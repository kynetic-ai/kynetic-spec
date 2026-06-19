import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  addThread,
  addReply,
  resolveThread,
  reopenThread,
  computeThreadDisposition,
  getUnresolvedBlockers,
  getUnresolvedThreads,
  addThreadAtomic,
  addReplyAtomic,
  resolveThreadAtomic,
  reopenThreadAtomic,
} from "../src/parser/review-threads.js";
import { createReviewRecord, saveReviewRecord, loadReviewRecords } from "../src/parser/reviews.js";
import type {
  ReviewRecordInput,
  ReviewCodeAnchor,
  ReviewStructuredAnchor,
} from "../src/schema/index.js";
import type { KspecContext } from "../src/parser/yaml.js";
import { createTempDir, cleanupTempDir, initGitRepo, testUlid } from "./helpers/cli.js";

function makeInput(overrides: Partial<ReviewRecordInput> = {}): ReviewRecordInput {
  return {
    title: "Test Review",
    author: "test-author",
    subject: {
      type: "code",
      base_commit: "abc123",
      head_commit: "def456",
    },
    ...overrides,
  };
}

function makeCtx(specDir: string): KspecContext {
  return { specDir } as KspecContext;
}

// ============================================================
// AC-1: General thread creation (no anchor)
// ============================================================

describe("General thread creation (AC-1)", () => {
  // AC: @review-comment-threads-and-anchors ac-1
  it("should create a general thread with ULID, author, kind, and timestamps", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: updated, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "General feedback on the approach.",
    });

    // Thread has ULID identifier
    expect(thread._ulid).toBeDefined();
    expect(thread._ulid).toHaveLength(26);

    // Thread has kind (defaults to nit)
    expect(thread.kind).toBe("nit");

    // Thread has no anchor (general feedback)
    expect(thread.anchor).toBeUndefined();

    // Thread has an initial entry with author and timestamps
    expect(thread.entries).toHaveLength(1);
    expect(thread.entries[0].author).toBe("reviewer@example.com");
    expect(thread.entries[0].body).toBe("General feedback on the approach.");
    expect(thread.entries[0].created_at).toBeDefined();
    expect(thread.entries[0]._ulid).toBeDefined();

    // Review is updated
    expect(updated.threads).toHaveLength(1);
    expect(updated.updated_at).toBeDefined();
  });

  // AC: @review-comment-threads-and-anchors ac-1
  it("should record a thread_created event when creating a general thread", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: updated, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Some feedback.",
    });

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].event_type).toBe("thread_created");
    expect(updated.events[0].actor).toBe("reviewer@example.com");
    expect(updated.events[0].payload).toEqual(
      expect.objectContaining({
        thread_ulid: thread._ulid,
        kind: "nit",
      }),
    );
  });

  // AC: @review-comment-threads-and-anchors ac-1
  it("should store thread without anchor as general feedback", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Looks good overall.",
    });

    // No anchor = general thread
    expect(thread.anchor).toBeUndefined();
    expect(thread._ulid).toBeDefined();
    expect(thread.entries).toHaveLength(1);
  });
});

// ============================================================
// AC-2: Code anchor threads
// ============================================================

