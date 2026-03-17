/**
 * Session stream utility functions.
 *
 * Parses raw session events from events.jsonl into structured display blocks.
 *
 * AC: @ui-session-stream ac-1 — Structured event blocks
 */

import type { SessionEvent } from '$lib/api';

export type BlockType = 'message' | 'tool_call' | 'tool_result' | 'thinking' | 'system';

export interface MessageBlock {
	type: 'message';
	content: string;
	timestamp: number;
	seq: number;
	isStreaming?: boolean;
}

export interface ToolCallBlock {
	type: 'tool_call';
	toolName: string;
	toolCallId: string;
	input: unknown;
	output?: unknown;
	status: 'pending' | 'running' | 'completed' | 'failed';
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
	seq: number;
	/** Seq of the result/completion event (for on-demand output fetching). */
	resultSeq?: number;
}

export interface ThinkingBlock {
	type: 'thinking';
	content: string;
	timestamp: number;
	seq: number;
	isStreaming?: boolean;
}

export interface SystemBlock {
	type: 'system';
	label: string;
	detail?: string;
	timestamp: number;
	seq: number;
}

export type DisplayBlock = MessageBlock | ToolCallBlock | ThinkingBlock | SystemBlock;

/**
 * Tool name to icon mapping.
 */
const TOOL_ICONS: Record<string, string> = {
	Read: '\u{1F4C4}',
	Write: '\u{270F}\u{FE0F}',
	Edit: '\u{270F}\u{FE0F}',
	Bash: '$',
	Grep: '\u{1F50D}',
	Glob: '\u{1F4C1}',
	WebFetch: '\u{1F310}',
	WebSearch: '\u{1F310}',
	Task: '\u{1F916}',
	TodoWrite: '\u{2705}',
	NotebookEdit: '\u{1F4D3}',
};

export function getToolIcon(toolName: string): string {
	return TOOL_ICONS[toolName] ?? '\u{1F527}';
}

/**
 * Extract a short preview of tool input for collapsed display.
 */
export function getToolInputPreview(toolName: string, input: unknown): string {
	if (!input || typeof input !== 'object') return '';
	const obj = input as Record<string, unknown>;

	if (obj.command && typeof obj.command === 'string') {
		return truncate(obj.command, 80);
	}
	if (obj.file_path && typeof obj.file_path === 'string') {
		return String(obj.file_path);
	}
	if (obj.pattern && typeof obj.pattern === 'string') {
		return `pattern: ${truncate(String(obj.pattern), 60)}`;
	}
	if (obj.query && typeof obj.query === 'string') {
		return truncate(String(obj.query), 80);
	}
	if (obj.content && typeof obj.content === 'string') {
		return truncate(String(obj.content), 80);
	}

	const keys = Object.keys(obj);
	if (keys.length <= 3) return keys.join(', ');
	return `${keys.length} params`;
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return str.slice(0, max) + '\u2026';
}

// ─── Shared field extraction helpers ────────────────────────────────────────
// Mirrors src/agent-runtime/session-event-fields.ts for the web-ui context.
// AC: @ws-session-event-streaming ac-unified-event-parsing

/**
 * Unwrap the SessionUpdate from a session.update event's data field.
 * ACP format: data.sessionUpdate exists (data IS the update).
 * Legacy format: data.update.sessionUpdate exists (data wraps the update).
 */
function unwrapSessionUpdate(
	data: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
	if (!data) return undefined;
	if (data.sessionUpdate) return data;
	const nested = data.update;
	if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
		return nested as Record<string, unknown>;
	}
	return undefined;
}

/**
 * Extract tool call identification and input fields from a SessionUpdate.
 * Field resolution order matches session-event-fields.ts.
 */
function extractToolCallFields(update: Record<string, unknown>): {
	toolCallId: string;
	toolName: string;
	rawInput: unknown;
} {
	const toolCallId = (update.toolCallId ?? update.tool_call_id ?? update.id ?? '') as string;
	const toolName = (update.title ?? update.tool ?? update.toolName ?? update.name ?? 'unknown') as string;
	const rawInput = update.rawInput ?? update.input;
	return { toolCallId, toolName, rawInput };
}

/**
 * Extract tool call result fields from a SessionUpdate.
 * Field resolution order matches session-event-fields.ts.
 */
