/**
 * Format version ceiling — forward-compatibility refusal at context
 * initialization.
 *
 * Project data declaring a `kynetic` format version newer than the running
 * tool's maximum supported version is refused with a deterministic error
 * code before any project data is read, mutated, or synchronized.
 * Unrecognized declared versions are refused rather than treated as the
 * oldest format. The doctor diagnostic is the sole exempt surface, and the
 * upgrade flow refuses before any step executes.
 *
 * Spec: @data-format-forward-compatibility
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import {
  kspec,
  createTempDir,
  cleanupTempDir,
  findManifestFileInDir,
  initGitRepo,
  readTestOutput,
  setupTempFixtures,
} from "./helpers/cli.js";
import {
  describeFormatVersionIncompatibility,
  FormatVersionCompatibilityError,
  FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE,
  UNRECOGNIZED_FORMAT_VERSION_CODE,
  MAX_SUPPORTED_KYNETIC_VERSION,
} from "../src/parser/format-version.js";
import { detectSourceVersion } from "../src/cli/commands/upgrade.js";

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Rewrite the `kynetic:` line of a manifest file to the given raw YAML value. */
async function setManifestVersionLine(manifestPath: string, rawYamlValue: string): Promise<void> {
  // Test-generated fixture manifest, rewritten to simulate a future format
  const raw = await readTestOutput(manifestPath);
  if (!/^kynetic:/m.test(raw)) {
    throw new Error(`setManifestVersionLine: no kynetic field in ${manifestPath}`);
  }
  const updated = raw.replace(/^kynetic:.*$/m, `kynetic: ${rawYamlValue}`);
  await fs.writeFile(manifestPath, updated, "utf-8");
}

/** Remove the `kynetic:` line entirely (missing-field legacy case). */
async function removeManifestVersionLine(manifestPath: string): Promise<void> {
  // Test-generated fixture manifest, rewritten to simulate a legacy manifest
  const raw = await readTestOutput(manifestPath);
  const updated = raw
    .split("\n")
    .filter((line) => !line.startsWith("kynetic:"))
    .join("\n");
  await fs.writeFile(manifestPath, updated, "utf-8");
}

interface FileSnapshot {
  content: string;
  mtimeMs: number;
}

/**
 * Snapshot all project files (content + mtime) under a directory, excluding
 * test-harness scaffolding. Used to assert the no-modification guarantee.
 */
async function snapshotProjectFiles(dir: string): Promise<Map<string, FileSnapshot>> {
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
        // Test-generated fixture files, snapshotted to prove the refusal
        // modified nothing (the spec's no-modification guarantee)
        const content = await readTestOutput(fullPath);
        snapshot.set(path.relative(dir, fullPath), { content, mtimeMs: stat.mtimeMs });
      }
    }
  };
  await walk(dir);
  return snapshot;
}

function expectSnapshotsEqual(
  before: Map<string, FileSnapshot>,
  after: Map<string, FileSnapshot>,
): void {
  expect([...after.keys()].toSorted()).toEqual([...before.keys()].toSorted());
  for (const [file, beforeState] of before) {
    const afterState = after.get(file);
    expect(afterState, `file ${file} should still exist`).toBeDefined();
    expect(afterState!.content, `content of ${file} should be unchanged`).toBe(beforeState.content);
    expect(afterState!.mtimeMs, `mtime of ${file} should be unchanged`).toBe(beforeState.mtimeMs);
  }
}

// ─── Unit: describeFormatVersionIncompatibility ─────────────────────────────

