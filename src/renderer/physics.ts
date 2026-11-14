import {
  ActivityLogEntry,
  AgentNodeSnapshot,
  AsteroidFieldBand,
  AsteroidProfile,
  ConstellationRootTarget,
  HarnessKind,
  LivePulseEvent,
  StellarProfile,
  ToolCategory,
  clampAnimationSpeed,
  computeAsteroidFieldBand,
  computeAsteroidProfile,
  computeAsteroidSlotPolar,
  computeConstellationAnchors,
  computeSpotlightHorizonY,
  computeStarSleepState,
  computeStellarProfile,
  getInnerBeltOrbitRadius,
  getMaxOuterPlanetOrbitRadius,
  getOuterPlanetOrbitRadius,
  getPlanetOrbitRadiusForRing,
  getPlanetRingAssignment,
  getSystemReach,
} from "../shared/types";

export type { AsteroidFieldBand, ConstellationRootTarget };

export {
  computeAsteroidFieldBand,
  computeAsteroidSlotPolar,
  computeConstellationAnchors,
  computeSpotlightHorizonY,
  getInnerBeltOrbitRadius,
  getMaxOuterPlanetOrbitRadius,
  getOuterPlanetOrbitRadius,
  getPlanetOrbitRadiusForRing,
  getPlanetRingAssignment,
  getSystemReach,
};

export interface SpiralReentryState {
  progress: number;
  duration: number;
  startDist: number;
  startAngle: number;
  startRadius: number;
  spinDir: number;
  trail: Array<{ x: number; y: number }>;
  impactTriggered: boolean;
}

export interface SolarAccretionFlare {
  parentId: string;
  age: number;
  maxAge: number;
  impactAngle: number;
  color: string;
  ringColor: string;
}

