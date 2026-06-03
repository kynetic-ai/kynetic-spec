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
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI_8BIT = String.fromCharCode(0x9b);
const OSC_8BIT = String.fromCharCode(0x9d);
const ST_8BIT = String.fromCharCode(0x9c);

// OSC (Operating System Command): ESC ] or 0x9D, arbitrary payload, terminated by
// BEL (0x07), ST (ESC \ or 0x9C), or — for malformed/truncated sequences within a
// single complete line — end-of-line. Examples: terminal hyperlinks (`ESC]8;;URL BEL`),
// window-title sequences (`ESC]0;title ESC\`). The payload may contain control bytes
// that would otherwise be picked up by CSI/control-char passes, so OSC must run first.
const OSC_PATTERN = new RegExp(
  `(?:${ESC}\\]|${OSC_8BIT})[\\s\\S]*?(?:${BEL}|${ESC}\\\\|${ST_8BIT}|$)`,
  "g",
);

// CSI (Control Sequence Introducer): ESC [ or 0x9B, parameter bytes (0x30–0x3F),
// intermediate bytes (0x20–0x2F), and a final byte (0x40–0x7E). The final byte is
// optional so a CSI fragment that survives line buffering still gets stripped.
const CSI_PATTERN = new RegExp(
  `(?:${ESC}\\[|${CSI_8BIT})[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]?`,
  "g",
);

// Other ESC-introduced sequences (Fp/Fe/Fs): ESC followed by a single byte in
// 0x20–0x7E. The trailing byte is optional so a stray ESC is also stripped.
const ESC_PATTERN = new RegExp(`${ESC}[\\x20-\\x7e]?`, "g");

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
  // Strip OSC sequences first: their payload can contain bytes (including \r and
  // BEL) that the later passes would otherwise misinterpret as visible content.
  const withoutOsc = line.replace(OSC_PATTERN, "");
  // Treat bare carriage returns as terminal progress-line rewrites. CRLF has already
  // been normalized to LF, so any remaining \r means "return to line start" output.
  const rewritten = withoutOsc.split("\r").pop() ?? "";
  const withoutEscapes = rewritten.replace(CSI_PATTERN, "").replace(ESC_PATTERN, "");
  return stripControlChars(applyBackspaces(withoutEscapes)).trim();
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
