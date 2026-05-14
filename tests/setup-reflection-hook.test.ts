/**
 * Tests for default session reflection hook scaffolding during setup.
 *
 * Verifies that kspec setup creates a default reflection hook that fires
 * on session.idle for all agents and prompts the reflect skill, with
 * proper idempotency and user-removal detection.
 *
 * Spec: @default-session-reflection-hook
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as YAML from "yaml";
import { matchesFilter } from "../src/schema/hooks.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  readTestOutput,
} from "./helpers/cli.js";

/**
 * Create a minimal kspec project in a temp dir (traditional layout).
 */
async function setupMinimalProject(dir: string): Promise<void> {
  initGitRepo(dir);
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1", title: "Test Project" }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "kynetic.meta.yaml"),
    YAML.stringify({
      kynetic_meta: "1.0",
      agents: [],
      workflows: [],
      conventions: [],
      observations: [],
      skills: [],
      hooks: [],
      includes: [],
    }),
    "utf-8",
  );
}

/**
 * Read hooks from the meta manifest.
 */
async function readHooks(dir: string): Promise<
  Array<{
    _ulid: string;
    name: string;
    on: string;
    filter?: Record<string, unknown>;
    action: { type: string; prompt?: string; skills?: string[] };
    enabled: boolean;
  }>
> {
  const metaPath = path.join(dir, "kynetic.meta.yaml");
  const raw = YAML.parse(await readTestOutput(metaPath, "utf-8")) as {
    hooks?: Array<Record<string, unknown>>;
  };
  return (raw.hooks || []) as ReturnType<typeof readHooks> extends Promise<infer T> ? T : never;
}

/**
 * Read the scaffold state file.
 */
