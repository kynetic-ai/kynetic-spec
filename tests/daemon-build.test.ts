import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import {
  createTestDaemonProject,
  isDaemonRuntimeAvailable,
  startTestDaemon,
  type DaemonTestRuntime,
  type StartedTestDaemon,
  type TestDaemonProject,
} from "./helpers/daemon.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const daemonEntry = path.join(projectRoot, "dist", "daemon", "index.js");

function runCommand(command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
}

function makeRuntimeWebUiDir(rootDir: string): string {
  const webUiDir = path.join(rootDir, "test-web-ui");
  fs.mkdirSync(path.join(webUiDir, "_app", "immutable", "entry"), { recursive: true });
  fs.writeFileSync(
    path.join(webUiDir, "index.html"),
    '<!doctype html><html><body>runtime-ui<script type="module" src="/_app/immutable/entry/start.js"></script></body></html>',
  );
  fs.writeFileSync(
    path.join(webUiDir, "_app", "immutable", "entry", "start.js"),
    'console.log("runtime-ui");\n',
  );
  fs.writeFileSync(path.join(webUiDir, "favicon.ico"), "ico");
  fs.writeFileSync(path.join(webUiDir, "favicon-32.png"), "png32");
  fs.writeFileSync(path.join(webUiDir, "favicon-192.png"), "png192");
  return webUiDir;
}

describe("daemon build pipeline", { timeout: 180_000 }, () => {
  let project: TestDaemonProject | null = null;
  let daemon: StartedTestDaemon | null = null;

  beforeEach(() => {
    project = null;
    daemon = null;
  });

  afterEach(async () => {
    if (project) {
      await project.cleanup();
    }
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
  // AC: @daemon-runtime-adapter ac-runtime-health
  // AC: @daemon-backed-test-fixture-contract ac-real-daemon-tests-use-shared-fixture
  // AC: @daemon-backed-test-fixture-contract ac-isolated-home-config
  // AC: @daemon-backed-test-fixture-contract ac-isolated-project-data
  // AC: @daemon-backed-test-fixture-contract ac-readiness-diagnostics
  // AC: @daemon-backed-test-fixture-contract ac-bounded-readiness
  // AC: @daemon-backed-test-fixture-contract ac-scoped-cleanup
  // AC: @daemon-backed-test-fixture-contract ac-no-ambient-daemon-control
  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  // AC: @daemon-test-endpoint-consistency ac-no-localhost-by-default
  // AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
  // AC: @daemon-test-runtime-selection ac-node-default
  // AC: @daemon-test-runtime-selection ac-runtime-matrix-parity
  // AC: @daemon-test-runtime-selection ac-missing-optional-runtime-skips
  // AC: @daemon-test-mode-boundaries ac-full-process-tests-use-real-daemon
  it("compiled daemon entrypoint starts and serves health checks and SPA routes under node and bun", async () => {
    const buildResult = runCommand("npm", ["run", "build:daemon"]);
    expect(buildResult.status).toBe(0);

    const candidateRuntimes: DaemonTestRuntime[] = ["node", "bun"];
    for (const runtimeName of candidateRuntimes) {
      const isRequired = runtimeName === "node";
      const available = await isDaemonRuntimeAvailable(runtimeName);
      if (!available) {
        if (isRequired) {
          throw new Error(
            `Required daemon runtime "${runtimeName}" is not available on PATH`,
          );
        }
        // ac-missing-optional-runtime-skips — surface missing optional runtime
        // without failing the generic Node coverage path.
        console.log(`  ⊘ Skipping ${runtimeName} build smoke — runtime not installed`);
        continue;
      }

      project = await createTestDaemonProject({ skipFixtures: true, webUiDir: null });
      project.webUiDir = makeRuntimeWebUiDir(project.tempDir);

      daemon = await startTestDaemon(
        project,
        {
          runtime: runtimeName,
          // The static-asset assertions below depend on routing, not on the
          // entity cache being warm. Use health-only readiness so the smoke
          // test stays focused on the build artifact integrity.
          readiness: { mode: "health" },
          extraEnv: {
            KSPEC_DAEMON_RUNTIME: runtimeName,
          },
          registerCleanup: (stop) => {
            onTestFinished(async () => {
              await stop();
            });
          },
        },
      );

      const healthResponse = await fetch(`${daemon.apiUrl}/api/health`);
      expect(healthResponse.status).toBe(200);
      const healthBody = (await healthResponse.json()) as { runtime: string; status: string };
      expect(healthBody.status).toBe("ok");
      expect(healthBody.runtime).toBe(runtimeName);

      const spaResponse = await fetch(`${daemon.apiUrl}/tasks`);
      expect(spaResponse.status).toBe(200);
      expect(spaResponse.headers.get("content-type")).toContain("text/html");
      expect(await spaResponse.text()).toContain("runtime-ui");

      const assetResponse = await fetch(`${daemon.apiUrl}/_app/immutable/entry/start.js`);
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-type")).toContain("javascript");
      expect(await assetResponse.text()).toContain('console.log("runtime-ui")');

      const faviconResponse = await fetch(`${daemon.apiUrl}/favicon.ico`);
      expect(faviconResponse.status).toBe(200);
      expect(faviconResponse.headers.get("content-type")).toContain("image/");
      expect(await faviconResponse.text()).toBe("ico");

      const favicon32Response = await fetch(`${daemon.apiUrl}/favicon-32.png`);
      expect(favicon32Response.status).toBe(200);
      expect(favicon32Response.headers.get("content-type")).toContain("image/png");
      expect(await favicon32Response.text()).toBe("png32");

      const favicon192Response = await fetch(`${daemon.apiUrl}/favicon-192.png`);
      expect(favicon192Response.status).toBe(200);
      expect(favicon192Response.headers.get("content-type")).toContain("image/png");
      expect(await favicon192Response.text()).toBe("png192");

      await daemon.stop();
      await project.cleanup();
      project = null;
      daemon = null;
    }
  });
});
