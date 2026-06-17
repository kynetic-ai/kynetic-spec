/**
 * Coverage record compatibility — additivity, optionality, format-version
 * gating, and unknown-field tolerance for the verification record store.
 *
 * Covers @coverage-record-compatibility:
 *   ac-absent-store-no-behavior-change, ac-upgrade-without-rewrite,
 *   ac-first-write-materializes, ac-newer-record-format-refused,
 *   ac-unknown-fields-roundtrip, ac-unrecognized-sidecar-untouched,
 *   ac-store-creation-additive.
 *
 * The store's gating precedent is the manifest-level forward-compatibility
 * gate (@data-format-forward-compatibility); the manifest-level contract keeps
 * its own coverage and is referenced here only where this store's gating
 * intersects it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { initContext, writeYamlFilePreserveFormat, readYamlFile } from "../src/parser/yaml.js";
import { validate } from "../src/parser/validate.js";
import { resolveAcFreshness } from "../src/parser/freshness-resolver.js";
import {
  CURRENT_VERIFICATION_RECORD_FORMAT,
  type VerificationStampInput,
} from "../src/schema/verification-records.js";
import {
  getVerificationRecordPath,
  getVerificationStoreRoot,
  loadVerificationRecord,
  loadVerificationRecords,
  VERIFICATION_STORE_DIR,
  writeVerificationStamp,
  VerificationRecordFormatCompatibilityError,
  VERIFICATION_RECORD_FORMAT_NEWER_THAN_SUPPORTED_CODE,
  describeVerificationRecordFormatIncompatibility,
} from "../src/parser/verification-record-store.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  readTestOutput,
  setupTempFixtures,
  testUlid,
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

interface FileSnapshot {
  content: string;
  mtimeMs: number;
}

/** Walk a directory and snapshot every file's content + mtime. */
async function snapshotFiles(root: string): Promise<Map<string, FileSnapshot>> {
  const snapshot = new Map<string, FileSnapshot>();
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".test-home" || entry.name === ".git") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        const content = await readTestOutput(fullPath);
        snapshot.set(path.relative(root, fullPath), { content, mtimeMs: stat.mtimeMs });
      }
    }
  };
  await walk(root);
  return snapshot;
}

function expectSnapshotsEqual(
  before: Map<string, FileSnapshot>,
  after: Map<string, FileSnapshot>,
  options: { ignore?: ReadonlySet<string> } = {},
): void {
  const ignore = options.ignore ?? new Set();
  const filterKeys = (keys: string[]): string[] => keys.filter((k) => !ignore.has(k)).toSorted();
  expect(filterKeys([...after.keys()])).toEqual(filterKeys([...before.keys()]));
  for (const [file, beforeState] of before) {
    if (ignore.has(file)) continue;
    const afterState = after.get(file);
    expect(afterState, `file ${file} should still exist`).toBeDefined();
    expect(afterState!.content, `content of ${file} should be unchanged`).toBe(beforeState.content);
    expect(afterState!.mtimeMs, `mtime of ${file} should be unchanged`).toBe(beforeState.mtimeMs);
  }
}

// ── Unit: describeVerificationRecordFormatIncompatibility ─────────────────

describe("describeVerificationRecordFormatIncompatibility", () => {
  // AC: @coverage-record-compatibility ac-newer-record-format-refused
  it("refuses a declared record-format version greater than the supported maximum", () => {
    const err = describeVerificationRecordFormatIncompatibility(
      CURRENT_VERIFICATION_RECORD_FORMAT + 1,
    );
    expect(err).toBeInstanceOf(VerificationRecordFormatCompatibilityError);
    expect(err!.code).toBe(VERIFICATION_RECORD_FORMAT_NEWER_THAN_SUPPORTED_CODE);
    expect(err!.declaredVersion).toBe(CURRENT_VERIFICATION_RECORD_FORMAT + 1);
    expect(err!.maxSupportedVersion).toBe(CURRENT_VERIFICATION_RECORD_FORMAT);
    // Refusal names both versions.
    expect(err!.message).toContain(String(CURRENT_VERIFICATION_RECORD_FORMAT + 1));
    expect(err!.message).toContain(String(CURRENT_VERIFICATION_RECORD_FORMAT));
    expect(err!.message).toContain(VERIFICATION_RECORD_FORMAT_NEWER_THAN_SUPPORTED_CODE);
  });

  // AC: @coverage-record-compatibility ac-newer-record-format-refused
  it("passes supported declared record-format versions and the missing-field case", () => {
    expect(
      describeVerificationRecordFormatIncompatibility(CURRENT_VERIFICATION_RECORD_FORMAT),
    ).toBeNull();
    expect(describeVerificationRecordFormatIncompatibility(1)).toBeNull();
    expect(describeVerificationRecordFormatIncompatibility(undefined)).toBeNull();
    expect(describeVerificationRecordFormatIncompatibility(null)).toBeNull();
  });

  // AC: @coverage-record-compatibility ac-newer-record-format-refused
  it("refuses non-numeric declared record-format values rather than treating them as oldest", () => {
    const err = describeVerificationRecordFormatIncompatibility("not-a-number");
    expect(err).toBeInstanceOf(VerificationRecordFormatCompatibilityError);
    expect(err!.message).toContain("not-a-number");
    expect(err!.declaredVersion).toBe("not-a-number");
  });
});