describe("describeFormatVersionIncompatibility", () => {
  // AC: @data-format-forward-compatibility ac-newer-version-refused
  it("refuses a declared version newer than the maximum supported", () => {
    const err = describeFormatVersionIncompatibility("9.9");
    expect(err).toBeInstanceOf(FormatVersionCompatibilityError);
    expect(err!.code).toBe(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
    expect(err!.declaredVersion).toBe("9.9");
    expect(err!.maxSupportedVersion).toBe(MAX_SUPPORTED_KYNETIC_VERSION);
    // The refusal names both versions and includes upgrade guidance
    expect(err!.message).toContain('"9.9"');
    expect(err!.message).toContain(`"${MAX_SUPPORTED_KYNETIC_VERSION}"`);
    expect(err!.message).toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
    expect(err!.suggestion).toMatch(/upgrade/i);
  });

  // AC: @data-format-forward-compatibility ac-newer-version-refused
  it("refuses the next minor version above the ceiling", () => {
    const err = describeFormatVersionIncompatibility("1.3");
    expect(err?.code).toBe(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
  });

  // AC: @data-format-forward-compatibility ac-unrecognized-version-refused
  it("refuses unrecognized version values naming the literal, never treating them as oldest", () => {
    const err = describeFormatVersionIncompatibility("not-a-version");
    expect(err).toBeInstanceOf(FormatVersionCompatibilityError);
    expect(err!.code).toBe(UNRECOGNIZED_FORMAT_VERSION_CODE);
    expect(err!.message).toContain('"not-a-version"');
    expect(err!.suggestion).toMatch(/upgrade/i);
  });

  // AC: @data-format-forward-compatibility ac-unrecognized-version-refused
  it("refuses non-string declared values that cannot be interpreted as versions", () => {
    expect(describeFormatVersionIncompatibility("")?.code).toBe(UNRECOGNIZED_FORMAT_VERSION_CODE);
    expect(describeFormatVersionIncompatibility(true)?.code).toBe(UNRECOGNIZED_FORMAT_VERSION_CODE);
    expect(describeFormatVersionIncompatibility({ value: "1.0" })?.code).toBe(
      UNRECOGNIZED_FORMAT_VERSION_CODE,
    );
  });

  // AC: @data-format-forward-compatibility ac-newer-version-refused
  it("refuses an unquoted YAML numeric version above the ceiling", () => {
    expect(describeFormatVersionIncompatibility(9.9)?.code).toBe(
      FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE,
    );
  });

  // AC: @data-format-forward-compatibility ac-supported-versions-unaffected
  it("passes all supported versions and the missing-field case", () => {
    expect(describeFormatVersionIncompatibility("1.0")).toBeNull();
    expect(describeFormatVersionIncompatibility("1.1")).toBeNull();
    expect(describeFormatVersionIncompatibility(MAX_SUPPORTED_KYNETIC_VERSION)).toBeNull();
    expect(describeFormatVersionIncompatibility(undefined)).toBeNull();
    expect(describeFormatVersionIncompatibility(null)).toBeNull();
  });
});

// ─── CLI: context-initialization refusal (traditional mode) ─────────────────

describe("format version ceiling — CLI refusal", () => {
  let tempDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    manifestPath = path.join(tempDir, "kynetic.yaml");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @data-format-forward-compatibility ac-newer-version-refused
  it("refuses a read command with the deterministic code and modifies nothing", async () => {
    await setManifestVersionLine(manifestPath, '"9.9"');
    const before = await snapshotProjectFiles(tempDir);

    const result = kspec("item list", tempDir, { expectFail: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
    expect(result.stderr).toContain('"9.9"');
    expect(result.stderr).toContain(`"${MAX_SUPPORTED_KYNETIC_VERSION}"`);
    expect(result.stderr).toMatch(/upgrade/i);

    const after = await snapshotProjectFiles(tempDir);
    expectSnapshotsEqual(before, after);
  });

  // AC: @data-format-forward-compatibility ac-newer-version-refused
  it("refuses a write command with the deterministic code and modifies nothing", async () => {
    await setManifestVersionLine(manifestPath, '"9.9"');
    const before = await snapshotProjectFiles(tempDir);

    const result = kspec('inbox add "an idea that must not land"', tempDir, { expectFail: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
    expect(result.stderr).toContain('"9.9"');
    expect(result.stderr).toContain(`"${MAX_SUPPORTED_KYNETIC_VERSION}"`);

    const after = await snapshotProjectFiles(tempDir);
    expectSnapshotsEqual(before, after);
  });

  // AC: @data-format-forward-compatibility ac-unrecognized-version-refused
  it("refuses an unrecognized version value naming the literal", async () => {
    await setManifestVersionLine(manifestPath, '"mystery-format"');

    const result = kspec("item list", tempDir, { expectFail: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(UNRECOGNIZED_FORMAT_VERSION_CODE);
    expect(result.stderr).toContain('"mystery-format"');
  });

  // AC: @data-format-forward-compatibility ac-supported-versions-unaffected
  it("does not refuse a manifest at the maximum supported version", async () => {
    await setManifestVersionLine(manifestPath, `"${MAX_SUPPORTED_KYNETIC_VERSION}"`);
    // A 1.2 manifest must declare folder-backed entity storage to satisfy
    // the existing storage gates this AC says remain in charge.
    await fs.appendFile(
      manifestPath,
      "\nplan_storage:\n  format: folder\nreview_storage:\n  format: folder\nresource_storage:\n  format: entity_scoped\n",
      "utf-8",
    );

    const result = kspec("item list", tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
    expect(result.stderr).not.toContain(UNRECOGNIZED_FORMAT_VERSION_CODE);
  });

  // AC: @data-format-forward-compatibility ac-supported-versions-unaffected
  it("does not refuse an older supported version (fixture default 1.1)", async () => {
    const result = kspec("item list", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
  });

  // AC: @data-format-forward-compatibility ac-supported-versions-unaffected
  it("keeps legacy handling for a manifest with no declared format version", async () => {
    await removeManifestVersionLine(manifestPath);

    const result = kspec("item list", tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
    expect(result.stderr).not.toContain(UNRECOGNIZED_FORMAT_VERSION_CODE);
  });

  // AC: @data-format-forward-compatibility ac-upgrade-refuses-newer
  it("refuses kspec upgrade before any step executes", async () => {
    await setManifestVersionLine(manifestPath, '"9.9"');
    const before = await snapshotProjectFiles(tempDir);

    const result = kspec("upgrade", tempDir, { expectFail: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
    expect(result.stderr).toContain('"9.9"');
    expect(result.stderr).toContain(`"${MAX_SUPPORTED_KYNETIC_VERSION}"`);
    // No upgrade step ran — nothing on disk changed
    const after = await snapshotProjectFiles(tempDir);
    expectSnapshotsEqual(before, after);
  });
});

// ─── Unit: upgrade probe inference (defense in depth) ───────────────────────

describe("detectSourceVersion — format version ceiling", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempDir();
    await fs.mkdir(path.join(projectDir, ".kspec"), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(projectDir);
  });

  // AC: @data-format-forward-compatibility ac-upgrade-refuses-newer
  it("classifies a newer-than-supported manifest as a refusal, not an old era", async () => {
    await fs.writeFile(
      path.join(projectDir, ".kspec", "kynetic.yaml"),
      'kynetic: "9.9"\nproject:\n  name: Newer\n  version: "0.1.0"\n  status: draft\n',
      "utf-8",
    );

    await expect(detectSourceVersion(path.join(projectDir, ".kspec"), projectDir)).rejects.toThrow(
      FormatVersionCompatibilityError,
    );
    await expect(
      detectSourceVersion(path.join(projectDir, ".kspec"), projectDir),
    ).rejects.toMatchObject({
      code: FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE,
      declaredVersion: "9.9",
      maxSupportedVersion: MAX_SUPPORTED_KYNETIC_VERSION,
    });
  });

  // AC: @data-format-forward-compatibility ac-supported-versions-unaffected
  it("still infers an era for a supported manifest version", async () => {
    await fs.writeFile(
      path.join(projectDir, ".kspec", "kynetic.yaml"),
      'kynetic: "1.2"\nproject:\n  name: Current\n  version: "0.1.0"\n  status: draft\n',
      "utf-8",
    );

    const result = await detectSourceVersion(path.join(projectDir, ".kspec"), projectDir);
    expect(result.confidence).toBe("approximate");
    expect(result.version).toBe("0.14.0");
  });
});

// ─── Doctor exemption + shadow-mode refusal (real kspec init project) ───────

// Requires git >= 2.42 for --orphan worktree support and the built CLI
const projectCli = path.resolve(__dirname, "..", "dist", "cli", "index.js");
const canRunShadowTests = (() => {
  try {
    const version = execSync("git --version", { encoding: "utf-8" }).trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor] = match.map(Number);
    const gitSupportsOrphan = major > 2 || (major === 2 && minor >= 42);
    return gitSupportsOrphan && existsSync(projectCli);
  } catch {
    return false;
  }
})();

describe.skipIf(!canRunShadowTests)(
  "format version ceiling — doctor exemption and shadow mode",
  () => {
    let projectDir: string;

    beforeAll(async () => {
      projectDir = await createTempDir();
      initGitRepo(projectDir);
      await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
      execSync('git add README.md && git commit -m "initial"', { cwd: projectDir, stdio: "pipe" });

      const init = kspec("init --no-prompt", projectDir, { env: { KSPEC_AUTHOR: "@test" } });
      if (init.exitCode !== 0) {
        throw new Error(`kspec init failed: ${init.stderr}`);
      }

      // Simulate a project written by a future kspec
      const manifestPath = await findManifestFileInDir(path.join(projectDir, ".kspec"));
      if (!manifestPath) {
        throw new Error("kspec init did not create a manifest in .kspec/");
      }
      await setManifestVersionLine(manifestPath, '"9.9"');
    }, 60_000);

    afterAll(async () => {
      await cleanupTempDir(projectDir);
    });

    // AC: @data-format-forward-compatibility ac-diagnostics-report-read-only
    it("doctor completes read-only and reports the mismatch with both versions", async () => {
      const before = await snapshotProjectFiles(path.join(projectDir, ".kspec"));

      const result = kspec("doctor --json", projectDir, { expectFail: true });

      // Doctor completes with a full report (exit code reflects the error
      // severity of the reported mismatch, not a refusal to run)
      const report = JSON.parse(result.stdout) as {
        setup: {
          checks: Array<{ name: string; severity: string; message: string; guidance?: string }>;
        };
      };
      const check = report.setup.checks.find((c) => c.name === "format-version");
      expect(check).toBeDefined();
      expect(check!.severity).toBe("error");
      expect(check!.message).toContain('"9.9"');
      expect(check!.message).toContain(`"${MAX_SUPPORTED_KYNETIC_VERSION}"`);
      expect(check!.guidance).toMatch(/upgrade/i);

      // Read-only: nothing under .kspec changed
      const after = await snapshotProjectFiles(path.join(projectDir, ".kspec"));
      expectSnapshotsEqual(before, after);
    });

    // AC: @data-format-forward-compatibility ac-newer-version-refused
    it("shadow-mode commands refuse before any sync side effect and modify nothing", async () => {
      const before = await snapshotProjectFiles(path.join(projectDir, ".kspec"));

      const result = kspec("task list", projectDir, { expectFail: true });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE);
      expect(result.stderr).toContain('"9.9"');
      expect(result.stderr).toContain(`"${MAX_SUPPORTED_KYNETIC_VERSION}"`);

      const after = await snapshotProjectFiles(path.join(projectDir, ".kspec"));
      expectSnapshotsEqual(before, after);
    });
  },
);
