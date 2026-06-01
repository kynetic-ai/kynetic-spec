/**
 * Tests for the runner env + secret boundary.
 *
 * Covers buildRunnerEnv (every inheritance mode, pass list behavior, literal
 * overrides, required secret failure, optional secret omission, privacy
 * default injection, explicit privacy override, nested-agent env stripping)
 * and the diagnostic redaction helper. Also exercises the runner contract's
 * kspec-required invocation variable overlay and routed session-id injection.
 *
 * Covers:
 *   @runner-environment-secret-boundaries
 *     ac-env-inheritance-policy-applied
 *     ac-env-set-overrides-allowed-values
 *     ac-secret-values-not-stored-inline
 *     ac-required-secret-missing-blocks
 *     ac-diagnostics-redact-secrets
 *     ac-privacy-defaults-applied
 *   @runner-invocation-semantics
 *     ac-session-env-injected-through-runner
 *     ac-runner-cleanup-restores-state
 */

import { describe, it, expect } from "vitest";
import {
  buildRunnerEnv,
  resolveRunnerInvocation,
  RunnerResolutionError,
  PRIVACY_DEFAULT_ENV,
  type ResolveRunnerInvocationInput,
} from "../src/agents/runners.js";
import {
  mergeRunnerConfigs,
  type EffectiveRunner,
  type EffectiveRunnerRegistry,
  type ProjectRunnerConfig,
  type SystemRunnerConfig,
} from "../src/agents/runner-config.js";
import { createRedactor, redactSecretValues, REDACTION_MARKER } from "../src/agents/redaction.js";
import { SANITIZED_ENV_VARS } from "../src/agents/spawner.js";
import type { Agent } from "../src/schema/meta.js";
import { testUlid } from "./helpers/cli.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_SESSION_ID = "01SESS00000000000000000000";

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
    sessionId: TEST_SESSION_ID,
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

/** Synthesize an effective runner directly (bypasses YAML schema). */
function makeEffectiveRunner(overrides: Partial<EffectiveRunner> = {}): EffectiveRunner {
  return {
    name: "test-runner",
    kind: "acp_process",
    adapter: "codex-acp",
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
    ...overrides,
  };
}

// ─── buildRunnerEnv: inheritance modes ───────────────────────────────────────

describe("buildRunnerEnv: inheritance modes", () => {
  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("inherit 'none' produces no host vars beyond the kspec required vars", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "none", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: { PATH: "/usr/bin", HOME: "/home/x", CUSTOM: "host" },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.CUSTOM).toBeUndefined();
    // kspec-required invocation vars are always present.
    expect(env.KSPEC_NO_DAEMON).toBe("1");
    expect(env.KSPEC_SESSION_ID).toBe(TEST_SESSION_ID);
  });

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("inherit 'minimal' inherits only the locale/shell/PATH-class basics", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "minimal", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {
        PATH: "/usr/bin:/bin",
        HOME: "/home/x",
        USER: "u",
        LANG: "en_US.UTF-8",
        CUSTOM_HOST_VAR: "leak-me",
        ANTHROPIC_API_KEY: "must-not-leak",
      },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.USER).toBe("u");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.CUSTOM_HOST_VAR).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("inherit 'ambient' inherits the full host env (operator opt-in)", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "ambient", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: { PATH: "/usr/bin", CUSTOM_HOST_VAR: "from-host" },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CUSTOM_HOST_VAR).toBe("from-host");
  });
});

// ─── buildRunnerEnv: env.pass ────────────────────────────────────────────────

describe("buildRunnerEnv: env.pass overlay", () => {
  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("pass list pulls specific host vars through regardless of inherit policy", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "none", pass: ["AWS_REGION"], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: { AWS_REGION: "us-east-1", LEAK_VAR: "no" },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.LEAK_VAR).toBeUndefined();
  });

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("pass entries whose host value is undefined are omitted", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "none", pass: ["ABSENT_VAR"], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {},
      sessionId: TEST_SESSION_ID,
    });
    expect(env.ABSENT_VAR).toBeUndefined();
  });
});

// ─── buildRunnerEnv: env.set literal overrides ───────────────────────────────

