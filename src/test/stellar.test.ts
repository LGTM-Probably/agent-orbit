import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentNodeSnapshot,
  ConstellationRootTarget,
  computeAsteroidFieldBand,
  computeAsteroidProfile,
  computeConstellationAnchors,
  computeStarSleepState,
  computeStellarProfile,
  getEffectiveTurnCount,
  getInnerBeltOrbitRadius,
  getMaxOuterPlanetOrbitRadius,
  getOuterPlanetOrbitRadius,
  getPlanetOrbitRadiusForRing,
  getPlanetRingAssignment,
  getSystemReach,
} from "../shared/types";

describe("Stellar Evolution & Mass Classes", () => {
  it("classifies stars into accurate astrophysical spectral classes based on subagent count", () => {
    const dwarf0 = computeStellarProfile(0, 0);
    assert.strictEqual(dwarf0.stellarClass, "white_dwarf");
    assert.strictEqual(dwarf0.label, "White Dwarf");
    assert.strictEqual(dwarf0.convective, false);
    assert.strictEqual(dwarf0.coreCenter, "#ffffff");

    const yellow1 = computeStellarProfile(1, 0);
    assert.strictEqual(yellow1.stellarClass, "yellow_star");
    assert.strictEqual(yellow1.label, "Yellow Star");
    assert.strictEqual(yellow1.convective, false);
    assert.strictEqual(yellow1.coreCenter, "#fffef5");

    const yellow2 = computeStellarProfile(2, 0);
    assert.strictEqual(yellow2.stellarClass, "yellow_star");

    const orange3 = computeStellarProfile(3, 0);
    assert.strictEqual(orange3.stellarClass, "orange_giant");
    assert.strictEqual(orange3.label, "Orange Giant");
    assert.strictEqual(orange3.convective, true);

    const orange5 = computeStellarProfile(5, 0);
    assert.strictEqual(orange5.stellarClass, "orange_giant");

    const red6 = computeStellarProfile(6, 0);
    assert.strictEqual(red6.stellarClass, "red_giant");
    assert.strictEqual(red6.label, "Red Giant");
    assert.strictEqual(red6.convective, true);

    const red11 = computeStellarProfile(11, 0);
    assert.strictEqual(red11.stellarClass, "red_giant");

    const super12 = computeStellarProfile(12, 0);
    assert.strictEqual(super12.stellarClass, "red_supergiant");
    assert.strictEqual(super12.label, "Red Supergiant");
    assert.strictEqual(super12.convective, true);

    const super24 = computeStellarProfile(24, 0);
    assert.strictEqual(super24.stellarClass, "red_supergiant");
  });

  it("verifies strictly monotonic radius growth across stellar evolution", () => {
    const rDwarf = computeStellarProfile(0, 5).baseRadius;
    const rYellow1 = computeStellarProfile(1, 5).baseRadius;
    const rYellow2 = computeStellarProfile(2, 5).baseRadius;
    const rOrange3 = computeStellarProfile(3, 0).baseRadius;
    const rOrange5 = computeStellarProfile(5, 0).baseRadius;
    const rRed6 = computeStellarProfile(6, 0).baseRadius;
    const rRed11 = computeStellarProfile(11, 0).baseRadius;
    const rSuper12 = computeStellarProfile(12, 0).baseRadius;
    const rSuper20 = computeStellarProfile(20, 0).baseRadius;

    assert.ok(
      rDwarf < rYellow1,
      `White Dwarf (${rDwarf}) should be smaller than Yellow Star 1 (${rYellow1})`
    );
    assert.ok(
      rYellow1 < rYellow2,
      `Yellow Star 1 (${rYellow1}) should be smaller than Yellow Star 2 (${rYellow2})`
    );
    assert.ok(
      rYellow2 < rOrange3,
      `Yellow Star 2 (${rYellow2}) should be smaller than Orange Giant 3 (${rOrange3})`
    );
    assert.ok(
      rOrange3 < rOrange5,
      `Orange Giant 3 (${rOrange3}) should be smaller than Orange Giant 5 (${rOrange5})`
    );
    assert.ok(
      rOrange5 < rRed6,
      `Orange Giant 5 (${rOrange5}) should be smaller than Red Giant 6 (${rRed6})`
    );
    assert.ok(
      rRed6 < rRed11,
      `Red Giant 6 (${rRed6}) should be smaller than Red Giant 11 (${rRed11})`
    );
    assert.ok(
      rRed11 < rSuper12,
      `Red Giant 11 (${rRed11}) should be smaller than Red Supergiant 12 (${rSuper12})`
    );
    assert.ok(
      rSuper12 <= rSuper20,
      `Red Supergiant 12 (${rSuper12}) should be <= Red Supergiant 20 (${rSuper20})`
    );
    assert.ok(
      rSuper20 <= 58,
      `Red Supergiant radius (${rSuper20}) must be capped at 58`
    );
  });
});

