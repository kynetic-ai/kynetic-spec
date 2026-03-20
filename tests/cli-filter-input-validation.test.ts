import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { stringify } from "yaml";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec as kspecRun,
  kspecJson,
  kspecOutput as kspec,
  setupTempFixtures,
  testUlid,
} from "./helpers/cli.js";

function writeMetaProject(
  dir: string,
  opts: { agents?: unknown[]; schedules?: unknown[] } = {},
): void {
  fs.writeFileSync(
    path.join(dir, "kynetic.yaml"),
    stringify({ kynetic: "1", title: "Test Project" }),
  );
  fs.writeFileSync(
    path.join(dir, "kynetic.meta.yaml"),
    stringify({
      kynetic_meta: "1.0",
      agents: opts.agents ?? [],
      schedules: opts.schedules ?? [],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "project.tasks.yaml"),
    stringify({ tasks: [] }),
  );
}

describe("Integration: CLI filter input validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cli-input-type-safety ac-2
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-type-safe-input ac-3
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-5
  // AC: @trait-semantic-exit-codes ac-2
  it("rejects invalid typed query filters instead of silently returning empty results", () => {
    kspec("review add --title 'Validation review' --base a1 --head b1 --slug validation-review", tempDir);
    kspec('inbox add "Validation triage item"', tempDir);
    const inboxItems = kspecJson<Array<{ _ulid: string }>>("inbox list", tempDir);
    kspec(
      `triage record @${inboxItems[0]._ulid} --action promote --reasoning "seed triage record"`,
      tempDir,
    );

    const cases = [
      ["tasks list --type invalid-type", "Invalid task type"],
      ["item list --type invalid-type", "Invalid item type"],
      ["plan list --status invalid-status", "Invalid plan status"],
      ["review list --status invalid-status", "Invalid review lifecycle state"],
      ["review list --disposition invalid-disposition", "Invalid review disposition"],
      ["triage list --status invalid-status", "Invalid triage status"],
      ["triage list --action invalid-action", "Invalid triage action"],
      ['search test --type invalid-type', "Invalid item type"],
      ['search test --status invalid-status', "Invalid task status"],
    ] as const;

    for (const [command, expected] of cases) {
      const result = kspecRun(command, tempDir, { expectFail: true });
      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain(expected);
    }
  });

  // AC: @cli-input-type-safety ac-3
  // AC: @trait-semantic-exit-codes ac-1
  it("accepts valid typed query filters and returns filtered results", () => {
    kspec("review add --title 'Open review' --base a1 --head b1 --slug open-review", tempDir);
    kspec("review open @open-review", tempDir);
    kspec('inbox add "Promote this"', tempDir);
    const inboxItems = kspecJson<Array<{ _ulid: string }>>("inbox list", tempDir);
    kspec(
      `triage record @${inboxItems[0]._ulid} --action promote --reasoning "seed triage record"`,
      tempDir,
    );

    const taskResults = kspecJson<Array<{ type: string }>>(
      "tasks list --type task",
      tempDir,
    );
    expect(taskResults.length).toBeGreaterThan(0);
    expect(taskResults.every((task) => task.type === "task")).toBe(true);

    const itemResults = kspecJson<{
      items: Array<{ type: string }>;
    }>(
      "item list --type feature",
      tempDir,
    );
    expect(itemResults.items.length).toBeGreaterThan(0);
    expect(itemResults.items.every((item) => item.type === "feature")).toBe(true);

    const planResults = kspecJson<Array<{ status: string }>>(
      "plan list --status draft",
      tempDir,
    );
    expect(planResults.every((plan) => plan.status === "draft")).toBe(true);

    const reviewResults = kspecJson<{ reviews: Array<{ lifecycle_state: string }> }>(
      "review list --status open",
      tempDir,
    );
    expect(reviewResults.reviews.length).toBe(1);
    expect(reviewResults.reviews[0].lifecycle_state).toBe("open");

    const triageResults = kspecJson<Array<{ action: string }>>(
      "triage list --action promote",
      tempDir,
    );
    expect(triageResults.length).toBe(1);
    expect(triageResults[0].action).toBe("promote");

    const searchResults = kspecJson<{
      results: Array<{ type: string; title: string }>;
    }>('search test --status pending', tempDir);
    const searchTaskResults = searchResults.results.filter((result) => result.type === "task");
    expect(searchTaskResults.length).toBeGreaterThan(0);
  });
});

describe("Integration: CLI meta filter input validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-filter-meta-");
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cli-input-type-safety ac-2
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-5
  // AC: @trait-semantic-exit-codes ac-2
  it("rejects invalid schedule and agent status filters", () => {
    writeMetaProject(tempDir, {
      agents: [
        {
          _ulid: testUlid("AGNT"),
          id: "eligible-worker",
          name: "Eligible Worker",
          dispatch: [],
          concurrency: { max_concurrent: 1 },
          adapter: "claude-agent-acp",
          auto_approve: false,
          automation: "eligible",
        },
      ],
      schedules: [
        {
          _ulid: testUlid("SCHED"),
          id: "daily",
          name: "Daily",
          cron: "0 * * * *",
          timezone: "UTC",
          action: { type: "command", command: "echo", args: ["hello"] },
          overlap_policy: "skip",
          backfill: false,
          enabled: true,
        },
      ],
    });

    let result = kspecRun("schedule list --status invalid-status", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid schedule status");
    expect(result.stderr).toContain("enabled, disabled");

    result = kspecRun("agent list --status invalid-status", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid agent automation status");
    expect(result.stderr).toContain("eligible, ineligible");
  });

  // AC: @cli-input-type-safety ac-3
  // AC: @trait-semantic-exit-codes ac-1
  it("accepts valid schedule and agent status filters", () => {
    writeMetaProject(tempDir, {
      agents: [
        {
          _ulid: testUlid("AGNT"),
          id: "eligible-worker",
          name: "Eligible Worker",
          dispatch: [],
          concurrency: { max_concurrent: 1 },
          adapter: "claude-agent-acp",
          auto_approve: false,
          automation: "eligible",
        },
        {
          _ulid: testUlid("AGNT", 2),
          id: "manual-worker",
          name: "Manual Worker",
          dispatch: [],
          concurrency: { max_concurrent: 1 },
          adapter: "claude-agent-acp",
          auto_approve: false,
        },
      ],
      schedules: [
        {
          _ulid: testUlid("SCHED"),
          id: "enabled-job",
          name: "Enabled Job",
          cron: "0 * * * *",
          timezone: "UTC",
          action: { type: "command", command: "echo", args: ["hello"] },
          overlap_policy: "skip",
          backfill: false,
          enabled: true,
        },
        {
          _ulid: testUlid("SCHED", 2),
          id: "disabled-job",
          name: "Disabled Job",
          cron: "0 * * * *",
          timezone: "UTC",
          action: { type: "command", command: "echo", args: ["hello"] },
          overlap_policy: "skip",
          backfill: false,
          enabled: false,
        },
      ],
    });

    const schedules = kspecJson<{ items: Array<{ enabled: boolean }> }>(
      "schedule list --status enabled",
      tempDir,
    );
    expect(schedules.items).toHaveLength(1);
    expect(schedules.items[0].enabled).toBe(true);

    const agents = kspecJson<{
      items: Array<{ id: string }>;
    }>("agent list --status eligible", tempDir);
    expect(agents.items).toHaveLength(1);
    expect(agents.items[0].id).toBe("eligible-worker");
  });
});
