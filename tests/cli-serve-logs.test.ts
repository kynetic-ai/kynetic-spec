/**
 * E2E tests for kspec serve logs (tail + follow) and the serve status
 * log file location line.
 *
 * Spec: @cli-serve-commands ac-8, ac-9
 * Spec: @daemon-log-capture ac-log-location-discoverable
 *
 * These tests fabricate a daemon log file inside the isolated test HOME
 * (`<tempDir>/.test-home/.config/kspec/daemon.log` — the kspec() helper
 * points HOME there) instead of starting a real daemon: the command under
 * test reads the persisted log file and must work whether or not a daemon
 * is currently running.
 */

import { describe, it, expect, beforeEach, afterEach, onTestFinished } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createTempDir,
  cleanupTempDir,
  buildTestSubprocessEnv,
  kspec,
  kspecJson,
  waitForStartup,
  CLI_PATH,
} from "./helpers/cli";
import { stopChildProcessBounded } from "./helpers/process-stop.js";

function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `line-${String(i + 1).padStart(3, "0")}`);
}

describe("kspec serve logs", () => {
  let tempDir: string;
  let testHome: string;
  let logPath: string;

  function writeLogLines(lines: string[]): void {
    writeFileSync(logPath, `${lines.join("\n")}\n`, "utf-8");
  }

  beforeEach(async () => {
    tempDir = await createTempDir();
    // The kspec() helper isolates HOME to <cwd>/.test-home, so the global
    // daemon state directory the CLI resolves is under this path.
    testHome = join(tempDir, ".test-home");
    logPath = join(testHome, ".config", "kspec", "daemon.log");
    mkdirSync(join(testHome, ".config", "kspec"), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cli-serve-commands ac-8
  // AC: @trait-semantic-exit-codes ac-1
  it("tails the last 50 lines of the daemon log by default", () => {
    writeLogLines(numberedLines(100));

    const result = kspec("serve logs", tempDir);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("line-051");
    expect(lines[49]).toBe("line-100");
    expect(result.stdout).not.toContain("line-050");
  });

  // AC: @cli-serve-commands ac-8
  it("respects --lines to override the tail length", () => {
    writeLogLines(numberedLines(100));

    const result = kspec("serve logs --lines 10", tempDir);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("line-091");
    expect(lines[9]).toBe("line-100");
  });

  // AC: @cli-serve-commands ac-8
  it("prints the whole file when --lines exceeds the file length", () => {
    writeLogLines(numberedLines(7));

    const result = kspec("serve logs --lines 500", tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n")).toHaveLength(7);
    expect(result.stdout).toContain("line-001");
  });

  // AC: @cli-serve-commands ac-8
  // AC: @trait-semantic-exit-codes ac-5
  it("exits 0 with empty output when the log file exists but is empty", () => {
    writeFileSync(logPath, "", "utf-8");

    const result = kspec("serve logs", tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  // AC: @cli-serve-commands ac-8
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("prints an actionable error when no log file exists yet", () => {
    const result = kspec("serve logs", tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain(`No daemon log file found at ${logPath}`);
    expect(result.stderr).toContain("kspec serve start --detach");
  });

  // AC: @cli-serve-commands ac-8
  // AC: @trait-json-output ac-1
  // AC: @trait-json-output ac-2
  it("outputs the tail as structured JSON with --json", () => {
    writeLogLines(numberedLines(100));

    const result = kspec("serve logs --json --lines 5", tempDir);

    expect(result.exitCode).toBe(0);
    // Valid JSON, no ANSI codes
    expect(result.stdout).not.toContain("\u001b");
    const parsed = JSON.parse(result.stdout) as { log_path: string; lines: string[] };
    // JSON mode carries all data available in human mode: the tail lines
    // plus the resolved log path.
    expect(parsed.log_path).toBe(logPath);
    expect(parsed.lines).toHaveLength(5);
    expect(parsed.lines[0]).toBe("line-096");
    expect(parsed.lines[4]).toBe("line-100");
  });

  // AC: @trait-json-output ac-3
  // AC: @trait-error-guidance ac-6
  it("returns a structured JSON error object when the log file is missing in --json mode", () => {
    const result = kspec("serve logs --json", tempDir, { expectFail: true });

    expect(result.exitCode).toBe(3);
    const parsed = JSON.parse(result.stdout) as { error: string; suggestion: string };
    expect(parsed.error).toContain("No daemon log file found");
    expect(parsed.suggestion).toContain("kspec serve start --detach");
  });

  // AC: @cli-serve-commands ac-8
  // AC: @trait-error-guidance ac-5
  it("rejects an invalid --lines value with a validation error naming the flag", () => {
    writeLogLines(numberedLines(10));

    for (const bad of ["abc", "0", "-5", "2.5"]) {
      const result = kspec(`serve logs --lines ${bad}`, tempDir, { expectFail: true });
      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain("Invalid --lines value");
    }
  });

  // AC: @cli-serve-commands ac-9
  it("rejects --json combined with --follow instead of silently dropping a flag", () => {
    writeLogLines(numberedLines(10));

    const result = kspec("serve logs --follow --json", tempDir, { expectFail: true });

    expect(result.exitCode).toBe(4);
    const parsed = JSON.parse(result.stdout) as { error: string; suggestion: string };
    expect(parsed.error).toContain("--json is not supported with --follow");
    expect(parsed.suggestion).toBeTruthy();
  });

  // AC: @cli-serve-commands ac-9
  // Behavioral follow-mode test: spawn the real CLI, append to the log
  // file from the test, and assert appended lines stream to stdout. Also
  // exercises rotation continuity (active file renamed to <log>.1 and
  // replaced, mirroring DaemonLogWriter's rotate-before-append) and the
  // Ctrl+C (SIGINT) exit path. Uses the 500ms polling loop, not inotify,
  // so this is deterministic in CI.
  it("streams appended lines with --follow, survives rotation, and stops on Ctrl+C", async () => {
    writeLogLines(["initial-line-1", "initial-line-2"]);

    const child: ChildProcess = spawn("node", [CLI_PATH, "serve", "logs", "--follow"], {
      cwd: tempDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...buildTestSubprocessEnv({}),
        HOME: testHome,
        USERPROFILE: testHome,
      },
    });

    // Register bounded cleanup at spawn time so the follower never outlives
    // the test on assertion failure.
    onTestFinished(async () => {
      await stopChildProcessBounded(child, { gracefulMs: 2_000, label: "serve logs --follow" });
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const observed = (marker: string) => async () => ({
      ok: stdout.includes(marker),
      details: `exit=${child.exitCode} stdout=${stdout.slice(-200)} stderr=${stderr.slice(-200)}`,
    });

    // Initial tail is printed before streaming begins.
    await waitForStartup("follow initial tail", observed("initial-line-2"), {
      timeoutMs: 10_000,
      intervalMs: 100,
    });

    // Appended lines stream out on subsequent poll ticks.
    appendFileSync(logPath, "appended-marker-1\n", "utf-8");
    await waitForStartup("follow appended line", observed("appended-marker-1"), {
      timeoutMs: 10_000,
      intervalMs: 100,
    });

    // Rotation: the active file is renamed to <log>.1 and a fresh active
    // file replaces it. The follower must continue from the new file.
    renameSync(logPath, `${logPath}.1`);
    writeFileSync(logPath, "post-rotation-marker\n", "utf-8");
    await waitForStartup("follow post-rotation line", observed("post-rotation-marker"), {
      timeoutMs: 10_000,
      intervalMs: 100,
    });

    // Ctrl+C stops the stream with a successful exit.
    child.kill("SIGINT");
    await waitForStartup(
      "follow child exit after SIGINT",
      async () => ({
        ok: child.exitCode !== null || child.signalCode !== null,
        details: `exitCode=${child.exitCode} signalCode=${child.signalCode}`,
      }),
      { timeoutMs: 10_000, intervalMs: 50 },
    );

    // Graceful path: the SIGINT handler runs process.exit(0). Accept the
    // signal-kill outcome too — node may die from SIGINT before the
    // handler is dispatched, same as the foreground-serve Ctrl+C test.
    const exitedCleanly = child.exitCode === 0;
    const killedBySignal = child.exitCode === null && child.signalCode === "SIGINT";
    // oxlint-disable-next-line jest/valid-expect -- vitest supports custom message as 2nd arg
    expect(
      exitedCleanly || killedBySignal,
      `expected clean exit (0) or SIGINT kill, got exitCode=${child.exitCode} signalCode=${child.signalCode}`,
    ).toBe(true);
  });
});

describe("kspec serve status log file location", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    const configDir = join(tempDir, ".test-home", ".config", "kspec");
    logPath = join(configDir, "daemon.log");
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-log-capture ac-log-location-discoverable
  it("reports the log file path in human-readable status when the log exists", () => {
    writeFileSync(logPath, "some daemon output\n", "utf-8");

    const result = kspec("serve status", tempDir);

    expect(result.stdout).toContain(`Log file: ${logPath}`);
  });

  // AC: @daemon-log-capture ac-log-location-discoverable
  it("reports the log file path in JSON status output", () => {
    const status = kspecJson<{ log_path: string }>("serve status --json", tempDir);

    expect(status.log_path).toBe(logPath);
  });
});
