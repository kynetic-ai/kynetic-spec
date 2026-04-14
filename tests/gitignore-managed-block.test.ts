// Tests for managed-block gitignore writer.
// AC: @trait-idempotent-file-scaffold ac-force-backs-up-before-overwrite — N/A: managed-block writer appends to files, it does not overwrite them. Force semantics are handled at the init/setup command level, not at the gitignore block level.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  parseManagedBlock,
  updateManagedBlock,
  serializeManagedBlock,
  ensureKspecGitignore,
  needsKspecGitignoreUpdate,
  buildKspecGitignoreEntries,
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  KSPEC_GITIGNORE_ENTRIES,
} from "../src/parser/gitignore.js";
import {
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  readTestOutput,
  kspec,
} from "./helpers/cli.js";

// ── Pure function tests (parseManagedBlock / updateManagedBlock) ──

describe("parseManagedBlock", () => {
  it("returns null block/after when no managed block exists", () => {
    const content = "node_modules/\ndist/\n";
    const result = parseManagedBlock(content);
    expect(result.block).toBeNull();
    expect(result.after).toBeNull();
    expect(result.before).toEqual(["node_modules/", "dist/", ""]);
  });

  it("parses an existing managed block correctly", () => {
    const content = [
      "node_modules/",
      "",
      MANAGED_BLOCK_START,
      ".kspec/",
      ".kspec-sessions/",
      MANAGED_BLOCK_END,
      "",
      "dist/",
      "",
    ].join("\n");

    const result = parseManagedBlock(content);
    expect(result.before).toEqual(["node_modules/", ""]);
    expect(result.block).toEqual([".kspec/", ".kspec-sessions/"]);
    expect(result.after).toEqual(["", "dist/", ""]);
  });

  it("handles empty file", () => {
    const result = parseManagedBlock("");
    expect(result.block).toBeNull();
    expect(result.before).toEqual([""]);
  });
});

describe("updateManagedBlock", () => {
  // AC: @complete-auto-gitignore ac-all-transient-paths-present
  it("creates managed block with all entries when none exists", () => {
    const content = "node_modules/\ndist/\n";
    const { newContent, result } = updateManagedBlock(content);

    expect(result.blockCreated).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.entriesAdded).toEqual([...KSPEC_GITIGNORE_ENTRIES]);

    // Verify all entries present
    for (const entry of KSPEC_GITIGNORE_ENTRIES) {
      expect(newContent).toContain(entry);
    }

    // Verify sentinels present
    expect(newContent).toContain(MANAGED_BLOCK_START);
    expect(newContent).toContain(MANAGED_BLOCK_END);

    // Verify existing content preserved
    expect(newContent).toContain("node_modules/");
    expect(newContent).toContain("dist/");
  });

  // AC: @complete-auto-gitignore ac-kspec-entries-idempotent
  it("returns unchanged when all entries already present", () => {
    const blockLines = [...KSPEC_GITIGNORE_ENTRIES];
    const content = serializeManagedBlock(
      ["node_modules/", ""],
      blockLines,
      [""],
    );

    const { result } = updateManagedBlock(content);
    expect(result.changed).toBe(false);
    expect(result.entriesAdded).toEqual([]);
    expect(result.blockCreated).toBe(false);
  });

  it("adds missing entries to existing block without removing existing ones", () => {
    // Block only has .kspec/ — should add the rest
    const content = serializeManagedBlock(
      ["node_modules/", ""],
      [".kspec/"],
      [""],
    );

    const { newContent, result } = updateManagedBlock(content);
    expect(result.changed).toBe(true);
    expect(result.blockCreated).toBe(false);
    expect(result.entriesAdded.length).toBeGreaterThan(0);

    // Original entry still present
    expect(newContent).toContain(".kspec/");

    // All canonical entries now present
    for (const entry of KSPEC_GITIGNORE_ENTRIES) {
      expect(newContent).toContain(entry);
    }
  });

  // AC: @complete-auto-gitignore ac-existing-entries-preserved
  it("preserves user content above and below managed block", () => {
    const content = [
      "# My project ignores",
      "node_modules/",
      "dist/",
      "",
      MANAGED_BLOCK_START,
      ".kspec/",
      MANAGED_BLOCK_END,
      "",
      "# Custom ignores",
      "*.log",
      "",
    ].join("\n");

    const { newContent } = updateManagedBlock(content);

    // User content above block preserved
    expect(newContent).toContain("# My project ignores");
    expect(newContent).toContain("node_modules/");
    expect(newContent).toContain("dist/");

    // User content below block preserved
    expect(newContent).toContain("# Custom ignores");
    expect(newContent).toContain("*.log");
  });

  it("preserves user entries added inside the managed block", () => {
    // User manually added .my-custom-cache/ inside the block
    const content = serializeManagedBlock(
      [""],
      [...KSPEC_GITIGNORE_ENTRIES, ".my-custom-cache/"],
      [""],
    );

    const { newContent, result } = updateManagedBlock(content);
    expect(result.changed).toBe(false);
    expect(newContent).toContain(".my-custom-cache/");
  });

  it("creates block at end of empty file", () => {
    const { newContent, result } = updateManagedBlock("");

    expect(result.blockCreated).toBe(true);
    expect(result.changed).toBe(true);
    expect(newContent).toContain(MANAGED_BLOCK_START);
    expect(newContent).toContain(MANAGED_BLOCK_END);

    for (const entry of KSPEC_GITIGNORE_ENTRIES) {
      expect(newContent).toContain(entry);
    }
  });

  it("handles file without trailing newline", () => {
    const content = "node_modules/\ndist/";
    const { newContent } = updateManagedBlock(content);
    expect(newContent.endsWith("\n")).toBe(true);
  });
});

