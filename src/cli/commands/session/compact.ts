/**
 * Session compact command.
 *
 * Rewrites events.jsonl by running existing events through the same
 * oversized-payload externalization pipeline used by appendEvent().
 */

import {
  initContext,
} from "../../../parser/index.js";
import { commitIfShadow } from "../../../parser/shadow.js";
import {
  compactSessionEvents,
  getAllSessionLogSummaries,
  getSession,
  resolveSessionId,
  type CompactSessionEventsResult,
} from "../../../sessions/store.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { error, info, isJsonMode, output, warn } from "../../output.js";

interface SessionCompactOptions {
  all?: boolean;
  dryRun?: boolean;
}

interface SessionCompactionEntry {
  session_id: string;
  status:
    | "compacted"
    | "would_compact"
    | "already_compacted"
    | "empty_events_file"
    | "missing_events_file"
    | "skipped_active"
    | "error";
  dry_run: boolean;
  changed: boolean;
  events_processed: number;
  blobs_created: number;
  bytes_before: number;
  bytes_after: number;
  bytes_reclaimed: number;
  error?: string;
}

function toEntry(
  sessionId: string,
  result: CompactSessionEventsResult,
): SessionCompactionEntry {
  return {
    session_id: sessionId,
    status: result.reason,
    dry_run: result.dry_run,
    changed: result.changed,
    events_processed: result.events_processed,
    blobs_created: result.blobs_created,
    bytes_before: result.bytes_before,
    bytes_after: result.bytes_after,
    bytes_reclaimed: result.bytes_reclaimed,
  };
}

function printEntry(entry: SessionCompactionEntry): void {
  const shortId = entry.session_id.slice(0, 8);
  if (entry.status === "skipped_active") {
    warn(`[${shortId}] skipped (active session)`);
    return;
  }
  if (entry.status === "error") {
    warn(`[${shortId}] failed: ${entry.error}`);
    return;
  }
  const reclaimed = entry.bytes_reclaimed.toLocaleString();
  const before = entry.bytes_before.toLocaleString();
  const after = entry.bytes_after.toLocaleString();
  info(
    `[${shortId}] ${entry.status} | events=${entry.events_processed} blobs=${entry.blobs_created} bytes=${before}->${after} reclaimed=${reclaimed}`,
  );
}

