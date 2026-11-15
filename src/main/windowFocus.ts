import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { FocusResult } from "../shared/types";
import { GraphStore, MutableAgentNode } from "./graphStore";

export interface MacProcessEntry {
  pid: number;
  ppid: number;
  comm: string;
  exeName: string;
  appName?: string;
}

export interface MacRunningApp {
  name: string;
  bundleId?: string;
  pid?: number;
}

export interface MacWindowInfo {
  appName: string;
  title: string;
  pid?: number;
  windowIndex?: number;
}

export interface MacFocusTargetQuery {
  harness: string;
  pid?: number;
  cwd?: string;
  project?: string;
  label?: string;
  entrypoint?: string;
}

export interface MacFocusContext {
  processes: Map<number, MacProcessEntry>;
  cwds?: Map<number, string>;
  runningApps?: MacRunningApp[];
  windows?: MacWindowInfo[];
}

export interface MacFocusCandidate {
  targetApp: string;
  windowTitle: string;
  windowIndex?: number;
  pid?: number;
  score: number;
}

interface MacAppSpec {
  key: string;
  canonicalName: string;
  kind: "terminal" | "agent";
  aliases: string[];
}

const MAC_KNOWN_APPS: MacAppSpec[] = [
  { key: "terminal", canonicalName: "Terminal", kind: "terminal", aliases: ["terminal"] },
  { key: "iterm", canonicalName: "iTerm2", kind: "terminal", aliases: ["iterm", "iterm2"] },
  { key: "ghostty", canonicalName: "Ghostty", kind: "terminal", aliases: ["ghostty"] },
  { key: "warp", canonicalName: "Warp", kind: "terminal", aliases: ["warp"] },
  { key: "tabby", canonicalName: "Tabby", kind: "terminal", aliases: ["tabby"] },
  {
    key: "vscode",
    canonicalName: "Visual Studio Code",
    kind: "terminal",
    aliases: ["visual studio code", "code", "code - insiders", "visual studio code - insiders"],
  },
  { key: "cursor", canonicalName: "Cursor", kind: "terminal", aliases: ["cursor"] },
  { key: "windsurf", canonicalName: "Windsurf", kind: "terminal", aliases: ["windsurf"] },
  { key: "zed", canonicalName: "Zed", kind: "terminal", aliases: ["zed"] },
  { key: "alacritty", canonicalName: "Alacritty", kind: "terminal", aliases: ["alacritty"] },
  { key: "kitty", canonicalName: "kitty", kind: "terminal", aliases: ["kitty"] },
  { key: "wezterm", canonicalName: "WezTerm", kind: "terminal", aliases: ["wezterm", "wezterm-gui"] },
  { key: "hyper", canonicalName: "Hyper", kind: "terminal", aliases: ["hyper"] },
  { key: "claude", canonicalName: "Claude", kind: "agent", aliases: ["claude"] },
  { key: "codex", canonicalName: "Codex", kind: "agent", aliases: ["codex"] },
  { key: "antigravity", canonicalName: "Antigravity", kind: "agent", aliases: ["antigravity"] },
  {
    key: "strata",
    canonicalName: "Strata",
    kind: "agent",
    aliases: ["strata", "strata-desktop", "strata desktop"],
  },
];

const MAC_ALIAS_MAP = new Map<string, MacAppSpec>();
for (const spec of MAC_KNOWN_APPS) {
  for (const alias of spec.aliases) {
    MAC_ALIAS_MAP.set(alias.toLowerCase(), spec);
  }
}

const IGNORED_SYSTEM_APPS = new Set([
  "agent orbit",
  "loginwindow",
  "dock",
  "finder",
  "systemuiserver",
  "windowserver",
]);

function normalizeAppToken(name: string): string {
  return name.trim().replace(/\.app$/i, "").toLowerCase();
}

function getKnownAppSpec(name?: string): MacAppSpec | undefined {
  if (!name) return undefined;
  return MAC_ALIAS_MAP.get(normalizeAppToken(name));
}

function isMacTerminalOrIdeApp(name?: string): boolean {
  return getKnownAppSpec(name)?.kind === "terminal";
}

function isIgnoredApp(name?: string, bundleId?: string): boolean {
  if (bundleId && bundleId.toLowerCase() === "dev.agentorbit.desktop") {
    return true;
  }
  if (!name) return false;
  return IGNORED_SYSTEM_APPS.has(normalizeAppToken(name));
}

function macAppsMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const specA = getKnownAppSpec(a);
  const specB = getKnownAppSpec(b);
  if (specA && specB) {
    return specA.key === specB.key;
  }
  return normalizeAppToken(a) === normalizeAppToken(b);
}

/**
 * Parses `/bin/ps -ax -o pid=,ppid=,comm=` output into a PID-keyed map.
 * Extracts the outermost `.app` bundle name (e.g. `Cursor.app/.../Cursor Helper.app` -> `"Cursor"`).
 */
export function parseMacPsOutput(psText: string): Map<number, MacProcessEntry> {
  const result = new Map<number, MacProcessEntry>();
  if (!psText) return result;

  const lines = psText.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;

    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const comm = match[3].trim();
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !comm) continue;

    const exeName = path.posix.basename(comm);
    const appMatch = comm.match(/(?:^|\/)([^/]+)\.app(?:\/|$)/);
    const appName = appMatch && appMatch[1] ? appMatch[1].trim() : undefined;

    result.set(pid, {
      pid,
      ppid,
      comm,
      exeName,
      appName,
    });
  }

  return result;
}

/**
 * Parses `lsof -a -p <pids> -d cwd -Fn` output (`p<pid>` + `n<cwdPath>`).
 */
export function parseLsofCwdOutput(lsofText: string): Map<number, string> {
  const result = new Map<number, string>();
  if (!lsofText) return result;

  let currentPid: number | undefined;
  let currentFd: string | undefined;

  const lines = lsofText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      if (Number.isFinite(pid) && pid > 0) {
        currentPid = pid;
        currentFd = undefined;
      } else {
        currentPid = undefined;
      }
      continue;
    }

    if (line.startsWith("f")) {
      currentFd = line.slice(1).toLowerCase();
      continue;
    }

    if (line.startsWith("n") && line.length > 1 && currentPid !== undefined) {
      if (!currentFd || currentFd === "cwd") {
        result.set(currentPid, line.slice(1));
      }
    }
  }

  return result;
}

function normalizePath(p?: string): string {
  if (!p) return "";
  const replaced = p.replace(/\\/g, "/").trim();
  if (replaced.length > 1) {
    return replaced.replace(/\/+$/, "").toLowerCase();
  }
  return replaced.toLowerCase();
}

function cwdsExactMatch(a?: string, b?: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return na.length > 1 && na === nb;
}

function cwdsRelatedMatch(a?: string, b?: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na.length <= 1 || nb.length <= 1) return false;
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

function titleMatchesCwd(title?: string, cwd?: string): boolean {
  if (!title || !cwd) return false;
  const lowerTitle = title.toLowerCase();
  const normCwd = normalizePath(cwd);
  if (normCwd.length <= 3) return false;

  if (lowerTitle.includes(normCwd)) return true;
  if (lowerTitle.includes(cwd.trim().toLowerCase())) return true;

  // Match ~/... shorthand often shown in macOS terminal titles
  const homeMatch = normCwd.match(/^\/users\/[^/]+(\/.*)$/);
  if (homeMatch && homeMatch[1]) {
    if (lowerTitle.includes("~" + homeMatch[1])) return true;
  }

  return false;
}

function titleMatchesProject(title?: string, project?: string): boolean {
  if (!title || !project) return false;
  const lowerProj = project.trim().toLowerCase();
  if (!lowerProj || lowerProj === "workspace" || lowerProj === "home") {
    return false;
  }
  return title.toLowerCase().includes(lowerProj);
}

function titleMatchesLabel(title?: string, label?: string): boolean {
  if (!title || !label) return false;
  const lowerLabel = label.trim().toLowerCase();
  if (!lowerLabel) return false;
  return title.toLowerCase().includes(lowerLabel);
}

function scoreWindowTitle(title: string, query: MacFocusTargetQuery): number {
  let score = 0;
  if (titleMatchesCwd(title, query.cwd)) score += 80;
  if (titleMatchesProject(title, query.project)) score += 40;
  if (titleMatchesLabel(title, query.label)) score += 30;
  return score;
}

