/**
 * Tests for the runner resolver and invocation contract.
 *
 * Covers:
 *   @runner-resolution-and-preflight
 *     ac-one-shot-uses-runner-resolution (via invocation tests)
 *     ac-unknown-runner-blocks-before-spawn
 *     ac-unknown-runner-reports-guidance
 *     ac-invalid-runner-blocks-before-prompt
 *   @agent-runner-configuration
 *     ac-adapter-field-backcompat
 *     ac-runner-precedence-over-adapter
 *   @runner-invocation-semantics
 *     ac-auto-approve-from-resolved-contract
 *   @runner-process-invocation-inputs (resolver-side enforcement)
 *     ac-existing-executable-reference-resolves
 *     ac-runner-cwd-is-invocation-only
 *   @runner-environment-secret-boundaries (resolver-side enforcement)
 *     ac-env-inheritance-policy-applied
 *     ac-env-set-overrides-allowed-values
 *     ac-required-secret-missing-blocks
 *     ac-secret-values-not-stored-inline
 */

import { describe, it, expect } from "vitest";
import {
  resolveRunnerInvocation,
  RunnerResolutionError,
  type ResolveRunnerInvocationInput,
} from "../src/agents/runners.js";
import {
  mergeRunnerConfigs,
  type EffectiveRunnerRegistry,
  type ProjectRunnerConfig,
  type SystemRunnerConfig,
} from "../src/agents/runner-config.js";
import { getAdapter, registerAdapter } from "../src/agents/adapters.js";
import type { Agent } from "../src/schema/meta.js";
import { testUlid } from "./helpers/cli.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "test-agent",
    name: "Test Agent",
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

function buildRegistry(
  project: ProjectRunnerConfig | null,
  system: SystemRunnerConfig | null,
): EffectiveRunnerRegistry {
  return mergeRunnerConfigs(project, system);
}

// ─── Legacy / implicit path ──────────────────────────────────────────────────

describe("resolveRunnerInvocation: legacy adapter agents", () => {
  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("resolves agent.adapter for the implicit runner path", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent }));

    expect(result.runnerId).toBeNull();
    expect(result.adapterId).toBe("claude-agent-acp");
    expect(result.adapter.command).toBeDefined();
    expect(result.diagnostics.selectedRunner.source).toBe("implicit");
    expect(result.diagnostics.selectedAdapter.source).toBe("agent.adapter");
    expect(result.diagnostics.sourceLayer).toBe("implicit");
  });

  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("passes through the supplied invocation cwd and base env on the implicit path", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        cwd: "/var/work/agent",
        env: { FOO: "bar", BAZ: "qux" },
      }),
    );

    expect(result.cwd).toBe("/var/work/agent");
    expect(result.env.FOO).toBe("bar");
    expect(result.env.BAZ).toBe("qux");
  });

  // AC: @runner-invocation-semantics ac-auto-approve-from-resolved-contract
  it("omits auto-approve args when autoApprove is false", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent, autoApprove: false }));
    expect(result.extraArgs).toEqual([]);
  });

  // AC: @runner-invocation-semantics ac-auto-approve-from-resolved-contract
  it("appends the resolved adapter's autoApproveArgs when autoApprove is true", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent, autoApprove: true }));
    expect(result.extraArgs).toContain("--dangerously-skip-permissions");
  });
});

describe("resolveRunnerInvocation: default adapter when none configured", () => {
  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("falls back to claude-agent-acp when neither runner nor adapter is set", () => {
    const agent = makeAgent({ adapter: undefined, runner: undefined });
    const result = resolveRunnerInvocation(makeInput({ agent }));

    expect(result.runnerId).toBeNull();
    expect(result.adapterId).toBe("claude-agent-acp");
    expect(result.diagnostics.selectedAdapter.source).toBe("default");
  });
});

// ─── System-only runner-backed agents ────────────────────────────────────────

