/**
 * Bounded process-stop primitives shared by daemon-backed test helpers.
 *
 * Cleanup in test infrastructure must mean the same thing whether the caller
 * owns a ChildProcess handle (real daemon fixture, mock daemon child) or only
 * a pid (CLI lifecycle tests). The contract enforced here:
 *
 *   1. Send a graceful termination request (SIGTERM).
 *   2. Wait for the OWNED process to be observed terminated:
 *        - ChildProcess: exitCode OR signalCode is non-null, OR the parent
 *          handle's 'exit' event fires.
 *        - Pid-only: `process.kill(pid, 0)` throws ESRCH (no such process).
 *   3. If the graceful budget elapses without observed termination,
 *      escalate to SIGKILL.
 *   4. Wait again for observed termination within the escalation budget.
 *   5. If escalation also elapses without observation, throw a
 *      `BoundedProcessStopError` with diagnostics — never report success.
 *
 * Signal-only exits are treated as real exits even when `exitCode` remains
 * `null` and only `signalCode` is set. The fast-path checks both, so a child
 * killed via SIGKILL elsewhere does not block cleanup waiting for an exit
 * code that will never arrive.
 *
 * Idempotency: callers may invoke the helpers multiple times. The "already
 * observed exit" fast-path short-circuits both signaling and waiting so a
 * second call cannot kill an unrelated process that has taken over the pid.
 */

import type { ChildProcess } from "node:child_process";

// ── Public types ──────────────────────────────────────────────────────

export interface BoundedStopOptions {
  /** Budget for the graceful (SIGTERM) phase in ms. Defaults to 5000. */
  gracefulMs?: number;
  /** Budget for the escalated (SIGKILL) phase in ms. Defaults to 2000. */
  escalationMs?: number;
  /** Diagnostic label used in error messages. Defaults to "process". */
  label?: string;
}

export interface BoundedStopDiagnostics {
  label: string;
  pid: number | undefined;
  gracefulMs: number;
  escalationMs: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  escalated: boolean;
}

export class BoundedProcessStopError extends Error {
  readonly diagnostics: BoundedStopDiagnostics;
  constructor(diagnostics: BoundedStopDiagnostics) {
    super(
      `Bounded process stop failed: ${diagnostics.label} ` +
        `(pid=${diagnostics.pid ?? "<none>"}) not observed terminated after ` +
        `${diagnostics.gracefulMs}ms graceful + ${diagnostics.escalationMs}ms escalation ` +
        `(exitCode=${diagnostics.exitCode} signalCode=${diagnostics.signalCode ?? "<none>"})`,
    );
    this.name = "BoundedProcessStopError";
    this.diagnostics = diagnostics;
  }
}

// ── Internals ─────────────────────────────────────────────────────────

const DEFAULT_GRACEFUL_MS = 5_000;
const DEFAULT_ESCALATION_MS = 2_000;

/**
 * Whether a ChildProcess handle has observed termination.
 *
 * Returns true when EITHER exitCode or signalCode is non-null. Treating
 * signalCode as an exit indicator equivalent to exitCode is the fix for the
 * signal-exit race: a child killed by signal has `exitCode === null` and
 * `signalCode !== null`, and the exit IS observable even though the code is
 * unset.
 */
