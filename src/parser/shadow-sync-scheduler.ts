/**
 * Periodic shadow branch sync for daemon mode.
 *
 * AC: @config-shadow ac-12 — The daemon performs a background shadow pull
 * at a configurable interval (default 60s) to pick up changes pushed by
 * other clones, making remote shadow state available locally without
 * requiring a manual `kspec shadow sync`.
 */

import { shadowPull, hasRemoteTracking, type ShadowOptions } from './shadow.js';

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
 * Manages periodic background shadow pull for the daemon.
 *
 * AC: @config-shadow ac-12
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

    console.log(
      `[daemon] Shadow sync scheduler started (interval: ${this.intervalMs / 1000}s)`
    );

    this.timer = setInterval(() => {
      this.syncOnce().catch((err) => {
        console.error('[daemon] Shadow sync error:', err);
      });
    }, this.intervalMs);

    // Don't prevent process exit
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
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
      console.log('[daemon] Shadow sync scheduler stopped');
    }
  }

  /**
   * Perform a single sync (pull from remote).
   * Skips if another sync is already in progress or no tracking configured.
   */
  async syncOnce(): Promise<void> {
    if (this.running) {
      return; // Skip if previous sync still running
    }

    // Check if remote tracking is configured before attempting pull
    const hasTracking = await hasRemoteTracking(this.worktreeDir, this.shadowOptions);
    if (!hasTracking) {
      return; // No remote tracking — nothing to sync
    }

    this.running = true;
    try {
      const result = await shadowPull(this.worktreeDir, this.shadowOptions);

      if (result.pulled) {
        console.log('[daemon] Shadow sync: pulled remote changes');

        // Broadcast so the UI refreshes
        if (this.pubsub) {
          this.pubsub.broadcast('shadow', 'shadow_sync', {
            pulled: true,
            hadConflict: false,
          });
        }
      }

      if (result.hadConflict) {
        console.warn(
          '[daemon] Shadow sync: conflict detected. Run `kspec shadow resolve` to fix.'
        );

        if (this.pubsub) {
          this.pubsub.broadcast('shadow', 'shadow_sync', {
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
