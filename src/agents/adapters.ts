/**
 * Agent adapter registry.
 *
 * Adapters define how to spawn and communicate with different ACP-compliant agents.
 * Each adapter specifies the command, args, and optional configuration.
 */

import { execSync } from "node:child_process";

/**
 * Adapter definition for spawning ACP agents.
 */
export interface AgentAdapter {
  /**
   * Command to execute (e.g., 'npx', 'node').
   *
   * Required for package-backed and model-specific adapters. Absent only for
   * adapters with `requiresProcessExecutable: true`, which carry no
   * adapter-level command and may be resolved only through a runner that
   * supplies `process.executable`. The resolver never returns a contract whose
   * effective adapter lacks a command — a generic adapter without a runner
   * executable fails with `missing_process_executable` before spawn.
   */
  command?: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Whether to use shell (needed for npx on Windows) */
  shell?: boolean;
  /** Human-readable description */
  description?: string;
  /** Arguments to append for auto-approve / yolo mode */
  autoApproveArgs?: string[];
  /**
   * When true, the adapter carries no built-in command and must be resolved
   * through a runner that supplies `process.executable`. Used by the generic
   * ACP process profile so custom ACP executables can be spawned exactly as
   * configured by the runner — without inheriting package-runner or
   * model-specific argv, and without pretending to be the mock test adapter.
   */
  requiresProcessExecutable?: boolean;
}

/**
 * Resolve the package runner command for the current runtime.
 *
 * When running under Bun, uses `process.execPath` (absolute path to the bun
 * binary) to eliminate PATH resolution entirely.  `bun x <pkg>` is equivalent
 * to `bunx <pkg>` but immune to PATH loss in detached / nested spawn chains.
 *
 * Under Node, resolves `npx` to an absolute path at module load time so
 * subsequent spawns don't depend on PATH staying intact.
 */
const IS_BUN = typeof globalThis.Bun !== "undefined";

function resolvePkgRunner(): { command: string; prependArgs: string[] } {
  if (IS_BUN) {
    // process.execPath is always absolute — no PATH needed
    return { command: process.execPath, prependArgs: ["x"] };
  }

  // Under Node, try to resolve npx to an absolute path
  try {
    const resolved = execSync("which npx", { encoding: "utf-8" }).trim();
    if (resolved) return { command: resolved, prependArgs: [] };
  } catch {
    // Fall through to plain "npx"
  }
  return { command: "npx", prependArgs: [] };
}

const { command: PKG_RUNNER_CMD, prependArgs: PKG_RUNNER_PREPEND } = resolvePkgRunner();

/**
 * Built-in adapter registry.
 */
const ADAPTERS: Record<string, AgentAdapter> = {
  /**
   * Claude Agent ACP adapter - the primary production adapter.
   * Uses the Agent Client Protocol org package.
   */
  "claude-agent-acp": {
    command: PKG_RUNNER_CMD,
    args: [...PKG_RUNNER_PREPEND, "@agentclientprotocol/claude-agent-acp@0.31.4"],
    shell: process.platform === "win32" && !IS_BUN,
    description: "Claude Agent via ACP protocol",
    autoApproveArgs: ["--dangerously-skip-permissions"],
  },

  /**
   * @deprecated Alias for backwards compatibility.
   * The adapter ID was renamed from claude-code-acp to claude-agent-acp.
   * This alias ensures existing scripts with --adapter claude-code-acp continue to work.
   */
  "claude-code-acp": {
    command: PKG_RUNNER_CMD,
    args: [...PKG_RUNNER_PREPEND, "@agentclientprotocol/claude-agent-acp@0.31.4"],
    shell: process.platform === "win32" && !IS_BUN,
    description: "Claude Agent via ACP protocol (deprecated alias)",
    autoApproveArgs: ["--dangerously-skip-permissions"],
  },

  /**
   * Codex ACP adapter.
   * Uses the codex-acp package for OpenAI Codex agent.
   */
  "codex-acp": {
    command: PKG_RUNNER_CMD,
    args: [...PKG_RUNNER_PREPEND, "@zed-industries/codex-acp@0.12.0"],
    shell: process.platform === "win32" && !IS_BUN,
    description: "Codex agent via ACP protocol",
    autoApproveArgs: ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'],
  },

  /**
   * Droid ACP adapter.
   * Uses Droid's native ACP support over stream JSON-RPC.
   */
  "droid-acp": {
    command: "droid",
    args: ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"],
    description: "Droid agent via native ACP protocol",
    autoApproveArgs: ["--skip-permissions-unsafe"],
  },

  /**
   * Mock ACP adapter for testing.
   * Uses a local mock script that simulates ACP behavior.
   */
  "mock-acp": {
    command: "node",
    args: [], // Path to mock script set at runtime via env
    env: {},
    description: "Mock ACP agent for testing",
  },

  /**
   * Generic ACP process adapter profile.
   *
   * Carries no built-in command, no package-runner or model-specific launch
   * args, and no auto-approve args. It exists so custom ACP-compatible
   * executables can be configured through a runner that supplies
   * `process.executable` without pretending to be the mock test adapter and
   * without inheriting argv from `claude-agent-acp`, `codex-acp`, or any other
   * model-specific built-in adapter. Resolution requires a runner-supplied
   * executable — direct/legacy use fails with `missing_process_executable`.
   */
  "generic-acp": {
    args: [],
    description: "Generic ACP process profile for runner-supplied executables",
    requiresProcessExecutable: true,
  },
};

/**
 * Get an adapter by ID.
 *
 * @param id - Adapter identifier
 * @returns Adapter definition or undefined if not found
 */
export function getAdapter(id: string): AgentAdapter | undefined {
  return ADAPTERS[id];
}

/**
 * List all registered adapter IDs.
 *
 * @returns Array of adapter IDs
 */
export function listAdapters(): string[] {
  return Object.keys(ADAPTERS);
}

/**
 * Register a custom adapter at runtime.
 *
 * Useful for testing or dynamic adapter configuration.
 *
 * @param id - Adapter identifier
 * @param adapter - Adapter definition
 */
export function registerAdapter(id: string, adapter: AgentAdapter): void {
  ADAPTERS[id] = adapter;
}

/**
 * Resolve adapter by ID or use default.
 *
 * If the ID matches a registered adapter, returns that adapter.
 * If not, treats the ID as an npm package name and creates an ad-hoc npx adapter.
 * This allows users to use any ACP-compatible package without registering it.
 *
 * @param id - Optional adapter ID or npm package name
 * @returns Adapter definition
 */
export function resolveAdapter(id?: string): AgentAdapter {
  const adapterId = id ?? "claude-agent-acp";
  const adapter = getAdapter(adapterId);

  if (adapter) {
    return adapter;
  }

  // Treat unknown IDs as npm package names - create ad-hoc adapter
  return {
    command: PKG_RUNNER_CMD,
    args: [...PKG_RUNNER_PREPEND, adapterId],
    shell: process.platform === "win32" && !IS_BUN,
    description: `Ad-hoc adapter for ${adapterId}`,
  };
}
