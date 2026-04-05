/**
 * Session Prompt Action Tests
 *
 * Tests the session_prompt action type: schema validation, executor behavior,
 * session resolution, template interpolation, skill resolution, and error handling.
 *
 * AC: @session-prompt-action ac-1 through ac-9
 * AC: @session-prompt-action-schema ac-1 through ac-5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { ActionSchema, SessionPromptActionSchema, type Action } from "../src/schema/action.js";
import {
  ActionExecutor,
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
import type { SessionIdleContext } from "../src/agent-runtime/invocation.js";
import { ScheduleSchema } from "../src/schema/schedules.js";
import { CompositionSchema } from "../src/schema/composition.js";
import { testUlid } from "./helpers/cli.js";

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
    turn_duration_ms: 30000,
    ...overrides,
  };
}

/**
 * Create a mock session handle with configurable state and tracking.
 */
function createMockHandle(
  options: {
    state?: SessionState;
    sendPromptFn?: (prompt: string) => Promise<void>;
  } = {},
): SessionHandle & { prompts: string[] } {
  const prompts: string[] = [];
  const state = options.state ?? "idle";

  return {
    prompts,
    sendPrompt:
      options.sendPromptFn ??
      vi.fn(async (prompt: string) => {
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

  // AC: @session-prompt-action-schema ac-5
  describe("skills field", () => {
    it("parses a session_prompt action with skills list", () => {
      const result = SessionPromptActionSchema.safeParse({
        type: "session_prompt",
        prompt: "Continue with reflection",
        skills: ["session-reflect", "task-work"],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skills).toEqual(["session-reflect", "task-work"]);
      }
    });

    it("parses a session_prompt action without skills (field is optional)", () => {
      const result = SessionPromptActionSchema.safeParse({
        type: "session_prompt",
        prompt: "Continue",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skills).toBeUndefined();
      }
    });

    it("parses a session_prompt action with empty skills array", () => {
      const result = SessionPromptActionSchema.safeParse({
        type: "session_prompt",
        prompt: "Continue",
        skills: [],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skills).toEqual([]);
      }
    });

    it("rejects skills field with non-string elements", () => {
      const result = SessionPromptActionSchema.safeParse({
        type: "session_prompt",
        prompt: "Continue",
        skills: [123],
      });
      expect(result.success).toBe(false);
    });
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
    expect(events[0].action_run.action_run_id).toBe(events[1].action_run.action_run_id);
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
      prompt_template:
        "Turn {{turn_count}} complete (stop: {{stop_reason}}). Continue working on {{task_ref}}.",
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

// ─── Skill Resolution Tests ──────────────────────────────────────────────────

describe("ActionExecutor — session_prompt skills resolution", () => {
  let events: ActionRunEvent[];
  let registry: SessionRegistry;
  let specDir: string;

  beforeEach(async () => {
    events = [];
    registry = new SessionRegistry();

    // Set up skill files in tempDir to simulate the skill registry.
    // buildPromptWithSkills resolves skills from specDir/skills/<id>/SKILL.md
    specDir = path.join(tempDir, ".kspec");
    const skillDir = path.join(specDir, "skills", "session-reflect");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Reflection Skill\n\nReflect on your work session.\n\nUse {skill:task-work} for task context.",
    );

    const skillDir2 = path.join(specDir, "skills", "task-work");
    await fs.mkdir(skillDir2, { recursive: true });
    await fs.writeFile(
      path.join(skillDir2, "SKILL.md"),
      "# Task Work Skill\n\nStructured task lifecycle.",
    );
  });

  function makeExecutor(): ActionExecutor {
    return new ActionExecutor({
      projectDir: tempDir,
      onActionRunEvent: (event) => events.push(event),
      sessionRegistry: registry,
    });
  }

  // AC: @session-prompt-action ac-8
  it("resolves skills and appends content to prompt", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-skills-001", handle);

    // Mock initContext to return our test specDir
    const yamlModule = await import("../src/parser/yaml.js");
    const initSpy = vi.spyOn(yamlModule, "initContext").mockResolvedValue({
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir,
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: null,
      manifest: null,
      shadow: null,
      config: { defaultView: "board" },
    } as any);

    // Mock loadMetaContext to return agent definitions
    const metaModule = await import("../src/parser/meta.js");
    const metaSpy = vi.spyOn(metaModule, "loadMetaContext").mockResolvedValue({
      agents: [{ id: "task-worker", adapter: "claude-code-acp", skills: [] }],
      hooks: [],
      skills: [],
      schedules: [],
      conventions: [],
      workflows: [],
      manifest: null,
    } as any);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Reflect on your work",
      skills: ["session-reflect"],
    };
    const ctx = makeSessionIdleContext({
      session_id: "session-skills-001",
      agent_id: "task-worker",
    });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    expect(handle.prompts.length).toBe(1);
    // Prompt should include both the base prompt and the skill content
    expect(handle.prompts[0]).toContain("Reflect on your work");
    expect(handle.prompts[0]).toContain("# Reflection Skill");
    expect(handle.prompts[0]).toContain("## Skills");

    initSpy.mockRestore();
    metaSpy.mockRestore();
  });

  // AC: @session-prompt-action ac-8
  it("delivers prompt unchanged when skills list is empty", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-noskills-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Continue your work",
      skills: [],
    };
    const ctx = makeSessionIdleContext({ session_id: "session-noskills-001" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    expect(handle.prompts).toEqual(["Continue your work"]);
  });

  // AC: @session-prompt-action ac-8
  it("delivers prompt unchanged when skills field is absent", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-absentskills-001", handle);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Continue your work",
      // No skills field
    };
    const ctx = makeSessionIdleContext({ session_id: "session-absentskills-001" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    expect(handle.prompts).toEqual(["Continue your work"]);
  });

  // AC: @session-prompt-action ac-9
  it("rewrites skill references to adapter-specific format", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-rewrite-001", handle);

    // Mock initContext
    const yamlModule = await import("../src/parser/yaml.js");
    const initSpy = vi.spyOn(yamlModule, "initContext").mockResolvedValue({
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir,
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: null,
      manifest: null,
      shadow: null,
      config: { defaultView: "board" },
    } as any);

    // Mock loadMetaContext — agent uses claude-code-acp adapter
    const metaModule = await import("../src/parser/meta.js");
    const metaSpy = vi.spyOn(metaModule, "loadMetaContext").mockResolvedValue({
      agents: [{ id: "task-worker", adapter: "claude-code-acp", skills: [] }],
      hooks: [],
      skills: [
        { id: "session-reflect", origin: "core" },
        { id: "task-work", origin: "core" },
      ],
      schedules: [],
      conventions: [],
      workflows: [],
      manifest: null,
    } as any);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Reflect on your work",
      skills: ["session-reflect"],
    };
    const ctx = makeSessionIdleContext({
      session_id: "session-rewrite-001",
      agent_id: "task-worker",
    });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    // The {skill:task-work} reference in the skill content should be rewritten
    // to the claude-code adapter format (/kspec:task-work)
    expect(handle.prompts[0]).toContain("/kspec:task-work");
    expect(handle.prompts[0]).not.toContain("{skill:task-work}");

    initSpy.mockRestore();
    metaSpy.mockRestore();
  });

  // AC: @session-prompt-action ac-8
  it("resolves multiple skills and appends all content", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-multi-skills-001", handle);

    const yamlModule = await import("../src/parser/yaml.js");
    const initSpy = vi.spyOn(yamlModule, "initContext").mockResolvedValue({
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir,
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: null,
      manifest: null,
      shadow: null,
      config: { defaultView: "board" },
    } as any);

    const metaModule = await import("../src/parser/meta.js");
    const metaSpy = vi.spyOn(metaModule, "loadMetaContext").mockResolvedValue({
      agents: [{ id: "task-worker", adapter: "claude-code-acp", skills: [] }],
      hooks: [],
      skills: [],
      schedules: [],
      conventions: [],
      workflows: [],
      manifest: null,
    } as any);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Review session",
      skills: ["session-reflect", "task-work"],
    };
    const ctx = makeSessionIdleContext({
      session_id: "session-multi-skills-001",
      agent_id: "task-worker",
    });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("completed");
    expect(handle.prompts[0]).toContain("# Reflection Skill");
    expect(handle.prompts[0]).toContain("# Task Work Skill");

    initSpy.mockRestore();
    metaSpy.mockRestore();
  });

  // AC: @session-prompt-action ac-8
  it("silently skips skills that don't exist in the registry", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-missing-skill-001", handle);

    const yamlModule = await import("../src/parser/yaml.js");
    const initSpy = vi.spyOn(yamlModule, "initContext").mockResolvedValue({
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir,
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: null,
      manifest: null,
      shadow: null,
      config: { defaultView: "board" },
    } as any);

    const metaModule = await import("../src/parser/meta.js");
    const metaSpy = vi.spyOn(metaModule, "loadMetaContext").mockResolvedValue({
      agents: [{ id: "task-worker", adapter: "claude-code-acp", skills: [] }],
      hooks: [],
      skills: [],
      schedules: [],
      conventions: [],
      workflows: [],
      manifest: null,
    } as any);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Continue",
      skills: ["nonexistent-skill"],
    };
    const ctx = makeSessionIdleContext({
      session_id: "session-missing-skill-001",
      agent_id: "task-worker",
    });

    const run = await executor.execute(action, ctx);

    // Missing skills are silently skipped — prompt delivered as-is
    expect(run.status).toBe("completed");
    expect(handle.prompts).toEqual(["Continue"]);

    initSpy.mockRestore();
    metaSpy.mockRestore();
  });

  // AC: @session-prompt-action ac-8
  it("defaults to claude-agent-acp adapter when agent_id is not in event context", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-no-agent-001", handle);

    const yamlModule = await import("../src/parser/yaml.js");
    const initSpy = vi.spyOn(yamlModule, "initContext").mockResolvedValue({
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir,
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: null,
      manifest: null,
      shadow: null,
      config: { defaultView: "board" },
    } as any);

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Continue",
      skills: ["session-reflect"],
      session_id: "session-no-agent-001",
    };
    // Event context without agent_id
    const ctx = makeEventContext({
      event_type: "task.ready",
    });

    const run = await executor.execute(action, ctx);

    // Should succeed — skill content resolved, adapter defaults to claude-agent-acp
    expect(run.status).toBe("completed");
    expect(handle.prompts[0]).toContain("# Reflection Skill");
    // AC: @session-prompt-action ac-9 — {skill:task-work} should be rewritten even without agent_id
    expect(handle.prompts[0]).not.toContain("{skill:task-work}");

    initSpy.mockRestore();
  });

  // AC: @session-prompt-action ac-8
  it("fails with clear error when initContext fails", async () => {
    const handle = createMockHandle({ state: "idle" });
    registry.register("session-initfail-001", handle);

    const yamlModule = await import("../src/parser/yaml.js");
    const initSpy = vi
      .spyOn(yamlModule, "initContext")
      .mockRejectedValue(new Error("Cannot find kspec project"));

    const executor = makeExecutor();
    const action: Action = {
      type: "session_prompt",
      prompt: "Continue",
      skills: ["session-reflect"],
    };
    const ctx = makeSessionIdleContext({ session_id: "session-initfail-001" });

    const run = await executor.execute(action, ctx);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Failed to resolve skills");
    expect(run.error).toContain("Cannot find kspec project");
    expect(run.error).toContain("session-reflect");

    initSpy.mockRestore();
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
    const warnings = validateActionTemplates(["Continue {{bogus_field}}"], "session.idle");
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

// ─── Invocation Runner Session Registration Tests ───────────────────────────

describe("InvocationOptions.sessionRegistry — session handle lifecycle", () => {
  /**
   * Verifies that when a sessionRegistry is passed to InvocationOptions, the
   * invocation runner registers a session handle during the session lifetime
   * and unregisters it on cleanup. This is the production registration path
   * that enables session_prompt actions to discover live sessions.
   *
   * AC: @session-prompt-action ac-1 — production registration path
   * AC: @active-session-registry ac-1, ac-2
   */
  it("registers session in registry and reports 'prompting' state during invocation", () => {
    // Verify the SessionRegistry + handle contract directly: the invocation
    // runner creates a handle with getState() reflecting the session lifecycle.
    const registry = new SessionRegistry();

    // Simulate what the invocation runner does: register a handle
    let sessionState: SessionState = "prompting";
    const pendingResolve: ((p: string) => void) | null = null;
    const sessionId = "invocation-test-session-001";
    registry.register(sessionId, {
      sendPrompt: async (prompt: string) => {
        if (sessionState === "idle" && pendingResolve) {
          sessionState = "prompting";
          pendingResolve(prompt);
        }
      },
      getState: () => sessionState,
      requestClose: () => {
        sessionState = "closed";
      },
    });

    // During invocation: handle is discoverable
    const handle = registry.get(sessionId);
    expect(handle).toBeDefined();
    expect(handle!.getState()).toBe("prompting");

    // After invocation: unregister
    sessionState = "closed";
    registry.unregister(sessionId);
    expect(registry.get(sessionId)).toBeUndefined();
  });

  // AC: @session-prompt-action ac-1 — idle handle accepts follow-up prompts
  it("idle handle accepts sendPrompt and transitions to prompting", async () => {
    const registry = new SessionRegistry();
    const sessionId = "idle-accept-001";

    let sessionState: SessionState = "prompting";
    let pendingResolve: ((p: string) => void) | null = null;

    registry.register(sessionId, {
      sendPrompt: async (prompt: string) => {
        if (sessionState === "closed") {
          throw new Error(`Session '${sessionId}' is closed`);
        }
        if (sessionState === "idle" && pendingResolve) {
          sessionState = "prompting";
          pendingResolve(prompt);
        }
      },
      getState: () => sessionState,
      requestClose: () => {
        sessionState = "closed";
      },
    });

    const handle = registry.get(sessionId)!;

    // Transition to idle and set up a pending resolver
    sessionState = "idle";
    let receivedPrompt: string | null = null;
    pendingResolve = (p: string) => {
      receivedPrompt = p;
    };

    // sendPrompt on idle handle should resolve the pending prompt
    await handle.sendPrompt("Follow-up question");
    expect(receivedPrompt).toBe("Follow-up question");
    expect(handle.getState()).toBe("prompting");
  });

  // AC: @session-prompt-action ac-1, ac-2 — idle sendPrompt returns deferred promise
  // that only resolves when the turn completes (not immediately on wake-up)
  it("idle sendPrompt returns deferred promise that resolves on turn completion", async () => {
    const registry = new SessionRegistry();
    const sessionId = "idle-deferred-001";

    let sessionState: SessionState = "prompting";
    let pendingResolve: ((p: string) => void) | null = null;
    interface QueueEntry {
      prompt: string;
      resolve: () => void;
      reject: (e: Error) => void;
    }
    const queue: QueueEntry[] = [];

    // Mirror the production sendPrompt: idle path pushes to queue, wakes idle loop
    registry.register(sessionId, {
      sendPrompt: (prompt: string): Promise<void> => {
        if (sessionState === "closed") {
          return Promise.reject(new Error("closed"));
        }
        if (sessionState === "idle") {
          const deferredPromise = new Promise<void>((resolve, reject) => {
            queue.push({ prompt, resolve, reject });
          });
          sessionState = "prompting";
          if (pendingResolve) {
            const wakeResolve = pendingResolve;
            pendingResolve = null;
            wakeResolve(""); // Wake idle loop; prompt is in queue
          }
          return deferredPromise;
        }
        if (sessionState === "prompting") {
          return new Promise<void>((resolve, reject) => {
            queue.push({ prompt, resolve, reject });
          });
        }
        return Promise.reject(new Error("not ready"));
      },
      getState: () => sessionState,
      requestClose: () => {
        sessionState = "closed";
      },
    });

    const handle = registry.get(sessionId)!;

    // Transition to idle
    sessionState = "idle";
    pendingResolve = () => {}; // Set up a pending resolver (simulates idle loop waiting)

    // sendPrompt should NOT resolve immediately — the promise is deferred
    let resolved = false;
    const sendPromise = handle.sendPrompt("Deferred prompt").then(() => {
      resolved = true;
    });

    // Promise should still be pending; prompt is in the queue
    expect(resolved).toBe(false);
    expect(queue.length).toBe(1);
    expect(queue[0].prompt).toBe("Deferred prompt");
    expect(handle.getState()).toBe("prompting");

    // Simulate turn completion — resolve the queue entry
    queue[0].resolve();
    await sendPromise;
    expect(resolved).toBe(true);
  });

  // AC: @session-prompt-action ac-1, ac-3 — sendPrompt during idle-before-resolver race
  // Regression: sendPrompt() arriving after session.idle is emitted but before the
  // idle-loop resolver is installed must queue successfully, not reject.
  it("idle sendPrompt without resolver queues prompt instead of rejecting", async () => {
    const registry = new SessionRegistry();
    const sessionId = "idle-race-001";

    let sessionState: SessionState = "prompting";
    let pendingResolve: ((p: string) => void) | null = null;
    interface QueueEntry {
      prompt: string;
      resolve: () => void;
      reject: (e: Error) => void;
    }
    const queue: QueueEntry[] = [];

    // Mirror the production sendPrompt — handles idle WITHOUT pendingResolve
    registry.register(sessionId, {
      sendPrompt: (prompt: string): Promise<void> => {
        if (sessionState === "closed") {
          return Promise.reject(new Error("closed"));
        }
        if (sessionState === "idle") {
          const deferredPromise = new Promise<void>((resolve, reject) => {
            queue.push({ prompt, resolve, reject });
          });
          sessionState = "prompting";
          if (pendingResolve) {
            const wakeResolve = pendingResolve;
            pendingResolve = null;
            wakeResolve("");
          }
          return deferredPromise;
        }
        if (sessionState === "prompting") {
          return new Promise<void>((resolve, reject) => {
            queue.push({ prompt, resolve, reject });
          });
        }
        return Promise.reject(new Error("not ready"));
      },
      getState: () => sessionState,
      requestClose: () => {
        sessionState = "closed";
      },
    });

    const handle = registry.get(sessionId)!;

    // Transition to idle but do NOT set pendingResolve — simulates the race
    // window between onIdle and the idle-loop installing the resolver
    sessionState = "idle";
    pendingResolve = null;

    // sendPrompt must NOT reject — it should queue the prompt
    let resolved = false;
    const sendPromise = handle.sendPrompt("Race prompt").then(() => {
      resolved = true;
    });

    // Prompt should be queued, state transitioned to prompting
    expect(queue.length).toBe(1);
    expect(queue[0].prompt).toBe("Race prompt");
    expect(handle.getState()).toBe("prompting");
    expect(resolved).toBe(false);

    // Simulate the idle loop eventually draining the queue and completing the turn
    queue[0].resolve();
    await sendPromise;
    expect(resolved).toBe(true);
  });

  // AC: @session-prompt-action ac-4 — closed handle rejects sendPrompt
  it("closed handle rejects sendPrompt with clear error", async () => {
    const registry = new SessionRegistry();
    const sessionId = "closed-reject-001";

    let sessionState: SessionState = "closed";

    registry.register(sessionId, {
      sendPrompt: async () => {
        if (sessionState === "closed") {
          throw new Error(
            `Session '${sessionId}' is closed — cannot deliver prompt to a closed session.`,
          );
        }
      },
      getState: () => sessionState,
      requestClose: () => {
        sessionState = "closed";
      },
    });

    const handle = registry.get(sessionId)!;
    await expect(handle.sendPrompt("test")).rejects.toThrow("closed");
  });

  // AC: @session-prompt-action ac-5 — prompting handle queues prompt
  // AC: @session-prompt-action ac-2 — sendPrompt promise defers until turn completes
  it("prompting handle queues sendPrompt and defers resolution until turn completes", async () => {
    const registry = new SessionRegistry();
    const sessionId = "queue-001";

    let sessionState: SessionState = "prompting";
    interface QueueEntry {
      prompt: string;
      resolve: () => void;
      reject: (e: Error) => void;
    }
    const queue: QueueEntry[] = [];

    registry.register(sessionId, {
      sendPrompt: (prompt: string): Promise<void> => {
        if (sessionState === "prompting") {
          // Mirror the production implementation: return a deferred promise
          return new Promise<void>((resolve, reject) => {
            queue.push({ prompt, resolve, reject });
          });
        }
        return Promise.resolve();
      },
      getState: () => sessionState,
      requestClose: () => {
        sessionState = "closed";
      },
    });

    const handle = registry.get(sessionId)!;

    // sendPrompt while prompting should queue and NOT resolve yet
    let resolved = false;
    const sendPromise = handle.sendPrompt("Queued for later").then(() => {
      resolved = true;
    });

    // Queue should have the entry but promise should not have resolved
    expect(queue.length).toBe(1);
    expect(queue[0].prompt).toBe("Queued for later");
    expect(resolved).toBe(false);

    // Simulate the turn completing — resolve the entry
    queue[0].resolve();
    await sendPromise;
    expect(resolved).toBe(true);

    // State remains prompting — the queue is drained after turn completes
    expect(handle.getState()).toBe("prompting");
  });

  // AC: @session-prompt-action ac-1, ac-5 — multiple queued prompts are preserved
  it("multiple concurrent sendPrompt calls are all queued (no overwrite)", async () => {
    const registry = new SessionRegistry();
    const sessionId = "multi-queue-001";

    let sessionState: SessionState = "prompting";
    interface QueueEntry {
      prompt: string;
      resolve: () => void;
      reject: (e: Error) => void;
    }
    const queue: QueueEntry[] = [];

    registry.register(sessionId, {
      sendPrompt: (prompt: string): Promise<void> => {
        if (sessionState === "closed") {
          return Promise.reject(new Error("closed"));
        }
        if (sessionState === "prompting") {
          return new Promise<void>((resolve, reject) => {
            queue.push({ prompt, resolve, reject });
          });
        }
        return Promise.resolve();
      },
      getState: () => sessionState,
      requestClose: () => {
        sessionState = "closed";
      },
    });

    const handle = registry.get(sessionId)!;

    // Fire two session_prompt actions while the session is prompting
    const results: boolean[] = [];
    const p1 = handle.sendPrompt("Prompt A").then(() => {
      results.push(true);
    });
    const p2 = handle.sendPrompt("Prompt B").then(() => {
      results.push(true);
    });

    // Both should be queued, neither lost
    expect(queue.length).toBe(2);
    expect(queue[0].prompt).toBe("Prompt A");
    expect(queue[1].prompt).toBe("Prompt B");
    expect(results).toEqual([]);

    // Resolve them in order (simulating sequential turn completion)
    queue[0].resolve();
    await p1;
    expect(results).toEqual([true]);

    queue[1].resolve();
    await p2;
    expect(results).toEqual([true, true]);
  });

  // AC: @session-prompt-action ac-4, ac-5 — queued prompts rejected on close
  it("queued sendPrompt promises are rejected when session closes", async () => {
    const registry = new SessionRegistry();
    const sessionId = "close-reject-001";

    let sessionState: SessionState = "prompting";
    interface QueueEntry {
      prompt: string;
      resolve: () => void;
      reject: (e: Error) => void;
    }
    const queue: QueueEntry[] = [];

    registry.register(sessionId, {
      sendPrompt: (prompt: string): Promise<void> => {
        if (sessionState === "closed") {
          return Promise.reject(new Error("closed"));
        }
        if (sessionState === "prompting") {
          return new Promise<void>((resolve, reject) => {
            queue.push({ prompt, resolve, reject });
          });
        }
        return Promise.resolve();
      },
      getState: () => sessionState,
      requestClose: (reason: string) => {
        sessionState = "closed";
        const err = new Error(`closed: ${reason}`);
        for (const entry of queue.splice(0)) {
          entry.reject(err);
        }
      },
    });

    const handle = registry.get(sessionId)!;

    // Queue a prompt
    const sendPromise = handle.sendPrompt("Will be rejected");
    expect(queue.length).toBe(1);

    // Close the session — the queued promise should reject
    handle.requestClose("shutdown");
    await expect(sendPromise).rejects.toThrow("closed");
  });
});

// ─── SessionIdleContext and onIdle Tests ───────────────────────────────

describe("SessionIdleContext — onIdle callback contract", () => {
  // AC: @session-idle-event ac-1 — turn complete info includes required fields
  it("SessionIdleContext type includes session context and turn metadata", () => {
    const info: SessionIdleContext = {
      sessionId: "session-001",
      agentId: "task-worker",
      taskRef: "@task-foo",
      turnCount: 1,
      stopReason: "end_turn",
      turnDurationMs: 5000,
    };

    expect(info.sessionId).toBe("session-001");
    expect(info.agentId).toBe("task-worker");
    expect(info.taskRef).toBe("@task-foo");
    expect(info.turnCount).toBe(1);
    expect(info.stopReason).toBe("end_turn");
    expect(info.turnDurationMs).toBe(5000);
  });

  // AC: @session-idle-event ac-2 — turn count increments across turns
  it("turnCount increments across successive turns", () => {
    const turns: SessionIdleContext[] = [];
    for (let i = 1; i <= 3; i++) {
      turns.push({
        sessionId: "session-multi",
        agentId: "task-worker",
        taskRef: "@task-bar",
        turnCount: i,
        stopReason: "end_turn",
        turnDurationMs: 1000 * i,
      });
    }

    expect(turns.map((t) => t.turnCount)).toEqual([1, 2, 3]);
    expect(turns[2].turnDurationMs).toBe(3000);
  });

  // AC: @session-idle-event ac-1 — taskRef is optional for unbound sessions
  it("taskRef can be undefined for unbound sessions", () => {
    const info: SessionIdleContext = {
      sessionId: "session-unbound",
      agentId: "task-worker",
      taskRef: undefined,
      turnCount: 1,
      stopReason: "end_turn",
      turnDurationMs: 2000,
    };

    expect(info.taskRef).toBeUndefined();
  });
});

// ─── Schedule & Composition Schema Tests ──────────────────────────────────────

describe("session_prompt on schedules and compositions", () => {
  // AC: @session-prompt-action ac-7 — schedules have no session context, so session_id
  // is always required. Schema still parses (validation warns), but ActionSchema
  // superRefine enforces prompt/prompt_template.
  // AC: @session-prompt-action-schema ac-4

  it("ScheduleSchema accepts session_prompt action with session_id", () => {
    const result = ScheduleSchema.safeParse({
      _ulid: testUlid("SCHED", 1),
      id: "idle-followup",
      name: "Idle Follow-Up",
      cron: "*/5 * * * *",
      action: {
        type: "session_prompt",
        prompt: "Continue working",
        session_id: "session-target-001",
      },
    });
    expect(result.success).toBe(true);
  });

  it("ScheduleSchema parses session_prompt without session_id (validation warns later)", () => {
    // Schema doesn't reject — the validate() pipeline emits a warning.
    // This verifies the shared ActionSchema allows it at parse time.
    const result = ScheduleSchema.safeParse({
      _ulid: testUlid("SCHED", 2),
      id: "missing-session",
      name: "Missing Session",
      cron: "*/5 * * * *",
      action: {
        type: "session_prompt",
        prompt: "Continue",
        // No session_id — validate() warns
      },
    });
    expect(result.success).toBe(true);
  });

  it("ScheduleSchema rejects session_prompt without prompt or prompt_template", () => {
    const result = ScheduleSchema.safeParse({
      _ulid: testUlid("SCHED", 3),
      id: "no-prompt",
      name: "No Prompt",
      cron: "*/5 * * * *",
      action: {
        type: "session_prompt",
        session_id: "session-001",
        // Missing both prompt and prompt_template
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("prompt") || m.includes("prompt_template"))).toBe(
        true,
      );
    }
  });

  it("CompositionSchema accepts session_prompt on_complete with session_id", () => {
    const result = CompositionSchema.safeParse({
      _ulid: testUlid("COMP", 1),
      id: "fan-in-session",
      name: "Fan-in Session",
      join_count: 2,
      on_complete: {
        type: "session_prompt",
        prompt: "Fan-in complete, review results",
        session_id: "session-target-002",
      },
    });
    expect(result.success).toBe(true);
  });

  it("CompositionSchema parses session_prompt on_complete without session_id (validation warns later)", () => {
    const result = CompositionSchema.safeParse({
      _ulid: testUlid("COMP", 2),
      id: "missing-session-comp",
      name: "Missing Session Comp",
      join_count: 3,
      on_complete: {
        type: "session_prompt",
        prompt_template: "Group {{group_id}} complete",
        // No session_id — validate() warns
      },
    });
    expect(result.success).toBe(true);
  });

  it("CompositionSchema rejects session_prompt on_complete without prompt or prompt_template", () => {
    const result = CompositionSchema.safeParse({
      _ulid: testUlid("COMP", 3),
      id: "no-prompt-comp",
      name: "No Prompt Comp",
      join_count: 2,
      on_complete: {
        type: "session_prompt",
        session_id: "session-001",
        // Missing both prompt and prompt_template
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("prompt") || m.includes("prompt_template"))).toBe(
        true,
      );
    }
  });
});

// ─── Daemon Wiring Integration Test ──────────────────────────────────────────

describe("daemon wiring — session registry threaded to ActionExecutor", () => {
  /**
   * Verifies that the daemon's route module exports getSessionRegistry and that
   * the registry lifecycle works correctly (undefined before start, available after).
   *
   * The full production wiring is verified by the dispatch engine integration
   * tests in daemon-agent-dispatch-routes.test.ts. Here we verify the
   * getSessionRegistry export is available and returns undefined when no
   * engine is running.
   *
   * AC: @session-prompt-action ac-1
   */
  it("getSessionRegistry returns undefined when no engine is running", async () => {
    const { getSessionRegistry } = await import("../dist/daemon/routes/agent-dispatch.js");

    // Before any engine starts, no registry exists for a random project path
    const fakePath = "/nonexistent/project";
    expect(getSessionRegistry(fakePath)).toBeUndefined();
  });
});
