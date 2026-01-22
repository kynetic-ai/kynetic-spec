#!/usr/bin/env node
/**
 * Mock ACP agent for testing ralph command.
 *
 * Implements minimal ACP JSON-RPC protocol:
 * - initialize
 * - session/new
 * - session/prompt
 * - session/request_permission (auto-approves in yolo mode style)
 *
 * Controlled via environment variables:
 * - MOCK_ACP_EXIT_CODE: Exit code to return on prompt (default: 0 = success)
 * - MOCK_ACP_FAIL_COUNT: Number of times to fail before succeeding (uses state file)
 * - MOCK_ACP_STATE_FILE: Path to state file for tracking call count
 * - MOCK_ACP_DELAY_MS: Delay before responding to prompt
 * - MOCK_ACP_RESPONSE_TEXT: Text to include in response
 * - MOCK_ACP_STOP_REASON: Stop reason (default: end_turn)
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';

// ─── State ───────────────────────────────────────────────────────────────────

let sessionId = null;
let initialized = false;

// ─── Environment Config ──────────────────────────────────────────────────────

const exitCode = parseInt(process.env.MOCK_ACP_EXIT_CODE || '0', 10);
const failCount = parseInt(process.env.MOCK_ACP_FAIL_COUNT || '0', 10);
const stateFile = process.env.MOCK_ACP_STATE_FILE;
const delayMs = parseInt(process.env.MOCK_ACP_DELAY_MS || '0', 10);
const responseText = process.env.MOCK_ACP_RESPONSE_TEXT || 'Mock response';
const stopReason = process.env.MOCK_ACP_STOP_REASON || 'end_turn';

// ─── JSON-RPC Helpers ────────────────────────────────────────────────────────

function sendResponse(id, result) {
  const response = { jsonrpc: '2.0', id, result };
  console.log(JSON.stringify(response));
}

function sendError(id, code, message) {
  const response = { jsonrpc: '2.0', id, error: { code, message } };
  console.log(JSON.stringify(response));
}

function sendNotification(method, params) {
  const notification = { jsonrpc: '2.0', method, params };
  console.log(JSON.stringify(notification));
}

// ─── Failure Tracking ────────────────────────────────────────────────────────

function shouldFail() {
  if (failCount <= 0 || !stateFile) {
    return exitCode !== 0;
  }

  // Track call count in state file
  let callCount = 0;
  try {
    callCount = parseInt(fs.readFileSync(stateFile, 'utf-8').trim(), 10) || 0;
  } catch {
    // File doesn't exist yet
  }
  callCount++;
  fs.writeFileSync(stateFile, String(callCount));

  // Fail until we've been called failCount times
  if (callCount <= failCount) {
    console.error(`Mock ACP: Simulated failure ${callCount}/${failCount}`);
    return true;
  }

  console.error(`Mock ACP: Success after ${failCount} failures`);
  return false;
}

// ─── Request Handlers ────────────────────────────────────────────────────────

async function handleInitialize(id, _params) {
  initialized = true;
  sendResponse(id, {
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: {
      name: "mock-acp",
      version: "1.0.0",
    },
  });
}

async function handleNewSession(id, params) {
  if (!initialized) {
    sendError(id, -32002, 'Not initialized');
    return;
  }

  sessionId = `mock-session-${Date.now()}`;
  sendResponse(id, { sessionId });
}

async function handlePrompt(id, params) {
  if (!initialized) {
    sendError(id, -32002, "Not initialized");
    return;
  }

  if (!sessionId || params.sessionId !== sessionId) {
    sendError(id, -32003, "Invalid session");
    return;
  }

  // Optional delay
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Check if we should fail
  if (shouldFail()) {
    sendError(id, -32000, "Mock failure");
    return;
  }

  // Send streaming update notification (ACP SessionUpdate format)
  // SessionUpdate is a discriminated union with sessionUpdate as the discriminator
  sendNotification("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: responseText },
    },
  });

  // Send completion response
  sendResponse(id, { stopReason });
}

async function handleRequestPermission(id, params) {
  if (!initialized) {
    sendError(id, -32002, "Not initialized");
    return;
  }

  // Extract options from request
  const options = params.options || [];

  // Auto-approve: Find an "allow" option (prefer allow_always, then allow_once)
  // This matches the yolo mode behavior in the real ralph command
  const allowOption =
    options.find((o) => o.kind === "allow_always") ||
    options.find((o) => o.kind === "allow_once");

  if (allowOption) {
    // Grant permission using the correct ACP response format
    sendResponse(id, {
      outcome: { outcome: "selected", optionId: allowOption.optionId },
    });
  } else {
    // No allow option available - cancel the request
    sendResponse(id, { outcome: { outcome: "cancelled" } });
  }
}

// ─── Message Router ──────────────────────────────────────────────────────────

async function handleMessage(line) {
  try {
    const msg = JSON.parse(line);

    if (msg.jsonrpc !== "2.0" || !msg.method) {
      sendError(msg.id || null, -32600, "Invalid Request");
      return;
    }

    switch (msg.method) {
      case "initialize":
        await handleInitialize(msg.id, msg.params);
        break;
      case "session/new":
        await handleNewSession(msg.id, msg.params);
        break;
      case "session/prompt":
        await handlePrompt(msg.id, msg.params);
        break;
      case "session/request_permission":
        await handleRequestPermission(msg.id, msg.params);
        break;
      default:
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    sendError(null, -32700, "Parse error");
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  if (line.trim()) {
    handleMessage(line).catch((err) => {
      console.error('Mock ACP error:', err.message);
    });
  }
});

rl.on('close', () => {
  process.exit(0);
});
