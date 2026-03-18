/**
 * Schedule Tick Engine Tests
 *
 * Tests the ScheduleEngine: cron evaluation, overlap policies, config reload,
 * backfill, manual triggers, action execution, and event emission.
 *
 * AC: @dispatch-schedule-entities ac-1 through ac-6
 * AC: @dispatch-schedule-runtime ac-1 through ac-5
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ScheduleEngine,
} from "../src/agent-runtime/schedule-engine.js";
import { EventBus, type EventEnvelope } from "../src/agent-runtime/event-bus.js";
import {
  ActionExecutor,
  type ActionEventContext,
} from "../src/agent-runtime/action-executor.js";
import type { ActionRun } from "../src/schema/action.js";
import type { LoadedSchedule } from "../src/parser/meta.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

let eventBus: EventBus;

/** Track emitted events for assertions. */
function collectEvents(bus: EventBus, pattern: string): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  bus.subscribe(pattern, (event) => {
    events.push(event);
  });
  return events;
}

/**
 * Create a mock ActionExecutor that records calls and resolves immediately.
 */
function createMockActionExecutor(
  options: {
    stayRunning?: boolean;
    fail?: boolean;
  } = {},
): {
  executor: ActionExecutor;
  executeCalls: Array<{
    action: any;
    eventContext: ActionEventContext;
    sourceName?: string;
  }>;
} {
  const executeCalls: Array<{
    action: any;
    eventContext: ActionEventContext;
    sourceName?: string;
  }> = [];
  let runCounter = 0;

  const executor = {
    execute: vi.fn(
      async (
        action: any,
        eventContext: ActionEventContext,
        sourceName?: string,
      ): Promise<ActionRun> => {
        executeCalls.push({ action, eventContext, sourceName });
        runCounter++;
        const actionRunId = `run-${String(runCounter).padStart(3, "0")}`;
        const now = new Date().toISOString();

        if (options.stayRunning) {
          return {
            action_run_id: actionRunId,
            action_type: action.type,
            status: "running" as const,
            started_at: now,
            source_name: sourceName,
            source_event_type: eventContext.event_type,
          };
        }

        if (options.fail) {
          return {
            action_run_id: actionRunId,
            action_type: action.type,
            status: "failed" as const,
            started_at: now,
            completed_at: now,
            duration_ms: 0,
            error: "Test failure",
            failure_reason: "error" as const,
            source_name: sourceName,
            source_event_type: eventContext.event_type,
          };
        }

        return {
          action_run_id: actionRunId,
          action_type: action.type,
          status: "completed" as const,
          started_at: now,
          completed_at: now,
          duration_ms: 0,
          source_name: sourceName,
          source_event_type: eventContext.event_type,
        };
      },
    ),
    executeAll: vi.fn(),
  } as unknown as ActionExecutor;

  return { executor, executeCalls };
}

/**
 * Build a test schedule definition.
 */
function makeSchedule(
  overrides: Partial<LoadedSchedule> = {},
): LoadedSchedule {
  return {
    _ulid: "01TEST00000000000000000001",
    id: "test-schedule",
    name: "Test Schedule",
    cron: "* * * * *",
    timezone: "UTC",
    action: {
      type: "command" as const,
      command: "echo",
      args: ["tick"],
      shell: false,
    },
    overlap_policy: "skip",
    backfill: false,
    enabled: true,
    ...overrides,
  } as LoadedSchedule;
}

/**
 * Create a ScheduleEngine with a mock schedule loader.
 */
function createEngine(
  schedules: LoadedSchedule[],
  executorOptions: { stayRunning?: boolean; fail?: boolean } = {},
): {
  engine: ScheduleEngine;
  executor: ActionExecutor;
  executeCalls: Array<{
    action: any;
    eventContext: ActionEventContext;
    sourceName?: string;
  }>;
} {
  const { executor, executeCalls } = createMockActionExecutor(executorOptions);

  const engine = new ScheduleEngine({
    projectDir: "/tmp/test-project",
    eventBus,
    actionExecutor: executor,
    evaluationIntervalMs: 100_000, // large — we control via triggerSchedule
    scheduleLoader: async () => schedules,
  });

  return { engine, executor, executeCalls };
}

beforeEach(() => {
  eventBus = new EventBus();
});

// ─── AC: @dispatch-schedule-entities ac-1 ───────────────────────────────────
// Given: A schedule is configured with a cron expression and an action
// When: The cron expression matches the current time
// Then: The configured action executes with schedule context in the event payload

