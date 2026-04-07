/**
 * Route-level regression coverage for hinted task write-through in triage promote.
 *
 * AC: @daemon-entity-cache ac-write-through
 */

import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.js";
import { createInboxRoutes } from "../dist/daemon/routes/inbox.js";
import { createTriageRoutes } from "../dist/daemon/routes/triage.js";
import { PubSubManager } from "../dist/daemon/websocket/pubsub.js";
import type {
  EntityCacheAccessor,
  RouteEntityCache,
} from "../dist/daemon/routes/entity-cache-types.js";
import type { WriteThroughHint } from "../dist/daemon/entity-cache.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  makeRequest,
  setupFixtures,
} from "./daemon-api/helpers.js";

let tempDir: string;
let app: Elysia;
let writeThroughEntries: Array<{ domain: string; hint?: WriteThroughHint }>;

function createMockCache(): RouteEntityCache {
  writeThroughEntries = [];

  return {
    getDomainState: () => "ready",
    getTaskIndex: () => null,
    getTaskDetail: () => null,
    getTaskHistory: () => null,
    setTaskDetail: () => {},
    getAllTaskDetails: () => null,
    getItemIndex: () => null,
    getItemDetail: () => null,
    setItemDetail: () => {},
    getAllItemDetails: () => null,
    getSessionIndex: () => null,
    getSessionLiveEventCount: () => undefined,
    getSessionDetail: () => null,
    setSessionDetail: () => {},
    getPlansIndex: () => null,
    getPlanDetail: () => null,
    setPlanDetail: () => {},
    getInboxIndex: () => null,
    getTriageIndex: () => null,
    getTriageDetail: () => null,
    setTriageDetail: () => {},
    getReviewsIndex: () => null,
    getReviewDetail: () => null,
    setReviewDetail: () => {},
    getMetaIndex: () => null,
    getMetaDetail: () => null,
    setMetaDetail: () => {},
    getShadowInfo: () => null,
    getProjectConfig: () => null,
    getSessionContext: () => null,
    writeThrough: vi.fn(async (domain: string, hint?: WriteThroughHint) => {
      writeThroughEntries.push({ domain, hint });
    }),
    markWriteThrough: vi.fn(),
    getCacheDiagnostics: () => ({
      projectPath: tempDir,
      updatedAt: new Date().toISOString(),
      domains: {},
    }),
  };
}

describe("triage promote write-through", () => {
  beforeEach(async () => {
    tempDir = await createTempDir("kspec-triage-write-through-");
    initGitRepo(tempDir);
    setupFixtures(tempDir);

    const pubsub = new PubSubManager();
    const { middleware, manager } = projectContextMiddleware();
    manager.startWatcher = async () => {};

    const cache = createMockCache();
    const getEntityCache: EntityCacheAccessor = () => cache;

    app = new Elysia()
      .resolve(({ set }) => ({
        error: (status: number, body: unknown) => {
          set.status = status;
          return body;
        },
      }))
      .use(middleware)
      .use(createInboxRoutes({ pubsub, getEntityCache }))
      .use(createTriageRoutes({ pubsub, getEntityCache }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-entity-cache ac-write-through
  it("passes the promoted task ULID to task writeThrough during triage act", async () => {
    const inboxResponse = await makeRequest(app, tempDir, "/api/inbox", {
      method: "POST",
      body: JSON.stringify({
        text: `Promote route coverage ${Date.now()}`,
      }),
    });
    expect(inboxResponse.status).toBe(200);

    const inboxBody = (await inboxResponse.json()) as { item: { _ulid: string } };
    const triageResponse = await makeRequest(app, tempDir, "/api/triage", {
      method: "POST",
      body: JSON.stringify({
        inbox_ref: `@${inboxBody.item._ulid}`,
        action: "promote",
        reasoning: "Regression coverage",
      }),
    });
    expect(triageResponse.status).toBe(200);

    const triageBody = (await triageResponse.json()) as { record: { _ulid: string } };
    const actResponse = await makeRequest(app, tempDir, `/api/triage/@${triageBody.record._ulid}/act`, {
      method: "POST",
    });
    expect(actResponse.status).toBe(200);

    expect(writeThroughEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: "triage" }),
        expect.objectContaining({ domain: "tasks", hint: { ulid: expect.any(String) } }),
        expect.objectContaining({ domain: "inbox" }),
      ]),
    );
  });
});
