/**
 * Review resource CLI integration tests.
 *
 * Exercises the `kspec review resource add|list|get|remove` subcommands
 * end-to-end through the production binary — verifying the JSON envelopes,
 * exit codes, and side effects required by the task contract.
 *
 * Spec: @folder-backed-review-storage-1
 *       @trait-entity-scoped-local-resources-1
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec as kspecRun,
  kspecJson,
  kspecOutput as kspecOk,
} from "./helpers/cli.js";

let projectDir: string;
let pngSource: string;
let reviewSlug: string;

async function setupFolderBackedProject(): Promise<void> {
  projectDir = await createTempDir();
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "initial"', {
    cwd: projectDir,
    stdio: "pipe",
  });
  const init = kspecRun("init --no-prompt", projectDir, {
    env: { KSPEC_AUTHOR: "@test" },
  });
  if (init.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${init.stderr}`);
  }
}

async function seedSource(): Promise<void> {
  const uploadsDir = path.join(projectDir, "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  pngSource = path.join(uploadsDir, "shot.png");
  await fs.writeFile(pngSource, "fake-png-bytes-for-testing");
}

async function seedReview(): Promise<void> {
  reviewSlug = "resource-test";
  // Code subject keeps things simple and matches the existing review-cli tests.
  kspecOk(
    `review add --title 'Resource Test Review' --base abc123 --head def456 --slug ${reviewSlug}`,
    projectDir,
  );
}

beforeEach(async () => {
  await setupFolderBackedProject();
  await seedSource();
  await seedReview();
});

afterEach(async () => {
  await cleanupTempDir(projectDir);
});

// AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
// AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
describe("Integration: review resource add", () => {
  it("adds a screenshot resource and returns the expected JSON envelope", () => {
    const result = kspecJson<{
      resource: {
        id: string;
        path: string;
        content_type: string;
        bytes: number;
        sha256: string;
      };
      replaced: boolean;
    }>(
      `review resource add @${reviewSlug} ${pngSource} --id login-bug --path screenshots/login.png`,
      projectDir,
    );
    expect(result.replaced).toBe(false);
    expect(result.resource).toMatchObject({
      id: "login-bug",
      path: "screenshots/login.png",
      content_type: "image/png",
    });
    expect(result.resource.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("returns the documented JSON error envelope + exit code 1 on invalid id", () => {
    const result = kspecRun(
      `review resource add @${reviewSlug} ${pngSource} --id BadID! --path shot.png --json`,
      projectDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("invalid_resource_id");
    expect(envelope.resource_id).toBe("BadID!");
    expect(envelope).toHaveProperty("message");
    expect(envelope).toHaveProperty("path");
    expect(envelope).toHaveProperty("source_file");
  });

  it("returns review_not_found + exit code 1 when the review ref is unknown", () => {
    const result = kspecRun(
      `review resource add @no-such-review ${pngSource} --id shot --path shot.png --json`,
      projectDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("review_not_found");
  });

  it("returns source_file_missing + exit code 1 when the source file is missing", () => {
    const result = kspecRun(
      `review resource add @${reviewSlug} ${pngSource}.missing --id shot --path shot.png --json`,
      projectDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("source_file_missing");
    expect(envelope.source_file).toContain(".missing");
  });

  it("returns resource_conflict for duplicate ids without --replace", () => {
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );
    const conflict = kspecRun(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot2.png --json`,
      projectDir,
      { expectFail: true },
    );
    expect(conflict.exitCode).toBe(1);
    const envelope = JSON.parse(conflict.stderr.trim());
    expect(envelope.code).toBe("resource_conflict");
  });

  it("replaces an existing resource and returns replaced:true with --replace", () => {
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );
    const result = kspecJson<{ resource: { id: string }; replaced: boolean }>(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png --replace`,
      projectDir,
    );
    expect(result.replaced).toBe(true);
    expect(result.resource.id).toBe("shot");
  });
});

// AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
describe("Integration: review resource list/get", () => {
  it("lists added resources via --json", () => {
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );
    const result = kspecJson<{ resources: Array<{ id: string }> }>(
      `review resource list @${reviewSlug}`,
      projectDir,
    );
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].id).toBe("shot");
  });

  it("returns the full metadata for a single resource via get --json", () => {
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );
    const result = kspecJson<{
      resource: { id: string; path: string; content_type: string };
    }>(`review resource get @${reviewSlug} shot`, projectDir);
    expect(result.resource).toMatchObject({
      id: "shot",
      path: "shot.png",
      content_type: "image/png",
    });
  });

  it("returns resource_not_found + exit code 1 for unknown resource ids", () => {
    const result = kspecRun(`review resource get @${reviewSlug} nope --json`, projectDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("resource_not_found");
  });
});

// AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
describe("Integration: review resource remove", () => {
  it("removes a resource with --force in non-interactive mode and returns the removed identity", () => {
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );
    const result = kspecJson<{ removed: { id: string; path: string } }>(
      `review resource remove @${reviewSlug} shot --force`,
      projectDir,
    );
    expect(result.removed).toEqual({ id: "shot", path: "shot.png" });

    const list = kspecJson<{ resources: unknown[] }>(
      `review resource list @${reviewSlug}`,
      projectDir,
    );
    expect(list.resources).toEqual([]);
  });

  it("returns confirmation_required + exit code 1 when run non-interactively without --force", () => {
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );
    const result = kspecRun(
      `review resource remove @${reviewSlug} shot --json`,
      projectDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("confirmation_required");
  });
});
