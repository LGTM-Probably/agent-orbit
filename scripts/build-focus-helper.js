const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

if (process.platform !== "win32") {
  console.log("[build-focus-helper] Skipping Windows Win32 focus helper compilation on non-Windows platform.");
  process.exit(0);
}

const rootDir = path.resolve(__dirname, "..");
const csPath = path.join(rootDir, "scripts", "FocusHelper.cs");
const assetsDir = path.join(rootDir, "assets");
const outPath = path.join(assetsDir, "orbit-focus.exe");

if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

if (!fs.existsSync(csPath)) {
  console.error(`Source file not found: ${csPath}`);
  process.exit(1);
}

console.log(`Compiling ${csPath} -> ${outPath}...`);
try {
  execFileSync(
    cscPath,
    ["/nologo", "/target:winexe", "/optimize+", `/out:${outPath}`, csPath],
    { stdio: "inherit" }
  );
  console.log(`Successfully built ${outPath}`);
} catch (err) {
  console.error("Compilation failed:", err.message);
  process.exit(1);
}
