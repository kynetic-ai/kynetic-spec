/**
 * Integration tests for enhanced plan derivation.
 */

// AC: @trait-shadow-commit ac-1 — N/A: plan derive delegates shadow commit creation to shared commitIfShadow coverage in shadow.test.ts.
// AC: @trait-shadow-commit ac-2 — N/A: commit message formatting is covered centrally by commitIfShadow tests.
// AC: @trait-shadow-commit ac-3 — N/A: commit message ref formatting is covered centrally by commitIfShadow tests.
// AC: @trait-shadow-commit ac-4 — N/A: shadow-disabled behavior is covered centrally by commitIfShadow tests.
// AC: @trait-shadow-commit ac-5 — N/A: save-failure short-circuit is covered by shared shadow commit tests.
// AC: @trait-shadow-commit ac-6 — N/A: fire-and-forget push behavior is covered centrally by commitIfShadow tests.
// AC: @trait-shadow-commit ac-7 — N/A: commit/push warning behavior is covered centrally by commitIfShadow tests.
// AC: @trait-shadow-commit ac-8 — N/A: temp CLI fixtures do not provision a shadow worktree; single-commit behavior is exercised in repositories with shadow enabled.
// AC: @trait-dry-run ac-5 — N/A: plan derive has no --force flag.
// AC: @trait-json-output ac-6 — N/A: plan derive has no competing format flags beyond --json.
// AC: @trait-semantic-exit-codes ac-3 — N/A: plan derive has no confirmation prompt.
// AC: @trait-semantic-exit-codes ac-5 — N/A: plan derive is a mutation command, not an empty-result query.
// AC: @trait-semantic-exit-codes ac-7 — N/A: partial materialization is warning-based success, not a batch failure mode.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  kspec as kspecRun,
  kspecJson,
  kspecOutput as kspec,
  setupTempFixtures,
} from "./helpers/cli";

function writePlanFile(tempDir: string, name: string, content: string): Promise<string> {
  const planPath = path.join(tempDir, name);
  return fs.writeFile(planPath, content).then(() => planPath);
}

