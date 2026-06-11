/**
 * Unified mock daemon for CLI client tests.
 *
 * Used by tests/helpers/mock-daemon.ts when a test must exercise the real
 * kspec CLI via spawnSync — that call blocks the test runner event loop, so
 * an in-process http.createServer() cannot accept the CLI's requests. This
 * child process owns the listener instead.
 *
 * Usage:
 *   node tests/helpers/mock-daemon.cjs \
 *     [--bind-host 127.0.0.1] \
 *     [--mode normal|error|hang] \
 *     [--record /path/to/requests.jsonl] \
 *     [--health-command-dispatch '{"status":"degraded",...}']
 *
 * On `listening`, writes one JSON line `{"port":<n>,"bindHost":"<host>"}` to
 * stdout so the parent can build daemon.connection.json pointing at the
 * advertised endpoint. Each request is appended (best-effort, one JSON
 * object per line) to the record file when --record is provided.
 *
 * Modes apply to /api/command:
 *   normal — POST returns 200 with stdout/stderr/exitCode payload.
 *   error  — POST returns 422 with non-zero exitCode.
 *   hang   — POST never responds (timeout simulation).
 *   refuse — POST returns a non-JSON 503. Used by endpoint-regression
 *            tests that drive real CLI subcommands: non-mutating commands
 *            fall back to direct mode (so the inline command handlers
 *            exercise the metadata-advertised URLs we record), and
 *            mutating commands surface the proxy attempt at /api/command
 *            for verification.
 *
 * Other endpoints respond identically across modes so tests that only need
 * a reachable daemon (e.g. /api/health, /api/agent/events) work uniformly.
 */

const http = require("node:http");
const fs = require("node:fs");

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const bindHost = getArg("bind-host", "127.0.0.1");
const mode = getArg("mode", "normal");
const recordFile = getArg("record", null);

// Optional command_dispatch payload merged into the /api/health body so
// CLI tests can simulate a daemon reporting a wedged command dispatch.
const healthCommandDispatchRaw = getArg("health-command-dispatch", null);
let healthCommandDispatch = null;
if (healthCommandDispatchRaw !== null) {
  try {
    healthCommandDispatch = JSON.parse(healthCommandDispatchRaw);
  } catch {
    process.stderr.write("mock daemon: invalid --health-command-dispatch JSON\n");
    process.exit(2);
  }
}

// ── Test-only failure-injection seams ─────────────────────────────────
// These flags exist to drive the failure-path contract tests in
// tests/helpers/mock-daemon.test.ts. Production mock-daemon usage never
// passes them; the helper only relays them when a test sets the
// __testInjectArgs option on startMockDaemon.
//
// --break <mode>     Skip the metadata stdout line (no-stdout) or replace
//                    it with non-JSON garbage (malformed-stdout) while the
//                    HTTP listener stays bound. The helper must then stop
//                    the running child before returning failure.
// --pid-file <path>  Write the child pid to <path> synchronously at startup
//                    so the test can assert the child is no longer running
//                    after the helper returns.
// --env-record <path> Write a JSON snapshot of inherited daemon-control /
//                    session env keys to <path> at startup so the test can
//                    assert the helper sanitised the child's environment.
// --ignore-sigterm   Install no-op SIGTERM / SIGINT / SIGHUP handlers so the
//                    child keeps its listener bound after the helper's
//                    graceful kill. The bounded-stop contract test uses this
//                    to drive the SIGTERM → SIGKILL escalation path.
const breakMode = getArg("break", null);
const pidFile = getArg("pid-file", null);
const envRecordFile = getArg("env-record", null);
const ignoreSigterm = process.argv.includes("--ignore-sigterm");

if (breakMode !== null && breakMode !== "malformed-stdout" && breakMode !== "no-stdout") {
  process.stderr.write(`mock daemon: unknown break '${breakMode}'\n`);
  process.exit(2);
}

if (mode !== "normal" && mode !== "error" && mode !== "hang" && mode !== "refuse") {
  process.stderr.write(`mock daemon: unknown mode '${mode}'\n`);
  process.exit(2);
}