export async function sessionCompactAction(
  sessionIdOrPrefix: string | undefined,
  options: SessionCompactOptions,
): Promise<void> {
  try {
    const ctx = await initContext();
    const dryRun = options.dryRun === true;

    if (options.all && sessionIdOrPrefix) {
      error("Cannot provide <session-id> together with --all");
      process.exit(EXIT_CODES.USAGE_ERROR);
    }

    if (!options.all && !sessionIdOrPrefix) {
      error("Provide <session-id> or use --all");
      process.exit(EXIT_CODES.USAGE_ERROR);
    }

    const targetSessionIds: string[] = [];
    if (options.all) {
      const summaries = await getAllSessionLogSummaries(ctx.sessionsDir);
      targetSessionIds.push(...summaries.map((s) => s.id));
    } else {
      const resolution = await resolveSessionId(ctx.sessionsDir, sessionIdOrPrefix!);
      if (!resolution.ok) {
        if (resolution.error === "not_found") {
          error(`Session not found: ${sessionIdOrPrefix}`);
        } else {
          error(
            `Session prefix "${sessionIdOrPrefix}" is ambiguous: ${resolution.matches.join(", ")}`,
          );
        }
        process.exit(EXIT_CODES.NOT_FOUND);
      }
      targetSessionIds.push(resolution.id);
    }

    const entries: SessionCompactionEntry[] = [];
    let failures = 0;
    for (let idx = 0; idx < targetSessionIds.length; idx += 1) {
      const sessionId = targetSessionIds[idx];
      const metadata = await getSession(ctx.sessionsDir, sessionId);
      if (!metadata) {
        if (!options.all) {
          error(`Session not found: ${sessionId}`);
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        entries.push({
          session_id: sessionId,
          status: "error",
          dry_run: dryRun,
          changed: false,
          events_processed: 0,
          blobs_created: 0,
          bytes_before: 0,
          bytes_after: 0,
          bytes_reclaimed: 0,
          error: "Session metadata not found",
        });
        failures += 1;
        continue;
      }

      if (options.all && !isJsonMode()) {
        info(`[${idx + 1}/${targetSessionIds.length}] Processing ${sessionId.slice(0, 8)}...`);
      }

      if (metadata.status === "active") {
        if (!options.all) {
          error(
            `Cannot compact active session ${sessionId}. End the session first to avoid data loss.`,
          );
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }
        entries.push({
          session_id: sessionId,
          status: "skipped_active",
          dry_run: dryRun,
          changed: false,
          events_processed: 0,
          blobs_created: 0,
          bytes_before: 0,
          bytes_after: 0,
          bytes_reclaimed: 0,
        });
        continue;
      }

      try {
        const result = await compactSessionEvents(ctx.sessionsDir, sessionId, {
          dryRun,
        });
        entries.push(toEntry(sessionId, result));
      } catch (err: unknown) {
        if (!options.all) {
          throw err;
        }
        entries.push({
          session_id: sessionId,
          status: "error",
          dry_run: dryRun,
          changed: false,
          events_processed: 0,
          blobs_created: 0,
          bytes_before: 0,
          bytes_after: 0,
          bytes_reclaimed: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        failures += 1;
      }
    }

    const changedEntries = entries.filter((e) => e.changed);
    if (!dryRun && changedEntries.length > 0) {
      await commitIfShadow(
        ctx.shadow,
        "session-compact",
        options.all ? "all" : entries[0]?.session_id.slice(0, 8),
        `${changedEntries.length} session(s) compacted`,
      );
    }

    const processedEntries = entries.filter(
      (e) => e.status !== "skipped_active" && e.status !== "error",
    );
    const payload = {
      dry_run: dryRun,
      all: options.all === true,
      session: options.all ? undefined : entries[0],
      sessions: options.all ? entries : undefined,
      totals: {
        sessions_total: entries.length,
        sessions_processed: processedEntries.length,
        sessions_changed: changedEntries.length,
        sessions_skipped_active: entries.filter((e) => e.status === "skipped_active").length,
        sessions_failed: failures,
        events_processed: processedEntries.reduce((sum, e) => sum + e.events_processed, 0),
        blobs_created: processedEntries.reduce((sum, e) => sum + e.blobs_created, 0),
        bytes_before: processedEntries.reduce((sum, e) => sum + e.bytes_before, 0),
        bytes_after: processedEntries.reduce((sum, e) => sum + e.bytes_after, 0),
        bytes_reclaimed: processedEntries.reduce((sum, e) => sum + e.bytes_reclaimed, 0),
      },
    };

    output(payload, () => {
      if (dryRun) {
        info("Dry run preview - no files were modified.");
      }
      if (options.all) {
        for (const entry of entries) {
          printEntry(entry);
        }
        const t = payload.totals;
        console.log("");
        console.log("Compaction summary:");
        console.log(`  Sessions processed: ${t.sessions_processed}/${t.sessions_total}`);
        console.log(`  Sessions changed:   ${t.sessions_changed}`);
        console.log(`  Blobs created:      ${t.blobs_created}`);
        console.log(`  Bytes reclaimed:    ${t.bytes_reclaimed.toLocaleString()}`);
        if (t.sessions_skipped_active > 0) {
          console.log(`  Skipped active:     ${t.sessions_skipped_active}`);
        }
        if (t.sessions_failed > 0) {
          console.log(`  Failed:             ${t.sessions_failed}`);
        }
      } else if (entries[0]) {
        const e = entries[0];
        console.log(`Session: ${e.session_id}`);
        console.log(`Status:  ${e.status}`);
        console.log(`Events:  ${e.events_processed}`);
        console.log(`Blobs:   ${e.blobs_created}`);
        console.log(`Bytes:   ${e.bytes_before.toLocaleString()} -> ${e.bytes_after.toLocaleString()}`);
        console.log(`Saved:   ${e.bytes_reclaimed.toLocaleString()} bytes`);
      }
    });

    if (failures > 0) {
      process.exit(EXIT_CODES.ERROR);
    }
  } catch (err) {
    error("Failed to compact session events", err);
    // AC: @trait-semantic-exit-codes ac-4
    // Runtime failures map to exit code 3 for this trait.
    process.exit(EXIT_CODES.NOT_FOUND);
  }
}
