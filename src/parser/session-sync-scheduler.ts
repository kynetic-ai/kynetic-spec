/**
 * Periodic session branch sync for daemon mode.
 *
 * Mirrors ShadowSyncScheduler but operates independently on the session branch.
 * Sync failures on one branch do not affect the other.
 *
 * AC: @session-branch-worktree ac-sync
 */

import {
  sessionBranchPull,
  type SessionBranchConfig,
} from "./session-branch.js";
import { hasRemoteTracking, type ShadowOptions } from "./shadow.js";

export interface SessionSyncSchedulerOptions {
  /** Path to session worktree (e.g., /project/.kspec-sessions) */
  worktreeDir: string;
  /** Sync interval in seconds (0 = disabled) */
  intervalSeconds: number;
  /** Session branch name */
  branchName: string;
  /** Optional pubsub manager for broadcasting sync events */
  pubsub?: SessionSyncPubSub;
}

/**
 * Minimal pubsub interface for broadcasting sync events.
 */
export interface SessionSyncPubSub {
  broadcast(
    channel: string,
    type: string,
    data: Record<string, unknown>,
  ): void;
}

/**
 * Manages periodic background session branch pull for the daemon.
 *
 * AC: @session-branch-worktree ac-sync
 */
export class SessionSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly worktreeDir: string;
  private readonly intervalMs: number;
  private readonly branchName: string;
  private readonly pubsub?: SessionSyncPubSub;

  constructor(options: SessionSyncSchedulerOptions) {
    this.worktreeDir = options.worktreeDir;
    this.intervalMs = options.intervalSeconds * 1000;
    this.branchName = options.branchName;
    this.pubsub = options.pubsub;
  }

  /**
   * Start the periodic sync scheduler.
   * Does nothing if interval is 0 or already started.
   */
  start(): void {
    if (this.intervalMs <= 0 || this.timer !== null) {
      return;
    }

    console.log(
      `[daemon] Session sync scheduler started (interval: ${this.intervalMs / 1000}s)`,
    );

    this.timer = setInterval(() => {
      this.syncOnce().catch((err) => {
        console.error("[daemon] Session sync error:", err);
      });
    }, this.intervalMs);

    // Don't prevent process exit
    if (
      this.timer &&
      typeof this.timer === "object" &&
      "unref" in this.timer
    ) {
      this.timer.unref();
    }
  }

  /**
   * Stop the periodic sync scheduler.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[daemon] Session sync scheduler stopped");
    }
  }

  /**
   * Perform a single sync (pull from remote).
   * Skips if another sync is already in progress or no tracking configured.
   */
  async syncOnce(): Promise<void> {
    if (this.running) {
      return;
    }

    const options: ShadowOptions = { branchName: this.branchName };
    const hasTracking = await hasRemoteTracking(this.worktreeDir, options);
    if (!hasTracking) {
      return;
    }

    this.running = true;
    try {
      const result = await sessionBranchPull(
        this.worktreeDir,
        this.branchName,
      );

      if (result.pulled) {
        console.log("[daemon] Session sync: pulled remote changes");

        if (this.pubsub) {
          this.pubsub.broadcast("sessions", "session_sync", {
            pulled: true,
            hadConflict: false,
          });
        }
      }

      if (result.hadConflict) {
        console.warn(
          "[daemon] Session sync: conflict detected. Run `kspec shadow resolve` to fix.",
        );

        if (this.pubsub) {
          this.pubsub.broadcast("sessions", "session_sync", {
            pulled: false,
            hadConflict: true,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
