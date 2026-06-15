/**
 * CLI behaviour for `kspec review rebuild-index`.
 *
 * Covers the structured envelope and exit-code contract from
 * @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 * and @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  setupShadowDetection,
} from "./helpers/cli.js";

const projectCli = path.resolve(__dirname, "..", "dist", "cli", "index.js");
const canRunInit = existsSync(projectCli);

interface ProjectPaths {
  root: string;
  specDir: string;
}

async function bootstrapFolderProject(): Promise<ProjectPaths> {
  const root = await createTempDir();
  const specDir = path.join(root, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    yamlStringify({
      kynetic: "1.2",
      project: { name: "rebuild-index-test", version: "0.1.0" },
      default_module: "01MDAAAAAAAAAAAAAAAAAAAAAA",
      review_storage: { format: "folder" },
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(specDir, "kspec.config.yaml"),
    yamlStringify({ schema: { version: "1.0" } }),
    "utf-8",
  );
  // Minimal default module so loaders that consult modules don't choke.
  await fs.mkdir(path.join(specDir, "modules"), { recursive: true });
  await fs.writeFile(
    path.join(specDir, "modules", "core.yaml"),
    yamlStringify({
      kynetic_module: "1.0",
      module: { _ulid: "01MDAAAAAAAAAAAAAAAAAAAAAA", slug: "core", title: "Core" },
    }),
    "utf-8",
  );
  await setupShadowDetection(root);
  return { root, specDir };
}

async function writeReviewFolder(
  specDir: string,
  ulid: string,
  fields: { title: string; lifecycle?: string; createdAt?: string },
): Promise<void> {
  const reviewDir = path.join(specDir, "reviews", ulid);
  await fs.mkdir(reviewDir, { recursive: true });
  await fs.writeFile(
    path.join(reviewDir, "review.yaml"),
    yamlStringify({
      _ulid: ulid,
      slugs: [],
      title: fields.title,
      lifecycle_state: fields.lifecycle ?? "draft",
      subject: {
        type: "code",
        base_commit: "aaaa1111",
        head_commit: "bbbb2222",
      },
      author: "@tester",
      related_refs: [],
      threads: [],
      checks: [],
      verdicts: [],
      events: [],
      notes: [],
      external_links: [],
      examined_commit: null,
      created_at: fields.createdAt ?? "2026-05-23T10:00:00Z",
    }),
    "utf-8",
  );
}

async function writeIndex(specDir: string, entries: Array<Record<string, unknown>>): Promise<void> {
  await fs.writeFile(
    path.join(specDir, "project.reviews.yaml"),
    yamlStringify({ kynetic_reviews: "1.0", reviews: entries }),
    "utf-8",
  );
}

function makeIndexEntry(ulid: string, title: string): Record<string, unknown> {
  return {
    _ulid: ulid,
    slugs: [],
    title,
    lifecycle_state: "draft",
    author: "@tester",
    subject: { type: "code", base_commit: "aaaa1111", head_commit: "bbbb2222" },
    related_refs: [],
    created_at: "2026-05-23T10:00:00Z",
    disposition: "pending",
    thread_count: 0,
    unresolved_blocker_count: 0,
    check_count: 0,
    verdict_count: 0,
  };
}

describe("kspec review rebuild-index", () => {
  let root: string;
  let specDir: string;

  beforeEach(async () => {
    const project = await bootstrapFolderProject();
    root = project.root;
    specDir = project.specDir;
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  // AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("emits status=clean with exit 0 when folders and index agree", async () => {
    const ulid = "01CNAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, ulid, { title: "Clean Review" });
    await writeIndex(specDir, [makeIndexEntry(ulid, "Clean Review")]);

    const result = kspec("review rebuild-index --json", root);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.domain).toBe("reviews");
    expect(envelope.status).toBe("clean");
    expect(envelope.summary.folders).toBe(1);
    expect(envelope.summary.index_entries).toBe(1);
    expect(envelope.changes).toEqual([]);
    expect(envelope.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("emits status=drift with exit 1 when folder exists without index entry", async () => {
    const ulid = "01ADAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, ulid, { title: "Added" });

    const result = kspec("review rebuild-index --json", root, { expectFail: true });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("drift");
    expect(envelope.summary.added).toBe(1);
    expect(envelope.summary.updated).toBe(0);
    expect(envelope.changes).toHaveLength(1);
    expect(envelope.changes[0]).toMatchObject({ kind: "add", ref: ulid });
    expect(envelope.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("dry-run preserves the index even when drift exists", async () => {
    const ulid = "01DRAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, ulid, { title: "Dry Run" });

    const indexPath = path.join(specDir, "project.reviews.yaml");
    const before = await fs.readFile(indexPath, "utf-8").catch(() => "");

    const result = kspec("review rebuild-index --dry-run --json", root, { expectFail: true });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.dry_run).toBe(true);
    expect(envelope.status).toBe("drift");

    const after = await fs.readFile(indexPath, "utf-8").catch(() => "");
    expect(after).toBe(before);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("repair rewrites the index from folders and exits 0", async () => {
    const ulid = "01RPAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, ulid, { title: "Repaired" });

    const result = kspec("review rebuild-index --repair --json", root);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("repaired");
    expect(envelope.repair).toBe(true);
    expect(envelope.summary.added).toBe(1);

    const indexData = yamlParse(
      await fs.readFile(path.join(specDir, "project.reviews.yaml"), "utf-8"),
    ) as { reviews: Array<{ _ulid: string; title: string }> };
    expect(indexData.reviews).toHaveLength(1);
    expect(indexData.reviews[0]._ulid).toBe(ulid);
    expect(indexData.reviews[0].title).toBe("Repaired");
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("emits status=blocked with exit 2 when stale index entries lack --force", async () => {
    const staleUlid = "01STAAAAAAAAAAAAAAAAAAAAAA";
    await writeIndex(specDir, [makeIndexEntry(staleUlid, "Stale")]);

    const result = kspec("review rebuild-index --json", root, { expectFail: true });
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("blocked");
    expect(envelope.summary.conflicts).toBe(1);
    expect(envelope.conflicts).toHaveLength(1);
    expect(envelope.conflicts[0].code).toBe("stale_index_entry_without_force");
    expect(envelope.conflicts[0].ref).toBe(staleUlid);

    // No writes: the stale index entry must still be there.
    const indexData = yamlParse(
      await fs.readFile(path.join(specDir, "project.reviews.yaml"), "utf-8"),
    ) as { reviews: Array<{ _ulid: string }> };
    expect(indexData.reviews).toHaveLength(1);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("--force --repair drops stale index entries and rewrites the index", async () => {
    const staleUlid = "01SFAAAAAAAAAAAAAAAAAAAAAA";
    const keptUlid = "01KFAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, keptUlid, { title: "Kept" });
    await writeIndex(specDir, [
      makeIndexEntry(keptUlid, "Kept"),
      makeIndexEntry(staleUlid, "Stale"),
    ]);

    const result = kspec("review rebuild-index --repair --force --json", root);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("repaired");
    expect(envelope.force).toBe(true);
    expect(envelope.summary.removed_stale).toBe(1);

    const indexData = yamlParse(
      await fs.readFile(path.join(specDir, "project.reviews.yaml"), "utf-8"),
    ) as { reviews: Array<{ _ulid: string }> };
    expect(indexData.reviews).toHaveLength(1);
    expect(indexData.reviews[0]._ulid).toBe(keptUlid);
  });

  it("rejects --force without --repair", async () => {
    const result = kspec("review rebuild-index --force", root, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--force can only be used with --repair/);
  });

  // ── Repair Convergence ─────────────────────────────────────────────────────
  //
  // After `--repair` rewrites the index from authoritative folder content,
  // the immediate follow-up dry-run with no intervening mutation MUST
  // report no changes.

  // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
  it("repair followed by dry-run reports clean and exits 0", async () => {
    const ulid = "01CVAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, ulid, { title: "Converge" });
    const driftedEntry = makeIndexEntry(ulid, "Drifted Title");
    await writeIndex(specDir, [driftedEntry]);

    const repair = kspec("review rebuild-index --repair --json", root);
    expect(repair.exitCode).toBe(0);
    const repairEnvelope = JSON.parse(repair.stdout);
    expect(repairEnvelope.status).toBe("repaired");
    expect(repairEnvelope.summary.updated).toBe(1);

    const dryRun = kspec("review rebuild-index --dry-run --json", root);
    expect(dryRun.exitCode, `${dryRun.stderr || dryRun.stdout}`).toBe(0);
    const dryEnvelope = JSON.parse(dryRun.stdout);
    expect(dryEnvelope.status).toBe("clean");
    expect(dryEnvelope.changes).toEqual([]);
    expect(dryEnvelope.conflicts).toEqual([]);
  });

  // ── Semantic Defaults Do Not Drift ────────────────────────────────────────
  //
  // Reviews carry several optional collections (`external_links`,
  // `resource_summary`) that have an omitted-form vs explicit-empty-form
  // duality. The rebuild path MUST treat both forms as equal so the same
  // entry does not surface as drift on every dry-run.

  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  it("an index entry that omits external_links equals a folder with external_links: []", async () => {
    const ulid = "01EKAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, ulid, { title: "Empty Links Review" });
    // writeReviewFolder writes `external_links: []` in review.yaml.
    // makeIndexEntry omits external_links — these are the two canonical
    // empty forms and must compare equal.
    await writeIndex(specDir, [makeIndexEntry(ulid, "Empty Links Review")]);

    const result = kspec("review rebuild-index --dry-run --json", root);
    expect(result.exitCode, `${result.stderr || result.stdout}`).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("clean");
    expect(envelope.changes).toEqual([]);
    expect(envelope.summary.updated).toBe(0);
  });

  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  it("an index entry without resource_summary equals a folder with empty resources.yaml", async () => {
    const ulid = "01RSAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, ulid, { title: "Empty Resources Review" });
    // Empty resources manifest — rebuild will compute `{count:0, total_bytes:0}`.
    await fs.writeFile(
      path.join(specDir, "reviews", ulid, "resources.yaml"),
      yamlStringify({ resources: [] }),
      "utf-8",
    );
    // Index omits resource_summary entirely — the canonical bounded form
    // for a resourceless review. Drift detection must treat these as equal.
    await writeIndex(specDir, [makeIndexEntry(ulid, "Empty Resources Review")]);

    const result = kspec("review rebuild-index --dry-run --json", root);
    expect(result.exitCode, `${result.stderr || result.stdout}`).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("clean");
    expect(envelope.changes).toEqual([]);
    expect(envelope.summary.updated).toBe(0);
  });

  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  it("an index entry with resource_summary {count:0,total_bytes:0} equals an entry with the field omitted", async () => {
    const ulid = "01ZSAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, ulid, { title: "Zero Summary Review" });
    await fs.writeFile(
      path.join(specDir, "reviews", ulid, "resources.yaml"),
      yamlStringify({ resources: [] }),
      "utf-8",
    );
    const entry = { ...makeIndexEntry(ulid, "Zero Summary Review") };
    entry.resource_summary = { count: 0, total_bytes: 0 };
    await writeIndex(specDir, [entry]);

    const result = kspec("review rebuild-index --dry-run --json", root);
    expect(result.exitCode, `${result.stderr || result.stdout}`).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("clean");
    expect(envelope.changes).toEqual([]);
    expect(envelope.summary.updated).toBe(0);
  });

  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  it("subject key order does not surface as drift", async () => {
    const ulid = "01SBAAAAAAAAAAAAAAAAAAAAAA";
    await writeReviewFolder(specDir, ulid, { title: "Subject Order Review" });
    // makeIndexEntry uses { type, base_commit, head_commit } subject order.
    // Write the same logical subject in a different key order — the
    // canonical-order equality check must treat both as equal so
    // legacy-shaped index entries do not flag as drift after a YAML round
    // trip or schema-parse reshuffle.
    const entry = makeIndexEntry(ulid, "Subject Order Review");
    entry.subject = { head_commit: "bbbb2222", type: "code", base_commit: "aaaa1111" };
    await writeIndex(specDir, [entry]);

    const result = kspec("review rebuild-index --dry-run --json", root);
    expect(result.exitCode, `${result.stderr || result.stdout}`).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("clean");
    expect(envelope.changes).toEqual([]);
  });
});

// ── Post-Mutation Index Consistency via CLI ──────────────────────────────────
//
// These tests exercise the public CLI surface end-to-end: after a normal
// mutating command (review add, comment, check, verdict, close, reopen),
// an immediate `kspec review rebuild-index --dry-run` must report
// status=clean without any repair step. Rebuild-index is a recovery tool;
// normal mutators own keeping the bounded index consistent.
//
// AC: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder
// AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
// AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection

async function setupFolderInitProject(projectDir: string): Promise<void> {
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "initial"', {
    cwd: projectDir,
    stdio: "pipe",
  });
  const result = kspec("init --no-prompt", projectDir, {
    env: { KSPEC_AUTHOR: "@test" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${result.stderr}`);
  }
}

describe.runIf(canRunInit)("Integration: review rebuild-index post-mutation consistency", () => {
  let projectDir: string;
  const reviewSlug = "consistency-review";
  const reviewRef = `@${reviewSlug}`;

  beforeEach(async () => {
    projectDir = await createTempDir();
    await setupFolderInitProject(projectDir);
    const add = kspec(
      `review add --title "Consistency Review" --slug ${reviewSlug} --subject-type code --base abc123 --head def456`,
      projectDir,
    );
    if (add.exitCode !== 0) {
      throw new Error(`review add failed: ${add.stderr || add.stdout}`);
    }
  });

  afterEach(async () => {
    await cleanupTempDir(projectDir);
  });

  function expectCleanDryRun(label: string): void {
    const result = kspec("review rebuild-index --dry-run --json", projectDir);
    expect(result.exitCode, `${label}: ${result.stderr || result.stdout}`).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status, `${label}: status`).toBe("clean");
    expect(envelope.changes, `${label}: changes`).toEqual([]);
    expect(envelope.conflicts, `${label}: conflicts`).toEqual([]);
  }

  // AC: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder
  it("review add: a new review is indexed in the same mutation as the folder creation", () => {
    expectCleanDryRun("after review add");
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("review comment: adding a thread refreshes thread_count and disposition without leaving the index stale", () => {
    const result = kspec(
      `review comment ${reviewRef} --body "Initial blocker" --kind blocker`,
      projectDir,
    );
    expect(result.exitCode).toBe(0);
    expectCleanDryRun("after review comment");
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("review check: adding a check refreshes check_count without leaving the index stale", () => {
    const result = kspec(`review check ${reviewRef} --name lint --status pass`, projectDir);
    expect(result.exitCode).toBe(0);
    expectCleanDryRun("after review check");
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("review verdict: setting a verdict refreshes verdict_count/disposition/lifecycle_state without leaving the index stale", () => {
    const result = kspec(
      `review verdict ${reviewRef} --decision approve --reviewer @test`,
      projectDir,
    );
    expect(result.exitCode).toBe(0);
    expectCleanDryRun("after review verdict");
  });
});