describe("buildRunnerEnv: env.set literal overrides", () => {
  // AC: @runner-environment-secret-boundaries ac-env-set-overrides-allowed-values
  it("literal env.set entries override inherited values for the same key", () => {
    const runner = makeEffectiveRunner({
      env: {
        inherit: "minimal",
        pass: [],
        set: { PATH: "/runner-only/bin" },
        secrets: {},
      },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: { PATH: "/usr/bin:/bin", HOME: "/home/x" },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.PATH).toBe("/runner-only/bin");
    expect(env.HOME).toBe("/home/x");
  });

  // AC: @runner-environment-secret-boundaries ac-env-set-overrides-allowed-values
  it("literal env.set entries override pass-list values for the same key", () => {
    const runner = makeEffectiveRunner({
      env: {
        inherit: "none",
        pass: ["TARGET"],
        set: { TARGET: "from-set" },
        secrets: {},
      },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: { TARGET: "from-host" },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.TARGET).toBe("from-set");
  });
});

// ─── buildRunnerEnv: env.secrets resolution ──────────────────────────────────

describe("buildRunnerEnv: env.secrets resolution", () => {
  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  it("throws missing_secret when a required user_env binding has no host value", () => {
    const runner = makeEffectiveRunner({
      env: {
        inherit: "minimal",
        pass: [],
        set: {},
        secrets: { ANTHROPIC_API_KEY: { source: "user_env", required: true } },
      },
    });
    try {
      buildRunnerEnv({
        runner,
        baseEnv: {},
        hostEnv: { PATH: "/bin" },
        sessionId: TEST_SESSION_ID,
      });
      throw new Error("expected RunnerResolutionError");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerResolutionError);
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("missing_secret");
      expect(e.details.secret_var).toBe("ANTHROPIC_API_KEY");
      expect(e.details.source).toBe("user_env");
    }
  });

  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  it("throws missing_secret for an unknown source kind", () => {
    const runner = makeEffectiveRunner({
      env: {
        inherit: "minimal",
        pass: [],
        set: {},
        secrets: { API_TOKEN: { source: "unknown-kind", required: true } },
      },
    });
    expect(() =>
      buildRunnerEnv({
        runner,
        baseEnv: {},
        hostEnv: { API_TOKEN: "value-from-host" },
        sessionId: TEST_SESSION_ID,
      }),
    ).toThrow(RunnerResolutionError);
  });

  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  it("omits optional bindings that fail to resolve without throwing", () => {
    const runner = makeEffectiveRunner({
      env: {
        inherit: "minimal",
        pass: [],
        set: {},
        secrets: {
          OPTIONAL_TOKEN: { source: "user_env", required: false },
          ANOTHER: { source: "unknown-kind", required: false },
        },
      },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {},
      sessionId: TEST_SESSION_ID,
    });
    expect(env.OPTIONAL_TOKEN).toBeUndefined();
    expect(env.ANOTHER).toBeUndefined();
  });

  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  it("returns resolved secret values via secretValues but not duplicated", () => {
    const runner = makeEffectiveRunner({
      env: {
        inherit: "none",
        pass: [],
        set: {},
        secrets: {
          ANTHROPIC_API_KEY: { source: "user_env", required: true },
          MIRROR_OF_KEY: { source: "user_env", required: false },
        },
      },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env, secretValues } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {
        ANTHROPIC_API_KEY: "shared-token-value",
        MIRROR_OF_KEY: "shared-token-value",
      },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.ANTHROPIC_API_KEY).toBe("shared-token-value");
    expect(env.MIRROR_OF_KEY).toBe("shared-token-value");
    // Duplicates collapse so the redactor doesn't double-process.
    expect(secretValues).toEqual(["shared-token-value"]);
  });
});

// ─── buildRunnerEnv: privacy defaults ────────────────────────────────────────

describe("buildRunnerEnv: privacy defaults", () => {
  // AC: @runner-environment-secret-boundaries ac-privacy-defaults-applied
  it("injects privacy defaults when disable_nonessential_traffic is true", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "none", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: true },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {},
      sessionId: TEST_SESSION_ID,
    });
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.DO_NOT_TRACK).toBe("1");
  });

  // AC: @runner-environment-secret-boundaries ac-privacy-defaults-applied
  it("omits privacy defaults when disable_nonessential_traffic is false", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "none", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {},
      sessionId: TEST_SESSION_ID,
    });
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    expect(env.DISABLE_TELEMETRY).toBeUndefined();
    expect(env.DO_NOT_TRACK).toBeUndefined();
  });

  // AC: @runner-environment-secret-boundaries ac-privacy-defaults-applied
  it("env.set explicit values override privacy defaults", () => {
    const runner = makeEffectiveRunner({
      env: {
        inherit: "none",
        pass: [],
        set: { DISABLE_TELEMETRY: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" },
        secrets: {},
      },
      privacy: { disable_nonessential_traffic: true },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {},
      sessionId: TEST_SESSION_ID,
    });
    expect(env.DISABLE_TELEMETRY).toBe("0");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("0");
    // Defaults that are not explicitly overridden remain applied.
    expect(env.DO_NOT_TRACK).toBe("1");
  });

  // AC: @runner-environment-secret-boundaries ac-privacy-defaults-applied
  it("privacy defaults override an inherited host value", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "ambient", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: true },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {
        DO_NOT_TRACK: "0",
        DISABLE_TELEMETRY: "0",
      },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });
});

