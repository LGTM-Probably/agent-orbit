import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import fs from "fs";
import path from "path";
import {
  AgentNodeSnapshot,
  AppViewMode,
  DrawerSizePreset,
  EdgeSide,
  FocusResult,
  GraphSnapshotPayload,
  LivePulseEvent,
  OpenFileResult,
  OrbitSettings,
  ResizeEdge,
  TimeWindowMode,
  WindowStateInfo,
} from "../shared/types";
import { EdgeWindowController } from "./edgeWindow";
import {
  GraphStore,
  resolveOpenableFilePath,
  sanitizeExternalHttpUrl,
  shouldRevealInsteadOfExecute,
} from "./graphStore";
import { SwarmSimulator } from "./simulator";
import { TranscriptTailer } from "./tailer";
import { buildOrbitContextMenu, createOrbitTray } from "./tray";
import { focusAgentNodeWindow } from "./windowFocus";

// Prevent multiple instances fighting over the screen edge (unless in headless capture/smoke mode)
const isCaptureMode =
  process.argv.includes("--capture-preview") ||
  process.argv.includes("--capture-demo") ||
  process.argv.includes("--capture-live") ||
  process.argv.includes("--smoke-exit");

let isQuitting = false;
let appWindow: BrowserWindow | null = null;
let dockWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let edgeController: EdgeWindowController | null = null;
let activeMode: AppViewMode = "window";
let lastWaitingIds = new Set<string>();
let lastOverlayWaitingCount = -1;
let isFlashingFrame = false;
let cachedAmberBadge: Electron.NativeImage | null = null;
let lastWaitingJumpId: string | null = null;
const lastSentLogSeq = new Map<number, number>();

function getAmberBadgeImage(): Electron.NativeImage {
  if (cachedAmberBadge) return cachedAmberBadge;
  const width = 16;
  const height = 16;
  const buf = Buffer.alloc(width * height * 4);
  const cx = 7.5;
  const cy = 7.5;
  const r = 6.5;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let alpha = 0;
      if (dist <= r - 0.75) {
        alpha = 1;
      } else if (dist <= r + 0.75) {
        alpha = (r + 0.75 - dist) / 1.5;
      }
      if (alpha > 0) {
        const offset = (y * width + x) * 4;
        if (process.platform === "darwin") {
          buf[offset + 0] = Math.round(245 * alpha); // R
          buf[offset + 1] = Math.round(158 * alpha); // G
          buf[offset + 2] = Math.round(11 * alpha);  // B
          buf[offset + 3] = Math.round(255 * alpha); // A
        } else {
          buf[offset + 0] = Math.round(11 * alpha);  // B
          buf[offset + 1] = Math.round(158 * alpha); // G
          buf[offset + 2] = Math.round(245 * alpha); // R
          buf[offset + 3] = Math.round(255 * alpha); // A
        }
      }
    }
  }
  cachedAmberBadge = nativeImage.createFromBitmap(buf, { width, height });
  return cachedAmberBadge;
}

const graphStore = new GraphStore();
const tailer = new TranscriptTailer(graphStore);
const simulator = new SwarmSimulator(graphStore);

function resolveWindowIconPath(): string | undefined {
  const assetsDir = path.resolve(__dirname, "../../assets");
  const candidates =
    process.platform === "win32"
      ? [path.join(assetsDir, "orbit.ico"), path.join(assetsDir, "orbit.png")]
      : [path.join(assetsDir, "orbit.png"), path.join(assetsDir, "orbit.ico")];
  return candidates.find(p => fs.existsSync(p));
}

function getTitleBarOptions(): Partial<Electron.BrowserWindowConstructorOptions> {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 11 },
    };
  }
  return {
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0d1424",
      symbolColor: "#cbd5e1",
      height: 38,
    },
  };
}

function showWindowReliable(win: BrowserWindow): void {
  if (process.platform === "win32") {
    // First ShowWindow call on Win32 consumes STARTUPINFO.wShowWindow=SW_HIDE;
    // cycling show -> hide -> show forces Win32 WS_VISIBLE=true!
    win.show();
    win.hide();
    win.show();
  } else {
    win.show();
  }
}

function toggleMainFullScreen(): void {
  if (activeMode === "dock") {
    switchViewMode("window");
    appWindow?.setFullScreen(true);
  } else if (appWindow && !appWindow.isDestroyed()) {
    appWindow.setFullScreen(!appWindow.isFullScreen());
  }
}

function openActivityLogInActiveWindow(): void {
  const targetWin = activeMode === "window" ? appWindow : dockWindow;
  if (activeMode === "window" && appWindow && !appWindow.isDestroyed()) {
    if (appWindow.isMinimized()) appWindow.restore();
    appWindow.show();
    appWindow.focus();
  } else if (activeMode === "dock") {
    edgeController?.setPinned(true);
  }
  if (targetWin && !targetWin.isDestroyed()) {
    targetWin.webContents.send("orbit:open-log", undefined);
  }
}

