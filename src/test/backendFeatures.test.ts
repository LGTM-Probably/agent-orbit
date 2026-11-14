import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ingestAntigravityLine,
  parseAntigravityFilePath,
} from "../main/adapters/antigravityAdapter";
import {
  ingestClaudeLine,
  parseClaudeFilePath,
} from "../main/adapters/claudeAdapter";
import {
  ingestCodexLine,
  parseCodexFilePath,
} from "../main/adapters/codexAdapter";
import {
  ingestStrataLine,
  parseStrataFilePath,
} from "../main/adapters/strataAdapter";
import {
  GraphStore,
  resolveOpenableFilePath,
  sanitizeExternalHttpUrl,
  shouldRevealInsteadOfExecute,
} from "../main/graphStore";
import { SwarmSimulator } from "../main/simulator";
import { inferContextWindowMax } from "../shared/types";

describe("Context-Window & Token Burn Tracking", () => {
  it("parses Claude assistant usage additively and deduplicates streaming lines sharing message.id", () => {
    const store = new GraphStore();
    const ctx = parseClaudeFilePath(
      "C:/Users/dev/.claude/projects/demo/sess-claude-1.jsonl"
    );
    assert.ok(ctx);
    const now = Date.now();

    // Streaming chunk 1 for msg_01
    ingestClaudeLine(
      ctx,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(now).toISOString(),
        cwd: "C:/repo/demo",
        message: {
          id: "msg_01",
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 12_000,
            cache_creation_input_tokens: 8_000,
            cache_read_input_tokens: 30_000,
            output_tokens: 50,
          },
          content: [{ type: "thinking", thinking: "Analyzing..." }],
        },
      }),
      store,
      now,
      true
    );

    let snap = store.getSnapshot(now);
    let node = snap.nodes.find(n => n.id === "claude:sess-claude-1");
    assert.ok(node?.tokenUsage);
    assert.equal(node.tokenUsage.contextTokens, 50_050);
    assert.equal(node.tokenUsage.contextMaxTokens, 400_000);
    assert.equal(node.tokenUsage.contextPercent, 13);
    assert.equal(node.tokenUsage.totalTokens, 50_050);
    assert.equal(node.tokenUsage.outputTokens, 50);

    // Final streaming chunk 2 for same msg_01 (output grew from 50 -> 950)
    ingestClaudeLine(
      ctx,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(now + 500).toISOString(),
        cwd: "C:/repo/demo",
        message: {
          id: "msg_01",
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 12_000,
            cache_creation_input_tokens: 8_000,
            cache_read_input_tokens: 30_000,
            output_tokens: 950,
          },
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "Edit",
              input: {
                file_path: "src/main/app.ts",
                old_string: "const a = 1;",
                new_string: "const a = 2;",
              },
            },
          ],
        },
      }),
      store,
      now + 500,
      true
    );

    snap = store.getSnapshot(now + 500);
    node = snap.nodes.find(n => n.id === "claude:sess-claude-1");
    assert.ok(node?.tokenUsage);
    // Deduplicated: 50_000 input + 950 output = 50_950 (not 101_000!)
    assert.equal(node.tokenUsage.contextTokens, 50_950);
    assert.equal(node.tokenUsage.totalTokens, 50_950);
    assert.equal(node.tokenUsage.outputTokens, 950);

    // Turn 2 (msg_02) with 1M model variant updates contextMaxTokens dynamically
    ingestClaudeLine(
      ctx,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(now + 1500).toISOString(),
        cwd: "C:/repo/demo",
        message: {
          id: "msg_02",
          model: "claude-opus-4-6[1m]",
          usage: {
            input_tokens: 4_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 55_000,
            output_tokens: 1_000,
          },
          content: [{ type: "text", text: "All done." }],
        },
      }),
      store,
      now + 1500,
      true
    );

    snap = store.getSnapshot(now + 1500);
    node = snap.nodes.find(n => n.id === "claude:sess-claude-1");
    assert.ok(node?.tokenUsage);
    assert.equal(node.tokenUsage.contextTokens, 60_000);
    assert.equal(node.tokenUsage.contextMaxTokens, 1_000_000);
    assert.equal(node.tokenUsage.contextPercent, 6);
    assert.equal(node.tokenUsage.totalTokens, 50_950 + 60_000);
    assert.equal(node.tokenUsage.outputTokens, 1_950);
  });

  it("parses Codex event_msg token_count without double-counting cached_input_tokens", () => {
    const store = new GraphStore();
    const ctx = parseCodexFilePath(
      "C:/Users/dev/.codex/sessions/2026/11/12/rollout-2026-11-12T01-00-00-01a1c803-74b6-7a31-bb74-21470f547527.jsonl"
    );
    assert.ok(ctx);
    const now = Date.now();

    ingestCodexLine(
      ctx,
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date(now).toISOString(),
        payload: {
          type: "token_count",
          info: {
            model_context_window: 258_400,
            last_token_usage: {
              input_tokens: 180_000,
              cached_input_tokens: 140_000,
              output_tokens: 6_000,
              total_tokens: 186_000,
            },
            total_token_usage: {
              input_tokens: 580_000,
              cached_input_tokens: 460_000,
              output_tokens: 40_000,
              total_tokens: 620_000,
            },
          },
        },
      }),
      store,
      now,
      true
    );

    const snap = store.getSnapshot(now);
    const node = snap.nodes.find(n => n.id === ctx.nodeId);
    assert.ok(node?.tokenUsage);
    assert.equal(node.tokenUsage.contextTokens, 186_000);
    assert.equal(node.tokenUsage.contextMaxTokens, 258_400);
    assert.equal(node.tokenUsage.contextPercent, Math.round((186_000 / 258_400) * 100));
    assert.equal(node.tokenUsage.totalTokens, 620_000);
    assert.equal(node.tokenUsage.outputTokens, 40_000);
  });

  it("parses Antigravity PLANNER_RESPONSE additive input_tokens + cache_read_tokens + output_tokens and deduplicates step_index", () => {
    const store = new GraphStore();
    const ctx = parseAntigravityFilePath(
      "C:/Users/dev/.gemini/antigravity/brain/conv-agy-1/.system_generated/logs/transcript.jsonl"
    );
    assert.ok(ctx);
    const now = Date.now();

    const stepLine = JSON.stringify({
      step_index: 7,
      type: "PLANNER_RESPONSE",
      created_at: new Date(now).toISOString(),
      input_tokens: 24_000,
      cache_read_tokens: 96_000,
      output_tokens: 2_500,
      tool_calls: [
        {
          name: "edit_file",
          args: {
            Path: "C:/repo/agent-orbit/src/main/graphStore.ts",
            Target: "old",
            Replacement: "new",
          },
        },
      ],
    });

    // Ingest from compact transcript.jsonl and again from transcript_full.jsonl
    ingestAntigravityLine(ctx, stepLine, store, now, true);
    ingestAntigravityLine(ctx, stepLine, store, now + 10, false);

    const snap = store.getSnapshot(now + 20);
    const node = snap.nodes.find(n => n.id === "antigravity:conv-agy-1");
    assert.ok(node?.tokenUsage);
    assert.equal(node.tokenUsage.contextTokens, 122_500);
    assert.equal(node.tokenUsage.contextMaxTokens, 1_000_000);
    assert.equal(node.tokenUsage.contextPercent, 12);
    // Deduplicated across step_index=7!
    assert.equal(node.tokenUsage.totalTokens, 122_500);
    assert.equal(node.tokenUsage.outputTokens, 2_500);
  });

  it("parses Strata token usage and populates Cosmic Showcase token gauges", () => {
    const store = new GraphStore();
    const ctx = parseStrataFilePath(
      "C:/Users/dev/.strata/data/agent/home/sessions/proj/strata-sess-1/session.v4.jsonl"
    );
    assert.ok(ctx);
    const now = Date.now();

    ingestStrataLine(
      ctx,
      JSON.stringify({
        type: "request/header",
        time: now,
        data: { header: { config: { model: "qwen-2.5-coder" } } },
      }),
      store,
      now,
      false
    );

    ingestStrataLine(
      ctx,
      JSON.stringify({
        id: "turn-1",
        type: "assistant/message",
        time: now + 100,
        data: {
          message: { content: "Implemented worker fix." },
          usage: {
            prompt_tokens: 32_000,
            completion_tokens: 768,
            total_tokens: 32_768,
          },
        },
      }),
      store,
      now + 100,
      true
    );

    const snap = store.getSnapshot(now + 200);
    const strataNode = snap.nodes.find(n => n.id === "strata:strata-sess-1");
    assert.ok(strataNode?.tokenUsage);
    assert.equal(strataNode.tokenUsage.contextMaxTokens, 131_072);
    assert.equal(strataNode.tokenUsage.contextTokens, 32_768);
    assert.equal(strataNode.tokenUsage.contextPercent, 25);

    // Verify Cosmic Showcase sets expected token gauges (including >=80% warning star)
    const sim = new SwarmSimulator(store);
    sim.spawnCosmicShowcase();
    const simSnap = store.getSnapshot(Date.now());
    const hyperionStar = simSnap.nodes.find(n => n.id === "claude:sim-hyperion-star");
    assert.ok(hyperionStar?.tokenUsage);
    assert.equal(hyperionStar.tokenUsage.contextPercent, 88);
    assert.equal(hyperionStar.tokenUsage.totalTokens, 1_840_000);

    const hyperionCompletedSubs = simSnap.nodes.filter(
      n => n.parentId === "claude:sim-hyperion-star" && n.status === "completed"
    );
    const claudeCompletedSubs = simSnap.nodes.filter(
      n => n.parentId === "claude:sim-claude-star" && n.status === "completed"
    );
    assert.equal(hyperionCompletedSubs.length, 20);
    assert.equal(claudeCompletedSubs.length, 12);
    sim.clear();
  });

  it("infers context window caps for modern models, fallbacks, and dynamic promotion", () => {
    // Claude models
    assert.equal(inferContextWindowMax("claude", "claude-opus-4-6[1m]"), 1_000_000);
    assert.equal(inferContextWindowMax("claude", "claude-opus-4-6"), 400_000);
    assert.equal(inferContextWindowMax("claude", "claude-sonnet-4-5"), 200_000);
    assert.equal(inferContextWindowMax("claude", undefined), 400_000);

    // OpenAI / Codex models
    assert.equal(inferContextWindowMax("codex", "gpt-5-codex"), 258_400);
    assert.equal(inferContextWindowMax("codex", "gpt-4.1"), 1_000_000);
    assert.equal(inferContextWindowMax("codex", undefined), 258_400);

    // Gemini / Antigravity models
    assert.equal(inferContextWindowMax("antigravity", undefined), 1_000_000);
    assert.equal(inferContextWindowMax("antigravity", "gemini-2.5-pro"), 1_000_000);

    // Open-weights / Strata
    assert.equal(inferContextWindowMax("strata", "qwen"), 131_072);

    // Dynamic promotion with observedContextTokens
    assert.equal(
      inferContextWindowMax("claude", "claude-sonnet-4-5", undefined, 550_000),
      1_000_000
    );
    assert.equal(
      inferContextWindowMax("strata", "custom-model", undefined, 250_000),
      258_400
    );
    assert.equal(
      inferContextWindowMax("strata", "custom-model", undefined, 2_250_000),
      2_300_000
    );
  });

  it("handles Claude compact_boundary by resetting contextTokens and ensuring 400k max", () => {
    const store = new GraphStore();
    const ctx = parseClaudeFilePath(
      "C:/Users/dev/.claude/projects/demo/sess-compact-test.jsonl"
    );
    assert.ok(ctx);
    const now = Date.now();

    // Initial usage near compaction threshold (~368k)
    ingestClaudeLine(
      ctx,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(now).toISOString(),
        message: {
          id: "msg_pre_compact",
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 360_000,
            output_tokens: 8_021,
          },
          content: [{ type: "text", text: "Working..." }],
        },
      }),
      store,
      now,
      true
    );

    let snap = store.getSnapshot(now);
    let node = snap.nodes.find(n => n.id === ctx.nodeId);
    assert.ok(node?.tokenUsage);
    assert.equal(node.tokenUsage.contextTokens, 368_021);
    assert.equal(node.tokenUsage.contextMaxTokens, 400_000);

    // Auto-compaction event
    ingestClaudeLine(
      ctx,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        timestamp: new Date(now + 1000).toISOString(),
        compactMetadata: {
          trigger: "auto",
          preTokens: 368021,
          postTokens: 24325,
        },
      }),
      store,
      now + 1000,
      true
    );

    snap = store.getSnapshot(now + 1000);
    node = snap.nodes.find(n => n.id === ctx.nodeId);
    assert.ok(node?.tokenUsage);
    assert.equal(node.tokenUsage.contextTokens, 24325);
    assert.equal(node.tokenUsage.contextMaxTokens, 400_000);
    assert.equal(node.tokenUsage.contextPercent, 6);
  });

  it("handles Antigravity CHECKPOINT compaction and step model extraction", () => {
    const store = new GraphStore();
    const ctx = parseAntigravityFilePath(
      "C:/Users/dev/.gemini/antigravity/brain/conv-checkpoint-test/.system_generated/logs/transcript.jsonl"
    );
    assert.ok(ctx);
    const now = Date.now();

    // Ingest CHECKPOINT line with model metadata
    ingestAntigravityLine(
      ctx,
      JSON.stringify({
        step_index: 12,
        type: "CHECKPOINT",
        model: "gemini-2.5-pro",
        created_at: new Date(now).toISOString(),
        input_tokens: 45_000,
        cache_read_tokens: 120_000,
        output_tokens: 15_000,
      }),
      store,
      now,
      true
    );

    const snap = store.getSnapshot(now);
    const node = snap.nodes.find(n => n.id === ctx.nodeId);
    assert.ok(node);
    assert.equal(node.model, "gemini-2.5-pro");
    assert.ok(node.tokenUsage);
    assert.equal(node.tokenUsage.contextTokens, 15_000);
    assert.equal(node.tokenUsage.totalTokens, 180_000);
    assert.equal(node.tokenUsage.outputTokens, 15_000);
    assert.equal(node.tokenUsage.contextMaxTokens, 1_000_000);
  });
});

