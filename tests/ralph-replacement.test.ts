/**
 * Tests for ralph replacement — kspec ralph deprecation and built-in agent setup.
 *
 * Verifies that kspec ralph commands show a helpful migration error, and that
 * kspec setup creates built-in task-worker and pr-reviewer agent definitions.
 *
 * Task: @implement-ralph-replacement
 * Spec: @ralph-replacement
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import { spawnSync } from "node:child_process";
import {
  CLI_PATH,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  kspec,
} from "./helpers/cli.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, KSPEC_AUTHOR: "@test" },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
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

// ─── Tests ────────────────────────────────────────────────────────────────────

// AC: @ralph-replacement ac-1
describe("kspec ralph deprecation", () => {
  it("shows migration error when kspec ralph run is invoked", () => {
    const result = runCli(["ralph", "run"], process.cwd());

    // Should exit with code 1
    expect(result.exitCode).toBe(1);

    // AC: @trait-error-guidance ac-1 — description of what went wrong
    expect(result.stderr).toMatch(/kspec ralph has been replaced/i);

    // AC: @ralph-replacement ac-1 — lists equivalent commands
    expect(result.stderr).toContain("kspec ralph run");
    expect(result.stderr).toContain("kspec agent dispatch start");
    expect(result.stderr).toMatch(
      /kspec ralph run\s+→\s+kspec agent dispatch start/,
    );
    expect(result.stderr).toContain("kspec ralph --dry-run");
    expect(result.stderr).toContain("kspec agent dispatch start --dry-run");
  });

  it("shows migration error when kspec ralph end-loop is invoked", () => {
    const result = runCli(["ralph", "end-loop"], process.cwd());

    // Should exit with code 1
    expect(result.exitCode).toBe(1);

    // AC: @trait-error-guidance ac-1 — description of what went wrong
    expect(result.stderr).toMatch(/kspec ralph has been replaced/i);

    // AC: @ralph-replacement ac-1 — lists equivalent commands
    expect(result.stderr).toContain("kspec agent end-loop");
  });

  it("shows kspec setup suggestion in migration message", () => {
    const result = runCli(["ralph"], process.cwd());

    // AC: @trait-error-guidance ac-2 — suggested action to resolve
    expect(result.stderr).toContain("kspec setup");
  });
});

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

// AC: @ralph-replacement ac-6
describe("agent dispatch template section", () => {
  it("06-ralph-loop.md template references agent dispatch not ralph", async () => {
    // Resolve the template path relative to package root
    const templatePath = path.join(
      __dirname,
      "..",
      "templates",
      "agents-sections",
      "06-ralph-loop.md",
    );
    const content = await fs.readFile(templatePath, "utf-8");
    const lower = content.toLowerCase();

    // Should be about agent dispatch, not ralph
    expect(lower).toContain("dispatch");
    expect(lower).not.toContain("ralph");
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
    await fs.writeFile(
      path.join(tempDir, "uncommitted.ts"),
      "// uncommitted work\n",
      "utf-8",
    );

    // Session checkpoint should detect the dirty working tree and block
    const result = await kspec(
      "session checkpoint --json",
      tempDir,
    );

    // In JSON mode, checkpoint exits 0 but outputs {"decision": "block", "reason": "..."}
    // when uncommitted changes are detected
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as { decision: string; reason: string };
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("uncommitted changes");
  });
});

// ─── AC Coverage Annotations ─────────────────────────────────────────────────
//
// Own ACs covered indirectly (no dedicated test needed):
// AC: @ralph-replacement ac-3 — covered by ac-2 dispatch rule tests verifying worker+reviewer lifecycle match ralph behavior
// AC: @ralph-replacement ac-4 — N/A: workflow updates are configuration-only changes in .kspec/; verified by kspec-agents.md content, no unit test needed
// AC: @ralph-replacement ac-5 — N/A: skill file content changes verified by kspec-agents.md generation; no unit test needed
// AC: @ralph-replacement ac-7 — N/A: AC is satisfied by deletion of ralph test files; verified by CI passing without them
//
// Inherited trait ACs (@trait-error-guidance) that do not apply to the ralph deprecation stub:
// AC: @trait-error-guidance ac-3 — N/A: ralph stub does not perform ref lookups; no 'not found' error paths
// AC: @trait-error-guidance ac-4 — N/A: ralph stub has no state machine transitions; only shows migration error
// AC: @trait-error-guidance ac-5 — N/A: ralph stub has no field validation; only shows migration error
// AC: @trait-error-guidance ac-6 — N/A: ralph stub has no --json mode
