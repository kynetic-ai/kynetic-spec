/**
 * Tests for daemon file watcher
 * Spec: @daemon-server ac-4, ac-5, ac-6, ac-7, ac-8
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir } from './helpers/cli';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { readFile } from 'fs/promises';

describe('Daemon File Watcher', () => {
  let tempDir: string;
  let kspecDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    kspecDir = join(tempDir, '.kspec');
    await mkdir(kspecDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-server ac-4
  it('should have KspecWatcher class with watch functionality', async () => {
    const watcherContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/watcher.ts'),
      'utf-8'
    );

    expect(watcherContent).toContain('export class KspecWatcher');
    expect(watcherContent).toContain('onFileChange');
    expect(watcherContent).toContain('async start()');
  });

  // AC: @daemon-server ac-4
  it('should integrate watcher into server with file change broadcasting', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain('KspecWatcher');
    expect(serverContent).toContain('watcher.start()');
    expect(serverContent).toContain('onFileChange');
    expect(serverContent).toContain('ws.send');
  });

  // AC: @daemon-server ac-5
  it('should implement 500ms debouncing for file changes', async () => {
    const watcherContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/watcher.ts'),
      'utf-8'
    );

    expect(watcherContent).toContain('debounceMs = 500');
    expect(watcherContent).toContain('setTimeout');
    expect(watcherContent).toContain('debounceTimers');
  });

  // AC: @daemon-server ac-6
  it('should validate YAML and handle parse errors', async () => {
    const watcherContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/watcher.ts'),
      'utf-8'
    );

    expect(watcherContent).toContain("import { parse as parseYaml } from 'yaml'");
    expect(watcherContent).toContain('parseYaml(content)');
    expect(watcherContent).toContain('catch (parseError)');
    expect(watcherContent).toContain('onError');
  });

  // AC: @daemon-server ac-6
  it('should broadcast error events on YAML parse errors', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain('onError: (error, file)');
    expect(serverContent).toContain("type: 'error'");
    expect(serverContent).toContain('ws.send(JSON.stringify(event))');
  });

  // AC: @daemon-server ac-7
  it('should implement exponential backoff for recovery', async () => {
    const watcherContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/watcher.ts'),
      'utf-8'
    );

    expect(watcherContent).toContain('retryCount');
    expect(watcherContent).toContain('maxRetries');
    expect(watcherContent).toContain('baseBackoffMs');
    expect(watcherContent).toContain('Math.pow(2, this.retryCount');
    expect(watcherContent).toContain('handleWatcherError');
  });

  // AC: @daemon-server ac-8
  it('should implement Bun fs.watch with Chokidar fallback', async () => {
    const watcherContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/watcher.ts'),
      'utf-8'
    );

    expect(watcherContent).toContain("import { watch");
    expect(watcherContent).toContain("import chokidar");
    expect(watcherContent).toContain('startBunWatcher');
    expect(watcherContent).toContain('startChokidarWatcher');
    expect(watcherContent).toContain('falling back to Chokidar');
  });

  // AC: @daemon-server ac-8
  it('should have Chokidar and YAML dependencies', async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), 'packages/daemon/package.json'), 'utf-8')
    );

    expect(packageJson.dependencies).toHaveProperty('chokidar');
    expect(packageJson.dependencies).toHaveProperty('yaml');
  });

  it('should track WebSocket connections', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain('wsConnections');
    expect(serverContent).toContain('wsConnections.add(ws)');
    expect(serverContent).toContain('wsConnections.delete(ws)');
    expect(serverContent).toContain('connections: wsConnections.size');
  });

  it('should close WebSocket connections on shutdown', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain('watcher.stop()');
    expect(serverContent).toContain('ws.close');
    expect(serverContent).toContain('wsConnections.clear()');
  });

  it('should watch .kspec directory recursively', async () => {
    const watcherContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/watcher.ts'),
      'utf-8'
    );

    expect(watcherContent).toContain('recursive: true');
    expect(watcherContent).toContain("'*.yaml'");
    expect(watcherContent).toContain('kspecDir');
  });
});
