import { describe, it, expect } from "vitest";
import { Command } from "commander";
import {
  BatchCommandSchema,
  BatchInputSchema,
} from "../src/schema/batch.js";
import {
  parseBatchInput,
  validateBatchCommands,
  reportBatchValidationErrors,
  BatchParseError,
} from "../src/cli/batch-exec.js";
import { extractCommandTree } from "../src/cli/introspection.js";
import type { CommandMeta } from "../src/cli/introspection.js";

// ── Test Program ────────────────────────────────────────────────────
// Minimal Commander program that mirrors real CLI structure for testing.

function createTestProgram(): Command {
  const program = new Command("kspec");

  // task group with subcommands
  const task = program.command("task").description("Task management");
  task
    .command("add")
    .description("Add a task")
    .requiredOption("--title <title>", "Task title")
    .option("--spec-ref <ref>", "Spec reference")
    .option("--priority <n>", "Priority level")
    .argument("<ref>", "Parent reference");
  task
    .command("note")
    .description("Add a note to a task")
    .argument("<ref>", "Task reference")
    .argument("<content>", "Note content");
  task
    .command("start")
    .description("Start a task")
    .argument("<ref>", "Task reference");
  task
    .command("complete")
    .description("Complete a task")
    .argument("<ref>", "Task reference")
    .option("--reason <reason>", "Completion reason")
    .option("--force", "Force completion");

  // item group with subcommands
  const item = program.command("item").description("Spec item management");
  item
    .command("add")
    .description("Add a spec item")
    .requiredOption("--title <title>", "Item title")
    .option("--under <ref>", "Parent item")
    .option("--type <type>", "Item type");
  item
    .command("note")
    .description("Add note to an item")
    .argument("<ref>", "Item reference")
    .argument("<content>", "Note content");
  const itemAc = item.command("ac").description("Acceptance criteria management");
  itemAc
    .command("remove")
    .description("Remove an acceptance criterion")
    .argument("<ref>", "Item reference")
    .argument("<id>", "Acceptance criterion identifier")
    .option("--force", "Skip confirmation");

  // validate (leaf command, no subcommands)
  program
    .command("validate")
    .description("Validate spec files")
    .option("--strict", "Strict mode");

  return program;
}

function getTestTree(): CommandMeta {
  return extractCommandTree(createTestProgram());
}

// ── Schema Tests ────────────────────────────────────────────────────

describe("BatchCommandSchema", () => {
  it("accepts valid command object", () => {
    const result = BatchCommandSchema.parse({
      command: "task add",
      args: { title: "My Task" },
      id: "cmd-1",
    });
    expect(result.command).toBe("task add");
    expect(result.args).toEqual({ title: "My Task" });
    expect(result.id).toBe("cmd-1");
  });

  it("defaults args to empty object", () => {
    const result = BatchCommandSchema.parse({ command: "validate" });
    expect(result.args).toEqual({});
  });

  // AC: @batch-command-schema ac-id-field — id is optional
  it("accepts command without id", () => {
    const result = BatchCommandSchema.parse({
      command: "task start",
      args: { ref: "@my-task" },
    });
    expect(result.id).toBeUndefined();
  });

  it("rejects empty command string", () => {
    expect(() => BatchCommandSchema.parse({ command: "" })).toThrow();
  });

  it("rejects missing command field", () => {
    expect(() => BatchCommandSchema.parse({ args: {} })).toThrow();
  });
});

describe("BatchInputSchema", () => {
  it("accepts array of valid commands", () => {
    const result = BatchInputSchema.parse([
      { command: "task add", args: { title: "One" } },
      { command: "task add", args: { title: "Two" } },
    ]);
    expect(result).toHaveLength(2);
  });

  it("rejects empty array", () => {
    expect(() => BatchInputSchema.parse([])).toThrow(
      /at least one command/i,
    );
  });

  it("rejects non-array input", () => {
    expect(() => BatchInputSchema.parse({ command: "task add" })).toThrow();
  });
});

// ── Parse Tests ─────────────────────────────────────────────────────

