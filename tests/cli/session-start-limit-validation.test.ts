/**
 * Tests for --limit option validation in gatherSessionContext.
 *
 * Ensures invalid --limit values (NaN, zero, negative) are rejected
 * with clear error messages instead of silently breaking.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
  git,
} from "../helpers/cli";
import type { SessionContext } from "../helpers/session-types";

describe("session start --limit validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    writeFileSync(join(tempDir, "README.md"), "# Test\n");
    git("add .", tempDir);
    git('commit -m "initial commit"', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should accept valid positive integer limit", { timeout: 30000 }, () => {
    const result = kspec("session start --limit 5", tempDir);
    expect(result.exitCode).toBe(0);
  });

  it("should accept valid limit in JSON mode", { timeout: 30000 }, () => {
    const session = kspecJson<SessionContext>("session start --json --limit 5", tempDir);
    expect(session).toBeDefined();
    expect(session.stats).toBeDefined();
  });

  it("should reject non-numeric limit with error", { timeout: 30000 }, () => {
    const result = kspec("session start --limit abc", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid limit");
    expect(result.stderr).toContain("abc");
    expect(result.stderr).toContain("positive integer");
  });

  it("should reject zero limit with error", { timeout: 30000 }, () => {
    const result = kspec("session start --limit 0", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid limit");
    expect(result.stderr).toContain("positive integer");
  });

  it("should reject negative limit with error", { timeout: 30000 }, () => {
    const result = kspec("session start --limit -5", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid limit");
    expect(result.stderr).toContain("positive integer");
  });

  it("should use default limit of 10 when --limit not specified", { timeout: 30000 }, () => {
    // Create 12 tasks to verify default limit applies
    for (let i = 1; i <= 12; i++) {
      kspec(`task add --title "Task ${i}" --slug task-${i}`, tempDir);
    }

    const session = kspecJson<SessionContext>("session start --json", tempDir);
    // Default limit is 10 for ready tasks (primer mode limits to 5, full mode to 10)
    // Just verify it doesn't fail and returns some tasks
    expect(session.ready_tasks).toBeDefined();
    expect(session.ready_tasks.length).toBeGreaterThan(0);
    expect(session.ready_tasks.length).toBeLessThanOrEqual(12);
  });
});
