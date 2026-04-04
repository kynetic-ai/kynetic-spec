/**
 * API Tests for Session Text Search
 *
 * Covered ACs:
 * - @session-text-search ac-api-search
 * - @session-text-search ac-performance
 * - @session-text-search ac-scope-narrowing
 * - @trait-api-endpoint ac-1
 * - @trait-api-endpoint ac-2
 */

// AC: @trait-api-endpoint ac-3 — N/A: GET /api/sessions/search does not accept a request body.
// AC: @trait-api-endpoint ac-4 — N/A: search results are bounded by limit, not offset/limit pagination.
// AC: @trait-api-endpoint ac-5 — N/A: the search endpoint is read-only and does not mutate shadow state.
// AC: @trait-api-endpoint ac-6 — N/A: x-request-id is set only by command routes (via onTransform middleware in command.ts), not session routes.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Elysia } from "elysia";
import * as YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupFixtures,
} from "./helpers.js";

let tempDir: string;
let app: Elysia;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-sessions-search-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

function writeSession(
  dir: string,
  sessionId: string,
  opts: {
    agentType?: string;
    agentId?: string;
    status?: string;
    trigger?: string;
    taskId?: string;
    startedAt?: string;
    events: Array<{ type: string; text: string }>;
  },
): void {
  const sessionDir = join(dir, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  writeFileSync(
    join(sessionDir, "session.yaml"),
    YAML.stringify({
      id: sessionId,
      agent_type: opts.agentType ?? "claude-agent-acp",
      agent_id: opts.agentId ?? "worker",
      status: opts.status ?? "completed",
      trigger: opts.trigger ?? "task.ready",
      task_id: opts.taskId,
      started_at: opts.startedAt ?? "2026-03-01T10:00:00.000Z",
    }),
  );

  writeFileSync(
    join(sessionDir, "events.jsonl"),
    `${opts.events
      .map((event, index) =>
        JSON.stringify({
          seq: index,
          ts: Date.parse(opts.startedAt ?? "2026-03-01T10:00:00.000Z") + index * 1000,
          type: event.type,
          session_id: sessionId,
          data: { message: event.text },
        }),
      )
      .join("\n")}\n`,
  );
}

describe("Session Search API", () => {
  // AC: @session-text-search ac-api-search
  // AC: @session-text-search ac-performance
  // AC: @session-text-search ac-scope-narrowing
  // AC: @trait-api-endpoint ac-1
  it("returns grouped matches and narrows the search set with metadata filters", async () => {
    const sessionsDir = join(tempDir, ".kspec-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const recentStartedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const staleStartedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    writeSession(sessionsDir, "01KSEARCH000000000000000001", {
      agentId: "worker",
      status: "completed",
      taskId: "@test-task-ready",
      startedAt: recentStartedAt,
      events: [
        { type: "session.start", text: "Starting run" },
        { type: "session.update", text: "Error handling added to daemon search" },
      ],
    });

    writeSession(sessionsDir, "01KSEARCH000000000000000002", {
      agentId: "pr-reviewer",
      status: "failed",
      taskId: "@test-task-ready",
      startedAt: staleStartedAt,
      events: [{ type: "session.update", text: "Error handling in unrelated review" }],
    });

    const response = await request(
      "/api/sessions/search?q=error+handling&status=completed&agent_id=worker&since=7d&task_id=@test-task-ready",
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.query).toBe("error handling");
    expect(body.data.total_sessions).toBe(1);
    expect(body.data.total_matches).toBe(1);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].session_id).toBe("01KSEARCH000000000000000001");
    expect(body.data.items[0].matches[0]).toMatchObject({
      session_id: "01KSEARCH000000000000000001",
      event_seq: 1,
      event_type: "session.update",
    });
    expect(typeof body.data.items[0].matches[0].timestamp).toBe("number");
    expect(body.data.items[0].matches[0].content_excerpt).toContain("Error handling");
    expect(body.meta).toBeDefined();
    expect(body.meta.cache_status).toBe("ready");
  });

  // AC: @trait-api-endpoint ac-2
  it("returns 404 for an unknown task filter", async () => {
    const response = await request("/api/sessions/search?q=error&task_id=@missing-task");
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("@missing-task");
    expect(body.suggestion).toContain("/api/tasks");
  });
});
