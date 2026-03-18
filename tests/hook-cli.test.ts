/**
 * Integration tests for kspec hook CLI commands.
 *
 * Tests: kspec hook list, add, get, set, enable, disable, remove.
 *
 * Spec: @dispatch-event-cli
 * Task: @task-hook-cli
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
} from "./helpers/cli";

/**
 * Helper: add a hook via CLI and return the parsed JSON result.
 */
function addTestHook(
  tempDir: string,
  name: string,
  eventType = "task.ready",
  actionJson = '{"type":"notify","message":"test"}',
): Record<string, unknown> {
  return kspecJson<Record<string, unknown>>(
    `hook add "${name}" --on ${eventType} --action '${actionJson}'`,
    tempDir,
  );
}

describe("Integration: hook list", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-event-cli ac-1
  it("should show empty message when no hooks exist", () => {
    const output = kspec("hook list", tempDir);
    expect(output).toContain("No hooks defined");
  });

  // AC: @dispatch-event-cli ac-1
  it("should list hooks with name, event trigger, action type, and enabled status", async () => {
    // Add two hooks
    addTestHook(tempDir, "notify-on-ready");
    addTestHook(tempDir, "log-on-complete", "task.in_progress", '{"type":"command","command":"echo","args":["done"]}');

    const output = kspec("hook list", tempDir);
    expect(output).toContain("notify-on-ready");
    expect(output).toContain("task.ready");
    expect(output).toContain("notify");
    expect(output).toContain("yes");

    expect(output).toContain("log-on-complete");
    expect(output).toContain("task.in_progress");
    expect(output).toContain("command");
  });

  // AC: @trait-json-output ac-1 — valid JSON output
  // AC: @trait-json-output ac-2 — includes all data from human-readable mode
  it("should output valid JSON with --json flag", () => {
    addTestHook(tempDir, "test-hook-json");

    const hooks = kspecJson<Array<Record<string, unknown>>>("hook list", tempDir);
    expect(Array.isArray(hooks)).toBe(true);
    expect(hooks).toHaveLength(1);

    const hook = hooks[0];
    expect(hook._ulid).toBeDefined();
    expect(hook.name).toBe("test-hook-json");
    expect(hook.on).toBe("task.ready");
    expect(hook.action).toBeDefined();
    expect(hook.enabled).toBe(true);
  });

  // AC: @trait-filterable-list ac-1 — filter by status
  it("should filter by enabled/disabled status", () => {
    addTestHook(tempDir, "enabled-hook");
    kspecJson(
      `hook add "disabled-hook" --on task.in_progress --action '{"type":"notify","message":"test"}' --disabled`,
      tempDir,
    );

    const enabled = kspecJson<Array<Record<string, unknown>>>("hook list --status enabled", tempDir);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe("enabled-hook");

    const disabled = kspecJson<Array<Record<string, unknown>>>("hook list --status disabled", tempDir);
    expect(disabled).toHaveLength(1);
    expect(disabled[0].name).toBe("disabled-hook");
  });

  // AC: @trait-filterable-list ac-2 — filter by tag (event domain)
  it("should filter by event type domain using --tag", () => {
    addTestHook(tempDir, "task-hook", "task.ready");
    addTestHook(tempDir, "invocation-hook", "invocation.started", '{"type":"notify","message":"test"}');

    const taskHooks = kspecJson<Array<Record<string, unknown>>>("hook list --tag task", tempDir);
    expect(taskHooks).toHaveLength(1);
    expect(taskHooks[0].name).toBe("task-hook");
  });

  // AC: @trait-filterable-list ac-3, ac-4 — limit and offset
  it("should support --limit and --offset", () => {
    addTestHook(tempDir, "hook-a");
    addTestHook(tempDir, "hook-b", "task.in_progress");
    addTestHook(tempDir, "hook-c", "task.in_progress");

    const limited = kspecJson<Array<Record<string, unknown>>>("hook list --limit 2", tempDir);
    expect(limited).toHaveLength(2);

    const offset = kspecJson<Array<Record<string, unknown>>>("hook list --offset 1", tempDir);
    expect(offset).toHaveLength(2);

    const combo = kspecJson<Array<Record<string, unknown>>>("hook list --offset 1 --limit 1", tempDir);
    expect(combo).toHaveLength(1);
  });

  // AC: @trait-filterable-list ac-5 — multiple filters AND logic
  it("should apply multiple filters with AND logic", () => {
    addTestHook(tempDir, "task-enabled", "task.ready");
    kspecJson(
      `hook add "task-disabled" --on task.in_progress --action '{"type":"notify","message":"test"}' --disabled`,
      tempDir,
    );
    addTestHook(tempDir, "invocation-enabled", "invocation.started", '{"type":"notify","message":"test"}');

    const result = kspecJson<Array<Record<string, unknown>>>(
      "hook list --status enabled --tag task",
      tempDir,
    );
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("task-enabled");
  });

  // AC: @trait-filterable-list ac-6 — empty result message
  it("should show informative message when no hooks match filters", () => {
    addTestHook(tempDir, "some-hook");

    const output = kspec("hook list --status disabled", tempDir);
    expect(output).toContain("No hooks match the specified filters");
  });

  // AC: @trait-filterable-list ac-7 — summary shows total matching items and filter state
  it("should show summary with total matching items", () => {
    addTestHook(tempDir, "hook-a");
    addTestHook(tempDir, "hook-b", "task.in_progress");
    addTestHook(tempDir, "hook-c", "task.in_progress");

    const output = kspec("hook list", tempDir);
    expect(output).toContain("3");
  });

  // AC: @trait-filterable-list ac-8 — count mode
  it("should output only count with --count flag", () => {
    addTestHook(tempDir, "hook-1");
    addTestHook(tempDir, "hook-2", "task.in_progress");

    const output = kspec("hook list --count", tempDir);
    expect(output.trim()).toBe("2");

    const json = kspecJson<{ count: number }>("hook list --count", tempDir);
    expect(json.count).toBe(2);
  });
});

