/**
 * ProjectContextManager - Multi-project daemon support
 *
 * Manages project registration, caching, path validation, and context management
 * for multi-directory daemon architecture.
 *
 * AC: @multi-directory-daemon ac-1 through ac-20b
 */

import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { isAbsolute, join, normalize, relative } from "path";
import { KspecWatcher } from "./watcher.js";
import { SessionWatcher } from "./session-watcher.js";
import type { PubSubManager } from "./websocket/pubsub.js";

/**
 * Optional callback for file change events from the watcher.
 * Used by the dispatch engine to detect task state transitions.
 * AC: @agent-dispatch-engine ac-5
 */
export type FileChangeCallback = (projectPath: string, file: string, content: string) => void;

/**
 * Callback for cache invalidation on file changes.
 * AC: @daemon-entity-cache ac-watcher-invalidation
 */
export type CacheInvalidationCallback = (
  projectPath: string,
  kspecDir: string,
  file: string,
  content?: string,
) => void;

export interface ProjectContext {
  path: string;
  registeredAt: Date;
  watcherActive: boolean;
  lastHealthCheckAt: Date | null;
  consecutiveFailures: number;
}

interface PendingHealthProbe {
  filePath: string;
  resolve: () => void;
}

/**
 * Manages multiple kspec project contexts for the daemon server.
 *
 * Key responsibilities:
 * - Project registration and caching
 * - Path validation and normalization
 * - Default project handling
 * - Project lifecycle management
 * - Per-project file watcher management
 */
export class ProjectContextManager {
  private projects: Map<string, ProjectContext> = new Map();
  private watchers: Map<string, { kspec: KspecWatcher; sessions: SessionWatcher }> = new Map();
  private pendingHealthProbes: Map<string, PendingHealthProbe> = new Map();
  private defaultProjectPath: string | null = null;
  private pubsub: PubSubManager | null = null;
  /** Optional callback for file changes (used by dispatch engine). AC: @agent-dispatch-engine ac-5 */
  private fileChangeCallback: FileChangeCallback | null = null;
  /** Optional callback for cache invalidation on file changes. AC: @daemon-entity-cache ac-watcher-invalidation */
  private cacheInvalidationCallback: CacheInvalidationCallback | null = null;
  /** Optional callback invoked when a project is unregistered (from any path). AC: @daemon-entity-cache ac-unregister-cleanup */
  private unregisterCallback: ((projectPath: string) => void) | null = null;

  constructor(defaultProjectPath?: string, pubsub?: PubSubManager) {
    if (defaultProjectPath) {
      this.defaultProjectPath = defaultProjectPath;
    }
    if (pubsub) {
      this.pubsub = pubsub;
    }
  }

  /**
   * Register a callback to be invoked on file changes.
   * Used by the dispatch engine to detect task state transitions.
   * AC: @agent-dispatch-engine ac-5
   */
  setFileChangeCallback(callback: FileChangeCallback | null): void {
    this.fileChangeCallback = callback;
  }

  /**
   * Register a callback for cache invalidation on file changes.
   * AC: @daemon-entity-cache ac-watcher-invalidation
   */
  setCacheInvalidationCallback(callback: CacheInvalidationCallback | null): void {
    this.cacheInvalidationCallback = callback;
  }

  /**
   * Register a callback invoked when a project is unregistered (from any code path).
   * Used to dispose entity cache on watcher permanent failure, not just API-driven unregister.
   * AC: @daemon-entity-cache ac-unregister-cleanup
   */
  setUnregisterCallback(callback: ((projectPath: string) => void) | null): void {
    this.unregisterCallback = callback;
  }

  /**
   * Set the PubSubManager for broadcasting file changes.
   * Must be called before starting watchers.
   *
   * @param pubsub - PubSubManager instance
   */
  setPubSub(pubsub: PubSubManager): void {
    this.pubsub = pubsub;
  }

