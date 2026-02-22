/**
 * Tests for core skill namespace rendering.
 * Core skills (origin: "core") on claude-code are now plugin-provided via
 * the npm package plugin/ directory. They are NOT locally rendered.
 * Project skills render to .claude/skills/<id>/.
 *
 * Task: @01KHZHPG
 * AC: @skill-rendering ac-7
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  kspec as kspecFull,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from "./helpers/cli";
import {
  getClaudeCodeSkillSubdir,
  getSkillSubdir,
} from "../src/parser/skill-render";
import type { LoadedSkill } from "../src/parser/meta";

describe("Core Skill Namespace", () => {
  describe("getSkillSubdir helper", () => {
    it("should return <id> for core skills on claude-code (plugin path provides namespace)", () => {
      expect(getSkillSubdir("help", "core", "claude-code")).toBe("help");
    });

    it("should return <id> for project skills on claude-code", () => {
      expect(getSkillSubdir("my-skill", "project", "claude-code")).toBe(
        "my-skill"
      );
    });

    it("should return <id> for local skills on claude-code", () => {
      expect(getSkillSubdir("local-skill", "local", "claude-code")).toBe(
        "local-skill"
      );
    });

    it("should return kspec-<id> for core skills on codex", () => {
      expect(getSkillSubdir("help", "core", "codex")).toBe("kspec-help");
    });

    it("should default to <id> when platform is omitted (no prefix)", () => {
      expect(getSkillSubdir("help", "core")).toBe("help");
    });

    it("should return <id> when origin is undefined", () => {
      expect(getSkillSubdir("help", undefined, "claude-code")).toBe("help");
    });
  });

  describe("getClaudeCodeSkillSubdir helper", () => {
    it("should return <id> for core skills (plugin path provides namespace)", () => {
      const skill = { id: "help", origin: "core" } as LoadedSkill;
      expect(getClaudeCodeSkillSubdir(skill)).toBe("help");
    });

    it("should return <id> for project skills", () => {
      const skill = { id: "my-skill", origin: "project" } as LoadedSkill;
      expect(getClaudeCodeSkillSubdir(skill)).toBe("my-skill");
    });
  });

  describe("rendering to filesystem", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await setupTempFixtures();
      await initGitRepo(tempDir);
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    // AC: @skill-rendering ac-7 - Core skills are plugin-provided, not locally rendered
    it("should skip core skill on claude-code (plugin-provided)", async () => {
      kspecFull(
        'skill add --id core-test --name "Core Test" --description "A core test skill" --origin core --skill-version 0.1.0',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "core-test", "SKILL.md"),
        "# Core Test Skill\n\nCore content.\n",
        "utf-8"
      );

      const result = kspecFull("skill render --json", tempDir);
      const json = JSON.parse(result.stdout);

      // Core skill should be skipped
      const coreResult = json.rendered.find(
        (r: { id: string }) => r.id === "core-test"
      );
      expect(coreResult).toBeDefined();
      expect(coreResult.action).toBe("skipped");
      expect(coreResult.skipReason).toContain("plugin");

      // Should NOT exist at plugin path (not locally rendered anymore)
      const pluginPath = path.join(
        tempDir, ".claude", "plugins", "kspec", "skills", "core-test", "SKILL.md"
      );
      await expect(fs.access(pluginPath)).rejects.toThrow();

      // Should NOT exist at flat path
      const flatPath = path.join(
        tempDir, ".claude", "skills", "core-test", "SKILL.md"
      );
      await expect(fs.access(flatPath)).rejects.toThrow();
    });

    it("should render project skill to .claude/skills/<id>/SKILL.md (flat)", async () => {
      kspecFull(
        'skill add --id proj-test --name "Project Test" --description "A project test skill"',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "proj-test", "SKILL.md"),
        "# Project Test\n\nProject content.\n",
        "utf-8"
      );

      kspecFull("skill render", tempDir);

      // Project skill at flat path
      const flatPath = path.join(
        tempDir, ".claude", "skills", "proj-test", "SKILL.md"
      );
      const content = await fs.readFile(flatPath, "utf-8");
      expect(content).toContain("<!-- kspec-managed -->");

      // Should NOT exist in plugin directory
      const pluginPath = path.join(
        tempDir, ".claude", "plugins", "kspec", "skills", "proj-test", "SKILL.md"
      );
      await expect(fs.access(pluginPath)).rejects.toThrow();
    });

    it("should clean up old flat path when rendering core skill", async () => {
      kspecFull(
        'skill add --id migrated --name "Migrated" --description "Migration test" --origin core --skill-version 0.1.0',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "migrated", "SKILL.md"),
        "# Migrated\n",
        "utf-8"
      );

      // Manually create old flat path to simulate pre-migration state
      const oldPath = path.join(tempDir, ".claude", "skills", "migrated");
      await fs.mkdir(oldPath, { recursive: true });
      await fs.writeFile(
        path.join(oldPath, "SKILL.md"),
        "---\nname: migrated\n---\n<!-- kspec-managed -->\n# Old\n",
        "utf-8"
      );

      // Render should clean up old path
      kspecFull("skill render", tempDir);

      // Old flat path should be cleaned up (migration ran)
      await expect(
        fs.access(path.join(oldPath, "SKILL.md"))
      ).rejects.toThrow();
    });

    it("should clean up old namespaced path (.claude/skills/kspec/<id>/) when rendering core skill", async () => {
      kspecFull(
        'skill add --id ns-migrated --name "NS Migrated" --description "Namespace migration test" --origin core --skill-version 0.1.0',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "ns-migrated", "SKILL.md"),
        "# NS Migrated\n",
        "utf-8"
      );

      // Manually create old namespaced path (PR #440 format)
      const oldPath = path.join(tempDir, ".claude", "skills", "kspec", "ns-migrated");
      await fs.mkdir(oldPath, { recursive: true });
      await fs.writeFile(
        path.join(oldPath, "SKILL.md"),
        "---\nname: ns-migrated\n---\n<!-- kspec-managed -->\n# Old\n",
        "utf-8"
      );

      kspecFull("skill render", tempDir);

      // Old namespaced path should be cleaned up
      await expect(
        fs.access(path.join(oldPath, "SKILL.md"))
      ).rejects.toThrow();
    });

    it("should handle both core and project skills in same render", async () => {
      kspecFull(
        'skill add --id core-a --name "Core A" --description "Core" --origin core --skill-version 0.1.0',
        tempDir
      );
      kspecFull(
        'skill add --id proj-b --name "Project B" --description "Project"',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "core-a", "SKILL.md"),
        "# Core A\n",
        "utf-8"
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "proj-b", "SKILL.md"),
        "# Project B\n",
        "utf-8"
      );

      const result = kspecFull("skill render --json", tempDir);
      const json = JSON.parse(result.stdout);

      // Core skill should be skipped (plugin-provided)
      const coreResult = json.rendered.find(
        (r: { id: string }) => r.id === "core-a"
      );
      expect(coreResult.action).toBe("skipped");
      expect(coreResult.skipReason).toContain("plugin");

      // Project at flat path should be rendered
      const projPath = path.join(
        tempDir, ".claude", "skills", "proj-b", "SKILL.md"
      );
      expect(await fs.readFile(projPath, "utf-8")).toContain("# Project B");
    });

    it("should clean up old plugin render target when rendering core skill", async () => {
      kspecFull(
        'skill add --id cleanup-test --name "Cleanup" --description "Plugin cleanup test" --origin core --skill-version 0.1.0',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "cleanup-test", "SKILL.md"),
        "# Cleanup Test\n",
        "utf-8"
      );

      // Create old plugin render target (the path that was used before this change)
      const oldPluginPath = path.join(
        tempDir, ".claude", "plugins", "kspec", "skills", "cleanup-test"
      );
      await fs.mkdir(oldPluginPath, { recursive: true });
      await fs.writeFile(
        path.join(oldPluginPath, "SKILL.md"),
        "---\nname: cleanup-test\n---\n<!-- kspec-managed -->\n# Old Plugin Render\n",
        "utf-8"
      );

      kspecFull("skill render", tempDir);

      // Old plugin render target should be cleaned up
      await expect(
        fs.access(path.join(oldPluginPath, "SKILL.md"))
      ).rejects.toThrow();
    });
  });
});
