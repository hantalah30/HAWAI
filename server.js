require("dotenv").config();
const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const git = require("isomorphic-git");
const http = require("isomorphic-git/http/node");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const cors = require("cors");
const os = require("os");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const TMP_DIR = os.tmpdir();
const UPLOAD_DIR = path.join(TMP_DIR, "uploads");
const EXTRACT_DIR = path.join(TMP_DIR, "temp");
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(EXTRACT_DIR);

const upload = multer({ dest: UPLOAD_DIR });
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// HALAMAN DEPAN
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

// --- NEW: API AI GRATIS (POLLINATIONS) ---
// Tidak perlu API Key, langsung tembak endpoint ini
app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  console.log("🤖 AI Request (Pollinations)...");

  try {
    // Ambil pesan terakhir user dan konteks sistem
    const systemMsg = messages.find((m) => m.role === "system")?.content || "";
    const userMsg =
      messages.reverse().find((m) => m.role === "user")?.content || "";

    // Gabungkan prompt agar sesuai format Pollinations (Plain text prompt)
    const finalPrompt = `${systemMsg}\n\nUser Question:\n${userMsg}`;

    // Request ke Pollinations (Gratis, No-Key)
    // Kita encodeURIComponent agar aman di URL
    const url = `https://text.pollinations.ai/${encodeURIComponent(finalPrompt)}?model=openai`;

    const response = await axios.get(url);

    console.log("✅ AI Response Success");
    // Format balik ke JSON agar frontend mudah baca
    res.json({
      choices: [{ message: { content: response.data } }],
    });
  } catch (error) {
    console.error("🔥 AI Error:", error.message);
    res.status(500).json({ error: "AI Server Error: " + error.message });
  }
});

// --- API FILE MANAGER ---
app.post("/api/files", async (req, res) => {
  const { repoName } = req.body;
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_USER}/${repoName}/contents/`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
    );
    const files = response.data
      .filter(
        (f) =>
          f.type === "file" && f.name.match(/\.(html|css|js|json|txt|md)$/i),
      )
      .map((f) => ({ name: f.name, path: f.path, sha: f.sha }));
    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post("/api/read", async (req, res) => {
  const { repoName, filePath } = req.body;
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_USER}/${repoName}/contents/${filePath}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
    );
    const content = Buffer.from(response.data.content, "base64").toString(
      "utf-8",
    );
    res.json({ success: true, content, sha: response.data.sha });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post("/api/save", async (req, res) => {
  const { repoName, filePath, content, sha } = req.body;
  try {
    const contentEncoded = Buffer.from(content).toString("base64");
    await axios.put(
      `https://api.github.com/repos/${GITHUB_USER}/${repoName}/contents/${filePath}`,
      { message: "Update via Hawai Editor", content: contentEncoded, sha },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
    );
    triggerCloudflareBuild(repoName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

async function triggerCloudflareBuild(projectName) {
  try {
    await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${projectName}/deployments`,
      { branch: "main" },
      { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } },
    );
  } catch (e) {
    console.log("Build Trigger Info:", e.message);
  }
}

// --- DEPLOY LOGIC ---
app.post("/deploy", upload.single("file"), async (req, res) => {
  if (!req.file || !req.body.projectName)
    return res.status(400).json({ success: false, error: "Missing data" });

  const userEmail = req.body.userEmail || "anonymous@hawai.id";
  const projectName = req.body.projectName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
  const hawaiName = `hawai-${projectName}`;
  const zipPath = req.file.path;
  const extractPath = path.join(EXTRACT_DIR, hawaiName);

  try {
    if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    const cleanGitTrash = (dir) => {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach((file) => {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          if (file === ".git" || file === "__MACOSX") fs.removeSync(fullPath);
          else cleanGitTrash(fullPath);
        } else {
          if (file === ".gitmodules" || file === ".DS_Store")
            fs.unlinkSync(fullPath);
        }
      });
    };
    cleanGitTrash(extractPath);

    const items = fs.readdirSync(extractPath);
    if (
      items.length === 1 &&
      fs.statSync(path.join(extractPath, items[0])).isDirectory()
    ) {
      const subDir = path.join(extractPath, items[0]);
      const subItems = fs.readdirSync(subDir);
      for (const item of subItems) {
        fs.moveSync(path.join(subDir, item), path.join(extractPath, item), {
          overwrite: true,
        });
      }
      fs.removeSync(subDir);
    }

    try {
      await axios.post(
        "https://api.github.com/user/repos",
        { name: hawaiName, private: false, auto_init: false },
        { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
      );
    } catch (e) {}

    await git.init({ fs, dir: extractPath, defaultBranch: "main" });
    const allFiles = fs.readdirSync(extractPath);
    for (const file of allFiles) {
      if (file !== ".git")
        await git.add({ fs, dir: extractPath, filepath: file });
    }

    await git.commit({
      fs,
      dir: extractPath,
      author: { name: "Hawai Deployer", email: userEmail },
      message: `Deploy by ${userEmail}`,
    });
    await git.addRemote({
      fs,
      dir: extractPath,
      remote: "origin",
      url: `https://github.com/${GITHUB_USER}/${hawaiName}.git`,
    });
    await git.push({
      fs,
      http,
      dir: extractPath,
      remote: "origin",
      ref: "main",
      onAuth: () => ({ username: GITHUB_TOKEN }),
      force: true,
    });

    await delay(3000);

    try {
      await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects`,
        {
          name: hawaiName,
          source: {
            type: "github",
            config: {
              owner: GITHUB_USER,
              repo_name: hawaiName,
              production_branch: "main",
              pr_comments_enabled: true,
              deployments_enabled: true,
            },
          },
          build_config: { build_command: "", destination_dir: "" },
        },
        { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } },
      );
    } catch (e) {}

    await triggerCloudflareBuild(hawaiName);

    const liveUrl = `https://${hawaiName}.pages.dev`;
    try {
      fs.removeSync(extractPath);
      fs.unlinkSync(zipPath);
    } catch (e) {}

    res.json({ success: true, url: liveUrl, repo: hawaiName });
  } catch (error) {
    console.error("🔥 Critical Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => console.log(`🔥 Hawai Server running on port ${PORT}`));