// ── File-level operation tests ──

describe("ensureKspecGitignore", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-gitignore-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @trait-idempotent-file-scaffold ac-fresh-file-creation
  it("creates .gitignore with managed block when file does not exist", async () => {
    const result = await ensureKspecGitignore(testDir);

    expect(result.changed).toBe(true);
    expect(result.blockCreated).toBe(true);
    expect(result.entriesAdded).toEqual([...KSPEC_GITIGNORE_ENTRIES]);

    const content = await readTestOutput(path.join(testDir, ".gitignore"));
    expect(content).toContain(MANAGED_BLOCK_START);
    expect(content).toContain(MANAGED_BLOCK_END);

    for (const entry of KSPEC_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });

  // AC: @complete-auto-gitignore ac-existing-entries-preserved
  it("preserves existing non-kspec entries when adding managed block", async () => {
    const existingContent = "# My ignores\nnode_modules/\ndist/\n*.log\n";
    await fs.writeFile(path.join(testDir, ".gitignore"), existingContent, "utf-8");

    const result = await ensureKspecGitignore(testDir);
    expect(result.changed).toBe(true);

    const content = await readTestOutput(path.join(testDir, ".gitignore"));
    expect(content).toContain("# My ignores");
    expect(content).toContain("node_modules/");
    expect(content).toContain("dist/");
    expect(content).toContain("*.log");
  });

  // AC: @complete-auto-gitignore ac-kspec-entries-idempotent
  // AC: @trait-idempotent-file-scaffold ac-existing-file-preserved-without-force
  it("is idempotent — second run produces no changes", async () => {
    // First run creates the block
    const first = await ensureKspecGitignore(testDir);
    expect(first.changed).toBe(true);

    const contentAfterFirst = await readTestOutput(path.join(testDir, ".gitignore"));

    // Second run — no changes
    const second = await ensureKspecGitignore(testDir);
    expect(second.changed).toBe(false);
    expect(second.entriesAdded).toEqual([]);

    const contentAfterSecond = await readTestOutput(path.join(testDir, ".gitignore"));
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  it("uses configured shadow directory when provided", async () => {
    const result = await ensureKspecGitignore(testDir, { shadowDir: ".specs" });

    expect(result.changed).toBe(true);
    expect(result.blockCreated).toBe(true);

    const content = await readTestOutput(path.join(testDir, ".gitignore"));
    expect(content).toContain(".specs/");
    expect(content).not.toContain(".kspec/");
    // Other entries still present
    expect(content).toContain(".kspec-sessions/");
    expect(content).toContain(".kspec-worktrees/");
  });

  it("uses configured worktree root when provided", async () => {
    const result = await ensureKspecGitignore(testDir, { worktreeRoot: ".dispatch-root" });

    expect(result.changed).toBe(true);
    expect(result.blockCreated).toBe(true);

    const content = await readTestOutput(path.join(testDir, ".gitignore"));
    expect(content).toContain(".dispatch-root/");
    expect(content).not.toContain(".kspec-worktrees/");
    // Default shadow dir still present
    expect(content).toContain(".kspec/");
  });

  it("adds missing entries to an existing partial managed block", async () => {
    // Write a managed block with only .kspec/
    const partial = [
      MANAGED_BLOCK_START,
      ".kspec/",
      MANAGED_BLOCK_END,
      "",
    ].join("\n");
    await fs.writeFile(path.join(testDir, ".gitignore"), partial, "utf-8");

    const result = await ensureKspecGitignore(testDir);
    expect(result.changed).toBe(true);
    expect(result.blockCreated).toBe(false);
    expect(result.entriesAdded.length).toBeGreaterThan(0);

    const content = await readTestOutput(path.join(testDir, ".gitignore"));
    for (const entry of KSPEC_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });
});

describe("needsKspecGitignoreUpdate", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-gitignore-needs-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("returns true when file does not exist", async () => {
    expect(await needsKspecGitignoreUpdate(testDir)).toBe(true);
  });

  it("returns true when managed block is missing", async () => {
    await fs.writeFile(path.join(testDir, ".gitignore"), "node_modules/\n", "utf-8");
    expect(await needsKspecGitignoreUpdate(testDir)).toBe(true);
  });

  it("returns false when all entries present", async () => {
    await ensureKspecGitignore(testDir);
    expect(await needsKspecGitignoreUpdate(testDir)).toBe(false);
  });
});

// ── Integration: AC coverage via kspec init ──

describe("kspec init gitignore integration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-init-gitignore-");
    initGitRepo(testDir);
    await fs.writeFile(path.join(testDir, "README.md"), "# Test\n");
    execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: "pipe" });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @complete-auto-gitignore ac-all-transient-paths-present
  it("init creates gitignore with all transient paths", () => {
    const result = kspec("init --no-prompt", testDir);
    expect(result.exitCode).toBe(0);

    const content = readTestOutputSync(path.join(testDir, ".gitignore"));
    for (const entry of KSPEC_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }

    expect(content).toContain(MANAGED_BLOCK_START);
    expect(content).toContain(MANAGED_BLOCK_END);
  });

  // AC: @complete-auto-gitignore ac-existing-entries-preserved
  it("init preserves existing user gitignore entries", async () => {
    const userContent = "# User rules\n*.tmp\nbuild/\n";
    await fs.writeFile(path.join(testDir, ".gitignore"), userContent, "utf-8");
    execSync('git add .gitignore && git commit -m "add gitignore"', {
      cwd: testDir,
      stdio: "pipe",
    });

    const result = kspec("init --no-prompt", testDir);
    expect(result.exitCode).toBe(0);

    const content = readTestOutputSync(path.join(testDir, ".gitignore"));
    expect(content).toContain("# User rules");
    expect(content).toContain("*.tmp");
    expect(content).toContain("build/");
  });

  // AC: @complete-auto-gitignore ac-kspec-entries-idempotent
  it("running init twice does not duplicate entries", () => {
    const result1 = kspec("init --no-prompt", testDir);
    expect(result1.exitCode).toBe(0);

    const content1 = readTestOutputSync(path.join(testDir, ".gitignore"));

    // Commit the gitignore changes so second init doesn't fail on uncommitted changes
    try {
      execSync('git add .gitignore && git commit -m "gitignore" --allow-empty', {
        cwd: testDir,
        stdio: "pipe",
      });
    } catch {
      // May already be committed by init
    }

    // Second init on existing project
    const result2 = kspec("init --no-prompt", testDir);
    // Second init returns success (already exists)
    expect(result2.exitCode).toBe(0);

    const content2 = readTestOutputSync(path.join(testDir, ".gitignore"));

    // Count occurrences of each entry — should be exactly 1
    for (const entry of KSPEC_GITIGNORE_ENTRIES) {
      const count = content2.split(entry).length - 1;
      expect(count).toBe(1);
    }
  });

  // AC: @complete-auto-gitignore ac-no-untracked-after-common-commands
  it("no kspec-created directory appears as untracked after init and transient state creation", async () => {
    const result = kspec("init --no-prompt", testDir);
    expect(result.exitCode).toBe(0);

    // Commit the gitignore so it doesn't show up as untracked
    execSync('git add .gitignore && git commit -m "gitignore" --allow-empty', {
      cwd: testDir,
      stdio: "pipe",
    });

    // Simulate the transient state that post-init commands lazily create:
    // - dispatch worktree pool (.kspec-worktrees/ with a child worktree dir)
    // - session storage (.kspec-sessions/ with a session file)
    // - plan drafts (plans/ with a draft file)
    // - dispatch workspace metadata file
    // - dispatch shadow mutation lock file
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(path.join(testDir, ".kspec-worktrees", "dispatch-test"), { recursive: true });
    writeFileSync(path.join(testDir, ".kspec-worktrees", "dispatch-test", "README"), "worktree");
    mkdirSync(path.join(testDir, ".kspec-sessions", "session-abc"), { recursive: true });
    writeFileSync(path.join(testDir, ".kspec-sessions", "session-abc", "state.json"), "{}");
    mkdirSync(path.join(testDir, "plans"), { recursive: true });
    writeFileSync(path.join(testDir, "plans", "draft.md"), "# Plan draft");
    writeFileSync(path.join(testDir, ".kspec-dispatch-workspace.json"), "{}");
    writeFileSync(path.join(testDir, ".kspec-dispatch-shadow-mutation"), "");

    // Check git status — none of the kspec-created transient content should be untracked
    const statusOutput = execSync("git status --porcelain", {
      cwd: testDir,
      encoding: "utf-8",
    });

    // Filter for untracked kspec directories (lines starting with "?? ")
    const untrackedKspecEntries = statusOutput
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3))
      .filter(
        (entry) =>
          entry.startsWith(".kspec") ||
          entry.startsWith("plans/") ||
          entry.startsWith(".kspec-worktrees/") ||
          entry.startsWith(".kspec-sessions/") ||
          entry.startsWith(".kspec-dispatch-"),
      );

    expect(untrackedKspecEntries).toEqual([]);
  });

  // AC: @trait-idempotent-file-scaffold ac-step-reports-action
  it("setup reports gitignore actions in summary", () => {
    // First init to set up project
    kspec("init --no-prompt", testDir);

    // Remove managed block to force repair
    const gitignorePath = path.join(testDir, ".gitignore");
    const content = readTestOutputSync(gitignorePath);
    const stripped = content
      .split("\n")
      .filter(
        (line) =>
          line.trim() !== MANAGED_BLOCK_START &&
          line.trim() !== MANAGED_BLOCK_END &&
          !KSPEC_GITIGNORE_ENTRIES.includes(line.trim()),
      )
      .join("\n");
    writeFileSyncSafe(gitignorePath, stripped);

    // Run setup — should report adding the block
    const result = kspec("setup --agent claude-code", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/gitignore|managed block/i);
  });
});

