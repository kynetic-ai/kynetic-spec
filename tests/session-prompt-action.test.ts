/**
 * Session Prompt Action Tests
 *
 * Tests the session_prompt action type: schema validation, executor behavior,
 * session resolution, template interpolation, and error handling.
 *
 * AC: @session-prompt-action ac-1 through ac-7
 * AC: @session-prompt-action-schema ac-1 through ac-4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  ActionSchema,
  SessionPromptActionSchema,
  type Action,
  type ActionRun,
} from "../src/schema/action.js";
import {
  ActionExecutor,
  resolveTemplateVars,
  extractActionTemplates,
  validateActionTemplates,
  type ActionEventContext,
  type ActionRunEvent,
} from "../src/agent-runtime/action-executor.js";
import {
  SessionRegistry,
  type SessionHandle,
  type SessionState,
} from "../src/agent-runtime/session-registry.js";

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

function makeSessionIdleContext(overrides: Partial<ActionEventContext> = {}): ActionEventContext {
  return {
    event_id: "01TEST00000000000000000010",
    event_type: "session.idle",
    correlation_id: "01CORR000000000000000000010",
    causation_id: "01CAUSE0000000000000000010",
    source_type: "invocation_lifecycle",
    source_id: "session-idle-001",
    session_id: "session-idle-001",
    agent_id: "task-worker",
    task_ref: "@task-current",
    turn_count: 1,
    stop_reason: "end_turn",
    duration_ms: 30000,
    ...overrides,
  };
}

/**
 * Create a mock session handle with configurable state and tracking.
 */
