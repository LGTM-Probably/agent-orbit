import fs from "fs";
import os from "os";
import path from "path";
import {
  buildCompactDiffPreview,
  computeEditLineDelta,
  extractSkillFromPath,
  formatSearchTargetSummary,
  projectFromCwd,
  serializeToolCallInput,
} from "../../shared/types";
import { decodeXmlEntities, extractFullUserPrompt, GraphStore } from "../graphStore";

export interface StrataFileContext {
  filePath: string;
  sessionId: string;
  nodeId: string;
  parentId?: string;
  pendingSubagentRoles?: string[];
}

export function parseStrataFilePath(filePath: string): StrataFileContext | null {
  const norm = filePath.replace(/\\/g, "/");
  if (!norm.toLowerCase().includes("/.strata/")) {
    return null;
  }

  // 1. Real Strata v4 sessions:
  // .../.strata/data/agent/home/sessions/<folder>/<sessionId>/session.v4.jsonl(.zstd)
  const v4Match = norm.match(
    /\/sessions\/[^/]+\/([^/]+)\/session\.v4\.jsonl(?:\.zstd)?$/i
  );
  if (v4Match && v4Match[1]) {
    const sessionId = v4Match[1];
    return {
      filePath,
      sessionId,
      nodeId: `strata:${sessionId}`,
      pendingSubagentRoles: [],
    };
  }

  // 2. Generic Strata sessions: .../sessions/<sessionId>.jsonl(.zstd)
  const genericMatch = norm.match(/\/sessions\/([^/]+)\.jsonl(?:\.zstd)?$/i);
  if (genericMatch && genericMatch[1]) {
    const sessionId = genericMatch[1];
    return {
      filePath,
      sessionId,
      nodeId: `strata:${sessionId}`,
      pendingSubagentRoles: [],
    };
  }

  // 3. Fallback for any .jsonl in ~/.strata
  const baseMatch = norm.match(/\/([^/]+)\.jsonl(?:\.zstd)?$/i);
  if (baseMatch && baseMatch[1]) {
    const sessionId = baseMatch[1];
    return {
      filePath,
      sessionId,
      nodeId: `strata:${sessionId}`,
      pendingSubagentRoles: [],
    };
  }

  return null;
}

