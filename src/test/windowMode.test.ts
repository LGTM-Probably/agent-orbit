import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AppViewMode,
  WindowStateInfo,
  OrbitBridgeAPI,
  OrbitSettings,
  clampAnimationSpeed,
  formatAnimationSpeedDescriptor,
} from "../shared/types";
import {
  AppWindowBounds,
  PersistedDockConfig,
  resolveAnimationSpeed,
  resolveFlashTaskbarOnWaiting,
} from "../main/edgeWindow";

describe("WindowMode & Dual-Mode Contracts", () => {
  it("validates AppViewMode and WindowStateInfo structure", () => {
    const windowState: WindowStateInfo = {
      viewMode: "window",
      isMaximized: false,
      isFullScreen: false,
      alwaysOnTop: false,
    };

    assert.strictEqual(windowState.viewMode, "window");
    assert.strictEqual(windowState.isMaximized, false);
    assert.strictEqual(windowState.isFullScreen, false);
    assert.strictEqual(windowState.alwaysOnTop, false);

    const dockState: WindowStateInfo = {
      viewMode: "dock",
      isMaximized: false,
      isFullScreen: false,
      alwaysOnTop: true,
    };
    assert.strictEqual(dockState.viewMode, "dock");
    assert.strictEqual(dockState.alwaysOnTop, true);
  });

  it("validates PersistedDockConfig defaults and bounds", () => {
    const rawSaved: Partial<PersistedDockConfig> = {
      displayId: 1,
      edge: "right",
      offsetRatio: 0.5,
    };

    // Default viewMode must be "window" when undefined
    const viewMode: AppViewMode = rawSaved.viewMode ?? "window";
    assert.strictEqual(viewMode, "window");

    const savedBounds: AppWindowBounds = {
      x: 100,
      y: 120,
      width: 1240,
      height: 840,
      isMaximized: true,
    };

    const config: PersistedDockConfig = {
      displayId: rawSaved.displayId ?? 1,
      edge: rawSaved.edge ?? "right",
      offsetRatio: rawSaved.offsetRatio ?? 0.5,
      viewMode,
      appWindowBounds: savedBounds,
    };

    assert.strictEqual(config.viewMode, "window");
    assert.strictEqual(config.appWindowBounds?.width, 1240);
    assert.strictEqual(config.appWindowBounds?.height, 840);
    assert.strictEqual(config.appWindowBounds?.isMaximized, true);
  });

  it("defaults PersistedDockConfig.flashTaskbarOnWaiting to false and round-trips true/false", () => {
    assert.strictEqual(resolveFlashTaskbarOnWaiting(undefined), false);
    assert.strictEqual(resolveFlashTaskbarOnWaiting(null), false);

    const omittedConfig: PersistedDockConfig = {
      displayId: 1,
      edge: "right",
      offsetRatio: 0.5,
    };
    assert.strictEqual(resolveFlashTaskbarOnWaiting(omittedConfig), false);

    const enabledJson = JSON.stringify({
      ...omittedConfig,
      flashTaskbarOnWaiting: true,
    } satisfies PersistedDockConfig);
    const parsedEnabled = JSON.parse(enabledJson) as PersistedDockConfig;
    assert.strictEqual(resolveFlashTaskbarOnWaiting(parsedEnabled), true);

    const disabledJson = JSON.stringify({
      ...omittedConfig,
      flashTaskbarOnWaiting: false,
    } satisfies PersistedDockConfig);
    const parsedDisabled = JSON.parse(disabledJson) as PersistedDockConfig;
    assert.strictEqual(resolveFlashTaskbarOnWaiting(parsedDisabled), false);
  });

  it("defaults PersistedDockConfig.animationSpeed to 1.0, clamps bounds, and round-trips", () => {
    assert.strictEqual(resolveAnimationSpeed(undefined), 1.0);
    assert.strictEqual(resolveAnimationSpeed(null), 1.0);
    assert.strictEqual(clampAnimationSpeed(NaN), 1.0);
    assert.strictEqual(clampAnimationSpeed(0.01), 0.1);
    assert.strictEqual(clampAnimationSpeed(9.5), 3.0);
    assert.strictEqual(clampAnimationSpeed(1.75), 1.75);

    assert.strictEqual(formatAnimationSpeedDescriptor(0.25), "Drift");
    assert.strictEqual(formatAnimationSpeedDescriptor(0.5), "Calm");
    assert.strictEqual(formatAnimationSpeedDescriptor(1.0), "Normal");
    assert.strictEqual(formatAnimationSpeedDescriptor(1.5), "Brisk");
    assert.strictEqual(formatAnimationSpeedDescriptor(2.5), "Swift");

    const savedJson = JSON.stringify({
      displayId: 1,
      edge: "right",
      offsetRatio: 0.5,
      animationSpeed: 0.45,
    } satisfies PersistedDockConfig);
    const parsed = JSON.parse(savedJson) as PersistedDockConfig;
    assert.strictEqual(resolveAnimationSpeed(parsed), 0.45);
  });

  it("verifies OrbitBridgeAPI shape compatibility", () => {
    const defaultSettings: OrbitSettings = {
      animationSpeed: 1.0,
      viewMode: "window",
      dockEdge: "right",
      sizePreset: "compact",
      isPinned: false,
      alwaysOnTop: false,
      flashTaskbarOnWaiting: false,
      openAtLogin: false,
      simActive: false,
    };

    // Type-level assertion that bridge API satisfies the dual-mode + settings contract
    const mockBridge: OrbitBridgeAPI = {
      getInitialState: async () => ({
        graph: {
          nodes: [],
          activityLog: [],
          timeWindow: "live",
          simActive: false,
          updatedAt: Date.now(),
        },
        attachment: {
          displayId: 1,
          edge: "right",
          offsetRatio: 0.5,
          isExpanded: false,
          isPinned: false,
          isDragging: false,
          sizePreset: "compact",
          drawerWidth: 430,
          drawerHeight: 650,
        },
        windowState: {
          viewMode: "window",
          isMaximized: false,
          isFullScreen: false,
          alwaysOnTop: false,
        },
        animationSpeed: 1.0,
      }),
      getLogDetail: async _id => null,
      openSettings: async () => {},
      getSettings: async () => defaultSettings,
      updateSettings: async patch => ({ ...defaultSettings, ...patch }),
      resetDockPosition: async () => {},
      onSettingsChanged: _cb => () => {},
      setViewMode: async (_mode, _edge) => {},
      toggleFullScreen: async () => {},
      onWindowState: _cb => () => {},
      setTimeWindow: async _m => {},
      setPinned: async _p => {},
      collapseDrawer: async () => {},
      triggerSimBurst: async () => {},
      clearSimulated: async () => {},
      showContextMenu: async _id => {},
      startEdgeDrag: async () => {},
      endEdgeDrag: async () => {},
      focusNode: async _id => ({ ok: true }),
      jumpToNextWaiting: async () => ({ ok: true }),
      openFilePath: async (_p, _id) => ({ ok: true }),
      cycleWindowSize: async () => {},
      startWindowResize: async _e => {},
      endWindowResize: async () => {},
      onGraphSnapshot: _cb => () => {},
      onPulse: _cb => () => {},
      onAttachment: _cb => () => {},
      onOpenLog: _cb => () => {},
      onFocusResult: _cb => () => {},
    };

    assert.ok(mockBridge.setViewMode);
    assert.ok(mockBridge.openSettings);
    assert.ok(mockBridge.updateSettings);
    assert.ok(mockBridge.onWindowState);
  });
});
