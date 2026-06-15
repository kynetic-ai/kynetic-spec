/**
 * Board utility functions for Kanban column logic.
 *
 * AC: @ui-task-board ac-1 — Column distribution logic
 */

import type { TaskSummary } from "@kynetic-ai/shared";

export type ColumnId = "backlog" | "ready" | "in_progress" | "review" | "done";

export interface BoardColumn {
  id: ColumnId;
  label: string;
  tasks: TaskSummary[];
}

/**
 * Distribute tasks into Kanban columns.
 *
 * AC: @ui-task-board ac-1
 * - Backlog: pending + manual_only or unassessed automation
 * - Ready: pending + eligible automation
 * - In Progress: in_progress + needs_work
 * - Review: pending_review
 * - Done: completed (recent — last 20)
 *
 * Blocked and cancelled are indicators on individual cards, not separate columns.
 */
export function distributeToColumns(tasks: TaskSummary[]): BoardColumn[] {
  const backlog: TaskSummary[] = [];
  const ready: TaskSummary[] = [];
  const inProgress: TaskSummary[] = [];
  const review: TaskSummary[] = [];
  const done: TaskSummary[] = [];

  for (const task of tasks) {
    switch (task.status) {
      case "pending": {
        const auto = task.automation;
        if (auto === "eligible") {
          ready.push(task);
        } else {
          // manual_only, unassessed, or undefined → backlog
          backlog.push(task);
        }
        break;
      }
      case "in_progress":
      case "needs_work":
        inProgress.push(task);
        break;
      case "pending_review":
        review.push(task);
        break;
      case "completed":
        done.push(task);
        break;
      case "blocked":
        // Show blocked tasks in their original column context (in_progress column)
        inProgress.push(task);
        break;
      case "cancelled":
        // Show cancelled tasks in done column with indicator
        done.push(task);
        break;
    }
  }

  // Sort by priority (lower = higher priority)
  const byPriority = (a: TaskSummary, b: TaskSummary) => a.priority - b.priority;
  backlog.sort(byPriority);
  ready.sort(byPriority);
  inProgress.sort(byPriority);
  review.sort(byPriority);

  // Done: most recent first, limit to 20
  done.sort((a, b) => {
    const aTime = new Date(a.started_at || a.created_at).getTime();
    const bTime = new Date(b.started_at || b.created_at).getTime();
    return bTime - aTime;
  });
  const recentDone = done.slice(0, 20);

  return [
    { id: "backlog", label: "Backlog", tasks: backlog },
    { id: "ready", label: "Ready", tasks: ready },
    { id: "in_progress", label: "In Progress", tasks: inProgress },
    { id: "review", label: "Review", tasks: review },
    { id: "done", label: "Done", tasks: recentDone },
  ];
}

/**
 * Format a relative age string from a date.
 */
export function formatAge(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 30) return `${diffDays}d`;
  return `${Math.floor(diffDays / 30)}mo`;
}

/**
 * Format elapsed milliseconds to human-readable string.
 */
export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);

  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

/**
 * Parse a VCS ref string into a display label and optional URL.
 *
 * AC: @ui-task-board ac-3 — VCS info with branch/PR links.
 *
 * VCS refs can be:
 * - "branch:feat/my-feature" → branch label
 * - "pr:123" or "pr:https://github.com/..." → PR link
 * - "https://github.com/..." → direct URL
 * - Plain text → displayed as-is
 */
export function formatVcsRef(ref: string): { label: string; url: string | null } {
  // "branch:name" format
  if (ref.startsWith("branch:")) {
    return { label: ref.slice(7), url: null };
  }

  // "pr:123" or "pr:URL" format
  if (ref.startsWith("pr:")) {
    const value = ref.slice(3);
    if (value.startsWith("http")) {
      return { label: `PR ${value.split("/").pop()}`, url: value };
    }
    return { label: `PR #${value}`, url: null };
  }

  // Direct URL
  if (ref.startsWith("http")) {
    // Extract meaningful label from GitHub-style URLs
    const prMatch = ref.match(/\/pull\/(\d+)/);
    if (prMatch) {
      return { label: `PR #${prMatch[1]}`, url: ref };
    }
    return { label: ref.split("/").slice(-1)[0] || ref, url: ref };
  }

  // Plain text
  return { label: ref, url: null };
}