function resolveCandidateForApp(
  discoveredAppName: string,
  pidsSeen: Set<number>,
  query: MacFocusTargetQuery,
  ctx: MacFocusContext,
  baseScore = 100
): MacFocusCandidate {
  const windows = (ctx.windows || []).filter((w) => !isIgnoredApp(w.appName));
  const runningApps = (ctx.runningApps || []).filter((a) => !isIgnoredApp(a.name, a.bundleId));

  let bestWin: MacWindowInfo | undefined;
  let bestWinScore = -1;

  for (const win of windows) {
    const pidMatch = win.pid !== undefined && pidsSeen.has(win.pid);
    const appMatch = macAppsMatch(win.appName, discoveredAppName);
    if (!pidMatch && !appMatch) continue;

    let winScore = scoreWindowTitle(win.title || "", query);
    if (pidMatch) winScore += 20;
    if (win.title) winScore += 1;

    if (winScore > bestWinScore) {
      bestWinScore = winScore;
      bestWin = win;
    }
  }

  if (bestWin) {
    return {
      targetApp: bestWin.appName,
      windowTitle: bestWin.title || "",
      windowIndex: bestWin.windowIndex,
      pid: bestWin.pid,
      score: baseScore + bestWinScore,
    };
  }

  const matchedRunning = runningApps.find(
    (app) =>
      (app.pid !== undefined && pidsSeen.has(app.pid)) || macAppsMatch(app.name, discoveredAppName)
  );

  if (matchedRunning) {
    return {
      targetApp: matchedRunning.name,
      windowTitle: "",
      pid: matchedRunning.pid,
      score: baseScore,
    };
  }

  const rootAppPid = Array.from(pidsSeen).pop();
  return {
    targetApp: discoveredAppName,
    windowTitle: "",
    pid: rootAppPid,
    score: baseScore,
  };
}

function walkProcessTreeToApp(
  startPid: number,
  processes: Map<number, MacProcessEntry>,
  windows: MacWindowInfo[]
): {
  appName?: string;
  pidsSeen: Set<number>;
  exactWindow?: MacWindowInfo;
} {
  const pidsSeen = new Set<number>();
  const visited = new Set<number>();
  let cur: number | undefined = startPid;
  let recognizedApp: string | undefined;
  let fallbackApp: string | undefined;
  let exactWindow: MacWindowInfo | undefined;

  for (let hop = 0; hop < 16; hop++) {
    if (!cur || cur <= 0 || visited.has(cur)) break;
    visited.add(cur);
    pidsSeen.add(cur);

    if (!exactWindow) {
      const win = windows.find((w) => w.pid === cur && !isIgnoredApp(w.appName));
      if (win) {
        exactWindow = win;
      }
    }

    const entry = processes.get(cur);
    if (!entry) break;

    const exeSpec = getKnownAppSpec(entry.exeName);
    const candidateName =
      entry.appName || (exeSpec && exeSpec.kind === "terminal" ? entry.exeName : undefined);
    if (candidateName && !isIgnoredApp(candidateName)) {
      if (getKnownAppSpec(candidateName)) {
        if (!recognizedApp) {
          recognizedApp = candidateName;
        }
        // Keep walking only while still inside the same .app bundle to collect its root PID
        const parent = entry.ppid > 0 ? processes.get(entry.ppid) : undefined;
        const parentExeSpec = parent ? getKnownAppSpec(parent.exeName) : undefined;
        const parentName =
          parent?.appName ||
          (parent && parentExeSpec && parentExeSpec.kind === "terminal"
            ? parent.exeName
            : undefined);
        if (!parent || !parentName || !macAppsMatch(parentName, recognizedApp)) {
          break;
        }
      } else if (!fallbackApp) {
        fallbackApp = candidateName;
      }
    }

    if (entry.ppid > 0 && entry.ppid !== cur) {
      cur = entry.ppid;
    } else {
      break;
    }
  }

  return {
    appName: recognizedApp || fallbackApp,
    pidsSeen,
    exactWindow,
  };
}

/**
 * Pure macOS target-selection logic mirroring `scripts/FocusHelper.cs` for deterministic testing.
 */
