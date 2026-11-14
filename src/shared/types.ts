export type HarnessKind = "claude" | "codex" | "antigravity" | "strata";

export type AgentStatus =
  | "tool_running"
  | "thinking"
  | "waiting_on_user"
  | "completed"
  | "idle";

export type WaitingReasonKind = "question" | "plan_review" | "turn_complete";

export type ToolCategory = "read" | "edit" | "bash" | "web" | "agent" | "other";

export type EdgeSide = "right" | "left" | "top" | "bottom";

export type AppViewMode = "window" | "dock";

export interface WindowStateInfo {
  viewMode: AppViewMode;
  isMaximized: boolean;
  isFullScreen: boolean;
  alwaysOnTop: boolean;
  platform?: string;
}

export type DrawerSizePreset = "compact" | "large" | "xl" | "custom";

export type ResizeEdge =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "bottom-left"
  | "top-right"
  | "bottom-right";

export type TimeWindowMode = "live" | "30m" | "4h" | "24h";

export type SemanticTaskBadge =
  | "TEST"
  | "BUILD"
  | "GIT"
  | "PR"
  | "SEARCH"
  | "READ"
  | "EDIT"
  | "WRITE"
  | "PLAN"
  | "ASK"
  | "SPAWN"
  | "DONE"
  | "MSG"
  | "MCP"
  | "WEB"
  | "PKG"
  | "SCRIPT"
  | "BASH"
  | "SKILL"
  | "PROMPT"
  | "REPLY"
  | "TOOL";

export type ActivityLogKind =
  | "tool"
  | "skill"
  | "subagent_spawn"
  | "subagent_complete"
  | "prompt"
  | "reply"
  | "waiting";

export interface ActivityLogDetailPayload {
  id: string;
  rawCommand?: string;
  toolInput?: string;
  fullText?: string;
  output?: string;
  diffPreview?: string;
}

export interface ActivityLogEntry {
  id: string;
  rev?: number;
  nodeId: string;
  rootId: string;
  agentLabel: string;
  isSubagent: boolean;
  harness: HarnessKind;
  kind: ActivityLogKind;
  badge: SemanticTaskBadge;
  category?: ToolCategory;
  title: string;
  /** Plain-English summary (e.g. Claude Bash description, Antigravity toolSummary, Artifact summary) */
  summary?: string;
  /** File path, query, prompt/reply text, or fallback target */
  detail?: string;
  /** File path for READ / EDIT / WRITE / PLAN rows so clicking opens the file directly */
  filePath?: string;
  /** Raw CLI shell command (revealed when clicking the row) */
  rawCommand?: string;
  /** Formatted JSON/structured arguments passed to the tool call (revealed when clicking the row) */
  toolInput?: string;
  /** Full untruncated multi-line text (e.g. full user prompt, full assistant reply, full MCP/tool payload) */
  fullText?: string;
  /** Captured CLI stdout/stderr or tool result output */
  output?: string;
  /** Compact unified diff preview (- removed / + added lines) for EDIT/WRITE tools */
  diffPreview?: string;
  /** Indicates full heavy payload can be fetched on demand via getLogDetail(id) */
  hasHeavyDetail?: boolean;
  hasRawCommand?: boolean;
  hasToolInput?: boolean;
  hasFullText?: boolean;
  hasOutput?: boolean;
  hasDiffPreview?: boolean;
  status?: "running" | "done" | "error";
  linesAdded?: number;
  linesRemoved?: number;
  durationMs?: number;
  exitCode?: number;
  subagentToolCount?: number;
  modelBadge?: string;
  timestamp: number;
}

export interface ToolEventSummary {
  id: string;
  name: string;
  category: ToolCategory;
  target?: string;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
  blockingWaitKind?: WaitingReasonKind;
  waitingPrompt?: string;
}

export interface SkillUse {
  name: string;
  count: number;
  lastUsedAt: number;
}

export interface TokenUsageSnapshot {
  /** Current active turn context window occupancy in tokens */
  contextTokens: number;
  /** Model context window cap (e.g. 200_000, 258_400, 1_000_000) */
  contextMaxTokens: number;
  /** 0..100 rounded percentage of context window occupied */
  contextPercent: number;
  /** Cumulative total tokens processed across the session */
  totalTokens: number;
  /** Cumulative generated output tokens across the session */
  outputTokens?: number;
}

export interface OpenFileResult {
  ok: boolean;
  resolvedPath?: string;
  error?: string;
}

export interface AgentNodeSnapshot {
  id: string;
  rawId: string;
  harness: HarnessKind;
  parentId?: string;
  isSubagent: boolean;
  label: string;
  project: string;
  cwd?: string;
  branch?: string;
  model?: string;
  status: AgentStatus;
  waitingReason?: WaitingReasonKind;
  waitingPrompt?: string;
  createdAt: number;
  lastActiveAt: number;
  /** Number of model response turns executed by this agent/subagent */
  turnCount?: number;
  totalToolCalls: number;
  toolCounts: Record<ToolCategory, number>;
  activeTool?: ToolEventSummary;
  recentTools: ToolEventSummary[];
  skills: SkillUse[];
  tokenUsage?: TokenUsageSnapshot;
  isSimulated?: boolean;
  entrypoint?: string;
}

export interface FocusResult {
  ok: boolean;
  targetApp?: string;
  windowTitle?: string;
  reason?: string;
}

export interface LivePulseEvent {
  kind:
    | "tool_start"
    | "tool_end"
    | "skill"
    | "subagent_spawn"
    | "subagent_complete"
    | "waiting";
  nodeId: string;
  harness: HarnessKind;
  label: string;
  category?: ToolCategory;
  isError?: boolean;
  timestamp: number;
}

export interface EdgeAttachment {
  displayId: number;
  edge: EdgeSide;
  /** 0.0 to 1.0 position of the spine along the screen edge */
  offsetRatio: number;
  isExpanded: boolean;
  isPinned: boolean;
  isDragging: boolean;
  previewEdge?: EdgeSide;
  sizePreset: DrawerSizePreset;
  drawerWidth: number;
  drawerHeight: number;
}

export interface GraphSnapshotPayload {
  nodes: AgentNodeSnapshot[];
  activityLog: ActivityLogEntry[];
  /** When true, renderer applies logUpserts incrementally instead of replacing activityLog */
  logDeltaMode?: boolean;
  logUpserts?: ActivityLogEntry[];
  logSeq?: number;
  timeWindow: TimeWindowMode;
  simActive: boolean;
  updatedAt: number;
}

export const MIN_ANIMATION_SPEED = 0.1;
export const MAX_ANIMATION_SPEED = 3.0;
export const DEFAULT_ANIMATION_SPEED = 1.0;

