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
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const WEB_UI_ROOT = join(process.cwd(), "packages", "web-ui");

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
      const manifestJson = result!.replace("export default ", "").replace(";", "");
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
      const manifest = JSON.parse(result.replace("export default ", "").replace(";", ""));

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
      const manifest = JSON.parse(result.replace("export default ", "").replace(";", ""));

      expect(manifest.entries).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles non-existent docs directory gracefully", () => {
    const plugin = docsPlugin("/tmp/non-existent-docs-dir-" + Date.now());
    const load = plugin.load as (id: string) => string | undefined;
    const result = load("\0virtual:docs")!;
    const manifest = JSON.parse(result.replace("export default ", "").replace(";", ""));

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

// ─── Route Structure Tests ────────────────────────────────────────────────────

describe("docs route structure", () => {
  // AC: @docs-reachability ac-1 — Docs entry present in primary navigation
  it("has a /docs landing page route", () => {
    expect(existsSync(join(WEB_UI_ROOT, "src/routes/docs/+page.svelte"))).toBe(true);
  });

  it("has a /docs/[...slug] catch-all route", () => {
    expect(existsSync(join(WEB_UI_ROOT, "src/routes/docs/[...slug]/+page.svelte"))).toBe(true);
  });

  it("has the vite-plugin-docs plugin file", () => {
    expect(existsSync(join(WEB_UI_ROOT, "vite-plugin-docs.ts"))).toBe(true);
  });

  it("has the docs module interface", () => {
    expect(existsSync(join(WEB_UI_ROOT, "src/lib/docs.ts"))).toBe(true);
  });

  it("has the docs-markdown utility", () => {
    expect(existsSync(join(WEB_UI_ROOT, "src/lib/utils/docs-markdown.ts"))).toBe(true);
  });
});

// ─── Navigation Integration Tests ────────────────────────────────────────────

describe("docs navigation integration", () => {
  // AC: @docs-reachability ac-1 — "Docs" entry present in primary navigation
  it("Sidebar includes Docs nav entry", async () => {
    const sidebarSource = (await import("node:fs")).readFileSync(
      join(WEB_UI_ROOT, "src/lib/components/Sidebar.svelte"),
      "utf-8",
    );
    // Verify the nav item exists in the Sidebar source
    expect(sidebarSource).toContain("'/docs'");
    expect(sidebarSource).toContain("'Docs'");
    expect(sidebarSource).toContain("BookOpen");
  });

  // AC: @docs-reachability ac-1 — Docs reachable from mobile navigation too
  it("MobileNav includes Docs nav entry", async () => {
    const mobileNavSource = (await import("node:fs")).readFileSync(
      join(WEB_UI_ROOT, "src/lib/components/MobileNav.svelte"),
      "utf-8",
    );
    expect(mobileNavSource).toContain("'/docs'");
    expect(mobileNavSource).toContain("'Docs'");
    expect(mobileNavSource).toContain("BookOpen");
  });
});

// ─── Vite Config Tests ───────────────────────────────────────────────────────

describe("vite config", () => {
  it("includes docsPlugin in vite.config.ts", async () => {
    const configSource = (await import("node:fs")).readFileSync(
      join(WEB_UI_ROOT, "vite.config.ts"),
      "utf-8",
    );
    expect(configSource).toContain("docsPlugin");
    expect(configSource).toContain("server");
    expect(configSource).toContain("fs");
    expect(configSource).toContain("allow");
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