function installMacApplicationMenu(): void {
  if (process.platform !== "darwin") return;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Agent Orbit",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => openSettingsWindow(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        {
          label: "Quit Agent Orbit",
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit(),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Fullscreen",
          accelerator: "Ctrl+Command+F",
          click: () => toggleMainFullScreen(),
        },
        {
          label: "View Activity Log",
          click: () => openActivityLogInActiveWindow(),
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getWindowState(): WindowStateInfo {
  const isMax = appWindow && !appWindow.isDestroyed() ? appWindow.isMaximized() : false;
  const isFull = appWindow && !appWindow.isDestroyed() ? appWindow.isFullScreen() : false;
  const alwaysOnTop = appWindow && !appWindow.isDestroyed() ? appWindow.isAlwaysOnTop() : false;
  return {
    viewMode: activeMode,
    isMaximized: isMax,
    isFullScreen: isFull,
    alwaysOnTop,
    platform: process.platform,
  };
}

function updateAppWindowTaskbarState(nodes: AgentNodeSnapshot[]): void {
  const waitingNodes = nodes.filter(n => !n.isSubagent && n.status === "waiting_on_user");
  const hasNewlyWaiting = waitingNodes.some(n => !lastWaitingIds.has(n.id));
  lastWaitingIds = new Set(waitingNodes.map(n => n.id));
  const allowFlash = Boolean(edgeController?.getFlashTaskbarOnWaiting());

  if (process.platform === "darwin") {
    if (waitingNodes.length !== lastOverlayWaitingCount) {
      lastOverlayWaitingCount = waitingNodes.length;
      try {
        app.dock?.setBadge(waitingNodes.length > 0 ? String(waitingNodes.length) : "");
      } catch {}
    }
    if (
      allowFlash &&
      hasNewlyWaiting &&
      !isCaptureMode &&
      (!appWindow || appWindow.isDestroyed() || !appWindow.isFocused())
    ) {
      try {
        app.dock?.bounce("informational");
      } catch {}
    }
    return;
  }

  if (!appWindow || appWindow.isDestroyed() || process.platform !== "win32") {
    return;
  }

  if (waitingNodes.length !== lastOverlayWaitingCount) {
    lastOverlayWaitingCount = waitingNodes.length;
    try {
      if (waitingNodes.length > 0) {
        appWindow.setOverlayIcon(
          getAmberBadgeImage(),
          `${waitingNodes.length} agent(s) waiting on you`
        );
      } else {
        appWindow.setOverlayIcon(null, "");
      }
    } catch {}
  }

  if (!allowFlash || waitingNodes.length === 0) {
    isFlashingFrame = false;
    try {
      appWindow.flashFrame(false);
    } catch {}
  } else if (allowFlash && hasNewlyWaiting && !isCaptureMode && !appWindow.isFocused()) {
    try {
      isFlashingFrame = true;
      appWindow.flashFrame(true);
      appWindow.once("focus", () => {
        isFlashingFrame = false;
        try {
          appWindow?.flashFrame(false);
        } catch {}
      });
    } catch {}
  }
}

function setFlashTaskbarOnWaiting(enabled: boolean): void {
  const next = Boolean(enabled);
  edgeController?.setFlashTaskbarOnWaiting(next);
  if (!next && appWindow && !appWindow.isDestroyed()) {
    isFlashingFrame = false;
    try {
      appWindow.flashFrame(false);
    } catch {}
  }
  if (tray) {
    (tray as any).rebuildMenu?.();
  }
  broadcastSettingsChanged();
}

function getOrbitSettings(): OrbitSettings {
  const att = edgeController?.getAttachment();
  const alwaysOnTop =
    appWindow && !appWindow.isDestroyed() ? appWindow.isAlwaysOnTop() : false;
  const appRoot = path.resolve(__dirname, "../..");
  let openAtLogin = false;
  try {
    const loginOpts =
      process.platform === "darwin" || app.isPackaged
        ? undefined
        : { path: process.execPath, args: [appRoot] };
    openAtLogin = Boolean(app.getLoginItemSettings(loginOpts).openAtLogin);
  } catch {}

  const simActive = graphStore.getSnapshot(Date.now(), {
    stripHeavyLogFields: true,
    sinceLogSeq: Number.MAX_SAFE_INTEGER,
  }).simActive;

  return {
    animationSpeed: edgeController?.getAnimationSpeed() ?? 1,
    viewMode: activeMode,
    dockEdge: att?.edge ?? "right",
    sizePreset: att?.sizePreset ?? "compact",
    isPinned: att?.isPinned ?? false,
    alwaysOnTop,
    flashTaskbarOnWaiting: Boolean(edgeController?.getFlashTaskbarOnWaiting()),
    openAtLogin,
    simActive,
    platform: process.platform,
  };
}

function broadcastSettingsChanged(): void {
  const settings = getOrbitSettings();
  for (const win of [appWindow, dockWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("orbit:settings-changed", settings);
    }
  }
  if (tray) {
    (tray as any).rebuildMenu?.();
  }
}

function hardenWindowSecurity(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => {
    event.preventDefault();
  });
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
  } catch {}
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  const iconPath = resolveWindowIconPath();
  const primaryWa = screen.getPrimaryDisplay().workArea;
  const winW = Math.min(760, Math.max(620, primaryWa.width - 80));
  const winH = Math.min(620, Math.max(460, primaryWa.height - 80));

  let startX = Math.round(primaryWa.x + (primaryWa.width - winW) / 2);
  let startY = Math.round(primaryWa.y + (primaryWa.height - winH) / 2);

  if (activeMode === "window" && appWindow && !appWindow.isDestroyed() && appWindow.isVisible()) {
    const ab = appWindow.getBounds();
    const disp = screen.getDisplayMatching(ab);
    const wa = disp.workArea;
    startX = Math.max(wa.x + 16, Math.min(wa.x + wa.width - winW - 16, Math.round(ab.x + (ab.width - winW) / 2)));
    startY = Math.max(wa.y + 16, Math.min(wa.y + wa.height - winH - 16, Math.round(ab.y + (ab.height - winH) / 2)));
  }

  settingsWindow = new BrowserWindow({
    title: "Agent Orbit — Settings",
    ...(iconPath ? { icon: iconPath } : {}),
    show: false,
    x: startX,
    y: startY,
    width: winW,
    height: winH,
    minWidth: 620,
    minHeight: 460,
    transparent: false,
    backgroundColor: "#0a0f1b",
    ...getTitleBarOptions(),
    autoHideMenuBar: true,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: activeMode === "dock",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  if (process.platform !== "darwin") {
    settingsWindow.setMenu(null);
  }
  hardenWindowSecurity(settingsWindow);
  settingsWindow.on("page-title-updated", e => e.preventDefault());

  settingsWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      settingsWindow?.close();
    }
  });

  settingsWindow.webContents.once("did-finish-load", () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    showWindowReliable(settingsWindow);
    settingsWindow.focus();
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  const rendererHtml = path.resolve(__dirname, "../../dist-renderer/index.html");
  settingsWindow.loadFile(rendererHtml, { query: { mode: "settings" } });
}

