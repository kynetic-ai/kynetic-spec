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

  // AC: @static-export-resource-assets-complete ac-static-review-image-asset-exists
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

  // AC: @static-export-resource-assets-complete ac-static-review-doc-asset-exists
  it("copies a review document resource to assets/resources/review/<ulid>/<path>", async () => {
    const uploadsDir = path.join(projectDir, "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    const docSource = path.join(uploadsDir, "notes.md");
    await fs.writeFile(docSource, "# Review notes\n\nDocument evidence.\n");

    const slug = "doc-export-test";
    kspecOk(
      `review add --title 'Doc Export Review' --base abc123 --head def456 --slug ${slug}`,
      projectDir,
    );
    kspecOk(
      `review resource add @${slug} ${docSource} --id notes-doc --path docs/notes.md --label Notes`,
      projectDir,
    );
    const reviewUlid = (
      JSON.parse(kspecRun(`review get @${slug} --json`, projectDir).stdout) as { _ulid: string }
    )._ulid;

    const exportDir = path.join(projectDir, "build");
    await fs.mkdir(exportDir, { recursive: true });
    const outputFile = path.join(exportDir, "snapshot.json");
    const result = kspecRun(`export --format json --output ${outputFile}`, projectDir);
    expect(result.exitCode).toBe(0);

    const snapshot = JSON.parse(await fs.readFile(outputFile, "utf-8")) as {
      reviews?: Array<{ _ulid: string; resources: Array<{ id: string; exported_path: string }> }>;
    };
    const exported = snapshot.reviews!.find((r) => r._ulid === reviewUlid)!;
    const docResource = exported.resources.find((r) => r.id === "notes-doc")!;
    expect(docResource.exported_path).toBe(`assets/resources/review/${reviewUlid}/docs/notes.md`);

    const assetPath = path.join(exportDir, docResource.exported_path);
    const bytes = await fs.readFile(assetPath);
    expect(bytes.toString("utf-8")).toBe("# Review notes\n\nDocument evidence.\n");
  });

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  // AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
  //
  // The resource path validator only rejects absolute paths, traversal,
  // backslashes, empty/dot segments, and trailing slashes — URL-reserved
  // characters such as `#` and `?` are legitimate filename characters and
  // can land in a valid exported_path. This test exercises the full
  // static-export round-trip for a `#`/`?` resource path: file copy
  // succeeds, snapshot's exported_path carries the raw POSIX path, and
  // the URL the web UI would construct (base + encoded exported_path)
  // resolves with the `#` / `?` escaped so the browser does not parse
  // them as a fragment or query string.
  it("round-trips a resource path containing # and ? through static export", async () => {
    const uploadsDir = path.join(projectDir, "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    const evidenceSource = path.join(uploadsDir, "evidence.png");
    await fs.writeFile(evidenceSource, "fake-png-bytes-for-fragment-export");

    const slug = "frag-export-test";
    kspecOk(
      `review add --title 'Fragment Export Review' --base abc123 --head def456 --slug ${slug}`,
      projectDir,
    );
    // Single-quote both the source path and the destination resource path so
    // the shell does not interpret `#` as a comment delimiter or `?` as a
    // glob. The destination path is the on-disk file name inside the
    // review's resources/ tree and exactly mirrors what the schema allows.
    const fragmentPath = "screenshots/login#bug?ref.png";
    kspecOk(
      `review resource add @${slug} '${evidenceSource}' --id evidence --path '${fragmentPath}' --label Evidence`,
      projectDir,
    );

    const getResult = kspecRun(`review get @${slug} --json`, projectDir);
    const reviewUlid = (JSON.parse(getResult.stdout) as { _ulid: string })._ulid;

    const exportDir = path.join(projectDir, "build");
    await fs.mkdir(exportDir, { recursive: true });
    const outputFile = path.join(exportDir, "snapshot.json");

    const result = kspecRun(`export --format json --output ${outputFile}`, projectDir);
    expect(result.exitCode).toBe(0);

    // The snapshot's exported_path stays a raw POSIX path because the
    // export pipeline serves both as a file pointer and as input to the
    // client-side URL encoder; encoding at export time would break the
    // on-disk asset lookup the static host performs.
    const snapshot = JSON.parse(await fs.readFile(outputFile, "utf-8")) as {
      reviews?: Array<{
        _ulid: string;
        resources: Array<{ id: string; path: string; exported_path: string }>;
      }>;
    };
    const exported = snapshot.reviews!.find((r) => r._ulid === reviewUlid)!;
    expect(exported.resources).toHaveLength(1);
    expect(exported.resources[0]).toMatchObject({
      id: "evidence",
      path: fragmentPath,
      exported_path: `assets/resources/review/${reviewUlid}/${fragmentPath}`,
    });

    // The asset file actually lands at the documented on-disk path,
    // including the `#` and `?` in the filename.
    const assetPath = path.join(
      exportDir,
      "assets",
      "resources",
      "review",
      reviewUlid,
      "screenshots",
      "login#bug?ref.png",
    );
    const bytes = await fs.readFile(assetPath);
    expect(bytes.toString("utf-8")).toBe("fake-png-bytes-for-fragment-export");

    // The URL the web UI builds from this snapshot must encode the path
    // so the browser does not interpret `#` as a fragment or `?` as a
    // query string. Build the URL the same way the Svelte page does
    // (base + per-segment-encoded exported_path) and verify it parses
    // cleanly.
    const encoded = exported.resources[0].exported_path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const url = new URL(`https://example.com/site/${encoded}`);
    expect(url.pathname).toBe(
      `/site/assets/resources/review/${reviewUlid}/screenshots/login%23bug%3Fref.png`,
    );
    expect(url.hash).toBe("");
    expect(url.search).toBe("");
  });
});
