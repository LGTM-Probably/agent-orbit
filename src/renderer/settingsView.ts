import {
  DEFAULT_ANIMATION_SPEED,
  DrawerSizePreset,
  EdgeSide,
  MAX_ANIMATION_SPEED,
  MIN_ANIMATION_SPEED,
  OrbitBridgeAPI,
  OrbitSettings,
  clampAnimationSpeed,
  formatAnimationSpeedDescriptor,
  getPlatformShortcuts,
} from "../shared/types";

declare global {
  interface Window {
    orbitBridge: OrbitBridgeAPI;
  }
}

interface PreviewStar {
  nx: number;
  ny: number;
  r: number;
  phase: number;
  tint: string;
}

interface PreviewAsteroid {
  orbitR: number;
  baseAngle: number;
  orbitSpeed: number;
  spinSpeed: number;
  radius: number;
  vertices: number[];
}

const PREVIEW_STARS: PreviewStar[] = Array.from({ length: 20 }, (_, i) => {
  const s1 = Math.sin(i * 12.9898 + 1.7) * 43758.5453;
  const s2 = Math.sin(i * 78.233 + 4.1) * 24634.6345;
  const fx = s1 - Math.floor(s1);
  const fy = s2 - Math.floor(s2);
  const tints = ["#e2e8f0", "#cbd5e1", "#bae6fd", "#ddd6fe", "#fde68a"];
  return {
    nx: 0.05 + fx * 0.9,
    ny: 0.06 + fy * 0.88,
    r: 0.55 + (i % 3) * 0.35,
    phase: i * 1.37,
    tint: tints[i % tints.length],
  };
});

const PREVIEW_ASTEROIDS: PreviewAsteroid[] = [
  { orbitR: 51, baseAngle: 0.3, orbitSpeed: 0.16, spinSpeed: 0.42, radius: 2.5, vertices: [0.88, 1.06, 0.92, 1.08, 0.84, 1.02] },
  { orbitR: 56, baseAngle: 1.45, orbitSpeed: 0.13, spinSpeed: -0.34, radius: 3.9, vertices: [1.05, 0.86, 1.08, 0.9, 1.04, 0.85, 0.98] },
  { orbitR: 60, baseAngle: 2.55, orbitSpeed: 0.115, spinSpeed: 0.28, radius: 4.8, vertices: [0.94, 1.08, 0.96, 1.06, 0.88, 1.03, 0.91] },
  { orbitR: 53, baseAngle: 3.65, orbitSpeed: 0.15, spinSpeed: -0.39, radius: 3.1, vertices: [1.04, 0.88, 1.02, 0.86, 1.07, 0.92] },
  { orbitR: 58, baseAngle: 4.72, orbitSpeed: 0.125, spinSpeed: 0.31, radius: 4.3, vertices: [0.9, 1.07, 0.95, 1.05, 0.87, 1.04, 0.93] },
  { orbitR: 62, baseAngle: 5.65, orbitSpeed: 0.105, spinSpeed: -0.26, radius: 2.8, vertices: [1.02, 0.89, 1.06, 0.85, 1.01, 0.9] },
];

const SPEED_PRESETS = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0];

/**
 * Pure zero-shadowBlur miniature cosmic preview renderer for the Settings speed slider.
 */
