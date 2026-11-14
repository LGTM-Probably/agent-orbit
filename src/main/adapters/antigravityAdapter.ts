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

export interface AntigravityFileContext {
  filePath: string;
  convId: string;
  nodeId: string;
  pendingSubagentRoles: string[];
}

export function parseAntigravityFilePath(filePath: string): AntigravityFileContext | null {
  const norm = filePath.replace(/\\/g, "/");
  const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/i);
  if (!m) return null;
  const convId = m[1];
  return {
    filePath,
    convId,
    nodeId: `antigravity:${convId}`,
    pendingSubagentRoles: [],
  };
}

export function cleanMultiLineString(val: any): string | undefined {
  if (val === undefined || val === null) return undefined;
  const str = typeof val === "string" ? val : String(val);
  return str.replace(/\r\n/g, "\n");
}

function cleanArgString(val: any): string | undefined {
  if (val === undefined || val === null) return undefined;
  let str = String(val).trim();
  if (
    (str.startsWith('"') && str.endsWith('"') && str.length >= 2) ||
    (str.startsWith("'") && str.endsWith("'") && str.length >= 2)
  ) {
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === "string") {
        str = parsed.trim();
      }
    } catch {
      str = str.slice(1, -1).trim();
    }
  }
  str = str.replace(/^["']+|["']+$/g, "").trim();
  return str || undefined;
}

export function ingestAntigravityLine(
  ctx: AntigravityFileContext,
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

  const stepModel = cleanArgString(obj.model || obj.model_name || obj.metadata?.model);
  const ts = (obj.created_at ? Date.parse(obj.created_at) : NaN) || fallbackTs;
  const node = store.upsertNode({
    id: ctx.nodeId,
    rawId: ctx.convId,
    harness: "antigravity",
    model: stepModel,
    timestamp: ts,
    emitSpawnPulse: isLive,
  });

  if (obj.type === "CHECKPOINT") {
    const inTok = (Number(obj.input_tokens) || 0) + (Number(obj.cache_read_tokens) || 0);
    const outTok = Number(obj.output_tokens) || 0;
    if (inTok + outTok > 0) {
      store.recordTokenUsage(ctx.nodeId, {
        turnKey: obj.step_index !== undefined ? `step:${obj.step_index}` : undefined,
        turnTotalTokens: inTok + outTok,
        turnOutputTokens: outTok,
        contextTokens: outTok > 0 ? outTok : undefined,
      });
    }
    return;
  }

  if (obj.type === "USER_INPUT") {
    store.recordTurnPhase(ctx.nodeId, "thinking", ts);
    if (typeof obj.content === "string") {
      if (obj.source !== "SYSTEM" || obj.content.includes("<USER_REQUEST>")) {
        store.recordUserPrompt(ctx.nodeId, obj.content, ts);
      }
      if (!node.hasCustomLabel) {
        const title = extractCleanTitleFromUserInput(obj.content);
        if (title) {
          store.upsertNode({
            id: ctx.nodeId,
            rawId: ctx.convId,
            harness: "antigravity",
            label: title,
            isCustomLabel: true,
            timestamp: ts,
          });
        }
      }
    }
    return;
  }

  if (obj.type === "PLANNER_RESPONSE") {
    const stepKey = obj.step_index !== undefined ? `step:${obj.step_index}` : undefined;
    store.recordModelTurn(ctx.nodeId, stepKey);

    const inTok = (Number(obj.input_tokens) || 0) + (Number(obj.cache_read_tokens) || 0);
    const outTok = Number(obj.output_tokens) || 0;
    const turnTotal = inTok + outTok;
    if (turnTotal > 0) {
      store.recordTokenUsage(ctx.nodeId, {
        turnKey: stepKey,
        contextTokens: turnTotal,
        turnTotalTokens: turnTotal,
        turnOutputTokens: outTok,
      });
    }

    const toolCalls = obj.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        if (!tc) continue;
        const name = String(tc.name || "tool");
        const args = tc.args || {};

        const explicitFilePath = cleanArgString(args.Path || args.TargetFile);
        const fileCandidate =
          explicitFilePath || cleanArgString(args.SearchPath || args.Directory);
        if (typeof fileCandidate === "string") {
          const skill = extractSkillFromPath(fileCandidate);
          if (skill) {
            store.recordSkill(ctx.nodeId, skill, ts, isLive);
          }
          const inferredProject = inferAntigravityProject(fileCandidate);
          if (inferredProject) {
            store.upsertNode({
              id: ctx.nodeId,
              rawId: ctx.convId,
              harness: "antigravity",
              project: inferredProject,
              timestamp: ts,
            });
          }
        }

        if (name === "invoke_subagent") {
          const role = cleanArgString(args.Role) || cleanArgString(args.TypeName) || "subagent";
          ctx.pendingSubagentRoles.push(role);
        }

        let summary: string | undefined;
        let rawCommand: string | undefined;
        let fullText: string | undefined;
        let diffPreview: string | undefined;
        let linesAdded: number | undefined;
        let linesRemoved: number | undefined;
        let isArtifact: boolean | undefined;
        let requestFeedback: boolean | undefined;
        let waitingPrompt: string | undefined;
        let mcpToolName: string | undefined;
        let modelBadge: string | undefined;

        if (name === "ask_question") {
          waitingPrompt = args.questions?.[0]?.question || args.question;
          if (Array.isArray(args.questions) && args.questions.length > 0) {
            fullText = args.questions
              .map((q: any) => {
                const header = q.question || "";
                const opts = Array.isArray(q.options)
                  ? q.options.map((o: any) => `  • ${typeof o === "string" ? o : o.label || o.text || JSON.stringify(o)}`).join("\n")
                  : "";
                return opts ? `${header}\n${opts}` : header;
              })
              .join("\n\n");
          }
        } else if (name === "run_command") {
          summary = cleanArgString(args.toolSummary);
          rawCommand = cleanMultiLineString(args.CommandLine);
        } else if (name === "edit_file") {
          const targetRaw = cleanMultiLineString(args.Target);
          const replacementRaw = cleanMultiLineString(args.Replacement);
          const delta = computeEditLineDelta(targetRaw, replacementRaw);
          if (delta) {
            linesAdded = delta.linesAdded;
            linesRemoved = delta.linesRemoved;
          }
          diffPreview = buildCompactDiffPreview(targetRaw, replacementRaw);
          if (args.ArtifactMetadata) {
            isArtifact = true;
            summary = cleanArgString(args.ArtifactMetadata.Summary);
            if (args.ArtifactMetadata.RequestFeedback === true) {
              requestFeedback = true;
              waitingPrompt = summary || "Review plan artifact";
            }
          }
        } else if (name === "write_file") {
          const contentRaw = cleanMultiLineString(args.Content);
          const delta = computeEditLineDelta("", contentRaw);
          if (delta) {
            linesAdded = delta.linesAdded;
            linesRemoved = delta.linesRemoved;
          }
          diffPreview = buildCompactDiffPreview("", contentRaw, 60);
          if (args.ArtifactMetadata) {
            isArtifact = true;
            summary = cleanArgString(args.ArtifactMetadata.Summary);
            if (args.ArtifactMetadata.RequestFeedback === true) {
              requestFeedback = true;
              waitingPrompt = summary || "Review plan artifact";
            }
          }
        } else if (name === "invoke_subagent") {
          summary = cleanArgString(args.Role);
          modelBadge = cleanArgString(args.Model);
          if (args.Prompt) {
            fullText = cleanMultiLineString(args.Prompt);
          }
        } else if (name === "call_mcp_tool") {
          mcpToolName = cleanArgString(args.ToolName);
          if (args.Arguments) {
            fullText =
              typeof args.Arguments === "string"
                ? args.Arguments
                : JSON.stringify(args.Arguments, null, 2);
          }
          if (
            mcpToolName &&
            (mcpToolName.includes("board_ask") || mcpToolName.includes("board_wait_for_answers"))
          ) {
            const mArgs =
              typeof args.Arguments === "string"
                ? (() => {
                    try {
                      return JSON.parse(args.Arguments);
                    } catch {
                      return {};
                    }
                  })()
                : args.Arguments || {};
            waitingPrompt =
              mArgs.question || mArgs.title || args.question || args.title || "Waiting on release board";
          }
        }

        const nLower = name.toLowerCase();
        const searchSummary =
          nLower === "grep_search" || nLower === "find_by_name" || nLower === "search_marketplace"
            ? formatSearchTargetSummary(name, args)
            : undefined;
        const rawTarget =
          searchSummary ||
          args.toolSummary ||
          args.Role ||
          args.Path ||
          args.TargetFile ||
          args.Query ||
          args.Pattern ||
          args.SearchPath ||
          args.query ||
          args.CommandLine ||
          undefined;
        const target = cleanArgString(rawTarget);
        const toolInput = serializeToolCallInput(name, args, {
          hasDiff: Boolean(diffPreview),
          omitCommandKeys: name === "run_command",
        });

        store.recordToolStart(ctx.nodeId, {
          callId: `${obj.step_index ?? ts}-${i}-${name}`,
          name,
          target: typeof target === "string" ? target : undefined,
          filePath: explicitFilePath,
          summary,
          rawCommand,
          toolInput,
          fullText,
          diffPreview,
          linesAdded,
          linesRemoved,
          isArtifact,
          requestFeedback,
          waitingPrompt,
          mcpToolName,
          modelBadge,
          timestamp: ts,
          isLive,
        });
      }
    } else {
      store.recordTurnPhase(ctx.nodeId, "waiting_on_user", ts);
      if (typeof obj.content === "string" && obj.content.trim()) {
        store.recordAssistantMilestone(ctx.nodeId, obj.content, ts);
      }
    }
    return;
  }

  if (obj.type === "GENERIC") {
    const contentStr =
      typeof obj.content === "string"
        ? obj.content
        : obj.content
          ? JSON.stringify(obj.content)
          : "";

    let exitCode: number | undefined;
    const exitMatch = contentStr.match(/Command exited with code (-?\d+)/i);
    if (exitMatch && exitMatch[1]) {
      exitCode = parseInt(exitMatch[1], 10);
    }

    let durationMs: number | undefined;
    const createdMatch = contentStr.match(/Created At:\s*([^\r\n]+)/i);
    const completedMatch = contentStr.match(/Completed At:\s*([^\r\n]+)/i);
    if (createdMatch && completedMatch) {
      const cMs = Date.parse(createdMatch[1].trim());
      const fMs = Date.parse(completedMatch[1].trim());
      if (!isNaN(cMs) && !isNaN(fMs) && fMs >= cMs) {
        durationMs = fMs - cMs;
      }
    }

    let outputText = contentStr;
    const cmdOutputIdx = contentStr.indexOf("Command output:\n");
    if (cmdOutputIdx >= 0) {
      outputText = contentStr.slice(cmdOutputIdx + "Command output:\n".length);
    } else {
      const cmdOutputIdx2 = contentStr.indexOf("Command output:\r\n");
      if (cmdOutputIdx2 >= 0) {
        outputText = contentStr.slice(cmdOutputIdx2 + "Command output:\r\n".length);
      } else {
        outputText = outputText
          .replace(/^Created At:\s*[^\r\n]*\r?\n?/i, "")
          .replace(/^Completed At:\s*[^\r\n]*\r?\n?/i, "")
          .replace(/^Command exited with code\s*-?\d+\.?\r?\n?/i, "");
      }
    }

    const isError = obj.status === "ERROR" || (exitCode !== undefined && exitCode !== 0);

    store.recordToolEnd(ctx.nodeId, {
      allInFlight: true,
      output: outputText.trim() || undefined,
      isError,
      durationMs,
      exitCode,
      timestamp: ts,
      isLive,
    });

    // Link spawned subagents when invoke_subagent returns a conversationId
    if (contentStr.includes("conversationId")) {
      const uuidMatch = contentStr.match(
        /conversationId["'\s:=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
      );
      if (uuidMatch && uuidMatch[1]) {
        const childConvId = uuidMatch[1];
        const role = ctx.pendingSubagentRoles.shift();
        store.registerSubagentHint("antigravity", childConvId, {
          parentId: ctx.nodeId,
          label: role,
          isLive,
          timestamp: ts,
        });
      }
    }
  }
}

