import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as YAML from "yaml";
import factsFixture from "./fixtures/dispatch-operator-facts.json" with { type: "json" };
import {
  KspecConfigSchema,
  getDefaultConfig,
  resolveDispatchRemoteSync,
} from "../src/parser/config.js";
import {
  AgentBootstrapStepSchema,
  AgentDispatchFilterSchema,
  AgentDispatchRuleSchema,
} from "../src/schema/meta.js";
import {
  DispatchCleanupErrorCodeSchema as DurableCleanupErrorCodeSchema,
  DispatchCleanupEntryStatusSchema as DurableCleanupEntryStatusSchema,
  DispatchCleanupStateSchema as DurableCleanupStateSchema,
  DispatchCleanupPhaseSchema,
  DispatchControlAuthoritySchema,
  DispatchTaskControlModeSchema,
  DispatchControlSchema,
  createMissingDispatchControl,
  type DispatchControl,
} from "../src/schema/dispatch-control.js";
import { DISPATCH_CONTROL_FILE, readDispatchControlFile } from "../src/parser/dispatch-control.js";
import {
  DispatchEngine,
  assertTaskLifecycleTransition,
  DISPATCH_CONTROL_FAILURE_CODE_BY_PREDICATE,
  resolveGlobalLifecycleTransition,
} from "../src/agent-runtime/dispatch.js";
import * as bootstrapModule from "../src/agent-runtime/bootstrap.js";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import * as workspaceModule from "../src/agent-runtime/workspace.js";
import {
  DispatchBootstrapError,
  ensureWorkspaceBootstrap,
  loadDispatchBootstrapAuthority,
} from "../src/agent-runtime/bootstrap.js";
import {
  provisionDispatchWorkspace,
  resolveDispatchWorkspaceConfig,
} from "../src/agent-runtime/workspace.js";
import { buildTaskRefResolver, normalizeTaskIdentity } from "../src/agent-runtime/task-identity.js";
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
import { createProgram, program } from "../src/cli/index.js";
import {
  extractCommandTree,
  flattenCommandTree,
  formatCommandUsage,
  type CommandMeta,
} from "../src/cli/introspection.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  kspecJson,
  readTestOutput,
  setupTempFixtures,
  seedSplitTask,
  testUlid,
  testUlids,
} from "./helpers/cli.js";
import { createAgentDispatchRoutes } from "../dist/daemon/routes/agent-dispatch.js";
import type { LoadedTask } from "../src/parser/yaml.js";
import type { Agent } from "../src/schema/meta.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";

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
  getGlobalActionLabel,
  getGlobalLifecycleActions,
  getTaskLifecycleActions,
} from "../packages/web-ui/src/lib/dispatch-lifecycle.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TASK_ID = "01KG0RR6CA45ZT43W2T6HJMVA1";
const CLEANUP_ID = "01KXH2PXT88X9MSC62MQVY2CW1";
const NOW = "2026-07-16T12:00:00.000Z";
const MOCK_KSPEC_CLI = join(ROOT, "tests", "mocks", "kspec-capture-mock.cjs");
ensureSplitBackendRegistered();
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function seedFactProject(projectDir: string): Promise<void> {
  initGitRepo(projectDir);
  await writeFile(join(projectDir, "README.md"), "seed\n", "utf8");
  git(projectDir, "add", "README.md");
  git(projectDir, "commit", "-m", "seed");
  git(projectDir, "branch", "dev");
  await writeFile(
    join(projectDir, "kynetic.yaml"),
    'kynetic: "1.1"\ntitle: Documentation facts\ntask_storage:\n  format: split\n',
    "utf8",
  );
  await writeFile(join(projectDir, "project.tasks.yaml"), "tasks: []\n", "utf8");
  await writeFile(
    join(projectDir, "project.plans.yaml"),
    YAML.stringify({
      kynetic_plans: "1.0",
      plans: [
        {
          _ulid: testUlids("PLAN", 1)[0],
          slugs: ["docs-plan"],
          title: "Docs plan",
          content: "",
          status: "active",
          derived_tasks: [],
          derived_specs: [],
          source_path: null,
          module_ref: null,
          branch: "dev",
          created_at: NOW,
          approved_at: null,
          completed_at: null,
          notes: [],
        },
      ],
    }),
    "utf8",
  );
}

