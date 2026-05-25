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
  const addResult = kspecRun(
    'plan add --title "Resource Plan" --content "Body"',
    projectDir,
  );
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
      const result = kspecRun(
        `plan resource remove ${planRef} ghost --force --json`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const env = JSON.parse(result.stderr) as PlanResourceErrorJson;
      expect(env.code).toBe("resource_not_found");
    });
  });
});
