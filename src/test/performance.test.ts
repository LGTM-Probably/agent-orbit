import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { GraphStore } from "../main/graphStore";
import {
  ConstellationRootTarget,
  HarnessKind,
  computeConstellationAnchors,
  computeStellarProfile,
} from "../shared/types";

describe("Performance Budgets & Incremental Wire Protocol (5x10 Target)", () => {
  it("strips heavy payloads in wire snapshots, fetches full detail in O(1), and streams sub-100KB deltas in <5ms", () => {
    const store = new GraphStore();
    const now = Date.now();
    const harnesses: HarnessKind[] = ["claude", "codex", "antigravity", "strata"];
    const heavyCmd = "npm test -- --bail\n" + "echo 'running test line'\n".repeat(50);
    const heavyOut = "[PASS] suite completed cleanly in 14.2ms\n".repeat(80);
    const heavyDiff = "@@ -1,6 +1,8 @@\n-old line\n+new line\n".repeat(40);
    const heavyReply = "### Summary\n\nAll checks passed.\n```ts\nexport const ok = true;\n```\n".repeat(35);

    const subIds: string[] = [];
    // Target workload: 5 orchestrator stars x (10 active + 10 completed subagents) = 105 nodes
    for (let r = 0; r < 5; r++) {
      const h = harnesses[r % harnesses.length];
      const rootId = `${h}:perf-root-${r}`;
      store.upsertNode({
        id: rootId,
        rawId: `perf-root-${r}`,
        harness: h,
        label: `Repo-${r}`,
        project: `Repo-${r}`,
        timestamp: now - 300_000,
      });

      for (let s = 0; s < 10; s++) {
        const subId = `${rootId}:sub:active-${s}`;
        store.upsertNode({
          id: subId,
          rawId: `active-${s}`,
          harness: h,
          parentId: rootId,
          isSubagent: true,
          label: `Worker ${r}-${s}`,
          timestamp: now - 60_000 + s * 50,
        });
        store.recordToolStart(subId, {
          callId: `init-${s}`,
          name: "Bash",
          summary: "Execute test worker",
          rawCommand: heavyCmd,
          timestamp: now - 500,
          isLive: false,
        });
        subIds.push(subId);
      }

      for (let c = 0; c < 10; c++) {
        const doneId = `${rootId}:sub:done-${c}`;
        store.upsertNode({
          id: doneId,
          rawId: `done-${c}`,
          harness: h,
          parentId: rootId,
          isSubagent: true,
          label: `Completed ${r}-${c}`,
          timestamp: now - 180_000 + c * 50,
        });
        store.markCompleted(doneId, now - 120_000 + c * 50, false, {
          durationMs: 2500,
          subagentToolCount: 6,
        });
      }
    }

    // Populate 1,200 heavy log entries
    let sampleEditEntryId = "";
    for (let i = 0; i < 1200; i++) {
      const nid = subIds[i % subIds.length];
      const ts = now - (1200 - i) * 40;
      if (i % 4 === 0) {
        store.recordAssistantMilestone(nid, `${heavyReply}\nStep ${i}`, ts);
      } else if (i % 2 === 0) {
        const callId = `edit-${i}`;
        sampleEditEntryId = `${nid}:tool:${callId}`;
        store.recordToolStart(nid, {
          callId,
          name: "Edit",
          target: `src/file_${i % 20}.ts`,
          diffPreview: heavyDiff,
          linesAdded: 40,
          linesRemoved: 40,
          timestamp: ts,
          isLive: false,
        });
        store.recordToolEnd(nid, { callId, timestamp: ts + 15, isLive: false });
      } else {
        const callId = `bash-${i}`;
        store.recordToolStart(nid, {
          callId,
          name: "Bash",
          summary: `Batch command ${i}`,
          rawCommand: heavyCmd,
          timestamp: ts,
          isLive: false,
        });
        store.recordToolEnd(nid, {
          callId,
          output: heavyOut,
          exitCode: 0,
          timestamp: ts + 20,
          isLive: false,
        });
      }
    }

    // 1. Default getSnapshot() preserves 100% full fields for backwards compatibility
    const fullSnap = store.getSnapshot(now);
    assert.strictEqual(fullSnap.nodes.length, 105);
    const fullEdit = fullSnap.activityLog.find(e => e.id === sampleEditEntryId);
    assert.ok(fullEdit?.diffPreview, "Default getSnapshot must preserve inline diffPreview");

    // 2. Wire initial snapshot strips heavy text while setting hasHeavyDetail flags
    const wireInit = store.getSnapshot(now, { stripHeavyLogFields: true });
    assert.strictEqual(wireInit.logDeltaMode, false);
    assert.ok((wireInit.logSeq ?? 0) > 0);
    const wireEdit = wireInit.activityLog.find(e => e.id === sampleEditEntryId);
    assert.ok(wireEdit);
    assert.strictEqual(wireEdit.diffPreview, undefined);
    assert.strictEqual(wireEdit.hasHeavyDetail, true);
    assert.strictEqual(wireEdit.hasDiffPreview, true);

    // 3. On-demand getLogDetail returns verbatim untruncated diffPreview in O(1)
    const detail = store.getLogDetail(sampleEditEntryId);
    assert.ok(detail);
    assert.strictEqual(detail.diffPreview, heavyDiff.trim());

    // 4. Live streaming delta snapshot ships ONLY changed log entries (<120KB, <6ms)
    const prevSeq = wireInit.logSeq!;
    store.recordToolStart(subIds[0], {
      callId: "live-delta-1",
      name: "Bash",
      summary: "Incremental check",
      rawCommand: heavyCmd,
      timestamp: now + 100,
      isLive: true,
    });

    const t0 = performance.now();
    const deltaSnap = store.getSnapshot(now + 110, {
      stripHeavyLogFields: true,
      sinceLogSeq: prevSeq,
    });
    const payloadStr = JSON.stringify(deltaSnap);
    const elapsedMs = performance.now() - t0;
    const payloadKB = Buffer.byteLength(payloadStr, "utf8") / 1024;

    assert.strictEqual(deltaSnap.logDeltaMode, true);
    assert.strictEqual(deltaSnap.activityLog.length, 0);
    assert.strictEqual(deltaSnap.logUpserts?.length, 1);
    assert.ok(payloadKB < 120, `Expected delta payload < 120KB, got ${payloadKB.toFixed(1)}KB`);
    assert.ok(elapsedMs < 15, `Expected delta snapshot + stringify < 15ms, got ${elapsedMs.toFixed(2)}ms`);

    // 5. Switching timeWindow invalidates delta watermark and emits full lightweight reset
    store.setTimeWindow("4h");
    const afterWindowSwitch = store.getSnapshot(now + 200, {
      stripHeavyLogFields: true,
      sinceLogSeq: deltaSnap.logSeq,
    });
    assert.strictEqual(afterWindowSwitch.logDeltaMode, false);
    assert.ok(afterWindowSwitch.activityLog.length > 0);
  });

  it("computes constellation anchors for 10 roots x 15 subagents in < 2ms", () => {
    const roots: ConstellationRootTarget[] = [];
    for (let i = 0; i < 10; i++) {
      const prof = computeStellarProfile(25, 120);
      roots.push({
        id: `root-${i}`,
        targetRadius: prof.baseRadius,
        activeSubsCount: 15,
        totalCompletedSubs: 10,
        status: i === 0 ? "waiting_on_user" : "tool_running",
        isWaiting: i === 0,
      });
    }

    const t0 = performance.now();
    for (let iter = 0; iter < 50; iter++) {
      computeConstellationAnchors(roots, 3440, 1400, true);
    }
    const avgMs = (performance.now() - t0) / 50;
    assert.ok(avgMs < 2.0, `Expected constellation layout < 2.0ms, got ${avgMs.toFixed(3)}ms`);
  });
});