function extractToolCallResult(update: Record<string, unknown>): {
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
 * Extract text content from an ACP SessionUpdate.
 *
 * ACP ContentChunk format: { content: { type: 'text', text: '...' } }
 * Legacy format: { text: '...' } or { content: '...' }
 */
function extractTextContent(update: Record<string, unknown>): string {
	// ACP ContentChunk: content is an object with type + text
	const content = update.content;
	if (content && typeof content === 'object') {
		const block = content as Record<string, unknown>;
		if (block.type === 'text' && typeof block.text === 'string') {
			return block.text;
		}
	}
	// Legacy: flat text or string content field
	if (typeof update.text === 'string') return update.text;
	if (typeof content === 'string') return content;
	return '';
}

/**
 * Parse raw session events into structured display blocks.
 *
 * Supports both ACP format (data IS the SessionUpdate directly) and
 * legacy format (data wraps the update at data.update).
 *
 * AC: @ui-session-stream ac-1
 */
export function parseEventsToBlocks(events: SessionEvent[]): DisplayBlock[] {
	const blocks: DisplayBlock[] = [];
	const toolCalls = new Map<string, ToolCallBlock>();

	for (const event of events) {
		const data = event.data as Record<string, unknown> | null;
		if (!data) continue;

		switch (event.type) {
			case 'session.start': {
				blocks.push({
					type: 'system',
					label: 'Session started',
					detail: data.agent_type ? `Agent: ${data.agent_type}` : undefined,
					timestamp: event.ts,
					seq: event.seq,
				});
				break;
			}

			case 'session.end':
			case 'session.wrapup': {
				blocks.push({
					type: 'system',
					label: event.type === 'session.end' ? 'Session ended' : 'Session wrapping up',
					detail: data.reason ? String(data.reason) : undefined,
					timestamp: event.ts,
					seq: event.seq,
				});
				break;
			}

			case 'session.update': {
				// AC: @ws-session-event-streaming ac-unified-event-parsing
				const update = unwrapSessionUpdate(data);
				if (!update) break;

				const sessionUpdate = update.sessionUpdate as string | undefined;

				if (
					sessionUpdate === 'agent_message_chunk' ||
					sessionUpdate === 'assistant_text' ||
					sessionUpdate === 'assistant'
				) {
					const content = extractTextContent(update);
					if (content) {
						// Merge consecutive message blocks
						const lastBlock = blocks[blocks.length - 1];
						if (lastBlock?.type === 'message') {
							lastBlock.content += content;
						} else {
							blocks.push({
								type: 'message',
								content,
								timestamp: event.ts,
								seq: event.seq,
							});
						}
					}
				} else if (
					sessionUpdate === 'agent_thought_chunk' ||
					sessionUpdate === 'thinking' ||
					sessionUpdate === 'assistant_thinking'
				) {
					const content = extractTextContent(update);
					if (content) {
						const lastBlock = blocks[blocks.length - 1];
						if (lastBlock?.type === 'thinking') {
							lastBlock.content += content;
						} else {
							blocks.push({
								type: 'thinking',
								content,
								timestamp: event.ts,
								seq: event.seq,
							});
						}
					}
				} else if (sessionUpdate === 'tool_call') {
					const { toolCallId, toolName, rawInput } = extractToolCallFields(update);

					const block: ToolCallBlock = {
						type: 'tool_call',
						toolName,
						toolCallId,
						input: rawInput,
						status: 'running',
						startedAt: event.ts,
						seq: event.seq,
					};

					toolCalls.set(toolCallId, block);
					blocks.push(block);
				} else if (sessionUpdate === 'tool_call_update' || sessionUpdate === 'tool_result') {
					const { toolCallId } = extractToolCallFields(update);
					const existing = toolCalls.get(toolCallId);

					if (existing) {
						const result = extractToolCallResult(update);
						if (result.rawOutput !== undefined) {
							existing.output = result.rawOutput;
							existing.resultSeq = event.seq;
						}
						if (result.status === 'completed' || result.status === 'failed') {
							existing.status = result.status;
							existing.completedAt = event.ts;
							existing.durationMs = event.ts - existing.startedAt;
						} else if (result.isError) {
							existing.status = 'failed';
							existing.completedAt = event.ts;
							existing.durationMs = event.ts - existing.startedAt;
						} else if (sessionUpdate === 'tool_result') {
							existing.status = 'completed';
							existing.completedAt = event.ts;
							existing.durationMs = event.ts - existing.startedAt;
						}
						if (!existing.resultSeq) {
							existing.resultSeq = event.seq;
						}
						// Update rawInput if provided (ACP phased tool calls)
						if (result.rawInput !== undefined) {
							existing.input = result.rawInput;
						}
					}
				}
				break;
			}

			case 'tool.call': {
				const toolName = (data.tool ?? data.name ?? 'unknown') as string;
				const toolCallId = (data.toolCallId ?? data.tool_call_id ?? data.id ?? `tool-${event.seq}`) as string;

				const block: ToolCallBlock = {
					type: 'tool_call',
					toolName,
					toolCallId,
					input: data.input ?? data.rawInput ?? data.args,
					status: 'running',
					startedAt: event.ts,
					seq: event.seq,
				};

				toolCalls.set(toolCallId, block);
				blocks.push(block);
				break;
			}

			case 'tool.result': {
				const toolCallId = (data.toolCallId ?? data.tool_call_id ?? data.id ?? '') as string;
				const existing = toolCalls.get(toolCallId);

				if (existing) {
					existing.output = data.output ?? data.rawOutput ?? data.content;
					existing.status = (data.error || data.isError) ? 'failed' : 'completed';
					existing.completedAt = event.ts;
					existing.durationMs = event.ts - existing.startedAt;
					existing.resultSeq = event.seq;
				}
				break;
			}

			case 'note': {
				blocks.push({
					type: 'system',
					label: 'Note',
					detail: typeof data.message === 'string' ? data.message : JSON.stringify(data),
					timestamp: event.ts,
					seq: event.seq,
				});
				break;
			}

			case 'agent.dispatched':
			case 'agent.started':
			case 'agent.completed':
			case 'agent.failed':
			case 'agent.timeout': {
				const labelMap: Record<string, string> = {
					'agent.dispatched': 'Agent dispatched',
					'agent.started': 'Agent started',
					'agent.completed': 'Agent completed',
					'agent.failed': 'Agent failed',
					'agent.timeout': 'Agent timed out',
				};
				blocks.push({
					type: 'system',
					label: labelMap[event.type] ?? event.type,
					detail: data.task_ref ? `Task: ${data.task_ref}` : undefined,
					timestamp: event.ts,
					seq: event.seq,
				});
				break;
			}

			case 'prompt.sent': {
				const phase = data.phase as string | undefined;
				const iteration = data.iteration as number | undefined;
				if (phase) {
					blocks.push({
						type: 'system',
						label: `Iteration ${iteration ?? '?'}`,
						detail: `Phase: ${phase}`,
						timestamp: event.ts,
						seq: event.seq,
					});
				}
				break;
			}

			case 'iteration.timeout': {
				blocks.push({
					type: 'system',
					label: 'Iteration timeout',
					timestamp: event.ts,
					seq: event.seq,
				});
				break;
			}
		}
	}

	return blocks;
}

/**
 * Apply a WebSocket session event to an existing block list incrementally.
 * Returns a new array (shallow copy) with the event applied.
 *
 * AC: @ws-session-event-streaming ac-message-start
 * AC: @ws-session-event-streaming ac-message-progress
 * AC: @ws-session-event-streaming ac-message-complete
 * AC: @ws-session-event-streaming ac-tool-call-start
 * AC: @ws-session-event-streaming ac-tool-call-complete
 * AC: @ws-session-event-streaming ac-thinking-blocks
 */
export function incrementalBlockUpdate(
	blocks: DisplayBlock[],
	eventType: string,
	data: Record<string, unknown>,
): DisplayBlock[] {
	const result = [...blocks];

	switch (eventType) {
		case 'message_start': {
			// AC: @ws-session-event-streaming ac-message-start — writing indicator
			result.push({
				type: 'message',
				content: '',
				timestamp: (data.timestamp as number) ?? Date.now(),
				seq: -1, // WS events don't have JSONL seq; will be reconciled on HTTP catch-up
				isStreaming: true,
			});
			break;
		}

		case 'message_progress': {
			// AC: @ws-session-event-streaming ac-message-progress — append text at newline boundaries
			const text = (data.text as string) ?? '';
			const lastBlock = result[result.length - 1];
			if (lastBlock?.type === 'message' && lastBlock.isStreaming) {
				// Mutate-in-place for the copy — spread a new object
				result[result.length - 1] = { ...lastBlock, content: lastBlock.content + text };
			} else {
				// No existing streaming message — create one
				result.push({
					type: 'message',
					content: text,
					timestamp: (data.timestamp as number) ?? Date.now(),
					seq: -1,
					isStreaming: true,
				});
			}
			break;
		}

		case 'message_complete': {
			// AC: @ws-session-event-streaming ac-message-complete — flush remaining text, remove indicator
			const text = (data.text as string) ?? '';
			const lastBlock = result[result.length - 1];
			if (lastBlock?.type === 'message' && lastBlock.isStreaming) {
				result[result.length - 1] = {
					...lastBlock,
					content: lastBlock.content + text,
					isStreaming: false,
				};
			} else if (text) {
				result.push({
					type: 'message',
					content: text,
					timestamp: (data.timestamp as number) ?? Date.now(),
					seq: -1,
				});
			}
			break;
		}

		case 'thinking_start': {
			// AC: @ws-session-event-streaming ac-thinking-blocks — thinking indicator
			result.push({
				type: 'thinking',
				content: '',
				timestamp: (data.timestamp as number) ?? Date.now(),
				seq: -1,
				isStreaming: true,
			});
			break;
		}

		case 'thinking_progress': {
			const text = (data.text as string) ?? '';
			const lastBlock = result[result.length - 1];
			if (lastBlock?.type === 'thinking' && lastBlock.isStreaming) {
				result[result.length - 1] = { ...lastBlock, content: lastBlock.content + text };
			} else {
				result.push({
					type: 'thinking',
					content: text,
					timestamp: (data.timestamp as number) ?? Date.now(),
					seq: -1,
					isStreaming: true,
				});
			}
			break;
		}

		case 'thinking_complete': {
			const text = (data.text as string) ?? '';
			const lastBlock = result[result.length - 1];
			if (lastBlock?.type === 'thinking' && lastBlock.isStreaming) {
				result[result.length - 1] = {
					...lastBlock,
					content: lastBlock.content + text,
					isStreaming: false,
				};
			} else if (text) {
				result.push({
					type: 'thinking',
					content: text,
					timestamp: (data.timestamp as number) ?? Date.now(),
					seq: -1,
				});
			}
			break;
		}

		case 'tool_call_start': {
			// AC: @ws-session-event-streaming ac-tool-call-start — running state with name + input
			const toolCallId = (data.tool_call_id as string) ?? '';
			const toolName = (data.tool_name as string) ?? 'unknown';
			result.push({
				type: 'tool_call',
				toolName,
				toolCallId,
				input: data.tool_input,
				status: 'running',
				startedAt: (data.timestamp as number) ?? Date.now(),
				seq: -1,
			});
			break;
		}

		case 'tool_call_input': {
			// AC: @ws-session-event-streaming ac-tool-input-update — update input in-place from phased event
			const toolCallId = (data.tool_call_id as string) ?? '';
			const idx = result.findLastIndex(
				(b) => b.type === 'tool_call' && b.toolCallId === toolCallId
			);
			if (idx !== -1) {
				const existing = result[idx] as ToolCallBlock;
				result[idx] = {
					...existing,
					input: data.tool_input,
				};
			}
			break;
		}

		case 'tool_call_complete': {
			// AC: @ws-session-event-streaming ac-tool-call-complete — update status and duration
			const toolCallId = (data.tool_call_id as string) ?? '';
			const idx = result.findLastIndex(
				(b) => b.type === 'tool_call' && b.toolCallId === toolCallId
			);
			if (idx !== -1) {
				const existing = result[idx] as ToolCallBlock;
				result[idx] = {
					...existing,
					status: (data.status as string) === 'failed' ? 'failed' : 'completed',
					durationMs: (data.duration_ms as number) ?? undefined,
					completedAt: (data.timestamp as number) ?? Date.now(),
				};
			}
			break;
		}
	}

	return result;
}

/**
 * Strip tool output from display blocks for on-demand loading.
 * Used for both historical playback and live session catch-up to ensure
 * consistent UX where tool output is always fetched on expand.
 *
 * AC: @ws-session-event-streaming ac-historical-playback
 * AC: @ws-session-event-streaming ac-tool-output-on-demand
 */
export function stripToolOutput(blocks: DisplayBlock[]): DisplayBlock[] {
	return blocks.map((block) => {
		if (block.type === 'tool_call' && block.output !== undefined) {
			const { output: _, ...rest } = block;
			return rest as ToolCallBlock;
		}
		return block;
	});
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const secs = Math.floor(ms / 1000);
	const mins = Math.floor(secs / 60);
	const hours = Math.floor(mins / 60);
	if (hours > 0) return `${hours}h ${mins % 60}m`;
	if (mins > 0) return `${mins}m ${secs % 60}s`;
	return `${secs}s`;
}

/**
 * Format a timestamp to a time string.
 */
export function formatTime(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Format elapsed milliseconds to human-readable string (e.g. "2h 5m", "30s").
 */
export function formatElapsed(ms: number): string {
	const secs = Math.floor(ms / 1000);
	const mins = Math.floor(secs / 60);
	const hours = Math.floor(mins / 60);

	if (hours > 0) return `${hours}h ${mins % 60}m`;
	if (mins > 0) return `${mins}m ${secs % 60}s`;
	return `${secs}s`;
}

/**
 * Format a relative age string from a date (e.g. "5m", "2h", "3d").
 */
export function formatAge(dateStr: string): string {
	const now = Date.now();
	const then = new Date(dateStr).getTime();
	const diffMs = now - then;
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffMins < 1) return 'just now';
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 30) return `${diffDays}d`;
	return `${Math.floor(diffDays / 30)}mo`;
}

