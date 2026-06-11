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
import { configureDaemonLogWriter } from "./logger.js";
import { createServer } from "./server.js";
import { parseArgs } from "util";
import { join } from "path";
import type { DaemonRuntime } from "./server.js";

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
if (isNaN(port) || port < 1 || port > 65535) {
  console.error("[daemon] Invalid port number. Must be between 1 and 65535.");
  process.exit(1);
}

if (runtimeValue !== "bun" && runtimeValue !== "node") {
  console.error("[daemon] Invalid runtime. Must be 'bun' or 'node'.");
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
    });

    // Server will start listening in createServer
    // Graceful shutdown handled in server.ts
  } catch (error) {
    console.error("[daemon] Failed to start:", error);
    process.exit(1);
  }
}

main();