function factAgent(bootstrapRun?: string): Agent {
  return {
    _ulid: testUlids("AGNT", 1)[0]!,
    id: "docs-fact-agent",
    name: "Docs fact agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [],
    skills: [],
    concurrency: { max_concurrent: 1 },
    auto_approve: false,
    tags: [],
    ...(bootstrapRun ? { bootstrap: { steps: [{ run: bootstrapRun, roles: ["worker"] }] } } : {}),
  };
}

function deferredBarrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((settle) => (enter = settle));
  const blocked = new Promise<void>((settle) => (release = settle));
  return { entered, release, arrive: async () => (enter(), blocked) };
}

class FactLifecycleStore implements DispatchLifecycleAuthorityStore {
  private publication: {
    snapshot: DispatchControl;
    token: { revision: number; commit_oid: string };
  };
  private listener: ((publication: this["publication"]) => void) | undefined;
  readonly operations: string[] = [];

  constructor(snapshot: DispatchControl) {
    this.publication = {
      snapshot: DispatchControlSchema.parse(snapshot),
      token: { revision: snapshot.revision, commit_oid: `fact-${snapshot.revision}` },
    };
  }

  setPublicationListener(_key: string, listener: (publication: this["publication"]) => void): void {
    this.listener = listener;
  }

  async loadCommitted() {
    this.operations.push("load committed control");
    this.listener?.(this.publication);
    return this.publication;
  }

  getPublication() {
    return this.publication;
  }

  getDegradedReason(): string | null {
    return null;
  }

  async mutate(
    operation: string,
    mutation: (
      snapshot: DispatchControl,
    ) => DispatchControl | null | Promise<DispatchControl | null>,
  ) {
    this.operations.push(operation);
    const next = await mutation(structuredClone(this.publication.snapshot));
    if (next) this.commit(next);
    return this.publication;
  }

  commit(snapshot: DispatchControl): void {
    const validated = DispatchControlSchema.parse(snapshot);
    this.publication = {
      snapshot: validated,
      token: { revision: validated.revision, commit_oid: `fact-${validated.revision}` },
    };
    this.listener?.(this.publication);
  }
}

