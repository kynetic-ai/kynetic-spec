/**
 * Tests for setup seeding (permission and memory seeding)
 *
 * AC: @new-project-bootstrapping ac-1 - permission seeding
 * AC: @new-project-bootstrapping ac-2 - memory seeding
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  kspec,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
} from "../helpers/cli.js";

// Direct imports for unit testing
import {
  encodeProjectPath,
  seedPermissions,
  seedMemory,
  generateProjectSeedContent,
  claudeCodeMemoryWriter,
} from "../../src/cli/commands/setup-seeding.js";

/**
 * Helper: Set up a temp directory with git and kspec init.
 */
async function setupKspecProject(tempDir: string): Promise<void> {
  initGitRepo(tempDir);
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "Initial"', {
    cwd: tempDir,
    stdio: "pipe",
  });

  const initResult = kspec("init --no-prompt", tempDir, {
    env: { CLAUDECODE: "1", KSPEC_AUTHOR: "@test" },
  });
  expect(initResult.exitCode).toBe(0);
}

/**
 * Helper: Clean up memory files created in home directory by tests.
 */
async function cleanupMemoryDir(tempDir: string): Promise<void> {
  try {
    const memoryPath = claudeCodeMemoryWriter.getMemoryPath(tempDir);
    // Remove the project-specific directory under ~/.claude/projects/
    const projectDir = path.dirname(path.dirname(memoryPath)); // up from memory/MEMORY.md
    await fs.rm(projectDir, { recursive: true, force: true });
  } catch (_err) {
    // Ignore cleanup errors
  }
}

// --- Path Encoding Tests ---

describe("encodeProjectPath", () => {
  it("should encode a typical Linux path", () => {
    const result = encodeProjectPath("/home/user/my-project");
    expect(result).toBe("home-user-my-project");
  });

  it("should handle paths with existing dashes", () => {
    const result = encodeProjectPath("/home/user/my-cool-project");
    expect(result).toBe("home-user-my-cool-project");
  });

  it("should normalize trailing slashes", () => {
    const result = encodeProjectPath("/home/user/project/");
    expect(result).toBe("home-user-project");
  });

  it("should handle root path", () => {
    const result = encodeProjectPath("/");
    expect(result).toBe("");
  });

  it("should handle deeply nested paths", () => {
    const result = encodeProjectPath("/a/b/c/d/e");
    expect(result).toBe("a-b-c-d-e");
  });

  it("should handle Windows-style backslash paths", () => {
    const result = encodeProjectPath("C:\\Users\\user\\project");
    expect(result).toBe("C:-Users-user-project");
  });

  it("should handle mixed separators", () => {
    const result = encodeProjectPath("C:\\Users/user\\project/");
    expect(result).toBe("C:-Users-user-project");
  });

  it("should produce consistent results with and without trailing separator", () => {
    const withSlash = encodeProjectPath("/home/user/project/");
    const withoutSlash = encodeProjectPath("/home/user/project");
    expect(withSlash).toBe(withoutSlash);
  });
});

// --- Permission Seeding Tests ---

