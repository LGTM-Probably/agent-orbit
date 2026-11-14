import { HarnessKind } from "../shared/types";
import { GraphStore } from "./graphStore";

const DEMO_SCENARIOS: Array<{
  harness: HarnessKind;
  project: string;
  title: string;
  model: string;
  skills: string[];
  subs: Array<{ role: string; skill?: string }>;
}> = [
  {
    harness: "claude",
    project: "nebula-gateway",
    title: "Release v0.46 wave dispatch",
    model: "claude-opus-4-6",
    skills: ["release-pipeline", "refactor-audit"],
    subs: [
      { role: "Worker #3801 rate limiter", skill: "audio-synth" },
      { role: "Worker #3804 session ledger", skill: "trace-capture" },
      { role: "Gate verifier batch 46-1" },
      { role: "Dead-code hygiene sweep", skill: "refactor-audit" },
      { role: "Socket pool audit" },
    ],
  },
  {
    harness: "antigravity",
    project: "agent-orbit",
    title: "Spring graph edge drawer",
    model: "gemini-2.5-pro",
    skills: ["generative_ui"],
    subs: [
      { role: "Transcript Schema Researcher" },
      { role: "Canvas Physics Tuner" },
      { role: "Win32 Dwell Verifier" },
    ],
  },
  {
    harness: "codex",
    project: "photon-ui",
    title: "Deterministic save replay",
    model: "gpt-5-codex",
    skills: ["triage-intake"],
    subs: [
      { role: "snapshot-diff-worker" },
      { role: "crc-fuzz-runner" },
    ],
  },
  {
    harness: "strata",
    project: "chrono-store",
    title: "M21 local worker swarm",
    model: "qwen-iq3_s",
    skills: ["code-review", "release-notes"],
    subs: [
      { role: "Fix worker PR 858", skill: "code-review" },
      { role: "Integration branch merger" },
      { role: "Sandbox policy attester" },
    ],
  },
];

const SAMPLE_TOOLS: Array<{
  name: string;
  target: string;
  filePath?: string;
  summary?: string;
  rawCommand?: string;
  linesAdded?: number;
  linesRemoved?: number;
  isArtifact?: boolean;
  exitCode?: number;
  durationMs?: number;
}> = [
  {
    name: "Bash",
    target: "git status -sb",
    summary: "Check git status",
    rawCommand: "git status -sb",
    durationMs: 120,
  },
  {
    name: "Bash",
    target: "npm test",
    summary: "Run vitest suite",
    rawCommand: "npm test",
    durationMs: 1840,
  },
  {
    name: "Bash",
    target: "npm run build",
    summary: "Compile main and renderer bundles",
    rawCommand: "npm run build",
    durationMs: 3200,
  },
  {
    name: "Grep",
    target: "SocketType.Interior",
    summary: "Search SocketType across codebase",
  },
  {
    name: "Edit",
    target: "src/ui/LedgerView.ts",
    filePath: "src/ui/LedgerView.ts",
    summary: "Refactor LedgerView rendering",
    linesAdded: 18,
    linesRemoved: 4,
  },
  {
    name: "Write",
    target: "tests/replay.spec.ts",
    filePath: "tests/replay.spec.ts",
    summary: "Generate deterministic replay test",
    linesAdded: 64,
    linesRemoved: 0,
  },
  {
    name: "Plan",
    target: "docs/architecture.md",
    filePath: "docs/architecture.md",
    summary: "Draft release v0.46 dispatch plan",
    isArtifact: true,
  },
  {
    name: "Bash",
    target: "npm run test:flaky",
    summary: "Run flaky test harness",
    rawCommand: "npm test -- tests/flaky.spec.ts",
    exitCode: 1,
    durationMs: 1840,
  },
  {
    name: "WebSearch",
    target: "verlet spring damping",
    summary: "Search physics damping equation",
  },
];

export class SwarmSimulator {
  private timers = new Set<NodeJS.Timeout>();
  private burstCounter = 0;

  constructor(private store: GraphStore) {}

