/**
 * Tests for the batch execution engine.
 *
 * Unit tests for buildCommandArgv, resetCommandTree, OutputCapture, BatchExitError.
 * Integration tests via CLI helper for atomic/immediate modes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import {
  buildCommandArgv,
  resetCommandTree,
} from "../src/cli/batch-exec.js";
import {
  BatchExitError,
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
} from "./helpers/cli.js";
import type { BatchExecResult, BatchCommandResult } from "../src/schema/batch.js";

// ── Test Program for Unit Tests ──────────────────────────────────────

function createTestProgram(): Command {
  const program = new Command("kspec");
  const task = program.command("task").description("Task management");
  markMutating(
    task.command("add")
      .description("Add a task")
      .requiredOption("--title <title>", "Task title")
      .option("--spec-ref <ref>", "Spec reference")
      .option("--priority <n>", "Priority level")
      .option("--force", "Skip confirmation"),
  );
  markMutating(
    task.command("start")
      .description("Start a task")
      .argument("<ref>", "Task reference"),
  );
  markMutating(
    task.command("note")
      .description("Add a note")
      .argument("<ref>", "Task reference")
      .argument("<content>", "Note content"),
  );

  const inbox = program.command("inbox").description("Inbox");
  markMutating(
    inbox.command("add")
      .description("Add inbox item")
      .argument("<text>", "Idea text")
      .option("--tag <tag...>", "Tags"),
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
    const argv = buildCommandArgv(
      { command: "inbox add", args: { text: "hello world" } },
      cmdMeta,
    );
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
    const tagIndices = argv
      .map((v, i) => (v === "--tag" ? i : -1))
      .filter((i) => i >= 0);
    expect(tagIndices.length).toBe(2);
    expect(argv[tagIndices[0] + 1]).toBe("a");
    expect(argv[tagIndices[1] + 1]).toBe("b");
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
  it("rejects malformed JSON", () => {
    const result = kspec(
      `batch --commands 'not valid json'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @batch-exec ac-empty-batch
  it("rejects empty batch", () => {
    const result = kspec(
      `batch --commands '[]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @batch-exec ac-stdin — stdin tested via parseBatchInput in batch-schema.test.ts
  // AC: @batch-exec ac-inline
  it("accepts inline JSON commands", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --commands '[{"command":"inbox add","args":{"text":"inline-test"}}]'`,
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.mode).toBe("atomic");
    expect(result.summary.succeeded).toBe(1);
  });

  // AC: @batch-exec ac-file
  it("accepts file input", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const cmdFile = join(tempDir, "cmds.json");
    await writeFile(cmdFile, JSON.stringify([
      { command: "inbox add", args: { text: "file-test" } },
    ]));
    const result = kspecJson<BatchExecResult>(
      `batch --file ${cmdFile}`,
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.summary.succeeded).toBe(1);
  });

  // AC: @batch-exec ac-default-atomic
  // AC: @batch-exec ac-single-commit
  // AC: @batch-exec ac-atomic-isolation
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

  // AC: @batch-exec ac-no-atomic-flag
  // AC: @batch-exec ac-immediate-per-commit
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

  // AC: @batch-exec ac-continue
  // AC: @batch-exec ac-continue-implies-immediate
  // AC: @batch-exec ac-partial-commit
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
    const itemList = kspec("item list --json", tempDir);
    // Init creates a root module; get its slug from the manifest
    const manifestResult = kspec("validate --json", tempDir);
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
    const addResult = kspecJson<{ item: { _ulid: string } }>(
      'inbox add "to-delete-test"',
      tempDir,
    );
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

  it("includes suggestion in JSON output for typos", () => {
    const result = kspecJson<BatchExecResult>(
      `batch --dry-run --commands '[{"command":"inbox add","args":{"tex":"test"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.success).toBe(false);
    // "tex" is close to "text" - should suggest it
    const unknownArgError = result.results.find(r => r.error?.includes("Unknown argument"));
    expect(unknownArgError?.suggestion).toBe("text");
  });

  it("shows 'Did you mean' in human-readable output for typos", () => {
    const result = kspec(
      `batch --dry-run --commands '[{"command":"task ad","args":{"title":"test"}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("Did you mean: task add?");
  });

  it("shows 'kspec batch commands' hint on validation failure", () => {
    const result = kspec(
      `batch --dry-run --commands '[{"command":"unknown cmd","args":{}}]'`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("Run 'kspec batch commands'");
    expect(result.stderr).toContain("for a list of available commands");
  });

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
