/**
 * Tests for WebSocket session event streaming — tool call input update
 * and parseEventsToBlocks / incrementalBlockUpdate parity.
 *
 * AC: @ws-session-event-streaming ac-tool-input-update
 * AC: @ws-session-event-streaming ac-unified-event-parsing
 */

import { describe, it, expect } from "vitest";

// These imports use relative paths to the web-ui package source.
// We can't import from SvelteKit $lib aliases in vitest, so we import directly.
import {
  parseEventsToBlocks,
  incrementalBlockUpdate,
  type DisplayBlock,
  type ToolCallBlock,
} from "../packages/web-ui/src/lib/components/session/session-utils";

function makeTerminalToolCallEvent(status: "completed" | "failed") {
  return {
    ts: status === "completed" ? 2000 : 3000,
    seq: status === "completed" ? 12 : 13,
    type: "session.update" as const,
    session_id: "sess1",
    data: {
      sessionUpdate: "tool_call",
      toolCallId: `view-image-${status}`,
      status,
      kind: "read",
      title: "View Image /tmp/example.png",
    },
  };
}

// AC: @ws-session-event-streaming ac-tool-input-update
describe("incrementalBlockUpdate — tool_call_input", () => {
  it("updates tool call input in-place when tool_call_input event arrives", () => {
    // Start with a tool call that has null input (registration phase)
    let blocks: DisplayBlock[] = [];
    blocks = incrementalBlockUpdate(blocks, "tool_call_start", {
      tool_call_id: "tc-1",
      tool_name: "Bash",
      tool_input: null,
      timestamp: 1000,
    });

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as ToolCallBlock).input).toBeNull();

    // Phase 2: input arrives
    blocks = incrementalBlockUpdate(blocks, "tool_call_input", {
      tool_call_id: "tc-1",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      timestamp: 1001,
    });

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as ToolCallBlock).input).toEqual({ command: "git status" });
    expect((blocks[0] as ToolCallBlock).status).toBe("running");
  });

  it("does not create a duplicate block for tool_call_input", () => {
    let blocks: DisplayBlock[] = [];
    blocks = incrementalBlockUpdate(blocks, "tool_call_start", {
      tool_call_id: "tc-1",
      tool_name: "Bash",
      tool_input: null,
      timestamp: 1000,
    });

    blocks = incrementalBlockUpdate(blocks, "tool_call_input", {
      tool_call_id: "tc-1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      timestamp: 1001,
    });

    const toolCallBlocks = blocks.filter((b) => b.type === "tool_call");
    expect(toolCallBlocks).toHaveLength(1);
  });

  it("handles tool_call_input when no matching tool call exists (no-op)", () => {
    let blocks: DisplayBlock[] = [];
    blocks = incrementalBlockUpdate(blocks, "tool_call_input", {
      tool_call_id: "tc-nonexistent",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      timestamp: 1000,
    });

    expect(blocks).toHaveLength(0);
  });

  it("complete sequence: start → input → complete", () => {
    let blocks: DisplayBlock[] = [];

    // Phase 1: registration
    blocks = incrementalBlockUpdate(blocks, "tool_call_start", {
      tool_call_id: "tc-1",
      tool_name: "Read",
      tool_input: null,
      timestamp: 1000,
    });

    // Phase 2: input
    blocks = incrementalBlockUpdate(blocks, "tool_call_input", {
      tool_call_id: "tc-1",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.ts" },
      timestamp: 1001,
    });

    // Phase 3: completion
    blocks = incrementalBlockUpdate(blocks, "tool_call_complete", {
      tool_call_id: "tc-1",
      tool_name: "Read",
      status: "completed",
      duration_ms: 150,
      timestamp: 1002,
    });

    expect(blocks).toHaveLength(1);
    const tc = blocks[0] as ToolCallBlock;
    expect(tc.input).toEqual({ file_path: "/tmp/test.ts" });
    expect(tc.status).toBe("completed");
    expect(tc.durationMs).toBe(150);
  });
});

