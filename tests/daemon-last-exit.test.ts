/**
 * Tests for daemon termination reason recording and surfacing.
 *
 * AC Coverage:
 * - @daemon-failure-observability ac-fatal-error-recorded: uncaught errors
 *   and unhandled rejections are durably recorded (message, stack,
 *   timestamp) before the process exits non-zero
 * - @daemon-failure-observability ac-exit-record-durable: the most recent
 *   termination (kind, reason, timestamp) is retrievable without a running
 *   daemon; malformed/missing records are tolerated
 * - @daemon-failure-observability ac-status-surfaces-last-exit: serve
 *   status reports the last termination when no daemon is running
 * - @daemon-failure-observability ac-graceful-exit-recorded: SIGTERM
 *   shutdown leaves a graceful record
 *
 * The fatal-handler tests spawn a short-lived node child that imports the
 * real production module (dist/daemon/fatal-handlers.js) with an isolated
 * HOME, then triggers the failure — exercising handler registration, the
 * record write, and the exit code end-to-end.
 */

import { describe, expect, it, onTestFinished } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import {
  buildTestSubprocessEnv,
  cleanupTempDir,
  createTempDir,
  kspec,
  kspecJson,
} from "./helpers/cli.js";
import { createTestDaemonProject, startTestDaemon } from "./helpers/daemon.js";
import {
  getDaemonLastExitPath,
  readDaemonLastExitRecord,
  writeDaemonLastExitRecord,
  type DaemonLastExitRecord,
} from "../src/daemon-shared/endpoint.js";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const FATAL_HANDLERS_URL = new URL("../dist/daemon/fatal-handlers.js", import.meta.url).href;

describe("last-exit record helpers", () => {
  // AC: @daemon-failure-observability ac-exit-record-durable
  it("round-trips a record with kind, reason, stack, timestamp, and pid", async () => {
    const configDir = await createTempDir("kspec-last-exit-");
    onTestFinished(() => cleanupTempDir(configDir));

    const written = writeDaemonLastExitRecord(
      { kind: "fatal", reason: "uncaughtException: boom", stack: "Error: boom\n    at x" },
      configDir,
    );
    expect(written).not.toBeNull();

    const record = readDaemonLastExitRecord(configDir);
    expect(record).toEqual({
      kind: "fatal",
      reason: "uncaughtException: boom",
      stack: "Error: boom\n    at x",
      timestamp: written!.timestamp,
      pid: process.pid,
    });
    expect(record!.timestamp).toMatch(ISO_TIMESTAMP);
  });

  // AC: @daemon-failure-observability ac-exit-record-durable — only the
  // most recent termination matters; each write overwrites the prior one.
  it("overwrites the previous record on each termination", async () => {
    const configDir = await createTempDir("kspec-last-exit-");
    onTestFinished(() => cleanupTempDir(configDir));

    writeDaemonLastExitRecord({ kind: "graceful", reason: "Received SIGTERM" }, configDir);
    writeDaemonLastExitRecord({ kind: "startup_failure", reason: "port in use" }, configDir);

    const record = readDaemonLastExitRecord(configDir);
    expect(record?.kind).toBe("startup_failure");
    expect(record?.reason).toBe("port in use");
    expect(record?.stack).toBeUndefined();
  });

  // AC: @daemon-failure-observability ac-exit-record-durable
  it("returns null when no record exists", async () => {
    const configDir = await createTempDir("kspec-last-exit-");
    onTestFinished(() => cleanupTempDir(configDir));

    expect(readDaemonLastExitRecord(configDir)).toBeNull();
  });

  // AC: @daemon-failure-observability ac-exit-record-durable — a malformed
  // file must never break the status surface that reports it.
  it("tolerates malformed and invalid-shape record files", async () => {
    const configDir = await createTempDir("kspec-last-exit-");
    onTestFinished(() => cleanupTempDir(configDir));

    writeFileSync(getDaemonLastExitPath(configDir), "{not json", "utf-8");
    expect(readDaemonLastExitRecord(configDir)).toBeNull();

    writeFileSync(
      getDaemonLastExitPath(configDir),
      JSON.stringify({ kind: "weird", reason: 7 }),
      "utf-8",
    );
    expect(readDaemonLastExitRecord(configDir)).toBeNull();
  });

  it("never throws when the record path is unwritable", async () => {
    const configDir = await createTempDir("kspec-last-exit-");
    onTestFinished(() => cleanupTempDir(configDir));

    // Make the config dir path a regular file so mkdir/write fail.
    const blockedDir = path.join(configDir, "blocked");
    writeFileSync(blockedDir, "not a directory", "utf-8");

    expect(() =>
      writeDaemonLastExitRecord({ kind: "graceful", reason: "Received SIGTERM" }, blockedDir),
    ).not.toThrow();
    expect(
      writeDaemonLastExitRecord({ kind: "graceful", reason: "Received SIGTERM" }, blockedDir),
    ).toBeNull();
  });
});

/**
 * Spawn a node child that imports the production fatal-handlers module
 * under an isolated HOME and runs `body`. Resolves with the exit code and
 * captured stderr once the child exits.
 */