// Env-record snapshot is written before the listener binds so a malformed/
// timeout failure path still produces an observation file. The recorded
// keys are the union of the daemon-test ambient strip list and the
// dispatch/agent strip lists in tests/helpers/cli.ts so a single test can
// assert the helper sanitises both groups.
if (envRecordFile) {
  const TRACKED_KEYS = [
    "KSPEC_DAEMON_PID",
    "KSPEC_DAEMON_PORT",
    "KSPEC_DAEMON_HOST",
    "KSPEC_DAEMON_CONNECT_HOST",
    "KSPEC_DAEMON_RUNTIME",
    "KSPEC_DAEMON_API_URL",
    "KSPEC_DAEMON_WS_URL",
    "KSPEC_NO_DAEMON",
    "KSPEC_SESSION_ID",
    "KSPEC_RALPH_SESSION",
    "KSPEC_DISPATCH_CANONICAL_HEAD",
  ];
  const snapshot = {};
  for (const key of TRACKED_KEYS) {
    if (key in process.env) snapshot[key] = process.env[key];
  }
  try {
    fs.writeFileSync(envRecordFile, JSON.stringify(snapshot), "utf8");
  } catch {
    // Best-effort: never crash the mock daemon over a test seam write
    // failure. The test asserts on file presence and parses missing keys
    // as 'absent', so a write failure surfaces as a test assertion miss
    // rather than a silent pass.
  }
}

if (pidFile) {
  try {
    fs.writeFileSync(pidFile, String(process.pid), "utf8");
  } catch {
    // Same best-effort policy as env-record.
  }
}

function record(entry) {
  if (!recordFile) return;
  try {
    fs.appendFileSync(recordFile, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Best-effort: never crash the mock daemon over an audit log write
    // failure during teardown.
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function ok(res, payload) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  record({
    method: req.method,
    url: req.url,
    host: req.headers.host || null,
    body,
    receivedAt: Date.now(),
  });

  const url = new URL(req.url, `http://${req.headers.host || bindHost}`);
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/health") {
    return ok(res, {
      status: "ok",
      uptime: 1,
      runtime: "node",
      ...(healthCommandDispatch ? { command_dispatch: healthCommandDispatch } : {}),
    });
  }
  if (path === "/api/projects") {
    return ok(res, { status: "ok" });
  }
  if (path === "/api/events/recent") {
    return ok(res, { items: [], total: 0 });
  }
  if (path === "/api/events/emit" && method === "POST") {
    return ok(res, {
      accepted: true,
      event_id: "01EVTRECORDED0000000000000",
      matched_hooks: [],
    });
  }
  if (path === "/api/schedules" && method === "GET") {
    return ok(res, { items: [] });
  }
  if (path.startsWith("/api/schedules/") && path.endsWith("/trigger") && method === "POST") {
    return ok(res, { outcome: "executed", accepted: true, reason: null });
  }
  if (path === "/api/agent/dispatch/status") {
    return ok(res, {
      running: false,
      activeInvocations: 0,
      queuedInvocations: 0,
      invocations: [],
      queued: [],
    });
  }
  if (path === "/api/agent/dispatch/start" && method === "POST") {
    return ok(res, {
      started: true,
      status: { running: true, activeInvocations: 0, queuedInvocations: 0 },
    });
  }
  if (path === "/api/agent/dispatch/stop" && method === "POST") {
    return ok(res, { stopped: true });
  }
  if (path === "/api/agent/events" && method === "POST") {
    return ok(res, { accepted: true });
  }
  if (path === "/api/command" && method === "POST") {
    if (mode === "hang") {
      return; // never respond — simulates timeout
    }
    if (mode === "error") {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          stdout: "",
          stderr: "error: not found\n",
          exitCode: 3,
        }),
      );
      return;
    }
    if (mode === "refuse") {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("mock daemon refuses /api/command");
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      parsed = {};
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        stdout: `proxied: ${parsed.command || ""}\n`,
        stderr: "",
        exitCode: 0,
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(0, bindHost, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  if (breakMode === "no-stdout") {
    // Stay listening but never advertise the metadata line. The helper
    // must time out and stop this still-running child.
    return;
  }
  if (breakMode === "malformed-stdout") {
    // Write a non-JSON line so the helper's JSON.parse fails and triggers
    // its malformed-stdout failure path while this listener stays alive.
    process.stdout.write("not-json garbage\n");
    return;
  }
  process.stdout.write(JSON.stringify({ port, bindHost }) + "\n");
});

server.on("error", (err) => {
  process.stderr.write(`mock daemon error: ${err.message}\n`);
  process.exit(1);
});

if (ignoreSigterm) {
  // No-op signal handlers force the helper to escalate from SIGTERM to
  // SIGKILL. SIGKILL is uncatchable, so the child still terminates — but
  // only after the helper's graceful timer fires.
  process.on("SIGTERM", () => {
    /* swallow */
  });
  process.on("SIGINT", () => {
    /* swallow */
  });
  process.on("SIGHUP", () => {
    /* swallow */
  });
} else {
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}
