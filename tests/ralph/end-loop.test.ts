/**
 * Tests for session-scoped end-loop signal.
 *
 * Migrated from marker file approach to session state.
 * AC: @session-end-loop-signal ac-signal, ac-block-task
 * AC: @trait-error-guidance ac-1, ac-2
 * AC: @trait-error-guidance ac-3 N/A — no ref resolution in end-loop command
 * AC: @trait-error-guidance ac-4 N/A — no state transitions in end-loop command
 * AC: @trait-error-guidance ac-5 N/A — no field-level validation in end-loop command
 * AC: @trait-error-guidance ac-6 N/A — agent end-loop does not support --json output mode
 * AC: @session-end-loop-signal ac-detect — N/A: tested implicitly via ac-block-task; task start
 *     and ralph both call isEndLoopRequested(). Integration verified in session-budget-integration.test.ts.
 * AC: @session-end-loop-signal ac-remove-markers — N/A: static absence check for removed code
 *     (END_LOOP_MARKER_PATH, readEndLoopMarker, etc.). Removed code does not need ongoing guard tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  kspec,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from "../helpers/cli";

const SESSION_ID = "01KJ7CCCHNMBABEHHDVEYSPJFR";

/**
 * Helper to create a session.yaml file in the test fixture directory.
 * Sessions live at {projectRoot}/.kspec-sessions/{sessionId}/session.yaml
 */
async function createTestSession(
  specDir: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const sessionDir = path.join(specDir, ".kspec-sessions", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const metadata = {
    id: sessionId,
    agent_type: "ralph",
    status: "active",
    started_at: new Date().toISOString(),
    ...overrides,
  };
  await fs.writeFile(
    path.join(sessionDir, "session.yaml"),
    YAML.stringify(metadata, { indent: 2, lineWidth: 100, sortMapEntries: false }),
  );
}

/**
 * Helper to read session metadata.
 */
async function readTestSession(
  specDir: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const sessionPath = path.join(
    specDir,
    ".kspec-sessions",
    sessionId,
    "session.yaml",
  );
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    return YAML.parse(content);
  } catch {
    return null;
  }
}

