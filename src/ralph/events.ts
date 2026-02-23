/**
 * Ralph Event System
 *
 * Translates ACP SessionUpdate events into structured RalphEvents.
 * This layer is pure data - no rendering concerns. Enables future
 * TUI or other renderers to consume the same event stream.
 */

import type { SessionUpdate } from "../acp/types.js";

// ============================================================================
// Event Types
// ============================================================================

export type RalphEventType =
  | "agent_message"
  | "agent_thought"
  | "tool_start"
  | "tool_update"
  | "tool_result"
  | "status";

export interface RalphEvent {
  type: RalphEventType;
  timestamp: number; // ms since session start
  data: RalphEventData;
}

export type RalphEventData =
  | AgentMessageData
  | AgentThoughtData
  | ToolStartData
  | ToolUpdateData
  | ToolResultData
  | StatusData;

export interface AgentMessageData {
  kind: "agent_message";
  content: string;
  isStreaming: boolean;
}

export interface AgentThoughtData {
  kind: "agent_thought";
  content: string;
  isStreaming: boolean;
}

export interface ToolStartData {
  kind: "tool_start";
  toolCallId: string;
  tool: string;
  summary: string;
  input: unknown;
}

export interface ToolUpdateData {
  kind: "tool_update";
  toolCallId: string;
  tool: string;
  status: "pending" | "running";
  summary?: string; // Present when input becomes available in phased events
}

export interface ToolResultData {
  kind: "tool_result";
  toolCallId: string;
  tool: string;
  status: "completed" | "failed" | "cancelled";
  output?: string;
  truncated: boolean;
}

export interface StatusData {
  kind: "status";
  status: string;
  message?: string;
}

// ============================================================================
// Translator Interface
// ============================================================================

export interface RalphTranslator {
  /**
   * Translate an ACP SessionUpdate to a RalphEvent.
   * Returns null if the update should be suppressed.
   */
  translate(update: SessionUpdate): RalphEvent | null;

  /**
   * Signal end of stream. Returns final event if there's pending state.
   */
  finalize(): RalphEvent | null;
}

// ============================================================================
// Tool Summary Extraction
// ============================================================================

/**
 * Extract a human-readable summary for a tool call.
 * Based on kynetic ui-event-translator.ts patterns.
 */
function getToolSummary(tool: string, input: unknown): string {
  const inp = input as Record<string, unknown>;

  switch (tool) {
    case "Bash": {
      const cmd = inp.command as string | undefined;
      if (cmd) {
        return cmd.length > 50 ? `${cmd.slice(0, 47)}...` : cmd;
      }
      return "";
    }

    case "Read":
    case "Write":
    case "Edit": {
      const filePath = inp.file_path as string | undefined;
      if (filePath) {
        // Extract filename from path
        const parts = filePath.split("/");
        return parts[parts.length - 1] || filePath;
      }
      return "";
    }

    case "Grep": {
      const pattern = inp.pattern as string | undefined;
      return pattern ? `/${pattern}/` : "";
    }

    case "Glob": {
      const pattern = inp.pattern as string | undefined;
      return pattern || "";
    }

    case "WebSearch": {
      const query = inp.query as string | undefined;
      return query || "";
    }

    case "Task": {
      const desc = inp.description as string | undefined;
      return desc || "";
    }

    case "TodoWrite": {
      const todos = inp.todos as Array<{ content: string }> | undefined;
      if (todos && todos.length > 0) {
        return `${todos.length} item(s)`;
      }
      return "";
    }

    default:
      return "";
  }
}

/**
 * Extract tool name from SessionUpdate.
 * Handles Claude Code's _meta.claudeCode.toolName pattern and MCP prefixes.
 */
function extractToolName(update: Record<string, unknown>): string {
  // Try _meta.claudeCode.toolName first (Claude Code pattern)
  const meta = update._meta as Record<string, unknown> | undefined;
  if (meta) {
    const claudeCode = meta.claudeCode as Record<string, unknown> | undefined;
    if (claudeCode?.toolName) {
      return normalizeTool(claudeCode.toolName as string);
    }
    if (meta.toolName) {
      return normalizeTool(meta.toolName as string);
    }
  }

  // Fall back to name field
  if (update.name) {
    return normalizeTool(update.name as string);
  }

  // Fall back to title
  if (update.title) {
    return normalizeTool(update.title as string);
  }

  return "unknown";
}

