/**
 * Shared inbox test helpers.
 *
 * Extracted from session-start-computed-json.test.ts and session-start-inbox-triage.test.ts
 * where these helpers were duplicated identically.
 */
import { kspec, kspecJson } from './cli';

/**
 * Add an inbox item and return its full ULID.
 */
export function addInboxItem(tempDir: string, text: string): string {
  const result = kspecJson<{ item: { _ulid: string } }>(
    `inbox add "${text}"`,
    tempDir,
  );
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
  kspec(
    `triage record @${inboxUlid} --action ${action} --reasoning "${reasoning}"`,
    tempDir,
  );
}
