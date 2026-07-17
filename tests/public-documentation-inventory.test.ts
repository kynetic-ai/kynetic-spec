import { execFileSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifestFixture from "./fixtures/public-documentation-surfaces.json" with { type: "json" };
import { createProgram } from "../src/cli/index.js";
import { extractCommandTree, flattenCommandTree } from "../src/cli/introspection.js";
import { DOCS_SECTION_ORDER } from "../packages/web-ui/src/lib/utils/docs-utils.js";
import { docsPlugin } from "../packages/web-ui/vite-plugin-docs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface DocsManifestEntry {
  path: string;
  content: string;
}

interface InventoryRecord {
  id: string;
  kind: string;
  path?: string;
  command?: string;
  classification: string;
  source_of_truth: string[];
  exclusion_reason?: string;
  generated_from?: string[];
  build_command?: string;
}

interface InventoryFixture {
  construction_pending_additions: string[];
  records: InventoryRecord[];
}

const REQUIRED_SURFACE_IDS = [
  "api:lifecycle-control",
  "api:agent-status",
  "ui:agents-lifecycle-writable",
  "ui:agents-lifecycle-static",
  "scaffold:setup-project-config",
  "scaffold:upgrade-project-config",
  "generated:plugin-skills",
  "generated:docs-search",
  "generated:web-docs",
  "generated:packaged-web-docs",
  "documentation-test:cli-help",
  "documentation-test:readme",
  "documentation-test:folder-resources",
  "documentation-test:resource-markdown",
  "documentation-test:web-rendering",
  "documentation-test:web-search",
  "documentation-test:docs-e2e",
  "documentation-test:scaffold",
  "documentation-test:generated-guidance",
  "documentation-test:inventory",
  "documentation-test:dispatch-operator",
] as const;

function trackedMarkdown(): string[] {
  return execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .toSorted();
}

function commandSurfaceIds(): string[] {
  return flattenCommandTree(extractCommandTree(createProgram()))
    .map((command) => `cli-help:${command.fullPath.join(" ")}`)
    .concat(["cli-help:root-help", "cli-help:full-help", "cli-help:json-help"])
    .toSorted();
}