function broadcastWindowState(): void {
  const state = getWindowState();
  const targetWin = activeMode === "window" ? appWindow : dockWindow;
  if (targetWin && !targetWin.isDestroyed()) {
    targetWin.webContents.send("orbit:window-state", state);
  }
  broadcastSettingsChanged();
}

function switchViewMode(nextMode: AppViewMode, dockEdge?: EdgeSide): void {
  activeMode = nextMode;
  edgeController?.setViewMode(nextMode);

  if (nextMode === "dock") {
    const alreadyExisted = Boolean(dockWindow && !dockWindow.isDestroyed());
    const win = createDockWindow();
    if (dockEdge && edgeController) {
      edgeController.setDockEdge(dockEdge);
    }
    if (appWindow && !appWindow.isDestroyed()) {
      if (appWindow.isFullScreen()) {
        appWindow.setFullScreen(false);
      }
      appWindow.hide();
    }
    edgeController?.setPaused(false);
    if (alreadyExisted && !win.webContents.isLoading()) {
      const wcId = win.webContents.id;
      lastSentLogSeq.delete(wcId);
      const snap = graphStore.getSnapshot(Date.now(), { stripHeavyLogFields: true });
      lastSentLogSeq.set(wcId, snap.logSeq ?? 0);
      win.webContents.send("orbit:snapshot", snap);
    }
  } else {
    // nextMode === "window"
    edgeController?.setPaused(true);
    const alreadyExisted = Boolean(appWindow && !appWindow.isDestroyed());
    const win = createAppWindow();
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    if (alreadyExisted && !win.webContents.isLoading()) {
      const wcId = win.webContents.id;
      lastSentLogSeq.delete(wcId);
      const snap = graphStore.getSnapshot(Date.now(), { stripHeavyLogFields: true });
      lastSentLogSeq.set(wcId, snap.logSeq ?? 0);
      win.webContents.send("orbit:snapshot", snap);
      updateAppWindowTaskbarState(snap.nodes);
    }
  }

  broadcastWindowState();
}

function createDockWindow(): BrowserWindow {
  if (dockWindow && !dockWindow.isDestroyed()) {
    return dockWindow;
  }

  const initAtt = edgeController!.getAttachment();
  const iconPath = resolveWindowIconPath();
  dockWindow = new BrowserWindow({
    title: "",
    ...(iconPath ? { icon: iconPath } : {}),
    show: false,
    width: initAtt.drawerWidth,
    height: initAtt.drawerHeight,
    frame: false,
    thickFrame: false,
    autoHideMenuBar: true,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  if (process.platform !== "darwin") {
    dockWindow.setMenu(null);
  }
  hardenWindowSecurity(dockWindow);
  dockWindow.on("page-title-updated", e => e.preventDefault());
  dockWindow.on("blur", () => {
    edgeController?.reapplyShape();
  });
  dockWindow.on("focus", () => {
    edgeController?.reapplyShape();
  });

  dockWindow.webContents.on("console-message", event => {
    console.log(
      `[DOCK RENDERER ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`
    );
  });

  dockWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && (input.control || input.meta) && input.key === ",") {
      event.preventDefault();
      openSettingsWindow();
    }
  });

  dockWindow.webContents.once("did-finish-load", () => {
    if (!dockWindow || dockWindow.isDestroyed()) return;
    if (activeMode === "dock") {
      showWindowReliable(dockWindow);
      dockWindow.setAlwaysOnTop(true, "screen-saver");
      dockWindow.moveTop();
      edgeController?.reapplyBoundsAndShow();
    }
  });

  const dockWcId = dockWindow.webContents.id;
  dockWindow.on("closed", () => {
    lastSentLogSeq.delete(dockWcId);
  });

  const rendererHtml = path.resolve(__dirname, "../../dist-renderer/index.html");
  dockWindow.loadFile(rendererHtml, { query: { mode: "dock" } });
  edgeController!.attachWindow(dockWindow);

  return dockWindow;
}

