/**
 * Shared Session Event Field Extraction
 *
 * Provides unified field extraction logic for tool call events, handling
 * both ACP format (data IS the SessionUpdate directly) and legacy format
 * (data wraps the update at data.update).
 *
 * Used by parseEventsToBlocks (HTTP/historical), incrementalBlockUpdate (WS/live),
 * deduplicatePhasedToolCalls, computeToolUsageStats, and other store functions.
 *
 * AC: @ws-session-event-streaming ac-unified-event-parsing
 */

/**
 * Unwrap the SessionUpdate from a session.update event's data field.
 *
 * ACP format: data IS the SessionUpdate (data.sessionUpdate exists).
 * Legacy format: data wraps the update (data.update.sessionUpdate exists).
 *
 * Returns the unwrapped update object, or undefined if neither format matches.
 */
export function unwrapSessionUpdate(
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  if (data.sessionUpdate) return data;
  const nested = data.update;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Extract tool call identification and input fields from a SessionUpdate.
 *
 * Resolves field name variations across ACP versions:
 * - toolCallId: toolCallId | tool_call_id | id
 * - toolName: title | tool | toolName | name
 * - rawInput: rawInput | input
 */
export function extractToolCallFields(update: Record<string, unknown>): {
  toolCallId: string;
  toolName: string;
  rawInput: unknown;
} {
  const toolCallId = (update.toolCallId ?? update.tool_call_id ?? update.id ?? "") as string;
  const toolName = (update.title ?? update.tool ?? update.toolName ?? update.name ?? "unknown") as string;
  const rawInput = update.rawInput ?? update.input;
  return { toolCallId, toolName, rawInput };
}

/**
 * Extract tool call result fields from a SessionUpdate (tool_call_update / tool_result).
 *
 * Resolves field name variations:
 * - rawOutput: rawOutput | output | content
 * - status: ACP status field or legacy error/isError flags
 * - rawInput: optional updated input from phased tool calls
 */
export function extractToolCallResult(update: Record<string, unknown>): {
  rawOutput: unknown;
  status: string | undefined;
  isError: boolean;
  rawInput: unknown;
} {
  const rawOutput = update.rawOutput ?? update.output ?? update.content;
  const status = update.status as string | undefined;
  const isError = !!(update.error || update.isError);
  const rawInput = update.rawInput;
  return { rawOutput, status, isError, rawInput };
}

/**
 * Extract the tool name from event data, checking both direct fields
 * and _meta.claudeCode.toolName (used by older Claude Code adapters).
 */
export function extractToolName(update: Record<string, unknown>): string {
  // Prefer direct title field (ACP standard)
  const direct = (update.title ?? update.tool ?? update.toolName ?? update.name) as string | undefined;
  if (direct) return direct;

  // Fallback: _meta.claudeCode.toolName
  const meta = update._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const claudeCode = (meta as Record<string, unknown>).claudeCode;
    if (claudeCode && typeof claudeCode === "object" && !Array.isArray(claudeCode)) {
      const toolName = (claudeCode as Record<string, unknown>).toolName;
      if (typeof toolName === "string") return toolName;
    }
  }

  return "unknown";
}

/**
 * Check whether a rawInput value is "populated" (non-empty object with keys).
 */
export function isPopulatedInput(rawInput: unknown): boolean {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return false;
  return Object.keys(rawInput as Record<string, unknown>).length > 0;
}
