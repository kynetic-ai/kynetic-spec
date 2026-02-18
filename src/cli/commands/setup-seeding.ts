/**
 * Setup seeding for new project bootstrapping.
 *
 * Extracted from setup.ts to keep that file focused on pipeline orchestration.
 * Seeds permission patterns and project memory when running kspec setup on a new project.
 *
 * AC: @new-project-bootstrapping ac-1 - permission seeding
 * AC: @new-project-bootstrapping ac-2 - memory seeding
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentType } from "./setup.js";

function debugLog(message: string, detail?: unknown): void {
  if (process.env.KSPEC_DEBUG === "1") {
    if (detail) {
      console.error(`[DEBUG] setup-seeding: ${message}`, detail);
    } else {
      console.error(`[DEBUG] setup-seeding: ${message}`);
    }
  }
}

/**
 * Default permission patterns for Claude Code projects using kspec.
 * These go into .claude/settings.json (project-level, committed, shared).
 */
const KSPEC_PERMISSION_PATTERNS = [
  "Bash(kspec:*)",
  "Bash(npm run build:*)",
  "Bash(npm test:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
];

/**
 * Result of a seeding operation.
 */
export interface SeedResult {
  seeded: boolean;
  path: string;
  message: string;
}

// --- Permission Seeding (AC-1) ---

/**
 * Seed common kspec permission patterns into .claude/settings.json.
 *
 * AC: @new-project-bootstrapping ac-1
 * - Only for claude-code agent type
 * - Merges into existing settings.json (doesn't clobber hooks or existing permissions)
 * - Skips if permissions key already exists (unless force)
 * - Force merges kspec patterns into existing permissions (additive)
 * - Dry-run support
 */
