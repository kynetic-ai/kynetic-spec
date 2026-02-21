/**
 * Tests for core skill namespace rendering.
 * Core skills (origin: "core") render under .claude/skills/kspec/<id>/
 * while project skills render under .claude/skills/<id>/.
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
} from "../src/parser/skill-render";
import type { LoadedSkill } from "../src/parser/meta";

describe("Core Skill Namespace", () => {
  describe("getSkillSubdir helper", () => {
    it("should return kspec/<id> for core skills on claude-code", () => {
      expect(getSkillSubdir("help", "core", "claude-code")).toBe(
        path.join("kspec", "help")
      );
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

    it("should return <id> for core skills on codex (no namespacing)", () => {
      expect(getSkillSubdir("help", "core", "codex")).toBe("help");
    });

    it("should default to claude-code when platform is omitted", () => {
      expect(getSkillSubdir("help", "core")).toBe(path.join("kspec", "help"));
    });

    it("should return <id> when origin is undefined", () => {
      expect(getSkillSubdir("help", undefined, "claude-code")).toBe("help");
    });
  });

  describe("getClaudeCodeSkillSubdir helper", () => {
    it("should return kspec/<id> for core skills", () => {
      const skill = { id: "help", origin: "core" } as LoadedSkill;
      expect(getClaudeCodeSkillSubdir(skill)).toBe(path.join("kspec", "help"));
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

    it("should render core skill to .claude/skills/kspec/<id>/SKILL.md", async () => {
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

      // Core skill should be under kspec/ namespace
      const namespacedPath = path.join(
        tempDir,
        ".claude",
        "skills",
        "kspec",
        "core-test",
        "SKILL.md"
      );
      const content = await fs.readFile(namespacedPath, "utf-8");
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

      // Should NOT exist under kspec/ namespace
      const namespacedPath = path.join(
        tempDir,
        ".claude",
        "skills",
        "kspec",
        "proj-test",
        "SKILL.md"
      );
      await expect(fs.access(namespacedPath)).rejects.toThrow();
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

      // New namespaced path should exist
      const newPath = path.join(
        tempDir,
        ".claude",
        "skills",
        "kspec",
        "migrated",
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

      // Core at namespaced path
      const corePath = path.join(
        tempDir, ".claude", "skills", "kspec", "core-a", "SKILL.md"
      );
      expect(await fs.readFile(corePath, "utf-8")).toContain("# Core A");

      // Project at flat path
      const projPath = path.join(
        tempDir, ".claude", "skills", "proj-b", "SKILL.md"
      );
      expect(await fs.readFile(projPath, "utf-8")).toContain("# Project B");
    });
  });
});
