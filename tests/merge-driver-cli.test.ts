/**
 * Tests for merge-driver CLI command.
 *
 * Spec: @merge-driver-cli
 *
 * Covers:
 * - AC-1: Git standard arguments (%O %A %B %L %P) and file I/O
 * - AC-2: stderr summary of merge results
 * - AC-3: --non-interactive mode writes conflicts as YAML comments
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { kspec, type KspecResult } from "./helpers/cli.js";

describe("merge-driver CLI", () => {
  let tempDir: string;
  let baseFile: string;
  let oursFile: string;
  let theirsFile: string;

  beforeEach(async () => {
    // Create temp directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-merge-test-"));
    baseFile = path.join(tempDir, "base.yaml");
    oursFile = path.join(tempDir, "ours.yaml");
    theirsFile = path.join(tempDir, "theirs.yaml");
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // AC: @merge-driver-cli ac-1
  it("should read base, ours, theirs and write merged result to ours path", async () => {
    // Base version
    await fs.writeFile(
      baseFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Original task"
    priority: 3
`,
    );

    // Ours version - modified priority
    await fs.writeFile(
      oursFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Original task"
    priority: 1
`,
    );

    // Theirs version - modified title
    await fs.writeFile(
      theirsFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Updated task title"
    priority: 3
`,
    );

    // Run merge driver
    const result = kspec(
      `merge-driver ${baseFile} ${oursFile} ${theirsFile}`,
      tempDir,
    );

    // Should exit with code 0 (clean merge, no conflicts)
    expect(result.exitCode).toBe(0);

    // Read merged result from ours path
    const merged = await fs.readFile(oursFile, "utf-8");

    // Should have both changes: title from theirs, priority from ours
    // Note: YAML may or may not quote the string depending on content
    expect(merged).toMatch(/title:\s+(")?Updated task title(")?/);
    expect(merged).toContain("priority: 1");
  });

  // AC: @merge-driver-cli ac-2
  it("should show merge summary on stderr for successful merge", async () => {
    // Simple non-conflicting merge
    await fs.writeFile(baseFile, "kynetic: '1.0'\nfield: base");
    await fs.writeFile(oursFile, "kynetic: '1.0'\nfield: base\nadded_ours: ours");
    await fs.writeFile(
      theirsFile,
      "kynetic: '1.0'\nfield: base\nadded_theirs: theirs",
    );

    const result = kspec(
      `merge-driver ${baseFile} ${oursFile} ${theirsFile}`,
      tempDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Merged successfully");
    expect(result.stderr).toContain("no conflicts");
  });

  // AC: @merge-driver-cli ac-2
  it("should show conflict summary on stderr when conflicts occur", async () => {
    // Conflicting merge - both modify same field
    await fs.writeFile(baseFile, "kynetic: '1.0'\ntitle: base");
    await fs.writeFile(oursFile, "kynetic: '1.0'\ntitle: ours value");
    await fs.writeFile(theirsFile, "kynetic: '1.0'\ntitle: theirs value");

    const result = kspec(
      `merge-driver ${baseFile} ${oursFile} ${theirsFile} --non-interactive`,
      tempDir,
      { expectFail: true }, // Conflicts return exit code 1
    );

    // Should exit with code 1 (conflicts detected)
    expect(result.exitCode).toBe(1);

    // Should show conflict count and details
    expect(result.stderr).toContain("conflict");
    expect(result.stderr).toContain("title");
  });

  // AC: @merge-driver-cli ac-3
  it("should write conflicts as YAML comments in non-interactive mode", async () => {
    // Conflicting merge
    await fs.writeFile(
      baseFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Original"
    priority: 3
`,
    );

    await fs.writeFile(
      oursFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Our version"
    priority: 3
`,
    );

    await fs.writeFile(
      theirsFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Their version"
    priority: 3
`,
    );

    const result = kspec(
      `merge-driver ${baseFile} ${oursFile} ${theirsFile} --non-interactive`,
      tempDir,
      { expectFail: true }, // Conflicts return exit code 1
    );

    expect(result.exitCode).toBe(1); // Conflicts detected

    // Read merged result
    const merged = await fs.readFile(oursFile, "utf-8");

    // Should contain conflict comments
    expect(merged).toContain("# CONFLICT:");
    expect(merged).toContain("# Path:");
    expect(merged).toContain("# Ours:");
    expect(merged).toContain("# Theirs:");
    expect(merged).toContain("# Resolution: Using ours");

    // Should keep ours value by default (may or may not be quoted)
    expect(merged).toMatch(/title:\s+(")?Our version(")?/);
  });

  // AC: @merge-driver-cli ac-1
  it("should accept optional conflict marker size and path arguments", async () => {
    // Git passes: %O %A %B %L %P (base ours theirs markerSize path)
    await fs.writeFile(baseFile, "kynetic: '1.0'\nfield: base");
    await fs.writeFile(oursFile, "kynetic: '1.0'\nfield: ours");
    await fs.writeFile(theirsFile, "kynetic: '1.0'\nfield: base");

    // Test with all 5 arguments (as git would invoke it)
    const result = kspec(
      `merge-driver ${baseFile} ${oursFile} ${theirsFile} 7 .kspec/project.tasks.yaml`,
      tempDir,
    );

    expect(result.exitCode).toBe(0);

    // Should successfully merge despite extra arguments
    const merged = await fs.readFile(oursFile, "utf-8");
    expect(merged).toContain("field: ours");
  });

  // AC: @merge-driver-cli ac-2
  it("should exit with error and show parse failure on stderr", async () => {
    // Invalid YAML in base
    await fs.writeFile(baseFile, "invalid: [unclosed array");
    await fs.writeFile(oursFile, "kynetic: '1.0'");
    await fs.writeFile(theirsFile, "kynetic: '1.0'");

    const result = kspec(
      `merge-driver ${baseFile} ${oursFile} ${theirsFile}`,
      tempDir,
      { expectFail: true },
    );

    // Should exit with error code
    expect(result.exitCode).not.toBe(0);

    // Should show parse error on stderr
    expect(result.stderr).toContain("Parse error");
    expect(result.stderr).toContain("Falling back");
  });

  // AC: @merge-driver-cli ac-3
  it("should handle multiple conflicts in non-interactive mode", async () => {
    await fs.writeFile(
      baseFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Task 1"
    priority: 3
  - _ulid: 01TASK000000000000000001
    title: "Task 2"
    status: pending
`,
    );

    await fs.writeFile(
      oursFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Task 1 - Ours"
    priority: 1
  - _ulid: 01TASK000000000000000001
    title: "Task 2"
    status: in_progress
`,
    );

    await fs.writeFile(
      theirsFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Task 1 - Theirs"
    priority: 2
  - _ulid: 01TASK000000000000000001
    title: "Task 2"
    status: completed
`,
    );

    const result = kspec(
      `merge-driver ${baseFile} ${oursFile} ${theirsFile} --non-interactive`,
      tempDir,
      { expectFail: true }, // Conflicts return exit code 1
    );

    expect(result.exitCode).toBe(1); // Conflicts detected

    // Should show multiple conflicts in stderr
    expect(result.stderr).toMatch(/\d+ conflict/);

    // Read merged result
    const merged = await fs.readFile(oursFile, "utf-8");

    // Should have multiple conflict comment blocks
    const conflictCount = (merged.match(/# CONFLICT:/g) || []).length;
    expect(conflictCount).toBeGreaterThan(1);
  });

  // AC: @merge-driver-cli ac-1
  it("should handle clean merge with no conflicts", async () => {
    await fs.writeFile(
      baseFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Task"
`,
    );

    await fs.writeFile(
      oursFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Task"
    status: in_progress
`,
    );

    await fs.writeFile(
      theirsFile,
      `
kynetic: "1.0"
tasks:
  - _ulid: 01TASK000000000000000000
    title: "Task"
    priority: 2
`,
    );

    const result = kspec(
      `merge-driver ${baseFile} ${oursFile} ${theirsFile}`,
      tempDir,
    );

    expect(result.exitCode).toBe(0);

    const merged = await fs.readFile(oursFile, "utf-8");

    // Should have both additions
    expect(merged).toContain("status: in_progress");
    expect(merged).toContain("priority: 2");
    // Should not have conflict comments
    expect(merged).not.toContain("# CONFLICT:");
  });
});
