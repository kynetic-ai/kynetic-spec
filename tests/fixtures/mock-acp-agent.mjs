/**
 * Minimal mock ACP agent for testing.
 *
 * Implements just enough of the ACP JSON-RPC 2.0 protocol to pass
 * initialize/session/new/session/prompt handshakes. Writes received
 * environment variables to a file so tests can verify env injection.
 *
 * Usage:
 *   MOCK_ACP_ENV_FILE=/tmp/env.json node mock-acp-agent.mjs
 *
 * Protocol: newline-delimited JSON-RPC 2.0 over stdio.
 */

import { writeFileSync } from "node:fs";

// Write env vars to file if requested (for env injection tests)
const envFile = process.env.MOCK_ACP_ENV_FILE;
if (envFile) {
  writeFileSync(
    envFile,
    JSON.stringify({
      KSPEC_SESSION_ID: process.env.KSPEC_SESSION_ID ?? null,
      KSPEC_RALPH_SESSION: process.env.KSPEC_RALPH_SESSION ?? null,
    }),
  );
}

let sessionCounter = 0;

/**
 * Handle a JSON-RPC request and return a response.
 */
function handleRequest(msg) {
  const { id, method } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: "mock-acp", version: "0.0.1" },
        },
      };

    case "session/new":
      sessionCounter++;
      return {
        jsonrpc: "2.0",
        id,
        result: { sessionId: `mock-session-${sessionCounter}` },
      };

    case "session/prompt":
      return {
        jsonrpc: "2.0",
        id,
        result: { stopReason: "endTurn" },
      };

    case "session/cancel":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// Read newline-delimited JSON from stdin
let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf("\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        // Only respond to requests (have an id), ignore notifications
        if (msg.id !== undefined) {
          const response = handleRequest(msg);
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      } catch {
        // Ignore parse errors
      }
    }
    idx = buffer.indexOf("\n");
  }
});

// Keep process alive until stdin closes
process.stdin.on("end", () => {
  process.exit(0);
});
