/**
 * Session log search tests.
 *
 * Tests for the `kspec session log search` command and supporting store functions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { searchSessionEvents, type SessionSearchResult } from "../src/sessions/store.js";
import { setupTempFixtures, cleanupTempDir, kspec, kspecJson, testUlid } from "./helpers/cli";

// ─── Store Unit Tests ───────────────────────────────────────────────────────

describe("searchSessionEvents", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-session-search-"));

    // Create sessions directory
    sessionsDir = path.join(testDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Session 1: with tool calls
    const s1 = testUlid("SESS", 1);
    const s1Dir = path.join(sessionsDir, s1);
    await fs.mkdir(s1Dir);
    await fs.writeFile(
      path.join(s1Dir, "session.yaml"),
      YAML.stringify({
        id: s1,
        agent_type: "claude-agent-acp",
        status: "completed",
        started_at: "2026-01-20T10:00:00.000Z",
        ended_at: "2026-01-20T11:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s1Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 1000,
          seq: 0,
          type: "session.start",
          session_id: s1,
          data: { message: "Starting session" },
        }),
        JSON.stringify({
          ts: 2000,
          seq: 1,
          type: "session.update",
          session_id: s1,
          data: {
            update: {
              sessionUpdate: "tool_call",
              rawInput: { command: "npm run build" },
            },
          },
        }),
        JSON.stringify({
          ts: 3000,
          seq: 2,
          type: "prompt.sent",
          session_id: s1,
          data: { prompt: "Tell me about ERROR handling" },
        }),
        JSON.stringify({
          ts: 4000,
          seq: 3,
          type: "session.end",
          session_id: s1,
          data: { reason: "completed successfully" },
        }),
      ].join("\n")}\n`,
    );

    // Session 2: different agent, more recent
    const s2 = testUlid("SESS", 2);
    const s2Dir = path.join(sessionsDir, s2);
    await fs.mkdir(s2Dir);
    await fs.writeFile(
      path.join(s2Dir, "session.yaml"),
      YAML.stringify({
        id: s2,
        agent_type: "custom-agent",
        status: "active",
        started_at: "2026-02-01T08:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s2Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 5000,
          seq: 0,
          type: "session.start",
          session_id: s2,
          data: { message: "Custom session start" },
        }),
        JSON.stringify({
          ts: 6000,
          seq: 1,
          type: "session.update",
          session_id: s2,
          data: {
            update: {
              sessionUpdate: "tool_call",
              rawInput: { command: 'kspec task complete @my-task --reason "Fixed ERROR in build"' },
            },
          },
        }),
      ].join("\n")}\n`,
    );

    // Session 3: no matches for common patterns
    const s3 = testUlid("SESS", 3);
    const s3Dir = path.join(sessionsDir, s3);
    await fs.mkdir(s3Dir);
    await fs.writeFile(
      path.join(s3Dir, "session.yaml"),
      YAML.stringify({
        id: s3,
        agent_type: "claude-agent-acp",
        status: "completed",
        started_at: "2026-02-02T10:00:00.000Z",
        ended_at: "2026-02-02T11:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s3Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 7000,
          seq: 0,
          type: "session.start",
          session_id: s3,
          data: { message: "Clean session" },
        }),
        JSON.stringify({
          ts: 8000,
          seq: 1,
          type: "session.end",
          session_id: s3,
          data: { reason: "done" },
        }),
      ].join("\n")}\n`,
    );

    // Session 4: externalized blob pointer payload
    const s4 = testUlid("SESS", 4);
    const s4Dir = path.join(sessionsDir, s4);
    await fs.mkdir(s4Dir);
    await fs.mkdir(path.join(s4Dir, "blobs"));
    await fs.writeFile(
      path.join(s4Dir, "session.yaml"),
      YAML.stringify({
        id: s4,
        agent_type: "claude-agent-acp",
        status: "completed",
        started_at: "2026-02-03T10:00:00.000Z",
        ended_at: "2026-02-03T10:30:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s4Dir, "blobs", "search-pointer.blob"),
      "RESOLVED_ONLY_BLOB_TOKEN",
    );
    await fs.writeFile(
      path.join(s4Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 9000,
          seq: 0,
          type: "tool.result",
          session_id: s4,
          data: {
            output: {
              path: "blobs/search-pointer.blob",
              bytes: 24,
              sha256: "test-hash",
              truncated: true,
              preview: "PREVIEW_ONLY_BLOB_TOKEN",
            },
          },
        }),
      ].join("\n")}\n`,
    );
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  // AC: @session-log-search ac-1
  it("should search event data for case-insensitive substring match", async () => {
    const results = await searchSessionEvents(sessionsDir, "error");
    expect(results.length).toBeGreaterThan(0);

    // Should find matches in both sessions that have "error" (case-insensitive)
    let totalMatches = 0;
    for (const r of results) {
      totalMatches += r.matches.length;
    }
    expect(totalMatches).toBe(2); // One in session 1, one in session 2
  });

  // AC: @session-log-search ac-1
  it("should return results grouped by session", async () => {
    const results = await searchSessionEvents(sessionsDir, "session");
    expect(results.length).toBeGreaterThan(0);

    for (const result of results) {
      expect(result).toHaveProperty("session_id");
      expect(result).toHaveProperty("agent_type");
      expect(result).toHaveProperty("started_at");
      expect(result).toHaveProperty("matches");
      expect(Array.isArray(result.matches)).toBe(true);
    }
  });

  // AC: @session-log-search ac-2
  it("should filter by event type when --type is provided", async () => {
    const results = await searchSessionEvents(sessionsDir, "session", {
      eventType: "session.start",
    });

    // All matches should be session.start events
    for (const result of results) {
      for (const match of result.matches) {
        expect(match.event_type).toBe("session.start");
      }
    }
  });

  // AC: @session-log-search ac-3
  it("should filter by since date", async () => {
    const sinceDate = new Date("2026-02-01");
    const results = await searchSessionEvents(sessionsDir, "session", {
      sinceDate,
    });

    // Only sessions 2 and 3 are after Feb 1
    for (const result of results) {
      expect(new Date(result.started_at).getTime()).toBeGreaterThanOrEqual(sinceDate.getTime());
    }
  });

  // AC: @session-log-search ac-4
  it("should return matches with session ID, timestamp, type, and excerpt", async () => {
    const results = await searchSessionEvents(sessionsDir, "build");
    expect(results.length).toBeGreaterThan(0);

    const match = results[0].matches[0];
    expect(match).toHaveProperty("session_id");
    expect(match).toHaveProperty("timestamp");
    expect(typeof match.timestamp).toBe("number");
    expect(match).toHaveProperty("event_type");
    expect(match).toHaveProperty("content_excerpt");
    expect(typeof match.content_excerpt).toBe("string");
  });

  // AC: @session-log-search ac-4
  it("should limit content excerpt to 200 characters", async () => {
    const results = await searchSessionEvents(sessionsDir, "build");
    for (const result of results) {
      for (const match of result.matches) {
        expect(match.content_excerpt.length).toBeLessThanOrEqual(200);
      }
    }
  });

  // AC: @session-log-search ac-5
  it("should respect limit option", async () => {
    const results = await searchSessionEvents(sessionsDir, "session", { limit: 2 });

    let totalMatches = 0;
    for (const r of results) {
      totalMatches += r.matches.length;
    }
    expect(totalMatches).toBeLessThanOrEqual(2);
  });

  // AC: @session-log-search ac-6
  it("should return empty array when no matches found", async () => {
    const results = await searchSessionEvents(sessionsDir, "xyznonexistent");
    expect(results).toEqual([]);
  });

  // AC: @session-log-search ac-7
  it("should filter by agent type", async () => {
    const results = await searchSessionEvents(sessionsDir, "session", {
      agentType: "custom-agent",
    });

    for (const result of results) {
      expect(result.agent_type).toBe("custom-agent");
    }
  });

  // Defense-in-depth: store normalizes invalid limits
  it("should fallback to default limit when given invalid limit", async () => {
    // NaN should be normalized to 50
    const results1 = await searchSessionEvents(sessionsDir, "session", { limit: NaN });
    expect(results1.length).toBeGreaterThan(0);

    // 0 should be normalized to 50
    const results2 = await searchSessionEvents(sessionsDir, "session", { limit: 0 });
    expect(results2.length).toBeGreaterThan(0);

    // Negative should be normalized to 50
    const results3 = await searchSessionEvents(sessionsDir, "session", { limit: -5 });
    expect(results3.length).toBeGreaterThan(0);
  });

  it("should combine multiple filters", async () => {
    const results = await searchSessionEvents(sessionsDir, "error", {
      agentType: "custom-agent",
      sinceDate: new Date("2026-01-01"),
    });

    expect(results.length).toBe(1);
    expect(results[0].agent_type).toBe("custom-agent");
  });

  it("should search pointer previews by default", async () => {
    const results = await searchSessionEvents(sessionsDir, "preview_only_blob_token");
    expect(results.length).toBe(1);
    expect(results[0].matches[0].content_excerpt).toContain("PREVIEW_ONLY_BLOB_TOKEN");
  });

  it("should resolve blob content when resolveBlobs is enabled", async () => {
    const noResolve = await searchSessionEvents(sessionsDir, "resolved_only_blob_token");
    expect(noResolve).toEqual([]);

    const resolved = await searchSessionEvents(sessionsDir, "resolved_only_blob_token", {
      resolveBlobs: true,
    });
    expect(resolved.length).toBe(1);
    expect(resolved[0].matches[0].content_excerpt).toContain("RESOLVED_ONLY_BLOB_TOKEN");
  });
});

// ─── CLI Integration Tests ──────────────────────────────────────────────────

describe("kspec session log search (CLI)", () => {
  let tempDir: string;
  let activeBuildSessionId: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    // Create sessions directory for test data
    const sessionsDir = path.join(tempDir, ".kspec-sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Session 1: with tool calls containing searchable content
    const s1 = testUlid("SESS", 1);
    const s1Dir = path.join(sessionsDir, s1);
    await fs.mkdir(s1Dir);
    await fs.writeFile(
      path.join(s1Dir, "session.yaml"),
      YAML.stringify({
        id: s1,
        agent_type: "claude-agent-acp",
        agent_id: "pr-reviewer",
        status: "completed",
        task_id: "@legacy-build-task",
        started_at: "2026-01-15T10:00:00.000Z",
        ended_at: "2026-01-15T11:30:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s1Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 1000,
          seq: 0,
          type: "session.start",
          session_id: s1,
          data: { message: "Starting automated build process" },
        }),
        JSON.stringify({
          ts: 2000,
          seq: 1,
          type: "session.update",
          session_id: s1,
          data: {
            update: {
              sessionUpdate: "tool_call",
              rawInput: { command: "npm run test" },
            },
          },
        }),
        JSON.stringify({
          ts: 3000,
          seq: 2,
          type: "prompt.sent",
          session_id: s1,
          data: { prompt: "Please analyze the TypeScript compiler errors" },
        }),
      ].join("\n")}\n`,
    );

    // Session 2: different agent, recent
    const s2 = testUlid("SESS", 2);
    activeBuildSessionId = s2;
    const s2Dir = path.join(sessionsDir, s2);
    await fs.mkdir(s2Dir);
    await fs.writeFile(
      path.join(s2Dir, "session.yaml"),
      YAML.stringify({
        id: s2,
        agent_type: "custom-agent",
        agent_id: "worker",
        status: "active",
        task_id: "@build-task",
        started_at: "2026-02-05T08:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s2Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 4000,
          seq: 0,
          type: "session.start",
          session_id: s2,
          data: { message: "Custom build agent session" },
        }),
        JSON.stringify({
          ts: 5000,
          seq: 1,
          type: "session.update",
          session_id: s2,
          data: {
            update: {
              sessionUpdate: "tool_call",
              rawInput: { command: 'kspec task complete @build-task --reason "Build successful"' },
            },
          },
        }),
      ].join("\n")}\n`,
    );

    // Session 3: no matches for common patterns
    const s3 = testUlid("SESS", 3);
    const s3Dir = path.join(sessionsDir, s3);
    await fs.mkdir(s3Dir);
    await fs.writeFile(
      path.join(s3Dir, "session.yaml"),
      YAML.stringify({
        id: s3,
        agent_type: "claude-agent-acp",
        agent_id: "worker",
        status: "completed",
        started_at: "2026-02-04T14:00:00.000Z",
        ended_at: "2026-02-04T15:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s3Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 6000,
          seq: 0,
          type: "session.start",
          session_id: s3,
          data: { message: "Simple session" },
        }),
        JSON.stringify({
          ts: 7000,
          seq: 1,
          type: "session.end",
          session_id: s3,
          data: { reason: "done" },
        }),
      ].join("\n")}\n`,
    );

    // Session 4: event containing externalized blob pointer
    const s4 = testUlid("SESS", 4);
    const s4Dir = path.join(sessionsDir, s4);
    await fs.mkdir(s4Dir);
    await fs.mkdir(path.join(s4Dir, "blobs"));
    await fs.writeFile(
      path.join(s4Dir, "session.yaml"),
      YAML.stringify({
        id: s4,
        agent_type: "claude-agent-acp",
        status: "completed",
        started_at: "2026-02-06T10:00:00.000Z",
        ended_at: "2026-02-06T10:15:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s4Dir, "blobs", "cli-search-pointer.blob"),
      "CLI_RESOLVED_BLOB_TOKEN",
    );
    await fs.writeFile(
      path.join(s4Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 8000,
          seq: 0,
          type: "tool.result",
          session_id: s4,
          data: {
            output: {
              path: "blobs/cli-search-pointer.blob",
              bytes: 23,
              sha256: "test-hash",
              truncated: true,
              preview: "CLI_PREVIEW_BLOB_TOKEN",
            },
          },
        }),
      ].join("\n")}\n`,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-log-search ac-1
  it("should search for pattern and display matches grouped by session", () => {
    const result = kspec("session log search build", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("match");
    expect(result.stdout).toContain("session");
  });

  // AC: @session-log-search ac-1 (JSON variant)
  it("should return valid JSON with matches grouped by session in --json mode", () => {
    const results = kspecJson<SessionSearchResult[]>("session log search build", tempDir);
    expect(results.length).toBeGreaterThan(0);

    for (const result of results) {
      expect(result).toHaveProperty("session_id");
      expect(result).toHaveProperty("agent_type");
      expect(result).toHaveProperty("started_at");
      expect(result).toHaveProperty("matches");
      expect(Array.isArray(result.matches)).toBe(true);
    }
  });

  // AC: @session-log-search ac-1
  it("should search case-insensitively", () => {
    // Search for uppercase BUILD should find lowercase "build"
    const results = kspecJson<SessionSearchResult[]>("session log search BUILD", tempDir);
    expect(results.length).toBeGreaterThan(0);
  });

  // AC: @session-log-search ac-2
  it("should filter by event type with --type flag", () => {
    const results = kspecJson<SessionSearchResult[]>(
      "session log search session --type session.start",
      tempDir,
    );

    for (const result of results) {
      for (const match of result.matches) {
        expect(match.event_type).toBe("session.start");
      }
    }
  });

  // AC: @session-log-search ac-3
  it("should filter by --since flag", () => {
    const results = kspecJson<SessionSearchResult[]>(
      "session log search session --since 2026-02-01",
      tempDir,
    );

    // Only sessions 2 and 3 are after Feb 1
    for (const result of results) {
      expect(new Date(result.started_at).getTime()).toBeGreaterThanOrEqual(
        new Date("2026-02-01").getTime(),
      );
    }
  });

  // AC: @session-log-search ac-4
  it("should show session ID, timestamp, type, and excerpt in each match", () => {
    const results = kspecJson<SessionSearchResult[]>("session log search build", tempDir);
    expect(results.length).toBeGreaterThan(0);

    const match = results[0].matches[0];
    expect(match).toHaveProperty("session_id");
    expect(match).toHaveProperty("event_seq");
    expect(match).toHaveProperty("timestamp");
    expect(match).toHaveProperty("event_type");
    expect(match).toHaveProperty("content_excerpt");
  });

  // AC: @session-text-search ac-cli-search
  // AC: @session-text-search ac-scope-narrowing
  it("narrows CLI search by status, agent id, since, and task filters before scanning events", () => {
    const results = kspecJson<SessionSearchResult[]>(
      "session log search build --status active --agent-id worker --since 2026-02-01 --task @build-task",
      tempDir,
    );

    expect(results).toHaveLength(1);
    expect(results[0].agent_type).toBe("custom-agent");
    expect(results[0].session_id).toBe(activeBuildSessionId);
    expect(results[0].matches[0].event_seq).toBeGreaterThanOrEqual(0);
  });

  // AC: @session-log-search ac-4
  it("should limit content excerpt to 200 characters", () => {
    const results = kspecJson<SessionSearchResult[]>("session log search build", tempDir);
    for (const result of results) {
      for (const match of result.matches) {
        expect(match.content_excerpt.length).toBeLessThanOrEqual(200);
      }
    }
  });

  // AC: @session-log-search ac-5
  it("should respect --limit flag", () => {
    const results = kspecJson<SessionSearchResult[]>("session log search session -n 1", tempDir);

    let totalMatches = 0;
    for (const r of results) {
      totalMatches += r.matches.length;
    }
    expect(totalMatches).toBeLessThanOrEqual(1);
  });

  // AC: @session-log-search ac-5
  it("should default limit to 50", () => {
    // This test just verifies the command runs with default limit
    const result = kspec("session log search session", tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @session-log-search ac-6
  it('should display "No matches found" when pattern has no matches', () => {
    const result = kspec("session log search xyznonexistent123", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No matches found");
  });

  // AC: @session-log-search ac-6 (JSON variant)
  it("should return empty array when no matches found in JSON mode", () => {
    const results = kspecJson<SessionSearchResult[]>(
      "session log search xyznonexistent123",
      tempDir,
    );
    expect(results).toEqual([]);
  });

  // AC: @session-log-search ac-7
  it("should filter by --agent flag", () => {
    const results = kspecJson<SessionSearchResult[]>(
      "session log search session --agent custom-agent",
      tempDir,
    );

    for (const result of results) {
      expect(result.agent_type).toBe("custom-agent");
    }
  });

  // Combined filters
  it("should combine --type and --agent filters", () => {
    const results = kspecJson<SessionSearchResult[]>(
      "session log search session --type session.start --agent custom-agent",
      tempDir,
    );

    for (const result of results) {
      expect(result.agent_type).toBe("custom-agent");
      for (const match of result.matches) {
        expect(match.event_type).toBe("session.start");
      }
    }
  });

  // Trait: JSON output has ISO 8601 timestamps
  // AC: @trait-json-output ac-5
  it("should use ISO 8601 timestamps in JSON output", () => {
    const results = kspecJson<SessionSearchResult[]>("session log search build", tempDir);
    for (const result of results) {
      expect(result.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  // Trait: JSON output no ANSI codes
  // AC: @trait-json-output ac-1
  it("should have no ANSI codes in JSON output", () => {
    const result = kspec("session log search build --json", tempDir);
    // oxlint-disable-next-line eslint(no-control-regex) -- intentionally matching ANSI escape
    expect(result.stdout).not.toMatch(/\x1b\[\d+m/);
  });

  // Trait: exit code 0 on success (even when no matches)
  // AC: @trait-semantic-exit-codes ac-1, ac-5
  it("should exit with code 0 on success", () => {
    const result = kspec("session log search build", tempDir);
    expect(result.exitCode).toBe(0);
  });

  it("should exit with code 0 when no matches found", () => {
    const result = kspec("session log search nonexistent", tempDir);
    expect(result.exitCode).toBe(0);
  });

  it("should search pointer preview content by default", () => {
    const results = kspecJson<SessionSearchResult[]>(
      "session log search cli_preview_blob_token",
      tempDir,
    );
    expect(results.length).toBe(1);
  });

  it("should resolve blob content when --resolve-blobs is set", () => {
    const noResolve = kspecJson<SessionSearchResult[]>(
      "session log search cli_resolved_blob_token",
      tempDir,
    );
    expect(noResolve).toEqual([]);

    const resolved = kspecJson<SessionSearchResult[]>(
      "session log search cli_resolved_blob_token --resolve-blobs",
      tempDir,
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0].matches[0].content_excerpt).toContain("CLI_RESOLVED_BLOB_TOKEN");
  });

  // AC: @trait-semantic-exit-codes ac-6 - Invalid limit handling (exit code 2 = USAGE_ERROR)
  it("should exit with code 2 for invalid --limit value", () => {
    const result = kspec("session log search build -n abc", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid limit");
  });

  it("should exit with code 2 for non-positive --limit value", () => {
    const result = kspec("session log search build -n 0", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid limit");
  });

  it("should exit with code 2 for negative --limit value", () => {
    const result = kspec("session log search build -n -5", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid limit");
  });
});
