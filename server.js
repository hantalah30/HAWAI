// server.js (Vercel Edition)
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const simpleGit = require("simple-git");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const cors = require("cors");
const os = require("os"); // Penting untuk Vercel

const app = express();
app.use(cors());
app.use(express.static("public"));

// --- KONFIGURASI PATH VERCEL (/tmp) ---
// Vercel hanya membolehkan tulis data di folder /tmp
const TMP_DIR = os.tmpdir();
const UPLOAD_DIR = path.join(TMP_DIR, "uploads");
const EXTRACT_DIR = path.join(TMP_DIR, "temp");

// Pastikan folder temp ada
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(EXTRACT_DIR);

const upload = multer({ dest: UPLOAD_DIR });
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

// --- FUNGSI CLEANER ---
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

const fixFolderStructure = async (rootDir) => {
  const files = await fs.readdir(rootDir);
  const validFiles = files.filter(
    (f) => !["__MACOSX", ".DS_Store", ".git"].includes(f),
  );
  if (validFiles.length === 1) {
    const singleItemPath = path.join(rootDir, validFiles[0]);
    const stats = await fs.stat(singleItemPath);
    if (stats.isDirectory()) {
      const children = await fs.readdir(singleItemPath);
      for (const child of children) {
        await fs.move(
          path.join(singleItemPath, child),
          path.join(rootDir, child),
          { overwrite: true },
        );
      }
      await fs.remove(singleItemPath);
    }
  }
};

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

    // 1. EXTRACT
    if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    // 2. CLEAN & FIX
    cleanGitTrash(extractPath);
    await fixFolderStructure(extractPath);

    if (!fs.existsSync(path.join(extractPath, "index.html"))) {
      throw new Error("index.html tidak ditemukan di root file zip!");
    }

    // 3. GITHUB REPO
    try {
      await axios.post(
        "https://api.github.com/user/repos",
        {
          name: hawaiName,
          private: false,
          auto_init: true,
        },
        { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
      );
    } catch (e) {
      /* Ignore if exists */
    }

    // 4. GIT OPERATIONS (Using simple-git in /tmp)
    const git = simpleGit(extractPath);
    await git
      .init()
      .addConfig("user.name", "HawaiBot")
      .addConfig("user.email", "bot@hawai.id");

    try {
      await git.raw(["branch", "-M", "main"]);
    } catch (e) {}
    await git.add(".");
    await git.commit("Auto Deploy");
    try {
      await git.addRemote(
        "origin",
        `https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${hawaiName}.git`,
      );
    } catch (e) {}
    await git.push(["-u", "origin", "main", "--force"]);

    // 5. CLOUDFLARE
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
    } catch (e) {
      /* Ignore if exists */
    }

    await delay(2000);

    // 6. TRIGGER DEPLOY
    try {
      await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${hawaiName}/deployments`,
        {
          branch: "main",
        },
        { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } },
      );
    } catch (e) {}

    const liveUrl = `https://${hawaiName}.pages.dev`;

    // Cleanup /tmp
    try {
      fs.removeSync(extractPath);
      fs.unlinkSync(zipPath);
    } catch (e) {}

    res.json({ success: true, url: liveUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PENTING UNTUK VERCEL: Export app, jangan app.listen
module.exports = app;
