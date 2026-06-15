import type { KspecContext } from "../parser/yaml.js";
import type { LoadedTriageRecord } from "../parser/index.js";
import {
  createObservation,
  deleteInboxItem,
  findInboxItemByRef,
  loadAllItems,
  loadInboxItems,
  loadMetaContext,
  ReferenceIndex,
  resolveActorForContext,
  saveObservation,
  shortestUniqueUlid,
  type LoadedTask,
} from "../parser/index.js";
import { resolveTaskDataManager } from "../parser/task-data-manager.js";
import { truncateText } from "../export/triage.js";

/**
 * Result of executing a triage action.
 */
export interface TriageActionResult {
  resultRef?: string;
}

/**
 * Options for executeTriageAction.
 * - dryRun: If true, describe what would happen without executing.
 * - onInfo: Optional callback for informational messages (used by CLI for logging).
 */
export interface ExecuteTriageActionOptions {
  dryRun?: boolean;
  consume?: boolean;
  onInfo?: (message: string) => void;
}

/**
 * Execute a triage action against the kspec context.
 *
 * Shared between CLI and daemon. The CLI passes dryRun and onInfo for
 * user-facing output; the daemon calls with no options for silent execution.
 *
 * AC: @triage-cli-commands ac-4, ac-5, ac-6, ac-7, ac-8
 */
export async function executeTriageAction(
  record: LoadedTriageRecord,
  ctx: KspecContext,
  options: ExecuteTriageActionOptions = {},
): Promise<TriageActionResult> {
  const { dryRun = false, consume = true, onInfo } = options;
  const action = record.action;
  if (!action) {
    throw new Error("Record has no action to execute");
  }

  const getShortInboxRef = async (): Promise<string> => {
    const inboxItems = await loadInboxItems(ctx);
    const ulids = inboxItems.map((item) => item._ulid);
    if (!ulids.includes(record.inbox_ref)) {
      ulids.push(record.inbox_ref);
    }
    return shortestUniqueUlid(record.inbox_ref, ulids);
  };

  switch (action) {
    case "promote": {
      // AC: @triage-cli-commands ac-4
      if (dryRun) {
        const inboxRef = await getShortInboxRef();
        onInfo?.(
          `Would create task from inbox item snapshot: "${truncateText(record.item_snapshot)}"`,
        );
        if (consume) {
          onInfo?.(`Would delete promoted inbox item: ${inboxRef}`);
        } else {
          onInfo?.(`Would keep promoted inbox item: ${inboxRef}`);
        }
        return {};
      }
      const task = await resolveTaskDataManager(ctx).createTask(ctx, {
        title: record.item_snapshot.split("\n")[0].slice(0, 100),
        type: "task",
        priority: 3,
        spec_ref: null,
        tags: [],
        description: record.item_snapshot,
      });
      const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
      const items = await loadAllItems(ctx);
      const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);
      const taskRef = `@${index.shortUlid(task._ulid)}`;
      if (consume) {
        const inboxItems = await loadInboxItems(ctx);
        const inboxRef = shortestUniqueUlid(
          record.inbox_ref,
          inboxItems.map((item) => item._ulid),
        );
        const inboxItem = findInboxItemByRef(inboxItems, record.inbox_ref);
        if (inboxItem) {
          await deleteInboxItem(ctx, inboxItem._ulid);
          onInfo?.(`Deleted promoted inbox item: ${inboxRef}`);
        }
      }
      onInfo?.(`Created task: ${taskRef} - ${task.title}`);
      return { resultRef: taskRef };
    }

    case "delete": {
      // AC: @triage-cli-commands ac-5
      if (dryRun) {
        onInfo?.(`Would delete inbox item: ${await getShortInboxRef()}`);
        return {};
      }
      const inboxItems = await loadInboxItems(ctx);
      const inboxRef = shortestUniqueUlid(
        record.inbox_ref,
        inboxItems.map((item) => item._ulid),
      );
      const inboxItem = findInboxItemByRef(inboxItems, record.inbox_ref);
      if (inboxItem) {
        await deleteInboxItem(ctx, inboxItem._ulid);
        onInfo?.(`Deleted inbox item: ${inboxRef}`);
      }
      return {};
    }

    case "defer": {
      // AC: @triage-cli-commands ac-6
      if (dryRun) {
        onInfo?.(`Would defer: no side effects beyond recording the deferral`);
        return {};
      }
      return {};
    }

    case "spec-gap": {
      // AC: @triage-cli-commands ac-7
      if (dryRun) {
        onInfo?.(`Would create spec-gap observation from: "${truncateText(record.item_snapshot)}"`);
        return {};
      }
      const content = `[spec-gap] ${record.item_snapshot}\n\nReasoning: ${record.reasoning || ""}`;
      // AC: @actor-identity-resolution ac-7 ac-8 — resolve and canonicalize the
      // observation author through the shared actor-write utility (shared by CLI
      // and daemon), rejecting out-of-pool values instead of persisting them.
      const authorResolution = await resolveActorForContext(ctx, { field: "author" });
      if (!authorResolution.ok) {
        throw new Error(authorResolution.error.message);
      }
      const observation = createObservation("question", content, {
        author: authorResolution.actor,
      });
      await saveObservation(ctx, observation);
      const meta = await loadMetaContext(ctx);
      const obsRef = `@${shortestUniqueUlid(
        observation._ulid,
        meta.observations.map((obs) => obs._ulid),
      )}`;
      onInfo?.(`Created spec-gap observation: ${obsRef}`);
      return { resultRef: obsRef };
    }

    case "duplicate": {
      // AC: @triage-cli-commands ac-8
      if (dryRun) {
        onInfo?.(`Would delete duplicate inbox item: ${await getShortInboxRef()}`);
        return {};
      }
      const dupItems = await loadInboxItems(ctx);
      const inboxRef = shortestUniqueUlid(
        record.inbox_ref,
        dupItems.map((item) => item._ulid),
      );
      const dupItem = findInboxItemByRef(dupItems, record.inbox_ref);
      if (dupItem) {
        await deleteInboxItem(ctx, dupItem._ulid);
        onInfo?.(`Deleted duplicate inbox item: ${inboxRef}`);
      }
      return {};
    }

    default:
      return {};
  }
}
