import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rename, symlink, writeFile } from "fs/promises";
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

describe("KspecWatcher Chokidar-only monitoring", () => {
  let tempDir: string;
  let kspecDir: string;
  let rootYamlPath: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    tempDir = await createTempDir("kspec-daemon-watcher-chokidar-");
    kspecDir = join(tempDir, ".kspec");
    rootYamlPath = join(kspecDir, "kynetic.yaml");

    await mkdir(kspecDir, { recursive: true });
    await writeFile(rootYamlPath, 'kynetic: "1.0"\nproject: Chokidar Delivery\n');
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
        expect.stringContaining("project: Chokidar Delivery"),
      );
    });
    expect(errorHandler).not.toHaveBeenCalled();

    await watcher.stop();
  });

  // AC: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation
  it("delivers non-YAML files inside folder-backed plan/review directories without parsing them as YAML", async () => {
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

    const planUlid = "01PNXA00000000000000000000";
    const reviewUlid = "01REVA00000000000000000000";
    const planMdPath = join(kspecDir, "plans", planUlid, "plan.md");
    const planResourcePath = join(kspecDir, "plans", planUlid, "resources", "ux.png");
    const reviewScreenshotPath = join(
      kspecDir,
      "reviews",
      reviewUlid,
      "resources",
      "screenshot.png",
    );

    // Create the directories and files so processFileChange's lstat()
    // succeeds against real files.
    await mkdir(join(kspecDir, "plans", planUlid, "resources"), { recursive: true });
    await mkdir(join(kspecDir, "reviews", reviewUlid, "resources"), { recursive: true });
    await writeFile(planMdPath, "# Plan body — not YAML\n");
    // Binary-ish content that would fail YAML parsing if mis-handled.
    await writeFile(planResourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeFile(reviewScreenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    mockState.latestWatcher?.emitChange(planMdPath);
    mockState.latestWatcher?.emitChange(planResourcePath);
    mockState.latestWatcher?.emitChange(reviewScreenshotPath);

    await vi.waitFor(() => {
      expect(changeHandler).toHaveBeenCalledWith(planMdPath, "");
      expect(changeHandler).toHaveBeenCalledWith(planResourcePath, "");
      expect(changeHandler).toHaveBeenCalledWith(reviewScreenshotPath, "");
    });
    expect(errorHandler).not.toHaveBeenCalled();

    await watcher.stop();
  });

  // AC: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation
  it("does NOT deliver non-YAML files outside folder-backed entity directories", async () => {
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

    // Random .md and .png anywhere else under .kspec/ are NOT folder-backed
    // entity children and must remain ignored by the watcher.
    const strayMd = join(kspecDir, "notes.md");
    const strayPng = join(kspecDir, "modules", "diagram.png");
    // Look-alike sibling dirs and non-ULID segments must also stay ignored.
    const planArchiveStray = join(kspecDir, "plans-archive", "old", "doc.md");
    const planMissingUlidStray = join(kspecDir, "plans", "not-a-ulid", "plan.md");

    mockState.latestWatcher?.emitChange(strayMd);
    mockState.latestWatcher?.emitChange(strayPng);
    mockState.latestWatcher?.emitChange(planArchiveStray);
    mockState.latestWatcher?.emitChange(planMissingUlidStray);

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(changeHandler).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();

    await watcher.stop();
  });

  const itWithRealWatcher = process.env.CI ? it.skip : it;

  // AC: @daemon-file-monitoring ac-5
  itWithRealWatcher(
    "detects atomic rename writes as a change to the destination YAML path",
    async () => {
      vi.resetModules();
      vi.doUnmock("chokidar");

      const { KspecWatcher } = await import("../packages/daemon/src/watcher");

      const changeHandler = vi.fn();
      const watcher = new KspecWatcher({
        kspecDir,
        onFileChange: changeHandler,
        onError: vi.fn(),
      });

      await watcher.start();

      const targetPath = join(kspecDir, "project.tasks.yaml");
      const tempPath = join(kspecDir, "project.tasks.yaml.tmp");
      await writeFile(targetPath, "tasks: []\n");

      await writeFile(tempPath, "tasks:\n  - title: atomic rename\n");
      await rename(tempPath, targetPath);

      await vi.waitFor(
        () => {
          // oxlint-disable-next-line jest/no-standalone-expect -- vi.waitFor is a valid test context
          expect(changeHandler).toHaveBeenCalledWith(
            targetPath,
            expect.stringContaining("atomic rename"),
          );
        },
        { timeout: 3000 },
      );

      await watcher.stop();
    },
  );
});
