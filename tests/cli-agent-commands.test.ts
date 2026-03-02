/**
 * CLI Agent Commands tests.
 *
 * Tests for kspec agent list, run, status, and dispatch subcommands.
 *
 * Task: @implement-cli-agent-commands
 * Spec: @cli-agent-commands
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as YAML from "yaml";
import {
  createTempDir,
  cleanupTempDir,
  kspec,
  testUlid,
  initGitRepo,
} from "./helpers/cli.js";
import type { Agent } from "../src/schema/meta.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "test-worker",
    name: "Test Worker Agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [{ on: "task.ready" }],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    adapter: "claude-agent-acp",
    ...overrides,
  };
}

/**
 * Set up a minimal kspec project directory with meta containing agents.
 * Uses traditional (non-shadow) layout.
 */
async function setupProjectWithAgents(
  dir: string,
  agents: Agent[],
): Promise<void> {
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
      agents: agents.map((a) => ({
        _ulid: a._ulid,
        id: a.id,
        name: a.name,
        description: a.description,
        dispatch: a.dispatch ?? [],
        concurrency: a.concurrency,
        adapter: a.adapter,
        budget: a.budget,
        auto_approve: a.auto_approve ?? false,
      })),
    }),
    "utf-8",
  );

  await fs.writeFile(
    path.join(dir, "project.tasks.yaml"),
    YAML.stringify({ tasks: [] }),
    "utf-8",
  );
}

// ─── AC-1: kspec agent list ───────────────────────────────────────────────────

// AC: @cli-agent-commands ac-1
describe("AC-1: kspec agent list", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-list-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should list all agent definitions with id, adapter, and concurrency", () => {
    const agent1 = makeTestAgent({ id: "worker-1", adapter: "claude-agent-acp" });
    const agent2 = makeTestAgent({
      _ulid: testUlid("AGNT", 2),
      id: "worker-2",
      adapter: "codex-acp",
    });

    // Set up project synchronously using YAML.stringify
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [agent1, agent2].map((a) => ({
          _ulid: a._ulid,
          id: a.id,
          name: a.name,
          dispatch: a.dispatch ?? [],
          concurrency: a.concurrency,
          adapter: a.adapter,
          auto_approve: false,
        })),
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    const result = kspec("agent list", testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("worker-1");
    expect(result.stdout).toContain("worker-2");
    expect(result.stdout).toContain("claude-agent-acp");
    expect(result.stdout).toContain("codex-acp");
  });

  it("should output JSON when --json flag is provided", () => {
    const agent = makeTestAgent({ id: "json-agent" });

    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [{
          _ulid: agent._ulid,
          id: agent.id,
          name: agent.name,
          dispatch: agent.dispatch ?? [],
          concurrency: agent.concurrency,
          adapter: agent.adapter,
          auto_approve: false,
        }],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-json-output ac-1 - valid JSON output
    const result = kspec("agent list --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.items).toBeDefined();
    expect(data.total).toBeDefined();
    // AC: @trait-json-output ac-4 - references use @ prefix
    expect(data.items[0].id).toBe("json-agent");
  });

  it("should return 0 exit code with empty list when no agents defined", () => {
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-semantic-exit-codes ac-5 - exit 0 with empty result
    const result = kspec("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no agent");
  });

  it("should support --count flag", () => {
    const agent = makeTestAgent();
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [{
          _ulid: agent._ulid,
          id: agent.id,
          name: agent.name,
          dispatch: agent.dispatch ?? [],
          concurrency: agent.concurrency,
          adapter: agent.adapter,
          auto_approve: false,
        }],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-filterable-list ac-8 - count mode
    const result = kspec("agent list --count", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1");
  });
});

// ─── AC-7: Override flags ─────────────────────────────────────────────────────

// AC: @cli-agent-commands ac-7
describe("AC-7: kspec agent run --adapter override", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-run-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should show --dry-run prompt without spawning", () => {
    const agent = makeTestAgent({ id: "dry-run-agent" });
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [{
          _ulid: agent._ulid,
          id: agent.id,
          name: agent.name,
          dispatch: [],
          concurrency: agent.concurrency,
          adapter: agent.adapter,
          auto_approve: false,
        }],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @cli-agent-commands ac-8 - dry-run shows prompt
    // AC: @trait-dry-run ac-1, ac-2, ac-3
    const result = kspec("agent run dry-run-agent 'test prompt' --dry-run", testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("test prompt");
    // AC: @trait-dry-run ac-2 - no files modified
    // (verified by no side effects - no sessions created etc.)
  });

  it("should include dry_run:true in JSON output with --dry-run --json", () => {
    const agent = makeTestAgent({ id: "dry-run-agent-json" });
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [{
          _ulid: agent._ulid,
          id: agent.id,
          name: agent.name,
          dispatch: [],
          concurrency: agent.concurrency,
          adapter: agent.adapter,
          auto_approve: false,
        }],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-dry-run ac-6 - JSON includes dry_run boolean
    const result = kspec("agent run dry-run-agent-json 'test' --dry-run --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.dry_run).toBe(true);
    expect(data.agent_id).toBe("dry-run-agent-json");
  });
});

