import {
  ActivityLogEntry,
  ActivityLogKind,
  AgentNodeSnapshot,
  AppViewMode,
  DrawerSizePreset,
  EdgeAttachment,
  EdgeSide,
  FocusResult,
  GraphSnapshotPayload,
  HarnessKind,
  LivePulseEvent,
  OrbitBridgeAPI,
  ResizeEdge,
  SemanticTaskBadge,
  TimeWindowMode,
  WindowStateInfo,
  computeAsteroidProfile,
  computeStarSleepState,
  formatCompactTokens,
} from "../shared/types";
import { CameraTransform, OrbitCanvasRenderer } from "./canvasRenderer";
import {
  HARNESS_COLORS,
  PhysicsNode,
  SpringGraphEngine,
  matchesSearchQuery,
} from "./physics";
import { initSettingsView } from "./settingsView";

export { matchesSearchQuery };

declare global {
  interface Window {
    orbitBridge: OrbitBridgeAPI;
  }
}

const rootEl = document.getElementById("app-root")!;
const spineEl = document.getElementById("edge-spine")!;
const spineDotsEl = document.getElementById("spine-dots")!;
const spineCountEl = document.getElementById("spine-count")!;
const dragEdgeLabelEl = document.getElementById("drag-edge-label")!;
const workspaceBodyEl = document.getElementById("workspace-body")!;
const stageEl = document.getElementById("canvas-stage")!;
const splitResizerEl = document.getElementById("split-resizer")!;
const canvasEl = document.getElementById("orbit-canvas") as HTMLCanvasElement;
const hoverCardEl = document.getElementById("hover-card")!;
const focusToastEl = document.getElementById("focus-toast");
const summaryEl = document.getElementById("harness-summary")!;
const brandTitleEl = document.querySelector<HTMLElement>(".brand-title");
const brandGroupEl = document.querySelector<HTMLElement>(".brand-group");
const btnFit = document.getElementById("btn-fit")!;
const btnDockMode = document.getElementById("btn-dock-mode");
const btnAppMode = document.getElementById("btn-app-mode");
const btnFullscreen = document.getElementById("btn-fullscreen");
const btnSize = document.getElementById("btn-size");
const btnBurst = document.getElementById("btn-burst");
const btnClearSim = document.getElementById("btn-clear-sim")!;
const btnLog = document.getElementById("btn-log");
const btnPin = document.getElementById("btn-pin")!;
const btnSettings = document.getElementById("btn-settings");
const btnMenu = document.getElementById("btn-menu");
const settingsShellEl = document.getElementById("settings-shell");
const windowPills = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".win-pill")
);
const needsYouBarEl = document.getElementById("needs-you-bar") as HTMLDivElement | null;

// Instant View Mode Detection from URL query
const urlParams = new URLSearchParams(window.location.search);
const urlMode = urlParams.get("mode");
let currentViewMode: AppViewMode = urlMode === "dock" ? "dock" : "window";
rootEl.dataset.viewMode = currentViewMode;
document.documentElement.dataset.viewMode = currentViewMode;

let currentWindowState: WindowStateInfo = {
  viewMode: currentViewMode,
  isMaximized: false,
  isFullScreen: false,
  alwaysOnTop: false,
};

// Trailing Activity Log elements
const activityLogPanelEl = document.getElementById("activity-log-panel")!;
const logScopePillEl = document.getElementById("log-scope-pill")!;
const btnLogScopeAll = document.getElementById("btn-log-scope-all")!;
const logWrapBtn = document.getElementById("log-wrap-btn");
const btnLogExpand = document.getElementById("btn-log-expand")!;
const btnLogClose = document.getElementById("btn-log-close")!;
const logCategoryBarEl = document.getElementById("log-category-bar");
const logSearchInput = document.getElementById("log-search-input") as HTMLInputElement | null;
const logSearchClear = document.getElementById("log-search-clear") as HTMLButtonElement | null;
const logBodyEl = document.getElementById("log-body")!;
const logListEl = document.getElementById("log-list")!;
const logEmptyEl = document.getElementById("log-empty")!;
const logJumpLiveBtn = document.getElementById("log-jump-live")!;

export type LogFilterCategory =
  | "all"
  | "code"
  | "verify"
  | "git"
  | "explore"
  | "agents"
  | "errors";

export const BADGE_COLORS: Record<SemanticTaskBadge, string> = {
  TEST: "#34d399",
  BUILD: "#fb923c",
  GIT: "#f97316",
  PR: "#e879f9",
  SEARCH: "#38bdf8",
  READ: "#60a5fa",
  EDIT: "#fbbf24",
  WRITE: "#a3e635",
  PLAN: "#a78bfa",
  ASK: "#f59e0b",
  SPAWN: "#c084fc",
  DONE: "#94a3b8",
  MSG: "#2dd4bf",
  MCP: "#f472b6",
  WEB: "#c084fc",
  PKG: "#22d3ee",
  SCRIPT: "#10b981",
  BASH: "#4ade80",
  SKILL: "#d8b4fe",
  PROMPT: "#7dd3fc",
  REPLY: "#cbd5e1",
  TOOL: "#94a3b8",
};

const engine = new SpringGraphEngine();
const renderer = new OrbitCanvasRenderer(canvasEl);

let currentAttachment: EdgeAttachment = {
  displayId: 0,
  edge: "right",
  offsetRatio: 0.5,
  isExpanded: false,
  isPinned: false,
  isDragging: false,
  sizePreset: "compact",
  drawerWidth: 410,
  drawerHeight: 620,
};

const cam: CameraTransform = { panX: 0, panY: 0, zoom: 1.0 };
const targetCam: CameraTransform = { panX: 0, panY: 0, zoom: 1.0 };
let isCameraAnimating = false;
let currentTimeWindow: TimeWindowMode | null = null;
let stageW = 380;
let stageH = 520;

let selectedHarness: HarnessKind | null = null;
let latestSnapshot: GraphSnapshotPayload | null = null;

// Activity Log state
const MAX_CLIENT_LOG_ENTRIES = 1500;
let isActivityLogOpen = false;
let isActivityLogExpanded = false;
let isWrapEnabled = false;
let isWrapManuallyToggled = false;
let activeLogCategory: LogFilterCategory = "all";
let activeLogSearchQuery = "";
const expandedRowIds = new Set<string>();
let currentLogScopeNodeId: string | null = null;
let activityLogEntries: ActivityLogEntry[] = [];
const activityLogById = new Map<string, ActivityLogEntry>();
const detailLoadingIds = new Set<string>();
const copyTextByEntryId = new Map<string, string>();
let lastAppliedLogSeq: number | undefined = undefined;
let logRenderRafId: number | null = null;
let userHasScrolledLog = false;
let logVisibleLimit = 250;

let lastHoverRenderKey = "";
let cachedHoverCardH = 160;

function hideHoverCard(): void {
  hoverCardEl.classList.add("hidden");
  lastHoverRenderKey = "";
}

let hoveredNode: PhysicsNode | null = null;
let draggedNode: PhysicsNode | null = null;
let pointerDownNode: PhysicsNode | null = null;
let pointerDownCallout: PhysicsNode | null = null;
let pointerDownX = 0;
let pointerDownY = 0;
let pointerDownTime = 0;
let pointerMoved = false;

let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let camStartX = 0;
let camStartY = 0;
let cameraFocusNodeId: string | null = null;
let spineFlashTimer: number | null = null;
let focusToastTimer: number | null = null;

function showFocusToast(msg: string, isError = false): void {
  if (!focusToastEl) return;
  focusToastEl.textContent = msg;
  focusToastEl.classList.toggle("error", isError);
  focusToastEl.classList.remove("hidden");
  if (focusToastTimer !== null) {
    window.clearTimeout(focusToastTimer);
  }
  focusToastTimer = window.setTimeout(() => {
    focusToastEl.classList.add("hidden");
    focusToastTimer = null;
  }, 1500);
}

function applyWindowState(state: WindowStateInfo): void {
  currentWindowState = state;
  currentViewMode = state.viewMode;
  rootEl.dataset.viewMode = state.viewMode;
  document.documentElement.dataset.viewMode = state.viewMode;
  rootEl.dataset.fullscreen = String(state.isFullScreen);
  rootEl.dataset.maximized = String(state.isMaximized);

  if (brandTitleEl) {
    brandTitleEl.textContent = state.viewMode === "window" ? "Agent Orbit" : "Orbit";
  }
  if (brandGroupEl) {
    brandGroupEl.title = state.viewMode === "window" ? "Agent Orbit" : "Drag";
  }

  if (btnFullscreen) {
    btnFullscreen.classList.toggle("active", state.isFullScreen);
    btnFullscreen.title = state.isFullScreen
      ? "Exit Fullscreen (F11)"
      : "Fullscreen (F11)";
  }

  if (state.viewMode === "window") {
    btnPin.classList.toggle("active", state.alwaysOnTop);
    btnPin.title = state.alwaysOnTop ? "Unpin" : "Pin";
  } else {
    btnPin.classList.toggle("active", currentAttachment.isPinned);
    btnPin.title = currentAttachment.isPinned ? "Unpin" : "Pin";
  }

  updateStageDimensions();
  fitGraphToViewport(false);
}

function isSplitLayout(): boolean {
  const containerW = workspaceBodyEl ? workspaceBodyEl.clientWidth : window.innerWidth;
  return (containerW || window.innerWidth) >= 820;
}

function syncLayoutState(): void {
  const wide = isSplitLayout();
  workspaceBodyEl.classList.toggle("split-layout", wide);

  if (wide) {
    if (isActivityLogOpen) {
      activityLogPanelEl.classList.remove("hidden");
      if (isActivityLogExpanded) {
        workspaceBodyEl.classList.add("log-maximized");
        splitResizerEl.classList.add("hidden");
      } else {
        workspaceBodyEl.classList.remove("log-maximized");
        splitResizerEl.classList.remove("hidden");
      }
    } else {
      activityLogPanelEl.classList.add("hidden");
      splitResizerEl.classList.add("hidden");
      workspaceBodyEl.classList.remove("log-maximized");
    }
  } else {
    workspaceBodyEl.classList.remove("log-maximized");
    splitResizerEl.classList.add("hidden");
    activityLogPanelEl.classList.toggle("hidden", !isActivityLogOpen);
    activityLogPanelEl.classList.toggle("expanded", isActivityLogExpanded);
  }
}

let isResizingSplit = false;
let currentLogSplitWidthPx: number | null = null;

function initSplitResizer(): void {
  splitResizerEl.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    if (!isSplitLayout() || !isActivityLogOpen || isActivityLogExpanded) return;
    e.preventDefault();
    e.stopPropagation();

    isResizingSplit = true;
    splitResizerEl.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingSplit) return;
      const bodyRect = workspaceBodyEl.getBoundingClientRect();
      const containerW = bodyRect.width;
      const minW = 320;
      const maxW = Math.max(minW, Math.floor(containerW * 0.7));
      const targetW = Math.max(minW, Math.min(maxW, bodyRect.right - ev.clientX));
      currentLogSplitWidthPx = targetW;
      workspaceBodyEl.style.setProperty("--log-split-width", `${targetW}px`);
      updateStageDimensions();
      fitGraphToViewport(false);
    };

    const onMouseUp = () => {
      if (!isResizingSplit) return;
      isResizingSplit = false;
      splitResizerEl.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      updateStageDimensions();
      fitGraphToViewport(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });
}

function fitGraphToViewport(smooth = true): void {
  cameraFocusNodeId = null;
  const bbox = engine.getBoundingBox();
  const isLogPartiallyOpen =
    isActivityLogOpen && !isActivityLogExpanded && !isSplitLayout();
  const heightFactor = isLogPartiallyOpen ? 0.46 : 1.0;
  const yShift = isLogPartiallyOpen ? -stageH * 0.24 : 0;

  if (!bbox || engine.nodes.size === 0) {
    targetCam.panX = 0;
    targetCam.panY = yShift;
    targetCam.zoom = 1.0;
  } else {
    const roots = [...engine.nodes.values()].filter(n => !n.data.isSubagent);
    const padX = 32;
    const padY = isLogPartiallyOpen ? 24 : 44;
    const usableW = Math.max(60, stageW - padX * 2);
    const usableH = Math.max(60, stageH * heightFactor - padY * 2);

    const zoomX = usableW / bbox.width;
    const zoomY = usableH / bbox.height;
    let idealZoom = Math.min(zoomX, zoomY);

    if (roots.length <= 1 && engine.nodes.size <= 4) {
      idealZoom = Math.min(1.0, idealZoom);
    } else {
      idealZoom = Math.min(1.0, idealZoom * 0.94);
    }
    idealZoom = Math.max(0.16, Math.min(1.12, idealZoom));

    targetCam.zoom = idealZoom;
    targetCam.panX = -(bbox.cx - stageW * 0.5) * idealZoom;
    targetCam.panY = -(bbox.cy - stageH * 0.5) * idealZoom + yShift;
  }

  if (!smooth) {
    cam.panX = targetCam.panX;
    cam.panY = targetCam.panY;
    cam.zoom = targetCam.zoom;
    isCameraAnimating = false;
  } else {
    isCameraAnimating = true;
  }
}

