import fs from "fs";
import path from "path";
import {
  buildCompactDiffPreview,
  computeEditLineDelta,
  extractSkillFromPath,
  formatSearchTargetSummary,
  serializeToolCallInput,
} from "../../shared/types";
import { decodeXmlEntities, extractFullUserPrompt, GraphStore } from "../graphStore";

export interface ClaudeFileContext {
  filePath: string;
  sessionId: string;
  subagentId?: string;
  nodeId: string;
  parentId?: string;
  metaLoaded?: boolean;
}

export function parseClaudeFilePath(filePath: string): ClaudeFileContext | null {
  const norm = filePath.replace(/\\/g, "/");
  // Match subagent: .../projects/<proj>/<sessionId>/subagents/agent-<agentId>.jsonl
  const subMatch = norm.match(/\/projects\/[^/]+\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/i);
  if (subMatch) {
    const sessionId = subMatch[1];
    const subagentId = subMatch[2];
    return {
      filePath,
      sessionId,
      subagentId,
      nodeId: `claude:${sessionId}:sub:${subagentId}`,
      parentId: `claude:${sessionId}`,
    };
  }

  // Match root session: .../projects/<proj>/<sessionId>.jsonl
  const rootMatch = norm.match(/\/projects\/[^/]+\/([^/]+)\.jsonl$/i);
  if (rootMatch) {
    const sessionId = rootMatch[1];
    return {
      filePath,
      sessionId,
      nodeId: `claude:${sessionId}`,
    };
  }

  return null;
}

export function ingestClaudeLine(
  ctx: ClaudeFileContext,
  line: string,
  store: GraphStore,
  fallbackTs: number,
  isLive: boolean
): void {
  if (!line || line[0] !== "{") return;

  // Quick pre-filter before full JSON.parse on giant api-request-blob or snapshot lines
  if (
    line.includes('"type":"api-request-blob"') ||
    line.includes('"type":"file-history-snapshot"') ||
    line.includes('"type":"api-request"') ||
    line.includes('"type":"api-request-shape"')
  ) {
    return;
  }

  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  const type = obj.type;
  if (
    type === "api-request-blob" ||
    type === "api-request" ||
    type === "api-request-shape" ||
    type === "file-history-snapshot"
  ) {
    return;
  }

  const ts = (obj.timestamp ? Date.parse(obj.timestamp) : NaN) || fallbackTs;
  const rawId = ctx.subagentId ?? ctx.sessionId;
  const entrypoint = typeof obj.entrypoint === "string" ? obj.entrypoint : undefined;

  // Ensure parent exists if this is a subagent file
  if (ctx.parentId) {
    store.upsertNode({
      id: ctx.parentId,
      rawId: ctx.sessionId,
      harness: "claude",
      cwd: obj.cwd,
      branch: obj.gitBranch,
      entrypoint,
      timestamp: ts,
    });
  }

  const node = store.upsertNode({
    id: ctx.nodeId,
    rawId,
    harness: "claude",
    parentId: ctx.parentId,
    isSubagent: Boolean(ctx.subagentId),
    cwd: obj.cwd,
    branch: obj.gitBranch,
    model: obj.message?.model,
    entrypoint,
    timestamp: ts,
    emitSpawnPulse: isLive,
  });

  if (ctx.subagentId && ctx.parentId && !ctx.metaLoaded) {
    ctx.metaLoaded = true;
    try {
      const metaPath = ctx.filePath.replace(/\.jsonl$/i, ".meta.json");
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (meta && typeof meta === "object") {
          const desc =
            typeof meta.description === "string" && meta.description.trim()
              ? meta.description.trim()
              : undefined;
          const pickedModel =
            typeof meta.pickedEffortModel === "string" && meta.pickedEffortModel.trim()
              ? meta.pickedEffortModel.trim()
              : typeof meta.model === "string" && meta.model.trim()
                ? meta.model.trim()
                : undefined;
          if (desc || pickedModel) {
            store.registerSubagentHint("claude", ctx.subagentId, {
              parentId: ctx.parentId,
              label: desc,
              model: pickedModel,
              isLive,
              timestamp: ts,
            });
          }
        }
      }
    } catch {}
  }

  if (type === "system" && obj.subtype === "compact_boundary") {
    const cm = obj.compactMetadata;
    if (cm && typeof cm === "object") {
      let inferredFromCompact: number | undefined;
      const pre = Number(cm.preTokens);
      if (cm.trigger === "auto" && pre > 0) {
        if (pre > 400_000) {
          inferredFromCompact = 1_000_000;
        } else if (pre > 210_000) {
          const currentMax = node.explicitContextMaxTokens ?? node.tokenUsage?.contextMaxTokens ?? 0;
          inferredFromCompact = Math.max(currentMax, 400_000);
        }
      }
      const post = Number(cm.postTokens);
      if (post > 0) {
        store.recordTokenUsage(ctx.nodeId, {
          contextTokens: post,
          contextMaxTokens: inferredFromCompact,
        });
      }
    }
    return;
  }

  if (type === "pr-link" && (obj.url || obj.prUrl)) {
    store.recordPullRequestLink(ctx.nodeId, {
      url: String(obj.url || obj.prUrl),
      prNumber: typeof obj.prNumber === "number" ? obj.prNumber : undefined,
      repository: typeof obj.prRepository === "string" ? obj.prRepository : undefined,
      timestamp: ts,
    });
    return;
  }

  if (type === "ai-title" && typeof obj.aiTitle === "string" && !ctx.subagentId) {
    store.upsertNode({
      id: ctx.nodeId,
      rawId,
      harness: "claude",
      label: obj.aiTitle.trim(),
      isCustomLabel: true,
      timestamp: ts,
    });
    return;
  }

