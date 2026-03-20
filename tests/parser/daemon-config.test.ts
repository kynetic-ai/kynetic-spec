/**
 * Tests for daemon configuration in kspec.config.yaml
 *
 * AC coverage:
 * - @config-daemon ac-1: config daemon.port used by serve start
 * - @config-daemon ac-2: CLI --port flag overrides config daemon.port
 * - @config-daemon ac-3: config daemon.auto_start controls auto-start behavior
 * - @config-daemon ac-4: deprecation warning for manifest daemon block
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  loadProjectConfig,
  resolveConfig,
  getDefaultConfig,
  KspecConfigSchema,
} from "../../src/parser/config.js";
import { initContext } from "../../src/parser/yaml.js";
import { createTempDir, cleanupTempDir, initGitRepo, kspec } from "../helpers/cli.js";
import { stringify } from "yaml";

describe("Daemon Config", () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-config-test-");
    initGitRepo(tempDir);
    originalEnv = { ...process.env };
    // Clean env vars that might affect tests
    delete process.env.KSPEC_DAEMON_PORT;
    delete process.env.KSPEC_DAEMON_HOST;
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    process.env = originalEnv;
  });

  describe("daemon.port configuration", () => {
    // AC: @config-daemon ac-1 — config daemon.port is used when no CLI flag
    it("loads daemon.port from config file", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 4000
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.port).toBe(4000);
    });

    // AC: @config-daemon ac-1 — default port when no config
    it("defaults to port 3456 when no config", async () => {
      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.port).toBe(3456);
    });

    // AC: @config-daemon ac-2 — env var overrides config (simulates CLI precedence)
    it("env var KSPEC_DAEMON_PORT overrides config", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 4000
`
      );

      process.env.KSPEC_DAEMON_PORT = "5000";

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.port).toBe(5000);
    });
  });

  describe("daemon.auto_start configuration", () => {
    // AC: @config-daemon ac-3 — auto_start defaults to true
    it("defaults auto_start to true when no config", async () => {
      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.auto_start).toBe(true);
    });

    // AC: @config-daemon ac-3 — auto_start can be set to false
    it("loads auto_start: false from config", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  auto_start: false
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.auto_start).toBe(false);
    });

    // AC: @config-daemon ac-3 — auto_start can be explicitly set to true
    it("loads auto_start: true from config", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  auto_start: true
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.auto_start).toBe(true);
    });

    // AC: @config-daemon ac-3 — auto_start combined with port
    it("supports both auto_start and port settings", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 4500
  auto_start: false
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.port).toBe(4500);
      expect(result.config.daemon.auto_start).toBe(false);
    });
  });

  describe("daemon schema validation", () => {
    it("rejects invalid port: too low", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: { port: 0 },
      });

      expect(result.success).toBe(false);
    });

    it("rejects invalid port: too high", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: { port: 70000 },
      });

      expect(result.success).toBe(false);
    });

    it("rejects invalid port: not a number", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: { port: "3456" },
      });

      expect(result.success).toBe(false);
    });

    it("rejects invalid auto_start: not a boolean", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: { auto_start: "true" },
      });

      expect(result.success).toBe(false);
    });

    it("accepts valid daemon config", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: {
          port: 4000,
          host: "0.0.0.0",
          auto_start: true,
        },
      });

      expect(result.success).toBe(true);
    });

    it("accepts partial daemon config", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: {
          auto_start: false,
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("resolveConfig daemon defaults", () => {
    it("applies all daemon defaults for empty config", () => {
      const config = resolveConfig({});

      expect(config.daemon.port).toBe(3456);
      expect(config.daemon.host).toBe("localhost");
      expect(config.daemon.auto_start).toBe(true);
    });

    it("merges partial daemon config with defaults", () => {
      const config = resolveConfig({
        daemon: { auto_start: false },
      });

      expect(config.daemon.port).toBe(3456); // default
      expect(config.daemon.host).toBe("localhost"); // default
      expect(config.daemon.auto_start).toBe(false); // from config
    });
  });

  describe("getDefaultConfig daemon", () => {
    it("returns correct daemon defaults", () => {
      const defaults = getDefaultConfig();

      expect(defaults.daemon.port).toBe(3456);
      expect(defaults.daemon.host).toBe("localhost");
      expect(defaults.daemon.auto_start).toBe(true);
    });
  });

  // AC: @config-daemon ac-4 — manifest daemon block deprecation
  describe("manifest daemon deprecation", () => {
    // AC: @config-daemon ac-4 — manifest daemon block still parsed (backward compat)
    it("manifest with daemon block is still parseable", async () => {
      // Write manifest directly in tempDir (initContext looks for kynetic.yaml there)
      await fs.writeFile(
        path.join(tempDir, "kynetic.yaml"),
        stringify({
          kynetic: "1.0",
          project: { name: "Test Project" },
          daemon: {
            auto_start: true,
            port: 5000,
          },
        })
      );

      // initContext should still load the manifest without error
      const ctx = await initContext(tempDir);

      expect(ctx.manifest).toBeDefined();
      expect(ctx.manifest?.daemon).toBeDefined();
      expect(ctx.manifest?.daemon?.port).toBe(5000);
    });

    // AC: @config-daemon ac-4 — config daemon takes precedence over manifest
    it("config daemon settings override manifest daemon when both exist", async () => {
      // Write manifest directly in tempDir with old daemon config
      await fs.writeFile(
        path.join(tempDir, "kynetic.yaml"),
        stringify({
          kynetic: "1.0",
          project: { name: "Test Project" },
          daemon: {
            auto_start: true,
            port: 5000,
          },
        })
      );

      // Create config file with different daemon settings
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 6000
  auto_start: false
`
      );

      const ctx = await initContext(tempDir);

      // config.daemon should have the config file values
      expect(ctx.config.daemon.port).toBe(6000);
      expect(ctx.config.daemon.auto_start).toBe(false);

      // manifest.daemon should still have old values (for deprecation warning)
      expect(ctx.manifest?.daemon?.port).toBe(5000);
      expect(ctx.manifest?.daemon?.auto_start).toBe(true);
    });

    // AC: @config-daemon ac-4 — CLI emits deprecation warning to stderr
    it("CLI emits deprecation warning when manifest has daemon block", async () => {
      // Write manifest with daemon block
      await fs.writeFile(
        path.join(tempDir, "kynetic.yaml"),
        stringify({
          kynetic: "1.0",
          project: { name: "Test Project" },
          daemon: {
            auto_start: false,
            port: 5000,
          },
        })
      );

      // Run a CLI command that triggers maybeAutoStartDaemon()
      // Using 'validate' since it doesn't require init and loads context
      const result = kspec("validate", tempDir, {
        expectFail: true,
        env: { KSPEC_NO_DAEMON: "0" },
      });

      // Should contain the deprecation warning in stderr
      expect(result.stderr).toContain('Manifest "daemon" block is deprecated');
      expect(result.stderr).toContain("Migrate to kspec.config.yaml");
      expect(result.stderr).toContain("port: 5000");
      expect(result.stderr).toContain("auto_start: false");
    });
  });

  describe("initContext daemon config integration", () => {
    it("includes daemon config on KspecContext", async () => {
      await fs.writeFile(
        path.join(tempDir, "kynetic.yaml"),
        stringify({
          kynetic: "1.0",
          project: { name: "Test Project" },
        })
      );
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 7777
  auto_start: false
`
      );

      const ctx = await initContext(tempDir);

      expect(ctx.config.daemon.port).toBe(7777);
      expect(ctx.config.daemon.auto_start).toBe(false);
    });

    it("uses daemon defaults when no config file", async () => {
      await fs.writeFile(
        path.join(tempDir, "kynetic.yaml"),
        stringify({
          kynetic: "1.0",
          project: { name: "Test Project" },
        })
      );

      const ctx = await initContext(tempDir);

      expect(ctx.config.daemon.port).toBe(3456);
      expect(ctx.config.daemon.auto_start).toBe(true);
    });
  });
});
