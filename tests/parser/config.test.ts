/**
 * Tests for project configuration loading (kspec.config.yaml)
 *
 * AC coverage:
 * - @project-config ac-1: no config = defaults
 * - @project-config ac-2: config available on KspecContext.config
 * - @project-config ac-3: invalid YAML = defaults + warning
 * - @project-config ac-4: unknown fields ignored
 * - @project-config ac-5: env vars take precedence
 * - @project-config ac-6: loads from git root, not cwd
 * - @project-config ac-7: batch mode uses real project root
 * - @config-author ac-1: config author used when no env var
 * - @config-author ac-2: env var wins over config author
 * - @config-author ac-3: fallback to git/OS when no config author
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  loadProjectConfig,
  resolveConfig,
  getDefaultConfig,
  KspecConfigSchema,
  type ResolvedKspecConfig,
} from "../../src/parser/config.js";
import { getAuthor, initContext } from "../../src/parser/yaml.js";
import { createTempDir, cleanupTempDir, initGitRepo } from "../helpers/cli.js";

describe("Project Config", () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-config-test-");
    initGitRepo(tempDir);
    originalEnv = { ...process.env };
    // Clean env vars that might affect tests
    delete process.env.KSPEC_AUTHOR;
    delete process.env.KSPEC_DAEMON_PORT;
    delete process.env.KSPEC_DAEMON_HOST;
    delete process.env.KSPEC_BATCH_PROJECT_ROOT;
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    // Restore env
    process.env = originalEnv;
  });

  describe("loadProjectConfig", () => {
    // AC: @project-config ac-1
    it("returns defaults when no config file exists", async () => {
      const result = await loadProjectConfig(tempDir);

      expect(result.configPath).toBeNull();
      expect(result.warning).toBeNull();
      expect(result.gitRoot).toBe(tempDir);
      expect(result.config).toEqual(getDefaultConfig());
    });

    // AC: @project-config ac-1
    it("returns defaults with no behavior change when no config exists", async () => {
      const result = await loadProjectConfig(tempDir);
      const defaults = getDefaultConfig();

      expect(result.config.shadow.branch).toBe(defaults.shadow.branch);
      expect(result.config.shadow.directory).toBe(defaults.shadow.directory);
      expect(result.config.shadow.remote).toBe(defaults.shadow.remote);
      expect(result.config.daemon.port).toBe(defaults.daemon.port);
      expect(result.config.daemon.host).toBe(defaults.daemon.host);
      // AC: @config-validation — validation defaults
      expect(result.config.validation.strict_refs).toBe(
        defaults.validation.strict_refs
      );
      expect(result.config.validation.require_acceptance).toBe(
        defaults.validation.require_acceptance
      );
    });

    // AC: @project-config ac-2 (partial - config file parsing)
    // AC: @config-validation ac-1 ac-2 — validation config fields
    // AC: @config-daemon ac-5 — host from config file
    it("parses valid config file", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
shadow:
  branch: custom-branch
  directory: .specs
  remote: https://example.com/specs.git
daemon:
  port: 4000
  host: 0.0.0.0
identity:
  author: "@custom-author"
validation:
  strict_refs: true
  require_acceptance: true
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.configPath).toBe(path.join(tempDir, "kspec.config.yaml"));
      expect(result.warning).toBeNull();
      expect(result.config.shadow.branch).toBe("custom-branch");
      expect(result.config.shadow.directory).toBe(".specs");
      expect(result.config.shadow.remote).toEqual({
        value: "https://example.com/specs.git",
        type: "url",
      });
      expect(result.config.daemon.port).toBe(4000);
      expect(result.config.daemon.host).toBe("0.0.0.0");
      expect(result.config.identity.author).toBe("@custom-author");
      // AC: @config-validation ac-1 ac-2
      expect(result.config.validation.strict_refs).toBe(true);
      expect(result.config.validation.require_acceptance).toBe(true);
    });

    // AC: @project-config ac-3
    it("falls back to defaults and warns on invalid YAML syntax", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
shadow:
  branch: [invalid yaml
  this is broken:
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.configPath).toBe(path.join(tempDir, "kspec.config.yaml"));
      expect(result.warning).toContain("Failed to parse kspec.config.yaml");
      expect(result.config).toEqual(getDefaultConfig());
    });

    // AC: @project-config ac-3
    it("falls back to defaults and warns on validation errors", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: "not-a-number"
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.warning).toContain("Config validation failed");
      expect(result.config).toEqual(getDefaultConfig());
    });

    // AC: @project-config ac-4
    it("ignores unknown fields and applies valid fields", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 5000
unknown_top_level_field: "should be ignored"
another_unknown:
  nested: value
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.warning).toBeNull();
      expect(result.config.daemon.port).toBe(5000);
      // Defaults should still be applied for unspecified fields
      expect(result.config.shadow.branch).toBe("kspec-meta");
    });

    it("parses ralph skill overrides from config file", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
ralph:
  skills:
    task_work: "/task-work"
    reflect: "/reflect"
    pr_review: "/pr-review"
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.warning).toBeNull();
      expect(result.config.ralph.skills.task_work).toBe("/task-work");
      expect(result.config.ralph.skills.reflect).toBe("/reflect");
      expect(result.config.ralph.skills.pr_review).toBe("/pr-review");
    });

    it("uses kspec: namespace defaults when ralph config omitted", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 5000
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.ralph.skills.task_work).toBe("/kspec:task-work");
      expect(result.config.ralph.skills.reflect).toBe("/kspec:reflect");
      expect(result.config.ralph.skills.pr_review).toBe("/kspec:review");
    });

    it("allows partial ralph skill overrides", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
ralph:
  skills:
    pr_review: "/my-review"
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.ralph.skills.task_work).toBe("/kspec:task-work");
      expect(result.config.ralph.skills.reflect).toBe("/kspec:reflect");
      expect(result.config.ralph.skills.pr_review).toBe("/my-review");
    });

    // AC: @project-config ac-5
    // AC: @config-daemon ac-6 — env var overrides config host
    it("env vars take precedence over config file values", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
identity:
  author: "@config-author"
daemon:
  port: 5000
  host: from-config.local
`
      );

      process.env.KSPEC_AUTHOR = "@env-author";
      process.env.KSPEC_DAEMON_PORT = "6000";
      process.env.KSPEC_DAEMON_HOST = "env-host.local";

      const result = await loadProjectConfig(tempDir);

      expect(result.config.identity.author).toBe("@env-author");
      expect(result.config.daemon.port).toBe(6000);
      expect(result.config.daemon.host).toBe("env-host.local");
    });

    // AC: @project-config ac-5
    it("env vars apply even when no config file exists", async () => {
      process.env.KSPEC_AUTHOR = "@env-only";
      process.env.KSPEC_DAEMON_PORT = "7000";

      const result = await loadProjectConfig(tempDir);

      expect(result.config.identity.author).toBe("@env-only");
      expect(result.config.daemon.port).toBe(7000);
    });

    // AC: @project-config ac-6
    it("loads config from git root, not subdirectory", async () => {
      // Create config in git root
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 8000
`
      );

      // Create subdirectory
      const subDir = path.join(tempDir, "src", "deep", "nested");
      await fs.mkdir(subDir, { recursive: true });

      const result = await loadProjectConfig(subDir);

      expect(result.gitRoot).toBe(tempDir);
      expect(result.config.daemon.port).toBe(8000);
    });

    // AC: @project-config ac-7
    it("uses KSPEC_BATCH_PROJECT_ROOT when set (batch mode)", async () => {
      // Create config in the "real" project root
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 9000
`
      );

      // Create a separate temp dir to simulate batch mode
      const batchTempDir = await createTempDir("kspec-batch-");

      try {
        // Simulate batch mode by setting the env var
        process.env.KSPEC_BATCH_PROJECT_ROOT = tempDir;

        // Load config from the batch temp dir - should still find config from real root
        const result = await loadProjectConfig(batchTempDir);

        expect(result.config.daemon.port).toBe(9000);
      } finally {
        await cleanupTempDir(batchTempDir);
      }
    });
  });

  describe("resolveConfig", () => {
    it("returns defaults for null input", () => {
      const config = resolveConfig(null);
      expect(config).toEqual(getDefaultConfig());
    });

    it("merges partial config with defaults", () => {
      const config = resolveConfig({
        daemon: { port: 4567 },
      });

      expect(config.daemon.port).toBe(4567);
      expect(config.daemon.host).toBe("localhost"); // default
      expect(config.shadow.branch).toBe("kspec-meta"); // default
    });

    it("applies env var overrides", () => {
      process.env.KSPEC_AUTHOR = "@test-author";

      const config = resolveConfig({
        identity: { author: "@file-author" },
      });

      expect(config.identity.author).toBe("@test-author");
    });

    it("handles invalid KSPEC_DAEMON_PORT gracefully", () => {
      process.env.KSPEC_DAEMON_PORT = "not-a-number";

      const config = resolveConfig({
        daemon: { port: 4000 },
      });

      // Should fall back to file value since env is invalid
      expect(config.daemon.port).toBe(4000);
    });
  });

  describe("KspecConfigSchema", () => {
    it("validates correct config", () => {
      const result = KspecConfigSchema.safeParse({
        shadow: {
          branch: "my-branch",
          directory: ".specs",
          remote: "https://github.com/org/repo.git",
        },
        daemon: {
          port: 3000,
          host: "localhost",
        },
        identity: {
          author: "@me",
        },
        validation: {
          strict_refs: true,
          require_acceptance: true,
        },
      });

      expect(result.success).toBe(true);
    });

    it("allows partial config", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: { port: 4000 },
      });

      expect(result.success).toBe(true);
    });

    it("allows empty config", () => {
      const result = KspecConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    // AC: @project-config ac-4
    it("allows unknown top-level fields (passthrough)", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: { port: 4000 },
        custom_field: "value",
        another: { nested: true },
      });

      expect(result.success).toBe(true);
    });

    it("rejects invalid port", () => {
      const result = KspecConfigSchema.safeParse({
        daemon: { port: 70000 }, // above 65535
      });

      expect(result.success).toBe(false);
    });

    // AC: @config-validation ac-1 ac-2 — validation fields are boolean
    it("rejects non-boolean validation fields", () => {
      const result = KspecConfigSchema.safeParse({
        validation: { strict_refs: "invalid" },
      });

      expect(result.success).toBe(false);
    });
  });

  // AC: @project-config ac-2 - full integration test
  describe("initContext integration", () => {
    it("includes config on KspecContext", async () => {
      // Create a minimal kspec setup
      await fs.mkdir(path.join(tempDir, "spec"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "spec", "kynetic.yaml"),
        `
kynetic: "1.0"
title: Test Project
`
      );
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
daemon:
  port: 5555
`
      );

      const ctx = await initContext(tempDir);

      expect(ctx.config).toBeDefined();
      expect(ctx.config.daemon.port).toBe(5555);
      expect(ctx.config.shadow.branch).toBe("kspec-meta"); // default
    });

    it("has config available even when no config file exists", async () => {
      // Create a minimal kspec setup without config file
      await fs.mkdir(path.join(tempDir, "spec"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "spec", "kynetic.yaml"),
        `
kynetic: "1.0"
title: Test Project
`
      );

      const ctx = await initContext(tempDir);

      expect(ctx.config).toBeDefined();
      expect(ctx.config).toEqual(getDefaultConfig());
    });
  });

  describe("getDefaultConfig", () => {
    it("returns consistent defaults", () => {
      const defaults = getDefaultConfig();

      expect(defaults.shadow.branch).toBe("kspec-meta");
      expect(defaults.shadow.directory).toBe(".kspec");
      expect(defaults.shadow.remote).toBeNull();
      expect(defaults.identity.author).toBeNull();
      // AC: @config-validation — defaults preserve existing behavior
      // strict_refs: true = dangling refs are errors (existing behavior)
      // require_acceptance: false = missing AC is warning (existing behavior)
      expect(defaults.validation.strict_refs).toBe(true);
      expect(defaults.validation.require_acceptance).toBe(false);
      expect(defaults.daemon.port).toBe(3456);
      expect(defaults.daemon.host).toBe("localhost");
      expect(defaults.ralph.skills.task_work).toBe("/kspec:task-work");
      expect(defaults.ralph.skills.reflect).toBe("/kspec:reflect");
      expect(defaults.ralph.skills.pr_review).toBe("/kspec:review");
    });

    it("returns independent objects", () => {
      const defaults1 = getDefaultConfig();
      const defaults2 = getDefaultConfig();

      defaults1.daemon.port = 9999;

      expect(defaults2.daemon.port).toBe(3456); // Should not be affected
    });
  });

  // AC: @config-author — config author in priority chain
  describe("config author", () => {
    // AC: @config-author ac-1 — config author is used when no env var
    it("config author is used when no env var set", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
identity:
  author: "@bot-agent"
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.identity.author).toBe("@bot-agent");
    });

    // AC: @config-author ac-2 — env var wins over config
    it("env var takes precedence over config author", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
identity:
  author: "@config-author"
`
      );

      process.env.KSPEC_AUTHOR = "@env-author";

      const result = await loadProjectConfig(tempDir);

      expect(result.config.identity.author).toBe("@env-author");
    });

    // AC: @config-author ac-3 — fallback to git/OS when no config
    it("author is null when no config and no env var", async () => {
      const result = await loadProjectConfig(tempDir);

      // Config author should be null, fallback to git/OS happens in getAuthor()
      expect(result.config.identity.author).toBeNull();
    });
  });

  // AC: @config-author — getAuthor function with config parameter
  describe("getAuthor with config", () => {
    // AC: @config-author ac-1 — config author is used when no env var
    it("returns config author when no env var set", () => {
      delete process.env.KSPEC_AUTHOR;

      const author = getAuthor("@config-bot");

      expect(author).toBe("@config-bot");
    });

    // AC: @config-author ac-2 — env var wins over config
    it("env var takes precedence over config author", () => {
      process.env.KSPEC_AUTHOR = "@env-author";

      const author = getAuthor("@config-author");

      expect(author).toBe("@env-author");
    });

    // AC: @config-author ac-3 — fallback to git/OS when no config author
    it("falls back to git/OS when config author is null", () => {
      delete process.env.KSPEC_AUTHOR;

      // Pass null to simulate no config author
      const author = getAuthor(null);

      // Should get git user.name or system user
      // In test env, should get git user since we called initGitRepo
      expect(author).toBeDefined();
      expect(typeof author).toBe("string");
    });

    // AC: @config-author ac-3 — fallback works when no parameter passed
    it("falls back to git/OS when no config author parameter passed", () => {
      delete process.env.KSPEC_AUTHOR;

      // No parameter = undefined, should use fallback chain
      const author = getAuthor();

      // Should get git user.name or system user
      expect(author).toBeDefined();
      expect(typeof author).toBe("string");
    });

    // AC: @config-author ac-1 — config author works with @-prefix
    it("preserves @-prefix in config author", () => {
      delete process.env.KSPEC_AUTHOR;

      const author = getAuthor("@bot-agent");

      expect(author).toBe("@bot-agent");
    });

    // AC: @config-author ac-1 — config author works without @-prefix
    it("works with config author without @-prefix", () => {
      delete process.env.KSPEC_AUTHOR;

      const author = getAuthor("project-bot");

      expect(author).toBe("project-bot");
    });
  });

  // AC: @config-validation — validation config fields
  describe("validation config", () => {
    // AC: @config-validation ac-1 — require_acceptance config
    it("loads require_acceptance from config", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
validation:
  require_acceptance: true
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.validation.require_acceptance).toBe(true);
    });

    // AC: @config-validation ac-2 — strict_refs config
    it("loads strict_refs from config", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
validation:
  strict_refs: true
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.validation.strict_refs).toBe(true);
    });

    // AC: @config-validation — strict_refs defaults to true (preserve existing behavior)
    it("defaults strict_refs to true", async () => {
      const result = await loadProjectConfig(tempDir);

      expect(result.config.validation.strict_refs).toBe(true);
    });

    // Both can be set independently
    it("allows independent setting of strict_refs and require_acceptance", async () => {
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        `
validation:
  strict_refs: false
  require_acceptance: true
`
      );

      const result = await loadProjectConfig(tempDir);

      expect(result.config.validation.strict_refs).toBe(false);
      expect(result.config.validation.require_acceptance).toBe(true);
    });
  });
});
