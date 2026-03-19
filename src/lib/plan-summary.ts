export interface PlanTaskProgress {
  total: number;
  completed: number;
  in_progress: number;
  pending: number;
  blocked: number;
}

export interface PlanSummaryPlan {
  _ulid: string;
  slugs: string[];
  derived_tasks: string[];
}

export interface PlanSummaryTask {
  _ulid: string;
  slugs: string[];
  plan_ref?: string | null;
  status: string;
}

function normalizeSummaryRef(ref: string | null | undefined): string | null {
  if (!ref) {
    return null;
  }
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

export function getLinkedPlanSummaryTasks<T extends PlanSummaryTask>(
  plan: PlanSummaryPlan,
  tasks: Iterable<T>,
): T[] {
  const linkedTaskRefs = new Set<string>();
  const linkedPlanRefs = new Set<string>([plan._ulid, ...plan.slugs]);
  const linkedTasks: T[] = [];

  for (const ref of plan.derived_tasks) {
    const normalizedRef = normalizeSummaryRef(ref);
    if (normalizedRef) {
      linkedTaskRefs.add(normalizedRef);
    }
  }

  for (const task of tasks) {
    const taskPlanRef = normalizeSummaryRef(task.plan_ref);
    const matchesPlanRef = taskPlanRef != null && linkedPlanRefs.has(taskPlanRef);
    const matchesDerivedTask =
      linkedTaskRefs.has(task._ulid) || task.slugs.some((slug) => linkedTaskRefs.has(slug));

    if (matchesPlanRef || matchesDerivedTask) {
      linkedTasks.push(task);
    }
  }

  return linkedTasks;
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