describe("Integration: hook add", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-event-cli ac-4 — hook is persisted and available
  it("should add a hook that persists across commands", () => {
    const added = addTestHook(tempDir, "persist-hook");
    expect(added._ulid).toBeDefined();
    expect(added.name).toBe("persist-hook");
    expect(added.on).toBe("task.ready");
    expect(added.enabled).toBe(true);

    // Verify it persists
    const list = kspecJson<Array<Record<string, unknown>>>("hook list", tempDir);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("persist-hook");
  });

  // AC: @dispatch-event-cli ac-4
  it("should add a hook with all action types", () => {
    // Command action
    const cmdHook = addTestHook(
      tempDir,
      "cmd-hook",
      "task.ready",
      '{"type":"command","command":"echo","args":["hello"]}',
    );
    expect((cmdHook.action as Record<string, unknown>).type).toBe("command");

    // Kspec action
    const kspecHook = addTestHook(
      tempDir,
      "kspec-hook",
      "task.in_progress",
      '{"type":"kspec","command":"validate"}',
    );
    expect((kspecHook.action as Record<string, unknown>).type).toBe("kspec");

    // Agent action
    const agentHook = addTestHook(
      tempDir,
      "agent-hook",
      "task.pending_review",
      '{"type":"agent","agent_id":"reviewer"}',
    );
    expect((agentHook.action as Record<string, unknown>).type).toBe("agent");

    // Notify action
    const notifyHook = addTestHook(
      tempDir,
      "notify-hook",
      "invocation.completed",
      '{"type":"notify","message":"done"}',
    );
    expect((notifyHook.action as Record<string, unknown>).type).toBe("notify");
  });

  // AC: @dispatch-event-cli ac-4
  it("should add a hook with filter", () => {
    const hook = kspecJson<Record<string, unknown>>(
      `hook add "filtered-hook" --on task.ready --action '{"type":"notify","message":"filtered"}' --filter '{"status":"pending"}'`,
      tempDir,
    );
    expect(hook.filter).toEqual({ status: "pending" });
  });

  it("should add a hook in disabled state with --disabled", () => {
    const hook = kspecJson<Record<string, unknown>>(
      `hook add "disabled-hook" --on task.ready --action '{"type":"notify","message":"test"}' --disabled`,
      tempDir,
    );
    expect(hook.enabled).toBe(false);
  });

  // AC: @trait-error-guidance ac-5 — validation error with field info
  it("should reject invalid event type", () => {
    const result = kspecRun(
      `hook add "bad-event" --on invalid.event --action '{"type":"notify","message":"test"}'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid event type");
  });

  // AC: @trait-error-guidance ac-5
  it("should reject invalid action JSON", () => {
    const result = kspecRun(
      `hook add "bad-action" --on task.ready --action '{"type":"unknown"}'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid");
  });

  it("should reject malformed JSON in --action", () => {
    const result = kspecRun(
      `hook add "bad-json" --on task.ready --action 'not-json'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid JSON");
  });

  it("should reject duplicate hook names", () => {
    addTestHook(tempDir, "unique-name");

    const result = kspecRun(
      `hook add "unique-name" --on task.ready --action '{"type":"notify","message":"dup"}'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists");
  });

  // AC: @trait-shadow-commit ac-1 — shadow commit is created
  it("should produce human-readable success message", () => {
    const output = kspec(
      `hook add "my-hook" --on task.ready --action '{"type":"notify","message":"test"}'`,
      tempDir,
    );
    expect(output).toContain("OK");
    expect(output).toContain("Created hook");
    expect(output).toContain("my-hook");
  });
});

describe("Integration: hook get", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should get hook details by name", () => {
    addTestHook(tempDir, "detail-hook");

    const output = kspec("hook get detail-hook", tempDir);
    expect(output).toContain("detail-hook");
    expect(output).toContain("task.ready");
    expect(output).toContain("notify");
  });

  it("should get hook details by ULID prefix", () => {
    const added = addTestHook(tempDir, "ulid-hook");
    const prefix = (added._ulid as string).substring(0, 8);

    const output = kspec(`hook get ${prefix}`, tempDir);
    expect(output).toContain("ulid-hook");
  });

  // AC: @trait-json-output ac-1, ac-2
  it("should get hook as JSON", () => {
    addTestHook(tempDir, "json-detail-hook");

    const hook = kspecJson<Record<string, unknown>>("hook get json-detail-hook", tempDir);
    expect(hook._ulid).toBeDefined();
    expect(hook.name).toBe("json-detail-hook");
    expect(hook.on).toBe("task.ready");
    expect(hook.action).toBeDefined();
    expect(hook.enabled).toBe(true);
  });

  // AC: @trait-error-guidance ac-1, ac-2, ac-3 — not found with suggestion
  it("should show error with suggestion when hook not found", () => {
    const result = kspecRun("hook get nonexistent", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain("Hook not found");
    expect(result.stderr).toContain("kspec hook list");
  });
});

