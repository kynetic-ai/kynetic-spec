/**
 * Tests that git subprocesses in dispatch and shadow contexts suppress
 * interactive credential prompts via GIT_TERMINAL_PROMPT=0.
 *
 * When git cannot authenticate (no credential helper configured, wrong creds),
 * it falls back to an interactive terminal prompt for username/password.
 * In daemon/dispatch mode, this hangs the process indefinitely because there
 * is no terminal. Setting GIT_TERMINAL_PROMPT=0 tells git to fail immediately,
 * letting the existing error-handling code run.
 *
 * AC: @dispatch-remote-branch-sync ac-push-non-fatal
 * AC: @dispatch-remote-branch-sync ac-transient-no-degrade
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { buildDispatchGitEnv } from "../src/agent-runtime/workspace.js";
import { createTempDir, initGitRepo, cleanupTempDir } from "./helpers/cli.js";

describe("git subprocess interactive prompt suppression", () => {
  // AC: @dispatch-remote-branch-sync ac-push-non-fatal
  describe("buildDispatchGitEnv", () => {
    it("sets GIT_TERMINAL_PROMPT=0 to prevent credential prompts", () => {
      const env = buildDispatchGitEnv({ HOME: "/test" });
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("preserves existing env vars while adding prompt suppression", () => {
      const env = buildDispatchGitEnv({ HOME: "/test", PATH: "/usr/bin" });
      expect(env.HOME).toBe("/test");
      expect(env.PATH).toBe("/usr/bin");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("overrides any inherited GIT_TERMINAL_PROMPT value", () => {
      const env = buildDispatchGitEnv({ GIT_TERMINAL_PROMPT: "1" });
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("strips worktree-contaminating env vars alongside prompt suppression", () => {
      const env = buildDispatchGitEnv({
        GIT_DIR: "/some/git/dir",
        GIT_WORK_TREE: "/some/work/tree",
        HOME: "/test",
      });
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_WORK_TREE).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.HOME).toBe("/test");
    });
  });

  // AC: @dispatch-remote-branch-sync ac-push-non-fatal
  // AC: @dispatch-remote-branch-sync ac-transient-no-degrade
  describe("shadow git operations inherit prompt suppression", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempDir("kspec-git-prompt-test-");
      initGitRepo(tempDir);
      execSync('git commit --allow-empty -m "init"', {
        cwd: tempDir,
        stdio: "pipe",
      });
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("git fetch to unreachable HTTPS remote fails fast instead of prompting", async () => {
      // Add a remote that requires auth but has no credential helper.
      // With GIT_TERMINAL_PROMPT=0, git should fail immediately rather than
      // prompting for credentials.
      execSync("git remote add origin https://github.com/nonexistent-org-12345/nonexistent-repo-67890.git", {
        cwd: tempDir,
        stdio: "pipe",
      });

      // Use the same env that dispatch/shadow operations use
      const env = buildDispatchGitEnv();
      const result = spawnSync("git", ["fetch", "origin"], {
        cwd: tempDir,
        env,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      });

      // Should fail (non-zero exit), NOT hang waiting for input
      expect(result.status).not.toBe(0);
      // Should complete within the timeout (if it hung, spawnSync would throw)
      expect(result.error).toBeUndefined();
    });

    it("git push to unreachable HTTPS remote fails fast instead of prompting", async () => {
      execSync("git remote add origin https://github.com/nonexistent-org-12345/nonexistent-repo-67890.git", {
        cwd: tempDir,
        stdio: "pipe",
      });

      const env = buildDispatchGitEnv();
      const result = spawnSync("git", ["push", "origin", "main"], {
        cwd: tempDir,
        env,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      });

      expect(result.status).not.toBe(0);
      expect(result.error).toBeUndefined();
    });

    it("git ls-remote to unreachable HTTPS remote fails fast instead of prompting", async () => {
      const env = buildDispatchGitEnv();
      const result = spawnSync(
        "git",
        ["ls-remote", "--heads", "https://github.com/nonexistent-org-12345/nonexistent-repo-67890.git"],
        {
          cwd: tempDir,
          env,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 10_000,
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.error).toBeUndefined();
    });
  });

  // AC: @trait-error-guidance ac-1 — N/A: this fix prevents hangs, not user-facing error messages
  // AC: @trait-error-guidance ac-2 — N/A: this fix prevents hangs, not user-facing error messages
  // AC: @trait-error-guidance ac-3 — N/A: this fix is about git subprocess env, not ref lookups
  // AC: @trait-error-guidance ac-4 — N/A: this fix is about git subprocess env, not state transitions
  // AC: @trait-error-guidance ac-5 — N/A: this fix is about git subprocess env, not validation errors
  // AC: @trait-error-guidance ac-6 — N/A: this fix is about git subprocess env, not JSON mode
});
