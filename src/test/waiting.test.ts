import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBlockingUserTool,
  computeConstellationAnchors,
  computeSpotlightHorizonY,
  ConstellationRootTarget,
  getSystemReach,
} from "../shared/types";
import { GraphStore, truncateWaitingPrompt } from "../main/graphStore";
import { ingestClaudeLine } from "../main/adapters/claudeAdapter";
import { ingestAntigravityLine } from "../main/adapters/antigravityAdapter";
import { ingestCodexLine } from "../main/adapters/codexAdapter";
import { ingestStrataLine } from "../main/adapters/strataAdapter";

describe("Waiting Detection, Spotlight Anchors & Taskbar Badges", () => {
  describe("1. classifyBlockingUserTool pure helper", () => {
    it("classifies questions from Claude, Antigravity, Codex and Release Boards", () => {
      assert.strictEqual(classifyBlockingUserTool("AskUserQuestion"), "question");
      assert.strictEqual(classifyBlockingUserTool("ask_question"), "question");
      assert.strictEqual(classifyBlockingUserTool("request_user_input"), "question");
      assert.strictEqual(classifyBlockingUserTool("request_user_input_async"), "question");
      assert.strictEqual(classifyBlockingUserTool("board_wait_for_answers"), "question");
      assert.strictEqual(classifyBlockingUserTool("mcp__release-boards__board_wait_for_answers"), "question");
      assert.strictEqual(classifyBlockingUserTool("board_ask_question"), "question");
      assert.strictEqual(classifyBlockingUserTool("mcp__release-boards__board_ask_question"), "question");
      assert.strictEqual(classifyBlockingUserTool("board_ask_one_liner"), "question");
      assert.strictEqual(classifyBlockingUserTool("board_ask_asset_review"), "question");
      assert.strictEqual(
        classifyBlockingUserTool("call_mcp_tool", { mcpToolName: "board_ask_question" }),
        "question"
      );
    });

    it("classifies plan reviews and feedback requests", () => {
      assert.strictEqual(classifyBlockingUserTool("ExitPlanMode"), "plan_review");
      assert.strictEqual(
        classifyBlockingUserTool("write_file", { isArtifact: true, requestFeedback: true }),
        "plan_review"
      );
      assert.strictEqual(
        classifyBlockingUserTool("edit_file", { isArtifact: true, requestFeedback: true }),
        "plan_review"
      );
      assert.strictEqual(
        classifyBlockingUserTool("write_file", { isArtifact: true, requestFeedback: false }),
        null
      );
      assert.strictEqual(classifyBlockingUserTool("Bash"), null);
      assert.strictEqual(classifyBlockingUserTool("read_file"), null);
    });
  });

  describe("2. Immediate waiting_on_user on question tools even while inFlightTools > 0", () => {
    it("Claude AskUserQuestion puts root node into waiting_on_user with exact prompt", () => {
      const store = new GraphStore();
      const ctx = {
        filePath: "/projects/repo/session-claude.jsonl",
        sessionId: "session-claude",
        nodeId: "claude:session-claude",
      };

      const questionLine = JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-ask-claude-1",
              name: "AskUserQuestion",
              input: {
                questions: [{ question: "Do you prefer blue or amber stars?" }],
              },
            },
          ],
        },
      });

      ingestClaudeLine(ctx, questionLine, store, Date.now(), false);
      const snap = store.getSnapshot();
      const node = snap.nodes.find(n => n.id === "claude:session-claude");

      assert.ok(node);
      assert.strictEqual(node.status, "waiting_on_user");
      assert.strictEqual(node.waitingReason, "question");
      assert.strictEqual(node.waitingPrompt, "Do you prefer blue or amber stars?");
      assert.strictEqual(store.getNodeById("claude:session-claude")?.inFlightTools.size, 1);
    });

    it("Antigravity ask_question puts root node into waiting_on_user with exact prompt", () => {
      const store = new GraphStore();
      const ctx = {
        filePath: "/brain/conv-agy/.system_generated/logs/transcript.jsonl",
        convId: "conv-agy",
        nodeId: "antigravity:conv-agy",
        pendingSubagentRoles: [],
      };

      const questionLine = JSON.stringify({
        type: "PLANNER_RESPONSE",
        created_at: new Date().toISOString(),
        step_index: 3,
        tool_calls: [
          {
            name: "ask_question",
            args: {
              questions: [{ question: "Deploy directly to staging or run smoke tests first?" }],
            },
          },
        ],
      });

      ingestAntigravityLine(ctx, questionLine, store, Date.now(), false);
      const snap = store.getSnapshot();
      const node = snap.nodes.find(n => n.id === "antigravity:conv-agy");

      assert.ok(node);
      assert.strictEqual(node.status, "waiting_on_user");
      assert.strictEqual(node.waitingReason, "question");
      assert.strictEqual(
        node.waitingPrompt,
        "Deploy directly to staging or run smoke tests first?"
      );
      assert.strictEqual(store.getNodeById("antigravity:conv-agy")?.inFlightTools.size, 1);
    });

    it("Codex request_user_input puts root node into waiting_on_user with extracted prompt", () => {
      const store = new GraphStore();
      const ctx = {
        filePath: "/logs/rollout-2026-11-10T19-30-32-01a1c803-74b6-7a31-bb74-21470f547527.jsonl",
        sessionId: "01a1c803-74b6-7a31-bb74-21470f547527",
        nodeId: "codex:01a1c803-74b6-7a31-bb74-21470f547527",
      };

      const line = JSON.stringify({
        type: "response_item",
        timestamp: new Date().toISOString(),
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "codex-input-call",
          arguments: JSON.stringify({
            prompt: "Confirm deletion of legacy temporary branch?",
          }),
        },
      });

      ingestCodexLine(ctx, line, store, Date.now(), false);
      const snap = store.getSnapshot();
      const node = snap.nodes.find(n => n.id === "codex:01a1c803-74b6-7a31-bb74-21470f547527");

      assert.ok(node);
      assert.strictEqual(node.status, "waiting_on_user");
      assert.strictEqual(node.waitingReason, "question");
      assert.strictEqual(node.waitingPrompt, "Confirm deletion of legacy temporary branch?");
    });
  });

  describe("3. Antigravity write_file with ArtifactMetadata.RequestFeedback and ExitPlanMode", () => {
    it("sets plan_review waitingReason and prompt on turn end, and clears on USER_INPUT", () => {
      const store = new GraphStore();
      const ctx = {
        filePath: "/brain/conv-plan/.system_generated/logs/transcript.jsonl",
        convId: "conv-plan",
        nodeId: "antigravity:conv-plan",
        pendingSubagentRoles: [],
      };

      const planToolLine = JSON.stringify({
        type: "PLANNER_RESPONSE",
        created_at: new Date().toISOString(),
        step_index: 2,
        tool_calls: [
          {
            name: "write_file",
            args: {
              Path: "brain/conv-plan/arch.md",
              Content: "Architecture spec",
              ArtifactMetadata: {
                Summary: "Release architecture proposal",
                RequestFeedback: true,
                UserFacing: true,
              },
            },
          },
        ],
      });

      ingestAntigravityLine(ctx, planToolLine, store, Date.now(), false);

      const genericEndLine = JSON.stringify({
        type: "GENERIC",
        created_at: new Date().toISOString(),
        content: "File written successfully.",
        status: "DONE",
      });

      ingestAntigravityLine(ctx, genericEndLine, store, Date.now(), false);

      let snap = store.getSnapshot();
      let node = snap.nodes.find(n => n.id === "antigravity:conv-plan");
      assert.ok(node);
      assert.strictEqual(node.status, "waiting_on_user");
      assert.strictEqual(node.waitingReason, "plan_review");
      assert.strictEqual(node.waitingPrompt, "Release architecture proposal");

      // User responds with a prompt
      const userLine = JSON.stringify({
        type: "USER_INPUT",
        created_at: new Date().toISOString(),
        content: "<USER_REQUEST>Looks good, proceed!</USER_REQUEST>",
      });

      ingestAntigravityLine(ctx, userLine, store, Date.now(), false);
      snap = store.getSnapshot();
      node = snap.nodes.find(n => n.id === "antigravity:conv-plan");
      assert.ok(node);
      assert.strictEqual(node.status, "thinking");
      assert.strictEqual(node.waitingReason, undefined);
    });

    it("Claude ExitPlanMode sets plan_review waitingReason", () => {
      const store = new GraphStore();
      const ctx = {
        filePath: "/projects/repo/session-exitplan.jsonl",
        sessionId: "session-exitplan",
        nodeId: "claude:session-exitplan",
      };

      const exitPlanLine = JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-exitplan-1",
              name: "ExitPlanMode",
              input: {},
            },
          ],
        },
      });

      ingestClaudeLine(ctx, exitPlanLine, store, Date.now(), false);
      let snap = store.getSnapshot();
      let node = snap.nodes.find(n => n.id === "claude:session-exitplan");
      assert.ok(node);
      assert.strictEqual(node.status, "waiting_on_user");
      assert.strictEqual(node.waitingReason, "plan_review");
      assert.strictEqual(node.waitingPrompt, "Plan ready for approval");

      // Tool completes
      const resultLine = JSON.stringify({
        type: "user",
        timestamp: new Date().toISOString(),
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-exitplan-1",
              content: "User feedback requested.",
            },
          ],
        },
      });
      ingestClaudeLine(ctx, resultLine, store, Date.now(), false);

      snap = store.getSnapshot();
      node = snap.nodes.find(n => n.id === "claude:session-exitplan");
      assert.ok(node);
      assert.strictEqual(node.status, "waiting_on_user");
      assert.strictEqual(node.waitingReason, "plan_review");
    });
  });

  describe("4. Smart Subagent-Wait Suppression for Root Orchestrators", () => {
    it("suppresses waiting_on_user when root orchestrator has active subagents", () => {
      const store = new GraphStore();
      const rootId = "claude:root-orch-1";
      const subId1 = "claude:root-orch-1:sub:worker-a";
      const now = Date.now();

      store.upsertNode({
        id: rootId,
        rawId: "root-orch-1",
        harness: "claude",
        label: "Armada Orchestrator",
        timestamp: now,
      });

      store.upsertNode({
        id: subId1,
        rawId: "worker-a",
        harness: "claude",
        parentId: rootId,
        isSubagent: true,
        label: "Worker A",
        timestamp: now,
      });

      // Orchestrator finishes turn with assistant text (lastTurnPhase = waiting_on_user)
      store.recordAssistantMilestone(rootId, "Dispatched Worker A to compile shaders.", now);
      store.recordTurnPhase(rootId, "waiting_on_user", now);

      // Child subagent is actively thinking
      store.recordTurnPhase(subId1, "thinking", now);

      // Orchestrator status MUST be "thinking" (NOT "waiting_on_user") because child is active!
      let snap = store.getSnapshot(now);
      let orchNode = snap.nodes.find(n => n.id === rootId);
      assert.ok(orchNode);
      assert.strictEqual(
        orchNode.status,
        "thinking",
        "Orchestrator must stay 'thinking' while its subagent is active"
      );

      // Child subagent runs a tool
      store.recordToolStart(subId1, {
        callId: "tool-sub-1",
        name: "Bash",
        timestamp: now + 50,
        isLive: false,
      });

      snap = store.getSnapshot(now + 60);
      orchNode = snap.nodes.find(n => n.id === rootId);
      assert.strictEqual(orchNode?.status, "thinking");

      // Child finishes tool and marks completed
      store.recordToolEnd(subId1, {
        callId: "tool-sub-1",
        timestamp: now + 300,
        isLive: false,
      });
      store.markCompleted(subId1, now + 350, false);

      // Now all subagents have completed: orchestrator automatically transitions to waiting_on_user!
      snap = store.getSnapshot(now + 400);
      orchNode = snap.nodes.find(n => n.id === rootId);
      assert.ok(orchNode);
      assert.strictEqual(orchNode.status, "waiting_on_user");
      assert.strictEqual(orchNode.waitingReason, "turn_complete");
      assert.ok(orchNode.waitingPrompt?.includes("Dispatched Worker A"));
    });

    it("immediately triggers waiting_on_user if root orchestrator calls AskUserQuestion even with active subagents", () => {
      const store = new GraphStore();
      const rootId = "codex:root-orch-2";
      const subId = "codex:root-orch-2:sub:child-b";
      const now = Date.now();

      store.upsertNode({
        id: rootId,
        rawId: "root-orch-2",
        harness: "codex",
        label: "Codex Replay Orchestrator",
        timestamp: now,
      });

      store.upsertNode({
        id: subId,
        rawId: "child-b",
        harness: "codex",
        parentId: rootId,
        isSubagent: true,
        label: "Fuzz Worker",
        timestamp: now,
      });

      // Child is thinking
      store.recordTurnPhase(subId, "thinking", now);

      // Orchestrator starts AskUserQuestion tool
      store.recordToolStart(rootId, {
        callId: "ask-call-1",
        name: "AskUserQuestion",
        waitingPrompt: "Approve replay CRC check?",
        timestamp: now,
        isLive: false,
      });

      // Orchestrator MUST be waiting_on_user immediately despite active child!
      const snap = store.getSnapshot(now);
      const orchNode = snap.nodes.find(n => n.id === rootId);
      assert.ok(orchNode);
      assert.strictEqual(orchNode.status, "waiting_on_user");
      assert.strictEqual(orchNode.waitingReason, "question");
      assert.strictEqual(orchNode.waitingPrompt, "Approve replay CRC check?");
    });
  });

  describe("5. Top 'Awaiting You' Spotlight Lane Anchors (computeConstellationAnchors)", () => {
    it("places waiting stars strictly higher than all regular stars with >= 150px clearance", () => {
      const roots: ConstellationRootTarget[] = [
        { id: "wait-1", status: "waiting_on_user", targetRadius: 34, activeSubsCount: 1 },
        { id: "wait-2", isWaiting: true, targetRadius: 28, activeSubsCount: 0 },
        { id: "reg-1", status: "tool_running", targetRadius: 44, activeSubsCount: 4 },
        { id: "reg-2", status: "thinking", targetRadius: 32, activeSubsCount: 2 },
        { id: "reg-3", status: "idle", targetRadius: 22, activeSubsCount: 0 },
        { id: "reg-4", status: "completed", targetRadius: 24, activeSubsCount: 0 },
      ];

      const width = 1280;
      const height = 860;
      const anchors = computeConstellationAnchors(roots, width, height, true);
      assert.strictEqual(anchors.size, 6);

      const wait1 = anchors.get("wait-1")!;
      const wait2 = anchors.get("wait-2")!;
      const reg1 = anchors.get("reg-1")!;
      const reg2 = anchors.get("reg-2")!;
      const reg3 = anchors.get("reg-3")!;
      const reg4 = anchors.get("reg-4")!;

      const waitReach1 = getSystemReach(roots[0]);
      const waitReach2 = getSystemReach(roots[1]);
      const regReach1 = getSystemReach(roots[2]);
      const regReach2 = getSystemReach(roots[3]);
      const regReach3 = getSystemReach(roots[4]);
      const regReach4 = getSystemReach(roots[5]);

      // All waiting stars have smaller Y (higher on screen) than any regular star
      const maxWaitY = Math.max(wait1.y, wait2.y);
      const minRegY = Math.min(reg1.y, reg2.y, reg3.y, reg4.y);
      assert.ok(maxWaitY < minRegY, `maxWaitY (${maxWaitY}) must be < minRegY (${minRegY})`);

      // System reach clearance between bottom of waiting stars and top of regular stars
      const maxWaitBottom = Math.max(wait1.y + waitReach1, wait2.y + waitReach2);
      const minRegTop = Math.min(
        reg1.y - regReach1,
        reg2.y - regReach2,
        reg3.y - regReach3,
        reg4.y - regReach4
      );

      const verticalClearance = minRegTop - maxWaitBottom;
      assert.ok(
        verticalClearance >= 150,
        `Expected vertical clearance >= 150px, got ${verticalClearance.toFixed(1)}px`
      );

      // Verify computeSpotlightHorizonY
      const horizonY = computeSpotlightHorizonY(
        [
          { y: wait1.y, reach: waitReach1 },
          { y: wait2.y, reach: waitReach2 },
        ],
        [
          { y: reg1.y, reach: regReach1 },
          { y: reg2.y, reach: regReach2 },
          { y: reg3.y, reach: regReach3 },
          { y: reg4.y, reach: regReach4 },
        ]
      );
      assert.ok(horizonY !== null);
      assert.ok(horizonY > maxWaitBottom);
      assert.ok(horizonY < minRegTop);
    });

    it("positions waiting stars in a horizontal spotlight row centered around height * 0.38 when all roots wait", () => {
      const roots: ConstellationRootTarget[] = [
        { id: "wait-a", status: "waiting_on_user", targetRadius: 25 },
        { id: "wait-b", isWaiting: true, targetRadius: 30 },
      ];

      const width = 1000;
      const height = 800;
      const anchors = computeConstellationAnchors(roots, width, height, false);
      assert.strictEqual(anchors.size, 2);

      const posA = anchors.get("wait-a")!;
      const posB = anchors.get("wait-b")!;

      // Both should be placed at height * 0.38 = 304
      assert.strictEqual(posA.y, 800 * 0.38);
      assert.strictEqual(posB.y, 800 * 0.38);

      // Centered horizontally around width * 0.5 = 500
      const midX = (posA.x + posB.x) * 0.5;
      assert.strictEqual(midX, 500);
    });
  });

  describe("6. truncateWaitingPrompt helper", () => {
    it("strips markdown code blocks, bold, headers and truncates <= 58 chars", () => {
      const raw = "### **Confirm Deploy** to `production` cluster with ```secret: 123```?";
      const cleaned = truncateWaitingPrompt(raw);
      assert.ok(cleaned.length <= 58);
      assert.ok(!cleaned.includes("###"));
      assert.ok(!cleaned.includes("**"));
      assert.ok(!cleaned.includes("`"));
    });

    it("returns default fallback when empty or undefined", () => {
      assert.strictEqual(truncateWaitingPrompt(undefined), "Waiting for your answer");
      assert.strictEqual(truncateWaitingPrompt(""), "Waiting for your answer");
    });
  });
});
