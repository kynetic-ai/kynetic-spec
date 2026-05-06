import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
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

    const result = spawnSync("bun", [CLI_PATH, "util", "ulid"], {
      cwd: tempDir,
      encoding: "utf-8",
      env: { ...cleanEnv, ...isolatedHome.env, KSPEC_AUTHOR: "@test" },
    });

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
  // AC: @daemon-network-endpoint-contract ac-configured-bind-host
  // AC: @config-daemon ac-connect-host-config
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // AC: @daemon-network-endpoint-contract ac-connection-metadata
  it("forwards host, host-explicit, and connect-host to the auto-started daemon", async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") {
          probe.close(() => reject(new Error("Failed to allocate ephemeral port")));
          return;
        }
        const allocatedPort = address.port;
        probe.close((err) => (err ? reject(err) : resolve(allocatedPort)));
      });
    });

    const isolatedHome = await createIsolatedKspecHome(tempDir);
    // bind_host=0.0.0.0 (wildcard) with connect_host=127.0.0.2 is the
    // configuration the resolver allows: a wildcard listener accepts
    // connections at any local interface, including the 127.0.0.0/8
    // loopback alias, so the advertised URL is reachable. A specific
    // bind_host (e.g. 127.0.0.1) paired with a different connect_host
    // is rejected at resolve time because the URL would be unreachable.
    writeFileSync(
      join(tempDir, "kspec.config.yaml"),
      [
        "daemon:",
        "  runtime: node",
        `  port: ${port}`,
        "  host: 0.0.0.0",
        "  connect_host: 127.0.0.2",
        "  auto_start: true",
        "",
      ].join("\n"),
      "utf-8",
    );

    const {
      KSPEC_NO_DAEMON: _kspecNoDaemon,
      KSPEC_SESSION_ID: _sessionId,
      KSPEC_RALPH_SESSION: _legacySession,
      KSPEC_DISPATCH_CANONICAL_HEAD: _dispatchCanonicalHead,
      KSPEC_SHADOW_MUTATION_LOCK_FILE: _shadowMutationLockFile,
      KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS: _shadowMutationLockTimeoutMs,
      KSPEC_DAEMON_HOST: _daemonHost,
      KSPEC_DAEMON_CONNECT_HOST: _daemonConnectHost,
      KSPEC_DAEMON_PORT: _daemonPort,
      ...cleanEnv
    } = process.env;

    const result = spawnSync("node", [CLI_PATH, "util", "ulid"], {
      cwd: tempDir,
      encoding: "utf-8",
      env: { ...cleanEnv, ...isolatedHome.env, KSPEC_AUTHOR: "@test" },
    });

    expect(result.status).toBe(0);

    // Wait for the auto-started daemon to write its PID file, then register
    // SIGTERM cleanup before any assertion that could throw — keeps the
    // detached daemon from leaking on assertion failure.
    await waitForStartup(
      "auto-started daemon pid file",
      async () => {
        try {
          const pid = parseInt(readTestOutputSync(isolatedHome.daemonPidFilePath).trim(), 10);
          return {
            ok: Number.isInteger(pid) && pid > 0,
            details: `pid=${Number.isFinite(pid) ? pid : "invalid"}`,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, details: message };
        }
      },
      { timeoutMs: 10_000 },
    );
    const pid = parseInt(readTestOutputSync(isolatedHome.daemonPidFilePath).trim(), 10);
    onTestFinished(() => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone — fine.
      }
    });

    // Wait for the auto-started daemon to write connection metadata.
    const metadataPath = join(isolatedHome.configDir, "daemon.connection.json");
    await waitForStartup(
      "auto-started daemon connection metadata",
      async () => {
        try {
          const raw = readTestOutputSync(metadataPath);
          const parsed = JSON.parse(raw) as { connect_host?: string };
          return {
            ok: typeof parsed.connect_host === "string",
            details: `metadata=${raw.slice(0, 200)}`,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, details: message };
        }
      },
      { timeoutMs: 10_000 },
    );

    const metadata = JSON.parse(readTestOutputSync(metadataPath)) as {
      port: number;
      bind_host: string;
      connect_host: string;
      api_url: string;
      ws_url: string;
    };
    expect(metadata.port).toBe(port);
    expect(metadata.bind_host).toBe("0.0.0.0");
    expect(metadata.connect_host).toBe("127.0.0.2");
    expect(metadata.api_url).toBe(`http://127.0.0.2:${port}`);
    expect(metadata.ws_url).toBe(`ws://127.0.0.2:${port}/ws`);

    // ps output also documents the forwarded flags so a regression that
    // strips one of them shows up in either layer of the assertion.
    const processCommand = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();
    expect(processCommand).toContain("--host 0.0.0.0");
    expect(processCommand).toContain("--host-explicit");
    expect(processCommand).toContain("--connect-host 127.0.0.2");

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
