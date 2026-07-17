import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import factsFixture from "./fixtures/dispatch-operator-facts.json" with { type: "json" };
import {
  KspecConfigSchema,
  getDefaultConfig,
  resolveDispatchRemoteSync,
} from "../src/parser/config.js";
import { AgentDispatchRuleSchema } from "../src/schema/meta.js";
import {
  DispatchCleanupErrorCodeSchema as DurableCleanupErrorCodeSchema,
  DispatchCleanupPhaseSchema,
  DispatchControlAuthoritySchema,
  DispatchTaskControlModeSchema,
  createMissingDispatchControl,
} from "../src/schema/dispatch-control.js";
import { EVENT_PAYLOAD_SCHEMAS } from "../src/schema/event-payloads.js";
import {
  DispatchCleanupErrorCodeSchema,
  DispatchControlErrorCodeSchema,
  DispatchLifecycleStatusSchema,
} from "../packages/shared/src/api.js";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir } from "./helpers/cli.js";

const modeState = vi.hoisted(() => ({ staticMode: false }));
vi.mock("../packages/web-ui/src/lib/stores/mode.svelte", () => ({
  isStaticMode: () => modeState.staticMode,
  assertWritable: () => undefined,
}));
vi.mock("../packages/web-ui/src/lib/stores/project.svelte", () => ({
  getSelectedProjectPath: () => null,
  clearInvalidSelection: () => undefined,
  isInvalidProjectError: () => false,
}));
vi.mock("../packages/web-ui/src/lib/api-static", () => ({}));
vi.mock("../packages/web-ui/src/lib/constants", () => ({
  DAEMON_API_BASE: "http://localhost:3456",
}));

import { parseAgentDispatchStatusWire } from "../packages/web-ui/src/lib/api.js";
import {
  HARD_STOP_CONFIRMATION,
  getGlobalLifecycleActions,
  getTaskLifecycleActions,
} from "../packages/web-ui/src/lib/dispatch-lifecycle.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TASK_ID = "01KG0RR6CA45ZT43W2T6HJMVA1";
const CLEANUP_ID = "01KXH2PXT88X9MSC62MQVY2CW1";
const NOW = "2026-07-16T12:00:00.000Z";
const EXPECTED_GLOBAL_COMMANDS = [
  "kspec agent dispatch start",
  "kspec agent dispatch pause",
  "kspec agent dispatch resume",
  "kspec agent dispatch stop",
  "kspec agent dispatch status",
  "kspec agent dispatch watch",
  "kspec agent status",
] as const;
const EXPECTED_TASK_COMMANDS = [
  "kspec agent dispatch task pause",
  "kspec agent dispatch task resume",
  "kspec agent dispatch task stop",
] as const;

interface CommandNode {
  fullPath: string[];
  subcommands: CommandNode[];
}

interface DispatchFacts {
  evidence: {
    reviewed_lifecycle_commit: string;
    integrated_lifecycle_commit: string;
    source_matrix: Array<{ sources: string[]; tests: string[] }>;
  };
  workspace: typeof factsFixture.workspace;
  command_tree: typeof factsFixture.command_tree;
  lifecycle: typeof factsFixture.lifecycle;
  api: typeof factsFixture.api;
  ui: typeof factsFixture.ui;
  events: typeof factsFixture.events;
  safety: typeof factsFixture.safety;
  limitations: string[];
}

function publicStatusWire() {
  return {
    dispatch_enabled: false,
    active_invocations: [],
    queued_invocations: [],
    queue_depth: 2,
    agent_definitions: [],
    degraded: { active: false, reason: "", enteredAt: null },
    global_authority: "paused",
    projection: "draining",
    cleanup_state: { status: "idle", entries: [] },
    active_count: 1,
    held_count: 1,
    held_tasks: [
      {
        task_id: TASK_ID,
        task_ref: "@test-task",
        title: "Test task",
        scope: "global",
        mode: "paused",
        reason: "operator pause",
        actor: "operator",
        source: "cli",
        controlled_at: NOW,
        updated_at: NOW,
      },
    ],
    task_controls: [
      {
        task_id: TASK_ID,
        task_ref: "@test-task",
        title: "Test task",
        mode: "paused",
        reason: "task pause",
        actor: "operator",
        source: "cli",
        controlled_at: NOW,
        updated_at: NOW,
        cleanup_state: { status: "idle", entries: [] },
      },
    ],
    degraded_targets: [],
  };
}

