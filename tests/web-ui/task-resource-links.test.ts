/**
 * Task description resource-link rewriting — contract tests for
 * `rewriteTaskResourceLinks`.
 *
 * Task descriptions can author `./resources/<relative-path>` markdown image and
 * document-link targets that point at the task's resolved resources. Unlike
 * plan resources (whose `path -> id` mapping comes straight off the owning
 * plan manifest), a task's resources are the versioned `resource_refs`
 * projected by the daemon as `resolved_resources`. Each projected entry may be
 * plan-owned (a non-drifted reference back to the owning plan's manifest) or
 * task-owned (a copy materialized with `kspec plan derive
 * --materialize-resources`). Both render through the same task-scoped bytes
 * route, so the rewriter only needs the resolved entry's `id`, `path`, and
 * `status` to build a URL.
 *
 * The browser-fetchable URL must carry selected-project routing context the
 * same way review resources do (`reviewResourceBytesUrl` in `$lib/api`): an
 * `<img src>` / `<a href>` request cannot send the `X-Kspec-Dir` header, so
 * the selected project's path travels as a `?kspec_dir=` query parameter built
 * from the project store. The rewritten URL therefore equals
 * `${resourcesBaseUrl}/${encodeURIComponent(id)}/bytes` plus
 * `?kspec_dir=${encodeURIComponent(path)}` when a non-default project is
 * selected.
 *
 * IMPLEMENTATION STATUS — these are tests-first contract tests. The behaviour
 * under test is a no-op STUB today (`rewriteTaskResourceLinks` returns the
 * input markdown unchanged); the sibling task
 * `@generalize-live-ui-resource-markdown-rewriting` implements the rewrite and
 * flips the `it.fails` contract tests below to `it` (the repo's
 * FLIPPED-ON-FIX protocol — see tests/lint-no-leaky-test-daemon.test.ts). The
 * negative-path tests (unmatched / drift stay raw) are normal `it` because the
 * no-op stub already satisfies them and they must keep passing after the fix.
 *
 * SCOPE — these are URL-SHAPE unit pins for the rewriter. The ACs' HTTP "Then"
 * clauses (fetching the produced URL WITHOUT `X-Kspec-Dir` in a multi-project
 * daemon returns the selected project's resolved bytes, and the plan-owned vs
 * task-owned owner projection is what gets served) are asserted end-to-end in
 * tests/daemon-api/resource-url-browser-fetch-contract.test.ts, which fetches
 * each rewritten URL through the real project-context middleware.
 *
 * Spec: @live-task-resource-markdown-rendering
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  findUnmatchedTaskResourceReferences,
  rewriteTaskResourceLinks,
  type ResolvedTaskResourceLink,
} from "../../packages/web-ui/src/lib/utils/task-resource-links";

const TASK_ULID = "01TESTTASK0000000000000000";
const TASK_RESOURCES_BASE = `/api/tasks/${TASK_ULID}/resources`;
const SELECTED_PROJECT = "/home/me/other-project";
const SELECTED_PROJECT_QS = "%2Fhome%2Fme%2Fother-project";

function resource(overrides: Partial<ResolvedTaskResourceLink> = {}): ResolvedTaskResourceLink {
  return {
    id: "diagram",
    path: "diagrams/flow.png",
    status: "present",
    owner_type: "plan",
    ...overrides,
  };
}

beforeEach(() => {
  projectState.selectedPath = SELECTED_PROJECT;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rewriteTaskResourceLinks", () => {
  // AC: @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
  // A non-drifted plan-owned resource: the `./resources/<path>` image target
  // is rewritten to the task-scoped bytes URL carrying the selected project's
  // routing context so the browser fetches that project's recorded plan
  // resource image.
  it("rewrites a plan-owned image target to the selected-project task-scoped bytes URL", () => {
    const markdown = "Flow: ![flow](./resources/diagrams/flow.png)";
    const out = rewriteTaskResourceLinks(
      markdown,
      [resource({ id: "diagram", path: "diagrams/flow.png", owner_type: "plan" })],
      TASK_RESOURCES_BASE,
    );
    expect(out).toBe(
      `Flow: ![flow](${TASK_RESOURCES_BASE}/diagram/bytes?kspec_dir=${SELECTED_PROJECT_QS})`,
    );
  });

  // AC: @live-task-resource-markdown-rendering ac-plan-owned-task-doc-link-opens
  // A non-drifted plan-owned document link is rewritten so opening it fetches
  // the recorded plan resource document bytes from the selected project.
  it("rewrites a plan-owned document link to the selected-project task-scoped bytes URL", () => {
    const markdown = "See [the spec](./resources/docs/spec.md) for details.";
    const out = rewriteTaskResourceLinks(
      markdown,
      [resource({ id: "specdoc", path: "docs/spec.md", owner_type: "plan" })],
      TASK_RESOURCES_BASE,
    );
    expect(out).toBe(
      `See [the spec](${TASK_RESOURCES_BASE}/specdoc/bytes?kspec_dir=${SELECTED_PROJECT_QS}) for details.`,
    );
  });

  // AC: @live-task-resource-markdown-rendering ac-materialized-task-image-renders
  // A task-owned copy (derived with --materialize-resources): the image target
  // is rewritten through the same task-scoped bytes route so the browser
  // displays the copied task-owned image.
  it("rewrites a materialized task-owned image target to the selected-project task-scoped bytes URL", () => {
    const markdown = "Home: ![home](./resources/screens/home.png)";
    const out = rewriteTaskResourceLinks(
      markdown,
      [resource({ id: "homecopy", path: "screens/home.png", owner_type: "task" })],
      TASK_RESOURCES_BASE,
    );
    expect(out).toBe(
      `Home: ![home](${TASK_RESOURCES_BASE}/homecopy/bytes?kspec_dir=${SELECTED_PROJECT_QS})`,
    );
  });

  // AC: @live-task-resource-markdown-rendering ac-materialized-task-doc-link-opens
  // A task-owned copy document link is rewritten so opening it fetches the
  // copied task-owned document bytes from the selected project.
  it("rewrites a materialized task-owned document link to the selected-project task-scoped bytes URL", () => {
    const markdown = "Read [the notes](./resources/docs/notes.md).";
    const out = rewriteTaskResourceLinks(
      markdown,
      [resource({ id: "notescopy", path: "docs/notes.md", owner_type: "task" })],
      TASK_RESOURCES_BASE,
    );
    expect(out).toBe(
      `Read [the notes](${TASK_RESOURCES_BASE}/notescopy/bytes?kspec_dir=${SELECTED_PROJECT_QS}).`,
    );
  });

  // AC: @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
  //     — when no project is selected the task-scoped bytes URL is emitted
  //     without a kspec_dir query (default project routing). Guards the base
  //     URL contract independent of project context.
  it("rewrites to the task-scoped bytes URL without kspec_dir when no project is selected", () => {
    projectState.selectedPath = null;
    const markdown = "![flow](./resources/diagrams/flow.png)";
    const out = rewriteTaskResourceLinks(
      markdown,
      [resource({ id: "diagram", path: "diagrams/flow.png" })],
      TASK_RESOURCES_BASE,
    );
    expect(out).toBe(`![flow](${TASK_RESOURCES_BASE}/diagram/bytes)`);
  });

  // AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw
  // A `./resources/<path>` reference with no matching resolved resource path
  // must remain visible (raw) rather than being rewritten to `/resources/...`
  // or an unrelated entity URL. The no-op stub already satisfies this; it must
  // keep holding after the rewrite lands.
  it("leaves an unmatched ./resources/ reference raw", () => {
    const markdown = "Missing: ![gone](./resources/screens/missing.png)";
    const out = rewriteTaskResourceLinks(
      markdown,
      [resource({ id: "diagram", path: "diagrams/flow.png" })],
      TASK_RESOURCES_BASE,
    );
    expect(out).toBe(markdown);
  });

  // AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw
  // No resolved resources at all (or a missing base URL): nothing to rewrite,
  // the raw authoring reference stays visible.
  it("returns the original markdown when there are no resolved resources or no base URL", () => {
    const markdown = "Look: ![flow](./resources/diagrams/flow.png)";
    expect(rewriteTaskResourceLinks(markdown, [], TASK_RESOURCES_BASE)).toBe(markdown);
    expect(rewriteTaskResourceLinks(markdown, undefined, TASK_RESOURCES_BASE)).toBe(markdown);
    expect(rewriteTaskResourceLinks(markdown, [resource()], undefined)).toBe(markdown);
    expect(rewriteTaskResourceLinks(markdown, [resource()], "")).toBe(markdown);
  });

  // AC: @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent
  // The "does not rewrite to a URL that silently serves different bytes" half of
  // the AC: a non-`present` resolved resource must NOT be rewritten to a bytes
  // URL — the raw reference stays visible. (The companion "UI shows the resource
  // status message" half is rendered by the resources-needing-attention section
  // in TaskDetailContent.svelte.)
  it("does not rewrite a drifted/missing/unresolved task resource reference", () => {
    const markdown = "![flow](./resources/diagrams/flow.png)";
    for (const status of ["drift", "missing", "unresolved"] as const) {
      const out = rewriteTaskResourceLinks(
        markdown,
        [resource({ id: "diagram", path: "diagrams/flow.png", status })],
        TASK_RESOURCES_BASE,
      );
      expect(out).toBe(markdown);
    }
  });

  // External https:// links that merely share a `/resources/` path segment must
  // never be rewritten — only author-style `./resources/<path>` references are
  // in scope. Holds under the stub and must hold after the rewrite.
  it("does not rewrite external https:// links that share a similar path", () => {
    const markdown = "External: [example](https://example.com/resources/diagrams/flow.png)";
    const out = rewriteTaskResourceLinks(
      markdown,
      [resource({ id: "diagram", path: "diagrams/flow.png" })],
      TASK_RESOURCES_BASE,
    );
    expect(out).toBe(markdown);
  });
});

/**
 * `findUnmatchedTaskResourceReferences` is the guidance-computation the live
 * task detail modal (`TaskDetailContent.svelte`) consumes to render its
 * "Resources needing attention" section for `./resources/<path>` references
 * that resolve to NO task resource at all.
 *
 * The rewriter leaves such references raw, which renders as a broken
 * `<img src>`/`<a href>` whose path the reader never sees — so without this
 * detection the unresolved authoring reference would be silent. These tests
 * pin the modal's actual decision logic: which references get surfaced as
 * visible guidance versus which already resolve (present or non-present) and
 * are handled elsewhere.
 *
 * Spec: @live-task-resource-markdown-rendering
 */
