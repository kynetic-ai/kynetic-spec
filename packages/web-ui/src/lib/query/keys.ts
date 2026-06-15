/**
 * Query Key Factories
 *
 * Centralized query key definitions for TanStack Query.
 * Hierarchical structure enables targeted invalidation.
 *
 * Pattern: entity → list (with filters) → detail
 * Invalidating ['tasks'] invalidates all task queries.
 * Invalidating ['tasks', { status: 'pending' }] targets only that filter.
 */

export const queryKeys = {
  tasks: {
    all: ["tasks"] as const,
    lists: () => [...queryKeys.tasks.all, "list"] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.tasks.lists(), filters] as const,
    detail: (ref: string) => [...queryKeys.tasks.all, "detail", ref] as const,
    summary: () => [...queryKeys.tasks.all, "summary"] as const,
  },

  inbox: {
    all: ["inbox"] as const,
    lists: () => [...queryKeys.inbox.all, "list"] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.inbox.lists(), filters] as const,
    merged: () => [...queryKeys.inbox.all, "merged"] as const,
    count: () => [...queryKeys.inbox.all, "count"] as const,
  },

  observations: {
    all: ["observations"] as const,
    lists: () => [...queryKeys.observations.all, "list"] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.observations.lists(), filters] as const,
    count: (filters?: Record<string, unknown>) =>
      [...queryKeys.observations.all, "count", filters] as const,
  },

  sessionContext: {
    all: ["sessionContext"] as const,
    current: () => [...queryKeys.sessionContext.all, "current"] as const,
  },

  validation: {
    all: ["validation"] as const,
    results: () => [...queryKeys.validation.all, "results"] as const,
    alignment: () => [...queryKeys.validation.all, "alignment"] as const,
    aggregation: () => [...queryKeys.validation.all, "aggregation"] as const,
  },

  agents: {
    all: ["agents"] as const,
    status: () => [...queryKeys.agents.all, "status"] as const,
    definitions: () => [...queryKeys.agents.all, "definitions"] as const,
  },

  items: {
    all: ["items"] as const,
    lists: () => [...queryKeys.items.all, "list"] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.items.lists(), filters] as const,
    detail: (ref: string) => [...queryKeys.items.all, "detail", ref] as const,
  },

  sessions: {
    all: ["sessions"] as const,
    lists: () => [...queryKeys.sessions.all, "list"] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.sessions.lists(), filters] as const,
    detail: (id: string) => [...queryKeys.sessions.all, "detail", id] as const,
    eventDetail: (id: string, seq: number) =>
      [...queryKeys.sessions.all, "eventDetail", id, seq] as const,
  },

  reviews: {
    all: ["reviews"] as const,
    lists: () => [...queryKeys.reviews.all, "list"] as const,
    list: (filters?: Record<string, unknown>) => [...queryKeys.reviews.lists(), filters] as const,
    forTask: (taskRef: string) => [...queryKeys.reviews.all, "forTask", taskRef] as const,
    detail: (ref: string) => [...queryKeys.reviews.all, "detail", ref] as const,
    content: (ref: string) => [...queryKeys.reviews.all, "content", ref] as const,
    siblings: (filters: { subject_type: string; subject_ref?: string; head_branch?: string }) =>
      [...queryKeys.reviews.all, "siblings", filters] as const,
  },

  diff: {
    all: ["diff"] as const,
    full: (base: string, head: string) => [...queryKeys.diff.all, "full", base, head] as const,
    file: (base: string, head: string, path: string) =>
      [...queryKeys.diff.all, "file", base, head, path] as const,
    context: (base: string, head: string, path: string, start: number, end: number) =>
      [...queryKeys.diff.all, "context", base, head, path, start, end] as const,
  },

  automation: {
    all: ["automation"] as const,
    hooks: () => [...queryKeys.automation.all, "hooks"] as const,
    schedules: () => [...queryKeys.automation.all, "schedules"] as const,
    scheduleStatus: (id: string) => [...queryKeys.automation.all, "scheduleStatus", id] as const,
    events: (filters?: Record<string, unknown>) =>
      [...queryKeys.automation.all, "events", filters] as const,
    compositionConfigs: () => [...queryKeys.automation.all, "compositionConfigs"] as const,
    compositionActivations: (configId: string) =>
      [...queryKeys.automation.all, "compositionActivations", configId] as const,
  },

  plans: {
    all: ["plans"] as const,
    lists: () => [...queryKeys.plans.all, "list"] as const,
    detail: (ref: string) => [...queryKeys.plans.all, "detail", ref] as const,
    content: (ref: string) => [...queryKeys.plans.all, "content", ref] as const,
  },

  workflows: {
    all: ["workflows"] as const,
  },

  identity: {
    all: ["identity"] as const,
    config: () => [...queryKeys.identity.all, "config"] as const,
  },

  settings: {
    all: ["settings"] as const,
    health: () => [...queryKeys.settings.all, "health"] as const,
    projectConfig: () => [...queryKeys.settings.all, "projectConfig"] as const,
    shadow: () => [...queryKeys.settings.all, "shadow"] as const,
    conventions: () => [...queryKeys.settings.all, "conventions"] as const,
    session: () => [...queryKeys.settings.all, "session"] as const,
  },
} as const;
