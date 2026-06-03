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

// Strip terminal escape/control sequences before displaying text in compact fleet cards.
// Full session logs preserve the original stream; this lossy cleanup is only for the
// short Active Fleet preview where raw terminal bytes create mangled-looking output.
const ESC = String.fromCharCode(27);
const CSI = String.fromCharCode(155);
const BEL = String.fromCharCode(7);
const ANSI_ESCAPE_PATTERN = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?${BEL})|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);
function isStrippableControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x00 && code <= 0x07) ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1a) ||
    (code >= 0x1c && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

function stripControlChars(text: string): string {
  return Array.from(text)
    .filter((char) => !isStrippableControlChar(char))
    .join("");
}

function applyBackspaces(text: string): string {
  const chars: string[] = [];
  for (const char of text) {
    if (char === "\b") {
      chars.pop();
    } else {
      chars.push(char);
    }
  }
  return chars.join("");
}

function sanitizeDisplayLine(line: string): string {
  // Treat bare carriage returns as terminal progress-line rewrites. CRLF has already
  // been normalized to LF, so any remaining \r means "return to line start" output.
  const rewritten = line.split("\r").pop() ?? "";
  const withoutAnsi = rewritten.replace(ANSI_ESCAPE_PATTERN, "");
  return stripControlChars(applyBackspaces(withoutAnsi)).trim();
}

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
  const combined = (state.buffer + text).replace(/\r\n/g, "\n");
  const parts = combined.split("\n");

  // Last element is either empty (if text ended with \n) or a partial line
  const partial = parts.pop() ?? "";

  // All parts except the last are complete lines
  const completedLines: string[] = [];
  for (const part of parts) {
    const trimmed = sanitizeDisplayLine(part);
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
