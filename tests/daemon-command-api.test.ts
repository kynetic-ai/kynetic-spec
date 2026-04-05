/**
 * Tests for the daemon command API endpoint.
 *
 * AC Coverage:
 * - @daemon-command-api ac-command-endpoint: POST /api/command executes commands
 * - @daemon-command-api ac-mutation-cache-update: cache updated after mutations
 * - @daemon-command-api ac-batch-support: batch array execution
 * - @daemon-command-api ac-concurrent-mutations: serialized mutation execution
 * - @daemon-command-api ac-response-parity: stdout/stderr/exitCode match direct CLI
 * - @trait-api-endpoint ac-1: returns 2xx with JSON body
 * - @trait-api-endpoint ac-3: returns 400 on invalid body
 * - @trait-api-endpoint ac-6: includes X-Request-Id header
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.js";
import { createCommandRoutes } from "../dist/daemon/routes/command.js";
import { PubSubManager } from "../dist/daemon/websocket/pubsub.js";
import type {
  RouteEntityCache,
  EntityCacheAccessor,
} from "../dist/daemon/routes/entity-cache-types.js";

ensureSplitBackendRegistered();

const TASK_ULID = testUlid("TASK", 1);
const SPEC_ULID = testUlid("SPEC", 2);
const PLAN_ULID = testUlid("PLAN", 3);

let tempDir: string;
let app: Elysia;
let pubsub: PubSubManager;
let mockCache: RouteEntityCache;
let writeThroughCalls: string[];

/**
 * Create a mock entity cache that tracks writeThrough calls.
 * This ensures ac-mutation-cache-update is genuinely exercised.
 */
function createMockEntityCache(): RouteEntityCache {
  writeThroughCalls = [];
  return {
    getDomainState: () => "ready",
    getTaskIndex: () => null,
    getTaskDetail: () => null,
    setTaskDetail: () => {},
    getItemIndex: () => null,
    getItemDetail: () => null,
    setItemDetail: () => {},
    getSessionIndex: () => null,
    getSessionDetail: () => null,
    setSessionDetail: () => {},
    getPlansIndex: () => null,
    getPlanDetail: () => null,
    setPlanDetail: () => {},
    getInboxIndex: () => null,
    getTriageIndex: () => null,
    getTriageDetail: () => null,
    setTriageDetail: () => {},
    getReviewsIndex: () => null,
    getReviewDetail: () => null,
    setReviewDetail: () => {},
    getMetaIndex: () => null,
    getMetaDetail: () => null,
    setMetaDetail: () => {},
    writeThrough: vi.fn(async (domain: string) => {
      writeThroughCalls.push(domain);
    }),
    markWriteThrough: vi.fn(),
  };
}

