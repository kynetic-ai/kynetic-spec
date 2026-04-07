import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetaContext } from "../../src/parser/meta.js";
import {
  cleanupTempDir,
  createTempDir,
  setupShadowDetection,
} from "../helpers/cli.js";
import {
  getEntityCacheContext,
  initContext,
  loadAllItems,
  runWithEntityCache,
} from "../../src/parser/yaml.js";

const cleanupDirs: string[] = [];

async function setupShadowProject(): Promise<string> {
  const tempDir = await createTempDir("entity-cache-context-");
  cleanupDirs.push(tempDir);

  await fs.mkdir(path.join(tempDir, ".kspec", "modules"), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, ".kspec", "kynetic.yaml"),
    `kynetic: "1.1"
project:
  name: Entity Cache Context Test
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(tempDir, ".kspec", "modules", "test.yaml"),
    `_ulid: 01KFCVXQAABBCCDDEEFFGGHHXX
slugs:
  - cache-test-module
title: Cache Test Module
type: module
description: Module for entity cache loader tests
features:
  - _ulid: 01KF1645CBDJYHWBPYWRN3HYPJ
    slugs:
      - cache-test-feature
    title: Cache Test Feature
    type: feature
    description: Feature for entity cache loader tests
    acceptance_criteria:
      - id: ac-1
        given: test fixture exists
        when: loadAllItems runs
        then: the feature is returned
`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(tempDir, "kspec.config.yaml"),
    `shadow:
  branch: kspec-meta
  directory: .kspec
  sync_interval: 0
daemon:
  port: 4567
  auto_start: false
`,
    "utf-8",
  );

  await setupShadowDetection(tempDir);
  return tempDir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await cleanupTempDir(dir);
    }
  }
});

describe("entity cache async context", () => {
  // AC: @daemon-command-api ac-cache-context-propagation
  it("preserves entity cache context across async boundaries", async () => {
    const cacheAccessor = vi.fn(() => null);
    let contextBeforeAwait = getEntityCacheContext();
    let contextAfterAwait = getEntityCacheContext();

    await runWithEntityCache(
      async () => {
        contextBeforeAwait = getEntityCacheContext();
        await Promise.resolve();
        contextAfterAwait = getEntityCacheContext();
      },
      cacheAccessor,
      "/tmp/kspec-project",
    );

    expect(contextBeforeAwait).toEqual({
      cacheAccessor,
      projectPath: "/tmp/kspec-project",
    });
    expect(contextAfterAwait).toEqual({
      cacheAccessor,
      projectPath: "/tmp/kspec-project",
    });
  });

  // AC: @daemon-command-api ac-no-cache-outside-daemon
  it("returns undefined outside a cache-backed daemon execution context", () => {
    expect(getEntityCacheContext()).toBeUndefined();
  });
});

describe("initContext with entity cache context", () => {
  // AC: @daemon-command-api ac-read-cache-serving
  it("returns cached project context when meta domain is ready", async () => {
    const tempDir = await setupShadowProject();
    const diskCtx = await initContext(tempDir, { syncMode: "skip" });
    const metaDetail: MetaContext = {
      manifest: null,
      manifestPath: null,
      agents: [],
      workflows: [],
      conventions: [],
      observations: [],
      skills: [],
      hooks: [],
      schedules: [],
      compositions: [],
    };
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "meta" ? "ready" : "unloaded")),
      getProjectConfig: vi.fn(() => ({
        project: diskCtx.manifest?.project
          ? {
              name: diskCtx.manifest.project.name,
              version: diskCtx.manifest.project.version,
              status: diskCtx.manifest.project.status,
            }
          : null,
        spec_version: diskCtx.manifest?.kynetic ?? null,
        root_dir: diskCtx.projectRoot,
        remote_tracking: diskCtx.config.shadow.remote
          ? {
              value: diskCtx.config.shadow.remote.value,
              type: diskCtx.config.shadow.remote.type,
            }
          : null,
        daemon: {
          port: diskCtx.config.daemon.port,
          host: diskCtx.config.daemon.host,
          auto_start: diskCtx.config.daemon.auto_start,
        },
        manifest_path: diskCtx.manifestPath,
        manifest: diskCtx.manifest,
        config: diskCtx.config,
      })),
      getShadowInfo: vi.fn(() => ({
        enabled: diskCtx.shadow?.enabled ?? false,
        branch_name: diskCtx.shadow?.branchName ?? null,
        worktree_dir: diskCtx.shadow?.worktreeDir ?? null,
        healthy: diskCtx.shadow?.enabled ?? false,
        remote_tracking: false,
      })),
      getMetaDetail: vi.fn(() => metaDetail),
    };

    const configModule = await import("../../src/parser/config.js");
    const shadowModule = await import("../../src/parser/shadow.js");
    vi.spyOn(configModule, "loadProjectConfig").mockRejectedValue(
      new Error("disk config discovery should not run on cache hit"),
    );
    vi.spyOn(shadowModule, "detectShadow").mockRejectedValue(
      new Error("shadow discovery should not run on cache hit"),
    );

    const ctx = await runWithEntityCache(
      () => initContext(tempDir, { syncMode: "skip" }),
      () => cache,
      tempDir,
    );

    expect(ctx).toEqual(diskCtx);
    expect(cache.getDomainState).toHaveBeenCalledWith("meta");
    expect(cache.getProjectConfig).toHaveBeenCalled();
    expect(cache.getShadowInfo).toHaveBeenCalled();
    expect(cache.getMetaDetail).toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk discovery when meta domain is not ready", async () => {
    const tempDir = await setupShadowProject();
    const expectedCtx = await initContext(tempDir, { syncMode: "skip" });
    const configModule = await import("../../src/parser/config.js");
    const loadProjectConfigSpy = vi.spyOn(configModule, "loadProjectConfig");
    const cache = {
      getDomainState: vi.fn(() => "loading"),
      getProjectConfig: vi.fn(() => {
        throw new Error("cache artifacts should not be read before meta is ready");
      }),
      getShadowInfo: vi.fn(),
      getMetaDetail: vi.fn(),
    };

    const ctx = await runWithEntityCache(
      () => initContext(tempDir, { syncMode: "skip" }),
      () => cache,
      tempDir,
    );

    expect(ctx).toEqual(expectedCtx);
    expect(loadProjectConfigSpy).toHaveBeenCalled();
    expect(cache.getProjectConfig).not.toHaveBeenCalled();
    expect(cache.getShadowInfo).not.toHaveBeenCalled();
    expect(cache.getMetaDetail).not.toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-no-cache-outside-daemon
  it("falls through to disk discovery when no cache context exists", async () => {
    const tempDir = await setupShadowProject();
    const expectedCtx = await initContext(tempDir, { syncMode: "skip" });
    const configModule = await import("../../src/parser/config.js");
    const loadProjectConfigSpy = vi.spyOn(configModule, "loadProjectConfig");

    const ctx = await initContext(tempDir, { syncMode: "skip" });

    expect(ctx).toEqual(expectedCtx);
    expect(loadProjectConfigSpy).toHaveBeenCalled();
  });
});

describe("loadAllItems with entity cache context", () => {
  // AC: @daemon-command-api ac-read-cache-serving
  it("returns cached item details when the items domain is ready", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const diskItems = await loadAllItems(ctx);
    expect(diskItems.length).toBeGreaterThan(0);

    const cachedItems = diskItems.map((item, index) =>
      index === 0 ? { ...item, title: `${item.title} (cached)` } : item,
    );
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "items" ? "ready" : "unloaded")),
      getAllItemDetails: vi.fn(() => cachedItems),
    };

    const items = await runWithEntityCache(
      () =>
        loadAllItems({
          ...ctx,
          manifest: null,
          manifestPath: null,
        }),
      () => cache,
      tempDir,
    );

    expect(items).toEqual(cachedItems);
    expect(cache.getDomainState).toHaveBeenCalledWith("items");
    expect(cache.getAllItemDetails).toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk loading when the items domain is not ready", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const expectedItems = await loadAllItems(ctx);
    const cache = {
      getDomainState: vi.fn(() => "loading"),
      getAllItemDetails: vi.fn(() => {
        throw new Error("item details should not be read before the items domain is ready");
      }),
    };

    const items = await runWithEntityCache(
      () => loadAllItems(ctx),
      () => cache,
      tempDir,
    );

    expect(items).toEqual(expectedItems);
    expect(cache.getDomainState).toHaveBeenCalledWith("items");
    expect(cache.getAllItemDetails).not.toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-no-cache-outside-daemon
  it("falls through to disk loading when no cache context exists", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const expectedItems = await loadAllItems(ctx);

    const items = await loadAllItems(ctx);

    expect(items).toEqual(expectedItems);
    expect(items.length).toBeGreaterThan(0);
  });
});