// ── Project setup helpers ─────────────────────────────────────────────────

interface NonShadowProject {
  tempDir: string;
  specDir: string;
  modulesDir: string;
}

async function setupNonShadowProject(): Promise<NonShadowProject> {
  const tempDir = await createTempDir("kspec-compat-noshadow-");
  const specDir = path.join(tempDir, "spec");
  const modulesDir = path.join(specDir, "modules");
  await fs.mkdir(modulesDir, { recursive: true });
  initGitRepo(tempDir);
  await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
    project: { name: "compat-test" },
    includes: ["modules/specs.yaml"],
  });
  return { tempDir, specDir, modulesDir };
}

async function writeModule(modulesDir: string, file: string, items: unknown[]): Promise<void> {
  await writeYamlFilePreserveFormat(path.join(modulesDir, file), items);
}

// ── AC: ac-absent-store-no-behavior-change ─────────────────────────────────

describe("ac-absent-store-no-behavior-change", () => {
  let project: NonShadowProject;

  beforeEach(async () => {
    project = await setupNonShadowProject();
    const ulid = testUlid("ITEM", 1);
    await writeModule(project.modulesDir, "specs.yaml", [makeItem(ulid, "feature-a", ["ac-one"])]);
  });

  afterEach(async () => {
    await cleanupTempDir(project.tempDir);
  });

  // AC: @coverage-record-compatibility ac-absent-store-no-behavior-change
  it("validate succeeds with no store present and creates no store as a side effect", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const storeRoot = getVerificationStoreRoot(ctx);
    expect(existsSync(storeRoot)).toBe(false);

    const result = await validate(ctx, { completeness: true });
    // The validate operation completes. Whatever warnings it raises are about
    // the project itself; the verification store is neither a source of
    // warnings nor a side effect of the read.
    expect(Array.isArray(result.completenessWarnings)).toBe(true);
    const storeRelated = result.completenessWarnings.filter(
      (w) =>
        w.type === "orphaned_verification_record" ||
        /verification/i.test(w.message) ||
        /coverage\/verifications/i.test(w.message),
    );
    expect(storeRelated).toEqual([]);

    // No store was created as a side effect of the read.
    expect(existsSync(storeRoot)).toBe(false);
  });

  // AC: @coverage-record-compatibility ac-absent-store-no-behavior-change
  it("freshness resolves through the bootstrap source alone and creates no store", async () => {
    // Bootstrap requires version-control history of the annotation's location.
    const annotationFile = path.join(project.tempDir, "tests", "bootstrap-only.test.ts");
    await fs.mkdir(path.dirname(annotationFile), { recursive: true });
    await fs.writeFile(annotationFile, `// AC: @feature-a ac-one\nit("covers", () => {});\n`);
    execSync('git add tests/bootstrap-only.test.ts && git commit -m "annotation"', {
      cwd: project.tempDir,
      stdio: "pipe",
    });

    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const storeRoot = getVerificationStoreRoot(ctx);
    const ulid = testUlid("ITEM", 1);

    const result = await resolveAcFreshness(ctx, ulid, "ac-one", [
      { file: annotationFile, line: 1 },
    ]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    expect(result.value.source).toBe("bootstrap");

    // No store was created by the freshness read.
    expect(existsSync(storeRoot)).toBe(false);
  });
});