function createAppWindow(): BrowserWindow {
  if (appWindow && !appWindow.isDestroyed()) {
    return appWindow;
  }

  lastOverlayWaitingCount = -1;
  isFlashingFrame = false;

  const iconPath = resolveWindowIconPath();
  const initialBounds = edgeController!.getAppWindowBounds();

  appWindow = new BrowserWindow({
    title: "Agent Orbit",
    ...(iconPath ? { icon: iconPath } : {}),
    show: false,
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: 520,
    minHeight: 420,
    transparent: false,
    backgroundColor: "#0a0f1b",
    ...getTitleBarOptions(),
    autoHideMenuBar: true,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  if (process.platform !== "darwin") {
    appWindow.setMenu(null);
  }
  hardenWindowSecurity(appWindow);
  appWindow.on("page-title-updated", e => e.preventDefault());

  appWindow.webContents.on("console-message", event => {
    console.log(
      `[APP RENDERER ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`
    );
  });

  appWindow.webContents.once("did-finish-load", () => {
    if (!appWindow || appWindow.isDestroyed()) return;
    try {
      appWindow.flashFrame(false);
    } catch {}
    if (activeMode === "window") {
      showWindowReliable(appWindow);
      if (initialBounds.isMaximized) {
        appWindow.maximize();
      }
      appWindow.focus();
    }
    const snap = graphStore.getSnapshot(Date.now(), {
      stripHeavyLogFields: true,
      sinceLogSeq: Number.MAX_SAFE_INTEGER,
    });
    updateAppWindowTaskbarState(snap.nodes);
  });

  const appWcId = appWindow.webContents.id;
  appWindow.on("closed", () => {
    lastSentLogSeq.delete(appWcId);
    lastOverlayWaitingCount = -1;
    isFlashingFrame = false;
  });

  // Keyboard shortcuts
  appWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && (input.control || input.meta) && input.key === ",") {
      event.preventDefault();
      openSettingsWindow();
    } else if (
      input.type === "keyDown" &&
      (input.key === "F11" ||
        (process.platform === "darwin" &&
          input.control &&
          input.meta &&
          input.key.toLowerCase() === "f"))
    ) {
      event.preventDefault();
      appWindow?.setFullScreen(!appWindow.isFullScreen());
    } else if (input.type === "keyDown" && input.key === "Escape" && appWindow?.isFullScreen()) {
      event.preventDefault();
      appWindow?.setFullScreen(false);
    }
  });

  // Bounds & state persistence listeners
  let saveBoundsTimeout: NodeJS.Timeout | null = null;
  const scheduleSaveBounds = () => {
    if (isCaptureMode) return;
    if (saveBoundsTimeout) clearTimeout(saveBoundsTimeout);
    saveBoundsTimeout = setTimeout(() => {
      if (!appWindow || appWindow.isDestroyed()) return;
      const isMax = appWindow.isMaximized();
      const isFull = appWindow.isFullScreen();
      if (!isMax && !isFull) {
        const b = appWindow.getBounds();
        edgeController?.setAppWindowBounds({
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          isMaximized: false,
        });
      } else if (isMax) {
        const cur = edgeController?.getAppWindowBounds();
        if (cur) {
          edgeController?.setAppWindowBounds({
            ...cur,
            isMaximized: true,
          });
        }
      }
    }, 250);
  };

  const handleWindowStateChange = () => {
    scheduleSaveBounds();
    broadcastWindowState();
  };

  appWindow.on("maximize", handleWindowStateChange);
  appWindow.on("unmaximize", handleWindowStateChange);
  appWindow.on("enter-full-screen", handleWindowStateChange);
  appWindow.on("leave-full-screen", handleWindowStateChange);
  appWindow.on("resize", scheduleSaveBounds);
  appWindow.on("move", scheduleSaveBounds);

  appWindow.on("close", event => {
    if (!isQuitting) {
      event.preventDefault();
      appWindow?.hide();
    }
  });

  const rendererHtml = path.resolve(__dirname, "../../dist-renderer/index.html");
  const isPreview = process.argv.includes("--capture-preview");
  const query: Record<string, string> = { mode: "window" };
  if (isPreview) {
    query.hideLog = "1";
  }
  appWindow.loadFile(rendererHtml, { query });

  return appWindow;
}

