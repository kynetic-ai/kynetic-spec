/**
 * Historical actor normalization upgrade — behavioral tests.
 *
 * Fixtures are seeded with the measured actor-string variants from
 * plans/ui-redesign/analysis.md §4.6: the same codex agent recorded many ways
 * (`codex@openai.com`, `codex@local`, `codex@gpt-5`, `@codex`, `codex-reviewer`),
 * pr-reviewer recorded as `@dispatch`/`@kspec`/`@kspec-dispatch`, the human
 * author variants (`@claude`, `Test User`), and an unrecognized value
 * (`Hermes`). Every inventoried `normalize` field path is covered by at least
 * one seeded record.
 *
 * These tests run the real migration over a real on-disk kspec project and
 * re-load each record kind through its normal loader to assert the persisted
 * result — they exercise behavior, not source text.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as yaml from "yaml";

import {
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  kspec,
  kspecJson,
  testUlids,
} from "./helpers/cli.js";
import {
  initContext,
  loadInboxItems,
  loadTriageRecords,
  loadAllItems,
} from "../src/parser/index.js";
import {
  loadReviewRecordsFromFolders,
  saveReviewRecordToFolder,
} from "../src/parser/review-storage-manager.js";
import { loadPlansFromFolders, savePlanToFolder } from "../src/parser/plan-storage-manager.js";
import { resolveTaskDataManager } from "../src/parser/task-data-manager.js";
import { loadMetaContext, loadWorkflowRuns } from "../src/parser/meta.js";
import {
  ACTOR_FIELD_INVENTORY,
  ActorInventoryIncompleteError,
  assertInventoryCoversSchemas,
  collectSchemaActorFields,
  findUncoveredActorFields,
  looksLikeActorFieldName,
  normalizeFieldPathsFor,
} from "../src/parser/actor-field-inventory.js";
import {
  DEFAULT_UNKNOWN_ACTOR,
  OperatorActorMapError,
  loadOperatorActorMap,
  runActorNormalization,
} from "../src/parser/actor-normalization-migration.js";
import type { ActorIdentityConfig } from "../packages/shared/src/actor.ts";

const TS = "2026-01-01T00:00:00.000Z";

/**
 * Deterministic classifier config recognizing the measured variant families.
 * Passed explicitly so tests do not depend on a project's default agent roster.
 */
const CONFIG: ActorIdentityConfig = {
  human: {
    canonicalId: "Jacob Chapel",
    displayName: "Jacob Chapel",
    aliases: ["@claude", "Test User"],
  },
  agents: [
    { canonicalId: "codex", displayName: "Codex" },
    {
      canonicalId: "pr-reviewer",
      displayName: "PR Reviewer",
      aliases: ["@dispatch", "@kspec", "@kspec-dispatch"],
    },
  ],
};

async function initProject(tempDir: string): Promise<void> {
  initGitRepo(tempDir);
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n");
  execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: "pipe" });
  const result = kspec("init --no-prompt --setup", tempDir);
  if (result.exitCode !== 0) {
    throw new Error(`kspec init failed: ${result.stderr}`);
  }
}

/** Resolve the manifest base name (derived from the `<base>.meta.yaml` file). */
async function manifestBase(specDir: string): Promise<string> {
  const files = await fs.readdir(specDir);
  const metaFile = files.find((f) => f.endsWith(".meta.yaml"));
  if (!metaFile) {
    throw new Error(`No meta file found in ${specDir}`);
  }
  return metaFile.slice(0, -".meta.yaml".length);
}

/**
 * Seed one record per record kind, covering every inventoried `normalize`
 * field path with a measured variant. Returns the ULIDs used.
 */
