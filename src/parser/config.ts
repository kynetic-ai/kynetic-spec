/**
 * Project-level configuration for kspec.
 *
 * Loads kspec.config.yaml from the project root (main branch) before shadow
 * branch detection. All fields are optional with backward-compatible defaults.
 *
 * Priority: env vars > config file > defaults
 *
 * @module
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import { z } from "zod";
import { DEFAULT_DAEMON_LOG_MAX_SIZE_BYTES } from "../daemon-shared/endpoint.js";
import { getGitRoot } from "./shadow.js";

// ── Schema ──────────────────────────────────────────────────────────────

/**
 * Schema for shadow branch configuration.
 *
 * AC: @config-shadow — shadow.branch, shadow.directory, shadow.remote configurable
 */
const ShadowConfigSchema = z
  .object({
    /** Branch name for shadow branch (default: kspec-meta) */
    branch: z.string().optional(),
    /** Worktree directory name (default: .kspec) */
    directory: z.string().optional(),
    /**
     * Remote target for shadow branch. Can be:
     * - Named remote (e.g., "origin", "specs-origin")
     * - Local filesystem path (starts with /, ./, or ~)
     * - Git URL (contains :// or starts with git@)
     */
    remote: z.string().optional(),
    /**
     * Interval in seconds for periodic background shadow pull in daemon mode.
     * Set to 0 to disable periodic sync. Default: 60.
     *
     * AC: @config-shadow ac-12 — configurable sync interval for daemon background pull
     */
    sync_interval: z.number().int().min(0).optional(),
  })
  .strict()
  .optional();

/**
 * Schema for identity configuration.
 */
const IdentityConfigSchema = z
  .object({
    /** Default author for notes/tasks (overridden by KSPEC_AUTHOR env var) */
    author: z.string().optional(),
  })
  .strict()
  .optional();

/**
 * Schema for validation configuration.
 *
 * AC: @config-validation — validation settings configurable in kspec.config.yaml
 */
const ValidationConfigSchema = z
  .object({
    /**
     * When true, dangling references are treated as errors instead of warnings.
     * AC: @config-validation ac-2 ac-3 — strict_refs configurable
     */
    strict_refs: z.boolean().optional(),
    /**
     * When true, specs missing acceptance criteria are reported as errors not warnings.
     * AC: @config-validation ac-1 — require_acceptance configurable
     */
    require_acceptance: z.boolean().optional(),
  })
  .strict()
  .optional();

/**
 * Schema for daemon configuration.
 *
 * AC: @config-daemon — daemon.port, daemon.auto_start configurable
 */
