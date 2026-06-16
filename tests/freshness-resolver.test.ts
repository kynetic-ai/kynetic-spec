/**
 * Per-AC freshness resolution tests.
 *
 * Covers @ac-freshness-resolution:
 *   ac-bootstrap-when-unstamped, ac-recorded-supersedes-bootstrap,
 *   ac-both-provenances-retrievable, ac-multi-annotation-most-recent,
 *   ac-no-history-absence, ac-timestamp-or-commit, ac-absence-reported.
 *
 * Each test sets up a real git repo in a temp dir, commits test files with
 * `// AC: @ref ac-N` annotations at known file:line locations, then drives
 * the resolver through the public API. Tests run the resolver end-to-end —
 * it spawns git blame against the temp repo and reads the verification
 * store from disk — so they cover the same surface a real consumer would
 * see, not the module's internal parsing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { initContext, writeYamlFilePreserveFormat } from "../src/parser/yaml.js";
import { writeVerificationStamp } from "../src/parser/verification-record-store.js";
import {
  resolveAcBootstrap,
  resolveAcFreshness,
  resolveAcFreshnessWithBoth,
} from "../src/parser/freshness-resolver.js";
import type { VerificationStampInput } from "../src/schema/verification-records.js";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";

/** A valid stamp for store writes. */
function validStamp(overrides: Partial<VerificationStampInput> = {}): VerificationStampInput {
  return {
    verified_at: "2026-06-10T12:00:00.000Z",
    actor: "pr-reviewer",
    provenance: "validation",
    ...overrides,
  };
}

/** Build a single-AC spec item. */
function makeItem(ulid: string, slug: string, acIds: string[]) {
  return {
    _ulid: ulid,
    title: `Item ${slug}`,
    slugs: [slug],
    type: "feature",
    description: "An item under test.",
    acceptance_criteria: acIds.map((id) => ({ id, given: "g", when: "w", then: "t" })),
  };
}

interface TestEnv {
  tempDir: string;
  specDir: string;
  modulesDir: string;
}

/** Initialise a fresh non-shadow project with one spec item carrying `acIds`. */
async function setupProject(
  prefix: string,
  ulid: string,
  slug: string,
  acIds: string[],
): Promise<TestEnv> {
  const tempDir = await createTempDir(prefix);
  const specDir = path.join(tempDir, "spec");
  const modulesDir = path.join(specDir, "modules");
  await fs.mkdir(modulesDir, { recursive: true });
  initGitRepo(tempDir);
  await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
    project: { name: "freshness-resolver-test" },
    includes: ["modules/specs.yaml"],
  });
  await writeYamlFilePreserveFormat(path.join(modulesDir, "specs.yaml"), [
    makeItem(ulid, slug, acIds),
  ]);
  return { tempDir, specDir, modulesDir };
}

/** Write a test file, commit it at `isoTimestamp`, return its absolute path. */
async function commitTestFile(
  env: TestEnv,
  relPath: string,
  body: string,
  isoTimestamp: string,
): Promise<string> {
  const absPath = path.join(env.tempDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, body);
  await commitWithDate(env.tempDir, relPath, isoTimestamp);
  return absPath;
}

/**
 * Stage and commit `relPath` with deterministic author/committer dates so
 * the timestamp the resolver reads back matches the value the test expects.
 */
async function commitWithDate(
  repoDir: string,
  relPath: string,
  isoTimestamp: string,
): Promise<void> {
  const envVars = {
    ...process.env,
    GIT_AUTHOR_DATE: isoTimestamp,
    GIT_COMMITTER_DATE: isoTimestamp,
  };
  execSync(`git add ${JSON.stringify(relPath)}`, {
    cwd: repoDir,
    stdio: "pipe",
    env: envVars,
  });
  execSync(`git commit -m "update ${relPath}"`, {
    cwd: repoDir,
    stdio: "pipe",
    env: envVars,
  });
}

