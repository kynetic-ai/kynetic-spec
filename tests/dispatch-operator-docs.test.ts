import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import factsFixture from "./fixtures/dispatch-operator-facts.json" with { type: "json" };
import {
  KspecConfigSchema,
  getDefaultConfig,
  resolveDispatchRemoteSync,
} from "../src/parser/config.js";
import { AgentDispatchRuleSchema } from "../src/schema/meta.js";
import {
  DispatchCleanupErrorCodeSchema as DurableCleanupErrorCodeSchema,
  DispatchCleanupEntryStatusSchema as DurableCleanupEntryStatusSchema,
  DispatchCleanupStateSchema as DurableCleanupStateSchema,
  DispatchCleanupPhaseSchema,
  DispatchControlAuthoritySchema,
  DispatchTaskControlModeSchema,
  createMissingDispatchControl,
} from "../src/schema/dispatch-control.js";
import { DISPATCH_CONTROL_FILE, readDispatchControlFile } from "../src/parser/dispatch-control.js";
import {
  assertTaskLifecycleTransition,
  DISPATCH_CONTROL_FAILURE_CODE_BY_PREDICATE,
  resolveGlobalLifecycleTransition,
} from "../src/agent-runtime/dispatch.js";
import { loadDispatchBootstrapAuthority } from "../src/agent-runtime/bootstrap.js";
import {
  projectDispatchCleanupState,
  type DispatchLifecycleAuthorityStore,
} from "../src/agent-runtime/dispatch-control-store.js";
import { EVENT_PAYLOAD_SCHEMAS } from "../src/schema/event-payloads.js";
import {
  DispatchCleanupEntryStatusSchema,
  DispatchCleanupErrorCodeSchema,
  DispatchControlErrorCodeSchema,
  DispatchHeldTaskSchema,
  DispatchLifecycleStatusSchema,
  DispatchTaskControlStatusSchema,
} from "../packages/shared/src/api.js";
import { createProgram } from "../src/cli/index.js";
import {
  extractCommandTree,
  flattenCommandTree,
  formatCommandUsage,
  type CommandMeta,
} from "../src/cli/introspection.js";
import {
  cleanupTempDir,
  createTempDir,
  kspec,
  kspecJson,
  setupTempFixtures,
} from "./helpers/cli.js";
import { createAgentDispatchRoutes } from "../dist/daemon/routes/agent-dispatch.js";