export function clampAnimationSpeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ANIMATION_SPEED;
  }
  const clamped = Math.max(MIN_ANIMATION_SPEED, Math.min(MAX_ANIMATION_SPEED, value));
  return Math.round(clamped * 100) / 100;
}

export function formatAnimationSpeedDescriptor(speed: number): string {
  const s = clampAnimationSpeed(speed);
  if (s <= 0.35) return "Drift";
  if (s <= 0.75) return "Calm";
  if (s <= 1.15) return "Normal";
  if (s <= 1.85) return "Brisk";
  return "Swift";
}

export interface OrbitSettings {
  animationSpeed: number;
  viewMode: AppViewMode;
  dockEdge: EdgeSide;
  sizePreset: DrawerSizePreset;
  isPinned: boolean;
  alwaysOnTop: boolean;
  flashTaskbarOnWaiting: boolean;
  openAtLogin: boolean;
  simActive: boolean;
  platform?: string;
}

export interface PlatformShortcuts {
  jumpWaiting: string;
  jumpWaitingKbd: string;
  toggleOrbit: string;
  toggleOrbitKbd: string;
  settings: string;
  settingsKbd: string;
  fullscreen: string;
  fullscreenKbd: string;
  search: string;
}

export function getPlatformShortcuts(
  platform: string | undefined = typeof process !== "undefined" ? process.platform : undefined
): PlatformShortcuts {
  if (platform === "darwin") {
    return {
      jumpWaiting: "⌥⇧Space",
      jumpWaitingKbd: "⌥ + ⇧ + Space",
      toggleOrbit: "⌥⇧O",
      toggleOrbitKbd: "⌥ + ⇧ + O",
      settings: "⌘,",
      settingsKbd: "⌘ + ,",
      fullscreen: "⌃⌘F",
      fullscreenKbd: "⌃ + ⌘ + F",
      search: "/ or ⌘F",
    };
  }
  return {
    jumpWaiting: "Alt+Shift+Space",
    jumpWaitingKbd: "Alt + Shift + Space",
    toggleOrbit: "Alt+Shift+O",
    toggleOrbitKbd: "Alt + Shift + O",
    settings: "Ctrl+,",
    settingsKbd: "Ctrl + ,",
    fullscreen: "F11",
    fullscreenKbd: "F11",
    search: "/ or Ctrl+F",
  };
}

export interface OrbitBridgeAPI {
  getInitialState(): Promise<{
    graph: GraphSnapshotPayload;
    attachment: EdgeAttachment;
    windowState: WindowStateInfo;
    animationSpeed?: number;
    hideLog?: boolean;
  }>;
  getLogDetail(entryId: string): Promise<ActivityLogDetailPayload | null>;
  openSettings(): Promise<void>;
  getSettings(): Promise<OrbitSettings>;
  updateSettings(patch: Partial<OrbitSettings>): Promise<OrbitSettings>;
  resetDockPosition(): Promise<void>;
  onSettingsChanged(cb: (settings: OrbitSettings) => void): () => void;
  setViewMode(mode: AppViewMode, dockEdge?: EdgeSide): Promise<void>;
  toggleFullScreen(): Promise<void>;
  onWindowState(cb: (state: WindowStateInfo) => void): () => void;
  setTimeWindow(mode: TimeWindowMode): Promise<void>;
  setPinned(pinned: boolean): Promise<void>;
  collapseDrawer(): Promise<void>;
  triggerSimBurst(): Promise<void>;
  clearSimulated(): Promise<void>;
  showContextMenu(nodeId?: string): Promise<void>;
  startEdgeDrag(): Promise<void>;
  endEdgeDrag(): Promise<void>;
  focusNode(nodeId: string): Promise<FocusResult>;
  jumpToNextWaiting(): Promise<FocusResult>;
  openFilePath(filePath: string, nodeId?: string): Promise<OpenFileResult>;
  cycleWindowSize(): Promise<void>;
  startWindowResize(edge: ResizeEdge): Promise<void>;
  endWindowResize(): Promise<void>;
  onGraphSnapshot(cb: (payload: GraphSnapshotPayload) => void): () => void;
  onPulse(cb: (pulse: LivePulseEvent) => void): () => void;
  onAttachment(cb: (att: EdgeAttachment) => void): () => void;
  onOpenLog(cb: (nodeId?: string) => void): () => void;
  onFocusResult(cb: (res: FocusResult) => void): () => void;
}

export function classifyBlockingUserTool(
  toolName: string,
  extra?: { isArtifact?: boolean; requestFeedback?: boolean; mcpToolName?: string }
): WaitingReasonKind | null {
  const n = (toolName || "").toLowerCase().trim();
  const mcp = (extra?.mcpToolName || "").toLowerCase().trim();

  const isQuestionName = (name: string) => {
    return (
      name === "askuserquestion" ||
      name === "ask_question" ||
      name === "request_user_input" ||
      name === "request_user_input_async" ||
      name === "board_wait_for_answers" ||
      name === "mcp__release-boards__board_wait_for_answers" ||
      name === "board_ask_question" ||
      name === "mcp__release-boards__board_ask_question" ||
      name === "board_ask_one_liner" ||
      name === "mcp__release-boards__board_ask_one_liner" ||
      name === "board_ask_asset_review" ||
      name === "mcp__release-boards__board_ask_asset_review" ||
      name.endsWith("board_wait_for_answers") ||
      name.endsWith("board_ask_question") ||
      name.endsWith("board_ask_one_liner") ||
      name.endsWith("board_ask_asset_review")
    );
  };

  if (isQuestionName(n) || (mcp && isQuestionName(mcp))) {
    return "question";
  }
  if (
    n === "exitplanmode" ||
    (mcp && mcp === "exitplanmode") ||
    Boolean(extra?.isArtifact && extra?.requestFeedback)
  ) {
    return "plan_review";
  }
  return null;
}

export function categorizeToolName(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (
    n === "read" ||
    n === "glob" ||
    n === "grep" ||
    n === "ls" ||
    n.includes("read_file") ||
    n.includes("view_file") ||
    n.includes("grep") ||
    n.includes("find_by_name") ||
    n.includes("list_dir") ||
    n.includes("list_resources")
  ) {
    return "read";
  }
  if (
    n === "edit" ||
    n === "multiedit" ||
    n === "write" ||
    n === "notebookedit" ||
    n.includes("edit_file") ||
    n.includes("write_file") ||
    n.includes("replace_file") ||
    n.includes("apply_patch")
  ) {
    return "edit";
  }
  if (
    n === "bash" ||
    n === "exec" ||
    n === "exec_command" ||
    n === "shell" ||
    n.includes("run_command") ||
    n.includes("local_shell") ||
    n.includes("write_stdin")
  ) {
    return "bash";
  }
  if (
    n === "agent" ||
    n === "task" ||
    n.includes("subagent") ||
    n.includes("spawn_agent") ||
    n.includes("followup_task") ||
    n.includes("send_message") ||
    n === "swarm"
  ) {
    return "agent";
  }
  if (
    n.includes("web") ||
    n.includes("fetch") ||
    n.includes("browser") ||
    n.includes("mcp") ||
    n.includes("search")
  ) {
    return "web";
  }
  return "other";
}