export function matchesSearchQuery(entry: ActivityLogEntry, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const fields = [
    entry.summary,
    entry.detail,
    entry.filePath,
    entry.title,
    entry.agentLabel,
    entry.badge,
    entry.rawCommand,
    entry.toolInput,
    entry.output,
    entry.fullText,
    entry.modelBadge,
  ];
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    let matched = false;
    for (let f = 0; f < fields.length; f++) {
      const val = fields[f];
      if (val && val.toLowerCase().includes(tok)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

export interface SimParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  label: string;
  color: string;
  alpha: number;
  life: number;
  maxLife: number;
}

export interface TetherPacket {
  fromId: string;
  toId: string;
  t: number;
  speed: number;
  color: string;
}

export interface GravitationalInfallState {
  progress: number;
  duration: number;
  startRadiusOffset: number;
  startAngleOffset: number;
}

const PLANET_RING_SPEEDS = [0.016, -0.011, 0.008, -0.006, 0.0045];

function getPlanetRingAngularSpeed(ringIndex: number): number {
  return (
    PLANET_RING_SPEEDS[ringIndex] ??
    (ringIndex % 2 === 0 ? 0.0038 : -0.0038)
  );
}

export interface PhysicsNode {
  id: string;
  data: AgentNodeSnapshot;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  targetRadius: number;
  /** Jelly squash/stretch scale offset */
  boing: number;
  boingVel: number;
  /** Orbit angle index among siblings */
  slotIndex: number;
  siblingCount: number;
  orbitPhase: number;
  blinkTimer: number;
  isHovered: boolean;
  isDragged: boolean;
  activeSubsCount?: number;
  totalCompletedSubs?: number;
  hiddenCompletedSubs?: number;
  totalSubsCount?: number;
  stellarProfile?: StellarProfile;
  asteroidProfile?: AsteroidProfile;
  asteroidSeed: number;
  spinAngle: number;
  spinSpeed: number;
  calloutRect?: { x: number; y: number; w: number; h: number };
  isCalloutHovered?: boolean;
  reentry?: SpiralReentryState;
  infall?: GravitationalInfallState;
  spawnAlpha?: number;
  orbitRadius?: number;
  orbitAngle?: number;
  captionHalfW?: number;
}

export interface RepoClusterZone {
  project: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  count: number;
}

export const TOOL_COLORS: Record<ToolCategory, string> = {
  read: "#5cc8ff",
  edit: "#fbbf24",
  bash: "#34d399",
  web: "#f472b6",
  agent: "#c084fc",
  other: "#94a3b8",
};

export const HARNESS_COLORS: Record<
  HarnessKind,
  { core: string; ring: string; glow: string; dim: string }
> = {
  claude: {
    core: "#f2845c",
    ring: "#ffb499",
    glow: "rgba(242, 132, 92, 0.30)",
    dim: "rgba(242, 132, 92, 0.45)",
  },
  codex: {
    core: "#3dd6a3",
    ring: "#86efac",
    glow: "rgba(61, 214, 163, 0.30)",
    dim: "rgba(61, 214, 163, 0.45)",
  },
  antigravity: {
    core: "#9580ff",
    ring: "#c4b5fd",
    glow: "rgba(149, 128, 255, 0.32)",
    dim: "rgba(149, 128, 255, 0.45)",
  },
  strata: {
    core: "#38bdf8",
    ring: "#bae6fd",
    glow: "rgba(56, 189, 248, 0.30)",
    dim: "rgba(56, 189, 248, 0.45)",
  },
};

export class SpringGraphEngine {
  public nodes = new Map<string, PhysicsNode>();
  public particles: SimParticle[] = [];
  public packets: TetherPacket[] = [];
  public solarFlares: SolarAccretionFlare[] = [];
  public clusters: RepoClusterZone[] = [];
  public spotlightHorizonY: number | null = null;

  public hasActiveAnimations(): boolean {
    if (
      this.particles.length > 0 ||
      this.packets.length > 0 ||
      this.solarFlares.length > 0
    ) {
      return true;
    }
    for (const n of this.nodes.values()) {
      if (n.reentry || n.infall) return true;
    }
    return false;
  }

  private width = 360;
  private height = 520;
  private isHorizontalLayout = false;
  private globalTime = 0;
  private animationSpeed = 1;
  private cachedAnchorKey = "";
  private cachedRootAnchors = new Map<string, { x: number; y: number }>();
  private isRootArr: boolean[] = [];
  private haloArr: number[] = [];
  private nodeBeltOrdinal = new Map<string, number>();
  private parentNextBeltOrdinal = new Map<string, number>();

  public setViewport(width: number, height: number, isHorizontal: boolean): void {
    this.width = Math.max(200, width);
    this.height = Math.max(200, height);
    this.isHorizontalLayout = isHorizontal;
  }

  public syncSnapshot(snapshots: AgentNodeSnapshot[]): void {
    // Uncapped subagents: keep 100% of roots, active planets, and completed outer-field asteroids
    const roots = snapshots
      .filter(s => !s.isSubagent)
      .sort((a, b) => {
        const pCmp =
          a.project < b.project ? -1 : a.project > b.project ? 1 : 0;
        if (pCmp !== 0) return pCmp;
        return a.createdAt - b.createdAt;
      });
    const activeSubs = snapshots.filter(s => s.isSubagent && s.status !== "completed");
    const completedSubs = snapshots.filter(s => s.isSubagent && s.status === "completed");

    // Group active subs by parent (sorted ascending by createdAt for stable planetary ring slots)
    const activeByParent = new Map<string, number>();
    const activeListByParent = new Map<string, AgentNodeSnapshot[]>();
    for (const sub of activeSubs) {
      if (!sub.parentId) continue;
      activeByParent.set(sub.parentId, (activeByParent.get(sub.parentId) ?? 0) + 1);
      let list = activeListByParent.get(sub.parentId);
      if (!list) {
        list = [];
        activeListByParent.set(sub.parentId, list);
      }
      list.push(sub);
    }

    const activeSlotMap = new Map<string, { slotIndex: number; total: number }>();
    for (const [, list] of activeListByParent.entries()) {
      list.sort((a, b) => a.createdAt - b.createdAt);
      for (let i = 0; i < list.length; i++) {
        activeSlotMap.set(list[i].id, { slotIndex: i, total: list.length });
      }
    }

    // Group completed subs by parent (sorted ascending by createdAt for stable Asteroid Field slots)
    const completedByParent = new Map<string, AgentNodeSnapshot[]>();
    for (const sub of completedSubs) {
      if (!sub.parentId) continue;
      let list = completedByParent.get(sub.parentId);
      if (!list) {
        list = [];
        completedByParent.set(sub.parentId, list);
      }
      list.push(sub);
    }

    const parentStats = new Map<string, { total: number; hidden: number }>();
    const completedSlotMap = new Map<string, { slotIndex: number; total: number }>();

    for (const [parentId, list] of completedByParent.entries()) {
      // Sort newly discovered completed subagents chronologically once, then lock their beltOrdinal permanently
      // so out-of-order historical file scans never shift existing asteroids by 137.5° Golden-Angle jumps!
      const unseen = list.filter(s => !this.nodeBeltOrdinal.has(s.id));
      if (unseen.length > 0) {
        unseen.sort((a, b) => a.createdAt - b.createdAt);
        let nextOrd = this.parentNextBeltOrdinal.get(parentId) ?? 0;
        for (const u of unseen) {
          this.nodeBeltOrdinal.set(u.id, nextOrd++);
        }
        this.parentNextBeltOrdinal.set(parentId, nextOrd);
      }
      const total = list.length;
      parentStats.set(parentId, { total, hidden: 0 });
      for (let i = 0; i < total; i++) {
        const ord = this.nodeBeltOrdinal.get(list[i].id) ?? i;
        completedSlotMap.set(list[i].id, { slotIndex: ord, total });
      }
    }

    const filteredSnapshots = [...roots, ...activeSubs, ...completedSubs];
    const nextIds = new Set(filteredSnapshots.map(s => s.id));

    // Precompute constellation anchors for roots
    const rootTargets: ConstellationRootTarget[] = roots.map(r => {
      const activeCount = activeByParent.get(r.id) ?? 0;
      const totalCompleted = parentStats.get(r.id)?.total ?? 0;
      const prof = computeStellarProfile(activeCount + totalCompleted, r.totalToolCalls);
      return {
        id: r.id,
        targetRadius: prof.baseRadius,
        activeSubsCount: activeCount,
        totalCompletedSubs: totalCompleted,
        status: r.status,
        isWaiting: r.status === "waiting_on_user",
      };
    });
    const constellationAnchors = this.computeConstellationAnchors(rootTargets);

    // Remove departed nodes
    for (const id of this.nodes.keys()) {
      if (!nextIds.has(id)) {
        this.nodes.delete(id);
      }
    }

    // Upsert nodes
    for (const snap of filteredSnapshots) {
      const activeCount = !snap.isSubagent ? (activeByParent.get(snap.id) ?? 0) : 0;
      const totalCompletedCount = !snap.isSubagent ? (parentStats.get(snap.id)?.total ?? 0) : 0;
      const hiddenCompletedCount = 0;
      const totalSubs = activeCount + totalCompletedCount;
      const stellarProfile = !snap.isSubagent
        ? computeStellarProfile(totalSubs, snap.totalToolCalls)
        : undefined;
      const asteroidProfile = snap.isSubagent
        ? computeAsteroidProfile(snap.turnCount, snap.totalToolCalls)
        : undefined;
      const sleep = !snap.isSubagent
        ? computeStarSleepState(snap, Date.now())
        : undefined;

      let targetR: number;
      if (snap.isSubagent) {
        targetR =
          snap.status === "completed"
            ? asteroidProfile!.baseRadius
            : snap.status === "tool_running"
              ? 16
              : 14.5;
      } else if (sleep && sleep.isAsleep) {
        targetR = stellarProfile!.baseRadius * (1 - 0.12 * sleep.sleepDepth);
      } else if (sleep && sleep.isResting) {
        targetR = stellarProfile!.baseRadius * 0.94;
      } else {
        targetR = stellarProfile!.baseRadius;
      }

      const existing = this.nodes.get(snap.id);

      if (existing) {
        const wasWaiting = existing.data.status === "waiting_on_user";
        const wasCompleted = existing.data.status === "completed";
        existing.data = snap;
        existing.targetRadius = targetR;
        if (snap.isSubagent) {
          existing.asteroidProfile = asteroidProfile;
          if (snap.status === "completed") {
            const baseSpin =
              (existing.asteroidSeed % 2 === 0 ? 1 : -1) *
              (0.032 + (existing.asteroidSeed % 36) * 0.0016);
            existing.spinSpeed = baseSpin * (7.8 / Math.max(4.8, targetR));
          }
        } else {
          existing.activeSubsCount = activeCount;
          existing.totalCompletedSubs = totalCompletedCount;
          existing.hiddenCompletedSubs = hiddenCompletedCount;
          existing.totalSubsCount = totalSubs;
          existing.stellarProfile = stellarProfile;
        }
        if (!wasCompleted && snap.status === "completed") {
          existing.boingVel += 0.28;
          existing.infall = undefined;
          existing.spawnAlpha = 1;
          if (snap.isSubagent && snap.parentId) {
            const parent = this.nodes.get(snap.parentId);
            if (parent) {
              const dx = existing.x - parent.x;
              const dy = existing.y - parent.y;
              const startDist = Math.max(parent.radius + 24, Math.hypot(dx, dy));
              const startAngle = Math.atan2(dy, dx);
              const pal = HARNESS_COLORS[snap.harness];

              // 1. Immediate Solar Accretion Flash + slow inward energy return packet to parent Star
              parent.boingVel += 0.48;
              if (this.solarFlares.length < 16) {
                this.solarFlares.push({
                  parentId: parent.id,
                  age: 0,
                  maxAge: 2.8,
                  impactAngle: startAngle,
                  color: pal.core,
                  ringColor: pal.ring,
                });
              }
              this.packets.push({
                fromId: existing.id,
                toId: parent.id,
                t: 0,
                speed: 0.32,
                color: pal.ring,
              });

              // 2. Graceful multi-second arc outward into the higher Kuiper Asteroid Field
              existing.reentry = {
                progress: 0,
                duration: 4.0,
                startDist,
                startAngle,
                startRadius: Math.max(12, existing.radius),
                spinDir: existing.spinSpeed >= 0 ? 1 : -1,
                trail: [{ x: existing.x, y: existing.y }],
                impactTriggered: true,
              };
            }
          }
        } else if (snap.status !== "completed") {
          existing.reentry = undefined;
        }
        if (!wasWaiting && snap.status === "waiting_on_user" && !snap.isSubagent) {
          existing.boingVel += 0.38;
        }
      } else {
        const seed = hashString(snap.id);
        const spinAngle = (seed % 628) / 100;
        const rawSpinSpeed =
          (seed % 2 === 0 ? 1 : -1) * (0.032 + (seed % 36) * 0.0016);
        const spinSpeed =
          snap.isSubagent && snap.status === "completed"
            ? rawSpinSpeed * (7.8 / Math.max(4.8, targetR))
            : rawSpinSpeed;

        let sx = this.width * 0.5 + (Math.random() - 0.5) * 60;
        let sy = this.height * 0.5 + (Math.random() - 0.5) * 60;
        const vx = 0;
        const vy = 0;
        let initRadius = !snap.isSubagent ? targetR * 0.94 : targetR * 0.74;
        let initOrbitRadius: number | undefined;
        let initOrbitAngle: number | undefined;
        let initInfall: GravitationalInfallState | undefined;
        let initSpawnAlpha = 1;

        if (snap.parentId && this.nodes.has(snap.parentId)) {
          const p = this.nodes.get(snap.parentId)!;
          const pRadius = Math.max(p.radius, p.targetRadius);
          const infallDuration = 4.4 + ((seed % 29) / 29) * 2.1;
          const startRadiusOffset = 115 + (seed % 80);
          const startArcPx = 90 + (seed % 55);

          if (snap.isSubagent && snap.status === "completed") {
            // Newly arriving asteroids materialize high in deep space and fall gracefully over ~4.4-6.5s into the Kuiper Belt
            const slotInfo = completedSlotMap.get(snap.id) ?? {
              slotIndex: this.nodeBeltOrdinal.get(snap.id) ?? 0,
              total: Math.max(1, p.totalCompletedSubs ?? 1),
            };
            const band = computeAsteroidFieldBand(
              pRadius,
              p.activeSubsCount ?? 0,
              slotInfo.total
            );
            const polar = computeAsteroidSlotPolar(
              slotInfo.slotIndex,
              slotInfo.total,
              band,
              seed,
              this.globalTime
            );
            initOrbitRadius = polar.radius;
            initOrbitAngle = polar.angle;
            const startAngleOffset = -(startArcPx / Math.max(140, initOrbitRadius));
            const spawnR = initOrbitRadius + startRadiusOffset;
            const spawnAng = initOrbitAngle + startAngleOffset;
            sx = p.x + Math.cos(spawnAng) * spawnR;
            sy = p.y + Math.sin(spawnAng) * spawnR;
            initRadius = targetR * 0.78;
            initInfall = {
              progress: 0,
              duration: infallDuration,
              startRadiusOffset,
              startAngleOffset,
            };
            initSpawnAlpha = 0.14;
          } else {
            // Active subagent planets materialize high above the star system and fall gracefully over ~4.4-6.5s into planetary orbit
            const slotInfo = activeSlotMap.get(snap.id) ?? {
              slotIndex: 0,
              total: Math.max(1, p.activeSubsCount ?? 1),
            };
            const assign = getPlanetRingAssignment(slotInfo.slotIndex, slotInfo.total);
            const targetOrbitR = getPlanetOrbitRadiusForRing(
              pRadius,
              assign.ringIndex,
              assign.countInRing
            );
            const ringSpeed = getPlanetRingAngularSpeed(assign.ringIndex);
            const ringPhaseOffset = assign.ringIndex * 1.1 + 0.65;
            const targetAngle =
              (assign.indexInRing / Math.max(1, assign.countInRing)) * Math.PI * 2 +
              this.globalTime * ringSpeed +
              ringPhaseOffset;
            const orbitDir = ringSpeed >= 0 ? 1 : -1;

            initOrbitRadius = targetOrbitR;
            initOrbitAngle = targetAngle;
            const startAngleOffset =
              -orbitDir * (startArcPx / Math.max(140, initOrbitRadius));
            const spawnR = initOrbitRadius + startRadiusOffset;
            const spawnAng = initOrbitAngle + startAngleOffset;
            sx = p.x + Math.cos(spawnAng) * spawnR;
            sy = p.y + Math.sin(spawnAng) * spawnR;
            initRadius = targetR * 0.72;
            initInfall = {
              progress: 0,
              duration: infallDuration,
              startRadiusOffset,
              startAngleOffset,
            };
            initSpawnAlpha = 0.14;
          }
        } else {
          const anchor = constellationAnchors.get(snap.id) ?? {
            x: this.width * 0.5,
            y: this.height * 0.5,
          };
          sx = anchor.x + (Math.random() - 0.5) * 8;
          sy = anchor.y + (Math.random() - 0.5) * 8;
        }

        const slotInfo = snap.isSubagent
          ? snap.status === "completed"
            ? completedSlotMap.get(snap.id)
            : activeSlotMap.get(snap.id)
          : undefined;

        this.nodes.set(snap.id, {
          id: snap.id,
          data: snap,
          x: sx,
          y: sy,
          vx,
          vy,
          radius: initRadius,
          targetRadius: targetR,
          boing: snap.isSubagent ? 0 : 0.1,
          boingVel:
            snap.status === "waiting_on_user" && !snap.isSubagent
              ? 0.32
              : snap.isSubagent
                ? 0
                : 0.08,
          slotIndex: slotInfo?.slotIndex ?? 0,
          siblingCount: slotInfo?.total ?? 1,
          orbitPhase: Math.random() * Math.PI * 2,
          blinkTimer: 3 + Math.random() * 6,
          isHovered: false,
          isDragged: false,
          activeSubsCount: !snap.isSubagent ? activeCount : undefined,
          totalCompletedSubs: !snap.isSubagent ? totalCompletedCount : undefined,
          hiddenCompletedSubs: !snap.isSubagent ? hiddenCompletedCount : undefined,
          totalSubsCount: !snap.isSubagent ? totalSubs : undefined,
          stellarProfile,
          asteroidProfile,
          asteroidSeed: seed,
          spinAngle,
          spinSpeed,
          calloutRect: undefined,
          isCalloutHovered: false,
          infall: initInfall,
          spawnAlpha: initSpawnAlpha,
          orbitRadius: initOrbitRadius,
          orbitAngle: initOrbitAngle,
        });
      }
    }

    // Attach stats to root parent nodes
    for (const [parentId, stats] of parentStats.entries()) {
      const parentNode = this.nodes.get(parentId);
      if (parentNode) {
        parentNode.totalCompletedSubs = stats.total;
        parentNode.hiddenCompletedSubs = 0;
        parentNode.totalSubsCount = (parentNode.activeSubsCount ?? 0) + stats.total;
        parentNode.stellarProfile = computeStellarProfile(
          parentNode.totalSubsCount,
          parentNode.data.totalToolCalls
        );
      }
    }

    // Assign stable sibling slot indices per parent (inner active planetary rings vs outer completed asteroid field)
    const byParentRing = new Map<string, PhysicsNode[]>();
    for (const n of this.nodes.values()) {
      if (!n.data.parentId) continue;
      const isCompleted = n.data.status === "completed";
      const key = `${n.data.parentId}:${isCompleted ? "outer" : "inner"}`;
      let arr = byParentRing.get(key);
      if (!arr) {
        arr = [];
        byParentRing.set(key, arr);
      }
      arr.push(n);
    }
    for (const [key, group] of byParentRing.entries()) {
      const isOuter = key.endsWith(":outer");
      if (isOuter) {
        const parentId = key.slice(0, key.length - ":outer".length);
        for (let i = 0; i < group.length; i++) {
          let ord = this.nodeBeltOrdinal.get(group[i].id);
          if (ord === undefined) {
            ord = this.parentNextBeltOrdinal.get(parentId) ?? 0;
            this.nodeBeltOrdinal.set(group[i].id, ord);
            this.parentNextBeltOrdinal.set(parentId, ord + 1);
          }
          group[i].slotIndex = ord;
          group[i].siblingCount = group.length;
        }
      } else {
        group.sort((a, b) => a.data.createdAt - b.data.createdAt);
        for (let i = 0; i < group.length; i++) {
          group[i].slotIndex = i;
          group[i].siblingCount = group.length;
        }
      }
    }
  }

  public handlePulse(pulse: LivePulseEvent): void {
    const node = this.nodes.get(pulse.nodeId);
    if (!node) return;

    // Gentle jelly cushion swell
    node.boingVel +=
      pulse.kind === "waiting" ? 0.34 : pulse.kind === "subagent_spawn" ? 0.28 : 0.16;
    if (!node.data.isSubagent) {
      node.vx += (Math.random() - 0.5) * 0.28;
      node.vy += (Math.random() - 0.5) * 0.28;
    }

    const color = pulse.isError
      ? "#f87171"
      : pulse.kind === "skill"
        ? "#e9d5ff"
        : pulse.category
          ? TOOL_COLORS[pulse.category]
          : HARNESS_COLORS[pulse.harness].ring;

    // Emit slow-drifting micro-bubble (capped to 12 max so screen stays clean; velocities in px/sec)
    if (this.particles.length < 12) {
      const shortLabel =
        pulse.kind === "skill"
          ? `★ ${pulse.label}`
          : pulse.label.split(":")[0].slice(0, 12);
      this.particles.push({
        x: node.x + (Math.random() - 0.5) * 8,
        y: node.y - node.radius - 4,
        vx: (Math.random() - 0.5) * 4.5,
        vy: -10.5 - Math.random() * 4.5,
        label: shortLabel,
        color,
        alpha: 1,
        life: 0,
        maxLife: 3.4,
      });
    }

    // Glide a slow comet packet along parent <-> subagent tether (~3.6s transit)
    if (node.data.parentId && this.nodes.has(node.data.parentId)) {
      const reverse = pulse.kind === "subagent_complete";
      this.packets.push({
        fromId: reverse ? node.id : node.data.parentId,
        toId: reverse ? node.data.parentId : node.id,
        t: 0,
        speed: 0.28,
        color,
      });
    }
  }

  public pokeNode(nodeId: string): void {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    n.boingVel += 0.32;
  }

  public setAnimationSpeed(speed: number): void {
    this.animationSpeed = clampAnimationSpeed(speed);
  }

  public getAnimationSpeed(): number {
    return this.animationSpeed;
  }

  public step(dtSeconds: number): void {
    const rawDt = Math.min(0.05, Math.max(0.001, dtSeconds));
    const totalScaledDt = rawDt * this.animationSpeed;
    if (totalScaledDt <= 0) return;
    const subSteps = Math.max(1, Math.ceil(totalScaledDt / 0.035));
    const subDt = totalScaledDt / subSteps;
    for (let s = 0; s < subSteps; s++) {
      this.stepSub(subDt);
    }
  }

  private stepSub(dt: number): void {
    const dtScale = dt * 60;
    const springStep = dt * 18;
    const radiusEase = 1 - Math.exp(-1.35 * dt);
    this.globalTime += dt;
    const stepNow = Date.now();

    const all = [...this.nodes.values()];
    const roots = all.filter(n => !n.data.isSubagent || !this.nodes.has(n.data.parentId || ""));
    roots.sort((a, b) => {
      const pCmp =
        a.data.project < b.data.project ? -1 : a.data.project > b.data.project ? 1 : 0;
      if (pCmp !== 0) return pCmp;
      return a.data.createdAt - b.data.createdAt;
    });

    let anchorKey = `${this.width}|${this.height}|${this.isHorizontalLayout ? 1 : 0}`;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      anchorKey += `;${r.id}:${Math.round(r.targetRadius)}:${r.activeSubsCount ?? 0}:${r.totalCompletedSubs ?? 0}:${r.data.status === "waiting_on_user" ? 1 : 0}`;
    }

    if (anchorKey !== this.cachedAnchorKey) {
      this.cachedAnchorKey = anchorKey;
      const rootDescriptors: ConstellationRootTarget[] = roots.map(r => ({
        id: r.id,
        targetRadius: r.targetRadius,
        radius: r.radius,
        activeSubsCount: r.activeSubsCount,
        totalCompletedSubs: r.totalCompletedSubs,
        totalSubsCount: r.totalSubsCount,
        status: r.data.status,
        isWaiting: r.data.status === "waiting_on_user",
      }));

      this.cachedRootAnchors = this.computeConstellationAnchors(rootDescriptors);

      const waitingAnchors: Array<{ y: number; reach?: number }> = [];
      const regularAnchors: Array<{ y: number; reach?: number }> = [];
      for (const r of rootDescriptors) {
        const anchor = this.cachedRootAnchors.get(r.id);
        if (!anchor) continue;
        const reach = getSystemReach(r);
        if (r.isWaiting) {
          waitingAnchors.push({ y: anchor.y, reach });
        } else {
          regularAnchors.push({ y: anchor.y, reach });
        }
      }
      this.spotlightHorizonY = computeSpotlightHorizonY(waitingAnchors, regularAnchors);
    }

    const rootAnchors = this.cachedRootAnchors;

    // 1. Attractors, Graceful Gravitational Infall & Parent-Relative Planetary/Asteroid Orbits
    for (const n of all) {
      if (n.reentry) {
        const parent = n.data.parentId ? this.nodes.get(n.data.parentId) : undefined;
        if (!parent) {
          n.reentry = undefined;
        } else {
          n.boingVel =
            (n.boingVel - 0.16 * n.boing * springStep) * Math.pow(0.76, springStep);
          n.boing += n.boingVel * springStep * 0.45;
          n.blinkTimer -= dt;
          if (n.blinkTimer < -0.18) {
            n.blinkTimer = 3.2 + Math.random() * 6.0;
          }

          const siblingTotal = Math.max(1, n.siblingCount);
          const band = computeAsteroidFieldBand(
            Math.max(parent.radius, parent.targetRadius),
            parent.activeSubsCount ?? 0,
            siblingTotal
          );
          const polar = computeAsteroidSlotPolar(
            n.slotIndex,
            siblingTotal,
            band,
            n.asteroidSeed,
            this.globalTime
          );

          n.reentry.progress += dt / n.reentry.duration;
          if (n.reentry.progress < 1) {
            const p = n.reentry.progress;
            // Smooth cubic ease-out into the higher Kuiper Asteroid Field
            const oneMinus = 1 - p;
            const ease = 1 - oneMinus * oneMinus * oneMinus;
            const curDist =
              n.reentry.startDist + (polar.radius - n.reentry.startDist) * ease;

            let dAng = (polar.angle - n.reentry.startAngle) % (Math.PI * 2);
            if (dAng > Math.PI) dAng -= Math.PI * 2;
            if (dAng < -Math.PI) dAng += Math.PI * 2;
            if (
              Math.sign(dAng) !== n.reentry.spinDir &&
              Math.abs(dAng) < Math.PI * 0.65
            ) {
              dAng += n.reentry.spinDir * Math.PI * 2;
            }
            const curAngle = n.reentry.startAngle + dAng * ease;

            n.x = parent.x + Math.cos(curAngle) * curDist;
            n.y = parent.y + Math.sin(curAngle) * curDist;
            n.vx = 0;
            n.vy = 0;
            n.radius = n.reentry.startRadius + (n.targetRadius - n.reentry.startRadius) * ease;
            n.spinAngle += n.reentry.spinDir * dt * (1.1 - 0.7 * p);
            n.reentry.trail.push({ x: n.x, y: n.y });
            if (n.reentry.trail.length > 24) {
              n.reentry.trail.shift();
            }
            continue;
          } else {
            if (!n.reentry.impactTriggered) {
              n.reentry.impactTriggered = true;
              parent.boingVel += 0.48;
              const pal = HARNESS_COLORS[n.data.harness];
              const impactAngle = Math.atan2(n.y - parent.y, n.x - parent.x);
              if (this.solarFlares.length < 16) {
                this.solarFlares.push({
                  parentId: parent.id,
                  age: 0,
                  maxAge: 2.8,
                  impactAngle,
                  color: pal.core,
                  ringColor: pal.ring,
                });
              }
            }
            n.orbitRadius = polar.radius;
            n.orbitAngle = polar.angle;
            n.x = parent.x + Math.cos(polar.angle) * polar.radius;
            n.y = parent.y + Math.sin(polar.angle) * polar.radius;
            n.vx = 0;
            n.vy = 0;
            n.radius = n.targetRadius;
            n.reentry = undefined;
            continue;
          }
        }
      }

      if (!n.data.isSubagent && n.data.status === "idle") {
        const sleep = computeStarSleepState(n.data, stepNow);
        const profile =
          n.stellarProfile ??
          computeStellarProfile(n.totalSubsCount ?? 0, n.data.totalToolCalls);
        if (sleep.isAsleep) {
          n.targetRadius = profile.baseRadius * (1 - 0.12 * sleep.sleepDepth);
        } else if (sleep.isResting) {
          n.targetRadius = profile.baseRadius * 0.94;
        } else {
          n.targetRadius = profile.baseRadius;
        }
      }

      // dt-independent radius growth & gentle jelly spring
      n.radius += (n.targetRadius - n.radius) * radiusEase;
      n.spinAngle += n.spinSpeed * dt;
      n.boingVel =
        (n.boingVel - 0.16 * n.boing * springStep) * Math.pow(0.76, springStep);
      n.boing += n.boingVel * springStep * 0.45;

      // Calm slow breathing wobble when thinking / running tools
      if (n.data.status === "thinking" || n.data.status === "tool_running") {
        n.boing += Math.sin(this.globalTime * 0.95 + n.orbitPhase) * 0.0012 * springStep;
      }

      // Eye blink timer
      n.blinkTimer -= dt;
      if (n.blinkTimer < -0.18) {
        n.blinkTimer = 3.2 + Math.random() * 6.0;
      }

      // Advance multi-second gravitational capture / infall from high deep space
      let infallRadiusOffset = 0;
      let infallAngleOffset = 0;
      if (n.infall) {
        if (n.isDragged) {
          n.infall = undefined;
          n.spawnAlpha = 1;
        } else {
          if (!n.isHovered) {
            n.infall.progress += dt / n.infall.duration;
          }
          if (n.infall.progress >= 1) {
            n.infall = undefined;
            n.spawnAlpha = 1;
          } else {
            const p = n.infall.progress;
            // Smooth cosine S-curve: begins gently from rest in deep space and kisses into orbit with zero velocity jump
            const easeRem = 0.5 * (1 + Math.cos(Math.PI * p));
            infallRadiusOffset = n.infall.startRadiusOffset * easeRem;
            infallAngleOffset = n.infall.startAngleOffset * easeRem;
            n.spawnAlpha = Math.min(1, 0.14 + 0.86 * Math.min(1, p / 0.36));
          }
        }
      } else {
        n.spawnAlpha = 1;
      }

      const parent = n.data.parentId ? this.nodes.get(n.data.parentId) : undefined;
      if (parent && n.data.isSubagent && n.data.status === "completed") {
        // Outer Kuiper Asteroid Field: smooth parent-relative orbital glide + graceful infall
        const band = computeAsteroidFieldBand(
          Math.max(parent.radius, parent.targetRadius),
          parent.activeSubsCount ?? 0,
          n.siblingCount
        );
        const polar = computeAsteroidSlotPolar(
          n.slotIndex,
          n.siblingCount,
          band,
          n.asteroidSeed,
          this.globalTime
        );

        if (n.isDragged || n.isHovered) {
          n.vx = 0;
          n.vy = 0;
          n.orbitRadius = Math.max(
            24,
            Math.hypot(n.x - parent.x, n.y - parent.y) - infallRadiusOffset
          );
          n.orbitAngle =
            Math.atan2(n.y - parent.y, n.x - parent.x) - infallAngleOffset;
          continue;
        }

        if (n.orbitRadius === undefined) {
          n.orbitRadius = polar.radius;
        }
        if (n.orbitAngle === undefined) {
          n.orbitAngle = polar.angle;
        }

        const radialEase = 1 - Math.exp(-0.85 * dt);
        const maxRadialStep = 34 * dt;
        const dr = (polar.radius - n.orbitRadius) * radialEase;
        n.orbitRadius += Math.max(-maxRadialStep, Math.min(maxRadialStep, dr));

        let dAng = (polar.angle - n.orbitAngle) % (Math.PI * 2);
        if (dAng > Math.PI) dAng -= Math.PI * 2;
        if (dAng < -Math.PI) dAng += Math.PI * 2;
        const angEase = 1 - Math.exp(-1.2 * dt);
        const maxAngStep = 0.32 * dt;
        n.orbitAngle += Math.max(-maxAngStep, Math.min(maxAngStep, dAng * angEase));

        const finalR = n.orbitRadius + infallRadiusOffset;
        const finalAng = n.orbitAngle + infallAngleOffset;
        n.x = parent.x + Math.cos(finalAng) * finalR;
        n.y = parent.y + Math.sin(finalAng) * finalR;
        n.vx = 0;
        n.vy = 0;
        continue;
      }

      if (parent && n.data.isSubagent) {
        // Active Planetary Rings: high, unhurried Keplerian orbits + graceful multi-second infall
        const assign = getPlanetRingAssignment(n.slotIndex, n.siblingCount);
        const targetOrbitR = getPlanetOrbitRadiusForRing(
          Math.max(parent.radius, parent.targetRadius),
          assign.ringIndex,
          assign.countInRing
        );
        const ringSpeed = getPlanetRingAngularSpeed(assign.ringIndex);
        const ringPhaseOffset = assign.ringIndex * 1.1 + 0.65;
        const targetAngle =
          (assign.indexInRing / Math.max(1, assign.countInRing)) * Math.PI * 2 +
          this.globalTime * ringSpeed +
          ringPhaseOffset;

        if (n.isDragged || n.isHovered) {
          n.vx = 0;
          n.vy = 0;
          n.orbitRadius = Math.max(
            24,
            Math.hypot(n.x - parent.x, n.y - parent.y) - infallRadiusOffset
          );
          n.orbitAngle =
            Math.atan2(n.y - parent.y, n.x - parent.x) - infallAngleOffset;
          continue;
        }

        if (n.orbitRadius === undefined) {
          n.orbitRadius = targetOrbitR;
        }
        if (n.orbitAngle === undefined) {
          n.orbitAngle = targetAngle;
        }

        const radialEase = 1 - Math.exp(-0.95 * dt);
        const maxRadialStep = 42 * dt;
        const dr = (targetOrbitR - n.orbitRadius) * radialEase;
        n.orbitRadius += Math.max(-maxRadialStep, Math.min(maxRadialStep, dr));

        let dAng = (targetAngle - n.orbitAngle) % (Math.PI * 2);
        if (dAng > Math.PI) dAng -= Math.PI * 2;
        if (dAng < -Math.PI) dAng += Math.PI * 2;
        const angEase = 1 - Math.exp(-1.15 * dt);
        const maxAngStep = 0.36 * dt;
        n.orbitAngle += Math.max(-maxAngStep, Math.min(maxAngStep, dAng * angEase));

        const finalR = n.orbitRadius + infallRadiusOffset;
        const finalAng = n.orbitAngle + infallAngleOffset;
        n.x = parent.x + Math.cos(finalAng) * finalR;
        n.y = parent.y + Math.sin(finalAng) * finalR;
        n.vx = 0;
        n.vy = 0;
        continue;
      }

      if (n.isDragged || n.isHovered) {
        n.vx *= Math.pow(0.35, dtScale);
        n.vy *= Math.pow(0.35, dtScale);
        continue;
      }

      // Root node: gentle, slow pull toward its dedicated constellation anchor (dt-independent)
      const anchor = rootAnchors.get(n.id) ?? {
        x: this.width * 0.5,
        y: this.height * 0.5,
      };
      const isWaiting = !n.data.isSubagent && n.data.status === "waiting_on_user";
      if (isWaiting) {
        const hopPhase = (this.globalTime * 0.45 + n.orbitPhase) % Math.PI;
        const hopY = -Math.sin(hopPhase) * 9;
        n.boing += Math.cos(hopPhase * 2) * 0.002 * springStep;
        n.vx += (anchor.x - n.x) * 0.0085 * dtScale;
        n.vy += (anchor.y + hopY - n.y) * 0.0085 * dtScale;
      } else {
        n.vx += (anchor.x - n.x) * 0.005 * dtScale;
        n.vy += (anchor.y - n.y) * 0.005 * dtScale;
      }
    }

    // 2. Pairwise Soft Repulsion between root star systems (and any orphan nodes)
    const nodeCount = all.length;
    const isRootArr = this.isRootArr;
    const haloArr = this.haloArr;
    isRootArr.length = nodeCount;
    haloArr.length = nodeCount;
    for (let i = 0; i < nodeCount; i++) {
      const n = all[i];
      const isRoot = !n.data.isSubagent || !this.nodes.has(n.data.parentId || "");
      isRootArr[i] = isRoot;
      haloArr[i] = isRoot
        ? getSystemReach({
            id: n.id,
            radius: n.radius,
            activeSubsCount: n.activeSubsCount,
            totalCompletedSubs: n.totalCompletedSubs,
          }) - 32
        : n.radius;
    }

    for (let i = 0; i < nodeCount; i++) {
      const a = all[i];
      if (!isRootArr[i]) continue;
      const aHalo = haloArr[i];

      for (let j = i + 1; j < nodeCount; j++) {
        const b = all[j];
        if (!isRootArr[j]) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const bHalo = haloArr[j];
        const minDist = aHalo + bHalo + 120;

        if (Math.abs(dx) >= minDist || Math.abs(dy) >= minDist) {
          continue;
        }

        const distSq = dx * dx + dy * dy + 0.01;
        if (distSq < minDist * minDist) {
          const dist = Math.sqrt(distSq);
          const push = ((minDist - dist) / minDist) * 0.35 * dtScale;
          const nx = dx / dist;
          const ny = dy / dist;
          if (!a.isDragged && !a.isHovered) {
            a.vx -= nx * push;
            a.vy -= ny * push;
          }
          if (!b.isDragged && !b.isHovered) {
            b.vx += nx * push;
            b.vy += ny * push;
          }
        }
      }
    }

    // 3. Integrate root velocities & soft safety world boundary (dt-independent)
    const cx = this.width * 0.5;
    const cy = this.height * 0.5;
    const safetyLimit = 5200;
    const minX = cx - safetyLimit;
    const maxX = cx + safetyLimit;
    const minY = cy - safetyLimit;
    const maxY = cy + safetyLimit;

    for (const n of all) {
      if (n.isDragged || n.reentry) continue;
      if (n.data.isSubagent && n.data.parentId && this.nodes.has(n.data.parentId)) {
        continue;
      }
      const damp = Math.pow(0.82, dtScale);
      n.vx *= damp;
      n.vy *= damp;
      const maxSpd = 3.2;
      const spd = Math.hypot(n.vx, n.vy);
      if (spd > maxSpd) {
        n.vx = (n.vx / spd) * maxSpd;
        n.vy = (n.vy / spd) * maxSpd;
      }
      if (!n.isHovered) {
        n.x += n.vx * dtScale;
        n.y += n.vy * dtScale;
      }

      if (n.x < minX + n.radius) {
        n.x = minX + n.radius;
        n.vx *= -0.5;
      } else if (n.x > maxX - n.radius) {
        n.x = maxX - n.radius;
        n.vx *= -0.5;
      }
      if (n.y < minY + n.radius) {
        n.y = minY + n.radius;
        n.vy *= -0.5;
      } else if (n.y > maxY - n.radius) {
        n.y = maxY - n.radius;
        n.vy *= -0.5;
      }
    }

    // 4. Step particles (px/sec) & tether packets
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.alpha = Math.max(0, 1 - p.life / p.maxLife);
      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
      }
    }

    for (let i = this.packets.length - 1; i >= 0; i--) {
      const pkt = this.packets[i];
      pkt.t += dt * pkt.speed;
      if (pkt.t >= 1) {
        this.packets.splice(i, 1);
      }
    }

    for (let i = this.solarFlares.length - 1; i >= 0; i--) {
      const flare = this.solarFlares[i];
      flare.age += dt;
      if (flare.age >= flare.maxAge) {
        this.solarFlares.splice(i, 1);
      }
    }
  }

  public getTime(): number {
    return this.globalTime;
  }

  public findNodeAt(wx: number, wy: number): PhysicsNode | null {
    // Check subagents & moons first, then roots (topmost hit)
    let best: PhysicsNode | null = null;
    let bestDist = Infinity;
    for (const n of this.nodes.values()) {
      const hitR = Math.max(11, n.radius + 5);
      const d = Math.hypot(wx - n.x, wy - n.y);
      let isHit = d <= hitR;
      if (!isHit) {
        if (!n.data.isSubagent) {
          const halfW = n.captionHalfW ?? 52;
          isHit =
            Math.abs(wx - n.x) <= halfW &&
            Math.abs(wy - (n.y + n.radius + 13)) <= 10;
        } else if (n.data.isSubagent && (n.isHovered || n.data.status === "tool_running")) {
          const halfW = n.captionHalfW ?? 48;
          isHit =
            Math.abs(wx - n.x) <= halfW &&
            Math.abs(wy - (n.y + n.radius + 11)) <= 9;
        }
      }
      if (isHit && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  public findWaitingCalloutAt(wx: number, wy: number): PhysicsNode | null {
    const pad = 4;
    for (const n of this.nodes.values()) {
      if (!n.data.isSubagent && n.data.status === "waiting_on_user" && n.calloutRect) {
        const r = n.calloutRect;
        if (
          wx >= r.x - pad &&
          wx <= r.x + r.w + pad &&
          wy >= r.y - pad &&
          wy <= r.y + r.h + pad
        ) {
          return n;
        }
      }
    }
    return null;
  }

  public getBoundingBox(): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
    cx: number;
    cy: number;
  } | null {
    if (this.nodes.size === 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes.values()) {
      const r = Math.max(n.radius, n.targetRadius) + 42;
      minX = Math.min(minX, n.x - r);
      maxX = Math.max(maxX, n.x + r);
      let topY = n.y - r;
      if (!n.data.isSubagent && n.data.status === "waiting_on_user") {
        topY = Math.min(topY, n.y - n.radius - 75);
      }
      minY = Math.min(minY, topY);
      maxY = Math.max(maxY, n.y + r + (n.data.isSubagent ? 14 : 28));
    }
    return {
      minX,
      maxX,
      minY,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      cx: (minX + maxX) * 0.5,
      cy: (minY + maxY) * 0.5,
    };
  }

  public computeConstellationAnchors(
    roots: ConstellationRootTarget[]
  ): Map<string, { x: number; y: number }> {
    return computeConstellationAnchors(
      roots,
      this.width,
      this.height,
      this.isHorizontalLayout
    );
  }
}

export function computeNodeRadius(snap: AgentNodeSnapshot, totalSubs = 0): number {
  if (snap.isSubagent) {
    if (snap.status === "completed") {
      return computeAsteroidProfile(snap.turnCount, snap.totalToolCalls).baseRadius;
    }
    return snap.status === "tool_running" ? 16 : 14.5;
  }
  const profile = computeStellarProfile(totalSubs, snap.totalToolCalls);
  const sleep = computeStarSleepState(snap, Date.now());
  if (sleep.isAsleep) {
    return profile.baseRadius * (1 - 0.12 * sleep.sleepDepth);
  }
  if (sleep.isResting) {
    return profile.baseRadius * 0.94;
  }
  return profile.baseRadius;
}

export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}