  /**
   * Start a file watcher for a project.
   *
   * AC: @multi-directory-daemon ac-17, ac-19
   *
   * @param projectPath - Absolute path to project root
   * @throws Error if watcher creation fails (e.g., OS resource limits)
   */
  async startWatcher(projectPath: string): Promise<void> {
    const normalizedPath = this.normalizePath(projectPath);

    // AC: @multi-directory-daemon ac-16 - Don't create duplicate watchers
    if (this.watchers.has(normalizedPath)) {
      return; // Watcher already running
    }

    const kspecDir = join(normalizedPath, ".kspec");
    const sessionsDir = join(normalizedPath, ".kspec-sessions");
    let kspecWatcher: KspecWatcher | null = null;
    let sessionWatcher: SessionWatcher | null = null;

    try {
      // AC: @multi-directory-daemon ac-17, ac-18 - Create watcher with project-scoped broadcasts
      kspecWatcher = new KspecWatcher({
        kspecDir,
        onFileChange: (file, content) => {
          if (this.isHealthProbePath(normalizedPath, file)) {
            this.resolveHealthProbe(normalizedPath, file);
            return;
          }

          // AC: @multi-directory-daemon ac-17 - File changes trigger events scoped to project
          if (this.pubsub) {
            const relativePath = relative(kspecDir, file);
            this.pubsub.broadcast(
              "files:updates",
              "file_changed",
              {
                ref: relativePath,
                action: "modified",
              },
              normalizedPath,
            );
          }
          // AC: @agent-dispatch-engine ac-5 - Notify dispatch engine of file changes
          if (this.fileChangeCallback) {
            this.fileChangeCallback(normalizedPath, file, content);
          }
          // AC: @daemon-entity-cache ac-watcher-invalidation — invalidate affected cache domain
          if (this.cacheInvalidationCallback) {
            this.cacheInvalidationCallback(normalizedPath, kspecDir, file, content);
          }
        },
        // AC: @daemon-entity-cache ac-watcher-invalidation — file deletion/rename invalidates cache
        onFileRemoved: (file) => {
          if (this.isHealthProbePath(normalizedPath, file)) {
            return;
          }

          if (this.pubsub) {
            const relativePath = relative(kspecDir, file);
            this.pubsub.broadcast(
              "files:updates",
              "file_changed",
              {
                ref: relativePath,
                action: "removed",
              },
              normalizedPath,
            );
          }
          // Cache invalidation for removed files — same path as onFileChange
          if (this.cacheInvalidationCallback) {
            this.cacheInvalidationCallback(normalizedPath, kspecDir, file, undefined);
          }
        },
        onError: (error, file) => {
          // Broadcast error event scoped to project
          if (this.pubsub) {
            const relativePath = file ? relative(kspecDir, file) : undefined;
            this.pubsub.broadcast(
              "files:errors",
              "file_error",
              {
                ref: relativePath,
                error: error.message,
              },
              normalizedPath,
            );
          }
        },
        onPermanentFailure: () => {
          this.unregisterProject(normalizedPath);
        },
      });

      sessionWatcher = new SessionWatcher({
        sessionsDir,
        onSessionChange: (file) => {
          // AC: @daemon-entity-cache ac-watcher-invalidation — invalidate session cache domain
          if (this.cacheInvalidationCallback) {
            // Session changes invalidate the sessions domain; pass sessionsDir as kspecDir
            // so the callback can map the file to a domain
            this.cacheInvalidationCallback(normalizedPath, sessionsDir, file, undefined);
          }
        },
        onError: (error, file) => {
          if (this.pubsub) {
            const relativePath = file ? relative(sessionsDir, file) : undefined;
            this.pubsub.broadcast(
              "sessions",
              "session_error",
              {
                ref: relativePath,
                error: error.message,
              },
              normalizedPath,
            );
          }
        },
      });

      await kspecWatcher.start();
      await sessionWatcher.start();
      this.watchers.set(normalizedPath, { kspec: kspecWatcher, sessions: sessionWatcher });

      // Update context
      const context = this.projects.get(normalizedPath);
      if (context) {
        context.watcherActive = true;
      }
    } catch (error: unknown) {
      if (sessionWatcher) {
        await sessionWatcher.stop().catch(() => undefined);
      }
      if (kspecWatcher) {
        await kspecWatcher.stop().catch(() => undefined);
      }

      // AC: @multi-directory-daemon ac-19 - Handle OS limits (EMFILE/ENFILE)
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "EMFILE" || code === "ENFILE") {
        throw new Error("Unable to watch project - resource limit reached", { cause: error });
      }
      throw error;
    }
  }

  /**
   * Stop a file watcher for a project.
   *
   * AC: @multi-directory-daemon ac-20, ac-11b
   *
   * @param projectPath - Absolute path to project root
   */
  async stopWatcher(projectPath: string): Promise<void> {
    const normalizedPath = this.normalizePath(projectPath);
    const watcher = this.watchers.get(normalizedPath);

    if (watcher) {
      await watcher.kspec.stop();
      await watcher.sessions.stop();
      this.watchers.delete(normalizedPath);

      // Update context
      const context = this.projects.get(normalizedPath);
      if (context) {
        context.watcherActive = false;
      }
    }
  }

  /**
   * Stop all file watchers.
   *
   * AC: @multi-directory-daemon ac-11b - Shutdown stops all watchers
   */
  async stopAllWatchers(): Promise<void> {
    const stopPromises = Array.from(this.watchers.keys()).map((path) => this.stopWatcher(path));
    await Promise.all(stopPromises);
  }

  async verifyWatcherHealth(
    projectPath: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ healthy: boolean; durationMs: number }> {
    const normalizedPath = this.normalizePath(projectPath);
    const context = this.getProject(normalizedPath);
    const watcher = this.watchers.get(normalizedPath);

    if (!context.watcherActive || !watcher) {
      return { healthy: false, durationMs: 0 };
    }

    if (this.pendingHealthProbes.has(normalizedPath)) {
      throw new Error(`Watcher health probe already in progress for ${normalizedPath}`);
    }

    const timeoutMs = options.timeoutMs ?? watcher.kspec.getDebounceMs() + 2000;
    const startedAt = Date.now();
    const probeDir = join(normalizedPath, ".kspec", ".health-check");
    const probeFile = join(probeDir, `probe-${startedAt}.yaml`);
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      await mkdir(probeDir, { recursive: true });

      const probeDetected = new Promise<boolean>((resolve) => {
        this.pendingHealthProbes.set(normalizedPath, {
          filePath: probeFile,
          resolve: () => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
            this.pendingHealthProbes.delete(normalizedPath);
            resolve(true);
          },
        });

        timeoutHandle = setTimeout(() => {
          this.pendingHealthProbes.delete(normalizedPath);
          timeoutHandle = null;
          resolve(false);
        }, timeoutMs);
        timeoutHandle.unref?.();
      });

      await writeFile(
        probeFile,
        `watcher_health_probe: true\ncreated_at: "${new Date(startedAt).toISOString()}"\n`,
        "utf-8",
      );

      const healthy = await probeDetected;
      const durationMs = Date.now() - startedAt;

      if (healthy) {
        context.lastHealthCheckAt = new Date();
        context.consecutiveFailures = 0;
        return { healthy: true, durationMs };
      }

      context.consecutiveFailures += 1;
      console.warn(
        `[watcher-health] Watcher health check failed for ${normalizedPath} after ${durationMs}ms; restarting watcher`,
      );
      await this.stopWatcher(normalizedPath);
      await this.startWatcher(normalizedPath);

      return { healthy: false, durationMs };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      this.pendingHealthProbes.delete(normalizedPath);
      await rm(probeFile, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Register a project for multi-directory daemon support.
   *
   * AC: @multi-directory-daemon ac-4, ac-5, ac-6, ac-7, ac-8, ac-8c
   *
   * Note: This method is synchronous. Start watchers separately via startWatcher().
   *
   * @param projectPath - Absolute path to project root directory
   * @param isDefault - Whether this project should be the default
   * @returns Registered project context
   * @throws Error if path validation fails or .kspec/ not found
   */
  registerProject(projectPath: string, isDefault = false): ProjectContext {
    // AC: @multi-directory-daemon ac-6 - reject relative paths
    if (!this.isAbsolutePath(projectPath)) {
      throw new Error("Path must be absolute");
    }

    // AC: @multi-directory-daemon ac-7 - reject parent traversal
    if (projectPath.includes("..")) {
      throw new Error("Path must not contain parent traversal");
    }

    // AC: @multi-directory-daemon ac-8 - normalize path (but don't resolve symlinks)
    const normalizedPath = this.normalizePath(projectPath);

    // AC: @multi-directory-daemon ac-5 - validate .kspec/ exists
    const kspecDir = join(normalizedPath, ".kspec");
    if (!existsSync(kspecDir)) {
      throw new Error(`Invalid kspec project - .kspec/ not found at ${normalizedPath}`);
    }

    // AC: @multi-directory-daemon ac-16 - check if already registered (avoid duplicates)
    if (this.projects.has(normalizedPath)) {
      const existing = this.projects.get(normalizedPath)!;
      if (isDefault) {
        this.defaultProjectPath = normalizedPath;
      }
      return existing;
    }

    // AC: @multi-directory-daemon ac-4 - auto-register and cache
    const context: ProjectContext = {
      path: normalizedPath,
      registeredAt: new Date(),
      watcherActive: false, // Set to true when watcher is started
      lastHealthCheckAt: null,
      consecutiveFailures: 0,
    };

    this.projects.set(normalizedPath, context);

    if (isDefault) {
      this.defaultProjectPath = normalizedPath;
    }

    return context;
  }

  /**
   * Get a project by path, or use default project if no path provided.
   *
   * AC: @multi-directory-daemon ac-1, ac-2, ac-3, ac-20b
   *
   * @param projectPath - Optional absolute path to project
   * @returns Project context
   * @throws Error if project not registered, no default, or default invalid
   */
  getProject(projectPath?: string): ProjectContext {
    // AC: @multi-directory-daemon ac-1 - use provided path
    if (projectPath) {
      const normalizedPath = this.normalizePath(projectPath);
      const context = this.projects.get(normalizedPath);
      if (!context) {
        throw new Error(`Project not registered: ${normalizedPath}`);
      }
      return context;
    }

    // AC: @multi-directory-daemon ac-2, ac-3 - use default or error
    if (!this.defaultProjectPath) {
      throw new Error("No default project configured. Specify X-Kspec-Dir header.");
    }

    // AC: @multi-directory-daemon ac-20b - check if default project still valid
    const kspecDir = join(this.defaultProjectPath, ".kspec");
    if (!existsSync(kspecDir)) {
      throw new Error("Default project no longer valid. Specify X-Kspec-Dir header.");
    }

    const context = this.projects.get(this.defaultProjectPath);
    if (!context) {
      throw new Error("Default project not registered");
    }

    return context;
  }

  /**
   * Get a project if already registered, or register it if not.
   * Returns whether the project was newly registered.
   *
   * Used by all auto-registration paths (middleware, projects API, WebSocket)
   * to unify the try-get-or-register pattern.
   *
   * @param projectPath - Absolute path to project
   * @returns Object with project context and whether it was newly registered
   */
  getOrRegisterProject(projectPath: string): { context: ProjectContext; wasRegistered: boolean } {
    try {
      return { context: this.getProject(projectPath), wasRegistered: false };
    } catch {
      return { context: this.registerProject(projectPath), wasRegistered: true };
    }
  }

  /**
   * Set the default project explicitly.
   *
   * AC: @multi-directory-daemon ac-2
   *
   * @param projectPath - Absolute path to project
   * @throws Error if project not registered
   */
  setDefaultProject(projectPath: string): void {
    const normalizedPath = this.normalizePath(projectPath);
    if (!this.projects.has(normalizedPath)) {
      throw new Error("Project must be registered before setting as default");
    }
    this.defaultProjectPath = normalizedPath;
  }

  /**
   * Check if a project is registered.
   *
   * @param projectPath - Absolute path to project
   * @returns True if project is registered
   */
  hasProject(projectPath: string): boolean {
    const normalizedPath = this.normalizePath(projectPath);
    return this.projects.has(normalizedPath);
  }

  /**
   * Unregister a project and stop its watcher.
   *
   * AC: @multi-directory-daemon ac-20
   *
   * @param projectPath - Absolute path to project
   */
  unregisterProject(projectPath: string): void {
    const normalizedPath = this.normalizePath(projectPath);

    // AC: @multi-directory-daemon ac-20 - Stop watcher when unregistering (async, fire-and-forget)
    void this.stopWatcher(normalizedPath);

    this.projects.delete(normalizedPath);

    if (this.defaultProjectPath === normalizedPath) {
      this.defaultProjectPath = null;
    }

    // AC: @daemon-entity-cache ac-unregister-cleanup — notify listeners (e.g. entity cache disposal)
    // This fires for all unregister paths: API-driven, watcher permanent failure, etc.
    if (this.unregisterCallback) {
      this.unregisterCallback(normalizedPath);
    }
  }

  /**
   * List all registered projects.
   *
   * AC: @multi-directory-daemon ac-14
   *
   * Returns the in-memory runtime roster only. Restoring the roster from the
   * daemon configuration directory on restart (ac-15) is a separate, not-yet-
   * implemented daemon-startup concern; this method does not provide it.
   *
   * @returns Array of registered project contexts
   */
  listProjects(): ProjectContext[] {
    return Array.from(this.projects.values());
  }

  /**
   * Normalize path without resolving symlinks.
   *
   * AC: @multi-directory-daemon ac-8, ac-8c
   *
   * Normalizes the path by:
   * - Resolving "." segments
   * - Removing trailing slashes
   * - Normalizing multiple slashes
   * - NOT resolving symlinks (symlinked paths treated as separate projects)
   *
   * @param projectPath - Path to normalize
   * @returns Normalized path
   */
  private normalizePath(projectPath: string): string {
    // Remove trailing slashes and resolve "." segments
    // But do NOT resolve symlinks (no realpath/fs.realpathSync)
    let normalized = normalize(projectPath);

    // Remove trailing slash (normalize doesn't always do this)
    if (normalized !== "/" && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  }

  /**
   * Check if path is absolute.
   *
   * @param projectPath - Path to check
   * @returns True if path is absolute
   */
  private isAbsolutePath(projectPath: string): boolean {
    return isAbsolute(projectPath);
  }

  private resolveHealthProbe(projectPath: string, filePath: string): void {
    const pending = this.pendingHealthProbes.get(projectPath);
    if (!pending) return;
    if (this.normalizePath(pending.filePath) !== this.normalizePath(filePath)) return;
    pending.resolve();
  }

  private isHealthProbePath(projectPath: string, filePath: string): boolean {
    const relativePath = relative(join(projectPath, ".kspec"), filePath);
    return (
      !relativePath.startsWith("..") &&
      relativePath.split(/[\\/]+/)[0] === ".health-check" &&
      relativePath.endsWith(".yaml")
    );
  }
}
