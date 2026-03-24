/**
 * Re-export ShadowSyncScheduler from its canonical location in src/parser/.
 * The daemon server.ts imports from this file; the actual implementation
 * lives in src/parser/shadow-sync-scheduler.ts so that both daemon runtime
 * (via dist/parser/) and vitest tests can import the same production code.
 *
 * AC: @config-shadow ac-12
 */

export { ShadowSyncScheduler } from "../parser/shadow-sync-scheduler.js";
export type {
  ShadowSyncSchedulerOptions,
  ShadowSyncPubSub,
} from "../parser/shadow-sync-scheduler.js";
