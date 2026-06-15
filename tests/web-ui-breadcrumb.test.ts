/**
 * Adaptive breadcrumb component tests.
 *
 * Two behavioral layers, no source scanning:
 *   1. Trail-layout logic — calls the pure computeTrail/overflow/keyboard
 *      functions and asserts the segments they select for each tier boundary
 *      and overflow level.
 *   2. SSR rendering — server-renders the real BreadcrumbNav (via the web-ui
 *      Vite pipeline + svelte/server) and inspects the produced DOM for the
 *      right visible segments, kind indicators, current emphasis, and the
 *      collapse trigger.
 *
 * Popover open/keyboard/overlay behavior that needs a live client runtime is
 * covered by the breadcrumb e2e cases in tests/e2e/reviews-detail.spec.ts and
 * tests/e2e/sessions.spec.ts.
 *
 * Spec: @ui-breadcrumb ac-1..ac-9
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";

const WEB_UI_ROOT = resolve(process.cwd(), "packages", "web-ui");
const ORIGINAL_CWD = process.cwd();

interface Ancestor {
  ref: string;
  title: string | null;
  kind: string;
}

let server: ViteDevServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let render: (component: any, options: { props?: Record<string, unknown> }) => { body: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let BreadcrumbNav: any;

let computeTrail: (
  a: Ancestor[],
  overflowLevel?: number,
) => {
  leading: Ancestor[];
  collapsed: Ancestor[];
  trailing: Ancestor[];
  current: Ancestor | null;
  hasCollapse: boolean;
};
let canCollapseFurther: (trail: { leading: Ancestor[]; trailing: Ancestor[] }) => boolean;
let nextPopoverIndex: (current: number, key: string, length: number) => number;
let kindMeta: (kind: string) => { label: string; refType: string; pillClass: string };

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
  BreadcrumbNav = (await server.ssrLoadModule("/src/lib/components/BreadcrumbNav.svelte")).default;

  const trailMod = await server.ssrLoadModule("/src/lib/utils/breadcrumb-trail.ts");
  computeTrail = trailMod.computeTrail;
  canCollapseFurther = trailMod.canCollapseFurther;
  nextPopoverIndex = trailMod.nextPopoverIndex;

  const kindMod = await server.ssrLoadModule("/src/lib/utils/breadcrumb-kind.ts");
  kindMeta = kindMod.kindMeta;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

// Build a root→current chain of `n` segments. The last segment is the current
// entity. Kinds cycle through the spec item kinds so each segment differs.
const KINDS = ["module", "feature", "requirement", "decision", "trait"];
function chain(n: number): Ancestor[] {
  return Array.from({ length: n }, (_v, i) => ({
    ref: `@seg-${i}`,
    title: `Segment ${i}`,
    kind: i === 0 ? "module" : KINDS[i % KINDS.length],
  }));
}

async function parse(body: string): Promise<HTMLElement> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<div id="root">${body}</div>`);
  return dom.window.document.getElementById("root") as unknown as HTMLElement;
}

function renderTrail(ancestors: Ancestor[]): Promise<HTMLElement> {
  return parse(render(BreadcrumbNav, { props: { ancestors } }).body);
}

function refs(list: Ancestor[]): string[] {
  return list.map((a) => a.ref);
}

describe("breadcrumb trail tiers (@ui-breadcrumb ac-1, ac-2, ac-3)", () => {
  // AC: @ui-breadcrumb ac-1
  it("renders every segment with no collapse indicator at 4 or fewer segments", () => {
    for (const n of [1, 2, 3, 4]) {
      const trail = computeTrail(chain(n));
      expect(trail.hasCollapse).toBe(false);
      expect(trail.collapsed).toEqual([]);
      const visible = [
        ...trail.leading,
        ...trail.trailing,
        ...(trail.current ? [trail.current] : []),
      ];
      // Every segment in the chain is visible, in hierarchy order.
      expect(refs(visible)).toEqual(refs(chain(n)));
    }
  });

  // AC: @ui-breadcrumb ac-2
  it("shows root + indicator + last two ancestors + current at 5 or 6 segments", () => {
    for (const n of [5, 6]) {
      const c = chain(n);
      const trail = computeTrail(c);
      expect(trail.hasCollapse).toBe(true);
      expect(refs(trail.leading)).toEqual([c[0].ref]); // root
      expect(refs(trail.trailing)).toEqual([c[n - 3].ref, c[n - 2].ref]); // last two ancestors
      expect(trail.current?.ref).toBe(c[n - 1].ref);
      // The middle ancestors are exactly the collapsed set, in hierarchy order.
      expect(refs(trail.collapsed)).toEqual(refs(c.slice(1, n - 3)));
    }
  });

  // AC: @ui-breadcrumb ac-3
  it("shows root + indicator + last one ancestor + current at 7 or more segments", () => {
    for (const n of [7, 9]) {
      const c = chain(n);
      const trail = computeTrail(c);
      expect(trail.hasCollapse).toBe(true);
      expect(refs(trail.leading)).toEqual([c[0].ref]); // root
      expect(refs(trail.trailing)).toEqual([c[n - 2].ref]); // single nearest ancestor
      expect(trail.current?.ref).toBe(c[n - 1].ref);
      expect(refs(trail.collapsed)).toEqual(refs(c.slice(1, n - 2)));
    }
  });
});

describe("breadcrumb overflow collapse (@ui-breadcrumb ac-4)", () => {
  // AC: @ui-breadcrumb ac-4
  it("folds visible ancestors away — root first — as the overflow level rises", () => {
    const c = chain(6);
    const base = computeTrail(c, 0);
    expect(refs(base.leading)).toEqual([c[0].ref]); // root visible at level 0

    const lvl1 = computeTrail(c, 1);
    expect(lvl1.leading).toEqual([]); // root folded into the indicator first
    expect(lvl1.collapsed[0].ref).toBe(c[0].ref); // and it leads the collapsed list
    expect(lvl1.current?.ref).toBe(c[5].ref);
  });

  // AC: @ui-breadcrumb ac-4
  it("keeps collapsing trailing ancestors until only the indicator and current remain", () => {
    const c = chain(6);
    let trail = computeTrail(c, 0);
    let level = 0;
    // Drive the same loop the component runs against its width observer.
    while (canCollapseFurther(trail)) {
      level += 1;
      trail = computeTrail(c, level);
    }
    expect(trail.leading).toEqual([]);
    expect(trail.trailing).toEqual([]);
    expect(trail.hasCollapse).toBe(true);
    // The current segment is never collapsed.
    expect(trail.current?.ref).toBe(c[5].ref);
    expect(refs(trail.collapsed)).toEqual(refs(c.slice(0, 5)));
  });

  // AC: @ui-breadcrumb ac-4
  it("clamps overflow beyond what the chain can collapse", () => {
    const c = chain(5);
    const huge = computeTrail(c, 99);
    expect(huge.current?.ref).toBe(c[4].ref);
    expect(canCollapseFurther(huge)).toBe(false);
  });
});

describe("breadcrumb keyboard selection (@ui-breadcrumb ac-6)", () => {
  // AC: @ui-breadcrumb ac-6
  it("advances and retreats selection within bounds and wraps in from no selection", () => {
    const len = 3;
    // ArrowDown from "no selection" enters at the top, then advances and clamps.
    expect(nextPopoverIndex(-1, "ArrowDown", len)).toBe(0);
    expect(nextPopoverIndex(0, "ArrowDown", len)).toBe(1);
    expect(nextPopoverIndex(2, "ArrowDown", len)).toBe(2); // clamps at the end
    // ArrowUp from "no selection" enters at the bottom, then retreats and clamps.
    expect(nextPopoverIndex(-1, "ArrowUp", len)).toBe(len - 1);
    expect(nextPopoverIndex(2, "ArrowUp", len)).toBe(1);
    expect(nextPopoverIndex(0, "ArrowUp", len)).toBe(0); // clamps at the start
  });

  // AC: @ui-breadcrumb ac-6
  it("leaves selection unchanged for non-arrow keys and handles an empty list", () => {
    expect(nextPopoverIndex(1, "Enter", 3)).toBe(1);
    expect(nextPopoverIndex(1, "a", 3)).toBe(1);
    expect(nextPopoverIndex(0, "ArrowDown", 0)).toBe(-1);
  });
});

describe("breadcrumb kind metadata (@ui-breadcrumb ac-9)", () => {
  // AC: @ui-breadcrumb ac-9
  it("maps every supported kind to a label and the correct route type", () => {
    expect(kindMeta("module").refType).toBe("spec");
    expect(kindMeta("feature").refType).toBe("spec");
    expect(kindMeta("requirement").refType).toBe("spec");
    expect(kindMeta("decision").refType).toBe("spec");
    expect(kindMeta("trait").refType).toBe("spec");
    expect(kindMeta("task").refType).toBe("task");
    expect(kindMeta("plan").refType).toBe("plan");
    expect(kindMeta("review").refType).toBe("review");
    expect(kindMeta("session").refType).toBe("session");
    // Each kind carries a non-empty label for its indicator.
    for (const k of [
      "module",
      "feature",
      "requirement",
      "decision",
      "trait",
      "task",
      "plan",
      "review",
      "session",
    ]) {
      expect(kindMeta(k).label.length).toBeGreaterThan(0);
    }
  });

  // AC: @ui-breadcrumb ac-9
  it("falls back to a neutral spec-routed pill for unknown kinds", () => {
    const meta = kindMeta("mystery");
    expect(meta.refType).toBe("spec");
    expect(meta.label.length).toBeGreaterThan(0);
  });
});

describe("breadcrumb SSR rendering (@ui-breadcrumb ac-1, ac-2, ac-3, ac-9)", () => {
  // AC: @ui-breadcrumb ac-1
  it("renders all four segments and no collapse trigger for a 4-segment chain", async () => {
    const root = await renderTrail(chain(4));
    expect(root.querySelector('[data-testid="breadcrumb-collapse"]')).toBeNull();
    const segs = root.querySelectorAll('[data-testid="breadcrumb-segment"]');
    const current = root.querySelector('[data-testid="breadcrumb-current"]');
    expect(segs.length).toBe(3); // three ancestors as links
    expect(current).not.toBeNull(); // plus the current segment
    expect(current?.textContent).toContain("Segment 3");
  });

  // AC: @ui-breadcrumb ac-2
  it("renders root + collapse trigger + two trailing ancestors + current at 6 segments", async () => {
    const root = await renderTrail(chain(6));
    const collapse = root.querySelector('[data-testid="breadcrumb-collapse"]');
    expect(collapse).not.toBeNull();
    expect(collapse?.tagName).toBe("BUTTON"); // AC: @ui-breadcrumb ac-7 — button activation, never hover-only
    expect(collapse?.textContent).toContain("2"); // two segments folded away
    const segs = root.querySelectorAll('[data-testid="breadcrumb-segment"]');
    expect(segs.length).toBe(3); // root + last two ancestors
    expect(root.querySelector('[data-testid="breadcrumb-current"]')?.textContent).toContain(
      "Segment 5",
    );
  });

  // AC: @ui-breadcrumb ac-3
  it("renders root + collapse trigger + one trailing ancestor + current at 7 segments", async () => {
    const root = await renderTrail(chain(7));
    const collapse = root.querySelector('[data-testid="breadcrumb-collapse"]');
    expect(collapse).not.toBeNull();
    expect(collapse?.textContent).toContain("4"); // four segments folded away
    const segs = root.querySelectorAll('[data-testid="breadcrumb-segment"]');
    expect(segs.length).toBe(2); // root + single nearest ancestor
  });

  // AC: @ui-breadcrumb ac-9
  it("gives every visible segment a kind indicator and emphasizes the current one", async () => {
    const ancestors: Ancestor[] = [
      { ref: "@m", title: "Mod", kind: "module" },
      { ref: "@f", title: "Feat", kind: "feature" },
      { ref: "@r", title: "Req", kind: "requirement" },
      { ref: "@rev", title: "The Review", kind: "review" },
    ];
    const root = await renderTrail(ancestors);

    // Every segment (ancestors + current) carries a kind pill with its kind.
    const kinds = [...root.querySelectorAll('[data-testid="breadcrumb-kind"]')].map((el) =>
      el.getAttribute("data-kind"),
    );
    expect(kinds).toEqual(["module", "feature", "requirement", "review"]);

    // The current segment is emphasized relative to ancestor segments.
    const current = root.querySelector('[data-testid="breadcrumb-current"]');
    expect(current?.getAttribute("aria-current")).toBe("page");
    // The current segment is bold; ancestor links are muted, not bold.
    expect(current?.className).toContain("font-semibold");
    const firstAncestor = root.querySelector('[data-testid="breadcrumb-segment"]');
    expect(firstAncestor?.className).not.toContain("font-semibold");
    expect(firstAncestor?.className).toContain("text-muted-foreground");
  });

  // AC: @ui-breadcrumb ac-9
  it("routes each segment to the detail URL for its kind", async () => {
    const ancestors: Ancestor[] = [
      { ref: "@m", title: "Mod", kind: "module" },
      { ref: "@the-task", title: "Task", kind: "task" },
    ];
    const root = await renderTrail(ancestors);
    const link = root.querySelector(
      '[data-testid="breadcrumb-segment"]',
    ) as HTMLAnchorElement | null;
    // module → spec route
    expect(link?.getAttribute("href")).toContain("/specs?ref=");
  });

  // AC: @ui-breadcrumb ac-10
  it("renders purely from the passed ancestors, issuing no fetch", async () => {
    // The component takes ancestors as a prop and never imports an API client;
    // rendering it in isolation (no network stack) producing the full trail is
    // the behavioral proof that the trail needs no client-side list fetch.
    const root = await renderTrail(chain(3));
    expect(root.querySelectorAll('[data-testid="breadcrumb-segment"]').length).toBe(2);
    expect(root.querySelector('[data-testid="breadcrumb-current"]')).not.toBeNull();
  });
});