describe("buildKspecGitignoreEntries custom overrides", () => {
  it("uses custom shadow directory when provided", () => {
    const entries = buildKspecGitignoreEntries(".specs");
    expect(entries).toContain(".specs/");
    expect(entries).not.toContain(".kspec/");
  });

  it("uses default .kspec/ when no shadow directory provided", () => {
    const entries = buildKspecGitignoreEntries();
    expect(entries).toContain(".kspec/");
  });

  it("uses custom worktree root when provided", () => {
    const entries = buildKspecGitignoreEntries(undefined, ".dispatch-root");
    expect(entries).toContain(".dispatch-root/");
    expect(entries).not.toContain(".kspec-worktrees/");
    // Other entries still present
    expect(entries).toContain(".kspec/");
    expect(entries).toContain(".kspec-sessions/");
  });

  it("uses default .kspec-worktrees/ when no worktree root provided", () => {
    const entries = buildKspecGitignoreEntries();
    expect(entries).toContain(".kspec-worktrees/");
  });

  it("uses both custom shadow and custom worktree root together", () => {
    const entries = buildKspecGitignoreEntries(".my-specs", ".my-worktrees");
    expect(entries).toContain(".my-specs/");
    expect(entries).toContain(".my-worktrees/");
    expect(entries).not.toContain(".kspec/");
    expect(entries).not.toContain(".kspec-worktrees/");
  });
});

// Sync helper for reading files in non-async test contexts
function readTestOutputSync(filePath: string): string {
  const { readFileSync } = require("node:fs");
  return readFileSync(filePath, "utf-8");
}

function writeFileSyncSafe(filePath: string, content: string): void {
  const { writeFileSync } = require("node:fs");
  writeFileSync(filePath, content, "utf-8");
}
