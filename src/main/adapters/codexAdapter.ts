import path from "path";
import {
  computePatchLineDelta,
  extractSkillFromPath,
  formatPatchPreview,
  serializeToolCallInput,
} from "../../shared/types";
import { GraphStore } from "../graphStore";

export interface CodexFileContext {
  filePath: string;
  sessionId: string;
  nodeId: string;
}

export function parseCodexFilePath(filePath: string): CodexFileContext | null {
  const base = path.basename(filePath, ".jsonl");
  if (!base.startsWith("rollout-")) return null;
  // Format: rollout-2026-11-10T19-30-32-01a1c803-74b6-7a31-bb74-21470f547527
  const uuidMatch = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  const sessionId = uuidMatch ? uuidMatch[1] : base;
  return {
    filePath,
    sessionId,
    nodeId: `codex:${sessionId}`,
  };
}

export function ingestCodexLine(
  ctx: CodexFileContext,
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

  const ts = (obj.timestamp ? Date.parse(obj.timestamp) : NaN) || fallbackTs;
  const type = obj.type;
  const payload = obj.payload || {};

  if (type === "session_meta") {
    const actualId = payload.id || payload.session_id || ctx.sessionId;
    ctx.sessionId = actualId;
    ctx.nodeId = `codex:${actualId}`;
    const parentRaw = payload.parent_thread_id;
    const parentId = parentRaw ? `codex:${parentRaw}` : undefined;

    if (parentId) {
      store.upsertNode({
        id: parentId,
        rawId: String(parentRaw),
        harness: "codex",
        cwd: payload.cwd,
        timestamp: ts,
      });
    }

    const nickname =
      typeof payload.agent_nickname === "string" && payload.agent_nickname.trim()
        ? payload.agent_nickname.trim()
        : undefined;

    store.upsertNode({
      id: ctx.nodeId,
      rawId: actualId,
      harness: "codex",
      parentId,
      isSubagent: Boolean(parentId),
      label: nickname,
      isCustomLabel: Boolean(nickname),
      cwd: payload.cwd,
      branch: payload.git?.branch,
      timestamp: ts,
      emitSpawnPulse: isLive,
    });
    return;
  }

  // Ensure node exists for any subsequent line
  const node = store.upsertNode({
    id: ctx.nodeId,
    rawId: ctx.sessionId,
    harness: "codex",
    cwd: payload.cwd,
    model: payload.model,
    timestamp: ts,
  });

  if (type === "event_msg") {
    if (payload.type === "task_started") {
      store.recordTurnPhase(ctx.nodeId, "thinking", ts);
    } else if (payload.type === "task_complete") {
      if (typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
        store.recordAssistantMilestone(ctx.nodeId, payload.last_agent_message, ts);
      }
      if (node.isSubagent) {
        store.markCompleted(ctx.nodeId, ts, isLive);
      } else {
        store.recordTurnPhase(ctx.nodeId, "waiting_on_user", ts);
      }
    } else if (payload.type === "token_count") {
      const info = payload.info;
      if (info && typeof info === "object") {
        const last = info.last_token_usage;
        const total = info.total_token_usage;
        const contextTokens =
          Number(last?.total_tokens) ||
          (Number(last?.input_tokens) || 0) + (Number(last?.output_tokens) || 0);
        const cumulativeTotalTokens = Number(total?.total_tokens) || contextTokens;
        const cumulativeOutputTokens =
          Number(total?.output_tokens) || Number(last?.output_tokens) || 0;
        const contextMaxTokens = Number(info.model_context_window) || undefined;
        if (contextTokens > 0 || cumulativeTotalTokens > 0) {
          store.recordModelTurn(
            ctx.nodeId,
            cumulativeTotalTokens > 0 ? `tok:${cumulativeTotalTokens}` : undefined
          );
          store.recordTokenUsage(ctx.nodeId, {
            contextTokens,
            cumulativeTotalTokens,
            cumulativeOutputTokens,
            contextMaxTokens,
          });
        }
      }
    }
    return;
  }

  if (type === "response_item") {
    const pType = payload.type;
    if (
      pType === "function_call" ||
      pType === "custom_tool_call" ||
      pType === "local_shell_call"
    ) {
      const toolName = String(
        payload.name || (pType === "local_shell_call" ? "shell" : "tool")
      );
      const callId = String(payload.call_id || payload.id || `${ts}-${toolName}`);
      let target = extractCodexTarget(payload);

      // Detect SKILL.md reads inside shell commands or file reads
      const rawText =
        typeof payload.arguments === "string"
          ? payload.arguments
          : typeof payload.input === "string"
            ? payload.input
            : JSON.stringify(payload.input || {});
      const skillMatch = rawText.match(/skills[\\/]+([a-zA-Z0-9_-]+)[\\/]+SKILL\.md/i);
      if (skillMatch && skillMatch[1]) {
        store.recordSkill(ctx.nodeId, skillMatch[1], ts, isLive);
      }
      const directSkill = extractSkillFromPath(target);
      if (directSkill) {
        store.recordSkill(ctx.nodeId, directSkill, ts, isLive);
      }

      let rawCommand: string | undefined;
      const isShell =
        toolName === "exec" ||
        toolName === "exec_command" ||
        toolName === "shell" ||
        toolName === "local_shell_call" ||
        pType === "local_shell_call";

      if (isShell) {
        rawCommand = extractCodexCommand(payload);
        if (rawCommand) target = rawCommand;
      }

      let linesAdded: number | undefined;
      let linesRemoved: number | undefined;
      let diffPreview: string | undefined;
      let fullText: string | undefined;
      let explicitFilePath: string | undefined;

      if (toolName === "apply_patch") {
        const rawPatch =
          typeof payload.input === "string"
            ? payload.input
            : typeof payload.arguments === "string"
              ? payload.arguments
              : payload.input?.patch || payload.arguments?.patch || "";
        const patchDelta = computePatchLineDelta(rawPatch);
        if (patchDelta) {
          linesAdded = patchDelta.linesAdded;
          linesRemoved = patchDelta.linesRemoved;
          if (patchDelta.firstFile) {
            target = patchDelta.firstFile;
            explicitFilePath = patchDelta.firstFile;
          }
        }
        diffPreview = formatPatchPreview(rawPatch);
      }

      let parsedArgs: any = {};
      if (typeof payload.arguments === "string") {
        try {
          parsedArgs = JSON.parse(payload.arguments);
        } catch {}
      } else if (payload.arguments && typeof payload.arguments === "object") {
        parsedArgs = payload.arguments;
      } else if (typeof payload.input === "string") {
        try {
          parsedArgs = JSON.parse(payload.input);
        } catch {}
      } else if (payload.input && typeof payload.input === "object") {
        parsedArgs = payload.input;
      }

      if (!explicitFilePath && !isShell && parsedArgs && typeof parsedArgs === "object") {
        const fp = parsedArgs.file_path || parsedArgs.target_file || parsedArgs.path;
        if (typeof fp === "string") {
          explicitFilePath = fp;
        }
      }

      let waitingPrompt: string | undefined;
      const tLow = toolName.toLowerCase();
      if (tLow === "request_user_input" || tLow === "request_user_input_async") {
        waitingPrompt =
          parsedArgs.questions?.[0]?.question || parsedArgs.prompt || parsedArgs.message;
        if (Array.isArray(parsedArgs.questions) && parsedArgs.questions.length > 0) {
          fullText = parsedArgs.questions
            .map((q: any) => {
              const header = q.question || "";
              const opts = Array.isArray(q.options)
                ? q.options.map((o: any) => `  • ${typeof o === "string" ? o : o.label || o.text || JSON.stringify(o)}`).join("\n")
                : "";
              return opts ? `${header}\n${opts}` : header;
            })
            .join("\n\n");
        } else if (parsedArgs.prompt || parsedArgs.message) {
          fullText = String(parsedArgs.prompt || parsedArgs.message);
        }
      }

      const rawArgsForDisplay =
        parsedArgs && typeof parsedArgs === "object" && Object.keys(parsedArgs).length > 0
          ? parsedArgs
          : payload.input ?? payload.arguments;
      const toolInput = serializeToolCallInput(toolName, rawArgsForDisplay, {
        hasDiff: Boolean(diffPreview),
        omitCommandKeys: isShell,
      });

      store.recordToolStart(ctx.nodeId, {
        callId,
        name: toolName,
        target,
        filePath: explicitFilePath,
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
    } else if (
      pType === "function_call_output" ||
      pType === "custom_tool_call_output" ||
      pType === "local_shell_call_output"
    ) {
      const callId = String(payload.call_id || payload.id || "");
      let durationMs: number | undefined;
      if (payload.wall_time_s !== undefined && !isNaN(Number(payload.wall_time_s))) {
        durationMs = Math.round(Number(payload.wall_time_s) * 1000);
      }
      let exitCode: number | undefined;
      if (typeof payload.exit_code === "number") {
        exitCode = payload.exit_code;
      } else if (typeof payload.output === "string") {
        const m = payload.output.match(/Process exited with code (\d+)/i);
        if (m && m[1]) exitCode = parseInt(m[1], 10);
      }
      const isError = Boolean(
        payload.is_error || (exitCode !== undefined && exitCode !== 0)
      );

      let output: string | undefined;
      if (typeof payload.output === "string") {
        output = payload.output;
      } else if (typeof payload.content === "string") {
        output = payload.content;
      } else if (payload.output && typeof payload.output === "object") {
        output = JSON.stringify(payload.output, null, 2);
      }

      store.recordToolEnd(ctx.nodeId, {
        callId: callId || undefined,
        allInFlight: !callId,
        output,
        isError,
        durationMs,
        exitCode,
        timestamp: ts,
        isLive,
      });
    }
  }
}

function extractCodexCommand(payload: any): string | undefined {
  if (typeof payload.arguments === "string") {
    try {
      const args = JSON.parse(payload.arguments);
      if (args.cmd || args.command) return String(args.cmd || args.command);
    } catch {}
  } else if (payload.arguments && typeof payload.arguments === "object") {
    if (payload.arguments.cmd || payload.arguments.command) {
      return String(payload.arguments.cmd || payload.arguments.command);
    }
  }
  if (typeof payload.input === "string") {
    const raw = payload.input.trim();
    const cmdMatch = raw.match(/cmd\s*:\s*["']([^"']+)["']/i);
    if (cmdMatch && cmdMatch[1]) {
      return cmdMatch[1];
    }
    if (raw.startsWith("{") && raw.endsWith("}")) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.cmd || parsed.command) return String(parsed.cmd || parsed.command);
      } catch {}
    }
    return raw;
  }
  if (payload.action?.command) {
    return Array.isArray(payload.action.command)
      ? payload.action.command.join(" ")
      : String(payload.action.command);
  }
  return undefined;
}

function extractCodexTarget(payload: any): string | undefined {
  if (typeof payload.input === "string" && payload.input.trim()) {
    return payload.input.trim().split("\n")[0];
  }
  if (typeof payload.arguments === "string") {
    try {
      const args = JSON.parse(payload.arguments);
      return (
        args.cmd ||
        args.command ||
        args.path ||
        args.file_path ||
        args.agent_nickname ||
        args.role ||
        args.message
      );
    } catch {
      return undefined;
    }
  }
  if (payload.action?.command) {
    return Array.isArray(payload.action.command)
      ? payload.action.command.join(" ")
      : String(payload.action.command);
  }
  return undefined;
}
