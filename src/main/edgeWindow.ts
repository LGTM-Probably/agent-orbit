import { app, BrowserWindow, Display, screen } from "electron";
import fs from "fs";
import path from "path";
import {
  AppViewMode,
  DrawerSizePreset,
  EdgeAttachment,
  EdgeSide,
  ResizeEdge,
  clampAnimationSpeed,
} from "../shared/types";

export interface AppWindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export interface PersistedDockConfig {
  displayId: number;
  edge: EdgeSide;
  offsetRatio: number;
  sizePreset?: DrawerSizePreset;
  drawerWidth?: number;
  drawerHeight?: number;
  viewMode?: AppViewMode;
  appWindowBounds?: AppWindowBounds;
  flashTaskbarOnWaiting?: boolean;
  animationSpeed?: number;
}

export function resolveFlashTaskbarOnWaiting(
  saved?: Partial<PersistedDockConfig> | null
): boolean {
  return Boolean(saved?.flashTaskbarOnWaiting ?? false);
}

export function resolveAnimationSpeed(
  saved?: Partial<PersistedDockConfig> | null
): number {
  return clampAnimationSpeed(saved?.animationSpeed);
}

// Scrollbar-safe Spine dimensions (must match CSS .spine)
const SPINE_THICKNESS = 28;
const SPINE_LENGTH = 196;

const HOVER_OPEN_DWELL_MS = 120;
const HOVER_CLOSE_GRACE_MS = 320;

export class EdgeWindowController {
  private win: BrowserWindow | null = null;
  private attachment: EdgeAttachment;
  private configPath: string;
  private cursorTimer: NodeJS.Timeout | null = null;
  private hoverEnteredAt: number | null = null;
  private hoverLeftAt: number | null = null;
  private userInteractedWithIntro = false;
  private currentlyIgnoringMouse = false;
  private onChangeCallbacks: Array<(att: EdgeAttachment) => void> = [];
  private viewMode: AppViewMode = "window";
  private appWindowBounds: AppWindowBounds;
  private flashTaskbarOnWaiting: boolean;
  private animationSpeed: number;
  private isPaused = false;
  private displayListenersRegistered = false;
  private resizing: {
    edge: ResizeEdge;
    startPt: { x: number; y: number };
    startBounds: Electron.Rectangle;
  } | null = null;

  constructor() {
    this.configPath = path.join(app.getPath("userData"), "orbit-dock.json");
    const saved = this.loadConfig();
    const primary = screen.getPrimaryDisplay();
    const edge: EdgeSide = saved?.edge ?? "right";
    const sizePreset: DrawerSizePreset = saved?.sizePreset ?? "compact";
    const dims = this.getPresetDimensions(
      sizePreset,
      edge,
      primary.workArea,
      saved?.drawerWidth,
      saved?.drawerHeight
    );
    const drawerWidth = saved?.drawerWidth ?? dims.width;
    const drawerHeight = saved?.drawerHeight ?? dims.height;

    this.viewMode = saved?.viewMode ?? "window";
    this.isPaused = this.viewMode === "window";
    this.appWindowBounds = this.resolveInitialAppWindowBounds(saved?.appWindowBounds, primary);
    this.flashTaskbarOnWaiting = resolveFlashTaskbarOnWaiting(saved);
    this.animationSpeed = resolveAnimationSpeed(saved);

    this.attachment = {
      displayId: saved?.displayId ?? primary.id,
      edge,
      offsetRatio: clamp(saved?.offsetRatio ?? 0.5, 0.08, 0.92),
      isExpanded: false,
      isPinned: false,
      isDragging: false,
      sizePreset,
      drawerWidth,
      drawerHeight,
    };
  }

  private startCursorTimer(): void {
    if (this.isPaused || !this.win || this.win.isDestroyed()) return;
    if (this.cursorTimer) return;
    // Poll global cursor at ~33Hz for zero-flicker dwell & multi-monitor magnetic edge drag
    this.cursorTimer = setInterval(() => {
      this.tickCursor();
    }, 30);
  }

