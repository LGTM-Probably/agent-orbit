import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GraphStore,
  cleanUserPrompt,
  cleanLogDetail,
  cleanLogCommand,
  cleanAssistantMilestone,
  decodeXmlEntities,
  extractFullUserPrompt,
  extractFullAssistantReply,
} from "../main/graphStore";
import {
  buildCompactDiffPreview,
  classifySemanticBadge,
  computeEditLineDelta,
  computePatchLineDelta,
  formatPatchPreview,
  formatSearchTargetSummary,
  serializeToolCallInput,
  SemanticTaskBadge,
} from "../shared/types";
import {
  parseClaudeFilePath,
  ingestClaudeLine,
  ClaudeFileContext,
} from "../main/adapters/claudeAdapter";
import {
  parseCodexFilePath,
  ingestCodexLine,
  CodexFileContext,
} from "../main/adapters/codexAdapter";
import {
  parseAntigravityFilePath,
  ingestAntigravityLine,
  AntigravityFileContext,
} from "../main/adapters/antigravityAdapter";
import {
  parseStrataFilePath,
  ingestStrataLine,
  StrataFileContext,
} from "../main/adapters/strataAdapter";
import { focusAgentNodeWindow } from "../main/windowFocus";

describe("ClaudeAdapter", () => {
  it("ignores api-request-blob and snapshot lines to prevent duplicate tool counts", () => {
    const store = new GraphStore();
    const ctx: ClaudeFileContext = {
      filePath: "C:/Users/test/.claude/projects/orbit/session-001.jsonl",
      sessionId: "session-001",
      nodeId: "claude:session-001",
    };
    const now = Date.now();

    // Normal assistant line with tool_use
    const normalAssistant = JSON.stringify({
      type: "assistant",
      timestamp: new Date(now).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "Bash",
            input: { command: "git status" },
          },
        ],
      },
    });
    ingestClaudeLine(ctx, normalAssistant, store, now, false);

    const snap1 = store.getSnapshot(now);
    assert.strictEqual(snap1.nodes.length, 1);
    assert.strictEqual(snap1.nodes[0].totalToolCalls, 1);
    assert.strictEqual(snap1.nodes[0].toolCounts.bash, 1);

    // Giant api-request-blob containing past tool_use history
    const blobLine = JSON.stringify({
      type: "api-request-blob",
      timestamp: new Date(now + 10).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool_old",
            name: "Bash",
            input: { command: "git status" },
          },
        ],
      },
    });
    ingestClaudeLine(ctx, blobLine, store, now + 10, false);

    // Also test other snapshot types: api-request, api-request-shape, file-history-snapshot
    ingestClaudeLine(
      ctx,
      JSON.stringify({ type: "api-request", timestamp: new Date(now + 20).toISOString() }),
      store,
      now + 20,
      false
    );
    ingestClaudeLine(
      ctx,
      JSON.stringify({ type: "api-request-shape", timestamp: new Date(now + 30).toISOString() }),
      store,
      now + 30,
      false
    );
    ingestClaudeLine(
      ctx,
      JSON.stringify({
        type: "file-history-snapshot",
        timestamp: new Date(now + 40).toISOString(),
      }),
      store,
      now + 40,
      false
    );

    const snap2 = store.getSnapshot(now + 50);
    assert.strictEqual(
      snap2.nodes[0].totalToolCalls,
      1,
      "Tool counts must not duplicate on api-request-blob or snapshots"
    );
  });

  it("tracks tool_use -> tool_result state transitions (tool_running -> thinking)", () => {
    const store = new GraphStore();
    const ctx: ClaudeFileContext = {
      filePath: "C:/Users/test/.claude/projects/orbit/session-002.jsonl",
      sessionId: "session-002",
      nodeId: "claude:session-002",
    };
    const now = Date.now();

    // 1. Assistant invokes tool -> tool_running
    const toolCall = JSON.stringify({
      type: "assistant",
      timestamp: new Date(now).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_bash_99",
            name: "Bash",
            input: { command: "npm test", description: "Run test suite" },
          },
        ],
      },
    });
    ingestClaudeLine(ctx, toolCall, store, now, false);

    let snap = store.getSnapshot(now);
    let node = snap.nodes[0];
    assert.strictEqual(node.status, "tool_running");
    assert.ok(node.activeTool);
    assert.strictEqual(node.activeTool?.name, "Bash");
    assert.strictEqual(node.activeTool?.category, "bash");

    // 2. User returns tool_result -> transitions back to thinking
    const toolResult = JSON.stringify({
      type: "user",
      timestamp: new Date(now + 500).toISOString(),
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_bash_99",
            content: "Tests passed: 12",
          },
        ],
      },
    });
    ingestClaudeLine(ctx, toolResult, store, now + 500, false);

    snap = store.getSnapshot(now + 600);
    node = snap.nodes[0];
    assert.strictEqual(node.status, "thinking");
    assert.strictEqual(node.activeTool, undefined);
  });

  it("detects skills across all three channels: Skill tool, <command-name>, and SKILL.md reads", () => {
    const store = new GraphStore();
    const ctx: ClaudeFileContext = {
      filePath: "C:/Users/test/.claude/projects/orbit/session-003.jsonl",
      sessionId: "session-003",
      nodeId: "claude:session-003",
    };
    const now = Date.now();

    // Channel 1: user <command-name>
    const userCmd = JSON.stringify({
      type: "user",
      timestamp: new Date(now).toISOString(),
      message: {
        content:
          "Please run <command-name>/release-pipeline</command-name> for milestone v1",
      },
    });
    ingestClaudeLine(ctx, userCmd, store, now, false);

    // Channel 2: assistant Skill tool call
    const skillTool = JSON.stringify({
      type: "assistant",
      timestamp: new Date(now + 100).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_skill_1",
            name: "Skill",
            input: { skill: "audio-synth" },
          },
        ],
      },
    });
    ingestClaudeLine(ctx, skillTool, store, now + 100, false);

    // Channel 3: assistant reading a SKILL.md file path
    const fileRead = JSON.stringify({
      type: "assistant",
      timestamp: new Date(now + 200).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_read_1",
            name: "View",
            input: {
              file_path: "C:/Users/dev/.agents/skills/refactor-audit/SKILL.md",
            },
          },
        ],
      },
    });
    ingestClaudeLine(ctx, fileRead, store, now + 200, false);

    const snap = store.getSnapshot(now + 300);
    const node = snap.nodes[0];
    const skillNames = node.skills.map(s => s.name);
    assert.ok(skillNames.includes("release-pipeline"), "Should detect <command-name>");
    assert.ok(
      skillNames.includes("audio-synth"),
      "Should detect Skill tool call"
    );
    assert.ok(
      skillNames.includes("refactor-audit"),
      "Should detect SKILL.md file read"
    );
  });

  it("applies ai-title to root session label", () => {
    const store = new GraphStore();
    const ctx: ClaudeFileContext = {
      filePath: "C:/Users/test/.claude/projects/orbit/session-004.jsonl",
      sessionId: "session-004",
      nodeId: "claude:session-004",
    };
    const now = Date.now();

    const titleLine = JSON.stringify({
      type: "ai-title",
      timestamp: new Date(now).toISOString(),
      aiTitle: "Orbit Telemetry Engine",
    });
    ingestClaudeLine(ctx, titleLine, store, now, false);

    const snap = store.getSnapshot(now);
    assert.strictEqual(snap.nodes[0].label, "Orbit Telemetry Engine");
  });

  it("links subagents/agent-*.jsonl files to parent and marks completed on SubagentHandback or toolUseResult", () => {
    const store = new GraphStore();
    const parentPath = "C:/Users/test/.claude/projects/orbit/session-parent.jsonl";
    const subPath =
      "C:/Users/test/.claude/projects/orbit/session-parent/subagents/agent-sub-99.jsonl";

    const parentCtx = parseClaudeFilePath(parentPath)!;
    const subCtx = parseClaudeFilePath(subPath)!;
    assert.ok(parentCtx);
    assert.ok(subCtx);
    assert.strictEqual(subCtx.parentId, parentCtx.nodeId);
    assert.strictEqual(subCtx.subagentId, "sub-99");

    const now = Date.now();

    // Ingest initial prompt in subagent
    const subPrompt = JSON.stringify({
      type: "user",
      timestamp: new Date(now).toISOString(),
      message: { content: "Refactor physics loops and verifications" },
    });
    ingestClaudeLine(subCtx, subPrompt, store, now, false);

    let snap = store.getSnapshot(now);
    const subNode = snap.nodes.find(n => n.id === subCtx.nodeId);
    assert.ok(subNode);
    assert.strictEqual(subNode.parentId, parentCtx.nodeId);
    assert.strictEqual(subNode.isSubagent, true);

    // Handback completion via SubagentHandback
    const handbackLine = JSON.stringify({
      type: "assistant",
      timestamp: new Date(now + 1000).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_hb",
            name: "SubagentHandback",
            input: {},
          },
        ],
      },
    });
    ingestClaudeLine(subCtx, handbackLine, store, now + 1000, false);

    snap = store.getSnapshot(now + 1000);
    const completedSub = snap.nodes.find(n => n.id === subCtx.nodeId);
    assert.strictEqual(completedSub?.status, "completed");

    // Also test synchronous toolUseResult in parent marking subagent completed
    const sub2Path =
      "C:/Users/test/.claude/projects/orbit/session-parent/subagents/agent-sub-88.jsonl";
    const sub2Ctx = parseClaudeFilePath(sub2Path)!;
    ingestClaudeLine(
      sub2Ctx,
      JSON.stringify({
        type: "user",
        timestamp: new Date(now + 2000).toISOString(),
        message: { content: "Subtask 88 prompt" },
      }),
      store,
      now + 2000,
      false
    );

    // Parent receives toolUseResult for sub-88
    const parentToolUseResult = JSON.stringify({
      type: "user",
      timestamp: new Date(now + 2100).toISOString(),
      message: { content: [] },
      toolUseResult: {
        agentId: "sub-88",
        status: "completed",
        description: "Unit Test Worker",
      },
    });
    ingestClaudeLine(parentCtx, parentToolUseResult, store, now + 2100, false);

    snap = store.getSnapshot(now + 2100);
    const sub2Node = snap.nodes.find(n => n.id === sub2Ctx.nodeId);
    assert.strictEqual(sub2Node?.status, "completed");
    assert.strictEqual(sub2Node?.label, "Unit Test Worker");
  });
});

