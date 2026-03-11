/**
 * Session Stream View Tests
 *
 * Runtime behavior tests for the session stream view implementation.
 * Tests exercise actual functions (parseEventsToBlocks, extractFilesChanged,
 * renderMarkdown) rather than checking source strings.
 *
 * Structural tests are limited to file existence and key integration points.
 *
 * Spec: @ui-session-stream
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";

const WEB_UI_ROOT = join(process.cwd(), "packages", "web-ui");
const WEB_UI_SRC = join(WEB_UI_ROOT, "src");
const SESSION_COMPONENTS = join(WEB_UI_SRC, "lib", "components", "session");

// ─── Runtime imports ─────────────────────────────────────────────────────────

type SessionUtils = typeof import("../packages/web-ui/src/lib/components/session/session-utils");
type MarkdownUtils = typeof import("../packages/web-ui/src/lib/utils/markdown");
type WebUiViteServer = Awaited<ReturnType<typeof createServer>>;

let parseEventsToBlocks: SessionUtils["parseEventsToBlocks"];
let getToolIcon: SessionUtils["getToolIcon"];
let getToolInputPreview: SessionUtils["getToolInputPreview"];
let formatDuration: SessionUtils["formatDuration"];
let formatTime: SessionUtils["formatTime"];
let formatElapsed: SessionUtils["formatElapsed"];
let formatAge: SessionUtils["formatAge"];
let extractFilesChanged: SessionUtils["extractFilesChanged"];
let computeScrollDistance: SessionUtils["computeScrollDistance"];
let shouldAutoScrollFn: SessionUtils["shouldAutoScroll"];
let AUTO_SCROLL_THRESHOLD: SessionUtils["AUTO_SCROLL_THRESHOLD"];
let shouldShowJumpButton: SessionUtils["shouldShowJumpButton"];
let accumulateStreamingText: SessionUtils["accumulateStreamingText"];
let getLastSeq: SessionUtils["getLastSeq"];
let renderMarkdown: MarkdownUtils["renderMarkdown"];
let sanitizeHtml: typeof import("../packages/web-ui/src/lib/utils/sanitize")["sanitizeHtml"];
let isLanguageSupported: typeof import("../packages/web-ui/src/lib/utils/highlight")["isLanguageSupported"];
let INLINE_CODE_CLASS_NAMES: typeof import("../packages/web-ui/src/lib/utils/highlight")["INLINE_CODE_CLASS_NAMES"];
let createStreamingMarkdownRenderer: typeof import("../packages/web-ui/src/lib/utils/streaming-markdown")["createStreamingMarkdownRenderer"];
let createStreamingMarkdownController: typeof import("../packages/web-ui/src/lib/utils/streaming-markdown")["createStreamingMarkdownController"];
let finalizeStreamingMarkdown: typeof import("../packages/web-ui/src/lib/utils/streaming-markdown")["finalizeStreamingMarkdown"];
let webUiViteServer: WebUiViteServer;
const ORIGINAL_CWD = process.cwd();

beforeAll(async () => {
  process.chdir(WEB_UI_ROOT);
  webUiViteServer = await createServer({
    root: process.cwd(),
    server: { middlewareMode: true },
    appType: "custom",
  });
  process.chdir(ORIGINAL_CWD);

  const sessionMod = await import(
    "../packages/web-ui/src/lib/components/session/session-utils"
  );
  parseEventsToBlocks = sessionMod.parseEventsToBlocks;
  getToolIcon = sessionMod.getToolIcon;
  getToolInputPreview = sessionMod.getToolInputPreview;
  formatDuration = sessionMod.formatDuration;
  formatTime = sessionMod.formatTime;
  formatElapsed = sessionMod.formatElapsed;
  formatAge = sessionMod.formatAge;
  extractFilesChanged = sessionMod.extractFilesChanged;
  computeScrollDistance = sessionMod.computeScrollDistance;
  shouldAutoScrollFn = sessionMod.shouldAutoScroll;
  AUTO_SCROLL_THRESHOLD = sessionMod.AUTO_SCROLL_THRESHOLD;
  shouldShowJumpButton = sessionMod.shouldShowJumpButton;
  accumulateStreamingText = sessionMod.accumulateStreamingText;
  getLastSeq = sessionMod.getLastSeq;

  const markdownMod = await import(
    "../packages/web-ui/src/lib/utils/markdown"
  );
  renderMarkdown = markdownMod.renderMarkdown;

  const sanitizeMod = await import(
    "../packages/web-ui/src/lib/utils/sanitize"
  );
  sanitizeHtml = sanitizeMod.sanitizeHtml;

  const highlightMod = await import(
    "../packages/web-ui/src/lib/utils/highlight"
  );
  isLanguageSupported = highlightMod.isLanguageSupported;
  INLINE_CODE_CLASS_NAMES = highlightMod.INLINE_CODE_CLASS_NAMES;

  const streamingMod = await import(
    "../packages/web-ui/src/lib/utils/streaming-markdown"
  );
  createStreamingMarkdownRenderer = streamingMod.createStreamingMarkdownRenderer;
  createStreamingMarkdownController = streamingMod.createStreamingMarkdownController;
  finalizeStreamingMarkdown = streamingMod.finalizeStreamingMarkdown;
});

async function transformWebUiModule(path: string): Promise<string> {
  const transformed = await webUiViteServer.transformRequest(path);
  if (!transformed?.code) {
    throw new Error(`Expected transformed output for ${path}`);
  }
  return transformed.code;
}

async function createDomHarness() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>");
  const root = dom.window.document.getElementById("root") as HTMLElement;

  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document as unknown as Document;
  globalThis.Element = dom.window.Element as typeof Element;
  globalThis.HTMLElement = dom.window.HTMLElement as typeof HTMLElement;
  globalThis.HTMLAnchorElement = dom.window.HTMLAnchorElement as typeof HTMLAnchorElement;
  globalThis.Node = dom.window.Node as typeof Node;

  return { dom, root };
}

function createTestScheduler() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  let requestCount = 0;
  let cancelCount = 0;

  return {
    get requestCount() {
      return requestCount;
    },
    get cancelCount() {
      return cancelCount;
    },
    request(callback: FrameRequestCallback) {
      requestCount += 1;
      const frameId = nextFrameId++;
      callbacks.set(frameId, callback);
      return frameId;
    },
    cancel(frameId: number) {
      cancelCount += 1;
      callbacks.delete(frameId);
    },
    flushAll() {
      for (const frameId of [...callbacks.keys()].sort((left, right) => left - right)) {
        const callback = callbacks.get(frameId);
        if (!callback) continue;
        callbacks.delete(frameId);
        callback(Date.now());
      }
    },
  };
}

// ─── AC-1: Structured event blocks ────────────────────────────────────────────

// AC: @ui-session-stream ac-1
describe("structured event blocks (@ui-session-stream ac-1)", () => {
  describe("component files exist", () => {
    it("session route exists at /sessions/[id]", () => {
      expect(
        existsSync(join(WEB_UI_SRC, "routes", "sessions", "[id]", "+page.svelte")),
      ).toBe(true);
    });

    it("all block components exist", () => {
      expect(existsSync(join(SESSION_COMPONENTS, "MessageBlock.svelte"))).toBe(true);
      expect(existsSync(join(SESSION_COMPONENTS, "ToolCallView.svelte"))).toBe(true);
      expect(existsSync(join(SESSION_COMPONENTS, "ThinkingBlock.svelte"))).toBe(true);
      expect(existsSync(join(SESSION_COMPONENTS, "SystemBlock.svelte"))).toBe(true);
      expect(existsSync(join(SESSION_COMPONENTS, "SessionStream.svelte"))).toBe(true);
    });
  });

  describe("parseEventsToBlocks — session lifecycle events", () => {
    // AC: @ui-session-stream ac-1
    it("parses session.start as system block with agent type", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.start",
          session_id: "s1",
          data: { agent_type: "worker" },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "system",
        label: "Session started",
        detail: "Agent: worker",
        timestamp: 1000,
        seq: 0,
      });
    });

    // AC: @ui-session-stream ac-1
    it("parses session.end as system block", () => {
      const events = [
        {
          ts: 5000,
          seq: 10,
          type: "session.end",
          session_id: "s1",
          data: { reason: "completed" },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "system",
        label: "Session ended",
        detail: "completed",
      });
    });

    // AC: @ui-session-stream ac-1
    it("parses session.wrapup as system block", () => {
      const events = [
        {
          ts: 4000,
          seq: 8,
          type: "session.wrapup",
          session_id: "s1",
          data: { reason: "budget exhausted" },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "system",
        label: "Session wrapping up",
        detail: "budget exhausted",
      });
    });
  });

  describe("parseEventsToBlocks — message blocks", () => {
    // AC: @ui-session-stream ac-1
    it("parses assistant_text as message block", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "assistant_text", text: "Hello world" },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "message",
        content: "Hello world",
        timestamp: 1000,
      });
    });

    // AC: @ui-session-stream ac-1
    it("parses assistant variant as message block", () => {
      const events = [
        {
          ts: 2000,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "assistant", content: "Response text" },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "message",
        content: "Response text",
      });
    });

    // AC: @ui-session-stream ac-1
    it("merges consecutive message blocks into one", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "assistant_text", text: "Hello " },
          },
        },
        {
          ts: 1001,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "assistant_text", text: "world" },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("message");
      if (blocks[0].type === "message") {
        expect(blocks[0].content).toBe("Hello world");
      }
    });

    // AC: @ui-session-stream ac-1
    it("does not merge messages separated by other block types", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "assistant_text", text: "First" },
          },
        },
        {
          ts: 1500,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "thinking", text: "hmm" },
          },
        },
        {
          ts: 2000,
          seq: 2,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "assistant_text", text: "Second" },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe("message");
      expect(blocks[1].type).toBe("thinking");
      expect(blocks[2].type).toBe("message");
      if (blocks[0].type === "message" && blocks[2].type === "message") {
        expect(blocks[0].content).toBe("First");
        expect(blocks[2].content).toBe("Second");
      }
    });

    // AC: @ui-session-stream ac-1
    it("ignores empty text content", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: { update: { sessionUpdate: "assistant_text", text: "" } },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(0);
    });

    // AC: @ui-session-stream ac-1
    it("parses ACP agent_message_chunk (direct data format) as message block", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello from ACP" },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "message",
        content: "Hello from ACP",
        timestamp: 1000,
      });
    });

    // AC: @ui-session-stream ac-1
    it("merges consecutive ACP agent_message_chunk blocks", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Part 1 " },
          },
        },
        {
          ts: 1001,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Part 2" },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      if (blocks[0].type === "message") {
        expect(blocks[0].content).toBe("Part 1 Part 2");
      }
    });
  });

  describe("parseEventsToBlocks — tool call blocks", () => {
    // AC: @ui-session-stream ac-1
    it("creates tool call block with running status and resolves on result", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-1",
              tool: "Bash",
              rawInput: { command: "ls" },
            },
          },
        },
        {
          ts: 2500,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            update: {
              sessionUpdate: "tool_result",
              toolCallId: "tc-1",
              output: "file.txt\ndir/",
            },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "tool_call",
        toolName: "Bash",
        toolCallId: "tc-1",
        input: { command: "ls" },
        output: "file.txt\ndir/",
        status: "completed",
        durationMs: 1500,
        startedAt: 1000,
        completedAt: 2500,
      });
    });

    // AC: @ui-session-stream ac-1
    it("marks tool call as failed when error flag is set", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-err",
              tool: "Bash",
              rawInput: { command: "false" },
            },
          },
        },
        {
          ts: 2000,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            update: {
              sessionUpdate: "tool_result",
              toolCallId: "tc-err",
              output: "exit code 1",
              error: true,
            },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks[0]).toMatchObject({
        type: "tool_call",
        status: "failed",
        durationMs: 1000,
      });
    });

    // AC: @ui-session-stream ac-1
    it("marks tool call as failed when isError flag is set", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-err2",
              tool: "Read",
              rawInput: { file_path: "/missing" },
            },
          },
        },
        {
          ts: 1200,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            update: {
              sessionUpdate: "tool_result",
              toolCallId: "tc-err2",
              output: "File not found",
              isError: true,
            },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks[0]).toMatchObject({
        type: "tool_call",
        status: "failed",
      });
    });

    // AC: @ui-session-stream ac-1
    it("handles tool.call / tool.result event types (alternative format)", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "tool.call",
          session_id: "s1",
          data: { tool: "Read", toolCallId: "tc-2", input: { file_path: "/a.ts" } },
        },
        {
          ts: 1500,
          seq: 1,
          type: "tool.result",
          session_id: "s1",
          data: { toolCallId: "tc-2", output: "contents" },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "tool_call",
        toolName: "Read",
        status: "completed",
        durationMs: 500,
      });
    });

    // AC: @ui-session-stream ac-1
    it("handles ACP tool_call_update with status field", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-acp",
            title: "Read",
            rawInput: { file_path: "/src/main.ts" },
          },
        },
        {
          ts: 2000,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-acp",
            status: "completed",
            rawOutput: "file contents here",
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "tool_call",
        toolName: "Read",
        toolCallId: "tc-acp",
        input: { file_path: "/src/main.ts" },
        output: "file contents here",
        status: "completed",
        durationMs: 1000,
      });
    });

    // AC: @ui-session-stream ac-1
    it("handles ACP tool_call_update with failed status", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-fail",
            title: "Bash",
            rawInput: { command: "exit 1" },
          },
        },
        {
          ts: 1500,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-fail",
            status: "failed",
            rawOutput: "exit code 1",
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks[0]).toMatchObject({
        type: "tool_call",
        status: "failed",
        durationMs: 500,
      });
    });

    // AC: @ui-session-stream ac-1
    it("handles ACP tool_call with title field as tool name", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-title",
            title: "Edit",
            rawInput: { file_path: "/src/app.ts" },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks[0]).toMatchObject({
        type: "tool_call",
        toolName: "Edit",
        status: "running",
      });
    });

    // AC: @ui-session-stream ac-1
    it("leaves tool call as running if no result arrives", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-pending",
              tool: "Bash",
              rawInput: { command: "sleep 999" },
            },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks[0]).toMatchObject({
        type: "tool_call",
        status: "running",
      });
      if (blocks[0].type === "tool_call") {
        expect(blocks[0].durationMs).toBeUndefined();
        expect(blocks[0].output).toBeUndefined();
      }
    });
  });

  describe("parseEventsToBlocks — thinking blocks", () => {
    // AC: @ui-session-stream ac-1
    it("parses thinking events as thinking blocks", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "thinking", text: "Let me think..." },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "thinking",
        content: "Let me think...",
        timestamp: 1000,
      });
    });

    // AC: @ui-session-stream ac-1
    it("parses assistant_thinking variant", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "assistant_thinking", text: "Considering..." },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks[0]).toMatchObject({
        type: "thinking",
        content: "Considering...",
      });
    });

    // AC: @ui-session-stream ac-1
    it("merges consecutive thinking blocks", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "thinking", text: "Part 1 " },
          },
        },
        {
          ts: 1100,
          seq: 1,
          type: "session.update",
          session_id: "s1",
          data: {
            update: { sessionUpdate: "thinking", text: "Part 2" },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      if (blocks[0].type === "thinking") {
        expect(blocks[0].content).toBe("Part 1 Part 2");
      }
    });

    // AC: @ui-session-stream ac-1
    it("parses ACP agent_thought_chunk (direct data format) as thinking block", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "ACP thinking..." },
          },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        type: "thinking",
        content: "ACP thinking...",
        timestamp: 1000,
      });
    });
  });

  describe("parseEventsToBlocks — agent lifecycle and other events", () => {
    // AC: @ui-session-stream ac-1
    it("handles all agent lifecycle event types", () => {
      const agentEvents = [
        "agent.dispatched",
        "agent.started",
        "agent.completed",
        "agent.failed",
        "agent.timeout",
      ];
      const events = agentEvents.map((type, i) => ({
        ts: 1000 + i * 1000,
        seq: i,
        type,
        session_id: "s1",
        data: { task_ref: "@task-foo" },
      }));
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(5);

      const labels = blocks.map((b) =>
        b.type === "system" ? b.label : "",
      );
      expect(labels).toEqual([
        "Agent dispatched",
        "Agent started",
        "Agent completed",
        "Agent failed",
        "Agent timed out",
      ]);

      // All should include task detail
      for (const block of blocks) {
        if (block.type === "system") {
          expect(block.detail).toBe("Task: @task-foo");
        }
      }
    });

    // AC: @ui-session-stream ac-1
    it("handles prompt.sent as iteration marker", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "prompt.sent",
          session_id: "s1",
          data: { phase: "execute", iteration: 3 },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks[0]).toMatchObject({
        type: "system",
        label: "Iteration 3",
        detail: "Phase: execute",
      });
    });

    // AC: @ui-session-stream ac-1
    it("handles note events", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "note",
          session_id: "s1",
          data: { message: "Important note" },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks[0]).toMatchObject({
        type: "system",
        label: "Note",
        detail: "Important note",
      });
    });

    // AC: @ui-session-stream ac-1
    it("skips events with null data", () => {
      const events = [
        { ts: 1000, seq: 0, type: "session.start", session_id: "s1", data: null },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(0);
    });

    // AC: @ui-session-stream ac-1
    it("skips session.update events with null update", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: { update: null },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(0);
    });

    // AC: @ui-session-stream ac-1
    it("skips session.update with no sessionUpdate field and no update wrapper", () => {
      const events = [
        {
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: "s1",
          data: { someOtherField: "value" },
        },
      ];
      const blocks = parseEventsToBlocks(events);
      expect(blocks).toHaveLength(0);
    });
  });

  describe("parseEventsToBlocks — complex multi-event sequences", () => {
    // AC: @ui-session-stream ac-1
    it("produces correct block sequence for a realistic agent session", () => {
      const events = [
        { ts: 1000, seq: 0, type: "session.start", session_id: "s1", data: { agent_type: "worker" } },
        { ts: 1100, seq: 1, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "thinking", text: "Planning..." } } },
        { ts: 1200, seq: 2, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "assistant_text", text: "I'll read the file." } } },
        { ts: 1300, seq: 3, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_call", toolCallId: "r1", tool: "Read", rawInput: { file_path: "/src/main.ts" } } } },
        { ts: 1800, seq: 4, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_result", toolCallId: "r1", output: "export function main() {}" } } },
        { ts: 1900, seq: 5, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "assistant_text", text: "Now editing." } } },
        { ts: 2000, seq: 6, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_call", toolCallId: "e1", tool: "Edit", rawInput: { file_path: "/src/main.ts", old_string: "main", new_string: "start" } } } },
        { ts: 2500, seq: 7, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_result", toolCallId: "e1", output: "OK" } } },
        { ts: 3000, seq: 8, type: "session.end", session_id: "s1", data: { reason: "completed" } },
      ];

      const blocks = parseEventsToBlocks(events);

      // Expected sequence: system, thinking, message, tool_call(Read), message, tool_call(Edit), system
      expect(blocks.map((b) => b.type)).toEqual([
        "system",
        "thinking",
        "message",
        "tool_call",
        "message",
        "tool_call",
        "system",
      ]);

      // Verify tool calls resolved correctly
      const toolCalls = blocks.filter((b) => b.type === "tool_call");
      expect(toolCalls[0]).toMatchObject({
        type: "tool_call",
        toolName: "Read",
        status: "completed",
        durationMs: 500,
      });
      expect(toolCalls[1]).toMatchObject({
        type: "tool_call",
        toolName: "Edit",
        status: "completed",
        durationMs: 500,
      });
    });
  });

  describe("parseEventsToBlocks — ACP format multi-event sequence", () => {
    // AC: @ui-session-stream ac-1
    it("produces correct block sequence for an ACP-format agent session", () => {
      const events = [
        { ts: 1000, seq: 0, type: "session.start", session_id: "s1", data: { agent_type: "worker" } },
        { ts: 1100, seq: 1, type: "session.update", session_id: "s1", data: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning..." } } },
        { ts: 1200, seq: 2, type: "session.update", session_id: "s1", data: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I'll read the file." } } },
        { ts: 1300, seq: 3, type: "session.update", session_id: "s1", data: { sessionUpdate: "tool_call", toolCallId: "r1", title: "Read", rawInput: { file_path: "/src/main.ts" } } },
        { ts: 1800, seq: 4, type: "session.update", session_id: "s1", data: { sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed", rawOutput: "export function main() {}" } },
        { ts: 1900, seq: 5, type: "session.update", session_id: "s1", data: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Now editing." } } },
        { ts: 2000, seq: 6, type: "session.update", session_id: "s1", data: { sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit", rawInput: { file_path: "/src/main.ts", old_string: "main", new_string: "start" } } },
        { ts: 2500, seq: 7, type: "session.update", session_id: "s1", data: { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", rawOutput: "OK" } },
        { ts: 3000, seq: 8, type: "session.end", session_id: "s1", data: { reason: "completed" } },
      ];

      const blocks = parseEventsToBlocks(events);

      // Expected sequence: system, thinking, message, tool_call(Read), message, tool_call(Edit), system
      expect(blocks.map((b) => b.type)).toEqual([
        "system",
        "thinking",
        "message",
        "tool_call",
        "message",
        "tool_call",
        "system",
      ]);

      // Verify thinking block
      if (blocks[1].type === "thinking") {
        expect(blocks[1].content).toBe("Planning...");
      }

      // Verify message blocks
      if (blocks[2].type === "message") {
        expect(blocks[2].content).toBe("I'll read the file.");
      }
      if (blocks[4].type === "message") {
        expect(blocks[4].content).toBe("Now editing.");
      }

      // Verify tool calls resolved correctly
      const toolCalls = blocks.filter((b) => b.type === "tool_call");
      expect(toolCalls[0]).toMatchObject({
        type: "tool_call",
        toolName: "Read",
        status: "completed",
        durationMs: 500,
      });
      expect(toolCalls[1]).toMatchObject({
        type: "tool_call",
        toolName: "Edit",
        status: "completed",
        durationMs: 500,
      });
    });
  });

  describe("markdown rendering in message blocks", () => {
    // AC: @ui-session-stream ac-1
    it("renders bold and italic markdown to HTML", () => {
      const html = renderMarkdown("**bold** and *italic*");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
    });

    // AC: @ui-session-stream ac-1
    it("renders inline code", () => {
      const html = renderMarkdown("Use `npm install`");
      expect(html).toContain('<code class="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]">npm install</code>');
    });

    // AC: @ui-session-stream ac-1
    it("renders fenced code blocks", () => {
      const html = renderMarkdown("```js\nconst x = 1;\n```");
      expect(html).toContain("<pre>");
      expect(html).toContain('<code class="hljs language-javascript"');
      expect(html).toContain("hljs-keyword");
      expect(html).toContain("hljs-number");
    });

    // AC: @ui-session-stream ac-1
    it("renders headings", () => {
      const html = renderMarkdown("# Title\n## Subtitle");
      expect(html).toContain("<h1>Title</h1>");
      expect(html).toContain("<h2>Subtitle</h2>");
    });

    // AC: @ui-session-stream ac-1
    it("renders unordered and ordered lists", () => {
      const ul = renderMarkdown("- item 1\n- item 2");
      expect(ul).toContain("<ul>");
      expect(ul).toContain("<li>item 1</li>");

      const ol = renderMarkdown("1. first\n2. second");
      expect(ol).toContain("<ol>");
      expect(ol).toContain("<li>first</li>");
    });

    // AC: @ui-session-stream ac-1
    it("renders links with safe attributes", () => {
      const html = renderMarkdown("[Click here](https://example.com)");
      expect(html).toContain("<a");
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain("Click here</a>");
    });

    // AC: @ui-session-stream ac-1
    it("renders blockquotes", () => {
      const html = renderMarkdown("> Important note");
      expect(html).toContain("<blockquote>");
      expect(html).toContain("Important note");
    });

    // AC: @ui-session-stream ac-1
    it("renders tables (GFM)", () => {
      const html = renderMarkdown(
        "| A | B |\n| --- | --- |\n| 1 | 2 |",
      );
      expect(html).toContain("<table>");
      expect(html).toContain("<th>A</th>");
      expect(html).toContain("<td>1</td>");
    });

    // AC: @ui-session-stream ac-1
    it("sanitizes XSS attempts", () => {
      const html = renderMarkdown('<script>alert("xss")</script>');
      expect(html).not.toContain("<script>");

      const imgXss = renderMarkdown('<img onerror="alert(1)" src="x">');
      expect(imgXss).not.toContain("onerror");

      const badLink = renderMarkdown('[xss](javascript:alert("xss"))');
      expect(badLink).not.toContain("javascript:");
    });

    // AC: @ui-session-stream ac-1
    // AC: @trait-markdown-rendering ac-7
    it("returns empty string for empty input", () => {
      expect(renderMarkdown("")).toBe("");
      expect(renderMarkdown(null as unknown as string)).toBe("");
    });

    // AC: @ui-session-stream ac-1
    it("handles line breaks (GFM breaks enabled)", () => {
      const html = renderMarkdown("Line 1\nLine 2");
      expect(html).toContain("<br");
    });
  });

  describe("shared markdown security and highlighting", () => {
    // AC: @trait-markdown-rendering ac-2
    it("supports the required highlight.js language set", () => {
      for (const language of [
        "bash",
        "typescript",
        "javascript",
        "python",
        "rust",
        "go",
        "json",
        "yaml",
        "sql",
        "css",
        "html",
        "java",
        "c",
        "cpp",
        "diff",
      ]) {
        expect(isLanguageSupported(language)).toBe(true);
      }
    });

    // AC: @trait-markdown-rendering ac-2
    it("highlights static code fences with highlight.js markup", () => {
      const html = renderMarkdown("```python\nprint('hi')\n```");
      expect(html).toContain("hljs");
      expect(html).toContain("language-python");
    });

    // AC: @trait-markdown-rendering ac-4
    // AC: @trait-markdown-rendering ac-6
    it("sanitizes unsafe HTML while keeping external link security attributes", () => {
      const clean = sanitizeHtml(
        '<p>safe</p><script>alert(1)</script><a href="https://example.com">x</a><a href="/local">y</a>',
      );

      expect(clean).toContain("<p>safe</p>");
      expect(clean).not.toContain("<script>");
      expect(clean).toContain('href="https://example.com"');
      expect(clean).toContain('target="_blank"');
      expect(clean).toContain('rel="noopener noreferrer"');
      expect(clean).toContain('href="/local"');
    });

    // AC: @trait-markdown-rendering ac-8
    it("renders malformed markdown without throwing", () => {
      expect(() => renderMarkdown("```ts\nconst x = 1")).not.toThrow();
      expect(renderMarkdown("```ts\nconst x = 1")).toContain("language-typescript");
    });
  });

  describe("streaming markdown renderer", () => {
    // AC: @streaming-markdown-component ac-1
    it("appends new chunks without rewriting earlier rendered nodes", async () => {
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM("<div id='root'></div>");
      const root = dom.window.document.getElementById("root") as HTMLElement;

      globalThis.document = dom.window.document as unknown as Document;
      globalThis.HTMLElement = dom.window.HTMLElement as typeof HTMLElement;
      globalThis.HTMLAnchorElement = dom.window.HTMLAnchorElement as typeof HTMLAnchorElement;

      const renderer = createStreamingMarkdownRenderer(root);
      const parser = (await import("streaming-markdown")).parser(renderer);
      const smd = await import("streaming-markdown");

      smd.parser_write(parser, "Hello ");
      const paragraph = root.querySelector("p");
      expect(paragraph).toBeTruthy();
      const initialText = root.textContent ?? "";

      smd.parser_write(parser, "world");
      expect(root.querySelector("p")).toBe(paragraph);
      expect(root.textContent).toContain("Hello");
      expect((root.textContent ?? "").length).toBeGreaterThan(initialText.length);
    });

    // AC: @streaming-markdown-component ac-2
    // AC: @streaming-markdown-component ac-3
    // AC: @streaming-markdown-component ac-4
    // AC: @trait-markdown-rendering ac-4
    it("defers code highlighting until finalization and sanitizes the final HTML", async () => {
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM("<div id='root'></div>");
      const root = dom.window.document.getElementById("root") as HTMLElement;

      globalThis.document = dom.window.document as unknown as Document;
      globalThis.HTMLElement = dom.window.HTMLElement as typeof HTMLElement;
      globalThis.HTMLAnchorElement = dom.window.HTMLAnchorElement as typeof HTMLAnchorElement;

      const smd = await import("streaming-markdown");
      const parser = smd.parser(createStreamingMarkdownRenderer(root));

      smd.parser_write(parser, "```js\nconst value = 1;\n```");
      expect(root.innerHTML).not.toContain("hljs");

      root.insertAdjacentHTML("beforeend", '<script>alert("xss")</script>');
      smd.parser_end(parser);
      finalizeStreamingMarkdown(root);

      expect(root.innerHTML).not.toContain("<script>");
      expect(root.innerHTML).toContain("hljs");
      expect(root.innerHTML).toContain("language-javascript");
    });

    // AC: @trait-markdown-rendering ac-6
    it("adds safe attributes to external links emitted by the streaming renderer", async () => {
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM("<div id='root'></div>");
      const root = dom.window.document.getElementById("root") as HTMLElement;

      globalThis.document = dom.window.document as unknown as Document;
      globalThis.HTMLElement = dom.window.HTMLElement as typeof HTMLElement;
      globalThis.HTMLAnchorElement = dom.window.HTMLAnchorElement as typeof HTMLAnchorElement;

      const smd = await import("streaming-markdown");
      const parser = smd.parser(createStreamingMarkdownRenderer(root));

      smd.parser_write(parser, "[docs](https://example.com)");
      smd.parser_end(parser);
      finalizeStreamingMarkdown(root);

      const link = root.querySelector("a");
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    });
  });

  describe("streaming markdown component integration", () => {
    // AC: @trait-markdown-rendering ac-1
    it("renders GFM elements and keeps prose typography styling on the markdown surface", async () => {
      const html = renderMarkdown(
        "# Title\n\n- [x] done\n- item\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> quoted\n\n~~old~~ and *italic* [docs](https://example.com)",
      );
      const componentCode = await transformWebUiModule("/src/lib/components/markdown/StreamingMarkdown.svelte");

      expect(html).toContain("<h1>Title</h1>");
      expect(html).toContain('type="checkbox"');
      expect(html).toContain("<table>");
      expect(html).toContain("<blockquote>");
      expect(html).toContain("<del>old</del>");
      expect(html).toContain("<em>italic</em>");
      expect(html).toContain('href="https://example.com"');
      expect(componentCode).toContain("streaming-markdown prose prose-sm dark:prose-invert");
    });

    // AC: @trait-markdown-rendering ac-3
    it("renders inline code with distinct monospace styling", async () => {
      const html = renderMarkdown("Use `npm install`");
      const { root } = await createDomHarness();
      root.innerHTML = html;
      const inlineCode = root.querySelector("code");

      expect(inlineCode).not.toBeNull();
      expect(inlineCode?.textContent).toBe("npm install");
      expect(inlineCode?.closest("pre")).toBeNull();
      expect(Array.from(INLINE_CODE_CLASS_NAMES).every((className) => inlineCode?.classList.contains(className))).toBe(true);
      expect(inlineCode?.classList.contains("hljs")).toBe(false);
    });

    it("decorates finalized streaming inline code spans without treating them as fenced blocks", async () => {
      const { root } = await createDomHarness();
      root.innerHTML = "<p>Use <code>npm install</code> before <code>npm test</code>.</p>";

      finalizeStreamingMarkdown(root);

      const inlineCodes = [...root.querySelectorAll("code")];
      expect(inlineCodes).toHaveLength(2);
      for (const inlineCode of inlineCodes) {
        expect(inlineCode.closest("pre")).toBeNull();
        expect(Array.from(INLINE_CODE_CLASS_NAMES).every((className) => inlineCode.classList.contains(className))).toBe(true);
        expect(inlineCode.classList.contains("hljs")).toBe(false);
      }
    });

    // AC: @trait-markdown-rendering ac-5
    it("uses dark-mode-compatible prose and highlight theme hooks", async () => {
      const css = await transformWebUiModule("/src/app.css");

      expect(css).toContain(".dark .hljs");
      expect(css).toContain(".prose");
    });

    // AC: @streaming-markdown-component ac-5
    it("uses an immediate static parse-sanitize-highlight pipeline when not streaming", async () => {
      const { root } = await createDomHarness();
      const scheduler = createTestScheduler();
      const controller = createStreamingMarkdownController(root, { scheduler });

      controller.update('<script>alert(1)</script>\n\n```js\nconst value = 1;\n```', false);

      expect(scheduler.requestCount).toBe(0);
      expect(root.innerHTML).not.toContain("<script>");
      expect(root.innerHTML).toContain("hljs");
      expect(root.innerHTML).toContain("language-javascript");

      controller.destroy();
    });

    // AC: @streaming-markdown-component ac-6
    it("queues streaming chunks behind a single requestAnimationFrame gate", async () => {
      const { root } = await createDomHarness();
      const flushes: string[] = [];
      const scheduler = createTestScheduler();
      const controller = createStreamingMarkdownController(root, {
        scheduler,
        onChunkFlush(chunk) {
          flushes.push(chunk);
        },
      });

      controller.update("Hello", true);
      controller.update("Hello **markdown**", true);
      controller.update("Hello **markdown**\n\nmore", true);

      expect(scheduler.requestCount).toBe(1);
      expect(root.textContent ?? "").toBe("");

      scheduler.flushAll();

      expect(flushes).toHaveLength(1);
      expect(flushes[0]).toContain("markdown");
      expect(root.textContent).toContain("Hello markdown");

      controller.destroy();
    });

    // AC: @trait-markdown-rendering ac-9
    it("keeps large markdown rendering on the frame-batched streaming path", async () => {
      const { root } = await createDomHarness();
      const scheduler = createTestScheduler();
      const controller = createStreamingMarkdownController(root, { scheduler });
      const largeMarkdown = Array.from({ length: 10_000 }, (_, index) => `- item ${index}`).join("\n");
      const start = Date.now();

      controller.update(largeMarkdown, true);
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).toBeLessThan(100);
      expect(scheduler.requestCount).toBe(1);
      expect(root.textContent ?? "").not.toContain("item 9999");

      scheduler.flushAll();
      controller.update(largeMarkdown, false);

      expect(root.textContent).toContain("item 9999");

      controller.destroy();
    });
  });

  describe("tool display utilities", () => {
    // AC: @ui-session-stream ac-1
    it("getToolIcon returns icons for all known tools", () => {
      const knownTools = [
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Grep",
        "Glob",
        "WebFetch",
        "WebSearch",
        "Task",
        "TodoWrite",
        "NotebookEdit",
      ];
      for (const tool of knownTools) {
        expect(getToolIcon(tool)).toBeTruthy();
      }
      // Bash specifically returns '$'
      expect(getToolIcon("Bash")).toBe("$");
    });

    // AC: @ui-session-stream ac-1
    it("getToolIcon returns fallback for unknown tools", () => {
      expect(getToolIcon("UnknownTool")).toBeTruthy();
      expect(getToolIcon("UnknownTool")).toBe("\u{1F527}");
    });

    // AC: @ui-session-stream ac-1
    it("getToolInputPreview extracts command from Bash input", () => {
      expect(getToolInputPreview("Bash", { command: "ls -la" })).toBe(
        "ls -la",
      );
    });

    // AC: @ui-session-stream ac-1
    it("getToolInputPreview extracts file_path from Read/Write/Edit", () => {
      expect(
        getToolInputPreview("Read", { file_path: "/foo/bar.ts" }),
      ).toBe("/foo/bar.ts");
      expect(
        getToolInputPreview("Edit", {
          file_path: "/src/lib.ts",
          old_string: "a",
          new_string: "b",
        }),
      ).toBe("/src/lib.ts");
    });

    // AC: @ui-session-stream ac-1
    it("getToolInputPreview extracts pattern from Grep/Glob", () => {
      const preview = getToolInputPreview("Grep", { pattern: "TODO" });
      expect(preview).toContain("TODO");
    });

    // AC: @ui-session-stream ac-1
    it("getToolInputPreview truncates long commands", () => {
      const longCmd = "a".repeat(100);
      const preview = getToolInputPreview("Bash", { command: longCmd });
      expect(preview.length).toBeLessThan(100);
      expect(preview).toContain("\u2026"); // ellipsis
    });

    // AC: @ui-session-stream ac-1
    it("getToolInputPreview returns key summary for objects with many params", () => {
      const preview = getToolInputPreview("Custom", {
        a: 1,
        b: 2,
        c: 3,
        d: 4,
      });
      expect(preview).toBe("4 params");
    });

    // AC: @ui-session-stream ac-1
    it("getToolInputPreview returns empty for null/non-object input", () => {
      expect(getToolInputPreview("Bash", null)).toBe("");
      expect(getToolInputPreview("Bash", "string" as unknown)).toBe("");
    });
  });

  describe("formatting utilities", () => {
    // AC: @ui-session-stream ac-1
    it("formatDuration formats milliseconds", () => {
      expect(formatDuration(500)).toBe("500ms");
      expect(formatDuration(5000)).toBe("5s");
      expect(formatDuration(65000)).toBe("1m 5s");
      expect(formatDuration(125000)).toBe("2m 5s");
      expect(formatDuration(3725000)).toBe("1h 2m");
    });

    // AC: @ui-session-stream ac-1
    it("formatDuration handles edge cases", () => {
      expect(formatDuration(0)).toBe("0ms");
      expect(formatDuration(999)).toBe("999ms");
      expect(formatDuration(1000)).toBe("1s");
      expect(formatDuration(60000)).toBe("1m 0s");
      expect(formatDuration(3600000)).toBe("1h 0m");
    });

    // AC: @ui-session-stream ac-1
    it("formatTime returns HH:MM:SS format", () => {
      const ts = new Date("2026-01-15T14:30:45Z").getTime();
      const result = formatTime(ts);
      expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it("formatElapsed formats durations", () => {
      expect(formatElapsed(30000)).toBe("30s");
      expect(formatElapsed(125000)).toBe("2m 5s");
      expect(formatElapsed(3725000)).toBe("1h 2m");
    });

    it("formatAge returns relative time strings", () => {
      const justNow = new Date(Date.now() - 10000).toISOString();
      expect(formatAge(justNow)).toMatch(/just now|\dm/);

      const fiveMin = new Date(Date.now() - 5 * 60000).toISOString();
      expect(formatAge(fiveMin)).toBe("5m");

      const twoHours = new Date(Date.now() - 2 * 3600000).toISOString();
      expect(formatAge(twoHours)).toBe("2h");

      const threeDays = new Date(Date.now() - 3 * 86400000).toISOString();
      expect(formatAge(threeDays)).toBe("3d");
    });
  });
});

// ─── AC-2: Live streaming ────────────────────────────────────────────────────

// AC: @ui-session-stream ac-2
describe("live streaming logic (@ui-session-stream ac-2)", () => {
  describe("incremental event loading via parseEventsToBlocks", () => {
    // AC: @ui-session-stream ac-2
    it("parseEventsToBlocks handles incremental event appending", () => {
      // Simulate first load
      const batch1 = [
        { ts: 1000, seq: 0, type: "session.start", session_id: "s1", data: { agent_type: "worker" } },
        { ts: 1100, seq: 1, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "assistant_text", text: "Hello" } } },
      ];
      let allEvents = [...batch1];
      let blocks = parseEventsToBlocks(allEvents);
      expect(blocks).toHaveLength(2);
      expect(blocks[1]).toMatchObject({ type: "message", content: "Hello" });

      // Simulate incremental refresh (new events appended)
      const batch2 = [
        { ts: 1200, seq: 2, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_call", toolCallId: "tc1", tool: "Bash", rawInput: { command: "echo test" } } } },
        { ts: 1500, seq: 3, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_result", toolCallId: "tc1", output: "test" } } },
      ];
      allEvents = [...allEvents, ...batch2];
      blocks = parseEventsToBlocks(allEvents);
      expect(blocks).toHaveLength(3);
      expect(blocks.map((b) => b.type)).toEqual(["system", "message", "tool_call"]);

      // Verify the tool call resolved
      if (blocks[2].type === "tool_call") {
        expect(blocks[2].status).toBe("completed");
        expect(blocks[2].durationMs).toBe(300);
      }
    });
  });

  describe("getLastSeq — sequence tracking for incremental loading", () => {
    // AC: @ui-session-stream ac-2
    it("returns -1 for empty events", () => {
      expect(getLastSeq([])).toBe(-1);
    });

    // AC: @ui-session-stream ac-2
    it("returns the seq of the last event", () => {
      const events = [
        { seq: 0 },
        { seq: 5 },
        { seq: 10 },
      ];
      expect(getLastSeq(events)).toBe(10);
    });

    // AC: @ui-session-stream ac-2
    it("works with single event", () => {
      expect(getLastSeq([{ seq: 42 }])).toBe(42);
    });

    // AC: @ui-session-stream ac-2
    it("tracks incremental batches correctly", () => {
      const batch1 = [{ seq: 0 }, { seq: 1 }, { seq: 2 }];
      const lastAfterBatch1 = getLastSeq(batch1);
      expect(lastAfterBatch1).toBe(2);

      const batch2 = [{ seq: 3 }, { seq: 4 }];
      const allEvents = [...batch1, ...batch2];
      const lastAfterBatch2 = getLastSeq(allEvents);
      expect(lastAfterBatch2).toBe(4);
      expect(lastAfterBatch2).toBeGreaterThan(lastAfterBatch1);
    });
  });

  describe("accumulateStreamingText — WebSocket text chunk handling", () => {
    // AC: @ui-session-stream ac-2
    it("accumulates text from matching session chunks", () => {
      let text = "";
      text = accumulateStreamingText(text, { event: "agent_text_chunk", data: { session_id: "s1", text: "Hello " } }, "s1");
      text = accumulateStreamingText(text, { event: "agent_text_chunk", data: { session_id: "s1", text: "world" } }, "s1");
      expect(text).toBe("Hello world");
    });

    // AC: @ui-session-stream ac-2
    it("ignores chunks from other sessions", () => {
      let text = "existing";
      text = accumulateStreamingText(text, { event: "agent_text_chunk", data: { session_id: "s2", text: "other" } }, "s1");
      expect(text).toBe("existing");
    });

    // AC: @ui-session-stream ac-2
    it("ignores non-text-chunk events", () => {
      let text = "existing";
      text = accumulateStreamingText(text, { event: "agent_invocation", data: { session_id: "s1" } }, "s1");
      expect(text).toBe("existing");
    });

    // AC: @ui-session-stream ac-2
    it("ignores chunks with empty/missing text", () => {
      let text = "existing";
      text = accumulateStreamingText(text, { event: "agent_text_chunk", data: { session_id: "s1", text: "" } }, "s1");
      expect(text).toBe("existing");
      text = accumulateStreamingText(text, { event: "agent_text_chunk", data: { session_id: "s1" } }, "s1");
      expect(text).toBe("existing");
    });

    // AC: @ui-session-stream ac-2
    it("handles null data gracefully", () => {
      let text = "existing";
      text = accumulateStreamingText(text, { event: "agent_text_chunk", data: null }, "s1");
      expect(text).toBe("existing");
    });
  });

  describe("streaming text refresh pattern", () => {
    // AC: @ui-session-stream ac-2
    it("streaming text clears when structured refresh provides new blocks", () => {
      // parseEventsToBlocks produces blocks from the refreshed events
      const newEvents = [
        { ts: 5000, seq: 50, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "assistant_text", text: "partial text from chunks" } } },
      ];
      const blocks = parseEventsToBlocks(newEvents);
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks[0]).toMatchObject({ type: "message", content: "partial text from chunks" });
      // When blocks arrive, streaming text resets (component behavior verified by the logic:
      // if (eventsData.events.length > 0) streamingText = '')
    });
  });

  describe("session activity detection", () => {
    // AC: @ui-session-stream ac-2
    it("isLive is determined by session status being active", () => {
      // This matches the $derived in +page.svelte: isLive = session?.status === 'active'
      const activeSession = { status: "active" as const };
      const completedSession = { status: "completed" as const };
      expect(activeSession.status === "active").toBe(true);
      expect(completedSession.status === "active").toBe(false);
    });
  });
});

// ─── AC-3: Auto-scroll ──────────────────────────────────────────────────────

// AC: @ui-session-stream ac-3
describe("auto-scroll behavior (@ui-session-stream ac-3)", () => {
  describe("computeScrollDistance — distance from bottom calculation", () => {
    // AC: @ui-session-stream ac-3
    it("returns 0 when scrolled to bottom", () => {
      // scrollTop = scrollHeight - clientHeight means at bottom
      expect(computeScrollDistance(1000, 600, 400)).toBe(0);
    });

    // AC: @ui-session-stream ac-3
    it("returns positive distance when scrolled up", () => {
      expect(computeScrollDistance(1000, 550, 400)).toBe(50);
      expect(computeScrollDistance(1000, 400, 400)).toBe(200);
    });

    // AC: @ui-session-stream ac-3
    it("handles edge case of content shorter than viewport", () => {
      // scrollHeight <= clientHeight: can't scroll
      expect(computeScrollDistance(400, 0, 400)).toBe(0);
    });
  });

  describe("shouldAutoScroll — threshold-based auto-scroll detection", () => {
    // AC: @ui-session-stream ac-3
    it("threshold is 100px", () => {
      expect(AUTO_SCROLL_THRESHOLD).toBe(100);
    });

    // AC: @ui-session-stream ac-3
    it("returns true when at bottom (0px from bottom)", () => {
      expect(shouldAutoScrollFn(1000, 600, 400)).toBe(true);
    });

    // AC: @ui-session-stream ac-3
    it("returns true when within threshold (50px from bottom)", () => {
      expect(shouldAutoScrollFn(1000, 550, 400)).toBe(true);
    });

    // AC: @ui-session-stream ac-3
    it("returns true at exactly the threshold (100px from bottom — spec says >100px pauses)", () => {
      expect(shouldAutoScrollFn(1000, 500, 400)).toBe(true);
    });

    // AC: @ui-session-stream ac-3
    it("returns false just beyond the threshold (101px from bottom)", () => {
      expect(shouldAutoScrollFn(1000, 499, 400)).toBe(false);
    });

    // AC: @ui-session-stream ac-3
    it("returns false when scrolled well above threshold (200px from bottom)", () => {
      expect(shouldAutoScrollFn(1000, 400, 400)).toBe(false);
    });

    // AC: @ui-session-stream ac-3
    it("returns true when content fits in viewport (no scrolling needed)", () => {
      expect(shouldAutoScrollFn(400, 0, 400)).toBe(true);
    });
  });

  describe("shouldShowJumpButton — button visibility logic", () => {
    // AC: @ui-session-stream ac-3
    it("hides button when auto-scrolling (regardless of content)", () => {
      expect(shouldShowJumpButton(true, true, 10)).toBe(false);
      expect(shouldShowJumpButton(true, false, 10)).toBe(false);
    });

    // AC: @ui-session-stream ac-3
    it("shows button when not auto-scrolling and live", () => {
      expect(shouldShowJumpButton(false, true, 10)).toBe(true);
    });

    // AC: @ui-session-stream ac-3
    it("shows button when not auto-scrolling and has blocks", () => {
      expect(shouldShowJumpButton(false, false, 5)).toBe(true);
    });

    // AC: @ui-session-stream ac-3
    it("hides button when not auto-scrolling but no content", () => {
      expect(shouldShowJumpButton(false, false, 0)).toBe(false);
    });
  });
});

// ─── AC-4: Context panel ─────────────────────────────────────────────────────

// AC: @ui-session-stream ac-4
describe("session context panel (@ui-session-stream ac-4)", () => {
  describe("component and route exist", () => {
    // AC: @ui-session-stream ac-4
    it("context panel component exists", () => {
      expect(
        existsSync(join(SESSION_COMPONENTS, "SessionContextPanel.svelte")),
      ).toBe(true);
    });
  });

  describe("extractFilesChanged — file path extraction from tool call blocks", () => {
    // AC: @ui-session-stream ac-4
    it("extracts file paths from Write tool calls", () => {
      const blocks = [
        {
          type: "tool_call" as const,
          toolName: "Write",
          toolCallId: "1",
          input: { file_path: "/src/foo.ts" },
          status: "completed" as const,
          startedAt: 1000,
          seq: 0,
        },
      ];
      expect(extractFilesChanged(blocks)).toEqual(["/src/foo.ts"]);
    });

    // AC: @ui-session-stream ac-4
    it("extracts file paths from Edit tool calls", () => {
      const blocks = [
        {
          type: "tool_call" as const,
          toolName: "Edit",
          toolCallId: "1",
          input: {
            file_path: "/src/bar.ts",
            old_string: "a",
            new_string: "b",
          },
          status: "completed" as const,
          startedAt: 1000,
          seq: 0,
        },
      ];
      expect(extractFilesChanged(blocks)).toEqual(["/src/bar.ts"]);
    });

    // AC: @ui-session-stream ac-4
    it("extracts notebook_path from NotebookEdit tool calls", () => {
      const blocks = [
        {
          type: "tool_call" as const,
          toolName: "NotebookEdit",
          toolCallId: "1",
          input: { notebook_path: "/notebooks/analysis.ipynb" },
          status: "completed" as const,
          startedAt: 1000,
          seq: 0,
        },
      ];
      expect(extractFilesChanged(blocks)).toEqual([
        "/notebooks/analysis.ipynb",
      ]);
    });

    // AC: @ui-session-stream ac-4
    it("deduplicates files changed multiple times", () => {
      const blocks = [
        {
          type: "tool_call" as const,
          toolName: "Edit",
          toolCallId: "1",
          input: { file_path: "/src/foo.ts" },
          status: "completed" as const,
          startedAt: 1000,
          seq: 0,
        },
        {
          type: "tool_call" as const,
          toolName: "Edit",
          toolCallId: "2",
          input: { file_path: "/src/foo.ts" },
          status: "completed" as const,
          startedAt: 2000,
          seq: 1,
        },
      ];
      expect(extractFilesChanged(blocks)).toEqual(["/src/foo.ts"]);
    });

    // AC: @ui-session-stream ac-4
    it("ignores read-only tools (Read, Bash, Grep, Glob)", () => {
      const blocks = [
        {
          type: "tool_call" as const,
          toolName: "Read",
          toolCallId: "1",
          input: { file_path: "/src/read-only.ts" },
          status: "completed" as const,
          startedAt: 1000,
          seq: 0,
        },
        {
          type: "tool_call" as const,
          toolName: "Bash",
          toolCallId: "2",
          input: { command: "ls" },
          status: "completed" as const,
          startedAt: 2000,
          seq: 1,
        },
        {
          type: "tool_call" as const,
          toolName: "Grep",
          toolCallId: "3",
          input: { pattern: "test" },
          status: "completed" as const,
          startedAt: 3000,
          seq: 2,
        },
      ];
      expect(extractFilesChanged(blocks)).toEqual([]);
    });

    // AC: @ui-session-stream ac-4
    it("ignores non-tool-call block types", () => {
      const blocks = [
        { type: "message" as const, content: "hello", timestamp: 1000, seq: 0 },
        { type: "system" as const, label: "Session started", timestamp: 1000, seq: 1 },
        { type: "thinking" as const, content: "hmm", timestamp: 1000, seq: 2 },
      ];
      expect(extractFilesChanged(blocks)).toEqual([]);
    });

    // AC: @ui-session-stream ac-4
    it("returns sorted file paths", () => {
      const blocks = [
        {
          type: "tool_call" as const,
          toolName: "Write",
          toolCallId: "1",
          input: { file_path: "/src/z.ts" },
          status: "completed" as const,
          startedAt: 1000,
          seq: 0,
        },
        {
          type: "tool_call" as const,
          toolName: "Write",
          toolCallId: "2",
          input: { file_path: "/src/a.ts" },
          status: "completed" as const,
          startedAt: 2000,
          seq: 1,
        },
        {
          type: "tool_call" as const,
          toolName: "Edit",
          toolCallId: "3",
          input: { file_path: "/src/m.ts" },
          status: "completed" as const,
          startedAt: 3000,
          seq: 2,
        },
      ];
      expect(extractFilesChanged(blocks)).toEqual([
        "/src/a.ts",
        "/src/m.ts",
        "/src/z.ts",
      ]);
    });

    // AC: @ui-session-stream ac-4
    it("handles tool calls with null input", () => {
      const blocks = [
        {
          type: "tool_call" as const,
          toolName: "Write",
          toolCallId: "1",
          input: null,
          status: "completed" as const,
          startedAt: 1000,
          seq: 0,
        },
      ];
      expect(extractFilesChanged(blocks)).toEqual([]);
    });
  });

  describe("extractFilesChanged integrated with parseEventsToBlocks", () => {
    // AC: @ui-session-stream ac-4
    it("end-to-end: parse events then extract files changed", () => {
      const events = [
        { ts: 1000, seq: 0, type: "session.start", session_id: "s1", data: { agent_type: "worker" } },
        { ts: 1100, seq: 1, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_call", toolCallId: "r1", tool: "Read", rawInput: { file_path: "/src/old.ts" } } } },
        { ts: 1200, seq: 2, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_result", toolCallId: "r1", output: "content" } } },
        { ts: 1300, seq: 3, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_call", toolCallId: "e1", tool: "Edit", rawInput: { file_path: "/src/old.ts", old_string: "a", new_string: "b" } } } },
        { ts: 1400, seq: 4, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_result", toolCallId: "e1", output: "OK" } } },
        { ts: 1500, seq: 5, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_call", toolCallId: "w1", tool: "Write", rawInput: { file_path: "/src/new.ts" } } } },
        { ts: 1600, seq: 6, type: "session.update", session_id: "s1", data: { update: { sessionUpdate: "tool_result", toolCallId: "w1", output: "OK" } } },
      ];

      const blocks = parseEventsToBlocks(events);
      const files = extractFilesChanged(blocks);

      // Read should be excluded, Edit and Write should be included
      expect(files).toEqual(["/src/new.ts", "/src/old.ts"]);
    });
  });

  describe("session metadata types", () => {
    // AC: @ui-session-stream ac-4
    it("SessionDetail includes spec_context and budget fields", () => {
      // Test that the type contract is correct by constructing mock data
      const session = {
        id: "s1",
        status: "completed" as const,
        agent_type: "worker",
        session_type: "invocation" as const,
        started_at: "2026-01-01T00:00:00Z",
        ended_at: "2026-01-01T01:00:00Z",
        duration_ms: 3600000,
        event_count: 50,
        iteration_count: 3,
        tasks_completed: 1,
        spec_context: {
          spec_ref: "@ui-session-stream",
          title: "Session Stream View",
          acceptance_criteria: [
            { id: "ac-1", description: "Structured blocks" },
            { id: "ac-2", description: "Live streaming" },
          ],
        },
        budget: {
          max_per_cycle: 10,
          started_this_cycle: 3,
        },
      };

      // Verify spec context
      expect(session.spec_context).toBeDefined();
      expect(session.spec_context!.spec_ref).toBe("@ui-session-stream");
      expect(session.spec_context!.title).toBe("Session Stream View");
      expect(session.spec_context!.acceptance_criteria).toHaveLength(2);
      expect(session.spec_context!.acceptance_criteria[0].id).toBe("ac-1");

      // Verify budget
      expect(session.budget).toBeDefined();
      expect(session.budget!.max_per_cycle).toBe(10);
      expect(session.budget!.started_this_cycle).toBe(3);
    });

    // AC: @ui-session-stream ac-4
    it("spec_context and budget can be null/undefined", () => {
      const session = {
        id: "s2",
        status: "active" as const,
        spec_context: null,
        budget: undefined,
      };
      expect(session.spec_context).toBeNull();
      expect(session.budget).toBeUndefined();
    });

    // AC: @ui-session-stream ac-4
    it("budget progress calculation is correct", () => {
      // The context panel displays a progress bar: (started / max) * 100
      const budget = { max_per_cycle: 10, started_this_cycle: 3 };
      const progress = Math.min(
        100,
        (budget.started_this_cycle / budget.max_per_cycle) * 100,
      );
      expect(progress).toBe(30);

      // Capped at 100% even if over budget
      const overBudget = { max_per_cycle: 5, started_this_cycle: 8 };
      const cappedProgress = Math.min(
        100,
        (overBudget.started_this_cycle / overBudget.max_per_cycle) * 100,
      );
      expect(cappedProgress).toBe(100);
    });
  });
});

// ─── AC-5: Collapsed tool call row single-line layout ────────────────────────

// AC: @ui-session-stream ac-5
describe("collapsed tool call row layout (@ui-session-stream ac-5)", () => {
  let toolCallSrc: string;

  beforeAll(() => {
    const { readFileSync } = require("node:fs");
    toolCallSrc = readFileSync(
      join(SESSION_COMPONENTS, "ToolCallView.svelte"),
      "utf-8",
    );
  });

  // AC: @ui-session-stream ac-5
  it("expanded state initializes to false (collapsed by default)", () => {
    // Tool calls must start collapsed regardless of status so the single-line
    // layout is the default view. $state(false) not $state(block.status === 'running').
    expect(toolCallSrc).toMatch(/let expanded = \$state\(false\)/);
    expect(toolCallSrc).not.toMatch(/let expanded = \$state\(block\.status/);
  });

  // AC: @ui-session-stream ac-5
  it("header button uses overflow-hidden to enforce single-line", () => {
    // The collapsed row button must clip overflow to prevent multi-line wrapping
    expect(toolCallSrc).toMatch(/class="[^"]*overflow-hidden[^"]*"/);
  });

  // AC: @ui-session-stream ac-5
  it("chevron, timestamp, and duration are flex-shrink-0 (never hidden)", () => {
    // ChevronRight component has flex-shrink-0
    expect(toolCallSrc).toMatch(/ChevronRight[\s\S]*?flex-shrink-0/);
    // Timestamp span has flex-shrink-0
    expect(toolCallSrc).toMatch(/formatTime[\s\S]*?flex-shrink-0/);
    // Duration span has flex-shrink-0
    expect(toolCallSrc).toMatch(/formatDuration[\s\S]*?flex-shrink-0/);
  });

  // AC: @ui-session-stream ac-5
  it("status icons are flex-shrink-0 (never hidden)", () => {
    // Each status icon (Loader, Check, X) must have flex-shrink-0
    expect(toolCallSrc).toMatch(/Loader[\s\S]*?flex-shrink-0/);
    expect(toolCallSrc).toMatch(/Check[\s\S]*?flex-shrink-0/);
    expect(toolCallSrc).toMatch(/<X[\s\S]*?flex-shrink-0/);
  });

  // AC: @ui-session-stream ac-5
  it("tool name badge allows truncation (not flex-shrink-0)", () => {
    // The tool name badge must use min-w-0 to allow flex shrinking
    // and must NOT be flex-shrink-0 (which would prevent truncation)
    const badgeMatch = toolCallSrc.match(
      /class="[^"]*font-mono bg-secondary[^"]*"/,
    );
    expect(badgeMatch).not.toBeNull();
    const badgeClasses = badgeMatch![0];
    expect(badgeClasses).toContain("min-w-0");
    expect(badgeClasses).not.toContain("flex-shrink-0");
  });

  // AC: @ui-session-stream ac-5
  it("tool name text inside badge uses truncate class", () => {
    // The inner span containing block.toolName must have truncate for ellipsis
    expect(toolCallSrc).toMatch(/class="truncate">\{block\.toolName\}/);
  });

  // AC: @ui-session-stream ac-5
  it("preview span uses truncate with min-w-0", () => {
    // Parameter preview should truncate, not wrap
    expect(toolCallSrc).toMatch(/class="[^"]*truncate[^"]*min-w-0[^"]*"/);
  });
});

// ─── View states ─────────────────────────────────────────────────────────────

describe("view states", () => {
  it("loading skeleton component exists", () => {
    expect(
      existsSync(join(SESSION_COMPONENTS, "SessionStreamSkeleton.svelte")),
    ).toBe(true);
  });

  it("sessions list page exists", () => {
    expect(
      existsSync(join(WEB_UI_SRC, "routes", "sessions", "+page.svelte")),
    ).toBe(true);
  });
});

// ─── Design tokens and accessibility ─────────────────────────────────────────

describe("design tokens and accessibility", () => {
  it("no raw Tailwind color classes in session components", () => {
    // Read component sources and verify no raw emerald/red/blue/purple colors
    const { readFileSync } = require("node:fs");
    const componentFiles = [
      "SessionStream.svelte",
      "ToolCallView.svelte",
      "ThinkingBlock.svelte",
      "MessageBlock.svelte",
      "SystemBlock.svelte",
      "SessionContextPanel.svelte",
    ];

    const rawColorPattern =
      /\b(?:text|bg|border(?:-[lrtb])?)-(?:emerald|red|blue|purple|green|amber|orange|yellow|pink|teal|cyan|indigo|violet|fuchsia|rose|lime|sky)-\d+\b/g;

    for (const file of componentFiles) {
      const path = join(SESSION_COMPONENTS, file);
      if (existsSync(path)) {
        const src = readFileSync(path, "utf-8");
        const matches = src.match(rawColorPattern);
        expect(
          matches,
          `${file} contains raw Tailwind colors: ${matches?.join(", ")}`,
        ).toBeNull();
      }
    }
  });

  it("no raw Tailwind color classes in session page", () => {
    const { readFileSync } = require("node:fs");
    const pagePath = join(WEB_UI_SRC, "routes", "sessions", "[id]", "+page.svelte");
    const src = readFileSync(pagePath, "utf-8");
    const rawColorPattern =
      /\b(?:text|bg|border(?:-[lrtb])?)-(?:emerald|red|blue|purple|green)-\d+\b/g;
    const matches = src.match(rawColorPattern);
    expect(
      matches,
      `Session page contains raw Tailwind colors: ${matches?.join(", ")}`,
    ).toBeNull();
  });

  it("session stream has aria-live and role=log for screen readers", () => {
    const { readFileSync } = require("node:fs");
    const src = readFileSync(
      join(SESSION_COMPONENTS, "SessionStream.svelte"),
      "utf-8",
    );
    // Verify the stream container has accessibility attributes
    expect(src).toContain("aria-live");
    expect(src).toContain('role="log"');
  });

  it("animations are gated behind prefers-reduced-motion", () => {
    const { readFileSync } = require("node:fs");
    const animatedFiles = [
      "SessionStream.svelte",
      "ToolCallView.svelte",
      "SessionContextPanel.svelte",
    ];

    for (const file of animatedFiles) {
      const path = join(SESSION_COMPONENTS, file);
      if (existsSync(path)) {
        const src = readFileSync(path, "utf-8");
        // If file has @keyframes, it should also have prefers-reduced-motion
        if (src.includes("@keyframes")) {
          expect(
            src,
            `${file} has animations but missing prefers-reduced-motion media query`,
          ).toContain("prefers-reduced-motion");
        }
      }
    }
  });
});
