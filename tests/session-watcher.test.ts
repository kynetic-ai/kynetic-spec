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

async function waitForMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function countOpenFileDescriptors(): Promise<number> {
  return (await readdir("/proc/self/fd")).length;
}

function createSessionChangeHandler() {
  return vi.fn<(file: string) => void>();
}

function createErrorHandler() {
  return vi.fn<(error: Error, file?: string) => void>();
}

async function writeSessionFixture(
  projectDir: string,
  sessionId: string,
  status: "active" | "completed" | "abandoned" | "timed_out" | "failed" | "stalled",
): Promise<string> {
  const sessionDir = join(projectDir, ".kspec-sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });

  const lines = [
    `id: ${sessionId}`,
    "agent_type: task-worker",
    `status: ${status}`,
    'started_at: "2026-03-19T12:00:00.000Z"',
  ];

  if (status !== "active") {
    lines.push('ended_at: "2026-03-19T12:05:00.000Z"');
  }

  lines.push("");

  await writeFile(join(sessionDir, "session.yaml"), lines.join("\n"));
  await writeFile(join(sessionDir, "events.jsonl"), '{"type":"session.started"}\n');
  return sessionDir;
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

  // AC: @daemon-file-monitoring ac-active-only-watching
  // AC: @daemon-file-monitoring ac-startup-active-only
  it("only watches active sessions that exist when monitoring starts", async () => {
    const onSessionChange = createSessionChangeHandler();
    const activeDir = await writeSessionFixture(
      projectDir,
      "01JTESTSESSIONWATCHER0000001",
      "active",
    );
    const completedDir = await writeSessionFixture(
      projectDir,
      "01JTESTSESSIONWATCHER0000002",
      "completed",
    );

    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: createErrorHandler(),
    });

    await watcher.start();
    onSessionChange.mockClear();

    await writeFile(join(activeDir, "events.jsonl"), '{"type":"session.updated"}\n', { flag: "a" });
    await writeFile(join(completedDir, "events.jsonl"), '{"type":"session.updated"}\n', {
      flag: "a",
    });
    await waitForDebounce();

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledWith(activeDir);

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-7
  // AC: @daemon-file-monitoring ac-new-session-conditional-watch
  // AC: @daemon-sensitive-cli-test-determinism ac-bounded-readiness
  it("detects a new active session created after monitoring starts", async () => {
    const onSessionChange = createSessionChangeHandler();
    const sessionsDir = join(projectDir, ".kspec-sessions");
    await rm(sessionsDir, { recursive: true, force: true });

    const watcher = new SessionWatcher({
      sessionsDir,
      onSessionChange,
      onError: createErrorHandler(),
    });

    await watcher.start();

    const sessionId = "01JTESTSESSIONWATCHER0000003";
    const sessionDir = join(sessionsDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeSessionFixture(projectDir, sessionId, "active");

    await vi.waitFor(
      () => {
        expect(onSessionChange).toHaveBeenCalledTimes(1);
        expect(onSessionChange).toHaveBeenCalledWith(sessionDir);
      },
      { timeout: process.env.CI ? 3000 : 2000 },
    );

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-7
  // AC: @daemon-file-monitoring ac-new-session-conditional-watch
  it("attaches to a new active session when metadata arrives after the directory", async () => {
    const onSessionChange = createSessionChangeHandler();
    const sessionsDir = join(projectDir, ".kspec-sessions");
    const sessionId = "01JTESTSESSIONWATCHER000000A";
    const sessionDir = join(sessionsDir, sessionId);

    const watcher = new SessionWatcher({
      sessionsDir,
      onSessionChange,
      onError: createErrorHandler(),
    });

    await watcher.start();

    await mkdir(sessionDir, { recursive: true });
    await waitForMs(500);
    await writeSessionFixture(projectDir, sessionId, "active");
    await waitForDebounce();

    await writeFile(join(sessionDir, "events.jsonl"), '{"type":"session.updated"}\n', {
      flag: "a",
    });
    await waitForDebounce();

    expect(onSessionChange).toHaveBeenCalled();
    expect(onSessionChange).toHaveBeenCalledWith(sessionDir);

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-new-session-conditional-watch
  // AC: @daemon-file-monitoring ac-new-session-list-freshness
  // AC: @daemon-file-monitoring ac-new-session-conditional-watch
  it("notifies once on new non-active session arrival but does not watch for ongoing changes", async () => {
    const onSessionChange = createSessionChangeHandler();
    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: createErrorHandler(),
    });

    await watcher.start();

    const sessionDir = await writeSessionFixture(
      projectDir,
      "01JTESTSESSIONWATCHER0000004",
      "completed",
    );
    await waitForDebounce();

    // Exactly one notification so the sessions domain cache invalidates and
    // surfaces the new session in list responses.
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledWith(sessionDir);

    // No per-session watcher attached — subsequent writes inside the
    // completed session directory must not trigger additional callbacks.
    onSessionChange.mockClear();
    await writeFile(join(sessionDir, "events.jsonl"), '{"type":"session.updated"}\n', {
      flag: "a",
    });
    await waitForDebounce();

    expect(onSessionChange).not.toHaveBeenCalled();

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-2
  it("fires when active session event logs change", async () => {
    const onSessionChange = createSessionChangeHandler();
    const sessionDir = await writeSessionFixture(
      projectDir,
      "01JTESTSESSIONWATCHER0000005",
      "active",
    );
    const eventsPath = join(sessionDir, "events.jsonl");

    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: createErrorHandler(),
    });

    await watcher.start();

    await writeFile(eventsPath, '{"type":"session.updated"}\n', { flag: "a" });
    await waitForDebounce();

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledWith(sessionDir);

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-2
  it("ignores blob subtree writes so content storage does not trigger monitoring", async () => {
    const onSessionChange = createSessionChangeHandler();
    const sessionDir = await writeSessionFixture(
      projectDir,
      "01JTESTSESSIONWATCHER0000006",
      "active",
    );

    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: createErrorHandler(),
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

  // AC: @daemon-file-monitoring ac-2
  it("ignores non-metadata file types in active session directories", async () => {
    const onSessionChange = createSessionChangeHandler();
    const sessionDir = await writeSessionFixture(
      projectDir,
      "01JTESTSESSIONWATCHER0000007",
      "active",
    );

    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: createErrorHandler(),
    });

    await watcher.start();
    onSessionChange.mockClear();

    await writeFile(join(sessionDir, "notes.txt"), "ignored\n");
    await waitForDebounce();

    expect(onSessionChange).not.toHaveBeenCalled();

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-session-close-unwatch
  it("removes the per-session watch after a session becomes non-active", async () => {
    const onSessionChange = createSessionChangeHandler();
    const sessionId = "01JTESTSESSIONWATCHER0000008";
    const sessionDir = await writeSessionFixture(projectDir, sessionId, "active");
    const metadataPath = join(sessionDir, "session.yaml");
    const eventsPath = join(sessionDir, "events.jsonl");

    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: createErrorHandler(),
    });

    await watcher.start();
    onSessionChange.mockClear();

    await writeFile(
      metadataPath,
      [
        `id: ${sessionId}`,
        "agent_type: task-worker",
        "status: completed",
        'started_at: "2026-03-19T12:00:00.000Z"',
        'ended_at: "2026-03-19T12:05:00.000Z"',
        "",
      ].join("\n"),
    );
    await waitForDebounce();

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledWith(sessionDir);

    onSessionChange.mockClear();
    await writeFile(eventsPath, '{"type":"session.updated"}\n', { flag: "a" });
    await waitForDebounce();

    expect(onSessionChange).not.toHaveBeenCalled();

    await watcher.stop();
  });

  // AC: @daemon-file-monitoring ac-3
  // AC: @daemon-file-monitoring ac-active-only-watching
  // AC: @daemon-file-monitoring ac-startup-active-only
  const itWithProcFd = existsSync("/proc/self/fd") ? it : it.skip;
  itWithProcFd("keeps open file descriptor usage tied to active sessions", async () => {
    async function measureWatcherDelta(
      activeCount: number,
      inactiveCount: number,
    ): Promise<number> {
      const sessionsDir = join(projectDir, ".kspec-sessions");
      await rm(sessionsDir, { recursive: true, force: true });
      await mkdir(sessionsDir, { recursive: true });

      for (let index = 0; index < activeCount; index++) {
        await writeSessionFixture(
          projectDir,
          `01JTESTACTIVE${index.toString().padStart(13, "0")}`,
          "active",
        );
      }

      const terminalStatuses = [
        "completed",
        "abandoned",
        "timed_out",
        "failed",
        "stalled",
      ] as const;
      for (let index = 0; index < inactiveCount; index++) {
        const status = terminalStatuses[index % terminalStatuses.length];
        await writeSessionFixture(
          projectDir,
          `01JTESTINACTIVE${index.toString().padStart(11, "0")}`,
          status,
        );
      }

      const baselineFdCount = await countOpenFileDescriptors();
      const watcher = new SessionWatcher({
        sessionsDir,
        onSessionChange: createSessionChangeHandler(),
        onError: createErrorHandler(),
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

    const fewInactive = await measureWatcherDelta(2, 2);
    const manyInactive = await measureWatcherDelta(2, 40);

    // oxlint-disable-next-line no-standalone-expect -- inside itWithProcFd (conditional it/it.skip)
    expect(fewInactive).toBeGreaterThanOrEqual(0);
    // oxlint-disable-next-line no-standalone-expect -- inside itWithProcFd (conditional it/it.skip)
    expect(manyInactive).toBeGreaterThanOrEqual(0);
    // oxlint-disable-next-line no-standalone-expect -- inside itWithProcFd (conditional it/it.skip)
    expect(manyInactive - fewInactive).toBeLessThanOrEqual(3);
  });

  it("stops emitting after watcher stop", async () => {
    const onSessionChange = createSessionChangeHandler();
    const watcher = new SessionWatcher({
      sessionsDir: join(projectDir, ".kspec-sessions"),
      onSessionChange,
      onError: createErrorHandler(),
    });

    await watcher.start();
    await watcher.stop();

    await writeSessionFixture(projectDir, "01JTESTSESSIONWATCHER0000009", "active");
    await waitForDebounce();

    expect(onSessionChange).not.toHaveBeenCalled();
  });
});