describe("CodexAdapter", () => {
  it("links parent_thread_id subagents with agent_nickname", () => {
    const store = new GraphStore();
    const parentSessionId = "00000000-0000-0000-0000-000000000001";
    const childSessionId = "00000000-0000-0000-0000-000000000002";
    const childFilePath = `C:/Users/test/.codex/sessions/rollout-2026-11-10T19-30-32-${childSessionId}.jsonl`;

    const ctx = parseCodexFilePath(childFilePath)!;
    assert.ok(ctx);
    assert.strictEqual(ctx.sessionId, childSessionId);

    const now = Date.now();
    const metaLine = JSON.stringify({
      type: "session_meta",
      timestamp: new Date(now).toISOString(),
      payload: {
        id: childSessionId,
        parent_thread_id: parentSessionId,
        agent_nickname: "Architecture Reviewer",
        cwd: "C:/projects/game",
      },
    });
    ingestCodexLine(ctx, metaLine, store, now, false);

    const snap = store.getSnapshot(now);
    const childNode = snap.nodes.find(n => n.id === `codex:${childSessionId}`);
    assert.ok(childNode);
    assert.strictEqual(childNode.parentId, `codex:${parentSessionId}`);
    assert.strictEqual(childNode.isSubagent, true);
    assert.strictEqual(childNode.label, "Architecture Reviewer");
    assert.strictEqual(childNode.project, "game");

    const parentNode = snap.nodes.find(n => n.id === `codex:${parentSessionId}`);
    assert.ok(parentNode, "Parent node should be auto-created");
  });

  it("tracks function_call / custom_tool_call + output pairs and detects SKILL.md", () => {
    const store = new GraphStore();
    const ctx: CodexFileContext = {
      filePath:
        "C:/Users/test/.codex/sessions/rollout-2026-11-10T19-30-32-00000000-0000-0000-0000-000000000003.jsonl",
      sessionId: "00000000-0000-0000-0000-000000000003",
      nodeId: "codex:00000000-0000-0000-0000-000000000003",
    };
    const now = Date.now();

    // Tool start: exec reading SKILL.md
    const callLine = JSON.stringify({
      type: "response_item",
      timestamp: new Date(now).toISOString(),
      payload: {
        type: "custom_tool_call",
        call_id: "exec_42",
        name: "exec",
        input: "cat C:/Users/test/.agents/skills/refactor-audit/SKILL.md",
      },
    });
    ingestCodexLine(ctx, callLine, store, now, false);

    let snap = store.getSnapshot(now);
    let node = snap.nodes[0];
    assert.strictEqual(node.status, "tool_running");
    assert.strictEqual(node.totalToolCalls, 1);
    assert.ok(node.skills.some(s => s.name === "refactor-audit"));

    // Tool end output
    const outputLine = JSON.stringify({
      type: "response_item",
      timestamp: new Date(now + 100).toISOString(),
      payload: {
        type: "custom_tool_call_output",
        call_id: "exec_42",
        output: "skill content here",
      },
    });
    ingestCodexLine(ctx, outputLine, store, now + 100, false);

    snap = store.getSnapshot(now + 150);
    node = snap.nodes[0];
    assert.strictEqual(node.status, "thinking");
  });

  it("transitions on task_started and task_complete", () => {
    const store = new GraphStore();
    const ctx: CodexFileContext = {
      filePath:
        "C:/Users/test/.codex/sessions/rollout-2026-11-10T19-30-32-00000000-0000-0000-0000-000000000004.jsonl",
      sessionId: "00000000-0000-0000-0000-000000000004",
      nodeId: "codex:00000000-0000-0000-0000-000000000004",
    };
    const now = Date.now();

    // 1. task_started -> thinking
    ingestCodexLine(
      ctx,
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date(now).toISOString(),
        payload: { type: "task_started" },
      }),
      store,
      now,
      false
    );
    let snap = store.getSnapshot(now);
    assert.strictEqual(snap.nodes[0].status, "thinking");

    // 2. task_complete on root -> waiting_on_user
    ingestCodexLine(
      ctx,
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date(now + 500).toISOString(),
        payload: { type: "task_complete" },
      }),
      store,
      now + 500,
      false
    );
    snap = store.getSnapshot(now + 500);
    assert.strictEqual(snap.nodes[0].status, "waiting_on_user");

    // 3. task_complete on subagent -> completed
    const subCtx: CodexFileContext = {
      filePath:
        "C:/Users/test/.codex/sessions/rollout-2026-11-10T19-30-32-00000000-0000-0000-0000-000000000005.jsonl",
      sessionId: "00000000-0000-0000-0000-000000000005",
      nodeId: "codex:00000000-0000-0000-0000-000000000005",
    };
    ingestCodexLine(
      subCtx,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: subCtx.sessionId,
          parent_thread_id: ctx.sessionId,
          agent_nickname: "Sub Worker",
        },
      }),
      store,
      now + 600,
      false
    );
    ingestCodexLine(
      subCtx,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
      store,
      now + 700,
      false
    );
    snap = store.getSnapshot(now + 700);
    const subNode = snap.nodes.find(n => n.id === subCtx.nodeId);
    assert.strictEqual(subNode?.status, "completed");
  });
});

describe("AntigravityAdapter", () => {
  it("parses USER_INPUT title and transitions to thinking", () => {
    const store = new GraphStore();
    const ctx = parseAntigravityFilePath(
      "C:/Users/dev/.gemini/antigravity/brain/session-ag-1/.system_generated/logs/transcript.jsonl"
    )!;
    assert.ok(ctx);
    const now = Date.now();

    const userInput = JSON.stringify({
      step_index: 1,
      source: "USER",
      type: "USER_INPUT",
      created_at: new Date(now).toISOString(),
      content:
        "<USER_REQUEST>Build zero-overhead telemetry visualizer</USER_REQUEST>",
    });
    ingestAntigravityLine(ctx, userInput, store, now, false);

    const snap = store.getSnapshot(now);
    assert.strictEqual(snap.nodes[0].label, "Build zero-overhead telemetry visualizer");
    assert.strictEqual(snap.nodes[0].status, "thinking");
  });

  it("parses PLANNER_RESPONSE tool_calls and detects SKILL.md reads", () => {
    const store = new GraphStore();
    const ctx = parseAntigravityFilePath(
      "C:/Users/dev/.gemini/antigravity/brain/session-ag-2/.system_generated/logs/transcript.jsonl"
    )!;
    const now = Date.now();

    const plannerResponse = JSON.stringify({
      step_index: 2,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: new Date(now).toISOString(),
      tool_calls: [
        {
          name: "read_file",
          args: {
            Path: "C:/Users/dev/.agents/skills/release-pipeline/SKILL.md",
          },
        },
        {
          name: "run_command",
          args: {
            CommandLine: "& 'C:/Program Files/Git/bin/bash.exe' -lc 'npm test'",
            toolSummary: "Run test suite",
          },
        },
      ],
    });
    ingestAntigravityLine(ctx, plannerResponse, store, now, false);

    let snap = store.getSnapshot(now);
    let node = snap.nodes[0];
    assert.strictEqual(node.status, "tool_running");
    assert.strictEqual(node.totalToolCalls, 2);
    assert.strictEqual(node.toolCounts.read, 1);
    assert.strictEqual(node.toolCounts.bash, 1);
    assert.ok(node.skills.some(s => s.name === "release-pipeline"));

    // Tool completion via GENERIC step
    const genericResponse = JSON.stringify({
      step_index: 3,
      source: "MODEL",
      type: "GENERIC",
      created_at: new Date(now + 200).toISOString(),
      content: "Command exited with code 0",
    });
    ingestAntigravityLine(ctx, genericResponse, store, now + 200, false);

    snap = store.getSnapshot(now + 250);
    node = snap.nodes[0];
    assert.strictEqual(node.status, "thinking");
  });

  it("links invoke_subagent + GENERIC conversationId and cleans outer quotes on roles", () => {
    const store = new GraphStore();
    const parentCtx = parseAntigravityFilePath(
      "C:/Users/dev/.gemini/antigravity/brain/parent-conv-123/.system_generated/logs/transcript.jsonl"
    )!;
    const childConvId = "5818386a-23ed-4686-af42-32b193d9ec61";
    const childCtx = parseAntigravityFilePath(
      `C:/Users/dev/.gemini/antigravity/brain/${childConvId}/.system_generated/logs/transcript.jsonl`
    )!;
    const now = Date.now();

    // Step with invoke_subagent carrying escaped quotes around Role (as seen in real transcripts)
    const invokeStep = JSON.stringify({
      step_index: 104,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: new Date(now).toISOString(),
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            Model: '"flash"',
            Prompt: "Run unit tests",
            Role: '"Telemetry & Adapter Test Engineer"',
            TypeName: '"self"',
          },
        },
      ],
    });
    ingestAntigravityLine(parentCtx, invokeStep, store, now, false);

    // Exact output format from Antigravity's real GENERIC step
    const genericStep = JSON.stringify({
      step_index: 108,
      source: "MODEL",
      type: "GENERIC",
      created_at: new Date(now + 500).toISOString(),
      content: `Created At: 2026-11-11T00:54:15-05:00
Completed At: 2026-11-11T00:54:22-05:00
Created the following subagent:
{
  "conversationId":  "${childConvId}",
  "logAbsoluteUri":  "file:///C:/Users/dev/.gemini/antigravity/brain/${childConvId}/.system_generated/logs/transcript.jsonl"
}
The subagent will send you a message when it has completed its task or requires guidance. There is no need to poll for its response.`,
    });
    ingestAntigravityLine(parentCtx, genericStep, store, now + 500, false);

    // Now ingest child subagent transcript line
    const childInput = JSON.stringify({
      step_index: 1,
      source: "USER",
      type: "USER_INPUT",
      created_at: new Date(now + 600).toISOString(),
      content: "The following is a <SYSTEM_MESSAGE> [Message] You are a Flash worker",
    });
    ingestAntigravityLine(childCtx, childInput, store, now + 600, false);

    const snap = store.getSnapshot(now + 700);
    const childNode = snap.nodes.find(n => n.id === childCtx.nodeId);
    assert.ok(childNode, "Child node must exist");
    assert.strictEqual(childNode.parentId, parentCtx.nodeId);
    assert.strictEqual(childNode.isSubagent, true);
    assert.strictEqual(
      childNode.label,
      "Telemetry & Adapter Test Engineer",
      "Outer quotes must be stripped cleanly from subagent label"
    );
  });
});

