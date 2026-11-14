const fs = require("fs");
const path = require("path");
const child_process = require("child_process");

function resolveElectronBinaryRelPath(platform = process.platform) {
  if (platform === "win32") {
    return "electron.exe";
  }
  if (platform === "darwin") {
    return "Electron.app/Contents/MacOS/Electron";
  }
  return "electron";
}

function extractElectronArchive(zipPath, distDir, platform = process.platform) {
  if (platform === "darwin") {
    try {
      child_process.execFileSync("/usr/bin/ditto", ["-x", "-k", zipPath, distDir]);
      return;
    } catch {
      child_process.execFileSync("unzip", ["-q", "-y", "-o", zipPath, "-d", distDir]);
      return;
    }
  }

  try {
    const tarBin =
      platform === "win32" && fs.existsSync("C:\\Windows\\System32\\tar.exe")
        ? "C:\\Windows\\System32\\tar.exe"
        : "tar";
    child_process.execFileSync(tarBin, ["-xf", zipPath, "-C", distDir]);
  } catch {
    child_process.execFileSync("unzip", ["-q", "-o", zipPath, "-d", distDir]);
  }
}

async function ensureElectron() {
  const electronDir = path.resolve(__dirname, "../node_modules/electron");
  const distDir = path.join(electronDir, "dist");
  const exeName = resolveElectronBinaryRelPath(process.platform);
  const pathTxt = path.join(electronDir, "path.txt");
  const exePath = path.join(distDir, exeName);
  const distVersionFile = path.join(distDir, "version");
  const { version } = require(path.join(electronDir, "package.json"));

  const installedDistVersion = fs.existsSync(distVersionFile)
    ? fs.readFileSync(distVersionFile, "utf8").trim().replace(/^v/, "")
    : "";

  if (
    fs.existsSync(pathTxt) &&
    fs.existsSync(exePath) &&
    installedDistVersion === version
  ) {
    return;
  }

  const { downloadArtifact } = require("@electron/get");

  const keepAlive = setInterval(() => {}, 1000);

  try {
    console.log(`[agent-orbit] Ensuring Electron v${version} binary is extracted...`);
    const zipPath = await downloadArtifact({
      version,
      artifactName: "electron",
      platform: process.platform,
      arch: process.arch,
    });
    fs.mkdirSync(distDir, { recursive: true });
    extractElectronArchive(zipPath, distDir, process.platform);
    fs.writeFileSync(pathTxt, exeName, "utf8");
    console.log("[agent-orbit] Electron binary ready.");
  } catch (err) {
    console.error("[agent-orbit] Failed to prepare Electron binary:", err);
    process.exitCode = 1;
  } finally {
    clearInterval(keepAlive);
  }
}

if (require.main === module) {
  ensureElectron();
}

module.exports = {
  resolveElectronBinaryRelPath,
  extractElectronArchive,
  ensureElectron,
};
