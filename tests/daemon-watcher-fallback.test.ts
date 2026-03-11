import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { cleanupTempDir, createTempDir } from './helpers/cli';

class MockChokidarWatcher {
  private handlers = new Map<string, (value: unknown) => void>();

  constructor(public options: Record<string, unknown>) {}

  on(event: string, handler: (value: unknown) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  async close(): Promise<void> {}

  emitChange(filePath: string): void {
    const ignored = this.options.ignored;
    const shouldIgnore =
      typeof ignored === 'function'
        ? Boolean(ignored(filePath))
        : ignored instanceof RegExp
          ? ignored.test(filePath)
          : false;

    if (!shouldIgnore) {
      this.handlers.get('change')?.(filePath);
    }
  }
}

const mockState = vi.hoisted(() => ({
  chokidarWatch: vi.fn(),
  fsWatch: vi.fn(),
  latestWatcher: null as MockChokidarWatcher | null,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    watch: mockState.fsWatch,
  };
});

vi.mock('chokidar', () => ({
  default: {
    watch: mockState.chokidarWatch,
  },
}));

describe('KspecWatcher Chokidar fallback', () => {
  let tempDir: string;
  let kspecDir: string;
  let rootYamlPath: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    tempDir = await createTempDir('kspec-daemon-watcher-fallback-');
    kspecDir = join(tempDir, '.kspec');
    rootYamlPath = join(kspecDir, 'kynetic.yaml');

    await mkdir(kspecDir, { recursive: true });
    await writeFile(rootYamlPath, 'kynetic: "1.0"\nproject: Fallback Delivery\n');
    await symlink(kspecDir, join(kspecDir, '.kspec'), 'dir');

    mockState.fsWatch.mockImplementation(() => {
      throw new Error('Bun watcher unavailable');
    });

    mockState.chokidarWatch.mockImplementation((_glob: string, options: Record<string, unknown>) => {
      const watcher = new MockChokidarWatcher(options);
      mockState.latestWatcher = watcher;
      return watcher;
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    mockState.latestWatcher = null;
  });

  // AC: @daemon-server ac-8
  it('ignores nested .kspec loop paths while still delivering fallback YAML changes', async () => {
    const changeHandler = vi.fn();
    const errorHandler = vi.fn();

    const { KspecWatcher } = await import('../packages/daemon/src/watcher');
    const watcher = new KspecWatcher({
      kspecDir,
      onFileChange: changeHandler,
      onError: errorHandler,
    });

    (watcher as unknown as { debounceMs: number }).debounceMs = 0;

    await watcher.start();

    expect(mockState.chokidarWatch).toHaveBeenCalledTimes(1);
    const options = mockState.latestWatcher?.options;
    expect(options?.followSymlinks).toBe(false);

    const loopYamlPath = join(kspecDir, '.kspec', 'kynetic.yaml');
    expect(typeof options?.ignored).toBe('function');
    expect((options?.ignored as (filePath: string) => boolean)(rootYamlPath)).toBe(false);
    expect((options?.ignored as (filePath: string) => boolean)(loopYamlPath)).toBe(true);

    mockState.latestWatcher?.emitChange(loopYamlPath);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(changeHandler).not.toHaveBeenCalled();

    mockState.latestWatcher?.emitChange(rootYamlPath);
    await vi.waitFor(() => {
      expect(changeHandler).toHaveBeenCalledWith(
        rootYamlPath,
        expect.stringContaining('project: Fallback Delivery')
      );
    });
    expect(errorHandler).not.toHaveBeenCalled();

    await watcher.stop();
  });
});
