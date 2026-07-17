import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifestFixture from "./fixtures/public-documentation-surfaces.json" with { type: "json" };
import factsFixture from "./fixtures/dispatch-operator-facts.json" with { type: "json" };
import packageFixture from "../package.json" with { type: "json" };
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
  surface?: string;
  destination?: string;
  classification: string;
  source_of_truth: string[];
  exclusion_reason?: string;
  generated_from?: string[];
  build_command?: string;
}

interface InventoryFixture {
  construction_pending_additions: string[];
  section_reading_order: Record<string, string[]>;
  records: InventoryRecord[];
}

const NON_FILE_KINDS = [
  "cli-help",
  "api-surface",
  "ui-surface",
  "scaffold",
  "generated-artifact",
  "documentation-test",
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

function trackedFiles(...patterns: string[]): string[] {
  return execFileSync("git", ["ls-files", ...patterns], { cwd: ROOT, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .toSorted();
}

function documentationTestPaths(): string[] {
  return trackedFiles("tests/*.test.ts", "tests/**/*.test.ts", "tests/e2e/*.spec.ts").filter(
    (path) =>
      /(?:docs|documentation)/.test(path) ||
      path === "tests/help.test.ts" ||
      path === "tests/scaffold-project-config.test.ts" ||
      path === "tests/skill-cli.test.ts",
  );
}

function generatedDestinations(): string[] {
  const scripts = packageFixture.scripts as Record<string, string>;
  const destinations: string[] = [];
  if (scripts["build:plugin"]) destinations.push("plugin/plugins/kspec/skills/");
  if (scripts["build:docs-search"]) destinations.push("packages/web-ui/build/pagefind/");
  if (scripts["build:web-ui"]) destinations.push("packages/web-ui/build/", "dist/web-ui/");
  return destinations.toSorted();
}

function nonFileSignature(record: InventoryRecord): string {
  switch (record.kind) {
    case "cli-help":
      return record.id;
    case "api-surface":
    case "ui-surface":
      return record.surface ?? "";
    case "scaffold":
    case "documentation-test":
      return record.source_of_truth[0] ?? "";
    case "generated-artifact":
      return record.destination ?? "";
    default:
      throw new Error(`unsupported non-file kind: ${record.kind}`);
  }
}

function derivedNonFileSignatures(): Record<(typeof NON_FILE_KINDS)[number], string[]> {
  return {
    "cli-help": commandSurfaceIds(),
    "api-surface": [
      `${factsFixture.api.control.method} ${factsFixture.api.control.path}`,
      `${factsFixture.api.status.method} ${factsFixture.api.status.path}`,
    ].toSorted(),
    "ui-surface": ["agents lifecycle writable", "agents lifecycle static/read-only"].toSorted(),
    scaffold: trackedFiles("src/cli/commands/setup.ts", "src/cli/commands/upgrade.ts"),
    "generated-artifact": generatedDestinations(),
    "documentation-test": documentationTestPaths(),
  };
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

  const derived = derivedNonFileSignatures();
  for (const kind of NON_FILE_KINDS) {
    const actual = fixture.records
      .filter((record) => record.kind === kind)
      .map(nonFileSignature)
      .toSorted();
    if (new Set(actual).size !== actual.length) {
      throw new Error(`duplicate ${kind} surface`);
    }
    const missingSurface = derived[kind].filter((signature) => !actual.includes(signature));
    const staleSurface = actual.filter((signature) => !derived[kind].includes(signature));
    if (missingSurface.length > 0) {
      throw new Error(`missing required ${kind} surface: ${missingSurface.join(", ")}`);
    }
    if (staleSurface.length > 0) {
      throw new Error(`unexpected stale ${kind} surface: ${staleSurface.join(", ")}`);
    }
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

function sectionChildPaths(section: string, entries: DocsManifestEntry[]): Set<string> {
  return new Set(
    entries
      .filter(
        (entry) => entry.path.startsWith(`${section}/`) && entry.path !== `${section}/index.md`,
      )
      .map((entry) => `./${entry.path.slice(section.length + 1)}`),
  );
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
      const declaredOrder = manifestFixture.section_reading_order[section];
      const pendingLinks = new Set(
        manifestFixture.construction_pending_additions
          .filter((path) => path.startsWith(`docs/${section}/`))
          .map((path) => `./${path.slice(`docs/${section}/`.length)}`),
      );
      expect(firstParagraph).toBeTruthy();
      expect(new Set(links).size).toBe(links.length);
      expect(links.filter((link) => !pendingLinks.has(link))).toEqual(declaredOrder);
      expect(new Set(declaredOrder)).toEqual(
        new Set([...sectionChildPaths(section, entries)].filter((path) => !pendingLinks.has(path))),
      );
    },
  );

  // AC: @auto-cli-docs ac-1
  it("matches every exported Commander node to a declared CLI help surface", () => {
    const ids = new Set((manifestFixture.records as InventoryRecord[]).map((record) => record.id));
    expect(commandSurfaceIds().filter((id) => !ids.has(id))).toEqual([]);
  });

  it("rejects a missing command node without a hand-maintained command allowlist", () => {
    const fixture = cloneFixture();
    fixture.records = fixture.records.filter(
      (record) => record.id !== "cli-help:kspec agent dispatch task stop",
    );
    expect(() => validateInventory(fixture)).toThrow(/missing required cli-help surface/);
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

  it("rejects omitted and stale records in every non-file surface class", () => {
    for (const [kind, id] of [
      ["api-surface", "api:lifecycle-control"],
      ["ui-surface", "ui:agents-lifecycle-static"],
      ["scaffold", "scaffold:upgrade-project-config"],
      ["generated-artifact", "generated:docs-search"],
      ["documentation-test", "documentation-test:docs-e2e"],
    ] as const) {
      const fixture = cloneFixture();
      fixture.records = fixture.records.filter((record) => record.id !== id);
      expect(() => validateInventory(fixture), id).toThrow(
        new RegExp(`missing required ${kind} surface`),
      );

      const stale = cloneFixture();
      const template = stale.records.find((record) => record.id === id)!;
      stale.records.push({
        ...structuredClone(template),
        id: `${id}:stale`,
        ...(kind === "api-surface" || kind === "ui-surface"
          ? { surface: `${template.surface} stale` }
          : kind === "generated-artifact"
            ? { destination: `${template.destination}stale/` }
            : { source_of_truth: [`${template.source_of_truth[0]}.stale`] }),
      });
      expect(() => validateInventory(stale), id).toThrow(
        new RegExp(`unexpected stale ${kind} surface`),
      );
    }
  });
});
