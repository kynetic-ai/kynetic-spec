/**
 * Tests for the Claude Code plugin marketplace registry.
 *
 * AC: @core-skill-install ac-6, ac-7, ac-8
 * AC: @enhanced-setup ac-7, ac-8
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTempDir } from "./helpers/cli";

// We test the registry functions with KSPEC_CLAUDE_HOME pointing to a temp dir
// to avoid touching real ~/.claude/plugins/.

describe("Claude Plugin Registry", () => {
  let tempHome: string;
  let tempProject: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempHome = await createTempDir("kspec-claude-home-");
    tempProject = await createTempDir("kspec-project-");
    originalEnv = process.env.KSPEC_CLAUDE_HOME;
    process.env.KSPEC_CLAUDE_HOME = tempHome;

    // Create a .claude directory in the temp project
    await fs.mkdir(path.join(tempProject, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.KSPEC_CLAUDE_HOME;
    } else {
      process.env.KSPEC_CLAUDE_HOME = originalEnv;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(tempProject, { recursive: true, force: true });
  });

  describe("registerCorePluginMarketplace", () => {
    it("should register marketplace with correct structure", async () => {
      const { registerCorePluginMarketplace, getClaudePluginsDir } = await import(
        "../src/lib/claude-plugin-registry"
      );

      const result = await registerCorePluginMarketplace();

      expect(result.success).toBe(true);
      expect(result.action).toBe("registered");
      expect(result.registeredPath).toBeDefined();

      // Verify the JSON file was created
      const marketplacesPath = path.join(getClaudePluginsDir(), "known_marketplaces.json");
      const content = JSON.parse(await fs.readFile(marketplacesPath, "utf-8"));
      expect(content["kspec-plugins"]).toBeDefined();
      expect(content["kspec-plugins"].source).toBe("local");
      expect(content["kspec-plugins"].installLocation).toBeTruthy();
      expect(content["kspec-plugins"].lastUpdated).toBeTruthy();
    });

    // AC: @core-skill-install ac-8
    it("should be idempotent (no lastUpdated change on re-run)", async () => {
      const { registerCorePluginMarketplace, getClaudePluginsDir } = await import(
        "../src/lib/claude-plugin-registry"
      );

      // First registration
      await registerCorePluginMarketplace();

      const marketplacesPath = path.join(getClaudePluginsDir(), "known_marketplaces.json");
      const firstContent = JSON.parse(await fs.readFile(marketplacesPath, "utf-8"));
      const firstTimestamp = firstContent["kspec-plugins"].lastUpdated;

      // Small delay to ensure timestamps would differ
      await new Promise((r) => setTimeout(r, 50));

      // Second registration
      const result = await registerCorePluginMarketplace();

      expect(result.success).toBe(true);
      expect(result.action).toBe("unchanged");

      // lastUpdated should NOT have changed
      const secondContent = JSON.parse(await fs.readFile(marketplacesPath, "utf-8"));
      expect(secondContent["kspec-plugins"].lastUpdated).toBe(firstTimestamp);
    });

    it("should preserve unrelated marketplace entries", async () => {
      const { registerCorePluginMarketplace, getClaudePluginsDir } = await import(
        "../src/lib/claude-plugin-registry"
      );

      // Pre-populate with another marketplace
      const pluginsDir = getClaudePluginsDir();
      await fs.mkdir(pluginsDir, { recursive: true });
      const marketplacesPath = path.join(pluginsDir, "known_marketplaces.json");
      await fs.writeFile(
        marketplacesPath,
        JSON.stringify({
          "other-plugin": {
            source: "marketplace",
            installLocation: "/some/path",
            lastUpdated: "2025-01-01T00:00:00.000Z",
          },
        }),
        "utf-8"
      );

      await registerCorePluginMarketplace();

      const content = JSON.parse(await fs.readFile(marketplacesPath, "utf-8"));
      expect(content["other-plugin"]).toBeDefined();
      expect(content["other-plugin"].source).toBe("marketplace");
      expect(content["kspec-plugins"]).toBeDefined();
    });

    it("should handle missing JSON file gracefully", async () => {
      const { registerCorePluginMarketplace } = await import(
        "../src/lib/claude-plugin-registry"
      );

      // Don't create anything - start from scratch
      const result = await registerCorePluginMarketplace();
      expect(result.success).toBe(true);
    });

    it("should handle corrupt JSON file gracefully", async () => {
      const { registerCorePluginMarketplace, getClaudePluginsDir } = await import(
        "../src/lib/claude-plugin-registry"
      );

      const pluginsDir = getClaudePluginsDir();
      await fs.mkdir(pluginsDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginsDir, "known_marketplaces.json"),
        "not valid json{{{",
        "utf-8"
      );

      const result = await registerCorePluginMarketplace();
      expect(result.success).toBe(true);
    });

    it("should not write in dry-run mode", async () => {
      const { registerCorePluginMarketplace, getClaudePluginsDir } = await import(
        "../src/lib/claude-plugin-registry"
      );

      const result = await registerCorePluginMarketplace({ dryRun: true });
      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");

      // No file should be created
      const marketplacesPath = path.join(getClaudePluginsDir(), "known_marketplaces.json");
      await expect(fs.access(marketplacesPath)).rejects.toThrow();
    });
  });

  describe("enablePluginInProject", () => {
    // AC: @core-skill-install ac-7
    it("should enable plugin in project settings", async () => {
      const { enablePluginInProject } = await import(
        "../src/lib/claude-plugin-registry"
      );

      // Create empty settings
      await fs.writeFile(
        path.join(tempProject, ".claude", "settings.json"),
        "{}",
        "utf-8"
      );

      const result = await enablePluginInProject(tempProject);

      expect(result.success).toBe(true);
      expect(result.action).toBe("enabled");

      const settings = JSON.parse(
        await fs.readFile(
          path.join(tempProject, ".claude", "settings.json"),
          "utf-8"
        )
      );
      expect(settings.enabledPlugins?.["kspec@kspec-plugins"]).toBe(true);
    });

    it("should preserve existing hooks config", async () => {
      const { enablePluginInProject } = await import(
        "../src/lib/claude-plugin-registry"
      );

      // Create settings with hooks
      const existingSettings = {
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "test" }] }],
        },
      };
      await fs.writeFile(
        path.join(tempProject, ".claude", "settings.json"),
        JSON.stringify(existingSettings),
        "utf-8"
      );

      await enablePluginInProject(tempProject);

      const settings = JSON.parse(
        await fs.readFile(
          path.join(tempProject, ".claude", "settings.json"),
          "utf-8"
        )
      );
      // Hooks should still be there
      expect(settings.hooks?.UserPromptSubmit).toBeDefined();
      expect(settings.enabledPlugins?.["kspec@kspec-plugins"]).toBe(true);
    });

    it("should be idempotent when already enabled", async () => {
      const { enablePluginInProject } = await import(
        "../src/lib/claude-plugin-registry"
      );

      await fs.writeFile(
        path.join(tempProject, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { "kspec@kspec-plugins": true } }),
        "utf-8"
      );

      const result = await enablePluginInProject(tempProject);
      expect(result.success).toBe(true);
      expect(result.action).toBe("unchanged");
    });
  });

  describe("checkMarketplaceHealth", () => {
    it("should return missing when not registered", async () => {
      const { checkMarketplaceHealth } = await import(
        "../src/lib/claude-plugin-registry"
      );

      const health = await checkMarketplaceHealth();
      expect(health.status).toBe("missing");
    });

    it("should return healthy when registered with valid path", async () => {
      const { registerCorePluginMarketplace, checkMarketplaceHealth } = await import(
        "../src/lib/claude-plugin-registry"
      );

      await registerCorePluginMarketplace();

      const health = await checkMarketplaceHealth();
      expect(health.status).toBe("healthy");
      expect(health.registeredPath).toBeDefined();
    });

    it("should detect path-broken when registered path is invalid", async () => {
      const { checkMarketplaceHealth, getClaudePluginsDir } = await import(
        "../src/lib/claude-plugin-registry"
      );

      // Manually register with a broken path
      const pluginsDir = getClaudePluginsDir();
      await fs.mkdir(pluginsDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginsDir, "known_marketplaces.json"),
        JSON.stringify({
          "kspec-plugins": {
            source: "local",
            installLocation: "/nonexistent/path/to/plugin",
            lastUpdated: new Date().toISOString(),
          },
        }),
        "utf-8"
      );

      const health = await checkMarketplaceHealth();
      expect(health.status).toBe("path-broken");
    });
  });
});
