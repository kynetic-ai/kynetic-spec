/**
 * Tests for runner process invocation inputs.
 *
 * Covers @runner-process-invocation-inputs:
 *   - ac-existing-executable-reference-resolves
 *   - ac-runner-args-extend-acp-invocation
 *   - ac-runner-cwd-is-invocation-only
 *   - ac-invocation-diagnostics-identify-inputs
 *
 * All tests use temp project directories with fake executables / fake adapters
 * so nothing depends on the host filesystem layout or registered packages.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  preflightExecutable,
  preflightRunnerInvocation,
  resolveRunnerInvocation,
  RunnerResolutionError,
  type RunnerInvocation,
  type ResolveRunnerInvocationInput,
} from "../src/agents/runners.js";
import {
  findSecretArgIndices,
  mergeRunnerConfigs,
  SystemRunnerConfigSchema,
  type EffectiveRunnerRegistry,
  type SystemRunnerConfig,
} from "../src/agents/runner-config.js";
import { registerAdapter } from "../src/agents/adapters.js";
import type { Agent } from "../src/schema/meta.js";
import { cleanupTempDir, createTempDir, testUlid } from "./helpers/cli.js";

// ─── Adapter registration ────────────────────────────────────────────────────

/**
 * Register a fake adapter used by every test in this file. Tests that need
 * to confirm the registered adapter is untouched read it back after
 * resolution. registerAdapter is idempotent — re-registering with the same
 * id overwrites the prior entry, which makes the tests stable when run in
 * any order.
 */
const FAKE_ADAPTER_ID = "fake-process-test-adapter";
const FAKE_ADAPTER_COMMAND = "/usr/local/bin/fake-acp-original";
const FAKE_ADAPTER_ARGS = ["--original-arg"];

function registerFakeAdapter(): void {
  registerAdapter(FAKE_ADAPTER_ID, {
    command: FAKE_ADAPTER_COMMAND,
    args: [...FAKE_ADAPTER_ARGS],
    autoApproveArgs: ["--auto-approve"],
  });
}

registerFakeAdapter();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "process-test-agent",
    name: "Process Test Agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    ...overrides,
  };
}

function makeInput(overrides: Partial<ResolveRunnerInvocationInput>): ResolveRunnerInvocationInput {
  return {
    agent: makeAgent(),
    registry: { runners: {} },
    cwd: "/tmp/workspace",
    sessionId: testUlid("SESS"),
    autoApprove: false,
    env: {},
    ...overrides,
  };
}

function buildRegistry(system: SystemRunnerConfig | null): EffectiveRunnerRegistry {
  return mergeRunnerConfigs(null, system);
}

async function writeExecutable(filePath: string, contents = "#!/bin/sh\nexit 0\n"): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf-8");
  await fs.chmod(filePath, 0o755);
}

async function writeNonExecutableFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "not executable\n", "utf-8");
  await fs.chmod(filePath, 0o644);
}

// ─── AC: ac-existing-executable-reference-resolves ───────────────────────────

