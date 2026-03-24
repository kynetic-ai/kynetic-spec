/**
 * Shared inbox test helpers.
 *
 * Extracted from session-start-computed-json.test.ts and session-start-inbox-triage.test.ts
 * where these helpers were duplicated identically.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { kspec, kspecJson } from "./cli";

/**
 * Add an inbox item and return its full ULID.
 */
export function addInboxItem(tempDir: string, text: string): string {
  const result = kspecJson<{ item: { _ulid: string } }>(`inbox add "${text}"`, tempDir);
  return result.item._ulid;
}

/**
 * Create a triage record for an inbox item.
 * Uses full ULID to avoid prefix collisions when items are created quickly.
 */
export function triageItem(
  tempDir: string,
  inboxUlid: string,
  action: string,
  reasoning: string,
): void {
  kspec(`triage record @${inboxUlid} --action ${action} --reasoning "${reasoning}"`, tempDir);
}

/**
 * Seed inbox items by writing project.inbox.yaml directly.
 *
 * Much faster than spawning `kspec inbox add` for each item — use this when
 * tests need inbox state as setup but aren't testing the inbox CLI itself.
 */
export function seedInboxItems(
  tempDir: string,
  items: Array<{
    _ulid: string;
    text: string;
    tags?: string[];
    created_at?: string;
  }>,
): void {
  writeFileSync(
    path.join(tempDir, "project.inbox.yaml"),
    yamlStringify({
      inbox: items.map((item) => ({
        _ulid: item._ulid,
        text: item.text,
        created_at: item.created_at ?? "2026-01-01T00:00:00.000Z",
        tags: item.tags ?? [],
        added_by: "@test",
      })),
    }),
  );
}

/**
 * Seed triage records by writing project.triage.yaml directly.
 *
 * Much faster than spawning `kspec triage record` for each item — use this when
 * tests need triage state as setup but aren't testing the triage CLI itself.
 */
export function seedTriageRecords(
  tempDir: string,
  records: Array<{
    _ulid: string;
    inbox_ref: string;
    item_snapshot: string;
    action: string;
    reasoning: string;
    created_at?: string;
  }>,
): void {
  writeFileSync(
    path.join(tempDir, "project.triage.yaml"),
    yamlStringify({
      kynetic_triage: "1.0",
      triage: records.map((r) => ({
        _ulid: r._ulid,
        inbox_ref: r.inbox_ref,
        item_snapshot: r.item_snapshot,
        status: "triaged",
        action: r.action,
        reasoning: r.reasoning,
        decided_by: "@test",
        evidence_refs: [],
        created_at: r.created_at ?? "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}
