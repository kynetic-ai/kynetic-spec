// Session event detail endpoint tests.
//
// Tests for readEventBySeq store function and
// GET /api/sessions/:id/events/:seq route behavior.
//
// Trait AC annotations (N/A):
// AC: @trait-api-endpoint ac-3 — N/A: endpoint has no request body to validate
// AC: @trait-api-endpoint ac-4 — N/A: this is a single-resource endpoint, not a list endpoint
// AC: @trait-api-endpoint ac-5 — N/A: endpoint is read-only, no state mutation
// AC: @trait-api-endpoint ac-6 — N/A: X-Request-Id handled by server middleware, not individual routes

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readEventBySeq, resolveSessionBlobPointers } from "../src/sessions/store.js";

let tempDir: string;
let sessionsDir: string;

const SESSION_ID = "01KTEST0000000000000000001";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-event-detail-"));
  sessionsDir = path.join(tempDir, ".kspec-sessions");
  const sessionDir = path.join(sessionsDir, SESSION_ID);
  await fs.mkdir(sessionDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function writeEvents(events: Array<Record<string, unknown>>): Promise<void> {
  const eventsPath = path.join(sessionsDir, SESSION_ID, "events.jsonl");
  const content = events
    .map((e) => JSON.stringify(e))
    .join("\n")
    .concat("\n");
  return fs.writeFile(eventsPath, content, "utf-8");
}

// ─── readEventBySeq Unit Tests ──────────────────────────────────────────────

describe("readEventBySeq", () => {
  // AC: @session-event-detail-endpoint ac-single-event-fetch
  // AC: @trait-api-endpoint ac-1
  it("should return the event matching the given seq", async () => {
    await writeEvents([
      { ts: 1000, seq: 0, type: "session.start", session_id: SESSION_ID, data: { iteration: 1 } },
      { ts: 2000, seq: 1, type: "note", session_id: SESSION_ID, data: { message: "hello" } },
      { ts: 3000, seq: 2, type: "session.end", session_id: SESSION_ID, data: {} },
    ]);

    const event = await readEventBySeq(sessionsDir, SESSION_ID, 1);
    expect(event).not.toBeNull();
    expect(event!.seq).toBe(1);
    expect(event!.type).toBe("note");
    expect(event!.ts).toBe(2000);
  });

  // AC: @session-event-detail-endpoint ac-single-event-fetch
  it("should return the first event (seq 0)", async () => {
    await writeEvents([
      { ts: 1000, seq: 0, type: "session.start", session_id: SESSION_ID, data: {} },
      { ts: 2000, seq: 1, type: "session.end", session_id: SESSION_ID, data: {} },
    ]);

    const event = await readEventBySeq(sessionsDir, SESSION_ID, 0);
    expect(event).not.toBeNull();
    expect(event!.seq).toBe(0);
    expect(event!.type).toBe("session.start");
  });

  // AC: @session-event-detail-endpoint ac-not-found
  // AC: @trait-api-endpoint ac-2
  it("should return null for non-existent seq", async () => {
    await writeEvents([
      { ts: 1000, seq: 0, type: "session.start", session_id: SESSION_ID, data: {} },
    ]);

    const event = await readEventBySeq(sessionsDir, SESSION_ID, 99);
    expect(event).toBeNull();
  });

  // AC: @session-event-detail-endpoint ac-not-found
  it("should return null for non-existent session", async () => {
    const event = await readEventBySeq(sessionsDir, "NONEXISTENT", 0);
    expect(event).toBeNull();
  });

  it("should return null when events.jsonl is empty", async () => {
    const eventsPath = path.join(sessionsDir, SESSION_ID, "events.jsonl");
    await fs.writeFile(eventsPath, "", "utf-8");

    const event = await readEventBySeq(sessionsDir, SESSION_ID, 0);
    expect(event).toBeNull();
  });

  it("should skip malformed lines and still find valid events", async () => {
    const eventsPath = path.join(sessionsDir, SESSION_ID, "events.jsonl");
    const content = [
      "invalid json line",
      JSON.stringify({
        ts: 1000,
        seq: 0,
        type: "session.start",
        session_id: SESSION_ID,
        data: {},
      }),
      "{ broken",
      JSON.stringify({
        ts: 2000,
        seq: 1,
        type: "note",
        session_id: SESSION_ID,
        data: { text: "ok" },
      }),
    ]
      .join("\n")
      .concat("\n");
    await fs.writeFile(eventsPath, content, "utf-8");

    const event = await readEventBySeq(sessionsDir, SESSION_ID, 1);
    expect(event).not.toBeNull();
    expect(event!.seq).toBe(1);
    expect(event!.type).toBe("note");
  });
});

// ─── Blob Resolution Tests ──────────────────────────────────────────────────

describe("resolveSessionBlobPointers for event data", () => {
  // AC: @session-event-detail-endpoint ac-blob-resolution
  it("should resolve blob pointers in event data to full content", async () => {
    const blobContent = "A".repeat(20000); // > 16KB externalization threshold
    const sessionDir = path.join(sessionsDir, SESSION_ID);
    const blobDir = path.join(sessionDir, "blobs");
    await fs.mkdir(blobDir, { recursive: true });
    await fs.writeFile(path.join(blobDir, "tool-output.blob"), blobContent, "utf-8");

    const eventData = {
      output: {
        path: "blobs/tool-output.blob",
        bytes: Buffer.byteLength(blobContent, "utf-8"),
        sha256: "test-hash",
        truncated: true as const,
        preview: blobContent.slice(0, 512),
      },
    };

    const resolved = (await resolveSessionBlobPointers(sessionsDir, SESSION_ID, eventData)) as {
      output: { content: string; preview: string };
    };

    expect(resolved.output.content).toBe(blobContent);
    expect(resolved.output.preview).toBe(blobContent.slice(0, 512));
  });

  // AC: @session-event-detail-endpoint ac-blob-resolution
  it("should resolve nested blob pointers", async () => {
    const blobContent = "nested blob content";
    const sessionDir = path.join(sessionsDir, SESSION_ID);
    const blobDir = path.join(sessionDir, "blobs");
    await fs.mkdir(blobDir, { recursive: true });
    await fs.writeFile(path.join(blobDir, "nested.blob"), blobContent, "utf-8");

    const eventData = {
      tool_calls: [
        {
          result: {
            path: "blobs/nested.blob",
            bytes: Buffer.byteLength(blobContent, "utf-8"),
            sha256: "test-hash",
            truncated: true as const,
            preview: "nested",
          },
        },
      ],
    };

    const resolved = (await resolveSessionBlobPointers(sessionsDir, SESSION_ID, eventData)) as {
      tool_calls: Array<{ result: { content: string } }>;
    };

    expect(resolved.tool_calls[0].result.content).toBe(blobContent);
  });

  it("should pass through non-blob data unchanged", async () => {
    const eventData = {
      message: "hello",
      count: 42,
      nested: { value: true },
    };

    const resolved = await resolveSessionBlobPointers(sessionsDir, SESSION_ID, eventData);

    expect(resolved).toEqual(eventData);
  });

  it("should fall back to preview when blob file is missing", async () => {
    const eventData = {
      output: {
        path: "blobs/missing.blob",
        bytes: 100,
        sha256: "test-hash",
        truncated: true as const,
        preview: "preview text",
      },
    };

    const resolved = (await resolveSessionBlobPointers(sessionsDir, SESSION_ID, eventData)) as {
      output: { content: string; preview: string };
    };

    // Falls back to preview when blob file doesn't exist
    expect(resolved.output.content).toBe("preview text");
  });
});

// ─── Integration: readEventBySeq + blob resolution ─────────────────────────

describe("readEventBySeq with blob resolution integration", () => {
  // AC: @session-event-detail-endpoint ac-single-event-fetch
  // AC: @session-event-detail-endpoint ac-blob-resolution
  it("should read a single event and resolve its blob pointers", async () => {
    const blobContent = "Full tool output content that was externalized";
    const sessionDir = path.join(sessionsDir, SESSION_ID);
    const blobDir = path.join(sessionDir, "blobs");
    await fs.mkdir(blobDir, { recursive: true });
    await fs.writeFile(path.join(blobDir, "output.blob"), blobContent, "utf-8");

    await writeEvents([
      { ts: 1000, seq: 0, type: "session.start", session_id: SESSION_ID, data: {} },
      {
        ts: 2000,
        seq: 1,
        type: "tool.result",
        session_id: SESSION_ID,
        data: {
          output: {
            path: "blobs/output.blob",
            bytes: Buffer.byteLength(blobContent, "utf-8"),
            sha256: "test-hash",
            truncated: true,
            preview: "Full tool",
          },
        },
      },
      { ts: 3000, seq: 2, type: "session.end", session_id: SESSION_ID, data: {} },
    ]);

    // Read the tool.result event
    const event = await readEventBySeq(sessionsDir, SESSION_ID, 1);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("tool.result");

    // Resolve blob pointers
    const resolvedData = (await resolveSessionBlobPointers(
      sessionsDir,
      SESSION_ID,
      event!.data,
    )) as { output: { content: string; preview: string } };

    expect(resolvedData.output.content).toBe(blobContent);
    expect(resolvedData.output.preview).toBe("Full tool");
  });
});