function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  const wx = (sx - stageW * 0.5 - cam.panX) / cam.zoom + stageW * 0.5;
  const wy = (sy - stageH * 0.5 - cam.panY) / cam.zoom + stageH * 0.5;
  return { x: wx, y: wy };
}

function focusCanvasOnNode(nodeId: string): void {
  if (!nodeId) return;

  // If the Activity Log is maximized over the entire window, exit maximized state so the stage is visible
  if (isActivityLogExpanded) {
    isActivityLogExpanded = false;
    activityLogPanelEl.classList.remove("expanded");
    btnLogExpand.textContent = "⤢";
    btnLogExpand.title = "Expand log";
    syncLayoutState();
    updateStageDimensions();
  }

  let node = engine.nodes.get(nodeId);
  if (!node && selectedHarness !== null && latestSnapshot) {
    const existsInFull = latestSnapshot.nodes.some(n => n.id === nodeId);
    if (existsInFull) {
      selectedHarness = null;
      applySnapshot(latestSnapshot);
      node = engine.nodes.get(nodeId);
    }
  }

  if (!node) {
    showFocusToast("Agent outside active window", true);
    return;
  }

  const isLogPartiallyOpen =
    isActivityLogOpen && !isActivityLogExpanded && !isSplitLayout();
  const heightFactor = isLogPartiallyOpen ? 0.46 : 1.0;
  const yShift = isLogPartiallyOpen ? -stageH * 0.24 : 0;
  const usableMin = Math.max(180, Math.min(stageW, stageH * heightFactor));

  let targetZoom: number;
  if (node.data.isSubagent) {
    targetZoom = Math.max(cam.zoom, Math.min(1.12, Math.max(0.86, usableMin / 460)));
  } else {
    targetZoom = Math.max(
      Math.min(cam.zoom, 0.86),
      Math.min(0.96, Math.max(0.64, usableMin / 640))
    );
  }
  targetZoom = Math.max(0.22, Math.min(1.35, targetZoom));

  cameraFocusNodeId = node.id;
  targetCam.zoom = targetZoom;
  targetCam.panX = -(node.x - stageW * 0.5) * targetZoom;
  targetCam.panY = -(node.y - stageH * 0.5) * targetZoom + yShift;
  isCameraAnimating = true;

  renderer.setSelectedNodeId(node.id);
  engine.pokeNode(node.id);
  showFocusToast(`Located ${node.data.label}`);
}

function updateStageDimensions(): void {
  syncLayoutState();
  const rect = stageEl.getBoundingClientRect();
  if (rect.width > 20 && rect.height > 20) {
    stageW = rect.width;
    stageH = rect.height;
    const isHoriz =
      currentViewMode === "window"
        ? stageW > stageH * 1.15
        : (currentAttachment.edge === "top" || currentAttachment.edge === "bottom");
    engine.setViewport(stageW, stageH, isHoriz);
    renderer.resize(stageW, stageH);
  }
}

function setWrapState(enabled: boolean): void {
  isWrapEnabled = enabled;
  logWrapBtn?.classList.toggle("active", enabled);
  activityLogPanelEl.classList.toggle("wrap-enabled", enabled);
}

function applyAttachment(att: EdgeAttachment): void {
  currentAttachment = att;
  rootEl.dataset.edge = att.edge;
  rootEl.dataset.expanded = String(att.isExpanded);
  rootEl.dataset.dragging = String(att.isDragging);
  dragEdgeLabelEl.textContent = att.previewEdge ?? att.edge;

  if (currentViewMode === "window") {
    btnPin.classList.toggle("active", currentWindowState.alwaysOnTop);
    btnPin.title = currentWindowState.alwaysOnTop ? "Unpin" : "Pin";
  } else {
    btnPin.classList.toggle("active", att.isPinned);
    btnPin.title = att.isPinned ? "Unpin" : "Pin";
  }

  if (btnSize) {
    const isCompact = !att.sizePreset || att.sizePreset === "compact";
    btnSize.classList.toggle("active", !isCompact);
    btnSize.title = att.sizePreset ? `Size: ${att.sizePreset}` : "Size";
  }

  if (!isWrapManuallyToggled) {
    const currentW = att.drawerWidth || window.innerWidth;
    const shouldWrap = currentW >= 650 || currentViewMode === "window";
    if (shouldWrap !== isWrapEnabled) {
      setWrapState(shouldWrap);
      if (isActivityLogOpen) {
        scheduleRenderActivityLog();
      }
    }
  }

  requestAnimationFrame(() => updateStageDimensions());
}

let lastRootCount = 0;

function mergeIncomingLogEntry(
  prev: ActivityLogEntry | undefined,
  next: ActivityLogEntry
): ActivityLogEntry {
  if (!prev) return { ...next };
  const merged: ActivityLogEntry = { ...next };
  if (merged.hasHeavyDetail) {
    if (!merged.toolInput && prev.toolInput) {
      merged.toolInput = prev.toolInput;
    }
    if (!merged.fullText && prev.fullText) {
      merged.fullText = prev.fullText;
    }
    if (!merged.output && prev.output) {
      merged.output = prev.output;
    }
    if (!merged.diffPreview && prev.diffPreview) {
      merged.diffPreview = prev.diffPreview;
    }
    if (
      prev.rawCommand &&
      (!merged.rawCommand || prev.rawCommand.length > merged.rawCommand.length)
    ) {
      merged.rawCommand = prev.rawCommand;
    }
    const rawOk = !merged.hasRawCommand || Boolean(merged.rawCommand && !prev.hasHeavyDetail);
    const toolInOk = !merged.hasToolInput || Boolean(merged.toolInput);
    const fullOk = !merged.hasFullText || Boolean(merged.fullText);
    const outOk = !merged.hasOutput || Boolean(merged.output);
    const diffOk = !merged.hasDiffPreview || Boolean(merged.diffPreview);
    if (!prev.hasHeavyDetail && rawOk && toolInOk && fullOk && outOk && diffOk) {
      merged.hasHeavyDetail = false;
    }
  }
  return merged;
}

function ensureEntryDetailLoaded(entryId: string): void {
  const entry = activityLogById.get(entryId);
  if (!entry || !entry.hasHeavyDetail || detailLoadingIds.has(entryId)) return;
  if (typeof window.orbitBridge?.getLogDetail !== "function") return;

  detailLoadingIds.add(entryId);
  window.orbitBridge
    .getLogDetail(entryId)
    .then(detail => {
      detailLoadingIds.delete(entryId);
      if (detail) {
        const cur = activityLogById.get(entryId);
        if (cur) {
          if (detail.rawCommand) cur.rawCommand = detail.rawCommand;
          if (detail.toolInput) cur.toolInput = detail.toolInput;
          if (detail.fullText) cur.fullText = detail.fullText;
          if (detail.output) cur.output = detail.output;
          if (detail.diffPreview) cur.diffPreview = detail.diffPreview;
          cur.hasHeavyDetail = false;
          if (isActivityLogOpen && expandedRowIds.has(entryId)) {
            scheduleRenderActivityLog();
          }
        }
      }
    })
    .catch(() => {
      detailLoadingIds.delete(entryId);
    });
}

function scheduleRenderActivityLog(): void {
  if (logRenderRafId !== null) return;
  logRenderRafId = requestAnimationFrame(() => {
    logRenderRafId = null;
    if (isActivityLogOpen) {
      renderActivityLog();
    }
  });
}

function applySnapshot(payload: GraphSnapshotPayload): void {
  latestSnapshot = payload;

  if (payload.logDeltaMode && payload.logUpserts) {
    const isRepeatInMemoryApply =
      payload.logSeq !== undefined && payload.logSeq === lastAppliedLogSeq;
    lastAppliedLogSeq = payload.logSeq;

    if (!isRepeatInMemoryApply && payload.logUpserts.length > 0) {
      for (let i = 0; i < payload.logUpserts.length; i++) {
        const incoming = payload.logUpserts[i];
        const merged = mergeIncomingLogEntry(activityLogById.get(incoming.id), incoming);
        activityLogById.set(merged.id, merged);
        if (merged.hasHeavyDetail && expandedRowIds.has(merged.id)) {
          ensureEntryDetailLoaded(merged.id);
        }
      }

      activityLogEntries = Array.from(activityLogById.values());
      activityLogEntries.sort((a, b) => a.timestamp - b.timestamp);

      if (activityLogEntries.length > MAX_CLIENT_LOG_ENTRIES) {
        const dropCount = activityLogEntries.length - MAX_CLIENT_LOG_ENTRIES;
        for (let i = 0; i < dropCount; i++) {
          const droppedId = activityLogEntries[i].id;
          activityLogById.delete(droppedId);
          copyTextByEntryId.delete(droppedId);
        }
        activityLogEntries = activityLogEntries.slice(dropCount);
      }

      if (isActivityLogOpen) {
        scheduleRenderActivityLog();
      }
    }
  } else {
    lastAppliedLogSeq = payload.logSeq;
    const incomingList = payload.activityLog ?? [];
    const nextMap = new Map<string, ActivityLogEntry>();
    for (let i = 0; i < incomingList.length; i++) {
      const incoming = incomingList[i];
      const merged = mergeIncomingLogEntry(activityLogById.get(incoming.id), incoming);
      nextMap.set(merged.id, merged);
      if (merged.hasHeavyDetail && expandedRowIds.has(merged.id)) {
        ensureEntryDetailLoaded(merged.id);
      }
    }
    activityLogById.clear();
    for (const [id, entry] of nextMap) {
      activityLogById.set(id, entry);
    }
    for (const id of copyTextByEntryId.keys()) {
      if (!activityLogById.has(id)) {
        copyTextByEntryId.delete(id);
      }
    }
    activityLogEntries = Array.from(activityLogById.values());
    activityLogEntries.sort((a, b) => a.timestamp - b.timestamp);

    if (isActivityLogOpen) {
      scheduleRenderActivityLog();
    }
  }

  const isTimeWindowSwitch = currentTimeWindow !== null && currentTimeWindow !== payload.timeWindow;
  const isFirstLoad = currentTimeWindow === null;
  currentTimeWindow = payload.timeWindow;

  // Unfiltered counts for legend pills
  const harnessCounts: Record<HarnessKind, number> = {
    claude: 0,
    codex: 0,
    antigravity: 0,
    strata: 0,
  };
  for (const n of payload.nodes) {
    if (harnessCounts[n.harness] !== undefined) {
      harnessCounts[n.harness]++;
    }
  }

  // Filter nodes if selectedHarness is active
  const visibleNodes = selectedHarness
    ? payload.nodes.filter(n => n.harness === selectedHarness)
    : payload.nodes;

  const roots = visibleNodes.filter(n => !n.isSubagent);
  const rootCountChanged = lastRootCount !== roots.length;
  lastRootCount = roots.length;

  engine.syncSnapshot(visibleNodes);
  renderer.setFilterHarness(selectedHarness);

  // If switching time windows, initial load, or root count changed, auto-fit smoothly to stage
  if (isTimeWindowSwitch || isFirstLoad || rootCountChanged) {
    fitGraphToViewport(true);
    setTimeout(() => fitGraphToViewport(true), 600);
    setTimeout(() => fitGraphToViewport(true), 1400);
  }

  // Update time-window pill active state
  for (const pill of windowPills) {
    pill.classList.toggle("active", pill.dataset.mode === payload.timeWindow);
  }

  btnClearSim.classList.toggle("hidden", !payload.simActive);

  // Update tucked Edge Spine dots & count
  const subs = visibleNodes.filter(n => n.isSubagent);
  const activeSubs = subs.filter(n => n.status !== "completed");
  const allWaitingRoots = payload.nodes.filter(
    n => !n.isSubagent && n.status === "waiting_on_user"
  );
  const anyWaiting = allWaitingRoots.length > 0;

  rootEl.dataset.waiting = anyWaiting ? "true" : "false";
  spineEl.classList.toggle("waiting-alert", anyWaiting);
  spineCountEl.textContent = String(roots.length);

  // Update Top-Bar 'Needs You' Quick-Jump Pill Bar
  if (needsYouBarEl) {
    const activeWaitingRoots = selectedHarness
      ? allWaitingRoots.filter(n => n.harness === selectedHarness)
      : allWaitingRoots;

    if (activeWaitingRoots.length === 0) {
      needsYouBarEl.classList.add("hidden");
      needsYouBarEl.innerHTML = "";
    } else {
      needsYouBarEl.classList.remove("hidden");
      const displayed = activeWaitingRoots.slice(0, 2);
      const overflow = activeWaitingRoots.length - displayed.length;

      const pillsHtml = displayed
        .map(n => {
          const reasonTag =
            n.waitingReason === "question"
              ? "Question"
              : n.waitingReason === "plan_review"
                ? "Plan"
                : "Ready";
          const shortName =
            n.label.length > 44 ? n.label.slice(0, 43) + "…" : n.label;
          const titleText = n.waitingPrompt || n.label;
          const harnessColor = HARNESS_COLORS[n.harness].core;

          return `<button class="needs-you-pill" data-node-id="${escapeHtml(n.id)}" title="${escapeHtml(titleText)}"><span class="needs-you-dot" style="background:${harnessColor}"></span><span class="needs-you-label">${escapeHtml(shortName)}</span><span class="needs-you-tag">${reasonTag}</span><span class="needs-you-jump">↗</span></button>`;
        })
        .join("");

      const overflowHtml =
        overflow > 0
          ? `<button class="needs-you-pill overflow" title="${overflow} more waiting on you">+${overflow}</button>`
          : "";

      needsYouBarEl.innerHTML = pillsHtml + overflowHtml;
    }
  }

  spineDotsEl.innerHTML = "";
  for (const r of roots.slice(0, 7)) {
    const dot = document.createElement("span");
    dot.className = "spine-dot";
    if (r.status === "tool_running" || r.status === "thinking") {
      dot.classList.add("working");
    } else if (r.status === "waiting_on_user") {
      dot.classList.add("waiting");
    }
    dot.style.background = HARNESS_COLORS[r.harness].core;
    spineDotsEl.appendChild(dot);
  }
  if (roots.length === 0) {
    const idleDot = document.createElement("span");
    idleDot.className = "spine-dot";
    idleDot.style.background = "rgba(148, 163, 184, 0.45)";
    spineDotsEl.appendChild(idleDot);
  }

  // Update 4-Harness Key in footer
  for (const h of ["claude", "codex", "antigravity", "strata"] as HarnessKind[]) {
    const legEl = document.querySelector<HTMLElement>(`.leg-${h}`);
    if (legEl) {
      const c = harnessCounts[h];
      legEl.classList.toggle("zero", c === 0);
      legEl.classList.toggle("active", c > 0);
      legEl.classList.toggle("selected", selectedHarness === h);
      legEl.classList.toggle("filter-dim", selectedHarness !== null && selectedHarness !== h);
      const countEl = legEl.querySelector<HTMLElement>(".leg-count");
      if (countEl) {
        countEl.textContent = c > 0 ? String(c) : "";
      }
      const capName =
        h === "claude" ? "Claude" : h === "codex" ? "Codex" : h === "antigravity" ? "Antigravity" : "Strata";
      legEl.title = selectedHarness === h ? "All harnesses" : capName;
    }
  }

  // Update footer summary
  if (selectedHarness !== null) {
    const capName =
      selectedHarness === "claude"
        ? "Claude"
        : selectedHarness === "codex"
          ? "Codex"
          : selectedHarness === "antigravity"
            ? "Antigravity"
            : "Strata";
    summaryEl.classList.add("filtered");
    summaryEl.title = "All harnesses";
    const agentCountTxt = `${roots.length} agent${roots.length === 1 ? "" : "s"}`;
    summaryEl.textContent = `${capName} · ${agentCountTxt} ✕`;
  } else {
    summaryEl.classList.remove("filtered");
    summaryEl.removeAttribute("title");
    summaryEl.textContent =
      subs.length > 0
        ? `${roots.length} agent${roots.length === 1 ? "" : "s"} · ${activeSubs.length} active`
        : `${roots.length} agent${roots.length === 1 ? "" : "s"}`;
  }

  if (hoveredNode) {
    const refreshed = engine.nodes.get(hoveredNode.id) ?? null;
    hoveredNode = refreshed;
    if (hoveredNode) {
      hoveredNode.isHovered = true;
      renderHoverCard(hoveredNode);
    } else {
      hideHoverCard();
    }
  }
}