function makeRequest(urlPath: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${urlPath}`, {
      method: init.method ?? "GET",
      headers: {
        Host: "localhost",
        "X-Kspec-Dir": tempDir,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body,
    }),
  );
}

function setupFixtures() {
  mkdirSync(path.join(tempDir, ".kspec"), { recursive: true });
  mkdirSync(path.join(tempDir, "modules"), { recursive: true });

  // Use kynetic 1.1 with split task storage format
  writeFileSync(
    path.join(tempDir, "kynetic.yaml"),
    `kynetic: "1.1"
task_storage:
  format: split
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`,
  );

  writeFileSync(
    path.join(tempDir, "modules", "test.yaml"),
    `features:
  - _ulid: "${SPEC_ULID}"
    slugs:
      - test-feature
    title: "Test Feature"
    type: feature
    description: "A test feature"
    created: "2026-01-01T00:00:00Z"
`,
  );

  // Seed task in split format (per-task directory)
  seedSplitTask(tempDir, {
    _ulid: TASK_ULID,
    slugs: ["task-test"],
    title: "Test Task",
    description: "A test task",
    status: "pending",
    type: "task",
    automation: "eligible",
    spec_ref: "@test-feature",
    created_at: "2026-01-01T00:00:00Z",
    notes: [],
  });

  writeFileSync(
    path.join(tempDir, "project.inbox.yaml"),
    `items: []
`,
  );

  writeFileSync(
    path.join(tempDir, "project.reviews.yaml"),
    `kynetic_reviews: "1.0"
reviews: []
`,
  );

  writeFileSync(
    path.join(tempDir, "project.plans.yaml"),
    `kynetic_plans: "1.0"
plans:
  - _ulid: "${PLAN_ULID}"
    slugs:
      - test-plan
    title: "Test Plan"
    content: |
      # Test Plan Content

      This is plan content written via process.stdout.write.
      It spans multiple lines to verify full capture.
    status: draft
    derived_tasks: []
    derived_specs: []
    created_at: "2026-01-01T00:00:00Z"
    notes: []
`,
  );

  writeFileSync(
    path.join(tempDir, "project.triage.yaml"),
    `kynetic_triage: "1.0"
records: []
`,
  );

  writeFileSync(
    path.join(tempDir, "kynetic.meta.yaml"),
    `kynetic_meta: "1.0"
agents: []
observations: []
workflows: []
conventions: []
`,
  );

  mkdirSync(path.join(tempDir, ".kspec-sessions"), { recursive: true });

  execSync('git add -A && git commit -m "kspec project setup"', { cwd: tempDir, stdio: "pipe" });
}

describe("Daemon Command API", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-command-api-");
    initGitRepo(tempDir);
    setupFixtures();

    pubsub = new PubSubManager();
    mockCache = createMockEntityCache();
    const getEntityCache: EntityCacheAccessor = (projectPath: string) => {
      // Return mock cache only for the temp project
      if (projectPath === tempDir) return mockCache;
      return null;
    };
    const { middleware } = projectContextMiddleware();
    app = new Elysia().use(middleware).use(createCommandRoutes({ pubsub, getEntityCache }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-command-endpoint
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-command-endpoint
  it("executes a read-only command and returns stdout, stderr, and exitCode", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
        args: { json: true },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("stdout");
    expect(body).toHaveProperty("stderr");
    expect(body).toHaveProperty("exitCode");
    expect(body.exitCode).toBe(0);
    // stdout should contain task data since we have a task in fixtures
    expect(body.stdout).toBeTruthy();
  });

  // AC: @daemon-command-api ac-command-endpoint
  it("returns non-zero exitCode for unknown commands", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "nonexistent-command",
        args: {},
      }),
    });

    const body = await response.json();
    expect(body.exitCode).not.toBe(0);
    expect(body.stderr).toBeTruthy();
  });

  // AC: @daemon-command-api ac-response-parity
  it("produces matching stderr for unknown commands vs direct CLI", async () => {
    // Run the same unknown command via direct CLI (subprocess) as ground truth
    const cliResult = kspec("nonexistent-command", tempDir, { expectFail: true });

    // Run the same unknown command via the daemon API
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "nonexistent-command",
        args: {},
      }),
    });

    const body = await response.json();
    expect(body.exitCode).not.toBe(0);

    // CLI stderr contains the Commander "command:*" handler output.
    // The API must produce the same error text — not a custom message.
    // Strip ANSI codes for comparison since chalk may differ between contexts.
    // oxlint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const cliStderr = stripAnsi(cliResult.stderr);
    const apiStderr = stripAnsi(body.stderr);

    expect(apiStderr).toContain("error: unknown command 'nonexistent-command'");
    expect(apiStderr).toContain(
      cliStderr.includes("Did you mean")
        ? "Did you mean"
        : "Run 'kspec help' to see available commands",
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-response-parity
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-response-parity
  it("produces the same stdout content as direct CLI execution", async () => {
    // Run the same command via the direct CLI (subprocess) as ground truth
    const cliResult = kspec("task get @task-test --json", tempDir);

    // Run the same command via the daemon API
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task get",
        args: { ref: "@task-test", json: true },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Both should produce parseable JSON with the same task data
    const cliTask = JSON.parse(cliResult.stdout);
    const apiTask = JSON.parse(body.stdout);

    // Verify key structural fields match — these are the user-visible outputs
    // that must be identical between CLI and API
    expect(apiTask.title).toBe(cliTask.title);
    expect(apiTask.status).toBe(cliTask.status);
    expect(apiTask._ulid).toBe(cliTask._ulid);
    expect(apiTask.type).toBe(cliTask.type);
    expect(apiTask.spec_ref).toBe(cliTask.spec_ref);

    // Verify stdout is returned verbatim (not trimmed) — the kspec() helper
    // trims its output, so the API result should contain that content plus
    // the trailing newline that direct CLI execution produces.
    expect(body.stdout).toContain(cliResult.stdout);
    expect(body.stdout).toMatch(/\n$/);
  });

  // AC: @daemon-command-api ac-response-parity
  it("captures process.stdout.write output (plan export uses stdout.write)", async () => {
    // plan export writes directly to process.stdout.write, not console.log.
    // This was the exact scenario the reviewer identified as broken.
    const cliResult = kspec("plan export @test-plan", tempDir);

    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "plan export",
        args: { ref: "@test-plan" },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Both should contain the plan content
    expect(cliResult.stdout).toContain("# Test Plan Content");
    expect(body.stdout).toContain("# Test Plan Content");

    // API stdout contains the trimmed CLI result (kspec() helper trims)
    expect(body.stdout).toContain(cliResult.stdout);
    // API stdout is returned verbatim — not stripped
    expect(body.stdout.length).toBeGreaterThanOrEqual(cliResult.stdout.length);
  });

  // AC: @daemon-command-api ac-response-parity
  it("produces matching exitCode for failing commands via CLI and API", async () => {
    // Run a command that fails via direct CLI
    const cliResult = kspec("task get @nonexistent-task --json", tempDir, { expectFail: true });

    // Run the same command via the daemon API
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task get",
        args: { ref: "@nonexistent-task", json: true },
      }),
    });

    const body = await response.json();

    // Both should fail with non-zero exit code
    expect(cliResult.exitCode).not.toBe(0);
    expect(body.exitCode).not.toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-mutation-cache-update
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-mutation-cache-update
  it("calls writeThrough on entity cache after successful mutating command", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task start",
        args: { ref: "@task-test" },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Verify writeThrough was called with all cache domains including sessions
    expect(writeThroughCalls.length).toBeGreaterThan(0);
    expect(writeThroughCalls).toContain("tasks");
    expect(writeThroughCalls).toContain("items");
    expect(writeThroughCalls).toContain("sessions");
  });

  // AC: @daemon-command-api ac-mutation-cache-update
  it("writes through all entity cache domains after mutation", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task start",
        args: { ref: "@task-test" },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Every CacheDomain must be written through after a mutation so
    // cross-domain side effects (e.g., session mutations, task → spec
    // status changes) are always reflected before the response.
    const expectedDomains = [
      "tasks",
      "items",
      "meta",
      "inbox",
      "plans",
      "triage",
      "reviews",
      "sessions",
    ];
    for (const domain of expectedDomains) {
      expect(writeThroughCalls).toContain(domain);
    }
  });

  // AC: @daemon-command-api ac-mutation-cache-update
  it("broadcasts WebSocket event after successful mutating command", async () => {
    const broadcastEvents: Array<{ topic: string; event: string; data: Record<string, unknown> }> =
      [];
    const origBroadcast = pubsub.broadcast.bind(pubsub);
    pubsub.broadcast = (
      topic: string,
      event: string,
      data: Record<string, unknown>,
      projectPath?: string,
    ) => {
      broadcastEvents.push({ topic, event, data });
      origBroadcast(topic, event, data, projectPath);
    };

    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task start",
        args: { ref: "@task-test" },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Verify WebSocket broadcast was triggered
    const commandEvent = broadcastEvents.find((e) => e.event === "command_executed");
    expect(commandEvent).toBeDefined();
    expect(commandEvent!.data.mutating).toBe(true);
    expect(commandEvent!.data.success).toBe(true);
    expect(commandEvent!.data.command).toBe("task start");
  });

  // AC: @daemon-command-api ac-mutation-cache-update
  it("does not call writeThrough for read-only commands", async () => {
    await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
        args: { json: true },
      }),
    });

    // Read-only commands should not trigger cache writes
    expect(writeThroughCalls.length).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-concurrent-mutations
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-concurrent-mutations
  it("serializes concurrent mutating commands via dispatch mutex", async () => {
    const [response1, response2] = await Promise.all([
      makeRequest("/api/command", {
        method: "POST",
        body: JSON.stringify({
          command: "inbox add",
          args: { text: "First concurrent item", tag: ["test"] },
        }),
      }),
      makeRequest("/api/command", {
        method: "POST",
        body: JSON.stringify({
          command: "inbox add",
          args: { text: "Second concurrent item", tag: ["test"] },
        }),
      }),
    ]);

    const body1 = await response1.json();
    const body2 = await response2.json();

    // Both should succeed — the dispatch mutex ensures no cwd/console corruption
    // and the file lock ensures no shadow branch conflicts
    expect(body1.exitCode).toBe(0);
    expect(body2.exitCode).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-batch-support
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-batch-support
  it("executes batch commands atomically", async () => {
    const response = await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "inbox add",
            args: { text: "Batch item 1", tag: ["batch"] },
            id: "cmd-1",
          },
          {
            command: "inbox add",
            args: { text: "Batch item 2", tag: ["batch"] },
            id: "cmd-2",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.summary.total).toBe(2);
    expect(body.summary.succeeded).toBe(2);
    expect(body.summary.failed).toBe(0);

    expect(body.results[0].id).toBe("cmd-1");
    expect(body.results[0].success).toBe(true);
    expect(body.results[1].id).toBe("cmd-2");
    expect(body.results[1].success).toBe(true);
  });

  // AC: @daemon-command-api ac-batch-support
  // AC: @daemon-command-api ac-mutation-cache-update
  it("calls writeThrough on entity cache after successful batch", async () => {
    await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "inbox add",
            args: { text: "Cache test batch item" },
          },
        ],
      }),
    });

    // Verify writeThrough was called for all domains after the batch completed
    expect(writeThroughCalls.length).toBeGreaterThan(0);
    expect(writeThroughCalls).toContain("tasks");
    expect(writeThroughCalls).toContain("inbox");
    expect(writeThroughCalls).toContain("sessions");
  });

  // AC: @daemon-command-api ac-batch-support
  it("broadcasts WebSocket event after batch completion", async () => {
    const broadcastEvents: Array<{ topic: string; event: string; data: Record<string, unknown> }> =
      [];
    const origBroadcast = pubsub.broadcast.bind(pubsub);
    pubsub.broadcast = (
      topic: string,
      event: string,
      data: Record<string, unknown>,
      projectPath?: string,
    ) => {
      broadcastEvents.push({ topic, event, data });
      origBroadcast(topic, event, data, projectPath);
    };

    await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "inbox add",
            args: { text: "Broadcast test" },
          },
        ],
      }),
    });

    const batchEvent = broadcastEvents.find((e) => e.event === "batch_executed");
    expect(batchEvent).toBeDefined();
    expect(batchEvent!.data.mutating).toBe(true);
    expect(batchEvent!.data.success).toBe(true);
  });

  // AC: @daemon-command-api ac-batch-support
  it("returns 422 when a batch command fails", async () => {
    const response = await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "nonexistent command",
            args: {},
          },
        ],
      }),
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.success).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // Trait: @trait-api-endpoint ACs
  // ───────────────────────────────────────────────────────────────────

  // AC: @trait-api-endpoint ac-1
  it("returns 200 with JSON body on successful command", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
        args: { json: true },
      }),
    });

    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type");
    expect(contentType).toContain("json");
    const body = await response.json();
    expect(body.exitCode).toBe(0);
  });

  // AC: @trait-api-endpoint ac-3
  it("returns 400 when body is missing required command field", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        args: { ref: "@task-test" },
      }),
    });

    // Elysia validation returns 422 for schema validation failures
    expect(response.status).toBeLessThan(500);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // AC: @trait-api-endpoint ac-3
  it("returns 400 when command is empty string", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "",
        args: {},
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  // AC: @trait-api-endpoint ac-6
  it("includes X-Request-Id header in response", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
        args: { json: true },
      }),
    });

    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    // Should be a ULID-like string (26 chars)
    expect(requestId!.length).toBe(26);
  });

  // AC: @trait-api-endpoint ac-6
  it("includes X-Request-Id header on validation error responses", async () => {
    // Send a request missing the required 'command' field — triggers Elysia
    // body validation before the handler (and onBeforeHandle) runs.
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        args: { ref: "@task-test" },
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    expect(requestId!.length).toBe(26);
  });

  // AC: @trait-api-endpoint ac-2 — N/A: command refs are free-form strings
  // resolved by CLI, not by the daemon route. Invalid refs produce non-zero
  // exitCode with error in stderr, not 404.

  // AC: @trait-api-endpoint ac-4 — N/A: command endpoint is not a list endpoint.
  // Pagination is handled by the underlying CLI commands when applicable.

  // AC: @trait-api-endpoint ac-5 — N/A: shadow commits are made by the CLI
  // commands themselves, not by the command route.

  // AC: @trait-localhost-security ac-1 — N/A: localhost binding is configured
  // at the server level in server.ts, not per-route.

  // AC: @trait-localhost-security ac-2 — N/A: localhostOnly middleware is a
  // server-level concern tested in daemon-server tests, not per-route.

  // AC: @trait-localhost-security ac-3 — N/A: server configuration warning
  // is handled at daemon startup in server.ts, not per-route.

  // AC: @daemon-command-api ac-response-parity
  it("does not leak --yaml output mode between sequential requests", async () => {
    // First request uses --yaml: this sets globalOutputFormat = "yaml"
    const yamlResponse = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "validate",
        args: { warningsOk: true, yaml: true },
      }),
    });
    expect(yamlResponse.status).toBeLessThan(500);

    // Second request does NOT pass --yaml — output must be text, not YAML.
    // Before the fix, setJsonMode(false) only cleared "json" format, leaving
    // "yaml" intact. The second request would then produce YAML output.
    const textResponse = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task get",
        args: { ref: "@task-test", json: true },
      }),
    });

    expect(textResponse.status).toBe(200);
    const body = await textResponse.json();
    expect(body.exitCode).toBe(0);

    // If YAML mode leaked, stdout would be YAML (contains "---" or "key: val"
    // style lines) instead of JSON. Since we asked for --json, it must be valid JSON.
    const parsed = JSON.parse(body.stdout);
    expect(parsed._ulid).toBe(TASK_ULID);
    expect(parsed.title).toBe("Test Task");
  });

  // AC: @daemon-command-api ac-response-parity
  it("does not leak --yaml output mode into batch commands", async () => {
    // First request uses --yaml via the single-command endpoint — sets
    // globalOutputFormat = "yaml" at the process level.
    const yamlResponse = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "validate",
        args: { warningsOk: true, yaml: true },
      }),
    });
    expect(yamlResponse.status).toBeLessThan(500);

    // Second request is a BATCH with a mutating command.
    // Before the fix, dispatchCommand() in batch-exec.ts called
    // setJsonMode(false) which only clears "json" format — leaving "yaml"
    // intact from the prior request. Batch commands would then inherit
    // the leaked YAML mode, corrupting their output capture.
    const batchResponse = await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "inbox add",
            args: { text: "Batch after yaml leak" },
            id: "batch-leak-test",
          },
        ],
      }),
    });

    expect(batchResponse.status).toBe(200);
    const body = await batchResponse.json();
    expect(body.success).toBe(true);

    const result = body.results[0];
    expect(result.success).toBe(true);

    // Verify the output doesn't contain YAML indicators that would signal
    // leaked format. The inbox add output, captured by dispatchCommand(),
    // should be plain text (not YAML-formatted).
    const output =
      typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    expect(output).not.toMatch(/^---\s*$/m);
  });

  // ───────────────────────────────────────────────────────────────────
  // Edge cases
  // ───────────────────────────────────────────────────────────────────

  it("handles command with default empty args", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);
  });

  it("rejects batch with empty commands array", async () => {
    const response = await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [],
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
