/**
 * Tests for daemon configuration in kspec.config.yaml
 *
 * AC coverage:
 * - @config-daemon ac-1: config daemon.port used by serve start
 * - @config-daemon ac-2: CLI --port flag overrides config daemon.port
 * - @config-daemon ac-3: config daemon.auto_start controls auto-start behavior
 * - @config-daemon ac-4: deprecation warning for manifest daemon block
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  loadProjectConfig,
  resolveConfig,
  getDefaultConfig,
  KspecConfigSchema,
} from "../../src/parser/config.js";
import { initContext } from "../../src/parser/yaml.js";
import {
  createTempDir,
  cleanupTempDir,
  createIsolatedKspecHome,
  initGitRepo,
  kspec,
  readTestOutput,
} from "../helpers/cli.js";
import { existsSync } from "node:fs";
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
    delete process.env.KSPEC_DAEMON_CONNECT_HOST;
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
`,
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
    // AC: @config-daemon ac-port-env-precedence — KSPEC_DAEMON_PORT wins over file config
    it("env var KSPEC_DAEMON_PORT overrides config", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 4000
`,
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
`,
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
`,
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
`,
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.port).toBe(4500);
      expect(result.config.daemon.auto_start).toBe(false);
    });
  });

  describe("daemon.runtime configuration", () => {
    // AC: @daemon-runtime-adapter ac-default-node
    // AC: @config-daemon ac-runtime-default
    it("defaults runtime to node when no config", async () => {
      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.runtime).toBe("node");
    });

    // AC: @daemon-runtime-adapter ac-runtime-selection
    // AC: @config-daemon ac-runtime-config
    it("loads runtime: node from config", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  runtime: node
`,
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.runtime).toBe("node");
    });

    // AC: @daemon-runtime-adapter ac-default-node
    // AC: @config-daemon ac-runtime-default
    it("defaults runtime to node when daemon config omits runtime", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 4500
  auto_start: false
`,
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.runtime).toBe("node");
      expect(result.config.daemon.port).toBe(4500);
      expect(result.config.daemon.auto_start).toBe(false);
    });

    // AC: @daemon-runtime-adapter ac-runtime-selection
    // AC: @config-daemon ac-runtime-config — bun runtime is selected from config
    it("loads runtime: bun from config", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  runtime: bun
`,
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.runtime).toBe("bun");
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

    it("rejects invalid runtime", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: { runtime: "deno" },
      });

      expect(result.success).toBe(false);
    });

    it("accepts valid daemon config", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: {
          port: 4000,
          host: "0.0.0.0",
          runtime: "node",
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
    // AC: @config-daemon ac-host-default
    // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
    it("applies all daemon defaults for empty config (host defaults to 127.0.0.1)", () => {
      const config = resolveConfig({});

      expect(config.daemon.port).toBe(3456);
      expect(config.daemon.host).toBe("127.0.0.1");
      expect(config.daemon.connect_host).toBeNull();
      expect(config.daemon.runtime).toBe("node");
      expect(config.daemon.auto_start).toBe(true);
    });

    // AC: @config-daemon ac-host-default
    it("merges partial daemon config with defaults", () => {
      const config = resolveConfig({
        daemon: { auto_start: false },
      });

      expect(config.daemon.port).toBe(3456); // default
      expect(config.daemon.host).toBe("127.0.0.1"); // default loopback
      expect(config.daemon.connect_host).toBeNull(); // default
      expect(config.daemon.runtime).toBe("node"); // default
      expect(config.daemon.auto_start).toBe(false); // from config
    });
  });

  describe("getDefaultConfig daemon", () => {
    // AC: @config-daemon ac-host-default
    // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
    it("returns correct daemon defaults (numeric IPv4 loopback)", () => {
      const defaults = getDefaultConfig();

      expect(defaults.daemon.port).toBe(3456);
      expect(defaults.daemon.host).toBe("127.0.0.1");
      expect(defaults.daemon.connect_host).toBeNull();
      expect(defaults.daemon.runtime).toBe("node");
      expect(defaults.daemon.auto_start).toBe(true);
    });
  });

  describe("daemon.connect_host configuration", () => {
    // AC: @config-daemon ac-connect-host-config
    it("loads connect_host from config file", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  host: "0.0.0.0"
  connect_host: "10.0.0.5"
`,
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.host).toBe("0.0.0.0");
      expect(result.config.daemon.connect_host).toBe("10.0.0.5");
    });

    // AC: @config-daemon ac-connect-host-config
    it("KSPEC_DAEMON_CONNECT_HOST overrides config", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  host: "0.0.0.0"
  connect_host: "10.0.0.5"
`,
      );

      process.env.KSPEC_DAEMON_CONNECT_HOST = "192.168.1.20";

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.connect_host).toBe("192.168.1.20");
    });

    // AC: @config-daemon ac-connect-host-config
    it("connect_host is null when not configured", async () => {
      const result = await loadProjectConfig(tempDir);
      expect(result.config.daemon.connect_host).toBeNull();
    });
  });

  describe("daemon.host env precedence", () => {
    // AC: @config-daemon ac-host-env-precedence
    it("KSPEC_DAEMON_HOST overrides config daemon.host", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  host: "0.0.0.0"
`,
      );

      process.env.KSPEC_DAEMON_HOST = "127.0.0.1";

      const result = await loadProjectConfig(tempDir);

      expect(result.config.daemon.host).toBe("127.0.0.1");
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
        }),
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
        }),
      );

      // Create config file with different daemon settings
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 6000
  auto_start: false
`,
      );

      const ctx = await initContext(tempDir);

      // config.daemon should have the config file values
      expect(ctx.config.daemon.port).toBe(6000);
      expect(ctx.config.daemon.runtime).toBe("node");
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
        }),
      );

      // Run a CLI command that triggers maybeAutoStartDaemon()
      // Using 'validate' since it doesn't require init and loads context.
      // AC: @multi-directory-daemon ac-32 - warning still emits even when incidental daemon traffic is suppressed.
      const result = kspec("validate", tempDir, {
        expectFail: true,
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
        }),
      );
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 7777
  auto_start: false
`,
      );

      const ctx = await initContext(tempDir);

      expect(ctx.config.daemon.port).toBe(7777);
      expect(ctx.config.daemon.runtime).toBe("node");
      expect(ctx.config.daemon.auto_start).toBe(false);
    });

    it("uses daemon defaults when no config file", async () => {
      await fs.writeFile(
        path.join(tempDir, "kynetic.yaml"),
        stringify({
          kynetic: "1.0",
          project: { name: "Test Project" },
        }),
      );

      const ctx = await initContext(tempDir);

      expect(ctx.config.daemon.port).toBe(3456);
      expect(ctx.config.daemon.runtime).toBe("node");
      expect(ctx.config.daemon.auto_start).toBe(true);
    });
  });

  // AC: @multi-directory-daemon ac-9, ac-10 — auto-start checks global PID path
  describe("auto-start PID file path", () => {
    it("detects existing daemon via global config PID file, not project specDir", async () => {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        ["daemon:", "  auto_start: true", "  runtime: node", ""].join("\n"),
      );

      // Write a PID file to the global config path (where the daemon actually writes)
      // using the current process PID so isDaemonRunning() sees a live process
      await fs.writeFile(isolatedHome.daemonPidFilePath, `${process.pid}\n`);

      // Run a CLI command — auto-start should detect the PID and NOT spawn a new daemon
      const result = kspec(`util ulid`, tempDir, {
        env: {
          ...isolatedHome.env,
          KSPEC_NO_DAEMON: "",
          KSPEC_SESSION_ID: "",
        },
      });

      expect(result.exitCode).toBe(0);

      // The PID file should still contain only our original PID — no new daemon was spawned
      const pidContent = await readTestOutput(isolatedHome.daemonPidFilePath);
      expect(pidContent.trim()).toBe(String(process.pid));
    });
  });

  // AC: @config-daemon ac-7 — suppress auto-start in dispatch agent sessions
  describe("dispatch agent session suppression", () => {
    it("does not auto-start daemon when KSPEC_SESSION_ID is set", async () => {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        ["daemon:", "  auto_start: true", "  runtime: node", ""].join("\n"),
      );

      // Run a CLI command with KSPEC_SESSION_ID set — should suppress auto-start
      const result = kspec(`util ulid`, tempDir, {
        env: {
          ...isolatedHome.env,
          KSPEC_SESSION_ID: "test-dispatch-session",
          KSPEC_NO_DAEMON: "",
        },
      });

      expect(result.exitCode).toBe(0);

      // No daemon PID file should have been created — auto-start was suppressed
      expect(existsSync(isolatedHome.daemonPidFilePath)).toBe(false);
    });
  });
});
