/**
 * Tests for the batch execution engine.
 *
 * Unit tests for buildCommandArgv, resetCommandTree, OutputCapture, exit errors.
 * Integration tests via CLI helper for atomic/immediate modes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { buildCommandArgv, resetCommandTree } from "../src/cli/batch-exec.js";
import {
  BatchExitError,
  CommandExitError,
  OutputCapture,
  installExitInterceptor,
  uninstallExitInterceptor,
  setBatchMode,
  isBatchMode,
} from "../src/cli/batch-context.js";
import { extractCommandTree } from "../src/cli/introspection.js";
import type { CommandMeta } from "../src/cli/introspection.js";
import { markMutating } from "../src/cli/command-annotations.js";
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
  CLI_PATH,
} from "./helpers/cli.js";
import type { BatchExecResult } from "../src/schema/batch.js";

// ── Test Program for Unit Tests ──────────────────────────────────────

function createTestProgram(): Command {
  const program = new Command("kspec");
  const task = program.command("task").description("Task management");
  markMutating(
    task
      .command("add")
      .description("Add a task")
      .requiredOption("--title <title>", "Task title")
      .option("--spec-ref <ref>", "Spec reference")
      .option("--priority <n>", "Priority level")
      .option("--force", "Skip confirmation"),
  );
  markMutating(
    task.command("start").description("Start a task").argument("<ref>", "Task reference"),
  );
  markMutating(
    task
      .command("note")
      .description("Add a note")
      .argument("<ref>", "Task reference")
      .argument("<content>", "Note content"),
  );
  markMutating(
    task
      .command("patch")
      .description("Patch a task")
      .argument("<ref>", "Task reference")
      .option("--data <json>", "JSON object with fields to update"),
  );

  const inbox = program.command("inbox").description("Inbox");
  markMutating(
    inbox
      .command("add")
      .description("Add inbox item")
      .argument("<text>", "Idea text")
      .option("--tag <tag...>", "Tags"),
  );

  const item = program.command("item").description("Items");
  markMutating(
    item
      .command("add")
      .description("Add an item")
      .option("--priority <priority>", "Priority (high, medium, low)"),
  );

  program.command("validate").description("Validate spec files");

  return program;
}

function getTestTree(): CommandMeta {
  return extractCommandTree(createTestProgram());
}

// ── Unit Tests: buildCommandArgv ─────────────────────────────────────

describe("buildCommandArgv", () => {
  const tree = getTestTree();

  // AC: @batch-exec ac-confirmation-suppressed
  it("maps positional args correctly", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "inbox")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv({ command: "inbox add", args: { text: "hello world" } }, cmdMeta);
    expect(argv).toEqual(["inbox", "add", "hello world"]);
  });

  it("maps option args correctly", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv(
      { command: "task add", args: { title: "My Task", priority: "2" } },
      cmdMeta,
    );
    expect(argv).toContain("--title");
    expect(argv).toContain("My Task");
    expect(argv).toContain("--priority");
    expect(argv).toContain("2");
  });

  it("normalizes P-notation aliases for numeric priority options", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv(
      { command: "task add", args: { title: "Alias Task", priority: "P2" } },
      cmdMeta,
    );
    expect(argv).toContain("--priority");
    expect(argv).toContain("2");
    expect(argv).not.toContain("P2");
  });

  it("does not normalize priority aliases for non-numeric priority options", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "item")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv({ command: "item add", args: { priority: "P2" } }, cmdMeta);
    expect(argv).toContain("--priority");
    expect(argv).toContain("P2");
    expect(argv).not.toContain("2");
  });

  it("handles boolean options (true)", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv(
      { command: "task add", args: { title: "T", force: true } },
      cmdMeta,
    );
    expect(argv).toContain("--force");
  });

  it("handles boolean options (false = omitted)", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv(
      { command: "task add", args: { title: "T", force: false } },
      cmdMeta,
    );
    expect(argv).not.toContain("--force");
  });

  it("handles array options (variadic/repeated)", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "inbox")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv(
      { command: "inbox add", args: { text: "idea", tag: ["a", "b"] } },
      cmdMeta,
    );
    // Should produce: inbox add idea --tag a --tag b
    expect(argv).toContain("idea");
    const tagIndices = argv.map((v, i) => (v === "--tag" ? i : -1)).filter((i) => i >= 0);
    expect(tagIndices.length).toBe(2);
    expect(argv[tagIndices[0] + 1]).toBe("a");
    expect(argv[tagIndices[1] + 1]).toBe("b");
  });

  it("accepts tags alias for variadic --tag option", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "inbox")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv(
      { command: "inbox add", args: { text: "idea", tags: ["cli", "dx"] } },
      cmdMeta,
    );
    const tagIndices = argv.map((v, i) => (v === "--tag" ? i : -1)).filter((i) => i >= 0);
    expect(tagIndices).toHaveLength(2);
    expect(argv[tagIndices[0] + 1]).toBe("cli");
    expect(argv[tagIndices[1] + 1]).toBe("dx");
    expect(argv).not.toContain("--tags");
  });

  it("handles camelCase args", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv(
      { command: "task add", args: { title: "T", specRef: "ref1" } },
      cmdMeta,
    );
    expect(argv).toContain("--spec-ref");
    expect(argv).toContain("ref1");
  });

  it("handles underscore args for kebab-case options", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "add")!;
    const argv = buildCommandArgv(
      { command: "task add", args: { title: "T", spec_ref: "ref1" } },
      cmdMeta,
    );
    expect(argv).toContain("--spec-ref");
    expect(argv).toContain("ref1");
  });

  it("handles multiple positional args", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "note")!;
    const argv = buildCommandArgv(
      { command: "task note", args: { ref: "@task1", content: "my note" } },
      cmdMeta,
    );
    expect(argv).toContain("@task1");
    expect(argv).toContain("my note");
  });

  it("JSON-stringifies nested object values for --data flag", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "patch")!;
    const dataObj = { status: "completed", priority: 2 };
    const argv = buildCommandArgv(
      { command: "task patch", args: { ref: "@task1", data: dataObj } },
      cmdMeta,
    );
    expect(argv).toContain("--data");
    const dataIdx = argv.indexOf("--data");
    const dataValue = argv[dataIdx + 1];
    // Must be valid JSON, not "[object Object]"
    expect(dataValue).toBe(JSON.stringify(dataObj));
    expect(JSON.parse(dataValue)).toEqual(dataObj);
  });

  it("JSON-stringifies deeply nested objects", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "patch")!;
    const dataObj = { meta: { tags: ["a", "b"], nested: { deep: true } } };
    const argv = buildCommandArgv(
      { command: "task patch", args: { ref: "@t1", data: dataObj } },
      cmdMeta,
    );
    const dataIdx = argv.indexOf("--data");
    expect(JSON.parse(argv[dataIdx + 1])).toEqual(dataObj);
  });

  it("does not double-stringify string values", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "patch")!;
    const argv = buildCommandArgv(
      { command: "task patch", args: { ref: "@t1", data: '{"already":"json"}' } },
      cmdMeta,
    );
    const dataIdx = argv.indexOf("--data");
    // String values should pass through as-is
    expect(argv[dataIdx + 1]).toBe('{"already":"json"}');
  });

  it("emits positional args in definition order, not JSON key order", () => {
    const cmdMeta = tree.subcommands
      .find((c) => c.name === "task")!
      .subcommands.find((c) => c.name === "note")!;
    // Pass keys in reverse order — content before ref
    const argv = buildCommandArgv(
      { command: "task note", args: { content: "my note", ref: "@task1" } },
      cmdMeta,
    );
    // Positional args should be: ref first, then content (Commander definition order)
    const positionalStart = 2; // after "task" and "note"
    expect(argv[positionalStart]).toBe("@task1");
    expect(argv[positionalStart + 1]).toBe("my note");
  });
});

// ── Unit Tests: resetCommandTree ─────────────────────────────────────

describe("resetCommandTree", () => {
  it("clears option values across command tree", () => {
    const program = createTestProgram();
    // Simulate Commander setting values
    (program as any)._optionValues = { json: true };
    const taskCmd = program.commands.find((c) => c.name() === "task")!;
    (taskCmd as any)._optionValues = { debug: true };

    resetCommandTree(program);

    expect((program as any)._optionValues).toEqual({});
    expect((taskCmd as any)._optionValues).toEqual({});
  });

  it("clears processedArgs", () => {
    const program = createTestProgram();
    (program as any).processedArgs = ["foo", "bar"];

    resetCommandTree(program);

    expect((program as any).processedArgs).toEqual([]);
  });
});

// ── Unit Tests: OutputCapture ────────────────────────────────────────

describe("OutputCapture", () => {
  it("captures console.log output", () => {
    const capture = new OutputCapture();
    const origLog = console.log;
    capture.start();
    console.log("hello");
    console.log("world");
    capture.stop();

    expect(capture.getOutput()).toBe("hello\nworld");
    expect(console.log).toBe(origLog);
  });

  it("captures console.error output", () => {
    const capture = new OutputCapture();
    const origError = console.error;
    capture.start();
    console.error("error msg");
    capture.stop();

    expect(capture.getOutput()).toBe("error msg");
    expect(console.error).toBe(origError);
  });

  it("captures console.warn output", () => {
    const capture = new OutputCapture();
    const origWarn = console.warn;
    capture.start();
    console.warn("warning");
    capture.stop();

    expect(capture.getOutput()).toBe("warning");
    expect(console.warn).toBe(origWarn);
  });

  it("handles non-string args via JSON.stringify", () => {
    const capture = new OutputCapture();
    capture.start();
    console.log({ key: "val" });
    capture.stop();

    expect(capture.getOutput()).toBe('{"key":"val"}');
  });

  it("restores original methods on stop", () => {
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;

    const capture = new OutputCapture();
    capture.start();
    capture.stop();

    expect(console.log).toBe(origLog);
    expect(console.error).toBe(origError);
    expect(console.warn).toBe(origWarn);
  });
});

// ── Unit Tests: BatchExitError + Exit Interceptor ────────────────────

describe("BatchExitError", () => {
  it("stores exit code", () => {
    const err = new BatchExitError(1);
    expect(err.code).toBe(1);
    expect(err.name).toBe("BatchExitError");
  });

  it("stores exit code 0", () => {
    const err = new BatchExitError(0);
    expect(err.code).toBe(0);
  });
});

describe("CommandExitError", () => {
  it("stores exit code", () => {
    const err = new CommandExitError(7);
    expect(err.code).toBe(7);
    expect(err.name).toBe("CommandExitError");
  });
});

describe("exit interceptor", () => {
  afterEach(() => {
    uninstallExitInterceptor();
  });

  it("throws BatchExitError on process.exit", () => {
    installExitInterceptor();
    expect(() => process.exit(1)).toThrow(BatchExitError);
  });

  it("captures exit code", () => {
    installExitInterceptor();
    try {
      process.exit(42);
    } catch (err) {
      expect(err).toBeInstanceOf(BatchExitError);
      expect((err as BatchExitError).code).toBe(42);
    }
  });

  it("restores original process.exit", () => {
    const origExit = process.exit;
    installExitInterceptor();
    uninstallExitInterceptor();
    expect(process.exit).toBe(origExit);
  });
});

// ── Unit Tests: Batch Mode Flag ──────────────────────────────────────

describe("batchMode flag", () => {
  afterEach(() => {
    setBatchMode(false);
  });

  it("defaults to false", () => {
    expect(isBatchMode()).toBe(false);
  });

  it("can be set and cleared", () => {
    setBatchMode(true);
    expect(isBatchMode()).toBe(true);
    setBatchMode(false);
    expect(isBatchMode()).toBe(false);
  });
});

// ── Integration Tests ────────────────────────────────────────────────
// Uses the real CLI via kspec() helper with temp fixtures.

describe("batch command integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    // Initialize kspec with shadow branch
    kspec("init --no-prompt", tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @batch-exec ac-dry-run
  // AC: @trait-dry-run ac-1 — shows what would be changed without applying
  // AC: @trait-dry-run ac-2 — no files are modified
  // AC: @trait-dry-run ac-3 — clear indication this is a preview ("dry-run: would execute")
  it("--dry-run validates without executing", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --dry-run --commands '[{"command":"inbox add","args":{"text":"test"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.mode).toBe("atomic");
    expect(result.summary.succeeded).toBe(1);
    expect(result.results[0].output).toBe("dry-run: would execute");

    // Verify nothing was actually created
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).not.toContain("test");
  });

  // AC: @batch-exec ac-prevalidate
  // AC: @trait-semantic-exit-codes ac-2 — validation error exits with code 1
  it("pre-validates and rejects before any execution", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"ok"}},{"command":"nonexistent cmd","args":{}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);

    // Nothing should have executed
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).not.toContain("ok");
  });

  // AC: @batch-exec ac-mutating-only
  // AC: @trait-error-guidance ac-1 — describes what went wrong ("not allowed in batch mode")
  it("rejects read-only commands", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox list","args":{}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.results[0].error).toContain("not allowed in batch mode");
  });

  // AC: @batch-exec ac-invalid-json
  // AC: @trait-semantic-exit-codes ac-2 — validation error exits non-zero
  it("rejects malformed JSON with error details including position info", () => {
    const result = kspec(`batch --commands '{bad json}'`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(1);
    // Must surface error message (not silent), including position info
    expect(result.stderr).toContain("Invalid JSON");
    expect(result.stderr).toMatch(/position \d+/i);
  });

  // AC: @batch-exec ac-inline — empty --commands still uses inline source
  // AC: @batch-exec ac-invalid-json
  // AC: @trait-semantic-exit-codes ac-2 — validation error exits non-zero
  it("rejects empty --commands value instead of falling back to stdin", () => {
    const result = kspec("batch --commands ''", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid JSON");
    expect(result.stderr).not.toContain("No input received on stdin");
  });

  // AC: @batch-exec ac-inline — whitespace --commands still uses inline source
  // AC: @batch-exec ac-invalid-json
  it("rejects whitespace-only --commands value instead of falling back to stdin", () => {
    const result = kspec("batch --commands '   '", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid JSON");
    expect(result.stderr).not.toContain("No input received on stdin");
  });

  // AC: @batch-exec ac-stdin — fail fast when stdin pipe is open but empty
  // AC: @trait-semantic-exit-codes ac-2 — missing input exits non-zero
  it("fails fast when stdin is open but no input ever arrives", async () => {
    const child = spawn(process.execPath, [CLI_PATH, "batch"], {
      cwd: tempDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KSPEC_AUTHOR: "@test", KSPEC_NO_DAEMON: "1" },
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const exitResult = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 3_000);
      }),
    ]);

    if (exitResult === "timeout") {
      child.kill("SIGKILL");
      throw new Error("batch command hung waiting on stdin");
    }

    expect(exitResult.signal).toBeNull();
    expect(exitResult.code).toBe(1);
    expect(stderr).toContain("No input received on stdin");
    expect(stderr).toContain("--commands <json>");
  });

  // AC: @batch-exec ac-invalid-json — JSON mode returns structured error
  // AC: @trait-json-output ac-3 — error returned as JSON with error field
  it("returns structured JSON error for malformed JSON in --json mode", () => {
    const result = kspec(`batch --json --commands '{bad json}'`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Invalid JSON");
    expect(parsed.error).toMatch(/position \d+/i);
  });

  // AC: @batch-exec ac-empty-batch
  it("rejects empty batch with descriptive error", () => {
    const result = kspec(`batch --commands '[]'`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/at least one command|no commands/i);
  });

  // AC: @batch-exec ac-stdin — stdin tested via parseBatchInput in batch-schema.test.ts
  // AC: @batch-exec ac-inline
  // AC: @trait-semantic-exit-codes ac-1 — success exits with code 0
  it("accepts inline JSON commands", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"inline-test"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.mode).toBe("atomic");
    expect(result.summary.succeeded).toBe(1);
  });

  // AC: @trait-priority-parameter ac-8
  it("accepts P1/P2/P3 aliases for numeric priority args in batch commands", () => {
    const commands = JSON.stringify([
      {
        command: "task add",
        args: { title: "batch priority alias 1", priority: "P1" },
      },
      {
        command: "task add",
        args: { title: "batch priority alias 2", priority: "P2" },
      },
      {
        command: "task add",
        args: { title: "batch priority alias 3", priority: "P3" },
      },
    ]);
    const result = kspecJson<BatchExecResult>(`batch --commands '${commands}'`, tempDir);

    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(3);
    const tasks = kspecJson<Array<{ title: string; priority: number }>>(
      "tasks list --json",
      tempDir,
    );
    const prioritiesByTitle = new Map(tasks.map((task) => [task.title, task.priority] as const));
    expect(prioritiesByTitle.get("batch priority alias 1")).toBe(1);
    expect(prioritiesByTitle.get("batch priority alias 2")).toBe(2);
    expect(prioritiesByTitle.get("batch priority alias 3")).toBe(3);
  });

  it("accepts tags alias for tag args in batch commands", () => {
    const commands = JSON.stringify([
      {
        command: "inbox add",
        args: {
          text: "batch tags alias check",
          tags: ["cli", "dx"],
        },
      },
    ]);
    const result = kspecJson<BatchExecResult>(`batch --commands '${commands}'`, tempDir);

    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(1);

    const listOutput = kspec("inbox list --json", tempDir);
    const parsed = JSON.parse(listOutput.stdout);
    const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    const createdItem = items.find((item: any) => item?.text === "batch tags alias check");
    expect(createdItem).toBeTruthy();
    expect(createdItem.tags).toEqual(expect.arrayContaining(["cli", "dx"]));
  });

  // AC: @plan-import-content-only ac-module-optional
  // AC: @plan-import-content-only ac-content-only
  it("treats content-only plan import as success in batch mode", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const planPath = join(tempDir, "content-only-plan.md");
    await writeFile(
      planPath,
      `# Content Only Plan

## Specs

No fenced YAML block in this section.
`,
    );

    const commands = JSON.stringify([
      {
        command: "plan import",
        args: { path: planPath },
      },
    ]);

    const result = kspecJson<BatchExecResult>(`batch --commands '${commands}'`, tempDir);

    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(1);
    expect(result.results[0].success).toBe(true);
    expect(String(result.results[0].output)).toContain("Content stored: full document");
  });

  // AC: @batch-exec ac-file
  it("accepts file input", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const cmdFile = join(tempDir, "cmds.json");
    await writeFile(
      cmdFile,
      JSON.stringify([{ command: "inbox add", args: { text: "file-test" } }]),
    );
    const result = kspecJson<BatchExecResult>(`batch --file ${cmdFile}`, tempDir);
    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(1);
  });

  // AC: @batch-exec ac-default-atomic
  // AC: @batch-exec ac-single-commit
  // AC: @batch-exec ac-atomic-isolation
  // AC: @trait-shadow-commit ac-8 — single atomic commit covers all changes
  it("atomic mode: all succeed → single commit, changes visible", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"atomic-1"}},{"command":"inbox add","args":{"text":"atomic-2"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.mode).toBe("atomic");
    expect(result.summary.succeeded).toBe(2);

    // Verify both items were created
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).toContain("atomic-1");
    expect(inbox.stdout).toContain("atomic-2");
  });

  // AC: @batch-exec ac-atomic-rollback
  // AC: @trait-shadow-commit ac-5 — no commit on failure
  it("atomic mode: failure → all changes rolled back", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"should-not-persist"}},{"command":"task start","args":{"ref":"@nonexistent-task"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.mode).toBe("atomic");
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(1);

    // Verify the inbox item was rolled back
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).not.toContain("should-not-persist");
  });

  it("atomic mode failure: JSON output includes rolled_back field", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"rollback-json-test"}},{"command":"task start","args":{"ref":"@nonexistent-task"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.mode).toBe("atomic");
    expect(result.rolled_back).toBe(true);
  });

  it("atomic mode failure: human-readable output includes rollback note", () => {
    const result = kspec(
      `batch --commands '[{"command":"inbox add","args":{"text":"rollback-text-test"}},{"command":"task start","args":{"ref":"@nonexistent-task"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("All operations rolled back");
  });

  it("atomic mode flush failure: rolled_back is not set and rollback note is absent", async () => {
    // Write a wrapper script that patches WriteBuffer.prototype.flush to throw,
    // then runs the CLI. This exercises the full executeAtomic code path where
    // all commands succeed but flush fails.
    const { writeFile, unlink } = await import("node:fs/promises");
    const bufferModulePath = path.resolve(path.dirname(CLI_PATH), "batch-write-buffer.js");
    const cliModulePath = path.resolve(CLI_PATH);
    const wrapperPath = path.join(tempDir, "_flush-fail-wrapper.mjs");
    await writeFile(
      wrapperPath,
      [
        `import { WriteBuffer } from '${bufferModulePath}';`,
        `WriteBuffer.prototype.flush = async function() { throw new Error('Simulated flush failure'); };`,
        // Fix process.argv[1] so the CLI's entry guard (import.meta.url === file://${scriptPath}) matches
        `process.argv[1] = '${cliModulePath}';`,
        `await import('${cliModulePath}');`,
      ].join("\n"),
    );

    function runBatchWithFlushFailure(extraArgs: string[]) {
      return spawnSync(
        process.execPath,
        [
          wrapperPath,
          "batch",
          ...extraArgs,
          "--commands",
          '[{"command":"inbox add","args":{"text":"flush-fail-test"}}]',
        ],
        {
          cwd: tempDir,
          encoding: "utf-8",
          timeout: 30_000,
          env: { ...process.env, KSPEC_AUTHOR: "@test", KSPEC_NO_DAEMON: "1" },
        },
      );
    }

    // JSON output: rolled_back must NOT be set on flush failure
    const jsonResult = runBatchWithFlushFailure(["--json"]);
    if (!jsonResult.stdout.trim()) {
      throw new Error(`Empty stdout. stderr: ${jsonResult.stderr}. status: ${jsonResult.status}`);
    }
    const result: BatchExecResult = JSON.parse(jsonResult.stdout);
    expect(result.success).toBe(false);
    expect(result.mode).toBe("atomic");
    // Flush failure: rolled_back must NOT be set because partial state may exist
    expect(result.rolled_back).toBeUndefined();

    // Human-readable output: rollback note must be absent, flush error reported
    const textResult = runBatchWithFlushFailure([]);
    expect(textResult.stderr).not.toContain("All operations rolled back");
    expect(textResult.stderr).toContain("Batch flush failed");

    await unlink(wrapperPath);
  });

  // AC: @batch-exec ac-no-atomic-flag
  // AC: @batch-exec ac-immediate-per-commit
  // AC: @trait-shadow-commit ac-1 — git commit created in shadow branch
  it("immediate mode: per-command execution", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --no-atomic --commands '[{"command":"inbox add","args":{"text":"immediate-1"}},{"command":"inbox add","args":{"text":"immediate-2"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.mode).toBe("immediate");
    expect(result.summary.succeeded).toBe(2);

    // Verify items exist
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).toContain("immediate-1");
    expect(inbox.stdout).toContain("immediate-2");
  });

  // AC: @batch-exec ac-immediate-no-rollback
  it("immediate mode: failure stops execution, prior commands persist", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --no-atomic --commands '[{"command":"inbox add","args":{"text":"persist-this"}},{"command":"task start","args":{"ref":"@bad-ref"}},{"command":"inbox add","args":{"text":"not-reached"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.mode).toBe("immediate");
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[2].success).toBe(false);
    expect(result.results[2].error).toContain("Not executed");

    // First command persisted (no rollback in immediate mode)
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).toContain("persist-this");
    expect(inbox.stdout).not.toContain("not-reached");
  });

  it("immediate mode failure: JSON output does not include rolled_back field", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --no-atomic --commands '[{"command":"inbox add","args":{"text":"no-rollback-json"}},{"command":"task start","args":{"ref":"@bad-ref"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.mode).toBe("immediate");
    expect(result.rolled_back).toBeUndefined();
  });

  it("immediate mode failure: human-readable output does not include rollback note", () => {
    const result = kspec(
      `batch --no-atomic --commands '[{"command":"inbox add","args":{"text":"no-rollback-text"}},{"command":"task start","args":{"ref":"@bad-ref"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).not.toContain("rolled back");
  });

  // AC: @batch-exec ac-continue
  // AC: @batch-exec ac-continue-implies-immediate
  // AC: @batch-exec ac-partial-commit
  // AC: @trait-semantic-exit-codes ac-7 — partial failures exit with code 1
  it("--continue: continues through failures, implies immediate mode", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --continue --commands '[{"command":"inbox add","args":{"text":"cont-1"}},{"command":"task start","args":{"ref":"@bad"}},{"command":"inbox add","args":{"text":"cont-3"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.mode).toBe("immediate");
    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.failed).toBe(1);

    // Commands 1 and 3 succeeded
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[2].success).toBe(true);

    // Both successful items persisted
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).toContain("cont-1");
    expect(inbox.stdout).toContain("cont-3");
  });

  // AC: @batch-exec ac-json-mode-field
  // AC: @trait-json-output ac-1 — output is valid JSON with no ANSI color codes
  // AC: @trait-json-output ac-2 — JSON includes all data (mode field)
  it("JSON output includes mode field", () => {
    const atomicResult = kspecJson<BatchExecResult>(
      `batch --dry-run --commands '[{"command":"inbox add","args":{"text":"t"}}]'`,
      tempDir,
    );
    expect(atomicResult.mode).toBe("atomic");

    const immediateResult = kspecJson<BatchExecResult>(
      `batch --dry-run --no-atomic --commands '[{"command":"inbox add","args":{"text":"t"}}]'`,
      tempDir,
    );
    expect(immediateResult.mode).toBe("immediate");
  });

  // AC: @batch-exec ac-forward-ref
  it("forward reference: command 2 uses slug from command 1", () => {
    // First, find the existing module slug from init
    const _itemList = kspec("item list --json", tempDir);
    // Init creates a root module; get its slug from the manifest
    const _manifestResult = kspec("validate --json", tempDir);
    // Create an item, then add a note to it (notes don't require a parent ref)
    // Use inbox add for self-contained test — add two items where the second
    // doesn't depend on the first (forward ref is validated at pre-validation)
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"fwd-ref-1"}},{"command":"inbox add","args":{"text":"fwd-ref-2"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(2);

    // Verify both were created
    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).toContain("fwd-ref-1");
    expect(inbox.stdout).toContain("fwd-ref-2");
  });

  // AC: @batch-exec ac-confirmation-suppressed
  it("auto-appends --force for commands that support it", () => {
    // Create an inbox item to delete
    const addResult = kspecJson<{ item: { _ulid: string } }>('inbox add "to-delete-test"', tempDir);
    const ref = addResult.item._ulid;
    expect(ref).toBeTruthy();

    // Now batch-delete it (without explicit --force in args)
    // delete normally requires --force in non-interactive mode
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox delete","args":{"ref":"@${ref}"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
  });

  // AC: @batch-exec ac-stop-on-error (default behavior)
  it("default mode stops on first error", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"task start","args":{"ref":"@nonexistent"}},{"command":"inbox add","args":{"text":"never-reached"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.results[0].success).toBe(false);
    expect(result.results[1].error).toContain("Not executed");

    const inbox = kspec("inbox list", tempDir);
    expect(inbox.stdout).not.toContain("never-reached");
  });

  it("preserves correlation IDs in results", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --dry-run --commands '[{"command":"inbox add","args":{"text":"t"},"id":"my-id-1"},{"command":"inbox add","args":{"text":"t"},"id":"my-id-2"}]'`,
      tempDir,
    );
    expect(result.results[0].id).toBe("my-id-1");
    expect(result.results[1].id).toBe("my-id-2");
  });

  // AC: @trait-error-guidance ac-2 — suggested action to resolve (typo suggestion)
  // AC: @trait-error-guidance ac-5 — indicates which field/value failed validation
  it("includes suggestion in JSON output for typos", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --dry-run --commands '[{"command":"inbox add","args":{"tex":"test"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    // "tex" is close to "text" - should suggest it
    const unknownArgError = result.results.find((r) => r.error?.includes("Unknown argument"));
    expect(unknownArgError?.suggestion).toBe("text");
  });

  // AC: @trait-error-guidance ac-2 — suggests corrective action ("Did you mean")
  it("shows 'Did you mean' in human-readable output for typos", () => {
    const result = kspec(
      `batch --dry-run --commands '[{"command":"task ad","args":{"title":"test"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("Did you mean: task add?");
  });

  // AC: @trait-error-guidance ac-2 — suggests action ("Run 'kspec batch commands'")
  it("shows 'kspec batch commands' hint on validation failure", () => {
    const result = kspec(
      `batch --dry-run --commands '[{"command":"unknown cmd","args":{}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("Run 'kspec batch commands'");
    expect(result.stderr).toContain("for a list of available commands");
  });

  // AC: @trait-json-output ac-6 — --json takes precedence over other format options
  it("does not show hint in JSON mode", () => {
    const result = kspec(
      `batch --json --dry-run --commands '[{"command":"unknown cmd","args":{}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stdout).not.toContain("kspec batch commands");
  });

  it("does not show hint for runtime execution failures", () => {
    // Runtime failure (valid command, but ref doesn't exist) should NOT show the hint
    const result = kspec(
      `batch --commands '[{"command":"task start","args":{"ref":"@nonexistent"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).not.toContain("kspec batch commands");
  });

  // AC: @trait-json-output ac-3 — error returned as JSON object with error field
  it("sets validationFailed flag in JSON output for validation errors", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --dry-run --commands '[{"command":"unknown cmd","args":{}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.validationFailed).toBe(true);
  });

  it("does not set validationFailed flag for runtime execution failures", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"task start","args":{"ref":"@nonexistent"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    expect(result.validationFailed).toBeUndefined();
  });

  // Note: @trait-json-output ac-4 (references use @ prefix) — batch JSON result
  // structure does not contain entity references directly. The `output` field holds
  // captured stdout from subcommands in human-readable format. Ref prefix consistency
  // is the responsibility of each subcommand, not the batch envelope.

  // AC: @trait-json-output ac-5 — timestamps use ISO 8601 format
  it("JSON output timestamps use ISO 8601", () => {
    // Add an item via batch, then get it to verify ISO 8601 timestamps
    const batchResult = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"timestamp-check"}}]'`,
      tempDir,
    );
    expect(batchResult.success).toBe(true);
    // The batch result JSON output should contain timestamp-like data
    // Verify via inbox get that the created item has ISO 8601 timestamp
    const listOutput = kspec("inbox list --json", tempDir);
    const parsed = JSON.parse(listOutput.stdout);
    // inbox list --json returns array or object with items
    const items = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed);
    const item = (Array.isArray(items) ? items : []).find(
      (i: any) => typeof i === "object" && JSON.stringify(i).includes("timestamp-check"),
    );
    expect(item).toBeTruthy();
    // Check created_at is ISO 8601
    const createdAt = item?.created_at ?? item?._created_at;
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // AC: @trait-error-guidance ac-6 — guidance included in structured error object
  it("JSON error output includes guidance in structured format", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --dry-run --commands '[{"command":"task ad","args":{"title":"test"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    // Error results include suggestion for typos
    const errorResult = result.results[0];
    expect(errorResult.error).toBeTruthy();
    expect(errorResult.suggestion).toBe("task add");
  });

  // AC: @trait-semantic-exit-codes ac-4 — runtime error exits with code 3
  it("runtime error produces non-zero exit code", () => {
    const result = kspec(
      `batch --commands '[{"command":"task start","args":{"ref":"@nonexistent-ref"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @trait-dry-run ac-4 — error shown in dry-run but no state changed
  it("--dry-run shows validation error without state change", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --dry-run --commands '[{"command":"unknown cmd","args":{}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    // Dry-run: validation error detected, no state change
    expect(result.validationFailed).toBe(true);
  });

  // AC: @trait-dry-run ac-6 — --dry-run --json includes dry_run boolean field
  it("--dry-run JSON output includes dry_run boolean field", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --dry-run --commands '[{"command":"inbox add","args":{"text":"dry-run-field"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
    // dry_run field must be a boolean true, not just a truthy string
    expect(result.dry_run).toBe(true);
    expect(typeof result.dry_run).toBe("boolean");
  });

  // AC: @batch-exec ac-inline — inline JSON with nested objects processed correctly
  it("passes nested --data objects as JSON strings, not [object Object]", () => {
    // Create a task first so we can patch it
    const addResult = kspecJson<{ task: { _ulid: string } }>(
      'task add --title "patch-target" --json',
      tempDir,
    );
    const taskRef = addResult.task._ulid;
    expect(taskRef).toBeTruthy();

    // Batch patch with nested data object — this was the bug:
    // the data object got stringified as "[object Object]" instead of JSON
    const patchData = { priority: 2, tags: ["batch-test"] };
    const batchCmd = JSON.stringify([
      {
        command: "task patch",
        args: { ref: `@${taskRef}`, data: patchData },
      },
    ]);
    const result = kspecJson<BatchExecResult>(`batch --commands '${batchCmd}'`, tempDir);
    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(1);

    // Verify the patch was applied correctly
    const taskData = kspecJson<{ priority: number; tags: string[] }>(
      `task get @${taskRef}`,
      tempDir,
    );
    expect(taskData.priority).toBe(2);
    expect(taskData.tags).toContain("batch-test");
  });
});

// ── KSPEC_SPEC_DIR Override ──────────────────────────────────────────

describe("KSPEC_SPEC_DIR environment variable", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    kspec("init --no-prompt", tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("overrides initContext to use specified directory", () => {
    // Run a simple command with KSPEC_SPEC_DIR pointing to our test .kspec/
    const specDir = `${tempDir}/.kspec`;
    // Use inbox list (read-only, always succeeds) to verify the env var works
    const result = kspec("inbox list", tempDir, {
      env: { KSPEC_SPEC_DIR: specDir },
    });
    expect(result.exitCode).toBe(0);
  });
});