describe("resolveRunnerInvocation: system-only runner-backed agents", () => {
  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  it("resolves the runner-named adapter when only the system layer defines it", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          process: { args: ["--system-arg"] },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry }));

    expect(result.runnerId).toBe("codex");
    expect(result.adapterId).toBe("codex-acp");
    expect(result.diagnostics.selectedRunner.source).toBe("agent.runner");
    expect(result.diagnostics.sourceLayer).toBe("system");
    expect(result.diagnostics.selectedAdapter.source).toBe("runner");
  });

  it("appends runner process.args to the invocation extraArgs", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          process: { args: ["--system-arg-a", "--system-arg-b"] },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry }));

    expect(result.extraArgs).toEqual(["--system-arg-a", "--system-arg-b"]);
  });

  it("overlays runner env.set non-secret literals onto the base invocation env", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: { set: { CODEX_MODEL: "gpt-5", CODEX_PROFILE: "fast" } },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        registry,
        env: { PRE_EXISTING: "1", CODEX_MODEL: "from-base" },
      }),
    );

    expect(result.env.PRE_EXISTING).toBe("1");
    // Runner env.set wins over base env values for the same key.
    expect(result.env.CODEX_MODEL).toBe("gpt-5");
    expect(result.env.CODEX_PROFILE).toBe("fast");
  });
});

// ─── Project + system merged runner-backed agents ────────────────────────────

describe("resolveRunnerInvocation: merged project + system runners", () => {
  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  it("reports merged sourceLayer when both layers contributed values", () => {
    const project: ProjectRunnerConfig = {
      runners: {
        codex: {
          env: { set: { CODEX_PROFILE: "from-project" } },
          privacy: { disable_nonessential_traffic: false },
        },
      },
    };
    const system: SystemRunnerConfig = {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: { set: { CODEX_MODEL: "gpt-5" } },
        },
      },
    };
    const registry = buildRegistry(project, system);
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry }));

    expect(result.runnerId).toBe("codex");
    expect(result.adapterId).toBe("codex-acp");
    expect(result.env.CODEX_PROFILE).toBe("from-project");
    expect(result.env.CODEX_MODEL).toBe("gpt-5");
    expect(result.diagnostics.sourceLayer).toBe("merged");
  });

  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  it("includes runner field-level overrides in diagnostics when system overrode project", () => {
    const project: ProjectRunnerConfig = {
      runners: {
        codex: { privacy: { disable_nonessential_traffic: false } },
      },
    };
    const system: SystemRunnerConfig = {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          privacy: { disable_nonessential_traffic: true },
        },
      },
    };
    const registry = buildRegistry(project, system);
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry }));

    expect(result.diagnostics.overrides).toContain("privacy.disable_nonessential_traffic");
  });
});

// ─── Runner precedence over adapter ──────────────────────────────────────────

describe("resolveRunnerInvocation: runner precedence over adapter", () => {
  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  it("uses the runner's adapter even when agent.adapter is also set", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: { kind: "acp_process", adapter: "codex-acp" },
      },
    });
    const agent = makeAgent({ runner: "codex", adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry }));

    expect(result.runnerId).toBe("codex");
    expect(result.adapterId).toBe("codex-acp");
    expect(result.diagnostics.selectedAdapter.source).toBe("runner");
  });

  // AC: @runner-invocation-semantics ac-auto-approve-from-resolved-contract
  it("uses the runner-resolved adapter's autoApproveArgs, not the agent.adapter's", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: { kind: "acp_process", adapter: "codex-acp" },
      },
    });
    const agent = makeAgent({ runner: "codex", adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, autoApprove: true }));

    // codex-acp uses `-c` flag args, not --dangerously-skip-permissions
    expect(result.extraArgs).not.toContain("--dangerously-skip-permissions");
    expect(result.extraArgs).toContain("-c");
  });
});

// ─── Unknown runner failure ──────────────────────────────────────────────────

describe("resolveRunnerInvocation: unknown runner failure", () => {
  // AC: @runner-resolution-and-preflight ac-unknown-runner-blocks-before-spawn
  // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
  // AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
  it("throws RunnerResolutionError with reason 'unknown_runner' when runner name not in registry", () => {
    const registry = buildRegistry(null, {
      runners: { codex: { kind: "acp_process", adapter: "codex-acp" } },
    });
    const agent = makeAgent({ runner: "missing-runner" });

    expect(() => resolveRunnerInvocation(makeInput({ agent, registry }))).toThrow(
      RunnerResolutionError,
    );

    try {
      resolveRunnerInvocation(makeInput({ agent, registry }));
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerResolutionError);
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("unknown_runner");
      expect(e.message).toContain("missing-runner");
      // Guidance must mention both layers + agent definition so users know
      // where to look.
      expect(e.message).toMatch(/project/i);
      expect(e.message).toMatch(/system/i);
      expect(e.message).toMatch(/agent/i);
    }
  });
});

// ─── Unknown adapter reference failure ───────────────────────────────────────

