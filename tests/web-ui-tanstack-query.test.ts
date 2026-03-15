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
const PROJECT_STORE_PATH = join(
  WEB_UI_SRC,
  "lib",
  "stores",
  "project.svelte.ts",
);
const PACKAGE_JSON_PATH = join(
  process.cwd(),
  "packages",
  "web-ui",
  "package.json",
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
const projectStoreSrc = readFileSync(PROJECT_STORE_PATH, "utf-8");
const packageJsonSrc = readFileSync(PACKAGE_JSON_PATH, "utf-8");
const packageJson = JSON.parse(packageJsonSrc);

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
describe("WebSocket invalidation wiring (@ui-data-freshness ac-3)", () => {
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

  it("context module exports clearQueryCache that calls queryClient.clear()", () => {
    expect(contextSrc).toContain("export function clearQueryCache");
    expect(contextSrc).toContain("queryClientInstance.clear()");
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
