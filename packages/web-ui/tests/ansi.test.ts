/**
 * Unit tests for ANSI SGR parser utility.
 *
 * Covers all 8 acceptance criteria for @ansi-terminal-rendering.
 */

import { describe, it, expect } from 'vitest';
import { ansiToHtml, containsAnsi, stripOrphanedCsi } from '../src/lib/utils/ansi';

// AC: @ansi-terminal-rendering ac-1
describe('ac-1: basic SGR rendering', () => {
	it('converts green text ANSI code to styled span', () => {
		const input = '\x1b[32mPASS\x1b[0m';
		const result = ansiToHtml(input);
		expect(result).toContain('<span');
		expect(result).toContain('color:var(--ansi-green)');
		expect(result).toContain('PASS');
		expect(result).not.toContain('\x1b');
	});

	it('renders multiple color segments', () => {
		const input = '\x1b[31mERROR\x1b[0m normal \x1b[32mOK\x1b[0m';
		const result = ansiToHtml(input);
		expect(result).toContain('color:var(--ansi-red)');
		expect(result).toContain('ERROR');
		expect(result).toContain(' normal ');
		expect(result).toContain('color:var(--ansi-green)');
		expect(result).toContain('OK');
	});

	it('passes through plain text unchanged (HTML-escaped)', () => {
		const input = 'Hello World';
		expect(ansiToHtml(input)).toBe('Hello World');
	});

	it('returns empty string for empty input', () => {
		expect(ansiToHtml('')).toBe('');
	});
});

// AC: @ansi-terminal-rendering ac-2
describe('ac-2: color modes (16, 256, truecolor)', () => {
	it('handles standard foreground colors 30-37', () => {
		const result = ansiToHtml('\x1b[31mred\x1b[0m');
		expect(result).toContain('color:var(--ansi-red)');
	});

	it('handles standard background colors 40-47', () => {
		const result = ansiToHtml('\x1b[42mgreen bg\x1b[0m');
		expect(result).toContain('background-color:var(--ansi-green)');
	});

	it('handles bright foreground colors 90-97', () => {
		const result = ansiToHtml('\x1b[91mbright red\x1b[0m');
		expect(result).toContain('color:var(--ansi-bright-red)');
	});

	it('handles bright background colors 100-107', () => {
		const result = ansiToHtml('\x1b[104mbright blue bg\x1b[0m');
		expect(result).toContain('background-color:var(--ansi-bright-blue)');
	});

	it('handles 256-color foreground (38;5;N)', () => {
		// Color 196 is bright red in 256-color mode (6x6x6 cube)
		const result = ansiToHtml('\x1b[38;5;196mtext\x1b[0m');
		expect(result).toContain('color:rgb(');
		expect(result).toContain('text');
	});

	it('handles 256-color background (48;5;N)', () => {
		const result = ansiToHtml('\x1b[48;5;21mtext\x1b[0m');
		expect(result).toContain('background-color:rgb(');
	});

	it('handles 256-color standard palette (0-15) via CSS vars', () => {
		const result = ansiToHtml('\x1b[38;5;1mred\x1b[0m');
		expect(result).toContain('color:var(--ansi-red)');
	});

	it('handles 256-color bright palette (8-15) via CSS vars', () => {
		const result = ansiToHtml('\x1b[38;5;10mgreen\x1b[0m');
		expect(result).toContain('color:var(--ansi-bright-green)');
	});

	it('handles 256-color grayscale ramp (232-255)', () => {
		const result = ansiToHtml('\x1b[38;5;240mgray\x1b[0m');
		expect(result).toContain('color:rgb(88,88,88)');
	});

	it('handles 24-bit truecolor foreground (38;2;R;G;B)', () => {
		const result = ansiToHtml('\x1b[38;2;255;128;0morange\x1b[0m');
		expect(result).toContain('color:rgb(255,128,0)');
		expect(result).toContain('orange');
	});

	it('handles 24-bit truecolor background (48;2;R;G;B)', () => {
		const result = ansiToHtml('\x1b[48;2;0;0;255mblue bg\x1b[0m');
		expect(result).toContain('background-color:rgb(0,0,255)');
	});

	it('handles combined foreground and background', () => {
		const result = ansiToHtml('\x1b[31;42mred on green\x1b[0m');
		expect(result).toContain('color:var(--ansi-red)');
		expect(result).toContain('background-color:var(--ansi-green)');
	});
});