async function seedVariants(tempDir: string): Promise<void> {
  const specDir = path.join(tempDir, ".kspec");
  const base = await manifestBase(specDir);
  const [
    revU,
    threadU,
    entryU,
    eventU,
    noteU,
    taskU,
    taskNoteU,
    inboxU,
    triageU,
    obsU,
    runU,
    specNoteU,
    planU,
    planNoteU,
  ] = testUlids("seed", 14);

  // A context for seeding folder-backed entities through their real save
  // paths (so the lean index entries are written and the partial-layout guard
  // stays satisfied).
  const seedCtx = await initContext(tempDir, { syncMode: "skip" });

  // ── Review (covers author, threads[].entries[].author, threads[].resolved_by,
  //    verdicts[].reviewer, events[].actor, notes[].author; runner out-of-scope) ──
  const review = {
    _ulid: revU,
    slugs: [],
    title: "Seeded review",
    lifecycle_state: "draft",
    subject: { type: "external", url: "https://example.com/pr/1" },
    author: "@claude",
    related_refs: [],
    threads: [
      {
        _ulid: threadU,
        kind: "blocker",
        entries: [{ _ulid: entryU, author: "codex@openai.com", body: "x", created_at: TS }],
        resolved_by: "@dispatch",
      },
    ],
    checks: [
      {
        name: "lint",
        status: "pass",
        runner: "vitest",
        applies_to_version: { type: "entity_version", content_hash: "abc" },
        created_at: TS,
      },
    ],
    verdicts: [
      {
        reviewer: "codex-reviewer",
        role: "reviewer",
        decision: "approve",
        applies_to_version: { type: "entity_version", content_hash: "abc" },
        created_at: TS,
      },
    ],
    events: [
      {
        _ulid: eventU,
        event_type: "verdict_submitted",
        actor: "codex@local",
        timestamp: TS,
        payload: {},
      },
    ],
    notes: [{ _ulid: noteU, created_at: TS, author: "Test User", content: "note" }],
    external_links: [],
    created_at: TS,
  };
  await saveReviewRecordToFolder(seedCtx, review as Parameters<typeof saveReviewRecordToFolder>[1]);

  // ── Task (covers notes[].author, todos[].added_by, assignee) ──
  const taskDir = path.join(specDir, "tasks", taskU);
  await fs.mkdir(taskDir, { recursive: true });
  const taskCore = {
    _ulid: taskU,
    slugs: ["seeded-task"],
    title: "Seeded task",
    type: "task",
    status: "pending",
    priority: 3,
    assignee: "Test User",
    todos: [{ id: 1, text: "do", done: false, added_at: TS, added_by: "@codex" }],
    created_at: TS,
  };
  await fs.writeFile(path.join(taskDir, "task.yaml"), yaml.stringify(taskCore));
  await fs.writeFile(
    path.join(taskDir, "notes.yaml"),
    yaml.stringify({
      notes: [{ _ulid: taskNoteU, created_at: TS, author: "codex@gpt-5", content: "n" }],
    }),
  );

  // ── Inbox (covers added_by) — loaded from the fixed project.inbox.yaml ──
  await fs.writeFile(
    path.join(specDir, "project.inbox.yaml"),
    yaml.stringify({
      inbox: [{ _ulid: inboxU, text: "idea", created_at: TS, tags: [], added_by: "@claude" }],
    }),
  );

  // ── Triage (covers decided_by, override_by) — fixed project.triage.yaml ──
  await fs.writeFile(
    path.join(specDir, "project.triage.yaml"),
    yaml.stringify({
      kynetic_triage: "1.0",
      triage: [
        {
          _ulid: triageU,
          inbox_ref: inboxU,
          item_snapshot: "idea",
          status: "triaged",
          action: "promote",
          reasoning: "ok",
          decided_by: "codex@openai",
          override_by: "@kspec",
          created_at: TS,
        },
      ],
    }),
  );

  // ── Observation (covers author, resolved_by) ──
  const metaPath = path.join(specDir, `${base}.meta.yaml`);
  const metaRaw = (yaml.parse(await fs.readFile(metaPath, "utf-8")) ?? {}) as Record<
    string,
    unknown
  >;
  metaRaw.observations = [
    {
      _ulid: obsU,
      type: "friction",
      content: "friction noted",
      created_at: TS,
      author: "@claude",
      resolved: true,
      resolution: "fixed",
      resolved_by: "codex-reviewer",
    },
  ];
  await fs.writeFile(metaPath, yaml.stringify(metaRaw));

  // ── Workflow run (covers initiated_by) ──
  await fs.writeFile(
    path.join(specDir, `${base}.runs.yaml`),
    yaml.stringify({
      kynetic_runs: "1.0",
      runs: [
        {
          _ulid: runU,
          workflow_ref: "@some-workflow",
          status: "active",
          current_step: 0,
          total_steps: 1,
          started_at: TS,
          step_results: [],
          initiated_by: "@codex",
        },
      ],
    }),
  );

  // ── Spec item (covers created_by, notes[].author) — set on the default module ──
  const modulePath = path.join(specDir, "modules", "main.yaml");
  const moduleRaw = yaml.parse(await fs.readFile(modulePath, "utf-8")) as Record<string, unknown>;
  moduleRaw.created_by = "Test User";
  moduleRaw.notes = [{ _ulid: specNoteU, created_at: TS, author: "@claude", content: "spec note" }];
  await fs.writeFile(modulePath, yaml.stringify(moduleRaw));

  // ── Plan (covers notes[].author) ──
  const plan = {
    _ulid: planU,
    slugs: ["seeded-plan"],
    title: "Seeded plan",
    content: "# Seeded plan\n",
    status: "draft",
    derived_tasks: [],
    derived_specs: [],
    created_at: TS,
    notes: [{ _ulid: planNoteU, created_at: TS, author: "@dispatch", content: "plan note" }],
  };
  await savePlanToFolder(seedCtx, plan as Parameters<typeof savePlanToFolder>[1]);
}

