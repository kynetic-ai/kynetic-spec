/**
 * ProjectContextManager - Multi-project daemon support
 *
 * Manages project registration, caching, path validation, and context management
 * for multi-directory daemon architecture.
 *
 * AC: @multi-directory-daemon ac-1 through ac-20b
 */

import { existsSync } from 'fs';
import { join, normalize } from 'path';

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
 */
export class ProjectContextManager {
  private projects: Map<string, ProjectContext> = new Map();
  private defaultProjectPath: string | null = null;

  constructor(defaultProjectPath?: string) {
    if (defaultProjectPath) {
      this.defaultProjectPath = defaultProjectPath;
    }
  }

  /**
   * Register a project for multi-directory daemon support.
   *
   * AC: @multi-directory-daemon ac-4, ac-5, ac-6, ac-7, ac-8, ac-8c
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
      watcherActive: true,
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
    // Check for absolute path (Unix: starts with /, Windows: matches /^[A-Z]:\\/i)
    return projectPath.startsWith('/') || /^[A-Z]:\\/i.test(projectPath);
  }
}
