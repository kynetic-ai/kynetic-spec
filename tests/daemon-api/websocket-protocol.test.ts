import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { readTestOutputSync } from "../helpers/cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DAEMON_ENTRY = join(__dirname, "../../dist/daemon/index.js");
const KSPEC_CLI = join(__dirname, "../../dist/cli/index.js");
const E2E_FIXTURES = join(__dirname, "../e2e/fixtures");
const WEB_UI_BUILD = join(__dirname, "../../packages/web-ui/build");

interface BroadcastMessage {
  msg_id: string;
  seq: number;
  timestamp: string;
  topic: string;
  event: string;
  data: Record<string, unknown>;
}

interface AckMessage {
  ack: boolean;
  request_id?: string;
  success: boolean;
  error?: string;
  details?: unknown;
}

interface ConnectedMessage {
  event: "connected";
  data: { session_id: string };
}

interface DaemonRuntime {
  tempDir: string;
  kspecDir: string;
  port: number;
  baseUrl: string;
  wsUrl: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

let runtime: DaemonRuntime;
let daemonProcess: ChildProcess | null = null;
let isolatedEnv: Record<string, string>;
let daemonStderr = "";

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate ephemeral port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForDaemonReady(baseUrl: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (daemonProcess?.exitCode !== null) {
      throw new Error(
        `Daemon exited with code ${daemonProcess.exitCode} before becoming ready.\n${daemonStderr}`,
      );
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        break;
      }
    } catch {
      // continue polling
    }

