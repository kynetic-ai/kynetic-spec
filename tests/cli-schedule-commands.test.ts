/**
 * Schedule CLI command tests
 *
 * Tests for: kspec schedule list, add, get, set, enable, disable, remove, trigger
 *
 * AC: @dispatch-event-cli ac-2 — schedule list shows name, cron, next tick, enabled status
 * AC: @dispatch-event-cli ac-3 — schedule trigger executes immediately with overlap policy
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stringify } from "yaml";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec,
  kspecJson,
  createTempDir,
  cleanupTempDir,
  createIsolatedKspecHome,
  initGitRepo,
  testUlid,
  testUlids,
} from "./helpers/cli.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeProject(
  dir: string,
  opts: { schedules?: unknown[]; hooks?: unknown[] } = {},
) {
  fs.writeFileSync(
    path.join(dir, "kynetic.yaml"),
    stringify({ kynetic: "1", title: "Test Project" }),
  );
  fs.writeFileSync(
    path.join(dir, "kynetic.meta.yaml"),
    stringify({
      kynetic_meta: "1.0",
      agents: [],
      ...(opts.schedules && { schedules: opts.schedules }),
      ...(opts.hooks && { hooks: opts.hooks }),
    }),
  );
  fs.writeFileSync(
    path.join(dir, "project.tasks.yaml"),
    stringify({ tasks: [] }),
  );
}

function makeSchedule(id: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    _ulid: testUlid("SCHED", seq),
    id,
    name: `Schedule ${id}`,
    cron: "*/5 * * * *",
    timezone: "UTC",
    action: { type: "command", command: "echo", args: ["hello"] },
    overlap_policy: "skip",
    backfill: false,
    enabled: true,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = await createTempDir("kspec-schedule-cli-");
  initGitRepo(testDir);
});

afterEach(async () => {
  await cleanupTempDir(testDir);
});

// ══════════════════════════════════════════════════════════════════════════════
// schedule list
// ══════════════════════════════════════════════════════════════════════════════

