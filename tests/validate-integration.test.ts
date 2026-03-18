/**
 * Validate integration tests for hook, schedule, and composition rules.
 *
 * Covers:
 * - @dispatch-hook-schema ac-3 — hook agent ref → error
 * - @dispatch-hook-filter ac-3 — unknown filter field → warning
 * - @dispatch-schedule-schema ac-3 — schedule agent ref → error
 * - @dispatch-action-model ac-7 — unknown template variable → warning
 *
 * Task: @task-validate-integration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify } from "yaml";
import {
  testUlid,
  setupTempFixtures,
  cleanupTempDir,
  kspec as kspecRun,
} from "./helpers/cli.js";

describe("Validate integration: hook/schedule/composition rules", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ─── Hook Agent Ref Validation ──────────────────────────────────────────────

  // AC: @dispatch-hook-schema ac-3
  describe("hook agent ref validation", () => {
    it("should error when hook agent action references non-existent agent", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [
            {
              _ulid: testUlid("AGNT", 1),
              id: "existing-agent",
              name: "Existing Agent",
            },
          ],
          hooks: [
            {
              _ulid: testUlid("HOOK", 1),
              name: "ghost-hook",
              on: "task.ready",
              action: {
                type: "agent",
                agent_id: "ghost-agent",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("ghost-agent");
      expect(combined).toContain("non-existent agent");
      expect(result.exitCode).not.toBe(0);
    });

    it("should pass when hook agent action references existing agent", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [
            {
              _ulid: testUlid("AGNT", 2),
              id: "real-worker",
              name: "Real Worker",
            },
          ],
          hooks: [
            {
              _ulid: testUlid("HOOK", 2),
              name: "valid-hook",
              on: "task.ready",
              action: {
                type: "agent",
                agent_id: "real-worker",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain("non-existent agent");
    });
  });

  // ─── Hook Filter Field Validation ──────────────────────────────────────────

  // AC: @dispatch-hook-filter ac-3
  describe("hook filter field validation", () => {
    it("should warn on unknown filter field", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [],
          hooks: [
            {
              _ulid: testUlid("HOOK", 10),
              name: "bad-filter-hook",
              on: "task.ready",
              filter: { nonexistent_field: "value" },
              action: { type: "command", command: "echo", args: ["test"] },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("nonexistent_field");
      expect(combined).toContain("unknown field");
    });

    it("should not warn on known envelope and payload fields", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [],
          hooks: [
            {
              _ulid: testUlid("HOOK", 11),
              name: "valid-filter-hook",
              on: "task.ready",
              filter: { source_type: "task_watcher", task_title: "My Task" },
              action: { type: "command", command: "echo", args: ["test"] },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain("unknown field");
    });
  });

  // ─── Schedule Agent Ref Validation ──────────────────────────────────────────

  // AC: @dispatch-schedule-schema ac-3
  describe("schedule agent ref validation", () => {
    it("should error when schedule agent action references non-existent agent", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [
            {
              _ulid: testUlid("AGNT", 3),
              id: "real-agent",
              name: "Real Agent",
            },
          ],
          schedules: [
            {
              _ulid: testUlid("SCHD", 1),
              id: "ghost-schedule",
              name: "Ghost Schedule",
              cron: "*/5 * * * *",
              action: {
                type: "agent",
                agent_id: "missing-agent",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("missing-agent");
      expect(combined).toContain("non-existent agent");
      expect(result.exitCode).not.toBe(0);
    });

    it("should pass when schedule agent action references existing agent", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [
            {
              _ulid: testUlid("AGNT", 4),
              id: "scheduled-worker",
              name: "Scheduled Worker",
            },
          ],
          schedules: [
            {
              _ulid: testUlid("SCHD", 2),
              id: "valid-schedule",
              name: "Valid Schedule",
              cron: "0 9 * * 1-5",
              action: {
                type: "agent",
                agent_id: "scheduled-worker",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain("non-existent agent");
    });
  });

  // ─── Composition Agent Ref Validation ───────────────────────────────────────

  describe("composition agent ref validation", () => {
    it("should error when composition on_complete references non-existent agent", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [
            {
              _ulid: testUlid("AGNT", 5),
              id: "known-agent",
              name: "Known Agent",
            },
          ],
          compositions: [
            {
              _ulid: testUlid("COMP", 1),
              id: "bad-comp",
              name: "Bad Composition",
              join_count: 3,
              on_complete: {
                type: "agent",
                agent_id: "phantom-agent",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("phantom-agent");
      expect(combined).toContain("non-existent agent");
      expect(result.exitCode).not.toBe(0);
    });

    it("should pass when composition on_complete references existing agent", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [
            {
              _ulid: testUlid("AGNT", 6),
              id: "comp-handler",
              name: "Composition Handler",
            },
          ],
          compositions: [
            {
              _ulid: testUlid("COMP", 2),
              id: "good-comp",
              name: "Good Composition",
              join_count: 2,
              on_complete: {
                type: "agent",
                agent_id: "comp-handler",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain("non-existent agent");
    });

    it("should not check agent refs for non-agent action types in compositions", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [],
          compositions: [
            {
              _ulid: testUlid("COMP", 3),
              id: "cmd-comp",
              name: "Command Composition",
              join_count: 2,
              on_complete: {
                type: "command",
                command: "echo",
                args: ["done"],
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain("non-existent agent");
    });
  });

  // ─── Template Variable Validation ───────────────────────────────────────────

  // AC: @dispatch-action-model ac-7
  describe("template variable validation", () => {
    it("should warn on unknown template variable in hook action", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [],
          hooks: [
            {
              _ulid: testUlid("HOOK", 20),
              name: "template-hook",
              on: "task.ready",
              action: {
                type: "notify",
                message: "Task {{task_title}} by {{nonexistent_var}}",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("nonexistent_var");
      expect(combined).toContain("unknown variable");
    });

    it("should not warn on known template variables for the event type", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [],
          hooks: [
            {
              _ulid: testUlid("HOOK", 21),
              name: "valid-template-hook",
              on: "task.ready",
              action: {
                type: "notify",
                message: "Task {{task_title}} ref={{task_ref}}",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain("unknown variable");
    });

    it("should warn on unknown template variable in schedule action", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [],
          schedules: [
            {
              _ulid: testUlid("SCHD", 10),
              id: "template-schedule",
              name: "Template Schedule",
              cron: "0 * * * *",
              action: {
                type: "notify",
                message: "Tick from {{schedule_name}} with {{bad_field}}",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("bad_field");
      expect(combined).toContain("unknown variable");
    });

    it("should warn on unknown template variable in composition on_complete", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [],
          compositions: [
            {
              _ulid: testUlid("COMP", 10),
              id: "template-comp",
              name: "Template Composition",
              join_count: 2,
              on_complete: {
                type: "notify",
                message: "Completed with {{unknown_field}}",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("unknown_field");
      expect(combined).toContain("unknown variable");
    });

    it("should warn on unknown template variable in agent prompt_template", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [
            {
              _ulid: testUlid("AGNT", 10),
              id: "tmpl-agent",
              name: "Template Agent",
            },
          ],
          hooks: [
            {
              _ulid: testUlid("HOOK", 22),
              name: "agent-template-hook",
              on: "task.ready",
              action: {
                type: "agent",
                agent_id: "tmpl-agent",
                prompt_template: "Work on {{task_ref}} with {{imaginary_field}}",
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("imaginary_field");
      expect(combined).toContain("unknown variable");
    });

    it("should not warn on actions without template variables", async () => {
      const metaPath = path.join(tempDir, "kynetic.meta.yaml");
      await fs.writeFile(
        metaPath,
        stringify({
          kynetic_meta: "1.0",
          agents: [],
          hooks: [
            {
              _ulid: testUlid("HOOK", 23),
              name: "no-template-hook",
              on: "task.ready",
              action: {
                type: "command",
                command: "echo",
                args: ["hello"],
              },
            },
          ],
        }),
      );

      const result = kspecRun(["validate"], tempDir);
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain("unknown variable");
    });
  });
});

// ─── Unit tests for validation functions ─────────────────────────────────────

describe("Template variable validation", () => {
  // AC: @dispatch-action-model ac-7
  it("extractActionTemplates collects all template strings from actions", async () => {
    const { extractActionTemplates } = await import(
      "../src/agent-runtime/action-executor.js"
    );

    // Command action
    const cmdTemplates = extractActionTemplates({
      type: "command" as const,
      command: "echo",
      args: ["{{task_ref}}", "{{task_title}}"],
      shell: false,
    });
    expect(cmdTemplates).toContain("echo");
    expect(cmdTemplates).toContain("{{task_ref}}");
    expect(cmdTemplates).toContain("{{task_title}}");

    // Agent action with prompt_template
    const agentTemplates = extractActionTemplates({
      type: "agent" as const,
      agent_id: "worker",
      prompt_template: "Do {{task_ref}}",
    });
    expect(agentTemplates).toContain("Do {{task_ref}}");

    // Notify action
    const notifyTemplates = extractActionTemplates({
      type: "notify" as const,
      message: "Alert: {{event_type}}",
      topic: "automation",
    });
    expect(notifyTemplates).toContain("Alert: {{event_type}}");
  });

  // AC: @dispatch-action-model ac-7
  it("validateActionTemplates warns on unknown variables for event type", async () => {
    const { validateActionTemplates } = await import(
      "../src/agent-runtime/action-executor.js"
    );

    const warnings = validateActionTemplates(
      ["Hello {{task_title}} {{unknown_var}}"],
      "task.ready",
    );

    // Should warn about unknown_var but not task_title
    expect(warnings).toHaveLength(1);
    expect(warnings[0].variable).toBe("unknown_var");
    expect(warnings[0].available_fields).toContain("task_title");
  });

  // AC: @dispatch-action-model ac-7
  it("validateActionTemplates returns no warnings for known variables", async () => {
    const { validateActionTemplates } = await import(
      "../src/agent-runtime/action-executor.js"
    );

    const warnings = validateActionTemplates(
      ["{{task_ref}} {{event_type}} {{source_type}}"],
      "task.ready",
    );

    expect(warnings).toHaveLength(0);
  });
});