describe("parseBatchInput", () => {
  it("parses inline JSON", async () => {
    const input = JSON.stringify([
      { command: "task start", args: { ref: "@my-task" } },
    ]);
    const result = await parseBatchInput({ type: "inline", json: input });
    expect(result).toHaveLength(1);
    expect(result[0].command).toBe("task start");
  });

  it("parses multiple commands from inline JSON", async () => {
    const input = JSON.stringify([
      { command: "task add", args: { title: "First" }, id: "a" },
      { command: "task add", args: { title: "Second" }, id: "b" },
    ]);
    const result = await parseBatchInput({ type: "inline", json: input });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  // AC: @batch-exec ac-invalid-json — invalid JSON throws with position info
  it("throws BatchParseError on invalid JSON with position info", async () => {
    await expect(
      parseBatchInput({ type: "inline", json: "{bad json" }),
    ).rejects.toThrow(BatchParseError);

    // Must include "Invalid JSON" label and position info from native parser
    await expect(
      parseBatchInput({ type: "inline", json: "{bad json" }),
    ).rejects.toThrow(/Invalid JSON.*position \d+/i);
  });

  // AC: @batch-exec ac-invalid-json — non-array valid JSON is rejected with schema error
  it("throws BatchParseError on valid JSON that is not an array", async () => {
    await expect(
      parseBatchInput({ type: "inline", json: '{"command":"test"}' }),
    ).rejects.toThrow(BatchParseError);
    await expect(
      parseBatchInput({ type: "inline", json: '{"command":"test"}' }),
    ).rejects.toThrow(/Expected array/);
  });

  // AC: parent ac-empty-batch — empty array rejected
  it("throws BatchParseError on empty array", async () => {
    await expect(
      parseBatchInput({ type: "inline", json: "[]" }),
    ).rejects.toThrow(BatchParseError);

    await expect(
      parseBatchInput({ type: "inline", json: "[]" }),
    ).rejects.toThrow(/at least one command/i);
  });

  it("throws BatchParseError when command field is missing", async () => {
    await expect(
      parseBatchInput({
        type: "inline",
        json: JSON.stringify([{ args: { title: "No command" } }]),
      }),
    ).rejects.toThrow(BatchParseError);
  });

  it("throws BatchParseError on non-existent file", async () => {
    await expect(
      parseBatchInput({ type: "file", path: "/nonexistent/file.json" }),
    ).rejects.toThrow(BatchParseError);

    await expect(
      parseBatchInput({ type: "file", path: "/nonexistent/file.json" }),
    ).rejects.toThrow(/Failed to read batch file/);
  });
});

// ── Validation Tests ────────────────────────────────────────────────

describe("validateBatchCommands", () => {
  const tree = getTestTree();

  // AC: @batch-command-schema ac-command-field
  describe("command path resolution", () => {
    it("accepts valid single-level command", () => {
      const result = validateBatchCommands(
        [{ command: "validate", args: {} }],
        tree,
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts valid multi-level command path", () => {
      const result = validateBatchCommands(
        [{ command: "task add", args: { title: "Test", ref: "@parent" } }],
        tree,
      );
      // May have missing required errors but not unknown_command errors
      const unknownErrs = result.errors.filter(
        (e) => e.type === "unknown_command",
      );
      expect(unknownErrs).toHaveLength(0);
    });

    it("accepts deeply nested command path", () => {
      const result = validateBatchCommands(
        [
          {
            command: "task note",
            args: { ref: "@task", content: "note text" },
          },
        ],
        tree,
      );
      const unknownErrs = result.errors.filter(
        (e) => e.type === "unknown_command",
      );
      expect(unknownErrs).toHaveLength(0);
    });

    it("rejects command group (non-leaf)", () => {
      const result = validateBatchCommands(
        [{ command: "task", args: {} }],
        tree,
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe("unknown_command");
      expect(result.errors[0].message).toContain("command group");
    });

    it("rejects with commandFilter", () => {
      const result = validateBatchCommands(
        [{ command: "validate", args: {} }],
        tree,
        {
          commandFilter: (cmd) => cmd.name !== "validate",
        },
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe("rejected_command");
      expect(result.errors[0].message).toContain("not allowed");
    });

    it("allows commands passing commandFilter", () => {
      const result = validateBatchCommands(
        [{ command: "validate", args: {} }],
        tree,
        {
          commandFilter: () => true,
        },
      );
      expect(result.valid).toBe(true);
    });
  });

  // AC: @batch-command-schema ac-args-mapping
  describe("argument mapping", () => {
    it("accepts kebab-case option names", () => {
      const result = validateBatchCommands(
        [
          {
            command: "task add",
            args: { title: "Test", ref: "@parent", "spec-ref": "@spec" },
          },
        ],
        tree,
      );
      const unknownArgErrs = result.errors.filter(
        (e) => e.type === "unknown_arg",
      );
      expect(unknownArgErrs).toHaveLength(0);
    });

    it("accepts camelCase option names", () => {
      const result = validateBatchCommands(
        [
          {
            command: "task add",
            args: { title: "Test", ref: "@parent", specRef: "@spec" },
          },
        ],
        tree,
      );
      const unknownArgErrs = result.errors.filter(
        (e) => e.type === "unknown_arg",
      );
      expect(unknownArgErrs).toHaveLength(0);
    });

    it("accepts underscore option names", () => {
      const result = validateBatchCommands(
        [
          {
            command: "task set",
            args: {
              ref: "@task-1",
              depends_on: ["@task-2"],
            },
          },
        ],
        tree,
      );
      const unknownArgErrs = result.errors.filter(
        (e) => e.type === "unknown_arg",
      );
      expect(unknownArgErrs).toHaveLength(0);
    });

    it("accepts positional args by name", () => {
      const result = validateBatchCommands(
        [{ command: "task start", args: { ref: "@my-task" } }],
        tree,
      );
      const unknownArgErrs = result.errors.filter(
        (e) => e.type === "unknown_arg",
      );
      expect(unknownArgErrs).toHaveLength(0);
    });

    // AC: @item-ac ac-item-ac-id-arg-consistency
    it("accepts id for item ac remove positional arg names", () => {
      const result = validateBatchCommands(
        [{ command: "item ac remove", args: { ref: "@item", id: "ac-1" } }],
        tree,
      );
      const unknownArgErrs = result.errors.filter(
        (e) => e.type === "unknown_arg",
      );
      expect(unknownArgErrs).toHaveLength(0);
      expect(result.valid).toBe(true);
    });

    it("rejects legacy acId for item ac remove with id suggestion", () => {
      const result = validateBatchCommands(
        [{ command: "item ac remove", args: { ref: "@item", acId: "ac-1" } }],
        tree,
      );
      const unknownArgErr = result.errors.find((e) => e.type === "unknown_arg");
      expect(unknownArgErr).toBeDefined();
      expect(unknownArgErr?.message).toContain('Unknown argument "acId"');
      expect(unknownArgErr?.suggestion).toBe("id");
    });

    it("flags unknown args with suggestion", () => {
      const result = validateBatchCommands(
        [
          {
            command: "task add",
            args: { title: "Test", ref: "@parent", tittle: "typo" },
          },
        ],
        tree,
      );
      const unknownArgErrs = result.errors.filter(
        (e) => e.type === "unknown_arg",
      );
      expect(unknownArgErrs).toHaveLength(1);
      expect(unknownArgErrs[0].message).toContain("tittle");
      expect(unknownArgErrs[0].suggestion).toBe("title");
    });
  });

  // AC: @batch-command-schema ac-unknown-command
  describe("unknown command handling", () => {
    it("reports unknown command with index", () => {
      const result = validateBatchCommands(
        [{ command: "taks add", args: {} }],
        tree,
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe("unknown_command");
      expect(result.errors[0].index).toBe(0);
      expect(result.errors[0].command).toBe("taks add");
    });

    it("suggests closest valid command", () => {
      const result = validateBatchCommands(
        [{ command: "task ad", args: {} }],
        tree,
      );
      expect(result.errors[0].type).toBe("unknown_command");
      expect(result.errors[0].suggestion).toBe("task add");
    });

    it("handles completely invalid command with no suggestion", () => {
      const result = validateBatchCommands(
        [{ command: "zzzzzzzzzzzzzzz", args: {} }],
        tree,
      );
      expect(result.errors[0].type).toBe("unknown_command");
      expect(result.errors[0].suggestion).toBeUndefined();
    });
  });

  // AC: @batch-command-schema ac-missing-required
  describe("missing required args", () => {
    it("detects missing required option", () => {
      const result = validateBatchCommands(
        [{ command: "task add", args: { ref: "@parent" } }],
        tree,
      );
      const missingErrs = result.errors.filter(
        (e) => e.type === "missing_required",
      );
      expect(missingErrs.length).toBeGreaterThanOrEqual(1);
      const titleErr = missingErrs.find((e) => e.message.includes("title"));
      expect(titleErr).toBeDefined();
    });

    it("detects missing required positional arg", () => {
      const result = validateBatchCommands(
        [{ command: "task start", args: {} }],
        tree,
      );
      const missingErrs = result.errors.filter(
        (e) => e.type === "missing_required",
      );
      expect(missingErrs.length).toBeGreaterThanOrEqual(1);
      expect(missingErrs[0].message).toContain("ref");
    });

    it("identifies missing args by name", () => {
      const result = validateBatchCommands(
        [{ command: "task note", args: {} }],
        tree,
      );
      const missingErrs = result.errors.filter(
        (e) => e.type === "missing_required",
      );
      const names = missingErrs.map((e) => e.message);
      expect(names.some((m) => m.includes("ref"))).toBe(true);
      expect(names.some((m) => m.includes("content"))).toBe(true);
    });

    it("passes when all required args are present", () => {
      const result = validateBatchCommands(
        [
          {
            command: "task add",
            args: { title: "Test", ref: "@parent" },
          },
        ],
        tree,
      );
      const missingErrs = result.errors.filter(
        (e) => e.type === "missing_required",
      );
      expect(missingErrs).toHaveLength(0);
    });
  });

  // AC: @batch-command-schema ac-id-field
  describe("id field handling", () => {
    it("preserves id in validation errors", () => {
      const result = validateBatchCommands(
        [{ command: "nonexistent", args: {}, id: "my-cmd-1" }],
        tree,
      );
      expect(result.errors[0].id).toBe("my-cmd-1");
    });

    it("uses index when id is absent", () => {
      const result = validateBatchCommands(
        [{ command: "nonexistent", args: {} }],
        tree,
      );
      expect(result.errors[0].index).toBe(0);
      expect(result.errors[0].id).toBeUndefined();
    });

    it("tracks correct index in multi-command batch", () => {
      const result = validateBatchCommands(
        [
          { command: "validate", args: {} },
          { command: "nonexistent", args: {}, id: "bad-one" },
          { command: "task start", args: { ref: "@t" } },
        ],
        tree,
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].index).toBe(1);
      expect(result.errors[0].id).toBe("bad-one");
    });
  });

  describe("mixed errors", () => {
    it("collects multiple error types from a single batch", () => {
      const result = validateBatchCommands(
        [
          { command: "nonexistent", args: {} },
          { command: "task add", args: {} },
          {
            command: "task start",
            args: { ref: "@t", bogus: true },
          },
        ],
        tree,
      );
      expect(result.valid).toBe(false);
      const types = result.errors.map((e) => e.type);
      expect(types).toContain("unknown_command");
      expect(types).toContain("missing_required");
      expect(types).toContain("unknown_arg");
    });
  });
});

// ── Error Reporting Tests ───────────────────────────────────────────

describe("reportBatchValidationErrors", () => {
  it("returns empty string for valid result", () => {
    const output = reportBatchValidationErrors({
      valid: true,
      commands: [],
      errors: [],
    });
    expect(output).toBe("");
  });

  it("formats human-readable errors with index", () => {
    const output = reportBatchValidationErrors({
      valid: false,
      commands: [],
      errors: [
        {
          index: 0,
          command: "taks add",
          type: "unknown_command",
          message: 'Unknown command: "taks add"',
          suggestion: "task add",
        },
      ],
    });
    expect(output).toContain("[#0]");
    expect(output).toContain("Unknown command");
    expect(output).toContain("Did you mean: task add?");
  });

  it("includes 'kspec batch commands' hint in human-readable errors", () => {
    const output = reportBatchValidationErrors({
      valid: false,
      commands: [],
      errors: [
        {
          index: 0,
          command: "unknown cmd",
          type: "unknown_command",
          message: 'Unknown command: "unknown cmd"',
        },
      ],
    });
    expect(output).toContain("Run 'kspec batch commands'");
    expect(output).toContain("for a list of available commands");
  });

  it("formats human-readable errors with id when present", () => {
    const output = reportBatchValidationErrors({
      valid: false,
      commands: [],
      errors: [
        {
          index: 0,
          id: "my-cmd",
          command: "taks add",
          type: "unknown_command",
          message: 'Unknown command: "taks add"',
        },
      ],
    });
    expect(output).toContain("[my-cmd]");
    expect(output).not.toContain("[#0]");
  });

  it("produces valid JSON in json mode", () => {
    const output = reportBatchValidationErrors(
      {
        valid: false,
        commands: [],
        errors: [
          {
            index: 0,
            command: "bad",
            type: "unknown_command",
            message: "Unknown command",
          },
        ],
      },
      true,
    );
    const parsed = JSON.parse(output);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].type).toBe("unknown_command");
  });

  it("does not include hint text in JSON mode", () => {
    const output = reportBatchValidationErrors(
      {
        valid: false,
        commands: [],
        errors: [
          {
            index: 0,
            command: "bad",
            type: "unknown_command",
            message: "Unknown command",
          },
        ],
      },
      true,
    );
    expect(output).not.toContain("kspec batch commands");
  });

  it("returns valid JSON for valid result in json mode", () => {
    const output = reportBatchValidationErrors(
      { valid: true, commands: [], errors: [] },
      true,
    );
    const parsed = JSON.parse(output);
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toHaveLength(0);
  });
});
