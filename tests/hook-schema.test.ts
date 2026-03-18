/**
 * Tests for hook schema, filter matching, and validation.
 *
 * Covers:
 * - @dispatch-hook-schema ac-1 through ac-4
 * - @dispatch-hook-filter ac-1 through ac-5
 *
 * Task: @task-hook-schema
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify } from "yaml";
import {
  HookSchema,
  HookFilterSchema,
  HookEventTypeSchema,
  ActionSchema,
  MetaManifestSchema,
} from "../src/schema/index.js";
import {
  matchesFilter,
  validateHookFilter,
  getValidFilterFields,
  ENVELOPE_FIELDS,
  PAYLOAD_FIELDS_BY_EVENT,
} from "../src/schema/hooks.js";
import { ACTION_TYPES } from "../src/schema/action.js";
import { testUlid, setupTempFixtures, cleanupTempDir, kspec as kspecRun } from "./helpers/cli.js";

// ─── @dispatch-hook-schema Tests ─────────────────────────────────────────────

describe("HookSchema", () => {
  // AC: @dispatch-hook-schema ac-1
  describe("ac-1: valid hook parsing with typed fields and shared action schema", () => {
    it("should parse a valid hook with command action", () => {
      const hook = {
        _ulid: testUlid("HOOK", 1),
        name: "notify-on-task-ready",
        on: "task.ready",
        filter: { agent_id: "worker" },
        action: {
          type: "command",
          command: "echo",
          args: ["task ready!"],
        },
        enabled: true,
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data._ulid).toBe(hook._ulid);
        expect(result.data.name).toBe("notify-on-task-ready");
        expect(result.data.on).toBe("task.ready");
        expect(result.data.action.type).toBe("command");
        expect(result.data.enabled).toBe(true);
      }
    });

    it("should parse a valid hook with kspec action", () => {
      const hook = {
        _ulid: testUlid("HOOK", 2),
        name: "auto-note-on-review",
        on: "task.pending_review",
        action: {
          type: "kspec",
          command: "task note @ref 'Submitted for review'",
        },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action.type).toBe("kspec");
        // enabled defaults to true
        expect(result.data.enabled).toBe(true);
      }
    });

    it("should parse a valid hook with agent action", () => {
      const hook = {
        _ulid: testUlid("HOOK", 3),
        name: "spawn-reviewer-on-submit",
        on: "task.pending_review",
        action: {
          type: "agent",
          agent_id: "pr-reviewer",
          timeout_minutes: 30,
        },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action.type).toBe("agent");
        if (result.data.action.type === "agent") {
          expect(result.data.action.agent_id).toBe("pr-reviewer");
          expect(result.data.action.timeout_minutes).toBe(30);
        }
      }
    });

    it("should parse a valid hook with notify action", () => {
      const hook = {
        _ulid: testUlid("HOOK", 4),
        name: "broadcast-completion",
        on: "invocation.completed",
        action: {
          type: "notify",
          message: "Invocation completed for {{agent_id}}",
          topic: "automation",
        },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action.type).toBe("notify");
      }
    });

    it("should parse a hook with optional filter omitted", () => {
      const hook = {
        _ulid: testUlid("HOOK", 5),
        name: "catch-all-task-ready",
        on: "task.ready",
        action: { type: "command", command: "echo", args: ["fired"] },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filter).toBeUndefined();
      }
    });
  });

  // AC: @dispatch-hook-schema ac-2
  describe("ac-2: invalid action type produces error identifying type and listing valid options", () => {
    it("should reject a hook with invalid action type", () => {
      const hook = {
        _ulid: testUlid("HOOK", 10),
        name: "bad-action-hook",
        on: "task.ready",
        action: {
          type: "invalid_action",
          command: "echo hello",
        },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(false);
      if (!result.success) {
        // The discriminated union error should mention the invalid discriminator
        const errorMessage = result.error.issues.map(i => i.message).join("; ");
        expect(errorMessage).toContain("Invalid discriminator value");
      }
    });

    it("should reject a hook with missing action type field", () => {
      const hook = {
        _ulid: testUlid("HOOK", 11),
        name: "missing-type-hook",
        on: "task.ready",
        action: {
          command: "echo hello",
        },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(false);
    });

    it("should list valid action types in ActionSchema", () => {
      // Verify the action types are as expected
      expect(ACTION_TYPES).toEqual(["command", "kspec", "agent", "notify"]);
    });
  });

  // AC: @dispatch-hook-schema ac-4
  describe("ac-4: manifest without hooks section loads with empty default", () => {
    it("should default hooks to empty array when not present", () => {
      const manifest = {
        kynetic_meta: "1.0",
        agents: [],
      };

      const result = MetaManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hooks).toEqual([]);
      }
    });

    it("should parse manifest with hooks present", () => {
      const manifest = {
        kynetic_meta: "1.0",
        agents: [],
        hooks: [
          {
            _ulid: testUlid("HOOK", 20),
            name: "test-hook",
            on: "task.ready",
            action: { type: "command", command: "echo", args: ["hi"] },
          },
        ],
      };

      const result = MetaManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hooks).toHaveLength(1);
        expect(result.data.hooks[0].name).toBe("test-hook");
      }
    });
  });

  describe("schema edge cases", () => {
    it("should reject a hook with empty name", () => {
      const hook = {
        _ulid: testUlid("HOOK", 30),
        name: "",
        on: "task.ready",
        action: { type: "command", command: "echo" },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(false);
    });

    it("should reject a hook with invalid event type", () => {
      const hook = {
        _ulid: testUlid("HOOK", 31),
        name: "bad-event",
        on: "nonexistent.event",
        action: { type: "command", command: "echo" },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(false);
    });

    it("should reject a hook with invalid ULID", () => {
      const hook = {
        _ulid: "not-a-ulid",
        name: "bad-ulid-hook",
        on: "task.ready",
        action: { type: "command", command: "echo" },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(false);
    });

    it("should default enabled to true when not specified", () => {
      const hook = {
        _ulid: testUlid("HOOK", 32),
        name: "defaults-enabled",
        on: "task.ready",
        action: { type: "command", command: "echo" },
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
      }
    });

    it("should accept enabled: false", () => {
      const hook = {
        _ulid: testUlid("HOOK", 33),
        name: "disabled-hook",
        on: "task.ready",
        action: { type: "command", command: "echo" },
        enabled: false,
      };

      const result = HookSchema.safeParse(hook);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
      }
    });

    it("should accept all registered event types", () => {
      const eventTypes = HookEventTypeSchema.options;
      for (const eventType of eventTypes) {
        const hook = {
          _ulid: testUlid("HOOK", 34),
          name: `hook-for-${eventType}`,
          on: eventType,
          action: { type: "command", command: "echo" },
        };
        const result = HookSchema.safeParse(hook);
        expect(result.success).toBe(true);
      }
    });
  });
});

// ─── @dispatch-hook-filter Tests ─────────────────────────────────────────────

describe("HookFilter", () => {
  // AC: @dispatch-hook-filter ac-1
  describe("ac-1: exact string equality for scalar fields", () => {
    it("should not match when agent_id differs", () => {
      const filter = { agent_id: "worker" };
      const envelope = { event_type: "task.ready", source_type: "task_watcher" };
      const payload = { agent_id: "reviewer" };

      expect(matchesFilter(filter, envelope, payload)).toBe(false);
    });

    it("should match when agent_id matches exactly", () => {
      const filter = { agent_id: "worker" };
      const envelope = { event_type: "task.ready", source_type: "task_watcher" };
      const payload = { agent_id: "worker" };

      expect(matchesFilter(filter, envelope, payload)).toBe(true);
    });

    it("should not match on partial string match", () => {
      const filter = { agent_id: "work" };
      const envelope = {};
      const payload = { agent_id: "worker" };

      expect(matchesFilter(filter, envelope, payload)).toBe(false);
    });
  });

  // AC: @dispatch-hook-filter ac-2
  describe("ac-2: contains-all semantics for array fields", () => {
    it("should match when all specified tags are present (extra tags allowed)", () => {
      const filter = { tags: ["mvp"] };
      const envelope = {};
      const payload = { tags: ["mvp", "cli"] };

      expect(matchesFilter(filter, envelope, payload)).toBe(true);
    });

    it("should not match when a specified tag is missing", () => {
      const filter = { tags: ["mvp", "urgent"] };
      const envelope = {};
      const payload = { tags: ["mvp", "cli"] };

      expect(matchesFilter(filter, envelope, payload)).toBe(false);
    });

    it("should match when all specified tags are present exactly", () => {
      const filter = { tags: ["mvp", "cli"] };
      const envelope = {};
      const payload = { tags: ["mvp", "cli"] };

      expect(matchesFilter(filter, envelope, payload)).toBe(true);
    });

    it("should not match when payload field is not an array", () => {
      const filter = { tags: ["mvp"] };
      const envelope = {};
      const payload = { tags: "mvp" };

      expect(matchesFilter(filter, envelope, payload)).toBe(false);
    });
  });

  // AC: @dispatch-hook-filter ac-3
  describe("ac-3: unknown filter field produces warning", () => {
    it("should warn on unknown filter field for known event type", () => {
      const warnings = validateHookFilter(
        "test-hook",
        "task.ready",
        { nonexistent_field: "value" },
      );

      expect(warnings).toHaveLength(1);
      expect(warnings[0].field).toBe("nonexistent_field");
      expect(warnings[0].message).toContain("unknown field 'nonexistent_field'");
      expect(warnings[0].message).toContain("task.ready");
      expect(warnings[0].message).toContain("Available fields:");
    });

    it("should not warn on known envelope fields", () => {
      const warnings = validateHookFilter(
        "test-hook",
        "task.ready",
        { source_type: "task_watcher", correlation_id: "abc" },
      );

      expect(warnings).toHaveLength(0);
    });

    it("should not warn on known payload fields for the event type", () => {
      const warnings = validateHookFilter(
        "test-hook",
        "task.ready",
        { agent_id: "worker", tags: ["mvp"] },
      );

      expect(warnings).toHaveLength(0);
    });

    it("should list envelope fields as always valid for any event type", () => {
      for (const envelopeField of ENVELOPE_FIELDS) {
        const warnings = validateHookFilter(
          "test-hook",
          "schedule.tick",
          { [envelopeField]: "value" },
        );
        expect(warnings).toHaveLength(0);
      }
    });

    it("should warn on payload field from a different event type", () => {
      // agent_id is a task.* payload field but not a schedule.tick payload field
      const warnings = validateHookFilter(
        "test-hook",
        "schedule.tick",
        { agent_id: "worker" },
      );

      expect(warnings).toHaveLength(1);
      expect(warnings[0].field).toBe("agent_id");
    });
  });

  // AC: @dispatch-hook-filter ac-4
  describe("ac-4: no filter matches all events of the type", () => {
    it("should match when filter is undefined", () => {
      const envelope = { event_type: "task.ready" };
      const payload = { agent_id: "reviewer", tags: ["mvp"] };

      expect(matchesFilter(undefined, envelope, payload)).toBe(true);
    });

    it("should match when filter is an empty object", () => {
      const envelope = { event_type: "task.ready" };
      const payload = { agent_id: "reviewer" };

      expect(matchesFilter({}, envelope, payload)).toBe(true);
    });
  });

  // AC: @dispatch-hook-filter ac-5
  describe("ac-5: filters can target envelope fields", () => {
    it("should not match when source_type filter does not match envelope", () => {
      const filter = { source_type: "schedule_engine" };
      const envelope = { source_type: "manual" };
      const payload = {};

      expect(matchesFilter(filter, envelope, payload)).toBe(false);
    });

    it("should match when source_type filter matches envelope", () => {
      const filter = { source_type: "schedule_engine" };
      const envelope = { source_type: "schedule_engine" };
      const payload = {};

      expect(matchesFilter(filter, envelope, payload)).toBe(true);
    });

    it("should match on correlation_id from envelope", () => {
      const filter = { correlation_id: "root-event-123" };
      const envelope = { correlation_id: "root-event-123" };
      const payload = {};

      expect(matchesFilter(filter, envelope, payload)).toBe(true);
    });

    it("should match on source_id from envelope", () => {
      const filter = { source_id: "task-abc" };
      const envelope = { source_id: "task-abc" };
      const payload = {};

      expect(matchesFilter(filter, envelope, payload)).toBe(true);
    });
  });

  describe("filter edge cases", () => {
    it("should handle combined envelope and payload filters", () => {
      const filter = { source_type: "task_watcher", agent_id: "worker" };
      const envelope = { source_type: "task_watcher" };
      const payload = { agent_id: "worker" };

      expect(matchesFilter(filter, envelope, payload)).toBe(true);
    });

    it("should fail if any filter criterion does not match", () => {
      const filter = { source_type: "task_watcher", agent_id: "worker" };
      const envelope = { source_type: "task_watcher" };
      const payload = { agent_id: "reviewer" };

      expect(matchesFilter(filter, envelope, payload)).toBe(false);
    });

    it("should not match when filtered field is absent from payload", () => {
      const filter = { agent_id: "worker" };
      const envelope = {};
      const payload = {};

      expect(matchesFilter(filter, envelope, payload)).toBe(false);
    });

    it("should handle numeric filter values", () => {
      const filter = { priority: 1 };
      const envelope = {};
      const payload = { priority: 1 };

      expect(matchesFilter(filter, envelope, payload)).toBe(true);
    });

    it("should handle boolean filter values", () => {
      const filter = { automation: true };
      const envelope = {};
      const payload = { automation: true };

      expect(matchesFilter(filter, envelope, payload)).toBe(true);
    });
  });

  describe("getValidFilterFields", () => {
    it("should return envelope fields for any event type", () => {
      const fields = getValidFilterFields("task.ready");
      for (const envelopeField of ENVELOPE_FIELDS) {
        expect(fields).toContain(envelopeField);
      }
    });

    it("should return payload fields for known event types", () => {
      const fields = getValidFilterFields("task.ready");
      expect(fields).toContain("task_id");
      expect(fields).toContain("agent_id");
      expect(fields).toContain("tags");
    });

    it("should return only envelope fields for unknown event types", () => {
      const fields = getValidFilterFields("unknown.event.type");
      expect(fields).toHaveLength(ENVELOPE_FIELDS.length);
    });
  });
});

// ─── E2E: Validate Integration Tests ────────────────────────────────────────

describe("Hook validation integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-hook-schema ac-3
  it("should report error when hook agent action references non-existent agent", async () => {
    // Overwrite meta manifest with hook referencing non-existent agent
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
            _ulid: testUlid("HOOK", 40),
            name: "spawn-ghost",
            on: "task.ready",
            action: {
              type: "agent",
              agent_id: "non-existent-agent",
            },
          },
        ],
      }),
    );

    const result = kspecRun(["validate"], tempDir);

    // Should report an error for the unresolvable agent ref
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("non-existent-agent");
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @dispatch-hook-schema ac-2
  it("should report error for hook with invalid action type via schema validation", async () => {
    // Write raw YAML with invalid action type (bypasses Zod at write time)
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    await fs.writeFile(
      metaPath,
      `kynetic_meta: "1.0"
agents: []
hooks:
  - _ulid: ${testUlid("HOOK", 41)}
    name: bad-action-hook
    on: task.ready
    action:
      type: invalid_type
      command: echo hello
`,
    );

    const result = kspecRun(["validate"], tempDir);

    // Schema validation should catch the invalid discriminator
    const combined = result.stdout + result.stderr;
    expect(combined).toContain("Invalid discriminator value");
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @dispatch-hook-schema ac-4
  it("should load manifest successfully with no hooks section", async () => {
    // Meta manifest without hooks — use existing fixture as-is since it has no hooks
    // Just verify validate passes
    const result = kspecRun(["validate"], tempDir);
    // The fixture may have warnings but should not have schema errors
    // Exit code 0 (no errors) or 6 (warnings only) are both acceptable
    expect(result.exitCode === 0 || result.exitCode === 6).toBe(true);
  });

  // AC: @dispatch-hook-schema ac-3
  it("should succeed when hook agent action references an existing agent", async () => {
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    await fs.writeFile(
      metaPath,
      stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: testUlid("AGNT", 2),
            id: "task-worker",
            name: "Task Worker",
          },
        ],
        hooks: [
          {
            _ulid: testUlid("HOOK", 42),
            name: "spawn-worker",
            on: "task.ready",
            action: {
              type: "agent",
              agent_id: "task-worker",
            },
          },
        ],
      }),
    );

    const result = kspecRun(["validate"], tempDir);
    // Should not report hook agent ref errors
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("non-existent");
  });

  it("should succeed with non-agent action hooks (no agent ref check needed)", async () => {
    // Read existing meta manifest and add hooks to it (preserve existing agents)
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const existing = await fs.readFile(metaPath, "utf-8");

    // Append hooks section to the existing meta manifest
    await fs.writeFile(
      metaPath,
      existing + `
hooks:
  - _ulid: ${testUlid("HOOK", 43)}
    name: command-hook
    on: task.ready
    action:
      type: command
      command: echo
      args:
        - hello
`,
    );

    const result = kspecRun(["validate"], tempDir);
    // Should not have schema errors from hooks — exit 0 or 6 (warnings only)
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("hooks[");
    expect(result.exitCode === 0 || result.exitCode === 6).toBe(true);
  });
});

// ─── ActionSchema Unit Tests ─────────────────────────────────────────────────

describe("ActionSchema", () => {
  it("should parse all four action types", () => {
    const actions = [
      { type: "command", command: "echo", args: ["hi"] },
      { type: "kspec", command: "task list" },
      { type: "agent", agent_id: "worker" },
      { type: "notify", message: "Hello" },
    ];

    for (const action of actions) {
      const result = ActionSchema.safeParse(action);
      expect(result.success).toBe(true);
    }
  });

  it("should reject unknown action type", () => {
    const result = ActionSchema.safeParse({ type: "webhook", url: "http://example.com" });
    expect(result.success).toBe(false);
  });

  it("should require command for command action", () => {
    const result = ActionSchema.safeParse({ type: "command" });
    expect(result.success).toBe(false);
  });

  it("should require agent_id for agent action", () => {
    const result = ActionSchema.safeParse({ type: "agent" });
    expect(result.success).toBe(false);
  });

  it("should require message for notify action", () => {
    const result = ActionSchema.safeParse({ type: "notify" });
    expect(result.success).toBe(false);
  });

  it("should accept optional fields on command action", () => {
    const result = ActionSchema.safeParse({
      type: "command",
      command: "npm",
      args: ["test"],
      timeout_ms: 60000,
      cwd: "/tmp",
      env: { NODE_ENV: "test" },
    });
    expect(result.success).toBe(true);
  });

  it("should accept optional fields on agent action", () => {
    const result = ActionSchema.safeParse({
      type: "agent",
      agent_id: "worker",
      prompt: "Do the work",
      task_ref: "@task-foo",
      timeout_minutes: 30,
    });
    expect(result.success).toBe(true);
  });
});
