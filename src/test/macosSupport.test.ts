import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  buildMacActivateJxa,
  parseLsofCwdOutput,
  parseMacPsOutput,
  selectMacFocusCandidate,
} from "../main/windowFocus";

const repoRoot = path.resolve(__dirname, "../..");

describe("macOS Cross-Platform Support", () => {
  it("resolveElectronBinaryRelPath returns expected binary path per OS", () => {
    const ensureElectron = require(path.join(repoRoot, "scripts", "ensure-electron.js"));
    assert.strictEqual(
      ensureElectron.resolveElectronBinaryRelPath("win32"),
      "electron.exe"
    );
    assert.strictEqual(
      ensureElectron.resolveElectronBinaryRelPath("darwin"),
      "Electron.app/Contents/MacOS/Electron"
    );
    assert.strictEqual(
      ensureElectron.resolveElectronBinaryRelPath("linux"),
      "electron"
    );
  });

  it("parseMacPsOutput extracts outermost .app bundles and CLI executables", () => {
    const samplePs = [
      "  100     1 /Applications/Cursor.app/Contents/MacOS/Cursor",
      "  101   100 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)",
      "  200     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "  201   200 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Renderer).app/Contents/MacOS/Code Helper (Renderer)",
      "  300     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      "  400     1 /Applications/iTerm.app/Contents/MacOS/iTerm2",
      "  500     1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
      "  600     1 /Applications/Claude.app/Contents/MacOS/Claude",
      "  700     1 /Applications/Codex.app/Contents/MacOS/Codex",
      "  800     1 /Applications/Antigravity.app/Contents/MacOS/Antigravity",
      "  900     1 /Applications/Strata.app/Contents/MacOS/strata-desktop",
      " 1001   101 /bin/zsh",
      " 1002  1001 /Users/dev/.local/bin/claude",
      " 1003   500 /opt/homebrew/bin/codex",
    ].join("\n");

    const map = parseMacPsOutput(samplePs);
    assert.strictEqual(map.size, 14);

    assert.strictEqual(map.get(100)?.appName, "Cursor");
    assert.strictEqual(map.get(101)?.appName, "Cursor");
    assert.strictEqual(map.get(200)?.appName, "Visual Studio Code");
    assert.strictEqual(map.get(201)?.appName, "Visual Studio Code");
    assert.strictEqual(map.get(300)?.appName, "Terminal");
    assert.strictEqual(map.get(300)?.exeName, "Terminal");
    assert.strictEqual(map.get(400)?.appName, "iTerm");
    assert.strictEqual(map.get(400)?.exeName, "iTerm2");
    assert.strictEqual(map.get(500)?.appName, "Ghostty");
    assert.strictEqual(map.get(500)?.exeName, "ghostty");
    assert.strictEqual(map.get(600)?.appName, "Claude");
    assert.strictEqual(map.get(700)?.appName, "Codex");
    assert.strictEqual(map.get(800)?.appName, "Antigravity");
    assert.strictEqual(map.get(900)?.appName, "Strata");
    assert.strictEqual(map.get(900)?.exeName, "strata-desktop");

    assert.strictEqual(map.get(1002)?.appName, undefined);
    assert.strictEqual(map.get(1002)?.exeName, "claude");
    assert.strictEqual(map.get(1002)?.ppid, 1001);

    assert.strictEqual(map.get(1003)?.appName, undefined);
    assert.strictEqual(map.get(1003)?.exeName, "codex");
    assert.strictEqual(map.get(1003)?.ppid, 500);
  });

  it("parseLsofCwdOutput parses p<pid> and n<cwdPath> records", () => {
    const sampleLsof = [
      "p1003",
      "fcwd",
      "n/Users/dev/code/repo-a",
      "p1004",
      "fcwd",
      "n/Users/dev/code/repo with spaces/repo-b",
      "p1005",
      "n/Users/dev/code/compact",
    ].join("\n");

    const cwds = parseLsofCwdOutput(sampleLsof);
    assert.strictEqual(cwds.size, 3);
    assert.strictEqual(cwds.get(1003), "/Users/dev/code/repo-a");
    assert.strictEqual(cwds.get(1004), "/Users/dev/code/repo with spaces/repo-b");
    assert.strictEqual(cwds.get(1005), "/Users/dev/code/compact");
  });

  it("selectMacFocusCandidate resolves Claude CLI inside Cursor/VS Code via PID tree walk", () => {
    const processes = parseMacPsOutput(
      [
        " 200    1 /Applications/Cursor.app/Contents/MacOS/Cursor",
        " 201  200 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)",
        " 202  201 /bin/zsh",
        " 203  202 /Users/dev/.local/bin/claude",
        " 300    1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
        " 301  300 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
        " 302  301 /bin/zsh",
        " 303  302 /Users/dev/.local/bin/claude",
      ].join("\n")
    );

    const windows = [
      { appName: "Cursor", title: "other-project — Cursor", pid: 200, windowIndex: 1 },
      { appName: "Cursor", title: "agent-orbit — Cursor", pid: 200, windowIndex: 2 },
      { appName: "Code", title: "docs — Visual Studio Code", pid: 300, windowIndex: 1 },
    ];

    const cursorRes = selectMacFocusCandidate(
      {
        harness: "claude",
        pid: 203,
        cwd: "/Users/dev/code/agent-orbit",
        project: "agent-orbit",
        entrypoint: "cli",
      },
      { processes, windows }
    );
    assert.ok(cursorRes);
    assert.strictEqual(cursorRes.targetApp, "Cursor");
    assert.strictEqual(cursorRes.windowTitle, "agent-orbit — Cursor");
    assert.strictEqual(cursorRes.windowIndex, 2);

    const vscodeRes = selectMacFocusCandidate(
      {
        harness: "claude",
        pid: 303,
        cwd: "/Users/dev/code/docs",
        project: "docs",
        entrypoint: "cli",
      },
      { processes, windows }
    );
    assert.ok(vscodeRes);
    assert.strictEqual(vscodeRes.targetApp, "Code");
    assert.strictEqual(vscodeRes.windowTitle, "docs — Visual Studio Code");
  });

  it("selectMacFocusCandidate disambiguates multiple Codex CLI sessions by cwd across Ghostty and iTerm", () => {
    const processes = parseMacPsOutput(
      [
        " 400    1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
        " 401  400 /bin/zsh",
        " 402  401 /opt/homebrew/bin/codex",
        " 500    1 /Applications/iTerm.app/Contents/MacOS/iTerm2",
        " 501  500 /bin/zsh",
        " 502  501 /opt/homebrew/bin/codex",
      ].join("\n")
    );

    const cwds = parseLsofCwdOutput(
      [
        "p402",
        "fcwd",
        "n/Users/dev/code/repo-a",
        "p502",
        "fcwd",
        "n/Users/dev/code/repo-b",
      ].join("\n")
    );

    const runningApps = [
      { name: "Ghostty", pid: 400 },
      { name: "iTerm2", pid: 500 },
    ];

    const resA = selectMacFocusCandidate(
      {
        harness: "codex",
        cwd: "/Users/dev/code/repo-a",
        project: "repo-a",
      },
      { processes, cwds, runningApps }
    );
    assert.ok(resA);
    assert.strictEqual(resA.targetApp, "Ghostty");
    assert.strictEqual(resA.pid, 400);

    const resB = selectMacFocusCandidate(
      {
        harness: "codex",
        cwd: "/Users/dev/code/repo-b",
        project: "repo-b",
      },
      { processes, cwds, runningApps }
    );
    assert.ok(resB);
    assert.strictEqual(resB.targetApp, "iTerm2");
    assert.strictEqual(resB.pid, 500);
  });

  it("selectMacFocusCandidate matches Antigravity and Strata windows by project/label", () => {
    const processes = new Map();
    const windows = [
      { appName: "Agent Orbit", title: "Agent Orbit", pid: 100, windowIndex: 1 },
      { appName: "Antigravity", title: "Antigravity — other-app", pid: 200, windowIndex: 1 },
      { appName: "Antigravity", title: "Antigravity — agent-orbit", pid: 200, windowIndex: 2 },
      { appName: "Strata", title: "Strata — game-engine", pid: 300, windowIndex: 1 },
    ];

    const agRes = selectMacFocusCandidate(
      {
        harness: "antigravity",
        project: "agent-orbit",
        label: "agent-orbit",
      },
      { processes, windows }
    );
    assert.ok(agRes);
    assert.strictEqual(agRes.targetApp, "Antigravity");
    assert.strictEqual(agRes.windowTitle, "Antigravity — agent-orbit");
    assert.strictEqual(agRes.windowIndex, 2);

    const strataRes = selectMacFocusCandidate(
      {
        harness: "strata",
        project: "game-engine",
        label: "game-engine",
      },
      { processes, windows }
    );
    assert.ok(strataRes);
    assert.strictEqual(strataRes.targetApp, "Strata");
    assert.strictEqual(strataRes.windowTitle, "Strata — game-engine");

    // Works with runningApps only when Accessibility window titles are unavailable
    const fallbackRes = selectMacFocusCandidate(
      {
        harness: "antigravity",
        project: "agent-orbit",
        label: "agent-orbit",
      },
      {
        processes,
        runningApps: [
          { name: "Agent Orbit", pid: 100 },
          { name: "Antigravity", pid: 200 },
        ],
      }
    );
    assert.ok(fallbackRes);
    assert.strictEqual(fallbackRes.targetApp, "Antigravity");
    assert.strictEqual(fallbackRes.windowTitle, "");
  });

  it("selectMacFocusCandidate distinguishes Claude Desktop from Claude CLI", () => {
    const processes = new Map();
    const windows = [
      { appName: "Claude", title: "Claude", pid: 600, windowIndex: 1 },
      { appName: "Terminal", title: "zsh — ~/code/agent-orbit", pid: 601, windowIndex: 1 },
    ];

    const desktopRes = selectMacFocusCandidate(
      {
        harness: "claude",
        entrypoint: "claude-desktop",
        cwd: "/Users/dev/code/agent-orbit",
        project: "agent-orbit",
      },
      { processes, windows }
    );
    assert.ok(desktopRes);
    assert.strictEqual(desktopRes.targetApp, "Claude");

    const cliRes = selectMacFocusCandidate(
      {
        harness: "claude",
        entrypoint: "cli",
        cwd: "/Users/dev/code/agent-orbit",
        project: "agent-orbit",
      },
      { processes, windows }
    );
    assert.ok(cliRes);
    assert.strictEqual(cliRes.targetApp, "Terminal");
    assert.strictEqual(cliRes.windowTitle, "zsh — ~/code/agent-orbit");
  });

  it("generated PNG assets have valid PNG signatures and IHDR dimensions", () => {
    const expectedAssets = [
      { file: "orbit.png", width: 512, height: 512 },
      { file: "orbit-tray.png", width: 18, height: 18 },
      { file: "orbit-tray@2x.png", width: 36, height: 36 },
    ];
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    for (const asset of expectedAssets) {
      const fullPath = path.join(repoRoot, "assets", asset.file);
      assert.ok(fs.existsSync(fullPath), `${asset.file} should exist`);
      const buf = fs.readFileSync(fullPath);
      assert.ok(buf.length >= 33, `${asset.file} should be a valid PNG buffer`);
      assert.ok(
        buf.subarray(0, 8).equals(pngSignature),
        `${asset.file} must start with 8-byte PNG signature`
      );
      assert.strictEqual(buf.subarray(12, 16).toString("ascii"), "IHDR");
      assert.strictEqual(buf.readUInt32BE(16), asset.width);
      assert.strictEqual(buf.readUInt32BE(20), asset.height);
    }
  });

  it("buildMacActivateJxa safely embeds special characters without CLI argv ambiguity", () => {
    const jxa = buildMacActivateJxa({
      targetApp: "Visual Studio Code",
      pid: 4242,
      windowIndex: 2,
      windowTitle: `-e "tricky" \\ path\nline\u2028sep`,
    });
    assert.ok(jxa.includes('"targetApp":"Visual Studio Code"'));
    assert.ok(jxa.includes('"targetPid":4242'));
    assert.ok(!jxa.includes("\u2028"));
  });
});