describe("StrataAdapter", () => {
  it("parses real Strata v4 session header, links subagent to parentSession, and applies descriptor label", () => {
    const store = new GraphStore();
    const parentPath =
      "C:/Users/dev/.strata/data/agent/home/sessions/--proj--/session-parent-1/session.v4.jsonl";
    const subPath =
      "C:/Users/dev/.strata/data/agent/home/sessions/--proj--/session-sub-1/session.v4.jsonl";

    const parentCtx = parseStrataFilePath(parentPath)!;
    const subCtx = parseStrataFilePath(subPath)!;
    assert.ok(parentCtx);
    assert.ok(subCtx);
    assert.strictEqual(parentCtx.sessionId, "session-parent-1");
    assert.strictEqual(subCtx.sessionId, "session-sub-1");

    const now = Date.now();

    // Ingest parent root session header
    const parentHeader = JSON.stringify({
      type: "session",
      version: 4,
      id: "session-parent-1",
      createdAt: now,
      cwd: "C:/Desktop/code/chrono-store",
      origin: "direct",
    });
    ingestStrataLine(parentCtx, parentHeader, store, now, false);

    // Ingest subagent session header with parentSession
    const subHeader = JSON.stringify({
      type: "session",
      version: 4,
      id: "session-sub-1",
      createdAt: now + 50,
      cwd: "C:/Desktop/code/chrono-store",
      parentSession: "session-parent-1",
      origin: "subagent",
    });
    ingestStrataLine(subCtx, subHeader, store, now + 50, false);

    // Ingest subagent descriptor with human label and model
    const descriptor = JSON.stringify({
      type: "subagent/descriptor",
      time: now + 60,
      data: {
        label: "Fix worker PR 858",
        agentModel: "iq3_s",
      },
    });
    ingestStrataLine(subCtx, descriptor, store, now + 60, false);

    const snap = store.getSnapshot(now + 100);
    const subNode = snap.nodes.find(n => n.id === "strata:session-sub-1");
    assert.ok(subNode, "Subagent node must exist in snapshot");
    assert.strictEqual(subNode.parentId, "strata:session-parent-1");
    assert.strictEqual(subNode.isSubagent, true);
    assert.strictEqual(subNode.label, "Fix worker PR 858");
    assert.strictEqual(subNode.model, "iq3_s");
    assert.strictEqual(subNode.harness, "strata");

    const parentNode = snap.nodes.find(n => n.id === "strata:session-parent-1");
    assert.ok(parentNode, "Parent node must exist in snapshot");
    assert.strictEqual(parentNode.isSubagent, false);
  });

  it("tracks tool/call -> tool/result state transitions and detects skills", () => {
    const store = new GraphStore();
    const ctx = parseStrataFilePath(
      "C:/Users/dev/.strata/sessions/strata-sess-2.jsonl"
    )!;
    assert.ok(ctx);
    const now = Date.now();

    // 1. Tool call reading SKILL.md
    const toolCall = JSON.stringify({
      type: "tool/call",
      time: now,
      data: {
        callId: "call_strata_01",
        name: "read_file",
        arguments: JSON.stringify({
          path: "C:/Users/dev/.agents/skills/strata-release/SKILL.md",
        }),
      },
    });
    ingestStrataLine(ctx, toolCall, store, now, false);

    let snap = store.getSnapshot(now);
    let node = snap.nodes[0];
    assert.strictEqual(node.status, "tool_running");
    assert.strictEqual(node.totalToolCalls, 1);
    assert.strictEqual(node.toolCounts.read, 1);
    assert.ok(
      node.skills.some(s => s.name === "strata-release"),
      "Skill must be extracted from SKILL.md path in tool arguments"
    );

    // 2. Tool result -> transitions back to thinking
    const toolResult = JSON.stringify({
      type: "tool/result",
      time: now + 200,
      data: {
        toolCallId: "call_strata_01",
        isError: false,
      },
    });
    ingestStrataLine(ctx, toolResult, store, now + 200, false);

    snap = store.getSnapshot(now + 250);
    node = snap.nodes[0];
    assert.strictEqual(node.status, "thinking");
  });

  it("parses session/title, user/message, and turn/end completion", () => {
    const store = new GraphStore();
    const ctx = parseStrataFilePath(
      "C:/Users/dev/.strata/sessions/strata-sess-3.jsonl"
    )!;
    const now = Date.now();

    // User message sets phase to thinking and derives title if none present
    const userMsg = JSON.stringify({
      type: "user/message",
      time: now,
      data: {
        content: [{ type: "text", text: "Refactor physics loop and verifications" }],
      },
    });
    ingestStrataLine(ctx, userMsg, store, now, false);

    let snap = store.getSnapshot(now);
    assert.strictEqual(snap.nodes[0].status, "thinking");
    assert.strictEqual(snap.nodes[0].label, "Refactor physics loop and verifications");

    // Explicit session/title overrides generic derived title
    const titleMsg = JSON.stringify({
      type: "session/title",
      time: now + 50,
      data: { title: "Custom Physics Overhaul" },
    });
    ingestStrataLine(ctx, titleMsg, store, now + 50, false);

    snap = store.getSnapshot(now + 60);
    assert.strictEqual(snap.nodes[0].label, "Custom Physics Overhaul");

    // Root turn/end transitions to waiting_on_user
    const turnEnd = JSON.stringify({
      type: "turn/end",
      time: now + 100,
      data: { turn: 1, reason: { kind: "completed" } },
    });
    ingestStrataLine(ctx, turnEnd, store, now + 100, false);

    snap = store.getSnapshot(now + 120);
    assert.strictEqual(snap.nodes[0].status, "waiting_on_user");

    // Subagent turn/end transitions to completed
    const subCtx = parseStrataFilePath(
      "C:/Users/dev/.strata/sessions/strata-sub-4.jsonl"
    )!;
    ingestStrataLine(
      subCtx,
      JSON.stringify({
        type: "session",
        id: "strata-sub-4",
        parentSession: "strata-sess-3",
        origin: "subagent",
      }),
      store,
      now + 150,
      false
    );
    ingestStrataLine(
      subCtx,
      JSON.stringify({
        type: "turn/end",
        time: now + 200,
        data: { turn: 1, reason: { kind: "completed" } },
      }),
      store,
      now + 200,
      false
    );

    snap = store.getSnapshot(now + 220);
    const subNode = snap.nodes.find(n => n.id === "strata:strata-sub-4");
    assert.strictEqual(subNode?.status, "completed");
  });

  it("handles generic session_meta fallback and tool events for ~/.strata sessions", () => {
    const store = new GraphStore();
    const ctx = parseStrataFilePath(
      "C:/Users/dev/.strata/sessions/strata-generic-5.jsonl"
    )!;
    const now = Date.now();

    ingestStrataLine(
      ctx,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "strata-generic-5",
          parent_session_id: "strata-parent-root",
          agent_nickname: "Worker Delta",
          cwd: "C:/code/strata-app",
          model: "qwen-2.5-coder",
        },
      }),
      store,
      now,
      false
    );

    const snap = store.getSnapshot(now);
    const node = snap.nodes.find(n => n.id === "strata:strata-generic-5");
    assert.ok(node);
    assert.strictEqual(node.parentId, "strata:strata-parent-root");
    assert.strictEqual(node.isSubagent, true);
    assert.strictEqual(node.label, "Worker Delta");
    assert.strictEqual(node.model, "qwen-2.5-coder");
    assert.strictEqual(node.project, "strata-app");
  });
});

describe("GraphStore", () => {
  it("keeps all completed subagents in getSnapshot when parent is active in time window", () => {
    const store = new GraphStore();
    store.setTimeWindow("30m");
    const now = Date.now();

    // Parent active 2 minutes ago
    const parent = store.upsertNode({
      id: "ag:parent-1",
      rawId: "parent-1",
      harness: "antigravity",
      label: "Release Orchestrator",
      timestamp: now - 2 * 60 * 1000,
    });

    // Subagent 1 completed 45 minutes ago (older than the 30m cutoff!)
    const sub1 = store.upsertNode({
      id: "ag:sub-1",
      rawId: "sub-1",
      harness: "antigravity",
      parentId: parent.id,
      isSubagent: true,
      label: "Asset Reviewer",
      timestamp: now - 45 * 60 * 1000,
    });
    store.markCompleted(sub1.id, now - 45 * 60 * 1000, false);

    // Subagent 2 active 5 minutes ago
    store.upsertNode({
      id: "ag:sub-2",
      rawId: "sub-2",
      harness: "antigravity",
      parentId: parent.id,
      isSubagent: true,
      label: "Test Runner",
      timestamp: now - 5 * 60 * 1000,
    });

    const snap = store.getSnapshot(now);
    const includedIds = snap.nodes.map(n => n.id);

    // Parent and recently active subagent 2 are included
    assert.ok(includedIds.includes(parent.id));
    assert.ok(includedIds.includes("ag:sub-2"));

    // Critical assertion: subagent 1 (completed 45m ago) MUST still be included because parent is active!
    assert.ok(
      includedIds.includes("ag:sub-1"),
      "Completed subagents must remain included while parent is active so inner halo stays intact"
    );

    const sub1Snap = snap.nodes.find(n => n.id === "ag:sub-1");
    assert.strictEqual(sub1Snap?.status, "completed");
  });

  it("prunes parent and all subagents when entire tree is older than time window", () => {
    const store = new GraphStore();
    store.setTimeWindow("30m");
    const now = Date.now();

    // Parent and subagent both active 2 hours ago
    const parent = store.upsertNode({
      id: "claude:old-p",
      rawId: "old-p",
      harness: "claude",
      timestamp: now - 2 * 60 * 60 * 1000,
    });
    store.upsertNode({
      id: "claude:old-sub",
      rawId: "old-sub",
      harness: "claude",
      parentId: parent.id,
      isSubagent: true,
      timestamp: now - 2 * 60 * 60 * 1000,
    });

    let snap = store.getSnapshot(now);
    assert.strictEqual(snap.nodes.length, 0);

    // Switching window to 4h revives the entire family
    store.setTimeWindow("4h");
    snap = store.getSnapshot(now);
    assert.strictEqual(snap.nodes.length, 2);
  });

  it("preserves simulated nodes regardless of timestamp until explicitly cleared", () => {
    const store = new GraphStore();
    store.setTimeWindow("live");
    const now = Date.now();

    store.upsertNode({
      id: "sim:node-1",
      rawId: "sim-1",
      harness: "claude",
      isSimulated: true,
      label: "Simulated Agent",
      timestamp: now - 24 * 60 * 60 * 1000, // 24h old
    });

    let snap = store.getSnapshot(now);
    assert.strictEqual(snap.nodes.length, 1);
    assert.strictEqual(snap.simActive, true);

    store.clearSimulatedNodes();
    snap = store.getSnapshot(now);
    assert.strictEqual(snap.nodes.length, 0);
    assert.strictEqual(snap.simActive, false);
  });
});