    if (i === 149) {
      throw new Error(`Daemon failed to become ready.\n${daemonStderr}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  for (let i = 0; i < 150; i++) {
    try {
      const response = await fetch(`${baseUrl}/api/tasks`);
      if (response.ok) {
        const body = await response.json();
        if (body?.meta?.cache_status === "ready") {
          return;
        }
      }
    } catch {
      // continue polling
    }

    if (i === 149) {
      throw new Error(`Daemon cache failed to become ready.\n${daemonStderr}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startDaemon() {
  if (daemonProcess && daemonProcess.exitCode === null) {
    return;
  }

  daemonStderr = "";
  daemonProcess = spawn(
    "bun",
    [DAEMON_ENTRY, "--port", String(runtime.port), "--kspec-dir", runtime.tempDir],
    {
      cwd: runtime.tempDir,
      stdio: "pipe",
      env: { ...isolatedEnv, BUN_ENV: "production" },
    },
  );

  daemonProcess.stderr?.on("data", (chunk: Buffer) => {
    daemonStderr += chunk.toString();
  });

  await waitForDaemonReady(runtime.baseUrl);
}

async function stopDaemon() {
  if (!daemonProcess || daemonProcess.exitCode !== null) {
    return;
  }

  try {
    execSync(`node ${KSPEC_CLI} serve stop`, {
      cwd: runtime.tempDir,
      stdio: "ignore",
      timeout: 10_000,
      env: isolatedEnv,
    });
  } catch {
    if (daemonProcess.pid && daemonProcess.exitCode === null) {
      daemonProcess.kill("SIGTERM");
    }
  }

  if (daemonProcess.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (daemonProcess?.exitCode === null) {
          daemonProcess.kill("SIGKILL");
        }
        resolve();
      }, 5_000);

      daemonProcess?.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  daemonProcess = null;
}

async function createRuntime(): Promise<DaemonRuntime> {
  const port = await getAvailablePort();
  const tempDir = mkdtempSync(join(tmpdir(), "kspec-ws-protocol-"));
  const kspecDir = join(tempDir, ".kspec");
  mkdirSync(kspecDir, { recursive: true });

  const isolatedHome = join(tempDir, ".home");
  mkdirSync(join(isolatedHome, ".config", "kspec"), { recursive: true });
  const {
    KSPEC_NO_DAEMON: _kspecNoDaemon,
    KSPEC_SESSION_ID: _kspecSessionId,
    ...baseEnv
  } = process.env;
  isolatedEnv = {
    ...baseEnv,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    WEB_UI_DIR: WEB_UI_BUILD,
  };

  cpSync(E2E_FIXTURES, kspecDir, {
    recursive: true,
    filter: (src) => !src.includes("test-base") && !src.includes("project-tests"),
  });

  execSync("git init", { cwd: tempDir, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: tempDir, stdio: "ignore" });

  const gitWorktreesDir = join(tempDir, ".git", "worktrees", "-kspec");
  mkdirSync(gitWorktreesDir, { recursive: true });
  writeFileSync(join(kspecDir, ".git"), `gitdir: ${gitWorktreesDir}\n`);
  writeFileSync(join(gitWorktreesDir, "gitdir"), `${join(tempDir, ".git")}\n`);
  writeFileSync(join(gitWorktreesDir, "HEAD"), "ref: refs/heads/kspec-meta\n");

  return {
    tempDir,
    kspecDir,
    port,
    baseUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}/ws`,
    start: startDaemon,
    stop: stopDaemon,
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open")),
      5_000,
    );
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function nextMessage<T>(
  ws: WebSocket,
  predicate: (message: unknown) => message is T,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for matching websocket message"));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const message = JSON.parse(raw.toString()) as unknown;
        if (predicate(message)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(message);
        }
      } catch {
        // ignore malformed frames until the predicate match or timeout
      }
    };

    ws.on("message", onMessage);
  });
}

async function connectClient() {
  const ws = new WebSocket(runtime.wsUrl);
  const connectedPromise = nextMessage<ConnectedMessage>(
    ws,
    (message): message is ConnectedMessage =>
      typeof message === "object" &&
      message !== null &&
      "event" in message &&
      (message as ConnectedMessage).event === "connected",
  );
  await waitForOpen(ws);
  const connected = await connectedPromise;
  return { ws, connected };
}

async function sendCommandAndWaitForAck(
  ws: WebSocket,
  command: Record<string, unknown>,
): Promise<AckMessage> {
  const ackPromise = nextMessage<AckMessage>(
    ws,
    (message): message is AckMessage =>
      typeof message === "object" &&
      message !== null &&
      "ack" in message &&
      typeof (message as AckMessage).ack === "boolean",
  );
  ws.send(JSON.stringify(command));
  return ackPromise;
}

describe("daemon websocket protocol", () => {
  beforeEach(async () => {
    runtime = await createRuntime();
    await runtime.start();
  });

  afterEach(async () => {
    await runtime.stop();
    rmSync(runtime.tempDir, { recursive: true, force: true });
  });

  // AC: @api-contract ac-25
  // AC: @trait-websocket-protocol ac-1
  it("sends a connected event with a session_id when the client connects", async () => {
    const { ws, connected } = await connectClient();

    expect(connected.data.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    ws.close(1000, "test complete");
    await waitForClose(ws);
  });

  // AC: @api-contract ac-websocket-origin
  // The daemon's WS upgrade hook accepts an Origin header in the
  // CORS allow-list. The default loopback configuration includes
  // http://127.0.0.1:5173 and http://localhost:5173 for the dev
  // server, plus the same-origin daemon URL.
  it("accepts a WebSocket upgrade from an allowed Origin (dev server)", async () => {
    const ws = new WebSocket(runtime.wsUrl, { origin: "http://127.0.0.1:5173" });
    const connectedPromise = nextMessage<ConnectedMessage>(
      ws,
      (message): message is ConnectedMessage =>
        typeof message === "object" &&
        message !== null &&
        "event" in message &&
        (message as ConnectedMessage).event === "connected",
    );
    await waitForOpen(ws);
    const connected = await connectedPromise;
    expect(connected.data.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    ws.close(1000, "test complete");
    await waitForClose(ws);
  });

  // AC: @api-contract ac-websocket-origin
  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // Regression: production same-origin must succeed when the user
  // opens the daemon UI through the `localhost` alias instead of the
  // advertised connect host (127.0.0.1). The daemon's localhostOnly
  // middleware accepts Host: localhost regardless of bind host, so the
  // browser-attached Origin: http://localhost:<daemon-port> header
  // must be in the allow-list — otherwise opening
  // http://localhost:<daemon-port> in production breaks the WebSocket.
  it("accepts a WebSocket upgrade from the localhost daemon-port same-origin", async () => {
    const ws = new WebSocket(runtime.wsUrl, {
      origin: `http://localhost:${runtime.port}`,
    });
    const connectedPromise = nextMessage<ConnectedMessage>(
      ws,
      (message): message is ConnectedMessage =>
        typeof message === "object" &&
        message !== null &&
        "event" in message &&
        (message as ConnectedMessage).event === "connected",
    );
    await waitForOpen(ws);
    const connected = await connectedPromise;
    expect(connected.data.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    ws.close(1000, "test complete");
    await waitForClose(ws);
  });

  // AC: @api-contract ac-websocket-origin
  // Browsers attach the Origin header automatically. A connection from
  // an origin outside the allow-list must be rejected at the upgrade
  // step instead of being silently accepted (which would let any
  // cross-origin page subscribe to project state and run commands).
  it("rejects a WebSocket upgrade from a disallowed Origin", async () => {
    const ws = new WebSocket(runtime.wsUrl, { origin: "http://evil.example.com" });
    // The connection must close (or error) without a successful open —
    // either an error event or a non-1000 close before any 'open'.
    let opened = false;
    ws.once("open", () => {
      opened = true;
    });
    const closed = await new Promise<{ code: number }>((resolve) => {
      const timeout = setTimeout(() => resolve({ code: -1 }), 5_000);
      const finish = (code: number) => {
        clearTimeout(timeout);
        resolve({ code });
      };
      ws.once("close", (code) => finish(code));
      ws.once("error", () => finish(-1));
    });
    expect(opened).toBe(false);
    // Either a close (often code 1006 for abnormal) or error path is
    // acceptable — both indicate the upgrade was rejected.
    expect(closed.code === -1 || closed.code === 1006 || closed.code >= 4000).toBe(true);
  });

  // AC: @api-contract ac-26
  // AC: @api-contract ac-27
  it("acknowledges valid commands with correlated ack metadata", async () => {
    const { ws } = await connectClient();

    const ack = await sendCommandAndWaitForAck(ws, {
      action: "ping",
      request_id: "req-ping-001",
      payload: {},
    });

    expect(ack).toMatchObject({
      ack: true,
      request_id: "req-ping-001",
      success: true,
    });

    ws.close(1000, "test complete");
    await waitForClose(ws);
  });

  // AC: @api-contract ac-30
  it("returns a validation_error nack for malformed commands", async () => {
    const { ws } = await connectClient();

    const ackPromise = nextMessage<AckMessage>(
      ws,
      (message): message is AckMessage =>
        typeof message === "object" &&
        message !== null &&
        "ack" in message &&
        typeof (message as AckMessage).ack === "boolean",
    );
    ws.send(JSON.stringify({ request_id: "bad-command" }));
    const ack = await ackPromise;

    expect(ack.ack).toBe(false);
    expect(ack.success).toBe(false);
    expect(ack.request_id).toBeUndefined();
    expect(ack.error).toBe("validation_error");
    expect(ack.details).toBe("Missing action field");

    ws.close(1000, "test complete");
    await waitForClose(ws);
  });

  // AC: @api-contract ac-30
  it("returns a validation_error nack for subscribe commands with invalid topics", async () => {
    const { ws } = await connectClient();

    const ack = await sendCommandAndWaitForAck(ws, {
      action: "subscribe",
      request_id: "bad-subscribe-topics",
      payload: {},
    });

    expect(ack).toMatchObject({
      ack: false,
      request_id: "bad-subscribe-topics",
      success: false,
      error: "validation_error",
      details: "Missing or invalid topics array",
    });

    ws.close(1000, "test complete");
    await waitForClose(ws);
  });

  // AC: @api-contract ac-30
  it("returns a validation_error nack for unsubscribe commands with invalid topics", async () => {
    const { ws } = await connectClient();

    const ack = await sendCommandAndWaitForAck(ws, {
      action: "unsubscribe",
      request_id: "bad-unsubscribe-topics",
      payload: {},
    });

    expect(ack).toMatchObject({
      ack: false,
      request_id: "bad-unsubscribe-topics",
      success: false,
      error: "validation_error",
      details: "Missing or invalid topics array",
    });

    ws.close(1000, "test complete");
    await waitForClose(ws);
  });

  // AC: @api-contract ac-28
  // AC: @api-contract ac-29
  // AC: @trait-websocket-protocol ac-2
  // AC: @trait-websocket-protocol ac-3
  // AC: @daemon-server ac-4
  it("broadcasts file change events after a successful subscription", async () => {
    const { ws } = await connectClient();

    const subscribeAck = await sendCommandAndWaitForAck(ws, {
      action: "subscribe",
      request_id: "subscribe-files",
      payload: { topics: ["files:updates"] },
    });

    expect(subscribeAck).toMatchObject({
      ack: true,
      request_id: "subscribe-files",
      success: true,
    });

    const broadcastPromise = nextMessage<BroadcastMessage>(
      ws,
      (message): message is BroadcastMessage =>
        typeof message === "object" &&
        message !== null &&
        "topic" in message &&
        (message as BroadcastMessage).topic === "files:updates" &&
        typeof (message as BroadcastMessage).msg_id === "string",
    );

    const tasksYaml = join(runtime.kspecDir, "project.tasks.yaml");
    const original = readTestOutputSync(tasksYaml, "utf8");
    writeFileSync(tasksYaml, `${original}\n# websocket-protocol-test ${Date.now()}\n`);

    const broadcast = await broadcastPromise;

    expect(broadcast.topic).toBe("files:updates");
    expect(broadcast.event).toBeTruthy();
    expect(broadcast.msg_id).toBeTruthy();
    expect(typeof broadcast.seq).toBe("number");
    expect(broadcast.seq).toBeGreaterThan(0);
    expect(new Date(broadcast.timestamp).toString()).not.toBe("Invalid Date");
    expect(broadcast.data).toMatchObject({
      action: expect.any(String),
      ref: expect.any(String),
    });

    ws.close(1000, "test complete");
    await waitForClose(ws);
  });

  // AC: @api-contract ac-31
  it("uses close code 1000 for a graceful daemon shutdown", async () => {
    const { ws } = await connectClient();

    const closePromise = waitForClose(ws);
    await runtime.stop();
    const close = await closePromise;

    expect(close.code).toBe(1000);
  });

  // AC: @api-contract ac-31
  // AC: @trait-websocket-protocol ac-7
  it("uses close code 1011 when command handling hits an internal server error", async () => {
    await runtime.stop();
    rmSync(runtime.tempDir, { recursive: true, force: true });

    runtime = await createRuntime();
    isolatedEnv.KSPEC_TEST_WS_FORCE_INTERNAL_ERROR_REQUEST_ID = "trigger-1011";
    await runtime.start();

    const { ws } = await connectClient();
    const closePromise = waitForClose(ws);

    const ack = await sendCommandAndWaitForAck(ws, {
      action: "ping",
      request_id: "trigger-1011",
      payload: {},
    });

    expect(ack).toMatchObject({
      ack: true,
      request_id: "trigger-1011",
      success: false,
      error: "error",
      details: "Injected websocket failure for trigger-1011",
    });

    const close = await closePromise;
    expect(close.code).toBe(1011);
    expect(close.reason).toBe("Internal error");

    delete isolatedEnv.KSPEC_TEST_WS_FORCE_INTERNAL_ERROR_REQUEST_ID;
  });
});
