import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
} from "./helpers/cli";
import { VALID_ACTIONS } from "../src/triage/constants";
import { TriageActionSchema } from "../src/schema/triage";

let tempDir: string;

beforeEach(async () => {
  tempDir = await setupTempFixtures();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

/**
 * Helper: add an inbox item and return its ULID
 */
function addInboxItem(text: string): string {
  const result = kspecJson<{ item: { _ulid: string } }>(
    `inbox add "${text}"`,
    tempDir,
  );
  return result.item._ulid;
}

/**
 * Helper: record a triage decision and return the record.
 */
function recordTriage(
  inboxRef: string,
  action: string,
  reasoning: string,
): { _ulid: string; status: string; action: string; inbox_ref: string } {
  const result = kspecJson<{ record: { _ulid: string; status: string; action: string; inbox_ref: string } }>(
    `triage record @${inboxRef} --action ${action} --reasoning "${reasoning}"`,
    tempDir,
  );
  return result.record;
}

describe("VALID_ACTIONS constant", () => {
  it("should be derived from TriageActionSchema", () => {
    // VALID_ACTIONS must exactly match the Zod enum options
    expect(VALID_ACTIONS).toEqual(TriageActionSchema.options);
  });

  it("should contain all expected actions", () => {
    expect(VALID_ACTIONS).toContain("promote");
    expect(VALID_ACTIONS).toContain("delete");
    expect(VALID_ACTIONS).toContain("defer");
    expect(VALID_ACTIONS).toContain("spec-gap");
    expect(VALID_ACTIONS).toContain("duplicate");
  });

  it("should have exactly 5 actions", () => {
    expect(VALID_ACTIONS).toHaveLength(5);
  });
});

describe("shared executeTriageAction via CLI", () => {
  // These tests verify the shared action executor works correctly
  // through the CLI consumer, which passes onInfo for logging.

  // AC: @triage-cli-commands ac-4
  it("promote action should create a task from the triage record", () => {
    const inboxUlid = addInboxItem("Feature: add export button");
    const record = recordTriage(inboxUlid, "promote", "clear feature request");

    const actResult = kspec(
      `triage act @${record._ulid.slice(0, 8)}`,
      tempDir,
    );
    expect(actResult.exitCode).toBe(0);
    expect(actResult.stdout).toContain("Created task:");
    expect(actResult.stdout).toContain("Acted on triage record");

    // Verify task was created
    const tasks = kspecJson<Array<{ title: string; description: string }>>(
      "tasks list",
      tempDir,
    );
    const created = tasks.find((t) => t.description?.includes("Feature: add export button"));
    expect(created).toBeDefined();
  });

  // AC: @triage-cli-commands ac-5
  it("delete action should remove the inbox item", () => {
    const inboxUlid = addInboxItem("Spam item to delete");
    const record = recordTriage(inboxUlid, "delete", "not relevant");

    const actResult = kspec(
      `triage act @${record._ulid.slice(0, 8)}`,
      tempDir,
    );
    expect(actResult.exitCode).toBe(0);
    expect(actResult.stdout).toContain("Deleted inbox item");

    // Verify inbox item was removed
    const inbox = kspecJson<Array<{ _ulid: string }>>("inbox list", tempDir);
    const found = inbox.find((i) => i._ulid === inboxUlid);
    expect(found).toBeUndefined();
  });

  // AC: @triage-cli-commands ac-6
  it("defer action should succeed with no side effects", () => {
    const inboxUlid = addInboxItem("Deferred idea");
    const record = recordTriage(inboxUlid, "defer", "needs more thought");

    const actResult = kspec(
      `triage act @${record._ulid.slice(0, 8)}`,
      tempDir,
    );
    expect(actResult.exitCode).toBe(0);
    expect(actResult.stdout).toContain("Acted on triage record");

    // Inbox item should still exist (defer has no side effect)
    const inbox = kspecJson<Array<{ _ulid: string }>>("inbox list", tempDir);
    const found = inbox.find((i) => i._ulid === inboxUlid);
    expect(found).toBeDefined();
  });

  // AC: @triage-cli-commands ac-7
  it("spec-gap action should create an observation", () => {
    const inboxUlid = addInboxItem("Missing spec coverage for auth");
    const record = recordTriage(inboxUlid, "spec-gap", "spec does not cover auth flow");

    const actResult = kspec(
      `triage act @${record._ulid.slice(0, 8)}`,
      tempDir,
    );
    expect(actResult.exitCode).toBe(0);
    expect(actResult.stdout).toContain("Created spec-gap observation");
  });

  // AC: @triage-cli-commands ac-8
  it("duplicate action should delete the inbox item", () => {
    const inboxUlid = addInboxItem("Duplicate of existing issue");
    const record = recordTriage(inboxUlid, "duplicate", "same as existing task");

    const actResult = kspec(
      `triage act @${record._ulid.slice(0, 8)}`,
      tempDir,
    );
    expect(actResult.exitCode).toBe(0);
    expect(actResult.stdout).toContain("Deleted duplicate inbox item");

    // Verify inbox item was removed
    const inbox = kspecJson<Array<{ _ulid: string }>>("inbox list", tempDir);
    const found = inbox.find((i) => i._ulid === inboxUlid);
    expect(found).toBeUndefined();
  });

  // AC: @triage-cli-commands ac-17
  it("dry-run should describe actions without executing", () => {
    const inboxUlid = addInboxItem("Dry run test item");
    const record = recordTriage(inboxUlid, "promote", "testing dry run");

    const actResult = kspec(
      `triage act @${record._ulid.slice(0, 8)} --dry-run`,
      tempDir,
    );
    expect(actResult.exitCode).toBe(0);
    expect(actResult.stdout).toContain("Would create task");

    // Verify no task was actually created
    const tasks = kspecJson<Array<{ description: string }>>(
      "tasks list",
      tempDir,
    );
    const created = tasks.find((t) => t.description?.includes("Dry run test item"));
    expect(created).toBeUndefined();
  });
});

describe("VALID_ACTIONS used in CLI validation", () => {
  it("should reject invalid actions in triage record", () => {
    const inboxUlid = addInboxItem("Test validation");
    const result = kspec(
      `triage record @${inboxUlid.slice(0, 8)} --action invalid-action --reasoning "test"`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid action");
  });

  it("should reject invalid actions in triage override", () => {
    const inboxUlid = addInboxItem("Test override validation");
    const record = recordTriage(inboxUlid, "defer", "initial decision");

    const result = kspec(
      `triage override @${record._ulid.slice(0, 8)} --action bad-action --reasoning "override"`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid action");
  });
});
