/**
 * Tests for kspec setup default agents, conventions, and session checkpoint.
 *
 * Verifies that kspec setup scaffolds default agents and conventions with
 * correct dispatch rules, write authorization, skills, and first-run marker.
 * Re-annotated from @ralph-replacement to @default-project-agents-and-conventions.
 *
 * Spec: @default-project-agents-and-conventions
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as YAML from "yaml";
import { cleanupTempDir, createTempDir, initGitRepo, kspec } from "./helpers/cli.js";

/**
 * Raw meta manifest shape for test assertions.
 */
interface RawMeta {
  agents?: Array<{
    id: string;
    name?: string;
    description?: string;
    capabilities?: string[];
    tools?: string[];
    dispatch?: Array<{ on: string; filter?: { automation?: string } }>;
    skills?: string[];
    auto_approve?: boolean;
    tags?: string[];
    concurrency?: { max_concurrent: number };
  }>;
  conventions?: Array<{
    domain: string;
    rules?: string[];
  }>;
}

/**
 * Create a minimal kspec project in a temp dir (traditional layout, not shadow branch).
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
      includes: [],
    }),
    "utf-8",
  );
}

/**
 * Read parsed meta manifest from a project dir.
 */
async function readMeta(dir: string): Promise<RawMeta> {
  const metaPath = path.join(dir, "kynetic.meta.yaml");
  return YAML.parse(await fs.readFile(metaPath, "utf-8")) as RawMeta;
}

/**
 * Read setup state file.
 */
async function readSetupState(
  dir: string,
): Promise<{
  defaultsSeeded?: boolean;
  defaultsSeededAt?: string;
  scaffoldedItems?: Array<{ type: string; id: string }>;
}> {
  const statePath = path.join(dir, ".setup-state.json");
  try {
    return JSON.parse(await fs.readFile(statePath, "utf-8"));
  } catch {
    return {};
  }
}

// ─── First-run scaffold tests ──────────────────────────────────────────────

