# User Guide & Visual Mechanics

[← Back to README](../README.md)

Agent Orbit watches append-only `.jsonl` session transcripts directly on disk for **Claude Code**, **Codex**, **Antigravity**, and **Strata**, rendering every active session as a living solar system alongside an expandable real-time activity log.

---

## Visual Guide & Highlights

- **Zero Token / Context Overhead:** Passively tails local session files (`~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/antigravity/brain`, `~/.strata`) via incremental byte offsets. Never injects prompts, MCP servers, or hooks into your agents.
- **Dual Window Modes (`App Window` & `Screen-Edge Dock`):**
  - **App Window:** Resizable, snap-friendly desktop window with split-pane cosmic canvas + live trailing activity log.
  - **Screen-Edge Dock:** Collapses to a scrollbar-safe 26×196px capsule on any monitor edge (`Left`, `Right`, `Top`, `Bottom`) with Win32 region clipping (`SetWindowRgn`) so IDE and browser scrollbars stay completely unobstructed.
- **Living Stellar Systems:**
  - **Orchestrator Stars:** Evolve through 5 astrophysical spectral classes (`Protostar` → `Main Sequence` → `Subgiant` → `Giant` → `Supergiant`) as sessions spawn subagents and accumulate work, with harness-tinted coronas, segmented tool-category arcs, expressive eyes (`zzZ` when idle), and **Core Fuel** context-window gauges (`200k` / `258k` / `400k` / `1M+` auto-detected per model).
  - **Subagent Exoplanets:** Active subagents orbit on Keplerian rings as procedural rocky, ocean, ringed, terrestrial, ice, and volcanic exoplanets with orbiting tool-probe satellites and live tether telemetry packets.
  - **Solar Accretion Flares & Turn-Scaled Kuiper Belts:** When a live subagent completes, it returns an energy packet to its parent star (triggering a solar prominence flare) and spirals gracefully into a spaced outer Kuiper belt, where each asteroid's mass and craggy silhouette scale with how many model turns that subagent executed.
  - **Skill Moons:** Invoked skills (`Skill` tool, `/slash` commands, or `SKILL.md` reads) attach as orbiting moons.
- **Granular Trailing Activity Log:**
  - Semantic task badges (`PROMPT`, `REPLY`, `PLAN`, `EDIT`, `WRITE`, `READ`, `SEARCH`, `GIT`, `TEST`, `BUILD`, `PR`, `MCP`, `ASK`, `SPAWN`, `DONE`) with instant multi-token search (`/` or `Ctrl+F`).
  - Click any row to lazy-load full untruncated prompts, replies, structured tool-call JSON arguments, unified `- / +` diffs, and terminal output.
  - Click file paths or `PR` links to open them safely, or click an agent chip to pan & zoom directly to that star or exoplanet on the canvas.
- **Waiting-on-You Spotlight & Global Hotkeys:**
  - Detects blocked orchestrators (`AskUserQuestion`, `ask_question`, `request_user_input`, plan reviews, completed turns), elevates them into a dedicated top **Awaiting You** spotlight lane, and surfaces a one-click jump pill + `Alt+Shift+Space` global shortcut.
  - Double-click any star (or click **Jump to Window**) to bring the matching IDE or terminal window to the foreground on Windows.
- **Dedicated Settings Window (`⚙` or `Ctrl+,`):**
  - Customize **Animation Speed** (`0.1×` contemplative drift to `3.0×` lively, with a live miniature star-system preview), default **Time Horizon**, and **Display Mode**.

---

## Keyboard & Canvas Controls

- **Pan & Zoom:** Drag background to pan, scroll wheel to zoom, click `⌖` to fit all visible star systems.
- **Inspect & Poke:** Hover any star, exoplanet, or Kuiper belt asteroid to inspect turn counts, tools, token usage, and skills; drag nodes to stretch orbital springs; click to scope the activity log to that star system.
- **`/` or `Ctrl+F`:** Focus instant activity log search (`Esc` clears).
- **`Ctrl+,`:** Open the Settings window.
- **`Alt+Shift+Space`:** Jump to the oldest agent waiting on your input.
- **`Alt+Shift+O`:** Summon or minimize Agent Orbit from anywhere.

---

## Setup Notes & Developer Scripts

### Platform Prerequisites

- **Windows 10 / 11** *(uses native `.NET Framework csc.exe` helpers for Win32 window focus, region clipping, and optional Desktop `.exe` launcher; core Electron visualizer + test suite also run from source on macOS and Linux)*
- **Node.js 20+** and `npm`

> **Note on Prebuilt Windows `.exe` Releases:** Community release builds are not signed with an Authenticode certificate yet. If Windows SmartScreen displays *"Windows protected your PC"* on first launch, click **More info** → **Run anyway** (or build directly from source).

### Scripts

| Command | Description |
| --- | --- |
| `npm start` | Ensures Electron binary, compiles TypeScript + Vite + Win32 helpers, and launches Agent Orbit |
| `npm test` | Compiles and runs the full Node unit test suite (`105` tests across adapters, physics, renderer, and IPC) |
| `npm run typecheck` | Runs strict TypeScript checks across Main and Renderer targets |
| `npm run verify:tailer` | Runs a headless scan of local agent transcripts and prints discovered session stats |
| `npm run shortcut:desktop` | Compiles and places a native `Agent Orbit.exe` launcher on your Windows Desktop |
| `npm run dist` | Packages a standalone Windows NSIS installer & portable `.exe` in `release/` via `electron-builder` |

---

## Related Docs

- [Architecture & Internals](architecture.md)
- [Adding a New Agent Provider](adding-a-provider.md)