describe("resolveRunnerInvocation: unknown adapter reference failure", () => {
  // AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
  it("throws 'invalid_adapter' when an effective runner points at an unregistered adapter", () => {
    // Bypass schema validation by building the registry directly with a
    // bogus adapter id. This simulates a registry constructed outside the
    // YAML loader (e.g., in a future programmatic API) or an adapter
    // unregistered between load and resolve.
    const registry: EffectiveRunnerRegistry = {
      runners: {
        rogue: {
          name: "rogue",
          kind: "acp_process",
          adapter: "not-registered-anywhere",
          process: { executable: null, args: [], cwd: null },
          env: { inherit: "minimal", pass: [], set: {}, secrets: {} },
          privacy: { disable_nonessential_traffic: true },
          diagnostics: { retain_raw_logs: "on_failure" },
          sources: {
            kind: "system",
            adapter: "system",
            processExecutable: null,
            processArgs: null,
            processCwd: null,
            envInherit: "default",
            envPass: "default",
            envSet: { keys: {} },
            envSecrets: null,
            privacyDisableNonessentialTraffic: "default",
            diagnosticsRetainRawLogs: "default",
            overriddenBySystem: [],
          },
        },
      },
    };
    const agent = makeAgent({ runner: "rogue" });

    try {
      resolveRunnerInvocation(makeInput({ agent, registry }));
      throw new Error("expected RunnerResolutionError");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerResolutionError);
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("invalid_adapter");
      expect(e.message).toContain("not-registered-anywhere");
    }
  });

  it("resolves successfully when runner.adapter was registered at runtime via registerAdapter", () => {
    const customAdapterId = "test-resolver-runtime-adapter";
    registerAdapter(customAdapterId, {
      command: "node",
      args: ["mock.js"],
      autoApproveArgs: ["--auto"],
    });
    const registry = buildRegistry(null, {
      runners: {
        runtime: { kind: "acp_process", adapter: customAdapterId },
      },
    });
    const agent = makeAgent({ runner: "runtime" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, autoApprove: true }));

    expect(result.adapterId).toBe(customAdapterId);
    expect(result.extraArgs).toContain("--auto");
  });
});

// ─── Invalid project-layer config diagnostics ────────────────────────────────

describe("resolveRunnerInvocation: invalid project-layer config diagnostics", () => {
  // AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
  it("surfaces project-layer load issues in diagnostics for runner-backed invocations", () => {
    const registry = buildRegistry(null, {
      runners: { codex: { kind: "acp_process", adapter: "codex-acp" } },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        registry,
        projectLayerIssues: [
          { path: "runners.codex.env.set.API_KEY", message: "Secret-looking env name" },
        ],
      }),
    );

    // The invocation still resolves (system layer is sufficient), but the
    // project-layer issues are visible so callers can surface them.
    expect(result.diagnostics.projectLayerIssues).toHaveLength(1);
    expect(result.diagnostics.projectLayerIssues?.[0].message).toMatch(/secret/i);
  });

  it("propagates project-layer issues for legacy invocations as well", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        projectLayerIssues: [{ path: "runners.codex", message: "bad" }],
      }),
    );

    expect(result.diagnostics.projectLayerIssues).toHaveLength(1);
  });
});

// ─── Invalid effective runner diagnostics ────────────────────────────────────

describe("resolveRunnerInvocation: invalid effective runner diagnostics", () => {
  // AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
  it("surfaces system-layer load issues in diagnostics for runner-backed invocations", () => {
    const registry = buildRegistry(null, {
      runners: { codex: { kind: "acp_process", adapter: "codex-acp" } },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        registry,
        systemLayerIssues: [
          { path: "runners.codex.adapter", message: "Adapter unknown-x is not registered" },
        ],
      }),
    );

    expect(result.diagnostics.systemLayerIssues).toHaveLength(1);
    expect(result.diagnostics.systemLayerIssues?.[0].path).toContain("adapter");
  });

  it("does not leak runner env.set values into diagnostics", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: { set: { CODEX_MODEL: "gpt-5-secret-build" } },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry }));

    // Diagnostics record the set keys (names) but never the values.
    const diagJson = JSON.stringify(result.diagnostics);
    expect(diagJson).not.toContain("gpt-5-secret-build");
  });
});

// ─── Adapter override ────────────────────────────────────────────────────────

