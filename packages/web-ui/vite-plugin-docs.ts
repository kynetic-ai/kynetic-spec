/**
 * Vite plugin that scans the repository's top-level docs/ directory at build time
 * and exposes a virtual module `virtual:docs` containing all markdown content.
 *
 * This ensures docs pages are bundled into the client JS and require no runtime
 * file reads, API calls, or network requests — satisfying offline and static-mode
 * requirements.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import type { Plugin } from "vite";

const VIRTUAL_MODULE_ID = "virtual:docs";
const RESOLVED_VIRTUAL_MODULE_ID = "\0" + VIRTUAL_MODULE_ID;

interface DocsEntry {
  slug: string;
  title: string;
  content: string;
  path: string;
}

/**
 * Extract a title from markdown content.
 * Looks for the first H1 heading (# Title). Falls back to humanizing the filename.
 */
function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  // Humanize filename: "getting-started.md" → "Getting Started"
  const name = basename(filename, extname(filename));
  return name
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Convert a file path relative to docs/ into a URL slug.
 * "getting-started.md" → "getting-started"
 * "history/KYNETIC_SPEC_DESIGN.md" → "history/KYNETIC_SPEC_DESIGN"
 */
function pathToSlug(relativePath: string): string {
  return relativePath.replace(/\.md$/i, "");
}

/**
 * Recursively collect all .md files under a directory.
 */
function collectMarkdownFiles(
  dir: string,
  baseDir: string,
): { relativePath: string; absolutePath: string }[] {
  const results: { relativePath: string; absolutePath: string }[] = [];

  let entries: string[];
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

export function docsPlugin(docsDir: string): Plugin {
  return {
    name: "vite-plugin-docs",

    resolveId(id: string) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_MODULE_ID;
      }
    },

    load(id: string) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return;

      const files = collectMarkdownFiles(docsDir, docsDir);

      const entries: DocsEntry[] = files
        .map(({ relativePath, absolutePath }) => {
          const content = readFileSync(absolutePath, "utf-8");
          return {
            slug: pathToSlug(relativePath),
            title: extractTitle(content, relativePath),
            content,
            path: relativePath,
          };
        })
        .sort((a, b) => a.slug.localeCompare(b.slug));

      const manifest = { entries };

      return `export default ${JSON.stringify(manifest)};`;
    },

    handleHotUpdate({ file, server }) {
      // If a docs .md file changes during dev, invalidate the virtual module
      if (file.startsWith(docsDir) && file.endsWith(".md")) {
        const mod = server.moduleGraph.getModuleById(
          RESOLVED_VIRTUAL_MODULE_ID,
        );
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
          return [mod];
        }
      }
    },
  };
}