function validateInventory(fixture: InventoryFixture): { pendingAdditions: string[] } {
  const ids = fixture.records.map((record) => record.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate inventory record id");

  const markdownRecords = fixture.records.filter(
    (record): record is InventoryRecord & { path: string } => record.kind === "markdown-file",
  );
  const paths = markdownRecords.map((record) => record.path);
  if (new Set(paths).size !== paths.length) throw new Error("duplicate Markdown manifest record");

  const tracked = trackedMarkdown();
  const trackedSet = new Set(tracked);
  const manifestSet = new Set(paths);
  const extras = paths.filter((path) => !trackedSet.has(path));
  if (extras.length > 0) throw new Error(`unexpected manifest extra: ${extras.join(", ")}`);

  const missing = tracked.filter((path) => !manifestSet.has(path));
  const allowed = new Set(fixture.construction_pending_additions);
  const unexpectedMissing = missing.filter((path) => !allowed.has(path));
  if (unexpectedMissing.length > 0) {
    throw new Error(`unclassified tracked Markdown: ${unexpectedMissing.join(", ")}`);
  }

  for (const record of markdownRecords) {
    if (!record.classification) throw new Error(`unclassified surface: ${record.path}`);
    if (record.source_of_truth.length === 0) throw new Error(`missing source: ${record.path}`);
    if (
      record.classification !== "active-public" &&
      (!record.exclusion_reason || record.exclusion_reason.trim().length === 0)
    ) {
      throw new Error(`unreasoned exclusion: ${record.path}`);
    }
    if (
      record.classification === "generated" &&
      (!record.generated_from?.length || !record.build_command)
    ) {
      throw new Error(`unpaired generated output: ${record.path}`);
    }
  }

  const requiredIds = [...commandSurfaceIds(), ...REQUIRED_SURFACE_IDS];
  for (const id of requiredIds) {
    if (!ids.includes(id)) throw new Error(`missing required surface id: ${id}`);
  }

  for (const record of fixture.records.filter(
    (candidate) => candidate.kind === "generated-artifact",
  )) {
    if (!record.generated_from?.length || !record.build_command) {
      throw new Error(`unpaired generated output: ${record.id}`);
    }
  }

  return { pendingAdditions: missing };
}

function cloneFixture(): InventoryFixture {
  return structuredClone(manifestFixture) as InventoryFixture;
}

function docsEntries(): DocsManifestEntry[] {
  const plugin = docsPlugin(join(ROOT, "docs"));
  const load = plugin.load as (id: string) => string | undefined;
  const moduleSource = load("\0virtual:docs");
  if (!moduleSource) throw new Error("docs plugin did not produce a manifest");
  return (
    JSON.parse(moduleSource.slice("export default ".length, -1)) as {
      entries: DocsManifestEntry[];
    }
  ).entries;
}

function sectionChildPaths(section: string, entries: DocsManifestEntry[]): string[] {
  return entries
    .filter((entry) => entry.path.startsWith(`${section}/`) && entry.path !== `${section}/index.md`)
    .map((entry) => `./${basename(entry.path)}`)
    .toSorted();
}

function landingLinks(markdown: string): string[] {
  return [...markdown.matchAll(/^\s*-\s+\[[^\]]+\]\((\.\/[^)#]+\.md)\)/gm)].map(
    (match) => match[1]!,
  );
}

describe("public documentation inventory", () => {
  // AC: @docs-section-taxonomy ac-1
  it("derives the five public documentation sections in navigation order", () => {
    expect([...DOCS_SECTION_ORDER]).toEqual([
      "getting-started",
      "guides",
      "concepts",
      "troubleshooting",
      "release-notes",
    ]);
  });

  // AC: @docs-section-taxonomy ac-2
  it.each(DOCS_SECTION_ORDER)(
    "%s landing page summarizes its purpose and links every child once",
    (section) => {
      const entries = docsEntries();
      const markdown = entries.find((entry) => entry.path === `${section}/index.md`)?.content;
      if (!markdown) throw new Error(`missing ${section} landing page`);
      const firstParagraph = markdown.split(/\n\s*\n/)[1]?.trim();
      const links = landingLinks(markdown);
      expect(firstParagraph).toBeTruthy();
      expect(new Set(links).size).toBe(links.length);
      expect(links.toSorted()).toEqual(sectionChildPaths(section, entries));
    },
  );

  // AC: @auto-cli-docs ac-1
  it("matches every exported Commander node to a declared CLI help surface", () => {
    const ids = new Set((manifestFixture.records as InventoryRecord[]).map((record) => record.id));
    expect(commandSurfaceIds().filter((id) => !ids.has(id))).toEqual([]);
  });

  // AC: @auto-cli-docs ac-5
  it("rejects a missing command node without a hand-maintained command allowlist", () => {
    const fixture = cloneFixture();
    fixture.records = fixture.records.filter(
      (record) => record.id !== "cli-help:kspec agent dispatch task stop",
    );
    expect(() => validateInventory(fixture)).toThrow(/missing required surface id/);
  });

  it("matches every tracked Markdown and required non-file public surface", () => {
    const result = validateInventory(cloneFixture());
    expect(
      result.pendingAdditions.every((path) =>
        manifestFixture.construction_pending_additions.includes(path),
      ),
    ).toBe(true);
    const markdownRecords = (manifestFixture.records as InventoryRecord[]).filter(
      (record) => record.kind === "markdown-file",
    );
    expect(markdownRecords.map((record) => record.path).toSorted()).toEqual(
      trackedMarkdown().filter(
        (path) => !manifestFixture.construction_pending_additions.includes(path),
      ),
    );
  });

  it("reports only the six planned pages as construction-phase additions", () => {
    const fixture = cloneFixture();
    expect(fixture.construction_pending_additions).toEqual([
      "docs/guides/configuring-dispatch-workspaces.md",
      "docs/guides/controlling-dispatch-lifecycle.md",
      "docs/concepts/dispatch-workspaces.md",
      "docs/troubleshooting/dispatch-bootstrap-failures.md",
      "docs/troubleshooting/dispatch-workspace-sync-and-cleanup.md",
      "docs/troubleshooting/dispatch-lifecycle-control-failures.md",
    ]);
    for (const planned of fixture.construction_pending_additions) {
      expect(relative(ROOT, resolve(ROOT, planned))).toBe(planned);
    }
  });

  it("rejects a missing or duplicate Markdown record", () => {
    const missing = cloneFixture();
    missing.records = missing.records.filter((record) => record.id !== "markdown:README.md");
    expect(() => validateInventory(missing)).toThrow(/unclassified tracked Markdown/);

    const duplicate = cloneFixture();
    duplicate.records.push(structuredClone(duplicate.records[0]!));
    expect(() => validateInventory(duplicate)).toThrow(/duplicate inventory record id/);
  });

  it("rejects an unexpected extra or an unreasoned exclusion", () => {
    const extra = cloneFixture();
    extra.records.push({
      id: "markdown:not-tracked.md",
      kind: "markdown-file",
      path: "not-tracked.md",
      classification: "active-public",
      source_of_truth: ["not-tracked.md"],
    });
    expect(() => validateInventory(extra)).toThrow(/unexpected manifest extra/);

    const unexplained = cloneFixture();
    const historical = unexplained.records.find(
      (record) => record.id === "markdown:docs/history/KYNETIC_SPEC_DESIGN.md",
    )!;
    delete historical.exclusion_reason;
    expect(() => validateInventory(unexplained)).toThrow(/unreasoned exclusion/);
  });

  it("rejects an unpaired generated output", () => {
    const fixture = cloneFixture();
    const generated = fixture.records.find((record) => record.id === "generated:plugin-skills")!;
    delete generated.generated_from;
    expect(() => validateInventory(fixture)).toThrow(/unpaired generated output/);
  });

  it("rejects an omitted API, UI, scaffold, generated, or documentation-test id", () => {
    for (const id of [
      "api:lifecycle-control",
      "ui:agents-lifecycle-static",
      "scaffold:upgrade-project-config",
      "generated:docs-search",
      "documentation-test:docs-e2e",
    ]) {
      const fixture = cloneFixture();
      fixture.records = fixture.records.filter((record) => record.id !== id);
      expect(() => validateInventory(fixture), id).toThrow(/missing required surface id/);
    }
  });
});