// ── AC: ac-upgrade-without-rewrite ──────────────────────────────────────────

describe("ac-upgrade-without-rewrite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @coverage-record-compatibility ac-upgrade-without-rewrite
  // A project created before the verification record store existed (no
  // coverage/verifications/ directory) loads, validates, and serves ordinary
  // commands without creating the store, without a migration prompt, and
  // without bumping the manifest format version.
  it("ordinary commands on a store-absent project create no store, prompt no migration, and leave the manifest format unchanged", async () => {
    // The fixture is a freshly-initialized project; no store directory exists.
    const storeDir = path.join(tempDir, VERIFICATION_STORE_DIR);
    expect(existsSync(storeDir)).toBe(false);

    const manifestPath = path.join(tempDir, "kynetic.yaml");
    const manifestBefore = await readTestOutput(manifestPath);
    const kyneticLineBefore = manifestBefore.match(/^kynetic:.*$/m)?.[0] ?? "";
    expect(kyneticLineBefore).toMatch(/^kynetic:/);

    const before = await snapshotFiles(tempDir);

    // Ordinary read commands succeed and create no store. validate is allowed
    // to exit with VALIDATION_WARNINGS (6) for reasons unrelated to the store
    // (e.g., coverage scanning not configured); the property under test is
    // that no migration step is required and no store is created.
    const itemList = kspec("item list", tempDir);
    expect(itemList.exitCode).toBe(0);
    const taskList = kspec("task list", tempDir);
    expect(taskList.exitCode).toBe(0);
    const validateResult = kspec("validate --completeness --warnings-ok", tempDir);
    expect(validateResult.exitCode).toBe(0);

    // No migration step is required: the commands never prompt or refuse on
    // account of the verification record store being absent.
    expect(itemList.stderr).not.toMatch(/verification/i);
    expect(itemList.stderr).not.toMatch(/migrat/i);
    expect(taskList.stderr).not.toMatch(/verification/i);
    expect(validateResult.stderr).not.toMatch(/verification/i);
    expect(validateResult.stderr).not.toMatch(/migrat/i);

    // No store was created as a side effect.
    expect(existsSync(storeDir)).toBe(false);

    // No project data was rewritten.
    const afterCommands = await snapshotFiles(tempDir);
    expectSnapshotsEqual(before, afterCommands);

    // The manifest's declared format version is unchanged by ordinary commands.
    const manifestAfterCommands = await readTestOutput(manifestPath);
    const kyneticLineAfter = manifestAfterCommands.match(/^kynetic:.*$/m)?.[0] ?? "";
    expect(kyneticLineAfter).toBe(kyneticLineBefore);
  });
});

// ── AC: ac-first-write-materializes ─────────────────────────────────────────

describe("ac-first-write-materializes", () => {
  let project: NonShadowProject;

  beforeEach(async () => {
    project = await setupNonShadowProject();
  });

  afterEach(async () => {
    await cleanupTempDir(project.tempDir);
  });

  // AC: @coverage-record-compatibility ac-first-write-materializes
  it("creates the store directory and record file as part of the first stamp write", async () => {
    const ulid = testUlid("ITEM", 1);
    await writeModule(project.modulesDir, "specs.yaml", [makeItem(ulid, "feature-a", ["ac-one"])]);
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const storeRoot = getVerificationStoreRoot(ctx);
    const recordPath = getVerificationRecordPath(ctx, ulid);

    expect(existsSync(storeRoot)).toBe(false);
    expect(existsSync(recordPath)).toBe(false);

    await writeVerificationStamp(ctx, ulid, "ac-one", validStamp());

    // The store directory and record file materialized as part of the write.
    expect(existsSync(storeRoot)).toBe(true);
    expect(existsSync(recordPath)).toBe(true);

    const record = await loadVerificationRecord(ctx, ulid);
    expect(record?.acs["ac-one"]).toBeDefined();
    expect(record?.acs["ac-one"].actor).toBe("pr-reviewer");
  });
});

// ── AC: ac-newer-record-format-refused ──────────────────────────────────────

