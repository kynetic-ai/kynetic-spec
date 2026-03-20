import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  kspec as kspecRun,
  kspecJson,
  kspecOutput as kspec,
  setupTempFixtures,
} from "./helpers/cli";

describe("Integration: CLI mutation input validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cli-input-type-safety ac-1
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-type-safe-input ac-3
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-5
  // AC: @trait-semantic-exit-codes ac-2
  it("rejects invalid task add and inbox promote task types before persisting", () => {
    let result = kspecRun(
      'task add --title "Bad task type" --type invalid-type --slug bad-task-type',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid task type");
    expect(result.stderr).toContain("epic, task, bug, spike, infra");

    let tasks = kspecJson<Array<{ title: string }>>("tasks list", tempDir);
    expect(tasks.some((task) => task.title === "Bad task type")).toBe(false);

    kspec('inbox add "Promote me"', tempDir);
    const inboxItems = kspecJson<Array<{ _ulid: string }>>("inbox list", tempDir);
    result = kspecRun(
      `inbox promote @${inboxItems[0]._ulid} --title "Promoted bad type" --type invalid-type`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid task type");
    expect(result.stderr).toContain("epic, task, bug, spike, infra");

    tasks = kspecJson<Array<{ title: string }>>("tasks list", tempDir);
    expect(tasks.some((task) => task.title === "Promoted bad type")).toBe(false);
  });

  // AC: @cli-input-type-safety ac-1
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-type-safe-input ac-3
  // AC: @trait-semantic-exit-codes ac-2
  it("rejects invalid item add and item set enum values before mutating the item", () => {
    let result = kspecRun(
      'item add --under @test-core --title "Bad item type" --type invalid-type --slug bad-item-type',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid item type");
    expect(result.stderr).toContain("feature");
    expect(result.stderr).toContain("requirement");
    expect(result.stderr).toContain("constraint");
    expect(result.stderr).toContain("decision");
    expect(result.stderr).toContain("module");
    expect(result.stderr).toContain("task");
    expect(result.stderr).toContain("trait");

    const itemsList = kspec("item list", tempDir);
    expect(itemsList).not.toContain("Bad item type");

    kspec(
      'item add --under @test-core --title "Mutable item" --type feature --slug mutable-item',
      tempDir,
    );

    result = kspecRun(
      "item set @mutable-item --type invalid-type",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid item type");

    result = kspecRun(
      "item set @mutable-item --status invalid-status",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid implementation status");
    expect(result.stderr).toContain("not_started, in_progress, implemented, verified");

    result = kspecRun(
      "item set @mutable-item --maturity invalid-maturity",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid maturity");
    expect(result.stderr).toContain("draft, proposed, stable, deferred, deprecated");

    const item = kspecJson<{
      type: string;
      status?: { implementation?: string; maturity?: string };
    }>("item get @mutable-item", tempDir);
    expect(item.type).toBe("feature");
    expect(item.status?.implementation ?? "not_started").toBe("not_started");
    expect(item.status?.maturity ?? "draft").toBe("draft");
  });

  // AC: @cli-input-type-safety ac-1
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-type-safe-input ac-3
  // AC: @trait-semantic-exit-codes ac-2
  it("rejects invalid plan statuses before creating or updating plans", () => {
    let result = kspecRun(
      'plan add --title "Bad plan" --content "text" --status invalid-status',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid plan status");
    expect(result.stderr).toContain("draft, approved, active, completed, rejected");

    let plans = kspecJson<Array<{ title: string }>>("plan list", tempDir);
    expect(plans).toHaveLength(0);

    kspec('plan add --title "Valid plan" --content "text" --slug valid-plan', tempDir);

    result = kspecRun(
      "plan set @valid-plan --status invalid-status",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid plan status");

    plans = kspecJson<Array<{ title: string; status: string }>>("plan list", tempDir);
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe("Valid plan");
    expect(plans[0].status).toBe("draft");
  });

  // AC: @cli-input-type-safety ac-1
  // AC: @trait-type-safe-input ac-1
  // AC: @trait-type-safe-input ac-2
  // AC: @trait-type-safe-input ac-3
  // AC: @trait-semantic-exit-codes ac-2
  it("rejects invalid review check statuses before recording checks", () => {
    kspec("review add --title 'Check status review' --base a1 --head b1 --slug check-status-review", tempDir);

    const result = kspecRun(
      "review check @check-status-review --name tests --status invalid-status",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Invalid check status");
    expect(result.stderr).toContain("pass, fail, running, skipped");

    const review = kspecJson<{ checks: Array<{ name: string }> }>(
      "review get @check-status-review",
      tempDir,
    );
    expect(review.checks).toHaveLength(0);
  });

  // AC: @cli-input-type-safety ac-3
  // AC: @cli-input-type-safety ac-4
  // AC: @trait-semantic-exit-codes ac-1
  it("accepts valid values and valid defaults for the mutated commands", () => {
    kspec(
      'task add --title "Valid bug task" --type bug --slug valid-bug-task',
      tempDir,
    );
    const task = kspecJson<{ type: string }>("task get @valid-bug-task", tempDir);
    expect(task.type).toBe("bug");

    kspec(
      'item add --under @test-core --title "Valid requirement item" --type requirement --slug valid-requirement-item',
      tempDir,
    );
    kspec(
      "item set @valid-requirement-item --status implemented --maturity stable",
      tempDir,
      { stdin: "n" },
    );
    const item = kspecJson<{
      type: string;
      status?: { implementation?: string; maturity?: string };
    }>("item get @valid-requirement-item", tempDir);
    expect(item.type).toBe("requirement");
    expect(item.status?.implementation).toBe("implemented");
    expect(item.status?.maturity).toBe("stable");

    kspec('inbox add "Inbox to promote"', tempDir);
    const inboxItems = kspecJson<Array<{ _ulid: string }>>("inbox list", tempDir);
    kspec(
      `inbox promote @${inboxItems[0]._ulid} --title "Default promote type"`,
      tempDir,
    );
    const promotedTasks = kspecJson<Array<{ title: string; type: string }>>("tasks list", tempDir);
    expect(
      promotedTasks.find((entry) => entry.title === "Default promote type")?.type,
    ).toBe("task");

    kspec('plan add --title "Default status plan" --content "body" --slug default-status-plan', tempDir);
    const plan = kspecJson<{ status: string }>("plan get @default-status-plan", tempDir);
    expect(plan.status).toBe("draft");

    kspec("review add --title 'Valid check review' --base a1 --head b1 --slug valid-check-review", tempDir);
    kspec(
      "review check @valid-check-review --name tests --status pass",
      tempDir,
    );
    const review = kspecJson<{ checks: Array<{ status: string }> }>(
      "review get @valid-check-review",
      tempDir,
    );
    expect(review.checks[0]?.status).toBe("pass");
  });
});