describe("AC: @dispatch-schedule-entities ac-1 — cron match triggers action", () => {
  // AC: @dispatch-schedule-entities ac-1
  it("should execute action when triggered and emit schedule.tick event with payload", async () => {
    const schedule = makeSchedule({ cron: "* * * * *" });
    const { engine, executeCalls } = createEngine([schedule]);
    const tickEvents = collectEvents(eventBus, "schedule.tick");

    await engine.start();

    const result = await engine.triggerSchedule("test-schedule");

    expect(result.accepted).toBe(true);
    expect(executeCalls.length).toBe(1);

    // Verify the event payload
    expect(tickEvents.length).toBe(1);
    expect(tickEvents[0].payload.schedule_id).toBe("test-schedule");
    expect(tickEvents[0].payload.schedule_name).toBe("Test Schedule");
    expect(tickEvents[0].payload.tick_time).toBeDefined();
    expect(typeof tickEvents[0].payload.tick_time).toBe("string");
    expect(tickEvents[0].payload.run_count).toBe(1);
    expect(tickEvents[0].source_type).toBe("schedule_engine");
    expect(tickEvents[0].source_id).toBe("test-schedule");

    // Verify action was called with schedule context
    const call = executeCalls[0];
    expect(call.eventContext.schedule_id).toBe("test-schedule");
    expect(call.eventContext.schedule_name).toBe("Test Schedule");
    expect(call.eventContext.event_type).toBe("schedule.tick");
    expect(call.sourceName).toBe("Test Schedule");

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-entities ac-2 ───────────────────────────────────

describe("AC: @dispatch-schedule-entities ac-2 — skip overlap policy", () => {
  // AC: @dispatch-schedule-entities ac-2
  it("should skip tick when overlap_policy is skip and action is running", async () => {
    const schedule = makeSchedule({ overlap_policy: "skip" });
    const { engine } = createEngine([schedule], { stayRunning: true });
    const tickEvents = collectEvents(eventBus, "schedule.tick");

    await engine.start();

    const first = await engine.triggerSchedule("test-schedule");
    expect(first.accepted).toBe(true);
    expect(tickEvents.length).toBe(1);

    const second = await engine.triggerSchedule("test-schedule");
    expect(second.accepted).toBe(false);
    expect(second.reason).toContain("skip");
    expect(tickEvents.length).toBe(1);

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-entities ac-3 ───────────────────────────────────

describe("AC: @dispatch-schedule-entities ac-3 — buffer_one overlap policy", () => {
  // AC: @dispatch-schedule-entities ac-3
  it("should buffer one tick and drop additional when buffer_one is active", async () => {
    const schedule = makeSchedule({ overlap_policy: "buffer_one" });
    const { engine } = createEngine([schedule], { stayRunning: true });

    await engine.start();

    const first = await engine.triggerSchedule("test-schedule");
    expect(first.accepted).toBe(true);

    const second = await engine.triggerSchedule("test-schedule");
    expect(second.accepted).toBe(false);
    expect(second.reason).toContain("Buffered");

    const third = await engine.triggerSchedule("test-schedule");
    expect(third.accepted).toBe(false);
    expect(third.reason).toContain("Dropped");

    const status = engine.getStatus();
    expect(status.find((s) => s.id === "test-schedule")?.buffered).toBe(true);

    await engine.stop();
  });

  // AC: @dispatch-schedule-entities ac-3
  it("should fire buffered tick when active run completes", async () => {
    const schedule = makeSchedule({ overlap_policy: "buffer_one" });

    let callCount = 0;
    const executeCalls: any[] = [];
    const executor = {
      execute: vi.fn(
        async (
          action: any,
          eventContext: ActionEventContext,
          sourceName?: string,
        ): Promise<ActionRun> => {
          callCount++;
          executeCalls.push({ action, eventContext, sourceName });
          const actionRunId = `run-${String(callCount).padStart(3, "0")}`;
          const now = new Date().toISOString();

          if (callCount === 1) {
            return {
              action_run_id: actionRunId,
              action_type: action.type,
              status: "running" as const,
              started_at: now,
              source_name: sourceName,
              source_event_type: eventContext.event_type,
            };
          }
          return {
            action_run_id: actionRunId,
            action_type: action.type,
            status: "completed" as const,
            started_at: now,
            completed_at: now,
            duration_ms: 0,
            source_name: sourceName,
            source_event_type: eventContext.event_type,
          };
        },
      ),
    } as unknown as ActionExecutor;

    const engine = new ScheduleEngine({
      projectDir: "/tmp/test-project",
      eventBus,
      actionExecutor: executor,
      evaluationIntervalMs: 100_000,
      scheduleLoader: async () => [schedule],
    });

    await engine.start();

    await engine.triggerSchedule("test-schedule");
    expect(executeCalls.length).toBe(1);

    await engine.triggerSchedule("test-schedule");
    expect(executeCalls.length).toBe(1); // Buffered, not executed yet

    // Simulate action.completed
    eventBus.emit({
      event_type: "action.completed",
      source_type: "schedule_engine",
      source_id: "test-schedule",
      payload: { action_run_id: "run-001", action_type: "command" },
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(executeCalls.length).toBe(2);
    expect(engine.getStatus().find((s) => s.id === "test-schedule")?.buffered).toBe(false);

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-entities ac-4 ───────────────────────────────────

describe("AC: @dispatch-schedule-entities ac-4 — disabled schedules", () => {
  // AC: @dispatch-schedule-entities ac-4
  it("should not fire ticks for disabled schedules", async () => {
    const schedule = makeSchedule({ enabled: false, cron: "* * * * *" });
    const { engine, executeCalls } = createEngine([schedule]);
    const tickEvents = collectEvents(eventBus, "schedule.tick");

    await engine.start();

    const status = engine.getStatus();
    expect(status.length).toBe(1);
    expect(status[0].enabled).toBe(false);
    expect(tickEvents.length).toBe(0);
    expect(executeCalls.length).toBe(0);

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-entities ac-5 ───────────────────────────────────

describe("AC: @dispatch-schedule-entities ac-5 — allow overlap policy", () => {
  // AC: @dispatch-schedule-entities ac-5
  it("should allow concurrent executions with overlap_policy: allow", async () => {
    const schedule = makeSchedule({ overlap_policy: "allow" });
    const { engine } = createEngine([schedule], { stayRunning: true });
    const tickEvents = collectEvents(eventBus, "schedule.tick");

    await engine.start();

    const first = await engine.triggerSchedule("test-schedule");
    expect(first.accepted).toBe(true);

    const second = await engine.triggerSchedule("test-schedule");
    expect(second.accepted).toBe(true);

    const third = await engine.triggerSchedule("test-schedule");
    expect(third.accepted).toBe(true);

    expect(tickEvents.filter((e) => e.payload.schedule_id === "test-schedule").length).toBe(3);
    expect(engine.getStatus().find((s) => s.id === "test-schedule")?.active_run_count).toBe(3);

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-entities ac-6 ───────────────────────────────────

describe("AC: @dispatch-schedule-entities ac-6 — config reload", () => {
  // AC: @dispatch-schedule-entities ac-6
  it("should detect added schedules after config reload", async () => {
    const schedule1 = makeSchedule({ id: "schedule-1", name: "Schedule 1" });
    let currentSchedules: LoadedSchedule[] = [schedule1];
    const { executor } = createMockActionExecutor();

    const engine = new ScheduleEngine({
      projectDir: "/tmp/test-project",
      eventBus,
      actionExecutor: executor,
      evaluationIntervalMs: 100_000,
      scheduleLoader: async () => currentSchedules,
    });

    await engine.start();
    expect(engine.getStatus().length).toBe(1);

    let result = await engine.triggerSchedule("schedule-2");
    expect(result.accepted).toBe(false);

    const schedule2 = makeSchedule({
      _ulid: "01TEST00000000000000000002",
      id: "schedule-2",
      name: "Schedule 2",
    });
    currentSchedules = [schedule1, schedule2];

    // Restart picks up new config
    await engine.stop();
    await engine.start();

    expect(engine.getStatus().length).toBe(2);
    result = await engine.triggerSchedule("schedule-2");
    expect(result.accepted).toBe(true);

    await engine.stop();
  });

  // AC: @dispatch-schedule-entities ac-6
  it("should remove schedules that are no longer in config", async () => {
    const schedule1 = makeSchedule({ id: "schedule-1", name: "Schedule 1" });
    const schedule2 = makeSchedule({
      _ulid: "01TEST00000000000000000002",
      id: "schedule-2",
      name: "Schedule 2",
    });
    let currentSchedules: LoadedSchedule[] = [schedule1, schedule2];
    const { executor } = createMockActionExecutor();

    const engine = new ScheduleEngine({
      projectDir: "/tmp/test-project",
      eventBus,
      actionExecutor: executor,
      evaluationIntervalMs: 100_000,
      scheduleLoader: async () => currentSchedules,
    });

    await engine.start();
    expect(engine.getStatus().length).toBe(2);

    currentSchedules = [schedule1];
    await engine.stop();
    await engine.start();

    expect(engine.getStatus().length).toBe(1);
    expect(engine.getStatus()[0].id).toBe("schedule-1");

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-runtime ac-1 ────────────────────────────────────

describe("AC: @dispatch-schedule-runtime ac-1 — volatile state and backfill", () => {
  // AC: @dispatch-schedule-runtime ac-1
  it("should reset runtime state to zero on start (volatile)", async () => {
    const schedule = makeSchedule();
    const { executor } = createMockActionExecutor();

    const engine = new ScheduleEngine({
      projectDir: "/tmp/test-project",
      eventBus,
      actionExecutor: executor,
      evaluationIntervalMs: 100_000,
      scheduleLoader: async () => [schedule],
    });

    await engine.start();

    expect(engine.getStatus()[0].run_count).toBe(0);
    expect(engine.getStatus()[0].last_tick).toBeNull();

    await engine.triggerSchedule("test-schedule");
    expect(engine.getStatus()[0].run_count).toBe(1);

    await engine.stop();
    await engine.start();

    expect(engine.getStatus()[0].run_count).toBe(0);
    expect(engine.getStatus()[0].last_tick).toBeNull();

    await engine.stop();
  });

  // AC: @dispatch-schedule-runtime ac-1
  it("should fire one catch-up tick on start for backfill: true schedules", async () => {
    const schedule = makeSchedule({ backfill: true, cron: "* * * * *" });
    const { executor, executeCalls } = createMockActionExecutor();
    const tickEvents = collectEvents(eventBus, "schedule.tick");

    const engine = new ScheduleEngine({
      projectDir: "/tmp/test-project",
      eventBus,
      actionExecutor: executor,
      evaluationIntervalMs: 100_000,
      scheduleLoader: async () => [schedule],
    });

    await engine.start();

    expect(tickEvents.length).toBe(1);
    expect(executeCalls.length).toBe(1);
    expect(engine.getStatus()[0].run_count).toBe(1);

    await engine.stop();
  });

  // AC: @dispatch-schedule-runtime ac-1
  it("should not backfill for schedules with backfill: false", async () => {
    const schedule = makeSchedule({ backfill: false, cron: "* * * * *" });
    const { engine, executeCalls } = createEngine([schedule]);

    await engine.start();

    expect(executeCalls.length).toBe(0);
    expect(engine.getStatus()[0].run_count).toBe(0);

    await engine.stop();
  });

  // AC: @dispatch-schedule-runtime ac-1
  it("should not backfill disabled schedules", async () => {
    const schedule = makeSchedule({
      backfill: true,
      enabled: false,
      cron: "* * * * *",
    });
    const { engine, executeCalls } = createEngine([schedule]);

    await engine.start();

    expect(executeCalls.length).toBe(0);

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-runtime ac-2 ────────────────────────────────────

describe("AC: @dispatch-schedule-runtime ac-2 — timezone and tick_time semantics", () => {
  // AC: @dispatch-schedule-runtime ac-2
  it("should use configured timezone for cron evaluation", async () => {
    const schedule = makeSchedule({
      timezone: "America/New_York",
      cron: "* * * * *",
    });
    const { engine } = createEngine([schedule]);
    const tickEvents = collectEvents(eventBus, "schedule.tick");

    await engine.start();

    await engine.triggerSchedule("test-schedule");

    expect(tickEvents.length).toBe(1);
    const tickTime = tickEvents[0].payload.tick_time as string;
    expect(tickTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(engine.getStatus()[0].timezone).toBe("America/New_York");

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-runtime ac-3 ────────────────────────────────────

describe("AC: @dispatch-schedule-runtime ac-3 — UTC default", () => {
  // AC: @dispatch-schedule-runtime ac-3
  it("should default to UTC when no timezone is configured", async () => {
    const schedule = makeSchedule();
    const { engine } = createEngine([schedule]);

    await engine.start();

    expect(engine.getStatus()[0].timezone).toBe("UTC");

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-runtime ac-4 ────────────────────────────────────

describe("AC: @dispatch-schedule-runtime ac-4 — manual trigger", () => {
  // AC: @dispatch-schedule-runtime ac-4
  it("should emit schedule.tick and increment run_count on manual trigger", async () => {
    const schedule = makeSchedule();
    const { engine } = createEngine([schedule]);
    const tickEvents = collectEvents(eventBus, "schedule.tick");

    await engine.start();

    expect(engine.getStatus()[0].run_count).toBe(0);

    const result = await engine.triggerSchedule("test-schedule");
    expect(result.accepted).toBe(true);
    expect(engine.getStatus()[0].run_count).toBe(1);
    expect(tickEvents.length).toBe(1);

    const result2 = await engine.triggerSchedule("test-schedule");
    expect(result2.accepted).toBe(true);
    expect(engine.getStatus()[0].run_count).toBe(2);

    await engine.stop();
  });

  // AC: @dispatch-schedule-runtime ac-4
  it("should enforce overlap policy on manual triggers", async () => {
    const schedule = makeSchedule({ overlap_policy: "skip" });
    const { engine } = createEngine([schedule], { stayRunning: true });

    await engine.start();

    const first = await engine.triggerSchedule("test-schedule");
    expect(first.accepted).toBe(true);

    const second = await engine.triggerSchedule("test-schedule");
    expect(second.accepted).toBe(false);
    expect(second.reason).toContain("skip");

    await engine.stop();
  });

  // AC: @dispatch-schedule-runtime ac-4
  it("should return error for unknown schedule ID", async () => {
    const { engine } = createEngine([]);

    await engine.start();

    const result = await engine.triggerSchedule("nonexistent-schedule");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("not found");

    await engine.stop();
  });
});

// ─── AC: @dispatch-schedule-runtime ac-5 ────────────────────────────────────

describe("AC: @dispatch-schedule-runtime ac-5 — run_count semantics", () => {
  // AC: @dispatch-schedule-runtime ac-5
  it("should increment run_count for accepted ticks regardless of action failure", async () => {
    const schedule = makeSchedule();
    const { engine } = createEngine([schedule], { fail: true });

    await engine.start();

    await engine.triggerSchedule("test-schedule");
    expect(engine.getStatus()[0].run_count).toBe(1);

    await engine.triggerSchedule("test-schedule");
    expect(engine.getStatus()[0].run_count).toBe(2);

    await engine.stop();
  });

  // AC: @dispatch-schedule-runtime ac-5
  it("should not increment run_count for skipped ticks", async () => {
    const schedule = makeSchedule({ overlap_policy: "skip" });
    const { engine } = createEngine([schedule], { stayRunning: true });

    await engine.start();

    await engine.triggerSchedule("test-schedule");
    expect(engine.getStatus()[0].run_count).toBe(1);

    await engine.triggerSchedule("test-schedule");
    expect(engine.getStatus()[0].run_count).toBe(1);

    await engine.stop();
  });
});

// ─── Trait: @trait-error-guidance ────────────────────────────────────────────

// AC: @trait-error-guidance ac-1 — N/A: ScheduleEngine is an internal runtime engine, not a CLI command
// AC: @trait-error-guidance ac-2 — N/A: ScheduleEngine is an internal runtime engine, not a CLI command
// AC: @trait-error-guidance ac-3 — N/A: ScheduleEngine is an internal runtime engine, not a CLI command
// AC: @trait-error-guidance ac-4 — N/A: ScheduleEngine is an internal runtime engine, not a CLI command
// AC: @trait-error-guidance ac-5 — N/A: ScheduleEngine is an internal runtime engine, not a CLI command
// AC: @trait-error-guidance ac-6 — N/A: ScheduleEngine is an internal runtime engine, not a CLI command

describe("Trait @trait-error-guidance N/A annotations", () => {
  it("returns structured error results (not CLI error messages)", async () => {
    const { engine } = createEngine([]);

    await engine.start();

    const result = await engine.triggerSchedule("nonexistent");
    expect(result.accepted).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect(result.reason!.length).toBeGreaterThan(0);

    await engine.stop();
  });
});

// ─── Engine lifecycle ───────────────────────────────────────────────────────

describe("ScheduleEngine lifecycle", () => {
  it("should start and stop cleanly", async () => {
    const { engine } = createEngine([]);

    expect(engine.isRunning()).toBe(false);

    await engine.start();
    expect(engine.isRunning()).toBe(true);

    await engine.stop();
    expect(engine.isRunning()).toBe(false);
  });

  it("should unsubscribe from bus events on stop", async () => {
    const { engine } = createEngine([]);

    await engine.start();
    await engine.stop();

    // After stop, emitting action events should not cause errors
    eventBus.emit({
      event_type: "action.completed",
      source_type: "schedule_engine",
      source_id: "test",
      payload: { action_run_id: "orphan" },
    });
    // Should not throw
  });
});
