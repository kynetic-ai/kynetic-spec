/**
 * `kspec serve status` surfaces the daemon's command_dispatch health.
 *
 * The command-timeout 504 response directs operators to `kspec serve
 * status`, so a wedged command dispatch must be visible there — in both
 * JSON and human output — with the stuck command name and held duration.
 *
 * Stands up the child-process mock daemon (tests/helpers/mock-daemon.ts)
 * with a configurable /api/health command_dispatch payload, writes
 * canonical connection metadata into an isolated kspec home, and runs the
 * real CLI via spawnSync.
 *
 * AC Coverage:
 * - @daemon-command-api ac-stuck-command-reported
 * AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  kspec,
  type IsolatedKspecHome,
} from "./helpers/cli.js";
import {
  startMockDaemon,
  writeMockDaemonMetadata,
  type MockDaemonClient,
} from "./helpers/mock-daemon.js";

describe("serve status command_dispatch surfacing", () => {
  let tempDir: string;
  let isolated: IsolatedKspecHome;
  let mock: MockDaemonClient | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-serve-status-dispatch-");
    isolated = await createIsolatedKspecHome(tempDir);
  });

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = undefined;
    }
    await cleanupTempDir(tempDir);
  });

  async function startMockWithHealth(
    healthCommandDispatch?: Record<string, unknown>,
  ): Promise<void> {
    const started = await startMockDaemon({
      asChildProcess: true,
      ...(healthCommandDispatch ? { healthCommandDispatch } : {}),
    });
    if (!started) {
      throw new Error("mock daemon failed to start on 127.0.0.1");
    }
    mock = started;
    writeMockDaemonMetadata({ home: isolated, client: started });
  }

  function runStatus(args: string): { exitCode: number; stdout: string; stderr: string } {
    return kspec(args, tempDir, {
      env: {
        ...isolated.env,
        // serve status must report daemon health even when proxying is
        // disabled; clear the kspec() helper's KSPEC_NO_DAEMON=1 default so
        // the run matches a real operator invocation.
        KSPEC_NO_DAEMON: "",
      },
    });
  }

  const DEGRADED = {
    status: "degraded",
    stuck_command: "task list",
    running_for_ms: 125_000,
    limit_ms: 120_000,
  };

  // AC: @daemon-command-api ac-stuck-command-reported
  it("surfaces a degraded command dispatch in serve status --json", async () => {
    await startMockWithHealth(DEGRADED);

    const result = runStatus("serve status --json");
    expect(result.exitCode).toBe(0);

    const status = JSON.parse(result.stdout) as {
      running: boolean;
      command_dispatch: {
        status: string;
        stuck_command: string;
        running_for_ms: number;
        limit_ms: number;
      } | null;
    };
    expect(status.running).toBe(true);
    expect(status.command_dispatch).toEqual(DEGRADED);
  });

  // AC: @daemon-command-api ac-stuck-command-reported
  it("surfaces a degraded command dispatch in human-readable output", async () => {
    await startMockWithHealth(DEGRADED);

    const result = runStatus("serve status");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Command dispatch: DEGRADED");
    expect(result.stdout).toContain("'task list'");
    expect(result.stdout).toContain("running for 2m 5s");
    expect(result.stdout).toContain("limit 2m 0s");
    expect(result.stdout).toContain("Restart the daemon");
  });

  // AC: @daemon-command-api ac-stuck-command-reported — stops reporting
  // degradation once the dispatch queue is healthy again.
  it("reports a healthy command dispatch as ok", async () => {
    await startMockWithHealth({ status: "ok" });

    const jsonResult = runStatus("serve status --json");
    expect(jsonResult.exitCode).toBe(0);
    const status = JSON.parse(jsonResult.stdout) as {
      command_dispatch: { status: string } | null;
    };
    expect(status.command_dispatch).toEqual({ status: "ok" });

    const humanResult = runStatus("serve status");
    expect(humanResult.exitCode).toBe(0);
    expect(humanResult.stdout).toContain("Command dispatch: ok");
    expect(humanResult.stdout).not.toContain("DEGRADED");
  });

  it("omits command dispatch health when the daemon does not report it", async () => {
    await startMockWithHealth();

    const jsonResult = runStatus("serve status --json");
    expect(jsonResult.exitCode).toBe(0);
    const status = JSON.parse(jsonResult.stdout) as {
      running: boolean;
      command_dispatch: unknown;
    };
    expect(status.running).toBe(true);
    expect(status.command_dispatch).toBeNull();

    const humanResult = runStatus("serve status");
    expect(humanResult.exitCode).toBe(0);
    expect(humanResult.stdout).not.toContain("Command dispatch:");
  });
});