/**
 * Normalize tool name by stripping MCP prefixes.
 */
function normalizeTool(name: string): string {
  // Strip mcp__<namespace>__ prefix
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  if (mcpMatch) {
    return mcpMatch[1];
  }
  return name;
}

/**
 * Extract tool output, handling Claude Code's non-standard delivery.
 */
function extractToolOutput(
  update: Record<string, unknown>,
): string | undefined {
  // Try rawOutput first
  if (update.rawOutput !== undefined) {
    return truncateOutput(stringify(update.rawOutput));
  }

  // Try _meta.claudeCode.toolResponse (Claude Code pattern)
  // toolResponse is an object with stdout/stderr, not a string
  const meta = update._meta as Record<string, unknown> | undefined;
  if (meta) {
    const claudeCode = meta.claudeCode as Record<string, unknown> | undefined;
    if (claudeCode?.toolResponse !== undefined) {
      const toolResponse = claudeCode.toolResponse as Record<string, unknown>;
      // Extract stdout, falling back to stringifying the whole response
      if (typeof toolResponse.stdout === "string") {
        const combined =
          toolResponse.stdout +
          (toolResponse.stderr ? `\n${toolResponse.stderr}` : "");
        return truncateOutput(combined.trim());
      }
      return truncateOutput(stringify(toolResponse));
    }
  }

  // Try output field
  if (update.output !== undefined) {
    return truncateOutput(stringify(update.output));
  }

  return undefined;
}

/**
 * Extract original (non-truncated) output for truncation detection.
 */
function extractOriginalOutput(
  update: Record<string, unknown>,
): string | undefined {
  if (update.rawOutput !== undefined) {
    return stringify(update.rawOutput);
  }

  const meta = update._meta as Record<string, unknown> | undefined;
  if (meta) {
    const claudeCode = meta.claudeCode as Record<string, unknown> | undefined;
    if (claudeCode?.toolResponse !== undefined) {
      const toolResponse = claudeCode.toolResponse as Record<string, unknown>;
      if (typeof toolResponse.stdout === "string") {
        return (
          toolResponse.stdout +
          (toolResponse.stderr ? `\n${toolResponse.stderr}` : "")
        ).trim();
      }
    }
  }

  if (update.output !== undefined) {
    return stringify(update.output);
  }

  return undefined;
}

/**
 * Safely stringify a value that may be a string, array of content blocks, or object.
 * Handles ACP tool results delivered as arrays like [{type:'text',text:'...'},...]
 */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    // Array of content blocks: extract .text fields
    const texts = value
      .map((item) =>
        typeof item === "string"
          ? item
          : typeof item === "object" && item !== null && "text" in item
            ? String((item as { text: unknown }).text)
            : JSON.stringify(item),
      )
      .filter(Boolean);
    return texts.join("\n");
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Truncate output to reasonable size.
 */
function truncateOutput(output: string): string {
  const MAX_LINES = 20;
  const MAX_CHARS = 1000;

  const lines = output.split("\n");
  if (lines.length > MAX_LINES) {
    return lines.slice(0, MAX_LINES).join("\n");
  }
  if (output.length > MAX_CHARS) {
    return output.slice(0, MAX_CHARS);
  }
  return output;
}

/**
 * Check if output was truncated.
 */
function wasOutputTruncated(
  original: string | undefined,
  truncated: string | undefined,
): boolean {
  if (!original || !truncated) return false;
  return original.length > truncated.length;
}

// ============================================================================
// Noise Suppression
// ============================================================================

/**
 * Noise patterns to strip from streaming content.
 * These match Claude Code hook warning messages that leak into agent output.
 * Pattern structure handles various noise forms:
 * - "No on[Pre|Post]ToolUseHook found"
 * - "No on[Pre|Post]ToolUseHook found for tool use"
 * - "No on[Pre|Post]ToolUseHook found for tool use ID: toolu_<24 chars>"
 * Tool IDs are exactly 24 base62 characters after "toolu_".
 */