export function extractSkillFromPath(filePath?: string): string | null {
  if (!filePath || typeof filePath !== "string") return null;
  const normalized = filePath.replace(/\\/g, "/");
  const m = normalized.match(/\/skills\/([^/]+)\/SKILL\.md$/i);
  if (m && m[1]) return m[1];
  return null;
}

export function projectFromCwd(cwd?: string): string {
  if (!cwd) return "workspace";
  const cleaned = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  // If inside a git worktree folder like .../worktree/feat-auth-flow, take basename
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 0) return "workspace";
  const last = parts[parts.length - 1];
  const isWinHome =
    parts.length === 3 &&
    /^[a-zA-Z]:$/.test(parts[0]) &&
    parts[1].toLowerCase() === "users";
  const isPosixHome =
    parts.length === 2 &&
    (parts[0].toLowerCase() === "users" || parts[0].toLowerCase() === "home");
  if (isWinHome || isPosixHome || last.toLowerCase() === "users" || last.toLowerCase() === "home") {
    return "home";
  }
  return last;
}

export function classifySemanticBadge(params: {
  kind: ActivityLogKind;
  toolName?: string;
  command?: string;
  filePath?: string;
  isArtifact?: boolean;
}): SemanticTaskBadge {
  // 1. Lifecycle kinds
  if (params.kind === "prompt") return "PROMPT";
  if (params.kind === "reply") return "REPLY";
  if (params.kind === "skill") return "SKILL";
  if (params.kind === "subagent_spawn") return "SPAWN";
  if (params.kind === "subagent_complete") return "DONE";

  // 2. Artifact
  if (params.isArtifact) return "PLAN";

  const n = (params.toolName || "").toLowerCase().trim();

  // 3. Tool name rules
  if (n === "pr-link") return "PR";
  if (n === "askuserquestion" || n === "ask_question" || n === "request_user_input_async") return "ASK";
  if (
    n === "todowrite" ||
    n === "taskcreate" ||
    n === "taskupdate" ||
    n === "plan" ||
    n === "exitplanmode" ||
    n === "enterplanmode" ||
    n === "update_plan"
  ) {
    return "PLAN";
  }
  if (
    n === "agent" ||
    n === "task" ||
    n === "invoke_subagent" ||
    n === "spawn_agent" ||
    n === "swarm"
  ) {
    return "SPAWN";
  }
  if (n === "sendmessage" || n === "send_message" || n === "followup_task") return "MSG";
  if (
    n.startsWith("mcp__") ||
    n === "call_mcp_tool" ||
    n === "read_resource" ||
    n === "list_resources"
  ) {
    return "MCP";
  }
  if (
    n === "websearch" ||
    n === "webfetch" ||
    n === "search_web" ||
    n === "read_url_content" ||
    n.includes("browser")
  ) {
    return "WEB";
  }
  if (
    n === "grep" ||
    n === "glob" ||
    n === "find_by_name" ||
    n === "toolsearch" ||
    n === "search_marketplace"
  ) {
    return "SEARCH";
  }
  if (
    n === "read" ||
    n === "read_file" ||
    n === "view_file" ||
    n === "view_file_outline" ||
    n === "view_code_item" ||
    n === "list_dir" ||
    n === "ls"
  ) {
    return "READ";
  }
  if (n === "write" || n === "write_file") return "WRITE";
  if (
    n === "edit" ||
    n === "multiedit" ||
    n === "notebookedit" ||
    n === "edit_file" ||
    n.includes("replace_file") ||
    n === "apply_patch"
  ) {
    return "EDIT";
  }

  // 4. Shell commands
  const isShell =
    n === "bash" ||
    n === "run_command" ||
    n === "exec" ||
    n === "exec_command" ||
    n === "shell" ||
    n === "local_shell" ||
    n === "pwsh" ||
    n === "sh" ||
    n === "command/run" ||
    Boolean(params.command);

  if (isShell) {
    let cmd = (params.command || "").trim();

    // Unwrap `& ".../bash.exe" -lc "..."` if present
    const bashWrappedMatch = cmd.match(
      /^&?\s*["'][^"']*(?:bash|sh)(?:\.exe)?["']\s+-[a-zA-Z]*c\s+["']([\s\S]*)["']\s*$/
    );
    if (bashWrappedMatch && bashWrappedMatch[1]) {
      cmd = bashWrappedMatch[1].trim();
    }

    // Strip leading `cd <dir> &&` segments
    while (/^cd\s+(?:"[^"]+"|\S+)\s*(&&|;)\s*/i.test(cmd)) {
      cmd = cmd.replace(/^cd\s+(?:"[^"]+"|\S+)\s*(&&|;)\s*/i, "").trim();
    }

    // Priority checks
    if (/\bgh\s+(pr|issue|release)\b/i.test(cmd)) return "PR";
    if (
      /\b(npm\s+test|npm\s+run\s+test\S*|npx\s+(vitest|jest|playwright|mocha)|node\s+--test|pytest|vitest|jest|dotnet\s+test|cargo\s+test|go\s+test|ctest)\b/i.test(
        cmd
      )
    ) {
      return "TEST";
    }
    if (
      /\b(npm\s+run\s+(build\S*|typecheck\S*|compile\S*)|npx\s+tsc|\btsc\b|vite\s+build|dotnet\s+build|cargo\s+(build|check)|csc\.exe|msbuild|make\b|cmake\b|go\s+build)\b/i.test(
        cmd
      )
    ) {
      return "BUILD";
    }
    if (
      /\b(npm\s+(install|i|ci|uninstall|update)|yarn\s+add|pnpm\s+(add|i|install)|pip3?\s+install|cargo\s+add|dotnet\s+add\s+package|nuget)\b/i.test(
        cmd
      )
    ) {
      return "PKG";
    }
    if (
      /\bgit\s+(status|diff|log|show|add|commit|push|pull|fetch|checkout|switch|branch|merge|rebase|stash|worktree|rev-parse|reset|restore|tag|clone)\b/i.test(
        cmd
      ) ||
      /^\s*git\b/i.test(cmd)
    ) {
      return "GIT";
    }
    if (/^\s*(rg|grep|egrep|fgrep|find|fd|ag|where|which)\b/i.test(cmd)) return "SEARCH";
    if (/^\s*(cat|head|tail|sed\s+-n|ls|dir|pwd|stat|wc)\b/i.test(cmd)) return "READ";
    if (
      /\b(node|python3?|py|tsx|ts-node|deno|bun)\s+\S+/i.test(cmd) ||
      /\S+\.(sh|py|js|mjs|cjs|vbs)\b/i.test(cmd) ||
      (params.filePath && /\.(sh|py|js|mjs|cjs|vbs)$/i.test(params.filePath))
    ) {
      return "SCRIPT";
    }

    return "BASH";
  }

  // 5. Fallback
  return "TOOL";
}

const DIFF_BODY_KEYS = new Set([
  "old_string",
  "new_string",
  "content",
  "Content",
  "Target",
  "Replacement",
  "patch",
]);

function sanitizeToolInputValue(val: any, key: string, hasDiff: boolean, depth = 0): any {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "string") {
    if (hasDiff && DIFF_BODY_KEYS.has(key) && val.length > 180) {
      const lineCount = val.split(/\r?\n/).length;
      return `<${lineCount} line${lineCount === 1 ? "" : "s"}, ${val.length} chars — see diff below>`;
    }
    if (val.length > 4000) {
      return val.slice(0, 3997) + "...";
    }
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  if (depth > 4) {
    return "[...]";
  }
  if (Array.isArray(val)) {
    const sliced = val.slice(0, 30).map(item => sanitizeToolInputValue(item, key, hasDiff, depth + 1));
    if (val.length > 30) {
      sliced.push(`... (+${val.length - 30} more)`);
    }
    return sliced;
  }
  if (typeof val === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v === undefined) continue;
      out[k] = sanitizeToolInputValue(v, k, hasDiff, depth + 1);
    }
    return out;
  }
  return String(val);
}

