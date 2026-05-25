/**
 * Static export integration tests for review resources.
 *
 * Verifies that `kspec export --format json --output <file>` includes the
 * review's resource metadata with `exported_path` pointing at the copied
 * asset, and that the asset file actually lands at the documented
 * `assets/resources/review/<review-ulid>/<relative-path>` location.
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
  kspecOutput as kspecOk,
} from "./helpers/cli.js";

let projectDir: string;
let pngSource: string;
let reviewSlug: string;

async function setupProject(): Promise<void> {
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

async function seedScreenshotReview(): Promise<string> {
  const uploadsDir = path.join(projectDir, "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  pngSource = path.join(uploadsDir, "shot.png");
  await fs.writeFile(pngSource, "fake-png-bytes-for-export");

  reviewSlug = "export-test";
  kspecOk(
    `review add --title 'Export Test Review' --base abc123 --head def456 --slug ${reviewSlug}`,
    projectDir,
  );
  kspecOk(
    `review resource add @${reviewSlug} ${pngSource} --id login-bug --path screenshots/login.png --label Login`,
    projectDir,
  );

  // Look up the review's ULID for path assertions.
  const getResult = kspecRun(`review get @${reviewSlug} --json`, projectDir);
  const review = JSON.parse(getResult.stdout) as { _ulid: string };
  return review._ulid;
}

beforeEach(async () => {
  await setupProject();
});

afterEach(async () => {
  await cleanupTempDir(projectDir);
});

// AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
// AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
describe("kspec export --format json --output <file>", () => {
  it("includes review resources with exported_path in the snapshot", async () => {
    const reviewUlid = await seedScreenshotReview();
    const exportDir = path.join(projectDir, "build");
    await fs.mkdir(exportDir, { recursive: true });
    const outputFile = path.join(exportDir, "snapshot.json");

    const result = kspecRun(`export --format json --output ${outputFile}`, projectDir);
    expect(result.exitCode).toBe(0);

    const snapshot = JSON.parse(await fs.readFile(outputFile, "utf-8")) as {
      reviews?: Array<{
        _ulid: string;
        resources: Array<{
          id: string;
          path: string;
          content_type: string;
          exported_path: string;
        }>;
      }>;
    };
    expect(snapshot.reviews).toBeDefined();
    const exported = snapshot.reviews!.find((r) => r._ulid === reviewUlid);
    expect(exported).toBeDefined();
    expect(exported!.resources).toHaveLength(1);
    expect(exported!.resources[0]).toMatchObject({
      id: "login-bug",
      path: "screenshots/login.png",
      content_type: "image/png",
      exported_path: `assets/resources/review/${reviewUlid}/screenshots/login.png`,
    });
  });

  it("copies resource bytes to assets/resources/review/<ulid>/<path>", async () => {
    const reviewUlid = await seedScreenshotReview();
    const exportDir = path.join(projectDir, "build");
    await fs.mkdir(exportDir, { recursive: true });
    const outputFile = path.join(exportDir, "snapshot.json");

    const result = kspecRun(`export --format json --output ${outputFile}`, projectDir);
    expect(result.exitCode).toBe(0);

    const assetPath = path.join(
      exportDir,
      "assets",
      "resources",
      "review",
      reviewUlid,
      "screenshots",
      "login.png",
    );
    const bytes = await fs.readFile(assetPath);
    expect(bytes.toString("utf-8")).toBe("fake-png-bytes-for-export");
  });
});
