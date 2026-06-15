/**
 * Standard View Header component tests.
 *
 * Behavioral tests that server-render the real ViewHeader and StatusBadge
 * components (via the web-ui Vite pipeline + svelte/server) and assert on the
 * rendered DOM. No source scanning — each test renders the component with props
 * and inspects what it produces.
 *
 * Spec: @ui-view-header ac-1 (zones), ac-3 (empty leading chrome zone),
 *       ac-4 (counts are props, no fetch path), ac-5 (actions zone + keyboard).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";

const WEB_UI_ROOT = resolve(process.cwd(), "packages", "web-ui");
const ORIGINAL_CWD = process.cwd();

let server: ViteDevServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let render: (component: any, options: { props?: Record<string, unknown> }) => { body: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createRawSnippet: (fn: (...args: any[]) => { render: () => string }) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ViewHeader: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let StatusBadge: any;

beforeAll(async () => {
  process.chdir(WEB_UI_ROOT);
  server = await createServer({
    root: WEB_UI_ROOT,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  process.chdir(ORIGINAL_CWD);

  ({ render } = (await server.ssrLoadModule("svelte/server")) as typeof import("svelte/server"));
  ({ createRawSnippet } = (await server.ssrLoadModule("svelte")) as typeof import("svelte"));
  ViewHeader = (await server.ssrLoadModule("/src/lib/components/ds/ViewHeader.svelte")).default;
  StatusBadge = (await server.ssrLoadModule("/src/lib/components/ds/StatusBadge.svelte")).default;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

async function parse(body: string): Promise<HTMLElement> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<div id="root">${body}</div>`);
  return dom.window.document.getElementById("root") as unknown as HTMLElement;
}

function actionSnippet(html: string): unknown {
  return createRawSnippet(() => ({ render: () => html }));
}

describe("ViewHeader zones (@ui-view-header ac-1)", () => {
  // AC: @ui-view-header ac-1
  it("presents reference, state indicator, child counts, and an actions zone", async () => {
    const out = render(ViewHeader, {
      props: {
        title: "Some Entity",
        reference: "task-do-the-thing",
        statusDomain: "task",
        statusState: "in_progress",
        statusTestid: "the-state",
        counts: [
          { label: "threads", value: 3, testid: "count-threads" },
          { label: "checks", value: 2, testid: "count-checks" },
        ],
        actions: actionSnippet(
          '<button type="button" data-testid="primary-action">Approve</button>',
        ),
      },
    });
    const root = await parse(out.body);

    // Reference zone with the (shortened) ref.
    const refZone = root.querySelector('[data-testid="view-header-reference"]');
    expect(refZone).not.toBeNull();
    expect(root.querySelector('[data-testid="view-header-ref"]')?.textContent).toContain(
      "@task-do-the-thing",
    );
    expect(root.querySelector('[data-testid="view-header-title"]')?.textContent).toContain(
      "Some Entity",
    );

    // State indicator drawn from the token vocabulary (glyph + label).
    const state = root.querySelector('[data-testid="the-state"]');
    expect(state).not.toBeNull();
    expect(state?.getAttribute("data-status-domain")).toBe("task");
    expect(state?.getAttribute("data-status-state")).toBe("in_progress");
    expect(state?.textContent).toContain("In Progress");

    // Child counts.
    const counts = root.querySelector('[data-testid="view-header-counts"]');
    expect(counts).not.toBeNull();
    expect(root.querySelector('[data-testid="count-threads"]')?.textContent).toContain("3");
    expect(root.querySelector('[data-testid="count-checks"]')?.textContent).toContain("2");

    // Actions zone present and populated.
    const actions = root.querySelector('[data-testid="view-header-actions"]');
    expect(actions).not.toBeNull();
    expect(actions?.querySelector('[data-testid="primary-action"]')).not.toBeNull();
  });

  // AC: @ui-view-header ac-1
  it("renders a copyable entity reference as a keyboard-operable button", async () => {
    const out = render(ViewHeader, {
      props: { reference: "01ABCDEF01ABCDEF01ABCDEF01" },
    });
    const root = await parse(out.body);

    const copy = root.querySelector('[data-testid="view-header-copy"]');
    expect(copy).not.toBeNull();
    // Native <button> is inherently focusable + Enter/Space operable.
    expect(copy?.tagName.toLowerCase()).toBe("button");
    expect(copy?.getAttribute("aria-label")).toContain("01ABCDEF01ABCDEF01ABCDEF01");
  });
});

describe("ViewHeader leading chrome zone (@ui-view-header ac-3)", () => {
  // AC: @ui-view-header ac-3
  it("renders a leading zone that contains no header element", async () => {
    const out = render(ViewHeader, {
      props: {
        reference: "task-x",
        statusDomain: "task",
        statusState: "blocked",
        counts: [{ label: "notes", value: 1 }],
        actions: actionSnippet('<button type="button" data-testid="a">A</button>'),
      },
    });
    const root = await parse(out.body);

    const leading = root.querySelector('[data-testid="view-header-leading"]');
    expect(leading).not.toBeNull();
    // The reservation zone holds no element at all.
    expect(leading?.children.length).toBe(0);
    expect(leading?.textContent?.trim()).toBe("");
    // It is sized by the single named reservation value.
    expect(leading?.getAttribute("style")).toContain("--ds-chrome-leading-reservation");

    // No header element (reference, state, counts, actions) lives inside it.
    for (const testid of [
      "view-header-reference",
      "view-header-state-zone",
      "view-header-counts",
      "view-header-actions",
    ]) {
      const el = root.querySelector(`[data-testid="${testid}"]`);
      expect(el).not.toBeNull();
      expect(leading?.contains(el)).toBe(false);
    }
  });
});

describe("ViewHeader child counts come from props (@ui-view-header ac-4)", () => {
  // AC: @ui-view-header ac-4
  it("renders exactly the server-resolved count values it is given", async () => {
    const out = render(ViewHeader, {
      props: {
        reference: "session-1",
        counts: [
          { label: "events", value: 42, testid: "c-events" },
          { label: "iterations", value: 7, testid: "c-iter" },
        ],
      },
    });
    const root = await parse(out.body);
    expect(root.querySelector('[data-testid="c-events"]')?.textContent).toContain("42");
    expect(root.querySelector('[data-testid="c-events"]')?.textContent).toContain("events");
    expect(root.querySelector('[data-testid="c-iter"]')?.textContent).toContain("7");
  });

  // AC: @ui-view-header ac-4
  it("renders no counts zone when no counts are provided", async () => {
    const out = render(ViewHeader, { props: { reference: "session-2" } });
    const root = await parse(out.body);
    expect(root.querySelector('[data-testid="view-header-counts"]')).toBeNull();
  });
});

describe("ViewHeader actions zone (@ui-view-header ac-5)", () => {
  // AC: @ui-view-header ac-5
  it("renders actions only inside the designated actions zone", async () => {
    const out = render(ViewHeader, {
      props: {
        reference: "task-y",
        actions: actionSnippet('<button type="button" data-testid="act-1">Run</button>'),
      },
    });
    const root = await parse(out.body);

    const actionsZone = root.querySelector('[data-testid="view-header-actions"]');
    const action = root.querySelector('[data-testid="act-1"]');
    expect(action).not.toBeNull();
    // The action lives within the actions zone, nowhere else.
    expect(actionsZone?.contains(action)).toBe(true);
    expect(root.querySelectorAll('[data-testid="act-1"]').length).toBe(1);
    // Provided as a native button → keyboard operable by construction.
    expect(action?.tagName.toLowerCase()).toBe("button");
  });
});

describe("StatusBadge shared token (@ui-view-header ac-2)", () => {
  // AC: @ui-view-header ac-2
  it("renders the same color and glyph for a state across independent renders", async () => {
    const first = render(StatusBadge, { props: { domain: "task", state: "completed" } });
    const second = render(StatusBadge, { props: { domain: "task", state: "completed" } });

    const a = await parse(first.body);
    const b = await parse(second.body);
    const badgeA = a.querySelector('[data-slot="status-badge"]');
    const badgeB = b.querySelector('[data-slot="status-badge"]');

    expect(badgeA?.getAttribute("class")).toBe(badgeB?.getAttribute("class"));
    expect(badgeA?.getAttribute("class")).toContain("bg-status-completed");
    expect(badgeA?.textContent).toBe(badgeB?.textContent);
    expect(badgeA?.textContent).toContain("Completed");
    // Glyph is present (the "●" filled circle for completed).
    expect(badgeA?.textContent).toContain("●");
  });

  // AC: @coverage-state-presentation ac-2
  it("renders coverage buckets with their distinct tokens", async () => {
    const covered = await parse(
      render(StatusBadge, { props: { domain: "coverage", state: "covered" } }).body,
    );
    const failing = await parse(
      render(StatusBadge, { props: { domain: "coverage", state: "failing" } }).body,
    );
    expect(covered.querySelector('[data-slot="status-badge"]')?.getAttribute("class")).toContain(
      "bg-severity-success",
    );
    expect(failing.querySelector('[data-slot="status-badge"]')?.getAttribute("class")).toContain(
      "bg-severity-error",
    );
  });
});
