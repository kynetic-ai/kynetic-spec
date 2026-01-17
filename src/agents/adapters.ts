/**
 * Agent adapter registry.
 *
 * Adapters define how to spawn and communicate with different ACP-compliant agents.
 * Each adapter specifies the command, args, and optional configuration.
 */

/**
 * Adapter definition for spawning ACP agents.
 */
export interface AgentAdapter {
  /** Command to execute (e.g., 'npx', 'node') */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Whether to use shell (needed for npx on Windows) */
  shell?: boolean;
  /** Human-readable description */
  description?: string;
}

/**
 * Built-in adapter registry.
 */
const ADAPTERS: Record<string, AgentAdapter> = {
  /**
   * Claude Code ACP adapter - the primary production adapter.
   * Uses @anthropic-ai/claude-code-acp package.
   */
  'claude-code-acp': {
    command: 'npx',
    args: ['@anthropic-ai/claude-code-acp'],
    shell: process.platform === 'win32',
    description: 'Claude Code via ACP protocol',
  },

  /**
   * Mock ACP adapter for testing.
   * Uses a local mock script that simulates ACP behavior.
   */
  'mock-acp': {
    command: 'node',
    args: [], // Path to mock script set at runtime via env
    env: {},
    description: 'Mock ACP agent for testing',
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
 * @param id - Optional adapter ID
 * @returns Adapter definition
 * @throws If adapter not found
 */
export function resolveAdapter(id?: string): AgentAdapter {
  const adapterId = id ?? 'claude-code-acp';
  const adapter = getAdapter(adapterId);

  if (!adapter) {
    const available = listAdapters().join(', ');
    throw new Error(`Unknown adapter: ${adapterId}. Available: ${available}`);
  }

  return adapter;
}
