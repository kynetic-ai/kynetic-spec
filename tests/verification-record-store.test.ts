/**
 * Per-AC verification record store tests.
 *
 * Covers @ac-verification-record-store:
 *   ac-keyed-by-canonical-identity, ac-stamp-read-back,
 *   ac-incomplete-stamp-rejected, ac-spec-source-untouched,
 *   ac-current-stamp-replacement, ac-versioned-persistence,
 *   ac-unresolvable-keys-tolerated.
 *
 * EXCLUDED from coverage scanning would not apply here — this file holds no
 * fixture `// AC:` annotation strings inside test bodies, only the real
 * annotations that map these tests to their criteria.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { initContext, loadAllItems, writeYamlFilePreserveFormat } from "../src/parser/yaml.js";
import { TraitIndex } from "../src/parser/traits.js";
import { ReferenceIndex } from "../src/parser/refs.js";
import { validate } from "../src/parser/validate.js";
import {
  getVerificationRecordPath,
  loadVerificationRecord,
  loadVerificationRecords,
  partitionVerificationReads,
  readVerificationStamp,
  writeVerificationStamp,
} from "../src/parser/verification-record-store.js";
import type { VerificationStampInput } from "../src/schema/verification-records.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  testUlid,
  testUlids,
} from "./helpers/cli.js";

const CLI_PATH = path.resolve(__dirname, "..", "dist", "cli", "index.js");
const canRunShadowTests = (() => {
  try {
    const version = execSync("git --version", { encoding: "utf-8" }).trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor] = match.map(Number);
    return (major > 2 || (major === 2 && minor >= 42)) && existsSync(CLI_PATH);
  } catch {
    return false;
  }
})();

/** A complete, valid stamp for round-trip and replacement tests. */
function validStamp(overrides: Partial<VerificationStampInput> = {}): VerificationStampInput {
  return {
    verified_at: "2026-06-10T12:00:00.000Z",
    actor: "pr-reviewer",
    provenance: "validation",
    ...overrides,
  };
}

/** A minimal spec item with the given AC ids. */
function makeItem(ulid: string, slug: string, acIds: string[]) {
  return {
    _ulid: ulid,
    title: `Item ${slug}`,
    slugs: [slug],
    type: "feature",
    description: "An item under verification.",
    acceptance_criteria: acIds.map((id) => ({
      id,
      given: "given",
      when: "when",
      then: "then",
    })),
  };
}

/** Build the live-criteria map directly from loaded items + traits. */
async function buildValidCriteria(tempDir: string) {
  const ctx = await initContext(tempDir, { syncMode: "skip" });
  const items = await loadAllItems(ctx);
  const index = new ReferenceIndex([], items, [], []);
  const traitIndex = new TraitIndex(items, index);
  const map = new Map<string, Set<string>>();
  for (const item of items) {
    const acIds = new Set<string>();
    for (const ac of item.acceptance_criteria ?? []) acIds.add(ac.id);
    for (const { ac } of traitIndex.getInheritedAC(item._ulid)) acIds.add(ac.id);
    map.set(item._ulid, acIds);
  }
  return map;
}

