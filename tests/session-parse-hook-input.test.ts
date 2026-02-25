/**
 * Tests for parseHookInput debug logging and validation.
 *
 * parseHookInput() parses Claude Code hook input from stdin.
 * Verifies: null/empty handling, valid JSON parsing, non-object rejection,
 * and debug logging for malformed input.
 *
 * Task: @task-add-debug-logging-hook-input
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseHookInput } from "../src/cli/commands/session/index.js";

describe("parseHookInput", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env.KSPEC_DEBUG;
  });

  // ─── Null/Empty Input ──────────────────────────────────────────────────────

  it("returns null for null input", () => {
    expect(parseHookInput(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseHookInput("")).toBeNull();
  });

  // ─── Valid JSON Parsing ────────────────────────────────────────────────────

  it("parses valid hook input with all fields", () => {
    const input = JSON.stringify({
      session_id: "abc-123",
      transcript_path: "/tmp/transcript.json",
      hook_event_name: "stop",
      stop_hook_active: true,
    });
    const result = parseHookInput(input);
    expect(result).toEqual({
      session_id: "abc-123",
      transcript_path: "/tmp/transcript.json",
      hook_event_name: "stop",
      stop_hook_active: true,
    });
  });

  it("parses valid hook input with partial fields", () => {
    const input = JSON.stringify({ stop_hook_active: false });
    const result = parseHookInput(input);
    expect(result).toEqual({ stop_hook_active: false });
  });

  it("parses empty object as valid input", () => {
    const result = parseHookInput("{}");
    expect(result).toEqual({});
  });

  it("trims whitespace before parsing", () => {
    const result = parseHookInput('  {"stop_hook_active": true}  \n');
    expect(result).toEqual({ stop_hook_active: true });
  });

  // ─── Malformed JSON ────────────────────────────────────────────────────────

  it("returns null for invalid JSON", () => {
    expect(parseHookInput("{not json}")).toBeNull();
  });

  it("returns null for truncated JSON", () => {
    expect(parseHookInput('{"session_id": "abc')).toBeNull();
  });

  // ─── Non-Object JSON ──────────────────────────────────────────────────────

  it("returns null for JSON array", () => {
    expect(parseHookInput("[1, 2, 3]")).toBeNull();
  });

  it("returns null for JSON string", () => {
    expect(parseHookInput('"just a string"')).toBeNull();
  });

  it("returns null for JSON number", () => {
    expect(parseHookInput("42")).toBeNull();
  });

  it("returns null for JSON null", () => {
    expect(parseHookInput("null")).toBeNull();
  });

  it("returns null for JSON boolean", () => {
    expect(parseHookInput("true")).toBeNull();
  });

  // ─── Debug Logging ────────────────────────────────────────────────────────

  it("logs debug message for invalid JSON when KSPEC_DEBUG=1", () => {
    process.env.KSPEC_DEBUG = "1";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    parseHookInput("{not json}");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("parseHookInput: failed to parse stdin as JSON:"),
      expect.anything(),
    );
    consoleSpy.mockRestore();
  });

  it("logs debug message for non-object JSON when KSPEC_DEBUG=1", () => {
    process.env.KSPEC_DEBUG = "1";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    parseHookInput("[1, 2]");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("parseHookInput: parsed value is not an object"),
    );
    consoleSpy.mockRestore();
  });

  it("does not log when KSPEC_DEBUG is not set", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    parseHookInput("{not json}");
    parseHookInput("[1, 2]");

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
