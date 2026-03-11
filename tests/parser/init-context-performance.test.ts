import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
} from "../helpers/cli.js";

const cleanupDirs: string[] = [];

async function setupWorktreeProject(): Promise<{
  codeWorktreeDir: string;
}> {
  const mainDir = await createTempDir("kspec-init-context-main-");
  cleanupDirs.push(mainDir);
  initGitRepo(mainDir);
  execSync('git commit --allow-empty -m "init"', { cwd: mainDir, stdio: "pipe" });

  const shadowDir = path.join(mainDir, ".kspec");
  execSync(`git worktree add "${shadowDir}" -b kspec-meta`, {
    cwd: mainDir,
    stdio: "pipe",
  });

  await fs.mkdir(path.join(shadowDir, "modules"), { recursive: true });
  await fs.writeFile(
    path.join(shadowDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: InitContext Perf Test\n',
    "utf-8",
  );

  const worktreeBase = await createTempDir("kspec-init-context-code-base-");
  cleanupDirs.push(worktreeBase);
  const codeWorktreeDir = path.join(worktreeBase, "code-wt");
  execSync(`git worktree add "${codeWorktreeDir}" -b feature/init-context-perf`, {
    cwd: mainDir,
    stdio: "pipe",
  });

  return { codeWorktreeDir };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:child_process");

  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await cleanupTempDir(dir);
    }
  }
});

describe("initContext git root resolution", () => {
  // AC: @worktree-support ac-performance
  it("uses a single combined git rev-parse call when resolving worktree roots", async () => {
    const { codeWorktreeDir } = await setupWorktreeProject();
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const gitCalls: Array<{ command: string; args: string[] }> = [];

    vi.doMock("node:child_process", () => ({
      ...actualChildProcess,
      spawnSync: vi.fn((command: string, args?: readonly string[]) => {
        gitCalls.push({ command, args: [...(args ?? [])] });
        return actualChildProcess.spawnSync(command, args, {
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8",
          cwd: codeWorktreeDir,
        });
      }),
    }));

    const { initContext } = await import("../../src/parser/yaml.js");
    const ctx = await initContext(codeWorktreeDir);

    expect(ctx.rootDir).toBe(codeWorktreeDir);

    const revParseCalls = gitCalls.filter(
      (call) => call.command === "git" && call.args[0] === "rev-parse",
    );
    expect(revParseCalls).toEqual([
      {
        command: "git",
        args: ["rev-parse", "--show-toplevel", "--git-common-dir"],
      },
    ]);
  });
});
