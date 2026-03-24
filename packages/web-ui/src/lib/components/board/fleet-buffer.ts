/**
 * Buffers raw streaming token chunks into complete lines for Active Fleet display.
 *
 * Instead of showing raw token fragments like "driven\nform\n.", this utility:
 * 1. Accumulates incoming text into a buffer per session
 * 2. Only emits complete lines (split on newline)
 * 3. Keeps the last N complete lines for display
 *
 * AC: @ui-task-board ac-4
 */

export interface FleetSessionState {
  /** Raw text buffer — holds partial line content until a newline arrives */
  buffer: string;
  /** Complete lines ready for display (last N) */
  lines: string[];
}

const MAX_DISPLAY_LINES = 3;

/**
 * Create a fresh session state.
 */
export function createSessionState(): FleetSessionState {
  return {
    buffer: "",
    lines: [],
  };
}

/**
 * Process an incoming text chunk for a session.
 * Accumulates text, extracts complete lines, and returns updated state.
 */
export function processTextChunk(state: FleetSessionState, text: string): FleetSessionState {
  const combined = state.buffer + text;
  const parts = combined.split("\n");

  // Last element is either empty (if text ended with \n) or a partial line
  const partial = parts.pop() ?? "";

  // All parts except the last are complete lines
  const completedLines: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      completedLines.push(trimmed);
    }
  }

  // Merge with existing lines and keep last N
  const allLines = [...state.lines, ...completedLines].slice(-MAX_DISPLAY_LINES);

  return {
    buffer: partial,
    lines: allLines,
  };
}

/**
 * Get display-ready output for a fleet card.
 * Returns the buffered lines.
 */
export function getDisplayState(state: FleetSessionState): {
  lines: string[];
} {
  return {
    lines: state.lines,
  };
}