function handlePulse(pulse: LivePulseEvent): void {
  if (selectedHarness && pulse.harness !== selectedHarness) {
    return;
  }
  engine.handlePulse(pulse);

  // Flash the tucked spine gently so peripheral vision feels live activity!
  spineEl.classList.add("pulse-flash");
  if (spineFlashTimer !== null) window.clearTimeout(spineFlashTimer);
  spineFlashTimer = window.setTimeout(() => {
    spineEl.classList.remove("pulse-flash");
  }, 360);
}

function renderHoverCard(node: PhysicsNode): void {
  const s: AgentNodeSnapshot = node.data;
  const sleep = computeStarSleepState(s, Date.now());
  const isSlumbering = !s.isSubagent && sleep.isAsleep;
  const activeToolKey = s.activeTool ? `${s.activeTool.name}:${s.activeTool.target ?? ""}` : "";
  const hoverKey = `${s.id}|${s.status}|${s.turnCount ?? 0}|${s.totalToolCalls}|${node.activeSubsCount ?? 0}|${node.totalCompletedSubs ?? 0}|${s.waitingPrompt ?? ""}|${activeToolKey}|${s.skills.length}|${isSlumbering ? 1 : 0}|${s.tokenUsage?.contextTokens ?? 0}`;

  if (hoverKey !== lastHoverRenderKey) {
    const pal = HARNESS_COLORS[s.harness];
    const statusLabel: Record<string, string> = {
      tool_running: "⚡ Running tool",
      thinking: "🧠 Thinking",
      waiting_on_user: "💬 Waiting on you",
      completed: "✓ Done",
      idle: isSlumbering ? "💤 Slumbering" : "💤 Idle",
    };

    let liveBannerHtml = "";
    if (s.status === "waiting_on_user" && s.waitingPrompt) {
      liveBannerHtml = `<div class="hc-waiting-prompt">${escapeHtml(s.waitingPrompt)}</div>`;
    } else if (s.status === "tool_running" && s.activeTool) {
      const activeTxt = s.activeTool.target
        ? `${s.activeTool.name}: ${s.activeTool.target}`
        : s.activeTool.name;
      liveBannerHtml = `<div class="hc-active-tool">⚡ ${escapeHtml(activeTxt)}</div>`;
    }

    const summaryChips: string[] = [];
    if (
      !s.isSubagent &&
      ((node.activeSubsCount ?? 0) > 0 || (node.totalCompletedSubs ?? 0) > 0)
    ) {
      summaryChips.push(
        `<span class="hc-stat-chip"><b>${node.activeSubsCount ?? 0}</b> active · <b>${node.totalCompletedSubs ?? 0}</b> done</span>`
      );
    }
    if ((s.turnCount ?? 0) > 0) {
      const tc = s.turnCount!;
      summaryChips.push(
        `<span class="hc-stat-chip"><b>${tc}</b> ${tc === 1 ? "turn" : "turns"}</span>`
      );
    }
    if (s.totalToolCalls > 0) {
      summaryChips.push(`<span class="hc-stat-chip"><b>${s.totalToolCalls}</b> tools</span>`);
    }
    for (const sk of s.skills.slice(0, 2)) {
      summaryChips.push(`<span class="hc-skill-pill">★ ${escapeHtml(sk.name)}</span>`);
    }
    if (s.skills.length > 2) {
      summaryChips.push(`<span class="hc-stat-chip">+${s.skills.length - 2}</span>`);
    }
    const summaryHtml =
      summaryChips.length > 0
        ? `<div class="hc-summary-strip">${summaryChips.join("")}</div>`
        : "";

    const bodyClassLabel = !s.isSubagent
      ? node.stellarProfile?.label
      : s.status === "completed"
        ? (node.asteroidProfile ?? computeAsteroidProfile(s.turnCount, s.totalToolCalls)).label
        : undefined;

    let fuelHtml = "";
    if (s.tokenUsage && s.tokenUsage.contextTokens > 0) {
      const pct = Math.min(100, Math.max(0, Math.round(s.tokenUsage.contextPercent)));
      const fuelCol = pct >= 80 ? "#fb7185" : pct >= 60 ? "#fbbf24" : "#34d399";
      fuelHtml = `
        <div class="hc-fuel-wrap">
          <div class="hc-fuel-head">
            <span>Context</span>
            <span>${formatCompactTokens(s.tokenUsage.contextTokens)} / ${formatCompactTokens(s.tokenUsage.contextMaxTokens)} · <b style="color:${fuelCol}">${pct}%</b></span>
          </div>
          <div class="hc-fuel-bar">
            <div class="hc-fuel-fill" style="width:${pct}%;background:${fuelCol}"></div>
          </div>
        </div>
      `;
    }

    hoverCardEl.innerHTML = `
      <div class="hc-top">
        <span class="hc-badge" style="background:${pal.glow};color:${pal.ring}">${escapeHtml(s.harness)}${s.isSubagent ? " · sub" : ""}</span>
        <span class="hc-status">${statusLabel[s.status] ?? s.status}</span>
      </div>
      <div class="hc-title">${escapeHtml(s.label)}</div>
      <div class="hc-meta">${escapeHtml(s.project)}${s.model ? ` · ${escapeHtml(s.model)}` : ""}${bodyClassLabel ? ` · <span style="color:${pal.ring}">${escapeHtml(bodyClassLabel)}</span>` : ""}</div>
      ${liveBannerHtml}
      ${summaryHtml}
      ${fuelHtml}
    `;

    hoverCardEl.classList.remove("hidden");
    cachedHoverCardH = hoverCardEl.offsetHeight || 110;
    lastHoverRenderKey = hoverKey;
  } else {
    hoverCardEl.classList.remove("hidden");
  }

  // Position card cleanly inside stage without clipping (zero forced reflow)
  const sx = (node.x - stageW * 0.5) * cam.zoom + stageW * 0.5 + cam.panX;
  const sy = (node.y - stageH * 0.5) * cam.zoom + stageH * 0.5 + cam.panY;
  const cardW = Math.min(280, Math.max(180, stageW - 16));
  const cardH = cachedHoverCardH;

  let left = sx + node.radius * cam.zoom + 12;
  if (left + cardW > stageW - 8) {
    left = Math.max(8, sx - node.radius * cam.zoom - cardW - 12);
  }
  const isBottomLogCovering =
    isActivityLogOpen && !isActivityLogExpanded && !isSplitLayout();
  const maxTop = isBottomLogCovering
    ? Math.max(8, stageH * 0.44 - cardH)
    : stageH - cardH - 8;
  const top = Math.max(8, Math.min(maxTop, sy - cardH * 0.35));

  hoverCardEl.style.left = `${Math.round(left)}px`;
  hoverCardEl.style.top = `${Math.round(top)}px`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ==================== ACTIVITY LOG HELPERS ====================
export interface FormattedActivity {
  displayText: string;
  tooltipText: string;
  isMono: boolean;
  isProse: boolean;
  isReplyProse: boolean;
  canExpand: boolean;
  expandedBlock?: string;
}

export function condensePaths(text: string): string {
  if (!text) return "";
  let s = text;

  // Worktree: C:\Users\<user>\Desktop\code\worktree\<wt>\ or /c/Users/<user>/Desktop/code/worktree/<wt>/
  s = s.replace(
    /(?:[A-Za-z]:[/\\]Users[/\\][^/\\"'`\s]+[/\\]Desktop[/\\]code[/\\]worktree[/\\]|\/[a-zA-Z]\/Users\/[^/\\"'`\s]+\/Desktop\/code\/worktree\/|\/(?:Users|home)\/[^/\\"'`\s]+\/(?:Desktop\/)?code\/worktree\/)([^/\\"'`\s]+)[/\\]?/gi,
    "[$1]/"
  );

  // Repo: C:\Users\<user>\Desktop\code\<repo>\ or /c/Users/<user>/Desktop/code/<repo>/
  s = s.replace(
    /(?:[A-Za-z]:[/\\]Users[/\\][^/\\"'`\s]+[/\\]Desktop[/\\]code[/\\]|\/[a-zA-Z]\/Users\/[^/\\"'`\s]+\/Desktop\/code\/|\/(?:Users|home)\/[^/\\"'`\s]+\/(?:Desktop\/)?code\/)([^/\\"'`\s]+)[/\\]?/gi,
    "$1/"
  );

  // Scratch project: C:\Users\<user>\.gemini\antigravity\scratch\<proj>\ or /c/Users/<user>/.gemini/antigravity/scratch/<proj>/
  s = s.replace(
    /(?:[A-Za-z]:[/\\]Users[/\\][^/\\"'`\s]+[/\\]\.gemini[/\\]antigravity[/\\]scratch[/\\]|\/[a-zA-Z]\/Users\/[^/\\"'`\s]+\/\.gemini\/antigravity\/scratch\/|\/(?:Users|home)\/[^/\\"'`\s]+\/\.gemini\/antigravity\/scratch\/)([^/\\"'`\s]+)[/\\]?/gi,
    "$1/"
  );

  // Temp script paths: C:/Users/<user>/AppData/Local/Temp/claude/<id>/.../<script>
  s = s.replace(
    /(?:[A-Za-z]:[/\\]Users[/\\][^/\\"'`\s]+[/\\]AppData[/\\]Local[/\\]Temp|\/[a-zA-Z]\/Users\/[^/\\"'`\s]+\/AppData\/Local\/Temp|\/tmp)[/\\](?:claude[/\\])?[^/\\"'`\s]+(?:[/\\][^/\\"'`\s]+)*[/\\]([^/\\"'`\s]+)/gi,
    "<tmp>/$1"
  );
  s = s.replace(
    /(?:[A-Za-z]:[/\\]Users[/\\][^/\\"'`\s]+[/\\]AppData[/\\]Local[/\\]Temp|\/[a-zA-Z]\/Users\/[^/\\"'`\s]+\/AppData\/Local\/Temp)[/\\]/gi,
    "<tmp>/"
  );

  // Remaining home dir: C:\Users\<user>\ or /c/Users/<user>/ or /Users/<user>/ or /home/<user>/
  s = s.replace(
    /(?:[A-Za-z]:[/\\]Users[/\\][^/\\"'`\s]+[/\\]|\/[a-zA-Z]\/Users\/[^/\\"'`\s]+\/|\/(?:Users|home)\/[^/\\"'`\s]+\/)/gi,
    "~/"
  );

  // Normalize remaining backslashes in paths
  s = s.replace(/\\/g, "/");

  // Collapse consecutive slashes
  s = s.replace(/([^:])\/{2,}/g, "$1/");

  return s;
}

export function unwrapShellCommand(cmd: string): string {
  let s = cmd.trim();

  // Strip Git Bash wrappers: & "C:/Program Files/Git/bin/bash.exe" -lc "..."
  const gitBashRegex = /^(?:&\s*)?(?:"[^"]*bash(?:\.exe)?"|bash(?:\.exe)?)\s+-(?:l?c)\s+(["'])([\s\S]*)\1$/i;
  const m = s.match(gitBashRegex);
  if (m) {
    s = m[2].trim();
  } else {
    const gitBashSimple = /^(?:&\s*)?(?:"[^"]*bash(?:\.exe)?"|bash(?:\.exe)?)\s+-(?:l?c)\s+([\s\S]+)$/i;
    const m2 = s.match(gitBashSimple);
    if (m2) {
      s = m2[1].trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1).trim();
      }
    }
  }

  // Strip leading cd ... && and extract folder name if present
  const cdRegex = /^cd\s+(?:["']([^"']+)["']|([^\s&]+))\s*&&\s*([\s\S]+)$/i;
  const cdMatch = s.match(cdRegex);
  if (cdMatch) {
    const cdTarget = (cdMatch[1] || cdMatch[2]).trim();
    const remainingCmd = cdMatch[3].trim();
    const normalizedTarget = condensePaths(cdTarget).replace(/\/+$/, "");
    if (normalizedTarget.startsWith("[") && normalizedTarget.endsWith("]")) {
      s = `${normalizedTarget} ${remainingCmd}`;
    } else if (normalizedTarget.startsWith("[") && normalizedTarget.includes("]")) {
      s = `${normalizedTarget} ${remainingCmd}`;
    } else {
      const parts = normalizedTarget.split("/").filter(Boolean);
      const folder = parts[parts.length - 1];
      if (folder && folder !== "~" && folder !== "c" && folder !== "Desktop" && folder !== "code") {
        s = `[${folder}] ${remainingCmd}`;
      } else {
        s = remainingCmd;
      }
    }
  }

  return s;
}

export function smartCondensePath(rawPath: string, maxLen = 46): string {
  if (!rawPath) return "";
  const condensed = condensePaths(rawPath);
  if (condensed.length <= maxLen) return condensed;
  const lastSlash = condensed.lastIndexOf("/");
  if (lastSlash > 0 && lastSlash < condensed.length - 1) {
    const filename = condensed.slice(lastSlash + 1);
    const firstSlash = condensed.indexOf("/");
    const prefix = firstSlash > 0 ? condensed.slice(0, firstSlash) : "";
    if (prefix && prefix.length + filename.length + 5 <= maxLen) {
      return `${prefix}/…/${filename}`;
    }
    if (filename.length + 6 <= maxLen) {
      const avail = maxLen - filename.length - 3;
      return `${condensed.slice(0, Math.max(3, avail))}…/${filename}`;
    }
    return `…/${filename}`;
  }
  return middleTruncate(condensed, maxLen);
}

export function middleTruncate(str: string, maxLen = 54): string {
  if (!str || str.length <= maxLen) return str;
  const lastSlash = str.lastIndexOf("/");
  if (lastSlash > 0 && lastSlash < str.length - 1) {
    const filename = str.slice(lastSlash + 1);
    if (filename.length + 8 <= maxLen) {
      const remainingLen = maxLen - filename.length - 3;
      const prefix = str.slice(0, Math.max(4, remainingLen));
      return `${prefix}…/${filename}`;
    }
  }

  const sep = "…";
  const chars = maxLen - sep.length;
  const head = Math.ceil(chars * 0.45);
  const tail = Math.floor(chars * 0.55);
  return `${str.slice(0, head)}${sep}${str.slice(str.length - tail)}`;
}

export function renderDiffLinesHtml(diffText: string): string {
  const lines = diffText.split("\n");
  const htmlParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith("+")) {
      htmlParts.push(`<div class="diff-line diff-line-add">${escapeHtml(line)}</div>`);
    } else if (line.startsWith("-")) {
      htmlParts.push(`<div class="diff-line diff-line-del">${escapeHtml(line)}</div>`);
    } else if (line.startsWith("@@") || line.startsWith("***")) {
      htmlParts.push(`<div class="diff-line diff-line-hunk">${escapeHtml(line)}</div>`);
    } else {
      htmlParts.push(`<div class="diff-line diff-line-ctx">${escapeHtml(line)}</div>`);
    }
  }
  return `<div class="log-diff-viewer">${htmlParts.join("")}</div>`;
}

export function renderOutputHtml(output: string, headerLabel = "Terminal Output"): string {
  return `<div class="log-terminal-output"><div class="log-output-header">${escapeHtml(headerLabel)}</div><pre class="log-output-content">${escapeHtml(output)}</pre></div>`;
}

export function renderToolCallBoxHtml(
  entry: ActivityLogEntry,
  options?: { openUrlOrPath?: string; fallbackArgsText?: string }
): string {
  const fnName = entry.title || entry.badge || "tool";
  const openTarget = (options?.openUrlOrPath || "").trim();
  let actionHtml = "";
  if (openTarget) {
    const isUrl = /^https?:\/\//i.test(openTarget);
    const label = isUrl ? "Open URL ↗" : `${condensePaths(openTarget)} ↗`;
    const title = isUrl ? `Open ${openTarget} in browser` : `Open ${openTarget}`;
    actionHtml = `<button type="button" class="log-file-link log-open-action-pill" data-open-path="${escapeHtml(openTarget)}" data-node-id="${escapeHtml(entry.nodeId)}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
  }

  const argsStr = entry.toolInput || options?.fallbackArgsText || "";
  const isWaitingForArgs = !argsStr && Boolean(entry.hasHeavyDetail && entry.hasToolInput);
  const argsHtml = argsStr
    ? `<pre class="log-tool-call-args">${escapeHtml(argsStr)}</pre>`
    : isWaitingForArgs
      ? `<div class="log-tool-call-loading">Loading tool parameters…</div>`
      : "";

  return `<div class="log-tool-call-box"><div class="log-tool-call-header"><span class="log-tool-call-kicker">Tool Call</span><code class="log-tool-call-fn">${escapeHtml(fnName)}</code>${actionHtml}</div>${argsHtml}</div>`;
}

export function wrapExpandedPanel(
  innerHtml: string,
  textToCopy?: string,
  entryId?: string
): string {
  let copyBtn = "";
  if (textToCopy) {
    if (entryId) {
      copyTextByEntryId.set(entryId, textToCopy);
      copyBtn = `<button class="log-copy-btn" data-copy-id="${escapeHtml(entryId)}" title="Copy full content" type="button">Copy</button>`;
    } else {
      copyBtn = `<button class="log-copy-btn" data-copy="${escapeHtml(textToCopy)}" title="Copy full content" type="button">Copy</button>`;
    }
  }
  return `<div class="log-expanded-panel">${copyBtn}${innerHtml}</div>`;
}

export function formatReadableActivity(
  entry: ActivityLogEntry,
  isRowExpanded: boolean,
  isWrapEnabled: boolean
): FormattedActivity {
  const badge = entry.badge || "TOOL";
  const rawTitle = entry.title || "";
  const rawDetail = entry.detail || "";
  const rawCmd = entry.rawCommand;
  const summary = entry.summary?.trim();

  let displayText = "";
  let tooltipText = "";
  let isMono = false;
  let isProse = false;
  let isReplyProse = false;
  let canExpand = false;
  let expandedBlock: string | undefined = undefined;

  // 1. Shell commands with rawCommand or wire flag hasRawCommand (GIT, TEST, BUILD, BASH, PKG, SCRIPT, PR via gh)
  if (rawCmd || entry.hasRawCommand) {
    canExpand = true;
    const cmdPreview = rawCmd || rawDetail || rawTitle;

    if (summary) {
      displayText = summary;
      isMono = false;
      tooltipText = `${rawTitle}: ${cmdPreview}`;
    } else {
      const unwrapped = unwrapShellCommand(cmdPreview);
      const condensed = condensePaths(unwrapped);
      displayText = (isWrapEnabled || isRowExpanded) ? condensed : middleTruncate(condensed, 56);
      isMono = true;
      tooltipText = `${rawTitle}: ${cmdPreview}`;
    }

    if (isRowExpanded) {
      const toolBoxHtml = renderToolCallBoxHtml(entry);
      if (entry.hasHeavyDetail && (!rawCmd || (entry.hasOutput && !entry.output))) {
        const loadingInner = rawCmd
          ? `${toolBoxHtml}<div class="log-raw-cmd">$ ${escapeHtml(rawCmd)}\n\nLoading full output…</div>`
          : `${toolBoxHtml}<div class="log-raw-cmd">Loading full output…</div>`;
        expandedBlock = wrapExpandedPanel(loadingInner, rawCmd || undefined, entry.id);
      } else {
        const cmdStr = rawCmd || cmdPreview;
        const outputHtml = entry.output ? renderOutputHtml(entry.output, "Terminal Output") : "";
        const copyParts = [
          entry.toolInput ? `${rawTitle} ${entry.toolInput}` : `${rawTitle}`,
          `$ ${cmdStr}`,
          entry.output || "",
        ].filter(Boolean);
        expandedBlock = wrapExpandedPanel(
          `${toolBoxHtml}<div class="log-raw-cmd">$ ${escapeHtml(cmdStr)}</div>${outputHtml}`,
          copyParts.join("\n\n"),
          entry.id
        );
      }
    }

    return {
      displayText,
      tooltipText,
      isMono,
      isProse,
      isReplyProse,
      canExpand,
      expandedBlock,
    };
  }

  // 2. File READ / EDIT / WRITE / PLAN
  if (badge === "READ" || badge === "EDIT" || badge === "WRITE" || badge === "PLAN") {
    const rawTarget = rawDetail || rawTitle;
    const smartTarget = smartCondensePath(rawTarget, 46);

    if (summary) {
      displayText = smartTarget ? `${summary} · ${smartTarget}` : summary;
      isMono = false;
      tooltipText = rawTarget ? `${rawTitle}: ${summary}\n${rawTarget}` : `${rawTitle}: ${summary}`;
    } else {
      displayText = (isWrapEnabled || isRowExpanded) ? condensePaths(rawTarget) : smartTarget;
      isMono = true;
      tooltipText = `${rawTitle}: ${rawTarget}`;
    }

    // Always allow expanding file/plan tool rows to inspect the actual tool call, line ranges, diff, or output
    canExpand = true;
    if (isRowExpanded) {
      const openPath = (entry.filePath || entry.detail || "").trim();
      const toolBoxHtml = renderToolCallBoxHtml(entry, {
        openUrlOrPath: openPath || undefined,
        fallbackArgsText: !entry.toolInput && !entry.hasToolInput && rawTarget ? rawTarget : undefined,
      });
      let extraHtml = "";
      const copyParts: string[] = [
        entry.toolInput ? `${rawTitle} ${entry.toolInput}` : `${rawTitle}: ${rawTarget}`,
      ];

      if (entry.diffPreview) {
        extraHtml += renderDiffLinesHtml(entry.diffPreview);
        copyParts.push(entry.diffPreview);
      }
      if (entry.fullText && entry.fullText !== entry.toolInput) {
        extraHtml += `<div class="log-prose-content log-sub-section">${escapeHtml(entry.fullText)}</div>`;
        copyParts.push(entry.fullText);
      }
      if (entry.output) {
        extraHtml += renderOutputHtml(entry.output, badge === "READ" ? "File / Read Output" : "Tool Output");
        copyParts.push(entry.output);
      } else if (
        entry.hasHeavyDetail &&
        ((entry.hasDiffPreview && !entry.diffPreview) ||
          (entry.hasOutput && !entry.output) ||
          (entry.hasFullText && !entry.fullText))
      ) {
        extraHtml += `<div class="log-raw-cmd">Loading full output…</div>`;
      }

      expandedBlock = wrapExpandedPanel(`${toolBoxHtml}${extraHtml}`, copyParts.join("\n\n"), entry.id);
    }

    return {
      displayText,
      tooltipText,
      isMono,
      isProse,
      isReplyProse,
      canExpand,
      expandedBlock,
    };
  }

  // 3. PR Link milestones (type === "pr-link")
  if (badge === "PR") {
    const urlOrText = rawDetail || summary || rawTitle;
    displayText = (isWrapEnabled || isRowExpanded) ? urlOrText : middleTruncate(urlOrText, 68);
    tooltipText = urlOrText;
    isMono = /^https?:\/\//i.test(urlOrText);
    canExpand = true;

    if (isRowExpanded) {
      const openUrl = (entry.filePath || (/^https?:\/\//i.test(urlOrText) ? urlOrText : "")).trim();
      const toolBoxHtml = renderToolCallBoxHtml(entry, {
        openUrlOrPath: openUrl || undefined,
        fallbackArgsText: !entry.toolInput && !entry.hasToolInput ? urlOrText : undefined,
      });
      const outHtml = entry.output ? renderOutputHtml(entry.output, "PR Output") : "";
      const copyText = entry.toolInput ? `${entry.toolInput}${entry.output ? `\n\n${entry.output}` : ""}` : urlOrText;
      expandedBlock = wrapExpandedPanel(`${toolBoxHtml}${outHtml}`, copyText, entry.id);
    }

    return {
      displayText,
      tooltipText,
      isMono,
      isProse,
      isReplyProse,
      canExpand,
      expandedBlock,
    };
  }

  // 4. REPLY / PROMPT
  if (badge === "REPLY" || badge === "PROMPT" || entry.kind === "reply" || entry.kind === "prompt") {
    isProse = true;
    if (badge === "REPLY" || entry.kind === "reply") {
      isReplyProse = true;
    }

    const crispSummary = summary || rawDetail || rawTitle;
    const fullText = entry.fullText || rawDetail || summary || rawTitle;

    // Header displayText shows the concise 1-line summary without duplication
    displayText = (isWrapEnabled && !isRowExpanded) ? crispSummary : middleTruncate(crispSummary, 72);
    tooltipText = crispSummary;

    const hasNewlines = fullText.includes("\n");
    const isLonger = fullText.length > 85;
    const isDiffFromSummary = Boolean(entry.fullText && entry.fullText !== crispSummary);

    if (
      hasNewlines ||
      isLonger ||
      isDiffFromSummary ||
      Boolean(entry.hasFullText || entry.hasHeavyDetail)
    ) {
      canExpand = true;
      if (isRowExpanded) {
        const bodyHtml =
          entry.hasHeavyDetail && !entry.fullText
            ? `<div class="log-prose-content">${escapeHtml(fullText)}\n\nLoading full output…</div>`
            : `<div class="log-prose-content">${escapeHtml(fullText)}</div>`;
        expandedBlock = wrapExpandedPanel(bodyHtml, fullText, entry.id);
      }
    }

    return {
      displayText,
      tooltipText,
      isMono,
      isProse,
      isReplyProse,
      canExpand,
      expandedBlock,
    };
  }

  // 5. MCP Tools
  if (badge === "MCP" || rawTitle.toLowerCase().startsWith("mcp__")) {
    const lowerTitle = rawTitle.toLowerCase();
    if (summary) {
      displayText = summary;
      isMono = false;
      tooltipText = rawDetail ? `${rawTitle}\n${summary}\n${rawDetail}` : `${rawTitle}: ${summary}`;
    } else {
      let server = "mcp";
      let action = "tool";
      if (lowerTitle.startsWith("mcp__")) {
        const stripped = rawTitle.slice(5);
        const parts = stripped.split("__");
        server = parts[0] || "mcp";
        action = parts.slice(1).join(" · ") || parts[0] || "tool";
      }
      const mcpPrefix = `${server} · ${action}`;
      let argsText = "";
      if (rawDetail && rawDetail.toLowerCase() !== lowerTitle) {
        let clean = rawDetail.replace(new RegExp(`^${rawTitle}\\s*[:=]?\\s*`, "i"), "").trim();
        clean = condensePaths(clean);
        argsText = clean;
      }
      const fullMcp = argsText ? `${mcpPrefix}  ${argsText}` : mcpPrefix;
      displayText = (isWrapEnabled || isRowExpanded) ? fullMcp : middleTruncate(fullMcp, 56);
      isMono = true;
      tooltipText = rawDetail ? `${rawTitle}: ${rawDetail}` : rawTitle;
    }

    canExpand = true;
    if (isRowExpanded) {
      const fallbackArgs = entry.fullText || rawDetail || undefined;
      const toolBoxHtml = renderToolCallBoxHtml(entry, {
        fallbackArgsText: !entry.toolInput && !entry.hasToolInput ? fallbackArgs : undefined,
      });
      if (
        entry.hasHeavyDetail &&
        !entry.toolInput &&
        !entry.fullText &&
        (entry.hasOutput && !entry.output)
      ) {
        expandedBlock = wrapExpandedPanel(
          `${toolBoxHtml}<div class="log-raw-cmd">Loading full output…</div>`,
          rawDetail || rawTitle,
          entry.id
        );
      } else {
        const outHtml = entry.output ? renderOutputHtml(entry.output, "MCP Result") : "";
        const mainText = entry.toolInput || entry.fullText || rawDetail || rawTitle;
        const copyText = entry.output ? `${rawTitle}\n${mainText}\n\n${entry.output}` : `${rawTitle}\n${mainText}`;
        expandedBlock = wrapExpandedPanel(`${toolBoxHtml}${outHtml}`, copyText, entry.id);
      }
    }

    return {
      displayText,
      tooltipText,
      isMono,
      isProse,
      isReplyProse,
      canExpand,
      expandedBlock,
    };
  }

  // 6. All Other Tools & Lifecycle Events (SEARCH, WEB, SPAWN, DONE, ASK, MSG, SKILL, TOOL)
  if (summary) {
    displayText = summary;
    isMono = false;
    tooltipText = rawDetail ? `${rawTitle}: ${summary}\n${rawDetail}` : `${rawTitle}: ${summary}`;
  } else {
    const full = condensePaths(rawDetail || rawTitle);
    displayText = (isWrapEnabled || isRowExpanded) ? full : middleTruncate(full, 62);
    isMono = entry.kind === "tool";
    tooltipText = rawDetail ? `${rawTitle}: ${rawDetail}` : rawTitle;
  }

  const hasDiff = Boolean(entry.diffPreview || entry.hasDiffPreview);
  const hasOut = Boolean(entry.output || entry.hasOutput);
  const hasFull = Boolean(entry.fullText || entry.hasFullText);
  const hasToolIn = Boolean(entry.toolInput || entry.hasToolInput);
  const hasLongDetail = Boolean(rawDetail && (rawDetail.includes("\n") || rawDetail.length > 56));

  if (
    entry.kind === "tool" ||
    hasToolIn ||
    hasDiff ||
    hasOut ||
    hasFull ||
    hasLongDetail ||
    entry.hasHeavyDetail
  ) {
    canExpand = true;
    if (isRowExpanded) {
      const openUrlOrPath =
        entry.filePath ||
        (/^https?:\/\//i.test(rawDetail.trim()) ? rawDetail.trim() : undefined);
      const toolBoxHtml = renderToolCallBoxHtml(entry, {
        openUrlOrPath,
        fallbackArgsText:
          !entry.toolInput && !entry.hasToolInput && !entry.fullText && rawDetail
            ? rawDetail
            : undefined,
      });

      let inner = toolBoxHtml;
      const copyParts: string[] = [
        entry.toolInput ? `${rawTitle} ${entry.toolInput}` : `${rawTitle}${rawDetail ? `: ${rawDetail}` : ""}`,
      ];

      if (entry.diffPreview) {
        inner += renderDiffLinesHtml(entry.diffPreview);
        copyParts.push(entry.diffPreview);
      } else if (entry.fullText && entry.fullText !== entry.toolInput) {
        const headerLabel =
          badge === "SPAWN"
            ? "Subagent Prompt"
            : badge === "ASK"
              ? "Question & Options"
              : "Details";
        inner += `<div class="log-terminal-output"><div class="log-output-header">${escapeHtml(headerLabel)}</div><div class="log-prose-content">${escapeHtml(entry.fullText)}</div></div>`;
        copyParts.push(entry.fullText);
      }

      if (entry.output) {
        const outHeader =
          badge === "SEARCH"
            ? "Search Output"
            : badge === "WEB"
              ? "Web Output"
              : "Tool Output";
        inner += renderOutputHtml(entry.output, outHeader);
        copyParts.push(entry.output);
      } else if (
        entry.hasHeavyDetail &&
        !entry.diffPreview &&
        !entry.fullText &&
        (entry.hasOutput && !entry.output)
      ) {
        inner += `<div class="log-raw-cmd">Loading full output…</div>`;
      }

      expandedBlock = wrapExpandedPanel(inner, copyParts.join("\n\n"), entry.id);
    }
  }

  return {
    displayText,
    tooltipText,
    isMono,
    isProse,
    isReplyProse,
    canExpand,
    expandedBlock,
  };
}

export function renderLogChips(entry: ActivityLogEntry): string {
  const chips: string[] = [];

  // 1. Line Diff Chip
  const added = entry.linesAdded ?? 0;
  const removed = entry.linesRemoved ?? 0;
  if (added > 0 || removed > 0) {
    const diffParts: string[] = [];
    if (added > 0) {
      diffParts.push(`<span class="diff-add">+${added}</span>`);
    }
    if (removed > 0) {
      diffParts.push(`<span class="diff-del">-${removed}</span>`);
    }
    chips.push(`<span class="log-chip diff" title="+${added} -${removed} lines">${diffParts.join(" ")}</span>`);
  }

  // 2. Exit Code Chip (exitCode !== undefined && exitCode !== 0)
  if (entry.exitCode !== undefined && entry.exitCode !== 0) {
    chips.push(`<span class="log-chip exit-err" title="Exit code ${entry.exitCode}">exit ${entry.exitCode}</span>`);
  }

  // 3. Model Badge Chip
  if (entry.modelBadge) {
    chips.push(`<span class="log-chip model" title="Model: ${escapeHtml(entry.modelBadge)}">${escapeHtml(entry.modelBadge)}</span>`);
  }

  // 4. Subagent Tool Count Rollup
  if (entry.badge === "DONE" && entry.subagentToolCount && entry.subagentToolCount > 0) {
    chips.push(`<span class="log-chip tools" title="${entry.subagentToolCount} tools executed">${entry.subagentToolCount} tools</span>`);
  }

  // 5. Duration Chip (durationMs >= 500)
  if (entry.durationMs !== undefined && entry.durationMs >= 500) {
    const ms = entry.durationMs;
    let durText = "";
    if (ms < 1000) {
      durText = `${(ms / 1000).toFixed(1)}s`;
    } else if (ms < 60_000) {
      durText = `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
    } else {
      const mins = Math.floor(ms / 60000);
      const secs = Math.round((ms % 60000) / 1000);
      durText = `${mins}m ${secs}s`;
    }
    chips.push(`<span class="log-chip dur" title="Duration: ${durText}">${durText}</span>`);
  }

  if (chips.length === 0) return "";
  return `<span class="log-chips">${chips.join("")}</span>`;
}

export function matchesCategory(entry: ActivityLogEntry, category: LogFilterCategory): boolean {
  if (category === "all") return true;

  if (category === "errors") {
    return entry.status === "error" || (entry.exitCode !== undefined && entry.exitCode !== 0);
  }

  const badge = entry.badge;
  if (!badge) return false;

  switch (category) {
    case "code":
      return badge === "EDIT" || badge === "WRITE" || badge === "PLAN";
    case "verify":
      return badge === "TEST" || badge === "BUILD" || badge === "PKG" || badge === "SCRIPT";
    case "git":
      return badge === "GIT" || badge === "PR";
    case "explore":
      return badge === "SEARCH" || badge === "READ" || badge === "WEB" || badge === "MCP";
    case "agents":
      return (
        badge === "SPAWN" ||
        badge === "DONE" ||
        badge === "MSG" ||
        badge === "REPLY" ||
        badge === "PROMPT" ||
        badge === "ASK" ||
        badge === "SKILL"
      );
    default:
      return true;
  }
}

export function updateCategoryBarUI(errorCount: number): void {
  const catBar = document.getElementById("log-category-bar");
  if (!catBar) return;

  const pills = catBar.querySelectorAll<HTMLButtonElement>(".log-cat-pill");
  for (const pill of pills) {
    const cat = pill.dataset.cat as LogFilterCategory;
    const isActive = cat === activeLogCategory;
    pill.classList.toggle("active", isActive);

    if (cat === "errors") {
      pill.classList.toggle("zero", errorCount === 0);
      const badgeEl = pill.querySelector<HTMLElement>(".cat-err-badge");
      if (badgeEl) {
        if (errorCount > 0) {
          badgeEl.textContent = String(errorCount);
          badgeEl.classList.remove("hidden");
        } else {
          badgeEl.textContent = "0";
          badgeEl.classList.add("hidden");
        }
      }
    }
  }
}

export function wireCategoryFilterBar(): void {
  const catBar = document.getElementById("log-category-bar");
  if (!catBar) return;

  catBar.addEventListener("click", e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".log-cat-pill");
    if (!btn) return;
    const cat = btn.dataset.cat as LogFilterCategory;
    if (!cat) return;

    if (activeLogCategory === cat) {
      if (cat !== "all") {
        activeLogCategory = "all";
      }
    } else {
      activeLogCategory = cat;
    }

    logVisibleLimit = 250;
    renderActivityLog();
    logBodyEl.scrollTop = logBodyEl.scrollHeight;
  });
}

function formatRelativeTime(ts: number, now = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 3) return "now";
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

interface CachedLogRow {
  el: HTMLDivElement;
  sig: string;
  timeEl: HTMLElement | null;
  timestamp: number;
}

const rowDomCache = new Map<string, CachedLogRow>();
const rowParserScratch = document.createElement("div");
let paginationHeaderEl: HTMLDivElement | null = null;
let paginationLoadMoreBtn: HTMLButtonElement | null = null;
let lastPaginationHiddenCount = -1;
let lastScopePillHtml = "";

function buildLogRowHtml(
  entry: ActivityLogEntry,
  now: number,
  showChip: boolean,
  isRowExpanded: boolean
): string {
  const relTime = formatRelativeTime(entry.timestamp, now);
  let chipHtml = "";
  if (showChip) {
    const hCol = HARNESS_COLORS[entry.harness]?.core ?? "#94a3b8";
    const rawName = entry.agentLabel || (entry.isSubagent ? "sub" : "agent");
    chipHtml = `<button type="button" class="log-agent-chip" data-agent-node-id="${escapeHtml(entry.nodeId)}" title="Locate ${escapeHtml(rawName)} in orbit view"><span class="chip-dot" style="background:${hCol}"></span><span class="chip-name">${escapeHtml(rawName)}</span></button>`;
  }

  const isErr = entry.status === "error" || (entry.exitCode !== undefined && entry.exitCode !== 0);
  const isRunning = entry.status === "running";

  let statusIndicator = "";
  if (isRunning) {
    statusIndicator = `<span class="log-status-dot"></span>`;
  } else if (isErr) {
    statusIndicator = `<span class="log-status-err">✕</span>`;
  }

  const badge = entry.badge || "TOOL";
  const badgeCol = BADGE_COLORS[badge] ?? "#94a3b8";
  const badgeHtml = `<span class="log-badge badge-${badge.toLowerCase()}" style="color:${badgeCol}" title="${escapeHtml(badge)}">${statusIndicator}${escapeHtml(badge)}</span>`;

  const formatted = formatReadableActivity(entry, isRowExpanded, isWrapEnabled);

  let expandIconHtml = "";
  if (formatted.canExpand) {
    expandIconHtml = `<span class="log-expand-icon" title="Toggle command / detail">${isRowExpanded ? "▾" : "▸"}</span>`;
  } else {
    expandIconHtml = `<span class="log-expand-icon" style="opacity:0;pointer-events:none">▸</span>`;
  }

  const chipsHtml = renderLogChips(entry);

  const detailClasses = [
    "log-detail",
    formatted.isMono ? "mono" : "",
    formatted.isProse ? "prose" : "",
    formatted.isReplyProse ? "reply-prose" : "",
    isErr ? "error-text" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const isOpenableBadge =
    badge === "READ" ||
    badge === "EDIT" ||
    badge === "WRITE" ||
    badge === "PLAN" ||
    (badge === "PR" && !entry.rawCommand && !entry.hasRawCommand);
  const openPath = isOpenableBadge ? (entry.filePath || entry.detail || "").trim() : "";
  let detailInnerHtml = escapeHtml(formatted.displayText);
  if (openPath) {
    const isUrl = /^https?:\/\//i.test(openPath);
    const summary = entry.summary?.trim();
    const smartTarget = isUrl
      ? formatted.displayText
      : smartCondensePath(entry.detail || entry.title || openPath, 46);
    if (!isUrl && summary && smartTarget && summary !== openPath) {
      detailInnerHtml = `${escapeHtml(summary)} · <button type="button" class="log-file-link" data-open-path="${escapeHtml(openPath)}" data-node-id="${escapeHtml(entry.nodeId)}" title="Open ${escapeHtml(openPath)}">${escapeHtml(smartTarget)}</button>`;
    } else if (formatted.displayText) {
      detailInnerHtml = `<button type="button" class="log-file-link" data-open-path="${escapeHtml(openPath)}" data-node-id="${escapeHtml(entry.nodeId)}" title="Open ${escapeHtml(openPath)}">${escapeHtml(formatted.displayText)}</button>`;
    }
  }

  const detailHtml = `<span class="${detailClasses}">${detailInnerHtml}</span>`;

  let expandedContentHtml = "";
  if (isRowExpanded && formatted.expandedBlock) {
    expandedContentHtml = formatted.expandedBlock;
  }

  const rowClasses = [
    "log-row",
    isErr ? "status-error" : "",
    isRowExpanded ? "row-expanded" : "",
    formatted.canExpand ? "has-expand" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<div class="${rowClasses}" data-id="${escapeHtml(entry.id)}" title="${escapeHtml(formatted.tooltipText)}">
    <div class="log-row-main">
      <span class="log-time">${relTime}</span>
      ${chipHtml}
      ${badgeHtml}
      ${expandIconHtml}
      ${detailHtml}
      ${chipsHtml}
    </div>
    ${expandedContentHtml}
  </div>`;
}

function openActivityLog(nodeId: string | null = null): void {
  isActivityLogOpen = true;
  currentLogScopeNodeId = nodeId;
  renderer.setSelectedNodeId(nodeId);
  btnLog?.classList.add("active");
  hideHoverCard();
  userHasScrolledLog = false;
  logJumpLiveBtn.classList.add("hidden");
  logVisibleLimit = 250;
  syncLayoutState();
  updateStageDimensions();
  renderActivityLog();
  fitGraphToViewport(true);
  requestAnimationFrame(() => {
    logBodyEl.scrollTop = logBodyEl.scrollHeight;
  });
}

function closeActivityLog(): void {
  isActivityLogOpen = false;
  currentLogScopeNodeId = null;
  renderer.setSelectedNodeId(null);
  btnLog?.classList.remove("active");
  syncLayoutState();
  updateStageDimensions();
  fitGraphToViewport(true);
}

function setLogScope(nodeId: string | null): void {
  currentLogScopeNodeId = nodeId;
  renderer.setSelectedNodeId(nodeId);
  logVisibleLimit = 250;
  renderActivityLog();
}

function renderActivityLog(): void {
  if (logRenderRafId !== null) {
    cancelAnimationFrame(logRenderRafId);
    logRenderRafId = null;
  }

  const scopedNode = currentLogScopeNodeId
    ? engine.nodes.get(currentLogScopeNodeId)?.data ??
      latestSnapshot?.nodes.find(n => n.id === currentLogScopeNodeId)
    : null;

  // 1. Render Header Scope Pill and Scope Switcher
  let scopePillHtml = "";
  if (currentLogScopeNodeId === null) {
    btnLogScopeAll.classList.add("hidden");
    if (selectedHarness !== null) {
      const pal = HARNESS_COLORS[selectedHarness];
      const cap =
        selectedHarness === "claude"
          ? "Claude"
          : selectedHarness === "codex"
            ? "Codex"
            : selectedHarness === "antigravity"
              ? "Antigravity"
              : "Strata";
      scopePillHtml = `<span class="log-scope-harness-dot" style="background:${pal.core}"></span><span>All ${cap} Agents</span>`;
    } else {
      scopePillHtml = `<span>All Agents</span>`;
    }
  } else {
    btnLogScopeAll.classList.remove("hidden");
    const label = scopedNode ? scopedNode.label : currentLogScopeNodeId;
    const harness = scopedNode ? scopedNode.harness : "antigravity";
    const pal = HARNESS_COLORS[harness];
    if (scopedNode?.isSubagent) {
      scopePillHtml = `<span class="log-scope-harness-dot" style="background:${pal.core}"></span><span>${escapeHtml(label)}</span> <span class="log-scope-tag">(sub)</span>`;
    } else {
      scopePillHtml = `<span class="log-scope-harness-dot" style="background:${pal.core}"></span><span>${escapeHtml(label)}</span>`;
    }
  }
  if (scopePillHtml !== lastScopePillHtml) {
    lastScopePillHtml = scopePillHtml;
    logScopePillEl.innerHTML = scopePillHtml;
  }

  // 2. Filter Entries by Scope & Category in a single pass
  let errorCount = 0;
  const filteredEntries: ActivityLogEntry[] = [];
  for (let i = 0; i < activityLogEntries.length; i++) {
    const entry = activityLogEntries[i];
    let inScope = true;
    if (currentLogScopeNodeId !== null) {
      if (scopedNode) {
        if (!scopedNode.isSubagent) {
          inScope = entry.rootId === scopedNode.id || entry.nodeId === scopedNode.id;
        } else {
          inScope = entry.nodeId === scopedNode.id;
        }
      } else {
        inScope = entry.nodeId === currentLogScopeNodeId || entry.rootId === currentLogScopeNodeId;
      }
    } else if (selectedHarness !== null) {
      inScope = entry.harness === selectedHarness;
    }
    if (!inScope) continue;

    if (entry.status === "error" || (entry.exitCode !== undefined && entry.exitCode !== 0)) {
      errorCount++;
    }
    if (
      matchesCategory(entry, activeLogCategory) &&
      matchesSearchQuery(entry, activeLogSearchQuery)
    ) {
      filteredEntries.push(entry);
    }
  }

  // Update Category Bar UI
  updateCategoryBarUI(errorCount);

  // 3. Render List or Empty State via Incremental DOM Reconciliation
  if (filteredEntries.length === 0) {
    logEmptyEl.classList.remove("hidden");
    if (logListEl.firstChild) {
      logListEl.replaceChildren();
    }
  } else {
    logEmptyEl.classList.add("hidden");
    const now = Date.now();

    const totalCount = filteredEntries.length;
    const hiddenCount = totalCount > logVisibleLimit ? totalCount - logVisibleLimit : 0;
    const startIdx = hiddenCount;

    const desiredNodes: HTMLElement[] = [];

    if (hiddenCount > 0) {
      if (!paginationHeaderEl) {
        paginationHeaderEl = document.createElement("div");
        paginationHeaderEl.className = "log-pagination-header";
        paginationLoadMoreBtn = document.createElement("button");
        paginationLoadMoreBtn.className = "log-load-more";
        paginationLoadMoreBtn.type = "button";
        paginationHeaderEl.appendChild(paginationLoadMoreBtn);
      }
      if (hiddenCount !== lastPaginationHiddenCount && paginationLoadMoreBtn) {
        lastPaginationHiddenCount = hiddenCount;
        paginationLoadMoreBtn.textContent = `↑ Show earlier (${hiddenCount} more)`;
      }
      desiredNodes.push(paginationHeaderEl);
    }

    for (let i = startIdx; i < totalCount; i++) {
      const entry = filteredEntries[i];
      const showChip =
        currentLogScopeNodeId === null ||
        (currentLogScopeNodeId !== entry.nodeId && entry.isSubagent);
      const isRowExpanded = expandedRowIds.has(entry.id);
      const sig = `${entry.rev ?? entry.timestamp}|${entry.status ?? ""}|${entry.durationMs ?? ""}|${entry.exitCode ?? ""}|${entry.linesAdded ?? ""}|${entry.linesRemoved ?? ""}|${entry.subagentToolCount ?? ""}|${entry.agentLabel}|${entry.summary ?? ""}|${entry.detail ? entry.detail.length : 0}|${entry.toolInput ? entry.toolInput.length : 0}|${entry.output ? entry.output.length : 0}|${entry.filePath ?? ""}|${isRowExpanded ? 1 : 0}|${isWrapEnabled ? 1 : 0}|${showChip ? 1 : 0}|${entry.hasHeavyDetail ? 1 : 0}`;

      const cached = rowDomCache.get(entry.id);
      if (cached && cached.sig === sig) {
        desiredNodes.push(cached.el);
      } else {
        rowParserScratch.innerHTML = buildLogRowHtml(entry, now, showChip, isRowExpanded);
        const el = rowParserScratch.firstElementChild as HTMLDivElement;
        const timeEl = el.querySelector<HTMLElement>(".log-time");
        rowDomCache.set(entry.id, { el, sig, timeEl, timestamp: entry.timestamp });
        desiredNodes.push(el);
      }
    }

    if (!logListEl.firstChild) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < desiredNodes.length; i++) {
        frag.appendChild(desiredNodes[i]);
      }
      logListEl.appendChild(frag);
    } else {
      const desiredSet = new Set<Node>(desiredNodes);
      let cursor: ChildNode | null = logListEl.firstChild;
      for (let i = 0; i < desiredNodes.length; i++) {
        const target = desiredNodes[i];
        while (cursor && !desiredSet.has(cursor)) {
          const next: ChildNode | null = cursor.nextSibling;
          logListEl.removeChild(cursor);
          cursor = next;
        }
        if (cursor === target) {
          cursor = cursor.nextSibling;
        } else {
          logListEl.insertBefore(target, cursor);
        }
      }
      while (cursor) {
        const next: ChildNode | null = cursor.nextSibling;
        logListEl.removeChild(cursor);
        cursor = next;
      }
    }

    if (rowDomCache.size > 1600) {
      for (const id of rowDomCache.keys()) {
        if (!activityLogById.has(id)) {
          rowDomCache.delete(id);
        }
      }
      if (rowDomCache.size > 1600) {
        const activeRowIds = new Set<string>();
        for (let i = startIdx; i < totalCount; i++) {
          activeRowIds.add(filteredEntries[i].id);
        }
        const targetTrim = rowDomCache.size - 1500;
        let trimmed = 0;
        for (const id of rowDomCache.keys()) {
          if (!activeRowIds.has(id)) {
            rowDomCache.delete(id);
            if (++trimmed >= targetTrim) break;
          }
        }
      }
    }
  }

  // 4. Trailing log auto-scroll unless scrolled up
  if (!userHasScrolledLog) {
    requestAnimationFrame(() => {
      logBodyEl.scrollTop = logBodyEl.scrollHeight;
    });
  }
}

// ==================== INTERACTIONS ====================
function wireInteractions(): void {
  // Time-window buttons
  for (const pill of windowPills) {
    pill.addEventListener("click", () => {
      const mode = pill.dataset.mode as TimeWindowMode;
      window.orbitBridge.setTimeWindow(mode);
      fitGraphToViewport(true);
    });
  }

  btnFit.addEventListener("click", () => {
    fitGraphToViewport(true);
  });

  btnDockMode?.addEventListener("click", () => {
    window.orbitBridge.setViewMode("dock");
  });

  btnDockMode?.addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    window.orbitBridge.showContextMenu();
  });

  btnAppMode?.addEventListener("click", () => {
    window.orbitBridge.setViewMode("window");
  });

  btnFullscreen?.addEventListener("click", () => {
    window.orbitBridge.toggleFullScreen();
  });

  window.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault();
      window.orbitBridge.openSettings();
      return;
    }
    if (e.key === "F11") {
      e.preventDefault();
      window.orbitBridge.toggleFullScreen();
      return;
    }
    if (
      e.key === "/" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      const active = document.activeElement as HTMLElement | null;
      const isTyping =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        Boolean(active?.isContentEditable);
      if (!isTyping) {
        e.preventDefault();
        if (!isActivityLogOpen) {
          openActivityLog(null);
        }
        if (logSearchInput) {
          logSearchInput.focus();
          logSearchInput.select();
        }
      }
    }
  });

  btnSize?.addEventListener("click", () => {
    window.orbitBridge.cycleWindowSize();
  });

  btnBurst?.addEventListener("click", () => {
    window.orbitBridge.triggerSimBurst();
  });

  btnClearSim.addEventListener("click", () => {
    window.orbitBridge.clearSimulated();
  });

  btnPin.addEventListener("click", () => {
    if (currentViewMode === "window") {
      window.orbitBridge.setPinned(!currentWindowState.alwaysOnTop);
    } else {
      window.orbitBridge.setPinned(!currentAttachment.isPinned);
    }
  });

  btnSettings?.addEventListener("click", () => {
    window.orbitBridge.openSettings();
  });

  btnMenu?.addEventListener("click", () => {
    window.orbitBridge.showContextMenu();
  });

  needsYouBarEl?.addEventListener("click", e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".needs-you-pill");
    if (!btn) return;
    const nodeId = btn.dataset.nodeId;
    if (nodeId) {
      window.orbitBridge.focusNode(nodeId);
    } else if (btn.classList.contains("overflow")) {
      const allWaiting = latestSnapshot?.nodes.filter(
        n => !n.isSubagent && n.status === "waiting_on_user"
      ) || [];
      const activeWaiting = selectedHarness
        ? allWaiting.filter(n => n.harness === selectedHarness)
        : allWaiting;
      if (activeWaiting.length > 2) {
        window.orbitBridge.focusNode(activeWaiting[2].id);
      }
    }
  });

  // Edge and Corner Drag-to-Resize handles
  const resizeHandles = Array.from(
    document.querySelectorAll<HTMLElement>(".resize-handle")
  );
  let isWindowResizing = false;

  for (const handle of resizeHandles) {
    handle.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const edge = handle.getAttribute("data-resize") as ResizeEdge;
      if (!edge) return;
      isWindowResizing = true;
      window.orbitBridge.startWindowResize(edge);
    });
  }

  window.addEventListener("mouseup", () => {
    if (isWindowResizing) {
      isWindowResizing = false;
      window.orbitBridge.endWindowResize();
    }
  });

  // Trailing Activity Log header buttons & controls
  btnLog?.addEventListener("click", () => {
    if (isActivityLogOpen) {
      if (currentLogScopeNodeId === null) {
        closeActivityLog();
      } else {
        setLogScope(null);
      }
    } else {
      openActivityLog(null);
    }
  });

  btnLogScopeAll.addEventListener("click", () => {
    setLogScope(null);
    fitGraphToViewport(true);
  });

  logScopePillEl?.addEventListener("click", () => {
    if (currentLogScopeNodeId) {
      focusCanvasOnNode(currentLogScopeNodeId);
    }
  });

  logWrapBtn?.addEventListener("click", () => {
    isWrapManuallyToggled = true;
    setWrapState(!isWrapEnabled);
    renderActivityLog();
  });

  btnLogExpand.addEventListener("click", () => {
    isActivityLogExpanded = !isActivityLogExpanded;
    activityLogPanelEl.classList.toggle("expanded", isActivityLogExpanded);
    btnLogExpand.textContent = isActivityLogExpanded ? "⤡" : "⤢";
    btnLogExpand.title = isActivityLogExpanded
      ? "Restore"
      : "Expand log";

    // Auto-expand drawer window to Large if compact (< 600px wide) in dock mode
    const currentW = currentAttachment.drawerWidth || window.innerWidth;
    const isCompact =
      !currentAttachment.sizePreset ||
      currentAttachment.sizePreset === "compact" ||
      currentW < 600;
    if (currentViewMode === "dock" && isActivityLogExpanded && isCompact) {
      window.orbitBridge.cycleWindowSize();
    }

    syncLayoutState();
    updateStageDimensions();
    if (!isActivityLogExpanded) {
      fitGraphToViewport(true);
    }
    if (!userHasScrolledLog) {
      requestAnimationFrame(() => {
        logBodyEl.scrollTop = logBodyEl.scrollHeight;
      });
    }
  });

  btnLogClose.addEventListener("click", () => {
    closeActivityLog();
  });

  wireCategoryFilterBar();

  logSearchInput?.addEventListener("input", () => {
    activeLogSearchQuery = logSearchInput.value;
    logSearchClear?.classList.toggle("hidden", logSearchInput.value.length === 0);
    logVisibleLimit = 250;
    userHasScrolledLog = false;
    logJumpLiveBtn.classList.add("hidden");
    scheduleRenderActivityLog();
  });

  logSearchInput?.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (logSearchInput.value.length > 0) {
        logSearchInput.value = "";
        activeLogSearchQuery = "";
        logSearchClear?.classList.add("hidden");
        logVisibleLimit = 250;
        userHasScrolledLog = false;
        logJumpLiveBtn.classList.add("hidden");
        renderActivityLog();
      } else {
        logSearchInput.blur();
      }
    }
  });

  logSearchClear?.addEventListener("click", () => {
    if (!logSearchInput) return;
    logSearchInput.value = "";
    activeLogSearchQuery = "";
    logSearchClear.classList.add("hidden");
    logVisibleLimit = 250;
    userHasScrolledLog = false;
    logJumpLiveBtn.classList.add("hidden");
    renderActivityLog();
    logSearchInput.focus();
  });

  // Clicking an individual log row toggles expanding its multi-line detail
  logListEl.addEventListener("click", e => {
    if (window.getSelection()?.toString()) return;

    // Handle click on agent chip -> pan/zoom cosmic view directly to that agent
    const agentChip = (e.target as HTMLElement).closest<HTMLElement>(".log-agent-chip");
    if (agentChip) {
      e.preventDefault();
      e.stopPropagation();
      const targetNodeId = agentChip.getAttribute("data-agent-node-id") || "";
      if (targetNodeId) {
        focusCanvasOnNode(targetNodeId);
      }
      return;
    }

    // Handle click-to-open file path / PR URL links on READ / EDIT / WRITE / PLAN / PR rows
    const fileLink = (e.target as HTMLElement).closest<HTMLElement>(".log-file-link");
    if (fileLink) {
      e.preventDefault();
      e.stopPropagation();
      const openPath = fileLink.getAttribute("data-open-path") || "";
      const nodeId = fileLink.getAttribute("data-node-id") || undefined;
      if (openPath && typeof window.orbitBridge?.openFilePath === "function") {
        const isUrl = /^https?:\/\//i.test(openPath);
        const norm = openPath.replace(/\\/g, "/");
        const shortBase = isUrl
          ? "link in browser"
          : (norm.split("/").filter(Boolean).pop() || openPath);
        window.orbitBridge
          .openFilePath(openPath, nodeId)
          .then(res => {
            showFocusToast(
              res.ok ? `Opened ${shortBase}` : (res.error || "File not found"),
              !res.ok
            );
          })
          .catch(() => {
            showFocusToast("File not found", true);
          });
      }
      return;
    }

    // Handle "Show earlier" pagination button
    const loadMoreBtn = (e.target as HTMLElement).closest<HTMLElement>(".log-load-more");
    if (loadMoreBtn) {
      e.stopPropagation();
      logVisibleLimit += 500;
      renderActivityLog();
      return;
    }

    // Handle copy button
    const copyBtn = (e.target as HTMLElement).closest<HTMLElement>(".log-copy-btn");
    if (copyBtn) {
      e.stopPropagation();
      const rowId =
        copyBtn.getAttribute("data-copy-id") ||
        copyBtn.closest<HTMLElement>(".log-row")?.dataset.id ||
        "";
      const textToCopy =
        (rowId ? copyTextByEntryId.get(rowId) : undefined) ??
        copyBtn.getAttribute("data-copy") ??
        "";
      if (textToCopy && navigator.clipboard) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          const orig = copyBtn.textContent;
          copyBtn.textContent = "Copied!";
          setTimeout(() => {
            copyBtn.textContent = orig;
          }, 1400);
        }).catch(() => {});
      }
      return;
    }

    const row = (e.target as HTMLElement).closest<HTMLElement>(".log-row");
    if (!row) return;
    const entryId = row.dataset.id;
    if (!entryId) return;

    if (expandedRowIds.has(entryId)) {
      expandedRowIds.delete(entryId);
    } else {
      expandedRowIds.add(entryId);
      ensureEntryDetailLoaded(entryId);
    }
    renderActivityLog();
  });

  logBodyEl.addEventListener("scroll", () => {
    const distanceToBottom =
      logBodyEl.scrollHeight - logBodyEl.scrollTop - logBodyEl.clientHeight;
    userHasScrolledLog = distanceToBottom > 28;
    logJumpLiveBtn.classList.toggle("hidden", !userHasScrolledLog);
  });

  logJumpLiveBtn.addEventListener("click", () => {
    userHasScrolledLog = false;
    logJumpLiveBtn.classList.add("hidden");
    logBodyEl.scrollTop = logBodyEl.scrollHeight;
  });

  activityLogPanelEl.addEventListener("mouseenter", () => {
    hideHoverCard();
  });

  // Right-click opens native context menu (with agent target if clicked over a node!)
  window.addEventListener("contextmenu", e => {
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const isOverCanvas =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;

    let hitNodeId: string | undefined = undefined;
    if (isOverCanvas) {
      const wpt = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const hit = engine.findNodeAt(wpt.x, wpt.y);
      if (hit) {
        hitNodeId = hit.id;
      }
    }
    window.orbitBridge.showContextMenu(hitNodeId);
  });

  // Magnetic drag-to-any-edge triggers (both Spine grip & Drawer header brand)
  const dragTriggers = Array.from(document.querySelectorAll<HTMLElement>(".drag-trigger"));
  for (const trig of dragTriggers) {
    trig.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      if (currentViewMode === "window" && trig.classList.contains("brand-group")) {
        // Do not trigger startEdgeDrag in window mode; let native titlebar drag handle it!
        return;
      }
      e.stopPropagation();
      window.orbitBridge.startEdgeDrag();
      const onUp = () => {
        window.removeEventListener("mouseup", onUp);
        window.orbitBridge.endEdgeDrag();
      };
      window.addEventListener("mouseup", onUp);
    });
  }

  // Footer harness filter pills
  const legItems = Array.from(
    document.querySelectorAll<HTMLElement>("#footer-harness-legend .leg")
  );
  for (const leg of legItems) {
    const toggleFilter = () => {
      const h = leg.dataset.harness as HarnessKind;
      if (!h) return;
      if (selectedHarness === h) {
        selectedHarness = null;
      } else {
        selectedHarness = h;
      }
      if (latestSnapshot) {
        applySnapshot(latestSnapshot);
        fitGraphToViewport(true);
        window.setTimeout(() => fitGraphToViewport(true), 450);
      }
      if (isActivityLogOpen && currentLogScopeNodeId === null) {
        renderActivityLog();
      }
    };
    leg.addEventListener("click", toggleFilter);
    leg.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleFilter();
      }
    });
  }

  // Footer summary clear filter button
  summaryEl.addEventListener("click", () => {
    if (selectedHarness !== null) {
      selectedHarness = null;
      if (latestSnapshot) {
        applySnapshot(latestSnapshot);
        fitGraphToViewport(true);
        window.setTimeout(() => fitGraphToViewport(true), 450);
      }
      if (isActivityLogOpen && currentLogScopeNodeId === null) {
        renderActivityLog();
      }
    }
  });
  summaryEl.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      if (selectedHarness !== null) {
        e.preventDefault();
        selectedHarness = null;
        if (latestSnapshot) {
          applySnapshot(latestSnapshot);
          fitGraphToViewport(true);
          window.setTimeout(() => fitGraphToViewport(true), 450);
        }
        if (isActivityLogOpen && currentLogScopeNodeId === null) {
          renderActivityLog();
        }
      }
    }
  });

  // Canvas pointer interactions: node hover, node spring-drag/poke, and camera pan/zoom
  canvasEl.addEventListener("mousemove", e => {
    const rect = canvasEl.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wpt = screenToWorld(sx, sy);

    if (draggedNode) {
      if (!pointerMoved) {
        if (Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > 5) {
          pointerMoved = true;
        }
      }
      if (pointerMoved) {
        draggedNode.x = wpt.x;
        draggedNode.y = wpt.y;
        renderHoverCard(draggedNode);
      }
      return;
    }

    if (isPanning) {
      cam.panX = camStartX + (e.clientX - panStartX);
      cam.panY = camStartY + (e.clientY - panStartY);
      targetCam.panX = cam.panX;
      targetCam.panY = cam.panY;
      return;
    }

    const hitCalloutNode = engine.findWaitingCalloutAt(wpt.x, wpt.y);
    for (const n of engine.nodes.values()) {
      n.isCalloutHovered = hitCalloutNode !== null && n === hitCalloutNode;
    }

    if (hitCalloutNode) {
      if (hoveredNode && hoveredNode !== hitCalloutNode) {
        hoveredNode.isHovered = false;
      }
      hoveredNode = hitCalloutNode;
      hoveredNode.isHovered = true;
      canvasEl.style.cursor = "pointer";
      renderHoverCard(hitCalloutNode);
      return;
    }

    const hit = engine.findNodeAt(wpt.x, wpt.y);
    if (hit !== hoveredNode) {
      if (hoveredNode) hoveredNode.isHovered = false;
      hoveredNode = hit;
      if (hoveredNode) hoveredNode.isHovered = true;
    }

    if (hoveredNode) {
      canvasEl.style.cursor = "pointer";
      renderHoverCard(hoveredNode);
    } else {
      canvasEl.style.cursor = "grab";
      hideHoverCard();
    }
  });

  canvasEl.addEventListener("mouseleave", () => {
    for (const n of engine.nodes.values()) {
      n.isCalloutHovered = false;
    }
    if (hoveredNode && !draggedNode) {
      hoveredNode.isHovered = false;
      hoveredNode = null;
    }
    hideHoverCard();
  });

  canvasEl.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    const rect = canvasEl.getBoundingClientRect();
    const wpt = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const hitCallout = engine.findWaitingCalloutAt(wpt.x, wpt.y);
    const hit = hitCallout ?? engine.findNodeAt(wpt.x, wpt.y);

    if (hit) {
      pointerDownCallout = hitCallout;
      pointerDownNode = hit;
      pointerDownX = e.clientX;
      pointerDownY = e.clientY;
      pointerDownTime = performance.now();
      pointerMoved = false;
      draggedNode = hit;
      draggedNode.isDragged = true;
      engine.pokeNode(hit.id);
    } else {
      isPanning = true;
      isCameraAnimating = false;
      cameraFocusNodeId = null;
      panStartX = e.clientX;
      panStartY = e.clientY;
      camStartX = cam.panX;
      camStartY = cam.panY;
    }
  });

  window.addEventListener("mouseup", (e: MouseEvent) => {
    const elapsed = performance.now() - pointerDownTime;
    const dragDist = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);

    if (!pointerMoved && dragDist < 5 && elapsed < 600) {
      const rect = canvasEl.getBoundingClientRect();
      const isOverCanvas =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      if (isOverCanvas) {
        const wpt = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const hitCallout = engine.findWaitingCalloutAt(wpt.x, wpt.y) ?? pointerDownCallout;
        if (hitCallout) {
          window.orbitBridge.focusNode(hitCallout.id);
          showFocusToast(`Focusing ${hitCallout.data.label}`);
          if (draggedNode) {
            draggedNode.isDragged = false;
            draggedNode = null;
          }
          pointerDownNode = null;
          pointerDownCallout = null;
          isPanning = false;
          return;
        }
      }

      const targetNode = pointerDownNode;
      if (targetNode) {
        engine.pokeNode(targetNode.id);
        if (isActivityLogOpen && currentLogScopeNodeId === targetNode.id) {
          if (isSplitLayout()) {
            setLogScope(null);
          } else {
            closeActivityLog();
          }
        } else {
          openActivityLog(targetNode.id);
        }
      }
    }

    if (draggedNode) {
      draggedNode.isDragged = false;
      draggedNode.boingVel += 0.25;
      draggedNode = null;
    }
    pointerDownNode = null;
    pointerDownCallout = null;
    isPanning = false;
  });

  canvasEl.addEventListener(
    "wheel",
    e => {
      e.preventDefault();
      isCameraAnimating = false;
      cameraFocusNodeId = null;
      const factor = e.deltaY < 0 ? 1.09 : 0.91;
      cam.zoom = Math.max(0.14, Math.min(2.4, cam.zoom * factor));
      targetCam.zoom = cam.zoom;
      targetCam.panX = cam.panX;
      targetCam.panY = cam.panY;
    },
    { passive: false }
  );

  window.addEventListener("resize", () => {
    if (currentLogSplitWidthPx !== null) {
      const maxW = Math.max(320, Math.floor(workspaceBodyEl.clientWidth * 0.7));
      if (currentLogSplitWidthPx > maxW) {
        currentLogSplitWidthPx = maxW;
        workspaceBodyEl.style.setProperty("--log-split-width", `${maxW}px`);
      }
    }
    updateStageDimensions();
    fitGraphToViewport(false);
    if (!isWrapManuallyToggled) {
      const shouldWrap = window.innerWidth >= 650 || currentViewMode === "window";
      if (shouldWrap !== isWrapEnabled) {
        setWrapState(shouldWrap);
        if (isActivityLogOpen) {
          renderActivityLog();
        }
      }
    }
  });
}