function setupAutomationHooks(): void {
  const liveIdx = process.argv.indexOf("--capture-live");
  const previewIdx = process.argv.indexOf("--capture-preview");
  const demoIdx = process.argv.indexOf("--capture-demo");

  if (demoIdx >= 0 && process.argv[demoIdx + 1]) {
    const outDir = process.argv[demoIdx + 1];
    appWindow?.webContents.once("did-finish-load", () => {
      void (async () => {
        try {
          if (!appWindow || appWindow.isDestroyed()) return;
          if (appWindow.isMaximized()) appWindow.unmaximize();
          appWindow.setSize(1360, 820);
          appWindow.center();
          appWindow.show();

          graphStore.setTimeWindow("30m");
          simulator.spawnCosmicShowcase();

          // Temporarily boost animation speed slightly for an engaging 8s clip (without saving to disk)
          appWindow.webContents.send("orbit:settings-changed", {
            ...getOrbitSettings(),
            animationSpeed: 1.45,
          });

          const hyperionId = "claude:sim-hyperion-star";
          const claudeId = "claude:sim-claude-star";
          const seedNow = Date.now();

          graphStore.recordToolStart(hyperionId, {
            callId: "demo-search-1",
            name: "Grep",
            target: '"OrbitDispatcher" in src/cluster',
            summary: 'Search "OrbitDispatcher" across src/cluster',
            toolInput: JSON.stringify(
              { pattern: "OrbitDispatcher", path: "src/cluster", glob: "*.ts" },
              null,
              2
            ),
            timestamp: seedNow + 10,
            isLive: false,
          });
          graphStore.recordToolEnd(hyperionId, {
            callId: "demo-search-1",
            durationMs: 140,
            output: "src/cluster/OrbitDispatcher.ts:42: export class OrbitDispatcher {\nsrc/cluster/ShardRouter.ts:18: private dispatcher: OrbitDispatcher;",
            timestamp: seedNow + 150,
            isLive: false,
          });

          const diffSample = [
            "  export function checkQuota(tokens: number, burstCap = 120): boolean {",
            "-   return tokens <= burstCap;",
            "+   const headroom = Math.max(burstCap, 250);",
            "+   return tokens <= headroom;",
            "  }",
          ].join("\n");

          graphStore.recordToolStart(hyperionId, {
            callId: "demo-edit-ratelimit",
            name: "Edit",
            target: "src/gateway/rateLimiter.ts",
            filePath: "src/gateway/rateLimiter.ts",
            summary: "src/gateway/rateLimiter.ts",
            linesAdded: 2,
            linesRemoved: 1,
            diffPreview: diffSample,
            toolInput: JSON.stringify(
              { file_path: "src/gateway/rateLimiter.ts", replace_all: false },
              null,
              2
            ),
            timestamp: seedNow + 220,
            isLive: false,
          });
          graphStore.recordToolEnd(hyperionId, {
            callId: "demo-edit-ratelimit",
            durationMs: 310,
            timestamp: seedNow + 530,
            isLive: false,
          });

          // Ensure split-pane Activity Log is open at a crisp width and fit constellation
          await appWindow.webContents.executeJavaScript(`
            (() => {
              const panel = document.getElementById('activity-log-panel');
              if (panel && panel.classList.contains('hidden')) {
                document.getElementById('btn-log')?.click();
              }
              window.dispatchEvent(new Event('resize'));
              document.getElementById('btn-fit')?.click();
            })();
          `);

          // Let springs & orbits settle gracefully before recording starts
          await new Promise(r => setTimeout(r, 2600));
          await appWindow.webContents.executeJavaScript(`
            document.getElementById('btn-fit')?.click();
          `);
          await new Promise(r => setTimeout(r, 700));

          fs.mkdirSync(outDir, { recursive: true });
          const totalFrames = 120; // 8.00s @ 15 fps
          const durationMs = 8000;
          const startPerf = performance.now();
          let spawnedProbe = false;
          let zoomedHyperion = false;
          let triggeredReentry = false;
          let expandedDiff = false;
          let postedPr = false;

          for (let i = 0; i < totalFrames; i++) {
            const targetElapsed = (i * durationMs) / totalFrames;

            if (!spawnedProbe && targetElapsed >= 700) {
              spawnedProbe = true;
              const probeId = `${claudeId}:sub:demo-query-planner`;
              graphStore.upsertNode({
                id: probeId,
                rawId: "demo-query-planner",
                harness: "claude",
                parentId: claudeId,
                isSubagent: true,
                label: "Query Planner",
                isCustomLabel: true,
                project: "nebula-gateway",
                cwd: "C:/code/nebula-gateway",
                model: "claude-opus-4-6",
                timestamp: Date.now(),
                isSimulated: true,
                emitSpawnPulse: true,
              });
              graphStore.recordToolStart(probeId, {
                callId: "demo-probe-test",
                name: "Bash",
                target: "npm test -- ShardRouter",
                summary: "Run ShardRouter unit suite",
                rawCommand: "npm test -- ShardRouter",
                timestamp: Date.now(),
                isLive: true,
              });
            }

            if (!zoomedHyperion && targetElapsed >= 2100) {
              zoomedHyperion = true;
              await appWindow.webContents.executeJavaScript(`
                (() => {
                  const chip = document.querySelector('.log-agent-chip[data-agent-node-id="claude:sim-hyperion-star"]');
                  if (chip) chip.click();
                })();
              `);
            }

            if (!triggeredReentry && targetElapsed >= 3500) {
              triggeredReentry = true;
              for (let t = 0; t < 18; t++) {
                graphStore.recordModelTurn(
                  "claude:sim-hyperion-star:sub:1",
                  `demo-turn-${t}`
                );
              }
              // Complete an active subagent on hyperion-cloud in close-up -> Solar Accretion Flare + Spiral Re-Entry!
              graphStore.markCompleted(
                "claude:sim-hyperion-star:sub:1",
                Date.now(),
                true,
                {
                  durationMs: 4820,
                  subagentToolCount: 7,
                  model: "claude-opus-4-6[1m]",
                }
              );
            }

            if (!expandedDiff && targetElapsed >= 5200) {
              expandedDiff = true;
              await appWindow.webContents.executeJavaScript(`
                (() => {
                  const row = document.querySelector('.log-row[data-id="claude:sim-hyperion-star:tool:demo-edit-ratelimit"]');
                  if (row) {
                    row.click();
                    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  }
                })();
              `);
            }

            if (!postedPr && targetElapsed >= 6700) {
              postedPr = true;
              graphStore.recordToolStart(hyperionId, {
                callId: "demo-pr-412",
                name: "pr-link",
                target: "https://github.com/acme-org/hyperion-cloud/pull/412",
                filePath: "https://github.com/acme-org/hyperion-cloud/pull/412",
                summary: "https://github.com/acme-org/hyperion-cloud/pull/412",
                toolInput: JSON.stringify(
                  { prNumber: 412, repository: "acme-org/hyperion-cloud" },
                  null,
                  2
                ),
                timestamp: Date.now(),
                isLive: true,
              });
              graphStore.recordToolEnd(hyperionId, {
                callId: "demo-pr-412",
                durationMs: 80,
                timestamp: Date.now(),
                isLive: true,
              });
            }

            const nowPerf = performance.now() - startPerf;
            if (targetElapsed > nowPerf) {
              await new Promise(r => setTimeout(r, targetElapsed - nowPerf));
            }

            const img = await appWindow.webContents.capturePage();
            const frameFile = path.join(
              outDir,
              `frame_${String(i).padStart(4, "0")}.png`
            );
            fs.writeFileSync(frameFile, img.toPNG());
          }

          console.log(`DEMO_FRAMES_SAVED ${outDir} count=${totalFrames}`);
        } catch (err) {
          console.error("DEMO_CAPTURE_ERR", err);
        } finally {
          app.quit();
        }
      })();
    });
  } else if (liveIdx >= 0 && process.argv[liveIdx + 1]) {
    const outPng = process.argv[liveIdx + 1];
    dockWindow?.webContents.once("did-finish-load", () => {
      edgeController?.setPinned(true);
      graphStore.setTimeWindow("30m");
      setTimeout(async () => {
        try {
          if (dockWindow && !dockWindow.isDestroyed()) {
            const img = await dockWindow.webContents.capturePage();
            const parentDir = path.dirname(outPng);
            if (!fs.existsSync(parentDir)) {
              fs.mkdirSync(parentDir, { recursive: true });
            }
            fs.writeFileSync(outPng, img.toPNG());
            console.log(`LIVE_SAVED ${outPng}`);
          }
        } catch (err) {
          console.error("CAPTURE_ERR", err);
        } finally {
          app.quit();
        }
      }, 3300);
    });
  } else if (previewIdx >= 0 && process.argv[previewIdx + 1]) {
    const outPng = process.argv[previewIdx + 1];
    appWindow?.webContents.once("did-finish-load", () => {
      if (appWindow?.isMaximized()) appWindow.unmaximize();
      appWindow?.setSize(1440, 900);
      appWindow?.center();
      appWindow?.show();
      graphStore.setTimeWindow("30m");
      simulator.spawnCosmicShowcase();
      setTimeout(async () => {
        try {
          if (appWindow && !appWindow.isDestroyed()) {
            await appWindow.webContents.executeJavaScript(`
              document.getElementById('btn-log-close')?.click();
              window.dispatchEvent(new Event('resize'));
              document.getElementById('btn-fit')?.click();
            `);
            await new Promise(r => setTimeout(r, 1100));
            const img = await appWindow.webContents.capturePage();
            const parentDir = path.dirname(outPng);
            if (!fs.existsSync(parentDir)) {
              fs.mkdirSync(parentDir, { recursive: true });
            }
            fs.writeFileSync(outPng, img.toPNG());
            console.log(`PREVIEW_SAVED ${outPng}`);
          }
        } catch (err) {
          console.error("CAPTURE_ERR", err);
        } finally {
          app.quit();
        }
      }, 4800);
    });
  } else if (process.argv.includes("--smoke-exit")) {
    dockWindow?.webContents.once("did-finish-load", () => {
      edgeController?.setPinned(true);
      setTimeout(() => {
        try {
          if (process.platform === "win32" && dockWindow && !dockWindow.isDestroyed()) {
            const focusExe = path.resolve(__dirname, "../../assets/orbit-focus.exe");
            if (fs.existsSync(focusExe)) {
              const hwndBuf = dockWindow.getNativeWindowHandle();
              const hwnd = hwndBuf.readBigInt64LE(0).toString();
              const { execFileSync } = require("child_process");
              const rgnOut = execFileSync(focusExe, ["--check-rgn", hwnd], { encoding: "utf8" }).trim();
              console.log(`SMOKE_RGN hwnd=${hwnd} ${rgnOut}`);
            }
          }
        } catch (e) {
          console.error("SMOKE_RGN_ERR", e);
        }
        if (edgeController && dockWindow && !dockWindow.isDestroyed()) {
          const initPreset = edgeController.getAttachment().sizePreset;
          edgeController.cycleWindowSize();
          const largePreset = edgeController.getAttachment().sizePreset;
          const largeBounds = dockWindow.getBounds();
          edgeController.cycleWindowSize();
          const xlPreset = edgeController.getAttachment().sizePreset;
          const xlBounds = dockWindow.getBounds();
          edgeController.cycleWindowSize();
          const compactPreset = edgeController.getAttachment().sizePreset;
          const compactBounds = dockWindow.getBounds();
          console.log(
            `SMOKE_PRESETS init=${initPreset} large=${largePreset}(${largeBounds.width}x${largeBounds.height}) xl=${xlPreset}(${xlBounds.width}x${xlBounds.height}) compact=${compactPreset}(${compactBounds.width}x${compactBounds.height})`
          );
        }
        console.log(
          `SMOKE_OK nodes=${graphStore.getSnapshot().nodes.length} tracked=${tailer.getTrackedFileCount()}`
        );
        app.quit();
      }, 900);
    });
  }
}

