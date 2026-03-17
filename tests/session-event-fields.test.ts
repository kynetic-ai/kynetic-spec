/**
 * Tests for shared session event field extraction
 *
 * AC: @ws-session-event-streaming ac-unified-event-parsing
 */

import { describe, it, expect } from "vitest";
import {
  unwrapSessionUpdate,
  extractToolCallFields,
  extractToolCallResult,
  extractToolName,
  isPopulatedInput,
} from "../src/agent-runtime/session-event-fields";

describe("session-event-fields", () => {
  // AC: @ws-session-event-streaming ac-unified-event-parsing
  describe("unwrapSessionUpdate", () => {
    it("returns data directly for ACP format (data.sessionUpdate exists)", () => {
      const data = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Bash",
        rawInput: { command: "ls" },
      };
      const result = unwrapSessionUpdate(data);
      expect(result).toBe(data);
    });

    it("unwraps data.update for legacy format", () => {
      const update = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Bash",
        rawInput: { command: "ls" },
      };
      const data = { update };
      const result = unwrapSessionUpdate(data);
      expect(result).toBe(update);
    });

    it("returns undefined for null data", () => {
      expect(unwrapSessionUpdate(null)).toBeUndefined();
    });

    it("returns undefined for undefined data", () => {
      expect(unwrapSessionUpdate(undefined)).toBeUndefined();
    });

    it("returns undefined for data with neither sessionUpdate nor update", () => {
      expect(unwrapSessionUpdate({ foo: "bar" })).toBeUndefined();
    });

    it("does not unwrap array update values", () => {
      expect(unwrapSessionUpdate({ update: [1, 2, 3] })).toBeUndefined();
    });
  });

  // AC: @ws-session-event-streaming ac-unified-event-parsing
  describe("extractToolCallFields", () => {
    it("extracts ACP format fields (toolCallId, title, rawInput)", () => {
      const update = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Bash",
        rawInput: { command: "git status" },
      };
      const result = extractToolCallFields(update);
      expect(result).toEqual({
        toolCallId: "tc-1",
        toolName: "Bash",
        rawInput: { command: "git status" },
      });
    });

    it("falls back to legacy field names (tool_call_id, tool, input)", () => {
      const update = {
        sessionUpdate: "tool_call",
        tool_call_id: "tc-2",
        tool: "Read",
        input: { file_path: "/tmp/foo" },
      };
      const result = extractToolCallFields(update);
      expect(result).toEqual({
        toolCallId: "tc-2",
        toolName: "Read",
        rawInput: { file_path: "/tmp/foo" },
      });
    });

    it("falls back to id for toolCallId", () => {
      const update = {
        sessionUpdate: "tool_call",
        id: "tc-3",
        name: "Write",
      };
      const result = extractToolCallFields(update);
      expect(result.toolCallId).toBe("tc-3");
      expect(result.toolName).toBe("Write");
    });

    it("defaults to empty string / unknown for missing fields", () => {
      const update = { sessionUpdate: "tool_call" };
      const result = extractToolCallFields(update);
      expect(result.toolCallId).toBe("");
      expect(result.toolName).toBe("unknown");
      expect(result.rawInput).toBeUndefined();
    });

    it("prefers primary fields over fallbacks", () => {
      const update = {
        toolCallId: "primary",
        tool_call_id: "fallback",
        title: "PrimaryTool",
        tool: "FallbackTool",
        rawInput: { primary: true },
        input: { fallback: true },
      };
      const result = extractToolCallFields(update);
      expect(result.toolCallId).toBe("primary");
      expect(result.toolName).toBe("PrimaryTool");
      expect(result.rawInput).toEqual({ primary: true });
    });
  });

  // AC: @ws-session-event-streaming ac-unified-event-parsing
  describe("extractToolCallResult", () => {
    it("extracts ACP format result fields", () => {
      const update = {
        toolCallId: "tc-1",
        status: "completed",
        rawOutput: "output data",
        rawInput: { command: "ls" },
      };
      const result = extractToolCallResult(update);
      expect(result.rawOutput).toBe("output data");
      expect(result.status).toBe("completed");
      expect(result.isError).toBe(false);
      expect(result.rawInput).toEqual({ command: "ls" });
    });

    it("falls back to legacy output fields", () => {
      const update = {
        output: "legacy output",
        error: true,
      };
      const result = extractToolCallResult(update);
      expect(result.rawOutput).toBe("legacy output");
      expect(result.isError).toBe(true);
    });

    it("detects isError from isError flag", () => {
      const update = { isError: true, content: "error content" };
      const result = extractToolCallResult(update);
      expect(result.isError).toBe(true);
      expect(result.rawOutput).toBe("error content");
    });

    it("returns undefined rawInput when not present", () => {
      const update = { status: "completed" };
      const result = extractToolCallResult(update);
      expect(result.rawInput).toBeUndefined();
    });
  });

  describe("extractToolName", () => {
    it("returns title as primary choice", () => {
      expect(extractToolName({ title: "Bash" })).toBe("Bash");
    });

    it("falls back to _meta.claudeCode.toolName", () => {
      const update = {
        _meta: {
          claudeCode: { toolName: "MetaTool" },
        },
      };
      expect(extractToolName(update)).toBe("MetaTool");
    });

    it("returns unknown when no tool name available", () => {
      expect(extractToolName({})).toBe("unknown");
    });

    it("prefers direct field over _meta", () => {
      const update = {
        title: "DirectTool",
        _meta: { claudeCode: { toolName: "MetaTool" } },
      };
      expect(extractToolName(update)).toBe("DirectTool");
    });
  });

  describe("isPopulatedInput", () => {
    it("returns true for non-empty objects", () => {
      expect(isPopulatedInput({ command: "ls" })).toBe(true);
    });

    it("returns false for empty objects", () => {
      expect(isPopulatedInput({})).toBe(false);
    });

    it("returns false for null", () => {
      expect(isPopulatedInput(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isPopulatedInput(undefined)).toBe(false);
    });

    it("returns false for arrays", () => {
      expect(isPopulatedInput([1, 2, 3])).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isPopulatedInput("string")).toBe(false);
      expect(isPopulatedInput(42)).toBe(false);
    });
  });
});