/**
 * Format a timestamp for timeline display showing absolute time.
 * Shows "HH:MM:SS" for today, "MMM D, HH:MM:SS" for other days.
 */
export function formatTimeline(dateStr: string): string {
	const d = new Date(dateStr);
	const now = new Date();
	const time = d.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });

	const isToday =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();

	if (isToday) return time;

	const month = d.toLocaleString('en-US', { month: 'short' });
	const day = d.getDate();
	return `${month} ${day}, ${time}`;
}

/**
 * Extract unique file paths that were changed during a session.
 * Looks at Write, Edit, and NotebookEdit tool calls.
 *
 * AC: @ui-session-stream ac-4 — Files changed during session.
 */
/**
 * Compute the distance from the bottom of a scroll container.
 * Used by SessionStream.svelte for auto-scroll detection.
 *
 * AC: @ui-session-stream ac-3
 */
export function computeScrollDistance(scrollHeight: number, scrollTop: number, clientHeight: number): number {
	return scrollHeight - scrollTop - clientHeight;
}

/**
 * Determine whether auto-scroll should be active based on scroll position.
 * Returns true when the user is within the threshold of the bottom.
 *
 * AC: @ui-session-stream ac-3
 */
export const AUTO_SCROLL_THRESHOLD = 100;

export function shouldAutoScroll(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
	return computeScrollDistance(scrollHeight, scrollTop, clientHeight) <= AUTO_SCROLL_THRESHOLD;
}

