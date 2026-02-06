import { describe, it, expect } from "vitest";
import { Command } from "commander";
import {
  markMutating,
  getAnnotation,
  createBatchCommandFilter,
} from "../src/cli/command-annotations.js";
import { extractCommandTree } from "../src/cli/introspection.js";
import type { CommandMeta } from "../src/cli/introspection.js";
import { validateBatchCommands } from "../src/cli/batch-exec.js";

// ── Test Program ────────────────────────────────────────────────────
// Minimal annotated Commander program for isolated testing.

function createAnnotatedTestProgram(): Command {
  const program = new Command("kspec");

  // task group with mixed mutating/read-only subcommands
  const task = program.command("task").description("Task management");
  markMutating(task.command("add"))
    .description("Add a task")
    .requiredOption("--title <title>", "Task title");
  task.command("list").description("List tasks"); // read-only
  markMutating(task.command("start"))
    .description("Start a task")
    .argument("<ref>", "Task reference");

  // mutating leaf command
  markMutating(program.command("derive [ref]")).description(
    "Derive task from spec",
  );

  // read-only leaf command
  program.command("search <pattern>").description("Search for items");

  // batch command for nested-batch test
  program.command("batch").description("Batch execute commands");

  return program;
}

function getAnnotatedTree(): CommandMeta {
  return extractCommandTree(createAnnotatedTestProgram());
}

// ── Annotation Registry Tests ───────────────────────────────────────

describe("command-annotations", () => {
  it("markMutating returns the same Command instance (chaining)", () => {
    const cmd = new Command("test");
    const result = markMutating(cmd);
    expect(result).toBe(cmd);
  });

  it("getAnnotation returns mutating: true for annotated commands", () => {
    const cmd = new Command("test");
    markMutating(cmd);
    expect(getAnnotation(cmd)).toEqual({ mutating: true });
  });

  it("getAnnotation returns undefined for unannotated commands", () => {
    const cmd = new Command("test");
    expect(getAnnotation(cmd)).toBeUndefined();
  });

  it("default annotation is read-only (mutating: false in CommandMeta)", () => {
    const tree = getAnnotatedTree();
    const search = tree.subcommands.find((c) => c.name === "search");
    expect(search).toBeDefined();
    expect(search!.mutating).toBe(false);
  });
});

// ── CommandMeta.mutating Tests ──────────────────────────────────────

describe("CommandMeta.mutating via extractCommandTree", () => {
  const tree = getAnnotatedTree();

  it("annotated leaf command has mutating: true", () => {
    const derive = tree.subcommands.find((c) => c.name === "derive");
    expect(derive).toBeDefined();
    expect(derive!.mutating).toBe(true);
  });

  it("annotated nested command has mutating: true", () => {
    const task = tree.subcommands.find((c) => c.name === "task");
    const add = task!.subcommands.find((c) => c.name === "add");
    expect(add).toBeDefined();
    expect(add!.mutating).toBe(true);
  });

  it("unannotated leaf command has mutating: false", () => {
    const search = tree.subcommands.find((c) => c.name === "search");
    expect(search!.mutating).toBe(false);
  });

  it("unannotated nested command has mutating: false", () => {
    const task = tree.subcommands.find((c) => c.name === "task");
    const list = task!.subcommands.find((c) => c.name === "list");
    expect(list!.mutating).toBe(false);
  });

  it("command group itself has mutating: false", () => {
    const task = tree.subcommands.find((c) => c.name === "task");
    expect(task!.mutating).toBe(false);
  });
});

// ── AC: ac-allowlist ────────────────────────────────────────────────