describe("seedPermissions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-seed-perms-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @new-project-bootstrapping ac-1
  it("should create permissions key in settings.json with expected patterns", async () => {
    await fs.mkdir(path.join(tempDir, ".claude"), { recursive: true });

    const result = await seedPermissions(tempDir, "claude-code");

    expect(result.seeded).toBe(true);
    const config = JSON.parse(
      await fs.readFile(
        path.join(tempDir, ".claude", "settings.json"),
        "utf-8",
      ),
    );
    expect(config.permissions).toBeDefined();
    expect(config.permissions.allow).toContain("Bash(kspec:*)");
    expect(config.permissions.allow).toContain("Bash(npm run build:*)");
    expect(config.permissions.allow).toContain("Bash(git add:*)");
  });

  // AC: @new-project-bootstrapping ac-1
  it("should merge with existing hooks in settings.json", async () => {
    await fs.mkdir(path.join(tempDir, ".claude"), { recursive: true });
    const existing = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "echo test" }] },
        ],
      },
    };
    await fs.writeFile(
      path.join(tempDir, ".claude", "settings.json"),
      JSON.stringify(existing, null, 2),
      "utf-8",
    );

    const result = await seedPermissions(tempDir, "claude-code");

    expect(result.seeded).toBe(true);
    const config = JSON.parse(
      await fs.readFile(
        path.join(tempDir, ".claude", "settings.json"),
        "utf-8",
      ),
    );
    // Hooks should be preserved
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
    // Permissions should be added
    expect(config.permissions.allow).toContain("Bash(kspec:*)");
  });

  it("should skip when permissions key already exists", async () => {
    await fs.mkdir(path.join(tempDir, ".claude"), { recursive: true });
    const existing = {
      permissions: { allow: ["Bash(custom:*)"] },
    };
    await fs.writeFile(
      path.join(tempDir, ".claude", "settings.json"),
      JSON.stringify(existing, null, 2),
      "utf-8",
    );

    const result = await seedPermissions(tempDir, "claude-code");

    expect(result.seeded).toBe(false);
    expect(result.message).toContain("already configured");

    // Existing permissions should be unchanged
    const config = JSON.parse(
      await fs.readFile(
        path.join(tempDir, ".claude", "settings.json"),
        "utf-8",
      ),
    );
    expect(config.permissions.allow).toEqual(["Bash(custom:*)"]);
  });

  it("should merge kspec patterns with existing permissions when force is set", async () => {
    await fs.mkdir(path.join(tempDir, ".claude"), { recursive: true });
    const existing = {
      permissions: { allow: ["Bash(custom:*)"] },
    };
    await fs.writeFile(
      path.join(tempDir, ".claude", "settings.json"),
      JSON.stringify(existing, null, 2),
      "utf-8",
    );

    const result = await seedPermissions(tempDir, "claude-code", {
      force: true,
    });

    expect(result.seeded).toBe(true);
    const config = JSON.parse(
      await fs.readFile(
        path.join(tempDir, ".claude", "settings.json"),
        "utf-8",
      ),
    );
    // Should contain BOTH custom and kspec patterns (additive merge)
    expect(config.permissions.allow).toContain("Bash(kspec:*)");
    expect(config.permissions.allow).toContain("Bash(custom:*)");
  });

  it("should only run for claude-code agent type", async () => {
    const result = await seedPermissions(tempDir, "aider");

    expect(result.seeded).toBe(false);
    expect(result.message).toContain("not applicable");
  });

  it("should produce no file changes in dry-run", async () => {
    const result = await seedPermissions(tempDir, "claude-code", {
      dryRun: true,
    });

    expect(result.seeded).toBe(true);
    // File should NOT exist
    await expect(
      fs.access(path.join(tempDir, ".claude", "settings.json")),
    ).rejects.toThrow();
  });

  it("should fail safely when settings.json contains malformed JSON", async () => {
    await fs.mkdir(path.join(tempDir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, ".claude", "settings.json"),
      "{ invalid json content",
      "utf-8",
    );

    const result = await seedPermissions(tempDir, "claude-code");

    expect(result.seeded).toBe(false);
    expect(result.message).toContain("invalid JSON");

    // Original file should be untouched
    const content = await fs.readFile(
      path.join(tempDir, ".claude", "settings.json"),
      "utf-8",
    );
    expect(content).toBe("{ invalid json content");
  });
});

// --- Memory Seeding Tests ---