describe("runner.process.executable: command reference resolution", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-runner-process-exec-");
    registerFakeAdapter();
  });
  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("identifies the configured executable as the spawn command reference", async () => {
    const fakeExecutable = path.join(tempDir, "fake-acp");
    await writeExecutable(fakeExecutable);

    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { executable: fakeExecutable },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry }),
    );

    expect(contract.adapter.command).toBe(fakeExecutable);
    expect(contract.adapter.command).not.toBe(FAKE_ADAPTER_COMMAND);

    // Preflight should succeed because the file exists and is executable.
    await expect(preflightRunnerInvocation(contract)).resolves.toBeUndefined();
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("returns an unspawnable_command diagnostic when the configured executable is missing", async () => {
    const missingExecutable = path.join(tempDir, "no-such-file");
    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { executable: missingExecutable },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry }),
    );

    // The contract still identifies the configured command — preflight is the
    // step that decides whether it can be spawned.
    expect(contract.adapter.command).toBe(missingExecutable);

    let captured: RunnerResolutionError | null = null;
    try {
      await preflightRunnerInvocation(contract);
    } catch (err) {
      captured = err as RunnerResolutionError;
    }
    expect(captured).toBeInstanceOf(RunnerResolutionError);
    expect(captured!.reason).toBe("unspawnable_command");
    expect(captured!.message).toContain(missingExecutable);
    expect(captured!.details.unspawnable_reason).toBe("not_found");
    expect(captured!.details.command).toBe(missingExecutable);
    expect(captured!.details.runner).toBe("fake");
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("returns an unspawnable_command diagnostic when the file exists but is not executable", async () => {
    const notExecutable = path.join(tempDir, "not-executable");
    await writeNonExecutableFile(notExecutable);

    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { executable: notExecutable },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry }),
    );

    let captured: RunnerResolutionError | null = null;
    try {
      await preflightRunnerInvocation(contract);
    } catch (err) {
      captured = err as RunnerResolutionError;
    }
    expect(captured).toBeInstanceOf(RunnerResolutionError);
    expect(captured!.reason).toBe("unspawnable_command");
    // EACCES → not_executable; some platforms surface ENOENT for non-readable
    // entries instead. Either is acceptable so long as the diagnostic is
    // typed; we assert that the reason is one of the unspawnable subtypes.
    expect(["not_executable", "not_found"]).toContain(
      captured!.details.unspawnable_reason as string,
    );
  });

  it("does not preflight when the runner did not configure an executable", async () => {
    // No process.executable → resolver keeps the adapter's registered command.
    const registry = buildRegistry({
      runners: {
        fake: { kind: "acp_process", adapter: FAKE_ADAPTER_ID },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry }),
    );
    expect(contract.adapter.command).toBe(FAKE_ADAPTER_COMMAND);

    // preflightRunnerInvocation must be a no-op here even though the
    // adapter's registered command points at a path that does not exist on
    // disk. The fake adapter's command is never preflighted because no
    // runner-configured executable was supplied.
    await expect(preflightRunnerInvocation(contract)).resolves.toBeUndefined();
  });

  it("does not preflight on the implicit/legacy path", async () => {
    const agent = makeAgent({ adapter: FAKE_ADAPTER_ID });
    const contract = resolveRunnerInvocation(makeInput({ agent }));
    // Legacy path uses the registered adapter command verbatim — preflight
    // skips it because no runner contributed the command reference.
    expect(contract.runnerId).toBeNull();
    await expect(preflightRunnerInvocation(contract)).resolves.toBeUndefined();
  });
});

// ─── Bare-command preflight honors invocation env PATH ──────────────────────

/**
 * Runner-backed invocations spawn with `inheritParentEnv: false`, so the
 * child sees only the runner-composed env. Node's `child_process.spawn`
 * resolves bare commands against `options.env.PATH`, NOT the daemon's host
 * `process.env.PATH`. Preflight must mirror that lookup, or it will skip
 * valid runners (false negative) or pass invalid ones (false positive)
 * whenever the runner-scoped PATH differs from the host PATH.
 */
