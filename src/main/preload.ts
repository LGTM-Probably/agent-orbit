import { contextBridge, ipcRenderer } from "electron";
import {
  AppViewMode,
  EdgeAttachment,
  EdgeSide,
  FocusResult,
  GraphSnapshotPayload,
  LivePulseEvent,
  OpenFileResult,
  OrbitBridgeAPI,
  OrbitSettings,
  ResizeEdge,
  TimeWindowMode,
  WindowStateInfo,
} from "../shared/types";

const api: OrbitBridgeAPI = {
  getInitialState: () => ipcRenderer.invoke("orbit:get-initial"),
  getLogDetail: (entryId: string) => ipcRenderer.invoke("orbit:get-log-detail", entryId),
  openSettings: () => ipcRenderer.invoke("orbit:open-settings"),
  getSettings: () => ipcRenderer.invoke("orbit:get-settings"),
  updateSettings: (patch: Partial<OrbitSettings>) =>
    ipcRenderer.invoke("orbit:update-settings", patch),
  resetDockPosition: () => ipcRenderer.invoke("orbit:reset-dock-position"),
  onSettingsChanged: (cb: (settings: OrbitSettings) => void) => {
    const handler = (_e: unknown, settings: OrbitSettings) => cb(settings);
    ipcRenderer.on("orbit:settings-changed", handler);
    return () => ipcRenderer.removeListener("orbit:settings-changed", handler);
  },
  setViewMode: (mode: AppViewMode, dockEdge?: EdgeSide) =>
    ipcRenderer.invoke("orbit:set-view-mode", mode, dockEdge),
  toggleFullScreen: () => ipcRenderer.invoke("orbit:toggle-fullscreen"),
  onWindowState: (cb: (state: WindowStateInfo) => void) => {
    const handler = (_e: unknown, state: WindowStateInfo) => cb(state);
    ipcRenderer.on("orbit:window-state", handler);
    return () => ipcRenderer.removeListener("orbit:window-state", handler);
  },
  setTimeWindow: (mode: TimeWindowMode) => ipcRenderer.invoke("orbit:set-window", mode),
  setPinned: (pinned: boolean) => ipcRenderer.invoke("orbit:set-pinned", pinned),
  collapseDrawer: () => ipcRenderer.invoke("orbit:collapse"),
  triggerSimBurst: () => ipcRenderer.invoke("orbit:sim-burst"),
  clearSimulated: () => ipcRenderer.invoke("orbit:sim-clear"),
  showContextMenu: (nodeId?: string) => ipcRenderer.invoke("orbit:show-menu", nodeId),
  startEdgeDrag: () => ipcRenderer.invoke("orbit:drag-start"),
  endEdgeDrag: () => ipcRenderer.invoke("orbit:drag-end"),
  focusNode: (nodeId: string) => ipcRenderer.invoke("orbit:focus-node", nodeId),
  jumpToNextWaiting: (): Promise<FocusResult> => ipcRenderer.invoke("orbit:jump-waiting"),
  openFilePath: (filePath: string, nodeId?: string): Promise<OpenFileResult> =>
    ipcRenderer.invoke("orbit:open-file", filePath, nodeId),
  cycleWindowSize: () => ipcRenderer.invoke("orbit:cycle-size"),
  startWindowResize: (edge: ResizeEdge) => ipcRenderer.invoke("orbit:resize-start", edge),
  endWindowResize: () => ipcRenderer.invoke("orbit:resize-end"),

  onGraphSnapshot: (cb: (payload: GraphSnapshotPayload) => void) => {
    const handler = (_e: unknown, payload: GraphSnapshotPayload) => cb(payload);
    ipcRenderer.on("orbit:snapshot", handler);
    return () => ipcRenderer.removeListener("orbit:snapshot", handler);
  },

  onPulse: (cb: (pulse: LivePulseEvent) => void) => {
    const handler = (_e: unknown, pulse: LivePulseEvent) => cb(pulse);
    ipcRenderer.on("orbit:pulse", handler);
    return () => ipcRenderer.removeListener("orbit:pulse", handler);
  },

  onAttachment: (cb: (att: EdgeAttachment) => void) => {
    const handler = (_e: unknown, att: EdgeAttachment) => cb(att);
    ipcRenderer.on("orbit:attachment", handler);
    return () => ipcRenderer.removeListener("orbit:attachment", handler);
  },

  onOpenLog: (cb: (nodeId?: string) => void) => {
    const handler = (_e: unknown, nodeId?: string) => cb(nodeId);
    ipcRenderer.on("orbit:open-log", handler);
    return () => ipcRenderer.removeListener("orbit:open-log", handler);
  },

  onFocusResult: (cb: (res: FocusResult) => void) => {
    const handler = (_e: unknown, res: FocusResult) => cb(res);
    ipcRenderer.on("orbit:focus-result", handler);
    return () => ipcRenderer.removeListener("orbit:focus-result", handler);
  },
};

contextBridge.exposeInMainWorld("orbitBridge", api);
