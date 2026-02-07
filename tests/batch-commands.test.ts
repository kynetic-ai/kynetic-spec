/**
 * Tests for `kspec batch commands` subcommand
 *
 * Verifies the discoverability feature that lists all commands
 * allowed in batch mode with their signatures and metadata.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir } from "./helpers/cli.js";

describe("batch commands", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await setupTempFixtures();
  });

  afterAll(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("human-readable output", () => {
    it("lists allowed commands with header", () => {
      const result = kspec("batch commands", tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Batch-Allowed Commands");
      expect(result.stdout).toContain("Only mutating commands can be used in batch mode");
    });

    it("includes command signatures with arguments", () => {
      const result = kspec("batch commands", tempDir);
      expect(result.stdout).toContain("task add");
      expect(result.stdout).toContain("inbox add <text>");
      expect(result.stdout).toContain("[options]");
    });

    it("includes command descriptions", () => {
      const result = kspec("batch commands", tempDir);
      expect(result.stdout).toContain("Create a new task");
      expect(result.stdout).toContain("Capture an idea quickly");
    });

    it("shows total count of allowed commands", () => {
      const result = kspec("batch commands", tempDir);
      // Match pattern like "53 command(s) available"
      expect(result.stdout).toMatch(/\d+ command\(s\) available/);
    });

    it("excludes read-only commands", () => {
      const result = kspec("batch commands", tempDir);
      // These are read-only commands that should NOT appear
      expect(result.stdout).not.toContain("task list");
      expect(result.stdout).not.toContain("task get");
      expect(result.stdout).not.toContain("session show");
      expect(result.stdout).not.toContain("validate");
    });

    it("excludes batch command itself", () => {
      const result = kspec("batch commands", tempDir);
      // Should not list 'batch' or 'batch commands'
      const lines = result.stdout.split("\n");
      const batchLines = lines.filter(
        (l) => l.trim().startsWith("batch ") && !l.includes("Batch-Allowed")
      );
      expect(batchLines).toHaveLength(0);
    });
  });

  describe("JSON output", () => {
    interface CommandInfo {
      command: string;
      signature: string;
      description: string;
      mutating: boolean;
      arguments: Array<{
        name: string;
        required: boolean;
        variadic: boolean;
      }>;
      options: Array<{
        flags: string;
        required: boolean;
      }>;
    }

    interface BatchCommandsOutput {
      commands: CommandInfo[];
      total: number;
    }

    it("returns structured command list", () => {
      const result = kspecJson<BatchCommandsOutput>("batch commands", tempDir);
      expect(result).toHaveProperty("commands");
      expect(result).toHaveProperty("total");
      expect(Array.isArray(result.commands)).toBe(true);
      expect(result.total).toBe(result.commands.length);
    });

    it("includes command paths without kspec prefix", () => {
      const result = kspecJson<BatchCommandsOutput>("batch commands", tempDir);
      const taskAdd = result.commands.find((c) => c.command === "task add");
      expect(taskAdd).toBeDefined();
      expect(taskAdd!.command).toBe("task add");
      expect(taskAdd!.command).not.toContain("kspec");
    });

    it("includes signature with arguments", () => {
      const result = kspecJson<BatchCommandsOutput>("batch commands", tempDir);
      const inboxAdd = result.commands.find((c) => c.command === "inbox add");
      expect(inboxAdd).toBeDefined();
      expect(inboxAdd!.signature).toContain("<text>");
    });

    it("marks all commands as mutating: true", () => {
      const result = kspecJson<BatchCommandsOutput>("batch commands", tempDir);
      for (const cmd of result.commands) {
        expect(cmd.mutating).toBe(true);
      }
    });

    it("includes argument metadata", () => {
      const result = kspecJson<BatchCommandsOutput>("batch commands", tempDir);
      const taskStart = result.commands.find((c) => c.command === "task start");
      expect(taskStart).toBeDefined();
      expect(taskStart!.arguments.length).toBeGreaterThan(0);
      const refArg = taskStart!.arguments.find((a) => a.name === "ref");
      expect(refArg).toBeDefined();
      expect(refArg!.required).toBe(true);
    });

    it("includes option metadata", () => {
      const result = kspecJson<BatchCommandsOutput>("batch commands", tempDir);
      const taskAdd = result.commands.find((c) => c.command === "task add");
      expect(taskAdd).toBeDefined();
      expect(taskAdd!.options.length).toBeGreaterThan(0);
      const titleOpt = taskAdd!.options.find((o) => o.flags.includes("--title"));
      expect(titleOpt).toBeDefined();
      expect(titleOpt!.required).toBe(true);
    });

    it("excludes read-only commands from JSON output", () => {
      const result = kspecJson<BatchCommandsOutput>("batch commands", tempDir);
      const readOnlyCommands = ["task list", "task get", "session show", "validate"];
      for (const readOnly of readOnlyCommands) {
        const found = result.commands.find((c) => c.command === readOnly);
        expect(found).toBeUndefined();
      }
    });
  });

  describe("backwards compatibility", () => {
    it("batch exec still works with stdin", () => {
      // Dry-run a valid mutating command
      const result = kspec(
        'batch --dry-run --commands \'[{"command":"inbox add","args":{"text":"test"}}]\'',
        tempDir
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("succeeded");
    });

    it("batch --help shows commands subcommand", () => {
      const result = kspec("batch --help", tempDir);
      expect(result.stdout).toContain("commands");
      expect(result.stdout).toContain("list allowed commands");
    });
  });
});
