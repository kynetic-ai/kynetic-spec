import {
  AlignmentIndex,
  ReferenceIndex,
  type LoadedSpecItem,
  type LoadedTask,
} from "../../parser/index.js";
import { getSessionCache } from "../../sessions/cache.js";
import type { SessionLogSummary } from "../../sessions/store.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

interface RelatedSessionsNotFound {
  error: "not_found";
  message: string;
  suggestion: string;
}

function sortSessions(sessions: SessionLogSummary[]): SessionLogSummary[] {
  return [...sessions].toSorted(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  );
}

function buildTaskRefSet(task: Pick<LoadedTask, "_ulid" | "slugs">): Set<string> {
  const refs = new Set<string>([task._ulid, `@${task._ulid}`]);
  for (const slug of task.slugs) {
    refs.add(slug);
    refs.add(`@${slug}`);
  }
  return refs;
}

function filterSessionsByTaskRefs(
  sessions: SessionLogSummary[],
  taskRefs: Set<string>,
): SessionLogSummary[] {
  return sessions.filter((session) => {
    if (!session.task_id) return false;
    const taskId = session.task_id.startsWith("@") ? session.task_id.slice(1) : session.task_id;
    return taskRefs.has(taskId) || taskRefs.has(session.task_id);
  });
}

/**
 * Get all session summaries, using entity cache when available.
 * AC: @daemon-entity-cache ac-serve-from-memory — use unified cache for sessions
 */
async function getAllSessionSummaries(
  sessionsDir: string,
  options?: { getEntityCache?: EntityCacheAccessor; projectPath?: string },
): Promise<SessionLogSummary[]> {
  const entityCache = options?.projectPath ? options.getEntityCache?.(options.projectPath) : null;
  const sessionsDomainReady = entityCache && entityCache.getDomainState("sessions") === "ready";
  if (sessionsDomainReady) {
    return entityCache!.getSessionIndex() ?? [];
  }
  // Fallback to standalone SessionSummaryCache
  const sessionCache = getSessionCache(sessionsDir);
  return sessionCache.getAll(sessionsDir);
}

export async function getRelatedSessionsForTask(params: {
  items: LoadedSpecItem[];
  tasks: LoadedTask[];
  taskRef: string;
  sessionsDir: string;
  getEntityCache?: EntityCacheAccessor;
  projectPath?: string;
}): Promise<
  { sessions: SessionLogSummary[]; task: LoadedTask } | { error: RelatedSessionsNotFound }
> {
  const { items, tasks, taskRef, sessionsDir } = params;
  const refIndex = new ReferenceIndex(tasks, items);
  const resolved = refIndex.resolve(taskRef);

  if (!resolved.ok) {
    return {
      error: {
        error: "not_found",
        message: `Task reference "${taskRef}" not found`,
        suggestion: "Use GET /api/tasks or kspec task list to find valid task references",
      },
    };
  }

  const task = tasks.find((candidate) => candidate._ulid === resolved.ulid);
  if (!task) {
    return {
      error: {
        error: "not_found",
        message: `Reference "${taskRef}" is not a task`,
        suggestion: "This reference might point to a spec item instead",
      },
    };
  }

  const sessions = await getAllSessionSummaries(sessionsDir, {
    getEntityCache: params.getEntityCache,
    projectPath: params.projectPath,
  });
  const filtered = filterSessionsByTaskRefs(sessions, buildTaskRefSet(task));

  return {
    task,
    sessions: sortSessions(filtered),
  };
}

export async function getRelatedSessionsForItem(params: {
  itemRef: string;
  items: LoadedSpecItem[];
  tasks: LoadedTask[];
  sessionsDir: string;
  getEntityCache?: EntityCacheAccessor;
  projectPath?: string;
}): Promise<
  { item: LoadedSpecItem; sessions: SessionLogSummary[] } | { error: RelatedSessionsNotFound }
> {
  const { itemRef, items, tasks, sessionsDir } = params;
  const refIndex = new ReferenceIndex(tasks, items);
  const alignmentIndex = new AlignmentIndex(tasks, items);
  alignmentIndex.buildLinks(refIndex);

  const resolved = refIndex.resolve(itemRef);
  if (!resolved.ok) {
    return {
      error: {
        error: "not_found",
        message: `Item reference "${itemRef}" not found`,
        suggestion: "Use GET /api/items or kspec item list to find valid item references",
      },
    };
  }

  const item = items.find((candidate) => candidate._ulid === resolved.ulid);
  if (!item) {
    return {
      error: {
        error: "not_found",
        message: `Reference "${itemRef}" is not a spec item`,
        suggestion: "This reference might point to a task instead",
      },
    };
  }

  const linkedTasks = alignmentIndex.getTasksForSpec(resolved.ulid);
  const taskRefs = new Set<string>();
  for (const task of linkedTasks) {
    for (const ref of buildTaskRefSet(task)) {
      taskRefs.add(ref);
    }
  }

  const sessions = await getAllSessionSummaries(sessionsDir, {
    getEntityCache: params.getEntityCache,
    projectPath: params.projectPath,
  });
  const filtered = filterSessionsByTaskRefs(sessions, taskRefs);

  return {
    item,
    sessions: sortSessions(filtered),
  };
}
