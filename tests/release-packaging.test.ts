/**
 * Tests for release packaging completeness.
 * Spec: @published-artifact-completeness
 *
 * Verifies the packed npm artifact ships with everything a consumer needs.
 * Created by @task-add-license-file (license coverage, ac-1); later
 * release-packaging tasks extend this file with further completeness checks.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestSubprocessEnv } from "./helpers/cli";
import packageJson from "../package.json" with { type: "json" };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Entry in `npm pack --json` output's `files` array. */
interface PackFileEntry {
  path: string;
  size: number;
  mode: number;
}

interface PackResult {
  files: PackFileEntry[];
}

describe("Release packaging", () => {
  // AC: @published-artifact-completeness ac-1
  it("includes LICENSE at the package root when packed for publication", () => {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 120_000,
      env: buildTestSubprocessEnv(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    // The prepack lifecycle script prints progress lines to stdout before
    // npm emits the JSON array, so parse from the array's opening bracket.
    const stdout = result.stdout;
    const jsonStart = stdout.indexOf("[");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(stdout.slice(jsonStart)) as PackResult[];

    const paths = parsed[0].files.map((file) => file.path);
    expect(paths).toContain("LICENSE");
  }, 180_000);

  // AC: @published-artifact-completeness ac-1
  it("declares the MIT license identifier in the package manifest", () => {
    expect(packageJson.license).toBe("MIT");
  });

  // AC: @published-artifact-completeness ac-1
  it("ships license terms that match the declared MIT identifier", () => {
    // eslint-disable-next-line no-source-scanning/no-source-file-reads -- The LICENSE text is the release artifact under test: ac-1 requires its terms to match the declared license identifier, which can only be verified by inspecting the artifact itself.
    const licenseText = readFileSync(join(REPO_ROOT, "LICENSE"), "utf-8");
    const headerLines = licenseText.split("\n").slice(0, 3);
    expect(headerLines[0]).toBe("MIT License");
    expect(headerLines[2]).toContain("Copyright (c)");
    expect(headerLines[2]).toContain("Kynetic AI");
  });
});