// AC: @ansi-terminal-rendering ac-3
describe('ac-3: text formatting codes', () => {
	it('applies bold (code 1)', () => {
		const result = ansiToHtml('\x1b[1mbold\x1b[0m');
		expect(result).toContain('font-weight:bold');
	});

	it('applies dim (code 2)', () => {
		const result = ansiToHtml('\x1b[2mdim\x1b[0m');
		expect(result).toContain('opacity:0.6');
	});

	it('applies italic (code 3)', () => {
		const result = ansiToHtml('\x1b[3mitalic\x1b[0m');
		expect(result).toContain('font-style:italic');
	});

	it('applies underline (code 4)', () => {
		const result = ansiToHtml('\x1b[4munderline\x1b[0m');
		expect(result).toContain('text-decoration:underline');
	});

	it('applies strikethrough (code 9)', () => {
		const result = ansiToHtml('\x1b[9mstrike\x1b[0m');
		expect(result).toContain('text-decoration:line-through');
	});

	it('combines multiple formatting codes', () => {
		const result = ansiToHtml('\x1b[1;3;4mbold italic underline\x1b[0m');
		expect(result).toContain('font-weight:bold');
		expect(result).toContain('font-style:italic');
		expect(result).toContain('text-decoration:underline');
	});

	it('combines underline and strikethrough in text-decoration', () => {
		const result = ansiToHtml('\x1b[4;9mboth\x1b[0m');
		expect(result).toContain('text-decoration:underline line-through');
	});

	it('combines formatting with colors', () => {
		const result = ansiToHtml('\x1b[1;31mbold red\x1b[0m');
		expect(result).toContain('font-weight:bold');
		expect(result).toContain('color:var(--ansi-red)');
	});
});

// AC: @ansi-terminal-rendering ac-4
describe('ac-4: reset codes', () => {
	it('full reset (code 0) clears all styles', () => {
		const result = ansiToHtml('\x1b[1;31;42mbold red on green\x1b[0m plain');
		// After reset, "plain" should not be in a styled span
		expect(result).toMatch(/plain(?!.*<\/span>)/);
		// The styled content should be before the reset
		expect(result).toContain('font-weight:bold');
		expect(result).toContain('color:var(--ansi-red)');
	});

	it('ESC[m (no params) acts as full reset', () => {
		const result = ansiToHtml('\x1b[31mred\x1b[m plain');
		// "plain" should be outside any styled span
		const plainIndex = result.indexOf('plain');
		const lastCloseSpan = result.lastIndexOf('</span>', plainIndex);
		expect(lastCloseSpan).toBeLessThan(plainIndex);
	});

	it('specific reset: code 22 resets bold and dim', () => {
		const result = ansiToHtml('\x1b[1;31mbold red\x1b[22mnot bold red\x1b[0m');
		// First segment should have bold
		expect(result).toContain('font-weight:bold');
		// Second segment should still have red but no bold
		const spans = result.match(/<span[^>]*>/g) || [];
		expect(spans.length).toBeGreaterThanOrEqual(2);
		const secondSpan = spans[1];
		expect(secondSpan).toContain('color:var(--ansi-red)');
		expect(secondSpan).not.toContain('font-weight:bold');
	});

	it('specific reset: code 23 resets italic only', () => {
		const result = ansiToHtml('\x1b[3;4mitalic underline\x1b[23munderline only\x1b[0m');
		const spans = result.match(/<span[^>]*>/g) || [];
		expect(spans.length).toBeGreaterThanOrEqual(2);
		const secondSpan = spans[1];
		expect(secondSpan).not.toContain('font-style:italic');
		expect(secondSpan).toContain('text-decoration:underline');
	});

	it('specific reset: code 39 resets fg color only', () => {
		const result = ansiToHtml('\x1b[31;42mred on green\x1b[39mdefault fg on green\x1b[0m');
		const spans = result.match(/<span[^>]*>/g) || [];
		const lastSpan = spans[spans.length - 1];
		expect(lastSpan).toContain('background-color:var(--ansi-green)');
		// Should not have a foreground color (only background-color)
		expect(lastSpan).not.toMatch(/(?<!background-)color:/);
	});

	it('styles do not leak past reset to subsequent text', () => {
		const result = ansiToHtml('\x1b[31mred\x1b[0m plain \x1b[32mgreen\x1b[0m end');
		// "plain" and "end" should not be inside colored spans
		expect(result).toContain('</span> plain ');
		expect(result).toContain('</span> end');
	});
});