describe("Code anchor threads (AC-2)", () => {
  // AC: @review-comment-threads-and-anchors ac-2
  it("should store a code anchor with path, side, line range, and commit", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const codeAnchor: ReviewCodeAnchor = {
      type: "code",
      path: "src/parser/reviews.ts",
      side: "head",
      line_start: 42,
      line_end: 46,
      commit: "abc123def",
    };

    const { review: updated, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "This function should handle errors.",
      kind: "blocker",
      anchor: codeAnchor,
    });

    expect(thread.anchor).toBeDefined();
    expect(thread.anchor!.type).toBe("code");

    const anchor = thread.anchor as ReviewCodeAnchor;
    expect(anchor.path).toBe("src/parser/reviews.ts");
    expect(anchor.side).toBe("head");
    expect(anchor.line_start).toBe(42);
    expect(anchor.line_end).toBe(46);
    expect(anchor.commit).toBe("abc123def");

    // Verify persisted in the review
    expect(updated.threads[0].anchor).toEqual(codeAnchor);
  });

  // AC: @review-comment-threads-and-anchors ac-2
  it("should support base-side code anchors", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const codeAnchor: ReviewCodeAnchor = {
      type: "code",
      path: "src/old-file.ts",
      side: "base",
      line_start: 10,
      line_end: 15,
      commit: "oldcommit123",
    };

    const { thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "This was removed but should be kept.",
      anchor: codeAnchor,
    });

    const anchor = thread.anchor as ReviewCodeAnchor;
    expect(anchor.side).toBe("base");
    expect(anchor.path).toBe("src/old-file.ts");
  });

  // AC: @review-comment-threads-and-anchors ac-2
  it("should record anchor_type in thread_created event for code anchors", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: updated } = addThread(review, {
      author: "reviewer@example.com",
      body: "Fix this.",
      anchor: {
        type: "code",
        path: "src/foo.ts",
        side: "head",
        line_start: 1,
        line_end: 3,
        commit: "abc",
      },
    });

    expect(updated.events[0].payload).toEqual(expect.objectContaining({ anchor_type: "code" }));
  });
});

// ============================================================
// AC-3: Structured anchor threads
// ============================================================

describe("Structured anchor threads (AC-3)", () => {
  // AC: @review-comment-threads-and-anchors ac-3
  it("should store a structured anchor targeting a section and field", () => {
    const review = createReviewRecord(
      makeInput({
        _ulid: testUlid("RV"),
        subject: {
          type: "plan",
          ref: "@my-plan",
          shadow_commit: "shadow123",
          content_hash: "hash123",
        },
      }),
    );

    const structuredAnchor: ReviewStructuredAnchor = {
      type: "structured",
      section: "acceptance_criteria",
      field: "ac-3",
      ref: "@my-spec",
    };

    const { review: updated, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "This AC is too vague.",
      kind: "question",
      anchor: structuredAnchor,
    });

    expect(thread.anchor).toBeDefined();
    expect(thread.anchor!.type).toBe("structured");

    const anchor = thread.anchor as ReviewStructuredAnchor;
    expect(anchor.section).toBe("acceptance_criteria");
    expect(anchor.field).toBe("ac-3");
    expect(anchor.ref).toBe("@my-spec");

    expect(updated.threads[0].anchor).toEqual(structuredAnchor);
  });

  // AC: @review-comment-threads-and-anchors ac-3
  it("should store a structured anchor with path targeting a file section", () => {
    const review = createReviewRecord(
      makeInput({
        _ulid: testUlid("RV"),
        subject: {
          type: "spec",
          ref: "@my-spec",
          shadow_commit: "shadow456",
          content_hash: "hash456",
        },
      }),
    );

    const structuredAnchor: ReviewStructuredAnchor = {
      type: "structured",
      section: "description",
      path: "modules/core.yaml",
    };

    const { thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Description needs more detail.",
      anchor: structuredAnchor,
    });

    const anchor = thread.anchor as ReviewStructuredAnchor;
    expect(anchor.type).toBe("structured");
    expect(anchor.section).toBe("description");
    expect(anchor.path).toBe("modules/core.yaml");
  });

  // AC: @review-comment-threads-and-anchors ac-3
  it("should record anchor_type in thread_created event for structured anchors", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: updated } = addThread(review, {
      author: "reviewer@example.com",
      body: "This section needs work.",
      anchor: {
        type: "structured",
        section: "description",
      },
    });

    expect(updated.events[0].payload).toEqual(
      expect.objectContaining({ anchor_type: "structured" }),
    );
  });
});

// ============================================================
// AC-4: Threaded replies
// ============================================================

