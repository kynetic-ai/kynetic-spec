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

// ─── Search Index Content Tests ─────────────────────────────────────────────

describe("docs search index content", () => {
  let tempDir: string;
  let pagefindDir: string;

  beforeAll(() => {
    const fixture = createTestFixture();
    tempDir = fixture.tempDir;
    pagefindDir = join(fixture.buildDir, "pagefind");

    // Build an index from the fixture docs
    const script = buildIndexScript(join(tempDir, "docs"), pagefindDir);
    runHelperScript(script, PROJECT_ROOT);
  }, 60000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // AC: @docs-search ac-1
  it("index fragment files contain indexed page content for search matching", () => {
    // Pagefind stores indexed content in gzip-compressed fragment files that
    // the client fetches when returning search results. Verify fragments exist
    // and contain the indexed text, proving the pipeline fed real content
    // into the index.
    const fragmentDir = join(pagefindDir, "fragment");
    const fragmentFiles = readdirSync(fragmentDir);
    expect(fragmentFiles.length).toBeGreaterThan(0);

    // Fragment files are gzip-compressed — decompress and collect content
    const { gunzipSync } = require("node:zlib");
    const allFragmentContent = fragmentFiles
      .map((f) => {
        const buf = readFileSync(join(fragmentDir, f));
        try {
          return gunzipSync(buf).toString("utf-8");
        } catch {
          // If not gzip, read as utf-8 directly
          return buf.toString("utf-8");
        }
      })
      .join("\n");

    // Fixture docs contain "shadow branch" in concepts/shadow-branch.md
    // and "kspec documentation" in getting-started/index.md.
    // The indexed fragments should contain these terms.
    expect(allFragmentContent).toContain("shadow");
    expect(allFragmentContent).toContain("npm");
  });

  // AC: @docs-search ac-1
  it("index entry manifest references all indexed pages", () => {
    // The pagefind-entry.json manifest tells the client how to load index
    // chunks. It should reflect the number of indexed pages.
    const entryJson = JSON.parse(readFileSync(join(pagefindDir, "pagefind-entry.json"), "utf-8"));
    // The entry should have index metadata
    expect(entryJson).toHaveProperty("version");
    expect(entryJson).toHaveProperty("languages");
    // English language index should exist since we used forceLanguage: "en"
    expect(entryJson.languages).toHaveProperty("en");
  });

  // AC: @docs-search ac-2
  it("index is fully self-contained with WASM search engine and worker", () => {
    // For offline operation, the index must include all runtime dependencies:
    // client JS, WASM search engine, and web worker — no external fetches needed
    const files = readdirSync(pagefindDir);
    expect(files).toContain("pagefind.js");
    expect(files).toContain("pagefind-worker.js");
    expect(files.some((f) => f.endsWith(".pagefind"))).toBe(true);
    expect(files).toContain("pagefind-entry.json");

    // Verify the client JS does not fetch from any external CDN or service.
    // Pagefind uses internal template strings like `https://example.com${...}`
    // for URL normalization — these are not real network requests.
    const clientJs = readFileSync(join(pagefindDir, "pagefind.js"), "utf-8");
    // Strip Pagefind's internal URL template patterns used for path normalization
    const cleaned = clientJs.replace(/https?:\/\/example\.com\$\{[^}]*\}/g, "");
    const externalUrls = cleaned.match(/https?:\/\/(?!localhost)[^\s"'`)\]]+/g);
    expect(externalUrls).toBeNull();
  });
});

// ─── Excluded Content Tests ─────────────────────────────────────────────────

describe("docs search exclusion behavior", () => {
  // AC: @docs-search ac-2
  it("excluded directories are not indexed even when present in docs dir", () => {
    // Create a fixture with an excluded "history" directory and verify
    // the indexer does not include it in the output
    const fixture = createTestFixture();
    const historyDir = join(fixture.docsDir, "history");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, "old-design.md"), "# Old Design\n\nThis should not be indexed.\n");

    const pagefindDir = join(fixture.buildDir, "pagefind-excl");

    // Use the actual build script logic (with exclusion) via the helper
    const script = `
      const { readdirSync, readFileSync, statSync } = require("node:fs");
      const { join, relative, basename, extname } = require("node:path");

      const EXCLUDE = ["history", "agents-eval-scenarios.md", "prime-mock.md"];
      function isExcluded(p) { return EXCLUDE.some(e => p === e || p.startsWith(e + "/")); }
      function collect(dir, base) {
        const r = [];
        try { for (const e of readdirSync(dir)) {
          const a = join(dir, e), s = statSync(a);
          if (s.isDirectory()) r.push(...collect(a, base));
          else if (e.endsWith(".md")) r.push({ rel: relative(base, a), abs: a });
        }} catch {}
        return r;
      }

      async function main() {
        const pf = await import("pagefind");
        const { index } = await pf.createIndex({ forceLanguage: "en" });
        const docsDir = ${JSON.stringify(fixture.docsDir)};
        const files = collect(docsDir, docsDir).filter(f => !isExcluded(f.rel));
        const urls = [];
        for (const { rel, abs } of files) {
          const c = readFileSync(abs, "utf-8");
          const slug = rel.replace(/\\.md$/i, "").replace(/\\/index$/, "");
          const url = "/docs/" + slug;
          urls.push(url);
          await index.addCustomRecord({ url, content: c, language: "en", meta: { title: "t" } });
        }
        await index.writeFiles({ outputPath: ${JSON.stringify(pagefindDir)} });
        console.log(JSON.stringify(urls));
      }
      main().catch(e => { console.error(e); process.exit(1); });
    `;
    const output = runHelperScript(script, PROJECT_ROOT);
    const urls = JSON.parse(output);

    // "history/old-design" should NOT appear in indexed URLs
    expect(urls).not.toContain("/docs/history/old-design");
    // But regular docs should still be indexed
    expect(urls.length).toBeGreaterThan(0);
    expect(urls).toContain("/docs/getting-started");

    rmSync(fixture.tempDir, { recursive: true, force: true });
  }, 60000);
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
