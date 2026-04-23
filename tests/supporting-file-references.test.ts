/**
 * Tests for Portable Skill Supporting File References
 *
 * AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
 * AC: @portable-skill-supporting-file-references ac-prompt-supporting-link-resolution
 * AC: @portable-skill-supporting-file-references ac-missing-supporting-target-rejected
 * AC: @portable-skill-supporting-file-references ac-supporting-reference-boundary
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import { buildPromptWithSkills } from "../src/agent-runtime/prompts.js";
import {
  validateSupportingFileReference,
  resolveSupportingFilePath,
  resolveSupportingFileReferences,
  collectSkillFiles,
  SupportingFileReferenceError,
} from "../src/parser/skill-render.js";
import {
  kspec as kspecFull,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
  readTestOutput,
  createTempDir,
  testUlid,
} from "./helpers/cli.js";

// ============================================================================
// Unit Tests: Core Resolution Functions
// ============================================================================

describe("Supporting-file reference validation", () => {
  // AC: @portable-skill-supporting-file-references ac-supporting-reference-boundary
  it("accepts valid relative paths", () => {
    expect(validateSupportingFileReference("scripts/merge.sh")).toEqual({ valid: true });
    expect(validateSupportingFileReference("docs/guide.md")).toEqual({ valid: true });
    expect(validateSupportingFileReference("assets/config.json")).toEqual({ valid: true });
    expect(validateSupportingFileReference("scripts/subdir/helper.sh")).toEqual({ valid: true });
  });

  // AC: @portable-skill-supporting-file-references ac-supporting-reference-boundary
  it("rejects absolute paths", () => {
    const result = validateSupportingFileReference("/etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("absolute path");
  });

  // AC: @portable-skill-supporting-file-references ac-supporting-reference-boundary
  it("rejects path traversal with ../", () => {
    const result = validateSupportingFileReference("../other-skill/secret.sh");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("escapes the skill directory boundary");
  });

  // AC: @portable-skill-supporting-file-references ac-supporting-reference-boundary
  it("rejects nested path traversal", () => {
    const result = validateSupportingFileReference("scripts/../../etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("escapes the skill directory boundary");
  });
});

describe("Supporting-file path resolution", () => {
  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("resolves to claude-code platform path for project skills", () => {
    const result = resolveSupportingFilePath(
      "scripts/merge.sh",
      "my-skill",
      "claude-code",
      "project",
    );
    expect(result).toBe(".claude/skills/my-skill/scripts/merge.sh");
  });

  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("resolves to codex platform path for project skills", () => {
    const result = resolveSupportingFilePath(
      "scripts/merge.sh",
      "my-skill",
      "codex",
      "project",
    );
    expect(result).toBe(".agents/skills/my-skill/scripts/merge.sh");
  });

  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("resolves to codex platform path with kspec- prefix for core skills", () => {
    const result = resolveSupportingFilePath(
      "scripts/merge.sh",
      "my-skill",
      "codex",
      "core",
    );
    expect(result).toBe(".agents/skills/kspec-my-skill/scripts/merge.sh");
  });

  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("resolves to droid platform path for project skills", () => {
    const result = resolveSupportingFilePath(
      "scripts/merge.sh",
      "my-skill",
      "droid",
      "project",
    );
    expect(result).toBe(".factory/skills/my-skill/scripts/merge.sh");
  });

  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("resolves nested supporting file paths", () => {
    const result = resolveSupportingFilePath(
      "scripts/subdir/helper.sh",
      "my-skill",
      "claude-code",
      "project",
    );
    expect(result).toBe(".claude/skills/my-skill/scripts/subdir/helper.sh");
  });

  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("respects custom output directory", () => {
    const result = resolveSupportingFilePath(
      "scripts/merge.sh",
      "my-skill",
      "codex",
      "project",
      "custom/output",
    );
    expect(result).toBe("custom/output/my-skill/scripts/merge.sh");
  });
});

describe("Supporting-file reference resolution in text", () => {
  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("resolves {supporting:...} tokens in text for claude-code", () => {
    const existingFiles = new Set(["scripts/merge.sh", "docs/guide.md"]);
    const result = resolveSupportingFileReferences(
      "Run the script at {supporting:scripts/merge.sh} and read {supporting:docs/guide.md}.",
      "my-skill",
      "claude-code",
      "project",
      "/fake/skill/dir",
      existingFiles,
    );
    expect(result).toBe(
      "Run the script at .claude/skills/my-skill/scripts/merge.sh and read .claude/skills/my-skill/docs/guide.md.",
    );
  });

  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("resolves {supporting:...} tokens in text for codex", () => {
    const existingFiles = new Set(["scripts/merge.sh"]);
    const result = resolveSupportingFileReferences(
      "Run {supporting:scripts/merge.sh}.",
      "my-skill",
      "codex",
      "project",
      "/fake/skill/dir",
      existingFiles,
    );
    expect(result).toBe("Run .agents/skills/my-skill/scripts/merge.sh.");
  });

  // AC: @portable-skill-supporting-file-references ac-missing-supporting-target-rejected
  it("throws on missing supporting file when validation set provided", () => {
    const existingFiles = new Set(["scripts/existing.sh"]);
    expect(() =>
      resolveSupportingFileReferences(
        "Use {supporting:scripts/nonexistent.sh}.",
        "my-skill",
        "claude-code",
        "project",
        "/fake/skill/dir",
        existingFiles,
      ),
    ).toThrow(SupportingFileReferenceError);
  });

  // AC: @portable-skill-supporting-file-references ac-missing-supporting-target-rejected
  it("error message names the unresolved file reference", () => {
    const existingFiles = new Set(["scripts/existing.sh"]);
    try {
      resolveSupportingFileReferences(
        "Use {supporting:scripts/nonexistent.sh}.",
        "my-skill",
        "claude-code",
        "project",
        "/fake/skill/dir",
        existingFiles,
      );
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SupportingFileReferenceError);
      const error = err as SupportingFileReferenceError;
      expect(error.message).toContain("scripts/nonexistent.sh");
      expect(error.message).toContain("my-skill");
      expect(error.skillId).toBe("my-skill");
      expect(error.refPath).toBe("scripts/nonexistent.sh");
    }
  });

  // AC: @portable-skill-supporting-file-references ac-supporting-reference-boundary
  it("throws on path traversal attempt", () => {
    const existingFiles = new Set(["scripts/merge.sh"]);
    expect(() =>
      resolveSupportingFileReferences(
        "Use {supporting:../other-skill/secret.sh}.",
        "my-skill",
        "claude-code",
        "project",
        "/fake/skill/dir",
        existingFiles,
      ),
    ).toThrow(SupportingFileReferenceError);
  });

  // AC: @portable-skill-supporting-file-references ac-supporting-reference-boundary
  it("throws on absolute path attempt", () => {
    const existingFiles = new Set(["scripts/merge.sh"]);
    expect(() =>
      resolveSupportingFileReferences(
        "Use {supporting:/etc/passwd}.",
        "my-skill",
        "claude-code",
        "project",
        "/fake/skill/dir",
        existingFiles,
      ),
    ).toThrow(SupportingFileReferenceError);
  });

  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("leaves text without supporting references unchanged", () => {
    const existingFiles = new Set(["scripts/merge.sh"]);
    const input = "No references here, just {skill:something} text.";
    const result = resolveSupportingFileReferences(
      input,
      "my-skill",
      "claude-code",
      "project",
      "/fake/skill/dir",
      existingFiles,
    );
    expect(result).toBe(input);
  });

  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  it("resolves without validation when no existingFiles provided", () => {
    const result = resolveSupportingFileReferences(
      "Use {supporting:scripts/any-file.sh}.",
      "my-skill",
      "claude-code",
      "project",
    );
    expect(result).toBe("Use .claude/skills/my-skill/scripts/any-file.sh.");
  });
});

describe("collectSkillFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-collect-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("collects all files with relative paths", async () => {
    const skillDir = path.join(tempDir, "my-skill");
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "docs"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Skill");
    await fs.writeFile(path.join(skillDir, "scripts", "merge.sh"), "#!/bin/bash");
    await fs.writeFile(path.join(skillDir, "docs", "guide.md"), "# Guide");

    const files = await collectSkillFiles(skillDir);
    expect(files.has("SKILL.md")).toBe(true);
    expect(files.has("scripts/merge.sh")).toBe(true);
    expect(files.has("docs/guide.md")).toBe(true);
  });

  it("returns empty set for non-existent directory", async () => {
    const files = await collectSkillFiles(path.join(tempDir, "nonexistent"));
    expect(files.size).toBe(0);
  });
});

// ============================================================================
// Integration Tests: Render-time Resolution
// ============================================================================

describe("Render-time supporting-file reference resolution", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function loadSkillForTest(skillId: string) {
    const { codexRenderer, claudeCodeRenderer, droidRenderer } = await import(
      "../src/parser/skill-render.js"
    );
    const { initContext } = await import("../src/parser/yaml.js");
    const { loadMetaContext } = await import("../src/parser/meta.js");

    const ctx = await initContext(tempDir);
    const meta = await loadMetaContext(ctx);
    const skill = meta.skills.find((s) => s.id === skillId);
    return { codexRenderer, claudeCodeRenderer, droidRenderer, ctx, skill };
  }

  // AC: @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
  describe("ac-rendered-supporting-link-resolution", () => {
    it("resolves supporting-file references in SKILL.md body for claude-code", async () => {
      kspecFull(
        'skill add --id merge --name "Merge" --description "Merge skill" --platform claude-code',
        tempDir,
      );

      const skillDir = path.join(tempDir, "skills", "merge");
      // Create supporting file
      const scriptsDir = path.join(skillDir, "scripts");
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, "merge-helper.sh"), "#!/bin/bash\necho merge");

      // Write SKILL.md with supporting reference
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Merge Skill\n\nRun the helper at {supporting:scripts/merge-helper.sh}.\n",
      );

      const { claudeCodeRenderer, ctx, skill } = await loadSkillForTest("merge");
      expect(skill).toBeDefined();
      await claudeCodeRenderer.render(ctx, tempDir, skill!);

      const renderedPath = path.join(tempDir, ".claude", "skills", "merge", "SKILL.md");
      const content = await readTestOutput(renderedPath);

      expect(content).toContain(".claude/skills/merge/scripts/merge-helper.sh");
      expect(content).not.toContain("{supporting:");
    });

    it("resolves supporting-file references in SKILL.md body for codex", async () => {
      kspecFull(
        'skill add --id merge --name "Merge" --description "Merge skill" --platform codex',
        tempDir,
      );

      const skillDir = path.join(tempDir, "skills", "merge");
      const scriptsDir = path.join(skillDir, "scripts");
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, "merge-helper.sh"), "#!/bin/bash\necho merge");

      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Merge Skill\n\nRun the helper at {supporting:scripts/merge-helper.sh}.\n",
      );

      const { codexRenderer, ctx, skill } = await loadSkillForTest("merge");
      expect(skill).toBeDefined();
      await codexRenderer.render(ctx, tempDir, skill!);

      const renderedPath = path.join(tempDir, ".agents", "skills", "merge", "SKILL.md");
      const content = await readTestOutput(renderedPath);

      expect(content).toContain(".agents/skills/merge/scripts/merge-helper.sh");
      expect(content).not.toContain("{supporting:");
    });

    it("resolves supporting-file references in copied markdown supporting files", async () => {
      kspecFull(
        'skill add --id merge --name "Merge" --description "Merge skill" --platform claude-code',
        tempDir,
      );

      const skillDir = path.join(tempDir, "skills", "merge");
      const scriptsDir = path.join(skillDir, "scripts");
      const docsDir = path.join(skillDir, "docs");
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, "merge-helper.sh"), "#!/bin/bash\necho merge");

      // Write a markdown doc that references the script
      await fs.writeFile(
        path.join(docsDir, "usage.md"),
        "# Usage\n\nThe helper script is at {supporting:scripts/merge-helper.sh}.\n",
      );

      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Merge Skill\n");

      const { claudeCodeRenderer, ctx, skill } = await loadSkillForTest("merge");
      expect(skill).toBeDefined();
      await claudeCodeRenderer.render(ctx, tempDir, skill!);

      const renderedDocPath = path.join(tempDir, ".claude", "skills", "merge", "docs", "usage.md");
      const content = await readTestOutput(renderedDocPath);

      expect(content).toContain(".claude/skills/merge/scripts/merge-helper.sh");
      expect(content).not.toContain("{supporting:");
    });

    it("resolves both {skill:...} and {supporting:...} references together", async () => {
      kspecFull(
        'skill add --id task-work --name "Task Work" --description "Core task work" --origin core --platform claude-code',
        tempDir,
      );
      kspecFull(
        'skill add --id merge --name "Merge" --description "Merge skill" --platform claude-code',
        tempDir,
      );

      const skillDir = path.join(tempDir, "skills", "merge");
      const scriptsDir = path.join(skillDir, "scripts");
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, "merge-helper.sh"), "#!/bin/bash\necho merge");

      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Merge\n\nUse {skill:task-work} then run {supporting:scripts/merge-helper.sh}.\n",
      );

      const { claudeCodeRenderer, ctx, skill } = await loadSkillForTest("merge");
      expect(skill).toBeDefined();
      await claudeCodeRenderer.render(ctx, tempDir, skill!);

      const renderedPath = path.join(tempDir, ".claude", "skills", "merge", "SKILL.md");
      const content = await readTestOutput(renderedPath);

      expect(content).toContain("/kspec:task-work");
      expect(content).toContain(".claude/skills/merge/scripts/merge-helper.sh");
      expect(content).not.toContain("{skill:");
      expect(content).not.toContain("{supporting:");
    });
  });

  // AC: @portable-skill-supporting-file-references ac-missing-supporting-target-rejected
  describe("ac-missing-supporting-target-rejected", () => {
    it("rejects rendering when supporting file reference points to non-existent file", async () => {
      kspecFull(
        'skill add --id broken --name "Broken" --description "Broken skill" --platform claude-code',
        tempDir,
      );

      const skillDir = path.join(tempDir, "skills", "broken");
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Broken\n\nRun {supporting:scripts/nonexistent.sh}.\n",
      );

      const { claudeCodeRenderer, ctx, skill } = await loadSkillForTest("broken");
      expect(skill).toBeDefined();

      await expect(claudeCodeRenderer.render(ctx, tempDir, skill!)).rejects.toThrow(
        SupportingFileReferenceError,
      );
    });

    it("error names the unresolved file reference", async () => {
      kspecFull(
        'skill add --id broken --name "Broken" --description "Broken skill" --platform codex',
        tempDir,
      );

      const skillDir = path.join(tempDir, "skills", "broken");
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Broken\n\nRun {supporting:scripts/missing-script.sh}.\n",
      );

      const { codexRenderer, ctx, skill } = await loadSkillForTest("broken");
      expect(skill).toBeDefined();

      try {
        await codexRenderer.render(ctx, tempDir, skill!);
        expect.fail("Should have thrown SupportingFileReferenceError");
      } catch (err) {
        expect(err).toBeInstanceOf(SupportingFileReferenceError);
        const error = err as SupportingFileReferenceError;
        expect(error.message).toContain("scripts/missing-script.sh");
        expect(error.message).toContain("broken");
      }
    });
  });

  // AC: @portable-skill-supporting-file-references ac-supporting-reference-boundary
  describe("ac-supporting-reference-boundary", () => {
    it("rejects rendering when supporting reference escapes skill directory", async () => {
      kspecFull(
        'skill add --id escape --name "Escape" --description "Escape attempt" --platform claude-code',
        tempDir,
      );

      const skillDir = path.join(tempDir, "skills", "escape");
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Escape\n\nRun {supporting:../other-skill/secret.sh}.\n",
      );

      const { claudeCodeRenderer, ctx, skill } = await loadSkillForTest("escape");
      expect(skill).toBeDefined();

      await expect(claudeCodeRenderer.render(ctx, tempDir, skill!)).rejects.toThrow(
        SupportingFileReferenceError,
      );
    });

    it("rejects absolute path references", async () => {
      kspecFull(
        'skill add --id abs --name "Abs" --description "Absolute path" --platform claude-code',
        tempDir,
      );

      const skillDir = path.join(tempDir, "skills", "abs");
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Abs\n\nRun {supporting:/etc/passwd}.\n",
      );

      const { claudeCodeRenderer, ctx, skill } = await loadSkillForTest("abs");
      expect(skill).toBeDefined();

      await expect(claudeCodeRenderer.render(ctx, tempDir, skill!)).rejects.toThrow(
        SupportingFileReferenceError,
      );
    });

    it("no escaped path is emitted on boundary violation", async () => {
      kspecFull(
        'skill add --id esc2 --name "Esc2" --description "Escape test" --platform claude-code',
        tempDir,
      );

      const skillDir = path.join(tempDir, "skills", "esc2");
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Esc\n\nRun {supporting:scripts/../../etc/passwd}.\n",
      );

      const { claudeCodeRenderer, ctx, skill } = await loadSkillForTest("esc2");
      expect(skill).toBeDefined();

      try {
        await claudeCodeRenderer.render(ctx, tempDir, skill!);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SupportingFileReferenceError);
        // Verify the error message does not contain a resolved path outside the skill dir
        const error = err as SupportingFileReferenceError;
        expect(error.message).toContain("escapes the skill directory boundary");
      }
    });
  });
});

// ============================================================================
// Integration Tests: Prompt-time Resolution
// ============================================================================

describe("Prompt-time supporting-file reference resolution", () => {
  const tempDirs: string[] = [];

  async function createProjectWithSkill(): Promise<string> {
    const tempDir = await createTempDir("kspec-prompt-supporting-");
    tempDirs.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1.0", project: { name: "Supporting File Test" } }),
    );
    await fs.writeFile(
      path.join(tempDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        skills: [
          {
            _ulid: testUlid("SKIL", 1),
            id: "merge",
            name: "Merge",
            description: "Merge skill",
            origin: "project",
          },
          {
            _ulid: testUlid("SKIL", 2),
            id: "core-skill",
            name: "Core Skill",
            description: "A core skill",
            origin: "core",
          },
        ],
      }),
    );

    // Create skill with supporting files
    const skillDir = path.join(tempDir, "skills", "merge");
    const scriptsDir = path.join(skillDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, "merge-helper.sh"), "#!/bin/bash\necho merge");

    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Merge Skill\n\nRun the helper at {supporting:scripts/merge-helper.sh}.\n",
    );

    return tempDir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => cleanupTempDir(d)));
  });

  // AC: @portable-skill-supporting-file-references ac-prompt-supporting-link-resolution
  it("resolves supporting-file references in prompt for claude-code adapter", async () => {
    const tempDir = await createProjectWithSkill();

    const prompt = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["merge"],
      specDir: tempDir,
      adapterId: "claude-code-acp",
    });

    expect(prompt).toContain(".claude/skills/merge/scripts/merge-helper.sh");
    expect(prompt).not.toContain("{supporting:");
  });

  // AC: @portable-skill-supporting-file-references ac-prompt-supporting-link-resolution
  it("resolves supporting-file references in prompt for codex adapter", async () => {
    const tempDir = await createProjectWithSkill();

    const prompt = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["merge"],
      specDir: tempDir,
      adapterId: "codex-acp",
    });

    expect(prompt).toContain(".agents/skills/merge/scripts/merge-helper.sh");
    expect(prompt).not.toContain("{supporting:");
  });

  // AC: @portable-skill-supporting-file-references ac-prompt-supporting-link-resolution
  it("resolves supporting-file references in prompt for droid adapter", async () => {
    const tempDir = await createProjectWithSkill();

    const prompt = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["merge"],
      specDir: tempDir,
      adapterId: "droid-acp",
    });

    expect(prompt).toContain(".factory/skills/merge/scripts/merge-helper.sh");
    expect(prompt).not.toContain("{supporting:");
  });

  // AC: @portable-skill-supporting-file-references ac-prompt-supporting-link-resolution
  it("leaves supporting-file references intact when no adapter specified", async () => {
    const tempDir = await createProjectWithSkill();

    const prompt = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["merge"],
      specDir: tempDir,
    });

    // Without an adapter, no platform resolution occurs
    expect(prompt).toContain("{supporting:scripts/merge-helper.sh}");
  });

  // AC: @portable-skill-supporting-file-references ac-missing-supporting-target-rejected
  it("rejects prompt build when supporting reference targets non-existent file", async () => {
    const tempDir = await createTempDir("kspec-prompt-missing-");
    tempDirs.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1.0", project: { name: "Missing File Test" } }),
    );
    await fs.writeFile(
      path.join(tempDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        skills: [
          {
            _ulid: testUlid("SKIL", 3),
            id: "broken",
            name: "Broken",
            description: "Broken skill",
            origin: "project",
          },
        ],
      }),
    );

    const skillDir = path.join(tempDir, "skills", "broken");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Broken\n\nRun {supporting:scripts/nonexistent.sh}.\n",
    );

    await expect(
      buildPromptWithSkills({
        basePrompt: "Base prompt",
        skillIds: ["broken"],
        specDir: tempDir,
        adapterId: "claude-code-acp",
      }),
    ).rejects.toThrow(SupportingFileReferenceError);
  });

  // AC: @portable-skill-supporting-file-references ac-supporting-reference-boundary
  it("rejects prompt build when supporting reference escapes boundary", async () => {
    const tempDir = await createTempDir("kspec-prompt-escape-");
    tempDirs.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1.0", project: { name: "Escape Test" } }),
    );
    await fs.writeFile(
      path.join(tempDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        skills: [
          {
            _ulid: testUlid("SKIL", 4),
            id: "escape",
            name: "Escape",
            description: "Escape skill",
            origin: "project",
          },
        ],
      }),
    );

    const skillDir = path.join(tempDir, "skills", "escape");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Escape\n\nRun {supporting:../other/secret.sh}.\n",
    );

    await expect(
      buildPromptWithSkills({
        basePrompt: "Base prompt",
        skillIds: ["escape"],
        specDir: tempDir,
        adapterId: "codex-acp",
      }),
    ).rejects.toThrow(SupportingFileReferenceError);
  });

  // AC: @detached-reviewer-merge-helper ac-helper-path-in-reviewer-guidance
  it("rendered merge skill output contains detached reviewer guidance with resolved helper path", async () => {
    // Copy the shipped merge skill into a temp project and render through buildPromptWithSkills
    // to verify behavioral output rather than inspecting source text.
    const tempDir = await createTempDir("kspec-merge-detached-guidance-");
    tempDirs.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1.0", project: { name: "Merge Guidance Test" } }),
    );
    await fs.writeFile(
      path.join(tempDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        skills: [
          {
            _ulid: testUlid("SKIL", 20),
            id: "merge",
            name: "Merge",
            description: "Merge skill",
            origin: "project",
          },
        ],
      }),
    );

    // Copy shipped merge skill source and supporting files into temp project
    const shippedSkillDir = path.join(__dirname, "..", "templates", "skills", "merge");
    const targetSkillDir = path.join(tempDir, "skills", "merge");
    await fs.cp(shippedSkillDir, targetSkillDir, { recursive: true });

    // Render through the prompt pipeline — this exercises the actual render behavior
    const renderedPrompt = await buildPromptWithSkills({
      basePrompt: "Base",
      skillIds: ["merge"],
      specDir: tempDir,
      adapterId: "claude-code-acp",
    });

    // Rendered output must contain detached reviewer context
    expect(renderedPrompt).toContain("Detached Reviewer Context");
    // Rendered output must contain resolved helper path (not the portable {supporting:} form)
    expect(renderedPrompt).toContain("scripts/detached-reviewer-merge.sh");
    expect(renderedPrompt).not.toContain("{supporting:");
    // The detached section must not contain positive git checkout instructions
    const detachedSection = renderedPrompt.split("Detached Reviewer Context")[1]?.split("## Merge Process")[0] || "";
    const lines = detachedSection.split("\n");
    const positiveCheckoutInstructions = lines.filter(
      (line) => line.trim().startsWith("git checkout") && !line.toLowerCase().includes("do not") && !line.toLowerCase().includes("do **not**"),
    );
    expect(positiveCheckoutInstructions).toHaveLength(0);
  });

  // AC: @detached-reviewer-merge-helper ac-helper-path-in-reviewer-guidance
  it("rendered merge skill output resolves helper path for each platform", async () => {
    // Set up project with merge skill that mirrors the shipped source
    const tempDir = await createTempDir("kspec-merge-render-");
    tempDirs.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1.0", project: { name: "Merge Render Test" } }),
    );
    await fs.writeFile(
      path.join(tempDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        skills: [
          {
            _ulid: testUlid("SKIL", 10),
            id: "merge",
            name: "Merge",
            description: "Merge skill",
            origin: "project",
          },
        ],
      }),
    );

    const skillDir = path.join(tempDir, "skills", "merge");
    const scriptsDir = path.join(skillDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(
      path.join(scriptsDir, "detached-reviewer-merge.sh"),
      "#!/bin/bash\necho merge-helper",
    );
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Merge\n\nRun `bash {supporting:scripts/detached-reviewer-merge.sh}`\n",
    );

    // Claude Code
    const claudePrompt = await buildPromptWithSkills({
      basePrompt: "Base",
      skillIds: ["merge"],
      specDir: tempDir,
      adapterId: "claude-code-acp",
    });
    expect(claudePrompt).toContain(".claude/skills/merge/scripts/detached-reviewer-merge.sh");
    expect(claudePrompt).not.toContain("{supporting:");

    // Codex
    const codexPrompt = await buildPromptWithSkills({
      basePrompt: "Base",
      skillIds: ["merge"],
      specDir: tempDir,
      adapterId: "codex-acp",
    });
    expect(codexPrompt).toContain(".agents/skills/merge/scripts/detached-reviewer-merge.sh");
    expect(codexPrompt).not.toContain("{supporting:");

    // Droid
    const droidPrompt = await buildPromptWithSkills({
      basePrompt: "Base",
      skillIds: ["merge"],
      specDir: tempDir,
      adapterId: "droid-acp",
    });
    expect(droidPrompt).toContain(".factory/skills/merge/scripts/detached-reviewer-merge.sh");
    expect(droidPrompt).not.toContain("{supporting:");
  });

  // AC: @portable-skill-supporting-file-references ac-prompt-supporting-link-resolution
  it("resolves both {skill:...} and {supporting:...} references in prompt", async () => {
    const tempDir = await createProjectWithSkill();

    // Update skill content to have both reference types
    const skillDir = path.join(tempDir, "skills", "merge");
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Merge\n\nSee {skill:core-skill} and run {supporting:scripts/merge-helper.sh}.\n",
    );

    const prompt = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["merge"],
      specDir: tempDir,
      adapterId: "claude-code-acp",
    });

    expect(prompt).toContain("/merge");
    expect(prompt).toContain(".claude/skills/merge/scripts/merge-helper.sh");
    expect(prompt).not.toContain("{skill:");
    expect(prompt).not.toContain("{supporting:");
  });
});