describe("Threaded replies (AC-4)", () => {
  // AC: @review-comment-threads-and-anchors ac-4
  it("should append a reply to an existing thread", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: withThread, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "This needs fixing.",
      kind: "blocker",
    });

    const { review: withReply, entry } = addReply(withThread, {
      threadUlid: thread._ulid,
      author: "author@example.com",
      body: "Fixed in the latest commit.",
    });

    // The thread should now have 2 entries
    const updatedThread = withReply.threads.find((t) => t._ulid === thread._ulid)!;
    expect(updatedThread.entries).toHaveLength(2);
    expect(updatedThread.entries[0].author).toBe("reviewer@example.com");
    expect(updatedThread.entries[0].body).toBe("This needs fixing.");
    expect(updatedThread.entries[1].author).toBe("author@example.com");
    expect(updatedThread.entries[1].body).toBe("Fixed in the latest commit.");
    expect(updatedThread.entries[1]._ulid).toBe(entry._ulid);
  });

  // AC: @review-comment-threads-and-anchors ac-4
  it("should preserve thread as a durable conversation with multiple replies", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));

    const { review: r1, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Why is this approach chosen?",
      kind: "question",
    });

    const { review: r2 } = addReply(r1, {
      threadUlid: thread._ulid,
      author: "author@example.com",
      body: "It's more performant for large datasets.",
    });

    const { review: r3 } = addReply(r2, {
      threadUlid: thread._ulid,
      author: "reviewer@example.com",
      body: "Makes sense, thanks for explaining.",
    });

    const finalThread = r3.threads.find((t) => t._ulid === thread._ulid)!;
    expect(finalThread.entries).toHaveLength(3);
    expect(finalThread.entries.map((e) => e.author)).toEqual([
      "reviewer@example.com",
      "author@example.com",
      "reviewer@example.com",
    ]);
  });

  // AC: @review-comment-threads-and-anchors ac-4
  it("should record thread_replied events for each reply", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: r1, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Initial comment.",
    });

    const { review: r2, entry } = addReply(r1, {
      threadUlid: thread._ulid,
      author: "author@example.com",
      body: "Reply here.",
    });

    // Should have thread_created + thread_replied events
    expect(r2.events).toHaveLength(2);
    expect(r2.events[0].event_type).toBe("thread_created");
    expect(r2.events[1].event_type).toBe("thread_replied");
    expect(r2.events[1].actor).toBe("author@example.com");
    expect(r2.events[1].payload).toEqual(
      expect.objectContaining({
        thread_ulid: thread._ulid,
        entry_ulid: entry._ulid,
      }),
    );
  });

  // AC: @review-comment-threads-and-anchors ac-4
  it("should throw when replying to a non-existent thread", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    expect(() =>
      addReply(review, {
        threadUlid: "NONEXISTENT0000000000000000",
        author: "author@example.com",
        body: "Reply to nothing.",
      }),
    ).toThrow("Thread not found");
  });
});

// ============================================================
// AC-5: Thread kind field
// ============================================================

describe("Thread kind field (AC-5)", () => {
  // AC: @review-comment-threads-and-anchors ac-5
  it("should store kind field distinguishing blocker, question, and nit", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));

    const { review: r1, thread: blockerThread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Must fix this before merge.",
      kind: "blocker",
    });

    const { review: r2, thread: questionThread } = addThread(r1, {
      author: "reviewer@example.com",
      body: "Why this approach?",
      kind: "question",
    });

    const { review: r3, thread: nitThread } = addThread(r2, {
      author: "reviewer@example.com",
      body: "Consider renaming this variable.",
      kind: "nit",
    });

    expect(blockerThread.kind).toBe("blocker");
    expect(questionThread.kind).toBe("question");
    expect(nitThread.kind).toBe("nit");

    expect(r3.threads).toHaveLength(3);
    expect(r3.threads.map((t) => t.kind)).toEqual(["blocker", "question", "nit"]);
  });

  // AC: @review-comment-threads-and-anchors ac-5
  it("should default kind to nit when not specified", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Small style suggestion.",
    });

    expect(thread.kind).toBe("nit");
  });

  // AC: @review-comment-threads-and-anchors ac-5
  it("should include kind in thread_created event payload", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: updated } = addThread(review, {
      author: "reviewer@example.com",
      body: "Critical issue.",
      kind: "blocker",
    });

    expect(updated.events[0].payload).toEqual(expect.objectContaining({ kind: "blocker" }));
  });

  // AC: @review-idea-threads ac-idea-kind-accepted
  it("should store idea threads and allow reply, resolve, and reopen operations", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: withIdea, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Consider a follow-up workflow.",
      kind: "idea",
    });

    const { review: withReply } = addReply(withIdea, {
      threadUlid: thread._ulid,
      author: "author@example.com",
      body: "Captured for later.",
    });

    const resolved = resolveThread(withReply, {
      threadUlid: thread._ulid,
      actor: "author@example.com",
    });

    const reopened = reopenThread(resolved, {
      threadUlid: thread._ulid,
      actor: "reviewer@example.com",
    });

    expect(reopened.threads[0].kind).toBe("idea");
    expect(reopened.threads[0].entries).toHaveLength(2);
    expect(reopened.threads[0].resolved_at).toBeNull();
    expect(reopened.threads[0].resolved_by).toBeNull();
    expect(reopened.events.map((event) => event.event_type)).toEqual([
      "thread_created",
      "thread_replied",
      "thread_resolved",
      "thread_reopened",
    ]);
  });
});

