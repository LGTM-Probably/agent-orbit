const fs = require("fs");
const path = require("path");
const child_process = require("child_process");

const electronDir = path.resolve(__dirname, "../node_modules/electron");
const distDir = path.join(electronDir, "dist");
const exeName = process.platform === "win32" ? "electron.exe" : "electron";
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
  process.exit(0);
}

const { downloadArtifact } = require("@electron/get");

const keepAlive = setInterval(() => {}, 1000);

(async () => {
  try {
    console.log(`[agent-orbit] Ensuring Electron v${version} binary is extracted...`);
    const zipPath = await downloadArtifact({
      version,
      artifactName: "electron",
      platform: process.platform,
      arch: process.arch,
    });
    fs.mkdirSync(distDir, { recursive: true });
    try {
      const tarBin =
        process.platform === "win32" && fs.existsSync("C:\\Windows\\System32\\tar.exe")
          ? "C:\\Windows\\System32\\tar.exe"
          : "tar";
      child_process.execFileSync(tarBin, ["-xf", zipPath, "-C", distDir]);
    } catch {
      child_process.execFileSync("unzip", ["-q", "-o", zipPath, "-d", distDir]);
    }
    fs.writeFileSync(pathTxt, exeName, "utf8");
    console.log("[agent-orbit] Electron binary ready.");
  } catch (err) {
    console.error("[agent-orbit] Failed to prepare Electron binary:", err);
    process.exitCode = 1;
  } finally {
    clearInterval(keepAlive);
  }
})();