describe("Asteroid Mass Evolution by Turn Count", () => {
  it("classifies completed subagent asteroids into 5 minor-planet classes with strictly monotonic radius growth", () => {
    const met0 = computeAsteroidProfile(0, 0);
    const met1 = computeAsteroidProfile(1, 2);
    assert.strictEqual(met0.asteroidClass, "meteoroid");
    assert.strictEqual(met0.label, "Meteoroid");
    assert.strictEqual(met0.facets, 6);
    assert.strictEqual(met0.craters, 1);
    assert.strictEqual(met1.asteroidClass, "meteoroid");

    const chon2 = computeAsteroidProfile(2, 3);
    const chon4 = computeAsteroidProfile(4, 5);
    assert.strictEqual(chon2.asteroidClass, "chondrite");
    assert.strictEqual(chon2.label, "Chondrite");
    assert.strictEqual(chon2.facets, 7);
    assert.strictEqual(chon2.craters, 2);

    const ast5 = computeAsteroidProfile(5, 7);
    const ast11 = computeAsteroidProfile(11, 14);
    assert.strictEqual(ast5.asteroidClass, "asteroid");
    assert.strictEqual(ast5.label, "Asteroid");
    assert.strictEqual(ast5.facets, 8);

    const plan12 = computeAsteroidProfile(12, 18);
    const plan24 = computeAsteroidProfile(24, 30);
    assert.strictEqual(plan12.asteroidClass, "planetesimal");
    assert.strictEqual(plan12.label, "Planetesimal");
    assert.strictEqual(plan12.facets, 9);
    assert.strictEqual(plan12.craters, 3);

    const pld25 = computeAsteroidProfile(25, 35);
    const pld60 = computeAsteroidProfile(60, 90);
    assert.strictEqual(pld25.asteroidClass, "planetoid");
    assert.strictEqual(pld25.label, "Dwarf Planetoid");
    assert.strictEqual(pld25.facets, 10);
    assert.strictEqual(pld25.craters, 3);

    const radii = [
      met0.baseRadius,
      met1.baseRadius,
      chon2.baseRadius,
      chon4.baseRadius,
      ast5.baseRadius,
      ast11.baseRadius,
      plan12.baseRadius,
      plan24.baseRadius,
      pld25.baseRadius,
      pld60.baseRadius,
    ];
    for (let i = 1; i < radii.length; i++) {
      assert.ok(
        radii[i - 1] < radii[i],
        `Expected strictly monotonic asteroid radius growth: step ${i - 1} (${radii[i - 1]}) < step ${i} (${radii[i]})`
      );
    }
    assert.ok(
      pld60.baseRadius <= 13.8 && pld60.baseRadius < 14.5,
      `Largest Dwarf Planetoid (${pld60.baseRadius}) must stay bounded below active Exoplanets (14.5px)`
    );

    // Fallback to totalToolCalls when turnCount is 0 (e.g. parent-hint-only subagent)
    assert.strictEqual(getEffectiveTurnCount(0, 16), 16);
    assert.strictEqual(computeAsteroidProfile(0, 16).asteroidClass, "planetesimal");
  });
});

