import type { KspecContext } from "../parser/yaml.js";
import type { LoadedTriageRecord } from "../parser/index.js";
import {
  createObservation,
  createTask,
  deleteInboxItem,
  findInboxItemByRef,
  loadAllItems,
  loadAllTasks,
  loadInboxItems,
  ReferenceIndex,
  saveObservation,
  saveTask,
} from "../parser/index.js";
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
  const { dryRun = false, onInfo } = options;
  const action = record.action;
  if (!action) return {};

  switch (action) {
    case "promote": {
      // AC: @triage-cli-commands ac-4
      if (dryRun) {
        onInfo?.(`Would create task from inbox item snapshot: "${truncateText(record.item_snapshot)}"`);
        return {};
      }
      const task = createTask({
        title: record.item_snapshot.split("\n")[0].slice(0, 100),
        type: "task",
        priority: 3,
        spec_ref: null,
        tags: [],
        description: record.item_snapshot,
      });
      await saveTask(ctx, task);
      const tasks = await loadAllTasks(ctx);
      const items = await loadAllItems(ctx);
      const index = new ReferenceIndex(tasks, items);
      const taskRef = `@${index.shortUlid(task._ulid)}`;
      onInfo?.(`Created task: ${taskRef} - ${task.title}`);
      return { resultRef: taskRef };
    }

    case "delete": {
      // AC: @triage-cli-commands ac-5
      if (dryRun) {
        onInfo?.(`Would delete inbox item: ${record.inbox_ref.slice(0, 8)}`);
        return {};
      }
      const inboxItems = await loadInboxItems(ctx);
      const inboxItem = findInboxItemByRef(inboxItems, record.inbox_ref);
      if (inboxItem) {
        await deleteInboxItem(ctx, inboxItem._ulid);
        onInfo?.(`Deleted inbox item: ${record.inbox_ref.slice(0, 8)}`);
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
      const observation = createObservation("question", content, {
        configAuthor: ctx.config?.identity?.author,
      });
      await saveObservation(ctx, observation);
      const obsRef = `@${observation._ulid.slice(0, 8)}`;
      onInfo?.(`Created spec-gap observation: ${obsRef}`);
      return { resultRef: obsRef };
    }

    case "duplicate": {
      // AC: @triage-cli-commands ac-8
      if (dryRun) {
        onInfo?.(`Would delete duplicate inbox item: ${record.inbox_ref.slice(0, 8)}`);
        return {};
      }
      const dupItems = await loadInboxItems(ctx);
      const dupItem = findInboxItemByRef(dupItems, record.inbox_ref);
      if (dupItem) {
        await deleteInboxItem(ctx, dupItem._ulid);
        onInfo?.(`Deleted duplicate inbox item: ${record.inbox_ref.slice(0, 8)}`);
      }
      return {};
    }

    default:
      return {};
  }
}
