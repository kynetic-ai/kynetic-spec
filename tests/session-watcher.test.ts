/**
 * Tests for the daemon session watcher.
 *
 * Verifies .kspec-sessions changes produce project-local callbacks without
 * depending on the daemon E2E harness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "fs";
import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { setupMultiDirFixtures, cleanupTempDir } from "./helpers/cli";
import { SessionWatcher } from "../packages/daemon/src/session-watcher";

const DEBOUNCE_WAIT = process.env.CI ? 2000 : 600;
const describeOrSkip = process.env.CI ? describe.skip : describe;

// AC: @trait-error-guidance ac-1 — N/A: SessionWatcher is an internal daemon component, not a user-facing command.
// AC: @trait-error-guidance ac-2 — N/A: SessionWatcher reports errors to callbacks/logging, not command guidance.
// AC: @trait-error-guidance ac-3 — N/A: SessionWatcher does not resolve user-facing refs.
// AC: @trait-error-guidance ac-4 — N/A: SessionWatcher does not perform task/item state transitions.
// AC: @trait-error-guidance ac-5 — N/A: SessionWatcher does not surface field validation errors to users.
// AC: @trait-error-guidance ac-6 — N/A: SessionWatcher has no JSON error mode.

async function waitForDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT));
}

async function countOpenFileDescriptors(): Promise<number> {
  return (await readdir("/proc/self/fd")).length;
}

describeOrSkip("SessionWatcher", () => {
  let fixturesRoot: string;
  let projectDir: string;

  beforeEach(async () => {
    fixturesRoot = await setupMultiDirFixtures();
    projectDir = join(fixturesRoot, "project-a");
  });

  afterEach(async () => {
    await cleanupTempDir(fixturesRoot);
  });

  // AC: @daemon-file-monitoring ac-2
  it("fires when session metadata changes under .kspec-sessions", async () => {
    const onSessionChange = vi.fn();
    const sessionDir = join(projectDir, ".kspec-sessions", "01JTESTSESSIONWATCHER0000001");
    await mkdir(sessionDir, { recursive: true });
    const metadataPath = join(sessionDir, "session.yaml");
    await writeFile(
      metadataPath,
      [
        "id: 01JTESTSESSIONWATCHER0000001",
        "agent_type: task-worker",
        "status: active",
        'started_at: "2026-03-19T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: vi.fn(),
    });

    await watcher.start();

    await writeFile(
      metadataPath,
      [
        "id: 01JTESTSESSIONWATCHER0000001",
        "agent_type: task-worker",
        "status: completed",
        'started_at: "2026-03-19T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    await waitForDebounce();

    expect(onSessionChange).toHaveBeenCalled();

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-7
  it("starts before .kspec-sessions exists and emits after the directory is created", async () => {
    const onSessionChange = vi.fn();
    const sessionsDir = join(projectDir, ".kspec-sessions");
    await rm(sessionsDir, { recursive: true, force: true });
    const watcher = new SessionWatcher({
      sessionsDir,
      onSessionChange,
      onError: vi.fn(),
    });

    await watcher.start();

    const sessionDir = join(sessionsDir, "01JTESTSESSIONWATCHER0000004");
    const metadataPath = join(sessionDir, "session.yaml");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      metadataPath,
      [
        "id: 01JTESTSESSIONWATCHER0000004",
        "agent_type: task-worker",
        "status: active",
        'started_at: "2026-03-19T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    await waitForDebounce();

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledWith(sessionDir);

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-2
  it("fires when session event logs change", async () => {
    const onSessionChange = vi.fn();
    const sessionDir = join(projectDir, ".kspec-sessions", "01JTESTSESSIONWATCHER0000005");
    await mkdir(sessionDir, { recursive: true });
    const eventsPath = join(sessionDir, "events.jsonl");
    await writeFile(eventsPath, '{"type":"session.started"}\n');

    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: vi.fn(),
    });

    await watcher.start();

    await writeFile(eventsPath, '{"type":"session.updated"}\n', { flag: "a" });
    await waitForDebounce();

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledWith(sessionDir);

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-2
  // AC: @daemon-file-monitoring ac-3
  it("ignores blob subtree writes so content storage does not trigger monitoring", async () => {
    const onSessionChange = vi.fn();
    const sessionDir = join(projectDir, ".kspec-sessions", "01JTESTSESSIONWATCHER0000006");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.yaml"), "status: active\n");

    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: vi.fn(),
    });

    await watcher.start();
    onSessionChange.mockClear();

    const blobDir = join(sessionDir, "blobs");
    await mkdir(blobDir, { recursive: true });
    await writeFile(join(blobDir, "payload.blob"), "externalized content\n");
    await waitForDebounce();

    expect(onSessionChange).not.toHaveBeenCalled();

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-3
  const itWithProcFd = existsSync("/proc/self/fd") ? it : it.skip;
  itWithProcFd("keeps open file descriptor usage flat when blob file volume increases", async () => {
    async function measureWatcherDelta(
      sessionId: string,
      blobCount: number,
    ): Promise<number> {
      const sessionsDir = join(projectDir, ".kspec-sessions");
      const sessionDir = join(sessionsDir, sessionId);
      const blobDir = join(sessionDir, "blobs");
      await mkdir(blobDir, { recursive: true });
      await writeFile(join(sessionDir, "session.yaml"), "status: active\n");
      await writeFile(join(sessionDir, "events.jsonl"), '{"type":"session.started"}\n');

      for (let index = 0; index < blobCount; index++) {
        await writeFile(join(blobDir, `payload-${index}.blob`), `blob ${index}\n`);
      }

      const baselineFdCount = await countOpenFileDescriptors();
      const watcher = new SessionWatcher({
        sessionsDir,
        onSessionChange: vi.fn(),
        onError: vi.fn(),
      });

      try {
        await watcher.start();
        await waitForDebounce();

        const watcherFdCount = await countOpenFileDescriptors();
        return watcherFdCount - baselineFdCount;
      } finally {
        await watcher.stop();
        await waitForDebounce();
      }
    }

    const lowBlobFootprint = await measureWatcherDelta("01JTESTSESSIONWATCHER0000008", 1);
    const highBlobFootprint = await measureWatcherDelta("01JTESTSESSIONWATCHER0000009", 250);

    expect(lowBlobFootprint).toBeGreaterThanOrEqual(0);
    expect(highBlobFootprint).toBeGreaterThanOrEqual(0);
    expect(highBlobFootprint - lowBlobFootprint).toBeLessThanOrEqual(1);
  });

  // AC: @daemon-file-monitoring ac-2
  it("ignores non-metadata file types in session directories", async () => {
    const onSessionChange = vi.fn();
    const sessionDir = join(projectDir, ".kspec-sessions", "01JTESTSESSIONWATCHER0000007");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.yaml"), "status: active\n");

    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: vi.fn(),
    });

    await watcher.start();
    onSessionChange.mockClear();

    await writeFile(join(sessionDir, "notes.txt"), "ignored\n");
    await waitForDebounce();

    expect(onSessionChange).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it("coalesces one logical session creation into a single callback", async () => {
    const onSessionChange = vi.fn();
    const sessionsDir = join(projectDir, ".kspec-sessions");
    await mkdir(sessionsDir, { recursive: true });
    const watcher = new SessionWatcher({
      sessionsDir,
      onSessionChange,
      onError: vi.fn(),
    });

    await watcher.start();

    const sessionDir = join(projectDir, ".kspec-sessions", "01JTESTSESSIONWATCHER0000003");
    const metadataPath = join(sessionDir, "session.yaml");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      metadataPath,
      [
        "id: 01JTESTSESSIONWATCHER0000003",
        "agent_type: task-worker",
        "status: active",
        'started_at: "2026-03-19T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    await waitForDebounce();

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledWith(sessionDir);

    await watcher.stop();
  });

  it("stops emitting after watcher stop", async () => {
    const onSessionChange = vi.fn();
    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: vi.fn(),
    });

    await watcher.start();
    await watcher.stop();

    const sessionDir = join(projectDir, ".kspec-sessions", "01JTESTSESSIONWATCHER0000002");
    await mkdir(sessionDir, { recursive: true });
    const metadataPath = join(sessionDir, "session.yaml");
    await writeFile(
      metadataPath,
      [
        "id: 01JTESTSESSIONWATCHER0000002",
        "agent_type: task-worker",
        "status: completed",
        'started_at: "2026-03-19T12:00:00.000Z"',
        "",
      ].join("\n"),
    );

    await waitForDebounce();

    expect(onSessionChange).not.toHaveBeenCalled();
  });
});