// ============================================================
// AC-6: Disposition computation (blockers block approval)
// ============================================================

describe("Disposition computation (AC-6)", () => {
  // AC: @review-comment-threads-and-anchors ac-6
  it("should return changes_requested when unresolved blocker threads exist", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: withBlocker } = addThread(review, {
      author: "reviewer@example.com",
      body: "Must fix this.",
      kind: "blocker",
    });

    expect(computeThreadDisposition(withBlocker)).toBe("changes_requested");
  });

  // AC: @review-comment-threads-and-anchors ac-6
  it("should return pending when only unresolved nit threads exist", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: withNit } = addThread(review, {
      author: "reviewer@example.com",
      body: "Consider renaming.",
      kind: "nit",
    });

    expect(computeThreadDisposition(withNit)).toBe("pending");
  });

  // AC: @review-comment-threads-and-anchors ac-6
  it("should return pending when only unresolved question threads exist", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: withQuestion } = addThread(review, {
      author: "reviewer@example.com",
      body: "Why this approach?",
      kind: "question",
    });

    expect(computeThreadDisposition(withQuestion)).toBe("pending");
  });

  // AC: @review-comment-threads-and-anchors ac-6
  it("should return pending when only unresolved idea threads exist", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: withIdea } = addThread(review, {
      author: "reviewer@example.com",
      body: "Consider a future improvement.",
      kind: "idea",
    });

    expect(computeThreadDisposition(withIdea)).toBe("pending");
  });

  // AC: @review-comment-threads-and-anchors ac-6
  it("should return pending when all blocker threads are resolved", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: withBlocker, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Must fix.",
      kind: "blocker",
    });

    const resolved = resolveThread(withBlocker, {
      threadUlid: thread._ulid,
      actor: "author@example.com",
    });

    expect(computeThreadDisposition(resolved)).toBe("pending");
  });

  // AC: @review-comment-threads-and-anchors ac-6
  it("should return changes_requested when mixed threads have unresolved blocker", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));

    const { review: r1 } = addThread(review, {
      author: "reviewer@example.com",
      body: "Nit: style issue.",
      kind: "nit",
    });

    const { review: r2 } = addThread(r1, {
      author: "reviewer@example.com",
      body: "Question about design.",
      kind: "question",
    });

    const { review: r3 } = addThread(r2, {
      author: "reviewer@example.com",
      body: "Blocker: security issue.",
      kind: "blocker",
    });

    expect(computeThreadDisposition(r3)).toBe("changes_requested");
  });

  // AC: @review-comment-threads-and-anchors ac-6
  it("should return pending when no threads exist", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    expect(computeThreadDisposition(review)).toBe("pending");
  });

  // AC: @review-comment-threads-and-anchors ac-6
  it("should not block when blocker is resolved but nit/question remain unresolved", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));

    const { review: r1, thread: blocker } = addThread(review, {
      author: "reviewer@example.com",
      body: "Security issue.",
      kind: "blocker",
    });

    const { review: r2 } = addThread(r1, {
      author: "reviewer@example.com",
      body: "Style nit.",
      kind: "nit",
    });

    const { review: r3 } = addThread(r2, {
      author: "reviewer@example.com",
      body: "Clarify this.",
      kind: "question",
    });

    // Resolve the blocker
    const resolved = resolveThread(r3, {
      threadUlid: blocker._ulid,
      actor: "author@example.com",
    });

    // Should not block — nit and question remain but are not blockers
    expect(computeThreadDisposition(resolved)).toBe("pending");
  });

  // AC: @review-comment-threads-and-anchors ac-6
  it("should block again when a resolved blocker is reopened", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: r1, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Fix this.",
      kind: "blocker",
    });

    const resolved = resolveThread(r1, {
      threadUlid: thread._ulid,
      actor: "author@example.com",
    });
    expect(computeThreadDisposition(resolved)).toBe("pending");

    const reopened = reopenThread(resolved, {
      threadUlid: thread._ulid,
      actor: "reviewer@example.com",
    });
    expect(computeThreadDisposition(reopened)).toBe("changes_requested");
  });
});