describe("preflightRunnerInvocation: bare command lookup uses invocation env PATH", () => {
  let runnerBin: string;
  let daemonBin: string;
  let originalPath: string | undefined;
  beforeEach(async () => {
    runnerBin = await createTempDir("kspec-runner-process-bin-");
    daemonBin = await createTempDir("kspec-runner-process-host-bin-");
    originalPath = process.env.PATH;
    registerFakeAdapter();
  });
  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await cleanupTempDir(runnerBin);
    await cleanupTempDir(daemonBin);
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("resolves a bare command via env.set.PATH when env.inherit is none", async () => {
    const bareName = "scoped-tool";
    await writeExecutable(path.join(runnerBin, bareName));
    // Daemon PATH does not contain the command, so the only way the
    // probe can find it is via the runner-scoped env.set.PATH.
    process.env.PATH = daemonBin;

    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { executable: bareName },
          env: { inherit: "none", set: { PATH: runnerBin } },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({
        agent: makeAgent({ runner: "fake" }),
        registry,
        hostEnv: { PATH: daemonBin },
      }),
    );
    expect(contract.inheritParentEnv).toBe(false);
    expect(contract.env.PATH).toBe(runnerBin);

    await expect(preflightRunnerInvocation(contract)).resolves.toBeUndefined();
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("fails preflight for a host-only bare command when the runner strips host PATH", async () => {
    // The bare command exists only in the daemon's process.env.PATH (under a
    // tempdir not in `_PATH_DEFPATH`). The runner uses env.inherit=none and
    // does not set PATH, so the contract env has no PATH key. Node spawn
    // would then resolve bare commands against the libc default path
    // (`/usr/bin:/bin` on POSIX) — neither of which contains this tempdir.
    // Preflight must report unspawnable_command so we never silently rely on
    // a host PATH leak.
    const bareName = "host-only-tool";
    await writeExecutable(path.join(daemonBin, bareName));
    process.env.PATH = daemonBin;

    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { executable: bareName },
          env: { inherit: "none" },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({
        agent: makeAgent({ runner: "fake" }),
        registry,
        // Even with the daemon's PATH containing the command, the
        // runner's inherit=none policy must scope the child to an empty
        // PATH.
        hostEnv: { PATH: daemonBin },
      }),
    );
    expect(contract.inheritParentEnv).toBe(false);
    expect(contract.env.PATH).toBeUndefined();

    let captured: RunnerResolutionError | null = null;
    try {
      await preflightRunnerInvocation(contract);
    } catch (err) {
      captured = err as RunnerResolutionError;
    }
    expect(captured).toBeInstanceOf(RunnerResolutionError);
    expect(captured!.reason).toBe("unspawnable_command");
    expect(captured!.details.unspawnable_reason).toBe("not_found");
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("uses inherited PATH from env.inherit=ambient via hostEnv snapshot", async () => {
    // env.inherit: ambient copies hostEnv into the contract env. The
    // contract env's PATH is then what Node consults at spawn — and what
    // preflight must consult. The daemon's process.env.PATH is unrelated.
    const bareName = "ambient-tool";
    await writeExecutable(path.join(runnerBin, bareName));
    process.env.PATH = daemonBin;

    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { executable: bareName },
          env: { inherit: "ambient" },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({
        agent: makeAgent({ runner: "fake" }),
        registry,
        hostEnv: { PATH: runnerBin },
      }),
    );
    expect(contract.env.PATH).toBe(runnerBin);

    await expect(preflightRunnerInvocation(contract)).resolves.toBeUndefined();
  });

  // Direct parity probes against `child_process.spawn`. These two tests pin
  // the distinction between "PATH absent from child env" (spawn falls back
  // to the libc `_PATH_DEFPATH` ≈ `/usr/bin:/bin`) and "PATH explicitly set
  // to empty" (spawn searches no segments). Earlier the preflight collapsed
  // both cases into "search nothing", rejecting commands the child could
  // actually spawn. The tests use `sh` because POSIX guarantees its presence
  // under both `/usr/bin` and `/bin`; they skip on Windows where the lookup
  // model differs.
  const isPosix = process.platform !== "win32";

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it.skipIf(!isPosix)(
    "preflight resolves a bare command via the libc default PATH when env.inherit=none and env.set.PATH is unset",
    async () => {
      // Sanity-check the parity claim against the real spawn first: if this
      // host genuinely cannot spawn `sh` with env: {}, the test environment
      // is too unusual to assert against and we'd want to know.
      const spawnProbe = spawnSync("sh", ["-c", "exit 0"], { env: {} });
      expect(spawnProbe.error).toBeUndefined();
      expect(spawnProbe.status).toBe(0);

      process.env.PATH = daemonBin; // host PATH cannot be the source of the hit

      const registry = buildRegistry({
        runners: {
          fake: {
            kind: "acp_process",
            adapter: FAKE_ADAPTER_ID,
            process: { executable: "sh" },
            env: { inherit: "none" },
          },
        },
      });
      const contract = resolveRunnerInvocation(
        makeInput({
          agent: makeAgent({ runner: "fake" }),
          registry,
          hostEnv: { PATH: daemonBin },
        }),
      );
      expect(contract.inheritParentEnv).toBe(false);
      expect(contract.env.PATH).toBeUndefined();

      // Preflight must mirror the spawn-time fallback to the libc default
      // search path; otherwise it false-rejects this contract.
      await expect(preflightRunnerInvocation(contract)).resolves.toBeUndefined();
    },
  );

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it.skipIf(!isPosix)(
    "preflight rejects the same bare command when env.set.PATH is explicitly empty",
    async () => {
      // Spawn parity in the opposite direction: an explicitly empty PATH
      // tells Node to search no segments, so `sh` cannot resolve even though
      // `sh` exists in the libc default path. Preflight must reject — the
      // empty-string case is preserved end-to-end and not collapsed into
      // the libc-default fallback.
      const spawnProbe = spawnSync("sh", ["-c", "exit 0"], { env: { PATH: "" } });
      expect(spawnProbe.error?.code).toBe("ENOENT");

      process.env.PATH = daemonBin;

      const registry = buildRegistry({
        runners: {
          fake: {
            kind: "acp_process",
            adapter: FAKE_ADAPTER_ID,
            process: { executable: "sh" },
            env: { inherit: "none", set: { PATH: "" } },
          },
        },
      });
      const contract = resolveRunnerInvocation(
        makeInput({
          agent: makeAgent({ runner: "fake" }),
          registry,
          hostEnv: { PATH: daemonBin },
        }),
      );
      expect(contract.inheritParentEnv).toBe(false);
      expect(contract.env.PATH).toBe("");

      let captured: RunnerResolutionError | null = null;
      try {
        await preflightRunnerInvocation(contract);
      } catch (err) {
        captured = err as RunnerResolutionError;
      }
      expect(captured).toBeInstanceOf(RunnerResolutionError);
      expect(captured!.reason).toBe("unspawnable_command");
      expect(captured!.details.unspawnable_reason).toBe("not_found");
    },
  );
});

describe("preflightExecutable: timeout and probe semantics", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-runner-process-preflight-");
  });
  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("returns spawnable=true with the resolved path for an absolute executable that exists", async () => {
    const fakeExecutable = path.join(tempDir, "ok");
    await writeExecutable(fakeExecutable);

    const result = await preflightExecutable(fakeExecutable);
    expect(result.spawnable).toBe(true);
    if (result.spawnable) {
      expect(result.resolved).toBe(fakeExecutable);
    }
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("resolves a bare command name from the supplied searchPath", async () => {
    const binDir = path.join(tempDir, "bin");
    const fakeExecutable = path.join(binDir, "fake-bin");
    await writeExecutable(fakeExecutable);

    const result = await preflightExecutable("fake-bin", { searchPath: binDir });
    expect(result.spawnable).toBe(true);
    if (result.spawnable) {
      expect(result.resolved).toBe(fakeExecutable);
    }
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("returns not_found for an empty PATH search when the command is bare", async () => {
    const result = await preflightExecutable("definitely-not-installed-xyz", { searchPath: "" });
    expect(result.spawnable).toBe(false);
    if (!result.spawnable) {
      expect(result.reason).toBe("not_found");
    }
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("returns a typed timeout diagnostic when the probe budget is zero", async () => {
    // A budget of 0 short-circuits to the timeout diagnostic so the test is
    // deterministic — no race with the underlying fs.access. Confirms the
    // typed timeout shape the AC requires.
    const result = await preflightExecutable("/does/not/matter", { timeoutMs: 0 });
    expect(result.spawnable).toBe(false);
    if (!result.spawnable) {
      expect(result.reason).toBe("timeout");
      expect(result.message).toMatch(/timed out/i);
    }
  });
});

// ─── AC: ac-runner-args-extend-acp-invocation ────────────────────────────────

describe("runner.process.args: argument appending", () => {
  // AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
  it("appends process.args to the contract extraArgs", () => {
    registerFakeAdapter();
    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { args: ["--runner-arg-a", "--runner-arg-b"] },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry }),
    );

    expect(contract.extraArgs).toEqual(["--runner-arg-a", "--runner-arg-b"]);
  });

  // AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
  it("appends process.args after auto-approve args (auto-approve is prepended)", () => {
    registerFakeAdapter();
    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { args: ["--runner-arg"] },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry, autoApprove: true }),
    );

    expect([...contract.extraArgs]).toEqual(["--auto-approve", "--runner-arg"]);
  });

  // AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
  it("does not mutate the registered adapter's args when appending invocation args", () => {
    registerFakeAdapter();
    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { args: ["--runner-arg"] },
        },
      },
    });
    resolveRunnerInvocation(makeInput({ agent: makeAgent({ runner: "fake" }), registry }));

    // The registered adapter's args list still holds only its original args.
    // We re-resolve and confirm the adapter.args from the new contract have
    // not absorbed the previous resolution's runner args.
    const followup = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry }),
    );
    expect(followup.adapter.args).toEqual(FAKE_ADAPTER_ARGS);
  });

  // AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
  it("rejects --api-key=<value> style args at config load time", () => {
    const parsed = SystemRunnerConfigSchema.safeParse({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { args: ["--api-key=plaintext-secret"] },
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message).join("\n");
      expect(messages).toMatch(/secret/i);
    }
  });

  // AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
  it("rejects --api-key <value> (pair) style args at config load time", () => {
    const parsed = SystemRunnerConfigSchema.safeParse({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { args: ["--auth-token", "plaintext-secret"] },
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The flagged index should be the value position (1), not the flag (0).
      const paths = parsed.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.endsWith("args.1"))).toBe(true);
    }
  });

  // AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
  it("rejects Bearer-token-style args anywhere they appear", () => {
    const parsed = SystemRunnerConfigSchema.safeParse({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { args: ["--header", "Bearer xyz123"] },
        },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts non-secret args like profile/mode flags", () => {
    const parsed = SystemRunnerConfigSchema.safeParse({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: {
            args: ["--profile", "fast", "--model=gpt-5", "--retry-count", "3", "-v"],
          },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("findSecretArgIndices flags pair-style secrets at the value position", () => {
    const indices = findSecretArgIndices(["--api-key", "abc", "--profile", "ok"]);
    expect(indices).toEqual([1]);
  });
});

// ─── AC: ac-runner-cwd-is-invocation-only ────────────────────────────────────

describe("runner.process.cwd: cwd is invocation-only", () => {
  // AC: @runner-process-invocation-inputs ac-runner-cwd-is-invocation-only
  it("uses runner.process.cwd as contract.cwd when configured", () => {
    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { cwd: "/var/runner-cwd" },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({
        agent: makeAgent({ runner: "fake" }),
        registry,
        cwd: "/var/invocation-default",
      }),
    );
    expect(contract.cwd).toBe("/var/runner-cwd");
  });

  // AC: @runner-process-invocation-inputs ac-runner-cwd-is-invocation-only
  it("does not mutate the daemon or parent process cwd while resolving", () => {
    const beforeCwd = process.cwd();
    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: { cwd: "/this/path/does/not/exist" },
        },
      },
    });
    resolveRunnerInvocation(
      makeInput({
        agent: makeAgent({ runner: "fake" }),
        registry,
        cwd: "/var/invocation-default",
      }),
    );
    expect(process.cwd()).toBe(beforeCwd);
  });

  // AC: @runner-process-invocation-inputs ac-runner-cwd-is-invocation-only
  it("falls back to the invocation cwd when runner.process.cwd is unset", () => {
    const registry = buildRegistry({
      runners: {
        fake: { kind: "acp_process", adapter: FAKE_ADAPTER_ID },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({
        agent: makeAgent({ runner: "fake" }),
        registry,
        cwd: "/var/invocation-default",
      }),
    );
    expect(contract.cwd).toBe("/var/invocation-default");
  });
});

