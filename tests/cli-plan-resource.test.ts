/**
 * CLI tests for `kspec plan resource` add/list/get/remove.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 * AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 * AC: @trait-semantic-exit-codes ac-1
 * AC: @trait-semantic-exit-codes ac-2
 * AC: @trait-semantic-exit-codes ac-3
 * AC: @trait-semantic-exit-codes ac-4
 */

// AC: @trait-semantic-exit-codes ac-5 — N/A: plan resource commands are not empty-result queries; list returns success with an empty array, not a "nothing found" code path.
// AC: @trait-semantic-exit-codes ac-6 — N/A: usage errors share the validation exit code (1) and are exercised by the missing/invalid argument cases.
// AC: @trait-semantic-exit-codes ac-7 — N/A: plan resource commands are not batch operations with partial success.
// AC: @trait-semantic-exit-codes ac-8 — N/A: exit code meanings are documented centrally in src/cli/exit-codes.ts.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec as kspecRun,
  kspecJson,
} from "./helpers/cli";

const projectCli = path.resolve(__dirname, "..", "dist", "cli", "index.js");
const canRunInit = existsSync(projectCli);

interface ResourceMetadataShape {
  id: string;
  label: string | null;
  path: string;
  content_type: string;
  bytes: number;
  sha256: string;
  git_commit: string | null;
  git_path: string | null;
  description: string | null;
}

interface AddResourceJson {
  resource: ResourceMetadataShape;
  replaced: boolean;
}

interface ListResourceJson {
  resources: ResourceMetadataShape[];
}

interface GetResourceJson {
  resource: ResourceMetadataShape;
}

interface RemoveResourceJson {
  removed: { id: string; path: string };
}

interface PlanResourceErrorJson {
  error: string;
  code: string;
  message: string;
  resource_id: string | null;
  path: string | null;
  source_file: string | null;
}

