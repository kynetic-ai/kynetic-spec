/**
 * Tests for layered runner configuration storage, schema, merge, and types.
 *
 * Covers:
 *   @agent-runner-configuration
 *     ac-named-runners-loaded
 *     ac-project-runner-storage-is-repo-managed
 *     ac-system-runner-storage-is-local
 *     ac-system-overrides-project-values
 *     ac-project-layer-accepts-portable-runner-values
 *     ac-project-layer-blocks-known-secret-keys
 *     ac-effective-runner-kind-and-adapter-required
 *   @runner-environment-secret-boundaries
 *     ac-project-env-literals-are-non-secret
 *     ac-secret-env-names-use-bindings
 *     ac-secret-bindings-system-only
 *     ac-secret-values-not-stored-inline
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveProjectKey,
  deriveProjectKeySync,
  getProjectRunnersPath,
  getSystemRunnersPath,
  isSecretEnvName,
  loadProjectRunnerConfig,
  loadSystemRunnerConfig,
  mergeRunnerConfigs,
  PROJECT_RUNNERS_FILENAME,
  ProjectRunnerConfigSchema,
  resolveEffectiveRunners,
  SYSTEM_RUNNERS_FILENAME,
  SystemRunnerConfigSchema,
  type ProjectRunnerConfig,
  type SystemRunnerConfig,
} from "../src/agents/runner-config.js";
import { listAdapters, registerAdapter } from "../src/agents/adapters.js";

import { cleanupTempDir, createTempDir, initGitRepo } from "./helpers/cli.js";

interface Fixture {
  projectRoot: string;
  shadowDir: string;
  daemonConfigDir: string;
}

/**
 * Build a temp project root with a shadow worktree directory plus a
 * separate temp daemon config dir. Both layer files start absent.
 */
async function createFixture(): Promise<Fixture> {
  const projectRoot = await createTempDir("kspec-runner-config-");
  initGitRepo(projectRoot);
  const shadowDir = path.join(projectRoot, ".kspec");
  await fs.mkdir(shadowDir, { recursive: true });

  const daemonConfigDir = await createTempDir("kspec-runner-daemon-");

  return { projectRoot, shadowDir, daemonConfigDir };
}

async function writeProjectLayer(fixture: Fixture, contents: string): Promise<void> {
  await fs.writeFile(getProjectRunnersPath(fixture.shadowDir), contents, "utf-8");
}

