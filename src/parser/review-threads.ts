/**
 * Review thread operations.
 *
 * Provides functions to add threads (general or anchored), add replies,
 * resolve/reopen threads, and compute review disposition based on
 * unresolved blocking threads.
 *
 * AC: @review-comment-threads-and-anchors ac-1 - General thread creation
 * AC: @review-comment-threads-and-anchors ac-2 - Code anchor threads
 * AC: @review-comment-threads-and-anchors ac-3 - Structured anchor threads
 * AC: @review-comment-threads-and-anchors ac-4 - Threaded replies
 * AC: @review-comment-threads-and-anchors ac-5 - Thread kind field
 * AC: @review-comment-threads-and-anchors ac-6 - Disposition computation
 */

import { ulid } from "ulid";
import type {
  ReviewRecord,
  ReviewThread,
  ReviewThreadEntry,
  ReviewThreadKind,
  ReviewAnchor,
  ReviewEvent,
  ReviewDisposition,
} from "../schema/index.js";
import type { LoadedReviewRecord } from "./reviews.js";
import { mutateReviewAtomically } from "./reviews.js";
import type { KspecContext } from "./yaml.js";

// --- Thread creation inputs ---

export interface AddThreadInput {
  author: string;
  body: string;
  kind?: ReviewThreadKind;
  anchor?: ReviewAnchor;
}

export interface AddReplyInput {
  threadUlid: string;
  author: string;
  body: string;
}

export interface ResolveThreadInput {
  threadUlid: string;
  actor: string;
}

// --- Event helpers ---

function createEvent(
  eventType: ReviewEvent["event_type"],
  actor: string,
  payload: Record<string, unknown> = {},
): ReviewEvent {
  return {
    _ulid: ulid(),
    event_type: eventType,
    actor,
    timestamp: new Date().toISOString(),
    payload,
  };
}

// --- Thread operations ---

/**
 * Add a new thread to a review record.
 *
 * AC: @review-comment-threads-and-anchors ac-1 - General threads (no anchor)
 * AC: @review-comment-threads-and-anchors ac-2 - Code anchor threads
 * AC: @review-comment-threads-and-anchors ac-3 - Structured anchor threads
 * AC: @review-comment-threads-and-anchors ac-5 - Thread kind field
 */
export function addThread(
  review: ReviewRecord,
  input: AddThreadInput,
): { review: ReviewRecord; thread: ReviewThread } {
  const now = new Date().toISOString();
  const threadUlid = ulid();
  const entryUlid = ulid();

  const entry: ReviewThreadEntry = {
    _ulid: entryUlid,
    author: input.author,
    body: input.body,
    created_at: now,
  };

  const thread: ReviewThread = {
    _ulid: threadUlid,
    kind: input.kind ?? "nit",
    entries: [entry],
    ...(input.anchor ? { anchor: input.anchor } : {}),
  };

  const event = createEvent("thread_created", input.author, {
    thread_ulid: threadUlid,
    kind: thread.kind,
    ...(input.anchor ? { anchor_type: input.anchor.type } : {}),
  });

  return {
    review: {
      ...review,
      threads: [...review.threads, thread],
      events: [...review.events, event],
      updated_at: now,
    },
    thread,
  };
}

/**
 * Add a reply to an existing thread.
 *
 * AC: @review-comment-threads-and-anchors ac-4 - Threaded replies
 */
export function addReply(
  review: ReviewRecord,
  input: AddReplyInput,
): { review: ReviewRecord; entry: ReviewThreadEntry } {
  const now = new Date().toISOString();
  const entryUlid = ulid();

  const threadIndex = review.threads.findIndex((t) => t._ulid === input.threadUlid);
  if (threadIndex === -1) {
    throw new Error(`Thread not found: ${input.threadUlid}`);
  }

  const entry: ReviewThreadEntry = {
    _ulid: entryUlid,
    author: input.author,
    body: input.body,
    created_at: now,
  };

  const updatedThread = {
    ...review.threads[threadIndex],
    entries: [...review.threads[threadIndex].entries, entry],
  };

  const updatedThreads = [...review.threads];
  updatedThreads[threadIndex] = updatedThread;

  const event = createEvent("thread_replied", input.author, {
    thread_ulid: input.threadUlid,
    entry_ulid: entryUlid,
  });

  return {
    review: {
      ...review,
      threads: updatedThreads,
      events: [...review.events, event],
      updated_at: now,
    },
    entry,
  };
}

/**
 * Resolve a thread.
 */
