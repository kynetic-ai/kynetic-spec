/**
 * Chord normalization, platform resolution, equality, and display labels.
 *
 * These are pure functions over plain data so they can be unit-tested directly
 * without a DOM or Svelte runtime. See @ui-shortcut-registry ac-3.
 */

import type { Platform, ResolvedChord, ShortcutChord } from "./types.js";

/** Normalize a key name to a stable lowercase form for comparison. */
export function normalizeKey(key: string): string {
  return key.toLowerCase();
}

/**
 * Resolve a platform-abstract chord against a concrete platform. The abstract
 * primary modifier (`mod`) becomes Command on macOS and Control elsewhere.
 *
 * AC: @ui-shortcut-registry ac-3
 */
export function resolveChord(chord: ShortcutChord, platform: Platform): ResolvedChord {
  return {
    key: normalizeKey(chord.key),
    meta: Boolean(chord.meta) || (Boolean(chord.mod) && platform === "mac"),
    ctrl: Boolean(chord.ctrl) || (Boolean(chord.mod) && platform === "other"),
    alt: Boolean(chord.alt),
    shift: Boolean(chord.shift),
  };
}

/** Build the resolved chord for an actual keyboard event. */
export function eventToResolvedChord(event: KeyboardEvent): ResolvedChord {
  return {
    key: normalizeKey(event.key),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

/** Whether the event carries the platform's conventional primary modifier. */
export function hasPrimaryModifier(event: KeyboardEvent, platform: Platform): boolean {
  return platform === "mac" ? event.metaKey : event.ctrlKey;
}

/**
 * Canonical string for a resolved chord. Used as the comparison/collision key
 * and for dispatch matching — two resolved chords are equal iff their keys match.
 */
export function chordKey(chord: ResolvedChord): string {
  const mods = `${chord.meta ? "M" : ""}${chord.ctrl ? "C" : ""}${chord.alt ? "A" : ""}${chord.shift ? "S" : ""}`;
  return `${mods}+${chord.key}`;
}

/** Pretty-print the main key for display labels. */
function displayKey(key: string): string {
  const specials: Record<string, string> = {
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    arrowdown: "↓",
    " ": "Space",
    spacebar: "Space",
    escape: "Esc",
    enter: "Enter",
    tab: "Tab",
    backspace: "⌫",
    delete: "Del",
  };
  if (key in specials) {
    return specials[key];
  }
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Render a resolved chord as a display label matching the active platform —
 * macOS uses the conventional symbol stack (⌃⌥⇧⌘), other platforms use
 * "Ctrl+Alt+Shift+Meta+" prefixes.
 *
 * AC: @ui-shortcut-registry ac-3
 */
export function labelForChord(chord: ResolvedChord, platform: Platform): string {
  const key = displayKey(chord.key);
  if (platform === "mac") {
    let out = "";
    if (chord.ctrl) out += "⌃";
    if (chord.alt) out += "⌥";
    if (chord.shift) out += "⇧";
    if (chord.meta) out += "⌘";
    return `${out}${key}`;
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  if (chord.meta) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
}
