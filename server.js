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

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

const TMP_DIR = os.tmpdir();
const UPLOAD_DIR = path.join(TMP_DIR, "uploads");
const EXTRACT_DIR = path.join(TMP_DIR, "temp");
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(EXTRACT_DIR);

const upload = multer({ dest: UPLOAD_DIR });
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

// --- API EDITOR ROUTES ---
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

    // TRIGGER REBUILD ON SAVE
    try {
      await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${repoName}/deployments`,
        { branch: "main" },
        { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } },
      );
    } catch (e) {
      console.log(
        "Auto-rebuild trigger failed (might need manual setup first)",
      );
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// --- DEPLOY LOGIC UTAMA ---
app.post("/deploy", upload.single("file"), async (req, res) => {
  if (!req.file || !req.body.projectName)
    return res.status(400).json({ success: false, error: "Missing data" });

  const userEmail = req.body.userEmail || "anonymous@hawai.id";
  const projectName = req.body.projectName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
  const hawaiName = `hawai-${projectName}`; // Nama Repo & Project Cloudflare
  const zipPath = req.file.path;
  const extractPath = path.join(EXTRACT_DIR, hawaiName);

  try {
    // 1. EXTRACT ZIP
    if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    // 2. CLEANUP & NORMALIZE FOLDER
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

    // Cek apakah user nge-zip folder (ada folder di dalam folder)
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

    // 3. CREATE GITHUB REPO (Jika belum ada)
    try {
      await axios.post(
        "https://api.github.com/user/repos",
        { name: hawaiName, private: false, auto_init: false },
        { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
      );
      console.log("✅ Repo Created:", hawaiName);
    } catch (e) {
      console.log("ℹ️ Repo Exists, Updating...");
    }

    // 4. GIT PUSH
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
      message: `Deploy by ${userEmail} at ${new Date().toISOString()}`,
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

    console.log("✅ Git Push Success");
    await delay(3000); // Tunggu GitHub sync sebentar

    // 5. CLOUDFLARE PAGES LOGIC (PERBAIKAN DI SINI)
    try {
      // Coba Buat Project Baru
      console.log("⚙️ Creating Cloudflare Project...");
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
          build_config: { build_command: "", destination_dir: "" }, // Kosongkan untuk HTML statis
        },
        { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } },
      );

      console.log("✅ Cloudflare Project Created");
    } catch (e) {
      // Jika Error Code 8000009 artinya "Project Name Already Taken" (Sudah ada)
      // Maka kita trigger deployment baru (Rebuild)
      if (
        e.response &&
        e.response.data &&
        e.response.data.errors[0].code === 8000009
      ) {
        console.log("ℹ️ Project exists. Triggering Rebuild...");
        try {
          await axios.post(
            `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${hawaiName}/deployments`,
            { branch: "main" },
            { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } },
          );
          console.log("✅ Rebuild Triggered");
        } catch (deployErr) {
          console.error(
            "❌ Rebuild Failed:",
            deployErr.response?.data || deployErr.message,
          );
        }
      } else {
        console.error("❌ Cloudflare Error:", e.response?.data || e.message);
      }
    }

    const liveUrl = `https://${hawaiName}.pages.dev`;

    // Cleanup
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Hawai Server running on port ${PORT}`));