describe("WindowFocus & Entrypoint", () => {
  it("captures entrypoint in claudeAdapter for parent and node and reflects in snapshot", () => {
    const store = new GraphStore();
    const ctx: ClaudeFileContext = {
      filePath: "C:/Users/test/.claude/projects/orbit/session-002.jsonl",
      sessionId: "session-002",
      nodeId: "claude:session-002",
    };
    const now = Date.now();

    const lineWithEntrypoint = JSON.stringify({
      type: "user",
      timestamp: new Date(now).toISOString(),
      entrypoint: "claude-desktop",
      message: { content: "hello" },
    });

    ingestClaudeLine(ctx, lineWithEntrypoint, store, now, false);

    const node = store.getNodeById("claude:session-002");
    assert.ok(node);
    assert.strictEqual(node.entrypoint, "claude-desktop");

    const snap = store.getSnapshot(now);
    assert.strictEqual(snap.nodes.length, 1);
    assert.strictEqual(snap.nodes[0].entrypoint, "claude-desktop");
  });

  it("subagent inherits entrypoint from parent or uses its own", () => {
    const store = new GraphStore();
    const parentCtx: ClaudeFileContext = {
      filePath: "C:/Users/test/.claude/projects/orbit/session-parent.jsonl",
      sessionId: "session-parent",
      nodeId: "claude:session-parent",
    };
    const subCtx: ClaudeFileContext = {
      filePath: "C:/Users/test/.claude/projects/orbit/session-parent/subagents/agent-sub1.jsonl",
      sessionId: "session-parent",
      subagentId: "sub1",
      nodeId: "claude:session-parent:sub:sub1",
      parentId: "claude:session-parent",
    };
    const now = Date.now();

    // Ingest parent with cli entrypoint
    ingestClaudeLine(
      parentCtx,
      JSON.stringify({
        type: "user",
        timestamp: new Date(now).toISOString(),
        entrypoint: "cli",
        message: { content: "run task" },
      }),
      store,
      now,
      false
    );

    // Ingest subagent
    ingestClaudeLine(
      subCtx,
      JSON.stringify({
        type: "user",
        timestamp: new Date(now + 10).toISOString(),
        message: { content: "subagent work" },
      }),
      store,
      now + 10,
      false
    );

    const root = store.getRootNode("claude:session-parent:sub:sub1");
    assert.ok(root);
    assert.strictEqual(root.id, "claude:session-parent");
    assert.strictEqual(root.entrypoint, "cli");

    const sub = store.getNodeById("claude:session-parent:sub:sub1");
    assert.ok(sub);
    assert.strictEqual(sub.entrypoint, "cli");
  });

  it("focusAgentNodeWindow returns error when agent is not found", async () => {
    const store = new GraphStore();
    const res = await focusAgentNodeWindow("non-existent-agent", store);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "Agent not found");
  });

  it("focusAgentNodeWindow runs orbit-focus.exe with dryRun safely and returns valid FocusResult", async () => {
    const store = new GraphStore();
    const now = Date.now();

    store.upsertNode({
      id: "antigravity:test-focus",
      rawId: "test-focus",
      harness: "antigravity",
      project: "agent-orbit",
      label: "agent-orbit",
      timestamp: now,
    });

    const res = await focusAgentNodeWindow("antigravity:test-focus", store, { dryRun: true });
    assert.strictEqual(typeof res.ok, "boolean");
    if (res.ok) {
      assert.ok(typeof res.targetApp === "string");
      assert.ok(typeof res.windowTitle === "string");
    } else {
      assert.ok(typeof res.reason === "string");
    }
  });
});

describe("ActivityLog & Telemetry Stream", () => {
  it("cleanUserPrompt and cleanLogDetail format text and paths correctly", () => {
    // Strips XML tags and collapses whitespace
    const prompt1 = cleanUserPrompt("<USER_REQUEST>\n  Fix the bug in main.ts   \n</USER_REQUEST>");
    assert.strictEqual(prompt1, "Fix the bug in main.ts");

    const prompt2 = cleanUserPrompt("<command-name>release-pipeline</command-name>");
    assert.strictEqual(prompt2, "release-pipeline");

    // Ignores SYSTEM payloads
    assert.strictEqual(cleanUserPrompt("<SYSTEM_MESSAGE>You are an AI assistant</SYSTEM_MESSAGE>"), null);

    // Ignores tool payloads
    assert.strictEqual(cleanUserPrompt('{"type":"tool_result","content":"ok"}'), null);

    // Ignores empty strings
    assert.strictEqual(cleanUserPrompt("   \n\t  "), null);

    // Truncates strings longer than 110 chars
    const longPrompt = "a".repeat(120);
    const cleanedLong = cleanUserPrompt(longPrompt);
    assert.ok(cleanedLong);
    assert.ok(cleanedLong.length <= 110);
    assert.ok(cleanedLong.endsWith("..."));

    // cleanLogDetail preserves paths and commands up to 320 chars without aggressive slicing
    const pathTarget = "C:/Users/dev/.gemini/antigravity/scratch/agent-orbit/src/main/graphStore.ts";
    assert.strictEqual(cleanLogDetail(pathTarget), pathTarget);

    const longCmd = "node --test dist-electron/test/*.js --verbose --reporter=spec --coverage-reporter=lcov --timeout=30000";
    // longCmd is 103 chars and stays fully untruncated within the 320-char limit
    assert.strictEqual(cleanLogDetail(longCmd), longCmd);

    const veryLongCmd = "x".repeat(350);
    const cleanedCmd = cleanLogDetail(veryLongCmd);
    assert.ok(cleanedCmd);
    assert.ok(cleanedCmd.length <= 320);
    assert.ok(cleanedCmd.endsWith("..."));
  });

  it("decodes XML/HTML entities in Claude Desktop <wake>/<relay> envelopes without double-unescaping", () => {
    const wakePrompt = `<wake reason="mention" current-time="2026-11-12T04:54:41Z">
  <project id="chan_015JXtwuHVpEgNcvU4Hg6fJf" type="project">
    <thread ts="cmsg_015JXtwuHVpEgNcvU4Hg6fJfKQWcz6sFLfmiir6gjskwNK">
      <message trigger="true" from="human" trust="principal" author-id="user_015" id="cmsg_015" sent-at="2026-11-12T04:54:41Z" mention="true">We&#39;re back, let&#39;s resume.</message>
    </thread>
  </project>
</wake>`;

    assert.strictEqual(cleanUserPrompt(wakePrompt), "We're back, let's resume.");
    assert.strictEqual(extractFullUserPrompt(wakePrompt), "We're back, let's resume.");

    const relayPrompt = `<relay from="coordinator" session="session_01" reason="spawn">
  The note below was written by the coordinator session.
  <note>
      Run \`git show main:brief.md &gt; &lt;tmp&gt;/brief.md\` &amp; check Alex&#39;s &quot;corvette&quot; mesh.
  </note>
</relay>`;

    assert.strictEqual(
      cleanUserPrompt(relayPrompt),
      'Run `git show main:brief.md > <tmp>/brief.md` & check Alex\'s "corvette" mesh.'
    );
    assert.strictEqual(
      extractFullUserPrompt(relayPrompt),
      'Run `git show main:brief.md > <tmp>/brief.md` & check Alex\'s "corvette" mesh.'
    );

    // Single-pass decoding never double-decodes &amp;#39; into '
    assert.strictEqual(decodeXmlEntities("literal &amp;#39; entity"), "literal &#39; entity");

    // Background task-notification envelopes are ignored as non-prompts
    const taskNotif = `<task-notification>\n<task-id>b3ngu4f6k</task-id>\n<status>completed</status>\n</task-notification>`;
    assert.strictEqual(cleanUserPrompt(taskNotif), null);

    // Claude adapter end-to-end check with <system-reminder> + <wake> array blocks and isMeta skill injection
    const store = new GraphStore();
    const now = Date.now();
    const ctx: ClaudeFileContext = {
      filePath: "C:/projects/nebula-cloud/36ccf7aa.jsonl",
      sessionId: "36ccf7aa",
      nodeId: "claude:36ccf7aa",
    };

    ingestClaudeLine(
      ctx,
      JSON.stringify({
        type: "user",
        isMeta: true,
        timestamp: new Date(now).toISOString(),
        message: { content: [{ type: "text", text: "Base directory for this skill: C:/skills/foo" }] },
      }),
      store,
      now,
      false
    );

    ingestClaudeLine(
      ctx,
      JSON.stringify({
        type: "user",
        timestamp: new Date(now + 10).toISOString(),
        message: {
          content: [
            { type: "text", text: "<system-reminder>\nInternal reminder\n</system-reminder>" },
            { type: "text", text: wakePrompt },
          ],
        },
      }),
      store,
      now + 10,
      false
    );

    const snap = store.getSnapshot(now + 20);
    const prompts = snap.activityLog.filter(e => e.kind === "prompt");
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].summary, "We're back, let's resume.");
    assert.strictEqual(prompts[0].detail, "We're back, let's resume.");
    assert.strictEqual(prompts[0].fullText, "We're back, let's resume.");
  });

  it("captures user prompts across adapters and deduplicates identical prompts", () => {
    const store = new GraphStore();
    const now = Date.now();

    // 1. Claude adapter prompt
    const claudeCtx: ClaudeFileContext = {
      filePath: "C:/projects/orbit/claude-session.jsonl",
      sessionId: "claude-session",
      nodeId: "claude:claude-session",
    };
    ingestClaudeLine(
      claudeCtx,
      JSON.stringify({
        type: "user",
        timestamp: new Date(now).toISOString(),
        message: { content: "Implement the trailing activity log" },
      }),
      store,
      now,
      false
    );

    // Duplicate prompt to same node should be deduplicated
    ingestClaudeLine(
      claudeCtx,
      JSON.stringify({
        type: "user",
        timestamp: new Date(now + 10).toISOString(),
        message: { content: "Implement the trailing activity log" },
      }),
      store,
      now + 10,
      false
    );

    // 2. Antigravity adapter prompt
    const agCtx: AntigravityFileContext = {
      filePath: "C:/brain/ag-conv/.system_generated/logs/transcript.jsonl",
      convId: "ag-conv",
      nodeId: "antigravity:ag-conv",
      pendingSubagentRoles: [],
    };
    ingestAntigravityLine(
      agCtx,
      JSON.stringify({
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        created_at: new Date(now + 20).toISOString(),
        content: "<USER_REQUEST>Refactor edge window controller</USER_REQUEST>",
      }),
      store,
      now + 20,
      false
    );

    // 3. Strata adapter prompt
    const strataCtx: StrataFileContext = {
      filePath: "C:/strata/sessions/strata-1.jsonl",
      sessionId: "strata-1",
      nodeId: "strata:strata-1",
      pendingSubagentRoles: [],
    };
    ingestStrataLine(
      strataCtx,
      JSON.stringify({
        type: "user/message",
        timestamp: now + 30,
        data: { content: "Run swarm burst simulation" },
      }),
      store,
      now + 30,
      false
    );

    const snap = store.getSnapshot(now + 40);
    const promptEntries = snap.activityLog.filter(e => e.kind === "prompt");
    assert.strictEqual(promptEntries.length, 3);
    assert.strictEqual(promptEntries[0].detail, "Implement the trailing activity log");
    assert.strictEqual(promptEntries[1].detail, "Refactor edge window controller");
    assert.strictEqual(promptEntries[2].detail, "Run swarm burst simulation");
  });

  it("tracks tool start (running) -> tool end (done and error) in place", () => {
    const store = new GraphStore();
    const now = Date.now();
    const nodeId = "claude:tool-session";

    store.upsertNode({
      id: nodeId,
      rawId: "tool-session",
      harness: "claude",
      label: "Tool Session",
      timestamp: now,
    });

    // Start Tool 1
    store.recordToolStart(nodeId, {
      callId: "call-1",
      name: "Bash",
      target: "npm run build:main",
      timestamp: now + 10,
      isLive: false,
    });

    let snap = store.getSnapshot(now + 15);
    let tool1 = snap.activityLog.find(e => e.id === `${nodeId}:tool:call-1`);
    assert.ok(tool1);
    assert.strictEqual(tool1.kind, "tool");
    assert.strictEqual(tool1.status, "running");
    assert.strictEqual(tool1.title, "Bash");
    assert.strictEqual(tool1.detail, "npm run build:main");
    assert.strictEqual(tool1.category, "bash");

    // End Tool 1 successfully
    store.recordToolEnd(nodeId, {
      callId: "call-1",
      timestamp: now + 20,
      isError: false,
      isLive: false,
    });

    snap = store.getSnapshot(now + 25);
    tool1 = snap.activityLog.find(e => e.id === `${nodeId}:tool:call-1`);
    assert.ok(tool1);
    assert.strictEqual(tool1.status, "done");

    // Start Tool 2
    store.recordToolStart(nodeId, {
      callId: "call-2",
      name: "Edit",
      target: "src/main/graphStore.ts",
      timestamp: now + 30,
      isLive: false,
    });

    // End Tool 2 with error
    store.recordToolEnd(nodeId, {
      callId: "call-2",
      timestamp: now + 40,
      isError: true,
      isLive: false,
    });

    snap = store.getSnapshot(now + 45);
    const tool2 = snap.activityLog.find(e => e.id === `${nodeId}:tool:call-2`);
    assert.ok(tool2);
    assert.strictEqual(tool2.status, "error");

    // Start Tool 3 & 4 and end allInFlight
    store.recordToolStart(nodeId, {
      callId: "call-3",
      name: "Read",
      target: "README.md",
      timestamp: now + 50,
      isLive: false,
    });
    store.recordToolStart(nodeId, {
      callId: "call-4",
      name: "Grep",
      target: "activityLog",
      timestamp: now + 55,
      isLive: false,
    });

    store.recordToolEnd(nodeId, {
      allInFlight: true,
      timestamp: now + 60,
      isError: false,
      isLive: false,
    });

    snap = store.getSnapshot(now + 65);
    const tool3 = snap.activityLog.find(e => e.id === `${nodeId}:tool:call-3`);
    const tool4 = snap.activityLog.find(e => e.id === `${nodeId}:tool:call-4`);
    assert.ok(tool3 && tool4);
    assert.strictEqual(tool3.status, "done");
    assert.strictEqual(tool4.status, "done");
  });

  it("captures skills, subagent spawn, and subagent complete events in chronological order", () => {
    const store = new GraphStore();
    const now = Date.now();
    const parentId = "claude:parent-sess";
    const subId = "claude:parent-sess:sub:sub-1";

    // 1. Create parent
    store.upsertNode({
      id: parentId,
      rawId: "parent-sess",
      harness: "claude",
      label: "Release Manager",
      timestamp: now,
    });

    // 2. Parent prompt
    store.recordUserPrompt(parentId, "Dispatch subagents for refactor", now + 10);

    // 3. Parent records skill
    store.recordSkill(parentId, "release-pipeline", now + 20, false);

    // 4. Spawn subagent
    store.upsertNode({
      id: subId,
      rawId: "sub-1",
      harness: "claude",
      parentId,
      isSubagent: true,
      label: "Worker #1 Refactor",
      timestamp: now + 30,
    });

    // 5. Subagent runs tool
    store.recordToolStart(subId, {
      callId: "sub-tool-1",
      name: "Edit",
      target: "src/main/graphStore.ts",
      timestamp: now + 40,
      isLive: false,
    });
    store.recordToolEnd(subId, {
      callId: "sub-tool-1",
      timestamp: now + 50,
      isLive: false,
    });

    // 6. Subagent completes
    store.markCompleted(subId, now + 60, false);

    const snap = store.getSnapshot(now + 70);
    assert.strictEqual(snap.activityLog.length, 5);

    // Verify kinds in strict chronological order
    const kinds = snap.activityLog.map(e => e.kind);
    assert.deepStrictEqual(kinds, [
      "prompt",
      "skill",
      "subagent_spawn",
      "tool",
      "subagent_complete",
    ]);

    // Verify subagent entries resolve rootId to parent
    const spawnEntry = snap.activityLog.find(e => e.kind === "subagent_spawn");
    assert.ok(spawnEntry);
    assert.strictEqual(spawnEntry.nodeId, subId);
    assert.strictEqual(spawnEntry.rootId, parentId);
    assert.strictEqual(spawnEntry.agentLabel, "Worker #1 Refactor");

    const completeEntry = snap.activityLog.find(e => e.kind === "subagent_complete");
    assert.ok(completeEntry);
    assert.strictEqual(completeEntry.nodeId, subId);
    assert.strictEqual(completeEntry.rootId, parentId);
    assert.strictEqual(completeEntry.title, "Completed");
    assert.strictEqual(completeEntry.detail, "Worker #1 Refactor");

    // Verify chronological ordering
    for (let i = 1; i < snap.activityLog.length; i++) {
      assert.ok(snap.activityLog[i].timestamp >= snap.activityLog[i - 1].timestamp);
    }
  });

  it("clears simulated log entries on clearSimulatedNodes()", () => {
    const store = new GraphStore();
    const now = Date.now();

    // Real node
    store.upsertNode({
      id: "claude:real-1",
      rawId: "real-1",
      harness: "claude",
      label: "Real Agent",
      timestamp: now,
    });
    store.recordUserPrompt("claude:real-1", "Build application", now + 10);
    store.recordToolStart("claude:real-1", {
      callId: "real-tool-1",
      name: "Bash",
      target: "npm run build",
      timestamp: now + 20,
      isLive: false,
    });

    // Simulated node
    store.upsertNode({
      id: "claude:sim-1",
      rawId: "sim-1",
      harness: "claude",
      isSimulated: true,
      label: "Simulated Agent",
      timestamp: now + 30,
    });
    store.recordUserPrompt("claude:sim-1", "Simulated prompt", now + 40);
    store.recordToolStart("claude:sim-1", {
      callId: "sim-tool-1",
      name: "Grep",
      target: "simulated-target",
      timestamp: now + 50,
      isLive: false,
    });

    let snap = store.getSnapshot(now + 60);
    assert.strictEqual(snap.activityLog.length, 4);
    assert.strictEqual(snap.simActive, true);

    // Clear simulated nodes
    store.clearSimulatedNodes();

    snap = store.getSnapshot(now + 70);
    assert.strictEqual(snap.simActive, false);
    // Only real node activity log entries should remain
    assert.strictEqual(snap.activityLog.length, 2);
    assert.ok(snap.activityLog.every(e => e.nodeId === "claude:real-1"));
  });

  it("recovers stale running tools in snapshot when agent status is no longer tool_running", () => {
    const store = new GraphStore();
    const now = Date.now();
    const nodeId = "claude:stale-tool-agent";

    store.upsertNode({
      id: nodeId,
      rawId: "stale-tool-agent",
      harness: "claude",
      label: "Stale Agent",
      timestamp: now,
    });

    store.recordToolStart(nodeId, {
      callId: "tool-stale",
      name: "Bash",
      target: "sleep 100",
      timestamp: now + 10,
      isLive: false,
    });

    // Snapshot while tool is active
    let snap = store.getSnapshot(now + 20);
    let entry = snap.activityLog.find(e => e.id === `${nodeId}:tool:tool-stale`);
    assert.ok(entry);
    assert.strictEqual(entry.status, "running");

    // Agent completes without explicit tool_end event
    store.markCompleted(nodeId, now + 30, false);

    // Subsequent snapshot should automatically report status as "done" so historical tools don't spin forever
    snap = store.getSnapshot(now + 40);
    entry = snap.activityLog.find(e => e.id === `${nodeId}:tool:tool-stale`);
    assert.ok(entry);
    assert.strictEqual(entry.status, "done");
  });

  it("caps activityLog in snapshot up to 1,200 entries while retaining oldest-to-newest sort and per-root preservation", () => {
    const store = new GraphStore();
    const now = Date.now();
    const nodeA = "claude:bulk-node-a";
    const nodeB = "claude:bulk-node-b";

    store.upsertNode({
      id: nodeA,
      rawId: "bulk-node-a",
      harness: "claude",
      label: "Bulk Node A",
      timestamp: now,
    });

    store.upsertNode({
      id: nodeB,
      rawId: "bulk-node-b",
      harness: "claude",
      label: "Bulk Node B",
      timestamp: now,
    });

    // Add 700 items for nodeA (trimmed to 600 per-root in appendLog)
    for (let i = 0; i < 700; i++) {
      store.recordToolStart(nodeA, {
        callId: `bulk-call-a-${i}`,
        name: "Read",
        target: `file-a-${i}.ts`,
        timestamp: now + i * 2,
        isLive: false,
      });
    }

    // Add 700 items for nodeB (trimmed to 600 per-root in appendLog)
    for (let i = 0; i < 700; i++) {
      store.recordToolStart(nodeB, {
        callId: `bulk-call-b-${i}`,
        name: "Read",
        target: `file-b-${i}.ts`,
        timestamp: now + 1500 + i * 2,
        isLive: false,
      });
    }

    const snap = store.getSnapshot(now + 4000);
    // Combined snapshot capped at 1,200 entries
    assert.strictEqual(snap.activityLog.length, 1200);

    // Guaranteed at least 150 entries per root
    const aCount = snap.activityLog.filter(e => e.rootId === nodeA).length;
    const bCount = snap.activityLog.filter(e => e.rootId === nodeB).length;
    assert.ok(aCount >= 150, `Expected nodeA >= 150, got ${aCount}`);
    assert.ok(bCount >= 150, `Expected nodeB >= 150, got ${bCount}`);

    // Verify ascending timestamp order
    for (let i = 1; i < snap.activityLog.length; i++) {
      assert.ok(snap.activityLog[i].timestamp >= snap.activityLog[i - 1].timestamp);
    }
  });
});