// AC: @ws-session-event-streaming ac-unified-event-parsing
describe("parseEventsToBlocks — ACP format", () => {
  it("parses ACP format tool_call events (data IS SessionUpdate)", () => {
    const events = [
      {
        ts: 1000,
        seq: 0,
        type: "session.update" as const,
        session_id: "sess1",
        data: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Bash",
          rawInput: { command: "git status" },
        },
      },
      {
        ts: 1001,
        seq: 1,
        type: "session.update" as const,
        session_id: "sess1",
        data: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          rawOutput: "output data",
        },
      },
    ];

    const blocks = parseEventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    const tc = blocks[0] as ToolCallBlock;
    expect(tc.toolName).toBe("Bash");
    expect(tc.toolCallId).toBe("tc-1");
    expect(tc.input).toEqual({ command: "git status" });
    expect(tc.status).toBe("completed");
    expect(tc.output).toBe("output data");
  });

  it("handles phased tool call with ACP format (rawInput arrives via tool_call_update)", () => {
    const events = [
      // Phase 1: registration with empty rawInput
      {
        ts: 1000,
        seq: 0,
        type: "session.update" as const,
        session_id: "sess1",
        data: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Bash",
          rawInput: {},
        },
      },
      // Phase 2: input arrives via tool_call_update (no status change)
      {
        ts: 1001,
        seq: 1,
        type: "session.update" as const,
        session_id: "sess1",
        data: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          rawInput: { command: "npm test" },
        },
      },
      // Phase 3: completion
      {
        ts: 1002,
        seq: 2,
        type: "session.update" as const,
        session_id: "sess1",
        data: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          rawOutput: "tests passed",
        },
      },
    ];

    const blocks = parseEventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    const tc = blocks[0] as ToolCallBlock;
    expect(tc.input).toEqual({ command: "npm test" });
    expect(tc.status).toBe("completed");
  });

  it("produces identical blocks to sequential incrementalBlockUpdate for same event sequence", () => {
    // Simulate a session with messages and tool calls using typed broadcast events
    const httpEvents = [
      {
        ts: 1000,
        seq: 0,
        type: "session.update" as const,
        session_id: "sess1",
        data: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello\n" },
        },
      },
      {
        ts: 1001,
        seq: 1,
        type: "session.update" as const,
        session_id: "sess1",
        data: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Bash",
          rawInput: { command: "ls" },
        },
      },
      {
        ts: 1002,
        seq: 2,
        type: "session.update" as const,
        session_id: "sess1",
        data: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
          rawOutput: "file1 file2",
        },
      },
    ];

    const httpBlocks = parseEventsToBlocks(httpEvents);

    // Same events, but via incrementalBlockUpdate (typed broadcast events)
    let wsBlocks: DisplayBlock[] = [];
    wsBlocks = incrementalBlockUpdate(wsBlocks, "message_start", { timestamp: 1000 });
    wsBlocks = incrementalBlockUpdate(wsBlocks, "message_progress", {
      text: "Hello\n",
      timestamp: 1000,
    });
    wsBlocks = incrementalBlockUpdate(wsBlocks, "message_complete", { text: "", timestamp: 1000 });
    wsBlocks = incrementalBlockUpdate(wsBlocks, "tool_call_start", {
      tool_call_id: "tc-1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      timestamp: 1001,
    });
    wsBlocks = incrementalBlockUpdate(wsBlocks, "tool_call_complete", {
      tool_call_id: "tc-1",
      tool_name: "Bash",
      status: "completed",
      duration_ms: 1,
      timestamp: 1002,
    });

    // Both should have a message block and a tool call block
    expect(httpBlocks.filter((b) => b.type === "message")).toHaveLength(1);
    expect(wsBlocks.filter((b) => b.type === "message")).toHaveLength(1);
    expect(httpBlocks.filter((b) => b.type === "tool_call")).toHaveLength(1);
    expect(wsBlocks.filter((b) => b.type === "tool_call")).toHaveLength(1);

    // Tool call blocks should have identical content-relevant fields
    const httpTc = httpBlocks.find((b) => b.type === "tool_call") as ToolCallBlock;
    const wsTc = wsBlocks.find((b) => b.type === "tool_call") as ToolCallBlock;
    expect(httpTc.toolName).toBe(wsTc.toolName);
    expect(httpTc.toolCallId).toBe(wsTc.toolCallId);
    expect(httpTc.input).toEqual(wsTc.input);
    expect(httpTc.status).toBe(wsTc.status);
  });
});

