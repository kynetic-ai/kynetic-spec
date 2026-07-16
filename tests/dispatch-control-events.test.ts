import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  DispatchCleanupError,
  DispatchEngine,
  DISPATCH_CONTROL_FAILURE_CODE_BY_PREDICATE,
  dispatchControlErrorCodeForPredicate,
  emitDispatchControlOutcome,
  type DispatchControlLifecycleEvent,
  type DispatchControlOutcomeInput,
  type DispatchLifecycleAuthorityStore,
} from "../src/agent-runtime/dispatch.js";
import { DispatchShadowTransactionError } from "../src/agent-runtime/dispatch-shadow-transaction.js";
import type {
  DispatchControl,
  DispatchControlMutation,
  DispatchControlPublication,
} from "../src/agent-runtime/dispatch-control-store.js";
import type { EventEnvelope } from "../src/agent-runtime/event-bus.js";
import { EventBus } from "../src/agent-runtime/event-bus.js";
import { createMissingDispatchControl } from "../src/schema/dispatch-control.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import {
  DispatchControlEventPayloadSchema,
  DispatchControlErrorCodeSchema,
  validateEventPayload,
} from "../src/schema/event-payloads.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";

const TASK_ID = testUlid();
const SECOND_TASK_ID = testUlid("TASK", 2);
const tempDirs: string[] = [];

ensureSplitBackendRegistered();

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
});

function control(authority: "stopped" | "running" | "paused" = "running"): DispatchControl {
  return { ...createMissingDispatchControl(), revision: 1, global: { authority } };
}

class EngineControlStore implements DispatchLifecycleAuthorityStore {
  private publication: DispatchControlPublication;
  private listener: ((publication: DispatchControlPublication) => void) | undefined;
  private failure: unknown;
  private commitBarrier: Promise<void> | null = null;
  private releaseBarrier: (() => void) | null = null;

  constructor(snapshot: DispatchControl) {
    this.publication = {
      snapshot,
      token: { revision: snapshot.revision, commit_oid: `memory-${snapshot.revision}` },
    };
  }

  setPublicationListener(
    _key: string,
    listener: (publication: DispatchControlPublication) => void,
  ): void {
    this.listener = listener;
  }

  async loadCommitted(): Promise<DispatchControlPublication> {
    this.listener?.(this.publication);
    return this.publication;
  }

  getPublication(): DispatchControlPublication {
    return this.publication;
  }

  getDegradedReason(): string | null {
    return null;
  }

  failNextMutation(error: unknown): void {
    this.failure = error;
  }

  holdNextCommit(): () => void {
    this.commitBarrier = new Promise<void>((resolve) => {
      this.releaseBarrier = resolve;
    });
    return () => this.releaseBarrier?.();
  }

  async mutate(
    _operation: string,
    mutation: DispatchControlMutation,
  ): Promise<DispatchControlPublication> {
    if (this.failure !== undefined) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
    const next = await mutation(structuredClone(this.publication.snapshot));
    if (this.commitBarrier) {
      await this.commitBarrier;
      this.commitBarrier = null;
      this.releaseBarrier = null;
    }
    if (next !== null) {
      this.publication = {
        snapshot: next,
        token: { revision: next.revision, commit_oid: `memory-${next.revision}` },
      };
    }
    this.listener?.(this.publication);
    return this.publication;
  }
}

