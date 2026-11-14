import { EventEmitter } from "events";
import os from "os";
import path from "path";
import {
  ActivityLogDetailPayload,
  ActivityLogEntry,
  ActivityLogKind,
  AgentNodeSnapshot,
  AgentStatus,
  categorizeToolName,
  classifyBlockingUserTool,
  classifySemanticBadge,
  GraphSnapshotPayload,
  HarnessKind,
  inferContextWindowMax,
  LivePulseEvent,
  projectFromCwd,
  SemanticTaskBadge,
  SkillUse,
  TimeWindowMode,
  TokenUsageSnapshot,
  ToolCategory,
  ToolEventSummary,
  WaitingReasonKind,
} from "../shared/types";

export function resolveOpenableFilePath(rawPath: string, cwd?: string): string | null {
  if (typeof rawPath !== "string") return null;
  let cleaned = rawPath.trim();
  if (!cleaned) return null;

  // Strip surrounding matching quotes or backticks
  cleaned = cleaned.replace(/^(["'`])([\s\S]*)\1$/, "$2").trim();
  if (!cleaned || /[\r\n\0]/.test(cleaned)) return null;

  // Strip file:/// or file:// URI prefix
  if (/^file:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^file:\/\/(?:localhost)?/i, "");
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {}
    // Strip leading slash before Windows drive letter (e.g. /C:/Users/...)
    if (/^\/[a-zA-Z]:[\\/]/.test(cleaned)) {
      cleaned = cleaned.slice(1);
    }
  }

  // Strip trailing line-range suffixes:
  // 1) #L10-L20, #L10, #L10C5-L20C8, #10
  cleaned = cleaned.replace(/#L?\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, "").trim();
  // 2) " (lines 1-50)" or " [line 10]"
  cleaned = cleaned
    .replace(/\s*[\(\[]lines?\s+\d+(?:\s*[-–]\s*\d+)?[\)\]]$/i, "")
    .trim();
  // 3) ":123" or ":123:45" or ":123-145" without stripping Windows drive letters like "C:"
  const lineColMatch = cleaned.match(/^(..+?):\d+(?::\d+|-\d+)?$/);
  if (lineColMatch && lineColMatch[1]) {
    cleaned = lineColMatch[1].trim();
  }

  if (!cleaned) return null;

  // Expand leading ~/ or ~\ (or bare ~)
  if (cleaned === "~") {
    cleaned = os.homedir();
  } else if (cleaned.startsWith("~/") || cleaned.startsWith("~\\")) {
    cleaned = path.join(os.homedir(), cleaned.slice(2));
  }

  // On Windows, convert Git Bash /c/Users/... to c:/Users/...
  if (process.platform === "win32") {
    const gitBashMatch = cleaned.match(/^\/([a-zA-Z])\/(.*)$/);
    if (gitBashMatch) {
      cleaned = `${gitBashMatch[1]}:/${gitBashMatch[2]}`;
    } else if (/^\/([a-zA-Z])$/.test(cleaned)) {
      cleaned = `${cleaned[1]}:/`;
    }
  }

  if (!path.isAbsolute(cleaned)) {
    if (typeof cwd === "string" && cwd.trim()) {
      let cleanCwd = cwd.trim();
      if (/^(?:\\\\|\/\/)/.test(cleanCwd)) return null;
      if (process.platform === "win32") {
        const cwdGitBash = cleanCwd.match(/^\/([a-zA-Z])\/(.*)$/);
        if (cwdGitBash) {
          cleanCwd = `${cwdGitBash[1]}:/${cwdGitBash[2]}`;
        }
      }
      const joined = path.normalize(path.resolve(cleanCwd, cleaned));
      if (/^(?:\\\\|\/\/)/.test(joined)) return null;
      return joined;
    }
    return null;
  }

  // Reject Windows UNC / network share paths (\\server\share) to prevent involuntary SMB connections
  if (/^(?:\\\\|\/\/)/.test(cleaned)) return null;

  return path.normalize(cleaned);
}

const REVEAL_ONLY_EXTENSIONS = new Set([
  ".exe",
  ".com",
  ".scr",
  ".pif",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".psd1",
  ".vbs",
  ".vbe",
  ".jse",
  ".wsf",
  ".wsh",
  ".hta",
  ".msi",
  ".msp",
  ".msc",
  ".cpl",
  ".reg",
  ".lnk",
  ".url",
  ".scf",
  ".inf",
  ".jar",
  ".application",
  ".appref-ms",
  ".gadget",
  ".app",
  ".command",
  ".desktop",
]);

/**
 * Returns true if opening the file with OS ShellExecute (`shell.openPath`) could
 * execute code, installers, shortcuts, or script hosts rather than opening a document/source file.
 * Such files should be revealed safely in Explorer/Finder (`shell.showItemInFolder`) instead.
 */
export function shouldRevealInsteadOfExecute(resolvedPath: string): boolean {
  if (typeof resolvedPath !== "string" || !resolvedPath.trim()) return true;
  // Windows strips trailing dots and spaces when resolving file extensions
  const normalizedBase = path.basename(resolvedPath.trim()).replace(/[. ]+$/, "");
  // Any NTFS alternate data stream (e.g. readme.txt:hidden.exe) is suspicious — reveal only
  if (normalizedBase.includes(":")) return true;
  const ext = path.extname(normalizedBase).toLowerCase();
  return REVEAL_ONLY_EXTENSIONS.has(ext);
}

/**
 * Validates an external URL before passing it to `shell.openExternal`, allowing only
 * clean `http:` / `https:` URLs without embedded credentials.
 */
export function sanitizeExternalHttpUrl(rawUrl: string): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export interface MutableAgentNode {
  id: string;
  rawId: string;
  harness: HarnessKind;
  parentId?: string;
  isSubagent: boolean;
  label: string;
  hasCustomLabel: boolean;
  project: string;
  cwd?: string;
  branch?: string;
  model?: string;
  createdAt: number;
  lastActiveAt: number;
  lastTurnPhase: "thinking" | "waiting_on_user" | "idle";
  explicitCompleted: boolean;
  turnCount: number;
  totalToolCalls: number;
  toolCounts: Record<ToolCategory, number>;
  inFlightTools: Map<string, ToolEventSummary>;
  recentTools: ToolEventSummary[];
  skills: Map<string, SkillUse>;
  tokenUsage?: TokenUsageSnapshot;
  explicitContextMaxTokens?: number;
  isSimulated?: boolean;
  entrypoint?: string;
  pendingPlanReview?: { summary?: string; timestamp: number };
  lastWaitingReason?: WaitingReasonKind;
  lastWaitingPrompt?: string;
  lastEmittedWaitingState?: boolean;
  lastAssistantSummary?: string;
}

const WINDOW_MS: Record<TimeWindowMode, number> = {
  live: 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

export class GraphStore extends EventEmitter {
  private nodes = new Map<string, MutableAgentNode>();
  private subagentHints = new Map<
    string,
    {
      parentId: string;
      label?: string;
      model?: string;
      completed?: boolean;
      durationMs?: number;
      subagentToolCount?: number;
    }
  >();
  private timeWindow: TimeWindowMode = "30m";
  private dirtyTimer: NodeJS.Timeout | null = null;
  private activityLog: ActivityLogEntry[] = [];
  private activityLogById = new Map<string, ActivityLogEntry>();
  private logSeq = 0;
  private logResetSeq = 0;
  private toolLogByCallId = new Map<string, ActivityLogEntry>();
  private lastPromptByNodeId = new Map<string, string>();
  private lastReplyByNodeId = new Map<string, string>();
  private lastPrUrlByNodeId = new Map<string, string>();
  private turnUsageByKey = new Map<string, { nodeId: string; total: number; out: number }>();
  private seenModelTurnKeys = new Set<string>();

  private refreshContextMaxOnModelUpdate(node: MutableAgentNode): void {
    if (!node.tokenUsage) return;
    const nextMax = inferContextWindowMax(
      node.harness,
      node.model,
      node.explicitContextMaxTokens,
      node.tokenUsage.contextTokens
    );
    if (nextMax !== node.tokenUsage.contextMaxTokens) {
      node.tokenUsage.contextMaxTokens = nextMax;
      node.tokenUsage.contextPercent = Math.min(
        100,
        Math.max(
          0,
          Math.round((node.tokenUsage.contextTokens / Math.max(1, nextMax)) * 100)
        )
      );
      this.scheduleSnapshot();
    }
  }

  private appendLog(entry: ActivityLogEntry): void {
    entry.rev = ++this.logSeq;
    this.activityLogById.set(entry.id, entry);

    if (
      this.activityLog.length === 0 ||
      entry.timestamp >= this.activityLog[this.activityLog.length - 1].timestamp
    ) {
      this.activityLog.push(entry);
    } else {
      let idx = this.activityLog.length - 1;
      while (idx >= 0 && this.activityLog[idx].timestamp > entry.timestamp) {
        idx--;
      }
      this.activityLog.splice(idx + 1, 0, entry);
    }

    // Per-root trimming if a single root exceeds 600 entries
    let rootCount = 0;
    for (let i = this.activityLog.length - 1; i >= 0; i--) {
      if (this.activityLog[i].rootId === entry.rootId) {
        rootCount++;
        if (rootCount > 600) {
          const removed = this.activityLog.splice(i, 1)[0];
          if (removed) {
            if (this.activityLogById.get(removed.id) === removed) {
              this.activityLogById.delete(removed.id);
            }
            if (removed.kind === "tool") {
              const callPart = removed.id.split(":tool:")[1];
              if (callPart) {
                this.toolLogByCallId.delete(`${removed.nodeId}:${callPart}`);
              }
            }
          }
        }
      }
    }

    // Global cap at 3,000 entries
    while (this.activityLog.length > 3000) {
      const removed = this.activityLog.shift();
      if (removed) {
        if (this.activityLogById.get(removed.id) === removed) {
          this.activityLogById.delete(removed.id);
        }
        if (removed.kind === "tool") {
          const callPart = removed.id.split(":tool:")[1];
          if (callPart) {
            this.toolLogByCallId.delete(`${removed.nodeId}:${callPart}`);
          }
        }
      }
    }
  }

  private syncNodeLogMetadata(node: MutableAgentNode): void {
    const nextRoot = node.parentId ?? node.id;
    for (const entry of this.activityLog) {
      if (entry.nodeId === node.id) {
        if (
          entry.agentLabel !== node.label ||
          entry.rootId !== nextRoot ||
          entry.isSubagent !== node.isSubagent
        ) {
          entry.agentLabel = node.label;
          entry.rootId = nextRoot;
          entry.isSubagent = node.isSubagent;
          entry.rev = ++this.logSeq;
        }
      }
    }
  }

  public getLogDetail(entryId: string): ActivityLogDetailPayload | null {
    const entry = this.activityLogById.get(entryId);
    if (!entry) return null;
    return {
      id: entry.id,
      rawCommand: entry.rawCommand,
      toolInput: entry.toolInput,
      fullText: entry.fullText,
      output: entry.output,
      diffPreview: entry.diffPreview,
    };
  }

  private hasSpawnLog(nodeId: string): boolean {
    return this.activityLog.some(e => e.nodeId === nodeId && e.kind === "subagent_spawn");
  }

  public setTimeWindow(mode: TimeWindowMode): void {
    this.timeWindow = mode;
    this.logResetSeq = ++this.logSeq;
    this.emitSnapshotNow();
  }

  public getTimeWindow(): TimeWindowMode {
    return this.timeWindow;
  }

  public upsertNode(params: {
    id: string;
    rawId: string;
    harness: HarnessKind;
    parentId?: string;
    isSubagent?: boolean;
    label?: string;
    isCustomLabel?: boolean;
    cwd?: string;
    project?: string;
    branch?: string;
    model?: string;
    entrypoint?: string;
    timestamp?: number;
    isSimulated?: boolean;
    emitSpawnPulse?: boolean;
  }): MutableAgentNode {
    const now = params.timestamp ?? Date.now();
    let node = this.nodes.get(params.id);
    const isNew = !node;

    // Check if parent already registered a hint for this rawId
    const hint = this.subagentHints.get(`${params.harness}:${params.rawId}`);

    if (!node) {
      const parentId = params.parentId ?? hint?.parentId;
      const isSubagent = Boolean(params.isSubagent || parentId);
      const cwd = params.cwd;
      const defaultProject = params.project ?? (cwd ? projectFromCwd(cwd) : params.harness);
      const rawInitialLabel =
        params.label ??
        hint?.label ??
        (isSubagent ? `sub-${params.rawId.slice(0, 6)}` : `${defaultProject}`);
      const initialLabel = decodeXmlEntities(rawInitialLabel);

      node = {
        id: params.id,
        rawId: params.rawId,
        harness: params.harness,
        parentId,
        isSubagent,
        label: initialLabel,
        hasCustomLabel: Boolean(params.isCustomLabel || hint?.label),
        project: defaultProject,
        cwd,
        branch: params.branch,
        model: params.model ?? hint?.model,
        entrypoint: params.entrypoint,
        createdAt: now,
        lastActiveAt: now,
        lastTurnPhase: "idle",
        explicitCompleted: Boolean(hint?.completed),
        turnCount: 0,
        totalToolCalls: Math.max(0, hint?.subagentToolCount ?? 0),
        toolCounts: { read: 0, edit: 0, bash: 0, web: 0, agent: 0, other: 0 },
        inFlightTools: new Map(),
        recentTools: [],
        skills: new Map(),
        isSimulated: params.isSimulated,
        pendingPlanReview: undefined,
        lastWaitingReason: undefined,
        lastWaitingPrompt: undefined,
        lastEmittedWaitingState: false,
        lastAssistantSummary: undefined,
      };
      this.nodes.set(params.id, node);

      // Inherit parent project if subagent doesn't have cwd yet
      if (node.parentId && (!node.cwd || node.project === params.harness)) {
        const parent = this.nodes.get(node.parentId);
        if (parent) {
          node.project = parent.project;
          node.cwd = node.cwd ?? parent.cwd;
          if (!node.entrypoint && parent.entrypoint) {
            node.entrypoint = parent.entrypoint;
          }
        }
      }

      if (node.isSubagent) {
        this.appendLog({
          id: `${node.id}:spawn:${now}`,
          nodeId: node.id,
          rootId: node.parentId ?? node.id,
          agentLabel: node.label,
          isSubagent: true,
          harness: node.harness,
          kind: "subagent_spawn",
          badge: "SPAWN",
          title: "Spawned subagent",
          detail: node.label,
          modelBadge: shortenModel(node.model),
          timestamp: now,
        });
      }

      if (params.emitSpawnPulse && node.isSubagent) {
        this.emitPulse({
          kind: "subagent_spawn",
          nodeId: node.id,
          harness: node.harness,
          label: node.label,
          timestamp: now,
        });
      }
    } else {
      const wasSubagent = node.isSubagent;
      const prevParentId = node.parentId;
      const prevLabel = node.label;
      if (params.parentId && !node.parentId) {
        node.parentId = params.parentId;
        node.isSubagent = true;
      }
      if (params.isSubagent) {
        node.isSubagent = true;
      }
      if (!wasSubagent && node.isSubagent && !this.hasSpawnLog(node.id)) {
        this.appendLog({
          id: `${node.id}:spawn:${now}`,
          nodeId: node.id,
          rootId: node.parentId ?? node.id,
          agentLabel: node.label,
          isSubagent: true,
          harness: node.harness,
          kind: "subagent_spawn",
          badge: "SPAWN",
          title: "Spawned subagent",
          detail: node.label,
          modelBadge: shortenModel(node.model),
          timestamp: now,
        });
      }
      if (params.cwd && !node.cwd) {
        node.cwd = params.cwd;
        node.project = params.project ?? projectFromCwd(params.cwd);
        if (!node.hasCustomLabel && !node.isSubagent) {
          node.label = node.project;
        }
      } else if (params.project && (node.project === node.harness || node.project === "workspace")) {
        node.project = params.project;
      }
      if (params.branch) node.branch = params.branch;
      if (params.model) {
        const prevModel = node.model;
        node.model = params.model;
        if (node.model !== prevModel) {
          this.refreshContextMaxOnModelUpdate(node);
        }
      }
      if (params.entrypoint) node.entrypoint = params.entrypoint;
      if (params.label && (params.isCustomLabel || !node.hasCustomLabel)) {
        node.label = decodeXmlEntities(params.label);
        if (params.isCustomLabel) node.hasCustomLabel = true;
      }
      if (now > node.lastActiveAt) node.lastActiveAt = now;
      if (now < node.createdAt) node.createdAt = now;
      if (
        node.label !== prevLabel ||
        node.parentId !== prevParentId ||
        node.isSubagent !== wasSubagent
      ) {
        this.syncNodeLogMetadata(node);
      }
    }

    // Propagate project to children if parent got its cwd resolved
    if (!node.isSubagent && node.project) {
      for (const child of this.nodes.values()) {
        if (child.parentId === node.id && (child.project === child.harness || child.project === "workspace")) {
          child.project = node.project;
        }
      }
    }

    if (isNew) this.scheduleSnapshot();
    return node;
  }

  public registerSubagentHint(
    harness: HarnessKind,
    rawSubagentId: string,
    info: {
      parentId: string;
      label?: string;
      model?: string;
      completed?: boolean;
      isLive?: boolean;
      timestamp?: number;
      durationMs?: number;
      subagentToolCount?: number;
    }
  ): void {
    const key = `${harness}:${rawSubagentId}`;
    const prev = this.subagentHints.get(key) ?? { parentId: info.parentId };
    const cleanHintLabel = info.label ? decodeXmlEntities(info.label) : undefined;
    const merged = {
      parentId: info.parentId || prev.parentId,
      label: cleanHintLabel ?? prev.label,
      model: info.model ?? prev.model,
      completed: info.completed ?? prev.completed,
      durationMs: info.durationMs ?? prev.durationMs,
      subagentToolCount: info.subagentToolCount ?? prev.subagentToolCount,
    };
    this.subagentHints.set(key, merged);

    // Also apply immediately if the subagent node already exists
    for (const node of this.nodes.values()) {
      if (node.harness === harness && node.rawId === rawSubagentId) {
        const wasSubagent = node.isSubagent;
        node.parentId = merged.parentId;
        node.isSubagent = true;
        if (merged.label) {
          node.label = merged.label;
          node.hasCustomLabel = true;
        }
        if (merged.model) {
          node.model = merged.model;
          this.refreshContextMaxOnModelUpdate(node);
        }
        if (merged.subagentToolCount && merged.subagentToolCount > node.totalToolCalls) {
          node.totalToolCalls = merged.subagentToolCount;
        }
        this.syncNodeLogMetadata(node);
        if (!wasSubagent || !this.hasSpawnLog(node.id)) {
          this.appendLog({
            id: `${node.id}:spawn:${info.timestamp ?? Date.now()}`,
            nodeId: node.id,
            rootId: node.parentId ?? node.id,
            agentLabel: node.label,
            isSubagent: true,
            harness: node.harness,
            kind: "subagent_spawn",
            badge: "SPAWN",
            title: "Spawned subagent",
            detail: node.label,
            modelBadge: shortenModel(merged.model || node.model),
            timestamp: info.timestamp ?? Date.now(),
          });
        }
        if (merged.completed && !node.explicitCompleted) {
          this.markCompleted(node.id, info.timestamp ?? Date.now(), Boolean(info.isLive), {
            durationMs: merged.durationMs,
            subagentToolCount: merged.subagentToolCount,
            model: merged.model || node.model,
          });
        }
        this.scheduleSnapshot();
      }
    }
  }

  public recordTurnPhase(
    nodeId: string,
    phase: "thinking" | "waiting_on_user" | "idle",
    timestamp: number
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.lastTurnPhase = phase;
    if (phase === "thinking") {
      node.explicitCompleted = false;
    }
    if (timestamp >= node.lastActiveAt) {
      node.lastActiveAt = timestamp;
    }
    this.scheduleSnapshot();
  }

  public recordModelTurn(nodeId: string, turnKey?: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    if (turnKey) {
      const fullKey = `${nodeId}:${turnKey}`;
      if (this.seenModelTurnKeys.has(fullKey)) {
        return;
      }
      this.seenModelTurnKeys.add(fullKey);
      while (this.seenModelTurnKeys.size > 8000) {
        const oldest = this.seenModelTurnKeys.values().next().value;
        if (oldest !== undefined) {
          this.seenModelTurnKeys.delete(oldest);
        } else {
          break;
        }
      }
    }
    node.turnCount += 1;
    this.scheduleSnapshot();
  }

  public recordTokenUsage(
    nodeId: string,
    params: {
      turnKey?: string;
      contextTokens?: number;
      turnTotalTokens?: number;
      turnOutputTokens?: number;
      cumulativeTotalTokens?: number;
      cumulativeOutputTokens?: number;
      contextMaxTokens?: number;
    }
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const prev = node.tokenUsage;
    let totalTokens = prev?.totalTokens ?? 0;
    let outputTokens = prev?.outputTokens ?? 0;

    if (params.cumulativeTotalTokens !== undefined && params.cumulativeTotalTokens > 0) {
      totalTokens = Math.max(totalTokens, Math.round(params.cumulativeTotalTokens));
      outputTokens = Math.max(outputTokens, Math.round(params.cumulativeOutputTokens ?? 0));
    } else if (params.turnTotalTokens !== undefined && params.turnTotalTokens > 0) {
      const roundedTotal = Math.round(params.turnTotalTokens);
      const roundedOut = Math.round(params.turnOutputTokens ?? 0);
      if (params.turnKey) {
        const fullKey = `${nodeId}:${params.turnKey}`;
        const prevTurn = this.turnUsageByKey.get(fullKey) ?? {
          nodeId,
          total: 0,
          out: 0,
        };
        const deltaTotal = Math.max(0, roundedTotal - prevTurn.total);
        const deltaOut = Math.max(0, roundedOut - prevTurn.out);
        this.turnUsageByKey.set(fullKey, {
          nodeId,
          total: Math.max(prevTurn.total, roundedTotal),
          out: Math.max(prevTurn.out, roundedOut),
        });
        while (this.turnUsageByKey.size > 4000) {
          const oldestKey = this.turnUsageByKey.keys().next().value;
          if (oldestKey !== undefined) {
            this.turnUsageByKey.delete(oldestKey);
          } else {
            break;
          }
        }
        totalTokens += deltaTotal;
        outputTokens += deltaOut;
      } else {
        totalTokens += roundedTotal;
        outputTokens += roundedOut;
      }
    }

    const contextTokens =
      params.contextTokens !== undefined && params.contextTokens > 0
        ? Math.round(params.contextTokens)
        : prev?.contextTokens ?? 0;

    if (
      params.contextMaxTokens !== undefined &&
      Number.isFinite(params.contextMaxTokens) &&
      params.contextMaxTokens >= 8_000
    ) {
      node.explicitContextMaxTokens = Math.round(params.contextMaxTokens);
    }

    const contextMaxTokens = inferContextWindowMax(
      node.harness,
      node.model,
      params.contextMaxTokens ?? node.explicitContextMaxTokens,
      contextTokens
    );

    const contextPercent = Math.min(
      100,
      Math.max(0, Math.round((contextTokens / Math.max(1, contextMaxTokens)) * 100))
    );

    node.tokenUsage = {
      contextTokens,
      contextMaxTokens,
      contextPercent,
      totalTokens,
      outputTokens: outputTokens > 0 ? outputTokens : undefined,
    };
    this.scheduleSnapshot();
  }

  public recordToolStart(
    nodeId: string,
    tool: {
      callId: string;
      name: string;
      target?: string;
      filePath?: string;
      summary?: string;
      rawCommand?: string;
      toolInput?: string;
      fullText?: string;
      diffPreview?: string;
      linesAdded?: number;
      linesRemoved?: number;
      isArtifact?: boolean;
      requestFeedback?: boolean;
      waitingPrompt?: string;
      mcpToolName?: string;
      modelBadge?: string;
      badge?: SemanticTaskBadge;
      durationMs?: number;
      timestamp: number;
      isLive: boolean;
    }
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const blockingWaitKind = classifyBlockingUserTool(tool.mcpToolName || tool.name, {
      isArtifact: tool.isArtifact,
      requestFeedback: tool.requestFeedback,
    });

    const category = categorizeToolName(tool.name);
    const entry: ToolEventSummary = {
      id: tool.callId,
      name: tool.name,
      category,
      target: tool.target ? truncateTarget(tool.target) : undefined,
      startedAt: tool.timestamp,
      blockingWaitKind: blockingWaitKind || undefined,
      waitingPrompt: blockingWaitKind
        ? tool.waitingPrompt || tool.summary || tool.target
        : undefined,
    };

    if (blockingWaitKind === "question" || (blockingWaitKind === "plan_review" && !tool.isArtifact)) {
      node.lastWaitingReason = blockingWaitKind;
      node.lastWaitingPrompt = entry.waitingPrompt;
    } else if (blockingWaitKind === "plan_review" && tool.isArtifact && tool.requestFeedback) {
      node.pendingPlanReview = {
        summary: tool.waitingPrompt || tool.summary || tool.target || "Review artifact plan",
        timestamp: tool.timestamp,
      };
      node.lastWaitingReason = "plan_review";
      node.lastWaitingPrompt = node.pendingPlanReview.summary;
    } else {
      node.lastWaitingReason = undefined;
      node.lastWaitingPrompt = undefined;
    }

    node.explicitCompleted = false;
    node.totalToolCalls += 1;
    node.toolCounts[category] = (node.toolCounts[category] ?? 0) + 1;
    node.inFlightTools.set(tool.callId, entry);
    node.recentTools.unshift(entry);
    if (node.recentTools.length > 8) {
      node.recentTools.length = 8;
    }
    if (tool.timestamp >= node.lastActiveAt) {
      node.lastActiveAt = tool.timestamp;
    }

    const badge =
      tool.badge ??
      classifySemanticBadge({
        kind: "tool",
        toolName: tool.name,
        command: tool.rawCommand || tool.target,
        filePath: tool.filePath || tool.target,
        isArtifact: tool.isArtifact,
      });

    let sanitizedFilePath = sanitizeRecordedFilePath(tool.filePath);
    if (
      !sanitizedFilePath &&
      (badge === "READ" || badge === "EDIT" || badge === "WRITE" || badge === "PLAN") &&
      category !== "bash" &&
      !tool.rawCommand &&
      typeof tool.target === "string"
    ) {
      const candidate = tool.target.trim();
      if (
        candidate &&
        !/[\r\n]/.test(candidate) &&
        (candidate.includes("/") ||
          candidate.includes("\\") ||
          /\.[a-z0-9]{1,8}$/i.test(candidate))
      ) {
        sanitizedFilePath = sanitizeRecordedFilePath(candidate);
      }
    }

    const sanitizedFullText = cleanFullText(tool.fullText);
    const sanitizedToolInput = cleanFullText(tool.toolInput);
    const sanitizedDiffPreview = cleanDiffPreview(tool.diffPreview);

    const logEntry: ActivityLogEntry = {
      id: `${node.id}:tool:${tool.callId}`,
      nodeId: node.id,
      rootId: node.parentId ?? node.id,
      agentLabel: node.label,
      isSubagent: node.isSubagent,
      harness: node.harness,
      kind: "tool",
      badge,
      category,
      title: tool.name,
      summary: cleanSummary(tool.summary),
      detail: cleanLogDetail(tool.target),
      filePath: sanitizedFilePath,
      rawCommand: cleanLogCommand(tool.rawCommand),
      toolInput: sanitizedToolInput,
      fullText: sanitizedFullText,
      diffPreview: sanitizedDiffPreview,
      linesAdded: tool.linesAdded,
      linesRemoved: tool.linesRemoved,
      modelBadge: tool.modelBadge,
      durationMs: tool.durationMs,
      status: "running",
      timestamp: tool.timestamp,
    };
    this.appendLog(logEntry);
    this.toolLogByCallId.set(`${node.id}:${tool.callId}`, logEntry);

    if (tool.isLive) {
      this.emitPulse({
        kind: "tool_start",
        nodeId: node.id,
        harness: node.harness,
        label: entry.target ? `${tool.name}: ${entry.target}` : tool.name,
        category,
        timestamp: tool.timestamp,
      });
    }
    this.scheduleSnapshot();
  }

  public recordToolEnd(
    nodeId: string,
    params: {
      callId?: string;
      allInFlight?: boolean;
      output?: string;
      isError?: boolean;
      durationMs?: number;
      exitCode?: number;
      linesAdded?: number;
      linesRemoved?: number;
      timestamp: number;
      isLive: boolean;
    }
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const isFailed = Boolean(
      params.isError || (params.exitCode !== undefined && params.exitCode !== 0)
    );

    const updateEntry = (entry: ActivityLogEntry) => {
      entry.status = isFailed ? "error" : "done";
      const dur =
        params.durationMs ??
        (params.timestamp > entry.timestamp ? params.timestamp - entry.timestamp : undefined);
      if (dur !== undefined && dur > 0 && dur < 3600_000) {
        entry.durationMs = dur;
      }
      if (params.exitCode !== undefined) {
        entry.exitCode = params.exitCode;
      }
      if (params.linesAdded !== undefined) {
        entry.linesAdded = params.linesAdded;
      }
      if (params.linesRemoved !== undefined) {
        entry.linesRemoved = params.linesRemoved;
      }
      if (params.output !== undefined) {
        const out = cleanToolOutput(params.output);
        if (out) {
          entry.output = out;
        }
      }
      entry.rev = ++this.logSeq;
      this.activityLogById.set(entry.id, entry);
    };

    let finishedTool: ToolEventSummary | undefined;
    if (params.allInFlight) {
      for (const t of node.inFlightTools.values()) {
        t.endedAt = params.timestamp;
        if (isFailed) t.isError = true;
        finishedTool = t;
      }
      node.inFlightTools.clear();

      for (const entry of this.activityLog) {
        if (entry.nodeId === nodeId && entry.kind === "tool" && entry.status === "running") {
          updateEntry(entry);
        }
      }
    } else if (params.callId) {
      finishedTool = node.inFlightTools.get(params.callId);
      if (finishedTool) {
        finishedTool.endedAt = params.timestamp;
        if (isFailed) finishedTool.isError = true;
        node.inFlightTools.delete(params.callId);
      }

      const key = `${nodeId}:${params.callId}`;
      const logEntry = this.toolLogByCallId.get(key);
      if (logEntry) {
        updateEntry(logEntry);
      } else {
        const id = `${nodeId}:tool:${params.callId}`;
        const fallback = this.activityLog.find(e => e.id === id);
        if (fallback) {
          updateEntry(fallback);
        }
      }
    }

    if (params.timestamp >= node.lastActiveAt) {
      node.lastActiveAt = params.timestamp;
    }
    // After ExitPlanMode tool ends, retain pendingPlanReview
    if (finishedTool && finishedTool.name.toLowerCase() === "exitplanmode") {
      node.pendingPlanReview = {
        summary: finishedTool.waitingPrompt || "Plan ready for approval",
        timestamp: params.timestamp,
      };
      node.lastWaitingReason = "plan_review";
      node.lastWaitingPrompt = node.pendingPlanReview.summary;
    }
    // After a tool result arrives, the model typically starts thinking on the next step
    if (node.inFlightTools.size === 0 && !node.explicitCompleted) {
      if (node.pendingPlanReview) {
        node.lastTurnPhase = "waiting_on_user";
      } else {
        node.lastTurnPhase = "thinking";
      }
    }

    if (params.isLive && finishedTool && isFailed) {
      this.emitPulse({
        kind: "tool_end",
        nodeId: node.id,
        harness: node.harness,
        label: `${finishedTool.name} failed`,
        category: finishedTool.category,
        isError: true,
        timestamp: params.timestamp,
      });
    }
    this.scheduleSnapshot();
  }

  public recordSkill(
    nodeId: string,
    skillName: string,
    timestamp: number,
    isLive: boolean
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node || !skillName) return;
    const clean = skillName.trim().replace(/^\/+/, "");
    if (!clean) return;

    const existing = node.skills.get(clean);
    if (existing) {
      existing.count += 1;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, timestamp);
    } else {
      node.skills.set(clean, {
        name: clean,
        count: 1,
        lastUsedAt: timestamp,
      });
    }

    this.appendLog({
      id: `${node.id}:skill:${timestamp}:${clean}`,
      nodeId: node.id,
      rootId: node.parentId ?? node.id,
      agentLabel: node.label,
      isSubagent: node.isSubagent,
      harness: node.harness,
      kind: "skill",
      badge: "SKILL",
      title: "Skill",
      detail: clean,
      timestamp,
    });

    if (isLive) {
      this.emitPulse({
        kind: "skill",
        nodeId: node.id,
        harness: node.harness,
        label: clean,
        timestamp,
      });
    }
    this.scheduleSnapshot();
  }

  public markCompleted(
    nodeId: string,
    timestamp: number,
    isLive: boolean,
    extra?: {
      durationMs?: number;
      subagentToolCount?: number;
      model?: string;
    }
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const wasCompleted = node.explicitCompleted;
    node.explicitCompleted = true;
    node.inFlightTools.clear();
    node.lastTurnPhase = "idle";
    if (timestamp >= node.lastActiveAt) {
      node.lastActiveAt = timestamp;
    }

    for (const entry of this.activityLog) {
      if (entry.nodeId === nodeId && entry.kind === "tool" && entry.status === "running") {
        entry.status = "done";
        entry.rev = ++this.logSeq;
        this.activityLogById.set(entry.id, entry);
      }
    }

    if (extra?.subagentToolCount && extra.subagentToolCount > node.totalToolCalls) {
      node.totalToolCalls = extra.subagentToolCount;
    }

    if (!wasCompleted && node.isSubagent) {
      const duration =
        extra?.durationMs ??
        (timestamp > node.createdAt && timestamp - node.createdAt < 3600_000
          ? timestamp - node.createdAt
          : undefined);
      const subagentToolCount =
        extra?.subagentToolCount ?? (node.totalToolCalls > 0 ? node.totalToolCalls : undefined);
      const modelBadge = shortenModel(extra?.model || node.model);

      this.appendLog({
        id: `${node.id}:complete:${timestamp}`,
        nodeId: node.id,
        rootId: node.parentId ?? node.id,
        agentLabel: node.label,
        isSubagent: true,
        harness: node.harness,
        kind: "subagent_complete",
        badge: "DONE",
        title: "Completed",
        detail: node.label,
        durationMs: duration,
        subagentToolCount,
        modelBadge,
        timestamp,
      });
    }

    if (isLive && !wasCompleted && node.isSubagent) {
      this.emitPulse({
        kind: "subagent_complete",
        nodeId: node.id,
        harness: node.harness,
        label: node.label,
        timestamp,
      });
    }
    this.scheduleSnapshot();
  }

  public recordUserPrompt(nodeId: string, text: string, timestamp: number): void {
    const summary = cleanUserPrompt(text);
    if (!summary) return;

    const node = this.nodes.get(nodeId);
    if (!node) return;

    node.pendingPlanReview = undefined;
    node.lastWaitingReason = undefined;
    node.lastWaitingPrompt = undefined;
    for (const t of node.inFlightTools.values()) {
      t.blockingWaitKind = undefined;
      t.waitingPrompt = undefined;
    }

    const fullPrompt = extractFullUserPrompt(text) || summary;
    const lastPrompt = this.lastPromptByNodeId.get(nodeId);
    if (lastPrompt === fullPrompt) {
      return;
    }
    this.lastPromptByNodeId.set(nodeId, fullPrompt);

    this.appendLog({
      id: `${node.id}:prompt:${timestamp}`,
      nodeId: node.id,
      rootId: node.parentId ?? node.id,
      agentLabel: node.label,
      isSubagent: node.isSubagent,
      harness: node.harness,
      kind: "prompt",
      badge: "PROMPT",
      title: "Prompt",
      detail: summary,
      summary,
      fullText: fullPrompt,
      timestamp,
    });
    this.scheduleSnapshot();
  }

  public recordAssistantMilestone(
    nodeId: string,
    rawText: string,
    timestamp: number,
    badgeOverride?: SemanticTaskBadge
  ): void {
    const cleaned = cleanAssistantMilestone(rawText);
    if (!cleaned) return;

    const node = this.nodes.get(nodeId);
    if (!node) return;

    node.lastAssistantSummary =
      cleaned.length > 64 ? cleaned.slice(0, 61).trim() + "..." : cleaned;

    const fullReply = extractFullAssistantReply(rawText) || cleaned;
    const lastReply = this.lastReplyByNodeId.get(nodeId);
    if (lastReply === fullReply) return;
    this.lastReplyByNodeId.set(nodeId, fullReply);

    const badge: SemanticTaskBadge = badgeOverride ?? "REPLY";
    const title = badgeOverride === "PR" ? "PR" : "Reply";

    this.appendLog({
      id: `${node.id}:reply:${timestamp}:${Math.random().toString(36).slice(2, 6)}`,
      nodeId: node.id,
      rootId: node.parentId ?? node.id,
      agentLabel: node.label,
      isSubagent: node.isSubagent,
      harness: node.harness,
      kind: "reply",
      badge,
      title,
      summary: cleaned,
      detail: cleaned,
      fullText: fullReply,
      timestamp,
    });
    this.scheduleSnapshot();
  }

  public recordPullRequestLink(
    nodeId: string,
    params: {
      url: string;
      prNumber?: number;
      repository?: string;
      timestamp: number;
    }
  ): void {
    const cleanUrl = (params.url || "").trim();
    if (!cleanUrl) return;

    const node = this.nodes.get(nodeId);
    if (!node) return;

    if (this.lastPrUrlByNodeId.get(nodeId) === cleanUrl) {
      return;
    }
    this.lastPrUrlByNodeId.set(nodeId, cleanUrl);

    const metaObj: Record<string, any> = { url: cleanUrl };
    if (params.prNumber !== undefined && Number.isFinite(params.prNumber)) {
      metaObj.prNumber = params.prNumber;
    }
    if (params.repository) {
      metaObj.repository = params.repository;
    }

    const summary =
      params.prNumber && params.repository
        ? `PR #${params.prNumber} · ${params.repository}`
        : params.prNumber
          ? `PR #${params.prNumber}`
          : undefined;

    this.appendLog({
      id: `${node.id}:pr:${params.timestamp}:${Math.random().toString(36).slice(2, 6)}`,
      nodeId: node.id,
      rootId: node.parentId ?? node.id,
      agentLabel: node.label,
      isSubagent: node.isSubagent,
      harness: node.harness,
      kind: "reply",
      badge: "PR",
      title: "PR",
      summary: cleanUrl,
      detail: cleanUrl,
      filePath: cleanUrl,
      toolInput: JSON.stringify(metaObj, null, 2),
      timestamp: params.timestamp,
    });
    this.scheduleSnapshot();
  }

  public clearSimulatedNodes(): void {
    const simNodeIds = new Set<string>();
    for (const [id, n] of this.nodes.entries()) {
      if (n.isSimulated) {
        simNodeIds.add(id);
        this.nodes.delete(id);
      }
    }
    this.activityLog = this.activityLog.filter(entry => {
      const keep = !simNodeIds.has(entry.nodeId) && !simNodeIds.has(entry.rootId);
      if (!keep && this.activityLogById.get(entry.id) === entry) {
        this.activityLogById.delete(entry.id);
      }
      return keep;
    });
    for (const key of Array.from(this.toolLogByCallId.keys())) {
      const colonIdx = key.indexOf(":");
      const nodeId = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
      if (simNodeIds.has(nodeId)) {
        this.toolLogByCallId.delete(key);
      }
    }
    for (const simId of simNodeIds) {
      this.lastPromptByNodeId.delete(simId);
      this.lastReplyByNodeId.delete(simId);
      this.lastPrUrlByNodeId.delete(simId);
    }
    for (const [key, val] of Array.from(this.turnUsageByKey.entries())) {
      if (simNodeIds.has(val.nodeId)) {
        this.turnUsageByKey.delete(key);
      }
    }
    this.logResetSeq = ++this.logSeq;
    this.emitSnapshotNow();
  }

  public hasSimulatedNodes(): boolean {
    for (const n of this.nodes.values()) {
      if (n.isSimulated) return true;
    }
    return false;
  }

  private hasActiveSubagents(
    nodeId: string,
    now: number,
    activeSubParentIds?: ReadonlySet<string>
  ): boolean {
    if (activeSubParentIds) {
      return activeSubParentIds.has(nodeId);
    }
    for (const child of this.nodes.values()) {
      if (child.parentId === nodeId) {
        const childStatus = this.computeStatus(child, now);
        if (childStatus === "tool_running" || childStatus === "thinking") {
          return true;
        }
      }
    }
    return false;
  }

  public computeStatus(
    node: MutableAgentNode,
    now: number,
    activeSubParentIds?: ReadonlySet<string>
  ): AgentStatus {
    const ageMs = Math.max(0, now - node.lastActiveAt);

    if (node.explicitCompleted) {
      return "completed";
    }

    if (!node.isSubagent) {
      for (const tool of node.inFlightTools.values()) {
        if (
          tool.blockingWaitKind &&
          (tool.blockingWaitKind === "question" || tool.blockingWaitKind === "plan_review") &&
          now - tool.startedAt < 30 * 60 * 1000
        ) {
          return "waiting_on_user";
        }
      }
    }

    // Active in-flight tool within 10m safety window
    if (node.inFlightTools.size > 0 && ageMs < 10 * 60 * 1000) {
      return "tool_running";
    }

    if (node.lastTurnPhase === "thinking" && ageMs < 90 * 1000) {
      return "thinking";
    }

    if (node.isSubagent) {
      // Subagents don't wait on interactive user input; once quiet > 35s they're done
      if (ageMs > 35 * 1000) {
        return "completed";
      }
      return node.lastTurnPhase === "waiting_on_user" ? "completed" : "thinking";
    }

    if (node.lastTurnPhase === "waiting_on_user") {
      if (node.pendingPlanReview && ageMs < 30 * 60 * 1000) {
        return "waiting_on_user";
      }

      if (this.hasActiveSubagents(node.id, now, activeSubParentIds)) {
        return "thinking";
      }

      if (ageMs < 15 * 60 * 1000) {
        return "waiting_on_user";
      }
    }

    return "idle";
  }

  public getSnapshot(
    now = Date.now(),
    options?: { stripHeavyLogFields?: boolean; sinceLogSeq?: number }
  ): GraphSnapshotPayload {
    const cutoff = now - WINDOW_MS[this.timeWindow];
    const includedIds = new Set<string>();

    // Precompute subagent statuses once in O(N) so hasActiveSubagents and activityLog auto-done are O(1)
    const activeSubParentIds = new Set<string>();
    const statusById = new Map<string, AgentStatus>();
    for (const node of this.nodes.values()) {
      if (node.isSubagent) {
        const subStatus = this.computeStatus(node, now);
        statusById.set(node.id, subStatus);
        if (node.parentId && (subStatus === "tool_running" || subStatus === "thinking")) {
          activeSubParentIds.add(node.parentId);
        }
      }
    }

    // First pass: include any node active within the selected time window (or simulated)
    for (const node of this.nodes.values()) {
      if (node.isSimulated || node.lastActiveAt >= cutoff) {
        includedIds.add(node.id);
        if (node.parentId && this.nodes.has(node.parentId)) {
          includedIds.add(node.parentId);
        }
      }
    }

    // Second pass: for every included parent, keep ALL of its subagents so its dimmed inner halo stays intact!
    for (const node of this.nodes.values()) {
      if (node.parentId && includedIds.has(node.parentId)) {
        includedIds.add(node.id);
      }
    }

    const snapshots: AgentNodeSnapshot[] = [];
    for (const id of includedIds) {
      const node = this.nodes.get(id);
      if (!node) continue;
      let status = statusById.get(node.id);
      if (status === undefined) {
        status = this.computeStatus(node, now, activeSubParentIds);
        statusById.set(node.id, status);
      }
      let activeTool: ToolEventSummary | undefined;
      if (status === "tool_running" && node.inFlightTools.size > 0) {
        const all = [...node.inFlightTools.values()];
        activeTool = all[all.length - 1];
      }

      let waitingReason: WaitingReasonKind | undefined;
      let waitingPrompt: string | undefined;

      if (status === "waiting_on_user") {
        let blockingTool: ToolEventSummary | undefined;
        for (const t of node.inFlightTools.values()) {
          if (t.blockingWaitKind) {
            blockingTool = t;
            break;
          }
        }

        if (blockingTool && blockingTool.blockingWaitKind) {
          waitingReason = blockingTool.blockingWaitKind;
          waitingPrompt = truncateWaitingPrompt(
            blockingTool.waitingPrompt ||
              (blockingTool.blockingWaitKind === "plan_review"
                ? "Plan ready for review"
                : "Waiting for your answer")
          );
        } else if (node.pendingPlanReview) {
          waitingReason = "plan_review";
          waitingPrompt = truncateWaitingPrompt(
            node.pendingPlanReview.summary || "Plan ready for review"
          );
        } else {
          waitingReason = node.lastWaitingReason ?? "turn_complete";
          waitingPrompt = truncateWaitingPrompt(
            node.lastWaitingPrompt || node.lastAssistantSummary || "Turn complete · ready"
          );
        }

        if (!node.lastEmittedWaitingState) {
          node.lastEmittedWaitingState = true;
          this.emitPulse({
            kind: "waiting",
            nodeId: node.id,
            harness: node.harness,
            label: node.label,
            timestamp: now,
          });
        }
      } else {
        node.lastEmittedWaitingState = false;
      }

      snapshots.push({
        id: node.id,
        rawId: node.rawId,
        harness: node.harness,
        parentId: node.parentId,
        isSubagent: node.isSubagent,
        label: node.label,
        project: node.project,
        cwd: node.cwd,
        branch: node.branch,
        model: shortenModel(node.model),
        status,
        waitingReason,
        waitingPrompt,
        createdAt: node.createdAt,
        lastActiveAt: node.lastActiveAt,
        turnCount: node.turnCount,
        totalToolCalls: node.totalToolCalls,
        toolCounts: { ...node.toolCounts },
        activeTool,
        recentTools: node.recentTools.map(t => ({ ...t })),
        skills: [...node.skills.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
        tokenUsage: node.tokenUsage ? { ...node.tokenUsage } : undefined,
        isSimulated: node.isSimulated,
        entrypoint: node.entrypoint,
      });
    }

    snapshots.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const stripHeavy = Boolean(options?.stripHeavyLogFields);
    const useDelta =
      stripHeavy &&
      options?.sinceLogSeq !== undefined &&
      options.sinceLogSeq >= this.logResetSeq;

    if (useDelta) {
      const sinceSeq = options!.sinceLogSeq!;
      let logUpserts: ActivityLogEntry[] = [];
      let isSorted = true;
      let prevTs = -Infinity;

      for (const entry of this.activityLog) {
        if (!includedIds.has(entry.nodeId) && !includedIds.has(entry.rootId)) {
          continue;
        }
        const liveNode = this.nodes.get(entry.nodeId);
        let status = entry.status;
        if (entry.kind === "tool" && status === "running" && liveNode) {
          let computed = statusById.get(liveNode.id);
          if (computed === undefined) {
            computed = this.computeStatus(liveNode, now, activeSubParentIds);
            statusById.set(liveNode.id, computed);
          }
          if (computed !== "tool_running") {
            status = "done";
            entry.status = "done";
            entry.rev = ++this.logSeq;
            this.activityLogById.set(entry.id, entry);
          }
        }

        if ((entry.rev ?? 0) <= sinceSeq) {
          continue;
        }

        const liveRoot = liveNode ? (liveNode.parentId ?? liveNode.id) : entry.rootId;
        const liveLabel = liveNode ? liveNode.label : entry.agentLabel;
        const isSubagent = liveNode ? liveNode.isSubagent : entry.isSubagent;

        if (entry.timestamp < prevTs) {
          isSorted = false;
        } else {
          prevTs = entry.timestamp;
        }

        logUpserts.push(
          toLightweightWireEntry(entry, liveLabel, liveRoot, isSubagent, status)
        );
      }

      if (!isSorted) {
        logUpserts.sort((a, b) => a.timestamp - b.timestamp);
      }
      if (logUpserts.length > 1200) {
        logUpserts = logUpserts.slice(logUpserts.length - 1200);
      }

      return {
        nodes: snapshots,
        activityLog: [],
        logDeltaMode: true,
        logUpserts,
        logSeq: this.logSeq,
        timeWindow: this.timeWindow,
        simActive: this.hasSimulatedNodes(),
        updatedAt: now,
      };
    }

    const activityLogSnapshot: ActivityLogEntry[] = [];
    let isSorted = true;
    let prevTs = -Infinity;

    for (const entry of this.activityLog) {
      if (!includedIds.has(entry.nodeId) && !includedIds.has(entry.rootId)) {
        continue;
      }
      const liveNode = this.nodes.get(entry.nodeId);
      const liveRoot = liveNode ? (liveNode.parentId ?? liveNode.id) : entry.rootId;
      const liveLabel = liveNode ? liveNode.label : entry.agentLabel;
      const isSubagent = liveNode ? liveNode.isSubagent : entry.isSubagent;

      let status = entry.status;
      if (entry.kind === "tool" && status === "running" && liveNode) {
        let computed = statusById.get(liveNode.id);
        if (computed === undefined) {
          computed = this.computeStatus(liveNode, now, activeSubParentIds);
          statusById.set(liveNode.id, computed);
        }
        if (computed !== "tool_running") {
          status = "done";
          entry.status = "done";
          entry.rev = ++this.logSeq;
          this.activityLogById.set(entry.id, entry);
        }
      }

      if (entry.timestamp < prevTs) {
        isSorted = false;
      } else {
        prevTs = entry.timestamp;
      }

      if (stripHeavy) {
        activityLogSnapshot.push(
          toLightweightWireEntry(entry, liveLabel, liveRoot, isSubagent, status)
        );
      } else {
        activityLogSnapshot.push({
          ...entry,
          agentLabel: liveLabel,
          rootId: liveRoot,
          isSubagent,
          status,
        });
      }
    }

    if (!isSorted) {
      activityLogSnapshot.sort((a, b) => a.timestamp - b.timestamp);
    }

    let activityLog: ActivityLogEntry[];
    if (activityLogSnapshot.length <= 1200) {
      activityLog = activityLogSnapshot;
    } else {
      // Ensure at least last 150 entries per root are preserved
      const guaranteedSet = new Set<ActivityLogEntry>();
      const entriesByRoot = new Map<string, ActivityLogEntry[]>();

      for (const entry of activityLogSnapshot) {
        const list = entriesByRoot.get(entry.rootId) ?? [];
        list.push(entry);
        entriesByRoot.set(entry.rootId, list);
      }

      for (const list of entriesByRoot.values()) {
        const last150 = list.slice(Math.max(0, list.length - 150));
        for (const e of last150) {
          guaranteedSet.add(e);
        }
      }

      const chosen = new Set<ActivityLogEntry>(guaranteedSet);
      if (chosen.size < 1200) {
        for (let i = activityLogSnapshot.length - 1; i >= 0 && chosen.size < 1200; i--) {
          chosen.add(activityLogSnapshot[i]);
        }
      }

      activityLog = Array.from(chosen);
      activityLog.sort((a, b) => a.timestamp - b.timestamp);
      if (activityLog.length > 1200) {
        activityLog = activityLog.slice(activityLog.length - 1200);
      }
    }

    if (stripHeavy) {
      return {
        nodes: snapshots,
        activityLog,
        logDeltaMode: false,
        logSeq: this.logSeq,
        timeWindow: this.timeWindow,
        simActive: this.hasSimulatedNodes(),
        updatedAt: now,
      };
    }

    return {
      nodes: snapshots,
      activityLog,
      ...(options?.sinceLogSeq !== undefined ? { logSeq: this.logSeq } : {}),
      timeWindow: this.timeWindow,
      simActive: this.hasSimulatedNodes(),
      updatedAt: now,
    };
  }

  public getNodeById(id: string): MutableAgentNode | undefined {
    return this.nodes.get(id);
  }

  public getRootNode(nodeId: string): MutableAgentNode | undefined {
    const visited = new Set<string>();
    let cur = this.nodes.get(nodeId);
    while (cur && cur.parentId && !visited.has(cur.id)) {
      visited.add(cur.id);
      const parent = this.nodes.get(cur.parentId);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  }

  public getAllNodesCount(): number {
    return this.nodes.size;
  }

  public emitPulse(pulse: LivePulseEvent): void {
    this.emit("pulse", pulse);
  }

  public scheduleSnapshot(): void {
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      this.emitSnapshotNow();
    }, 90);
  }

  public emitSnapshotNow(): void {
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
    }
    this.emit("invalidate");
    if (this.listenerCount("snapshot") > 0) {
      this.emit("snapshot", this.getSnapshot());
    }
  }
}

function toLightweightWireEntry(
  entry: ActivityLogEntry,
  liveLabel: string,
  liveRoot: string,
  isSubagent: boolean,
  status: "running" | "done" | "error" | undefined
): ActivityLogEntry {
  const hasRawCommand = Boolean(entry.rawCommand);
  const hasToolInput = Boolean(entry.toolInput);
  const hasFullText = Boolean(entry.fullText);
  const hasOutput = Boolean(entry.output);
  const hasDiffPreview = Boolean(entry.diffPreview);
  const rawCmdIsHeavy = Boolean(
    entry.rawCommand && (entry.rawCommand.length > 200 || entry.rawCommand.includes("\n"))
  );
  const hasHeavyDetail =
    hasToolInput || hasFullText || hasOutput || hasDiffPreview || rawCmdIsHeavy;

  return {
    ...entry,
    agentLabel: liveLabel,
    rootId: liveRoot,
    isSubagent,
    status,
    toolInput: undefined,
    fullText: undefined,
    output: undefined,
    diffPreview: undefined,
    rawCommand: rawCmdIsHeavy
      ? entry.summary
        ? undefined
        : entry.rawCommand!.slice(0, 200)
      : entry.rawCommand,
    hasHeavyDetail,
    hasRawCommand,
    hasToolInput,
    hasFullText,
    hasOutput,
    hasDiffPreview,
  };
}

function truncateTarget(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.includes("/") || clean.includes("\\")) {
    const norm = clean.replace(/\\/g, "/");
    const parts = norm.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const short = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
      return short.length <= 34 ? short : parts[parts.length - 1].slice(0, 32);
    }
  }
  return clean.length > 34 ? clean.slice(0, 31) + "..." : clean;
}

