import {
  HarnessKind,
  StarSleepState,
  StellarProfile,
  ToolCategory,
  computeAsteroidFieldBand,
  computeAsteroidProfile,
  computeStarSleepState,
  computeStellarProfile,
  getPlanetOrbitRadiusForRing,
  getPlanetRingAssignment,
} from "../shared/types";
import {
  HARNESS_COLORS,
  PhysicsNode,
  SpringGraphEngine,
  TOOL_COLORS,
} from "./physics";

export interface CameraTransform {
  panX: number;
  panY: number;
  zoom: number;
}

const STAR_COLORS = ["#ffffff", "#cbd5e1", "#93c5fd", "#fef08a", "#fed7aa"];
const STAR_ALPHA_TIERS = [0.28, 0.52, 0.78];

function hash2D(x: number, y: number, seed = 0): number {
  let n = (x * 374761393 + y * 668265263 + seed * 3266489917) >>> 0;
  n = (n ^ (n >>> 13)) * 1274126177 >>> 0;
  return (n ^ (n >>> 16)) >>> 0;
}

export class OrbitCanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  private filterHarness: HarnessKind | null = null;
  private selectedNodeId: string | null = null;
  private textWidthCache = new Map<string, number>();
  private starBuckets: number[][] = Array.from(
    { length: STAR_COLORS.length * STAR_ALPHA_TIERS.length },
    () => []
  );
  private activeSubsByParent = new Map<string, PhysicsNode[]>();
  private sleepById = new Map<string, StarSleepState>();
  private rootNodes: PhysicsNode[] = [];
  private sortedNodes: PhysicsNode[] = [];
  private frameNow = 0;
  private simTime = 0;
  private viewMinX = 0;
  private viewMaxX = 0;
  private viewMinY = 0;
  private viewMaxY = 0;
  private cullMinX = 0;
  private cullMaxX = 0;
  private cullMinY = 0;
  private cullMaxY = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas unavailable");
    this.ctx = context;
  }

  private measureTextCached(
    ctx: CanvasRenderingContext2D,
    font: string,
    text: string
  ): number {
    ctx.font = font;
    const key = `${font}|${text}`;
    const cached = this.textWidthCache.get(key);
    if (cached !== undefined) return cached;
    if (this.textWidthCache.size > 2000) {
      this.textWidthCache.clear();
    }
    const w = ctx.measureText(text).width;
    this.textWidthCache.set(key, w);
    return w;
  }

  public setSelectedNodeId(id: string | null): void {
    this.selectedNodeId = id;
  }

  public setFilterHarness(harness: HarnessKind | null): void {
    this.filterHarness = harness;
  }

  public resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.floor(width * dpr));
    const targetH = Math.max(1, Math.floor(height * dpr));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  public render(
    engine: SpringGraphEngine,
    width: number,
    height: number,
    cam: CameraTransform
  ): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);

    const time = engine.getTime();
    const frameNow = Date.now();
    this.frameNow = frameNow;
    this.simTime = time;

    const wx0 = (0 - width * 0.5 - cam.panX) / cam.zoom + width * 0.5;
    const wy0 = (0 - height * 0.5 - cam.panY) / cam.zoom + height * 0.5;
    const wx1 = (width - width * 0.5 - cam.panX) / cam.zoom + width * 0.5;
    const wy1 = (height - height * 0.5 - cam.panY) / cam.zoom + height * 0.5;
    this.viewMinX = wx0;
    this.viewMaxX = wx1;
    this.viewMinY = wy0;
    this.viewMaxY = wy1;
    const cullPad = 210;
    this.cullMinX = wx0 - cullPad;
    this.cullMaxX = wx1 + cullPad;
    this.cullMinY = wy0 - cullPad;
    this.cullMaxY = wy1 + cullPad;

    // Single O(N) pass to index roots, sleep states, active subagents by parent, and draw order
    this.activeSubsByParent.clear();
    this.sleepById.clear();
    this.rootNodes.length = 0;
    this.sortedNodes.length = 0;
    for (const node of engine.nodes.values()) {
      this.sortedNodes.push(node);
      if (!node.data.isSubagent) {
        this.rootNodes.push(node);
        this.sleepById.set(node.id, computeStarSleepState(node.data, frameNow));
      } else if (node.data.parentId && node.data.status !== "completed") {
        let subs = this.activeSubsByParent.get(node.data.parentId);
        if (!subs) {
          subs = [];
          this.activeSubsByParent.set(node.data.parentId, subs);
        }
        subs.push(node);
      }
    }

    ctx.save();
    ctx.translate(width * 0.5 + cam.panX, height * 0.5 + cam.panY);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-width * 0.5, -height * 0.5);

    // 0. Deterministic Deep-Space Starfield & Ambient Nebula Backdrops
    this.drawDeepSpaceBackdrop(ctx, wx0, wy0, wx1, wy1, cam, time);

    if (engine.nodes.size === 0) {
      ctx.restore();
      this.drawEmptyState(ctx, width, height);
      return;
    }

    // 0.5 Spotlight Stage Horizon (when both waiting and regular stars are on screen)
    if (engine.spotlightHorizonY !== null) {
      this.drawSpotlightHorizon(ctx, engine, width);
    }

    // 1. Asteroid Belt Dust Bands & Planetary Orbit Rings around parent stars
    this.drawOrbitRingsAndBands(ctx, time);

    // 2. Gravitational Energy Streams (Parent -> ACTIVE Subagents only)
    this.drawGravitationalStreams(ctx, engine, time);

    // 3. Comet-Tail Packets
    this.drawCometPackets(ctx, engine);

    // 4. Nodes (Sorted: Asteroids first, then active planets, then stars, then re-entry meteors; selected/hovered always topmost)
    const selId = this.selectedNodeId;
    this.sortedNodes.sort((a, b) => {
      const rankA =
        a.isHovered ? 4 : selId === a.id ? 3.8 : a.reentry ? 3.2 : !a.data.isSubagent ? 3 : a.data.status === "completed" ? 1 : 2;
      const rankB =
        b.isHovered ? 4 : selId === b.id ? 3.8 : b.reentry ? 3.2 : !b.data.isSubagent ? 3 : b.data.status === "completed" ? 1 : 2;
      return rankA - rankB;
    });

    for (let i = 0; i < this.sortedNodes.length; i++) {
      this.drawNode(ctx, this.sortedNodes[i], engine, time);
    }

    // 4.5. Solar Accretion Flares from completed subagent impacts
    if (engine.solarFlares.length > 0) {
      this.drawSolarAccretionFlares(ctx, engine);
    }

    // 5. Floating Tool / Skill Micro-Bubbles
    this.drawMicroBubbles(ctx, engine);

    ctx.restore();
  }

  /**
   * Deep-Space Starfield Backdrop with zoom-adaptive octaves & batched path fills.
   * Behind each non-idle root Star, a soft ambient nebula glow is painted.
   */
  private drawDeepSpaceBackdrop(
    ctx: CanvasRenderingContext2D,
    wx0: number,
    wy0: number,
    wx1: number,
    wy1: number,
    cam: CameraTransform,
    time: number
  ): void {
    // 1. Ambient Nebula Glow behind each root Star (dimmed softly in sleep)
    for (let i = 0; i < this.rootNodes.length; i++) {
      const node = this.rootNodes[i];
      const r = node.radius;
      const nebulaR = r * 3.4;
      if (
        node.x + nebulaR < wx0 ||
        node.x - nebulaR > wx1 ||
        node.y + nebulaR < wy0 ||
        node.y - nebulaR > wy1
      ) {
        continue;
      }
      const profile =
        node.stellarProfile ??
        computeStellarProfile(node.totalSubsCount ?? 0, node.data.totalToolCalls);
      const sleep =
        this.sleepById.get(node.id) ?? computeStarSleepState(node.data, this.frameNow);

      const nebulaAlpha = sleep.isAsleep
        ? Math.max(0.08, 1 - 0.72 * sleep.sleepDepth)
        : 1.0;

      const grad = ctx.createRadialGradient(node.x, node.y, r * 0.2, node.x, node.y, nebulaR);
      grad.addColorStop(0, profile.nebulaGlow);
      grad.addColorStop(0.45, "rgba(148, 163, 184, 0.04)");
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");

      ctx.save();
      ctx.globalAlpha = nebulaAlpha;
      ctx.beginPath();
      ctx.arc(node.x, node.y, nebulaR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }

    // 2. Zoom-Adaptive Deep-Space Starfield (<= 34x20 cells, batched into <= 15 fill() calls/frame)
    const spanX = Math.max(1, wx1 - wx0);
    const spanY = Math.max(1, wy1 - wy0);
    let cellSize = 96;
    while (spanX / cellSize > 34 || spanY / cellSize > 20) {
      cellSize *= 2;
    }

    const zoomScale = cam.zoom < 1 ? 1 / Math.max(0.22, Math.sqrt(cam.zoom)) : 1;
    const pad = cellSize * 0.035;
    const innerSpan = cellSize - pad * 2;
    const startCol = Math.floor(wx0 / cellSize);
    const endCol = Math.ceil(wx1 / cellSize);
    const startRow = Math.floor(wy0 / cellSize);
    const endRow = Math.ceil(wy1 / cellSize);

    const buckets = this.starBuckets;
    for (let i = 0; i < buckets.length; i++) {
      buckets[i].length = 0;
    }

    for (let c = startCol; c <= endCol; c++) {
      for (let r = startRow; r <= endRow; r++) {
        const h0 = hash2D(c, r, 73);
        const starCount = 1 + (h0 & 1);

        for (let s = 0; s < starCount; s++) {
          const hs = hash2D(c, r, 127 + s * 149);
          const ox = pad + ((hs & 0x3ff) * 0.0009765625) * innerSpan;
          const oy = pad + (((hs >>> 10) & 0x3ff) * 0.0009765625) * innerSpan;
          const sx = c * cellSize + ox;
          const sy = r * cellSize + oy;

          const baseRadius = 0.55 + (((hs >>> 20) & 0x7f) * 0.00748);
          const rStar = baseRadius * zoomScale;
          const colorIdx = (hs >>> 27) % STAR_COLORS.length;

          const ht = (h0 ^ (hs * 2654435761)) >>> 0;
          const twinkleSpeed = 0.22 + (ht & 0x7f) * 0.0032;
          const phase = ((ht >>> 8) & 0x3ff) * 0.00614;
          const osc = 0.5 + 0.5 * Math.sin(time * twinkleSpeed + phase);
          const tier = osc < 0.34 ? 0 : osc < 0.68 ? 1 : 2;

          const bucket = buckets[colorIdx * 3 + tier];
          bucket.push(sx, sy, rStar);
        }
      }
    }

    ctx.save();
    for (let colorIdx = 0; colorIdx < STAR_COLORS.length; colorIdx++) {
      ctx.fillStyle = STAR_COLORS[colorIdx];
      for (let tier = 0; tier < STAR_ALPHA_TIERS.length; tier++) {
        const b = buckets[colorIdx * 3 + tier];
        if (b.length === 0) continue;
        ctx.globalAlpha = STAR_ALPHA_TIERS[tier];
        ctx.beginPath();
        for (let k = 0; k < b.length; k += 3) {
          const sx = b[k];
          const sy = b[k + 1];
          const sr = b[k + 2];
          ctx.moveTo(sx + sr, sy);
          ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * Inner Planetary Orbit track guides for active subagents +
   * Outer Kuiper Asteroid Field toroidal dust band around parents with completed subagents.
   */
  private drawOrbitRingsAndBands(
    ctx: CanvasRenderingContext2D,
    time: number
  ): void {
    for (let idx = 0; idx < this.rootNodes.length; idx++) {
      const p = this.rootNodes[idx];

      // 1. Inner Active Planetary Orbit track guides (pre-indexed O(1) lookup)
      const activeSubs = this.activeSubsByParent.get(p.id);
      if (activeSubs && activeSubs.length > 0) {
        const rings = new Map<number, number>();
        for (let i = 0; i < activeSubs.length; i++) {
          const sub = activeSubs[i];
          const assign = getPlanetRingAssignment(sub.slotIndex, activeSubs.length);
          if (!rings.has(assign.ringIndex)) {
            rings.set(assign.ringIndex, assign.countInRing);
          }
        }

        ctx.save();
        ctx.strokeStyle = "rgba(148, 163, 184, 0.09)";
        ctx.lineWidth = 1.0;
        ctx.setLineDash([3, 5]);
        for (const [ringIndex, countInRing] of rings.entries()) {
          const ringRadius = getPlanetOrbitRadiusForRing(
            Math.max(p.radius, p.targetRadius),
            ringIndex,
            countInRing
          );
          if (
            p.x + ringRadius < this.viewMinX ||
            p.x - ringRadius > this.viewMaxX ||
            p.y + ringRadius < this.viewMinY ||
            p.y - ringRadius > this.viewMaxY
          ) {
            continue;
          }
          ctx.beginPath();
          ctx.arc(p.x, p.y, ringRadius, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 2. Outer Kuiper Asteroid Field around parents with completed subagents
      const completedCount = p.totalCompletedSubs ?? 0;
      if (completedCount > 0) {
        const band = computeAsteroidFieldBand(
          Math.max(p.radius, p.targetRadius),
          p.activeSubsCount ?? 0,
          completedCount
        );
        if (
          p.x + band.outerRadius + 24 >= this.viewMinX &&
          p.x - band.outerRadius - 24 <= this.viewMaxX &&
          p.y + band.outerRadius + 24 >= this.viewMinY &&
          p.y - band.outerRadius - 24 <= this.viewMaxY
        ) {
          ctx.save();

          // Soft wide toroidal dust wash centered at band.midRadius
          ctx.beginPath();
          ctx.arc(p.x, p.y, band.midRadius, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(148, 163, 184, 0.042)";
          ctx.lineWidth = band.bandWidth + 10;
          ctx.stroke();

          // Subtle dashed inner & outer belt boundary arcs
          ctx.strokeStyle = "rgba(148, 163, 184, 0.10)";
          ctx.lineWidth = 0.8;
          ctx.setLineDash([2, 6]);
          ctx.beginPath();
          ctx.arc(p.x, p.y, band.innerRadius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(p.x, p.y, band.outerRadius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);

          // 20 tiny drifting cosmic dust specks distributed across [band.innerRadius, band.outerRadius]
          // via Golden-Angle + p.asteroidSeed, batched into 1 ctx.fill() call!
          const goldenAng = 2.399963229728653;
          const goldenFrac = 0.618033988749895;
          const seedOff = (p.asteroidSeed % 997) / 997;
          ctx.beginPath();
          for (let i = 0; i < 20; i++) {
            const u = (i * goldenFrac + seedOff) % 1;
            const speckR = band.innerRadius + u * band.bandWidth;
            const driftSpeed = 0.008 / Math.sqrt(Math.max(0.6, speckR / 175));
            const driftAngle =
              i * goldenAng + seedOff * Math.PI * 2 + time * driftSpeed;
            const dx = p.x + Math.cos(driftAngle) * speckR;
            const dy = p.y + Math.sin(driftAngle) * speckR;
            const sr = i % 3 === 0 ? 1.05 : 0.8;
            ctx.moveTo(dx + sr, dy);
            ctx.arc(dx, dy, sr, 0, Math.PI * 2);
          }
          ctx.fillStyle = "rgba(203, 213, 225, 0.30)";
          ctx.fill();

          ctx.restore();
        }
      }
    }
  }

  /**
   * Gravitational Energy Streams (tethers) from Parent Star to Active Planets.
   */
  private drawGravitationalStreams(
    ctx: CanvasRenderingContext2D,
    engine: SpringGraphEngine,
    time: number
  ): void {
    for (const n of engine.nodes.values()) {
      if (!n.data.parentId) continue;
      if (n.data.status === "completed") continue; // Tumbling asteroids don't have spokes!
      const p = engine.nodes.get(n.data.parentId);
      if (!p) continue;

      if (
        (n.x < this.cullMinX && p.x < this.cullMinX) ||
        (n.x > this.cullMaxX && p.x > this.cullMaxX) ||
        (n.y < this.cullMinY && p.y < this.cullMinY) ||
        (n.y > this.cullMaxY && p.y > this.cullMaxY)
      ) {
        continue;
      }

      const isRunning = n.data.status === "tool_running" || n.data.status === "thinking";
      const palette = HARNESS_COLORS[n.data.harness];

      const mx = (p.x + n.x) * 0.5;
      const my = (p.y + n.y) * 0.5;
      const dx = n.x - p.x;
      const dy = n.y - p.y;
      const cx = mx - dy * 0.08;
      const cy = my + dx * 0.08;

      ctx.save();
      ctx.globalAlpha = n.spawnAlpha ?? 1;
      if (isRunning) {
        // Soft glowing outer stream
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(cx, cy, n.x, n.y);
        ctx.strokeStyle = palette.glow;
        ctx.lineWidth = 3.6;
        ctx.stroke();

        // Sleek energetic core stream
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(cx, cy, n.x, n.y);
        ctx.strokeStyle = palette.ring;
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 3]);
        ctx.lineDashOffset = -time * 2.2;
        ctx.stroke();
      } else {
        // Calm gravitational ribbon
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(cx, cy, n.x, n.y);
        ctx.strokeStyle = "rgba(203, 213, 225, 0.28)";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 4]);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /**
   * Comet-Tail Packets: bright orbital probe heads with tapered luminous glowing tails.
   */
  private drawCometPackets(ctx: CanvasRenderingContext2D, engine: SpringGraphEngine): void {
    for (const pkt of engine.packets) {
      const a = engine.nodes.get(pkt.fromId);
      const b = engine.nodes.get(pkt.toId);
      if (!a || !b) continue;

      const x = a.x + (b.x - a.x) * pkt.t;
      const y = a.y + (b.y - a.y) * pkt.t;
      if (
        x < this.cullMinX ||
        x > this.cullMaxX ||
        y < this.cullMinY ||
        y > this.cullMaxY
      ) {
        continue;
      }

      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const tailLen = 15;
      const tailX = x - Math.cos(angle) * tailLen;
      const tailY = y - Math.sin(angle) * tailLen;

      ctx.save();
      // Tapered glowing comet tail
      const tailGrad = ctx.createLinearGradient(tailX, tailY, x, y);
      tailGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
      tailGrad.addColorStop(0.65, pkt.color);
      tailGrad.addColorStop(1, "#ffffff");

      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(x, y);
      ctx.strokeStyle = tailGrad;
      ctx.lineWidth = 2.8;
      ctx.lineCap = "round";
      ctx.stroke();

      // Zero-blur layered orbital probe head halo + crisp core
      ctx.beginPath();
      ctx.arc(x, y, 5.4, 0, Math.PI * 2);
      ctx.fillStyle = pkt.color;
      ctx.globalAlpha = 0.28;
      ctx.fill();

      ctx.globalAlpha = 1.0;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Main Node Dispatcher:
   * - Roots: Blazing Star / Golden Pulsar / Cooled Dwarf
   * - Active Subagents: Banded Planets with sunward lighting
   * - Completed Subagents: Tumbling Rocky Asteroids
   */
  private drawNode(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    engine: SpringGraphEngine,
    time: number
  ): void {
    const snap = node.data;
    if (!snap.isSubagent) {
      const rootPad = node.radius * 4.5 + 160;
      if (
        node.x < this.viewMinX - rootPad ||
        node.x > this.viewMaxX + rootPad ||
        node.y < this.viewMinY - rootPad ||
        node.y > this.viewMaxY + rootPad
      ) {
        return;
      }
    } else if (
      node.x < this.cullMinX ||
      node.x > this.cullMaxX ||
      node.y < this.cullMinY ||
      node.y > this.cullMaxY
    ) {
      return;
    }

    const parent = snap.parentId ? engine.nodes.get(snap.parentId) : undefined;
    const isCompleted = snap.isSubagent && snap.status === "completed";
    const isSelected = this.selectedNodeId === snap.id;
    const isParentSelected = snap.parentId ? this.selectedNodeId === snap.parentId : false;

    if (!snap.isSubagent) {
      this.drawOrchestratorStar(ctx, node, time, isSelected);
    } else if (node.reentry) {
      this.drawReentryMeteor(ctx, node, parent, time, isSelected);
    } else if (isCompleted) {
      this.drawCompletedAsteroid(ctx, node, parent, time, isSelected, isParentSelected);
    } else {
      this.drawSubagentPlanet(ctx, node, parent, time, isSelected, isParentSelected);
    }
  }

  /**
   * Orchestrator Star:
   * - Astrophysical Spectral Class (White Dwarf -> Yellow Star -> Orange Giant -> Red Giant -> Red Supergiant)
   * - Active: Multi-layer breathing corona + prominence arcs when tool_running!
   * - Resting (<90s idle): Calm corona at 55% alpha, awake blinking eyes.
   * - Slumbering (>=90s idle): Gentle breathing wave, twilight dimming veil, cozy ◡ ◡ eyes, floating z·z·Z.
   * - Waiting: Golden Pulsar Beacon + concentric expanding pulsar wave rings!
   */
  private drawOrchestratorStar(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    time: number,
    isSelected: boolean
  ): void {
    const snap = node.data;
    const palette = HARNESS_COLORS[snap.harness];
    const profile =
      node.stellarProfile ??
      computeStellarProfile(node.totalSubsCount ?? 0, snap.totalToolCalls);
    const sleep =
      this.sleepById.get(node.id) ?? computeStarSleepState(snap, this.frameNow);
    const isWaiting = snap.status === "waiting_on_user";
    const isWorking = snap.status === "tool_running" || snap.status === "thinking";
    const isToolRunning = snap.status === "tool_running";
    const isIdle = snap.status === "idle";
    const r = node.radius;

    ctx.save();
    ctx.translate(node.x, node.y);

    if (isWaiting) {
      this.drawLighthouseBeacon(ctx, node, r, time);
    }

    // Squash & stretch jelly spring
    let sx = 1 + node.boing * 0.22;
    let sy = 1 - node.boing * 0.18;

    // Slow Sleep Breathing wave (~13s period) when asleep
    let breath = 0;
    if (sleep.isAsleep) {
      breath = Math.sin(time * 0.48 + node.orbitPhase);
      sx *= 1 + breath * 0.032 * sleep.sleepDepth;
      sy *= 1 - breath * 0.028 * sleep.sleepDepth;
    }
    ctx.scale(sx, sy);

    // 0. Accretion Disk BACK HALF (Antigravity harness)
    if (snap.harness === "antigravity") {
      this.drawAccretionRingBack(ctx, r, isWorking, sleep.isAsleep);
    }

    // 1. Selection Halo (if selected)
    if (isSelected) {
      this.drawSelectionHalo(ctx, r, palette, time);
    }

    // 2. Photosphere & Corona Rendering (for ALL root star states — Active, Waiting, Resting, Asleep)
    if (sleep.isAsleep) {
      // --- DEEP SLUMBER STATE ---
      // 1. Subtle hushed ember corona pulsing gently with breath
      const emberAlpha = 0.16 + 0.08 * (0.5 + 0.5 * breath);
      const coronaR = r + 8 + (r > 38 ? 4 : 0);
      const gradCorona = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, coronaR);
      gradCorona.addColorStop(0, profile.coronaGlow);
      gradCorona.addColorStop(0.7, "rgba(255, 255, 255, 0.02)");
      gradCorona.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.save();
      ctx.globalAlpha = emberAlpha;
      ctx.beginPath();
      ctx.arc(0, 0, coronaR, 0, Math.PI * 2);
      ctx.fillStyle = gradCorona;
      ctx.fill();
      ctx.restore();

      // 2. Photosphere base with star's true spectral gradient
      const gradCore = ctx.createRadialGradient(-r * 0.28, -r * 0.28, r * 0.1, 0, 0, r);
      gradCore.addColorStop(0, profile.coreCenter);
      gradCore.addColorStop(0.42, profile.coreMid);
      gradCore.addColorStop(0.85, profile.coreLimb);
      gradCore.addColorStop(1, profile.coreLimb);

      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = gradCore;
      ctx.fill();

      // Convective giant surface detail (Orange/Red Giants & Supergiants)
      if (profile.convective) {
        this.drawConvectivePlasmaArcs(ctx, r, time, node.orbitPhase, profile.rimColor, 0.09);
      }

      // 3. Soft radial twilight dimming veil over the sphere
      const veil = ctx.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.1, 0, 0, r);
      veil.addColorStop(0, `rgba(7, 11, 22, ${(0.32 * sleep.sleepDepth).toFixed(3)})`);
      veil.addColorStop(1, `rgba(5, 8, 18, ${(0.62 * sleep.sleepDepth).toFixed(3)})`);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = veil;
      ctx.fill();

      // 4. Dimmed photosphere rim pulsing softly with breath
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = profile.rimColor;
      ctx.globalAlpha = 0.42 + 0.12 * breath;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.globalAlpha = 1.0;

      // 5. Cozy closed sleeping eyes ◡ ◡ (gently rising/falling slightly with breath)
      this.drawCuteEyes(ctx, node, r, true, false, breath * 0.7);
    } else if (isWaiting) {
      // --- WAITING ON USER (Golden Pulsar Beacon) ---
      // Concentric pulsar wave rings
      for (let i = 0; i < 2; i++) {
        const prog = (time * 0.11 + i * 0.5) % 1;
        const waveR = r + 6 + prog * 44;
        const alpha = (1 - prog) * 0.55;

        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, waveR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(251, 191, 36, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.restore();
      }

      // True stellar spectral photosphere
      const gradCore = ctx.createRadialGradient(-r * 0.28, -r * 0.28, r * 0.1, 0, 0, r);
      gradCore.addColorStop(0, profile.coreCenter);
      gradCore.addColorStop(0.42, profile.coreMid);
      gradCore.addColorStop(0.85, profile.coreLimb);
      gradCore.addColorStop(1, profile.coreLimb);

      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = gradCore;
      ctx.fill();

      if (profile.convective) {
        this.drawConvectivePlasmaArcs(ctx, r, time, node.orbitPhase, profile.rimColor, 0.16);
      }

      // Photosphere rim
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = profile.rimColor;
      ctx.lineWidth = 2.0;
      ctx.stroke();

      // Expressive awake eyes
      this.drawCuteEyes(ctx, node, r, false, false);
    } else {
      // --- ACTIVE (working) OR RESTING (< 90s idle) ---
      const isResting = sleep.isResting && !sleep.isAsleep;

      // Multi-layer breathing corona glow
      const coronaBaseR = r + 14 + (r > 38 ? 6 : 0);
      const pulse = isWorking ? (1 + Math.sin(time * 0.55 + node.orbitPhase) * 0.06) : 1.0;
      const coronaOuterR = coronaBaseR * pulse;
      const coronaInnerR = (r + 6) * pulse;

      ctx.save();
      if (isResting) {
        ctx.globalAlpha = 0.55;
      }

      // Outer corona
      const gradOuter = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, coronaOuterR);
      gradOuter.addColorStop(0, profile.coronaGlow);
      gradOuter.addColorStop(0.65, "rgba(255, 255, 255, 0.04)");
      gradOuter.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.beginPath();
      ctx.arc(0, 0, coronaOuterR, 0, Math.PI * 2);
      ctx.fillStyle = gradOuter;
      ctx.fill();

      // Inner corona
      ctx.beginPath();
      ctx.arc(0, 0, coronaInnerR, 0, Math.PI * 2);
      ctx.fillStyle = profile.coronaGlow;
      ctx.fill();
      ctx.restore();

      // True stellar spectral photosphere
      const gradCore = ctx.createRadialGradient(-r * 0.28, -r * 0.28, r * 0.1, 0, 0, r);
      gradCore.addColorStop(0, profile.coreCenter);
      gradCore.addColorStop(0.42, profile.coreMid);
      gradCore.addColorStop(0.85, profile.coreLimb);
      gradCore.addColorStop(1, profile.coreLimb);

      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = gradCore;
      ctx.fill();

      // Convective giant surface detail (Orange/Red Giants & Supergiants)
      if (profile.convective) {
        const convAlpha = isWorking ? 0.24 : 0.16;
        this.drawConvectivePlasmaArcs(ctx, r, time, node.orbitPhase, profile.rimColor, convAlpha);
      }

      // Photosphere rim
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = profile.rimColor;
      ctx.lineWidth = 2.0;
      ctx.stroke();

      // 3 animated curved solar prominence flare arcs when tool_running!
      if (isToolRunning) {
        for (let i = 0; i < 3; i++) {
          const baseAng = time * 0.22 + (i * Math.PI * 2) / 3 + node.orbitPhase;
          const arcSpan = 0.42;
          const flareH = r * 1.32 + Math.sin(time * 0.65 + i * 2) * 2.0;

          const p0x = Math.cos(baseAng - arcSpan) * r;
          const p0y = Math.sin(baseAng - arcSpan) * r;
          const cpx = Math.cos(baseAng) * flareH;
          const cpy = Math.sin(baseAng) * flareH;
          const p1x = Math.cos(baseAng + arcSpan) * r;
          const p1y = Math.sin(baseAng + arcSpan) * r;

          ctx.save();
          ctx.beginPath();
          ctx.moveTo(p0x, p0y);
          ctx.quadraticCurveTo(cpx, cpy, p1x, p1y);
          ctx.lineCap = "round";
          ctx.strokeStyle = profile.rimColor;
          ctx.globalAlpha = 0.32;
          ctx.lineWidth = 4.5;
          ctx.stroke();

          ctx.globalAlpha = 1.0;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.8;
          ctx.stroke();
          ctx.restore();
        }
      }

      // Awake blinking eyes (Resting stars stay awake & blinking)
      this.drawCuteEyes(ctx, node, r, false, isWorking);
    }

    // 2.5. Core Fuel Compaction Ring (>= 80% context fullness when awake)
    if (!sleep.isAsleep) {
      this.drawCoreFuelRing(ctx, node, r, time);
    }

    // 3. Accretion Disk FRONT HALF (Antigravity harness)
    if (snap.harness === "antigravity") {
      this.drawAccretionRingFront(ctx, r, isWorking, sleep.isAsleep);
    }

    // 4. Celestial Signatures (Claude, Codex, Antigravity, Strata)
    this.drawCelestialSignature(ctx, snap.harness, r, time, isWorking, true, isIdle, sleep.isAsleep);

    // 5. Skill Moons
    if (snap.skills.length > 0 && !sleep.isAsleep) {
      this.drawSkillMoons(ctx, node, r, time);
    }

    ctx.restore();

    // 6. Floating "z · z · Z" Sleep Animation (unscaled world coords)
    if (!snap.isSubagent && sleep.isAsleep) {
      ctx.save();
      for (let i = 0; i < 3; i++) {
        const prog = (time * 0.075 + i / 3 + (node.asteroidSeed % 97) * 0.01) % 1;
        const zx = node.x + r * 0.52 + prog * 11 + Math.sin(prog * Math.PI * 2 + i * 1.7) * 3.2;
        const zy = node.y - r * 0.52 - prog * (22 + r * 0.25);
        const alpha = Math.sin(prog * Math.PI) * 0.78 * sleep.sleepDepth;
        if (alpha > 0.01) {
          const fontSize = 8.5 + prog * 4;
          const glyph = prog < 0.55 ? "z" : "Z";

          ctx.font = `700 ${fontSize.toFixed(1)}px 'Segoe UI', system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineJoin = "round";
          ctx.strokeStyle = profile.rimColor;
          ctx.globalAlpha = alpha * 0.28;
          ctx.lineWidth = 2.6;
          ctx.strokeText(glyph, zx, zy);
          ctx.globalAlpha = 1.0;
          ctx.fillStyle = `rgba(226, 232, 240, ${alpha.toFixed(3)})`;
          ctx.fillText(glyph, zx, zy);
        }
      }
      ctx.restore();
    }

    // 7. Crisp unscaled session caption
    this.drawCaption(ctx, node, r, !snap.isSubagent, isIdle, palette);

    if (isWaiting) {
      this.drawWaitingCallout(ctx, node, r);
    } else {
      node.calloutRect = undefined;
    }
  }

  private drawConvectivePlasmaArcs(
    ctx: CanvasRenderingContext2D,
    r: number,
    time: number,
    orbitPhase: number,
    rimColor: string,
    alpha: number
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = rimColor;
    ctx.lineWidth = Math.max(1.4, r * 0.055);
    ctx.lineCap = "round";
    ctx.globalAlpha = alpha;

    for (let i = 0; i < 4; i++) {
      const cellAngle = time * 0.03 + (i * Math.PI) / 2 + orbitPhase;
      const cellDist = r * (0.28 + 0.22 * (i % 2 === 0 ? 1 : 0.6));
      const cx = Math.cos(cellAngle) * cellDist;
      const cy = Math.sin(cellAngle) * cellDist;
      const span = r * 0.38;
      const perpAngle = cellAngle + Math.PI * 0.5;
      const x0 = cx - Math.cos(perpAngle) * span;
      const y0 = cy - Math.sin(perpAngle) * span;
      const x1 = cx + Math.cos(perpAngle) * span;
      const y1 = cy + Math.sin(perpAngle) * span;
      const midX = cx + Math.cos(cellAngle) * (r * 0.12);
      const midY = cy + Math.sin(cellAngle) * (r * 0.12);

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(midX, midY, x1, y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Active Subagent Exoplanet:
   * 6 deterministic procedural archetypes (ocean, jovian, ringed, arid, ice, twilight),
   * true starward day/night terminator shadow, atmospheric limb glow,
   * 3D multi-band rings for Saturnian giants, and orbital probe satellite when tool_running!
   */
  private drawSubagentPlanet(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    parent: PhysicsNode | undefined,
    time: number,
    isSelected: boolean,
    isParentSelected: boolean
  ): void {
    const snap = node.data;
    const palette = HARNESS_COLORS[snap.harness];
    const isToolRunning = snap.status === "tool_running";
    const r = node.radius;
    const spawnAlpha = node.spawnAlpha ?? 1;

    // Genuine light angle from parent Star to planet
    const lightAngle = parent
      ? Math.atan2(parent.y - node.y, parent.x - node.x)
      : -Math.PI * 0.75;

    ctx.save();
    ctx.globalAlpha = spawnAlpha;

    // Soft gravitational capture wake while falling in from deep space (zero shadowBlur)
    if (node.infall && node.infall.progress < 0.92 && parent) {
      const rem = Math.pow(1 - node.infall.progress, 2);
      const outAng = Math.atan2(node.y - parent.y, node.x - parent.x);
      const wakeAng =
        outAng + (node.infall.startAngleOffset >= 0 ? 0.45 : -0.45);
      const wakeLen = (18 + 34 * rem);
      const wx = node.x + Math.cos(wakeAng) * wakeLen;
      const wy = node.y + Math.sin(wakeAng) * wakeLen;
      const wakeGrad = ctx.createLinearGradient(wx, wy, node.x, node.y);
      wakeGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
      wakeGrad.addColorStop(1, palette.glow);
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.lineTo(node.x, node.y);
      ctx.strokeStyle = wakeGrad;
      ctx.lineWidth = Math.max(1.5, r * 0.48 * rem);
      ctx.lineCap = "round";
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(node.x, node.y);

    const sx = 1 + node.boing * 0.22;
    const sy = 1 - node.boing * 0.18;
    ctx.scale(sx, sy);

    const archetype = (node.asteroidSeed >>> 0) % 6;
    const rot = time * 0.048 * (node.spinSpeed >= 0 ? 1 : -1) + (node.asteroidSeed % 100) * 0.06;
    const axialTilt = (((node.asteroidSeed >>> 4) % 21) - 10) * 0.032; // ~ -18° to +18°

    // 0. Ringed Giant BACK HALF rings (tilted at ringTilt, drawn before sphere)
    if (archetype === 2) {
      const ringTilt = axialTilt - 0.32;
      ctx.save();
      ctx.rotate(ringTilt);
      // Outer dusty ring: rx = r * 1.95, ry = rx * 0.30, rgba(253, 230, 138, 0.55), lineWidth: 2.6
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.95, r * 1.95 * 0.30, 0, Math.PI, Math.PI * 2);
      ctx.strokeStyle = "rgba(253, 230, 138, 0.55)";
      ctx.lineWidth = 2.6;
      ctx.stroke();

      // Inner icy ring: rx = r * 1.56, ry = rx * 0.30, rgba(254, 249, 195, 0.38), lineWidth: 1.6
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.56, r * 1.56 * 0.30, 0, Math.PI, Math.PI * 2);
      ctx.strokeStyle = "rgba(254, 249, 195, 0.38)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    }

    // 1. Selection Halos
    if (isSelected) {
      this.drawSelectionHalo(ctx, r, palette, time);
    } else if (isParentSelected) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r + 4.2, 0, Math.PI * 2);
      ctx.strokeStyle = palette.ring;
      ctx.lineWidth = 1.1;
      ctx.setLineDash([2.5, 3]);
      ctx.globalAlpha = 0.65;
      ctx.stroke();
      ctx.restore();
    }

    // 2. Planet Sphere with Surface Archetype and Starward Terminator Shadow
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();

    ctx.save();
    ctx.rotate(axialTilt);

    const wrapW = r * 2.6;
    const wrapX = (val: number) => (((val % wrapW) + wrapW) % wrapW) - wrapW * 0.5;

    if (archetype === 0) {
      // --- Archetype 0: Terra / Ocean World ---
      const sunLX = Math.cos(lightAngle - axialTilt) * r * 0.35;
      const sunLY = Math.sin(lightAngle - axialTilt) * r * 0.35;
      const oceanGrad = ctx.createRadialGradient(sunLX, sunLY, r * 0.1, 0, 0, r);
      oceanGrad.addColorStop(0, "#38bdf8");
      oceanGrad.addColorStop(0.55, "#0284c7");
      oceanGrad.addColorStop(1, "#1e3a8a");
      ctx.fillStyle = oceanGrad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();

      // 2-3 rounded organic emerald/sage continental landmasses (#34d399 & #10b981 with warm #a7f3d0 coastal highlight)
      const drawContinent = (baseX: number, cy: number, rx: number, ry: number, tilt: number) => {
        const cx = wrapX(baseX + rot * r);
        const drawAt = (x: number) => {
          ctx.save();
          ctx.translate(x, cy);
          ctx.rotate(tilt);
          ctx.fillStyle = "#10b981";
          ctx.beginPath();
          ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#34d399";
          ctx.beginPath();
          ctx.ellipse(rx * 0.12, -ry * 0.1, rx * 0.62, ry * 0.58, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(167, 243, 208, 0.70)";
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        };
        drawAt(cx);
        if (cx < -r * 0.5) drawAt(cx + wrapW);
        else if (cx > r * 0.5) drawAt(cx - wrapW);
      };

      drawContinent(0, -r * 0.22, r * 0.52, r * 0.34, 0.18);
      drawContinent(r * 0.95, r * 0.28, r * 0.58, r * 0.36, -0.22);
      drawContinent(r * 1.85, -r * 0.45, r * 0.40, r * 0.24, 0.12);

      // Snowy white polar ice caps (rgba(248, 250, 252, 0.85)) at y = -r * 0.92 and y = r * 0.92
      ctx.fillStyle = "rgba(248, 250, 252, 0.85)";
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.92, r * 0.54, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, r * 0.92, r * 0.48, r * 0.20, 0, 0, Math.PI * 2);
      ctx.fill();

      // 2 delicate translucent white atmospheric cloud wisps (rgba(255, 255, 255, 0.48))
      const drawCloudWisp = (baseX: number, cy: number, w: number, curve: number) => {
        const cx = wrapX(baseX + rot * r * 1.35);
        const drawAt = (x: number) => {
          ctx.save();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.48)";
          ctx.lineWidth = 1.5;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(x - w * 0.5, cy);
          ctx.quadraticCurveTo(x, cy + curve, x + w * 0.5, cy);
          ctx.stroke();
          ctx.restore();
        };
        drawAt(cx);
        if (cx < -r * 0.5) drawAt(cx + wrapW);
        else if (cx > r * 0.5) drawAt(cx - wrapW);
      };
      drawCloudWisp(r * 0.3, -r * 0.32, r * 0.9, -2.2);
      drawCloudWisp(r * 1.5, r * 0.18, r * 1.1, 2.0);
    } else if (archetype === 1) {
      // --- Archetype 1: Jovian Banded Gas Giant ---
      const belts = [
        { y0: -r * 1.05, y1: -r * 0.65, color: "#fed7aa" },
        { y0: -r * 0.65, y1: -r * 0.38, color: "#ea580c" },
        { y0: -r * 0.38, y1: -r * 0.15, color: "#fef3c7" },
        { y0: -r * 0.15, y1: r * 0.12,  color: "#9a3412" },
        { y0: r * 0.12,  y1: r * 0.42,  color: "#f59e0b" },
        { y0: r * 0.42,  y1: r * 0.70,  color: "#ea580c" },
        { y0: r * 0.70,  y1: r * 1.05,  color: "#fed7aa" },
      ];
      for (const b of belts) {
        ctx.fillStyle = b.color;
        ctx.fillRect(-r * 1.3, b.y0, r * 2.6, b.y1 - b.y0);
      }
      ctx.strokeStyle = "rgba(254, 243, 199, 0.35)";
      ctx.lineWidth = 1.0;
      for (let i = 1; i < belts.length; i++) {
        const y = belts[i].y0;
        ctx.beginPath();
        ctx.moveTo(-r * 1.2, y);
        ctx.quadraticCurveTo(0, y + (i % 2 === 0 ? 1.5 : -1.5), r * 1.2, y);
        ctx.stroke();
      }

      // Great Red/Amber Storm oval
      const stormY = r * 0.28;
      const stormX = wrapX(rot * r * 0.75);
      const drawStorm = (x: number) => {
        ctx.save();
        ctx.translate(x, stormY);
        ctx.fillStyle = "#7c2d12";
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.34, r * 0.20, -0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fb923c";
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.22, r * 0.13, -0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fef08a";
        ctx.beginPath();
        ctx.ellipse(-r * 0.05, -r * 0.03, r * 0.08, r * 0.05, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };
      drawStorm(stormX);
      if (stormX < -r * 0.5) drawStorm(stormX + wrapW);
      else if (stormX > r * 0.5) drawStorm(stormX - wrapW);
    } else if (archetype === 2) {
      // --- Archetype 2: Saturnian Ringed Giant ---
      const gradSaturn = ctx.createLinearGradient(0, -r, 0, r);
      gradSaturn.addColorStop(0, "#fef9c3");
      gradSaturn.addColorStop(0.35, "#fde68a");
      gradSaturn.addColorStop(0.68, "#eab308");
      gradSaturn.addColorStop(1, "#a16207");
      ctx.fillStyle = gradSaturn;
      ctx.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6);

      ctx.fillStyle = "rgba(120, 53, 15, 0.22)";
      ctx.fillRect(-r * 1.3, -r * 0.28, r * 2.6, r * 0.16);
      ctx.fillRect(-r * 1.3, r * 0.32, r * 2.6, r * 0.14);

      // Subtle thin ring shadow band across the equator
      ctx.save();
      ctx.rotate(-0.32);
      ctx.fillStyle = "rgba(20, 12, 4, 0.45)";
      ctx.fillRect(-r * 1.3, r * 0.04, r * 2.6, r * 0.15);
      ctx.restore();
    } else if (archetype === 3) {
      // --- Archetype 3: Martian Rust Desert World ---
      const sunLX3 = Math.cos(lightAngle - axialTilt) * r * 0.35;
      const sunLY3 = Math.sin(lightAngle - axialTilt) * r * 0.35;
      const gradMars = ctx.createRadialGradient(sunLX3, sunLY3, r * 0.1, 0, 0, r);
      gradMars.addColorStop(0, "#fdba74");
      gradMars.addColorStop(0.55, "#ea580c");
      gradMars.addColorStop(1, "#7c2d12");
      ctx.fillStyle = gradMars;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();

      // Basaltic Maria patches (rgba(67, 20, 7, 0.34))
      const drawMaria = (baseX: number, cy: number, rx: number, ry: number) => {
        const cx = wrapX(baseX + rot * r);
        const drawAt = (x: number) => {
          ctx.save();
          ctx.fillStyle = "rgba(67, 20, 7, 0.34)";
          ctx.beginPath();
          ctx.ellipse(x, cy, rx, ry, 0.22, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        };
        drawAt(cx);
        if (cx < -r * 0.5) drawAt(cx + wrapW);
        else if (cx > r * 0.5) drawAt(cx - wrapW);
      };
      drawMaria(0, r * 0.15, r * 0.52, r * 0.28);
      drawMaria(r * 1.1, -r * 0.25, r * 0.44, r * 0.24);

      // 2 subtle sunlit rimmed impact basins drifting with rot
      const drawCrater = (baseX: number, cy: number, cr: number) => {
        const cx = wrapX(baseX + rot * r);
        const drawAt = (x: number) => {
          ctx.save();
          ctx.fillStyle = "rgba(45, 12, 4, 0.45)";
          ctx.beginPath();
          ctx.arc(x, cy, cr, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(253, 186, 116, 0.72)";
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.arc(x, cy, cr, lightAngle - axialTilt - Math.PI * 0.5, lightAngle - axialTilt + Math.PI * 0.5);
          ctx.stroke();
          ctx.restore();
        };
        drawAt(cx);
        if (cx < -r * 0.5) drawAt(cx + wrapW);
        else if (cx > r * 0.5) drawAt(cx - wrapW);
      };
      drawCrater(r * 0.45, -r * 0.18, r * 0.22);
      drawCrater(r * 1.55, r * 0.32, r * 0.17);

      // Small crisp north polar frost cap (rgba(255, 247, 237, 0.82))
      ctx.fillStyle = "rgba(255, 247, 237, 0.82)";
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.90, r * 0.38, r * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (archetype === 4) {
      // --- Archetype 4: Neptunian Ice Giant ---
      const sunLX4 = Math.cos(lightAngle - axialTilt) * r * 0.35;
      const sunLY4 = Math.sin(lightAngle - axialTilt) * r * 0.35;
      const gradNeptune = ctx.createRadialGradient(sunLX4, sunLY4, r * 0.1, 0, 0, r);
      gradNeptune.addColorStop(0, "#a5f3fc");
      gradNeptune.addColorStop(0.35, "#06b6d4");
      gradNeptune.addColorStop(0.75, "#1d4ed8");
      gradNeptune.addColorStop(1, "#172554");
      ctx.fillStyle = gradNeptune;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();

      // Slanted pale supersonic ice-crystal wind bands (rgba(224, 242, 254, 0.38))
      ctx.strokeStyle = "rgba(224, 242, 254, 0.38)";
      ctx.lineWidth = 1.4;
      const bandsY = [-r * 0.45, -r * 0.15, r * 0.15, r * 0.48];
      for (let i = 0; i < bandsY.length; i++) {
        const by = bandsY[i];
        ctx.beginPath();
        ctx.moveTo(-r * 1.2, by);
        ctx.quadraticCurveTo(0, by + (i % 2 === 0 ? 2 : -2), r * 1.2, by);
        ctx.stroke();
      }

      // Dark cobalt storm oval
      const stormY4 = r * 0.22;
      const stormX4 = wrapX(rot * r * 0.80);
      const drawDarkSpot = (x: number) => {
        ctx.save();
        ctx.translate(x, stormY4);
        ctx.fillStyle = "rgba(15, 23, 42, 0.65)";
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.32, r * 0.17, -0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(165, 243, 252, 0.30)";
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.18, r * 0.09, -0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };
      drawDarkSpot(stormX4);
      if (stormX4 < -r * 0.5) drawDarkSpot(stormX4 + wrapW);
      else if (stormX4 > r * 0.5) drawDarkSpot(stormX4 - wrapW);
    } else {
      // --- Archetype 5: Lush Violet / Twilight Super-Earth ---
      const sunLX5 = Math.cos(lightAngle - axialTilt) * r * 0.35;
      const sunLY5 = Math.sin(lightAngle - axialTilt) * r * 0.35;
      const gradTwilight = ctx.createRadialGradient(sunLX5, sunLY5, r * 0.1, 0, 0, r);
      gradTwilight.addColorStop(0, "#f5d0fe");
      gradTwilight.addColorStop(0.40, "#c084fc");
      gradTwilight.addColorStop(0.70, "#a855f7");
      gradTwilight.addColorStop(0.90, "#4c1d95");
      gradTwilight.addColorStop(1, "#2e1065");
      ctx.fillStyle = gradTwilight;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();

      // Swirling pearlescent lavender cloud bands
      const drawLavenderClouds = (baseX: number, cy: number, w: number, curve: number) => {
        const cx = wrapX(baseX + rot * r * 1.15);
        const drawAt = (x: number) => {
          ctx.save();
          ctx.strokeStyle = "rgba(253, 244, 255, 0.42)";
          ctx.lineWidth = 1.7;
          ctx.beginPath();
          ctx.moveTo(x - w * 0.5, cy);
          ctx.quadraticCurveTo(x, cy + curve, x + w * 0.5, cy);
          ctx.stroke();
          ctx.restore();
        };
        drawAt(cx);
        if (cx < -r * 0.5) drawAt(cx + wrapW);
        else if (cx > r * 0.5) drawAt(cx - wrapW);
      };
      drawLavenderClouds(0, -r * 0.28, r * 1.1, -2.5);
      drawLavenderClouds(r * 0.9, r * 0.20, r * 1.2, 2.8);
      drawLavenderClouds(r * 1.7, -r * 0.50, r * 0.8, -1.8);

      // Amethyst highland patches
      const drawHighland = (baseX: number, cy: number, rx: number, ry: number) => {
        const cx = wrapX(baseX + rot * r);
        const drawAt = (x: number) => {
          ctx.save();
          ctx.fillStyle = "rgba(112, 26, 117, 0.32)";
          ctx.beginPath();
          ctx.ellipse(x, cy, rx, ry, 0.15, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(244, 114, 182, 0.45)";
          ctx.lineWidth = 0.8;
          ctx.stroke();
          ctx.restore();
        };
        drawAt(cx);
        if (cx < -r * 0.5) drawAt(cx + wrapW);
        else if (cx > r * 0.5) drawAt(cx - wrapW);
      };
      drawHighland(r * 0.35, -r * 0.10, r * 0.40, r * 0.22);
      drawHighland(r * 1.4, r * 0.35, r * 0.48, r * 0.26);
    }

    ctx.restore(); // unrotate axialTilt

    // Realistic night-side crescent shadow offset away from parent Star
    const nx = -Math.cos(lightAngle) * r * 0.60;
    const ny = -Math.sin(lightAngle) * r * 0.60;
    const gradShadow = ctx.createRadialGradient(nx, ny, r * 0.15, nx, ny, r * 1.25);
    gradShadow.addColorStop(0, "rgba(4, 8, 20, 0.82)");
    gradShadow.addColorStop(0.55, "rgba(4, 8, 20, 0.58)");
    gradShadow.addColorStop(0.85, "rgba(4, 8, 20, 0.18)");
    gradShadow.addColorStop(1, "rgba(4, 8, 20, 0)");

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = gradShadow;
    ctx.fill();

    ctx.restore(); // unclip sphere

    // 3. Ringed Giant FRONT HALF rings (angles 0 to Math.PI)
    if (archetype === 2) {
      const ringTilt = axialTilt - 0.32;
      ctx.save();
      ctx.rotate(ringTilt);
      // Outer ring front
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.95, r * 1.95 * 0.30, 0, 0, Math.PI);
      ctx.strokeStyle = "rgba(253, 230, 138, 0.65)";
      ctx.lineWidth = 2.6;
      ctx.stroke();

      // Inner ring front
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.56, r * 1.56 * 0.30, 0, 0, Math.PI);
      ctx.strokeStyle = "rgba(254, 249, 195, 0.48)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    }

    // 4. Sunward atmospheric limb crescent & subtle outer atmospheric aura
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.5, lightAngle - Math.PI * 0.46, lightAngle + Math.PI * 0.46);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Subtle outer atmospheric aura on sunward side
    const auraGrad = ctx.createRadialGradient(
      Math.cos(lightAngle) * r * 0.5,
      Math.sin(lightAngle) * r * 0.5,
      r * 0.75,
      0,
      0,
      r + 2.8
    );
    auraGrad.addColorStop(0, "rgba(255, 255, 255, 0.26)");
    auraGrad.addColorStop(0.6, "rgba(255, 255, 255, 0.08)");
    auraGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.beginPath();
    ctx.arc(0, 0, r + 2.8, 0, Math.PI * 2);
    ctx.fillStyle = auraGrad;
    ctx.fill();
    ctx.restore();

    // Crisp subtle planet rim stroke
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = 1.0;
    ctx.stroke();

    // 5. Tool-Running Indicator (Orbital Probe Satellite)
    if (isToolRunning) {
      const satAngle = time * 0.34 + node.orbitPhase;
      const trackR = r + 4.5;

      ctx.save();
      // Delicate dashed orbital telemetry track
      ctx.beginPath();
      ctx.arc(0, 0, trackR, 0, Math.PI * 2);
      ctx.strokeStyle = palette.ring;
      ctx.lineWidth = 1.0;
      ctx.setLineDash([2, 3]);
      ctx.globalAlpha = 0.45;
      ctx.stroke();
      ctx.setLineDash([]);

      // Tiny bright orbiting telemetry satellite/probe dot
      const satX = Math.cos(satAngle) * trackR;
      const satY = Math.sin(satAngle) * trackR;

      // 3.8px palette.ring halo
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.arc(satX, satY, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = palette.ring;
      ctx.fill();

      // 1.9px white core
      ctx.globalAlpha = 1.0;
      ctx.beginPath();
      ctx.arc(satX, satY, 1.9, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();

      ctx.restore();
    }

    // 6. Core Fuel Compaction Ring (>= 85% context fullness on subagent planet)
    this.drawCoreFuelRing(ctx, node, r, time);

    // 7. Skill Moons
    if (snap.skills.length > 0) {
      this.drawSkillMoons(ctx, node, r, time);
    }

    ctx.restore();

    // Caption
    this.drawCaption(ctx, node, r, false, false, palette);
    ctx.restore();
  }

  /**
   * Completed Subagent Asteroid:
   * Tumbling 7-vertex irregular faceted rocky polygon, directional shading facing Star,
   * crisp facet edges, and 2 tiny circular craters!
   */
  private drawCompletedAsteroid(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    parent: PhysicsNode | undefined,
    time: number,
    isSelected: boolean,
    isParentSelected: boolean
  ): void {
    const snap = node.data;
    const palette = HARNESS_COLORS[snap.harness];
    const r = node.radius;

    ctx.save();
    ctx.globalAlpha = node.spawnAlpha ?? 1;
    ctx.save();
    ctx.translate(node.x, node.y);

    // Selection Halos
    if (isSelected) {
      this.drawSelectionHalo(ctx, r, palette, time);
    } else if (isParentSelected) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r + 2.8, 0, Math.PI * 2);
      ctx.strokeStyle = palette.ring;
      ctx.lineWidth = 0.9;
      ctx.setLineDash([2, 2]);
      ctx.globalAlpha = 0.55;
      ctx.stroke();
      ctx.restore();
    }

    // Tumbling rotation
    ctx.rotate(node.spinAngle);

    if (node.isHovered) {
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.48, 0, Math.PI * 2);
      ctx.fillStyle = palette.glow;
      ctx.fill();
    }

    // Build faceted rocky polygon scaled by asteroid mass class (6 angular facets on Meteoroids -> 10 quasi-spherical facets on Dwarf Planetoids)
    const profile =
      node.asteroidProfile ??
      computeAsteroidProfile(snap.turnCount, snap.totalToolCalls);
    const numVerts = profile.facets;
    const isMassive =
      profile.asteroidClass === "planetesimal" ||
      profile.asteroidClass === "planetoid";
    const minRadFactor = isMassive ? 0.82 : profile.asteroidClass === "meteoroid" ? 0.7 : 0.75;
    const varRadFactor = isMassive ? 0.21 : profile.asteroidClass === "meteoroid" ? 0.34 : 0.3;

    ctx.beginPath();
    for (let i = 0; i < numVerts; i++) {
      const ang = (i / numVerts) * Math.PI * 2;
      const h = hash2D(node.asteroidSeed, i);
      const radI = r * (minRadFactor + varRadFactor * ((h % 1000) / 1000));
      const vx = Math.cos(ang) * radI;
      const vy = Math.sin(ang) * radI;
      if (i === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
    ctx.closePath();

    // Directional shading facing parent Star
    const lightAngle = parent
      ? Math.atan2(parent.y - node.y, parent.x - node.x) - node.spinAngle
      : -Math.PI * 0.75 - node.spinAngle;

    const lx = Math.cos(lightAngle) * r;
    const ly = Math.sin(lightAngle) * r;
    const grad = ctx.createLinearGradient(lx, ly, -lx, -ly);

    if (node.isHovered || isSelected) {
      grad.addColorStop(0, palette.ring);
      grad.addColorStop(0.55, palette.core);
      grad.addColorStop(1, "#1e293b");
    } else if (isMassive) {
      grad.addColorStop(0, palette.ring);
      grad.addColorStop(0.28, palette.dim);
      grad.addColorStop(0.58, "#94a3b8");
      grad.addColorStop(1, "#0f172a");
    } else {
      grad.addColorStop(0, palette.dim);
      grad.addColorStop(0.35, "#94a3b8");
      grad.addColorStop(1, "#1e293b");
    }

    ctx.fillStyle = grad;
    ctx.fill();

    // Crisp rocky facet edge stroke
    ctx.strokeStyle =
      node.isHovered || isSelected
        ? "#ffffff"
        : isMassive
          ? "rgba(203, 213, 225, 0.58)"
          : "rgba(148, 163, 184, 0.45)";
    ctx.lineWidth = node.isHovered || isSelected ? 1.4 : isMassive ? 1.1 : 0.85;
    ctx.stroke();

    // Craters scaled to asteroid mass class (1 on tiny Meteoroid pebbles, 2 on Chondrites/Asteroids, 3 + sunlit rim on Planetesimals/Planetoids)
    this.drawDarkCrater(ctx, -r * 0.22, -r * 0.18, r * 0.19);
    if (profile.craters >= 2) {
      this.drawDarkCrater(ctx, r * 0.21, r * 0.22, r * 0.14);
    }
    if (profile.craters >= 3) {
      this.drawDarkCrater(ctx, r * 0.24, -r * 0.22, r * 0.12);
      // Subtle sunlit impact basin rim on massive minor planets (zero shadowBlur)
      ctx.beginPath();
      ctx.arc(
        -r * 0.22,
        -r * 0.18,
        r * 0.2,
        lightAngle - Math.PI * 0.42,
        lightAngle + Math.PI * 0.42
      );
      ctx.strokeStyle = "rgba(241, 245, 249, 0.48)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    ctx.restore();

    // Hover or Selected caption
    if (node.isHovered || isSelected) {
      this.drawCaption(ctx, node, r, false, false, palette);
    }
    ctx.restore();
  }

  /**
   * Core Fuel Compaction Ring (zero shadowBlur):
   * Drawn around orchestrator stars (>= 80%) and subagent planets (>= 85%)
   * when context-window occupancy approaches compaction.
   */
  private drawCoreFuelRing(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    r: number,
    time: number
  ): void {
    const snap = node.data;
    const ctxPct = snap.tokenUsage?.contextPercent ?? 0;
    const threshold = snap.isSubagent ? 85 : 80;
    if (ctxPct < threshold) return;

    const gaugeR = r + (snap.isSubagent ? 3.6 : 5.2);
    const startAng = -Math.PI * 0.5;
    const sweep = (Math.min(100, ctxPct) / 100) * Math.PI * 2;
    const isCritical = ctxPct >= 90;

    ctx.save();
    ctx.lineCap = "round";

    // Soft wide outer glow arc (zero shadowBlur)
    ctx.beginPath();
    ctx.arc(0, 0, gaugeR, startAng, startAng + sweep);
    ctx.lineWidth = 4.2;
    ctx.globalAlpha = 0.2 + 0.12 * (0.5 + 0.5 * Math.sin(time * 1.05 + node.orbitPhase));
    ctx.strokeStyle = isCritical ? "#fb7185" : "#f59e0b";
    ctx.stroke();

    // Crisp inner gauge arc
    ctx.beginPath();
    ctx.arc(0, 0, gaugeR, startAng, startAng + sweep);
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = isCritical ? "#fecdd3" : "#fde68a";
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Blazing Meteoric Re-Entry (zero shadowBlur):
   * Curved tapered plasma wake + fiery atmospheric bow-shock crescent as a completed
   * subagent spirals inward to feed its parent orchestrator star.
   */
  private drawReentryMeteor(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    parent: PhysicsNode | undefined,
    time: number,
    isSelected: boolean
  ): void {
    const reentry = node.reentry;
    if (!reentry) return;
    const snap = node.data;
    const palette = HARNESS_COLORS[snap.harness];
    const r = node.radius;
    const trail = reentry.trail;

    // 1. Tapered curved plasma trail in world coordinates
    if (trail.length >= 2) {
      ctx.save();
      ctx.lineCap = "round";
      const segCount = trail.length - 1;
      for (let i = 1; i < trail.length; i++) {
        const p0 = trail[i - 1];
        const p1 = trail[i];
        const frac = i / segCount;

        // Outer translucent harness plasma wake
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.strokeStyle = palette.core;
        ctx.globalAlpha = 0.05 + 0.36 * frac;
        ctx.lineWidth = 1.8 + 4.8 * frac;
        ctx.stroke();

        // Inner white-gold incandescent core streak
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.strokeStyle = frac > 0.65 ? "#ffffff" : "#fef08a";
        ctx.globalAlpha = 0.05 + 0.87 * frac;
        ctx.lineWidth = 1.0 + 2.2 * frac;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Compute velocity / entry heading vector
    let heading = 0;
    if (trail.length >= 2) {
      const prev = trail[trail.length - 2];
      const dx = node.x - prev.x;
      const dy = node.y - prev.y;
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        heading = Math.atan2(dy, dx);
      } else if (parent) {
        heading = Math.atan2(parent.y - node.y, parent.x - node.x);
      }
    } else if (parent) {
      heading = Math.atan2(parent.y - node.y, parent.x - node.x);
    }

    ctx.save();
    ctx.translate(node.x, node.y);

    if (isSelected) {
      this.drawSelectionHalo(ctx, r, palette, time);
    }

    // 2. Soft fiery atmospheric plasma envelope (radial gradient, zero shadowBlur)
    const envR = r * 1.9;
    const envGrad = ctx.createRadialGradient(
      Math.cos(heading) * r * 0.25,
      Math.sin(heading) * r * 0.25,
      r * 0.15,
      0,
      0,
      envR
    );
    envGrad.addColorStop(0, "rgba(254, 240, 138, 0.55)");
    envGrad.addColorStop(0.5, palette.glow);
    envGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.beginPath();
    ctx.arc(0, 0, envR, 0, Math.PI * 2);
    ctx.fillStyle = envGrad;
    ctx.fill();

    // 3. Heated meteoric body
    const coreGrad = ctx.createRadialGradient(
      Math.cos(heading) * r * 0.35,
      Math.sin(heading) * r * 0.35,
      r * 0.1,
      0,
      0,
      r
    );
    coreGrad.addColorStop(0, "#ffffff");
    coreGrad.addColorStop(0.45, "#fde047");
    coreGrad.addColorStop(1, palette.core);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = coreGrad;
    ctx.fill();

    // 4. Fiery atmospheric bow-shock crescent facing heading
    ctx.save();
    ctx.rotate(heading);
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.arc(0, 0, r + 2.4, -0.95, 0.95);
    ctx.strokeStyle = palette.core;
    ctx.globalAlpha = 0.48;
    ctx.lineWidth = 4.0;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r + 2.0, -0.76, 0.76);
    ctx.strokeStyle = "#fde047";
    ctx.globalAlpha = 0.86;
    ctx.lineWidth = 2.3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r + 1.7, -0.5, 0.5);
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = 0.96;
    ctx.lineWidth = 1.35;
    ctx.stroke();

    ctx.restore();
    ctx.restore();
  }

  /**
   * Solar Accretion Flares (zero shadowBlur):
   * Expanding coronal shockwave ring + directional solar prominence splash arc &
   * 3 erupting plasma droplets when a completed subagent impacts its parent star.
   */
  private drawSolarAccretionFlares(
    ctx: CanvasRenderingContext2D,
    engine: SpringGraphEngine
  ): void {
    for (let i = 0; i < engine.solarFlares.length; i++) {
      const flare = engine.solarFlares[i];
      const parent = engine.nodes.get(flare.parentId);
      if (!parent) continue;

      const pad = parent.radius + 70;
      if (
        parent.x + pad < this.viewMinX ||
        parent.x - pad > this.viewMaxX ||
        parent.y + pad < this.viewMinY ||
        parent.y - pad > this.viewMaxY
      ) {
        continue;
      }

      const prog = Math.min(1, Math.max(0, flare.age / flare.maxAge));
      const fade = Math.pow(1 - prog, 1.45);
      if (fade <= 0.01) continue;

      const ringR = parent.radius + 2 + prog * 46;

      ctx.save();
      ctx.translate(parent.x, parent.y);

      // 1. Expanding golden-coral coronal shockwave ring
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.lineWidth = 6 * fade;
      ctx.globalAlpha = 0.26 * fade;
      ctx.strokeStyle = flare.color;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.lineWidth = 2.0 * fade + 0.6;
      ctx.globalAlpha = 0.85 * fade;
      ctx.strokeStyle = "#fef08a";
      ctx.stroke();

      // 2. Directional solar prominence splash arc at impactAngle
      const arcSpan = 0.44 + prog * 0.22;
      const splashPeak = parent.radius + 14 + prog * 24;
      const p0x = Math.cos(flare.impactAngle - arcSpan) * parent.radius;
      const p0y = Math.sin(flare.impactAngle - arcSpan) * parent.radius;
      const cpx = Math.cos(flare.impactAngle) * splashPeak;
      const cpy = Math.sin(flare.impactAngle) * splashPeak;
      const p1x = Math.cos(flare.impactAngle + arcSpan) * parent.radius;
      const p1y = Math.sin(flare.impactAngle + arcSpan) * parent.radius;

      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(cpx, cpy, p1x, p1y);
      ctx.strokeStyle = flare.color;
      ctx.globalAlpha = 0.42 * fade;
      ctx.lineWidth = 4.6 * fade;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(cpx, cpy, p1x, p1y);
      ctx.strokeStyle = "#ffffff";
      ctx.globalAlpha = 0.9 * fade;
      ctx.lineWidth = Math.max(0.8, 1.8 * fade);
      ctx.stroke();

      // 3. Three erupting plasma droplets at impactAngle and ±0.42 rad
      for (let d = -1; d <= 1; d++) {
        const dAng = flare.impactAngle + d * 0.42;
        const dDist =
          parent.radius + (d === 0 ? 14 : 10) + prog * (d === 0 ? 28 : 22);
        const dx = Math.cos(dAng) * dDist;
        const dy = Math.sin(dAng) * dDist;
        const dr = (d === 0 ? 2.4 : 1.8) * Math.max(0.35, fade);

        ctx.beginPath();
        ctx.arc(dx, dy, dr + 2.0, 0, Math.PI * 2);
        ctx.fillStyle = flare.ringColor;
        ctx.globalAlpha = 0.3 * fade;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(dx, dy, dr, 0, Math.PI * 2);
        ctx.fillStyle = "#fef08a";
        ctx.globalAlpha = 0.92 * fade;
        ctx.fill();
      }

      ctx.restore();
    }
  }

  /**
   * Antigravity 3D Tilted Accretion Disk / Gravity Ring (BACK HALF).
   */
  private drawAccretionRingBack(
    ctx: CanvasRenderingContext2D,
    r: number,
    isWorking: boolean,
    isAsleep = false
  ): void {
    const rx = Math.min(r * 1.58, r + 17);
    const ry = rx * 0.28;
    const tilt = -0.28; // -16 deg

    ctx.save();
    ctx.rotate(tilt);
    if (isAsleep) {
      ctx.globalAlpha = 0.42;
    }

    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, Math.PI, Math.PI * 2);
    ctx.strokeStyle = isWorking ? "rgba(149, 128, 255, 0.75)" : "rgba(149, 128, 255, 0.45)";
    ctx.lineWidth = 2.2;
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(0, 0, rx + 1.5, ry + 0.9, 0, Math.PI, Math.PI * 2);
    ctx.strokeStyle = "rgba(196, 181, 253, 0.22)";
    ctx.lineWidth = 1.0;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Antigravity 3D Tilted Accretion Disk / Gravity Ring (FRONT HALF).
   */
  private drawAccretionRingFront(
    ctx: CanvasRenderingContext2D,
    r: number,
    isWorking: boolean,
    isAsleep = false
  ): void {
    const rx = Math.min(r * 1.58, r + 17);
    const ry = rx * 0.28;
    const tilt = -0.28;

    ctx.save();
    ctx.rotate(tilt);
    if (isAsleep) {
      ctx.globalAlpha = 0.42;
    }

    // Soft outer glow arc first (zero shadowBlur)
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI);
    ctx.strokeStyle = "rgba(149, 128, 255, 0.28)";
    ctx.lineWidth = 5.5;
    ctx.stroke();

    ctx.strokeStyle = isWorking ? "#c4b5fd" : "rgba(196, 181, 253, 0.88)";
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // Bright specular glint in front of the body
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, Math.PI * 0.22, Math.PI * 0.78);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 3.6;
    ctx.stroke();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Celestial Signatures for the 4 Harnesses:
   * - Claude: Solar Sunburst Crown
   * - Codex: Twin Pulsar Polar Jets
   * - Antigravity: Accretion Disk / Magnetar
   * - Strata: JWST Crystalline Diffraction Spikes
   */
  private drawCelestialSignature(
    ctx: CanvasRenderingContext2D,
    harness: HarnessKind,
    r: number,
    time: number,
    isWorking: boolean,
    isRoot: boolean,
    isIdle: boolean,
    isAsleep = false
  ): void {
    const s = isRoot ? 1.0 : 0.75;
    ctx.save();

    if (harness === "claude") {
      // 1. Claude: Solar Sunburst Crown
      if (isWorking && !isIdle) {
        // Alternating golden-coral sun rays around the rim
        const rayCount = 12;
        for (let i = 0; i < rayCount; i++) {
          const ang = (i / rayCount) * Math.PI * 2 + time * 0.07;
          const rayLen = (i % 2 === 0 ? 5.8 : 3.4) * s * (1 + 0.12 * Math.sin(time * 0.85 + i));
          const x0 = Math.cos(ang) * (r + 1);
          const y0 = Math.sin(ang) * (r + 1);
          const x1 = Math.cos(ang) * (r + 1 + rayLen);
          const y1 = Math.sin(ang) * (r + 1 + rayLen);

          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.strokeStyle = i % 2 === 0 ? "#ffb499" : "#f2845c";
          ctx.lineWidth = 1.3 * s;
          ctx.stroke();
        }
      }

      // Floating 4-point solar flare star (✦) above north pole
      const bob = Math.sin(time * 0.62) * 0.9;
      const cy = -r - 7 * s + bob;
      const R = 5.8 * s;
      const waist = 1.3 * s;

      if (!isAsleep && !isIdle) {
        ctx.beginPath();
        ctx.arc(0, cy, R * 1.25, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(242, 132, 92, 0.24)";
        ctx.fill();
      }

      ctx.beginPath();
      ctx.moveTo(0, cy - R);
      ctx.quadraticCurveTo(waist * 0.4, cy - waist * 0.4, R * 0.85, cy);
      ctx.quadraticCurveTo(waist * 0.4, cy + waist * 0.4, 0, cy + R * 0.85);
      ctx.quadraticCurveTo(-waist * 0.4, cy + waist * 0.4, -R * 0.85, cy);
      ctx.quadraticCurveTo(-waist * 0.4, cy - waist * 0.4, 0, cy - R);
      ctx.closePath();

      if (isAsleep) {
        ctx.fillStyle = "rgba(242, 132, 92, 0.4)";
        ctx.fill();
      } else if (isIdle) {
        ctx.fillStyle = "rgba(148, 163, 184, 0.4)";
        ctx.fill();
      } else {
        ctx.fillStyle = "#fff5eb";
        ctx.fill();
        ctx.strokeStyle = "#f2845c";
        ctx.lineWidth = 1.0 * s;
        ctx.stroke();
      }
    } else if (harness === "codex") {
      // 2. Codex: Twin Pulsar Polar Jets (tilted 18° axis)
      const tiltAng = 18 * (Math.PI / 180);
      const angles = [-Math.PI * 0.5 + tiltAng, Math.PI * 0.5 + tiltAng];

      for (let pIdx = 0; pIdx < angles.length; pIdx++) {
        const ang = angles[pIdx];
        const bx = Math.cos(ang) * r;
        const by = Math.sin(ang) * r;

        if (isIdle) {
          // Stubby dim pole caps
          ctx.beginPath();
          ctx.arc(bx, by, 1.8 * s, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(61, 214, 163, 0.35)";
          ctx.fill();
        } else {
          // Luminous tapered polar jet beam (zero-blur layered under-glow + core gradient)
          const jetLen = (isWorking ? 18 : 12) * s * (1 + 0.10 * Math.sin(time * 1.05 + pIdx * 2));
          const tx = Math.cos(ang) * (r + jetLen);
          const ty = Math.sin(ang) * (r + jetLen);

          const perp = ang + Math.PI * 0.5;
          const cosP = Math.cos(perp);
          const sinP = Math.sin(perp);
          const w0 = 1.8 * s;
          const w1 = 3.6 * s;

          // Subtle wider outer jet halo
          const gw0 = w0 * 1.65;
          const gw1 = w1 * 1.45;
          ctx.save();
          ctx.globalAlpha = 0.22;
          ctx.beginPath();
          ctx.moveTo(bx + cosP * gw0, by + sinP * gw0);
          ctx.lineTo(tx + cosP * gw1, ty + sinP * gw1);
          ctx.lineTo(tx - cosP * gw1, ty - sinP * gw1);
          ctx.lineTo(bx - cosP * gw0, by - sinP * gw0);
          ctx.closePath();
          ctx.fillStyle = "#3dd6a3";
          ctx.fill();
          ctx.restore();

          const gradJet = ctx.createLinearGradient(bx, by, tx, ty);
          gradJet.addColorStop(0, "#ffffff");
          gradJet.addColorStop(0.3, "#86efac");
          gradJet.addColorStop(0.85, "#3dd6a3");
          gradJet.addColorStop(1, "rgba(61, 214, 163, 0)");

          ctx.beginPath();
          ctx.moveTo(bx + cosP * w0, by + sinP * w0);
          ctx.lineTo(tx + cosP * w1, ty + sinP * w1);
          ctx.lineTo(tx - cosP * w1, ty - sinP * w1);
          ctx.lineTo(bx - cosP * w0, by - sinP * w0);
          ctx.closePath();
          ctx.fillStyle = gradJet;
          ctx.fill();
        }
      }
    } else if (harness === "antigravity") {
      // 3. Antigravity: Accretion Disk is handled via drawAccretionRingBack / drawAccretionRingFront
    } else if (harness === "strata") {
      // 4. Strata: JWST Crystalline Diffraction Spikes
      if (!isIdle || isAsleep) {
        ctx.save();
        const baseAlpha = isAsleep ? 0.35 : 1.0;

        // 4-point tapered starlight diffraction needles (anchored at star rim)
        const spikeLen = r * 1.95 * s;
        const dirs = [
          { dx: 1, dy: 0 },
          { dx: -1, dy: 0 },
          { dx: 0, dy: 1 },
          { dx: 0, dy: -1 },
        ];

        for (const dir of dirs) {
          const bx = dir.dx * r;
          const by = dir.dy * r;
          const ex = dir.dx * spikeLen;
          const ey = dir.dy * spikeLen;
          const px = -dir.dy * (1.6 * s);
          const py = dir.dx * (1.6 * s);

          // Subtle wider under-fill halo
          ctx.globalAlpha = baseAlpha * 0.22;
          ctx.beginPath();
          ctx.moveTo(bx + px * 1.8, by + py * 1.8);
          ctx.lineTo(ex, ey);
          ctx.lineTo(bx - px * 1.8, by - py * 1.8);
          ctx.closePath();
          ctx.fillStyle = "#38bdf8";
          ctx.fill();

          ctx.globalAlpha = baseAlpha;
          const gradSpike = ctx.createLinearGradient(bx, by, ex, ey);
          gradSpike.addColorStop(0, "#ffffff");
          gradSpike.addColorStop(0.45, "#bae6fd");
          gradSpike.addColorStop(1, "rgba(56, 189, 248, 0)");

          ctx.beginPath();
          ctx.moveTo(bx + px, by + py);
          ctx.lineTo(ex, ey);
          ctx.lineTo(bx - px, by - py);
          ctx.closePath();
          ctx.fillStyle = gradSpike;
          ctx.fill();
        }

        // Tiny 45° cross glints (anchored at star rim)
        const glintLen = r * 1.35 * s;
        const glintDirs = [
          { dx: 0.707, dy: 0.707 },
          { dx: -0.707, dy: 0.707 },
          { dx: 0.707, dy: -0.707 },
          { dx: -0.707, dy: -0.707 },
        ];
        ctx.globalAlpha = baseAlpha;
        ctx.beginPath();
        for (const gd of glintDirs) {
          const gbx = gd.dx * r;
          const gby = gd.dy * r;
          ctx.moveTo(gbx, gby);
          ctx.lineTo(gd.dx * glintLen, gd.dy * glintLen);
        }
        ctx.strokeStyle = "rgba(186, 230, 253, 0.45)";
        ctx.lineWidth = 0.9 * s;
        ctx.stroke();

        ctx.restore();
      }

      // Floating icy prism gem at the crown
      const bob = Math.sin(time * 0.58) * 0.8;
      const cy = -r - 7.5 * s + bob;
      const dw = 5.2 * s;
      const dh = 6.2 * s;

      if (!isAsleep && !isIdle) {
        ctx.beginPath();
        ctx.arc(0, cy, dh * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(56, 189, 248, 0.24)";
        ctx.fill();
      }

      ctx.beginPath();
      ctx.moveTo(0, cy - dh * 0.5);
      ctx.lineTo(dw * 0.5, cy);
      ctx.lineTo(0, cy + dh * 0.5);
      ctx.lineTo(-dw * 0.5, cy);
      ctx.closePath();

      if (isAsleep) {
        ctx.fillStyle = "rgba(56, 189, 248, 0.35)";
        ctx.fill();
      } else if (isIdle) {
        ctx.fillStyle = "rgba(148, 163, 184, 0.35)";
        ctx.fill();
      } else {
        ctx.fillStyle = "#bae6fd";
        ctx.fill();
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 1.0 * s;
        ctx.stroke();

        // Lower stacked chevron
        const chY = cy + 4.8 * s;
        ctx.beginPath();
        ctx.moveTo(-dw * 0.48, chY - 1.4 * s);
        ctx.lineTo(0, chY + 1.8 * s);
        ctx.lineTo(dw * 0.48, chY - 1.4 * s);
        ctx.strokeStyle = "#0284c7";
        ctx.lineWidth = 1.3 * s;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Pearlescent Mini-Moons with a delicate shadow crescent for attached skills.
   */
  private drawSkillMoons(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    r: number,
    time: number
  ): void {
    const snap = node.data;
    const orbitR = r + (snap.isSubagent ? 8.5 : 12);
    const maxMoons = Math.min(3, snap.skills.length);
    const moonR = 3.2;

    for (let i = 0; i < maxMoons; i++) {
      const mAngle = time * 0.14 + node.orbitPhase + (i / maxMoons) * Math.PI * 2;
      const mx = Math.cos(mAngle) * orbitR;
      const my = Math.sin(mAngle) * orbitR;

      ctx.save();
      ctx.translate(mx, my);

      // Translucent outer moon halo (zero shadowBlur)
      ctx.beginPath();
      ctx.arc(0, 0, moonR + 2.4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(192, 132, 252, 0.26)";
      ctx.fill();

      // Pearlescent gradient
      const gradMoon = ctx.createRadialGradient(-0.8, -0.8, 0.4, 0, 0, moonR);
      gradMoon.addColorStop(0, "#ffffff");
      gradMoon.addColorStop(0.65, "#f1f5f9");
      gradMoon.addColorStop(1, "#cbd5e1");

      ctx.beginPath();
      ctx.arc(0, 0, moonR, 0, Math.PI * 2);
      ctx.fillStyle = gradMoon;
      ctx.fill();

      // Shadow crescent on side away from center
      ctx.beginPath();
      ctx.arc(0, 0, moonR, mAngle - Math.PI * 0.5, mAngle + Math.PI * 0.5);
      ctx.fillStyle = "rgba(15, 23, 42, 0.45)";
      ctx.fill();

      ctx.strokeStyle = "rgba(148, 163, 184, 0.5)";
      ctx.lineWidth = 0.7;
      ctx.stroke();

      ctx.restore();
    }
  }

  /**
   * Cozy Minimalist Expressive Eyes:
   * - Active: • • with tiny white catchlights
   * - Sleeping (idle or blinking): ◡ ◡ with contrast backing
   */
  private drawCuteEyes(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    r: number,
    isSleeping: boolean,
    isWorking: boolean,
    breathOffset = 0
  ): void {
    const eyeSpread = r * 0.31;
    const eyeY = -r * 0.06 + breathOffset;
    const eyeR = Math.max(1.6, r * 0.105);
    const isBlinking = node.blinkTimer < 0;

    ctx.save();
    ctx.lineCap = "round";

    if (isSleeping || isBlinking) {
      // Cozy sleeping / blinking curved eyes: ◡ ◡
      for (const dir of [-1, 1]) {
        // Subtle light under-highlight for clear readability across all dimmed stars
        ctx.beginPath();
        ctx.arc(dir * eyeSpread, eyeY + 0.5, eyeR * 1.05, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
        ctx.lineWidth = 2.4;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(dir * eyeSpread, eyeY, eyeR * 1.05, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.strokeStyle = "#0b1120";
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    } else {
      const lookX = isWorking ? Math.sin(node.orbitPhase + this.simTime * 0.65) * 1.1 : 0;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(dir * eyeSpread + lookX, eyeY, eyeR, 0, Math.PI * 2);
        ctx.fillStyle = "#0f172a";
        ctx.fill();

        // Tiny white specular catchlight
        ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
        ctx.beginPath();
        ctx.arc(dir * eyeSpread + lookX - eyeR * 0.3, eyeY - eyeR * 0.3, eyeR * 0.36, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawDarkCrater(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    cr: number
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, cr, 0, Math.PI * 2);
    ctx.fillStyle = "#0b1120";
    ctx.fill();
    ctx.strokeStyle = "rgba(71, 85, 105, 0.4)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();
  }

  private drawSelectionHalo(
    ctx: CanvasRenderingContext2D,
    r: number,
    palette: { ring: string; glow: string },
    time: number
  ): void {
    const haloPulse = 1 + Math.sin(time * 0.85) * 0.035;
    const haloR = (r + 7.5) * haloPulse;

    ctx.save();
    // Ambient glow
    ctx.beginPath();
    ctx.arc(0, 0, haloR + 3, 0, Math.PI * 2);
    ctx.fillStyle = palette.glow;
    ctx.fill();

    // Outer animated dashed halo ring
    ctx.beginPath();
    ctx.arc(0, 0, haloR, 0, Math.PI * 2);
    ctx.strokeStyle = palette.ring;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.lineDashOffset = -time * 3.2;
    ctx.stroke();

    // Inner crisp white ring
    ctx.beginPath();
    ctx.arc(0, 0, r + 3.8, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.0;
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Caption pill below node.
   */
  private drawCaption(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    r: number,
    isRoot: boolean,
    isIdle: boolean,
    palette: { ring: string }
  ): void {
    const snap = node.data;
    ctx.save();
    ctx.translate(node.x, node.y);

    if (isRoot) {
      const labelY = r + 13;
      const rawTitle = (snap.project || snap.label).trim();
      const fullTitle = rawTitle.length > 96 ? rawTitle.slice(0, 95) + "…" : rawTitle;

      const font = "600 10.5px 'Segoe UI', system-ui, sans-serif";
      const tw = this.measureTextCached(ctx, font, fullTitle);
      const dotR = 2.6;
      const dotPad = 7;
      const dotGap = 5;
      const pw = tw + dotPad * 2 + dotR * 2 + dotGap;
      const ph = 15;
      node.captionHalfW = pw * 0.5 + 3;

      ctx.beginPath();
      roundRect(ctx, -pw * 0.5, labelY - ph * 0.5, pw, ph, 6);
      ctx.fillStyle = node.isHovered ? "rgba(15, 23, 42, 0.95)" : "rgba(13, 19, 33, 0.88)";
      ctx.fill();
      ctx.strokeStyle = node.isHovered ? palette.ring : "rgba(148, 163, 184, 0.22)";
      ctx.lineWidth = node.isHovered ? 1.0 : 0.8;
      ctx.stroke();

      // Crisp harness identity circle dot at the left of project name
      const dotX = -pw * 0.5 + dotPad + dotR;
      ctx.beginPath();
      ctx.arc(dotX, labelY, dotR, 0, Math.PI * 2);
      ctx.fillStyle = HARNESS_COLORS[snap.harness].core;
      ctx.fill();

      // Project title text
      ctx.fillStyle = isIdle ? "rgba(203, 213, 225, 0.68)" : "rgba(248, 250, 252, 0.94)";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(fullTitle, dotX + dotR + dotGap, labelY + 0.5);
    } else if (
      node.isHovered ||
      this.selectedNodeId === snap.id ||
      (snap.status === "tool_running" && node.siblingCount <= 5)
    ) {
      const labelY = r + 11;
      const rawLabel = snap.label.trim();
      const fullSub = rawLabel.length > 110 ? rawLabel.slice(0, 109) + "…" : rawLabel;

      const font = "500 10px 'Segoe UI', system-ui, sans-serif";
      const tw = this.measureTextCached(ctx, font, fullSub);
      const pw = tw + 12;
      const ph = 15;
      node.captionHalfW = pw * 0.5 + 3;

      ctx.beginPath();
      roundRect(ctx, -pw * 0.5, labelY - ph * 0.5, pw, ph, 5);
      ctx.fillStyle = "rgba(15, 23, 42, 0.94)";
      ctx.fill();
      ctx.strokeStyle = node.isHovered || this.selectedNodeId === snap.id ? palette.ring : "rgba(148, 163, 184, 0.32)";
      ctx.lineWidth = node.isHovered || this.selectedNodeId === snap.id ? 1.0 : 0.8;
      ctx.stroke();

      ctx.fillStyle = "#f8fafc";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(fullSub, 0, labelY + 0.5);
    } else {
      node.captionHalfW = undefined;
    }

    ctx.restore();
  }

  /**
   * Floating Tool / Skill Micro-Bubbles
   */
  private drawMicroBubbles(ctx: CanvasRenderingContext2D, engine: SpringGraphEngine): void {
    for (const p of engine.particles) {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      const font = "600 9.5px 'Segoe UI', system-ui, sans-serif";
      const tw = this.measureTextCached(ctx, font, p.label);
      const pw = tw + 10;
      const ph = 15;
      ctx.beginPath();
      roundRect(ctx, p.x - pw * 0.5, p.y - ph * 0.5, pw, ph, 7.5);
      ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
      ctx.fill();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = p.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(p.label, p.x, p.y + 0.5);
      ctx.restore();
    }
  }

  /**
   * Subtle golden 'AWAITING YOU' spotlight horizon stage divider
   */
  private drawSpotlightHorizon(
    ctx: CanvasRenderingContext2D,
    engine: SpringGraphEngine,
    width: number
  ): void {
    if (engine.spotlightHorizonY === null) return;
    const bbox = engine.getBoundingBox();
    const minX = bbox ? bbox.minX : 0;
    const maxX = bbox ? bbox.maxX : width;
    const spanLeft = minX - 90;
    const spanRight = maxX + 90;
    const lineY = engine.spotlightHorizonY;
    const centerX = (spanLeft + spanRight) * 0.5;

    ctx.save();

    // 1. Soft warm linear glow band above the line
    const glowH = 38;
    const glowGrad = ctx.createLinearGradient(0, lineY, 0, lineY - glowH);
    glowGrad.addColorStop(0, "rgba(251, 191, 36, 0.055)");
    glowGrad.addColorStop(1, "rgba(251, 191, 36, 0)");
    ctx.fillStyle = glowGrad;
    ctx.fillRect(spanLeft, lineY - glowH, spanRight - spanLeft, glowH);

    // 2. Delicate dashed amber divider line
    const lineGrad = ctx.createLinearGradient(spanLeft, 0, spanRight, 0);
    lineGrad.addColorStop(0, "rgba(251, 191, 36, 0)");
    lineGrad.addColorStop(0.06, "rgba(251, 191, 36, 0.28)");
    lineGrad.addColorStop(0.94, "rgba(251, 191, 36, 0.28)");
    lineGrad.addColorStop(1, "rgba(251, 191, 36, 0)");

    ctx.beginPath();
    ctx.moveTo(spanLeft, lineY);
    ctx.lineTo(spanRight, lineY);
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 1.1;
    ctx.setLineDash([5, 6]);
    ctx.stroke();

    // 3. Crisp micro-pill centered on the line: ⚡ AWAITING YOU
    const pillText = "⚡ AWAITING YOU";
    const font = "700 9px 'Segoe UI', system-ui, sans-serif";
    const tw = this.measureTextCached(ctx, font, pillText);
    const pw = tw + 16;
    const ph = 16;
    const px = centerX - pw * 0.5;
    const py = lineY - ph * 0.5;

    ctx.beginPath();
    roundRect(ctx, px, py, pw, ph, 8);
    ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
    ctx.fill();
    ctx.strokeStyle = "rgba(251, 191, 36, 0.35)";
    ctx.lineWidth = 1.0;
    ctx.stroke();

    ctx.fillStyle = "#fde68a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(pillText, centerX, lineY + 0.5);

    ctx.restore();
  }

  /**
   * Sweeping vertical golden lighthouse beacon beam & rising signal motes
   */
  private drawLighthouseBeacon(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    r: number,
    time: number
  ): void {
    const sweep = Math.sin(time * 0.24 + node.orbitPhase) * 0.16;

    ctx.save();
    ctx.rotate(sweep);

    // 1. Upward tapered luminous searchlight beam
    const upH = Math.max(130, r * 4.2);
    const baseHalfW = (r * 0.55) * 0.5;
    const topHalfW = (r * 2.1) * 0.5;

    const upGrad = ctx.createLinearGradient(0, 0, 0, -upH);
    upGrad.addColorStop(0, "rgba(254, 240, 138, 0.42)");
    upGrad.addColorStop(0.45, "rgba(251, 191, 36, 0.16)");
    upGrad.addColorStop(1, "rgba(245, 158, 11, 0)");

    ctx.beginPath();
    ctx.moveTo(-baseHalfW, 0);
    ctx.lineTo(-topHalfW, -upH);
    ctx.lineTo(topHalfW, -upH);
    ctx.lineTo(baseHalfW, 0);
    ctx.closePath();
    ctx.fillStyle = upGrad;
    ctx.fill();

    // Core beam spine for authentic searchlight intensity
    const coreGrad = ctx.createLinearGradient(0, 0, 0, -upH * 0.85);
    coreGrad.addColorStop(0, "rgba(255, 255, 255, 0.55)");
    coreGrad.addColorStop(0.35, "rgba(254, 240, 138, 0.22)");
    coreGrad.addColorStop(1, "rgba(251, 191, 36, 0)");

    ctx.beginPath();
    ctx.moveTo(-baseHalfW * 0.35, 0);
    ctx.lineTo(-topHalfW * 0.25, -upH * 0.85);
    ctx.lineTo(topHalfW * 0.25, -upH * 0.85);
    ctx.lineTo(baseHalfW * 0.35, 0);
    ctx.closePath();
    ctx.fillStyle = coreGrad;
    ctx.fill();

    // 2. Shorter softer counter-beam downward
    const downH = Math.max(65, r * 2.1);
    const downHalfW = (r * 1.1) * 0.5;
    const downGrad = ctx.createLinearGradient(0, 0, 0, downH);
    downGrad.addColorStop(0, "rgba(254, 240, 138, 0.28)");
    downGrad.addColorStop(0.5, "rgba(251, 191, 36, 0.08)");
    downGrad.addColorStop(1, "rgba(245, 158, 11, 0)");

    ctx.beginPath();
    ctx.moveTo(-baseHalfW, 0);
    ctx.lineTo(-downHalfW, downH);
    ctx.lineTo(downHalfW, downH);
    ctx.lineTo(baseHalfW, 0);
    ctx.closePath();
    ctx.fillStyle = downGrad;
    ctx.fill();

    // 3. 4 rising golden signal motes (zero shadowBlur layered halo + core)
    for (let i = 0; i < 4; i++) {
      const prog = (time * 0.12 + i * 0.25) % 1;
      const my = -r - prog * 95;
      const mx = Math.sin(prog * Math.PI * 2 + i * 1.5) * (r * 0.22);
      const alpha = Math.sin(prog * Math.PI) * 0.85;
      if (alpha > 0.02) {
        const mr = 1.4 + (1 - prog) * 0.8;
        ctx.beginPath();
        ctx.arc(mx, my, mr + 2.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(251, 191, 36, ${(alpha * 0.26).toFixed(3)})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(mx, my, mr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(254, 240, 138, ${alpha.toFixed(3)})`;
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /**
   * Clickable Speech-Bubble Callout above waiting stars
   */
  private drawWaitingCallout(
    ctx: CanvasRenderingContext2D,
    node: PhysicsNode,
    r: number
  ): void {
    const snap = node.data;
    const bubbleCenterY = node.y - r - 30;
    const ph = 24;

    const reason = snap.waitingReason || "turn_complete";
    let iconChar = "✓";
    let badgeBg = "#fbbf24";
    let badgeBorder = "rgba(251, 191, 36, 0.78)";
    let badgeTextColor = "#0f172a";

    if (reason === "question") {
      iconChar = "?";
      badgeBg = "#f59e0b";
      badgeBorder = "#fbbf24";
      badgeTextColor = "#0f172a";
    } else if (reason === "plan_review") {
      iconChar = "◈";
      badgeBg = "#c084fc";
      badgeBorder = "#fcd34d";
      badgeTextColor = "#0f172a";
    }

    const defaultFallback =
      reason === "question"
        ? "Question waiting"
        : reason === "plan_review"
          ? "Plan review"
          : "Turn complete";
    const rawText = snap.waitingPrompt || defaultFallback;
    const displayText = rawText.length > 42 ? rawText.slice(0, 41) + "…" : rawText;

    ctx.save();
    const labelFont = "500 11px 'Segoe UI', system-ui, sans-serif";
    const textW = this.measureTextCached(ctx, labelFont, displayText);

    // Layout: 7px left pad + 15px badge + 6px gap + textW + 6px gap + 11px arrow + 8px right pad
    const pw = Math.max(140, Math.min(270, Math.round(textW + 53)));
    const px = node.x - pw * 0.5;
    const py = bubbleCenterY - ph * 0.5;

    const rad = 11;
    const right = px + pw;
    const bottom = py + ph;

    ctx.beginPath();
    ctx.moveTo(px + rad, py);
    ctx.lineTo(right - rad, py);
    ctx.arcTo(right, py, right, bottom, rad);
    ctx.lineTo(right, bottom - rad);
    ctx.arcTo(right, bottom, px, bottom, rad);

    // Pointer tail pointing down towards star
    ctx.lineTo(node.x + 5, bottom);
    ctx.lineTo(node.x, bottom + 6);
    ctx.lineTo(node.x - 5, bottom);

    ctx.lineTo(px + rad, bottom);
    ctx.arcTo(px, bottom, px, py, rad);
    ctx.lineTo(px, py + rad);
    ctx.arcTo(px, py, right, py, rad);
    ctx.closePath();

    // Soft outer halo stroke (zero shadowBlur)
    ctx.strokeStyle = node.isCalloutHovered
      ? "rgba(251, 191, 36, 0.28)"
      : "rgba(251, 191, 36, 0.16)";
    ctx.lineWidth = node.isCalloutHovered ? 6.5 : 4.5;
    ctx.stroke();

    ctx.fillStyle = node.isCalloutHovered
      ? "rgba(30, 41, 59, 0.98)"
      : "rgba(13, 19, 33, 0.94)";
    ctx.fill();

    ctx.strokeStyle = node.isCalloutHovered
      ? "rgba(251, 191, 36, 0.85)"
      : "rgba(251, 191, 36, 0.45)";
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // Reason Icon Badge
    const badgeCx = px + 15;
    const badgeCy = bubbleCenterY;
    ctx.beginPath();
    ctx.arc(badgeCx, badgeCy, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = badgeBg;
    ctx.fill();
    ctx.strokeStyle = badgeBorder;
    ctx.lineWidth = 1.0;
    ctx.stroke();

    ctx.font = "800 10px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = badgeTextColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(iconChar, badgeCx, badgeCy + 0.5);

    // Text label
    ctx.font = "500 11px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "#f1f5f9";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(displayText, px + 27, bubbleCenterY + 0.5);

    // Jump arrow glyph ↗
    ctx.font = "700 11px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = node.isCalloutHovered ? "#ffffff" : "#fde68a";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("↗", right - 7, bubbleCenterY + 0.5);

    ctx.restore();

    // Store callout rect for exact pixel hit-testing
    node.calloutRect = {
      x: px,
      y: py,
      w: pw,
      h: ph + 6,
    };
  }

  private drawEmptyState(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(226, 232, 240, 0.65)";
    ctx.font = "500 13px 'Segoe UI', system-ui, sans-serif";
    if (this.filterHarness) {
      const harnessName =
        this.filterHarness === "claude"
          ? "Claude"
          : this.filterHarness === "codex"
            ? "Codex"
            : this.filterHarness === "antigravity"
              ? "Antigravity"
              : "Strata";
      ctx.fillText(`No ${harnessName} agents`, w * 0.5, h * 0.48);
    } else {
      ctx.fillText("Quiet space", w * 0.5, h * 0.48);
    }
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