export async function seedPermissions(
  projectDir: string,
  agentType: AgentType,
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<SeedResult> {
  const { dryRun = false, force = false } = options;

  if (agentType !== "claude-code") {
    return {
      seeded: false,
      path: "",
      message: `not applicable for ${agentType}`,
    };
  }

  const configPath = path.join(projectDir, ".claude", "settings.json");

  try {
    // Read existing config — distinguish file-not-found from parse errors
    let config: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        debugLog("No existing settings.json, starting fresh");
      } else {
        // File exists but is malformed JSON — fail safely, don't overwrite
        return {
          seeded: false,
          path: configPath,
          message: `failed: settings.json exists but contains invalid JSON`,
        };
      }
    }

    // Skip if permissions already configured (unless force)
    if (config.permissions && !force) {
      return {
        seeded: false,
        path: configPath,
        message: "permissions already configured",
      };
    }

    // Merge kspec patterns into existing permissions (additive, never destructive)
    const existingAllow = Array.isArray(
      (config.permissions as Record<string, unknown>)?.allow,
    )
      ? ((config.permissions as Record<string, unknown>).allow as string[])
      : [];
    const merged = [
      ...new Set([...existingAllow, ...KSPEC_PERMISSION_PATTERNS]),
    ];
    config.permissions = {
      ...(config.permissions as Record<string, unknown>),
      allow: merged,
    };

    if (!dryRun) {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(config, null, 2)}\n`,
        "utf-8",
      );
    }

    return {
      seeded: true,
      path: configPath,
      message: `${KSPEC_PERMISSION_PATTERNS.length} permission patterns`,
    };
  } catch (err) {
    debugLog("seedPermissions failed", err);
    return {
      seeded: false,
      path: configPath,
      message: `failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Type guard for Node.js errors with a `code` property.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

// --- Memory Seeding (AC-2) ---

/**
 * Platform-specific memory seed writer interface.
 * Extensible for future agent platforms.
 */
export interface MemorySeedWriter {
  platform: AgentType;
  getMemoryPath(projectDir: string): string;
  exists(projectDir: string): Promise<boolean>;
  write(
    projectDir: string,
    content: string,
    dryRun: boolean,
  ): Promise<{ created: boolean; path: string }>;
}

/**
 * Encode a project path for Claude Code's project memory directory.
 *
 * Claude Code uses: ~/.claude/projects/{encoded-path}/memory/MEMORY.md
 * Encoding: absolute path with separators replaced by - and leading - stripped.
 * Trailing separators are normalized (stripped) to avoid inconsistent paths.
 *
 * Known fragility: This convention is undocumented by Claude Code.
 * If it changes, only this function needs updating.
 */
export function encodeProjectPath(projectPath: string): string {
  // Normalize trailing slashes/backslashes
  let normalized = projectPath.replace(/[\\/]+$/, "");
  // Replace all path separators (both / and \) with -
  let encoded = normalized.replace(/[\\/]/g, "-");
  // Strip leading -
  encoded = encoded.replace(/^-+/, "");
  return encoded;
}

/**
 * Get the Claude Code memory path for a project directory.
 * Standalone function to avoid `this` binding issues with object literal methods.
 */
function getClaudeCodeMemoryPath(projectDir: string): string {
  const homedir = os.homedir();
  const encoded = encodeProjectPath(projectDir);
  return path.join(
    homedir,
    ".claude",
    "projects",
    encoded,
    "memory",
    "MEMORY.md",
  );
}

/**
 * Claude Code memory seed writer.
 */
export const claudeCodeMemoryWriter: MemorySeedWriter = {
  platform: "claude-code",

  getMemoryPath(projectDir: string): string {
    return getClaudeCodeMemoryPath(projectDir);
  },

  async exists(projectDir: string): Promise<boolean> {
    try {
      await fs.access(getClaudeCodeMemoryPath(projectDir));
      return true;
    } catch (_err) {
      return false;
    }
  },

  async write(
    projectDir: string,
    content: string,
    dryRun: boolean,
  ): Promise<{ created: boolean; path: string }> {
    const memoryPath = getClaudeCodeMemoryPath(projectDir);
    if (!dryRun) {
      await fs.mkdir(path.dirname(memoryPath), { recursive: true });
      await fs.writeFile(memoryPath, content, "utf-8");
    }
    return { created: true, path: memoryPath };
  },
};

/**
 * Get the memory seed writer for a given agent type.
 * Returns null for unsupported platforms (no-op).
 */
function getMemoryWriter(agentType: AgentType): MemorySeedWriter | null {
  switch (agentType) {
    case "claude-code":
      return claudeCodeMemoryWriter;
    default:
      return null;
  }
}

/**
 * Generate project seed content for agent memory.
 *
 * Content is platform-agnostic — only stable project info, no volatile data.
 */
export async function generateProjectSeedContent(
  projectDir: string,
): Promise<string> {
  const projectName = await getProjectName(projectDir);
  const moduleNames = await getModuleNames(projectDir);
  const timestamp = new Date().toISOString();

  const lines = [
    `# ${projectName} - Project Memory`,
    "",
    `<!-- kspec-seeded: ${timestamp} -->`,
    "",
    "## Project Overview",
    `- **Root**: ${projectDir}`,
    "- **Spec directory**: .kspec/",
  ];

  if (moduleNames.length > 0) {
    lines.push(`- **Modules**: ${moduleNames.join(", ")}`);
  }

  lines.push(
    "",
    "## Key Conventions",
    "- Use `kspec` CLI for all spec/task operations — never edit .kspec/ files directly",
    "- Shadow branch (kspec-meta) tracks spec state independently from code branches",
    "- Run `kspec session start` at the beginning of each session",
    "",
    "## Quick Reference",
    "- `kspec tasks ready` — see available work",
    "- `kspec task start @ref` — begin a task",
    '- `kspec task note @ref "..."` — add context while working',
    "- `kspec setup --status` — check environment health",
    "",
  );

  return lines.join("\n");
}

/**
 * Get the project name from the kspec manifest, falling back to directory name.
 */
async function getProjectName(projectDir: string): Promise<string> {
  try {
    const { initContext } = await import("../../parser/index.js");
    const ctx = await initContext(projectDir);
    if (ctx.manifest?.project?.name) {
      return ctx.manifest.project.name;
    }
  } catch (err) {
    debugLog("Could not load manifest for project name", err);
  }
  return path.basename(projectDir);
}

/**
 * Get module names from the .kspec/modules/ directory.
 */
async function getModuleNames(projectDir: string): Promise<string[]> {
  const modulesDir = path.join(projectDir, ".kspec", "modules");
  try {
    const entries = await fs.readdir(modulesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    debugLog("Could not read modules directory", err);
    return [];
  }
}

/**
 * Seed project memory for the detected agent platform.
 *
 * AC: @new-project-bootstrapping ac-2
 * - Generates platform-agnostic content, delegates to platform writer
 * - Currently supports Claude Code; other platforms return no-op
 * - Skips if memory file already exists (unless force)
 * - Creates parent directories
 * - Dry-run support
 */
export async function seedMemory(
  projectDir: string,
  agentType: AgentType,
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<SeedResult> {
  const { dryRun = false, force = false } = options;

  const writer = getMemoryWriter(agentType);
  if (!writer) {
    return {
      seeded: false,
      path: "",
      message: `no memory writer for ${agentType}`,
    };
  }

  const memoryPath = writer.getMemoryPath(projectDir);

  try {
    // Skip if already exists (unless force)
    if (!force && (await writer.exists(projectDir))) {
      return {
        seeded: false,
        path: memoryPath,
        message: "memory file already exists",
      };
    }

    const content = await generateProjectSeedContent(projectDir);
    const result = await writer.write(projectDir, content, dryRun);

    return {
      seeded: result.created,
      path: result.path,
      message: result.created ? "seeded" : "skipped",
    };
  } catch (err) {
    debugLog("seedMemory failed", err);
    return {
      seeded: false,
      path: memoryPath,
      message: `failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