  private stopCursorTimer(): void {
    if (this.cursorTimer) {
      clearInterval(this.cursorTimer);
      this.cursorTimer = null;
    }
  }

  public attachWindow(win: BrowserWindow): void {
    this.win = win;
    this.repositionWindow();

    // On startup, if in dock mode, start expanded until user interacts with it so user immediately spots the drawer!
    if (!this.isPaused) {
      this.attachment.isExpanded = true;
      this.setClickThrough(false);
      this.applyWindowShape();
      this.broadcast();
      this.startCursorTimer();
    } else {
      this.stopCursorTimer();
      if (!win.isDestroyed()) {
        win.hide();
      }
    }

    if (!this.displayListenersRegistered) {
      this.displayListenersRegistered = true;
      screen.on("display-metrics-changed", () => this.repositionWindow());
      screen.on("display-added", () => this.repositionWindow());
      screen.on("display-removed", () => this.resetToPrimaryRight(false));
    }
  }

  public setPaused(paused: boolean): void {
    this.isPaused = paused;
    if (paused) {
      this.stopCursorTimer();
      if (this.win && !this.win.isDestroyed()) {
        this.win.hide();
      }
    } else {
      if (this.win && !this.win.isDestroyed()) {
        this.win.show();
      }
      this.repositionWindow();
      this.attachment.isExpanded = true;
      this.userInteractedWithIntro = false;
      this.setClickThrough(false);
      this.applyWindowShape();
      this.broadcast();
      this.startCursorTimer();
    }
  }

  public isWindowPaused(): boolean {
    return this.isPaused;
  }

  public setDockEdge(edge: EdgeSide): void {
    this.attachment.edge = edge;
    this.repositionWindow();
    this.applyWindowShape();
    this.saveConfig();
    this.broadcast();
  }

  public getViewMode(): AppViewMode {
    return this.viewMode;
  }

  public setViewMode(mode: AppViewMode): void {
    this.viewMode = mode;
    this.saveConfig();
  }

  public getAppWindowBounds(): AppWindowBounds {
    return { ...this.appWindowBounds };
  }

  public setAppWindowBounds(bounds: AppWindowBounds): void {
    this.appWindowBounds = { ...this.appWindowBounds, ...bounds };
    this.saveConfig();
  }

  public getFlashTaskbarOnWaiting(): boolean {
    return this.flashTaskbarOnWaiting;
  }

  public setFlashTaskbarOnWaiting(enabled: boolean): void {
    this.flashTaskbarOnWaiting = Boolean(enabled);
    this.saveConfig();
  }

  public getAnimationSpeed(): number {
    return this.animationSpeed;
  }

  public setAnimationSpeed(speed: number): number {
    this.animationSpeed = clampAnimationSpeed(speed);
    this.saveConfig();
    return this.animationSpeed;
  }

  private resolveInitialAppWindowBounds(
    saved: AppWindowBounds | undefined,
    display: Display
  ): AppWindowBounds {
    const wa = display.workArea;
    const defaultW = Math.min(1240, Math.max(520, wa.width - 40));
    const defaultH = Math.min(840, Math.max(420, wa.height - 40));
    const defaultX = Math.round(wa.x + (wa.width - defaultW) / 2);
    const defaultY = Math.round(wa.y + (wa.height - defaultH) / 2);

    if (!saved) {
      return {
        x: defaultX,
        y: defaultY,
        width: defaultW,
        height: defaultH,
        isMaximized: false,
      };
    }

    const width = clamp(saved.width || defaultW, 520, wa.width);
    const height = clamp(saved.height || defaultH, 420, wa.height);

    let x = saved.x;
    let y = saved.y;

    if (x === undefined || y === undefined) {
      x = defaultX;
      y = defaultY;
    } else {
      const allDisplays = screen.getAllDisplays();
      const onScreen = allDisplays.some(d => {
        const dwa = d.workArea;
        return (
          x! + width > dwa.x + 40 &&
          x! < dwa.x + dwa.width - 40 &&
          y! + height > dwa.y + 40 &&
          y! < dwa.y + dwa.height - 40
        );
      });
      if (!onScreen) {
        x = defaultX;
        y = defaultY;
      }
    }

    return {
      x,
      y,
      width,
      height,
      isMaximized: Boolean(saved.isMaximized),
    };
  }

