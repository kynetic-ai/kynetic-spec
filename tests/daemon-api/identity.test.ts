// AC: @trait-api-endpoint ac-2 — N/A: the identity endpoint takes no entity-ref
//     parameter, so there is no ref to resolve or 404 on.
// AC: @trait-api-endpoint ac-3 — N/A: GET-only endpoint with no request body to validate.
// AC: @trait-api-endpoint ac-4 — N/A: returns a single bounded identity object,
//     not a paginated list, so limit/offset/total do not apply.
// AC: @trait-api-endpoint ac-5 — N/A: read-only endpoint, performs no state mutation
//     and therefore no shadow commit.

import { writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyActor } from "@kynetic-ai/shared";
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
let savedAuthor: string | undefined;

beforeEach(async () => {
  // Pin the author so the resolved human identity is deterministic regardless
  // of the ambient git/OS user or any dispatch-set KSPEC_AUTHOR.
  savedAuthor = process.env.KSPEC_AUTHOR;
  process.env.KSPEC_AUTHOR = "@tester";

  tempDir = await createTempDir("kspec-daemon-api-identity-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  ({ app } = createTestApp());
});

afterEach(async () => {
  if (savedAuthor === undefined) {
    delete process.env.KSPEC_AUTHOR;
  } else {
    process.env.KSPEC_AUTHOR = savedAuthor;
  }
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

describe("GET /api/identity", () => {
  it("returns 200 with a JSON body", async () => {
    // AC: @trait-api-endpoint ac-1 — 2xx with JSON body
    const response = await request("/api/identity");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("returns the configured human identity with a display name", async () => {
    // AC: @actor-identity-resolution ac-1 — human identity + display name
    const response = await request("/api/identity");
    const body = await response.json();
    expect(body.data.human).not.toBeNull();
    expect(body.data.human.canonicalId).toBe("@tester");
    expect(typeof body.data.human.displayName).toBe("string");
    expect(body.data.human.displayName.length).toBeGreaterThan(0);
  });

  it("returns the canonical agent roster with id and display info", async () => {
    // AC: @actor-identity-resolution ac-1 — canonical agent roster
    const response = await request("/api/identity");
    const body = await response.json();
    expect(Array.isArray(body.data.agents)).toBe(true);
    expect(body.data.agents.length).toBeGreaterThan(0);

    for (const agent of body.data.agents) {
      expect(typeof agent.canonicalId).toBe("string");
      expect(agent.canonicalId.length).toBeGreaterThan(0);
      expect(typeof agent.displayName).toBe("string");
      expect(agent.displayName.length).toBeGreaterThan(0);
    }

    // Fixture agents (see tests/e2e/fixtures/kynetic.meta.yaml).
    const byId = new Map<string, string>(
      body.data.agents.map((a: { canonicalId: string; displayName: string }) => [
        a.canonicalId,
        a.displayName,
      ]),
    );
    expect(byId.get("task-worker")).toBe("Task Worker");
    expect(byId.get("pr-reviewer")).toBe("PR Reviewer");
  });

  it("returns a single bounded object, not a paginated list", async () => {
    // AC: @actor-identity-resolution ac-1 — one bounded response, no list fan-out
    const response = await request("/api/identity");
    const body = await response.json();
    expect(typeof body.data).toBe("object");
    expect(Array.isArray(body.data)).toBe(false);
    expect(body.data).toHaveProperty("human");
    expect(body.data).toHaveProperty("agents");
    // No pagination metadata on a bounded (non-list) payload.
    expect(body.meta.total).toBeUndefined();
    expect(body.meta).toHaveProperty("cache_status");
  });

  it("includes an X-Request-Id header for tracing", async () => {
    // AC: @trait-api-endpoint ac-6 — X-Request-Id header
    const response = await request("/api/identity");
    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();
    expect((requestId ?? "").length).toBeGreaterThan(0);
  });
});

describe("GET /api/identity — configured agent aliases", () => {
  // AC: @actor-identity-resolution ac-2 — the endpoint payload must carry the
  // configured non-derivable agent spellings so the classifier fed by the REAL
  // endpoint payload (not a hand-built config) resolves the measured variants.
  beforeEach(() => {
    writeFileSync(
      path.join(tempDir, "kspec.config.yaml"),
      [
        "identity:",
        "  agent_aliases:",
        '    pr-reviewer: ["@dispatch", "@kspec", "@kspec-dispatch"]',
        "",
      ].join("\n"),
    );
  });

  it("emits each agent's configured aliases in the roster payload", async () => {
    // AC: @actor-identity-resolution ac-2 — production alias source surfaced
    const response = await request("/api/identity");
    const body = await response.json();
    const prReviewer = body.data.agents.find(
      (a: { canonicalId: string }) => a.canonicalId === "pr-reviewer",
    );
    expect(prReviewer).toBeDefined();
    expect(prReviewer.aliases).toEqual(["@dispatch", "@kspec", "@kspec-dispatch"]);

    // Agents without configured aliases omit the field rather than emitting [].
    const taskWorker = body.data.agents.find(
      (a: { canonicalId: string }) => a.canonicalId === "task-worker",
    );
    expect(taskWorker).toBeDefined();
    expect(taskWorker.aliases).toBeUndefined();
  });

  it("classifies non-derivable variants through the real endpoint payload", async () => {
    // AC: @actor-identity-resolution ac-2 — feeding the endpoint payload (as the
    // web UI does via fetchIdentity) to the shared classifier resolves the
    // measured spellings that algorithmic normalization cannot derive.
    const response = await request("/api/identity");
    const config = (await response.json()).data;

    for (const variant of ["@dispatch", "@kspec", "@kspec-dispatch", "dispatch"]) {
      const result = classifyActor(variant, config);
      expect(result.kind).toBe("agent");
      expect(result.canonicalId).toBe("pr-reviewer");
    }

    // Sanity: an unconfigured string still resolves to unknown, not misattributed.
    expect(classifyActor("Hermes", config).kind).toBe("unknown");
  });
});
