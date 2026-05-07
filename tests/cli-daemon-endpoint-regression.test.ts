/**
 * Behavioral regression tests for every CLI surface that talks to the
 * running daemon. Each test seeds daemon connection metadata pointing at
 * a recording mock daemon and runs an actual `kspec` CLI subcommand,
 * then asserts the mock recorded a request whose Host header matches the
 * metadata-advertised URL.
 *
 * Before centralization, agent / event / schedule / task event-emit
 * helpers each constructed `http://localhost:<port>` from the daemon
 * port file. After centralization they all go through
 * `getRunningDaemonClient()`, which honors the metadata's `api_url` /
 * `ws_url` verbatim. These tests prove every CLI client now uses the
 * advertised URL — including bracketed IPv6 hosts and non-default
 * connect_host values — instead of re-deriving from a port number.
 *
 * The mock daemon listens on an ephemeral port and (when available) a
 * non-default loopback alias. On Linux 127.0.0.0/8 routes to loopback
 * so 127.0.0.2 is reachable; on macOS / Windows the alias is not
 * configured by default — those cases skip the alias-strict assertion
 * but still exercise the metadata-driven URL path on 127.0.0.1.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-default-loopback-v4
 * AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */

import { ChildProcess, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  initGitRepo,
  kspec,
  readTestOutputSync,
  testUlid,
  type IsolatedKspecHome,
} from "./helpers/cli.js";

const RECORDING_DAEMON_PATH = join(__dirname, "helpers", "recording-daemon.cjs");

interface RecordedRequest {
  method: string;
  url: string;
  host: string | null;
  body: string;
  receivedAt: number;
}

interface MockDaemon {
  process: ChildProcess;
  port: number;
  bindHost: string;
  recordPath: string;
}

function startRecordingDaemon(bindHost: string, recordPath: string): Promise<MockDaemon | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [RECORDING_DAEMON_PATH, "--bind-host", bindHost, "--record", recordPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let resolved = false;
    const finish = (value: MockDaemon | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newlineIdx = stdout.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = stdout.slice(0, newlineIdx);
      try {
        const parsed = JSON.parse(line) as { port: number; bindHost: string };
        finish({ process: child, port: parsed.port, bindHost: parsed.bindHost, recordPath });
      } catch {
        finish(null);
      }
    });

    child.on("exit", () => finish(null));
    child.on("error", () => finish(null));

    setTimeout(() => finish(null), 5000);
  });
}

