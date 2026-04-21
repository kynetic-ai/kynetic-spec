/**
 * Docs Rendering Pipeline Tests
 *
 * Tests the build-time docs bundling pipeline and docs-specific markdown rendering.
 * Exercises the Vite plugin, virtual module, docs-markdown renderer with anchored
 * headings, and navigation structure.
 *
 * Spec: @docs-reachability, @docs-navigation-shape
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ─── Vite Plugin Tests ────────────────────────────────────────────────────────

describe("vite-plugin-docs", () => {
  let docsPlugin: typeof import("../packages/web-ui/vite-plugin-docs")["docsPlugin"];

  beforeAll(async () => {
    const mod = await import("../packages/web-ui/vite-plugin-docs");
    docsPlugin = mod.docsPlugin;
  });

  it("resolves virtual:docs module ID", () => {
    const plugin = docsPlugin("/tmp/fake-docs");
    // Plugin has resolveId hook
    const resolveId = plugin.resolveId as (id: string) => string | undefined;
    expect(resolveId("virtual:docs")).toBe("\0virtual:docs");
    expect(resolveId("other-module")).toBeUndefined();
  });

  it("loads markdown files from a docs directory into a manifest", () => {
    // Create a temp docs directory with test content
    const tempDir = join(tmpdir(), `docs-plugin-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    writeFileSync(join(tempDir, "getting-started.md"), "# Getting Started\n\nWelcome to the docs.");
    writeFileSync(join(tempDir, "overview.md"), "# Overview\n\nThis is an overview.");
    mkdirSync(join(tempDir, "guides"), { recursive: true });
    writeFileSync(join(tempDir, "guides", "setup.md"), "# Setup Guide\n\nHow to set up.");

    try {
      const plugin = docsPlugin(tempDir);
      const load = plugin.load as (id: string) => string | undefined;

      // Should not load non-virtual modules
      expect(load("some-other-id")).toBeUndefined();

      // Should load the virtual module
      const result = load("\0virtual:docs");
      expect(result).toBeDefined();
      expect(result).toContain("export default");

      // Parse the manifest from the generated module
      const manifestJson = result!.slice("export default ".length, -1);
      const manifest = JSON.parse(manifestJson);

      expect(manifest.entries).toBeInstanceOf(Array);
      expect(manifest.entries.length).toBe(3);

      // Check entries are sorted by slug
      const slugs = manifest.entries.map((e: { slug: string }) => e.slug);
      expect(slugs).toEqual(["getting-started", "guides/setup", "overview"]);

      // Check title extraction from H1
      const gettingStarted = manifest.entries.find((e: { slug: string }) => e.slug === "getting-started");
      expect(gettingStarted.title).toBe("Getting Started");
      expect(gettingStarted.content).toContain("Welcome to the docs.");
      expect(gettingStarted.path).toBe("getting-started.md");

      // Check nested path
      const setup = manifest.entries.find((e: { slug: string }) => e.slug === "guides/setup");
      expect(setup.title).toBe("Setup Guide");
      expect(setup.path).toBe("guides/setup.md");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes section index.md slugs to bare section names", () => {
    const tempDir = join(tmpdir(), `docs-plugin-index-norm-${Date.now()}`);
    mkdirSync(join(tempDir, "getting-started"), { recursive: true });
    mkdirSync(join(tempDir, "guides"), { recursive: true });

    writeFileSync(join(tempDir, "getting-started", "index.md"), "# Getting Started\n\nWelcome.");
    writeFileSync(join(tempDir, "getting-started", "tutorial.md"), "# Tutorial\n\nLearn here.");
    writeFileSync(join(tempDir, "guides", "index.md"), "# Guides\n\nAll guides.");

    try {
      const plugin = docsPlugin(tempDir);
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      const manifest = JSON.parse(result.slice("export default ".length, -1));
      const slugs = manifest.entries.map((e: { slug: string }) => e.slug);

      // index.md files are normalized to the bare section slug
      expect(slugs).toContain("getting-started");
      expect(slugs).toContain("guides");
      expect(slugs).not.toContain("getting-started/index");
      expect(slugs).not.toContain("guides/index");

      // Non-index files retain their slug
      expect(slugs).toContain("getting-started/tutorial");

      // Path still reflects the original file
      const gsEntry = manifest.entries.find((e: { slug: string }) => e.slug === "getting-started");
      expect(gsEntry.path).toBe("getting-started/index.md");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("humanizes filename when no H1 heading exists", () => {
    const tempDir = join(tmpdir(), `docs-plugin-no-h1-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    writeFileSync(join(tempDir, "my-cool-page.md"), "Some content without a heading.");

    try {
      const plugin = docsPlugin(tempDir);
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      const manifest = JSON.parse(result.slice("export default ".length, -1));

      expect(manifest.entries[0].title).toBe("My Cool Page");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles empty docs directory gracefully", () => {
    const tempDir = join(tmpdir(), `docs-plugin-empty-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const plugin = docsPlugin(tempDir);
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      const manifest = JSON.parse(result.slice("export default ".length, -1));

      expect(manifest.entries).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles non-existent docs directory gracefully", () => {
    const plugin = docsPlugin("/tmp/non-existent-docs-dir-" + Date.now());
    const load = plugin.load as (id: string) => string | undefined;
    const result = load("\0virtual:docs")!;
    const manifest = JSON.parse(result.slice("export default ".length, -1));

    expect(manifest.entries).toEqual([]);
  });
});

// ─── Docs Markdown Renderer Tests ─────────────────────────────────────────────

describe("docs-markdown renderer", () => {
  let renderDocsMarkdown: typeof import("../packages/web-ui/src/lib/utils/docs-markdown")["renderDocsMarkdown"];
  let slugifyHeading: typeof import("../packages/web-ui/src/lib/utils/docs-markdown")["slugifyHeading"];

  beforeAll(async () => {
    const mod = await import("../packages/web-ui/src/lib/utils/docs-markdown");
    renderDocsMarkdown = mod.renderDocsMarkdown;
    slugifyHeading = mod.slugifyHeading;
  });

  // AC: @docs-navigation-shape ac-2 — Anchored headings with stable direct links
  describe("anchored headings", () => {
    it("adds id attributes and anchor links to headings", () => {
      const result = renderDocsMarkdown("# Hello World\n\nSome text.\n\n## Sub Section");

      expect(result.html).toContain('id="hello-world"');
      expect(result.html).toContain('href="#hello-world"');
      expect(result.html).toContain('id="sub-section"');
      expect(result.html).toContain('href="#sub-section"');
    });

    it("generates unique ids for duplicate headings", () => {
      const result = renderDocsMarkdown("# Intro\n\n## Intro\n\n### Intro");

      expect(result.html).toContain('id="intro"');
      expect(result.html).toContain('id="intro-1"');
      expect(result.html).toContain('id="intro-2"');
    });

    it("handles headings with special characters", () => {
      const result = renderDocsMarkdown("## What's New? (v2.0)");

      expect(result.html).toContain('id="whats-new-v2-0"');
    });

    it("handles headings with inline code", () => {
      const result = renderDocsMarkdown("## Using `kspec init`");

      // The slug should strip the code markup
      expect(result.html).toMatch(/id="using-kspec-init"/);
    });
  });

  describe("table of contents extraction", () => {
    it("extracts heading structure into toc entries", () => {
      const md = "# Title\n\n## Section A\n\n### Sub A1\n\n## Section B";
      const result = renderDocsMarkdown(md);

      expect(result.toc).toHaveLength(4);
      expect(result.toc[0]).toEqual({ id: "title", text: "Title", level: 1 });
      expect(result.toc[1]).toEqual({ id: "section-a", text: "Section A", level: 2 });
      expect(result.toc[2]).toEqual({ id: "sub-a1", text: "Sub A1", level: 3 });
      expect(result.toc[3]).toEqual({ id: "section-b", text: "Section B", level: 2 });
    });

    it("returns empty toc for content without headings", () => {
      const result = renderDocsMarkdown("Just some text.\n\nMore text.");
      expect(result.toc).toEqual([]);
    });
  });

  // AC: @docs-reachability ac-2 — Content renders without network requests
  // AC: @docs-reachability ac-3 — Pages render without daemon/SSR
  describe("markdown rendering", () => {
    it("renders code fences with syntax highlighting", () => {
      const md = "```typescript\nconst x = 1;\n```";
      const result = renderDocsMarkdown(md);

      expect(result.html).toContain("<pre><code");
      expect(result.html).toContain("hljs");
      expect(result.html).toContain("language-typescript");
    });

    it("renders inline code with proper classes", () => {
      const md = "Use `kspec init` to start.";
      const result = renderDocsMarkdown(md);

      expect(result.html).toContain("<code");
      expect(result.html).toContain("kspec init");
    });

    it("renders GFM tables", () => {
      const md = "| Col A | Col B |\n| --- | --- |\n| 1 | 2 |";
      const result = renderDocsMarkdown(md);

      expect(result.html).toContain("<table>");
      expect(result.html).toContain("<th>");
    });

    it("renders links with external security attributes", () => {
      const md = "[External](https://example.com) and [Internal](#section)";
      const result = renderDocsMarkdown(md);

      expect(result.html).toContain('target="_blank"');
      expect(result.html).toContain('rel="noopener noreferrer"');
      // Internal link should not have target="_blank"
      expect(result.html).toContain('href="#section"');
    });

    it("returns empty html and toc for empty input", () => {
      const result = renderDocsMarkdown("");
      expect(result.html).toBe("");
      expect(result.toc).toEqual([]);
    });

    it("sanitizes HTML to prevent XSS", () => {
      const md = '# Title\n\n<script>alert("xss")</script>\n\nSafe text.';
      const result = renderDocsMarkdown(md);

      expect(result.html).not.toContain("<script>");
      expect(result.html).toContain("Safe text.");
    });
  });

  describe("link rewriting with linkContext", () => {
    const repoUrl = "https://github.com/lepahc/kynetic-spec/blob/main";
    const linkContext = {
      currentDocPath: "getting-started.md",
      knownSlugs: new Set(["getting-started", "overview", "history/KYNETIC_SPEC_DESIGN"]),
      basePath: "",
      repoUrl,
    };

    it("rewrites in-tree .md links to SPA routes", () => {
      const md = "[Overview](./overview.md)";
      const result = renderDocsMarkdown(md, linkContext);

      expect(result.html).toContain('href="/docs/overview"');
      expect(result.html).not.toContain("overview.md");
    });

    it("rewrites out-of-tree .md links to GitHub blob URLs", () => {
      const md = "[Install](../INSTALL.md)";
      const result = renderDocsMarkdown(md, linkContext);

      // Out-of-tree links should be rewritten to the GitHub blob URL
      expect(result.html).toContain(`href="${repoUrl}/INSTALL.md"`);
      expect(result.html).not.toContain('href="../INSTALL.md"');
    });

    it("rewrites out-of-tree .md links from nested docs to GitHub blob URLs", () => {
      const nestedContext = {
        currentDocPath: "guides/setup.md",
        knownSlugs: new Set(["guides/setup"]),
        basePath: "",
        repoUrl,
      };
      // ../../README.md from docs/guides/setup.md -> README.md at repo root
      const md = "[README](../../README.md)";
      const result = renderDocsMarkdown(md, nestedContext);

      expect(result.html).toContain(`href="${repoUrl}/README.md"`);
    });

    it("leaves out-of-tree .md links unchanged when repoUrl not provided", () => {
      const contextNoRepo = {
        currentDocPath: "getting-started.md",
        knownSlugs: new Set(["getting-started", "overview"]),
        basePath: "",
      };
      const md = "[Install](../INSTALL.md)";
      const result = renderDocsMarkdown(md, contextNoRepo);

      // Without repoUrl, out-of-tree links are left as-is (graceful fallback)
      expect(result.html).toContain('href="../INSTALL.md"');
    });

    it("rewrites unbundled in-tree .md links to GitHub blob URLs", () => {
      const md = "[Missing](./nonexistent.md)";
      const result = renderDocsMarkdown(md, linkContext);

      // The slug resolves in-tree but doesn't exist in knownSlugs — rewrite to GitHub
      expect(result.html).toContain(`href="${repoUrl}/docs/nonexistent.md"`);
    });

    it("rewrites nested doc links correctly", () => {
      const nestedContext = {
        currentDocPath: "history/KYNETIC_SPEC_DESIGN.md",
        knownSlugs: new Set(["getting-started", "overview", "history/KYNETIC_SPEC_DESIGN"]),
        basePath: "",
        repoUrl,
      };
      const md = "[Getting Started](../getting-started.md)";
      const result = renderDocsMarkdown(md, nestedContext);

      expect(result.html).toContain('href="/docs/getting-started"');
    });

    it("applies basePath prefix to rewritten links", () => {
      const contextWithBase = { ...linkContext, basePath: "/kynetic-spec" };
      const md = "[Overview](./overview.md)";
      const result = renderDocsMarkdown(md, contextWithBase);

      expect(result.html).toContain('href="/kynetic-spec/docs/overview"');
    });

    it("does not rewrite external links", () => {
      const md = "[Ext](https://example.com/file.md)";
      const result = renderDocsMarkdown(md, linkContext);

      expect(result.html).toContain('href="https://example.com/file.md"');
    });

    it("marks out-of-tree rewritten links as external", () => {
      const md = "[Install](../INSTALL.md)";
      const result = renderDocsMarkdown(md, linkContext);

      // GitHub URLs are external — should have target="_blank" and rel="noopener noreferrer"
      expect(result.html).toContain('target="_blank"');
      expect(result.html).toContain('rel="noopener noreferrer"');
    });

    it("works without linkContext (backward compatible)", () => {
      const md = "[Link](./overview.md)";
      const result = renderDocsMarkdown(md);

      // Without context, .md links are left as-is
      expect(result.html).toContain('href="./overview.md"');
    });
  });

  describe("slugifyHeading", () => {
    it("lowercases text", () => {
      expect(slugifyHeading("Hello World")).toBe("hello-world");
    });

    it("replaces spaces with hyphens", () => {
      expect(slugifyHeading("foo bar baz")).toBe("foo-bar-baz");
    });

    it("strips special characters", () => {
      expect(slugifyHeading("What's New? (v2)")).toBe("whats-new-v2");
    });

    // AC: @docs-release-notes-availability ac-1 — version anchors of the form v<major>-<minor>-<patch>
    it("converts dots to hyphens for version-style headings", () => {
      expect(slugifyHeading("v0.13.0")).toBe("v0-13-0");
      expect(slugifyHeading("v0.1.0")).toBe("v0-1-0");
      expect(slugifyHeading("v1.2.3")).toBe("v1-2-3");
    });

    it("collapses multiple hyphens", () => {
      expect(slugifyHeading("one - two --- three")).toBe("one-two-three");
    });

    it("strips HTML tags", () => {
      expect(slugifyHeading('Hello <code>world</code>')).toBe("hello-world");
    });

    it("strips HTML entities", () => {
      expect(slugifyHeading("A &amp; B")).toBe("a-b");
    });

    it("trims leading/trailing hyphens", () => {
      expect(slugifyHeading("  Hello  ")).toBe("hello");
    });
  });
});

// ─── Docs Module Tests ───────────────────────────────────────────────────────

describe("docs module interface", () => {
  let docsPlugin: typeof import("../packages/web-ui/vite-plugin-docs")["docsPlugin"];

  beforeAll(async () => {
    const mod = await import("../packages/web-ui/vite-plugin-docs");
    docsPlugin = mod.docsPlugin;
  });

  // AC: @docs-reachability ac-2 — Content bundled at build time, no network requests
  it("produces a valid manifest that can be consumed by getDocsEntry-style lookups", () => {
    const tempDir = join(tmpdir(), `docs-module-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "getting-started.md"), "# Getting Started\n\nWelcome.");
    mkdirSync(join(tempDir, "history"), { recursive: true });
    writeFileSync(join(tempDir, "history", "design.md"), "# Design\n\nDesign doc.");

    try {
      const plugin = docsPlugin(tempDir);
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      const manifest = JSON.parse(result.slice("export default ".length, -1));

      // Simulate getDocsEntry lookup
      const entry = manifest.entries.find((e: { slug: string }) => e.slug === "getting-started");
      expect(entry).toBeDefined();
      expect(entry.title).toBe("Getting Started");
      expect(entry.content).toContain("Welcome.");

      // Simulate getDocsEntry for nested
      const nested = manifest.entries.find((e: { slug: string }) => e.slug === "history/design");
      expect(nested).toBeDefined();
      expect(nested.title).toBe("Design");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // AC: @docs-reachability ac-3 — Pages render without daemon or SSR
  it("bundles full markdown content so pages can render client-side", () => {
    const tempDir = join(tmpdir(), `docs-content-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "page.md"),
      "# Test Page\n\n## Section One\n\nContent here.\n\n```typescript\nconst x = 1;\n```",
    );

    try {
      const plugin = docsPlugin(tempDir);
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      // Strip "export default " prefix and trailing ";"
      const jsonStr = result.slice("export default ".length, -1);
      const manifest = JSON.parse(jsonStr);

      const entry = manifest.entries[0];
      // Full content is present in the bundle — no need for runtime fetching
      expect(entry.content).toContain("## Section One");
      expect(entry.content).toContain("const x = 1;");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Section Filtering Tests ─────────────────────────────────────────────────

describe("docs section filtering", () => {
  let filterSectionEntries: typeof import("../packages/web-ui/src/lib/utils/docs-utils")["filterSectionEntries"];

  beforeAll(async () => {
    const mod = await import("../packages/web-ui/src/lib/utils/docs-utils");
    filterSectionEntries = mod.filterSectionEntries;
  });

  const entries = [
    { slug: "getting-started", title: "Getting Started", content: "", path: "getting-started.md" },
    { slug: "overview", title: "Overview", content: "", path: "overview.md" },
    { slug: "guides/deploy", title: "Deploy", content: "", path: "guides/deploy.md" },
    { slug: "guides/setup", title: "Setup", content: "", path: "guides/setup.md" },
    { slug: "history/design", title: "Design", content: "", path: "history/design.md" },
  ];

  // Supports @docs-navigation-shape ac-1 — section filtering logic (E2E tests cover the rendered UI)
  it("filters entries to same section for nested slugs", () => {
    const result = filterSectionEntries(entries, "guides/setup");

    expect(result.map((e) => e.slug)).toEqual(["guides/deploy", "guides/setup"]);
    // Should NOT include entries from other sections
    expect(result.some((e) => e.slug === "overview")).toBe(false);
    expect(result.some((e) => e.slug.startsWith("history/"))).toBe(false);
  });

  it("filters entries to root-level for root slugs", () => {
    const result = filterSectionEntries(entries, "overview");

    expect(result.map((e) => e.slug)).toEqual(["getting-started", "overview"]);
    // Should NOT include nested entries
    expect(result.some((e) => e.slug.includes("/"))).toBe(false);
  });

  it("includes normalized section landing page when present", () => {
    const withIndex = [
      ...entries,
      { slug: "guides", title: "Guides Index", content: "", path: "guides/index.md" },
    ];
    const result = filterSectionEntries(withIndex, "guides/setup");

    expect(result.some((e) => e.slug === "guides")).toBe(true);
    expect(result.some((e) => e.slug === "guides/setup")).toBe(true);
  });

  it("returns section entries when slug is a normalized landing page", () => {
    const withIndex = [
      ...entries,
      { slug: "guides", title: "Guides Index", content: "", path: "guides/index.md" },
    ];
    const result = filterSectionEntries(withIndex, "guides");

    expect(result.some((e) => e.slug === "guides")).toBe(true);
    expect(result.some((e) => e.slug === "guides/deploy")).toBe(true);
    expect(result.some((e) => e.slug === "guides/setup")).toBe(true);
    // Should NOT include entries from other sections
    expect(result.some((e) => e.slug === "overview")).toBe(false);
  });

  it("includes synthetic changelog in release-notes section entries", () => {
    const withReleaseNotes = [
      { slug: "release-notes", title: "Release Notes", content: "", path: "release-notes/index.md" },
      { slug: "release-notes/changelog", title: "Changelog", content: "", path: "release-notes/RELEASE_NOTES.md" },
      { slug: "overview", title: "Overview", content: "", path: "overview.md" },
    ];
    const result = filterSectionEntries(withReleaseNotes, "release-notes/changelog");

    expect(result.some((e) => e.slug === "release-notes")).toBe(true);
    expect(result.some((e) => e.slug === "release-notes/changelog")).toBe(true);
    expect(result.some((e) => e.slug === "overview")).toBe(false);
  });
});

// ─── Link Resolution Tests ───────────────────────────────────────────────────

describe("docs link resolution", () => {
  let resolveDocsLink: typeof import("../packages/web-ui/src/lib/utils/docs-utils")["resolveDocsLink"];
  let resolveOutOfTreeHref: typeof import("../packages/web-ui/src/lib/utils/docs-utils")["resolveOutOfTreeHref"];

  beforeAll(async () => {
    const mod = await import("../packages/web-ui/src/lib/utils/docs-utils");
    resolveDocsLink = mod.resolveDocsLink;
    resolveOutOfTreeHref = mod.resolveOutOfTreeHref;
  });

  it("resolves sibling links from root docs", () => {
    // From root doc getting-started.md, link to ./overview.md
    expect(resolveDocsLink("./overview.md", "getting-started.md")).toBe("overview");
    // From root doc, sibling link without ./
    expect(resolveDocsLink("overview.md", "getting-started.md")).toBe("overview");
  });

  it("resolves links between nested docs", () => {
    // From history/KYNETIC_SPEC_DESIGN.md, link to ./FORMAT_COMPARISON.md
    expect(resolveDocsLink("./FORMAT_COMPARISON.md", "history/KYNETIC_SPEC_DESIGN.md")).toBe(
      "history/FORMAT_COMPARISON",
    );
  });

  it("resolves parent-traversal links within docs tree", () => {
    // From history/design.md, link to ../getting-started.md
    expect(resolveDocsLink("../getting-started.md", "history/design.md")).toBe("getting-started");
  });

  it("returns null when link walks outside docs tree", () => {
    // From root doc, ../INSTALL.md walks outside docs/
    expect(resolveDocsLink("../INSTALL.md", "getting-started.md")).toBeNull();
    // From root doc, ../../README.md also walks outside
    expect(resolveDocsLink("../../README.md", "getting-started.md")).toBeNull();
  });

  it("normalizes index.md links to bare section slug", () => {
    // From getting-started/tutorial.md, link to ./index.md resolves to "getting-started"
    expect(resolveDocsLink("./index.md", "getting-started/tutorial.md")).toBe("getting-started");
    // From guides/deploy.md, link to ../getting-started/index.md
    expect(resolveDocsLink("../getting-started/index.md", "guides/deploy.md")).toBe("getting-started");
  });

  it("returns null for non-markdown links", () => {
    expect(resolveDocsLink("https://example.com", "getting-started.md")).toBeNull();
    expect(resolveDocsLink("#section", "getting-started.md")).toBeNull();
    expect(resolveDocsLink("image.png", "getting-started.md")).toBeNull();
  });

  describe("resolveOutOfTreeHref", () => {
    it("resolves ../INSTALL.md from root doc to INSTALL.md", () => {
      // docs/getting-started.md links to ../INSTALL.md => INSTALL.md at repo root
      expect(resolveOutOfTreeHref("../INSTALL.md", "getting-started.md")).toBe("INSTALL.md");
    });

    it("resolves ../AGENTS.md from root doc to AGENTS.md", () => {
      expect(resolveOutOfTreeHref("../AGENTS.md", "getting-started.md")).toBe("AGENTS.md");
    });

    it("resolves ../../README.md from nested doc to README.md", () => {
      // docs/guides/setup.md links to ../../README.md => README.md at repo root
      expect(resolveOutOfTreeHref("../../README.md", "guides/setup.md")).toBe("README.md");
    });

    it("resolves ../../INSTALL.md from nested tutorial to INSTALL.md", () => {
      // docs/getting-started/tutorial.md links to ../../INSTALL.md => INSTALL.md at repo root
      expect(resolveOutOfTreeHref("../../INSTALL.md", "getting-started/tutorial.md")).toBe("INSTALL.md");
    });

    it("resolves sibling link within docs tree to docs/<file>", () => {
      // docs/getting-started.md links to ./overview.md => docs/overview.md
      expect(resolveOutOfTreeHref("./overview.md", "getting-started.md")).toBe("docs/overview.md");
    });

    it("returns null for non-markdown links", () => {
      expect(resolveOutOfTreeHref("image.png", "getting-started.md")).toBeNull();
      expect(resolveOutOfTreeHref("#section", "getting-started.md")).toBeNull();
    });

    it("returns null when traversal goes above repo root", () => {
      // docs/getting-started.md links to ../../.. — too many levels
      expect(resolveOutOfTreeHref("../../../above-root.md", "getting-started.md")).toBeNull();
    });
  });
});

// ─── Release Notes Rendering Tests ──────────────────────────────────────────

describe("release notes rendering", () => {
  let docsPlugin: typeof import("../packages/web-ui/vite-plugin-docs")["docsPlugin"];
  let renderDocsMarkdown: typeof import("../packages/web-ui/src/lib/utils/docs-markdown")["renderDocsMarkdown"];

  beforeAll(async () => {
    const pluginMod = await import("../packages/web-ui/vite-plugin-docs");
    docsPlugin = pluginMod.docsPlugin;
    const mdMod = await import("../packages/web-ui/src/lib/utils/docs-markdown");
    renderDocsMarkdown = mdMod.renderDocsMarkdown;
  });

  // AC: @docs-release-notes-availability ac-1 — Release notes page with version anchors
  describe("version anchors and navigation", () => {
    it("renders version headings as anchored links of the form v<major>-<minor>-<patch>", () => {
      const content = [
        "# kspec Release Notes",
        "",
        "## Unreleased",
        "",
        "Staged changes.",
        "",
        "## v0.13.0",
        "",
        "Major release.",
        "",
        "## v0.12.0",
        "",
        "Feature release.",
      ].join("\n");

      const { html, toc } = renderDocsMarkdown(content);

      // Version headings produce anchors of the form v<major>-<minor>-<patch>
      expect(html).toContain('id="v0-13-0"');
      expect(html).toContain('href="#v0-13-0"');
      expect(html).toContain('id="v0-12-0"');
      expect(html).toContain('href="#v0-12-0"');
      expect(html).toContain('id="unreleased"');

      // TOC contains version entries that serve as an index of versions
      const versionTocEntries = toc.filter((e) => /^v\d/.test(e.text) || e.text === "Unreleased");
      expect(versionTocEntries.length).toBeGreaterThanOrEqual(3);
      expect(versionTocEntries.map((e) => e.text)).toContain("v0.13.0");
      expect(versionTocEntries.map((e) => e.text)).toContain("v0.12.0");
    });

    it("produces direct-linkable version anchors for every version in the file", () => {
      const content = [
        "# Release Notes",
        "",
        "## v1.0.0",
        "",
        "First stable.",
        "",
        "## v0.9.0",
        "",
        "Pre-release.",
        "",
        "## v0.1.0",
        "",
        "Initial.",
      ].join("\n");

      const { html } = renderDocsMarkdown(content);

      // Each version has a clickable anchor element
      expect(html).toContain('<a class="anchor" href="#v1-0-0"');
      expect(html).toContain('<a class="anchor" href="#v0-9-0"');
      expect(html).toContain('<a class="anchor" href="#v0-1-0"');
    });
  });

  // AC: @docs-release-notes-availability ac-2 — Content from canonical source, no duplication
  describe("canonical source bundling", () => {
    it("bundles RELEASE_NOTES.md as a docs entry with slug 'release-notes/changelog'", () => {
      const tempDocsDir = join(tmpdir(), `docs-rn-bundle-${Date.now()}`);
      const tempRnPath = join(tmpdir(), `RELEASE_NOTES-${Date.now()}.md`);

      mkdirSync(tempDocsDir, { recursive: true });
      writeFileSync(join(tempDocsDir, "getting-started.md"), "# Getting Started\n\nWelcome.");
      writeFileSync(
        tempRnPath,
        "# kspec Release Notes\n\n## v0.2.0\n\nSecond.\n\n## v0.1.0\n\nFirst.",
      );

      try {
        const plugin = docsPlugin(tempDocsDir, { releaseNotesPath: tempRnPath });
        const load = plugin.load as (id: string) => string | undefined;
        const result = load("\0virtual:docs")!;
        const manifest = JSON.parse(result.slice("export default ".length, -1));

        // Release notes entry is present under the release-notes section
        const rnEntry = manifest.entries.find((e: { slug: string }) => e.slug === "release-notes/changelog");
        expect(rnEntry).toBeDefined();
        expect(rnEntry.title).toBe("kspec Release Notes");
        expect(rnEntry.path).toBe("release-notes/RELEASE_NOTES.md");

        // Content is the canonical source (not a copy or transformation)
        expect(rnEntry.content).toContain("## v0.2.0");
        expect(rnEntry.content).toContain("## v0.1.0");
        expect(rnEntry.content).toContain("Second.");
        expect(rnEntry.content).toContain("First.");
      } finally {
        rmSync(tempDocsDir, { recursive: true, force: true });
        rmSync(tempRnPath, { force: true });
      }
    });

    it("renders content equivalent to the canonical source file", () => {
      const canonicalSource = [
        "# kspec Release Notes",
        "",
        "## v0.3.0",
        "",
        "### Features",
        "",
        "- Feature A",
        "- Feature B",
        "",
        "## v0.2.0",
        "",
        "### Bug Fixes",
        "",
        "- Fix C",
      ].join("\n");

      const { html } = renderDocsMarkdown(canonicalSource);

      // Rendered output contains all content from the source
      expect(html).toContain("Feature A");
      expect(html).toContain("Feature B");
      expect(html).toContain("Fix C");
      expect(html).toContain("v0.3.0");
      expect(html).toContain("v0.2.0");
    });

    it("does not create a second copy — only one entry with release notes content", () => {
      const tempDocsDir = join(tmpdir(), `docs-rn-nodup-${Date.now()}`);
      const tempRnPath = join(tmpdir(), `RELEASE_NOTES-nodup-${Date.now()}.md`);

      mkdirSync(tempDocsDir, { recursive: true });
      writeFileSync(join(tempDocsDir, "overview.md"), "# Overview\n\nDocs overview.");
      writeFileSync(tempRnPath, "# kspec Release Notes\n\n## v0.1.0\n\nInitial.");

      try {
        const plugin = docsPlugin(tempDocsDir, { releaseNotesPath: tempRnPath });
        const load = plugin.load as (id: string) => string | undefined;
        const result = load("\0virtual:docs")!;
        const manifest = JSON.parse(result.slice("export default ".length, -1));

        // Exactly one entry contains release notes content
        const releaseEntries = manifest.entries.filter(
          (e: { content: string }) => e.content.includes("Release Notes"),
        );
        expect(releaseEntries).toHaveLength(1);
        expect(releaseEntries[0].slug).toBe("release-notes/changelog");
      } finally {
        rmSync(tempDocsDir, { recursive: true, force: true });
        rmSync(tempRnPath, { force: true });
      }
    });

    it("skips gracefully when RELEASE_NOTES.md does not exist", () => {
      const tempDocsDir = join(tmpdir(), `docs-rn-missing-${Date.now()}`);
      mkdirSync(tempDocsDir, { recursive: true });
      writeFileSync(join(tempDocsDir, "page.md"), "# Page\n\nContent.");

      try {
        const plugin = docsPlugin(tempDocsDir, {
          releaseNotesPath: "/tmp/nonexistent-release-notes-" + Date.now() + ".md",
        });
        const load = plugin.load as (id: string) => string | undefined;
        const result = load("\0virtual:docs")!;
        const manifest = JSON.parse(result.slice("export default ".length, -1));

        // No release notes changelog entry when file is missing
        const rnEntry = manifest.entries.find((e: { slug: string }) => e.slug === "release-notes/changelog");
        expect(rnEntry).toBeUndefined();
        // Other docs still work
        expect(manifest.entries).toHaveLength(1);
      } finally {
        rmSync(tempDocsDir, { recursive: true, force: true });
      }
    });
  });

  // AC: @docs-release-notes-availability ac-1, ac-2 — Real build wiring integration
  describe("real vite config wiring", () => {
    // These paths mirror packages/web-ui/vite.config.ts — the test fails if
    // the config ever stops pointing at the canonical RELEASE_NOTES.md.
    const repoRoot = resolve(__dirname, "..");
    const realDocsDir = resolve(repoRoot, "docs");
    const realReleaseNotesPath = resolve(repoRoot, "RELEASE_NOTES.md");

    it("produces a release-notes/changelog manifest entry from the canonical RELEASE_NOTES.md", () => {
      const plugin = docsPlugin(realDocsDir, {
        releaseNotesPath: realReleaseNotesPath,
        exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
      });
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      const manifest = JSON.parse(result.slice("export default ".length, -1));

      const rnEntry = manifest.entries.find(
        (e: { slug: string }) => e.slug === "release-notes/changelog",
      );
      expect(rnEntry).toBeDefined();
      expect(rnEntry.slug).toBe("release-notes/changelog");
      expect(rnEntry.path).toBe("release-notes/RELEASE_NOTES.md");

      // Content matches the canonical source file byte-for-byte
      const canonicalContent = readFileSync(realReleaseNotesPath, "utf-8");
      expect(rnEntry.content).toBe(canonicalContent);
    });

    it("renders the canonical release notes with working version anchors", () => {
      const canonicalContent = readFileSync(realReleaseNotesPath, "utf-8");
      const { html, toc } = renderDocsMarkdown(canonicalContent);

      // The real RELEASE_NOTES.md contains versioned headings — verify anchors
      const versionPattern = /## v(\d+)\.(\d+)\.(\d+)/g;
      const versions: string[] = [];
      let match;
      while ((match = versionPattern.exec(canonicalContent)) !== null) {
        versions.push(`v${match[1]}-${match[2]}-${match[3]}`);
      }

      // There must be at least one released version
      expect(versions.length).toBeGreaterThan(0);

      // Each version heading produces a clickable anchor
      for (const anchor of versions) {
        expect(html).toContain(`id="${anchor}"`);
        expect(html).toContain(`href="#${anchor}"`);
      }

      // TOC includes version entries for navigation
      const tocVersions = toc.filter((e) => /^v\d/.test(e.text));
      expect(tocVersions.length).toBe(versions.length);
    });

    it("includes exactly one changelog entry — no duplication", () => {
      const plugin = docsPlugin(realDocsDir, {
        releaseNotesPath: realReleaseNotesPath,
        exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
      });
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      const manifest = JSON.parse(result.slice("export default ".length, -1));

      const releaseEntries = manifest.entries.filter(
        (e: { slug: string }) => e.slug === "release-notes/changelog",
      );
      expect(releaseEntries).toHaveLength(1);
    });
  });
});

// ─── Sanitizer Configuration Tests ──────────────────────────────────────────

describe("sanitizer allows heading anchors", () => {
  let sanitizeHtml: typeof import("../packages/web-ui/src/lib/utils/sanitize")["sanitizeHtml"];

  beforeAll(async () => {
    const mod = await import("../packages/web-ui/src/lib/utils/sanitize");
    sanitizeHtml = mod.sanitizeHtml;
  });

  // AC: @docs-navigation-shape ac-2 — Heading anchors survive sanitization
  it("preserves id attributes on headings", () => {
    const html = '<h2 id="my-section">My Section</h2>';
    const result = sanitizeHtml(html);
    expect(result).toContain('id="my-section"');
  });

  it("preserves anchor links inside headings", () => {
    const html = '<h2 id="intro"><a class="anchor" href="#intro" aria-hidden="true">#</a>Introduction</h2>';
    const result = sanitizeHtml(html);
    expect(result).toContain('href="#intro"');
    expect(result).toContain('aria-hidden="true"');
    expect(result).toContain('id="intro"');
  });
});

// ─── Section Scaffolding Tests (@docs-section-taxonomy) ─────────────────────

describe("docs section ordering (groupDocsSections)", () => {
  let groupDocsSections: typeof import("../packages/web-ui/src/lib/utils/docs-utils")["groupDocsSections"];
  let DOCS_SECTION_ORDER: typeof import("../packages/web-ui/src/lib/utils/docs-utils")["DOCS_SECTION_ORDER"];

  beforeAll(async () => {
    const mod = await import("../packages/web-ui/src/lib/utils/docs-utils");
    groupDocsSections = mod.groupDocsSections;
    DOCS_SECTION_ORDER = mod.DOCS_SECTION_ORDER;
  });

  const sectionEntries = [
    { slug: "concepts", title: "Concepts", content: "", path: "concepts/index.md" },
    { slug: "getting-started", title: "Getting Started", content: "", path: "getting-started/index.md" },
    { slug: "getting-started/tutorial", title: "Tutorial", content: "", path: "getting-started/tutorial.md" },
    { slug: "guides", title: "Guides", content: "", path: "guides/index.md" },
    { slug: "release-notes", title: "Release Notes", content: "", path: "release-notes/index.md" },
    { slug: "troubleshooting", title: "Troubleshooting", content: "", path: "troubleshooting/index.md" },
  ];

  // AC: @docs-section-taxonomy ac-1
  it("returns the five sections in canonical order: Getting Started, Guides, Concepts, Troubleshooting, Release Notes", () => {
    const sections = groupDocsSections(sectionEntries);
    const sectionKeys = sections.map((s) => s.key);

    expect(sectionKeys).toEqual([
      "getting-started",
      "guides",
      "concepts",
      "troubleshooting",
      "release-notes",
    ]);
  });

  // AC: @docs-section-taxonomy ac-1
  it("produces human-readable labels for each section", () => {
    const sections = groupDocsSections(sectionEntries);
    const labels = sections.map((s) => s.label);

    expect(labels).toEqual([
      "Getting Started",
      "Guides",
      "Concepts",
      "Troubleshooting",
      "Release Notes",
    ]);
  });

  it("places root-level entries after known sections", () => {
    const withRoot = [
      ...sectionEntries,
      { slug: "standalone-page", title: "Standalone", content: "", path: "standalone-page.md" },
    ];
    const sections = groupDocsSections(withRoot);
    const lastSection = sections[sections.length - 1];

    expect(lastSection.key).toBe("");
    expect(lastSection.label).toBe("Docs");
    expect(lastSection.entries[0].slug).toBe("standalone-page");
  });

  it("places unknown directory sections after known sections but before root", () => {
    const withUnknown = [
      ...sectionEntries,
      { slug: "api-reference", title: "API Ref", content: "", path: "api-reference/index.md" },
      { slug: "standalone", title: "Standalone", content: "", path: "standalone.md" },
    ];
    const sections = groupDocsSections(withUnknown);
    const keys = sections.map((s) => s.key);

    // Known sections first, then unknown alphabetically, then root
    expect(keys).toEqual([
      "getting-started",
      "guides",
      "concepts",
      "troubleshooting",
      "release-notes",
      "api-reference",
      "", // root
    ]);
  });

  it("groups entries within each section correctly", () => {
    const sections = groupDocsSections(sectionEntries);
    const gettingStarted = sections.find((s) => s.key === "getting-started");

    expect(gettingStarted).toBeDefined();
    expect(gettingStarted!.entries.map((e) => e.slug)).toEqual([
      "getting-started",
      "getting-started/tutorial",
    ]);
  });

  // AC: @docs-section-taxonomy ac-1 — synthetic changelog classified under release-notes, not a sixth section
  it("classifies synthetic changelog entry under the release-notes section", () => {
    const withChangelog = [
      ...sectionEntries,
      { slug: "release-notes/changelog", title: "Changelog", content: "", path: "release-notes/RELEASE_NOTES.md" },
    ];
    const sections = groupDocsSections(withChangelog);
    const sectionKeys = sections.map((s) => s.key);

    // Must still be exactly five sections — no sixth "Docs" section
    expect(sectionKeys).toEqual([
      "getting-started",
      "guides",
      "concepts",
      "troubleshooting",
      "release-notes",
    ]);

    // Changelog is inside the release-notes section
    const releaseNotes = sections.find((s) => s.key === "release-notes");
    expect(releaseNotes).toBeDefined();
    expect(releaseNotes!.entries.some((e) => e.slug === "release-notes/changelog")).toBe(true);
  });

  it("DOCS_SECTION_ORDER contains exactly the five canonical sections", () => {
    expect([...DOCS_SECTION_ORDER]).toEqual([
      "getting-started",
      "guides",
      "concepts",
      "troubleshooting",
      "release-notes",
    ]);
  });
});

describe("docs plugin exclude option", () => {
  let docsPlugin: typeof import("../packages/web-ui/vite-plugin-docs")["docsPlugin"];

  beforeAll(async () => {
    const mod = await import("../packages/web-ui/vite-plugin-docs");
    docsPlugin = mod.docsPlugin;
  });

  it("excludes files matching directory prefixes", () => {
    const tempDir = join(tmpdir(), `docs-exclude-dir-${Date.now()}`);
    mkdirSync(join(tempDir, "history"), { recursive: true });
    mkdirSync(join(tempDir, "guides"), { recursive: true });
    writeFileSync(join(tempDir, "index.md"), "# Home");
    writeFileSync(join(tempDir, "history", "design.md"), "# Design");
    writeFileSync(join(tempDir, "guides", "setup.md"), "# Setup");

    try {
      const plugin = docsPlugin(tempDir, { exclude: ["history"] });
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      const manifest = JSON.parse(result.slice("export default ".length, -1));
      const slugs = manifest.entries.map((e: { slug: string }) => e.slug);

      expect(slugs).toContain("index");
      expect(slugs).toContain("guides/setup");
      expect(slugs).not.toContain("history/design");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("excludes individual files by relative path", () => {
    const tempDir = join(tmpdir(), `docs-exclude-file-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "index.md"), "# Home");
    writeFileSync(join(tempDir, "internal-notes.md"), "# Internal");
    writeFileSync(join(tempDir, "guide.md"), "# Guide");

    try {
      const plugin = docsPlugin(tempDir, { exclude: ["internal-notes.md"] });
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      const manifest = JSON.parse(result.slice("export default ".length, -1));
      const slugs = manifest.entries.map((e: { slug: string }) => e.slug);

      expect(slugs).toContain("index");
      expect(slugs).toContain("guide");
      expect(slugs).not.toContain("internal-notes");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("applies multiple exclude patterns simultaneously", () => {
    const tempDir = join(tmpdir(), `docs-exclude-multi-${Date.now()}`);
    mkdirSync(join(tempDir, "history"), { recursive: true });
    mkdirSync(join(tempDir, "guides"), { recursive: true });
    writeFileSync(join(tempDir, "index.md"), "# Home");
    writeFileSync(join(tempDir, "internal.md"), "# Internal");
    writeFileSync(join(tempDir, "history", "old.md"), "# Old");
    writeFileSync(join(tempDir, "guides", "setup.md"), "# Setup");

    try {
      const plugin = docsPlugin(tempDir, { exclude: ["history", "internal.md"] });
      const load = plugin.load as (id: string) => string | undefined;
      const result = load("\0virtual:docs")!;
      const manifest = JSON.parse(result.slice("export default ".length, -1));
      const slugs = manifest.entries.map((e: { slug: string }) => e.slug);

      expect(slugs).toEqual(["guides/setup", "index"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// AC: @docs-section-taxonomy ac-2
describe("section landing page structure", () => {
  let docsPlugin: typeof import("../packages/web-ui/vite-plugin-docs")["docsPlugin"];
  let renderDocsMarkdown: typeof import("../packages/web-ui/src/lib/utils/docs-markdown")["renderDocsMarkdown"];

  beforeAll(async () => {
    const pluginMod = await import("../packages/web-ui/vite-plugin-docs");
    docsPlugin = pluginMod.docsPlugin;
    const mdMod = await import("../packages/web-ui/src/lib/utils/docs-markdown");
    renderDocsMarkdown = mdMod.renderDocsMarkdown;
  });

  // AC: @docs-section-taxonomy ac-2
  it("each section landing page has an H1 title and a purpose paragraph", () => {
    const docsDir = join(__dirname, "..", "docs");
    const plugin = docsPlugin(docsDir, {
      exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
    });
    const load = plugin.load as (id: string) => string | undefined;
    const result = load("\0virtual:docs")!;
    const manifest = JSON.parse(result.slice("export default ".length, -1));

    const sectionDirs = ["getting-started", "guides", "concepts", "troubleshooting", "release-notes"];

    for (const dir of sectionDirs) {
      const indexEntry = manifest.entries.find(
        (e: { slug: string }) => e.slug === dir,
      );
      expect(indexEntry, `${dir} landing page should exist`).toBeDefined();

      // Landing page should have an H1 title
      expect(indexEntry.content).toMatch(/^# .+$/m);

      // Landing page should have a non-empty paragraph (the purpose summary)
      const rendered = renderDocsMarkdown(indexEntry.content);
      expect(rendered.html).toContain("<p>");
    }
  });

  // AC: @docs-section-taxonomy ac-2
  it("every child-page link on a landing page resolves to a real manifest entry", () => {
    const docsDir = join(__dirname, "..", "docs");
    const plugin = docsPlugin(docsDir, {
      exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
    });
    const load = plugin.load as (id: string) => string | undefined;
    const result = load("\0virtual:docs")!;
    const manifest = JSON.parse(result.slice("export default ".length, -1));

    const allSlugs = new Set(
      manifest.entries.map((e: { slug: string }) => e.slug),
    );

    const sectionDirs = ["getting-started", "guides", "concepts", "troubleshooting", "release-notes"];
    const mdLinkPattern = /\[.+?\]\(\.\/(.+?)\.md\)/g;

    for (const dir of sectionDirs) {
      const indexEntry = manifest.entries.find(
        (e: { slug: string }) => e.slug === dir,
      );
      expect(indexEntry, `${dir} landing page should exist`).toBeDefined();

      // Extract all relative markdown links from the landing page
      const links: string[] = [];
      let match;
      while ((match = mdLinkPattern.exec(indexEntry.content)) !== null) {
        links.push(match[1]);
      }

      // Every linked child page must resolve to a real entry in the manifest
      for (const linkedFile of links) {
        const expectedSlug = `${dir}/${linkedFile}`;
        expect(allSlugs.has(expectedSlug), `${dir}/index.md links to ./${linkedFile}.md but slug "${expectedSlug}" is not in the docs manifest`).toBe(true);
      }
    }
  });

  // AC: @docs-section-taxonomy ac-2
  it("getting-started landing page links to its child pages in reading order", () => {
    const docsDir = join(__dirname, "..", "docs");
    const plugin = docsPlugin(docsDir, {
      exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
    });
    const load = plugin.load as (id: string) => string | undefined;
    const result = load("\0virtual:docs")!;
    const manifest = JSON.parse(result.slice("export default ".length, -1));

    const indexEntry = manifest.entries.find(
      (e: { slug: string }) => e.slug === "getting-started",
    );
    expect(indexEntry).toBeDefined();

    // Should link to child pages (at minimum the tutorial)
    expect(indexEntry.content).toContain("./tutorial.md");
  });
});

// ─── Getting Started Section Content ─────────────��────────────────────────────

describe("getting started section content", () => {
  let docsPlugin: typeof import("../packages/web-ui/vite-plugin-docs")["docsPlugin"];
  let renderDocsMarkdown: typeof import("../packages/web-ui/src/lib/utils/docs-markdown")["renderDocsMarkdown"];
  let manifest: { entries: Array<{ slug: string; title: string; content: string; path: string }> };

  beforeAll(async () => {
    const pluginMod = await import("../packages/web-ui/vite-plugin-docs");
    docsPlugin = pluginMod.docsPlugin;
    const mdMod = await import("../packages/web-ui/src/lib/utils/docs-markdown");
    renderDocsMarkdown = mdMod.renderDocsMarkdown;

    const docsDir = join(__dirname, "..", "docs");
    const plugin = docsPlugin(docsDir, {
      exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
    });
    const load = plugin.load as (id: string) => string | undefined;
    const result = load("\0virtual:docs")!;
    manifest = JSON.parse(result.slice("export default ".length, -1));
  });

  function getEntry(slug: string) {
    return manifest.entries.find((e) => e.slug === slug);
  }

  // The six required Getting Started pages in reading order
  const GETTING_STARTED_PAGES = [
    "getting-started/overview",
    "getting-started/installation",
    "getting-started/initializing-a-project",
    "getting-started/connecting-your-agent",
    "getting-started/your-first-action",
    "getting-started/where-to-go-next",
  ];

  // AC: @docs-getting-started-section ac-1
  describe("pages cover all required stages with executable commands", () => {
    it("all six Getting Started pages exist in the manifest", () => {
      for (const slug of GETTING_STARTED_PAGES) {
        const entry = getEntry(slug);
        expect(entry, `page ${slug} should exist`).toBeDefined();
      }
    });

    // AC: @docs-getting-started-section ac-1
    it("installation page shows how to install kspec", () => {
      const entry = getEntry("getting-started/installation")!;
      expect(entry.content).toContain("npm install -g @kynetic-ai/spec");
      expect(entry.content).toContain("kspec --version");
    });

    // AC: @docs-getting-started-section ac-1
    it("initializing page shows init and setup commands", () => {
      const entry = getEntry("getting-started/initializing-a-project")!;
      expect(entry.content).toContain("kspec init");
      expect(entry.content).toContain("kspec setup");
      expect(entry.content).toContain("kspec session start");
    });

    // AC: @docs-getting-started-section ac-1
    it("connecting-your-agent page covers agent integration", () => {
      const entry = getEntry("getting-started/connecting-your-agent")!;
      // Must cover at least one agent family
      expect(entry.content).toMatch(/claude|cline|cursor|windsurf/i);
      // Must show how to confirm the connection works
      expect(entry.content).toMatch(/verify|confirm/i);
    });

    // AC: @docs-getting-started-section ac-1
    it("your-first-action page includes at least one authoring action", () => {
      const entry = getEntry("getting-started/your-first-action")!;
      // Must show creating a spec item
      expect(entry.content).toContain("kspec item add");
      // Must show deriving a task
      expect(entry.content).toContain("kspec derive");
      // Must show task lifecycle
      expect(entry.content).toContain("kspec task start");
      expect(entry.content).toContain("kspec task submit");
    });

    // AC: @docs-getting-started-section ac-1
    it("each page contains at least one code block with an executable command", () => {
      for (const slug of GETTING_STARTED_PAGES) {
        const entry = getEntry(slug)!;
        const rendered = renderDocsMarkdown(entry.content);
        // Each page should have at least one code block
        expect(rendered.html, `${slug} should contain a code block`).toContain("<pre><code");
      }
    });
  });

  // AC: @docs-getting-started-section ac-2
  describe("pages end with next links in reading order", () => {
    // All pages except the last must end with a "next" link
    const pagesWithNextLinks = GETTING_STARTED_PAGES.slice(0, -1);

    for (let i = 0; i < pagesWithNextLinks.length; i++) {
      const currentSlug = pagesWithNextLinks[i];
      const nextSlug = GETTING_STARTED_PAGES[i + 1];
      const nextFilename = nextSlug.split("/")[1] + ".md";

      // AC: @docs-getting-started-section ac-2
      it(`${currentSlug.split("/")[1]} links to ${nextSlug.split("/")[1]}`, () => {
        const entry = getEntry(currentSlug)!;
        // The next link should be a relative .md link to the following page
        expect(entry.content).toContain(`./${nextFilename}`);
      });
    }

    // AC: @docs-getting-started-section ac-2
    it("the last page (where-to-go-next) does not have a next link marker", () => {
      const entry = getEntry("getting-started/where-to-go-next")!;
      // Should not contain a "Next:" marker pointing to another getting-started page
      expect(entry.content).not.toMatch(/\*\*Next:\*\*/);
    });
  });

  // AC: @docs-getting-started-section ac-3
  describe("initializing a project page covers shadow branch", () => {
    // AC: @docs-getting-started-section ac-3
    it("names the shadow branch (kspec-meta)", () => {
      const entry = getEntry("getting-started/initializing-a-project")!;
      expect(entry.content).toContain("kspec-meta");
    });

    // AC: @docs-getting-started-section ac-3
    it("identifies the shadow directory (.kspec/)", () => {
      const entry = getEntry("getting-started/initializing-a-project")!;
      expect(entry.content).toContain(".kspec/");
    });

    // AC: @docs-getting-started-section ac-3
    it("names the health-check command (kspec shadow status)", () => {
      const entry = getEntry("getting-started/initializing-a-project")!;
      expect(entry.content).toContain("kspec shadow status");
    });

    // AC: @docs-getting-started-section ac-3
    it("names the repair command (kspec shadow repair)", () => {
      const entry = getEntry("getting-started/initializing-a-project")!;
      expect(entry.content).toContain("kspec shadow repair");
    });

    // AC: @docs-getting-started-section ac-3
    it("instructs the reader not to edit shadow state by hand", () => {
      const entry = getEntry("getting-started/initializing-a-project")!;
      const rendered = renderDocsMarkdown(entry.content);
      // Must contain a clear instruction not to manually edit .kspec/ files
      expect(rendered.html).toMatch(/never\s+manual|do\s+not\s+edit|not\s+edit.*by\s+hand|not\s+.*manually\s+edit/i);
    });
  });

  // AC: @docs-getting-started-section ac-2
  it("landing page links to all six pages in reading order", () => {
    const indexEntry = getEntry("getting-started")!;
    const expectedLinks = [
      "./overview.md",
      "./installation.md",
      "./initializing-a-project.md",
      "./connecting-your-agent.md",
      "./your-first-action.md",
      "./where-to-go-next.md",
    ];

    for (const link of expectedLinks) {
      expect(indexEntry.content, `index should link to ${link}`).toContain(link);
    }

    // Verify the links appear in reading order
    const positions = expectedLinks.map((link) => indexEntry.content.indexOf(link));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i], `${expectedLinks[i]} should appear after ${expectedLinks[i - 1]}`).toBeGreaterThan(positions[i - 1]);
    }
  });
});