// ============================================================
// Thread resolution and reopening
// ============================================================

describe("Thread resolution and reopening", () => {
  it("should resolve a thread with timestamp and actor", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: r1, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Fix this.",
      kind: "blocker",
    });

    const resolved = resolveThread(r1, {
      threadUlid: thread._ulid,
      actor: "author@example.com",
    });

    const resolvedThread = resolved.threads.find((t) => t._ulid === thread._ulid)!;
    expect(resolvedThread.resolved_at).toBeDefined();
    expect(resolvedThread.resolved_by).toBe("author@example.com");
  });

  it("should record thread_resolved event", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: r1, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Fix this.",
    });

    const resolved = resolveThread(r1, {
      threadUlid: thread._ulid,
      actor: "author@example.com",
    });

    const resolveEvent = resolved.events.find((e) => e.event_type === "thread_resolved");
    expect(resolveEvent).toBeDefined();
    expect(resolveEvent!.actor).toBe("author@example.com");
    expect(resolveEvent!.payload).toEqual(expect.objectContaining({ thread_ulid: thread._ulid }));
  });

  it("should reopen a resolved thread", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: r1, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Fix this.",
    });

    const resolved = resolveThread(r1, {
      threadUlid: thread._ulid,
      actor: "author@example.com",
    });

    const reopened = reopenThread(resolved, {
      threadUlid: thread._ulid,
      actor: "reviewer@example.com",
    });

    const reopenedThread = reopened.threads.find((t) => t._ulid === thread._ulid)!;
    expect(reopenedThread.resolved_at).toBeNull();
    expect(reopenedThread.resolved_by).toBeNull();
  });

  it("should record thread_reopened event", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: r1, thread } = addThread(review, {
      author: "reviewer@example.com",
      body: "Fix this.",
    });

    const resolved = resolveThread(r1, {
      threadUlid: thread._ulid,
      actor: "author@example.com",
    });

    const reopened = reopenThread(resolved, {
      threadUlid: thread._ulid,
      actor: "reviewer@example.com",
    });

    const reopenEvent = reopened.events.find((e) => e.event_type === "thread_reopened");
    expect(reopenEvent).toBeDefined();
    expect(reopenEvent!.actor).toBe("reviewer@example.com");
  });

  it("should throw when resolving a non-existent thread", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    expect(() =>
      resolveThread(review, {
        threadUlid: "NONEXISTENT0000000000000000",
        actor: "actor@example.com",
      }),
    ).toThrow("Thread not found");
  });

  it("should throw when reopening a non-existent thread", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    expect(() =>
      reopenThread(review, {
        threadUlid: "NONEXISTENT0000000000000000",
        actor: "actor@example.com",
      }),
    ).toThrow("Thread not found");
  });
});

// ============================================================
// Helper functions
// ============================================================

