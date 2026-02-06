/**
 * Command annotation registry for batch mode classification.
 *
 * Uses a WeakMap to associate Commander commands with metadata
 * (mutating vs read-only) without monkey-patching Commander internals.
 * GC-friendly: annotations are released when commands are collected.
 */

import type { Command } from "commander";
import type { CommandMeta } from "./introspection.js";

const annotations = new WeakMap<Command, { mutating: boolean }>();

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
 * Factory for batch validation filter — allows only mutating commands.
 *
 * AC: @batch-allowed-commands ac-allowlist
 * AC: @batch-allowed-commands ac-denylist
 */
export function createBatchCommandFilter(): (cmd: CommandMeta) => boolean {
  return (cmd) => cmd.mutating === true;
}
