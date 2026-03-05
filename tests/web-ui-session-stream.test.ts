/**
 * Session Stream View Tests
 *
 * Tests for the session stream view implementation.
 * Combines static analysis for Svelte component structure verification
 * with unit tests for the session-utils module (parseEventsToBlocks,
 * extractFilesChanged, formatDuration, etc.).
 *
 * Spec: @ui-session-stream
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB_UI_ROOT = join(process.cwd(), "packages", "web-ui");
const WEB_UI_SRC = join(WEB_UI_ROOT, "src");
const SESSION_COMPONENTS = join(WEB_UI_SRC, "lib", "components", "session");
const DAEMON_ROUTES = join(
  process.cwd(),
  "packages",
  "daemon",
  "src",
  "routes",
);

// Path variables for session components
const SESSION_STREAM_PATH = join(SESSION_COMPONENTS, "SessionStream.svelte");
const TOOL_CALL_VIEW_PATH = join(SESSION_COMPONENTS, "ToolCallView.svelte");
const THINKING_BLOCK_PATH = join(SESSION_COMPONENTS, "ThinkingBlock.svelte");
const MESSAGE_BLOCK_PATH = join(SESSION_COMPONENTS, "MessageBlock.svelte");
const SYSTEM_BLOCK_PATH = join(SESSION_COMPONENTS, "SystemBlock.svelte");
const SESSION_UTILS_PATH = join(SESSION_COMPONENTS, "session-utils.ts");
const CONTEXT_PANEL_PATH = join(
  SESSION_COMPONENTS,
  "SessionContextPanel.svelte",
);
const SKELETON_PATH = join(
  SESSION_COMPONENTS,
  "SessionStreamSkeleton.svelte",
);
const SESSION_PAGE_PATH = join(
  WEB_UI_SRC,
  "routes",
  "sessions",
  "[id]",
  "+page.svelte",
);
const SESSIONS_LIST_PATH = join(
  WEB_UI_SRC,
  "routes",
  "sessions",
  "+page.svelte",
);
const API_PATH = join(WEB_UI_SRC, "lib", "api.ts");
const SESSION_ROUTES_PATH = join(DAEMON_ROUTES, "sessions.ts");

// Load sources
let sessionStreamSrc = "";
let toolCallViewSrc = "";
let thinkingBlockSrc = "";
let messageBlockSrc = "";
let systemBlockSrc = "";
let sessionUtilsSrc = "";
let contextPanelSrc = "";
let skeletonSrc = "";
let sessionPageSrc = "";
let sessionsListSrc = "";
let apiSrc = "";
let sessionRoutesSrc = "";

function loadSources() {
  sessionStreamSrc = readFileSync(SESSION_STREAM_PATH, "utf-8");
  toolCallViewSrc = readFileSync(TOOL_CALL_VIEW_PATH, "utf-8");
  thinkingBlockSrc = readFileSync(THINKING_BLOCK_PATH, "utf-8");
  messageBlockSrc = readFileSync(MESSAGE_BLOCK_PATH, "utf-8");
  systemBlockSrc = readFileSync(SYSTEM_BLOCK_PATH, "utf-8");
  sessionUtilsSrc = readFileSync(SESSION_UTILS_PATH, "utf-8");
  contextPanelSrc = readFileSync(CONTEXT_PANEL_PATH, "utf-8");
  skeletonSrc = readFileSync(SKELETON_PATH, "utf-8");
  sessionPageSrc = readFileSync(SESSION_PAGE_PATH, "utf-8");
  sessionsListSrc = readFileSync(SESSIONS_LIST_PATH, "utf-8");
  apiSrc = readFileSync(API_PATH, "utf-8");
  sessionRoutesSrc = readFileSync(SESSION_ROUTES_PATH, "utf-8");
}

loadSources();

// ─── AC-1: Structured event blocks ────────────────────────────────────────────

// AC: @ui-session-stream ac-1
describe("structured event blocks (@ui-session-stream ac-1)", () => {
  it("session route exists at /sessions/[id]", () => {
    expect(existsSync(SESSION_PAGE_PATH)).toBe(true);
  });

  it("renders all four block types from session-utils DisplayBlock union", () => {
    // Verify SessionStream conditionally renders each block type
    expect(sessionStreamSrc).toContain("MessageBlock");
    expect(sessionStreamSrc).toContain("ToolCallView");
    expect(sessionStreamSrc).toContain("ThinkingBlock");
    expect(sessionStreamSrc).toContain("SystemBlock");
  });

  it("message blocks have correct test id and render agent content", () => {
    expect(messageBlockSrc).toContain('data-testid="message-block"');
    expect(messageBlockSrc).toContain("block.content");
  });

  it("tool call blocks are collapsible with aria-expanded", () => {
    expect(toolCallViewSrc).toContain('data-testid="tool-call-block"');
    expect(toolCallViewSrc).toContain("aria-expanded={expanded}");
    // Verify expanded state toggles on click
    expect(toolCallViewSrc).toContain(
      "onclick={() => (expanded = !expanded)}",
    );
  });

  it("tool call blocks show icon, input, output, and timing", () => {
    expect(toolCallViewSrc).toContain("getToolIcon");
    expect(toolCallViewSrc).toContain("formatInput(block.input)");
    expect(toolCallViewSrc).toContain("formatDuration(block.durationMs)");
    // Input and Output sections exist in the expanded view
    expect(toolCallViewSrc).toContain("Input</p>");
    expect(toolCallViewSrc).toContain("Output");
  });

  it("thinking blocks are collapsed by default and expandable", () => {
    expect(thinkingBlockSrc).toContain('data-testid="thinking-block"');
    // Default collapsed state
    expect(thinkingBlockSrc).toContain("let expanded = $state(false)");
    expect(thinkingBlockSrc).toContain("aria-expanded={expanded}");
  });

  it("system blocks render lifecycle events with label and detail", () => {
    expect(systemBlockSrc).toContain('data-testid="system-block"');
    expect(systemBlockSrc).toContain("block.label");
    expect(systemBlockSrc).toContain("block.detail");
  });

  it("daemon has session routes for list, get, and events", () => {
    expect(existsSync(SESSION_ROUTES_PATH)).toBe(true);
    expect(sessionRoutesSrc).toContain("/api/sessions");
    expect(sessionRoutesSrc).toContain("/:id/events");
  });

  it("web-ui API client exports session fetch functions", () => {
    expect(apiSrc).toContain("export async function fetchSessions");
    expect(apiSrc).toContain("export async function fetchSession");
    expect(apiSrc).toContain("export async function fetchSessionEvents");
  });
});

// ─── AC-2: Live streaming ────────────────────────────────────────────────────

// AC: @ui-session-stream ac-2
describe("live streaming via WebSocket (@ui-session-stream ac-2)", () => {
  it("subscribes to agent WebSocket topic for live events", () => {
    expect(sessionPageSrc).toContain("subscribe(['agents'])");
    expect(sessionPageSrc).toContain("on('agents'");
  });

  it("handles agent_text_chunk events and appends to streaming text", () => {
    expect(sessionPageSrc).toContain("agent_text_chunk");
    // Verify it filters by session ID
    expect(sessionPageSrc).toContain("data.session_id === sessionId");
    expect(sessionPageSrc).toContain("streamingText +=");
  });

  it("renders streaming text with blinking cursor indicator", () => {
    expect(sessionStreamSrc).toContain('data-testid="streaming-text"');
    expect(sessionStreamSrc).toContain("ds-streaming-cursor");
  });

  it("performs periodic structured refresh every 3 seconds for live sessions", () => {
    expect(sessionPageSrc).toContain("setInterval");
    expect(sessionPageSrc).toContain("3000");
    expect(sessionPageSrc).toContain("refreshEvents");
  });

  it("uses incremental event loading via since_seq parameter", () => {
    expect(sessionPageSrc).toContain("lastSeq");
    expect(apiSrc).toContain("since_seq");
  });

  it("clears streaming text when structured data arrives", () => {
    expect(sessionPageSrc).toContain("streamingText = ''");
  });

  it("unsubscribes and cleans up on destroy", () => {
    expect(sessionPageSrc).toContain("onDestroy");
    expect(sessionPageSrc).toContain("unsubscribe(['agents'])");
    expect(sessionPageSrc).toContain("off('agents'");
    expect(sessionPageSrc).toContain("clearInterval");
  });
});

// ─── AC-3: Auto-scroll ──────────────────────────────────────────────────────

// AC: @ui-session-stream ac-3
describe("auto-scroll behavior (@ui-session-stream ac-3)", () => {
  it("tracks shouldAutoScroll state and scrolls via $effect", () => {
    expect(sessionStreamSrc).toContain("shouldAutoScroll");
    expect(sessionStreamSrc).toContain("scrollTo");
    expect(sessionStreamSrc).toContain("$effect");
  });

  it("pauses auto-scroll when user scrolls >100px from bottom", () => {
    expect(sessionStreamSrc).toContain("distanceFromBottom");
    expect(sessionStreamSrc).toContain(
      "shouldAutoScroll = distanceFromBottom < 100",
    );
  });

  it("shows jump-to-bottom button when auto-scroll is paused", () => {
    expect(sessionStreamSrc).toContain('data-testid="jump-to-bottom"');
    expect(sessionStreamSrc).toContain("showJumpButton");
    expect(sessionStreamSrc).toContain("jumpToBottom");
  });

  it("jump-to-bottom re-enables auto-scroll with smooth behavior", () => {
    expect(sessionStreamSrc).toContain("shouldAutoScroll = true");
    expect(sessionStreamSrc).toContain("behavior: 'smooth'");
  });

  it("uses debounced scroll detection (150ms)", () => {
    expect(sessionStreamSrc).toContain("userScrolling");
    expect(sessionStreamSrc).toContain("scrollDebounceTimer");
    expect(sessionStreamSrc).toContain("150");
  });
});

// ─── AC-4: Context panel ─────────────────────────────────────────────────────

// AC: @ui-session-stream ac-4
describe("session context panel (@ui-session-stream ac-4)", () => {
  it("renders context panel on the left side of the session view", () => {
    expect(sessionPageSrc).toContain("SessionContextPanel");
    expect(contextPanelSrc).toContain('data-testid="session-context-panel"');
  });

  it("displays session metadata: status, agent, duration, trigger", () => {
    expect(contextPanelSrc).toContain("session.status");
    expect(contextPanelSrc).toContain("session.agent_type");
    expect(contextPanelSrc).toContain("formatElapsed(session.duration_ms)");
    expect(contextPanelSrc).toContain("triggerLabel");
  });

  it("displays spec context with title, ref, and AC checklist", () => {
    // Verify spec context section exists
    expect(contextPanelSrc).toContain('data-testid="spec-context-section"');
    // Verify AC checklist rendering
    expect(contextPanelSrc).toContain('data-testid="ac-checklist"');
    expect(contextPanelSrc).toContain("session.spec_context");
    expect(contextPanelSrc).toContain("session.spec_context.spec_ref");
    expect(contextPanelSrc).toContain("session.spec_context.title");
    expect(contextPanelSrc).toContain(
      "session.spec_context.acceptance_criteria",
    );
  });

  it("displays files changed during session", () => {
    expect(contextPanelSrc).toContain('data-testid="files-changed-section"');
    expect(contextPanelSrc).toContain("filesChanged");
    // Uses extractFilesChanged from session-utils
    expect(contextPanelSrc).toContain("extractFilesChanged");
  });

  it("displays budget info when available", () => {
    expect(contextPanelSrc).toContain('data-testid="budget-section"');
    expect(contextPanelSrc).toContain("session.budget");
    expect(contextPanelSrc).toContain(
      "session.budget.started_this_cycle",
    );
    expect(contextPanelSrc).toContain("session.budget.max_per_cycle");
  });

  it("API types include spec_context and budget on SessionDetail", () => {
    expect(apiSrc).toContain("interface SessionSpecContext");
    expect(apiSrc).toContain("interface SessionBudget");
    expect(apiSrc).toContain("spec_context?: SessionSpecContext");
    expect(apiSrc).toContain("budget?: SessionBudget");
  });

  it("daemon session route resolves spec context from task's spec_ref", () => {
    expect(sessionRoutesSrc).toContain("spec_context");
    expect(sessionRoutesSrc).toContain("acceptance_criteria");
    expect(sessionRoutesSrc).toContain("getBudget");
  });

  it("page passes blocks to context panel for files-changed extraction", () => {
    expect(sessionPageSrc).toContain("SessionContextPanel {session} {blocks}");
  });

  it("shows timeline information (started, ended, duration)", () => {
    expect(contextPanelSrc).toContain("session.started_at");
    expect(contextPanelSrc).toContain("session.ended_at");
    expect(contextPanelSrc).toContain("formatAge");
  });
});

// ─── View states ─────────────────────────────────────────────────────────────

describe("view states", () => {
  it("has loading skeleton state", () => {
    expect(sessionPageSrc).toContain("SessionStreamSkeleton");
    expect(sessionPageSrc).toContain("{#if loading}");
    expect(skeletonSrc).toContain('data-testid="session-skeleton"');
    expect(skeletonSrc).toContain("ds-shimmer");
  });

  it("has error state with alert role", () => {
    expect(sessionPageSrc).toContain('data-testid="session-error"');
    expect(sessionPageSrc).toContain('role="alert"');
  });

  it("has empty state for no events", () => {
    expect(sessionStreamSrc).toContain('data-testid="stream-empty"');
    expect(sessionStreamSrc).toContain("No events recorded");
  });

  it("sessions list page renders session rows", () => {
    expect(sessionsListSrc).toContain("fetchSessions");
    expect(sessionsListSrc).toContain('data-testid="session-row"');
  });

  it("sessions list has empty state", () => {
    expect(sessionsListSrc).toContain('data-testid="sessions-empty"');
    expect(sessionsListSrc).toContain("No sessions yet");
  });
});

// ─── Animations, accessibility, and design tokens ────────────────────────────

describe("animations, accessibility, and design tokens", () => {
  it("streaming cursor animation gated behind prefers-reduced-motion", () => {
    expect(sessionStreamSrc).toContain("prefers-reduced-motion");
    expect(sessionStreamSrc).toContain("ds-streaming-cursor");
  });

  it("tool call spinner animation gated behind prefers-reduced-motion", () => {
    expect(toolCallViewSrc).toContain("prefers-reduced-motion");
    expect(toolCallViewSrc).toContain("ds-tool-spin");
  });

  it("active session pulse animation gated behind prefers-reduced-motion", () => {
    expect(contextPanelSrc).toContain("prefers-reduced-motion");
    expect(contextPanelSrc).toContain("ds-session-active-dot");
  });

  it("skeleton uses ds-shimmer animation", () => {
    expect(skeletonSrc).toContain("ds-shimmer");
  });

  it("streaming output region has aria-live for screen readers", () => {
    expect(sessionStreamSrc).toContain("aria-live");
    expect(sessionStreamSrc).toContain('role="log"');
  });

  it("uses design-system status tokens instead of raw Tailwind colors", () => {
    // ToolCallView should use status-* tokens, not emerald/red/blue
    expect(toolCallViewSrc).not.toMatch(/\btext-emerald-\d+\b/);
    expect(toolCallViewSrc).not.toMatch(/\btext-red-\d+\b/);
    expect(toolCallViewSrc).not.toMatch(/\btext-blue-\d+\b/);
    expect(toolCallViewSrc).not.toMatch(/\bborder-l-emerald-\d+\b/);
    expect(toolCallViewSrc).not.toMatch(/\bborder-l-red-\d+\b/);
    expect(toolCallViewSrc).not.toMatch(/\bborder-l-blue-\d+\b/);
    // Should use status tokens instead
    expect(toolCallViewSrc).toContain("status-completed");
    expect(toolCallViewSrc).toContain("status-blocked");
    expect(toolCallViewSrc).toContain("status-pending-review");

    // ThinkingBlock should not use raw purple colors
    expect(thinkingBlockSrc).not.toMatch(/\btext-purple-\d+\b/);
    expect(thinkingBlockSrc).not.toMatch(/\bborder-l-purple-\d+\b/);

    // Session page should not use raw emerald
    expect(sessionPageSrc).not.toMatch(/\bbg-emerald-\d+\b/);
    expect(sessionPageSrc).not.toMatch(/\btext-emerald-\d+\b/);

    // Context panel should not use raw emerald
    expect(contextPanelSrc).not.toMatch(/\bbg-emerald-\d+\b/);
  });
});

// ─── Event parsing unit tests ────────────────────────────────────────────────

describe("parseEventsToBlocks", () => {
  let parseEventsToBlocks: (typeof import("../packages/web-ui/src/lib/components/session/session-utils"))["parseEventsToBlocks"];
  let getToolIcon: (typeof import("../packages/web-ui/src/lib/components/session/session-utils"))["getToolIcon"];
  let getToolInputPreview: (typeof import("../packages/web-ui/src/lib/components/session/session-utils"))["getToolInputPreview"];
  let formatDuration: (typeof import("../packages/web-ui/src/lib/components/session/session-utils"))["formatDuration"];
  let formatTime: (typeof import("../packages/web-ui/src/lib/components/session/session-utils"))["formatTime"];
  let extractFilesChanged: (typeof import("../packages/web-ui/src/lib/components/session/session-utils"))["extractFilesChanged"];

  beforeAll(async () => {
    const mod = await import(
      "../packages/web-ui/src/lib/components/session/session-utils"
    );
    parseEventsToBlocks = mod.parseEventsToBlocks;
    getToolIcon = mod.getToolIcon;
    getToolInputPreview = mod.getToolInputPreview;
    formatDuration = mod.formatDuration;
    formatTime = mod.formatTime;
    extractFilesChanged = mod.extractFilesChanged;
  });

  // AC: @ui-session-stream ac-1
  it("parses session.start as system block", () => {
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
    expect(blocks[0].type).toBe("system");
    if (blocks[0].type === "system") {
      expect(blocks[0].label).toBe("Session started");
    }
  });

  // AC: @ui-session-stream ac-1
  it("parses assistant text as message block", () => {
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
    expect(blocks[0].type).toBe("message");
    if (blocks[0].type === "message") {
      expect(blocks[0].content).toBe("Hello world");
    }
  });

  // AC: @ui-session-stream ac-1
  it("merges consecutive message blocks", () => {
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
        data: { update: { sessionUpdate: "assistant_text", text: "world" } },
      },
    ];
    const blocks = parseEventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === "message") {
      expect(blocks[0].content).toBe("Hello world");
    }
  });

  // AC: @ui-session-stream ac-1
  it("parses tool_call and tool_result as tool call block with duration", () => {
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
        ts: 2000,
        seq: 1,
        type: "session.update",
        session_id: "s1",
        data: {
          update: {
            sessionUpdate: "tool_result",
            toolCallId: "tc-1",
            output: "file.txt",
          },
        },
      },
    ];
    const blocks = parseEventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_call");
    if (blocks[0].type === "tool_call") {
      expect(blocks[0].toolName).toBe("Bash");
      expect(blocks[0].status).toBe("completed");
      expect(blocks[0].durationMs).toBe(1000);
    }
  });

  // AC: @ui-session-stream ac-1
  it("parses thinking blocks", () => {
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
    expect(blocks[0].type).toBe("thinking");
    if (blocks[0].type === "thinking") {
      expect(blocks[0].content).toBe("Let me think...");
    }
  });

  // AC: @ui-session-stream ac-1
  it("handles failed tool results", () => {
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
            rawInput: { command: "bad" },
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
            toolCallId: "tc-1",
            output: "error",
            error: true,
          },
        },
      },
    ];
    const blocks = parseEventsToBlocks(events);
    expect(blocks[0].type).toBe("tool_call");
    if (blocks[0].type === "tool_call") {
      expect(blocks[0].status).toBe("failed");
    }
  });

  // AC: @ui-session-stream ac-1
  it("handles agent lifecycle events", () => {
    const events = [
      {
        ts: 1000,
        seq: 0,
        type: "agent.dispatched",
        session_id: "s1",
        data: { task_ref: "@task-foo" },
      },
      {
        ts: 2000,
        seq: 1,
        type: "agent.completed",
        session_id: "s1",
        data: { task_ref: "@task-foo" },
      },
    ];
    const blocks = parseEventsToBlocks(events);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("system");
    expect(blocks[1].type).toBe("system");
    if (blocks[0].type === "system") {
      expect(blocks[0].label).toBe("Agent dispatched");
    }
    if (blocks[1].type === "system") {
      expect(blocks[1].label).toBe("Agent completed");
    }
  });

  it("getToolIcon returns icon for known tools", () => {
    expect(getToolIcon("Read")).toBeTruthy();
    expect(getToolIcon("Bash")).toBe("$");
    expect(getToolIcon("unknown_tool")).toBeTruthy();
  });

  it("getToolInputPreview extracts command from bash input", () => {
    expect(getToolInputPreview("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("getToolInputPreview extracts file_path", () => {
    expect(getToolInputPreview("Read", { file_path: "/foo/bar.ts" })).toBe(
      "/foo/bar.ts",
    );
  });

  it("formatDuration formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(125000)).toBe("2m 5s");
    expect(formatDuration(3725000)).toBe("1h 2m");
  });

  it("formatTime returns HH:MM:SS", () => {
    const ts = new Date("2026-01-15T14:30:45Z").getTime();
    const result = formatTime(ts);
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});

// ─── Files changed extraction unit tests ─────────────────────────────────────

// AC: @ui-session-stream ac-4
describe("extractFilesChanged", () => {
  let extractFilesChanged: (typeof import("../packages/web-ui/src/lib/components/session/session-utils"))["extractFilesChanged"];

  beforeAll(async () => {
    const mod = await import(
      "../packages/web-ui/src/lib/components/session/session-utils"
    );
    extractFilesChanged = mod.extractFilesChanged;
  });

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

  it("extracts file paths from Edit tool calls", () => {
    const blocks = [
      {
        type: "tool_call" as const,
        toolName: "Edit",
        toolCallId: "1",
        input: { file_path: "/src/bar.ts", old_string: "a", new_string: "b" },
        status: "completed" as const,
        startedAt: 1000,
        seq: 0,
      },
    ];
    expect(extractFilesChanged(blocks)).toEqual(["/src/bar.ts"]);
  });

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

  it("deduplicates files that were changed multiple times", () => {
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

  it("ignores non-write tool calls (Read, Bash, Grep)", () => {
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
    ];
    expect(extractFilesChanged(blocks)).toEqual([]);
  });

  it("ignores non-tool-call block types", () => {
    const blocks = [
      {
        type: "message" as const,
        content: "hello",
        timestamp: 1000,
        seq: 0,
      },
      {
        type: "system" as const,
        label: "Session started",
        timestamp: 1000,
        seq: 1,
      },
    ];
    expect(extractFilesChanged(blocks)).toEqual([]);
  });

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
    ];
    expect(extractFilesChanged(blocks)).toEqual(["/src/a.ts", "/src/z.ts"]);
  });
});