// AC: @ws-session-event-streaming ac-terminal-tool-call-display-parity
// AC: @ws-session-event-streaming ac-terminal-tool-call-output-sequence
describe("parseEventsToBlocks — terminal initial tool_call events", () => {
  it("renders an initial completed tool_call as completed without a later update", () => {
    const event = makeTerminalToolCallEvent("completed");

    const httpBlocks = parseEventsToBlocks([event]);
    let wsBlocks: DisplayBlock[] = [];
    wsBlocks = incrementalBlockUpdate(wsBlocks, "tool_call_start", {
      tool_call_id: "view-image-completed",
      tool_name: "View Image /tmp/example.png",
      tool_input: null,
      timestamp: event.ts,
    });
    wsBlocks = incrementalBlockUpdate(wsBlocks, "tool_call_complete", {
      tool_call_id: "view-image-completed",
      tool_name: "View Image /tmp/example.png",
      status: "completed",
      duration_ms: 0,
      timestamp: event.ts,
    });

    expect(httpBlocks).toHaveLength(1);
    expect(wsBlocks).toHaveLength(1);
    const httpTool = httpBlocks[0] as ToolCallBlock;
    const wsTool = wsBlocks[0] as ToolCallBlock;
    expect(httpTool.status).toBe("completed");
    expect(wsTool.status).toBe("completed");
    expect(httpTool.toolCallId).toBe("view-image-completed");
    expect(httpTool.toolName).toBe("View Image /tmp/example.png");
    expect(httpTool.resultSeq).toBe(event.seq);
    expect(httpTool.seq).toBe(event.seq);
    expect(httpTool.output).toBeUndefined();
  });

  it("renders an initial failed tool_call as failed without a later update", () => {
    const event = makeTerminalToolCallEvent("failed");

    const httpBlocks = parseEventsToBlocks([event]);
    let wsBlocks: DisplayBlock[] = [];
    wsBlocks = incrementalBlockUpdate(wsBlocks, "tool_call_start", {
      tool_call_id: "view-image-failed",
      tool_name: "View Image /tmp/example.png",
      tool_input: null,
      timestamp: event.ts,
    });
    wsBlocks = incrementalBlockUpdate(wsBlocks, "tool_call_complete", {
      tool_call_id: "view-image-failed",
      tool_name: "View Image /tmp/example.png",
      status: "failed",
      duration_ms: 0,
      timestamp: event.ts,
    });

    expect(httpBlocks).toHaveLength(1);
    expect(wsBlocks).toHaveLength(1);
    const httpTool = httpBlocks[0] as ToolCallBlock;
    const wsTool = wsBlocks[0] as ToolCallBlock;
    expect(httpTool.status).toBe("failed");
    expect(wsTool.status).toBe("failed");
    expect(httpTool.toolCallId).toBe("view-image-failed");
    expect(httpTool.toolName).toBe("View Image /tmp/example.png");
    expect(httpTool.resultSeq).toBe(event.seq);
    expect(httpTool.seq).toBe(event.seq);
    expect(httpTool.output).toBeUndefined();
  });
});

// AC: @ws-session-event-streaming ac-unified-event-parsing
describe("parseEventsToBlocks — legacy format", () => {
  it("still handles legacy format (data.update wrapper)", () => {
    const events = [
      {
        ts: 1000,
        seq: 0,
        type: "session.update" as const,
        session_id: "sess1",
        data: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "Bash",
            rawInput: { command: "git status" },
          },
        },
      },
    ];

    const blocks = parseEventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    const tc = blocks[0] as ToolCallBlock;
    expect(tc.toolName).toBe("Bash");
    expect(tc.input).toEqual({ command: "git status" });
  });
});
