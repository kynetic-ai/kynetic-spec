#!/usr/bin/env node
/**
 * Mock ACP agent for testing dispatch command flows.
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
 * - MOCK_ACP_COMPLETE_TASK: Task ref to complete after successful prompt (e.g., "@task-slug")
 * - MOCK_ACP_NEEDS_WORK_TASK: Task ref to kick back as needs_work after successful prompt
 * - MOCK_ACP_PROJECT_DIR: Working directory for kspec commands
 * - MOCK_ACP_CLI_PATH: Path to kspec CLI entry point (required in CI where kspec isn't global)
 * - MOCK_ACP_VERIFY_ARGS_FILE: Write process.argv to this file for verifying command-line args
 * - MOCK_ACP_EMIT_RATE_LIMIT_EVENT: If true, emit a simulated non-actionable rate_limit_event stderr line
 * - MOCK_ACP_EMIT_ACTIONABLE_STDERR: Emit this stderr line during prompt handling
 * - MOCK_ACP_SUPPRESS_UPDATES: If true, send no session updates before response
 * - MOCK_ACP_SEND_NON_MEANINGFUL_ONLY: If true, send only available_commands_update (not meaningful)
 * - MOCK_ACP_CUSTOM_UPDATE_TYPE: Send a specific sessionUpdate type (e.g., "tool_call", "plan")
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { execSync } from 'node:child_process';

// ─── State ───────────────────────────────────────────────────────────────────

let sessionId = null;
let initialized = false;
/** Map of pending outgoing requests: id → { resolve, reject } */
const pendingRequests = new Map();

// ─── Environment Config ──────────────────────────────────────────────────────

const exitCode = parseInt(process.env.MOCK_ACP_EXIT_CODE || '0', 10);
const failCount = parseInt(process.env.MOCK_ACP_FAIL_COUNT || '0', 10);
const stateFile = process.env.MOCK_ACP_STATE_FILE;
const delayMs = parseInt(process.env.MOCK_ACP_DELAY_MS || '0', 10);
const responseText = process.env.MOCK_ACP_RESPONSE_TEXT || 'Mock response';
const stopReason = process.env.MOCK_ACP_STOP_REASON || 'end_turn';
const completeTask = process.env.MOCK_ACP_COMPLETE_TASK;
const needsWorkTask = process.env.MOCK_ACP_NEEDS_WORK_TASK;
const projectDir = process.env.MOCK_ACP_PROJECT_DIR;
const cliPath = process.env.MOCK_ACP_CLI_PATH || 'kspec';
// Write specified env var values to a file for test verification
const verifyEnvFile = process.env.MOCK_ACP_VERIFY_ENV_FILE;
const verifyEnvVars = process.env.MOCK_ACP_VERIFY_ENV_VARS; // comma-separated var names
// Write process.argv to a file for verifying command-line args
const verifyArgsFile = process.env.MOCK_ACP_VERIFY_ARGS_FILE;
const sendPermissionRequest = process.env.MOCK_ACP_SEND_PERMISSION_REQUEST === 'true';
const emitRateLimitEvent = process.env.MOCK_ACP_EMIT_RATE_LIMIT_EVENT === 'true';
const actionableStderr = process.env.MOCK_ACP_EMIT_ACTIONABLE_STDERR;
// Stall watchdog testing: suppress meaningful updates or send only non-meaningful ones
const suppressUpdates = process.env.MOCK_ACP_SUPPRESS_UPDATES === 'true';
const sendNonMeaningfulOnly = process.env.MOCK_ACP_SEND_NON_MEANINGFUL_ONLY === 'true';
// Send a specific sessionUpdate type before responding
const customUpdateType = process.env.MOCK_ACP_CUSTOM_UPDATE_TYPE;

// ─── JSON-RPC Helpers ────────────────────────────────────────────────────────

function sendResponse(id, result) {
  const response = { jsonrpc: '2.0', id, result };
  console.log(JSON.stringify(response));
}

let nextRequestId = 1;
/**
 * Send a JSON-RPC request FROM the agent TO the client and await the response.
 * Used for permission requests where the agent asks the client to approve a tool call.
 */
function sendOutgoingRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = `mock-req-${nextRequestId++}`;
    pendingRequests.set(id, { resolve, reject });
    const request = { jsonrpc: '2.0', id, method, params };
    console.log(JSON.stringify(request));
  });
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

  // Write process.argv to file for test verification of command-line args
  if (verifyArgsFile) {
    fs.writeFileSync(verifyArgsFile, JSON.stringify(process.argv, null, 2));
  }

  // Write requested env var values to file for test verification
  if (verifyEnvFile && verifyEnvVars) {
    const vars = verifyEnvVars.split(',').map(v => v.trim());
    const result = {};
    for (const name of vars) {
      result[name] = process.env[name] || null;
    }
    fs.writeFileSync(verifyEnvFile, JSON.stringify(result, null, 2));
  }

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

  if (emitRateLimitEvent) {
    console.error('Unexpected case: {"type":"rate_limit_event","detail":"mock rate limit info"}');
  }

  if (actionableStderr) {
    console.error(actionableStderr);
  }

  // Optionally send a permission request before responding (for ac-11 tests)
  if (sendPermissionRequest) {
    await sendOutgoingRequest("session/request_permission", {
      sessionId: params.sessionId,
      toolCall: {
        toolCallUpdate: "tool_use",
        toolCallId: "mock-tool-1",
        toolName: "Edit",
        input: { path: "/some/file.ts", content: "new content" },
      },
      options: [
        { optionId: "allow-once-id", kind: "allow_once", name: "Allow once" },
        { optionId: "allow-always-id", kind: "allow_always", name: "Allow always" },
      ],
    });
  }

  // Send streaming update notification (ACP SessionUpdate format)
  // SessionUpdate is a discriminated union with sessionUpdate as the discriminator
  if (sendNonMeaningfulOnly) {
    // Send only non-meaningful update (for stall watchdog tests)
    sendNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        commands: [],
      },
    });
  } else if (customUpdateType) {
    // Send a specific update type (for testing individual meaningful types)
    sendNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: customUpdateType,
        ...(customUpdateType === "agent_message_chunk" || customUpdateType === "agent_thought_chunk"
          ? { content: { type: "text", text: responseText } }
          : customUpdateType === "tool_call"
            ? { toolCallUpdate: "tool_use", toolCallId: "mock-tool-1", toolName: "Read", input: {} }
            : customUpdateType === "tool_call_update"
              ? { toolCallUpdate: "progress", toolCallId: "mock-tool-1", progress: "working..." }
              : customUpdateType === "plan"
                ? { entries: [{ id: "1", title: "Step 1", status: "in_progress", priority: "high" }] }
                : customUpdateType === "usage_update"
                  ? { usage: { inputTokens: 100, outputTokens: 50 }, cost: { inputCostUsd: 0.01, outputCostUsd: 0.005 } }
                  : {}),
      },
    });
  } else if (!suppressUpdates) {
    sendNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: responseText },
      },
    });
  }

  // Complete task if configured (simulates agent completing work)
  // IMPORTANT: Must complete BEFORE sending response so the dispatch verifier sees the change
  if (completeTask && projectDir) {
    try {
      // Use --force to complete from pending_review state
      // Use node + cliPath for CI compatibility (kspec may not be globally installed)
      const cmd = cliPath === 'kspec'
        ? `kspec task complete ${completeTask} --reason "Mock automated completion" --force`
        : `node ${cliPath} task complete ${completeTask} --reason "Mock automated completion" --force`;
      execSync(cmd, {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.error(`Mock ACP: Completed task ${completeTask}`);
    } catch (err) {
      console.error(`Mock ACP: Failed to complete task ${completeTask}: ${err.message}`);
      // Don't fail the mock - task completion is best-effort
    }
  }

  // Kick task back to needs_work if configured (simulates reviewer findings)
  if (needsWorkTask && projectDir) {
    try {
      const cmd = cliPath === 'kspec'
        ? `kspec task needs-work ${needsWorkTask} --reason "Mock review findings"`
        : `node ${cliPath} task needs-work ${needsWorkTask} --reason "Mock review findings"`;
      execSync(cmd, {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.error(`Mock ACP: Kicked task to needs_work ${needsWorkTask}`);
    } catch (err) {
      console.error(`Mock ACP: Failed to set needs_work for ${needsWorkTask}: ${err.message}`);
      // Don't fail the mock - task status update is best-effort
    }
  }

  // Send completion response AFTER task is completed
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
  // This matches the yolo mode behavior in the real dispatch command
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

    if (msg.jsonrpc !== "2.0") {
      sendError(msg.id || null, -32600, "Invalid Request");
      return;
    }

    // Handle responses to outgoing requests (no 'method' field, has 'result' or 'error')
    if (!msg.method && msg.id !== undefined) {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'Request failed'));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (!msg.method) {
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
