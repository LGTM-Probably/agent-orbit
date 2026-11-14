import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import fs from "fs";
import path from "path";
import { AppViewMode, EdgeSide, HarnessKind } from "../shared/types";
import { EdgeWindowController } from "./edgeWindow";
import { GraphStore } from "./graphStore";
import { SwarmSimulator } from "./simulator";

export interface ContextMenuOptions {
  graphStore?: GraphStore;
  targetNodeId?: string;
  activeMode?: AppViewMode;
  appWindow?: BrowserWindow | null;
  flashTaskbarOnWaiting?: boolean;
  onFocusNode?: (nodeId: string) => void;
  onOpenLog?: (nodeId?: string) => void;
  onOpenSettings?: () => void;
  onMenuUpdated?: () => void;
  onSwitchMode?: (mode: AppViewMode, dockEdge?: EdgeSide) => void;
  onToggleFullScreen?: () => void;
  onToggleAppAlwaysOnTop?: () => void;
  onToggleFlashTaskbar?: (enabled: boolean) => void;
  onJumpWaiting?: () => void;
  onToggleOrbit?: () => void;
}

export interface TrayStateProvider {
  getActiveMode: () => AppViewMode;
  getAppWindow: () => BrowserWindow | null;
  getFlashTaskbarOnWaiting?: () => boolean;
  onSwitchMode: (mode: AppViewMode, dockEdge?: EdgeSide) => void;
  onToggleFullScreen: () => void;
  onToggleAppAlwaysOnTop: () => void;
  onToggleFlashTaskbar?: (enabled: boolean) => void;
  onOpenSettings?: () => void;
  onOpenLog?: () => void;
  onFocusAppWindow: () => void;
  onJumpWaiting?: () => void;
  onToggleOrbit?: () => void;
}

function harnessDisplayName(harness: HarnessKind): string {
  switch (harness) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "antigravity":
      return "Antigravity";
    case "strata":
      return "Strata";
    default:
      return harness;
  }
}

function truncate(str: string, maxLen: number): string {
  const clean = str.trim();
  return clean.length > maxLen ? clean.slice(0, maxLen - 1) + "…" : clean;
}

export function buildOrbitContextMenu(
  edgeCtrl: EdgeWindowController,
  _simulator: SwarmSimulator,
  optionsOrCb?: ContextMenuOptions | (() => void)
): Electron.Menu {
  const options: ContextMenuOptions =
    typeof optionsOrCb === "function" ? { onMenuUpdated: optionsOrCb } : optionsOrCb ?? {};
  const onMenuUpdated = options.onMenuUpdated;

  const att = edgeCtrl.getAttachment();
  const template: Electron.MenuItemConstructorOptions[] = [];

  const targetNode =
    options.targetNodeId && options.graphStore
      ? options.graphStore.getNodeById(options.targetNodeId)
      : undefined;

  if (targetNode) {
    template.push(
      {
        label: `${harnessDisplayName(targetNode.harness)} · ${truncate(targetNode.label, 28)}`,
        enabled: false,
      },
      {
        label: "Go to Agent Window",
        click: () => {
          options.onFocusNode?.(targetNode.id);
        },
      },
      {
        label: "View Activity Log",
        click: () => {
          options.onOpenLog?.(targetNode.id);
        },
      },
      { type: "separator" },
      {
        label: "Settings…",
        accelerator: "CmdOrCtrl+,",
        click: () => {
          options.onOpenSettings?.();
        },
      }
    );
    return Menu.buildFromTemplate(template);
  }

  const viewMode = options.activeMode ?? edgeCtrl.getViewMode();

  template.push(
    {
      label: "Agent Orbit",
      enabled: false,
    },
    {
      label: "Jump to Waiting Agent (Alt+Shift+Space)",
      click: () => {
        options.onJumpWaiting?.();
      },
    }
  );

  if (options.onOpenLog) {
    template.push({
      label: "View Activity Log",
      click: () => {
        options.onOpenLog?.();
      },
    });
  }

  template.push({ type: "separator" });

  if (viewMode === "window") {
    template.push(
      {
        label: "Toggle Fullscreen (F11)",
        click: () => {
          options.onToggleFullScreen?.();
          onMenuUpdated?.();
        },
      },
      {
        label: "Switch to Edge Dock",
        click: () => {
          options.onSwitchMode?.("dock");
          onMenuUpdated?.();
        },
      }
    );
  } else {
    template.push(
      {
        label: "Open as App Window",
        click: () => {
          options.onSwitchMode?.("window");
          onMenuUpdated?.();
        },
      },
      {
        label: att.isPinned ? "Unpin Drawer" : "Pin Drawer Open",
        click: () => {
          edgeCtrl.togglePinned();
          onMenuUpdated?.();
        },
      }
    );
  }

  template.push(
    {
      label: "Toggle Agent Orbit (Alt+Shift+O)",
      click: () => {
        options.onToggleOrbit?.();
        onMenuUpdated?.();
      },
    },
    { type: "separator" },
    {
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      click: () => {
        options.onOpenSettings?.();
      },
    },
    { type: "separator" },
    {
      label: "Quit Agent Orbit",
      click: () => app.quit(),
    }
  );

  return Menu.buildFromTemplate(template);
}

