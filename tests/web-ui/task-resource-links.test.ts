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
  it.fails("rewrites a plan-owned image target to the selected-project task-scoped bytes URL", () => {
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
  it.fails("rewrites a plan-owned document link to the selected-project task-scoped bytes URL", () => {
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
  it.fails("rewrites a materialized task-owned image target to the selected-project task-scoped bytes URL", () => {
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
  it.fails("rewrites a materialized task-owned document link to the selected-project task-scoped bytes URL", () => {
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
  it.fails("rewrites to the task-scoped bytes URL without kspec_dir when no project is selected", () => {
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

  // Regression guard for the present-only gate (the drift/missing/unresolved
  // visibility AC itself is owned by @generalize-live-ui-resource-markdown-rewriting).
  // A non-`present` resolved resource must NOT be rewritten to a bytes URL that
  // would silently serve different bytes — the raw reference stays visible. The
  // no-op stub satisfies this today and must keep doing so after the rewrite.
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
