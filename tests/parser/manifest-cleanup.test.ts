/**
 * Tests for manifest cleanup spec
 *
 * AC coverage:
 * - @config-manifest-cleanup ac-1: kspec init generates manifest without config block
 * - @config-manifest-cleanup ac-2: existing manifests with config block parse successfully
 * - @config-manifest-cleanup ac-3: kspec init generates manifest without daemon block
 * - @config-manifest-cleanup ac-4: existing manifests with daemon block parse successfully
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManifestSchema } from "../../src/schema/spec.js";
import { createTempDir, cleanupTempDir, initGitRepo, kspec } from "../helpers/cli.js";

describe("Manifest Cleanup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-manifest-cleanup-");
    initGitRepo(tempDir);
    // Create initial commit so we have a branch
    await fs.writeFile(path.join(tempDir, "README.md"), "# Test Project\n");
    const { execSync } = await import("node:child_process");
    execSync("git add . && git commit -m 'Initial commit'", {
      cwd: tempDir,
      stdio: "pipe",
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("generated manifest content", () => {
    // AC: @config-manifest-cleanup ac-1 — no config block in generated manifest
    it("kspec init generates manifest without config block", async () => {
      const result = kspec("init --no-prompt", tempDir);

      expect(result.exitCode).toBe(0);

      // Find and read the generated manifest
      const kspecDir = path.join(tempDir, ".kspec");
      const files = await fs.readdir(kspecDir);
      const manifestFile = files.find(
        (f) => f.endsWith(".yaml") && !f.endsWith(".tasks.yaml") && !f.startsWith("project.")
      );
      expect(manifestFile).toBeDefined();

      const manifestContent = await fs.readFile(
        path.join(kspecDir, manifestFile!),
        "utf-8"
      );

      // Should NOT contain config block
      expect(manifestContent).not.toMatch(/^config:/m);
      expect(manifestContent).not.toContain("validation:");
      expect(manifestContent).not.toContain("strict_refs:");
      expect(manifestContent).not.toContain("require_acceptance:");
    });

    // AC: @config-manifest-cleanup ac-3 — no daemon block in generated manifest
    it("kspec init generates manifest without daemon block", async () => {
      const result = kspec("init --no-prompt", tempDir);

      expect(result.exitCode).toBe(0);

      // Find and read the generated manifest
      const kspecDir = path.join(tempDir, ".kspec");
      const files = await fs.readdir(kspecDir);
      const manifestFile = files.find(
        (f) => f.endsWith(".yaml") && !f.endsWith(".tasks.yaml") && !f.startsWith("project.")
      );
      expect(manifestFile).toBeDefined();

      const manifestContent = await fs.readFile(
        path.join(kspecDir, manifestFile!),
        "utf-8"
      );

      // Should NOT contain daemon block
      expect(manifestContent).not.toMatch(/^daemon:/m);
      expect(manifestContent).not.toContain("auto_start:");
      expect(manifestContent).not.toContain("port:");
    });
  });

  describe("backward compatibility parsing", () => {
    // AC: @config-manifest-cleanup ac-2 — existing manifests with config block parse successfully
    it("parses manifest with config block without errors", () => {
      const manifestWithConfig = {
        kynetic: "1.0",
        project: {
          name: "Test Project",
          version: "1.0.0",
          status: "draft",
        },
        config: {
          validation: {
            strict_refs: true,
            require_acceptance: false,
          },
        },
      };

      const result = ManifestSchema.safeParse(manifestWithConfig);

      expect(result.success).toBe(true);
      if (result.success) {
        // Config is accepted but stored as-is (z.any())
        expect(result.data.config).toEqual({
          validation: {
            strict_refs: true,
            require_acceptance: false,
          },
        });
      }
    });

    // AC: @config-manifest-cleanup ac-2 — config block with arbitrary content parses
    it("parses manifest with arbitrary config content", () => {
      const manifestWithArbitraryConfig = {
        kynetic: "1.0",
        project: {
          name: "Test Project",
          version: "1.0.0",
        },
        config: {
          some_future_field: "value",
          nested: {
            deeply: {
              unknown: true,
            },
          },
        },
      };

      const result = ManifestSchema.safeParse(manifestWithArbitraryConfig);

      expect(result.success).toBe(true);
    });

    // AC: @config-manifest-cleanup ac-4 — existing manifests with daemon block parse successfully
    it("parses manifest with daemon block without errors", () => {
      const manifestWithDaemon = {
        kynetic: "1.0",
        project: {
          name: "Test Project",
          version: "1.0.0",
          status: "draft",
        },
        daemon: {
          port: 4000,
          auto_start: false,
        },
      };

      const result = ManifestSchema.safeParse(manifestWithDaemon);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.daemon?.port).toBe(4000);
        expect(result.data.daemon?.auto_start).toBe(false);
      }
    });

    // AC: @config-manifest-cleanup ac-4 — daemon block with defaults parses
    it("parses manifest with partial daemon block using defaults", () => {
      const manifestWithPartialDaemon = {
        kynetic: "1.0",
        project: {
          name: "Test Project",
          version: "1.0.0",
        },
        daemon: {
          port: 5000,
          // auto_start not specified, should default to true
        },
      };

      const result = ManifestSchema.safeParse(manifestWithPartialDaemon);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.daemon?.port).toBe(5000);
        expect(result.data.daemon?.auto_start).toBe(true);
      }
    });

    // AC: @config-manifest-cleanup ac-2 + ac-4 — manifest with both config and daemon parses
    it("parses manifest with both config and daemon blocks", () => {
      const manifestWithBoth = {
        kynetic: "1.0",
        project: {
          name: "Test Project",
          version: "1.0.0",
        },
        config: {
          validation: {
            strict_refs: false,
          },
        },
        daemon: {
          port: 4567,
          auto_start: true,
        },
      };

      const result = ManifestSchema.safeParse(manifestWithBoth);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.config).toBeDefined();
        expect(result.data.daemon?.port).toBe(4567);
      }
    });

    // Test that manifest without deprecated fields still parses
    it("parses clean manifest without config or daemon blocks", () => {
      const cleanManifest = {
        kynetic: "1.0",
        project: {
          name: "Test Project",
          version: "1.0.0",
          status: "draft",
        },
        includes: ["modules/main.yaml"],
      };

      const result = ManifestSchema.safeParse(cleanManifest);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.config).toBeUndefined();
        expect(result.data.daemon).toBeUndefined();
      }
    });
  });
});
