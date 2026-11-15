# Adding a New Agent Provider (Harness)

[← Back to README](../README.md)

Agent Orbit's adapter layer is intentionally decoupled from the physics engine and canvas renderer. If another coding agent writes local `.jsonl` (or structured log) transcripts on disk, you can add support in **6 small steps**:

### 1. Register the Harness Identifier & Context Window Defaults (`src/shared/types.ts`)
Add your provider key (for example, `"aider"` or `"cursor"`) to `HarnessKind` and `inferContextWindowMax`:

```ts
export type HarnessKind = "claude" | "codex" | "antigravity" | "strata" | "myagent";
```

### 2. Create a Line Adapter (`src/main/adapters/myagentAdapter.ts`)
Implement two pure functions — a path parser and a single-line ingester that mutates `GraphStore`:

```ts
import { GraphStore } from "../graphStore";

export interface MyAgentFileContext {
  filePath: string;
  sessionId: string;
  nodeId: string;
  parentId?: string;
}

export function parseMyAgentFilePath(filePath: string): MyAgentFileContext | null {
  const norm = filePath.replace(/\\/g, "/");
  const m = norm.match(/\/\.myagent\/sessions\/([^/]+)\.jsonl$/i);
  if (!m) return null;
  return {
    filePath,
    sessionId: m[1],
    nodeId: `myagent:${m[1]}`,
  };
}

export function ingestMyAgentLine(
  ctx: MyAgentFileContext,
  line: string,
  store: GraphStore,
  fallbackTs: number,
  isLive: boolean
): void {
  if (!line || line[0] !== "{") return;
  let evt: any;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }

  const ts = typeof evt.timestamp === "number" ? evt.timestamp : fallbackTs;

  // 1) Ensure session (or subagent) node exists
  store.upsertNode({
    id: ctx.nodeId,
    rawId: ctx.sessionId,
    harness: "myagent",
    parentId: ctx.parentId,
    isSubagent: Boolean(ctx.parentId),
    cwd: evt.cwd,
    model: evt.model,
    timestamp: ts,
  });

  // 2) Map lifecycle & tool events onto GraphStore primitives:
  if (evt.type === "user_prompt") {
    store.recordUserPrompt(ctx.nodeId, evt.text, ts);
    store.recordTurnPhase(ctx.nodeId, "thinking", ts);
  } else if (evt.type === "tool_start") {
    store.recordToolStart(ctx.nodeId, {
      callId: evt.callId,
      name: evt.toolName,
      target: evt.summary,
      filePath: evt.filePath,
      rawCommand: evt.command,
      timestamp: ts,
      isLive,
    });
  } else if (evt.type === "tool_end") {
    store.recordToolEnd(ctx.nodeId, {
      callId: evt.callId,
      isError: Boolean(evt.isError),
      output: evt.output,
      timestamp: ts,
      isLive,
    });
  } else if (evt.type === "turn_end") {
    store.recordModelTurn(ctx.nodeId, evt.turnId);
    if (evt.usage) {
      store.recordTokenUsage(ctx.nodeId, {
        contextTokens: evt.usage.inputTokens + evt.usage.outputTokens,
        outputTokensDelta: evt.usage.outputTokens,
      });
    }
    if (ctx.parentId) {
      store.markCompleted(ctx.nodeId, ts, isLive);
    } else {
      store.recordTurnPhase(ctx.nodeId, "waiting_on_user", ts);
    }
  }
}
```

### 3. Wire Discovery & Watching in `TranscriptTailer` (`src/main/tailer.ts`)
- Add a `collectMyAgentSessions` / `collectMyAgentSessionsAsync` directory scan (you can reuse `this.walkRecentJsonlSync` / `this.walkRecentJsonlAsync` just like `collectStrataSessions` does).
- Add your root directory to `setupDirectoryWatchers()`.
- Match `parseMyAgentFilePath(filePath)` inside `tryRegisterFile()` and dispatch lines to `ingestMyAgentLine(...)` inside `processLine()`.

### 4. Add Palette Color & Footer Filter Pill (`src/renderer/`)
- Add the provider's star/corona hex color to `HARNESS_COLORS` in `src/renderer/physics.ts`.
- Add its count entry in `src/renderer/app.ts` (`harnessCounts`) and a `<span class="leg" data-harness="myagent">` filter pill in `src/renderer/index.html` + `src/main/tray.ts` (`harnessDisplayName`).

### 5. *(Optional)* Add Window-Focus Hints (`scripts/FocusHelper.cs`)
If your agent runs inside a dedicated desktop app or terminal title pattern on Windows, add its process/window-title scoring rules in `scripts/FocusHelper.cs` so double-clicking its star jumps straight to that window.

### 6. Add Adapter Unit Tests (`src/test/telemetry.test.ts` & `src/test/backendFeatures.test.ts`)
Feed representative `.jsonl` lines directly into `ingestMyAgentLine(ctx, line, store, now, true)` and assert node status transitions, subagent parent linking, token gauges, and semantic badges with `npm test`.

---

## Related Docs

- [User Guide & Visual Mechanics](guide.md)
- [Architecture & Internals](architecture.md)
