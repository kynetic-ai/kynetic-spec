import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetaContext } from "../../src/parser/meta.js";
import {
  cleanupTempDir,
  createTempDir,
  setupShadowDetection,
  testUlid,
} from "../helpers/cli.js";
import {
  getEntityCacheContext,
  initContext,
  loadAllItems,
  loadInboxItems,
  loadTriageRecords,
  runWithEntityCache,
} from "../../src/parser/yaml.js";
import { createPlan, loadPlans, savePlan } from "../../src/parser/plans.js";
import {
  createReviewRecord,
  loadReviewRecords,
  saveReviewRecord,
} from "../../src/parser/reviews.js";
import { testUlid } from "../helpers/cli.js";

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

describe("cache-backed inbox and triage loaders", () => {
  // AC: @daemon-command-api ac-read-cache-serving
  it("returns cached inbox items when the inbox domain is ready", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const cachedInboxUlid = testUlid("NBXA");
    const cachedInboxItems = [
      {
        _ulid: cachedInboxUlid,
        text: "Cached inbox item",
        created_at: "2026-04-07T00:00:00.000Z",
        tags: ["cache"],
        added_by: "cache-test",
        _sourceFile: path.join(tempDir, ".kspec", "project.inbox.yaml"),
      },
    ];
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "inbox" ? "ready" : "unloaded")),
      getInboxIndex: vi.fn(() => cachedInboxItems),
    };

    const items = await runWithEntityCache(() => loadInboxItems(ctx), () => cache, tempDir);

    expect(items).toEqual(cachedInboxItems);
    expect(cache.getDomainState).toHaveBeenCalledWith("inbox");
    expect(cache.getInboxIndex).toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk for inbox items when the inbox domain is not ready", async () => {
    const tempDir = await setupShadowProject();
    const diskInboxUlid = testUlid("NBXD");
    await fs.writeFile(
      path.join(tempDir, ".kspec", "project.inbox.yaml"),
      `inbox:
  - _ulid: "${diskInboxUlid}"
    text: "Disk inbox item"
    created_at: "2026-04-07T00:00:00.000Z"
    tags: []
    added_by: "disk-test"
`,
      "utf-8",
    );
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "inbox" ? "loading" : "unloaded")),
      getInboxIndex: vi.fn(() => {
        throw new Error("inbox cache should not be read before the domain is ready");
      }),
    };

    const items = await runWithEntityCache(() => loadInboxItems(ctx), () => cache, tempDir);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      _ulid: diskInboxUlid,
      text: "Disk inbox item",
      added_by: "disk-test",
    });
    expect(cache.getInboxIndex).not.toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("returns cached triage records from the ready index using inbox cache snapshots", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const cachedInboxUlid = testUlid("NBXC");
    const cachedTriageUlid = testUlid("TRCA");
    const cache = {
      getDomainState: vi.fn((domain: string) =>
        domain === "triage" || domain === "inbox" ? "ready" : "unloaded",
      ),
      getInboxIndex: vi.fn(() => [
        {
          _ulid: cachedInboxUlid,
          text: "Cached inbox item",
          created_at: "2026-04-07T00:00:00.000Z",
          tags: ["cache"],
          added_by: "cache-test",
          _sourceFile: path.join(tempDir, ".kspec", "project.inbox.yaml"),
        },
      ]),
      getTriageIndex: vi.fn(() => [
        {
          _ulid: cachedTriageUlid,
          inbox_ref: cachedInboxUlid,
          status: "triaged",
          created_at: "2026-04-07T00:00:00.000Z",
          action: "promote",
          reasoning: "Use cached triage summary",
          decided_by: "cache-test",
          evidence_refs: [],
        },
      ]),
      getTriageDetail: vi.fn(() => null),
    };

    const records = await runWithEntityCache(() => loadTriageRecords(ctx), () => cache, tempDir);

    expect(records).toEqual([
      {
        _ulid: cachedTriageUlid,
        inbox_ref: cachedInboxUlid,
        item_snapshot: "Cached inbox item",
        status: "triaged",
        created_at: "2026-04-07T00:00:00.000Z",
        action: "promote",
        reasoning: "Use cached triage summary",
        decided_by: "cache-test",
        evidence_refs: [],
        _sourceFile: path.join(tempDir, ".kspec", "project.triage.yaml"),
      },
    ]);
    expect(cache.getDomainState).toHaveBeenCalledWith("triage");
    expect(cache.getDomainState).toHaveBeenCalledWith("inbox");
    expect(cache.getInboxIndex).toHaveBeenCalled();
    expect(cache.getTriageIndex).toHaveBeenCalled();
    expect(cache.getTriageDetail).toHaveBeenCalledWith(cachedTriageUlid);
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk for triage records when inbox cache is unavailable", async () => {
    const tempDir = await setupShadowProject();
    const diskInboxUlid = testUlid("NBXE");
    const diskTriageUlid = testUlid("TRDB");
    await fs.writeFile(
      path.join(tempDir, ".kspec", "project.triage.yaml"),
      `kynetic_triage: "1.0"
triage:
  - _ulid: "${diskTriageUlid}"
    inbox_ref: "${diskInboxUlid}"
    item_snapshot: "Disk triage item"
    status: "triaged"
    created_at: "2026-04-07T00:00:00.000Z"
    action: "defer"
    reasoning: "Disk fallback"
    decided_by: "disk-test"
    evidence_refs: []
`,
      "utf-8",
    );
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const cache = {
      getDomainState: vi.fn((domain: string) =>
        domain === "triage" ? "ready" : domain === "inbox" ? "loading" : "unloaded",
      ),
      getInboxIndex: vi.fn(() => {
        throw new Error("inbox cache should not be read before the domain is ready");
      }),
      getTriageIndex: vi.fn(() => [
        {
          _ulid: diskTriageUlid,
          inbox_ref: diskInboxUlid,
          status: "triaged",
          created_at: "2026-04-07T00:00:00.000Z",
          action: "defer",
          reasoning: "Disk fallback",
          decided_by: "disk-test",
          evidence_refs: [],
        },
      ]),
      getTriageDetail: vi.fn(() => null),
    };

    const records = await runWithEntityCache(() => loadTriageRecords(ctx), () => cache, tempDir);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      _ulid: diskTriageUlid,
      inbox_ref: diskInboxUlid,
      action: "defer",
      decided_by: "disk-test",
    });
    expect(cache.getTriageIndex).toHaveBeenCalled();
    expect(cache.getTriageDetail).toHaveBeenCalledWith(diskTriageUlid);
    expect(cache.getInboxIndex).not.toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-no-cache-outside-daemon
  it("loads inbox and triage data from disk when no cache context exists", async () => {
    const tempDir = await setupShadowProject();
    const directInboxUlid = testUlid("NBXF");
    const directTriageUlid = testUlid("TRDC");
    await fs.writeFile(
      path.join(tempDir, ".kspec", "project.inbox.yaml"),
      `inbox:
  - _ulid: "${directInboxUlid}"
    text: "Direct inbox item"
    created_at: "2026-04-07T00:00:00.000Z"
    tags: []
    added_by: "direct-test"
`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(tempDir, ".kspec", "project.triage.yaml"),
      `kynetic_triage: "1.0"
triage:
  - _ulid: "${directTriageUlid}"
    inbox_ref: "${directInboxUlid}"
    item_snapshot: "Direct triage item"
    status: "triaged"
    created_at: "2026-04-07T00:00:00.000Z"
    action: "duplicate"
    reasoning: "Direct mode disk read"
    decided_by: "direct-test"
    evidence_refs: []
`,
      "utf-8",
    );
    const ctx = await initContext(tempDir, { syncMode: "skip" });

    const inboxItems = await loadInboxItems(ctx);
    const triageRecords = await loadTriageRecords(ctx);

    expect(inboxItems).toHaveLength(1);
    expect(inboxItems[0]).toMatchObject({
      _ulid: directInboxUlid,
      text: "Direct inbox item",
    });
    expect(triageRecords).toHaveLength(1);
    expect(triageRecords[0]).toMatchObject({
      _ulid: directTriageUlid,
      action: "duplicate",
    });
  });
});