describe("SemanticTaskBadge & Classifier", () => {
  it("classifies lifecycle kinds correctly", () => {
    assert.strictEqual(classifySemanticBadge({ kind: "prompt" }), "PROMPT");
    assert.strictEqual(classifySemanticBadge({ kind: "reply" }), "REPLY");
    assert.strictEqual(classifySemanticBadge({ kind: "skill" }), "SKILL");
    assert.strictEqual(classifySemanticBadge({ kind: "subagent_spawn" }), "SPAWN");
    assert.strictEqual(classifySemanticBadge({ kind: "subagent_complete" }), "DONE");
  });

  it("prioritizes isArtifact flag as PLAN", () => {
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "edit_file", isArtifact: true }),
      "PLAN"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "write_file", isArtifact: true }),
      "PLAN"
    );
  });

  it("classifies recognized tool names correctly", () => {
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "pr-link" }), "PR");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "AskUserQuestion" }), "ASK");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "ask_question" }), "ASK");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "request_user_input_async" }), "ASK");

    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "TodoWrite" }), "PLAN");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "TaskCreate" }), "PLAN");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "TaskUpdate" }), "PLAN");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "Plan" }), "PLAN");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "ExitPlanMode" }), "PLAN");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "update_plan" }), "PLAN");

    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "Agent" }), "SPAWN");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "Task" }), "SPAWN");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "invoke_subagent" }), "SPAWN");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "spawn_agent" }), "SPAWN");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "swarm" }), "SPAWN");

    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "SendMessage" }), "MSG");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "send_message" }), "MSG");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "followup_task" }), "MSG");

    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "mcp__github__get_issue" }), "MCP");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "call_mcp_tool" }), "MCP");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "read_resource" }), "MCP");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "list_resources" }), "MCP");

    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "WebSearch" }), "WEB");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "webfetch" }), "WEB");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "search_web" }), "WEB");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "browser_action" }), "WEB");

    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "grep" }), "SEARCH");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "glob" }), "SEARCH");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "find_by_name" }), "SEARCH");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "search_marketplace" }), "SEARCH");

    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "read" }), "READ");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "read_file" }), "READ");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "view_file" }), "READ");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "list_dir" }), "READ");

    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "write" }), "WRITE");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "write_file" }), "WRITE");

    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "edit" }), "EDIT");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "multiedit" }), "EDIT");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "notebookedit" }), "EDIT");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "edit_file" }), "EDIT");
    assert.strictEqual(classifySemanticBadge({ kind: "tool", toolName: "apply_patch" }), "EDIT");
  });

  it("classifies shell commands in priority order with unwrapping", () => {
    // PR
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "gh pr create --title 'feat'" }),
      "PR"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "run_command", command: "gh issue list" }),
      "PR"
    );

    // TEST
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "npm test" }),
      "TEST"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "npm run test:watch" }),
      "TEST"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "npx vitest run" }),
      "TEST"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "exec", command: "pytest tests/" }),
      "TEST"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "shell", command: "cargo test" }),
      "TEST"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "run_command", command: "dotnet test" }),
      "TEST"
    );

    // BUILD
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "npm run build" }),
      "BUILD"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "npm run typecheck" }),
      "BUILD"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "npx tsc --noEmit" }),
      "BUILD"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "exec", command: "cargo build" }),
      "BUILD"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "run_command", command: "make all" }),
      "BUILD"
    );

    // PKG
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "npm install express" }),
      "PKG"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "yarn add vue" }),
      "PKG"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "exec", command: "pip install requests" }),
      "PKG"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "shell", command: "cargo add serde" }),
      "PKG"
    );

    // GIT
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "git status -sb" }),
      "GIT"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "run_command", command: "git commit -m 'feat'" }),
      "GIT"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "exec", command: "git diff HEAD~1" }),
      "GIT"
    );

    // SEARCH
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "rg 'function foo' src/" }),
      "SEARCH"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "exec", command: "grep -rn 'hello' ." }),
      "SEARCH"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "shell", command: "find . -name '*.ts'" }),
      "SEARCH"
    );

    // READ
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "cat package.json" }),
      "READ"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "exec", command: "head -n 20 main.ts" }),
      "READ"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "run_command", command: "ls -la" }),
      "READ"
    );

    // SCRIPT
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "python scripts/audit.py" }),
      "SCRIPT"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "exec", command: "node scripts/build.js" }),
      "SCRIPT"
    );
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "./deploy.sh" }),
      "SCRIPT"
    );

    // Git Bash unwrapping and cd stripping
    assert.strictEqual(
      classifySemanticBadge({
        kind: "tool",
        toolName: "run_command",
        command:
          '& "C:/Program Files/Git/bin/bash.exe" -lc "cd /c/repo && npm test"',
      }),
      "TEST"
    );
    assert.strictEqual(
      classifySemanticBadge({
        kind: "tool",
        toolName: "run_command",
        command:
          '& "C:/Program Files/Git/bin/bash.exe" -lc "cd /c/repo && git status -sb"',
      }),
      "GIT"
    );

    // Default shell fallback
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "Bash", command: "curl https://example.com" }),
      "BASH"
    );

    // Generic tool fallback
    assert.strictEqual(
      classifySemanticBadge({ kind: "tool", toolName: "unknown_custom_tool" }),
      "TOOL"
    );
  });
});