async function setupFolderProject(projectDir: string): Promise<string> {
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "initial"', {
    cwd: projectDir,
    stdio: "pipe",
  });
  const result = kspecRun("init --no-prompt", projectDir, {
    env: { KSPEC_AUTHOR: "@test" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${result.stderr}`);
  }
  const addResult = kspecRun('plan add --title "Resource Plan" --content "Body"', projectDir);
  if (addResult.exitCode !== 0) {
    throw new Error(`plan add failed: ${addResult.stderr}`);
  }
  return "@plan-resource-plan";
}

describe.runIf(canRunInit)("Integration: plan resource CLI", () => {
  let tempDir: string;
  let planRef: string;
  let sourcePath: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    planRef = await setupFolderProject(tempDir);
    sourcePath = path.join(tempDir, "shot.png");
    await fs.writeFile(sourcePath, "PNG_BYTES");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("plan resource add", () => {
    // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    // AC: @trait-semantic-exit-codes ac-1
    it("adds a new resource with explicit id and path and returns the full metadata envelope", () => {
      const json = kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login.png`,
        tempDir,
      );
      expect(json.replaced).toBe(false);
      expect(json.resource.id).toBe("login-shot");
      expect(json.resource.path).toBe("screenshots/login.png");
      expect(json.resource.content_type).toBe("image/png");
      expect(json.resource.bytes).toBe(Buffer.byteLength("PNG_BYTES"));
      expect(json.resource.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(json.resource.label).toBeNull();
      expect(json.resource.description).toBeNull();
      // The plan is brand-new and uncommitted, so git version identity must
      // be null (no HEAD blob to anchor the resource to).
      expect(json.resource.git_commit).toBeNull();
    });

    // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
    it("infers content_type from the path extension when --content-type is omitted", () => {
      const json = kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id text --path notes.txt`,
        tempDir,
      );
      expect(json.resource.content_type).toBe("text/plain");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("stores an explicit --content-type verbatim", () => {
      const json = kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id custom --path blob.bin --content-type application/x-custom`,
        tempDir,
      );
      expect(json.resource.content_type).toBe("application/x-custom");
    });

    // AC: @trait-semantic-exit-codes ac-2
    it("fails with invalid_resource_id when --id is missing", () => {
      const result = kspecRun(
        `plan resource add ${planRef} "${sourcePath}" --path screenshots/login.png --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("invalid_resource_id");
    });

    // AC: @trait-semantic-exit-codes ac-2
    it("fails with invalid_resource_path when --path is missing", () => {
      const result = kspecRun(
        `plan resource add ${planRef} "${sourcePath}" --id missing-path --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("invalid_resource_path");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects absolute paths with invalid_resource_path", () => {
      const result = kspecRun(
        `plan resource add ${planRef} "${sourcePath}" --id bad --path /etc/passwd --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("invalid_resource_path");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects parent traversal segments with invalid_resource_path", () => {
      const result = kspecRun(
        `plan resource add ${planRef} "${sourcePath}" --id bad --path ../escape.png --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("invalid_resource_path");
    });

    it("fails with source_file_missing when the source path does not exist", () => {
      const result = kspecRun(
        `plan resource add ${planRef} "${path.join(tempDir, "nope.png")}" --id missing --path missing.png --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("source_file_missing");
      expect(env.source_file).toContain("nope.png");
    });

    it("fails with source_file_unreadable when the source path is a directory", async () => {
      const dirPath = path.join(tempDir, "shots");
      await fs.mkdir(dirPath, { recursive: true });
      const result = kspecRun(
        `plan resource add ${planRef} "${dirPath}" --id bad --path bad.png --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("source_file_unreadable");
    });

    it("fails with plan_not_found when the plan ref does not exist", () => {
      const result = kspecRun(
        `plan resource add @ghost "${sourcePath}" --id nope --path nope.png --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("plan_not_found");
    });

    // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
    it("refuses to overwrite an existing resource id without --replace", () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login.png`,
        tempDir,
      );
      const result = kspecRun(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login-v2.png --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("resource_conflict");
    });

    // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
    it("refuses to overwrite a different resource id's path even with --replace", async () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login.png`,
        tempDir,
      );
      const other = path.join(tempDir, "alt.png");
      await fs.writeFile(other, "ALT");
      const result = kspecRun(
        `plan resource add ${planRef} "${other}" --id other-shot --path screenshots/login.png --replace --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("resource_conflict");
    });

    // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
    it("--replace updates one resource id's bytes and metadata in place", async () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login.png`,
        tempDir,
      );
      const next = path.join(tempDir, "next.png");
      await fs.writeFile(next, "PNG_BYTES_V2");
      const json = kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${next}" --id login-shot --path screenshots/login.png --replace`,
        tempDir,
      );
      expect(json.replaced).toBe(true);
      expect(json.resource.bytes).toBe(Buffer.byteLength("PNG_BYTES_V2"));
    });

    // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
    it("--replace can move the resource to a new path and removes the previous file", async () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login.png`,
        tempDir,
      );
      const planUlid = kspecJson<{ _ulid: string }>(`plan get ${planRef}`, tempDir)._ulid;
      const planDir = path.join(tempDir, ".kspec", "plans", planUlid);
      const oldPath = path.join(planDir, "resources", "screenshots", "login.png");
      expect(existsSync(oldPath)).toBe(true);
      const json = kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login-v2.png --replace`,
        tempDir,
      );
      expect(json.resource.path).toBe("screenshots/login-v2.png");
      expect(existsSync(oldPath)).toBe(false);
      const newPath = path.join(planDir, "resources", "screenshots", "login-v2.png");
      expect(existsSync(newPath)).toBe(true);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    // Regression for review cycle 2 blocker #1: `plan resource add` must not
    // follow a pre-existing symlink under `<plan>/resources/<intermediate>`
    // and write the source bytes to an outside tree. The textual
    // `validateResourceRelativePath` check stops authoring-time traversal
    // but does not see disk-level symlinks; the mutation gate must lstat
    // each chain segment before any copy.
    it("rejects plan resource add when an intermediate directory under resources/ is a symlink to an outside tree", async () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id baseline --path baseline.png`,
        tempDir,
      );
      const planUlid = kspecJson<{ _ulid: string }>(`plan get ${planRef}`, tempDir)._ulid;
      const resourcesDir = path.join(tempDir, ".kspec", "plans", planUlid, "resources");
      const outsideDir = path.join(tempDir, "outside-of-plan");
      await fs.mkdir(outsideDir, { recursive: true });
      const symlinkSub = path.join(resourcesDir, "sub");
      await fs.symlink(outsideDir, symlinkSub, "dir");

      const result = kspecRun(
        `plan resource add ${planRef} "${sourcePath}" --id leak --path sub/leak.txt --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("invalid_resource_path");
      expect(env.message).toMatch(/symlink/i);
      expect(existsSync(path.join(outsideDir, "leak.txt"))).toBe(false);
      expect(existsSync(path.join(resourcesDir, "sub", "leak.txt"))).toBe(false);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    // Defence-in-depth: even when the resources/ root itself is a symlink
    // (e.g. someone migrated state by symlinking the dir), add must refuse
    // every write — not silently redirect every declared path into the
    // outside tree.
    it("rejects plan resource add when resources/ itself is a symlink", async () => {
      const planUlid = kspecJson<{ _ulid: string }>(`plan get ${planRef}`, tempDir)._ulid;
      const planDir = path.join(tempDir, ".kspec", "plans", planUlid);
      const resourcesDir = path.join(planDir, "resources");
      const outsideDir = path.join(tempDir, "outside-of-plan-root");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, resourcesDir, "dir");

      const result = kspecRun(
        `plan resource add ${planRef} "${sourcePath}" --id leak --path leak.png --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("invalid_resource_path");
      expect(env.message).toMatch(/symlink/i);
      expect(existsSync(path.join(outsideDir, "leak.png"))).toBe(false);
    });

    // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    // Regression: --replace must not mutate the on-disk file or manifest when
    // post-copy validation rejects the request. A rejected validation that
    // already moved bytes leaves the manifest and disk out of sync.
    it("--replace leaves the existing file and manifest untouched when validation rejects the request", async () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path doc.bin`,
        tempDir,
      );
      const planUlid = kspecJson<{ _ulid: string }>(`plan get ${planRef}`, tempDir)._ulid;
      const planDir = path.join(tempDir, ".kspec", "plans", planUlid);
      const onDisk = path.join(planDir, "resources", "doc.bin");
      const originalBytes = await fs.readFile(onDisk, "utf-8");
      const originalManifest = await fs.readFile(path.join(planDir, "resources.yaml"), "utf-8");

      const replacement = path.join(tempDir, "replacement.bin");
      await fs.writeFile(replacement, "TWO");
      const result = kspecRun(
        `plan resource add ${planRef} "${replacement}" --id login-shot --path doc.bin --replace --content-type not-a-mime --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("invalid_resource_path");

      const bytesAfter = await fs.readFile(onDisk, "utf-8");
      expect(bytesAfter).toBe(originalBytes);
      const manifestAfter = await fs.readFile(path.join(planDir, "resources.yaml"), "utf-8");
      expect(manifestAfter).toBe(originalManifest);
    });
  });

  describe("plan resource list", () => {
    // AC: @trait-semantic-exit-codes ac-1
    it("returns an empty resources array when no resources are declared", () => {
      const json = kspecJson<ListResourceJson>(`plan resource list ${planRef}`, tempDir);
      expect(json).toEqual({ resources: [] });
    });

    // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
    it("returns each declared resource's full metadata envelope", () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id shot-a --path a.png`,
        tempDir,
      );
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id shot-b --path b.png`,
        tempDir,
      );
      const json = kspecJson<ListResourceJson>(`plan resource list ${planRef}`, tempDir);
      expect(json.resources.map((r) => r.id).toSorted()).toEqual(["shot-a", "shot-b"]);
      expect(json.resources.every((r) => r.sha256.length === 64)).toBe(true);
    });
  });

  describe("plan resource get", () => {
    // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
    it("returns the matching resource envelope", () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id shot --path shot.png --label "Login shot"`,
        tempDir,
      );
      const json = kspecJson<GetResourceJson>(`plan resource get ${planRef} shot`, tempDir);
      expect(json.resource.id).toBe("shot");
      expect(json.resource.label).toBe("Login shot");
    });

    it("fails with resource_not_found when the id is absent", () => {
      const result = kspecRun(`plan resource get ${planRef} missing --json`, tempDir, {
        expectFail: true,
      });
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("resource_not_found");
    });

    it("fails with invalid_resource_id when the id violates the pattern", () => {
      const result = kspecRun(`plan resource get ${planRef} BAD/ID --json`, tempDir, {
        expectFail: true,
      });
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("invalid_resource_id");
    });
  });

  describe("plan resource remove", () => {
    // AC: @trait-semantic-exit-codes ac-1
    it("removes the resource and its file when --force is supplied", () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id shot --path shot.png`,
        tempDir,
      );
      const planUlid = kspecJson<{ _ulid: string }>(`plan get ${planRef}`, tempDir)._ulid;
      const file = path.join(tempDir, ".kspec", "plans", planUlid, "resources", "shot.png");
      expect(existsSync(file)).toBe(true);
      const json = kspecJson<RemoveResourceJson>(
        `plan resource remove ${planRef} shot --force`,
        tempDir,
      );
      expect(json.removed).toEqual({ id: "shot", path: "shot.png" });
      expect(existsSync(file)).toBe(false);
    });

    it("fails with confirmation_required in JSON mode without --force", () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id shot --path shot.png`,
        tempDir,
      );
      const result = kspecRun(`plan resource remove ${planRef} shot --json`, tempDir, {
        expectFail: true,
      });
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("confirmation_required");
    });

    // AC: @trait-semantic-exit-codes ac-3
    it("exits 2 with operation_cancelled when the interactive prompt is declined", () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id shot --path shot.png`,
        tempDir,
      );
      const result = kspecRun(`plan resource remove ${planRef} shot --json`, tempDir, {
        env: { KSPEC_TEST_TTY: "true" },
        stdin: "n",
        expectFail: true,
      });
      expect(result.exitCode).toBe(2);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("operation_cancelled");
    });

    it("fails with resource_not_found when the id is absent", () => {
      const result = kspecRun(`plan resource remove ${planRef} ghost --force --json`, tempDir, {
        expectFail: true,
      });
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("resource_not_found");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    // Regression for review cycle 2 blocker #2: `plan resource remove` must
    // not follow a pre-existing symlink under `<plan>/resources/<intermediate>`
    // and delete an arbitrary outside file. Even though the manifest entry
    // is plan-owned text, the on-disk path may be poisoned by a symlinked
    // intermediate directory; the destructive `fs.rm` must refuse the
    // request before it touches disk.
    it("rejects plan resource remove when an intermediate directory under resources/ is a symlink to an outside tree", async () => {
      // Establish the resources/ root by adding a legitimate baseline file
      // first (this avoids hand-creating .kspec state and keeps the test
      // grounded in the real CLI flow).
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id baseline --path baseline.png`,
        tempDir,
      );
      const planUlid = kspecJson<{ _ulid: string }>(`plan get ${planRef}`, tempDir)._ulid;
      const planDir = path.join(tempDir, ".kspec", "plans", planUlid);
      const resourcesDir = path.join(planDir, "resources");
      const outsideDir = path.join(tempDir, "outside-of-plan-remove");
      await fs.mkdir(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, "leak.txt");
      await fs.writeFile(outsideFile, "OUTSIDE_SECRET", "utf-8");

      // Plant the pre-existing symlink and a manifest entry that points
      // through it. The fixed `add` flow refuses to write such an entry,
      // so we install it by editing the manifest directly — matching the
      // reviewer's repro where the manifest already contains the bad path.
      const symlinkSub = path.join(resourcesDir, "sub");
      await fs.symlink(outsideDir, symlinkSub, "dir");
      const manifestPath = path.join(planDir, "resources.yaml");
      const manifestText = await fs.readFile(manifestPath, "utf-8");
      // sha256 is quoted to keep YAML from coercing a digits-only value
      // into a number; the helper only validates the on-disk symlink
      // chain, so the actual hash is unimportant for the regression.
      const poisonedManifest = `${manifestText.trimEnd()}\n  - id: leak\n    label: null\n    path: sub/leak.txt\n    content_type: text/plain\n    bytes: 14\n    sha256: "0000000000000000000000000000000000000000000000000000000000000000"\n    git_commit: null\n    git_path: null\n    description: null\n`;
      await fs.writeFile(manifestPath, poisonedManifest, "utf-8");

      const result = kspecRun(`plan resource remove ${planRef} leak --force --json`, tempDir, {
        expectFail: true,
      });
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("invalid_resource_path");
      expect(env.message).toMatch(/symlink/i);
      expect(existsSync(outsideFile)).toBe(true);
      expect(await fs.readFile(outsideFile, "utf-8")).toBe("OUTSIDE_SECRET");
    });
  });

  // ── Post-Mutation Index Consistency ──────────────────────────────────────
  //
  // Every plan resource mutation that changes the bounded resource_summary
  // projection (count, total_bytes) must update the lean index in the same
  // logical mutation. Rebuild-index is a recovery tool, not the expected
  // follow-up after normal commands.
  //
  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection

  function expectCleanPlanRebuildDryRun(label: string): void {
    const result = kspecRun("plan rebuild-index --dry-run --json", tempDir);
    expect(result.exitCode, `${label}: ${result.stderr || result.stdout}`).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status, `${label}: status`).toBe("clean");
    expect(envelope.changes, `${label}: changes`).toEqual([]);
    expect(envelope.conflicts, `${label}: conflicts`).toEqual([]);
  }

  describe("post-mutation index consistency", () => {
    // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
    // RED: plan resource add writes resources.yaml directly without
    // refreshing the owning plan's index entry, so resource_summary in
    // project.plans.yaml does not reflect the new resource until a manual
    // rebuild-index runs.
    it("plan resource add: resource_summary is recorded in the same mutation", () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login.png`,
        tempDir,
      );
      expectCleanPlanRebuildDryRun("after plan resource add");
    });

    // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
    // RED: plan resource add --replace can change total_bytes (different
    // source file) without refreshing the index summary.
    it("plan resource add --replace: total_bytes change is recorded in the same mutation", async () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login.png`,
        tempDir,
      );
      const next = path.join(tempDir, "next.png");
      await fs.writeFile(next, "PNG_BYTES_REPLACED_LONGER");
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${next}" --id login-shot --path screenshots/login.png --replace`,
        tempDir,
      );
      expectCleanPlanRebuildDryRun("after plan resource add --replace");
    });

    // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
    // RED: plan resource remove drops a manifest entry (and the file) but
    // does not refresh the owning plan's index entry, so the index entry
    // continues to claim the resource is still present.
    it("plan resource remove: resource_summary drops in the same mutation", () => {
      kspecJson<AddResourceJson>(
        `plan resource add ${planRef} "${sourcePath}" --id login-shot --path screenshots/login.png`,
        tempDir,
      );
      const remove = kspecRun(`plan resource remove ${planRef} login-shot --force --json`, tempDir);
      expect(remove.exitCode).toBe(0);
      expectCleanPlanRebuildDryRun("after plan resource remove");
    });
  });
});
