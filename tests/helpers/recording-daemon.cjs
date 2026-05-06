/**
 * Recording mock daemon for CLI endpoint regression tests.
 *
 * Runs as a child process so spawnSync in the kspec() test helper does not
 * block the event loop. Listens on a host:port the parent provides and
 * writes a JSON line with `{ port, bindHost }` to stdout once listening, so
 * the parent can build daemon.connection.json pointing at the same address.
 *
 * Each request is recorded into the file at $RECORD_FILE (one JSON object
 * per line) so the parent can read recorded requests after each CLI run
 * even though the mock is in a separate process.
 *
 * Usage:
 *   node recording-daemon.cjs --bind-host 127.0.0.2 --record /tmp/x.log
 *
 * Endpoints served:
 *   GET  /api/health                          → 200 {status:"ok",uptime:1}
 *   POST /api/projects                        → 200 {status:"ok"}
 *   GET  /api/events/recent                   → 200 {items:[],total:0}
 *   POST /api/events/emit                     → 200 {accepted:true,matches:[]}
 *   GET  /api/schedules                       → 200 {items:[]}
 *   POST /api/schedules/:id/trigger           → 200 {outcome:"executed",accepted:true,reason:null}
 *   GET  /api/agent/dispatch/status           → 200 {running:false,activeInvocations:0,queuedInvocations:0,invocations:[],queued:[]}
 *   POST /api/agent/dispatch/start            → 200 {started:true}
 *   POST /api/agent/dispatch/stop             → 200 {stopped:true}
 *   POST /api/agent/events                    → 200 {accepted:true}
 *   *                                          → 404
 */

const http = require("http");
const fs = require("fs");

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const bindHost = getArg("bind-host", "127.0.0.1");
const recordFile = getArg("record", null);

function record(entry) {
  if (!recordFile) return;
  try {
    fs.appendFileSync(recordFile, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Best-effort recording — never crash the mock daemon over an audit log
    // write failure during teardown.
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

  function ok(payload) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  if (path === "/api/health") {
    return ok({ status: "ok", uptime: 1, runtime: "node" });
  }
  if (path === "/api/projects") {
    return ok({ status: "ok" });
  }
  if (path === "/api/events/recent") {
    return ok({ items: [], total: 0 });
  }
  if (path === "/api/events/emit" && method === "POST") {
    return ok({ accepted: true, event_id: "01EVTRECORDED0000000000000", matched_hooks: [] });
  }
  if (path === "/api/schedules" && method === "GET") {
    return ok({ items: [] });
  }
  if (path.startsWith("/api/schedules/") && path.endsWith("/trigger") && method === "POST") {
    return ok({ outcome: "executed", accepted: true, reason: null });
  }
  if (path === "/api/agent/dispatch/status") {
    return ok({
      running: false,
      activeInvocations: 0,
      queuedInvocations: 0,
      invocations: [],
      queued: [],
    });
  }
  if (path === "/api/agent/dispatch/start" && method === "POST") {
    return ok({
      started: true,
      status: { running: true, activeInvocations: 0, queuedInvocations: 0 },
    });
  }
  if (path === "/api/agent/dispatch/stop" && method === "POST") {
    return ok({ stopped: true });
  }
  if (path === "/api/agent/events" && method === "POST") {
    return ok({ accepted: true });
  }
  if (path === "/api/command" && method === "POST") {
    // Always return a non-JSON 503 so the CLI proxy treats this as
    // a daemon-side failure: non-mutating commands fall back to direct
    // mode (where the inline command handlers exercise the
    // metadata-advertised URLs we're recording), and mutating commands
    // surface the proxy attempt at /api/command for verification.
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("recording mock daemon refuses /api/command");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(0, bindHost, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.stdout.write(JSON.stringify({ port, bindHost }) + "\n");
});

server.on("error", (err) => {
  process.stderr.write(`mock daemon error: ${err.message}\n`);
  process.exit(1);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
