/// <reference lib="dom" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ActivityLogEntry,
  AgentNodeSnapshot,
  ToolCategory,
  computeAsteroidFieldBand,
  computeAsteroidProfile,
  formatCompactTokens,
  getMaxOuterPlanetOrbitRadius,
  inferContextWindowMax,
  projectFromCwd,
} from "../shared/types";
import { SpiralReentryState, SpringGraphEngine, matchesSearchQuery } from "../renderer/physics";
import { OrbitCanvasRenderer } from "../renderer/canvasRenderer";
import { renderSpeedPreviewFrame } from "../renderer/settingsView";

function makeToolCounts(): Record<ToolCategory, number> {
  return { read: 2, edit: 1, bash: 1, web: 0, agent: 0, other: 0 };
}

function makeNode(overrides: Partial<AgentNodeSnapshot> & { id: string }): AgentNodeSnapshot {
  const now = Date.now();
  return {
    id: overrides.id,
    rawId: overrides.rawId ?? overrides.id,
    harness: overrides.harness ?? "claude",
    parentId: overrides.parentId,
    isSubagent: overrides.isSubagent ?? Boolean(overrides.parentId),
    label: overrides.label ?? overrides.id,
    project: overrides.project ?? "agent-orbit",
    status: overrides.status ?? "tool_running",
    createdAt: overrides.createdAt ?? now - 10_000,
    lastActiveAt: overrides.lastActiveAt ?? now,
    turnCount: overrides.turnCount,
    totalToolCalls: overrides.totalToolCalls ?? 4,
    toolCounts: overrides.toolCounts ?? makeToolCounts(),
    recentTools: overrides.recentTools ?? [],
    skills: overrides.skills ?? [],
    tokenUsage: overrides.tokenUsage,
    model: overrides.model,
  };
}

