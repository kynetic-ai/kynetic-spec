/**
 * Tests for review_url field on Task schema
 * AC: @task-submit ac-submit-1, ac-submit-2, ac-submit-3
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
} from "./helpers/cli";

describe("Integration: task review_url field", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @task-submit ac-submit-1 - submit transitions to pending_review
  it("should transition in_progress to pending_review on submit", () => {
    kspec('task add --title "Submit test" --slug submit-test', tempDir);
    kspec("task start @submit-test", tempDir);
    const output = kspec("task submit @submit-test", tempDir);
    expect(output).toContain("Submitted task for review");

    const task = kspecJson<{ status: string; submitted_at: string }>(
      "task get @submit-test --json",
      tempDir,
    );
    expect(task.status).toBe("pending_review");
    expect(task.submitted_at).toBeDefined();
  });

  // AC: @task-submit ac-submit-2 - review_url persisted on submit
  it("should persist review_url when submitted with --review-url", () => {
    kspec('task add --title "URL test" --slug url-test', tempDir);
    kspec("task start @url-test", tempDir);
    kspec('task submit @url-test --review-url "https://github.com/org/repo/pull/42"', tempDir);

    const task = kspecJson<{ review_url?: string }>("task get @url-test --json", tempDir);
    expect(task.review_url).toBe("https://github.com/org/repo/pull/42");
  });

  // AC: @task-submit ac-submit-2 - review_url shown in task get
  it("should display review_url in task get human output", () => {
    kspec('task add --title "Display test" --slug display-test', tempDir);
    kspec("task start @display-test", tempDir);
    kspec('task submit @display-test --review-url "https://github.com/org/repo/pull/99"', tempDir);

    const output = kspec("task get @display-test", tempDir);
    expect(output).toContain("https://github.com/org/repo/pull/99");
  });

  // AC: @task-submit ac-submit-3 - invalid URL rejected before state change
  it("should reject invalid review URL without changing state", () => {
    kspec('task add --title "Invalid URL test" --slug invalid-url', tempDir);
    kspec("task start @invalid-url", tempDir);

    const result = kspecRun('task submit @invalid-url --review-url "not-a-url"', tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid review URL");

    // Task should still be in_progress
    const task = kspecJson<{ status: string }>("task get @invalid-url --json", tempDir);
    expect(task.status).toBe("in_progress");
  });

  // AC: @task-submit ac-submit-3 - empty string is invalid URL
  it("should reject empty review URL without changing state", () => {
    kspec('task add --title "Empty URL test" --slug empty-url', tempDir);
    kspec("task start @empty-url", tempDir);

    const result = kspecRun('task submit @empty-url --review-url ""', tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid review URL");

    // Task should still be in_progress
    const task = kspecJson<{ status: string }>("task get @empty-url --json", tempDir);
    expect(task.status).toBe("in_progress");
  });

  it("should submit without --review-url and leave field undefined", () => {
    kspec('task add --title "No URL test" --slug no-url', tempDir);
    kspec("task start @no-url", tempDir);
    kspec("task submit @no-url", tempDir);

    const task = kspecJson<{ review_url?: string }>("task get @no-url --json", tempDir);
    expect(task.review_url).toBeUndefined();
  });

  // task set --review-url
  it("should set review_url via task set", () => {
    kspec('task add --title "Set URL test" --slug set-url', tempDir);
    kspec('task set @set-url --review-url "https://github.com/org/repo/pull/7"', tempDir);

    const task = kspecJson<{ review_url?: string }>("task get @set-url --json", tempDir);
    expect(task.review_url).toBe("https://github.com/org/repo/pull/7");
  });

  // task set --review-url null (clear)
  it("should clear review_url via task set --review-url null", () => {
    kspec('task add --title "Clear URL test" --slug clear-url', tempDir);
    kspec('task set @clear-url --review-url "https://github.com/org/repo/pull/1"', tempDir);
    kspec("task set @clear-url --review-url null", tempDir);

    const task = kspecJson<{ review_url?: string }>("task get @clear-url --json", tempDir);
    expect(task.review_url).toBeUndefined();
  });

  // task set --review-url with invalid URL
  it("should reject invalid URL in task set", () => {
    kspec('task add --title "Bad set URL" --slug bad-set-url', tempDir);
    const result = kspecRun('task set @bad-set-url --review-url "not-valid"', tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid review URL");
  });
});
