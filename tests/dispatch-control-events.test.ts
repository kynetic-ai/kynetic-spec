import { describe, expect, it } from "vitest";
import {
  DISPATCH_CONTROL_FAILURE_CODE_BY_PREDICATE,
  dispatchControlErrorCodeForPredicate,
  emitDispatchControlOutcome,
  type DispatchControlOutcomeInput,
} from "../src/agent-runtime/dispatch.js";
import type { EventEnvelope } from "../src/agent-runtime/event-bus.js";
import { EventBus } from "../src/agent-runtime/event-bus.js";
import {
  DispatchControlEventPayloadSchema,
  DispatchControlErrorCodeSchema,
  validateEventPayload,
} from "../src/schema/event-payloads.js";
import { testUlid } from "./helpers/cli.js";

const TASK_ID = testUlid();

function captureDispatchControlEvents(bus: EventBus): EventEnvelope[] {
  const captured: EventEnvelope[] = [];
  bus.subscribe("dispatch_control.*", (event) => captured.push(event));
  return captured;
}

async function emitOutcomeFixture(
  input: DispatchControlOutcomeInput,
): Promise<{ captured: EventEnvelope[]; releaseCommit: () => void }> {
  const bus = new EventBus();
  const captured = captureDispatchControlEvents(bus);
  let releaseCommit!: () => void;
  const commitBarrier = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  void commitBarrier.then(() => emitDispatchControlOutcome(bus, input));
  return { captured, releaseCommit };
}

const baseGlobalInput = {
  scope: "global" as const,
  authority: "running" as const,
  projection: "running" as const,
  reason: "operator request",
  actor: "operator",
  source: "api" as const,
  timestamp: "2026-07-15T12:00:00.000Z",
};