export function shortenModel(model?: string): string | undefined {
  if (!model) return undefined;
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

const NAMED_XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  hellip: "\u2026",
  bull: "\u2022",
  rarr: "\u2192",
  larr: "\u2190",
  times: "\u00D7",
  copy: "\u00A9",
};

/**
 * Single-pass XML/HTML entity decoder so XML-escaped strings (e.g. `We&#39;re back`,
 * `&quot;hello&quot;`, `&lt;tmp&gt;`, `&amp;`) render cleanly without double-unescaping.
 */
export function decodeXmlEntities(str: string): string {
  if (!str || !str.includes("&")) return str;
  return str.replace(
    /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,15}));/g,
    (full, dec, hex, named) => {
      if (dec !== undefined) {
        const cp = parseInt(dec, 10);
        if ((cp === 0x09 || cp === 0x0a || cp >= 0x20) && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          try {
            return String.fromCodePoint(cp);
          } catch {
            return full;
          }
        }
        return full;
      }
      if (hex !== undefined) {
        const cp = parseInt(hex, 16);
        if ((cp === 0x09 || cp === 0x0a || cp >= 0x20) && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
          try {
            return String.fromCodePoint(cp);
          } catch {
            return full;
          }
        }
        return full;
      }
      if (named !== undefined) {
        const mapped = NAMED_XML_ENTITIES[named] ?? NAMED_XML_ENTITIES[named.toLowerCase()];
        if (mapped !== undefined) return mapped;
      }
      return full;
    }
  );
}