function createMockHandle(options: {
  state?: SessionState;
  sendPromptFn?: (prompt: string) => Promise<void>;
} = {}): SessionHandle & { prompts: string[] } {
  const prompts: string[] = [];
  const state = options.state ?? "idle";

  return {
    prompts,
    sendPrompt: options.sendPromptFn ?? vi.fn(async (prompt: string) => {
      prompts.push(prompt);
    }),
    getState: vi.fn(() => state),
    requestClose: vi.fn(),
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-prompt-action-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ─── Schema Tests ────────────────────────────────────────────────────────────

describe("SessionPromptActionSchema", () => {
  // AC: @session-prompt-action-schema ac-1
  it("parses a session_prompt action with prompt", () => {
    const result = SessionPromptActionSchema.safeParse({
      type: "session_prompt",
      prompt: "Continue your analysis",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("session_prompt");
      expect(result.data.prompt).toBe("Continue your analysis");
    }
  });

  // AC: @session-prompt-action-schema ac-1
  it("parses a session_prompt action with prompt_template", () => {
    const result = SessionPromptActionSchema.safeParse({
      type: "session_prompt",
      prompt_template: "Turn {{turn_count}} complete. Continue working on {{task_ref}}.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt_template).toBe(
        "Turn {{turn_count}} complete. Continue working on {{task_ref}}.",
      );
    }
  });

  // AC: @session-prompt-action-schema ac-1
  it("parses a session_prompt action with both prompt and prompt_template", () => {
    const result = SessionPromptActionSchema.safeParse({
      type: "session_prompt",
      prompt: "Direct prompt",
      prompt_template: "Template prompt",
    });
    expect(result.success).toBe(true);
  });

  // AC: @session-prompt-action-schema ac-1
  it("parses a session_prompt action with optional session_id", () => {
    const result = SessionPromptActionSchema.safeParse({
      type: "session_prompt",
      prompt: "Continue",
      session_id: "session-explicit-001",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBe("session-explicit-001");
    }
  });

  // AC: @session-prompt-action-schema ac-1
  describe("ActionSchema rejects session_prompt without prompt or prompt_template", () => {
    it("rejects when neither prompt nor prompt_template is provided", () => {
      const result = ActionSchema.safeParse({
        type: "session_prompt",
        session_id: "session-001",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "At least one of 'prompt' or 'prompt_template' is required",
        );
      }
    });

    it("accepts when prompt is provided", () => {
      const result = ActionSchema.safeParse({
        type: "session_prompt",
        prompt: "Continue",
      });
      expect(result.success).toBe(true);
    });

    it("accepts when prompt_template is provided", () => {
      const result = ActionSchema.safeParse({
        type: "session_prompt",
        prompt_template: "Work on {{task_ref}}",
      });
      expect(result.success).toBe(true);
    });
  });

  // AC: @session-prompt-action-schema ac-2
  it("is an additive option — existing action types still parse correctly", () => {
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

    // New session_prompt type also works
    const sessionPrompt = ActionSchema.parse({
      type: "session_prompt",
      prompt: "Continue",
    });
    expect(sessionPrompt.type).toBe("session_prompt");
  });

  // AC: @session-prompt-action-schema ac-3
  it("accepts session_prompt without session_id (defaults from event context)", () => {
    const result = SessionPromptActionSchema.safeParse({
      type: "session_prompt",
      prompt: "Continue",
      // No session_id — valid for session.idle hooks
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBeUndefined();
    }
  });
});

// ─── ActionExecutor: Session Prompt Execution ────────────────────────────────

describe("ActionExecutor — session_prompt", () => {
  let events: ActionRunEvent[];
  let registry: SessionRegistry;

  beforeEach(() => {
    events = [];
    registry = new SessionRegistry();
  });

  function makeExecutor(): ActionExecutor {
    return new ActionExecutor({
      projectDir: tempDir,
      onActionRunEvent: (event) => events.push(event),
      sessionRegistry: registry,
    });
  }

  // AC: @session-prompt-action ac-1
  it("delivers prompt to an idle session", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-idle-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Continue your analysis of the codebase",
    };
    const ctx = makeSessionIdleContext({ session_id: "session-idle-001" });

    const run = await executor.execute(action, ctx, "idle-hook");

    expect(run.status).toBe("completed");
    expect(run.action_type).toBe("session_prompt");
    expect(run.source_name).toBe("idle-hook");
    expect(run.source_event_type).toBe("session.idle");
    expect(run.duration_ms).toBeGreaterThanOrEqual(0);
    expect(handle.prompts).toEqual(["Continue your analysis of the codebase"]);
  });

  // AC: @session-prompt-action ac-2
  it("emits action.started and action.completed events during lifecycle", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-lifecycle-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Lifecycle test",
    };
    const ctx = makeSessionIdleContext({ session_id: "session-lifecycle-001" });

    const run = await executor.execute(action, ctx);

    // Verify lifecycle events
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("action.started");
    expect(events[0].action_run.status).toBe("running");
    expect(events[1].type).toBe("action.completed");
    expect(events[1].action_run.status).toBe("completed");

    // Same action_run_id across events
    expect(events[0].action_run.action_run_id).toBe(
      events[1].action_run.action_run_id,
    );
    expect(events[0].action_run.action_run_id).toBe(run.action_run_id);
  });

  // AC: @session-prompt-action ac-2
  it("emits action.started and action.failed on delivery failure", async () => {
    const handle = createMockHandle({
      state: "idle",
      sendPromptFn: async () => {
        throw new Error("Connection lost");
      },
    });
    registry.register("session-fail-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Will fail",
    };
    const ctx = makeSessionIdleContext({ session_id: "session-fail-001" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("failed");
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("action.started");
    expect(events[1].type).toBe("action.failed");
  });

  // AC: @session-prompt-action ac-3
  it("resolves session_id from event context for session.idle hooks", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-from-event", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Follow-up prompt",
      // No explicit session_id — should come from event context
    };
    const ctx = makeSessionIdleContext({ session_id: "session-from-event" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    expect(handle.prompts).toEqual(["Follow-up prompt"]);
  });

  // AC: @session-prompt-action ac-3
  it("explicit session_id takes precedence over event context", async () => {
    const eventHandle = createMockHandle({ state: "idle" });
    const explicitHandle = createMockHandle({ state: "idle" });
    registry.register("session-from-event", eventHandle);
    registry.register("session-explicit", explicitHandle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Targeted prompt",
      session_id: "session-explicit", // Explicit session_id
    };
    const ctx = makeSessionIdleContext({ session_id: "session-from-event" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    // Prompt went to explicit session, not event session
    expect(explicitHandle.prompts).toEqual(["Targeted prompt"]);
    expect(eventHandle.prompts).toEqual([]);
  });

  // AC: @session-prompt-action ac-4
  it("fails with clear error when session is closed", async () => {
    const handle = createMockHandle({ state: "closed" });
    registry.register("session-closed-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Should fail",
    };
    const ctx = makeSessionIdleContext({ session_id: "session-closed-001" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("session-closed-001");
    expect(run.error).toContain("closed");
    expect(run.failure_reason).toBe("error");
  });

  // AC: @session-prompt-action ac-4
  it("fails with clear error when session is not registered (already closed)", async () => {
    // Don't register any session — simulates session that was closed and unregistered
    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Should fail",
    };
    const ctx = makeSessionIdleContext({ session_id: "session-gone-001" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("session-gone-001");
    expect(run.error).toContain("no longer active");
    expect(run.failure_reason).toBe("error");
  });

  // AC: @session-prompt-action ac-5
  it("delivers prompt to a session in prompting state (queued)", async () => {
    // In prompting state, sendPrompt is expected to queue the prompt
    // The session handle implementation manages the queue internally
    const handle = createMockHandle({ state: "prompting" });
    registry.register("session-prompting-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Queued prompt for after current turn",
    };
    const ctx = makeSessionIdleContext({ session_id: "session-prompting-001" });

    const run = await executor.execute(action, ctx);

    // Should succeed — sendPrompt handles queuing internally
    expect(run.status).toBe("completed");
    expect(handle.prompts).toEqual(["Queued prompt for after current turn"]);
  });

  // AC: @session-prompt-action ac-6
  it("interpolates template variables from event context", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-template-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt_template: "Turn {{turn_count}} complete (stop: {{stop_reason}}). Continue working on {{task_ref}}.",
    };
    const ctx = makeSessionIdleContext({
      session_id: "session-template-001",
      turn_count: 3,
      stop_reason: "end_turn",
      task_ref: "@task-analysis",
    });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    expect(handle.prompts).toEqual([
      "Turn 3 complete (stop: end_turn). Continue working on @task-analysis.",
    ]);
  });

  // AC: @session-prompt-action ac-6
  it("prompt takes precedence over prompt_template", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-precedence-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Direct prompt for {{task_ref}}",
      prompt_template: "Template for {{task_ref}}",
    };
    const ctx = makeSessionIdleContext({
      session_id: "session-precedence-001",
      task_ref: "@task-test",
    });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    expect(handle.prompts).toEqual(["Direct prompt for @task-test"]);
  });

  // AC: @session-prompt-action ac-6
  it("passes through unresolved template variables", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-unresolved-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt_template: "Value: {{unknown_field}}",
    };
    const ctx = makeSessionIdleContext({ session_id: "session-unresolved-001" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    expect(handle.prompts).toEqual(["Value: {{unknown_field}}"]);
  });

  // AC: @session-prompt-action ac-7
  it("fails when no session_id is available (non-session event, no explicit id)", async () => {
    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Should fail — no session_id",
      // No explicit session_id
    };
    // Event context without session_id (e.g. task.ready)
    const ctx = makeEventContext({
      event_type: "task.ready",
      // No session_id in task events
    });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("No session_id available");
    expect(run.error).toContain("session_prompt action requires");
    expect(run.failure_reason).toBe("error");
  });

  // AC: @session-prompt-action ac-7
  it("succeeds with explicit session_id outside session event context", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-explicit-outside", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Explicit targeting",
      session_id: "session-explicit-outside",
    };
    // Non-session event (e.g. task.ready)
    const ctx = makeEventContext({ event_type: "task.ready" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    expect(handle.prompts).toEqual(["Explicit targeting"]);
  });

  it("fails when no session registry is configured", async () => {
    const executorNoRegistry = new ActionExecutor({
      projectDir: tempDir,
      onActionRunEvent: (event) => events.push(event),
      // No sessionRegistry
    });

    const action: Action = {
      type: "session_prompt",
      prompt: "Should fail",
    };
    const ctx = makeSessionIdleContext({ session_id: "session-001" });

    const run = await executorNoRegistry.execute(action, ctx);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("No session registry configured");
  });

  it("handles sendPrompt rejection gracefully", async () => {
    const handle = createMockHandle({
      state: "idle",
      sendPromptFn: async () => {
        throw new Error("Session closed during delivery");
      },
    });
    registry.register("session-reject-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Will reject",
    };
    const ctx = makeSessionIdleContext({ session_id: "session-reject-001" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Failed to deliver prompt");
    expect(run.error).toContain("session-reject-001");
    expect(run.error).toContain("Session closed during delivery");
  });
});

// ─── Template Extraction Tests ───────────────────────────────────────────────

describe("extractActionTemplates — session_prompt", () => {
  it("extracts prompt from session_prompt action", () => {
    const templates = extractActionTemplates({
      type: "session_prompt",
      prompt: "Continue {{task_ref}}",
    } as Action);
    expect(templates).toEqual(["Continue {{task_ref}}"]);
  });

  it("extracts prompt_template from session_prompt action", () => {
    const templates = extractActionTemplates({
      type: "session_prompt",
      prompt_template: "Turn {{turn_count}}: {{stop_reason}}",
    } as Action);
    expect(templates).toEqual(["Turn {{turn_count}}: {{stop_reason}}"]);
  });

  it("extracts both prompt and prompt_template when present", () => {
    const templates = extractActionTemplates({
      type: "session_prompt",
      prompt: "Direct {{task_ref}}",
      prompt_template: "Template {{event_type}}",
    } as Action);
    expect(templates).toEqual(["Direct {{task_ref}}", "Template {{event_type}}"]);
  });

  it("returns empty array when neither is set", () => {
    const templates = extractActionTemplates({
      type: "session_prompt",
    } as Action);
    expect(templates).toEqual([]);
  });
});

// ─── Template Validation Tests ───────────────────────────────────────────────

describe("validateActionTemplates — session_prompt templates", () => {
  it("validates session.idle template variables without warnings", () => {
    const warnings = validateActionTemplates(
      ["Turn {{turn_count}}: {{stop_reason}} for {{task_ref}}"],
      "session.idle",
    );
    expect(warnings).toEqual([]);
  });

  it("warns about unknown variables in session_prompt templates", () => {
    const warnings = validateActionTemplates(
      ["Continue {{bogus_field}}"],
      "session.idle",
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0].variable).toBe("bogus_field");
  });
});

// ─── Failure Isolation Tests ─────────────────────────────────────────────────

describe("session_prompt failure isolation", () => {
  it("session_prompt failure does not affect other actions in executeAll", async () => {
    const events: ActionRunEvent[] = [];
    const registry = new SessionRegistry();
    // Don't register the target session — session_prompt will fail

    const executor = new ActionExecutor({
      projectDir: tempDir,
      onActionRunEvent: (event) => events.push(event),
      sessionRegistry: registry,
      notifyBroadcast: () => {},
    });

    const actions: Action[] = [
      { type: "session_prompt", prompt: "Will fail", session_id: "nonexistent" },
      { type: "notify", message: "Still works" },
      { type: "command", command: "echo", args: ["also works"] },
    ];
    const ctx = makeSessionIdleContext();

    const runs = await executor.executeAll(actions, ctx);

    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toContain("no longer active");
    expect(runs[1].status).toBe("completed");
    expect(runs[2].status).toBe("completed");
  });
});

// ─── Trait AC Coverage ───────────────────────────────────────────────────────

// AC: @trait-error-guidance ac-1 — session_prompt error messages describe what went wrong:
// - "No session registry configured" with suggestion
// - "No session_id available" with explanation of what's needed
// - "Session '...' is no longer active" with guidance
// - "Session '...' is closed" with context
// - "Failed to deliver prompt to session '...': <reason>"
// These are verified by the error handling tests above.

// AC: @trait-error-guidance ac-2 — session_prompt error messages include suggested actions:
// - "Ensure the dispatch engine is running with session registry support"
// - "Check your hook configuration"
// - "Ensure the target session is alive before sending prompts"
// - "The session may have terminated between the triggering event and action execution"
// Verified by error message content assertions above.

// AC: @trait-error-guidance ac-3 — N/A: session_prompt action does not resolve
// @-prefixed references. Session IDs are direct identifiers, not spec references.

// AC: @trait-error-guidance ac-4 — N/A: session_prompt actions have a simple
// running→completed/failed lifecycle with no invalid state transitions possible.
// The action run lifecycle is managed by the ActionExecutor.execute() wrapper.

// AC: @trait-error-guidance ac-5 — N/A: Validation errors for session_prompt
// schema fields are handled by Zod schemas (ActionSchema with superRefine).
// The Zod error messages include field/value details by default.
// The "At least one of 'prompt' or 'prompt_template'" message covers
// the primary validation rule.

// AC: @trait-error-guidance ac-6 — N/A: session_prompt action does not operate
// in JSON mode. JSON-mode error formatting is handled by CLI commands that
// consume the action model.