describe("resolveRunnerInvocation: adapter override", () => {
  it("honors adapterOverride and reports its source", () => {
    const agent = makeAgent({ runner: "codex" });
    const registry = buildRegistry(null, {
      runners: { codex: { kind: "acp_process", adapter: "codex-acp" } },
    });
    const result = resolveRunnerInvocation(
      makeInput({ agent, registry, adapterOverride: "claude-agent-acp" }),
    );

    expect(result.adapterId).toBe("claude-agent-acp");
    expect(result.diagnostics.selectedAdapter.source).toBe("override");
    // The override path bypasses the runner — runnerId should be null.
    expect(result.runnerId).toBeNull();
  });
});

// ─── Cleanup hook ────────────────────────────────────────────────────────────

describe("resolveRunnerInvocation: cleanup hook", () => {
  it("returns a no-throw async cleanup hook", async () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent }));

    expect(result.cleanup).toBeDefined();
    await expect(result.cleanup!()).resolves.toBeUndefined();
  });
});

// ─── inheritParentEnv flag ───────────────────────────────────────────────────

describe("resolveRunnerInvocation: inheritParentEnv flag", () => {
  it("sets inheritParentEnv=true on the implicit/legacy path", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent }));
    expect(result.inheritParentEnv).toBe(true);
  });

  it("sets inheritParentEnv=true when --adapter override is supplied", () => {
    const agent = makeAgent({ runner: "codex" });
    const registry = buildRegistry(null, {
      runners: { codex: { kind: "acp_process", adapter: "codex-acp" } },
    });
    const result = resolveRunnerInvocation(
      makeInput({ agent, registry, adapterOverride: "claude-agent-acp" }),
    );
    expect(result.inheritParentEnv).toBe(true);
  });

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("sets inheritParentEnv=false on the runner-backed path so env policy is enforced", () => {
    const registry = buildRegistry(null, {
      runners: { codex: { kind: "acp_process", adapter: "codex-acp" } },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry }));
    expect(result.inheritParentEnv).toBe(false);
  });
});

// ─── process.executable override ─────────────────────────────────────────────

describe("resolveRunnerInvocation: process.executable", () => {
  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("replaces adapter.command with runner.process.executable when set", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          process: { executable: "/usr/local/bin/codex-wrapper" },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry }));

    expect(result.adapter.command).toBe("/usr/local/bin/codex-wrapper");
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  it("does not mutate the registered adapter when overriding the command", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          process: { executable: "/bin/echo" },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const beforeResolution = (
      [...listRegisteredAdapterCommands()].find(([id]) => id === "codex-acp") as
        | [string, string]
        | undefined
    )?.[1];

    const result = resolveRunnerInvocation(makeInput({ agent, registry }));
    expect(result.adapter.command).toBe("/bin/echo");

    const afterResolution = (
      [...listRegisteredAdapterCommands()].find(([id]) => id === "codex-acp") as
        | [string, string]
        | undefined
    )?.[1];
    // The registered adapter's command is unchanged.
    expect(afterResolution).toBe(beforeResolution);
    expect(afterResolution).not.toBe("/bin/echo");
  });

  it("preserves the adapter command on the implicit/legacy path", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent }));
    // Implicit path keeps the registered adapter command unchanged.
    expect(result.adapter.command).toBeDefined();
    // The runner-backed override should never apply on the implicit path.
    expect(result.adapter.command).not.toBe("/bin/echo");
  });
});

// ─── generic-acp process adapter ─────────────────────────────────────────────

