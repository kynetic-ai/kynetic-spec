import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

import { readTestOutputSync } from "../helpers/cli.js";
import {
  createTestDaemonProject,
  isDaemonRuntimeAvailable,
  startTestDaemon,
  type DaemonTestRuntime,
  type StartedTestDaemon,
  type TestDaemonProject,
} from "../helpers/daemon.js";

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

async function connectClient(daemon: StartedTestDaemon) {
  const ws = new WebSocket(daemon.wsUrl);
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

describe("daemon websocket protocol", { timeout: 60_000 }, () => {
  let project: TestDaemonProject;
  let daemon: StartedTestDaemon;

  // Vitest's hookTimeout default (10s) does not inherit the describe-level
  // test timeout. Cold-starting the daemon (spawn child + load + cache-ready
  // probe) plus copying the e2e fixture set can exceed 10s under shared-worker
  // load, so widen this beforeEach explicitly to match the suite-level intent.
  beforeEach(async () => {
    project = await createTestDaemonProject();
    daemon = await startTestDaemon(project, {
      registerCleanup: (stop) => {
        onTestFinished(async () => {
          await stop();
        });
      },
    });
  }, 60_000);

  afterEach(async () => {
    await project.cleanup();
  });

  // AC: @api-contract ac-25
  // AC: @trait-websocket-protocol ac-1
  // AC: @daemon-backed-test-fixture-contract ac-real-daemon-tests-use-shared-fixture
  // AC: @daemon-backed-test-fixture-contract ac-isolated-home-config
  // AC: @daemon-backed-test-fixture-contract ac-isolated-project-data
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-backed-test-fixture-contract ac-bounded-readiness
  // AC: @daemon-backed-test-fixture-contract ac-readiness-diagnostics
  // AC: @daemon-backed-test-fixture-contract ac-no-ambient-daemon-control
  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  // AC: @daemon-test-endpoint-consistency ac-no-localhost-by-default
  // AC: @daemon-test-endpoint-consistency ac-http-ws-same-endpoint
  // AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
  // AC: @daemon-test-runtime-selection ac-node-default
  // AC: @daemon-test-mode-boundaries ac-full-process-tests-use-real-daemon
  it("sends a connected event with a session_id when the client connects", async () => {
    // Endpoint propagation: the daemon URL is fixture-resolved (127.0.0.1, no
    // localhost, dynamic port) and HTTP and WS share the same endpoint.
    expect(daemon.runtime).toBe("node");
    expect(daemon.endpoint.connectHost).toBe("127.0.0.1");
    expect(daemon.apiUrl).not.toContain("localhost");
    expect(daemon.wsUrl).not.toContain("localhost");
    const apiPortMatch = daemon.apiUrl.match(/:(\d+)/);
    const wsPortMatch = daemon.wsUrl.match(/:(\d+)/);
    expect(apiPortMatch?.[1]).toBe(String(daemon.port));
    expect(wsPortMatch?.[1]).toBe(String(daemon.port));

    const { ws, connected } = await connectClient(daemon);

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
    const ws = new WebSocket(daemon.wsUrl, { origin: "http://127.0.0.1:5173" });
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
    const ws = new WebSocket(daemon.wsUrl, {
      origin: `http://localhost:${daemon.port}`,
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
    const ws = new WebSocket(daemon.wsUrl, { origin: "http://evil.example.com" });
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
    const { ws } = await connectClient(daemon);

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
    const { ws } = await connectClient(daemon);

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
    const { ws } = await connectClient(daemon);

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
    const { ws } = await connectClient(daemon);

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
    const { ws } = await connectClient(daemon);

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

    const tasksYaml = join(project.kspecDir, "project.tasks.yaml");
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
    const { ws } = await connectClient(daemon);

    const closePromise = waitForClose(ws);
    await daemon.stop();
    const close = await closePromise;

    expect(close.code).toBe(1000);
  });
});

describe("daemon websocket protocol — internal error close", { timeout: 60_000 }, () => {
  // AC: @api-contract ac-31
  // AC: @trait-websocket-protocol ac-7
  // AC: @daemon-backed-test-fixture-contract ac-real-daemon-tests-use-shared-fixture
  // AC: @daemon-backed-test-fixture-contract ac-no-ambient-daemon-control
  it("uses close code 1011 when command handling hits an internal server error", async () => {
    const project = await createTestDaemonProject();
    onTestFinished(async () => {
      await project.cleanup();
    });

    const daemon = await startTestDaemon(project, {
      extraEnv: {
        KSPEC_TEST_WS_FORCE_INTERNAL_ERROR_REQUEST_ID: "trigger-1011",
      },
      registerCleanup: (stop) => {
        onTestFinished(async () => {
          await stop();
        });
      },
    });

    const { ws } = await connectClient(daemon);
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
  });
});

// AC: @daemon-test-runtime-selection ac-runtime-matrix-parity
// AC: @daemon-test-runtime-selection ac-missing-optional-runtime-skips
// AC: @daemon-test-runtime-selection ac-runtime-degradation-assertions
// AC: @daemon-test-runtime-selection ac-explicit-runtime-only
// AC: @daemon-runtime-adapter ac-websocket-parity
// AC: @daemon-runtime-adapter ac-heartbeat-degradation
// AC: @daemon-test-mode-boundaries ac-full-process-tests-use-real-daemon
//
// Runtime parity for the WebSocket protocol. Node is required (the project's
// canonical runtime); Bun is optional and reported as skipped when absent so
// the suite does not fail generic Node coverage on machines without Bun.
describe("daemon websocket protocol — runtime parity", { timeout: 90_000 }, () => {
  const runtimes: Array<{ name: DaemonTestRuntime; required: boolean }> = [
    { name: "node", required: true },
    { name: "bun", required: false },
  ];

  for (const { name: runtimeName, required } of runtimes) {
    describe(`${runtimeName} runtime`, () => {
      let project: TestDaemonProject;
      let daemon: StartedTestDaemon;
      let runtimeAvailable = false;

      // Same hookTimeout widening as the parent describe — daemon cold-start
      // plus fixture copy can exceed Vitest's 10s default under shared-worker
      // load.
      beforeEach(async () => {
        runtimeAvailable = await isDaemonRuntimeAvailable(runtimeName);
        if (!runtimeAvailable) {
          if (required) {
            throw new Error(
              `Required daemon runtime "${runtimeName}" is not available on PATH`,
            );
          }
          // ac-missing-optional-runtime-skips — surface skip without failing
          // the generic Node coverage path on machines that lack Bun.
          console.log(`  ⊘ Skipping ${runtimeName} parity — runtime not installed`);
          return;
        }

        project = await createTestDaemonProject();
        daemon = await startTestDaemon(project, {
          runtime: runtimeName,
          registerCleanup: (stop) => {
            onTestFinished(async () => {
              await stop();
            });
          },
        });
      }, 60_000);

      afterEach(async () => {
        if (project) {
          await project.cleanup();
        }
      });

      // ac-runtime-matrix-parity — same connect/subscribe/broadcast behavior
      // exercised against each available runtime.
      it("connect, subscribe, and broadcast behave consistently", async () => {
        if (!runtimeAvailable) return;

        // Health endpoint advertises which runtime is in use.
        const health = (await (
          await fetch(`${daemon.apiUrl}/api/health`)
        ).json()) as { runtime: string; status: string };
        expect(health.runtime).toBe(runtimeName);
        expect(health.status).toBe("ok");

        const { ws, connected } = await connectClient(daemon);
        expect(connected.data.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

        const subscribeAck = await sendCommandAndWaitForAck(ws, {
          action: "subscribe",
          request_id: "parity-subscribe",
          payload: { topics: ["files:updates"] },
        });
        expect(subscribeAck).toMatchObject({
          ack: true,
          request_id: "parity-subscribe",
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

        const tasksYaml = join(project.kspecDir, "project.tasks.yaml");
        const original = readTestOutputSync(tasksYaml, "utf8");
        writeFileSync(
          tasksYaml,
          `${original}\n# parity-${runtimeName} ${Date.now()}\n`,
        );

        const broadcast = await broadcastPromise;
        expect(broadcast.topic).toBe("files:updates");
        expect(typeof broadcast.seq).toBe("number");
        expect(broadcast.seq).toBeGreaterThan(0);

        ws.close(1000, "parity complete");
        await waitForClose(ws);
      });

      // ac-runtime-degradation-assertions — Node lacks frame-level WebSocket
      // ping, so the daemon must log the documented heartbeat-degraded
      // warning at startup and the connection still stays open. Bun supports
      // frame-level ping and does NOT log this warning.
      it("logs documented heartbeat degradation behavior for the runtime", async () => {
        if (!runtimeAvailable) return;

        // The daemon emits the warning before readiness, so it lives in the
        // captured stdout/stderr tails by the time startTestDaemon resolves.
        const startupLog = `${daemon.stdoutTail()}\n${daemon.stderrTail()}`;
        const degradationMessage =
          "WebSocket heartbeat ping/pong is unavailable. Dead connection detection is disabled.";

        if (runtimeName === "node") {
          expect(startupLog).toContain(degradationMessage);
        } else {
          // Bun supports frame-level ping; the degradation warning must NOT
          // appear and the heartbeat is enabled normally.
          expect(startupLog).not.toContain(degradationMessage);
        }

        // ac-heartbeat-degradation: the connection remains open without
        // heartbeat enforcement when degraded — verify the WebSocket opens
        // and stays connected long enough to exchange a ping/ack regardless
        // of runtime.
        const { ws } = await connectClient(daemon);
        const ack = await sendCommandAndWaitForAck(ws, {
          action: "ping",
          request_id: "parity-ping",
          payload: {},
        });
        expect(ack.ack).toBe(true);
        expect(ack.success).toBe(true);
        ws.close(1000, "degradation check complete");
        await waitForClose(ws);
      });
    });
  }
});
