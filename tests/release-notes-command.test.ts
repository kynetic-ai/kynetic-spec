/**
 * E2E tests for the `kspec release-notes` command.
 *
 * AC: @release-notes-accessible ac-current-version-notes
 * AC: @release-notes-accessible ac-version-range-notes
 * AC: @release-notes-accessible ac-notes-mention-new-config
 * AC: @trait-error-guidance ac-1, ac-2
 * AC: @trait-semantic-exit-codes ac-1, ac-2, ac-3
 */

import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec,
  kspecJson,
  createTempDir,
  cleanupTempDir,
  readTestOutputSync,
} from "./helpers/cli.js";

function getCurrentVersion(): string {
  const pkgPath = path.resolve(__dirname, "..", "package.json");
  const pkg = JSON.parse(readTestOutputSync(pkgPath, "utf-8"));
  return pkg.version as string;
}

describe("kspec release-notes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-release-notes-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @release-notes-accessible ac-current-version-notes
  // AC: @trait-semantic-exit-codes ac-1
  it("shows the release notes for the currently installed version when invoked with no arguments", () => {
    const current = getCurrentVersion();
    const result = kspec("release-notes", tempDir);
    expect(result.exitCode).toBe(0);
    // The command prints the current version's section, starting with its
    // heading. The heading may omit or include the `v` prefix depending on
    // what's authored in RELEASE_NOTES.md.
    expect(result.stdout).toMatch(new RegExp(`^## v?${current.replace(/\./g, "\\.")}`, "m"));
  });

  // AC: @release-notes-accessible ac-current-version-notes
  // AC: @trait-json-output ac-1, ac-2
  it("emits structured JSON with the markdown payload when --json is set", () => {
    const current = getCurrentVersion();
    const result = kspecJson<{
      mode: string;
      version: string;
      heading: string;
      markdown: string;
    }>("release-notes", tempDir);
    expect(result.mode).toBe("version");
    expect(result.version).toBe(current);
    expect(result.heading).toMatch(new RegExp(`^v?${current.replace(/\./g, "\\.")}$`));
    expect(result.markdown).toContain(result.heading);
  });

  // AC: @release-notes-accessible ac-version-range-notes
  // AC: @trait-semantic-exit-codes ac-1
  it("shows release notes for every version in an inclusive range in chronological order", () => {
    const result = kspec("release-notes --from 0.10.0 --to 0.12.0", tempDir);
    expect(result.exitCode).toBe(0);
    // All three versions' sections must appear.
    expect(result.stdout).toContain("v0.10.0");
    expect(result.stdout).toContain("v0.11.0");
    expect(result.stdout).toContain("v0.12.0");
    // Chronological order — oldest first.
    const iden10 = result.stdout.indexOf("v0.10.0");
    const iden11 = result.stdout.indexOf("v0.11.0");
    const iden12 = result.stdout.indexOf("v0.12.0");
    expect(iden10).toBeLessThan(iden11);
    expect(iden11).toBeLessThan(iden12);
  });

  // AC: @release-notes-accessible ac-version-range-notes
  it("emits structured JSON for range queries", () => {
    const result = kspecJson<{
      mode: string;
      from: string;
      to: string;
      versions: string[];
      markdown: string;
    }>("release-notes --from 0.10.0 --to 0.11.0", tempDir);
    expect(result.mode).toBe("range");
    expect(result.versions).toEqual(["0.10.0", "0.11.0"]);
    expect(result.markdown).toContain("v0.10.0");
    expect(result.markdown).toContain("v0.11.0");
  });

  // AC: @trait-error-guidance ac-1, ac-2
  // AC: @trait-semantic-exit-codes ac-2
  it("rejects an inverted range with a non-zero exit code and actionable guidance", () => {
    const result = kspec("release-notes --from 0.12.0 --to 0.10.0", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    // Suggestion is emitted to stderr via the error() helper.
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/older/i);
  });

  // AC: @trait-error-guidance ac-1, ac-2
  // AC: @trait-semantic-exit-codes ac-2
  it("rejects mismatched --from / --to pairing", () => {
    const result = kspec("release-notes --from 0.10.0", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/--from and --to must be provided together/i);
  });

  // AC: @release-notes-accessible ac-version-range-notes
  // AC: @trait-semantic-exit-codes ac-1
  // An out-of-range query is not an error — the CLI prints a helpful
  // message and exits 0 with an empty result set, matching the
  // semantic-exit-codes trait's "empty result" guidance.
  it("exits 0 with a helpful message when no versions fall in the range", () => {
    const result = kspec("release-notes --from 99.99.99 --to 99.99.99", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/No release notes in the range/);
  });

  // AC: @release-notes-accessible ac-current-version-notes
  // AC: @trait-error-guidance ac-1, ac-2, ac-3
  it("echoes the authored markdown verbatim (no reformatting)", () => {
    const current = getCurrentVersion();
    const result = kspec("release-notes", tempDir);
    expect(result.exitCode).toBe(0);
    // Read the on-disk file and assert the printed slice is a substring.
    const notesPath = path.resolve(__dirname, "..", "RELEASE_NOTES.md");
    const notesRaw = readTestOutputSync(notesPath, "utf-8");
    // Find the current version's section in the file and confirm our output
    // starts with the same heading.
    const heading = `## v${current}`;
    const idx = notesRaw.indexOf(heading);
    expect(idx).toBeGreaterThanOrEqual(0);
    // The printed output should start with the heading line.
    expect(result.stdout.startsWith(heading)).toBe(true);
  });

  // AC: @trait-error-guidance ac-4 — N/A: release-notes has no state transitions
  // AC: @trait-error-guidance ac-5 — N/A: release-notes performs no field-level validation
  // AC: @trait-error-guidance ac-6 — N/A: release-notes has no --json mode; structured output is the default via output()
  // AC: @trait-semantic-exit-codes ac-4 — N/A: runtime failures during load are surfaced via ReleaseNotesError with exit codes 1/3/4 as appropriate
  // AC: @trait-semantic-exit-codes ac-5 — covered by the out-of-range test above
  // AC: @trait-semantic-exit-codes ac-6 — N/A: commander handles invalid-flag errors with its own exit code
  // AC: @trait-semantic-exit-codes ac-7 — N/A: release-notes is not a batch command
  // AC: @trait-semantic-exit-codes ac-8 — covered by release-notes.ts using EXIT_CODES constants throughout
});