function collectCommandPaths(node: CommandNode): string[] {
  return [node.fullPath.join(" "), ...node.subcommands.flatMap(collectCommandPaths)];
}

function validateFacts(facts: DispatchFacts): void {
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", facts.evidence.reviewed_lifecycle_commit, "HEAD"],
    {
      cwd: ROOT,
    },
  );
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", facts.evidence.integrated_lifecycle_commit, "HEAD"],
    { cwd: ROOT },
  );
  for (const row of facts.evidence.source_matrix) {
    for (const path of [...row.sources, ...row.tests]) {
      if (!existsSync(resolve(ROOT, path))) throw new Error(`missing fact authority: ${path}`);
    }
  }

  expect(facts.lifecycle.durable_authorities).toEqual(DispatchControlAuthoritySchema.options);
  expect(facts.lifecycle.task_modes).toEqual(DispatchTaskControlModeSchema.options);
  expect(facts.lifecycle.cleanup.phases).toEqual(DispatchCleanupPhaseSchema.options);
  expect(facts.safety.cleanup_error_codes).toEqual(DurableCleanupErrorCodeSchema.options);
  expect(facts.safety.cleanup_error_codes).toEqual(DispatchCleanupErrorCodeSchema.options);
  expect(facts.safety.control_error_codes).toEqual(DispatchControlErrorCodeSchema.options);
  expect(facts.lifecycle.missing_state_default).toBe(
    createMissingDispatchControl().global.authority,
  );

  const defaults = getDefaultConfig();
  expect({
    base_branch: defaults.dispatch.base_branch,
    worktree_root: defaults.dispatch.worktree_root,
    publication_mode: defaults.dispatch.publication_mode,
    bootstrap_steps: defaults.dispatch.bootstrap.steps,
    sync_interval: defaults.dispatch.sync_interval,
    remote_sync: defaults.dispatch.remote_sync,
  }).toEqual(facts.workspace.defaults);
  expect(resolveDispatchRemoteSync(defaults, false)).toBe(false);
  expect(resolveDispatchRemoteSync(defaults, true)).toBe(true);
  for (const publication_mode of facts.workspace.publication_modes) {
    expect(
      KspecConfigSchema.safeParse({
        dispatch: {
          publication_mode,
          bootstrap: {
            steps: [
              {
                run: "npm ci",
                roles: ["worker", "reviewer"],
                idempotent: true,
                allow_tracked_changes: false,
                reviewer_rerun_allowed: false,
              },
            ],
          },
        },
      }).success,
    ).toBe(true);
  }
  expect(
    AgentDispatchRuleSchema.parse({
      on: "task.ready",
      filter: { automation: "eligible", tags: ["docs"], priority: 1 },
    }),
  ).toEqual({
    on: "task.ready",
    filter: { automation: "eligible", tags: ["docs"], priority: 1 },
  });

  const wire = publicStatusWire();
  const parsedWire = DispatchLifecycleStatusSchema.parse({
    global_authority: wire.global_authority,
    projection: wire.projection,
    cleanup_state: wire.cleanup_state,
    active_count: wire.active_count,
    queue_depth: wire.queue_depth,
    held_count: wire.held_count,
    held_tasks: wire.held_tasks,
    task_controls: wire.task_controls,
    degraded_targets: wire.degraded_targets,
  });
  expect(facts.lifecycle.status_fields.toSorted()).toEqual(Object.keys(parsedWire).toSorted());
  expect(parsedWire.held_count).toBe(parsedWire.held_tasks.length);

  const uiStatus = parseAgentDispatchStatusWire(publicStatusWire());
  expect(uiStatus).toMatchObject({
    globalAuthority: "paused",
    projection: "draining",
    activeCount: 1,
    queueDepth: 2,
    heldCount: 1,
  });
  expect(uiStatus.heldTasks[0]).toMatchObject({ taskId: TASK_ID, scope: "global" });
  expect(getGlobalLifecycleActions(uiStatus)).toEqual(facts.ui.writable_actions.paused);
  expect(getTaskLifecycleActions(uiStatus, TASK_ID)).toEqual(facts.lifecycle.task_actions.paused);
  expect(HARD_STOP_CONFIRMATION.description).toContain("evidence will be preserved");

  const eventNames = Object.keys(EVENT_PAYLOAD_SCHEMAS)
    .filter((name) => name.startsWith("dispatch_control."))
    .toSorted();
  expect(facts.events.names.toSorted()).toEqual(eventNames);

  const requiredCommands = [
    ...facts.command_tree.global,
    ...facts.command_tree.task,
    ...facts.command_tree.help_modes,
  ];
  if (new Set(requiredCommands).size !== requiredCommands.length) {
    throw new Error("duplicate fact command");
  }
  expect(facts.command_tree.global).toEqual(EXPECTED_GLOBAL_COMMANDS);
  expect(facts.command_tree.task).toEqual(EXPECTED_TASK_COMMANDS);
  if (!facts.api.control.path || !facts.api.status.path) throw new Error("missing API fact");
  expect(facts.api.control).toEqual({ method: "POST", path: "/api/agent/dispatch/control" });
  expect(facts.api.status).toEqual({ method: "GET", path: "/api/agent/status" });
  if (!facts.ui.route || facts.ui.visible_evidence.length === 0) throw new Error("missing UI fact");
  if (facts.limitations.length === 0) throw new Error("missing limitations");
  if (!facts.safety.dispatch_owned_only) throw new Error("unsafe dispatch ownership fact");
}

