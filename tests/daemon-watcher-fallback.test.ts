import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { cleanupTempDir, createTempDir } from "./helpers/cli";

class MockChokidarWatcher {
  private handlers = new Map<string, (value: unknown) => void>();

  constructor(public options: Record<string, unknown>) {}

  on(event: string, handler: (value: unknown) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  once(event: string, handler: (value?: unknown) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  async close(): Promise<void> {}

  emitReady(): void {
    this.handlers.get("ready")?.(undefined);
  }

  emitChange(filePath: string): void {
    const ignored = this.options.ignored;
    const shouldIgnore =
      typeof ignored === "function"
        ? Boolean(ignored(filePath))
        : ignored instanceof RegExp
          ? ignored.test(filePath)
          : false;

    if (!shouldIgnore) {
      this.handlers.get("change")?.(filePath);
    }
  }
}

const mockState = vi.hoisted(() => ({
  chokidarWatch: vi.fn(),
  latestWatcher: null as MockChokidarWatcher | null,
}));

vi.mock("chokidar", () => ({
  default: {
    watch: mockState.chokidarWatch,
  },
  watch: mockState.chokidarWatch,
}));

describe("KspecWatcher Chokidar monitoring", () => {
  let tempDir: string;
  let kspecDir: string;
  let rootYamlPath: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    tempDir = await createTempDir("kspec-daemon-watcher-fallback-");
    kspecDir = join(tempDir, ".kspec");
    rootYamlPath = join(kspecDir, "kynetic.yaml");

    await mkdir(kspecDir, { recursive: true });
    await writeFile(rootYamlPath, 'kynetic: "1.0"\nproject: Fallback Delivery\n');
    await symlink(kspecDir, join(kspecDir, ".kspec"), "dir");

    mockState.chokidarWatch.mockImplementation(
      (_glob: string, options: Record<string, unknown>) => {
        const watcher = new MockChokidarWatcher(options);
        mockState.latestWatcher = watcher;
        queueMicrotask(() => watcher.emitReady());
        return watcher;
      },
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    mockState.latestWatcher = null;
  });

  // AC: @daemon-file-monitoring ac-1
  // AC: @daemon-file-monitoring ac-4
  // AC: @daemon-file-monitoring ac-5
  it("starts with Chokidar, ignores nested .kspec loop paths, and delivers YAML changes", async () => {
    const changeHandler = vi.fn();
    const errorHandler = vi.fn();

    const { KspecWatcher } = await import("../packages/daemon/src/watcher");
    const watcher = new KspecWatcher({
      kspecDir,
      onFileChange: changeHandler,
      onError: errorHandler,
    });

    (watcher as unknown as { debounceMs: number }).debounceMs = 0;

    await watcher.start();

    expect(mockState.chokidarWatch).toHaveBeenCalledTimes(1);
    expect(mockState.chokidarWatch).toHaveBeenCalledWith(
      kspecDir,
      expect.objectContaining({
        ignoreInitial: true,
        followSymlinks: false,
      }),
    );
    const options = mockState.latestWatcher?.options;
    expect(options?.followSymlinks).toBe(false);

    const loopYamlPath = join(kspecDir, ".kspec", "kynetic.yaml");
    expect(typeof options?.ignored).toBe("function");
    const ignored = options!.ignored as (filePath: string) => boolean;
    expect(ignored(rootYamlPath)).toBe(false);
    expect(ignored(loopYamlPath)).toBe(true);

    mockState.latestWatcher?.emitChange(loopYamlPath);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(changeHandler).not.toHaveBeenCalled();

    mockState.latestWatcher?.emitChange(rootYamlPath);
    await vi.waitFor(() => {
      expect(changeHandler).toHaveBeenCalledWith(
        rootYamlPath,
        expect.stringContaining("project: Fallback Delivery"),
      );
    });
    expect(errorHandler).not.toHaveBeenCalled();

    await watcher.stop();
  });
});
