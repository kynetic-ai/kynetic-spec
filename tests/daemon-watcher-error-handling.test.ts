import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const mockState = vi.hoisted(() => ({
  fsWatch: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    watch: mockState.fsWatch,
  };
});

class MockFsWatcher extends EventEmitter {
  close = vi.fn();
}

describe('KspecWatcher error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // AC: @daemon-server ac-7
  it('retries when Bun fs.watch emits ENOENT for a deleted watched root', async () => {
    const fsWatcher = new MockFsWatcher();
    const recoveredWatcher = new MockFsWatcher();
    const errorHandler = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    mockState.fsWatch
      .mockReturnValueOnce(fsWatcher)
      .mockReturnValueOnce(recoveredWatcher);

    const { KspecWatcher } = await import('../packages/daemon/src/watcher');
    const watcher = new KspecWatcher({
      kspecDir: '/tmp/kspec-missing/.kspec',
      onFileChange: vi.fn(),
      onError: errorHandler,
    });

    await watcher.start();

    fsWatcher.emit('error', Object.assign(new Error('ENOENT: watch /tmp/kspec-missing/.kspec'), { code: 'ENOENT' }));
    await vi.waitFor(() => {
      expect(errorHandler).toHaveBeenCalledTimes(1);
    });

    expect(fsWatcher.close).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(fsWatcher.close).toHaveBeenCalledTimes(1);
    expect(mockState.fsWatch).toHaveBeenCalledTimes(2);

    await watcher.stop();
  });
});
