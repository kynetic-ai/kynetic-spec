export interface PlanTaskProgress {
  total: number;
  completed: number;
  in_progress: number;
  pending: number;
  blocked: number;
}

export interface PlanSummaryTask {
  status: string;
}

export function isCountedInPlanSummary(task: PlanSummaryTask): boolean {
  return task.status !== "cancelled";
}

export function countPlanTaskProgress(
  tasks: Iterable<PlanSummaryTask>,
): PlanTaskProgress {
  const progress: PlanTaskProgress = {
    total: 0,
    completed: 0,
    in_progress: 0,
    pending: 0,
    blocked: 0,
  };

  for (const task of tasks) {
    if (!isCountedInPlanSummary(task)) {
      continue;
    }

    progress.total += 1;

    switch (task.status) {
      case "completed":
        progress.completed += 1;
        break;
      case "in_progress":
      case "pending_review":
      case "needs_work":
        progress.in_progress += 1;
        break;
      case "blocked":
        progress.blocked += 1;
        break;
      default:
        progress.pending += 1;
        break;
    }
  }

  return progress;
}
