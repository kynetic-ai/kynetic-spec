import * as readline from "node:readline";
import type { Command } from "commander";
import { markMutating } from "../command-annotations.js";
import {
  createInboxItem,
  createNote,
  deleteInboxItem,
  findInboxItemByRef,
  initContext,
  type LoadedInboxItem,
  type LoadedTask,
  loadAllItems,
  loadInboxItems,
  mutateInboxItemAtomically,
  ReferenceIndex,
  saveInboxItem,
  shortestUniqueUlid,
} from "../../parser/index.js";
import { resolveTaskDataManager } from "../../parser/task-data-manager.js";
import { commitIfShadow } from "../../parser/shadow.js";
import { TaskTypeSchema, type InboxItemInput, type TaskInput } from "../../schema/index.js";
import { errors } from "../../strings/index.js";
import { fieldLabels } from "../../strings/labels.js";
import { formatRelativeTime as formatRelativeTimeUtil } from "../../utils/time.js";
import { describeEnumValues } from "../enum-help.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, output, success } from "../output.js";
import { resolveCliActor } from "../actor.js";
import { parseTagsArray } from "../parse-utils.js";
import { parseIntOption, validateEnumOption, validateSpecRef } from "../validators.js";

/**
 * Format relative time for display (wrapper for utils function)
 */
function formatRelativeTime(dateStr: string): string {
  return formatRelativeTimeUtil(new Date(dateStr));
}

/**
 * Resolve inbox item ref with error handling
 */
function resolveInboxRef(ref: string, items: LoadedInboxItem[]): LoadedInboxItem {
  const item = findInboxItemByRef(items, ref);
  if (!item) {
    error(errors.reference.inboxNotFound(ref));
    process.exit(EXIT_CODES.NOT_FOUND);
  }
  return item;
}

function shortInboxRef(item: LoadedInboxItem, items: LoadedInboxItem[]): string {
  return shortestUniqueUlid(
    item._ulid,
    items.map((candidate) => candidate._ulid),
  );
}

/**
 * Simple prompt for user input
 */
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Register the 'inbox' command group
 */