describe("actor-field inventory completeness (fail-closed guard)", () => {
  // AC: @actor-history-normalization ac-6 — every actor-bearing schema field is inventoried
  it("covers every actor-bearing field in the stored-record schemas", () => {
    expect(findUncoveredActorFields()).toEqual([]);
  });

  // AC: @actor-history-normalization ac-6 — guard discovers actor fields by schema reflection
  it("discovers the known actor-named fields across record kinds", () => {
    const found = collectSchemaActorFields().map((f) => `${f.recordKind}::${f.fieldPath}`);
    expect(found).toContain("review::author");
    expect(found).toContain("review::threads[].entries[].author");
    expect(found).toContain("review::verdicts[].reviewer");
    expect(found).toContain("task::todos[].added_by");
    expect(found).toContain("triage::decided_by");
    expect(found).toContain("observation::resolved_by");
    expect(found).toContain("spec_item::created_by");
    // Entity-ref fields that look actor-bearing by name are still discovered so
    // they must be classified (as out_of_scope) in the inventory.
    expect(found).toContain("task::blocked_by");
    expect(found).toContain("spec_item::superseded_by");
  });

  // AC: @actor-history-normalization ac-6 — fails closed when a field is unclassified
  it("reports and refuses when an actor-bearing field is missing from the inventory", () => {
    const incomplete = ACTOR_FIELD_INVENTORY.filter(
      (e) => !(e.recordKind === "triage" && e.fieldPath === "decided_by"),
    );
    const uncovered = findUncoveredActorFields(incomplete);
    expect(uncovered).toContainEqual({ recordKind: "triage", fieldPath: "decided_by" });
    expect(() => assertInventoryCoversSchemas(incomplete)).toThrow(ActorInventoryIncompleteError);
  });

  // AC: @actor-history-normalization ac-6 — out-of-scope fields carry an audit reason
  it("documents every out-of-scope field with a reason", () => {
    for (const entry of ACTOR_FIELD_INVENTORY) {
      if (entry.disposition === "out_of_scope") {
        expect(entry.reason, `${entry.recordKind}::${entry.fieldPath}`).toBeTruthy();
      }
    }
  });

  it("classifies actor-bearing field names with the heuristic", () => {
    expect(looksLikeActorFieldName("author")).toBe(true);
    expect(looksLikeActorFieldName("resolved_by")).toBe(true);
    expect(looksLikeActorFieldName("reviewer")).toBe(true);
    expect(looksLikeActorFieldName("assignee")).toBe(true);
    expect(looksLikeActorFieldName("title")).toBe(false);
    expect(looksLikeActorFieldName("created_at")).toBe(false);
  });
});

