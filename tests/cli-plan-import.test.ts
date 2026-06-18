/**
 * CLI Plan Import Tests
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  downgradeManifestToLegacyStorage,
  initGitRepo,
  kspec as kspecRun,
  kspecJson,
  kspecOutput,
  setupTempFixtures,
} from "./helpers/cli";
import { SHADOW_WORKTREE_DIR } from "../src/parser/shadow.js";

// AC: @trait-shadow-commit ac-2 — N/A: commit message formatting is covered by shared commitIfShadow tests in shadow.test.ts.
// AC: @trait-shadow-commit ac-3 — N/A: commit ref formatting is covered by shared commitIfShadow tests in shadow.test.ts.
// AC: @trait-shadow-commit ac-4 — N/A: shadow-disabled behavior is covered by generic commitIfShadow tests in shadow.test.ts.
// AC: @trait-shadow-commit ac-5 — N/A: save/commit failure behavior is covered by generic commitIfShadow tests in shadow.test.ts.
// AC: @trait-shadow-commit ac-6 — N/A: push fire-and-forget behavior depends on remote shadow setup and is covered in shadow.test.ts.
// AC: @trait-shadow-commit ac-7 — N/A: git commit/push failure handling is covered in shadow.test.ts.
// AC: @trait-dry-run ac-5 — N/A: plan import does not implement a --force flag.
// AC: @trait-json-output ac-6 — N/A: plan import has no competing format flags beyond --json.
// AC: @trait-semantic-exit-codes ac-3 — N/A: plan import has no confirmation prompt path.
// AC: @trait-semantic-exit-codes ac-5 — N/A: plan import is a mutation command, not a query with empty-result semantics.
// AC: @trait-semantic-exit-codes ac-7 — N/A: plan import is no longer a batch partial-success operation.
// AC: @trait-semantic-exit-codes ac-8 — N/A: exit code meanings are documented centrally in src/cli/exit-codes.ts.
const projectCli = path.resolve(__dirname, "..", "dist", "cli", "index.js");
const canRunShadowTests = (() => {
  try {
    const version = execSync("git --version", { encoding: "utf-8" }).trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor] = match.map(Number);
    const gitSupportsOrphan = major > 2 || (major === 2 && minor >= 42);
    return gitSupportsOrphan && existsSync(projectCli);
  } catch {
    return false;
  }
})();

async function setupShadowProject(projectDir: string): Promise<void> {
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "initial"', {
    cwd: projectDir,
    stdio: "pipe",
  });

  const result = kspecRun("init --no-prompt", projectDir, {
    env: { KSPEC_AUTHOR: "@test" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${result.stderr}`);
  }
  // kspec init writes kynetic 1.2 with folder-backed plan/review/resource
  // storage declared. The folder-backed storage managers that make those
  // declarations functional are implemented by sibling tasks under the same
  // plan; until they land, plan/review CRUD only works on a legacy manifest.
  await downgradeManifestToLegacyStorage(projectDir);
}

function getShadowCommitCount(projectDir: string): number {
  const worktreeDir = path.join(projectDir, SHADOW_WORKTREE_DIR);
  return parseInt(
    execSync("git rev-list --count HEAD", {
      cwd: worktreeDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim(),
    10,
  );
}

function getShadowHeadSubject(projectDir: string): string {
  const worktreeDir = path.join(projectDir, SHADOW_WORKTREE_DIR);
  return execSync("git log --format=%s -1", {
    cwd: worktreeDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function getShadowStatus(projectDir: string): string {
  const worktreeDir = path.join(projectDir, SHADOW_WORKTREE_DIR);
  return execSync("git status --porcelain", {
    cwd: worktreeDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

describe("Integration: plan import content-only", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function writePlan(
    filename: string,
    content = `# Test Plan

## Specs

\`\`\`yaml
- title: Feature One
  slug: feature-one
  type: feature
\`\`\`

## Tasks

derive_from_specs: true
`,
  ): Promise<string> {
    const planPath = path.join(tempDir, filename);
    await fs.writeFile(planPath, content);
    return planPath;
  }

  // AC: @plan-import-content-only ac-draft-default
  // AC: @plan-import-content-only ac-module-optional
  // AC: @plan-import-content-only ac-content-only
  // AC: @trait-semantic-exit-codes ac-1
  it("stores the full document as a draft plan without creating specs or tasks", async () => {
    const planPath = await writePlan("test-plan.md");

    const output = kspecOutput(`plan import "${planPath}"`, tempDir);
    expect(output).toContain("Plan: @plan-test-plan");
    expect(output).toContain("Status: draft");
    expect(output).toContain("Content stored: full document");
    expect(output).toContain("Derived specs: 0");
    expect(output).toContain("Derived tasks: 0");

    const plan = kspecJson<{
      status: string;
      content: string;
      derived_specs: string[];
      derived_tasks: string[];
      module_ref: string | null;
      source_path: string;
    }>("plan get @plan-test-plan", tempDir);
    expect(plan.status).toBe("draft");
    expect(plan.content).toContain("## Specs");
    expect(plan.content).toContain("derive_from_specs: true");
    expect(plan.derived_specs).toEqual([]);
    expect(plan.derived_tasks).toEqual([]);
    expect(plan.module_ref).toBeNull();
    expect(plan.source_path).toContain("test-plan.md");

    const tasks = kspecJson<Array<{ plan_ref?: string }>>("task list", tempDir);
    expect(tasks.filter((task) => task.plan_ref === "@plan-test-plan")).toEqual([]);
  });

  // AC: @plan-import-content-only ac-status-override
  it("accepts an explicit plan status during import", async () => {
    const planPath = await writePlan("approved-plan.md");

    kspecOutput(`plan import "${planPath}" --status approved`, tempDir);

    const plan = kspecJson<{ status: string }>("plan get @plan-test-plan", tempDir);
    expect(plan.status).toBe("approved");
  });

  // AC: @plan-import-content-only ac-module-stored
  it("stores the optional module reference on the imported plan", async () => {
    const planPath = await writePlan("module-plan.md");

    kspecOutput(`plan import "${planPath}" --module @test-core`, tempDir);

    const plan = kspecJson<{ module_ref: string | null }>("plan get @plan-test-plan", tempDir);
    expect(plan.module_ref).toBe("@test-core");
  });

  // AC: @plan-import-content-only ac-update-ignored
  it("warns and still imports content-only when --update is passed", async () => {
    const planPath = await writePlan("update-plan.md");

    const result = kspecRun(`plan import "${planPath}" --update`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--update is ignored for content-only import");

    const plan = kspecJson<{ derived_specs: string[]; derived_tasks: string[] }>(
      "plan get @plan-test-plan",
      tempDir,
    );
    expect(plan.derived_specs).toEqual([]);
    expect(plan.derived_tasks).toEqual([]);
  });

  // AC: @trait-dry-run ac-1
  // AC: @trait-dry-run ac-2
  // AC: @trait-dry-run ac-3
  // AC: @trait-dry-run ac-6
  // AC: @trait-json-output ac-1
  // AC: @trait-json-output ac-2
  // AC: @trait-json-output ac-4
  // AC: @trait-json-output ac-5
  it("supports dry-run previews in JSON mode without modifying state", async () => {
    const planPath = await writePlan("dry-run-plan.md");

    const preview = kspecJson<{
      dry_run: boolean;
      plan_ref: string;
      title: string;
      status: string;
      module_ref: string | null;
      source_path: string;
      created_at: string | null;
      derived_specs: string[];
      derived_tasks: string[];
      content: string;
    }>(`plan import "${planPath}" --module @test-core --dry-run`, tempDir);

    expect(preview.dry_run).toBe(true);
    expect(preview.plan_ref).toBe("@plan-test-plan");
    expect(preview.title).toBe("Test Plan");
    expect(preview.status).toBe("draft");
    expect(preview.module_ref).toBe("@test-core");
    expect(preview.source_path).toContain("dry-run-plan.md");
    expect(preview.created_at).toBeNull();
    expect(preview.derived_specs).toEqual([]);
    expect(preview.derived_tasks).toEqual([]);
    expect(preview.content).toContain("## Specs");

    const plans = kspecJson<Array<{ slugs: string[] }>>("plan list", tempDir);
    expect(plans.some((plan) => plan.slugs.includes("plan-test-plan"))).toBe(false);
  });

  // AC: @trait-semantic-exit-codes ac-6
  // Commander rejects unknown flags before the command action runs.
  it("returns a usage-style error for invalid flags", async () => {
    const planPath = await writePlan("invalid-flags-plan.md");

    const result = kspecRun(`plan import "${planPath}" --bogus-flag`, tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown option '--bogus-flag'");
  });

  // AC: @trait-dry-run ac-4
  // AC: @trait-json-output ac-3
  // AC: @trait-semantic-exit-codes ac-2
  it("returns a JSON usage error when the source file cannot be read", () => {
    const missingPath = path.join(tempDir, "missing-plan.md");

    const result = kspecRun(`plan import "${missingPath}" --json`, tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      success: false,
      error: `Failed to read plan file: ${missingPath}`,
    });
  });
});

describe("Integration: plan import into existing plan", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function writePlan(filename: string, content: string): Promise<string> {
    const planPath = path.join(tempDir, filename);
    await fs.writeFile(planPath, content);
    return planPath;
  }

  // AC: @plan-import-into ac-into-draft
  // AC: @plan-import-into ac-into-no-module
  // AC: @plan-import-into ac-into-reason-optional
  it("updates a draft plan title and content in place and appends the default note", async () => {
    kspecOutput('plan add --title "Existing Plan" --content "Original content"', tempDir);
    const editedPath = await writePlan(
      "edited-plan.md",
      `# Revised Plan

Updated body.
`,
    );

    const output = kspecOutput(`plan import "${editedPath}" --into @plan-existing-plan`, tempDir);

    expect(output).toContain("Plan: @plan-existing-plan");
    expect(output).toContain("Title: Revised Plan");
    expect(output).toContain("Changes: title, content");
    expect(output).toContain("Note: Content updated from file");

    const plan = kspecJson<{
      title: string;
      content: string;
      status: string;
      source_path: string | null;
      module_ref: string | null;
      notes: Array<{ content: string }>;
    }>("plan get @plan-existing-plan", tempDir);

    expect(plan.title).toBe("Revised Plan");
    expect(plan.content).toBe(`# Revised Plan

Updated body.
`);
    expect(plan.status).toBe("draft");
    expect(plan.source_path).toBeNull();
    expect(plan.module_ref).toBeNull();
    expect(plan.notes.at(-1)?.content).toBe("Content updated from file");
  });

  // AC: @plan-import-into ac-into-no-title
  // AC: @plan-import-into ac-into-approved
  // AC: @plan-import-into ac-into-content-only
  // AC: @plan-import-into ac-into-reason
  // AC: @trait-semantic-exit-codes ac-1
  it("preserves title without an H1, keeps approved status, and does not derive work", async () => {
    kspecOutput('plan add --title "Approved Plan" --content "Original content"', tempDir);
    kspecOutput("plan set @plan-approved-plan --status approved", tempDir);
    const editedPath = await writePlan(
      "approved-edit.md",
      `Updated body without heading.

## Specs

\`\`\`yaml
- title: Should Not Materialize
  slug: should-not-materialize
  type: feature
\`\`\`

## Tasks

derive_from_specs: true
`,
    );

    kspecOutput(
      `plan import "${editedPath}" --into @plan-approved-plan --reason "Removed obsolete section"`,
      tempDir,
    );

    const plan = kspecJson<{
      title: string;
      content: string;
      status: string;
      derived_specs: string[];
      derived_tasks: string[];
      notes: Array<{ content: string }>;
    }>("plan get @plan-approved-plan", tempDir);

    expect(plan.title).toBe("Approved Plan");
    expect(plan.status).toBe("approved");
    expect(plan.content).toContain("Should Not Materialize");
    expect(plan.derived_specs).toEqual([]);
    expect(plan.derived_tasks).toEqual([]);
    expect(plan.notes.at(-1)?.content).toBe("Removed obsolete section");

    const tasks = kspecJson<Array<{ plan_ref?: string }>>("task list", tempDir);
    expect(tasks.filter((task) => task.plan_ref === "@plan-approved-plan")).toEqual([]);
  });

  // AC: @plan-import-into ac-into-ignores-module
  // AC: @plan-import-into ac-into-ignores-update
  // AC: @plan-import-into ac-into-ignores-status
  it("warns and ignores module, update, and status flags when --into is used", async () => {
    kspecOutput('plan add --title "Ignored Flags Plan" --content "Original content"', tempDir);
    const editedPath = await writePlan(
      "ignored-flags.md",
      `# Ignored Flags Plan Updated

Edited content.
`,
    );

    const result = kspecRun(
      `plan import "${editedPath}" --into @plan-ignored-flags-plan --module @missing-module --update --status approved`,
      tempDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--module is ignored with --into");
    expect(result.stderr).toContain("--update is ignored with --into");
    expect(result.stderr).toContain("--status is ignored with --into");

    const plan = kspecJson<{ title: string; status: string; module_ref: string | null }>(
      "plan get @plan-ignored-flags-plan",
      tempDir,
    );
    expect(plan.title).toBe("Ignored Flags Plan Updated");
    expect(plan.status).toBe("draft");
    expect(plan.module_ref).toBeNull();
  });

  // AC: @plan-import-into ac-into-dry-run
  // AC: @trait-dry-run ac-1
  // AC: @trait-dry-run ac-2
  // AC: @trait-dry-run ac-3
  // AC: @trait-dry-run ac-6
  it("previews an in-place update without modifying the existing plan", async () => {
    kspecOutput('plan add --title "Dry Run Plan" --content "Original content"', tempDir);
    const editedPath = await writePlan(
      "dry-run-edit.md",
      `# Dry Run Plan Updated

Edited content.
`,
    );

    const preview = kspecJson<{
      dry_run: boolean;
      plan_ref: string;
      title: string;
      status: string;
      changes: string[];
      note_message: string;
      content: string;
      created_at: string | null;
    }>(`plan import "${editedPath}" --into @plan-dry-run-plan --dry-run`, tempDir);

    expect(preview.dry_run).toBe(true);
    expect(preview.plan_ref).toBe("@plan-dry-run-plan");
    expect(preview.title).toBe("Dry Run Plan Updated");
    expect(preview.status).toBe("draft");
    expect(preview.changes).toEqual(["title", "content"]);
    expect(preview.note_message).toBe("Content updated from file");
    expect(preview.content).toContain("Edited content.");
    expect(preview.created_at).toBeNull();

    const plan = kspecJson<{ title: string; content: string; notes: Array<{ content: string }> }>(
      "plan get @plan-dry-run-plan",
      tempDir,
    );
    expect(plan.title).toBe("Dry Run Plan");
    expect(plan.content).toBe("Original content");
    expect(plan.notes).toEqual([]);
  });

  it.runIf(canRunShadowTests)(
    "creates clean shadow-branch commits when --into succeeds and mints a revision",
    async () => {
      // AC: @plan-import-into ac-into-commit
      // AC: @plan-revisions ac-import-mints-revision
      // AC: @trait-shadow-commit ac-1, ac-8
      const shadowDir = await createTempDir("kspec-plan-import-into-shadow-");

      try {
        await setupShadowProject(shadowDir);
        kspecOutput('plan add --title "Shadow Plan" --content "Original content"', shadowDir);

        const editedPath = path.join(shadowDir, "shadow-edit.md");
        await fs.writeFile(
          editedPath,
          `# Shadow Plan Updated

Updated body.
`,
        );

        const commitsBefore = getShadowCommitCount(shadowDir);
        kspecOutput(`plan import "${editedPath}" --into @plan-shadow-plan`, shadowDir);
        const commitsAfter = getShadowCommitCount(shadowDir);

        expect(commitsAfter).toBe(commitsBefore + 2);
        expect(getShadowStatus(shadowDir)).toBe("");
        expect(getShadowHeadSubject(shadowDir)).toBe("Update Plan: @plan-shadow-plan - revision 1");

        const plan = kspecJson<{
          revisions: Array<{ ordinal: number; note: string; shadow_commit: string }>;
        }>("plan get @plan-shadow-plan", shadowDir);
        expect(plan.revisions).toHaveLength(1);
        expect(plan.revisions[0]).toMatchObject({
          ordinal: 1,
          note: "Content updated from file",
        });
        expect(plan.revisions[0].shadow_commit).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        await cleanupTempDir(shadowDir);
      }
    },
  );

  // AC: @plan-import-into ac-into-active
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-4
  it("rejects updates to active plans with a conflict exit code", async () => {
    kspecOutput('plan add --title "Active Plan" --content "Original content"', tempDir);
    kspecOutput("plan set @plan-active-plan --status active", tempDir);
    const editedPath = await writePlan("active-edit.md", "# Active Plan Updated\n");

    const result = kspecRun(`plan import "${editedPath}" --into @plan-active-plan`, tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("Cannot update active plan. Derive is a one-shot operation.");
    expect(result.stderr).toContain("Suggestion:");
  });

  // AC: @trait-error-guidance ac-3
  // AC: @trait-error-guidance ac-6
  it("includes actionable guidance when the target plan ref does not resolve", async () => {
    const editedPath = await writePlan("missing-target.md", "# Missing Target\n");

    const textResult = kspecRun(
      `plan import "${editedPath}" --into @plan-does-not-exist`,
      tempDir,
      { expectFail: true },
    );

    expect(textResult.exitCode).toBe(3);
    expect(textResult.stderr).toContain("Plan not found: @plan-does-not-exist");
    expect(textResult.stderr).toContain("Suggestion: Check available plans with: kspec plan list");

    const jsonResult = kspecRun(
      `plan import "${editedPath}" --into @plan-does-not-exist --json`,
      tempDir,
      { expectFail: true },
    );

    expect(jsonResult.exitCode).toBe(3);
    expect(JSON.parse(jsonResult.stderr)).toMatchObject({
      success: false,
      error: "Plan not found: @plan-does-not-exist",
      details: {
        ref: "@plan-does-not-exist",
        entity: "plan",
        suggestion: "Check available plans with: kspec plan list",
        guidance: "Check available plans with: kspec plan list",
      },
    });
  });

  // AC: @plan-import-into ac-into-terminal
  it("rejects updates to terminal plans with a conflict exit code", async () => {
    kspecOutput('plan add --title "Completed Plan" --content "Original content"', tempDir);
    kspecOutput("plan set @plan-completed-plan --status completed", tempDir);
    const editedPath = await writePlan("completed-edit.md", "# Completed Plan Updated\n");

    const result = kspecRun(`plan import "${editedPath}" --into @plan-completed-plan`, tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("Cannot update plan in terminal status");
  });

  // AC: @plan-import-into ac-into-file-not-found
  // AC: @trait-dry-run ac-4
  // AC: @trait-semantic-exit-codes ac-2
  // AC: @trait-error-guidance ac-6
  it("returns a JSON usage error when an --into source file is missing", () => {
    kspecOutput('plan add --title "Missing Source Plan" --content "Original content"', tempDir);
    const missingPath = path.join(tempDir, "missing-into-plan.md");

    const result = kspecRun(
      `plan import "${missingPath}" --into @plan-missing-source-plan --json`,
      tempDir,
      { expectFail: true },
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      success: false,
      error: `Failed to read plan file: ${missingPath}`,
    });
  });

  // AC: @plan-import-format-guidance ac-ac-shape-mismatch-fails-import
  it("rejects --into re-import when document has malformed acceptance criteria", async () => {
    kspecOutput('plan add --title "AC Shape Plan" --content "Original content"', tempDir);
    const editedPath = await writePlan(
      "bad-ac-into.md",
      `# AC Shape Plan Updated

## Specs

\`\`\`yaml
- title: Feature With Bad AC
  slug: feature-bad-ac
  acceptance_criteria:
    - id: ac-incomplete
      given: a precondition
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${editedPath}" --into @plan-ac-shape-plan`, tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("feature-bad-ac");
    expect(result.stderr).toContain("ac-incomplete");
  });

  // AC: @plan-import-format-guidance ac-empty-plan-import-warns
  it("emits empty-plan warning when --into re-import has no derivable content", async () => {
    kspecOutput('plan add --title "Empty Into Plan" --content "Original content"', tempDir);
    const editedPath = await writePlan(
      "empty-into.md",
      `# Empty Into Plan Updated

Just prose, no specs or tasks.
`,
    );

    const result = kspecRun(`plan import "${editedPath}" --into @plan-empty-into-plan`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("no derivable content");
    expect(result.stderr).toContain("## Specs");
    expect(result.stderr).toContain("## Tasks");
  });
});

// AC: @plan-import-format-guidance ac-missing-title-fails-import — Plan import format error guidance tests
describe("Integration: plan import format guidance", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function writePlan(filename: string, content: string): Promise<string> {
    const planPath = path.join(tempDir, filename);
    await fs.writeFile(planPath, content);
    return planPath;
  }

  // AC: @plan-import-format-guidance ac-missing-title-fails-import
  // AC: @trait-semantic-exit-codes ac-2
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("fails import when document has no top-level heading", async () => {
    const planPath = await writePlan(
      "no-title.md",
      `## Not a top-level heading

Some content without a # Title.
`,
    );

    const result = kspecRun(`plan import "${planPath}"`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("top-level heading");
    expect(result.stderr).toContain("# ");
    expect(result.stderr).toContain("Example:");
  });

  // AC: @plan-import-format-guidance ac-missing-title-fails-import
  it("fails import when document has a heading but not as the first significant element", async () => {
    const planPath = await writePlan(
      "late-title.md",
      `Some prose before the heading.

# Late Title

## Specs

\`\`\`yaml
- title: Feature A
  slug: feature-a
  type: feature
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}"`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("top-level heading");
    expect(result.stderr).toContain("first significant element");
  });

  // AC: @plan-import-format-guidance ac-missing-title-fails-import
  // AC: @plan-import-format-guidance ac-error-no-external-references
  it("title error message is self-contained without external references", async () => {
    const planPath = await writePlan(
      "no-title-self-contained.md",
      `Just text, no heading at all.
`,
    );

    const result = kspecRun(`plan import "${planPath}"`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2);
    const stderr = result.stderr;
    // The error should explain the expected format without referencing external files
    expect(stderr).toContain("top-level heading");
    expect(stderr).not.toMatch(/README|docs\/|skills\//);
    expect(stderr).not.toMatch(/source code/i);
  });

  // AC: @plan-import-format-guidance ac-missing-title-fails-import
  // AC: @trait-error-guidance ac-6
  // AC: @trait-json-output ac-3
  it("returns a structured JSON error for missing title", async () => {
    const planPath = await writePlan(
      "no-title-json.md",
      `Some content without a heading.
`,
    );

    const result = kspecRun(`plan import "${planPath}" --json`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("top-level heading");
  });

  // AC: @plan-import-format-guidance ac-empty-plan-import-warns
  // AC: @trait-semantic-exit-codes ac-1
  it("imports an empty plan with a warning when title is valid but no specs or tasks", async () => {
    const planPath = await writePlan(
      "empty-plan.md",
      `# My Empty Plan

Just prose, no structured sections yet.
`,
    );

    const result = kspecRun(`plan import "${planPath}"`, tempDir);

    expect(result.exitCode).toBe(0);
    // Warning should appear on stderr
    expect(result.stderr).toContain("no derivable content");
    expect(result.stderr).toContain("## Specs");
    expect(result.stderr).toContain("## Tasks");
    expect(result.stderr).toContain("kspec plan derive");

    // Plan should be stored
    const plan = kspecJson<{ title: string; status: string }>(
      "plan get @plan-my-empty-plan",
      tempDir,
    );
    expect(plan.title).toBe("My Empty Plan");
    expect(plan.status).toBe("draft");
  });

  // AC: @plan-import-format-guidance ac-empty-plan-import-warns
  // AC: @trait-json-output ac-2
  it("includes warnings in JSON output for empty plan import", async () => {
    const planPath = await writePlan(
      "empty-plan-json.md",
      `# My Empty JSON Plan

Just prose.
`,
    );

    const result = kspecRun(`plan import "${planPath}" --json`, tempDir);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.title).toBe("My Empty JSON Plan");
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0]).toContain("no derivable content");
    expect(parsed.warnings[0]).toContain("## Specs");
    expect(parsed.warnings[0]).toContain("## Tasks");
  });

  // AC: @plan-import-format-guidance ac-empty-plan-import-warns
  // AC: @plan-import-format-guidance ac-error-no-external-references
  it("empty plan warning is self-contained without external references", async () => {
    const planPath = await writePlan(
      "empty-self-contained.md",
      `# Empty But Self Contained

Just a plan title and prose.
`,
    );

    const result = kspecRun(`plan import "${planPath}"`, tempDir);

    expect(result.exitCode).toBe(0);
    const stderr = result.stderr;
    expect(stderr).not.toMatch(/README|docs\/|skills\//);
    expect(stderr).not.toMatch(/source code/i);
  });

  // AC: @plan-import-format-guidance ac-ac-shape-mismatch-fails-import
  // AC: @plan-import-format-guidance ac-ac-shape-mismatch-describes-shape
  // AC: @trait-semantic-exit-codes ac-2
  it("fails import when acceptance criterion is missing required fields", async () => {
    const planPath = await writePlan(
      "bad-ac.md",
      `# Plan With Bad AC

## Specs

\`\`\`yaml
- title: My Feature
  slug: my-feature
  acceptance_criteria:
    - id: ac-bad
      given: a precondition
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}"`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2);
    // Should identify the spec and AC
    expect(result.stderr).toContain("my-feature");
    expect(result.stderr).toContain("ac-bad");
    // Should describe the required fields
    expect(result.stderr).toContain("id");
    expect(result.stderr).toContain("given");
    expect(result.stderr).toContain("when");
    expect(result.stderr).toContain("then");
  });

  // AC: @plan-import-format-guidance ac-ac-shape-mismatch-fails-import
  it("locates malformed AC by spec slug and position when AC has no id", async () => {
    const planPath = await writePlan(
      "bad-ac-no-id.md",
      `# Plan With Malformed AC

## Specs

\`\`\`yaml
- title: Feature Two
  slug: feature-two
  acceptance_criteria:
    - given: a precondition
      when: an action
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}"`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2);
    // Should locate by spec slug and AC index
    expect(result.stderr).toContain("feature-two");
    expect(result.stderr).toContain("index 0");
  });

  // AC: @plan-import-format-guidance ac-ac-shape-mismatch-describes-shape
  // AC: @plan-import-format-guidance ac-error-no-external-references
  it("AC shape error describes all required fields without external references", async () => {
    const planPath = await writePlan(
      "bad-ac-self-contained.md",
      `# Plan AC Self Contained

## Specs

\`\`\`yaml
- title: Feature Three
  slug: feature-three
  acceptance_criteria:
    - description: not the right shape
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}"`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2);
    const stderr = result.stderr;
    // Describes each required field with its purpose
    expect(stderr).toContain("id");
    expect(stderr).toContain("identifier");
    expect(stderr).toContain("given");
    expect(stderr).toContain("precondition");
    expect(stderr).toContain("when");
    expect(stderr).toContain("action");
    expect(stderr).toContain("then");
    expect(stderr).toContain("expected outcome");
    // Self-contained
    expect(stderr).not.toMatch(/README|docs\/|skills\//);
    expect(stderr).not.toMatch(/source code/i);
  });

  // AC: @plan-import-format-guidance ac-help-describes-format
  it("help output includes a minimal runnable example and names required elements", () => {
    const result = kspecRun("plan import --help", tempDir);

    const stdout = result.stdout;
    // Must include a runnable example
    expect(stdout).toContain("# My Plan Title");
    expect(stdout).toContain("## Specs");
    expect(stdout).toContain("## Tasks");
    expect(stdout).toContain("derive_from_specs: true");
    // Must name required structural elements
    expect(stdout).toContain("acceptance_criteria");
    expect(stdout).toContain("id");
    expect(stdout).toContain("given");
    expect(stdout).toContain("when");
    expect(stdout).toContain("then");
  });

  // AC: @plan-import-format-guidance ac-missing-title-fails-import (dry-run parity)
  it("dry-run produces the same title error as a real import", async () => {
    const planPath = await writePlan(
      "no-title-dry.md",
      `No heading here.
`,
    );

    const dryResult = kspecRun(`plan import "${planPath}" --dry-run`, tempDir, {
      expectFail: true,
    });
    const realResult = kspecRun(`plan import "${planPath}"`, tempDir, { expectFail: true });

    expect(dryResult.exitCode).toBe(realResult.exitCode);
    // Both should produce the same structural error
    expect(dryResult.stderr).toContain("top-level heading");
    expect(realResult.stderr).toContain("top-level heading");
  });

  // AC: @plan-import-format-guidance ac-empty-plan-import-warns (dry-run parity)
  it("dry-run produces the same empty-plan warning as a real import", async () => {
    const planPath = await writePlan(
      "empty-plan-dry.md",
      `# Empty Plan Dry Run

Prose only.
`,
    );

    const dryResult = kspecRun(`plan import "${planPath}" --dry-run`, tempDir);
    const realResult = kspecRun(`plan import "${planPath}"`, tempDir);

    expect(dryResult.exitCode).toBe(0);
    expect(realResult.exitCode).toBe(0);
    // Both should produce the same warning
    expect(dryResult.stderr).toContain("no derivable content");
    expect(realResult.stderr).toContain("no derivable content");
  });

  // AC: @plan-import-format-guidance ac-ac-shape-mismatch-fails-import (dry-run parity)
  it("dry-run produces the same AC shape error as a real import", async () => {
    const planPath = await writePlan(
      "bad-ac-dry.md",
      `# Bad AC Dry Run

## Specs

\`\`\`yaml
- title: Feature Dry
  slug: feature-dry
  acceptance_criteria:
    - id: ac-incomplete
\`\`\`
`,
    );

    const dryResult = kspecRun(`plan import "${planPath}" --dry-run`, tempDir, {
      expectFail: true,
    });
    const realResult = kspecRun(`plan import "${planPath}"`, tempDir, { expectFail: true });

    expect(dryResult.exitCode).toBe(realResult.exitCode);
    expect(dryResult.stderr).toContain("feature-dry");
    expect(realResult.stderr).toContain("feature-dry");
  });

  // AC: @trait-error-guidance ac-5 — validation error indicates which field failed
  it("AC shape error identifies which specific fields are missing", async () => {
    const planPath = await writePlan(
      "ac-missing-when-then.md",
      `# AC Missing When Then

## Specs

\`\`\`yaml
- title: Feature Fields
  slug: feature-fields
  acceptance_criteria:
    - id: ac-partial
      given: |
        a precondition
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}"`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ac-partial");
    expect(result.stderr).toContain("feature-fields");
    // Should enumerate the required shape
    expect(result.stderr).toContain("when");
    expect(result.stderr).toContain("then");
  });

  // AC: @trait-json-output ac-1 — valid JSON with no ANSI in structured mode
  it("AC shape error in JSON mode produces valid JSON without ANSI codes", async () => {
    const planPath = await writePlan(
      "bad-ac-json.md",
      `# Bad AC JSON

## Specs

\`\`\`yaml
- title: JSON Feature
  slug: json-feature
  acceptance_criteria:
    - id: ac-json-bad
      given: a precondition
\`\`\`
`,
    );

    const result = kspecRun(`plan import "${planPath}" --json`, tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("json-feature");
    expect(parsed.error).toContain("ac-json-bad");
    // No ANSI codes in JSON output
    // oxlint-disable-next-line no-control-regex -- asserting absence of ANSI escape char in JSON output
    expect(parsed.error).not.toMatch(/\u001b/);
  });
});