describe("Diff Helpers", () => {
  it("computeEditLineDelta verifies unchanged context lines are stripped", () => {
    const oldText = [
      "import React from 'react';",
      "import { useState } from 'react';",
      "",
      "export function Counter() {",
      "  const [count, setCount] = useState(0);",
      "  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;",
      "}",
    ].join("\n");

    const newText = [
      "import React from 'react';",
      "import { useState } from 'react';",
      "",
      "export function Counter() {",
      "  const [count, setCount] = useState(0);",
      "  console.log('rendering count:', count);",
      "  return <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>;",
      "}",
    ].join("\n");

    const delta = computeEditLineDelta(oldText, newText);
    assert.ok(delta);
    // 1 line was replaced by 2 lines (1 line removed, 2 lines added)
    assert.strictEqual(delta.linesRemoved, 1);
    assert.strictEqual(delta.linesAdded, 2);
  });

  it("computeEditLineDelta handles edge cases: pure additions, removals, identicals, undefined", () => {
    // Pure addition
    const addDelta = computeEditLineDelta("", "line 1\nline 2\nline 3");
    assert.deepStrictEqual(addDelta, { linesAdded: 3, linesRemoved: 0 });

    // Pure addition with undefined oldText
    const addUndefDelta = computeEditLineDelta(undefined, "line 1\nline 2");
    assert.deepStrictEqual(addUndefDelta, { linesAdded: 2, linesRemoved: 0 });

    // Pure removal
    const remDelta = computeEditLineDelta("line 1\nline 2", "");
    assert.deepStrictEqual(remDelta, { linesAdded: 0, linesRemoved: 2 });

    // Identical
    const sameDelta = computeEditLineDelta("same line", "same line");
    assert.deepStrictEqual(sameDelta, { linesAdded: 0, linesRemoved: 0 });

    // Both undefined
    const undefDelta = computeEditLineDelta(undefined, undefined);
    assert.strictEqual(undefDelta, undefined);
  });

  it("computePatchLineDelta parses unified and Codex patches correctly", () => {
    // Unified diff
    const unified = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,5 +1,6 @@",
      " import express from 'express';",
      "-const port = 3000;",
      "+const port = process.env.PORT || 3000;",
      "+console.log('Port configured');",
      " const app = express();",
    ].join("\n");

    const uniDelta = computePatchLineDelta(unified);
    assert.ok(uniDelta);
    assert.strictEqual(uniDelta.firstFile, "src/app.ts");
    assert.strictEqual(uniDelta.linesRemoved, 1);
    assert.strictEqual(uniDelta.linesAdded, 2);

    // Codex Update File patch
    const codexUpdate = [
      "*** Update File: src/server.ts",
      "@@ -10,4 +10,5 @@",
      "-app.listen(3000);",
      "+app.listen(port, () => {",
      "+  console.log('ready');",
      "+});",
    ].join("\n");

    const codexDelta = computePatchLineDelta(codexUpdate);
    assert.ok(codexDelta);
    assert.strictEqual(codexDelta.firstFile, "src/server.ts");
    assert.strictEqual(codexDelta.linesRemoved, 1);
    assert.strictEqual(codexDelta.linesAdded, 3);

    // Codex Add File
    const codexAdd = [
      "*** Add File: src/config.ts",
      "+export const PORT = 8080;",
      "+export const HOST = 'localhost';",
    ].join("\n");

    const addFileDelta = computePatchLineDelta(codexAdd);
    assert.ok(addFileDelta);
    assert.strictEqual(addFileDelta.firstFile, "src/config.ts");
    assert.strictEqual(addFileDelta.linesRemoved, 0);
    assert.strictEqual(addFileDelta.linesAdded, 2);

    // Undefined / empty
    assert.strictEqual(computePatchLineDelta(undefined), undefined);
    assert.strictEqual(computePatchLineDelta(""), undefined);
  });
});

