/**
 * Process-level fault handlers for the daemon.
 *
 * An uncaught exception or unhandled rejection would otherwise kill the
 * daemon with no diagnostics anywhere — stdio is discarded in detached
 * mode. These handlers log the failure through the daemon log tee (so the
 * message and stack land in daemon.log), write the durable last-exit
 * record, and exit non-zero.
 *
 * Installed by the daemon entry point (index.ts) before any async work
 * begins, so a rejection during startup is captured too.
 *
 * AC: @daemon-failure-observability ac-fatal-error-recorded
 */

import { writeDaemonLastExitRecord } from "./pid.js";

type FatalSource = "uncaughtException" | "unhandledRejection";

function handleFatalError(source: FatalSource, raw: unknown): void {
  const error = raw instanceof Error ? raw : new Error(String(raw));
  // console.error flows through the daemon console tee into daemon.log,
  // so the message + stack survive detached runs.
  console.error(`[daemon] Fatal ${source}:`, error.stack ?? error.message);
  writeDaemonLastExitRecord({
    kind: "fatal",
    reason: `${source}: ${error.message}`,
    stack: error.stack,
  });
  process.exit(1);
}

/**
 * Register the process-level fault handlers. Idempotent only in effect —
 * call once from the daemon entry point.
 *
 * AC: @daemon-failure-observability ac-fatal-error-recorded
 */
export function installDaemonFatalHandlers(): void {
  process.on("uncaughtException", (err) => handleFatalError("uncaughtException", err));
  process.on("unhandledRejection", (reason) => handleFatalError("unhandledRejection", reason));
}
