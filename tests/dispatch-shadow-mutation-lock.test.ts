import { spawn } from "node:child_process";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock } from "../src/parser/file-lock.js";
import {
  cleanupTempDir,
  CLI_PATH,
  setupTempFixtures,
} from "./helpers/cli.js";

function runKspecAsync(
  args: string,
  cwd: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", `node ${CLI_PATH} ${args}`], {
      cwd,
      env: { ...process.env, KSPEC_AUTHOR: "@test", ...env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Dispatch shadow mutation lock", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  it("serializes mutating commands without blocking read-only commands", async () => {
    // AC: @scoped-dispatch-shadow-serialization ac-1
    // AC: @scoped-dispatch-shadow-serialization ac-2
    tempDir = await setupTempFixtures();
    const lockFile = path.join(tempDir, "dispatch-shadow-mutation");
    const release = await acquireFileLock(lockFile);

    let mutationSettled = false;
    const mutation = runKspecAsync(
      'task note @test-task-pending "serialized note"',
      tempDir,
      { KSPEC_SHADOW_MUTATION_LOCK_FILE: lockFile },
    ).finally(() => {
      mutationSettled = true;
    });

    await sleep(100);

    const readResult = await runKspecAsync(
      "task get @test-task-pending",
      tempDir,
      { KSPEC_SHADOW_MUTATION_LOCK_FILE: lockFile },
    );

    expect(readResult.exitCode).toBe(0);
    expect(mutationSettled).toBe(false);

    await release();

    const mutationResult = await mutation;
    expect(mutationResult.exitCode).toBe(0);
  });

  it("reports mutation lock timeouts with explicit guidance", async () => {
    // AC: @trait-error-guidance ac-1
    // AC: @trait-error-guidance ac-2
    tempDir = await setupTempFixtures();
    const lockFile = path.join(tempDir, "dispatch-shadow-mutation");
    const release = await acquireFileLock(lockFile);

    const result = await runKspecAsync(
      'task note @test-task-pending "blocked note"',
      tempDir,
      {
        KSPEC_SHADOW_MUTATION_LOCK_FILE: lockFile,
        KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS: "50",
      },
    );

    await release();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dispatch shadow mutation lock unavailable");
    expect(result.stderr).toContain("Reason:");
    expect(result.stderr).toContain("Suggested action:");
  });
});
