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
import { z } from "zod";
import * as YAML from "yaml";
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
    /** Host to bind to (default: localhost) */
    host: z.string().optional(),
    /**
     * Whether to auto-start daemon when running kspec commands.
     * AC: @config-daemon ac-3 — auto_start configurable
     */
    auto_start: z.boolean().optional(),
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
  // AC: ac-4 — Local filesystem path (starts with /, ./, or ~)
  if (remote.startsWith("/") || remote.startsWith("./") || remote.startsWith("~")) {
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
     * Whether to auto-start daemon when running kspec commands.
     * AC: @config-daemon ac-3
     */
    auto_start: boolean;
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
    host: "localhost",
    auto_start: true, // AC: @config-daemon — default auto-start enabled
  },
};

// ── Loading ─────────────────────────────────────────────────────────────

const CONFIG_FILENAME = "kspec.config.yaml";

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
export function findProjectRoot(startDir: string): string | null {
  // In batch mode, the batch executor should set this to the real root
  // before redirecting KSPEC_SPEC_DIR
  const batchRoot = process.env.KSPEC_BATCH_PROJECT_ROOT;
  if (batchRoot) {
    return batchRoot;
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
): Promise<LoadConfigResult> {
  const gitRoot = findProjectRoot(startDir);

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
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
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

  // Get env var overrides
  const envAuthor = process.env.KSPEC_AUTHOR;
  const envPort = process.env.KSPEC_DAEMON_PORT
    ? parseInt(process.env.KSPEC_DAEMON_PORT, 10)
    : undefined;
  const envHost = process.env.KSPEC_DAEMON_HOST;

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
    },
    identity: {
      // AC: ac-5 — env var takes precedence
      author: envAuthor ?? file.identity?.author ?? DEFAULT_CONFIG.identity.author,
    },
    validation: {
      // AC: @config-validation ac-2 ac-3 — strict_refs from config
      strict_refs:
        file.validation?.strict_refs ?? DEFAULT_CONFIG.validation.strict_refs,
      // AC: @config-validation ac-1 — require_acceptance from config
      require_acceptance:
        file.validation?.require_acceptance ?? DEFAULT_CONFIG.validation.require_acceptance,
    },
    daemon: {
      // AC: ac-5 — env vars take precedence
      port:
        (envPort && !isNaN(envPort) ? envPort : undefined) ??
        file.daemon?.port ??
        DEFAULT_CONFIG.daemon.port,
      host: envHost ?? file.daemon?.host ?? DEFAULT_CONFIG.daemon.host,
      // AC: @config-daemon ac-3 — auto_start from config
      auto_start: file.daemon?.auto_start ?? DEFAULT_CONFIG.daemon.auto_start,
    },
  };
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
    },
    identity: { ...DEFAULT_CONFIG.identity },
    validation: {
      strict_refs: DEFAULT_CONFIG.validation.strict_refs,
      require_acceptance: DEFAULT_CONFIG.validation.require_acceptance,
    },
    daemon: {
      port: DEFAULT_CONFIG.daemon.port,
      host: DEFAULT_CONFIG.daemon.host,
      auto_start: DEFAULT_CONFIG.daemon.auto_start,
    },
  };
}