export function selectMacFocusCandidate(
  query: MacFocusTargetQuery,
  ctx: MacFocusContext
): MacFocusCandidate | null {
  const harness = (query.harness || "").trim().toLowerCase();
  const entrypoint = (query.entrypoint || "").trim().toLowerCase();
  const windows = (ctx.windows || []).filter((w) => !isIgnoredApp(w.appName));
  const runningApps = (ctx.runningApps || []).filter((a) => !isIgnoredApp(a.name, a.bundleId));

  // Step 1: Live PID tree walk (e.g. from ~/.claude/sessions/*.json)
  if (query.pid && query.pid > 0 && ctx.processes.has(query.pid)) {
    const walk = walkProcessTreeToApp(query.pid, ctx.processes, windows);
    if (walk.appName) {
      return resolveCandidateForApp(walk.appName, walk.pidsSeen, query, ctx, 200);
    }
    if (walk.exactWindow) {
      return {
        targetApp: walk.exactWindow.appName,
        windowTitle: walk.exactWindow.title || "",
        windowIndex: walk.exactWindow.windowIndex,
        pid: walk.exactWindow.pid,
        score: 200,
      };
    }
  }

  // Step 2: Live CLI process discovery & CWD disambiguation (e.g. codex / claude without session PID)
  if (harness === "codex" || harness === "claude") {
    const cliEntries: MacProcessEntry[] = [];
    for (const entry of ctx.processes.values()) {
      if (entry.exeName.toLowerCase() !== harness) continue;
      if (
        harness === "claude" &&
        (entrypoint === "cli" || entrypoint === "sdk-cli") &&
        entry.appName &&
        macAppsMatch(entry.appName, "Claude")
      ) {
        continue;
      }
      cliEntries.push(entry);
    }

    let bestStep2: MacFocusCandidate | null = null;
    for (const cliEntry of cliEntries) {
      const walk = walkProcessTreeToApp(cliEntry.pid, ctx.processes, windows);
      if (!walk.appName && !walk.exactWindow) continue;

      const resolved = walk.appName
        ? resolveCandidateForApp(walk.appName, walk.pidsSeen, query, ctx, 50)
        : {
            targetApp: walk.exactWindow!.appName,
            windowTitle: walk.exactWindow!.title || "",
            windowIndex: walk.exactWindow!.windowIndex,
            pid: walk.exactWindow!.pid,
            score: 50,
          };

      let score = 50;
      const procCwd = ctx.cwds?.get(cliEntry.pid);
      if (procCwd && query.cwd) {
        if (cwdsExactMatch(procCwd, query.cwd)) {
          score += 120;
        } else if (cwdsRelatedMatch(procCwd, query.cwd)) {
          score += 60;
        }
      }
      if (procCwd && query.project) {
        const cwdBase = path.posix.basename(normalizePath(procCwd));
        if (cwdBase && cwdBase === query.project.trim().toLowerCase()) {
          score += 40;
        }
      }

      if (resolved.windowTitle) {
        if (titleMatchesCwd(resolved.windowTitle, query.cwd)) score += 80;
        if (titleMatchesProject(resolved.windowTitle, query.project)) score += 40;
        if (titleMatchesLabel(resolved.windowTitle, query.label)) score += 20;
      }

      if (harness === "claude") {
        if (entrypoint === "claude-desktop" && macAppsMatch(resolved.targetApp, "Claude")) {
          score += 50;
        } else if (
          (entrypoint === "cli" || entrypoint === "sdk-cli") &&
          isMacTerminalOrIdeApp(resolved.targetApp)
        ) {
          score += 30;
        }
      } else if (harness === "codex" && macAppsMatch(resolved.targetApp, "Codex")) {
        score += 30;
      }

      if (!bestStep2 || score > bestStep2.score) {
        bestStep2 = { ...resolved, score };
      }
    }

    if (bestStep2) {
      return bestStep2;
    }
  }

  // Step 3: Harness-specific fallback across open windows and running GUI apps
  const candidates: Array<{ appName: string; title: string; windowIndex?: number; pid?: number }> =
    windows.map((w) => ({
      appName: w.appName,
      title: w.title || "",
      windowIndex: w.windowIndex,
      pid: w.pid,
    }));

  for (const app of runningApps) {
    const alreadyHasWindow = candidates.some(
      (c) =>
        (app.pid !== undefined && c.pid === app.pid) || macAppsMatch(c.appName, app.name)
    );
    if (!alreadyHasWindow) {
      candidates.push({
        appName: app.name,
        title: "",
        pid: app.pid,
      });
    }
  }

  let bestStep3: MacFocusCandidate | null = null;

  for (const item of candidates) {
    let score = 0;

    if (harness === "antigravity") {
      if (macAppsMatch(item.appName, "Antigravity")) {
        score = 10;
        if (titleMatchesLabel(item.title, query.label)) score += 100;
        if (titleMatchesProject(item.title, query.project)) score += 50;
        if (titleMatchesCwd(item.title, query.cwd)) score += 40;
      }
    } else if (harness === "strata") {
      if (
        macAppsMatch(item.appName, "Strata") ||
        (item.title && item.title.toLowerCase().includes("strata"))
      ) {
        score = 10;
        if (titleMatchesProject(item.title, query.project)) score += 50;
        if (titleMatchesLabel(item.title, query.label)) score += 40;
        if (titleMatchesCwd(item.title, query.cwd)) score += 30;
      }
    } else if (harness === "claude") {
      const isTerminal = isMacTerminalOrIdeApp(item.appName);
      const isClaudeDesktop = macAppsMatch(item.appName, "Claude");

      if (entrypoint === "claude-desktop") {
        if (isClaudeDesktop) {
          score = 160;
          if (titleMatchesProject(item.title, query.project)) score += 20;
        } else if (isTerminal) {
          score = 20;
          if (titleMatchesCwd(item.title, query.cwd)) score += 80;
          if (titleMatchesProject(item.title, query.project)) score += 40;
        }
      } else if (entrypoint === "cli" || entrypoint === "sdk-cli") {
        if (isTerminal) {
          score = 20;
          if (titleMatchesCwd(item.title, query.cwd)) score += 80;
          if (titleMatchesProject(item.title, query.project)) score += 40;
        } else if (isClaudeDesktop) {
          score = 10;
        }
      } else {
        if (isClaudeDesktop) {
          score = 60;
        } else if (isTerminal) {
          score = 20;
          if (titleMatchesCwd(item.title, query.cwd)) score += 80;
          if (titleMatchesProject(item.title, query.project)) score += 40;
        }
      }
    } else if (harness === "codex") {
      const isTerminal = isMacTerminalOrIdeApp(item.appName);
      const isCodexDesktop = macAppsMatch(item.appName, "Codex");

      if (isCodexDesktop) {
        score = 90;
        if (titleMatchesProject(item.title, query.project)) score += 40;
        if (titleMatchesLabel(item.title, query.label)) score += 20;
      } else if (isTerminal) {
        score = 20;
        if (titleMatchesCwd(item.title, query.cwd)) score += 80;
        if (titleMatchesProject(item.title, query.project)) score += 40;
      }
    }

    if (score > 0 && (!bestStep3 || score > bestStep3.score)) {
      bestStep3 = {
        targetApp: item.appName,
        windowTitle: item.title,
        windowIndex: item.windowIndex,
        pid: item.pid,
        score,
      };
    }
  }

  return bestStep3;
}

