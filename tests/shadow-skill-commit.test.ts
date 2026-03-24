/**
 * Regression tests: skill command flows leave shadow branch clean
 *
 * Reproduces the issue where skill import/set/render left pending changes in .kspec/
 * that required a manual git commit/push on kspec-meta.
 *
 * Concrete regression: after skill import/set/render, .kspec had pending changes
 * (skills/<id>/SKILL.md + .render-hash-<platform> files) and required manual commit bcda69ab.
 *
 * AC: @trait-shadow-commit ac-1, ac-8 - mutating commands commit with semantic messages
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { kspec, createTempDir, cleanupTempDir, initGitRepo } from "./helpers/cli.js";
import { SHADOW_WORKTREE_DIR } from "../src/parser/shadow.js";

// Requires git >= 2.42 for --orphan worktree support and built CLI
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

/**
 * Set up a fresh kspec project with shadow branch.
 * Returns the project directory.
 */
async function setupShadowProject(tempDir: string): Promise<void> {
  initGitRepo(tempDir);
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "initial"', {
    cwd: tempDir,
    stdio: "pipe",
  });

  // kspec init --setup creates shadow branch + installs core skills
  const result = kspec("init --no-prompt --setup", tempDir, {
    env: { CLAUDECODE: "1", KSPEC_AUTHOR: "@test" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt --setup failed: ${result.stderr}`);
  }
}

/**
 * Check if the shadow branch worktree has any uncommitted changes.
 * Returns the porcelain status output (empty string = clean).
 */
function getShadowStatus(projectDir: string): string {
  const worktreeDir = path.join(projectDir, SHADOW_WORKTREE_DIR);
  try {
    return execSync("git status --porcelain", {
      cwd: worktreeDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Get the number of commits on the shadow branch.
 */
function getShadowCommitCount(projectDir: string): number {
  const worktreeDir = path.join(projectDir, SHADOW_WORKTREE_DIR);
  try {
    const count = execSync("git rev-list --count HEAD", {
      cwd: worktreeDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return parseInt(count, 10);
  } catch {
    return 0;
  }
}

/**
 * Create a minimal SKILL.md file in a temp directory for import testing.
 */
async function createSkillFile(dir: string, skillId: string): Promise<string> {
  const skillDir = path.join(dir, skillId);
  await fs.mkdir(skillDir, { recursive: true });
  const skillMdPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(
    skillMdPath,
    `---\nname: ${skillId}\ndescription: Test skill for ${skillId}\n---\n\n# ${skillId}\n\nTest skill content.\n`,
    "utf-8",
  );
  return skillMdPath;
}

describe("Shadow auto-commit regression: skill commands", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-shadow-skill-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-shadow-commit ac-1 - skill add commits to shadow branch
  it.skipIf(!canRunShadowTests)(
    "skill add leaves shadow branch clean (no pending changes)",
    async () => {
      await setupShadowProject(tempDir);

      const commitsBefore = getShadowCommitCount(tempDir);

      const result = kspec(
        'skill add --id test-skill --name "Test Skill" --description "A test skill" --origin project',
        tempDir,
      );
      expect(result.exitCode).toBe(0);

      // Shadow branch must be clean — no pending changes
      const status = getShadowStatus(tempDir);
      expect(status).toBe("");

      // A commit must have been created
      const commitsAfter = getShadowCommitCount(tempDir);
      expect(commitsAfter).toBeGreaterThan(commitsBefore);
    },
  );

  // AC: @trait-shadow-commit ac-1 - skill import commits to shadow branch
  it.skipIf(!canRunShadowTests)(
    "skill import leaves shadow branch clean (no pending changes) — regression for bcda69ab",
    async () => {
      await setupShadowProject(tempDir);

      // Create a SKILL.md to import
      const skillMdPath = await createSkillFile(tempDir, "my-imported-skill");

      const commitsBefore = getShadowCommitCount(tempDir);

      const result = kspec(`skill import ${skillMdPath}`, tempDir);
      expect(result.exitCode).toBe(0);

      // Shadow branch must be clean after import
      // Regression: skill import previously left SKILL.md content untracked in shadow branch
      const status = getShadowStatus(tempDir);
      expect(status).toBe("");

      // A commit must have been created
      const commitsAfter = getShadowCommitCount(tempDir);
      expect(commitsAfter).toBeGreaterThan(commitsBefore);
    },
  );

  // AC: @trait-shadow-commit ac-1 - skill set commits to shadow branch
  it.skipIf(!canRunShadowTests)(
    "skill set leaves shadow branch clean (no pending changes)",
    async () => {
      await setupShadowProject(tempDir);

      // First add a skill
      const addResult = kspec(
        'skill add --id settable-skill --name "Settable Skill" --description "A skill to set" --origin project',
        tempDir,
      );
      expect(addResult.exitCode).toBe(0);

      const commitsBefore = getShadowCommitCount(tempDir);

      // Update the skill description
      const result = kspec(
        'skill set @settable-skill --description "Updated description"',
        tempDir,
      );
      expect(result.exitCode).toBe(0);

      // Shadow branch must be clean after set
      const status = getShadowStatus(tempDir);
      expect(status).toBe("");

      // A commit must have been created
      const commitsAfter = getShadowCommitCount(tempDir);
      expect(commitsAfter).toBeGreaterThan(commitsBefore);
    },
  );

  // AC: @trait-shadow-commit ac-1, ac-8 - skill render commits render hashes to shadow branch
  it.skipIf(!canRunShadowTests)(
    "skill render leaves shadow branch clean — regression: render hashes were not committed",
    async () => {
      await setupShadowProject(tempDir);

      // Add a project skill that can be rendered
      const addResult = kspec(
        'skill add --id render-test-skill --name "Render Test Skill" --description "A skill for render testing" --origin project',
        tempDir,
      );
      expect(addResult.exitCode).toBe(0);

      const commitsBefore = getShadowCommitCount(tempDir);

      // Render the skill — this writes SKILL.md to main branch AND .render-hash-* to shadow branch
      // Regression: the render hash files were left uncommitted in shadow branch
      const result = kspec("skill render @render-test-skill", tempDir);
      expect(result.exitCode).toBe(0);

      // Shadow branch must be clean — render hashes must be committed
      const status = getShadowStatus(tempDir);
      expect(status).toBe("");

      // A commit must have been created for the render hash
      const commitsAfter = getShadowCommitCount(tempDir);
      expect(commitsAfter).toBeGreaterThan(commitsBefore);
    },
  );

  // AC: @trait-shadow-commit ac-8 - all-skills render creates single atomic commit
  it.skipIf(!canRunShadowTests)(
    "skill render (all skills) creates single atomic commit covering all render hash changes",
    async () => {
      await setupShadowProject(tempDir);

      // Add two project skills
      const add1 = kspec(
        'skill add --id render-skill-a --name "Render Skill A" --description "First render test skill" --origin project',
        tempDir,
      );
      expect(add1.exitCode).toBe(0);

      const add2 = kspec(
        'skill add --id render-skill-b --name "Render Skill B" --description "Second render test skill" --origin project',
        tempDir,
      );
      expect(add2.exitCode).toBe(0);

      const commitsBefore = getShadowCommitCount(tempDir);

      // Render all skills at once
      const result = kspec("skill render", tempDir);
      expect(result.exitCode).toBe(0);

      // Shadow branch must be clean — all render hashes committed
      const status = getShadowStatus(tempDir);
      expect(status).toBe("");

      // Exactly one commit for the batch render (not one per skill)
      const commitsAfter = getShadowCommitCount(tempDir);
      expect(commitsAfter).toBe(commitsBefore + 1);
    },
  );

  // AC: @trait-shadow-commit ac-1 - skill delete commits to shadow branch
  it.skipIf(!canRunShadowTests)(
    "skill delete leaves shadow branch clean (no pending changes)",
    async () => {
      await setupShadowProject(tempDir);

      // Add a skill to delete
      const addResult = kspec(
        'skill add --id deletable-skill --name "Deletable Skill" --description "A skill to delete" --origin project',
        tempDir,
      );
      expect(addResult.exitCode).toBe(0);

      const commitsBefore = getShadowCommitCount(tempDir);

      const result = kspec("skill delete @deletable-skill --confirm", tempDir);
      expect(result.exitCode).toBe(0);

      // Shadow branch must be clean after delete
      const status = getShadowStatus(tempDir);
      expect(status).toBe("");

      // A commit must have been created
      const commitsAfter = getShadowCommitCount(tempDir);
      expect(commitsAfter).toBeGreaterThan(commitsBefore);
    },
  );
});
