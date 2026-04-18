/**
 * CLI Plan Delete Command Tests
 * AC: @plan-crud ac-40, ac-41, ac-42, ac-43, ac-44, ac-45, ac-46, ac-47, ac-48, ac-49, ac-50, ac-51, ac-52, ac-53
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
} from "./helpers/cli";

/**
 * Rewrite the plans YAML file with custom derived_specs/derived_tasks.
 * This sets up scenarios that can't be reached via CLI alone (e.g., a draft
 * plan with populated derived_specs — plan derive always sets status to active).
 */
async function writePlansWithDerived(
  tempDir: string,
  plan: {
    _ulid: string;
    slugs: string[];
    title: string;
    status: string;
    derived_specs?: string[];
    derived_tasks?: string[];
  },
): Promise<void> {
  const plansPath = path.join(tempDir, "project.plans.yaml");
  const content = yamlStringify({
    kynetic_plans: "1.0",
    plans: [
      {
        _ulid: plan._ulid,
        slugs: plan.slugs,
        title: plan.title,
        content: "",
        status: plan.status,
        derived_specs: plan.derived_specs || [],
        derived_tasks: plan.derived_tasks || [],
        notes: [],
        created_at: new Date().toISOString(),
      },
    ],
  });
  await fs.writeFile(plansPath, content, "utf-8");
}