describe("Telemetry Adapters & Milestone Extraction", () => {
  it("Claude adapter separates Bash description summary from rawCommand and tracks Edit deltas", () => {
    const store = new GraphStore();
    const ctx: ClaudeFileContext = {
      filePath: "C:/projects/orbit/session-001.jsonl",
      sessionId: "session-001",
      nodeId: "claude:session-001",
    };
    const now = Date.now();

    // 1. Tool Use: Bash with description
    const bashLine = JSON.stringify({
      type: "assistant",
      timestamp: new Date(now).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_bash_1",
            name: "Bash",
            input: {
              description: "Run vitest test suites",
              command: "npm test",
            },
          },
        ],
      },
    });
    ingestClaudeLine(ctx, bashLine, store, now, false);

    const snap1 = store.getSnapshot(now);
    const bashEntry = snap1.activityLog.find(e => e.id === "claude:session-001:tool:call_bash_1");
    assert.ok(bashEntry);
    assert.strictEqual(bashEntry.badge, "TEST");
    assert.strictEqual(bashEntry.summary, "Run vitest test suites");
    assert.strictEqual(bashEntry.rawCommand, "npm test");
    assert.strictEqual(bashEntry.status, "running");

    // Tool Result for bash with durationMs
    const bashResultLine = JSON.stringify({
      type: "user",
      timestamp: new Date(now + 1200).toISOString(),
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_bash_1",
            content: "Tests passed",
          },
        ],
      },
      toolUseResult: {
        durationMs: 1200,
      },
    });
    ingestClaudeLine(ctx, bashResultLine, store, now + 1200, false);

    const snap2 = store.getSnapshot(now + 1200);
    const bashEntryDone = snap2.activityLog.find(e => e.id === "claude:session-001:tool:call_bash_1");
    assert.ok(bashEntryDone);
    assert.strictEqual(bashEntryDone.status, "done");
    assert.strictEqual(bashEntryDone.durationMs, 1200);

    // 2. Tool Use: Edit with line deltas
    const editLine = JSON.stringify({
      type: "assistant",
      timestamp: new Date(now + 1500).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_edit_1",
            name: "Edit",
            input: {
              file_path: "src/utils.ts",
              old_string: "line 1\nline 2",
              new_string: "line 1\nline 2 mod\nline 3 add",
            },
          },
        ],
      },
    });
    ingestClaudeLine(ctx, editLine, store, now + 1500, false);

    const snap3 = store.getSnapshot(now + 1500);
    const editEntry = snap3.activityLog.find(e => e.id === "claude:session-001:tool:call_edit_1");
    assert.ok(editEntry);
    assert.strictEqual(editEntry.badge, "EDIT");
    assert.strictEqual(editEntry.linesRemoved, 1);
    assert.strictEqual(editEntry.linesAdded, 2);

    // 3. Assistant text milestone reply
    const replyLine = JSON.stringify({
      type: "assistant",
      timestamp: new Date(now + 2000).toISOString(),
      message: {
        content: [
          {
            type: "text",
            text: "All 12 test suites passing! Code refactor complete.",
          },
        ],
      },
    });
    ingestClaudeLine(ctx, replyLine, store, now + 2000, false);

    const snap4 = store.getSnapshot(now + 2000);
    const replyEntry = snap4.activityLog.find(e => e.kind === "reply");
    assert.ok(replyEntry);
    assert.strictEqual(replyEntry.badge, "REPLY");
    assert.strictEqual(replyEntry.title, "Reply");
    assert.strictEqual(replyEntry.summary, "All 12 test suites passing! Code refactor complete.");

    // 4. pr-link milestone
    const prLine = JSON.stringify({
      type: "pr-link",
      timestamp: new Date(now + 2500).toISOString(),
      url: "https://github.com/org/repo/pull/42",
    });
    ingestClaudeLine(ctx, prLine, store, now + 2500, false);

    const snap5 = store.getSnapshot(now + 2500);
    const prEntry = snap5.activityLog.find(e => e.badge === "PR" && e.kind === "reply");
    assert.ok(prEntry);
    assert.strictEqual(prEntry.title, "PR");
    assert.strictEqual(prEntry.summary, "https://github.com/org/repo/pull/42");
  });

  it("Antigravity adapter extracts exit code, duration, ArtifactMetadata and milestone replies", () => {
    const store = new GraphStore();
    const ctx: AntigravityFileContext = {
      filePath: "C:/Users/test/.gemini/antigravity/brain/session-agy-001/.system_generated/logs/transcript.jsonl",
      convId: "session-agy-001",
      nodeId: "antigravity:session-agy-001",
      pendingSubagentRoles: [],
    };
    const now = Date.now();

    // 1. PLANNER_RESPONSE run_command with CommandLine and toolSummary
    const runLine = JSON.stringify({
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: new Date(now).toISOString(),
      tool_calls: [
        {
          name: "run_command",
          args: {
            CommandLine: "git status -s",
            toolSummary: "Check git status",
          },
        },
      ],
    });
    ingestAntigravityLine(ctx, runLine, store, now, false);

    const snap1 = store.getSnapshot(now);
    const toolEntry = snap1.activityLog.find(e => e.title === "run_command");
    assert.ok(toolEntry);
    assert.strictEqual(toolEntry.badge, "GIT");
    assert.strictEqual(toolEntry.summary, "Check git status");
    assert.strictEqual(toolEntry.rawCommand, "git status -s");

    // 2. GENERIC output with Created At / Completed At and exit code
    const genericLine = JSON.stringify({
      type: "GENERIC",
      step_index: 2,
      created_at: new Date(now + 2500).toISOString(),
      status: "DONE",
      content: [
        "Created At: 2026-11-11T16:52:45.000Z",
        "Completed At: 2026-11-11T16:52:47.500Z",
        "Command exited with code 1.",
        "",
        "Command output:",
        "fatal: not a git repository",
      ].join("\n"),
    });
    ingestAntigravityLine(ctx, genericLine, store, now + 2500, false);

    const snap2 = store.getSnapshot(now + 2500);
    const finishedTool = snap2.activityLog.find(e => e.title === "run_command");
    assert.ok(finishedTool);
    assert.strictEqual(finishedTool.status, "error");
    assert.strictEqual(finishedTool.exitCode, 1);
    assert.strictEqual(finishedTool.durationMs, 2500);

    // 3. edit_file with ArtifactMetadata -> PLAN
    const artifactLine = JSON.stringify({
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: new Date(now + 3000).toISOString(),
      tool_calls: [
        {
          name: "edit_file",
          args: {
            Path: "C:/brain/task.md",
            Target: "old content",
            Replacement: "new content",
            ArtifactMetadata: {
              Summary: "Implementation checklist for release v0.46",
              UserFacing: true,
              RequestFeedback: false,
            },
          },
        },
      ],
    });
    ingestAntigravityLine(ctx, artifactLine, store, now + 3000, false);

    const snap3 = store.getSnapshot(now + 3000);
    const artifactEntry = snap3.activityLog.find(e => e.title === "edit_file");
    assert.ok(artifactEntry);
    assert.strictEqual(artifactEntry.badge, "PLAN");
    assert.strictEqual(artifactEntry.summary, "Implementation checklist for release v0.46");

    // 4. Assistant text without tool calls -> recordAssistantMilestone
    const textOnlyLine = JSON.stringify({
      type: "PLANNER_RESPONSE",
      step_index: 4,
      created_at: new Date(now + 4000).toISOString(),
      content: "All refactoring tasks have completed successfully. Ready for verification.",
    });
    ingestAntigravityLine(ctx, textOnlyLine, store, now + 4000, false);

    const snap4 = store.getSnapshot(now + 4000);
    const agyReply = snap4.activityLog.find(e => e.kind === "reply");
    assert.ok(agyReply);
    assert.strictEqual(agyReply.badge, "REPLY");
    assert.strictEqual(
      agyReply.summary,
      "All refactoring tasks have completed successfully. Ready for verification."
    );
  });

  it("Subagent DONE rollup tracks durationMs and subagentToolCount", () => {
    const store = new GraphStore();
    const now = Date.now();
    const parentId = "claude:parent-session";
    const subId = "claude:parent-session:sub:worker-1";

    store.upsertNode({
      id: parentId,
      rawId: "parent-session",
      harness: "claude",
      label: "Parent Coordinator",
      timestamp: now,
    });

    store.upsertNode({
      id: subId,
      rawId: "worker-1",
      harness: "claude",
      parentId,
      isSubagent: true,
      label: "Worker 1",
      model: "claude-3-7-sonnet-20250219",
      timestamp: now,
    });

    // Subagent executes 4 tools
    for (let i = 0; i < 4; i++) {
      store.recordToolStart(subId, {
        callId: `sub-tool-${i}`,
        name: "Bash",
        target: "npm test",
        timestamp: now + (i + 1) * 200,
        isLive: false,
      });
      store.recordToolEnd(subId, {
        callId: `sub-tool-${i}`,
        timestamp: now + (i + 1) * 200 + 100,
        isLive: false,
      });
    }

    // Complete subagent
    store.markCompleted(subId, now + 1500, false);

    const snap = store.getSnapshot(now + 1600);
    const completeEntry = snap.activityLog.find(
      e => e.nodeId === subId && e.kind === "subagent_complete"
    );
    assert.ok(completeEntry);
    assert.strictEqual(completeEntry.badge, "DONE");
    assert.strictEqual(completeEntry.subagentToolCount, 4);
    assert.strictEqual(completeEntry.durationMs, 1500);
    assert.strictEqual(completeEntry.modelBadge, "3-7-sonnet");
  });

  it("cleanAssistantMilestone cleans markdown and recordAssistantMilestone deduplicates", () => {
    const rawMarkdown = [
      "### Header Title",
      "",
      "Here is the report with [Release Docs](file:///C:/Users/dev/docs.md):",
      "```typescript",
      "const foo = 123;",
      "```",
      "* Bullet item 1",
      "* Bullet item 2",
    ].join("\n");

    const cleaned = cleanAssistantMilestone(rawMarkdown);
    assert.ok(cleaned);
    assert.ok(!cleaned.includes("```"));
    assert.ok(!cleaned.includes("file:///"));
    assert.ok(cleaned.includes("Release Docs"));
    assert.ok(!cleaned.includes("###"));

    const store = new GraphStore();
    const now = Date.now();
    const nodeId = "claude:dedup-node";

    store.upsertNode({
      id: nodeId,
      rawId: "dedup-node",
      harness: "claude",
      label: "Dedup Agent",
      timestamp: now,
    });

    // Record milestone twice with exact same text
    store.recordAssistantMilestone(nodeId, "Execution finished cleanly.", now);
    store.recordAssistantMilestone(nodeId, "Execution finished cleanly.", now + 50);

    const snap = store.getSnapshot(now + 100);
    const replies = snap.activityLog.filter(e => e.nodeId === nodeId && e.kind === "reply");
    assert.strictEqual(replies.length, 1);
  });
});