const modeState = vi.hoisted(() => ({ staticMode: false }));
vi.mock("../packages/web-ui/src/lib/stores/mode.svelte", () => ({
  isStaticMode: () => modeState.staticMode,
  assertWritable: (operation: string) => {
    if (modeState.staticMode) throw new Error(`Cannot ${operation} in read-only mode.`);
  },
  ReadOnlyModeError: class ReadOnlyModeError extends Error {},
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

import {
  controlDispatchLifecycle,
  fetchAgentStatus,
  parseAgentDispatchStatusWire,
} from "../packages/web-ui/src/lib/api.js";
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

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizedHelp(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function expectFullReferenceMetadata(stdout: string, commands: CommandMeta[]): void {
  const normalized = normalizedHelp(stdout);
  for (const command of commands.filter((candidate) => candidate.name !== "kspec")) {
    expect(normalized).toContain(normalizedHelp(formatCommandUsage(command)));
    if (command.description) expect(normalized).toContain(normalizedHelp(command.description));
    for (const option of command.options) {
      expect(normalized).toContain(normalizedHelp(`${option.flags} ${option.description}`));
    }
    for (const argument of command.arguments) {
      const marker = argument.required ? `<${argument.name}` : `[${argument.name}`;
      expect(formatCommandUsage(command)).toContain(marker);
    }
  }
}

function cleanupSnapshot() {
  return {
    ...createMissingDispatchControl(),
    pending_cleanup: {
      global: {
        cleanup_id: CLEANUP_ID,
        status: "failed" as const,
        phase: "owned" as const,
        error_code: "cancellation_timeout" as const,
        targets: [],
      },
      [TASK_ID]: {
        cleanup_id: "01KXH2PXT88X9MSC62MQVY2CW2",
        status: "pending" as const,
        phase: "signals_sent" as const,
        targets: [],
      },
    },
  };
}

function validateFacts(facts: DispatchFacts): void {
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", facts.evidence.reviewed_lifecycle_commit, "HEAD"],
    {
      cwd: ROOT,
    },
  );
  expect(
    execFileSync(
      "git",
      [
        "merge-base",
        "HEAD",
        "origin/plan/plan-dispatch-lifecycle-pause-resume-and-stop-controls/01kxc2vx",
      ],
      { cwd: ROOT, encoding: "utf8" },
    ).trim(),
  ).toBe(facts.evidence.integration_target_at_freeze);
  expect(facts.evidence.source_matrix.map((row) => row.group)).toEqual([
    "workspace-configuration",
    "lifecycle-authority-and-durability",
    "cli-and-identity",
    "api-status-control",
    "ui-projection-accessibility",
    "events-safety-recovery",
  ]);
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
  expect(facts.workspace.config_keys).toEqual([
    "base_branch",
    "worktree_root",
    "publication_mode",
    "bootstrap",
    "sync_interval",
    "remote_sync",
  ]);
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
  expect(facts.workspace.remote_sync_default).toBe("enabled exactly when a remote exists");
  expect(facts.workspace.worktree_root_resolution).toBe(
    "relative paths resolve from the project root; absolute paths remain absolute",
  );
  expect(facts.workspace.base_target_precedence).toEqual([
    "plan branch",
    "configured dispatch base branch",
    "remote HEAD",
    "current branch",
    "main",
  ]);
  expect(facts.workspace.bootstrap.order).toEqual([
    "project bootstrap",
    "role-filtered agent bootstrap",
    "agent prompt",
  ]);
  expect(facts.workspace.bootstrap.roles).toEqual(["worker", "reviewer"]);
  expect(facts.workspace.bootstrap.step_keys).toEqual([
    "run",
    "name",
    "roles",
    "idempotent",
    "allow_tracked_changes",
    "reviewer_rerun_allowed",
  ]);
  expect(facts.workspace.bootstrap.scope).toBe("dispatch workspaces only");
  expect(facts.workspace.bootstrap.tracked_mutation_default).toContain("rejected");
  expect(facts.workspace.bootstrap.reviewer_behavior).toContain("role-filtered");
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
  expect(facts.workspace.publication_modes).toEqual(["pull_request", "manual_merge", "auto"]);
  expect(
    AgentDispatchRuleSchema.parse({
      on: "task.ready",
      filter: { automation: "eligible", tags: ["docs"], priority: 1 },
    }),
  ).toEqual({
    on: "task.ready",
    filter: { automation: "eligible", tags: ["docs"], priority: 1 },
  });
  expect(facts.workspace.rule_keys).toEqual(["on", "filter"]);
  expect(facts.workspace.rule_filter_keys).toEqual(["automation", "tags", "priority"]);
  expect(facts.workspace.default_agent_skills).toEqual(defaults.agent.skills);

  const exportedCommands = flattenCommandTree(extractCommandTree(createProgram())).map((command) =>
    command.fullPath.join(" "),
  );
  expect(facts.workspace.no_workspace_command).toBe(true);
  expect(exportedCommands.some((command) => command.includes("dispatch workspace"))).toBe(false);
  expect(facts.workspace.one_shot_agent_run_controlled).toBe(false);
  expect(exportedCommands).toContain("kspec agent run");

  const transitionSnapshot = createMissingDispatchControl();
  expect(resolveGlobalLifecycleTransition(transitionSnapshot, "start")).toBe("running");
  transitionSnapshot.global.authority = "running";
  expect(resolveGlobalLifecycleTransition(transitionSnapshot, "pause")).toBe("paused");
  expect(resolveGlobalLifecycleTransition(transitionSnapshot, "resume")).toBe("running");
  transitionSnapshot.global.authority = "paused";
  expect(resolveGlobalLifecycleTransition(transitionSnapshot, "pause")).toBe("paused");
  expect(resolveGlobalLifecycleTransition(transitionSnapshot, "resume")).toBe("running");
  expect(() => resolveGlobalLifecycleTransition(transitionSnapshot, "start")).toThrow();
  expect(facts.lifecycle.transitions).toEqual({
    start: "valid from cleanup-idle stopped",
    pause: "holds new admission while active work finishes naturally",
    resume: "valid from paused and reconciles held work subject to task controls",
    stop: "commits stopped authority before cancelling verified dispatch-owned work",
  });
  expect(facts.lifecycle.identity).toEqual({
    accepted_input: "resolvable task reference alias",
    durable_key: "canonical task ULID",
    rejected: ["missing identity", "ambiguous identity", "not found", "ref/id disagreement"],
    isolation: "unrelated task controls and cleanup remain independent",
  });
  expect(facts.lifecycle.durability.path).toBe(`.kspec/${DISPATCH_CONTROL_FILE}`);
  expect(facts.lifecycle.durability.startup_order).toEqual([
    "load committed control",
    "retry matching pending cleanup",
    "schedule bootstrap/admission",
  ]);
  expect(facts.lifecycle.durability.final_admission_rechecks).toEqual([
    "global authority",
    "canonical task authority",
  ]);
  expect(facts.lifecycle.durability.readiness_mutated).toBe(false);
  expect(facts.lifecycle.durability.degraded_targets_mutated).toBe(false);

  expect(facts.lifecycle.global_actions).toEqual({
    stopped: ["start"],
    running: ["pause", "stop"],
    paused: ["resume", "stop"],
    stopped_with_cleanup: ["stop"],
  });
  expect(facts.lifecycle.task_actions).toEqual({
    uncontrolled: ["pause", "stop"],
    paused: ["resume", "stop"],
    stopped: ["resume"],
    stopped_with_cleanup: ["stop"],
  });

  const scopedCleanup = cleanupSnapshot();
  expect(projectDispatchCleanupState(scopedCleanup, { scope: "global" }).entries).toHaveLength(1);
  expect(
    projectDispatchCleanupState(scopedCleanup, { scope: "task", task_id: TASK_ID }).entries,
  ).toHaveLength(1);
  expect(() => assertTaskLifecycleTransition(scopedCleanup, TASK_ID, "resume")).toThrow();
  expect(() =>
    assertTaskLifecycleTransition(scopedCleanup, "01KG0RR6CA45ZT43W2T6HJMVA2", "resume"),
  ).not.toThrow();

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
  expect(facts.lifecycle.projections).toEqual(["running", "paused", "draining", "stopped"]);
  expect(parsedWire.held_count).toBe(parsedWire.held_tasks.length);
  expect(facts.lifecycle.held_task_fields.toSorted()).toEqual(
    Object.keys(DispatchHeldTaskSchema.parse(wire.held_tasks[0])).toSorted(),
  );
  expect(facts.lifecycle.task_control_fields.toSorted()).toEqual(
    Object.keys(DispatchTaskControlStatusSchema.parse(wire.task_controls[0])).toSorted(),
  );
  const failedCleanupEntry = DispatchCleanupEntryStatusSchema.parse({
    cleanup_id: CLEANUP_ID,
    scope: "task",
    task_id: TASK_ID,
    status: "failed",
    phase: "owned",
    error_code: "cancellation_timeout",
  });
  expect(facts.lifecycle.cleanup.entry_fields.toSorted()).toEqual(
    Object.keys(failedCleanupEntry).toSorted(),
  );
  expect(facts.lifecycle.cleanup.statuses).toEqual(["idle", "pending", "failed"]);
  expect(facts.lifecycle.cleanup.scopes).toEqual(["global", "task"]);
  expect(facts.lifecycle.cleanup.gate_scope).toBe(
    "global operations inspect global cleanup; task operations inspect only matching task cleanup",
  );
  expect(facts.lifecycle.cleanup.aggregate_is_observability_only).toBe(true);
  expect(DurableCleanupEntryStatusSchema.parse(failedCleanupEntry)).toEqual(failedCleanupEntry);
  expect(
    DurableCleanupStateSchema.parse({ status: "failed", entries: [failedCleanupEntry] }),
  ).toEqual({ status: "failed", entries: [failedCleanupEntry] });

  const uiStatus = parseAgentDispatchStatusWire(publicStatusWire());
  expect(uiStatus).toMatchObject({
    globalAuthority: "paused",
    projection: "draining",
    activeCount: 1,
    queueDepth: 2,
    heldCount: 1,
  });
  expect(uiStatus.heldTasks[0]).toMatchObject({ taskId: TASK_ID, scope: "global" });
  for (const [wireKey, uiKey] of Object.entries(facts.ui.mapping)) {
    expect((uiStatus as unknown as Record<string, unknown>)[uiKey]).toBeDefined();
    expect((wire as unknown as Record<string, unknown>)[wireKey]).toBeDefined();
  }
  expect(facts.ui.route).toBe("/agents");
  expect(facts.ui.writable_actions).toEqual({
    running: ["pause", "stop"],
    paused: ["resume", "stop"],
    stopped: ["start"],
  });
  expect(
    getGlobalLifecycleActions({
      ...uiStatus,
      globalAuthority: "running",
      projection: "running",
    }),
  ).toEqual(facts.lifecycle.global_actions.running);
  expect(getGlobalLifecycleActions(uiStatus)).toEqual(facts.lifecycle.global_actions.paused);
  expect(
    getGlobalLifecycleActions({
      ...uiStatus,
      globalAuthority: "stopped",
      projection: "stopped",
      cleanupState: { status: "idle", entries: [] },
    }),
  ).toEqual(facts.lifecycle.global_actions.stopped);
  expect(
    getGlobalLifecycleActions({
      ...uiStatus,
      globalAuthority: "stopped",
      projection: "stopped",
      cleanupState: {
        status: "pending",
        entries: [
          {
            cleanupId: CLEANUP_ID,
            scope: "global",
            status: "pending",
            phase: "owned",
          },
        ],
      },
    }),
  ).toEqual(facts.lifecycle.global_actions.stopped_with_cleanup);
  expect(getTaskLifecycleActions(uiStatus, "01KG0RR6CA45ZT43W2T6HJMVA2")).toEqual(
    facts.lifecycle.task_actions.uncontrolled,
  );
  expect(getTaskLifecycleActions(uiStatus, TASK_ID)).toEqual(facts.lifecycle.task_actions.paused);
  const stoppedTaskStatus = {
    ...uiStatus,
    taskControls: [{ ...uiStatus.taskControls[0]!, mode: "stopped" as const }],
  };
  expect(getTaskLifecycleActions(stoppedTaskStatus, TASK_ID)).toEqual(
    facts.lifecycle.task_actions.stopped,
  );
  expect(
    getTaskLifecycleActions(
      {
        ...stoppedTaskStatus,
        taskControls: [
          {
            ...stoppedTaskStatus.taskControls[0]!,
            cleanupState: {
              status: "pending",
              entries: [
                {
                  cleanupId: CLEANUP_ID,
                  scope: "task",
                  taskId: TASK_ID,
                  status: "pending",
                  phase: "owned",
                },
              ],
            },
          },
        ],
      },
      TASK_ID,
    ),
  ).toEqual(facts.lifecycle.task_actions.stopped_with_cleanup);
  expect(facts.ui.writable_actions).toEqual({
    running: facts.lifecycle.global_actions.running,
    paused: facts.lifecycle.global_actions.paused,
    stopped: facts.lifecycle.global_actions.stopped,
  });
  expect(HARD_STOP_CONFIRMATION.description).toContain("evidence will be preserved");
  expect(facts.ui.hard_stop_confirmation).toBe(true);
  if (facts.ui.visible_evidence.length === 0) throw new Error("missing UI fact");
  expect(facts.ui.accessibility).toEqual([
    "labelled lifecycle controls",
    "focus retained after actions",
    "polite status announcements",
    "assertive failure announcements",
  ]);
  expect(facts.ui.visible_evidence).toEqual([
    "active",
    "queued",
    "held",
    "cleanup",
    "degraded targets",
  ]);
  expect(facts.ui.static_mode).toBe("stopped and read-only");

  const eventNames = Object.keys(EVENT_PAYLOAD_SCHEMAS)
    .filter((name) => name.startsWith("dispatch_control."))
    .toSorted();
  expect(facts.events.names.toSorted()).toEqual(eventNames);
  expect(facts.events.selected_for_public_docs).toBe(true);
  expect(facts.events.task_identity).toBe("canonical task identity");
  expect(facts.events.failure_contract).toBe("closed error code; no raw error or path");

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
  expect(facts.command_tree.help_modes).toEqual([
    "kspec --help",
    "kspec help --all",
    "kspec help --json",
  ]);
  if (!facts.api.control.path || !facts.api.status.path) throw new Error("missing API fact");
  expect(facts.api.control).toEqual({ method: "POST", path: "/api/agent/dispatch/control" });
  expect(facts.api.status).toEqual({ method: "GET", path: "/api/agent/status" });
  expect(facts.api.compatibility_status).toEqual({
    method: "GET",
    path: "/api/agent/dispatch/status",
  });
  expect(facts.api.wire_case).toBe("snake_case");
  expect(facts.api.control_error_includes_current_status).toBe(true);
  const lifecycleRoutes = createAgentDispatchRoutes()
    .routes.filter((route) =>
      /^\/api\/agent\/(?:status|dispatch\/(?:status|control))$/.test(route.path),
    )
    .map((route) => `${route.method} ${route.path}`)
    .toSorted();
  expect(lifecycleRoutes).toEqual(
    [facts.api.control, facts.api.status, facts.api.compatibility_status]
      .map((route) => `${route.method} ${route.path}`)
      .toSorted(),
  );

  expect(facts.safety.interactive_stop).toBe(
    "confirms active cancellation and evidence preservation",
  );
  expect(facts.safety.noninteractive_stop).toBe("requires --force");
  expect(facts.safety.json_stop).toBe("requires --force");
  expect(facts.safety.host_stop_rejected).toBe(true);
  expect(facts.safety.dispatch_owned_only).toBe(true);
  expect(facts.safety.evidence_preserved).toEqual([
    "session",
    "branch",
    "workspace",
    "worktree",
    "snapshot",
    "audit",
  ]);
  for (const evidence of facts.safety.evidence_preserved) {
    expect(HARD_STOP_CONFIRMATION.description.toLowerCase()).toContain(evidence);
  }
  expect(facts.safety.failure_authority).toBe(
    "hard-stop failure remains stopped with retryable pending or failed matching cleanup",
  );
  expect(Object.values(DISPATCH_CONTROL_FAILURE_CODE_BY_PREDICATE).toSorted()).toEqual(
    [...new Set(facts.safety.control_error_codes)].toSorted(),
  );

  expect(facts.limitations).toEqual([
    "pause is a graceful admission hold; stop is hard stop",
    "no checkpointing",
    "no distributed scheduler",
    "no exact durable FIFO promise",
    "no workspace deletion or reset command",
    "no control of arbitrary one-shot processes",
    "one-shot kspec agent run is outside lifecycle control unless dispatch-owned",
    "recovery may remain pending when ownership, process birth, or group identity cannot be proven",
    "remote branch synchronization remains incomplete and must be documented as limited where not behaviorally proven",
    "lifecycle controls do not delete workspaces",
  ]);
  expect(exportedCommands.some((command) => /workspace (?:delete|reset)/.test(command))).toBe(
    false,
  );
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

  afterEach(() => {
    modeState.staticMode = false;
    vi.unstubAllGlobals();
  });

  // AC: @auto-cli-docs ac-3
  it("captures the complete observable help reference from an explicit fixture cwd", () => {
    const rootHelp = kspec("--help", fixtureDir);
    const fullHelp = kspec("help --all", fixtureDir);
    expect(rootHelp.exitCode).toBe(0);
    expect(fullHelp.exitCode).toBe(0);
    const commandTree = extractCommandTree(createProgram());
    expectFullReferenceMetadata(fullHelp.stdout, flattenCommandTree(commandTree));
    expect(rootHelp.stdout).toContain(commandTree.description);
    for (const command of commandTree.subcommands) {
      expect(rootHelp.stdout).toContain(command.name);
      expect(normalizedHelp(rootHelp.stdout)).toContain(normalizedHelp(command.description));
    }
  });

  // AC: @auto-cli-docs ac-4
  it("captures structured JSON help from an explicit fixture cwd", () => {
    const output = kspecJson<{ commands: CommandMeta }>("help --json", fixtureDir);
    expect(output.commands).toEqual(jsonRoundTrip(extractCommandTree(createProgram())));
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

  it("binds durable default and bootstrap ordering to exported behavior", async () => {
    const emptySpecDir = await createTempDir("dispatch-fact-default-");
    try {
      expect(await readDispatchControlFile(emptySpecDir)).toEqual(createMissingDispatchControl());
    } finally {
      await cleanupTempDir(emptySpecDir);
    }

    const calls: string[] = [];
    const snapshot = createMissingDispatchControl();
    const store: DispatchLifecycleAuthorityStore = {
      setPublicationListener: () => undefined,
      loadCommitted: async () => {
        calls.push("load committed control");
        return { snapshot, token: { revision: 0, commit_oid: "test" } };
      },
      getPublication: () => ({ snapshot, token: { revision: 0, commit_oid: "test" } }),
      getDegradedReason: () => null,
      mutate: async () => ({ snapshot, token: { revision: 0, commit_oid: "test" } }),
    };
    expect((await loadDispatchBootstrapAuthority(store)).snapshot.global.authority).toBe(
      factsFixture.lifecycle.missing_state_default,
    );
    expect(calls).toEqual([factsFixture.lifecycle.durability.startup_order[0]]);
  });

  it("binds canonical API and static UI facts to observable public helpers", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const wire = publicStatusWire();
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: {
              global_authority: wire.global_authority,
              projection: wire.projection,
              cleanup_state: wire.cleanup_state,
              active_count: wire.active_count,
              queue_depth: wire.queue_depth,
              held_count: wire.held_count,
              held_tasks: wire.held_tasks,
              task_controls: wire.task_controls,
              degraded_targets: wire.degraded_targets,
              outcome: "applied",
            },
            error: null,
          }),
        } as Response;
      }),
    );
    const result = await controlDispatchLifecycle({ scope: "global", action: "pause" });
    expect(requests).toEqual([
      {
        url: `http://localhost:3456${factsFixture.api.control.path}`,
        method: factsFixture.api.control.method,
        body: { scope: "global", action: "pause" },
      },
    ]);
    expect(result.status.globalAuthority).toBe("paused");

    modeState.staticMode = true;
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fetchAgentStatus()).toMatchObject({
      globalAuthority: "stopped",
      projection: "stopped",
      activeCount: 0,
      queueDepth: 0,
      heldCount: 0,
    });
    await expect(controlDispatchLifecycle({ scope: "global", action: "pause" })).rejects.toThrow(
      /read-only mode/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("binds hard-stop force safety to observable CLI behavior", () => {
    const noninteractive = kspec("agent dispatch stop", fixtureDir, { expectFail: true });
    expect(noninteractive.exitCode).not.toBe(0);
    expect(noninteractive.stderr).toContain("Hard stop requires --force");

    const json = kspec("agent dispatch stop --json", fixtureDir, { expectFail: true });
    expect(json.exitCode).not.toBe(0);
    expect(json.stderr).toContain("Hard stop requires --force");
  });

  it("rejects stale facts in every structured fact group", () => {
    const mutations: Array<[string, (facts: DispatchFacts) => void]> = [
      ["evidence", (facts) => (facts.evidence.integration_target_at_freeze = "0".repeat(40))],
      ["workspace", (facts) => (facts.workspace.bootstrap.scope = "all workspaces")],
      ["command tree", (facts) => facts.command_tree.help_modes.pop()],
      ["transitions", (facts) => (facts.lifecycle.transitions.pause = "checkpoint active work")],
      ["durability", (facts) => (facts.lifecycle.durability.path = ".kspec/other.yaml")],
      ["status fields", (facts) => facts.lifecycle.held_task_fields.pop()],
      ["cleanup", (facts) => (facts.lifecycle.cleanup.aggregate_is_observability_only = false)],
      ["API", (facts) => (facts.api.compatibility_status.path = "/api/other")],
      ["UI", (facts) => (facts.ui.static_mode = "writable")],
      ["events", (facts) => (facts.events.failure_contract = "raw errors")],
      ["safety", (facts) => facts.safety.evidence_preserved.pop()],
      ["limitations", (facts) => facts.limitations.pop()],
    ];
    for (const [label, mutate] of mutations) {
      const stale = cloneFacts();
      mutate(stale);
      expect(() => validateFacts(stale), label).toThrow();
    }
  });
});
