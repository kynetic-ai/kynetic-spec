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

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("returns invalid_resource_id + the documented JSON envelope when --id is missing", () => {
    // Commander's requiredOption would normally fail before the action runs
    // and bypass the JSON contract; the CLI must validate --id inside the
    // action so --json callers always receive the documented envelope.
    const result = kspecRun(
      `review resource add @${reviewSlug} ${pngSource} --path shot.png --json`,
      projectDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("invalid_resource_id");
    expect(envelope).toHaveProperty("message");
    expect(envelope).toHaveProperty("resource_id", null);
    expect(envelope).toHaveProperty("path", "shot.png");
    expect(envelope).toHaveProperty("source_file");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("returns invalid_resource_path + the documented JSON envelope when --path is missing", () => {
    const result = kspecRun(
      `review resource add @${reviewSlug} ${pngSource} --id shot --json`,
      projectDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("invalid_resource_path");
    expect(envelope).toHaveProperty("resource_id", "shot");
    expect(envelope).toHaveProperty("path", null);
    expect(envelope).toHaveProperty("source_file");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("returns invalid_resource_path + exit code 1 when --content-type is malformed", () => {
    // The documented CLI failure codes do NOT include invalid_content_type.
    // Malformed explicit content_type maps to invalid_resource_path (the
    // documented path-shaped code) with the relative path attached.
    const result = kspecRun(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png --content-type 'not a mime' --json`,
      projectDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("invalid_resource_path");
    expect(envelope.path).toBe("shot.png");
    expect(envelope.resource_id).toBe("shot");
    expect(envelope.message).toMatch(/content_type/);
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

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("returns source_file_unreadable + exit code 1 for a regular file with no read permissions (chmod 000)", async () => {
    // The original implementation only used stat().isFile() to gate source
    // validity. A chmod 000 regular file passed that check; fs.copyFile
    // inside the manager then threw EACCES, which the CLI mapped through
    // its unexpected-error handler to exit code 3 with
    // entity_storage_incompatible — masking the documented
    // source_file_unreadable code and validation exit code 1.
    //
    // This is the second documented source_file_unreadable variant
    // alongside "not a regular file" (directory). Both must surface
    // through the same envelope + exit code so the CLI contract is
    // closed.
    if (process.platform === "win32" || process.getuid?.() === 0) {
      // chmod 000 has no effect for root or on platforms without POSIX
      // permission semantics; skip rather than produce a flaky test.
      return;
    }
    const unreadable = path.join(projectDir, "uploads", "unreadable.png");
    await fs.writeFile(unreadable, "private-bytes");
    await fs.chmod(unreadable, 0o000);
    try {
      const result = kspecRun(
        `review resource add @${reviewSlug} ${unreadable} --id shot --path shot.png --json`,
        projectDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(result.stderr.trim());
      expect(envelope.code).toBe("source_file_unreadable");
      expect(envelope.source_file).toBe(unreadable);
      expect(envelope.message).toMatch(/readable|permission/i);
    } finally {
      // Restore permissions so the temp dir can be cleaned up.
      await fs.chmod(unreadable, 0o600).catch(() => {});
    }
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
  it("returns source_file_unreadable + exit code 1 when the source path is a directory", async () => {
    // The manager rejects non-regular files (directories, devices, etc.)
    // with the documented source_file_unreadable code. Coverage at the
    // manager layer alone would miss a regression in CLI error mapping
    // for this case, so this test invokes the CLI end-to-end against a
    // directory source and asserts the full envelope + exit code.
    const dirSource = path.join(projectDir, "uploads", "not-a-file");
    await fs.mkdir(dirSource, { recursive: true });
    const result = kspecRun(
      `review resource add @${reviewSlug} ${dirSource} --id shot --path shot.png --json`,
      projectDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("source_file_unreadable");
    expect(envelope.source_file).toBe(dirSource);
    expect(envelope.message).toMatch(/not a regular file/i);
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

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("returns invalid_resource_id + exit code 1 for malformed resource ids on get", () => {
    // Malformed IDs must surface as invalid_resource_id rather than
    // resource_not_found so consumers can distinguish "this id is illegal"
    // from "this id was never declared".
    const result = kspecRun(`review resource get @${reviewSlug} BadID! --json`, projectDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("invalid_resource_id");
    expect(envelope.resource_id).toBe("BadID!");
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
    const result = kspecRun(`review resource remove @${reviewSlug} shot --json`, projectDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("confirmation_required");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  it("returns invalid_resource_id + exit code 1 for malformed resource ids on remove", () => {
    const result = kspecRun(
      `review resource remove @${reviewSlug} Bad-ID! --force --json`,
      projectDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("invalid_resource_id");
    expect(envelope.resource_id).toBe("Bad-ID!");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  it("returns operation_cancelled + exit code 2 when the interactive prompt is answered 'no' and leaves the resource intact", () => {
    // Interactive cancellation is the third leg of the documented remove
    // contract (alongside --force success and non-interactive
    // confirmation_required). Coverage at the manager layer cannot catch
    // a regression here because the prompt/cancel/exit-code wiring is
    // CLI-only: it lives entirely in src/cli/commands/review-resource.ts
    // remove action's readline branch.
    //
    // The CLI detects interactive mode via KSPEC_TEST_TTY=true OR
    // process.stdin.isTTY. spawnSync's piped stdin always has isTTY=false,
    // so the env var is the way to assert this code path under test.
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );

    const cancel = kspecRun(`review resource remove @${reviewSlug} shot`, projectDir, {
      stdin: "n",
      env: { KSPEC_TEST_TTY: "true" },
      expectFail: true,
    });
    expect(cancel.exitCode).toBe(2);
    expect(cancel.stderr).toMatch(/cancel/i);
    expect(cancel.stderr).toMatch(/shot/);

    // The resource must still be present — cancellation must not leak any
    // deletion side effect.
    const list = kspecJson<{ resources: Array<{ id: string }> }>(
      `review resource list @${reviewSlug}`,
      projectDir,
    );
    expect(list.resources).toHaveLength(1);
    expect(list.resources[0].id).toBe("shot");
  });
});

// ── Post-Mutation Index Consistency ──────────────────────────────────────────
//
// Every review resource mutation that changes the bounded resource_summary
// projection (count, total_bytes) must update the lean index in the same
// logical mutation. Rebuild-index is a recovery tool, not the expected
// follow-up after normal commands.
//
// AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
// AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection

describe("Integration: review resource post-mutation index consistency", () => {
  // The module-level beforeEach/afterEach already set up the temp project,
  // pngSource, and reviewSlug — no per-describe setup is needed.

  function expectCleanReviewRebuildDryRun(label: string): void {
    const result = kspecRun("review rebuild-index --dry-run --json", projectDir);
    expect(result.exitCode, `${label}: ${result.stderr || result.stdout}`).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status, `${label}: status`).toBe("clean");
    expect(envelope.changes, `${label}: changes`).toEqual([]);
    expect(envelope.conflicts, `${label}: conflicts`).toEqual([]);
  }

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("review resource add: resource_summary is recorded in the same mutation", () => {
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );
    expectCleanReviewRebuildDryRun("after review resource add");
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("review resource add --replace: total_bytes change is recorded in the same mutation", async () => {
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );
    const next = path.join(projectDir, "next.png");
    await fs.writeFile(next, "PNG_BYTES_REPLACED_LONGER");
    kspecOk(
      `review resource add @${reviewSlug} ${next} --id shot --path shot.png --replace`,
      projectDir,
    );
    expectCleanReviewRebuildDryRun("after review resource add --replace");
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("review resource remove: resource_summary drops in the same mutation", () => {
    kspecOk(
      `review resource add @${reviewSlug} ${pngSource} --id shot --path shot.png`,
      projectDir,
    );
    const remove = kspecRun(
      `review resource remove @${reviewSlug} shot --force --json`,
      projectDir,
    );
    expect(remove.exitCode).toBe(0);
    expectCleanReviewRebuildDryRun("after review resource remove");
  });
});