// ─── AC: ac-invocation-diagnostics-identify-inputs ───────────────────────────

describe("runner invocation diagnostics: source metadata", () => {
  // AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
  it("reports runner name, adapter, command/cwd/args sources, and env policy", () => {
    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: {
            executable: "/var/runner/fake-acp",
            args: ["--profile", "fast"],
            cwd: "/var/runner-cwd",
          },
          env: { inherit: "minimal" },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry }),
    );

    expect(contract.diagnostics.selectedRunner.name).toBe("fake");
    expect(contract.diagnostics.selectedAdapter.id).toBe(FAKE_ADAPTER_ID);
    expect(contract.diagnostics.selectedAdapter.source).toBe("runner");
    expect(contract.diagnostics.fieldOrigins?.processExecutable).toBe("system");
    expect(contract.diagnostics.fieldOrigins?.processArgs).toBe("system");
    expect(contract.diagnostics.fieldOrigins?.processCwd).toBe("system");
    expect(contract.diagnostics.fieldOrigins?.envInherit).toBe("system");
  });

  // AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
  it("reports null process.* origins when the runner did not configure them", () => {
    const registry = buildRegistry({
      runners: {
        fake: { kind: "acp_process", adapter: FAKE_ADAPTER_ID },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry }),
    );

    expect(contract.diagnostics.fieldOrigins?.processExecutable).toBeNull();
    expect(contract.diagnostics.fieldOrigins?.processArgs).toBeNull();
    expect(contract.diagnostics.fieldOrigins?.processCwd).toBeNull();
  });

  // AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
  it("does not leak runner.process.executable, args, or cwd values into diagnostics", () => {
    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          process: {
            executable: "/secret-path/sensitive-command",
            args: ["--profile", "sensitive-profile-name"],
            cwd: "/secret-path/sensitive-cwd",
          },
        },
      },
    });
    const contract: RunnerInvocation = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "fake" }), registry }),
    );

    // Origins record *whether* the value came from system/project/default,
    // never the value itself. The diagnostics JSON should reflect that.
    const diagJson = JSON.stringify(contract.diagnostics);
    expect(diagJson).not.toContain("sensitive-command");
    expect(diagJson).not.toContain("sensitive-profile-name");
    expect(diagJson).not.toContain("sensitive-cwd");
  });

  // AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
  it("redacts secret-binding source detail to keys/source names only", () => {
    const registry = buildRegistry({
      runners: {
        fake: {
          kind: "acp_process",
          adapter: FAKE_ADAPTER_ID,
          env: {
            secrets: { ANTHROPIC_API_KEY: { source: "user_env", required: false } },
          },
        },
      },
    });
    const contract = resolveRunnerInvocation(
      makeInput({
        agent: makeAgent({ runner: "fake" }),
        registry,
        hostEnv: { ANTHROPIC_API_KEY: "must-not-leak" },
      }),
    );

    const diagJson = JSON.stringify(contract.diagnostics);
    expect(diagJson).not.toContain("must-not-leak");
    expect(contract.diagnostics.fieldOrigins?.envSecrets).toBe("system");
  });
});