// AC: @dispatch-event-taxonomy ac-dispatch-control-domain
// AC: @dispatch-event-payload ac-dispatch-control-common-fields
// AC: @dispatch-event-payload ac-dispatch-control-global-identity-absence
describe("dispatch control outcome identifiers", () => {
  it.each(["start", "pause", "resume", "stop"] as const)(
    "emits dispatch_control.%s_applied after the commit barrier",
    async (action) => {
      const fixture = await emitOutcomeFixture({
        ...baseGlobalInput,
        action,
        outcome: "applied",
      });

      expect(fixture.captured).toHaveLength(0);
      fixture.releaseCommit();
      await new Promise((resolve) => setImmediate(resolve));

      expect(fixture.captured).toHaveLength(1);
      expect(fixture.captured[0]).toMatchObject({
        event_type: `dispatch_control.${action}_applied`,
        source_type: "api",
        source_id: "dispatch-control:global",
        payload: {
          scope: "global",
          action,
          authority: "running",
          projection: "running",
          outcome: "applied",
          reason: "operator request",
          actor: "operator",
          source: "api",
          timestamp: "2026-07-15T12:00:00.000Z",
        },
      });
      expect(fixture.captured[0]?.payload).not.toHaveProperty("task_id");
      expect(fixture.captured[0]?.payload).not.toHaveProperty("task_ref");
      expect(fixture.captured[0]?.payload).not.toHaveProperty("error_code");
    },
  );

  it("emits a single noop event without an error code", async () => {
    const bus = new EventBus();
    const captured = captureDispatchControlEvents(bus);
    emitDispatchControlOutcome(bus, {
      ...baseGlobalInput,
      action: "start",
      outcome: "noop",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.event_type).toBe("dispatch_control.noop");
    expect(captured[0]?.payload.outcome).toBe("noop");
    expect(captured[0]?.payload).not.toHaveProperty("error_code");
  });

  it("publishes the same sanitized outcome through the agents callback", () => {
    const published: unknown[] = [];
    emitDispatchControlOutcome(
      new EventBus(),
      { ...baseGlobalInput, action: "pause", outcome: "applied" },
      (event) => published.push(event),
    );
    expect(published).toEqual([
      {
        type: "dispatch_control.pause_applied",
        data: {
          ...baseGlobalInput,
          action: "pause",
          outcome: "applied",
        },
      },
    ]);
  });
});

// AC: @dispatch-event-payload ac-dispatch-control-error-codes
// AC: @dispatch-event-payload ac-dispatch-control-failure-error-code-presence
// AC: @dispatch-event-payload ac-dispatch-control-no-raw-error
describe("closed dispatch control failure mapping", () => {
  const expected = {
    request_validation: "validation_failed",
    missing_task: "task_not_found",
    multiple_resolved_tasks: "task_identity_ambiguous",
    submitted_identity_disagreement: "task_identity_mismatch",
    matrix_rejection: "invalid_transition",
    control_store_io_or_timeout: "control_store_unavailable",
    malformed_committed_control: "control_store_corrupt",
    commit_or_verification_failure: "control_commit_failed",
    bounded_cancellation_wait: "cancellation_timeout",
    verified_signal_failure: "cancellation_failed",
    durable_session_close_failure: "session_closure_failed",
    cleanup_ownership_tuple_mismatch: "cleanup_ownership_mismatch",
    cleanup_process_birth_mismatch: "cleanup_process_birth_mismatch",
    cleanup_leader_missing_group_alive: "cleanup_leader_missing_group_alive",
    cleanup_identity_unverifiable: "cleanup_identity_unverifiable",
    cleanup_group_unverifiable: "cleanup_group_unverifiable",
    uncategorized_fault: "internal_error",
  } as const;

  it("maps every exhaustive predicate to exactly one closed code", () => {
    expect(DISPATCH_CONTROL_FAILURE_CODE_BY_PREDICATE).toEqual(expected);
    expect(Object.keys(expected)).toHaveLength(17);
    expect(new Set(Object.values(expected))).toHaveLength(17);
    for (const [predicate, code] of Object.entries(expected)) {
      expect(dispatchControlErrorCodeForPredicate(predicate as keyof typeof expected)).toBe(code);
      expect(DispatchControlErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it.each(Object.entries(expected))("emits %s as %s exactly once", async (predicate, errorCode) => {
    const bus = new EventBus();
    const captured = captureDispatchControlEvents(bus);
    emitDispatchControlOutcome(bus, {
      scope: "task",
      action: "stop",
      authority: "stopped",
      projection: "stopped",
      outcome: "failed",
      failurePredicate: predicate as keyof typeof expected,
      reason: "operator request",
      actor: "operator",
      source: "recovery",
      timestamp: "2026-07-15T12:00:00.000Z",
      taskId: TASK_ID,
      taskRef: "@task-example",
      rawError: new Error("secret raw failure"),
    } as DispatchControlOutcomeInput & { rawError: Error });
    await new Promise((resolve) => setImmediate(resolve));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.event_type).toBe("dispatch_control.failed");
    expect(captured[0]?.payload).toMatchObject({
      scope: "task",
      task_id: TASK_ID,
      task_ref: "@task-example",
      outcome: "failed",
      error_code: errorCode,
    });
    expect(captured[0]?.payload).not.toHaveProperty("error");
    expect(captured[0]?.payload).not.toHaveProperty("rawError");
  });

  it("rejects every non-enum error code", () => {
    for (const code of ["", "timeout", "CONTROL_COMMIT_FAILED", "control_verification_failed"]) {
      expect(DispatchControlErrorCodeSchema.safeParse(code).success).toBe(false);
      expect(
        DispatchControlEventPayloadSchema.safeParse({
          ...baseGlobalInput,
          action: "stop",
          outcome: "failed",
          error_code: code,
        }).success,
      ).toBe(false);
    }
  });
});

// AC: @dispatch-event-payload ac-dispatch-control-task-canonical-identity
// AC: @dispatch-event-payload ac-dispatch-control-reason-bound
// AC: @dispatch-event-payload ac-dispatch-control-actor-bound
// AC: @dispatch-event-payload ac-dispatch-control-task-ref-bound
// AC: @dispatch-event-payload ac-dispatch-control-whitespace-normalization
// AC: @dispatch-event-payload ac-dispatch-control-control-character-removal
// AC: @dispatch-event-payload ac-dispatch-control-no-prompts
// AC: @dispatch-event-payload ac-dispatch-control-no-secrets
// AC: @dispatch-event-payload ac-dispatch-control-no-terminal-buffer
// AC: @dispatch-event-payload ac-dispatch-control-no-workspace-path
// AC: @dispatch-event-payload ac-dispatch-control-no-raw-input-error
describe("dispatch control payload sanitization", () => {
  it("normalizes and code-point bounds only the approved payload fields", async () => {
    const bus = new EventBus();
    const captured = captureDispatchControlEvents(bus);
    emitDispatchControlOutcome(bus, {
      scope: "task",
      action: "pause",
      authority: "paused",
      projection: "draining",
      outcome: "applied",
      reason: `  hello\u0000\n   world ${"😀".repeat(300)}  `,
      actor: `  operator\u007f ${"a".repeat(200)}  `,
      source: "ui",
      timestamp: "2026-07-15T12:00:00.000Z",
      taskId: TASK_ID,
      taskRef: `  @task\u0001   example ${"r".repeat(250)}  `,
      prompt: "secret prompt",
      secret: "token",
      terminalBuffer: "terminal output",
      workspacePath: "/private/workspace",
      rawInputError: new Error("raw input"),
    } as DispatchControlOutcomeInput & Record<string, unknown>);
    await new Promise((resolve) => setImmediate(resolve));

    const payload = captured[0]?.payload;
    expect(payload).toBeDefined();
    expect(Array.from(payload?.reason as string)).toHaveLength(240);
    expect(Array.from(payload?.actor as string)).toHaveLength(120);
    expect(Array.from(payload?.task_ref as string)).toHaveLength(200);
    expect(payload?.reason).toMatch(/^hello world /);
    expect(payload?.actor).toMatch(/^operator /);
    expect(payload?.task_ref).toMatch(/^@task example /);
    for (const field of ["reason", "actor", "task_ref"] as const) {
      expect(payload?.[field]).not.toMatch(/[\p{Cc}]/u);
      expect(payload?.[field]).not.toMatch(/^\s|\s$/);
      expect(payload?.[field]).not.toMatch(/\s{2,}/);
    }
    expect(Object.keys(payload ?? {}).toSorted()).toEqual(
      [
        "action",
        "actor",
        "authority",
        "outcome",
        "projection",
        "reason",
        "scope",
        "source",
        "task_id",
        "task_ref",
        "timestamp",
      ].toSorted(),
    );
  });

  it("defaults an omitted reason to operator request", () => {
    const result = emitDispatchControlOutcome(new EventBus(), {
      ...baseGlobalInput,
      reason: undefined,
      action: "start",
      outcome: "noop",
    });
    expect(result.event?.payload.reason).toBe("operator request");
  });

  it("requires canonical task identity and enforces global identity absence", () => {
    expect(
      DispatchControlEventPayloadSchema.safeParse({
        ...baseGlobalInput,
        scope: "task",
        action: "pause",
        outcome: "applied",
      }).success,
    ).toBe(false);
    expect(
      DispatchControlEventPayloadSchema.safeParse({
        ...baseGlobalInput,
        action: "pause",
        outcome: "applied",
        task_id: TASK_ID,
      }).success,
    ).toBe(false);
  });

  it("validates emitted payloads through the registry lookup", () => {
    const emitted = emitDispatchControlOutcome(new EventBus(), {
      ...baseGlobalInput,
      action: "resume",
      outcome: "applied",
    });
    expect(validateEventPayload(emitted.event!.event_type, emitted.event!.payload).success).toBe(
      true,
    );
  });
});