export function renderSpeedPreviewFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  simTime: number,
  _speed: number
): void {
  ctx.clearRect(0, 0, width, height);

  // 1. Deep cosmic backdrop
  const bg = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    6,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.72
  );
  bg.addColorStop(0, "#131d36");
  bg.addColorStop(0.6, "#0b1222");
  bg.addColorStop(1, "#070b15");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // 2. Twinkling background starfield
  for (let i = 0; i < PREVIEW_STARS.length; i++) {
    const st = PREVIEW_STARS[i];
    const twinkle = 0.32 + 0.38 * (0.5 + 0.5 * Math.sin(simTime * 1.15 + st.phase));
    ctx.globalAlpha = twinkle;
    ctx.fillStyle = st.tint;
    ctx.beginPath();
    ctx.arc(st.nx * width, st.ny * height, st.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const cx = width * 0.5;
  const cy = height * 0.5;
  const scale = Math.min(width / 220, height / 148);
  const planetOrbitR = 34 * scale;

  // 3. Outer Kuiper belt band & inner planetary orbit track
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 56.5 * scale, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
  ctx.lineWidth = 11 * scale;
  ctx.stroke();

  ctx.beginPath();
  ctx.setLineDash([3, 4]);
  ctx.arc(cx, cy, planetOrbitR, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(242, 132, 92, 0.22)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // 4. Outer Kuiper belt tumbling asteroids (turn-scaled sizes)
  for (let i = 0; i < PREVIEW_ASTEROIDS.length; i++) {
    const ast = PREVIEW_ASTEROIDS[i];
    const ang = ast.baseAngle + simTime * ast.orbitSpeed;
    const ax = cx + Math.cos(ang) * ast.orbitR * scale;
    const ay = cy + Math.sin(ang) * ast.orbitR * scale;
    const ar = ast.radius * scale;
    const spin = ast.baseAngle + simTime * ast.spinSpeed;

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(spin);

    ctx.beginPath();
    const nVerts = ast.vertices.length;
    for (let v = 0; v < nVerts; v++) {
      const va = (v / nVerts) * Math.PI * 2;
      const vr = ar * ast.vertices[v];
      const vx = Math.cos(va) * vr;
      const vy = Math.sin(va) * vr;
      if (v === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
    ctx.closePath();

    const rockGrad = ctx.createLinearGradient(-ar, -ar, ar, ar);
    rockGrad.addColorStop(0, "#cbd5e1");
    rockGrad.addColorStop(0.55, "#64748b");
    rockGrad.addColorStop(1, "#334155");
    ctx.fillStyle = rockGrad;
    ctx.fill();
    ctx.strokeStyle = "rgba(226, 232, 240, 0.36)";
    ctx.lineWidth = 0.75;
    ctx.stroke();

    if (ar >= 3.2) {
      ctx.beginPath();
      ctx.arc(ar * 0.22, ar * 0.16, ar * 0.24, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(15, 23, 42, 0.45)";
      ctx.fill();
    }
    ctx.restore();
  }

  // 5. Planet coordinates + tether + live comet packet
  const planetAngle = -0.55 + simTime * 0.52;
  const px = cx + Math.cos(planetAngle) * planetOrbitR;
  const py = cy + Math.sin(planetAngle) * planetOrbitR;

  ctx.save();
  ctx.beginPath();
  ctx.setLineDash([2.5, 3]);
  ctx.lineDashOffset = -simTime * 10;
  ctx.moveTo(cx, cy);
  ctx.lineTo(px, py);
  ctx.strokeStyle = "rgba(242, 132, 92, 0.45)";
  ctx.lineWidth = 1.15;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Gliding comet packet along tether
  const pktT = (simTime * 0.42) % 1;
  for (let trail = 2; trail >= 0; trail--) {
    const tPos = Math.max(0, pktT - trail * 0.055);
    const kx = cx + (px - cx) * tPos;
    const ky = cy + (py - cy) * tPos;
    const kr = (2.2 - trail * 0.55) * scale;
    ctx.beginPath();
    ctx.arc(kx, ky, Math.max(0.7, kr), 0, Math.PI * 2);
    ctx.fillStyle = trail === 0 ? "#fde68a" : `rgba(251, 146, 60, ${0.48 - trail * 0.16})`;
    ctx.fill();
  }

  // 6. Central Star corona + rays + sphere + cute blinking eyes
  const starR = 14.5 * scale;
  const pulse = 1 + 0.045 * Math.sin(simTime * 1.9);
  const coronaR = starR * 2.35 * pulse;

  const corona = ctx.createRadialGradient(cx, cy, starR * 0.5, cx, cy, coronaR);
  corona.addColorStop(0, "rgba(242, 132, 92, 0.42)");
  corona.addColorStop(0.5, "rgba(242, 132, 92, 0.14)");
  corona.addColorStop(1, "rgba(242, 132, 92, 0)");
  ctx.fillStyle = corona;
  ctx.beginPath();
  ctx.arc(cx, cy, coronaR, 0, Math.PI * 2);
  ctx.fill();

  // Subtle rotating corona ring
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(simTime * 0.22);
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.arc(0, 0, starR + 3.2 * scale, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(253, 186, 140, 0.55)";
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Star sphere
  const starGrad = ctx.createRadialGradient(
    cx - starR * 0.32,
    cy - starR * 0.32,
    starR * 0.12,
    cx,
    cy,
    starR
  );
  starGrad.addColorStop(0, "#ffe4d6");
  starGrad.addColorStop(0.45, "#f2845c");
  starGrad.addColorStop(1, "#9a3412");
  ctx.beginPath();
  ctx.arc(cx, cy, starR, 0, Math.PI * 2);
  ctx.fillStyle = starGrad;
  ctx.fill();

  // Star eyes
  const isBlinking = simTime % 4.6 > 4.42;
  const eyeSpread = starR * 0.31;
  const eyeY = cy - starR * 0.05;
  const eyeR = Math.max(1.3, starR * 0.115);
  const lookX = Math.sin(simTime * 0.85) * 0.9 * scale;

  ctx.save();
  ctx.lineCap = "round";
  if (isBlinking) {
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx + dir * eyeSpread, eyeY, eyeR * 1.05, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.strokeStyle = "#0b1120";
      ctx.lineWidth = 1.35;
      ctx.stroke();
    }
  } else {
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx + dir * eyeSpread + lookX, eyeY, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = "#0f172a";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(
        cx + dir * eyeSpread + lookX - eyeR * 0.28,
        eyeY - eyeR * 0.28,
        eyeR * 0.36,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fill();
    }
  }
  ctx.restore();

  // 7. Orbiting Ringed Exoplanet + Tiny Probe Moon
  const planetR = 6.2 * scale;
  const planetHalo = ctx.createRadialGradient(px, py, planetR * 0.4, px, py, planetR * 2.1);
  planetHalo.addColorStop(0, "rgba(149, 128, 255, 0.34)");
  planetHalo.addColorStop(1, "rgba(149, 128, 255, 0)");
  ctx.fillStyle = planetHalo;
  ctx.beginPath();
  ctx.arc(px, py, planetR * 2.1, 0, Math.PI * 2);
  ctx.fill();

  const planetGrad = ctx.createRadialGradient(
    px - planetR * 0.3,
    py - planetR * 0.3,
    planetR * 0.12,
    px,
    py,
    planetR
  );
  planetGrad.addColorStop(0, "#ddd6fe");
  planetGrad.addColorStop(0.55, "#8b5cf6");
  planetGrad.addColorStop(1, "#3b0764");
  ctx.beginPath();
  ctx.arc(px, py, planetR, 0, Math.PI * 2);
  ctx.fillStyle = planetGrad;
  ctx.fill();

  // Tilted planetary ring arc
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-0.38);
  ctx.beginPath();
  ctx.ellipse(0, 0, planetR * 1.65, planetR * 0.52, 0, -0.15, Math.PI + 0.15);
  ctx.strokeStyle = "rgba(196, 181, 253, 0.72)";
  ctx.lineWidth = 1.25;
  ctx.stroke();
  ctx.restore();

  // Orbiting tool probe moon around planet
  const moonAng = simTime * 1.85;
  const moonOrbit = planetR + 5.2 * scale;
  const mx = px + Math.cos(moonAng) * moonOrbit;
  const my = py + Math.sin(moonAng) * moonOrbit;
  ctx.beginPath();
  ctx.arc(mx, my, 1.85 * scale, 0, Math.PI * 2);
  ctx.fillStyle = "#3dd6a3";
  ctx.fill();
}

export async function initSettingsView(container: HTMLElement): Promise<void> {
  const detectFallbackPlatform = (): string => {
    if (typeof navigator !== "undefined") {
      const navInfo = navigator.platform || navigator.userAgent || "";
      if (/Mac|iPhone|iPad/i.test(navInfo)) {
        return "darwin";
      }
    }
    return "win32";
  };
  let currentPlatform = detectFallbackPlatform();
  container.dataset.platform = currentPlatform;
  document.documentElement.dataset.platform = currentPlatform;

  container.innerHTML = `
    <header class="settings-titlebar">
      <div class="settings-titlebar-left">
        <span class="brand-dot"></span>
        <span class="settings-window-title">Settings</span>
        <span class="settings-window-sub">Agent Orbit</span>
      </div>
    </header>

    <div class="settings-layout">
      <nav class="settings-sidebar" aria-label="Settings sections">
        <button class="settings-nav-item active" data-target="sec-motion" type="button">
          <span class="settings-nav-icon">✦</span>
          <span>Motion &amp; Visuals</span>
        </button>
        <button class="settings-nav-item" data-target="sec-window" type="button">
          <span class="settings-nav-icon">❐</span>
          <span>Window &amp; Dock</span>
        </button>
        <button class="settings-nav-item" data-target="sec-system" type="button">
          <span class="settings-nav-icon">⚙</span>
          <span>System &amp; Alerts</span>
        </button>
      </nav>

      <div class="settings-content" id="settings-scroll-pane">
        <!-- SECTION 1: MOTION & VISUALS -->
        <section class="settings-section" id="sec-motion">
          <h2 class="settings-section-heading">Motion &amp; Visuals</h2>

          <div class="settings-card speed-feature-card">
            <div class="speed-controls-col">
              <div class="speed-header-row">
                <div class="settings-row-title">Animation Speed</div>
                <div class="speed-readout-group">
                  <span class="speed-value-pill" id="speed-value-pill">1.00× · Normal</span>
                  <button class="settings-mini-btn hidden" id="btn-speed-reset" type="button" title="Reset to 1.0×">Reset</button>
                </div>
              </div>
              <p class="settings-row-desc">
                Adjusts orbital velocity, gravitational infall, asteroid spin, and tether pulses.
              </p>

              <div class="speed-slider-wrap">
                <span class="speed-bound-lbl">0.1×</span>
                <input
                  id="settings-speed-slider"
                  class="settings-range"
                  type="range"
                  min="${MIN_ANIMATION_SPEED}"
                  max="${MAX_ANIMATION_SPEED}"
                  step="0.05"
                  value="${DEFAULT_ANIMATION_SPEED}"
                  aria-label="Animation speed"
                />
                <span class="speed-bound-lbl">3.0×</span>
              </div>

              <div class="speed-presets-row" id="speed-presets-row">
                ${SPEED_PRESETS.map(
                  p =>
                    `<button class="speed-preset-chip" data-speed="${p}" type="button">${p % 1 === 0 ? p.toFixed(1) : p}×</button>`
                ).join("")}
              </div>
            </div>

            <div class="speed-preview-col">
              <div class="speed-preview-frame">
                <canvas id="settings-speed-canvas"></canvas>
                <span class="speed-preview-tag" id="speed-preview-tag">Live 1.00×</span>
              </div>
            </div>
          </div>
        </section>

        <!-- SECTION 2: WINDOW & DOCK -->
        <section class="settings-section" id="sec-window">
          <h2 class="settings-section-heading">Window &amp; Dock</h2>

          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-title">Display Mode</div>
                <div class="settings-row-desc">Run as a standard desktop window or a tuckable screen-edge drawer.</div>
              </div>
              <div class="segmented-group" id="seg-view-mode">
                <button class="seg-btn" data-mode="window" type="button">App Window</button>
                <button class="seg-btn" data-mode="dock" type="button">Edge Dock</button>
              </div>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row" id="row-always-on-top">
              <div class="settings-row-info">
                <div class="settings-row-title">Always on Top</div>
                <div class="settings-row-desc">Keep the App Window floating above other windows.</div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="chk-always-on-top" />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row" id="row-pin-drawer">
              <div class="settings-row-info">
                <div class="settings-row-title">Pin Edge Drawer Open</div>
                <div class="settings-row-desc">Keep the Edge Dock expanded instead of auto-collapsing when cursor leaves.</div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="chk-pin-drawer" />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-title">Dock Screen Edge</div>
                <div class="settings-row-desc">Choose which edge of the display the Edge Dock attaches to.</div>
              </div>
              <div class="segmented-group" id="seg-dock-edge">
                <button class="seg-btn" data-edge="left" type="button">Left</button>
                <button class="seg-btn" data-edge="top" type="button">Top</button>
                <button class="seg-btn" data-edge="right" type="button">Right</button>
                <button class="seg-btn" data-edge="bottom" type="button">Bottom</button>
              </div>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-title">Edge Drawer Size</div>
                <div class="settings-row-desc">Preset dimensions when expanded in Edge Dock mode.</div>
              </div>
              <div class="segmented-group" id="seg-size-preset">
                <button class="seg-btn" data-preset="compact" type="button">Compact</button>
                <button class="seg-btn" data-preset="large" type="button">Large</button>
                <button class="seg-btn" data-preset="xl" type="button">Ultrawide</button>
              </div>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-title">Reset Dock Position</div>
                <div class="settings-row-desc">Snap the Edge Dock back to the center of your primary monitor's right edge.</div>
              </div>
              <button class="settings-action-btn" id="btn-reset-dock" type="button">Snap to Primary Right</button>
            </div>
          </div>
        </section>

        <!-- SECTION 3: SYSTEM & ALERTS -->
        <section class="settings-section" id="sec-system">
          <h2 class="settings-section-heading">System &amp; Alerts</h2>

          <div class="settings-card">
            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-title" id="lbl-flash-title">Flash Taskbar When Agent Waits</div>
                <div class="settings-row-desc" id="lbl-flash-desc">Pulse the Windows taskbar button when an agent stops for your input.</div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="chk-flash-taskbar" />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-title">Start Automatically at Login</div>
                <div class="settings-row-desc" id="lbl-login-desc">Launch Agent Orbit quietly in the background when signing in to Windows.</div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" id="chk-open-login" />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row">
              <div class="settings-row-info">
                <div class="settings-row-title">Demo Cosmic Simulation</div>
                <div class="settings-row-desc">Spawn synthetic multi-harness stars, exoplanets, and asteroid belts to preview layouts.</div>
              </div>
              <div class="settings-btn-pair">
                <button class="settings-action-btn accent" id="btn-sim-burst" type="button">✨ Simulate Swarm</button>
                <button class="settings-action-btn danger hidden" id="btn-sim-clear" type="button">Clear Simulated</button>
              </div>
            </div>
          </div>

          <div class="settings-card shortcuts-card">
            <div class="settings-row-title shortcuts-heading">Keyboard Shortcuts</div>
            <div class="shortcuts-grid">
              <div class="shortcut-item">
                <span>Jump to waiting agent</span>
                <kbd id="kbd-jump-waiting">Alt + Shift + Space</kbd>
              </div>
              <div class="shortcut-item">
                <span>Toggle Agent Orbit</span>
                <kbd id="kbd-toggle-orbit">Alt + Shift + O</kbd>
              </div>
              <div class="shortcut-item">
                <span>Open Settings</span>
                <kbd id="kbd-open-settings">Ctrl + ,</kbd>
              </div>
              <div class="shortcut-item">
                <span>Toggle Fullscreen</span>
                <kbd id="kbd-toggle-fullscreen">F11</kbd>
              </div>
              <div class="shortcut-item">
                <span>Filter Activity Log</span>
                <kbd>/</kbd>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;

  const speedSlider = container.querySelector<HTMLInputElement>("#settings-speed-slider")!;
  const speedValuePill = container.querySelector<HTMLElement>("#speed-value-pill")!;
  const speedPreviewTag = container.querySelector<HTMLElement>("#speed-preview-tag")!;
  const btnSpeedReset = container.querySelector<HTMLButtonElement>("#btn-speed-reset")!;
  const presetChips = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".speed-preset-chip")
  );
  const previewCanvas = container.querySelector<HTMLCanvasElement>("#settings-speed-canvas")!;
  const previewCtx = previewCanvas.getContext("2d")!;

  const segViewModeBtns = Array.from(
    container.querySelectorAll<HTMLButtonElement>("#seg-view-mode .seg-btn")
  );
  const segDockEdgeBtns = Array.from(
    container.querySelectorAll<HTMLButtonElement>("#seg-dock-edge .seg-btn")
  );
  const segSizePresetBtns = Array.from(
    container.querySelectorAll<HTMLButtonElement>("#seg-size-preset .seg-btn")
  );

  const chkAlwaysOnTop = container.querySelector<HTMLInputElement>("#chk-always-on-top")!;
  const chkPinDrawer = container.querySelector<HTMLInputElement>("#chk-pin-drawer")!;
  const chkFlashTaskbar = container.querySelector<HTMLInputElement>("#chk-flash-taskbar")!;
  const chkOpenLogin = container.querySelector<HTMLInputElement>("#chk-open-login")!;
  const btnResetDock = container.querySelector<HTMLButtonElement>("#btn-reset-dock")!;
  const btnSimBurst = container.querySelector<HTMLButtonElement>("#btn-sim-burst")!;
  const btnSimClear = container.querySelector<HTMLButtonElement>("#btn-sim-clear")!;

  const navItems = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".settings-nav-item")
  );
  const scrollPane = container.querySelector<HTMLElement>("#settings-scroll-pane")!;

  let currentSpeed = DEFAULT_ANIMATION_SPEED;
  let isDraggingSlider = false;
  let pendingSpeedSend: number | null = null;
  let speedSendInFlight = false;

  function flushSpeedUpdate(): void {
    if (speedSendInFlight || pendingSpeedSend === null) return;
    const targetSpeed = pendingSpeedSend;
    pendingSpeedSend = null;
    speedSendInFlight = true;
    window.orbitBridge
      .updateSettings({ animationSpeed: targetSpeed })
      .catch(() => {})
      .finally(() => {
        speedSendInFlight = false;
        if (pendingSpeedSend !== null) {
          flushSpeedUpdate();
        }
      });
  }

  function queueSpeedUpdate(speed: number): void {
    pendingSpeedSend = clampAnimationSpeed(speed);
    flushSpeedUpdate();
  }

  function updateSpeedUI(speed: number): void {
    currentSpeed = clampAnimationSpeed(speed);
    if (!isDraggingSlider) {
      speedSlider.value = String(currentSpeed);
    }
    const pct =
      ((currentSpeed - MIN_ANIMATION_SPEED) / (MAX_ANIMATION_SPEED - MIN_ANIMATION_SPEED)) * 100;
    speedSlider.style.setProperty("--slider-pct", `${pct.toFixed(1)}%`);

    const formatted = currentSpeed.toFixed(2).replace(/\.00$/, ".0").replace(/(\.\d)0$/, "$1");
    const desc = formatAnimationSpeedDescriptor(currentSpeed);
    speedValuePill.textContent = `${formatted}× · ${desc}`;
    speedPreviewTag.textContent = `Live ${formatted}×`;
    btnSpeedReset.classList.toggle("hidden", Math.abs(currentSpeed - 1.0) < 0.02);

    for (const chip of presetChips) {
      const chipVal = Number(chip.dataset.speed);
      chip.classList.toggle("active", Math.abs(chipVal - currentSpeed) < 0.025);
    }
  }

  const lblFlashTitle = container.querySelector<HTMLElement>("#lbl-flash-title")!;
  const lblFlashDesc = container.querySelector<HTMLElement>("#lbl-flash-desc")!;
  const lblLoginDesc = container.querySelector<HTMLElement>("#lbl-login-desc")!;
  const kbdJumpWaiting = container.querySelector<HTMLElement>("#kbd-jump-waiting")!;
  const kbdToggleOrbit = container.querySelector<HTMLElement>("#kbd-toggle-orbit")!;
  const kbdOpenSettings = container.querySelector<HTMLElement>("#kbd-open-settings")!;
  const kbdToggleFullscreen = container.querySelector<HTMLElement>("#kbd-toggle-fullscreen")!;

  function applyPlatformLabels(platform: string): void {
    currentPlatform = platform;
    container.dataset.platform = platform;
    document.documentElement.dataset.platform = platform;
    const isMac = platform === "darwin";
    const shortcuts = getPlatformShortcuts(platform);

    lblFlashTitle.textContent = isMac
      ? "Bounce Dock Icon When Agent Waits"
      : "Flash Taskbar When Agent Waits";
    lblFlashDesc.textContent = isMac
      ? "Bounce the macOS Dock icon and show a badge count when an agent stops for your input."
      : "Pulse the Windows taskbar button when an agent stops for your input.";
    lblLoginDesc.textContent = isMac
      ? "Launch Agent Orbit quietly in the background when signing in to macOS."
      : "Launch Agent Orbit quietly in the background when signing in to Windows.";

    kbdJumpWaiting.textContent = shortcuts.jumpWaitingKbd;
    kbdToggleOrbit.textContent = shortcuts.toggleOrbitKbd;
    kbdOpenSettings.textContent = shortcuts.settingsKbd;
    kbdToggleFullscreen.textContent = shortcuts.fullscreenKbd;
  }

  applyPlatformLabels(currentPlatform);

  function applySettingsToControls(s: OrbitSettings): void {
    if (s.platform) {
      applyPlatformLabels(s.platform);
    }
    updateSpeedUI(s.animationSpeed);

    for (const btn of segViewModeBtns) {
      btn.classList.toggle("active", btn.dataset.mode === s.viewMode);
    }
    for (const btn of segDockEdgeBtns) {
      btn.classList.toggle("active", btn.dataset.edge === s.dockEdge);
    }
    for (const btn of segSizePresetBtns) {
      btn.classList.toggle("active", btn.dataset.preset === s.sizePreset);
    }

    chkAlwaysOnTop.checked = Boolean(s.alwaysOnTop);
    chkPinDrawer.checked = Boolean(s.isPinned);
    chkFlashTaskbar.checked = Boolean(s.flashTaskbarOnWaiting);
    chkOpenLogin.checked = Boolean(s.openAtLogin);
    btnSimClear.classList.toggle("hidden", !s.simActive);
  }

  // Sidebar navigation smooth scroll + active highlight
  for (const navBtn of navItems) {
    navBtn.addEventListener("click", () => {
      for (const n of navItems) n.classList.toggle("active", n === navBtn);
      const targetId = navBtn.dataset.target;
      const sec = targetId ? container.querySelector<HTMLElement>(`#${targetId}`) : null;
      if (sec) {
        sec.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  scrollPane.addEventListener("scroll", () => {
    const sections = ["sec-motion", "sec-window", "sec-system"];
    const paneTop = scrollPane.getBoundingClientRect().top;
    let activeId = sections[0];
    for (const id of sections) {
      const el = container.querySelector<HTMLElement>(`#${id}`);
      if (el && el.getBoundingClientRect().top - paneTop <= 90) {
        activeId = id;
      }
    }
    for (const n of navItems) {
      n.classList.toggle("active", n.dataset.target === activeId);
    }
  });

  // Slider interactions
  speedSlider.addEventListener("pointerdown", () => {
    isDraggingSlider = true;
  });
  window.addEventListener("pointerup", () => {
    if (isDraggingSlider) {
      isDraggingSlider = false;
    }
  });

  speedSlider.addEventListener("input", () => {
    const val = clampAnimationSpeed(Number(speedSlider.value));
    updateSpeedUI(val);
    queueSpeedUpdate(val);
  });

  btnSpeedReset.addEventListener("click", () => {
    isDraggingSlider = false;
    updateSpeedUI(DEFAULT_ANIMATION_SPEED);
    queueSpeedUpdate(DEFAULT_ANIMATION_SPEED);
  });

  for (const chip of presetChips) {
    chip.addEventListener("click", () => {
      const val = clampAnimationSpeed(Number(chip.dataset.speed));
      isDraggingSlider = false;
      updateSpeedUI(val);
      queueSpeedUpdate(val);
    });
  }

  // Window & Dock controls
  for (const btn of segViewModeBtns) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode === "dock" ? "dock" : "window";
      void window.orbitBridge.updateSettings({ viewMode: mode }).then(applySettingsToControls);
    });
  }

  for (const btn of segDockEdgeBtns) {
    btn.addEventListener("click", () => {
      const edge = (btn.dataset.edge as EdgeSide) || "right";
      void window.orbitBridge.updateSettings({ dockEdge: edge }).then(applySettingsToControls);
    });
  }

  for (const btn of segSizePresetBtns) {
    btn.addEventListener("click", () => {
      const preset = (btn.dataset.preset as DrawerSizePreset) || "compact";
      void window.orbitBridge.updateSettings({ sizePreset: preset }).then(applySettingsToControls);
    });
  }

  chkAlwaysOnTop.addEventListener("change", () => {
    void window.orbitBridge
      .updateSettings({ alwaysOnTop: chkAlwaysOnTop.checked })
      .then(applySettingsToControls);
  });

  chkPinDrawer.addEventListener("change", () => {
    void window.orbitBridge
      .updateSettings({ isPinned: chkPinDrawer.checked })
      .then(applySettingsToControls);
  });

  btnResetDock.addEventListener("click", () => {
    void window.orbitBridge.resetDockPosition().then(() => {
      return window.orbitBridge.getSettings().then(applySettingsToControls);
    });
  });

  // System & Alerts controls
  chkFlashTaskbar.addEventListener("change", () => {
    void window.orbitBridge
      .updateSettings({ flashTaskbarOnWaiting: chkFlashTaskbar.checked })
      .then(applySettingsToControls);
  });

  chkOpenLogin.addEventListener("change", () => {
    void window.orbitBridge
      .updateSettings({ openAtLogin: chkOpenLogin.checked })
      .then(applySettingsToControls);
  });

  btnSimBurst.addEventListener("click", () => {
    void window.orbitBridge.triggerSimBurst().then(() => {
      return window.orbitBridge.getSettings().then(applySettingsToControls);
    });
  });

  btnSimClear.addEventListener("click", () => {
    void window.orbitBridge.clearSimulated().then(() => {
      return window.orbitBridge.getSettings().then(applySettingsToControls);
    });
  });

  // Live sync from main process
  window.orbitBridge.onSettingsChanged(s => {
    applySettingsToControls(s);
  });

  const initialSettings = await window.orbitBridge.getSettings();
  applySettingsToControls(initialSettings);

  // Live 60fps miniature cosmic preview loop
  let previewSimTime = 0;
  let lastTs = performance.now();

  function resizePreviewCanvas(): { w: number; h: number } {
    const rect = previewCanvas.parentElement?.getBoundingClientRect();
    const cssW = Math.max(180, Math.round(rect?.width || 212));
    const cssH = Math.max(128, Math.round(rect?.height || 144));
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (previewCanvas.width !== targetW || previewCanvas.height !== targetH) {
      previewCanvas.width = targetW;
      previewCanvas.height = targetH;
    }
    previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: cssW, h: cssH };
  }

  function tickPreview(now: number): void {
    const rawDt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
    lastTs = now;
    if (!document.hidden) {
      previewSimTime += rawDt * currentSpeed;
      const { w, h } = resizePreviewCanvas();
      renderSpeedPreviewFrame(previewCtx, w, h, previewSimTime, currentSpeed);
    }
    requestAnimationFrame(tickPreview);
  }

  requestAnimationFrame(tickPreview);
}
