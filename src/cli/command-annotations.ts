/**
 * Command annotation registry for batch mode classification and sync mode.
 *
 * Uses WeakMaps to associate Commander commands with metadata
 * (mutating vs read-only, always-sync) without monkey-patching Commander internals.
 * GC-friendly: annotations are released when commands are collected.
 */

import type { Command } from "commander";
import type { CommandMeta } from "./introspection.js";

const annotations = new WeakMap<Command, { mutating: boolean }>();
const alwaysSyncAnnotations = new WeakMap<Command, boolean>();

/** Annotate a Commander command as mutating. Returns same instance for chaining. */
export function markMutating(cmd: Command): Command {
  annotations.set(cmd, { mutating: true });
  return cmd;
}

/** Read annotation for a command (used by extractCommandTree). */
export function getAnnotation(cmd: Command): { mutating: boolean } | undefined {
  return annotations.get(cmd);
}

/**
 * Annotate a Commander command as always-sync (bypasses drift check).
 * Used for commands like session start that need fresh remote state.
 * Returns same instance for chaining.
 *
 * AC: @shadow-lazy-read-sync ac-session-start-always-pulls
 */
export function markAlwaysSync(cmd: Command): Command {
  alwaysSyncAnnotations.set(cmd, true);
  return cmd;
}

/** Check if a command is annotated as always-sync. */
export function getAlwaysSyncAnnotation(cmd: Command): boolean {
  return alwaysSyncAnnotations.get(cmd) === true;
}

/** Read the mutating annotation as a boolean. */
export function getMutatingAnnotation(cmd: Command): boolean {
  return annotations.get(cmd)?.mutating === true;
}

/**
 * Factory for batch validation filter — allows only mutating commands.
 *
 * AC: @batch-allowed-commands ac-allowlist
 * AC: @batch-allowed-commands ac-denylist
 */
export function createBatchCommandFilter(): (cmd: CommandMeta) => boolean {
  return (cmd) => cmd.mutating === true;
}
