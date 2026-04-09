import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { initContext, loadAllItems, loadAllTasks } from "../src/parser/index.js";
import type { RouteEntityCache } from "../dist/daemon/routes/entity-cache-types.js";
import {
  getRelatedSessionsForItem,
  getRelatedSessionsForTask,
} from "../dist/daemon/routes/session-related.js";

const tempDirs: string[] = [];

async function createFixtureProject(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-session-related-"));
  tempDirs.push(tempDir);

  const kspecDir = path.join(tempDir, ".kspec");
  await fs.mkdir(path.join(kspecDir, "modules"), { recursive: true });
  await fs.writeFile(
    path.join(kspecDir, "kynetic.yaml"),
    `kynetic: "1.0"

project:
  name: "Session Related Test Project"
  version: "0.1.0"
  status: draft

includes:
  - modules/core.yaml

tasks_file: project.tasks.yaml
`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(kspecDir, "modules", "core.yaml"),
    `_ulid: 01KF1645CB2FQ3F2XTPYVZGCFS
slugs:
  - core
title: Core
type: module
description: Core test module

features:
  - _ulid: 01KF1645CBDJYHWBPYWRN3HYPJ
    slugs:
      - test-feature
    title: Test Feature
    type: feature
    description: Feature used by session-related tests
    acceptance_criteria:
      - id: ac-1
        given: related tasks exist
        when: sessions are queried
        then: matching sessions are returned
`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(kspecDir, "project.tasks.yaml"),
    `tasks:
  - _ulid: 01KG0RR6CA45ZT43W2T6HJMVA1
    slugs:
      - test-task-ready
    title: Ready task
    type: task
    status: pending
    priority: 2
    spec_ref: "@test-feature"
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: 01KG0RR8CB8N4YGP991WD7XS9R
    slugs:
      - test-task-in-progress
    title: In progress task
    type: task
    status: in_progress
    priority: 2
    spec_ref: "@test-feature"
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"
`,
    "utf-8",
  );
  await fs.mkdir(path.join(kspecDir, ".kspec-sessions"), { recursive: true });

  return kspecDir;
}

async function writeSession(
  projectRoot: string,
  options: {
    id: string;
    taskId: string;
    startedAt: string;
    status?: "active" | "completed";
    endedAt?: string;
  },
) {
  const sessionDir = path.join(projectRoot, ".kspec-sessions", options.id);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "session.yaml"),
    `id: "${options.id}"
task_id: "${options.taskId}"
agent_type: "claude-agent-acp"
agent_id: "worker"
trigger: "task.ready"
status: "${options.status ?? "completed"}"
started_at: "${options.startedAt}"
${options.endedAt ? `ended_at: "${options.endedAt}"` : ""}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(sessionDir, "events.jsonl"), "", "utf-8");
}

function createReadySessionsCacheWithLiveCounter(
  liveEventCounts: Record<string, number>,
): RouteEntityCache {
  return {
    getDomainState: (domain: string) => (domain === "sessions" ? "ready" : "unloaded"),
    getTaskIndex: () => null,
    getTaskDetail: () => null,
    getTaskHistory: () => null,
    setTaskDetail: () => {},
    getAllTaskDetails: () => null,
    getItemIndex: () => null,
    getItemDetail: () => null,
    setItemDetail: () => {},
    getAllItemDetails: () => null,
    getSessionIndex: () => [],
    getSessionLiveEventCount: (sessionId: string) => liveEventCounts[sessionId],
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
    writeThrough: async () => {},
    markWriteThrough: () => {},
    getCacheDiagnostics: () =>
      ({
        projectPath: "",
        domains: {},
        watcherActive: false,
        lastInvalidationAt: null,
        entryCounts: {},
      }) as ReturnType<RouteEntityCache["getCacheDiagnostics"]>,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-related route helpers", () => {
  // AC: @task-spec-session-context ac-api-task-sessions
  it("returns sessions for a resolved task reference", async () => {
    const projectRoot = await createFixtureProject();
    await writeSession(projectRoot, {
      id: "session-task-ready",
      taskId: "@test-task-ready",
      startedAt: "2026-03-01T10:00:00Z",
      endedAt: "2026-03-01T10:05:00Z",
    });

    const ctx = await initContext(projectRoot);
    const tasks = await loadAllTasks(ctx);
    const items = await loadAllItems(ctx);
    const result = await getRelatedSessionsForTask({
      taskRef: "@test-task-ready",
      tasks,
      items,
      sessionsDir: ctx.sessionsDir,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.task.title).toBe("Ready task");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      id: "session-task-ready",
      task_id: "@test-task-ready",
      status: "completed",
      duration_ms: 300000,
    });
  });

  // AC: @task-spec-session-context ac-api-item-sessions
  it("returns sessions for tasks aligned to a spec item", async () => {
    const projectRoot = await createFixtureProject();
    await writeSession(projectRoot, {
      id: "session-task-ready",
      taskId: "@test-task-ready",
      startedAt: "2026-03-01T10:00:00Z",
      endedAt: "2026-03-01T10:05:00Z",
    });
    await writeSession(projectRoot, {
      id: "session-task-progress",
      taskId: "@test-task-in-progress",
      startedAt: "2026-03-01T12:00:00Z",
      endedAt: "2026-03-01T12:08:00Z",
    });

    const ctx = await initContext(projectRoot);
    const tasks = await loadAllTasks(ctx);
    const items = await loadAllItems(ctx);
    const result = await getRelatedSessionsForItem({
      itemRef: "@test-feature",
      tasks,
      items,
      sessionsDir: ctx.sessionsDir,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.item.title).toBe("Test Feature");
    expect(result.sessions.map((session) => session.id)).toEqual([
      "session-task-progress",
      "session-task-ready",
    ]);
  });

  // AC: @daemon-entity-cache ac-session-live-counter
  it("preserves live event counts when related-session fallback refreshes from disk", async () => {
    const projectRoot = await createFixtureProject();
    await writeSession(projectRoot, {
      id: "session-task-active",
      taskId: "@test-task-ready",
      startedAt: "2026-03-01T12:00:00Z",
      status: "active",
    });

    const ctx = await initContext(projectRoot);
    const tasks = await loadAllTasks(ctx);
    const items = await loadAllItems(ctx);
    const entityCache = createReadySessionsCacheWithLiveCounter({
      "session-task-active": 3,
    });
    const result = await getRelatedSessionsForTask({
      taskRef: "@test-task-ready",
      tasks,
      items,
      sessionsDir: ctx.sessionsDir,
      projectPath: projectRoot,
      getEntityCache: () => entityCache,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      id: "session-task-active",
      status: "active",
      event_count: 3,
    });
  });
});
