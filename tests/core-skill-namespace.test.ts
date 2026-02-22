/**
 * Tests for core skill namespace rendering.
 * Core skills (origin: "core") render to .claude/plugins/kspec/skills/<id>/
 * (Claude Code plugin directory) while project skills render to .claude/skills/<id>/.
 *
 * Task: @01KHZHPG
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
  PLUGIN_SKILLS_DIR,
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

    // AC: @skill-rendering ac-7
    it("should render core skill to .claude/plugins/kspec/skills/<id>/SKILL.md", async () => {
      // Create a core skill
      kspecFull(
        'skill add --id core-test --name "Core Test" --description "A core test skill" --origin core --skill-version 0.1.0',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "core-test", "SKILL.md"),
        "# Core Test Skill\n\nCore content.\n",
        "utf-8"
      );

      kspecFull("skill render", tempDir);

      // Core skill should be in plugin directory
      const pluginPath = path.join(
        tempDir,
        ".claude",
        "plugins",
        "kspec",
        "skills",
        "core-test",
        "SKILL.md"
      );
      const content = await fs.readFile(pluginPath, "utf-8");
      expect(content).toContain("<!-- kspec-managed -->");
      expect(content).toContain("# Core Test Skill");

      // Should NOT exist at flat path
      const flatPath = path.join(
        tempDir,
        ".claude",
        "skills",
        "core-test",
        "SKILL.md"
      );
      await expect(fs.access(flatPath)).rejects.toThrow();

      // Should NOT exist at old namespaced path
      const oldNamespacedPath = path.join(
        tempDir,
        ".claude",
        "skills",
        "kspec",
        "core-test",
        "SKILL.md"
      );
      await expect(fs.access(oldNamespacedPath)).rejects.toThrow();
    });

    // AC: @skill-rendering ac-7
    it("should generate plugin manifest", async () => {
      // Create a core skill
      kspecFull(
        'skill add --id manifest-test --name "Manifest Test" --description "Plugin manifest test" --origin core --skill-version 0.1.0',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "manifest-test", "SKILL.md"),
        "# Manifest Test\n",
        "utf-8"
      );

      kspecFull("skill render", tempDir);

      // Plugin manifest should exist
      const manifestPath = path.join(
        tempDir,
        ".claude",
        "plugins",
        "kspec",
        ".claude-plugin",
        "plugin.json"
      );
      const manifestContent = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(manifestContent);
      expect(manifest.name).toBe("kspec");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.description).toBe("kspec agent skills");
    });

    it("should render project skill to .claude/skills/<id>/SKILL.md (flat)", async () => {
      // Create a project skill
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
        tempDir,
        ".claude",
        "skills",
        "proj-test",
        "SKILL.md"
      );
      const content = await fs.readFile(flatPath, "utf-8");
      expect(content).toContain("<!-- kspec-managed -->");

      // Should NOT exist in plugin directory
      const pluginPath = path.join(
        tempDir,
        ".claude",
        "plugins",
        "kspec",
        "skills",
        "proj-test",
        "SKILL.md"
      );
      await expect(fs.access(pluginPath)).rejects.toThrow();
    });

    it("should clean up old flat path when rendering core skill", async () => {
      // Create a core skill
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

      // Render should migrate
      kspecFull("skill render", tempDir);

      // Old flat path should be cleaned up
      await expect(
        fs.access(path.join(oldPath, "SKILL.md"))
      ).rejects.toThrow();

      // New plugin path should exist
      const newPath = path.join(
        tempDir,
        ".claude",
        "plugins",
        "kspec",
        "skills",
        "migrated",
        "SKILL.md"
      );
      const content = await fs.readFile(newPath, "utf-8");
      expect(content).toContain("<!-- kspec-managed -->");
    });

    it("should clean up old namespaced path (.claude/skills/kspec/<id>/) when rendering core skill", async () => {
      // Create a core skill
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

      // Render should migrate
      kspecFull("skill render", tempDir);

      // Old namespaced path should be cleaned up
      await expect(
        fs.access(path.join(oldPath, "SKILL.md"))
      ).rejects.toThrow();

      // New plugin path should exist
      const newPath = path.join(
        tempDir,
        ".claude",
        "plugins",
        "kspec",
        "skills",
        "ns-migrated",
        "SKILL.md"
      );
      const content = await fs.readFile(newPath, "utf-8");
      expect(content).toContain("<!-- kspec-managed -->");
    });

    it("should handle both core and project skills in same render", async () => {
      // Create one core skill and one project skill
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

      kspecFull("skill render", tempDir);

      // Core at plugin path
      const corePath = path.join(
        tempDir, ".claude", "plugins", "kspec", "skills", "core-a", "SKILL.md"
      );
      expect(await fs.readFile(corePath, "utf-8")).toContain("# Core A");

      // Project at flat path
      const projPath = path.join(
        tempDir, ".claude", "skills", "proj-b", "SKILL.md"
      );
      expect(await fs.readFile(projPath, "utf-8")).toContain("# Project B");
    });

    // AC: @skill-rendering ac-6
    it("should clean orphaned skills in plugin dir with --clean", async () => {
      // Create and render a core skill
      kspecFull(
        'skill add --id ns-keep --name "Namespace Keep" --description "Keep me" --origin core --skill-version 0.1.0',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, "skills", "ns-keep", "SKILL.md"),
        "# Keep Me\n",
        "utf-8"
      );
      kspecFull("skill render", tempDir);

      // Verify skill exists in plugin dir
      const pluginPath = path.join(
        tempDir, ".claude", "plugins", "kspec", "skills", "ns-keep", "SKILL.md"
      );
      expect(await fs.readFile(pluginPath, "utf-8")).toContain("# Keep Me");

      // Create an orphaned skill in plugin dir (simulating a removed core skill)
      const orphanPath = path.join(
        tempDir, ".claude", "plugins", "kspec", "skills", "orphaned"
      );
      await fs.mkdir(orphanPath, { recursive: true });
      await fs.writeFile(
        path.join(orphanPath, "SKILL.md"),
        "---\nname: orphaned\n---\n<!-- kspec-managed -->\n# Orphaned\n",
        "utf-8"
      );

      // Run render --clean — should remove orphaned but keep active
      kspecFull("skill render --clean", tempDir);

      // Orphaned should be removed
      await expect(
        fs.access(path.join(orphanPath, "SKILL.md"))
      ).rejects.toThrow();

      // Active should still exist
      const keptContent = await fs.readFile(pluginPath, "utf-8");
      expect(keptContent).toContain("# Keep Me");
    });
  });
});
