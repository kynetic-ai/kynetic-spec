import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const mockState = vi.hoisted(() => ({
  chokidarWatch: vi.fn(),
}));

vi.mock("chokidar", () => ({
  default: {
    watch: mockState.chokidarWatch,
  },
  watch: mockState.chokidarWatch,
}));

class MockChokidarWatcher extends EventEmitter {
  close = vi.fn();

  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

describe("KspecWatcher error handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // AC: @daemon-file-monitoring ac-4
  it("retries when the Chokidar watcher emits ENOENT for a deleted watched root", async () => {
    const chokidarWatcher = new MockChokidarWatcher();
    const recoveredWatcher = new MockChokidarWatcher();
    const errorHandler = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    mockState.chokidarWatch
      .mockImplementationOnce(() => {
        queueMicrotask(() => chokidarWatcher.emit("ready"));
        return chokidarWatcher;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => recoveredWatcher.emit("ready"));
        return recoveredWatcher;
      });

    const { KspecWatcher } = await import("../packages/daemon/src/watcher");
    const watcher = new KspecWatcher({
      kspecDir: "/tmp/kspec-missing/.kspec",
      onFileChange: vi.fn(),
      onError: errorHandler,
    });

    await watcher.start();

    chokidarWatcher.emit(
      "error",
      Object.assign(new Error("ENOENT: watch /tmp/kspec-missing/.kspec"), { code: "ENOENT" }),
    );
    await vi.waitFor(() => {
      expect(errorHandler).toHaveBeenCalledTimes(1);
    });

    expect(chokidarWatcher.close).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

    await vi.advanceTimersByTimeAsync(1000);

    expect(chokidarWatcher.close).toHaveBeenCalledTimes(1);
    expect(mockState.chokidarWatch).toHaveBeenCalledTimes(2);

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-8
  // AC: @multi-directory-daemon ac-34
  it("invokes permanent failure callback after ENOENT exhausts retries and the watched root is gone", async () => {
    const errorHandler = vi.fn();
    const permanentFailureHandler = vi.fn();
    const chokidarWatcher = new MockChokidarWatcher();

    mockState.chokidarWatch.mockImplementation(() => {
      queueMicrotask(() => chokidarWatcher.emit("ready"));
      return chokidarWatcher;
    });

    const { KspecWatcher } = await import("../packages/daemon/src/watcher");
    const watcher = new KspecWatcher({
      kspecDir: "/tmp/kspec-missing/.kspec",
      onFileChange: vi.fn(),
      onError: errorHandler,
      onPermanentFailure: permanentFailureHandler,
    });

    await watcher.start();

    for (let attempt = 0; attempt < 6; attempt++) {
      chokidarWatcher.emit(
        "error",
        Object.assign(new Error("ENOENT: watch /tmp/kspec-missing/.kspec"), { code: "ENOENT" }),
      );
      await vi.runOnlyPendingTimersAsync();
    }

    await vi.waitFor(() => {
      expect(permanentFailureHandler).toHaveBeenCalledWith("/tmp/kspec-missing/.kspec");
    });

    expect(errorHandler).toHaveBeenCalledTimes(6);
    expect(chokidarWatcher.close).toHaveBeenCalled();
  });
});
