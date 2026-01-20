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
app.use(express.json()); // Penting agar bisa baca JSON dari editor
app.use(express.static(path.join(__dirname, "public")));

// HALAMAN DEPAN
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// KONFIGURASI PATH
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

// --- API BARU: AMBIL LIST FILE DARI GITHUB ---
app.post("/api/files", async (req, res) => {
  const { repoName } = req.body;
  try {
    // Ambil struktur folder root
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_USER}/${repoName}/contents/`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
    );

    // Filter hanya file teks yang bisa diedit (html, css, js, txt, json)
    const files = response.data
      .filter(
        (f) =>
          f.type === "file" && f.name.match(/\.(html|css|js|json|txt|md)$/i),
      )
      .map((f) => ({ name: f.name, path: f.path, sha: f.sha }));

    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, error: "Gagal mengambil file" });
  }
});

// --- API BARU: BACA ISI FILE ---
app.post("/api/read", async (req, res) => {
  const { repoName, filePath } = req.body;
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_USER}/${repoName}/contents/${filePath}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
    );

    // GitHub kasih konten dalam format Base64, kita decode ke Text biasa
    const content = Buffer.from(response.data.content, "base64").toString(
      "utf-8",
    );
    res.json({ success: true, content, sha: response.data.sha });
  } catch (error) {
    res.status(500).json({ success: false, error: "Gagal membaca file" });
  }
});

// --- API BARU: SIMPAN (UPDATE) FILE KE GITHUB ---
app.post("/api/save", async (req, res) => {
  const { repoName, filePath, content, sha } = req.body;
  try {
    // Encode balik ke Base64
    const contentEncoded = Buffer.from(content).toString("base64");

    await axios.put(
      `https://api.github.com/repos/${GITHUB_USER}/${repoName}/contents/${filePath}`,
      {
        message: "Update via Hawai Editor",
        content: contentEncoded,
        sha: sha, // Wajib kirim SHA lama untuk verifikasi update
      },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
    );

    // Trigger Cloudflare Re-deployment (Optional, biasanya otomatis kalau connect github)
    // Tapi kita bisa pancing biar cepet (opsional)

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Gagal menyimpan file" });
  }
});

// --- FUNGSI DEPLOY (YANG LAMA) ---
const cleanGitTrash = (dir) => {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file === ".git" || file === "__MACOSX") fs.removeSync(fullPath);
      else cleanGitTrash(fullPath);
    } else {
      if (file === ".gitmodules" || file === ".DS_Store")
        fs.unlinkSync(fullPath);
    }
  });
};

async function findIndexDir(dir) {
  const items = await fs.readdir(dir);
  if (items.includes("index.html")) return dir;
  for (const item of items) {
    const fullPath = path.join(dir, item);
    try {
      const stat = await fs.stat(fullPath);
      if (
        stat.isDirectory() &&
        ![".git", "__MACOSX", "node_modules"].includes(item)
      ) {
        const found = await findIndexDir(fullPath);
        if (found) return found;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

app.post("/deploy", upload.single("file"), async (req, res) => {
  if (!req.file || !req.body.projectName) {
    return res
      .status(400)
      .json({ success: false, error: "Data tidak lengkap!" });
  }

  const projectName = req.body.projectName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
  const hawaiName = `hawai-${projectName}`;
  const zipPath = req.file.path;
  const extractPath = path.join(EXTRACT_DIR, hawaiName);

  try {
    console.log(`🚀 Processing: ${hawaiName}`);
    if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    cleanGitTrash(extractPath);
    const realRoot = await findIndexDir(extractPath);
    if (!realRoot) throw new Error("index.html tidak ditemukan!");

    if (realRoot !== extractPath) {
      const files = await fs.readdir(realRoot);
      for (const file of files) {
        await fs.move(path.join(realRoot, file), path.join(extractPath, file), {
          overwrite: true,
        });
      }
    }

    try {
      await axios.post(
        "https://api.github.com/user/repos",
        { name: hawaiName, private: false, auto_init: false },
        { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
      );
      await delay(1000);
    } catch (e) {
      console.log("Repo exists...");
    }

    await git.init({ fs, dir: extractPath, defaultBranch: "main" });
    const allFiles = fs.readdirSync(extractPath);
    for (const file of allFiles) {
      if (file !== ".git")
        await git.add({ fs, dir: extractPath, filepath: file });
    }
    await git.commit({
      fs,
      dir: extractPath,
      author: { name: "HawaiBot", email: "bot@hawai.id" },
      message: "Auto Deploy",
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

    await delay(2000);
    try {
      await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${hawaiName}/deployments`,
        { branch: "main" },
        { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } },
      );
    } catch (e) {}

    const liveUrl = `https://${hawaiName}.pages.dev`;
    try {
      fs.removeSync(extractPath);
      fs.unlinkSync(zipPath);
    } catch (e) {}

    // PENTING: Kirim juga nama repo agar frontend tahu harus ngedit repo mana
    res.json({ success: true, url: liveUrl, repo: hawaiName });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = app;
