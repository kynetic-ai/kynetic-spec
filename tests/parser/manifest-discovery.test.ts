/**
 * Tests for manifest file discovery with slug-based naming support.
 *
 * AC: @manifest-discovery ac-1, ac-2, ac-3, ac-4, ac-5
 * AC: @meta-manifest-discovery ac-1, ac-2, ac-3
 *
 * Note: These tests use traditional mode (spec/ subdirectory) since shadow mode
 * requires proper git worktree setup which is complex for unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTempDir, cleanupTempDir } from "../helpers/cli";

// Import the functions to test
import { findManifest } from "../../src/parser/yaml";
import { findMetaManifest } from "../../src/parser/meta";

describe("Manifest File Discovery", () => {
  let tempDir: string;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    // Use spec/ subdirectory for traditional mode (no shadow setup needed)
    specDir = path.join(tempDir, "spec");
    await fs.mkdir(specDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @manifest-discovery ac-1
  it("returns kynetic.yaml path when it exists", async () => {
    await fs.writeFile(
      path.join(specDir, "kynetic.yaml"),
      'kynetic: "1.0"\nproject: Test\n'
    );

    const result = await findManifest(tempDir);
    expect(result).toBe(path.join(specDir, "kynetic.yaml"));
  });

  // AC: @manifest-discovery ac-2
  it("returns kynetic.spec.yaml when kynetic.yaml doesn't exist", async () => {
    await fs.writeFile(
      path.join(specDir, "kynetic.spec.yaml"),
      'kynetic: "1.0"\nproject: Test\n'
    );

    const result = await findManifest(tempDir);
    expect(result).toBe(path.join(specDir, "kynetic.spec.yaml"));
  });

  // AC: @manifest-discovery ac-3
  it("returns slug-based manifest when explicit names don't exist", async () => {
    await fs.writeFile(
      path.join(specDir, "myproject.yaml"),
      'kynetic: "1.0"\nproject: My Project\n'
    );

    const result = await findManifest(tempDir);
    expect(result).toBe(path.join(specDir, "myproject.yaml"));
  });

  // AC: @manifest-discovery ac-4
  it("returns first alphabetically when multiple yaml files match", async () => {
    // Create multiple yaml files with kynetic version field
    await fs.writeFile(
      path.join(specDir, "zebra.yaml"),
      'kynetic: "1.0"\nproject: Zebra\n'
    );
    await fs.writeFile(
      path.join(specDir, "alpha.yaml"),
      'kynetic: "1.0"\nproject: Alpha\n'
    );

    const result = await findManifest(tempDir);
    // Should return alpha.yaml (first alphabetically)
    expect(result).toBe(path.join(specDir, "alpha.yaml"));
  });

  // AC: @manifest-discovery ac-5
  it("skips yaml files without kynetic version field", async () => {
    // Create a yaml file without kynetic version field
    await fs.writeFile(
      path.join(specDir, "notamanifest.yaml"),
      "some: data\nother: stuff\n"
    );
    // Create a valid manifest
    await fs.writeFile(
      path.join(specDir, "valid.yaml"),
      'kynetic: "1.0"\nproject: Valid\n'
    );

    const result = await findManifest(tempDir);
    expect(result).toBe(path.join(specDir, "valid.yaml"));
  });

  // AC: @manifest-discovery ac-1, ac-3
  it("prefers kynetic.yaml over slug-based names", async () => {
    await fs.writeFile(
      path.join(specDir, "kynetic.yaml"),
      'kynetic: "1.0"\nproject: Default\n'
    );
    await fs.writeFile(
      path.join(specDir, "myproject.yaml"),
      'kynetic: "1.0"\nproject: Custom\n'
    );

    const result = await findManifest(tempDir);
    expect(result).toBe(path.join(specDir, "kynetic.yaml"));
  });

  // AC: @manifest-discovery ac-5
  it("excludes task files from manifest discovery", async () => {
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      'kynetic: "1.0"\ntasks: []\n'
    );
    await fs.writeFile(
      path.join(specDir, "valid.yaml"),
      'kynetic: "1.0"\nproject: Valid\n'
    );

    const result = await findManifest(tempDir);
    expect(result).toBe(path.join(specDir, "valid.yaml"));
  });

  // AC: @manifest-discovery ac-5
  it("excludes inbox files from manifest discovery", async () => {
    await fs.writeFile(
      path.join(specDir, "project.inbox.yaml"),
      'kynetic: "1.0"\ninbox: []\n'
    );
    await fs.writeFile(
      path.join(specDir, "valid.yaml"),
      'kynetic: "1.0"\nproject: Valid\n'
    );

    const result = await findManifest(tempDir);
    expect(result).toBe(path.join(specDir, "valid.yaml"));
  });

  // AC: @manifest-discovery ac-5
  it("excludes meta files from manifest discovery", async () => {
    await fs.writeFile(
      path.join(specDir, "kynetic.meta.yaml"),
      'kynetic_meta: "1.0"\nagents: []\n'
    );
    await fs.writeFile(
      path.join(specDir, "valid.yaml"),
      'kynetic: "1.0"\nproject: Valid\n'
    );

    const result = await findManifest(tempDir);
    expect(result).toBe(path.join(specDir, "valid.yaml"));
  });

  // AC: @manifest-discovery ac-1
  it("also checks current directory for manifest", async () => {
    // Put manifest in tempDir directly (not in spec/)
    await fs.writeFile(
      path.join(tempDir, "kynetic.yaml"),
      'kynetic: "1.0"\nproject: Direct\n'
    );

    const result = await findManifest(tempDir);
    expect(result).toBe(path.join(tempDir, "kynetic.yaml"));
  });

  // AC: @manifest-discovery ac-5
  it("returns null when no valid manifest exists", async () => {
    // Only create invalid files
    await fs.writeFile(
      path.join(specDir, "notamanifest.yaml"),
      "some: data\n"
    );

    const result = await findManifest(tempDir);
    expect(result).toBeNull();
  });
});

describe("Meta Manifest File Discovery", () => {
  let tempDir: string;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    specDir = path.join(tempDir, "spec");
    await fs.mkdir(specDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @meta-manifest-discovery ac-1
  it("returns kynetic.meta.yaml path when it exists", async () => {
    await fs.writeFile(
      path.join(specDir, "kynetic.meta.yaml"),
      'kynetic_meta: "1.0"\nagents: []\n'
    );

    const result = await findMetaManifest(specDir);
    expect(result).toBe(path.join(specDir, "kynetic.meta.yaml"));
  });

  // AC: @meta-manifest-discovery ac-2
  it("returns slug-based meta manifest when explicit name doesn't exist", async () => {
    await fs.writeFile(
      path.join(specDir, "myproject.meta.yaml"),
      'kynetic_meta: "1.0"\nagents: []\n'
    );

    const result = await findMetaManifest(specDir);
    expect(result).toBe(path.join(specDir, "myproject.meta.yaml"));
  });

  // AC: @meta-manifest-discovery ac-3
  it("prefers kynetic.meta.yaml over slug-based names", async () => {
    await fs.writeFile(
      path.join(specDir, "kynetic.meta.yaml"),
      'kynetic_meta: "1.0"\nagents: []\n'
    );
    await fs.writeFile(
      path.join(specDir, "myproject.meta.yaml"),
      'kynetic_meta: "1.0"\nagents: []\n'
    );

    const result = await findMetaManifest(specDir);
    expect(result).toBe(path.join(specDir, "kynetic.meta.yaml"));
  });

  // AC: @meta-manifest-discovery ac-3
  it("returns first alphabetically when multiple meta.yaml files exist", async () => {
    await fs.writeFile(
      path.join(specDir, "zebra.meta.yaml"),
      'kynetic_meta: "1.0"\nagents: []\n'
    );
    await fs.writeFile(
      path.join(specDir, "alpha.meta.yaml"),
      'kynetic_meta: "1.0"\nagents: []\n'
    );

    const result = await findMetaManifest(specDir);
    expect(result).toBe(path.join(specDir, "alpha.meta.yaml"));
  });

  // AC: @meta-manifest-discovery ac-2
  it("skips meta.yaml files without kynetic_meta version field", async () => {
    await fs.writeFile(
      path.join(specDir, "invalid.meta.yaml"),
      "agents: []\nworkflows: []\n"
    );
    await fs.writeFile(
      path.join(specDir, "valid.meta.yaml"),
      'kynetic_meta: "1.0"\nagents: []\n'
    );

    const result = await findMetaManifest(specDir);
    expect(result).toBe(path.join(specDir, "valid.meta.yaml"));
  });

  // AC: @meta-manifest-discovery ac-2
  it("returns null when no valid meta manifest exists", async () => {
    await fs.writeFile(
      path.join(specDir, "invalid.meta.yaml"),
      "agents: []\n"
    );

    const result = await findMetaManifest(specDir);
    expect(result).toBeNull();
  });
});
