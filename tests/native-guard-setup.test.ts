/**
 * Tests for setup command's native guard migration.
 *
 * Verifies that kspec setup installs native kspec guard worktree command
 * instead of bash scripts, migrates old entries, and handles idempotency.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { kspec, createTempDir, cleanupTempDir, initGitRepo, readTestOutputSync } from "./helpers/cli.js";

describe("kspec setup native guard migration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("guard-setup");
    await initGitRepo(tempDir);
    // Initialize kspec so setup has a valid project
    kspec("init", tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @native-guard-commands ac-setup-native
  it("installs native kspec guard worktree command in PreToolUse hooks", () => {
    const result = kspec("setup", tempDir, {
      env: { CLAUDECODE: "1" },
    });
    expect(result.exitCode).toBe(0);

    const settingsPath = path.join(tempDir, ".claude", "settings.json");
    const settings = JSON.parse(readTestOutputSync(settingsPath));
    const preToolUse = settings.hooks?.PreToolUse;

    expect(preToolUse).toBeDefined();
    const hasNativeGuard = preToolUse.some((entry: { hooks?: Array<{ command?: string }> }) =>
      entry.hooks?.some((h) => h.command === "kspec guard worktree"),
    );
    expect(hasNativeGuard).toBe(true);
  });

  // AC: @native-guard-commands ac-setup-native - no bash scripts created
  it("does not create bash guard scripts in .claude/hooks/", async () => {
    kspec("setup", tempDir, { env: { CLAUDECODE: "1" } });

    const hooksDir = path.join(tempDir, ".claude", "hooks");
    let files: string[] = [];
    try {
      files = await fs.readdir(hooksDir);
    } catch {
      // hooks dir might not exist — that's fine
    }
    expect(files).not.toContain("kspec-worktree-guard.sh");
    expect(files).not.toContain("ralph-task-limit-guard.sh");
  });

  // AC: @native-guard-commands ac-no-task-limit-hook
  it("does not install task-limit guard hook", () => {
    kspec("setup", tempDir, { env: { CLAUDECODE: "1" } });

    const settingsPath = path.join(tempDir, ".claude", "settings.json");
    const settings = JSON.parse(readTestOutputSync(settingsPath));
    const preToolUse = settings.hooks?.PreToolUse || [];

    const hasTaskLimit = preToolUse.some((entry: { hooks?: Array<{ command?: string }> }) =>
      entry.hooks?.some((h) => h.command?.includes("ralph-task-limit-guard")),
    );
    expect(hasTaskLimit).toBe(false);
  });

  // AC: @native-guard-commands ac-migrate-hooks - replaces old entries
  it("replaces old bash script entries with native command", async () => {
    // Create old-style settings.json with bash script references
    const claudeDir = path.join(tempDir, ".claude");
    const hooksDir = path.join(claudeDir, "hooks");
    await fs.mkdir(hooksDir, { recursive: true });

    // Write old bash script
    await fs.writeFile(path.join(hooksDir, "kspec-worktree-guard.sh"), "#!/bin/bash\necho 'old'", {
      mode: 0o755,
    });

    // Write old-style settings
    const settingsPath = path.join(claudeDir, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: ".claude/hooks/kspec-worktree-guard.sh",
                },
              ],
            },
          ],
        },
      }),
    );

    // Run setup
    kspec("setup", tempDir, { env: { CLAUDECODE: "1" } });

    // Verify old entries replaced
    const settings = JSON.parse(readTestOutputSync(settingsPath));
    const preToolUse = settings.hooks?.PreToolUse || [];

    // No old bash script references
    const hasOldScript = preToolUse.some((entry: { hooks?: Array<{ command?: string }> }) =>
      entry.hooks?.some((h) => h.command?.includes("kspec-worktree-guard.sh")),
    );
    expect(hasOldScript).toBe(false);

    // Has native command
    const hasNativeGuard = preToolUse.some((entry: { hooks?: Array<{ command?: string }> }) =>
      entry.hooks?.some((h) => h.command === "kspec guard worktree"),
    );
    expect(hasNativeGuard).toBe(true);
  });

  // AC: @native-guard-commands ac-migrate-hooks - deletes old script files
  it("deletes old bash script files during migration", async () => {
    const hooksDir = path.join(tempDir, ".claude", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });

    // Create old scripts
    await fs.writeFile(
      path.join(hooksDir, "kspec-worktree-guard.sh"),
      "#!/bin/bash\necho 'old guard'",
    );
    await fs.writeFile(
      path.join(hooksDir, "ralph-task-limit-guard.sh"),
      "#!/bin/bash\necho 'old limit'",
    );

    // Write old settings
    const settingsPath = path.join(tempDir, ".claude", "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: ".claude/hooks/kspec-worktree-guard.sh",
                },
                {
                  type: "command",
                  command: ".claude/hooks/ralph-task-limit-guard.sh",
                },
              ],
            },
          ],
        },
      }),
    );

    // Run setup
    kspec("setup", tempDir, { env: { CLAUDECODE: "1" } });

    // Verify old files deleted
    const files = await fs.readdir(hooksDir);
    expect(files).not.toContain("kspec-worktree-guard.sh");
    expect(files).not.toContain("ralph-task-limit-guard.sh");
  });

  // AC: @native-guard-commands ac-idempotent
  it("does not create duplicate PreToolUse entries on repeated runs", { timeout: 60_000 }, () => {
    // Run setup twice
    kspec("setup", tempDir, { env: { CLAUDECODE: "1" } });
    kspec("setup", tempDir, { env: { CLAUDECODE: "1" } });

    const settingsPath = path.join(tempDir, ".claude", "settings.json");
    const settings = JSON.parse(readTestOutputSync(settingsPath));
    const preToolUse = settings.hooks?.PreToolUse || [];

    // Count entries with native guard command
    let guardCount = 0;
    for (const entry of preToolUse) {
      for (const hook of entry.hooks || []) {
        if (hook.command === "kspec guard worktree") {
          guardCount++;
        }
      }
    }
    expect(guardCount).toBe(1);
  });

  // AC: @native-guard-commands ac-idempotent - preserves other PreToolUse entries
  it("preserves unrelated PreToolUse entries during migration", async () => {
    const settingsPath = path.join(tempDir, ".claude", "settings.json");
    await fs.mkdir(path.join(tempDir, ".claude"), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: ".claude/hooks/kspec-worktree-guard.sh",
                },
              ],
            },
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "my-custom-guard.sh",
                },
              ],
            },
          ],
        },
      }),
    );

    kspec("setup", tempDir, { env: { CLAUDECODE: "1" } });

    const settings = JSON.parse(readTestOutputSync(settingsPath));
    const preToolUse = settings.hooks?.PreToolUse || [];

    // Custom guard should still be present
    const hasCustom = preToolUse.some((entry: { hooks?: Array<{ command?: string }> }) =>
      entry.hooks?.some((h) => h.command === "my-custom-guard.sh"),
    );
    expect(hasCustom).toBe(true);

    // Native guard should be present
    const hasNative = preToolUse.some((entry: { hooks?: Array<{ command?: string }> }) =>
      entry.hooks?.some((h) => h.command === "kspec guard worktree"),
    );
    expect(hasNative).toBe(true);
  });
});