describe("loadPlans with entity cache context", () => {
  // AC: @daemon-command-api ac-read-cache-serving
  it("returns cached plan details when the plans domain is ready and details are populated", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const plan = createPlan({
      _ulid: testUlid("PLN"),
      title: "Disk Plan",
      content: "disk content",
      slugs: ["disk-plan"],
    });
    await savePlan(ctx, plan);

    const cachedPlans = [
      {
        ...(await loadPlans(ctx))[0],
        title: "Cached Plan",
      },
    ];
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "plans" ? "ready" : "unloaded")),
      getPlansIndex: vi.fn(() => cachedPlans.map(({ _ulid }) => ({ _ulid }))),
      getPlanDetail: vi.fn((ulid: string) => cachedPlans.find((plan) => plan._ulid === ulid) ?? null),
    };

    const plans = await runWithEntityCache(() => loadPlans(ctx), () => cache, tempDir);

    expect(plans).toEqual(cachedPlans);
    expect(cache.getDomainState).toHaveBeenCalledWith("plans");
    expect(cache.getPlansIndex).toHaveBeenCalled();
    expect(cache.getPlanDetail).toHaveBeenCalledWith(cachedPlans[0]._ulid);
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk loading when the plans detail tier is empty", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const plan = createPlan({
      _ulid: testUlid("PLN"),
      title: "Disk Plan",
      content: "disk content",
      slugs: ["disk-plan"],
    });
    await savePlan(ctx, plan);
    const expectedPlans = await loadPlans(ctx);
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "plans" ? "ready" : "unloaded")),
      getPlansIndex: vi.fn(() => expectedPlans.map(({ _ulid }) => ({ _ulid }))),
      getPlanDetail: vi.fn(() => null),
    };

    const plans = await runWithEntityCache(() => loadPlans(ctx), () => cache, tempDir);

    expect(plans).toEqual(expectedPlans);
    expect(cache.getPlansIndex).toHaveBeenCalled();
    expect(cache.getPlanDetail).toHaveBeenCalledWith(expectedPlans[0]._ulid);
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk loading when the plans detail tier is only partially populated", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const plansToSave = [
      createPlan({
        _ulid: testUlid("PLA", 1),
        title: "Disk Plan One",
        content: "disk content one",
        slugs: ["disk-plan-one"],
      }),
      createPlan({
        _ulid: testUlid("PLA", 2),
        title: "Disk Plan Two",
        content: "disk content two",
        slugs: ["disk-plan-two"],
      }),
    ];
    for (const plan of plansToSave) {
      await savePlan(ctx, plan);
    }
    const expectedPlans = await loadPlans(ctx);
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "plans" ? "ready" : "unloaded")),
      getPlansIndex: vi.fn(() => expectedPlans.map(({ _ulid }) => ({ _ulid }))),
      getPlanDetail: vi.fn((ulid: string) =>
        ulid === expectedPlans[0]?._ulid ? expectedPlans[0] : null,
      ),
    };

    const plans = await runWithEntityCache(() => loadPlans(ctx), () => cache, tempDir);

    expect(plans).toEqual(expectedPlans);
    expect(cache.getPlansIndex).toHaveBeenCalled();
    expect(cache.getPlanDetail).toHaveBeenCalledTimes(expectedPlans.length);
    expect(cache.getPlanDetail).toHaveBeenCalledWith(expectedPlans[0]._ulid);
    expect(cache.getPlanDetail).toHaveBeenCalledWith(expectedPlans[1]._ulid);
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk loading when the plans index tier is unavailable", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const plan = createPlan({
      _ulid: testUlid("PLN"),
      title: "Disk Plan",
      content: "disk content",
      slugs: ["disk-plan"],
    });
    await savePlan(ctx, plan);
    const expectedPlans = await loadPlans(ctx);
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "plans" ? "ready" : "unloaded")),
      getPlansIndex: vi.fn(() => null),
      getPlanDetail: vi.fn(),
    };

    const plans = await runWithEntityCache(() => loadPlans(ctx), () => cache, tempDir);

    expect(plans).toEqual(expectedPlans);
    expect(cache.getPlansIndex).toHaveBeenCalled();
    expect(cache.getPlanDetail).not.toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk loading when the plans domain is not ready", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    const plan = createPlan({
      _ulid: testUlid("PLN"),
      title: "Disk Plan",
      content: "disk content",
      slugs: ["disk-plan"],
    });
    await savePlan(ctx, plan);
    const expectedPlans = await loadPlans(ctx);
    const cache = {
      getDomainState: vi.fn(() => "loading"),
      getPlansIndex: vi.fn(() => {
        throw new Error("plan index should not be read before the plans domain is ready");
      }),
      getPlanDetail: vi.fn(),
    };

    const plans = await runWithEntityCache(() => loadPlans(ctx), () => cache, tempDir);

    expect(plans).toEqual(expectedPlans);
    expect(cache.getDomainState).toHaveBeenCalledWith("plans");
    expect(cache.getPlansIndex).not.toHaveBeenCalled();
    expect(cache.getPlanDetail).not.toHaveBeenCalled();
  });
});