describe("resolveRunnerInvocation: generic-acp process adapter", () => {
  // AC: @runner-process-invocation-inputs ac-generic-acp-process-uses-runner-executable
  // AC: @runner-invocation-semantics ac-generic-acp-auto-approve-contributes-no-args
  it("uses the runner executable and contributes only runner args, even with autoApprove", () => {
    const registry = buildRegistry(null, {
      runners: {
        custom: {
          kind: "acp_process",
          adapter: "generic-acp",
          process: { executable: "/usr/local/bin/my-acp", args: ["--model", "x"] },
        },
      },
    });
    const agent = makeAgent({ runner: "custom" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, autoApprove: true }));

    expect(result.adapterId).toBe("generic-acp");
    // The spawned command is the runner-declared executable.
    expect(result.adapter.command).toBe("/usr/local/bin/my-acp");
    // The generic adapter contributes no base args and no auto-approve args —
    // extraArgs is exactly the runner's process.args.
    expect(result.adapter.args).toEqual([]);
    expect(result.extraArgs).toEqual(["--model", "x"]);
  });

  // AC: @runner-invocation-semantics ac-generic-acp-auto-approve-contributes-no-args
  it("produces empty extraArgs for a generic-acp runner with no process.args under autoApprove", () => {
    const registry = buildRegistry(null, {
      runners: {
        custom: {
          kind: "acp_process",
          adapter: "generic-acp",
          process: { executable: "/usr/local/bin/my-acp" },
        },
      },
    });
    const agent = makeAgent({ runner: "custom" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, autoApprove: true }));

    expect(result.extraArgs).toEqual([]);
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  // Package-backed regression: the executable override replaces only the
  // command; the adapter's base args stay on the adapter and its auto-approve
  // args precede the runner args in extraArgs.
  it("preserves package-backed adapter base args and auto-approve ordering when overriding the command", () => {
    const customAdapterId = "test-generic-regression-pkg-adapter";
    registerAdapter(customAdapterId, {
      command: "node",
      args: ["base-a", "base-b"],
      autoApproveArgs: ["--yolo"],
    });
    const registry = buildRegistry(null, {
      runners: {
        pkg: {
          kind: "acp_process",
          adapter: customAdapterId,
          process: { executable: "/bin/echo", args: ["--runner-arg"] },
        },
      },
    });
    const agent = makeAgent({ runner: "pkg" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, autoApprove: true }));

    // Command is overridden by the runner executable...
    expect(result.adapter.command).toBe("/bin/echo");
    // ...but the adapter's base args remain on the adapter.
    expect(result.adapter.args).toEqual(["base-a", "base-b"]);
    // extraArgs is adapter auto-approve args followed by runner args.
    expect(result.extraArgs).toEqual(["--yolo", "--runner-arg"]);
    // The registered adapter is not mutated by the command override.
    expect(getAdapter(customAdapterId)!.command).toBe("node");
  });

  // AC: @runner-process-invocation-inputs ac-generic-acp-process-requires-executable
  it("fails during contract resolution when a generic-acp runner omits process.executable", () => {
    const registry = buildRegistry(null, {
      runners: {
        custom: { kind: "acp_process", adapter: "generic-acp" },
      },
    });
    const agent = makeAgent({ runner: "custom" });

    expect(() => resolveRunnerInvocation(makeInput({ agent, registry }))).toThrow(
      RunnerResolutionError,
    );

    try {
      resolveRunnerInvocation(makeInput({ agent, registry }));
    } catch (err) {
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("missing_process_executable");
      expect(e.details).toEqual({
        runner: "custom",
        adapter: "generic-acp",
        missing_field: "process.executable",
      });
    }
  });

  // AC: @runner-resolution-and-preflight ac-generic-acp-direct-invocation-requires-runner
  it("rejects implicit agent.adapter: generic-acp before spawn (no runner)", () => {
    const agent = makeAgent({ adapter: "generic-acp" });

    expect(() => resolveRunnerInvocation(makeInput({ agent }))).toThrow(RunnerResolutionError);

    try {
      resolveRunnerInvocation(makeInput({ agent }));
    } catch (err) {
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("missing_process_executable");
      expect(e.details).toEqual({
        adapter: "generic-acp",
        missing_field: "process.executable",
      });
      // No runner context on the direct/legacy path.
      expect(e.details.runner).toBeUndefined();
    }
  });

  // AC: @runner-resolution-and-preflight ac-generic-acp-direct-invocation-requires-runner
  it("rejects adapterOverride: generic-acp before spawn (no runner)", () => {
    const agent = makeAgent();

    expect(() =>
      resolveRunnerInvocation(makeInput({ agent, adapterOverride: "generic-acp" })),
    ).toThrow(RunnerResolutionError);

    try {
      resolveRunnerInvocation(makeInput({ agent, adapterOverride: "generic-acp" }));
    } catch (err) {
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("missing_process_executable");
      expect(e.details).toEqual({
        adapter: "generic-acp",
        missing_field: "process.executable",
      });
    }
  });
});

// ─── process.cwd override ────────────────────────────────────────────────────