// ==================== MAIN 60FPS LOOP ====================
let lastFrameTs = performance.now();
function animate(now: number): void {
  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTs) / 1000));
  lastFrameTs = now;

  if (document.hidden) {
    requestAnimationFrame(animate);
    return;
  }

  // Smooth dt-independent camera interpolation towards target framing
  if (isCameraAnimating) {
    if (cameraFocusNodeId) {
      const liveFocusNode = engine.nodes.get(cameraFocusNodeId);
      if (liveFocusNode) {
        const isLogPartiallyOpen =
          isActivityLogOpen && !isActivityLogExpanded && !isSplitLayout();
        const yShift = isLogPartiallyOpen ? -stageH * 0.24 : 0;
        targetCam.panX = -(liveFocusNode.x - stageW * 0.5) * targetCam.zoom;
        targetCam.panY = -(liveFocusNode.y - stageH * 0.5) * targetCam.zoom + yShift;
      } else {
        cameraFocusNodeId = null;
      }
    }

    const lerp = 1 - Math.exp(-3.2 * dt);
    cam.panX += (targetCam.panX - cam.panX) * lerp;
    cam.panY += (targetCam.panY - cam.panY) * lerp;
    cam.zoom += (targetCam.zoom - cam.zoom) * lerp;

    if (
      Math.abs(targetCam.panX - cam.panX) < 0.2 &&
      Math.abs(targetCam.panY - cam.panY) < 0.2 &&
      Math.abs(targetCam.zoom - cam.zoom) < 0.002
    ) {
      cam.panX = targetCam.panX;
      cam.panY = targetCam.panY;
      cam.zoom = targetCam.zoom;
      isCameraAnimating = false;
      cameraFocusNodeId = null;
    }
  }

  // Always step physics smoothly in window mode, or when expanded, or during camera/pulse animations
  if (
    currentViewMode === "window" ||
    currentAttachment.isExpanded ||
    engine.hasActiveAnimations() ||
    isCameraAnimating
  ) {
    engine.step(dt);
    renderer.render(engine, stageW, stageH, cam);
  }

  requestAnimationFrame(animate);
}

