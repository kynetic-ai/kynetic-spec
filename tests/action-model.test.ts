/**
 * Action Model Tests
 *
 * Tests the shared action model: schemas, ActionExecutor, template interpolation,
 * action run tracking, and event emission for all four action types.
 *
 * AC: @dispatch-action-model ac-1 through ac-9
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  ActionSchema,
  CommandActionSchema,
  KspecActionSchema,
  AgentActionSchema,
  NotifyActionSchema,
  ActionRunSchema,
  ActionRunStatusSchema,
  TEMPLATE_VAR_PATTERN,
  type Action,
  type ActionRun,
} from "../src/schema/action.js";
import {
  ActionExecutor,
  resolveTemplateVars,
  extractTemplateVars,
  validateActionTemplates,
  extractActionTemplates,
  KNOWN_EVENT_FIELDS,
  type ActionEventContext,
  type ActionRunEvent,
} from "../src/agent-runtime/action-executor.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeEventContext(overrides: Partial<ActionEventContext> = {}): ActionEventContext {
  return {
    event_id: "01TEST00000000000000000001",
    event_type: "task.ready",
    correlation_id: "01CORR000000000000000000001",
    causation_id: "01CAUSE0000000000000000001",
    source_type: "task_watcher",
    source_id: "watcher-1",
    task_ref: "@task-foo",
    task_title: "Foo Task",
    ...overrides,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "action-model-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ─── Schema Tests ────────────────────────────────────────────────────────────

describe("Action Schemas", () => {
  describe("CommandActionSchema", () => {
    it("parses a minimal command action", () => {
      const result = CommandActionSchema.safeParse({
        type: "command",
        command: "echo",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("command");
        expect(result.data.command).toBe("echo");
        expect(result.data.args).toEqual([]);
      }
    });

    it("parses a full command action with all fields", () => {
      const result = CommandActionSchema.safeParse({
        type: "command",
        command: "npm",
        args: ["test"],
        timeout_ms: 30000,
        cwd: "/tmp",
        env: { NODE_ENV: "test" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout_ms).toBe(30000);
        expect(result.data.cwd).toBe("/tmp");
        expect(result.data.env).toEqual({ NODE_ENV: "test" });
      }
    });

    it("rejects missing command", () => {
      const result = CommandActionSchema.safeParse({
        type: "command",
        command: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("KspecActionSchema", () => {
    it("parses a kspec action", () => {
      const result = KspecActionSchema.safeParse({
        type: "kspec",
        command: "task list --json",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("kspec");
        expect(result.data.command).toBe("task list --json");
      }
    });
  });

  describe("AgentActionSchema", () => {
    it("parses an agent action", () => {
      const result = AgentActionSchema.safeParse({
        type: "agent",
        agent_id: "task-worker",
        prompt: "Work on {{task_ref}}",
        task_ref: "@task-foo",
        timeout_minutes: 30,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agent_id).toBe("task-worker");
        expect(result.data.task_ref).toBe("@task-foo");
      }
    });
  });

  describe("NotifyActionSchema", () => {
    it("parses a notify action with defaults", () => {
      const result = NotifyActionSchema.safeParse({
        type: "notify",
        message: "Task {{task_ref}} is ready",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.topic).toBe("automation");
      }
    });

    it("parses a notify action with custom topic", () => {
      const result = NotifyActionSchema.safeParse({
        type: "notify",
        message: "Alert!",
        topic: "alerts",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.topic).toBe("alerts");
      }
    });
  });

  describe("ActionSchema (discriminated union)", () => {
    it("discriminates by type field", () => {
      const command = ActionSchema.parse({
        type: "command",
        command: "echo hello",
      });
      expect(command.type).toBe("command");

      const kspec = ActionSchema.parse({
        type: "kspec",
        command: "task list",
      });
      expect(kspec.type).toBe("kspec");

      const agent = ActionSchema.parse({
        type: "agent",
        agent_id: "worker",
      });
      expect(agent.type).toBe("agent");

      const notify = ActionSchema.parse({
        type: "notify",
        message: "hello",
      });
      expect(notify.type).toBe("notify");
    });

    it("rejects unknown action type", () => {
      const result = ActionSchema.safeParse({
        type: "unknown",
        command: "foo",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ActionRunSchema", () => {
    it("parses a running action run", () => {
      const result = ActionRunSchema.safeParse({
        action_run_id: "01TESTACT000000000000000A1",
        action_type: "command",
        status: "running",
        started_at: "2026-03-18T00:00:00.000Z",
      });
      expect(result.success).toBe(true);
    });

    it("parses a completed action run with all fields", () => {
      const result = ActionRunSchema.safeParse({
        action_run_id: "01TESTACT000000000000000A2",
        action_type: "agent",
        status: "completed",
        started_at: "2026-03-18T00:00:00.000Z",
        completed_at: "2026-03-18T00:01:00.000Z",
        duration_ms: 60000,
        invocation_id: "session-123",
        source_name: "my-hook",
        source_event_type: "task.ready",
      });
      expect(result.success).toBe(true);
    });

    it("parses a failed action run with error details", () => {
      const result = ActionRunSchema.safeParse({
        action_run_id: "01TESTACT000000000000000A3",
        action_type: "command",
        status: "failed",
        started_at: "2026-03-18T00:00:00.000Z",
        completed_at: "2026-03-18T00:00:05.000Z",
        duration_ms: 5000,
        pid: 12345,
        exit_code: 1,
        error: "Command exited with code 1",
        failure_reason: "exit_code",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("ActionRunStatusSchema", () => {
    it("accepts valid statuses", () => {
      expect(ActionRunStatusSchema.parse("running")).toBe("running");
      expect(ActionRunStatusSchema.parse("completed")).toBe("completed");
      expect(ActionRunStatusSchema.parse("failed")).toBe("failed");
    });

    it("rejects invalid status", () => {
      const result = ActionRunStatusSchema.safeParse("pending");
      expect(result.success).toBe(false);
    });
  });
});

// ─── Template Interpolation Tests ────────────────────────────────────────────

describe("Template Interpolation", () => {
  // AC: @dispatch-action-model ac-8
  it("resolves known template variables from event context", () => {
    const ctx = makeEventContext({ task_ref: "@task-bar" });
    const result = resolveTemplateVars("Working on {{task_ref}}", ctx);
    expect(result).toBe("Working on @task-bar");
  });

  // AC: @dispatch-action-model ac-8
  it("passes through unresolved placeholders unchanged", () => {
    const ctx = makeEventContext();
    const result = resolveTemplateVars("Value: {{unknown_field}}", ctx);
    expect(result).toBe("Value: {{unknown_field}}");
  });

  // AC: @dispatch-action-model ac-8
  it("resolves multiple variables in a single template", () => {
    const ctx = makeEventContext({
      task_ref: "@task-x",
      event_type: "task.ready",
    });
    const result = resolveTemplateVars(
      "Event {{event_type}} for {{task_ref}}",
      ctx,
    );
    expect(result).toBe("Event task.ready for @task-x");
  });

  it("handles templates with no variables", () => {
    const ctx = makeEventContext();
    const result = resolveTemplateVars("No variables here", ctx);
    expect(result).toBe("No variables here");
  });

  it("handles empty template", () => {
    const ctx = makeEventContext();
    const result = resolveTemplateVars("", ctx);
    expect(result).toBe("");
  });

  // AC: @dispatch-action-model ac-7
  describe("extractTemplateVars", () => {
    it("extracts variable names from template", () => {
      const vars = extractTemplateVars("Hello {{name}}, event {{event_type}}");
      expect(vars).toEqual(["name", "event_type"]);
    });

    it("returns empty array for templates without variables", () => {
      const vars = extractTemplateVars("No variables");
      expect(vars).toEqual([]);
    });

    it("extracts duplicate variable names", () => {
      const vars = extractTemplateVars("{{a}} and {{a}}");
      expect(vars).toEqual(["a", "a"]);
    });
  });
});

// ─── ActionExecutor Tests ────────────────────────────────────────────────────

describe("ActionExecutor", () => {
  let events: ActionRunEvent[];
  let executor: ActionExecutor;

  beforeEach(() => {
    events = [];
    executor = new ActionExecutor({
      projectDir: tempDir,
      onActionRunEvent: (event) => events.push(event),
    });
  });

  // AC: @dispatch-action-model ac-1
  describe("command action execution", () => {
    it("runs a command asynchronously and produces action run events", async () => {
      const action: Action = {
        type: "command",
        command: "echo",
        args: ["hello"],
      };
      const ctx = makeEventContext();

      const run = await executor.execute(action, ctx, "test-hook");

      expect(run.status).toBe("completed");
      expect(run.action_type).toBe("command");
      expect(run.exit_code).toBe(0);
      expect(run.duration_ms).toBeGreaterThanOrEqual(0);
      expect(run.source_name).toBe("test-hook");
      expect(run.source_event_type).toBe("task.ready");
      expect(run.pid).toBeDefined();

      // Verify events emitted
      expect(events.length).toBe(2);
      expect(events[0].type).toBe("action.started");
      expect(events[0].action_run.action_run_id).toBe(run.action_run_id);
      expect(events[1].type).toBe("action.completed");
      expect(events[1].action_run.status).toBe("completed");
    });

    it("does not block — returns a promise", () => {
      const action: Action = {
        type: "command",
        command: "echo",
        args: ["hello"],
      };
      const ctx = makeEventContext();

      // AC: @dispatch-action-model ac-1 — the action does not block event processing
      const promise = executor.execute(action, ctx);
      expect(promise).toBeInstanceOf(Promise);
    });

    it("handles command failure with non-zero exit code", async () => {
      const action: Action = {
        type: "command",
        command: "sh",
        args: ["-c", "exit 42"],
      };
      const ctx = makeEventContext();

      const run = await executor.execute(action, ctx);

      expect(run.status).toBe("failed");
      expect(run.exit_code).toBe(42);
      expect(run.failure_reason).toBe("exit_code");
      expect(run.error).toContain("42");

      // action.started + action.failed
      expect(events.length).toBe(2);
      expect(events[1].type).toBe("action.failed");
    });

    it("handles spawn error for non-existent command", async () => {
      const action: Action = {
        type: "command",
        command: "/nonexistent/command/that/does/not/exist",
        args: [],
      };
      const ctx = makeEventContext();

      const run = await executor.execute(action, ctx);

      expect(run.status).toBe("failed");
      expect(run.failure_reason).toBe("spawn_error");
    });

    // AC: @dispatch-action-model ac-2
    it("kills the process when timeout is exceeded", async () => {
      const action: Action = {
        type: "command",
        command: "sleep",
        args: ["60"],
        timeout_ms: 200,
      };
      const ctx = makeEventContext();

      const run = await executor.execute(action, ctx);

      expect(run.status).toBe("failed");
      expect(run.failure_reason).toBe("timeout");
      expect(run.error).toContain("timed out");
      expect(run.duration_ms).toBeGreaterThanOrEqual(150);

      // action.started + action.failed (with timeout)
      const failedEvent = events.find((e) => e.type === "action.failed");
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.action_run.failure_reason).toBe("timeout");
    });

    it("resolves template variables in command and args", async () => {
      // Write a small script to verify the resolved value
      const scriptPath = path.join(tempDir, "echo-arg.sh");
      await fs.writeFile(
        scriptPath,
        '#!/bin/sh\necho "$1" > ' + path.join(tempDir, "output.txt"),
        { mode: 0o755 },
      );

      const action: Action = {
        type: "command",
        command: scriptPath,
        args: ["{{task_ref}}"],
      };
      const ctx = makeEventContext({ task_ref: "@task-resolve-test" });

      const run = await executor.execute(action, ctx);
      expect(run.status).toBe("completed");

      const output = await fs.readFile(
        path.join(tempDir, "output.txt"),
        "utf-8",
      );
      expect(output.trim()).toBe("@task-resolve-test");
    });
  });

  // AC: @dispatch-action-model ac-3
  describe("kspec action execution", () => {
    it("runs kspec CLI in project root with correlation_id", async () => {
      // Create a script that checks env var presence
      const scriptPath = path.join(tempDir, "mock-kspec.sh");
      await fs.writeFile(
        scriptPath,
        `#!/bin/sh
echo "CORRELATION=$KSPEC_CORRELATION_ID" > "${tempDir}/kspec-env.txt"
exit 0`,
        { mode: 0o755 },
      );

      const kspecExecutor = new ActionExecutor({
        projectDir: tempDir,
        kspecCliPath: scriptPath,
        onActionRunEvent: (event) => events.push(event),
      });

      const action: Action = {
        type: "kspec",
        command: "task list --json",
      };
      const ctx = makeEventContext({
        correlation_id: "01CORR_TEST_VALUE_00000001",
      });

      // Note: The kspec action spawns with `node <kspecCliPath> <args>`, but our
      // mock is a shell script. To test the env var injection properly, we need
      // the executor to use the script as the kspec CLI path.
      // Since the executor does `spawn(process.execPath, [kspecCliPath, ...args])`,
      // we need a node-compatible test. Let's use a node script instead.
      const nodeScriptPath = path.join(tempDir, "mock-kspec.cjs");
      await fs.writeFile(
        nodeScriptPath,
        `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'kspec-env.txt'),
  'CORRELATION=' + (process.env.KSPEC_CORRELATION_ID || 'MISSING') + '\\n' +
  'CWD=' + process.cwd() + '\\n'
);
process.exit(0);`,
      );

      const kspecExecutor2 = new ActionExecutor({
        projectDir: tempDir,
        kspecCliPath: nodeScriptPath,
        onActionRunEvent: (event) => events.push(event),
      });

      const run = await kspecExecutor2.execute(action, ctx);

      expect(run.status).toBe("completed");
      expect(run.action_type).toBe("kspec");

      const envOutput = await fs.readFile(
        path.join(tempDir, "kspec-env.txt"),
        "utf-8",
      );

      // AC: @dispatch-action-model ac-3 — correlation_id injected via KSPEC_CORRELATION_ID
      expect(envOutput).toContain("CORRELATION=01CORR_TEST_VALUE_00000001");
      // AC: @dispatch-action-model ac-3 — runs in project root directory
      expect(envOutput).toContain(`CWD=${tempDir}`);
    });

    it("handles kspec command timeout", async () => {
      const nodeScriptPath = path.join(tempDir, "mock-kspec-slow.cjs");
      await fs.writeFile(
        nodeScriptPath,
        `setTimeout(() => process.exit(0), 60000);`,
      );

      const kspecExecutor = new ActionExecutor({
        projectDir: tempDir,
        kspecCliPath: nodeScriptPath,
        onActionRunEvent: (event) => events.push(event),
      });

      const action: Action = {
        type: "kspec",
        command: "slow-command",
        timeout_ms: 200,
      };
      const ctx = makeEventContext();

      const run = await kspecExecutor.execute(action, ctx);

      expect(run.status).toBe("failed");
      expect(run.failure_reason).toBe("timeout");
    });
  });

  // AC: @dispatch-action-model ac-4, ac-5
  describe("agent action execution", () => {
    it("spawns a new invocation and tracks invocation_id", async () => {
      const mockSpawner = vi.fn().mockResolvedValue({
        invocation_id: "session-abc-123",
      });

      const agentExecutor = new ActionExecutor({
        projectDir: tempDir,
        onActionRunEvent: (event) => events.push(event),
        agentSpawner: mockSpawner,
      });

      const action: Action = {
        type: "agent",
        agent_id: "task-worker",
        prompt: "Work on {{task_ref}}",
        task_ref: "@task-agent-test",
        timeout_minutes: 15,
      };
      const ctx = makeEventContext({
        task_ref: "@task-agent-test",
        correlation_id: "01CORR_AGENT_TEST_00000001",
      });

      const run = await agentExecutor.execute(action, ctx);

      // AC: @dispatch-action-model ac-4 — action run tracks the linked invocation_id
      expect(run.status).toBe("completed");
      expect(run.invocation_id).toBe("session-abc-123");
      expect(run.action_type).toBe("agent");

      // Verify spawner called with correct params
      expect(mockSpawner).toHaveBeenCalledWith({
        agent_id: "task-worker",
        prompt: "Work on @task-agent-test", // Template resolved
        task_ref: "@task-agent-test",
        timeout_minutes: 15,
        correlation_id: "01CORR_AGENT_TEST_00000001",
      });
    });

    // AC: @dispatch-action-model ac-5
    it("spawns non-task-scoped invocations without task_ref", async () => {
      const mockSpawner = vi.fn().mockResolvedValue({
        invocation_id: "session-unscoped-456",
      });

      const agentExecutor = new ActionExecutor({
        projectDir: tempDir,
        onActionRunEvent: (event) => events.push(event),
        agentSpawner: mockSpawner,
      });

      const action: Action = {
        type: "agent",
        agent_id: "utility-agent",
        prompt: "Run maintenance",
        // No task_ref — non-task-scoped
      };
      const ctx = makeEventContext();

      const run = await agentExecutor.execute(action, ctx);

      expect(run.status).toBe("completed");
      expect(run.invocation_id).toBe("session-unscoped-456");

      // AC: @dispatch-action-model ac-5 — no task_ref passed means not subject
      // to per-task exclusivity
      expect(mockSpawner).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: "utility-agent",
          task_ref: undefined,
        }),
      );
    });

    it("fails when no agent spawner is configured", async () => {
      // executor has no agentSpawner
      const action: Action = {
        type: "agent",
        agent_id: "task-worker",
      };
      const ctx = makeEventContext();

      const run = await executor.execute(action, ctx);

      expect(run.status).toBe("failed");
      expect(run.error).toContain("No agent spawner configured");
    });

    it("handles agent spawner failure", async () => {
      const mockSpawner = vi
        .fn()
        .mockRejectedValue(new Error("Agent pool exhausted"));

      const agentExecutor = new ActionExecutor({
        projectDir: tempDir,
        onActionRunEvent: (event) => events.push(event),
        agentSpawner: mockSpawner,
      });

      const action: Action = {
        type: "agent",
        agent_id: "task-worker",
      };
      const ctx = makeEventContext();

      const run = await agentExecutor.execute(action, ctx);

      expect(run.status).toBe("failed");
      expect(run.error).toContain("Agent pool exhausted");
    });
  });

  // AC: @dispatch-action-model ac-6
  describe("notify action execution", () => {
    it("broadcasts notification to WebSocket clients", async () => {
      const broadcastCalls: Array<{
        topic: string;
        event: string;
        data: Record<string, unknown>;
      }> = [];

      const notifyExecutor = new ActionExecutor({
        projectDir: tempDir,
        onActionRunEvent: (event) => events.push(event),
        notifyBroadcast: (topic, event, data) => {
          broadcastCalls.push({ topic, event, data });
        },
      });

      const action: Action = {
        type: "notify",
        message: "Task {{task_ref}} is ready for review",
        topic: "automation",
      };
      const ctx = makeEventContext({
        task_ref: "@task-notify-test",
        event_type: "task.pending_review",
      });

      const run = await notifyExecutor.execute(action, ctx, "review-hook");

      expect(run.status).toBe("completed");

      // AC: @dispatch-action-model ac-6 — clients subscribed to automation topic receive
      expect(broadcastCalls.length).toBe(1);
      expect(broadcastCalls[0].topic).toBe("automation");
      expect(broadcastCalls[0].event).toBe("action.notify");
      expect(broadcastCalls[0].data.message).toBe(
        "Task @task-notify-test is ready for review",
      );
      expect(broadcastCalls[0].data.source_name).toBe("review-hook");
      expect(broadcastCalls[0].data.event_type).toBe("task.pending_review");
    });

    it("completes even without broadcast function", async () => {
      // executor has no notifyBroadcast
      const action: Action = {
        type: "notify",
        message: "Silenced notification",
      };
      const ctx = makeEventContext();

      const run = await executor.execute(action, ctx);
      expect(run.status).toBe("completed");
    });
  });

  // AC: @dispatch-action-model ac-7
  describe("template variable validation", () => {
    it("identifies unknown template variables and lists available fields", () => {
      const warnings = validateActionTemplates(
        ["Hello {{task_ref}}, status is {{unknown_status}}"],
        "task.ready",
      );

      // task_ref is known for task events — no warning
      const taskRefWarning = warnings.find((w) => w.variable === "task_ref");
      expect(taskRefWarning).toBeUndefined();

      // unknown_status is not a known field — produces a warning
      const unknownWarning = warnings.find(
        (w) => w.variable === "unknown_status",
      );
      expect(unknownWarning).toBeDefined();
      expect(unknownWarning!.available_fields).toContain("task_ref");
      expect(unknownWarning!.available_fields).toContain("event_id");
      expect(unknownWarning!.event_type).toBe("task.ready");
    });

    it("returns no warnings for templates with only known fields", () => {
      const warnings = validateActionTemplates(
        ["Task {{task_ref}} changed from {{from_status}} to {{to_status}}"],
        "task.ready",
      );
      expect(warnings).toEqual([]);
    });

    it("validates against all domains when event_type is not specified", () => {
      const warnings = validateActionTemplates(
        ["Agent {{agent_id}} with session {{session_id}}"],
      );
      // agent_id and session_id are known fields across domains
      expect(warnings).toEqual([]);
    });

    it("extracts templates from all action types", () => {
      expect(
        extractActionTemplates({
          type: "command",
          command: "echo {{task_ref}}",
          args: ["{{event_type}}", "literal"],
          cwd: "/tmp/{{source_id}}",
        }),
      ).toEqual(["echo {{task_ref}}", "{{event_type}}", "literal", "/tmp/{{source_id}}"]);

      expect(
        extractActionTemplates({
          type: "kspec",
          command: "task set {{task_ref}} --status {{to_status}}",
        }),
      ).toEqual(["task set {{task_ref}} --status {{to_status}}"]);

      expect(
        extractActionTemplates({
          type: "agent",
          agent_id: "worker",
          prompt: "Handle {{event_type}}",
        }),
      ).toEqual(["Handle {{event_type}}"]);

      expect(
        extractActionTemplates({
          type: "notify",
          message: "Alert: {{task_title}}",
          topic: "automation",
        }),
      ).toEqual(["Alert: {{task_title}}"]);
    });

    it("validates extracted templates from action definitions end-to-end", () => {
      const action: Action = {
        type: "notify",
        message: "Task {{task_ref}} has {{bogus_field}}",
        topic: "automation",
      };
      const templates = extractActionTemplates(action);
      const warnings = validateActionTemplates(templates, "task.ready");

      expect(warnings.length).toBe(1);
      expect(warnings[0].variable).toBe("bogus_field");
      expect(warnings[0].available_fields.length).toBeGreaterThan(0);
    });
  });

  // AC: @dispatch-action-model ac-8
  describe("runtime template resolution", () => {
    it("passes through absent field placeholders unchanged", () => {
      const ctx = makeEventContext();
      // absent_field is not in the event context
      const result = resolveTemplateVars(
        "Value: {{absent_field}}",
        ctx,
      );
      expect(result).toBe("Value: {{absent_field}}");
    });

    it("still executes the action with unresolved placeholders", async () => {
      const scriptPath = path.join(tempDir, "check-arg.cjs");
      await fs.writeFile(
        scriptPath,
        `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(${JSON.stringify(tempDir)}, 'arg-output.txt'),
  process.argv.slice(2).join(' ')
);
process.exit(0);`,
      );

      const action: Action = {
        type: "command",
        command: process.execPath,
        args: [scriptPath, "{{absent_field}}"],
      };
      const ctx = makeEventContext();

      const run = await executor.execute(action, ctx);

      // AC: @dispatch-action-model ac-8 — action still executes
      expect(run.status).toBe("completed");

      const output = await fs.readFile(
        path.join(tempDir, "arg-output.txt"),
        "utf-8",
      );
      // The unresolved placeholder passes through unchanged
      expect(output).toBe("{{absent_field}}");
    });
  });

  // AC: @dispatch-action-model ac-9
  describe("failure isolation across actions", () => {
    it("one action failure does not affect other pending actions", async () => {
      const actions: Action[] = [
        {
          type: "command",
          command: "sh",
          args: ["-c", "exit 1"], // This will fail
        },
        {
          type: "command",
          command: "echo",
          args: ["success"], // This should succeed
        },
        {
          type: "command",
          command: "sh",
          args: ["-c", "exit 2"], // This will also fail
        },
      ];
      const ctx = makeEventContext();

      const runs = await executor.executeAll(actions, ctx, "multi-hook");

      expect(runs.length).toBe(3);
      expect(runs[0].status).toBe("failed");
      expect(runs[0].exit_code).toBe(1);
      expect(runs[1].status).toBe("completed");
      expect(runs[1].exit_code).toBe(0);
      expect(runs[2].status).toBe("failed");
      expect(runs[2].exit_code).toBe(2);

      // All actions produced events independently
      const startedEvents = events.filter((e) => e.type === "action.started");
      expect(startedEvents.length).toBe(3);
    });

    it("handles a mix of action types with isolated failures", async () => {
      const mockSpawner = vi.fn().mockRejectedValue(new Error("Agent failed"));

      const mixedExecutor = new ActionExecutor({
        projectDir: tempDir,
        onActionRunEvent: (event) => events.push(event),
        agentSpawner: mockSpawner,
        notifyBroadcast: () => {},
      });

      const actions: Action[] = [
        { type: "agent", agent_id: "broken-agent" },
        { type: "notify", message: "Still works" },
        { type: "command", command: "echo", args: ["also works"] },
      ];
      const ctx = makeEventContext();

      const runs = await mixedExecutor.executeAll(actions, ctx);

      expect(runs[0].status).toBe("failed");
      expect(runs[0].error).toContain("Agent failed");
      expect(runs[1].status).toBe("completed");
      expect(runs[2].status).toBe("completed");
    });
  });

  describe("action run event lifecycle", () => {
    it("emits action.started before action.completed for successful actions", async () => {
      const action: Action = {
        type: "command",
        command: "echo",
        args: ["test"],
      };
      const ctx = makeEventContext();

      await executor.execute(action, ctx);

      expect(events.length).toBe(2);
      expect(events[0].type).toBe("action.started");
      expect(events[0].action_run.status).toBe("running");
      expect(events[1].type).toBe("action.completed");
      expect(events[1].action_run.status).toBe("completed");

      // Same action_run_id across events
      expect(events[0].action_run.action_run_id).toBe(
        events[1].action_run.action_run_id,
      );
    });

    it("emits action.started before action.failed for failed actions", async () => {
      const action: Action = {
        type: "command",
        command: "sh",
        args: ["-c", "exit 1"],
      };
      const ctx = makeEventContext();

      await executor.execute(action, ctx);

      expect(events.length).toBe(2);
      expect(events[0].type).toBe("action.started");
      expect(events[1].type).toBe("action.failed");

      // Same action_run_id
      expect(events[0].action_run.action_run_id).toBe(
        events[1].action_run.action_run_id,
      );
    });

    it("includes event_context in all emitted events", async () => {
      const action: Action = {
        type: "command",
        command: "echo",
        args: ["test"],
      };
      const ctx = makeEventContext({ event_type: "task.ready" });

      await executor.execute(action, ctx);

      for (const event of events) {
        expect(event.event_context.event_type).toBe("task.ready");
        expect(event.event_context.event_id).toBe(ctx.event_id);
      }
    });
  });

  describe("action run fields", () => {
    it("populates all expected fields on completed command run", async () => {
      const action: Action = {
        type: "command",
        command: "echo",
        args: ["hello"],
      };
      const ctx = makeEventContext();

      const run = await executor.execute(action, ctx, "test-source");

      // Validate the run conforms to ActionRunSchema
      const parsed = ActionRunSchema.safeParse(run);
      expect(parsed.success).toBe(true);

      expect(run.action_run_id).toBeDefined();
      expect(run.action_run_id.length).toBe(26); // ULID length
      expect(run.action_type).toBe("command");
      expect(run.status).toBe("completed");
      expect(run.started_at).toBeDefined();
      expect(run.completed_at).toBeDefined();
      expect(run.duration_ms).toBeGreaterThanOrEqual(0);
      expect(run.exit_code).toBe(0);
      expect(run.pid).toBeDefined();
      expect(run.source_name).toBe("test-source");
      expect(run.source_event_type).toBe("task.ready");
    });
  });
});

// ─── Trait AC Coverage ───────────────────────────────────────────────────────

// AC: @trait-error-guidance ac-1 — N/A: ActionExecutor is a library component,
// not a CLI command. Error messages are returned in the ActionRun.error field
// for consumers to format. CLI-level error guidance is handled by the hook/schedule
// CLI commands that use ActionExecutor.

// AC: @trait-error-guidance ac-2 — N/A: Same as ac-1. Suggested actions are the
// responsibility of CLI consumers that present errors to users.

// AC: @trait-error-guidance ac-3 — N/A: ActionExecutor does not resolve references.
// Reference resolution errors occur in the spec/task layer, not the action layer.

// AC: @trait-error-guidance ac-4 — N/A: ActionExecutor does not manage state
// transitions. Action runs have a simple running→completed/failed lifecycle
// with no invalid transitions possible.

// AC: @trait-error-guidance ac-5 — N/A: Validation errors for action schemas
// are handled by Zod schemas (ActionSchema), not by ActionExecutor runtime.
// The Zod error messages include field/value details by default.

// AC: @trait-error-guidance ac-6 — N/A: ActionExecutor does not operate in JSON
// mode. JSON-mode error formatting is handled by CLI commands that consume the
// action model.