async function readScaffoldState(dir: string): Promise<{ reflectionHookScaffolded?: boolean }> {
  try {
    const content = await fs.readFile(
      path.join(dir, ".kspec", ".setup-scaffold-state.json"),
      "utf-8",
    );
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// AC: @default-session-reflection-hook ac-reflection-hook-present
describe("default reflection hook creation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @default-session-reflection-hook ac-reflection-hook-present
  // AC: @default-session-reflection-hook ac-fires-once-per-invocation
  it("creates a reflection hook that fires on session.idle with a first-turn filter", async () => {
    const result = await kspec("setup --no-hooks --skip-skills", tempDir);
    expect(result.exitCode).toBe(0);

    const hooks = await readHooks(tempDir);
    const reflectHook = hooks.find((h) => h.name === "default-session-reflect");

    expect(reflectHook).toBeDefined();
    expect(reflectHook!.on).toBe("session.idle");
    expect(reflectHook!.enabled).toBe(true);
    // Hook is NOT scoped to a specific agent (no agent_id filter), but it
    // IS restricted to the first idle event of an invocation via turn_count.
    expect(reflectHook!.filter).toBeDefined();
    expect(reflectHook!.filter).toEqual({ turn_count: 1 });
    // turn_count must be numeric so strict-equality filter matching against
    // the z.number() payload field works. A string "1" would silently
    // disable the filter.
    expect(typeof reflectHook!.filter!.turn_count).toBe("number");
  });

  // AC: @default-session-reflection-hook ac-reflection-hook-present
  it("reflection hook uses session_prompt action with reflect skill", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const hooks = await readHooks(tempDir);
    const reflectHook = hooks.find((h) => h.name === "default-session-reflect");

    expect(reflectHook).toBeDefined();
    expect(reflectHook!.action.type).toBe("session_prompt");
    expect(reflectHook!.action.skills).toContain("reflect");
  });

  // AC: @default-session-reflection-hook ac-reflection-hook-present
  it("records scaffold state after creating the hook", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const state = await readScaffoldState(tempDir);
    expect(state.reflectionHookScaffolded).toBe(true);
  });

  // AC: @default-session-reflection-hook ac-fires-once-per-invocation
  // Semantic check: drive the hook filter through matchesFilter() with
  // synthetic session.idle payloads and verify it matches the first turn
  // and rejects a later turn. A shape-only assertion (filter.turn_count===1)
  // does not exercise matchesFilter, so it would not catch a type drift
  // (e.g. numeric → string) that silently disables the filter at runtime.
  it("scaffolded hook matches the first session.idle event but not later turns", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const hooks = await readHooks(tempDir);
    const reflectHook = hooks.find((h) => h.name === "default-session-reflect");
    expect(reflectHook).toBeDefined();

    const envelope = {
      event_id: "01JEVENT000000000000000000",
      event_type: "session.idle",
      emitted_at: "2026-04-15T00:00:00.000Z",
      source_type: "invocation_lifecycle",
      source_id: "01JSESS000000000000000000",
    };
    const firstTurnPayload = {
      session_id: "01JSESS000000000000000000",
      agent_id: "task-worker",
      task_ref: "@task-example",
      turn_count: 1,
      stop_reason: "end_turn",
      turn_duration_ms: 1000,
    };
    const secondTurnPayload = { ...firstTurnPayload, turn_count: 2 };
    const laterTurnPayload = { ...firstTurnPayload, turn_count: 7 };

    expect(matchesFilter(reflectHook!.filter, envelope, firstTurnPayload)).toBe(true);
    expect(matchesFilter(reflectHook!.filter, envelope, secondTurnPayload)).toBe(false);
    expect(matchesFilter(reflectHook!.filter, envelope, laterTurnPayload)).toBe(false);
  });

  // AC: @default-session-reflection-hook ac-fires-once-per-invocation
  // Round-trip check: write the scaffolded meta file and read it back through
  // the YAML parser, then verify the filter's turn_count survives as a
  // number. A string or accidental YAML quoting would silently change
  // matchesFilter semantics, so type preservation through disk persistence
  // is part of the acceptance criterion.
  it("preserves numeric filter value through YAML round-trip", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const rawYaml = await fs.readFile(metaPath, "utf-8");
    const parsed = YAML.parse(rawYaml) as {
      hooks?: Array<{
        name: string;
        filter?: Record<string, unknown>;
      }>;
    };
    const reflectHook = (parsed.hooks || []).find((h) => h.name === "default-session-reflect");

    expect(reflectHook).toBeDefined();
    expect(reflectHook!.filter).toBeDefined();
    const turnCount = reflectHook!.filter!.turn_count;
    expect(typeof turnCount).toBe("number");
    expect(turnCount).toBe(1);
    // Belt-and-suspenders: explicitly assert it is NOT the string "1"
    // since YAML.parse("'1'") returns a string that looks equal in stringification.
    expect(turnCount).not.toBe("1");
  });
});

// AC: @default-session-reflection-hook ac-hook-idempotent
describe("reflection hook idempotency", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @default-session-reflection-hook ac-hook-idempotent
  it("does not duplicate the hook when setup is run twice", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const hooks = await readHooks(tempDir);
    const reflectHooks = hooks.filter((h) => h.name === "default-session-reflect");

    expect(reflectHooks).toHaveLength(1);
  });

  // AC: @default-session-reflection-hook ac-hook-idempotent
  it("preserves the existing hook on re-run", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const hooksBefore = await readHooks(tempDir);
    const hookBefore = hooksBefore.find((h) => h.name === "default-session-reflect");
    const ulidBefore = hookBefore!._ulid;

    await kspec("setup --no-hooks --skip-skills", tempDir);

    const hooksAfter = await readHooks(tempDir);
    const hookAfter = hooksAfter.find((h) => h.name === "default-session-reflect");

    expect(hookAfter!._ulid).toBe(ulidBefore);
  });
});

