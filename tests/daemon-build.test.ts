import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

// Per-call fetch budget for the build smoke. Each request targets a freshly
// started local daemon, so a healthy response should land within a few hundred
// ms — 5s is generous headroom that still fails fast if the runtime stops
// responding mid-request. Without this bound the test would only break on the
// outer vitest timeout, hiding which probe hung and on which runtime.
const FETCH_TIMEOUT_MS = 5_000;

// Hard ceiling on `npm run build:daemon` so a wedged build cannot consume the
// full describe-level budget. The hot path completes in <1s; cold runs that
// fall through to `tsc` fit comfortably under 60s.
const BUILD_TIMEOUT_MS = 90_000;

interface CommandFailureContext {
  step: string;
  command: string;
  args: readonly string[];
  result: SpawnSyncReturns<string>;
}

// `spawnSync` populates `result.error` when the runtime times out (ETIMEDOUT)
// AND `result.signal` AND captures stdout/stderr up to the kill point. The
// previous shape returned only `result.error.message` for any non-null error,
// so the timeout path that this test was hardening against silently dropped
// the tails the diagnostic bundle exists to capture. Always emit the tails;
// classify the failure header based on whichever signals are present.
function describeCommandFailure(ctx: CommandFailureContext): string {
  const { step, command, args, result } = ctx;
  const head = `${step}: \`${command} ${args.join(" ")}\``;
  const errorCode =
    result.error && typeof (result.error as NodeJS.ErrnoException).code === "string"
      ? (result.error as NodeJS.ErrnoException).code
      : undefined;
  let summary: string;
  if (errorCode === "ETIMEDOUT" || (result.error && result.signal)) {
    const reason = result.error?.message ?? "spawn timeout";
    summary =
      `timed out (spawnSync timeout=${BUILD_TIMEOUT_MS}ms reached, ` +
      `signal=${result.signal ?? "<none>"}, code=${errorCode ?? "<none>"}): ${reason}`;
  } else if (result.error) {
    summary = `threw before completion (code=${errorCode ?? "<none>"}): ${result.error.message}`;
  } else if (result.signal) {
    summary =
      `was killed by signal ${result.signal} ` +
      `(spawnSync timeout=${BUILD_TIMEOUT_MS}ms reached)`;
  } else {
    summary = `exited with status ${String(result.status)}`;
  }
  return (
    `${head} ${summary}.\n` +
    `stdout-tail=\n${tail(result.stdout)}\n` +
    `stderr-tail=\n${tail(result.stderr)}`
  );
}

function tail(text: string | null | undefined, lines = 40): string {
  if (!text) return "<empty>";
  const split = text.split(/\r?\n/);
  return split.slice(Math.max(0, split.length - lines)).join("\n");
}

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string> } = {},
) {
  return spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: options.timeoutMs ?? BUILD_TIMEOUT_MS,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
}

interface BoundedFetchOptions {
  step: string;
  runtime: DaemonTestRuntime;
  daemon: StartedTestDaemon;
}

async function boundedFetch(
  url: string,
  { step, runtime, daemon }: BoundedFetchOptions,
): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${step} on runtime=${runtime} (${url}) failed within ${FETCH_TIMEOUT_MS}ms: ${message}\n` +
        `daemon-stdout-tail=\n${tail(daemon.stdoutTail())}\n` +
        `daemon-stderr-tail=\n${tail(daemon.stderrTail())}`,
      { cause: error },
    );
  }
}

async function readBoundedText(
  response: Response,
  { step, runtime, daemon }: BoundedFetchOptions,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${step} body read on runtime=${runtime} failed: ${message}\n` +
        `daemon-stdout-tail=\n${tail(daemon.stdoutTail())}\n` +
        `daemon-stderr-tail=\n${tail(daemon.stderrTail())}`,
      { cause: error },
    );
  }
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

