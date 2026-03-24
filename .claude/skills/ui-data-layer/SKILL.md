---
name: ui-data-layer
description: Svelte + TanStack Query v6 data fetching patterns. Use when
  building or migrating web UI data fetching, cache management, WebSocket
  invalidation, or query/mutation patterns.
---

<!-- kspec-managed -->

# UI Data Layer — Svelte + TanStack Query

Patterns and conventions for the web UI data fetching layer. Covers TanStack Query v6 setup, query factories, WebSocket-driven cache invalidation, mutations, and migration from manual fetch patterns.

**Companion to:** `/svelte-5` skill (reactivity, SSR, state management). This skill covers the data layer specifically.

## Technology Choice

**@tanstack/svelte-query v6** — Svelte 5 runes-native (~13 kB gzip).

Key capabilities used in this project:

- Automatic caching with stale-while-revalidate
- Request deduplication (concurrent identical requests share one fetch)
- Background revalidation on navigation
- Query invalidation via `queryClient.invalidateQueries()`
- Direct cache updates via `queryClient.setQueryData()`
- Infinite queries for paginated data (`createInfiniteQuery`)

**Requires:** Svelte >= 5.25.0

### References

- [TanStack Query Svelte Overview](https://tanstack.com/query/v5/docs/framework/svelte/overview)
- [v5 → v6 Migration Guide](https://tanstack.com/query/v5/docs/framework/svelte/migrate-from-v5-to-v6)
- [createQuery API Reference](https://tanstack.com/query/v5/docs/framework/svelte/reference/functions/createquery)
- [createInfiniteQuery API Reference](https://tanstack.com/query/v5/docs/framework/svelte/reference/functions/createInfiniteQuery)
- [createMutation API Reference](https://tanstack.com/query/v5/docs/framework/svelte/reference/functions/createmutation)
- [SSR & SvelteKit Guide](https://tanstack.com/query/v5/docs/framework/svelte/ssr)

## Quick Reference

| Need                              | Pattern                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Fetch and cache data              | `createQuery(() => ({ queryKey, queryFn }))`                                             |
| Paginated / infinite scroll       | `createInfiniteQuery(() => ({ queryKey, queryFn, getNextPageParam, initialPageParam }))` |
| Write operation with cache update | `createMutation(() => ({ mutationFn, onSuccess: invalidate }))`                          |
| Invalidate after WS event         | `queryClient.invalidateQueries({ queryKey: ['tasks'] })`                                 |
| Update cache without refetch      | `queryClient.setQueryData(['tasks', ref], newData)`                                      |
| Clear all cache (project switch)  | `queryClient.clear()`                                                                    |
| Access QueryClient in component   | `useQueryClient()`                                                                       |

## Setup

### QueryClient Configuration

```typescript
// src/lib/query/client.ts
import { QueryClient } from "@tanstack/svelte-query";

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Localhost daemon — data changes via WS events, not staleness
        staleTime: 30_000, // 30s — lists and frequently changing data
        gcTime: 10 * 60_000, // 10min — keep in memory for session
        retry: 1, // Localhost: one retry is enough
        retryDelay: 500, // Short delay — daemon is local
        refetchOnWindowFocus: false, // WS events handle freshness
      },
    },
  });
}
```

### Provider in Root Layout

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { createAppQueryClient } from '$lib/query/client';

  const queryClient = createAppQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <slot />
</QueryClientProvider>
```

## v6 API — Thunk Pattern (Critical)

In v6, **all query/mutation functions take a thunk** (function returning options), not a plain object. This enables Svelte 5 runes reactivity without stores.

```typescript
// v5 (WRONG in v6)
const query = createQuery({
  queryKey: ["tasks"],
  queryFn: fetchTasks,
});

// v6 (CORRECT) — options wrapped in () => ({...})
const query = createQuery(() => ({
  queryKey: ["tasks"],
  queryFn: fetchTasks,
}));
```

**Why:** The thunk is re-executed when reactive dependencies inside it change. This is how reactive query keys work — Svelte's fine-grained reactivity tracks which `$state`/`$derived` values the thunk reads.

### Accessing Query Results

v6 returns a plain object (not a Svelte store). No `$` prefix needed:

```svelte
<script lang="ts">
  const tasks = createQuery(() => ({
    queryKey: ['tasks'],
    queryFn: () => fetchTasks(),
  }));
</script>

<!-- Direct property access — no $tasks needed -->
{#if tasks.isPending}
  <Loading />
{:else if tasks.isError}
  <Error message={tasks.error.message} />
{:else}
  {#each tasks.data.items as task}
    <TaskRow {task} />
  {/each}
{/if}
```

### Reactive Query Keys

When the query key depends on reactive state, include the state in the thunk:

```svelte
<script lang="ts">
  import { page } from '$app/stores';

  let status = $derived($page.url.searchParams.get('status') ?? 'all');

  const tasks = createQuery(() => ({
    queryKey: ['tasks', { status }],
    queryFn: () => fetchTasks({ status }),
    enabled: true,
  }));
</script>
```

When `status` changes (via URL param), the thunk re-runs, producing a new queryKey. TanStack Query detects the key change and fetches fresh data.

## Query Key Conventions

### Naming Pattern

Use hierarchical arrays with entity type first, then qualifiers:

```typescript
// Entity lists
["tasks"][("tasks", { status: "pending", tag: "web-ui" })]["items"][("items", { type: "feature" })][
  "inbox"
][("sessions", { status: "active" })][
  // Entity detail
  ("tasks", ref)
][("items", ref)][("sessions", sessionId)][ // e.g. ['tasks', '@task-add-auth']
  // Aggregations / summaries
  ("tasks", "summary")
]["validation"]["alignment"][ // Status counts
  // Lightweight indexes
  ("refs", "index")
][ // Ref → title/type/status map
  // Counts (sidebar badges)
  ("inbox", "count")
][("observations", "count")][("tasks", "pending-review-count")];
```

### Query Key Factory

Centralize keys to prevent typos and enable targeted invalidation:

```typescript
// src/lib/query/keys.ts
export const queryKeys = {
  tasks: {
    all: ["tasks"] as const,
    lists: () => [...queryKeys.tasks.all] as const,
    list: (filters: TaskFilters) => [...queryKeys.tasks.all, filters] as const,
    detail: (ref: string) => [...queryKeys.tasks.all, ref] as const,
    summary: () => [...queryKeys.tasks.all, "summary"] as const,
    pendingReviewCount: () => [...queryKeys.tasks.all, "pending-review-count"] as const,
  },
  items: {
    all: ["items"] as const,
    lists: () => [...queryKeys.items.all] as const,
    list: (filters: ItemFilters) => [...queryKeys.items.all, filters] as const,
    detail: (ref: string) => [...queryKeys.items.all, ref] as const,
  },
  inbox: {
    all: ["inbox"] as const,
    list: (filters?: InboxFilters) => [...queryKeys.inbox.all, filters] as const,
    count: () => [...queryKeys.inbox.all, "count"] as const,
  },
  sessions: {
    all: ["sessions"] as const,
    list: (filters: SessionFilters) => [...queryKeys.sessions.all, filters] as const,
    detail: (id: string) => [...queryKeys.sessions.all, id] as const,
  },
  agents: {
    all: ["agents"] as const,
    status: () => [...queryKeys.agents.all, "status"] as const,
    definitions: () => [...queryKeys.agents.all, "definitions"] as const,
  },
  refs: {
    index: () => ["refs", "index"] as const,
  },
  validation: () => ["validation"] as const,
  alignment: () => ["alignment"] as const,
  observations: {
    all: ["observations"] as const,
    list: (filters?: ObservationFilters) => [...queryKeys.observations.all, filters] as const,
    count: () => [...queryKeys.observations.all, "count"] as const,
  },
} as const;
```

**Usage:**

```typescript
// In a query
const tasks = createQuery(() => ({
  queryKey: queryKeys.tasks.list({ status: "pending" }),
  queryFn: () => fetchTasks({ status: "pending" }),
}));

// For invalidation — invalidate all tasks queries
queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });

// For targeted invalidation — only list queries
queryClient.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
```

## Cache Timing Conventions

| Data Type                    | staleTime | gcTime | Rationale                                 |
| ---------------------------- | --------- | ------ | ----------------------------------------- |
| Entity lists (tasks, items)  | 30s       | 10 min | Frequently changing, WS handles freshness |
| Entity detail                | 30s       | 10 min | Same as lists                             |
| Ref index (title resolution) | 5 min     | 30 min | Rarely changes, expensive to compute      |
| Sidebar badge counts         | 30s       | 5 min  | Small payload, WS-invalidated             |
| Validation / alignment       | 60s       | 10 min | Expensive to compute, rarely polled       |
| Agent status                 | 10s       | 5 min  | Needs near-real-time feel                 |
| Session context              | 5 min     | 30 min | Changes on project switch only            |

Override per-query in the factory:

```typescript
const refIndex = createQuery(() => ({
  queryKey: queryKeys.refs.index(),
  queryFn: () => fetchRefIndex(),
  staleTime: 5 * 60_000, // 5 minutes — titles rarely change
  gcTime: 30 * 60_000, // 30 minutes
}));
```

## Creating a New Query — Step by Step

### 1. Add query key to factory

```typescript
// src/lib/query/keys.ts
export const queryKeys = {
  // ...existing keys...
  workflows: {
    all: ["workflows"] as const,
    list: () => [...queryKeys.workflows.all] as const,
  },
};
```

### 2. Create the query in the component

```svelte
<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { fetchWorkflows } from '$lib/api';
  import { queryKeys } from '$lib/query/keys';
  import { isStaticMode } from '$lib/stores/mode.svelte';
  import { isProjectInitialized, getProjectVersion } from '$lib/stores/project.svelte';

  const workflows = createQuery(() => ({
    queryKey: queryKeys.workflows.list(),
    queryFn: () => fetchWorkflows(),
    enabled: isProjectInitialized(),
  }));
</script>

{#if workflows.isPending}
  <LoadingSkeleton />
{:else if workflows.isError}
  <ErrorMessage error={workflows.error} />
{:else}
  {#each workflows.data.items as workflow}
    <WorkflowCard {workflow} />
  {/each}
{/if}
```

### 3. Wire WS invalidation (if applicable)

```typescript
// In the WebSocket → query invalidation wiring
case 'workflows':
  queryClient.invalidateQueries({ queryKey: queryKeys.workflows.all });
  break;
```

## Creating a Mutation

Mutations handle write operations (start task, add note, create inbox item, etc.).

```svelte
<script lang="ts">
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { startTask } from '$lib/api';
  import { queryKeys } from '$lib/query/keys';

  const queryClient = useQueryClient();

  const startTaskMutation = createMutation(() => ({
    mutationFn: (ref: string) => startTask(ref),
    onSuccess: () => {
      // Invalidate task queries so lists and details refresh
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
    onError: (error: Error) => {
      // Show error toast
      addToast({ type: 'error', message: error.message });
    },
  }));

  function handleStartTask(ref: string) {
    startTaskMutation.mutate(ref);
  }
</script>

<button
  onclick={() => handleStartTask(task._ref)}
  disabled={startTaskMutation.isPending}
>
  {startTaskMutation.isPending ? 'Starting...' : 'Start Task'}
</button>
```

### Optimistic Updates

For mutations where you want the UI to update instantly:

```typescript
const addNoteMutation = createMutation(() => ({
  mutationFn: ({ ref, content }: { ref: string; content: string }) => addTaskNote(ref, content),
  onMutate: async ({ ref, content }) => {
    // Cancel outgoing refetches
    await queryClient.cancelQueries({ queryKey: queryKeys.tasks.detail(ref) });

    // Snapshot previous value
    const previous = queryClient.getQueryData(queryKeys.tasks.detail(ref));

    // Optimistically update
    queryClient.setQueryData(queryKeys.tasks.detail(ref), (old: TaskDetail) => ({
      ...old,
      notes: [...old.notes, { content, created_at: new Date().toISOString() }],
    }));

    return { previous };
  },
  onError: (_err, _vars, context) => {
    // Roll back on error
    if (context?.previous) {
      queryClient.setQueryData(queryKeys.tasks.detail(ref), context.previous);
    }
  },
  onSettled: () => {
    // Always refetch after mutation
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
  },
}));
```

## WebSocket → Query Invalidation

The WebSocket manager receives broadcast events. Wire these to query invalidation so active views revalidate automatically.

### Wiring Pattern

```typescript
// src/lib/query/ws-invalidation.ts
import type { QueryClient } from "@tanstack/svelte-query";
import type { BroadcastEvent } from "@kynetic-ai/shared";
import { queryKeys } from "./keys";

export function handleBroadcastInvalidation(queryClient: QueryClient, event: BroadcastEvent): void {
  switch (event.topic) {
    case "tasks":
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.pendingReviewCount() });
      // If enriched payload includes the full task, update cache directly
      if (event.data?.task) {
        queryClient.setQueryData(queryKeys.tasks.detail(event.data.ref), event.data.task);
      }
      break;

    case "inbox":
      queryClient.invalidateQueries({ queryKey: queryKeys.inbox.all });
      break;

    case "agents":
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      break;

    case "files":
      // Settings/config changes
      queryClient.invalidateQueries({ queryKey: queryKeys.validation() });
      queryClient.invalidateQueries({ queryKey: queryKeys.alignment() });
      queryClient.invalidateQueries({ queryKey: queryKeys.items.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      break;
  }
}
```

### Integration with WebSocket Manager

```typescript
// In root layout or connection setup
import { on } from "$lib/stores/connection.svelte";
import { handleBroadcastInvalidation } from "$lib/query/ws-invalidation";

// Subscribe to all relevant topics
subscribe(["tasks", "agents", "inbox", "files"]);

// Single handler for all invalidations
function handleBroadcast(event: BroadcastEvent) {
  handleBroadcastInvalidation(queryClient, event);
}

on("tasks", handleBroadcast);
on("agents", handleBroadcast);
on("inbox", handleBroadcast);
on("files", handleBroadcast);
```

**Key principle:** After wiring WS → invalidation, individual pages no longer need `on('tasks', reloadEverything)` handlers. TanStack Query handles refetching active queries automatically.

## Ref Index for Title Resolution

Instead of `fetchTasks({ limit: 1000 })` to get task titles for display, use the lightweight ref index endpoint:

```typescript
// Query for the ref index (long staleTime — titles rarely change)
const refIndex = createQuery(() => ({
  queryKey: queryKeys.refs.index(),
  queryFn: () => fetchRefIndex(),
  staleTime: 5 * 60_000,
  gcTime: 30 * 60_000,
}));

// Usage in template
function resolveTitle(ref: string): string {
  return refIndex.data?.[ref]?.title ?? ref;
}
```

After the server-side resolution work is done, most title resolution will happen inline in API responses (e.g., `spec_title` alongside `spec_ref`), reducing the need for client-side lookups.

## Project Switch — Cache Clearing

When the user switches projects, all cached data must be discarded:

```typescript
// In project switch handler
import { useQueryClient } from "@tanstack/svelte-query";

function handleProjectSwitch(newPath: string) {
  const queryClient = useQueryClient();

  // Clear ALL cached data
  queryClient.clear();

  // Set new project and trigger reloads
  selectProject(newPath);
}
```

`queryClient.clear()` removes all queries from the cache. New queries will fetch fresh data with the updated `X-Kspec-Dir` header.

## Static Mode Compatibility

Query factories must respect static mode. The existing `fetchTasks()`, `fetchItems()`, etc. in `api.ts` already dispatch to static implementations when `isStaticMode()` is true — so queries "just work" in static mode.

Key considerations:

```typescript
// Mutations should be disabled in static mode
const startTaskMutation = createMutation(() => ({
  mutationFn: (ref: string) => startTask(ref), // Throws ReadOnlyModeError in static mode
  // ...
}));

// Agent-specific queries should be disabled
const agentStatus = createQuery(() => ({
  queryKey: queryKeys.agents.status(),
  queryFn: () => fetchAgentStatus(),
  enabled: !isStaticMode() && isProjectInitialized(), // Skip in static mode
}));
```

**WebSocket connections are not established in static mode**, so WS-driven invalidation is naturally disabled. The `subscribe()` calls in the connection store are no-ops when static.

## Error Handling and Retry Config

The daemon runs on localhost — network flakiness is rare. Connection failures usually mean the daemon isn't running.

```typescript
// Default query client config (see Setup section)
{
  retry: 1,              // One retry — if daemon is down, more retries won't help
  retryDelay: 500,       // Short delay — it's localhost
  refetchOnWindowFocus: false,  // WS events handle freshness
}
```

### Error Display Pattern

```svelte
{#if query.isError}
  {#if query.error.message.includes('fetch')}
    <Alert type="warning">
      Daemon not reachable. Start it with <code>kspec serve</code>.
    </Alert>
  {:else}
    <Alert type="error">{query.error.message}</Alert>
  {/if}
{/if}
```

### Invalid Project Recovery

The existing `handleResponseError()` in `api.ts` detects invalid project responses (400/404) and calls `clearInvalidSelection()`. This works the same through TanStack Query — the error propagates to the query's `error` state.

## Sessions Infinite Scroll — createInfiniteQuery

The sessions page uses `createInfiniteQuery` for paginated data with scroll-to-load-more:

```svelte
<script lang="ts">
  import { createInfiniteQuery } from '@tanstack/svelte-query';
  import { queryKeys } from '$lib/query/keys';

  const PAGE_SIZE = 25;

  const sessions = createInfiniteQuery(() => ({
    queryKey: queryKeys.sessions.list({ status: filterStatus }),
    queryFn: ({ pageParam }) =>
      fetchSessions({ offset: pageParam, limit: PAGE_SIZE, status: filterStatus }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const totalFetched = allPages.reduce((sum, p) => sum + p.items.length, 0);
      return totalFetched < lastPage.total ? totalFetched : undefined;
    },
  }));

  // Flatten pages for rendering
  let allSessions = $derived(sessions.data?.pages.flatMap(p => p.items) ?? []);
</script>

{#each allSessions as session}
  <SessionRow {session} />
{/each}

{#if sessions.hasNextPage}
  <div use:intersectionObserver={() => sessions.fetchNextPage()}>
    {#if sessions.isFetchingNextPage}
      <LoadingMore />
    {/if}
  </div>
{/if}
```

### Key Properties

| Property             | Type         | Description                 |
| -------------------- | ------------ | --------------------------- |
| `data.pages`         | `Page[]`     | Array of fetched pages      |
| `data.pageParams`    | `number[]`   | Array of page params used   |
| `fetchNextPage()`    | `() => void` | Trigger next page fetch     |
| `hasNextPage`        | `boolean`    | Whether more pages exist    |
| `isFetchingNextPage` | `boolean`    | Currently loading next page |

## Migration Guide — Page from Manual Fetch to Queries

### Before (Manual Fetch + $state + $effect)

```svelte
<script lang="ts">
  import { fetchTasks, fetchAgentStatus } from '$lib/api';
  import { getProjectVersion, isProjectInitialized } from '$lib/stores/project.svelte';
  import { isStaticMode } from '$lib/stores/mode.svelte';
  import { subscribe, on, off } from '$lib/stores/connection.svelte';

  let tasks = $state<TaskSummary[]>([]);
  let agentStatus = $state<AgentStatus | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Fetch on mount + project change
  $effect(() => {
    const version = getProjectVersion();
    if (!isProjectInitialized()) return;
    loadData();
  });

  async function loadData() {
    loading = true;
    error = null;
    try {
      const [tasksRes, statusRes] = await Promise.all([
        fetchTasks({ limit: 1000 }),
        isStaticMode() ? null : fetchAgentStatus().catch(() => null),
      ]);
      tasks = tasksRes.items;
      agentStatus = statusRes;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  // WebSocket reload
  onMount(() => {
    if (!isStaticMode()) {
      subscribe(['tasks', 'agents']);
      on('tasks', loadData);      // Full reload on any task event
      on('agents', loadData);     // Full reload on any agent event
    }
  });

  onDestroy(() => {
    off('tasks', loadData);
    off('agents', loadData);
  });
</script>
```

### After (TanStack Query)

```svelte
<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { fetchTasks, fetchAgentStatus } from '$lib/api';
  import { queryKeys } from '$lib/query/keys';
  import { isProjectInitialized } from '$lib/stores/project.svelte';
  import { isStaticMode } from '$lib/stores/mode.svelte';

  // Queries — caching, dedup, and revalidation handled automatically
  const tasks = createQuery(() => ({
    queryKey: queryKeys.tasks.lists(),
    queryFn: () => fetchTasks(),
    enabled: isProjectInitialized(),
  }));

  const agentStatus = createQuery(() => ({
    queryKey: queryKeys.agents.status(),
    queryFn: () => fetchAgentStatus(),
    enabled: !isStaticMode() && isProjectInitialized(),
  }));

  // No manual loading/error state — query objects provide it
  // No onMount/onDestroy — query lifecycle is automatic
  // No WS handlers here — centralized WS → invalidation wiring handles it
</script>

{#if tasks.isPending}
  <LoadingSkeleton />
{:else if tasks.isError}
  <ErrorState error={tasks.error} />
{:else}
  <TaskList tasks={tasks.data.items} />
{/if}
```

### What Changed

| Before                          | After                                                    |
| ------------------------------- | -------------------------------------------------------- |
| `let data = $state([])`         | `createQuery()` manages state                            |
| `let loading = $state(true)`    | `query.isPending`                                        |
| `let error = $state(null)`      | `query.isError` / `query.error`                          |
| `$effect(() => loadData())`     | `enabled` option + reactive queryKey                     |
| `on('tasks', loadData)`         | Centralized WS → `invalidateQueries`                     |
| `Promise.all([fetch1, fetch2])` | Multiple independent `createQuery` calls (auto-parallel) |
| Manual try/catch/finally        | Query error/loading states                               |
| `fetchTasks({ limit: 1000 })`   | Proper pagination or ref index                           |

### Migration Checklist

1. Replace `$state` variables for API data with `createQuery()`
2. Remove manual `loading` / `error` state variables
3. Remove `$effect(() => loadData())` — use `enabled` + reactive keys
4. Remove per-page `on('topic', handler)` / `off('topic', handler)` — rely on centralized WS wiring
5. Remove `onMount` / `onDestroy` for WS subscription when page no longer needs custom event handling
6. Update template to use `query.isPending`, `query.isError`, `query.data`
7. Remove `fetchTasks({ limit: 1000 })` calls for title lookup — use ref index or server-resolved titles

## Testing Patterns

### QueryClientProvider Wrapper

Every component using queries needs a QueryClientProvider in tests:

```typescript
// tests/helpers/query.ts
import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, // No retries in tests
        staleTime: Infinity, // Prevent background refetches
        gcTime: Infinity, // Keep data for test duration
      },
    },
  });
}
```

### Mocking queryFn

```typescript
import { render } from "@testing-library/svelte";
import { vi } from "vitest";

// Mock the API module
vi.mock("$lib/api", () => ({
  fetchTasks: vi.fn().mockResolvedValue({
    items: [{ _ulid: "01ABC", title: "Test task", status: "pending" }],
    total: 1,
  }),
}));

// Render with provider
const { getByText } = render(TasksPage);
await waitFor(() => expect(getByText("Test task")).toBeInTheDocument());
```

### Testing Mutations

```typescript
const { getByRole } = render(TaskActions, { props: { taskRef: "@test-task" } });

// Trigger mutation
await fireEvent.click(getByRole("button", { name: "Start Task" }));

// Verify API called
expect(startTask).toHaveBeenCalledWith("@test-task");

// Verify cache invalidated (check via query client spy or re-render)
```

## Anti-Patterns

### 1. Manual fetch + $state for API data

```typescript
// BAD — bypasses cache, dedup, and revalidation
let tasks = $state<Task[]>([]);
$effect(() => {
  fetchTasks().then((res) => (tasks = res.items));
});

// GOOD — uses query cache
const tasks = createQuery(() => ({
  queryKey: queryKeys.tasks.lists(),
  queryFn: () => fetchTasks(),
}));
```

### 2. fetchTasks({ limit: 1000 }) for title lookup

```typescript
// BAD — fetches all tasks just to show a title
const allTasks = await fetchTasks({ limit: 1000 });
const title = allTasks.items.find((t) => t._ulid === ref)?.title ?? ref;

// GOOD — use ref index (lightweight endpoint)
const refIndex = createQuery(() => ({
  queryKey: queryKeys.refs.index(),
  queryFn: () => fetchRefIndex(),
  staleTime: 5 * 60_000,
}));
const title = refIndex.data?.[ref]?.title ?? ref;

// BEST — use server-resolved title from API response
// task.spec_title is already in the response — no separate lookup needed
```

### 3. Polling intervals for data freshness

```typescript
// BAD — wasteful, laggy, and doesn't scale
setInterval(loadCounts, 30_000);

// GOOD — event-driven invalidation via WebSocket
// WS event → queryClient.invalidateQueries() → active queries refetch
```

### 4. Per-page WebSocket reload handlers

```typescript
// BAD — every page manages its own WS handlers
onMount(() => {
  on("tasks", () => {
    loadTasks();
    loadSummary();
    loadAgentStatus();
  });
});
onDestroy(() => {
  off("tasks", handler);
});

// GOOD — centralized WS → invalidation wiring
// Pages don't need WS handlers — queries auto-refetch when invalidated
```

### 5. Unbounded limit fetches

```typescript
// BAD — fetches everything, O(n) memory, slow on large projects
fetchTasks({ limit: 999 });

// GOOD — paginate with limit/offset, or use summary endpoints
// For counts: use summary endpoint or limit: 0 with total
// For display: paginate with createInfiniteQuery
```

## Boundaries

### What Goes Through TanStack Query

All **request-response** data fetching:

- Entity lists and details (tasks, items, inbox, sessions, etc.)
- Aggregation endpoints (counts, validation, alignment)
- Ref index for title resolution
- Agent status and definitions
- Settings and configuration

### What Stays Outside TanStack Query

- **WebSocket text streaming** (agent text chunks) — These are real-time streaming data, not request-response. Continue using the existing WS handler + `$state` accumulation pattern for `agent_text_chunk` events.
- **WebSocket connection management** — The connection store handles connect/disconnect/reconnect lifecycle.
- **Local UI state** — Filter selections, panel open/close, dialog state. These are not server data.
- **Static snapshot loading** — Initial mode detection and snapshot loading happens once at startup, before QueryClientProvider is available.

## Project Architecture

### File Layout

```
src/lib/
├── query/
│   ├── client.ts              # QueryClient factory with default config
│   ├── keys.ts                # Query key factory (centralized)
│   └── ws-invalidation.ts     # WebSocket → query invalidation mapping
├── api.ts                     # HTTP fetch functions (unchanged)
├── api-static.ts              # Static mode fetch implementations (unchanged)
├── stores/
│   ├── connection.svelte.ts   # WebSocket connection store (unchanged)
│   ├── mode.svelte.ts         # Static/daemon mode detection (unchanged)
│   └── project.svelte.ts     # Project selection store (unchanged)
└── websocket/
    ├── manager.ts             # WebSocket manager (unchanged)
    └── types.ts               # WebSocket types (unchanged)
```

### Data Flow

```
User navigates to page
  → createQuery() checks cache
  → Cache hit + fresh? → Render immediately
  → Cache hit + stale? → Render from cache, refetch in background
  → Cache miss? → Show loading, fetch from daemon

WebSocket event arrives
  → handleBroadcastInvalidation() maps topic → query keys
  → queryClient.invalidateQueries() marks queries stale
  → Active queries refetch in background
  → If enriched payload: queryClient.setQueryData() updates cache directly

User performs write (mutation)
  → createMutation() calls API
  → onSuccess: invalidateQueries() for affected keys
  → Active queries refetch, UI updates

User switches project
  → queryClient.clear() discards all cache
  → New queries fetch with updated X-Kspec-Dir header
```