describe("resolveRunnerInvocation: process.cwd", () => {
  // AC: @runner-process-invocation-inputs ac-runner-cwd-is-invocation-only
  it("uses runner.process.cwd when set", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          process: { cwd: "/tmp/runner-managed-cwd" },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({ agent, registry, cwd: "/tmp/invocation-default-cwd" }),
    );
    expect(result.cwd).toBe("/tmp/runner-managed-cwd");
  });

  // AC: @runner-process-invocation-inputs ac-runner-cwd-is-invocation-only
  it("falls back to invocation cwd when runner.process.cwd is unset", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: { kind: "acp_process", adapter: "codex-acp" },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({ agent, registry, cwd: "/tmp/invocation-default-cwd" }),
    );
    expect(result.cwd).toBe("/tmp/invocation-default-cwd");
  });
});

// ─── env.inherit policy ─────────────────────────────────────────────────────

describe("resolveRunnerInvocation: env.inherit policy", () => {
  const hostEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/runner-test",
    USER: "runner-test",
    LANG: "en_US.UTF-8",
    SECRET_LOOKING_API_KEY: "leak-me-if-you-can",
    CUSTOM_HOST_VAR: "from-host",
    ANTHROPIC_API_KEY: "must-not-leak",
  };

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("env.inherit: 'none' produces a child env with no host process vars", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: { inherit: "none" },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({ agent, registry, env: { KSPEC_NO_DAEMON: "1" }, hostEnv }),
    );

    expect(result.env.PATH).toBeUndefined();
    expect(result.env.HOME).toBeUndefined();
    expect(result.env.CUSTOM_HOST_VAR).toBeUndefined();
    expect(result.env.SECRET_LOOKING_API_KEY).toBeUndefined();
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    // caller-supplied kspec-required env still appears.
    expect(result.env.KSPEC_NO_DAEMON).toBe("1");
  });

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("env.inherit: 'minimal' inherits only PATH/HOME/USER/LANG-class basics", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: { inherit: "minimal" },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, hostEnv }));

    expect(result.env.PATH).toBe("/usr/bin:/bin");
    expect(result.env.HOME).toBe("/home/runner-test");
    expect(result.env.USER).toBe("runner-test");
    expect(result.env.LANG).toBe("en_US.UTF-8");
    // Non-minimal host vars are excluded.
    expect(result.env.CUSTOM_HOST_VAR).toBeUndefined();
    expect(result.env.SECRET_LOOKING_API_KEY).toBeUndefined();
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("env.inherit: 'ambient' inherits the host process env in full", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: { inherit: "ambient" },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, hostEnv }));

    expect(result.env.PATH).toBe("/usr/bin:/bin");
    expect(result.env.CUSTOM_HOST_VAR).toBe("from-host");
    // Note: ambient inheritance is the operator's explicit opt-in, so
    // secret-looking host names are inherited. The secrets-rejection
    // boundary is at config validation time, not at env composition.
    expect(result.env.ANTHROPIC_API_KEY).toBe("must-not-leak");
  });

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("env.pass forces specific host vars through regardless of inherit policy", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: { inherit: "none", pass: ["CUSTOM_HOST_VAR"] },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, hostEnv }));

    expect(result.env.PATH).toBeUndefined();
    expect(result.env.CUSTOM_HOST_VAR).toBe("from-host");
  });

  // AC: @runner-environment-secret-boundaries ac-env-set-overrides-allowed-values
  it("env.set overrides inherited host values for the same keys", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: {
            inherit: "minimal",
            set: { PATH: "/runner-only/bin" },
          },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, hostEnv }));

    expect(result.env.PATH).toBe("/runner-only/bin");
  });

  it("env.inherit defaults to 'minimal' when neither layer specifies it", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: { kind: "acp_process", adapter: "codex-acp" },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, hostEnv }));

    // PATH/HOME come through the minimal default.
    expect(result.env.PATH).toBe("/usr/bin:/bin");
    expect(result.env.HOME).toBe("/home/runner-test");
    // Non-minimal vars are excluded.
    expect(result.env.CUSTOM_HOST_VAR).toBeUndefined();
  });

  it("legacy/implicit invocations still pass through the supplied env unchanged", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(
      makeInput({ agent, env: { FOO: "bar" }, hostEnv: { PATH: "/host/path" } }),
    );

    // Implicit path returns the caller env as-is — no inheritance composition
    // happens on this path (the spawner inherits host env via
    // inheritParentEnv: true).
    expect(result.env.FOO).toBe("bar");
    expect(result.env.PATH).toBeUndefined();
  });
});

// ─── env.secrets resolution and missing_secret preflight ───────────────────