describe("describeCommandFailure diagnostics", () => {
  // Regression: the prior shape returned only `result.error.message` when
  // `result.error` was set, so the spawnSync-timeout path that this test was
  // hardening (error.code='ETIMEDOUT' AND signal='SIGTERM' AND captured
  // stdout/stderr) silently dropped the tails the diagnostic exists to capture.
  it("includes stdout and stderr tails when spawnSync hits its timeout", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "console.log('marker-stdout-line'); console.error('marker-stderr-line'); setTimeout(() => {}, 30000);",
      ],
      { encoding: "utf8", timeout: 200 },
    );

    // Sanity-check Node's documented spawnSync timeout shape: error with
    // code='ETIMEDOUT', a kill signal, and preserved captured output. If
    // this assertion ever fails, the regression below would be moot.
    const errorCode =
      result.error && typeof (result.error as NodeJS.ErrnoException).code === "string"
        ? (result.error as NodeJS.ErrnoException).code
        : undefined;
    expect(errorCode).toBe("ETIMEDOUT");
    expect(result.signal).toBeTruthy();
    expect(result.stdout).toContain("marker-stdout-line");
    expect(result.stderr).toContain("marker-stderr-line");

    const message = describeCommandFailure({
      step: "diagnostic-regression",
      command: process.execPath,
      args: ["-e", "<inline>"],
      result,
    });

    expect(message).toContain("diagnostic-regression");
    expect(message).toContain("timed out");
    expect(message).toContain("ETIMEDOUT");
    expect(message).toContain("stdout-tail=");
    expect(message).toContain("marker-stdout-line");
    expect(message).toContain("stderr-tail=");
    expect(message).toContain("marker-stderr-line");
  });
});

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
    // Build into an isolated output root: rewriting the live dist/daemon/
    // from inside the suite would race against concurrently running tests
    // that spawn the daemon (the dist-rewrite flake class the build/test
    // lock exists to prevent — the lock itself refuses in-suite builds that
    // target the real dist/).
    const isolatedDistRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kspec-daemon-build-"));
    onTestFinished(() => {
      fs.rmSync(isolatedDistRoot, { recursive: true, force: true });
    });

    const command = "npm";
    const args = ["run", "build:daemon"];
    const result = runCommand(command, args, {
      env: { KSPEC_DAEMON_BUILD_DIST_ROOT: isolatedDistRoot },
    });
    if (result.status !== 0 || result.signal || result.error) {
      throw new Error(
        describeCommandFailure({ step: "build:daemon (artifact emit)", command, args, result }),
      );
    }
    expect(result.stderr).not.toContain("error");
    expect(fs.existsSync(path.join(isolatedDistRoot, "daemon", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(isolatedDistRoot, "daemon", "entity-cache.js"))).toBe(true);
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
    // No in-test rebuild: the runner's pre-test build hook guarantees
    // dist/daemon/ is current (mtime staleness check against all build
    // inputs), and rebuilding the live dist/ mid-suite is exactly the race
    // the build/test lock forbids. The artifacts exercised here are produced
    // by the same scripts/build-daemon.cjs pipeline the previous in-test
    // build ran; the build's own emit behavior is covered by the isolated
    // artifact-emit test above. startTestDaemon() fails with an actionable
    // error if the entry is missing.
    const candidateRuntimes: DaemonTestRuntime[] = ["node", "bun"];
    for (const runtimeName of candidateRuntimes) {
      const isRequired = runtimeName === "node";
      const available = await isDaemonRuntimeAvailable(runtimeName);
      if (!available) {
        if (isRequired) {
          throw new Error(`Required daemon runtime "${runtimeName}" is not available on PATH`);
        }
        // ac-missing-optional-runtime-skips — surface missing optional runtime
        // without failing the generic Node coverage path.
        console.log(`  ⊘ Skipping ${runtimeName} build smoke — runtime not installed`);
        continue;
      }

      project = await createTestDaemonProject({ skipFixtures: true, webUiDir: null });
      project.webUiDir = makeRuntimeWebUiDir(project.tempDir);

      daemon = await startTestDaemon(project, {
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
      });
      const fetchCtx = { runtime: runtimeName, daemon } as const;

      const healthResponse = await boundedFetch(`${daemon.apiUrl}/api/health`, {
        ...fetchCtx,
        step: "health probe",
      });
      expect(healthResponse.status).toBe(200);
      const healthBody = JSON.parse(
        await readBoundedText(healthResponse, { ...fetchCtx, step: "health probe" }),
      ) as { runtime: string; status: string };
      expect(healthBody.status).toBe("ok");
      expect(healthBody.runtime).toBe(runtimeName);

      const spaResponse = await boundedFetch(`${daemon.apiUrl}/tasks`, {
        ...fetchCtx,
        step: "spa route",
      });
      expect(spaResponse.status).toBe(200);
      expect(spaResponse.headers.get("content-type")).toContain("text/html");
      expect(await readBoundedText(spaResponse, { ...fetchCtx, step: "spa route" })).toContain(
        "runtime-ui",
      );

      const assetResponse = await boundedFetch(`${daemon.apiUrl}/_app/immutable/entry/start.js`, {
        ...fetchCtx,
        step: "spa asset",
      });
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-type")).toContain("javascript");
      expect(await readBoundedText(assetResponse, { ...fetchCtx, step: "spa asset" })).toContain(
        'console.log("runtime-ui")',
      );

      const faviconResponse = await boundedFetch(`${daemon.apiUrl}/favicon.ico`, {
        ...fetchCtx,
        step: "favicon.ico",
      });
      expect(faviconResponse.status).toBe(200);
      expect(faviconResponse.headers.get("content-type")).toContain("image/");
      expect(await readBoundedText(faviconResponse, { ...fetchCtx, step: "favicon.ico" })).toBe(
        "ico",
      );

      const favicon32Response = await boundedFetch(`${daemon.apiUrl}/favicon-32.png`, {
        ...fetchCtx,
        step: "favicon-32.png",
      });
      expect(favicon32Response.status).toBe(200);
      expect(favicon32Response.headers.get("content-type")).toContain("image/png");
      expect(
        await readBoundedText(favicon32Response, { ...fetchCtx, step: "favicon-32.png" }),
      ).toBe("png32");

      const favicon192Response = await boundedFetch(`${daemon.apiUrl}/favicon-192.png`, {
        ...fetchCtx,
        step: "favicon-192.png",
      });
      expect(favicon192Response.status).toBe(200);
      expect(favicon192Response.headers.get("content-type")).toContain("image/png");
      expect(
        await readBoundedText(favicon192Response, { ...fetchCtx, step: "favicon-192.png" }),
      ).toBe("png192");

      await daemon.stop();
      await project.cleanup();
      project = null;
      daemon = null;
    }
  });
});