export function registerInboxCommands(program: Command): void {
  const inbox = program
    .command("inbox")
    .description("Low-friction capture for ideas (not yet tasks)");

  // kspec inbox add <text>
  markMutating(inbox.command("add <text>"))
    .description("Capture an idea quickly")
    .option("--tag <tag...>", "Add tags for categorization")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec inbox add "Idea for new feature"
  $ kspec inbox add "Consider refactoring X" --tag refactor tech-debt`,
    )
    .action(async (text: string, options) => {
      try {
        const ctx = await initContext();

        const input: InboxItemInput = {
          text,
          tags: parseTagsArray(options.tag),
        };

        const item = createInboxItem(input, ctx.config?.identity?.author);
        await saveInboxItem(ctx, item);
        await commitIfShadow(ctx.shadow, "inbox-add", item._ulid, text);
        const inboxItems = await loadInboxItems(ctx);
        const itemRef = shortInboxRef(item, inboxItems);

        success(`Captured: ${itemRef}`, { item });
      } catch (err) {
        error(errors.failures.addInboxItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec inbox list
  inbox
    .command("list")
    .description("Show inbox items (oldest first for triage)")
    .option("--tag <tag>", "Filter by tag")
    .option("--limit <n>", "Limit results")
    .option("--newest", "Sort newest first (default is oldest first)")
    .option("--count", "Show only the count of matching items")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        let items = await loadInboxItems(ctx);
        const allInboxUlids = items.map((item) => item._ulid);

        // Filter by tag
        if (options.tag) {
          items = items.filter((i) => i.tags.includes(options.tag));
        }

        // Sort: oldest first by default (for triage), newest if requested
        items.sort((a, b) => {
          const dateA = new Date(a.created_at).getTime();
          const dateB = new Date(b.created_at).getTime();
          return options.newest ? dateB - dateA : dateA - dateB;
        });

        // AC: @trait-filterable-list ac-8
        if (options.count) {
          output({ count: items.length }, () => {
            console.log(items.length);
          });
          return;
        }

        // Limit
        if (options.limit) {
          const limit = parseInt(options.limit, 10);
          items = items.slice(0, limit);
        }

        output(items, () => {
          if (items.length === 0) {
            console.log("Inbox is empty");
            return;
          }

          console.log(`Inbox (${items.length} item${items.length === 1 ? "" : "s"}):\n`);

          for (const item of items) {
            const tags = item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";
            const age = formatRelativeTime(item.created_at);
            const author = item.added_by ? ` by ${item.added_by}` : "";
            const itemRef = shortestUniqueUlid(item._ulid, allInboxUlids);
            console.log(`  ${itemRef} (${age}${author})${tags}`);
            console.log(`    ${item.text}`);
            console.log("");
          }
        });
      } catch (err) {
        error(errors.failures.listInboxItems, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec inbox promote <ref>
  markMutating(inbox.command("promote <ref>"))
    .description("Convert inbox item to task")
    .option("--title <title>", "Task title (prompts if not provided)")
    .option("--description <text>", "Task description (defaults to inbox item text)")
    .option("--priority <n>", "Priority (1-5)", "3")
    .option("--type <type>", describeEnumValues("Task type", TaskTypeSchema.options), "task")
    .option("--spec-ref <ref>", "Link to spec item")
    .option("--tag <tag...>", "Tags for the task")
    .option("--note <text>", "Add initial note to the created task")
    .option("--keep", "Keep inbox item after promoting")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec inbox promote @ref --title "New task from idea"
  $ kspec inbox promote @ref --title "Tagged task" --tag cli urgent`,
    )
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const inboxItems = await loadInboxItems(ctx);
        const item = resolveInboxRef(ref, inboxItems);
        const itemRef = shortInboxRef(item, inboxItems);

        // Validate priority
        const priorityResult = parseIntOption(options.priority, {
          min: 1,
          max: 5,
          name: "Priority",
        });
        if (!priorityResult.ok) {
          error(priorityResult.error);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const taskTypeResult = validateEnumOption(
          options.type || "task",
          TaskTypeSchema.options,
          "task type",
        );
        if (!taskTypeResult.ok) {
          error(taskTypeResult.error);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // Validate spec_ref if provided — must point to a spec item
        if (options.specRef) {
          const allTasks = await resolveTaskDataManager(ctx).listTasks(ctx);
          const allItems = await loadAllItems(ctx);
          const refIndex = new ReferenceIndex(allTasks as unknown as LoadedTask[], allItems);
          const specRefResult = validateSpecRef(
            options.specRef,
            refIndex,
            allTasks as unknown as LoadedTask[],
            allItems,
          );
          if (!specRefResult.ok) {
            error(specRefResult.error);
            process.exit(EXIT_CODES.NOT_FOUND);
          }
        }

        // Determine task title
        let title = options.title;
        if (!title) {
          // Interactive prompt
          console.log(`Promoting: "${item.text}"`);
          console.log("");
          title = await prompt("Task title: ");
          if (!title) {
            error(errors.validation.titleRequired);
            process.exit(EXIT_CODES.USAGE_ERROR);
          }
        }

        // Create the task
        const taskInput: TaskInput = {
          title,
          type: taskTypeResult.value,
          priority: priorityResult.value,
          spec_ref: options.specRef || null,
          tags: options.tag ? parseTagsArray(options.tag) : item.tags, // Inherit tags from inbox item if not specified
          description: options.description !== undefined ? options.description : item.text, // Use provided description (even if empty) or fall back to inbox item text
        };

        // AC: @cmd-inbox-promote ac-2
        if (options.note) {
          // AC: @actor-identity-resolution ac-7 ac-8 — canonical author or rejection.
          const note = createNote(options.note, await resolveCliActor(ctx, undefined, "author"));
          taskInput.notes = [note];
        }

        // Create task first, then delete inbox item — if task creation fails,
        // the inbox item is preserved (no data loss).
        const task = await resolveTaskDataManager(ctx).createTask(ctx, taskInput);

        // Delete inbox item unless --keep (after task creation so inbox item
        // is preserved if createTask fails)
        if (!options.keep) {
          await deleteInboxItem(ctx, item._ulid);
          info(`Removed from inbox: ${itemRef}`);
        }

        // Single shadow commit covers both task creation and inbox deletion
        await commitIfShadow(ctx.shadow, "inbox-promote", title);

        // Load for index to get short ULID
        const tasks = await resolveTaskDataManager(ctx).listTasks(ctx);
        const items = await loadAllItems(ctx);
        const index = new ReferenceIndex(tasks as unknown as LoadedTask[], items);

        success(`Created task: ${index.shortUlid(task._ulid)} - ${title}`, {
          task,
        });
      } catch (err) {
        error(errors.failures.promoteInboxItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec inbox delete <ref>
  markMutating(inbox.command("delete <ref>"))
    .description("Remove an inbox item")
    .option("--force", "Skip confirmation")
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const items = await loadInboxItems(ctx);
        const item = resolveInboxRef(ref, items);
        const itemRef = shortInboxRef(item, items);

        // Confirm unless --force
        if (!options.force) {
          console.log(`Delete: "${item.text}"`);
          const confirm = await prompt("Are you sure? (y/N): ");
          if (confirm.toLowerCase() !== "y") {
            console.log("Cancelled");
            return;
          }
        }

        const deleted = await deleteInboxItem(ctx, item._ulid);
        if (deleted) {
          await commitIfShadow(ctx.shadow, "inbox-delete", item._ulid.slice(0, 8));
          success(`Deleted inbox item: ${itemRef}`);
        } else {
          error(errors.failures.deleteInboxItem);
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        error(errors.failures.deleteInboxItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec inbox get <ref>
  inbox
    .command("get <ref>")
    .description("Show details of an inbox item")
    .action(async (ref: string) => {
      try {
        const ctx = await initContext();
        const items = await loadInboxItems(ctx);
        const item = resolveInboxRef(ref, items);
        const _itemRef = shortInboxRef(item, items);

        output(item, () => {
          console.log(`${fieldLabels.ulid}     ${item._ulid}`);
          console.log(
            `${fieldLabels.created}  ${item.created_at} (${formatRelativeTime(item.created_at)})`,
          );
          if (item.added_by) {
            console.log(`Added by: ${item.added_by}`);
          }
          if (item.tags.length > 0) {
            console.log(`${fieldLabels.tags}     ${item.tags.join(", ")}`);
          }
          console.log("");
          console.log(item.text);
        });
      } catch (err) {
        error(errors.failures.getInboxItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec inbox set <ref>
  // AC: @inbox-set ac-1, ac-2
  markMutating(inbox.command("set <ref>"))
    .description("Update an inbox item")
    .option("--content <text>", "Replace item content")
    .option("--tag <tag...>", "Add tags to item")
    .option("--clear-tags", "Clear all tags before adding new ones")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec inbox set @ref --content "Updated text"
  $ kspec inbox set @ref --tag newtag
  $ kspec inbox set @ref --clear-tags --tag fresh-start`,
    )
    .action(async (ref: string, options) => {
      try {
        const ctx = await initContext();
        const items = await loadInboxItems(ctx);
        const item = resolveInboxRef(ref, items);
        const itemRef = shortInboxRef(item, items);
        const newTags = options.tag ? parseTagsArray(options.tag) : [];

        // Track what was updated
        const updates: string[] = [];

        // AC: @inbox-set ac-1 - Update content if provided
        if (options.content !== undefined) {
          updates.push("content");
        }

        // AC: @inbox-set ac-2 - Update tags if provided
        if (options.clearTags) {
          updates.push("cleared tags");
        }
        if (newTags.length > 0) {
          updates.push("tags");
        }

        if (updates.length === 0) {
          info("No updates specified. Use --content or --tag to update.");
          return;
        }

        const updatedItem = await mutateInboxItemAtomically(ctx, item, (latestItem) => {
          const nextItem: LoadedInboxItem = {
            ...latestItem,
            tags: [...latestItem.tags],
          };

          if (options.content !== undefined) {
            nextItem.text = options.content;
          }

          if (options.clearTags) {
            nextItem.tags = [];
          }

          // Append new tags, avoiding duplicates
          for (const tag of newTags) {
            if (!nextItem.tags.includes(tag)) {
              nextItem.tags.push(tag);
            }
          }

          return nextItem;
        });

        await commitIfShadow(
          ctx.shadow,
          "inbox-set",
          updatedItem._ulid.slice(0, 8),
          updates.join(", "),
        );

        success(`Updated inbox item: ${itemRef}`, { item: updatedItem });
      } catch (err) {
        error(errors.failures.updateInboxItem, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // kspec inbox note <ref> <text>
  // AC: @inbox-note ac-1
  markMutating(inbox.command("note <ref> <text>"))
    .description("Append a note to an inbox item")
    .addHelpText(
      "after",
      `
Examples:
  $ kspec inbox note @ref "Additional context for this idea"
  $ kspec inbox note @ref "Update: decided to defer this"`,
    )
    .action(async (ref: string, text: string) => {
      try {
        const ctx = await initContext();
        const items = await loadInboxItems(ctx);
        const item = resolveInboxRef(ref, items);
        const itemRef = shortInboxRef(item, items);

        // Append note with separator
        const separator = "\n\n---\n\n";
        const updatedItem = await mutateInboxItemAtomically(ctx, item, (latestItem) => ({
          ...latestItem,
          text: latestItem.text + separator + text,
        }));

        await commitIfShadow(ctx.shadow, "inbox-note", updatedItem._ulid.slice(0, 8));

        success(`Added note to inbox item: ${itemRef}`, { item: updatedItem });
      } catch (err) {
        error(errors.failures.addInboxNote, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