describe("actor normalization migration over a real project", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-actor-norm-");
    await initProject(tempDir);
    await seedVariants(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @actor-history-normalization ac-1 — recognizable variants → canonical identities
  // AC: @actor-history-normalization ac-5 — every inventoried field ends canonical-or-default
  // AC: @actor-identity-model ac-2 — historical records resolve once through the upgrade path
  it("rewrites recognizable historical variants to canonical identities across all record kinds", async () => {
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const report = await runActorNormalization(ctx, { config: CONFIG, now: TS });

    expect(report.rewriteCount).toBeGreaterThan(0);
    expect(report.recordsModified).toBeGreaterThan(0);

    // Re-load through the real loaders and assert canonical persisted values.
    const fresh = await initContext(tempDir, { syncMode: "skip" });

    const reviews = await loadReviewRecordsFromFolders(fresh);
    const review = reviews.find((r) => r.title === "Seeded review")!;
    expect(review.author).toBe("Jacob Chapel"); // @claude → human
    expect(review.threads[0].entries[0].author).toBe("codex"); // codex@openai.com → codex
    expect(review.threads[0].resolved_by).toBe("pr-reviewer"); // @dispatch → pr-reviewer
    expect(review.verdicts[0].reviewer).toBe("codex"); // codex-reviewer → codex
    expect(review.events[0].actor).toBe("codex"); // codex@local → codex
    expect(review.notes[0].author).toBe("Jacob Chapel"); // Test User → human
    expect(review.checks[0].runner).toBe("vitest"); // out of scope — untouched

    const manager = resolveTaskDataManager(fresh);
    const tasks = await manager.loadAllTasks(fresh);
    const task = tasks.find((t) => t.slugs.includes("seeded-task"))!;
    expect(task.assignee).toBe("Jacob Chapel"); // Test User → human
    expect(task.todos[0].added_by).toBe("codex"); // @codex → codex
    expect(task.notes[0].author).toBe("codex"); // codex@gpt-5 → codex

    const inbox = await loadInboxItems(fresh);
    expect(inbox[0].added_by).toBe("Jacob Chapel"); // @claude → human

    const triage = await loadTriageRecords(fresh);
    expect(triage[0].decided_by).toBe("codex"); // codex@openai → codex
    expect(triage[0].override_by).toBe("pr-reviewer"); // @kspec → pr-reviewer

    const meta = await loadMetaContext(fresh);
    const obs = meta.observations.find((o) => o.content === "friction noted")!;
    expect(obs.author).toBe("Jacob Chapel"); // @claude → human
    expect(obs.resolved_by).toBe("codex"); // codex-reviewer → codex

    const runs = await loadWorkflowRuns(fresh);
    expect(runs[0].initiated_by).toBe("codex"); // @codex → codex

    const items = await loadAllItems(fresh);
    const moduleItem = items.find((i) => i.slugs.includes("main"))!;
    expect(moduleItem.created_by).toBe("Jacob Chapel"); // Test User → human
    expect(moduleItem.notes?.[0].author).toBe("Jacob Chapel"); // @claude → human

    const plans = await loadPlansFromFolders(fresh);
    const plan = plans.find((p) => p.slugs.includes("seeded-plan"))!;
    expect(plan.notes[0].author).toBe("pr-reviewer"); // @dispatch → pr-reviewer

    // ac-5 — re-running the resolver over the normalized corpus finds nothing
    // left to change: every value is now canonical or a declared default.
    const verify = await runActorNormalization(fresh, { config: CONFIG, dryRun: true, now: TS });
    expect(verify.rewriteCount).toBe(0);
  });

  // AC: @actor-history-normalization ac-2 — unresolved value → declared default, original in report
  it("falls back to the declared default actor for unresolved values and reports the original", async () => {
    // Inject an unrecognized actor value into the inbox item.
    const specDir = path.join(tempDir, ".kspec");
    const inboxPath = path.join(specDir, "project.inbox.yaml");
    const inbox = yaml.parse(await fs.readFile(inboxPath, "utf-8")) as {
      inbox: Record<string, unknown>[];
    };
    inbox.inbox[0].added_by = "Hermes";
    await fs.writeFile(inboxPath, yaml.stringify(inbox));

    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const report = await runActorNormalization(ctx, { config: CONFIG, now: TS });

    const hermesRewrite = report.rewrites.find((r) => r.original === "Hermes");
    expect(hermesRewrite).toBeDefined();
    expect(hermesRewrite!.resolved).toBe(DEFAULT_UNKNOWN_ACTOR);
    expect(hermesRewrite!.resolutionSource).toBe("default");
    expect(report.unresolvedOriginals).toContain("Hermes");

    const fresh = await initContext(tempDir, { syncMode: "skip" });
    const reloaded = await loadInboxItems(fresh);
    expect(reloaded[0].added_by).toBe(DEFAULT_UNKNOWN_ACTOR);
  });

  // AC: @actor-history-normalization ac-2 — operator mapping resolves ambiguous values before the default
  it("applies an operator-provided mapping after the variant map and before the default", async () => {
    const specDir = path.join(tempDir, ".kspec");
    const inboxPath = path.join(specDir, "project.inbox.yaml");
    const inbox = yaml.parse(await fs.readFile(inboxPath, "utf-8")) as {
      inbox: Record<string, unknown>[];
    };
    inbox.inbox[0].added_by = "Hermes";
    await fs.writeFile(inboxPath, yaml.stringify(inbox));

    const mapPath = path.join(tempDir, "actor-map.yaml");
    await fs.writeFile(mapPath, yaml.stringify({ mappings: { Hermes: "codex" } }));

    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const report = await runActorNormalization(ctx, {
      config: CONFIG,
      operatorMapPath: mapPath,
      now: TS,
    });

    const hermesRewrite = report.rewrites.find((r) => r.original === "Hermes")!;
    expect(hermesRewrite.resolved).toBe("codex");
    expect(hermesRewrite.resolutionSource).toBe("operator_mapping");
    expect(report.unresolvedOriginals).not.toContain("Hermes");

    const fresh = await initContext(tempDir, { syncMode: "skip" });
    const reloaded = await loadInboxItems(fresh);
    expect(reloaded[0].added_by).toBe("codex");
  });

  // AC: @actor-history-normalization ac-1 — recognizable operator mapping targets resolve to canonical
  it("normalizes a recognizable operator mapping target alias to its canonical id", async () => {
    const specDir = path.join(tempDir, ".kspec");
    const inboxPath = path.join(specDir, "project.inbox.yaml");
    const inbox = yaml.parse(await fs.readFile(inboxPath, "utf-8")) as {
      inbox: Record<string, unknown>[];
    };
    inbox.inbox[0].added_by = "Hermes";
    await fs.writeFile(inboxPath, yaml.stringify(inbox));

    // Target is the alias `@codex`, not the canonical id `codex` — the resolver
    // must reduce it to the canonical identity before writing.
    const mapPath = path.join(tempDir, "actor-map.yaml");
    await fs.writeFile(mapPath, yaml.stringify({ mappings: { Hermes: "@codex" } }));

    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const report = await runActorNormalization(ctx, {
      config: CONFIG,
      operatorMapPath: mapPath,
      now: TS,
    });

    const hermesRewrite = report.rewrites.find((r) => r.original === "Hermes")!;
    expect(hermesRewrite.resolved).toBe("codex");
    expect(hermesRewrite.resolutionSource).toBe("operator_mapping");

    const fresh = await initContext(tempDir, { syncMode: "skip" });
    const reloaded = await loadInboxItems(fresh);
    expect(reloaded[0].added_by).toBe("codex");
  });

  // AC: @actor-history-normalization ac-5 — every inventoried field ends canonical-or-default
  // AC: @actor-history-normalization ac-3 — a non-canonical target would break idempotency, so it is rejected
  it("fails closed when an operator mapping target is not a canonical identity, modifying nothing", async () => {
    const specDir = path.join(tempDir, ".kspec");
    const inboxPath = path.join(specDir, "project.inbox.yaml");
    const inbox = yaml.parse(await fs.readFile(inboxPath, "utf-8")) as {
      inbox: Record<string, unknown>[];
    };
    inbox.inbox[0].added_by = "Hermes";
    await fs.writeFile(inboxPath, yaml.stringify(inbox));

    const mapPath = path.join(tempDir, "actor-map.yaml");
    await fs.writeFile(mapPath, yaml.stringify({ mappings: { Hermes: "not-a-real-actor" } }));

    const before = await snapshotDir(specDir);

    const ctx = await initContext(tempDir, { syncMode: "skip" });
    await expect(
      runActorNormalization(ctx, { config: CONFIG, operatorMapPath: mapPath, now: TS }),
    ).rejects.toThrow(OperatorActorMapError);

    // No record was rewritten — the bad value never reached storage.
    const after = await snapshotDir(specDir);
    expect(after).toEqual(before);
    const fresh = await initContext(tempDir, { syncMode: "skip" });
    const reloaded = await loadInboxItems(fresh);
    expect(reloaded[0].added_by).toBe("Hermes");
  });

  // AC: @actor-history-normalization ac-2 — routing a value to a declared default sentinel is allowed
  it("allows an operator mapping target that is a declared default sentinel", async () => {
    const specDir = path.join(tempDir, ".kspec");
    const inboxPath = path.join(specDir, "project.inbox.yaml");
    const inbox = yaml.parse(await fs.readFile(inboxPath, "utf-8")) as {
      inbox: Record<string, unknown>[];
    };
    inbox.inbox[0].added_by = "Hermes";
    await fs.writeFile(inboxPath, yaml.stringify(inbox));

    const mapPath = path.join(tempDir, "actor-map.yaml");
    await fs.writeFile(mapPath, yaml.stringify({ mappings: { Hermes: DEFAULT_UNKNOWN_ACTOR } }));

    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const report = await runActorNormalization(ctx, {
      config: CONFIG,
      operatorMapPath: mapPath,
      now: TS,
    });

    const hermesRewrite = report.rewrites.find((r) => r.original === "Hermes")!;
    expect(hermesRewrite.resolved).toBe(DEFAULT_UNKNOWN_ACTOR);

    const fresh = await initContext(tempDir, { syncMode: "skip" });
    const reloaded = await loadInboxItems(fresh);
    expect(reloaded[0].added_by).toBe(DEFAULT_UNKNOWN_ACTOR);
  });

  // AC: @actor-history-normalization ac-4 — preview mode reports rewrites and modifies nothing
  it("dry-run reports the rewrites it would perform without modifying any record", async () => {
    const ctx = await initContext(tempDir, { syncMode: "skip" });

    const reviewPath = path.join(tempDir, ".kspec", "reviews");
    const before = await snapshotDir(reviewPath);

    const report = await runActorNormalization(ctx, { config: CONFIG, dryRun: true, now: TS });
    expect(report.dryRun).toBe(true);
    expect(report.rewriteCount).toBeGreaterThan(0);
    expect(report.recordsModified).toBe(0);

    // On-disk review unchanged.
    const after = await snapshotDir(reviewPath);
    expect(after).toEqual(before);

    const fresh = await initContext(tempDir, { syncMode: "skip" });
    const reviews = await loadReviewRecordsFromFolders(fresh);
    expect(reviews[0].author).toBe("@claude"); // still the original variant
  });

  // AC: @actor-history-normalization ac-3 — re-running on a normalized project changes nothing
  it("is idempotent: a second run rewrites nothing", async () => {
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const first = await runActorNormalization(ctx, { config: CONFIG, now: TS });
    expect(first.rewriteCount).toBeGreaterThan(0);

    const afterFirst = await snapshotDir(path.join(tempDir, ".kspec"));

    const fresh = await initContext(tempDir, { syncMode: "skip" });
    const second = await runActorNormalization(fresh, { config: CONFIG, now: TS });
    expect(second.rewriteCount).toBe(0);
    expect(second.recordsModified).toBe(0);

    const afterSecond = await snapshotDir(path.join(tempDir, ".kspec"));
    expect(afterSecond).toEqual(afterFirst);
  });

  it("covers at least one fixture for every inventoried normalize field path", async () => {
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const report = await runActorNormalization(ctx, { config: CONFIG, dryRun: true, now: TS });

    // Every record kind that has normalize fields must have produced at least
    // one rewrite from the seeded fixtures.
    const kindsWithNormalizeFields = [
      ...new Set(
        ACTOR_FIELD_INVENTORY.filter((e) => e.disposition === "normalize").map((e) => e.recordKind),
      ),
    ];
    const kindsInReport = new Set(report.rewrites.map((r) => r.recordKind));
    for (const kind of kindsWithNormalizeFields) {
      expect(kindsInReport.has(kind), `expected a seeded rewrite for record kind ${kind}`).toBe(
        true,
      );
      expect(normalizeFieldPathsFor(kind).length).toBeGreaterThan(0);
    }
  });
});

