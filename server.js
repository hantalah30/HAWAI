// server.js (Vercel & Isomorphic-Git Fix Branch)
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
app.use(express.static("public"));

// --- RUTE HALAMAN DEPAN ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- KONFIGURASI PATH VERCEL (/tmp) ---
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
          auto_init: false, // auto_init FALSE agar repo kosong
        },
        { headers: { Authorization: `token ${GITHUB_TOKEN}` } },
      );
      await delay(1000);
    } catch (e) {
      console.log("Repo might exist...");
    }

    // 4. GIT OPERATIONS (FIXED BRANCH LOGIC)
    // Init Git
    await git.init({ fs, dir: extractPath, defaultBranch: "main" }); // Force default branch 'main'

    // Add All Files (Manual loop for Vercel compat)
    // Note: git.add '.' is tricky in isomorphic, we use glob pattern
    await git.add({ fs, dir: extractPath, filepath: "." });

    // Commit
    await git.commit({
      fs,
      dir: extractPath,
      author: { name: "HawaiBot", email: "bot@hawai.id" },
      message: "Auto Deploy",
    });

    // Add Remote
    await git.addRemote({
      fs,
      dir: extractPath,
      remote: "origin",
      url: `https://github.com/${GITHUB_USER}/${hawaiName}.git`,
    });

    // PUSH (FIXED)
    console.log("Pushing...");
    await git.push({
      fs,
      http,
      dir: extractPath,
      remote: "origin",
      ref: "main", // Explicitly push to main
      onAuth: () => ({ username: GITHUB_TOKEN }),
      force: true,
    });

    // 5. CLOUDFLARE PAGES
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
      /* Ignore */
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

module.exports = app;