function createWindows(): void {
  edgeController = new EdgeWindowController();
  activeMode =
    process.argv.includes("--capture-preview") || process.argv.includes("--capture-demo")
      ? "window"
      : edgeController.getViewMode();

  const needsDockNow =
    activeMode === "dock" ||
    process.argv.includes("--smoke-exit") ||
    process.argv.includes("--capture-live");
  const needsAppNow =
    activeMode === "window" ||
    process.argv.includes("--capture-preview") ||
    process.argv.includes("--capture-demo");

  if (needsDockNow) {
    createDockWindow();
  } else {
    edgeController.setPaused(true);
  }

  if (needsAppNow) {
    createAppWindow();
  }

  tray = createOrbitTray(edgeController, simulator, graphStore, {
    getActiveMode: () => activeMode,
    getAppWindow: () => appWindow,
    onSwitchMode: (mode, dockEdge) => switchViewMode(mode, dockEdge),
    onToggleFullScreen: () => {
      toggleMainFullScreen();
    },
    onToggleAppAlwaysOnTop: () => {
      if (appWindow && !appWindow.isDestroyed()) {
        appWindow.setAlwaysOnTop(!appWindow.isAlwaysOnTop());
        broadcastWindowState();
      }
    },
    getFlashTaskbarOnWaiting: () => Boolean(edgeController?.getFlashTaskbarOnWaiting()),
    onToggleFlashTaskbar: enabled => {
      setFlashTaskbarOnWaiting(enabled);
    },
    onOpenSettings: () => {
      openSettingsWindow();
    },
    onOpenLog: () => {
      openActivityLogInActiveWindow();
    },
    onFocusAppWindow: () => {
      if (appWindow && !appWindow.isDestroyed()) {
        if (appWindow.isMinimized()) appWindow.restore();
        appWindow.show();
        appWindow.focus();
      }
    },
    onJumpWaiting: () => {
      void jumpToNextWaitingAgent();
    },
    onToggleOrbit: () => {
      toggleOrbitVisibility();
    },
  });

  edgeController.onAttachmentChanged(att => {
    const targetWin = activeMode === "window" ? appWindow : dockWindow;
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send("orbit:attachment", att);
    }
    broadcastSettingsChanged();
  });

  let lastKnownSimActive = false;
  graphStore.on("invalidate", () => {
    const now = Date.now();
    const targetWin = activeMode === "window" ? appWindow : dockWindow;
    let snap: GraphSnapshotPayload | null = null;

    if (targetWin && !targetWin.isDestroyed()) {
      const wcId = targetWin.webContents.id;
      const prevSeq = lastSentLogSeq.get(wcId);
      snap = graphStore.getSnapshot(now, {
        stripHeavyLogFields: true,
        sinceLogSeq: prevSeq,
      });
      lastSentLogSeq.set(wcId, snap.logSeq ?? 0);
      targetWin.webContents.send("orbit:snapshot", snap);
    }

    const fallbackSnap =
      snap ??
      graphStore.getSnapshot(now, {
        stripHeavyLogFields: true,
        sinceLogSeq: Number.MAX_SAFE_INTEGER,
      });
    updateAppWindowTaskbarState(fallbackSnap.nodes);

    if (fallbackSnap.simActive !== lastKnownSimActive) {
      lastKnownSimActive = fallbackSnap.simActive;
      broadcastSettingsChanged();
    }
  });

  graphStore.on("pulse", (pulse: LivePulseEvent) => {
    const targetWin = activeMode === "window" ? appWindow : dockWindow;
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send("orbit:pulse", pulse);
    }
  });

  setupAutomationHooks();
}