export function ingestStrataLine(
  ctx: StrataFileContext,
  line: string,
  store: GraphStore,
  fallbackTs: number,
  isLive: boolean
): void {
  if (!line || line[0] !== "{") return;

  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  const rawTime = obj.time ?? obj.createdAt ?? obj.timestamp;
  const ts =
    typeof rawTime === "number"
      ? rawTime
      : rawTime
        ? Date.parse(rawTime) || fallbackTs
        : fallbackTs;

  const type = String(obj.type || obj.kind || "");

  // 1. Strata v4 Session Header
  if (type === "session") {
    const actualId = obj.id || ctx.sessionId;
    ctx.sessionId = actualId;
    ctx.nodeId = `strata:${actualId}`;

    const parentRaw = obj.parentSession;
    if (parentRaw) {
      ctx.parentId = `strata:${parentRaw}`;
      store.upsertNode({
        id: ctx.parentId,
        rawId: String(parentRaw),
        harness: "strata",
        cwd: obj.cwd,
        timestamp: ts,
      });
    }

    store.upsertNode({
      id: ctx.nodeId,
      rawId: actualId,
      harness: "strata",
      parentId: ctx.parentId,
      isSubagent: Boolean(ctx.parentId || obj.origin === "subagent"),
      cwd: obj.cwd,
      timestamp: ts,
      emitSpawnPulse: isLive,
    });
    return;
  }

  // 2. Generic session_meta fallback
  if (type === "session_meta") {
    const payload = obj.payload || {};
    const actualId = payload.id || payload.session_id || ctx.sessionId;
    ctx.sessionId = actualId;
    ctx.nodeId = `strata:${actualId}`;

    const parentRaw = payload.parent_session_id || payload.parent_thread_id;
    if (parentRaw) {
      ctx.parentId = `strata:${parentRaw}`;
      store.upsertNode({
        id: ctx.parentId,
        rawId: String(parentRaw),
        harness: "strata",
        cwd: payload.cwd,
        timestamp: ts,
      });
    }

    const nickname =
      typeof payload.agent_nickname === "string" && payload.agent_nickname.trim()
        ? payload.agent_nickname.trim()
        : payload.label;

    store.upsertNode({
      id: ctx.nodeId,
      rawId: actualId,
      harness: "strata",
      parentId: ctx.parentId,
      isSubagent: Boolean(ctx.parentId),
      label: nickname,
      isCustomLabel: Boolean(nickname),
      cwd: payload.cwd,
      model: payload.model,
      timestamp: ts,
      emitSpawnPulse: isLive,
    });
    return;
  }

  // Ensure node exists for subsequent events
  const node = store.upsertNode({
    id: ctx.nodeId,
    rawId: ctx.sessionId,
    harness: "strata",
    timestamp: ts,
  });

  // Extract token usage when present across Strata v4 / OpenAI-style usage payloads
  const usage =
    obj.usage ||
    obj.data?.usage ||
    obj.payload?.usage ||
    obj.token_usage ||
    obj.data?.token_usage ||
    obj.message?.usage ||
    obj.data?.message?.usage;
  if (usage && typeof usage === "object") {
    const inTok =
      (Number(usage.input_tokens ?? usage.prompt_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0) +
      (Number(usage.cache_read_input_tokens ?? usage.cache_read_tokens) || 0);
    const outTok = Number(usage.output_tokens ?? usage.completion_tokens) || 0;
    const explicitTotal = Number(usage.total_tokens) || 0;
    const turnTotal = explicitTotal > 0 ? explicitTotal : inTok + outTok;
    const contextMaxTokens =
      Number(
        usage.context_window ??
          usage.max_context_tokens ??
          usage.model_context_window ??
          obj.context_window ??
          obj.max_context_tokens ??
          obj.data?.context_window ??
          obj.data?.max_context_tokens
      ) || undefined;
    const cumulativeTotal =
      Number(usage.cumulative_total_tokens ?? usage.session_total_tokens) || undefined;
    const cumulativeOut =
      Number(usage.cumulative_output_tokens ?? usage.session_output_tokens) || undefined;
    const rawTurnKey = obj.id ?? obj.data?.id ?? obj.message?.id ?? obj.data?.message?.id;

    if (turnTotal > 0 || (cumulativeTotal && cumulativeTotal > 0)) {
      const turnKey =
        typeof rawTurnKey === "string"
          ? rawTurnKey
          : cumulativeTotal && cumulativeTotal > 0
            ? `cum:${cumulativeTotal}`
            : undefined;
      store.recordModelTurn(ctx.nodeId, turnKey);
      store.recordTokenUsage(ctx.nodeId, {
        turnKey: typeof rawTurnKey === "string" ? rawTurnKey : undefined,
        contextTokens: turnTotal > 0 ? turnTotal : undefined,
        turnTotalTokens: cumulativeTotal ? undefined : turnTotal,
        turnOutputTokens: cumulativeTotal ? undefined : outTok,
        cumulativeTotalTokens: cumulativeTotal,
        cumulativeOutputTokens: cumulativeOut,
        contextMaxTokens,
      });
    }
  }

  // 3. Subagent descriptor (real Strata v4)
  if (type === "subagent/descriptor") {
    const data = obj.data || {};
    const label = data.label ? String(data.label).trim() : undefined;
    const model = data.agentModel ? String(data.agentModel).trim() : undefined;

    store.upsertNode({
      id: ctx.nodeId,
      rawId: ctx.sessionId,
      harness: "strata",
      label,
      isCustomLabel: Boolean(label),
      model,
      isSubagent: true,
      timestamp: ts,
    });
    return;
  }

  // 4. Session title (real Strata v4)
  if (type === "session/title") {
    const data = obj.data || {};
    const title = data.title ? String(data.title).trim() : undefined;
    if (title && (!node.hasCustomLabel || !node.isSubagent)) {
      store.upsertNode({
        id: ctx.nodeId,
        rawId: ctx.sessionId,
        harness: "strata",
        label: title,
        isCustomLabel: true,
        timestamp: ts,
      });
    }
    return;
  }

  // 5. Working directory change (real Strata v4)
  if (type === "working-directory/change") {
    const data = obj.data || {};
    if (data.cwd) {
      store.upsertNode({
        id: ctx.nodeId,
        rawId: ctx.sessionId,
        harness: "strata",
        cwd: data.cwd,
        timestamp: ts,
      });
    }
    return;
  }

  // 6. Request header / model configuration (real Strata v4)
  if (type === "request/header") {
    const data = obj.data || {};
    const model = data.header?.config?.model;
    if (model) {
      store.upsertNode({
        id: ctx.nodeId,
        rawId: ctx.sessionId,
        harness: "strata",
        model: String(model),
        timestamp: ts,
      });
    }
    return;
  }

  // 7. User messages (thinking transition + clean label derivation)
  if (type === "user/message" || type === "user") {
    store.recordTurnPhase(ctx.nodeId, "thinking", ts);

    const data = obj.data || obj.payload || {};
    const textContent = extractStrataTextContent(data.content ?? obj.message?.content);

    if (textContent) {
      store.recordUserPrompt(ctx.nodeId, textContent, ts);

      // Check for skill triggers like <command-name> or skills
      const cmdMatch = textContent.match(/<command-name>\/?([a-zA-Z0-9_:-]+)<\/command-name>/i);
      if (cmdMatch && cmdMatch[1]) {
        store.recordSkill(ctx.nodeId, cmdMatch[1], ts, isLive);
      }

      if (!node.hasCustomLabel && !node.isSubagent) {
        const title = deriveTitleFromText(textContent);
        if (title) {
          store.upsertNode({
            id: ctx.nodeId,
            rawId: ctx.sessionId,
            harness: "strata",
            label: title,
            isCustomLabel: true,
            timestamp: ts,
          });
        }
      }
    }
    return;
  }

  // 8. Tool Call (real Strata v4 & generic)
  if (type === "tool/call" || type === "tool_call" || type === "function_call") {
    const data = obj.data || obj.payload || {};
    const toolName = String(data.name || obj.name || "tool");
    const callId = String(data.callId || data.id || `${ts}-${toolName}`);
    const argsRaw = data.arguments || data.input || {};

    const rawStr = typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw);

    // Skill detection from arguments (e.g. SKILL.md reads)
    const skillMatch = rawStr.match(/skills[\\/]+([a-zA-Z0-9_-]+)[\\/]+SKILL\.md/i);
    if (skillMatch && skillMatch[1]) {
      store.recordSkill(ctx.nodeId, skillMatch[1], ts, isLive);
    }

    const target = extractStrataTarget(toolName, argsRaw);
    if (target) {
      const pathSkill = extractSkillFromPath(target);
      if (pathSkill) {
        store.recordSkill(ctx.nodeId, pathSkill, ts, isLive);
      }
    }

    let rawCommand: string | undefined;
    const isShell = ["pwsh", "bash", "sh", "shell", "exec", "run_command"].includes(
      toolName.toLowerCase()
    );
    if (isShell) {
      if (typeof argsRaw === "string") {
        rawCommand = argsRaw;
      } else if (typeof argsRaw === "object" && argsRaw) {
        rawCommand = argsRaw.command || argsRaw.cmd;
      }
    }

    let linesAdded: number | undefined;
    let linesRemoved: number | undefined;
    let diffPreview: string | undefined;
    let fullText: string | undefined;

    if (typeof argsRaw === "object" && argsRaw) {
      if (argsRaw.old_string !== undefined || argsRaw.new_string !== undefined) {
        const delta = computeEditLineDelta(argsRaw.old_string, argsRaw.new_string);
        if (delta) {
          linesAdded = delta.linesAdded;
          linesRemoved = delta.linesRemoved;
        }
        diffPreview = buildCompactDiffPreview(argsRaw.old_string, argsRaw.new_string);
      } else if (
        argsRaw.content !== undefined &&
        (toolName.toLowerCase().includes("write") || toolName.toLowerCase().includes("edit"))
      ) {
        const delta = computeEditLineDelta("", String(argsRaw.content));
        if (delta) {
          linesAdded = delta.linesAdded;
          linesRemoved = delta.linesRemoved;
        }
        diffPreview = buildCompactDiffPreview("", String(argsRaw.content), 60);
      }
    }

    let argsObj: any = typeof argsRaw === "object" && argsRaw ? argsRaw : {};
    if (typeof argsRaw === "string") {
      try {
        argsObj = JSON.parse(argsRaw);
      } catch {}
    }

    let waitingPrompt: string | undefined;
    const tLow = toolName.toLowerCase();
    if (
      tLow === "askuserquestion" ||
      tLow === "ask_question" ||
      tLow === "request_user_input" ||
      tLow === "request_user_input_async" ||
      tLow.includes("board_ask") ||
      tLow.includes("board_wait_for_answers")
    ) {
      waitingPrompt =
        argsObj.questions?.[0]?.question ||
        argsObj.question ||
        argsObj.prompt ||
        argsObj.message ||
        argsObj.title ||
        "Waiting for user input";
      if (Array.isArray(argsObj.questions) && argsObj.questions.length > 0) {
        fullText = argsObj.questions
          .map((q: any) => {
            const header = q.question || "";
            const opts = Array.isArray(q.options)
              ? q.options.map((o: any) => `  • ${typeof o === "string" ? o : o.label || o.text || JSON.stringify(o)}`).join("\n")
              : "";
            return opts ? `${header}\n${opts}` : header;
          })
          .join("\n\n");
      } else if (argsObj.prompt || argsObj.message) {
        fullText = String(argsObj.prompt || argsObj.message);
      }
    }

    const explicitFilePath =
      !isShell && argsObj && typeof argsObj === "object"
        ? argsObj.file_path || argsObj.targetPath || argsObj.target_file || argsObj.path
        : undefined;

    const rawArgsForDisplay =
      argsObj && typeof argsObj === "object" && Object.keys(argsObj).length > 0
        ? argsObj
        : argsRaw;
    const toolInput = serializeToolCallInput(toolName, rawArgsForDisplay, {
      hasDiff: Boolean(diffPreview),
      omitCommandKeys: isShell,
    });

    store.recordToolStart(ctx.nodeId, {
      callId,
      name: toolName,
      target,
      filePath: typeof explicitFilePath === "string" ? explicitFilePath : undefined,
      rawCommand,
      toolInput,
      fullText,
      diffPreview,
      linesAdded,
      linesRemoved,
      waitingPrompt,
      timestamp: ts,
      isLive,
    });
    return;
  }

  // 9. Tool Result (real Strata v4 & generic)
  if (type === "tool/result" || type === "tool_result" || type === "function_call_output") {
    const data = obj.data || obj.payload || {};
    const callId = String(data.toolCallId || data.call_id || data.id || "");
    let output =
      typeof data.output === "string"
        ? data.output
        : typeof data.content === "string"
          ? data.content
          : undefined;
    if (!output && data.output && typeof data.output === "object") {
      output = JSON.stringify(data.output, null, 2);
    }

    store.recordToolEnd(ctx.nodeId, {
      callId: callId || undefined,
      allInFlight: !callId,
      output,
      isError: Boolean(data.isError || obj.is_error),
      timestamp: ts,
      isLive,
    });
    return;
  }

  // 10. Job settled (process / bash result)
  if (type === "job/settled") {
    const data = obj.data || obj.payload || {};
    let exitCode: number | undefined;
    if (typeof data.detail === "string") {
      const m = data.detail.match(/exit code:\s*(-?\d+)/i);
      if (m && m[1]) exitCode = parseInt(m[1], 10);
    }
    let durationMs: number | undefined;
    if (data.startedAt && data.finishedAt) {
      const s = typeof data.startedAt === "number" ? data.startedAt : Date.parse(data.startedAt);
      const f = typeof data.finishedAt === "number" ? data.finishedAt : Date.parse(data.finishedAt);
      if (!isNaN(s) && !isNaN(f) && f >= s) {
        durationMs = f - s;
      }
    }
    const isError = Boolean(data.isError || (exitCode !== undefined && exitCode !== 0));
    let output =
      typeof data.output === "string"
        ? data.output
        : typeof data.stdout === "string"
          ? [data.stdout, data.stderr].filter(Boolean).join("\n")
          : typeof data.detail === "string"
            ? data.detail
            : undefined;

    store.recordToolEnd(ctx.nodeId, {
      callId: data.callId || data.id || undefined,
      allInFlight: !data.callId && !data.id,
      output,
      isError,
      durationMs,
      exitCode,
      timestamp: ts,
      isLive,
    });
    return;
  }

  // 11. Assistant messages
  if (type === "assistant/message" || type === "assistant") {
    if (!usage) {
      const msgKey =
        typeof (obj.id ?? obj.data?.id ?? obj.message?.id) === "string"
          ? String(obj.id ?? obj.data?.id ?? obj.message?.id)
          : undefined;
      store.recordModelTurn(ctx.nodeId, msgKey);
    }
    const text = extractStrataTextContent(
      obj.data?.message?.content ?? obj.message?.content ?? obj.content
    );
    if (text && text.trim()) {
      store.recordAssistantMilestone(ctx.nodeId, text, ts);
    }
    return;
  }

  // 12. Turn end / completion events
  if (type === "turn/end" || type === "turn_end" || type === "task_complete") {
    const data = obj.data || obj.payload || {};
    const reasonKind = data.reason?.kind;

    if (node.isSubagent) {
      store.markCompleted(ctx.nodeId, ts, isLive);
    } else {
      store.recordTurnPhase(ctx.nodeId, "waiting_on_user", ts);
    }
  }
}