describe("operator actor-map loading", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-actor-map-");
  });
  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("rejects a malformed operator mapping file", async () => {
    const mapPath = path.join(tempDir, "bad-map.yaml");
    await fs.writeFile(mapPath, yaml.stringify({ mappings: { Hermes: "" } }));
    await expect(loadOperatorActorMap(mapPath)).rejects.toThrow(/non-empty string/);
  });

  it("parses mappings and per-record-kind defaults", async () => {
    const mapPath = path.join(tempDir, "map.yaml");
    await fs.writeFile(
      mapPath,
      yaml.stringify({ mappings: { Hermes: "codex" }, defaults: { review: "@anon" } }),
    );
    const loaded = await loadOperatorActorMap(mapPath);
    expect(loaded.mappings.Hermes).toBe("codex");
    expect(loaded.defaults?.review).toBe("@anon");
  });
});

describe("kspec upgrade integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-actor-upgrade-");
    await initProject(tempDir);
    // Configure identity so the default-roster classifier recognizes the seeded
    // variants without depending on hand-injected config in every record.
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      yaml.stringify({
        identity: {
          author: "Jacob Chapel",
          aliases: ["@claude"],
          agent_aliases: { "pr-reviewer": ["@dispatch"] },
        },
      }),
    );
    await seedVariants(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @actor-history-normalization ac-4 — `kspec upgrade --dry-run` previews without writing
  it("previews actor normalization under --dry-run without modifying records", async () => {
    const result = kspecJson<{
      steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
    }>("upgrade --dry-run --force", tempDir);
    const step = result.steps.find((s) => s.name === "Historical actor normalization")!;
    expect(step).toBeDefined();
    expect(step.status).toBe("done");
    expect(step.details?.rewrite_count as number).toBeGreaterThan(0);

    // Review still holds the original variant — dry-run wrote nothing.
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const reviews = await loadReviewRecordsFromFolders(ctx);
    expect(reviews[0].author).toBe("@claude");
  });

  // AC: @actor-history-normalization ac-1 — real upgrade rewrites and writes a durable report
  // AC: @actor-history-normalization ac-3 — a second upgrade run is a no-op for actor fields
  it("rewrites actor fields, writes a report artifact, and is idempotent on re-run", async () => {
    const first = kspecJson<{
      steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
    }>("upgrade --force", tempDir);
    const firstStep = first.steps.find((s) => s.name === "Historical actor normalization")!;
    expect(firstStep.status).toBe("done");
    expect(firstStep.details?.rewrite_count as number).toBeGreaterThan(0);

    const reportPath = firstStep.details?.report_path as string;
    expect(reportPath).toBeTruthy();
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reads the migration's own generated report artifact
    const reportRaw = await fs.readFile(reportPath, "utf-8");
    const reportJson = JSON.parse(reportRaw) as { rewrites: unknown[]; generatedAt: string };
    expect(reportJson.rewrites.length).toBeGreaterThan(0);
    expect(reportJson.generatedAt).toBeTruthy();

    // Canonical persisted value. The thread resolver maps the configured
    // agent alias `@dispatch` → `pr-reviewer` deterministically (independent of
    // how the human identity resolves in the subprocess environment), and the
    // human-variant author `@claude` is no longer the raw historical string.
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const reviews = await loadReviewRecordsFromFolders(ctx);
    expect(reviews[0].threads[0].resolved_by).toBe("pr-reviewer");
    expect(reviews[0].author).not.toBe("@claude");

    // Second run: no actor fields left to rewrite.
    const second = kspecJson<{
      steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
    }>("upgrade --force", tempDir);
    const secondStep = second.steps.find((s) => s.name === "Historical actor normalization")!;
    expect(secondStep.status).toBe("skipped");
    expect(secondStep.details?.rewrite_count as number).toBe(0);
  });
});