/**
 * Formats structured tool call arguments as pretty JSON for the Activity Log expanded view.
 */
export function serializeToolCallInput(
  toolName: string,
  input: any,
  options?: { hasDiff?: boolean; omitCommandKeys?: boolean }
): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      return serializeToolCallInput(toolName, parsed, options);
    } catch {
      return trimmed.length > 4000 ? trimmed.slice(0, 3997) + "..." : trimmed;
    }
  }
  if (typeof input !== "object") {
    return String(input);
  }
  const hasDiff = Boolean(options?.hasDiff);
  const omitCmd = Boolean(options?.omitCommandKeys);
  const CMD_KEYS = new Set(["command", "CommandLine", "cmd"]);
  const cleaned: Record<string, any> = {};
  let count = 0;
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null || v === "") continue;
    if (omitCmd && CMD_KEYS.has(k)) continue;
    cleaned[k] = sanitizeToolInputValue(v, k, hasDiff, 0);
    count++;
  }
  if (count === 0) return undefined;
  try {
    return JSON.stringify(cleaned, null, 2);
  } catch {
    return undefined;
  }
}

/**
 * Builds a high-signal 1-line summary for search tools (Grep, Glob, grep_search, find_by_name, etc.)
 * so both the search pattern/query AND scope path/glob are visible without shadowing each other.
 */
export function formatSearchTargetSummary(
  toolName: string,
  input: Record<string, any> | undefined
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const n = (toolName || "").toLowerCase();
  const pattern =
    input.pattern ??
    input.Pattern ??
    input.Query ??
    input.query ??
    (Array.isArray(input.queries) ? input.queries.join(", ") : undefined);
  const scopePath =
    input.path ?? input.SearchPath ?? input.SearchDirectory ?? input.Directory ?? input.file_path;
  const glob = input.glob ?? input.Includes ?? (Array.isArray(input.Extensions) ? input.Extensions.join(",") : undefined);

  const patStr = typeof pattern === "string" ? pattern.trim() : "";
  const pathStr = typeof scopePath === "string" ? scopePath.trim() : "";
  const globStr = typeof glob === "string" ? glob.trim() : Array.isArray(glob) ? glob.join(",") : "";

  if (n === "glob" || n === "find_by_name") {
    if (patStr && pathStr) return `${patStr} in ${pathStr}`;
    if (patStr) return patStr;
    if (pathStr) return pathStr;
  }

  if (patStr && pathStr) {
    const quoted = patStr.length > 48 ? `"${patStr.slice(0, 45)}…"` : `"${patStr}"`;
    return globStr ? `${quoted} in ${pathStr} (${globStr})` : `${quoted} in ${pathStr}`;
  }
  if (patStr) {
    const quoted = patStr.length > 64 ? `"${patStr.slice(0, 61)}…"` : `"${patStr}"`;
    return globStr ? `${quoted} (${globStr})` : quoted;
  }
  if (pathStr) return pathStr;
  return undefined;
}

export function computeEditLineDelta(
  oldText?: string,
  newText?: string
): { linesAdded: number; linesRemoved: number } | undefined {
  if (typeof oldText !== "string" && typeof newText !== "string") {
    return undefined;
  }
  const oldStr = typeof oldText === "string" ? oldText : "";
  const newStr = typeof newText === "string" ? newText : "";

  if (!oldStr && newStr) {
    const newLines = newStr.split(/\r?\n/);
    return { linesAdded: newLines.length, linesRemoved: 0 };
  }
  if (oldStr && !newStr) {
    const oldLines = oldStr.split(/\r?\n/);
    return { linesAdded: 0, linesRemoved: oldLines.length };
  }
  if (!oldStr && !newStr) {
    return { linesAdded: 0, linesRemoved: 0 };
  }

  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const linesRemoved = Math.max(0, oldEnd - start + 1);
  const linesAdded = Math.max(0, newEnd - start + 1);

  return { linesAdded, linesRemoved };
}

export function computePatchLineDelta(
  patchText?: string
): { linesAdded: number; linesRemoved: number; firstFile?: string } | undefined {
  if (typeof patchText !== "string" || !patchText.trim()) {
    return undefined;
  }

  const lines = patchText.split(/\r?\n/);
  let linesAdded = 0;
  let linesRemoved = 0;
  let firstFile: string | undefined;

  for (const line of lines) {
    if (!firstFile) {
      const starMatch = line.match(/^\*\*\*\s+(?:Update File|Add File|Delete File):\s*(\S+)/i);
      if (starMatch && starMatch[1]) {
        firstFile = starMatch[1].trim();
      } else {
        const plusFile = line.match(/^\+\+\+\s+(?:b\/)?(\S+)/);
        if (plusFile && plusFile[1] && plusFile[1] !== "/dev/null") {
          firstFile = plusFile[1].trim();
        } else {
          const minusFile = line.match(/^---\s+(?:a\/)?(\S+)/);
          if (minusFile && minusFile[1] && minusFile[1] !== "/dev/null") {
            firstFile = minusFile[1].trim();
          }
        }
      }
    }

    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("***")) {
      continue;
    }
    if (line.startsWith("+")) {
      linesAdded++;
    } else if (line.startsWith("-")) {
      linesRemoved++;
    }
  }

  return { linesAdded, linesRemoved, firstFile };
}

