/**
 * Tests for merge driver parsing functionality.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseYamlVersions } from "../src/merge/parse.js";
import { createTempDir, cleanupTempDir } from "./helpers/cli.js";

describe("parseYamlVersions", () => {
  it("should parse all three versions successfully", async () => {
    // AC: @yaml-merge-driver ac-1
    const tempDir = await createTempDir();
    try {
      // Create three valid YAML files
      const base = path.join(tempDir, "base.yaml");
      const ours = path.join(tempDir, "ours.yaml");
      const theirs = path.join(tempDir, "theirs.yaml");

      await fs.writeFile(base, "version: '1.0'\ndata: base");
      await fs.writeFile(ours, "version: '1.0'\ndata: ours");
      await fs.writeFile(theirs, "version: '1.0'\ndata: theirs");

      const result = await parseYamlVersions(base, ours, theirs);

      expect(result.success).toBe(true);
      expect(result.versions).toBeDefined();
      expect(result.versions?.base).toEqual({ version: "1.0", data: "base" });
      expect(result.versions?.ours).toEqual({ version: "1.0", data: "ours" });
      expect(result.versions?.theirs).toEqual({
        version: "1.0",
        data: "theirs",
      });
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it("should return error when base file fails to parse", async () => {
    // AC: @yaml-merge-driver ac-11
    const tempDir = await createTempDir();
    try {
      const base = path.join(tempDir, "base.yaml");
      const ours = path.join(tempDir, "ours.yaml");
      const theirs = path.join(tempDir, "theirs.yaml");

      // Invalid YAML in base
      await fs.writeFile(base, "invalid: yaml: content: [");
      await fs.writeFile(ours, "version: '1.0'");
      await fs.writeFile(theirs, "version: '1.0'");

      const result = await parseYamlVersions(base, ours, theirs);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to parse base");
      expect(result.failedFile).toBe("base");
      expect(result.versions).toBeUndefined();
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it("should return error when ours file fails to parse", async () => {
    // AC: @yaml-merge-driver ac-11
    const tempDir = await createTempDir();
    try {
      const base = path.join(tempDir, "base.yaml");
      const ours = path.join(tempDir, "ours.yaml");
      const theirs = path.join(tempDir, "theirs.yaml");

      await fs.writeFile(base, "version: '1.0'");
      // Invalid YAML in ours
      await fs.writeFile(ours, "invalid: yaml: content: [");
      await fs.writeFile(theirs, "version: '1.0'");

      const result = await parseYamlVersions(base, ours, theirs);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to parse ours");
      expect(result.failedFile).toBe("ours");
      expect(result.versions).toBeUndefined();
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it("should return error when theirs file fails to parse", async () => {
    // AC: @yaml-merge-driver ac-11
    const tempDir = await createTempDir();
    try {
      const base = path.join(tempDir, "base.yaml");
      const ours = path.join(tempDir, "ours.yaml");
      const theirs = path.join(tempDir, "theirs.yaml");

      await fs.writeFile(base, "version: '1.0'");
      await fs.writeFile(ours, "version: '1.0'");
      // Invalid YAML in theirs
      await fs.writeFile(theirs, "invalid: yaml: content: [");

      const result = await parseYamlVersions(base, ours, theirs);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to parse theirs");
      expect(result.failedFile).toBe("theirs");
      expect(result.versions).toBeUndefined();
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it("should return error when file cannot be read", async () => {
    // AC: @yaml-merge-driver ac-11
    const tempDir = await createTempDir();
    try {
      const base = path.join(tempDir, "nonexistent-base.yaml");
      const ours = path.join(tempDir, "ours.yaml");
      const theirs = path.join(tempDir, "theirs.yaml");

      await fs.writeFile(ours, "version: '1.0'");
      await fs.writeFile(theirs, "version: '1.0'");

      const result = await parseYamlVersions(base, ours, theirs);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to read files");
      expect(result.versions).toBeUndefined();
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it("should parse complex kspec task file structures", async () => {
    // AC: @yaml-merge-driver ac-1
    const tempDir = await createTempDir();
    try {
      const base = path.join(tempDir, "base.yaml");
      const ours = path.join(tempDir, "ours.yaml");
      const theirs = path.join(tempDir, "theirs.yaml");

      const taskContent = `tasks:
  - _ulid: 01TASK0000000000000000000
    title: Example task
    type: task
    status: pending
    priority: 2
    tags: []
    notes: []
`;

      await fs.writeFile(base, taskContent);
      await fs.writeFile(ours, taskContent);
      await fs.writeFile(theirs, taskContent);

      const result = await parseYamlVersions(base, ours, theirs);

      expect(result.success).toBe(true);
      expect(result.versions).toBeDefined();
      expect(result.versions?.base).toHaveProperty("tasks");
      expect(result.versions?.ours).toHaveProperty("tasks");
      expect(result.versions?.theirs).toHaveProperty("tasks");
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
