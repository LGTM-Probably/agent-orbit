# User Guide & Visual Mechanics

[← Back to README](../README.md)

Agent Orbit watches append-only `.jsonl` session transcripts directly on disk for **Claude Code**, **Codex**, **Antigravity**, and **Strata**, rendering every active session as a living solar system alongside an expandable real-time activity log.

---

## Visual Guide & Highlights

- **Zero Token / Context Overhead:** Passively tails local session files (`~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/antigravity/brain`, `~/.strata`) via incremental byte offsets. Never injects prompts, MCP servers, or hooks into your agents.
- **Dual Window Modes (`App Window` & `Screen-Edge Dock`):**
  - **App Window:** Resizable, snap-friendly desktop window with split-pane cosmic canvas + live trailing activity log.
  - **Screen-Edge Dock:** Collapses to a scrollbar-safe 26×196px capsule on any monitor edge (`Left`, `Right`, `Top`, `Bottom`) so IDE and browser scrollbars stay unobstructed. On Windows the capsule is clipped with Win32 region clipping (`SetWindowRgn`). On macOS it stays visible across all Spaces and full-screen apps.
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
  - Detects blocked orchestrators (`AskUserQuestion`, `ask_question`, `request_user_input`, plan reviews, completed turns), elevates them into a dedicated top **Awaiting You** spotlight lane, and surfaces a one-click jump pill + global shortcut (`⌥⇧Space` on macOS, `Alt+Shift+Space` on Windows).
  - Double-click any star (or click **Jump to Window**) to bring the matching IDE or terminal window to the foreground on macOS or Windows.
  - Bounces the macOS Dock icon with a badge count, or flashes the Windows taskbar button, when an agent stops for your input.
- **Dedicated Settings Window (`⚙`, `⌘,` or `Ctrl+,`):**
  - Customize **Animation Speed** (`0.1×` contemplative drift to `3.0×` lively, with a live miniature star-system preview), default **Time Horizon**, and **Display Mode**.

---

## Keyboard & Canvas Controls

- **Pan & Zoom:** Drag background to pan, scroll wheel to zoom, click `⌖` to fit all visible star systems.
- **Inspect & Poke:** Hover any star, exoplanet, or Kuiper belt asteroid to inspect turn counts, tools, token usage, and skills; drag nodes to stretch orbital springs; click to scope the activity log to that star system.
| Action | macOS | Windows |
| --- | --- | --- |
| Focus activity log search (`Esc` clears) | `/` or `⌘F` | `/` or `Ctrl+F` |
| Open Settings | `⌘,` | `Ctrl+,` |
| Jump to the oldest agent waiting on you | `⌥⇧Space` | `Alt+Shift+Space` |
| Summon or minimize Agent Orbit from anywhere | `⌥⇧O` | `Alt+Shift+O` |
| Toggle full screen | `⌃⌘F` | `F11` |

---

## Platform Setup

Both platforms need **Node.js 20+** and `npm`. Clone the repo, then run `npm install` and `npm start`.

### macOS

- **Requirements:** macOS 12 Monterey or later, on Apple silicon or Intel. No Xcode or extra toolchain is needed.
- **Jump to Window:** Agent Orbit finds the terminal or IDE running each agent and brings it forward. It works with Terminal, iTerm2, Ghostty, Warp, Tabby, VS Code, Cursor, Windsurf, Zed, Alacritty, kitty, WezTerm and Hyper, plus the Claude, Codex, Antigravity and Strata desktop apps.
- **Permissions:** The first time you jump to a window, macOS may ask whether Agent Orbit can control **System Events**. Allow it (and grant **Accessibility** access under *System Settings → Privacy & Security* if asked) so Agent Orbit can raise the exact window. If you decline, the right app still comes to the front, but macOS may not pick the specific window.
- **Packaging:** `npm run dist:mac` builds a `.dmg` and `.zip` in `release/`. These builds are not signed or notarized yet, so on first launch Gatekeeper will block the app. Control-click the app and choose **Open**, or click **Open Anyway** under *System Settings → Privacy & Security*.

### Windows

- **Requirements:** Windows 10 or 11.
- **Native helpers:** `npm run build` compiles small Win32 helpers for window focus, dock region clipping, and the optional Desktop launcher, using the `csc.exe` compiler that ships with the .NET Framework. No extra install is needed on a standard Windows machine.
- **Packaging:** `npm run dist:win` builds an NSIS installer and a portable `.exe` in `release/`.
- **Unsigned builds:** Release builds are not signed with an Authenticode certificate yet. If Windows SmartScreen shows *"Windows protected your PC"* on first launch, click **More info** → **Run anyway**, or build from source.

### Linux

The visualizer and test suite also run from source on Linux, but Jump to Window is not supported there yet and no Linux packaging target is configured.

---

## Developer Scripts

| Command | Description |
| --- | --- |
| `npm start` | Ensures the Electron binary, compiles TypeScript + Vite (plus the Win32 helpers on Windows), and launches Agent Orbit |
| `npm test` | Compiles and runs the full Node unit test suite across adapters, physics, renderer, IPC, and macOS/Windows platform code |
| `npm run typecheck` | Runs strict TypeScript checks across Main and Renderer targets |
| `npm run verify:tailer` | Runs a headless scan of local agent transcripts and prints discovered session stats |
| `npm run dist` | Packages Agent Orbit for the current platform in `release/` via `electron-builder` |
| `npm run dist:mac` | Packages a macOS `.dmg` and `.zip` |
| `npm run dist:win` | Packages a Windows NSIS installer and portable `.exe` |
| `npm run shortcut:desktop` | *(Windows only)* Compiles and places a native `Agent Orbit.exe` launcher on your Desktop |

---

## Related Docs

- [Architecture & Internals](architecture.md)
- [Adding a New Agent Provider](adding-a-provider.md)