describe("Integration: enhanced plan derive", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("derives specs from plan content, honors stored module, creates root traits, and leaves tasks disabled by default", async () => {
    // AC: @plan-derive-enhanced ac-parse-content, ac-module-from-import, ac-topo-sort, ac-traits, ac-no-tasks-default, ac-root-trait, ac-status-transition, ac-bidirectional-links
    // AC: @trait-json-output ac-2
    // AC: @trait-semantic-exit-codes ac-1
    const planPath = await writePlanFile(
      tempDir,
      "derive-specs.md",
      `# Derive Specs

## Specs

\`\`\`yaml
- title: Parent Feature
  slug: parent-feature
  type: feature
  traits:
    - trait-json-output

- title: Child Requirement
  slug: child-requirement
  type: requirement
  parent: "@parent-feature"

- title: Root Trait
  slug: plan-root-trait
  type: trait
\`\`\`
`,
    );

    kspec(
      `plan import "${planPath}" --module @test-core --status approved`,
      tempDir,
    );

    const result = kspecJson<{
      plan_ref: string;
      module_ref: string;
      created_specs: string[];
      created_tasks: string[];
      skipped: Array<{ ref: string }>;
      errors: Array<{ message: string }>;
    }>("plan derive @plan-derive-specs", tempDir);

    expect(result.module_ref).toBe("@test-core");
    expect(result.created_specs).toEqual([
      "@parent-feature",
      "@child-requirement",
      "@plan-root-trait",
    ]);
    expect(result.created_tasks).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);

    const derivedPlan = kspecJson<{
      status: string;
      derived_specs: string[];
      derived_tasks: string[];
    }>("plan get @plan-derive-specs", tempDir);
    expect(derivedPlan.status).toBe("active");
    expect(derivedPlan.derived_specs).toEqual(result.created_specs);
    expect(derivedPlan.derived_tasks).toEqual([]);

    const parent = kspecJson<{ traits: string[] }>(
      "item get @parent-feature",
      tempDir,
    );
    expect(parent.traits).toContain("@trait-json-output");

    const rootTrait = kspecJson<{ type: string }>(
      "item get @plan-root-trait",
      tempDir,
    );
    expect(rootTrait.type).toBe("trait");
  });

  it("requires a module when neither --module nor stored module_ref is available", async () => {
    // AC: @plan-derive-enhanced ac-module-required
    // AC: @trait-error-guidance ac-1, ac-2
    // AC: @trait-semantic-exit-codes ac-6
    const planPath = await writePlanFile(
      tempDir,
      "module-required.md",
      `# Module Required

## Specs

\`\`\`yaml
- title: Missing Module Feature
  slug: missing-module-feature
\`\`\`
`,
    );

    kspec(`plan import "${planPath}" --status approved`, tempDir);
    const result = kspecRun("plan derive @plan-module-required", tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "Plan derive requires --module when the plan has no stored module ref",
    );
  });

  it("lets --module override the stored module ref from import", async () => {
    // AC: @plan-derive-enhanced ac-module-override
    const planPath = await writePlanFile(
      tempDir,
      "override-module.md",
      `# Override Module

## Specs

\`\`\`yaml
- title: Override Feature
  slug: override-feature
\`\`\`
`,
    );

    kspec(
      'item add --under @test-core --title "Second Module" --type module --slug second-module',
      tempDir,
    );
    kspec(
      `plan import "${planPath}" --module @test-core --status approved`,
      tempDir,
    );

    const result = kspecJson<{ module_ref: string }>(
      "plan derive @plan-override-module --module @second-module",
      tempDir,
    );
    expect(result.module_ref).toBe("@second-module");

    const derivedPlan = kspecJson<{ derived_specs: string[] }>(
      "plan get @plan-override-module",
      tempDir,
    );
    expect(derivedPlan.derived_specs).toContain("@override-feature");
  });

  it("fails on circular local parent references", async () => {
    // AC: @plan-derive-enhanced ac-circular-dep
    // AC: @trait-error-guidance ac-5
    const planPath = await writePlanFile(
      tempDir,
      "circular.md",
      `# Circular Parents

## Specs

\`\`\`yaml
- title: First
  slug: first
  parent: "@second"

- title: Second
  slug: second
  parent: "@first"
\`\`\`
`,
    );

    kspec(
      `plan import "${planPath}" --module @test-core --status approved`,
      tempDir,
    );

    const result = kspecRun(
      "plan derive @plan-circular-parents --module @test-core",
      tempDir,
      { expectFail: true },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Circular parent reference");
  });

  it("deduplicates colliding slugs during derivation", async () => {
    // AC: @plan-derive-enhanced ac-slug-dedup, ac-commit
    kspec(
      'item add --under @test-core --title "Existing Collision" --slug collision-item',
      tempDir,
    );

    const planPath = await writePlanFile(
      tempDir,
      "slug-dedup.md",
      `# Slug Dedup

## Specs

\`\`\`yaml
- title: New Collision
  slug: collision-item
\`\`\`
`,
    );

    kspec(
      `plan import "${planPath}" --module @test-core --status approved`,
      tempDir,
    );

    const result = kspecJson<{ created_specs: string[] }>(
      "plan derive @plan-slug-dedup --module @test-core",
      tempDir,
    );

    expect(result.created_specs).toEqual(["@collision-item-1"]);
  });

  it("derives tasks, maps refs, carries priorities, and stores global plus per-spec implementation notes", async () => {
    // AC: @plan-derive-enhanced ac-depends-on, ac-tasks-flag, ac-task-refs, ac-additional-tasks, ac-impl-notes-global, ac-impl-notes-per-spec, ac-priority-inheritance
    const planPath = await writePlanFile(
      tempDir,
      "derive-tasks.md",
      `# Derive Tasks

## Specs

\`\`\`yaml
- title: Alpha Feature
  slug: alpha-feature
  priority: 1
  implementation_notes: |
    Alpha implementation detail.

- title: Beta Feature
  slug: beta-feature
  depends_on:
    - "@alpha-feature"
\`\`\`

## Tasks

derive_from_specs: true

\`\`\`yaml
- title: Write migration guide
  slug: migration-guide
  priority: 2
  spec_ref: "@beta-feature"
  depends_on:
    - "@alpha-feature"
\`\`\`

## Implementation Notes

Global implementation note for the plan.
`,
    );

    kspec(
      `plan import "${planPath}" --module @test-core --status approved`,
      tempDir,
    );

    const result = kspecJson<{
      created_specs: string[];
      created_tasks: string[];
    }>("plan derive @plan-derive-tasks --module @test-core --tasks", tempDir);

    expect(result.created_specs).toEqual(["@alpha-feature", "@beta-feature"]);
    expect(result.created_tasks).toEqual([
      "@implement-alpha-feature",
      "@implement-beta-feature",
      "@migration-guide",
    ]);

    const alphaTask = kspecJson<{
      plan_ref: string;
      spec_ref: string;
      priority: number;
      notes: Array<{ content: string }>;
    }>("task get @implement-alpha-feature", tempDir);
    expect(alphaTask.plan_ref).toBe("@plan-derive-tasks");
    expect(alphaTask.spec_ref).toBe("@alpha-feature");
    expect(alphaTask.priority).toBe(1);
    expect(alphaTask.notes.some((note) => note.content.includes("Alpha implementation detail."))).toBe(true);

    const betaTask = kspecJson<{
      depends_on: string[];
      spec_ref: string;
    }>("task get @implement-beta-feature", tempDir);
    expect(betaTask.spec_ref).toBe("@beta-feature");
    expect(betaTask.depends_on).toEqual(["@implement-alpha-feature"]);

    const guideTask = kspecJson<{
      plan_ref: string;
      spec_ref: string | null;
      priority: number;
      depends_on: string[];
    }>("task get @migration-guide", tempDir);
    expect(guideTask.plan_ref).toBe("@plan-derive-tasks");
    expect(guideTask.spec_ref).toBe("@beta-feature");
    expect(guideTask.priority).toBe(2);
    expect(guideTask.depends_on).toEqual(["@implement-alpha-feature"]);

    const derivedPlan = kspecJson<{
      notes: Array<{ content: string }>;
      derived_tasks: string[];
    }>("plan get @plan-derive-tasks", tempDir);
    expect(derivedPlan.derived_tasks).toEqual(result.created_tasks);
    expect(derivedPlan.notes.some((note) => note.content.includes("Global implementation note"))).toBe(true);
  });

  it("supports dry-run and structured JSON output without mutating plan state", async () => {
    // AC: @plan-derive-enhanced ac-dry-run, ac-json-output
    // AC: @trait-dry-run ac-1, ac-2, ac-3, ac-6
    // AC: @trait-json-output ac-1, ac-4
    const planPath = await writePlanFile(
      tempDir,
      "dry-run.md",
      `# Dry Run

## Specs

\`\`\`yaml
- title: Dry Run Feature
  slug: dry-run-feature
\`\`\`
`,
    );

    kspec(
      `plan import "${planPath}" --module @test-core --status approved`,
      tempDir,
    );

    const result = kspecJson<{
      dry_run: boolean;
      plan_ref: string;
      created_specs: string[];
      created_tasks: string[];
      skipped: unknown[];
      errors: unknown[];
    }>("plan derive @plan-dry-run --tasks --dry-run", tempDir);

    expect(result.dry_run).toBe(true);
    expect(result.plan_ref).toBe("@plan-dry-run");
    expect(result.created_specs).toEqual(["@dry-run-feature"]);
    expect(result.created_tasks).toEqual(["@implement-dry-run-feature"]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);

    const planAfter = kspecJson<{
      status: string;
      derived_specs: string[];
      derived_tasks: string[];
    }>("plan get @plan-dry-run", tempDir);
    expect(planAfter.status).toBe("approved");
    expect(planAfter.derived_specs).toEqual([]);
    expect(planAfter.derived_tasks).toEqual([]);
  });

  it("surfaces parse validation errors, skips unresolved parents, and preserves unresolved dependencies for later resolution", async () => {
    // AC: @plan-derive-enhanced ac-validation-errors, ac-parent-unresolved, ac-depends-on-unresolved
    const planPath = await writePlanFile(
      tempDir,
      "validation-errors.md",
      `# Validation Errors

## Specs

\`\`\`yaml
- title: Valid Feature
  slug: valid-feature

- slug: missing-title

- title: Missing Parent Feature
  slug: missing-parent-feature
  parent: "@not-here"

- title: Keeps Unresolved Dependency
  slug: unresolved-dependency
  depends_on:
    - "@ghost-spec"
\`\`\`
`,
    );

    kspec(
      `plan import "${planPath}" --module @test-core --status approved`,
      tempDir,
    );

    const result = kspecJson<{
      created_specs: string[];
      skipped: Array<{ ref: string; reason: string }>;
      errors: Array<{ type: string; message: string }>;
    }>("plan derive @plan-validation-errors --module @test-core", tempDir);

    expect(result.created_specs).toEqual(["@valid-feature", "@unresolved-dependency"]);
    expect(result.errors.some((err) => err.message.includes("missing required field: title"))).toBe(true);
    expect(result.skipped.some((entry) => entry.ref === "@missing-parent-feature")).toBe(true);

    const dependencySpec = kspecJson<{ depends_on: string[] }>(
      "item get @unresolved-dependency",
      tempDir,
    );
    expect(dependencySpec.depends_on).toEqual(["@ghost-spec"]);
  });

  it("errors when plan content has no specs section or fenced YAML block", async () => {
    // AC: @plan-derive-enhanced ac-no-specs-content
    // AC: @trait-error-guidance ac-5
    const planPath = await writePlanFile(
      tempDir,
      "no-specs.md",
      `# No Specs

Just prose, no structured specs section.
`,
    );

    kspec(
      `plan import "${planPath}" --module @test-core --status approved`,
      tempDir,
    );

    const result = kspecRun(
      "plan derive @plan-no-specs --module @test-core",
      tempDir,
      { expectFail: true },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("No specs found in plan content");
  });

  it("returns structured JSON errors for invalid usage and guards draft plus already-derived plans", async () => {
    // AC: @plan-derive-enhanced ac-status-guard, ac-already-derived
    // AC: @trait-error-guidance ac-4, ac-6
    // AC: @trait-json-output ac-3
    // AC: @trait-semantic-exit-codes ac-2
    const draftPath = await writePlanFile(
      tempDir,
      "draft-plan.md",
      `# Draft Plan

## Specs

\`\`\`yaml
- title: Draft Feature
  slug: draft-feature
\`\`\`
`,
    );
    kspec(`plan import "${draftPath}" --module @test-core`, tempDir);

    const draftResult = kspecRun(
      "plan derive @plan-draft-plan --module @test-core --json",
      tempDir,
      { expectFail: true },
    );
    expect(draftResult.exitCode).toBe(5);
    expect(JSON.parse(draftResult.stderr).error).toBe(
      "Plan must be in approved status to derive",
    );

    const approvedPath = await writePlanFile(
      tempDir,
      "already-derived.md",
      `# Already Derived

## Specs

\`\`\`yaml
- title: Already Feature
  slug: already-feature
\`\`\`
`,
    );
    kspec(
      `plan import "${approvedPath}" --module @test-core --status approved`,
      tempDir,
    );
    kspec("plan derive @plan-already-derived --module @test-core", tempDir);

    const activeResult = kspecRun(
      "plan derive @plan-already-derived --json",
      tempDir,
      { expectFail: true },
    );
    expect(activeResult.exitCode).toBe(5);
    expect(JSON.parse(activeResult.stderr).error).toBe(
      "Plan already derived. Manage specs directly via kspec item set.",
    );
  });
});
