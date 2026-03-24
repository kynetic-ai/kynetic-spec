/**
 * Tests for kspec setup built-in agent creation and session checkpoint.
 *
 * Verifies that kspec setup creates built-in task-worker and pr-reviewer
 * agent definitions with correct dispatch rules, and that session checkpoint
 * detects uncommitted changes.
 *
 * Spec: @ralph-replacement
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as YAML from "yaml";
import { cleanupTempDir, createTempDir, initGitRepo, kspec } from "./helpers/cli.js";

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

// ─── Tests ────────────────────────────────────────────────────────────────────

// AC: @ralph-replacement ac-2
describe("kspec setup built-in agents", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupMinimalProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("creates task-worker and pr-reviewer agents when project has no agents", async () => {
    // Run setup (no-hooks to keep it fast in tests)
    const result = await kspec("setup --no-hooks --skip-skills", tempDir);
    expect(result.exitCode).toBe(0);

    // Read the meta manifest
    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const raw = YAML.parse(await fs.readFile(metaPath, "utf-8")) as {
      agents?: Array<{ id: string; dispatch?: unknown[] }>;
    };

    const agents = raw.agents || [];
    const agentIds = agents.map((a) => a.id);

    // AC: @ralph-replacement ac-2 — built-in worker and reviewer created
    expect(agentIds).toContain("task-worker");
    expect(agentIds).toContain("pr-reviewer");
  });

  // AC: @agent-dispatch-engine ac-22
  it("task-worker has dispatch rules for task.in_progress/task.ready/task.needs_work with eligible filter", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const raw = YAML.parse(await fs.readFile(metaPath, "utf-8")) as {
      agents?: Array<{
        id: string;
        dispatch?: Array<{ on: string; filter?: { automation?: string } }>;
      }>;
    };

    const worker = (raw.agents || []).find((a) => a.id === "task-worker");
    expect(worker).toBeDefined();

    const dispatch = worker!.dispatch || [];
    const events = dispatch.map((r) => r.on);

    // AC: @ralph-replacement ac-2 — worker: task.in_progress + task.ready + task.needs_work with eligible filter
    expect(events).toContain("task.in_progress");
    expect(events).toContain("task.ready");
    expect(events).toContain("task.needs_work");

    // Should have automation: eligible filter
    const inProgressRule = dispatch.find((r) => r.on === "task.in_progress");
    expect(inProgressRule?.filter?.automation).toBe("eligible");
    const readyRule = dispatch.find((r) => r.on === "task.ready");
    expect(readyRule?.filter?.automation).toBe("eligible");
    const needsWorkRule = dispatch.find((r) => r.on === "task.needs_work");
    expect(needsWorkRule?.filter?.automation).toBe("eligible");
  });

  it("pr-reviewer has dispatch rule for task.pending_review", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const raw = YAML.parse(await fs.readFile(metaPath, "utf-8")) as {
      agents?: Array<{
        id: string;
        dispatch?: Array<{ on: string }>;
      }>;
    };

    const reviewer = (raw.agents || []).find((a) => a.id === "pr-reviewer");
    expect(reviewer).toBeDefined();

    const events = (reviewer!.dispatch || []).map((r) => r.on);

    // AC: @ralph-replacement ac-2 — reviewer: task.pending_review
    expect(events).toContain("task.pending_review");
  });

  it("does not duplicate agents when run twice (idempotent)", async () => {
    await kspec("setup --no-hooks --skip-skills", tempDir);
    await kspec("setup --no-hooks --skip-skills", tempDir);

    const metaPath = path.join(tempDir, "kynetic.meta.yaml");
    const raw = YAML.parse(await fs.readFile(metaPath, "utf-8")) as {
      agents?: Array<{ id: string }>;
    };

    const agentIds = (raw.agents || []).map((a) => a.id);
    const workerCount = agentIds.filter((id) => id === "task-worker").length;
    const reviewerCount = agentIds.filter((id) => id === "pr-reviewer").length;

    expect(workerCount).toBe(1);
    expect(reviewerCount).toBe(1);
  });
});

// AC: @ralph-replacement ac-8
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

// ─── AC Coverage Annotations ─────────────────────────────────────────────────
//
// AC: @ralph-replacement ac-3 — covered by ac-2 dispatch rule tests verifying worker+reviewer lifecycle
// AC: @ralph-replacement ac-4 — N/A: workflow updates are configuration-only changes in .kspec/
// AC: @ralph-replacement ac-5 — N/A: skill file content changes verified by kspec-agents.md generation
// AC: @ralph-replacement ac-7 — N/A: AC is satisfied by deletion of ralph test files