const BUILTIN_SLASH_COMMANDS = new Set([
  "clear",
  "compact",
  "model",
  "help",
  "login",
  "logout",
  "status",
  "cost",
  "doctor",
  "config",
  "init",
  "resume",
  "mcp",
  "memory",
  "permissions",
  "vim",
  "exit",
  "quit",
  "bug",
  "pr-comments",
  " terminal-setup",
]);

  if (type === "user") {
    const content = obj.message?.content;
    const isMetaInjection = Boolean(obj.isMeta);
    if (typeof content === "string") {
      store.recordTurnPhase(ctx.nodeId, "thinking", ts);
      if (!isMetaInjection) {
        store.recordUserPrompt(ctx.nodeId, content, ts);
      }
      const cmdMatch = content.match(/<command-name>\/?([a-zA-Z0-9_:-]+)<\/command-name>/i);
      if (cmdMatch && cmdMatch[1] && !BUILTIN_SLASH_COMMANDS.has(cmdMatch[1].toLowerCase())) {
        store.recordSkill(ctx.nodeId, cmdMatch[1], ts, isLive);
      }
      // If subagent has no custom label yet, derive a clean role label from its initial prompt
      if (ctx.subagentId && content.trim().length > 0 && !content.includes("<command-name>")) {
        const unwrappedPrompt = extractFullUserPrompt(content);
        if (unwrappedPrompt) {
          const rawFirst = decodeXmlEntities(
            unwrappedPrompt
              .trim()
              .split("\n")[0]
              .replace(/^[#>*\-\s]+/, "")
              .trim()
          );
          const firstLine =
            rawFirst.length > 120 ? rawFirst.slice(0, 117).trim() + "…" : rawFirst;
          if (firstLine) {
            store.upsertNode({
              id: ctx.nodeId,
              rawId,
              harness: "claude",
              parentId: ctx.parentId,
              isSubagent: true,
              label: firstLine,
              timestamp: ts,
            });
          }
        }
      }
    } else if (Array.isArray(content)) {
      let sawToolResult = false;
      const userPromptParts: string[] = [];
      const tr = obj.toolUseResult;
      for (const item of content) {
        if (item && item.type === "tool_result") {
          sawToolResult = true;
          const durationMs =
            typeof item.duration_ms === "number"
              ? item.duration_ms
              : typeof tr?.durationMs === "number"
                ? tr.durationMs
                : undefined;

          let output: string | undefined;
          if (typeof item.content === "string") {
            output = item.content;
          } else if (Array.isArray(item.content)) {
            const parts = item.content
              .filter((p: any) => p && typeof p.text === "string")
              .map((p: any) => p.text);
            if (parts.length > 0) output = parts.join("\n");
          }
          if (!output && tr) {
            if (tr.stdout || tr.stderr) {
              output = [tr.stdout, tr.stderr].filter(Boolean).join("\n");
            } else if (typeof tr.output === "string") {
              output = tr.output;
            }
          }

          store.recordToolEnd(ctx.nodeId, {
            callId: item.tool_use_id,
            isError: Boolean(item.is_error),
            durationMs,
            output,
            timestamp: ts,
            isLive,
          });
        } else if (item && item.type === "text" && typeof item.text === "string") {
          const trimmedItem = item.text.trim();
          if (trimmedItem && !/^<system-reminder\b[\s\S]*<\/system-reminder>$/i.test(trimmedItem)) {
            userPromptParts.push(item.text);
          }
        }
      }
      if (!sawToolResult) {
        store.recordTurnPhase(ctx.nodeId, "thinking", ts);
        if (!isMetaInjection && userPromptParts.length > 0) {
          store.recordUserPrompt(ctx.nodeId, userPromptParts.join("\n\n"), ts);
        }
      }
    }

    // Check rich subagent metadata on toolUseResult
    const tr = obj.toolUseResult;
    if (tr && typeof tr === "object" && tr.agentId) {
      const subAgentId = String(tr.agentId);
      const isAsync = Boolean(tr.isAsync);
      const status = String(tr.status || "");
      const completed = !isAsync || status === "completed" || status === "done";
      store.registerSubagentHint("claude", subAgentId, {
        parentId: ctx.nodeId,
        label: typeof tr.description === "string" ? tr.description : undefined,
        model: typeof tr.resolvedModel === "string" ? tr.resolvedModel : undefined,
        completed,
        isLive,
        timestamp: ts,
        durationMs: typeof tr.totalDurationMs === "number" ? tr.totalDurationMs : undefined,
        subagentToolCount: typeof tr.totalToolUseCount === "number" ? tr.totalToolUseCount : undefined,
      });
    }
    return;
  }

  if (type === "assistant") {
    const msgId = typeof obj.message?.id === "string" ? obj.message.id : undefined;
    store.recordModelTurn(ctx.nodeId, msgId);

    const usage = obj.message?.usage;
    if (usage && typeof usage === "object") {
      const inTok =
        (Number(usage.input_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0) +
        (Number(usage.cache_read_input_tokens) || 0);
      const outTok = Number(usage.output_tokens) || 0;
      const turnTotal = inTok + outTok;
      if (turnTotal > 0) {
        store.recordTokenUsage(ctx.nodeId, {
          turnKey: msgId,
          contextTokens: turnTotal,
          turnTotalTokens: turnTotal,
          turnOutputTokens: outTok,
        });
      }
    }

    const content = obj.message?.content;
    if (!Array.isArray(content)) return;

    let sawToolUse = false;
    let sawAskUser = false;
    let sawText = false;
    let sawThinking = false;
    let assistantText = "";

    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!block) continue;

      if (block.type === "thinking") {
        sawThinking = true;
      } else if (block.type === "text") {
        sawText = true;
        if (typeof block.text === "string") {
          assistantText += (assistantText ? "\n" : "") + block.text;
        }
      } else if (block.type === "tool_use") {
        const toolName = String(block.name || "tool");
        const input = block.input || {};
        const callId = String(block.id || `${ts}-${i}-${toolName}`);

        if (toolName === "SubagentHandback") {
          store.markCompleted(ctx.nodeId, ts, isLive);
          continue;
        }

        sawToolUse = true;
        if (toolName === "AskUserQuestion") {
          sawAskUser = true;
        }

        let waitingPrompt: string | undefined;
        if (toolName === "AskUserQuestion") {
          waitingPrompt = input.questions?.[0]?.question || input.question;
        } else if (toolName === "ExitPlanMode") {
          waitingPrompt = "Plan ready for approval";
        } else if (
          toolName.includes("board_ask_question") ||
          toolName.includes("board_wait_for_answers") ||
          toolName.includes("board_ask_one_liner") ||
          toolName.includes("board_ask_asset_review")
        ) {
          waitingPrompt = input.question || input.title || "Waiting on release board";
        }

        // Skill detection
        if (toolName === "Skill" && typeof input.skill === "string") {
          store.recordSkill(ctx.nodeId, input.skill, ts, isLive);
        }
        const fileTarget = input.file_path || input.path;
        const pathSkill = extractSkillFromPath(fileTarget);
        if (pathSkill) {
          store.recordSkill(ctx.nodeId, pathSkill, ts, isLive);
        }

        let linesAdded: number | undefined;
        let linesRemoved: number | undefined;
        let summary: string | undefined;
        let rawCommand: string | undefined;
        let fullText: string | undefined;
        let diffPreview: string | undefined;
        let modelBadge: string | undefined;

        if (toolName === "Bash") {
          summary = typeof input.description === "string" ? input.description.trim() : undefined;
          rawCommand = typeof input.command === "string" ? input.command.trim() : undefined;
        } else if (toolName === "Edit") {
          const delta = computeEditLineDelta(input.old_string, input.new_string);
          if (delta) {
            linesAdded = delta.linesAdded;
            linesRemoved = delta.linesRemoved;
          }
          diffPreview = buildCompactDiffPreview(input.old_string, input.new_string);
        } else if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
          let added = 0;
          let removed = 0;
          let hasDelta = false;
          const diffPieces: string[] = [];
          for (const ed of input.edits) {
            if (ed) {
              const delta = computeEditLineDelta(ed.old_string, ed.new_string);
              if (delta) {
                hasDelta = true;
                added += delta.linesAdded;
                removed += delta.linesRemoved;
              }
              const p = buildCompactDiffPreview(ed.old_string, ed.new_string, 40);
              if (p) diffPieces.push(p);
            }
          }
          if (hasDelta) {
            linesAdded = added;
            linesRemoved = removed;
          }
          if (diffPieces.length > 0) {
            diffPreview = diffPieces.join("\n---\n");
          }
        } else if (toolName === "Write") {
          const delta = computeEditLineDelta("", input.content);
          if (delta) {
            linesAdded = delta.linesAdded;
            linesRemoved = delta.linesRemoved;
          }
          diffPreview = buildCompactDiffPreview("", input.content, 60);
        } else if (toolName === "Agent" || toolName === "Task") {
          summary = typeof input.description === "string" ? input.description.trim() : undefined;
          modelBadge = typeof input.model === "string" ? input.model.trim() : undefined;
          if (typeof input.prompt === "string") {
            fullText = input.prompt;
          }
        } else if (toolName === "AskUserQuestion") {
          const qs = input.questions || (input.question ? [input] : []);
          if (Array.isArray(qs) && qs.length > 0) {
            fullText = qs
              .map((q: any) => {
                const header = q.question || "";
                const opts = Array.isArray(q.options)
                  ? q.options.map((o: any) => `  • ${typeof o === "string" ? o : o.label || o.text || JSON.stringify(o)}`).join("\n")
                  : "";
                return opts ? `${header}\n${opts}` : header;
              })
              .join("\n\n");
          }
        } else if (toolName.startsWith("mcp__") || toolName.includes("board_")) {
          try {
            fullText = JSON.stringify(input, null, 2);
          } catch {}
        }

        const target = toolName === "Bash" ? (input.description || input.command) : extractClaudeToolTarget(toolName, input);
        const explicitFilePath =
          typeof input.file_path === "string"
            ? input.file_path
            : typeof input.notebook_path === "string"
              ? input.notebook_path
              : (toolName === "Read" ||
                    toolName === "Edit" ||
                    toolName === "MultiEdit" ||
                    toolName === "Write") &&
                  typeof input.path === "string"
                ? input.path
                : typeof input.url === "string" && /^https?:\/\//i.test(input.url)
                  ? input.url
                  : undefined;
        const toolInput = serializeToolCallInput(toolName, input, {
          hasDiff: Boolean(diffPreview),
          omitCommandKeys: toolName === "Bash",
        });
        store.recordToolStart(ctx.nodeId, {
          callId,
          name: toolName,
          target,
          filePath: explicitFilePath,
          summary,
          rawCommand,
          toolInput,
          fullText,
          diffPreview,
          linesAdded,
          linesRemoved,
          modelBadge,
          waitingPrompt,
          timestamp: ts,
          isLive,
        });
      }
    }

    if (!sawToolUse && assistantText.trim()) {
      store.recordAssistantMilestone(ctx.nodeId, assistantText, ts);
    }

    if (sawAskUser) {
      store.recordTurnPhase(ctx.nodeId, "waiting_on_user", ts);
    } else if (!sawToolUse && sawText) {
      store.recordTurnPhase(ctx.nodeId, "waiting_on_user", ts);
    } else if (!sawToolUse && sawThinking) {
      store.recordTurnPhase(ctx.nodeId, "thinking", ts);
    }
  }
}

function extractClaudeToolTarget(toolName: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (toolName === "Skill") return input.skill;
  if (toolName === "Agent" || toolName === "Task") {
    return input.description || input.subagent_type;
  }
  if (toolName === "Bash") {
    return input.description || input.command;
  }
  const lower = toolName.toLowerCase();
  if (lower === "grep" || lower === "glob" || lower === "toolsearch") {
    const searchSummary = formatSearchTargetSummary(toolName, input);
    if (searchSummary) return searchSummary;
  }
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.query) return String(input.query);
  if (input.url) return String(input.url);
  if (input.path) return String(input.path);
  return undefined;
}
