/**
 * Re-export SessionSyncScheduler from its canonical location in src/parser/.
 * The daemon server.ts imports from this file; the actual implementation
 * lives in src/parser/session-sync-scheduler.ts so that both daemon runtime
 * (via dist/parser/) and vitest tests can import the same production code.
 *
 * AC: @session-branch-worktree ac-sync
 */

export { SessionSyncScheduler } from "../parser/session-sync-scheduler.js";
export type {
  SessionSyncSchedulerOptions,
  SessionSyncPubSub,
} from "../parser/session-sync-scheduler.js";
