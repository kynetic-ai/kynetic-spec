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
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

      expect(result.html).toContain('id="whats-new-v20"');
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

  it("includes section index page when present", () => {
    const withIndex = [
      ...entries,
      { slug: "guides", title: "Guides Index", content: "", path: "guides.md" },
    ];
    const result = filterSectionEntries(withIndex, "guides/setup");

    expect(result.some((e) => e.slug === "guides")).toBe(true);
    expect(result.some((e) => e.slug === "guides/setup")).toBe(true);
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