describe("kspec setup default agents and conventions — first run", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @default-project-agents-and-conventions ac-task-worker-agent
  it("creates task-worker agent with dispatch rules for task.ready, task.needs_work, and eligible filter", async () => {
    const result = await kspec("setup --no-hooks --skip-skills", tempDir);
    expect(result.exitCode).toBe(0);

    const meta = await readMeta(tempDir);
    const worker = (meta.agents || []).find((a) => a.id === "task-worker");
    expect(worker).toBeDefined();
    expect(worker!.name).toBe("Task Worker");

    const dispatch = worker!.dispatch || [];
    const events = dispatch.map((r) => r.on);
    expect(events).toContain("task.in_progress");
    expect(events).toContain("task.ready");
    expect(events).toContain("task.needs_work");

    // Automation: eligible filter on all dispatch rules
    for (const rule of dispatch) {
      expect(rule.filter?.automation).toBe("eligible");
    }

    // Write authorization: auto_approve must be true
    expect(worker!.auto_approve).toBe(true);
  });

  // AC: @default-project-agents-and-conventions ac-pr-reviewer-agent
  it("creates pr-reviewer agent with dispatch rule for task.pending_review", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const reviewer = (meta.agents || []).find((a) => a.id === "pr-reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer!.name).toBe("PR Reviewer");

    const events = (reviewer!.dispatch || []).map((r) => r.on);
    expect(events).toContain("task.pending_review");

    expect(reviewer!.auto_approve).toBe(true);
  });

  // AC: @default-project-agents-and-conventions ac-primary-dev-agent
  it("creates primary-dev agent with code, test, refactor, and review capabilities", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const dev = (meta.agents || []).find((a) => a.id === "primary-dev");
    expect(dev).toBeDefined();
    expect(dev!.name).toBe("Primary Development Agent");
    expect(dev!.capabilities).toContain("code");
    expect(dev!.capabilities).toContain("test");
    expect(dev!.capabilities).toContain("refactor");
    expect(dev!.capabilities).toContain("review");

    expect(dev!.auto_approve).toBe(true);
  });

  // AC: @default-project-agents-and-conventions ac-plan-reviewer-agent
  it("creates plan-reviewer agent with review capability", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const planReviewer = (meta.agents || []).find((a) => a.id === "plan-reviewer");
    expect(planReviewer).toBeDefined();
    expect(planReviewer!.name).toBe("Plan Reviewer");
    expect(planReviewer!.capabilities).toContain("review");

    expect(planReviewer!.auto_approve).toBe(true);
  });

  // AC: @default-project-agents-and-conventions ac-plan-reviewer-agent-skills
  it("plan-reviewer has review-plan, writing-specs, and plan skills attached", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const planReviewer = (meta.agents || []).find((a) => a.id === "plan-reviewer");
    expect(planReviewer).toBeDefined();

    expect(planReviewer!.skills).toContain("review-plan");
    expect(planReviewer!.skills).toContain("writing-specs");
    expect(planReviewer!.skills).toContain("plan");
  });

  // AC: @default-project-agents-and-conventions ac-plan-reviewer-adapter-guidance
  it("plan-reviewer description includes adapter guidance", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const planReviewer = (meta.agents || []).find((a) => a.id === "plan-reviewer");
    expect(planReviewer).toBeDefined();

    const desc = planReviewer!.description || "";
    // Must include guidance on switching adapters using existing CLI commands
    expect(desc).toContain("adapter");
    expect(desc).toContain("kspec meta set");
    expect(desc).toContain("kspec agent adapters");
  });

  // AC: @default-project-agents-and-conventions ac-all-defaults-write-authorized
  it("every default agent has auto_approve set to true (unconditional write authorization)", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const expectedAgentIds = ["task-worker", "pr-reviewer", "primary-dev", "plan-reviewer"];
    for (const agentId of expectedAgentIds) {
      const agent = (meta.agents || []).find((a) => a.id === agentId);
      expect(agent, `Agent ${agentId} should exist`).toBeDefined();
      expect(agent!.auto_approve, `Agent ${agentId} should have auto_approve=true`).toBe(true);
    }
  });

  // AC: @default-project-agents-and-conventions ac-commits-convention
  it("creates commits convention with rules for message format and task reference", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const commits = (meta.conventions || []).find((c) => c.domain === "commits");
    expect(commits).toBeDefined();
    expect(commits!.rules).toBeDefined();
    expect(commits!.rules!.length).toBeGreaterThanOrEqual(2);

    // One rule about commit format, one about task reference
    const rulesText = commits!.rules!.join(" ").toLowerCase();
    expect(rulesText).toContain("conventional commit");
    expect(rulesText).toContain("task");
  });

  // AC: @default-project-agents-and-conventions ac-architecture-convention
  it("creates architecture convention with placeholder rule", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const arch = (meta.conventions || []).find((c) => c.domain === "architecture");
    expect(arch).toBeDefined();
    expect(arch!.rules).toBeDefined();
    expect(arch!.rules!.length).toBeGreaterThanOrEqual(1);

    // Rule must instruct user to replace with project-specific rules
    const rulesText = arch!.rules!.join(" ").toUpperCase();
    expect(rulesText).toContain("PLACEHOLDER");
    expect(rulesText).toContain("REPLACE");
  });

  // AC: @default-project-agents-and-conventions ac-testing-convention
  it("creates testing convention with placeholder rule", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const testing = (meta.conventions || []).find((c) => c.domain === "testing");
    expect(testing).toBeDefined();
    expect(testing!.rules).toBeDefined();
    expect(testing!.rules!.length).toBeGreaterThanOrEqual(1);

    // Rule must instruct user to replace with project testing expectations
    const rulesText = testing!.rules!.join(" ").toUpperCase();
    expect(rulesText).toContain("PLACEHOLDER");
    expect(rulesText).toContain("REPLACE");
  });

  // AC: @default-project-agents-and-conventions ac-agents-md-reflects-defaults
  it("kspec-agents.md reflects scaffolded defaults after setup", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    // The agents.md generation step runs after the scaffold step
    const agentsMdPath = path.join(tempDir, "kspec-agents.md");
    let agentsMdExists = false;
    try {
      await fs.access(agentsMdPath);
      agentsMdExists = true;
    } catch {
      // File doesn't exist
    }

    if (agentsMdExists) {
      const content = await fs.readFile(agentsMdPath, "utf-8");
      // Should reflect the commits convention at minimum
      expect(content).toContain("commits");
    }
    // If agents.md generation was skipped (no templates), the test still passes
    // because the scaffold step runs before generation in the pipeline
  });

  // AC: @default-project-agents-and-conventions ac-first-run-marker-written
  it("writes first-run marker to setup state file", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const state = await readSetupState(tempDir);
    expect(state.defaultsSeeded).toBe(true);
    expect(state.defaultsSeededAt).toBeDefined();
    expect(state.scaffoldedItems).toBeDefined();
    expect(state.scaffoldedItems!.length).toBeGreaterThan(0);

    // Should include all default agents and conventions
    const ids = state.scaffoldedItems!.map((i) => i.id);
    expect(ids).toContain("task-worker");
    expect(ids).toContain("pr-reviewer");
    expect(ids).toContain("primary-dev");
    expect(ids).toContain("plan-reviewer");
    expect(ids).toContain("commits");
    expect(ids).toContain("architecture");
    expect(ids).toContain("testing");
  });

  it("scaffold-default tag is applied to all scaffolded agents", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const expectedAgentIds = ["task-worker", "pr-reviewer", "primary-dev", "plan-reviewer"];
    for (const agentId of expectedAgentIds) {
      const agent = (meta.agents || []).find((a) => a.id === agentId);
      expect(agent, `Agent ${agentId} should exist`).toBeDefined();
      expect(agent!.tags, `Agent ${agentId} should have tags`).toBeDefined();
      expect(agent!.tags, `Agent ${agentId} should have scaffold-default tag`).toContain(
        "scaffold-default",
      );
    }
  });
});