describe("verification record store (non-shadow)", () => {
  let tempDir: string;
  let specDir: string;
  let modulesDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-verif-store-");
    specDir = path.join(tempDir, "spec");
    modulesDir = path.join(specDir, "modules");
    await fs.mkdir(modulesDir, { recursive: true });
    initGitRepo(tempDir);
    await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
      project: { name: "verif-test" },
      includes: ["modules/specs.yaml"],
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function writeModule(file: string, items: unknown[]) {
    await writeYamlFilePreserveFormat(path.join(modulesDir, file), items);
  }

  // AC: @ac-verification-record-store ac-stamp-read-back
  it("writes a stamp and reads back the same verification time, actor, and provenance", async () => {
    const ulid = testUlid("ITEM", 1);
    await writeModule("specs.yaml", [makeItem(ulid, "feature-a", ["ac-one"])]);
    const ctx = await initContext(tempDir, { syncMode: "skip" });

    const written = await writeVerificationStamp(
      ctx,
      ulid,
      "ac-one",
      validStamp({ provenance: "ingestion", commit: "abc1234", session: testUlid("SESS", 2) }),
    );

    const read = await readVerificationStamp(ctx, ulid, "ac-one");
    expect(read).toBeDefined();
    expect(read?.verified_at).toBe("2026-06-10T12:00:00.000Z");
    expect(read?.actor).toBe("pr-reviewer");
    expect(read?.provenance).toBe("ingestion");
    expect(read?.commit).toBe("abc1234");
    expect(read).toEqual(written);
  });

  // AC: @ac-verification-record-store ac-incomplete-stamp-rejected
  it("rejects a stamp missing verified_at, actor, or provenance and leaves stored state unchanged", async () => {
    const ulid = testUlid("ITEM", 3);
    await writeModule("specs.yaml", [makeItem(ulid, "feature-b", ["ac-one"])]);
    const ctx = await initContext(tempDir, { syncMode: "skip" });

    // Seed a valid current stamp.
    await writeVerificationStamp(ctx, ulid, "ac-one", validStamp({ actor: "human-author" }));

    const missingActor = { verified_at: "2026-06-10T12:00:00.000Z", provenance: "validation" };
    const missingTime = { actor: "pr-reviewer", provenance: "validation" };
    const missingProvenance = { verified_at: "2026-06-10T12:00:00.000Z", actor: "pr-reviewer" };

    await expect(
      writeVerificationStamp(
        ctx,
        ulid,
        "ac-one",
        missingActor as unknown as VerificationStampInput,
      ),
    ).rejects.toThrow();
    await expect(
      writeVerificationStamp(ctx, ulid, "ac-one", missingTime as unknown as VerificationStampInput),
    ).rejects.toThrow();
    await expect(
      writeVerificationStamp(
        ctx,
        ulid,
        "ac-one",
        missingProvenance as unknown as VerificationStampInput,
      ),
    ).rejects.toThrow();

    // Stored state is unchanged — the original valid stamp survives.
    const read = await readVerificationStamp(ctx, ulid, "ac-one");
    expect(read?.actor).toBe("human-author");
    expect(read?.provenance).toBe("validation");
  });

  // AC: @ac-verification-record-store ac-keyed-by-canonical-identity
  it("keeps a stamp resolvable after a slug rename (ULID keying)", async () => {
    const ulid = testUlid("ITEM", 4);
    await writeModule("specs.yaml", [makeItem(ulid, "old-slug", ["ac-keep"])]);
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    await writeVerificationStamp(ctx, ulid, "ac-keep", validStamp());

    // Rename the slug; the ULID is unchanged.
    await writeModule("specs.yaml", [makeItem(ulid, "new-slug", ["ac-keep"])]);

    const records = await loadVerificationRecords(ctx);
    const { resolved, orphans } = partitionVerificationReads(
      records,
      await buildValidCriteria(tempDir),
    );
    expect(orphans).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ itemUlid: ulid, acId: "ac-keep" });
  });

  // AC: @ac-verification-record-store ac-keyed-by-canonical-identity
  it("keeps a stamp resolvable after the item moves to a different spec source file", async () => {
    const ulid = testUlid("ITEM", 5);
    // Manifest includes both module files so either may own the item.
    await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
      project: { name: "verif-test" },
      includes: ["modules/a.yaml", "modules/b.yaml"],
    });
    await writeModule("a.yaml", [makeItem(ulid, "movable", ["ac-move"])]);
    await writeModule("b.yaml", []);
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    await writeVerificationStamp(ctx, ulid, "ac-move", validStamp());

    // Move the item from a.yaml to b.yaml, same ULID.
    await writeModule("a.yaml", []);
    await writeModule("b.yaml", [makeItem(ulid, "movable", ["ac-move"])]);

    const records = await loadVerificationRecords(ctx);
    const { resolved, orphans } = partitionVerificationReads(
      records,
      await buildValidCriteria(tempDir),
    );
    expect(orphans).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ itemUlid: ulid, acId: "ac-move" });
  });

  // AC: @ac-verification-record-store ac-spec-source-untouched
  it("leaves every spec source file byte-identical across stamp writes", async () => {
    const [u1, u2] = testUlids("ITEM", 2);
    await writeModule("specs.yaml", [
      makeItem(u1, "feature-c", ["ac-x"]),
      makeItem(u2, "feature-d", ["ac-y"]),
    ]);
    const manifestPath = path.join(specDir, "kynetic.yaml");
    const modulePath = path.join(modulesDir, "specs.yaml");
    const moduleBefore = await fs.readFile(modulePath);
    const manifestBefore = await fs.readFile(manifestPath);

    const ctx = await initContext(tempDir, { syncMode: "skip" });
    await writeVerificationStamp(ctx, u1, "ac-x", validStamp());
    await writeVerificationStamp(ctx, u2, "ac-y", validStamp({ provenance: "re_verification" }));
    await writeVerificationStamp(ctx, u1, "ac-x", validStamp({ actor: "human-author" }));

    expect(await fs.readFile(modulePath)).toEqual(moduleBefore);
    expect(await fs.readFile(manifestPath)).toEqual(manifestBefore);
  });

  // AC: @ac-verification-record-store ac-current-stamp-replacement
  it("returns only the most recent stamp as the current verification", async () => {
    const ulid = testUlid("ITEM", 6);
    await writeModule("specs.yaml", [makeItem(ulid, "feature-e", ["ac-r"])]);
    const ctx = await initContext(tempDir, { syncMode: "skip" });

    await writeVerificationStamp(
      ctx,
      ulid,
      "ac-r",
      validStamp({ verified_at: "2026-06-01T00:00:00.000Z", actor: "first-actor" }),
    );
    await writeVerificationStamp(
      ctx,
      ulid,
      "ac-r",
      validStamp({ verified_at: "2026-06-10T00:00:00.000Z", actor: "second-actor" }),
    );

    const record = await loadVerificationRecord(ctx, ulid);
    // Exactly one current stamp per AC — the prior is not retained live.
    expect(Object.keys(record?.acs ?? {})).toEqual(["ac-r"]);
    expect(record?.acs["ac-r"].actor).toBe("second-actor");
    expect(record?.acs["ac-r"].verified_at).toBe("2026-06-10T00:00:00.000Z");
  });

  // AC: @ac-verification-record-store ac-unresolvable-keys-tolerated
  it("loads orphaned records without error and excludes them from resolved reads", async () => {
    const liveUlid = testUlid("ITEM", 7);
    const goneUlid = testUlid("GONE", 8);
    await writeModule("specs.yaml", [makeItem(liveUlid, "feature-f", ["ac-live"])]);
    const ctx = await initContext(tempDir, { syncMode: "skip" });

    // Resolvable stamp.
    await writeVerificationStamp(ctx, liveUlid, "ac-live", validStamp());
    // Orphan: item ULID no longer exists.
    await writeVerificationStamp(ctx, goneUlid, "ac-live", validStamp());
    // Orphan: AC id no longer exists on a live item.
    await writeVerificationStamp(ctx, liveUlid, "ac-removed", validStamp());

    const records = await loadVerificationRecords(ctx);
    expect(records.length).toBeGreaterThan(0); // load succeeded, nothing thrown

    const { resolved, orphans } = partitionVerificationReads(
      records,
      await buildValidCriteria(tempDir),
    );
    expect(resolved).toEqual([expect.objectContaining({ itemUlid: liveUlid, acId: "ac-live" })]);
    expect(orphans).toEqual(
      expect.arrayContaining([
        { itemUlid: goneUlid, acId: "ac-live", reason: "unknown_item" },
        { itemUlid: liveUlid, acId: "ac-removed", reason: "unknown_ac" },
      ]),
    );
    expect(orphans).toHaveLength(2);
  });

  // AC: @ac-verification-record-store ac-unresolvable-keys-tolerated
  it("reports orphaned stamps as completeness findings in validation", async () => {
    const liveUlid = testUlid("ITEM", 9);
    const goneUlid = testUlid("GONE", 10);
    await writeModule("specs.yaml", [makeItem(liveUlid, "feature-g", ["ac-live"])]);
    const ctx = await initContext(tempDir, { syncMode: "skip" });

    await writeVerificationStamp(ctx, liveUlid, "ac-live", validStamp());
    await writeVerificationStamp(ctx, goneUlid, "ac-removed", validStamp());

    const result = await validate(ctx, { completeness: true });
    const orphanFindings = result.completenessWarnings.filter(
      (w) => w.type === "orphaned_verification_record",
    );
    expect(orphanFindings).toHaveLength(1);
    expect(orphanFindings[0].message).toContain(goneUlid);
    // Validation as a whole does not throw on the orphan.
    expect(Array.isArray(result.completenessWarnings)).toBe(true);
  });
});

