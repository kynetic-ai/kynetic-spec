/**
 * Unit tests for Active Fleet output buffering.
 *
 * AC: @ui-task-board ac-4 — Active Fleet row shows buffered output
 */

import { describe, it, expect } from "vitest";
import {
  createSessionState,
  processTextChunk,
  getDisplayState,
} from "../../packages/web-ui/src/lib/components/board/fleet-buffer";

describe("createSessionState", () => {
  // AC: @ui-task-board ac-4
  it("creates empty initial state", () => {
    const state = createSessionState();
    expect(state.buffer).toBe("");
    expect(state.lines).toEqual([]);
  });
});

describe("processTextChunk", () => {
  // AC: @ui-task-board ac-4
  it("buffers partial text without newlines", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "partial text");
    expect(result.lines).toEqual([]);
    expect(result.buffer).toBe("partial text");
  });

  // AC: @ui-task-board ac-4
  it("emits complete lines when newline arrives", () => {
    const state = createSessionState();
    const s1 = processTextChunk(state, "hello world\n");
    expect(s1.lines).toEqual(["hello world"]);
    expect(s1.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("accumulates partial chunks into complete lines", () => {
    let state = createSessionState();
    state = processTextChunk(state, "hel");
    expect(state.lines).toEqual([]);
    expect(state.buffer).toBe("hel");

    state = processTextChunk(state, "lo world\n");
    expect(state.lines).toEqual(["hello world"]);
    expect(state.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("handles multiple lines in a single chunk", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "line one\nline two\nline three\n");
    expect(result.lines).toEqual(["line one", "line two", "line three"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("keeps trailing partial text in buffer", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "complete line\npartial");
    expect(result.lines).toEqual(["complete line"]);
    expect(result.buffer).toBe("partial");
  });

  // AC: @ui-task-board ac-4
  it("limits output to last 3 lines", () => {
    let state = createSessionState();
    state = processTextChunk(state, "line 1\nline 2\nline 3\nline 4\nline 5\n");
    expect(state.lines).toEqual(["line 3", "line 4", "line 5"]);
  });

  // AC: @ui-task-board ac-4
  it("accumulates across multiple processTextChunk calls", () => {
    let state = createSessionState();
    state = processTextChunk(state, "first\n");
    state = processTextChunk(state, "second\n");
    state = processTextChunk(state, "third\n");
    expect(state.lines).toEqual(["first", "second", "third"]);

    state = processTextChunk(state, "fourth\n");
    expect(state.lines).toEqual(["second", "third", "fourth"]);
  });

  // AC: @ui-task-board ac-4
  it("skips empty lines", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "hello\n\n\nworld\n");
    expect(result.lines).toEqual(["hello", "world"]);
  });

  // AC: @ui-task-board ac-4
  it("trims whitespace from lines", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "  hello  \n  world  \n");
    expect(result.lines).toEqual(["hello", "world"]);
  });

  // AC: @ui-task-board ac-4
  it("handles raw token fragments like the bug described", () => {
    // Simulates the original bug: "driven\nform\n." arriving as token chunks
    let state = createSessionState();
    state = processTextChunk(state, "driven");
    expect(state.lines).toEqual([]);
    expect(state.buffer).toBe("driven");

    state = processTextChunk(state, "\nform");
    expect(state.lines).toEqual(["driven"]);
    expect(state.buffer).toBe("form");

    state = processTextChunk(state, "\n.");
    expect(state.lines).toEqual(["driven", "form"]);
    expect(state.buffer).toBe(".");
  });

  // AC: @ui-task-board ac-4
  it("strips terminal ANSI escape sequences from displayed lines", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "\u001b[31merror:\u001b[0m failed\n");
    expect(result.lines).toEqual(["error: failed"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("waits to sanitize split ANSI sequences until a complete line arrives", () => {
    let state = createSessionState();
    state = processTextChunk(state, "\u001b[3");
    expect(state.lines).toEqual([]);
    expect(state.buffer).toBe("\u001b[3");

    state = processTextChunk(state, "1merror\u001b[0m\n");
    expect(state.lines).toEqual(["error"]);
    expect(state.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("strips non-color CSI terminal control sequences from displayed lines", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "\u001b[2K\u001b[1Gstatus: ready\n");
    expect(result.lines).toEqual(["status: ready"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("treats bare carriage returns as terminal progress-line rewrites", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "Checking 10%\rChecking 95%\rerror: failed\n");
    expect(result.lines).toEqual(["error: failed"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("normalizes CRLF newlines without dropping lines", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "one\r\ntwo\r\n");
    expect(result.lines).toEqual(["one", "two"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("applies terminal backspace controls before display", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "erroo\br\n");
    expect(result.lines).toEqual(["error"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("strips ANSI sequences before applying backspace controls", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "safe\u001b[31m\bX\u001b[0m\n");
    expect(result.lines).toEqual(["safX"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("strips OSC terminal hyperlink sequences terminated by BEL", () => {
    const state = createSessionState();
    const result = processTextChunk(
      state,
      "\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\n",
    );
    expect(result.lines).toEqual(["link"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("strips OSC sequences terminated by ST (ESC backslash)", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "\u001b]0;window title\u001b\\hello\n");
    expect(result.lines).toEqual(["hello"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("strips OSC sequences terminated by single-byte ST (0x9C)", () => {
    const state = createSessionState();
    const result = processTextChunk(state, "\u001b]0;title\u009cready\n");
    expect(result.lines).toEqual(["ready"]);
    expect(result.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("waits to sanitize split OSC sequences until a complete line arrives", () => {
    let state = createSessionState();
    state = processTextChunk(state, "\u001b]8;;https://exa");
    expect(state.lines).toEqual([]);
    expect(state.buffer).toBe("\u001b]8;;https://exa");

    state = processTextChunk(state, "mple.com\u0007link\u001b]8;;\u0007\n");
    expect(state.lines).toEqual(["link"]);
    expect(state.buffer).toBe("");
  });

  // AC: @ui-task-board ac-4
  it("does not leave OSC payload text behind when payload contains URL punctuation", () => {
    // Regression for review cycle 3 blocker: arbitrary OSC payloads (URLs with
    // colons, slashes, dots, query strings) previously bled through the sanitizer
    // and produced mangled output like "ttps://example.comlink".
    const state = createSessionState();
    const result = processTextChunk(
      state,
      "\u001b]8;;https://example.com/path?q=1&r=2\u0007label\u001b]8;;\u0007\n",
    );
    expect(result.lines).toEqual(["label"]);
    expect(result.buffer).toBe("");
  });
});

describe("getDisplayState", () => {
  // AC: @ui-task-board ac-4
  it("returns lines for display", () => {
    let state = createSessionState();
    state = processTextChunk(state, "hello\nworld\n");
    const display = getDisplayState(state);
    expect(display.lines).toEqual(["hello", "world"]);
  });
});

describe("full lifecycle simulation", () => {
  // AC: @ui-task-board ac-4
  it("simulates realistic agent output stream", () => {
    let state = createSessionState();

    // Agent starts writing text
    state = processTextChunk(state, "I'll start by reading the ");
    expect(state.lines).toEqual([]);

    state = processTextChunk(state, "spec file.\n");
    expect(state.lines).toEqual(["I'll start by reading the spec file."]);

    // More text output
    state = processTextChunk(state, "Now implementing the fix.\n");
    expect(state.lines).toEqual([
      "I'll start by reading the spec file.",
      "Now implementing the fix.",
    ]);

    // Text arrives during continued work
    state = processTextChunk(state, "Updated the login handler.\n");
    expect(state.lines).toHaveLength(3);
  });
});
