/**
 * Re-export multi-project shadow sync manager from its canonical location
 * in src/daemon/. The actual implementation lives there so that both vitest
 * and the daemon build (via staging copy) can import it with correct parser
 * path resolution. This shim exists so that server.ts's `./shadow-sync-manager.js`
 * import is present in the daemon package source tree.
 *
 * AC: @config-shadow ac-13, ac-14, ac-15, ac-16, ac-17
 */

export {
  shadowSyncSchedulers,
  startShadowSyncForProject,
  stopShadowSyncForProject,
  createShadowSyncOnPullHandler,
} from "../../../src/daemon/shadow-sync-manager.js";

export type {
  ShadowPullReloadableCache,
  ShadowSyncPubSub,
} from "../../../src/daemon/shadow-sync-manager.js";