describe("verification record store (shadow versioned persistence)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-verif-shadow-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function setupShadowProject(dir: string): Promise<void> {
    initGitRepo(dir);
    await fs.writeFile(path.join(dir, "README.md"), "# Test", "utf-8");
    execSync('git add README.md && git commit -m "initial"', { cwd: dir, stdio: "pipe" });
    const result = kspec("init --no-prompt --setup", dir, {
      env: { CLAUDECODE: "1", KSPEC_AUTHOR: "@test" },
    });
    if (result.exitCode !== 0) {
      throw new Error(`kspec init --no-prompt --setup failed: ${result.stderr}`);
    }
  }

  function shadowShow(dir: string, relPath: string): string {
    return execSync(`git show kspec-meta:${relPath}`, {
      cwd: path.join(dir, ".kspec"),
      encoding: "utf-8",
    });
  }

  function shadowStatus(dir: string): string {
    return execSync("git status --porcelain", {
      cwd: path.join(dir, ".kspec"),
      encoding: "utf-8",
    }).trim();
  }

  function shadowFileLogCount(dir: string, relPath: string): number {
    const out = execSync(`git log --oneline -- ${relPath}`, {
      cwd: path.join(dir, ".kspec"),
      encoding: "utf-8",
    }).trim();
    return out === "" ? 0 : out.split("\n").length;
  }

  // AC: @ac-verification-record-store ac-versioned-persistence
  it.skipIf(!canRunShadowTests)(
    "commits each stamp write to the shadow branch so a fresh checkout reproduces it",
    async () => {
      await setupShadowProject(tempDir);
      const ctx = await initContext(tempDir, { syncMode: "skip" });
      expect(ctx.shadow?.enabled).toBe(true);

      const ulid = testUlid("ITEM", 11);
      await writeVerificationStamp(ctx, ulid, "ac-persist", validStamp({ commit: "deadbee" }));

      // Working tree of the shadow branch is clean — the write was committed.
      expect(shadowStatus(tempDir)).toBe("");

      // The committed blob (what a fresh checkout reproduces) carries the stamp.
      const rel = path.posix.join("coverage", "verifications", `${ulid}.yaml`);
      const committed = shadowShow(tempDir, rel);
      expect(committed).toContain("ac-persist");
      expect(committed).toContain("pr-reviewer");
      expect(committed).toContain("deadbee");

      // The file on disk also exists at the expected path.
      const onDisk = await fs.readFile(getVerificationRecordPath(ctx, ulid), "utf-8");
      expect(onDisk).toContain("ac-persist");
    },
  );

  // AC: @ac-verification-record-store ac-current-stamp-replacement
  it.skipIf(!canRunShadowTests)(
    "recovers a superseded stamp from shadow commit history, not the live record",
    async () => {
      await setupShadowProject(tempDir);
      const ctx = await initContext(tempDir, { syncMode: "skip" });

      const ulid = testUlid("ITEM", 12);
      const rel = path.posix.join("coverage", "verifications", `${ulid}.yaml`);

      await writeVerificationStamp(ctx, ulid, "ac-hist", validStamp({ actor: "first-actor" }));
      await writeVerificationStamp(ctx, ulid, "ac-hist", validStamp({ actor: "second-actor" }));

      // Live record holds only the current stamp.
      const live = await readVerificationStamp(ctx, ulid, "ac-hist");
      expect(live?.actor).toBe("second-actor");

      // Two commits touched the record file — supersession history is the
      // shadow commit history, not parallel live records.
      expect(shadowFileLogCount(tempDir, rel)).toBe(2);

      // The prior stamp is recoverable from history.
      const priorBlob = execSync(`git show kspec-meta~1:${rel}`, {
        cwd: path.join(tempDir, ".kspec"),
        encoding: "utf-8",
      });
      expect(priorBlob).toContain("first-actor");
    },
  );
});
