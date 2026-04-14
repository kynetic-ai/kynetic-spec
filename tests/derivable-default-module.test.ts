/**
 * Tests for derivable default module.
 *
 * Verifies that `kspec init` creates a real module item that is
 * resolvable by reference and accepted by plan derive.
 *
 * AC: @derivable-default-module ac-default-module-resolvable
 * AC: @derivable-default-module ac-plan-derive-accepts-default
 * AC: @derivable-default-module ac-default-module-editable
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec as kspecRun,
  kspecJson,
  kspecOutput as kspec,
} from "./helpers/cli";

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

async function setupFreshProject(projectDir: string): Promise<void> {
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
}

function writePlanFile(tempDir: string, name: string, content: string): Promise<string> {
  const planPath = path.join(tempDir, name);
  return fs.writeFile(planPath, content).then(() => planPath);
}

describe.skipIf(!canRunShadowTests)("Derivable default module", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempDir("kspec-default-module-");
  });

  afterEach(async () => {
    await cleanupTempDir(projectDir);
  });

  // AC: @derivable-default-module ac-default-module-resolvable
  it("creates a resolvable module item on init", async () => {
    await setupFreshProject(projectDir);

    // The default module should be queryable by slug @main
    const result = kspecJson<{
      ulid: string;
      slugs: string[];
      title: string;
      type: string;
      description: string;
    }>("item get @main", projectDir);

    expect(result.ulid).toBeTruthy();
    expect(result.slugs).toContain("main");
    expect(result.title).toBeTruthy();
    expect(result.type).toBe("module");
    expect(result.description).toBeTruthy();
  });

  // AC: @derivable-default-module ac-default-module-resolvable
  it("lists the default module via item list --type module", async () => {
    await setupFreshProject(projectDir);

    const result = kspecJson<{
      items: Array<{ slugs: string[]; type: string }>;
      total: number;
    }>("item list --type module", projectDir);

    expect(result.total).toBeGreaterThanOrEqual(1);
    const mainModule = result.items.find((item) => item.slugs.includes("main"));
    expect(mainModule).toBeDefined();
    expect(mainModule!.type).toBe("module");
  });

  // AC: @derivable-default-module ac-plan-derive-accepts-default
  it("derives plan specs targeting the default module without explicit module creation", async () => {
    await setupFreshProject(projectDir);

    const planPath = await writePlanFile(
      projectDir,
      "test-plan.md",
      `# Test Plan

## Specs

\`\`\`yaml
- title: Test Feature
  slug: test-feature
  type: feature
\`\`\`
`,
    );

    // Import plan targeting the default module @main
    kspec(
      `plan import "${planPath}" --module @main --status approved`,
      projectDir,
    );

    // Derive should succeed without needing a separate module add
    const result = kspecJson<{
      module_ref: string;
      created_specs: string[];
      errors: Array<{ message: string }>;
    }>("plan derive @plan-test-plan --module @main", projectDir);

    expect(result.module_ref).toBe("@main");
    expect(result.created_specs).toContain("@test-feature");
    expect(result.errors).toEqual([]);

    // Verify the feature was created
    const feature = kspecJson<{
      ulid: string;
      title: string;
      type: string;
    }>("item get @test-feature", projectDir);
    expect(feature.title).toBe("Test Feature");
    expect(feature.type).toBe("feature");
  });

  // AC: @derivable-default-module ac-default-module-editable
  it("persists title changes and subsequent derive continues to work", async () => {
    await setupFreshProject(projectDir);

    // Edit the default module title
    kspec('item set @main --title "My Custom Module"', projectDir);

    // Verify the title change persisted
    const updatedModule = kspecJson<{
      title: string;
      slugs: string[];
      type: string;
    }>("item get @main", projectDir);
    expect(updatedModule.title).toBe("My Custom Module");
    expect(updatedModule.type).toBe("module");

    // Derive still works with the edited module
    const planPath = await writePlanFile(
      projectDir,
      "post-edit-plan.md",
      `# Post Edit Plan

## Specs

\`\`\`yaml
- title: Another Feature
  slug: another-feature
  type: feature
\`\`\`
`,
    );

    kspec(
      `plan import "${planPath}" --module @main --status approved`,
      projectDir,
    );

    const result = kspecJson<{
      module_ref: string;
      created_specs: string[];
      errors: Array<{ message: string }>;
    }>("plan derive @plan-post-edit-plan --module @main", projectDir);

    expect(result.module_ref).toBe("@main");
    expect(result.created_specs).toContain("@another-feature");
    expect(result.errors).toEqual([]);
  });

  // AC: @derivable-default-module ac-default-module-editable
  it("persists slug addition and derive targets the new slug", async () => {
    await setupFreshProject(projectDir);

    // Add a new slug to the default module
    kspec("item set @main --slug custom-module", projectDir);

    // Should be reachable by both old and new slugs
    const byOldSlug = kspecJson<{
      slugs: string[];
      type: string;
    }>("item get @main", projectDir);
    expect(byOldSlug.slugs).toContain("main");
    expect(byOldSlug.slugs).toContain("custom-module");

    const byNewSlug = kspecJson<{
      slugs: string[];
      type: string;
    }>("item get @custom-module", projectDir);
    expect(byNewSlug.slugs).toContain("custom-module");
    expect(byNewSlug.type).toBe("module");

    // Derive with the new slug works
    const planPath = await writePlanFile(
      projectDir,
      "slug-change-plan.md",
      `# Slug Change Plan

## Specs

\`\`\`yaml
- title: Slug Test Feature
  slug: slug-test-feature
  type: feature
\`\`\`
`,
    );

    kspec(
      `plan import "${planPath}" --module @custom-module --status approved`,
      projectDir,
    );

    const result = kspecJson<{
      module_ref: string;
      created_specs: string[];
      errors: Array<{ message: string }>;
    }>("plan derive @plan-slug-change-plan --module @custom-module", projectDir);

    expect(result.module_ref).toBe("@custom-module");
    expect(result.created_specs).toContain("@slug-test-feature");
    expect(result.errors).toEqual([]);
  });

  // AC: @derivable-default-module ac-default-module-editable
  it("persists description changes", async () => {
    await setupFreshProject(projectDir);

    kspec(
      'item set @main --description "Updated description for the main module"',
      projectDir,
    );

    const updatedModule = kspecJson<{
      description: string;
      type: string;
    }>("item get @main", projectDir);
    expect(updatedModule.description).toContain("Updated description");
    expect(updatedModule.type).toBe("module");
  });
});
