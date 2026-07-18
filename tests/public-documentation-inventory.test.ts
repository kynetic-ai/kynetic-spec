import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifestFixture from "./fixtures/public-documentation-surfaces.json" with { type: "json" };
import factsFixture from "./fixtures/dispatch-operator-facts.json" with { type: "json" };
import packageFixture from "../package.json" with { type: "json" };
import { createProgram } from "../src/cli/index.js";
import { extractCommandTree, flattenCommandTree } from "../src/cli/introspection.js";
import { parsePlanDocument } from "../src/parser/plan-document.js";
import { DOCS_SECTION_ORDER } from "../packages/web-ui/src/lib/utils/docs-utils.js";
import { docsPlugin } from "../packages/web-ui/vite-plugin-docs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface DocsManifestEntry {
  slug: string;
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
  owning_test?: string;
  audit_topics?: string[];
  audit_status?: string;
  disposition?: string;
}

interface InventoryFixture {
  schema_version: number;
  reviewed_lifecycle_commit: string;
  integrated_lifecycle_commit: string;
  tracked_markdown_count: number;
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

const PUBLIC_SURFACE_METADATA = {
  classification: "public-surface",
  audit_topics: ["factual-accuracy", "reachability"],
  audit_status: "source-verified",
  disposition: "declared",
} as const;
const ACTIVE_PUBLIC_ROOTS = new Set([
  "README.md",
  "INSTALL.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "RELEASE_NOTES.md",
  "packages/web-ui/README.md",
  ".github/ISSUE_TEMPLATE/maintainer-approved-issues-and-features.md",
]);
const EXCLUSION_METADATA = {
  audit_topics: ["ownership", "safety", "exclusion"],
  audit_status: "scope-verified",
  disposition: "verified-limited-audit",
} as const;
const ACTIVE_PUBLIC_METADATA = {
  audit_topics: ["factual-accuracy", "navigation", "links"],
  audit_status: "source-verified",
  disposition: "verified-or-corrected",
} as const;
const SOURCE_TEMPLATE_METADATA = {
  audit_topics: ["factual-accuracy", "package-neutrality", "generated-pairing"],
  audit_status: "source-verified",
  disposition: "verified-package-neutral",
} as const;
const FIXTURE_OWNERS: Record<string, string> = {
  "tests/e2e/fixtures/plans/01KG0RRPCA45ZT43W2T6HJMVP1/plan.md": "tests/e2e/plans.spec.ts",
  "tests/e2e/fixtures/plans/01KG0RRRCA45ZT43W2T6HJMVP2/plan.md": "tests/e2e/plans.spec.ts",
  "tests/e2e/fixtures/plans/01KG0RRSCA45ZT43W2T6HJMVP3/plan.md": "tests/e2e/plans.spec.ts",
  "tests/fixtures/multi-dir/README.md": "tests/daemon-context-manager.test.ts",
  "tests/fixtures/multi-dir/project-invalid/README.md":
    "tests/daemon-path-validation-middleware.test.ts",
};

function markdownSurfaceRecord(path: string): InventoryRecord {
  const base = {
    id: `markdown:${path}`,
    kind: "markdown-file",
    path,
    source_of_truth: [path],
  };
  if (
    ACTIVE_PUBLIC_ROOTS.has(path) ||
    (path.startsWith("docs/") &&
      !path.startsWith("docs/history/") &&
      path !== "docs/agents-eval-scenarios.md" &&
      path !== "docs/prime-mock.md")
  ) {
    return { ...base, classification: "active-public", ...ACTIVE_PUBLIC_METADATA };
  }
  if (path.startsWith("docs/history/")) {
    return {
      ...base,
      classification: "historical",
      exclusion_reason:
        "Historical record retained for context and checked only for dangerous current recovery advice.",
      ...EXCLUSION_METADATA,
    };
  }
  if (path === "docs/agents-eval-scenarios.md" || path === "docs/prime-mock.md") {
    return {
      ...base,
      classification: "internal-eval",
      exclusion_reason:
        "Internal evaluation or design input, not an operator documentation surface.",
      ...EXCLUSION_METADATA,
    };
  }
  if (path.startsWith("templates/agents-sections/") || path.startsWith("templates/skills/")) {
    return {
      ...base,
      classification: "source-template",
      exclusion_reason:
        "Package authoring source audited for factual neutrality; consumers read rendered outputs.",
      ...SOURCE_TEMPLATE_METADATA,
    };
  }
  if (path === "kspec-agents.md") {
    const generatedFrom = ["templates/agents-sections/", "project meta conventions/workflows"];
    return {
      ...base,
      classification: "generated",
      source_of_truth: generatedFrom,
      exclusion_reason: "Generated output audited through its source and regeneration pairing.",
      generated_from: generatedFrom,
      build_command: "kspec agents generate",
      ...EXCLUSION_METADATA,
    };
  }
  const renderedSkill = path.match(/^\.(?:agents|factory)\/skills\/(.+)$/)?.[1];
  const renderedSkillSource = renderedSkill?.replace(/^kspec-/, "");
  if (renderedSkillSource && existsSync(resolve(ROOT, `templates/skills/${renderedSkillSource}`))) {
    const generatedFrom = [`templates/skills/${renderedSkillSource}`];
    return {
      ...base,
      classification: "generated",
      source_of_truth: generatedFrom,
      exclusion_reason: "Generated output audited through its source and regeneration pairing.",
      generated_from: generatedFrom,
      build_command: "kspec skill render",
      ...EXCLUSION_METADATA,
    };
  }
  if (path.startsWith("tests/") && path.includes("/fixtures/")) {
    const owningTest = FIXTURE_OWNERS[path];
    if (!owningTest) throw new Error(`missing fixture ownership contract for ${path}`);
    return {
      ...base,
      classification: "fixture",
      exclusion_reason:
        "Test input owned by its behavioral fixture consumer, not public documentation.",
      owning_test: owningTest,
      ...EXCLUSION_METADATA,
    };
  }
  if (
    path === "AGENTS.md" ||
    path === "CLAUDE.md" ||
    path.startsWith(".claude/") ||
    path.startsWith(".agents/") ||
    path.startsWith(".factory/")
  ) {
    return {
      ...base,
      classification: "internal-agent-guidance",
      exclusion_reason: "Project or runtime agent guidance, not public operator documentation.",
      ...EXCLUSION_METADATA,
    };
  }
  throw new Error(`no Markdown classification contract for ${path}`);
}

function commandSurfaceRecords(): InventoryRecord[] {
  const generated = flattenCommandTree(extractCommandTree(createProgram())).map((command) => ({
    id: `cli-help:${command.fullPath.join(" ")}`,
    kind: "cli-help",
    command: command.fullPath.join(" "),
    classification: "public-generated",
    source_of_truth: ["src/cli/index.ts", "src/cli/introspection.ts"],
    audit_topics: ["syntax", "options", "subcommands"],
    audit_status: "source-verified",
    disposition: "generated-from-commander",
  }));
  const special = [
    ["root-help", "kspec --help"],
    ["full-help", "kspec help --all"],
    ["json-help", "kspec help --json"],
  ].map(([id, command]) => ({
    id: `cli-help:${id}`,
    kind: "cli-help",
    command,
    classification: "public-generated",
    source_of_truth: ["src/cli/index.ts", "src/cli/commands/help.ts", "src/cli/introspection.ts"],
    audit_topics: ["syntax", "content"],
    audit_status: "source-verified",
    disposition: "generated-from-commander",
  }));
  return [...generated, ...special];
}

function commandSurfaceIds(): string[] {
  return commandSurfaceRecords()
    .map((record) => record.id)
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

function declaredRecord(
  id: string,
  kind: InventoryRecord["kind"],
  surface: string,
  source_of_truth: string[],
  extra: Partial<InventoryRecord> = {},
): InventoryRecord {
  return { id, kind, surface, source_of_truth, ...PUBLIC_SURFACE_METADATA, ...extra };
}

function derivedNonFileRecords(): Record<(typeof NON_FILE_KINDS)[number], InventoryRecord[]> {
  const documentationTestIds = new Map([
    ["tests/help.test.ts", "cli-help"],
    ["tests/docs-readme-structure.test.ts", "readme"],
    ["tests/folder-backed-resource-docs.test.ts", "folder-resources"],
    ["tests/resource-ui-task-markdown-docs.test.ts", "resource-markdown"],
    ["tests/web-ui-docs-rendering.test.ts", "web-rendering"],
    ["tests/web-ui-docs-search.test.ts", "web-search"],
    ["tests/e2e/docs.spec.ts", "docs-e2e"],
    ["tests/scaffold-project-config.test.ts", "scaffold"],
    ["tests/skill-cli.test.ts", "generated-guidance"],
    ["tests/public-documentation-inventory.test.ts", "inventory"],
    ["tests/dispatch-operator-docs.test.ts", "dispatch-operator"],
  ]);
  const generatedSources: Record<string, string[]> = {
    "plugin/plugins/kspec/skills/": ["templates/skills/", "scripts/build-plugin.cjs"],
    "packages/web-ui/build/pagefind/": [
      "docs/",
      "RELEASE_NOTES.md",
      "scripts/build-docs-search.cjs",
    ],
    "packages/web-ui/build/": [
      "docs/",
      "packages/web-ui/vite-plugin-docs.ts",
      "packages/web-ui/vite.config.ts",
    ],
    "dist/web-ui/": ["packages/web-ui/build/", "package.json"],
  };
  const generatedIds: Record<string, string> = {
    "plugin/plugins/kspec/skills/": "plugin-skills",
    "packages/web-ui/build/pagefind/": "docs-search",
    "packages/web-ui/build/": "web-docs",
    "dist/web-ui/": "packaged-web-docs",
  };
  const buildCommands: Record<string, string> = {
    "plugin/plugins/kspec/skills/": "npm run build:plugin",
    "packages/web-ui/build/pagefind/": "npm run build:docs-search",
    "packages/web-ui/build/": "npm run build:web-ui",
    "dist/web-ui/": "npm run build:web-ui",
  };
  return {
    "cli-help": commandSurfaceRecords(),
    "api-surface": [
      declaredRecord(
        "api:lifecycle-control",
        "api-surface",
        `${factsFixture.api.control.method} ${factsFixture.api.control.path}`,
        [
          "packages/daemon/src/routes/agent-dispatch.ts",
          "packages/shared/src/api.ts",
          "tests/daemon-agent-dispatch-lifecycle.test.ts",
        ],
      ),
      declaredRecord(
        "api:agent-status",
        "api-surface",
        `${factsFixture.api.status.method} ${factsFixture.api.status.path}`,
        [
          "packages/daemon/src/routes/agent-dispatch.ts",
          "packages/shared/src/api.ts",
          "tests/daemon-agent-dispatch-lifecycle.test.ts",
        ],
      ),
    ],
    "ui-surface": [
      declaredRecord("ui:agents-lifecycle-writable", "ui-surface", "agents lifecycle writable", [
        "packages/web-ui/src/routes/agents/+page.svelte",
        "packages/web-ui/src/lib/dispatch-lifecycle.ts",
        "tests/web-ui/dispatch-lifecycle-controls.test.ts",
      ]),
      declaredRecord(
        "ui:agents-lifecycle-static",
        "ui-surface",
        "agents lifecycle static/read-only",
        [
          "packages/web-ui/src/routes/agents/+page.svelte",
          "packages/web-ui/src/lib/components/agents/DispatchStatus.svelte",
          "tests/web-ui/dispatch-lifecycle-controls.test.ts",
        ],
      ),
    ],
    scaffold: [
      declaredRecord("scaffold:setup-project-config", "scaffold", "setup-project-config", [
        "src/cli/commands/setup.ts",
        "tests/scaffold-project-config.test.ts",
      ]),
      declaredRecord("scaffold:upgrade-project-config", "scaffold", "upgrade-project-config", [
        "src/cli/commands/upgrade.ts",
        "tests/upgrade-command.test.ts",
      ]),
    ],
    "generated-artifact": generatedDestinations().map((destination) =>
      declaredRecord(
        `generated:${generatedIds[destination]}`,
        "generated-artifact",
        destination,
        generatedSources[destination]!,
        {
          destination,
          generated_from: generatedSources[destination],
          build_command: buildCommands[destination],
        },
      ),
    ),
    "documentation-test": documentationTestPaths().map((path) =>
      declaredRecord(
        `documentation-test:${documentationTestIds.get(path) ?? `UNMAPPED:${path}`}`,
        "documentation-test",
        path,
        [path],
      ),
    ),
  };
}

function normalizedRecord(record: InventoryRecord): string {
  const normalized = Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  );
  return JSON.stringify(normalized);
}

function validateInventory(fixture: InventoryFixture): void {
  if (fixture.schema_version !== factsFixture.schema_version) {
    throw new Error("unsupported inventory schema version");
  }
  if (fixture.reviewed_lifecycle_commit !== factsFixture.evidence.reviewed_lifecycle_commit) {
    throw new Error("stale reviewed lifecycle evidence");
  }
  if (fixture.integrated_lifecycle_commit !== factsFixture.evidence.integrated_lifecycle_commit) {
    throw new Error("stale integrated lifecycle evidence");
  }

  const ids = fixture.records.map((record) => record.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate inventory record id");

  const markdownRecords = fixture.records.filter(
    (record): record is InventoryRecord & { path: string } => record.kind === "markdown-file",
  );
  const paths = markdownRecords.map((record) => record.path);
  if (new Set(paths).size !== paths.length) throw new Error("duplicate Markdown manifest record");

  const tracked = trackedMarkdown();
  if (fixture.tracked_markdown_count !== tracked.length) {
    throw new Error("stale tracked Markdown count");
  }
  const trackedSet = new Set(tracked);
  const manifestSet = new Set(paths);
  const extras = paths.filter((path) => !trackedSet.has(path));
  if (extras.length > 0) throw new Error(`unexpected manifest extra: ${extras.join(", ")}`);

  const missing = tracked.filter((path) => !manifestSet.has(path));
  if (missing.length > 0) {
    throw new Error(`unclassified tracked Markdown: ${missing.join(", ")}`);
  }

  for (const record of markdownRecords) {
    if (!record.classification) throw new Error(`unclassified surface: ${record.path}`);
    if (record.source_of_truth.length === 0) throw new Error(`missing source: ${record.path}`);
    for (const authority of record.source_of_truth) {
      if (
        authority !== "project meta conventions/workflows" &&
        !existsSync(resolve(ROOT, authority))
      ) {
        throw new Error(`missing Markdown source authority: ${record.path}: ${authority}`);
      }
    }
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

  const expectedMarkdownRecords = tracked
    .map(markdownSurfaceRecord)
    .map(normalizedRecord)
    .toSorted();
  const actualMarkdownRecords = markdownRecords.map(normalizedRecord).toSorted();
  const missingMarkdownContract = expectedMarkdownRecords.filter(
    (record) => !actualMarkdownRecords.includes(record),
  );
  const staleMarkdownContract = actualMarkdownRecords.filter(
    (record) => !expectedMarkdownRecords.includes(record),
  );
  if (missingMarkdownContract.length > 0) {
    throw new Error(`missing required Markdown contract: ${missingMarkdownContract.join(", ")}`);
  }
  if (staleMarkdownContract.length > 0) {
    throw new Error(`unexpected stale Markdown contract: ${staleMarkdownContract.join(", ")}`);
  }

  for (const record of fixture.records.filter(
    (candidate) => candidate.kind === "generated-artifact",
  )) {
    if (!record.generated_from?.length || !record.build_command) {
      throw new Error(`unpaired generated output: ${record.id}`);
    }
  }

  const derived = derivedNonFileRecords();
  for (const kind of NON_FILE_KINDS) {
    const actualRecords = fixture.records.filter((record) => record.kind === kind);
    const expectedRecords = derived[kind];
    const actual = actualRecords.map(normalizedRecord).toSorted();
    const expected = expectedRecords.map(normalizedRecord).toSorted();
    if (new Set(actualRecords.map((record) => record.id)).size !== actualRecords.length) {
      throw new Error(`duplicate ${kind} surface`);
    }
    for (const record of actualRecords) {
      if (!record.classification) throw new Error(`unclassified surface: ${record.id}`);
      if (record.source_of_truth.length === 0) throw new Error(`missing source: ${record.id}`);
      for (const authority of record.source_of_truth) {
        if (!existsSync(resolve(ROOT, authority))) {
          throw new Error(`missing source authority: ${record.id}: ${authority}`);
        }
      }
    }
    const missingSurface = expected.filter((record) => !actual.includes(record));
    const staleSurface = actual.filter((record) => !expected.includes(record));
    if (missingSurface.length > 0) {
      throw new Error(`missing required ${kind} surface: ${missingSurface.join(", ")}`);
    }
    if (staleSurface.length > 0) {
      throw new Error(`unexpected stale ${kind} surface: ${staleSurface.join(", ")}`);
    }
  }
}

function cloneFixture(): InventoryFixture {
  return structuredClone(manifestFixture) as InventoryFixture;
}

function docsEntries(): DocsManifestEntry[] {
  const plugin = docsPlugin(join(ROOT, "docs"), {
    repoUrl: "https://github.com/lepahc/kynetic-spec/blob/main",
    releaseNotesPath: join(ROOT, "RELEASE_NOTES.md"),
    exclude: ["history", "agents-eval-scenarios.md", "prime-mock.md"],
  });
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
      .map((entry) => `./${entry.slug.slice(section.length + 1)}.md`),
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
      expect(firstParagraph).toBeTruthy();
      expect(new Set(links).size).toBe(links.length);
      expect(links).toEqual(declaredOrder);
      expect(new Set(declaredOrder)).toEqual(sectionChildPaths(section, entries));
    },
  );

  it("parses the tagged plan-import example through the public plan parser", () => {
    const entry = docsEntries().find(
      (candidate) => candidate.path === "guides/importing-and-approving-a-plan.md",
    );
    if (!entry) throw new Error("missing plan import guide");
    const tagged = entry.content.match(/````markdown kspec-plan\n([\s\S]*?)\n````/);
    if (!tagged?.[1]) throw new Error("missing tagged kspec plan example");

    const parsed = parsePlanDocument(tagged[1]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.specs).toHaveLength(1);
    expect(parsed.tasks.additional_tasks).toHaveLength(1);
  });

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
    validateInventory(cloneFixture());
    const markdownRecords = (manifestFixture.records as InventoryRecord[]).filter(
      (record) => record.kind === "markdown-file",
    );
    expect(markdownRecords.map((record) => record.path).toSorted()).toEqual(trackedMarkdown());
  });

  it("enforces strict closure without construction-phase additions", () => {
    const fixture = cloneFixture();
    const tracked = trackedMarkdown();
    const declared = fixture.records
      .filter((record) => record.kind === "markdown-file")
      .map((record) => record.path)
      .toSorted();
    expect(declared).toEqual(tracked);
  });

  it("rejects a missing or duplicate Markdown record", () => {
    const missing = cloneFixture();
    missing.records = missing.records.filter((record) => record.id !== "markdown:README.md");
    expect(() => validateInventory(missing)).toThrow(/unclassified tracked Markdown/);

    const duplicate = cloneFixture();
    duplicate.records.push(structuredClone(duplicate.records[0]!));
    expect(() => validateInventory(duplicate)).toThrow(/duplicate inventory record id/);
  });

  it("rejects stale inventory schema, lifecycle evidence, count, and fixture ownership", () => {
    const mutations: Array<[string, (fixture: InventoryFixture) => void]> = [
      ["schema", (fixture) => (fixture.schema_version += 1)],
      ["reviewed evidence", (fixture) => (fixture.reviewed_lifecycle_commit = "0".repeat(40))],
      ["integrated evidence", (fixture) => (fixture.integrated_lifecycle_commit = "0".repeat(40))],
      ["Markdown count", (fixture) => (fixture.tracked_markdown_count -= 1)],
      [
        "fixture ownership",
        (fixture) => {
          fixture.records.find(
            (record) => record.id === "markdown:tests/fixtures/multi-dir/README.md",
          )!.owning_test = "tests/plan-document-parser.test.ts";
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      const fixture = cloneFixture();
      mutate(fixture);
      expect(() => validateInventory(fixture), label).toThrow();
    }
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

  it("rejects path-specific Markdown classification, authority, and audit metadata drift", () => {
    const mutations: Array<[string, (record: InventoryRecord) => void]> = [
      [
        "classification",
        (record) => {
          record.classification = "historical";
          record.exclusion_reason = "Arbitrary reclassification";
        },
      ],
      ["source authority", (record) => (record.source_of_truth = ["INSTALL.md"])],
      ["audit topics", (record) => (record.audit_topics = [])],
      ["audit status", (record) => (record.audit_status = "pending")],
      ["disposition", (record) => (record.disposition = "arbitrary")],
    ];
    for (const [label, mutate] of mutations) {
      const fixture = cloneFixture();
      mutate(fixture.records.find((record) => record.id === "markdown:README.md")!);
      expect(() => validateInventory(fixture), label).toThrow(/Markdown contract/);
    }
  });

  it("rejects an unpaired generated output", () => {
    const fixture = cloneFixture();
    const generated = fixture.records.find((record) => record.id === "generated:plugin-skills")!;
    delete generated.generated_from;
    expect(() => validateInventory(fixture)).toThrow(/unpaired generated output/);
  });

  it("rejects a generated file presented as its own source", () => {
    const fixture = cloneFixture();
    const generated = fixture.records.find((record) => record.id === "markdown:kspec-agents.md")!;
    generated.source_of_truth = ["kspec-agents.md"];
    generated.generated_from = ["kspec-agents.md"];

    expect(() => validateInventory(fixture)).toThrow(/Markdown contract/);
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
        new RegExp(`unexpected stale ${kind} surface|missing source authority`),
      );
    }
  });

  it("rejects drift in non-file identity, classification, and source authority", () => {
    for (const id of [
      "api:lifecycle-control",
      "ui:agents-lifecycle-writable",
      "scaffold:setup-project-config",
      "generated:plugin-skills",
      "documentation-test:cli-help",
    ]) {
      const wrongId = cloneFixture();
      wrongId.records.find((record) => record.id === id)!.id = `${id}:arbitrary`;
      expect(() => validateInventory(wrongId), `${id} identity`).toThrow(/missing required/);

      const unclassified = cloneFixture();
      unclassified.records.find((record) => record.id === id)!.classification = "";
      expect(() => validateInventory(unclassified), `${id} classification`).toThrow(
        /unclassified surface/,
      );

      const sourceDrift = cloneFixture();
      sourceDrift.records.find((record) => record.id === id)!.source_of_truth = [
        "arbitrary-authority.ts",
      ];
      expect(() => validateInventory(sourceDrift), `${id} source`).toThrow(
        /missing source authority/,
      );
    }
  });
});
