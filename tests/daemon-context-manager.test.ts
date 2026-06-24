/**
 * Tests for ProjectContextManager
 *
 * Tests the project registration, caching, path validation, and context management
 * for the multi-directory daemon architecture.
 *
 * AC: @multi-directory-daemon ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7, ac-8, ac-8c, ac-14, ac-16, ac-20, ac-20b
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupMultiDirFixtures, cleanupTempDir } from "./helpers/cli";
import { join } from "path";
import { access, mkdir, readdir, rm, symlink, writeFile } from "fs/promises";
import { ProjectContextManager } from "../packages/daemon/src/project-context";
import { KspecWatcher } from "../packages/daemon/src/watcher";
import { SessionWatcher } from "../packages/daemon/src/session-watcher";
import { WatcherHealthMonitor } from "../packages/daemon/src/watcher-health-monitor";

const WATCHER_WAIT_MS = process.env.CI ? 2500 : 1500;

describe("ProjectContextManager", () => {
  let fixturesRoot: string;
  let projectA: string;
  let projectB: string;
  let projectInvalid: string;
  let manager: ProjectContextManager;

  beforeEach(async () => {
    fixturesRoot = await setupMultiDirFixtures();
    projectA = join(fixturesRoot, "project-a");
    projectB = join(fixturesRoot, "project-b");
    projectInvalid = join(fixturesRoot, "project-invalid");
    manager = new ProjectContextManager();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.stopAllWatchers().catch(() => undefined);
    await cleanupTempDir(fixturesRoot);
  });

  describe("Project registration and caching", () => {
    // AC: @multi-directory-daemon ac-4
    it("should auto-register new project on first request", () => {
      expect(manager.hasProject(projectA)).toBe(false);

      const context = manager.registerProject(projectA);

      expect(manager.hasProject(projectA)).toBe(true);
      expect(context.path).toBe(projectA);
      expect(context.watcherActive).toBe(false); // Watcher started separately via startWatcher()
      expect(context.registeredAt).toBeInstanceOf(Date);
    });

    // AC: @multi-directory-daemon ac-4
    it("should cache registered project", () => {
      const context1 = manager.registerProject(projectA);
      const context2 = manager.getProject(projectA);

      expect(context1).toBe(context2); // Same object reference
    });

    // AC: @multi-directory-daemon ac-14
    it("should register multiple projects independently", () => {
      manager.registerProject(projectA);
      manager.registerProject(projectB);

      expect(manager.hasProject(projectA)).toBe(true);
      expect(manager.hasProject(projectB)).toBe(true);

      const contextA = manager.getProject(projectA);
      const contextB = manager.getProject(projectB);

      expect(contextA.path).toBe(projectA);
      expect(contextB.path).toBe(projectB);
    });

    // Supporting unit test for listProjects() (underpins serve status / GET /api/projects).
    // Not ac-15 coverage: ac-15 is restart roster restore, which this in-memory test does not exercise.
    it("should list all registered projects", () => {
      manager.registerProject(projectA);
      manager.registerProject(projectB);

      const projects = manager.listProjects();

      expect(projects).toHaveLength(2);
      expect(projects.map((p) => p.path)).toContain(projectA);
      expect(projects.map((p) => p.path)).toContain(projectB);
    });

    // AC: @multi-directory-daemon ac-16
    it("should handle concurrent registration of same project", () => {
      // Simulate concurrent registration
      const context1 = manager.registerProject(projectA);
      const context2 = manager.registerProject(projectA);

      // Should return same context (no duplicate)
      expect(context1).toBe(context2);
      expect(manager.listProjects()).toHaveLength(1);
    });

    // AC: @multi-directory-daemon ac-4
    it("should not re-register already cached project", () => {
      const context1 = manager.registerProject(projectA);
      const registeredAt1 = context1.registeredAt;

      // Re-register immediately (should return same cached instance)
      const context2 = manager.registerProject(projectA);

      expect(context2).toBe(context1);
      expect(context2.registeredAt).toBe(registeredAt1);
    });
  });

  describe("Watcher startup rollback", () => {
    it("stops an already-started kspec watcher if session watcher startup fails", async () => {
      manager.registerProject(projectA);

      const kspecWatcherStart = vi.spyOn(KspecWatcher.prototype, "start").mockResolvedValue();
      const kspecWatcherStop = vi.spyOn(KspecWatcher.prototype, "stop").mockResolvedValue();
      const sessionWatcherStart = vi
        .spyOn(SessionWatcher.prototype, "start")
        .mockRejectedValue(new Error("session watcher failed"));
      const sessionWatcherStop = vi.spyOn(SessionWatcher.prototype, "stop").mockResolvedValue();

      await expect(manager.startWatcher(projectA)).rejects.toThrow("session watcher failed");

      expect(kspecWatcherStart).toHaveBeenCalledOnce();
      expect(sessionWatcherStart).toHaveBeenCalledOnce();
      expect(kspecWatcherStop).toHaveBeenCalledOnce();
      expect(sessionWatcherStop).toHaveBeenCalledOnce();
    });

    // AC: @daemon-file-monitoring ac-8
    // AC: @multi-directory-daemon ac-34
    it("unregisters a project when the watcher reports permanent directory removal", async () => {
      manager.registerProject(projectA);

      const watcherInstances: KspecWatcher[] = [];
      const kspecWatcherStart = vi
        .spyOn(KspecWatcher.prototype, "start")
        .mockImplementation(async function () {
          watcherInstances.push(this as KspecWatcher);
        });
      const kspecWatcherStop = vi.spyOn(KspecWatcher.prototype, "stop").mockResolvedValue();
      const sessionWatcherStart = vi.spyOn(SessionWatcher.prototype, "start").mockResolvedValue();
      const sessionWatcherStop = vi.spyOn(SessionWatcher.prototype, "stop").mockResolvedValue();

      await manager.startWatcher(projectA);
      expect(kspecWatcherStart).toHaveBeenCalledOnce();
      expect(sessionWatcherStart).toHaveBeenCalledOnce();
      expect(manager.hasProject(projectA)).toBe(true);

      await (
        watcherInstances[0] as KspecWatcher & {
          options: { onPermanentFailure?: (kspecDir: string) => void | Promise<void> };
        }
      ).options.onPermanentFailure?.(join(projectA, ".kspec"));

      await vi.waitFor(() => {
        expect(manager.hasProject(projectA)).toBe(false);
      });

      expect(kspecWatcherStop).toHaveBeenCalledOnce();
      expect(sessionWatcherStop).toHaveBeenCalledOnce();
    });
  });

  describe("cache invalidation callback content passthrough", () => {
    // AC: @daemon-incremental-cache ac-watcher-content-passthrough
    it("forwards watcher-read file content to the cache invalidation callback", async () => {
      manager.registerProject(projectA);

      const received: Array<{
        projectPath: string;
        kspecDir: string;
        file: string;
        content: string | undefined;
      }> = [];
      manager.setCacheInvalidationCallback((projectPath, kspecDir, file, content) => {
        received.push({ projectPath, kspecDir, file, content });
      });

      await manager.startWatcher(projectA);

      const changedFile = join(projectA, ".kspec", "modules", "content-passthrough.yaml");
      const changedContent = "title: Content passthrough\n";
      await writeFile(changedFile, changedContent, "utf-8");

      await vi.waitFor(
        () => {
          expect(received).toContainEqual({
            projectPath: projectA,
            kspecDir: join(projectA, ".kspec"),
            file: changedFile,
            content: changedContent,
          });
        },
        { timeout: WATCHER_WAIT_MS },
      );
    });

    // AC: @daemon-incremental-cache ac-watcher-content-passthrough
    it("passes undefined content to cache invalidation for removed files", async () => {
      manager.registerProject(projectA);

      const received: Array<{
        projectPath: string;
        kspecDir: string;
        file: string;
        content: string | undefined;
      }> = [];
      manager.setCacheInvalidationCallback((projectPath, kspecDir, file, content) => {
        received.push({ projectPath, kspecDir, file, content });
      });

      await manager.startWatcher(projectA);

      const removedFile = join(projectA, ".kspec", "modules", "content-removed.yaml");
      await writeFile(removedFile, "title: Content removed\n", "utf-8");
      await vi.waitFor(
        () => {
          expect(received.some((event) => event.file === removedFile)).toBe(true);
        },
        { timeout: WATCHER_WAIT_MS },
      );

      received.length = 0;
      await rm(removedFile);

      await vi.waitFor(
        () => {
          expect(received).toContainEqual({
            projectPath: projectA,
            kspecDir: join(projectA, ".kspec"),
            file: removedFile,
            content: undefined,
          });
        },
        { timeout: WATCHER_WAIT_MS },
      );
    });

    // AC: @coverage-state-api-cache ac-cache-invalidation
    it("forwards configured coverage scan-path file changes to cache invalidation", async () => {
      await writeFile(
        join(projectA, "kspec.config.yaml"),
        "coverage:\n  scan_paths:\n    - tests\n",
        "utf-8",
      );
      await mkdir(join(projectA, "tests"), { recursive: true });
      manager.registerProject(projectA);

      const received: Array<{
        projectPath: string;
        kspecDir: string;
        file: string;
        content: string | undefined;
      }> = [];
      manager.setCacheInvalidationCallback((projectPath, kspecDir, file, content) => {
        received.push({ projectPath, kspecDir, file, content });
      });

      await manager.startWatcher(projectA);

      const changedFile = join(projectA, "tests", "coverage-source.test.ts");
      await writeFile(
        changedFile,
        `// ${"AC"}: @coverage-state-api-cache ac-cache-invalidation\n`,
        "utf-8",
      );

      await vi.waitFor(
        () => {
          expect(received).toContainEqual({
            projectPath: projectA,
            kspecDir: projectA,
            file: changedFile,
            content: undefined,
          });
        },
        { timeout: WATCHER_WAIT_MS },
      );
    });

    // AC: @coverage-state-api-cache ac-cache-invalidation
    it("reconfigures coverage source watching when configured scan paths change", async () => {
      const configFile = join(projectA, "kspec.config.yaml");
      await writeFile(configFile, "coverage:\n  scan_paths:\n    - tests\n", "utf-8");
      await mkdir(join(projectA, "tests"), { recursive: true });
      await mkdir(join(projectA, "runtime-tests"), { recursive: true });
      manager.registerProject(projectA);

      const received: Array<{
        projectPath: string;
        kspecDir: string;
        file: string;
        content: string | undefined;
      }> = [];
      manager.setCacheInvalidationCallback((projectPath, kspecDir, file, content) => {
        received.push({ projectPath, kspecDir, file, content });
      });

      await manager.startWatcher(projectA);
      await writeFile(configFile, "coverage:\n  scan_paths:\n    - runtime-tests\n", "utf-8");

      await vi.waitFor(
        () => {
          expect(received).toContainEqual({
            projectPath: projectA,
            kspecDir: projectA,
            file: configFile,
            content: undefined,
          });
        },
        { timeout: WATCHER_WAIT_MS },
      );

      received.length = 0;
      const changedFile = join(projectA, "runtime-tests", "coverage-source.test.ts");
      await writeFile(
        changedFile,
        `// ${"AC"}: @coverage-state-api-cache ac-cache-invalidation\n`,
        "utf-8",
      );

      await vi.waitFor(
        () => {
          expect(received).toContainEqual({
            projectPath: projectA,
            kspecDir: projectA,
            file: changedFile,
            content: undefined,
          });
        },
        { timeout: WATCHER_WAIT_MS },
      );
    });
  });

  describe("Watcher health verification", () => {
    // AC: @daemon-watcher-health ac-1
    it("verifies a synthetic watcher change within the expected window", async () => {
      manager.registerProject(projectA);
      await manager.startWatcher(projectA);
      const verification = manager.verifyWatcherHealth(projectA, {
        timeoutMs: WATCHER_WAIT_MS,
      });
      const probeDir = join(projectA, ".kspec", ".health-check");

      await vi.waitFor(async () => {
        await access(probeDir);
        const files = await readdir(probeDir);
        expect(files.length).toBe(1);
      });

      const [probeName] = await readdir(probeDir);
      const probePath = join(probeDir, probeName);

      const result = await verification;
      const context = manager.getProject(projectA);

      expect(result.healthy).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(context.lastHealthCheckAt).toBeInstanceOf(Date);
      expect(context.consecutiveFailures).toBe(0);
      await expect(access(probePath)).rejects.toThrow();
    });

    // AC: @daemon-watcher-health ac-2
    it("restarts the affected watcher and recovers event delivery when probe delivery times out", async () => {
      manager.registerProject(projectA);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deliveredFiles: string[] = [];
      manager.setCacheInvalidationCallback((projectPath, _kspecDir, file) => {
        if (projectPath === projectA) {
          deliveredFiles.push(file);
        }
      });

      await manager.startWatcher(projectA);

      const stopSpy = vi.spyOn(manager, "stopWatcher");
      const startSpy = vi.spyOn(manager, "startWatcher");
      stopSpy.mockClear();
      startSpy.mockClear();

      const internalManager = manager as ProjectContextManager & {
        watchers: Map<string, { kspec: KspecWatcher; sessions: SessionWatcher }>;
      };
      const closedWatcher = internalManager.watchers.get(projectA)?.kspec as KspecWatcher & {
        watcher: { close(): Promise<void> } | null;
      };
      await closedWatcher.watcher?.close();

      const result = await manager.verifyWatcherHealth(projectA, { timeoutMs: 50 });
      const context = manager.getProject(projectA);

      expect(result.healthy).toBe(false);
      expect(context.lastHealthCheckAt).toBeNull();
      expect(context.consecutiveFailures).toBe(1);
      expect(stopSpy).toHaveBeenCalledWith(projectA);
      expect(startSpy).toHaveBeenCalledWith(projectA);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[watcher-health] Watcher health check failed for ${projectA}`),
      );

      const recoveredFile = join(projectA, ".kspec", "modules", "watcher-health-recovered.yaml");
      await writeFile(recoveredFile, "recovered: true\n", "utf-8");

      await vi.waitFor(
        () => {
          expect(deliveredFiles).toContain(recoveredFile);
        },
        { timeout: WATCHER_WAIT_MS },
      );
    });

    // AC: @daemon-watcher-health ac-3
    it("restarts only the failed project's watcher while other projects remain monitored", async () => {
      manager.registerProject(projectA);
      manager.registerProject(projectB);

      const deliveredByProject = new Map<string, string[]>([
        [projectA, []],
        [projectB, []],
      ]);
      manager.setCacheInvalidationCallback((projectPath, _kspecDir, file) => {
        deliveredByProject.get(projectPath)?.push(file);
      });

      await manager.startWatcher(projectA);
      await manager.startWatcher(projectB);

      const stopSpy = vi.spyOn(manager, "stopWatcher");
      const startSpy = vi.spyOn(manager, "startWatcher");
      stopSpy.mockClear();
      startSpy.mockClear();

      const internalManager = manager as ProjectContextManager & {
        watchers: Map<string, { kspec: KspecWatcher; sessions: SessionWatcher }>;
      };
      const failedWatcher = internalManager.watchers.get(projectA)?.kspec as KspecWatcher & {
        watcher: { close(): Promise<void> } | null;
      };
      await failedWatcher.watcher?.close();

      await manager.verifyWatcherHealth(projectA, { timeoutMs: 50 });

      expect(stopSpy.mock.calls).toEqual([[projectA]]);
      expect(startSpy.mock.calls).toEqual([[projectA]]);
      expect(manager.getProject(projectB).watcherActive).toBe(true);
      expect(manager.getProject(projectB).consecutiveFailures).toBe(0);

      const healthyProjectFile = join(
        projectB,
        ".kspec",
        "modules",
        "watcher-health-project-b.yaml",
      );
      await writeFile(healthyProjectFile, "healthy: true\n", "utf-8");

      await vi.waitFor(
        () => {
          expect(deliveredByProject.get(projectB)).toContain(healthyProjectFile);
        },
        { timeout: WATCHER_WAIT_MS },
      );
      expect(deliveredByProject.get(projectA)).not.toContain(healthyProjectFile);
    });

    // AC: @daemon-watcher-health ac-1
    it("runs periodic checks only for active watchers", async () => {
      manager.registerProject(projectA);
      manager.registerProject(projectB);
      manager.getProject(projectA).watcherActive = true;

      const verifySpy = vi.spyOn(manager, "verifyWatcherHealth").mockResolvedValue({
        healthy: true,
        durationMs: 5,
      });

      const monitor = new WatcherHealthMonitor(manager, { intervalMs: 10 });
      await monitor.runOnce();
      monitor.stop();

      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(verifySpy).toHaveBeenCalledWith(projectA);
      expect(verifySpy).not.toHaveBeenCalledWith(projectB);
    });
  });

  describe("Daemon restart behavior", () => {
    // AC: @multi-directory-daemon ac-14
    it("should re-register project automatically after daemon restart", () => {
      // Initial registration before restart
      manager.registerProject(projectA);
      manager.registerProject(projectB);
      expect(manager.listProjects()).toHaveLength(2);

      // Simulate daemon restart (new instance)
      const managerAfterRestart = new ProjectContextManager();

      // Verify list is empty after restart
      expect(managerAfterRestart.listProjects()).toHaveLength(0);

      // Simulate first request - auto-registers project
      const context = managerAfterRestart.registerProject(projectA);
      expect(context.path).toBe(projectA);
      expect(managerAfterRestart.hasProject(projectA)).toBe(true);

      // Project B is not re-registered yet
      expect(managerAfterRestart.hasProject(projectB)).toBe(false);
    });

    // ac-15 (roster restore from daemon config on restart) is intentionally future
    // work — ProjectContextManager holds per-process runtime state only and starts
    // empty on construction (see the ac-14 test above). Restore-from-config is a
    // separate daemon-startup layer that does not yet exist, so there is no
    // behavioral test claiming ac-15 coverage here. See follow-up task
    // @task-implement-daemon-roster-persistence.
  });

  describe("Path validation", () => {
    // AC: @multi-directory-daemon ac-5
    it("should reject path without .kspec/ directory", () => {
      expect(() => {
        manager.registerProject(projectInvalid);
      }).toThrow("Invalid kspec project - .kspec/ not found");
    });

    // AC: @multi-directory-daemon ac-6
    it("should reject relative paths", () => {
      expect(() => {
        manager.registerProject("./project-a");
      }).toThrow("Path must be absolute");
    });

    // AC: @multi-directory-daemon ac-6
    it("should reject paths without leading slash", () => {
      expect(() => {
        manager.registerProject("project-a");
      }).toThrow("Path must be absolute");
    });

    // AC: @multi-directory-daemon ac-7
    it("should reject paths with parent traversal (..) segments", () => {
      expect(() => {
        manager.registerProject(`${projectA}/../project-a`);
      }).toThrow("Path must not contain parent traversal");
    });

    // AC: @multi-directory-daemon ac-7
    it("should reject paths with .. in middle", () => {
      expect(() => {
        manager.registerProject("/some/path/../other/path");
      }).toThrow("Path must not contain parent traversal");
    });
  });

  describe("Path normalization", () => {
    // AC: @multi-directory-daemon ac-8
    it("should normalize path with trailing slash", () => {
      const contextWithSlash = manager.registerProject(`${projectA}/`);
      const contextWithoutSlash = manager.getProject(projectA);

      expect(contextWithSlash).toBe(contextWithoutSlash);
      expect(contextWithSlash.path).toBe(projectA); // No trailing slash
    });

    // AC: @multi-directory-daemon ac-8
    it("should normalize path with dot segments", () => {
      const pathWithDot = `${projectA}/.`;
      const context = manager.registerProject(pathWithDot);

      expect(context.path).toBe(projectA); // Dot removed
    });

    // AC: @multi-directory-daemon ac-8
    it("should normalize path with multiple slashes", () => {
      const pathWithSlashes = `${fixturesRoot}//project-a`;
      const context = manager.registerProject(pathWithSlashes);

      expect(context.path).toBe(projectA); // Double slash normalized
    });

    // AC: @multi-directory-daemon ac-8c
    it("should NOT resolve symlinks during normalization", async () => {
      // Create symlink to project-a
      const symlinkPath = join(fixturesRoot, "project-a-symlink");
      await symlink(projectA, symlinkPath, "dir");

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

  describe("Default project handling", () => {
    // AC: @multi-directory-daemon ac-2
    it("should use default project when no path specified", () => {
      manager.registerProject(projectA, true);

      const context = manager.getProject();
      expect(context.path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-2
    it("should set default project explicitly", () => {
      manager.registerProject(projectA);
      manager.setDefaultProject(projectA);

      const context = manager.getProject();
      expect(context.path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-3
    it("should error when no default project and no path provided", () => {
      expect(() => {
        manager.getProject();
      }).toThrow("No default project configured. Specify X-Kspec-Dir header.");
    });

    // AC: @multi-directory-daemon ac-2
    it("should allow default project from constructor", () => {
      const managerWithDefault = new ProjectContextManager(projectA);
      managerWithDefault.registerProject(projectA);

      const context = managerWithDefault.getProject();
      expect(context.path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-2
    it("should switch default project when requested", () => {
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
    it("should error when setting unregistered project as default", () => {
      expect(() => {
        manager.setDefaultProject(projectA);
      }).toThrow("Project must be registered before setting as default");
    });
  });

  describe("Project unregistration", () => {
    // AC: @multi-directory-daemon ac-20
    it("should unregister project", () => {
      manager.registerProject(projectA);
      expect(manager.hasProject(projectA)).toBe(true);

      manager.unregisterProject(projectA);
      expect(manager.hasProject(projectA)).toBe(false);
    });

    // AC: @multi-directory-daemon ac-20
    it("should clear default project when unregistering it", () => {
      manager.registerProject(projectA, true);
      expect(() => manager.getProject()).not.toThrow();

      manager.unregisterProject(projectA);

      expect(() => {
        manager.getProject();
      }).toThrow("No default project configured");
    });

    // AC: @multi-directory-daemon ac-20
    it("should not affect other projects when unregistering", () => {
      manager.registerProject(projectA);
      manager.registerProject(projectB);

      manager.unregisterProject(projectA);

      expect(manager.hasProject(projectA)).toBe(false);
      expect(manager.hasProject(projectB)).toBe(true);
    });
  });

  describe("Deleted project detection", () => {
    // AC: @multi-directory-daemon ac-20b
    it("should error when default project .kspec/ is deleted", async () => {
      manager.registerProject(projectA, true);

      // Delete .kspec/ directory
      const kspecDir = join(projectA, ".kspec");
      await cleanupTempDir(kspecDir);

      expect(() => {
        manager.getProject();
      }).toThrow("Default project no longer valid. Specify X-Kspec-Dir header.");
    });

    // AC: @multi-directory-daemon ac-2
    it("should allow non-default project access even if default is deleted", async () => {
      manager.registerProject(projectA, true);
      manager.registerProject(projectB);

      // Delete default project's .kspec/
      const kspecDir = join(projectA, ".kspec");
      await cleanupTempDir(kspecDir);

      // Should error without path (default deleted)
      expect(() => manager.getProject()).toThrow("Default project no longer valid");

      // Should succeed with explicit path
      const contextB = manager.getProject(projectB);
      expect(contextB.path).toBe(projectB);
    });
  });

  describe("Get project validation", () => {
    // AC: @multi-directory-daemon ac-1
    it("should return registered project by path", () => {
      manager.registerProject(projectA);
      const context = manager.getProject(projectA);

      expect(context.path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-1
    it("should error when getting unregistered project", () => {
      expect(() => {
        manager.getProject(projectA);
      }).toThrow("Project not registered");
    });

    // AC: @multi-directory-daemon ac-8
    it("should normalize path when getting project", () => {
      manager.registerProject(projectA);

      // Get with trailing slash
      const context = manager.getProject(`${projectA}/`);
      expect(context.path).toBe(projectA);
    });
  });
});
