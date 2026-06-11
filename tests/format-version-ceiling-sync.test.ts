/**
 * Format version ceiling — post-sync re-check.
 *
 * A project whose LOCAL shadow manifest declares a supported format version
 * passes the pre-sync ceiling check, but the pre-read sync pull performed by
 * context initialization can import a manifest upgraded remotely to a newer
 * format. The SAME invocation must refuse with the deterministic
 * newer-than-supported code after the pull and before any entity read or
 * mutation — refusal is not deferred to a subsequent invocation.
 *
 * Dual fixture: local shadow worktree on a supported version, bare remote
 * whose kspec-meta branch carries a kynetic "9.9" manifest.
 *
 * Spec: @data-format-forward-compatibility
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import {
  kspec,
  createTempDir,
  cleanupTempDir,
  findManifestFileInDir,
  initGitRepo,
  readTestOutput,
} from "./helpers/cli.js";
import {
  FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE,
  MAX_SUPPORTED_KYNETIC_VERSION,
} from "../src/parser/format-version.js";

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
}

// Requires git >= 2.42 for --orphan worktree support and the built CLI
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

describe.skipIf(!canRunShadowTests)("format version ceiling — post-sync re-check", () => {
  let baseDir: string;
  let projectDir: string;
  let bareDir: string;
  let cloneDir: string;

  beforeAll(async () => {
    baseDir = await createTempDir();

    // 1. Real kspec project with a shadow worktree (supported format version)
    projectDir = path.join(baseDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    initGitRepo(projectDir);
    await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
    execSync('git add README.md && git commit -m "initial"', { cwd: projectDir, stdio: "pipe" });
    const init = kspec("init --no-prompt", projectDir, { env: { KSPEC_AUTHOR: "@test" } });
    if (init.exitCode !== 0) {
      throw new Error(`kspec init failed: ${init.stderr}`);
    }

    // 2. Bare remote with the shadow branch tracked
    bareDir = path.join(baseDir, "remote.git");
    await fs.mkdir(bareDir, { recursive: true });
    execSync("git init --bare", { cwd: bareDir, stdio: "pipe" });
    git(projectDir, `remote add origin "${bareDir}"`);
    const shadowDir = path.join(projectDir, ".kspec");
    git(shadowDir, "push -u origin kspec-meta");

    // 3. Second clone simulates a NEWER kspec upgrading the project remotely
    cloneDir = path.join(baseDir, "clone");
    execSync(`git clone --branch kspec-meta "${bareDir}" "${cloneDir}"`, { stdio: "pipe" });
    git(cloneDir, 'config user.email "test@test.com"');
    git(cloneDir, 'config user.name "Test"');
    const cloneManifest = await findManifestFileInDir(cloneDir);
    if (!cloneManifest) {
      throw new Error("no manifest found in kspec-meta clone");
    }
    // Test-generated clone manifest, rewritten to simulate a future format
    const raw = await readTestOutput(cloneManifest);
    await fs.writeFile(cloneManifest, raw.replace(/^kynetic:.*$/m, 'kynetic: "9.9"'), "utf-8");
    git(cloneDir, `add "${path.basename(cloneManifest)}"`);
    git(cloneDir, 'commit -m "upgrade to future format"');
    git(cloneDir, "push origin kspec-meta");
  }, 120_000);

  afterAll(async () => {
    await cleanupTempDir(baseDir);
  });

  // AC: @data-format-forward-compatibility ac-post-sync-newer-version-refused
  it("the invocation that pulls a newer-format manifest refuses after the pull", async () => {
    const shadowDir = path.join(projectDir, ".kspec");
    const manifestPath = (await findManifestFileInDir(shadowDir))!;
    expect(manifestPath).toBeTruthy();

    // Sanity: local manifest still declares a supported version, so the
    // pre-sync ceiling check passes and the sync pull is permitted.
    const localBefore = await readTestOutput(manifestPath);
    expect(localBefore).toContain(`kynetic: "${MAX_SUPPORTED_KYNETIC_VERSION}"`);

    // Capture the tasks file content to prove no entity mutation occurs.
    const tasksPath = path.join(shadowDir, "project.tasks.yaml");
    const tasksBefore = existsSync(tasksPath) ? await readTestOutput(tasksPath) : null;

    const result = kspec("task list", projectDir, { expectFail: true });

    // Same invocation refuses with the deterministic code, naming both
    // versions with upgrade guidance — not deferred to a later invocation.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
    expect(result.stderr).toContain('"9.9"');
    expect(result.stderr).toContain(`"${MAX_SUPPORTED_KYNETIC_VERSION}"`);
    expect(result.stderr).toMatch(/upgrade/i);

    // The sync itself was permitted: the pull imported the remote manifest.
    const localAfter = await readTestOutput(manifestPath);
    expect(localAfter).toContain('kynetic: "9.9"');

    // The shadow worktree matches the pulled remote head exactly — the
    // invocation imported data authored elsewhere but mutated nothing.
    expect(git(shadowDir, "status --porcelain")).toBe("");
    expect(git(shadowDir, "rev-parse HEAD")).toBe(git(cloneDir, "rev-parse HEAD"));
    const tasksAfter = existsSync(tasksPath) ? await readTestOutput(tasksPath) : null;
    expect(tasksAfter).toBe(tasksBefore);
  }, 60_000);

  // AC: @data-format-forward-compatibility ac-newer-version-refused
  it("subsequent invocations refuse on the now-local newer manifest before any sync", async () => {
    const result = kspec("task list", projectDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
  });
});
