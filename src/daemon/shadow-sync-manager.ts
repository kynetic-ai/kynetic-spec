/**
 * Multi-project shadow sync scheduler management.
 *
 * Lives in src/daemon/ so that both vitest and the daemon build can import it
 * with correct parser path resolution. The daemon build (scripts/build-daemon.cjs)
 * copies this file into the staging directory alongside packages/daemon/src/.
 * A re-export shim at packages/daemon/src/shadow-sync-manager.ts makes the
 * import visible in the daemon package source tree for IDE navigation.
 *
 * AC: @config-shadow ac-13, ac-14, ac-15, ac-16, ac-17
 */

import { join } from "path";
import {
  ShadowSyncScheduler,
  type ShadowSyncPubSub,
} from "../parser/shadow-sync-scheduler.js";

export type { ShadowSyncPubSub } from "../parser/shadow-sync-scheduler.js";

export interface ShadowPullReloadableCache {
  refreshMetaShadowInfo(): Promise<void>;
}

// AC: @config-shadow ac-13 — per-project shadow sync schedulers
export const shadowSyncSchedulers: Map<string, ShadowSyncScheduler> = new Map();

// Serializes concurrent starts per project to prevent TOCTOU races (ac-16)
const inFlightStarts: Map<string, Promise<void>> = new Map();

// Tracks projects whose stop was called while a start was in-flight (ac-15).
// If doStart() finds its project in this set after the async config load,
// it skips scheduler installation so the stop is not silently lost.
const cancelledStarts: Set<string> = new Set();

/**
 * Create a per-project onPull handler that refreshes the correct project's
 * shadow metadata cache after a successful pull.
 *
 * AC: @config-shadow ac-13 — per-project cache refresh
 */
export function createShadowSyncOnPullHandler(
  projectPath: string,
  getEntityCache: (projectPath: string) => ShadowPullReloadableCache | undefined,
): () => Promise<void> {
  return async () => {
    const cache = getEntityCache(projectPath);
    if (!cache) return;
    console.log(`[daemon] Shadow sync pulled data for ${projectPath} — refreshing shadow status`);
    await cache.refreshMetaShadowInfo();
  };
}

/**
 * Start a shadow sync scheduler for a project if it has remote tracking configured.
 * Safe to call multiple times — skips if scheduler already exists for that project.
 *
 * AC: @config-shadow ac-13 — every registered project with remote tracking gets background pulls
 * AC: @config-shadow ac-14 — projects registered after startup get background pulls
 * AC: @config-shadow ac-16 — idempotent: re-registration does not create duplicate schedulers
 */
export async function startShadowSyncForProject(
  projectPath: string,
  pubsub: ShadowSyncPubSub,
  getEntityCache: (projectPath: string) => ShadowPullReloadableCache | undefined,
): Promise<void> {
  // Fast path: scheduler already running
  if (shadowSyncSchedulers.has(projectPath)) {
    return;
  }

  // Serialize concurrent starts for the same project (ac-16).
  // If another call is already in flight, await its completion rather than
  // racing through the async config load and creating a duplicate scheduler.
  const existing = inFlightStarts.get(projectPath);
  if (existing) {
    await existing;
    return;
  }

  const doStart = async (): Promise<void> => {
    // Re-check after acquiring the slot — a previous in-flight call may have
    // already created the scheduler before we were scheduled.
    if (shadowSyncSchedulers.has(projectPath)) {
      return;
    }

    const { loadProjectConfig } = await import("../parser/config.js");
    const { config } = await loadProjectConfig(projectPath);

    // After the async config load, check whether stopShadowSyncForProject was
    // called while we were awaiting.  If so, abandon the start so the stop is
    // not silently lost.  (ac-15: stop-during-in-flight-start race)
    if (cancelledStarts.has(projectPath)) {
      return;
    }

    const syncInterval = config.shadow.sync_interval;
    const worktreeDir = join(projectPath, config.shadow.directory);

    if (syncInterval > 0 && config.shadow.remote) {
      const scheduler = new ShadowSyncScheduler({
        worktreeDir,
        intervalSeconds: syncInterval,
        shadowOptions: {
          branchName: config.shadow.branch,
          directory: config.shadow.directory,
          remote: config.shadow.remote?.value,
          remoteType: config.shadow.remote?.type,
        },
        pubsub,
        onPull: createShadowSyncOnPullHandler(projectPath, getEntityCache),
      });
      scheduler.start();
      shadowSyncSchedulers.set(projectPath, scheduler);
    }
  };

  const promise = doStart();
  inFlightStarts.set(projectPath, promise);
  try {
    await promise;
  } finally {
    inFlightStarts.delete(projectPath);
    cancelledStarts.delete(projectPath);
  }
}

/**
 * Stop shadow sync scheduler for a specific project.
 *
 * If a start is currently in-flight (awaiting config load), marks it as
 * cancelled so the start will abandon scheduler installation when it resumes.
 * This prevents the race where stop runs while start is suspended on an await,
 * finds no scheduler, and returns — allowing the start to later install a
 * scheduler for an already-unregistered project.
 *
 * AC: @config-shadow ac-15 — background pulls stop when a project is removed
 */
export function stopShadowSyncForProject(projectPath: string): void {
  // Signal any in-flight start to abort after its async work completes.
  if (inFlightStarts.has(projectPath)) {
    cancelledStarts.add(projectPath);
  }

  const scheduler = shadowSyncSchedulers.get(projectPath);
  if (scheduler) {
    scheduler.stop();
    shadowSyncSchedulers.delete(projectPath);
  }
}
