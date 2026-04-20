/**
 * Multi-project shadow sync scheduler management.
 *
 * Lives in src/daemon/ (not packages/daemon/src/) so that both vitest and the
 * daemon build can import it without path resolution issues. The daemon build
 * compiles src/daemon/ into dist/daemon/ alongside packages/daemon/src/.
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
  if (shadowSyncSchedulers.has(projectPath)) {
    return;
  }

  const { loadProjectConfig } = await import("../parser/config.js");
  const { config } = await loadProjectConfig(projectPath);
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
}

/**
 * Stop shadow sync scheduler for a specific project.
 *
 * AC: @config-shadow ac-15 — background pulls stop when a project is removed
 */
export function stopShadowSyncForProject(projectPath: string): void {
  const scheduler = shadowSyncSchedulers.get(projectPath);
  if (scheduler) {
    scheduler.stop();
    shadowSyncSchedulers.delete(projectPath);
  }
}
