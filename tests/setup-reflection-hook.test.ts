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
import { cleanupTempDir, createTempDir, initGitRepo, kspec } from "./helpers/cli.js";

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
async function readHooks(
  dir: string,
): Promise<
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
  const raw = YAML.parse(await fs.readFile(metaPath, "utf-8")) as {
    hooks?: Array<Record<string, unknown>>;
  };
  return (raw.hooks || []) as ReturnType<typeof readHooks> extends Promise<infer T> ? T : never;
}

/**
 * Read the scaffold state file.
 */
async function readScaffoldState(
  dir: string,
): Promise<{ reflectionHookScaffolded?: boolean }> {
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
  it("creates a reflection hook that fires on session.idle with no agent filter", async () => {
    const result = await kspec("setup --no-hooks --skip-skills", tempDir);
    expect(result.exitCode).toBe(0);

    const hooks = await readHooks(tempDir);
    const reflectHook = hooks.find((h) => h.name === "default-session-reflect");

    expect(reflectHook).toBeDefined();
    expect(reflectHook!.on).toBe("session.idle");
    expect(reflectHook!.filter).toBeUndefined();
    expect(reflectHook!.enabled).toBe(true);
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
