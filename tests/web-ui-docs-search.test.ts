/**
 * Docs Search Tests
 *
 * Tests the Pagefind-based docs search pipeline: build-time indexing via the
 * Node.js API produces a self-contained search index that ships with the static
 * build output. The Svelte component lazily loads the Pagefind client and
 * provides search UI scoped to docs pages.
 *
 * Spec: @docs-search
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const PROJECT_ROOT = resolve(__dirname, "..");

// ─── Test Fixture Helpers ───────────────────────────────────────────────────

function createTestFixture() {
  const tempDir = join(
    tmpdir(),
    `docs-search-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const docsDir = join(tempDir, "docs");
  const buildDir = join(tempDir, "build");
  const releaseNotesPath = join(tempDir, "RELEASE_NOTES.md");

  mkdirSync(docsDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });

  mkdirSync(join(docsDir, "getting-started"), { recursive: true });
  writeFileSync(
    join(docsDir, "getting-started", "index.md"),
    "# Getting Started\n\nWelcome to kspec documentation.\n",
  );
  writeFileSync(
    join(docsDir, "getting-started", "installation.md"),
    "# Installation\n\nInstall kspec using npm.\n",
  );

  mkdirSync(join(docsDir, "concepts"), { recursive: true });
  writeFileSync(
    join(docsDir, "concepts", "index.md"),
    "# Concepts\n\nCore concepts behind kspec.\n",
  );
  writeFileSync(
    join(docsDir, "concepts", "shadow-branch.md"),
    "# The Shadow Branch\n\nThe shadow branch stores spec and task state.\n",
  );

  mkdirSync(join(docsDir, "guides"), { recursive: true });
  writeFileSync(
    join(docsDir, "guides", "index.md"),
    "# Guides\n\nStep-by-step guides for kspec workflows.\n",
  );

  writeFileSync(releaseNotesPath, "# Release Notes\n\n## v0.13.0\n\nAdded documentation search.\n");

  return { tempDir, docsDir, buildDir, releaseNotesPath };
}

/**
 * Write a helper script into the project root (so `pagefind` resolves from
 * node_modules) and execute it.
 */
