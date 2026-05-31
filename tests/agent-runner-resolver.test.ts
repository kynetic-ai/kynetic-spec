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
 *     ac-skill-formatting-uses-resolved-adapter (via adapterId field)
 *     ac-auto-approve-from-resolved-contract
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
import { registerAdapter } from "../src/agents/adapters.js";
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