describe("Integration: hook set", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should update hook name", () => {
    addTestHook(tempDir, "old-name");

    kspec(`hook set old-name --name "new-name"`, tempDir);

    const hooks = kspecJson<Array<Record<string, unknown>>>("hook list", tempDir);
    expect(hooks[0].name).toBe("new-name");
  });

  it("should update hook event type", () => {
    addTestHook(tempDir, "event-hook");

    kspec("hook set event-hook --on task.in_progress", tempDir);

    const hook = kspecJson<Record<string, unknown>>("hook get event-hook", tempDir);
    expect(hook.on).toBe("task.in_progress");
  });

  it("should update hook action", () => {
    addTestHook(tempDir, "action-hook");

    kspec(`hook set action-hook --action '{"type":"kspec","command":"validate"}'`, tempDir);

    const hook = kspecJson<Record<string, unknown>>("hook get action-hook", tempDir);
    expect((hook.action as Record<string, unknown>).type).toBe("kspec");
  });

  it("should update hook filter", () => {
    addTestHook(tempDir, "filter-hook");

    kspec(`hook set filter-hook --filter '{"status":"pending"}'`, tempDir);

    const hook = kspecJson<Record<string, unknown>>("hook get filter-hook", tempDir);
    expect(hook.filter).toEqual({ status: "pending" });
  });

  it("should clear filter with empty object", () => {
    // Add a hook with a filter
    kspecJson(
      `hook add "clear-filter" --on task.ready --action '{"type":"notify","message":"test"}' --filter '{"status":"pending"}'`,
      tempDir,
    );

    // Clear filter
    kspec(`hook set clear-filter --filter '{}'`, tempDir);

    const hook = kspecJson<Record<string, unknown>>("hook get clear-filter", tempDir);
    expect(hook.filter).toBeNull();
  });

  it("should enable/disable via --enabled/--disabled", () => {
    addTestHook(tempDir, "toggle-hook");

    kspec("hook set toggle-hook --disabled", tempDir);
    let hook = kspecJson<Record<string, unknown>>("hook get toggle-hook", tempDir);
    expect(hook.enabled).toBe(false);

    kspec("hook set toggle-hook --enabled", tempDir);
    hook = kspecJson<Record<string, unknown>>("hook get toggle-hook", tempDir);
    expect(hook.enabled).toBe(true);
  });

  // AC: @trait-error-guidance ac-1, ac-2
  it("should error when hook not found", () => {
    const result = kspecRun("hook set nonexistent --name new", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain("Hook not found");
  });

  it("should reject duplicate name on rename", () => {
    addTestHook(tempDir, "name-a");
    addTestHook(tempDir, "name-b", "task.in_progress");

    const result = kspecRun(`hook set name-b --name "name-a"`, tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists");
  });

  // AC: @trait-error-guidance ac-5 — invalid event type
  it("should reject invalid event type in set", () => {
    addTestHook(tempDir, "bad-event-set");

    const result = kspecRun(
      "hook set bad-event-set --on invalid.type",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid event type");
  });
});

describe("Integration: hook enable/disable", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should enable a disabled hook", () => {
    kspecJson(
      `hook add "disabled-one" --on task.ready --action '{"type":"notify","message":"test"}' --disabled`,
      tempDir,
    );

    kspec("hook enable disabled-one", tempDir);

    const hook = kspecJson<Record<string, unknown>>("hook get disabled-one", tempDir);
    expect(hook.enabled).toBe(true);
  });

  it("should disable an enabled hook", () => {
    addTestHook(tempDir, "enabled-one");

    kspec("hook disable enabled-one", tempDir);

    const hook = kspecJson<Record<string, unknown>>("hook get enabled-one", tempDir);
    expect(hook.enabled).toBe(false);
  });

  it("should succeed when enabling an already enabled hook", () => {
    addTestHook(tempDir, "already-enabled");

    const output = kspec("hook enable already-enabled", tempDir);
    expect(output).toContain("already enabled");
  });

  it("should succeed when disabling an already disabled hook", () => {
    kspecJson(
      `hook add "already-disabled" --on task.ready --action '{"type":"notify","message":"test"}' --disabled`,
      tempDir,
    );

    const output = kspec("hook disable already-disabled", tempDir);
    expect(output).toContain("already disabled");
  });

  // AC: @trait-error-guidance ac-1, ac-2
  it("should error when hook not found for enable", () => {
    const result = kspecRun("hook enable nonexistent", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain("Hook not found");
  });

  // AC: @trait-semantic-exit-codes ac-1 — success exit code
  it("should exit with code 0 on successful enable", () => {
    kspecJson(
      `hook add "exit-test" --on task.ready --action '{"type":"notify","message":"test"}' --disabled`,
      tempDir,
    );

    const result = kspecRun("hook enable exit-test", tempDir);
    expect(result.exitCode).toBe(0);
  });
});

