/**
 * Mock daemon server for E2E proxy routing tests.
 *
 * Runs as a child process to avoid blocking the vitest event loop
 * (spawnSync in the kspec() test helper blocks the parent, so an
 * in-process server can't accept connections during test execution).
 *
 * Usage:
 *   node tests/helpers/mock-daemon.cjs [--mode normal|error|hang]
 *
 * Writes port to stdout on startup, then serves on that port.
 * Modes:
 *   normal — responds to health/projects/command normally
 *   error  — command endpoint returns non-zero exit code
 *   hang   — command endpoint never responds (for timeout tests)
 */

const http = require("http");

const mode = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "normal";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1`);
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname === "/api/projects" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "registered" }));
      return;
    }

    if (url.pathname === "/api/command" && req.method === "POST") {
      if (mode === "hang") {
        // Never respond — simulates timeout
        return;
      }

      const parsed = JSON.parse(body);

      if (mode === "error") {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          stdout: "",
          stderr: "error: not found\n",
          exitCode: 3,
        }));
        return;
      }

      // normal mode
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        stdout: `proxied: ${parsed.command}\n`,
        stderr: "",
        exitCode: 0,
      }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  // Signal port to parent via stdout
  process.stdout.write(String(port) + "\n");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
