/**
 * Review structured-content resource markdown rewriting — contract tests for
 * `rewriteReviewSectionResourceLinks` and `reviewSectionResourceGuidance`.
 *
 * Markdown sections of `GET /api/reviews/:id/content` carry a byte-free
 * `resource_context` naming the owning entity (plan or task), its
 * entity-scoped bytes base URL, and bounded resource metadata/status. The
 * review viewer rewrites author-style `./resources/<relative-path>` image and
 * document-link targets through the SAME shared rewriters the plan and task
 * detail views use (`rewritePlanResourceLinks` / `rewriteTaskResourceLinks`),
 * so these tests pin:
 *
 *   - plan sections rewrite declared resources to the plan-scoped bytes URL
 *     carrying selected-project routing context, and leave undeclared paths
 *     untouched;
 *   - task sections rewrite only `present` resolved resources (plan-owned
 *     refs and materialized task-owned copies) to the task-scoped bytes URL,
 *     and keep drifted/missing/unresolved/unmatched references raw with
 *     actionable guidance instead of silently serving replacement bytes.
 *
 * SCOPE — these are URL-shape unit pins for the review-page rewrite path. The
 * HTTP side (the produced URLs returning the selected project's bytes through
 * the real project-context middleware) is covered end-to-end by
 * tests/daemon-api/resource-url-browser-fetch-contract.test.ts, and the
 * review content API's resource context payload by
 * tests/daemon-diff-api.test.ts.
 *
 * Spec: @review-structured-content-viewer
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResolvedTaskResourceSummary,
  ReviewContentPlanResourceContext,
  ReviewContentTaskResourceContext,
} from "@kynetic-ai/shared";

const projectState = vi.hoisted(() => ({
  selectedPath: null as string | null,
}));

const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => projectState.selectedPath,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));

vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);

import {
  reviewSectionResourceGuidance,
  rewriteReviewSectionResourceLinks,
} from "../../packages/web-ui/src/lib/utils/review-content-resources";

const PLAN_ULID = "01TESTPXAN0000000000000000";
const TASK_ULID = "01TESTTASK0000000000000000";
const PLAN_RESOURCES_BASE = `/api/plans/${PLAN_ULID}/resources`;
const TASK_RESOURCES_BASE = `/api/tasks/${TASK_ULID}/resources`;
const SELECTED_PROJECT = "/home/me/other-project";
const SELECTED_PROJECT_QS = "%2Fhome%2Fme%2Fother-project";

function planContext(
  overrides: Partial<ReviewContentPlanResourceContext> = {},
): ReviewContentPlanResourceContext {
  return {
    owner_type: "plan",
    owner_ref: "@plan-resourced",
    resources_base_url: PLAN_RESOURCES_BASE,
    resources: [
      {
        id: "arch-png",
        label: null,
        path: "img/arch.png",
        content_type: "image/png",
        bytes: 10,
        sha256: "a".repeat(64),
        git_commit: null,
        git_path: null,
        description: null,
      },
      {
        id: "design-doc",
        label: null,
        path: "docs/design.md",
        content_type: "text/markdown",
        bytes: 20,
        sha256: "b".repeat(64),
        git_commit: null,
        git_path: null,
        description: null,
      },
    ],
    ...overrides,
  };
}

function taskResource(
  overrides: Partial<ResolvedTaskResourceSummary> = {},
): ResolvedTaskResourceSummary {
  return {
    owner_type: "plan",
    owner_ref: "@plan-resourced",
    id: "arch-png",
    path: "img/arch.png",
    content_type: "image/png",
    byte_size: 10,
    status: "present",
    recorded_sha256: "a".repeat(64),
    current_sha256: "a".repeat(64),
    recorded_git_commit: null,
    current_git_commit: null,
    message: "Resource matches the version recorded at derivation time.",
    ...overrides,
  };
}

function taskContext(resources: ResolvedTaskResourceSummary[]): ReviewContentTaskResourceContext {
  return {
    owner_type: "task",
    owner_ref: "@task-resourced",
    resources_base_url: TASK_RESOURCES_BASE,
    resources,
  };
}

beforeEach(() => {
  projectState.selectedPath = SELECTED_PROJECT;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rewriteReviewSectionResourceLinks — plan sections", () => {
  // AC: @review-structured-content-viewer ac-5
  // Declared plan resources in embedded plan content rewrite to the
  // plan-scoped bytes URL carrying selected-project routing context, so the
  // browser fetches the selected project's declared bytes.
  it("rewrites declared image and doc-link targets to selected-project plan-scoped bytes URLs", () => {
    const markdown =
      "![arch](./resources/img/arch.png) and read [the doc](./resources/docs/design.md)";
    const out = rewriteReviewSectionResourceLinks(markdown, planContext());

    expect(out).toContain(
      `![arch](${PLAN_RESOURCES_BASE}/arch-png/bytes?kspec_dir=${SELECTED_PROJECT_QS})`,
    );
    expect(out).toContain(
      `[the doc](${PLAN_RESOURCES_BASE}/design-doc/bytes?kspec_dir=${SELECTED_PROJECT_QS})`,
    );
  });

  // AC: @review-structured-content-viewer ac-5
  // Undeclared paths have no manifest entry, so the reference must stay
  // visible untouched instead of being rewritten to a guessed destination.
  it("does not rewrite undeclared resource paths", () => {
    const markdown = "![ghost](./resources/img/undeclared.png)";
    const out = rewriteReviewSectionResourceLinks(markdown, planContext());
    expect(out).toBe(markdown);
  });

  // AC: @review-structured-content-viewer ac-5
  it("emits plain plan-scoped URLs with no kspec_dir when no project is selected", () => {
    projectState.selectedPath = null;
    const out = rewriteReviewSectionResourceLinks(
      "![arch](./resources/img/arch.png)",
      planContext(),
    );
    expect(out).toBe(`![arch](${PLAN_RESOURCES_BASE}/arch-png/bytes)`);
  });
});

describe("rewriteReviewSectionResourceLinks — task sections", () => {
  // AC: @review-structured-content-viewer ac-6
  // Present resolved resources — both plan-owned references and materialized
  // task-owned copies — rewrite through the task-scoped bytes URL with
  // selected-project routing context.
  it("rewrites present plan-owned and task-owned targets to selected-project task-scoped bytes URLs", () => {
    const markdown = "![arch](./resources/img/arch.png) ![copy](./resources/img/copy.png)";
    const out = rewriteReviewSectionResourceLinks(
      markdown,
      taskContext([
        taskResource({ id: "arch-png", path: "img/arch.png", owner_type: "plan" }),
        taskResource({
          id: "copy-png",
          path: "img/copy.png",
          owner_type: "task",
          owner_ref: TASK_ULID,
        }),
      ]),
    );

    expect(out).toContain(
      `![arch](${TASK_RESOURCES_BASE}/arch-png/bytes?kspec_dir=${SELECTED_PROJECT_QS})`,
    );
    expect(out).toContain(
      `![copy](${TASK_RESOURCES_BASE}/copy-png/bytes?kspec_dir=${SELECTED_PROJECT_QS})`,
    );
  });

  // AC: @review-structured-content-viewer ac-6
  // Drifted/missing/unresolved resources must NOT be rewritten — serving the
  // current bytes would silently differ from what the task was derived
  // against. The raw reference stays visible.
  it("leaves drifted, missing, and unresolved references raw", () => {
    const markdown =
      "[drifty](./resources/docs/drifty.md) ![gone](./resources/img/gone.png) ![lost](./resources/img/lost.png)";
    const out = rewriteReviewSectionResourceLinks(
      markdown,
      taskContext([
        taskResource({ id: "drifty-doc", path: "docs/drifty.md", status: "drift" }),
        taskResource({ id: "gone-png", path: "img/gone.png", status: "missing" }),
        taskResource({ id: "lost-png", path: "img/lost.png", status: "unresolved" }),
      ]),
    );
    expect(out).toBe(markdown);
  });

  it("returns markdown unchanged when the section has no resource context", () => {
    const markdown = "![arch](./resources/img/arch.png)";
    expect(rewriteReviewSectionResourceLinks(markdown, undefined)).toBe(markdown);
  });
});

describe("reviewSectionResourceGuidance", () => {
  // AC: @review-structured-content-viewer ac-6
  // Non-present resolved resources and unmatched authoring references are
  // surfaced as visible status messages — never silently dropped behind a
  // broken <img>/<a> target.
  it("lists drifted resources and unmatched references with actionable messages", () => {
    const markdown =
      "![arch](./resources/img/arch.png) [drifty](./resources/docs/drifty.md) ![nowhere](./resources/img/nowhere.png)";
    const guidance = reviewSectionResourceGuidance(
      markdown,
      taskContext([
        taskResource({ id: "arch-png", path: "img/arch.png", status: "present" }),
        taskResource({
          id: "drifty-doc",
          path: "docs/drifty.md",
          status: "drift",
          message: "Resource has changed since this task was derived.",
        }),
      ]),
    );

    expect(guidance).toHaveLength(2);

    const drifted = guidance.find((g) => g.status === "drift");
    expect(drifted?.path).toBe("docs/drifty.md");
    expect(drifted?.message).toBe("Resource has changed since this task was derived.");

    const unmatched = guidance.find((g) => g.status === "unmatched");
    expect(unmatched?.path).toBe("img/nowhere.png");
    expect(unmatched?.message).toContain("No matching task resource");
  });

  // AC: @review-structured-content-viewer ac-6
  it("reports no guidance when every referenced resource is present", () => {
    const markdown = "![arch](./resources/img/arch.png)";
    const guidance = reviewSectionResourceGuidance(
      markdown,
      taskContext([taskResource({ id: "arch-png", path: "img/arch.png", status: "present" })]),
    );
    expect(guidance).toEqual([]);
  });

  // AC: @review-structured-content-viewer ac-5
  // Plan sections surface no guidance block: only declared resources are in
  // context and undeclared paths simply stay visible untouched in the
  // rendered markdown.
  it("returns no guidance for plan contexts and sections without context", () => {
    expect(
      reviewSectionResourceGuidance("![ghost](./resources/img/undeclared.png)", planContext()),
    ).toEqual([]);
    expect(reviewSectionResourceGuidance("anything", undefined)).toEqual([]);
  });
});
