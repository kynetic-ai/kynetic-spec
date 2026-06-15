/**
 * Inline review-thread actor adoption tests.
 *
 * Behavioral tests that server-render the real inline review-thread components
 * (DiffInlineThread for anchored code threads, ContentInlineThread for anchored
 * structured-content threads) via the web-ui Vite pipeline + svelte/server and
 * assert that thread authors render through the shared ActorDisplay primitive —
 * i.e. with the same canonical name + kind distinction the rest of the review
 * surface uses for the same actor. No source scanning: each test renders the
 * component with a thread fixture and an identity-backed classifier and inspects
 * the produced DOM.
 *
 * These cover the review finding that inline diff/content threads still rendered
 * recorded authors as raw strings, which violated @actor-display ac-1's
 * same-actor consistency across surfaces.
 *
 * Spec: @actor-display ac-1 (canonical name + human/agent distinction, same
 *       actor identical across surfaces), ac-2 (unknown treatment / degradation).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";
import { buildActorClassifier, type ActorIdentityConfig } from "../packages/shared/src/actor.ts";

const WEB_UI_ROOT = resolve(process.cwd(), "packages", "web-ui");
const ORIGINAL_CWD = process.cwd();

let server: ViteDevServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let render: (component: any, options: { props?: Record<string, unknown> }) => { body: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DiffInlineThread: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ContentInlineThread: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ActorDisplay: any;

const CONFIG: ActorIdentityConfig = {
  human: { canonicalId: "Jacob Chapel", displayName: "Jacob Chapel" },
  agents: [
    { canonicalId: "codex", displayName: "Codex", aliases: ["@dispatch"] },
    { canonicalId: "claude", displayName: "Claude" },
  ],
};

const classifier = buildActorClassifier(CONFIG);

const noop = () => {};

function makeThread(authors: string[]) {
  return {
    _ulid: "01THREADXXXXXXXXXXXXXXXXXX",
    kind: "nit",
    resolved_at: null,
    anchor: { type: "code", path: "src/x.ts", side: "head", line_start: 1, line_end: 1 },
    entries: authors.map((author, i) => ({
      _ulid: `01ENTRY${i}XXXXXXXXXXXXXXXXXX`.slice(0, 26),
      author,
      body: "a comment",
      created_at: "2026-06-15T00:00:00.000Z",
    })),
  };
}

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
  DiffInlineThread = (
    await server.ssrLoadModule("/src/lib/components/diff/DiffInlineThread.svelte")
  ).default;
  ContentInlineThread = (
    await server.ssrLoadModule("/src/lib/components/content/ContentInlineThread.svelte")
  ).default;
  ActorDisplay = (await server.ssrLoadModule("/src/lib/components/ds/ActorDisplay.svelte")).default;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

async function parse(body: string): Promise<HTMLElement> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<div id="root">${body}</div>`);
  return dom.window.document.getElementById("root") as unknown as HTMLElement;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderInline(component: any, props: Record<string, unknown>) {
  return parse(
    render(component, {
      props: { isInteractive: false, onReply: noop, onResolve: noop, onReopen: noop, ...props },
    }).body,
  );
}

describe("inline diff thread authors render through ActorDisplay (@actor-display ac-1)", () => {
  // AC: @actor-display ac-1 — a thread entry author in the code diff inline thread
  // renders its canonical display name + kind, not the raw recorded string.
  it("renders the diff thread entry author through the actor primitive", async () => {
    const root = await renderInline(DiffInlineThread, {
      thread: makeThread(["@dispatch"]),
      classifier,
    });
    const author = root.querySelector('[data-testid="diff-thread-entry-author"]');
    expect(author).not.toBeNull();
    expect(author?.getAttribute("data-actor-kind")).toBe("agent");
    expect(author?.querySelector("[data-actor-name]")?.textContent).toBe("Codex");
  });

  // AC: @actor-display ac-1 — same actor renders identically here as via the
  // standalone primitive used elsewhere on the surface.
  it("renders the same actor identically to a standalone ActorDisplay", async () => {
    const inline = await renderInline(DiffInlineThread, {
      thread: makeThread(["@dispatch"]),
      classifier,
    });
    const standalone = await parse(
      render(ActorDisplay, { props: { actor: "@dispatch", classifier } }).body,
    );

    const inlineAuthor = inline.querySelector('[data-testid="diff-thread-entry-author"]');
    const standaloneEl = standalone.querySelector('[data-slot="actor-display"]');
    expect(inlineAuthor?.getAttribute("data-actor-kind")).toBe(
      standaloneEl?.getAttribute("data-actor-kind"),
    );
    expect(inlineAuthor?.querySelector("[data-actor-name]")?.textContent).toBe(
      standaloneEl?.querySelector("[data-actor-name]")?.textContent,
    );
    expect(inlineAuthor?.querySelector("[data-actor-glyph]")?.textContent).toBe(
      standaloneEl?.querySelector("[data-actor-glyph]")?.textContent,
    );
  });

  // AC: @actor-display ac-2 — with no classifier (static mode) the diff thread
  // author degrades to the unknown treatment, never a misattributed canonical id.
  it("degrades the diff thread author to unknown when no classifier is supplied", async () => {
    const root = await renderInline(DiffInlineThread, { thread: makeThread(["Jacob Chapel"]) });
    const author = root.querySelector('[data-testid="diff-thread-entry-author"]');
    expect(author?.getAttribute("data-actor-kind")).toBe("unknown");
    expect(author?.querySelector("[data-actor-name]")?.textContent).toBe("Jacob Chapel");
  });
});

describe("inline content thread authors render through ActorDisplay (@actor-display ac-1)", () => {
  // AC: @actor-display ac-1 — a thread entry author in the structured-content
  // inline thread renders canonically, matching the rest of the review surface.
  it("renders the content thread entry author through the actor primitive", async () => {
    const root = await renderInline(ContentInlineThread, {
      thread: makeThread(["Jacob Chapel"]),
      classifier,
    });
    const author = root.querySelector('[data-testid="content-thread-entry-author"]');
    expect(author).not.toBeNull();
    expect(author?.getAttribute("data-actor-kind")).toBe("human");
    expect(author?.querySelector("[data-actor-name]")?.textContent).toBe("Jacob Chapel");
  });

  // AC: @actor-display ac-1 — the same author classified by the same payload
  // renders identically in the diff and content inline threads.
  it("renders the same author identically in diff and content inline threads", async () => {
    const diff = await renderInline(DiffInlineThread, {
      thread: makeThread(["claude"]),
      classifier,
    });
    const content = await renderInline(ContentInlineThread, {
      thread: makeThread(["claude"]),
      classifier,
    });
    const diffAuthor = diff.querySelector('[data-testid="diff-thread-entry-author"]');
    const contentAuthor = content.querySelector('[data-testid="content-thread-entry-author"]');

    expect(contentAuthor?.getAttribute("data-actor-kind")).toBe(
      diffAuthor?.getAttribute("data-actor-kind"),
    );
    expect(contentAuthor?.querySelector("[data-actor-name]")?.textContent).toBe(
      diffAuthor?.querySelector("[data-actor-name]")?.textContent,
    );
  });
});