export function hasObservedChildExit(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until the ChildProcess handle observes termination, the budget
 * elapses, or the predicate already reports termination. Resolves with the
 * observation state.
 */
function waitForChildExitObservation(
  child: ChildProcess,
  budgetMs: number,
): Promise<{ observed: boolean }> {
  return new Promise((resolve) => {
    if (hasObservedChildExit(child)) {
      resolve({ observed: true });
      return;
    }
    let settled = false;
    const finalize = (observed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve({ observed });
    };
    const onExit = (): void => finalize(true);
    const timer = setTimeout(() => finalize(hasObservedChildExit(child)), budgetMs);
    child.once("exit", onExit);
  });
}

/**
 * Wait until the OS reports the pid is no longer alive (kill(pid, 0) throws
 * ESRCH), or the budget elapses. Polls because the parent has no handle to
 * receive an 'exit' event for an unowned pid.
 *
 * The poll interval is 25ms — small enough that the helper does not add
 * meaningful latency to a cooperating process, large enough that the busy
 * loop does not dominate the event loop on a hung child.
 */
function waitForPidReap(pid: number, budgetMs: number): Promise<{ observed: boolean }> {
  return new Promise((resolve) => {
    if (!isPidAlive(pid)) {
      resolve({ observed: true });
      return;
    }
    const POLL_INTERVAL_MS = 25;
    const deadline = Date.now() + budgetMs;
    const tick = (): void => {
      if (!isPidAlive(pid)) {
        resolve({ observed: true });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ observed: false });
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    setTimeout(tick, POLL_INTERVAL_MS);
  });
}

function sendChildSignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (hasObservedChildExit(child)) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function sendPidSignal(pid: number, signal: NodeJS.Signals): boolean {
  if (!isPidAlive(pid)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Stop a ChildProcess handle within bounded time, observing termination
 * before reporting success.
 *
 * Sends SIGTERM, waits up to `gracefulMs` for an observed exit, escalates
 * to SIGKILL on timeout, and waits up to `escalationMs` for the resulting
 * exit observation. Throws `BoundedProcessStopError` only if escalation
 * also fails to observe termination — never resolves while the child is
 * still observably running.
 *
 * Idempotent: a child that has already exited returns immediately without
 * signaling, so a second call cannot kill a process that has reused the pid.
 */
export async function stopChildProcessBounded(
  child: ChildProcess,
  options: BoundedStopOptions = {},
): Promise<void> {
  const gracefulMs = options.gracefulMs ?? DEFAULT_GRACEFUL_MS;
  const escalationMs = options.escalationMs ?? DEFAULT_ESCALATION_MS;
  const label = options.label ?? "child";

  if (hasObservedChildExit(child)) return;

  // If the OS never spawned the child (e.g. ENOENT before .pid was assigned),
  // there is no process to wait on and no exit event will fire. Return
  // immediately so callers with launch failures stay bounded — sending a
  // signal to a missing pid would also throw.
  if (child.pid === undefined) return;

  sendChildSignal(child, "SIGTERM");
  let observation = await waitForChildExitObservation(child, gracefulMs);
  let escalated = false;
  if (!observation.observed) {
    escalated = true;
    sendChildSignal(child, "SIGKILL");
    observation = await waitForChildExitObservation(child, escalationMs);
  }
  if (!observation.observed) {
    throw new BoundedProcessStopError({
      label,
      pid: child.pid,
      gracefulMs,
      escalationMs,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      escalated,
    });
  }
}

/**
 * Stop a pid-only owned process within bounded time, observing termination
 * before reporting success.
 *
 * Mirrors `stopChildProcessBounded` for callers that hold a raw pid rather
 * than a ChildProcess handle. Polls liveness via `process.kill(pid, 0)`.
 * Idempotent: an already-reaped pid is a no-op.
 */
export async function stopPidBounded(
  pid: number,
  options: BoundedStopOptions = {},
): Promise<void> {
  const gracefulMs = options.gracefulMs ?? DEFAULT_GRACEFUL_MS;
  const escalationMs = options.escalationMs ?? DEFAULT_ESCALATION_MS;
  const label = options.label ?? "pid";

  if (!isPidAlive(pid)) return;

  sendPidSignal(pid, "SIGTERM");
  let observation = await waitForPidReap(pid, gracefulMs);
  let escalated = false;
  if (!observation.observed) {
    escalated = true;
    sendPidSignal(pid, "SIGKILL");
    observation = await waitForPidReap(pid, escalationMs);
  }
  if (!observation.observed) {
    throw new BoundedProcessStopError({
      label,
      pid,
      gracefulMs,
      escalationMs,
      exitCode: null,
      signalCode: null,
      escalated,
    });
  }
}
