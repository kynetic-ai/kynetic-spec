/**
 * Session management commands — barrel re-export.
 *
 * The implementation has been split into focused modules under ./session/.
 * This file re-exports the public API for backward compatibility.
 */

export {
  // Types
  type ActiveTaskSummary,
  type ActivityItem,
  type BlockedTaskSummary,
  type CheckpointIssue,
  type CheckpointOptions,
  type CheckpointResult,
  type CommitSummary,
  type CompletedTaskSummary,
  type InboxStats,
  type InboxSummary,
  type IterationStats,
  type NoteSummary,
  type ObservationSummary,
  type ReadyTaskSummary,
  type SessionStartContext,
  type SessionContextComputed,
  type SessionOptions,
  type SessionStats,
  type StopHookInput,
  type TodoSummary,

  // Functions
  gatherSessionContext,
  getIterationStats,
  performCheckpoint,
  getDisplayRef,
  formatPriority,
  statusColor,
  registerSessionCommands,
} from "./session/index.js";