describe("Session-scoped end-loop signal", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-end-loop-signal ac-signal
  describe("ac-signal: end-loop writes to session state", () => {
    it("should write end_requested=true to session metadata", async () => {
      await createTestSession(tempDir, SESSION_ID);

      const result = kspec("agent end-loop", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Loop end signal sent");

      // Verify session state was updated
      const session = await readTestSession(tempDir, SESSION_ID);
      expect(session).not.toBeNull();
      expect(session!.end_requested).toBe(true);
    });

    it("should include reason in session metadata when provided", async () => {
      await createTestSession(tempDir, SESSION_ID);

      // AC: @session-end-loop-signal ac-signal
      const result = kspec(
        'agent end-loop --reason "No eligible tasks"',
        tempDir,
        { env: { KSPEC_SESSION_ID: SESSION_ID } },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Reason: No eligible tasks");

      const session = await readTestSession(tempDir, SESSION_ID);
      expect(session!.end_requested).toBe(true);
      expect(session!.end_reason).toBe("No eligible tasks");
    });

    it("should fail with exit code 4 when KSPEC_SESSION_ID is not set", async () => {
      // AC: @trait-error-guidance ac-1, ac-2
      const result = kspec("agent end-loop", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: "" },
      });

      expect(result.exitCode).toBe(4);
      const output = result.stdout + result.stderr;
      expect(output).toContain("KSPEC_SESSION_ID not set");
      expect(output).toContain("kspec session create");
    });

    it("should fail with exit code 3 when session not found", async () => {
      // AC: @trait-error-guidance ac-1, ac-2
      const result = kspec("agent end-loop", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: "NONEXISTENT_SESSION" },
      });

      expect(result.exitCode).toBe(3);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Session not found");
      expect(output).toContain("kspec session log list");
    });
  });

  // AC: @session-end-loop-signal ac-block-task
  describe("ac-block-task: task start blocked when end-loop requested", () => {
    it("should block task start when end_requested is true", async () => {
      await createTestSession(tempDir, SESSION_ID, {
        end_requested: true,
        end_reason: "Wrapping up",
      });

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      expect(result.exitCode).toBe(4);
      const output = result.stdout + result.stderr;
      expect(output).toContain("loop is ending");
    });

    it("should include end-loop reason in error message", async () => {
      await createTestSession(tempDir, SESSION_ID, {
        end_requested: true,
        end_reason: "No more eligible tasks",
      });

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const output = result.stdout + result.stderr;
      expect(output).toContain("No more eligible tasks");
    });

    it("should include wrap-up guidance in error message", async () => {
      // AC: @trait-error-guidance ac-2
      await createTestSession(tempDir, SESSION_ID, {
        end_requested: true,
      });

      const result = kspec("task start @test-task-pending", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      const output = result.stdout + result.stderr;
      expect(output).toMatch(/[Ww]rap up/);
    });

    it("should allow task start when no session ID is set", async () => {
      // No KSPEC_SESSION_ID means no end-loop check
      await createTestSession(tempDir, SESSION_ID, {
        end_requested: true,
      });

      const result = kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: "" },
      });

      expect(result.exitCode).toBe(0);
    });

    it("should allow task start when end_requested is not set", async () => {
      await createTestSession(tempDir, SESSION_ID);

      const result = kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      expect(result.exitCode).toBe(0);
    });

    it("should allow task start when session is completed even with end_requested", async () => {
      // Stale session: completed but end_requested is still true
      await createTestSession(tempDir, SESSION_ID, {
        end_requested: true,
        end_reason: "Previous loop ended",
        status: "completed",
        ended_at: new Date().toISOString(),
        close_reason: "No eligible tasks remaining",
      });

      const result = kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      // Should succeed — completed sessions don't block task starts
      expect(result.exitCode).toBe(0);
    });

    it("should allow task start when session is abandoned even with end_requested", async () => {
      // Stale session: abandoned but end_requested is still true
      await createTestSession(tempDir, SESSION_ID, {
        end_requested: true,
        status: "abandoned",
        ended_at: new Date().toISOString(),
        close_reason: "Received SIGINT",
      });

      const result = kspec("task start @test-task-pending", tempDir, {
        env: { KSPEC_SESSION_ID: SESSION_ID },
      });

      // Should succeed — abandoned sessions don't block task starts
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("Session store: requestEndLoop and isEndLoopRequested", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should write end_requested and end_reason to session", async () => {
    await createTestSession(tempDir, SESSION_ID);

    // Use end-loop command with session
    const result = kspec(
      'agent end-loop --reason "Testing"',
      tempDir,
      { env: { KSPEC_SESSION_ID: SESSION_ID } },
    );
    expect(result.exitCode).toBe(0);

    // Verify the session YAML was updated
    const session = await readTestSession(tempDir, SESSION_ID);
    expect(session!.end_requested).toBe(true);
    expect(session!.end_reason).toBe("Testing");
    // Original fields should be preserved
    expect(session!.status).toBe("active");
    expect(session!.agent_type).toBe("ralph");
  });

  it("should report end-loop not requested for fresh session", async () => {
    await createTestSession(tempDir, SESSION_ID);

    // Task start should succeed (no end-loop requested)
    const result = kspec("task start @test-task-pending", tempDir, {
      env: { KSPEC_SESSION_ID: SESSION_ID },
    });
    expect(result.exitCode).toBe(0);
  });

  it("should ignore end_requested for non-active sessions", async () => {
    // end_requested=true but session is completed — should not block
    await createTestSession(tempDir, SESSION_ID, {
      end_requested: true,
      end_reason: "Old reason",
      status: "completed",
    });

    // Verify at the CLI level: task start should succeed
    const result = kspec("task start @test-task-pending", tempDir, {
      env: { KSPEC_SESSION_ID: SESSION_ID },
    });
    expect(result.exitCode).toBe(0);
  });
});
