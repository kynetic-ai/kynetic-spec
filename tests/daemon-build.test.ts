import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  initGitRepo,
  setupTempFixtures,
  waitForStartup,
} from "./helpers/cli.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");
const daemonEntry = path.join(projectRoot, "dist", "daemon", "index.js");

let bunAvailable = false;
try {
  execSync("which bun", { stdio: "pipe" });
  bunAvailable = true;
} catch {
  console.log("⊘ Bun runtime not available - skipping bun daemon startup smoke");
}

function runCommand(command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate ephemeral port")));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForDaemonHealth(
  baseUrl: string,
  child: ChildProcess,
  stderrBuffer: () => string,
): Promise<void> {
  await waitForStartup(
    `daemon health endpoint at ${baseUrl}`,
    async () => {
      if (child.exitCode !== null) {
        return {
          ok: false,
          details: `process exited with code ${child.exitCode}: ${stderrBuffer() || "<no stderr>"}`,
        };
      }

      try {
        const response = await fetch(`${baseUrl}/api/health`);
        const body = await response.text();
        return {
          ok: response.ok && body.includes('"status":"ok"'),
          details: `status=${response.status} body=${body || "<empty>"}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, details: `fetch error=${message}` };
      }
    },
    { timeoutMs: 15_000, intervalMs: 100 },
  );
}

async function stopDaemon(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 10_000),
    ),
  ]);
}

describe("daemon build pipeline", () => {
  let tempDir: string;
  let child: ChildProcess | null = null;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    fs.mkdirSync(path.join(tempDir, "test-web-ui", "_app", "immutable", "entry"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempDir, "test-web-ui", "index.html"),
      '<!doctype html><html><body>runtime-ui<script type="module" src="/_app/immutable/entry/start.js"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(tempDir, "test-web-ui", "_app", "immutable", "entry", "start.js"),
      'console.log("runtime-ui");\n',
    );
    fs.writeFileSync(path.join(tempDir, "test-web-ui", "favicon.ico"), "ico");
    fs.writeFileSync(path.join(tempDir, "test-web-ui", "favicon-32.png"), "png32");
    fs.writeFileSync(path.join(tempDir, "test-web-ui", "favicon-192.png"), "png192");
  });

  afterEach(async () => {
    await stopDaemon(child);
    child = null;
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-runtime-adapter ac-runtime-selection
  it("build:daemon emits compiled JavaScript artifacts", () => {
    const result = runCommand("npm", ["run", "build:daemon"]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("error");
    expect(fs.existsSync(daemonEntry)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "dist", "daemon", "entity-cache.js"))).toBe(true);
  });

  // AC: @daemon-runtime-adapter ac-runtime-selection
  // AC: @daemon-runtime-adapter ac-http-parity
  it("compiled daemon entrypoint starts and serves health checks and SPA routes under node and bun", async () => {
    const buildResult = runCommand("npm", ["run", "build:daemon"]);
    expect(buildResult.status).toBe(0);

    const runtimes = [
      { command: "node", envVar: "NODE_ENV" },
      ...(bunAvailable ? [{ command: "bun", envVar: "BUN_ENV" }] : []),
    ];

    for (const runtime of runtimes) {
      const isolatedHome = await createIsolatedKspecHome(tempDir, `.home-${runtime.command}`);
      const port = await getAvailablePort();
      let stderr = "";

      child = spawn(
        runtime.command,
        [daemonEntry, "--port", String(port), "--kspec-dir", path.join(tempDir, ".kspec")],
        {
          cwd: tempDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            ...isolatedHome.env,
            WEB_UI_DIR: path.join(tempDir, "test-web-ui"),
            KSPEC_DAEMON_RUNTIME: runtime.command,
            [runtime.envVar]: "test",
          },
        },
      );

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      await waitForDaemonHealth(`http://localhost:${port}`, child, () => stderr);

      const response = await fetch(`http://localhost:${port}/api/health`);
      expect(response.status).toBe(200);
      const healthBody = (await response.json()) as { runtime: string; status: string };
      expect(healthBody.status).toBe("ok");
      // AC: @daemon-runtime-adapter ac-runtime-health
      expect(healthBody.runtime).toBe(runtime.command);
      const spaResponse = await fetch(`http://localhost:${port}/tasks`);
      expect(spaResponse.status).toBe(200);
      expect(spaResponse.headers.get("content-type")).toContain("text/html");
      expect(await spaResponse.text()).toContain("runtime-ui");
      const assetResponse = await fetch(`http://localhost:${port}/_app/immutable/entry/start.js`);
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-type")).toContain("javascript");
      expect(await assetResponse.text()).toContain('console.log("runtime-ui")');
      const faviconResponse = await fetch(`http://localhost:${port}/favicon.ico`);
      expect(faviconResponse.status).toBe(200);
      expect(faviconResponse.headers.get("content-type")).toContain("image/");
      expect(await faviconResponse.text()).toBe("ico");
      const favicon32Response = await fetch(`http://localhost:${port}/favicon-32.png`);
      expect(favicon32Response.status).toBe(200);
      expect(favicon32Response.headers.get("content-type")).toContain("image/png");
      expect(await favicon32Response.text()).toBe("png32");
      const favicon192Response = await fetch(`http://localhost:${port}/favicon-192.png`);
      expect(favicon192Response.status).toBe(200);
      expect(favicon192Response.headers.get("content-type")).toContain("image/png");
      expect(await favicon192Response.text()).toBe("png192");
      await stopDaemon(child);
      child = null;
    }
  });
});
