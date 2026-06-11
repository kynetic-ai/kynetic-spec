#!/usr/bin/env node
/**
 * Kspec Daemon Entry Point
 *
 * Long-running server that exposes kspec state via HTTP API and WebSocket.
 * Supports foreground and background modes with PID file management.
 * AC: @daemon-server ac-9
 */

// AC: @daemon-log-capture ac-detached-output-captured — the console tee
// must install before server.js (which statically imports routes/command.js
// and its console interceptors), so this side-effect import stays first.
// oxlint-disable-next-line eslint-plugin-import/no-unassigned-import -- intentional side-effect import
import "./logger-install.js";
import { installDaemonFatalHandlers } from "./fatal-handlers.js";
import { configureDaemonLogWriter } from "./logger.js";
import { createServer } from "./server.js";
import { writeDaemonLastExitRecord } from "./pid.js";
import { parseArgs } from "util";
import { join } from "path";
import type { DaemonRuntime } from "./server.js";

// AC: @daemon-failure-observability ac-fatal-error-recorded — fault handlers
// must be active before createServer() (and any other async work) so an
// uncaught error or unhandled rejection at any point is recorded before the
// process dies.
installDaemonFatalHandlers();

function detectProcessRuntime(): DaemonRuntime {
  return typeof process.versions.bun === "string" ? "bun" : "node";
}

// Parse command line args
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", default: "3456" },
    runtime: { type: "string" },
    "kspec-dir": { type: "string" },
    host: { type: "string" },
    // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
    // Set by the CLI when daemon.host came from an explicit env/config
    // value rather than the built-in default. Suppresses IPv6 fallback.
    "host-explicit": { type: "boolean" },
    "connect-host": { type: "string" },
    // AC: @daemon-log-capture ac-bounded-rotation
    // Configured daemon.log_max_size_bytes forwarded by the CLI.
    "log-max-size": { type: "string" },
    // AC: @daemon-command-api ac-command-timeout
    // Configured daemon.command_timeout_ms forwarded by the CLI.
    "command-timeout": { type: "string" },
  },
  allowPositionals: true,
});

const port = parseInt(values.port as string, 10);
const kspecDir = (values["kspec-dir"] as string) || join(process.cwd(), ".kspec");
const runtimeValue =
  (values.runtime as string | undefined) ??
  process.env.KSPEC_DAEMON_RUNTIME ??
  detectProcessRuntime();
const bindHost = (values.host as string | undefined) ?? undefined;
const hostExplicit = values["host-explicit"] === true;
const connectHost = (values["connect-host"] as string | undefined) ?? undefined;

// AC: @daemon-command-api ac-command-timeout — configured execution limit
// forwarded by the CLI; invalid or absent values fall back to the default.
let commandTimeoutMs: number | undefined;
if (values["command-timeout"] !== undefined) {
  const parsed = parseInt(values["command-timeout"] as string, 10);
  if (!isNaN(parsed) && parsed > 0) {
    commandTimeoutMs = parsed;
  }
}

// AC: @daemon-log-capture ac-bounded-rotation — apply the configured size
// limit once startup configuration is parsed. The tee installed with the
// built-in default until now; invalid values are ignored by the writer.
if (values["log-max-size"] !== undefined) {
  const logMaxSize = parseInt(values["log-max-size"] as string, 10);
  if (!isNaN(logMaxSize)) {
    configureDaemonLogWriter({ maxSizeBytes: logMaxSize });
  }
}

// Validate port
// AC: @daemon-failure-observability ac-exit-record-durable — startup
// validation exits record why the daemon never came up.
if (isNaN(port) || port < 1 || port > 65535) {
  console.error("[daemon] Invalid port number. Must be between 1 and 65535.");
  writeDaemonLastExitRecord({
    kind: "startup_failure",
    reason: `Invalid port number: ${values.port as string}. Must be between 1 and 65535.`,
  });
  process.exit(1);
}

if (runtimeValue !== "bun" && runtimeValue !== "node") {
  console.error("[daemon] Invalid runtime. Must be 'bun' or 'node'.");
  writeDaemonLastExitRecord({
    kind: "startup_failure",
    reason: `Invalid runtime: ${runtimeValue}. Must be 'bun' or 'node'.`,
  });
  process.exit(1);
}

const runtime = runtimeValue as DaemonRuntime;

async function main() {
  try {
    console.log(`[daemon] Starting kspec daemon on port ${port}...`);

    const _server = await createServer({
      port,
      isDaemon: true, // Always true when running as standalone daemon
      runtime,
      kspecDir,
      bindHost,
      bindHostExplicitlyConfigured: hostExplicit,
      connectHost: connectHost ?? null,
      commandTimeoutMs,
    });

    // Server will start listening in createServer
    // Graceful shutdown handled in server.ts

    // createServer resolves only after the shutdown signal handlers are
    // registered, so this marker means the daemon is fully operational
    // (listening AND able to shut down gracefully). Tests and operators
    // rely on it to distinguish "port is up" from "startup complete".
    console.log("[daemon] Startup complete");
  } catch (error) {
    console.error("[daemon] Failed to start:", error);
    // AC: @daemon-failure-observability ac-exit-record-durable — a daemon
    // that never came up leaves a startup_failure record explaining why.
    const err = error instanceof Error ? error : new Error(String(error));
    writeDaemonLastExitRecord({
      kind: "startup_failure",
      reason: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

main();