export function buildCompactDiffPreview(
  oldText?: string,
  newText?: string,
  maxLines = 80
): string | undefined {
  if (oldText === undefined && newText === undefined) return undefined;
  const oldStr = typeof oldText === "string" ? oldText.replace(/\r\n/g, "\n") : "";
  const newStr = typeof newText === "string" ? newText.replace(/\r\n/g, "\n") : "";

  if (!oldStr && !newStr) return undefined;
  if (oldStr === newStr) return undefined;

  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];

  // Pure addition (e.g. Write new file)
  if (oldLines.length === 0) {
    const formatted = newLines.map(l => `+ ${l}`);
    if (formatted.length > maxLines) {
      const remaining = formatted.length - maxLines;
      return formatted.slice(0, maxLines).join("\n") + `\n… (+${remaining} more lines)`;
    }
    return formatted.join("\n");
  }

  // Pure deletion
  if (newLines.length === 0) {
    const formatted = oldLines.map(l => `- ${l}`);
    if (formatted.length > maxLines) {
      const remaining = formatted.length - maxLines;
      return formatted.slice(0, maxLines).join("\n") + `\n… (+${remaining} more lines)`;
    }
    return formatted.join("\n");
  }

  // Find common leading prefix lines
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  // Find common trailing suffix lines
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const resultLines: string[] = [];

  // Up to 2 context lines before change
  const leadStart = Math.max(0, start - 2);
  for (let i = leadStart; i < start; i++) {
    resultLines.push(`  ${oldLines[i]}`);
  }

  // Removed lines
  for (let i = start; i <= oldEnd; i++) {
    resultLines.push(`- ${oldLines[i]}`);
  }

  // Added lines
  for (let i = start; i <= newEnd; i++) {
    resultLines.push(`+ ${newLines[i]}`);
  }

  // Up to 2 context lines after change
  const trailEnd = Math.min(oldLines.length - 1, oldEnd + 2);
  for (let i = oldEnd + 1; i <= trailEnd; i++) {
    resultLines.push(`  ${oldLines[i]}`);
  }

  if (resultLines.length === 0) return undefined;

  if (resultLines.length > maxLines) {
    const remaining = resultLines.length - maxLines;
    return resultLines.slice(0, maxLines).join("\n") + `\n… (+${remaining} more lines)`;
  }

  return resultLines.join("\n");
}

export function formatPatchPreview(patchText?: string, maxLines = 80): string | undefined {
  if (typeof patchText !== "string" || !patchText.trim()) return undefined;
  const raw = patchText.replace(/\r\n/g, "\n").trim();
  const allLines = raw.split("\n");

  const formatted: string[] = [];
  for (const line of allLines) {
    if (
      line.startsWith("+") ||
      line.startsWith("-") ||
      line.startsWith(" ") ||
      line.startsWith("@@") ||
      line.startsWith("***")
    ) {
      formatted.push(line);
    } else {
      formatted.push(`  ${line}`);
    }
  }

  if (formatted.length === 0) return undefined;

  if (formatted.length > maxLines) {
    const remaining = formatted.length - maxLines;
    return formatted.slice(0, maxLines).join("\n") + `\n… (+${remaining} more lines)`;
  }

  return formatted.join("\n");
}

export type StellarClass =
  | "white_dwarf"
  | "yellow_star"
  | "orange_giant"
  | "red_giant"
  | "red_supergiant";

export interface StellarProfile {
  stellarClass: StellarClass;
  label: string;
  baseRadius: number;
  coreCenter: string;
  coreMid: string;
  coreLimb: string;
  rimColor: string;
  coronaGlow: string;
  nebulaGlow: string;
  convective: boolean;
}

export function computeStellarProfile(
  totalSubagents: number,
  totalToolCalls = 0
): StellarProfile {
  if (totalSubagents <= 0) {
    return {
      stellarClass: "white_dwarf",
      label: "White Dwarf",
      baseRadius: 19.5 + Math.min(2.5, Math.log2(1 + totalToolCalls) * 0.4),
      coreCenter: "#ffffff",
      coreMid: "#dbeafe",
      coreLimb: "#60a5fa",
      rimColor: "#f0f9ff",
      coronaGlow: "rgba(186, 230, 253, 0.36)",
      nebulaGlow: "rgba(147, 197, 253, 0.24)",
      convective: false,
    };
  }

  if (totalSubagents <= 2) {
    return {
      stellarClass: "yellow_star",
      label: "Yellow Star",
      baseRadius:
        26 +
        (totalSubagents - 1) * 3 +
        Math.min(2.5, Math.log2(1 + totalToolCalls) * 0.35),
      coreCenter: "#fffef5",
      coreMid: "#fde047",
      coreLimb: "#d97706",
      rimColor: "#fef08a",
      coronaGlow: "rgba(251, 191, 36, 0.34)",
      nebulaGlow: "rgba(245, 158, 11, 0.24)",
      convective: false,
    };
  }

  if (totalSubagents <= 5) {
    return {
      stellarClass: "orange_giant",
      label: "Orange Giant",
      baseRadius: 34 + (totalSubagents - 3) * 2.2,
      coreCenter: "#fff7ed",
      coreMid: "#fb923c",
      coreLimb: "#c2410c",
      rimColor: "#fed7aa",
      coronaGlow: "rgba(249, 115, 22, 0.36)",
      nebulaGlow: "rgba(234, 88, 12, 0.26)",
      convective: true,
    };
  }

  if (totalSubagents <= 11) {
    return {
      stellarClass: "red_giant",
      label: "Red Giant",
      baseRadius: 42 + (totalSubagents - 6) * 1.4,
      coreCenter: "#ffe4e6",
      coreMid: "#f87171",
      coreLimb: "#991b1b",
      rimColor: "#fca5a5",
      coronaGlow: "rgba(239, 68, 68, 0.40)",
      nebulaGlow: "rgba(220, 38, 38, 0.30)",
      convective: true,
    };
  }

  return {
    stellarClass: "red_supergiant",
    label: "Red Supergiant",
    baseRadius: Math.min(58, 51 + Math.log2(totalSubagents - 10) * 2.2),
    coreCenter: "#fff1f2",
    coreMid: "#ef4444",
    coreLimb: "#7f1d1d",
    rimColor: "#fecdd3",
    coronaGlow: "rgba(220, 38, 38, 0.46)",
    nebulaGlow: "rgba(185, 28, 28, 0.34)",
    convective: true,
  };
}

