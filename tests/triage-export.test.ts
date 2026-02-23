/**
 * Triage Export Formatter Tests
 *
 * Tests for the shared triage export formatter used by both CLI and daemon API.
 * AC: @triage-agent-export ac-1, ac-2, ac-3, ac-4
 */

import { describe, expect, it } from "vitest";
import type { TriageRecord } from "../src/schema/triage.js";
import {
  exportTriageAsContext,
  exportTriageRecords,
  formatTriageRecordContext,
} from "../src/export/triage.js";

function makeRecord(overrides: Partial<TriageRecord> = {}): TriageRecord {
  return {
    _ulid: "01TESTUL1D000000000000000",
    inbox_ref: "01INBOXRE000000000000000F",
    item_snapshot: "Test inbox item for triage",
    status: "triaged",
    action: "promote",
    reasoning: "This should become a task",
    decided_by: "@claude",
    evidence_refs: [],
    created_at: "2026-02-22T20:00:00.000Z",
    ...overrides,
  };
}

describe("formatTriageRecordContext", () => {
  // AC: @triage-agent-export ac-1
  it("formats a single record as markdown with required fields", () => {
    const record = makeRecord();
    const output = formatTriageRecordContext(record);

    expect(output).toContain("### 01TESTU");
    expect(output).toContain("**Item:** Test inbox item for triage");
    expect(output).toContain("**Status:** triaged");
    expect(output).toContain("**Action:** promote");
    expect(output).toContain("**Reasoning:** This should become a task");
    expect(output).toContain("**Decided by:** @claude");
  });

  // AC: @triage-agent-export ac-1
  it("includes evidence refs when present", () => {
    const record = makeRecord({ evidence_refs: ["@spec-foo", "@task-bar"] });
    const output = formatTriageRecordContext(record);

    expect(output).toContain("**Evidence:** @spec-foo, @task-bar");
  });

  // AC: @triage-agent-export ac-3
  it("includes both original decision and override information", () => {
    const record = makeRecord({
      reasoning: "Agent says promote",
      decided_by: "@claude",
      override_reasoning: "Actually should defer",
      override_by: "@human",
      override_at: "2026-02-22T21:00:00.000Z",
    });
    const output = formatTriageRecordContext(record);

    // Original decision fields
    expect(output).toContain("**Reasoning:** Agent says promote");
    expect(output).toContain("**Decided by:** @claude");
    // Override fields
    expect(output).toContain("**Override:** Actually should defer (by @human)");
  });

  // AC: @triage-agent-export ac-3
  it("shows override by unknown when override_by missing", () => {
    const record = makeRecord({
      override_reasoning: "Override without author",
    });
    const output = formatTriageRecordContext(record);
    expect(output).toContain("**Override:** Override without author (by unknown)");
  });

  // AC: @triage-agent-export ac-1
  it("includes acted_at and result_ref for acted records", () => {
    const record = makeRecord({
      status: "acted_on",
      acted_at: "2026-02-22T22:00:00.000Z",
      result_ref: "@task-new-thing",
    });
    const output = formatTriageRecordContext(record);

    expect(output).toContain("**Acted at:** 2026-02-22T22:00:00.000Z");
    expect(output).toContain("**Result:** @task-new-thing");
  });

  // AC: @triage-agent-export ac-1
  it("truncates long item snapshots in heading", () => {
    const longText = "A".repeat(100);
    const record = makeRecord({ item_snapshot: longText });
    const output = formatTriageRecordContext(record);
    const heading = output.split("\n")[0];

    // Heading should be truncated but full text appears in Item field
    expect(heading.length).toBeLessThan(120);
    expect(output).toContain(`**Item:** ${longText}`);
  });

  it("omits optional fields when not present", () => {
    const record = makeRecord({
      action: undefined,
      reasoning: undefined,
      decided_by: undefined,
      evidence_refs: [],
      override_reasoning: undefined,
      acted_at: undefined,
      status: "pending",
    });
    const output = formatTriageRecordContext(record);

    expect(output).not.toContain("**Action:");
    expect(output).not.toContain("**Reasoning:");
    expect(output).not.toContain("**Decided by:");
    expect(output).not.toContain("**Evidence:");
    expect(output).not.toContain("**Override:");
    expect(output).not.toContain("**Acted at:");
    // Required fields still present
    expect(output).toContain("**Item:**");
    expect(output).toContain("**Status:** pending");
  });
});

