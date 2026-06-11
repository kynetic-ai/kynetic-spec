/**
 * Tests for the daemon log file with size-based rotation.
 *
 * AC Coverage:
 * - @daemon-log-capture ac-detached-output-captured: console output is
 *   appended to the durable log file via the in-process tee
 * - @daemon-log-capture ac-foreground-tee: tee'd output still reaches the
 *   passthrough console (terminal) in addition to the file
 * - @daemon-log-capture ac-log-line-timestamps: each captured line carries
 *   a timestamp
 * - @daemon-log-capture ac-bounded-rotation: rotate-before-append, exactly
 *   one rotated generation, total retained size bounded
 * - @daemon-log-capture ac-log-location-discoverable: serve status reports
 *   the daemon log file location
 *
 * The tee/guard tests use dynamic imports to reproduce the daemon entry
 * point's module evaluation order: the logger tee installs BEFORE
 * routes/command.js evaluates, so the command-route console interceptors
 * capture the tee'd console functions as their originals.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, createTempDir, kspecJson, readTestOutputSync } from "./helpers/cli.js";
import type { DaemonLogWriter as DaemonLogWriterType } from "../dist/daemon/logger.js";

const TIMESTAMPED_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(log|warn|error)\] /;

type LoggerModule = typeof import("../dist/daemon/logger.js");

let logger: LoggerModule;

// Recorder standing in for the terminal. Must replace console BEFORE the
// tee installs so the tee binds it as its passthrough target — mirroring
// how the tee binds the real console in the daemon process.
const terminal: string[] = [];

beforeAll(async () => {
  console.log = (...args: unknown[]) => {
    terminal.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    terminal.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    terminal.push(args.map(String).join(" "));
  };

  logger = await import("../dist/daemon/logger.js");
});

async function freshWriter(maxSizeBytes?: number): Promise<{
  tempDir: string;
  logPath: string;
  rotatedPath: string;
  writer: DaemonLogWriterType;
}> {
  const tempDir = await createTempDir("kspec-daemon-log-");
  const logPath = path.join(tempDir, "state", "daemon.log");
  const writer = new logger.DaemonLogWriter({ logPath, maxSizeBytes });
  return { tempDir, logPath, rotatedPath: `${logPath}.1`, writer };
}

describe("DaemonLogWriter", () => {
  // AC: @daemon-log-capture ac-log-line-timestamps
  it("appends each captured line with a timestamp", async () => {
    const { tempDir, logPath, writer } = await freshWriter();

    writer.writeLine("log", "startup complete");
    writer.writeLine("warn", "something odd");
    writer.writeLine("error", "first line\nsecond line");

    const lines = readTestOutputSync(logPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).toMatch(TIMESTAMPED_LINE);
    }
    expect(lines[0]).toContain("startup complete");
    expect(lines[1]).toContain("something odd");
    expect(lines[2]).toContain("first line");
    expect(lines[3]).toContain("second line");

    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-log-capture ac-bounded-rotation
  it("rotates before the append that would cross the size limit", async () => {
    const maxSize = 200;
    const { tempDir, logPath, rotatedPath, writer } = await freshWriter(maxSize);

    // Fill the active file without crossing the limit.
    writer.writeLine("log", "first entry kept in the old generation");
    expect(existsSync(rotatedPath)).toBe(false);
    const sizeBefore = statSync(logPath).size;
    expect(sizeBefore).toBeLessThanOrEqual(maxSize);

    // This append would cross the limit — rotation must happen FIRST so the
    // new line begins a fresh active file.
    writer.writeLine("log", "x".repeat(maxSize - sizeBefore));

    expect(existsSync(rotatedPath)).toBe(true);
    expect(readTestOutputSync(rotatedPath, "utf8")).toContain(
      "first entry kept in the old generation",
    );
    const active = readTestOutputSync(logPath, "utf8");
    expect(active).not.toContain("first entry kept in the old generation");
    expect(active).toContain("x".repeat(50));

    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-log-capture ac-bounded-rotation
  it("retains exactly one rotated generation, replacing the previous one", async () => {
    const maxSize = 120;
    const { tempDir, logPath, rotatedPath, writer } = await freshWriter(maxSize);

    writer.writeLine("log", `generation-one content ${"a".repeat(60)}`);
    writer.writeLine("log", `generation-two content ${"b".repeat(60)}`); // rotates gen 1
    writer.writeLine("log", `generation-three content ${"c".repeat(60)}`); // rotates gen 2

    // Exactly one rotated generation: gen 2 replaced gen 1, no .2 file.
    expect(existsSync(`${logPath}.2`)).toBe(false);
    const rotated = readTestOutputSync(rotatedPath, "utf8");
    expect(rotated).toContain("generation-two content");
    expect(rotated).not.toContain("generation-one content");
    expect(readTestOutputSync(logPath, "utf8")).toContain("generation-three content");

    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-log-capture ac-bounded-rotation
  it("bounds total retained size at twice the limit plus one captured line", async () => {
    const maxSize = 256;
    const { tempDir, logPath, rotatedPath, writer } = await freshWriter(maxSize);

    const line = "payload ".repeat(8).trim();
    let maxEntryBytes = 0;
    for (let i = 0; i < 100; i++) {
      writer.writeLine("log", `${i} ${line}`);
      // Upper bound for a single written entry: timestamp + level + text + newline.
      maxEntryBytes = Math.max(maxEntryBytes, Buffer.byteLength(`${i} ${line}`) + 64);
      const total =
        statSync(logPath).size + (existsSync(rotatedPath) ? statSync(rotatedPath).size : 0);
      expect(total).toBeLessThanOrEqual(2 * maxSize + maxEntryBytes);
    }

    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-log-capture ac-bounded-rotation
  it("does not rotate while appends fit within the limit", async () => {
    const { tempDir, logPath, rotatedPath, writer } = await freshWriter(10_000);

    for (let i = 0; i < 20; i++) {
      writer.writeLine("log", `entry ${i}`);
    }

    expect(existsSync(rotatedPath)).toBe(false);
    const lines = readTestOutputSync(logPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(20);

    await cleanupTempDir(tempDir);
  });

  it("never throws when the log path is unwritable", async () => {
    const { tempDir, writer } = await freshWriter();
    // Make the parent of the log path a regular file so mkdir/append fail.
    const blocked = new logger.DaemonLogWriter({
      logPath: path.join(tempDir, "state", "daemon.log", "nested.log"),
    });
    writer.writeLine("log", "make the state dir a real path first");

    expect(() => blocked.writeLine("error", "must not throw")).not.toThrow();

    await cleanupTempDir(tempDir);
  });
});

describe("daemon console tee", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-tee-");
    logPath = path.join(tempDir, "daemon.log");
    // Swap the active writer to a fresh temp file for each test. The tee
    // itself installs once per process and stays installed.
    logger.installDaemonConsoleTee(new logger.DaemonLogWriter({ logPath }));
  });

  // AC: @daemon-log-capture ac-detached-output-captured
  it("captures console.log/warn/error output into the durable log file", () => {
    console.log("[daemon] tee-capture-log-marker");
    console.warn("[daemon] tee-capture-warn-marker");
    console.error("[daemon] tee-capture-error-marker");

    const content = readTestOutputSync(logPath, "utf8");
    expect(content).toContain("[log] [daemon] tee-capture-log-marker");
    expect(content).toContain("[warn] [daemon] tee-capture-warn-marker");
    expect(content).toContain("[error] [daemon] tee-capture-error-marker");
    for (const line of content.trimEnd().split("\n")) {
      // AC: @daemon-log-capture ac-log-line-timestamps
      expect(line).toMatch(TIMESTAMPED_LINE);
    }
  });

  // AC: @daemon-log-capture ac-foreground-tee
  it("passes output through to the terminal in addition to the file", () => {
    terminal.length = 0;

    console.log("[daemon] tee-passthrough-marker");

    expect(terminal).toContain("[daemon] tee-passthrough-marker");
    expect(readTestOutputSync(logPath, "utf8")).toContain("[daemon] tee-passthrough-marker");
  });

  it("applies a configured size limit to the active writer", () => {
    logger.configureDaemonLogWriter({ maxSizeBytes: 150 });

    console.log(`config-rotation generation-one ${"a".repeat(80)}`);
    console.log(`config-rotation generation-two ${"b".repeat(80)}`);

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readTestOutputSync(`${logPath}.1`, "utf8")).toContain("generation-one");
    expect(readTestOutputSync(logPath, "utf8")).toContain("generation-two");
  });
});

describe("command capture guard", () => {
  // AC: @daemon-log-capture ac-detached-output-captured — guard: output
  // emitted while a command capture store is active is swallowed by the
  // capture store and must NOT land in the daemon log (no double-logging
  // of command output that the API returns to the client).
  it("does not write command-scoped output to the daemon log", async () => {
    const tempDir = await createTempDir("kspec-daemon-guard-");
    const logPath = path.join(tempDir, "daemon.log");
    logger.installDaemonConsoleTee(new logger.DaemonLogWriter({ logPath }));

    // Import AFTER the tee is installed — mirrors the daemon entry point's
    // import order, so the interceptors capture the tee as their originals.
    const { createCommandRoutes } = await import("../dist/daemon/routes/command.js");
    const { projectContextMiddleware } =
      await import("../dist/daemon/middleware/project-context.js");
    const { PubSubManager } = await import("../dist/daemon/websocket/pubsub.js");
    const { Elysia } = await import("elysia");

    // Minimal project: the middleware only requires .kspec/ to exist and
    // the injected command never loads project state.
    mkdirSync(path.join(tempDir, "project", ".kspec"), { recursive: true });

    const { middleware } = projectContextMiddleware();
    const app = new Elysia().use(middleware).use(
      createCommandRoutes({
        pubsub: new PubSubManager(),
        prepareProgram: (program) => {
          program.command("guard-emit").action(() => {
            console.log("GUARD_COMMAND_OUTPUT_MARKER");
          });
        },
      }),
    );

    const response = await app.handle(
      new Request("http://localhost/api/command", {
        method: "POST",
        headers: {
          Host: "localhost",
          "X-Kspec-Dir": path.join(tempDir, "project"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ command: "guard-emit" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { stdout: string };
    // The command's output reached the API response via the capture store...
    expect(body.stdout).toContain("GUARD_COMMAND_OUTPUT_MARKER");
    // ...and was never double-logged into the daemon log file.
    const logContent = existsSync(logPath) ? readTestOutputSync(logPath, "utf8") : "";
    expect(logContent).not.toContain("GUARD_COMMAND_OUTPUT_MARKER");

    // Daemon-side output (no active capture store) still flows
    // interceptor → tee → file.
    console.log("GUARD_DAEMON_SIDE_MARKER");
    expect(readTestOutputSync(logPath, "utf8")).toContain("GUARD_DAEMON_SIDE_MARKER");

    await cleanupTempDir(tempDir);
  });
});

describe("serve status log location", () => {
  // AC: @daemon-log-capture ac-log-location-discoverable
  it("reports the daemon log file location in status output", async () => {
    const tempDir = await createTempDir("kspec-daemon-status-");

    const status = kspecJson<{ log_path: string }>("serve status --json", tempDir);

    // The kspec helper isolates HOME to <cwd>/.test-home, so the reported
    // location is the global daemon state directory under that HOME.
    expect(typeof status.log_path).toBe("string");
    expect(status.log_path).toBe(
      path.join(tempDir, ".test-home", ".config", "kspec", "daemon.log"),
    );

    await cleanupTempDir(tempDir);
  });
});
