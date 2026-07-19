/**
 * Live fetch envelope unwrapping tests.
 *
 * Verifies that api.ts fetch functions correctly unwrap the daemon's unified
 * response envelope and that CacheWarmingError is thrown for "loading" responses.
 *
 * AC: @api-contract ac-envelope — client-side unwrapping
 * AC: @api-contract ac-cache-status-field — loading status detection
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

const modeState = vi.hoisted(() => ({
  staticMode: false,
}));

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => null,
  isStaticMode: () => modeState.staticMode,
  assertWritable: (op: string) => {
    if (modeState.staticMode) {
      throw new Error(`Cannot ${op} in read-only mode.`);
    }
  },
  ReadOnlyModeError: class ReadOnlyModeError extends Error {
    constructor(operation: string) {
      super(`Cannot ${operation} in read-only mode.`);
    }
  },
}));

const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => null,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));

const constantsMock = vi.hoisted(() => () => ({
  DAEMON_API_BASE: "http://localhost:3456",
}));

// Mock both $lib/ alias (used by api-static.ts) and relative path (resolved by api.ts)
vi.mock("$lib/stores/mode.svelte", modeMock);
vi.mock("../../packages/web-ui/src/lib/stores/mode.svelte", modeMock);
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);
vi.mock("$lib/constants", constantsMock);
vi.mock("../../packages/web-ui/src/lib/constants", constantsMock);

// Mock api-static so imports don't fail (not exercised in live mode tests)
vi.mock("$lib/api-static", () => ({}));
vi.mock("../../packages/web-ui/src/lib/api-static", () => ({}));

import {
  fetchTasks,
  fetchTask,
  fetchItems,
  fetchItem,
  fetchItemTasks,
  fetchInbox,
  fetchPlans,
  fetchPlanContent,
  fetchWorkflows,
  fetchObservations,
  fetchReviews,
  fetchReviewSiblings,
  fetchReview,
  fetchSession,
  fetchSessions,
  fetchSessionSearch,
  fetchSessionEvents,
  fetchSessionEventDetail,
  search,
  fetchValidation,
  fetchAlignment,
  fetchProjectConfig,
  fetchShadowStatus,
  fetchConventions,
  fetchAgentDefinitions,
  fetchMergedInbox,
  fetchTriageRecords,
  fetchValidationAggregation,
  fetchTaskStatusSummary,
  CacheWarmingError,
} from "../../packages/web-ui/src/lib/api";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a mock fetch Response returning JSON body.
 */
