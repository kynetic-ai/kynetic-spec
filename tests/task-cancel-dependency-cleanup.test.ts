import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  initGitRepo,
  kspecJson,
  kspecOutput as kspec,
  setupTempFixtures,
} from "./helpers/cli";

describe("Integration: task cancel dependency cleanup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cancelled-task-dependency-cleanup ac-1
  // AC: @cancelled-task-dependency-cleanup ac-3
  // AC: @cancelled-task-dependency-cleanup ac-4
  it("removes a cancelled task from one downstream dependency list, records a note, and makes the downstream ready", () => {
    kspec('task add --title "Upstream task" --slug cancel-parent', tempDir);
    kspec('task add --title "Downstream task" --slug cancel-child --depends-on @cancel-parent', tempDir);

    const readyBefore = kspecJson<Array<{ slugs: string[] }>>("tasks ready", tempDir);
    expect(readyBefore.some((task) => task.slugs.includes("cancel-child"))).toBe(false);

    kspec('task cancel @cancel-parent --reason "No longer needed"', tempDir);

    const parent = kspecJson<{ status: string; closed_reason: string | null }>(
      "task get @cancel-parent",
      tempDir,
    );
    expect(parent.status).toBe("cancelled");
    expect(parent.closed_reason).toBe("No longer needed");

    const child = kspecJson<{
      depends_on: string[];
      notes: Array<{ author?: string; content: string }>;
    }>("task get @cancel-child", tempDir);
    expect(child.depends_on).toEqual([]);

    const cleanupNote = child.notes.find((note) =>
      note.content.includes("Cancelled dependency cleanup: removed @cancel-parent"),
    );
    expect(cleanupNote?.author).toBe("@test");
    expect(cleanupNote?.content).toContain("upstream task was cancelled");
    expect(cleanupNote?.content).toContain("Reason: No longer needed");

    const readyAfter = kspecJson<Array<{ slugs: string[] }>>("tasks ready", tempDir);
    expect(readyAfter.some((task) => task.slugs.includes("cancel-child"))).toBe(true);
  });

  // AC: @cancelled-task-dependency-cleanup ac-2
  it("removes a cancelled task from every downstream dependency list", () => {
    kspec('task add --title "Shared upstream" --slug shared-upstream', tempDir);
    kspec('task add --title "First dependent" --slug first-dependent --depends-on @shared-upstream', tempDir);
    kspec('task add --title "Second dependent" --slug second-dependent --depends-on @shared-upstream', tempDir);

    kspec("task cancel @shared-upstream", tempDir);

    const firstDependent = kspecJson<{ depends_on: string[] }>("task get @first-dependent", tempDir);
    const secondDependent = kspecJson<{ depends_on: string[] }>("task get @second-dependent", tempDir);

    expect(firstDependent.depends_on).toEqual([]);
    expect(secondDependent.depends_on).toEqual([]);
  });

  // AC: @cancelled-task-dependency-cleanup ac-5
  it("does not modify unrelated tasks when no downstream dependency cleanup is needed", () => {
    kspec('task add --title "Standalone upstream" --slug standalone-upstream', tempDir);
    kspec('task add --title "Unrelated task" --slug unrelated-task --depends-on @test-task-pending', tempDir);

    const unrelatedBefore = kspecJson<{
      depends_on: string[];
      notes: Array<{ content: string }>;
    }>("task get @unrelated-task", tempDir);

    kspec('task cancel @standalone-upstream --reason "Dropped scope"', tempDir);

    const unrelatedAfter = kspecJson<{
      depends_on: string[];
      notes: Array<{ content: string }>;
    }>("task get @unrelated-task", tempDir);

    expect(unrelatedAfter.depends_on).toEqual(unrelatedBefore.depends_on);
    expect(unrelatedAfter.notes).toEqual(unrelatedBefore.notes);
  });

  // AC: @cancelled-task-dependency-cleanup ac-6
  it("persists cancellation and downstream cleanup in a single shadow commit", () => {
    execSync('git add . && git commit -m "initial"', {
      cwd: tempDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    kspec("init --no-prompt", tempDir);

    kspec('task add --title "Atomic upstream" --slug atomic-upstream', tempDir);
    kspec('task add --title "Atomic downstream" --slug atomic-downstream --depends-on @atomic-upstream', tempDir);

    const shadowDir = `${tempDir}/.kspec`;
    const commitsBefore = Number.parseInt(
      execSync("git rev-list --count HEAD", { cwd: shadowDir, encoding: "utf-8" }).trim(),
      10,
    );

    kspec('task cancel @atomic-upstream --reason "Atomic cancel"', tempDir);

    const commitsAfter = Number.parseInt(
      execSync("git rev-list --count HEAD", { cwd: shadowDir, encoding: "utf-8" }).trim(),
      10,
    );
    expect(commitsAfter).toBe(commitsBefore + 1);

    const parent = kspecJson<{ status: string }>("task get @atomic-upstream", tempDir);
    const child = kspecJson<{ depends_on: string[]; notes: Array<{ content: string }> }>(
      "task get @atomic-downstream",
      tempDir,
    );

    expect(parent.status).toBe("cancelled");
    expect(child.depends_on).toEqual([]);
    expect(
      child.notes.some((note) => note.content.includes("Cancelled dependency cleanup")),
    ).toBe(true);
  });
});
