/**
 * Tests for Claude Code Skill Renderer
 * AC: @claude-code-renderer ac-1 through ac-4
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
  renderClaudeCodeSkill,
  KSPEC_MANAGED_MARKER,
  loadMetaContext,
  initContext,
} from "../src/parser/index";

describe("Claude Code Skill Renderer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a test skill with known content
    const result = kspecFull(
      'skill add --id task-work --name "Task Work Skill" --description "A skill for task work" --platform claude-code',
      tempDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`skill add failed: ${result.stderr || result.stdout}`);
    }

    // Write custom content to the skill's SKILL.md
    const skillMdPath = path.join(tempDir, "skills", "task-work", "SKILL.md");
    await fs.writeFile(
      skillMdPath,
      "# Task Work Session\n\nStructured workflow for working on tasks.\n",
      "utf-8"
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @claude-code-renderer ac-1
  describe("ac-1: renderClaudeCodeSkill creates .claude/skills/<id>/SKILL.md with YAML frontmatter", () => {
    it("should create SKILL.md with YAML frontmatter when called", async () => {
      // Get context and skill
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");
      expect(skill).toBeDefined();

      // Call renderClaudeCodeSkill
      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!);

      // Verify file was created
      expect(result.action).toBe("created");
      expect(result.path).toBe(
        path.join(tempDir, ".claude", "skills", "task-work", "SKILL.md")
      );

      // Verify content has YAML frontmatter
      const content = await fs.readFile(result.path, "utf-8");
      expect(content).toMatch(/^---\n/);
      expect(content).toContain("---");
    });

    it("should create file at correct path .claude/skills/task-work/SKILL.md", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      await renderClaudeCodeSkill(ctx, tempDir, skill!);

      // Verify directory structure
      const expectedPath = path.join(
        tempDir,
        ".claude",
        "skills",
        "task-work",
        "SKILL.md"
      );
      const stats = await fs.stat(expectedPath);
      expect(stats.isFile()).toBe(true);
    });
  });

  // AC: @claude-code-renderer ac-2
  describe("ac-2: rendered output has YAML frontmatter delimiters with name and description fields", () => {
    it("should have YAML frontmatter with name field", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      const content = await fs.readFile(result.path, "utf-8");

      // Check frontmatter has name field
      expect(content).toContain("name: task-work");
    });

    it("should have YAML frontmatter with description field", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      const content = await fs.readFile(result.path, "utf-8");

      // Check frontmatter has description field
      expect(content).toContain("description: A skill for task work");
    });

    it("should have YAML frontmatter delimiters (--- at start and end)", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      const content = await fs.readFile(result.path, "utf-8");

      // Check frontmatter delimiters
      expect(content.startsWith("---\n")).toBe(true);

      // Count frontmatter delimiters - should have exactly 2 (opening and closing)
      const delimiterMatches = content.match(/^---$/gm);
      expect(delimiterMatches?.length).toBe(2);
    });
  });

  // AC: @claude-code-renderer ac-3
  describe("ac-3: skill body content from source appears verbatim below frontmatter", () => {
    it("should include source content verbatim below frontmatter", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      const content = await fs.readFile(result.path, "utf-8");

      // Check that source content is present
      expect(content).toContain("# Task Work Session");
      expect(content).toContain("Structured workflow for working on tasks.");
    });

    it("should preserve source content exactly (not modify it)", async () => {
      // Write source with specific formatting
      const sourceContent =
        "# Task Work Session\n\n## Quick Start\n\n```bash\nkspec workflow start\n```\n";
      const skillMdPath = path.join(tempDir, "skills", "task-work", "SKILL.md");
      await fs.writeFile(skillMdPath, sourceContent, "utf-8");

      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      const content = await fs.readFile(result.path, "utf-8");

      // Source content should appear exactly as written (after frontmatter + marker)
      expect(content).toContain(sourceContent);
    });

    it("should strip existing frontmatter from source and replace with generated", async () => {
      // Write source with existing frontmatter
      const skillMdPath = path.join(tempDir, "skills", "task-work", "SKILL.md");
      await fs.writeFile(
        skillMdPath,
        '---\nname: old-name\ndescription: old description\n---\n\n# Actual Content\n',
        "utf-8"
      );

      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      const content = await fs.readFile(result.path, "utf-8");

      // Should have new frontmatter values
      expect(content).toContain("name: task-work");
      expect(content).toContain("description: A skill for task work");

      // Should NOT have old values
      expect(content).not.toContain("name: old-name");
      expect(content).not.toContain("old description");

      // Should have the actual content
      expect(content).toContain("# Actual Content");

      // Should have exactly 2 frontmatter delimiters (not 4)
      const delimiterMatches = content.match(/^---$/gm);
      expect(delimiterMatches?.length).toBe(2);
    });
  });

  // AC: @claude-code-renderer ac-4
  describe("ac-4: rendered files appear as unstaged changes on main branch", () => {
    it("should leave rendered files as unstaged changes (not committed)", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      await renderClaudeCodeSkill(ctx, tempDir, skill!);

      // Check git status - file should be untracked or modified
      // Use -u to show individual files in untracked directories
      const { execSync } = await import("node:child_process");
      const gitStatus = execSync("git status --porcelain -u", {
        cwd: tempDir,
        encoding: "utf-8",
      });

      // The rendered file (or its directory) should appear in git status as new/untracked
      // Git may show either the full path or the directory, depending on config
      expect(gitStatus).toMatch(/\.claude/);
    });

    it("should NOT auto-commit rendered files", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      // Create an initial commit so we have a HEAD
      const { execSync } = await import("node:child_process");
      execSync("git add -A && git commit -m 'Initial commit'", {
        cwd: tempDir,
        encoding: "utf-8",
      });

      // Get commit count before
      const commitsBefore = execSync("git rev-list --count HEAD", {
        cwd: tempDir,
        encoding: "utf-8",
      }).trim();

      await renderClaudeCodeSkill(ctx, tempDir, skill!);

      // Get commit count after
      const commitsAfter = execSync("git rev-list --count HEAD", {
        cwd: tempDir,
        encoding: "utf-8",
      }).trim();

      // Should have same number of commits (no auto-commit)
      expect(commitsAfter).toBe(commitsBefore);
    });

    it("should write to main branch working directory not shadow branch", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!);

      // The path should be under project root .claude/, not .kspec/
      expect(result.path).toContain(".claude/skills/task-work/SKILL.md");
      expect(result.path).not.toContain(".kspec");

      // Verify the file exists at the expected location
      const renderedPath = path.join(
        tempDir,
        ".claude",
        "skills",
        "task-work",
        "SKILL.md"
      );
      const stats = await fs.stat(renderedPath);
      expect(stats.isFile()).toBe(true);
    });
  });

  // Additional tests for library behavior
  describe("Library function behavior", () => {
    it("should support dry run mode", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      // Call with dry run
      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!, {
        dryRun: true,
      });

      // Should report what would be done
      expect(result.action).toBe("created");

      // But file should NOT exist
      await expect(fs.access(result.path)).rejects.toThrow();
    });

    it("should be idempotent (return unchanged on second call)", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      // First call
      const result1 = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      expect(result1.action).toBe("created");

      // Second call
      const result2 = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      expect(result2.action).toBe("unchanged");
    });

    it("should return updated when source content changes", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      // First render
      const result1 = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      expect(result1.action).toBe("created");

      // Modify source
      const skillMdPath = path.join(tempDir, "skills", "task-work", "SKILL.md");
      await fs.writeFile(skillMdPath, "# Updated Content\n", "utf-8");

      // Second render
      const result2 = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      expect(result2.action).toBe("updated");
    });

    it("should include kspec-managed marker in output", async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === "task-work");

      const result = await renderClaudeCodeSkill(ctx, tempDir, skill!);
      const content = await fs.readFile(result.path, "utf-8");

      expect(content).toContain(KSPEC_MANAGED_MARKER);
    });
  });
});