async function createAdmissionHarness(snapshot: DispatchControl) {
  const projectDir = await createTempDir("dispatch-doc-admission-facts-");
  initGitRepo(projectDir);
  await writeFile(join(projectDir, "README.md"), "seed\n", "utf8");
  git(projectDir, "add", "README.md");
  git(projectDir, "commit", "-m", "seed");
  await writeFile(
    join(projectDir, "kynetic.yaml"),
    'kynetic: "1.1"\ntitle: Admission facts\ntask_storage:\n  format: split\n',
    "utf8",
  );
  const taskId = testUlid("FACT", 1);
  await writeFile(
    join(projectDir, "kynetic.meta.yaml"),
    YAML.stringify({
      kynetic_meta: "1.0",
      agents: [
        {
          _ulid: testUlid("AGNT", 2),
          id: "fact-worker",
          name: "Fact worker",
          adapter: "mock-acp",
          capabilities: [],
          tools: [],
          conventions: [],
          skills: [],
          auto_approve: false,
          concurrency: { max_concurrent: 1 },
          dispatch: [{ on: "task.ready" }],
        },
      ],
    }),
    "utf8",
  );
  seedSplitTask(projectDir, {
    _ulid: taskId,
    type: "task",
    title: "Admission fact task",
    slugs: ["admission-fact-task"],
    status: "pending",
    priority: 1,
    automation: "eligible",
    depends_on: [],
    blocked_by: [],
    tags: [],
    notes: [],
    created_at: NOW,
  });

  const store = new FactLifecycleStore(snapshot);
  const metadata = {
    workspaceId: "fact-workspace",
    taskId,
    taskRef: `@${taskId}`,
    taskSlug: "admission-fact-task",
    baseBranch: "main",
    baseBranchPoint: git(projectDir, "rev-parse", "HEAD"),
    mergeTargetBranch: "main",
    integrationTargetBranch: "main",
    canonicalBranch: "dispatch/task/admission-fact-task/fact",
    canonicalBranchHead: git(projectDir, "rev-parse", "HEAD"),
    publicationMode: "manual_merge",
    lifecycleState: "ready",
    activeRole: null,
    workerWorktreeDir: projectDir,
    reviewerWorktreeDir: null,
    worktreeRoot: join(projectDir, ".worktrees"),
    bootstrap: {
      status: "ready",
      lastRole: "worker",
      roleStates: {
        worker: { status: "ready", steps: [], invalidationReasons: [] },
        reviewer: { status: "not_run", steps: [], invalidationReasons: [] },
      },
    },
  };
  const provisioned = {
    cwd: projectDir,
    metadataPath: join(projectDir, ".kspec-dispatch-workspace.json"),
    metadata: metadata as never,
  };
  vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceRegistry").mockResolvedValue();
  vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceArtifacts").mockResolvedValue();
  vi.spyOn(workspaceModule, "reconcileDispatchWorkspaceLifecycle").mockResolvedValue();
  vi.spyOn(workspaceModule, "provisionDispatchWorkspace").mockResolvedValue(provisioned);
  vi.spyOn(workspaceModule, "markDispatchWorkspaceActive").mockResolvedValue(provisioned);
  vi.spyOn(workspaceModule, "markDispatchWorkspaceIdle").mockResolvedValue(provisioned);
  vi.spyOn(bootstrapModule, "ensureWorkspaceBootstrap").mockResolvedValue({
    metadata: metadata as never,
    reused: true,
    ranSteps: false,
  });

  const gate = deferredBarrier();
  let gated = false;
  const events: string[] = [];
  const artifacts: string[] = [];
  vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (options) => {
    events.push("invocation candidate");
    if (gated) await gate.arrive();
    const handoff = await options.beforeCreate?.();
    if (!handoff) throw new Error("admission fact omitted handoff");
    artifacts.push(handoff.taskId ?? "");
    await options.onOwnershipPersisted?.({
      invocation_id: handoff.invocationId,
      session_id: handoff.sessionId,
      task_id: handoff.taskId,
      agent_id: handoff.agentId,
      adapter: handoff.adapter,
      owner_instance_id: handoff.ownerInstanceId,
      pid: process.pid,
      pgid: process.pid,
      process_start_ticks: "1",
      process_identity_platform: "linux_proc_stat_v1",
      captured_at: NOW,
      group_members: [{ pid: process.pid, process_start_ticks: "1" }],
    });
    return { session: {} as never, outcome: "success", durationMs: 1, turnCount: 1 };
  });
  const engine = new DispatchEngine({
    projectDir,
    specDir: projectDir,
    kspecCliPath: MOCK_KSPEC_CLI,
    reconcileIntervalMs: 0,
    coalesceWindowMs: 0,
    lifecycleStore: store,
    stopRecoveryRuntime: {
      readProcess: async () => null,
      listProcessGroup: async () => [],
      signalProcessGroup: async () => undefined,
      waitForProcessGroupExit: async () => true,
      closeSession: async () => undefined,
    },
  });
  return {
    projectDir,
    taskId,
    store,
    engine,
    gate,
    events,
    artifacts,
    enableGate: () => (gated = true),
  };
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

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizedHelp(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fullReferenceBlocks(stdout: string): Map<string, string> {
  const lines = stdout.split(/\r?\n/);
  const blocks = new Map<string, string>();
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index]!;
    if (!heading.startsWith("kspec ")) continue;
    let end = index + 1;
    while (end < lines.length && !lines[end]!.startsWith("kspec ")) end++;
    blocks.set(normalizedHelp(heading), normalizedHelp(lines.slice(index, end).join("\n")));
  }
  return blocks;
}

