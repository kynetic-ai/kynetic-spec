/**
 * Tests for session start inbox triage awareness
 *
 * AC: @session-start-inbox-triage ac-inbox-stat-line
 * AC: @session-start-inbox-triage ac-inbox-full-list
 * AC: @session-start-inbox-triage ac-inbox-all-triaged
 * AC: @session-start-inbox-triage ac-inbox-untriaged-def
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
} from "../helpers/cli";
import type { SessionContext } from "../helpers/session-types";
import { addInboxItem, triageItem } from "../helpers/inbox";

let tempDir: string;
const SESSION_START_INBOX_TIMEOUT_MS = 20_000;

beforeEach(async () => {
  tempDir = await setupTempFixtures();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

// AC: @session-start-inbox-triage ac-inbox-stat-line
describe("stat line with triage counts", () => {
  it("should show untriaged count, deferred count, and total in JSON", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    // Add 3 inbox items
    const ulid1 = addInboxItem(tempDir, "First untriaged item");
    const ulid2 = addInboxItem(tempDir, "Second item to be deferred");
    addInboxItem(tempDir, "Third untriaged item");

    // Triage one as deferred, one as promoted
    triageItem(tempDir, ulid1, "promote", "clear feature request");
    triageItem(tempDir, ulid2, "defer", "needs more thought");

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.total).toBe(3);
    expect(session.inbox_stats.untriaged).toBe(1);
    expect(session.inbox_stats.deferred).toBe(1);
    expect(session.inbox_stats.triaged).toBe(2);
  });

  it("should show stat line in human-readable primer output", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    addInboxItem(tempDir, "Untriaged idea");
    const ulid2 = addInboxItem(tempDir, "Deferred idea");
    triageItem(tempDir, ulid2, "defer", "later");

    const result = kspec("session start", tempDir);

    expect(result.stdout).toContain("1 untriaged");
    expect(result.stdout).toContain("1 deferred");
    expect(result.stdout).toContain("2 total");
  });

  it("should not list individual items in primer mode", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    addInboxItem(tempDir, "Should not appear in primer");

    const result = kspec("session start", tempDir);

    // Stat line should be present
    expect(result.stdout).toContain("1 untriaged");
    // But individual item text should not appear
    expect(result.stdout).not.toContain("Should not appear in primer");
  });
});

// AC: @session-start-inbox-triage ac-inbox-full-list
describe("full mode lists untriaged items", () => {
  it("should include all items in JSON with triage status", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    addInboxItem(tempDir, "Untriaged feature request");
    const ulid2 = addInboxItem(tempDir, "Already triaged item");
    triageItem(tempDir, ulid2, "promote", "good idea");

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    // JSON includes ALL items with triage status
    expect(session.inbox_items.length).toBe(2);
    const untriaged = session.inbox_items.filter((i) => !i.triaged);
    expect(untriaged.length).toBe(1);
    expect(untriaged[0].text).toBe("Untriaged feature request");
    const triaged = session.inbox_items.filter((i) => i.triaged);
    expect(triaged.length).toBe(1);
    expect(triaged[0].triage_action).toBe("promote");
  });

  it("should show untriaged items plus stat line in human full output", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    addInboxItem(tempDir, "Needs triage");
    const ulid2 = addInboxItem(tempDir, "Already handled");
    triageItem(tempDir, ulid2, "delete", "stale");

    const result = kspec("session start --full", tempDir);

    // Stat line present
    expect(result.stdout).toContain("1 untriaged");
    expect(result.stdout).toContain("2 total");
    // Untriaged item listed
    expect(result.stdout).toContain("Needs triage");
    // Triaged item NOT listed
    expect(result.stdout).not.toContain("Already handled");
  });

  it("should limit displayed untriaged items to 20 in human full mode", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    // Add 22 inbox items (all untriaged)
    for (let i = 0; i < 22; i++) {
      addInboxItem(tempDir, `Item number ${i}`);
    }

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    // JSON includes all 22 items
    expect(session.inbox_items.length).toBe(22);
    // Stats should reflect all 22
    expect(session.inbox_stats.total).toBe(22);
    expect(session.inbox_stats.untriaged).toBe(22);

    // Human output should cap displayed untriaged at 20
    const result = kspec("session start --full", tempDir);
    // Count displayed item refs (8-char ULID prefix lines)
    const itemLines = result.stdout
      .split("\n")
      .filter((l: string) => l.match(/^\s+[0-9A-Z]{8}\s/));
    expect(itemLines.length).toBeLessThanOrEqual(20);
  });
});

// AC: @session-start-inbox-triage ac-inbox-all-triaged
describe("all items triaged", () => {
  it("should show 0 untriaged when all items have triage records", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    const ulid1 = addInboxItem(tempDir, "First item");
    const ulid2 = addInboxItem(tempDir, "Second item");

    triageItem(tempDir, ulid1, "promote", "good idea");
    triageItem(tempDir, ulid2, "defer", "later");

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.untriaged).toBe(0);
    expect(session.inbox_stats.total).toBe(2);
    expect(session.inbox_stats.triaged).toBe(2);
  });

  it("should show 0 untriaged in human output when all triaged", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    const ulid1 = addInboxItem(tempDir, "Handled item");
    triageItem(tempDir, ulid1, "delete", "stale");

    const result = kspec("session start", tempDir);

    expect(result.stdout).toContain("0 untriaged");
  });

  it("should mark all items as triaged in JSON when all have records", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    const ulid1 = addInboxItem(tempDir, "All done");
    triageItem(tempDir, ulid1, "promote", "shipped");

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    // JSON still includes the item, but marked as triaged
    expect(session.inbox_items.length).toBe(1);
    expect(session.inbox_items[0].triaged).toBe(true);
    expect(session.inbox_stats.untriaged).toBe(0);
  });
});

// AC: @session-start-inbox-triage ac-inbox-untriaged-def
describe("untriaged definition", () => {
  it("should count item as untriaged when no triage record exists", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    addInboxItem(tempDir, "No triage record for this");

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.untriaged).toBe(1);
    // JSON always includes all items
    expect(session.inbox_items.length).toBe(1);
    expect(session.inbox_items[0].triaged).toBe(false);
  });

  it("should mark item as triaged when triage record exists", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    const ulid = addInboxItem(tempDir, "Has triage record");
    triageItem(tempDir, ulid, "defer", "deferred");

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    // JSON includes the item, marked as triaged
    expect(session.inbox_items.length).toBe(1);
    expect(session.inbox_items[0].triaged).toBe(true);
    expect(session.inbox_items[0].triage_action).toBe("defer");
    expect(session.inbox_stats.untriaged).toBe(0);
    expect(session.inbox_stats.triaged).toBe(1);
  });

  it("should include triaged and triage_action fields in inbox summaries", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    addInboxItem(tempDir, "Untriaged item");
    const ulid2 = addInboxItem(tempDir, "Deferred item");
    triageItem(tempDir, ulid2, "defer", "needs review");

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    // JSON includes both items with correct triage status
    expect(session.inbox_items.length).toBe(2);
    const untriaged = session.inbox_items.find((i) => !i.triaged);
    const deferred = session.inbox_items.find(
      (i) => i.triage_action === "defer",
    );
    expect(untriaged).toBeDefined();
    expect(untriaged!.triage_action).toBeNull();
    expect(deferred).toBeDefined();
    expect(deferred!.triaged).toBe(true);
  });

  it("should handle empty inbox gracefully", { timeout: SESSION_START_INBOX_TIMEOUT_MS }, () => {
    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.total).toBe(0);
    expect(session.inbox_stats.untriaged).toBe(0);
    expect(session.inbox_stats.deferred).toBe(0);
    expect(session.inbox_stats.triaged).toBe(0);
    expect(session.inbox_items.length).toBe(0);
  });
});