// Lightweight 5s relative-time ticker for visible Activity Log rows (zero HTML rebuild)
window.setInterval(() => {
  if (!isActivityLogOpen || document.hidden) return;
  const now = Date.now();
  for (
    let child = logListEl.firstElementChild as HTMLElement | null;
    child;
    child = child.nextElementSibling as HTMLElement | null
  ) {
    const id = child.dataset.id;
    if (!id) continue;
    const cached = rowDomCache.get(id);
    if (cached && cached.timeEl) {
      const nextRel = formatRelativeTime(cached.timestamp, now);
      if (cached.timeEl.textContent !== nextRel) {
        cached.timeEl.textContent = nextRel;
      }
    }
  }
}, 5000);

async function boot(): Promise<void> {
  wireInteractions();
  initSplitResizer();
  updateStageDimensions();

  // In window mode, open Activity Log by default scoped to All Agents with Wrap enabled (unless hideLog is requested)
  if (currentViewMode === "window" && urlParams.get("hideLog") !== "1") {
    setWrapState(true);
    openActivityLog(null);
  }

  window.orbitBridge.onWindowState(state => applyWindowState(state));
  window.orbitBridge.onAttachment(att => applyAttachment(att));
  window.orbitBridge.onGraphSnapshot(snap => applySnapshot(snap));
  window.orbitBridge.onPulse(pulse => handlePulse(pulse));
  window.orbitBridge.onFocusResult(res => {
    const target = res.targetApp || res.windowTitle || "window";
    const msg = res.ok ? `↗ Switched to ${target}` : (res.reason || "No active window found");
    showFocusToast(msg, !res.ok);
  });
  window.orbitBridge.onOpenLog(nodeId => {
    openActivityLog(nodeId ?? null);
  });
  window.orbitBridge.onSettingsChanged(settings => {
    engine.setAnimationSpeed(settings.animationSpeed);
  });

  const init = await window.orbitBridge.getInitialState();
  if (typeof init.animationSpeed === "number") {
    engine.setAnimationSpeed(init.animationSpeed);
  }
  if (init.attachment) applyAttachment(init.attachment);
  if (init.graph) applySnapshot(init.graph);
  if (init.windowState) {
    applyWindowState(init.windowState);
    if (init.windowState.viewMode === "window" && !isActivityLogOpen && !init.hideLog) {
      setWrapState(true);
      openActivityLog(null);
    }
  }

  requestAnimationFrame(animate);
}

if (urlMode === "settings" && settingsShellEl) {
  document.documentElement.dataset.viewMode = "settings";
  document.body.dataset.viewMode = "settings";
  rootEl.classList.add("hidden");
  settingsShellEl.classList.remove("hidden");
  void initSettingsView(settingsShellEl);
} else {
  boot();
}
