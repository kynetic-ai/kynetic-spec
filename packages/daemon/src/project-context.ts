/**
 * ProjectContextManager - Multi-project daemon support
 *
 * Manages project registration, caching, path validation, and context management
 * for multi-directory daemon architecture.
 *
 * AC: @multi-directory-daemon ac-1 through ac-20b
 */

import { existsSync } from 'fs';
import { isAbsolute, join, normalize, relative } from 'path';
import { KspecWatcher } from './watcher';
import type { PubSubManager } from './websocket/pubsub';

export interface ProjectContext {
  path: string;
  registeredAt: Date;
  watcherActive: boolean;
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
  private watchers: Map<string, KspecWatcher> = new Map();
  private defaultProjectPath: string | null = null;
  private pubsub: PubSubManager | null = null;

  constructor(defaultProjectPath?: string, pubsub?: PubSubManager) {
    if (defaultProjectPath) {
      this.defaultProjectPath = defaultProjectPath;
    }
    if (pubsub) {
      this.pubsub = pubsub;
    }
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

    const kspecDir = join(normalizedPath, '.kspec');

    try {
      // AC: @multi-directory-daemon ac-17, ac-18 - Create watcher with project-scoped broadcasts
      const watcher = new KspecWatcher({
        kspecDir,
        onFileChange: (file, content) => {
          // AC: @multi-directory-daemon ac-17 - File changes trigger events scoped to project
          if (this.pubsub) {
            const relativePath = relative(kspecDir, file);
            this.pubsub.broadcast('files:updates', 'file_changed', {
              ref: relativePath,
              action: 'modified'
            }, normalizedPath);
          }
        },
        onError: (error, file) => {
          // Broadcast error event scoped to project
          if (this.pubsub) {
            const relativePath = file ? relative(kspecDir, file) : undefined;
            this.pubsub.broadcast('files:errors', 'file_error', {
              ref: relativePath,
              error: error.message
            }, normalizedPath);
          }
        }
      });

      await watcher.start();
      this.watchers.set(normalizedPath, watcher);

      // Update context
      const context = this.projects.get(normalizedPath);
      if (context) {
        context.watcherActive = true;
      }
    } catch (error: any) {
      // AC: @multi-directory-daemon ac-19 - Handle OS limits (EMFILE/ENFILE)
      if (error.code === 'EMFILE' || error.code === 'ENFILE') {
        throw new Error('Unable to watch project - resource limit reached');
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
      await watcher.stop();
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
    const stopPromises = Array.from(this.watchers.keys()).map(path =>
      this.stopWatcher(path)
    );
    await Promise.all(stopPromises);
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
      throw new Error('Path must be absolute');
    }

    // AC: @multi-directory-daemon ac-7 - reject parent traversal
    if (projectPath.includes('..')) {
      throw new Error('Path must not contain parent traversal');
    }

    // AC: @multi-directory-daemon ac-8 - normalize path (but don't resolve symlinks)
    const normalizedPath = this.normalizePath(projectPath);

    // AC: @multi-directory-daemon ac-5 - validate .kspec/ exists
    const kspecDir = join(normalizedPath, '.kspec');
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
      throw new Error('No default project configured. Specify X-Kspec-Dir header.');
    }

    // AC: @multi-directory-daemon ac-20b - check if default project still valid
    const kspecDir = join(this.defaultProjectPath, '.kspec');
    if (!existsSync(kspecDir)) {
      throw new Error('Default project no longer valid. Specify X-Kspec-Dir header.');
    }

    const context = this.projects.get(this.defaultProjectPath);
    if (!context) {
      throw new Error('Default project not registered');
    }

    return context;
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
      throw new Error('Project must be registered before setting as default');
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
  }

  /**
   * List all registered projects.
   *
   * AC: @multi-directory-daemon ac-14, ac-15
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
    if (normalized !== '/' && normalized.endsWith('/')) {
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
}
