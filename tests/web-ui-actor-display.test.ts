/**
 * ActorDisplay component tests.
 *
 * Behavioral tests that server-render the real ActorDisplay component (via the
 * web-ui Vite pipeline + svelte/server) and assert on the rendered DOM. No
 * source scanning — each test renders the component with props (a recorded
 * actor string and an optional classifier built from an identity config) and
 * inspects what it produces.
 *
 * Spec: @actor-display ac-1 (canonical name + human/agent distinction, stable
 *       across surfaces), ac-2 (unknown treatment, never canonical).
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
let ActorDisplay: any;

const CONFIG: ActorIdentityConfig = {
  human: { canonicalId: "Jacob Chapel", displayName: "Jacob Chapel" },
  agents: [
    { canonicalId: "codex", displayName: "Codex", aliases: ["@dispatch"] },
    { canonicalId: "claude", displayName: "Claude" },
  ],
};

const classifier = buildActorClassifier(CONFIG);

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

function renderActor(props: Record<string, unknown>) {
  return parse(render(ActorDisplay, { props }).body);
}

describe("ActorDisplay canonical name + kind distinction (@actor-display ac-1)", () => {
  // AC: @actor-display ac-1 — an agent actor renders its canonical display name
  // with the agent kind distinction.
  it("renders an agent's canonical display name with the agent kind", async () => {
    const root = await renderActor({ actor: "@dispatch", classifier, testid: "a" });
    const el = root.querySelector('[data-testid="a"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-actor-kind")).toBe("agent");
    // Canonical name, not the raw recorded variant.
    expect(el?.querySelector("[data-actor-name]")?.textContent).toBe("Codex");
    // An accessible kind label distinguishes the kind for assistive tech.
    expect(el?.querySelector("[data-actor-kind-label]")?.textContent).toContain("Agent");
  });

  // AC: @actor-display ac-1 — a human actor renders its canonical display name
  // with the human kind distinction, visibly distinct from the agent kind.
  it("renders a human's canonical display name with a distinct human kind", async () => {
    const root = await renderActor({ actor: "Jacob Chapel", classifier, testid: "h" });
    const el = root.querySelector('[data-testid="h"]');
    expect(el?.getAttribute("data-actor-kind")).toBe("human");
    expect(el?.querySelector("[data-actor-name]")?.textContent).toBe("Jacob Chapel");
    expect(el?.querySelector("[data-actor-kind-label]")?.textContent).toContain("Human");

    // The human and agent kinds are visually distinguished: different glyphs.
    const agentRoot = await renderActor({ actor: "codex", classifier, testid: "g" });
    const humanGlyph = el?.querySelector("[data-actor-glyph]")?.textContent;
    const agentGlyph = agentRoot
      .querySelector('[data-testid="g"]')
      ?.querySelector("[data-actor-glyph]")?.textContent;
    expect(humanGlyph).toBeTruthy();
    expect(agentGlyph).toBeTruthy();
    expect(humanGlyph).not.toBe(agentGlyph);
  });

  // AC: @actor-display ac-1 — the same actor renders identically across surfaces.
  it("renders the same actor identically across independent renders", async () => {
    // Two different recorded spellings of the same canonical agent identity.
    const first = await renderActor({ actor: "codex", classifier, testid: "x" });
    const second = await renderActor({ actor: "@dispatch", classifier, testid: "x" });
    const a = first.querySelector('[data-testid="x"]');
    const b = second.querySelector('[data-testid="x"]');

    // Same canonical name, same kind, same glyph → identical presentation.
    expect(b?.getAttribute("data-actor-kind")).toBe(a?.getAttribute("data-actor-kind"));
    expect(b?.querySelector("[data-actor-name]")?.textContent).toBe(
      a?.querySelector("[data-actor-name]")?.textContent,
    );
    expect(b?.querySelector("[data-actor-glyph]")?.textContent).toBe(
      a?.querySelector("[data-actor-glyph]")?.textContent,
    );
    expect(b?.getAttribute("class")).toBe(a?.getAttribute("class"));
  });
});

describe("ActorDisplay unknown treatment (@actor-display ac-2)", () => {
  // AC: @actor-display ac-2 — an unrecognized actor displays the original
  // recorded string with a distinct unknown treatment, never as canonical.
  it("renders an unknown actor's original string with the unknown kind", async () => {
    const root = await renderActor({ actor: "Hermes", classifier, testid: "u" });
    const el = root.querySelector('[data-testid="u"]');
    expect(el?.getAttribute("data-actor-kind")).toBe("unknown");
    // The original recorded string is shown verbatim.
    expect(el?.querySelector("[data-actor-name]")?.textContent).toBe("Hermes");
    expect(el?.querySelector("[data-actor-kind-label]")?.textContent).toContain("Unknown");
    // It is honestly marked as unrecognized, not presented as a canonical id.
    expect(el?.getAttribute("title")).toContain("Unrecognized actor");
  });

  // AC: @actor-display ac-2 — with no classifier (static export / identity
  // unavailable) the actor degrades to the unknown treatment rather than being
  // misattributed.
  it("degrades to the unknown treatment when no classifier is supplied", async () => {
    const root = await renderActor({ actor: "Jacob Chapel", testid: "d" });
    const el = root.querySelector('[data-testid="d"]');
    expect(el?.getAttribute("data-actor-kind")).toBe("unknown");
    // Original string preserved, shown as-is.
    expect(el?.querySelector("[data-actor-name]")?.textContent).toBe("Jacob Chapel");
    expect(el?.getAttribute("title")).toContain("Unrecognized actor");
  });

  // AC: @actor-display ac-2 — the unknown treatment is visually distinct from a
  // canonical-identity treatment (a different kind glyph + muted name styling).
  it("uses a distinct visual treatment for unknown vs known actors", async () => {
    const unknown = await renderActor({ actor: "Hermes", classifier, testid: "k" });
    const known = await renderActor({ actor: "codex", classifier, testid: "k" });
    const unknownEl = unknown.querySelector('[data-testid="k"]');
    const knownEl = known.querySelector('[data-testid="k"]');

    expect(unknownEl?.querySelector("[data-actor-glyph]")?.textContent).not.toBe(
      knownEl?.querySelector("[data-actor-glyph]")?.textContent,
    );
    // The unknown name carries a muted treatment the known name does not.
    const unknownNameClass =
      unknownEl?.querySelector("[data-actor-name]")?.getAttribute("class") ?? "";
    const knownNameClass = knownEl?.querySelector("[data-actor-name]")?.getAttribute("class") ?? "";
    expect(unknownNameClass).not.toBe(knownNameClass);
    expect(unknownNameClass).toContain("text-muted-foreground");
  });
});