describe("Star-Only Sleep State & Progressive Dimming", () => {
  const now = 1_000_000_000;

  it("never puts subagents to sleep even after hours", () => {
    const subIdle: Pick<AgentNodeSnapshot, "isSubagent" | "status" | "lastActiveAt"> = {
      isSubagent: true,
      status: "idle",
      lastActiveAt: now - 3600_000, // 1 hour ago
    };
    const res = computeStarSleepState(subIdle, now);
    assert.strictEqual(res.isResting, false);
    assert.strictEqual(res.isAsleep, false);
    assert.strictEqual(res.sleepDepth, 0);

    const subDone: Pick<AgentNodeSnapshot, "isSubagent" | "status" | "lastActiveAt"> = {
      isSubagent: true,
      status: "completed",
      lastActiveAt: now - 7200_000,
    };
    const resDone = computeStarSleepState(subDone, now);
    assert.strictEqual(resDone.isAsleep, false);
  });

  it("keeps active and waiting root stars awake with isAsleep false", () => {
    const activeStar: Pick<AgentNodeSnapshot, "isSubagent" | "status" | "lastActiveAt"> = {
      isSubagent: false,
      status: "tool_running",
      lastActiveAt: now - 300_000,
    };
    const resActive = computeStarSleepState(activeStar, now);
    assert.strictEqual(resActive.isAsleep, false);
    assert.strictEqual(resActive.isResting, false);

    const waitingStar: Pick<AgentNodeSnapshot, "isSubagent" | "status" | "lastActiveAt"> = {
      isSubagent: false,
      status: "waiting_on_user",
      lastActiveAt: now - 300_000,
    };
    const resWaiting = computeStarSleepState(waitingStar, now);
    assert.strictEqual(resWaiting.isAsleep, false);
  });

  it("marks recently idle root stars (<90s) as resting but not asleep", () => {
    const restingStar: Pick<AgentNodeSnapshot, "isSubagent" | "status" | "lastActiveAt"> = {
      isSubagent: false,
      status: "idle",
      lastActiveAt: now - 30_000, // 30s ago
    };
    const res = computeStarSleepState(restingStar, now);
    assert.strictEqual(res.isResting, true);
    assert.strictEqual(res.isAsleep, false);
    assert.strictEqual(res.sleepDepth, 0);
    assert.strictEqual(res.idleMs, 30_000);
  });

  it("transitions root stars into deep slumber (>=90s) with smooth sleepDepth ramp", () => {
    // 90s: onset of sleep
    const onsetStar: Pick<AgentNodeSnapshot, "isSubagent" | "status" | "lastActiveAt"> = {
      isSubagent: false,
      status: "idle",
      lastActiveAt: now - 90_000,
    };
    const resOnset = computeStarSleepState(onsetStar, now);
    assert.strictEqual(resOnset.isResting, true);
    assert.strictEqual(resOnset.isAsleep, true);
    assert.strictEqual(resOnset.sleepDepth, 0.2);

    // 135s: midpoint between 90s and 180s
    const midStar: Pick<AgentNodeSnapshot, "isSubagent" | "status" | "lastActiveAt"> = {
      isSubagent: false,
      status: "idle",
      lastActiveAt: now - 135_000,
    };
    const resMid = computeStarSleepState(midStar, now);
    assert.strictEqual(resMid.isAsleep, true);
    assert.strictEqual(resMid.sleepDepth, 0.5);

    // 300s (5m): full sleep depth
    const deepStar: Pick<AgentNodeSnapshot, "isSubagent" | "status" | "lastActiveAt"> = {
      isSubagent: false,
      status: "idle",
      lastActiveAt: now - 300_000,
    };
    const resDeep = computeStarSleepState(deepStar, now);
    assert.strictEqual(resDeep.isResting, true);
    assert.strictEqual(resDeep.isAsleep, true);
    assert.strictEqual(resDeep.sleepDepth, 1.0);
    assert.strictEqual(resDeep.idleMs, 300_000);
  });
});