export function resolveThread(review: ReviewRecord, input: ResolveThreadInput): ReviewRecord {
  const now = new Date().toISOString();

  const threadIndex = review.threads.findIndex((t) => t._ulid === input.threadUlid);
  if (threadIndex === -1) {
    throw new Error(`Thread not found: ${input.threadUlid}`);
  }

  const updatedThread = {
    ...review.threads[threadIndex],
    resolved_at: now,
    resolved_by: input.actor,
  };

  const updatedThreads = [...review.threads];
  updatedThreads[threadIndex] = updatedThread;

  const event = createEvent("thread_resolved", input.actor, {
    thread_ulid: input.threadUlid,
  });

  return {
    ...review,
    threads: updatedThreads,
    events: [...review.events, event],
    updated_at: now,
  };
}

/**
 * Reopen a previously resolved thread.
 */
export function reopenThread(review: ReviewRecord, input: ResolveThreadInput): ReviewRecord {
  const now = new Date().toISOString();

  const threadIndex = review.threads.findIndex((t) => t._ulid === input.threadUlid);
  if (threadIndex === -1) {
    throw new Error(`Thread not found: ${input.threadUlid}`);
  }

  const updatedThread = {
    ...review.threads[threadIndex],
    resolved_at: null,
    resolved_by: null,
  };

  const updatedThreads = [...review.threads];
  updatedThreads[threadIndex] = updatedThread;

  const event = createEvent("thread_reopened", input.actor, {
    thread_ulid: input.threadUlid,
  });

  return {
    ...review,
    threads: updatedThreads,
    events: [...review.events, event],
    updated_at: now,
  };
}

// --- Disposition computation ---

/**
 * Compute review disposition based on unresolved threads.
 *
 * AC: @review-comment-threads-and-anchors ac-6
 *
 * Only unresolved threads with kind "blocker" prevent approval.
 * Unresolved "nit", "question", and "idea" threads do not block.
 */
export function computeThreadDisposition(review: ReviewRecord): ReviewDisposition {
  const hasUnresolvedBlockers = review.threads.some((t) => t.kind === "blocker" && !t.resolved_at);

  if (hasUnresolvedBlockers) {
    return "changes_requested";
  }

  return "pending";
}

/**
 * Get unresolved blocking threads from a review.
 */
export function getUnresolvedBlockers(review: ReviewRecord): ReviewThread[] {
  return review.threads.filter((t) => t.kind === "blocker" && !t.resolved_at);
}

/**
 * Get all unresolved threads from a review (any kind).
 */
export function getUnresolvedThreads(review: ReviewRecord): ReviewThread[] {
  return review.threads.filter((t) => !t.resolved_at);
}

// --- Atomic persistence wrappers ---

/**
 * Add a thread to a review with atomic persistence.
 */
export async function addThreadAtomic(
  ctx: KspecContext,
  review: LoadedReviewRecord,
  input: AddThreadInput,
): Promise<{ review: LoadedReviewRecord; thread: ReviewThread }> {
  let createdThread: ReviewThread | undefined;

  const updated = await mutateReviewAtomically(ctx, review, (latest) => {
    const result = addThread(latest, input);
    createdThread = result.thread;
    return result.review;
  });

  return { review: updated, thread: createdThread! };
}

/**
 * Add a reply to a thread with atomic persistence.
 */
export async function addReplyAtomic(
  ctx: KspecContext,
  review: LoadedReviewRecord,
  input: AddReplyInput,
): Promise<{ review: LoadedReviewRecord; entry: ReviewThreadEntry }> {
  let createdEntry: ReviewThreadEntry | undefined;

  const updated = await mutateReviewAtomically(ctx, review, (latest) => {
    const result = addReply(latest, input);
    createdEntry = result.entry;
    return result.review;
  });

  return { review: updated, entry: createdEntry! };
}

/**
 * Resolve a thread with atomic persistence.
 */
export async function resolveThreadAtomic(
  ctx: KspecContext,
  review: LoadedReviewRecord,
  input: ResolveThreadInput,
): Promise<LoadedReviewRecord> {
  return mutateReviewAtomically(ctx, review, (latest) => resolveThread(latest, input));
}

/**
 * Reopen a thread with atomic persistence.
 */
export async function reopenThreadAtomic(
  ctx: KspecContext,
  review: LoadedReviewRecord,
  input: ResolveThreadInput,
): Promise<LoadedReviewRecord> {
  return mutateReviewAtomically(ctx, review, (latest) => reopenThread(latest, input));
}