async function createEngineFixture(
  options: {
    authority?: "stopped" | "running" | "paused";
    snapshot?: DispatchControl;
    duplicateTaskSlug?: boolean;
    callbackError?: Error;
  } = {},
): Promise<{
  engine: DispatchEngine;
  store: EngineControlStore;
  callbackEvents: DispatchControlLifecycleEvent[];
  busEvents: EventEnvelope[];
}> {
  const projectDir = await createTempDir("dispatch-control-events-");
  tempDirs.push(projectDir);
  initGitRepo(projectDir);
  await fs.writeFile(
    path.join(projectDir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1.1", title: "Control events", task_storage: { format: "split" } }),
  );
  const writeTask = (taskId: string, slug: string) =>
    seedSplitTask(projectDir, {
      _ulid: taskId,
      type: "task",
      title: slug,
      slugs: [slug],
      status: "pending",
      priority: 1,
      automation: "eligible",
      depends_on: [],
      blocked_by: [],
      tags: [],
      notes: [],
      created_at: new Date().toISOString(),
    });
  writeTask(TASK_ID, "task-alpha");
  writeTask(SECOND_TASK_ID, options.duplicateTaskSlug ? "task-alpha" : "task-beta");

  const store = new EngineControlStore(options.snapshot ?? control(options.authority));
  const callbackEvents: DispatchControlLifecycleEvent[] = [];
  const engine = new DispatchEngine({
    projectDir,
    specDir: projectDir,
    reconcileIntervalMs: 0,
    coalesceWindowMs: 0,
    lifecycleStore: store,
    onDispatchControlEvent: (event) => {
      callbackEvents.push(event);
      if (options.callbackError) throw options.callbackError;
    },
  });
  const busEvents = captureDispatchControlEvents(engine.eventBus);
  return { engine, store, callbackEvents, busEvents };
}

function captureDispatchControlEvents(bus: EventBus): EventEnvelope[] {
  const captured: EventEnvelope[] = [];
  bus.subscribe("dispatch_control.*", (event) => captured.push(event));
  return captured;
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

describe("DispatchEngine lifecycle audit boundary", () => {
  // AC: @dispatch-lifecycle-control-authority ac-applied-control-is-auditable
  it("emits one applied event only after the lifecycle store commits", async () => {
    const fixture = await createEngineFixture({ authority: "running" });
    const releaseCommit = fixture.store.holdNextCommit();

    const pending = fixture.engine.applyGlobalLifecycleAction("pause", {
      reason: "operator request",
      actor: "operator",
      source: "api",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fixture.callbackEvents).toEqual([]);
    expect(fixture.busEvents).toEqual([]);

    releaseCommit();
    await expect(pending).resolves.toEqual({ outcome: "applied", authority: "paused" });
    expect(fixture.callbackEvents).toHaveLength(1);
    expect(fixture.callbackEvents[0]).toMatchObject({
      type: "dispatch_control.pause_applied",
      data: { scope: "global", action: "pause", outcome: "applied", authority: "paused" },
    });
    expect(fixture.busEvents).toHaveLength(1);
  });

  // AC: @dispatch-lifecycle-control-authority ac-applied-control-is-auditable
  it("does not reclassify a committed outcome when publication delivery throws", async () => {
    const callbackError = new Error("injected agents publication failure");
    const fixture = await createEngineFixture({ authority: "running", callbackError });

    await expect(
      fixture.engine.applyGlobalLifecycleAction("pause", {
        reason: "operator request",
        actor: "operator",
        source: "api",
      }),
    ).resolves.toEqual({ outcome: "applied", authority: "paused" });

    expect(fixture.engine.getLifecycleStatus().globalAuthority).toBe("paused");
    expect(fixture.callbackEvents).toHaveLength(1);
    expect(fixture.callbackEvents[0]?.type).toBe("dispatch_control.pause_applied");
    expect(fixture.busEvents).toHaveLength(1);
    expect(fixture.busEvents[0]?.event_type).toBe("dispatch_control.pause_applied");
  });

  // AC: @dispatch-lifecycle-control-authority ac-noop-control-is-auditable
  it("emits one noop event only after committed state is observed", async () => {
    const fixture = await createEngineFixture({ authority: "paused" });
    const releaseCommit = fixture.store.holdNextCommit();

    const pending = fixture.engine.applyGlobalLifecycleAction("pause", { source: "api" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fixture.callbackEvents).toEqual([]);
    expect(fixture.busEvents).toEqual([]);

    releaseCommit();
    await expect(pending).resolves.toEqual({ outcome: "noop", authority: "paused" });
    expect(fixture.callbackEvents).toHaveLength(1);
    expect(fixture.callbackEvents[0]).toMatchObject({
      type: "dispatch_control.noop",
      data: { scope: "global", action: "pause", outcome: "noop", authority: "paused" },
    });
    expect(fixture.busEvents).toHaveLength(1);
  });

  // AC: @dispatch-lifecycle-control-authority ac-failed-control-is-auditable
  it("emits task failures for resolved aliases and identity-neutral failures before canonicalization", async () => {
    const timestamp = new Date().toISOString();
    const stoppedTaskSnapshot: DispatchControl = {
      ...control("running"),
      revision: 2,
      tasks: {
        [TASK_ID]: {
          mode: "stopped",
          reason: "stop A",
          actor: "operator",
          source: "api",
          controlled_at: timestamp,
          updated_at: timestamp,
        },
      },
    };
    const fixture = await createEngineFixture({ snapshot: stoppedTaskSnapshot });

    await expect(
      fixture.engine.applyTaskLifecycleAction("pause", { taskRef: "@task-alpha" }),
    ).rejects.toMatchObject({ name: "DispatchLifecycleTransitionError" });
    await expect(
      fixture.engine.applyTaskLifecycleAction("pause", { taskRef: "@missing-task" }),
    ).rejects.toMatchObject({ code: "unresolved-task-ref" });

    expect(fixture.callbackEvents).toHaveLength(2);
    expect(fixture.callbackEvents[0]).toMatchObject({
      type: "dispatch_control.failed",
      data: {
        scope: "task",
        task_id: TASK_ID,
        task_ref: "@task-alpha",
        error_code: "invalid_transition",
      },
    });
    expect(fixture.callbackEvents[1]).toMatchObject({
      type: "dispatch_control.failed",
      data: { scope: "global", action: "pause", error_code: "task_not_found" },
    });
    expect(fixture.callbackEvents[1]?.data).not.toHaveProperty("task_id");
    expect(fixture.callbackEvents[1]?.data).not.toHaveProperty("task_ref");
    expect(fixture.busEvents).toHaveLength(2);
  });

  // AC: @dispatch-lifecycle-control-authority ac-failed-control-is-auditable
  // AC: @dispatch-lifecycle-control-authority ac-failure-events-use-closed-error-codes
  it("maps every engine failure class to one closed failed event", async () => {
    const observedCodes: string[] = [];
    const actualIdentityCases = [
      {
        code: "validation_failed",
        fixture: () => createEngineFixture(),
        invoke: (engine: DispatchEngine) => engine.applyTaskLifecycleAction("pause", {}),
      },
      {
        code: "task_not_found",
        fixture: () => createEngineFixture(),
        invoke: (engine: DispatchEngine) =>
          engine.applyTaskLifecycleAction("pause", { taskRef: "@missing-task" }),
      },
      {
        code: "task_identity_ambiguous",
        fixture: () => createEngineFixture({ duplicateTaskSlug: true }),
        invoke: (engine: DispatchEngine) =>
          engine.applyTaskLifecycleAction("pause", { taskRef: "@task-alpha" }),
      },
      {
        code: "task_identity_mismatch",
        fixture: () => createEngineFixture(),
        invoke: (engine: DispatchEngine) =>
          engine.applyTaskLifecycleAction("pause", {
            taskId: TASK_ID,
            taskRef: "@task-beta",
          }),
      },
    ] as const;

    for (const identityCase of actualIdentityCases) {
      const fixture = await identityCase.fixture();
      await expect(identityCase.invoke(fixture.engine)).rejects.toBeDefined();
      expect(fixture.callbackEvents).toHaveLength(1);
      expect(fixture.callbackEvents[0]).toMatchObject({
        type: "dispatch_control.failed",
        data: { outcome: "failed", error_code: identityCase.code },
      });
      observedCodes.push(String(fixture.callbackEvents[0]?.data.error_code));
      expect(fixture.busEvents).toHaveLength(1);
    }

    const timestamp = new Date().toISOString();
    const matrixSnapshot: DispatchControl = {
      ...control("running"),
      revision: 2,
      tasks: {
        [TASK_ID]: {
          mode: "stopped",
          reason: "stop A",
          actor: "operator",
          source: "api",
          controlled_at: timestamp,
          updated_at: timestamp,
        },
      },
    };
    const matrixFixture = await createEngineFixture({ snapshot: matrixSnapshot });
    await expect(
      matrixFixture.engine.applyTaskLifecycleAction("pause", { taskRef: "@task-alpha" }),
    ).rejects.toBeDefined();
    expect(matrixFixture.callbackEvents).toHaveLength(1);
    expect(matrixFixture.callbackEvents[0]?.data.error_code).toBe("invalid_transition");
    observedCodes.push(String(matrixFixture.callbackEvents[0]?.data.error_code));

    const injectedFailures: ReadonlyArray<readonly [unknown, string]> = [
      [new Error("Timed out waiting for file lock"), "control_store_unavailable"],
      [new Error("Invalid dispatch-control.yaml committed object"), "control_store_corrupt"],
      [
        new DispatchShadowTransactionError("control_commit_failed", "commit returned false"),
        "control_commit_failed",
      ],
      [new DispatchCleanupError("cancellation_timeout", "timed out"), "cancellation_timeout"],
      [new DispatchCleanupError("cancellation_failed", "signal failed"), "cancellation_failed"],
      [
        new DispatchCleanupError("session_closure_failed", "session close failed"),
        "session_closure_failed",
      ],
      [
        new DispatchCleanupError("cleanup_ownership_mismatch", "ownership mismatch"),
        "cleanup_ownership_mismatch",
      ],
      [
        new DispatchCleanupError("cleanup_process_birth_mismatch", "birth mismatch"),
        "cleanup_process_birth_mismatch",
      ],
      [
        new DispatchCleanupError(
          "cleanup_leader_missing_group_alive",
          "leader missing with live group",
        ),
        "cleanup_leader_missing_group_alive",
      ],
      [
        new DispatchCleanupError("cleanup_identity_unverifiable", "identity unverifiable"),
        "cleanup_identity_unverifiable",
      ],
      [
        new DispatchCleanupError("cleanup_group_unverifiable", "group unverifiable"),
        "cleanup_group_unverifiable",
      ],
      [new Error("unexpected lifecycle fault"), "internal_error"],
    ];

    for (const [failure, expectedCode] of injectedFailures) {
      const fixture = await createEngineFixture({ authority: "running" });
      fixture.store.failNextMutation(failure);
      await expect(fixture.engine.applyGlobalLifecycleAction("pause")).rejects.toBe(failure);
      expect(fixture.callbackEvents).toHaveLength(1);
      expect(fixture.callbackEvents[0]).toMatchObject({
        type: "dispatch_control.failed",
        data: { scope: "global", outcome: "failed", error_code: expectedCode },
      });
      observedCodes.push(String(fixture.callbackEvents[0]?.data.error_code));
      expect(fixture.busEvents).toHaveLength(1);
    }

    expect(observedCodes).toHaveLength(17);
    expect(new Set(observedCodes)).toHaveLength(17);
  });
});

// AC: @dispatch-event-taxonomy ac-dispatch-control-domain
// AC: @dispatch-event-payload ac-dispatch-control-common-fields
// AC: @dispatch-event-payload ac-dispatch-control-global-identity-absence
describe("dispatch control outcome identifiers", () => {
  it.each(["start", "pause", "resume", "stop"] as const)(
    "formats an applied %s outcome with its matching identifier",
    async (action) => {
      const bus = new EventBus();
      const captured = captureDispatchControlEvents(bus);
      emitDispatchControlOutcome(bus, {
        ...baseGlobalInput,
        action,
        outcome: "applied",
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
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
      expect(captured[0]?.payload).not.toHaveProperty("task_id");
      expect(captured[0]?.payload).not.toHaveProperty("task_ref");
      expect(captured[0]?.payload).not.toHaveProperty("error_code");
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