describe("seedMemory", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-seed-memory-");
  });

  afterEach(async () => {
    await cleanupMemoryDir(tempDir);
    await cleanupTempDir(tempDir);
  });

  it("should generate content with project conventions", async () => {
    const content = await generateProjectSeedContent(tempDir);

    expect(content).toContain("Project Memory");
    expect(content).toContain("kspec");
    expect(content).toContain(".kspec/");
    expect(content).toContain("kspec session start");
    expect(content).toContain("kspec tasks ready");
    expect(content).toContain("<!-- kspec-seeded:");
  });

  it("should not include volatile data like task counts", async () => {
    const content = await generateProjectSeedContent(tempDir);

    expect(content).not.toMatch(/\d+ tasks?/i);
    expect(content).not.toMatch(/pending|in_progress|completed/i);
  });

  // AC: @new-project-bootstrapping ac-2
  it("should create memory file at correct Claude Code path", async () => {
    const memoryPath = claudeCodeMemoryWriter.getMemoryPath(tempDir);

    expect(memoryPath).toContain(".claude/projects/");
    expect(memoryPath).toContain("memory/MEMORY.md");
  });

  // AC: @new-project-bootstrapping ac-2
  it("should seed memory with project content when setup runs", async () => {
    const result = await seedMemory(tempDir, "claude-code");

    expect(result.seeded).toBe(true);
    const memoryPath = claudeCodeMemoryWriter.getMemoryPath(tempDir);
    const content = await fs.readFile(memoryPath, "utf-8");
    expect(content).toContain("Project Memory");
    expect(content).toContain("kspec");
    expect(content).toContain("<!-- kspec-seeded:");
  });

  it("should create parent directories if needed", async () => {
    const result = await seedMemory(tempDir, "claude-code");

    expect(result.seeded).toBe(true);
    const memoryPath = claudeCodeMemoryWriter.getMemoryPath(tempDir);
    const content = await fs.readFile(memoryPath, "utf-8");
    expect(content).toContain("Project Memory");
  });

  it("should skip when memory file already exists", async () => {
    // Seed once
    await seedMemory(tempDir, "claude-code");

    // Seed again
    const result = await seedMemory(tempDir, "claude-code");

    expect(result.seeded).toBe(false);
    expect(result.message).toContain("already exists");
  });

  it("should regenerate when force flag is set", async () => {
    // Seed once
    await seedMemory(tempDir, "claude-code");

    // Seed again with force
    const result = await seedMemory(tempDir, "claude-code", { force: true });

    expect(result.seeded).toBe(true);
  });

  it("should include kspec-seeded marker", async () => {
    await seedMemory(tempDir, "claude-code");

    const memoryPath = claudeCodeMemoryWriter.getMemoryPath(tempDir);
    const content = await fs.readFile(memoryPath, "utf-8");
    expect(content).toMatch(/<!-- kspec-seeded: \d{4}-\d{2}-\d{2}T/);
  });

  it("should produce no file changes in dry-run", async () => {
    const result = await seedMemory(tempDir, "claude-code", { dryRun: true });

    expect(result.seeded).toBe(true);
    const memoryPath = claudeCodeMemoryWriter.getMemoryPath(tempDir);
    await expect(fs.access(memoryPath)).rejects.toThrow();
  });

  it("should return no-op for unsupported agent types", async () => {
    const result = await seedMemory(tempDir, "aider");

    expect(result.seeded).toBe(false);
    expect(result.message).toContain("no memory writer");
  });
});

// --- Pipeline Integration Tests ---

describe("setup pipeline integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-seed-pipeline-");
  });

  afterEach(async () => {
    await cleanupMemoryDir(tempDir);
    await cleanupTempDir(tempDir);
  });

  // AC: @new-project-bootstrapping ac-1, ac-2
  it("should include seeding steps in setup output", async () => {
    await setupKspecProject(tempDir);

    const result = kspec("setup", tempDir, {
      env: { CLAUDECODE: "1", KSPEC_AUTHOR: "@test" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Seed permissions");
    expect(result.stdout).toContain("Seed memory");
  });

  it("should report seeding in --status output", async () => {
    await setupKspecProject(tempDir);

    // Run setup first to seed
    kspec("setup", tempDir, {
      env: { CLAUDECODE: "1", KSPEC_AUTHOR: "@test" },
    });

    const result = kspec("setup --status", tempDir, {
      env: { CLAUDECODE: "1", KSPEC_AUTHOR: "@test" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Seeding:");
    expect(result.stdout).toContain("Permissions:");
    expect(result.stdout).toContain("Memory:");
  });

  it("should skip permission seeding on second run", async () => {
    await setupKspecProject(tempDir);

    // First run seeds
    kspec("setup", tempDir, {
      env: { CLAUDECODE: "1", KSPEC_AUTHOR: "@test" },
    });

    // Second run should skip
    const result = kspec("setup", tempDir, {
      env: { CLAUDECODE: "1", KSPEC_AUTHOR: "@test" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Seed permissions");
    expect(result.stdout).toContain("already configured");
  });
});