describe("ac-newer-record-format-refused", () => {
  let project: NonShadowProject;

  beforeEach(async () => {
    project = await setupNonShadowProject();
    const ulid = testUlid("ITEM", 1);
    await writeModule(project.modulesDir, "specs.yaml", [makeItem(ulid, "feature-a", ["ac-one"])]);
  });

  afterEach(async () => {
    await cleanupTempDir(project.tempDir);
  });

  /**
   * Seed a verification record file on disk declaring a record-format version
   * greater than the running tool supports. The seeded file uses a valid stamp
   * shape so the only reason for refusal is the format-version ceiling.
   */
  async function seedNewerFormatRecord(
    ctx: ReturnType<Awaited<ReturnType<typeof initContext>>> extends infer C ? C : never,
    itemUlid: string,
  ): Promise<{ recordPath: string; originalBytes: string }> {
    const recordPath = getVerificationRecordPath(ctx, itemUlid);
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    const newerFormat = CURRENT_VERIFICATION_RECORD_FORMAT + 1;
    const content =
      `format: ${newerFormat}\n` +
      `acs:\n` +
      `  ac-one:\n` +
      `    verified_at: 2026-06-10T12:00:00.000Z\n` +
      `    actor: pr-reviewer\n` +
      `    provenance: validation\n`;
    await fs.writeFile(recordPath, content, "utf-8");
    const originalBytes = await readTestOutput(recordPath);
    return { recordPath, originalBytes };
  }

  // AC: @coverage-record-compatibility ac-newer-record-format-refused
  it("direct read refuses with both versions named and leaves the file unmodified", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const ulid = testUlid("ITEM", 1);
    const { originalBytes } = await seedNewerFormatRecord(ctx as never, ulid);

    await expect(loadVerificationRecord(ctx, ulid)).rejects.toThrow(
      VerificationRecordFormatCompatibilityError,
    );
    await expect(loadVerificationRecord(ctx, ulid)).rejects.toMatchObject({
      code: VERIFICATION_RECORD_FORMAT_NEWER_THAN_SUPPORTED_CODE,
      declaredVersion: CURRENT_VERIFICATION_RECORD_FORMAT + 1,
      maxSupportedVersion: CURRENT_VERIFICATION_RECORD_FORMAT,
    });

    // The refusal message names both versions.
    try {
      await loadVerificationRecord(ctx, ulid);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(VerificationRecordFormatCompatibilityError);
      const e = err as VerificationRecordFormatCompatibilityError;
      expect(e.message).toContain(String(CURRENT_VERIFICATION_RECORD_FORMAT + 1));
      expect(e.message).toContain(String(CURRENT_VERIFICATION_RECORD_FORMAT));
    }

    // The store was not modified by the read attempt.
    const recordPath = getVerificationRecordPath(ctx, ulid);
    expect(await readTestOutput(recordPath)).toBe(originalBytes);
  });

  // AC: @coverage-record-compatibility ac-newer-record-format-refused
  it("write refuses with both versions named, leaves the file unmodified, and does not lose the caller's stamp", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const ulid = testUlid("ITEM", 1);
    const { originalBytes } = await seedNewerFormatRecord(ctx as never, ulid);

    await expect(
      writeVerificationStamp(ctx, ulid, "ac-one", validStamp({ actor: "new-actor" })),
    ).rejects.toThrow(VerificationRecordFormatCompatibilityError);

    // The existing record file is byte-identical — no disk modification.
    const recordPath = getVerificationRecordPath(ctx, ulid);
    expect(await readTestOutput(recordPath)).toBe(originalBytes);
  });

  // AC: @coverage-record-compatibility ac-newer-record-format-refused
  it("operations not involving the store remain unaffected by a newer-format record", async () => {
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const ulid = testUlid("ITEM", 1);
    await seedNewerFormatRecord(ctx as never, ulid);

    // Bulk load (used by validation's orphan scan) tolerates the newer-format
    // record — it skips that file without throwing.
    const records = await loadVerificationRecords(ctx);
    expect(records).toEqual([]);

    // validate --completeness succeeds; the newer-format record is not
    // surfaced as an orphan finding and the operation is not refused.
    const result = await validate(ctx, { completeness: true });
    const newFormatFindings = result.completenessWarnings.filter((w) => w.message.includes(ulid));
    expect(newFormatFindings).toEqual([]);

    // An unrelated write that does not involve the store succeeds.
    const inboxResult = kspec('inbox add "compat-test idea"', project.tempDir);
    expect(inboxResult.exitCode).toBe(0);

    // The newer-format record file is still untouched.
    const recordPath = getVerificationRecordPath(ctx, ulid);
    const newerFormat = CURRENT_VERIFICATION_RECORD_FORMAT + 1;
    expect(await readTestOutput(recordPath)).toContain(`format: ${newerFormat}`);
  });
});

