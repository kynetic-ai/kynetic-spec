/**
 * Module-level state for controlling pre-read shadow sync behavior.
 *
 * syncMode is set once per CLI command lifecycle in the preAction hook,
 * then consumed by initContext(). The consume-once pattern prevents
 * double-pull when preAction (via maybeAutoStartDaemon) and the action
 * handler both call initContext().
 *
 * Non-Commander callers (daemon, dispatch engine) that never call
 * setSyncMode() get 'drift-check' as the default.
 *
 * AC: @shadow-lazy-read-sync ac-syncmode-propagation
 * AC: @shadow-lazy-read-sync ac-syncmode-consume-once
 */

/** Controls pre-read sync behavior in initContext(). */
export type ShadowSyncMode =
  | "drift-check" // Default for reads: lightweight check, pull only if behind/diverged
  | "always" // Session start: unconditional shadowPull()
  | "skip"; // Mutating commands: no pre-read sync (commitIfShadow handles it)

let commandSyncMode: ShadowSyncMode | null = null;
let commandId = 0;
let consumedForCommand = -1;

/**
 * Set sync mode for the current CLI command lifecycle.
 * Called once in preAction. Increments commandId to scope consume-once.
 */
export function setSyncMode(mode: ShadowSyncMode): void {
  commandSyncMode = mode;
  commandId++;
  consumedForCommand = -1;
}

/**
 * Consume sync mode for the current command.
 * Returns the real mode on first call per commandId, then 'skip' for
 * subsequent calls (prevents double-pull when preAction and action
 * handler both call initContext).
 *
 * Non-Commander callers (daemon, dispatch engine) that never call
 * setSyncMode() get 'drift-check' as the default.
 */
export function consumeSyncMode(): ShadowSyncMode {
  // Non-Commander caller — no preAction set syncMode
  if (commandSyncMode === null) return "drift-check";

  // Already consumed for this command lifecycle
  if (consumedForCommand === commandId) return "skip";

  consumedForCommand = commandId;
  return commandSyncMode;
}

/**
 * Clear sync mode after a CLI command lifecycle completes (postAction hook).
 * This prevents stale state from leaking to non-Commander callers
 * (daemon, dispatch engine) that run initContext() later in the same process.
 *
 * AC: @shadow-lazy-read-sync ac-syncmode-propagation
 */
export function clearSyncMode(): void {
  commandSyncMode = null;
}

/**
 * Reset module state — for testing only.
 */
export function _resetSyncModeForTesting(): void {
  commandSyncMode = null;
  commandId = 0;
  consumedForCommand = -1;
}