describe("Astrophysical Orbit Rings & Clearance", () => {
  it("guarantees high active planetary rings (> r + 110) and high asteroid belt clearance (> r + 170) across all stellar sizes", () => {
    const testRadii = [19.5, 22, 26, 31.5, 34, 38.4, 42, 49, 51, 58];
    for (const r of testRadii) {
      const innerPlanet = getOuterPlanetOrbitRadius(r, 1);
      const innerBelt = getInnerBeltOrbitRadius(r);
      assert.ok(
        innerPlanet > r + 110,
        `Active planetary orbit ${innerPlanet} must exceed r (${r}) + 110`
      );
      assert.ok(
        innerBelt > r + 170,
        `Asteroid belt radius ${innerBelt} must exceed r (${r}) + 170`
      );
    }
  });

  it("guarantees outer Kuiper Asteroid Field sits strictly beyond active planetary orbits with >= 90px gap", () => {
    for (let r = 20; r <= 58; r += 5) {
      for (let siblings = 1; siblings <= 12; siblings++) {
        const activeOuter = getOuterPlanetOrbitRadius(r, siblings);
        const fieldBand = computeAsteroidFieldBand(r, siblings, 12);
        assert.ok(
          fieldBand.innerRadius > activeOuter + 90,
          `Asteroid field innerRadius (${fieldBand.innerRadius}) must exceed outer planet orbit (${activeOuter}) + 90 for r=${r}, siblings=${siblings}`
        );
      }
    }
  });
});

describe("Multi-Ring Planetary Orbits for Large Swarms", () => {
  it("splits active subagents into concentric rings (Ring 0 <= 8, Ring 1 <= 12, Ring 2 remaining)", () => {
    // 1 subagent: ring 0
    const a1 = getPlanetRingAssignment(0, 1);
    assert.strictEqual(a1.ringIndex, 0);
    assert.strictEqual(a1.indexInRing, 0);
    assert.strictEqual(a1.countInRing, 1);

    // 8 subagents: all on ring 0
    for (let i = 0; i < 8; i++) {
      const a = getPlanetRingAssignment(i, 8);
      assert.strictEqual(a.ringIndex, 0);
      assert.strictEqual(a.indexInRing, i);
      assert.strictEqual(a.countInRing, 8);
    }

    // 9 subagents: 8 on ring 0, 1 on ring 1
    const a9_0 = getPlanetRingAssignment(0, 9);
    assert.strictEqual(a9_0.ringIndex, 0);
    assert.strictEqual(a9_0.countInRing, 8);
    const a9_8 = getPlanetRingAssignment(8, 9);
    assert.strictEqual(a9_8.ringIndex, 1);
    assert.strictEqual(a9_8.indexInRing, 0);
    assert.strictEqual(a9_8.countInRing, 1);

    // 20 subagents: 8 on ring 0, 12 on ring 1
    const a20_0 = getPlanetRingAssignment(0, 20);
    assert.strictEqual(a20_0.ringIndex, 0);
    assert.strictEqual(a20_0.countInRing, 8);

    const a20_7 = getPlanetRingAssignment(7, 20);
    assert.strictEqual(a20_7.ringIndex, 0);
    assert.strictEqual(a20_7.indexInRing, 7);

    const a20_8 = getPlanetRingAssignment(8, 20);
    assert.strictEqual(a20_8.ringIndex, 1);
    assert.strictEqual(a20_8.indexInRing, 0);
    assert.strictEqual(a20_8.countInRing, 12);

    const a20_19 = getPlanetRingAssignment(19, 20);
    assert.strictEqual(a20_19.ringIndex, 1);
    assert.strictEqual(a20_19.indexInRing, 11);
    assert.strictEqual(a20_19.countInRing, 12);

    // 25 subagents: 8 on ring 0, 12 on ring 1, 5 on ring 2
    const a25_20 = getPlanetRingAssignment(20, 25);
    assert.strictEqual(a25_20.ringIndex, 2);
    assert.strictEqual(a25_20.indexInRing, 0);
    assert.strictEqual(a25_20.countInRing, 5);

    const a25_24 = getPlanetRingAssignment(24, 25);
    assert.strictEqual(a25_24.ringIndex, 2);
    assert.strictEqual(a25_24.indexInRing, 4);
    assert.strictEqual(a25_24.countInRing, 5);
  });

  it("guarantees minimum arc spacing >= 54px along ring circumference for large swarms", () => {
    const parentRadius = 58; // Red Supergiant
    for (const totalSubs of [8, 16, 20, 28, 35]) {
      for (let slot = 0; slot < totalSubs; slot++) {
        const assign = getPlanetRingAssignment(slot, totalSubs);
        const radius = getPlanetOrbitRadiusForRing(
          parentRadius,
          assign.ringIndex,
          assign.countInRing
        );
        const circumference = 2 * Math.PI * radius;
        const arcSpacing = circumference / assign.countInRing;
        assert.ok(
          arcSpacing >= 54,
          `Arc spacing (${arcSpacing.toFixed(1)}px) on ring ${assign.ringIndex} for ${assign.countInRing} siblings must be >= 54px`
        );
      }
    }
  });

  it("ensures each outer ring sits strictly beyond previous ring with clearance >= 60px", () => {
    const parentRadius = 45;
    const r0 = getPlanetOrbitRadiusForRing(parentRadius, 0, 8);
    const r1 = getPlanetOrbitRadiusForRing(parentRadius, 1, 12);
    const r2 = getPlanetOrbitRadiusForRing(parentRadius, 2, 8);

    assert.ok(r1 >= r0 + 60, `Ring 1 (${r1}) must be >= Ring 0 (${r0}) + 60`);
    assert.ok(r2 >= r1 + 60, `Ring 2 (${r2}) must be >= Ring 1 (${r1}) + 60`);
  });
});