describe("kspec upgrade dry-run on a not-yet-promoted (legacy) project", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-actor-legacy-");
    await initProject(tempDir);
    // Identity so the default-roster classifier recognizes `@claude` as the
    // human author without hand-injected per-record config.
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      yaml.stringify({ identity: { author: "Jacob Chapel", aliases: ["@claude"] } }),
    );

    // Seed a recognizable variant on the default module — a spec_item, whose
    // loader is storage-format-agnostic and so readable even before promotion.
    const modulePath = path.join(tempDir, ".kspec", "modules", "main.yaml");
    const moduleRaw = yaml.parse(await fs.readFile(modulePath, "utf-8")) as Record<string, unknown>;
    moduleRaw.created_by = "@claude";
    await fs.writeFile(modulePath, yaml.stringify(moduleRaw));

    // Reproduce the reviewer's legacy layout: strip the folder-backed plan and
    // review storage declarations so the project is no longer fully promoted.
    // This is exactly the state where the prior implementation skipped the
    // actor preview entirely.
    const specDir = path.join(tempDir, ".kspec");
    const base = await manifestBase(specDir);
    const manifestPath = path.join(specDir, `${base}.yaml`);
    const manifest = yaml.parse(await fs.readFile(manifestPath, "utf-8")) as Record<
      string,
      unknown
    >;
    delete manifest.plan_storage;
    delete manifest.review_storage;
    await fs.writeFile(manifestPath, yaml.stringify(manifest));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @actor-history-normalization ac-4 — preview reports rewrites even before
  //   storage promotion, instead of skipping the whole step
  it("previews actor rewrites and modifies nothing, deferring kinds it cannot read yet", async () => {
    const modulePath = path.join(tempDir, ".kspec", "modules", "main.yaml");
    const before = await fs.readFile(modulePath, "utf-8");

    const result = kspecJson<{
      steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
    }>("upgrade --dry-run --force", tempDir);

    const step = result.steps.find((s) => s.name === "Historical actor normalization")!;
    expect(step).toBeDefined();
    // Previously this returned `skipped` on a not-yet-promoted project.
    expect(step.status).toBe("done");
    expect(step.details?.rewrite_count as number).toBeGreaterThan(0);

    // The spec-item variant is previewed: original recorded, rewritten away from
    // the raw historical string.
    const rewrites = step.details?.rewrites as Array<{
      recordKind: string;
      original: string;
      resolved: string;
    }>;
    const specRewrite = rewrites.find(
      (r) => r.recordKind === "spec_item" && r.original === "@claude",
    );
    expect(specRewrite).toBeDefined();
    expect(specRewrite!.resolved).not.toBe("@claude");

    // Reviews and plans cannot be read on the un-promoted manifest, so they are
    // deferred (surfaced) rather than silently dropped or crashing the preview.
    const deferred = (step.details?.deferred_kinds as Array<{ recordKind: string }>) ?? [];
    const deferredKinds = new Set(deferred.map((d) => d.recordKind));
    expect(deferredKinds.has("review")).toBe(true);
    expect(deferredKinds.has("plan")).toBe(true);

    // Dry-run wrote nothing.
    const after = await fs.readFile(modulePath, "utf-8");
    expect(after).toBe(before);
  });
});

/** Read every file under a directory into a path→content map for diffing. */
async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- snapshots temp-project record files to assert the migration left them byte-for-byte unchanged
        out[full] = await fs.readFile(full, "utf-8");
      }
    }
  }
  await walk(dir);
  return out;
}
