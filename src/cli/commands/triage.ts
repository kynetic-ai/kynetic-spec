import * as readline from "node:readline";
import { ulid } from "ulid";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  initContext,
  type LoadedTriageRecord,
  loadInboxItems,
  loadTriageRecords,
  saveTriageRecord,
  findInboxItemByRef,
  findTriageRecordByInboxRef,
  findTriageRecordByRef,
  shortestUniqueUlid,
} from "../../parser/index.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { normalizeRefInput, TriageActionSchema, TriageStatusSchema } from "../../schema/index.js";
import type { TriageAction } from "../../schema/index.js";
import { exportTriageAsContext, truncateText } from "../../export/triage.js";
import { errors } from "../../strings/index.js";
import { formatRelativeTime as formatRelativeTimeUtil } from "../../utils/time.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, output, success } from "../output.js";
import { resolveCliActor } from "../actor.js";
import { validateEnumOption } from "../validators.js";
import { executeTriageAction, VALID_ACTIONS } from "../../triage/index.js";

/**
 * Format relative time for display
 */
function formatRelativeTime(dateStr: string): string {
  return formatRelativeTimeUtil(new Date(dateStr));
}

/**
 * Resolve triage record ref with error handling
 */
function resolveTriageRef(ref: string, records: LoadedTriageRecord[]): LoadedTriageRecord {
  const record = findTriageRecordByRef(records, ref);
  if (!record) {
    error(`Triage record not found: ${ref}`);
    process.exit(EXIT_CODES.NOT_FOUND);
  }
  return record;
}

function shortRecordRef(record: LoadedTriageRecord, records: LoadedTriageRecord[]): string {
  return shortestUniqueUlid(
    record._ulid,
    records.map((r) => r._ulid),
  );
}

async function persistAndReloadTriageRecord(
  ctx: Awaited<ReturnType<typeof initContext>>,
  record: LoadedTriageRecord,
): Promise<{
  persistedRecord: LoadedTriageRecord;
  records: LoadedTriageRecord[];
}> {
  await saveTriageRecord(ctx, record);
  const records = await loadTriageRecords(ctx);
  const persistedRecord = findTriageRecordByInboxRef(records, record.inbox_ref);

  if (!persistedRecord) {
    throw new Error(
      `Persisted triage record for inbox item ${record.inbox_ref} was not found after save`,
    );
  }

  return { persistedRecord, records };
}

// truncateText imported from shared export/triage.ts
// executeTriageAction and VALID_ACTIONS imported from shared triage module

/**
 * Register the 'triage' command group
 * AC: @triage-cli-commands ac-1 through ac-17
 */
