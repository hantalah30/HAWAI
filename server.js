require("dotenv").config();
const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const simpleGit = require("simple-git");
const axios = require("axios");
const fs = require("fs-extra"); // Kita pakai fs-extra biar gampang pindah file
const path = require("path");
const cors = require("cors");

// Pastikan install fs-extra dulu: npm install fs-extra

const app = express();
app.use(cors());
app.use(express.static("public"));

// --- KONFIGURASI ---
const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const upload = multer({ dest: "uploads/" });
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// --- 1. MEMBERSIHKAN SAMPAH GIT ---
const cleanGitTrash = (dir) => {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file === ".git" || file === "__MACOSX") {
        // Hapus .git dan sampah Mac
        fs.removeSync(fullPath);
      } else {
        cleanGitTrash(fullPath);
      }
    } else {
      if (file === ".gitmodules" || file === ".DS_Store") {
        fs.unlinkSync(fullPath);
      }
    }
  });
};

// --- 2. PERBAIKI STRUKTUR FOLDER (ANTI 404) ---
const fixFolderStructure = async (rootDir) => {
  const files = await fs.readdir(rootDir);
  // Filter file sampah sistem
  const validFiles = files.filter(
    (f) => !["__MACOSX", ".DS_Store", ".git"].includes(f),
  );

  // Jika isinya cuma 1 folder, berarti user salah nge-zip (Folder dlm Folder)
  if (validFiles.length === 1) {
    const singleItemPath = path.join(rootDir, validFiles[0]);
    const stats = await fs.stat(singleItemPath);

    if (stats.isDirectory()) {
      console.log(
        `   📂 Mendeteksi folder tunggal: '${validFiles[0]}'. Memindahkan isi ke root...`,
      );
      // Pindahkan isi folder anak ke root
      const children = await fs.readdir(singleItemPath);
      for (const child of children) {
        await fs.move(
          path.join(singleItemPath, child),
          path.join(rootDir, child),
          { overwrite: true },
        );
      }
      // Hapus folder anak yang sudah kosong
      await fs.remove(singleItemPath);
    }
  }
};

app.post("/deploy", upload.single("file"), async (req, res) => {
  if (!req.file || !req.body.projectName) {
    return res
      .status(400)
      .json({ success: false, error: "File/Nama Project kosong!" });
  }

  const projectName = req.body.projectName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
  const hawaiName = `hawai-${projectName}`;
  const zipPath = req.file.path;
  const extractPath = path.join(__dirname, "temp", hawaiName);

  try {
    console.log(`\n🚀 Memulai Deploy: ${hawaiName}`);

    // 1. EXTRACT ZIP
    console.log(`[1/7] Extracting ZIP...`);
    if (fs.existsSync(extractPath)) fs.removeSync(extractPath);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    // 2. BERSIH-BERSIH & RAPIKAN
    console.log(`[2/7] Merapikan struktur file...`);
    cleanGitTrash(extractPath); // Hapus .git lama
    await fixFolderStructure(extractPath); // Pindahkan index.html ke depan

    // Cek apakah index.html ada?
    if (!fs.existsSync(path.join(extractPath, "index.html"))) {
      console.log("   ⚠️ Peringatan: index.html tidak ditemukan di root!");
    }

    // 3. GITHUB REPO
    console.log(`[3/7] Setup GitHub Repo...`);
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
    } catch (error) {
      if (error.response?.status !== 422) throw error;
      console.log("   ⚠️ Repo sudah ada, lanjut update...");
    }

    // 4. GIT PUSH (FORCE)
    console.log(`[4/7] Pushing ke GitHub...`);
    const git = simpleGit(extractPath);
    await git
      .init()
      .addConfig("user.name", "HawaiBot")
      .addConfig("user.email", "bot@hawai.id");
    try {
      await git.raw(["branch", "-M", "main"]);
    } catch (e) {}
    await git.add(".").commit("Auto Deploy by Hawai");
    try {
      await git.addRemote(
        "origin",
        `https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${hawaiName}.git`,
      );
    } catch (e) {}
    await git.push(["-u", "origin", "main", "--force"]);

    // 5. CLOUDFLARE PROJECT
    console.log(`[5/7] Config Cloudflare Project...`);
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
    } catch (error) {
      if (!error.response?.data?.errors?.[0]?.code === 8000009) {
        console.log("   ℹ️ Project Cloudflare sudah ada.");
      }
    }

    await delay(3000);

    // 6. TRIGGER DEPLOYMENT
    console.log(`[6/7] ⚡ MEMAKSA DEPLOYMENT BARU...`);
    try {
      await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${hawaiName}/deployments`,
        {
          branch: "main",
        },
        { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } },
      );
      console.log("   ✅ Deployment dipicu manual!");
    } catch (error) {
      console.log("   ⚠️ Info Deployment: " + error.message);
    }

    // 7. SELESAI
    const liveUrl = `https://${hawaiName}.pages.dev`;
    console.log(`[7/7] 🎉 SUKSES! Link: ${liveUrl}`);

    fs.removeSync(extractPath);
    fs.removeSync(zipPath);

    res.json({ success: true, url: liveUrl });
  } catch (error) {
    console.error("❌ ERROR:", error.message);
    try {
      fs.removeSync(zipPath);
    } catch (e) {}
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(3000, () =>
  console.log("🚀 Hawai Hosting Server v6 (Anti-404) Siap!"),
);
