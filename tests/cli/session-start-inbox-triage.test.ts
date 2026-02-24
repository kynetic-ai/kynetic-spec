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

interface InboxSummary {
  ref: string;
  text: string;
  created_at: string;
  tags: string[];
  added_by: string | null;
  triaged: boolean;
  triage_action: string | null;
}

interface InboxStats {
  total: number;
  untriaged: number;
  deferred: number;
  triaged: number;
}

interface SessionContext {
  inbox_items: InboxSummary[];
  inbox_stats: InboxStats;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await setupTempFixtures();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

/**
 * Helper: add an inbox item and return its full ULID
 */
function addInboxItem(text: string): string {
  const result = kspecJson<{ item: { _ulid: string } }>(
    `inbox add "${text}"`,
    tempDir,
  );
  return result.item._ulid;
}

/**
 * Helper: create a triage record for an inbox item.
 * Uses full ULID to avoid prefix collisions when items are created quickly.
 */
function triageItem(
  inboxUlid: string,
  action: string,
  reasoning: string,
): void {
  kspec(
    `triage record @${inboxUlid} --action ${action} --reasoning "${reasoning}"`,
    tempDir,
  );
}

// AC: @session-start-inbox-triage ac-inbox-stat-line
describe("stat line with triage counts", () => {
  it("should show untriaged count, deferred count, and total in JSON", () => {
    // Add 3 inbox items
    const ulid1 = addInboxItem("First untriaged item");
    const ulid2 = addInboxItem("Second item to be deferred");
    addInboxItem("Third untriaged item");

    // Triage one as deferred, one as promoted
    triageItem(ulid1, "promote", "clear feature request");
    triageItem(ulid2, "defer", "needs more thought");

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.total).toBe(3);
    expect(session.inbox_stats.untriaged).toBe(1);
    expect(session.inbox_stats.deferred).toBe(1);
    expect(session.inbox_stats.triaged).toBe(2);
  });

  it("should show stat line in human-readable primer output", () => {
    addInboxItem("Untriaged idea");
    const ulid2 = addInboxItem("Deferred idea");
    triageItem(ulid2, "defer", "later");

    const result = kspec("session start", tempDir);

    expect(result.stdout).toContain("1 untriaged");
    expect(result.stdout).toContain("1 deferred");
    expect(result.stdout).toContain("2 total");
  });

  it("should not list individual items in primer mode", () => {
    addInboxItem("Should not appear in primer");

    const result = kspec("session start", tempDir);

    // Stat line should be present
    expect(result.stdout).toContain("1 untriaged");
    // But individual item text should not appear
    expect(result.stdout).not.toContain("Should not appear in primer");
  });
});

// AC: @session-start-inbox-triage ac-inbox-full-list
describe("full mode lists untriaged items", () => {
  it("should list untriaged items in full mode", () => {
    addInboxItem("Untriaged feature request");
    const ulid2 = addInboxItem("Already triaged item");
    triageItem(ulid2, "promote", "good idea");

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    // Only untriaged items should be in the list
    expect(session.inbox_items.length).toBe(1);
    expect(session.inbox_items[0].text).toBe("Untriaged feature request");
    expect(session.inbox_items[0].triaged).toBe(false);
  });

  it("should show untriaged items plus stat line in human full output", () => {
    addInboxItem("Needs triage");
    const ulid2 = addInboxItem("Already handled");
    triageItem(ulid2, "delete", "stale");

    const result = kspec("session start --full", tempDir);

    // Stat line present
    expect(result.stdout).toContain("1 untriaged");
    expect(result.stdout).toContain("2 total");
    // Untriaged item listed
    expect(result.stdout).toContain("Needs triage");
    // Triaged item NOT listed
    expect(result.stdout).not.toContain("Already handled");
  });

  it("should limit untriaged items to 20 in full mode", () => {
    // Add 22 inbox items (all untriaged)
    for (let i = 0; i < 22; i++) {
      addInboxItem(`Item number ${i}`);
    }

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    // Should be capped at 20
    expect(session.inbox_items.length).toBe(20);
    // Stats should reflect all 22
    expect(session.inbox_stats.total).toBe(22);
    expect(session.inbox_stats.untriaged).toBe(22);
  });
});

// AC: @session-start-inbox-triage ac-inbox-all-triaged
describe("all items triaged", () => {
  it("should show 0 untriaged when all items have triage records", () => {
    const ulid1 = addInboxItem("First item");
    const ulid2 = addInboxItem("Second item");

    triageItem(ulid1, "promote", "good idea");
    triageItem(ulid2, "defer", "later");

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.untriaged).toBe(0);
    expect(session.inbox_stats.total).toBe(2);
    expect(session.inbox_stats.triaged).toBe(2);
  });

  it("should show 0 untriaged in human output when all triaged", () => {
    const ulid1 = addInboxItem("Handled item");
    triageItem(ulid1, "delete", "stale");

    const result = kspec("session start", tempDir);

    expect(result.stdout).toContain("0 untriaged");
  });

  it("should show empty inbox_items list when all triaged in full mode", () => {
    const ulid1 = addInboxItem("All done");
    triageItem(ulid1, "promote", "shipped");

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    expect(session.inbox_items.length).toBe(0);
    expect(session.inbox_stats.untriaged).toBe(0);
  });
});

// AC: @session-start-inbox-triage ac-inbox-untriaged-def
describe("untriaged definition", () => {
  it("should count item as untriaged when no triage record exists", () => {
    addInboxItem("No triage record for this");

    const session = kspecJson<SessionContext>("session start --json", tempDir);

    expect(session.inbox_stats.untriaged).toBe(1);
    expect(session.inbox_items.length).toBe(0); // primer mode = no list
  });

  it("should mark item as triaged when triage record exists", () => {
    const ulid = addInboxItem("Has triage record");
    triageItem(ulid, "defer", "deferred");

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    // Item should not appear in inbox_items (only untriaged shown)
    expect(session.inbox_items.length).toBe(0);
    expect(session.inbox_stats.untriaged).toBe(0);
    expect(session.inbox_stats.triaged).toBe(1);
  });

  it("should include triaged and triage_action fields in inbox summaries", () => {
    addInboxItem("Untriaged item");
    const ulid2 = addInboxItem("Deferred item");
    triageItem(ulid2, "defer", "needs review");

    const session = kspecJson<SessionContext>(
      "session start --json --full",
      tempDir,
    );

    // Only untriaged item appears in full mode
    expect(session.inbox_items.length).toBe(1);
    expect(session.inbox_items[0].triaged).toBe(false);
    expect(session.inbox_items[0].triage_action).toBeNull();
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