  public triggerBurst(): void {
    const scenario = DEMO_SCENARIOS[this.burstCounter % DEMO_SCENARIOS.length];
    this.burstCounter += 1;

    const suffix = Math.random().toString(36).slice(2, 7);
    const rootRaw = `sim-${suffix}`;
    const rootId = `${scenario.harness}:${rootRaw}`;
    const now = Date.now();

    this.store.upsertNode({
      id: rootId,
      rawId: rootRaw,
      harness: scenario.harness,
      label: scenario.title,
      isCustomLabel: true,
      project: scenario.project,
      cwd: `C:/code/${scenario.project}`,
      branch: "feat/orbit-sim",
      model: scenario.model,
      timestamp: now,
      isSimulated: true,
    });

    this.store.recordUserPrompt(rootId, scenario.title, now);
    this.store.recordTurnPhase(rootId, "thinking", now);

    // Progressive Core Fuel & context-window burn across the burst (42k -> 96k -> 168k / 200k = 84%)
    this.store.recordTokenUsage(rootId, {
      contextTokens: 42_000,
      contextMaxTokens: 200_000,
      cumulativeTotalTokens: 124_000,
      cumulativeOutputTokens: 14_200,
    });
    this.later(1600, () => {
      this.store.recordTokenUsage(rootId, {
        contextTokens: 96_000,
        contextMaxTokens: 200_000,
        cumulativeTotalTokens: 310_000,
        cumulativeOutputTokens: 36_800,
      });
    });
    this.later(3400, () => {
      this.store.recordTokenUsage(rootId, {
        contextTokens: 168_000,
        contextMaxTokens: 200_000,
        cumulativeTotalTokens: 642_000,
        cumulativeOutputTokens: 74_500,
      });
    });

    // Fast "Scout Probe" subagent for instant Spiral Re-Entry + Solar Flare within ~1.45s
    const scoutRaw = `sim-scout-${suffix}`;
    const scoutId = `${scenario.harness}:${rootRaw}:sub:${scoutRaw}`;
    const scoutCallId = `sim-scout-call-${suffix}`;
    this.later(180, () => {
      this.store.upsertNode({
        id: scoutId,
        rawId: scoutRaw,
        harness: scenario.harness,
        parentId: rootId,
        isSubagent: true,
        label: "Scout Probe",
        isCustomLabel: true,
        project: scenario.project,
        cwd: `C:/code/${scenario.project}`,
        model: scenario.model,
        timestamp: Date.now(),
        isSimulated: true,
        emitSpawnPulse: true,
      });
      this.store.recordTurnPhase(scoutId, "thinking", Date.now());
      this.store.recordTokenUsage(scoutId, {
        contextTokens: 24_000,
        contextMaxTokens: 200_000,
        cumulativeTotalTokens: 24_000,
        cumulativeOutputTokens: 2_800,
      });
    });
    this.later(450, () => {
      this.store.recordToolStart(scoutId, {
        callId: scoutCallId,
        name: "Read",
        target: "src/index.ts",
        filePath: "src/index.ts",
        summary: "Scan workspace entrypoints",
        timestamp: Date.now(),
        isLive: true,
      });
    });
    this.later(980, () => {
      this.store.recordToolEnd(scoutId, {
        callId: scoutCallId,
        durationMs: 530,
        timestamp: Date.now(),
        isLive: true,
      });
    });
    this.later(1450, () => {
      this.store.markCompleted(scoutId, Date.now(), true, {
        durationMs: 1270,
        subagentToolCount: 1,
        model: scenario.model,
      });
    });

    // Attach skills sequentially
    scenario.skills.forEach((sk, idx) => {
      this.later(350 + idx * 500, () => {
        this.store.recordSkill(rootId, sk, Date.now(), true);
      });
    });

    // Fire orchestrator tool calls
    for (let i = 0; i < 6; i++) {
      const tool = SAMPLE_TOOLS[(i + this.burstCounter) % SAMPLE_TOOLS.length];
      const startDelay = 250 + i * 950;
      const callId = `sim-call-${suffix}-${i}`;
      this.later(startDelay, () => {
        this.store.recordToolStart(rootId, {
          callId,
          name: tool.name,
          target: tool.target,
          filePath: tool.filePath,
          summary: tool.summary,
          rawCommand: tool.rawCommand,
          linesAdded: tool.linesAdded,
          linesRemoved: tool.linesRemoved,
          isArtifact: tool.isArtifact,
          timestamp: Date.now(),
          isLive: true,
        });
      });
      this.later(startDelay + 620, () => {
        const isErr = tool.exitCode !== undefined && tool.exitCode !== 0;
        this.store.recordToolEnd(rootId, {
          callId,
          isError: isErr,
          exitCode: tool.exitCode,
          durationMs: tool.durationMs ?? 620,
          timestamp: Date.now(),
          isLive: true,
        });
      });
    }

    // Spawn subagents staggered; some complete into dimmed mini-nodes, 1-2 stay active briefly
    scenario.subs.forEach((sub, sIdx) => {
      const subRaw = `sim-sub-${suffix}-${sIdx}`;
      const subId = `${scenario.harness}:${rootRaw}:sub:${subRaw}`;
      const spawnAt = 500 + sIdx * 650;

      this.later(spawnAt, () => {
        this.store.upsertNode({
          id: subId,
          rawId: subRaw,
          harness: scenario.harness,
          parentId: rootId,
          isSubagent: true,
          label: sub.role,
          isCustomLabel: true,
          project: scenario.project,
          cwd: `C:/code/${scenario.project}`,
          model: scenario.model,
          timestamp: Date.now(),
          isSimulated: true,
          emitSpawnPulse: true,
        });
        if (sub.skill) {
          this.store.recordSkill(subId, sub.skill, Date.now(), true);
        }
      });

      const subToolCount = 3 + (sIdx % 3);
      const simulatedTurns = [1, 4, 9, 17, 29][sIdx % 5];
      this.later(spawnAt + 120, () => {
        for (let tr = 0; tr < simulatedTurns; tr++) {
          this.store.recordModelTurn(subId, `sim-turn-${sIdx}-${tr}`);
        }
      });
      for (let t = 0; t < subToolCount; t++) {
        const tool = SAMPLE_TOOLS[(sIdx * 2 + t) % SAMPLE_TOOLS.length];
        const tStart = spawnAt + 350 + t * 800;
        const cid = `sim-subcall-${suffix}-${sIdx}-${t}`;
        this.later(tStart, () => {
          this.store.recordToolStart(subId, {
            callId: cid,
            name: tool.name,
            target: tool.target,
            filePath: tool.filePath,
            summary: tool.summary,
            rawCommand: tool.rawCommand,
            linesAdded: tool.linesAdded,
            linesRemoved: tool.linesRemoved,
            isArtifact: tool.isArtifact,
            timestamp: Date.now(),
            isLive: true,
          });
        });
        this.later(tStart + 520, () => {
          const isErr = (sIdx === 2 && t === 1) || (tool.exitCode !== undefined && tool.exitCode !== 0);
          this.store.recordToolEnd(subId, {
            callId: cid,
            isError: isErr,
            exitCode: isErr ? (tool.exitCode ?? 1) : 0,
            durationMs: tool.durationMs ?? 520,
            timestamp: Date.now(),
            isLive: true,
          });
        });
      }

      // Reel finished subagents into the inner dimmed halo!
      const finishAt = spawnAt + 350 + subToolCount * 800 + 400;
      this.later(finishAt, () => {
        this.store.markCompleted(subId, Date.now(), true, {
          durationMs: subToolCount * 800 + 400,
          subagentToolCount: subToolCount,
          model: scenario.model,
        });
      });
    });

    // Milestone reply
    this.later(8100, () => {
      this.store.recordAssistantMilestone(
        rootId,
        `Task burst completed for ${scenario.project}. All integration checks pass.`,
        Date.now()
      );
    });

    // Finally put root session into "waiting_on_user" so the amber beacon shows off too
    this.later(8200, () => {
      this.store.recordTurnPhase(rootId, "waiting_on_user", Date.now());
    });
  }

