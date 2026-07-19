/**
 * Agent Action Input Contract Tests
 *
 * Tests prompt templating, session strategy, and correlation propagation
 * for agent actions. Covers the contract that makes pipeline chaining work.
 *
 * AC: @dispatch-agent-action-input ac-1 through ac-4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { AgentActionSchema, type Action } from "../src/schema/action.js";
import {
  ActionExecutor,
  buildDefaultAgentPrompt,
  type ActionEventContext,
  type ActionRunEvent,
  type AgentSpawner,
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

function makeInvocationCompletedContext(
  overrides: Partial<ActionEventContext> = {},
): ActionEventContext {
  return {
    event_id: "01TEST00000000000000000002",
    event_type: "invocation.completed",
    correlation_id: "01CORR000000000000000000002",
    causation_id: "01CAUSE0000000000000000002",
    source_type: "invocation_lifecycle",
    source_id: "session-upstream-001",
    session_id: "session-upstream-001",
    agent_id: "task-worker",
    task_ref: "@task-upstream",
    trigger: "task.ready",
    duration_ms: 45000,
    outcome: "success",
    ...overrides,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-action-input-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ─── Schema Tests ───────────────────────────────────────────────────────────

describe("AgentActionSchema extensions", () => {
  // AC: @dispatch-agent-action-input ac-1
  it("accepts prompt_template field for template-based prompt generation", () => {
    const result = AgentActionSchema.safeParse({
      type: "agent",
      agent_id: "task-worker",
      prompt_template: "Work on {{task_ref}}: {{task_title}}",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt_template).toBe("Work on {{task_ref}}: {{task_title}}");
    }
  });

  // AC: @dispatch-agent-action-input ac-3
  it("accepts task_binding boolean flag", () => {
    const result = AgentActionSchema.safeParse({
      type: "agent",
      agent_id: "task-worker",
      task_binding: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task_binding).toBe(true);
    }
  });

  it("allows both prompt and prompt_template (prompt takes precedence at execution)", () => {
    const result = AgentActionSchema.safeParse({
      type: "agent",
      agent_id: "task-worker",
      prompt: "Direct prompt",
      prompt_template: "Template {{task_ref}}",
    });
    expect(result.success).toBe(true);
  });

  it("allows agent action with no prompt, prompt_template, or task_ref", () => {
    const result = AgentActionSchema.safeParse({
      type: "agent",
      agent_id: "utility-agent",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt).toBeUndefined();
      expect(result.data.prompt_template).toBeUndefined();
      expect(result.data.task_binding).toBeUndefined();
    }
  });
});

// ─── Default Prompt Generation ──────────────────────────────────────────────

describe("buildDefaultAgentPrompt", () => {
  // AC: @dispatch-agent-action-input ac-1
  it("generates a default prompt from event context for non-invocation events", () => {
    const ctx = makeEventContext({
      event_type: "task.ready",
      task_ref: "@task-build",
      task_title: "Build the feature",
      source_id: "watcher-1",
    });
    const prompt = buildDefaultAgentPrompt(ctx);

    expect(prompt).toContain("Event: task.ready");
    expect(prompt).toContain("Task: @task-build");
    expect(prompt).toContain("Title: Build the feature");
  });

  // AC: @dispatch-agent-action-input ac-2
  it("generates a default prompt for invocation.completed with upstream context", () => {
    const ctx = makeInvocationCompletedContext();
    const prompt = buildDefaultAgentPrompt(ctx);

    expect(prompt).toContain("Upstream invocation completed.");
    expect(prompt).toContain("Session: session-upstream-001");
    expect(prompt).toContain("Agent: task-worker");
    expect(prompt).toContain("Task: @task-upstream");
    expect(prompt).toContain("Outcome: success");
    expect(prompt).toContain("Duration: 45000ms");
  });

  // AC: @dispatch-agent-action-input ac-2
  it("includes trigger in invocation.completed default prompt", () => {
    const ctx = makeInvocationCompletedContext({ trigger: "task.needs_work" });
    const prompt = buildDefaultAgentPrompt(ctx);
    expect(prompt).toContain("Trigger: task.needs_work");
  });

  // AC: @dispatch-agent-action-input ac-2
  it("includes terminal_reason in invocation.completed default prompt when present", () => {
    const ctx = makeInvocationCompletedContext({
      terminal_reason: "timed_out",
      outcome: undefined,
    });
    const prompt = buildDefaultAgentPrompt(ctx);
    expect(prompt).toContain("Terminal reason: timed_out");
  });

  // AC: @dispatch-agent-action-input ac-2
  it("handles invocation.completed with minimal fields", () => {
    const ctx: ActionEventContext = {
      event_id: "01TEST00000000000000000003",
      event_type: "invocation.completed",
    };
    const prompt = buildDefaultAgentPrompt(ctx);
    expect(prompt).toContain("Upstream invocation completed.");
    // No session_id, agent_id, etc. — they're simply not included
    expect(prompt).not.toContain("Session:");
    expect(prompt).not.toContain("Agent:");
  });
});

// ─── Prompt Resolution Order Tests ──────────────────────────────────────────

describe("Agent action prompt resolution", () => {
  let events: ActionRunEvent[];
  let spawnerCalls: Parameters<AgentSpawner>[0][];
  let mockSpawner: AgentSpawner;

  beforeEach(() => {
    events = [];
    spawnerCalls = [];
    mockSpawner = vi.fn(async (opts) => {
      spawnerCalls.push(opts);
      return { invocation_id: "session-test-001" };
    });
  });

  function makeExecutor(): ActionExecutor {
    return new ActionExecutor({
      projectDir: tempDir,
      onActionRunEvent: (event) => events.push(event),
      agentSpawner: mockSpawner,
    });
  }

  // AC: @dispatch-agent-action-input ac-1
  it("interpolates prompt with event envelope and payload variables", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
      prompt: "Work on {{task_ref}} (event: {{event_type}}, corr: {{correlation_id}})",
    };
    const ctx = makeEventContext({
      task_ref: "@task-hello",
      event_type: "task.ready",
      correlation_id: "01CORR_INTERP_TEST_0000001",
    });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].prompt).toBe(
      "Work on @task-hello (event: task.ready, corr: 01CORR_INTERP_TEST_0000001)",
    );
  });

  // AC: @dispatch-agent-action-input ac-1
  it("interpolates prompt_template with event context when prompt is absent", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
      prompt_template: "Handle {{event_type}} for {{task_ref}}: {{task_title}}",
    };
    const ctx = makeEventContext({
      task_ref: "@task-template",
      task_title: "Template Task",
      event_type: "task.needs_work",
    });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].prompt).toBe("Handle task.needs_work for @task-template: Template Task");
  });

  // AC: @dispatch-agent-action-input ac-1
  it("prompt takes precedence over prompt_template", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
      prompt: "Direct prompt for {{task_ref}}",
      prompt_template: "Template for {{task_ref}}",
    };
    const ctx = makeEventContext({ task_ref: "@task-precedence" });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].prompt).toBe("Direct prompt for @task-precedence");
  });

  // AC: @dispatch-agent-action-input ac-1
  it("generates default prompt when neither prompt nor prompt_template is configured", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
    };
    const ctx = makeEventContext({
      event_type: "task.ready",
      task_ref: "@task-default",
      task_title: "Default Task",
    });

    await executor.execute(action, ctx);

    const prompt = spawnerCalls[0].prompt!;
    expect(prompt).toContain("Event: task.ready");
    expect(prompt).toContain("Task: @task-default");
    expect(prompt).toContain("Title: Default Task");
  });

  // AC: @dispatch-agent-action-input ac-2
  it("generates invocation.completed default prompt with upstream context", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "pr-reviewer",
      // No prompt or prompt_template — should get default
    };
    const ctx = makeInvocationCompletedContext({
      session_id: "session-upstream-abc",
      agent_id: "task-worker",
      task_ref: "@task-completed-upstream",
      outcome: "success",
      duration_ms: 30000,
    });

    const run = await executor.execute(action, ctx);
    expect(run.status).toBe("completed");

    const prompt = spawnerCalls[0].prompt!;
    expect(prompt).toContain("Upstream invocation completed.");
    expect(prompt).toContain("Session: session-upstream-abc");
    expect(prompt).toContain("Agent: task-worker");
    expect(prompt).toContain("Task: @task-completed-upstream");
    expect(prompt).toContain("Outcome: success");
  });

  // AC: @dispatch-agent-action-input ac-2
  it("allows prompt_template to override default invocation.completed prompt", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "pr-reviewer",
      prompt_template: "Review work from session {{session_id}} by {{agent_id}} on {{task_ref}}",
    };
    const ctx = makeInvocationCompletedContext({
      session_id: "session-custom-001",
      agent_id: "task-worker",
      task_ref: "@task-custom-review",
    });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].prompt).toBe(
      "Review work from session session-custom-001 by task-worker on @task-custom-review",
    );
  });
});

// ─── Task Binding Tests ─────────────────────────────────────────────────────

describe("Agent action task_binding", () => {
  let spawnerCalls: Parameters<AgentSpawner>[0][];
  let mockSpawner: AgentSpawner;

  beforeEach(() => {
    spawnerCalls = [];
    mockSpawner = vi.fn(async (opts) => {
      spawnerCalls.push(opts);
      return { invocation_id: "session-binding-001" };
    });
  });

  function makeExecutor(): ActionExecutor {
    return new ActionExecutor({
      projectDir: tempDir,
      agentSpawner: mockSpawner,
    });
  }

  // AC: @dispatch-agent-action-input ac-3
  it("derives task_ref from event when task_binding is true and event has task_ref", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
      task_binding: true,
      // No explicit task_ref — should come from event
    };
    const ctx = makeEventContext({ task_ref: "@task-from-event" });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].task_ref).toBe("@task-from-event");
  });

  // AC: @dispatch-agent-action-input ac-3
  it("explicit task_ref takes precedence over event-derived task_ref", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
      task_binding: true,
      task_ref: "@task-explicit",
    };
    const ctx = makeEventContext({ task_ref: "@task-from-event" });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].task_ref).toBe("@task-explicit");
  });

  // AC: @dispatch-canonical-task-identity ac-automation-agent-actions-canonicalize-task-binding
  // task_binding forwards BOTH the event task_id and task_ref so the spawner can
  // canonicalize identity and reject mismatched pairs.
  it("task_binding forwards both event task_id and task_ref to the spawner", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
      task_binding: true,
    };
    const ctx = makeEventContext({
      task_id: "01JFFFFFFFFFFFFFFFFFFFFFF1",
      task_ref: "@task-from-event",
    });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].task_ref).toBe("@task-from-event");
    expect(spawnerCalls[0].task_id).toBe("01JFFFFFFFFFFFFFFFFFFFFFF1");
  });

  // AC: @dispatch-canonical-task-identity ac-automation-agent-actions-canonicalize-task-binding
  // task_binding with only a task_id in the event forwards the id (no display ref);
  // the spawner derives the default @<task_id> display.
  it("task_binding forwards a task_id-only event with no task_ref", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
      task_binding: true,
    };
    const ctx: ActionEventContext = {
      event_id: "01TEST0000000000000000000A",
      event_type: "task.ready",
      task_id: "01JFFFFFFFFFFFFFFFFFFFFFF2",
      // No task_ref
    };

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].task_id).toBe("01JFFFFFFFFFFFFFFFFFFFFFF2");
    expect(spawnerCalls[0].task_ref).toBeUndefined();
  });

  // AC: @dispatch-canonical-task-identity ac-automation-agent-actions-canonicalize-task-binding
  // An explicit action.task_ref is the authoritative binding and display ref:
  // event task_id/task_ref are ignored for identity entirely, even when the
  // triggering event references a DIFFERENT task. The spawner must not receive
  // the event task_id, so the explicit ref alone defines identity.
  it("explicit action.task_ref drops event identity even when event references a different task", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
      task_ref: "@task-explicit",
      // task_binding may be true or false — explicit ref wins regardless
      task_binding: true,
    };
    const ctx = makeEventContext({
      task_id: "01JFFFFFFFFFFFFFFFFFFFFFF3",
      task_ref: "@task-different-from-event",
    });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].task_ref).toBe("@task-explicit");
    // Event task_id must NOT leak through — explicit ref is the sole identity input
    expect(spawnerCalls[0].task_id).toBeUndefined();
  });

  // AC: @dispatch-agent-action-input ac-3
  it("invocation is non-task-scoped without task_binding", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "utility-agent",
      // No task_binding, no task_ref
    };
    const ctx = makeEventContext({ task_ref: "@task-in-event" });

    await executor.execute(action, ctx);

    // Without task_binding, even though event has task_ref, invocation is non-task-scoped
    expect(spawnerCalls[0].task_ref).toBeUndefined();
  });

  // AC: @dispatch-agent-action-input ac-3
  it("task_binding with no event task_ref results in non-task-scoped invocation", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
      task_binding: true,
    };
    const ctx: ActionEventContext = {
      event_id: "01TEST00000000000000000004",
      event_type: "schedule.tick",
      // No task_ref in this event
    };

    await executor.execute(action, ctx);

    // task_binding is true but event has no task_ref
    expect(spawnerCalls[0].task_ref).toBeUndefined();
  });

  // AC: @dispatch-agent-action-input ac-3
  it("task_binding false does not derive task_ref from event", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "utility-agent",
      task_binding: false,
    };
    const ctx = makeEventContext({ task_ref: "@task-should-not-bind" });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].task_ref).toBeUndefined();
  });
});

// ─── Correlation and Group ID Propagation Tests ─────────────────────────────

describe("Agent action correlation and group_id propagation", () => {
  let spawnerCalls: Parameters<AgentSpawner>[0][];
  let mockSpawner: AgentSpawner;

  beforeEach(() => {
    spawnerCalls = [];
    mockSpawner = vi.fn(async (opts) => {
      spawnerCalls.push(opts);
      return { invocation_id: "session-corr-001" };
    });
  });

  function makeExecutor(): ActionExecutor {
    return new ActionExecutor({
      projectDir: tempDir,
      agentSpawner: mockSpawner,
    });
  }

  // AC: @dispatch-agent-action-input ac-4
  it("propagates correlation_id from triggering event to spawned invocation", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
    };
    const ctx = makeEventContext({
      correlation_id: "01CORR_PROPAGATE_TEST_001",
    });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].correlation_id).toBe("01CORR_PROPAGATE_TEST_001");
  });

  // AC: @dispatch-agent-action-input ac-4
  it("propagates group_id from triggering event to spawned invocation", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
    };
    const ctx = makeEventContext({
      group_id: "group-composition-001",
      correlation_id: "01CORR_GROUP_TEST_0000001",
    });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].group_id).toBe("group-composition-001");
    expect(spawnerCalls[0].correlation_id).toBe("01CORR_GROUP_TEST_0000001");
  });

  // AC: @dispatch-agent-action-input ac-4
  it("propagates both correlation_id and group_id together in composition", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "downstream-agent",
      prompt_template: "Continue work on {{task_ref}} in group {{group_id}}",
    };
    const ctx = makeEventContext({
      correlation_id: "01CORR_COMPOSITION_TEST01",
      group_id: "group-pipeline-abc",
      task_ref: "@task-pipeline",
    });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].correlation_id).toBe("01CORR_COMPOSITION_TEST01");
    expect(spawnerCalls[0].group_id).toBe("group-pipeline-abc");
    expect(spawnerCalls[0].prompt).toContain("group-pipeline-abc");
  });

  // AC: @dispatch-agent-action-input ac-4
  it("handles missing group_id gracefully (undefined propagation)", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
    };
    const ctx = makeEventContext({
      correlation_id: "01CORR_NO_GROUP_TEST_001",
      // No group_id
    });

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].group_id).toBeUndefined();
    expect(spawnerCalls[0].correlation_id).toBe("01CORR_NO_GROUP_TEST_001");
  });

  // AC: @dispatch-agent-action-input ac-4
  it("handles missing correlation_id gracefully", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "agent",
      agent_id: "task-worker",
    };
    const ctx: ActionEventContext = {
      event_id: "01TEST00000000000000000005",
      event_type: "schedule.tick",
      // No correlation_id or group_id
    };

    await executor.execute(action, ctx);

    expect(spawnerCalls[0].correlation_id).toBeUndefined();
    expect(spawnerCalls[0].group_id).toBeUndefined();
  });
});

// ─── Integration Test: Full Pipeline ────────────────────────────────────────

describe("Agent action input contract — integration", () => {
  // AC: @dispatch-agent-action-input ac-1, ac-2, ac-3, ac-4
  it("handles a complete invocation.completed pipeline with all features", async () => {
    const spawnerCalls: Parameters<AgentSpawner>[0][] = [];
    const mockSpawner: AgentSpawner = vi.fn(async (opts) => {
      spawnerCalls.push(opts);
      return { invocation_id: "session-downstream-001" };
    });

    const events: ActionRunEvent[] = [];
    const executor = new ActionExecutor({
      projectDir: tempDir,
      onActionRunEvent: (event) => events.push(event),
      agentSpawner: mockSpawner,
    });

    // Simulate a hook that fires on invocation.completed with task_binding
    const action: Action = {
      type: "agent",
      agent_id: "pr-reviewer",
      task_binding: true,
      // No prompt — uses default invocation.completed prompt (AC-1, AC-2)
    };

    const ctx: ActionEventContext = {
      event_id: "01TEST00000000000000000006",
      event_type: "invocation.completed",
      correlation_id: "01CORR_PIPELINE_TEST_001",
      causation_id: "01CAUSE_PIPELINE_TEST_01",
      source_type: "invocation_lifecycle",
      source_id: "session-worker-xyz",
      group_id: "group-review-pipeline",
      session_id: "session-worker-xyz",
      agent_id: "task-worker",
      task_ref: "@task-review-me",
      trigger: "task.ready",
      duration_ms: 120000,
      outcome: "success",
    };

    const run = await executor.execute(action, ctx, "review-hook");

    // Verify the action completed
    expect(run.status).toBe("completed");
    expect(run.invocation_id).toBe("session-downstream-001");

    // AC-1: Default prompt includes event context
    const prompt = spawnerCalls[0].prompt!;
    expect(prompt).toContain("Upstream invocation completed.");
    expect(prompt).toContain("Session: session-worker-xyz");
    expect(prompt).toContain("Agent: task-worker");
    expect(prompt).toContain("Outcome: success");

    // AC-2: Prompt includes session_id, agent_id, task_ref, outcome
    expect(prompt).toContain("Task: @task-review-me");
    expect(prompt).toContain("Duration: 120000ms");

    // AC-3: task_binding derived task_ref from event
    expect(spawnerCalls[0].task_ref).toBe("@task-review-me");

    // AC-4: correlation_id and group_id propagated
    expect(spawnerCalls[0].correlation_id).toBe("01CORR_PIPELINE_TEST_001");
    expect(spawnerCalls[0].group_id).toBe("group-review-pipeline");
  });
});
