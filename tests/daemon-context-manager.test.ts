/**
 * Tests for ProjectContextManager
 *
 * Tests the project registration, caching, path validation, and context management
 * for the multi-directory daemon architecture.
 *
 * AC: @multi-directory-daemon ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7, ac-8, ac-8c, ac-14, ac-15, ac-16, ac-20, ac-20b
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupMultiDirFixtures, cleanupTempDir } from './helpers/cli';
import { join } from 'path';
import { symlink } from 'fs/promises';
import { ProjectContextManager } from '../packages/daemon/src/project-context';
import type { ProjectContext } from '../packages/daemon/src/project-context';

describe('ProjectContextManager', () => {
  let fixturesRoot: string;
  let projectA: string;
  let projectB: string;
  let projectInvalid: string;
  let manager: ProjectContextManager;

  beforeEach(async () => {
    fixturesRoot = await setupMultiDirFixtures();
    projectA = join(fixturesRoot, 'project-a');
    projectB = join(fixturesRoot, 'project-b');
    projectInvalid = join(fixturesRoot, 'project-invalid');
    manager = new ProjectContextManager();
  });

  afterEach(async () => {
    await cleanupTempDir(fixturesRoot);
  });

  describe('Project registration and caching', () => {
    // AC: @multi-directory-daemon ac-4
    it('should auto-register new project on first request', () => {
      expect(manager.hasProject(projectA)).toBe(false);

      const context = manager.registerProject(projectA);

      expect(manager.hasProject(projectA)).toBe(true);
      expect(context.path).toBe(projectA);
      expect(context.watcherActive).toBe(true);
      expect(context.registeredAt).toBeInstanceOf(Date);
    });

    // AC: @multi-directory-daemon ac-4
    it('should cache registered project', () => {
      const context1 = manager.registerProject(projectA);
      const context2 = manager.getProject(projectA);

      expect(context1).toBe(context2); // Same object reference
    });

    // AC: @multi-directory-daemon ac-14
    it('should register multiple projects independently', () => {
      manager.registerProject(projectA);
      manager.registerProject(projectB);

      expect(manager.hasProject(projectA)).toBe(true);
      expect(manager.hasProject(projectB)).toBe(true);

      const contextA = manager.getProject(projectA);
      const contextB = manager.getProject(projectB);

      expect(contextA.path).toBe(projectA);
      expect(contextB.path).toBe(projectB);
    });

    // AC: @multi-directory-daemon ac-15
    it('should list all registered projects', () => {
      manager.registerProject(projectA);
      manager.registerProject(projectB);

      const projects = manager.listProjects();

      expect(projects).toHaveLength(2);
      expect(projects.map(p => p.path)).toContain(projectA);
      expect(projects.map(p => p.path)).toContain(projectB);
    });

    // AC: @multi-directory-daemon ac-16
    it('should handle concurrent registration of same project', () => {
      // Simulate concurrent registration
      const context1 = manager.registerProject(projectA);
      const context2 = manager.registerProject(projectA);

      // Should return same context (no duplicate)
      expect(context1).toBe(context2);
      expect(manager.listProjects()).toHaveLength(1);
    });

    // AC: @multi-directory-daemon ac-4
    it('should not re-register already cached project', () => {
      const context1 = manager.registerProject(projectA);
      const registeredAt1 = context1.registeredAt;

      // Re-register immediately (should return same cached instance)
      const context2 = manager.registerProject(projectA);

      expect(context2).toBe(context1);
      expect(context2.registeredAt).toBe(registeredAt1);
    });
  });

  describe('Path validation', () => {
    // AC: @multi-directory-daemon ac-5
    it('should reject path without .kspec/ directory', () => {
      expect(() => {
        manager.registerProject(projectInvalid);
      }).toThrow('Invalid kspec project - .kspec/ not found');
    });

    // AC: @multi-directory-daemon ac-6
    it('should reject relative paths', () => {
      expect(() => {
        manager.registerProject('./project-a');
      }).toThrow('Path must be absolute');
    });

    // AC: @multi-directory-daemon ac-6
    it('should reject paths without leading slash', () => {
      expect(() => {
        manager.registerProject('project-a');
      }).toThrow('Path must be absolute');
    });

    // AC: @multi-directory-daemon ac-7
    it('should reject paths with parent traversal (..) segments', () => {
      expect(() => {
        manager.registerProject(`${projectA}/../project-a`);
      }).toThrow('Path must not contain parent traversal');
    });

    // AC: @multi-directory-daemon ac-7
    it('should reject paths with .. in middle', () => {
      expect(() => {
        manager.registerProject('/some/path/../other/path');
      }).toThrow('Path must not contain parent traversal');
    });
  });

  describe('Path normalization', () => {
    // AC: @multi-directory-daemon ac-8
    it('should normalize path with trailing slash', () => {
      const contextWithSlash = manager.registerProject(`${projectA}/`);
      const contextWithoutSlash = manager.getProject(projectA);

      expect(contextWithSlash).toBe(contextWithoutSlash);
      expect(contextWithSlash.path).toBe(projectA); // No trailing slash
    });

    // AC: @multi-directory-daemon ac-8
    it('should normalize path with dot segments', () => {
      const pathWithDot = `${projectA}/.`;
      const context = manager.registerProject(pathWithDot);

      expect(context.path).toBe(projectA); // Dot removed
    });

    // AC: @multi-directory-daemon ac-8
    it('should normalize path with multiple slashes', () => {
      const pathWithSlashes = `${fixturesRoot}//project-a`;
      const context = manager.registerProject(pathWithSlashes);

      expect(context.path).toBe(projectA); // Double slash normalized
    });

    // AC: @multi-directory-daemon ac-8c
    it('should NOT resolve symlinks during normalization', async () => {
      // Create symlink to project-a
      const symlinkPath = join(fixturesRoot, 'project-a-symlink');
      await symlink(projectA, symlinkPath, 'dir');

      // Register both real path and symlink
      manager.registerProject(projectA);
      manager.registerProject(symlinkPath);

      // Should be treated as separate projects
      expect(manager.listProjects()).toHaveLength(2);

      const contextReal = manager.getProject(projectA);
      const contextSymlink = manager.getProject(symlinkPath);

      expect(contextReal.path).toBe(projectA);
      expect(contextSymlink.path).toBe(symlinkPath);
      expect(contextReal).not.toBe(contextSymlink);
    });
  });

  describe('Default project handling', () => {
    // AC: @multi-directory-daemon ac-2
    it('should use default project when no path specified', () => {
      manager.registerProject(projectA, true);

      const context = manager.getProject();
      expect(context.path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-2
    it('should set default project explicitly', () => {
      manager.registerProject(projectA);
      manager.setDefaultProject(projectA);

      const context = manager.getProject();
      expect(context.path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-3
    it('should error when no default project and no path provided', () => {
      expect(() => {
        manager.getProject();
      }).toThrow('No default project configured. Specify X-Kspec-Dir header.');
    });

    // AC: @multi-directory-daemon ac-2
    it('should allow default project from constructor', () => {
      const managerWithDefault = new ProjectContextManager(projectA);
      managerWithDefault.registerProject(projectA);

      const context = managerWithDefault.getProject();
      expect(context.path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-2
    it('should switch default project when requested', () => {
      manager.registerProject(projectA);
      manager.registerProject(projectB);
      manager.setDefaultProject(projectA);

      let context = manager.getProject();
      expect(context.path).toBe(projectA);

      manager.setDefaultProject(projectB);
      context = manager.getProject();
      expect(context.path).toBe(projectB);
    });

    // AC: @multi-directory-daemon ac-2
    it('should error when setting unregistered project as default', () => {
      expect(() => {
        manager.setDefaultProject(projectA);
      }).toThrow('Project must be registered before setting as default');
    });
  });

  describe('Project unregistration', () => {
    // AC: @multi-directory-daemon ac-20
    it('should unregister project', () => {
      manager.registerProject(projectA);
      expect(manager.hasProject(projectA)).toBe(true);

      manager.unregisterProject(projectA);
      expect(manager.hasProject(projectA)).toBe(false);
    });

    // AC: @multi-directory-daemon ac-20
    it('should clear default project when unregistering it', () => {
      manager.registerProject(projectA, true);
      expect(() => manager.getProject()).not.toThrow();

      manager.unregisterProject(projectA);

      expect(() => {
        manager.getProject();
      }).toThrow('No default project configured');
    });

    // AC: @multi-directory-daemon ac-20
    it('should not affect other projects when unregistering', () => {
      manager.registerProject(projectA);
      manager.registerProject(projectB);

      manager.unregisterProject(projectA);

      expect(manager.hasProject(projectA)).toBe(false);
      expect(manager.hasProject(projectB)).toBe(true);
    });
  });

  describe('Deleted project detection', () => {
    // AC: @multi-directory-daemon ac-20b
    it('should error when default project .kspec/ is deleted', async () => {
      manager.registerProject(projectA, true);

      // Delete .kspec/ directory
      const kspecDir = join(projectA, '.kspec');
      await cleanupTempDir(kspecDir);

      expect(() => {
        manager.getProject();
      }).toThrow('Default project no longer valid. Specify X-Kspec-Dir header.');
    });

    // AC: @multi-directory-daemon ac-2
    it('should allow non-default project access even if default is deleted', async () => {
      manager.registerProject(projectA, true);
      manager.registerProject(projectB);

      // Delete default project's .kspec/
      const kspecDir = join(projectA, '.kspec');
      await cleanupTempDir(kspecDir);

      // Should error without path (default deleted)
      expect(() => manager.getProject()).toThrow('Default project no longer valid');

      // Should succeed with explicit path
      const contextB = manager.getProject(projectB);
      expect(contextB.path).toBe(projectB);
    });
  });

  describe('Get project validation', () => {
    // AC: @multi-directory-daemon ac-1
    it('should return registered project by path', () => {
      manager.registerProject(projectA);
      const context = manager.getProject(projectA);

      expect(context.path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-1
    it('should error when getting unregistered project', () => {
      expect(() => {
        manager.getProject(projectA);
      }).toThrow('Project not registered');
    });

    // AC: @multi-directory-daemon ac-8
    it('should normalize path when getting project', () => {
      manager.registerProject(projectA);

      // Get with trailing slash
      const context = manager.getProject(`${projectA}/`);
      expect(context.path).toBe(projectA);
    });
  });
});