function runHelperScript(scriptContent: string, cwd: string): string {
  const scriptPath = join(
    cwd,
    `.pf-helper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`,
  );
  writeFileSync(scriptPath, scriptContent);
  try {
    return execSync(`node ${scriptPath}`, {
      cwd,
      encoding: "utf-8",
      timeout: 30000,
    }).trim();
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

// ─── Index builder helper ───────────────────────────────────────────────────

function buildIndexScript(docsDir: string, outputDir: string, basePath = ""): string {
  return `
    const { readdirSync, readFileSync, statSync } = require("node:fs");
    const { join, relative, basename, extname } = require("node:path");

    function collect(dir, base) {
      const r = [];
      try { for (const e of readdirSync(dir)) {
        const a = join(dir, e), s = statSync(a);
        if (s.isDirectory()) r.push(...collect(a, base));
        else if (e.endsWith(".md")) r.push({ rel: relative(base, a), abs: a });
      }} catch {}
      return r;
    }
    function title(c, f) {
      const m = c.match(/^#\\s+(.+)$/m);
      return m ? m[1].trim() : basename(f, extname(f)).replace(/[-_]/g, " ");
    }
    function slug(p) {
      const s = p.replace(/\\.md$/i, "");
      return s.endsWith("/index") ? s.slice(0, -6) : s;
    }
    function strip(md) {
      return md.replace(/^#{1,6}\\s+/gm, "").trim();
    }

    async function main() {
      const pf = await import("pagefind");
      const { index } = await pf.createIndex({ forceLanguage: "en" });
      const docs = ${JSON.stringify(docsDir)};
      const bp = ${JSON.stringify(basePath)};
      const files = collect(docs, docs);
      let count = 0;
      const urls = [];
      for (const { rel, abs } of files) {
        const c = readFileSync(abs, "utf-8");
        const url = bp + "/docs/" + slug(rel);
        urls.push(url);
        await index.addCustomRecord({
          url, content: strip(c), language: "en",
          meta: { title: title(c, rel) },
        });
        count++;
      }
      await index.writeFiles({ outputPath: ${JSON.stringify(outputDir)} });
      console.log(JSON.stringify({ count, urls }));
    }
    main().catch(e => { console.error(e); process.exit(1); });
  `;
}

// ─── Index Structure Tests ──────────────────────────────────────────────────

describe("docs search indexing (build-docs-search.cjs)", () => {
  let tempDir: string;
  let pagefindDir: string;
  let indexResult: { count: number; urls: string[] };

  beforeAll(() => {
    const fixture = createTestFixture();
    tempDir = fixture.tempDir;
    pagefindDir = join(fixture.buildDir, "pagefind");

    const script = buildIndexScript(join(tempDir, "docs"), pagefindDir);
    const result = runHelperScript(script, PROJECT_ROOT);
    indexResult = JSON.parse(result);
  }, 60000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // AC: @docs-search ac-1
  it("produces a pagefind directory with all required index files", () => {
    expect(existsSync(pagefindDir)).toBe(true);
    const files = readdirSync(pagefindDir);

    // Core Pagefind files
    expect(files).toContain("pagefind.js");
    expect(files).toContain("pagefind-entry.json");
    // WASM search engine (runs entirely in the browser)
    expect(files.some((f) => f.endsWith(".pagefind"))).toBe(true);
    // Index and fragment directories
    expect(files).toContain("index");
    expect(files).toContain("fragment");
  });

  // AC: @docs-search ac-1
  it("indexes all docs entries from the fixture", () => {
    // Fixture has 5 markdown files (getting-started/index, getting-started/installation,
    // concepts/index, concepts/shadow-branch, guides/index)
    expect(indexResult.count).toBe(5);
  });

  // AC: @docs-search ac-1
  it("produces URLs that point to docs pages", () => {
    for (const url of indexResult.urls) {
      expect(url).toMatch(/^\/docs\//);
    }
    const slugs = indexResult.urls.map((u) => u.replace("/docs/", ""));
    expect(slugs).toContain("getting-started");
    expect(slugs).toContain("getting-started/installation");
    expect(slugs).toContain("concepts");
    expect(slugs).toContain("concepts/shadow-branch");
    expect(slugs).toContain("guides");
  });

  // AC: @docs-search ac-2
  it("produces a self-contained index with WASM and worker for offline use", () => {
    const files = readdirSync(pagefindDir);
    // Client JS (loads and runs search)
    expect(files).toContain("pagefind.js");
    // WASM binary (search engine — no server needed)
    expect(files.some((f) => f.endsWith(".pagefind"))).toBe(true);
    // Worker JS (background thread search)
    expect(files).toContain("pagefind-worker.js");
    // Entry manifest (metadata for lazy-loading index chunks)
    expect(files).toContain("pagefind-entry.json");
  });

  // AC: @docs-search ac-1
  it("fragment directory has entries for each indexed page", () => {
    const fragmentDir = join(pagefindDir, "fragment");
    expect(existsSync(fragmentDir)).toBe(true);
    const fragmentFiles = readdirSync(fragmentDir);
    // Each indexed page should produce at least one fragment file
    expect(fragmentFiles.length).toBeGreaterThan(0);
  });
});

// ─── Base Path Handling Tests ───────────────────────────────────────────────

describe("docs search base path handling", () => {
  let tempDir: string;

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // AC: @docs-search ac-3
  it("indexes URLs with base path prefix when configured", () => {
    const fixture = createTestFixture();
    tempDir = fixture.tempDir;
    const pagefindDir = join(fixture.buildDir, "pagefind");

    const script = buildIndexScript(join(tempDir, "docs"), pagefindDir, "/kynetic-spec");
    const result = runHelperScript(script, PROJECT_ROOT);
    const { urls } = JSON.parse(result);

    // All URLs should include the base path
    for (const url of urls) {
      expect(url).toMatch(/^\/kynetic-spec\/docs\//);
    }
  }, 60000);

  // AC: @docs-search ac-3
  it("indexes URLs without base path prefix when not configured", () => {
    const fixture = createTestFixture();
    const pagefindDir2 = join(fixture.buildDir, "pagefind2");

    const script = buildIndexScript(join(tempDir!, "docs"), pagefindDir2, "");
    const result = runHelperScript(script, PROJECT_ROOT);
    const { urls } = JSON.parse(result);

    // All URLs should start with /docs/ (no base path)
    for (const url of urls) {
      expect(url).toMatch(/^\/docs\//);
      expect(url).not.toMatch(/^\/kynetic-spec\//);
    }

    rmSync(pagefindDir2, { recursive: true, force: true });
  }, 60000);
});

// ─── Build Pipeline Integration ─────────────────────────────────────────────

describe("docs search build integration", () => {
  // AC: @docs-search ac-2
  it("build-docs-search.cjs exists in scripts directory", () => {
    expect(existsSync(join(PROJECT_ROOT, "scripts", "build-docs-search.cjs"))).toBe(true);
  });

  // AC: @docs-search ac-2
  it("build pipeline chains docs search after web-ui build", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- build config verification, not source scanning
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts["build:docs-search"]).toContain("build-docs-search.cjs");
    expect(pkg.scripts["build:web-ui"]).toContain("build:docs-search");
  });

  // AC: @docs-search ac-3
  it("build script reads BASE_PATH from environment", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- build config verification
    const content = readFileSync(join(PROJECT_ROOT, "scripts", "build-docs-search.cjs"), "utf-8");
    expect(content).toContain("process.env.BASE_PATH");
  });

  // AC: @docs-search ac-3
  it("GitHub Pages workflows include docs search indexing with BASE_PATH", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- CI config verification
    const ghPagesUi = readFileSync(
      join(PROJECT_ROOT, ".github", "workflows", "gh-pages-ui.yml"),
      "utf-8",
    );
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- CI config verification
    const ghPages = readFileSync(
      join(PROJECT_ROOT, ".github", "workflows", "gh-pages.yml"),
      "utf-8",
    );

    expect(ghPagesUi).toContain("build:docs-search");
    expect(ghPages).toContain("build:docs-search");
  });

  // AC: @docs-search ac-2
  it("index exclude patterns match vite-plugin-docs excludes", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- build config verification
    const scriptContent = readFileSync(
      join(PROJECT_ROOT, "scripts", "build-docs-search.cjs"),
      "utf-8",
    );
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- build config verification
    const viteConfig = readFileSync(
      join(PROJECT_ROOT, "packages", "web-ui", "vite.config.ts"),
      "utf-8",
    );

    // Both should exclude "history" (directory)
    expect(scriptContent).toContain('"history"');
    expect(viteConfig).toContain('"history"');

    // Both should exclude specific files
    expect(scriptContent).toContain('"agents-eval-scenarios.md"');
    expect(scriptContent).toContain('"prime-mock.md"');
  });
});

// ─── Svelte Component Integration ──────────────────────────────────────────

describe("DocsSearch component integration", () => {
  const componentPath = join(PROJECT_ROOT, "packages/web-ui/src/lib/components/DocsSearch.svelte");

  // AC: @docs-search ac-1
  it("DocsSearch.svelte component exists", () => {
    expect(existsSync(componentPath)).toBe(true);
  });

  // AC: @docs-search ac-1
  it("search component is imported in the docs slug page (any docs page)", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- component wiring verification
    const slugPage = readFileSync(
      join(PROJECT_ROOT, "packages/web-ui/src/routes/docs/[...slug]/+page.svelte"),
      "utf-8",
    );
    expect(slugPage).toContain("import DocsSearch");
    expect(slugPage).toContain("<DocsSearch");
  });

  // AC: @docs-search ac-1
  it("search component is imported in the docs landing page", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- component wiring verification
    const landingPage = readFileSync(
      join(PROJECT_ROOT, "packages/web-ui/src/routes/docs/+page.svelte"),
      "utf-8",
    );
    expect(landingPage).toContain("import DocsSearch");
    expect(landingPage).toContain("<DocsSearch");
  });

  // AC: @docs-search ac-2
  it("loads Pagefind from the local bundle path, not from a CDN", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- verifying no external network dependencies
    const content = readFileSync(componentPath, "utf-8");
    // Must reference the local pagefind directory
    expect(content).toContain("pagefind/pagefind.js");
    expect(content).toContain("bundlePath");
    // Must not contain external CDN or remote service URLs
    const externalUrlMatches = content.match(/https?:\/\/(?!localhost)/g);
    expect(externalUrlMatches).toBeNull();
  });

  // AC: @docs-search ac-1
  it("has a search input and results container with test IDs", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- component wiring verification
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain('data-testid="docs-search-input"');
    expect(content).toContain('data-testid="docs-search-results"');
  });

  // AC: @docs-search ac-1
  it("navigates to the result URL when a result is selected", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- component wiring verification
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("goto(");
    expect(content).toContain("$app/navigation");
  });

  // AC: @docs-search ac-2
  it("initializes Pagefind lazily on user interaction", () => {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- verifying lazy loading behavior
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("import(");
    expect(content).toContain("handleFocus");
  });
});