// ─── buildRunnerEnv: nested-agent env stripping ──────────────────────────────

describe("buildRunnerEnv: nested-agent env stripping", () => {
  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("strips CLAUDECODE/CLAUDE_CODE_SESSION from ambient inheritance", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "ambient", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION: "parent-session-id",
        PATH: "/usr/bin",
      },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("strips CLAUDECODE/CLAUDE_CODE_SESSION from env.pass entries too", () => {
    const runner = makeEffectiveRunner({
      env: {
        inherit: "none",
        pass: ["CLAUDECODE", "CLAUDE_CODE_SESSION", "PATH"],
        set: {},
        secrets: {},
      },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION: "parent-session-id",
        PATH: "/usr/bin",
      },
      sessionId: TEST_SESSION_ID,
    });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("SANITIZED_ENV_VARS retains CLAUDECODE and CLAUDE_CODE_SESSION", () => {
    expect(SANITIZED_ENV_VARS).toContain("CLAUDECODE");
    expect(SANITIZED_ENV_VARS).toContain("CLAUDE_CODE_SESSION");
  });
});

// ─── buildRunnerEnv: kspec-required vars overlay ─────────────────────────────

describe("buildRunnerEnv: kspec-required vars overlay", () => {
  // AC: @runner-invocation-semantics ac-session-env-injected-through-runner
  it("always injects KSPEC_NO_DAEMON and KSPEC_SESSION_ID regardless of runner config", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "none", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {},
      sessionId: "01SESS-DETERMINISTIC-VALUE",
    });
    expect(env.KSPEC_NO_DAEMON).toBe("1");
    expect(env.KSPEC_SESSION_ID).toBe("01SESS-DETERMINISTIC-VALUE");
  });

  // AC: @runner-invocation-semantics ac-session-env-injected-through-runner
  it("includes KSPEC_SHADOW_MUTATION_LOCK_FILE when supplied by the caller", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "none", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {},
      sessionId: TEST_SESSION_ID,
      mutationLockFile: "/tmp/kspec-shadow.lock",
    });
    expect(env.KSPEC_SHADOW_MUTATION_LOCK_FILE).toBe("/tmp/kspec-shadow.lock");
  });

  it("omits KSPEC_SHADOW_MUTATION_LOCK_FILE when not supplied", () => {
    const runner = makeEffectiveRunner({
      env: { inherit: "none", pass: [], set: {}, secrets: {} },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {},
      sessionId: TEST_SESSION_ID,
    });
    expect(env.KSPEC_SHADOW_MUTATION_LOCK_FILE).toBeUndefined();
  });

  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  it("kspec-required vars override any env.set attempt to reassign them", () => {
    const runner = makeEffectiveRunner({
      env: {
        inherit: "none",
        pass: [],
        set: {
          KSPEC_NO_DAEMON: "0",
          KSPEC_SESSION_ID: "stolen-by-env-set",
        },
        secrets: {},
      },
      privacy: { disable_nonessential_traffic: false },
    });
    const { env } = buildRunnerEnv({
      runner,
      baseEnv: {},
      hostEnv: {},
      sessionId: "real-session",
    });
    expect(env.KSPEC_NO_DAEMON).toBe("1");
    expect(env.KSPEC_SESSION_ID).toBe("real-session");
  });
});