describe("findUnmatchedTaskResourceReferences", () => {
  // AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw
  // A description reference with no matching resolved resource path is reported
  // so the modal can surface the raw reference with actionable guidance instead
  // of letting it vanish into a broken <img>/<a> target.
  it("reports a ./resources/ reference that matches no resolved resource", () => {
    const markdown = "Missing: ![gone](./resources/screens/missing.png)";
    const unmatched = findUnmatchedTaskResourceReferences(markdown, [
      resource({ id: "diagram", path: "diagrams/flow.png" }),
    ]);
    expect(unmatched).toEqual(["screens/missing.png"]);
  });

  // AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw
  // With no resolved resources at all, every authored reference is unmatched and
  // must be surfaced rather than silently rewritten.
  it("reports references when the task has no resolved resources", () => {
    const markdown = "See ![a](./resources/a.png) and [b](./resources/docs/b.md).";
    expect(findUnmatchedTaskResourceReferences(markdown, [])).toEqual(["a.png", "docs/b.md"]);
    expect(findUnmatchedTaskResourceReferences(markdown, undefined)).toEqual([
      "a.png",
      "docs/b.md",
    ]);
  });

  // AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw
  // A reference that DOES resolve — whether `present` or a non-`present`
  // drift/missing/unresolved entry — is NOT unmatched: present refs are
  // rewritten, and non-present refs are surfaced through the resolved-resource
  // status projection instead. Only truly absent references are reported here.
  it("does not report references that resolve to a task resource (any status)", () => {
    const markdown =
      "![present](./resources/diagrams/flow.png) ![drifted](./resources/docs/spec.md)";
    const unmatched = findUnmatchedTaskResourceReferences(markdown, [
      resource({ id: "diagram", path: "diagrams/flow.png", status: "present" }),
      resource({ id: "specdoc", path: "docs/spec.md", status: "drift" }),
    ]);
    expect(unmatched).toEqual([]);
  });

  // AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw
  // Only matched references are filtered out; unmatched ones in the same
  // description are still reported. De-duplicates repeated references.
  it("reports only the unmatched references and de-duplicates them", () => {
    const markdown =
      "![ok](./resources/diagrams/flow.png) ![x](./resources/screens/missing.png) again ![x2](./resources/screens/missing.png)";
    const unmatched = findUnmatchedTaskResourceReferences(markdown, [
      resource({ id: "diagram", path: "diagrams/flow.png" }),
    ]);
    expect(unmatched).toEqual(["screens/missing.png"]);
  });

  // External https:// links that merely share a `/resources/` segment are not
  // author-style references and must not be reported as unmatched guidance.
  it("ignores external https:// links that share a similar path", () => {
    const markdown = "[example](https://example.com/resources/screens/missing.png)";
    expect(findUnmatchedTaskResourceReferences(markdown, [])).toEqual([]);
  });

  // No description (or no authored references) means no guidance to surface.
  it("returns an empty list when the description has no resource references", () => {
    expect(findUnmatchedTaskResourceReferences(undefined, [])).toEqual([]);
    expect(findUnmatchedTaskResourceReferences("", [])).toEqual([]);
    expect(findUnmatchedTaskResourceReferences("Plain text, no resources.", [])).toEqual([]);
  });
});
