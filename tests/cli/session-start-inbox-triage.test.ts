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
  testUlid,
  testUlids,
} from "../helpers/cli";
import type { SessionContext } from "../helpers/session-types";
import { seedInboxItems, seedTriageRecords } from "../helpers/inbox";

let tempDir: string;

beforeEach(async () => {
  tempDir = await setupTempFixtures();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

// AC: @session-start-inbox-triage ac-inbox-stat-line
describe("stat line with triage counts", () => {
  it("should show untriaged count, deferred count, and total in JSON", () => {
    const [ulid1, ulid2, ulid3] = testUlids("JNBX", 3);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "First untriaged item" },
      { _ulid: ulid2, text: "Second item to be deferred" },
      { _ulid: ulid3, text: "Third untriaged item" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid1, item_snapshot: "First untriaged item", action: "promote", reasoning: "clear feature request" },
      { _ulid: testUlid("TRJG", 1), inbox_ref: ulid2, item_snapshot: "Second item to be deferred", action: "defer", reasoning: "needs more thought" },
    ]);

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.total).toBe(3);
    expect(session.inbox_stats.untriaged).toBe(1);
    expect(session.inbox_stats.deferred).toBe(1);
    expect(session.inbox_stats.triaged).toBe(2);
  });

  it("should show stat line in human-readable primer output", () => {
    const [ulid1, ulid2] = testUlids("JNBX", 2);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "Untriaged idea" },
      { _ulid: ulid2, text: "Deferred idea" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid2, item_snapshot: "Deferred idea", action: "defer", reasoning: "later" },
    ]);

    const result = kspec("session start", tempDir);

    expect(result.stdout).toContain("1 untriaged");
    expect(result.stdout).toContain("1 deferred");
    expect(result.stdout).toContain("2 total");
  });

  it("should not list individual items in primer mode", () => {
    const ulid1 = testUlid("JNBX", 0);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "Should not appear in primer" },
    ]);

    const result = kspec("session start", tempDir);

    // Stat line should be present
    expect(result.stdout).toContain("1 untriaged");
    // But individual item text should not appear
    expect(result.stdout).not.toContain("Should not appear in primer");
  });
});

// AC: @session-start-inbox-triage ac-inbox-full-list
describe("full mode lists untriaged items", () => {
  it("should include all items in JSON with triage status", () => {
    const [ulid1, ulid2] = testUlids("JNBX", 2);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "Untriaged feature request" },
      { _ulid: ulid2, text: "Already triaged item" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid2, item_snapshot: "Already triaged item", action: "promote", reasoning: "good idea" },
    ]);

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

  it("should show untriaged items plus stat line in human full output", () => {
    const [ulid1, ulid2] = testUlids("JNBX", 2);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "Needs triage" },
      { _ulid: ulid2, text: "Already handled" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid2, item_snapshot: "Already handled", action: "delete", reasoning: "stale" },
    ]);

    const result = kspec("session start --full", tempDir);

    // Stat line present
    expect(result.stdout).toContain("1 untriaged");
    expect(result.stdout).toContain("2 total");
    // Untriaged item listed
    expect(result.stdout).toContain("Needs triage");
    // Triaged item NOT listed
    expect(result.stdout).not.toContain("Already handled");
  });

  it("should limit displayed untriaged items to 20 in human full mode", () => {
    // Add 22 inbox items (all untriaged) via YAML seeding instead of 22 CLI spawns
    const ulids = testUlids("JNBX", 22);
    seedInboxItems(
      tempDir,
      ulids.map((ulid, i) => ({ _ulid: ulid, text: `Item number ${i}` })),
    );

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
  it("should show 0 untriaged when all items have triage records", () => {
    const [ulid1, ulid2] = testUlids("JNBX", 2);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "First item" },
      { _ulid: ulid2, text: "Second item" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid1, item_snapshot: "First item", action: "promote", reasoning: "good idea" },
      { _ulid: testUlid("TRJG", 1), inbox_ref: ulid2, item_snapshot: "Second item", action: "defer", reasoning: "later" },
    ]);

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.untriaged).toBe(0);
    expect(session.inbox_stats.total).toBe(2);
    expect(session.inbox_stats.triaged).toBe(2);
  });

  it("should show 0 untriaged in human output when all triaged", () => {
    const ulid1 = testUlid("JNBX", 0);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "Handled item" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid1, item_snapshot: "Handled item", action: "delete", reasoning: "stale" },
    ]);

    const result = kspec("session start", tempDir);

    expect(result.stdout).toContain("0 untriaged");
  });

  it("should mark all items as triaged in JSON when all have records", () => {
    const ulid1 = testUlid("JNBX", 0);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "All done" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid1, item_snapshot: "All done", action: "promote", reasoning: "shipped" },
    ]);

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
  it("should count item as untriaged when no triage record exists", () => {
    const ulid1 = testUlid("JNBX", 0);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "No triage record for this" },
    ]);

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.untriaged).toBe(1);
    // JSON always includes all items
    expect(session.inbox_items.length).toBe(1);
    expect(session.inbox_items[0].triaged).toBe(false);
  });

  it("should mark item as triaged when triage record exists", () => {
    const ulid1 = testUlid("JNBX", 0);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "Has triage record" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid1, item_snapshot: "Has triage record", action: "defer", reasoning: "deferred" },
    ]);

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

  it("should include triaged and triage_action fields in inbox summaries", () => {
    const [ulid1, ulid2] = testUlids("JNBX", 2);

    seedInboxItems(tempDir, [
      { _ulid: ulid1, text: "Untriaged item" },
      { _ulid: ulid2, text: "Deferred item" },
    ]);

    seedTriageRecords(tempDir, [
      { _ulid: testUlid("TRJG", 0), inbox_ref: ulid2, item_snapshot: "Deferred item", action: "defer", reasoning: "needs review" },
    ]);

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

  it("should handle empty inbox gracefully", () => {
    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.total).toBe(0);
    expect(session.inbox_stats.untriaged).toBe(0);
    expect(session.inbox_stats.deferred).toBe(0);
    expect(session.inbox_stats.triaged).toBe(0);
    expect(session.inbox_items.length).toBe(0);
  });
});