function extractStrataTextContent(content: any): string | null {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textPieces = content
      .filter(item => item && (item.type === "text" || typeof item.text === "string"))
      .map(item => item.text);
    return textPieces.join("\n").trim() || null;
  }
  return null;
}

function deriveTitleFromText(raw: string): string | null {
  const body = extractFullUserPrompt(raw);
  if (!body) return null;
  const firstSentence = decodeXmlEntities(body)
    .split(/[\n.!?]/)[0]
    .trim()
    .replace(/^[#>*\-\s]+/, "");
  if (!firstSentence) return null;
  return firstSentence.length > 120 ? firstSentence.slice(0, 117).trim() + "…" : firstSentence;
}

function extractStrataTarget(toolName: string, args: any): string | undefined {
  if (!args) return undefined;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return args.slice(0, 40);
    }
  }
  if (typeof args !== "object") return undefined;

  const lower = toolName.toLowerCase();
  if (lower === "grep" || lower === "glob" || lower.includes("search")) {
    const searchSummary = formatSearchTargetSummary(toolName, args);
    if (searchSummary) return searchSummary;
  }
  if (args.command || args.cmd) return String(args.command || args.cmd);
  if (args.path || args.file_path || args.targetPath) {
    return String(args.path || args.file_path || args.targetPath);
  }
  if (args.query) return String(args.query);
  if (args.url) return String(args.url);
  if (args.label) return String(args.label);
  return undefined;
}