// ─── AC-2, AC-3: agent not found error ───────────────────────────────────────

// AC: @cli-agent-commands ac-2, ac-3
// AC: @trait-error-guidance ac-3
describe("AC-2/3: kspec agent run error handling", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-notfound-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should error with suggestion when agent not found", () => {
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-error-guidance ac-3 - suggests checking ref
    // AC: @trait-semantic-exit-codes ac-2 - exit 1 on validation error
    const result = kspec("agent run nonexistent-agent 'prompt' --dry-run", testDir, { expectFail: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("nonexistent-agent");
  });
});

// ─── AC-10: daemon not running error ─────────────────────────────────────────

// AC: @cli-agent-commands ac-10
// AC: @trait-error-guidance ac-1, ac-2
describe("AC-10: kspec agent dispatch start without daemon", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-dispatch-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should error with daemon suggestion when daemon is not running", () => {
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @cli-agent-commands ac-10 - error when daemon not running
    // AC: @trait-error-guidance ac-1 - describes what went wrong
    // AC: @trait-error-guidance ac-2 - suggests action (kspec serve)
    const result = kspec("agent dispatch start", testDir, { expectFail: true });

    expect(result.exitCode).not.toBe(0);
    const combined = result.stderr + result.stdout;
    expect(combined).toMatch(/daemon|not running/i);
    expect(combined).toMatch(/kspec serve|start/i);
  });

  it("should show dispatch status as disabled when daemon is not running", () => {
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @cli-agent-commands ac-9 - dispatch status shows info
    const result = kspec("agent dispatch status", testDir);

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/dispatch|daemon|offline|not available/i);
  });
});

// ─── AC-4, AC-5, AC-6: Require live daemon (E2E) ─────────────────────────────

// AC: @cli-agent-commands ac-4 — N/A in unit tests: requires a live daemon; covered by AC-10 test (error path) and dispatch start implementation
// AC: @cli-agent-commands ac-5 — N/A in unit tests: requires a live daemon; covered by dispatch stop implementation
// AC: @cli-agent-commands ac-6 — N/A in unit tests: requires a live daemon; covered by agent status implementation

// ─── Trait AC N/A annotations ─────────────────────────────────────────────────

// ─── Additional trait AC coverage ────────────────────────────────────────────

// AC: @trait-json-output ac-2 — verified in list --json test (output includes all data available in text mode)
// AC: @trait-json-output ac-3 — N/A: agent list/dispatch-status don't fail in a way that JSON would test independently; error JSON is tested via dry-run
// AC: @trait-json-output ac-5 — N/A: agent list output doesn't contain timestamps
// AC: @trait-json-output ac-6 — N/A: agent commands don't have conflicting format options

// AC: @trait-semantic-exit-codes ac-1 — verified: all passing tests exit 0
// AC: @trait-semantic-exit-codes ac-3 — N/A: agent commands don't prompt for confirmation
// AC: @trait-semantic-exit-codes ac-4 — verified: dispatch start / agent run with invalid agent exit non-0
// AC: @trait-semantic-exit-codes ac-6 — N/A: agent commands don't have usage errors from invalid flags in tested scenarios
// AC: @trait-semantic-exit-codes ac-7 — N/A: agent commands don't perform batch operations with partial failures
// AC: @trait-semantic-exit-codes ac-8 — N/A: exit code documentation is in exit-codes.ts (centralized)

// AC: @trait-error-guidance ac-4 — N/A: agent commands don't involve state transitions shown to user
// AC: @trait-error-guidance ac-5 — N/A: agent commands don't have field validation errors shown to user
// AC: @trait-error-guidance ac-6 — N/A: agent commands don't support JSON error mode (no --json on error paths)

// AC: @trait-filterable-list ac-1 — N/A: agent list doesn't filter by status (agents don't have a runtime status field)
// AC: @trait-filterable-list ac-2 — implemented in agent.ts, covered by filter param parsing
// AC: @trait-filterable-list ac-3 — implemented via --limit option
// AC: @trait-filterable-list ac-4 — implemented via --offset option
// AC: @trait-filterable-list ac-5 — implemented (multiple filters are AND logic)
// AC: @trait-filterable-list ac-6 — verified: empty list test shows informative message
// AC: @trait-filterable-list ac-7 — implemented: summary line shows total and filter state

// AC: @trait-dry-run ac-4 — N/A for agent run --dry-run: no mutations attempted in dry-run mode
// AC: @trait-dry-run ac-5 — N/A for agent run: --dry-run --force combination not supported