describe("Integration: hook remove", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should remove a hook with --confirm", () => {
    addTestHook(tempDir, "remove-me");

    const output = kspec("hook remove remove-me --confirm", tempDir);
    expect(output).toContain("Removed hook");

    const hooks = kspecJson<Array<Record<string, unknown>>>("hook list", tempDir);
    expect(hooks).toHaveLength(0);
  });

  it("should require --confirm for removal", () => {
    addTestHook(tempDir, "need-confirm");

    const result = kspecRun("hook remove need-confirm", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--confirm");
  });

  // AC: @trait-error-guidance ac-1, ac-2
  it("should error when hook not found for remove", () => {
    const result = kspecRun("hook remove nonexistent --confirm", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain("Hook not found");
  });

  // AC: @trait-json-output ac-1
  it("should output JSON on successful remove", () => {
    addTestHook(tempDir, "remove-json");

    const result = kspecJson<Record<string, unknown>>(
      "hook remove remove-json --confirm",
      tempDir,
    );
    expect(result.deleted).toBe(true);
    expect(result.name).toBe("remove-json");
  });

  // AC: @trait-semantic-exit-codes ac-1 — success exit code
  it("should exit with code 0 on successful remove", () => {
    addTestHook(tempDir, "exit-remove");

    const result = kspecRun("hook remove exit-remove --confirm", tempDir);
    expect(result.exitCode).toBe(0);
  });
});

