/**
 * Ralph CLI Renderer
 *
 * Renders RalphEvents to the terminal with chalk colors and formatting.
 * This is the CLI-specific implementation; other renderers (TUI) could
 * consume the same event stream with different display logic.
 */

import chalk from 'chalk';
import type {
  RalphEvent,
  AgentMessageData,
  AgentThoughtData,
  ToolStartData,
  ToolUpdateData,
  ToolResultData,
  StatusData,
} from './events.js';

// ============================================================================
// Renderer Interface
// ============================================================================

export interface RalphRenderer {
  /**
   * Render an event to the output.
   */
  render(event: RalphEvent): void;

  /**
   * Called when a new section starts (e.g., iteration boundary).
   */
  newSection?(label: string): void;
}

// ============================================================================
// Timestamp Formatting
// ============================================================================

/**
 * Format milliseconds as relative timestamp.
 * Examples: +0s, +5s, +1m, +2m30s
 */
function formatTimestamp(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `+${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) {
    return `+${minutes}m`;
  }
  return `+${minutes}m${remainingSeconds}s`;
}

// ============================================================================
// CLI Renderer Implementation
// ============================================================================

interface CliRendererState {
  lastEventType: string | null;
  isStreaming: boolean;
}

export function createCliRenderer(): RalphRenderer {
  const state: CliRendererState = {
    lastEventType: null,
    isStreaming: false,
  };

  function render(event: RalphEvent): void {
    const ts = chalk.gray(`[${formatTimestamp(event.timestamp)}]`);
    const data = event.data;

    switch (data.kind) {
      case 'agent_message':
        renderAgentMessage(ts, data, state);
        break;
      case 'agent_thought':
        renderAgentThought(ts, data, state);
        break;
      case 'tool_start':
        renderToolStart(ts, data, state);
        break;
      case 'tool_update':
        renderToolUpdate(ts, data);
        break;
      case 'tool_result':
        renderToolResult(ts, data, state);
        break;
      case 'status':
        renderStatus(ts, data);
        break;
    }
  }

  function newSection(label: string): void {
    // End any streaming state
    if (state.isStreaming) {
      process.stdout.write('\n');
      state.isStreaming = false;
    }
    state.lastEventType = null;

    console.log('');
    console.log(chalk.cyan(`${'─'.repeat(60)}`));
    console.log(chalk.cyan.bold(label));
    console.log(chalk.cyan(`${'─'.repeat(60)}`));
    console.log('');
  }

  return { render, newSection };
}

// ============================================================================
// Event Renderers
// ============================================================================

function renderAgentMessage(
  ts: string,
  data: AgentMessageData,
  state: CliRendererState
): void {
  // New section header if switching from non-message
  if (state.lastEventType !== 'agent_message' && !state.isStreaming) {
    if (state.lastEventType !== null) {
      console.log(''); // Spacing
    }
    console.log(`${ts} ${chalk.blue('--- Agent ---')}`);
  }

  // Stream content directly
  if (data.isStreaming) {
    process.stdout.write(data.content);
    state.isStreaming = true;
  } else {
    // Final content - ensure newline
    if (state.isStreaming) {
      process.stdout.write('\n');
    }
    state.isStreaming = false;
  }

  state.lastEventType = 'agent_message';
}

function renderAgentThought(
  ts: string,
  data: AgentThoughtData,
  state: CliRendererState
): void {
  // New section header if switching from non-thought
  if (state.lastEventType !== 'agent_thought' && !state.isStreaming) {
    if (state.lastEventType !== null) {
      console.log('');
    }
    console.log(`${ts} ${chalk.magenta('--- Thinking ---')}`);
  }

  // Stream content in dim/gray
  if (data.isStreaming) {
    process.stdout.write(chalk.dim(data.content));
    state.isStreaming = true;
  } else {
    if (state.isStreaming) {
      process.stdout.write('\n');
    }
    state.isStreaming = false;
  }

  state.lastEventType = 'agent_thought';
}

function renderToolStart(
  ts: string,
  data: ToolStartData,
  state: CliRendererState
): void {
  // End any streaming
  if (state.isStreaming) {
    process.stdout.write('\n');
    state.isStreaming = false;
  }

  if (state.lastEventType !== null) {
    console.log('');
  }

  console.log(`${ts} ${chalk.yellow(`--- Tool: ${data.tool} ---`)}`);

  // Show summary if available
  if (data.summary) {
    console.log(`${ts} ${chalk.gray(data.summary)}`);
  }

  state.lastEventType = 'tool_start';
}

function renderToolUpdate(ts: string, data: ToolUpdateData): void {
  const statusIcon = data.status === 'running' ? chalk.blue('⟳') : chalk.gray('○');
  console.log(`${ts} ${statusIcon} ${chalk.gray(data.status)}`);
}

function renderToolResult(
  ts: string,
  data: ToolResultData,
  state: CliRendererState
): void {
  // Status line
  const statusColor =
    data.status === 'completed'
      ? chalk.green
      : data.status === 'failed'
        ? chalk.red
        : chalk.yellow;
  const statusIcon =
    data.status === 'completed' ? '✓' : data.status === 'failed' ? '✗' : '○';

  console.log(`${ts} ${statusColor(`${statusIcon} ${data.status}`)}`);

  // Output (if any)
  if (data.output) {
    const outputLines = data.output.split('\n');
    const indent = '       '; // Align with timestamp

    // Show output with indentation
    for (const line of outputLines.slice(0, 20)) {
      console.log(chalk.gray(`${indent}${line}`));
    }

    if (data.truncated) {
      console.log(chalk.gray(`${indent}... (truncated)`));
    }
  }

  state.lastEventType = 'tool_result';
}

function renderStatus(ts: string, data: StatusData): void {
  const statusColor =
    data.status === 'completed' || data.status === 'end_turn'
      ? chalk.green
      : data.status === 'error' || data.status === 'crashed'
        ? chalk.red
        : chalk.gray;

  let statusText = data.status;
  if (data.message) {
    statusText += `: ${data.message}`;
  }

  console.log(`${ts} ${statusColor(`[${statusText}]`)}`);
}
