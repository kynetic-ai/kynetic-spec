/**
 * Session command module barrel.
 *
 * Re-exports public API from sub-modules. The registerSessionCommands function
 * wires everything up with commander.
 */

// Types — all types re-exported for consumers
export type {
  ActiveTaskSummary,
  ActivityItem,
  BlockedTaskSummary,
  CheckpointIssue,
  CheckpointOptions,
  CheckpointResult,
  CommitSummary,
  CompletedTaskSummary,
  InboxStats,
  InboxSummary,
  IterationStats,
  NoteSummary,
  ObservationSummary,
  ReadyTaskSummary,
  SessionContext,
  SessionContextComputed,
  SessionOptions,
  SessionStats,
  StopHookInput,
  TodoSummary,
} from "./types.js";

// Data gathering
export { gatherSessionContext, getIterationStats } from "./context.js";

// Checkpoint
export { performCheckpoint } from "./checkpoint.js";

// Formatting helpers (used by tests)
export { getDisplayRef, formatPriority, statusColor } from "./format.js";

// Command registration
export { registerSessionCommands } from "./commands.js";