describe("ac-allowlist: mutating commands accepted in batch", () => {
  const tree = getAnnotatedTree();
  const filter = createBatchCommandFilter();

  it("mutating leaf command passes filter", () => {
    const result = validateBatchCommands(
      [{ command: "derive", args: { ref: "@spec" } }],
      tree,
      { commandFilter: filter },
    );
    const rejected = result.errors.filter(
      (e) => e.type === "rejected_command",
    );
    expect(rejected).toHaveLength(0);
  });

  it("mutating nested command passes filter", () => {
    const result = validateBatchCommands(
      [{ command: "task add", args: { title: "Test" } }],
      tree,
      { commandFilter: filter },
    );
    const rejected = result.errors.filter(
      (e) => e.type === "rejected_command",
    );
    expect(rejected).toHaveLength(0);
  });

  it("batch with all mutating commands validates cleanly", () => {
    const result = validateBatchCommands(
      [
        { command: "task add", args: { title: "One" } },
        { command: "task start", args: { ref: "@t" } },
        { command: "derive", args: { ref: "@s" } },
      ],
      tree,
      { commandFilter: filter },
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("createBatchCommandFilter accepts commands with mutating: true", () => {
    const filterFn = createBatchCommandFilter();
    const meta: CommandMeta = {
      name: "add",
      fullPath: ["kspec", "task", "add"],
      description: "",
      aliases: [],
      arguments: [],
      options: [],
      subcommands: [],
      hidden: false,
      mutating: true,
    };
    expect(filterFn(meta)).toBe(true);
  });
});

// ── AC: ac-denylist ─────────────────────────────────────────────────

describe("ac-denylist: read-only commands rejected in batch", () => {
  const tree = getAnnotatedTree();
  const filter = createBatchCommandFilter();

  it("read-only leaf command is rejected", () => {
    const result = validateBatchCommands(
      [{ command: "search", args: { pattern: "test" } }],
      tree,
      { commandFilter: filter },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("rejected_command");
  });

  it("read-only nested command is rejected", () => {
    const result = validateBatchCommands(
      [{ command: "task list", args: {} }],
      tree,
      { commandFilter: filter },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].type).toBe("rejected_command");
  });

  it("rejection message explains batch is for mutating operations", () => {
    const result = validateBatchCommands(
      [{ command: "search", args: { pattern: "test" } }],
      tree,
      { commandFilter: filter },
    );
    expect(result.errors[0].message).toContain("mutating");
    expect(result.errors[0].message).toContain("not allowed in batch");
  });

  it("createBatchCommandFilter rejects commands with mutating: false", () => {
    const filterFn = createBatchCommandFilter();
    const meta: CommandMeta = {
      name: "list",
      fullPath: ["kspec", "task", "list"],
      description: "",
      aliases: [],
      arguments: [],
      options: [],
      subcommands: [],
      hidden: false,
      mutating: false,
    };
    expect(filterFn(meta)).toBe(false);
  });
});

// ── AC: ac-batch-itself ─────────────────────────────────────────────

describe("ac-batch-itself: nested batch commands rejected", () => {
  const tree = getAnnotatedTree();
  const filter = createBatchCommandFilter();

  it("batch command is rejected with specific message", () => {
    const result = validateBatchCommands(
      [{ command: "batch", args: {} }],
      tree,
      { commandFilter: filter },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("rejected_command");
    expect(result.errors[0].message).toBe(
      "Nested batch commands are not allowed",
    );
  });

  it("nested batch rejection is distinct from read-only rejection", () => {
    const result = validateBatchCommands(
      [
        { command: "batch", args: {}, id: "nested" },
        { command: "search", args: { pattern: "x" }, id: "readonly" },
      ],
      tree,
      { commandFilter: filter },
    );
    expect(result.errors).toHaveLength(2);

    const nestedErr = result.errors.find((e) => e.id === "nested");
    const readonlyErr = result.errors.find((e) => e.id === "readonly");

    expect(nestedErr!.message).toBe("Nested batch commands are not allowed");
    expect(readonlyErr!.message).toContain("mutating");
    expect(nestedErr!.message).not.toEqual(readonlyErr!.message);
  });

  it("nested batch rejection happens before commandFilter check", () => {
    // Even without a filter, batch should be rejected
    const result = validateBatchCommands(
      [{ command: "batch", args: {} }],
      tree,
      // No commandFilter — batch rejection is unconditional
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].type).toBe("rejected_command");
    expect(result.errors[0].message).toBe(
      "Nested batch commands are not allowed",
    );
  });
});

// ── Integration Tests ───────────────────────────────────────────────

describe("batch-allowed-commands integration", () => {
  const tree = getAnnotatedTree();
  const filter = createBatchCommandFilter();

  it("mixed batch: only read-only and nested-batch rejected", () => {
    const result = validateBatchCommands(
      [
        { command: "task add", args: { title: "OK" }, id: "mutating-1" },
        { command: "task list", args: {}, id: "readonly-1" },
        { command: "derive", args: { ref: "@s" }, id: "mutating-2" },
        { command: "batch", args: {}, id: "nested-batch" },
        { command: "search", args: { pattern: "x" }, id: "readonly-2" },
      ],
      tree,
      { commandFilter: filter },
    );
    expect(result.valid).toBe(false);
    // 3 errors: readonly-1, nested-batch, readonly-2
    expect(result.errors).toHaveLength(3);

    const errorIds = result.errors.map((e) => e.id);
    expect(errorIds).toContain("readonly-1");
    expect(errorIds).toContain("nested-batch");
    expect(errorIds).toContain("readonly-2");

    // mutating commands are NOT in errors
    expect(errorIds).not.toContain("mutating-1");
    expect(errorIds).not.toContain("mutating-2");
  });

  it("mixed batch produces distinct error messages for each rejection type", () => {
    const result = validateBatchCommands(
      [
        { command: "batch", args: {}, id: "nested" },
        { command: "task list", args: {}, id: "readonly" },
      ],
      tree,
      { commandFilter: filter },
    );

    const messages = result.errors.map((e) => e.message);
    // Nested batch has its own message
    expect(messages).toContain("Nested batch commands are not allowed");
    // Read-only has the mutating explanation
    expect(messages.some((m) => m.includes("mutating"))).toBe(true);
  });
});