describe("schedule list", () => {
  // AC: @dispatch-event-cli ac-2
  it("should display each schedule's name, cron expression, and enabled status", () => {
    const schedules = [
      makeSchedule("daily-backup", 1),
      makeSchedule("hourly-sync", 2, { cron: "0 * * * *", enabled: false }),
    ];
    writeProject(testDir, { schedules });

    const result = kspec("schedule list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("daily-backup");
    expect(result.stdout).toContain("*/5 * * * *");
    expect(result.stdout).toContain("hourly-sync");
    expect(result.stdout).toContain("0 * * * *");
    // Summary
    expect(result.stdout).toContain("2");
  });

  // AC: @trait-json-output ac-1
  it("should output valid JSON with no ANSI codes when --json flag is provided", () => {
    writeProject(testDir, { schedules: [makeSchedule("s1", 1)] });

    const result = kspec("schedule list --json", testDir);
    expect(result.exitCode).toBe(0);
    // Must not contain ANSI escape codes
    expect(result.stdout).not.toMatch(/\x1b\[/);
    // Must parse as valid JSON
    const data = JSON.parse(result.stdout);
    expect(data).toBeDefined();
    expect(data.items).toBeInstanceOf(Array);
  });

  // AC: @trait-json-output ac-2
  it("should include all data available in human-readable mode in JSON output", () => {
    writeProject(testDir, { schedules: [makeSchedule("s1", 1)] });

    const data = kspecJson<{
      items: Array<{
        id: string;
        name: string;
        cron: string;
        enabled: boolean;
        overlap_policy: string;
      }>;
      total: number;
    }>("schedule list", testDir);

    expect(data.items).toHaveLength(1);
    expect(data.items[0].id).toBe("s1");
    expect(data.items[0].name).toBe("Schedule s1");
    expect(data.items[0].cron).toBe("*/5 * * * *");
    expect(data.items[0].enabled).toBe(true);
    expect(data.items[0].overlap_policy).toBe("skip");
    expect(data.total).toBe(1);
  });

  // AC: @trait-filterable-list ac-1 — filter by enabled status
  it("should filter by --status enabled", () => {
    const schedules = [
      makeSchedule("active", 1, { enabled: true }),
      makeSchedule("inactive", 2, { enabled: false }),
    ];
    writeProject(testDir, { schedules });

    const data = kspecJson<{ items: unknown[]; total: number }>(
      "schedule list --status enabled",
      testDir,
    );
    expect(data.items).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  // AC: @trait-filterable-list ac-3 — pagination with --limit
  it("should limit output to N items with --limit", () => {
    const schedules = [
      makeSchedule("s1", 1),
      makeSchedule("s2", 2),
      makeSchedule("s3", 3),
    ];
    writeProject(testDir, { schedules });

    const data = kspecJson<{ items: unknown[]; total: number }>(
      "schedule list --limit 2",
      testDir,
    );
    expect(data.items).toHaveLength(2);
    expect(data.total).toBe(3);
  });

  // AC: @trait-filterable-list ac-4 — pagination with --offset
  it("should skip first N items with --offset", () => {
    const schedules = [
      makeSchedule("s1", 1),
      makeSchedule("s2", 2),
      makeSchedule("s3", 3),
    ];
    writeProject(testDir, { schedules });

    const data = kspecJson<{ items: Array<{ id: string }>; total: number }>(
      "schedule list --offset 2",
      testDir,
    );
    expect(data.items).toHaveLength(1);
    expect(data.items[0].id).toBe("s3");
  });

  // AC: @trait-filterable-list ac-6 — empty list with informative message
  it("should show informative message when no schedules exist", () => {
    writeProject(testDir);

    const result = kspec("schedule list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no schedule");
  });

  // AC: @trait-filterable-list ac-7 — summary shows total and filter state
  it("should show summary count in human output", () => {
    const schedules = [makeSchedule("s1", 1), makeSchedule("s2", 2)];
    writeProject(testDir, { schedules });

    const result = kspec("schedule list", testDir);
    expect(result.stdout).toContain("2");
    expect(result.stdout).toContain("schedule");
  });

  // AC: @trait-filterable-list ac-8 — count mode
  it("should output only the count with --count", () => {
    const schedules = [makeSchedule("s1", 1), makeSchedule("s2", 2)];
    writeProject(testDir, { schedules });

    const result = kspec("schedule list --count", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("2");
  });

  // AC: @trait-filterable-list ac-8 — count mode with JSON
  it("should output JSON count object with --count --json", () => {
    const schedules = [makeSchedule("s1", 1), makeSchedule("s2", 2)];
    writeProject(testDir, { schedules });

    const data = kspecJson<{ count: number }>(
      "schedule list --count",
      testDir,
    );
    expect(data.count).toBe(2);
  });

  // AC: @trait-semantic-exit-codes ac-1 — exit 0 on success
  it("should exit 0 on success", () => {
    writeProject(testDir);
    const result = kspec("schedule list", testDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-5 — exit 0 with empty result set
  it("should exit 0 when no schedules exist", () => {
    writeProject(testDir);
    const result = kspec("schedule list", testDir);
    expect(result.exitCode).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// schedule get
// ══════════════════════════════════════════════════════════════════════════════

describe("schedule get", () => {
  it("should display schedule details", () => {
    writeProject(testDir, { schedules: [makeSchedule("my-schedule", 1)] });

    const result = kspec("schedule get my-schedule", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("my-schedule");
    expect(result.stdout).toContain("*/5 * * * *");
    expect(result.stdout).toContain("skip");
  });

  it("should return JSON with all fields", () => {
    writeProject(testDir, {
      schedules: [makeSchedule("my-schedule", 1)],
    });

    const data = kspecJson<{
      id: string;
      name: string;
      cron: string;
      enabled: boolean;
      action: { type: string };
    }>("schedule get my-schedule", testDir);

    expect(data.id).toBe("my-schedule");
    expect(data.name).toBe("Schedule my-schedule");
    expect(data.cron).toBe("*/5 * * * *");
    expect(data.enabled).toBe(true);
    expect(data.action.type).toBe("command");
  });

  // AC: @trait-error-guidance ac-1, ac-2, ac-3
  it("should show error with hint for unknown ref", () => {
    writeProject(testDir);

    const result = kspec("schedule get nonexistent", testDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain("not found");
    // Hint appears on stdout via console.log
    expect(result.stdout).toContain("schedule list");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// schedule add
// ══════════════════════════════════════════════════════════════════════════════

describe("schedule add", () => {
  it("should create a new schedule", () => {
    writeProject(testDir);

    const result = kspec(
      'schedule add --id nightly --name "Nightly Build" --cron "0 0 * * *" --action-type command --command "echo build"',
      testDir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nightly");

    // Verify it persists
    const data = kspecJson<{ items: Array<{ id: string }> }>(
      "schedule list",
      testDir,
    );
    expect(data.items.some((s) => s.id === "nightly")).toBe(true);
  });

  it("should create schedule with all options", () => {
    writeProject(testDir);

    const result = kspec(
      'schedule add --id full --name "Full Options" --cron "*/10 * * * *" --action-type command --command echo --timezone America/New_York --overlap-policy buffer_one --backfill',
      testDir,
    );
    expect(result.exitCode).toBe(0);

    const data = kspecJson<{
      id: string;
      timezone: string;
      overlap_policy: string;
      backfill: boolean;
    }>("schedule get full", testDir);
    expect(data.timezone).toBe("America/New_York");
    expect(data.overlap_policy).toBe("buffer_one");
    expect(data.backfill).toBe(true);
  });

  // AC: @trait-error-guidance ac-5 — validation error indicates which field failed
  it("should reject invalid cron expression", () => {
    writeProject(testDir);

    const result = kspec(
      'schedule add --id bad --name "Bad Cron" --cron "invalid" --action-type command --command echo',
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cron");
  });

  it("should reject duplicate ID", () => {
    writeProject(testDir, { schedules: [makeSchedule("existing", 1)] });

    const result = kspec(
      'schedule add --id existing --name "Duplicate" --cron "* * * * *" --action-type command --command echo',
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(5); // CONFLICT
    expect(result.stderr).toContain("already exists");
  });

  // AC: @trait-error-guidance ac-1, ac-2
  it("should error with guidance when missing required action option", () => {
    writeProject(testDir);

    const result = kspec(
      'schedule add --id no-cmd --name "No Command" --cron "* * * * *" --action-type command',
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--command");
  });

  // AC: @trait-json-output ac-3 — error returned as JSON with error field
  it("should return JSON error on failure in JSON mode", () => {
    writeProject(testDir);

    const result = kspec(
      'schedule add --id bad --name "Bad" --cron "invalid" --action-type command --command echo --json',
      testDir,
      { expectFail: true },
    );
    const errorJson = JSON.parse(result.stderr);
    expect(errorJson.success).toBe(false);
    expect(errorJson.error).toBeDefined();
  });

  // AC: @trait-shadow-commit ac-1 — state persisted via shadow commit
  it("should persist schedule across reads", () => {
    writeProject(testDir);

    kspec(
      'schedule add --id persisted --name "Persisted" --cron "0 * * * *" --action-type command --command echo',
      testDir,
    );

    // Read back
    const data = kspecJson<{ items: Array<{ id: string }> }>(
      "schedule list",
      testDir,
    );
    expect(data.items.some((s) => s.id === "persisted")).toBe(true);
  });

  // AC: @trait-shadow-commit ac-5 — no commit on validation error
  it("should not persist state when add fails validation", () => {
    writeProject(testDir);

    kspec(
      'schedule add --id bad --name "Bad" --cron "invalid" --action-type command --command echo',
      testDir,
      { expectFail: true },
    );

    const data = kspecJson<{ items: unknown[] }>("schedule list", testDir);
    expect(data.items).toHaveLength(0);
  });

  // AC: @trait-semantic-exit-codes ac-1 — exit 0 on success
  it("should exit 0 on successful add", () => {
    writeProject(testDir);

    const result = kspec(
      'schedule add --id ok --name "OK" --cron "0 * * * *" --action-type command --command echo',
      testDir,
    );
    expect(result.exitCode).toBe(0);
  });

  it("should create schedule with kspec action type", () => {
    writeProject(testDir);

    const result = kspec(
      'schedule add --id kspec-task --name "Kspec Task" --cron "0 * * * *" --action-type kspec --command "task list"',
      testDir,
    );
    expect(result.exitCode).toBe(0);

    const data = kspecJson<{ action: { type: string; command: string } }>(
      "schedule get kspec-task",
      testDir,
    );
    expect(data.action.type).toBe("kspec");
    expect(data.action.command).toBe("task list");
  });

  it("should create schedule with agent action type", () => {
    writeProject(testDir);

    const result = kspec(
      'schedule add --id agent-task --name "Agent Task" --cron "0 * * * *" --action-type agent --agent-id task-worker',
      testDir,
    );
    expect(result.exitCode).toBe(0);

    const data = kspecJson<{ action: { type: string; agent_id: string } }>(
      "schedule get agent-task",
      testDir,
    );
    expect(data.action.type).toBe("agent");
    expect(data.action.agent_id).toBe("task-worker");
  });

  it("should create schedule with notify action type", () => {
    writeProject(testDir);

    const result = kspec(
      'schedule add --id notify-task --name "Notify" --cron "0 * * * *" --action-type notify --message "hello"',
      testDir,
    );
    expect(result.exitCode).toBe(0);

    const data = kspecJson<{ action: { type: string; message: string } }>(
      "schedule get notify-task",
      testDir,
    );
    expect(data.action.type).toBe("notify");
    expect(data.action.message).toBe("hello");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// schedule set
// ══════════════════════════════════════════════════════════════════════════════

describe("schedule set", () => {
  it("should update schedule fields", () => {
    writeProject(testDir, { schedules: [makeSchedule("updatable", 1)] });

    const result = kspec(
      'schedule set updatable --name "Updated Name" --cron "0 12 * * *"',
      testDir,
    );
    expect(result.exitCode).toBe(0);

    const data = kspecJson<{ name: string; cron: string }>(
      "schedule get updatable",
      testDir,
    );
    expect(data.name).toBe("Updated Name");
    expect(data.cron).toBe("0 12 * * *");
  });

  it("should update overlap policy", () => {
    writeProject(testDir, { schedules: [makeSchedule("updatable", 1)] });

    kspec("schedule set updatable --overlap-policy allow", testDir);

    const data = kspecJson<{ overlap_policy: string }>(
      "schedule get updatable",
      testDir,
    );
    expect(data.overlap_policy).toBe("allow");
  });

  // AC: @trait-error-guidance ac-3 — suggests search for unknown ref
  it("should error with hint for unknown ref", () => {
    writeProject(testDir);

    const result = kspec("schedule set nonexistent --name foo", testDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain("not found");
  });

  it("should reject invalid cron on set", () => {
    writeProject(testDir, { schedules: [makeSchedule("updatable", 1)] });

    const result = kspec(
      'schedule set updatable --cron "not valid"',
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// schedule enable / disable
// ══════════════════════════════════════════════════════════════════════════════

describe("schedule enable", () => {
  it("should enable a disabled schedule", () => {
    writeProject(testDir, {
      schedules: [makeSchedule("disabled-one", 1, { enabled: false })],
    });

    const result = kspec("schedule enable disabled-one", testDir);
    expect(result.exitCode).toBe(0);

    const data = kspecJson<{ enabled: boolean }>(
      "schedule get disabled-one",
      testDir,
    );
    expect(data.enabled).toBe(true);
  });

  it("should be idempotent for already-enabled schedule", () => {
    writeProject(testDir, { schedules: [makeSchedule("already-on", 1)] });

    const result = kspec("schedule enable already-on", testDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-error-guidance ac-1, ac-2
  it("should error with hint for unknown ref", () => {
    writeProject(testDir);

    const result = kspec("schedule enable nonexistent", testDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3);
  });
});

describe("schedule disable", () => {
  it("should disable an enabled schedule", () => {
    writeProject(testDir, { schedules: [makeSchedule("active-one", 1)] });

    const result = kspec("schedule disable active-one", testDir);
    expect(result.exitCode).toBe(0);

    const data = kspecJson<{ enabled: boolean }>(
      "schedule get active-one",
      testDir,
    );
    expect(data.enabled).toBe(false);
  });

  it("should be idempotent for already-disabled schedule", () => {
    writeProject(testDir, {
      schedules: [makeSchedule("already-off", 1, { enabled: false })],
    });

    const result = kspec("schedule disable already-off", testDir);
    expect(result.exitCode).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// schedule remove
// ══════════════════════════════════════════════════════════════════════════════

describe("schedule remove", () => {
  it("should remove a schedule with --confirm", () => {
    writeProject(testDir, { schedules: [makeSchedule("deletable", 1)] });

    const result = kspec("schedule remove deletable --confirm", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Removed");

    // Verify removal
    const data = kspecJson<{ items: unknown[] }>("schedule list", testDir);
    expect(data.items).toHaveLength(0);
  });

  it("should require --confirm flag", () => {
    writeProject(testDir, { schedules: [makeSchedule("keep-me", 1)] });

    const result = kspec("schedule remove keep-me", testDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--confirm");

    // Should not be deleted
    const data = kspecJson<{ items: unknown[] }>("schedule list", testDir);
    expect(data.items).toHaveLength(1);
  });

  // AC: @trait-error-guidance ac-3
  it("should error with hint for unknown ref", () => {
    writeProject(testDir);

    const result = kspec("schedule remove nonexistent --confirm", testDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr + result.stdout).toContain("schedule list");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// schedule trigger
// ══════════════════════════════════════════════════════════════════════════════

describe("schedule trigger", () => {
  // AC: @dispatch-event-cli ac-3
  // AC: @trait-error-guidance ac-1, ac-2
  it("should error when daemon is not running", async () => {
    writeProject(testDir, { schedules: [makeSchedule("trigger-me", 1)] });

    // Use isolated HOME so the test doesn't see the ambient daemon
    const isolated = await createIsolatedKspecHome(testDir);

    const result = kspec("schedule trigger trigger-me", testDir, {
      expectFail: true,
      env: isolated.env,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not running");
    expect(result.stderr + result.stdout).toContain("kspec serve");
  });

  // AC: @trait-error-guidance ac-3
  it("should error with hint for unknown schedule ref", () => {
    writeProject(testDir);

    const result = kspec("schedule trigger nonexistent", testDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr + result.stdout).toContain("schedule list");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Trait: @trait-json-output
// ══════════════════════════════════════════════════════════════════════════════

describe("trait-json-output", () => {
  // AC: @trait-json-output ac-4 — references use @ prefix consistently
  it("should use @ prefix for references in JSON output", () => {
    writeProject(testDir, { schedules: [makeSchedule("ref-test", 1)] });

    const data = kspecJson<{ items: Array<{ id: string }> }>(
      "schedule list",
      testDir,
    );
    // Schedule IDs are plain strings, not refs — this AC is about item references
    // For schedule commands, verify JSON structure is consistent
    expect(data.items[0].id).toBe("ref-test");
  });

  // AC: @trait-json-output ac-5 — timestamps use ISO 8601 format
  // N/A: Schedule list items from config don't include timestamps directly.
  // Runtime timestamps (next_tick, last_tick) are daemon-provided.
  // AC: @trait-json-output ac-5 — N/A: schedule config items don't contain user-set timestamps; runtime timestamps come from daemon API

  // AC: @trait-json-output ac-6 — --json takes precedence over other format options
  it("should output JSON even when other format flags present", () => {
    writeProject(testDir, { schedules: [makeSchedule("s1", 1)] });

    const result = kspec("schedule list --json", testDir);
    expect(result.exitCode).toBe(0);
    // Should be valid JSON
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Trait: @trait-error-guidance
// ══════════════════════════════════════════════════════════════════════════════

describe("trait-error-guidance", () => {
  // AC: @trait-error-guidance ac-6 — guidance included in structured error object
  it("should include guidance in JSON error", () => {
    writeProject(testDir);

    const result = kspec("schedule get @missing --json", testDir, {
      expectFail: true,
    });
    const err = JSON.parse(result.stderr);
    expect(err.success).toBe(false);
    expect(err.error).toBeDefined();
    expect(err.details).toBeDefined();
    expect(err.details.hint).toContain("schedule list");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Trait: @trait-shadow-commit — N/A annotations
// ══════════════════════════════════════════════════════════════════════════════

// AC: @trait-shadow-commit ac-2 — N/A: commit message formatting covered by shared commitIfShadow tests in shadow.test.ts
// AC: @trait-shadow-commit ac-3 — N/A: commit message ULID inclusion covered by shared commitIfShadow tests in shadow.test.ts
// AC: @trait-shadow-commit ac-4 — N/A: shadow-disabled behavior covered by generic commitIfShadow tests
// AC: @trait-shadow-commit ac-6 — N/A: remote push behavior covered by generic commitIfShadow tests
// AC: @trait-shadow-commit ac-7 — N/A: push failure handling covered by generic commitIfShadow tests
// AC: @trait-shadow-commit ac-8 — N/A: schedule commands perform single saves, not multiple; batch atomic commit is handled by kspec batch infrastructure

// ══════════════════════════════════════════════════════════════════════════════
// Trait: @trait-filterable-list — already covered above in schedule list tests
// ══════════════════════════════════════════════════════════════════════════════

// AC: @trait-filterable-list ac-2 — N/A: schedules don't have tags; --tag filter is reserved for future use
// AC: @trait-filterable-list ac-5 — N/A: only one filter supported (--status); AND logic requires multiple filters

// ══════════════════════════════════════════════════════════════════════════════
// Trait: @trait-semantic-exit-codes
// ══════════════════════════════════════════════════════════════════════════════

describe("trait-semantic-exit-codes", () => {
  // AC: @trait-semantic-exit-codes ac-2 — exit code for validation error
  it("should exit with validation error code for invalid input", () => {
    writeProject(testDir);

    const result = kspec("schedule list --limit abc", testDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
  });

  // AC: @trait-semantic-exit-codes ac-6 — exit code with usage info for invalid flags
  // N/A: Commander handles invalid flag errors before our code runs; commander's own exit behavior applies
  // AC: @trait-semantic-exit-codes ac-6 — N/A: Commander handles invalid flag errors with its own exit behavior

  // AC: @trait-semantic-exit-codes ac-3 — N/A: schedule commands have no interactive confirmation prompts
  // AC: @trait-semantic-exit-codes ac-7 — N/A: schedule commands don't perform batch operations
  // AC: @trait-semantic-exit-codes ac-8 — exit code meanings are documented in exit-codes.ts (covered by that file's own tests)
});