  public dispose(): void {
    this.stopCursorTimer();
  }

  public reapplyBoundsAndShow(): void {
    this.repositionWindow();
    this.attachment.isExpanded = true;
    this.setClickThrough(false);
    this.applyWindowShape();
    this.broadcast();
  }

  public reapplyShape(): void {
    this.applyWindowShape();
  }

  public getAttachment(): EdgeAttachment {
    return { ...this.attachment };
  }

  public onAttachmentChanged(cb: (att: EdgeAttachment) => void): void {
    this.onChangeCallbacks.push(cb);
  }

  public setPinned(pinned: boolean): void {
    this.attachment.isPinned = pinned;
    if (pinned) {
      this.attachment.isExpanded = true;
      this.setClickThrough(false);
    }
    this.applyWindowShape();
    this.broadcast();
  }

  public togglePinned(): void {
    this.setPinned(!this.attachment.isPinned);
  }

  public collapseNow(): void {
    this.attachment.isPinned = false;
    this.attachment.isExpanded = false;
    this.hoverEnteredAt = null;
    this.hoverLeftAt = null;
    this.setClickThrough(true);
    this.applyWindowShape();
    this.broadcast();
  }

  public resetToPrimaryRight(expandBriefly = true): void {
    const primary = screen.getPrimaryDisplay();
    this.attachment.displayId = primary.id;
    this.attachment.edge = "right";
    this.attachment.offsetRatio = 0.5;
    this.attachment.isDragging = false;
    this.attachment.sizePreset = "compact";
    const dims = this.getPresetDimensions("compact", "right", primary.workArea);
    this.attachment.drawerWidth = dims.width;
    this.attachment.drawerHeight = dims.height;
    if (expandBriefly) {
      this.attachment.isExpanded = true;
      this.setClickThrough(false);
    }
    this.repositionWindow();
    this.applyWindowShape();
    this.saveConfig();
    this.broadcast();
  }

  public setSizePreset(preset: DrawerSizePreset): void {
    const disp = this.resolveDisplay();
    const dims = this.getPresetDimensions(preset, this.attachment.edge, disp.workArea);
    this.attachment.sizePreset = preset;
    this.attachment.drawerWidth = dims.width;
    this.attachment.drawerHeight = dims.height;
    if (preset === "large" || preset === "xl") {
      this.attachment.isPinned = true;
      this.attachment.isExpanded = true;
      this.setClickThrough(false);
    }
    this.repositionWindow();
    this.applyWindowShape();
    this.saveConfig();
    this.broadcast();
  }

  public cycleWindowSize(): void {
    let nextPreset: DrawerSizePreset = "compact";
    if (this.attachment.sizePreset === "compact") {
      nextPreset = "large";
    } else if (this.attachment.sizePreset === "large") {
      nextPreset = "xl";
    } else if (this.attachment.sizePreset === "xl") {
      nextPreset = "compact";
    } else {
      // currently "custom"
      if (this.attachment.drawerWidth >= 1100) {
        nextPreset = "compact";
      } else if (this.attachment.drawerWidth >= 780) {
        nextPreset = "xl";
      } else {
        nextPreset = "large";
      }
    }
    this.setSizePreset(nextPreset);
  }