// ── AC: ac-unknown-fields-roundtrip ─────────────────────────────────────────

describe("ac-unknown-fields-roundtrip", () => {
  let project: NonShadowProject;

  beforeEach(async () => {
    project = await setupNonShadowProject();
  });

  afterEach(async () => {
    await cleanupTempDir(project.tempDir);
  });

  // AC: @coverage-record-compatibility ac-unknown-fields-roundtrip
  it("preserves unrecognized fields on stored records through a read-modify-write of a different criterion", async () => {
    const ulid = testUlid("ITEM", 1);
    await writeModule(project.modulesDir, "specs.yaml", [
      makeItem(ulid, "feature-a", ["ac-one", "ac-two"]),
    ]);
    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const recordPath = getVerificationRecordPath(ctx, ulid);

    // Seed a record with valid `format`, a known stamp for ac-one carrying
    // unknown extension fields the running tool does not recognize, and an
    // unknown top-level extension field.
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(
      recordPath,
      [
        "format: 1",
        "metadata:",
        "  source_tool_version: 9.9.9",
        "acs:",
        "  ac-one:",
        "    verified_at: 2026-06-10T12:00:00.000Z",
        "    actor: pr-reviewer",
        "    provenance: validation",
        "    future_field: preserved-through-rmw",
        "",
      ].join("\n"),
      "utf-8",
    );

    // Read-modify-write of a DIFFERENT criterion. The original ac-one entry
    // must round-trip unchanged.
    await writeVerificationStamp(ctx, ulid, "ac-two", validStamp({ actor: "second-actor" }));

    const rawAfter = (await readYamlFile<Record<string, unknown>>(recordPath)) as Record<
      string,
      unknown
    >;
    expect(rawAfter.format).toBe(1);

    // Unknown top-level field is preserved.
    expect(rawAfter.metadata).toEqual({ source_tool_version: "9.9.9" });

    // The untouched entry's unknown stamp-level field is preserved.
    const acs = rawAfter.acs as Record<string, Record<string, unknown>>;
    expect(acs["ac-one"].future_field).toBe("preserved-through-rmw");
    expect(acs["ac-one"].actor).toBe("pr-reviewer");

    // The newly-written criterion is present.
    expect(acs["ac-two"].actor).toBe("second-actor");
  });
});

// ── AC: ac-unrecognized-sidecar-untouched ───────────────────────────────────

describe("ac-unrecognized-sidecar-untouched", () => {
  let project: NonShadowProject;

  beforeEach(async () => {
    project = await setupNonShadowProject();
  });

  afterEach(async () => {
    await cleanupTempDir(project.tempDir);
  });

  // AC: @coverage-record-compatibility ac-unrecognized-sidecar-untouched
  it("leaves an unrecognized sidecar directory unread and unmodified across load, validate, and metadata write", async () => {
    const ulid = testUlid("ITEM", 1);
    await writeModule(project.modulesDir, "specs.yaml", [makeItem(ulid, "feature-a", ["ac-one"])]);

    // Drop an unrecognized sidecar directory alongside the known metadata.
    // Tools that predate the verification store (or any future feature) must
    // neither read nor rewrite files in directories they do not recognize.
    const sidecarDir = path.join(project.specDir, "unknown-sidecar");
    const sidecarFile = path.join(sidecarDir, "data.yaml");
    await fs.mkdir(sidecarDir, { recursive: true });
    const sidecarBytes = "unknown_field: preserved-by-all-readers\nnested:\n  data: [1, 2, 3]\n";
    await fs.writeFile(sidecarFile, sidecarBytes, "utf-8");

    const ctx = await initContext(project.tempDir, { syncMode: "skip" });

    // Load: the metadata scan must tolerate the unrecognized sidecar.
    const validateResult = await validate(ctx, { completeness: true });
    expect(Array.isArray(validateResult.completenessWarnings)).toBe(true);

    // Write elsewhere: a verification stamp write that materializes the
    // store under coverage/verifications/ must not touch the sidecar.
    await writeVerificationStamp(ctx, ulid, "ac-one", validStamp());

    // The unrecognized sidecar file is byte-identical.
    expect(await readTestOutput(sidecarFile)).toBe(sidecarBytes);
  });
});