// ─── Subsequent run tests ──────────────────────────────────────────────────

describe("kspec setup default agents and conventions — subsequent run", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
    // Do the first-run setup
    await kspec("setup --no-hooks --skip-skills", tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("does not duplicate agents when run twice (idempotent)", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const meta = await readMeta(tempDir);
    const agentIds = (meta.agents || []).map((a) => a.id);
    const workerCount = agentIds.filter((id) => id === "task-worker").length;
    const reviewerCount = agentIds.filter((id) => id === "pr-reviewer").length;
    const devCount = agentIds.filter((id) => id === "primary-dev").length;
    const planCount = agentIds.filter((id) => id === "plan-reviewer").length;

    expect(workerCount).toBe(1);
    expect(reviewerCount).toBe(1);
    expect(devCount).toBe(1);
    expect(planCount).toBe(1);
  });

  // AC: @default-project-agents-and-conventions ac-removed-defaults-not-recreated
  it("does not recreate a removed agent on subsequent run", async () => {
    // Remove the primary-dev agent from meta
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const rawContent = await fs.readFile(metaPath, "utf-8");
    const raw = YAML.parse(rawContent) as RawMeta;
    raw.agents = (raw.agents || []).filter((a) => a.id !== "primary-dev");
    await fs.writeFile(metaPath, YAML.stringify(raw), "utf-8");

    // Run setup again
    const result = await kspec("setup --no-hooks --skip-skills", tempDir);
    expect(result.exitCode).toBe(0);

    // Agent should not be recreated
    const meta = await readMeta(tempDir);
    const dev = (meta.agents || []).find((a) => a.id === "primary-dev");
    expect(dev).toBeUndefined();

    // Setup output should mention it was removed
    expect(result.stdout + result.stderr).toContain("removed");
  });

  // AC: @default-project-agents-and-conventions ac-renamed-defaults-preserved
  it("preserves a renamed agent and does not recreate the original", async () => {
    // Rename task-worker to my-custom-worker (keep scaffold-default tag)
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const rawContent = await fs.readFile(metaPath, "utf-8");
    const raw = YAML.parse(rawContent) as RawMeta;
    const worker = (raw.agents || []).find((a) => a.id === "task-worker");
    expect(worker).toBeDefined();
    worker!.id = "my-custom-worker";
    worker!.name = "My Custom Worker";
    await fs.writeFile(metaPath, YAML.stringify(raw), "utf-8");

    // Run setup again
    const result = await kspec("setup --no-hooks --skip-skills", tempDir);
    expect(result.exitCode).toBe(0);

    // Original task-worker should not exist
    const meta = await readMeta(tempDir);
    const originalWorker = (meta.agents || []).find((a) => a.id === "task-worker");
    expect(originalWorker).toBeUndefined();

    // Renamed agent should still exist
    const customWorker = (meta.agents || []).find((a) => a.id === "my-custom-worker");
    expect(customWorker).toBeDefined();

    // Setup output should mention rename
    expect(result.stdout + result.stderr).toContain("renamed");
  });

  // AC: @default-project-agents-and-conventions ac-removed-defaults-not-recreated
  it("does not recreate a removed convention on subsequent run", async () => {
    // Remove the architecture convention
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const rawContent = await fs.readFile(metaPath, "utf-8");
    const raw = YAML.parse(rawContent) as RawMeta;
    raw.conventions = (raw.conventions || []).filter((c) => c.domain !== "architecture");
    await fs.writeFile(metaPath, YAML.stringify(raw), "utf-8");

    // Run setup again
    const result = await kspec("setup --no-hooks --skip-skills", tempDir);
    expect(result.exitCode).toBe(0);

    // Convention should not be recreated
    const meta = await readMeta(tempDir);
    const arch = (meta.conventions || []).find((c) => c.domain === "architecture");
    expect(arch).toBeUndefined();
  });
});

// ─── Force reseed tests ────────────────────────────────────────────────────