export function registerTriageCommands(program: Command): void {
  const triage = program
    .command("triage")
    .description("Record, review, and act on triage decisions");

  // kspec triage record <inbox-ref>
  // AC: @triage-cli-commands ac-1, ac-11
  markMutating(triage.command("record <inbox-ref>"))
    .description("Record a triage decision for an inbox item")
    .requiredOption(
      "--action <action>",
      "Triage action (promote, delete, defer, spec-gap, duplicate)",
    )
    .requiredOption("--reasoning <text>", "Reasoning for the decision")
    .option("--decided-by <author>", "Who made the decision")
    .option("--evidence <refs...>", "Evidence references")
    .option("--dry-run", "Show what would happen without making changes")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec triage record @ref --action promote --reasoning "clear feature request"
  $ kspec triage record @ref --action defer --reasoning "needs more discussion"`,
    )
    .action(async (inboxRef: string, options) => {
      try {
        const ctx = await initContext();

        // Validate action
        if (!VALID_ACTIONS.includes(options.action)) {
          error(`Invalid action: ${options.action}. Must be one of: ${VALID_ACTIONS.join(", ")}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // Resolve inbox item
        const inboxItems = await loadInboxItems(ctx);
        const inboxUlids = inboxItems.map((inboxItem) => inboxItem._ulid);
        const item = findInboxItemByRef(inboxItems, inboxRef);
        if (!item) {
          error(errors.reference.inboxNotFound(inboxRef));
          process.exit(EXIT_CODES.NOT_FOUND);
        }
        const inboxRefDisplay = shortestUniqueUlid(item._ulid, inboxUlids);

        if (options.dryRun) {
          info(
            `Would create triage record for inbox item ${inboxRefDisplay} with action: ${options.action}`,
          );
          return;
        }

        // AC: @actor-identity-resolution ac-7 ac-8 — canonical decided_by or rejection.
        const author = await resolveCliActor(ctx, options.decidedBy, "decided_by");
        const evidenceRefs = options.evidence ? options.evidence.map(normalizeRefInput) : [];

        const record: LoadedTriageRecord = {
          _ulid: ulid(),
          inbox_ref: item._ulid,
          item_snapshot: item.text,
          status: "triaged",
          action: options.action as TriageAction,
          reasoning: options.reasoning,
          decided_by: author,
          evidence_refs: evidenceRefs,
          created_at: new Date().toISOString(),
        };

        const { persistedRecord, records } = await persistAndReloadTriageRecord(ctx, record);
        await commitIfShadow(
          ctx.shadow,
          "triage-record",
          persistedRecord._ulid.slice(0, 8),
          options.action,
        );

        const createdRef = shortRecordRef(persistedRecord, records);

        // AC: @triage-cli-commands ac-11 — JSON output
        // AC: @trait-json-output ac-1, ac-2, ac-4, ac-5
        success(`Recorded triage decision: ${createdRef}`, { record: persistedRecord });
      } catch (err) {
        error("Failed to record triage decision", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec triage list
  // AC: @triage-cli-commands ac-2, ac-3
  triage
    .command("list")
    .description("List triage records")
    .option("--status <status>", "Filter by status (pending, triaged, acted_on)")
    .option("--action <action>", "Filter by action")
    .option("--decided-by <author>", "Filter by decision author")
    .option("--limit <n>", "Limit results")
    .option("--offset <n>", "Skip first N results")
    .option("--count", "Show only the count")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        let records = await loadTriageRecords(ctx);
        const allRecordUlids = records.map((record) => record._ulid);
        const totalCount = records.length;
        const activeFilters: string[] = [];
        // oxlint-disable-next-line eslint/prefer-const -- assigned conditionally later
        let filteredCount: number;

        // AC: @triage-cli-commands ac-3 — status filter
        // AC: @trait-filterable-list ac-1
        if (options.status) {
          const statusResult = validateEnumOption(
            options.status,
            TriageStatusSchema.options,
            "triage status",
          );
          if (!statusResult.ok) {
            error(statusResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          records = records.filter((r) => r.status === statusResult.value);
          activeFilters.push(`status=${statusResult.value}`);
        }

        // AC: @trait-filterable-list ac-5
        if (options.action) {
          const actionResult = validateEnumOption(
            options.action,
            TriageActionSchema.options,
            "triage action",
          );
          if (!actionResult.ok) {
            error(actionResult.error);
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          records = records.filter((r) => r.action === actionResult.value);
          activeFilters.push(`action=${actionResult.value}`);
        }

        if (options.decidedBy) {
          records = records.filter((r) => r.decided_by === options.decidedBy);
          activeFilters.push(`decided_by=${options.decidedBy}`);
        }

        // Sort by created_at desc (newest first)
        records.sort((a, b) => {
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });

        // Capture post-filter count before pagination
        filteredCount = records.length;

        // AC: @trait-filterable-list ac-8
        if (options.count) {
          output({ count: records.length }, () => {
            console.log(records.length);
          });
          return;
        }

        // AC: @trait-filterable-list ac-4 — offset
        if (options.offset) {
          const offset = parseInt(options.offset, 10);
          records = records.slice(offset);
        }

        // AC: @trait-filterable-list ac-3 — limit
        if (options.limit) {
          const limit = parseInt(options.limit, 10);
          records = records.slice(0, limit);
        }

        // AC: @trait-json-output ac-1, ac-2
        output(records, () => {
          if (records.length === 0) {
            // AC: @trait-filterable-list ac-6
            console.log("No triage records");
            return;
          }

          // AC: @trait-filterable-list ac-7 — summary with total matching items and filter state
          const filterInfo = activeFilters.length > 0 ? ` (${activeFilters.join(", ")})` : "";
          const showing =
            filteredCount < totalCount ? `${filteredCount} of ${totalCount}` : `${filteredCount}`;
          console.log(`Triage records (${showing}${filterInfo}):\n`);

          // AC: @triage-cli-commands ac-2
          for (const record of records) {
            const snapshot = truncateText(record.item_snapshot, 50);
            const age = formatRelativeTime(record.created_at);
            const action = record.action ? ` [${record.action}]` : "";
            const decidedBy = record.decided_by ? ` by ${record.decided_by}` : "";
            const recordRef = shortestUniqueUlid(record._ulid, allRecordUlids);
            console.log(`  ${recordRef} (${age}${decidedBy}) ${record.status}${action}`);
            console.log(`    ${snapshot}`);
            console.log("");
          }
        });
      } catch (err) {
        error("Failed to list triage records", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec triage act <triage-ref>
  // AC: @triage-cli-commands ac-4, ac-5, ac-6, ac-7, ac-8, ac-15, ac-16, ac-17
  markMutating(triage.command("act <triage-ref>"))
    .description("Execute a triage decision")
    .option("--dry-run", "Show what would happen without executing")
    .option("--keep", "Keep inbox item after promote")
    .action(async (triageRef: string, options) => {
      try {
        const ctx = await initContext();
        const records = await loadTriageRecords(ctx);
        const record = resolveTriageRef(triageRef, records);
        const recordRef = shortRecordRef(record, records);

        // AC: @triage-cli-commands ac-15 — already acted on
        // AC: @trait-error-guidance ac-1, ac-2
        if (record.status === "acted_on") {
          error(
            `Triage record ${recordRef} has already been acted on. No further action is possible.`,
          );
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @triage-cli-commands ac-16 — no decision yet
        // AC: @trait-error-guidance ac-1, ac-2
        if (record.status === "pending") {
          error(
            `Triage record ${recordRef} has no decision yet. Record a decision first with: kspec triage record <inbox-ref> --action <action> --reasoning <text>`,
          );
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @triage-cli-commands ac-17 — dry run
        if (options.dryRun) {
          info(`Dry run for triage record ${recordRef}:`);
          await executeTriageAction(record, ctx, {
            dryRun: true,
            consume: !options.keep,
            onInfo: info,
          });
          return;
        }

        // Execute the action
        const result = await executeTriageAction(record, ctx, {
          consume: !options.keep,
          onInfo: info,
        });

        // Transition to acted_on
        record.status = "acted_on";
        record.acted_at = new Date().toISOString();
        if (result.resultRef) {
          record.result_ref = result.resultRef;
        }
        record.updated_at = new Date().toISOString();

        await saveTriageRecord(ctx, record);
        await commitIfShadow(ctx.shadow, "triage-act", record._ulid.slice(0, 8), record.action);

        success(`Acted on triage record: ${recordRef} (${record.action})`, { record });
      } catch (err) {
        error("Failed to act on triage record", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec triage override <triage-ref>
  // AC: @triage-cli-commands ac-12
  markMutating(triage.command("override <triage-ref>"))
    .description("Override an existing triage decision")
    .requiredOption("--action <action>", "New action (promote, delete, defer, spec-gap, duplicate)")
    .requiredOption("--reasoning <text>", "Reasoning for the override")
    .option("--override-by <author>", "Who is overriding")
    .action(async (triageRef: string, options) => {
      try {
        const ctx = await initContext();
        const records = await loadTriageRecords(ctx);
        const record = resolveTriageRef(triageRef, records);
        const recordRef = shortRecordRef(record, records);

        // Validate action
        if (!VALID_ACTIONS.includes(options.action)) {
          error(`Invalid action: ${options.action}. Must be one of: ${VALID_ACTIONS.join(", ")}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @actor-identity-resolution ac-7 ac-8 — canonical override_by or rejection.
        const overrideBy = await resolveCliActor(ctx, options.overrideBy, "override_by");

        // AC: @triage-cli-commands ac-12
        record.override_reasoning = options.reasoning;
        record.override_by = overrideBy;
        record.override_at = new Date().toISOString();
        record.action = options.action as TriageAction;

        // Ensure status is triaged (for re-acting after override)
        if (record.status === "acted_on") {
          record.status = "triaged";
        }

        await saveTriageRecord(ctx, record);
        await commitIfShadow(
          ctx.shadow,
          "triage-override",
          record._ulid.slice(0, 8),
          options.action,
        );

        success(`Overrode triage decision: ${recordRef} → ${options.action}`, { record });
      } catch (err) {
        error("Failed to override triage decision", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec triage export
  // AC: @triage-cli-commands ac-13, ac-14
  triage
    .command("export")
    .description("Export triage decisions for agent handoff")
    .requiredOption("--format <format>", "Export format (context, json)")
    .option("--status <status>", "Filter by status")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        let records = await loadTriageRecords(ctx);

        if (options.status) {
          records = records.filter((r) => r.status === options.status);
        }

        const validFormats = ["context", "json"];
        if (!validFormats.includes(options.format)) {
          error(`Invalid format: ${options.format}. Must be one of: ${validFormats.join(", ")}`);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @trait-json-output ac-6 — --json takes precedence over --format
        // AC: @triage-cli-commands ac-13, ac-14
        // AC: @triage-agent-export ac-1, ac-2, ac-3, ac-4 — shared formatter
        output(records, () => {
          if (options.format === "json") {
            // AC: @triage-cli-commands ac-14
            console.log(JSON.stringify(records, null, 2));
          } else {
            // AC: @triage-cli-commands ac-13 — context format via shared formatter
            console.log(exportTriageAsContext(records));
          }
        });
      } catch (err) {
        error("Failed to export triage records", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec triage start
  // AC: @triage-cli-commands ac-9, ac-10
  markMutating(triage.command("start"))
    .description("Start interactive triage of inbox items")
    .action(async () => {
      try {
        const ctx = await initContext();
        const inboxItems = await loadInboxItems(ctx);
        const inboxUlids = inboxItems.map((item) => item._ulid);
        const existingRecords = await loadTriageRecords(ctx);

        // Find untriaged items (no existing triage record)
        const triagedInboxRefs = new Set(existingRecords.map((r) => r.inbox_ref));
        const untriaged = inboxItems.filter((item) => !triagedInboxRefs.has(item._ulid));

        if (untriaged.length === 0) {
          info("No untriaged inbox items");
          return;
        }

        console.log(`\nInteractive triage: ${untriaged.length} item(s) to review\n`);
        console.log("Actions: promote, delete, defer, spec-gap, duplicate, skip\n");

        const validActions = [...VALID_ACTIONS, "skip"];
        let triaged = 0;

        // Use a line-buffering approach for interactive prompts.
        // readline.question() has issues with piped stdin because the close
        // event can fire before subsequent question() calls process buffered lines.
        // Instead, we collect lines via the 'line' event and read from the buffer.
        const lineBuffer: string[] = [];
        let lineResolve: ((value: string | null) => void) | null = null;
        let inputClosed = false;

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: false,
        });

        rl.on("line", (line) => {
          if (lineResolve) {
            const resolve = lineResolve;
            lineResolve = null;
            resolve(line.trim());
          } else {
            lineBuffer.push(line.trim());
          }
        });

        rl.on("close", () => {
          inputClosed = true;
          if (lineResolve) {
            const resolve = lineResolve;
            lineResolve = null;
            resolve(null);
          }
        });

        const askQuestion = (question: string): Promise<string | null> => {
          process.stdout.write(question);
          if (lineBuffer.length > 0) {
            return Promise.resolve(lineBuffer.shift()!);
          }
          if (inputClosed) return Promise.resolve(null);
          return new Promise((resolve) => {
            lineResolve = resolve;
          });
        };

        // AC: @triage-cli-commands ac-9 — present items one at a time
        for (const item of untriaged) {
          const inboxRef = shortestUniqueUlid(item._ulid, inboxUlids);
          console.log("─".repeat(60));
          console.log(`Item: ${inboxRef} (${formatRelativeTime(item.created_at)})`);
          if (item.tags.length > 0) {
            console.log(`Tags: ${item.tags.join(", ")}`);
          }
          if (item.added_by) {
            console.log(`Added by: ${item.added_by}`);
          }
          console.log("");
          console.log(item.text);
          console.log("");

          // AC: @triage-cli-commands ac-10 — Ctrl+C preserves committed records
          const action = await askQuestion(
            "Action (promote/delete/defer/spec-gap/duplicate/skip): ",
          );

          if (action === null) {
            // Ctrl+C or closed input
            console.log(`\nTriage interrupted. ${triaged} record(s) saved.`);
            rl.close();
            return;
          }

          if (!action || action === "skip") {
            console.log("Skipped\n");
            continue;
          }

          if (!validActions.includes(action)) {
            console.log(`Invalid action: ${action}. Skipping.\n`);
            continue;
          }

          const reasoning = await askQuestion("Reasoning: ");

          if (reasoning === null) {
            console.log(`\nTriage interrupted. ${triaged} record(s) saved.`);
            rl.close();
            return;
          }

          if (!reasoning) {
            console.log("Reasoning required. Skipping.\n");
            continue;
          }

          // AC: @actor-identity-resolution ac-7 ac-8 — canonical decided_by or rejection.
          const author = await resolveCliActor(ctx, undefined, "decided_by");

          const record: LoadedTriageRecord = {
            _ulid: ulid(),
            inbox_ref: item._ulid,
            item_snapshot: item.text,
            status: "triaged",
            action: action as TriageAction,
            reasoning,
            decided_by: author,
            evidence_refs: [],
            created_at: new Date().toISOString(),
          };

          const { persistedRecord, records } = await persistAndReloadTriageRecord(ctx, record);
          await commitIfShadow(
            ctx.shadow,
            "triage-record",
            persistedRecord._ulid.slice(0, 8),
            action,
          );

          const recordRef = shortRecordRef(persistedRecord, records);
          triaged++;
          console.log(`Recorded: ${recordRef} → ${action}\n`);
        }

        rl.close();
        console.log(`\nTriage complete. ${triaged} record(s) created.`);
      } catch (err) {
        error("Failed to start interactive triage", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec triage get <triage-ref>
  triage
    .command("get <triage-ref>")
    .description("Show details of a triage record")
    .action(async (triageRef: string) => {
      try {
        const ctx = await initContext();
        const records = await loadTriageRecords(ctx);
        const record = resolveTriageRef(triageRef, records);

        output(record, () => {
          console.log(`ULID:        ${record._ulid}`);
          console.log(`Inbox ref:   ${record.inbox_ref}`);
          console.log(`Status:      ${record.status}`);
          if (record.action) console.log(`Action:      ${record.action}`);
          if (record.reasoning) console.log(`Reasoning:   ${record.reasoning}`);
          if (record.decided_by) console.log(`Decided by:  ${record.decided_by}`);
          if (record.evidence_refs.length > 0) {
            console.log(`Evidence:    ${record.evidence_refs.join(", ")}`);
          }
          console.log(
            `Created:     ${record.created_at} (${formatRelativeTime(record.created_at)})`,
          );
          if (record.updated_at) {
            console.log(`Updated:     ${record.updated_at}`);
          }
          if (record.override_reasoning) {
            console.log("");
            console.log("Override:");
            console.log(`  Reasoning: ${record.override_reasoning}`);
            if (record.override_by) console.log(`  By:        ${record.override_by}`);
            if (record.override_at) console.log(`  At:        ${record.override_at}`);
          }
          if (record.acted_at) {
            console.log("");
            console.log(`Acted at:    ${record.acted_at}`);
            if (record.result_ref) console.log(`Result ref:  ${record.result_ref}`);
          }
          console.log("");
          console.log("Item snapshot:");
          console.log(record.item_snapshot);
        });
      } catch (err) {
        error("Failed to get triage record", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
