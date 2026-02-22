/**
 * Claude Code plugin marketplace registry library.
 *
 * Shared by setup.ts and skill-install.ts for registering the kspec core
 * skills plugin with Claude Code's global state.
 *
 * AC: @core-skill-install ac-6, ac-7, ac-8
 * AC: @enhanced-setup ac-7, ac-8
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Types
// ============================================================================

export interface RegisterResult {
  success: boolean;
  action: "registered" | "updated" | "unchanged" | "skipped" | "error";
  message: string;
  registeredPath?: string;
}

export interface EnableResult {
  success: boolean;
  action: "enabled" | "unchanged" | "error";
  message: string;
}

export type MarketplaceHealthStatus =
  | "healthy"
  | "missing"
  | "path-broken"
  | "version-mismatch"
  | "error";

export interface MarketplaceHealth {
  status: MarketplaceHealthStatus;
  registeredPath?: string;
  pluginVersion?: string;
  packageVersion?: string;
  message: string;
}

interface MarketplaceEntry {
  source: string;
  installLocation: string;
  lastUpdated: string;
  autoUpdate?: boolean;
  [key: string]: unknown;
}

interface KnownMarketplacesJson {
  [key: string]: MarketplaceEntry;
}

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Get the Claude Code plugins directory.
 * Respects KSPEC_CLAUDE_HOME env override for test isolation.
 */
export function getClaudePluginsDir(): string {
  const home = process.env.KSPEC_CLAUDE_HOME || path.join(os.homedir(), ".claude");
  return path.join(home, "plugins");
}

/**
 * Get the absolute path to the pre-built plugin directory in the npm package.
 * Uses fs.realpath for symlink/pnpm stability.
 */
export async function getPackagePluginDir(): Promise<string> {
  // Resolve relative to this file: src/lib/ -> ../../plugin
  const rawPath = path.resolve(
    import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
    "../../plugin"
  );
  try {
    return await fs.realpath(rawPath);
  } catch {
    return rawPath;
  }
}

// ============================================================================
// Atomic JSON Operations
// ============================================================================

/**
 * Tolerant JSON read — returns default if missing, empty, or corrupt.
 * Only use for files owned by this module (known_marketplaces.json).
 */
async function readJsonSafe<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (!content.trim()) return defaultValue;
    return JSON.parse(content) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Strict JSON read — throws on corrupt JSON.
 * Use for files with critical config (settings.json) to avoid silent data loss.
 */
async function readJsonStrict<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (!content.trim()) return defaultValue;
    return JSON.parse(content) as T;
  } catch (err) {
    // ENOENT = file doesn't exist -> return default
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultValue;
    }
    // Parse errors or permission errors -> throw
    throw err;
  }
}

/**
 * Atomic JSON write — temp file + rename in same directory.
 * Creates parent directory if needed.
 */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2) + "\n";

  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Read-modify-write with optimistic retry (3 attempts).
 * Best-effort concurrent safety, not lock-based.
 */
async function modifyJsonAtomic<T>(
  filePath: string,
  defaultValue: T,
  mutator: (data: T) => T,
  options?: { strict?: boolean }
): Promise<T> {
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const data = options?.strict
      ? await readJsonStrict(filePath, defaultValue)
      : await readJsonSafe(filePath, defaultValue);

    const modified = mutator(data);
    await writeJsonAtomic(filePath, modified);

    // Verify write
    try {
      const readBack = options?.strict
        ? await readJsonStrict(filePath, defaultValue)
        : await readJsonSafe(filePath, defaultValue);
      const expected = JSON.stringify(modified);
      const actual = JSON.stringify(readBack);
      if (expected === actual) {
        return modified;
      }
    } catch {
      // Read-back failed, retry
    }

    if (attempt < maxAttempts - 1) {
      // Brief delay before retry
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }

  // Final attempt without verification
  const data = options?.strict
    ? await readJsonStrict(filePath, defaultValue)
    : await readJsonSafe(filePath, defaultValue);
  const modified = mutator(data);
  await writeJsonAtomic(filePath, modified);
  return modified;
}

// ============================================================================
// Registration Functions
// ============================================================================

const MARKETPLACE_KEY = "kspec-plugins";

/**
 * Register the kspec core plugin marketplace in Claude Code's global state.
 * Writes kspec-plugins entry to known_marketplaces.json.
 * Only updates lastUpdated when path actually changes (idempotent).
 * Validates plugin/.claude-plugin/plugin.json exists before registering.
 *
 * AC: @core-skill-install ac-6, ac-8
 */