function findClaudeSessionInfo(rawId: string): { pid?: number; entrypoint?: string } {
  try {
    const sessionsDir = path.join(os.homedir(), ".claude", "sessions");
    if (!fs.existsSync(sessionsDir)) return {};
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
          const data = JSON.parse(content);
          if (data && data.sessionId === rawId) {
            const pid = typeof data.pid === "number" ? data.pid : undefined;
            const entrypoint = typeof data.entrypoint === "string" ? data.entrypoint : undefined;
            return { pid, entrypoint };
          }
        } catch {
          // ignore corrupted/unreadable single file
        }
      }
    }
  } catch {
    // ignore directory read error
  }
  return {};
}

function execFileText(
  file: string,
  args: string[],
  timeoutMs = 3000,
  maxBuffer = 4 * 1024 * 1024
): Promise<{ stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        error: err || undefined,
      });
    });
  });
}

async function queryMacProcesses(): Promise<Map<number, MacProcessEntry>> {
  const { stdout } = await execFileText("/bin/ps", ["-ax", "-o", "pid=,ppid=,comm="], 2500);
  return parseMacPsOutput(stdout);
}

async function queryMacCwds(pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  const bounded = pids.slice(0, 32).join(",");
  const { stdout } = await execFileText("/usr/sbin/lsof", ["-a", "-p", bounded, "-d", "cwd", "-Fn"], 2000);
  return parseLsofCwdOutput(stdout);
}

