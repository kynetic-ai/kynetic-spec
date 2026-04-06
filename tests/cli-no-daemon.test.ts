import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PidFileManager } from "../src/cli/pid-utils";
import { buildDaemonChildEnv } from "../src/cli/commands/serve";
import {
  CLI_PATH,
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  initGitRepo,
  kspec,
  readTestOutputSync,
  waitForStartup,
} from "./helpers/cli";

let bunAvailable = false;
try {
  execSync("which bun", { stdio: "pipe" });
  bunAvailable = true;
} catch {
  // Bun-specific runtime tests skip when Bun is unavailable.
}

describe("KSPEC_NO_DAEMON", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    initGitRepo(tempDir);
    mkdirSync(join(tempDir, ".kspec"), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @multi-directory-daemon ac-32
  it("suppresses incidental daemon detection when KSPEC_NO_DAEMON is truthy", () => {
    const pidManager = new PidFileManager(join(tempDir, ".daemon-config"));
    pidManager.writePid();

    process.env.KSPEC_NO_DAEMON = "1";

    expect(pidManager.isDaemonRunning()).toBe(false);
    expect(pidManager.isDaemonRunning({ ignoreNoDaemon: true })).toBe(true);
  });

  // AC: @multi-directory-daemon ac-33
  it("allows explicit serve status to ignore KSPEC_NO_DAEMON", async () => {
    const isolatedHome = await createIsolatedKspecHome(tempDir);
    writeFileSync(isolatedHome.daemonPidFilePath, `${process.pid}\n`, "utf-8");

    const result = kspec(`serve status --json --kspec-dir ${join(tempDir, ".kspec")}`, tempDir, {
      env: isolatedHome.env,
    });
    const status = JSON.parse(result.stdout) as {
      running: boolean;
      pid: number | null;
      port: number | null;
    };

    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBeNull();
  });

  // AC: @multi-directory-daemon ac-33
  it("strips KSPEC_NO_DAEMON from explicit daemon child processes", () => {
    const childEnv = buildDaemonChildEnv("bun", {
      ...process.env,
      KSPEC_NO_DAEMON: "1",
      KSPEC_CUSTOM_FLAG: "preserved",
    });

    expect(childEnv.KSPEC_NO_DAEMON).toBeUndefined();
    expect(childEnv.KSPEC_CUSTOM_FLAG).toBe("preserved");
    expect(childEnv.BUN_ENV).toBe("production");
  });

  it("sets NODE_ENV for node runtime child processes", () => {
    const childEnv = buildDaemonChildEnv("node", {
      ...process.env,
      KSPEC_NO_DAEMON: "1",
      KSPEC_CUSTOM_FLAG: "preserved",
    });

    expect(childEnv.KSPEC_NO_DAEMON).toBeUndefined();
    expect(childEnv.KSPEC_CUSTOM_FLAG).toBe("preserved");
    expect(childEnv.NODE_ENV).toBe("production");
    expect(childEnv.BUN_ENV).toBeUndefined();
  });

  // AC: @daemon-runtime-adapter ac-auto-start-runtime
  it("auto-starts the daemon with the configured node runtime even when the CLI runs under bun", async () => {
    if (!bunAvailable) {
      console.log("  ⊘ Skipping test - Bun runtime required");
      return;
    }

    const isolatedHome = await createIsolatedKspecHome(tempDir);
    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      ["daemon:", "  runtime: node", ""].join("\n"),
      "utf-8",
    );
    const {
      KSPEC_NO_DAEMON: _kspecNoDaemon,
      KSPEC_SESSION_ID: _sessionId,
      KSPEC_RALPH_SESSION: _legacySession,
      KSPEC_DISPATCH_CANONICAL_HEAD: _dispatchCanonicalHead,
      KSPEC_SHADOW_MUTATION_LOCK_FILE: _shadowMutationLockFile,
      KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS: _shadowMutationLockTimeoutMs,
      ...cleanEnv
    } = process.env;

    const result = spawnSync(
      "bun",
      [CLI_PATH, "util", "ulid"],
      {
        cwd: tempDir,
        encoding: "utf-8",
        env: { ...cleanEnv, ...isolatedHome.env, KSPEC_AUTHOR: "@test" },
      },
    );

    expect(result.status).toBe(0);

    await waitForStartup(
      "auto-started daemon pid file",
      async () => {
        try {
          const pid = parseInt(readTestOutputSync(isolatedHome.daemonPidFilePath).trim(), 10);
          return {
            ok: Number.isInteger(pid) && pid > 0,
            details: `pid=${Number.isFinite(pid) ? pid : "invalid"}`,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, details: message };
        }
      },
      { timeoutMs: 10_000 },
    );

    const pid = parseInt(readTestOutputSync(isolatedHome.daemonPidFilePath).trim(), 10);
    const processCommand = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();

    expect(processCommand).toContain("node");
    expect(processCommand).toContain("dist/daemon/index.js");

    kspec(`serve stop --kspec-dir ${join(tempDir, ".kspec")}`, tempDir, {
      env: isolatedHome.env,
    });
  });
  // AC: @config-daemon ac-8
  describe("explicit daemon lifecycle commands", () => {
    it("does not auto-start the daemon for serve status", async () => {
      const isolatedHome = await createIsolatedKspecHome(tempDir);
      writeFileSync(
        join(tempDir, "kspec.config.yaml"),
        ["daemon:", "  auto_start: true", "  runtime: node", ""].join("\n"),
        "utf-8",
      );

      const result = kspec(`serve status --json --kspec-dir ${join(tempDir, ".kspec")}`, tempDir, {
        env: { ...isolatedHome.env, KSPEC_NO_DAEMON: "" },
      });
      const status = JSON.parse(result.stdout) as {
        running: boolean;
        pid: number | null;
        port: number | null;
      };

      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
      expect(status.port).toBeNull();
      expect(existsSync(isolatedHome.daemonPidFilePath)).toBe(false);
    });
  });
});
