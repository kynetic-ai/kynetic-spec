/**
 * ANSI SGR escape sequence parser.
 *
 * Converts ANSI color/formatting codes in terminal output to styled HTML spans.
 * Supports standard 16 colors, 256-color (38;5;N), 24-bit true color (38;2;R;G;B),
 * and text formatting (bold, dim, italic, underline, strikethrough).
 *
 * Non-SGR sequences (cursor movement, screen clear) are stripped.
 * Orphaned CSI parameters (ESC char stripped) are also stripped.
 * All non-ANSI content is HTML-escaped to prevent XSS.
 */

// Match a real ANSI escape sequence: ESC [ (optional private-mode prefix) params final-byte
const ANSI_RE = /\x1b\[(\??[0-9;]*)([A-Za-z])/g;

// Match orphaned CSI parameters where ESC was stripped: bare [digits;digits followed by letter
// Also matches private-mode sequences like [?25l where ESC was stripped
// Only matches sequences that look like ANSI codes, not regular bracket usage
const ORPHANED_CSI_RE = /\[(\??[0-9]+(?:;[0-9]+)*)([A-HJKSTfhilmnpsu])/g;

/** HTML-escape a string to prevent XSS. */
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

interface AnsiState {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	strikethrough: boolean;
	fg: string | null; // CSS color value or var(--ansi-*)
	bg: string | null;
}

function emptyState(): AnsiState {
	return {
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		strikethrough: false,
		fg: null,
		bg: null
	};
}

/** Map standard ANSI color index (0-7) to CSS custom property name. */
const STANDARD_COLORS = [
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white'
] as const;

function colorFromIndex(index: number): string {
	if (index < 8) {
		return `var(--ansi-${STANDARD_COLORS[index]})`;
	}
	if (index < 16) {
		return `var(--ansi-bright-${STANDARD_COLORS[index - 8]})`;
	}
	if (index < 232) {
		// 216-color cube: 6x6x6
		const ci = index - 16;
		const r = Math.floor(ci / 36);
		const g = Math.floor((ci % 36) / 6);
		const b = ci % 6;
		// Map 0-5 to 0-255 using standard xterm values
		const toVal = (v: number) => (v === 0 ? 0 : 55 + v * 40);
		return `rgb(${toVal(r)},${toVal(g)},${toVal(b)})`;
	}
	// Grayscale ramp: 232-255 → 8, 18, 28, ..., 238
	const gray = 8 + (index - 232) * 10;
	return `rgb(${gray},${gray},${gray})`;
}

/** Parse SGR parameter codes and update state. */
function applySgr(params: number[], state: AnsiState): void {
	let i = 0;
	while (i < params.length) {
		const code = params[i];
		switch (code) {
			case 0: // Reset all
				Object.assign(state, emptyState());
				break;
			case 1:
				state.bold = true;
				break;
			case 2:
				state.dim = true;
				break;
			case 3:
				state.italic = true;
				break;
			case 4:
				state.underline = true;
				break;
			case 9:
				state.strikethrough = true;
				break;
			case 22: // Normal intensity (reset bold and dim)
				state.bold = false;
				state.dim = false;
				break;
			case 23: // Reset italic
				state.italic = false;
				break;
			case 24: // Reset underline
				state.underline = false;
				break;
			case 29: // Reset strikethrough
				state.strikethrough = false;
				break;
			case 39: // Default foreground
				state.fg = null;
				break;
			case 49: // Default background
				state.bg = null;
				break;
			default:
				// Standard foreground colors 30-37
				if (code >= 30 && code <= 37) {
					state.fg = `var(--ansi-${STANDARD_COLORS[code - 30]})`;
				}
				// Standard background colors 40-47
				else if (code >= 40 && code <= 47) {
					state.bg = `var(--ansi-${STANDARD_COLORS[code - 40]})`;
				}
				// Bright foreground 90-97
				else if (code >= 90 && code <= 97) {
					state.fg = `var(--ansi-bright-${STANDARD_COLORS[code - 90]})`;
				}
				// Bright background 100-107
				else if (code >= 100 && code <= 107) {
					state.bg = `var(--ansi-bright-${STANDARD_COLORS[code - 100]})`;
				}
				// Extended color: 38;5;N (fg 256) or 38;2;R;G;B (fg truecolor)
				else if (code === 38) {
					if (params[i + 1] === 5 && i + 2 < params.length) {
						state.fg = colorFromIndex(params[i + 2]);
						i += 2;
					} else if (params[i + 1] === 2 && i + 4 < params.length) {
						state.fg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
						i += 4;
					}
				}
				// Extended color: 48;5;N (bg 256) or 48;2;R;G;B (bg truecolor)
				else if (code === 48) {
					if (params[i + 1] === 5 && i + 2 < params.length) {
						state.bg = colorFromIndex(params[i + 2]);
						i += 2;
					} else if (params[i + 1] === 2 && i + 4 < params.length) {
						state.bg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
						i += 4;
					}
				}
				break;
		}
		i++;
	}
}

/** Build a style attribute string from the current ANSI state. */
function stateToStyle(state: AnsiState): string {
	const parts: string[] = [];
	if (state.fg) parts.push(`color:${state.fg}`);
	if (state.bg) parts.push(`background-color:${state.bg}`);
	if (state.bold) parts.push('font-weight:bold');
	if (state.dim) parts.push('opacity:0.6');
	if (state.italic) parts.push('font-style:italic');

	const decorations: string[] = [];
	if (state.underline) decorations.push('underline');
	if (state.strikethrough) decorations.push('line-through');
	if (decorations.length) parts.push(`text-decoration:${decorations.join(' ')}`);

	return parts.join(';');
}

function isStateActive(state: AnsiState): boolean {
	return (
		state.bold ||
		state.dim ||
		state.italic ||
		state.underline ||
		state.strikethrough ||
		state.fg !== null ||
		state.bg !== null
	);
}

/** Check if a string contains any ANSI escape sequences or orphaned CSI fragments. */
export function containsAnsi(text: string): boolean {
	if (text.includes('\x1b[')) return true;
	// Reset lastIndex since ORPHANED_CSI_RE has the global flag
	ORPHANED_CSI_RE.lastIndex = 0;
	return ORPHANED_CSI_RE.test(text);
}

/**
 * Strip orphaned CSI parameter sequences where the ESC character was lost.
 * e.g. "[32m" → "" when ESC (0x1B) is missing.
 */
export function stripOrphanedCsi(text: string): string {
	return text.replace(ORPHANED_CSI_RE, '');
}

/**
 * Truncate text to maxLen without splitting an ANSI escape sequence.
 *
 * If the cutoff lands inside a sequence (e.g. mid-`\x1b[31m`), the trailing
 * partial sequence is removed so that downstream ANSI parsing never sees a
 * dangling ESC byte.
 */
export function safeTruncateAnsi(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	let truncated = text.slice(0, maxLen);
	// Strip any trailing incomplete ESC sequence: \x1b possibly followed by [ and partial params
	truncated = truncated.replace(/\x1b(?:\[[\x20-\x3f]*)?$/, '');
	// Also strip orphaned trailing [ that could be the start of an orphaned CSI
	truncated = truncated.replace(/\[\??[0-9;]*$/, '');
	return truncated;
}

/**
 * Convert ANSI SGR escape sequences in text to HTML with inline styles.
 *
 * - SGR codes (m suffix) are parsed and converted to styled <span> elements
 * - Non-SGR escape sequences (cursor movement, etc.) are stripped
 * - All literal text content is HTML-escaped for XSS safety
 * - Orphaned CSI parameters (ESC stripped) are cleaned up
 */
export function ansiToHtml(text: string): string {
	// Fast path: no ANSI codes at all
	if (!text.includes('\x1b[')) {
		// Still check for orphaned CSI and escape
		return escapeHtml(stripOrphanedCsi(text));
	}

	const state = emptyState();
	const output: string[] = [];
	let lastIndex = 0;
	let spanOpen = false;

	ANSI_RE.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = ANSI_RE.exec(text)) !== null) {
		// Append text before this escape sequence (strip orphaned CSI, then HTML-escape)
		if (match.index > lastIndex) {
			const chunk = stripOrphanedCsi(text.slice(lastIndex, match.index));
			if (chunk) output.push(escapeHtml(chunk));
		}
		lastIndex = match.index + match[0].length;

		const paramsStr = match[1];
		const finalByte = match[2];

		// Only process SGR sequences (final byte 'm', no private-mode prefix)
		if (finalByte === 'm' && !paramsStr.startsWith('?')) {
			const params =
				paramsStr === '' ? [0] : paramsStr.split(';').map((s) => parseInt(s, 10) || 0);
			applySgr(params, state);

			// Close previous span if open
			if (spanOpen) {
				output.push('</span>');
				spanOpen = false;
			}

			// Open new span if state is active
			if (isStateActive(state)) {
				const style = stateToStyle(state);
				output.push(`<span style="${style}">`);
				spanOpen = true;
			}
		}
		// Non-SGR sequences are simply stripped (not rendered)
	}

	// Append remaining text (strip orphaned CSI, then HTML-escape)
	if (lastIndex < text.length) {
		const remaining = stripOrphanedCsi(text.slice(lastIndex));
		if (remaining) output.push(escapeHtml(remaining));
	}

	// Close any open span
	if (spanOpen) {
		output.push('</span>');
	}

	return output.join('');
}
