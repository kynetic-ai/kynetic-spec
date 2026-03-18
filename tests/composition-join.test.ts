/**
 * Composition Join Accumulator Tests
 *
 * Tests the composition schema, JoinAccumulator runtime, fan-in threshold
 * behavior, timeout with partial results, and group lifecycle management.
 *
 * Spec: @dispatch-composition-patterns, @dispatch-composition-correlation,
 *       @dispatch-composition-schema
 * Task: @task-composition-join
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ulid } from "ulid";
import { EventBus } from "../src/agent-runtime/event-bus.js";
import {
  ActionExecutor,
  type ActionEventContext,
  type ActionRunEvent,
} from "../src/agent-runtime/action-executor.js";
import {
  JoinAccumulator,
  type GroupState,
} from "../src/agent-runtime/join-accumulator.js";
import { CompositionSchema, type Composition } from "../src/schema/composition.js";
import { MetaManifestSchema } from "../src/schema/meta.js";
import type { Action } from "../src/schema/action.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeComposition(overrides: Partial<Composition> = {}): Composition {
  return {
    _ulid: ulid(),
    id: "test-composition",
    name: "Test Composition",
    join_count: 3,
    on_complete: {
      type: "notify",
      message: "Composition complete: {{group_id}}",
      topic: "automation",
    },
    enabled: true,
    ...overrides,
  };
}

function emitActionCompleted(
  bus: EventBus,
  options: {
    groupId: string;
    configId: string;
    actionRunId?: string;
    sessionId?: string;
  },
): void {
  bus.emit({
    event_type: "action.completed",
    source_type: "invocation_lifecycle",
    source_id: options.actionRunId ?? ulid(),
    payload: {
      action_run_id: options.actionRunId ?? ulid(),
      action_type: "agent",
      group_id: options.groupId,
      config_id: options.configId,
      session_id: options.sessionId,
      duration_ms: 1000,
      source_name: "test-hook",
    },
  });
}

function emitActionFailed(
  bus: EventBus,
  options: {
    groupId: string;
    configId: string;
    actionRunId?: string;
  },
): void {
  bus.emit({
    event_type: "action.failed",
    source_type: "invocation_lifecycle",
    source_id: options.actionRunId ?? ulid(),
    payload: {
      action_run_id: options.actionRunId ?? ulid(),
      action_type: "agent",
      group_id: options.groupId,
      config_id: options.configId,
      duration_ms: 500,
      error: "Test failure",
      failure_reason: "exit_code",
      source_name: "test-hook",
    },
  });
}

// ─── Schema Tests ────────────────────────────────────────────────────────────

// AC: @dispatch-composition-schema ac-1
describe("CompositionSchema", () => {
  it("parses a minimal composition config", () => {
    const input = {
      _ulid: ulid(),
      id: "fan-in-review",
      name: "Fan-in Review Group",
      join_count: 3,
      on_complete: {
        type: "agent",
        agent_id: "synthesis-agent",
      },
    };
    const result = CompositionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("fan-in-review");
      expect(result.data.join_count).toBe(3);
      expect(result.data.on_complete.type).toBe("agent");
      expect(result.data.enabled).toBe(true);
    }
  });

  // AC: @dispatch-composition-schema ac-1
  it("parses a full composition config with timeout and all fields", () => {
    const input = {
      _ulid: ulid(),
      id: "full-config",
      name: "Full Config Composition",
      join_count: 5,
      on_complete: {
        type: "notify",
        message: "All done",
      },
      timeout_ms: 30000,
      enabled: false,
    };
    const result = CompositionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout_ms).toBe(30000);
      expect(result.data.enabled).toBe(false);
    }
  });

  it("rejects invalid join_count (zero)", () => {
    const input = {
      _ulid: ulid(),
      id: "bad-count",
      name: "Bad Count",
      join_count: 0,
      on_complete: { type: "notify", message: "test" },
    };
    const result = CompositionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects invalid join_count (negative)", () => {
    const input = {
      _ulid: ulid(),
      id: "bad-count",
      name: "Bad Count",
      join_count: -1,
      on_complete: { type: "notify", message: "test" },
    };
    const result = CompositionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // AC: @dispatch-composition-schema ac-1
  it("on_complete uses the shared action schema (all 4 types)", () => {
    const actionTypes: Action[] = [
      { type: "command", command: "echo", args: ["done"] },
      { type: "kspec", command: "task complete @ref" },
      { type: "agent", agent_id: "synthesis" },
      { type: "notify", message: "done", topic: "automation" },
    ];
    for (const action of actionTypes) {
      const input = {
        _ulid: ulid(),
        id: `action-${action.type}`,
        name: `Action ${action.type}`,
        join_count: 2,
        on_complete: action,
      };
      const result = CompositionSchema.safeParse(input);
      expect(result.success).toBe(true);
    }
  });
});

// AC: @dispatch-composition-schema ac-2
describe("MetaManifest compositions field", () => {
  it("defaults compositions to empty array when not present", () => {
    const manifest = MetaManifestSchema.parse({});
    expect(manifest.compositions).toEqual([]);
  });

  it("accepts a manifest with compositions", () => {
    const manifest = MetaManifestSchema.parse({
      compositions: [
        {
          _ulid: ulid(),
          id: "fan-in",
          name: "Fan-in",
          join_count: 2,
          on_complete: { type: "notify", message: "done" },
        },
      ],
    });
    expect(manifest.compositions).toHaveLength(1);
    expect(manifest.compositions[0].id).toBe("fan-in");
  });
});

// ─── JoinAccumulator Tests ──────────────────────────────────────────────────

describe("JoinAccumulator", () => {
  let bus: EventBus;
  let executor: ActionExecutor;
  let accumulator: JoinAccumulator;
  let executedActions: { action: Action; context: ActionEventContext }[];

  beforeEach(() => {
    bus = new EventBus({ maxChainDepth: 20 });
    executedActions = [];

    // Create executor with a spy that captures executions
    executor = new ActionExecutor({
      projectDir: "/tmp/test",
      onActionRunEvent: vi.fn(),
      notifyBroadcast: vi.fn(),
    });

    // Spy on execute to capture calls without actually running actions
    vi.spyOn(executor, "execute").mockImplementation(
      async (action, context, sourceName) => {
        executedActions.push({ action, context });
        return {
          action_run_id: ulid(),
          action_type: action.type,
          status: "completed",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: 0,
        };
      },
    );

    accumulator = new JoinAccumulator({ eventBus: bus, actionExecutor: executor });
  });

  afterEach(() => {
    accumulator.stop();
    vi.restoreAllMocks();
  });

  // AC: @dispatch-composition-patterns ac-2
  it("fires on_complete when Nth successful run finishes", async () => {
    const config = makeComposition({ join_count: 3 });
    accumulator.start([config]);
    const groupId = ulid();

    // Emit 3 completed action events with the same group_id
    emitActionCompleted(bus, { groupId, configId: config.id, sessionId: "session-1" });
    emitActionCompleted(bus, { groupId, configId: config.id, sessionId: "session-2" });
    emitActionCompleted(bus, { groupId, configId: config.id, sessionId: "session-3" });

    // Wait for async event delivery
    await vi.waitFor(() => {
      expect(executedActions).toHaveLength(1);
    });

    // Verify on_complete was called with composition context
    const ctx = executedActions[0].context;
    expect(ctx.trigger).toBe("threshold_met");
    expect(ctx.completed_count).toBe(3);
    expect(ctx.join_count).toBe(3);
    expect(ctx.group_id).toBe(groupId);

    // Verify completed run references are provided
    expect(ctx.completed_session_ids).toContain("session-1");
    expect(ctx.completed_session_ids).toContain("session-2");
    expect(ctx.completed_session_ids).toContain("session-3");
  });

  // AC: @dispatch-composition-patterns ac-2
  it("includes references to all completed action runs", async () => {
    const config = makeComposition({ join_count: 2 });
    accumulator.start([config]);
    const groupId = ulid();

    const runId1 = ulid();
    const runId2 = ulid();

    emitActionCompleted(bus, {
      groupId,
      configId: config.id,
      actionRunId: runId1,
      sessionId: "sess-a",
    });
    emitActionCompleted(bus, {
      groupId,
      configId: config.id,
      actionRunId: runId2,
      sessionId: "sess-b",
    });

    await vi.waitFor(() => {
      expect(executedActions).toHaveLength(1);
    });

    const ctx = executedActions[0].context;
    expect(ctx.completed_run_ids).toContain(runId1);
    expect(ctx.completed_run_ids).toContain(runId2);
    expect(ctx.completed_session_ids).toContain("sess-a");
    expect(ctx.completed_session_ids).toContain("sess-b");
  });

  // AC: @dispatch-composition-correlation ac-2
  it("does not count failed runs toward the join threshold", async () => {
    const config = makeComposition({ join_count: 2 });
    accumulator.start([config]);
    const groupId = ulid();

    // 1 completed + 1 failed = should not fire
    emitActionCompleted(bus, { groupId, configId: config.id });
    emitActionFailed(bus, { groupId, configId: config.id });

    // Give time for async processing
    await new Promise((r) => setTimeout(r, 50));
    expect(executedActions).toHaveLength(0);

    // Verify group tracks the failure
    const group = accumulator.getGroupState(groupId);
    expect(group).toBeDefined();
    expect(group!.completed_count).toBe(1);
    expect(group!.failed_count).toBe(1);
    expect(group!.members).toHaveLength(2);

    // Second success should trigger
    emitActionCompleted(bus, { groupId, configId: config.id });

    await vi.waitFor(() => {
      expect(executedActions).toHaveLength(1);
    });
    expect(executedActions[0].context.completed_count).toBe(2);
    expect(executedActions[0].context.failed_count).toBe(1);
  });

  // AC: @dispatch-composition-patterns ac-3
  it("fires on_complete with partial results on timeout", async () => {
    vi.useFakeTimers();
    const config = makeComposition({ join_count: 3, timeout_ms: 5000 });
    accumulator.start([config]);
    const groupId = ulid();

    // Only 1 completed + 1 failed before timeout
    emitActionCompleted(bus, {
      groupId,
      configId: config.id,
      sessionId: "partial-session",
    });
    emitActionFailed(bus, { groupId, configId: config.id });

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(5100);

    expect(executedActions).toHaveLength(1);

    const ctx = executedActions[0].context;
    expect(ctx.trigger).toBe("timeout");
    expect(ctx.completed_count).toBe(1);
    expect(ctx.failed_count).toBe(1);
    expect(ctx.join_count).toBe(3);
    expect(ctx.completed_session_ids).toContain("partial-session");
    // Failed run IDs should be present
    const failedIds = (ctx.failed_run_ids as string);
    expect(failedIds.length).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  // AC: @dispatch-composition-correlation ac-3
  it("starts timeout when first run begins, not when config is loaded", async () => {
    vi.useFakeTimers();
    const config = makeComposition({ join_count: 3, timeout_ms: 5000 });
    accumulator.start([config]);
    const groupId = ulid();

    // Advance 3 seconds — no events yet, no timeout should fire
    await vi.advanceTimersByTimeAsync(3000);
    expect(executedActions).toHaveLength(0);

    // Now emit first event — timeout starts HERE
    emitActionCompleted(bus, { groupId, configId: config.id });

    // Advance 3 seconds (total 6s since start, but only 3s since first event)
    await vi.advanceTimersByTimeAsync(3000);
    expect(executedActions).toHaveLength(0);

    // Advance 2.1 more seconds (5.1s since first event — past timeout)
    await vi.advanceTimersByTimeAsync(2100);
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0].context.trigger).toBe("timeout");

    vi.useRealTimers();
  });

  // AC: @dispatch-composition-correlation ac-1
  it("creates separate activations for different group_ids", async () => {
    const config = makeComposition({ join_count: 2 });
    accumulator.start([config]);
    const groupA = ulid();
    const groupB = ulid();

    // Emit one event for each group
    emitActionCompleted(bus, { groupId: groupA, configId: config.id });
    emitActionCompleted(bus, { groupId: groupB, configId: config.id });

    // Give time for processing
    await new Promise((r) => setTimeout(r, 50));

    // Neither should have fired yet (need 2 each)
    expect(executedActions).toHaveLength(0);

    const stateA = accumulator.getGroupState(groupA);
    const stateB = accumulator.getGroupState(groupB);
    expect(stateA).toBeDefined();
    expect(stateB).toBeDefined();
    expect(stateA!.activation_id).not.toBe(stateB!.activation_id);
    expect(stateA!.completed_count).toBe(1);
    expect(stateB!.completed_count).toBe(1);
  });

  // AC: @dispatch-composition-correlation ac-1
  it("propagates activation_id in the on_complete context", async () => {
    const config = makeComposition({ join_count: 1 });
    accumulator.start([config]);
    const groupId = ulid();

    emitActionCompleted(bus, { groupId, configId: config.id });

    await vi.waitFor(() => {
      expect(executedActions).toHaveLength(1);
    });

    const ctx = executedActions[0].context;
    expect(ctx.activation_id).toBeDefined();
    expect(typeof ctx.activation_id).toBe("string");
    expect((ctx.activation_id as string).length).toBe(26); // ULID length
  });

  // AC: @dispatch-composition-correlation ac-4
  it("state is volatile — groups are cleared on stop", async () => {
    const config = makeComposition({ join_count: 3 });
    accumulator.start([config]);
    const groupId = ulid();

    emitActionCompleted(bus, { groupId, configId: config.id });

    // Wait for async event delivery to process
    await vi.waitFor(() => {
      expect(accumulator.getGroupState(groupId)).toBeDefined();
    });

    // Simulating daemon restart by stopping
    accumulator.stop();

    // Group should be gone
    expect(accumulator.getGroupState(groupId)).toBeUndefined();
    expect(accumulator.getActiveGroups().size).toBe(0);
  });

  it("ignores events without group_id", async () => {
    const config = makeComposition({ join_count: 1 });
    accumulator.start([config]);

    // Emit action.completed without group_id
    bus.emit({
      event_type: "action.completed",
      source_type: "invocation_lifecycle",
      source_id: ulid(),
      payload: {
        action_run_id: ulid(),
        action_type: "command",
        duration_ms: 100,
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(executedActions).toHaveLength(0);
    expect(accumulator.getActiveGroups().size).toBe(0);
  });

  it("ignores events for unknown config_id", async () => {
    const config = makeComposition({ join_count: 1, id: "known-config" });
    accumulator.start([config]);

    bus.emit({
      event_type: "action.completed",
      source_type: "invocation_lifecycle",
      source_id: ulid(),
      payload: {
        action_run_id: ulid(),
        action_type: "agent",
        group_id: ulid(),
        config_id: "unknown-config",
        duration_ms: 100,
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(executedActions).toHaveLength(0);
  });

  it("ignores disabled compositions", async () => {
    const config = makeComposition({ join_count: 1, enabled: false });
    accumulator.start([config]);
    const groupId = ulid();

    emitActionCompleted(bus, { groupId, configId: config.id });

    await new Promise((r) => setTimeout(r, 50));
    expect(executedActions).toHaveLength(0);
  });

  it("does not double-fire if extra events arrive after threshold", async () => {
    const config = makeComposition({ join_count: 2 });
    accumulator.start([config]);
    const groupId = ulid();

    emitActionCompleted(bus, { groupId, configId: config.id });
    emitActionCompleted(bus, { groupId, configId: config.id });

    await vi.waitFor(() => {
      expect(executedActions).toHaveLength(1);
    });

    // Extra event after threshold met
    emitActionCompleted(bus, { groupId, configId: config.id });

    await new Promise((r) => setTimeout(r, 50));
    // Still only 1 execution
    expect(executedActions).toHaveLength(1);
  });

  it("cancels timeout when threshold is met before timeout expires", async () => {
    vi.useFakeTimers();
    const config = makeComposition({ join_count: 2, timeout_ms: 10000 });
    accumulator.start([config]);
    const groupId = ulid();

    emitActionCompleted(bus, { groupId, configId: config.id });
    emitActionCompleted(bus, { groupId, configId: config.id });

    // Threshold met — should fire immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0].context.trigger).toBe("threshold_met");

    // Advance past the timeout — should NOT fire again
    await vi.advanceTimersByTimeAsync(11000);
    expect(executedActions).toHaveLength(1);

    vi.useRealTimers();
  });

  it("supports concurrent activations of the same config", async () => {
    const config = makeComposition({ join_count: 1 });
    accumulator.start([config]);
    const groupA = ulid();
    const groupB = ulid();

    emitActionCompleted(bus, { groupId: groupA, configId: config.id });
    emitActionCompleted(bus, { groupId: groupB, configId: config.id });

    await vi.waitFor(() => {
      expect(executedActions).toHaveLength(2);
    });

    // Both should have fired independently
    const groups = executedActions.map((e) => e.context.group_id);
    expect(groups).toContain(groupA);
    expect(groups).toContain(groupB);
  });

  it("reload updates configs without affecting in-flight groups", async () => {
    const config = makeComposition({ join_count: 3, id: "evolving" });
    accumulator.start([config]);
    const groupId = ulid();

    // Start a group with 1 completion
    emitActionCompleted(bus, { groupId, configId: "evolving" });

    await new Promise((r) => setTimeout(r, 50));
    expect(accumulator.getGroupState(groupId)?.completed_count).toBe(1);

    // Reload with updated config (different join_count)
    const newConfig = makeComposition({
      join_count: 1,
      id: "evolving",
    });
    accumulator.reload([newConfig]);

    // New events for NEW groups would use join_count=1
    const newGroupId = ulid();
    emitActionCompleted(bus, { groupId: newGroupId, configId: "evolving" });

    await vi.waitFor(() => {
      expect(executedActions).toHaveLength(1);
    });

    // New group fired with join_count=1
    expect(executedActions[0].context.group_id).toBe(newGroupId);
  });

  it("cleans up group state after on_complete fires", async () => {
    const config = makeComposition({ join_count: 1 });
    accumulator.start([config]);
    const groupId = ulid();

    emitActionCompleted(bus, { groupId, configId: config.id });

    await vi.waitFor(() => {
      expect(executedActions).toHaveLength(1);
    });

    // Group state should be cleaned up
    expect(accumulator.getGroupState(groupId)).toBeUndefined();
  });

  it("uses the on_complete action from the composition config", async () => {
    const config = makeComposition({
      join_count: 1,
      on_complete: {
        type: "agent",
        agent_id: "synthesis-reviewer",
        prompt_template: "Review results for group {{group_id}}",
      },
    });
    accumulator.start([config]);
    const groupId = ulid();

    emitActionCompleted(bus, { groupId, configId: config.id });

    await vi.waitFor(() => {
      expect(executedActions).toHaveLength(1);
    });

    expect(executedActions[0].action).toEqual(config.on_complete);
  });

  it("passes source_name as composition:<config_id>", async () => {
    const config = makeComposition({ join_count: 1, id: "my-comp" });
    accumulator.start([config]);
    const groupId = ulid();

    emitActionCompleted(bus, { groupId, configId: "my-comp" });

    await vi.waitFor(() => {
      expect(executor.execute).toHaveBeenCalled();
    });

    const call = (executor.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toBe("composition:my-comp");
  });
});
