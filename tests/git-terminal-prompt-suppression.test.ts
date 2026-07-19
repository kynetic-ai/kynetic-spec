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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
    let authServer: ChildProcessWithoutNullStreams | null;
    let authRemoteUrl: string;

    beforeEach(async () => {
      tempDir = await createTempDir("kspec-git-prompt-test-");
      initGitRepo(tempDir);
      execSync('git commit --allow-empty -m "init"', {
        cwd: tempDir,
        stdio: "pipe",
      });
      authServer = null;
      authRemoteUrl = await startAuthChallengeServer(tempDir, (server) => {
        authServer = server;
      });
    });

    afterEach(async () => {
      await stopAuthChallengeServer(authServer);
      await cleanupTempDir(tempDir);
    });

    it("git fetch to authenticated HTTP remote fails fast instead of prompting", async () => {
      execSync(`git remote add origin ${authRemoteUrl}`, {
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
      expect(result.stderr).toContain("terminal prompts disabled");
    });

    it("git push to authenticated HTTP remote fails fast instead of prompting", async () => {
      execSync(`git remote add origin ${authRemoteUrl}`, {
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
      expect(result.stderr).toContain("terminal prompts disabled");
    });

    it("git ls-remote to authenticated HTTP remote fails fast instead of prompting", async () => {
      const env = buildDispatchGitEnv();
      const result = spawnSync("git", ["ls-remote", "--heads", authRemoteUrl], {
        cwd: tempDir,
        env,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      });

      expect(result.status).not.toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.stderr).toContain("terminal prompts disabled");
    });
  });

  // AC: @trait-error-guidance ac-1 — N/A: this fix prevents hangs, not user-facing error messages
  // AC: @trait-error-guidance ac-2 — N/A: this fix prevents hangs, not user-facing error messages
  // AC: @trait-error-guidance ac-3 — N/A: this fix is about git subprocess env, not ref lookups
  // AC: @trait-error-guidance ac-4 — N/A: this fix is about git subprocess env, not state transitions
  // AC: @trait-error-guidance ac-5 — N/A: this fix is about git subprocess env, not validation errors
  // AC: @trait-error-guidance ac-6 — N/A: this fix is about git subprocess env, not JSON mode
});

async function startAuthChallengeServer(
  tempDir: string,
  captureServer: (server: ChildProcessWithoutNullStreams) => void,
): Promise<string> {
  const serverScript = join(tempDir, "auth-challenge-server.cjs");
  writeFileSync(
    serverScript,
    `
const http = require("node:http");

const server = http.createServer((_req, res) => {
  res.writeHead(401, { "WWW-Authenticate": "Basic realm=\\"kspec-test\\"" });
  res.end("auth required\\n");
});

server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
`,
  );

  const server = spawn(process.execPath, [serverScript], {
    cwd: tempDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  captureServer(server);

  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`auth challenge server did not start. stderr: ${stderr}`));
    }, 5_000);

    server.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split("\n")[0]?.trim();
      if (!line) return;
      clearTimeout(timeout);
      resolve(Number(line));
    });

    server.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    server.on("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`auth challenge server exited early: code=${code} signal=${signal}`));
    });
  });

  return `http://127.0.0.1:${port}/repo.git`;
}

async function stopAuthChallengeServer(
  server: ChildProcessWithoutNullStreams | null,
): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1_000);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.kill("SIGTERM");
  });
}