function runWithFatalHandlers(
  body: string,
  homeDir: string,
): Promise<{ code: number | null; stderr: string }> {
  const script = [
    `const m = await import(${JSON.stringify(FATAL_HANDLERS_URL)});`,
    "m.installDaemonFatalHandlers();",
    body,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: buildTestSubprocessEnv({ HOME: homeDir, USERPROFILE: homeDir }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

describe("daemon fatal handlers", () => {
  // AC: @daemon-failure-observability ac-fatal-error-recorded
  it("records an uncaught exception with message, stack, and timestamp, then exits non-zero", async () => {
    const homeDir = await createTempDir("kspec-fatal-home-");
    onTestFinished(() => cleanupTempDir(homeDir));

    const { code, stderr } = await runWithFatalHandlers(
      'setTimeout(() => { throw new Error("boom-uncaught"); }, 10);',
      homeDir,
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Fatal uncaughtException");
    expect(stderr).toContain("boom-uncaught");

    const record = readDaemonLastExitRecord(path.join(homeDir, ".config", "kspec"));
    expect(record).not.toBeNull();
    expect(record!.kind).toBe("fatal");
    expect(record!.reason).toBe("uncaughtException: boom-uncaught");
    expect(record!.stack).toContain("boom-uncaught");
    expect(record!.timestamp).toMatch(ISO_TIMESTAMP);
    expect(record!.pid).toBeGreaterThan(0);
  });

  // AC: @daemon-failure-observability ac-fatal-error-recorded — unhandled
  // rejections are captured too, including non-Error rejection reasons.
  it("records an unhandled rejection and exits non-zero", async () => {
    const homeDir = await createTempDir("kspec-fatal-home-");
    onTestFinished(() => cleanupTempDir(homeDir));

    const { code, stderr } = await runWithFatalHandlers(
      'Promise.reject("boom-rejected-string");',
      homeDir,
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Fatal unhandledRejection");

    const record = readDaemonLastExitRecord(path.join(homeDir, ".config", "kspec"));
    expect(record).not.toBeNull();
    expect(record!.kind).toBe("fatal");
    expect(record!.reason).toBe("unhandledRejection: boom-rejected-string");
    expect(record!.timestamp).toMatch(ISO_TIMESTAMP);
  });
});

/**
 * Wait for an already-signaled daemon child to exit, bounded so a graceful
 * shutdown stall fails with the daemon's output tails instead of an opaque
 * test timeout. Register before sending the signal so the exit event cannot
 * be missed. The budget is far above a healthy shutdown (<1s) — it exists
 * only to convert a hang into an actionable failure, not to race it.
 */
function waitForChildExitBounded(
  started: Awaited<ReturnType<typeof startTestDaemon>>,
  budgetMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (started.child.exitCode !== null || started.child.signalCode !== null) {
      resolve(started.child.exitCode);
      return;
    }
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      started.child.off("exit", onExit);
      reject(
        new Error(
          [
            `daemon child (pid=${started.pid ?? "<none>"}) did not exit within ${budgetMs}ms of SIGTERM`,
            `stdout-tail:\n${started.stdoutTail() || "<empty>"}`,
            `stderr-tail:\n${started.stderrTail() || "<empty>"}`,
          ].join("\n"),
        ),
      );
    }, budgetMs);
    started.child.once("exit", onExit);
  });
}

describe("daemon termination paths", () => {
  // AC: @daemon-failure-observability ac-graceful-exit-recorded
  it("records a graceful exit when the daemon shuts down on SIGTERM", async () => {
    const project = await createTestDaemonProject({ skipFixtures: true });
    onTestFinished(async () => {
      await project.cleanup();
    });

    // Health alone is not enough: /api/health goes live at listen time,
    // BEFORE createServer registers its SIGTERM handler at the end of
    // startup. Wait for the startup-complete marker (logged after
    // createServer resolves) so the SIGTERM below hits the graceful
    // shutdown path instead of the default signal disposition.
    const started = await startTestDaemon(project, {
      readiness: {
        mode: "custom",
        probe: (ctx) =>
          ctx.stdoutTail().includes("[daemon] Startup complete")
            ? { ok: true, details: "startup complete" }
            : { ok: false, details: "waiting for startup-complete marker" },
      },
      registerCleanup: (stop) => {
        onTestFinished(async () => {
          await stop();
        });
      },
    });

    const exited = waitForChildExitBounded(started, 20_000);
    started.child.kill("SIGTERM");
    const code = await exited;
    expect(code).toBe(0);

    // AC: @daemon-failure-observability ac-exit-record-durable — the record
    // is retrievable after the process is gone.
    const record = readDaemonLastExitRecord(project.isolatedHome.configDir);
    expect(record).not.toBeNull();
    expect(record!.kind).toBe("graceful");
    expect(record!.reason).toBe("Received SIGTERM");
    expect(record!.timestamp).toMatch(ISO_TIMESTAMP);
    expect(record!.pid).toBe(started.pid);
  });

  // AC: @daemon-failure-observability ac-exit-record-durable — a daemon
  // that never came up (bind failure) leaves a startup_failure record.
  it("records a startup failure when the daemon cannot bind its port", async () => {
    // Occupy a port so the daemon's bind fails with EADDRINUSE.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => resolve());
        }),
    );
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const project = await createTestDaemonProject({ skipFixtures: true });
    onTestFinished(async () => {
      await project.cleanup();
    });

    // Custom readiness probe: wait for the daemon child to exit on its
    // own — the default health probe would hang against the blocker port.
    const started = await startTestDaemon(project, {
      port,
      readiness: {
        mode: "custom",
        probe: (ctx) => {
          if (ctx.child.exitCode !== null || ctx.child.signalCode) {
            return { ok: true, details: `child exited code=${ctx.child.exitCode ?? "<signal>"}` };
          }
          return { ok: false, details: "child still running" };
        },
      },
      timeoutMs: 10_000,
      intervalMs: 50,
      registerCleanup: (stop) => {
        onTestFinished(async () => {
          await stop();
        });
      },
    });

    expect(started.child.exitCode).not.toBe(null);
    expect(started.child.exitCode).not.toBe(0);

    const record = readDaemonLastExitRecord(project.isolatedHome.configDir);
    expect(record).not.toBeNull();
    expect(record!.kind).toBe("startup_failure");
    expect(record!.reason.length).toBeGreaterThan(0);
    expect(record!.timestamp).toMatch(ISO_TIMESTAMP);
  });
});