describe("freshness-resolver (bootstrap + recorded)", () => {
  let env: TestEnv;
  const ulid = testUlid("FRESH", 1);
  const slug = "freshness-target";
  const acId = "ac-one";

  beforeEach(async () => {
    env = await setupProject("kspec-fresh-", ulid, slug, [acId]);
  });

  afterEach(async () => {
    await cleanupTempDir(env.tempDir);
  });

  // AC: @ac-freshness-resolution ac-bootstrap-when-unstamped
  it("resolves a bootstrap value from the annotation's version-control history when no stamp is recorded", async () => {
    const isoTime = "2026-05-20T10:00:00.000Z";
    const testFile = await commitTestFile(
      env,
      "tests/bootstrap-only.test.ts",
      `// AC: @${slug} ${acId}\nit("covers the criterion", () => {});\n`,
      isoTime,
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });

    const result = await resolveAcFreshness(ctx, ulid, acId, [{ file: testFile, line: 1 }]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    expect(result.value.source).toBe("bootstrap");
    if (result.value.source !== "bootstrap") throw new Error("expected bootstrap");
    expect(result.value.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.value.timestamp).toBe(isoTime);
  });

  // AC: @ac-freshness-resolution ac-recorded-supersedes-bootstrap
  it("returns the recorded stamp verbatim and ignores the bootstrap value when both are available", async () => {
    // Older test file commit; the stamp's verified_at is even older than
    // the commit, so the bootstrap value would be "more recent" than the
    // stamp. The resolver must still return the stamp, never compare.
    const commitIso = "2026-05-25T08:00:00.000Z";
    const testFile = await commitTestFile(
      env,
      "tests/recorded-wins.test.ts",
      `// AC: @${slug} ${acId}\nit("covers the criterion", () => {});\n`,
      commitIso,
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });

    // Stamp verified at a time BEFORE the file was committed.
    await writeVerificationStamp(
      ctx,
      ulid,
      acId,
      validStamp({
        verified_at: "2026-04-01T00:00:00.000Z",
        actor: "ingestion-runner",
        provenance: "ingestion",
        commit: `${"deadbeef"}${"0".repeat(32)}`,
      }),
    );

    const result = await resolveAcFreshness(ctx, ulid, acId, [{ file: testFile, line: 1 }]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    expect(result.value.source).toBe("recorded");
    if (result.value.source !== "recorded") throw new Error("expected recorded");
    expect(result.value.timestamp).toBe("2026-04-01T00:00:00.000Z");
    expect(result.value.commit).toBe(`${"deadbeef"}${"0".repeat(32)}`);
    expect(result.value.stamp.provenance).toBe("ingestion");
    expect(result.value.stamp.actor).toBe("ingestion-runner");
  });

  // AC: @ac-freshness-resolution ac-both-provenances-retrievable
  it("returns both provenances side by side, unaltered and uncomparable, when explicitly requested", async () => {
    const commitIso = "2026-05-26T14:30:00.000Z";
    const testFile = await commitTestFile(
      env,
      "tests/both.test.ts",
      `// AC: @${slug} ${acId}\nit("covers the criterion", () => {});\n`,
      commitIso,
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });

    await writeVerificationStamp(
      ctx,
      ulid,
      acId,
      validStamp({
        verified_at: "2026-04-10T00:00:00.000Z",
        actor: "human-reviewer",
        provenance: "re_verification",
        commit: `${"feedface"}${"0".repeat(32)}`,
      }),
    );

    const result = await resolveAcFreshnessWithBoth(ctx, ulid, acId, [{ file: testFile, line: 1 }]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    expect(result.recorded).not.toBeNull();
    expect(result.bootstrap).not.toBeNull();
    if (!result.recorded || !result.bootstrap) throw new Error("expected both");

    // Recorded side carries the stamp verbatim.
    expect(result.recorded.source).toBe("recorded");
    expect(result.recorded.timestamp).toBe("2026-04-10T00:00:00.000Z");
    expect(result.recorded.commit).toBe(`${"feedface"}${"0".repeat(32)}`);
    expect(result.recorded.stamp.provenance).toBe("re_verification");
    expect(result.recorded.stamp.actor).toBe("human-reviewer");

    // Bootstrap side carries the unaltered commit + committer timestamp.
    expect(result.bootstrap.source).toBe("bootstrap");
    expect(result.bootstrap.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.bootstrap.timestamp).toBe(commitIso);

    // The two values are NOT compared — both are returned unchanged.
    expect(result.recorded.timestamp).not.toBe(result.bootstrap.timestamp);
  });

  // AC: @ac-freshness-resolution ac-multi-annotation-most-recent
  it("returns the most recent of several annotation history values when no stamp is recorded", async () => {
    const olderFile = await commitTestFile(
      env,
      "tests/older.test.ts",
      `// AC: @${slug} ${acId}\nit("older coverage", () => {});\n`,
      "2026-05-01T09:00:00.000Z",
    );
    const newerFile = await commitTestFile(
      env,
      "tests/newer.test.ts",
      `// AC: @${slug} ${acId}\nit("newer coverage", () => {});\n`,
      "2026-05-15T09:00:00.000Z",
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });

    const result = await resolveAcFreshness(ctx, ulid, acId, [
      { file: olderFile, line: 1 },
      { file: newerFile, line: 1 },
    ]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    expect(result.value.source).toBe("bootstrap");
    if (result.value.source !== "bootstrap") throw new Error("expected bootstrap");
    expect(result.value.timestamp).toBe("2026-05-15T09:00:00.000Z");

    // Order-independent: reverse the input list and the answer is the same.
    const reversed = await resolveAcFreshness(ctx, ulid, acId, [
      { file: newerFile, line: 1 },
      { file: olderFile, line: 1 },
    ]);
    expect(reversed.kind).toBe("freshness");
    if (reversed.kind !== "freshness") throw new Error("expected freshness");
    expect(reversed.value.source).toBe("bootstrap");
    if (reversed.value.source !== "bootstrap") throw new Error("expected bootstrap");
    expect(reversed.value.timestamp).toBe("2026-05-15T09:00:00.000Z");
  });

  // AC: @ac-freshness-resolution ac-multi-annotation-most-recent
  // AC: @ac-freshness-resolution ac-no-history-absence (mixed case)
  it("resolves to the most recent history value when some annotations have history and others do not", async () => {
    const committedFile = await commitTestFile(
      env,
      "tests/committed.test.ts",
      `// AC: @${slug} ${acId}\nit("committed coverage", () => {});\n`,
      "2026-05-10T12:00:00.000Z",
    );
    // Uncommitted: created in the working tree, never `git add`-ed. The
    // scanner would have to scan to find this annotation; we just point
    // the resolver at the path/line to confirm absence-on-that-side does
    // not poison the result.
    const uncommittedFile = path.join(env.tempDir, "tests", "uncommitted.test.ts");
    await fs.mkdir(path.dirname(uncommittedFile), { recursive: true });
    await fs.writeFile(
      uncommittedFile,
      `// AC: @${slug} ${acId}\nit("uncommitted coverage", () => {});\n`,
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });

    const result = await resolveAcFreshness(ctx, ulid, acId, [
      { file: uncommittedFile, line: 1 },
      { file: committedFile, line: 1 },
    ]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    expect(result.value.source).toBe("bootstrap");
    if (result.value.source !== "bootstrap") throw new Error("expected bootstrap");
    expect(result.value.timestamp).toBe("2026-05-10T12:00:00.000Z");
    expect(result.value.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // AC: @ac-freshness-resolution ac-multi-annotation-most-recent
  //
  // Same-file batched blame: git emits the records contiguously in a single
  // invocation, so the parser must split records by header pattern, not by
  // blank-line separators. The most recent of the same-file history values
  // must win regardless of which line was committed first.
  it("picks the most recent history value across multiple annotation lines in the same file", async () => {
    const relPath = "tests/same-file-multi.test.ts";
    const absPath = path.join(env.tempDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    // Commit 1: only the first annotation block exists. Line 1's blame will
    // stay anchored at this commit even after later commits append lines.
    await fs.writeFile(absPath, `// AC: @${slug} ${acId}\nit("first coverage", () => {});\n`);
    commitWithDate(env.tempDir, relPath, "2026-05-01T08:00:00.000Z");

    // Commit 2 (later timestamp): append a second annotation block. Line 1's
    // text is unchanged, so its blame remains commit 1; the new annotation
    // line's blame is commit 2.
    await fs.writeFile(
      absPath,
      `// AC: @${slug} ${acId}\nit("first coverage", () => {});\n// AC: @${slug} ${acId}\nit("second coverage", () => {});\n`,
    );
    commitWithDate(env.tempDir, relPath, "2026-05-20T08:00:00.000Z");

    const ctx = await initContext(env.tempDir, { syncMode: "skip" });

    const result = await resolveAcFreshness(ctx, ulid, acId, [
      { file: absPath, line: 1 },
      { file: absPath, line: 3 },
    ]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    if (result.value.source !== "bootstrap") throw new Error("expected bootstrap");
    expect(result.value.timestamp).toBe("2026-05-20T08:00:00.000Z");

    // Order-independent: reversing the input lines yields the same answer.
    const reversed = await resolveAcFreshness(ctx, ulid, acId, [
      { file: absPath, line: 3 },
      { file: absPath, line: 1 },
    ]);
    expect(reversed.kind).toBe("freshness");
    if (reversed.kind !== "freshness") throw new Error("expected freshness");
    if (reversed.value.source !== "bootstrap") throw new Error("expected bootstrap");
    expect(reversed.value.timestamp).toBe("2026-05-20T08:00:00.000Z");
  });

  // AC: @ac-freshness-resolution ac-multi-annotation-most-recent
  // AC: @ac-freshness-resolution ac-no-history-absence (same-file mixed case)
  //
  // When one of several same-file annotation lines is uncommitted (working-tree
  // edit, blame returns the all-zero SHA) and another line in the same file
  // has real history, the resolver must still surface the committed value
  // rather than treating the whole file as no-history.
  it("surfaces the committed history value when a sibling annotation line in the same file is uncommitted", async () => {
    const relPath = "tests/same-file-mixed.test.ts";
    const absPath = path.join(env.tempDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    // Commit: both annotation lines exist with the same blame.
    await fs.writeFile(
      absPath,
      `// AC: @${slug} ${acId}\nit("first coverage", () => {});\n// AC: @${slug} ${acId}\nit("second coverage", () => {});\n`,
    );
    commitWithDate(env.tempDir, relPath, "2026-05-12T09:00:00.000Z");

    // Working-tree edit on line 1 only: git blame reports line 1 as the
    // all-zero (uncommitted) SHA while line 3 keeps the committed blame.
    await fs.writeFile(
      absPath,
      `// AC: @${slug} ${acId} (edited)\nit("first coverage", () => {});\n// AC: @${slug} ${acId}\nit("second coverage", () => {});\n`,
    );

    const ctx = await initContext(env.tempDir, { syncMode: "skip" });

    const result = await resolveAcFreshness(ctx, ulid, acId, [
      { file: absPath, line: 1 },
      { file: absPath, line: 3 },
    ]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    if (result.value.source !== "bootstrap") throw new Error("expected bootstrap");
    expect(result.value.timestamp).toBe("2026-05-12T09:00:00.000Z");
    expect(result.value.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // AC: @ac-freshness-resolution ac-no-history-absence
  it("reports absence as a distinct outcome when no stamp exists and every annotation location is uncommitted", async () => {
    const uncommittedFile = path.join(env.tempDir, "tests", "absent.test.ts");
    await fs.mkdir(path.dirname(uncommittedFile), { recursive: true });
    await fs.writeFile(
      uncommittedFile,
      `// AC: @${slug} ${acId}\nit("uncommitted coverage", () => {});\n`,
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });

    const result = await resolveAcFreshness(ctx, ulid, acId, [{ file: uncommittedFile, line: 1 }]);
    expect(result.kind).toBe("absent");
    // No error thrown, no fabricated value — absence is observable.
  });

  // AC: @ac-freshness-resolution ac-absence-reported
  it("reports absence for an AC with neither annotation nor stamp", async () => {
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });
    const result = await resolveAcFreshness(ctx, ulid, acId, []);
    expect(result.kind).toBe("absent");
  });

  // AC: @ac-freshness-resolution ac-timestamp-or-commit
  it("resolves bootstrap values carrying a timestamp and a commit reference", async () => {
    const testFile = await commitTestFile(
      env,
      "tests/shape.test.ts",
      `// AC: @${slug} ${acId}\nit("shape check", () => {});\n`,
      "2026-05-20T10:00:00.000Z",
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });

    const resolved = await resolveAcFreshness(ctx, ulid, acId, [{ file: testFile, line: 1 }]);
    expect(resolved.kind).toBe("freshness");
    if (resolved.kind !== "freshness") throw new Error("expected freshness");
    if (resolved.value.source !== "bootstrap") throw new Error("expected bootstrap");
    expect(typeof resolved.value.timestamp).toBe("string");
    expect(resolved.value.timestamp).not.toBeNull();
    expect(typeof resolved.value.commit).toBe("string");
    expect(resolved.value.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // AC: @ac-freshness-resolution ac-timestamp-or-commit
  it("exposes resolveAcBootstrap as a pure derivation helper", async () => {
    const testFile = await commitTestFile(
      env,
      "tests/helper.test.ts",
      `// AC: @${slug} ${acId}\nit("helper check", () => {});\n`,
      "2026-05-20T10:00:00.000Z",
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });
    const bootstrap = await resolveAcBootstrap(ctx, [{ file: testFile, line: 1 }]);
    expect(bootstrap).not.toBeNull();
    expect(bootstrap?.source).toBe("bootstrap");
    expect(bootstrap?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(bootstrap?.timestamp).toBe("2026-05-20T10:00:00.000Z");
  });

  // AC: @ac-freshness-resolution ac-both-provenances-retrievable
  it("returns only the bootstrap side when no recorded stamp exists and the explicit-both API is used", async () => {
    const testFile = await commitTestFile(
      env,
      "tests/bootstrap-only-both.test.ts",
      `// AC: @${slug} ${acId}\nit("bootstrap only", () => {});\n`,
      "2026-05-22T11:00:00.000Z",
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });
    const result = await resolveAcFreshnessWithBoth(ctx, ulid, acId, [{ file: testFile, line: 1 }]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    expect(result.recorded).toBeNull();
    expect(result.bootstrap).not.toBeNull();
    expect(result.bootstrap?.source).toBe("bootstrap");
  });

  // AC: @ac-freshness-resolution ac-both-provenances-retrievable
  // AC: @ac-freshness-resolution ac-no-history-absence
  it("returns only the recorded side when a stamp exists but no annotation has history", async () => {
    const uncommittedFile = path.join(env.tempDir, "tests", "uncommitted-both.test.ts");
    await fs.mkdir(path.dirname(uncommittedFile), { recursive: true });
    await fs.writeFile(
      uncommittedFile,
      `// AC: @${slug} ${acId}\nit("uncommitted both", () => {});\n`,
    );
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });
    await writeVerificationStamp(ctx, ulid, acId, validStamp({ provenance: "validation" }));
    const result = await resolveAcFreshnessWithBoth(ctx, ulid, acId, [
      { file: uncommittedFile, line: 1 },
    ]);
    expect(result.kind).toBe("freshness");
    if (result.kind !== "freshness") throw new Error("expected freshness");
    expect(result.recorded).not.toBeNull();
    expect(result.bootstrap).toBeNull();
  });

  // AC: @ac-freshness-resolution ac-both-provenances-retrievable
  // AC: @ac-freshness-resolution ac-absence-reported
  it("returns absence for the both API when neither provenance has a value", async () => {
    const ctx = await initContext(env.tempDir, { syncMode: "skip" });
    const result = await resolveAcFreshnessWithBoth(ctx, ulid, acId, []);
    expect(result.kind).toBe("absent");
  });
});

describe("freshness-resolver (no git repo)", () => {
  // AC: @ac-freshness-resolution ac-no-history-absence
  // AC: @ac-freshness-resolution ac-absence-reported
  //
  // The resolver must not throw when the project is not a git repository —
  // absence is the observable outcome, not an error.
  it("treats every line as no-history when the project is not a git repo", async () => {
    const tempDir = await createTempDir("kspec-fresh-nogit-");
    const specDir = path.join(tempDir, "spec");
    const modulesDir = path.join(specDir, "modules");
    await fs.mkdir(modulesDir, { recursive: true });
    await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
      project: { name: "no-git" },
      includes: ["modules/specs.yaml"],
    });
    const ulid = testUlid("NOGIT", 1);
    await writeYamlFilePreserveFormat(path.join(modulesDir, "specs.yaml"), [
      makeItem(ulid, "no-git-item", ["ac-one"]),
    ]);
    const annotationFile = path.join(tempDir, "tests", "x.test.ts");
    await fs.mkdir(path.dirname(annotationFile), { recursive: true });
    await fs.writeFile(annotationFile, `// AC: @no-git-item ac-one\nit("x", () => {});\n`);

    try {
      const ctx = await initContext(tempDir, { syncMode: "skip" });
      const result = await resolveAcFreshness(ctx, ulid, "ac-one", [
        { file: annotationFile, line: 1 },
      ]);
      expect(result.kind).toBe("absent");
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