/**
 * Determine whether the "jump to bottom" button should be visible.
 * Shown when not auto-scrolling AND there is content to jump to.
 *
 * AC: @ui-session-stream ac-3
 */
export function shouldShowJumpButton(autoScrolling: boolean, isLive: boolean, blockCount: number): boolean {
	return !autoScrolling && (isLive || blockCount > 0);
}

/**
 * Determine the last sequence number from an events array.
 * Returns -1 if the array is empty.
 *
 * AC: @ui-session-stream ac-2
 */
export function getLastSeq(events: Array<{ seq: number }>): number {
	if (events.length === 0) return -1;
	return events[events.length - 1].seq;
}

/**
 * Map a raw trigger value to a human-readable label.
 * Used by both the session list and session context panel.
 */
export function getTriggerLabel(trigger: string | undefined): string {
	switch (trigger) {
		case 'manual': return 'Manual Run';
		case 'task.ready': return 'Dispatched: Task Ready';
		case 'task.in_progress': return 'Dispatched: In Progress';
		case 'task.needs_work': return 'Dispatched: Fix Cycle';
		case 'task.pending_review': return 'Dispatched: PR Review';
		case 'legacy': return 'Legacy';
		default: return trigger ? `Dispatched: ${trigger}` : 'Legacy';
	}
}

/**
 * Determine whether a session trigger represents a dispatched (automated) session.
 */
export function isDispatchedSession(trigger: string | undefined): boolean {
	return !!trigger && trigger !== 'manual' && trigger !== 'legacy';
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

export function extractFilesChanged(blocks: DisplayBlock[]): string[] {
	const files = new Set<string>();
	for (const block of blocks) {
		if (block.type !== 'tool_call') continue;
		if (!WRITE_TOOLS.has(block.toolName)) continue;
		const input = block.input as Record<string, unknown> | null;
		if (!input) continue;
		const filePath = (input.file_path ?? input.notebook_path) as string | undefined;
		if (filePath) files.add(filePath);
	}
	return [...files].sort();
}
