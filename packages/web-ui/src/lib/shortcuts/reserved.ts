/**
 * Per-platform browser-reserved key combinations.
 *
 * Maintained as plain data so the lists can be inspected and unit-tested
 * directly. A registration whose resolved chord appears here is never bound;
 * the registry falls through to declared fallbacks instead.
 *
 * AC: @ui-shortcut-registry ac-5
 * AC: @web-shell-platform-target ac-3
 */

import { chordKey } from "./chord.js";
import type { Platform, ResolvedChord } from "./types.js";

function reserved(key: string, mods: Partial<ResolvedChord> = {}): ResolvedChord {
  return {
    key,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

/**
 * Browser-reserved combinations on macOS. Command maps to the primary modifier,
 * so Cmd+W/T/N (close/new tab/new window) and Cmd+Q (quit) plus Ctrl+Tab
 * (tab cycling) are off-limits.
 */
const RESERVED_MAC: ResolvedChord[] = [
  reserved("w", { meta: true }),
  reserved("t", { meta: true }),
  reserved("n", { meta: true }),
  reserved("q", { meta: true }),
  reserved("tab", { ctrl: true }),
];

/**
 * Browser-reserved combinations on Windows/Linux. Control maps to the primary
 * modifier, so Ctrl+W/T/N and Ctrl+Tab are off-limits. (Ctrl+Q is not a
 * universal browser reservation, so it is intentionally omitted here.)
 */
const RESERVED_OTHER: ResolvedChord[] = [
  reserved("w", { ctrl: true }),
  reserved("t", { ctrl: true }),
  reserved("n", { ctrl: true }),
  reserved("tab", { ctrl: true }),
];

const RESERVED_KEYS: Record<Platform, Set<string>> = {
  mac: new Set(RESERVED_MAC.map(chordKey)),
  other: new Set(RESERVED_OTHER.map(chordKey)),
};

/** The reserved chord list for a platform (defensive copy). */
export function reservedChords(platform: Platform): ResolvedChord[] {
  return (platform === "mac" ? RESERVED_MAC : RESERVED_OTHER).map((c) => ({ ...c }));
}

/** Whether a resolved chord is on the platform's browser-reserved list. */
export function isReserved(chord: ResolvedChord, platform: Platform): boolean {
  return RESERVED_KEYS[platform].has(chordKey(chord));
}
