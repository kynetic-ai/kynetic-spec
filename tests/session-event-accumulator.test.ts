/**
 * Tests for SessionEventAccumulator
 *
 * AC: @session-event-broadcast ac-newline-streaming
 * AC: @session-event-broadcast ac-boundary-flush
 * AC: @session-event-broadcast ac-per-session-state
 * AC: @session-event-broadcast ac-tool-input-included
 * AC: @session-event-broadcast ac-replaces-text-chunks
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SessionEventAccumulator,
  type SessionContext,
} from "../src/agent-runtime/session-event-accumulator";
import type { SessionUpdate } from "../src/acp/index.js";
import type { SessionEventData } from "@kynetic-ai/shared";

function makeCtx(sessionId = "sess-1"): SessionContext {
  return {
    sessionId,
    agentId: "worker",
    taskId: "@task-1",
    taskTitle: "Test task",
  };
}

function makeTextUpdate(text: string): SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  } as unknown as SessionUpdate;
}

function makeThoughtUpdate(text: string): SessionUpdate {
  return {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  } as unknown as SessionUpdate;
}

function makeToolCallUpdate(id: string, title: string, rawInput?: unknown): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title,
    rawInput: rawInput ?? null,
  } as unknown as SessionUpdate;
}

function makeToolCallCompleteUpdate(id: string, status: string): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    status,
  } as unknown as SessionUpdate;
}

describe("SessionEventAccumulator", () => {
  let accumulator: SessionEventAccumulator;
  let events: SessionEventData[];
  let emit: (event: SessionEventData) => void;

  beforeEach(() => {
    accumulator = new SessionEventAccumulator();
    events = [];
    emit = (event) => events.push(event);
  });

  // AC: @session-event-broadcast ac-newline-streaming
  describe("newline-boundary streaming", () => {
    it("flushes complete lines at newline boundaries", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeTextUpdate("line 1\nline 2\npartial"), emit);

      // Should get: message_start, then message_progress with "line 1\nline 2\n"
      const types = events.map((e) => e.type);
      expect(types).toContain("message_start");
      expect(types).toContain("message_progress");

      const progress = events.find((e) => e.type === "message_progress") as any;
      expect(progress.text).toBe("line 1\nline 2\n");
    });

    it("holds partial lines in buffer until next newline", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeTextUpdate("partial"), emit);

      // Should only get message_start, no progress yet (no newline)
      const types = events.map((e) => e.type);
      expect(types).toEqual(["message_start"]);
    });

    it("flushes accumulated partial when newline arrives", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeTextUpdate("partial "), emit);
      events.length = 0; // Clear the message_start

      accumulator.handleUpdate(ctx, makeTextUpdate("text\n"), emit);

      const progress = events.find((e) => e.type === "message_progress") as any;
      expect(progress.text).toBe("partial text\n");
    });

    it("handles multiple flushes across chunks", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeTextUpdate("a\n"), emit);
      const firstProgress = events.filter((e) => e.type === "message_progress");
      expect(firstProgress).toHaveLength(1);
      expect((firstProgress[0] as any).text).toBe("a\n");

      events.length = 0;
      accumulator.handleUpdate(ctx, makeTextUpdate("b\n"), emit);
      const secondProgress = events.filter((e) => e.type === "message_progress");
      expect(secondProgress).toHaveLength(1);
      expect((secondProgress[0] as any).text).toBe("b\n");
    });

    it("force-flushes when buffer exceeds 8KB", () => {
      const ctx = makeCtx();

      // Send 8KB+ of text without a newline
      const bigText = "x".repeat(8192 + 100);
      accumulator.handleUpdate(ctx, makeTextUpdate(bigText), emit);

      const progress = events.filter((e) => e.type === "message_progress");
      expect(progress.length).toBeGreaterThanOrEqual(1);
      // All the text should have been flushed
      const totalText = progress.map((e) => (e as any).text).join("");
      expect(totalText).toBe(bigText);
    });
  });

  // AC: @session-event-broadcast ac-boundary-flush
  describe("state transition boundary flush", () => {
    it("flushes buffer as message_complete when transitioning to tool_call", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeTextUpdate("partial text"), emit);
      events.length = 0;

      accumulator.handleUpdate(ctx, makeToolCallUpdate("t1", "Bash", { command: "ls" }), emit);

      const complete = events.find((e) => e.type === "message_complete") as any;
      expect(complete).toBeDefined();
      expect(complete.text).toBe("partial text");
    });

    it("flushes buffer as thinking_complete when transitioning from thinking to message", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeThoughtUpdate("thinking..."), emit);
      events.length = 0;

      accumulator.handleUpdate(ctx, makeTextUpdate("response"), emit);

      const complete = events.find((e) => e.type === "thinking_complete") as any;
      expect(complete).toBeDefined();
      expect(complete.text).toBe("thinking...");
    });

    it("flushes buffer on session end", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeTextUpdate("final text"), emit);
      events.length = 0;

      accumulator.endSession(ctx, emit);

      const complete = events.find((e) => e.type === "message_complete") as any;
      expect(complete).toBeDefined();
      expect(complete.text).toBe("final text");
    });

    it("emits empty message_complete when buffer is empty on transition", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeTextUpdate("line\n"), emit);
      events.length = 0;

      // Buffer should be empty after newline flush
      accumulator.handleUpdate(ctx, makeToolCallUpdate("t1", "Bash"), emit);

      const complete = events.find((e) => e.type === "message_complete") as any;
      expect(complete).toBeDefined();
      expect(complete.text).toBe("");
    });
  });

  // AC: @session-event-broadcast ac-per-session-state
  describe("per-session state isolation", () => {
    it("tracks sessions independently", () => {
      const ctx1 = makeCtx("sess-1");
      const ctx2 = makeCtx("sess-2");

      accumulator.handleUpdate(ctx1, makeTextUpdate("session 1\n"), emit);
      accumulator.handleUpdate(ctx2, makeTextUpdate("session 2\n"), emit);

      const progress = events.filter((e) => e.type === "message_progress");
      expect(progress).toHaveLength(2);

      const sess1Progress = progress.find((e) => e.session_id === "sess-1") as any;
      const sess2Progress = progress.find((e) => e.session_id === "sess-2") as any;
      expect(sess1Progress.text).toBe("session 1\n");
      expect(sess2Progress.text).toBe("session 2\n");
    });

    it("ending one session does not affect another", () => {
      const ctx1 = makeCtx("sess-1");
      const ctx2 = makeCtx("sess-2");

      accumulator.handleUpdate(ctx1, makeTextUpdate("partial-1"), emit);
      accumulator.handleUpdate(ctx2, makeTextUpdate("partial-2"), emit);

      accumulator.endSession(ctx1, emit);

      expect(accumulator.hasSession("sess-1")).toBe(false);
      expect(accumulator.hasSession("sess-2")).toBe(true);
    });

    it("includes session_id in all emitted events", () => {
      const ctx = makeCtx("my-session");

      accumulator.handleUpdate(ctx, makeTextUpdate("hello\n"), emit);

      for (const event of events) {
        expect(event.session_id).toBe("my-session");
      }
    });

    it("tracks session count correctly", () => {
      expect(accumulator.sessionCount).toBe(0);

      accumulator.handleUpdate(makeCtx("s1"), makeTextUpdate("a"), emit);
      expect(accumulator.sessionCount).toBe(1);

      accumulator.handleUpdate(makeCtx("s2"), makeTextUpdate("b"), emit);
      expect(accumulator.sessionCount).toBe(2);

      accumulator.endSession(makeCtx("s1"), emit);
      expect(accumulator.sessionCount).toBe(1);
    });
  });

  // AC: @session-event-broadcast ac-tool-input-included
  describe("tool call events", () => {
    it("includes tool name and input in tool_call_start", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(
        ctx,
        makeToolCallUpdate("tc-1", "Bash", { command: "git status" }),
        emit,
      );

      const start = events.find((e) => e.type === "tool_call_start") as any;
      expect(start).toBeDefined();
      expect(start.tool_call_id).toBe("tc-1");
      expect(start.tool_name).toBe("Bash");
      expect(start.tool_input).toEqual({ command: "git status" });
    });

    it("excludes tool output from tool_call_complete", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(
        ctx,
        makeToolCallUpdate("tc-1", "Bash"),
        emit,
      );
      events.length = 0;

      accumulator.handleUpdate(
        ctx,
        makeToolCallCompleteUpdate("tc-1", "completed"),
        emit,
      );

      const complete = events.find((e) => e.type === "tool_call_complete") as any;
      expect(complete).toBeDefined();
      expect(complete.tool_call_id).toBe("tc-1");
      expect(complete.status).toBe("completed");
      expect(complete.duration_ms).toBeGreaterThanOrEqual(0);
      expect(complete).not.toHaveProperty("output");
    });

    it("includes tool name in tool_call_complete", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(
        ctx,
        makeToolCallUpdate("tc-1", "Read"),
        emit,
      );
      events.length = 0;

      accumulator.handleUpdate(
        ctx,
        makeToolCallCompleteUpdate("tc-1", "completed"),
        emit,
      );

      const complete = events.find((e) => e.type === "tool_call_complete") as any;
      expect(complete.tool_name).toBe("Read");
    });

    it("handles failed tool calls", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeToolCallUpdate("tc-1", "Write"), emit);
      events.length = 0;

      accumulator.handleUpdate(ctx, makeToolCallCompleteUpdate("tc-1", "failed"), emit);

      const complete = events.find((e) => e.type === "tool_call_complete") as any;
      expect(complete.status).toBe("failed");
    });
  });

  // AC: @ws-session-event-streaming ac-tool-input-update
  describe("phased tool call input", () => {
    function makeToolCallInputUpdate(id: string, rawInput: unknown): SessionUpdate {
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        rawInput,
      } as unknown as SessionUpdate;
    }

    it("emits tool_call_input when populated rawInput arrives without status transition", () => {
      const ctx = makeCtx();

      // Phase 1: registration with empty input
      accumulator.handleUpdate(
        ctx,
        makeToolCallUpdate("tc-1", "Bash", {}),
        emit,
      );
      events.length = 0;

      // Phase 2: input update with populated rawInput
      accumulator.handleUpdate(
        ctx,
        makeToolCallInputUpdate("tc-1", { command: "git status" }),
        emit,
      );

      const inputEvent = events.find((e) => e.type === "tool_call_input") as any;
      expect(inputEvent).toBeDefined();
      expect(inputEvent.tool_call_id).toBe("tc-1");
      expect(inputEvent.tool_name).toBe("Bash");
      expect(inputEvent.tool_input).toEqual({ command: "git status" });
    });

    it("does not emit tool_call_input for empty rawInput", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeToolCallUpdate("tc-1", "Bash"), emit);
      events.length = 0;

      accumulator.handleUpdate(
        ctx,
        makeToolCallInputUpdate("tc-1", {}),
        emit,
      );

      expect(events.filter((e) => e.type === "tool_call_input")).toHaveLength(0);
    });

    it("does not emit tool_call_input when status transitions to completed", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeToolCallUpdate("tc-1", "Bash"), emit);
      events.length = 0;

      // Update with both rawInput and completed status — should only emit tool_call_complete
      accumulator.handleUpdate(ctx, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        rawInput: { command: "git status" },
        status: "completed",
      } as unknown as SessionUpdate, emit);

      const types = events.map((e) => e.type);
      expect(types).not.toContain("tool_call_input");
      expect(types).toContain("tool_call_complete");
    });

    it("emits correct event sequence for phased tool call", () => {
      const ctx = makeCtx();

      // Phase 1: registration
      accumulator.handleUpdate(
        ctx,
        makeToolCallUpdate("tc-1", "Read", null),
        emit,
      );

      // Phase 2: input
      accumulator.handleUpdate(
        ctx,
        makeToolCallInputUpdate("tc-1", { file_path: "/tmp/test.ts" }),
        emit,
      );

      // Phase 3: completion
      accumulator.handleUpdate(
        ctx,
        makeToolCallCompleteUpdate("tc-1", "completed"),
        emit,
      );

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "tool_call_start",
        "tool_call_input",
        "tool_call_complete",
      ]);
    });
  });

  // AC: @session-event-broadcast ac-replaces-text-chunks
  describe("lifecycle event sequence", () => {
    it("produces correct event sequence for message → tool → message", () => {
      const ctx = makeCtx();

      // Message text
      accumulator.handleUpdate(ctx, makeTextUpdate("Hello world\n"), emit);
      // Tool call
      accumulator.handleUpdate(ctx, makeToolCallUpdate("t1", "Bash", { cmd: "ls" }), emit);
      accumulator.handleUpdate(ctx, makeToolCallCompleteUpdate("t1", "completed"), emit);
      // More message text
      accumulator.handleUpdate(ctx, makeTextUpdate("Done\n"), emit);
      // End session
      accumulator.endSession(ctx, emit);

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "message_start",
        "message_progress",    // "Hello world\n"
        "message_complete",    // transition to idle (empty buffer)
        "tool_call_start",
        "tool_call_complete",
        "message_start",       // re-enter message mode
        "message_progress",    // "Done\n"
        "message_complete",    // session end flush (empty buffer)
      ]);
    });

    it("produces correct event sequence for thinking → message", () => {
      const ctx = makeCtx();

      accumulator.handleUpdate(ctx, makeThoughtUpdate("reasoning\n"), emit);
      accumulator.handleUpdate(ctx, makeTextUpdate("answer\n"), emit);
      accumulator.endSession(ctx, emit);

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        "thinking_start",
        "thinking_progress",
        "thinking_complete",   // transition flush
        "message_start",
        "message_progress",
        "message_complete",    // session end
      ]);
    });
  });
});