export type AsteroidClass =
  | "meteoroid"
  | "chondrite"
  | "asteroid"
  | "planetesimal"
  | "planetoid";

export interface AsteroidProfile {
  asteroidClass: AsteroidClass;
  label: string;
  baseRadius: number;
  facets: number;
  craters: number;
  effectiveTurns: number;
}

export function getEffectiveTurnCount(
  turnCount = 0,
  totalToolCalls = 0
): number {
  const turns = Number.isFinite(turnCount) ? Math.max(0, Math.floor(turnCount)) : 0;
  const tools = Number.isFinite(totalToolCalls) ? Math.max(0, Math.floor(totalToolCalls)) : 0;
  return turns > 0 ? turns : tools;
}

export function computeAsteroidProfile(
  turnCount = 0,
  totalToolCalls = 0
): AsteroidProfile {
  const effectiveTurns = getEffectiveTurnCount(turnCount, totalToolCalls);

  if (effectiveTurns <= 1) {
    return {
      asteroidClass: "meteoroid",
      label: "Meteoroid",
      baseRadius: 4.8 + effectiveTurns * 0.5,
      facets: 6,
      craters: 1,
      effectiveTurns,
    };
  }

  if (effectiveTurns <= 4) {
    return {
      asteroidClass: "chondrite",
      label: "Chondrite",
      baseRadius: 5.8 + (effectiveTurns - 2) * 0.6,
      facets: 7,
      craters: 2,
      effectiveTurns,
    };
  }

  if (effectiveTurns <= 11) {
    return {
      asteroidClass: "asteroid",
      label: "Asteroid",
      baseRadius: 7.6 + (effectiveTurns - 5) * 0.34,
      facets: 8,
      craters: 2,
      effectiveTurns,
    };
  }

  if (effectiveTurns <= 24) {
    return {
      asteroidClass: "planetesimal",
      label: "Planetesimal",
      baseRadius: 10.1 + (effectiveTurns - 12) * 0.14,
      facets: 9,
      craters: 3,
      effectiveTurns,
    };
  }

  return {
    asteroidClass: "planetoid",
    label: "Dwarf Planetoid",
    baseRadius: Math.min(13.8, 12.1 + Math.log2(effectiveTurns - 23) * 0.42),
    facets: 10,
    craters: 3,
    effectiveTurns,
  };
}

export interface StarSleepState {
  isResting: boolean;
  isAsleep: boolean;
  sleepDepth: number;
  idleMs: number;
}

export function computeStarSleepState(
  snap: Pick<AgentNodeSnapshot, "isSubagent" | "status" | "lastActiveAt">,
  now = Date.now()
): StarSleepState {
  if (snap.isSubagent || snap.status !== "idle") {
    return { isResting: false, isAsleep: false, sleepDepth: 0, idleMs: 0 };
  }

  const idleMs = Math.max(0, now - snap.lastActiveAt);
  const SLEEP_ONSET_MS = 90_000;
  const SLEEP_FULL_MS = 180_000;

  if (idleMs < SLEEP_ONSET_MS) {
    return { isResting: true, isAsleep: false, sleepDepth: 0, idleMs };
  }

  const sleepDepth = Math.min(
    1,
    (idleMs - SLEEP_ONSET_MS) / (SLEEP_FULL_MS - SLEEP_ONSET_MS)
  );

  return {
    isResting: true,
    isAsleep: true,
    sleepDepth: Math.max(0.2, sleepDepth),
    idleMs,
  };
}

export interface AsteroidFieldBand {
  innerRadius: number;
  outerRadius: number;
  bandWidth: number;
  midRadius: number;
}

export function getInnerBeltOrbitRadius(
  parentRadius: number,
  completedCount = 0
): number {
  return computeAsteroidFieldBand(parentRadius, 0, completedCount).innerRadius;
}

export function getPlanetRingAssignment(
  slotIndex: number,
  totalActiveSiblings: number
): { ringIndex: number; indexInRing: number; countInRing: number } {
  const total = Math.max(1, totalActiveSiblings);
  const slot = Math.max(0, slotIndex);

  if (total <= 8) {
    return {
      ringIndex: 0,
      indexInRing: Math.min(slot, total - 1),
      countInRing: total,
    };
  }

  if (total <= 20) {
    const count0 = 8;
    const count1 = total - 8;
    if (slot < 8) {
      return { ringIndex: 0, indexInRing: slot, countInRing: count0 };
    }
    return {
      ringIndex: 1,
      indexInRing: Math.min(slot - 8, count1 - 1),
      countInRing: count1,
    };
  }

  if (total <= 36) {
    const count0 = 8;
    const count1 = 12;
    const count2 = total - 20;
    if (slot < 8) {
      return { ringIndex: 0, indexInRing: slot, countInRing: count0 };
    }
    if (slot < 20) {
      return { ringIndex: 1, indexInRing: slot - 8, countInRing: count1 };
    }
    return {
      ringIndex: 2,
      indexInRing: Math.min(slot - 20, count2 - 1),
      countInRing: count2,
    };
  }

  // Unlimited concentric rings for massive active swarms (> 36 active subagents):
  // Ring 0 = 8, Ring 1 = 12, Ring 2 = 16, Ring k >= 3 holds (16 + (k - 2) * 4)
  if (slot < 8) {
    return { ringIndex: 0, indexInRing: slot, countInRing: 8 };
  }
  if (slot < 20) {
    return { ringIndex: 1, indexInRing: slot - 8, countInRing: 12 };
  }
  if (slot < 36) {
    return { ringIndex: 2, indexInRing: slot - 20, countInRing: 16 };
  }

  let ringIdx = 3;
  let offset = 36;
  while (true) {
    const cap = 16 + (ringIdx - 2) * 4;
    if (slot < offset + cap || total <= offset + cap) {
      const countInRing = Math.min(cap, Math.max(1, total - offset));
      return {
        ringIndex: ringIdx,
        indexInRing: Math.min(slot - offset, countInRing - 1),
        countInRing,
      };
    }
    offset += cap;
    ringIdx++;
  }
}

export function getPlanetOrbitRadiusForRing(
  parentRadius: number,
  ringIndex: number,
  countInRing: number
): number {
  const baseRingRadius =
    parentRadius + Math.max(122, Math.round(parentRadius * 1.95)) + 98 * ringIndex;
  const minRadiusForCircumference = (countInRing * 72) / (Math.PI * 2);
  return Math.max(baseRingRadius, minRadiusForCircumference);
}

export function getMaxOuterPlanetOrbitRadius(
  parentRadius: number,
  activeSiblingCount: number
): number {
  if (activeSiblingCount <= 0) {
    return parentRadius + Math.max(122, Math.round(parentRadius * 1.95));
  }
  const lastAssign = getPlanetRingAssignment(
    activeSiblingCount - 1,
    activeSiblingCount
  );
  return getPlanetOrbitRadiusForRing(
    parentRadius,
    lastAssign.ringIndex,
    lastAssign.countInRing
  );
}