const NOISE_PATTERNS = [
  /No onPostToolUseHook found(?:\s+for\s+tool\s+use(?:\s+ID:\s*toolu_[A-Za-z0-9]{24})?)?/gi,
  /No onPreToolUseHook found(?:\s+for\s+tool\s+use(?:\s+ID:\s*toolu_[A-Za-z0-9]{24})?)?/gi,
];

/**
 * Full noise pattern strings (without tool ID suffix).
 * Used to check if a suffix could be a prefix of a noise pattern.
 */
const NOISE_PATTERN_STRINGS = [
  "No onPostToolUseHook found for tool use ID: toolu_",
  "No onPreToolUseHook found for tool use ID: toolu_",
  "No onPostToolUseHook found for tool use",
  "No onPreToolUseHook found for tool use",
  "No onPostToolUseHook found",
  "No onPreToolUseHook found",
];

// Maximum length to check for potential partial match
const MAX_NOISE_PATTERN_LEN =
  Math.max(...NOISE_PATTERN_STRINGS.map((p) => p.length)) + 24; // +24 for tool ID

/**
 * Check if the content ends with a potential partial noise pattern.
 * Returns the partial match length if found, 0 otherwise.
 *
 * A partial match occurs when:
 * 1. The content ends with something that is a PREFIX of a noise pattern
 *    (e.g., "No on" or "No onPostToolUseHook found"), OR
 * 2. The content ends with a complete noise pattern prefix followed by
 *    a partial tool ID (< 24 chars)
 */
function getPartialNoiseLength(content: string): number {
  // Check suffixes of decreasing length (longer matches first)
  const maxCheck = Math.min(content.length, MAX_NOISE_PATTERN_LEN);

  for (let len = maxCheck; len > 0; len--) {
    const suffix = content.slice(-len);

    for (const pattern of NOISE_PATTERN_STRINGS) {
      // Case 1: suffix is a prefix of a pattern (suffix is shorter than pattern)
      // e.g., suffix="No onPost" is a prefix of pattern="No onPostToolUseHook found..."
      if (suffix.length <= pattern.length && pattern.startsWith(suffix)) {
        return len;
      }

      // Case 2: suffix starts with a complete toolu_ pattern and has partial tool ID
      // e.g., suffix="No onPostToolUseHook found for tool use ID: toolu_ABC123"
      // where the tool ID is < 24 chars
      if (pattern.endsWith("toolu_") && suffix.startsWith(pattern)) {
        const afterToolu = suffix.slice(pattern.length);
        // If tool ID is incomplete (< 24 chars) and valid chars, it's a partial match
        if (afterToolu.length < 24 && /^[A-Za-z0-9]*$/.test(afterToolu)) {
          return len;
        }
      }
    }
  }

  return 0;
}

/**
 * Strip noise patterns from content.
 * Returns the cleaned content, or null if nothing remains after stripping.
 * Preserves whitespace-only chunks that aren't noise to maintain streaming formatting.
 */
function stripNoise(content: string): string | null {
  let cleaned = content;
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  // If nothing was stripped, return original (preserves pure whitespace chunks)
  if (cleaned === content) {
    return content;
  }

  // Something was stripped - return cleaned if non-empty, null otherwise
  return cleaned.length > 0 ? cleaned : null;
}

// ============================================================================
// Translator Implementation
// ============================================================================

interface TranslatorState {
  sessionStart: number;
  activeMessage: {
    type: "agent_message" | "agent_thought";
    content: string;
  } | null;
  pendingTools: Map<
    string,
    { tool: string; input: unknown; startTime: number }
  >;
  /**
   * Buffer for potential partial noise at chunk boundaries.
   * When a chunk ends with what might be the start of a noise pattern,
   * we hold it here until the next chunk arrives.
   */
  noiseBuffer: string;
}

