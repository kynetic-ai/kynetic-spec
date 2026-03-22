/**
 * Hook Executor Tests
 *
 * Tests the HookExecutor: event subscription, hook matching, action dispatch,
 * filter evaluation, disabled hook skipping, config reload, and correlation
 * chain propagation.
 *
 * AC: @dispatch-hook-system ac-1 through ac-5
 * Task: @task-hook-executor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus, type EventEnvelope } from "../src/agent-runtime/event-bus.js";
import {
  ActionExecutor,
  type ActionEventContext,
  type ActionRunEvent,
} from "../src/agent-runtime/action-executor.js";
import {
  HookExecutor,
  type HookExecutorOptions,
} from "../src/agent-runtime/hook-executor.js";
import type { Hook } from "../src/schema/hooks.js";
import type { Action, ActionRun } from "../src/schema/action.js";
import { testUlid, testUlids } from "./helpers/cli.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeHook(overrides: Partial<Hook> & { on: string; action?: Action } = { on: "task.ready" }): Hook {
  return {
    _ulid: testUlid("H00K", Math.floor(Math.random() * 1000)),
    name: "test-hook",
    on: overrides.on,
    enabled: true,
    action: overrides.action ?? {
      type: "notify",
      message: "Hook fired: {{event_type}}",
      topic: "automation",
    },
    ...overrides,
  };
}

function makeCompletedActionRun(sourceName?: string): ActionRun {
  return {
    action_run_id: testUlid("ACRN"),
    action_type: "notify",
    status: "completed",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: 1,
    source_name: sourceName,
  };
}

/**
 * Emit a task.ready event on the bus and wait for all subscribers to process.
 */
