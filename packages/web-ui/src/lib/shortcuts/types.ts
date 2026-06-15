/**
 * Keyboard shortcut registry — shared types.
 *
 * The registry resolves platform-abstract chords to a concrete chord per
 * platform, detects binding collisions within a context, refuses
 * browser-reserved combinations (falling through to declared fallbacks), and
 * exposes an enumerable inventory of active bindings. See @ui-shortcut-registry
 * and @web-shell-platform-target.
 */

/** Supported runtime platforms for chord resolution. */
export type Platform = "mac" | "other";

/** The context an "always active" shortcut lives in. */
export const GLOBAL_CONTEXT = "global";

/**
 * A platform-abstract chord declaration. `mod` is the platform-abstract
 * primary modifier — it resolves to Command on macOS and Control elsewhere.
 * `ctrl`/`meta` are literal modifiers for the rare case a shortcut needs a
 * specific physical key regardless of platform convention.
 */
export interface ShortcutChord {
  /** Main key, e.g. "k", "b", "ArrowLeft". Case-insensitive; normalized internally. */
  key: string;
  /** Platform-abstract primary modifier (Cmd on macOS, Ctrl elsewhere). */
  mod?: boolean;
  /** Literal Control modifier (distinct from the abstract primary modifier). */
  ctrl?: boolean;
  /** Literal Command/Meta modifier. */
  meta?: boolean;
  /** Alt/Option modifier. */
  alt?: boolean;
  /** Shift modifier. */
  shift?: boolean;
}

/**
 * A chord resolved against a concrete platform. Every modifier is explicit, so
 * two resolved chords compare for equality field-by-field (see chordKey).
 */
export interface ResolvedChord {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** A shortcut declaration handed to the registry. */
export interface ShortcutDefinition {
  /** Stable unique identifier for the shortcut. */
  id: string;
  /** Human-readable action label, e.g. "Open command palette". */
  label: string;
  /** Preferred platform-abstract chord. */
  chord: ShortcutChord;
  /** Ordered fallback chords tried when the preferred chord cannot be bound. */
  fallbacks?: ShortcutChord[];
  /** Activation context; defaults to the global context when omitted. */
  context?: string;
  /** Invoked when the resolved chord fires. */
  handler: (event: KeyboardEvent) => void;
  /** Whether to call preventDefault when the shortcut fires. Defaults to true. */
  preventDefault?: boolean;
}

/** One active binding as reported by the enumeration API. */
export interface ActiveBinding {
  id: string;
  label: string;
  context: string;
  /** The chord actually bound (after platform resolution / fallback). */
  chord: ResolvedChord;
  /** The bound chord rendered for the active platform, e.g. "⌘K" / "Ctrl+K". */
  chordLabel: string;
  /** True when a declared fallback was used because the preferred chord could not bind. */
  usedFallback: boolean;
}

/** A shortcut that could not bind any chord on the active platform. */
export interface UnboundShortcut {
  id: string;
  label: string;
  context: string;
  reason: "reserved-no-fallback";
}

/** Outcome of a registration attempt. */
export type RegisterResult =
  | { status: "bound"; binding: ActiveBinding; unregister: () => void }
  | { status: "unbound"; shortcut: UnboundShortcut; unregister: () => void }
  | { status: "collision"; conflictId: string; chord: ResolvedChord; unregister: () => void };