describe("resolveRunnerInvocation: env.secrets preflight", () => {
  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  it("throws missing_secret when a required binding's source cannot be resolved", () => {
    const registry: EffectiveRunnerRegistry = {
      runners: {
        codex: {
          name: "codex",
          kind: "acp_process",
          adapter: "codex-acp",
          process: { executable: null, args: [], cwd: null },
          env: {
            inherit: "minimal",
            pass: [],
            set: {},
            secrets: { API_TOKEN: { source: "missing-source", required: true } },
          },
          privacy: { disable_nonessential_traffic: true },
          diagnostics: { retain_raw_logs: "on_failure" },
          sources: {
            kind: "system",
            adapter: "system",
            processExecutable: null,
            processArgs: null,
            processCwd: null,
            envInherit: "default",
            envPass: "default",
            envSet: { keys: {} },
            envSecrets: "system",
            privacyDisableNonessentialTraffic: "default",
            diagnosticsRetainRawLogs: "default",
            overriddenBySystem: [],
          },
        },
      },
    };
    const agent = makeAgent({ runner: "codex" });

    try {
      resolveRunnerInvocation(makeInput({ agent, registry, hostEnv: {} }));
      throw new Error("expected RunnerResolutionError");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerResolutionError);
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("missing_secret");
      expect(e.message).toContain("API_TOKEN");
      expect(e.message).toContain("missing-source");
      expect(e.details.runner).toBe("codex");
      expect(e.details.secret_var).toBe("API_TOKEN");
      expect(e.details.source).toBe("missing-source");
    }
  });

  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  it("throws missing_secret when a required user_env binding has no value on the host", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: { secrets: { API_TOKEN: { source: "user_env", required: true } } },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });

    try {
      // hostEnv intentionally omits API_TOKEN so user_env cannot resolve it.
      resolveRunnerInvocation(makeInput({ agent, registry, hostEnv: { PATH: "/bin" } }));
      throw new Error("expected RunnerResolutionError");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerResolutionError);
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("missing_secret");
      expect(e.message).toContain("API_TOKEN");
    }
  });

  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  it("resolves user_env bindings from hostEnv and injects them into the contract env", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: {
            inherit: "none",
            secrets: { ANTHROPIC_API_KEY: { source: "user_env", required: true } },
          },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        registry,
        hostEnv: { ANTHROPIC_API_KEY: "host-token-value" },
      }),
    );

    expect(result.env.ANTHROPIC_API_KEY).toBe("host-token-value");
  });

  it("omits optional bindings that cannot resolve without throwing", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: {
            secrets: {
              OPTIONAL_TOKEN: { source: "user_env" }, // required defaults to false
              ANOTHER_TOKEN: { source: "missing-source" },
            },
          },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(makeInput({ agent, registry, hostEnv: {} }));

    expect(result.env.OPTIONAL_TOKEN).toBeUndefined();
    expect(result.env.ANOTHER_TOKEN).toBeUndefined();
  });

  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  it("does not leak resolved secret values into diagnostics", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: { secrets: { ANTHROPIC_API_KEY: { source: "user_env", required: true } } },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        registry,
        hostEnv: { ANTHROPIC_API_KEY: "must-not-appear-in-diagnostics" },
      }),
    );

    const diagJson = JSON.stringify(result.diagnostics);
    expect(diagJson).not.toContain("must-not-appear-in-diagnostics");
  });

  it("does not resolve env.secrets on the implicit/legacy path", () => {
    // Legacy/adapter agents don't have a runner — env.secrets only lives on
    // the runner-backed path. Sanity check: implicit path returns without
    // throwing even when no secrets are configured. The contract env
    // contains only the kspec-required invocation variables — no
    // secret-derived entries.
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent }));
    expect(result.runnerId).toBeNull();
    expect(Object.keys(result.env).toSorted()).toEqual(["KSPEC_NO_DAEMON", "KSPEC_SESSION_ID"]);
  });

  it("overlays secret values on top of env.set literals when both bind the same key", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: {
            set: { MY_VAR: "literal-value" },
            secrets: { MY_VAR: { source: "user_env", required: true } },
          },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({ agent, registry, hostEnv: { MY_VAR: "secret-value" } }),
    );
    // The resolved secret value wins over the env.set literal.
    expect(result.env.MY_VAR).toBe("secret-value");
  });

  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("exposes a sanitized mutationEnv that excludes resolved env.secrets", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: {
            inherit: "ambient",
            pass: ["HOST_VAR"],
            set: { CODEX_MODEL: "gpt-5", CODEX_PROFILE: "fast" },
            secrets: {
              ANTHROPIC_API_KEY: { source: "user_env", required: true },
              OPTIONAL_TOKEN: { source: "user_env" },
            },
          },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const sessionId = testUlid("SESS");
    const mutationLockFile = "/tmp/dispatch.lock";
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        registry,
        sessionId,
        mutationLockFile,
        env: { CALLER_OVERRIDE: "base" },
        hostEnv: {
          HOST_VAR: "from-host",
          ANTHROPIC_API_KEY: "anthropic-secret-value",
          OPTIONAL_TOKEN: "optional-token-value",
          AMBIENT_HOST: "ambient-value",
        },
      }),
    );

    // Adapter env carries everything (inherit, pass, base, set, secrets,
    // kspec-required vars). Confirm the secret is present in adapter env.
    expect(result.env.ANTHROPIC_API_KEY).toBe("anthropic-secret-value");
    expect(result.env.OPTIONAL_TOKEN).toBe("optional-token-value");
    expect(result.env.HOST_VAR).toBe("from-host");
    expect(result.env.AMBIENT_HOST).toBe("ambient-value");
    expect(result.env.CODEX_MODEL).toBe("gpt-5");
    expect(result.env.CALLER_OVERRIDE).toBe("base");
    expect(result.env.KSPEC_SESSION_ID).toBe(sessionId);

    // mutationEnv contains ONLY the kspec-required invocation variables.
    // No host inherit, no env.pass, no base env, no env.set, no secrets.
    expect(Object.keys(result.mutationEnv).toSorted()).toEqual([
      "KSPEC_NO_DAEMON",
      "KSPEC_SESSION_ID",
      "KSPEC_SHADOW_MUTATION_LOCK_FILE",
    ]);
    expect(result.mutationEnv.KSPEC_NO_DAEMON).toBe("1");
    expect(result.mutationEnv.KSPEC_SESSION_ID).toBe(sessionId);
    expect(result.mutationEnv.KSPEC_SHADOW_MUTATION_LOCK_FILE).toBe(mutationLockFile);

    // Strictly: no secret literal anywhere in mutationEnv (even values).
    const mutationJson = JSON.stringify(result.mutationEnv);
    expect(mutationJson).not.toContain("anthropic-secret-value");
    expect(mutationJson).not.toContain("optional-token-value");
    expect(mutationJson).not.toContain("ambient-value");
    expect(mutationJson).not.toContain("from-host");
    expect(mutationJson).not.toContain("base");
    expect(mutationJson).not.toContain("gpt-5");

    // secretEnvKeys lists the env var names sourced from env.secrets so the
    // mutation subprocess spawner can strip them from inherited host env.
    expect([...result.secretEnvKeys].toSorted()).toEqual(["ANTHROPIC_API_KEY", "OPTIONAL_TOKEN"]);
  });

  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  it("omits unresolved optional secrets from secretEnvKeys", () => {
    const registry = buildRegistry(null, {
      runners: {
        codex: {
          kind: "acp_process",
          adapter: "codex-acp",
          env: {
            secrets: {
              REQUIRED_TOKEN: { source: "user_env", required: true },
              UNRESOLVED_OPTIONAL: { source: "user_env" },
            },
          },
        },
      },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        registry,
        hostEnv: { REQUIRED_TOKEN: "required-value" },
      }),
    );

    // Only the actually-resolved secret is in secretEnvKeys.
    expect([...result.secretEnvKeys]).toEqual(["REQUIRED_TOKEN"]);
  });

  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  it("returns empty secretEnvKeys and mutationEnv-only contract on the implicit path", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const sessionId = testUlid("SESS");
    const result = resolveRunnerInvocation(makeInput({ agent, sessionId }));

    expect(result.runnerId).toBeNull();
    expect([...result.secretEnvKeys]).toEqual([]);
    expect(Object.keys(result.mutationEnv).toSorted()).toEqual([
      "KSPEC_NO_DAEMON",
      "KSPEC_SESSION_ID",
    ]);
    expect(result.mutationEnv.KSPEC_SESSION_ID).toBe(sessionId);
  });
});

/**
 * Snapshot the registered adapter list with their current command strings.
 * Used by tests that verify resolver does not mutate the shared registry.
 */
function listRegisteredAdapterCommands(): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ["claude-agent-acp", "codex-acp", "droid-acp", "mock-acp"]) {
    const adapter = getAdapter(id);
    if (adapter) out.set(id, adapter.command);
  }
  return out;
}