ipcMain.handle("orbit:get-initial", event => {
  const snap = graphStore.getSnapshot(Date.now(), { stripHeavyLogFields: true });
  lastSentLogSeq.set(event.sender.id, snap.logSeq ?? 0);
  return {
    graph: snap,
    attachment: edgeController?.getAttachment(),
    windowState: getWindowState(),
    animationSpeed: edgeController?.getAnimationSpeed() ?? 1,
    hideLog: process.argv.includes("--capture-preview"),
  };
});

ipcMain.handle("orbit:open-settings", () => {
  openSettingsWindow();
});

ipcMain.handle("orbit:get-settings", () => {
  return getOrbitSettings();
});

ipcMain.handle("orbit:update-settings", (_e, patch: Partial<OrbitSettings>) => {
  if (!patch || typeof patch !== "object") {
    return getOrbitSettings();
  }

  if (typeof patch.animationSpeed === "number") {
    edgeController?.setAnimationSpeed(patch.animationSpeed);
  }

  if (patch.viewMode === "window" || patch.viewMode === "dock") {
    if (patch.viewMode !== activeMode) {
      switchViewMode(patch.viewMode, patch.dockEdge);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.setAlwaysOnTop(patch.viewMode === "dock");
      }
    } else if (patch.dockEdge && edgeController) {
      edgeController.setDockEdge(patch.dockEdge);
    }
  } else if (patch.dockEdge && edgeController) {
    edgeController.setDockEdge(patch.dockEdge);
  }

  if (
    patch.sizePreset &&
    (patch.sizePreset === "compact" || patch.sizePreset === "large" || patch.sizePreset === "xl")
  ) {
    edgeController?.setSizePreset(patch.sizePreset as DrawerSizePreset);
  }

  if (typeof patch.isPinned === "boolean") {
    edgeController?.setPinned(patch.isPinned);
  }

  if (typeof patch.alwaysOnTop === "boolean") {
    const win = createAppWindow();
    win.setAlwaysOnTop(patch.alwaysOnTop);
  }

  if (typeof patch.flashTaskbarOnWaiting === "boolean") {
    setFlashTaskbarOnWaiting(patch.flashTaskbarOnWaiting);
  }

  if (typeof patch.openAtLogin === "boolean") {
    const appRoot = path.resolve(__dirname, "../..");
    try {
      if (process.platform === "darwin" || app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
      } else {
        app.setLoginItemSettings({
          openAtLogin: patch.openAtLogin,
          path: process.execPath,
          args: [appRoot],
        });
      }
    } catch {}
  }

  broadcastSettingsChanged();
  return getOrbitSettings();
});

ipcMain.handle("orbit:reset-dock-position", () => {
  edgeController?.resetToPrimaryRight(true);
  broadcastSettingsChanged();
});

ipcMain.handle("orbit:get-log-detail", (_e, entryId: string) => {
  return graphStore.getLogDetail(entryId);
});

ipcMain.handle("orbit:set-view-mode", (_e, mode: AppViewMode, dockEdge?: EdgeSide) => {
  switchViewMode(mode, dockEdge);
});

ipcMain.handle("orbit:toggle-fullscreen", () => {
  toggleMainFullScreen();
});

ipcMain.handle("orbit:set-pinned", (event, pinned: boolean) => {
  if (appWindow && !appWindow.isDestroyed() && event.sender === appWindow.webContents) {
    appWindow.setAlwaysOnTop(Boolean(pinned));
    broadcastWindowState();
  } else {
    edgeController?.setPinned(Boolean(pinned));
  }
});

ipcMain.handle("orbit:cycle-size", () => {
  edgeController?.cycleWindowSize();
});

ipcMain.handle("orbit:resize-start", (_e, edge: ResizeEdge) => {
  edgeController?.startWindowResize(edge);
});

ipcMain.handle("orbit:resize-end", () => {
  edgeController?.endWindowResize();
});

ipcMain.handle("orbit:set-window", (_e, mode: TimeWindowMode) => {
  graphStore.setTimeWindow(mode);
});

ipcMain.handle("orbit:collapse", () => {
  edgeController?.collapseNow();
});

ipcMain.handle("orbit:sim-burst", () => {
  simulator.triggerBurst();
});

ipcMain.handle("orbit:sim-clear", () => {
  simulator.clear();
});

ipcMain.handle("orbit:show-menu", (event, nodeId?: string) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin || senderWin.isDestroyed() || !edgeController) return;

  const menu = buildOrbitContextMenu(edgeController, simulator, {
    graphStore,
    activeMode,
    appWindow,
    targetNodeId: typeof nodeId === "string" ? nodeId : undefined,
    onSwitchMode: (mode, dockEdge) => switchViewMode(mode, dockEdge),
    onToggleFullScreen: () => {
      toggleMainFullScreen();
    },
    onToggleAppAlwaysOnTop: () => {
      if (appWindow && !appWindow.isDestroyed()) {
        appWindow.setAlwaysOnTop(!appWindow.isAlwaysOnTop());
        broadcastWindowState();
      }
    },
    flashTaskbarOnWaiting: edgeController.getFlashTaskbarOnWaiting(),
    onToggleFlashTaskbar: enabled => {
      setFlashTaskbarOnWaiting(enabled);
    },
    onFocusNode: async id => {
      const res = await focusAgentNodeWindow(id, graphStore);
      if (appWindow && !appWindow.isDestroyed()) {
        appWindow.webContents.send("orbit:focus-result", res);
      }
      if (dockWindow && !dockWindow.isDestroyed()) {
        dockWindow.webContents.send("orbit:focus-result", res);
      }
      if (res.ok && activeMode === "dock" && edgeController && !edgeController.getAttachment().isPinned) {
        edgeController.collapseNow();
      }
    },
    onOpenLog: id => {
      if (senderWin && !senderWin.isDestroyed()) {
        senderWin.webContents.send("orbit:open-log", id);
      }
    },
    onOpenSettings: () => {
      openSettingsWindow();
    },
    onJumpWaiting: () => {
      void jumpToNextWaitingAgent();
    },
    onToggleOrbit: () => {
      toggleOrbitVisibility();
    },
  });
  menu.popup({ window: senderWin });
});