describe("serve status last-exit surface", () => {
  function writeRecordIntoTestHome(tempDir: string, record: DaemonLastExitRecord): string {
    // The kspec helper isolates HOME to <cwd>/.test-home, so the CLI reads
    // the record from the global config dir under that HOME.
    const configDir = path.join(tempDir, ".test-home", ".config", "kspec");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(getDaemonLastExitPath(configDir), JSON.stringify(record), "utf-8");
    return configDir;
  }

  // AC: @daemon-failure-observability ac-status-surfaces-last-exit
  it("reports the last termination kind, reason, and timestamp when no daemon is running", async () => {
    const tempDir = await createTempDir("kspec-status-last-exit-");
    onTestFinished(() => cleanupTempDir(tempDir));

    writeRecordIntoTestHome(tempDir, {
      kind: "fatal",
      reason: "uncaughtException: boom",
      stack: "Error: boom\n    at x",
      timestamp: "2026-06-11T00:00:00.000Z",
      pid: 12345,
    });

    const result = kspec("serve status", tempDir);
    expect(result.stdout).toContain("Daemon not running");
    expect(result.stdout).toContain("Last exit: fatal at 2026-06-11T00:00:00.000Z");
    expect(result.stdout).toContain("Reason: uncaughtException: boom");
  });

  // AC: @daemon-failure-observability ac-status-surfaces-last-exit — the
  // JSON output carries the same fields.
  it("includes the last_exit fields in --json output", async () => {
    const tempDir = await createTempDir("kspec-status-last-exit-");
    onTestFinished(() => cleanupTempDir(tempDir));

    writeRecordIntoTestHome(tempDir, {
      kind: "graceful",
      reason: "Received SIGTERM",
      timestamp: "2026-06-11T00:00:00.000Z",
      pid: 12345,
    });

    const status = kspecJson<{
      running: boolean;
      last_exit: DaemonLastExitRecord | null;
    }>("serve status --json", tempDir);

    expect(status.running).toBe(false);
    expect(status.last_exit).toEqual({
      kind: "graceful",
      reason: "Received SIGTERM",
      timestamp: "2026-06-11T00:00:00.000Z",
      pid: 12345,
    });
  });

  // AC: @daemon-failure-observability ac-graceful-exit-recorded — a
  // graceful record must not be reported as a failure.
  it("identifies a graceful shutdown as graceful in status output", async () => {
    const tempDir = await createTempDir("kspec-status-last-exit-");
    onTestFinished(() => cleanupTempDir(tempDir));

    writeRecordIntoTestHome(tempDir, {
      kind: "graceful",
      reason: "Received SIGTERM",
      timestamp: "2026-06-11T00:00:00.000Z",
      pid: 12345,
    });

    const result = kspec("serve status", tempDir);
    expect(result.stdout).toContain("Last exit: graceful at 2026-06-11T00:00:00.000Z");
    expect(result.stdout).not.toContain("fatal");
  });

  it("omits last-exit output when no record exists", async () => {
    const tempDir = await createTempDir("kspec-status-last-exit-");
    onTestFinished(() => cleanupTempDir(tempDir));

    const result = kspec("serve status", tempDir);
    expect(result.stdout).toContain("Daemon not running");
    expect(result.stdout).not.toContain("Last exit:");
  });

  it("reports a null last_exit in --json output when no record exists", async () => {
    const tempDir = await createTempDir("kspec-status-last-exit-");
    onTestFinished(() => cleanupTempDir(tempDir));

    const status = kspecJson<{ last_exit: DaemonLastExitRecord | null }>(
      "serve status --json",
      tempDir,
    );
    expect(status.last_exit).toBeNull();
  });
});
