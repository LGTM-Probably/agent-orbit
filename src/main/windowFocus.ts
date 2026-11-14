import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { FocusResult } from "../shared/types";
import { GraphStore, MutableAgentNode } from "./graphStore";

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
