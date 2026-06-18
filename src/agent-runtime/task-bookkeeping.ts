import { createMutationPipeline } from "../mutation-pipeline.js";
import type { MutationCacheCapability, MutationPubSubCapability } from "../mutation-pipeline.js";
import {
  initContext,
  resolveTaskDataManager,
  type KspecContext,
  type LoadedTask,
} from "../parser/index.js";
import { resolveActorForContext } from "../identity/actor-write-context.js";

export interface TaskBookkeepingMutations {
  addTaskNote(taskRef: string, note: string): Promise<void>;
  blockTask(taskRef: string, reason: string): Promise<void>;
}

export interface TaskBookkeepingMutationOptions {
  projectDir: string;
  cache?: MutationCacheCapability | null;
  pubsub?: MutationPubSubCapability | null;
  projectPath?: string;
}

export function createTaskBookkeepingMutations(
  options: TaskBookkeepingMutationOptions,
): TaskBookkeepingMutations {
  return {
    addTaskNote: (taskRef, note) => addTaskNoteViaPipeline(options, taskRef, note),
    blockTask: (taskRef, reason) => blockTaskViaPipeline(options, taskRef, reason),
  };
}

export function describeBookkeepingError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` Cause: ${err.cause.message}` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}

async function resolveAuthor(ctx: KspecContext): Promise<string> {
  const resolved = await resolveActorForContext(ctx, { field: "author" });
  if (!resolved.ok) {
    throw new Error(resolved.error.message);
  }
  return resolved.actor;
}

async function addTaskNoteViaPipeline(
  options: TaskBookkeepingMutationOptions,
  taskRef: string,
  note: string,
): Promise<void> {
  const ctx = await initContext(options.projectDir);
  const author = await resolveAuthor(ctx);
  const pipeline = createMutationPipeline({
    shadow: ctx.shadow,
    cache: options.cache ?? null,
    pubsub: options.pubsub ?? null,
    projectPath: options.projectPath ?? options.projectDir,
  });

  await pipeline.run({
    apply: () =>
      resolveTaskDataManager(ctx).addNote(ctx, taskRef, note, author, {
        operation: "task-note",
        ref: taskRef,
        detail: "add note",
        skipCommit: true,
      }),
    commit: { operation: "task-note", ref: taskRef, detail: "add note" },
    writeThrough: ({ task }) => [{ domain: "tasks", hint: taskWriteThroughHint(task) }],
    events: ({ task, note: createdNote }) => [
      {
        topic: "tasks:updates",
        event: "task_updated",
        data: {
          ref: taskRef,
          ulid: task._ulid,
          action: "note_added",
          title: task.title,
          old_status: null,
          new_status: null,
          note_ulid: createdNote._ulid,
        },
      },
    ],
  });
}

async function blockTaskViaPipeline(
  options: TaskBookkeepingMutationOptions,
  taskRef: string,
  reason: string,
): Promise<void> {
  const ctx = await initContext(options.projectDir);
  const task = await resolveTaskDataManager(ctx).getTask(ctx, taskRef);
  if (task.status === "completed" || task.status === "cancelled") {
    throw new Error(`Cannot block ${task.status} task: ${taskRef}`);
  }

  const pipeline = createMutationPipeline({
    shadow: ctx.shadow,
    cache: options.cache ?? null,
    pubsub: options.pubsub ?? null,
    projectPath: options.projectPath ?? options.projectDir,
  });

  let oldStatus: LoadedTask["status"] = task.status;
  const updatedTask = await pipeline.run({
    apply: () =>
      resolveTaskDataManager(ctx).mutateTask(
        ctx,
        task._ulid,
        (latestTask) => {
          if (latestTask.status === "completed" || latestTask.status === "cancelled") {
            throw new Error(`Cannot block ${latestTask.status} task: ${taskRef}`);
          }
          oldStatus = latestTask.status;
          return {
            ...latestTask,
            status: "blocked",
            prior_status:
              latestTask.status === "blocked" ? latestTask.prior_status : latestTask.status,
            blocked_by: [...latestTask.blocked_by, reason],
          };
        },
        {
          operation: "task-block",
          ref: taskRef,
          detail: `block ${taskRef}`,
          skipCommit: true,
        },
      ),
    commit: { operation: "task-block", ref: taskRef, detail: `block ${taskRef}` },
    writeThrough: (updated) => [{ domain: "tasks", hint: taskWriteThroughHint(updated) }],
    events: (updated) => [
      {
        topic: "tasks:updates",
        event: "task_updated",
        data: {
          ref: taskRef,
          ulid: updated._ulid,
          action: "block",
          title: updated.title,
          old_status: oldStatus,
          new_status: "blocked",
        },
      },
    ],
  });

  if (updatedTask.status !== "blocked") {
    throw new Error(`Task ${taskRef} was not blocked`);
  }
}

function taskWriteThroughHint(task: LoadedTask): { ulid: string } {
  return { ulid: task._ulid };
}