// ─── PRIVACY_DEFAULT_ENV constant ────────────────────────────────────────────

describe("PRIVACY_DEFAULT_ENV constant", () => {
  it("declares the documented privacy/telemetry suppression vars", () => {
    expect(PRIVACY_DEFAULT_ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(PRIVACY_DEFAULT_ENV.DISABLE_TELEMETRY).toBe("1");
    expect(PRIVACY_DEFAULT_ENV.DO_NOT_TRACK).toBe("1");
  });
});

// ─── Redaction helper ────────────────────────────────────────────────────────

describe("redactSecretValues / createRedactor", () => {
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("redactSecretValues replaces every occurrence with the redaction marker", () => {
    const text = "value is abc123 and also abc123 here";
    expect(redactSecretValues(text, ["abc123"])).toBe(
      `value is ${REDACTION_MARKER} and also ${REDACTION_MARKER} here`,
    );
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("redactSecretValues sorts longer secrets first so prefix overlaps don't bleed", () => {
    const text = "token=abcXYZ and prefix=abc";
    const out = redactSecretValues(text, ["abc", "abcXYZ"]);
    expect(out).toBe(`token=${REDACTION_MARKER} and prefix=${REDACTION_MARKER}`);
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("redactSecretValues ignores empty / non-string entries", () => {
    expect(redactSecretValues("hello world", [""])).toBe("hello world");
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("createRedactor returns a noop when given no secrets", () => {
    const redact = createRedactor([]);
    const text = "no secrets here";
    expect(redact(text)).toBe(text);
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("createRedactor captures values once so repeated invocation is consistent", () => {
    const redact = createRedactor(["super-secret-token"]);
    expect(redact("see super-secret-token in logs")).toBe(`see ${REDACTION_MARKER} in logs`);
    expect(redact("super-secret-token again")).toBe(`${REDACTION_MARKER} again`);
  });
});

// ─── End-to-end: contract redactor + session id routing ─────────────────────

describe("resolveRunnerInvocation: contract redactor + routed session id", () => {
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("contract.redact scrubs resolved secret values from diagnostic text", () => {
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
        hostEnv: { ANTHROPIC_API_KEY: "abc-secret-value-123" },
      }),
    );

    const sample = "Adapter startup failed: token abc-secret-value-123 rejected by remote";
    const scrubbed = result.redact(sample);
    expect(scrubbed).not.toContain("abc-secret-value-123");
    expect(scrubbed).toContain(REDACTION_MARKER);
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("contract.redact is a no-op when no secrets resolved (legacy path)", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(makeInput({ agent }));
    expect(result.redact("plain diagnostic text")).toBe("plain diagnostic text");
  });

  // AC: @runner-invocation-semantics ac-session-env-injected-through-runner
  it("routes KSPEC_SESSION_ID through the runner contract on the runner-backed path", () => {
    const registry = buildRegistry(null, {
      runners: { codex: { kind: "acp_process", adapter: "codex-acp" } },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({ agent, registry, sessionId: "01CUSTOM-SESSION-ID000000" }),
    );
    expect(result.env.KSPEC_SESSION_ID).toBe("01CUSTOM-SESSION-ID000000");
    expect(result.env.KSPEC_NO_DAEMON).toBe("1");
  });

  // AC: @runner-invocation-semantics ac-session-env-injected-through-runner
  it("routes KSPEC_SESSION_ID through the runner contract on the legacy/implicit path", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(
      makeInput({ agent, sessionId: "01LEGACY-SESSION-ID00000" }),
    );
    expect(result.env.KSPEC_SESSION_ID).toBe("01LEGACY-SESSION-ID00000");
    expect(result.env.KSPEC_NO_DAEMON).toBe("1");
  });

  // AC: @runner-invocation-semantics ac-session-env-injected-through-runner
  it("threads mutationLockFile into the contract env on the runner-backed path", () => {
    const registry = buildRegistry(null, {
      runners: { codex: { kind: "acp_process", adapter: "codex-acp" } },
    });
    const agent = makeAgent({ runner: "codex" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        registry,
        mutationLockFile: "/tmp/kspec-shadow-mutation.lock",
      }),
    );
    expect(result.env.KSPEC_SHADOW_MUTATION_LOCK_FILE).toBe("/tmp/kspec-shadow-mutation.lock");
  });

  // AC: @runner-invocation-semantics ac-runner-cleanup-restores-state
  it("returns a no-throw async cleanup hook on both paths", async () => {
    const implicit = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ adapter: "claude-agent-acp" }) }),
    );
    await expect(implicit.cleanup!()).resolves.toBeUndefined();

    const registry = buildRegistry(null, {
      runners: { codex: { kind: "acp_process", adapter: "codex-acp" } },
    });
    const runnerBacked = resolveRunnerInvocation(
      makeInput({ agent: makeAgent({ runner: "codex" }), registry }),
    );
    await expect(runnerBacked.cleanup!()).resolves.toBeUndefined();
  });

  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  it("missing required secret blocks resolution before any spawn-side state is built", () => {
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
    expect(() => resolveRunnerInvocation(makeInput({ agent, registry, hostEnv: {} }))).toThrowError(
      RunnerResolutionError,
    );
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
  // Mixed-layer regression: when one config layer fails to load but another
  // layer still contributes the referenced runner, resolution must still
  // throw runner_registry_unavailable. Resolving against the surviving layer
  // would mask the malformed file and may return a different runner than the
  // operator expects.
  it("blocks with runner_registry_unavailable when one layer fails to load even if the named runner survives from the other layer", () => {
    // Build a registry where the runner name "ok" is contributed by the
    // (surviving) system layer. Project layer is treated as failed via the
    // registryLoadFailures argument.
    const registry = buildRegistry(null, {
      runners: { ok: { kind: "acp_process", adapter: "claude-agent-acp" } },
    });
    const agent = makeAgent({ runner: "ok" });
    expect(() =>
      resolveRunnerInvocation(
        makeInput({
          agent,
          registry,
          registryLoadFailures: [
            {
              reason: "runner_registry_unavailable",
              layer: "project",
              config_path: "/tmp/project.runners.yaml",
              issues: [{ path: "runners.broken", message: "unterminated flow sequence" }],
            },
          ],
        }),
      ),
    ).toThrowError(RunnerResolutionError);

    try {
      resolveRunnerInvocation(
        makeInput({
          agent,
          registry,
          registryLoadFailures: [
            {
              reason: "runner_registry_unavailable",
              layer: "project",
              config_path: "/tmp/project.runners.yaml",
              issues: [{ path: "runners.broken", message: "unterminated flow sequence" }],
            },
          ],
        }),
      );
    } catch (err) {
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("runner_registry_unavailable");
      const failures = (e.details as { failures?: Array<{ layer: string; config_path: string }> })
        .failures;
      expect(Array.isArray(failures)).toBe(true);
      expect(failures!.length).toBeGreaterThan(0);
      expect(failures![0].layer).toBe("project");
      expect(failures![0].config_path).toBe("/tmp/project.runners.yaml");
    }
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
  // Legacy adapter-only agents must remain resolvable even when registry
  // load fails — they do not depend on the runner registry.
  it("does not block legacy adapter-only agents when the registry has load failures", () => {
    const agent = makeAgent({ adapter: "claude-agent-acp" });
    const result = resolveRunnerInvocation(
      makeInput({
        agent,
        registry: { runners: {} },
        registryLoadFailures: [
          {
            reason: "runner_registry_unavailable",
            layer: "system",
            config_path: "/tmp/system-runners.yaml",
            issues: [{ path: "", message: "malformed YAML" }],
          },
        ],
      }),
    );
    expect(result.diagnostics.selectedRunner.source).toBe("implicit");
    expect(result.diagnostics.selectedAdapter.id).toBe("claude-agent-acp");
  });
});