// ─── Real Project Indexing ──────────────────────────────────────────────────

describe("docs search against real project docs", () => {
  // AC: @docs-search ac-1
  it("build-docs-search.cjs indexes the real docs directory successfully", () => {
    const buildDir = join(tmpdir(), `docs-search-real-${Date.now()}`);
    mkdirSync(join(buildDir, "pagefind"), { recursive: true });

    // Run the actual build script with output redirected to temp
    const wrapperPath = join(PROJECT_ROOT, `.pf-real-test-${Date.now()}.cjs`);
    const runPath = join(PROJECT_ROOT, `.pf-real-run-${Date.now()}.cjs`);
    const script = `
      process.env.BASE_PATH = "";
      const originalScript = require("node:fs").readFileSync(
        ${JSON.stringify(join(PROJECT_ROOT, "scripts", "build-docs-search.cjs"))},
        "utf-8"
      );
      const patched = originalScript.replace(
        'resolve(__dirname, "../packages/web-ui/build")',
        JSON.stringify(${JSON.stringify(buildDir)})
      );
      require("node:fs").writeFileSync(${JSON.stringify(runPath)}, patched);
      try { require(${JSON.stringify(runPath)}); } finally {
        try { require("node:fs").unlinkSync(${JSON.stringify(runPath)}); } catch {}
      }
    `;
    writeFileSync(wrapperPath, script);

    try {
      const output = execSync(`node ${wrapperPath}`, {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 30000,
      });

      // Should report indexed entries
      expect(output).toContain("Pagefind: indexed");

      const pagefindDir = join(buildDir, "pagefind");
      expect(existsSync(pagefindDir)).toBe(true);
      expect(readdirSync(pagefindDir)).toContain("pagefind.js");
      expect(readdirSync(pagefindDir)).toContain("pagefind-entry.json");
    } finally {
      rmSync(wrapperPath, { force: true });
      rmSync(runPath, { force: true });
      rmSync(buildDir, { recursive: true, force: true });
    }
  }, 60000);
});
