#!/usr/bin/env node
/**
 * Kspec Daemon Entry Point
 *
 * Long-running server that exposes kspec state via HTTP API and WebSocket.
 * Supports foreground and background modes with PID file management.
 * AC: @daemon-server ac-9
 */

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
