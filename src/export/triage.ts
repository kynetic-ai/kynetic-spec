/**
 * Triage Export Formatter
 *
 * Shared formatter for triage record exports, used by both CLI and daemon API.
 * Two formats: structured JSON and markdown context block.
 *
 * AC: @triage-agent-export ac-1, ac-2, ac-3, ac-4
 */

import type { TriageRecord } from "../schema/triage.js";

/**
 * Truncate text to a maximum length, taking only the first line.
 */
export function truncateText(text: string, maxLen: number = 60): string {
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return `${firstLine.slice(0, maxLen - 3)}...`;
}

/**
 * Format a single triage record as a markdown context block.
 * AC: @triage-agent-export ac-1
 * AC: @triage-agent-export ac-3
 */
export function formatTriageRecordContext(record: TriageRecord): string {
  const lines: string[] = [];
  lines.push(`### ${record._ulid.slice(0, 8)} — ${truncateText(record.item_snapshot, 80)}`);
  lines.push("");
  lines.push(`**Item:** ${record.item_snapshot}`);
  lines.push(`**Status:** ${record.status}`);
  if (record.action) lines.push(`**Action:** ${record.action}`);
  if (record.reasoning) lines.push(`**Reasoning:** ${record.reasoning}`);
  if (record.decided_by) lines.push(`**Decided by:** ${record.decided_by}`);
  if (record.evidence_refs.length > 0) {
    lines.push(`**Evidence:** ${record.evidence_refs.join(", ")}`);
  }
  // AC: @triage-agent-export ac-3 — include override information
  if (record.override_reasoning) {
    lines.push(`**Override:** ${record.override_reasoning} (by ${record.override_by || "unknown"})`);
  }
  if (record.acted_at) {
    lines.push(`**Acted at:** ${record.acted_at}`);
    if (record.result_ref) lines.push(`**Result:** ${record.result_ref}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Export triage records in context (markdown) format.
 * AC: @triage-agent-export ac-1 — markdown block per record
 * AC: @triage-agent-export ac-3 — overrides included
 * AC: @triage-agent-export ac-4 — empty result message
 */
export function exportTriageAsContext(records: TriageRecord[]): string {
  if (records.length === 0) {
    return "No triage decisions recorded.";
  }
  let content = "# Triage Decisions\n\n";
  for (const record of records) {
    content += formatTriageRecordContext(record);
  }
  return content;
}

/**
 * Export result for JSON format.
 * AC: @triage-agent-export ac-2 — JSON array with full objects
 * AC: @triage-agent-export ac-3 — overrides included (full objects)
 * AC: @triage-agent-export ac-4 — empty array when no records
 */
export interface TriageJsonExport {
  format: "json";
  items: TriageRecord[];
  total: number;
}

/**
 * Export result for context format.
 */
export interface TriageContextExport {
  format: "context";
  content: string;
}

export type TriageExportResult = TriageJsonExport | TriageContextExport;

/**
 * Export triage records in the requested format.
 * AC: @triage-agent-export ac-1, ac-2, ac-3, ac-4
 */
export function exportTriageRecords(
  records: TriageRecord[],
  format: "json" | "context",
): TriageExportResult {
  if (format === "context") {
    return {
      format: "context",
      content: exportTriageAsContext(records),
    };
  }
  return {
    format: "json",
    items: records,
    total: records.length,
  };
}
