/**
 * Behavioral regression tests for the CLI-side `postDispatchEvent` helper
 * in `src/cli/dispatch-events.ts`. The helper fires a fire-and-forget POST
 * to `/api/agent/events` whenever a task state transition is committed
 * locally — it is the only CLI-side surface that talks to the daemon's
 * dispatch event ingest endpoint, so it must honour the centralised
 * `getRunningDaemonClient()` URL contract instead of re-deriving the URL
 * from a port number alone.
 *
 * Stand up an in-process recording HTTP server on a non-default loopback
 * (or bracketed IPv6) host, write daemon connection metadata pointing at
 * that endpoint, then call `postDispatchEvent` directly and assert the
 * recorded request uses the metadata-advertised URL — not 127.0.0.1.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */

import http from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { postDispatchEvent } from "../src/cli/dispatch-events.js";
import { cleanupTempDir, createTempDir } from "./helpers/cli.js";

interface RecordedRequest {
  host: string | null;
  method: string;
  url: string;
  body: string;
}

interface MockDaemon {
  server: http.Server;
  port: number;
  bindHost: string;
  requests: RecordedRequest[];
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

async function startMockDaemonOn(host: string): Promise<MockDaemon | null> {
  return new Promise((resolve) => {
    const requests: RecordedRequest[] = [];
    const server = http.createServer(async (req, res) => {
      const body = await readBody(req);
      requests.push({
        host: req.headers.host ?? null,
        method: req.method ?? "GET",
        url: req.url ?? "",
        body,
      });
      if (req.url === "/api/agent/events" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once("error", () => {
      try {
        server.close(() => resolve(null));
      } catch {
        resolve(null);
      }
    });
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => resolve(null));
        return;
      }
      resolve({ server, port: addr.port, bindHost: host, requests });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function probeHost(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => {
      try {
        probe.close(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
    probe.once("listening", () => probe.close(() => resolve(true)));
    try {
      probe.listen({ host, port: 0, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

function writeFakeDaemonState(
  configDir: string,
  metadata: Record<string, unknown>,
): void {
  mkdirSync(configDir, { recursive: true });
  // PID file holds the test process pid so PidFileManager.isDaemonRunning()
  // sees a live process. We are intentionally pretending the test process is
  // the daemon for the purpose of pid-liveness checks; the recording server
  // is a different listener but the URL came from metadata, not the pid.
  writeFileSync(join(configDir, "daemon.pid"), String(process.pid));
  writeFileSync(join(configDir, "daemon.connection.json"), JSON.stringify(metadata));
}

function expectedHostHeader(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

describe("postDispatchEvent posts /api/agent/events to the metadata-advertised api_url", () => {
  let homeDir: string;
  let configDir: string;
  let originalHome: string | undefined;
  let originalNoDaemon: string | undefined;
  let originalSessionId: string | undefined;
  let mock: MockDaemon | undefined;

  beforeEach(async () => {
    homeDir = await createTempDir("kspec-cli-task-event-home-");
    configDir = join(homeDir, ".config", "kspec");
    originalHome = process.env.HOME;
    originalNoDaemon = process.env.KSPEC_NO_DAEMON;
    originalSessionId = process.env.KSPEC_SESSION_ID;
    process.env.HOME = homeDir;
    delete process.env.KSPEC_NO_DAEMON;
    // postDispatchEvent suppresses itself when KSPEC_SESSION_ID is set.
    delete process.env.KSPEC_SESSION_ID;
  });

  afterEach(async () => {
    if (mock) {
      await closeServer(mock.server);
      mock = undefined;
    }
    process.env.HOME = originalHome!;
    if (originalNoDaemon === undefined) {
      delete process.env.KSPEC_NO_DAEMON;
    } else {
      process.env.KSPEC_NO_DAEMON = originalNoDaemon;
    }
    if (originalSessionId === undefined) {
      delete process.env.KSPEC_SESSION_ID;
    } else {
      process.env.KSPEC_SESSION_ID = originalSessionId;
    }
    await cleanupTempDir(homeDir);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  //
  // Default loopback baseline: metadata advertises 127.0.0.1 at an
  // ephemeral port. postDispatchEvent must POST /api/agent/events at that
  // exact endpoint, including the advertised port — proving the URL came
  // from metadata rather than a separate hardcoded `localhost`.
  it("posts /api/agent/events at the metadata-advertised 127.0.0.1 endpoint", async () => {
    mock = (await startMockDaemonOn("127.0.0.1")) ?? undefined;
    expect(mock).toBeDefined();
    const advertisedPort = mock!.port;

    writeFakeDaemonState(configDir, {
      pid: process.pid,
      port: advertisedPort,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: `http://127.0.0.1:${advertisedPort}`,
      ws_url: `ws://127.0.0.1:${advertisedPort}/ws`,
      runtime: "node",
    });

    await postDispatchEvent({
      taskId: "01TASKULIDFAKE0000000000000",
      taskRef: "@endpoint-event-task",
      fromStatus: "pending",
      toStatus: "in_progress",
      projectPath: homeDir,
    });

    expect(mock!.requests).toHaveLength(1);
    const req = mock!.requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/agent/events");
    expect(req.host).toBe(expectedHostHeader("127.0.0.1", advertisedPort));

    const parsed = JSON.parse(req.body) as {
      task_id: string;
      task_ref: string;
      from_status: string;
      to_status: string;
    };
    expect(parsed.task_id).toBe("01TASKULIDFAKE0000000000000");
    expect(parsed.task_ref).toBe("@endpoint-event-task");
    expect(parsed.from_status).toBe("pending");
    expect(parsed.to_status).toBe("in_progress");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  //
  // The metadata advertises a non-default loopback alias (127.0.0.2). On
  // Linux this address routes to loopback; on macOS / Windows it does not.
  // If postDispatchEvent re-derived `127.0.0.1`, the request would never
  // reach this server. The Host header is the strongest behavioural proof
  // that the URL came from metadata. Test skips when the alias is not
  // addressable.
  it("honors a non-default connect_host advertised by metadata", async () => {
    if (!(await probeHost("127.0.0.2"))) {
      console.log("  ⊘ Skipping test - 127.0.0.2 loopback alias not available");
      return;
    }
    mock = (await startMockDaemonOn("127.0.0.2")) ?? undefined;
    if (!mock) {
      console.log("  ⊘ Skipping test - mock daemon failed to start on 127.0.0.2");
      return;
    }
    const advertisedPort = mock.port;

    writeFakeDaemonState(configDir, {
      pid: process.pid,
      port: advertisedPort,
      bind_host: "0.0.0.0",
      connect_host: "127.0.0.2",
      api_url: `http://127.0.0.2:${advertisedPort}`,
      ws_url: `ws://127.0.0.2:${advertisedPort}/ws`,
      runtime: "node",
    });

    await postDispatchEvent({
      taskId: "01TASKULIDALIAS000000000000",
      taskRef: "@endpoint-alias-task",
      fromStatus: "in_progress",
      toStatus: "pending_review",
      projectPath: homeDir,
    });

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].method).toBe("POST");
    expect(mock.requests[0].url).toBe("/api/agent/events");
    // Host header reflects the URL the client actually called — a
    // request that hardcoded 127.0.0.1 would never reach this server.
    expect(mock.requests[0].host).toBe(`127.0.0.2:${advertisedPort}`);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  //
  // When metadata advertises a bracketed IPv6 api_url, postDispatchEvent
  // must call that bracketed URL verbatim — re-derived URLs would corrupt
  // the bracket syntax or pick a different host entirely.
  it("honors a bracketed IPv6 api_url advertised by metadata", async () => {
    if (!(await probeHost("::1"))) {
      console.log("  ⊘ Skipping test - IPv6 loopback (::1) not available");
      return;
    }
    mock = (await startMockDaemonOn("::1")) ?? undefined;
    if (!mock) {
      console.log("  ⊘ Skipping test - IPv6 server failed to start");
      return;
    }
    const advertisedPort = mock.port;

    writeFakeDaemonState(configDir, {
      pid: process.pid,
      port: advertisedPort,
      bind_host: "::1",
      connect_host: "::1",
      api_url: `http://[::1]:${advertisedPort}`,
      ws_url: `ws://[::1]:${advertisedPort}/ws`,
      runtime: "node",
    });

    await postDispatchEvent({
      taskId: "01TASKULIDIPV6000000000000",
      taskRef: "@endpoint-ipv6-task",
      fromStatus: "pending",
      toStatus: "in_progress",
      projectPath: homeDir,
    });

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].method).toBe("POST");
    expect(mock.requests[0].url).toBe("/api/agent/events");
    // The Host header includes the bracketed IPv6 literal verbatim,
    // proving the client used the bracketed api_url from metadata
    // rather than re-deriving (which would corrupt the bracket syntax).
    expect(mock.requests[0].host).toBe(`[::1]:${advertisedPort}`);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  //
  // KSPEC_SESSION_ID short-circuits postDispatchEvent before any HTTP work
  // — verifies the suppression contract still holds even when metadata is
  // present (otherwise dispatched agents would emit redundant events that
  // accumulate in the queue).
  it("does not call the daemon when KSPEC_SESSION_ID is set (dispatched agent)", async () => {
    mock = (await startMockDaemonOn("127.0.0.1")) ?? undefined;
    expect(mock).toBeDefined();
    const advertisedPort = mock!.port;

    writeFakeDaemonState(configDir, {
      pid: process.pid,
      port: advertisedPort,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: `http://127.0.0.1:${advertisedPort}`,
      ws_url: `ws://127.0.0.1:${advertisedPort}/ws`,
      runtime: "node",
    });
    process.env.KSPEC_SESSION_ID = "01SESSIONFAKE0000000000000";

    await postDispatchEvent({
      taskId: "01TASKULIDSKIP000000000000",
      taskRef: "@endpoint-skip-task",
      fromStatus: "pending",
      toStatus: "in_progress",
      projectPath: homeDir,
    });

    expect(mock!.requests).toHaveLength(0);
  });
});
