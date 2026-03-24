/**
 * Integration tests for multi-value status filter
 * AC: @multi-value-status-filter
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir, initGitRepo } from "./helpers/cli";

describe("Integration: multi-value status filter", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @multi-value-status-filter ac-comma-separated
  it("should filter tasks by comma-separated status values", () => {
    // Start a task to have both pending and in_progress statuses
    kspec("task start @test-task-pending", tempDir);

    const result = kspecJson<any[]>("tasks list --status pending,in_progress", tempDir);
    const statuses = new Set(result.map((t: any) => t.status));

    // Should only contain pending and in_progress
    for (const s of statuses) {
      expect(["pending", "in_progress"]).toContain(s);
    }
    // Should have both types (fixture has pending tasks + we started one)
    expect(result.length).toBeGreaterThan(0);
  });

  // AC: @multi-value-status-filter ac-single-value-unchanged
  it("should work with single status value (backward compatible)", () => {
    const result = kspecJson<any[]>("tasks list --status pending", tempDir);
    for (const task of result) {
      expect(task.status).toBe("pending");
    }
    expect(result.length).toBeGreaterThan(0);
  });

  // AC: @multi-value-status-filter ac-invalid-task-status
  it("should error with valid status list on invalid task status", () => {
    const result = kspec("tasks list --status invalid_value", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid task status: invalid_value");
    expect(result.stderr).toContain("pending");
    expect(result.stderr).toContain("in_progress");
    expect(result.stderr).toContain("completed");
  });

  // AC: @multi-value-status-filter ac-invalid-task-status (partial invalid)
  it("should error when any status in comma list is invalid", () => {
    const result = kspec("tasks list --status pending,bogus", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid task status: bogus");
  });

  // AC: @multi-value-status-filter ac-invalid-item-status
  it("should error with valid status list on invalid item status", () => {
    const result = kspec("item list --status invalid_value", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid implementation status: invalid_value");
    expect(result.stderr).toContain("not_started");
    expect(result.stderr).toContain("implemented");
  });

  // AC: @multi-value-status-filter ac-item-list-parity
  it("should support comma-separated status on item list", () => {
    // Create items with known statuses
    kspec(
      'item add --under @test-core --title "Implemented Feature" --slug impl-feature --type feature',
      tempDir,
    );
    kspec(
      'item add --under @test-core --title "Verified Feature" --slug verified-feature --type feature',
      tempDir,
    );
    kspec(
      'item add --under @test-core --title "Not Started Feature" --slug not-started-feature --type feature',
      tempDir,
    );

    kspec("item set @impl-feature --status implemented", tempDir);
    kspec("item set @verified-feature --status verified", tempDir);
    // @not-started-feature stays not_started (default)

    const result = kspecJson<{
      items: Array<{ slugs: string[]; status?: { implementation?: string } }>;
    }>("item list --status implemented,verified --json", tempDir);
    const items = result.items;
    expect(Array.isArray(items)).toBe(true);

    const slugs = items.flatMap((item) => item.slugs);
    expect(slugs).toContain("impl-feature");
    expect(slugs).toContain("verified-feature");
    expect(slugs).not.toContain("not-started-feature");

    // All returned items must have status implemented or verified
    for (const item of items) {
      expect(["implemented", "verified"]).toContain(item.status?.implementation);
    }
  });

  // AC: @multi-value-status-filter ac-json-output
  it("should return only matching tasks in JSON output", () => {
    const result = kspecJson<any[]>("tasks list --status pending", tempDir);
    expect(Array.isArray(result)).toBe(true);
    for (const task of result) {
      expect(task.status).toBe("pending");
    }
  });

  // AC: @multi-value-status-filter ac-trailing-comma
  it("should silently ignore trailing comma", () => {
    const withComma = kspecJson<any[]>("tasks list --status pending,", tempDir);
    const without = kspecJson<any[]>("tasks list --status pending", tempDir);
    expect(withComma).toEqual(without);
  });

  // AC: @multi-value-status-filter ac-trailing-comma (leading comma)
  it("should silently ignore leading comma", () => {
    const result = kspec("tasks list --status ,pending", tempDir);
    expect(result.exitCode).toBe(0);
  });

  // Works with bare `tasks` command (default action)
  it("should work with bare tasks command multi-status", () => {
    kspec("task start @test-task-pending", tempDir);
    const bare = kspec("tasks --status pending,in_progress", tempDir);
    const explicit = kspec("tasks list --status pending,in_progress", tempDir);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toBe(explicit.stdout);
  });
});