// AC: @default-session-reflection-hook ac-hook-removable
describe("reflection hook user-removal detection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @default-session-reflection-hook ac-hook-removable
  it("does not recreate hook after user removes it (without force)", async () => {
    // First setup creates the hook
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const hooksBefore = await readHooks(tempDir);
    expect(hooksBefore.some((h) => h.name === "default-session-reflect")).toBe(true);

    // Simulate user removing the hook via CLI
    const reflectHook = hooksBefore.find((h) => h.name === "default-session-reflect");
    await kspec(`hook remove ${reflectHook!._ulid} --confirm`, tempDir);

    // Verify hook is removed
    const hooksAfterRemoval = await readHooks(tempDir);
    expect(hooksAfterRemoval.some((h) => h.name === "default-session-reflect")).toBe(false);

    // Re-run setup without force
    await kspec("setup --no-hooks --skip-skills", tempDir);

    // Hook should NOT be recreated
    const hooksAfterRerun = await readHooks(tempDir);
    expect(hooksAfterRerun.some((h) => h.name === "default-session-reflect")).toBe(false);
  });

  // AC: @default-session-reflection-hook ac-hook-removable
  it("recreates hook when force flag is used after user removal", async () => {
    // First setup creates the hook
    await kspec("setup --no-hooks --skip-skills", tempDir);

    // Remove the hook
    const hooks = await readHooks(tempDir);
    const reflectHook = hooks.find((h) => h.name === "default-session-reflect");
    await kspec(`hook remove ${reflectHook!._ulid} --confirm`, tempDir);

    // Re-run setup WITH force
    await kspec("setup --no-hooks --skip-skills --force", tempDir);

    // Hook SHOULD be recreated
    const hooksAfterForce = await readHooks(tempDir);
    expect(hooksAfterForce.some((h) => h.name === "default-session-reflect")).toBe(true);
  });
});

// ─── Default Agent Reflection Promptability ──────────────────────────────────

/**
 * Read agent definitions from the meta manifest.
 */
async function readAgents(dir: string): Promise<
  Array<{
    _ulid: string;
    id: string;
    session?: { mode?: string; idle_grace_period_ms?: number };
    dispatch?: Array<{ on: string }>;
  }>
> {
  const metaPath = path.join(dir, "kynetic.meta.yaml");
  const raw = YAML.parse(await readTestOutput(metaPath, "utf-8")) as {
    agents?: Array<Record<string, unknown>>;
  };
  return (raw.agents || []) as ReturnType<typeof readAgents> extends Promise<infer T> ? T : never;
}

// AC: @default-project-agents-and-conventions ac-default-agents-reflection-promptable
describe("default dispatch agent reflection promptability", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @default-project-agents-and-conventions ac-default-agents-reflection-promptable
  it("scaffolded dispatch agents have session config with auto_close mode and idle_grace_period_ms", async () => {
    const result = await kspec("setup --no-hooks --skip-skills", tempDir);
    expect(result.exitCode).toBe(0);

    const agents = await readAgents(tempDir);

    // Dispatch-capable agents (those with dispatch rules) must have session config
    const dispatchAgents = agents.filter((a) => a.dispatch && a.dispatch.length > 0);
    expect(dispatchAgents.length).toBeGreaterThan(0);

    for (const agent of dispatchAgents) {
      expect(agent.session).toBeDefined();
      expect(agent.session!.mode).toBe("auto_close");
      expect(agent.session!.idle_grace_period_ms).toBe(5000);
    }
  });

  // AC: @default-project-agents-and-conventions ac-default-agents-reflection-promptable
  it("non-dispatch agents do not have session config", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const agents = await readAgents(tempDir);

    // Non-dispatch agents (no dispatch rules) should NOT have session config
    const nonDispatchAgents = agents.filter((a) => !a.dispatch || a.dispatch.length === 0);
    expect(nonDispatchAgents.length).toBeGreaterThan(0);

    for (const agent of nonDispatchAgents) {
      expect(agent.session).toBeUndefined();
    }
  });

  // AC: @default-project-agents-and-conventions ac-default-agents-reflection-promptable
  it("idle_grace_period_ms matches DEFAULT_IDLE_GRACE_MS ensuring single source of truth", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const agents = await readAgents(tempDir);
    const taskWorker = agents.find((a) => a.id === "task-worker");

    expect(taskWorker).toBeDefined();
    expect(taskWorker!.session).toBeDefined();
    // The value should match the runtime default so there is a single source of truth
    expect(taskWorker!.session!.idle_grace_period_ms).toBe(5000);
  });
});