function mockFetchJson(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

/**
 * Construct a paginated envelope matching daemon format.
 * AC: @api-contract ac-envelope
 */
function paginatedEnvelope<T>(
  data: T[],
  meta: { total?: number; offset?: number; limit?: number; cache_status?: string } = {},
) {
  return {
    data,
    meta: {
      cache_status: meta.cache_status ?? "ready",
      total: meta.total ?? data.length,
      offset: meta.offset ?? 0,
      limit: meta.limit ?? data.length,
    },
  };
}

/**
 * Construct a detail/aggregation envelope.
 */
function detailEnvelope<T>(data: T, cache_status = "ready") {
  return { data, meta: { cache_status } };
}

/**
 * Construct a list envelope (items + total, no offset/limit).
 */
function listEnvelope<T>(data: T[], cache_status = "ready") {
  return { data, meta: { cache_status, total: data.length } };
}

// ── Test data ───────────────────────────────────────────────────────────────

const sampleTask = {
  _ulid: "01TASK00000000000000000001",
  slugs: ["task-one"],
  title: "Task One",
  type: "task",
  status: "in_progress",
  priority: 2,
  spec_ref: "@spec-one",
  tags: ["ui"],
  depends_on: [],
  created_at: "2026-03-01T00:00:00.000Z",
  notes_count: 0,
};

const sampleItem = {
  _ulid: "01SPEC00000000000000000001",
  slugs: ["spec-one"],
  title: "Spec One",
  type: "feature",
  tags: ["ui"],
  created_at: "2026-03-01T00:00:00.000Z",
  acceptance_criteria_count: 1,
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("live fetch envelope unwrapping", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    modeState.staticMode = false;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // AC: @api-contract ac-envelope — paginated endpoints unwrap correctly
  describe("paginated endpoints", () => {
    it("fetchTasks unwraps paginated envelope to legacy shape", async () => {
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([sampleTask], { total: 1, offset: 0, limit: 50 }),
      );

      const result = await fetchTasks();
      expect(result).toEqual({
        items: [sampleTask],
        total: 1,
        offset: 0,
        limit: 50,
      });
    });

    it("fetchItems unwraps paginated envelope", async () => {
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([sampleItem], { total: 1, offset: 0, limit: 50 }),
      );

      const result = await fetchItems();
      expect(result).toEqual({
        items: [sampleItem],
        total: 1,
        offset: 0,
        limit: 50,
      });
    });

    it("fetchItemTasks unwraps paginated envelope", async () => {
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([sampleTask], { total: 1, offset: 0, limit: 50 }),
      );

      const result = await fetchItemTasks("@spec-one");
      expect(result).toEqual({
        items: [sampleTask],
        total: 1,
        offset: 0,
        limit: 50,
      });
    });

    it("fetchInbox unwraps paginated envelope", async () => {
      const inboxItem = {
        _ulid: "01INBOX0000000000000000001",
        text: "Test inbox",
        tags: [],
        added_by: "user",
        created_at: "2026-03-01T00:00:00.000Z",
      };
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([inboxItem], { total: 1, offset: 0, limit: 50 }),
      );

      const result = await fetchInbox();
      expect(result.items).toEqual([inboxItem]);
      expect(result.total).toBe(1);
    });

    it("fetchObservations unwraps paginated envelope", async () => {
      const obs = {
        _ulid: "01OBS0000000000000000001",
        type: "friction",
        content: "test",
        created_at: "2026-03-01T00:00:00.000Z",
      };
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([obs], { total: 1, offset: 0, limit: 50 }),
      );

      const result = await fetchObservations();
      expect(result.items).toEqual([obs]);
    });

    it("fetchReviews unwraps paginated envelope", async () => {
      const review = {
        _ulid: "01REV0000000000000000001",
        slugs: ["review-one"],
        title: "Review One",
        lifecycle_state: "open",
        disposition: "pending",
        subject_type: "task",
        author: "user",
        related_refs: [],
        thread_count: 0,
        unresolved_blocker_count: 0,
        check_count: 0,
        verdict_count: 0,
        created_at: "2026-03-01T00:00:00.000Z",
      };
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([review], { total: 1, offset: 0, limit: 50 }),
      );

      const result = await fetchReviews();
      expect(result.items).toEqual([review]);
    });

    it("fetchReviewSiblings requests all lifecycle states for revision history", async () => {
      const review = {
        _ulid: "01REV0000000000000000001",
        slugs: ["review-one"],
        title: "Review One",
        lifecycle_state: "open",
        disposition: "pending",
        subject_type: "task",
        subject_ref: "@task-one",
        author: "user",
        related_refs: [],
        thread_count: 0,
        unresolved_blocker_count: 0,
        check_count: 0,
        verdict_count: 0,
        created_at: "2026-03-01T00:00:00.000Z",
      };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(paginatedEnvelope([review], { total: 1, offset: 0, limit: 1 })),
      } as unknown as Response);
      globalThis.fetch = fetchMock;

      const result = await fetchReviewSiblings({
        subject_type: "task",
        subject_ref: "@task-one",
      });

      expect(result).toEqual([review]);

      const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(requestUrl.searchParams.getAll("status")).toEqual([
        "draft",
        "open",
        "closed",
        "archived",
      ]);
      expect(requestUrl.searchParams.get("subject_type")).toBe("task");
      expect(requestUrl.searchParams.get("subject_ref")).toBe("@task-one");
      expect(requestUrl.searchParams.get("sort")).toBe("created_at");
      expect(requestUrl.searchParams.get("sort_dir")).toBe("asc");
    });

    it("fetchTriageRecords unwraps paginated envelope", async () => {
      const triage = {
        _ulid: "01TRIAGE000000000000000001",
        inbox_ref: "01INBOX0000000000000000001",
        item_snapshot: "test",
        status: "triaged",
        action: "defer",
        evidence_refs: [],
        created_at: "2026-03-01T00:00:00.000Z",
      };
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([triage], { total: 1, offset: 0, limit: 50 }),
      );

      const result = await fetchTriageRecords();
      expect(result.items).toEqual([triage]);
    });
  });

  // AC: @api-contract ac-envelope — detail endpoints unwrap correctly
  describe("detail endpoints", () => {
    it("fetchTask unwraps detail envelope", async () => {
      const taskDetail = { ...sampleTask, notes: [], blocked_by: [], context: [], vcs_refs: [] };
      globalThis.fetch = mockFetchJson(detailEnvelope(taskDetail));

      const result = await fetchTask("@task-one");
      expect(result).toEqual(taskDetail);
    });

    it("fetchItem unwraps detail envelope", async () => {
      const itemDetail = {
        ...sampleItem,
        acceptance_criteria: [],
        traits: [],
        depends_on: [],
      };
      globalThis.fetch = mockFetchJson(detailEnvelope(itemDetail));

      const result = await fetchItem("@spec-one");
      expect(result).toEqual(itemDetail);
    });

    it("fetchPlanContent unwraps detail envelope", async () => {
      const plan = {
        _ulid: "01PLAN00000000000000000001",
        slugs: ["plan-one"],
        title: "Plan One",
        status: "active",
        content: "# Plan",
        created_at: "2026-03-01T00:00:00.000Z",
        derived_specs: [],
        derived_tasks: [],
        spec_count: 0,
        task_count: 0,
        task_progress: { total: 0, completed: 0, in_progress: 0, pending: 0, blocked: 0 },
      };
      globalThis.fetch = mockFetchJson(detailEnvelope(plan));

      const result = await fetchPlanContent("@plan-one");
      expect(result.title).toBe("Plan One");
      expect(result.content).toBe("# Plan");
    });

    it("fetchReview unwraps detail envelope", async () => {
      const reviewDetail = {
        _ulid: "01REV0000000000000000001",
        slugs: [],
        title: "Review",
        lifecycle_state: "open",
        disposition: "pending",
        subject: { type: "task", ref: "@task-one", shadow_commit: "abc", content_hash: "def" },
        author: "user",
        related_refs: [],
        threads: [],
        checks: [],
        verdicts: [],
        events: [],
        notes: [],
        external_links: [],
        examined_commit: null,
        created_at: "2026-03-01T00:00:00.000Z",
      };
      globalThis.fetch = mockFetchJson(detailEnvelope(reviewDetail));

      const result = await fetchReview("01REV0000000000000000001");
      expect(result.title).toBe("Review");
    });

    it("fetchSession unwraps detail envelope", async () => {
      const session = {
        id: "session-1",
        status: "active",
        agent_type: "claude-code",
        session_type: "invocation",
        started_at: "2026-03-01T00:00:00.000Z",
        duration_ms: 1000,
        event_count: 5,
        iteration_count: 1,
        tasks_completed: 0,
      };
      globalThis.fetch = mockFetchJson(detailEnvelope(session));

      const result = await fetchSession("session-1");
      expect(result.id).toBe("session-1");
      expect(result.status).toBe("active");
    });

    it("search unwraps detail envelope", async () => {
      const searchResult = {
        results: [{ type: "task", ulid: "01TASK", title: "Task", matchedFields: ["title"] }],
        total: 1,
        showing: 1,
      };
      globalThis.fetch = mockFetchJson(detailEnvelope(searchResult));

      const result = await search("Task");
      expect(result.results).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("fetchSessionSearch unwraps detail envelope", async () => {
      const searchResult = { items: [], total_sessions: 0, total_matches: 0, query: "test" };
      globalThis.fetch = mockFetchJson(detailEnvelope(searchResult));

      const result = await fetchSessionSearch({ q: "test" });
      expect(result.query).toBe("test");
    });

    it("fetchSessionEventDetail unwraps detail envelope", async () => {
      const event = { ts: 1000, seq: 0, type: "init", session_id: "s1", data: {} };
      globalThis.fetch = mockFetchJson(detailEnvelope(event));

      const result = await fetchSessionEventDetail("s1", 0);
      expect(result.type).toBe("init");
    });

    it("fetchValidation unwraps detail envelope and normalizes fields", async () => {
      const validation = { valid: true };
      globalThis.fetch = mockFetchJson(detailEnvelope(validation));

      const result = await fetchValidation();
      expect(result.valid).toBe(true);
      expect(result.schemaErrors).toEqual([]);
      expect(result.refErrors).toEqual([]);
    });

    it("fetchAlignment unwraps detail envelope", async () => {
      const alignment = {
        stats: { totalSpecs: 5, specsWithTasks: 3, alignedSpecs: 3, orphanedSpecs: 2 },
        warnings: [],
      };
      globalThis.fetch = mockFetchJson(detailEnvelope(alignment));

      const result = await fetchAlignment();
      expect(result.stats.totalSpecs).toBe(5);
    });

    it("fetchProjectConfig unwraps detail envelope", async () => {
      const config = {
        project: { name: "test", version: "1.0.0", status: "active" },
        spec_version: "1.0.0",
        root_dir: "/tmp",
        remote_tracking: null,
        daemon: { port: 3456, host: "localhost", auto_start: true },
      };
      globalThis.fetch = mockFetchJson(detailEnvelope(config));

      const result = await fetchProjectConfig();
      expect(result.project?.name).toBe("test");
    });

    it("fetchShadowStatus unwraps detail envelope", async () => {
      const shadow = {
        enabled: true,
        branch_name: "kspec-meta",
        worktree_dir: ".kspec",
        healthy: true,
        remote_tracking: false,
      };
      globalThis.fetch = mockFetchJson(detailEnvelope(shadow));

      const result = await fetchShadowStatus();
      expect(result.healthy).toBe(true);
    });

    it("fetchValidationAggregation unwraps detail envelope", async () => {
      const agg = {
        entity_count: 10,
        ac_count: 20,
        trait_ac_count: 5,
        trait_count: 3,
        coverage_percent: 80,
      };
      globalThis.fetch = mockFetchJson(detailEnvelope(agg));

      const result = await fetchValidationAggregation();
      expect(result.entity_count).toBe(10);
    });

    // AC: @ui-dashboard-overview ac-counts-from-summary — live mode hits the
    // pre-computed aggregation endpoint instead of the full task list
    // AC: @ui-api-aggregation ac-1
    it("fetchTaskStatusSummary calls the aggregation endpoint and unwraps the envelope", async () => {
      const summary = {
        counts: { pending: 3, in_progress: 1, completed: 2, blocked: 1 },
        ready: 2,
        blocked_by_dependencies: 1,
        total: 7,
      };
      const fetchMock = mockFetchJson(detailEnvelope(summary));
      globalThis.fetch = fetchMock;

      const result = await fetchTaskStatusSummary();

      expect(result).toEqual(summary);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestedUrl = String(fetchMock.mock.calls[0][0]);
      expect(requestedUrl).toBe("http://localhost:3456/api/aggregation/tasks/summary");
    });

    // AC: @api-contract ac-cache-status-field — warming summary throws instead
    // of caching empty counts
    it("fetchTaskStatusSummary throws CacheWarmingError when cache is loading", async () => {
      globalThis.fetch = mockFetchJson({
        data: { counts: {}, ready: 0, blocked_by_dependencies: 0, total: 0 },
        meta: { cache_status: "loading" },
      });

      await expect(fetchTaskStatusSummary()).rejects.toBeInstanceOf(CacheWarmingError);
    });
  });

  // AC: @api-contract ac-envelope — list endpoints unwrap correctly
  describe("list endpoints", () => {
    it("fetchPlans unwraps list envelope", async () => {
      const plan = {
        _ulid: "01PLAN",
        slugs: ["plan-one"],
        title: "Plan",
        status: "active",
        created_at: "2026-03-01T00:00:00.000Z",
        derived_specs: [],
        derived_tasks: [],
        spec_count: 0,
        task_count: 0,
        task_progress: { total: 0, completed: 0, in_progress: 0, pending: 0, blocked: 0 },
      };
      globalThis.fetch = mockFetchJson(listEnvelope([plan]));

      const result = await fetchPlans();
      expect(result.items).toEqual([plan]);
      expect(result.total).toBe(1);
    });

    it("fetchWorkflows unwraps list envelope", async () => {
      const wf = { _ulid: "01WF", id: "wf-1", trigger: "manual", steps: [] };
      globalThis.fetch = mockFetchJson(listEnvelope([wf]));

      const result = await fetchWorkflows();
      expect(result.items).toEqual([wf]);
      expect(result.total).toBe(1);
    });

    it("fetchConventions unwraps list envelope", async () => {
      const conv = { _ulid: "01CONV", domain: "commits", rules: ["Use conventional commits"] };
      globalThis.fetch = mockFetchJson(listEnvelope([conv]));

      const result = await fetchConventions();
      expect(result.items).toEqual([conv]);
    });

    it("fetchAgentDefinitions unwraps list envelope", async () => {
      const agent = { id: "worker", name: "Task Worker" };
      globalThis.fetch = mockFetchJson(listEnvelope([agent]));

      const result = await fetchAgentDefinitions();
      expect(result.items).toEqual([agent]);
    });

    it("fetchMergedInbox unwraps list envelope", async () => {
      const item = {
        _ulid: "01INBOX0000000000000000001",
        text: "Test",
        tags: [],
        added_by: "user",
        created_at: "2026-03-01T00:00:00.000Z",
      };
      globalThis.fetch = mockFetchJson(listEnvelope([item]));

      const result = await fetchMergedInbox();
      expect(result.items).toEqual([item]);
      expect(result.total).toBe(1);
    });
  });

  // AC: @api-contract ac-envelope — session endpoints unwrap correctly
  describe("session endpoints", () => {
    it("fetchSessions unwraps session list envelope", async () => {
      const session = {
        id: "s1",
        status: "active",
        agent_type: "claude-code",
        session_type: "invocation",
        started_at: "2026-03-01T00:00:00.000Z",
        duration_ms: 1000,
        event_count: 5,
        iteration_count: 1,
        tasks_completed: 0,
      };
      globalThis.fetch = mockFetchJson({
        data: { items: [session], unfiltered_total: 10 },
        meta: { cache_status: "ready", total: 1, offset: 0, limit: 25 },
      });

      const result = await fetchSessions();
      expect(result.items).toEqual([session]);
      expect(result.total).toBe(1);
      expect(result.unfiltered_total).toBe(10);
    });

    it("fetchSessionEvents unwraps envelope and extracts events + total", async () => {
      const events = [{ ts: 1000, seq: 0, type: "init", session_id: "s1", data: {} }];
      globalThis.fetch = mockFetchJson({
        data: { events },
        meta: { cache_status: "ready", total: 1 },
      });

      const result = await fetchSessionEvents("s1");
      expect(result.events).toEqual(events);
      expect(result.total).toBe(1);
    });
  });

  // AC: @api-contract ac-cache-status-field — loading status throws CacheWarmingError
  describe("cache warming detection", () => {
    it("CacheWarmingError is exported and has correct properties", () => {
      const err = new CacheWarmingError();
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("CacheWarmingError");
      expect(err.cacheStatus).toBe("loading");
      expect(err.message).toContain("warming");
    });

    it("fetchTasks throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([], { total: 0, offset: 0, limit: 50, cache_status: "loading" }),
      );

      await expect(fetchTasks()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchItems throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([], { total: 0, offset: 0, limit: 50, cache_status: "loading" }),
      );

      await expect(fetchItems()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchTask throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(detailEnvelope({}, "loading"));

      await expect(fetchTask("@task-one")).rejects.toThrow(CacheWarmingError);
    });

    it("fetchItem throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(detailEnvelope({}, "loading"));

      await expect(fetchItem("@spec-one")).rejects.toThrow(CacheWarmingError);
    });

    it("fetchPlans throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(listEnvelope([], "loading"));

      await expect(fetchPlans()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchWorkflows throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(listEnvelope([], "loading"));

      await expect(fetchWorkflows()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchReviews throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([], { total: 0, offset: 0, limit: 50, cache_status: "loading" }),
      );

      await expect(fetchReviews()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchSessions throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson({
        data: { items: [], unfiltered_total: 0 },
        meta: { cache_status: "loading", total: 0, offset: 0, limit: 25 },
      });

      await expect(fetchSessions()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchValidation throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(detailEnvelope({ valid: true }, "loading"));

      await expect(fetchValidation()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchAlignment throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(detailEnvelope({}, "loading"));

      await expect(fetchAlignment()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchMergedInbox throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(listEnvelope([], "loading"));

      await expect(fetchMergedInbox()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchObservations throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([], { total: 0, offset: 0, limit: 50, cache_status: "loading" }),
      );

      await expect(fetchObservations()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchTriageRecords throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(
        paginatedEnvelope([], { total: 0, offset: 0, limit: 50, cache_status: "loading" }),
      );

      await expect(fetchTriageRecords()).rejects.toThrow(CacheWarmingError);
    });

    it("search throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(detailEnvelope({}, "loading"));

      await expect(search("test")).rejects.toThrow(CacheWarmingError);
    });

    it("fetchConventions throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(listEnvelope([], "loading"));

      await expect(fetchConventions()).rejects.toThrow(CacheWarmingError);
    });

    it("fetchAgentDefinitions throws CacheWarmingError when cache_status is loading", async () => {
      globalThis.fetch = mockFetchJson(listEnvelope([], "loading"));

      await expect(fetchAgentDefinitions()).rejects.toThrow(CacheWarmingError);
    });
  });
});