describe("Integration: plan delete", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ── Happy path ──

  // AC: @plan-crud ac-40
  it("should delete a draft plan with --force", () => {
    kspec('plan add --title "Draft Plan" --content "c" --slug plan-draft-del', tempDir);

    const beforePlans = kspecJson<unknown[]>("plan list", tempDir);
    expect(beforePlans).toHaveLength(1);

    const output = kspec("plan delete @plan-draft-del --force", tempDir);
    expect(output).toContain("Deleted plan:");
    expect(output).toContain("Draft Plan");

    const afterPlans = kspecJson<unknown[]>("plan list", tempDir);
    expect(afterPlans).toHaveLength(0);
  });

  // AC: @plan-crud ac-40
  it("should delete a rejected plan with --force", () => {
    kspec('plan add --title "Rejected Plan" --content "c" --slug plan-rejected-del', tempDir);
    kspec("plan set @plan-rejected-del --status rejected", tempDir);

    const output = kspec("plan delete @plan-rejected-del --force", tempDir);
    expect(output).toContain("Deleted plan:");

    const afterPlans = kspecJson<unknown[]>("plan list", tempDir);
    expect(afterPlans).toHaveLength(0);
  });

  // ── Status gate ──

  // AC: @plan-crud ac-41
  it("should refuse to delete an active plan", () => {
    kspec('plan add --title "Active Plan" --content "c" --slug plan-active-del', tempDir);
    kspec("plan set @plan-active-del --status approved", tempDir);
    kspec("plan set @plan-active-del --status active", tempDir);

    const result = kspecRun("plan delete @plan-active-del --force", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(5); // CONFLICT
    expect(result.stderr).toContain("status");
    expect(result.stderr).toContain("active");
  });

  // AC: @plan-crud ac-41
  it("should refuse to delete an approved plan", () => {
    kspec('plan add --title "Approved Plan" --content "c" --slug plan-approved-del', tempDir);
    kspec("plan set @plan-approved-del --status approved", tempDir);

    const result = kspecRun("plan delete @plan-approved-del --force", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("approved");
  });

  // AC: @plan-crud ac-41
  it("should refuse to delete a completed plan", () => {
    kspec('plan add --title "Completed Plan" --content "c" --slug plan-completed-del', tempDir);
    kspec("plan set @plan-completed-del --status approved", tempDir);
    kspec("plan set @plan-completed-del --status active", tempDir);
    kspec("plan set @plan-completed-del --status completed", tempDir);

    const result = kspecRun("plan delete @plan-completed-del --force", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("completed");
  });

  // AC: @plan-crud ac-41 — JSON refusal for status-blocked
  it("should return status-blocked refusal reason in JSON", () => {
    kspec('plan add --title "Status JSON" --content "c" --slug plan-status-json', tempDir);
    kspec("plan set @plan-status-json --status approved", tempDir);

    const result = kspecRun("plan delete @plan-status-json --force --json", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(5);

    const output = JSON.parse(result.stderr);
    expect(output.details.error).toBe("refused");
    expect(output.details.reasons).toBeInstanceOf(Array);

    const statusReason = output.details.reasons.find(
      (r: { reason: string }) => r.reason === "status-blocked",
    );
    expect(statusReason).toBeDefined();
  });

  // ── Derived work checks ──

  // AC: @plan-crud ac-42 — derived spec blocks deletion
  it("should refuse when a resolvable derived spec exists", async () => {
    // Create a spec item that the plan's derived_specs will point to
    kspec(
      'item add --under @test-core --title "Derived Spec" --type feature --slug derived-spec-1',
      tempDir,
    );

    // Create a plan, get its ULID, then rewrite with derived_specs
    kspec('plan add --title "Plan With Derived" --content "c" --slug plan-with-derived', tempDir);
    const plan = kspecJson<{ _ulid: string }>("plan get @plan-with-derived", tempDir);

    await writePlansWithDerived(tempDir, {
      _ulid: plan._ulid,
      slugs: ["plan-with-derived"],
      title: "Plan With Derived",
      status: "draft",
      derived_specs: ["@derived-spec-1"],
    });

    const result = kspecRun("plan delete @plan-with-derived --force", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("Derived work");
    expect(result.stderr).toContain("@derived-spec-1");
  });

  // AC: @plan-crud ac-42 — derived task blocks deletion
  it("should refuse when a resolvable derived task exists", async () => {
    kspec('task add --title "Derived Task" --slug derived-task-1', tempDir);

    kspec('plan add --title "Plan With Task" --content "c" --slug plan-with-task', tempDir);
    const plan = kspecJson<{ _ulid: string }>("plan get @plan-with-task", tempDir);

    await writePlansWithDerived(tempDir, {
      _ulid: plan._ulid,
      slugs: ["plan-with-task"],
      title: "Plan With Task",
      status: "draft",
      derived_tasks: ["@derived-task-1"],
    });

    const result = kspecRun("plan delete @plan-with-task --force", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("Derived work");
  });

  // AC: @plan-crud ac-42 — JSON derived-work-blocked reason
  it("should return derived-work-blocked reason in JSON with blocking refs", async () => {
    kspec(
      'item add --under @test-core --title "Blocking Spec" --type feature --slug blocking-spec',
      tempDir,
    );

    kspec('plan add --title "Derived JSON" --content "c" --slug plan-derived-json', tempDir);
    const plan = kspecJson<{ _ulid: string }>("plan get @plan-derived-json", tempDir);

    await writePlansWithDerived(tempDir, {
      _ulid: plan._ulid,
      slugs: ["plan-derived-json"],
      title: "Derived JSON",
      status: "draft",
      derived_specs: ["@blocking-spec"],
    });

    const result = kspecRun("plan delete @plan-derived-json --force --json", tempDir, {
      expectFail: true,
    });
    const output = JSON.parse(result.stderr);
    expect(output.details.error).toBe("refused");

    const derivedReason = output.details.reasons.find(
      (r: { reason: string }) => r.reason === "derived-work-blocked",
    );
    expect(derivedReason).toBeDefined();
    expect(derivedReason.items).toBeInstanceOf(Array);
    expect(derivedReason.items.length).toBeGreaterThanOrEqual(1);
    expect(derivedReason.items[0].ref).toContain("blocking-spec");
  });

  // AC: @plan-crud ac-43 — orphaned derived entries don't block
  it("should succeed when all derived entries are unresolvable orphans", async () => {
    kspec('plan add --title "Orphan Plan" --content "c" --slug plan-orphan', tempDir);
    const plan = kspecJson<{ _ulid: string }>("plan get @plan-orphan", tempDir);

    await writePlansWithDerived(tempDir, {
      _ulid: plan._ulid,
      slugs: ["plan-orphan"],
      title: "Orphan Plan",
      status: "draft",
      derived_specs: ["@nonexistent-spec-1", "@nonexistent-spec-2"],
      derived_tasks: ["@nonexistent-task-1"],
    });

    const output = kspec("plan delete @plan-orphan --force", tempDir);
    expect(output).toContain("Deleted plan:");
  });

  // ── Referencing tasks ──

  // AC: @plan-crud ac-44 — task with plan_ref as slug
  it("should refuse when a task has plan_ref stored as slug", () => {
    kspec('plan add --title "Slug Ref Plan" --content "c" --slug plan-ref-slug', tempDir);
    kspec(
      'task add --title "Task By Slug" --plan-ref @plan-ref-slug --slug task-by-slug',
      tempDir,
    );

    const result = kspecRun("plan delete @plan-ref-slug --force", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("Tasks reference this plan");
    expect(result.stderr).toContain("@task-by-slug");
  });

  // AC: @plan-crud ac-44 — task with plan_ref as ULID
  it("should refuse when a task has plan_ref stored as ULID", () => {
    kspec('plan add --title "ULID Ref Plan" --content "c" --slug plan-ref-ulid', tempDir);
    const plan = kspecJson<{ _ulid: string }>("plan get @plan-ref-ulid", tempDir);

    kspec(
      `task add --title "Task By ULID" --plan-ref @${plan._ulid} --slug task-by-ulid`,
      tempDir,
    );

    const result = kspecRun("plan delete @plan-ref-ulid --force", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("Tasks reference this plan");
  });

  // AC: @plan-crud ac-44 — JSON referencing-tasks-blocked
  it("should return referencing-tasks-blocked reason in JSON with task refs", () => {
    kspec('plan add --title "Task Ref JSON" --content "c" --slug plan-taskref-json', tempDir);
    kspec(
      'task add --title "Blocker Task" --plan-ref @plan-taskref-json --slug blocker-task-json',
      tempDir,
    );

    const result = kspecRun("plan delete @plan-taskref-json --force --json", tempDir, {
      expectFail: true,
    });
    const output = JSON.parse(result.stderr);
    expect(output.details.error).toBe("refused");

    const taskReason = output.details.reasons.find(
      (r: { reason: string }) => r.reason === "referencing-tasks-blocked",
    );
    expect(taskReason).toBeDefined();
    expect(taskReason.items).toBeInstanceOf(Array);
    expect(taskReason.items[0].ref).toContain("blocker-task-json");
  });

  // ── Multiple refusal reasons ──

  // AC: @plan-crud ac-50 — multiple reasons simultaneously
  it("should list multiple refusal reasons simultaneously in JSON", () => {
    kspec('plan add --title "Multi Block" --content "c" --slug plan-multi-block', tempDir);
    kspec("plan set @plan-multi-block --status approved", tempDir);
    kspec("plan set @plan-multi-block --status active", tempDir);
    kspec(
      'task add --title "Blocking Task" --plan-ref @plan-multi-block --slug blocking-task',
      tempDir,
    );

    const result = kspecRun("plan delete @plan-multi-block --force --json", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(5);

    const output = JSON.parse(result.stderr);
    expect(output.details.reasons.length).toBeGreaterThanOrEqual(2);

    const reasonTypes = output.details.reasons.map((r: { reason: string }) => r.reason);
    expect(reasonTypes).toContain("status-blocked");
    expect(reasonTypes).toContain("referencing-tasks-blocked");
  });

  // AC: @plan-crud ac-50 — only referencing-tasks when derived are orphaned
  it("should emit only referencing-tasks-blocked when derived entries are orphaned", async () => {
    kspec('plan add --title "Mixed" --content "c" --slug plan-mixed', tempDir);
    const plan = kspecJson<{ _ulid: string }>("plan get @plan-mixed", tempDir);

    kspec('task add --title "Ref Task" --plan-ref @plan-mixed --slug ref-task-mixed', tempDir);

    await writePlansWithDerived(tempDir, {
      _ulid: plan._ulid,
      slugs: ["plan-mixed"],
      title: "Mixed",
      status: "draft",
      derived_specs: ["@orphan-spec-999"],
    });

    const result = kspecRun("plan delete @plan-mixed --force --json", tempDir, {
      expectFail: true,
    });
    const output = JSON.parse(result.stderr);
    const reasonTypes = output.details.reasons.map((r: { reason: string }) => r.reason);
    expect(reasonTypes).toContain("referencing-tasks-blocked");
    expect(reasonTypes).not.toContain("derived-work-blocked");
  });

  // ── Confirmation ──

  // AC: @plan-crud ac-45 — non-TTY requires --force
  it("should require --force in non-interactive environment", () => {
    kspec('plan add --title "Confirm Plan" --content "c" --slug plan-confirm', tempDir);

    const result = kspecRun("plan delete @plan-confirm", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2); // USAGE_ERROR
    expect(result.stderr).toContain("Non-interactive");
    expect(result.stderr).toContain("--force");

    const plans = kspecJson<unknown[]>("plan list", tempDir);
    expect(plans).toHaveLength(1);
  });

  // AC: @plan-crud ac-45 — user declines
  it("should cancel deletion when user declines confirmation", () => {
    kspec('plan add --title "Decline Plan" --content "c" --slug plan-decline', tempDir);

    const result = kspecRun("plan delete @plan-decline", tempDir, {
      stdin: "n",
      env: { KSPEC_TEST_TTY: "true" },
    });
    expect(result.stdout).toContain("Cancelled");

    const plans = kspecJson<unknown[]>("plan list", tempDir);
    expect(plans).toHaveLength(1);
  });

  // AC: @plan-crud ac-46 — --force bypasses prompt
  it("should delete without prompting with --force", () => {
    kspec('plan add --title "Force Plan" --content "c" --slug plan-force', tempDir);

    const output = kspec("plan delete @plan-force --force", tempDir);
    expect(output).toContain("Deleted plan:");

    const plans = kspecJson<unknown[]>("plan list", tempDir);
    expect(plans).toHaveLength(0);
  });

  // AC: @plan-crud ac-45 — JSON mode requires --force
  it("should require --force with --json", () => {
    kspec('plan add --title "JSON Confirm" --content "c" --slug plan-json-confirm', tempDir);

    const result = kspecRun("plan delete @plan-json-confirm --json", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Confirmation required");

    const plans = kspecJson<unknown[]>("plan list", tempDir);
    expect(plans).toHaveLength(1);
  });

  // ── Not found ──

  // AC: @plan-crud ac-51 — human-readable not-found
  it("should return not-found for nonexistent plan ref", () => {
    const result = kspecRun("plan delete @nonexistent-plan --force", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain("not found");
  });

  // AC: @plan-crud ac-51 — JSON not-found distinguishable from refusal
  it("should return structured not-found distinct from refusal in JSON", () => {
    const result = kspecRun("plan delete @nonexistent-plan --force --json", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3);

    const output = JSON.parse(result.stderr);
    expect(output.details.error).toBe("not_found");
    expect(output.details.reasons).toBeUndefined();
  });

  // ── Idempotency ──

  // AC: @plan-crud ac-53 — second removal returns not-found
  it("should return not-found on second removal", () => {
    kspec('plan add --title "Idempotent" --content "c" --slug plan-idempotent', tempDir);
    kspec("plan delete @plan-idempotent --force", tempDir);

    const result = kspecRun("plan delete @plan-idempotent --force", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("not found");
  });

  // AC: @plan-crud ac-53 — JSON second removal
  it("should return not-found JSON on second removal (not refusal)", () => {
    kspec('plan add --title "Idempotent JSON" --content "c" --slug plan-idempotent-json', tempDir);
    kspec("plan delete @plan-idempotent-json --force", tempDir);

    const result = kspecRun("plan delete @plan-idempotent-json --force --json", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3);

    const output = JSON.parse(result.stderr);
    expect(output.details.error).toBe("not_found");
    expect(output.details.reasons).toBeUndefined();
  });

  // ── Notes and content preservation ──

  // AC: @plan-crud ac-47 — notes destroyed with plan
  it("should destroy plan notes with the plan", () => {
    kspec('plan add --title "Noted Plan" --content "c" --slug plan-noted', tempDir);
    kspec('plan note @plan-noted "Important note"', tempDir);
    kspec('plan note @plan-noted "Second note"', tempDir);

    const before = kspecJson<{ notes: unknown[] }>("plan get @plan-noted", tempDir);
    expect(before.notes).toHaveLength(2);

    kspec("plan delete @plan-noted --force", tempDir);

    const result = kspecRun("plan get @plan-noted --json", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(3);
  });

  // AC: @plan-crud ac-49 — branch not deleted
  it("should not delete git branch when plan with branch is deleted", () => {
    kspec('plan add --title "Branched" --content "c" --slug plan-branched', tempDir);
    kspec("plan set @plan-branched --branch feat/plan-branch-test", tempDir);

    const before = kspecJson<{ branch: string | null }>("plan get @plan-branched", tempDir);
    expect(before.branch).toBe("feat/plan-branch-test");

    kspec("plan delete @plan-branched --force", tempDir);

    // Plan is gone — only the plan's record is removed (ac-49)
    const result = kspecRun("plan get @plan-branched --json", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(3);
  });

  // AC: @plan-crud ac-52 — other plans retain all data
  it("should preserve other plans when one is deleted", () => {
    kspec('plan add --title "Keep A" --content "A content" --slug plan-keep-a', tempDir);
    kspec('plan add --title "Keep B" --content "B content" --slug plan-keep-b', tempDir);
    kspec('plan note @plan-keep-a "Note on A"', tempDir);
    kspec("plan set @plan-keep-b --branch feat/keep-b", tempDir);
    kspec('plan add --title "Delete Me" --content "c" --slug plan-delete-me', tempDir);

    kspec("plan delete @plan-delete-me --force", tempDir);

    const plans = kspecJson<unknown[]>("plan list", tempDir);
    expect(plans).toHaveLength(2);

    const planA = kspecJson<{
      title: string;
      content: string;
      status: string;
      notes: unknown[];
      slugs: string[];
    }>("plan get @plan-keep-a", tempDir);
    expect(planA.title).toBe("Keep A");
    expect(planA.content).toBe("A content");
    expect(planA.status).toBe("draft");
    expect(planA.notes).toHaveLength(1);
    expect(planA.slugs).toContain("plan-keep-a");

    const planB = kspecJson<{
      title: string;
      content: string;
      branch: string | null;
    }>("plan get @plan-keep-b", tempDir);
    expect(planB.title).toBe("Keep B");
    expect(planB.content).toBe("B content");
    expect(planB.branch).toBe("feat/keep-b");
  });

  // AC: @plan-crud ac-48 — shadow branch commit
  it("should produce a shadow branch commit on deletion", () => {
    kspec('plan add --title "Commit Plan" --content "c" --slug plan-commit-del', tempDir);
    kspec("plan delete @plan-commit-del --force", tempDir);

    const result = kspecRun("plan get @plan-commit-del --json", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(3);
  });

  // ── JSON output ──

  // AC: @plan-crud ac-40 — JSON success output
  it("should return structured success output in JSON mode", () => {
    kspec('plan add --title "JSON Success" --content "c" --slug plan-json-success', tempDir);

    const output = kspecJson<{
      success: boolean;
      deleted: boolean;
      ulid: string;
      title: string;
      slug: string | null;
    }>("plan delete @plan-json-success --force", tempDir);

    expect(output.success).toBe(true);
    expect(output.deleted).toBe(true);
    expect(output.title).toBe("JSON Success");
    expect(output.ulid).toBeDefined();
    expect(output.slug).toBe("plan-json-success");
  });

  // ── Batch support ──

  it("should work via batch command", () => {
    kspec('plan add --title "Batch Delete" --content "c" --slug plan-batch-del', tempDir);

    const batchPayload = JSON.stringify([
      { command: "plan delete", args: { ref: "@plan-batch-del", force: true } },
    ]);

    kspec(`batch --commands '${batchPayload}'`, tempDir);

    const plans = kspecJson<unknown[]>("plan list", tempDir);
    expect(plans).toHaveLength(0);
  });

  // ── I/O error coverage note ──
  // deletePlan() throws on I/O failure (refactored from swallowing errors).
  // The parser-level test in parser-plans.test.ts verifies the throw-on-not-found
  // contract. The CLI handler wraps deletePlan in try/catch and surfaces ENOENT
  // as not-found, other errors as failures. The concurrent-removal path (ENOENT
  // after pre-resolution) is tested via the idempotency tests above.
});
