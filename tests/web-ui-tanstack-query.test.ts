/**
 * TanStack Query Infrastructure and Dashboard Migration Tests
 *
 * Static analysis tests verifying the TanStack Query v6 setup,
 * QueryClientProvider integration, query key factories, WebSocket
 * invalidation wiring, project switch cache clearing, static mode
 * compatibility, and dashboard migration.
 *
 * Spec: @ui-data-freshness
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB_UI_SRC = join(process.cwd(), "packages", "web-ui", "src");
const QUERY_DIR = join(WEB_UI_SRC, "lib", "query");
const LAYOUT_PATH = join(WEB_UI_SRC, "routes", "+layout.svelte");
const DASHBOARD_PATH = join(WEB_UI_SRC, "routes", "+page.svelte");
const AGENTS_PATH = join(WEB_UI_SRC, "routes", "agents", "+page.svelte");
const SESSIONS_PATH = join(WEB_UI_SRC, "routes", "sessions", "+page.svelte");
const SESSION_DETAIL_PATH = join(
  WEB_UI_SRC,
  "routes",
  "sessions",
  "[id]",
  "+page.svelte",
);
const SETTINGS_PATH = join(WEB_UI_SRC, "routes", "settings", "+page.svelte");
const WORKFLOWS_PATH = join(WEB_UI_SRC, "routes", "workflows", "+page.svelte");
const OBSERVATIONS_PATH = join(
  WEB_UI_SRC,
  "routes",
  "observations",
  "+page.svelte",
);
const PROJECT_STORE_PATH = join(
  WEB_UI_SRC,
  "lib",
  "stores",
  "project.svelte.ts",
);
const API_PATH = join(WEB_UI_SRC, "lib", "api.ts");
const PACKAGE_JSON_PATH = join(
  process.cwd(),
  "packages",
  "web-ui",
  "package.json",
);

const SIDEBAR_PATH = join(
  WEB_UI_SRC,
  "lib",
  "components",
  "Sidebar.svelte",
);

// Load source files
const clientSrc = readFileSync(join(QUERY_DIR, "client.ts"), "utf-8");
const keysSrc = readFileSync(join(QUERY_DIR, "keys.ts"), "utf-8");
const wsInvalidationSrc = readFileSync(
  join(QUERY_DIR, "ws-invalidation.ts"),
  "utf-8",
);
const contextSrc = readFileSync(join(QUERY_DIR, "context.ts"), "utf-8");
const indexSrc = readFileSync(join(QUERY_DIR, "index.ts"), "utf-8");
const layoutSrc = readFileSync(LAYOUT_PATH, "utf-8");
const dashboardSrc = readFileSync(DASHBOARD_PATH, "utf-8");
const sidebarSrc = readFileSync(SIDEBAR_PATH, "utf-8");
const agentsSrc = readFileSync(AGENTS_PATH, "utf-8");
const sessionsSrc = readFileSync(SESSIONS_PATH, "utf-8");
const sessionDetailSrc = readFileSync(SESSION_DETAIL_PATH, "utf-8");
const settingsSrc = readFileSync(SETTINGS_PATH, "utf-8");
const workflowsSrc = readFileSync(WORKFLOWS_PATH, "utf-8");
const observationsSrc = readFileSync(OBSERVATIONS_PATH, "utf-8");
const projectStoreSrc = readFileSync(PROJECT_STORE_PATH, "utf-8");
const packageJsonSrc = readFileSync(PACKAGE_JSON_PATH, "utf-8");
const packageJson = JSON.parse(packageJsonSrc);
const apiSrc = readFileSync(API_PATH, "utf-8");

describe("TanStack Query package installation", () => {
  it("has @tanstack/svelte-query in dependencies", () => {
    expect(packageJson.dependencies).toHaveProperty("@tanstack/svelte-query");
  });
});

// AC: @ui-data-freshness ac-1
describe("query client factory (@ui-data-freshness ac-1)", () => {
  it("exports createQueryClientInstance function", () => {
    expect(clientSrc).toContain("export function createQueryClientInstance");
  });

  it("creates a QueryClient with staleTime for cache-then-revalidate", () => {
    expect(clientSrc).toContain("staleTime");
    expect(clientSrc).toContain("new QueryClient");
  });

  it("configures gcTime for session-length caching", () => {
    expect(clientSrc).toContain("gcTime");
  });

  // AC: @ui-data-freshness ac-7
  it("configures retry for localhost daemon (minimal retries)", () => {
    expect(clientSrc).toContain("retry: 1");
    expect(clientSrc).toContain("retryDelay");
  });
});

describe("query key factories", () => {
  it("exports queryKeys with hierarchical structure", () => {
    expect(keysSrc).toContain("export const queryKeys");
  });

  it("defines task key factories", () => {
    expect(keysSrc).toContain("tasks:");
    expect(keysSrc).toContain("all:");
    expect(keysSrc).toContain("lists:");
    expect(keysSrc).toContain("detail:");
    expect(keysSrc).toContain("summary:");
  });

  it("defines inbox key factories", () => {
    expect(keysSrc).toContain("inbox:");
    expect(keysSrc).toContain("count:");
  });

  it("defines observation key factories", () => {
    expect(keysSrc).toContain("observations:");
  });

  it("defines validation key factories", () => {
    expect(keysSrc).toContain("validation:");
  });

  it("defines agent key factories", () => {
    expect(keysSrc).toContain("agents:");
    expect(keysSrc).toContain("status:");
  });

  it("defines item key factories", () => {
    expect(keysSrc).toContain("items:");
  });

  it("defines session key factories", () => {
    expect(keysSrc).toContain("sessions:");
  });

  it("defines plan key factories", () => {
    expect(keysSrc).toContain("plans:");
  });

  it("defines workflow key factories", () => {
    expect(keysSrc).toContain("workflows:");
  });

  it("defines settings key factories", () => {
    expect(keysSrc).toContain("settings:");
  });
});

// AC: @ui-data-freshness ac-3
// AC: @ui-data-freshness ac-4 — Event-driven invalidation, not timer-based polling
describe("WebSocket invalidation wiring (@ui-data-freshness ac-3, ac-4)", () => {
  it("exports setupWsInvalidation function", () => {
    expect(wsInvalidationSrc).toContain("export function setupWsInvalidation");
  });

  it("exports teardownWsInvalidation function", () => {
    expect(wsInvalidationSrc).toContain(
      "export function teardownWsInvalidation",
    );
  });

  it("subscribes to relevant broadcast topics", () => {
    expect(wsInvalidationSrc).toContain("tasks");
    expect(wsInvalidationSrc).toContain("items");
    expect(wsInvalidationSrc).toContain("inbox");
    expect(wsInvalidationSrc).toContain("agents");
    expect(wsInvalidationSrc).toContain("files");
  });

  it("calls queryClient.invalidateQueries for matched events", () => {
    expect(wsInvalidationSrc).toContain("invalidateQueries");
  });

  it("skips invalidation for agent text chunks (streaming)", () => {
    expect(wsInvalidationSrc).toContain("agent_text_chunk");
  });

  it("maps task events to task and validation key invalidation", () => {
    expect(wsInvalidationSrc).toContain("queryKeys.tasks.all");
    expect(wsInvalidationSrc).toContain("queryKeys.validation.all");
  });

  // AC: @ui-data-freshness ac-4
  it("uses event-driven invalidation, not timer-based polling", () => {
    // No setInterval or polling timers — data freshness is driven by WS events
    expect(wsInvalidationSrc).not.toContain("setInterval");
    expect(wsInvalidationSrc).not.toContain("setTimeout");
    // Uses WS event handlers (on/off) for reactivity, not timers
    expect(wsInvalidationSrc).toContain("on(topic, handler)");
  });
});

// AC: @ui-data-freshness ac-5
describe("project switch cache clearing (@ui-data-freshness ac-5)", () => {
  it("imports clearQueryCache in project store", () => {
    expect(projectStoreSrc).toContain("clearQueryCache");
  });

  it("calls clearQueryCache in selectProject", () => {
    // Verify clearQueryCache is called within the selectProject function
    const selectProjectBlock = projectStoreSrc.slice(
      projectStoreSrc.indexOf("export function selectProject"),
    );
    expect(selectProjectBlock).toContain("clearQueryCache()");
  });

  it("context module exports clearQueryCache that uses resetQueries()", () => {
    expect(contextSrc).toContain("export function clearQueryCache");
    // resetQueries() resets state AND triggers refetches of active queries,
    // unlike clear() which destroys queries without notifying observers
    expect(contextSrc).toContain("queryClientInstance.resetQueries()");
    expect(contextSrc).not.toContain("queryClientInstance.clear()");
  });
});

// AC: @ui-data-freshness ac-1, ac-2
describe(
  "QueryClientProvider in root layout (@ui-data-freshness ac-1, ac-2)",
  () => {
    it("imports QueryClientProvider from @tanstack/svelte-query", () => {
      expect(layoutSrc).toContain("QueryClientProvider");
      expect(layoutSrc).toContain("@tanstack/svelte-query");
    });

    it("creates a QueryClient instance", () => {
      expect(layoutSrc).toContain("createQueryClientInstance");
    });

    it("wraps app content with QueryClientProvider", () => {
      expect(layoutSrc).toContain("<QueryClientProvider");
      expect(layoutSrc).toContain("</QueryClientProvider>");
    });

    it("passes client prop to QueryClientProvider", () => {
      expect(layoutSrc).toContain("client={queryClient}");
    });

    it("sets up WebSocket invalidation in daemon mode", () => {
      expect(layoutSrc).toContain("setupWsInvalidation");
    });

    it("does not set up WS invalidation in static mode (conditional)", () => {
      // Verify WS setup is within the daemon code path
      const staticBlock = layoutSrc.slice(
        layoutSrc.indexOf("if (isStaticMode())"),
        layoutSrc.indexOf("return;") + 10,
      );
      expect(staticBlock).not.toContain("setupWsInvalidation");
    });
  },
);

// AC: @ui-data-freshness ac-1
describe("dashboard migration — cache-then-revalidate (@ui-data-freshness ac-1)", () => {
  it("uses createQuery from @tanstack/svelte-query", () => {
    expect(dashboardSrc).toContain("createQuery");
    expect(dashboardSrc).toContain("@tanstack/svelte-query");
  });

  it("uses query key factories for cache identity", () => {
    expect(dashboardSrc).toContain("queryKeys.tasks");
    expect(dashboardSrc).toContain("queryKeys.inbox");
    expect(dashboardSrc).toContain("queryKeys.observations");
    expect(dashboardSrc).toContain("queryKeys.validation");
    expect(dashboardSrc).toContain("queryKeys.agents");
  });

  it("does not use manual loadDashboard fetch pattern", () => {
    expect(dashboardSrc).not.toContain("async function loadDashboard");
    expect(dashboardSrc).not.toContain("Promise.all");
  });

  it("derives loading state from query states (not manual $state)", () => {
    expect(dashboardSrc).toContain("tasksQuery.isLoading");
    expect(dashboardSrc).toContain("inboxQuery.isLoading");
  });

  it("shows loading skeleton only on initial fetch (isLoading)", () => {
    // isLoading is true only when there's no cached data — on revisit,
    // cached data renders immediately
    expect(dashboardSrc).toContain("$derived(");
    expect(dashboardSrc).toContain("isLoading");
  });
});

// AC: @ui-data-freshness ac-3
describe("dashboard WebSocket integration (@ui-data-freshness ac-3)", () => {
  it("still subscribes to agents topic for text chunk streaming", () => {
    expect(dashboardSrc).toContain("subscribe(['agents'])");
  });

  it("does not subscribe to tasks topic (handled by centralized wiring)", () => {
    // The dashboard should NOT have its own tasks subscription anymore
    expect(dashboardSrc).not.toContain("subscribe(['tasks', 'agents'])");
    expect(dashboardSrc).not.toContain("subscribe(['tasks'");
  });

  it("uses query invalidation for agent lifecycle events", () => {
    expect(dashboardSrc).toContain("invalidateQueries");
    expect(dashboardSrc).toContain("queryKeys.agents.status()");
  });

  it("still buffers agent text chunks outside TanStack Query", () => {
    expect(dashboardSrc).toContain("processTextChunk");
    expect(dashboardSrc).toContain("sessionStates");
  });
});

// AC: @ui-data-freshness ac-6
describe("dashboard static mode compatibility (@ui-data-freshness ac-6)", () => {
  it("uses existing fetch functions that dispatch to static mode", () => {
    expect(dashboardSrc).toContain("fetchTasks");
    expect(dashboardSrc).toContain("fetchInbox");
    expect(dashboardSrc).toContain("fetchObservations");
    expect(dashboardSrc).toContain("fetchValidation");
  });

  it("disables agent status query in static mode", () => {
    expect(dashboardSrc).toContain("!isStaticMode()");
  });

  it("gates queries on project initialization", () => {
    expect(dashboardSrc).toContain("enabled: isProjectInitialized()");
  });
});

// AC: @ui-data-freshness ac-7
describe("dashboard error handling (@ui-data-freshness ac-7)", () => {
  it("derives error state from query errors", () => {
    expect(dashboardSrc).toContain("tasksQuery.error");
    expect(dashboardSrc).toContain("inboxQuery.error");
  });

  it("shows error message with retry button", () => {
    expect(dashboardSrc).toContain("data-testid=\"dashboard-error\"");
    expect(dashboardSrc).toContain("Retry");
  });

  it("retry invalidates all dashboard queries", () => {
    expect(dashboardSrc).toContain("function retryAll");
    expect(dashboardSrc).toContain("invalidateQueries");
  });
});

// AC: @ui-data-freshness ac-8
describe("write operation cache invalidation pattern (@ui-data-freshness ac-8)", () => {
  it("WS invalidation handles task events for write-through updates", () => {
    // When a write operation succeeds, the daemon broadcasts a WS event.
    // The centralized WS invalidation handler catches it and invalidates
    // the relevant queries. This ensures write operations update the UI.
    expect(wsInvalidationSrc).toContain("case 'tasks':");
    expect(wsInvalidationSrc).toContain("queryKeys.tasks.all");
  });
});

describe("query module barrel export", () => {
  it("re-exports all query modules", () => {
    expect(indexSrc).toContain("createQueryClientInstance");
    expect(indexSrc).toContain("queryKeys");
    expect(indexSrc).toContain("setupWsInvalidation");
    expect(indexSrc).toContain("teardownWsInvalidation");
    expect(indexSrc).toContain("setQueryClient");
    expect(indexSrc).toContain("getQueryClient");
    expect(indexSrc).toContain("clearQueryCache");
  });
});

// AC: @ui-data-freshness ac-4 — Sidebar badge counts via cache, no polling
describe("sidebar migration to TanStack Query (@ui-data-freshness ac-4)", () => {
  it("uses createQuery for all badge count data fetching", () => {
    expect(sidebarSrc).toContain("createQuery");
    expect(sidebarSrc).toContain("@tanstack/svelte-query");
  });

  it("creates inbox count query", () => {
    expect(sidebarSrc).toContain("inboxCountQuery");
    expect(sidebarSrc).toContain("queryKeys.inbox.count()");
    expect(sidebarSrc).toContain("fetchInbox({ limit: 0 })");
  });

  it("creates observations count query", () => {
    expect(sidebarSrc).toContain("observationsCountQuery");
    expect(sidebarSrc).toContain("queryKeys.observations.count");
    expect(sidebarSrc).toContain("fetchObservations({ resolved: false })");
  });

  it("creates pending review count query", () => {
    expect(sidebarSrc).toContain("pendingReviewCountQuery");
    expect(sidebarSrc).toContain("queryKeys.tasks.list");
    expect(sidebarSrc).toContain("fetchTasks({ status: 'pending_review', limit: 0 })");
  });

  it("creates session context query", () => {
    expect(sidebarSrc).toContain("sessionContextQuery");
    expect(sidebarSrc).toContain("queryKeys.sessionContext.current()");
    expect(sidebarSrc).toContain("fetchSessionContext()");
  });

  it("does not use setInterval polling", () => {
    expect(sidebarSrc).not.toContain("setInterval");
    expect(sidebarSrc).not.toContain("clearInterval");
    expect(sidebarSrc).not.toContain("countsInterval");
  });

  it("does not use manual loadCounts function", () => {
    expect(sidebarSrc).not.toContain("async function loadCounts");
    expect(sidebarSrc).not.toContain("Promise.all");
  });

  it("gates all queries on project initialization", () => {
    // All createQuery calls should be gated by isProjectInitialized()
    const queryBlocks = sidebarSrc.match(/createQuery\(\(\) => \(\{[\s\S]*?\}\)\)/g) ?? [];
    expect(queryBlocks.length).toBe(4);
    for (const block of queryBlocks) {
      expect(block).toContain("isProjectInitialized()");
    }
  });

  it("reads badge counts from query data", () => {
    expect(sidebarSrc).toContain("inboxCountQuery.data?.total");
    expect(sidebarSrc).toContain("observationsCountQuery.data?.total");
    expect(sidebarSrc).toContain("pendingReviewCountQuery.data?.total");
  });

  it("reads session context from query data", () => {
    expect(sidebarSrc).toContain("sessionContextQuery.data?.focus");
  });
});

describe("query key factories include sidebar-specific keys", () => {
  it("defines sessionContext key factories", () => {
    expect(keysSrc).toContain("sessionContext:");
    expect(keysSrc).toContain("current:");
  });

  it("defines observations count key factory", () => {
    expect(keysSrc).toContain("observations:");
    // Should have a count() factory parallel to inbox.count()
    const obsSection = keysSrc.slice(
      keysSrc.indexOf("observations:"),
      keysSrc.indexOf("},", keysSrc.indexOf("observations:")) + 2,
    );
    expect(obsSection).toContain("count:");
  });
});

describe("WS invalidation covers sidebar data (@ui-data-freshness ac-3)", () => {
  it("file events invalidate observations queries", () => {
    expect(wsInvalidationSrc).toContain("queryKeys.observations.all");
  });

  it("file events invalidate session context queries", () => {
    expect(wsInvalidationSrc).toContain("queryKeys.sessionContext.all");
  });

  it("task events invalidate session context queries", () => {
    // Session context includes focus/active work which changes with tasks
    const tasksCase = wsInvalidationSrc.slice(
      wsInvalidationSrc.indexOf("case 'tasks':"),
      wsInvalidationSrc.indexOf("case 'items':"),
    );
    expect(tasksCase).toContain("queryKeys.sessionContext.all");
  });
});

// ===================================================================
// Core page migrations — @ui-data-freshness ac-1, ac-2, ac-3
// ===================================================================

// AC: @ui-data-freshness ac-1
describe("observations page migration (@ui-data-freshness ac-1)", () => {
  it("uses createQuery from @tanstack/svelte-query", () => {
    expect(observationsSrc).toContain("createQuery");
    expect(observationsSrc).toContain("@tanstack/svelte-query");
  });

  it("uses query key factory for observations", () => {
    expect(observationsSrc).toContain("queryKeys.observations.list");
  });

  it("does not use manual $effect for data loading", () => {
    expect(observationsSrc).not.toContain("$effect(");
    expect(observationsSrc).not.toContain("async function loadObservations");
  });

  it("does not import getProjectVersion", () => {
    expect(observationsSrc).not.toContain("getProjectVersion");
  });

  it("derives loading from query state", () => {
    expect(observationsSrc).toContain("observationsQuery.isLoading");
  });

  it("gates query on project initialization", () => {
    expect(observationsSrc).toContain("enabled: isProjectInitialized()");
  });
});

// AC: @ui-data-freshness ac-1
describe("workflows page migration (@ui-data-freshness ac-1)", () => {
  it("uses createQuery from @tanstack/svelte-query", () => {
    expect(workflowsSrc).toContain("createQuery");
    expect(workflowsSrc).toContain("@tanstack/svelte-query");
  });

  it("uses query key factory for workflows", () => {
    expect(workflowsSrc).toContain("queryKeys.workflows.all");
  });

  it("does not use manual $effect for data loading", () => {
    expect(workflowsSrc).not.toContain("$effect(");
    expect(workflowsSrc).not.toContain("async function loadData");
  });

  it("does not have manual WS subscription (handled by centralized wiring)", () => {
    expect(workflowsSrc).not.toContain("subscribe(");
    expect(workflowsSrc).not.toContain("on('files:updates'");
    expect(workflowsSrc).not.toContain("onMount(");
    expect(workflowsSrc).not.toContain("onDestroy(");
  });

  it("derives loading from query state", () => {
    expect(workflowsSrc).toContain("workflowsQuery.isLoading");
  });
});

// AC: @ui-data-freshness ac-1
describe("settings page migration (@ui-data-freshness ac-1)", () => {
  it("uses createQuery from @tanstack/svelte-query", () => {
    expect(settingsSrc).toContain("createQuery");
    expect(settingsSrc).toContain("@tanstack/svelte-query");
  });

  it("uses query key factories for all settings queries", () => {
    expect(settingsSrc).toContain("queryKeys.settings.projectConfig()");
    expect(settingsSrc).toContain("queryKeys.settings.health()");
    expect(settingsSrc).toContain("queryKeys.settings.shadow()");
    expect(settingsSrc).toContain("queryKeys.settings.conventions()");
  });

  it("does not have manual WS subscription (handled by centralized wiring)", () => {
    expect(settingsSrc).not.toContain("subscribe(");
    expect(settingsSrc).not.toContain("on('files:updates'");
    expect(settingsSrc).not.toContain("onMount(");
    expect(settingsSrc).not.toContain("onDestroy(");
  });

  it("does not use manual $effect for data loading", () => {
    expect(settingsSrc).not.toContain("$effect(");
    expect(settingsSrc).not.toContain("async function loadAllData");
  });

  it("disables daemon-only queries in static mode", () => {
    expect(settingsSrc).toContain("!isStaticMode()");
  });
});

// AC: @ui-data-freshness ac-1
describe("agents page migration (@ui-data-freshness ac-1, ac-8)", () => {
  it("uses createQuery from @tanstack/svelte-query", () => {
    expect(agentsSrc).toContain("createQuery");
    expect(agentsSrc).toContain("@tanstack/svelte-query");
  });

  it("uses query key factories for agent queries", () => {
    expect(agentsSrc).toContain("queryKeys.agents.status()");
    expect(agentsSrc).toContain("queryKeys.agents.definitions()");
  });

  it("does not use manual $effect for data loading", () => {
    expect(agentsSrc).not.toContain("async function loadData");
  });

  // AC: @ui-data-freshness ac-8 — Write operations invalidate cache
  it("uses createMutation for dispatch control with cache invalidation", () => {
    expect(agentsSrc).toContain("createMutation");
    expect(agentsSrc).toContain("invalidateQueries");
    expect(agentsSrc).toContain("queryKeys.agents.all");
  });

  it("does not fetch all tasks for title lookup", () => {
    expect(agentsSrc).not.toContain("fetchTasks");
    expect(agentsSrc).not.toContain("limit: 1000");
  });

  it("uses server-resolved task_title from invocation data", () => {
    expect(agentsSrc).toContain("task_title");
  });

  it("derives loading from query states", () => {
    expect(agentsSrc).toContain("agentStatusQuery.isLoading");
    expect(agentsSrc).toContain("agentDefsQuery.isLoading");
  });
});

// AC: @ui-data-freshness ac-1
describe("session detail page migration (@ui-data-freshness ac-1)", () => {
  it("uses createQuery for session detail", () => {
    expect(sessionDetailSrc).toContain("createQuery");
    expect(sessionDetailSrc).toContain("@tanstack/svelte-query");
  });

  it("uses query key factory for session detail", () => {
    expect(sessionDetailSrc).toContain("queryKeys.sessions.detail(sessionId)");
  });

  it("does not fetch all tasks for title lookup", () => {
    expect(sessionDetailSrc).not.toContain("fetchTasks");
    expect(sessionDetailSrc).not.toContain("limit: 1000");
    expect(sessionDetailSrc).not.toContain("resolveTaskTitle");
  });

  it("uses server-resolved task_title from session data", () => {
    expect(sessionDetailSrc).toContain("task_title");
  });

  it("keeps agent text streaming outside TanStack Query", () => {
    expect(sessionDetailSrc).toContain("accumulateStreamingText");
    expect(sessionDetailSrc).toContain("streamingText");
    expect(sessionDetailSrc).toContain("subscribe(['agents'])");
  });
});

// AC: @ui-data-freshness ac-1
describe("sessions list page migration (@ui-data-freshness ac-1)", () => {
  it("uses createInfiniteQuery for paginated session list", () => {
    expect(sessionsSrc).toContain("createInfiniteQuery");
    expect(sessionsSrc).toContain("@tanstack/svelte-query");
  });

  it("uses query key factory for sessions", () => {
    expect(sessionsSrc).toContain("queryKeys.sessions.list");
  });

  it("uses createQuery for search results", () => {
    expect(sessionsSrc).toContain("createQuery");
    expect(sessionsSrc).toContain("fetchSessionSearch");
  });

  it("does not use manual $effect for data loading", () => {
    expect(sessionsSrc).not.toContain("async function loadInitialPage");
    expect(sessionsSrc).not.toContain("async function loadNextPage");
  });

  it("does not have manual WS subscription (handled by centralized wiring)", () => {
    expect(sessionsSrc).not.toContain("subscribe(");
    expect(sessionsSrc).not.toContain("unsubscribe(");
    expect(sessionsSrc).not.toContain("on('agents'");
    expect(sessionsSrc).not.toContain("off('agents'");
  });

  it("derives sessions from infinite query pages", () => {
    expect(sessionsSrc).toContain("sessionsQuery.data?.pages.flatMap");
  });

  it("uses fetchNextPage for infinite scroll", () => {
    expect(sessionsSrc).toContain("sessionsQuery.fetchNextPage()");
  });

  it("gates queries on project initialization", () => {
    expect(sessionsSrc).toContain("enabled: isProjectInitialized()");
  });

  it("does not fetch all tasks for title lookup", () => {
    expect(sessionsSrc).not.toContain("fetchTasks");
    expect(sessionsSrc).not.toContain("limit: 1000");
    expect(sessionsSrc).not.toContain("taskTitlesLoaded");
  });

  it("uses server-resolved task_title from session data", () => {
    expect(sessionsSrc).toContain("task_title");
  });

  it("preserves URL panel state AC annotations", () => {
    expect(sessionsSrc).toContain("AC: @ui-url-panel-state");
  });
});

// AC: @ui-data-freshness ac-3
describe("WS invalidation covers all migrated page topics (@ui-data-freshness ac-3)", () => {
  it("invalidates observations queries on file changes", () => {
    expect(wsInvalidationSrc).toContain("queryKeys.observations.all");
  });

  it("invalidates session queries on agent lifecycle events", () => {
    expect(wsInvalidationSrc).toContain("queryKeys.sessions.all");
  });
});

// Verify fetchTasks-for-titles pattern is eliminated
describe("fetchTasks-for-titles elimination", () => {
  it("agents page does not import fetchTasks", () => {
    expect(agentsSrc).not.toContain("fetchTasks");
  });

  it("session detail page does not import fetchTasks", () => {
    expect(sessionDetailSrc).not.toContain("fetchTasks");
  });

  it("sessions list page does not import fetchTasks", () => {
    expect(sessionsSrc).not.toContain("fetchTasks");
  });
});

// Verify server-side title resolution types
describe("server-side title resolution types", () => {
  it("ActiveInvocation includes task_title field", () => {
    expect(apiSrc).toContain("task_title: string | null");
  });

  it("SessionSummary includes task_title field", () => {
    // Check the task_title field is near task_id in SessionSummary
    const sessionSummaryBlock = apiSrc.slice(
      apiSrc.indexOf("interface SessionSummary"),
      apiSrc.indexOf("interface SessionSpecContext"),
    );
    expect(sessionSummaryBlock).toContain("task_title");
  });
});

// Query key factory additions
describe("query key factory additions for core pages", () => {
  it("sessions key factory includes list method with filters", () => {
    expect(keysSrc).toContain("sessions:");
    // Verify sessions has a list factory function
    const sessionsBlock = keysSrc.slice(
      keysSrc.indexOf("sessions:"),
      keysSrc.indexOf("plans:"),
    );
    expect(sessionsBlock).toContain("list:");
  });

  it("settings key factory includes health, projectConfig, shadow", () => {
    expect(keysSrc).toContain("health:");
    expect(keysSrc).toContain("projectConfig:");
    expect(keysSrc).toContain("shadow:");
  });
});
