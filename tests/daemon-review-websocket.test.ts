/**
 * Tests for WebSocket broadcasts on review mutation endpoints
 *
 * Spec: @review-records-daemon-api ac-9
 * Task: @task-review-api-websocket
 *
 * Verifies that all review mutation endpoints broadcast events
 * on the "reviews:updates" topic so the UI can refresh without polling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Elysia } from "elysia";
import {
  captureBroadcasts,
  cleanupTempDir,
  createTempDir,
  createTestApp,
  FOLDER_BACKED_INLINE_MANIFEST,
  initGitRepo,
  requestJson,
  setupInlineFixtures,
  testUlid,
} from "./daemon-api/helpers.js";
import type { PubSubManager } from "../dist/daemon/websocket/pubsub.js";

// AC: @daemon-test-mode-boundaries ac-in-process-route-tests-no-child-process
// AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run

// Test ULIDs
const REVIEW_OPEN_ULID = testUlid("RVOP", 1);
const REVIEW_DRAFT_ULID = testUlid("RVDR", 2);
const REVIEW_CLOSED_ULID = testUlid("RVCL", 3);
const TASK_ULID = testUlid("TASK", 4);
const THREAD_ULID = testUlid("THRD", 5);

let tempDir: string;
let app: Elysia;
let pubsub: PubSubManager;
let broadcastSpy: ReturnType<typeof captureBroadcasts>;

// Split-storage task seed used by setupInlineFixtures({ splitTasks: [...] })
// under the folder-backed manifest (which declares task_storage.format: split).
const REVIEW_FIXTURES_SPLIT_TASK = {
  _ulid: TASK_ULID,
  slugs: ["task-test"],
  title: "Test Task",
  description: "A test task",
  status: "pending_review",
  spec_ref: "@test-feature",
  review_ref: "@review-open",
  created_at: "2026-01-01T00:00:00Z",
};

function reviewFixturesYaml(): string {
  return `kynetic_reviews: "1.0"
reviews:
  - _ulid: "${REVIEW_OPEN_ULID}"
    slugs:
      - review-open
    title: "Open review"
    lifecycle_state: open
    author: "@test"
    subject:
      type: task
      ref: "@task-test"
      shadow_commit: "abc123"
      content_hash: "hash1"
    verdicts: []
    checks: []
    threads:
      - _ulid: "${THREAD_ULID}"
        kind: blocker
        resolved: false
        entries:
          - _ulid: "${testUlid("ENTR", 1)}"
            author: "reviewer@example.com"
            body: "This needs fixing"
            created_at: "2026-01-01T00:00:00Z"
        anchors: []
        created_at: "2026-01-01T00:00:00Z"
        updated_at: "2026-01-01T00:00:00Z"
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_DRAFT_ULID}"
    slugs:
      - review-draft
    title: "Draft review"
    lifecycle_state: draft
    author: "@test"
    subject:
      type: plan
      ref: "@plan-test"
      shadow_commit: "abc123"
      content_hash: "hash2"
    verdicts: []
    checks: []
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
  - _ulid: "${REVIEW_CLOSED_ULID}"
    slugs:
      - review-closed
    title: "Closed review"
    lifecycle_state: closed
    author: "@test"
    subject:
      type: plan
      ref: "@plan-test"
      shadow_commit: "abc123"
      content_hash: "hash3"
    verdicts: []
    checks: []
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
`;
}

const REVIEW_FIXTURE_MODULES = {
  "test.yaml": `features:
  - _ulid: "${testUlid("SPEC", 1)}"
    slugs:
      - test-feature
    title: "Test Feature"
    type: feature
    description: "A test feature"
    created: "2026-01-01T00:00:00Z"
`,
};

// Agent roster so the actor values these broadcast tests send (email-suffix
// variants like `reviewer@test.com`) classify to a configured agent identity
// and persist in canonical form (`reviewer`) rather than being rejected as
// out-of-pool free-form authors by the shared actor-write utility.
// AC: @actor-identity-resolution ac-7 — recognized variant persists as canonical id
const REVIEW_FIXTURE_META = `kynetic_meta: "1.0"
agents:
  - _ulid: ${testUlid("AGNT", 6)}
    id: reviewer
    name: Reviewer Agent
    description: Review agent
    adapter: claude-agent-acp
    dispatch: []
    capabilities: []
    tools: []
    skills: []
    concurrency:
      max_concurrent: 1
    auto_approve: false
  - _ulid: ${testUlid("AGNT", 7)}
    id: worker
    name: Worker Agent
    description: Worker agent
    adapter: claude-agent-acp
    dispatch: []
    capabilities: []
    tools: []
    skills: []
    concurrency:
      max_concurrent: 1
    auto_approve: false
  - _ulid: ${testUlid("AGNT", 8)}
    id: lead
    name: Lead Agent
    description: Lead agent
    adapter: claude-agent-acp
    dispatch: []
    capabilities: []
    tools: []
    skills: []
    concurrency:
      max_concurrent: 1
    auto_approve: false
`;

// AC: @review-records-daemon-api ac-9
describe("Review WebSocket Broadcasts", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-review-ws-");
    initGitRepo(tempDir);
    setupInlineFixtures(tempDir, {
      manifest: FOLDER_BACKED_INLINE_MANIFEST,
      modules: REVIEW_FIXTURE_MODULES,
      splitTasks: [REVIEW_FIXTURES_SPLIT_TASK],
      reviews: reviewFixturesYaml(),
      meta: REVIEW_FIXTURE_META,
    });

    ({ app, pubsub } = createTestApp());
    broadcastSpy = captureBroadcasts(pubsub);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // AC: @review-records-daemon-api ac-9
  it("should broadcast thread_created when adding a comment thread", async () => {
    const response = await requestJson(
      app,
      tempDir,
      "POST",
      `/api/reviews/${REVIEW_OPEN_ULID}/comments`,
      {
        body: "Found an issue here",
        kind: "blocker",
        author: "reviewer@test.com",
      },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "thread_created",
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        kind: "blocker",
        author: "reviewer",
      }),
      expect.any(String),
    );

    // Verify thread_ulid is included in the payload
    const payload = broadcastSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.thread_ulid).toBeDefined();
    expect(typeof payload.thread_ulid).toBe("string");
  });

  // AC: @review-records-daemon-api ac-9
  it("should broadcast thread_replied when adding a reply", async () => {
    const response = await requestJson(
      app,
      tempDir,
      "POST",
      `/api/reviews/${REVIEW_OPEN_ULID}/comments/${THREAD_ULID}/replies`,
      {
        body: "Fixed in latest commit",
        author: "worker@test.com",
      },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "thread_replied",
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        thread_ulid: THREAD_ULID,
        author: "worker",
      }),
      expect.any(String),
    );

    // Verify entry_ulid is included
    const payload = broadcastSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.entry_ulid).toBeDefined();
    expect(typeof payload.entry_ulid).toBe("string");
  });

  // AC: @review-records-daemon-api ac-9
  it("should broadcast thread_resolved when resolving a thread", async () => {
    const response = await requestJson(
      app,
      tempDir,
      "PATCH",
      `/api/reviews/${REVIEW_OPEN_ULID}/comments/${THREAD_ULID}/resolve`,
      {
        actor: "reviewer@test.com",
      },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "thread_resolved",
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        thread_ulid: THREAD_ULID,
        actor: "reviewer",
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it("should broadcast thread_reopened when reopening a resolved thread", async () => {
    // First resolve the thread
    await requestJson(
      app,
      tempDir,
      "PATCH",
      `/api/reviews/${REVIEW_OPEN_ULID}/comments/${THREAD_ULID}/resolve`,
      { actor: "reviewer@test.com" },
    );
    broadcastSpy.mockClear();

    // Then reopen it
    const response = await requestJson(
      app,
      tempDir,
      "PATCH",
      `/api/reviews/${REVIEW_OPEN_ULID}/comments/${THREAD_ULID}/reopen`,
      { actor: "reviewer@test.com" },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "thread_reopened",
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        thread_ulid: THREAD_ULID,
        actor: "reviewer",
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it("should broadcast verdict_submitted when recording a verdict", async () => {
    const response = await requestJson(
      app,
      tempDir,
      "POST",
      `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`,
      {
        decision: "approve",
        reviewer: "lead@test.com",
      },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "verdict_submitted",
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        decision: "approve",
        reviewer: "lead",
        disposition: expect.any(String),
        lifecycle_state: expect.any(String),
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it("should broadcast check_added when recording a check", async () => {
    const response = await requestJson(
      app,
      tempDir,
      "POST",
      `/api/reviews/${REVIEW_OPEN_ULID}/checks`,
      {
        name: "vitest",
        status: "pass",
        runner: "vitest",
        evidence: "All 100 tests passed",
      },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "check_added",
      expect.objectContaining({
        review_ulid: REVIEW_OPEN_ULID,
        check_name: "vitest",
        check_status: "pass",
        gate_state: expect.any(String),
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it("should broadcast lifecycle_changed when transitioning lifecycle state", async () => {
    const response = await requestJson(
      app,
      tempDir,
      "PATCH",
      `/api/reviews/${REVIEW_DRAFT_ULID}/lifecycle`,
      {
        target: "open",
        actor: "reviewer@test.com",
      },
    );

    expect(response.status).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledOnce();
    expect(broadcastSpy).toHaveBeenCalledWith(
      "reviews:updates",
      "lifecycle_changed",
      expect.objectContaining({
        review_ulid: REVIEW_DRAFT_ULID,
        from: "draft",
        to: "open",
        actor: "reviewer",
      }),
      expect.any(String),
    );
  });

  // AC: @review-records-daemon-api ac-9
  it("should not broadcast when mutation fails with validation error", async () => {
    const response = await requestJson(
      app,
      tempDir,
      "POST",
      `/api/reviews/${REVIEW_OPEN_ULID}/verdicts`,
      {
        decision: "invalid_decision",
        reviewer: "test@example.com",
      },
    );

    expect(response.status).toBe(400);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  // AC: @review-records-daemon-api ac-9
  it("should not broadcast when review is not found", async () => {
    const response = await requestJson(app, tempDir, "POST", "/api/reviews/nonexistent/verdicts", {
      decision: "approve",
      reviewer: "test@example.com",
    });

    expect(response.status).toBe(404);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  // AC: @review-records-daemon-api ac-9
  it("should include projectPath in all broadcasts", async () => {
    await requestJson(app, tempDir, "POST", `/api/reviews/${REVIEW_OPEN_ULID}/comments`, {
      body: "Test comment",
      kind: "nit",
    });

    expect(broadcastSpy).toHaveBeenCalledOnce();
    // Fourth argument is the projectPath
    const projectPath = broadcastSpy.mock.calls[0][3];
    expect(projectPath).toBeDefined();
    expect(typeof projectPath).toBe("string");
  });
});

// AC: @review-records-daemon-api ac-9
describe("Review WebSocket Event Data Shape", () => {
  // Type conformance tests: verify broadcast payloads match the typed interfaces
  // from packages/shared/src/websocket.ts. The import ensures the interfaces
  // compile; the runtime checks verify the actual broadcast data shape.

  let localTempDir: string;
  let localApp: Elysia;
  let localPubsub: PubSubManager;
  let localSpy: ReturnType<typeof captureBroadcasts>;

  beforeEach(async () => {
    localTempDir = await createTempDir("kspec-review-ws-shape-");
    initGitRepo(localTempDir);

    setupInlineFixtures(localTempDir, {
      manifest: FOLDER_BACKED_INLINE_MANIFEST,
      modules: REVIEW_FIXTURE_MODULES,
      splitTasks: [],
      reviews: `kynetic_reviews: "1.0"
reviews:
  - _ulid: "${testUlid("RVSH", 1)}"
    slugs:
      - review-shape-test
    title: "Shape test review"
    lifecycle_state: open
    author: "@test"
    subject:
      type: plan
      ref: "@plan-test"
      shadow_commit: "abc123"
      content_hash: "hash1"
    verdicts: []
    checks: []
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
`,
      meta: REVIEW_FIXTURE_META,
    });

    ({ app: localApp, pubsub: localPubsub } = createTestApp());
    localSpy = captureBroadcasts(localPubsub);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(localTempDir);
  });

  it("should broadcast thread_created with ReviewThreadCreatedEventData shape", async () => {
    const response = await requestJson(
      localApp,
      localTempDir,
      "POST",
      "/api/reviews/review-shape-test/comments",
      { body: "Test", kind: "nit", author: "reviewer" },
    );

    expect(response.status).toBe(200);
    const payload = localSpy.mock.calls[0][2] as Record<string, unknown>;
    // ReviewThreadCreatedEventData shape: review_ulid, thread_ulid, kind, author
    expect(payload).toHaveProperty("review_ulid");
    expect(payload).toHaveProperty("thread_ulid");
    expect(payload).toHaveProperty("kind");
    expect(payload).toHaveProperty("author");
    expect(Object.keys(payload).toSorted()).toEqual([
      "author",
      "kind",
      "review_ulid",
      "thread_ulid",
    ]);
  });

  it("should broadcast check_added with ReviewCheckAddedEventData shape", async () => {
    const response = await requestJson(
      localApp,
      localTempDir,
      "POST",
      `/api/reviews/review-shape-test/checks`,
      { name: "vitest", status: "pass", runner: "vitest" },
    );

    expect(response.status).toBe(200);
    const payload = localSpy.mock.calls[0][2] as Record<string, unknown>;
    // ReviewCheckAddedEventData shape: review_ulid, check_name, check_status, gate_state
    expect(payload).toHaveProperty("review_ulid");
    expect(payload).toHaveProperty("check_name");
    expect(payload).toHaveProperty("check_status");
    expect(payload).toHaveProperty("gate_state");
    expect(Object.keys(payload).toSorted()).toEqual([
      "check_name",
      "check_status",
      "gate_state",
      "review_ulid",
    ]);
  });
});

// Trait AC annotations for this task's spec
// AC: @trait-json-output ac-1 — N/A: WebSocket events are not CLI commands; they broadcast JSON by design
// AC: @trait-json-output ac-2 — N/A: WebSocket events carry mutation-specific data, not human-readable output
// AC: @trait-json-output ac-3 — N/A: WebSocket broadcasts only on successful mutations; errors don't broadcast
// AC: @trait-json-output ac-4 — N/A: WebSocket event payloads use ULIDs, not @ prefix references
// AC: @trait-json-output ac-5 — N/A: Timestamps in broadcast events use ISO 8601 via BroadcastEvent.timestamp
// AC: @trait-json-output ac-6 — N/A: WebSocket events have no formatting flags
// AC: @trait-error-guidance ac-1 — N/A: WebSocket broadcasts are fire-and-forget; errors in mutation endpoints are covered by ac-10 tests
// AC: @trait-error-guidance ac-2 — N/A: Mutation endpoint error responses are tested in daemon-review-verdicts-api.test.ts
// AC: @trait-error-guidance ac-3 — N/A: Not-found errors are tested in daemon-review-verdicts-api.test.ts
// AC: @trait-error-guidance ac-4 — N/A: Invalid lifecycle transitions are tested in daemon-review-verdicts-api.test.ts
// AC: @trait-error-guidance ac-5 — N/A: Validation errors with field details are tested in daemon-review-verdicts-api.test.ts
// AC: @trait-error-guidance ac-6 — N/A: API is always JSON; no --json flag distinction
// AC: @trait-localhost-security ac-loopback-default — N/A: WebSocket event-logic unit tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
// AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
// AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
// AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket connection handling is in server.ts ws handler
// AC: @trait-websocket-protocol ac-2 — N/A: Topic subscription is in websocket/handler.ts
// AC: @trait-websocket-protocol ac-3 — Broadcast format is verified via pubsub spy assertions (topic, event, data structure)
// AC: @trait-websocket-protocol ac-4 — N/A: Heartbeat is in websocket/heartbeat.ts
// AC: @trait-websocket-protocol ac-5 — N/A: Pong timeout is in websocket/heartbeat.ts
// AC: @trait-websocket-protocol ac-6 — N/A: Backpressure is handled by PubSubManager
// AC: @trait-websocket-protocol ac-7 — N/A: Close codes are in websocket/lifecycle.ts
// AC: @trait-websocket-protocol ac-8 — N/A: Reconnection is client-side behavior