export function getOuterPlanetOrbitRadius(
  parentRadius: number,
  activeSiblingCount: number
): number {
  return getMaxOuterPlanetOrbitRadius(parentRadius, activeSiblingCount);
}

export function computeAsteroidFieldBand(
  parentRadius: number,
  activeSiblingCount = 0,
  completedCount = 0
): AsteroidFieldBand {
  const clearanceBase =
    activeSiblingCount > 0
      ? getMaxOuterPlanetOrbitRadius(parentRadius, activeSiblingCount) + 98
      : parentRadius + Math.max(185, Math.round(parentRadius * 2.85));

  const count = Math.max(0, completedCount);
  const bandWidth =
    count <= 1
      ? 28
      : Math.min(220, Math.round(36 + Math.sqrt(count) * 13.5 + Math.floor(count / 12) * 16));

  const effectiveLanes = Math.max(1, bandWidth / 20);
  const minMidRadius =
    count > 0 ? ((count / effectiveLanes) * 33) / (Math.PI * 2) : 0;
  const innerRadius = Math.max(clearanceBase, Math.round(minMidRadius - bandWidth * 0.5));
  const outerRadius = innerRadius + bandWidth;
  return {
    innerRadius,
    outerRadius,
    bandWidth,
    midRadius: innerRadius + bandWidth * 0.5,
  };
}

const GOLDEN_ANGLE_RAD = 2.399963229728653;
const GOLDEN_RATIO_FRAC = 0.618033988749895;

export function computeAsteroidSlotPolar(
  slotIndex: number,
  _completedCount: number,
  band: AsteroidFieldBand,
  asteroidSeed: number,
  globalTime: number
): { radius: number; angle: number } {
  const seedNorm1 = ((asteroidSeed >>> 0) % 997) / 997;
  const seedNorm2 = (((asteroidSeed >>> 10) >>> 0) % 991) / 991;
  const u = (slotIndex * GOLDEN_RATIO_FRAC + 0.35 + seedNorm1 * 0.28) % 1;
  const baseRadius = band.innerRadius + u * band.bandWidth;
  const ecc = 1 + 0.026 * Math.sin(globalTime * 0.045 + seedNorm1 * Math.PI * 2);
  const angularSpeed = 0.0095 / Math.sqrt(Math.max(0.6, baseRadius / 175));
  const baseAngle = slotIndex * GOLDEN_ANGLE_RAD + (seedNorm2 - 0.5) * 0.22;
  return {
    radius: baseRadius * ecc,
    angle: baseAngle + globalTime * angularSpeed,
  };
}

export interface ConstellationRootTarget {
  id: string;
  targetRadius?: number;
  radius?: number;
  activeSubsCount?: number;
  totalCompletedSubs?: number;
  totalSubsCount?: number;
  status?: AgentStatus;
  isWaiting?: boolean;
}

export function getSystemReach(r: ConstellationRootTarget): number {
  const tr = r.targetRadius ?? r.radius ?? 24;
  const activeCount = r.activeSubsCount ?? 0;
  const completedCount = r.totalCompletedSubs ?? 0;
  if (completedCount > 0) {
    return computeAsteroidFieldBand(tr, activeCount, completedCount).outerRadius + 68;
  }
  if (activeCount > 0) {
    return getMaxOuterPlanetOrbitRadius(tr, activeCount) + 74;
  }
  return tr + 90;
}

export function computeSpotlightHorizonY(
  waitingAnchors: Array<{ y: number; reach?: number }>,
  regularAnchors: Array<{ y: number; reach?: number }>
): number | null {
  if (!waitingAnchors.length || !regularAnchors.length) return null;
  const maxWaitBottom = Math.max(...waitingAnchors.map(a => a.y + (a.reach ?? 0)));
  const minRegTop = Math.min(...regularAnchors.map(a => a.y - (a.reach ?? 0)));
  return (maxWaitBottom + minRegTop) * 0.5;
}

function layoutGridRelative(
  subRoots: ConstellationRootTarget[],
  isHorizontalLayout: boolean,
  aspect: number
): Array<{ id: string; x: number; y: number; reach: number }> {
  const n = subRoots.length;
  if (n === 0) return [];
  if (n === 1) {
    return [{ id: subRoots[0].id, x: 0, y: 0, reach: getSystemReach(subRoots[0]) }];
  }

  let cols: number;
  if (isHorizontalLayout) {
    cols = Math.ceil(Math.sqrt(n * aspect));
  } else {
    cols = Math.max(1, Math.min(2, Math.round(Math.sqrt(n * aspect))));
  }
  cols = Math.max(1, Math.min(n, cols));
  const rows = Math.ceil(n / cols);

  const colMaxReach: number[] = new Array(cols).fill(95);
  const rowMaxReach: number[] = new Array(rows).fill(95);

  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const reach = getSystemReach(subRoots[i]);
    colMaxReach[col] = Math.max(colMaxReach[col], reach);
    rowMaxReach[row] = Math.max(rowMaxReach[row], reach);
  }

  const GAP = 165;

  const colXRel: number[] = new Array(cols).fill(0);
  for (let c = 1; c < cols; c++) {
    colXRel[c] = colXRel[c - 1] + colMaxReach[c - 1] + colMaxReach[c] + GAP;
  }
  const totalSpanX = colXRel[cols - 1];

  const rowYRel: number[] = new Array(rows).fill(0);
  for (let r = 1; r < rows; r++) {
    rowYRel[r] = rowYRel[r - 1] + rowMaxReach[r - 1] + rowMaxReach[r] + GAP;
  }
  const totalSpanY = rowYRel[rows - 1];

  const result: Array<{ id: string; x: number; y: number; reach: number }> = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);

    const staggerX =
      cols > 1 ? (row % 2 === 1 ? 26 : -18) : row % 2 === 1 ? 36 : -36;
    const staggerY =
      rows > 1 ? (col % 2 === 1 ? -22 : 16) : col % 2 === 1 ? 32 : -32;

    result.push({
      id: subRoots[i].id,
      x: colXRel[col] - totalSpanX * 0.5 + staggerX,
      y: rowYRel[row] - totalSpanY * 0.5 + staggerY,
      reach: getSystemReach(subRoots[i]),
    });
  }

  return result;
}