export function createTranslator(): RalphTranslator {
  const state: TranslatorState = {
    sessionStart: Date.now(),
    activeMessage: null,
    pendingTools: new Map(),
    noiseBuffer: "",
  };

  function getTimestamp(): number {
    return Date.now() - state.sessionStart;
  }

  /**
   * Process a text chunk with boundary-aware noise stripping.
   * Returns the safe content to emit, and updates the noise buffer.
   * Returns null if the entire chunk should be suppressed.
   *
   * The key insight is that we need to check for partial noise patterns
   * BEFORE stripping, because partial patterns won't match the full regex
   * and could leave fragments behind.
   */
  function processChunkWithBuffer(text: string): string | null {
    // Combine buffer with new text
    const combined = state.noiseBuffer + text;
    state.noiseBuffer = "";

    // First, check if the combined content ends with a partial noise pattern
    // This must happen BEFORE stripping, because partial patterns at the end
    // won't match the regex and could leave fragments
    const partialLen = getPartialNoiseLength(combined);
    if (partialLen > 0) {
      // Buffer the potential partial match
      state.noiseBuffer = combined.slice(-partialLen);
      const safeContent = combined.slice(0, -partialLen);

      // Strip complete noise patterns from the safe content
      const cleaned = stripNoise(safeContent);
      if (cleaned === null || cleaned.length === 0) {
        return null;
      }
      return cleaned;
    }

    // No partial match at the end - strip complete patterns
    const cleaned = stripNoise(combined);
    if (cleaned === null) {
      return null;
    }

    return cleaned;
  }

  /**
   * Flush any remaining buffer content at finalization.
   * Strips any complete noise patterns from the buffer.
   */
  function flushBuffer(): string {
    const buffered = state.noiseBuffer;
    state.noiseBuffer = "";
    // Strip any complete noise from the buffer
    const cleaned = stripNoise(buffered);
    return cleaned ?? "";
  }

  function translate(update: SessionUpdate): RalphEvent | null {
    const updateType = update.sessionUpdate;
    const timestamp = getTimestamp();

    switch (updateType) {
      // ─── Content Chunks ─────────────────────────────────────────────────────
      case "agent_message_chunk": {
        const content = (
          update as { content?: { type: string; text?: string } }
        ).content;
        if (content?.type === "text" && typeof content.text === "string") {
          // Empty string signals finalization
          if (content.text === "") {
            if (state.activeMessage?.type === "agent_message") {
              // Flush buffer and strip noise from accumulated content
              const buffered = flushBuffer();
              const combined = state.activeMessage.content + buffered;
              const finalContent = stripNoise(combined);
              state.activeMessage = null;
              if (finalContent === null || finalContent.trim() === "") {
                return null;
              }
              return {
                type: "agent_message",
                timestamp,
                data: {
                  kind: "agent_message",
                  content: finalContent,
                  isStreaming: false,
                },
              };
            }
            return null;
          }

          // Process chunk with boundary-aware noise stripping
          const cleanedText = processChunkWithBuffer(content.text);
          if (cleanedText === null) {
            return null;
          }

          // Accumulate content
          if (state.activeMessage?.type === "agent_message") {
            state.activeMessage.content += cleanedText;
          } else {
            state.activeMessage = {
              type: "agent_message",
              content: cleanedText,
            };
          }

          return {
            type: "agent_message",
            timestamp,
            data: {
              kind: "agent_message",
              content: cleanedText,
              isStreaming: true,
            },
          };
        }
        return null;
      }

      case "agent_thought_chunk": {
        const content = (
          update as { content?: { type: string; text?: string } }
        ).content;
        if (content?.type === "text" && typeof content.text === "string") {
          if (content.text === "") {
            if (state.activeMessage?.type === "agent_thought") {
              // Flush buffer and strip noise from accumulated content
              const buffered = flushBuffer();
              const combined = state.activeMessage.content + buffered;
              const finalContent = stripNoise(combined);
              state.activeMessage = null;
              if (finalContent === null || finalContent.trim() === "") {
                return null;
              }
              return {
                type: "agent_thought",
                timestamp,
                data: {
                  kind: "agent_thought",
                  content: finalContent,
                  isStreaming: false,
                },
              };
            }
            return null;
          }

          // Process chunk with boundary-aware noise stripping
          const cleanedText = processChunkWithBuffer(content.text);
          if (cleanedText === null) {
            return null;
          }

          if (state.activeMessage?.type === "agent_thought") {
            state.activeMessage.content += cleanedText;
          } else {
            state.activeMessage = {
              type: "agent_thought",
              content: cleanedText,
            };
          }

          return {
            type: "agent_thought",
            timestamp,
            data: {
              kind: "agent_thought",
              content: cleanedText,
              isStreaming: true,
            },
          };
        }
        return null;
      }

      case "user_message_chunk": {
        // User messages are typically the prompt we sent, skip display
        return null;
      }

      // ─── Tool Events ────────────────────────────────────────────────────────
      case "tool_call": {
        const u = update as Record<string, unknown>;
        const toolCallId = (u.tool_call_id || u.toolCallId || u.id) as string;
        const tool = extractToolName(u);
        const input = u.rawInput || u.input || u.params || {};
        const summary = getToolSummary(tool, input);

        // Check if this is an update to an existing tool call (phased events)
        const existing = state.pendingTools.get(toolCallId);
        if (existing) {
          // Update existing entry with new input if present
          const hadSummary = getToolSummary(existing.tool, existing.input);
          existing.input = input;
          existing.tool = tool;

          // Only emit update if we now have a summary we didn't have before
          if (summary && !hadSummary) {
            return {
              type: "tool_update",
              timestamp,
              data: {
                kind: "tool_update",
                toolCallId,
                tool,
                status: "pending" as const,
                summary,
              },
            };
          }
          // No meaningful change, suppress event
          return null;
        }

        // First time seeing this tool_call_id - create entry and emit tool_start
        state.pendingTools.set(toolCallId, {
          tool,
          input,
          startTime: timestamp,
        });

        return {
          type: "tool_start",
          timestamp,
          data: {
            kind: "tool_start",
            toolCallId,
            tool,
            summary,
            input,
          },
        };
      }

      case "tool_call_update": {
        const u = update as Record<string, unknown>;
        const toolCallId = (u.tool_call_id || u.toolCallId || u.id) as string;
        const status = u.status as string | undefined;
        const pending = state.pendingTools.get(toolCallId);
        const tool = pending?.tool || extractToolName(u);

        // Check if rawInput arrived with this update (phased event pattern)
        const newInput = u.rawInput || u.input || u.params;
        if (newInput && pending) {
          const oldSummary = getToolSummary(pending.tool, pending.input);
          const newSummary = getToolSummary(tool, newInput);
          if (newSummary && !oldSummary) {
            // Input became available - update pending entry and emit summary
            pending.input = newInput;
            pending.tool = tool;
            return {
              type: "tool_update",
              timestamp,
              data: {
                kind: "tool_update",
                toolCallId,
                tool,
                status: "pending" as const,
                summary: newSummary,
              },
            };
          }
          // Update the pending entry even if summary didn't change
          pending.input = newInput;
        }

        // Non-terminal status update
        if (
          status === "pending" ||
          status === "in_progress" ||
          status === "running"
        ) {
          return {
            type: "tool_update",
            timestamp,
            data: {
              kind: "tool_update",
              toolCallId,
              tool,
              status:
                status === "in_progress"
                  ? "running"
                  : (status as "pending" | "running"),
            },
          };
        }

        // Terminal status - treat as result
        if (
          status === "completed" ||
          status === "failed" ||
          status === "cancelled"
        ) {
          const rawOutput = extractToolOutput(u);
          const originalOutput = extractOriginalOutput(u);
          state.pendingTools.delete(toolCallId);

          return {
            type: "tool_result",
            timestamp,
            data: {
              kind: "tool_result",
              toolCallId,
              tool,
              status,
              output: rawOutput,
              truncated: wasOutputTruncated(originalOutput, rawOutput),
            },
          };
        }

        return null;
      }

      // Note: 'status' is not a SessionUpdate type in the ACP spec.
      // Status changes come through other mechanisms (e.g., prompt completion).

      default:
        // Unknown update type - ignore
        return null;
    }
  }

  function finalize(): RalphEvent | null {
    if (state.activeMessage) {
      // Flush buffer and strip noise from accumulated content
      const buffered = flushBuffer();
      const combined = state.activeMessage.content + buffered;
      const finalContent = stripNoise(combined);
      const type = state.activeMessage.type;
      state.activeMessage = null;
      if (finalContent === null || finalContent.trim() === "") {
        return null;
      }
      return {
        type,
        timestamp: getTimestamp(),
        data: {
          kind: type,
          content: finalContent,
          isStreaming: false,
        } as AgentMessageData | AgentThoughtData,
      };
    }
    return null;
  }

  return { translate, finalize };
}
