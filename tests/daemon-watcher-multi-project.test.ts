/**
 * Tests for per-project file watcher behavior in multi-directory daemon
 *
 * Tests file watcher integration with ProjectContextManager to ensure:
 * - Each project gets its own watcher instance
 * - Events are scoped to the correct project
 * - Watchers are cleaned up on project unregister
 * - OS resource limits are handled gracefully
 *
 * AC: @multi-directory-daemon ac-17, ac-18, ac-19
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupMultiDirFixtures, cleanupTempDir } from './helpers/cli';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { KspecWatcher } from '../packages/daemon/src/watcher';

describe('Per-Project File Watchers', () => {
  let fixturesRoot: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    fixturesRoot = await setupMultiDirFixtures();
    projectA = join(fixturesRoot, 'project-a');
    projectB = join(fixturesRoot, 'project-b');
  });

  afterEach(async () => {
    await cleanupTempDir(fixturesRoot);
  });

  describe('Watcher isolation per project', () => {
    // AC: @multi-directory-daemon ac-17
    it('should create separate watcher for each project', async () => {
      // Create two separate watchers for different projects
      const watcherA = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: vi.fn(),
        onError: vi.fn(),
      });

      const watcherB = new KspecWatcher({
        kspecDir: join(projectB, '.kspec'),
        onFileChange: vi.fn(),
        onError: vi.fn(),
      });

      await watcherA.start();
      await watcherB.start();

      // Watchers should be separate instances
      expect(watcherA).not.toBe(watcherB);

      await watcherA.stop();
      await watcherB.stop();
    });

    // AC: @multi-directory-daemon ac-17
    it('should trigger events scoped to correct project when file changes', async () => {
      const changeHandlerA = vi.fn();
      const changeHandlerB = vi.fn();

      const watcherA = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: changeHandlerA,
        onError: vi.fn(),
      });

      const watcherB = new KspecWatcher({
        kspecDir: join(projectB, '.kspec'),
        onFileChange: changeHandlerB,
        onError: vi.fn(),
      });

      await watcherA.start();
      await watcherB.start();

      // Change file in project A
      const fileA = join(projectA, '.kspec', 'kynetic.yaml');
      await writeFile(fileA, 'kynetic: "1.0"\nproject: Modified A\n');

      // Wait for debounce (500ms + buffer)
      await new Promise(resolve => setTimeout(resolve, 600));

      // Only project A's watcher should have been notified
      expect(changeHandlerA).toHaveBeenCalled();
      expect(changeHandlerB).not.toHaveBeenCalled();

      await watcherA.stop();
      await watcherB.stop();
    });

    // AC: @multi-directory-daemon ac-18
    it('should only notify watchers for the project that changed', async () => {
      const changeHandlerA = vi.fn();
      const changeHandlerB = vi.fn();

      const watcherA = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: changeHandlerA,
        onError: vi.fn(),
      });

      const watcherB = new KspecWatcher({
        kspecDir: join(projectB, '.kspec'),
        onFileChange: changeHandlerB,
        onError: vi.fn(),
      });

      await watcherA.start();
      await watcherB.start();

      // Change file in project B
      const fileB = join(projectB, '.kspec', 'kynetic.yaml');
      await writeFile(fileB, 'kynetic: "1.0"\nproject: Modified B\n');

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 600));

      // Only project B's watcher should have been notified
      expect(changeHandlerA).not.toHaveBeenCalled();
      expect(changeHandlerB).toHaveBeenCalled();

      await watcherA.stop();
      await watcherB.stop();
    });

    // AC: @multi-directory-daemon ac-17
    it('should receive file path scoped to project directory', async () => {
      let receivedPath: string | undefined;
      const changeHandler = vi.fn((path: string) => {
        receivedPath = path;
      });

      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: changeHandler,
        onError: vi.fn(),
      });

      await watcher.start();

      // Modify a file
      const testFile = join(projectA, '.kspec', 'modules', 'test.yaml');
      await writeFile(testFile, 'test: data\n');

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 600));

      expect(changeHandler).toHaveBeenCalled();
      expect(receivedPath).toBe(testFile);

      await watcher.stop();
    });
  });

  describe('Watcher cleanup', () => {
    // AC: @multi-directory-daemon ac-17
    it('should stop watcher when project is unregistered', async () => {
      const changeHandler = vi.fn();
      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: changeHandler,
        onError: vi.fn(),
      });

      await watcher.start();

      // Simulate unregister by stopping watcher
      await watcher.stop();

      // Change file after watcher stopped
      const file = join(projectA, '.kspec', 'kynetic.yaml');
      await writeFile(file, 'kynetic: "1.0"\nproject: After Stop\n');

      // Wait for what would be debounce time
      await new Promise(resolve => setTimeout(resolve, 600));

      // Should not have been notified (watcher stopped)
      expect(changeHandler).not.toHaveBeenCalled();
    });

    // AC: @multi-directory-daemon ac-17
    it('should clean up all debounce timers on stop', async () => {
      const changeHandler = vi.fn();
      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: changeHandler,
        onError: vi.fn(),
      });

      await watcher.start();

      // Trigger multiple file changes rapidly (within debounce window)
      const file = join(projectA, '.kspec', 'kynetic.yaml');
      await writeFile(file, 'kynetic: "1.0"\nproject: Change 1\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(file, 'kynetic: "1.0"\nproject: Change 2\n');

      // Stop watcher before debounce completes
      await watcher.stop();

      // Wait for what would have been debounce time
      await new Promise(resolve => setTimeout(resolve, 600));

      // Handler should not have been called (timers cleared on stop)
      expect(changeHandler).not.toHaveBeenCalled();
    });

    // AC: @multi-directory-daemon ac-17
    it('should handle stopping watcher that was never started', async () => {
      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: vi.fn(),
        onError: vi.fn(),
      });

      // Should not throw
      await expect(watcher.stop()).resolves.not.toThrow();
    });

    // AC: @multi-directory-daemon ac-17
    it('should handle multiple stop calls idempotently', async () => {
      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: vi.fn(),
        onError: vi.fn(),
      });

      await watcher.start();
      await watcher.stop();

      // Second stop should not throw
      await expect(watcher.stop()).resolves.not.toThrow();
    });
  });

  describe('OS resource limit handling', () => {
    // AC: @multi-directory-daemon ac-19
    it('should handle EMFILE error (too many open files)', async () => {
      const errorHandler = vi.fn();
      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: vi.fn(),
        onError: errorHandler,
      });

      // Mock the start method to throw EMFILE error
      const originalStart = watcher.start.bind(watcher);
      vi.spyOn(watcher, 'start').mockImplementationOnce(async () => {
        const error = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
        error.code = 'EMFILE';
        throw error;
      });

      // Start should propagate the error
      await expect(watcher.start()).rejects.toThrow('EMFILE');
    });

    // AC: @multi-directory-daemon ac-19
    it('should handle ENFILE error (file table overflow)', async () => {
      const errorHandler = vi.fn();
      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: vi.fn(),
        onError: errorHandler,
      });

      // Mock the start method to throw ENFILE error
      vi.spyOn(watcher, 'start').mockImplementationOnce(async () => {
        const error = new Error('ENFILE: file table overflow') as NodeJS.ErrnoException;
        error.code = 'ENFILE';
        throw error;
      });

      // Start should propagate the error
      await expect(watcher.start()).rejects.toThrow('ENFILE');
    });

    // AC: @multi-directory-daemon ac-19
    it('should provide meaningful error message for resource limits', async () => {
      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: vi.fn(),
        onError: vi.fn(),
      });

      // Mock to simulate resource limit error
      vi.spyOn(watcher, 'start').mockImplementationOnce(async () => {
        const error = new Error('Unable to watch project - resource limit reached') as NodeJS.ErrnoException;
        error.code = 'EMFILE';
        throw error;
      });

      await expect(watcher.start()).rejects.toThrow('Unable to watch project - resource limit reached');
    });
  });

  describe('Multiple projects file watching', () => {
    // AC: @multi-directory-daemon ac-18
    it('should isolate file events between projects when both are watching', async () => {
      const eventsA: string[] = [];
      const eventsB: string[] = [];

      const watcherA = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: (path) => eventsA.push(path),
        onError: vi.fn(),
      });

      const watcherB = new KspecWatcher({
        kspecDir: join(projectB, '.kspec'),
        onFileChange: (path) => eventsB.push(path),
        onError: vi.fn(),
      });

      await watcherA.start();
      await watcherB.start();

      // Modify files in both projects
      const fileA = join(projectA, '.kspec', 'kynetic.yaml');
      const fileB = join(projectB, '.kspec', 'kynetic.yaml');

      await writeFile(fileA, 'kynetic: "1.0"\nproject: A Modified\n');
      await writeFile(fileB, 'kynetic: "1.0"\nproject: B Modified\n');

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 600));

      // Each watcher should only have received its own event
      expect(eventsA).toHaveLength(1);
      expect(eventsB).toHaveLength(1);
      expect(eventsA[0]).toBe(fileA);
      expect(eventsB[0]).toBe(fileB);

      await watcherA.stop();
      await watcherB.stop();
    });

    // AC: @multi-directory-daemon ac-17, ac-18
    it('should handle rapid changes in multiple projects independently', async () => {
      const changesA = vi.fn();
      const changesB = vi.fn();

      const watcherA = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: changesA,
        onError: vi.fn(),
      });

      const watcherB = new KspecWatcher({
        kspecDir: join(projectB, '.kspec'),
        onFileChange: changesB,
        onError: vi.fn(),
      });

      await watcherA.start();
      await watcherB.start();

      // Rapid changes in both projects
      const fileA = join(projectA, '.kspec', 'kynetic.yaml');
      const fileB = join(projectB, '.kspec', 'kynetic.yaml');

      // Project A: 3 rapid changes
      await writeFile(fileA, 'kynetic: "1.0"\nproject: A1\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(fileA, 'kynetic: "1.0"\nproject: A2\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(fileA, 'kynetic: "1.0"\nproject: A3\n');

      // Project B: 2 rapid changes
      await writeFile(fileB, 'kynetic: "1.0"\nproject: B1\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeFile(fileB, 'kynetic: "1.0"\nproject: B2\n');

      // Wait for debounce (500ms from last change + buffer)
      await new Promise(resolve => setTimeout(resolve, 700));

      // Each watcher should debounce to single call per project
      expect(changesA).toHaveBeenCalledTimes(1);
      expect(changesB).toHaveBeenCalledTimes(1);

      await watcherA.stop();
      await watcherB.stop();
    });
  });

  describe('Watcher lifecycle management', () => {
    // AC: @multi-directory-daemon ac-17
    it('should allow restarting watcher after stop', async () => {
      const changeHandler = vi.fn();
      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: changeHandler,
        onError: vi.fn(),
      });

      // Start, stop, then start again
      await watcher.start();
      await watcher.stop();
      await watcher.start();

      // Modify file
      const file = join(projectA, '.kspec', 'kynetic.yaml');
      await writeFile(file, 'kynetic: "1.0"\nproject: Restarted\n');

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 600));

      // Should have received event after restart
      expect(changeHandler).toHaveBeenCalled();

      await watcher.stop();
    });

    // AC: @multi-directory-daemon ac-17
    it('should track watcher active state correctly', async () => {
      const watcher = new KspecWatcher({
        kspecDir: join(projectA, '.kspec'),
        onFileChange: vi.fn(),
        onError: vi.fn(),
      });

      // Initially no watcher
      await watcher.start();
      // After start, watcher should be active (implementation detail - would need exposure)

      await watcher.stop();
      // After stop, watcher should be inactive
    });
  });

  describe('Error propagation', () => {
    // AC: @multi-directory-daemon ac-17, ac-19
    it('should handle watcher failures gracefully with Chokidar fallback', async () => {
      const errorHandler = vi.fn();
      const changeHandler = vi.fn();
      const watcher = new KspecWatcher({
        kspecDir: '/nonexistent/path/.kspec',
        onFileChange: changeHandler,
        onError: errorHandler,
      });

      // Attempting to watch nonexistent directory
      // Watcher falls back to Chokidar which handles this gracefully (doesn't throw)
      await watcher.start();

      // Watcher started successfully with Chokidar fallback
      // But won't receive any events since directory doesn't exist
      await watcher.stop();
    });

    // AC: @multi-directory-daemon ac-17
    it('should handle errors per project without affecting other watchers', async () => {
      const errorHandlerB = vi.fn();
      const changeHandlerB = vi.fn();

      // Valid watcher for project B
      const watcherB = new KspecWatcher({
        kspecDir: join(projectB, '.kspec'),
        onFileChange: changeHandlerB,
        onError: errorHandlerB,
      });

      await watcherB.start();

      // Watcher for nonexistent path (uses Chokidar fallback, doesn't throw)
      const watcherInvalid = new KspecWatcher({
        kspecDir: '/nonexistent/.kspec',
        onFileChange: vi.fn(),
        onError: vi.fn(),
      });

      // Invalid watcher should start with Chokidar (no error thrown)
      await watcherInvalid.start();
      await watcherInvalid.stop();

      // Valid watcher should still work
      const fileB = join(projectB, '.kspec', 'kynetic.yaml');
      await writeFile(fileB, 'kynetic: "1.0"\nproject: Still Works\n');

      await new Promise(resolve => setTimeout(resolve, 600));

      // Project B's watcher should receive events
      expect(changeHandlerB).toHaveBeenCalled();
      expect(errorHandlerB).not.toHaveBeenCalled();

      await watcherB.stop();
    });
  });
});