function decodeXmlEntitiesOutsideCodeFences(str: string): string {
  if (!str || !str.includes("&")) return str;
  const parts = str.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = decodeXmlEntities(parts[i]);
  }
  return parts.join("");
}

function dedentXmlBlock(raw: string): string {
  const norm = raw.replace(/\r\n/g, "\n");
  const lines = norm.split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return "";
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = line.match(/^[ \t]*/);
    const indent = m ? m[0].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent > 0 && Number.isFinite(minIndent)) {
    return lines.map(l => (l.trim() === "" ? "" : l.slice(minIndent))).join("\n");
  }
  return lines.join("\n");
}

function unwrapPromptEnvelopeRaw(
  raw: string
): { text: string; isXmlEscapedEnvelope: boolean } | null {
  if (!raw || typeof raw !== "string") return null;

  // Ignore system payloads unless USER_REQUEST is present inside
  if (raw.includes("<SYSTEM_MESSAGE>") && !raw.includes("<USER_REQUEST>")) {
    return null;
  }

  // Strip injected <system-reminder>...</system-reminder> blocks
  let text = raw.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "").trim();
  if (!text) return null;

  // Ignore background task completion envelopes when no user request is present
  if (
    /^<task-notification\b[\s\S]*<\/task-notification>$/i.test(text) &&
    !text.includes("<USER_REQUEST>")
  ) {
    return null;
  }

  // 1. Antigravity <USER_REQUEST>
  const userReqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (userReqMatch) {
    return { text: userReqMatch[1], isXmlEscapedEnvelope: false };
  }

  // 2. Claude Desktop / Projects / Slack <wake>...<message>...</message>...</wake>
  const wakeMatch = text.match(/<wake\b[^>]*>([\s\S]*?)<\/wake>/i);
  if (wakeMatch) {
    const wakeInner = wakeMatch[1];
    const msgMatches = Array.from(
      wakeInner.matchAll(/<message\b([^>]*)>([\s\S]*?)<\/message>/gi)
    );
    if (msgMatches.length > 0) {
      const triggered = msgMatches.filter(m => /\btrigger\s*=\s*["']true["']/i.test(m[1]));
      const chosen = triggered.length > 0 ? triggered : msgMatches;
      const joined = chosen
        .map(m => dedentXmlBlock(m[2]))
        .filter(Boolean)
        .join("\n\n");
      return joined ? { text: joined, isXmlEscapedEnvelope: true } : null;
    }
    const fallbackWake = dedentXmlBlock(wakeInner);
    return fallbackWake ? { text: fallbackWake, isXmlEscapedEnvelope: true } : null;
  }

  // 3. Claude Coordinator <relay>...<note>...</note></relay>
  const relayMatch = text.match(/<relay\b[^>]*>([\s\S]*?)<\/relay>/i);
  if (relayMatch) {
    const relayInner = relayMatch[1];
    const noteMatch = relayInner.match(/<note\b[^>]*>([\s\S]*?)<\/note>/i);
    const body = dedentXmlBlock(noteMatch ? noteMatch[1] : relayInner);
    return body ? { text: body, isXmlEscapedEnvelope: true } : null;
  }

  // 4. Antigravity subagent [Message] ... content=...
  if (text.startsWith("[Message]")) {
    const contentMatch = text.match(/content=([\s\S]*)/i);
    if (contentMatch && contentMatch[1]) {
      return { text: contentMatch[1], isXmlEscapedEnvelope: false };
    }
    return null;
  }

  // Check for JSON tool payloads
  if (text.includes('"tool_use_id"') || text.includes('"type":"tool_result"')) {
    return null;
  }

  return { text, isXmlEscapedEnvelope: false };
}

export function cleanSummary(raw?: string): string | undefined {
  if (!raw) return undefined;
  const clean = decodeXmlEntities(raw).replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > 160 ? clean.slice(0, 157) + "..." : clean;
}

export function cleanLogCommand(raw?: string): string | undefined {
  if (!raw) return undefined;
  const clean = raw.replace(/\r\n/g, "\n").trim();
  if (!clean) return undefined;
  return clean.length > 16000 ? clean.slice(0, 15997).trim() + "..." : clean;
}

export function cleanFullText(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const clean = raw.replace(/\r\n/g, "\n").trim();
  if (!clean) return undefined;
  return clean.length > 16000 ? clean.slice(0, 15997).trim() + "..." : clean;
}

export function cleanDiffPreview(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const clean = raw.replace(/\r\n/g, "\n").trim();
  if (!clean) return undefined;
  return clean.length > 12000 ? clean.slice(0, 11997).trim() + "..." : clean;
}

export function cleanToolOutput(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  let clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  // Strip Antigravity metadata boilerplate if present
  const cmdOutputIdx = clean.indexOf("Command output:\n");
  if (cmdOutputIdx >= 0) {
    clean = clean.slice(cmdOutputIdx + "Command output:\n".length);
  } else {
    const cmdOutputIdx2 = clean.indexOf("Command output:\r\n");
    if (cmdOutputIdx2 >= 0) {
      clean = clean.slice(cmdOutputIdx2 + "Command output:\r\n".length);
    } else {
      clean = clean
        .replace(/^Created At:\s*[^\r\n]*\r?\n?/i, "")
        .replace(/^Completed At:\s*[^\r\n]*\r?\n?/i, "");
    }
  }
  clean = clean.replace(/\r\n/g, "\n").trim();
  if (!clean) return undefined;
  return clean.length > 16000 ? clean.slice(0, 15997).trim() + "..." : clean;
}

export function cleanLogDetail(raw?: string): string | undefined {
  if (!raw) return undefined;
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > 320 ? clean.slice(0, 317) + "..." : clean;
}

function sanitizeRecordedFilePath(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const clean = raw.trim().replace(/^(["'`])([\s\S]*)\1$/, "$2").trim();
  if (!clean || /[\r\n\0]/.test(clean)) return undefined;
  return clean.length > 1024 ? clean.slice(0, 1024) : clean;
}

export function cleanAssistantMilestone(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;

  // 1. Remove code blocks
  let text = raw.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");

  // 2. Unpack markdown links [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");

  // 3. Remove markdown headers, blockquotes, bullets, bold/italic, backticks
  text = text.replace(/^[\s#>*-]+/gm, " ");
  text = text.replace(/[*_`~]/g, "");

  // 4. Decode XML/HTML entities & collapse whitespace
  text = decodeXmlEntities(text).replace(/\s+/g, " ").trim();

  // 5. Minimum length
  if (text.length < 4) return null;

  // 6. Crisp 1-line summary <= 120 chars
  if (text.length > 120) {
    text = text.slice(0, 117).trim() + "...";
  }

  return text;
}

export function extractFullAssistantReply(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length < 4) return null;
  if (text.length > 24000) {
    text = text.slice(0, 24000).trim();
  }
  return text;
}

export function cleanUserPrompt(raw: string): string | null {
  const unwrapped = unwrapPromptEnvelopeRaw(raw);
  if (!unwrapped) return null;

  // Strip slash-command boilerplate status lines while keeping <command-name> & <command-args>
  let stripped = unwrapped.text
    .replace(/<command-message\b[^>]*>[\s\S]*?<\/command-message>/gi, " ")
    .replace(/<local-command-stdout\b[^>]*>[\s\S]*?<\/local-command-stdout>/gi, " ");

  // Strip remaining XML / HTML wrapper tags BEFORE decoding XML entities so literal
  // escaped angle-bracket tokens like `&lt;tmp&gt;` survive intact after decoding.
  stripped = stripped.replace(/<\/?[a-zA-Z0-9_:-]+(\s[^>]*)?>/g, " ");

  // Decode XML / HTML character entities (e.g. `&#39;` -> `'`, `&quot;` -> `"`, `&lt;` -> `<`)
  stripped = decodeXmlEntities(stripped);

  // Collapse whitespace
  stripped = stripped.replace(/\s+/g, " ").trim();
  if (!stripped) return null;

  // Crisp 1-line summary <= 110 chars
  if (stripped.length > 110) {
    stripped = stripped.slice(0, 107).trim() + "...";
  }

  return stripped;
}

export function extractFullUserPrompt(raw: string): string | null {
  const unwrapped = unwrapPromptEnvelopeRaw(raw);
  if (!unwrapped) return null;

  // Strip wrapper XML tags cleanly while preserving newlines, code blocks, bullet points
  let text = unwrapped.text
    .replace(/<command-message\b[^>]*>[\s\S]*?<\/command-message>/gi, "")
    .replace(/<local-command-stdout\b[^>]*>[\s\S]*?<\/local-command-stdout>/gi, "")
    .replace(
      /<\/?(command-name|command-args|system_message|user_request|task-notification|wake|project|thread|message|relay|note|antml:[^>]+)[^>]*>/gi,
      ""
    );

  // Decode XML entities (full decode for XML-serialized envelopes like <wake>/<relay>;
  // outside code fences for plain markdown prompts)
  text = unwrapped.isXmlEscapedEnvelope
    ? decodeXmlEntities(text)
    : decodeXmlEntitiesOutsideCodeFences(text);

  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) return null;

  // Cap at 24,000 characters
  if (text.length > 24000) {
    text = text.slice(0, 24000).trim();
  }

  return text;
}

export function truncateWaitingPrompt(raw?: string): string {
  if (!raw || typeof raw !== "string") return "Waiting for your answer";
  let text = decodeXmlEntities(raw)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/^[\s#>*-]+/gm, " ")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 58) {
    text = text.slice(0, 55).trim() + "...";
  }
  return text || "Waiting for your answer";
}
