import type { AgentDispatchStatus, DispatchTaskControl } from "./api";

export type GlobalLifecycleAction = "start" | "pause" | "resume" | "stop";
export type TaskLifecycleAction = "pause" | "resume" | "stop";

export const HARD_STOP_CONFIRMATION = {
  title: "Confirm hard stop",
  description:
    "Active matching invocations will be cancelled. Session, branch, workspace, worktree, snapshot, and audit evidence will be preserved.",
} as const;

function hasGlobalCleanup(status: AgentDispatchStatus): boolean {
  return status.cleanupState.entries.some((entry) => entry.scope === "global");
}

function hasMatchingTaskCleanup(control: DispatchTaskControl): boolean {
  return control.cleanupState.entries.some(
    (entry) => entry.scope === "task" && entry.taskId === control.taskId,
  );
}

export function getGlobalLifecycleActions(status: AgentDispatchStatus): GlobalLifecycleAction[] {
  if (status.globalAuthority === "running") return ["pause", "stop"];
  if (status.globalAuthority === "paused") return ["resume", "stop"];
  return hasGlobalCleanup(status) ? ["stop"] : ["start"];
}

export function getTaskLifecycleActions(
  status: AgentDispatchStatus,
  taskId: string,
): TaskLifecycleAction[] {
  const control = status.taskControls.find((candidate) => candidate.taskId === taskId);
  if (!control) return ["pause", "stop"];
  if (control.mode === "paused") return ["resume", "stop"];
  return hasMatchingTaskCleanup(control) ? ["stop"] : ["resume"];
}

export function getLifecycleBadge(status: AgentDispatchStatus): string {
  if (status.globalAuthority === "running") return "Running";
  if (status.globalAuthority === "paused") {
    return status.projection === "draining" ? "Paused — draining" : "Paused";
  }
  if (hasGlobalCleanup(status)) {
    return status.cleanupState.entries.some(
      (entry) => entry.scope === "global" && entry.status === "failed",
    )
      ? "Stopped — cleanup failed"
      : "Stopped — cleanup pending";
  }
  return "Stopped";
}

export function getGlobalActionLabel(
  status: AgentDispatchStatus,
  action: GlobalLifecycleAction,
): string {
  if (action === "start") return "Start";
  if (action === "pause") return "Pause";
  if (action === "resume") return "Resume";
  return hasGlobalCleanup(status) ? "Retry hard stop" : "Hard stop";
}

export function getTaskActionLabel(
  status: AgentDispatchStatus,
  taskId: string,
  action: TaskLifecycleAction,
): string {
  if (action === "pause") return "Pause task";
  if (action === "resume") return "Resume task";
  const control = status.taskControls.find((candidate) => candidate.taskId === taskId);
  return control?.mode === "stopped" && hasMatchingTaskCleanup(control)
    ? "Retry hard stop"
    : "Hard-stop task";
}