  public spawnCosmicShowcase(): void {
    this.clear();
    const now = Date.now();

    // 1. Claude: Active Blazing Star (tool_running) with prominence flares!
    const claudeId = "claude:sim-claude-star";
    this.store.upsertNode({
      id: claudeId,
      rawId: "sim-claude-star",
      harness: "claude",
      label: "Release v0.46 wave dispatch",
      isCustomLabel: true,
      project: "nebula-gateway",
      cwd: "C:/code/nebula-gateway",
      branch: "release/v0.46",
      model: "claude-opus-4-6",
      timestamp: now,
      isSimulated: true,
    });
    this.store.recordUserPrompt(claudeId, "Release v0.46 wave dispatch", now);
    this.store.recordTurnPhase(claudeId, "thinking", now);
    this.store.recordTokenUsage(claudeId, {
      contextTokens: 128_000,
      contextMaxTokens: 400_000,
      cumulativeTotalTokens: 740_000,
      cumulativeOutputTokens: 86_000,
    });
    this.store.recordSkill(claudeId, "release-pipeline", now, false);
    this.store.recordSkill(claudeId, "refactor-audit", now, false);
    this.store.recordToolStart(claudeId, {
      callId: "claude-tool-active",
      name: "Bash",
      target: "npm run test",
      summary: "Run integration tests",
      rawCommand: "npm run test",
      timestamp: now,
      isLive: false,
    });
    this.store.recordAssistantMilestone(
      claudeId,
      "PR #859 verified and merged into release/v0.46 branch.",
      now - 5000
    );

    // Claude active subagent planets:
    const claudeSub1 = "claude:sim-claude-star:sub:turret";
    this.store.upsertNode({
      id: claudeSub1,
      rawId: "turret",
      harness: "claude",
      parentId: claudeId,
      isSubagent: true,
      label: "Rate Limiter",
      isCustomLabel: true,
      project: "nebula-gateway",
      timestamp: now,
      isSimulated: true,
    });
    this.store.recordTurnPhase(claudeSub1, "thinking", now);
    this.store.recordSkill(claudeSub1, "audio-synth", now, false);
    this.store.recordToolStart(claudeSub1, {
      callId: "sub1-tool-active",
      name: "Edit",
      target: "src/gateway/RateLimiter.ts",
      summary: "Tune token bucket burst capacity",
      linesAdded: 18,
      linesRemoved: 4,
      timestamp: now,
      isLive: false,
    });

    const claudeSub2 = "claude:sim-claude-star:sub:ledger";
    this.store.upsertNode({
      id: claudeSub2,
      rawId: "ledger",
      harness: "claude",
      parentId: claudeId,
      isSubagent: true,
      label: "Session Ledger",
      isCustomLabel: true,
      project: "nebula-gateway",
      timestamp: now,
      isSimulated: true,
    });
    this.store.recordTurnPhase(claudeSub2, "thinking", now);

    // Claude completed asteroids in outer Kuiper belt (12 completed + 2 active = 14 subagents):
    const claudeAsteroids = [
      { id: "gate-verifier", label: "Gate Verifier 46-1" },
      { id: "hull-audit", label: "Socket Pool Audit" },
      { id: "hygiene-sweep", label: "Dead-Code Sweep" },
      { id: "atlas-opt", label: "Bundle Chunker" },
      { id: "laser-fx", label: "Trace Exporter" },
      { id: "recoil-bench", label: "Throughput Bench" },
      { id: "nav-spline", label: "Route Resolver" },
      { id: "dock-clamp", label: "Backoff Solver" },
      { id: "shield-lut", label: "Auth Token Cache" },
      { id: "save-migrator", label: "Schema v46 Migrator" },
      { id: "audio-bus", label: "Metrics Limiter" },
      { id: "smoke-runner", label: "Replay Smoke Gate" },
    ];
    const claudeAsteroidTurns = [28, 3, 19, 1, 9, 34, 4, 15, 2, 22, 6, 12];
    claudeAsteroids.forEach((ast, idx) => {
      const astId = `claude:sim-claude-star:sub:${ast.id}`;
      this.store.upsertNode({
        id: astId,
        rawId: ast.id,
        harness: "claude",
        parentId: claudeId,
        isSubagent: true,
        label: ast.label,
        isCustomLabel: true,
        project: "nebula-gateway",
        timestamp: now - (idx + 1) * 45000,
        isSimulated: true,
      });
      const turns = claudeAsteroidTurns[idx % claudeAsteroidTurns.length];
      for (let t = 0; t < turns; t++) {
        this.store.recordModelTurn(astId, `ast-turn-${idx}-${t}`);
      }
      this.store.markCompleted(astId, now - (idx + 1) * 45000, false, {
        subagentToolCount: Math.round(turns * 1.4),
      });
    });

    // 2. Antigravity: Active Blazing Star (thinking) with 3D tilted accretion disk!
    // 2 active subagents + 2 completed asteroids = 4 subagents -> Orange Giant!
    const agyId = "antigravity:sim-agy-star";
    this.store.upsertNode({
      id: agyId,
      rawId: "sim-agy-star",
      harness: "antigravity",
      label: "Cosmic Physics Engine",
      isCustomLabel: true,
      project: "agent-orbit",
      cwd: "C:/code/agent-orbit",
      branch: "main",
      model: "gemini-2.5-pro",
      timestamp: now,
      isSimulated: true,
    });
    this.store.recordUserPrompt(agyId, "Cosmic Physics Engine", now);
    this.store.recordTurnPhase(agyId, "thinking", now);
    this.store.recordTokenUsage(agyId, {
      contextTokens: 94_000,
      contextMaxTokens: 1_000_000,
      cumulativeTotalTokens: 410_000,
      cumulativeOutputTokens: 48_000,
    });
    this.store.recordSkill(agyId, "generative_ui", now, false);
    this.store.recordAssistantMilestone(
      agyId,
      "Refactored accretion disk shader and orbital physics loop.",
      now - 2000
    );

    // Antigravity active subagent planets:
    const agySub1 = "antigravity:sim-agy-star:sub:canvas";
    this.store.upsertNode({
      id: agySub1,
      rawId: "canvas",
      harness: "antigravity",
      parentId: agyId,
      isSubagent: true,
      label: "Planetary Orbit Tuner",
      isCustomLabel: true,
      project: "agent-orbit",
      timestamp: now,
      isSimulated: true,
    });
    this.store.recordTurnPhase(agySub1, "thinking", now);
    this.store.recordToolStart(agySub1, {
      callId: "agy-sub1-tool",
      name: "Edit",
      target: "src/renderer/physics.ts",
      summary: "Update spring damping and tilt",
      linesAdded: 32,
      linesRemoved: 8,
      timestamp: now,
      isLive: false,
    });

    const agySub2 = "antigravity:sim-agy-star:sub:researcher";
    this.store.upsertNode({
      id: agySub2,
      rawId: "researcher",
      harness: "antigravity",
      parentId: agyId,
      isSubagent: true,
      label: "Depth Shaper",
      isCustomLabel: true,
      project: "agent-orbit",
      timestamp: now,
      isSimulated: true,
    });
    this.store.recordTurnPhase(agySub2, "thinking", now);

    // Antigravity completed asteroids (2 completed + 2 active = 4 subagents):
    const agyAsteroids = [
      { id: "win32-dwell", label: "Win32 Dwell Verifier" },
      { id: "ipc-perf", label: "IPC Batch Profiler" },
    ];
    agyAsteroids.forEach((ast, idx) => {
      const astId = `antigravity:sim-agy-star:sub:${ast.id}`;
      this.store.upsertNode({
        id: astId,
        rawId: ast.id,
        harness: "antigravity",
        parentId: agyId,
        isSubagent: true,
        label: ast.label,
        isCustomLabel: true,
        project: "agent-orbit",
        timestamp: now - (idx + 1) * 60000,
        isSimulated: true,
      });
      this.store.markCompleted(astId, now - (idx + 1) * 60000, false);
    });

    // 3. Codex: Waiting on User (waiting_on_user) Golden Pulsar Beacon with concentric rings!
    // 1 active subagent + 1 completed asteroid = 2 subagents -> Yellow Star!
    const codexId = "codex:sim-codex-star";
    this.store.upsertNode({
      id: codexId,
      rawId: "sim-codex-star",
      harness: "codex",
      label: "Deterministic save replay",
      isCustomLabel: true,
      project: "photon-ui",
      cwd: "C:/code/photon-ui",
      branch: "fix/replay-crc",
      model: "gpt-5-codex",
      timestamp: now,
      isSimulated: true,
    });
    this.store.recordUserPrompt(codexId, "Deterministic save replay", now);
    this.store.recordTurnPhase(codexId, "waiting_on_user", now);
    this.store.recordTokenUsage(codexId, {
      contextTokens: 186_000,
      contextMaxTokens: 258_400,
      cumulativeTotalTokens: 620_000,
      cumulativeOutputTokens: 54_000,
    });
    this.store.recordSkill(codexId, "triage-intake", now, false);
    this.store.recordToolStart(codexId, {
      callId: "codex-ask-1",
      name: "AskUserQuestion",
      target: "Approve deterministic CRC replay format?",
      waitingPrompt: "Approve deterministic CRC replay format?",
      timestamp: now,
      isLive: false,
    });
    this.store.recordAssistantMilestone(
      codexId,
      "CRC fuzz suite complete: 10,000 deterministic ticks verified.",
      now - 1000
    );

    // Codex active planet:
    const codexSub1 = "codex:sim-codex-star:sub:fuzzer";
    this.store.upsertNode({
      id: codexSub1,
      rawId: "fuzzer",
      harness: "codex",
      parentId: codexId,
      isSubagent: true,
      label: "CRC Fuzz Runner",
      isCustomLabel: true,
      project: "photon-ui",
      timestamp: now,
      isSimulated: true,
    });
    this.store.recordTurnPhase(codexSub1, "thinking", now);

    // Codex completed asteroid (1 completed + 1 active = 2 subagents):
    const codexAsteroids = [
      { id: "diff-worker", label: "Snapshot Diff" },
    ];
    codexAsteroids.forEach((ast, idx) => {
      const astId = `codex:sim-codex-star:sub:${ast.id}`;
      this.store.upsertNode({
        id: astId,
        rawId: ast.id,
        harness: "codex",
        parentId: codexId,
        isSubagent: true,
        label: ast.label,
        isCustomLabel: true,
        project: "photon-ui",
        timestamp: now - (idx + 1) * 60000,
        isSimulated: true,
      });
      this.store.markCompleted(astId, now - (idx + 1) * 60000, false);
    });

    // 4. Strata: Slumbering White Dwarf (0 subagents, idle for 30m) - hushed frosted pearl-blue dwarf, cozy ◡ ◡ eyes, z·z·Z
    const strataId = "strata:sim-strata-star";
    this.store.upsertNode({
      id: strataId,
      rawId: "sim-strata-star",
      harness: "strata",
      label: "M21 local worker swarm",
      isCustomLabel: true,
      project: "chrono-store",
      cwd: "C:/code/chrono-store",
      branch: "m21-cleanup",
      model: "qwen3-coder",
      timestamp: now - 30 * 60000,
      isSimulated: true,
    });
    this.store.recordTurnPhase(strataId, "idle", now - 30 * 60000);
    this.store.recordTokenUsage(strataId, {
      contextTokens: 28_000,
      contextMaxTokens: 131_072,
      cumulativeTotalTokens: 92_000,
      cumulativeOutputTokens: 11_400,
    });
    this.store.recordAssistantMilestone(
      strataId,
      "Merged integration branch and validated policy constraints.",
      now - 25 * 60000
    );

    // 5. Hyperion-Cloud: Massive Red Supergiant running a large 12-subagent swarm across concentric rings + 20 completed asteroids
    const hyperionId = "claude:sim-hyperion-star";
    this.store.upsertNode({
      id: hyperionId,
      rawId: "sim-hyperion-star",
      harness: "claude",
      label: "Hyperion Cluster Coordinator",
      isCustomLabel: true,
      project: "hyperion-cloud",
      cwd: "C:/code/hyperion-cloud",
      branch: "swarm/cluster",
      model: "claude-opus-4-6[1m]",
      timestamp: now,
      isSimulated: true,
    });
    this.store.recordUserPrompt(hyperionId, "Deploy distributed microservice cluster", now);
    this.store.recordTurnPhase(hyperionId, "thinking", now);
    this.store.recordTokenUsage(hyperionId, {
      contextTokens: 880_000,
      contextMaxTokens: 1_000_000,
      cumulativeTotalTokens: 1_840_000,
      cumulativeOutputTokens: 215_000,
    });
    this.store.recordSkill(hyperionId, "swarm", now, false);
    this.store.recordAssistantMilestone(
      hyperionId,
      "Coordinating 12 active planetary subagents across 2 orbital rings.",
      now - 800
    );

    // 12 active subagents: slots 0..7 on Ring 0, slots 8..11 on Ring 1
    const subNames = [
      "Nav Grid",
      "Auth Proxy",
      "Ingest Pipe",
      "Comms Mesh",
      "Trace Collector",
      "Load Shedder",
      "Edge Router",
      "Event Bus",
      "Worker Pool",
      "State Sync",
      "Blob Store",
      "Health Gate",
    ];
    subNames.forEach((sName, sIdx) => {
      const subId = `claude:sim-hyperion-star:sub:${sIdx}`;
      this.store.upsertNode({
        id: subId,
        rawId: `sub-${sIdx}`,
        harness: "claude",
        parentId: hyperionId,
        isSubagent: true,
        label: sName,
        isCustomLabel: true,
        project: "hyperion-cloud",
        timestamp: now - sIdx * 5000,
        isSimulated: true,
      });
      this.store.recordTurnPhase(subId, "thinking", now);
      if (sIdx % 2 !== 0) {
        this.store.recordToolStart(subId, {
          callId: `tool-${sIdx}`,
          name: "Edit",
          target: `src/cluster/${sName.toLowerCase().replace(/\s+/g, "_")}.ts`,
          summary: `Update ${sName} telemetry`,
          linesAdded: 14 + sIdx * 2,
          linesRemoved: 3,
          timestamp: now,
          isLive: false,
        });
      }
    });

    // 20 completed asteroids in outer Kuiper Asteroid Field
    const interAsteroids = [
      "Bootstrapper",
      "Config Loader",
      "Schema Audit",
      "Preflight Check",
      "Key Vault",
      "DNS Resolver",
      "Mesh Router",
      "TLS Attester",
      "Shard Balancer",
      "Packet Framer",
      "CRC Validator",
      "State Hydrator",
      "Telemetry Sink",
      "Cache Warmer",
      "Quota Guard",
      "Queue Drainer",
      "Snapshot Archiver",
      "Codec Compiler",
      "Index Builder",
      "Health Prober",
    ];
    interAsteroids.forEach((astName, idx) => {
      const astId = `claude:sim-hyperion-star:ast:${idx}`;
      this.store.upsertNode({
        id: astId,
        rawId: `ast-${idx}`,
        harness: "claude",
        parentId: hyperionId,
        isSubagent: true,
        label: astName,
        isCustomLabel: true,
        project: "hyperion-cloud",
        timestamp: now - (idx + 1) * 40000,
        isSimulated: true,
      });
      this.store.markCompleted(astId, now - (idx + 1) * 40000, false);
    });

    // 6. Aurora-Engine: Recently Idle White Dwarf (< 90s idle, awake blinking eyes, warm resting)
    const auroraId = "antigravity:sim-aurora-star";
    this.store.upsertNode({
      id: auroraId,
      rawId: "sim-aurora-star",
      harness: "antigravity",
      label: "Shader Pipeline Compiler",
      isCustomLabel: true,
      project: "aurora-engine",
      cwd: "C:/code/aurora-engine",
      branch: "main",
      model: "gemini-2.5-pro",
      timestamp: now - 35000,
      isSimulated: true,
    });
    this.store.recordTurnPhase(auroraId, "idle", now - 35000);
    this.store.recordTokenUsage(auroraId, {
      contextTokens: 62_000,
      contextMaxTokens: 1_000_000,
      cumulativeTotalTokens: 195_000,
      cumulativeOutputTokens: 24_000,
    });
    this.store.recordAssistantMilestone(
      auroraId,
      "Finished compiling 48 compute kernels. Resting calmly.",
      now - 30000
    );
  }

  public clear(): void {
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();
    this.store.clearSimulatedNodes();
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }
}
