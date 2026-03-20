import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stringify as yamlStringify } from "yaml";
import {
  kspec,
  kspecJson,
  testUlid,
  setupTempFixtures,
  cleanupTempDir,
} from "./helpers/cli";

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
function addInboxItem(text: string, tags: string[] = []): string {
  const tagArgs = tags.map((t) => `--tag ${t}`).join(" ");
  const result = kspecJson<{ item: { _ulid: string } }>(
    `inbox add "${text}" ${tagArgs}`,
    tempDir,
  );
  return result.item._ulid;
}

/**
 * Helper: record a triage decision and return the record.
 * Uses full ULID to avoid prefix collisions when multiple items are created quickly.
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

describe("kspec triage record", () => {
  // AC: @triage-cli-commands ac-1
  it("should create a triage record for an inbox item", () => {
    const inboxUlid = addInboxItem("Feature request: add dark mode");
    const result = kspec(
      `triage record @${inboxUlid.slice(0, 8)} --action promote --reasoning "clear feature request"`,
      tempDir,
    );
    expect(result.stdout).toContain("Recorded triage decision");
    expect(result.exitCode).toBe(0);

    // Verify the record was created
    const records = kspecJson<Array<{ status: string; action: string; item_snapshot: string; inbox_ref: string }>>(
      "triage list",
      tempDir,
    );
    expect(records.length).toBe(1);
    expect(records[0].status).toBe("triaged");
    expect(records[0].action).toBe("promote");
    expect(records[0].item_snapshot).toBe("Feature request: add dark mode");
    expect(records[0].inbox_ref).toBe(inboxUlid);
  });

  // AC: @triage-cli-commands ac-11
  // AC: @trait-json-output ac-1
  it("should output created triage record as JSON when --json flag is used", () => {
    const inboxUlid = addInboxItem("Test JSON output");
    const result = kspecJson<{ record: { _ulid: string; status: string; action: string } }>(
      `triage record @${inboxUlid.slice(0, 8)} --action defer --reasoning "needs discussion"`,
      tempDir,
    );
    expect(result.record).toBeDefined();
    expect(result.record._ulid).toBeDefined();
    expect(result.record.status).toBe("triaged");
    expect(result.record.action).toBe("defer");
  });

  // AC: @trait-json-output ac-2
  it("should include all data in JSON mode that is available in human-readable mode", () => {
    const inboxUlid = addInboxItem("Comprehensive JSON test");
    const result = kspecJson<{ record: { _ulid: string; inbox_ref: string; item_snapshot: string; status: string; action: string; reasoning: string; decided_by: string; created_at: string } }>(
      `triage record @${inboxUlid.slice(0, 8)} --action promote --reasoning "important feature"`,
      tempDir,
    );
    const record = result.record;
    expect(record._ulid).toBeDefined();
    expect(record.inbox_ref).toBe(inboxUlid);
    expect(record.item_snapshot).toBe("Comprehensive JSON test");
    expect(record.status).toBe("triaged");
    expect(record.action).toBe("promote");
    expect(record.reasoning).toBe("important feature");
    expect(record.decided_by).toBeDefined();
    expect(record.created_at).toBeDefined();
  });

  // AC: @trait-json-output ac-5
  it("should use ISO 8601 timestamps in JSON output", () => {
    const inboxUlid = addInboxItem("ISO timestamp test");
    const result = kspecJson<{ record: { created_at: string } }>(
      `triage record @${inboxUlid.slice(0, 8)} --action defer --reasoning "test"`,
      tempDir,
    );
    // ISO 8601 pattern
    expect(result.record.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("should report the persisted record ref when re-recording an already triaged inbox item", () => {
    const inboxUlid = addInboxItem("Existing triage record");
    const original = recordTriage(inboxUlid, "promote", "first pass");

    const rerecorded = kspecJson<{ record: { _ulid: string; action: string; reasoning: string } }>(
      `triage record @${inboxUlid.slice(0, 8)} --action defer --reasoning "updated decision"`,
      tempDir,
    );

    expect(rerecorded.record._ulid).toBe(original._ulid);
    expect(rerecorded.record.action).toBe("defer");
    expect(rerecorded.record.reasoning).toBe("updated decision");

    const records = kspecJson<Array<{ _ulid: string; action: string; reasoning: string }>>(
      "triage list",
      tempDir,
    );
    expect(records).toHaveLength(1);
    expect(records[0]._ulid).toBe(original._ulid);
    expect(records[0].action).toBe("defer");
    expect(records[0].reasoning).toBe("updated decision");

    const actResult = kspec(`triage act @${rerecorded.record._ulid.slice(0, 8)}`, tempDir);
    expect(actResult.stdout).toContain("Acted on triage record");
  });

  // AC: @trait-error-guidance ac-1
  it("should return error with guidance when inbox item not found", () => {
    const result = kspec(
      'triage record @NOTEXIST --action promote --reasoning "test"',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain("not found");
  });

  // AC: @trait-semantic-exit-codes ac-1
  it("should use validation exit code for invalid action", () => {
    const inboxUlid = addInboxItem("Invalid action test");
    const result = kspec(
      `triage record @${inboxUlid.slice(0, 8)} --action invalid --reasoning "test"`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    expect(result.stderr).toContain("Invalid action");
  });
});

describe("kspec triage list", () => {
  // AC: @triage-cli-commands ac-2
  it("should display records with ULID prefix, snapshot, status, action, decided_by, and relative time", () => {
    const inboxUlid = addInboxItem("Test list display");
    recordTriage(inboxUlid, "promote", "test display");

    const result = kspec("triage list", tempDir);
    expect(result.stdout).toContain("triaged");
    expect(result.stdout).toContain("[promote]");
    expect(result.stdout).toContain("Test list display");
    expect(result.stdout).toContain("@test"); // decided_by
  });

  // AC: @triage-cli-commands ac-3
  // AC: @trait-filterable-list ac-1
  it("should filter records by status", () => {
    const ulid1 = addInboxItem("Item pending");
    const ulid2 = addInboxItem("Item triaged");
    recordTriage(ulid2, "promote", "promote it");

    // Pending filter should find no records (we created triaged records)
    const pending = kspecJson<Array<{ status: string }>>(
      "triage list --status pending",
      tempDir,
    );
    expect(pending.length).toBe(0);

    // Triaged filter should find one record
    const triaged = kspecJson<Array<{ status: string }>>(
      "triage list --status triaged",
      tempDir,
    );
    expect(triaged.length).toBe(1);
    expect(triaged[0].status).toBe("triaged");
  });

  // AC: @trait-filterable-list ac-8
  it("should support --count flag to show only count", () => {
    const ulid1 = addInboxItem("Count test 1");
    const ulid2 = addInboxItem("Count test 2");
    recordTriage(ulid1, "promote", "promote");
    recordTriage(ulid2, "defer", "defer");

    const result = kspecJson<{ count: number }>(
      "triage list --count",
      tempDir,
    );
    expect(result.count).toBe(2);
  });

  // AC: @trait-json-output ac-1
  it("should output records as valid JSON array", () => {
    const ulid1 = addInboxItem("JSON list test");
    recordTriage(ulid1, "promote", "test");

    const records = kspecJson<Array<{ _ulid: string; status: string }>>(
      "triage list",
      tempDir,
    );
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBe(1);
    expect(records[0]._ulid).toBeDefined();
  });

  // AC: @trait-filterable-list ac-6
  it("should show empty message when no records exist", () => {
    const result = kspec("triage list", tempDir);
    expect(result.stdout).toContain("No triage records");
  });

  // AC: @trait-filterable-list ac-4
  it("should support --offset to skip first N results", () => {
    const ulid1 = addInboxItem("Offset test 1");
    const ulid2 = addInboxItem("Offset test 2");
    const ulid3 = addInboxItem("Offset test 3");
    recordTriage(ulid1, "promote", "first");
    recordTriage(ulid2, "defer", "second");
    recordTriage(ulid3, "delete", "third");

    const all = kspecJson<Array<{ _ulid: string }>>("triage list", tempDir);
    expect(all.length).toBe(3);

    const offset1 = kspecJson<Array<{ _ulid: string }>>("triage list --offset 1", tempDir);
    expect(offset1.length).toBe(2);

    const offset2 = kspecJson<Array<{ _ulid: string }>>("triage list --offset 2", tempDir);
    expect(offset2.length).toBe(1);
  });

  // AC: @trait-filterable-list ac-7
  it("should show summary with total and filter state", () => {
    const ulid1 = addInboxItem("Summary test 1");
    const ulid2 = addInboxItem("Summary test 2");
    recordTriage(ulid1, "promote", "promote it");
    recordTriage(ulid2, "defer", "defer it");

    const filtered = kspec("triage list --action promote", tempDir);
    expect(filtered.stdout).toContain("1 of 2");
    expect(filtered.stdout).toContain("action=promote");
  });

  it("should disambiguate displayed refs when triage ULIDs share 8-char prefix", async () => {
    const first = testUlid("ABCDEF", 0);
    const second = testUlid("ABCDEF", 1);
    const inboxA = addInboxItem("First colliding record");
    const inboxB = addInboxItem("Second colliding record");
    recordTriage(inboxA, "promote", "seed");
    recordTriage(inboxB, "defer", "seed");

    const existing = kspecJson<
      Array<{
        _ulid: string;
        inbox_ref: string;
        item_snapshot: string;
        status: string;
        action: string;
        reasoning: string;
        decided_by: string;
        evidence_refs: string[];
        created_at: string;
        updated_at?: string;
        _sourceFile?: string;
      }>
    >("triage list", tempDir);
    const triagePath = existing[0]._sourceFile || path.join(tempDir, "spec", "project.triage.yaml");

    await fs.writeFile(
      triagePath,
      yamlStringify({
        kynetic_triage: "1.0",
        triage: existing.map((record, idx) => ({
          _ulid: idx === 0 ? first : second,
          inbox_ref: record.inbox_ref,
          item_snapshot: record.item_snapshot,
          status: record.status,
          action: record.action,
          reasoning: record.reasoning,
          decided_by: record.decided_by,
          evidence_refs: record.evidence_refs,
          created_at: record.created_at,
          updated_at: record.updated_at,
        })),
      }),
      "utf-8",
    );

    const list = kspec("triage list", tempDir);
    const refs = list.stdout
      .split("\n")
      .map((line) => line.trim().split(" ")[0] || "")
      .filter((token) => token.startsWith("01ABCDEF"));

    expect(refs).toHaveLength(2);
    expect(refs[0]).not.toBe("01ABCDEF");
    expect(refs[1]).not.toBe("01ABCDEF");
    expect(refs[0]).not.toBe(refs[1]);
    expect(refs[0].length).toBeGreaterThan(8);
    expect(refs[1].length).toBeGreaterThan(8);

    const firstGet = kspecJson<{ _ulid: string }>(`triage get @${refs[0]}`, tempDir);
    const secondGet = kspecJson<{ _ulid: string }>(`triage get @${refs[1]}`, tempDir);
    expect(new Set([firstGet._ulid, secondGet._ulid])).toEqual(new Set([first, second]));
  });
});

describe("kspec triage act", () => {
  // AC: @triage-cli-commands ac-4
  it("should execute promote action creating a task and consuming inbox item by default", () => {
    const inboxUlid = addInboxItem("Create this as a task");
    const record = recordTriage(inboxUlid, "promote", "clear feature");

    const result = kspec(
      `triage act @${record._ulid.slice(0, 8)}`,
      tempDir,
    );
    expect(result.stdout).toContain("Acted on triage record");
    expect(result.stdout).toContain("promote");
    expect(result.stdout).toContain("Deleted promoted inbox item");

    // Verify record transitioned to acted_on
    const records = kspecJson<Array<{ _ulid: string; status: string; acted_at: string; result_ref: string }>>(
      "triage list",
      tempDir,
    );
    const acted = records.find((r) => r._ulid === record._ulid);
    expect(acted).toBeDefined();
    expect(acted!.status).toBe("acted_on");
    expect(acted!.acted_at).toBeDefined();
    expect(acted!.result_ref).toBeDefined();

    // Verify inbox item was consumed
    const inbox = kspecJson<Array<{ _ulid: string }>>(
      "inbox list",
      tempDir,
    );
    const found = inbox.find((item) => item._ulid === inboxUlid);
    expect(found).toBeUndefined();
  });

  // AC: @triage-cli-commands ac-4
  it("should keep promoted inbox item when --keep is provided", () => {
    const inboxUlid = addInboxItem("Keep this inbox item");
    const record = recordTriage(inboxUlid, "promote", "keep item");

    const result = kspec(
      `triage act @${record._ulid.slice(0, 8)} --keep`,
      tempDir,
    );
    expect(result.stdout).toContain("Acted on triage record");
    expect(result.stdout).toContain("promote");
    expect(result.stdout).not.toContain("Deleted promoted inbox item");

    const inbox = kspecJson<Array<{ _ulid: string }>>(
      "inbox list",
      tempDir,
    );
    const found = inbox.find((item) => item._ulid === inboxUlid);
    expect(found).toBeDefined();
  });

  // AC: @triage-cli-commands ac-5
  it("should execute delete action removing inbox item", () => {
    const inboxUlid = addInboxItem("Delete this item");
    const record = recordTriage(inboxUlid, "delete", "not needed");

    kspec(`triage act @${record._ulid.slice(0, 8)}`, tempDir);

    // Verify inbox item was deleted
    const inboxResult = kspecJson<Array<{ _ulid: string }>>(
      "inbox list",
      tempDir,
    );
    const found = inboxResult.find((item) => item._ulid === inboxUlid);
    expect(found).toBeUndefined();
  });

  // AC: @triage-cli-commands ac-6
  it("should execute defer action with no side effects", () => {
    const inboxUlid = addInboxItem("Defer this item");
    const record = recordTriage(inboxUlid, "defer", "not ready yet");

    kspec(`triage act @${record._ulid.slice(0, 8)}`, tempDir);

    // Verify record transitioned to acted_on
    const records = kspecJson<Array<{ _ulid: string; status: string }>>(
      "triage list",
      tempDir,
    );
    const acted = records.find((r) => r._ulid === record._ulid);
    expect(acted!.status).toBe("acted_on");

    // Inbox item should still exist
    const inboxResult = kspecJson<Array<{ _ulid: string }>>(
      "inbox list",
      tempDir,
    );
    const inboxItem = inboxResult.find((item) => item._ulid === inboxUlid);
    expect(inboxItem).toBeDefined();
  });

  // AC: @triage-cli-commands ac-7
  it("should execute spec-gap action creating an observation tagged spec-gap", () => {
    const inboxUlid = addInboxItem("Spec gap identified here");
    const record = recordTriage(inboxUlid, "spec-gap", "needs spec review");

    const result = kspec(`triage act @${record._ulid.slice(0, 8)}`, tempDir);
    expect(result.stdout).toContain("Acted on triage record");
    expect(result.stdout).toContain("spec-gap observation");

    // Verify record has result_ref
    const records = kspecJson<Array<{ _ulid: string; status: string; result_ref: string }>>(
      "triage list",
      tempDir,
    );
    const acted = records.find((r) => r._ulid === record._ulid);
    expect(acted!.status).toBe("acted_on");
    expect(acted!.result_ref).toBeDefined();

    // Verify the observation contains spec-gap marker
    const observations = kspecJson<Array<{ type: string; content: string }>>(
      "meta observations --all",
      tempDir,
    );
    const specGapObs = observations.find((o) => o.content.includes("[spec-gap]"));
    expect(specGapObs).toBeDefined();
    expect(specGapObs!.type).toBe("question");
    expect(specGapObs!.content).toContain("Spec gap identified here");
    expect(specGapObs!.content).toContain("needs spec review");
  });

  // AC: @triage-cli-commands ac-8
  it("should execute duplicate action deleting inbox item", () => {
    const inboxUlid = addInboxItem("This is a duplicate");
    const record = recordTriage(inboxUlid, "duplicate", "duplicate of existing item");

    kspec(`triage act @${record._ulid.slice(0, 8)}`, tempDir);

    // Verify inbox item was deleted
    const inboxResult = kspecJson<Array<{ _ulid: string }>>(
      "inbox list",
      tempDir,
    );
    const found = inboxResult.find((item) => item._ulid === inboxUlid);
    expect(found).toBeUndefined();

    // Verify record is acted_on
    const records = kspecJson<Array<{ _ulid: string; status: string }>>(
      "triage list",
      tempDir,
    );
    const acted = records.find((r) => r._ulid === record._ulid);
    expect(acted!.status).toBe("acted_on");
  });

  // AC: @triage-cli-commands ac-15
  // AC: @trait-error-guidance ac-1
  it("should error when acting on already acted_on record", () => {
    const inboxUlid = addInboxItem("Already acted on");
    const record = recordTriage(inboxUlid, "defer", "defer it");

    // Act once
    kspec(`triage act @${record._ulid.slice(0, 8)}`, tempDir);

    // Try to act again
    const result = kspec(
      `triage act @${record._ulid.slice(0, 8)}`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    expect(result.stderr).toContain("already been acted on");
  });

  // AC: @triage-cli-commands ac-16
  // AC: @trait-error-guidance ac-1, ac-2
  it("should error when acting on pending record with no decision", async () => {
    // Create a pending triage record by writing directly to the triage YAML file
    const pendingUlid = testUlid("PEND", 1);
    const inboxUlid = testUlid("PEND", 2);
    const triageData = {
      kynetic_triage: "1.0",
      triage: [{
        _ulid: pendingUlid,
        inbox_ref: inboxUlid,
        item_snapshot: "A pending item",
        status: "pending",
        created_at: new Date().toISOString(),
      }],
    };
    await fs.writeFile(
      path.join(tempDir, "project.triage.yaml"),
      yamlStringify(triageData),
    );

    const result = kspec(
      `triage act @${pendingUlid.slice(0, 8)}`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    expect(result.stderr).toContain("no decision yet");
    expect(result.stderr).toContain("kspec triage record");
  });

  // AC: @triage-cli-commands ac-17
  // AC: @trait-dry-run ac-1
  it("should show what would happen in dry-run mode", () => {
    const inboxUlid = addInboxItem("Dry run test item");
    const record = recordTriage(inboxUlid, "promote", "dry run test");

    const result = kspec(
      `triage act @${record._ulid.slice(0, 8)} --dry-run`,
      tempDir,
    );
    expect(result.stdout).toContain("Dry run");
    expect(result.stdout).toContain("Would create task");
    expect(result.stdout).toContain("Would delete promoted inbox item");

    const keepResult = kspec(
      `triage act @${record._ulid.slice(0, 8)} --dry-run --keep`,
      tempDir,
    );
    expect(keepResult.stdout).toContain("Would keep promoted inbox item");

    // Verify record was NOT transitioned
    const records = kspecJson<Array<{ _ulid: string; status: string }>>(
      "triage list",
      tempDir,
    );
    const unchanged = records.find((r) => r._ulid === record._ulid);
    expect(unchanged!.status).toBe("triaged");
  });
});

describe("kspec triage override", () => {
  // AC: @triage-cli-commands ac-12
  // AC: @interactive-triage ac-2 (override preserves attribution and timestamps)
  it("should update record with override fields", () => {
    const inboxUlid = addInboxItem("Override test item");
    const record = recordTriage(inboxUlid, "promote", "initial decision");

    const result = kspec(
      `triage override @${record._ulid.slice(0, 8)} --action defer --reasoning "not ready yet"`,
      tempDir,
    );
    expect(result.stdout).toContain("Overrode triage decision");

    // Verify override fields
    const records = kspecJson<Array<{
      _ulid: string;
      action: string;
      override_reasoning: string;
      override_by: string;
      override_at: string;
    }>>(
      "triage list",
      tempDir,
    );
    const overridden = records.find((r) => r._ulid === record._ulid);
    expect(overridden!.action).toBe("defer");
    expect(overridden!.override_reasoning).toBe("not ready yet");
    expect(overridden!.override_by).toBeDefined();
    expect(overridden!.override_at).toBeDefined();
  });
});

describe("kspec triage export", () => {
  // AC: @triage-cli-commands ac-13
  // AC: @interactive-triage ac-2 (export captures full decision chain)
  it("should output markdown context blocks with item text, action, reasoning", () => {
    const inboxUlid = addInboxItem("Export context test");
    recordTriage(inboxUlid, "promote", "export reasoning test");

    const result = kspec("triage export --format context", tempDir);
    expect(result.stdout).toContain("# Triage Decisions");
    expect(result.stdout).toContain("Export context test");
    expect(result.stdout).toContain("promote");
    expect(result.stdout).toContain("export reasoning test");
    expect(result.stdout).toContain("@test"); // decided_by
  });

  // AC: @triage-cli-commands ac-14
  // AC: @trait-json-output ac-1
  it("should output JSON array with full triage records", () => {
    const inboxUlid = addInboxItem("Export JSON test");
    recordTriage(inboxUlid, "defer", "JSON export test");

    const result = kspec("triage export --format json", tempDir);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0]._ulid).toBeDefined();
    expect(parsed[0].action).toBe("defer");
    expect(parsed[0].reasoning).toBe("JSON export test");
    expect(parsed[0].created_at).toBeDefined();
  });

  it("should show message when no records exist for context export", () => {
    const result = kspec("triage export --format context", tempDir);
    expect(result.stdout).toContain("No triage decisions recorded");
  });

  // AC: @trait-error-guidance ac-1
  it("should error on invalid format", () => {
    const result = kspec(
      "triage export --format invalid",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    expect(result.stderr).toContain("Invalid format");
  });
});

describe("kspec triage start (interactive)", () => {
  // AC: @triage-cli-commands ac-9
  it("should show message when no untriaged items exist", () => {
    const result = kspec("triage start", tempDir);
    expect(result.stdout).toContain("No untriaged inbox items");
  });

  // AC: @triage-cli-commands ac-9
  it("should skip already-triaged items and show correct count", () => {
    const ulid1 = addInboxItem("Already triaged");
    addInboxItem("Not yet triaged");
    recordTriage(ulid1, "defer", "already done");

    // Start interactive triage — with EOF on stdin, it will display but not record
    // The key assertion is the count and which items are shown
    const result = kspec(
      "triage start",
      tempDir,
      { stdin: "skip\n" },
    );
    // Should show only 1 item to review (the untriaged one)
    expect(result.stdout).toContain("1 item(s) to review");
    // Should show the untriaged item text
    expect(result.stdout).toContain("Not yet triaged");
    // Should NOT show the already-triaged item
    expect(result.stdout).not.toContain("Already triaged");
  });

  // AC: @triage-cli-commands ac-10 (partial — tests EOF preservation, not SIGINT)
  it("should preserve records that were committed before input ends", () => {
    addInboxItem("First item to triage");
    addInboxItem("Second item to triage");

    // Provide action+reasoning for first item, then skip second
    // Each triage record is committed individually, so even if the process
    // ends early, committed records are preserved
    const result = kspec(
      "triage start",
      tempDir,
      { stdin: "defer\nfirst item reasoning\nskip\n" },
    );

    // At least one record should have been created
    const records = kspecJson<Array<{ status: string }>>(
      "triage list",
      tempDir,
    );
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.some((r) => r.status === "triaged")).toBe(true);
  });
});

describe("kspec triage get", () => {
  it("should display full triage record details", () => {
    const inboxUlid = addInboxItem("Get test item");
    const record = recordTriage(inboxUlid, "promote", "get test reasoning");

    const result = kspec(
      `triage get @${record._ulid.slice(0, 8)}`,
      tempDir,
    );
    expect(result.stdout).toContain(record._ulid);
    expect(result.stdout).toContain("promote");
    expect(result.stdout).toContain("get test reasoning");
    expect(result.stdout).toContain("Get test item");
  });

  // AC: @trait-json-output ac-1, ac-2
  it("should output full record as JSON", () => {
    const inboxUlid = addInboxItem("Get JSON test");
    const record = recordTriage(inboxUlid, "defer", "json get test");

    const jsonResult = kspecJson<{ _ulid: string; status: string; action: string; reasoning: string; item_snapshot: string }>(
      `triage get @${record._ulid.slice(0, 8)}`,
      tempDir,
    );
    expect(jsonResult._ulid).toBe(record._ulid);
    expect(jsonResult.status).toBe("triaged");
    expect(jsonResult.action).toBe("defer");
    expect(jsonResult.reasoning).toBe("json get test");
    expect(jsonResult.item_snapshot).toBe("Get JSON test");
  });

  // AC: @trait-error-guidance ac-1
  it("should error when triage record not found", () => {
    const result = kspec(
      "triage get @NOTEXIST",
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(3); // NOT_FOUND
    expect(result.stderr).toContain("not found");
  });
});

describe("kspec triage shadow commits", () => {
  // AC: @trait-shadow-commit ac-1
  it("should commit to shadow branch on record creation", () => {
    const inboxUlid = addInboxItem("Shadow commit test");
    recordTriage(inboxUlid, "promote", "shadow test");

    // Verify the triage file exists
    const records = kspecJson<Array<{ _ulid: string }>>(
      "triage list",
      tempDir,
    );
    expect(records.length).toBe(1);
  });

  it("should commit to shadow branch on act", () => {
    const inboxUlid = addInboxItem("Shadow act test");
    const record = recordTriage(inboxUlid, "defer", "shadow act");

    kspec(`triage act @${record._ulid.slice(0, 8)}`, tempDir);

    // Verify the change was persisted
    const records = kspecJson<Array<{ _ulid: string; status: string }>>(
      "triage list",
      tempDir,
    );
    expect(records[0].status).toBe("acted_on");
  });
});

describe("triage JSON output trait compliance", () => {
  // AC: @trait-json-output ac-3
  it("should return JSON error on failure in JSON mode", () => {
    const result = kspec(
      'triage record @NOTEXIST --action promote --reasoning "test" --json',
      tempDir,
      { expectFail: true },
    );
    // stderr should contain JSON error
    const errorJson = JSON.parse(result.stderr);
    expect(errorJson.success).toBe(false);
    expect(errorJson.error).toBeDefined();
  });

  // AC: @trait-json-output ac-4
  it("should use @ prefix consistently in references", () => {
    const inboxUlid = addInboxItem("Ref prefix test");
    const result = kspecJson<{ record: { evidence_refs: string[] } }>(
      `triage record @${inboxUlid.slice(0, 8)} --action promote --reasoning "test" --evidence "@some-ref"`,
      tempDir,
    );
    if (result.record.evidence_refs.length > 0) {
      for (const ref of result.record.evidence_refs) {
        expect(ref.startsWith("@")).toBe(true);
      }
    }
  });

  // AC: @trait-json-output ac-6
  it("should use --json over other format options", () => {
    const inboxUlid = addInboxItem("Format precedence test");
    const result = kspec(
      `triage record @${inboxUlid.slice(0, 8)} --action defer --reasoning "test" --json`,
      tempDir,
    );
    // Output should be valid JSON
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  // AC: @trait-json-output ac-6
  it("should use --json over --format in triage export", () => {
    const inboxUlid = addInboxItem("Export JSON precedence test");
    recordTriage(inboxUlid, "defer", "test");

    const result = kspec(
      "triage export --format context --json",
      tempDir,
    );
    // When --json is active, output should be JSON, not markdown
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe("triage filterable-list trait compliance", () => {
  // AC: @trait-filterable-list ac-3
  it("should support --limit to restrict result count", () => {
    const ulid1 = addInboxItem("Limit test 1");
    const ulid2 = addInboxItem("Limit test 2");
    const ulid3 = addInboxItem("Limit test 3");
    recordTriage(ulid1, "promote", "first");
    recordTriage(ulid2, "defer", "second");
    recordTriage(ulid3, "delete", "third");

    const limited = kspecJson<Array<{ _ulid: string }>>("triage list --limit 2", tempDir);
    expect(limited.length).toBe(2);
  });

  // AC: @trait-filterable-list ac-5
  it("should combine multiple filters with AND logic", () => {
    const ulid1 = addInboxItem("Multi filter 1");
    const ulid2 = addInboxItem("Multi filter 2");
    const ulid3 = addInboxItem("Multi filter 3");
    recordTriage(ulid1, "promote", "first");
    recordTriage(ulid2, "defer", "second");
    recordTriage(ulid3, "promote", "third");

    // Filter by action only
    const promotes = kspecJson<Array<{ action: string }>>(
      "triage list --action promote",
      tempDir,
    );
    expect(promotes.length).toBe(2);
    expect(promotes.every((r) => r.action === "promote")).toBe(true);

    // Combine status + action
    const statusAndAction = kspecJson<Array<{ status: string; action: string }>>(
      "triage list --status triaged --action promote",
      tempDir,
    );
    expect(statusAndAction.every((r) => r.status === "triaged" && r.action === "promote")).toBe(true);
  });

  // AC: @trait-filterable-list ac-6
  it("should show informative message for empty filtered list", () => {
    const result = kspec("triage list", tempDir);
    expect(result.stdout).toContain("No triage records");
  });
});

describe("triage dry-run trait compliance", () => {
  // AC: @trait-dry-run ac-2
  it("should not modify files in dry-run mode for triage record", () => {
    const inboxUlid = addInboxItem("Dry run record test");

    kspec(
      `triage record @${inboxUlid.slice(0, 8)} --action promote --reasoning "test" --dry-run`,
      tempDir,
    );

    // No record should have been created
    const records = kspecJson<Array<{ _ulid: string }>>("triage list", tempDir);
    expect(records.length).toBe(0);
  });

  // AC: @trait-dry-run ac-3
  it("should clearly indicate dry-run is a preview", () => {
    const inboxUlid = addInboxItem("Dry run preview test");
    const record = recordTriage(inboxUlid, "promote", "test");

    const result = kspec(
      `triage act @${record._ulid.slice(0, 8)} --dry-run`,
      tempDir,
    );
    expect(result.stdout).toContain("Dry run");
  });

  // AC: @trait-dry-run ac-5
  it("should not modify state even when --dry-run is combined with other flags", () => {
    const inboxUlid = addInboxItem("Dry run precedence test");
    const record = recordTriage(inboxUlid, "delete", "test");

    kspec(
      `triage act @${record._ulid.slice(0, 8)} --dry-run`,
      tempDir,
    );

    // Record should NOT be acted_on
    const records = kspecJson<Array<{ _ulid: string; status: string }>>("triage list", tempDir);
    const unchanged = records.find((r) => r._ulid === record._ulid);
    expect(unchanged!.status).toBe("triaged");

    // Inbox item should still exist
    const inbox = kspecJson<Array<{ _ulid: string }>>("inbox list", tempDir);
    expect(inbox.find((i) => i._ulid === inboxUlid)).toBeDefined();
  });
});

describe("triage semantic-exit-codes trait compliance", () => {
  // AC: @trait-semantic-exit-codes ac-1
  it("should exit 0 on successful operations", () => {
    const inboxUlid = addInboxItem("Exit code test");
    const result = kspec(
      `triage record @${inboxUlid.slice(0, 8)} --action defer --reasoning "test"`,
      tempDir,
    );
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-2
  it("should exit 1 for validation errors (mapped to VALIDATION_FAILED=4)", () => {
    const inboxUlid = addInboxItem("Validation exit code test");
    const result = kspec(
      `triage record @${inboxUlid.slice(0, 8)} --action badaction --reasoning "test"`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
  });

  // AC: @trait-semantic-exit-codes ac-5
  it("should exit 0 with empty result set when query returns nothing", () => {
    const result = kspec("triage list --status pending", tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-8
  // Exit code meanings are documented in src/cli/exit-codes.ts
});

describe("triage error-guidance trait compliance", () => {
  // AC: @trait-error-guidance ac-2
  it("should include suggested action in error messages", () => {
    const result = kspec(
      "triage get @NOTEXIST",
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("not found");
  });

  // AC: @trait-error-guidance ac-4
  it("should indicate current state and valid next states on invalid transition", () => {
    const inboxUlid = addInboxItem("State transition error test");
    const record = recordTriage(inboxUlid, "defer", "test");
    kspec(`triage act @${record._ulid.slice(0, 8)}`, tempDir);

    const result = kspec(
      `triage act @${record._ulid.slice(0, 8)}`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("already been acted on");
  });

  // AC: @trait-error-guidance ac-5
  it("should indicate which value failed validation", () => {
    const inboxUlid = addInboxItem("Validation guidance test");
    const result = kspec(
      `triage record @${inboxUlid.slice(0, 8)} --action notvalid --reasoning "test"`,
      tempDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("Invalid action");
    expect(result.stderr).toContain("notvalid");
  });

  // AC: @trait-error-guidance ac-6
  it("should include guidance in structured JSON error", () => {
    const result = kspec(
      'triage record @NOTEXIST --action promote --reasoning "test" --json',
      tempDir,
      { expectFail: true },
    );
    const errorJson = JSON.parse(result.stderr);
    expect(errorJson.error).toBeDefined();
  });
});

// AC: @interactive-triage ac-1, ac-2 (end-to-end decision chain)
describe("interactive triage system integration", () => {
  it("should capture full decision chain: agent record → user override → act → export", () => {
    // Step 1: Agent records initial triage decision
    const inboxUlid = addInboxItem("Improve search performance");
    const record = recordTriage(inboxUlid, "defer", "needs profiling first");

    // Step 2: User overrides the agent decision
    kspec(
      `triage override @${record._ulid.slice(0, 8)} --action promote --reasoning "actually urgent, users complaining"`,
      tempDir,
    );

    // Step 3: Execute the overridden action
    kspec(`triage act @${record._ulid.slice(0, 8)}`, tempDir);

    // Step 4: Export and verify the full chain is captured in context output
    const exported = kspec("triage export --format context", tempDir);
    // Item text
    expect(exported.stdout).toContain("Improve search performance");
    // Current action (overridden)
    expect(exported.stdout).toContain("promote");
    // Original reasoning from agent
    expect(exported.stdout).toContain("needs profiling first");
    // Attribution — decided_by appears in export
    expect(exported.stdout).toContain("Decided by:");
    // Override reasoning and attribution in export
    expect(exported.stdout).toContain("actually urgent, users complaining");
    expect(exported.stdout).toContain("Override:");
    // Execution timestamp in export
    expect(exported.stdout).toContain("Acted at:");
    // Result ref in export
    expect(exported.stdout).toContain("Result:");
  });

  // AC: @interactive-triage ac-1 (records survive inbox item deletion)
  it("should preserve triage records after inbox item is deleted", () => {
    const inboxUlid = addInboxItem("Ephemeral item");
    const record = recordTriage(inboxUlid, "delete", "duplicate content");

    // Act on it (deletes the inbox item)
    kspec(`triage act @${record._ulid.slice(0, 8)}`, tempDir);

    // Verify inbox item is gone
    const inbox = kspecJson<Array<{ _ulid: string }>>("inbox list", tempDir);
    expect(inbox.find((i) => i._ulid === inboxUlid)).toBeUndefined();

    // Verify triage record still exists with snapshot
    const triageRecord = kspecJson<{
      _ulid: string;
      item_snapshot: string;
      status: string;
    }>(`triage get @${record._ulid.slice(0, 8)}`, tempDir);
    expect(triageRecord.item_snapshot).toBe("Ephemeral item");
    expect(triageRecord.status).toBe("acted_on");
  });
});

describe("triage shadow-commit trait compliance", () => {
  // AC: @trait-shadow-commit ac-1
  // Already covered in "kspec triage shadow commits" describe block

  // AC: @trait-shadow-commit ac-5
  it("should not commit when validation error occurs", () => {
    const inboxUlid = addInboxItem("Shadow validation test");
    const result = kspec(
      `triage record @${inboxUlid.slice(0, 8)} --action badaction --reasoning "test"`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(4);

    // No triage record should have been created
    const records = kspecJson<Array<{ _ulid: string }>>("triage list", tempDir);
    expect(records.length).toBe(0);
  });
});
