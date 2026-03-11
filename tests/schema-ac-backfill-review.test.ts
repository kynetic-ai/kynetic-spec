import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AlignmentIndex } from "../src/parser/alignment.js";
import { ReferenceIndex } from "../src/parser/refs.js";
import {
  findItemByRef,
  initContext,
  loadAllItems,
  parseYaml,
  toYaml,
  type LoadedSpecItem,
  type LoadedTask,
} from "../src/parser/yaml.js";
import { validate } from "../src/parser/validate.js";
import { ManifestSchema } from "../src/schema/spec.js";
import { cleanupTempDir, createTempDir } from "./helpers/cli.js";

function requireItem(items: LoadedSpecItem[], ref: string): LoadedSpecItem {
  const item = findItemByRef(items, ref);
  expect(item, `expected ${ref} to resolve in current project spec`).toBeDefined();
  return item!;
}

function logicalGraph(items: LoadedSpecItem[]) {
  return items
    .map((item) => ({
      title: item.title,
      type: item.type,
      slugs: [...item.slugs].sort(),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

describe("schema AC backfill review coverage", () => {
  // AC: @file-structure ac-1
  // AC: @single-file-structure ac-1
  // AC: @directory-structure ac-1
  it("loads single-file and included manifests into the same logical graph", async () => {
    const singleDir = await createTempDir("kspec-single-graph-");
    const splitDir = await createTempDir("kspec-split-graph-");

    try {
      await fs.writeFile(
        path.join(singleDir, "kynetic.yaml"),
        `kynetic: "1.0"
project:
  name: graph-test
  version: "0.1.0"
features:
  - _ulid: 01KMB00000000000000000001
    slugs:
      - graph-feature
    title: Graph Feature
    type: feature
    description: Shared feature definition
    status:
      maturity: draft
      implementation: not_started
    acceptance_criteria:
      - id: ac-1
        given: single-file project
        when: kspec loads the manifest
        then: feature is available in the loaded graph
`,
      );

      await fs.writeFile(
        path.join(splitDir, "kynetic.yaml"),
        `kynetic: "1.0"
project:
  name: graph-test
  version: "0.1.0"
includes:
  - modules/feature.yaml
`,
      );
      await fs.mkdir(path.join(splitDir, "modules"), { recursive: true });
      await fs.writeFile(
        path.join(splitDir, "modules", "feature.yaml"),
        `- _ulid: 01KMB00000000000000000001
  slugs:
    - graph-feature
  title: Graph Feature
  type: feature
  description: Shared feature definition
  status:
    maturity: draft
    implementation: not_started
  acceptance_criteria:
    - id: ac-1
      given: split project
      when: kspec loads the root manifest
      then: feature is available in the loaded graph
`,
      );

      const singleItems = await loadAllItems(await initContext(singleDir));
      const splitItems = await loadAllItems(await initContext(splitDir));

      expect(logicalGraph(singleItems)).toEqual(logicalGraph(splitItems));
    } finally {
      await cleanupTempDir(singleDir);
      await cleanupTempDir(splitDir);
    }
  });

  // AC: @file-structure ac-2
  it("preserves the logical spec model when a project is split from one file into includes", async () => {
    const projectDir = await createTempDir("kspec-split-transition-");

    try {
      const manifestPath = path.join(projectDir, "kynetic.yaml");
      await fs.writeFile(
        manifestPath,
        `kynetic: "1.0"
project:
  name: transition-test
  version: "0.1.0"
features:
  - _ulid: 01KMB00000000000000000031
    slugs:
      - transition-feature
    title: Transition Feature
    type: feature
    description: Shared feature definition
    status:
      maturity: draft
      implementation: not_started
    acceptance_criteria:
      - id: ac-1
        given: single-file project
        when: it is loaded
        then: the feature appears in the graph
`,
      );

      const beforeSplit = logicalGraph(await loadAllItems(await initContext(projectDir)));

      await fs.mkdir(path.join(projectDir, "modules"), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, "modules", "feature.yaml"),
        `- _ulid: 01KMB00000000000000000031
  slugs:
    - transition-feature
  title: Transition Feature
  type: feature
  description: Shared feature definition
  status:
    maturity: draft
    implementation: not_started
  acceptance_criteria:
    - id: ac-1
      given: split project
      when: it is loaded
      then: the feature appears in the graph
`,
      );
      await fs.writeFile(
        manifestPath,
        `kynetic: "1.0"
project:
  name: transition-test
  version: "0.1.0"
includes:
  - modules/feature.yaml
`,
      );

      const afterSplit = logicalGraph(await loadAllItems(await initContext(projectDir)));

      expect(afterSplit).toEqual(beforeSplit);
    } finally {
      await cleanupTempDir(projectDir);
    }
  });

  // AC: @yaml-conventions ac-1
  // AC: @yaml-conventions ac-2
  it("round-trips ambiguous YAML values without changing their meaning", () => {
    const source = `kynetic: "1.0"
project:
  name: "Round Trip"
  version: "0.1.0"
flags:
  yes_string: "yes"
  no_string: "no"
  on_string: "on"
notes:
  literal: |
    line one

    line three
`;

    const parsed = parseYaml<{
      flags: Record<string, string>;
      notes: { literal: string };
    }>(source);
    const roundTripped = parseYaml<{
      flags: Record<string, string>;
      notes: { literal: string };
    }>(toYaml(parsed));

    expect(parsed.flags).toEqual({
      yes_string: "yes",
      no_string: "no",
      on_string: "on",
    });
    expect(roundTripped.flags).toEqual(parsed.flags);
    expect(roundTripped.notes.literal).toBe("line one\n\nline three\n");
  });

  // AC: @alignment-system ac-1
  // AC: @alignment-system ac-2
  it("builds bidirectional alignment links and exposes progress summaries", () => {
    const items: LoadedSpecItem[] = [
      {
        _ulid: "01KMB00000000000000000011",
        slugs: ["aligned-spec"],
        title: "Aligned Spec",
        type: "feature",
        description: "Spec with linked task",
        status: { maturity: "draft", implementation: "not_started" },
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        traits: [],
        notes: [],
      },
    ] as LoadedSpecItem[];
    const tasks: LoadedTask[] = [
      {
        _ulid: "01KMB00000000000000000022",
        slugs: ["task-aligned-spec"],
        title: "Implement aligned spec",
        type: "task",
        status: "in_progress",
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 2,
        tags: [],
        vcs_refs: [],
        created_at: "2026-03-11T00:00:00Z",
        notes: [],
        todos: [],
        spec_ref: "@aligned-spec",
      },
    ] as LoadedTask[];

    const refIndex = new ReferenceIndex(tasks, items);
    const alignment = new AlignmentIndex(tasks, items);
    alignment.buildLinks(refIndex);

    expect(alignment.getTasksForSpec("01KMB00000000000000000011").map((task) => task.title)).toEqual([
      "Implement aligned spec",
    ]);
    expect(alignment.getSpecForTask("01KMB00000000000000000022", refIndex)?.title).toBe(
      "Aligned Spec",
    );

    const summary = alignment.getImplementationSummary("01KMB00000000000000000011");
    expect(summary?.expectedStatus).toBe("in_progress");
    expect(summary?.linkedTasks[0]?.taskStatus).toBe("in_progress");
    expect(summary?.isAligned).toBe(false);
  });

  // AC: @format-version ac-1
  // AC: @spec-version ac-1
  it("preserves manifest format version and project version as separate fields", () => {
    const manifest = ManifestSchema.parse({
      kynetic: "2.0",
      project: {
        name: "Version Test",
        version: "1.2.3",
        status: "draft",
      },
    });

    expect(manifest.kynetic).toBe("2.0");
    expect(manifest.project.version).toBe("1.2.3");
  });

  // AC: @schema-ac-backfill ac-coverage
  it("keeps schema descendants free of missing acceptance criteria warnings", async () => {
    const ctx = await initContext(process.cwd());
    const items = await loadAllItems(ctx);
    const schemaItems = items.filter(
      (item) =>
        item._sourceFile?.endsWith(`${path.sep}schema.yaml`) &&
        (item.type === "feature" || item.type === "requirement"),
    );
    const result = await validate(ctx, { completeness: true });

    const warnings = result.completenessWarnings.filter(
      (warning) =>
        warning.type === "missing_acceptance_criteria" &&
        schemaItems.some((item) => warning.itemRef === `@${item.slugs[0]}` || warning.itemRef === `@${item._ulid}`),
    );

    expect(warnings).toEqual([]);
  });

  // AC: @schema-ac-backfill ac-testable
  // AC: @versioning ac-1
  // AC: @git-baselines ac-1
  // AC: @auto-adaptive-structure ac-1
  // AC: @auto-adaptive-structure ac-2
  it("keeps backfilled schema requirements specific and reviewable", async () => {
    const items = await loadAllItems(await initContext(process.cwd()));
    const versioning = requireItem(items, "@versioning");
    const gitBaselines = requireItem(items, "@git-baselines");
    const autoAdaptive = requireItem(items, "@auto-adaptive-structure");

    expect(versioning.acceptance_criteria?.[0]).toMatchObject({
      given: expect.stringContaining("format version"),
      when: expect.stringContaining("inspects the spec"),
      then: expect.stringContaining("historical comparison"),
    });

    expect(gitBaselines.implements).toContain("@versioning");
    expect(gitBaselines.acceptance_criteria?.[0]?.then).toContain(
      "comparison point for spec diffs",
    );

    expect(autoAdaptive.status?.implementation).toBe("not_started");
    expect(autoAdaptive.acceptance_criteria?.map((ac) => ac.when)).toEqual([
      "A user runs kspec split --suggest",
      "kspec split --apply runs",
    ]);

    for (const ref of [
      "@schema-ac-backfill",
      "@versioning",
      "@format-version",
      "@spec-version",
      "@git-baselines",
      "@auto-adaptive-structure",
    ]) {
      const item = requireItem(items, ref);
      expect(item.acceptance_criteria?.length).toBeGreaterThan(0);
      for (const ac of item.acceptance_criteria ?? []) {
        expect(ac.given.trim().split(/\s+/).length).toBeGreaterThanOrEqual(3);
        expect(ac.when.trim().split(/\s+/).length).toBeGreaterThanOrEqual(3);
        expect(ac.then.trim().split(/\s+/).length).toBeGreaterThanOrEqual(4);
      }
    }
  });
});
