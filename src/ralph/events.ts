/**
 * Ralph Event System
 *
 * Translates ACP SessionUpdate events into structured RalphEvents.
 * This layer is pure data - no rendering concerns. Enables future
 * TUI or other renderers to consume the same event stream.
 */

import type { SessionUpdate } from '../acp/types.js';

// ============================================================================
// Event Types
// ============================================================================

export type RalphEventType =
  | 'agent_message'
  | 'agent_thought'
  | 'tool_start'
  | 'tool_update'
  | 'tool_result'
  | 'status';

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
  kind: 'agent_message';
  content: string;
  isStreaming: boolean;
}

export interface AgentThoughtData {
  kind: 'agent_thought';
  content: string;
  isStreaming: boolean;
}

export interface ToolStartData {
  kind: 'tool_start';
  toolCallId: string;
  tool: string;
  summary: string;
  input: unknown;
}

export interface ToolUpdateData {
  kind: 'tool_update';
  toolCallId: string;
  tool: string;
  status: 'pending' | 'running';
}

export interface ToolResultData {
  kind: 'tool_result';
  toolCallId: string;
  tool: string;
  status: 'completed' | 'failed' | 'cancelled';
  output?: string;
  truncated: boolean;
}

export interface StatusData {
  kind: 'status';
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
    case 'Bash': {
      const cmd = inp.command as string | undefined;
      if (cmd) {
        return cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd;
      }
      return '';
    }

    case 'Read':
    case 'Write':
    case 'Edit': {
      const filePath = inp.file_path as string | undefined;
      if (filePath) {
        // Extract filename from path
        const parts = filePath.split('/');
        return parts[parts.length - 1] || filePath;
      }
      return '';
    }

    case 'Grep': {
      const pattern = inp.pattern as string | undefined;
      return pattern ? `/${pattern}/` : '';
    }

    case 'Glob': {
      const pattern = inp.pattern as string | undefined;
      return pattern || '';
    }

    case 'WebSearch': {
      const query = inp.query as string | undefined;
      return query || '';
    }

    case 'Task': {
      const desc = inp.description as string | undefined;
      return desc || '';
    }

    case 'TodoWrite': {
      const todos = inp.todos as Array<{ content: string }> | undefined;
      if (todos && todos.length > 0) {
        return `${todos.length} item(s)`;
      }
      return '';
    }

    default:
      return '';
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