describe("Spacious 2D Constellation Layout & Anti-Crowding Clearance", () => {
  it("centers a single orchestrator star in viewport", () => {
    const anchors = computeConstellationAnchors(
      [{ id: "star-1", targetRadius: 30 }],
      500,
      800,
      false
    );
    assert.strictEqual(anchors.size, 1);
    const pos = anchors.get("star-1");
    assert.ok(pos);
    assert.strictEqual(pos.x, 250);
    assert.strictEqual(pos.y, 400);
  });

  it("spaces 6 stars in portrait mode in a 2x3 staggered constellation with generous clearance", () => {
    const roots: ConstellationRootTarget[] = [
      { id: "s1", targetRadius: 20, activeSubsCount: 0, totalCompletedSubs: 0 },
      { id: "s2", targetRadius: 28, activeSubsCount: 2, totalCompletedSubs: 1 },
      { id: "s3", targetRadius: 36, activeSubsCount: 4, totalCompletedSubs: 2 },
      { id: "s4", targetRadius: 46, activeSubsCount: 6, totalCompletedSubs: 3 },
      { id: "s5", targetRadius: 58, activeSubsCount: 20, totalCompletedSubs: 10 }, // Massive 20-subagent Supergiant
      { id: "s6", targetRadius: 22, activeSubsCount: 0, totalCompletedSubs: 0 },
    ];

    const anchors = computeConstellationAnchors(roots, 440, 750, false);
    assert.strictEqual(anchors.size, 6);

    const positions = roots.map(r => ({ id: r.id, pos: anchors.get(r.id)! }));

    // Pairwise non-overlapping check: center-to-center distance must be >= 250px
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i];
        const b = positions[j];
        const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        assert.ok(
          dist >= 250,
          `Stars ${a.id} and ${b.id} are too close: ${dist.toFixed(1)}px (minimum 250px)`
        );
      }
    }

    // Clearance for massive 20-subagent supergiant (s5) to any neighbor must be >= 450px
    const s5Pos = anchors.get("s5")!;
    for (const r of roots) {
      if (r.id === "s5") continue;
      const otherPos = anchors.get(r.id)!;
      const dist = Math.hypot(s5Pos.x - otherPos.x, s5Pos.y - otherPos.y);
      assert.ok(
        dist >= 450,
        `Supergiant s5 should have generous clearance (>=450px) to neighbor ${r.id}, but got ${dist.toFixed(1)}px`
      );
    }
  });

  it("arranges roots into wide columns in horizontal layout", () => {
    const roots: ConstellationRootTarget[] = [
      { id: "s1", targetRadius: 20 },
      { id: "s2", targetRadius: 28 },
      { id: "s3", targetRadius: 36 },
      { id: "s4", targetRadius: 46 },
    ];

    const anchors = computeConstellationAnchors(roots, 1600, 600, true);
    assert.strictEqual(anchors.size, 4);

    const p1 = anchors.get("s1")!;
    const p2 = anchors.get("s2")!;
    const p3 = anchors.get("s3")!;
    const p4 = anchors.get("s4")!;

    // In 1600x600 horizontal layout, columns span horizontally
    assert.ok(p1.x < p2.x || p2.x < p3.x || p3.x < p4.x);
  });
});
