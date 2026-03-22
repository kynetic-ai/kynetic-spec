/**
 * Structured Content Viewer Tests
 *
 * Static analysis and structural tests verifying the structured content viewer
 * components for plan/spec reviews, including section rendering, inline
 * commenting with structured anchors, and thread positioning.
 *
 * Spec: @review-structured-content-viewer
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB_UI_SRC = join(process.cwd(), "packages", "web-ui", "src");
const CONTENT_DIR = join(WEB_UI_SRC, "lib", "components", "content");
const REVIEW_DETAIL_PATH = join(
  WEB_UI_SRC,
  "routes",
  "reviews",
  "[id]",
  "+page.svelte",
);
const API_PATH = join(WEB_UI_SRC, "lib", "api.ts");
const QUERY_KEYS_PATH = join(WEB_UI_SRC, "lib", "query", "keys.ts");

// Load source files
const viewerSrc = readFileSync(
  join(CONTENT_DIR, "StructuredContentViewer.svelte"),
  "utf-8",
);
const commentFormSrc = readFileSync(
  join(CONTENT_DIR, "ContentCommentForm.svelte"),
  "utf-8",
);
const inlineThreadSrc = readFileSync(
  join(CONTENT_DIR, "ContentInlineThread.svelte"),
  "utf-8",
);
const indexSrc = readFileSync(join(CONTENT_DIR, "index.ts"), "utf-8");
const reviewDetailSrc = readFileSync(REVIEW_DETAIL_PATH, "utf-8");
const apiSrc = readFileSync(API_PATH, "utf-8");
const queryKeysSrc = readFileSync(QUERY_KEYS_PATH, "utf-8");

// AC: @review-structured-content-viewer ac-1
describe("Plan content rendering (ac-1)", () => {
  it("should fetch review content from the API", () => {
    expect(viewerSrc).toContain("fetchReviewContent");
    expect(viewerSrc).toContain("queryKeys.reviews.content");
  });

  it("should render markdown sections", () => {
    expect(viewerSrc).toContain("section.type === 'markdown'");
    expect(viewerSrc).toContain("renderMarkdown(section.content)");
  });

  it("should render ref_list sections for specs and tasks", () => {
    expect(viewerSrc).toContain("section.type === 'ref_list'");
    expect(viewerSrc).toContain("section-ref-list");
  });

  it("should render notes sections", () => {
    expect(viewerSrc).toContain("section.type === 'notes'");
    expect(viewerSrc).toContain("section-notes-list");
  });

  it("should display section titles", () => {
    expect(viewerSrc).toContain("section-title");
    expect(viewerSrc).toContain("section.title");
  });

  it("should show loading state while fetching content", () => {
    expect(viewerSrc).toContain("contentLoading");
    expect(viewerSrc).toContain("Loading content...");
  });

  it("should show error state on fetch failure", () => {
    expect(viewerSrc).toContain("contentError");
    expect(viewerSrc).toContain("content-error");
  });
});

// AC: @review-structured-content-viewer ac-2
describe("Spec content rendering (ac-2)", () => {
  it("should render acceptance_criteria sections with individual AC items", () => {
    expect(viewerSrc).toContain("section.type === 'acceptance_criteria'");
    expect(viewerSrc).toContain("section-ac-list");
    expect(viewerSrc).toContain("ac-item");
  });

  it("should display AC given/when/then fields", () => {
    expect(viewerSrc).toContain("ac.given");
    expect(viewerSrc).toContain("ac.when");
    expect(viewerSrc).toContain("ac.then");
  });

  it("should display AC identifiers", () => {
    expect(viewerSrc).toContain("ac.id");
    expect(viewerSrc).toContain("data-ac-id");
  });

  it("should render metadata sections", () => {
    expect(viewerSrc).toContain("section.type === 'metadata'");
    expect(viewerSrc).toContain("section-metadata");
  });

  it("should make each AC individually targetable for comments", () => {
    expect(viewerSrc).toContain("ac-comment-button");
    expect(viewerSrc).toContain(
      "openCommentForm('acceptance_criteria', ac.id)",
    );
  });

  it("should make each section targetable for comments", () => {
    expect(viewerSrc).toContain("section-comment-button");
    expect(viewerSrc).toContain("openCommentForm(section.id)");
  });
});

// AC: @review-structured-content-viewer ac-3
describe("Comment creation with structured anchors (ac-3)", () => {
  it("should create threads with structured anchor type", () => {
    expect(viewerSrc).toContain("type: 'structured'");
    expect(viewerSrc).toContain("section: data.section");
    expect(viewerSrc).toContain("field: data.field");
  });

  it("should include subject_ref in the anchor", () => {
    expect(viewerSrc).toContain("content?.subject_ref");
  });

  it("should use createReviewThread with anchor parameter", () => {
    expect(viewerSrc).toContain("createReviewThread(review._ulid");
  });

  it("should track which section/field is being commented on", () => {
    expect(viewerSrc).toContain("commentingOnSection");
    expect(viewerSrc).toContain("commentingOnField");
  });

  it("should render the ContentCommentForm component", () => {
    expect(viewerSrc).toContain("ContentCommentForm");
    expect(commentFormSrc).toContain("content-comment-form");
    expect(commentFormSrc).toContain("content-comment-body");
    expect(commentFormSrc).toContain("content-comment-submit");
  });

  it("comment form should support kind selection", () => {
    expect(commentFormSrc).toContain("'blocker'");
    expect(commentFormSrc).toContain("'question'");
    expect(commentFormSrc).toContain("'nit'");
    expect(commentFormSrc).toContain("content-comment-kind");
  });
});

// AC: @review-structured-content-viewer ac-4
describe("Inline thread rendering at anchored positions (ac-4)", () => {
  it("should find threads matching section anchors", () => {
    expect(viewerSrc).toContain("getThreadsForSection");
    expect(viewerSrc).toContain("t.anchor.type !== 'structured'");
    expect(viewerSrc).toContain("t.anchor.section !== sectionId");
  });

  it("should find threads matching AC field anchors", () => {
    expect(viewerSrc).toContain("getThreadsForAcField");
    expect(viewerSrc).toContain(
      "t.anchor.section === 'acceptance_criteria'",
    );
    expect(viewerSrc).toContain("t.anchor.field === acId");
  });

  it("should render inline threads within AC items", () => {
    // Threads are rendered per-AC within the acceptance_criteria loop
    expect(viewerSrc).toContain("acThreads");
    expect(viewerSrc).toMatch(
      /each acThreads as thread/,
    );
  });

  it("should render inline threads within non-AC sections", () => {
    expect(viewerSrc).toContain("sectionThreads");
    expect(viewerSrc).toMatch(
      /each sectionThreads as thread/,
    );
  });

  it("should render ContentInlineThread with interaction callbacks", () => {
    expect(viewerSrc).toContain("ContentInlineThread");
    expect(viewerSrc).toContain("onReply={handleReply}");
    expect(viewerSrc).toContain("onResolve={handleResolve}");
    expect(viewerSrc).toContain("onReopen={handleReopen}");
  });

  it("ContentInlineThread should display thread kind badges", () => {
    expect(inlineThreadSrc).toContain("content-inline-thread");
    expect(inlineThreadSrc).toContain("getKindColor");
    expect(inlineThreadSrc).toContain("thread.kind");
  });

  it("ContentInlineThread should support reply/resolve/reopen interactions", () => {
    expect(inlineThreadSrc).toContain("onReply");
    expect(inlineThreadSrc).toContain("onResolve");
    expect(inlineThreadSrc).toContain("onReopen");
    expect(inlineThreadSrc).toContain("content-thread-reply-form");
  });

  it("ContentInlineThread should be collapsible when resolved", () => {
    expect(inlineThreadSrc).toContain("collapsed");
    expect(inlineThreadSrc).toContain("thread.resolved_at");
  });
});

describe("Integration with review detail page", () => {
  it("should import StructuredContentViewer in the review detail page", () => {
    expect(reviewDetailSrc).toContain("StructuredContentViewer");
    expect(reviewDetailSrc).toContain("$lib/components/content");
  });

  it("should detect plan/spec/task subjects for structured content", () => {
    expect(reviewDetailSrc).toContain("hasStructuredContent");
    expect(reviewDetailSrc).toContain("subject.type === 'plan'");
    expect(reviewDetailSrc).toContain("subject.type === 'spec'");
    expect(reviewDetailSrc).toContain("subject.type === 'task'");
  });

  it("should render structured content section with test ID", () => {
    expect(reviewDetailSrc).toContain("structured-content-section");
  });

  it("should pass review, threads, and isInteractive to the viewer", () => {
    expect(reviewDetailSrc).toContain("{review}");
    expect(reviewDetailSrc).toContain("threads={review.threads}");
    expect(reviewDetailSrc).toContain("{isInteractive}");
  });

  it("should have AC annotations for structured content viewer spec", () => {
    expect(reviewDetailSrc).toContain(
      "AC: @review-structured-content-viewer ac-1",
    );
    expect(reviewDetailSrc).toContain(
      "AC: @review-structured-content-viewer ac-2",
    );
    expect(reviewDetailSrc).toContain(
      "AC: @review-structured-content-viewer ac-3",
    );
    expect(reviewDetailSrc).toContain(
      "AC: @review-structured-content-viewer ac-4",
    );
  });
});

describe("API and query infrastructure", () => {
  it("should export fetchReviewContent function", () => {
    expect(apiSrc).toContain("export async function fetchReviewContent");
  });

  it("fetchReviewContent should call GET /api/reviews/:id/content", () => {
    expect(apiSrc).toContain("/api/reviews/");
    expect(apiSrc).toContain("/content");
  });

  it("should export content section types", () => {
    expect(apiSrc).toContain("export interface ContentSectionMarkdown");
    expect(apiSrc).toContain("export interface ContentSectionRefList");
    expect(apiSrc).toContain(
      "export interface ContentSectionAcceptanceCriteria",
    );
    expect(apiSrc).toContain("export interface ContentSectionNotes");
    expect(apiSrc).toContain("export interface ContentSectionMetadata");
    expect(apiSrc).toContain("export type ContentSection");
    expect(apiSrc).toContain("export interface ReviewContentResponse");
  });

  it("should have reviews.content query key", () => {
    expect(queryKeysSrc).toContain("content:");
    expect(queryKeysSrc).toContain("'content'");
  });

  it("createReviewThread should accept anchor parameter", () => {
    expect(apiSrc).toContain("anchor?: {");
    expect(apiSrc).toContain("type: 'code'");
    expect(apiSrc).toContain("type: 'structured'");
    expect(apiSrc).toContain("section?: string");
    expect(apiSrc).toContain("field?: string");
  });
});

describe("Component barrel exports", () => {
  it("should export StructuredContentViewer", () => {
    expect(indexSrc).toContain("StructuredContentViewer");
  });

  it("should export ContentCommentForm", () => {
    expect(indexSrc).toContain("ContentCommentForm");
  });

  it("should export ContentInlineThread", () => {
    expect(indexSrc).toContain("ContentInlineThread");
  });
});

describe("Component file structure", () => {
  it("should have all required component files", () => {
    expect(
      existsSync(join(CONTENT_DIR, "StructuredContentViewer.svelte")),
    ).toBe(true);
    expect(
      existsSync(join(CONTENT_DIR, "ContentCommentForm.svelte")),
    ).toBe(true);
    expect(
      existsSync(join(CONTENT_DIR, "ContentInlineThread.svelte")),
    ).toBe(true);
    expect(existsSync(join(CONTENT_DIR, "index.ts"))).toBe(true);
  });
});