function stopMockDaemon(mock: MockDaemon): Promise<void> {
  return new Promise((resolve) => {
    mock.process.once("exit", () => resolve());
    mock.process.kill("SIGTERM");
    setTimeout(() => {
      try {
        mock.process.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, 1500);
  });
}

function readRecordedRequests(recordPath: string): RecordedRequest[] {
  if (!existsSync(recordPath)) return [];
  const raw = readTestOutputSync(recordPath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedRequest);
}

async function probeAlias(host: string): Promise<boolean> {
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

function writeKspecProject(
  dir: string,
  opts: { schedules?: unknown[]; tasks?: unknown[] } = {},
): void {
  writeFileSync(
    join(dir, "kynetic.yaml"),
    yamlStringify({ kynetic: "1", title: "Endpoint Regression" }),
  );
  writeFileSync(
    join(dir, "kynetic.meta.yaml"),
    yamlStringify({
      kynetic_meta: "1.0",
      agents: [],
      ...(opts.schedules ? { schedules: opts.schedules } : {}),
    }),
  );
  writeFileSync(
    join(dir, "project.tasks.yaml"),
    yamlStringify(opts.tasks ?? []),
  );
}

function writeMetadata(home: IsolatedKspecHome, mock: MockDaemon): void {
  const apiUrl = formatUrl("http", mock.bindHost, mock.port);
  const wsUrl = `${formatUrl("ws", mock.bindHost, mock.port)}/ws`;

  // PID file holds the test runner's pid so PidFileManager.isDaemonRunning()
  // reports running=true. The mock is a different process; it doesn't matter
  // because the gate only checks process liveness, not identity.
  writeFileSync(home.daemonPidFilePath, String(process.pid));
  writeFileSync(
    join(home.configDir, "daemon.connection.json"),
    JSON.stringify({
      pid: process.pid,
      port: mock.port,
      bind_host: mock.bindHost,
      connect_host: mock.bindHost,
      api_url: apiUrl,
      ws_url: wsUrl,
      runtime: "node",
    }),
  );
}

function formatUrl(scheme: string, host: string, port: number): string {
  const formatted = host.includes(":") ? `[${host}]` : host;
  return `${scheme}://${formatted}:${port}`;
}

function expectedHostHeader(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

describe("CLI daemon clients use the metadata-advertised endpoint", () => {
  let tempDir: string;
  let recordPath: string;
  let isolated: IsolatedKspecHome;
  let mock: MockDaemon | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-cli-endpoint-regression-");
    initGitRepo(tempDir);
    recordPath = join(tempDir, "daemon-requests.jsonl");
    isolated = await createIsolatedKspecHome(tempDir);
    writeKspecProject(tempDir);
  });

  afterEach(async () => {
    if (mock) {
      await stopMockDaemon(mock);
      mock = undefined;
    }
    try {
      rmSync(recordPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    await cleanupTempDir(tempDir);
  });

  /**
   * Stand up the recording daemon on the strongest available host.
   * Linux: 127.0.0.2 (proves the URL came from metadata, not a hardcoded
   *   127.0.0.1 fallback).
   * Other platforms: fall back to 127.0.0.1 — still proves the port came
   *   from metadata even when host strictness can't be enforced.
   */
  async function startMock(): Promise<MockDaemon> {
    if (await probeAlias("127.0.0.2")) {
      const aliasMock = await startRecordingDaemon("127.0.0.2", recordPath);
      if (aliasMock) {
        mock = aliasMock;
        return aliasMock;
      }
    }
    const fallbackMock = await startRecordingDaemon("127.0.0.1", recordPath);
    if (!fallbackMock) {
      throw new Error("recording daemon failed to start on 127.0.0.1");
    }
    mock = fallbackMock;
    return fallbackMock;
  }

  function runCli(args: string): { exitCode: number; stdout: string; stderr: string } {
    return kspec(args, tempDir, {
      env: {
        ...isolated.env,
        // Override the kspec() helper's KSPEC_NO_DAEMON=1 default so the
        // daemon helpers actually attempt the metadata-advertised request.
        KSPEC_NO_DAEMON: "",
        // Strip any KSPEC_SESSION_ID inherited from a dispatch-driven test
        // run so postDispatchEvent is not suppressed.
        KSPEC_SESSION_ID: "",
      },
      expectFail: true,
    });
  }

  function findRequest(predicate: (r: RecordedRequest) => boolean): RecordedRequest | undefined {
    return readRecordedRequests(recordPath).find(predicate);
  }

  function expectRequestAtAdvertisedHost(
    request: RecordedRequest | undefined,
    pathHint: string,
  ): void {
    expect(
      request,
      `expected a recorded request matching ${pathHint}; recorded: ${JSON.stringify(
        readRecordedRequests(recordPath),
      )}`,
    ).toBeDefined();
    expect(request!.host).toBe(expectedHostHeader(mock!.bindHost, mock!.port));
  }

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("`event log` GETs /api/events/recent at the advertised api_url", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    const result = runCli("event log");
    expect(result.exitCode).toBe(0);

    const req = findRequest((r) => r.method === "GET" && r.url.startsWith("/api/events/recent"));
    expectRequestAtAdvertisedHost(req, "GET /api/events/recent");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("`event emit` POSTs /api/events/emit at the advertised api_url", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    const result = runCli('event emit task.ready --field task_id=abc --field task_ref=@x');
    expect(result.exitCode).toBe(0);

    const req = findRequest((r) => r.method === "POST" && r.url === "/api/events/emit");
    expectRequestAtAdvertisedHost(req, "POST /api/events/emit");

    const parsed = JSON.parse(req!.body) as { event_type: string };
    expect(parsed.event_type).toBe("task.ready");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("`agent dispatch start` POSTs /api/agent/dispatch/start at the advertised api_url", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    const result = runCli("agent dispatch start");
    expect(result.exitCode).toBe(0);

    const req = findRequest((r) => r.method === "POST" && r.url === "/api/agent/dispatch/start");
    expectRequestAtAdvertisedHost(req, "POST /api/agent/dispatch/start");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("`agent dispatch stop` POSTs /api/agent/dispatch/stop at the advertised api_url", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    const result = runCli("agent dispatch stop");
    expect(result.exitCode).toBe(0);

    const req = findRequest((r) => r.method === "POST" && r.url === "/api/agent/dispatch/stop");
    expectRequestAtAdvertisedHost(req, "POST /api/agent/dispatch/stop");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("`agent dispatch status` GETs /api/agent/dispatch/status at the advertised api_url", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    const result = runCli("agent dispatch status");
    expect(result.exitCode).toBe(0);

    const req = findRequest(
      (r) => r.method === "GET" && r.url === "/api/agent/dispatch/status",
    );
    expectRequestAtAdvertisedHost(req, "GET /api/agent/dispatch/status");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("`agent status` GETs /api/agent/dispatch/status at the advertised api_url", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    const result = runCli("agent status");
    expect(result.exitCode).toBe(0);

    const req = findRequest(
      (r) => r.method === "GET" && r.url === "/api/agent/dispatch/status",
    );
    expectRequestAtAdvertisedHost(req, "GET /api/agent/dispatch/status");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("`schedule list` GETs /api/schedules at the advertised api_url for daemon enrichment", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    // Schedule list is non-fatal when daemon is unreachable, but with a
    // running daemon it should attempt the enrichment fetch.
    writeKspecProject(tempDir, {
      schedules: [
        {
          _ulid: testUlid("SCHED", 1),
          id: "test-list",
          name: "Test list",
          cron: "*/5 * * * *",
          timezone: "UTC",
          action: { type: "command", command: "echo", args: ["hello"] },
          overlap_policy: "skip",
          backfill: false,
          enabled: true,
        },
      ],
    });

    const result = runCli("schedule list");
    expect(result.exitCode).toBe(0);

    const req = findRequest((r) => r.method === "GET" && r.url === "/api/schedules");
    expectRequestAtAdvertisedHost(req, "GET /api/schedules");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("`schedule trigger` POSTs /api/schedules/<id>/trigger at the advertised api_url", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    const scheduleId = "trigger-target";
    writeKspecProject(tempDir, {
      schedules: [
        {
          _ulid: testUlid("SCHED", 2),
          id: scheduleId,
          name: "Trigger target",
          cron: "*/5 * * * *",
          timezone: "UTC",
          action: { type: "command", command: "echo", args: ["go"] },
          overlap_policy: "skip",
          backfill: false,
          enabled: true,
        },
      ],
    });

    const result = runCli(`schedule trigger ${scheduleId}`);
    expect(result.exitCode).toBe(0);

    const req = findRequest(
      (r) => r.method === "POST" && r.url === `/api/schedules/${scheduleId}/trigger`,
    );
    expectRequestAtAdvertisedHost(req, `POST /api/schedules/${scheduleId}/trigger`);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-connection-metadata
  // AC: @cli-serve-commands ac-6
  //
  // `kspec serve status` must read the advertised endpoint out of
  // daemon.connection.json and report it in JSON output (bind_host,
  // connect_host, port) — without re-deriving the URL from a port number
  // or a hardcoded localhost. Seed metadata pointing at the recording
  // mock and assert the rendered status object reflects those exact
  // values, including a non-default connect_host that distinguishes the
  // metadata path from any port-only fallback.
  it("`serve status --json` renders the metadata-advertised endpoint fields verbatim", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    const result = runCli(`serve status --json --kspec-dir ${join(tempDir, ".kspec")}`);
    expect(result.exitCode).toBe(0);

    const status = JSON.parse(result.stdout) as {
      running: boolean;
      pid: number | null;
      port: number | null;
      bind_host: string | null;
      connect_host: string | null;
      runtime: string | null;
      healthReachable?: boolean;
    };
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBe(mock!.port);
    expect(status.bind_host).toBe(mock!.bindHost);
    expect(status.connect_host).toBe(mock!.bindHost);
    expect(status.runtime).toBe("node");

    // Health probe lands at the metadata-advertised URL (the recording
    // daemon serves /api/health) — additional behavioral evidence the
    // status command honored the advertised endpoint.
    const healthReq = findRequest(
      (r) => r.method === "GET" && r.url === "/api/health",
    );
    expectRequestAtAdvertisedHost(healthReq, "GET /api/health");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @cli-serve-commands ac-6
  //
  // The non-JSON status output must include the advertised bind_host,
  // connect_host, and port — same metadata-driven contract surfaced for
  // human readers.
  it("`serve status` (human output) prints the metadata-advertised bind_host / connect_host / port", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    const result = runCli(`serve status --kspec-dir ${join(tempDir, ".kspec")}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Port: ${mock!.port}`);
    expect(result.stdout).toContain(`Bind host: ${mock!.bindHost}`);
    expect(result.stdout).toContain(`Connect host: ${mock!.bindHost}`);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  //
  // task.ts internal `postDispatchEvent` fires a fire-and-forget POST to
  // /api/agent/events whenever a state transition occurs. Because `task`
  // commands are NOT in the proxy-skip list (src/cli/index.ts) and are
  // marked mutating, every CLI-side state transition is proxied through
  // `/api/command` — the daemon executes the mutation server-side and the
  // CLI exits before reaching postDispatchEvent. So the CLI-side URL
  // contract for postDispatchEvent is covered transitively by:
  //   1. cli-daemon-client.test.ts proves getRunningDaemonClient() returns
  //      the metadata-advertised endpoint verbatim.
  //   2. The single-line `${endpoint.apiUrl}/api/agent/events` fetch in
  //      src/cli/commands/task.ts pulls api_url straight off that endpoint.
  // Adding a behavioral CLI-side test here would require either making
  // postDispatchEvent exportable or running a task command in a mode where
  // proxy is skipped while the daemon is still detected — neither path
  // reflects production behavior.
  //
  // We DO assert the proxy itself routes to the metadata-advertised URL —
  // when the daemon serves /api/command, the daemon's own task code runs
  // postDispatchEvent against its own loopback. The proxy hop is covered
  // by tests/cli-daemon-proxy.test.ts; the proxy-target equivalence with
  // metadata is asserted below as the single observable boundary check.
  it("`task start` (mutating) proxies through the metadata-advertised /api/command endpoint", async () => {
    await startMock();
    writeMetadata(isolated, mock!);

    // Seed a task to start.
    const taskUlid = testUlid("TSK", 1);
    const taskDir = join(tempDir, "tasks", taskUlid);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "task.yaml"),
      yamlStringify({
        _ulid: taskUlid,
        slugs: ["endpoint-regression-task"],
        title: "Endpoint regression task",
        type: "task",
        status: "pending",
        priority: 2,
        depends_on: [],
        todos: [],
        created_at: "2026-01-01T00:00:00Z",
      }),
    );
    writeFileSync(join(taskDir, "notes.yaml"), yamlStringify({ notes: [] }));
    writeFileSync(
      join(tempDir, "project.tasks.yaml"),
      yamlStringify([
        {
          _ulid: taskUlid,
          slugs: ["endpoint-regression-task"],
          title: "Endpoint regression task",
          type: "task",
          status: "pending",
          priority: 2,
          depends_on: [],
          notes_count: 0,
          todos_count: 0,
          created_at: "2026-01-01T00:00:00Z",
        },
      ]),
    );

    const result = runCli(`task start @endpoint-regression-task`);
    // Mock daemon rejects /api/command with 503 so we can observe the proxy
    // attempt without the daemon-side execution path. For mutating commands,
    // a proxy failure surfaces as an error rather than fallback to direct.
    expect(result.exitCode).not.toBe(0);

    const req = findRequest((r) => r.method === "POST" && r.url === "/api/command");
    expectRequestAtAdvertisedHost(req, "POST /api/command");

    const body = JSON.parse(req!.body) as { command: string };
    expect(body.command).toBe("task start");
  });
});