describe("File Path Preservation & resolveOpenableFilePath", () => {
  it("resolves Windows paths, relative paths + cwd, Git Bash /c/... paths, file:/// URIs, and line/col suffixes", () => {
    const winAbs = resolveOpenableFilePath(
      "  \"C:/Users/dev/project/src/index.ts:128:14\"  "
    );
    assert.equal(winAbs, path.normalize("C:/Users/dev/project/src/index.ts"));

    const uriResolved = resolveOpenableFilePath(
      "file:///C:/Users/dev/My%20Project/src/view.tsx#L10-L25"
    );
    assert.equal(
      uriResolved,
      path.normalize("C:/Users/dev/My Project/src/view.tsx")
    );

    const linesSuffix = resolveOpenableFilePath(
      "src/main/graphStore.ts (lines 1-50)",
      "C:/Users/dev/agent-orbit"
    );
    assert.equal(
      linesSuffix,
      path.normalize("C:/Users/dev/agent-orbit/src/main/graphStore.ts")
    );

    // Relative path without cwd cannot be resolved safely
    assert.equal(resolveOpenableFilePath("src/main/graphStore.ts"), null);

    // Home directory expansion
    const homeExpanded = resolveOpenableFilePath("~/Desktop/notes.md#L4");
    assert.equal(homeExpanded, path.normalize(path.join(os.homedir(), "Desktop/notes.md")));

    if (process.platform === "win32") {
      const gitBash = resolveOpenableFilePath(
        "/c/Users/dev/scratch/agent-orbit/src/main/main.ts:45"
      );
      assert.equal(
        gitBash?.toLowerCase(),
        path.normalize("c:/Users/dev/scratch/agent-orbit/src/main/main.ts").toLowerCase()
      );
    }
  });

  it("preserves ActivityLogEntry.filePath across adapters and GraphStore.getSnapshot({ stripHeavyLogFields: true })", () => {
    const store = new GraphStore();
    const now = Date.now();

    // 1. Codex apply_patch extracts firstFile -> filePath
    const codexCtx = parseCodexFilePath(
      "C:/Users/dev/.codex/sessions/rollout-2026-11-12T01-00-00-11111111-2222-3333-4444-555555555555.jsonl"
    );
    assert.ok(codexCtx);
    ingestCodexLine(
      codexCtx,
      JSON.stringify({
        type: "response_item",
        timestamp: new Date(now).toISOString(),
        payload: {
          type: "custom_tool_call",
          call_id: "patch-1",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: src/renderer/canvas.ts\n@@\n-old\n+new\n*** End Patch",
        },
      }),
      store,
      now,
      true
    );

    // 2. Antigravity TargetFile / Path preserved even when summary is set
    const agyCtx = parseAntigravityFilePath(
      "C:/Users/dev/.gemini/antigravity/brain/conv-fp/.system_generated/logs/transcript.jsonl"
    );
    assert.ok(agyCtx);
    ingestAntigravityLine(
      agyCtx,
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: new Date(now + 10).toISOString(),
        tool_calls: [
          {
            name: "write_file",
            args: {
              TargetFile: "C:/Users/dev/plan.md",
              Content: "# Plan\n- Step 1",
              ArtifactMetadata: {
                Summary: "Implementation plan for telemetry",
                UserFacing: true,
                RequestFeedback: false,
              },
            },
          },
        ],
      }),
      store,
      now + 10,
      true
    );

    // 3. Direct recordToolStart inference for READ/EDIT/WRITE/PLAN vs non-inference for Bash
    store.upsertNode({
      id: "claude:direct-test",
      rawId: "direct-test",
      harness: "claude",
      cwd: "C:/repo",
      timestamp: now + 20,
    });
    store.recordToolStart("claude:direct-test", {
      callId: "read-1",
      name: "Read",
      target: "packages/core/deep/nested/very/long/path/moduleConfig.ts",
      fullText: "heavy content that gets stripped",
      timestamp: now + 20,
      isLive: true,
    });
    store.recordToolStart("claude:direct-test", {
      callId: "bash-ls",
      name: "Bash",
      target: "ls -la /tmp",
      rawCommand: "ls -la /tmp",
      timestamp: now + 30,
      isLive: true,
    });

    const wireSnap = store.getSnapshot(now + 50, { stripHeavyLogFields: true });
    const patchEntry = wireSnap.activityLog.find(e => e.title === "apply_patch");
    assert.equal(patchEntry?.filePath, "src/renderer/canvas.ts");
    assert.equal(patchEntry?.diffPreview, undefined); // heavy field stripped
    assert.equal(patchEntry?.hasDiffPreview, true);

    const agyEntry = wireSnap.activityLog.find(e => e.title === "write_file");
    assert.equal(agyEntry?.filePath, "C:/Users/dev/plan.md");
    assert.equal(agyEntry?.badge, "PLAN");

    const inferredRead = wireSnap.activityLog.find(e => e.title === "Read");
    assert.equal(
      inferredRead?.filePath,
      "packages/core/deep/nested/very/long/path/moduleConfig.ts"
    );
    assert.equal(inferredRead?.fullText, undefined); // stripped on wire

    const bashEntry = wireSnap.activityLog.find(e => e.title === "Bash");
    assert.equal(bashEntry?.filePath, undefined);
  });

  it("blocks UNC network paths, flags executable extensions for safe folder reveal, and sanitizes external URLs", () => {
    // Reject UNC paths and embedded null bytes
    assert.equal(resolveOpenableFilePath("\\\\attacker.example\\share\\payload.txt"), null);
    assert.equal(resolveOpenableFilePath("//attacker.example/share/payload.txt"), null);
    assert.equal(resolveOpenableFilePath("C:/Users/dev/notes.txt\0.exe"), null);

    // Executable, script-host, shortcut, and installer extensions reveal instead of ShellExecute
    assert.equal(shouldRevealInsteadOfExecute("C:/repo/setup.exe"), true);
    assert.equal(shouldRevealInsteadOfExecute("C:/repo/deploy.BAT"), true);
    assert.equal(shouldRevealInsteadOfExecute("C:/repo/script.ps1"), true);
    assert.equal(shouldRevealInsteadOfExecute("C:/repo/shortcut.lnk"), true);
    assert.equal(shouldRevealInsteadOfExecute("C:/repo/tricky.cmd. "), true);
    assert.equal(shouldRevealInsteadOfExecute("C:/repo/readme.txt:hidden.exe"), true);

    // Source code and docs remain safe to open directly in user's editor
    assert.equal(shouldRevealInsteadOfExecute("C:/repo/src/main.ts"), false);
    assert.equal(shouldRevealInsteadOfExecute("C:/repo/README.md"), false);
    assert.equal(shouldRevealInsteadOfExecute("C:/repo/package.json"), false);

    // External URL sanitization
    assert.equal(
      sanitizeExternalHttpUrl("https://github.com/acme-org/nebula-cloud/pull/42"),
      "https://github.com/acme-org/nebula-cloud/pull/42"
    );
    assert.equal(sanitizeExternalHttpUrl("javascript:alert(1)"), null);
    assert.equal(sanitizeExternalHttpUrl("file:///C:/Windows/System32/calc.exe"), null);
    assert.equal(sanitizeExternalHttpUrl("https://user:secret@example.com/pr"), null);
  });
});