describe("Thread query helpers", () => {
  it("should return unresolved blockers", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: r1, thread: blocker1 } = addThread(review, {
      author: "reviewer@example.com",
      body: "Blocker 1.",
      kind: "blocker",
    });
    const { review: r2, thread: blocker2 } = addThread(r1, {
      author: "reviewer@example.com",
      body: "Blocker 2.",
      kind: "blocker",
    });
    const { review: r3 } = addThread(r2, {
      author: "reviewer@example.com",
      body: "Just a nit.",
      kind: "nit",
    });

    // Resolve one blocker
    const r4 = resolveThread(r3, {
      threadUlid: blocker1._ulid,
      actor: "author@example.com",
    });

    const blockers = getUnresolvedBlockers(r4);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]._ulid).toBe(blocker2._ulid);
  });

  it("should return all unresolved threads", () => {
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    const { review: r1, thread: t1 } = addThread(review, {
      author: "reviewer@example.com",
      body: "Blocker.",
      kind: "blocker",
    });
    const { review: r2 } = addThread(r1, {
      author: "reviewer@example.com",
      body: "Nit.",
      kind: "nit",
    });
    const { review: r3 } = addThread(r2, {
      author: "reviewer@example.com",
      body: "Question.",
      kind: "question",
    });

    // Resolve one
    const r4 = resolveThread(r3, {
      threadUlid: t1._ulid,
      actor: "author@example.com",
    });

    const unresolved = getUnresolvedThreads(r4);
    expect(unresolved).toHaveLength(2);
  });
});

// ============================================================
// Atomic persistence operations
// ============================================================

describe("Atomic thread persistence", () => {
  let tempDir: string;
  let kspecDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    kspecDir = path.join(tempDir, ".kspec");
    await fs.mkdir(kspecDir, { recursive: true });
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should persist a thread atomically", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    const { review: _updated, thread } = await addThreadAtomic(ctx, loaded[0], {
      author: "reviewer@example.com",
      body: "Persisted thread.",
      kind: "blocker",
    });

    expect(thread._ulid).toBeDefined();

    // Reload and verify persistence
    const reloaded = await loadReviewRecords(ctx);
    expect(reloaded[0].threads).toHaveLength(1);
    expect(reloaded[0].threads[0].kind).toBe("blocker");
    expect(reloaded[0].threads[0].entries[0].body).toBe("Persisted thread.");
  });

  it("should persist a reply atomically", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    const { review: withThread, thread } = await addThreadAtomic(ctx, loaded[0], {
      author: "reviewer@example.com",
      body: "Initial.",
    });

    await addReplyAtomic(ctx, withThread, {
      threadUlid: thread._ulid,
      author: "author@example.com",
      body: "Reply here.",
    });

    const reloaded = await loadReviewRecords(ctx);
    expect(reloaded[0].threads[0].entries).toHaveLength(2);
    expect(reloaded[0].threads[0].entries[1].body).toBe("Reply here.");
  });

  it("should persist thread resolution atomically", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    const { review: withThread, thread } = await addThreadAtomic(ctx, loaded[0], {
      author: "reviewer@example.com",
      body: "Fix.",
      kind: "blocker",
    });

    await resolveThreadAtomic(ctx, withThread, {
      threadUlid: thread._ulid,
      actor: "author@example.com",
    });

    const reloaded = await loadReviewRecords(ctx);
    expect(reloaded[0].threads[0].resolved_at).toBeDefined();
    expect(reloaded[0].threads[0].resolved_by).toBe("author@example.com");
  });

  it("should persist thread reopen atomically", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("RV") }));
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    const { review: withThread, thread } = await addThreadAtomic(ctx, loaded[0], {
      author: "reviewer@example.com",
      body: "Fix.",
      kind: "blocker",
    });

    const resolved = await resolveThreadAtomic(ctx, withThread, {
      threadUlid: thread._ulid,
      actor: "author@example.com",
    });

    await reopenThreadAtomic(ctx, resolved, {
      threadUlid: thread._ulid,
      actor: "reviewer@example.com",
    });

    const reloaded = await loadReviewRecords(ctx);
    expect(reloaded[0].threads[0].resolved_at).toBeNull();
    expect(reloaded[0].threads[0].resolved_by).toBeNull();
  });
});