function expectFullReferenceMetadata(stdout: string, commands: CommandMeta[]): void {
  const blocks = fullReferenceBlocks(stdout);
  for (const command of commands.filter((candidate) => candidate.name !== "kspec")) {
    const usage = normalizedHelp(formatCommandUsage(command));
    const block = blocks.get(usage);
    expect(block, `missing command-scoped help block for ${usage}`).toBeDefined();
    if (!block) continue;
    if (command.description) expect(block).toContain(normalizedHelp(command.description));
    for (const option of command.options) {
      expect(block).toContain(normalizedHelp(`${option.flags} ${option.description}`));
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
  const dispatchConfigSchema = KspecConfigSchema.shape.dispatch.unwrap();
  expect(facts.workspace.config_keys).toEqual(Object.keys(dispatchConfigSchema.shape));
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
  expect(facts.workspace.base_target_precedence).toEqual({
    plan_over_configured: true,
    configured_over_fallback: true,
  });
  expect(facts.workspace.publication_modes).toEqual(
    dispatchConfigSchema.shape.publication_mode.unwrap().options,
  );
  expect(facts.workspace.bootstrap.roles).toEqual(
    AgentBootstrapStepSchema.shape.roles.unwrap().element.options,
  );
  expect(facts.workspace.bootstrap.step_keys).toEqual(Object.keys(AgentBootstrapStepSchema.shape));
  expect(facts.workspace.bootstrap).toMatchObject({
    project_steps_before_agent_steps: true,
    tracked_mutation_requires_opt_in: true,
    reviewer_reruns_only_safe_steps: true,
  });
  expect(
    AgentDispatchRuleSchema.parse({
      on: "task.ready",
      filter: { automation: "eligible", tags: ["docs"], priority: 1 },
    }),
  ).toEqual({
    on: "task.ready",
    filter: { automation: "eligible", tags: ["docs"], priority: 1 },
  });
  expect(facts.workspace.rule_keys).toEqual(Object.keys(AgentDispatchRuleSchema.shape));
  expect(facts.workspace.rule_filter_keys).toEqual(Object.keys(AgentDispatchFilterSchema.shape));
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
  const [identityA, identityB] = testUlids("DOCS", 2);
  const identityResolver = buildTaskRefResolver([
    { _ulid: identityA, slugs: ["docs-alpha"] } as LoadedTask,
    { _ulid: identityB, slugs: ["docs-beta"] } as LoadedTask,
  ]);
  const acceptedAliases = [
    ["slug", "@docs-alpha"],
    ["full ULID", `@${identityA}`],
    ["unique ULID prefix", `@${identityA.slice(0, 25)}`],
  ] as const;
  expect(facts.lifecycle.identity.accepted_aliases).toEqual(
    acceptedAliases.map(([label]) => label),
  );
  for (const [, taskRef] of acceptedAliases) {
    const result = normalizeTaskIdentity({ taskRef, source: "docs-fact" }, identityResolver);
    expect(result).toMatchObject({ ok: true, canonicalTaskId: identityA });
  }
  const rejectedIdentities = [
    normalizeTaskIdentity({ source: "docs-fact" }, identityResolver),
    normalizeTaskIdentity(
      { taskRef: `@${identityA.slice(0, 10)}`, source: "docs-fact" },
      identityResolver,
    ),
    normalizeTaskIdentity({ taskRef: "@missing", source: "docs-fact" }, identityResolver),
    normalizeTaskIdentity(
      { taskId: identityA, taskRef: "@docs-beta", source: "docs-fact" },
      identityResolver,
    ),
  ];
  expect(rejectedIdentities.every((result) => !result.ok)).toBe(true);
  expect(rejectedIdentities.map((result) => (result.ok ? "" : result.code))).toEqual(
    facts.lifecycle.identity.rejection_codes,
  );
  expect(facts.lifecycle.identity.durable_key).toBe("canonical task ULID");
  expect(facts.lifecycle.durability.path).toBe(`.kspec/${DISPATCH_CONTROL_FILE}`);
  expect(facts.lifecycle.durability).toMatchObject({
    startup_loads_committed_authority: true,
    pending_cleanup_is_durable: true,
    final_admission_checks_global_and_task_authority: true,
  });

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
  expect(facts.ui.status_evidence_fields).toEqual([
    "activeCount",
    "queueDepth",
    "heldCount",
    "cleanupState",
    "degradedTargets",
  ]);
  for (const field of facts.ui.status_evidence_fields) {
    expect(uiStatus).toHaveProperty(field);
  }
  const runningUiStatus = {
    ...uiStatus,
    globalAuthority: "running" as const,
    projection: "running" as const,
  };
  const stoppedUiStatus = {
    ...uiStatus,
    globalAuthority: "stopped" as const,
    projection: "stopped" as const,
    cleanupState: { status: "idle" as const, entries: [] },
  };
  const cleanupUiStatus = {
    ...stoppedUiStatus,
    cleanupState: {
      status: "pending" as const,
      entries: [
        {
          cleanupId: CLEANUP_ID,
          scope: "global" as const,
          status: "pending" as const,
          phase: "owned" as const,
        },
      ],
    },
  };
  expect(facts.ui.accessibility).toEqual({
    running_pause_label: getGlobalActionLabel(runningUiStatus, "pause"),
    running_stop_label: getGlobalActionLabel(runningUiStatus, "stop"),
    paused_resume_label: getGlobalActionLabel(uiStatus, "resume"),
    stopped_start_label: getGlobalActionLabel(stoppedUiStatus, "start"),
    cleanup_retry_label: getGlobalActionLabel(cleanupUiStatus, "stop"),
  });
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
    "no workspace deletion or reset command",
    "one-shot kspec agent run is separate from dispatch lifecycle control",
    "failed ownership verification remains represented as retryable cleanup",
  ]);
  expect(facts.lifecycle.global_actions.running).toEqual(["pause", "stop"]);
  expect(exportedCommands.some((command) => /workspace (?:delete|reset)/.test(command))).toBe(
    false,
  );
  expect(exportedCommands).toContain("kspec agent run");
  expect(exportedCommands).not.toContain("kspec agent dispatch run");
  expect(scopedCleanup.pending_cleanup.global).toMatchObject({
    status: "failed",
    error_code: "cancellation_timeout",
  });
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
    vi.restoreAllMocks();
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

  it("binds workspace path and plan/config target precedence to provisioning behavior", async () => {
    const projectDir = await createTempDir("dispatch-doc-workspace-facts-");
    try {
      await seedFactProject(projectDir);
      await writeFile(
        join(projectDir, "kspec.config.yaml"),
        "dispatch:\n  base_branch: main\n  worktree_root: relative/worktrees\n",
        "utf8",
      );
      const configured = await resolveDispatchWorkspaceConfig(projectDir);
      const planScoped = await resolveDispatchWorkspaceConfig(projectDir, {
        taskRef: "@docs-task",
        task: { title: "Docs task", slugs: ["docs-task"], plan_ref: "@docs-plan" },
      });
      expect(configured).toMatchObject({
        baseBranch: "main",
        baseBranchSource: "configured",
        worktreeRoot: join(projectDir, "relative", "worktrees"),
      });
      expect(planScoped).toMatchObject({ baseBranch: "dev", baseBranchSource: "plan" });
      expect(factsFixture.workspace.base_target_precedence).toEqual({
        plan_over_configured: true,
        configured_over_fallback: true,
      });

      const absoluteRoot = join(projectDir, "absolute-worktrees");
      await writeFile(
        join(projectDir, "kspec.config.yaml"),
        `dispatch:\n  base_branch: main\n  worktree_root: ${JSON.stringify(absoluteRoot)}\n`,
        "utf8",
      );
      expect((await resolveDispatchWorkspaceConfig(projectDir)).worktreeRoot).toBe(absoluteRoot);
      expect(factsFixture.workspace.worktree_root_resolution).toBe(
        "relative paths resolve from the project root; absolute paths remain absolute",
      );
    } finally {
      await cleanupTempDir(projectDir);
    }
  });

  it("binds bootstrap ordering, role filtering, and mutation safety to executed steps", async () => {
    const projectDir = await createTempDir("dispatch-doc-bootstrap-facts-");
    try {
      await seedFactProject(projectDir);
      await writeFile(
        join(projectDir, "kspec.config.yaml"),
        [
          "dispatch:",
          "  base_branch: main",
          "  worktree_root: .worktrees",
          "  bootstrap:",
          "    steps:",
          "      - run: mkdir -p .facts && printf 'project\\n' >> .facts/order",
          "        roles: [worker]",
        ].join("\n"),
        "utf8",
      );
      const taskId = testUlids("TASK", 1)[0]!;
      const workspace = await provisionDispatchWorkspace({
        projectDir,
        taskRef: `@${taskId}`,
        task: { title: "Bootstrap facts", slugs: ["bootstrap-facts"] },
      });
      const result = await ensureWorkspaceBootstrap({
        projectDir,
        workspaceDir: workspace.cwd,
        metadataPath: workspace.metadataPath,
        metadata: workspace.metadata,
        role: "worker",
        agent: factAgent("mkdir -p .facts && printf 'agent\\n' >> .facts/order"),
        env: {},
      });
      expect(await readTestOutput(join(workspace.cwd, ".facts", "order"))).toBe("project\nagent\n");
      expect(result.ranSteps).toBe(true);
      expect(factsFixture.workspace.bootstrap.project_steps_before_agent_steps).toBe(true);

      await writeFile(
        join(projectDir, "kspec.config.yaml"),
        [
          "dispatch:",
          "  base_branch: main",
          "  worktree_root: .worktrees",
          "  bootstrap:",
          "    steps:",
          "      - run: printf changed >> README.md",
        ].join("\n"),
        "utf8",
      );
      const unsafeTaskId = testUlids("TASK", 2)[1]!;
      const unsafeWorkspace = await provisionDispatchWorkspace({
        projectDir,
        taskRef: `@${unsafeTaskId}`,
        task: { title: "Unsafe bootstrap", slugs: ["unsafe-bootstrap"] },
      });
      await expect(
        ensureWorkspaceBootstrap({
          projectDir,
          workspaceDir: unsafeWorkspace.cwd,
          metadataPath: unsafeWorkspace.metadataPath,
          metadata: unsafeWorkspace.metadata,
          role: "worker",
          agent: factAgent(),
          env: {},
        }),
      ).rejects.toBeInstanceOf(DispatchBootstrapError);
      expect(factsFixture.workspace.bootstrap.tracked_mutation_requires_opt_in).toBe(true);

      const reviewerTaskId = testUlids("TASK", 3)[2]!;
      const reviewerWorkspace = await provisionDispatchWorkspace({
        projectDir,
        taskRef: `@${reviewerTaskId}`,
        role: "reviewer",
        task: { title: "Reviewer bootstrap", slugs: ["reviewer-bootstrap"] },
      });
      await expect(
        ensureWorkspaceBootstrap({
          projectDir,
          workspaceDir: reviewerWorkspace.cwd,
          metadataPath: reviewerWorkspace.metadataPath,
          metadata: reviewerWorkspace.metadata,
          role: "reviewer",
          agent: factAgent(),
          env: {},
        }),
      ).rejects.toBeInstanceOf(DispatchBootstrapError);
      expect(factsFixture.workspace.bootstrap.reviewer_reruns_only_safe_steps).toBe(true);
    } finally {
      await cleanupTempDir(projectDir);
    }
  });

  it("retries durable startup cleanup before admitting queued work", async () => {
    const snapshot = createMissingDispatchControl();
    snapshot.global.authority = "running";
    snapshot.pending_cleanup.global = {
      cleanup_id: CLEANUP_ID,
      status: "pending",
      phase: "signals_sent",
      targets: [
        {
          invocation_id: "startup-cleanup-invocation",
          session_id: "startup-cleanup-session",
          task_id: null,
          agent_id: "fact-worker",
          adapter: "mock-acp",
          owner_instance_id: "startup-owner",
          pid: null,
          pgid: null,
          process_start_ticks: null,
          process_identity_platform: "unverifiable",
          captured_at: NOW,
          group_members: [],
          session_metadata_path: ".kspec-sessions/startup-cleanup-session/session.yaml",
        },
      ],
    };
    const harness = await createAdmissionHarness(snapshot);
    try {
      await harness.engine.start();
      expect(harness.store.getPublication().snapshot.pending_cleanup.global).toBeUndefined();
      await harness.engine.handleStateChange({
        taskId: harness.taskId,
        taskRef: `@${harness.taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: {
          _ulid: harness.taskId,
          type: "task",
          title: "Admission fact task",
          slugs: ["admission-fact-task"],
          status: "pending",
          priority: 1,
          automation: "eligible",
          depends_on: [],
          blocked_by: [],
          tags: [],
          notes: [],
          context: [],
          vcs_refs: [],
          todos: [],
          created_at: NOW,
        } as never,
      });
      await vi.waitFor(() => expect(harness.artifacts.length).toBeGreaterThan(0));
      expect(new Set(harness.artifacts)).toEqual(new Set([harness.taskId]));
      expect(harness.store.operations[0]).toBe("load committed control");
      expect(harness.store.operations.some((operation) => operation.includes("cleanup"))).toBe(
        true,
      );
      expect(factsFixture.lifecycle.durability).toMatchObject({
        startup_loads_committed_authority: true,
        pending_cleanup_is_durable: true,
      });
    } finally {
      harness.gate.release();
      await harness.engine.stop().catch(() => undefined);
      await cleanupTempDir(harness.projectDir);
    }
  });

  it.each(["global", "task"] as const)(
    "rechecks %s authority at the final process/session admission boundary",
    async (scope) => {
      const snapshot = createMissingDispatchControl();
      snapshot.global.authority = "running";
      const harness = await createAdmissionHarness(snapshot);
      harness.enableGate();
      try {
        const starting = harness.engine.start();
        await harness.gate.entered;
        if (scope === "global") {
          await harness.engine.applyGlobalLifecycleAction("pause");
        } else {
          await harness.engine.applyTaskLifecycleAction("pause", { taskId: harness.taskId });
        }
        expect(harness.artifacts).toEqual([]);
        expect(
          factsFixture.lifecycle.durability.final_admission_checks_global_and_task_authority,
        ).toBe(true);
        harness.gate.release();
        await starting;
        await vi.waitFor(() => expect(harness.engine.getLifecycleStatus().activeCount).toBe(0));
        expect(harness.artifacts).toEqual([]);
      } finally {
        harness.gate.release();
        await harness.engine.stop().catch(() => undefined);
        await cleanupTempDir(harness.projectDir);
      }
    },
  );

  // AC: @auto-cli-docs ac-5
  it("discovers a newly registered subcommand in observable parent help", async () => {
    const parent = program.command("documentation-fixture").description("Documentation fixture");
    parent.command("new-child").description("Newly registered child");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await program.parseAsync(["help", "documentation-fixture"], { from: "user" });
      const stdout = log.mock.calls.map(([line]) => String(line)).join("\n");
      expect(stdout).toContain("Commands:");
      expect(stdout).toContain("new-child");
      expect(stdout).toContain("Newly registered child");
    } finally {
      program.commands.splice(program.commands.indexOf(parent), 1);
      log.mockRestore();
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
    missingUi.ui.status_evidence_fields = [];
    expect(() => validateFacts(missingUi)).toThrow();

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
    const snapshot = cleanupSnapshot();
    const store: DispatchLifecycleAuthorityStore = {
      setPublicationListener: () => undefined,
      loadCommitted: async () => {
        calls.push("load");
        return { snapshot, token: { revision: 0, commit_oid: "test" } };
      },
      getPublication: () => ({ snapshot, token: { revision: 0, commit_oid: "test" } }),
      getDegradedReason: () => null,
      mutate: async () => ({ snapshot, token: { revision: 0, commit_oid: "test" } }),
    };
    expect((await loadDispatchBootstrapAuthority(store)).snapshot.global.authority).toBe(
      factsFixture.lifecycle.missing_state_default,
    );
    expect(calls).toEqual(["load"]);
    expect(factsFixture.lifecycle.durability.startup_loads_committed_authority).toBe(true);
    expect(projectDispatchCleanupState((await store.loadCommitted()).snapshot).status).toBe(
      "failed",
    );
    expect(factsFixture.lifecycle.durability.pending_cleanup_is_durable).toBe(true);
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
      [
        "workspace",
        (facts) => (facts.workspace.bootstrap.project_steps_before_agent_steps = false),
      ],
      ["command tree", (facts) => facts.command_tree.help_modes.pop()],
      ["identity", (facts) => facts.lifecycle.identity.accepted_aliases.pop()],
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