export async function registerCorePluginMarketplace(
  opts?: { dryRun?: boolean }
): Promise<RegisterResult> {
  const dryRun = opts?.dryRun ?? false;

  try {
    const pluginDir = await getPackagePluginDir();

    // Validate plugin directory has the manifest
    const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
    try {
      await fs.access(manifestPath);
    } catch {
      return {
        success: false,
        action: "error",
        message: `Plugin manifest not found at ${manifestPath}. Run 'npm run build' first.`,
      };
    }

    if (dryRun) {
      return {
        success: true,
        action: "skipped",
        message: `Would register marketplace at ${pluginDir}`,
        registeredPath: pluginDir,
      };
    }

    const marketplacesPath = path.join(getClaudePluginsDir(), "known_marketplaces.json");
    const existing = await readJsonSafe<KnownMarketplacesJson>(marketplacesPath, {});

    // Check if already registered with same path
    const currentEntry = existing[MARKETPLACE_KEY];
    if (currentEntry && currentEntry.installLocation === pluginDir) {
      return {
        success: true,
        action: "unchanged",
        message: "Marketplace already registered with correct path",
        registeredPath: pluginDir,
      };
    }

    // Register or update
    const action = currentEntry ? "updated" : "registered";
    await modifyJsonAtomic<KnownMarketplacesJson>(
      marketplacesPath,
      {},
      (data) => ({
        ...data,
        [MARKETPLACE_KEY]: {
          ...data[MARKETPLACE_KEY],
          source: { source: "directory", path: pluginDir },
          installLocation: pluginDir,
          lastUpdated: new Date().toISOString(),
          autoUpdate: false,
        },
      })
    );

    return {
      success: true,
      action,
      message: `Marketplace ${action} at ${pluginDir}`,
      registeredPath: pluginDir,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      action: "error",
      message: `Registration failed: ${msg}`,
    };
  }
}

/**
 * Enable the kspec plugin in a project's .claude/settings.json.
 * Uses strict JSON read to avoid silently discarding hooks config.
 *
 * AC: @core-skill-install ac-7
 */
export async function enablePluginInProject(
  projectDir: string,
  opts?: { dryRun?: boolean }
): Promise<EnableResult> {
  const dryRun = opts?.dryRun ?? false;

  try {
    const settingsPath = path.join(projectDir, ".claude", "settings.json");

    if (dryRun) {
      return {
        success: true,
        action: "unchanged",
        message: "Would enable kspec@kspec-plugins in project settings",
      };
    }

    const settings = await readJsonStrict<Record<string, unknown>>(settingsPath, {});

    const enabledPlugins = (settings.enabledPlugins || {}) as Record<string, boolean>;

    if (enabledPlugins["kspec@kspec-plugins"] === true) {
      return {
        success: true,
        action: "unchanged",
        message: "Plugin already enabled in project",
      };
    }

    await modifyJsonAtomic<Record<string, unknown>>(
      settingsPath,
      {},
      (data) => ({
        ...data,
        enabledPlugins: {
          ...((data.enabledPlugins || {}) as Record<string, boolean>),
          "kspec@kspec-plugins": true,
        },
      }),
      { strict: true }
    );

    return {
      success: true,
      action: "enabled",
      message: "Plugin enabled in project settings",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      action: "error",
      message: `Enablement failed: ${msg}`,
    };
  }
}

/**
 * Check the health of the kspec marketplace registration.
 * Returns status and details for setup --status reporting.
 *
 * AC: @enhanced-setup ac-7, ac-8
 */
export async function checkMarketplaceHealth(): Promise<MarketplaceHealth> {
  try {
    const marketplacesPath = path.join(getClaudePluginsDir(), "known_marketplaces.json");
    const marketplaces = await readJsonSafe<KnownMarketplacesJson>(marketplacesPath, {});

    const entry = marketplaces[MARKETPLACE_KEY];
    if (!entry) {
      return {
        status: "missing",
        message: "kspec-plugins marketplace not registered. Run 'kspec setup' to register.",
      };
    }

    const registeredPath = entry.installLocation;

    // Check if the path is valid
    const manifestPath = path.join(registeredPath, ".claude-plugin", "plugin.json");
    try {
      const content = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(content);

      // Read current package version for comparison
      let packageVersion: string | undefined;
      try {
        const pkgPath = path.resolve(
          import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
          "../../package.json"
        );
        const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
        packageVersion = pkg.version;
      } catch {
        // Can't determine package version
      }

      const pluginVersion = manifest.version;

      if (packageVersion && pluginVersion && pluginVersion !== packageVersion) {
        return {
          status: "version-mismatch",
          registeredPath,
          pluginVersion,
          packageVersion,
          message: `Plugin version ${pluginVersion} doesn't match package version ${packageVersion}`,
        };
      }

      return {
        status: "healthy",
        registeredPath,
        pluginVersion,
        packageVersion,
        message: "Marketplace registered and healthy",
      };
    } catch {
      return {
        status: "path-broken",
        registeredPath,
        message: `Registered path is invalid: ${registeredPath}. Run 'kspec setup' to re-register.`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      message: `Health check failed: ${msg}`,
    };
  }
}
