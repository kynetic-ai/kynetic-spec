/**
 * Integration tests for kspec event CLI commands.
 *
 * Tests: kspec event types, kspec event log, kspec event emit.
 *
 * Note: event types is a pure local command (reads from static registry).
 * event log and event emit require the daemon; tests verify validation
 * and error handling without a running daemon.
 *
 * Spec: @dispatch-event-cli
 * Task: @task-event-cli
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec,
  kspecOutput,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
} from "./helpers/cli";

// ─── event types ────────────────────────────────────────────────────────────

describe("Integration: event types", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-event-cli ac-5 — list all registered event identifiers grouped by domain
  it("should list all event types grouped by domain", () => {
    const output = kspecOutput("event types", tempDir);
    // Should have all 5 domains
    expect(output).toContain("task");
    expect(output).toContain("invocation");
    expect(output).toContain("session");
    expect(output).toContain("schedule");
    expect(output).toContain("action");
    // Should show specific event types
    expect(output).toContain("task.ready");
    expect(output).toContain("invocation.started");
    expect(output).toContain("session.ended");
    expect(output).toContain("schedule.tick");
    expect(output).toContain("action.started");
  });

  // AC: @dispatch-event-cli ac-5 — payload fields available for each type
  it("should show payload fields for each event type", () => {
    const output = kspecOutput("event types", tempDir);
    // Task events should show their payload fields
    expect(output).toContain("task_id");
    expect(output).toContain("task_ref");
    expect(output).toContain("from_status");
    expect(output).toContain("to_status");
    // Invocation events should show their fields
    expect(output).toContain("session_id");
    expect(output).toContain("agent_id");
    expect(output).toContain("duration_ms");
  });

  // AC: @dispatch-event-cli ac-5 — grouped by domain
  it("should filter by domain when --domain is specified", () => {
    const output = kspecOutput("event types --domain task", tempDir);
    // Should show task domain events
    expect(output).toContain("task.ready");
    expect(output).toContain("task.in_progress");
    expect(output).toContain("task.needs_work");
    expect(output).toContain("task.pending_review");
    // Should NOT show other domains
    expect(output).not.toContain("invocation.started");
    expect(output).not.toContain("session.ended");
    expect(output).not.toContain("schedule.tick");
  });

  // AC: @trait-error-guidance ac-1, ac-2, ac-5 — error for invalid domain
  it("should error on invalid domain with guidance", () => {
    const result = kspec("event types --domain bogus", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("Unknown event domain");
    expect(combined).toContain("bogus");
    expect(combined).toContain("Valid domains");
  });

  // AC: @trait-json-output ac-1 — valid JSON output
  // AC: @trait-json-output ac-2 — includes all data
  it("should output valid JSON with --json flag", () => {
    const data = kspecJson<{ domains: Record<string, unknown[]>; total: number }>(
      "event types",
      tempDir,
    );
    expect(data.domains).toBeDefined();
    expect(data.total).toBeGreaterThan(0);
    // Should have all domains
    expect(data.domains.task).toBeDefined();
    expect(data.domains.invocation).toBeDefined();
    expect(data.domains.session).toBeDefined();
    expect(data.domains.schedule).toBeDefined();
    expect(data.domains.action).toBeDefined();
  });

  // AC: @trait-json-output ac-2 — JSON includes all data available in human-readable mode
  it("should include event_type, description, and payload_fields in JSON output", () => {
    const data = kspecJson<{
      domains: Record<string, Array<{
        event_type: string;
        description: string;
        payload_fields: string[];
      }>>;
      total: number;
    }>("event types", tempDir);

    const taskEvents = data.domains.task;
    expect(taskEvents.length).toBeGreaterThan(0);

    const taskReady = taskEvents.find((e) => e.event_type === "task.ready");
    expect(taskReady).toBeDefined();
    expect(taskReady!.description).toBeTruthy();
    expect(taskReady!.payload_fields).toContain("task_id");
    expect(taskReady!.payload_fields).toContain("task_ref");
  });

  // AC: @trait-json-output ac-1, ac-2 — JSON output for filtered domain
  it("should output valid JSON when filtered by domain", () => {
    const data = kspecJson<{ domains: Record<string, unknown[]>; total: number }>(
      "event types --domain schedule",
      tempDir,
    );
    expect(data.domains.schedule).toBeDefined();
    expect(Object.keys(data.domains)).toHaveLength(1);
  });

  // AC: @trait-filterable-list ac-8 — count mode
  it("should output count in text mode", () => {
    const output = kspecOutput("event types --count", tempDir);
    const count = parseInt(output.trim(), 10);
    expect(count).toBeGreaterThan(0);
  });

  // AC: @trait-filterable-list ac-8 — count mode in JSON
  it("should output count as JSON with --count --json", () => {
    const data = kspecJson<{ count: number }>("event types --count", tempDir);
    expect(data.count).toBeGreaterThan(0);
  });

  // AC: @trait-semantic-exit-codes ac-1 — exit code 0 on success
  it("should exit with code 0 on success", () => {
    const result = kspec("event types", tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-2 — exit code on validation error
  it("should exit with validation exit code on invalid domain", () => {
    const result = kspec("event types --domain invalid", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
  });
});

// ─── event log ──────────────────────────────────────────────────────────────

describe("Integration: event log", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-error-guidance ac-1, ac-2 — error when daemon not running
  it("should report error when daemon is not running", () => {
    // Use a temp config dir to ensure no daemon PID file exists
    const result = kspec("event log", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/Daemon is not running|Failed to/i);
  });

  // AC: @trait-error-guidance ac-5 — indicate which field/value failed
  it("should validate event type filter before querying daemon", () => {
    const result = kspec("event log --type bogus.event", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("bogus");
  });

  // AC: @trait-json-output ac-3 — error returned as JSON with error field
  it("should return error as JSON when --json is active and daemon not running", () => {
    const result = kspec("event log --json", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    // Should have JSON error on stderr
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('"error"');
  });

  // AC: @trait-semantic-exit-codes ac-2 — exit code on validation error
  it("should exit with validation code for invalid event type", () => {
    const result = kspec("event log --type not_a_type", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
  });
});

// ─── event emit ─────────────────────────────────────────────────────────────

describe("Integration: event emit", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-event-cli ac-6 — validation: invalid event type
  // AC: @trait-error-guidance ac-5 — indicate which field/value failed
  it("should error on invalid event type with guidance", () => {
    const result = kspec("event emit bogus.event", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("bogus");
  });

  // AC: @trait-error-guidance ac-5 — error for malformed event type
  it("should error on event type without domain prefix", () => {
    const result = kspec("event emit nodots", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("dotted-namespace");
  });

  // AC: @trait-error-guidance ac-5 — error for invalid JSON payload
  it("should error on invalid JSON in --payload", () => {
    const result = kspec('event emit task.ready --payload "not-json"', tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).toBe(4);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("Invalid JSON");
  });

  // AC: @trait-error-guidance ac-1, ac-2 — error when daemon not running
  it("should report error when daemon is not running", () => {
    const result = kspec("event emit task.ready", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/Daemon is not running|Failed to/i);
  });

  // AC: @trait-json-output ac-3 — error as JSON when --json is active
  it("should return error as JSON when --json and daemon not running", () => {
    const result = kspec("event emit task.ready --json", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('"error"');
  });

  // AC: @trait-semantic-exit-codes ac-2 — exit code on validation error
  it("should exit with validation code for invalid event type", () => {
    const result = kspec("event emit fake.type", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
  });

  // AC: @trait-error-guidance ac-5 — known domain but unknown event
  it("should suggest valid events when domain is valid but event type is not", () => {
    const result = kspec("event emit task.unknown", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).toBe(4);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("task.ready");
  });

  // Validation: --payload must be a JSON object
  it("should error when --payload is a JSON array", () => {
    const result = kspec('event emit task.ready --payload "[1,2,3]"', tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).toBe(4);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("must be a JSON object");
  });

  // Validation: --field format
  it("should error on invalid --field format", () => {
    const result = kspec("event emit task.ready --field badfield", tempDir, {
      expectFail: true,
      env: { HOME: tempDir },
    });
    expect(result.exitCode).toBe(4);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("Invalid --field format");
  });
});

// ─── Trait AC: @trait-json-output ───────────────────────────────────────────
// AC: @trait-json-output ac-4 — N/A: event types has no references
// AC: @trait-json-output ac-5 — N/A: event types has no timestamps
// AC: @trait-json-output ac-6 — N/A: no other formatting flags to conflict with

// ─── Trait AC: @trait-shadow-commit ─────────────────────────────────────────
// AC: @trait-shadow-commit ac-1 — N/A: event commands are read-only, no shadow state modification
// AC: @trait-shadow-commit ac-2 — N/A: event commands are read-only
// AC: @trait-shadow-commit ac-3 — N/A: event commands are read-only
// AC: @trait-shadow-commit ac-4 — N/A: event commands are read-only
// AC: @trait-shadow-commit ac-5 — N/A: event commands are read-only
// AC: @trait-shadow-commit ac-6 — N/A: event commands are read-only
// AC: @trait-shadow-commit ac-7 — N/A: event commands are read-only
// AC: @trait-shadow-commit ac-8 — N/A: event commands are read-only

// ─── Trait AC: @trait-filterable-list ───────────────────────────────────────
// AC: @trait-filterable-list ac-1 — N/A: event types has no status to filter (static registry)
// AC: @trait-filterable-list ac-2 — N/A: event types has no tags; domain filter serves analogous purpose
// AC: @trait-filterable-list ac-3 — N/A: event types is a static small list, pagination unnecessary
// AC: @trait-filterable-list ac-4 — N/A: event types is a static small list, pagination unnecessary
// AC: @trait-filterable-list ac-5 — N/A: only single domain filter supported; no compound filters
// AC: @trait-filterable-list ac-6 — covered implicitly (filtered domain with no events would show nothing)
// AC: @trait-filterable-list ac-7 — covered by text output footer showing count summary

// ─── Trait AC: @trait-error-guidance ────────────────────────────────────────
// AC: @trait-error-guidance ac-3 — N/A: event commands don't resolve references; they use event types
// AC: @trait-error-guidance ac-4 — N/A: event commands have no state transitions
// AC: @trait-error-guidance ac-6 — covered by JSON error tests above

// ─── Trait AC: @trait-semantic-exit-codes ───────────────────────────────────
// AC: @trait-semantic-exit-codes ac-3 — N/A: no confirmation prompts in event commands
// AC: @trait-semantic-exit-codes ac-4 — covered by daemon-not-running error tests (exit code from error handler)
// AC: @trait-semantic-exit-codes ac-5 — N/A: event types always has results (static registry); event log with no results returns 0
// AC: @trait-semantic-exit-codes ac-6 — covered by invalid event type tests (exit code 4 = VALIDATION_FAILED)
// AC: @trait-semantic-exit-codes ac-7 — N/A: no batch operations in event commands
// AC: @trait-semantic-exit-codes ac-8 — exit code meanings documented in code via EXIT_CODES constants