export function computeConstellationAnchors(
  roots: ConstellationRootTarget[],
  width: number,
  height: number,
  isHorizontalLayout: boolean
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const n = roots.length;
  if (n === 0) return result;
  if (n === 1) {
    result.set(roots[0].id, { x: width * 0.5, y: height * 0.5 });
    return result;
  }

  const isWaiting = (r: ConstellationRootTarget) =>
    Boolean(r.isWaiting === true || r.status === "waiting_on_user");

  const waitingRoots = roots.filter(isWaiting);
  const regularRoots = roots.filter(r => !isWaiting(r));

  // Case 1: No waiting stars -> classic spacious 2D grid
  if (waitingRoots.length === 0) {
    const aspect = width / Math.max(1, height);
    const grid = layoutGridRelative(roots, isHorizontalLayout, aspect);
    for (const p of grid) {
      result.set(p.id, {
        x: width * 0.5 + p.x,
        y: height * 0.5 + p.y,
      });
    }
    return result;
  }

  // Case 2: All stars are waiting -> horizontal row centered at (width * 0.5, height * 0.38)
  if (regularRoots.length === 0) {
    if (waitingRoots.length === 1) {
      result.set(waitingRoots[0].id, { x: width * 0.5, y: height * 0.38 });
      return result;
    }
    const waitXRel: number[] = new Array(waitingRoots.length).fill(0);
    for (let i = 1; i < waitingRoots.length; i++) {
      const reachPrev = getSystemReach(waitingRoots[i - 1]);
      const reachCurr = getSystemReach(waitingRoots[i]);
      waitXRel[i] = waitXRel[i - 1] + reachPrev + reachCurr + 140;
    }
    const totalSpanX = waitXRel[waitingRoots.length - 1];
    for (let i = 0; i < waitingRoots.length; i++) {
      result.set(waitingRoots[i].id, {
        x: width * 0.5 - totalSpanX * 0.5 + waitXRel[i],
        y: height * 0.38,
      });
    }
    return result;
  }

  // Case 3: Both waiting and regular stars exist
  // Place waiting stars horizontally at y = 0
  const waitXRel: number[] = new Array(waitingRoots.length).fill(0);
  for (let i = 1; i < waitingRoots.length; i++) {
    const reachPrev = getSystemReach(waitingRoots[i - 1]);
    const reachCurr = getSystemReach(waitingRoots[i]);
    waitXRel[i] = waitXRel[i - 1] + reachPrev + reachCurr + 140;
  }
  const waitSpanX = waitXRel[waitingRoots.length - 1];
  const waitPositions = waitingRoots.map((r, i) => ({
    id: r.id,
    x: waitXRel[i] - waitSpanX * 0.5,
    y: 0,
    reach: getSystemReach(r),
  }));

  const maxWaitBottom = Math.max(...waitPositions.map(p => p.y + p.reach));
  const minWaitTop = Math.min(...waitPositions.map(p => p.y - p.reach));

  const aspect = width / Math.max(1, height);
  const regPositions = layoutGridRelative(regularRoots, isHorizontalLayout, aspect);
  const minRegTop = Math.min(...regPositions.map(p => p.y - p.reach));
  const maxRegBottom = Math.max(...regPositions.map(p => p.y + p.reach));

  const VERTICAL_GAP = 170; // Guaranteed >= 165px
  const regShiftY = (maxWaitBottom + VERTICAL_GAP) - minRegTop;

  const combinedMinY = minWaitTop;
  const combinedMaxY = maxRegBottom + regShiftY;
  const combinedCenterY = (combinedMinY + combinedMaxY) * 0.5;
  const offsetY = height * 0.5 - combinedCenterY;

  for (const p of waitPositions) {
    result.set(p.id, {
      x: width * 0.5 + p.x,
      y: p.y + offsetY,
    });
  }

  for (const p of regPositions) {
    result.set(p.id, {
      x: width * 0.5 + p.x,
      y: p.y + regShiftY + offsetY,
    });
  }

  return result;
}

const STANDARD_CONTEXT_TIERS = [
  131_072,
  200_000,
  258_400,
  400_000,
  475_000,
  1_000_000,
  2_000_000,
] as const;

export function inferContextWindowMax(
  harness: HarnessKind,
  model?: string,
  explicitMax?: number,
  observedContextTokens?: number
): number {
  let base: number;

  if (explicitMax !== undefined && Number.isFinite(explicitMax) && explicitMax >= 8_000) {
    base = Math.round(explicitMax);
  } else {
    const m = (model || "").toLowerCase();

    // 1. Explicit [1m] / 1m / 2m tag in model string
    if (m.includes("[2m]") || /(?:^|[\-_\[\s])2m(?:[\-_\]\s]|$)/i.test(m)) {
      base = 2_000_000;
    } else if (m.includes("[1m]") || /(?:^|[\-_\[\s])1m(?:[\-_\]\s]|$)/i.test(m)) {
      base = 1_000_000;
    }
    // 2. Gemini / Antigravity models (1M context window; Antigravity's transcript.jsonl often leaves model unset)
    else if (m.includes("gemini") || harness === "antigravity") {
      base = 1_000_000;
    }
    // 3. Claude models (whether harness === "claude" or "strata")
    else if (
      m.includes("opus-4-6") ||
      m.includes("sonnet-4-6") ||
      m.includes("opus-4-7") ||
      m.includes("sonnet-4-7")
    ) {
      base = 400_000;
    } else if (
      m.includes("haiku") ||
      m.includes("claude-3") ||
      m.includes("opus-4") ||
      m.includes("sonnet-4") ||
      m.includes("3-5") ||
      m.includes("3-7") ||
      m.includes("4-0") ||
      m.includes("4-1") ||
      m.includes("4-5")
    ) {
      base = 200_000;
    } else if (harness === "claude" || m.includes("claude")) {
      base = 400_000;
    }
    // 4. OpenAI / Codex models (whether harness === "codex" or "strata")
    else if (m.includes("gpt-4.1")) {
      base = 1_000_000;
    } else if (
      m.includes("codex") ||
      m.includes("o3") ||
      m.includes("o4") ||
      harness === "codex"
    ) {
      base = 258_400;
    } else if (m.includes("gpt-5") || m.includes("gpt-4")) {
      base = 400_000;
    }
    // 5. Open-weights / Strata local models
    else if (
      m.includes("qwen") ||
      m.includes("llama") ||
      m.includes("deepseek") ||
      m.includes("mistral")
    ) {
      base = 131_072;
    } else {
      base = 200_000;
    }
  }

  // Dynamic Ceiling Promotion (observedContextTokens)
  if (
    observedContextTokens !== undefined &&
    Number.isFinite(observedContextTokens) &&
    observedContextTokens > base
  ) {
    const nextTier = STANDARD_CONTEXT_TIERS.find(tier => tier >= observedContextTokens);
    if (nextTier !== undefined) {
      base = nextTier;
    } else {
      base = Math.ceil(observedContextTokens / 100_000) * 100_000;
    }
  }

  return base;
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 100_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