function extractCleanTitleFromUserInput(raw: string): string | null {
  const body = extractFullUserPrompt(raw);
  if (!body) return null;
  const firstSentence = decodeXmlEntities(body)
    .split(/[\n.!?]/)[0]
    .trim()
    .replace(/^[#>*\-\s]+/, "");
  if (!firstSentence) return null;
  return firstSentence.length > 120 ? firstSentence.slice(0, 117).trim() + "…" : firstSentence;
}

function inferAntigravityProject(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, "/");
  // Ignore internal brain logs and global skills
  if (norm.includes("/.gemini/antigravity/brain/")) return null;
  if (norm.includes("/skills/")) return null;
  const scratchMatch = norm.match(/\/scratch\/([^/]+)/i);
  if (scratchMatch && scratchMatch[1]) return scratchMatch[1];
  const parts = norm.split("/").filter(Boolean);
  if (parts.length >= 3) {
    // e.g., C:/nebula-api/src/... -> nebula-api
    if (/^[a-zA-Z]:$/.test(parts[0])) {
      if (parts[1].toLowerCase() !== "users") {
        return parts[1];
      }
      // C:/Users/<user>/Desktop/code/<repo>/...
      const codeIdx = parts.findIndex(p => p.toLowerCase() === "code" || p.toLowerCase() === "worktree");
      if (codeIdx >= 0 && parts[codeIdx + 1]) {
        return parts[codeIdx + 1];
      }
    }
  }
  return projectFromCwd(path.dirname(norm));
}