// Zstandard decoder support for live ~/.strata/data/agent/home/sessions/**/*.zstd
let zstdModule: any = null;
let zstdChecked = false;

function getZstdModule(): any {
  if (zstdChecked) return zstdModule;
  zstdChecked = true;
  try {
    const candidate = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Programs",
      "Strata",
      "harness",
      "node_modules",
      "@deepseek-ai",
      "dsh-session-persistence-jsonl",
      "lib",
      "types",
      "zstd.js"
    );
    if (fs.existsSync(candidate)) {
      zstdModule = require(candidate);
    }
  } catch {}
  return zstdModule;
}

export async function ingestStrataZstdFile(
  filePath: string,
  store: GraphStore,
  fallbackTs: number,
  isLive: boolean
): Promise<void> {
  const mod = getZstdModule();
  if (!mod || typeof mod.scanZstdFrames !== "function" || typeof mod.decompressZstdFrame !== "function") {
    return;
  }

  const ctx = parseStrataFilePath(filePath);
  if (!ctx) return;

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return;
  }

  const scan = mod.scanZstdFrames(buf);
  if (!scan || !Array.isArray(scan.frames)) return;

  for (const f of scan.frames) {
    try {
      const frameBuf = buf.subarray(f.start, f.end);
      const decomp = await mod.decompressZstdFrame(frameBuf);
      const lines = decomp.toString("utf-8").trim().split("\n");
      for (const line of lines) {
        if (!line) continue;
        ingestStrataLine(ctx, line, store, fallbackTs, isLive);
      }
    } catch {}
  }
}
