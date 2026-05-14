/**
 * Post-build script that creates a Pagefind search index from the docs directory.
 *
 * The web UI is a pure SPA (no SSR/SSG for individual pages), so Pagefind cannot
 * crawl rendered HTML. Instead we use Pagefind's Node.js indexing API to feed each
 * doc entry as a custom record. The resulting index is written into the static build
 * output so it ships with both the daemon-embedded UI and the GitHub Pages deployment.
 *
 * Usage: node scripts/build-docs-search.cjs [--base-path /kynetic-spec]
 */

const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative, basename, extname } = require("node:path");
const { resolve } = require("node:path");

// ─── Docs collection (mirrors vite-plugin-docs logic) ─────────────────────

function collectMarkdownFiles(dir, baseDir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const absolutePath = join(dir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      results.push(...collectMarkdownFiles(absolutePath, baseDir));
    } else if (stat.isFile() && entry.endsWith(".md")) {
      results.push({
        relativePath: relative(baseDir, absolutePath),
        absolutePath,
      });
    }
  }
  return results;
}

function extractTitle(content, filename) {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  const name = basename(filename, extname(filename));
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function pathToSlug(relativePath) {
  const slug = relativePath.replace(/\.md$/i, "");
  if (slug.endsWith("/index")) return slug.slice(0, -"/index".length);
  return slug;
}

/**
 * Strip markdown syntax to produce plain text for indexing.
 * Pagefind indexes the `content` field as plain text, so we remove
 * headings markers, code fences, links, images, bold/italic, etc.
 */
function stripMarkdown(md) {
  return (
    md
      // Remove code fences (```...```)
      .replace(/```[\s\S]*?```/g, "")
      // Remove inline code
      .replace(/`[^`]+`/g, "")
      // Remove images ![alt](url)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // Convert links [text](url) to just text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Remove heading markers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove bold/italic markers
      .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2")
      // Remove HTML tags
      .replace(/<[^>]+>/g, "")
      // Remove horizontal rules
      .replace(/^[-*_]{3,}$/gm, "")
      // Collapse whitespace
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ─── Excluded paths (must match vite-plugin-docs config) ──────────────────

const EXCLUDE = ["history", "agents-eval-scenarios.md", "prime-mock.md"];

function isExcluded(relativePath) {
  return EXCLUDE.some(
    (pattern) => relativePath === pattern || relativePath.startsWith(pattern + "/"),
  );
}

// ─── Section label mapping ────────────────────────────────────────────────

function sectionLabel(slug) {
  const section = slug.includes("/") ? slug.split("/")[0] : null;
  if (!section) return "Docs";
  return section
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // Read base path from env (same as svelte.config.js) or CLI arg
  const args = process.argv.slice(2);
  const basePathIdx = args.indexOf("--base-path");
  const basePath = basePathIdx !== -1 ? args[basePathIdx + 1] || "" : process.env.BASE_PATH || "";

  const docsDir = resolve(__dirname, "../docs");
  const buildDir = resolve(__dirname, "../packages/web-ui/build");
  const releaseNotesPath = resolve(__dirname, "../RELEASE_NOTES.md");

  // Dynamically import pagefind (ESM-only package)
  const pagefind = await import("pagefind");

  const { index } = await pagefind.createIndex({
    forceLanguage: "en",
  });

  if (!index) {
    console.error("Failed to create Pagefind index");
    process.exit(1);
  }

  // Collect docs entries (same logic as vite-plugin-docs)
  const files = collectMarkdownFiles(docsDir, docsDir).filter(
    ({ relativePath }) => !isExcluded(relativePath),
  );

  let count = 0;

  for (const { relativePath, absolutePath } of files) {
    const content = readFileSync(absolutePath, "utf-8");
    const slug = pathToSlug(relativePath);
    const title = extractTitle(content, relativePath);
    const plainText = stripMarkdown(content);
    const section = sectionLabel(slug);

    await index.addCustomRecord({
      url: `${basePath}/docs/${slug}`,
      content: plainText,
      language: "en",
      meta: {
        title,
      },
      filters: {
        section: [section],
      },
    });
    count++;
  }

  // Add release notes if present
  try {
    const rnContent = readFileSync(releaseNotesPath, "utf-8");
    const rnTitle = extractTitle(rnContent, "RELEASE_NOTES.md");
    const rnPlainText = stripMarkdown(rnContent);

    await index.addCustomRecord({
      url: `${basePath}/docs/release-notes/changelog`,
      content: rnPlainText,
      language: "en",
      meta: {
        title: rnTitle,
      },
      filters: {
        section: ["Release Notes"],
      },
    });
    count++;
  } catch {
    // RELEASE_NOTES.md is optional
  }

  // Write the index into the static build output
  const outputPath = join(buildDir, "pagefind");
  await index.writeFiles({ outputPath });

  console.log(`Pagefind: indexed ${count} docs entries → ${outputPath}`);
}

main().catch((err) => {
  console.error("Failed to build docs search index:", err);
  process.exit(1);
});