  return 'unknown';
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
function extractToolOutput(update: Record<string, unknown>): string | undefined {
  // Try rawOutput first
  if (update.rawOutput !== undefined) {
    return truncateOutput(String(update.rawOutput));
  }

  // Try _meta.claudeCode.toolResponse (Claude Code pattern)
  const meta = update._meta as Record<string, unknown> | undefined;
  if (meta) {
    const claudeCode = meta.claudeCode as Record<string, unknown> | undefined;
    if (claudeCode?.toolResponse !== undefined) {
      return truncateOutput(String(claudeCode.toolResponse));
    }
  }

  // Try output field
  if (update.output !== undefined) {
    return truncateOutput(String(update.output));
  }

  return undefined;
}

/**
 * Truncate output to reasonable size.
 */
function truncateOutput(output: string): string {
  const MAX_LINES = 20;
  const MAX_CHARS = 1000;

  const lines = output.split('\n');
  if (lines.length > MAX_LINES) {
    return lines.slice(0, MAX_LINES).join('\n');
  }
  if (output.length > MAX_CHARS) {
    return output.slice(0, MAX_CHARS);
  }
  return output;
}

/**
 * Check if output was truncated.
 */
function wasOutputTruncated(original: string | undefined, truncated: string | undefined): boolean {
  if (!original || !truncated) return false;
  return original.length > truncated.length;
}

// ============================================================================
// Noise Suppression
// ============================================================================

const SUPPRESSED_PATTERNS = [
  /No onPostToolUseHook found/i,
  /No onPreToolUseHook found/i,
];

/**
 * Check if a message should be suppressed from display.
 */
function shouldSuppress(content: string): boolean {
  return SUPPRESSED_PATTERNS.some((pattern) => pattern.test(content));
}

// ============================================================================
// Translator Implementation
// ============================================================================

interface TranslatorState {
  sessionStart: number;
  activeMessage: { type: 'agent_message' | 'agent_thought'; content: string } | null;
  pendingTools: Map<string, { tool: string; input: unknown; startTime: number }>;
}

export function createTranslator(): RalphTranslator {
  const state: TranslatorState = {
    sessionStart: Date.now(),
    activeMessage: null,
    pendingTools: new Map(),
  };

  function getTimestamp(): number {
    return Date.now() - state.sessionStart;
  }

  function translate(update: SessionUpdate): RalphEvent | null {
    const updateType = update.sessionUpdate;
    const timestamp = getTimestamp();

    switch (updateType) {
      // ─── Content Chunks ─────────────────────────────────────────────────────
      case 'agent_message_chunk': {
        const content = (update as { content?: { type: string; text?: string } }).content;
        if (content?.type === 'text' && typeof content.text === 'string') {
          // Check for noise
          if (shouldSuppress(content.text)) {
            return null;
          }

          // Empty string signals finalization
          if (content.text === '') {
            if (state.activeMessage?.type === 'agent_message') {
              const final: RalphEvent = {
                type: 'agent_message',
                timestamp,
                data: {
                  kind: 'agent_message',
                  content: state.activeMessage.content,
                  isStreaming: false,
                },
              };
              state.activeMessage = null;
              return final;
            }
            return null;
          }

          // Accumulate content
          if (state.activeMessage?.type === 'agent_message') {
            state.activeMessage.content += content.text;
          } else {
            state.activeMessage = { type: 'agent_message', content: content.text };
          }

          return {
            type: 'agent_message',
            timestamp,
            data: {
              kind: 'agent_message',
              content: content.text,
              isStreaming: true,
            },
          };
        }
        return null;
      }

      case 'agent_thought_chunk': {
        const content = (update as { content?: { type: string; text?: string } }).content;
        if (content?.type === 'text' && typeof content.text === 'string') {
          if (shouldSuppress(content.text)) {
            return null;
          }

          if (content.text === '') {
            if (state.activeMessage?.type === 'agent_thought') {
              const final: RalphEvent = {
                type: 'agent_thought',
                timestamp,
                data: {
                  kind: 'agent_thought',
                  content: state.activeMessage.content,
                  isStreaming: false,
                },
              };
              state.activeMessage = null;
              return final;
            }
            return null;
          }

          if (state.activeMessage?.type === 'agent_thought') {
            state.activeMessage.content += content.text;
          } else {
            state.activeMessage = { type: 'agent_thought', content: content.text };
          }

          return {
            type: 'agent_thought',
            timestamp,
            data: {
              kind: 'agent_thought',
              content: content.text,
              isStreaming: true,
            },
          };
        }
        return null;
      }

      case 'user_message_chunk': {
        // User messages are typically the prompt we sent, skip display
        return null;
      }

      // ─── Tool Events ────────────────────────────────────────────────────────
      case 'tool_call': {
        const u = update as Record<string, unknown>;
        const toolCallId = (u.tool_call_id || u.toolCallId || u.id) as string;
        const tool = extractToolName(u);
        const input = u.input || u.params || {};

        state.pendingTools.set(toolCallId, { tool, input, startTime: timestamp });

        return {
          type: 'tool_start',
          timestamp,
          data: {
            kind: 'tool_start',
            toolCallId,
            tool,
            summary: getToolSummary(tool, input),
            input,
          },
        };
      }

      case 'tool_call_update': {
        const u = update as Record<string, unknown>;
        const toolCallId = (u.tool_call_id || u.toolCallId || u.id) as string;
        const status = u.status as string | undefined;
        const pending = state.pendingTools.get(toolCallId);
        const tool = pending?.tool || extractToolName(u);

        // Non-terminal status update
        if (status === 'pending' || status === 'in_progress' || status === 'running') {
          return {
            type: 'tool_update',
            timestamp,
            data: {
              kind: 'tool_update',
              toolCallId,
              tool,
              status: status === 'in_progress' ? 'running' : (status as 'pending' | 'running'),
            },
          };
        }

        // Terminal status - treat as result
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          const rawOutput = extractToolOutput(u);
          const originalOutput = (u.rawOutput || u.output) as string | undefined;
          state.pendingTools.delete(toolCallId);

          return {
            type: 'tool_result',
            timestamp,
            data: {
              kind: 'tool_result',
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
      const final: RalphEvent = {
        type: state.activeMessage.type,
        timestamp: getTimestamp(),
        data: {
          kind: state.activeMessage.type,
          content: state.activeMessage.content,
          isStreaming: false,
        } as AgentMessageData | AgentThoughtData,
      };
      state.activeMessage = null;
      return final;
    }
    return null;
  }

  return { translate, finalize };
}
