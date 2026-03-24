/**
 * Periodic shadow branch sync for daemon mode.
 *
 * AC: @config-shadow ac-12 — The daemon performs a background shadow pull
 * at a configurable interval (default 60s) to pick up changes pushed by
 * other clones, making remote shadow state available locally without
 * requiring a manual `kspec shadow sync`.
 *
 * AC: @shadow-daemon-push-sync ac-periodic-push — After pulling, pushes
 * local commits if ahead of upstream. Push failure is non-fatal.
 *
 * AC: @shadow-daemon-push-sync ac-daemon-freshens-fetch-head — Fetch runs
 * from the worktree dir so FETCH_HEAD in the worktree git dir is fresh.
 */

import {
  shadowPull,
  hasRemoteTracking,
  fetchRemote,
  isAheadOfUpstream,
  pushShadowBranch,
  getRemoteName,
  type ShadowOptions,
} from "./shadow.js";

export interface ShadowSyncSchedulerOptions {
  /** Path to shadow worktree (e.g., /project/.kspec) */
  worktreeDir: string;
  /** Sync interval in seconds (0 = disabled) */
  intervalSeconds: number;
  /** Optional shadow options for branch/remote config */
  shadowOptions?: ShadowOptions;
  /** Optional pubsub manager for broadcasting sync events */
  pubsub?: ShadowSyncPubSub;
}

/**
 * Minimal pubsub interface for broadcasting sync events.
 * Matches PubSubManager.broadcast() without importing the full daemon type.
 */
export interface ShadowSyncPubSub {
  broadcast(channel: string, type: string, data: Record<string, unknown>): void;
}

/**
 * Manages periodic background shadow sync (fetch + pull + push) for the daemon.
 *
 * AC: @config-shadow ac-12
 * AC: @shadow-daemon-push-sync ac-periodic-push
 * AC: @shadow-daemon-push-sync ac-daemon-freshens-fetch-head
 */
export class ShadowSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly worktreeDir: string;
  private readonly intervalMs: number;
  private readonly shadowOptions?: ShadowOptions;
  private readonly pubsub?: ShadowSyncPubSub;

  constructor(options: ShadowSyncSchedulerOptions) {
    this.worktreeDir = options.worktreeDir;
    this.intervalMs = options.intervalSeconds * 1000;
    this.shadowOptions = options.shadowOptions;
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

    console.log(`[daemon] Shadow sync scheduler started (interval: ${this.intervalMs / 1000}s)`);

    this.timer = setInterval(() => {
      this.syncOnce().catch((err) => {
        console.error("[daemon] Shadow sync error:", err);
      });
    }, this.intervalMs);

    // Don't prevent process exit
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
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
      console.log("[daemon] Shadow sync scheduler stopped");
    }
  }

  /**
   * Perform a single sync cycle: fetch, pull, then push if ahead.
   * Skips if another sync is already in progress or no tracking configured.
   *
   * AC: @shadow-daemon-push-sync ac-daemon-freshens-fetch-head —
   * Fetch runs from worktreeDir so FETCH_HEAD in the worktree git dir
   * is fresh for CLI drift checks.
   *
   * AC: @shadow-daemon-push-sync ac-periodic-push —
   * After pulling, pushes if local is ahead of remote.
   * Push failure is non-fatal (logged, not thrown).
   */
  async syncOnce(): Promise<void> {
    if (this.running) {
      return; // Skip if previous sync still running
    }

    // Check if remote tracking is configured before attempting sync
    const hasTracking = await hasRemoteTracking(this.worktreeDir, this.shadowOptions);
    if (!hasTracking) {
      return; // No remote tracking — nothing to sync
    }

    this.running = true;
    try {
      // AC: @shadow-daemon-push-sync ac-daemon-freshens-fetch-head
      // Fetch from worktreeDir to freshen FETCH_HEAD in the worktree git dir.
      // CLI drift checks resolve FETCH_HEAD from the same worktree dir, so
      // the daemon's fetch keeps it fresh and CLI skips redundant fetches.
      await fetchRemote(this.worktreeDir, getRemoteName(this.shadowOptions));

      const result = await shadowPull(this.worktreeDir, this.shadowOptions);

      if (result.pulled) {
        console.log("[daemon] Shadow sync: pulled remote changes");

        // Broadcast so the UI refreshes
        if (this.pubsub) {
          this.pubsub.broadcast("shadow", "shadow_sync", {
            pulled: true,
            hadConflict: false,
          });
        }
      }

      if (result.hadConflict) {
        console.warn("[daemon] Shadow sync: conflict detected. Run `kspec shadow resolve` to fix.");

        if (this.pubsub) {
          this.pubsub.broadcast("shadow", "shadow_sync", {
            pulled: false,
            hadConflict: true,
          });
        }
      }

      // AC: @shadow-daemon-push-sync ac-periodic-push
      // After pulling, push if local has unpushed commits ahead of upstream.
      // Push failure is non-fatal — logged but does not throw.
      if (!result.hadConflict) {
        const ahead = await isAheadOfUpstream(this.worktreeDir);
        if (ahead) {
          const pushed = await pushShadowBranch(
            this.worktreeDir,
            getRemoteName(this.shadowOptions),
            this.shadowOptions,
          );
          if (pushed) {
            console.log("[daemon] Shadow sync: pushed local changes");
            if (this.pubsub) {
              this.pubsub.broadcast("shadow", "shadow_sync", {
                pushed: true,
              });
            }
          } else {
            console.warn("[daemon] Shadow sync: push failed (non-fatal)");
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
