/**
 * Keyboard shortcut registry — public entry point.
 *
 * Surfaces register shortcuts through the shared `shortcutRegistry` singleton
 * and tear them down on component destroy. The root layout installs the single
 * document-level dispatcher. Future shortcut-help and command-palette surfaces
 * consume `shortcutRegistry.list()`.
 *
 * See @ui-shortcut-registry and @web-shell-platform-target.
 */

import { detectPlatform } from "./platform.js";
import { ShortcutRegistry } from "./registry.js";

export { ShortcutRegistry } from "./registry.js";
export { detectPlatform } from "./platform.js";
export {
  chordKey,
  eventToResolvedChord,
  hasPrimaryModifier,
  labelForChord,
  normalizeKey,
  resolveChord,
} from "./chord.js";
export { isReserved, reservedChords } from "./reserved.js";
export {
  GLOBAL_CONTEXT,
  type ActiveBinding,
  type Platform,
  type RegisterResult,
  type ResolvedChord,
  type ShortcutChord,
  type ShortcutDefinition,
  type UnboundShortcut,
} from "./types.js";

/** The application-wide shortcut registry, resolved for the detected platform. */
export const shortcutRegistry = new ShortcutRegistry(detectPlatform());