async function jumpToNextWaitingAgent(): Promise<FocusResult> {
  const snap = graphStore.getSnapshot(Date.now(), {
    stripHeavyLogFields: true,
    sinceLogSeq: Number.MAX_SAFE_INTEGER,
  });
  const waiting = snap.nodes
    .filter(n => !n.isSubagent && n.status === "waiting_on_user")
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

  if (waiting.length === 0) {
    const emptyRes: FocusResult = { ok: false, reason: "No agents waiting on you" };
    const activeWin = activeMode === "window" ? appWindow : dockWindow;
    if (activeWin && !activeWin.isDestroyed() && activeWin.isVisible()) {
      activeWin.webContents.send("orbit:focus-result", emptyRes);
    }
    return emptyRes;
  }

  let target = waiting[0];
  if (waiting.length > 1 && lastWaitingJumpId) {
    const idx = waiting.findIndex(n => n.id === lastWaitingJumpId);
    if (idx >= 0) {
      target = waiting[(idx + 1) % waiting.length];
    }
  }
  lastWaitingJumpId = target.id;

  const res = await focusAgentNodeWindow(target.id, graphStore);
  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.webContents.send("orbit:focus-result", res);
  }
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.webContents.send("orbit:focus-result", res);
  }
  if (
    res.ok &&
    activeMode === "dock" &&
    edgeController &&
    !edgeController.getAttachment().isPinned
  ) {
    edgeController.collapseNow();
  }
  return res;
}

function toggleOrbitVisibility(): void {
  if (activeMode === "window") {
    if (
      appWindow &&
      !appWindow.isDestroyed() &&
      appWindow.isVisible() &&
      appWindow.isFocused() &&
      !appWindow.isMinimized()
    ) {
      appWindow.minimize();
    } else {
      const win = createAppWindow();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  } else {
    edgeController?.togglePinned();
  }
}

ipcMain.handle("orbit:jump-waiting", () => jumpToNextWaitingAgent());

ipcMain.handle(
  "orbit:open-file",
  async (_e, filePath: string, nodeId?: string): Promise<OpenFileResult> => {
    if (typeof filePath !== "string" || !filePath.trim()) {
      return { ok: false, error: "File not found on disk" };
    }
    const trimmed = filePath.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const safeUrl = sanitizeExternalHttpUrl(trimmed);
      if (!safeUrl) {
        return { ok: false, error: "Blocked unsafe URL" };
      }
      try {
        await shell.openExternal(safeUrl);
        return { ok: true, resolvedPath: safeUrl };
      } catch {
        return { ok: false, error: "Failed to open URL" };
      }
    }
    const cwd = nodeId
      ? graphStore.getNodeById(nodeId)?.cwd ?? graphStore.getRootNode(nodeId)?.cwd
      : undefined;
    const resolved = resolveOpenableFilePath(filePath, cwd);
    if (!resolved || !fs.existsSync(resolved)) {
      return { ok: false, error: "File not found on disk" };
    }
    // Never execute binaries, scripts, shortcuts, or installers directly via ShellExecute
    if (shouldRevealInsteadOfExecute(resolved)) {
      shell.showItemInFolder(resolved);
      return { ok: true, resolvedPath: resolved };
    }
    try {
      const err = await shell.openPath(resolved);
      if (err) {
        shell.showItemInFolder(resolved);
      }
      return { ok: true, resolvedPath: resolved };
    } catch {
      shell.showItemInFolder(resolved);
      return { ok: true, resolvedPath: resolved };
    }
  }
);

ipcMain.handle("orbit:drag-start", () => {
  edgeController?.startDrag();
});

ipcMain.handle("orbit:drag-end", () => {
  edgeController?.endDrag();
});

ipcMain.handle("orbit:focus-node", async (_e, nodeId: string) => {
  const res = await focusAgentNodeWindow(nodeId, graphStore);
  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.webContents.send("orbit:focus-result", res);
  }
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.webContents.send("orbit:focus-result", res);
  }
  if (res.ok && activeMode === "dock" && edgeController && !edgeController.getAttachment().isPinned) {
    edgeController.collapseNow();
  }
  return res;
});

async function init(): Promise<void> {
  if (!isCaptureMode) {
    let gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      if (process.argv.includes("--replace")) {
        for (let i = 0; i < 5; i++) {
          await new Promise(resolve => setTimeout(resolve, 600));
          gotLock = app.requestSingleInstanceLock();
          if (gotLock) break;
        }
      }
      if (!gotLock) {
        app.quit();
        return;
      }
    }
  }

  await app.whenReady();
  if (process.platform === "darwin") {
    installMacApplicationMenu();
  }
  if (!isCaptureMode) {
    try {
      globalShortcut.register("Alt+Shift+Space", () => {
        void jumpToNextWaitingAgent();
      });
    } catch {}
    try {
      globalShortcut.register("Alt+Shift+O", () => {
        toggleOrbitVisibility();
      });
    } catch {}
  }
  createWindows();
  if (
    !process.argv.includes("--capture-preview") &&
    !process.argv.includes("--capture-demo")
  ) {
    tailer.start();
  }
}

init();

app.on("second-instance", (_event, argv) => {
  if (argv.includes("--replace")) {
    app.quit();
  } else {
    if (activeMode === "window") {
      if (appWindow && !appWindow.isDestroyed()) {
        if (appWindow.isMinimized()) appWindow.restore();
        appWindow.show();
        appWindow.focus();
      }
    } else {
      edgeController?.setPinned(true);
    }
  }
});

app.on("activate", () => {
  if (!edgeController) return;
  if (activeMode === "window") {
    const win = createAppWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    edgeController.setPinned(true);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  try {
    if (!isCaptureMode) globalShortcut.unregisterAll();
  } catch {}
  tailer.stop();
  edgeController?.dispose();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on("will-quit", () => {
  try {
    if (!isCaptureMode) globalShortcut.unregisterAll();
  } catch {}
});