function cloneFacts(): DispatchFacts {
  return structuredClone(factsFixture) as unknown as DispatchFacts;
}

describe("dispatch operator fact fixture", () => {
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = await setupTempFixtures();
  });

  afterAll(async () => {
    await cleanupTempDir(fixtureDir);
  });

  // AC: @auto-cli-docs ac-3
  it("captures the complete observable help reference from an explicit fixture cwd", () => {
    const rootHelp = kspec("--help", fixtureDir);
    const fullHelp = kspec("help --all", fixtureDir);
    expect(rootHelp.exitCode).toBe(0);
    expect(fullHelp.exitCode).toBe(0);
    for (const command of [
      ...factsFixture.command_tree.global,
      ...factsFixture.command_tree.task,
    ]) {
      expect(fullHelp.stdout).toContain(command.replace(/^kspec /, ""));
    }
  });

  // AC: @auto-cli-docs ac-4
  it("captures structured JSON help from an explicit fixture cwd", () => {
    const output = kspecJson<{ commands: CommandNode }>("help --json", fixtureDir);
    const commandPaths = collectCommandPaths(output.commands);
    for (const command of [
      ...factsFixture.command_tree.global,
      ...factsFixture.command_tree.task,
    ]) {
      expect(commandPaths).toContain(command);
    }
  });

  it("matches configuration, lifecycle, API, UI, event, safety, and limitation facts", () => {
    expect(() => validateFacts(cloneFacts())).not.toThrow();
  });

  it("rejects a missing lifecycle command and stale fact fixture", () => {
    const missingCommand = cloneFacts();
    missingCommand.command_tree.task = missingCommand.command_tree.task.filter(
      (command) => command !== "kspec agent dispatch task stop",
    );
    expect(() => validateFacts(missingCommand)).toThrow(/expected|contain|command/i);

    const stale = cloneFacts();
    stale.lifecycle.durable_authorities = [
      "stopped",
      "running",
    ] as typeof stale.lifecycle.durable_authorities;
    expect(() => validateFacts(stale)).toThrow();
  });

  it("rejects missing API/UI facts and preserves cleanup scope evidence", () => {
    const missingApi = cloneFacts();
    missingApi.api.control.path = "";
    expect(() => validateFacts(missingApi)).toThrow(/missing API fact/);

    const missingUi = cloneFacts();
    missingUi.ui.visible_evidence = [];
    expect(() => validateFacts(missingUi)).toThrow(/missing UI fact/);

    const wire = publicStatusWire();
    const cleanup = DispatchLifecycleStatusSchema.parse({
      global_authority: wire.global_authority,
      projection: wire.projection,
      cleanup_state: {
        status: "pending",
        entries: [
          {
            cleanup_id: CLEANUP_ID,
            scope: "task",
            task_id: TASK_ID,
            status: "pending",
            phase: "owned",
          },
        ],
      },
      active_count: wire.active_count,
      queue_depth: wire.queue_depth,
      held_count: wire.held_count,
      held_tasks: wire.held_tasks,
      task_controls: wire.task_controls,
      degraded_targets: wire.degraded_targets,
    });
    expect(cleanup.cleanup_state.entries[0]).toMatchObject({
      scope: "task",
      task_id: TASK_ID,
      phase: "owned",
    });
  });
});