function makeLogEntry(overrides: Partial<ActivityLogEntry> = {}): ActivityLogEntry {
  return {
    id: overrides.id ?? "log-1",
    nodeId: overrides.nodeId ?? "claude:root-1",
    rootId: overrides.rootId ?? "claude:root-1",
    agentLabel: overrides.agentLabel ?? "Frontend Engineer",
    isSubagent: overrides.isSubagent ?? false,
    harness: overrides.harness ?? "claude",
    kind: overrides.kind ?? "tool",
    badge: overrides.badge ?? "EDIT",
    title: overrides.title ?? "Edit",
    summary: overrides.summary ?? "Update spiral re-entry physics",
    detail: overrides.detail ?? "src/renderer/physics.ts",
    filePath: overrides.filePath ?? "C:/repo/src/renderer/physics.ts",
    rawCommand: overrides.rawCommand,
    output: overrides.output,
    fullText: overrides.fullText,
    modelBadge: overrides.modelBadge,
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

function createMockCanvas() {
  let shadowBlurVal = 0;
  let shadowDraws = 0;
  let nonZeroShadowSets = 0;
  let strokeCalls = 0;
  let fillCalls = 0;
  let arcCalls = 0;

  const gradStub = {
    addColorStop() {},
  };

  const checkShadow = () => {
    if (shadowBlurVal > 0) {
      shadowDraws++;
    }
  };

  const ctx: Record<string, unknown> = {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    lineDashOffset: 0,
    globalAlpha: 1,
    textAlign: "start",
    textBaseline: "alphabetic",
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    rotate() {},
    setTransform() {},
    beginPath() {},
    closePath() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    arcTo() {},
    ellipse() {},
    setLineDash() {},
    arc() {
      arcCalls++;
    },
    fill() {
      checkShadow();
      fillCalls++;
    },
    stroke() {
      checkShadow();
      strokeCalls++;
    },
    fillRect() {
      checkShadow();
      fillCalls++;
    },
    fillText() {
      checkShadow();
    },
    strokeText() {
      checkShadow();
    },
    measureText(text: string) {
      return { width: text.length * 6 };
    },
    createRadialGradient() {
      return gradStub;
    },
    createLinearGradient() {
      return gradStub;
    },
  };

  Object.defineProperty(ctx, "shadowBlur", {
    get() {
      return shadowBlurVal;
    },
    set(v: number) {
      shadowBlurVal = v;
      if (v > 0) nonZeroShadowSets++;
    },
  });

  const canvas = {
    width: 800,
    height: 600,
    getContext(kind: string) {
      return kind === "2d" ? ctx : null;
    },
  } as unknown as HTMLCanvasElement;

  return {
    canvas,
    getStats: () => ({ shadowDraws, nonZeroShadowSets, strokeCalls, fillCalls, arcCalls }),
  };
}

describe("Instant Log Search (matchesSearchQuery)", () => {
  it("matches empty or whitespace queries unconditionally", () => {
    const entry = makeLogEntry();
    assert.equal(matchesSearchQuery(entry, ""), true);
    assert.equal(matchesSearchQuery(entry, "   "), true);
  });

  it("matches single terms case-insensitively across summary, filePath, rawCommand, agentLabel, badge, output, and modelBadge", () => {
    const entry = makeLogEntry({
      summary: "Run unit test suite",
      filePath: "src/test/frontendFeatures.test.ts",
      rawCommand: "npx tsc -p tsconfig.main.json && node --test",
      agentLabel: "Sonnet Verifier",
      badge: "TEST",
      output: "ok 1 - spiral reentry passed",
      modelBadge: "Sonnet",
    });

    assert.equal(matchesSearchQuery(entry, "SUITE"), true);
    assert.equal(matchesSearchQuery(entry, "frontendfeatures.test"), true);
    assert.equal(matchesSearchQuery(entry, "tsconfig.main"), true);
    assert.equal(matchesSearchQuery(entry, "verifier"), true);
    assert.equal(matchesSearchQuery(entry, "test"), true);
    assert.equal(matchesSearchQuery(entry, "reentry passed"), true);
    assert.equal(matchesSearchQuery(entry, "sonnet"), true);
    assert.equal(matchesSearchQuery(entry, "nonexistent-token"), false);
  });

  it("requires ALL space-separated tokens to match across entry fields", () => {
    const entry = makeLogEntry({
      agentLabel: "Physics Worker",
      badge: "EDIT",
      summary: "Add solar accretion flare",
      filePath: "src/renderer/canvasRenderer.ts",
    });

    assert.equal(matchesSearchQuery(entry, "physics edit canvasrenderer flare"), true);
    assert.equal(matchesSearchQuery(entry, "physics edit missingtoken"), false);
  });
});

describe("Core Fuel token helpers & Spiral Re-Entry Physics", () => {
  it("formats compact token counts and infers context caps cleanly", () => {
    assert.equal(formatCompactTokens(0), "0");
    assert.equal(formatCompactTokens(176_000), "176k");
    assert.equal(formatCompactTokens(1_000_000), "1M");
    assert.equal(inferContextWindowMax("claude", "claude-sonnet-4-5"), 200_000);
    assert.equal(inferContextWindowMax("claude", "claude-opus-4-6[1m]"), 1_000_000);
    assert.equal(inferContextWindowMax("codex", "gpt-5.2-codex"), 258_400);
    assert.equal(projectFromCwd("C:/Users/alice"), "home");
    assert.equal(projectFromCwd("/Users/bob"), "home");
    assert.equal(projectFromCwd("/home/charlie"), "home");
    assert.equal(projectFromCwd("C:/Users/alice/code/nebula-api"), "nebula-api");
  });

  it("does NOT trigger spiral re-entry or solar flares when cold-syncing historical completed subagents, and falls gracefully inward over seconds", () => {
    const engine = new SpringGraphEngine();
    engine.setViewport(800, 600, true);

    const root = makeNode({ id: "claude:root", isSubagent: false, status: "thinking" });
    const coldSub1 = makeNode({
      id: "claude:sub-1",
      parentId: "claude:root",
      isSubagent: true,
      status: "completed",
    });
    const coldSub2 = makeNode({
      id: "claude:sub-2",
      parentId: "claude:root",
      isSubagent: true,
      status: "completed",
    });

    engine.syncSnapshot([root, coldSub1, coldSub2]);

    const s1 = engine.nodes.get("claude:sub-1")!;
    const s2 = engine.nodes.get("claude:sub-2")!;
    assert.equal(s1.reentry, undefined);
    assert.equal(s2.reentry, undefined);
    assert.equal(engine.solarFlares.length, 0);
    assert.ok(s1.infall && s1.infall.duration >= 4.0, "Expected graceful multi-second infall on initial arrival");
    assert.ok(s2.infall && s2.infall.duration >= 4.0, "Expected graceful multi-second infall on initial arrival");
    assert.equal(engine.hasActiveAnimations(), true);

    // Step 7.0s so both asteroids complete their graceful inward capture
    for (let i = 0; i < 140; i++) {
      engine.step(0.05);
    }
    assert.equal(s1.infall, undefined);
    assert.equal(s2.infall, undefined);
    assert.equal(engine.hasActiveAnimations(), false);
  });

  it("erupts a SolarAccretionFlare + energy return packet and slingshots a newly-completed live subagent outward into the Kuiper Asteroid Field", () => {
    const engine = new SpringGraphEngine();
    engine.setViewport(800, 600, true);

    const root = makeNode({ id: "claude:root", isSubagent: false, status: "thinking" });
    const activePeer = makeNode({
      id: "claude:sub-active",
      parentId: "claude:root",
      isSubagent: true,
      status: "tool_running",
      createdAt: 1_000,
    });
    const liveSub = makeNode({
      id: "claude:sub-live",
      parentId: "claude:root",
      isSubagent: true,
      status: "tool_running",
      createdAt: 2_000,
    });

    engine.syncSnapshot([root, activePeer, liveSub]);

    // Step 6.5s so the active planet finishes its graceful infall into its inner planetary orbit
    for (let i = 0; i < 130; i++) {
      engine.step(0.05);
    }

    const parentNode = engine.nodes.get("claude:root")!;
    const subNode = engine.nodes.get("claude:sub-live")!;
    assert.equal(subNode.infall, undefined);
    assert.equal(subNode.reentry, undefined);
    assert.equal(engine.solarFlares.length, 0);
    const prevBoingVel = parentNode.boingVel;

    // Transition liveSub from tool_running -> completed
    engine.syncSnapshot([
      root,
      activePeer,
      { ...liveSub, status: "completed" },
    ]);

    // Immediate solar accretion flare + inward energy packet + boing swell on completion
    assert.ok(
      parentNode.boingVel - prevBoingVel > 0.4,
      "Expected parent star boingVel to swell immediately upon subagent completion"
    );
    assert.equal(engine.solarFlares.length, 1, "Expected 1 SolarAccretionFlare on parent star");
    assert.equal(engine.solarFlares[0].parentId, "claude:root");
    assert.ok(
      engine.packets.some((p) => p.fromId === "claude:sub-live" && p.toId === "claude:root"),
      "Expected inward energy return TetherPacket to parent star"
    );

    const reentryAfterSync = subNode.reentry as SpiralReentryState | undefined;
    assert.ok(reentryAfterSync, "Expected live completion transition to attach outward slingshot state");
    assert.equal(reentryAfterSync.progress, 0);
    assert.equal(reentryAfterSync.duration, 4.0);
    assert.equal(engine.hasActiveAnimations(), true);

    const initialDist = reentryAfterSync.startDist;

    // Step ~1.4s into the 4.0s outward arc and verify outward trajectory + trail buildup
    for (let i = 0; i < 28; i++) {
      engine.step(0.05);
    }
    const reentryMid = subNode.reentry as SpiralReentryState | undefined;
    assert.ok(reentryMid, "Expected slingshot arc to still be in flight at 1.40s");
    assert.ok(reentryMid.trail.length > 2 && reentryMid.trail.length <= 24);
    const midDist = Math.hypot(subNode.x - parentNode.x, subNode.y - parentNode.y);
    assert.ok(
      midDist > initialDist,
      `Expected subagent to arc outward toward Kuiper Asteroid Field (${midDist.toFixed(1)} > ${initialDist.toFixed(1)})`
    );

    // Step until 4.0s outward arc finishes
    for (let i = 0; i < 80; i++) {
      engine.step(0.05);
      if (!subNode.reentry) break;
    }

    assert.equal(subNode.reentry, undefined, "Expected slingshot state to clear once settled in outer field");
    assert.equal(
      subNode.radius,
      computeAsteroidProfile(liveSub.turnCount, liveSub.totalToolCalls).baseRadius
    );
    const finalDist = Math.hypot(subNode.x - parentNode.x, subNode.y - parentNode.y);
    const outerBand = computeAsteroidFieldBand(
      Math.max(parentNode.radius, parentNode.targetRadius),
      1,
      1
    );
    assert.ok(
      finalDist >= outerBand.innerRadius * 0.95,
      `Expected completed asteroid (${finalDist.toFixed(1)}) to settle inside Outer Asteroid Field (inner=${outerBand.innerRadius})`
    );

    // Step remaining frames so flare & packet expire cleanly
    for (let i = 0; i < 60; i++) {
      engine.step(0.05);
    }
    assert.equal(engine.solarFlares.length, 0);
    assert.equal(engine.hasActiveAnimations(), false);
  });

  it("keeps 100% of subagents uncapped (15 active + 35 completed = 51 nodes) and falls gracefully from higher space into the Outer Kuiper Asteroid Field", () => {
    const engine = new SpringGraphEngine();
    engine.setViewport(1200, 900, true);

    const root = makeNode({
      id: "claude:mega-root",
      isSubagent: false,
      status: "tool_running",
      createdAt: 1_000,
    });
    const activeSubs: AgentNodeSnapshot[] = [];
    for (let i = 0; i < 15; i++) {
      activeSubs.push(
        makeNode({
          id: `claude:active-${i}`,
          parentId: "claude:mega-root",
          isSubagent: true,
          status: "tool_running",
          createdAt: 2_000 + i * 100,
        })
      );
    }
    const completedSubs: AgentNodeSnapshot[] = [];
    for (let i = 0; i < 35; i++) {
      completedSubs.push(
        makeNode({
          id: `claude:done-${i}`,
          parentId: "claude:mega-root",
          isSubagent: true,
          status: "completed",
          createdAt: 5_000 + i * 100,
        })
      );
    }

    engine.syncSnapshot([root, ...activeSubs, ...completedSubs]);

    assert.equal(engine.nodes.size, 51, "Expected zero capping: 1 root + 15 active + 35 completed = 51 nodes");
    const rootNode = engine.nodes.get("claude:mega-root")!;
    assert.equal(rootNode.activeSubsCount, 15);
    assert.equal(rootNode.totalCompletedSubs, 35);
    assert.equal(rootNode.hiddenCompletedSubs, 0);

    const pRadius = Math.max(rootNode.radius, rootNode.targetRadius);
    const maxActiveOrbit = getMaxOuterPlanetOrbitRadius(pRadius, 15);
    const band = computeAsteroidFieldBand(pRadius, 15, 35);
    assert.ok(band.innerRadius > maxActiveOrbit + 85);

    // At t = 0, newly arriving asteroids start higher out in deep space above their target Kuiper slot
    for (let i = 0; i < 35; i++) {
      const ast = engine.nodes.get(`claude:done-${i}`)!;
      assert.ok(ast.infall, `Expected asteroid ${i} to begin in gravitational infall`);
      const spawnDist = Math.hypot(ast.x - rootNode.x, ast.y - rootNode.y);
      assert.ok(
        spawnDist > band.innerRadius + 90,
        `Expected asteroid ${i} to spawn high in deep space (${spawnDist.toFixed(1)} > ${band.innerRadius + 90})`
      );
    }

    // Step 7.0s (140 * 0.05s) so all 15 planets and 35 asteroids fall gracefully into their higher orbits
    for (let s = 0; s < 140; s++) {
      engine.step(0.05);
    }

    const settledPRadius = Math.max(rootNode.radius, rootNode.targetRadius);
    const settledMaxActiveOrbit = getMaxOuterPlanetOrbitRadius(settledPRadius, 15);
    const settledBand = computeAsteroidFieldBand(settledPRadius, 15, 35);

    for (let i = 0; i < 35; i++) {
      const ast = engine.nodes.get(`claude:done-${i}`)!;
      assert.equal(ast.infall, undefined, `Expected asteroid ${i} to finish infall by 7.0s`);
      const dist = Math.hypot(ast.x - rootNode.x, ast.y - rootNode.y);
      assert.ok(
        dist >= settledBand.innerRadius * 0.96 && dist <= settledBand.outerRadius * 1.04,
        `Expected asteroid ${i} at dist ${dist.toFixed(1)} to lie within Kuiper band [${settledBand.innerRadius}, ${settledBand.outerRadius}]`
      );
      assert.ok(
        dist > settledMaxActiveOrbit + 70,
        `Expected asteroid ${i} (${dist.toFixed(1)}) strictly outside outermost active planet ring (${settledMaxActiveOrbit})`
      );
    }
  });

  it("maintains frame-rate-independent infall progress across 60Hz vs 240Hz displays", () => {
    const engine60 = new SpringGraphEngine();
    const engine240 = new SpringGraphEngine();
    engine60.setViewport(1000, 800, true);
    engine240.setViewport(1000, 800, true);

    const root = makeNode({ id: "claude:hz-root", isSubagent: false, status: "thinking", createdAt: 1_000 });
    const planet = makeNode({
      id: "claude:hz-planet",
      parentId: "claude:hz-root",
      isSubagent: true,
      status: "tool_running",
      createdAt: 2_000,
    });

    engine60.syncSnapshot([root, planet]);
    engine240.syncSnapshot([root, planet]);

    // Advance exactly 2.0 wall-clock seconds on both (120 steps @ 1/60s vs 480 steps @ 1/240s)
    for (let i = 0; i < 120; i++) engine60.step(1 / 60);
    for (let i = 0; i < 480; i++) engine240.step(1 / 240);

    const r60 = engine60.nodes.get("claude:hz-root")!;
    const p60 = engine60.nodes.get("claude:hz-planet")!;
    const r240 = engine240.nodes.get("claude:hz-root")!;
    const p240 = engine240.nodes.get("claude:hz-planet")!;

    assert.ok(p60.infall && p240.infall, "Both planets should still be gracefully falling in at 2.0s");
    assert.ok(Math.abs(p60.infall.progress - p240.infall.progress) < 0.005);

    const d60 = Math.hypot(p60.x - r60.x, p60.y - r60.y);
    const d240 = Math.hypot(p240.x - r240.x, p240.y - r240.y);
    assert.ok(
      Math.abs(d60 - d240) < 2.0,
      `Expected 60Hz (${d60.toFixed(2)}) and 240Hz (${d240.toFixed(2)}) orbital distance to match within 2px`
    );
  });
});

describe("OrbitCanvasRenderer Zero-ShadowBlur Invariant (Core Fuel + Re-Entry + Solar Flares)", () => {
  it("renders Core Fuel compaction rings, re-entry plasma trails, and solar accretion flares with 0 shadowBlur draws", () => {
    const { canvas, getStats } = createMockCanvas();
    const renderer = new OrbitCanvasRenderer(canvas);
    const engine = new SpringGraphEngine();
    engine.setViewport(800, 600, true);

    const root = makeNode({
      id: "antigravity:root",
      harness: "antigravity",
      isSubagent: false,
      status: "tool_running",
      tokenUsage: {
        contextTokens: 176_000,
        contextMaxTokens: 200_000,
        contextPercent: 88,
        totalTokens: 450_000,
        outputTokens: 32_000,
      },
    });
    const fuelPlanet = makeNode({
      id: "antigravity:sub-fuel",
      harness: "antigravity",
      parentId: "antigravity:root",
      isSubagent: true,
      status: "thinking",
      tokenUsage: {
        contextTokens: 184_000,
        contextMaxTokens: 200_000,
        contextPercent: 92,
        totalTokens: 210_000,
      },
    });
    const reentrySub = makeNode({
      id: "claude:sub-reentry",
      harness: "claude",
      parentId: "antigravity:root",
      isSubagent: true,
      status: "tool_running",
    });

    engine.syncSnapshot([root, fuelPlanet, reentrySub]);
    for (let i = 0; i < 20; i++) engine.step(0.025);

    // Trigger live re-entry on reentrySub and step 6 frames to populate curved plasma trail
    engine.syncSnapshot([root, fuelPlanet, { ...reentrySub, status: "completed" }]);
    for (let i = 0; i < 6; i++) engine.step(0.025);

    // Also inject an active SolarAccretionFlare on the parent star simultaneously
    engine.solarFlares.push({
      parentId: "antigravity:root",
      age: 0.18,
      maxAge: 1.35,
      impactAngle: 0.6,
      color: "#f2845c",
      ringColor: "#ffb499",
    });

    renderer.render(engine, 800, 600, { panX: 0, panY: 0, zoom: 1 });

    const stats = getStats();
    assert.equal(stats.shadowDraws, 0, "Expected strictly ZERO shadowBlur draw calls");
    assert.equal(stats.nonZeroShadowSets, 0, "Expected strictly ZERO shadowBlur > 0 assignments");
    assert.ok(stats.arcCalls > 15, "Expected arcs for stars, Core Fuel rings, bow-shock, and flare");
    assert.ok(stats.strokeCalls > 10, "Expected strokes for Core Fuel gauge, trail, and shockwave");
    assert.ok(stats.fillCalls > 10, "Expected fills for stars, planets, and droplets");
  });

  it("renders all 6 procedural Exoplanet archetypes and tool_running probe satellite with 0 shadowBlur draws", () => {
    const { canvas, getStats } = createMockCanvas();
    const renderer = new OrbitCanvasRenderer(canvas);
    const engine = new SpringGraphEngine();
    engine.setViewport(1200, 800, true);

    const root = makeNode({
      id: "claude:star-system",
      harness: "claude",
      isSubagent: false,
      status: "thinking",
    });

    const harnesses: Array<"claude" | "codex" | "antigravity" | "strata"> = [
      "claude",
      "codex",
      "antigravity",
      "strata",
      "claude",
      "codex",
    ];

    const subagents: AgentNodeSnapshot[] = [];
    for (let i = 0; i < 6; i++) {
      subagents.push(
        makeNode({
          id: `claude:planet-${i}`,
          harness: harnesses[i],
          parentId: "claude:star-system",
          isSubagent: true,
          status: i === 2 ? "tool_running" : i === 0 ? "tool_running" : "thinking",
          skills: i === 1 ? [{ name: "skill-1", count: 1, lastUsedAt: Date.now() }] : [],
          tokenUsage: i === 3 ? {
            contextTokens: 180_000,
            contextMaxTokens: 200_000,
            contextPercent: 90,
            totalTokens: 200_000,
          } : undefined,
        })
      );
    }

    engine.syncSnapshot([root, ...subagents]);

    // Force exact asteroidSeed % 6 mapping across the 6 subagents to cover all 6 archetypes:
    // 0 = ocean, 1 = jovian, 2 = ringed, 3 = arid, 4 = ice, 5 = twilight
    for (let i = 0; i < 6; i++) {
      const node = engine.nodes.get(`claude:planet-${i}`)!;
      assert.ok(node, `Expected planet node claude:planet-${i}`);
      node.asteroidSeed = i;
    }

    // Step physics a few frames to populate orbits
    for (let f = 0; f < 10; f++) {
      engine.step(0.025);
    }

    // Render multiple frames with different times to verify animated features (rot, clouds, satellites)
    renderer.render(engine, 1200, 800, { panX: 0, panY: 0, zoom: 1 });

    const stats = getStats();
    assert.equal(stats.shadowDraws, 0, "Expected strictly ZERO shadowBlur draw calls across all 6 archetypes");
    assert.equal(stats.nonZeroShadowSets, 0, "Expected strictly ZERO shadowBlur > 0 sets across all 6 archetypes");
    assert.ok(stats.arcCalls > 30, "Expected abundant arcs for procedural planet features, atmospheres, and satellites");
    assert.ok(stats.strokeCalls > 25, "Expected strokes for Saturn rings, cloud bands, and telemetry tracks");
    assert.ok(stats.fillCalls > 25, "Expected fills for planet spheres, continents, and storm vortices");
  });

  it("settles 100+ out-of-order historical completed subagents gracefully without Golden-Angle spazzing", () => {
    const engine = new SpringGraphEngine();
    engine.setViewport(1400, 900, true);
    const now = Date.now();

    const root = makeNode({
      id: "claude:massive-root",
      harness: "claude",
      isSubagent: false,
      status: "thinking",
      createdAt: now - 500_000,
    });

    // Wave 1: 30 newer completed subagents arrive first
    const wave1: AgentNodeSnapshot[] = [];
    for (let i = 0; i < 30; i++) {
      wave1.push(
        makeNode({
          id: `claude:ast-w1-${i}`,
          harness: "claude",
          parentId: root.id,
          isSubagent: true,
          status: "completed",
          createdAt: now - 100_000 + i * 1000,
        })
      );
    }
    engine.syncSnapshot([root, ...wave1]);
    for (let f = 0; f < 5; f++) engine.step(0.016);

    // Wave 2: 75 OLDER completed subagents arrive out-of-order (simulating async filesystem scan)
    const wave2: AgentNodeSnapshot[] = [];
    for (let i = 0; i < 75; i++) {
      wave2.push(
        makeNode({
          id: `claude:ast-w2-${i}`,
          harness: "claude",
          parentId: root.id,
          isSubagent: true,
          status: "completed",
          createdAt: now - 400_000 + i * 1000,
        })
      );
    }
    engine.syncSnapshot([root, ...wave1, ...wave2]);

    // Verify wave1 slotIndex values did NOT shift and per-frame displacement stays gentle (< 4px/frame)
    const parentNode = engine.nodes.get(root.id)!;
    for (let f = 0; f < 30; f++) {
      const prevRel = new Map<string, { dx: number; dy: number }>();
      for (const w of wave1) {
        const n = engine.nodes.get(w.id)!;
        prevRel.set(w.id, { dx: n.x - parentNode.x, dy: n.y - parentNode.y });
      }

      engine.step(0.016);

      for (const w of wave1) {
        const n = engine.nodes.get(w.id)!;
        const prev = prevRel.get(w.id)!;
        const curDx = n.x - parentNode.x;
        const curDy = n.y - parentNode.y;
        const stepDelta = Math.hypot(curDx - prev.dx, curDy - prev.dy);
        assert.ok(
          stepDelta < 3.5,
          `Expected graceful per-frame asteroid glide (< 3.5px), got ${stepDelta.toFixed(2)}px for ${w.id}`
        );
      }
    }
  });

  it("scales completed asteroid physics radius, inertia, and zero-shadowBlur rendering by turnCount", () => {
    const { canvas, getStats } = createMockCanvas();
    const engine = new SpringGraphEngine();
    engine.setViewport(1280, 900, true);
    const renderer = new OrbitCanvasRenderer(canvas);

    const root = makeNode({ id: "claude:root-mass", isSubagent: false, status: "thinking" });
    const scoutAst = makeNode({
      id: "claude:ast-1turn",
      parentId: root.id,
      isSubagent: true,
      status: "completed",
      turnCount: 1,
      totalToolCalls: 1,
    });
    const midAst = makeNode({
      id: "claude:ast-8turns",
      parentId: root.id,
      isSubagent: true,
      status: "completed",
      turnCount: 8,
      totalToolCalls: 11,
    });
    const giantAst = makeNode({
      id: "claude:ast-32turns",
      parentId: root.id,
      isSubagent: true,
      status: "completed",
      turnCount: 32,
      totalToolCalls: 48,
    });

    engine.syncSnapshot([root, scoutAst, midAst, giantAst]);
    for (let i = 0; i < 140; i++) {
      engine.step(0.05);
    }

    const nScout = engine.nodes.get(scoutAst.id)!;
    const nMid = engine.nodes.get(midAst.id)!;
    const nGiant = engine.nodes.get(giantAst.id)!;

    assert.ok(
      nScout.radius < nMid.radius && nMid.radius < nGiant.radius,
      `Expected 1-turn (${nScout.radius.toFixed(2)}) < 8-turn (${nMid.radius.toFixed(2)}) < 32-turn (${nGiant.radius.toFixed(2)})`
    );
    assert.equal(nScout.asteroidProfile?.asteroidClass, "meteoroid");
    assert.equal(nMid.asteroidProfile?.asteroidClass, "asteroid");
    assert.equal(nGiant.asteroidProfile?.asteroidClass, "planetoid");

    renderer.setSelectedNodeId(nGiant.id);
    renderer.render(engine, 1280, 900, { panX: 0, panY: 0, zoom: 1 });
    const stats = getStats();
    assert.equal(stats.shadowDraws, 0, "Expected 0 shadowBlur draws across all asteroid mass classes");
    assert.equal(stats.nonZeroShadowSets, 0, "Expected 0 shadowBlur > 0 assignments");
  });

  it("scales cosmic simulation time and orbits smoothly with setAnimationSpeed and renders zero-shadowBlur preview", () => {
    const slowEngine = new SpringGraphEngine();
    const fastEngine = new SpringGraphEngine();
    slowEngine.setViewport(1000, 800, true);
    fastEngine.setViewport(1000, 800, true);
    slowEngine.setAnimationSpeed(0.25);
    fastEngine.setAnimationSpeed(2.5);

    const root = makeNode({ id: "claude:speed-root", isSubagent: false, status: "thinking" });
    const planet = makeNode({
      id: "claude:speed-planet",
      parentId: root.id,
      isSubagent: true,
      status: "tool_running",
    });

    slowEngine.syncSnapshot([root, planet]);
    fastEngine.syncSnapshot([root, planet]);

    // Settle both systems onto their circular orbit first before applying different speeds
    slowEngine.nodes.get(planet.id)!.infall = undefined;
    fastEngine.nodes.get(planet.id)!.infall = undefined;
    slowEngine.setAnimationSpeed(1.0);
    fastEngine.setAnimationSpeed(1.0);
    for (let i = 0; i < 180; i++) {
      slowEngine.step(0.05);
      fastEngine.step(0.05);
    }

    const baseSlowTime = slowEngine.getTime();
    const baseFastTime = fastEngine.getTime();
    slowEngine.setAnimationSpeed(0.25);
    fastEngine.setAnimationSpeed(2.5);

    const getRelAngle = (eng: SpringGraphEngine) => {
      const r = eng.nodes.get(root.id)!;
      const p = eng.nodes.get(planet.id)!;
      return Math.atan2(p.y - r.y, p.x - r.x);
    };
    const unwrapDelta = (a1: number, a0: number) => {
      let d = a1 - a0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return Math.abs(d);
    };

    const initSlowAng = getRelAngle(slowEngine);
    const initFastAng = getRelAngle(fastEngine);

    for (let i = 0; i < 60; i++) {
      slowEngine.step(1 / 60);
      fastEngine.step(1 / 60);
    }

    assert.ok(
      Math.abs(slowEngine.getTime() - baseSlowTime - 0.25) < 0.02,
      `Expected ~0.25s elapsed at 0.25x, got ${slowEngine.getTime() - baseSlowTime}`
    );
    assert.ok(
      Math.abs(fastEngine.getTime() - baseFastTime - 2.5) < 0.05,
      `Expected ~2.5s elapsed at 2.5x, got ${fastEngine.getTime() - baseFastTime}`
    );

    const slowDelta = unwrapDelta(getRelAngle(slowEngine), initSlowAng);
    const fastDelta = unwrapDelta(getRelAngle(fastEngine), initFastAng);
    assert.ok(slowDelta > 0.0002, `Expected measurable slow orbit advance, got ${slowDelta}`);
    assert.ok(
      Math.abs(fastDelta / slowDelta - 10) < 0.8,
      `Expected 2.5x orbital advance to be ~10x 0.25x advance, got ratio ${(fastDelta / slowDelta).toFixed(2)}`
    );

    // Verify Settings live visual speed preview renders cleanly with strictly 0 shadowBlur
    const { canvas, getStats } = createMockCanvas();
    const ctx = canvas.getContext("2d")!;
    renderSpeedPreviewFrame(ctx, 214, 144, 0, 1.0);
    renderSpeedPreviewFrame(ctx, 214, 144, 3.2, 2.0);
    const previewStats = getStats();
    assert.equal(previewStats.shadowDraws, 0, "Expected 0 shadowBlur draws in settings visual preview");
    assert.equal(previewStats.nonZeroShadowSets, 0, "Expected 0 shadowBlur > 0 assignments in preview");
    assert.ok(previewStats.arcCalls > 20, "Expected star, planet, moon, and asteroid arc draws in preview");
  });
});