describe("loadReviewRecords with entity cache context", () => {
  function makeReviewInput() {
    return {
      _ulid: testUlid("REV"),
      title: "Disk Review",
      author: "tester",
      subject: {
        type: "code" as const,
        base_commit: "abc123",
        head_commit: "def456",
      },
    };
  }

  // AC: @daemon-command-api ac-read-cache-serving
  it("returns cached review details when the reviews domain is ready and details are populated", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    await saveReviewRecord(ctx, createReviewRecord(makeReviewInput()));

    const cachedReviews = [
      {
        ...(await loadReviewRecords(ctx))[0],
        title: "Cached Review",
      },
    ];
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "reviews" ? "ready" : "unloaded")),
      getReviewsIndex: vi.fn(() => cachedReviews.map(({ _ulid }) => ({ _ulid }))),
      getReviewDetail: vi.fn(
        (ulid: string) => cachedReviews.find((review) => review._ulid === ulid) ?? null,
      ),
    };

    const reviews = await runWithEntityCache(() => loadReviewRecords(ctx), () => cache, tempDir);

    expect(reviews).toEqual(cachedReviews);
    expect(cache.getDomainState).toHaveBeenCalledWith("reviews");
    expect(cache.getReviewsIndex).toHaveBeenCalled();
    expect(cache.getReviewDetail).toHaveBeenCalledWith(cachedReviews[0]._ulid);
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk loading when the reviews detail tier is empty", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    await saveReviewRecord(ctx, createReviewRecord(makeReviewInput()));
    const expectedReviews = await loadReviewRecords(ctx);
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "reviews" ? "ready" : "unloaded")),
      getReviewsIndex: vi.fn(() => expectedReviews.map(({ _ulid }) => ({ _ulid }))),
      getReviewDetail: vi.fn(() => null),
    };

    const reviews = await runWithEntityCache(() => loadReviewRecords(ctx), () => cache, tempDir);

    expect(reviews).toEqual(expectedReviews);
    expect(cache.getReviewsIndex).toHaveBeenCalled();
    expect(cache.getReviewDetail).toHaveBeenCalledWith(expectedReviews[0]._ulid);
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk loading when the reviews detail tier is only partially populated", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    await saveReviewRecord(
      ctx,
      createReviewRecord({
        ...makeReviewInput(),
        _ulid: testUlid("REW", 1),
        slugs: ["disk-review-one"],
      }),
    );
    await saveReviewRecord(
      ctx,
      createReviewRecord({
        ...makeReviewInput(),
        _ulid: testUlid("REW", 2),
        slugs: ["disk-review-two"],
      }),
    );
    const expectedReviews = await loadReviewRecords(ctx);
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "reviews" ? "ready" : "unloaded")),
      getReviewsIndex: vi.fn(() => expectedReviews.map(({ _ulid }) => ({ _ulid }))),
      getReviewDetail: vi.fn((ulid: string) =>
        ulid === expectedReviews[0]?._ulid ? expectedReviews[0] : null,
      ),
    };

    const reviews = await runWithEntityCache(() => loadReviewRecords(ctx), () => cache, tempDir);

    expect(reviews).toEqual(expectedReviews);
    expect(cache.getReviewsIndex).toHaveBeenCalled();
    expect(cache.getReviewDetail).toHaveBeenCalledTimes(expectedReviews.length);
    expect(cache.getReviewDetail).toHaveBeenCalledWith(expectedReviews[0]._ulid);
    expect(cache.getReviewDetail).toHaveBeenCalledWith(expectedReviews[1]._ulid);
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk loading when the reviews index tier is unavailable", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    await saveReviewRecord(ctx, createReviewRecord(makeReviewInput()));
    const expectedReviews = await loadReviewRecords(ctx);
    const cache = {
      getDomainState: vi.fn((domain: string) => (domain === "reviews" ? "ready" : "unloaded")),
      getReviewsIndex: vi.fn(() => null),
      getReviewDetail: vi.fn(),
    };

    const reviews = await runWithEntityCache(() => loadReviewRecords(ctx), () => cache, tempDir);

    expect(reviews).toEqual(expectedReviews);
    expect(cache.getReviewsIndex).toHaveBeenCalled();
    expect(cache.getReviewDetail).not.toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-read-cache-serving
  it("falls through to disk loading when the reviews domain is not ready", async () => {
    const tempDir = await setupShadowProject();
    const ctx = await initContext(tempDir, { syncMode: "skip" });
    await saveReviewRecord(ctx, createReviewRecord(makeReviewInput()));
    const expectedReviews = await loadReviewRecords(ctx);
    const cache = {
      getDomainState: vi.fn(() => "loading"),
      getReviewsIndex: vi.fn(() => {
        throw new Error("review index should not be read before the reviews domain is ready");
      }),
      getReviewDetail: vi.fn(),
    };

    const reviews = await runWithEntityCache(() => loadReviewRecords(ctx), () => cache, tempDir);

    expect(reviews).toEqual(expectedReviews);
    expect(cache.getDomainState).toHaveBeenCalledWith("reviews");
    expect(cache.getReviewsIndex).not.toHaveBeenCalled();
    expect(cache.getReviewDetail).not.toHaveBeenCalled();
  });
});