export function createOrbitTray(
  edgeCtrl: EdgeWindowController,
  simulator: SwarmSimulator,
  graphStore?: GraphStore,
  stateProvider?: TrayStateProvider
): Tray {
  const icoPath = path.resolve(__dirname, "../../assets/orbit.ico");
  const icon = fs.existsSync(icoPath)
    ? nativeImage.createFromPath(icoPath)
    : buildOrbitTrayIcon();
  const tray = new Tray(icon);
  tray.setToolTip("Agent Orbit — Passive Agent Visualizer");

  const rebuildMenu = () => {
    const activeMode = stateProvider ? stateProvider.getActiveMode() : edgeCtrl.getViewMode();
    const appWindow = stateProvider ? stateProvider.getAppWindow() : null;
    const menu = buildOrbitContextMenu(edgeCtrl, simulator, {
      graphStore,
      activeMode,
      appWindow,
      flashTaskbarOnWaiting: stateProvider?.getFlashTaskbarOnWaiting
        ? stateProvider.getFlashTaskbarOnWaiting()
        : edgeCtrl.getFlashTaskbarOnWaiting(),
      onSwitchMode: stateProvider?.onSwitchMode,
      onToggleFullScreen: stateProvider?.onToggleFullScreen,
      onToggleAppAlwaysOnTop: stateProvider?.onToggleAppAlwaysOnTop,
      onToggleFlashTaskbar: stateProvider?.onToggleFlashTaskbar,
      onOpenSettings: stateProvider?.onOpenSettings,
      onOpenLog: stateProvider?.onOpenLog,
      onJumpWaiting: stateProvider?.onJumpWaiting,
      onToggleOrbit: stateProvider?.onToggleOrbit,
      onMenuUpdated: () => rebuildMenu(),
    });
    tray.setContextMenu(menu);
  };

  (tray as any).rebuildMenu = rebuildMenu;
  rebuildMenu();
  edgeCtrl.onAttachmentChanged(() => rebuildMenu());
  tray.on("click", () => {
    const mode = stateProvider ? stateProvider.getActiveMode() : edgeCtrl.getViewMode();
    if (mode === "window") {
      stateProvider?.onFocusAppWindow();
    } else {
      edgeCtrl.togglePinned();
    }
  });

  return tray;
}

/**
 * Generates a crisp 16x16 RGBA orbital icon programmatically (zero external binary asset needed).
 */
function buildOrbitTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4, 0);

  const setPx = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    // BGRA byte order on Windows for createFromBitmap
    const idx = (y * size + x) * 4;
    buf[idx] = b;
    buf[idx + 1] = g;
    buf[idx + 2] = r;
    buf[idx + 3] = a;
  };

  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      // Central coral/amber core
      if (d <= 3.2) {
        setPx(x, y, 242, 139, 98, 255);
      } else if (Math.abs(d - 6.0) <= 0.9) {
        // Outer orbit ring
        setPx(x, y, 148, 163, 255, 220);
      }
    }
  }
  // Tiny mint moon on top-right of orbit
  for (let y = 1; y <= 4; y++) {
    for (let x = 11; x <= 14; x++) {
      const d = Math.hypot(x - 12.5, y - 2.5);
      if (d <= 1.8) setPx(x, y, 74, 222, 172, 255);
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