async function writeSystemLayer(fixture: Fixture, contents: string): Promise<void> {
  const filePath = await getSystemRunnersPath(fixture.projectRoot, {
    daemonConfigDir: fixture.daemonConfigDir,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf-8");
}

describe("runner-config: project key derivation", () => {
  let projectRoot: string;
  beforeEach(async () => {
    projectRoot = await createTempDir("kspec-runner-key-");
  });
  afterEach(async () => {
    await cleanupTempDir(projectRoot);
  });

  // AC: @agent-runner-configuration ac-system-runner-storage-is-local
  it("deriveProjectKey returns a lowercase 64-char hex sha256 digest", async () => {
    const key = await deriveProjectKey(projectRoot);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  // AC: @agent-runner-configuration ac-system-runner-storage-is-local
  it("deriveProjectKey is stable across calls and matches sync variant", async () => {
    const key1 = await deriveProjectKey(projectRoot);
    const key2 = await deriveProjectKey(projectRoot);
    const sync = deriveProjectKeySync(projectRoot);
    expect(key1).toBe(key2);
    expect(sync).toBe(key1);
  });

  // AC: @agent-runner-configuration ac-system-runner-storage-is-local
  it("deriveProjectKey never embeds the raw project path", async () => {
    const key = await deriveProjectKey(projectRoot);
    expect(key).not.toContain(path.basename(projectRoot));
    expect(key).not.toContain("/");
    expect(key.length).toBe(64);
  });

  // AC: @agent-runner-configuration ac-system-runner-storage-is-local
  it("getSystemRunnersPath places runners.yaml under projects/<project-key>/", async () => {
    const daemonConfigDir = await createTempDir("kspec-runner-daemon-key-");
    try {
      const filePath = await getSystemRunnersPath(projectRoot, { daemonConfigDir });
      const key = await deriveProjectKey(projectRoot);
      expect(filePath).toBe(path.join(daemonConfigDir, "projects", key, SYSTEM_RUNNERS_FILENAME));
    } finally {
      await cleanupTempDir(daemonConfigDir);
    }
  });

  // AC: @agent-runner-configuration ac-project-runner-storage-is-repo-managed
  it("getProjectRunnersPath places project.runners.yaml in the shadow worktree", async () => {
    const shadowDir = path.join(projectRoot, ".kspec");
    await fs.mkdir(shadowDir, { recursive: true });
    expect(getProjectRunnersPath(shadowDir)).toBe(path.join(shadowDir, PROJECT_RUNNERS_FILENAME));
    expect(getProjectRunnersPath(shadowDir).endsWith(PROJECT_RUNNERS_FILENAME)).toBe(true);
  });
});

describe("runner-config: secret-key detection", () => {
  // AC: @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret
  // AC: @runner-environment-secret-boundaries ac-secret-env-names-use-bindings
  it("flags well-known credential variable names as secret", () => {
    expect(isSecretEnvName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSecretEnvName("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(isSecretEnvName("OPENAI_API_KEY")).toBe(true);
    expect(isSecretEnvName("GITHUB_TOKEN")).toBe(true);
    expect(isSecretEnvName("anthropic_api_key")).toBe(true);
  });

  // AC: @runner-environment-secret-boundaries ac-secret-env-names-use-bindings
  it("flags names containing secret-looking substrings", () => {
    expect(isSecretEnvName("MY_API_KEY")).toBe(true);
    expect(isSecretEnvName("CUSTOM_AUTH_TOKEN")).toBe(true);
    expect(isSecretEnvName("ACME_ACCESS_TOKEN")).toBe(true);
    expect(isSecretEnvName("FOO_OAUTH_TOKEN")).toBe(true);
    expect(isSecretEnvName("DATABASE_PASSWORD")).toBe(true);
    expect(isSecretEnvName("PRIVATE_SECRET")).toBe(true);
  });

  it("does not flag plain non-secret names", () => {
    expect(isSecretEnvName("PATH")).toBe(false);
    expect(isSecretEnvName("LANG")).toBe(false);
    expect(isSecretEnvName("KSPEC_NO_DAEMON")).toBe(false);
    expect(isSecretEnvName("NODE_ENV")).toBe(false);
  });
});

describe("runner-config: project layer schema", () => {
  // AC: @agent-runner-configuration ac-project-layer-accepts-portable-runner-values
  it("accepts portable env.set entries, privacy, and diagnostics", () => {
    const result = ProjectRunnerConfigSchema.safeParse({
      runners: {
        claude: {
          env: { set: { NODE_ENV: "production", LANG: "en_US.UTF-8" } },
          privacy: { disable_nonessential_traffic: true },
          diagnostics: { retain_raw_logs: "on_failure" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  // AC: @agent-runner-configuration ac-project-layer-blocks-known-secret-keys
  // AC: @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret
  it("rejects known credential env names in env.set", () => {
    const result = ProjectRunnerConfigSchema.safeParse({
      runners: {
        claude: { env: { set: { ANTHROPIC_API_KEY: "sk-xxx" } } },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("\n");
      expect(message).toMatch(/ANTHROPIC_API_KEY/);
    }
  });

  // AC: @runner-environment-secret-boundaries ac-secret-env-names-use-bindings
  it("rejects substring-matched secret-looking env names with guidance", () => {
    const result = ProjectRunnerConfigSchema.safeParse({
      runners: {
        claude: { env: { set: { CUSTOM_AUTH_TOKEN: "abc" } } },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("\n");
      expect(message).toMatch(/env\.secrets/i);
    }
  });

  // AC: @runner-environment-secret-boundaries ac-secret-bindings-system-only
  it("rejects env.secrets bindings from the project layer", () => {
    const result = ProjectRunnerConfigSchema.safeParse({
      runners: {
        claude: {
          env: {
            secrets: { ANTHROPIC_API_KEY: { source: "user_env", required: true } },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  // AC: @agent-runner-configuration ac-project-runner-storage-is-repo-managed
  it("rejects operational fields (kind, adapter, process) from the project layer", () => {
    const kindResult = ProjectRunnerConfigSchema.safeParse({
      runners: { claude: { kind: "acp_process" } },
    });
    expect(kindResult.success).toBe(false);

    const adapterResult = ProjectRunnerConfigSchema.safeParse({
      runners: { claude: { adapter: "claude-agent-acp" } },
    });
    expect(adapterResult.success).toBe(false);

    const processResult = ProjectRunnerConfigSchema.safeParse({
      runners: { claude: { process: { executable: "/usr/bin/claude" } } },
    });
    expect(processResult.success).toBe(false);
  });
});

describe("runner-config: system layer schema", () => {
  // AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
  it("accepts a complete acp_process runner with all explicit fields", () => {
    const result = SystemRunnerConfigSchema.safeParse({
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          process: { executable: "/usr/local/bin/claude", args: ["--verbose"], cwd: "/tmp" },
          env: {
            inherit: "minimal",
            pass: ["PATH", "HOME"],
            set: { NODE_ENV: "production" },
            secrets: { ANTHROPIC_API_KEY: { source: "user_env", required: true } },
          },
          privacy: { disable_nonessential_traffic: true },
          diagnostics: { retain_raw_logs: "always" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  // AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
  it("rejects an entry that is missing kind", () => {
    const result = SystemRunnerConfigSchema.safeParse({
      runners: { claude: { adapter: "claude-agent-acp" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("kind"))).toBe(true);
    }
  });

  // AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
  it("rejects an entry that is missing adapter", () => {
    const result = SystemRunnerConfigSchema.safeParse({
      runners: { claude: { kind: "acp_process" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("adapter"))).toBe(true);
    }
  });

  // AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
  it("rejects unknown kind values", () => {
    const result = SystemRunnerConfigSchema.safeParse({
      runners: { claude: { kind: "headed_sidecar", adapter: "claude-agent-acp" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown env.inherit values", () => {
    const result = SystemRunnerConfigSchema.safeParse({
      runners: {
        claude: { kind: "acp_process", adapter: "claude-agent-acp", env: { inherit: "all" } },
      },
    });
    expect(result.success).toBe(false);
  });

  // AC: @runner-environment-secret-boundaries ac-secret-env-names-use-bindings
  it("rejects secret-looking env.set names from the system layer too", () => {
    const result = SystemRunnerConfigSchema.safeParse({
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          env: { set: { OPENAI_API_KEY: "sk-xxx" } },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("\n");
      expect(message).toMatch(/env\.secrets/i);
    }
  });

  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  it("rejects secret bindings that include inline value fields", () => {
    const result = SystemRunnerConfigSchema.safeParse({
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          env: {
            secrets: {
              ANTHROPIC_API_KEY: { source: "user_env", value: "sk-xxx" },
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  // AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
  it("rejects an adapter that is not in the registered adapter list", () => {
    const result = SystemRunnerConfigSchema.safeParse({
      runners: {
        claude: { kind: "acp_process", adapter: "definitely-not-registered" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const adapterIssue = result.error.issues.find((i) => i.path[i.path.length - 1] === "adapter");
      expect(adapterIssue).toBeDefined();
      expect(adapterIssue?.message).toMatch(/not a registered adapter/i);
      // Message should also surface the registered adapter list so operators
      // can self-correct without reading source.
      expect(adapterIssue?.message).toMatch(/claude-agent-acp/);
    }
  });

  // AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
  it("accepts each built-in registered adapter", () => {
    for (const adapter of listAdapters()) {
      const result = SystemRunnerConfigSchema.safeParse({
        runners: { x: { kind: "acp_process", adapter } },
      });
      expect(result.success, `expected ${adapter} to be accepted`).toBe(true);
    }
  });

  // AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
  it("accepts adapters registered at runtime via registerAdapter", () => {
    const customId = "test-runner-config-custom-adapter";
    registerAdapter(customId, { command: "node", args: [] });
    const result = SystemRunnerConfigSchema.safeParse({
      runners: { x: { kind: "acp_process", adapter: customId } },
    });
    expect(result.success).toBe(true);
  });

  // AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
  it("propagates unknown adapter rejection through the loader", async () => {
    const fixture = await createFixture();
    try {
      await writeSystemLayer(
        fixture,
        `
runners:
  claude:
    kind: acp_process
    adapter: not-a-real-adapter
`.trimStart(),
      );
      const systemLoad = await loadSystemRunnerConfig(fixture.projectRoot, {
        daemonConfigDir: fixture.daemonConfigDir,
      });
      expect(systemLoad.loaded).toBe(true);
      expect(systemLoad.config).toBeNull();
      expect(systemLoad.issues).not.toBeNull();
      const adapterPath = systemLoad.issues?.find((i) => i.path.endsWith("adapter"));
      expect(adapterPath).toBeDefined();
      expect(adapterPath?.message).toMatch(/not a registered adapter/i);
    } finally {
      await cleanupTempDir(fixture.projectRoot);
      await cleanupTempDir(fixture.daemonConfigDir);
    }
  });

  it("accepts process.cwd as both absolute and relative paths", () => {
    const absolute = SystemRunnerConfigSchema.safeParse({
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          process: { cwd: "/var/lib/kspec/runner" },
        },
      },
    });
    expect(absolute.success).toBe(true);

    const relative = SystemRunnerConfigSchema.safeParse({
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          process: { cwd: "workdir/runner" },
        },
      },
    });
    expect(relative.success).toBe(true);
  });
});

describe("runner-config: loaders", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await cleanupTempDir(fixture.projectRoot);
    await cleanupTempDir(fixture.daemonConfigDir);
  });

  // AC: @agent-runner-configuration ac-named-runners-loaded
  // (no runners defined → empty registry; loader does not error)
  it("returns loaded=false when neither layer file exists", async () => {
    const projectLoad = await loadProjectRunnerConfig(fixture.shadowDir);
    const systemLoad = await loadSystemRunnerConfig(fixture.projectRoot, {
      daemonConfigDir: fixture.daemonConfigDir,
    });
    expect(projectLoad.loaded).toBe(false);
    expect(projectLoad.config).toBeNull();
    expect(systemLoad.loaded).toBe(false);
    expect(systemLoad.config).toBeNull();

    const resolved = await resolveEffectiveRunners({
      projectRoot: fixture.projectRoot,
      shadowWorktreeDir: fixture.shadowDir,
      daemonConfigDir: fixture.daemonConfigDir,
    });
    expect(Object.keys(resolved.registry.runners)).toEqual([]);
  });

  // AC: @agent-runner-configuration ac-named-runners-loaded
  // AC: @agent-runner-configuration ac-project-layer-accepts-portable-runner-values
  it("loads project-only portable values (no effective runner without system kind/adapter)", async () => {
    await writeProjectLayer(
      fixture,
      `
runners:
  claude:
    env:
      set:
        NODE_ENV: production
    privacy:
      disable_nonessential_traffic: true
`.trimStart(),
    );

    const projectLoad = await loadProjectRunnerConfig(fixture.shadowDir);
    expect(projectLoad.loaded).toBe(true);
    expect(projectLoad.issues).toBeNull();
    const claudeProject = (projectLoad.config as ProjectRunnerConfig)?.runners?.claude;
    expect(claudeProject?.env?.set).toEqual({ NODE_ENV: "production" });
    expect(claudeProject?.privacy?.disable_nonessential_traffic).toBe(true);

    const resolved = await resolveEffectiveRunners({
      projectRoot: fixture.projectRoot,
      shadowWorktreeDir: fixture.shadowDir,
      daemonConfigDir: fixture.daemonConfigDir,
    });
    // Project-only entries are not effective on their own — kind/adapter required.
    expect(Object.keys(resolved.registry.runners)).toEqual([]);
  });

  // AC: @agent-runner-configuration ac-named-runners-loaded
  // AC: @agent-runner-configuration ac-system-runner-storage-is-local
  it("loads system-only runners and exposes them in the effective registry", async () => {
    await writeSystemLayer(
      fixture,
      `
runners:
  claude:
    kind: acp_process
    adapter: claude-agent-acp
`.trimStart(),
    );

    const systemLoad = await loadSystemRunnerConfig(fixture.projectRoot, {
      daemonConfigDir: fixture.daemonConfigDir,
    });
    expect(systemLoad.loaded).toBe(true);
    expect(systemLoad.issues).toBeNull();

    const resolved = await resolveEffectiveRunners({
      projectRoot: fixture.projectRoot,
      shadowWorktreeDir: fixture.shadowDir,
      daemonConfigDir: fixture.daemonConfigDir,
    });
    expect(Object.keys(resolved.registry.runners)).toEqual(["claude"]);
    const claude = resolved.registry.runners.claude;
    expect(claude.kind).toBe("acp_process");
    expect(claude.adapter).toBe("claude-agent-acp");
    // Defaults applied.
    expect(claude.env.inherit).toBe("minimal");
    expect(claude.privacy.disable_nonessential_traffic).toBe(true);
    expect(claude.diagnostics.retain_raw_logs).toBe("on_failure");
    expect(claude.env.pass).toEqual([]);
    expect(claude.env.set).toEqual({});
    expect(claude.env.secrets).toEqual({});
    expect(claude.sources.envInherit).toBe("default");
    expect(claude.sources.privacyDisableNonessentialTraffic).toBe("default");
    expect(claude.sources.diagnosticsRetainRawLogs).toBe("default");
  });

  // AC: @agent-runner-configuration ac-project-layer-blocks-known-secret-keys
  // AC: @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret
  it("rejects project layer files containing secret-looking env.set entries", async () => {
    await writeProjectLayer(
      fixture,
      `
runners:
  claude:
    env:
      set:
        ANTHROPIC_API_KEY: sk-secret
`.trimStart(),
    );

    const projectLoad = await loadProjectRunnerConfig(fixture.shadowDir);
    expect(projectLoad.loaded).toBe(true);
    expect(projectLoad.config).toBeNull();
    expect(projectLoad.issues).not.toBeNull();
    const message = projectLoad.issues?.map((i) => i.message).join("\n") ?? "";
    expect(message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("returns issues when a system layer file omits required kind", async () => {
    await writeSystemLayer(
      fixture,
      `
runners:
  claude:
    adapter: claude-agent-acp
`.trimStart(),
    );

    const systemLoad = await loadSystemRunnerConfig(fixture.projectRoot, {
      daemonConfigDir: fixture.daemonConfigDir,
    });
    expect(systemLoad.loaded).toBe(true);
    expect(systemLoad.config).toBeNull();
    expect(systemLoad.issues).not.toBeNull();
    const paths = systemLoad.issues?.map((i) => i.path) ?? [];
    expect(paths.some((p) => p.endsWith("kind"))).toBe(true);
  });

  it("returns issues when a system layer file omits required adapter", async () => {
    await writeSystemLayer(
      fixture,
      `
runners:
  claude:
    kind: acp_process
`.trimStart(),
    );

    const systemLoad = await loadSystemRunnerConfig(fixture.projectRoot, {
      daemonConfigDir: fixture.daemonConfigDir,
    });
    expect(systemLoad.loaded).toBe(true);
    expect(systemLoad.config).toBeNull();
    expect(systemLoad.issues).not.toBeNull();
    const paths = systemLoad.issues?.map((i) => i.path) ?? [];
    expect(paths.some((p) => p.endsWith("adapter"))).toBe(true);
  });

  it("skips the project layer entirely when shadow context is not yet available", async () => {
    await writeProjectLayer(
      fixture,
      `
runners:
  claude:
    env:
      set:
        NODE_ENV: production
`.trimStart(),
    );
    await writeSystemLayer(
      fixture,
      `
runners:
  claude:
    kind: acp_process
    adapter: claude-agent-acp
`.trimStart(),
    );

    const resolved = await resolveEffectiveRunners({
      projectRoot: fixture.projectRoot,
      daemonConfigDir: fixture.daemonConfigDir,
    });
    expect(resolved.project.loaded).toBe(false);
    expect(resolved.system.loaded).toBe(true);
    // Project env.set NOT applied because project layer was skipped.
    expect(resolved.registry.runners.claude.env.set).toEqual({});
    expect(resolved.registry.runners.claude.sources.envSet.keys).toEqual({});
  });
});

describe("runner-config: merge semantics", () => {
  // AC: @agent-runner-configuration ac-system-overrides-project-values
  it("system scalar values replace project scalar values per field", () => {
    const project: ProjectRunnerConfig = {
      runners: {
        claude: {
          privacy: { disable_nonessential_traffic: false },
          diagnostics: { retain_raw_logs: "always" },
        },
      },
    };
    const system: SystemRunnerConfig = {
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          privacy: { disable_nonessential_traffic: true },
          diagnostics: { retain_raw_logs: "never" },
        },
      },
    };

    const registry = mergeRunnerConfigs(project, system);
    const claude = registry.runners.claude;
    expect(claude.privacy.disable_nonessential_traffic).toBe(true);
    expect(claude.diagnostics.retain_raw_logs).toBe("never");
    expect(claude.sources.privacyDisableNonessentialTraffic).toBe("system");
    expect(claude.sources.diagnosticsRetainRawLogs).toBe("system");
    expect(claude.sources.overriddenBySystem).toContain("privacy.disable_nonessential_traffic");
    expect(claude.sources.overriddenBySystem).toContain("diagnostics.retain_raw_logs");
  });

  // AC: @agent-runner-configuration ac-system-overrides-project-values
  it("system env.set keys override project env.set keys with the same name", () => {
    const project: ProjectRunnerConfig = {
      runners: {
        claude: {
          env: { set: { LOG_LEVEL: "info", NODE_ENV: "production" } },
        },
      },
    };
    const system: SystemRunnerConfig = {
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          env: { set: { LOG_LEVEL: "debug", EXTRA: "1" } },
        },
      },
    };

    const claude = mergeRunnerConfigs(project, system).runners.claude;
    expect(claude.env.set).toEqual({ LOG_LEVEL: "debug", NODE_ENV: "production", EXTRA: "1" });
    expect(claude.sources.envSet.keys.LOG_LEVEL).toBe("system");
    expect(claude.sources.envSet.keys.NODE_ENV).toBe("project");
    expect(claude.sources.envSet.keys.EXTRA).toBe("system");
    expect(claude.sources.overriddenBySystem).toContain("env.set.LOG_LEVEL");
  });

  // AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
  it("omits runners that exist only in the project layer (no kind/adapter)", () => {
    const project: ProjectRunnerConfig = {
      runners: { codex: { env: { set: { LOG_LEVEL: "info" } } } },
    };
    const system: SystemRunnerConfig = { runners: {} };
    const registry = mergeRunnerConfigs(project, system);
    expect(Object.keys(registry.runners)).toEqual([]);
  });

  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  it("preserves env.secrets source bindings without persisting any value field", () => {
    const system: SystemRunnerConfig = {
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          env: {
            secrets: { ANTHROPIC_API_KEY: { source: "user_env", required: true } },
          },
        },
      },
    };

    const claude = mergeRunnerConfigs(null, system).runners.claude;
    expect(claude.env.secrets.ANTHROPIC_API_KEY).toEqual({
      source: "user_env",
      required: true,
    });
    const serialized = JSON.stringify(claude);
    expect(serialized).not.toMatch(/sk-/);
    expect(serialized).not.toMatch(/"value":/);
    expect(serialized).not.toMatch(/"token":/);
  });

  // AC: @agent-runner-configuration ac-named-runners-loaded
  it("preserves multiple named runners and keeps their entries independent", () => {
    const system: SystemRunnerConfig = {
      runners: {
        claude: { kind: "acp_process", adapter: "claude-agent-acp" },
        codex: { kind: "acp_process", adapter: "codex-acp" },
      },
    };
    const registry = mergeRunnerConfigs(null, system);
    expect(Object.keys(registry.runners).toSorted()).toEqual(["claude", "codex"]);
    expect(registry.runners.claude.adapter).toBe("claude-agent-acp");
    expect(registry.runners.codex.adapter).toBe("codex-acp");
  });
});

// ─── AC: ac-relative-system-cwd-resolves-from-config-dir ─────────────────────

describe("runner-config: system process.cwd resolves deterministically", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await cleanupTempDir(fixture.projectRoot);
    await cleanupTempDir(fixture.daemonConfigDir);
  });

  // AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
  it("mergeRunnerConfigs resolves relative system cwd against the system config dir", () => {
    const system: SystemRunnerConfig = {
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          process: { cwd: "workdir/runner" },
        },
      },
    };
    const systemConfigPath = "/etc/kspec/projects/abc/runners.yaml";
    const registry = mergeRunnerConfigs(null, system, { systemConfigPath });
    expect(registry.runners.claude.process.cwd).toBe("/etc/kspec/projects/abc/workdir/runner");
    expect(registry.runners.claude.sources.processCwd).toBe("system");
  });

  // AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
  it("mergeRunnerConfigs keeps absolute system cwd absolute (normalized)", () => {
    const system: SystemRunnerConfig = {
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          process: { cwd: "/var/lib/kspec/./runner/../runner" },
        },
      },
    };
    const systemConfigPath = "/etc/kspec/projects/abc/runners.yaml";
    const registry = mergeRunnerConfigs(null, system, { systemConfigPath });
    // path.resolve normalizes `.` and `..` but the value remains absolute.
    expect(path.isAbsolute(registry.runners.claude.process.cwd!)).toBe(true);
    expect(registry.runners.claude.process.cwd).toBe("/var/lib/kspec/runner");
  });

  // AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
  it("mergeRunnerConfigs does not consult the parent process cwd for relative system cwd", () => {
    const system: SystemRunnerConfig = {
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          process: { cwd: "relative-subdir" },
        },
      },
    };
    const systemConfigPath = "/etc/kspec/projects/abc/runners.yaml";
    const originalCwd = process.cwd();
    // Move the parent process cwd to a different directory and re-merge.
    // The resolved cwd must not depend on process.cwd().
    process.chdir(fixture.projectRoot);
    try {
      const registry = mergeRunnerConfigs(null, system, { systemConfigPath });
      expect(registry.runners.claude.process.cwd).toBe("/etc/kspec/projects/abc/relative-subdir");
      expect(registry.runners.claude.process.cwd).not.toContain(fixture.projectRoot);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
  it("resolveEffectiveRunners passes the system config path so relative cwd resolves there", async () => {
    await writeSystemLayer(
      fixture,
      [
        "runners:",
        "  claude:",
        "    kind: acp_process",
        "    adapter: claude-agent-acp",
        "    process:",
        "      cwd: ./agents-cwd",
        "",
      ].join("\n"),
    );

    const resolved = await resolveEffectiveRunners({
      projectRoot: fixture.projectRoot,
      shadowWorktreeDir: fixture.shadowDir,
      daemonConfigDir: fixture.daemonConfigDir,
    });
    const expectedDir = path.dirname(resolved.system.path);
    expect(resolved.registry.runners.claude.process.cwd).toBe(path.join(expectedDir, "agents-cwd"));
    expect(path.isAbsolute(resolved.registry.runners.claude.process.cwd!)).toBe(true);
  });

  // AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
  it("resolveEffectiveRunners keeps absolute system cwd absolute", async () => {
    await writeSystemLayer(
      fixture,
      [
        "runners:",
        "  claude:",
        "    kind: acp_process",
        "    adapter: claude-agent-acp",
        "    process:",
        "      cwd: /opt/kspec/agents-cwd",
        "",
      ].join("\n"),
    );

    const resolved = await resolveEffectiveRunners({
      projectRoot: fixture.projectRoot,
      shadowWorktreeDir: fixture.shadowDir,
      daemonConfigDir: fixture.daemonConfigDir,
    });
    expect(resolved.registry.runners.claude.process.cwd).toBe("/opt/kspec/agents-cwd");
  });

  // AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
  it("resolveEffectiveRunners produces the same cwd regardless of parent process cwd", async () => {
    await writeSystemLayer(
      fixture,
      [
        "runners:",
        "  claude:",
        "    kind: acp_process",
        "    adapter: claude-agent-acp",
        "    process:",
        "      cwd: relative-from-config",
        "",
      ].join("\n"),
    );

    const originalCwd = process.cwd();
    const resolvedFromRoot = await resolveEffectiveRunners({
      projectRoot: fixture.projectRoot,
      shadowWorktreeDir: fixture.shadowDir,
      daemonConfigDir: fixture.daemonConfigDir,
    });

    process.chdir(fixture.projectRoot);
    try {
      const resolvedFromProject = await resolveEffectiveRunners({
        projectRoot: fixture.projectRoot,
        shadowWorktreeDir: fixture.shadowDir,
        daemonConfigDir: fixture.daemonConfigDir,
      });
      expect(resolvedFromProject.registry.runners.claude.process.cwd).toBe(
        resolvedFromRoot.registry.runners.claude.process.cwd,
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  // AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
  it("mergeRunnerConfigs preserves a relative cwd verbatim when no systemConfigPath is supplied", () => {
    // This is the test-only raw-merge contract: callers that did not load the
    // system file from disk cannot get cwd resolution. resolveEffectiveRunners
    // is the supported entry point for cwd-sensitive behavior.
    const system: SystemRunnerConfig = {
      runners: {
        claude: {
          kind: "acp_process",
          adapter: "claude-agent-acp",
          process: { cwd: "still-relative" },
        },
      },
    };
    const registry = mergeRunnerConfigs(null, system);
    expect(registry.runners.claude.process.cwd).toBe("still-relative");
  });
});

describe("runner-config: existing kspec.config.yaml behavior", () => {
  // Regression check — this task must not change project config behavior.
  it("does not introduce any read of kspec.config.yaml", async () => {
    // Project layer is gated on shadow dir; system layer is daemon-config-dir.
    // Neither helper accepts or returns kspec.config.yaml content. Verify via
    // a behavioral resolve: project layer is skipped without shadowWorktreeDir.
    const projectRoot = await createTempDir("kspec-runner-noconfig-");
    initGitRepo(projectRoot);
    try {
      await fs.writeFile(
        path.join(projectRoot, "kspec.config.yaml"),
        "daemon:\n  port: 9999\n",
        "utf-8",
      );
      const daemonConfigDir = await createTempDir("kspec-runner-noconfig-daemon-");
      try {
        const resolved = await resolveEffectiveRunners({
          projectRoot,
          daemonConfigDir,
        });
        expect(resolved.project.loaded).toBe(false);
        expect(resolved.system.loaded).toBe(false);
        expect(resolved.registry.runners).toEqual({});
      } finally {
        await cleanupTempDir(daemonConfigDir);
      }
    } finally {
      await cleanupTempDir(projectRoot);
    }
  });
});