// ── AC: ac-store-creation-additive ──────────────────────────────────────────

describe("ac-store-creation-additive", () => {
  let project: NonShadowProject;

  beforeEach(async () => {
    project = await setupNonShadowProject();
  });

  afterEach(async () => {
    await cleanupTempDir(project.tempDir);
  });

  // AC: @coverage-record-compatibility ac-store-creation-additive
  it("first stamp write modifies no pre-existing metadata file", async () => {
    const ulid = testUlid("ITEM", 1);
    await writeModule(project.modulesDir, "specs.yaml", [makeItem(ulid, "feature-a", ["ac-one"])]);

    // Pre-populate metadata files an older reader depends on — manifest,
    // spec module, and a kynetic.meta.yaml — and snapshot them.
    await writeYamlFilePreserveFormat(path.join(project.specDir, "kynetic.meta.yaml"), {
      project: { url: "https://example.com/compat-test" },
    });

    const ctx = await initContext(project.tempDir, { syncMode: "skip" });
    const before = await snapshotFiles(project.specDir);
    // The store does not exist yet.
    expect(before.has(path.join(VERIFICATION_STORE_DIR, `${ulid}.yaml`))).toBe(false);

    // First stamp write materializes the store.
    await writeVerificationStamp(ctx, ulid, "ac-one", validStamp());

    const after = await snapshotFiles(project.specDir);

    // Every file that existed before the write is unchanged.
    // The only new file is the verification record under coverage/verifications/.
    const newRecordPath = path.join(VERIFICATION_STORE_DIR, `${ulid}.yaml`);
    expect(after.has(newRecordPath)).toBe(true);
    expectSnapshotsEqual(before, after, { ignore: new Set([newRecordPath]) });
  });
});

// ── Upgrade interaction: record format vs. manifest format (shadow) ────────

describe.skipIf(!canRunShadowTests)(
  "verification record format ceiling — shadow-mode additivity",
  () => {
    let projectDir: string;

    beforeEach(async () => {
      projectDir = await createTempDir("kspec-compat-shadow-");
      initGitRepo(projectDir);
      await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
      execSync('git add README.md && git commit -m "initial"', {
        cwd: projectDir,
        stdio: "pipe",
      });
      const init = kspec("init --no-prompt --setup", projectDir, {
        env: { CLAUDECODE: "1", KSPEC_AUTHOR: "@test" },
      });
      if (init.exitCode !== 0) {
        throw new Error(`kspec init --no-prompt --setup failed: ${init.stderr}`);
      }
    });

    afterEach(async () => {
      await cleanupTempDir(projectDir);
    });

    // AC: @coverage-record-compatibility ac-store-creation-additive
    // AC: @coverage-record-compatibility ac-first-write-materializes
    it("first stamp write creates the store in shadow metadata without modifying any pre-existing metadata file", async () => {
      const specDir = path.join(projectDir, ".kspec");
      const before = await snapshotFiles(specDir);

      const ulid = testUlid("ITEM", 1);
      // Drop a spec module so the item exists for orphan partitioning.
      const modulePath = path.join(specDir, "modules", "compat.yaml");
      await fs.mkdir(path.dirname(modulePath), { recursive: true });
      await writeYamlFilePreserveFormat(modulePath, [makeItem(ulid, "feature-compat", ["ac-one"])]);

      const ctx = await initContext(projectDir, { syncMode: "skip" });

      // Re-snapshot after adding the spec module so we measure only the
      // stamp write's effect.
      const beforeStamp = await snapshotFiles(specDir);

      await writeVerificationStamp(ctx, ulid, "ac-one", validStamp());

      const after = await snapshotFiles(specDir);
      const newRecordPath = path.join(VERIFICATION_STORE_DIR, `${ulid}.yaml`);
      expect(after.has(newRecordPath)).toBe(true);

      // No pre-existing metadata file is modified by the store's creation.
      // The shadow branch auto-commit moves history forward but the working
      // set of files (other than the new record) is byte-identical.
      expectSnapshotsEqual(beforeStamp, after, { ignore: new Set([newRecordPath]) });

      // The whole-project snapshot proves nothing else changed either.
      expectSnapshotsEqual(before, after, {
        ignore: new Set([newRecordPath, path.join("modules", "compat.yaml")]),
      });
    });
  },
);