// AC: @ansi-terminal-rendering ac-5
describe('ac-5: orphaned CSI parameter stripping', () => {
	it('strips orphaned CSI sequences where ESC was lost', () => {
		const input = '[32mPASS[0m normal text';
		const result = ansiToHtml(input);
		expect(result).not.toContain('[32m');
		expect(result).not.toContain('[0m');
		expect(result).toContain('PASS');
		expect(result).toContain('normal text');
	});

	it('strips multiple orphaned CSI sequences', () => {
		const input = '[1;31mERROR[0m: [32mfixed[0m';
		const result = ansiToHtml(input);
		expect(result).not.toContain('[1;31m');
		expect(result).not.toContain('[0m');
		expect(result).toContain('ERROR');
		expect(result).toContain('fixed');
	});

	it('preserves regular brackets in text', () => {
		const input = 'array[0] and obj[key]';
		const result = ansiToHtml(input);
		expect(result).toContain('array[0]');
		expect(result).toContain('obj[key]');
	});

	it('containsAnsi returns false for orphaned sequences', () => {
		expect(containsAnsi('[32mtext[0m')).toBe(false);
	});

	it('stripOrphanedCsi works directly', () => {
		expect(stripOrphanedCsi('[32mPASS[0m')).toBe('PASS');
	});
});

// AC: @ansi-terminal-rendering ac-6
describe('ac-6: XSS prevention', () => {
	it('HTML-escapes angle brackets in plain text', () => {
		const input = '<script>alert("xss")</script>';
		const result = ansiToHtml(input);
		expect(result).toContain('&lt;script&gt;');
		expect(result).not.toContain('<script>');
	});

	it('HTML-escapes content between ANSI codes', () => {
		const input = '\x1b[31m<img onerror=alert(1)>\x1b[0m';
		const result = ansiToHtml(input);
		expect(result).toContain('&lt;img onerror=alert(1)&gt;');
		expect(result).not.toContain('<img');
	});

	it('HTML-escapes ampersands', () => {
		const result = ansiToHtml('a & b');
		expect(result).toBe('a &amp; b');
	});

	it('HTML-escapes quotes', () => {
		const result = ansiToHtml('class="foo" data-x=\'bar\'');
		expect(result).toContain('&quot;');
		expect(result).toContain('&#039;');
	});

	it('escapes content inside styled spans', () => {
		const input = '\x1b[32m<div onclick="evil()">\x1b[0m';
		const result = ansiToHtml(input);
		expect(result).toContain('&lt;div onclick=&quot;evil()&quot;&gt;');
	});
});