describe("Full Untruncated Activity Log & Transcripts", () => {
  it("preserves long multi-paragraph user prompts (> 500 chars) with newlines and code blocks in fullText and concise summary", () => {
    const store = new GraphStore();
    const now = Date.now();
    const nodeId = "claude:untruncated-prompt-node";

    store.upsertNode({
      id: nodeId,
      rawId: "untruncated-prompt-node",
      harness: "claude",
      label: "Prompt Agent",
      timestamp: now,
    });

    const longPrompt = [
      "Here is a detailed user request to refactor the activity log system:",
      "",
      "1. Make sure all entries preserve their multi-line text without truncation.",
      "2. When expanding a PROMPT or REPLY row, show the full content in the panel.",
      "3. Here is an example of code to inspect:",
      "```typescript",
      "export function cleanLogCommand(raw?: string): string | undefined {",
      "  if (!raw) return undefined;",
      "  return raw.replace(/\\r\\n/g, '\\n').trim();",
      "}",
      "```",
      "Ensure all ANSI escape sequences are stripped, and tests pass with 100% green status across all platforms.",
      "Additional instructions for edge cases: handle empty lines, whitespace collapsing in 1-line summary, and long tokens.",
    ].join("\n");

    assert.ok(longPrompt.length > 500, `Expected prompt length > 500, got ${longPrompt.length}`);

    store.recordUserPrompt(nodeId, longPrompt, now + 10);

    const snap = store.getSnapshot(now + 20);
    const entry = snap.activityLog.find(e => e.nodeId === nodeId && e.kind === "prompt");
    assert.ok(entry, "Prompt entry must exist in activity log");

    // Summary must be crisp 1-line <= 110 chars
    assert.ok(entry.summary, "Summary must be populated");
    assert.ok(entry.summary.length <= 110, `Expected summary <= 110, got ${entry.summary.length}`);
    assert.ok(!entry.summary.includes("\n"), "Summary must be single-line without newlines");

    // fullText must preserve 100% verbatim multi-line text with code blocks without '...' truncation
    assert.ok(entry.fullText, "fullText must be populated");
    assert.strictEqual(entry.fullText, longPrompt);
    assert.ok(entry.fullText.includes("```typescript"));
    assert.ok(entry.fullText.includes("export function cleanLogCommand"));
    assert.ok(!entry.fullText.endsWith("..."));
  });

  it("preserves long multi-paragraph assistant replies (> 600 chars) with code blocks in fullText and concise summary", () => {
    const store = new GraphStore();
    const now = Date.now();
    const nodeId = "claude:untruncated-reply-node";

    store.upsertNode({
      id: nodeId,
      rawId: "untruncated-reply-node",
      harness: "claude",
      label: "Reply Agent",
      timestamp: now,
    });

    const longReply = [
      "### Architectural Summary & Implementation Complete",
      "",
      "We have resolved the activity log truncation issue with the following changes:",
      "",
      "- Updated ActivityLogEntry with fullText, output, and diffPreview fields.",
      "- Modified GraphStore to retain 3,000 entries globally and 1,200 in snapshots.",
      "- Replaced the collapsed text in the expanded panel with non-duplicating multi-line views.",
      "",
      "```typescript",
      "interface ActivityLogEntry {",
      "  fullText?: string;",
      "  output?: string;",
      "  diffPreview?: string;",
      "}",
      "```",
      "",
      "All automated tests have succeeded, and the application compiles cleanly without errors.",
      "The user can now click any row to inspect complete multi-line shell scripts, unified diffs, and prompt text.",
    ].join("\n");

    assert.ok(longReply.length > 600, `Expected reply length > 600, got ${longReply.length}`);

    store.recordAssistantMilestone(nodeId, longReply, now + 10);

    const snap = store.getSnapshot(now + 20);
    const entry = snap.activityLog.find(e => e.nodeId === nodeId && e.kind === "reply");
    assert.ok(entry, "Reply entry must exist in activity log");

    // Summary must be crisp 1-line <= 120 chars without code blocks or markdown headers
    assert.ok(entry.summary, "Summary must be populated");
    assert.ok(entry.summary.length <= 120, `Expected summary <= 120, got ${entry.summary.length}`);
    assert.ok(!entry.summary.includes("\n"), "Summary must be single line");
    assert.ok(!entry.summary.includes("```"), "Summary must strip code fences");
    assert.ok(!entry.summary.includes("###"), "Summary must strip header hashes");

    // fullText must preserve 100% of the verbatim multi-line reply with code blocks
    assert.ok(entry.fullText, "fullText must be populated on reply");
    assert.strictEqual(entry.fullText, longReply);
    assert.ok(entry.fullText.includes("```typescript"));
    assert.ok(entry.fullText.includes("interface ActivityLogEntry"));
  });

  it("preserves multi-line shell commands (> 800 chars) and attaches tool output on recordToolEnd", () => {
    const store = new GraphStore();
    const now = Date.now();
    const nodeId = "claude:cmd-output-node";

    store.upsertNode({
      id: nodeId,
      rawId: "cmd-output-node",
      harness: "claude",
      label: "Command Agent",
      timestamp: now,
    });

    const lines: string[] = [];
    lines.push("#!/usr/bin/env bash");
    lines.push("set -euo pipefail");
    for (let i = 0; i < 25; i++) {
      lines.push(`echo "Step ${i}: Processing batch file component /var/log/pipeline/chunk_${i}.log"`);
    }
    lines.push("echo 'Pipeline execution complete with exit code 0'");
    const longBashScript = lines.join("\n");

    assert.ok(longBashScript.length > 800, `Expected script length > 800, got ${longBashScript.length}`);

    const callId = "call-multiline-bash-1";
    store.recordToolStart(nodeId, {
      callId,
      name: "Bash",
      rawCommand: longBashScript,
      timestamp: now + 10,
      isLive: false,
    });

    let snap = store.getSnapshot(now + 15);
    let entry = snap.activityLog.find(e => e.id === `${nodeId}:tool:${callId}`);
    assert.ok(entry, "Tool entry must exist");
    assert.ok(entry.rawCommand, "rawCommand must exist");
    assert.strictEqual(entry.rawCommand, longBashScript);
    assert.ok(entry.rawCommand.includes("\n"), "rawCommand must preserve newlines");

    // Now end tool with stdout output and ANSI escape sequences
    const rawStdout = [
      "\x1b[32m[SUCCESS]\x1b[0m Pipeline finished successfully.",
      "Processed 25 log chunks in 1.42s.",
      "Output saved to /var/log/pipeline/summary.json",
    ].join("\n");

    store.recordToolEnd(nodeId, {
      callId,
      output: rawStdout,
      exitCode: 0,
      timestamp: now + 50,
      isLive: false,
    });

    snap = store.getSnapshot(now + 60);
    entry = snap.activityLog.find(e => e.id === `${nodeId}:tool:${callId}`);
    assert.ok(entry);
    assert.strictEqual(entry.status, "done");
    assert.ok(entry.output, "output must be attached to ActivityLogEntry");
    assert.ok(!entry.output.includes("\x1b[32m"), "ANSI escape codes must be stripped");
    assert.ok(entry.output.includes("[SUCCESS] Pipeline finished successfully."));
    assert.ok(entry.output.includes("Processed 25 log chunks in 1.42s."));
  });

  it("populates entry.diffPreview with - and + lines for Edit, write_file, and apply_patch", () => {
    // 1. buildCompactDiffPreview for Edit
    const oldCode = [
      "function calculateTotal(items: Item[]): number {",
      "  let sum = 0;",
      "  for (const item of items) {",
      "    sum += item.price;",
      "  }",
      "  return sum;",
      "}",
    ].join("\n");

    const newCode = [
      "function calculateTotal(items: Item[]): number {",
      "  let sum = 0;",
      "  for (const item of items) {",
      "    sum += item.price * (1 - item.discount);",
      "  }",
      "  return sum;",
      "}",
    ].join("\n");

    const editDiff = buildCompactDiffPreview(oldCode, newCode);
    assert.ok(editDiff, "Diff preview must be generated");
    assert.ok(editDiff.includes("-     sum += item.price;"));
    assert.ok(editDiff.includes("+     sum += item.price * (1 - item.discount);"));
    assert.ok(editDiff.includes("    let sum = 0;"), "Context line must be prefixed with 2 spaces");

    // 2. buildCompactDiffPreview for Write (new file)
    const newFileContent = "line 1\nline 2\nline 3";
    const writeDiff = buildCompactDiffPreview("", newFileContent);
    assert.ok(writeDiff);
    assert.ok(writeDiff.includes("+ line 1"));
    assert.ok(writeDiff.includes("+ line 2"));
    assert.ok(writeDiff.includes("+ line 3"));

    // 3. formatPatchPreview for Codex apply_patch
    const codexPatch = [
      "*** Update File: src/main/tailer.ts",
      "@@ -10,3 +10,3 @@",
      " const OLD_LIMIT = 100;",
      "-const MAX_CHUNKS = 10;",
      "+const MAX_CHUNKS = 50;",
    ].join("\n");

    const patchPreview = formatPatchPreview(codexPatch);
    assert.ok(patchPreview);
    assert.ok(patchPreview.includes("-const MAX_CHUNKS = 10;"));
    assert.ok(patchPreview.includes("+const MAX_CHUNKS = 50;"));
  });

  it("parseAntigravityFilePath matches both transcript.jsonl and transcript_full.jsonl to the exact same nodeId", () => {
    const compactPath = "C:/Users/dev/.gemini/antigravity/brain/session-uuid-1234/.system_generated/logs/transcript.jsonl";
    const fullPath = "C:/Users/dev/.gemini/antigravity/brain/session-uuid-1234/.system_generated/logs/transcript_full.jsonl";

    const compactCtx = parseAntigravityFilePath(compactPath);
    assert.ok(compactCtx, "compact transcript must parse");
    assert.strictEqual(compactCtx.convId, "session-uuid-1234");
    assert.strictEqual(compactCtx.nodeId, "antigravity:session-uuid-1234");

    const fullCtx = parseAntigravityFilePath(fullPath);
    assert.ok(fullCtx, "full transcript must parse");
    assert.strictEqual(fullCtx.convId, "session-uuid-1234");
    assert.strictEqual(fullCtx.nodeId, "antigravity:session-uuid-1234");

    assert.strictEqual(compactCtx.nodeId, fullCtx.nodeId, "Both paths must resolve to the identical nodeId");
  });

  it("captures structured toolInput for SEARCH / GIT / EDIT / PR and lazy-loads it via getLogDetail", () => {
    const store = new GraphStore();
    const ctx = parseClaudeFilePath(
      "C:/Users/dev/.claude/projects/C--Users-dev-code-orbit/session-detail-01.jsonl"
    )!;
    const now = Date.now();

    // 1. Grep with BOTH pattern and path preserves pattern in 1-line summary AND full JSON in toolInput
    const grepLine = JSON.stringify({
      type: "assistant",
      sessionId: "session-detail-01",
      timestamp: new Date(now).toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_grep_01",
            name: "Grep",
            input: {
              pattern: "manual_qa",
              path: "C:/Users/dev/.claude/skills/release-pipeline/references/boards/release-board-generator",
              glob: "*.md",
              "-C": 5,
            },
          },
        ],
      },
    });
    ingestClaudeLine(ctx, grepLine, store, now, false);

    const wireSnap = store.getSnapshot(now, { stripHeavyLogFields: true });
    const grepEntry = wireSnap.activityLog.find(e => e.title === "Grep");
    assert.ok(grepEntry, "Grep entry must exist");
    assert.strictEqual(grepEntry.badge, "SEARCH");
    const grepDetail = grepEntry.detail ?? "";
    assert.ok(grepDetail.includes("\"manual_qa\""), `Detail should include search pattern, got: ${grepDetail}`);
    assert.ok(grepDetail.includes("release-board-generator"), `Detail should include path, got: ${grepDetail}`);
    assert.strictEqual(grepEntry.toolInput, undefined, "Heavy toolInput must be stripped from wire snapshot");
    assert.strictEqual(grepEntry.hasToolInput, true, "Wire entry must set hasToolInput=true");

    const detail = store.getLogDetail(grepEntry.id);
    assert.ok(detail?.toolInput, "getLogDetail must return full toolInput JSON");
    const parsedGrepArgs = JSON.parse(detail.toolInput);
    assert.strictEqual(parsedGrepArgs.pattern, "manual_qa");
    assert.strictEqual(parsedGrepArgs.glob, "*.md");
    assert.strictEqual(parsedGrepArgs["-C"], 5);

    // 2. Bash GIT command omits redundant command key from toolInput while keeping description & timeout
    const bashLine = JSON.stringify({
      type: "assistant",
      sessionId: "session-detail-01",
      timestamp: new Date(now + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_git_01",
            name: "Bash",
            input: {
              command: "git status -sb && git log -1 --oneline",
              description: "Check main checkout state, preview head and running Unity",
              timeout: 30000,
            },
          },
        ],
      },
    });
    ingestClaudeLine(ctx, bashLine, store, now + 1000, false);
    const bashSnap = store.getSnapshot(now + 1000);
    const gitEntry = bashSnap.activityLog.find(e => e.badge === "GIT");
    assert.ok(gitEntry);
    assert.strictEqual(gitEntry.rawCommand, "git status -sb && git log -1 --oneline");
    assert.ok(gitEntry.toolInput);
    const parsedBashArgs = JSON.parse(gitEntry.toolInput);
    assert.strictEqual(parsedBashArgs.command, undefined, "Redundant command key omitted when rawCommand is stored");
    assert.strictEqual(parsedBashArgs.timeout, 30000);

    // 3. pr-link stores PR metadata in toolInput, sets clickable filePath URL, and deduplicates consecutive identical links
    const prLine = JSON.stringify({
      type: "pr-link",
      timestamp: new Date(now + 2000).toISOString(),
      prUrl: "https://github.com/acme-org/nebula-cloud/pull/3945",
      prNumber: 3945,
      prRepository: "acme-org/nebula-cloud",
    });
    ingestClaudeLine(ctx, prLine, store, now + 2000, false);
    ingestClaudeLine(ctx, prLine, store, now + 2100, false);

    const prSnap = store.getSnapshot(now + 2100);
    const prEntries = prSnap.activityLog.filter(e => e.badge === "PR");
    assert.strictEqual(prEntries.length, 1, "Consecutive identical PR links must deduplicate");
    assert.strictEqual(prEntries[0].filePath, "https://github.com/acme-org/nebula-cloud/pull/3945");
    assert.ok(prEntries[0].toolInput);
    const parsedPrMeta = JSON.parse(prEntries[0].toolInput);
    assert.strictEqual(parsedPrMeta.prNumber, 3945);
    assert.strictEqual(parsedPrMeta.repository, "acme-org/nebula-cloud");

    // 4. serializeToolCallInput summarizes huge old_string/new_string bodies when hasDiff=true
    const hugeBody = Array.from({ length: 25 }, (_, i) => `const row_${i} = computeValue(${i});`).join("\n");
    const editSerialized = serializeToolCallInput(
      "Edit",
      { file_path: "src/app.ts", old_string: hugeBody, new_string: hugeBody + "\n// done", replace_all: false },
      { hasDiff: true }
    );
    assert.ok(editSerialized);
    const parsedEdit = JSON.parse(editSerialized);
    assert.strictEqual(parsedEdit.file_path, "src/app.ts");
    assert.strictEqual(parsedEdit.replace_all, false);
    assert.ok(String(parsedEdit.old_string).includes("see diff below"));

    assert.strictEqual(
      formatSearchTargetSummary("find_by_name", { Pattern: "*.tsx", SearchDirectory: "src/components" }),
      "*.tsx in src/components"
    );
  });
});