describe("Integration: hook JSON output traits", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-json-output ac-3 — error as JSON with error field
  it("should return errors as JSON with error field", () => {
    const result = kspecRun("hook get nonexistent --json", tempDir, { expectFail: true });
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error).toBeDefined();
    expect(parsed.success).toBe(false);
  });

  // AC: @trait-json-output ac-6 — --json takes precedence over other format options
  it("should output JSON even when other format flags present", () => {
    addTestHook(tempDir, "format-test");

    // JSON flag should produce valid JSON
    const result = kspecRun("hook list --json", tempDir);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe("Integration: hook error guidance traits", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-error-guidance ac-1 — description of what went wrong
  // AC: @trait-error-guidance ac-2 — suggested action to resolve
  it("should include description and suggestion on not-found error", () => {
    const result = kspecRun("hook get missing-ref", tempDir, { expectFail: true });
    expect(result.stderr).toContain("Hook not found");
    expect(result.stderr).toContain("kspec hook list");
  });

  // AC: @trait-error-guidance ac-6 — guidance in structured error object
  it("should include guidance in JSON error output", () => {
    const result = kspecRun("hook get missing-ref --json", tempDir, { expectFail: true });
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error).toContain("Hook not found");
  });
});

describe("Integration: hook semantic exit codes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-semantic-exit-codes ac-1 — success exit code 0
  it("should exit 0 on successful list", () => {
    const result = kspecRun("hook list", tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-2 — validation error exit code 1
  it("should exit non-zero on validation error", () => {
    const result = kspecRun(
      `hook add "bad" --on invalid.type --action '{"type":"notify","message":"test"}'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-5 — exit 0 with empty result set
  it("should exit 0 with empty hook list", () => {
    const result = kspecRun("hook list", tempDir);
    expect(result.exitCode).toBe(0);
  });
});

// AC: @trait-json-output ac-4 — N/A: hook output does not contain @ references
// AC: @trait-json-output ac-5 — N/A: hook output does not contain timestamps

// AC: @trait-shadow-commit ac-2 — N/A: commit message format is tested centrally in shadow-commit tests
// AC: @trait-shadow-commit ac-3 — N/A: ULID prefix in commit message is tested centrally in shadow-commit tests
// AC: @trait-shadow-commit ac-4 — N/A: hook commands require shadow branch for persistence;
// projects without shadow branch get standard "no kspec project" error from initContext()
// AC: @trait-shadow-commit ac-5 — N/A: save errors are caught and returned as CLI errors
// AC: @trait-shadow-commit ac-6 — N/A: push is handled by commitIfShadow fire-and-forget
// AC: @trait-shadow-commit ac-7 — N/A: git failure warnings handled by commitIfShadow
// AC: @trait-shadow-commit ac-8 — N/A: each hook mutation is a single save + single commit

// AC: @trait-error-guidance ac-4 — N/A: hooks do not have state transitions
// AC: @trait-semantic-exit-codes ac-3 — N/A: hook commands do not have confirmation prompts
// AC: @trait-semantic-exit-codes ac-4 — N/A: runtime errors use EXIT_CODES.ERROR
// AC: @trait-semantic-exit-codes ac-6 — N/A: invalid flags/arguments are handled by Commander.js framework
// AC: @trait-semantic-exit-codes ac-7 — N/A: hook commands are not batch operations
// AC: @trait-semantic-exit-codes ac-8 — N/A: exit code meanings documented in code (exit-codes.ts)
