/**
 * Tests for fix-cycle diff context in reviewer orientation.
 *
 * Task: @task-review-diff-orientation
 * Spec: @review-fix-cycle-diff
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execSync } from "node:child_process";
import {
  findPriorExaminedCommit,
  computeDiffStat,
} from "../src/agent-runtime/dispatch.js";
import {
  createTempDir,
  cleanupTempDir,
  initGitRepo,
} from "./helpers/cli.js";

// ─── findPriorExaminedCommit ─────────────────────────────────────────────────

describe("findPriorExaminedCommit", () => {
  const makeReview = (overrides: Record<string, unknown>) => ({
    lifecycle_state: "closed" as string,
    examined_commit: null as string | null,
    subject: { type: "task", ref: "task-slug" },
    related_refs: ["task-slug"],
    created_at: "2026-01-01T00:00:00Z" as string | null,
    ...overrides,
  });

  // AC: @review-fix-cycle-diff ac-2
  it("should return examined_commit from the most recent closed review", () => {
    const reviews = [
      makeReview({ examined_commit: "aaa111", created_at: "2026-01-01T00:00:00Z" }),
      makeReview({ examined_commit: "bbb222", created_at: "2026-01-02T00:00:00Z" }),
    ];

    const result = findPriorExaminedCommit(reviews, "@task-slug");
    expect(result).toBe("bbb222");
  });

  it("should return null when no reviews have examined_commit", () => {
    const reviews = [
      makeReview({ examined_commit: null }),
    ];

    const result = findPriorExaminedCommit(reviews, "@task-slug");
    expect(result).toBeNull();
  });

  it("should ignore open reviews", () => {
    const reviews = [
      makeReview({ lifecycle_state: "open", examined_commit: "aaa111" }),
    ];

    const result = findPriorExaminedCommit(reviews, "@task-slug");
    expect(result).toBeNull();
  });

  it("should only match reviews linked to the specified task", () => {
    const reviews = [
      makeReview({
        examined_commit: "aaa111",
        subject: { type: "task", ref: "other-task" },
        related_refs: ["other-task"],
      }),
    ];

    const result = findPriorExaminedCommit(reviews, "@task-slug");
    expect(result).toBeNull();
  });

  it("should match by related_refs", () => {
    const reviews = [
      makeReview({
        examined_commit: "aaa111",
        subject: { type: "task", ref: "different" },
        related_refs: ["task-slug"],
      }),
    ];

    const result = findPriorExaminedCommit(reviews, "@task-slug");
    expect(result).toBe("aaa111");
  });

  it("should match by subject.ref", () => {
    const reviews = [
      makeReview({
        examined_commit: "aaa111",
        subject: { type: "task", ref: "task-slug" },
        related_refs: [],
      }),
    ];

    const result = findPriorExaminedCommit(reviews, "@task-slug");
    expect(result).toBe("aaa111");
  });

  it("should strip @ prefix from taskRef", () => {
    const reviews = [
      makeReview({ examined_commit: "aaa111" }),
    ];

    // Both with and without @ should work
    expect(findPriorExaminedCommit(reviews, "@task-slug")).toBe("aaa111");
    expect(findPriorExaminedCommit(reviews, "task-slug")).toBe("aaa111");
  });

  it("should return null when reviews array is empty", () => {
    expect(findPriorExaminedCommit([], "@task-slug")).toBeNull();
  });
});

// ─── computeDiffStat ─────────────────────────────────────────────────────────

describe("computeDiffStat", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-diff-stat-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @review-fix-cycle-diff ac-2
  it("should return formatted diff stat between two commits", async () => {
    await initGitRepo(tempDir);
    const file = path.join(tempDir, "src.ts");
    await fs.writeFile(file, "const a = 1;\n");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir });
    const commit1 = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

    await fs.writeFile(file, "const a = 1;\nconst b = 2;\n");
    execSync("git add . && git commit -m 'add b'", { cwd: tempDir });
    const commit2 = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

    const result = computeDiffStat(commit1, commit2, tempDir);

    expect(result).not.toBeNull();
    expect(result).toContain("Changes since prior review");
    expect(result).toContain("src.ts");
    expect(result).toContain("1 file changed");
    // Should contain short SHAs
    expect(result).toContain(commit1.slice(0, 7));
    expect(result).toContain(commit2.slice(0, 7));
  });

  // AC: @review-fix-cycle-diff ac-3
  it("should return null when commit is unreachable", async () => {
    await initGitRepo(tempDir);
    const file = path.join(tempDir, "src.ts");
    await fs.writeFile(file, "const a = 1;\n");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir });
    const commit = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

    const result = computeDiffStat(
      "0000000000000000000000000000000000000000",
      commit,
      tempDir,
    );

    expect(result).toBeNull();
  });

  // AC: @review-fix-cycle-diff ac-3
  it("should return null when cwd is not a git repo", async () => {
    const nonGitDir = await createTempDir("kspec-diff-stat-nogit-");
    try {
      const result = computeDiffStat("abc123", "def456", nonGitDir);
      expect(result).toBeNull();
    } finally {
      await cleanupTempDir(nonGitDir);
    }
  });

  it("should return null when commits are identical (empty diff)", async () => {
    await initGitRepo(tempDir);
    const file = path.join(tempDir, "src.ts");
    await fs.writeFile(file, "const a = 1;\n");
    execSync("git add . && git commit -m 'initial'", { cwd: tempDir });
    const commit = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

    const result = computeDiffStat(commit, commit, tempDir);

    // Same commit → empty diff → null
    expect(result).toBeNull();
  });
});