const DaemonConfigSchema = z
  .object({
    /** Default port for daemon (default: 3456) */
    port: z.number().int().min(1).max(65535).optional(),
    /**
     * Host to bind to. Default is the numeric IPv4 loopback 127.0.0.1
     * (avoids /etc/hosts and DNS resolution differences).
     *
     * AC: @config-daemon ac-host-default
     * AC: @config-daemon ac-host-config
     * AC: @config-daemon ac-host-env-precedence
     */
    host: z.string().optional(),
    /**
     * Host that local clients should connect to. When the daemon binds
     * a wildcard address (0.0.0.0 / ::), clients use this host to reach
     * it. When omitted, defaults to a loopback derived from `host`.
     *
     * AC: @config-daemon ac-connect-host-config
     */
    connect_host: z.string().optional(),
    /**
     * JavaScript runtime used to spawn the daemon (default: node).
     * AC: @daemon-runtime-adapter ac-runtime-selection
     * AC: @daemon-runtime-adapter ac-default-node
     */
    runtime: z.enum(["bun", "node"]).optional(),
    /**
     * Whether to auto-start daemon when running kspec commands.
     * AC: @config-daemon ac-3 — auto_start configurable
     */
    auto_start: z.boolean().optional(),
    /**
     * Maximum size in bytes of the active daemon log file before
     * rotation (default: 5 MiB).
     * AC: @daemon-log-capture ac-bounded-rotation
     */
    log_max_size_bytes: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const DispatchBootstrapStepSchema = z
  .object({
    run: z.string().min(1),
    name: z.string().optional(),
    roles: z.array(z.enum(["worker", "reviewer"])).optional(),
    idempotent: z.boolean().optional(),
    allow_tracked_changes: z.boolean().optional(),
    reviewer_rerun_allowed: z.boolean().optional(),
  })
  .strict();

const DispatchBootstrapConfigSchema = z
  .object({
    steps: z.array(DispatchBootstrapStepSchema).default([]),
  })
  .strict()
  .optional();

/**
 * Schema for dispatch workspace configuration.
 *
 * AC: @dispatch-sync-configuration — sync_interval, remote_sync configurable
 */
const DispatchConfigSchema = z
  .object({
    /**
     * Base/integration branch used when provisioning task workspaces.
     * When omitted, the dispatcher resolves a deterministic fallback.
     */
    base_branch: z.string().optional(),
    /**
     * Root directory where dispatcher-managed git worktrees live.
     * Relative paths resolve from the project root.
     */
    worktree_root: z.string().optional(),
    /**
     * How dispatched agents publish completed work.
     * - "pull_request": agents create GitHub PRs (requires gh CLI + GitHub remote)
     * - "manual_merge": agents merge locally, no PRs created
     * - "auto": detect based on environment (default, preserves existing behavior)
     */
    publication_mode: z.enum(["pull_request", "manual_merge", "auto"]).optional(),
    /**
     * Dispatcher-owned workspace bootstrap contract.
     * Steps run before agent prompts are delivered.
     */
    bootstrap: DispatchBootstrapConfigSchema,
    /**
     * Interval in seconds for periodic target branch sync in dispatch mode.
     * Set to 0 to disable periodic sync (on-start and before-provision syncs
     * still run). Default: 60.
     *
     * AC: @dispatch-sync-configuration ac-sync-interval
     */
    sync_interval: z.number().int().min(0).optional(),
    /**
     * Whether remote push/pull operations are enabled for dispatch.
     * When false, the engine operates in local-only mode.
     * When omitted, resolved at runtime: true if a remote exists, false otherwise.
     *
     * AC: @dispatch-sync-configuration ac-remote-sync-disabled
     * AC: @dispatch-sync-configuration ac-remote-sync-default
     */
    remote_sync: z.boolean().optional(),
  })
  .strict()
  .optional();

/**
 * Schema for hooks configuration.
 *
 * Controls which agent hooks kspec setup installs/removes.
 * AC: @project-config ac-hooks-section — each hook independently enabled/disabled
 * AC: @project-config ac-hooks-missing-keys — absent keys resolve to defaults
 * AC: @project-config ac-hooks-validation — invalid values produce validation error
 */
const HooksConfigSchema = z
  .object({
    /** Whether to install the checkpoint (Stop) hook. Default: false */
    checkpoint: z.boolean().optional(),
    /** Whether to install the prompt-check (UserPromptSubmit) hook. Default: true */
    prompt_check: z.boolean().optional(),
  })
  .strict()
  .optional();

/**
 * Schema for agent skill name overrides.
 *
 * Agent prompts reference skills by invocation name. These default to
 * kspec: namespace core skills but can be overridden per-project for
 * projects that use project-specific skill names.
 */
const AgentSkillsSchema = z
  .object({
    /** Skill invocation for task-work (default: /kspec:task-work) */
    task_work: z.string().optional(),
    /** Skill invocation for reflect (default: /kspec:reflect) */
    reflect: z.string().optional(),
    /** Skill invocation for PR review (default: /kspec:review) */
    pr_review: z.string().optional(),
  })
  .strict()
  .optional();

/**
 * Schema for agent configuration.
 */
const AgentConfigSchema = z
  .object({
    /** Skill invocation name overrides */
    skills: AgentSkillsSchema,
  })
  .strict()
  .optional();

/**
 * Legacy alias schema for agent configuration.
 *
 * Kept only so existing `ralph:` config blocks continue to parse while the
 * resolved runtime shape stays on `config.agent`.
 */
const LegacyAgentConfigAliasSchema = AgentConfigSchema;

/**
 * Schema for coverage scanning configuration.
 *
 * AC: @coverage-scan-config ac-explicit-opt-in — scanning requires explicit configuration
 * AC: @coverage-scan-config ac-configured-paths — configured paths are scanned
 */
const CoverageConfigSchema = z
  .object({
    /**
     * Directories to scan for AC annotation test files.
     * When empty or absent, no files are scanned (explicit opt-in).
     * Paths are relative to the project root.
     *
     * AC: @coverage-scan-config ac-explicit-opt-in
     * AC: @coverage-scan-config ac-configured-paths
     */
    scan_paths: z.array(z.string()).optional(),
    /**
     * Glob patterns for files to exclude from scanning.
     * Matched against the relative path from rootDir.
     */
    exclude_patterns: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

/**
 * Complete schema for kspec.config.yaml.
 *
 * AC: @project-config ac-4 — unknown fields are ignored via passthrough
 */
export const KspecConfigSchema = z
  .object({
    /** Shadow branch configuration */
    shadow: ShadowConfigSchema,
    /** Identity configuration */
    identity: IdentityConfigSchema,
    /** Validation configuration */
    validation: ValidationConfigSchema,
    /** Daemon configuration */
    daemon: DaemonConfigSchema,
    /** Dispatch workspace configuration */
    dispatch: DispatchConfigSchema,
    /** Agent configuration */
    agent: AgentConfigSchema,
    /** Legacy alias for agent configuration */
    ralph: LegacyAgentConfigAliasSchema,
    /** Hooks installation configuration */
    hooks: HooksConfigSchema,
    /** Coverage scanning configuration */
    coverage: CoverageConfigSchema,
  })
  .passthrough(); // AC: ac-4 — ignore unknown fields

/**
 * Raw config type as parsed from YAML file.
 */
export type KspecConfig = z.infer<typeof KspecConfigSchema>;

/**
 * Remote type for shadow branch configuration.
 * - "named": Git remote name (e.g., "origin", "specs-origin")
 * - "path": Local filesystem path
 * - "url": Git URL (https://, git@, etc.)
 */
export type ShadowRemoteType = "named" | "path" | "url";

/**
 * Resolved shadow remote configuration.
 */
export interface ResolvedShadowRemote {
  /** The remote value from config */
  value: string;
  /** Detected type of the remote */
  type: ShadowRemoteType;
}

/**
 * Detect the type of a shadow remote string.
 *
 * AC: @config-shadow ac-3 ac-4 ac-5 — remote type detection
 *
 * @param remote Remote string from config
 * @returns Detected type: "path" for filesystem, "url" for git URLs, "named" for git remote names
 */
export function detectRemoteType(remote: string): ShadowRemoteType {
  // AC: ac-4 — Local filesystem path (starts with /, ./, ../, or ~)
  if (
    remote.startsWith("/") ||
    remote.startsWith("./") ||
    remote.startsWith("../") ||
    remote.startsWith("~")
  ) {
    return "path";
  }
  // AC: ac-5 — Git URL (contains :// or starts with git@)
  if (remote.includes("://") || remote.startsWith("git@")) {
    return "url";
  }
  // AC: ac-3 — Otherwise it's a named remote
  return "named";
}

/**
 * Resolved config with all values finalized (env vars applied, defaults filled).
 */
export interface ResolvedKspecConfig {
  shadow: {
    /** Branch name (default: kspec-meta) */
    branch: string;
    /** Worktree directory name (default: .kspec) */
    directory: string;
    /** Remote configuration, null if not specified */
    remote: ResolvedShadowRemote | null;
    /**
     * Interval in seconds for periodic background shadow pull in daemon mode.
     * 0 disables periodic sync. Default: 60.
     * AC: @config-shadow ac-12
     */
    sync_interval: number;
  };
  identity: {
    author: string | null;
  };
  validation: {
    /**
     * When true, dangling references are treated as errors instead of warnings.
     * AC: @config-validation ac-2 ac-3
     */
    strict_refs: boolean;
    /**
     * When true, specs missing acceptance criteria are reported as errors not warnings.
     * AC: @config-validation ac-1
     */
    require_acceptance: boolean;
  };
  daemon: {
    port: number;
    host: string;
    /**
     * True when `host` came from an explicit source (config file or env
     * var) rather than the built-in default. Daemon startup uses this
     * to decide whether IPv6 fallback applies — when the user explicitly
     * configured a host, surface bind errors instead of silently
     * switching to ::1.
     *
     * AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
     */
    host_explicitly_configured: boolean;
    /**
     * Explicit host advertised to local clients. Null when no override is
     * configured — callers derive the connect host from `host` (loopback
     * when bind is wildcard).
     *
     * AC: @config-daemon ac-connect-host-config
     */
    connect_host: string | null;
    /**
     * Runtime used to spawn the daemon.
     * AC: @daemon-runtime-adapter ac-runtime-selection
     * AC: @daemon-runtime-adapter ac-default-node
     */
    runtime: "bun" | "node";
    /**
     * Whether to auto-start daemon when running kspec commands.
     * AC: @config-daemon ac-3
     */
    auto_start: boolean;
    /**
     * Maximum size in bytes of the active daemon log file before rotation.
     * AC: @daemon-log-capture ac-bounded-rotation
     */
    log_max_size_bytes: number;
  };
  dispatch: {
    /**
     * Optional configured base branch for dispatcher-managed workspaces.
     * Null means "resolve deterministically at provisioning time".
     */
    base_branch: string | null;
    /**
     * Raw worktree root from config/defaults. Relative paths resolve from the
     * project root when dispatch workspaces are provisioned.
     */
    worktree_root: string;
    /**
     * How dispatched agents publish completed work.
     * "auto" means detect based on environment (gh CLI + GitHub remote).
     */
    publication_mode: "pull_request" | "manual_merge" | "auto";
    bootstrap: {
      steps: Array<{
        run: string;
        name?: string;
        roles?: Array<"worker" | "reviewer">;
        idempotent: boolean;
        allow_tracked_changes: boolean;
        reviewer_rerun_allowed: boolean;
      }>;
    };
    /**
     * Interval in seconds for periodic target branch sync.
     * 0 disables periodic sync. Default: 60.
     * AC: @dispatch-sync-configuration ac-sync-interval
     */
    sync_interval: number;
    /**
     * Whether remote sync is enabled for dispatch branches and target.
     * Null means "not yet resolved" — runtime resolution determines the
     * effective value based on whether a git remote exists.
     * AC: @dispatch-sync-configuration ac-remote-sync-disabled
     * AC: @dispatch-sync-configuration ac-remote-sync-default
     */
    remote_sync: boolean | null;
  };
  agent: {
    skills: {
      /** Skill invocation for task-work (default: /kspec:task-work) */
      task_work: string;
      /** Skill invocation for reflect (default: /kspec:reflect) */
      reflect: string;
      /** Skill invocation for PR review (default: /kspec:review) */
      pr_review: string;
    };
  };
  hooks: {
    /**
     * Whether to install the checkpoint (Stop) hook.
     * Default: false — most dispatch-managed sessions don't need it.
     * AC: @project-config ac-hooks-section
     */
    checkpoint: boolean;
    /**
     * Whether to install the prompt-check (UserPromptSubmit) hook.
     * Default: true — lightweight spec-first reminder.
     * AC: @project-config ac-hooks-section
     */
    prompt_check: boolean;
  };
  coverage: {
    /**
     * Directories to scan for AC annotation test files.
     * Empty array means no scanning (explicit opt-in required).
     *
     * AC: @coverage-scan-config ac-explicit-opt-in
     * AC: @coverage-scan-config ac-configured-paths
     */
    scan_paths: string[];
    /**
     * Glob patterns for files to exclude from scanning.
     * Matched against the relative path from rootDir.
     */
    exclude_patterns: string[];
  };
}

// ── Defaults ────────────────────────────────────────────────────────────

/**
 * Default configuration values.
 *
 * AC: @project-config ac-1 — these are the current defaults
 */
const DEFAULT_CONFIG: ResolvedKspecConfig = {
  shadow: {
    branch: "kspec-meta",
    directory: ".kspec",
    remote: null,
    sync_interval: 60, // AC: @config-shadow ac-12 — default 60s
  },
  identity: {
    author: null,
  },
  validation: {
    // AC: @config-validation — defaults preserve existing behavior
    // strict_refs: true = dangling refs are errors (existing behavior)
    // require_acceptance: false = missing AC is warning (existing behavior)
    strict_refs: true,
    require_acceptance: false,
  },
  daemon: {
    port: 3456,
    // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
    // AC: @config-daemon ac-host-default
    // Numeric IPv4 loopback avoids /etc/hosts and DNS resolution drift.
    host: "127.0.0.1",
    host_explicitly_configured: false,
    connect_host: null,
    runtime: "node",
    auto_start: true, // AC: @config-daemon — default auto-start enabled
    // AC: @daemon-log-capture ac-bounded-rotation — default 5 MiB rotation cap
    log_max_size_bytes: DEFAULT_DAEMON_LOG_MAX_SIZE_BYTES,
  },
  dispatch: {
    base_branch: null,
    worktree_root: ".kspec-worktrees",
    publication_mode: "auto",
    bootstrap: {
      steps: [],
    },
    sync_interval: 60, // AC: @dispatch-sync-configuration ac-sync-interval — default 60s
    remote_sync: null, // AC: @dispatch-sync-configuration ac-remote-sync-default — resolved at runtime
  },
  agent: {
    skills: {
      task_work: "/kspec:task-work",
      reflect: "/kspec:reflect",
      pr_review: "/kspec:review",
    },
  },
  hooks: {
    // AC: @project-config ac-hooks-no-config — defaults when no config
    checkpoint: false, // Disabled by default — dispatch handles task lifecycle
    prompt_check: true, // Enabled by default — lightweight spec-first reminder
  },
  coverage: {
    // AC: @coverage-scan-config ac-explicit-opt-in — empty = no scanning
    scan_paths: [],
    exclude_patterns: [],
  },
};

// ── Loading ─────────────────────────────────────────────────────────────

export const CONFIG_FILENAME = "kspec.config.yaml";

/**
 * Result of loading project config.
 */
export interface LoadConfigResult {
  /** Resolved configuration with all values finalized */
  config: ResolvedKspecConfig;
  /** Path to config file if found, null otherwise */
  configPath: string | null;
  /** Warning message if config had issues but was recoverable */
  warning: string | null;
  /** The git root directory where config was loaded from */
  gitRoot: string | null;
}

/**
 * Find git root directory, handling KSPEC_SPEC_DIR batch mode.
 *
 * AC: @project-config ac-7 — in batch mode, we need the REAL project root
 *
 * When KSPEC_SPEC_DIR is set (batch atomic mode), the cwd might be the temp
 * directory. We need to find the real project root by checking:
 * 1. If KSPEC_BATCH_PROJECT_ROOT is set, use that (set by batch executor)
 * 2. Otherwise, use git root from cwd
 *
 * AC: @project-config ac-6 — loads from git root, not cwd subdirectory
 */
export function findProjectRoot(startDir: string, mainRoot?: string): string | null {
  // In batch mode, the batch executor should set this to the real root
  // before redirecting KSPEC_SPEC_DIR
  const batchRoot = process.env.KSPEC_BATCH_PROJECT_ROOT;
  if (batchRoot) {
    return batchRoot;
  }

  if (mainRoot) {
    return mainRoot;
  }

  // Normal mode: find git root
  return getGitRoot(startDir);
}

/**
 * Load project configuration from kspec.config.yaml.
 *
 * AC: @project-config ac-1 — no config = all defaults
 * AC: @project-config ac-2 — config parsed and available before shadow detection
 * AC: @project-config ac-3 — invalid YAML = defaults + warning
 * AC: @project-config ac-4 — unknown fields ignored
 * AC: @project-config ac-5 — env vars take precedence
 * AC: @project-config ac-6 — loads from git root
 * AC: @project-config ac-7 — batch mode uses real project root
 *
 * @param startDir Starting directory for git root detection
 */
export async function loadProjectConfig(
  startDir: string = process.cwd(),
  mainRoot?: string,
): Promise<LoadConfigResult> {
  const gitRoot = findProjectRoot(startDir, mainRoot);

  if (!gitRoot) {
    // Not in a git repo, use defaults
    return {
      config: resolveConfig(null),
      configPath: null,
      warning: null,
      gitRoot: null,
    };
  }

  const configPath = path.join(gitRoot, CONFIG_FILENAME);

  // Check if config file exists
  try {
    await fs.access(configPath);
  } catch {
    // AC: ac-1 — no config file, use defaults
    return {
      config: resolveConfig(null),
      configPath: null,
      warning: null,
      gitRoot,
    };
  }

  // Try to load and parse config
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const raw = YAML.parse(content);

    // Validate against schema
    const result = KspecConfigSchema.safeParse(raw);

    if (!result.success) {
      // AC: ac-3 — validation error = defaults + warning
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return {
        config: resolveConfig(null),
        configPath,
        warning: `Config validation failed: ${issues}. Using defaults.`,
        gitRoot,
      };
    }

    // AC: ac-5 — apply env var overrides during resolution
    return {
      config: resolveConfig(result.data),
      configPath,
      warning: null,
      gitRoot,
    };
  } catch (err) {
    // AC: ac-3 — parse error = defaults + warning
    const message = err instanceof Error ? err.message : String(err);
    return {
      config: resolveConfig(null),
      configPath,
      warning: `Failed to parse ${CONFIG_FILENAME}: ${message}. Using defaults.`,
      gitRoot,
    };
  }
}

/**
 * Resolve configuration by merging file config with env vars and defaults.
 *
 * Priority: env vars > config file > defaults
 *
 * AC: @project-config ac-5 — env vars take precedence
 */
export function resolveConfig(fileConfig: KspecConfig | null): ResolvedKspecConfig {
  const file = fileConfig || {};
  const agentConfig = file.agent ?? file.ralph;

  // Get env var overrides
  const envAuthor = process.env.KSPEC_AUTHOR;
  const envPort = process.env.KSPEC_DAEMON_PORT
    ? parseInt(process.env.KSPEC_DAEMON_PORT, 10)
    : undefined;
  const envHost = process.env.KSPEC_DAEMON_HOST;
  const envConnectHost = process.env.KSPEC_DAEMON_CONNECT_HOST;

  // Resolve shadow remote if specified
  const remoteValue = file.shadow?.remote;
  const resolvedRemote: ResolvedShadowRemote | null = remoteValue
    ? { value: remoteValue, type: detectRemoteType(remoteValue) }
    : DEFAULT_CONFIG.shadow.remote;

  return {
    shadow: {
      branch: file.shadow?.branch ?? DEFAULT_CONFIG.shadow.branch,
      directory: file.shadow?.directory ?? DEFAULT_CONFIG.shadow.directory,
      remote: resolvedRemote,
      sync_interval: file.shadow?.sync_interval ?? DEFAULT_CONFIG.shadow.sync_interval,
    },
    identity: {
      // AC: ac-5 — env var takes precedence
      author: envAuthor ?? file.identity?.author ?? DEFAULT_CONFIG.identity.author,
    },
    validation: {
      // AC: @config-validation ac-2 ac-3 — strict_refs from config
      strict_refs: file.validation?.strict_refs ?? DEFAULT_CONFIG.validation.strict_refs,
      // AC: @config-validation ac-1 — require_acceptance from config
      require_acceptance:
        file.validation?.require_acceptance ?? DEFAULT_CONFIG.validation.require_acceptance,
    },
    daemon: {
      // AC: ac-5 — env vars take precedence
      // AC: @config-daemon ac-port-env-precedence
      port:
        (envPort && !isNaN(envPort) ? envPort : undefined) ??
        file.daemon?.port ??
        DEFAULT_CONFIG.daemon.port,
      // AC: @config-daemon ac-host-default ac-host-config ac-host-env-precedence — host from env/config/default
      host: envHost ?? file.daemon?.host ?? DEFAULT_CONFIG.daemon.host,
      // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
      // True when env or file supplied a non-empty host. Daemon startup
      // uses this to gate the IPv4 → IPv6 fallback (only auto-fallback
      // when the user did not explicitly configure a host).
      host_explicitly_configured:
        (typeof envHost === "string" && envHost.length > 0) ||
        (typeof file.daemon?.host === "string" && file.daemon.host.length > 0),
      // AC: @config-daemon ac-connect-host-config — explicit connect host from env/config; null otherwise
      connect_host:
        envConnectHost ?? file.daemon?.connect_host ?? DEFAULT_CONFIG.daemon.connect_host,
      // AC: @daemon-runtime-adapter ac-runtime-selection
      // AC: @daemon-runtime-adapter ac-default-node
      runtime: file.daemon?.runtime ?? DEFAULT_CONFIG.daemon.runtime,
      // AC: @config-daemon ac-3 — auto_start from config
      auto_start: file.daemon?.auto_start ?? DEFAULT_CONFIG.daemon.auto_start,
      // AC: @daemon-log-capture ac-bounded-rotation — rotation cap from config or 5 MiB default
      log_max_size_bytes:
        file.daemon?.log_max_size_bytes ?? DEFAULT_CONFIG.daemon.log_max_size_bytes,
    },
    dispatch: {
      base_branch: file.dispatch?.base_branch ?? DEFAULT_CONFIG.dispatch.base_branch,
      worktree_root: file.dispatch?.worktree_root ?? DEFAULT_CONFIG.dispatch.worktree_root,
      publication_mode: file.dispatch?.publication_mode ?? DEFAULT_CONFIG.dispatch.publication_mode,
      bootstrap: {
        steps: (file.dispatch?.bootstrap?.steps ?? DEFAULT_CONFIG.dispatch.bootstrap.steps).map(
          (step) => ({
            run: step.run,
            ...(step.name ? { name: step.name } : {}),
            ...(step.roles ? { roles: step.roles } : {}),
            idempotent: step.idempotent ?? false,
            allow_tracked_changes: step.allow_tracked_changes ?? false,
            reviewer_rerun_allowed: step.reviewer_rerun_allowed ?? false,
          }),
        ),
      },
      // AC: @dispatch-sync-configuration ac-sync-interval — from config or default 60s
      sync_interval: file.dispatch?.sync_interval ?? DEFAULT_CONFIG.dispatch.sync_interval,
      // AC: @dispatch-sync-configuration ac-remote-sync-default — explicit config or null for runtime resolution
      remote_sync: file.dispatch?.remote_sync ?? DEFAULT_CONFIG.dispatch.remote_sync,
    },
    agent: {
      skills: {
        task_work: agentConfig?.skills?.task_work ?? DEFAULT_CONFIG.agent.skills.task_work,
        reflect: agentConfig?.skills?.reflect ?? DEFAULT_CONFIG.agent.skills.reflect,
        pr_review: agentConfig?.skills?.pr_review ?? DEFAULT_CONFIG.agent.skills.pr_review,
      },
    },
    hooks: {
      // AC: @project-config ac-hooks-missing-keys — absent keys resolve to defaults
      checkpoint: file.hooks?.checkpoint ?? DEFAULT_CONFIG.hooks.checkpoint,
      prompt_check: file.hooks?.prompt_check ?? DEFAULT_CONFIG.hooks.prompt_check,
    },
    coverage: {
      // AC: @coverage-scan-config ac-explicit-opt-in — empty default = no scanning
      scan_paths: file.coverage?.scan_paths ?? DEFAULT_CONFIG.coverage.scan_paths,
      exclude_patterns: file.coverage?.exclude_patterns ?? DEFAULT_CONFIG.coverage.exclude_patterns,
    },
  };
}

/**
 * Resolve the effective remote_sync value for dispatch.
 *
 * When config explicitly sets remote_sync to true or false, that value is used.
 * When remote_sync is null (unset), it defaults based on whether a git remote exists:
 * true if a remote exists, false otherwise.
 *
 * AC: @dispatch-sync-configuration ac-remote-sync-default — defaults based on remote existence
 * AC: @dispatch-sync-configuration ac-remote-sync-disabled — explicit false disables sync
 *
 * @param config Resolved config (remote_sync may be null)
 * @param hasRemote Whether the project has at least one git remote
 * @returns The effective remote_sync value (never null)
 */
export function resolveDispatchRemoteSync(
  config: ResolvedKspecConfig,
  hasRemote: boolean,
): boolean {
  if (config.dispatch.remote_sync !== null) {
    return config.dispatch.remote_sync;
  }
  return hasRemote;
}

/**
 * Get the default configuration (no file, no env vars).
 * Useful for testing or when config loading fails completely.
 * Returns a deep copy to prevent mutation of shared defaults.
 */
export function getDefaultConfig(): ResolvedKspecConfig {
  return {
    shadow: {
      branch: DEFAULT_CONFIG.shadow.branch,
      directory: DEFAULT_CONFIG.shadow.directory,
      remote: DEFAULT_CONFIG.shadow.remote,
      sync_interval: DEFAULT_CONFIG.shadow.sync_interval,
    },
    identity: { ...DEFAULT_CONFIG.identity },
    validation: {
      strict_refs: DEFAULT_CONFIG.validation.strict_refs,
      require_acceptance: DEFAULT_CONFIG.validation.require_acceptance,
    },
    daemon: {
      port: DEFAULT_CONFIG.daemon.port,
      host: DEFAULT_CONFIG.daemon.host,
      host_explicitly_configured: DEFAULT_CONFIG.daemon.host_explicitly_configured,
      connect_host: DEFAULT_CONFIG.daemon.connect_host,
      runtime: DEFAULT_CONFIG.daemon.runtime,
      auto_start: DEFAULT_CONFIG.daemon.auto_start,
      log_max_size_bytes: DEFAULT_CONFIG.daemon.log_max_size_bytes,
    },
    dispatch: {
      base_branch: DEFAULT_CONFIG.dispatch.base_branch,
      worktree_root: DEFAULT_CONFIG.dispatch.worktree_root,
      publication_mode: DEFAULT_CONFIG.dispatch.publication_mode,
      bootstrap: {
        steps: DEFAULT_CONFIG.dispatch.bootstrap.steps.map((step) => ({
          ...step,
        })),
      },
      sync_interval: DEFAULT_CONFIG.dispatch.sync_interval,
      remote_sync: DEFAULT_CONFIG.dispatch.remote_sync,
    },
    agent: {
      skills: { ...DEFAULT_CONFIG.agent.skills },
    },
    hooks: { ...DEFAULT_CONFIG.hooks },
    coverage: {
      scan_paths: [...DEFAULT_CONFIG.coverage.scan_paths],
      exclude_patterns: [...DEFAULT_CONFIG.coverage.exclude_patterns],
    },
  };
}