async function emitAndDrain(
  bus: EventBus,
  eventType: string,
  payload: Record<string, unknown> = {},
  sourceId = "test-source",
): Promise<EventEnvelope | undefined> {
  const result = bus.emit({
    event_type: eventType,
    source_type: "task_watcher",
    source_id: sourceId,
    payload,
    skipDedup: true,
  });
  // Allow microtask queue to flush for async subscriber delivery
  await new Promise((resolve) => setTimeout(resolve, 10));
  return result.event;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let eventBus: EventBus;
let actionExecutor: ActionExecutor;
let executeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  eventBus = new EventBus({ dedupWindowMs: 0 });
  actionExecutor = new ActionExecutor({
    projectDir: "/tmp/test-project",
  });
  // Spy on execute to intercept actual action execution
  executeSpy = vi.spyOn(actionExecutor, "execute").mockResolvedValue(
    makeCompletedActionRun(),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── AC: @dispatch-hook-system ac-1 ─────────────────────────────────────────

describe("ac-1: matching event fires configured action with envelope and payload context", () => {
  // AC: @dispatch-hook-system ac-1
  it("should execute hook action when matching event fires", async () => {
    const hook = makeHook({ on: "task.ready", name: "on-task-ready" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    await emitAndDrain(eventBus, "task.ready", { task_ref: "@task-foo" });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      hook.action,
      expect.objectContaining({
        event_type: "task.ready",
        task_ref: "@task-foo",
      }),
      "on-task-ready",
    );

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-1
  it("should propagate correlation_id from triggering event", async () => {
    const hook = makeHook({ on: "task.ready" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    // Emit a root event — correlation_id should be set to event_id
    const event = await emitAndDrain(eventBus, "task.ready");

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const passedContext = executeSpy.mock.calls[0][1] as ActionEventContext;
    // For root events, correlation_id defaults to null on the envelope,
    // so the executor sets it to event_id
    expect(passedContext.correlation_id).toBe(event!.event_id);

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-1
  it("should set causation_id to the triggering event's event_id", async () => {
    const hook = makeHook({ on: "task.ready" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    const event = await emitAndDrain(eventBus, "task.ready");

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const passedContext = executeSpy.mock.calls[0][1] as ActionEventContext;
    expect(passedContext.causation_id).toBe(event!.event_id);

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-1
  it("should propagate existing correlation_id when present", async () => {
    const hook = makeHook({ on: "action.completed" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    // First emit a root event to establish a correlation chain
    const rootResult = eventBus.emit({
      event_type: "task.ready",
      source_type: "task_watcher",
      source_id: "test",
      skipDedup: true,
    });
    const rootEvent = rootResult.event!;

    // Now emit a chained event with correlation_id
    eventBus.emit({
      event_type: "action.completed",
      source_type: "api",
      source_id: "test",
      causation_id: rootEvent.event_id,
      correlation_id: rootEvent.event_id,
      payload: { action_run_id: "run-1" },
      skipDedup: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const passedContext = executeSpy.mock.calls[0][1] as ActionEventContext;
    expect(passedContext.correlation_id).toBe(rootEvent.event_id);

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-1
  it("should flatten payload fields into action event context", async () => {
    const hook = makeHook({ on: "task.ready" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    await emitAndDrain(eventBus, "task.ready", {
      task_ref: "@task-foo",
      from_status: "pending",
      to_status: "in_progress",
      priority: 2,
    });

    const passedContext = executeSpy.mock.calls[0][1] as ActionEventContext;
    expect(passedContext.task_ref).toBe("@task-foo");
    expect(passedContext.from_status).toBe("pending");
    expect(passedContext.to_status).toBe("in_progress");
    expect(passedContext.priority).toBe(2);

    executor.stop();
  });
});

// ─── AC: @dispatch-hook-system ac-2 ─────────────────────────────────────────

describe("ac-2: disabled hooks are silently skipped", () => {
  // AC: @dispatch-hook-system ac-2
  it("should not execute disabled hooks", async () => {
    const hook = makeHook({ on: "task.ready", enabled: false });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    await emitAndDrain(eventBus, "task.ready");

    expect(executeSpy).not.toHaveBeenCalled();

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-2
  it("should execute enabled hooks while skipping disabled ones in the same set", async () => {
    const [id1, id2] = testUlids("H00K", 2);
    const disabledHook = makeHook({
      _ulid: id1,
      on: "task.ready",
      name: "disabled-hook",
      enabled: false,
    });
    const enabledHook = makeHook({
      _ulid: id2,
      on: "task.ready",
      name: "enabled-hook",
      enabled: true,
    });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [disabledHook, enabledHook],
    });
    executor.start();

    await emitAndDrain(eventBus, "task.ready");

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(
      enabledHook.action,
      expect.anything(),
      "enabled-hook",
    );

    executor.stop();
  });
});

// ─── AC: @dispatch-hook-system ac-3 ─────────────────────────────────────────

describe("ac-3: multiple matching hooks all execute independently", () => {
  // AC: @dispatch-hook-system ac-3
  it("should execute all matching hooks for the same event", async () => {
    const [id1, id2, id3] = testUlids("H00K", 3);
    const hook1 = makeHook({ _ulid: id1, on: "task.ready", name: "hook-1" });
    const hook2 = makeHook({ _ulid: id2, on: "task.ready", name: "hook-2" });
    const hook3 = makeHook({ _ulid: id3, on: "task.ready", name: "hook-3" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook1, hook2, hook3],
    });
    executor.start();

    await emitAndDrain(eventBus, "task.ready");

    expect(executeSpy).toHaveBeenCalledTimes(3);
    const sourceNames = executeSpy.mock.calls.map((call) => call[2]);
    expect(sourceNames).toContain("hook-1");
    expect(sourceNames).toContain("hook-2");
    expect(sourceNames).toContain("hook-3");

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-3
  it("should not let one hook failure affect other hooks", async () => {
    const [id1, id2] = testUlids("H00K", 2);

    // First hook's execute will reject
    let callCount = 0;
    executeSpy.mockImplementation(async (_action, _ctx, sourceName) => {
      callCount++;
      if (sourceName === "failing-hook") {
        throw new Error("Hook action failed");
      }
      return makeCompletedActionRun(sourceName);
    });

    const failingHook = makeHook({ _ulid: id1, on: "task.ready", name: "failing-hook" });
    const okHook = makeHook({ _ulid: id2, on: "task.ready", name: "ok-hook" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [failingHook, okHook],
    });
    executor.start();

    await emitAndDrain(eventBus, "task.ready");

    // Both hooks should have been called (independently)
    expect(callCount).toBe(2);

    executor.stop();
  });
});

// ─── AC: @dispatch-hook-system ac-4 ─────────────────────────────────────────

describe("ac-4: hooks with filters skip non-matching events", () => {
  // AC: @dispatch-hook-system ac-4
  it("should not execute hook when filter does not match payload", async () => {
    const hook = makeHook({
      on: "task.ready",
      filter: { automation: "eligible" },
    });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    // Emit event with non-matching automation value
    await emitAndDrain(eventBus, "task.ready", { automation: "manual_only" });

    expect(executeSpy).not.toHaveBeenCalled();

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-4
  it("should execute hook when filter matches payload", async () => {
    const hook = makeHook({
      on: "task.ready",
      filter: { automation: "eligible" },
    });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    await emitAndDrain(eventBus, "task.ready", { automation: "eligible" });

    expect(executeSpy).toHaveBeenCalledTimes(1);

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-4
  it("should match against envelope fields in the filter", async () => {
    const hook = makeHook({
      on: "task.ready",
      filter: { source_type: "api" },
    });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    // task_watcher source — should NOT match
    eventBus.emit({
      event_type: "task.ready",
      source_type: "task_watcher",
      source_id: "test",
      skipDedup: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executeSpy).not.toHaveBeenCalled();

    // api source — should match
    eventBus.emit({
      event_type: "task.ready",
      source_type: "api",
      source_id: "test-api",
      skipDedup: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executeSpy).toHaveBeenCalledTimes(1);

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-4
  it("should match array filter with contains-all semantics", async () => {
    const hook = makeHook({
      on: "task.ready",
      filter: { tags: ["dispatch", "hooks"] },
    });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    // Missing one tag — should NOT match
    await emitAndDrain(eventBus, "task.ready", { tags: ["dispatch"] });
    expect(executeSpy).not.toHaveBeenCalled();

    // Has all required tags plus extras — should match
    await emitAndDrain(eventBus, "task.ready", {
      tags: ["dispatch", "hooks", "mvp"],
    }, "source-2");
    expect(executeSpy).toHaveBeenCalledTimes(1);

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-4
  it("should match all events when hook has no filter", async () => {
    const hook = makeHook({
      on: "task.ready",
      // no filter field
    });
    delete (hook as Record<string, unknown>).filter;
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    await emitAndDrain(eventBus, "task.ready", { anything: "goes" });

    expect(executeSpy).toHaveBeenCalledTimes(1);

    executor.stop();
  });
});

// ─── AC: @dispatch-hook-system ac-5 ─────────────────────────────────────────

describe("ac-5: config changes take effect on next event; in-flight actions complete", () => {
  // AC: @dispatch-hook-system ac-5
  it("should use updated hooks after reloadHooks()", async () => {
    const [id1, id2] = testUlids("H00K", 2);
    const hookA = makeHook({ _ulid: id1, on: "task.ready", name: "hook-a" });
    const hookB = makeHook({ _ulid: id2, on: "task.ready", name: "hook-b" });

    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hookA],
    });
    executor.start();

    // First event: only hookA is configured
    await emitAndDrain(eventBus, "task.ready");
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0][2]).toBe("hook-a");

    // Reload with hookB only
    executor.reloadHooks([hookB]);
    executeSpy.mockClear();

    // Second event: only hookB should fire
    await emitAndDrain(eventBus, "task.ready", {}, "source-2");
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0][2]).toBe("hook-b");

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-5
  it("should increment config version on reload", () => {
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [],
    });

    expect(executor.configVersion).toBe(1);
    executor.reloadHooks([]);
    expect(executor.configVersion).toBe(2);
    executor.reloadHooks([]);
    expect(executor.configVersion).toBe(3);
  });

  // AC: @dispatch-hook-system ac-5
  it("should allow in-flight actions to complete after hook removal", async () => {
    // Create a slow-resolving execute mock to simulate in-flight action
    let resolveAction: (() => void) | null = null;
    const actionPromise = new Promise<ActionRun>((resolve) => {
      resolveAction = () => resolve(makeCompletedActionRun("slow-hook"));
    });
    executeSpy.mockReturnValue(actionPromise);

    const hook = makeHook({ on: "task.ready", name: "slow-hook" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    // Trigger the event — action starts executing
    await emitAndDrain(eventBus, "task.ready");
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executor.inFlightCount).toBe(1);

    // Remove the hook from config
    executor.reloadHooks([]);
    expect(executor.hookCount).toBe(0);

    // The in-flight action should still be tracked
    expect(executor.inFlightCount).toBe(1);

    // Resolve the action — should complete normally
    resolveAction!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.inFlightCount).toBe(0);

    executor.stop();
  });

  // AC: @dispatch-hook-system ac-5
  it("should not fire removed hooks on subsequent events", async () => {
    const hook = makeHook({ on: "task.ready", name: "removed-hook" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    // Remove the hook
    executor.reloadHooks([]);
    executeSpy.mockClear();

    // Event should produce no hook executions
    await emitAndDrain(eventBus, "task.ready");
    expect(executeSpy).not.toHaveBeenCalled();

    executor.stop();
  });
});

// ─── Lifecycle Tests ─────────────────────────────────────────────────────────

describe("HookExecutor lifecycle", () => {
  it("should not process events before start()", async () => {
    const hook = makeHook({ on: "task.ready" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    // Do NOT call start()

    await emitAndDrain(eventBus, "task.ready");

    expect(executeSpy).not.toHaveBeenCalled();
    expect(executor.isRunning).toBe(false);
  });

  it("should not process events after stop()", async () => {
    const hook = makeHook({ on: "task.ready" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();
    executor.stop();

    await emitAndDrain(eventBus, "task.ready");

    expect(executeSpy).not.toHaveBeenCalled();
    expect(executor.isRunning).toBe(false);
  });

  it("should be idempotent for start() calls", () => {
    const hook = makeHook({ on: "task.ready" });
    const subscribeSpy = vi.spyOn(eventBus, "subscribe");
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });

    executor.start();
    executor.start(); // Second call should be a no-op

    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    executor.stop();
  });

  it("should only fire hooks for matching event types", async () => {
    const hook = makeHook({ on: "task.ready" });
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks: [hook],
    });
    executor.start();

    // Non-matching event type
    await emitAndDrain(eventBus, "invocation.completed", { session_id: "s1" });

    expect(executeSpy).not.toHaveBeenCalled();

    executor.stop();
  });

  it("should report hookCount and isRunning correctly", () => {
    const [id1, id2] = testUlids("H00K", 2);
    const hooks = [
      makeHook({ _ulid: id1, on: "task.ready", name: "h1" }),
      makeHook({ _ulid: id2, on: "task.completed", name: "h2" }),
    ];
    const executor = new HookExecutor({
      eventBus,
      actionExecutor,
      hooks,
    });

    expect(executor.hookCount).toBe(2);
    expect(executor.isRunning).toBe(false);

    executor.start();
    expect(executor.isRunning).toBe(true);

    executor.stop();
    expect(executor.isRunning).toBe(false);
  });
});

// ─── Trait AC: @trait-error-guidance ─────────────────────────────────────────
//
// The HookExecutor is an internal runtime component, not a CLI command.
// It does not produce user-facing error messages, does not have a --json mode,
// does not handle references, state transitions, or validation errors directly.
// These trait ACs apply to CLI commands, not to internal engine components.

// AC: @trait-error-guidance ac-1 — N/A: HookExecutor is an internal runtime component, not a CLI command; errors are logged, not shown to users
// AC: @trait-error-guidance ac-2 — N/A: HookExecutor is an internal runtime component; no user-facing suggested actions
// AC: @trait-error-guidance ac-3 — N/A: HookExecutor does not resolve references from user input
// AC: @trait-error-guidance ac-4 — N/A: HookExecutor does not perform state transitions on user-facing entities
// AC: @trait-error-guidance ac-5 — N/A: HookExecutor does not surface validation errors to users; hook schema validation is done at load time by the parser
// AC: @trait-error-guidance ac-6 — N/A: HookExecutor has no --json mode; it is an internal engine component
