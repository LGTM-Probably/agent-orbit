const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

if (process.platform !== "win32") {
  console.log("[build-launcher-exe] Skipping Windows .exe launcher compilation on non-Windows platform.");
  process.exit(0);
}

const installDesktop =
  process.argv.includes("--install-desktop") ||
  process.env.ORBIT_COPY_DESKTOP === "1";

const rootDir = path.resolve(__dirname, "..");
const csPath = path.join(rootDir, "scripts", "Launcher.cs");
const iconPath = path.join(rootDir, "assets", "orbit.ico");
const projectExePath = path.join(rootDir, "Agent Orbit.exe");

const userProfile = process.env.USERPROFILE || os.homedir();
const desktopDir = path.join(userProfile, "Desktop");
const desktopExePath = path.join(desktopDir, "Agent Orbit.exe");
const desktopSidecarPath = path.join(desktopDir, "Agent Orbit.path");

const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

console.log("[build-launcher-exe] Validating inputs...");

if (!fs.existsSync(cscPath)) {
  console.error(`[build-launcher-exe] Error: C# compiler not found at ${cscPath}`);
  process.exit(1);
}

if (!fs.existsSync(csPath)) {
  console.error(`[build-launcher-exe] Error: C# source file not found at ${csPath}`);
  process.exit(1);
}

if (!fs.existsSync(iconPath)) {
  console.error(`[build-launcher-exe] Error: Icon file not found at ${iconPath}`);
  process.exit(1);
}

console.log(`[build-launcher-exe] Compiling ${csPath}`);
console.log(`[build-launcher-exe] Output: ${projectExePath}`);
console.log(`[build-launcher-exe] Icon:   ${iconPath}`);

try {
  const compilerArgs = [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/win32icon:" + iconPath,
    "/out:" + projectExePath,
    csPath,
  ];

  execFileSync(cscPath, compilerArgs, { stdio: "inherit" });
  console.log(`[build-launcher-exe] Compilation succeeded: ${projectExePath}`);
} catch (err) {
  console.error("[build-launcher-exe] Compilation failed:", err.message);
  process.exit(1);
}

// Opt-in Desktop shortcut installation (`npm run shortcut:desktop`)
if (installDesktop) {
  if (fs.existsSync(desktopDir)) {
    console.log(`[build-launcher-exe] Installing launcher to Desktop: ${desktopExePath}`);
    try {
      fs.copyFileSync(projectExePath, desktopExePath);
      fs.writeFileSync(desktopSidecarPath, rootDir + "\n", "utf8");
      console.log("[build-launcher-exe] Installed Desktop launcher and Agent Orbit.path pointer.");
    } catch (err) {
      console.error("[build-launcher-exe] Failed to copy to Desktop:", err.message);
      process.exit(1);
    }
  } else {
    console.warn(`[build-launcher-exe] Warning: Desktop directory does not exist at ${desktopDir}`);
  }
}

function verifyExe(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`File does not exist: ${targetPath}`);
  }
  const stat = fs.statSync(targetPath);
  if (stat.size === 0) {
    throw new Error(`File is 0 bytes: ${targetPath}`);
  }

  const fd = fs.openSync(targetPath, "r");
  try {
    const buffer = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, buffer, 0, 2, 0);
    if (bytesRead < 2) {
      throw new Error(`Unable to read 2 bytes from ${targetPath}`);
    }
    const magic = buffer.toString("ascii");
    if (magic !== "MZ") {
      throw new Error(`Expected MZ header magic, got '${magic}' in ${targetPath}`);
    }
    console.log(`[build-launcher-exe] Verified ${targetPath} (${stat.size} bytes, PE magic: MZ)`);
  } finally {
    fs.closeSync(fd);
  }
}

try {
  verifyExe(projectExePath);
  if (installDesktop && fs.existsSync(desktopDir)) {
    verifyExe(desktopExePath);
  }
  console.log("[build-launcher-exe] All verifications passed successfully!");
} catch (err) {
  console.error("[build-launcher-exe] Verification error:", err.message);
  process.exit(1);
}