  public startWindowResize(edge: ResizeEdge): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.attachment.isDragging = false;
    const startPt = screen.getCursorScreenPoint();
    const startBounds = this.win.getBounds();
    this.resizing = {
      edge,
      startPt,
      startBounds,
    };
    this.attachment.sizePreset = "custom";
    this.attachment.isPinned = true;
    this.attachment.isExpanded = true;
    this.setClickThrough(false);
  }

  public endWindowResize(): void {
    if (!this.resizing) return;
    this.resizing = null;
    this.saveConfig();
    this.broadcast();
  }

  public startDrag(): void {
    this.resizing = null;
    this.attachment.isDragging = true;
    this.attachment.previewEdge = this.attachment.edge;
    this.setClickThrough(false);
    this.applyWindowShape();
    this.broadcast();
  }

  public endDrag(): void {
    if (!this.attachment.isDragging) return;
    this.attachment.isDragging = false;
    this.attachment.previewEdge = undefined;
    this.repositionWindow();
    this.applyWindowShape();
    this.saveConfig();
    this.broadcast();
  }

  private resolveDisplay(): Display {
    const all = screen.getAllDisplays();
    return all.find(d => d.id === this.attachment.displayId) ?? screen.getPrimaryDisplay();
  }

  private getPresetDimensions(
    preset: DrawerSizePreset,
    edge: EdgeSide,
    workArea: Electron.Rectangle,
    fallbackW?: number,
    fallbackH?: number
  ): { width: number; height: number } {
    const isVert = edge === "right" || edge === "left";
    const maxW = Math.max(380, workArea.width - 24);
    const maxH = Math.max(440, workArea.height - 16);
    const safeW = Math.max(380, workArea.width - 40);
    const safeH = Math.max(440, workArea.height - 24);

    if (isVert) {
      switch (preset) {
        case "compact":
          return { width: Math.min(430, maxW), height: Math.min(650, maxH) };
        case "large":
          return { width: Math.min(780, maxW), height: Math.min(1000, maxH) };
        case "xl":
          return { width: Math.min(1240, safeW), height: Math.min(1320, safeH) };
        case "custom":
          return {
            width: clamp(fallbackW ?? this.attachment?.drawerWidth ?? 430, 380, maxW),
            height: clamp(fallbackH ?? this.attachment?.drawerHeight ?? 650, 440, maxH),
          };
      }
    } else {
      switch (preset) {
        case "compact":
          return { width: Math.min(650, maxW), height: Math.min(420, maxH) };
        case "large":
          return { width: Math.min(1000, maxW), height: Math.min(680, maxH) };
        case "xl":
          return { width: Math.min(1320, safeW), height: Math.min(1240, safeH) };
        case "custom":
          return {
            width: clamp(fallbackW ?? this.attachment?.drawerWidth ?? 650, 440, maxW),
            height: clamp(fallbackH ?? this.attachment?.drawerHeight ?? 420, 320, maxH),
          };
      }
    }
  }

  private computeWindowBounds(
    display: Display,
    edge: EdgeSide,
    offsetRatio: number
  ): Electron.Rectangle {
    const wa = display.workArea;
    const isVert = edge === "right" || edge === "left";
    const dims = this.getPresetDimensions(this.attachment.sizePreset, edge, wa);
    const width = dims.width;
    const height = dims.height;

    if (isVert) {
      const x = edge === "right" ? wa.x + wa.width - width : wa.x;
      const availY = Math.max(0, wa.height - height);
      const y = Math.round(wa.y + availY * clamp(offsetRatio, 0, 1));
      return { x, y, width, height };
    } else {
      const availX = Math.max(0, wa.width - width);
      const x = Math.round(wa.x + availX * clamp(offsetRatio, 0, 1));
      const y = edge === "bottom" ? wa.y + wa.height - height : wa.y;
      return { x, y, width, height };
    }
  }

  private computeSpineLocalRect(
    bounds: Electron.Rectangle,
    edge: EdgeSide,
    pad = 18
  ): Electron.Rectangle {
    let baseX = 0;
    let baseY = 0;
    let baseW = 0;
    let baseH = 0;

    if (edge === "right") {
      baseX = bounds.width - SPINE_THICKNESS;
      baseY = Math.round((bounds.height - SPINE_LENGTH) / 2);
      baseW = SPINE_THICKNESS;
      baseH = SPINE_LENGTH;
    } else if (edge === "left") {
      baseX = 0;
      baseY = Math.round((bounds.height - SPINE_LENGTH) / 2);
      baseW = SPINE_THICKNESS;
      baseH = SPINE_LENGTH;
    } else if (edge === "top") {
      baseX = Math.round((bounds.width - SPINE_LENGTH) / 2);
      baseY = 0;
      baseW = SPINE_LENGTH;
      baseH = SPINE_THICKNESS;
    } else {
      // bottom
      baseX = Math.round((bounds.width - SPINE_LENGTH) / 2);
      baseY = bounds.height - SPINE_THICKNESS;
      baseW = SPINE_LENGTH;
      baseH = SPINE_THICKNESS;
    }

    const x1 = Math.max(0, baseX - pad);
    const y1 = Math.max(0, baseY - pad);
    const x2 = Math.min(bounds.width, baseX + baseW + pad);
    const y2 = Math.min(bounds.height, baseY + baseH + pad);

    return {
      x: x1,
      y: y1,
      width: Math.max(0, x2 - x1),
      height: Math.max(0, y2 - y1),
    };
  }

  private computeDrawerLocalRect(
    bounds: Electron.Rectangle,
    edge: EdgeSide
  ): Electron.Rectangle {
    switch (edge) {
      case "right":
        return {
          x: 6,
          y: 6,
          width: Math.max(10, bounds.width - 6),
          height: Math.max(10, bounds.height - 12),
        };
      case "left":
        return {
          x: 0,
          y: 6,
          width: Math.max(10, bounds.width - 6),
          height: Math.max(10, bounds.height - 12),
        };
      case "top":
        return {
          x: 6,
          y: 0,
          width: Math.max(10, bounds.width - 12),
          height: Math.max(10, bounds.height - 6),
        };
      case "bottom":
        return {
          x: 6,
          y: 6,
          width: Math.max(10, bounds.width - 12),
          height: Math.max(10, bounds.height - 6),
        };
    }
  }

  private computeSpineScreenRect(bounds: Electron.Rectangle, edge: EdgeSide): Electron.Rectangle {
    const local = this.computeSpineLocalRect(bounds, edge, 0);
    return {
      x: bounds.x + local.x,
      y: bounds.y + local.y,
      width: local.width,
      height: local.height,
    };
  }

  private applyWindowShape(): void {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      const bounds = this.win.getBounds();
      if (!this.attachment.isExpanded && !this.attachment.isDragging) {
        const localRect = this.computeSpineLocalRect(bounds, this.attachment.edge, 18);
        this.win.setShape([localRect]);
      } else if (this.attachment.isDragging) {
        this.win.setShape([
          {
            x: 6,
            y: 6,
            width: Math.max(10, bounds.width - 12),
            height: Math.max(10, bounds.height - 12),
          },
        ]);
      } else {
        const drawerRect = this.computeDrawerLocalRect(bounds, this.attachment.edge);
        this.win.setShape([drawerRect]);
      }
    } catch {
      // setShape is platform-dependent; safe fallback
    }
  }

  private repositionWindow(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const disp = this.resolveDisplay();
    const bounds = this.computeWindowBounds(
      disp,
      this.attachment.edge,
      this.attachment.offsetRatio
    );
    this.attachment.drawerWidth = bounds.width;
    this.attachment.drawerHeight = bounds.height;
    this.win.setBounds(bounds, false);
    this.applyWindowShape();
  }

  private tickCursor(): void {
    if (this.isPaused || !this.win || this.win.isDestroyed()) {
      this.stopCursorTimer();
      return;
    }
    const pt = screen.getCursorScreenPoint();
    const now = Date.now();

    // 0. Live Drag-to-Resize Mode
    if (this.resizing) {
      const disp = this.resolveDisplay();
      const wa = disp.workArea;
      const { edge: resizeEdge, startPt, startBounds } = this.resizing;
      const dx = pt.x - startPt.x;
      const dy = pt.y - startPt.y;
      const edge = this.attachment.edge;
      const isVert = edge === "right" || edge === "left";

      const minW = isVert ? 380 : 440;
      const maxW = Math.max(minW, wa.width - 24);
      const minH = isVert ? 440 : 320;
      const maxH = Math.max(minH, wa.height - 16);

      let targetW = startBounds.width;
      let targetH = startBounds.height;
      let targetX = startBounds.x;
      let targetY = startBounds.y;

      const hasLeft =
        resizeEdge === "left" || resizeEdge === "top-left" || resizeEdge === "bottom-left";
      const hasRight =
        resizeEdge === "right" || resizeEdge === "top-right" || resizeEdge === "bottom-right";
      const hasTop =
        resizeEdge === "top" || resizeEdge === "top-left" || resizeEdge === "top-right";
      const hasBottom =
        resizeEdge === "bottom" || resizeEdge === "bottom-left" || resizeEdge === "bottom-right";

      // Width adjustment
      if (hasLeft) {
        targetW = clamp(startBounds.width - dx, minW, maxW);
        if (edge !== "right") {
          targetX = startBounds.x + startBounds.width - targetW;
        }
      } else if (hasRight) {
        targetW = clamp(startBounds.width + dx, minW, maxW);
        if (edge !== "left") {
          targetX = startBounds.x;
        }
      }

      // Height adjustment
      if (hasTop) {
        targetH = clamp(startBounds.height - dy, minH, maxH);
        if (edge !== "bottom") {
          targetY = startBounds.y + startBounds.height - targetH;
        }
      } else if (hasBottom) {
        targetH = clamp(startBounds.height + dy, minH, maxH);
        if (edge !== "top") {
          targetY = startBounds.y;
        }
      }

      if (isVert) {
        if (hasTop || hasBottom) {
          const availY = Math.max(1, wa.height - targetH);
          this.attachment.offsetRatio = clamp((targetY - wa.y) / availY, 0, 1);
        }
      } else {
        if (hasLeft || hasRight) {
          const availX = Math.max(1, wa.width - targetW);
          this.attachment.offsetRatio = clamp((targetX - wa.x) / availX, 0, 1);
        }
      }

      this.attachment.drawerWidth = targetW;
      this.attachment.drawerHeight = targetH;
      this.attachment.sizePreset = "custom";
      this.attachment.isPinned = true;
      this.attachment.isExpanded = true;
      this.repositionWindow();
      this.broadcast();
      return;
    }

    // 1. Magnetic Drag-to-Any-Edge Mode
    if (this.attachment.isDragging) {
      const disp = screen.getDisplayNearestPoint(pt);
      const wa = disp.workArea;

      const dLeft = Math.abs(pt.x - wa.x);
      const dRight = Math.abs(wa.x + wa.width - pt.x);
      const dTop = Math.abs(pt.y - wa.y);
      const dBottom = Math.abs(wa.y + wa.height - pt.y);

      const minDist = Math.min(dLeft, dRight, dTop, dBottom);
      let nextEdge: EdgeSide = "right";
      if (minDist === dLeft) nextEdge = "left";
      else if (minDist === dRight) nextEdge = "right";
      else if (minDist === dTop) nextEdge = "top";
      else nextEdge = "bottom";

      let ratio = 0.5;
      if (nextEdge === "left" || nextEdge === "right") {
        const h = this.attachment.drawerHeight;
        const span = Math.max(1, wa.height - h);
        ratio = clamp((pt.y - h / 2 - wa.y) / span, 0.02, 0.98);
      } else {
        const w = this.attachment.drawerWidth;
        const span = Math.max(1, wa.width - w);
        ratio = clamp((pt.x - w / 2 - wa.x) / span, 0.02, 0.98);
      }

      const edgeChanged =
        this.attachment.displayId !== disp.id || this.attachment.edge !== nextEdge;
      this.attachment.displayId = disp.id;
      this.attachment.edge = nextEdge;
      this.attachment.previewEdge = nextEdge;
      this.attachment.offsetRatio = ratio;
      this.repositionWindow();
      if (edgeChanged) {
        this.broadcast();
      }
      return;
    }

    const bounds = this.win.getBounds();

    // 2. Tucked state: ONLY react inside the compact Spine capsule so scrollbars stay clear!
    if (!this.attachment.isExpanded) {
      const spineRect = this.computeSpineScreenRect(bounds, this.attachment.edge);
      const inSpine = pointInRect(pt, spineRect, 2);

      if (inSpine) {
        this.setClickThrough(false);
        if (this.hoverEnteredAt === null) {
          this.hoverEnteredAt = now;
        } else if (now - this.hoverEnteredAt >= HOVER_OPEN_DWELL_MS) {
          this.attachment.isExpanded = true;
          this.hoverEnteredAt = null;
          this.hoverLeftAt = null;
          this.applyWindowShape();
          this.broadcast();
        }
      } else {
        this.hoverEnteredAt = null;
        this.setClickThrough(true);
      }
      return;
    }

    // 3. Expanded state: stay interactive inside window; close smoothly after 320ms outside
    const inDrawer = pointInRect(pt, bounds, 10);
    if (inDrawer) {
      this.hoverLeftAt = null;
      this.setClickThrough(false);
      this.userInteractedWithIntro = true;
    } else if (this.attachment.isPinned) {
      // When pinned open, let clicks outside the window go to other apps normally (outside bounds is already OS-transparent)
      this.setClickThrough(false);
    } else {
      // During intro: if user hasn't interacted with drawer yet, stay expanded!
      if (!this.userInteractedWithIntro) {
        return;
      }
      if (this.hoverLeftAt === null) {
        this.hoverLeftAt = now;
      } else if (now - this.hoverLeftAt >= HOVER_CLOSE_GRACE_MS) {
        this.attachment.isExpanded = false;
        this.hoverLeftAt = null;
        this.setClickThrough(true);
        this.applyWindowShape();
        this.broadcast();
      }
    }
  }

  private setClickThrough(ignore: boolean): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.currentlyIgnoringMouse === ignore) return;
    this.currentlyIgnoringMouse = ignore;
    if (ignore) {
      this.win.setIgnoreMouseEvents(true, { forward: true });
    } else {
      this.win.setIgnoreMouseEvents(false);
    }
  }

  private broadcast(): void {
    const snap = this.getAttachment();
    for (const cb of this.onChangeCallbacks) {
      cb(snap);
    }
  }

  private loadConfig(): PersistedDockConfig | null {
    try {
      if (!fs.existsSync(this.configPath)) return null;
      return JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    } catch {
      return null;
    }
  }

  private saveConfig(): void {
    try {
      const data: PersistedDockConfig = {
        displayId: this.attachment.displayId,
        edge: this.attachment.edge,
        offsetRatio: this.attachment.offsetRatio,
        sizePreset: this.attachment.sizePreset,
        drawerWidth: this.attachment.drawerWidth,
        drawerHeight: this.attachment.drawerHeight,
        viewMode: this.viewMode,
        appWindowBounds: this.appWindowBounds,
        flashTaskbarOnWaiting: this.flashTaskbarOnWaiting,
        animationSpeed: this.animationSpeed,
      };
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), "utf8");
    } catch {}
  }
}

function pointInRect(
  pt: { x: number; y: number },
  r: Electron.Rectangle,
  pad = 0
): boolean {
  return (
    pt.x >= r.x - pad &&
    pt.x <= r.x + r.width + pad &&
    pt.y >= r.y - pad &&
    pt.y <= r.y + r.height + pad
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