describe("exportTriageAsContext", () => {
  // AC: @triage-agent-export ac-1
  it("produces markdown with header and per-record blocks", () => {
    const records = [
      makeRecord({ _ulid: "01TESTUL1D000000000000001" }),
      makeRecord({ _ulid: "01TESTUL1D000000000000002" }),
    ];
    const output = exportTriageAsContext(records);

    expect(output).toContain("# Triage Decisions");
    expect(output).toContain("### 01TESTU");
    // Should have two record blocks
    const headings = output.match(/^### /gm);
    expect(headings).toHaveLength(2);
  });

  // AC: @triage-agent-export ac-4
  it("returns empty message when no records exist", () => {
    const output = exportTriageAsContext([]);
    expect(output).toBe("No triage decisions recorded.");
  });
});

describe("exportTriageRecords", () => {
  // AC: @triage-agent-export ac-1
  it("returns context format with markdown content", () => {
    const records = [makeRecord()];
    const result = exportTriageRecords(records, "context");

    expect(result.format).toBe("context");
    expect(result).toHaveProperty("content");
    if (result.format === "context") {
      expect(result.content).toContain("# Triage Decisions");
      expect(result.content).toContain("**Action:** promote");
    }
  });

  // AC: @triage-agent-export ac-2
  // The shared formatter returns an envelope { format, items, total } for API consumers.
  // CLI extracts `items` and outputs as raw JSON array via JSON.stringify(result.items).
  // The `items` field IS the JSON array of full TriageRecord objects per ac-2.
  it("returns json format with full TriageRecord objects in items array", () => {
    const records = [makeRecord(), makeRecord({ _ulid: "01TESTUL1D000000000000002" })];
    const result = exportTriageRecords(records, "json");

    expect(result.format).toBe("json");
    if (result.format === "json") {
      // items is the JSON array per ac-2
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      // Verify items array is directly serializable as JSON array
      const jsonArray = JSON.stringify(result.items, null, 2);
      const parsed = JSON.parse(jsonArray);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      // Full object fields present per ac-2
      expect(result.items[0]).toHaveProperty("_ulid");
      expect(result.items[0]).toHaveProperty("inbox_ref");
      expect(result.items[0]).toHaveProperty("item_snapshot");
      expect(result.items[0]).toHaveProperty("status");
      expect(result.items[0]).toHaveProperty("action");
      expect(result.items[0]).toHaveProperty("reasoning");
      expect(result.items[0]).toHaveProperty("decided_by");
      expect(result.items[0]).toHaveProperty("evidence_refs");
      expect(result.items[0]).toHaveProperty("created_at");
    }
  });

  // AC: @triage-agent-export ac-3
  it("includes override fields in json export", () => {
    const records = [
      makeRecord({
        override_reasoning: "Human disagrees",
        override_by: "@human",
        override_at: "2026-02-22T21:00:00.000Z",
      }),
    ];
    const result = exportTriageRecords(records, "json");

    if (result.format === "json") {
      expect(result.items[0].override_reasoning).toBe("Human disagrees");
      expect(result.items[0].override_by).toBe("@human");
      expect(result.items[0].override_at).toBe("2026-02-22T21:00:00.000Z");
    }
  });

  // AC: @triage-agent-export ac-4
  it("returns empty result for json format with no records", () => {
    const result = exportTriageRecords([], "json");

    if (result.format === "json") {
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    }
  });

  // AC: @triage-agent-export ac-4
  it("returns empty message for context format with no records", () => {
    const result = exportTriageRecords([], "context");

    if (result.format === "context") {
      expect(result.content).toBe("No triage decisions recorded.");
    }
  });
});

describe("trait: json-output", () => {
  // AC: @trait-json-output ac-1
  it("json format output contains no ANSI codes", () => {
    const records = [makeRecord()];
    const result = exportTriageRecords(records, "json");

    if (result.format === "json") {
      const json = JSON.stringify(result.items, null, 2);
      // eslint-disable-next-line no-control-regex
      expect(json).not.toMatch(/\x1b\[/);
    }
  });

  // AC: @trait-json-output ac-2
  it("json format includes all data available in context format", () => {
    const record = makeRecord({
      evidence_refs: ["@spec-foo"],
      override_reasoning: "Override test",
      override_by: "@user",
      acted_at: "2026-02-22T22:00:00.000Z",
      result_ref: "@task-result",
    });
    const jsonResult = exportTriageRecords([record], "json");
    const contextResult = exportTriageRecords([record], "context");

    if (jsonResult.format === "json" && contextResult.format === "context") {
      // Every field shown in context should be in JSON
      expect(jsonResult.items[0].item_snapshot).toBe(record.item_snapshot);
      expect(jsonResult.items[0].status).toBe(record.status);
      expect(jsonResult.items[0].action).toBe(record.action);
      expect(jsonResult.items[0].reasoning).toBe(record.reasoning);
      expect(jsonResult.items[0].decided_by).toBe(record.decided_by);
      expect(jsonResult.items[0].evidence_refs).toEqual(record.evidence_refs);
      expect(jsonResult.items[0].override_reasoning).toBe(record.override_reasoning);
      expect(jsonResult.items[0].override_by).toBe(record.override_by);
      expect(jsonResult.items[0].acted_at).toBe(record.acted_at);
      expect(jsonResult.items[0].result_ref).toBe(record.result_ref);
    }
  });

  // AC: @trait-json-output ac-4
  it("references in json output use @ prefix", () => {
    const record = makeRecord({ evidence_refs: ["@spec-foo", "@task-bar"] });
    const result = exportTriageRecords([record], "json");

    if (result.format === "json") {
      for (const ref of result.items[0].evidence_refs) {
        expect(ref).toMatch(/^@/);
      }
    }
  });

  // AC: @trait-json-output ac-5
  it("timestamps in json output use ISO 8601 format", () => {
    const record = makeRecord({
      created_at: "2026-02-22T20:00:00.000Z",
      acted_at: "2026-02-22T22:00:00.000Z",
    });
    const result = exportTriageRecords([record], "json");

    if (result.format === "json") {
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(result.items[0].created_at).toMatch(isoRegex);
      expect(result.items[0].acted_at).toMatch(isoRegex);
    }
  });

  // AC: @trait-json-output ac-3 — N/A: shared formatter receives pre-validated records;
  // error-as-JSON handling is at the CLI/API layer (see triage-cli.test.ts, daemon-api-triage.test.ts)

  // AC: @trait-json-output ac-6 — N/A: shared formatter receives format parameter directly;
  // --json flag precedence is handled at the CLI layer (see triage-cli.test.ts)
});
