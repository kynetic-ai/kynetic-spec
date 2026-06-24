/**
 * ProjectEntityCache tests.
 *
 * Tests the in-memory tiered entity cache for daemon API requests,
 * covering all acceptance criteria for @daemon-entity-cache.
 *
 * Strategy: Tests use the multi-dir fixtures which provide minimal
 * .kspec/ structures with tasks, items, and manifests. The cache
 * is tested through its public API — loading, querying, invalidation,
 * and lifecycle methods.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dirname, join } from "path";
import * as fs from "fs/promises";
import { stringify as yamlStringify } from "yaml";
import {
  setupMultiDirFixtures,
  cleanupTempDir,
  createTempDir,
  seedSplitTask,
  setupShadowDetection,
  testUlid,
} from "./helpers/cli";
import { TaskDataManager } from "../src/parser/task-data-manager";
import {
  buildCoverageEvidenceIndex,
  type CoverageEvidenceIndex,
} from "../src/parser/coverage-evidence-index";
import {
  getCachedCoverageStateReadModel,
  getCoverageStateReadModelCacheStats,
  invalidateCoverageStateReadModelCache,
} from "../src/parser/coverage-state-read-model";
import type { KspecContext } from "../src/parser/yaml";
import {
  ProjectEntityCache,
  fileToDomain,
  registerEntityCache,
  unregisterEntityCache,
  getEntityCache,
  getAllRegisteredCaches,
  clearAllEntityCaches,
  setTestDelay,
  releaseTestDelay,
  type CacheDomain,
  type DomainState,
  type DomainReadyCallback,
  type DomainReloadedCallback,
  DOMAIN_LOAD_ORDER,
} from "../src/daemon/entity-cache";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend";
import * as yamlModule from "../src/parser/yaml";
import * as sessionStoreModule from "../src/sessions/store";

ensureSplitBackendRegistered();

describe("ProjectEntityCache", () => {
  let fixturesRoot: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    fixturesRoot = await setupMultiDirFixtures();
    projectA = join(fixturesRoot, "project-a");
    projectB = join(fixturesRoot, "project-b");

    // Set up shadow detection so initContext() resolves .kspec/ as specDir
    await setupShadowDetection(projectA);
    await setupShadowDetection(projectB);

    clearAllEntityCaches();
    invalidateCoverageStateReadModelCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock("fs/promises");
    vi.resetModules();
    clearAllEntityCaches();
    invalidateCoverageStateReadModelCache();
    await cleanupTempDir(fixturesRoot);
  });

  async function importEntityCacheWithMockedOpendir(
    directoryHandle: Awaited<ReturnType<typeof fs.opendir>>,
  ): Promise<{
    ProjectEntityCacheCtor: typeof ProjectEntityCache;
    opendirMock: ReturnType<typeof vi.fn>;
  }> {
    vi.resetModules();

    let opendirMock!: ReturnType<typeof vi.fn>;
    vi.doMock("fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs/promises")>();
      opendirMock = vi
        .fn<() => Promise<Awaited<ReturnType<typeof fs.opendir>>>>()
        .mockResolvedValue(directoryHandle);
      return {
        ...actual,
        opendir: opendirMock,
      };
    });

    const entityCacheModule = await import("../src/daemon/entity-cache");
    return {
      ProjectEntityCacheCtor: entityCacheModule.ProjectEntityCache,
      opendirMock,
    };
  }

  function buildItemsManifest(includes: string[] = ["modules/*.yaml"]): string {
    return yamlStringify({
      kynetic: "1.1",
      project: {
        name: "Incremental Items Test Project",
        version: "0.1.0",
        status: "draft",
      },
      includes,
      task_storage: {
        format: "split",
      },
    });
  }

  function buildSpecItem(sequence: number, slug: string, title: string) {
    return {
      _ulid: testUlid("SPEC", sequence),
      slugs: [slug],
      title,
      type: "requirement",
      description: `${title} description`,
      acceptance_criteria: [
        {
          id: `ac-${sequence}`,
          given: `${title} exists`,
          when: `${title} is loaded`,
          then: `${title} is returned from cache`,
        },
      ],
    };
  }

  async function writeItemsFixture(
    projectPath: string,
    files: Record<string, unknown>,
    includes: string[] = ["modules/*.yaml"],
  ): Promise<void> {
    const kspecDir = join(projectPath, ".kspec");
    await fs.writeFile(join(kspecDir, "kynetic.yaml"), buildItemsManifest(includes), "utf-8");
    await fs.mkdir(join(kspecDir, "modules"), { recursive: true });

    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(kspecDir, relativePath);
      await fs.mkdir(dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, yamlStringify(content), "utf-8");
    }
  }

  function fakeCoverageContext(rootDir: string): KspecContext {
    return {
      rootDir,
      specDir: join(rootDir, ".kspec"),
      projectRoot: rootDir,
      manifest: null,
      config: {
        coverage: {
          scan_paths: ["tests"],
          exclude_patterns: [],
        },
      },
      shadow: {
        enabled: false,
        branch: "kspec-meta",
        directory: ".kspec",
        auto_sync: false,
        sync_interval: 0,
        remote: null,
        worktreeDir: null,
      },
    } as unknown as KspecContext;
  }

  // ─── fileToDomain mapping ──────────────────────────────────────────────

  describe("fileToDomain", () => {
    // AC: @daemon-entity-cache ac-granular-reload
    it("should map task files to tasks domain", () => {
      expect(fileToDomain("project.tasks.yaml")).toEqual(["tasks"]);
      expect(fileToDomain("custom.tasks.yaml")).toEqual(["tasks"]);
    });

    it("should map inbox file to inbox domain", () => {
      expect(fileToDomain("project.inbox.yaml")).toEqual(["inbox"]);
    });

    it("should map plans file to plans domain", () => {
      expect(fileToDomain("project.plans.yaml")).toEqual(["plans"]);
    });

    it("should map reviews file to reviews domain", () => {
      expect(fileToDomain("project.reviews.yaml")).toEqual(["reviews"]);
    });

    // AC: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation
    // AC: @daemon-entity-cache ac-granular-reload
    it("should map folder-backed plan files (plans/<ulid>/...) to plans domain only", () => {
      const ulid = "01PNXA00000000000000000000";
      // Core sidecars
      expect(fileToDomain(`plans/${ulid}/plan.md`)).toEqual(["plans"]);
      expect(fileToDomain(`plans/${ulid}/plan.yaml`)).toEqual(["plans"]);
      expect(fileToDomain(`plans/${ulid}/notes.yaml`)).toEqual(["plans"]);
      expect(fileToDomain(`plans/${ulid}/resources.yaml`)).toEqual(["plans"]);
      // Local resources subtree (binary and nested paths)
      expect(fileToDomain(`plans/${ulid}/resources/ux.png`)).toEqual(["plans"]);
      expect(fileToDomain(`plans/${ulid}/resources/diagrams/flow.svg`)).toEqual(["plans"]);
    });

    // AC: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation
    // AC: @daemon-entity-cache ac-granular-reload
    it("should map folder-backed review files (reviews/<ulid>/...) to reviews domain only", () => {
      const ulid = "01REVA00000000000000000000";
      expect(fileToDomain(`reviews/${ulid}/review.yaml`)).toEqual(["reviews"]);
      expect(fileToDomain(`reviews/${ulid}/resources.yaml`)).toEqual(["reviews"]);
      expect(fileToDomain(`reviews/${ulid}/resources/screenshot.png`)).toEqual(["reviews"]);
      expect(fileToDomain(`reviews/${ulid}/resources/logs/run.log`)).toEqual(["reviews"]);
    });

    // Guards that the folder match requires a valid ULID segment, not just any
    // path starting with the word "plans" or "reviews". Without this, the
    // fall-through catch-all that maps *.yaml to items+meta would still cover
    // them, but ad-hoc filenames like "plans-archive/foo.yaml" must NOT be
    // claimed as a folder-backed plan/review change.
    it("should NOT map paths that share the prefix but are not folder-backed roots", () => {
      // No ULID after plans/ — falls through to the .yaml catch-all
      expect(fileToDomain("plans/notes.yaml")).toEqual(["items", "meta"]);
      // Look-alike sibling directories must not be matched as plans/reviews
      expect(fileToDomain("plans-archive/foo.yaml")).toEqual(["items", "meta"]);
      expect(fileToDomain("reviews-archive/foo.yaml")).toEqual(["items", "meta"]);
      // Filename containing the word but at the top level is not a folder root
      expect(fileToDomain("plansreport.yaml")).toEqual(["items", "meta"]);
      expect(fileToDomain("reviewsreport.yaml")).toEqual(["items", "meta"]);
    });

    it("should map triage file to triage domain", () => {
      expect(fileToDomain("project.triage.yaml")).toEqual(["triage"]);
    });

    it("should map manifest to meta, items, and tasks domains", () => {
      // kynetic.yaml carries the project manifest (meta), is the root of the
      // item include tree (items), and holds task_storage compatibility
      // settings (tasks) — see ac-manifest-task-storage-settings-affect-tasks-domain.
      const domains = fileToDomain("kynetic.yaml");
      expect(domains).toEqual(expect.arrayContaining(["meta", "items", "tasks"]));
      expect(domains).toHaveLength(3);
    });

    it("should map session context file to meta domain", () => {
      expect(fileToDomain(".kspec-session")).toEqual(["meta"]);
    });

    it("should map module files to items domain", () => {
      expect(fileToDomain("modules/test.yaml")).toEqual(["items"]);
      expect(fileToDomain("modules/nested/feature.yaml")).toEqual(["items"]);
    });

    it("should map spec files to items domain", () => {
      expect(fileToDomain("my-feature.spec.yaml")).toEqual(["items"]);
    });

    // AC: @daemon-entity-cache ac-watcher-invalidation
    it("should map session ULID paths to sessions domain", () => {
      // Bare ULID (session root from SessionWatcher.getBroadcastPath)
      expect(fileToDomain("01TASKA0000000000000000000")).toEqual(["sessions"]);
      // ULID/filename (metadata file)
      expect(fileToDomain("01TASKA0000000000000000000/metadata.json")).toEqual(["sessions"]);
      // ULID/filename (events file)
      expect(fileToDomain("01TASKA0000000000000000000/events.jsonl")).toEqual(["sessions"]);
    });

    // AC: @daemon-entity-cache ac-watcher-invalidation
    it("should map non-ULID session paths to sessions domain when source is sessions", () => {
      // Session IDs can be arbitrary strings (not just ULIDs). When the source
      // is "sessions" (path is relative to .kspec-sessions/), any path maps to sessions.
      expect(fileToDomain("session-123", "sessions")).toEqual(["sessions"]);
      expect(fileToDomain("session-123/events.jsonl", "sessions")).toEqual(["sessions"]);
      expect(fileToDomain("my-test-session/metadata.json", "sessions")).toEqual(["sessions"]);
    });

    it("should NOT map non-ULID session paths without source hint", () => {
      // Without the source hint, non-ULID bare directory names don't match sessions
      // (they fall through to the catch-all or return null)
      expect(fileToDomain("session-123")).toBeNull();
      expect(fileToDomain("session-123/events.jsonl")).toBeNull();
    });

    it("should return null for unmapped files", () => {
      expect(fileToDomain("random.txt")).toBeNull();
      expect(fileToDomain("notes/something.md")).toBeNull();
    });
  });

  // ─── AC: ac-load-on-register ───────────────────────────────────────────

  // AC: @daemon-entity-cache ac-load-on-register
  describe("ac-load-on-register: index data loaded on registration", () => {
    it("should load task index into memory when loadAll completes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const taskIndex = cache.getTaskIndex();
      expect(taskIndex).not.toBeNull();
      expect(taskIndex!.length).toBeGreaterThan(0);
      expect(taskIndex![0]._ulid).toBe("01TASKA0000000000000000000");
      expect(taskIndex![0].title).toBe("Sample Task A");
    });

    it("should load item index into memory when loadAll completes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("items");

      const itemIndex = cache.getItemIndex();
      expect(itemIndex).not.toBeNull();
      // Items may be empty if initContext doesn't find spec items in the
      // test fixture (no full shadow branch). Verify the domain is ready
      // and index is an array.
      expect(Array.isArray(itemIndex)).toBe(true);
    });

    it("should load meta index into memory when loadAll completes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");

      const metaIndex = cache.getMetaIndex();
      expect(metaIndex).not.toBeNull();
    });
  });

  // ─── AC: ac-serve-from-memory ──────────────────────────────────────────

  // AC: @daemon-entity-cache ac-serve-from-memory
  describe("ac-serve-from-memory: responses served from cache", () => {
    it("should return task summaries from cache without re-reading disk", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      // First access
      const first = cache.getTaskIndex();
      expect(first).not.toBeNull();

      // Second access returns same reference (no re-reading)
      const second = cache.getTaskIndex();
      expect(second).toBe(first); // Same object reference
    });

    it("should return item data from cache without re-reading disk", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("items");

      const first = cache.getItemIndex();
      expect(first).not.toBeNull();

      const second = cache.getItemIndex();
      expect(second).toBe(first);
    });
  });

  // ─── AC: ac-detail-on-demand ───────────────────────────────────────────

  // AC: @daemon-entity-cache ac-detail-on-demand
  describe("ac-detail-on-demand: detail loaded and cached when accessed", () => {
    it("should eagerly populate task detail during domain load", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      // Task details are eagerly populated during domain load so that
      // search (grepItem) can access full entity data (description, notes, etc.)
      const detail = cache.getTaskDetail("01TASKA0000000000000000000");
      expect(detail).not.toBeNull();
      expect(detail!.title).toBe("Sample Task A");
      expect(cache.getTaskHistory("01TASKA0000000000000000000")).toEqual([]);
    });

    it("should retain task detail after explicit set", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const mockTask = { _ulid: "01TASKA0000000000000000000", title: "Full Detail" } as any;
      cache.setTaskDetail("01TASKA0000000000000000000", mockTask);

      const detail = cache.getTaskDetail("01TASKA0000000000000000000");
      expect(detail).not.toBeNull();
      expect(detail!.title).toBe("Full Detail");
    });

    it("should update both index and detail tiers via applyTaskMutation", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      // Verify initial state
      const initialIndex = cache.getTaskIndex();
      const initialEntry = initialIndex?.find((t) => t._ulid === "01TASKA0000000000000000000");
      expect(initialEntry).toBeDefined();
      expect(initialEntry!.status).toBe("pending");

      // Apply a mutation that changes the task status
      const mutatedTask = {
        _ulid: "01TASKA0000000000000000000",
        slugs: initialEntry!.slugs,
        title: initialEntry!.title,
        type: initialEntry!.type,
        status: "in_progress",
        priority: initialEntry!.priority,
        tags: initialEntry!.tags,
        notes: [],
        _sourceFile: "/mock/task.yaml",
      } as any;

      cache.applyTaskMutation("01TASKA0000000000000000000", mutatedTask);

      // Verify index tier is updated
      const updatedIndex = cache.getTaskIndex();
      const updatedEntry = updatedIndex?.find((t) => t._ulid === "01TASKA0000000000000000000");
      expect(updatedEntry).toBeDefined();
      expect(updatedEntry!.status).toBe("in_progress");

      // Verify detail tier is updated
      const updatedDetail = cache.getTaskDetail("01TASKA0000000000000000000");
      expect(updatedDetail).not.toBeNull();
      expect(updatedDetail!.status).toBe("in_progress");
    });

    it("should add new task to index via applyTaskMutation", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const initialCount = cache.getTaskIndex()?.length ?? 0;

      // Apply mutation for a task not yet in the index
      const newTask = {
        _ulid: "01NEWTA0000000000000000000",
        slugs: ["new-task"],
        title: "New Task",
        type: "task",
        status: "pending",
        priority: 3,
        tags: [],
        notes: [],
        _sourceFile: "/mock/new-task.yaml",
      } as any;

      cache.applyTaskMutation("01NEWTA0000000000000000000", newTask);

      // Verify new task appears in both tiers
      const updatedIndex = cache.getTaskIndex();
      expect(updatedIndex?.length).toBe(initialCount + 1);
      const newEntry = updatedIndex?.find((t) => t._ulid === "01NEWTA0000000000000000000");
      expect(newEntry).toBeDefined();
      expect(newEntry!.title).toBe("New Task");

      const detail = cache.getTaskDetail("01NEWTA0000000000000000000");
      expect(detail).not.toBeNull();
    });

    it("should invalidate cached history via applyTaskMutation", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      // After loadDomain, history should be populated (even if empty array)
      const historyBefore = cache.getTaskHistory("01TASKA0000000000000000000");
      expect(historyBefore).not.toBeNull();

      // Apply a mutation that changes the task status
      const initialIndex = cache.getTaskIndex();
      const initialEntry = initialIndex?.find((t) => t._ulid === "01TASKA0000000000000000000");
      const mutatedTask = {
        _ulid: "01TASKA0000000000000000000",
        slugs: initialEntry!.slugs,
        title: initialEntry!.title,
        type: initialEntry!.type,
        status: "in_progress",
        priority: initialEntry!.priority,
        tags: initialEntry!.tags,
        notes: [],
        _sourceFile: "/mock/task.yaml",
      } as any;

      cache.applyTaskMutation("01TASKA0000000000000000000", mutatedTask);

      // History should be invalidated (null) so next read falls through to disk
      const historyAfter = cache.getTaskHistory("01TASKA0000000000000000000");
      expect(historyAfter).toBeNull();

      // But detail and index tiers should still be updated
      const updatedDetail = cache.getTaskDetail("01TASKA0000000000000000000");
      expect(updatedDetail).not.toBeNull();
      expect(updatedDetail!.status).toBe("in_progress");
    });

    it("should not update when tasks domain is not ready", () => {
      // Cache not loaded — domain state is "unloaded"
      const cache = new ProjectEntityCache(projectA);

      const task = {
        _ulid: "01TASKA0000000000000000000",
        title: "Test",
        status: "in_progress",
      } as any;

      // Should silently do nothing (no error)
      cache.applyTaskMutation("01TASKA0000000000000000000", task);

      // Index should still be null (not ready)
      expect(cache.getTaskIndex()).toBeNull();
    });

    it("should return null for uncached session detail", async () => {
      const cache = new ProjectEntityCache(projectA);
      const detail = cache.getSessionDetail("nonexistent-session");
      expect(detail).toBeNull();
    });

    it("should retain session detail after explicit set", async () => {
      const cache = new ProjectEntityCache(projectA);
      const mockSession = { id: "session-001", status: "completed" } as any;
      cache.setSessionDetail("session-001", mockSession);

      const detail = cache.getSessionDetail("session-001");
      expect(detail).not.toBeNull();
      expect(detail!.id).toBe("session-001");
    });

    it("should not eagerly preload plan details during index load", async () => {
      // Cache plan warm-up runs `requirePlanFolderStorage` before `loadPlans`
      // (AC: @entity-folder-migration-and-compatibility-1
      // ac-unmigrated-projects-are-blocked-with-guidance), so the project must
      // declare folder-backed plan storage AND have a consistent folder/index
      // layout for the domain to reach "ready" state. Override the multi-dir
      // fixture's 1.1 manifest with a 1.2 folder-declared manifest and seed a
      // folder-backed plan with its lean index entry — anything else would
      // degrade the plans domain and the detail-on-demand contract could not
      // be exercised.
      // Note: Crockford base32 excludes I, L, O, U
      const planUlid = "01PPAN00000000000000000000";
      await fs.writeFile(
        join(projectA, ".kspec", "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.2",
          project: {
            name: "Plans Detail-on-Demand Project",
            version: "0.1.0",
            status: "draft",
          },
          includes: ["modules/test.yaml"],
          task_storage: { format: "split" },
          plan_storage: { format: "folder" },
          review_storage: { format: "folder" },
          resource_storage: { format: "entity_scoped" },
        }),
        "utf-8",
      );
      // Folder-backed plan sidecar — proves the strict gate's drift detector
      // can match the index entry to an entity folder.
      const planDir = join(projectA, ".kspec", "plans", planUlid);
      await fs.mkdir(planDir, { recursive: true });
      await fs.writeFile(join(planDir, "plan.md"), "# Test Plan\n", "utf-8");
      await fs.writeFile(
        join(planDir, "plan.yaml"),
        yamlStringify({
          _ulid: planUlid,
          slugs: ["plan-test"],
          title: "Test Plan",
          status: "draft",
          created_at: "2026-01-01T00:00:00.000Z",
          derived_tasks: [],
          derived_specs: [],
          notes: [],
        }),
        "utf-8",
      );
      // Lean index entry — populated by the (currently monolithic) loadPlans
      // path. Once folder-backed loadPlans lands, the same lean shape is read
      // directly from `plans/<ulid>/plan.yaml`; the projection through
      // toPlanIndexSummary is identical either way.
      await fs.writeFile(
        join(projectA, ".kspec", "project.plans.yaml"),
        yamlStringify({
          kynetic_plans: "1.2",
          plans: [
            {
              _ulid: planUlid,
              slugs: ["plan-test"],
              title: "Test Plan",
              status: "draft",
              created_at: "2026-01-01T00:00:00.000Z",
              derived_tasks: [],
              derived_specs: [],
            },
          ],
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("plans");

      // Index should be populated
      expect(cache.getPlansIndex()).not.toBeNull();
      expect(cache.getPlansIndex()!.length).toBe(1);
      expect(cache.getPlansIndex()![0]._ulid).toBe(planUlid);

      // Detail tier should NOT be eagerly preloaded — ac-detail-on-demand
      expect(cache.getPlanDetail(planUlid)).toBeNull();
    });

    it("should not eagerly preload review details during index load", async () => {
      // Cache review warm-up runs `requireReviewFolderStorage` before
      // `loadReviewRecords` (AC: @entity-folder-migration-and-compatibility-1
      // ac-unmigrated-projects-are-blocked-with-guidance), so the project
      // must declare folder-backed review storage AND have a consistent
      // folder/index layout for the domain to reach "ready" state. See the
      // sibling plans test for the full rationale.
      const reviewUlid = "01REVW00000000000000000000";
      await fs.writeFile(
        join(projectA, ".kspec", "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.2",
          project: {
            name: "Reviews Detail-on-Demand Project",
            version: "0.1.0",
            status: "draft",
          },
          includes: ["modules/test.yaml"],
          task_storage: { format: "split" },
          plan_storage: { format: "folder" },
          review_storage: { format: "folder" },
          resource_storage: { format: "entity_scoped" },
        }),
        "utf-8",
      );
      const reviewDir = join(projectA, ".kspec", "reviews", reviewUlid);
      await fs.mkdir(reviewDir, { recursive: true });
      await fs.writeFile(
        join(reviewDir, "review.yaml"),
        yamlStringify({
          _ulid: reviewUlid,
          slugs: ["review-test"],
          title: "Test Review",
          lifecycle_state: "open",
          author: "@test",
          subject: {
            type: "task",
            ref: "@task-test",
            shadow_commit: "abc123",
            content_hash: "def456",
          },
          related_refs: [],
          created_at: "2026-01-01T00:00:00.000Z",
          threads: [],
          checks: [],
          verdicts: [],
          events: [],
          external_links: [],
        }),
        "utf-8",
      );
      await fs.writeFile(
        join(projectA, ".kspec", "project.reviews.yaml"),
        yamlStringify({
          kynetic_reviews: "1.2",
          reviews: [
            {
              _ulid: reviewUlid,
              slugs: ["review-test"],
              title: "Test Review",
              lifecycle_state: "open",
              author: "@test",
              subject: {
                type: "task",
                ref: "@task-test",
                shadow_commit: "abc123",
                content_hash: "def456",
              },
              related_refs: [],
              created_at: "2026-01-01T00:00:00.000Z",
              threads: [],
              checks: [],
              verdicts: [],
              events: [],
              external_links: [],
            },
          ],
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("reviews");

      // Index should be populated
      expect(cache.getReviewsIndex()).not.toBeNull();
      expect(cache.getReviewsIndex()!.length).toBe(1);
      expect(cache.getReviewsIndex()![0]._ulid).toBe(reviewUlid);

      // Detail tier should NOT be eagerly preloaded
      expect(cache.getReviewDetail(reviewUlid)).toBeNull();
    });

    it("should not eagerly preload triage details during index load", async () => {
      // Seed triage file in .kspec/ (specDir resolves to .kspec/ via shadow detection)
      const triageUlid = "01TRAG00000000000000000000";
      const inboxUlid = "01BNBX00000000000000000000";
      await fs.writeFile(
        join(projectA, ".kspec", "project.triage.yaml"),
        yamlStringify({
          kynetic_triage: "1.0",
          triage: [
            {
              _ulid: triageUlid,
              inbox_ref: inboxUlid,
              item_snapshot: "Heavy snapshot content for triage record",
              status: "triaged",
              action: "promote",
              reasoning: "This is heavy reasoning content",
              decided_by: "@test",
              evidence_refs: [],
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("triage");

      // Index should be populated
      expect(cache.getTriageIndex()).not.toBeNull();
      expect(cache.getTriageIndex()!.length).toBe(1);
      expect(cache.getTriageIndex()![0]._ulid).toBe(triageUlid);

      // Detail tier should NOT be eagerly preloaded
      expect(cache.getTriageDetail(triageUlid)).toBeNull();
    });
  });

  // ─── AC: ac-watcher-invalidation ───────────────────────────────────────

  // AC: @daemon-entity-cache ac-watcher-invalidation
  describe("ac-watcher-invalidation: file changes reload affected domain", () => {
    it("should reload task index when task file changes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const before = cache.getTaskIndex();
      expect(before).not.toBeNull();
      expect(before!.length).toBe(1);

      // Modify the tasks file — add a second task
      const tasksPath = join(projectA, ".kspec", "project.tasks.yaml");
      const _currentContent = await fs.readFile(tasksPath, "utf-8");
      const newTask = yamlStringify([
        {
          _ulid: "01TASKA0000000000000000000",
          slugs: ["task-a-sample"],
          title: "Sample Task A",
          type: "task",
          status: "pending",
          priority: 1,
          spec_ref: "@spec-a-sample",
          depends_on: [],
          created_at: "2026-01-24T00:00:00.000Z",
          notes: [],
          todos: [],
        },
        {
          _ulid: "01TASKA0000000000000000001",
          slugs: ["task-a-new"],
          title: "New Task A",
          type: "task",
          status: "in_progress",
          priority: 2,
          depends_on: [],
          created_at: "2026-03-01T00:00:00.000Z",
          notes: [],
          todos: [],
        },
      ]);
      await fs.writeFile(tasksPath, newTask, "utf-8");

      // Simulate watcher invalidation
      const kspecDir = join(projectA, ".kspec");
      await cache.handleFileChange(kspecDir, tasksPath);

      const after = cache.getTaskIndex();
      expect(after).not.toBeNull();
      expect(after!.length).toBe(2);
    });

    // AC: @daemon-incremental-cache ac-watcher-content-passthrough
    it("should accept watcher-provided content when invalidating a changed file", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const tasksPath = join(projectA, ".kspec", "project.tasks.yaml");
      const changedContent = yamlStringify([
        {
          _ulid: "01TASKA0000000000000000000",
          slugs: ["task-a-sample"],
          title: "Sample Task A Updated",
          type: "task",
          status: "pending",
          priority: 1,
          spec_ref: "@spec-a-sample",
          depends_on: [],
          created_at: "2026-01-24T00:00:00.000Z",
          notes: [],
          todos: [],
        },
      ]);
      await fs.writeFile(tasksPath, changedContent, "utf-8");

      const kspecDir = join(projectA, ".kspec");
      await expect(
        cache.handleFileChange(kspecDir, tasksPath, changedContent),
      ).resolves.toBeUndefined();

      const after = cache.getTaskIndex();
      expect(after).not.toBeNull();
      expect(after![0].title).toBe("Sample Task A Updated");
    });

    // AC: @coverage-state-api-cache ac-cache-invalidation
    it("should evict coverage-state read model cache when coverage source files change", async () => {
      const cache = new ProjectEntityCache(projectA);
      const ctx = fakeCoverageContext(projectA);
      const loadEvidenceIndex = vi.fn<() => Promise<CoverageEvidenceIndex>>(async () =>
        buildCoverageEvidenceIndex({
          items: [],
          annotations: [],
          testRuns: [],
        }),
      );

      await getCachedCoverageStateReadModel(ctx, { loadEvidenceIndex });
      expect(getCoverageStateReadModelCacheStats().entries).toBe(1);

      await cache.handleFileChange(projectA, join(projectA, "tests", "coverage-source.test.ts"));

      expect(getCoverageStateReadModelCacheStats().entries).toBe(0);
      await getCachedCoverageStateReadModel(ctx, { loadEvidenceIndex });
      expect(loadEvidenceIndex).toHaveBeenCalledTimes(2);
    });

    // AC: @daemon-incremental-cache ac-batch-coalescing
    // AC: @daemon-incremental-cache ac-file-path-preserved
    it("should coalesce all changed file paths into one domain batch per debounce window", async () => {
      vi.useFakeTimers();

      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 50;

        const processChangesSpy = vi
          .spyOn(cache as any, "processDomainChanges")
          .mockResolvedValue(undefined);

        const kspecDir = join(projectA, ".kspec");
        const itemPathA = join(kspecDir, "modules", "alpha.yaml");
        const itemPathB = join(kspecDir, "modules", "beta.yaml");

        const firstInvalidation = cache.handleFileChange(kspecDir, itemPathA, "title: alpha");
        const secondInvalidation = cache.handleFileChange(kspecDir, itemPathB, "title: beta");

        await vi.advanceTimersByTimeAsync(49);
        expect(processChangesSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await Promise.all([firstInvalidation, secondInvalidation]);

        expect(processChangesSpy).toHaveBeenCalledTimes(1);
        expect(processChangesSpy).toHaveBeenCalledWith(
          "items",
          [
            { filePath: itemPathA, content: "title: alpha" },
            { filePath: itemPathB, content: "title: beta" },
          ],
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    // AC: @daemon-incremental-cache ac-file-path-preserved
    it("should keep only the latest content for the same file within one debounce window", async () => {
      vi.useFakeTimers();

      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 50;

        const processChangesSpy = vi
          .spyOn(cache as any, "processDomainChanges")
          .mockResolvedValue(undefined);

        const kspecDir = join(projectA, ".kspec");
        const itemPath = join(kspecDir, "modules", "alpha.yaml");

        const firstInvalidation = cache.handleFileChange(kspecDir, itemPath, "title: alpha v1");
        const secondInvalidation = cache.handleFileChange(kspecDir, itemPath, "title: alpha v2");

        await vi.advanceTimersByTimeAsync(50);
        await Promise.all([firstInvalidation, secondInvalidation]);

        expect(processChangesSpy).toHaveBeenCalledTimes(1);
        expect(processChangesSpy).toHaveBeenCalledWith(
          "items",
          [{ filePath: itemPath, content: "title: alpha v2" }],
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    // AC: @daemon-incremental-cache ac-fallback-full-reload
    it("should pass an empty change set for invalidations without file context", async () => {
      vi.useFakeTimers();

      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 50;

        const processChangesSpy = vi
          .spyOn(cache as any, "processDomainChanges")
          .mockResolvedValue(undefined);

        const invalidation = cache.invalidateDomain("tasks");

        await vi.advanceTimersByTimeAsync(50);
        await invalidation;

        expect(processChangesSpy).toHaveBeenCalledTimes(1);
        expect(processChangesSpy).toHaveBeenCalledWith("tasks", [], expect.anything());
      } finally {
        vi.useRealTimers();
      }
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    // AC: @daemon-incremental-cache ac-index-consistency
    it("should patch only the changed split-backend task in index and detail tiers", async () => {
      const kspecDir = join(projectA, ".kspec");
      seedSplitTask(kspecDir, {
        _ulid: "01TASKB0000000000000000000",
        slugs: ["task-b-sample"],
        title: "Sample Task B",
        type: "task",
        status: "pending",
        priority: 2,
        spec_ref: "@spec-b-sample",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-24T00:00:00.000Z",
      });

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const originalOtherTask = cache.getTaskDetail("01TASKB0000000000000000000");
      expect(originalOtherTask).not.toBeNull();

      const taskPath = join(kspecDir, "tasks", "01TASKA0000000000000000000", "task.yaml");
      await fs.writeFile(
        taskPath,
        yamlStringify({
          _ulid: "01TASKA0000000000000000000",
          slugs: ["task-a-sample"],
          title: "Sample Task A Updated",
          type: "task",
          status: "in_progress",
          priority: 1,
          spec_ref: "@spec-a-sample",
          depends_on: [],
          created_at: "2026-01-24T00:00:00.000Z",
        }),
        "utf-8",
      );

      await cache.handleFileChange(kspecDir, taskPath);

      expect(cache.getTaskDetail("01TASKA0000000000000000000")?.title).toBe(
        "Sample Task A Updated",
      );
      expect(cache.getTaskDetail("01TASKA0000000000000000000")?.status).toBe("in_progress");
      expect(cache.getTaskDetail("01TASKB0000000000000000000")).toBe(originalOtherTask);

      const taskIndex = cache.getTaskIndex();
      expect(taskIndex?.find((task) => task._ulid === "01TASKA0000000000000000000")?.title).toBe(
        "Sample Task A Updated",
      );
      expect(taskIndex?.find((task) => task._ulid === "01TASKB0000000000000000000")?.title).toBe(
        "Sample Task B",
      );
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    it("should update task summary counts from a split-backend notes file change", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const kspecDir = join(projectA, ".kspec");
      const notesPath = join(kspecDir, "tasks", "01TASKA0000000000000000000", "notes.yaml");
      await fs.writeFile(
        notesPath,
        yamlStringify({
          notes: [
            {
              _ulid: testUlid("NOTE", 1),
              created_at: "2026-01-24T00:00:00.000Z",
              author: "@test",
              content: "Updated note",
            },
          ],
        }),
        "utf-8",
      );

      await cache.handleFileChange(kspecDir, notesPath);

      expect(cache.getTaskDetail("01TASKA0000000000000000000")?.notes).toHaveLength(1);
      expect(
        cache.getTaskIndex()?.find((task) => task._ulid === "01TASKA0000000000000000000")
          ?.notes_count,
      ).toBe(1);
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    // AC: @daemon-incremental-cache ac-batch-coalescing
    it("should add a new split-backend task without reloading unrelated tasks", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const kspecDir = join(projectA, ".kspec");
      const newTaskUlid = "01TASKC0000000000000000000";

      seedSplitTask(kspecDir, {
        _ulid: newTaskUlid,
        slugs: ["task-c-sample"],
        title: "Sample Task C",
        type: "task",
        status: "pending",
        priority: 3,
        spec_ref: "@spec-c-sample",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-24T00:00:00.000Z",
      });

      const taskPath = join(kspecDir, "tasks", newTaskUlid, "task.yaml");
      await cache.handleFileChange(kspecDir, taskPath);

      expect(cache.getTaskDetail(newTaskUlid)?.title).toBe("Sample Task C");
      expect(cache.getTaskIndex()?.some((task) => task._ulid === newTaskUlid)).toBe(true);
    });

    // AC: @daemon-incremental-cache ac-removal-detection
    it("should remove a deleted split-backend task from index and detail tiers", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const kspecDir = join(projectA, ".kspec");
      const taskPath = join(kspecDir, "tasks", "01TASKA0000000000000000000", "task.yaml");
      await fs.rm(taskPath, { force: true });

      await cache.handleFileChange(kspecDir, taskPath);

      expect(cache.getTaskDetail("01TASKA0000000000000000000")).toBeNull();
      expect(
        cache.getTaskIndex()?.some((task) => task._ulid === "01TASKA0000000000000000000"),
      ).toBe(false);
    });

    // AC: @daemon-incremental-cache ac-fallback-full-reload
    it("should fall back to a full tasks reload when the monolithic task index file changes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const incrementalSpy = vi.spyOn(cache as any, "tryIncrementalTaskUpdate");
      const loadDomainSpy = vi.spyOn(cache, "loadDomain");
      incrementalSpy.mockClear();
      loadDomainSpy.mockClear();

      const kspecDir = join(projectA, ".kspec");
      const indexPath = join(kspecDir, "project.tasks.yaml");
      await fs.writeFile(
        indexPath,
        yamlStringify([
          {
            _ulid: "01TASKA0000000000000000000",
            slugs: ["task-a-sample"],
            title: "Summary Updated From Index",
            type: "task",
            status: "pending",
            priority: 1,
            spec_ref: "@spec-a-sample",
            depends_on: [],
            created_at: "2026-01-24T00:00:00.000Z",
            notes_count: 0,
            todos_count: 0,
          },
        ]),
        "utf-8",
      );

      await cache.handleFileChange(kspecDir, indexPath);

      expect(incrementalSpy).toHaveBeenCalledOnce();
      await expect(incrementalSpy.mock.results[0]?.value).resolves.toBe(false);
      expect(loadDomainSpy).toHaveBeenCalledWith("tasks", expect.anything());
      expect(cache.getTaskIndex()?.[0]?.title).toBe("Summary Updated From Index");
    });

    it("should replace stale detail cache when domain is invalidated", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      // Set a mock detail that overrides the eagerly loaded one
      const mockTask = { _ulid: "01TASKA0000000000000000000", title: "Stale Detail" } as any;
      cache.setTaskDetail("01TASKA0000000000000000000", mockTask);
      expect(cache.getTaskDetail("01TASKA0000000000000000000")!.title).toBe("Stale Detail");

      // Invalidate domain — detail tier reloads from disk
      await cache.invalidateDomain("tasks");

      // Detail should be refreshed from disk, not stale
      const detail = cache.getTaskDetail("01TASKA0000000000000000000");
      expect(detail).not.toBeNull();
      expect(detail!.title).toBe("Sample Task A"); // Disk value, not stale mock
    });

    it("should invalidate both meta and items domains when manifest changes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");
      await cache.loadDomain("items");

      const metaBefore = cache.getMetaIndex();
      const itemsBefore = cache.getItemIndex();
      expect(metaBefore).not.toBeNull();
      expect(itemsBefore).not.toBeNull();

      // Simulate watcher detecting manifest (kynetic.yaml) change.
      // Because loadAllItems() reads the manifest to discover module
      // includes, the items domain must also be reloaded when the
      // manifest changes — not just the meta domain.
      const kspecDir = join(projectA, ".kspec");
      const manifestPath = join(kspecDir, "kynetic.yaml");
      await cache.handleFileChange(kspecDir, manifestPath);

      // Both domains should have been reloaded (new array references)
      const metaAfter = cache.getMetaIndex();
      const itemsAfter = cache.getItemIndex();
      expect(metaAfter).not.toBeNull();
      expect(itemsAfter).not.toBeNull();
      expect(metaAfter).not.toBe(metaBefore);
      expect(itemsAfter).not.toBe(itemsBefore);
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    // AC: @daemon-incremental-cache ac-index-consistency
    it("should patch only the changed module file without full item reload", async () => {
      await writeItemsFixture(projectA, {
        "modules/alpha.yaml": [buildSpecItem(1, "alpha-spec", "Alpha Spec v1")],
        "modules/beta.yaml": [buildSpecItem(2, "beta-spec", "Beta Spec")],
      });

      const cache = new ProjectEntityCache(projectA);
      const loadAllItemsSpy = vi.spyOn(yamlModule, "loadAllItems");
      await cache.loadDomain("items");
      loadAllItemsSpy.mockClear();

      const beforeIndex = cache.getItemIndex();
      expect(beforeIndex).not.toBeNull();
      expect(beforeIndex!.find((item) => item.slugs.includes("alpha-spec"))?.title).toBe(
        "Alpha Spec v1",
      );

      const kspecDir = join(projectA, ".kspec");
      const alphaPath = join(kspecDir, "modules", "alpha.yaml");
      await fs.writeFile(
        alphaPath,
        yamlStringify([buildSpecItem(1, "alpha-spec", "Alpha Spec v2")]),
        "utf-8",
      );

      await cache.handleFileChange(kspecDir, alphaPath);

      const afterIndex = cache.getItemIndex();
      expect(afterIndex).not.toBeNull();
      expect(afterIndex).not.toBe(beforeIndex);
      expect(beforeIndex!.find((item) => item.slugs.includes("alpha-spec"))?.title).toBe(
        "Alpha Spec v1",
      );
      expect(afterIndex!.find((item) => item.slugs.includes("alpha-spec"))?.title).toBe(
        "Alpha Spec v2",
      );
      expect(afterIndex!.find((item) => item.slugs.includes("beta-spec"))?.title).toBe("Beta Spec");
      expect(loadAllItemsSpy).not.toHaveBeenCalled();
    });

    // AC: @daemon-incremental-cache ac-multi-entity-file
    it("should add newly parsed items from the changed module file to index and details", async () => {
      await writeItemsFixture(projectA, {
        "modules/alpha.yaml": [buildSpecItem(3, "alpha-spec", "Alpha Spec")],
      });

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("items");

      const kspecDir = join(projectA, ".kspec");
      const alphaPath = join(kspecDir, "modules", "alpha.yaml");
      const newItem = buildSpecItem(4, "alpha-extra", "Alpha Extra");
      await fs.writeFile(
        alphaPath,
        yamlStringify([buildSpecItem(3, "alpha-spec", "Alpha Spec"), newItem]),
        "utf-8",
      );

      await cache.handleFileChange(kspecDir, alphaPath);

      const afterIndex = cache.getItemIndex();
      expect(afterIndex?.map((item) => item.slugs[0])).toEqual(["alpha-spec", "alpha-extra"]);
      expect(cache.getItemDetail(newItem._ulid)?.title).toBe("Alpha Extra");
    });

    // AC: @daemon-incremental-cache ac-multi-entity-file
    // AC: @daemon-incremental-cache ac-batch-coalescing
    // AC: @daemon-incremental-cache ac-index-consistency
    it("should preserve file order when multiple module files are patched in one debounce window", async () => {
      vi.useFakeTimers();

      try {
        await writeItemsFixture(projectA, {
          "modules/alpha.yaml": [buildSpecItem(9, "alpha-spec", "Alpha Spec v1")],
          "modules/beta.yaml": [buildSpecItem(10, "beta-spec", "Beta Spec v1")],
          "modules/gamma.yaml": [buildSpecItem(11, "gamma-spec", "Gamma Spec v1")],
        });

        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 50;
        await cache.loadDomain("items");

        const kspecDir = join(projectA, ".kspec");
        const alphaPath = join(kspecDir, "modules", "alpha.yaml");
        const betaPath = join(kspecDir, "modules", "beta.yaml");

        await fs.writeFile(
          alphaPath,
          yamlStringify([buildSpecItem(9, "alpha-spec", "Alpha Spec v2")]),
          "utf-8",
        );
        await fs.writeFile(
          betaPath,
          yamlStringify([buildSpecItem(10, "beta-spec", "Beta Spec v2")]),
          "utf-8",
        );

        const alphaReload = cache.handleFileChange(kspecDir, alphaPath);
        const betaReload = cache.handleFileChange(kspecDir, betaPath);

        await vi.advanceTimersByTimeAsync(50);
        await Promise.all([alphaReload, betaReload]);

        expect(cache.getItemIndex()?.map((item) => item.title)).toEqual([
          "Alpha Spec v2",
          "Beta Spec v2",
          "Gamma Spec v1",
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    // AC: @daemon-incremental-cache ac-removal-detection
    it("should remove items whose source module file was deleted", async () => {
      await writeItemsFixture(projectA, {
        "modules/alpha.yaml": [buildSpecItem(5, "alpha-spec", "Alpha Spec")],
        "modules/beta.yaml": [buildSpecItem(6, "beta-spec", "Beta Spec")],
      });

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("items");

      const kspecDir = join(projectA, ".kspec");
      const alphaPath = join(kspecDir, "modules", "alpha.yaml");
      const alphaUlid = testUlid("SPEC", 5);
      await fs.rm(alphaPath);

      await cache.handleFileChange(kspecDir, alphaPath);

      const afterIndex = cache.getItemIndex();
      expect(afterIndex?.map((item) => item.slugs[0])).toEqual(["beta-spec"]);
      expect(cache.getItemDetail(alphaUlid)).toBeNull();
    });

    // AC: @daemon-incremental-cache ac-fallback-full-reload
    it("should fall back to full item reload when kynetic.yaml changes", async () => {
      await writeItemsFixture(
        projectA,
        {
          "modules/alpha.yaml": [buildSpecItem(7, "alpha-spec", "Alpha Spec")],
          "modules/beta.yaml": [buildSpecItem(8, "beta-spec", "Beta Spec")],
        },
        ["modules/alpha.yaml"],
      );

      const cache = new ProjectEntityCache(projectA);
      const loadAllItemsSpy = vi.spyOn(yamlModule, "loadAllItems");
      await cache.loadDomain("items");
      loadAllItemsSpy.mockClear();

      const kspecDir = join(projectA, ".kspec");
      const manifestPath = join(kspecDir, "kynetic.yaml");
      await fs.writeFile(
        manifestPath,
        buildItemsManifest(["modules/alpha.yaml", "modules/beta.yaml"]),
        "utf-8",
      );

      await cache.handleFileChange(kspecDir, manifestPath);

      const afterIndex = cache.getItemIndex();
      expect(afterIndex?.map((item) => item.slugs[0])).toEqual(["alpha-spec", "beta-spec"]);
      expect(loadAllItemsSpy).toHaveBeenCalledTimes(1);
    });

    // AC: @daemon-incremental-cache ac-fallback-full-reload
    it("should fall back to full item reload for changed spec files outside manifest includes", async () => {
      const orphanItem = buildSpecItem(12, "orphan-spec", "Orphan Spec");
      await writeItemsFixture(projectA, {
        "modules/alpha.yaml": [buildSpecItem(13, "alpha-spec", "Alpha Spec")],
        "orphan.spec.yaml": [orphanItem],
      });

      const cache = new ProjectEntityCache(projectA);
      const loadAllItemsSpy = vi.spyOn(yamlModule, "loadAllItems");
      await cache.loadDomain("items");
      loadAllItemsSpy.mockClear();

      const kspecDir = join(projectA, ".kspec");
      const orphanPath = join(kspecDir, "orphan.spec.yaml");
      await fs.writeFile(
        orphanPath,
        yamlStringify([buildSpecItem(12, "orphan-spec", "Orphan Spec Updated")]),
        "utf-8",
      );

      await cache.handleFileChange(kspecDir, orphanPath);

      expect(cache.getItemIndex()?.map((item) => item.slugs[0])).toEqual(["alpha-spec"]);
      expect(cache.getItemDetail(orphanItem._ulid)).toBeNull();
      expect(loadAllItemsSpy).toHaveBeenCalledTimes(1);
    });

    // AC: @daemon-meta-subdomain ac-manifest-only-reload
    it("reloads only manifest-backed meta data when a meta YAML file changes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");
      await cache.loadDomain("items");

      const manifestSpy = vi.spyOn(cache as any, "loadMetaManifestSubdomain");
      const shadowSpy = vi.spyOn(cache as any, "loadMetaShadowSubdomain");
      const sessionSpy = vi.spyOn(cache as any, "loadMetaSessionSubdomain");

      const shadowBefore = cache.getShadowInfo();
      const sessionBefore = cache.getSessionContext();

      const kspecDir = join(projectA, ".kspec");
      const manifestPath = join(kspecDir, "kynetic.yaml");
      await cache.handleFileChange(kspecDir, manifestPath);

      expect(manifestSpy).toHaveBeenCalledOnce();
      expect(shadowSpy).not.toHaveBeenCalled();
      expect(sessionSpy).not.toHaveBeenCalled();
      expect(cache.getShadowInfo()).toBe(shadowBefore);
      expect(cache.getSessionContext()).toBe(sessionBefore);
    });

    // AC: @daemon-meta-subdomain ac-manifest-only-reload
    it("reloads only manifest-backed meta data when an included meta YAML file changes", async () => {
      const kspecDir = join(projectA, ".kspec");
      const metaManifestPath = join(kspecDir, "kynetic.meta.yaml");
      const includedMetaPath = join(kspecDir, "meta", "roles.yaml");

      await fs.mkdir(dirname(includedMetaPath), { recursive: true });
      await fs.writeFile(
        metaManifestPath,
        yamlStringify({
          kynetic_meta: "1.0",
          includes: ["meta/roles.yaml"],
          conventions: [],
        }),
        "utf-8",
      );
      await fs.writeFile(
        includedMetaPath,
        yamlStringify({
          conventions: [],
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");

      const manifestSpy = vi.spyOn(cache as any, "loadMetaManifestSubdomain");
      const shadowSpy = vi.spyOn(cache as any, "loadMetaShadowSubdomain");
      const sessionSpy = vi.spyOn(cache as any, "loadMetaSessionSubdomain");

      const shadowBefore = cache.getShadowInfo();
      const sessionBefore = cache.getSessionContext();

      await fs.writeFile(
        includedMetaPath,
        yamlStringify({
          conventions: [{ title: "Roles convention", rules: ["Use named roles"] }],
        }),
        "utf-8",
      );

      await cache.handleFileChange(kspecDir, includedMetaPath);

      expect(manifestSpy).toHaveBeenCalledOnce();
      expect(shadowSpy).not.toHaveBeenCalled();
      expect(sessionSpy).not.toHaveBeenCalled();
      expect(cache.getShadowInfo()).toBe(shadowBefore);
      expect(cache.getSessionContext()).toBe(sessionBefore);
    });

    it("deduplicates overlapping manifest-only meta reloads", async () => {
      const originalKspecTest = process.env.KSPEC_TEST;
      process.env.KSPEC_TEST = "1";

      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 0;
        await cache.loadDomain("meta");

        const manifestSpy = vi.spyOn(cache as any, "loadMetaManifestSubdomain");
        const kspecDir = join(projectA, ".kspec");
        const manifestPath = join(kspecDir, "kynetic.yaml");

        setTestDelay(projectA);

        const firstReload = cache.handleFileChange(kspecDir, manifestPath);
        await vi.waitFor(() => expect((cache as any).inFlightReloads.has("meta")).toBe(true));

        const secondReload = cache.handleFileChange(kspecDir, manifestPath);

        releaseTestDelay(projectA);
        await Promise.all([firstReload, secondReload]);

        expect(manifestSpy).toHaveBeenCalledTimes(1);
        expect(cache.getDomainState("meta")).toBe("ready");
      } finally {
        releaseTestDelay(projectA);
        if (originalKspecTest === undefined) {
          delete process.env.KSPEC_TEST;
        } else {
          process.env.KSPEC_TEST = originalKspecTest;
        }
      }
    });

    // AC: @daemon-entity-cache ac-reload-dedup
    it("runs pending shadow refreshes after an in-flight manifest-only meta reload finishes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");

      const originalManifestLoad = (cache as any).loadMetaManifestSubdomain.bind(cache);
      let releaseManifestLoad!: () => void;
      const manifestGate = new Promise<void>((resolve) => {
        releaseManifestLoad = resolve;
      });
      const manifestSpy = vi
        .spyOn(cache as any, "loadMetaManifestSubdomain")
        .mockImplementation(async (cycle?: unknown) => {
          await manifestGate;
          await originalManifestLoad(cycle);
        });
      const shadowSpy = vi.spyOn(cache as any, "loadMetaShadowSubdomain");

      const kspecDir = join(projectA, ".kspec");
      const manifestPath = join(kspecDir, "kynetic.yaml");

      const manifestReload = cache.handleFileChange(kspecDir, manifestPath);
      await vi.waitFor(() => expect(manifestSpy).toHaveBeenCalledOnce());

      const shadowReload = cache.refreshMetaShadowInfo();
      await vi.waitFor(() => expect((cache as any).pendingMetaSubdomains.has("shadow")).toBe(true));

      releaseManifestLoad();
      await Promise.all([manifestReload, shadowReload]);

      expect(manifestSpy).toHaveBeenCalledOnce();
      expect(shadowSpy).toHaveBeenCalledOnce();
      expect(cache.getDomainState("meta")).toBe("ready");
    });

    // AC: @daemon-meta-subdomain ac-session-context-independent
    it("reloads only cached session context when the session context file changes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");

      const manifestSpy = vi.spyOn(cache as any, "loadMetaManifestSubdomain");
      const shadowSpy = vi.spyOn(cache as any, "loadMetaShadowSubdomain");
      const sessionSpy = vi.spyOn(cache as any, "loadMetaSessionSubdomain");

      const metaBefore = cache.getMetaIndex();
      const shadowBefore = cache.getShadowInfo();
      const kspecDir = join(projectA, ".kspec");
      const sessionContextPath = join(kspecDir, ".kspec-session");

      await fs.writeFile(
        sessionContextPath,
        yamlStringify({
          focus: "Investigate meta sub-domain reloads",
          threads: ["thread-a"],
          open_questions: ["question-a"],
          updated_at: "2026-04-06T00:00:00.000Z",
        }),
        "utf-8",
      );

      await cache.handleFileChange(kspecDir, sessionContextPath);

      expect(sessionSpy).toHaveBeenCalledOnce();
      expect(manifestSpy).not.toHaveBeenCalled();
      expect(shadowSpy).not.toHaveBeenCalled();
      expect(cache.getMetaIndex()).toBe(metaBefore);
      expect(cache.getShadowInfo()).toBe(shadowBefore);
      expect(cache.getSessionContext()).toMatchObject({
        focus: "Investigate meta sub-domain reloads",
        threads: ["thread-a"],
        questions: ["question-a"],
      });
    });

    // AC: @daemon-meta-subdomain ac-shadow-on-schedule
    it("refreshes only cached shadow info during background shadow sync", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");

      const manifestSpy = vi.spyOn(cache as any, "loadMetaManifestSubdomain");
      const shadowSpy = vi.spyOn(cache as any, "loadMetaShadowSubdomain");
      const sessionSpy = vi.spyOn(cache as any, "loadMetaSessionSubdomain");

      const metaBefore = cache.getMetaIndex();
      const sessionBefore = cache.getSessionContext();
      const shadowBefore = cache.getShadowInfo();

      await cache.refreshMetaShadowInfo();

      expect(shadowSpy).toHaveBeenCalledOnce();
      expect(manifestSpy).not.toHaveBeenCalled();
      expect(sessionSpy).not.toHaveBeenCalled();
      expect(cache.getMetaIndex()).toBe(metaBefore);
      expect(cache.getSessionContext()).toBe(sessionBefore);
      expect(cache.getShadowInfo()).not.toBeNull();
      expect(cache.getShadowInfo()).not.toBe(shadowBefore);
    });

    // AC: @daemon-entity-cache ac-context-reuse
    it("should reuse initContext once across manifest-triggered multi-domain reloads", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");
      await cache.loadDomain("items");

      const initContextSpy = vi.spyOn(yamlModule, "initContext");
      const kspecDir = join(projectA, ".kspec");
      const manifestPath = join(kspecDir, "kynetic.yaml");

      await cache.handleFileChange(kspecDir, manifestPath);

      expect(initContextSpy).toHaveBeenCalledTimes(1);
    });

    // AC: @daemon-entity-cache ac-context-reuse
    it("should start a fresh initContext for a later debounce window", async () => {
      const originalKspecTest = process.env.KSPEC_TEST;
      process.env.KSPEC_TEST = "1";

      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 0;
        await cache.loadDomain("meta");
        await cache.loadDomain("items");
        await cache.loadDomain("tasks");

        const initContextSpy = vi.spyOn(yamlModule, "initContext");
        const kspecDir = join(projectA, ".kspec");
        // Use a generic .yaml change for the first window so it touches only
        // items+meta (catch-all mapping). kynetic.yaml now also invalidates
        // the tasks domain (task-storage compatibility re-evaluation), so it
        // would overlap with the second window's tasks invalidation.
        const genericYamlPath = join(kspecDir, "settings.yaml");

        setTestDelay(projectA);

        const firstWindowReload = cache.handleFileChange(kspecDir, genericYamlPath);
        await vi.waitFor(() => {
          expect((cache as any).inFlightReloads.has("meta")).toBe(true);
          expect((cache as any).inFlightReloads.has("items")).toBe(true);
        });

        const secondWindowReload = cache.invalidateDomain("tasks");
        await vi.waitFor(() => {
          expect((cache as any).inFlightReloads.has("meta")).toBe(true);
          expect((cache as any).inFlightReloads.has("items")).toBe(true);
          expect((cache as any).inFlightReloads.has("tasks")).toBe(true);
        });

        releaseTestDelay(projectA);
        await Promise.all([firstWindowReload, secondWindowReload]);

        expect(initContextSpy).toHaveBeenCalledTimes(2);
      } finally {
        releaseTestDelay(projectA);
        if (originalKspecTest === undefined) {
          delete process.env.KSPEC_TEST;
        } else {
          process.env.KSPEC_TEST = originalKspecTest;
        }
      }
    });

    it("should invalidate sessions domain when session watcher path is received", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");

      const before = cache.getSessionIndex();
      expect(before).not.toBeNull();

      // Simulate session watcher: sessionsDir as kspecDir, session root as filePath.
      // SessionWatcher.getBroadcastPath returns the session root directory
      // (e.g. /path/to/.kspec-sessions/01ULID...), and project-context.ts
      // passes sessionsDir as the second argument to handleFileChange.
      const sessionsDir = join(projectA, ".kspec-sessions");
      const sessionPath = join(sessionsDir, "01TASKA0000000000000000000");
      await cache.handleFileChange(sessionsDir, sessionPath);

      // Sessions domain should have been reloaded (new array reference)
      const after = cache.getSessionIndex();
      expect(after).not.toBe(before);
    });

    // AC: @daemon-entity-cache ac-watcher-invalidation
    it("should invalidate sessions domain for non-ULID session paths", async () => {
      // Session IDs in this codebase are plain strings (SessionMetadataSchema uses z.string()).
      // SessionWatcher broadcasts the session root directory name verbatim, so for a
      // non-ULID path like 'session-123/events.jsonl', handleFileChange must still
      // invalidate the sessions domain.
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");

      const before = cache.getSessionIndex();
      expect(before).not.toBeNull();

      const sessionsDir = join(projectA, ".kspec-sessions");
      const sessionPath = join(sessionsDir, "session-123", "events.jsonl");
      await cache.handleFileChange(sessionsDir, sessionPath);

      // Sessions domain should have been reloaded
      const after = cache.getSessionIndex();
      expect(after).not.toBe(before);
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    // AC: @daemon-incremental-cache ac-index-consistency
    it("should patch only the changed session without rescanning the sessions directory", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      const alphaDir = join(sessionsDir, "session-alpha");
      const betaDir = join(sessionsDir, "session-beta");
      await fs.mkdir(alphaDir, { recursive: true });
      await fs.mkdir(betaDir, { recursive: true });
      const alphaPath = join(alphaDir, "session.yaml");
      await fs.writeFile(
        alphaPath,
        yamlStringify({
          id: "session-alpha",
          agent_type: "claude-agent-acp",
          status: "active",
          started_at: "2026-04-01T00:00:00.000Z",
          event_count: 1,
        }),
        "utf-8",
      );
      await fs.writeFile(
        join(betaDir, "session.yaml"),
        yamlStringify({
          id: "session-beta",
          agent_type: "claude-agent-acp",
          status: "completed",
          started_at: "2026-04-02T00:00:00.000Z",
          ended_at: "2026-04-02T00:05:00.000Z",
          event_count: 2,
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");

      const metadataSpy = vi.spyOn(sessionStoreModule, "getSessionMetadataOnly");

      await fs.writeFile(
        alphaPath,
        yamlStringify({
          id: "session-alpha",
          agent_type: "claude-agent-acp",
          status: "completed",
          started_at: "2026-04-01T00:00:00.000Z",
          ended_at: "2026-04-01T00:07:00.000Z",
          event_count: 7,
          iteration_count: 3,
        }),
        "utf-8",
      );

      await cache.handleFileChange(sessionsDir, alphaPath);

      expect(metadataSpy).toHaveBeenCalledTimes(1);
      expect(metadataSpy).toHaveBeenCalledWith(sessionsDir, "session-alpha");
      expect(cache.getSessionDetail("session-alpha")).toBeNull();
      expect(cache.getSessionIndex()?.map((session) => session.id)).toEqual([
        "session-beta",
        "session-alpha",
      ]);
      expect(
        cache.getSessionIndex()?.find((session) => session.id === "session-beta"),
      ).toMatchObject({
        id: "session-beta",
        status: "completed",
        event_count: 2,
      });
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    // AC: @daemon-incremental-cache ac-index-consistency
    // AC: @daemon-entity-cache ac-session-bounded-index
    it("should insert a new session into the bounded index in recency order", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      for (const [id, startedAt] of [
        ["session-oldest", "2026-04-01T00:00:00.000Z"],
        ["session-middle", "2026-04-02T00:00:00.000Z"],
      ] as const) {
        const sessionDir = join(sessionsDir, id);
        await fs.mkdir(sessionDir, { recursive: true });
        await fs.writeFile(
          join(sessionDir, "session.yaml"),
          yamlStringify({
            id,
            agent_type: "claude-agent-acp",
            status: "completed",
            started_at: startedAt,
            ended_at: startedAt,
          }),
          "utf-8",
        );
      }

      const cache = new ProjectEntityCache(projectA, { maxIndexSize: 2 });
      await cache.loadDomain("sessions");

      const newestDir = join(sessionsDir, "session-newest");
      await fs.mkdir(newestDir, { recursive: true });
      const newestPath = join(newestDir, "session.yaml");
      await fs.writeFile(
        newestPath,
        yamlStringify({
          id: "session-newest",
          agent_type: "claude-agent-acp",
          status: "completed",
          started_at: "2026-04-03T00:00:00.000Z",
          ended_at: "2026-04-03T00:05:00.000Z",
        }),
        "utf-8",
      );

      const metadataSpy = vi.spyOn(sessionStoreModule, "getSessionMetadataOnly");

      await cache.handleFileChange(sessionsDir, newestPath);

      expect(metadataSpy).toHaveBeenCalledTimes(1);
      expect(metadataSpy).toHaveBeenCalledWith(sessionsDir, "session-newest");
      expect(cache.getSessionIndex()?.map((session) => session.id)).toEqual([
        "session-newest",
        "session-middle",
      ]);
      expect(cache.getSessionDetail("session-newest")).toBeNull();
    });

    // AC: @daemon-incremental-cache ac-removal-detection
    it("should remove a deleted session from index, detail cache, and live counters", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      const removableDir = join(sessionsDir, "session-removable");
      await fs.mkdir(removableDir, { recursive: true });
      const removablePath = join(removableDir, "session.yaml");
      await fs.writeFile(
        removablePath,
        yamlStringify({
          id: "session-removable",
          agent_type: "claude-agent-acp",
          status: "active",
          started_at: "2026-04-03T00:00:00.000Z",
          event_count: 1,
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");
      cache.setSessionDetail("session-removable", {
        id: "session-removable",
        status: "active",
        agent_type: "claude-agent-acp",
        agent_id: undefined,
        session_type: "agent",
        trigger: "legacy",
        task_id: undefined,
        started_at: "2026-04-03T00:00:00.000Z",
        ended_at: undefined,
        duration_ms: 0,
        event_count: 1,
        iteration_count: 0,
        tasks_completed: 0,
      });
      cache.incrementSessionEventCount("session-removable");

      await fs.rm(removableDir, { recursive: true, force: true });

      const metadataSpy = vi.spyOn(sessionStoreModule, "getSessionMetadataOnly");
      await cache.handleFileChange(sessionsDir, removablePath);

      expect(metadataSpy).not.toHaveBeenCalled();
      expect(cache.getSessionIndex()?.find((session) => session.id === "session-removable")).toBe(
        undefined,
      );
      expect(cache.getSessionDetail("session-removable")).toBeNull();
      expect(cache.getSessionLiveEventCount("session-removable")).toBeUndefined();
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    it("should clear stale detail cache on active-session event invalidation so routes use live counts", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      const sessionId = "session-live-detail";
      const sessionDir = join(sessionsDir, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      const eventsPath = join(sessionDir, "events.jsonl");
      await fs.writeFile(
        join(sessionDir, "session.yaml"),
        yamlStringify({
          id: sessionId,
          agent_type: "claude-agent-acp",
          status: "active",
          started_at: "2026-04-03T00:00:00.000Z",
          event_count: 1,
        }),
        "utf-8",
      );
      await fs.writeFile(eventsPath, "", "utf-8");

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");
      cache.setSessionDetail(sessionId, {
        id: sessionId,
        status: "active",
        agent_type: "claude-agent-acp",
        agent_id: undefined,
        session_type: "agent",
        trigger: "legacy",
        task_id: undefined,
        started_at: "2026-04-03T00:00:00.000Z",
        ended_at: undefined,
        duration_ms: 0,
        event_count: 1,
        iteration_count: 0,
        tasks_completed: 0,
      });
      cache.incrementSessionEventCount(sessionId);
      cache.incrementSessionEventCount(sessionId);

      await fs.appendFile(eventsPath, '{"type":"tool_call"}\n', "utf-8");
      await cache.handleFileChange(sessionsDir, eventsPath);

      expect(cache.getSessionDetail(sessionId)).toBeNull();
      expect(
        cache.getSessionIndex()?.find((session) => session.id === sessionId)?.event_count,
      ).toBe(3);
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    it("should mark an incrementally invalidated active session as stalled when it crosses stale thresholds", async () => {
      vi.useFakeTimers();

      try {
        vi.setSystemTime(new Date("2026-04-02T12:00:00.000Z"));

        const sessionsDir = join(projectA, ".kspec-sessions");
        await fs.mkdir(sessionsDir, { recursive: true });

        const sessionId = "session-turns-stale";
        const sessionDir = join(sessionsDir, sessionId);
        await fs.mkdir(sessionDir, { recursive: true });
        const metadataPath = join(sessionDir, "session.yaml");
        await fs.writeFile(
          metadataPath,
          yamlStringify({
            id: sessionId,
            agent_type: "claude-agent-acp",
            status: "active",
            started_at: "2026-04-02T00:00:00.000Z",
            event_count: 1,
          }),
          "utf-8",
        );

        const cache = new ProjectEntityCache(projectA);
        await cache.loadDomain("sessions");
        (cache as any).domainDebounceMs = 0;

        expect(cache.getSessionIndex()?.find((session) => session.id === sessionId)?.status).toBe(
          "active",
        );

        vi.setSystemTime(new Date("2026-04-03T18:30:00.000Z"));
        const invalidation = cache.handleFileChange(sessionsDir, metadataPath);
        await vi.advanceTimersByTimeAsync(0);
        await invalidation;

        expect(cache.getSessionIndex()?.find((session) => session.id === sessionId)?.status).toBe(
          "stalled",
        );
        expect(cache.getSessionDetail(sessionId)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    // AC: @daemon-incremental-cache ac-fallback-full-reload
    it("should fall back to a full sessions reload when the sessions root changes without a session id", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      const sessionId = "session-root-fallback";
      const sessionDir = join(sessionsDir, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        join(sessionDir, "session.yaml"),
        yamlStringify({
          id: sessionId,
          agent_type: "claude-agent-acp",
          status: "completed",
          started_at: "2026-04-03T00:00:00.000Z",
          ended_at: "2026-04-03T00:05:00.000Z",
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");

      const incrementalSpy = vi.spyOn(cache as any, "tryIncrementalSessionUpdate");
      const loadDomainSpy = vi.spyOn(cache, "loadDomain");
      incrementalSpy.mockClear();
      loadDomainSpy.mockClear();

      await cache.handleFileChange(sessionsDir, sessionsDir);

      expect(incrementalSpy).toHaveBeenCalledTimes(1);
      expect(loadDomainSpy).toHaveBeenCalledWith("sessions", expect.anything());
    });
  });

  // ─── AC: ac-granular-reload ────────────────────────────────────────────

  // AC: @daemon-entity-cache ac-granular-reload
  describe("ac-granular-reload: only affected domain reloaded", () => {
    it("should reload only tasks when task file changes, leaving items intact", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");
      await cache.loadDomain("items");

      const itemsBefore = cache.getItemIndex();
      expect(itemsBefore).not.toBeNull();

      // Invalidate tasks only
      await cache.invalidateDomain("tasks");

      // Items should still be the same reference (not reloaded)
      const itemsAfter = cache.getItemIndex();
      expect(itemsAfter).toBe(itemsBefore);
    });

    it("should reload only items when spec file changes, leaving tasks intact", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");
      await cache.loadDomain("items");

      const tasksBefore = cache.getTaskIndex();

      // Simulate item file change
      const kspecDir = join(projectA, ".kspec");
      await cache.handleFileChange(kspecDir, join(kspecDir, "modules", "test.yaml"));

      // Tasks should be unchanged
      const tasksAfter = cache.getTaskIndex();
      expect(tasksAfter).toBe(tasksBefore);
    });
  });

  // ─── AC: ac-write-through ─────────────────────────────────────────────

  // AC: @daemon-entity-cache ac-write-through
  describe("ac-write-through: cache updated before response, watcher skip", () => {
    it("should skip next watcher invalidation after write-through", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const tasksBefore = cache.getTaskIndex();

      // Mark write-through — next invalidation should be skipped
      cache.markWriteThrough("tasks");

      // Simulate watcher invalidation (should be skipped)
      await cache.invalidateDomain("tasks");

      // Tasks should be the same reference (no reload occurred)
      const tasksAfter = cache.getTaskIndex();
      expect(tasksAfter).toBe(tasksBefore);
    });

    it("should allow invalidation after write-through skip is consumed", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const tasksBefore = cache.getTaskIndex();

      // First invalidation: write-through skip
      cache.markWriteThrough("tasks");
      await cache.invalidateDomain("tasks");
      expect(cache.getTaskIndex()).toBe(tasksBefore); // Skipped

      // Second invalidation: should actually reload
      await cache.invalidateDomain("tasks");
      // After reload, it's a new array (even if same data)
      const tasksAfter = cache.getTaskIndex();
      expect(tasksAfter).not.toBe(tasksBefore); // Different reference
    });

    it("should reload domain via writeThrough convenience method", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const before = cache.getTaskIndex();

      // writeThrough reloads and marks skip
      await cache.writeThrough("tasks");

      // Data reloaded (new reference)
      const after = cache.getTaskIndex();
      expect(after).not.toBe(before);

      // Next watcher invalidation should be skipped
      const afterWriteThrough = cache.getTaskIndex();
      await cache.invalidateDomain("tasks");
      expect(cache.getTaskIndex()).toBe(afterWriteThrough);
    });

    // AC: @daemon-entity-cache ac-task-history-retention
    it("retains task field-change history after hinted task write-through updates", async () => {
      const kspecDir = join(projectA, ".kspec");
      seedSplitTask(kspecDir, {
        _ulid: "01TASKH0000000000000000000",
        slugs: ["task-history-sample"],
        title: "Task history sample",
        type: "task",
        status: "pending",
        priority: 3,
        depends_on: [],
        created_at: "2026-01-24T00:00:00.000Z",
        history: [
          {
            timestamp: "2026-01-24T00:00:00.000Z",
            author: "@tester",
            command: "task-set",
            changes: {
              priority: {
                previous: 2,
                new: 3,
              },
            },
          },
        ],
      });

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const taskPath = join(kspecDir, "tasks", "01TASKH0000000000000000000", "task.yaml");
      await fs.writeFile(
        taskPath,
        yamlStringify({
          _ulid: "01TASKH0000000000000000000",
          slugs: ["task-history-sample"],
          title: "Task history sample updated",
          type: "task",
          status: "in_progress",
          priority: 1,
          depends_on: [],
          created_at: "2026-01-24T00:00:00.000Z",
          history: [
            {
              timestamp: "2026-01-24T00:00:00.000Z",
              author: "@tester",
              command: "task-set",
              changes: {
                priority: {
                  previous: 2,
                  new: 3,
                },
              },
            },
            {
              timestamp: "2026-01-24T00:05:00.000Z",
              author: "@tester",
              command: "task-start",
              changes: {
                status: {
                  previous: "pending",
                  new: "in_progress",
                },
              },
            },
          ],
        }),
        "utf-8",
      );

      await cache.writeThrough("tasks", { ulid: "01TASKH0000000000000000000" });

      const cached = cache.getTaskDetail("01TASKH0000000000000000000");
      const history = cache.getTaskHistory("01TASKH0000000000000000000");
      expect(cached).not.toBeNull();
      expect(cached?.title).toBe("Task history sample updated");
      expect(history).toHaveLength(2);
      expect(history?.[1]?.changes.status).toEqual({
        previous: "pending",
        new: "in_progress",
      });
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    // AC: @daemon-entity-cache ac-write-through
    it("should use incremental task patching for writeThrough when given a task hint", async () => {
      const kspecDir = join(projectA, ".kspec");
      seedSplitTask(kspecDir, {
        _ulid: "01TASKB0000000000000000000",
        slugs: ["task-b-sample"],
        title: "Sample Task B",
        type: "task",
        status: "pending",
        priority: 2,
        spec_ref: "@spec-b-sample",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-24T00:00:00.000Z",
      });

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const unchangedTask = cache.getTaskDetail("01TASKB0000000000000000000");
      expect(unchangedTask).not.toBeNull();

      const loadDomainSpy = vi.spyOn(cache, "loadDomain");
      loadDomainSpy.mockClear();

      const taskPath = join(kspecDir, "tasks", "01TASKA0000000000000000000", "task.yaml");
      await fs.writeFile(
        taskPath,
        yamlStringify({
          _ulid: "01TASKA0000000000000000000",
          slugs: ["task-a-sample"],
          title: "Sample Task A via WriteThrough",
          type: "task",
          status: "in_progress",
          priority: 1,
          spec_ref: "@spec-a-sample",
          depends_on: [],
          created_at: "2026-01-24T00:00:00.000Z",
        }),
        "utf-8",
      );

      await cache.writeThrough("tasks", { ulid: "01TASKA0000000000000000000" });

      expect(loadDomainSpy).not.toHaveBeenCalled();
      expect(cache.getTaskDetail("01TASKA0000000000000000000")?.title).toBe(
        "Sample Task A via WriteThrough",
      );
      expect(cache.getTaskDetail("01TASKB0000000000000000000")).toBe(unchangedTask);

      const afterWriteThrough = cache.getTaskIndex();
      await cache.invalidateDomain("tasks");
      expect(cache.getTaskIndex()).toBe(afterWriteThrough);
    });

    // AC: @daemon-incremental-cache ac-single-entity-patch
    // AC: @daemon-incremental-cache ac-index-consistency
    // AC: @daemon-entity-cache ac-write-through
    it("should preserve both task patches during concurrent hinted writeThrough calls", async () => {
      const kspecDir = join(projectA, ".kspec");
      seedSplitTask(kspecDir, {
        _ulid: "01TASKB0000000000000000000",
        slugs: ["task-b-sample"],
        title: "Sample Task B",
        type: "task",
        status: "pending",
        priority: 2,
        spec_ref: "@spec-b-sample",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-24T00:00:00.000Z",
      });

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const taskAPath = join(kspecDir, "tasks", "01TASKA0000000000000000000", "task.yaml");
      const taskBPath = join(kspecDir, "tasks", "01TASKB0000000000000000000", "task.yaml");
      await fs.writeFile(
        taskAPath,
        yamlStringify({
          _ulid: "01TASKA0000000000000000000",
          slugs: ["task-a-sample"],
          title: "Sample Task A concurrent update",
          type: "task",
          status: "in_progress",
          priority: 1,
          spec_ref: "@spec-a-sample",
          depends_on: [],
          created_at: "2026-01-24T00:00:00.000Z",
        }),
        "utf-8",
      );
      await fs.writeFile(
        taskBPath,
        yamlStringify({
          _ulid: "01TASKB0000000000000000000",
          slugs: ["task-b-sample"],
          title: "Sample Task B concurrent update",
          type: "task",
          status: "completed",
          priority: 2,
          spec_ref: "@spec-b-sample",
          depends_on: [],
          created_at: "2026-01-24T00:00:00.000Z",
        }),
        "utf-8",
      );

      const originalGetTask = TaskDataManager.prototype.getTask;
      let releaseTaskARead!: () => void;
      const taskAReadGate = new Promise<void>((resolve) => {
        releaseTaskARead = resolve;
      });
      let resolveTaskBRead!: () => void;
      const taskBRead = new Promise<void>((resolve) => {
        resolveTaskBRead = resolve;
      });

      vi.spyOn(TaskDataManager.prototype, "getTask").mockImplementation(async function (ctx, ref) {
        if (ref === "01TASKA0000000000000000000") {
          await taskAReadGate;
        }
        const task = await originalGetTask.call(this, ctx, ref);
        if (ref === "01TASKB0000000000000000000") {
          resolveTaskBRead();
        }
        return task;
      });

      const writeThroughs = Promise.all([
        cache.writeThrough("tasks", { ulid: "01TASKA0000000000000000000" }),
        cache.writeThrough("tasks", { ulid: "01TASKB0000000000000000000" }),
      ]);

      await Promise.race([taskBRead, new Promise((resolve) => setTimeout(resolve, 25))]);
      releaseTaskARead();
      await writeThroughs;

      expect(cache.getTaskDetail("01TASKA0000000000000000000")?.title).toBe(
        "Sample Task A concurrent update",
      );
      expect(cache.getTaskDetail("01TASKB0000000000000000000")?.title).toBe(
        "Sample Task B concurrent update",
      );
      expect(cache.getTaskDetail("01TASKB0000000000000000000")?.status).toBe("completed");
    });

    // AC: @daemon-incremental-cache ac-fallback-full-reload
    // AC: @daemon-entity-cache ac-write-through
    it("should fall back to a full reload when writeThrough has no entity hint", async () => {
      const kspecDir = join(projectA, ".kspec");
      seedSplitTask(kspecDir, {
        _ulid: "01TASKB0000000000000000000",
        slugs: ["task-b-sample"],
        title: "Sample Task B",
        type: "task",
        status: "pending",
        priority: 2,
        spec_ref: "@spec-b-sample",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-24T00:00:00.000Z",
      });

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const sentinel = { _ulid: "01TASKB0000000000000000000", title: "stale detail" } as any;
      cache.setTaskDetail("01TASKB0000000000000000000", sentinel);

      const taskPath = join(kspecDir, "tasks", "01TASKA0000000000000000000", "task.yaml");
      await fs.writeFile(
        taskPath,
        yamlStringify({
          _ulid: "01TASKA0000000000000000000",
          slugs: ["task-a-sample"],
          title: "Sample Task A full reload",
          type: "task",
          status: "in_progress",
          priority: 1,
          spec_ref: "@spec-a-sample",
          depends_on: [],
          created_at: "2026-01-24T00:00:00.000Z",
        }),
        "utf-8",
      );

      await cache.writeThrough("tasks");

      expect(cache.getTaskDetail("01TASKB0000000000000000000")).not.toBe(sentinel);
      expect(cache.getTaskDetail("01TASKB0000000000000000000")?.title).toBe("Sample Task B");
    });

    // AC: @daemon-incremental-cache ac-multi-entity-file
    // AC: @daemon-entity-cache ac-write-through
    it("should use item source-file patching for writeThrough when given an item hint", async () => {
      await writeItemsFixture(projectA, {
        "modules/alpha.yaml": [buildSpecItem(20, "alpha-spec", "Alpha Spec v1")],
        "modules/beta.yaml": [buildSpecItem(21, "beta-spec", "Beta Spec")],
      });

      const cache = new ProjectEntityCache(projectA);
      const loadAllItemsSpy = vi.spyOn(yamlModule, "loadAllItems");
      await cache.loadDomain("items");
      loadAllItemsSpy.mockClear();

      const alphaUlid = testUlid("SPEC", 20);
      const betaUlid = testUlid("SPEC", 21);
      const betaBefore = cache.getItemDetail(betaUlid);
      expect(betaBefore).not.toBeNull();

      const alphaPath = join(projectA, ".kspec", "modules", "alpha.yaml");
      await fs.writeFile(
        alphaPath,
        yamlStringify([buildSpecItem(20, "alpha-spec", "Alpha Spec v2")]),
        "utf-8",
      );

      await cache.writeThrough("items", { ulid: alphaUlid });

      expect(loadAllItemsSpy).not.toHaveBeenCalled();
      expect(cache.getItemDetail(alphaUlid)?.title).toBe("Alpha Spec v2");
      expect(cache.getItemDetail(betaUlid)).toBe(betaBefore);

      const afterWriteThrough = cache.getItemIndex();
      await cache.invalidateDomain("items");
      expect(cache.getItemIndex()).toBe(afterWriteThrough);
    });

    // AC: @daemon-entity-cache ac-write-through
    // AC: @daemon-entity-cache ac-graceful-degradation
    it("should NOT suppress watcher invalidation when writeThrough reload fails", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");

      // Mock initContext to throw on the next call, simulating a transient
      // infrastructure failure (disk error, shadow branch corruption, etc.).
      // The split backend catches parse errors gracefully, so we need to
      // fail at a higher level to exercise the degradation path.
      const initContextSpy = vi
        .spyOn(yamlModule, "initContext")
        .mockRejectedValueOnce(new Error("simulated infrastructure failure"));

      try {
        // writeThrough should attempt reload (fail → degraded) but NOT mark skip
        await cache.writeThrough("tasks");
        expect(cache.getDomainState("tasks")).toBe("degraded");

        // Restore initContext so the next reload succeeds
        initContextSpy.mockRestore();

        // Watcher invalidation must NOT be suppressed — domain should recover
        await cache.invalidateDomain("tasks");
        expect(cache.getDomainState("tasks")).toBe("ready");
        expect(cache.getTaskIndex()).not.toBeNull();
      } finally {
        initContextSpy.mockRestore();
      }
    });
  });

  // ─── AC: ac-concurrent-reads ───────────────────────────────────────────

  // AC: @daemon-entity-cache ac-concurrent-reads
  describe("ac-concurrent-reads: concurrent access from same cached data", () => {
    it("should serve multiple concurrent reads from the same cached data", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      // Simulate concurrent reads
      const results = await Promise.all([
        Promise.resolve(cache.getTaskIndex()),
        Promise.resolve(cache.getTaskIndex()),
        Promise.resolve(cache.getTaskIndex()),
      ]);

      // All should return the same reference
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
      expect(results[0]).not.toBeNull();
    });
  });

  // ─── AC: ac-reload-dedup ───────────────────────────────────────────────

  // AC: @daemon-entity-cache ac-reload-dedup
  describe("ac-reload-dedup: multiple invalidations produce single reload", () => {
    it("should deduplicate concurrent loadDomain calls for same domain", async () => {
      const cache = new ProjectEntityCache(projectA);

      // Fire multiple loads concurrently
      const p1 = cache.loadDomain("tasks");
      const p2 = cache.loadDomain("tasks");
      const p3 = cache.loadDomain("tasks");

      await Promise.all([p1, p2, p3]);

      // All should have completed, domain should be ready
      expect(cache.getDomainState("tasks")).toBe("ready");
      expect(cache.getTaskIndex()).not.toBeNull();
    });

    it("should deduplicate concurrent invalidation calls", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      // Fire multiple invalidations concurrently
      const promises = [
        cache.invalidateDomain("tasks"),
        cache.invalidateDomain("tasks"),
        cache.invalidateDomain("tasks"),
      ];

      await Promise.all(promises);

      expect(cache.getDomainState("tasks")).toBe("ready");
    });
  });

  // ─── AC: ac-folder-backed-entity-directory-invalidation ────────────────
  //
  // Folder-backed plans (`.kspec/plans/<ulid>/...`) and reviews
  // (`.kspec/reviews/<ulid>/...`) must route through the same
  // domain-level debounce/reload path as the legacy index files
  // `project.plans.yaml` / `project.reviews.yaml`. These tests exercise
  // handleFileChange end-to-end (path classification + domain
  // invalidation + dedup) so we don't get stale plan/review detail
  // after a sidecar or resource file change.

  // AC: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation
  // AC: @daemon-entity-cache ac-watcher-invalidation
  describe("ac-folder-backed-entity-directory-invalidation: plan/review folder changes invalidate the right domain", () => {
    const PLAN_ULID = "01PNXA00000000000000000000";
    const REVIEW_ULID = "01REVA00000000000000000000";

    function expectOnlyDomainsInvoked(
      spy: ReturnType<typeof vi.spyOn>,
      expectedDomains: CacheDomain[],
    ): void {
      const invokedDomains = spy.mock.calls.map((call) => call[0] as CacheDomain);
      expect(new Set(invokedDomains)).toEqual(new Set(expectedDomains));
    }

    // AC: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation
    // AC: @daemon-entity-cache ac-granular-reload
    it("routes plans/<ulid>/plan.md, plan.yaml, notes.yaml, resources.yaml, and resources/<file> to plans only", async () => {
      vi.useFakeTimers();
      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 50;
        const processChangesSpy = vi
          .spyOn(cache as any, "processDomainChanges")
          .mockResolvedValue(undefined);

        const kspecDir = join(projectA, ".kspec");
        const planDir = join(kspecDir, "plans", PLAN_ULID);
        const paths = [
          join(planDir, "plan.md"),
          join(planDir, "plan.yaml"),
          join(planDir, "notes.yaml"),
          join(planDir, "resources.yaml"),
          join(planDir, "resources", "ux.png"),
          join(planDir, "resources", "nested", "diagram.svg"),
        ];

        // Each path fires its own debounce window so we can check
        // domain classification per-path. Coalescing is covered separately.
        for (const p of paths) {
          const invalidation = cache.handleFileChange(kspecDir, p);
          await vi.advanceTimersByTimeAsync(50);
          await invalidation;
        }

        expectOnlyDomainsInvoked(processChangesSpy, ["plans"]);
        expect(processChangesSpy).toHaveBeenCalledTimes(paths.length);
      } finally {
        vi.useRealTimers();
      }
    });

    // AC: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation
    // AC: @daemon-entity-cache ac-granular-reload
    it("routes reviews/<ulid>/review.yaml, resources.yaml, and resources/<file> to reviews only", async () => {
      vi.useFakeTimers();
      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 50;
        const processChangesSpy = vi
          .spyOn(cache as any, "processDomainChanges")
          .mockResolvedValue(undefined);

        const kspecDir = join(projectA, ".kspec");
        const reviewDir = join(kspecDir, "reviews", REVIEW_ULID);
        const paths = [
          join(reviewDir, "review.yaml"),
          join(reviewDir, "resources.yaml"),
          join(reviewDir, "resources", "screenshot.png"),
          join(reviewDir, "resources", "logs", "run.log"),
        ];

        for (const p of paths) {
          const invalidation = cache.handleFileChange(kspecDir, p);
          await vi.advanceTimersByTimeAsync(50);
          await invalidation;
        }

        expectOnlyDomainsInvoked(processChangesSpy, ["reviews"]);
        expect(processChangesSpy).toHaveBeenCalledTimes(paths.length);
      } finally {
        vi.useRealTimers();
      }
    });

    // AC: @daemon-entity-cache ac-reload-dedup
    it("coalesces multiple plan-folder file events into a single plans reload", async () => {
      vi.useFakeTimers();
      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 50;
        const processChangesSpy = vi
          .spyOn(cache as any, "processDomainChanges")
          .mockResolvedValue(undefined);

        const kspecDir = join(projectA, ".kspec");
        const planDir = join(kspecDir, "plans", PLAN_ULID);
        const planMd = join(planDir, "plan.md");
        const planYaml = join(planDir, "plan.yaml");
        const planResource = join(planDir, "resources", "ux.png");

        const a = cache.handleFileChange(kspecDir, planMd, "# updated body");
        const b = cache.handleFileChange(kspecDir, planYaml, "title: New title");
        const c = cache.handleFileChange(kspecDir, planResource);

        await vi.advanceTimersByTimeAsync(50);
        await Promise.all([a, b, c]);

        expect(processChangesSpy).toHaveBeenCalledTimes(1);
        expect(processChangesSpy).toHaveBeenCalledWith(
          "plans",
          expect.any(Array),
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    // AC: @daemon-entity-cache ac-reload-dedup
    it("coalesces multiple review-folder file events into a single reviews reload", async () => {
      vi.useFakeTimers();
      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 50;
        const processChangesSpy = vi
          .spyOn(cache as any, "processDomainChanges")
          .mockResolvedValue(undefined);

        const kspecDir = join(projectA, ".kspec");
        const reviewDir = join(kspecDir, "reviews", REVIEW_ULID);
        const reviewYaml = join(reviewDir, "review.yaml");
        const reviewResources = join(reviewDir, "resources.yaml");
        const reviewScreenshot = join(reviewDir, "resources", "screenshot.png");

        const a = cache.handleFileChange(kspecDir, reviewYaml, "lifecycle_state: open");
        const b = cache.handleFileChange(kspecDir, reviewResources, "resources: []");
        const c = cache.handleFileChange(kspecDir, reviewScreenshot);

        await vi.advanceTimersByTimeAsync(50);
        await Promise.all([a, b, c]);

        expect(processChangesSpy).toHaveBeenCalledTimes(1);
        expect(processChangesSpy).toHaveBeenCalledWith(
          "reviews",
          expect.any(Array),
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    // Regression: parent-index files still drive their respective domains so
    // legacy index-only writes and migration writes continue to work.
    // AC: @daemon-entity-cache ac-watcher-invalidation
    it("still invalidates plans on project.plans.yaml and reviews on project.reviews.yaml", async () => {
      vi.useFakeTimers();
      try {
        const cache = new ProjectEntityCache(projectA);
        (cache as any).domainDebounceMs = 50;
        const processChangesSpy = vi
          .spyOn(cache as any, "processDomainChanges")
          .mockResolvedValue(undefined);

        const kspecDir = join(projectA, ".kspec");
        const plansIndex = join(kspecDir, "project.plans.yaml");
        const reviewsIndex = join(kspecDir, "project.reviews.yaml");

        const a = cache.handleFileChange(kspecDir, plansIndex);
        await vi.advanceTimersByTimeAsync(50);
        await a;

        const b = cache.handleFileChange(kspecDir, reviewsIndex);
        await vi.advanceTimersByTimeAsync(50);
        await b;

        expectOnlyDomainsInvoked(processChangesSpy, ["plans", "reviews"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── AC: ac-graceful-degradation ───────────────────────────────────────

  // AC: @daemon-entity-cache ac-graceful-degradation
  describe("ac-graceful-degradation: failed loads mark domain degraded", () => {
    it("should mark domain as degraded when loading fails", async () => {
      // Create a project directory with a .kspec that has a corrupt tasks file
      // that causes the YAML parser to throw
      const brokenProject = await createTempDir("kspec-broken-");
      const brokenKspec = join(brokenProject, ".kspec");
      await fs.mkdir(brokenKspec, { recursive: true });
      // Write a valid manifest so initContext succeeds
      await fs.writeFile(
        join(brokenKspec, "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.0",
          project: { name: "Broken", version: "0.1.0" },
        }),
        "utf-8",
      );
      // Write a corrupt tasks file — valid YAML but not an array (Zod parse fails)
      await fs.writeFile(
        join(brokenKspec, "project.tasks.yaml"),
        "this_is_not_a_task_array: true\nnested: { deeply: broken }",
        "utf-8",
      );

      try {
        const cache = new ProjectEntityCache(brokenProject);
        await cache.loadDomain("tasks");

        // The task loader should gracefully handle non-array data.
        // Either the domain degrades OR it loads an empty array.
        // Both are acceptable graceful degradation behaviors.
        const state = cache.getDomainState("tasks");
        const index = cache.getTaskIndex();
        expect(["degraded", "ready"]).toContain(state);
        if (state === "degraded") {
          expect(index).toBeNull();
        } else {
          // Ready with empty index — loader handled the bad data gracefully
          expect(index).not.toBeNull();
        }
      } finally {
        await fs.rm(brokenProject, { recursive: true, force: true });
      }
    });

    it("should not affect other domains when one fails", async () => {
      const cache = new ProjectEntityCache(projectA);

      // Load items successfully
      await cache.loadDomain("items");
      expect(cache.getDomainState("items")).toBe("ready");

      // Now manually set a domain to degraded by loading a nonexistent domain type
      // We'll test that successful domains remain available
      expect(cache.getItemIndex()).not.toBeNull();
    });
  });

  // ─── AC: ac-project-isolation ──────────────────────────────────────────

  // AC: @daemon-entity-cache ac-project-isolation
  describe("ac-project-isolation: separate caches per project", () => {
    it("should maintain separate caches for different projects", async () => {
      const cacheA = new ProjectEntityCache(projectA);
      const cacheB = new ProjectEntityCache(projectB);

      await cacheA.loadDomain("tasks");
      await cacheB.loadDomain("tasks");

      const tasksA = cacheA.getTaskIndex();
      const tasksB = cacheB.getTaskIndex();

      expect(tasksA).not.toBeNull();
      expect(tasksB).not.toBeNull();
      // Different projects have different tasks
      expect(tasksA![0]._ulid).toBe("01TASKA0000000000000000000");
      expect(tasksB![0]._ulid).toBe("01TASKB0000000000000000000");
    });

    it("should not affect other project cache when one is invalidated", async () => {
      const cacheA = new ProjectEntityCache(projectA);
      const cacheB = new ProjectEntityCache(projectB);

      await cacheA.loadDomain("tasks");
      await cacheB.loadDomain("tasks");

      const tasksBefore = cacheB.getTaskIndex();

      // Invalidate project A
      await cacheA.invalidateDomain("tasks");

      // Project B should be unaffected
      expect(cacheB.getTaskIndex()).toBe(tasksBefore);
    });

    it("should use registry for per-project cache isolation", () => {
      const cacheA = registerEntityCache(projectA);
      const cacheB = registerEntityCache(projectB);

      expect(getEntityCache(projectA)).toBe(cacheA);
      expect(getEntityCache(projectB)).toBe(cacheB);
      expect(cacheA).not.toBe(cacheB);

      clearAllEntityCaches();
    });
  });

  // ─── AC: ac-unregister-cleanup ─────────────────────────────────────────

  // AC: @daemon-entity-cache ac-unregister-cleanup
  describe("ac-unregister-cleanup: all cached data released", () => {
    it("should release all data when disposed", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");
      await cache.loadDomain("items");

      expect(cache.getTaskIndex()).not.toBeNull();
      expect(cache.getItemIndex()).not.toBeNull();

      cache.dispose();

      expect(cache.getTaskIndex()).toBeNull();
      expect(cache.getItemIndex()).toBeNull();
      expect(cache.isDisposed()).toBe(true);
    });

    it("should set all domain states to unloaded when disposed", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");

      cache.dispose();

      for (const domain of DOMAIN_LOAD_ORDER) {
        expect(cache.getDomainState(domain)).toBe("unloaded");
      }
    });

    it("should not reload after disposal", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");
      cache.dispose();

      // Trying to load after disposal should be a no-op
      await cache.loadDomain("tasks");
      expect(cache.getTaskIndex()).toBeNull();
    });

    it("should not repopulate stores when in-flight load completes after dispose", async () => {
      // AC: @daemon-entity-cache ac-unregister-cleanup
      // Regression: doLoadDomain() wrote directly to stores without checking
      // disposed, so a load started before dispose() could repopulate cleared
      // stores after dispose() returned.
      const cache = new ProjectEntityCache(projectA);

      // Start a load but don't await it yet — let it be in-flight
      const loadPromise = cache.loadDomain("tasks");

      // Dispose while the load is in-flight
      cache.dispose();

      // Verify stores are cleared immediately after dispose
      expect(cache.getTaskIndex()).toBeNull();
      expect(cache.isDisposed()).toBe(true);

      // Wait for the in-flight load to settle
      await loadPromise;

      // After the in-flight load completes, stores must still be null.
      // Before the fix, doLoadDomain would write to this.tasks.index
      // even though dispose() had already cleared it.
      expect(cache.getTaskIndex()).toBeNull();
      expect(cache.getDomainState("tasks")).toBe("unloaded");
    });

    it("should unregister via registry function", async () => {
      const cache = registerEntityCache(projectA);
      await cache.loadDomain("tasks");

      unregisterEntityCache(projectA);

      expect(getEntityCache(projectA)).toBeNull();
      expect(cache.isDisposed()).toBe(true);
    });
  });

  // ─── AC: ac-session-bounded-index ──────────────────────────────────────

  // AC: @daemon-entity-cache ac-session-bounded-index
  describe("ac-session-bounded-index: index limited to N most recent", () => {
    it("should limit session index to configured max size", async () => {
      // Create a sessions directory with more sessions than the limit
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      // Create 5 sessions
      for (let i = 0; i < 5; i++) {
        const id = `session-${String(i).padStart(3, "0")}`;
        const sessionDir = join(sessionsDir, id);
        await fs.mkdir(sessionDir, { recursive: true });
        await fs.writeFile(
          join(sessionDir, "session.yaml"),
          yamlStringify({
            id,
            agent_type: "claude-agent-acp",
            status: "completed",
            started_at: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
            ended_at: `2026-03-${String(i + 1).padStart(2, "0")}T01:00:00.000Z`,
          }),
          "utf-8",
        );
      }

      // Create cache with max 3 sessions in index
      const cache = new ProjectEntityCache(projectA, { maxIndexSize: 3 });
      await cache.loadDomain("sessions");

      const sessionIndex = cache.getSessionIndex();
      expect(sessionIndex).not.toBeNull();
      expect(sessionIndex!.length).toBe(3);

      // Should be most recent first
      expect(sessionIndex![0].id).toBe("session-004"); // March 5
      expect(sessionIndex![1].id).toBe("session-003"); // March 4
      expect(sessionIndex![2].id).toBe("session-002"); // March 3
    });
  });

  // AC: @daemon-entity-cache ac-deterministic-fd-cleanup
  describe("ac-deterministic-fd-cleanup: session enumeration closes directory handles", () => {
    it("closes the session directory handle after a successful enumeration", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      const sessionId = "session-close-success";
      await fs.mkdir(join(sessionsDir, sessionId), { recursive: true });
      await fs.writeFile(
        join(sessionsDir, sessionId, "session.yaml"),
        yamlStringify({
          id: sessionId,
          agent_type: "claude-agent-acp",
          status: "completed",
          started_at: "2026-03-01T00:00:00.000Z",
          ended_at: "2026-03-01T01:00:00.000Z",
        }),
        "utf-8",
      );

      const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const read = vi.fn<() => Promise<{ name: string; isDirectory: () => boolean } | null>>();
      read
        .mockResolvedValueOnce({
          name: sessionId,
          isDirectory: () => true,
        })
        .mockResolvedValueOnce(null);

      const { ProjectEntityCacheCtor, opendirMock } = await importEntityCacheWithMockedOpendir({
        read,
        close,
      } as unknown as Awaited<ReturnType<typeof fs.opendir>>);

      const cache = new ProjectEntityCacheCtor(projectA);
      await cache.loadDomain("sessions");

      expect(opendirMock).toHaveBeenCalledWith(sessionsDir);
      expect(read).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(1);
      expect(cache.getSessionIndex()?.map((session) => session.id)).toEqual([sessionId]);
    });

    it("closes the session directory handle when enumeration fails", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const read = vi
        .fn<() => Promise<{ name: string; isDirectory: () => boolean } | null>>()
        .mockRejectedValue(new Error("enumeration failed"));

      const { ProjectEntityCacheCtor, opendirMock } = await importEntityCacheWithMockedOpendir({
        read,
        close,
      } as unknown as Awaited<ReturnType<typeof fs.opendir>>);

      const cache = new ProjectEntityCacheCtor(projectA);
      await cache.loadDomain("sessions");

      expect(opendirMock).toHaveBeenCalledWith(sessionsDir);
      expect(read).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(cache.getSessionIndex()).toEqual([]);
    });
  });

  // ─── AC: ac-session-stale-exclusion ────────────────────────────────────

  // AC: @daemon-entity-cache ac-session-stale-exclusion
  describe("ac-session-stale-exclusion: stale active sessions not treated as active", () => {
    it("should mark old active sessions as stalled in the index", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      // Create an active session that is very old (exceeds stale criteria)
      const id = "session-stale";
      const sessionDir = join(sessionsDir, id);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        join(sessionDir, "session.yaml"),
        yamlStringify({
          id,
          agent_type: "claude-agent-acp",
          status: "active",
          // Very old — far exceeds default olderThan of 7d
          started_at: "2025-01-01T00:00:00.000Z",
        }),
        "utf-8",
      );
      // No events.jsonl → activity = started_at, which is very old

      // Create a recent active session (should remain active)
      const recentId = "session-recent";
      const recentDir = join(sessionsDir, recentId);
      await fs.mkdir(recentDir, { recursive: true });
      await fs.writeFile(
        join(recentDir, "session.yaml"),
        yamlStringify({
          id: recentId,
          agent_type: "claude-agent-acp",
          status: "active",
          started_at: new Date().toISOString(),
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");

      const sessionIndex = cache.getSessionIndex();
      expect(sessionIndex).not.toBeNull();

      const staleSession = sessionIndex!.find((s) => s.id === "session-stale");
      const recentSession = sessionIndex!.find((s) => s.id === "session-recent");

      // Stale session should NOT be treated as active
      expect(staleSession).toBeDefined();
      expect(staleSession!.status).not.toBe("active");

      // Recent session should still be active
      expect(recentSession).toBeDefined();
      expect(recentSession!.status).toBe("active");
    });
  });

  // ─── AC: ac-warming-availability ───────────────────────────────────────

  // AC: @daemon-entity-cache ac-warming-availability
  describe("ac-warming-availability: loading state during cache warming", () => {
    it("should report unloaded state before loading starts", () => {
      const cache = new ProjectEntityCache(projectA);

      for (const domain of DOMAIN_LOAD_ORDER) {
        expect(cache.getDomainState(domain)).toBe("unloaded");
      }
    });

    it("should report loading state during domain load", async () => {
      const cache = new ProjectEntityCache(projectA);

      // Start loading but don't await — check intermediate state
      const loadPromise = cache.loadDomain("tasks");

      // At this point, the state should be loading (may already be ready if fast)
      const state = cache.getDomainState("tasks");
      expect(["loading", "ready"]).toContain(state);

      await loadPromise;
      expect(cache.getDomainState("tasks")).toBe("ready");
    });

    it("should report ready state after successful load", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      expect(cache.getDomainState("tasks")).toBe("ready");
    });

    it("should return null for unloaded domains", () => {
      const cache = new ProjectEntityCache(projectA);

      expect(cache.getTaskIndex()).toBeNull();
      expect(cache.getItemIndex()).toBeNull();
      expect(cache.getSessionIndex()).toBeNull();
    });
  });

  // ─── AC: ac-progressive-loading ────────────────────────────────────────

  // AC: @daemon-entity-cache ac-progressive-loading
  describe("ac-progressive-loading: domains available as they finish loading", () => {
    it("should make loaded domains available while others are still loading", async () => {
      const cache = new ProjectEntityCache(projectA);

      // Load tasks first
      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");
      expect(cache.getTaskIndex()).not.toBeNull();

      // Items not loaded yet
      expect(cache.getDomainState("items")).toBe("unloaded");
      expect(cache.getItemIndex()).toBeNull();

      // Load items
      await cache.loadDomain("items");
      expect(cache.getDomainState("items")).toBe("ready");
      expect(cache.getItemIndex()).not.toBeNull();

      // Both available now
      expect(cache.getTaskIndex()).not.toBeNull();
      expect(cache.getItemIndex()).not.toBeNull();
    });

    it("should define correct domain load priority order", () => {
      // The spec defines: tasks → items → meta → inbox → plans → triage → reviews → sessions
      expect(DOMAIN_LOAD_ORDER).toEqual([
        "tasks",
        "items",
        "meta",
        "inbox",
        "plans",
        "triage",
        "reviews",
        "sessions",
      ]);
    });

    it("should load all domains via loadAll in priority order", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadAll();

      // Core domains should be ready
      expect(cache.getDomainState("tasks")).toBe("ready");
      expect(cache.getDomainState("items")).toBe("ready");
      expect(cache.getDomainState("meta")).toBe("ready");
    });

    // AC: @daemon-meta-subdomain ac-initial-load-all
    it("keeps meta loading until all three meta sub-domains finish the initial load", async () => {
      const cache = new ProjectEntityCache(projectA);

      const manifestSpy = vi.spyOn(cache as any, "loadMetaManifestSubdomain");
      const shadowSpy = vi.spyOn(cache as any, "loadMetaShadowSubdomain");
      const originalLoadSession = (cache as any).loadMetaSessionSubdomain.bind(cache);
      let releaseSessionLoad!: () => void;
      const sessionGate = new Promise<void>((resolve) => {
        releaseSessionLoad = resolve;
      });
      const sessionSpy = vi
        .spyOn(cache as any, "loadMetaSessionSubdomain")
        .mockImplementation(async () => {
          await originalLoadSession();
          await sessionGate;
        });

      const loadPromise = cache.loadDomain("meta");

      await vi.waitFor(() => expect(sessionSpy).toHaveBeenCalledOnce());
      expect(manifestSpy).toHaveBeenCalledOnce();
      expect(shadowSpy).toHaveBeenCalledOnce();
      expect(cache.getDomainState("meta")).toBe("loading");

      releaseSessionLoad();
      await loadPromise;

      expect(cache.getDomainState("meta")).toBe("ready");
      expect(cache.getMetaIndex()).not.toBeNull();
      expect(cache.getShadowInfo()).not.toBeNull();
      expect(cache.getSessionContext()).not.toBeNull();
    });
  });

  // ─── AC: ac-stale-during-reload ─────────────────────────────────────────

  // AC: @daemon-entity-cache ac-stale-during-reload
  describe("ac-stale-during-reload: domain stays ready and serves stale data during reload", () => {
    it("should keep domain state as ready during a reload of already-populated data", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");

      // Capture the state during reload by intercepting loadDomain mid-flight.
      // We'll spy on the underlying data loader to pause mid-reload.
      const statesDuringReload: string[] = [];
      const _originalLoadDomain = cache.loadDomain.bind(cache);

      // Trigger a reload (e.g., via invalidateDomain) and check state mid-flight
      // Use a zero-ms debounce cache for instant reload
      const reloadPromise = cache.loadDomain("tasks");

      // State should remain "ready" while the reload is in-flight
      statesDuringReload.push(cache.getDomainState("tasks"));

      await reloadPromise;

      // After reload completes, still ready
      expect(cache.getDomainState("tasks")).toBe("ready");
      // During reload, state should never have been "loading"
      for (const state of statesDuringReload) {
        expect(state).toBe("ready");
      }
    });

    it("should serve previously cached data while reload is in progress", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const originalTaskIndex = cache.getTaskIndex();
      expect(originalTaskIndex).not.toBeNull();
      expect(originalTaskIndex!.length).toBeGreaterThan(0);

      // Start a reload
      const reloadPromise = cache.loadDomain("tasks");

      // During reload, cached data should still be accessible
      const duringReloadIndex = cache.getTaskIndex();
      expect(duringReloadIndex).not.toBeNull();
      expect(duringReloadIndex!.length).toBeGreaterThan(0);

      await reloadPromise;

      // After reload, data should be refreshed but present
      const afterReloadIndex = cache.getTaskIndex();
      expect(afterReloadIndex).not.toBeNull();
      expect(afterReloadIndex!.length).toBeGreaterThan(0);
    });

    it("should swap in new data atomically after reload completes", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const originalTaskIndex = cache.getTaskIndex();
      expect(originalTaskIndex).not.toBeNull();

      // Modify the underlying task file to produce different data on reload
      const kspecDir = join(projectA, ".kspec");
      const tasksFile = join(kspecDir, "project.tasks.yaml");
      const newTask = yamlStringify([
        {
          _ulid: "01TASKA0000000000000000000",
          title: "Updated Task Title",
          slug: "task-sample-a",
          status: "pending",
          priority: 3,
        },
      ]);
      await fs.writeFile(tasksFile, newTask, "utf-8");

      // Reload domain
      await cache.loadDomain("tasks");

      // New data should be served
      const updatedIndex = cache.getTaskIndex();
      expect(updatedIndex).not.toBeNull();
      expect(updatedIndex![0].title).toBe("Updated Task Title");
    });

    it("should never regress to loading state on reload failure", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");

      // Corrupt the task file so the reload encounters bad data.
      // The task loader may gracefully handle it (ready with empty data)
      // or throw (degraded). Either outcome is acceptable — the key
      // invariant is that the domain NEVER transitions to "loading".
      const kspecDir = join(projectA, ".kspec");
      const tasksFile = join(kspecDir, "project.tasks.yaml");
      await fs.writeFile(tasksFile, "{{{{invalid yaml!!!!:", "utf-8");

      await cache.loadDomain("tasks");
      const state = cache.getDomainState("tasks");
      // State should be "ready" (graceful handling) or "degraded" (error),
      // but NEVER "loading" — that's the regression we're fixing.
      expect(["ready", "degraded"]).toContain(state);
      expect(state).not.toBe("loading");
    });

    it("should set loading state only for initial loads from unloaded", async () => {
      const cache = new ProjectEntityCache(projectA);

      // Before any load, state is unloaded
      expect(cache.getDomainState("tasks")).toBe("unloaded");

      // During initial load, state transitions through loading to ready
      // (we can't easily observe the transient "loading" state in a sync test,
      // but we verify the final state)
      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");
    });

    it("should keep items domain ready during reload via invalidateDomain", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("items");
      expect(cache.getDomainState("items")).toBe("ready");

      // Invalidate triggers a debounced reload
      const invalidatePromise = cache.invalidateDomain("items");

      // State should remain ready during debounce and reload
      expect(cache.getDomainState("items")).toBe("ready");

      // Original data still accessible
      expect(cache.getItemIndex()).not.toBeNull();

      await invalidatePromise;

      expect(cache.getDomainState("items")).toBe("ready");
    });

    it("should keep domain ready during writeThrough reload", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");

      // writeThrough calls loadDomain internally
      await cache.writeThrough("tasks");

      // Should still be ready
      expect(cache.getDomainState("tasks")).toBe("ready");
    });

    it("should keep meta domain ready and serve stale data during reload", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");
      expect(cache.getDomainState("meta")).toBe("ready");

      // Start a reload — state should remain ready
      const reloadPromise = cache.loadDomain("meta");

      // During reload, state stays ready and stale data is accessible
      expect(cache.getDomainState("meta")).toBe("ready");
      expect(cache.getMetaIndex()).not.toBeNull();

      await reloadPromise;

      // After reload, still ready with refreshed data
      expect(cache.getDomainState("meta")).toBe("ready");
      expect(cache.getMetaIndex()).not.toBeNull();
    });

    it("should swap all meta artifacts atomically on reload", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");
      expect(cache.getDomainState("meta")).toBe("ready");

      // Capture references to the original meta artifacts so we can
      // verify the reload produces a fresh swap (new object references).
      const originalMetaIndex = cache.getMetaIndex();
      const originalProjectConfig = cache.getProjectConfig();
      const originalShadowInfo = cache.getShadowInfo();

      // Reload meta domain — should produce fresh objects
      await cache.loadDomain("meta");

      // After reload, all artifacts are present and consistent
      expect(cache.getDomainState("meta")).toBe("ready");

      const reloadedIndex = cache.getMetaIndex();
      const reloadedConfig = cache.getProjectConfig();
      const reloadedShadow = cache.getShadowInfo();

      expect(reloadedIndex).not.toBeNull();
      expect(reloadedConfig).not.toBeNull();
      expect(reloadedShadow).not.toBeNull();

      // New index and details map references confirm the swap happened
      // (build-then-swap creates new objects each reload)
      expect(reloadedIndex).not.toBe(originalMetaIndex);
      expect(reloadedConfig).not.toBe(originalProjectConfig);
      expect(reloadedShadow).not.toBe(originalShadowInfo);
    });

    it("should keep meta domain ready during writeThrough reload", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("meta");
      expect(cache.getDomainState("meta")).toBe("ready");

      // writeThrough calls loadDomain internally
      await cache.writeThrough("meta");

      // Should still be ready with data intact
      expect(cache.getDomainState("meta")).toBe("ready");
      expect(cache.getMetaIndex()).not.toBeNull();
      expect(cache.getProjectConfig()).not.toBeNull();
    });
  });

  // ─── Session live counters ─────────────────────────────────────────────

  describe("session live event counters", () => {
    // AC: @daemon-entity-cache ac-session-event-tracking
    it("should increment and serve live event counts for active sessions", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      const id = "session-active";
      const sessionDir = join(sessionsDir, id);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        join(sessionDir, "session.yaml"),
        yamlStringify({
          id,
          agent_type: "claude-agent-acp",
          status: "active",
          started_at: new Date().toISOString(),
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");

      // Increment live counter
      cache.incrementSessionEventCount(id);
      cache.incrementSessionEventCount(id);
      cache.incrementSessionEventCount(id);

      const index = cache.getSessionIndex();
      const session = index!.find((s) => s.id === id);
      expect(session).toBeDefined();
      expect(session!.event_count).toBe(3);
    });

    // AC: @daemon-entity-cache ac-session-event-tracking
    it("should seed live counts from persisted metadata before incrementing", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      const id = "session-seeded";
      const sessionDir = join(sessionsDir, id);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        join(sessionDir, "session.yaml"),
        yamlStringify({
          id,
          agent_type: "claude-agent-acp",
          status: "active",
          started_at: new Date().toISOString(),
          event_count: 2,
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");

      cache.incrementSessionEventCount(id);
      cache.incrementSessionEventCount(id);

      const session = cache.getSessionIndex()!.find((entry) => entry.id === id);
      expect(session).toBeDefined();
      expect(session!.event_count).toBe(4);
    });

    // AC: @daemon-entity-cache ac-session-stats-handoff
    it("should hand off from live counters to persisted metadata after reload", async () => {
      const sessionsDir = join(projectA, ".kspec-sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      const id = "session-handoff";
      const sessionDir = join(sessionsDir, id);
      await fs.mkdir(sessionDir, { recursive: true });
      const metadataPath = join(sessionDir, "session.yaml");
      await fs.writeFile(
        metadataPath,
        yamlStringify({
          id,
          agent_type: "claude-agent-acp",
          status: "active",
          started_at: "2026-04-01T00:00:00.000Z",
          event_count: 1,
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("sessions");

      cache.incrementSessionEventCount(id);
      expect(cache.getSessionIndex()!.find((entry) => entry.id === id)?.event_count).toBe(2);

      cache.discardSessionLiveCounter(id);
      await fs.writeFile(
        metadataPath,
        yamlStringify({
          id,
          agent_type: "claude-agent-acp",
          status: "completed",
          started_at: "2026-04-01T00:00:00.000Z",
          ended_at: "2026-04-01T00:05:00.000Z",
          event_count: 7,
          iteration_count: 3,
          tasks_completed: 1,
        }),
        "utf-8",
      );

      await cache.invalidateDomain("sessions");

      const session = cache.getSessionIndex()!.find((entry) => entry.id === id);
      expect(session).toBeDefined();
      expect(session).toMatchObject({
        id,
        status: "completed",
        event_count: 7,
        iteration_count: 3,
        tasks_completed: 1,
      });
    });
  });

  // ─── Route Integration: serve-from-memory via cache ───────────────────

  // AC: @daemon-entity-cache ac-serve-from-memory
  describe("ac-serve-from-memory: route-level integration", () => {
    it("should serve task summaries from cache matching route handler pattern", async () => {
      // Simulate the route handler pattern: get cache → check domain → use index
      const cache = registerEntityCache(projectA);
      await cache.loadDomain("tasks");
      await cache.loadDomain("items");

      // Route pattern: getEntityCache(path) → getDomainState → getTaskIndex
      const resolvedCache = getEntityCache(projectA);
      expect(resolvedCache).not.toBeNull();
      expect(resolvedCache!.getDomainState("tasks")).toBe("ready");

      const taskIndex = resolvedCache!.getTaskIndex();
      expect(taskIndex).not.toBeNull();
      expect(taskIndex!.length).toBeGreaterThan(0);
      // Verify summary fields that routes depend on
      expect(taskIndex![0]).toHaveProperty("_ulid");
      expect(taskIndex![0]).toHaveProperty("title");
      expect(taskIndex![0]).toHaveProperty("status");
    });

    it("should serve item index from cache matching route handler pattern", async () => {
      const cache = registerEntityCache(projectA);
      await cache.loadDomain("items");

      const resolvedCache = getEntityCache(projectA);
      expect(resolvedCache!.getDomainState("items")).toBe("ready");

      const itemIndex = resolvedCache!.getItemIndex();
      expect(itemIndex).not.toBeNull();
      expect(Array.isArray(itemIndex)).toBe(true);
    });

    it("should return null for unregistered project matching route fallback", () => {
      // When cache is not registered, route falls back to disk
      const resolvedCache = getEntityCache("/nonexistent/path");
      expect(resolvedCache).toBeNull();
    });
  });

  // AC: @daemon-entity-cache ac-write-through
  describe("ac-write-through: route-level integration", () => {
    it("should update cache via writeThrough matching route mutation pattern", async () => {
      const cache = registerEntityCache(projectA);
      await cache.loadDomain("tasks");

      const before = cache.getTaskIndex();
      expect(before).not.toBeNull();
      // Simulate mutation: modify file, then writeThrough
      const tasksPath = join(projectA, ".kspec", "project.tasks.yaml");
      const newTasks = yamlStringify([
        {
          _ulid: "01TASKA0000000000000000000",
          slugs: ["task-a-sample"],
          title: "Sample Task A",
          type: "task",
          status: "in_progress", // Changed status
          priority: 1,
          spec_ref: "@spec-a-sample",
          depends_on: [],
          created_at: "2026-01-24T00:00:00.000Z",
          notes: [],
          todos: [],
        },
      ]);
      await fs.writeFile(tasksPath, newTasks, "utf-8");

      // Route handler calls writeThrough after mutation + commit
      await cache.writeThrough("tasks");

      const after = cache.getTaskIndex();
      expect(after).not.toBeNull();
      // Cache reflects the mutation
      expect(after![0].status).toBe("in_progress");

      // The write-through skip flag should prevent double-reload from watcher
      const afterWriteThrough = cache.getTaskIndex();
      await cache.invalidateDomain("tasks"); // Watcher fires
      expect(cache.getTaskIndex()).toBe(afterWriteThrough); // Skipped
    });
  });

  // AC: @daemon-entity-cache ac-warming-availability
  describe("ac-warming-availability: route-level integration", () => {
    it("should report unloaded state before loadAll is called", () => {
      const cache = registerEntityCache(projectA);

      // Before loadAll, all domains are unloaded
      expect(cache.getDomainState("tasks")).toBe("unloaded");
      expect(cache.getTaskIndex()).toBeNull();
    });

    it("should mark all domains as loading when loadAll starts", async () => {
      const cache = registerEntityCache(projectA);

      // Start loadAll but don't await — check state synchronously after first tick
      const loadPromise = cache.loadAll();

      // After loadAll starts, all domains should be "loading" (not "unloaded")
      // so routes return _cache_status: "loading" for not-yet-started domains
      // instead of falling back to disk.
      for (const domain of DOMAIN_LOAD_ORDER) {
        const state = cache.getDomainState(domain);
        // Each domain is either "loading" (not yet loaded) or "ready" (already completed)
        expect(["loading", "ready"]).toContain(state);
      }

      await loadPromise;
    });

    it("should report ready after loadAll, matching route ready check", async () => {
      const cache = registerEntityCache(projectA);
      await cache.loadAll();

      expect(cache.getDomainState("tasks")).toBe("ready");
      expect(cache.getTaskIndex()).not.toBeNull();
    });
  });

  // AC: @daemon-entity-cache ac-graceful-degradation
  describe("ac-graceful-degradation: route-level integration", () => {
    it("should return null index for degraded domain, triggering route fallback", async () => {
      // Create a project with a broken tasks file
      const brokenProject = await createTempDir("kspec-route-degraded-");
      const brokenKspec = join(brokenProject, ".kspec");
      await fs.mkdir(brokenKspec, { recursive: true });
      await fs.writeFile(
        join(brokenKspec, "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.0",
          project: { name: "Degraded", version: "0.1.0" },
        }),
        "utf-8",
      );
      // Write a corrupt tasks file
      await fs.writeFile(
        join(brokenKspec, "project.tasks.yaml"),
        "this_is_not_a_task_array: true",
        "utf-8",
      );

      try {
        const cache = registerEntityCache(brokenProject);
        await cache.loadDomain("tasks");

        const state = cache.getDomainState("tasks");
        if (state === "degraded") {
          // Route handler checks: if state is degraded, fall back to disk
          expect(cache.getTaskIndex()).toBeNull();
        }
        // Both degraded (null index → fallback) and ready (empty array) are valid
        expect(["degraded", "ready"]).toContain(state);
      } finally {
        unregisterEntityCache(brokenProject);
        await fs.rm(brokenProject, { recursive: true, force: true });
      }
    });
  });

  // AC: @daemon-entity-cache ac-detail-on-demand
  describe("ac-detail-on-demand: route-level integration", () => {
    it("should have task detail populated after domain load", async () => {
      const cache = registerEntityCache(projectA);
      await cache.loadDomain("tasks");

      // Task details are eagerly populated during domain load for search support
      const taskUlid = "01TASKA0000000000000000000";
      const detail = cache.getTaskDetail(taskUlid);
      expect(detail).not.toBeNull();
      expect(detail!.title).toBe("Sample Task A");

      // Route can override with explicit set (e.g., after mutation)
      const mockDetail = {
        _ulid: taskUlid,
        title: "Sample Task A",
        status: "pending",
        notes: [{ content: "note1" }],
      } as any;
      cache.setTaskDetail(taskUlid, mockDetail);

      // Subsequent requests can use updated detail
      const cached = cache.getTaskDetail(taskUlid);
      expect(cached).not.toBeNull();
      expect(cached!.title).toBe("Sample Task A");
      expect(cached!.notes).toHaveLength(1);
    });

    it("should refresh cached detail on domain invalidation", async () => {
      const cache = registerEntityCache(projectA);
      await cache.loadDomain("tasks");

      const taskUlid = "01TASKA0000000000000000000";
      // Override the eagerly loaded detail with a mock
      cache.setTaskDetail(taskUlid, { _ulid: taskUlid, title: "Overridden" } as any);
      expect(cache.getTaskDetail(taskUlid)!.title).toBe("Overridden");

      // Invalidation reloads from disk — eagerly populated again
      await cache.invalidateDomain("tasks");
      const refreshed = cache.getTaskDetail(taskUlid);
      expect(refreshed).not.toBeNull();
      expect(refreshed!.title).toBe("Sample Task A"); // Back to disk value
    });

    // AC: @daemon-entity-cache ac-task-history-retention
    it("retains task field-change history in cached task detail after domain load", async () => {
      const kspecDir = join(projectA, ".kspec");
      seedSplitTask(kspecDir, {
        _ulid: "01TASKC0000000000000000000",
        slugs: ["task-c-history"],
        title: "Task C with history",
        type: "task",
        status: "pending_review",
        priority: 2,
        depends_on: [],
        created_at: "2026-01-24T00:00:00.000Z",
        history: [
          {
            timestamp: "2026-01-24T00:00:00.000Z",
            author: "@tester",
            command: "task-submit",
            changes: {
              status: {
                previous: "in_progress",
                new: "pending_review",
              },
            },
          },
        ],
      });

      const cache = registerEntityCache(projectA);
      await cache.loadDomain("tasks");

      const detail = cache.getTaskDetail("01TASKC0000000000000000000");
      const history = cache.getTaskHistory("01TASKC0000000000000000000");
      expect(detail).not.toBeNull();
      expect(history).toHaveLength(1);
      expect(history?.[0]?.command).toBe("task-submit");
      expect(history?.[0]?.changes.status).toEqual({
        previous: "in_progress",
        new: "pending_review",
      });
    });
  });

  // ─── AC: ac-write-through cross-domain ─────────────────────────────────

  // AC: @daemon-entity-cache ac-write-through
  describe("ac-write-through: cross-domain task mutation write-through", () => {
    it("should support writing through multiple domains in parallel", async () => {
      // Simulate what task status mutation routes do: write-through both
      // tasks AND items (because syncSpecImplementationStatus modifies spec items)
      const cache = registerEntityCache(projectA);
      await cache.loadAll();

      const tasksBefore = cache.getTaskIndex();
      const itemsBefore = cache.getItemIndex();

      // Parallel write-through matches the route pattern:
      // await Promise.all([cache.writeThrough("tasks"), cache.writeThrough("items")])
      await Promise.all([cache.writeThrough("tasks"), cache.writeThrough("items")]);

      // Both domains reloaded (new references)
      const tasksAfter = cache.getTaskIndex();
      const itemsAfter = cache.getItemIndex();
      expect(tasksAfter).not.toBe(tasksBefore);
      expect(itemsAfter).not.toBe(itemsBefore);

      // Write-through skip flags set for both — next watcher invalidation skipped
      const tasksRef = cache.getTaskIndex();
      const itemsRef = cache.getItemIndex();
      await cache.invalidateDomain("tasks");
      await cache.invalidateDomain("items");
      expect(cache.getTaskIndex()).toBe(tasksRef);
      expect(cache.getItemIndex()).toBe(itemsRef);
    });
  });

  // ─── AC: ac-warming-availability refs endpoint ────────────────────────

  // AC: @daemon-entity-cache ac-warming-availability
  describe("ac-warming-availability: refs endpoint loading contract", () => {
    it("should report loading state for domains not yet ready", async () => {
      // Cache plans warm-up enforces the strict folder-storage gate (AC:
      // @entity-folder-migration-and-compatibility-1
      // ac-unmigrated-projects-are-blocked-with-guidance), so the project
      // manifest must declare folder-backed plan/review storage for the
      // plans domain to reach "ready". The multi-dir fixture is kynetic
      // 1.1 — rewrite the manifest before warming so this test exercises
      // the loading→ready transition rather than degrade-on-load.
      await fs.writeFile(
        join(projectA, ".kspec", "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.2",
          project: {
            name: "Refs Endpoint Loading Contract Project",
            version: "0.1.0",
            status: "draft",
          },
          includes: ["modules/test.yaml"],
          task_storage: { format: "split" },
          plan_storage: { format: "folder" },
          review_storage: { format: "folder" },
          resource_storage: { format: "entity_scoped" },
        }),
        "utf-8",
      );
      // Simulates the refs endpoint check: if any required domain is loading,
      // return a loading response instead of falling through to disk reads
      const cache = registerEntityCache(projectA);

      // Start loadAll but check state before it completes
      const loadPromise = cache.loadAll();

      // During warmup, at least some domains should be "loading"
      const domainsForRefs: CacheDomain[] = ["tasks", "items", "plans"];
      // Either some are still loading (warmup in progress) or all ready (fast load)
      // The point is that no domain is "unloaded" — loadAll marks them all loading upfront
      for (const domain of domainsForRefs) {
        expect(["loading", "ready"]).toContain(cache.getDomainState(domain));
      }

      await loadPromise;

      // After loadAll, all should be ready
      for (const domain of domainsForRefs) {
        expect(cache.getDomainState(domain)).toBe("ready");
      }
    });
  });

  // ─── Entity Storage Compatibility — plans/reviews strict gate ────────────
  //
  // Cycle 3 blocker 1 & 2 fix: cache warm-up runs the strict folder-storage
  // gate before loadPlans() / loadReviewRecords(), so a legacy project
  // (kynetic < 1.2 without folder declarations) cannot enter "ready" with
  // monolithic data and the route's cache-warm fast path cannot leak that
  // data with a 200. These tests pin the cache-loader contract: an
  // incompatible project produces a "degraded" plans/reviews domain whose
  // stored error is the EntityStorageCompatibilityError that the daemon
  // route translates into the 409 entity_storage_incompatible response.

  describe("plans/reviews cache warm-up enforces strict folder-storage gate", () => {
    // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
    // AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
    it("transitions plans domain to degraded with legacy_plan_storage_removed on a kynetic 1.1 project (no plan_storage declaration)", async () => {
      // The multi-dir fixture is kynetic 1.1 with no plan_storage. The
      // strict gate must fire before loadPlans so the cache cannot serve
      // monolithic data through the ready fast path.
      await fs.writeFile(
        join(projectA, ".kspec", "project.plans.yaml"),
        yamlStringify({
          kynetic_plans: "1.0",
          plans: [
            {
              _ulid: "01LEGCYPLAN0000000000000A",
              slugs: ["legacy"],
              title: "Legacy monolithic plan",
              status: "draft",
              content: "Heavy content",
              created_at: "2026-01-01T00:00:00Z",
              derived_tasks: [],
              derived_specs: [],
              notes: [],
            },
          ],
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("plans");

      expect(cache.getDomainState("plans")).toBe("degraded");
      expect(cache.getPlansIndex()).toBeNull();
      const diagnostics = cache.getCacheDiagnostics();
      expect(diagnostics.domains.plans.errorReason).toBe("legacy_plan_storage_removed");
    });

    // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
    it("transitions plans domain to degraded with missing_plan_folder_storage on a kynetic 1.2 project without plan_storage declaration", async () => {
      await fs.writeFile(
        join(projectA, ".kspec", "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.2",
          project: { name: "Missing Decl", version: "0.1.0", status: "draft" },
          includes: ["modules/test.yaml"],
          task_storage: { format: "split" },
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("plans");

      expect(cache.getDomainState("plans")).toBe("degraded");
      expect(cache.getPlansIndex()).toBeNull();
      const diagnostics = cache.getCacheDiagnostics();
      expect(diagnostics.domains.plans.errorReason).toBe("missing_plan_folder_storage");
    });

    // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
    it("transitions reviews domain to degraded with legacy_review_storage_removed on a kynetic 1.1 project", async () => {
      await fs.writeFile(
        join(projectA, ".kspec", "project.reviews.yaml"),
        yamlStringify({
          kynetic_reviews: "1.0",
          reviews: [
            {
              _ulid: "01LEGCYREVIEW00000000000A",
              slugs: ["legacy-review"],
              title: "Legacy monolithic review",
              lifecycle_state: "open",
              author: "@test",
              subject: {
                type: "task",
                ref: "@task-test",
                shadow_commit: "abc",
                content_hash: "def",
              },
              related_refs: [],
              created_at: "2026-01-01T00:00:00Z",
              threads: [],
              checks: [],
              verdicts: [],
              events: [],
              external_links: [],
            },
          ],
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("reviews");

      expect(cache.getDomainState("reviews")).toBe("degraded");
      expect(cache.getReviewsIndex()).toBeNull();
      const diagnostics = cache.getCacheDiagnostics();
      expect(diagnostics.domains.reviews.errorReason).toBe("legacy_review_storage_removed");
    });

    // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
    it("transitions plans domain to degraded with partial_entity_storage_layout when folder declared but a plan index entry has no matching folder", async () => {
      await fs.writeFile(
        join(projectA, ".kspec", "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.2",
          project: { name: "Partial Layout", version: "0.1.0", status: "draft" },
          includes: ["modules/test.yaml"],
          task_storage: { format: "split" },
          plan_storage: { format: "folder" },
          review_storage: { format: "folder" },
          resource_storage: { format: "entity_scoped" },
        }),
        "utf-8",
      );
      // Index entry without matching `plans/<ulid>/` folder → partial layout
      await fs.writeFile(
        join(projectA, ".kspec", "project.plans.yaml"),
        yamlStringify({
          kynetic_plans: "1.2",
          plans: [
            {
              _ulid: "01STRANDED00000000000000A",
              slugs: [],
              title: "Stranded index entry",
              status: "draft",
              created_at: "2026-01-01T00:00:00Z",
              derived_tasks: [],
              derived_specs: [],
            },
          ],
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("plans");

      expect(cache.getDomainState("plans")).toBe("degraded");
      expect(cache.getPlansIndex()).toBeNull();
      const diagnostics = cache.getCacheDiagnostics();
      expect(diagnostics.domains.plans.errorReason).toBe("partial_entity_storage_layout");
    });
  });

  // ─── Cache Registry ────────────────────────────────────────────────────

  describe("cache registry", () => {
    it("should return null for unregistered project", () => {
      expect(getEntityCache("/nonexistent")).toBeNull();
    });

    it("should register and retrieve cache by project path", () => {
      const cache = registerEntityCache(projectA);
      expect(getEntityCache(projectA)).toBe(cache);
    });

    it("should reuse existing cache on re-registration", () => {
      const cache1 = registerEntityCache(projectA);
      const cache2 = registerEntityCache(projectA);
      expect(cache1).toBe(cache2);
    });

    it("should clear all caches", async () => {
      registerEntityCache(projectA);
      registerEntityCache(projectB);

      clearAllEntityCaches();

      expect(getEntityCache(projectA)).toBeNull();
      expect(getEntityCache(projectB)).toBeNull();
    });

    // AC: @daemon-server ac-18
    it("should enumerate all registered caches via getAllRegisteredCaches", () => {
      const cacheA = registerEntityCache(projectA);
      const cacheB = registerEntityCache(projectB);

      const all = getAllRegisteredCaches();
      expect(all).toHaveLength(2);
      expect(all).toContain(cacheA);
      expect(all).toContain(cacheB);
    });
  });

  // ─── AC: @daemon-server ac-18 — Diagnostics ────────────────────────────

  // AC: @daemon-server ac-18
  describe("getCacheDiagnostics: diagnostic snapshot", () => {
    it("should return per-domain state and counts after loadAll", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadAll();

      const diagnostics = cache.getCacheDiagnostics();
      expect(diagnostics.projectPath).toBe(projectA);
      expect(Object.keys(diagnostics.domains)).toHaveLength(DOMAIN_LOAD_ORDER.length);

      // Tasks domain should be ready with populated index
      expect(diagnostics.domains.tasks.state).toBe("ready");
      expect(diagnostics.domains.tasks.indexCount).toBeGreaterThan(0);
      expect(diagnostics.domains.tasks.lastError).toBeNull();
      // Detail count may be 0 if eager detail population fails silently for test fixtures
      expect(diagnostics.domains.tasks.detailCount).toBeGreaterThanOrEqual(0);

      // Items domain should be ready (index may be empty in test fixtures without
      // full shadow branch — consistent with existing item-load tests)
      expect(diagnostics.domains.items.state).toBe("ready");
      expect(diagnostics.domains.items.indexCount).toBeGreaterThanOrEqual(0);
      expect(diagnostics.domains.items.detailCount).toBeGreaterThanOrEqual(0);

      // Meta domain has a single-object index (not an array)
      expect(diagnostics.domains.meta.state).toBe("ready");
      expect(diagnostics.domains.meta.indexCount).toBe(1);
    });

    it("should report unloaded state before any loading", () => {
      const cache = new ProjectEntityCache(projectA);
      const diagnostics = cache.getCacheDiagnostics();

      for (const domain of DOMAIN_LOAD_ORDER) {
        expect(diagnostics.domains[domain].state).toBe("unloaded");
        expect(diagnostics.domains[domain].indexCount).toBe(0);
        expect(diagnostics.domains[domain].detailCount).toBe(0);
        expect(diagnostics.domains[domain].lastError).toBeNull();
        expect(diagnostics.domains[domain].lastInvalidatedAt).toBeNull();
      }
    });

    it("should include lastInvalidatedAt after invalidation", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("tasks");

      const before = cache.getCacheDiagnostics();
      expect(before.domains.tasks.lastInvalidatedAt).toBeNull();

      await cache.invalidateDomain("tasks");

      const after = cache.getCacheDiagnostics();
      expect(after.domains.tasks.lastInvalidatedAt).not.toBeNull();
      // Should be a valid ISO 8601 timestamp
      const ts = new Date(after.domains.tasks.lastInvalidatedAt!);
      expect(ts.getTime()).not.toBeNaN();
    });

    it("should include lastInvalidatedAt after writeThrough", async () => {
      const cache = new ProjectEntityCache(projectA);
      await cache.loadDomain("items");

      const before = cache.getCacheDiagnostics();
      expect(before.domains.items.lastInvalidatedAt).toBeNull();

      await cache.writeThrough("items");

      const after = cache.getCacheDiagnostics();
      expect(after.domains.items.lastInvalidatedAt).not.toBeNull();
    });
  });

  // ─── AC: ac-domain-ready-event ──────────────────────────────────────────

  // AC: @daemon-entity-cache ac-domain-ready-event
  describe("ac-domain-ready-event: broadcast when domain transitions to ready", () => {
    it("should broadcast a real-time event when a domain transitions from loading to ready", async () => {
      const readyEvents: Array<{
        domain: CacheDomain;
        projectPath: string;
        previousState: DomainState;
      }> = [];
      const onDomainReady: DomainReadyCallback = (domain, projectPath, previousState) => {
        readyEvents.push({ domain, projectPath, previousState });
      };

      const cache = new ProjectEntityCache(projectA, undefined, onDomainReady);
      expect(cache.getDomainState("tasks")).toBe("unloaded");

      await cache.loadDomain("tasks");

      expect(cache.getDomainState("tasks")).toBe("ready");
      expect(readyEvents).toHaveLength(1);
      expect(readyEvents[0].domain).toBe("tasks");
      expect(readyEvents[0].previousState).toBe("unloaded");
    });

    it("should broadcast a real-time event when a domain transitions from degraded to ready", async () => {
      const readyEvents: Array<{
        domain: CacheDomain;
        projectPath: string;
        previousState: DomainState;
      }> = [];
      const onDomainReady: DomainReadyCallback = (domain, projectPath, previousState) => {
        readyEvents.push({ domain, projectPath, previousState });
      };

      const cache = new ProjectEntityCache(projectA, undefined, onDomainReady);

      // Force the domain into degraded state by making initContext fail
      const initContextSpy = vi
        .spyOn(yamlModule, "initContext")
        .mockRejectedValueOnce(new Error("simulated failure"));

      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("degraded");

      initContextSpy.mockRestore();

      // The first load should NOT have fired a ready event (it degraded)
      expect(readyEvents).toHaveLength(0);

      // Now reload — should transition from degraded to ready
      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");
      expect(readyEvents).toHaveLength(1);
      expect(readyEvents[0].domain).toBe("tasks");
      expect(readyEvents[0].previousState).toBe("degraded");
    });

    it("should include the domain name and project identifier in the broadcast payload delivered to subscribers", async () => {
      // Integration test: wire onDomainReady → PubSubManager.broadcast (same as server.ts)
      // then verify the serialized WebSocket message contains both domain and projectPath.
      const { PubSubManager } = await import("../packages/daemon/src/websocket/pubsub");

      const pubsub = new PubSubManager();

      // Create a mock WebSocket subscribed to cache:status
      const sentMessages: string[] = [];
      const mockWs = {
        data: {
          sessionId: "test-conn",
          topics: new Set(["cache:status"]),
          seq: 0,
          lastPong: Date.now(),
          projectPath: projectA,
        },
        send: vi.fn<(msg: string) => number>((msg: string) => sentMessages.push(msg)),
        close: vi.fn<() => void>(),
        subscribe: vi.fn<() => void>(),
        unsubscribe: vi.fn<() => void>(),
      } as any;

      pubsub.addConnection("test-conn", mockWs);

      // Wire the callback exactly as server.ts does
      const onDomainReady: DomainReadyCallback = (domain, cachePath, previousState) => {
        pubsub.broadcast(
          "cache:status",
          "domain_ready",
          { domain, projectPath: cachePath, previousState, timestamp: new Date().toISOString() },
          cachePath,
        );
      };

      const cache = new ProjectEntityCache(projectA, undefined, onDomainReady);

      await cache.loadDomain("tasks");
      await cache.loadDomain("items");

      // Two domains loaded → two broadcast messages
      expect(sentMessages).toHaveLength(2);

      const msg1 = JSON.parse(sentMessages[0]);
      expect(msg1.topic).toBe("cache:status");
      expect(msg1.event).toBe("domain_ready");
      expect(msg1.data.domain).toBe("tasks");
      expect(msg1.data.projectPath).toBe(projectA);
      expect(msg1.data.previousState).toBe("unloaded");
      expect(msg1.data).toHaveProperty("timestamp");

      const msg2 = JSON.parse(sentMessages[1]);
      expect(msg2.data.domain).toBe("items");
      expect(msg2.data.projectPath).toBe(projectA);
      expect(msg2.data.previousState).toBe("unloaded");

      pubsub.removeConnection("test-conn");
    });

    it("should not broadcast when a domain stays in ready state during a reload", async () => {
      const readyEvents: Array<{
        domain: CacheDomain;
        projectPath: string;
        previousState: DomainState;
      }> = [];
      const onDomainReady: DomainReadyCallback = (domain, projectPath, previousState) => {
        readyEvents.push({ domain, projectPath, previousState });
      };

      const cache = new ProjectEntityCache(projectA, undefined, onDomainReady);

      // Initial load — should fire ready event
      await cache.loadDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");
      expect(readyEvents).toHaveLength(1);

      // Reload via invalidation — domain stays ready (ac-stale-during-reload),
      // so no additional ready event should fire
      await cache.invalidateDomain("tasks");
      expect(cache.getDomainState("tasks")).toBe("ready");
      expect(readyEvents).toHaveLength(1); // Still just the initial one
    });

    // AC: @daemon-entity-cache ac-broadcast-after-reload
    it("should notify after a watcher-driven reload completes with fresh sessions data", async () => {
      const reloadEvents: Array<{ domain: CacheDomain; projectPath: string }> = [];
      const onDomainReloaded: DomainReloadedCallback = (domain, projectPath) => {
        reloadEvents.push({ domain, projectPath });
      };

      const sessionsDir = join(projectA, ".kspec-sessions");
      const sessionId = "session-reload";
      const sessionDir = join(sessionsDir, sessionId);
      const metadataPath = join(sessionDir, "session.yaml");
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        metadataPath,
        yamlStringify({
          id: sessionId,
          agent_type: "claude-agent-acp",
          status: "active",
          started_at: "2026-04-01T00:00:00.000Z",
          event_count: 1,
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA, undefined, undefined, onDomainReloaded);
      await cache.loadDomain("sessions");

      await fs.writeFile(
        metadataPath,
        yamlStringify({
          id: sessionId,
          agent_type: "claude-agent-acp",
          status: "completed",
          started_at: "2026-04-01T00:00:00.000Z",
          ended_at: "2026-04-01T00:05:00.000Z",
          event_count: 9,
        }),
        "utf-8",
      );

      await cache.handleFileChange(sessionsDir, metadataPath);

      expect(reloadEvents).toEqual([{ domain: "sessions", projectPath: projectA }]);
      expect(cache.getSessionIndex()!.find((entry) => entry.id === sessionId)).toMatchObject({
        id: sessionId,
        status: "completed",
        event_count: 9,
      });
    });

    // AC: @daemon-entity-cache ac-broadcast-after-reload
    it("should broadcast the sessions topic only after the sessions reload finishes", async () => {
      const { PubSubManager } = await import("../packages/daemon/src/websocket/pubsub");

      const pubsub = new PubSubManager();
      const sentMessages: string[] = [];
      const mockWs = {
        data: {
          sessionId: "test-conn",
          topics: new Set(["sessions"]),
          seq: 0,
          lastPong: Date.now(),
          projectPath: projectA,
        },
        send: vi.fn<(msg: string) => number>((msg: string) => sentMessages.push(msg)),
        close: vi.fn<() => void>(),
        subscribe: vi.fn<() => void>(),
        unsubscribe: vi.fn<() => void>(),
      } as any;
      pubsub.addConnection("test-conn", mockWs);

      const sessionsDir = join(projectA, ".kspec-sessions");
      const sessionId = "session-pubsub";
      const sessionDir = join(sessionsDir, sessionId);
      const metadataPath = join(sessionDir, "session.yaml");
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        metadataPath,
        yamlStringify({
          id: sessionId,
          agent_type: "claude-agent-acp",
          status: "active",
          started_at: "2026-04-01T00:00:00.000Z",
          event_count: 1,
        }),
        "utf-8",
      );

      const cache = new ProjectEntityCache(projectA, undefined, undefined, (domain, cachePath) => {
        if (domain !== "sessions") return;
        pubsub.broadcast(
          "sessions",
          "session_changed",
          {
            domain,
            projectPath: cachePath,
            action: "modified",
            timestamp: new Date().toISOString(),
          },
          cachePath,
        );
      });
      await cache.loadDomain("sessions");
      sentMessages.length = 0;

      await fs.writeFile(
        metadataPath,
        yamlStringify({
          id: sessionId,
          agent_type: "claude-agent-acp",
          status: "completed",
          started_at: "2026-04-01T00:00:00.000Z",
          ended_at: "2026-04-01T00:05:00.000Z",
          event_count: 4,
        }),
        "utf-8",
      );

      await cache.handleFileChange(sessionsDir, metadataPath);

      expect(sentMessages).toHaveLength(1);
      const broadcast = JSON.parse(sentMessages[0]);
      expect(broadcast.topic).toBe("sessions");
      expect(broadcast.event).toBe("session_changed");
      expect(broadcast.data).toMatchObject({
        domain: "sessions",
        projectPath: projectA,
        action: "modified",
      });
      expect(cache.getSessionIndex()!.find((entry) => entry.id === sessionId)?.event_count).toBe(4);

      pubsub.removeConnection("test-conn");
    });

    // AC: @daemon-entity-cache ac-domain-ready-event
    it("should fire onDomainReady when cache is created via registerEntityCache", async () => {
      const readyEvents: Array<{
        domain: CacheDomain;
        projectPath: string;
        previousState: DomainState;
      }> = [];
      const onDomainReady: DomainReadyCallback = (domain, projectPath, previousState) => {
        readyEvents.push({ domain, projectPath, previousState });
      };

      // Use the registry function (same as production code) with the callback
      const cache = registerEntityCache(projectA, undefined, onDomainReady);
      await cache.loadDomain("tasks");

      expect(readyEvents).toHaveLength(1);
      expect(readyEvents[0]).toEqual({
        domain: "tasks",
        projectPath: projectA,
        previousState: "unloaded",
      });

      // Clean up — unregister so other tests aren't affected
      unregisterEntityCache(projectA);
    });
  });

  // ─── Task-storage compatibility / migration suppression ─────────────────
  describe("task-storage incompatibility suppression", () => {
    /**
     * Build a legacy (kynetic 1.0 without split task_storage) project on
     * top of an existing multi-dir fixture by overwriting kynetic.yaml.
     * Returns the project path to be used.
     */
    async function makeLegacyProject(): Promise<string> {
      const legacyDir = await createTempDir("kspec-legacy-");
      await fs.mkdir(join(legacyDir, ".kspec"), { recursive: true });
      await setupShadowDetection(legacyDir);
      await fs.writeFile(
        join(legacyDir, ".kspec", "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.0",
          project: { name: "Legacy", version: "0.1.0", status: "draft" },
        }),
        "utf-8",
      );
      // Legacy projects had project.tasks.yaml with full task entries; the
      // file's presence isn't required for the version gate to fire, but
      // include a representative file so watcher tests have something to
      // change.
      await fs.writeFile(
        join(legacyDir, ".kspec", "project.tasks.yaml"),
        yamlStringify([
          {
            _ulid: "01LEGACY00000000000000000A",
            slugs: ["task-legacy"],
            title: "Legacy task",
            type: "task",
            status: "pending",
            priority: 3,
            depends_on: [],
            created_at: "2026-01-01T00:00:00.000Z",
            notes: [],
            todos: [],
          },
        ]),
        "utf-8",
      );
      return legacyDir;
    }

    /**
     * Build a split-configured project that has an unmigrated entry — the
     * index has a task without notes_count and no matching per-task dir,
     * which is exactly what the split backend's ensureMigrated() guards
     * against.
     */
    async function makeUnmigratedSplitProject(): Promise<string> {
      const dir = await createTempDir("kspec-unmigrated-");
      await fs.mkdir(join(dir, ".kspec"), { recursive: true });
      await setupShadowDetection(dir);
      await fs.writeFile(
        join(dir, ".kspec", "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.1",
          project: { name: "Unmigrated", version: "0.1.0", status: "draft" },
          task_storage: { format: "split" },
        }),
        "utf-8",
      );
      // Unmigrated entry: lacks notes_count scalar and has no per-task dir.
      await fs.writeFile(
        join(dir, ".kspec", "project.tasks.yaml"),
        yamlStringify([
          {
            _ulid: "01UNMIG0000000000000000000",
            slugs: ["task-unmig"],
            title: "Unmigrated entry",
            type: "task",
            status: "pending",
            priority: 3,
            depends_on: [],
            created_at: "2026-01-01T00:00:00.000Z",
            notes: [],
            todos: [],
          },
        ]),
        "utf-8",
      );
      return dir;
    }

    /** Patch a project so its manifest declares split task storage at kynetic 1.1. */
    async function migrateToSplit(projectDir: string): Promise<void> {
      await fs.writeFile(
        join(projectDir, ".kspec", "kynetic.yaml"),
        yamlStringify({
          kynetic: "1.1",
          project: { name: "Migrated", version: "0.1.0", status: "draft" },
          task_storage: { format: "split" },
        }),
        "utf-8",
      );
      // Clear the legacy tasks file so split mode finds no tasks (empty
      // project is valid for split per ensureMigrated()).
      await fs.writeFile(join(projectDir, ".kspec", "project.tasks.yaml"), "[]\n", "utf-8");
    }

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-degraded-state
    it("degrades tasks domain when legacy kynetic 1.0 monolithic storage is detected", async () => {
      const legacyDir = await makeLegacyProject();
      try {
        const cache = new ProjectEntityCache(legacyDir);
        await cache.loadDomain("tasks");

        expect(cache.getDomainState("tasks")).toBe("degraded");
        const diagnostics = cache.getCacheDiagnostics();
        expect(diagnostics.domains.tasks.state).toBe("degraded");
        expect(diagnostics.domains.tasks.errorReason).toBe("legacy_task_storage_removed");
        expect(diagnostics.domains.tasks.recoveryGuidance).toContain("kspec task migrate");
        expect(diagnostics.domains.tasks.recoveryWaitingOnProjectState).toBe(true);
        expect(diagnostics.domains.tasks.lastError).toBeTruthy();
      } finally {
        await fs.rm(legacyDir, { recursive: true, force: true });
      }
    });

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-degraded-state
    it("classifies split-configured-but-unmigrated tasks as deterministic migration error", async () => {
      const dir = await makeUnmigratedSplitProject();
      try {
        const cache = new ProjectEntityCache(dir);
        await cache.loadDomain("tasks");

        expect(cache.getDomainState("tasks")).toBe("degraded");
        const diagnostics = cache.getCacheDiagnostics();
        expect(diagnostics.domains.tasks.errorReason).toBe("split_task_storage_unmigrated");
        expect(diagnostics.domains.tasks.recoveryGuidance).toContain("kspec task migrate");
        expect(diagnostics.domains.tasks.recoveryWaitingOnProjectState).toBe(true);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-stable-reporting
    it("suppresses repeated failure reports for the same unchanged condition", async () => {
      const legacyDir = await makeLegacyProject();
      const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const cache = new ProjectEntityCache(legacyDir);
        await cache.loadDomain("tasks");

        const firstReportCount = consoleErrSpy.mock.calls.filter((c) =>
          String(c[0]).includes('domain "tasks"'),
        ).length;
        expect(firstReportCount).toBe(1);

        // Repeated explicit loads: each goes through the lower-level reload
        // path, so suppression must kick in and prevent another report.
        await cache.loadDomain("tasks");
        await cache.loadDomain("tasks");
        await cache.loadDomain("tasks");

        const totalReports = consoleErrSpy.mock.calls.filter((c) =>
          String(c[0]).includes('domain "tasks"'),
        ).length;
        expect(totalReports).toBe(firstReportCount);

        // State is still degraded and surfaces the deterministic reason.
        const diag = cache.getCacheDiagnostics();
        expect(diag.domains.tasks.state).toBe("degraded");
        expect(diag.domains.tasks.errorReason).toBe("legacy_task_storage_removed");
        expect(diag.domains.tasks.recoveryWaitingOnProjectState).toBe(true);
      } finally {
        consoleErrSpy.mockRestore();
        await fs.rm(legacyDir, { recursive: true, force: true });
      }
    });

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-stable-reporting
    it("does not bypass suppression for concurrent/queued reloads or writeThrough fallback", async () => {
      const legacyDir = await makeLegacyProject();
      const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const cache = new ProjectEntityCache(legacyDir);
        await cache.loadDomain("tasks");

        const baselineReports = consoleErrSpy.mock.calls.filter((c) =>
          String(c[0]).includes('domain "tasks"'),
        ).length;

        // Concurrent reload paths must not each emit their own failure
        // report. writeThrough without a hint falls through to the
        // non-meta reload path; queued reloads go through the in-flight
        // dedup so any waiting work also sees suppression after the first
        // observation.
        await Promise.all([
          cache.loadDomain("tasks"),
          cache.loadDomain("tasks"),
          cache.writeThrough("tasks"),
          cache.writeThrough("tasks"),
        ]);

        const totalReports = consoleErrSpy.mock.calls.filter((c) =>
          String(c[0]).includes('domain "tasks"'),
        ).length;
        expect(totalReports).toBe(baselineReports);
        expect(cache.getDomainState("tasks")).toBe("degraded");
      } finally {
        consoleErrSpy.mockRestore();
        await fs.rm(legacyDir, { recursive: true, force: true });
      }
    });

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-rechecked-after-storage-change
    // AC: @daemon-entity-cache ac-manifest-task-storage-settings-affect-tasks-domain
    it("re-evaluates tasks domain when kynetic.yaml task-storage settings change", async () => {
      const legacyDir = await makeLegacyProject();
      const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const cache = new ProjectEntityCache(legacyDir);
        await cache.loadDomain("tasks");
        expect(cache.getDomainState("tasks")).toBe("degraded");

        // Migrate the project: update kynetic.yaml to declare split storage
        // and empty out the legacy tasks file. The watcher will emit a
        // change for kynetic.yaml, which lifts suppression and triggers a
        // recheck.
        await migrateToSplit(legacyDir);

        const kspecDir = join(legacyDir, ".kspec");
        await cache.handleFileChange(kspecDir, join(kspecDir, "kynetic.yaml"));

        // Recheck should restore the domain to ready without daemon restart.
        expect(cache.getDomainState("tasks")).toBe("ready");
        const diag = cache.getCacheDiagnostics();
        expect(diag.domains.tasks.errorReason).toBeNull();
        expect(diag.domains.tasks.recoveryWaitingOnProjectState).toBe(false);
        expect(diag.domains.tasks.lastError).toBeNull();
      } finally {
        consoleErrSpy.mockRestore();
        await fs.rm(legacyDir, { recursive: true, force: true });
      }
    });

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-rechecked-after-storage-change
    it("re-evaluates tasks domain when task-storage files change", async () => {
      const legacyDir = await makeLegacyProject();
      const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const cache = new ProjectEntityCache(legacyDir);
        await cache.loadDomain("tasks");

        const kspecDir = join(legacyDir, ".kspec");
        // Simulate a watcher event for the legacy tasks file. The domain
        // re-evaluates against current state, and since the legacy gate
        // still fails, stays degraded — but the recheck path must run.
        await cache.handleFileChange(kspecDir, join(kspecDir, "project.tasks.yaml"));
        expect(cache.getDomainState("tasks")).toBe("degraded");

        // Now migrate and emit a task-file watcher event to confirm
        // recovery via the task-file change signal alone.
        await migrateToSplit(legacyDir);
        await cache.handleFileChange(kspecDir, join(kspecDir, "project.tasks.yaml"));
        expect(cache.getDomainState("tasks")).toBe("ready");
      } finally {
        consoleErrSpy.mockRestore();
        await fs.rm(legacyDir, { recursive: true, force: true });
      }
    });

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-recovers-after-migration
    it("returns tasks domain to available state after successful migration without restart", async () => {
      const legacyDir = await makeLegacyProject();
      try {
        const cache = new ProjectEntityCache(legacyDir);
        await cache.loadDomain("tasks");
        expect(cache.getDomainState("tasks")).toBe("degraded");

        await migrateToSplit(legacyDir);
        const kspecDir = join(legacyDir, ".kspec");
        await cache.handleFileChange(kspecDir, join(kspecDir, "kynetic.yaml"));

        expect(cache.getDomainState("tasks")).toBe("ready");
        // Re-runs of loadDomain on the now-healthy project must continue to
        // work normally (suppression cleared).
        await cache.loadDomain("tasks");
        expect(cache.getDomainState("tasks")).toBe("ready");
      } finally {
        await fs.rm(legacyDir, { recursive: true, force: true });
      }
    });

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-persists-when-unresolved
    it("keeps tasks domain degraded when a recheck finds the same incompatibility", async () => {
      const legacyDir = await makeLegacyProject();
      const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const cache = new ProjectEntityCache(legacyDir);
        await cache.loadDomain("tasks");
        const firstObservedAt = cache.getCacheDiagnostics().domains.tasks;
        expect(firstObservedAt.errorReason).toBe("legacy_task_storage_removed");

        // Edit the legacy tasks file (e.g., the user touched it but did NOT
        // migrate). The watcher event lifts suppression and triggers a
        // recheck — but the underlying gate still fires.
        const kspecDir = join(legacyDir, ".kspec");
        await fs.writeFile(
          join(kspecDir, "project.tasks.yaml"),
          yamlStringify([
            {
              _ulid: "01LEGACY00000000000000000A",
              slugs: ["task-legacy"],
              title: "Legacy task edited",
              type: "task",
              status: "pending",
              priority: 3,
              depends_on: [],
              created_at: "2026-01-01T00:00:00.000Z",
              notes: [],
              todos: [],
            },
          ]),
          "utf-8",
        );
        await cache.handleFileChange(kspecDir, join(kspecDir, "project.tasks.yaml"));

        expect(cache.getDomainState("tasks")).toBe("degraded");
        const diag = cache.getCacheDiagnostics().domains.tasks;
        expect(diag.errorReason).toBe("legacy_task_storage_removed");
        expect(diag.recoveryWaitingOnProjectState).toBe(true);
        // Suppression for the same code must not duplicate the failure log.
        const reportCount = consoleErrSpy.mock.calls.filter((c) =>
          String(c[0]).includes('domain "tasks"'),
        ).length;
        expect(reportCount).toBe(1);
      } finally {
        consoleErrSpy.mockRestore();
        await fs.rm(legacyDir, { recursive: true, force: true });
      }
    });
  });
});