// AC: @ansi-terminal-rendering ac-7
describe('ac-7: performance with large inputs', () => {
	it('handles 10000+ character input with many ANSI sequences', () => {
		// Build a large string with alternating colored segments
		const segments: string[] = [];
		for (let i = 0; i < 500; i++) {
			const color = 31 + (i % 7); // cycle through colors
			segments.push(`\x1b[${color}m${'x'.repeat(20)}\x1b[0m`);
		}
		const input = segments.join(' ');
		expect(input.length).toBeGreaterThan(10000);

		const start = performance.now();
		const result = ansiToHtml(input);
		const elapsed = performance.now() - start;

		// Should complete in under 100ms (generous threshold for CI)
		expect(elapsed).toBeLessThan(100);
		expect(result).toContain('<span');
		expect(result).not.toContain('\x1b');
	});

	it('handles input with many 256-color sequences', () => {
		const segments: string[] = [];
		for (let i = 0; i < 256; i++) {
			segments.push(`\x1b[38;5;${i}mcolor${i}\x1b[0m`);
		}
		const input = segments.join('');

		const start = performance.now();
		const result = ansiToHtml(input);
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(100);
		expect(result).not.toContain('\x1b');
	});

	it('handles input with many truecolor sequences', () => {
		const segments: string[] = [];
		for (let i = 0; i < 200; i++) {
			segments.push(`\x1b[38;2;${i};${255 - i};128mrgb${i}\x1b[0m`);
		}
		const input = segments.join('');

		const start = performance.now();
		const result = ansiToHtml(input);
		const elapsed = performance.now() - start;

		expect(elapsed).toBeLessThan(100);
		expect(result).not.toContain('\x1b');
	});
});

// AC: @ansi-terminal-rendering ac-8
describe('ac-8: pipeline isolation (pre blocks only)', () => {
	it('containsAnsi correctly detects ANSI sequences', () => {
		expect(containsAnsi('\x1b[32mtext\x1b[0m')).toBe(true);
		expect(containsAnsi('plain text')).toBe(false);
		expect(containsAnsi('')).toBe(false);
	});

	it('ansiToHtml returns plain HTML-escaped text when no ANSI present', () => {
		const input = 'Just regular text with <html>';
		const result = ansiToHtml(input);
		expect(result).toBe('Just regular text with &lt;html&gt;');
		expect(result).not.toContain('<span');
	});
});

describe('edge cases', () => {
	it('handles non-SGR escape sequences by stripping them', () => {
		// Cursor up (CSI A), clear screen (CSI J) — should be stripped
		const input = '\x1b[2J\x1b[H\x1b[32mHello\x1b[0m';
		const result = ansiToHtml(input);
		expect(result).not.toContain('\x1b');
		expect(result).toContain('Hello');
		expect(result).toContain('color:var(--ansi-green)');
	});

	it('handles unclosed style at end of string', () => {
		// No reset at end — span should still be closed
		const result = ansiToHtml('\x1b[31mred text');
		expect(result).toContain('<span');
		expect(result).toContain('</span>');
		expect(result).toContain('red text');
	});

	it('handles consecutive escape sequences with no text between', () => {
		const result = ansiToHtml('\x1b[1m\x1b[31m\x1b[42mtext\x1b[0m');
		expect(result).toContain('text');
		// Should have accumulated bold + red fg + green bg
		expect(result).toContain('font-weight:bold');
		expect(result).toContain('color:var(--ansi-red)');
		expect(result).toContain('background-color:var(--ansi-green)');
	});

	it('handles 256-color cube boundary values', () => {
		// Color 16 is first in cube (0,0,0 = black)
		const result16 = ansiToHtml('\x1b[38;5;16mtext\x1b[0m');
		expect(result16).toContain('color:rgb(0,0,0)');

		// Color 231 is last in cube (5,5,5 = white-ish)
		const result231 = ansiToHtml('\x1b[38;5;231mtext\x1b[0m');
		expect(result231).toContain('color:rgb(255,255,255)');
	});

	it('handles grayscale boundary values', () => {
		// Color 232 is darkest grayscale
		const result232 = ansiToHtml('\x1b[38;5;232mtext\x1b[0m');
		expect(result232).toContain('color:rgb(8,8,8)');

		// Color 255 is lightest grayscale
		const result255 = ansiToHtml('\x1b[38;5;255mtext\x1b[0m');
		expect(result255).toContain('color:rgb(238,238,238)');
	});
});