const MAC_ENUMERATE_JXA = `
ObjC.import("AppKit");
const runningApps = [];
const windows = [];
try {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    if (app.activationPolicy !== $.NSApplicationActivationPolicyRegular) continue;
    const name = app.localizedName ? ObjC.unwrap(app.localizedName) : "";
    const bundleId = app.bundleIdentifier ? ObjC.unwrap(app.bundleIdentifier) : "";
    const pid = app.processIdentifier;
    if (name) {
      runningApps.push({ name, bundleId, pid });
    }
  }
} catch {}
try {
  const se = Application("System Events");
  const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
  for (let i = 0; i < procs.length; i++) {
    const p = procs[i];
    const appName = p.name();
    const pid = p.unixId();
    const wins = p.windows();
    for (let w = 0; w < wins.length; w++) {
      const title = wins[w].name() || "";
      windows.push({ appName, pid, title, windowIndex: w + 1 });
    }
  }
} catch {}
JSON.stringify({ runningApps, windows });
`;

async function queryMacAppsAndWindows(): Promise<{
  runningApps: MacRunningApp[];
  windows: MacWindowInfo[];
}> {
  const { stdout } = await execFileText(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", MAC_ENUMERATE_JXA],
    3000
  );
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { runningApps: [], windows: [] };
  }
  try {
    const parsed = JSON.parse(trimmed);
    return {
      runningApps: Array.isArray(parsed.runningApps) ? parsed.runningApps : [],
      windows: Array.isArray(parsed.windows) ? parsed.windows : [],
    };
  } catch {
    return { runningApps: [], windows: [] };
  }
}

export function buildMacActivateJxa(candidate: Pick<
  MacFocusCandidate,
  "targetApp" | "pid" | "windowIndex" | "windowTitle"
>): string {
  const safePayload = JSON.stringify({
    targetApp: candidate.targetApp || "",
    targetPid: candidate.pid || 0,
    windowIndex: candidate.windowIndex || 0,
    windowTitle: candidate.windowTitle || "",
  })
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `
(() => {
  ObjC.import("AppKit");
  const params = ${safePayload};
  const targetApp = params.targetApp;
  const targetPid = Number(params.targetPid || 0);
  const windowIndex = Number(params.windowIndex || 0);
  const windowTitle = params.windowTitle || "";

  let activated = false;
  try {
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    for (let i = 0; i < apps.count; i++) {
      const app = apps.objectAtIndex(i);
      if (app.activationPolicy !== $.NSApplicationActivationPolicyRegular) continue;
      const pid = app.processIdentifier;
      const name = app.localizedName ? ObjC.unwrap(app.localizedName) : "";
      if ((targetPid > 0 && pid === targetPid) || (targetApp && name.toLowerCase() === targetApp.toLowerCase())) {
        app.activateWithOptions(2);
        activated = true;
        break;
      }
    }
  } catch {}

  if (!activated && targetApp) {
    try {
      Application(targetApp).activate();
      activated = true;
    } catch {}
  }

  try {
    const se = Application("System Events");
    let proc = null;
    if (targetPid > 0) {
      const matches = se.applicationProcesses.whose({ unixId: targetPid })();
      if (matches.length > 0) proc = matches[0];
    }
    if (!proc && targetApp) {
      proc = se.applicationProcesses.byName(targetApp);
    }
    if (proc && proc.exists()) {
      const wins = proc.windows();
      let targetWin = null;
      if (windowIndex > 0 && windowIndex <= wins.length) {
        targetWin = wins[windowIndex - 1];
      } else if (windowTitle) {
        for (let w = 0; w < wins.length; w++) {
          if (wins[w].name() === windowTitle) {
            targetWin = wins[w];
            break;
          }
        }
      }
      if (targetWin) {
        targetWin.actions.byName("AXRaise").perform();
      }
    }
  } catch {}

  return JSON.stringify({ activated });
})();
`;
}

async function activateMacCandidate(candidate: MacFocusCandidate): Promise<boolean> {
  const script = buildMacActivateJxa(candidate);
  const { stdout, error } = await execFileText(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script],
    3000
  );
  if (error && !stdout) {
    return false;
  }
  try {
    const parsed = JSON.parse(stdout.trim());
    return Boolean(parsed.activated);
  } catch {
    return !error;
  }
}