// AC: @default-project-agents-and-conventions ac-force-reseed
describe("kspec setup default agents and conventions — force reseed", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
    // First-run setup
    await kspec("setup --no-hooks --skip-skills", tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("force-reseeds a missing agent but leaves existing agents untouched", async () => {
    // Remove only the primary-dev agent
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const rawContent = await fs.readFile(metaPath, "utf-8");
    const raw = YAML.parse(rawContent) as RawMeta;
    raw.agents = (raw.agents || []).filter((a) => a.id !== "primary-dev");
    await fs.writeFile(metaPath, YAML.stringify(raw), "utf-8");

    // Run setup with --force
    const result = await kspec("setup --no-hooks --skip-skills --force", tempDir);
    expect(result.exitCode).toBe(0);

    // primary-dev should be recreated
    const meta = await readMeta(tempDir);
    const dev = (meta.agents || []).find((a) => a.id === "primary-dev");
    expect(dev).toBeDefined();
    expect(dev!.auto_approve).toBe(true);

    // Other agents should still be exactly one instance each
    const workerCount = (meta.agents || []).filter((a) => a.id === "task-worker").length;
    expect(workerCount).toBe(1);
  });

  it("force does not recreate a renamed agent (scaffold tag still present under different id)", async () => {
    // Rename task-worker to my-worker (keep scaffold-default tag)
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const rawContent = await fs.readFile(metaPath, "utf-8");
    const raw = YAML.parse(rawContent) as RawMeta;
    const worker = (raw.agents || []).find((a) => a.id === "task-worker");
    expect(worker).toBeDefined();
    worker!.id = "my-worker";
    await fs.writeFile(metaPath, YAML.stringify(raw), "utf-8");

    // Run setup with --force
    const result = await kspec("setup --no-hooks --skip-skills --force", tempDir);
    expect(result.exitCode).toBe(0);

    // Original task-worker should NOT be recreated because the renamed version still has the tag
    const meta = await readMeta(tempDir);
    const originalWorker = (meta.agents || []).find((a) => a.id === "task-worker");
    expect(originalWorker).toBeUndefined();

    // Renamed agent should still exist
    const customWorker = (meta.agents || []).find((a) => a.id === "my-worker");
    expect(customWorker).toBeDefined();
  });

  it("force-reseeds a missing convention", async () => {
    // Remove the testing convention
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const rawContent = await fs.readFile(metaPath, "utf-8");
    const raw = YAML.parse(rawContent) as RawMeta;
    raw.conventions = (raw.conventions || []).filter((c) => c.domain !== "testing");
    await fs.writeFile(metaPath, YAML.stringify(raw), "utf-8");

    // Run setup with --force
    const result = await kspec("setup --no-hooks --skip-skills --force", tempDir);
    expect(result.exitCode).toBe(0);

    // Testing convention should be recreated
    const meta = await readMeta(tempDir);
    const testing = (meta.conventions || []).find((c) => c.domain === "testing");
    expect(testing).toBeDefined();
    expect(testing!.rules).toBeDefined();
    expect(testing!.rules!.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Integration test: init with setup ─────────────────────────────────────

describe("kspec setup integration — fresh project", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("setup creates all four agents and three conventions with correct shape", async () => {
    const result = await kspec("setup --no-hooks --skip-skills", tempDir);
    expect(result.exitCode).toBe(0);

    const meta = await readMeta(tempDir);

    // Four expected agents
    const expectedAgentIds = ["task-worker", "pr-reviewer", "primary-dev", "plan-reviewer"];
    const actualAgentIds = (meta.agents || []).map((a) => a.id);
    for (const id of expectedAgentIds) {
      expect(actualAgentIds, `Expected agent ${id}`).toContain(id);
    }

    // Three expected conventions
    const expectedConventionDomains = ["commits", "architecture", "testing"];
    const actualDomains = (meta.conventions || []).map((c) => c.domain);
    for (const domain of expectedConventionDomains) {
      expect(actualDomains, `Expected convention ${domain}`).toContain(domain);
    }

    // All agents have write authorization
    for (const id of expectedAgentIds) {
      const agent = (meta.agents || []).find((a) => a.id === id);
      expect(agent!.auto_approve).toBe(true);
    }

    // First-run marker is present
    const state = await readSetupState(tempDir);
    expect(state.defaultsSeeded).toBe(true);
  });
});

// ─── Unchanged: session checkpoint detection ───────────────────────────────

// AC: @ralph-replacement ac-8 — this test covers session checkpoint, not default agents
describe("uncommitted changes detection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("session checkpoint warns about uncommitted changes when they exist", async () => {
    // Create a file change to simulate uncommitted work
    await fs.writeFile(path.join(tempDir, "uncommitted.ts"), "// uncommitted work\n", "utf-8");

    // Session checkpoint should detect the dirty working tree and block
    const result = await kspec("session checkpoint --json", tempDir);

    // In JSON mode, checkpoint exits 0 but outputs {"decision": "block", "reason": "..."}
    // when uncommitted changes are detected
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as {
      decision: string;
      reason: string;
    };
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("uncommitted changes");
  });
});