async function focusMacAgentWindow(
  query: MacFocusTargetQuery,
  options?: { dryRun?: boolean }
): Promise<FocusResult> {
  const [processes, appState] = await Promise.all([
    queryMacProcesses(),
    queryMacAppsAndWindows(),
  ]);

  let cwds: Map<number, string> | undefined;
  const needsLsof =
    (query.harness === "codex" || query.harness === "claude") &&
    (!query.pid || !processes.has(query.pid));

  if (needsLsof) {
    const cliPids: number[] = [];
    for (const proc of processes.values()) {
      if (proc.exeName.toLowerCase() === query.harness.toLowerCase()) {
        cliPids.push(proc.pid);
      }
    }
    if (cliPids.length > 0) {
      cwds = await queryMacCwds(cliPids);
    }
  }

  const candidate = selectMacFocusCandidate(query, {
    processes,
    cwds,
    runningApps: appState.runningApps,
    windows: appState.windows,
  });

  if (!candidate) {
    return { ok: false, reason: "No matching open window found" };
  }

  if (!options?.dryRun) {
    const activated = await activateMacCandidate(candidate);
    if (!activated) {
      return {
        ok: false,
        targetApp: candidate.targetApp,
        windowTitle: candidate.windowTitle,
        reason: `Failed to activate ${candidate.targetApp}`,
      };
    }
  }

  return {
    ok: true,
    targetApp: candidate.targetApp,
    windowTitle: candidate.windowTitle,
  };
}

function getFocusHelperPath(): string {
  const resPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resPath
      ? [
          path.join(resPath, "app.asar.unpacked", "assets", "orbit-focus.exe"),
          path.join(resPath, "assets", "orbit-focus.exe"),
        ]
      : []),
    path.resolve(__dirname, "../../assets/orbit-focus.exe").replace("app.asar", "app.asar.unpacked"),
    path.resolve(__dirname, "../../assets/orbit-focus.exe"),
    path.resolve(__dirname, "../assets/orbit-focus.exe"),
    path.resolve(__dirname, "assets/orbit-focus.exe"),
    path.resolve(process.cwd(), "assets/orbit-focus.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export async function focusAgentNodeWindow(
  nodeId: string,
  store: GraphStore,
  options?: { dryRun?: boolean }
): Promise<FocusResult> {
  const node = store.getNodeById(nodeId);
  if (!node) {
    return { ok: false, reason: "Agent not found" };
  }

  // If subagent, resolve up parentId to root orchestrator node
  const root: MutableAgentNode = store.getRootNode ? (store.getRootNode(node.id) ?? node) : node;

  const harness = root.harness || node.harness;
  const cwd = root.cwd || node.cwd;
  const project = root.project || node.project;
  const label = root.label || node.label;
  let entrypoint = root.entrypoint || node.entrypoint;
  let pid: number | undefined;

  if (root.harness === "claude" && !root.isSimulated) {
    const sessionInfo = findClaudeSessionInfo(root.rawId);
    if (sessionInfo.pid) {
      pid = sessionInfo.pid;
    }
    if (!entrypoint && sessionInfo.entrypoint) {
      entrypoint = sessionInfo.entrypoint;
    }
  }

  if (process.platform === "darwin") {
    return focusMacAgentWindow(
      {
        harness,
        pid,
        cwd,
        project,
        label,
        entrypoint,
      },
      options
    );
  }

  if (process.platform !== "win32") {
    return { ok: false, reason: "Window focus is not supported on this platform" };
  }

  const helperPath = getFocusHelperPath();
  if (!fs.existsSync(helperPath)) {
    return { ok: false, reason: "Focus helper executable not found" };
  }

  const args: string[] = ["--harness", harness];
  if (pid) {
    args.push("--pid", String(pid));
  }
  if (cwd) {
    args.push("--cwd", cwd);
  }
  if (project) {
    args.push("--project", project);
  }
  if (label) {
    args.push("--label", label);
  }
  if (entrypoint) {
    args.push("--entrypoint", entrypoint);
  }
  if (options?.dryRun) {
    args.push("--dry-run");
  }

  return new Promise<FocusResult>((resolve) => {
    execFile(
      helperPath,
      args,
      { windowsHide: true, timeout: 3000 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ ok: false, reason: err.message || "Failed to execute focus helper" });
          return;
        }

        const outStr = (stdout || "").trim();
        if (!outStr) {
          resolve({ ok: false, reason: "Empty response from focus helper" });
          return;
        }

        try {
          const res = JSON.parse(outStr) as FocusResult;
          resolve(res);
        } catch {
          resolve({ ok: false, reason: `Failed to parse focus helper output: ${outStr}` });
        }
      }
    );
  });
}
