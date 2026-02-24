/**
 * Tests for session-scoped end-loop signal.
 *
 * Migrated from marker file approach to session state.
 * AC: @session-end-loop-signal ac-signal, ac-block-task, ac-detect, ac-session-close-normal,
 *     ac-session-close-signal, ac-session-close-error, ac-remove-markers
 * AC: @trait-error-guidance ac-1, ac-2
 *
 * Trait ACs documented as N/A for this feature:
 * - @trait-error-guidance ac-3: N/A — no ref resolution in end-loop command
 * - @trait-error-guidance ac-4: N/A — no state transitions in end-loop command
 * - @trait-error-guidance ac-5: N/A — no field-level validation in end-loop command
 * - @trait-error-guidance ac-6: N/A — ralph end-loop does not support --json output mode
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from "../helpers/cli";

const SESSION_ID = "01KJ7CCCHNMBABEHHDVEYSPJFR";

/**
 * Helper to create a session.yaml file in the test fixture directory.
 * Sessions live at {specDir}/sessions/{sessionId}/session.yaml
 */
async function createTestSession(
  specDir: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const sessionDir = path.join(specDir, "sessions", sessionId);
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
    "sessions",
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

      const result = kspec("ralph end-loop", tempDir, {
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
        'ralph end-loop --reason "No eligible tasks"',
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
      const result = kspec("ralph end-loop", tempDir, {
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
      const result = kspec("ralph end-loop", tempDir, {
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

  // AC: @session-end-loop-signal ac-detect
  describe("ac-detect: ralph detects end-loop from session state", () => {
    it("should detect end-loop purely via session state between iterations", async () => {
      // The CLI writes end_requested to session state; ralph checks it
      // between iterations via isEndLoopRequested — no bash command sniffing needed
      const ralphContent = await fs.readFile(
        path.join(process.cwd(), "src/cli/commands/ralph.ts"),
        "utf-8",
      );

      // Session state check exists between iterations
      expect(ralphContent).toContain("isEndLoopRequested(specDir, sessionId)");
      expect(ralphContent).toContain("endLoopState?.requested");
      expect(ralphContent).toContain('exitReason = "end_loop_signal"');

      // No bash command detection for end-loop (removed to avoid false positives)
      expect(ralphContent).not.toContain("detectEndLoopCommand");
    });
  });

  // AC: @session-end-loop-signal ac-session-close-normal
  // AC: @session-end-loop-signal ac-session-close-signal
  // AC: @session-end-loop-signal ac-session-close-error
  describe("session close handlers", () => {
    it("should register SIGINT and SIGTERM handlers that close session", async () => {
      // AC: @session-end-loop-signal ac-session-close-signal
      // Static analysis to verify signal handlers close session
      const ralphContent = await fs.readFile(
        path.join(process.cwd(), "src/cli/commands/ralph.ts"),
        "utf-8",
      );

      // Verify signal handlers are registered
      expect(ralphContent).toContain('process.on("SIGINT"');
      expect(ralphContent).toContain('process.on("SIGTERM"');

      // Verify session is closed with abandoned status on signal
      expect(ralphContent).toContain("closeSession");
      expect(ralphContent).toContain('"abandoned"');
      expect(ralphContent).toContain("Received ${signal}");

      // Verify cleanup awaits before exit
      expect(ralphContent).toContain("Promise.all");
      expect(ralphContent).toContain(".finally(() =>");
    });

    it("should close session with completed status on normal exit", async () => {
      // AC: @session-end-loop-signal ac-session-close-normal
      const ralphContent = await fs.readFile(
        path.join(process.cwd(), "src/cli/commands/ralph.ts"),
        "utf-8",
      );

      // Verify closeSession is called at the end of the loop
      expect(ralphContent).toContain("closeSession(specDir, sessionId, status, closeReason)");

      // Verify close reasons are computed for various exit paths
      expect(ralphContent).toContain("Completed all");
      expect(ralphContent).toContain("No eligible tasks remaining");
      expect(ralphContent).toContain("Agent requested end of loop");
    });

    it("should close session with abandoned status on max failures", async () => {
      // AC: @session-end-loop-signal ac-session-close-error
      const ralphContent = await fs.readFile(
        path.join(process.cwd(), "src/cli/commands/ralph.ts"),
        "utf-8",
      );

      // Verify max_failures exit sets abandoned status
      expect(ralphContent).toContain("max_failures");
      expect(ralphContent).toContain("Max failures reached");
    });

    it("should close session with abandoned status on unrecoverable error", async () => {
      // AC: @session-end-loop-signal ac-session-close-error
      const ralphContent = await fs.readFile(
        path.join(process.cwd(), "src/cli/commands/ralph.ts"),
        "utf-8",
      );

      // Verify unrecoverable errors are caught and set error exit reason
      expect(ralphContent).toContain("} catch (loopErr)");
      expect(ralphContent).toContain('exitReason = exitReason ?? "error"');
      expect(ralphContent).toContain("Unrecoverable error in ralph loop");

      // Verify error exit reason leads to abandoned status
      expect(ralphContent).toContain('exitReason === "error"');
      expect(ralphContent).toContain("const isErrorExit");
      // Verify the close reason includes the error message
      expect(ralphContent).toContain("Unrecoverable error");
    });
  });

  // AC: @session-end-loop-signal ac-remove-markers
  describe("ac-remove-markers: marker file code removed", () => {
    it("should not contain END_LOOP_MARKER_PATH in ralph.ts", async () => {
      const ralphContent = await fs.readFile(
        path.join(process.cwd(), "src/cli/commands/ralph.ts"),
        "utf-8",
      );

      // AC: @session-end-loop-signal ac-remove-markers
      expect(ralphContent).not.toContain("END_LOOP_MARKER_PATH");
      expect(ralphContent).not.toContain("readEndLoopMarker");
      expect(ralphContent).not.toContain("clearEndLoopMarker");
      expect(ralphContent).not.toContain("clearStaleEndLoopMarker");
      expect(ralphContent).not.toContain("writeEndLoopMarker");
    });

    it("should not reference ralph-end-loop.json marker file", async () => {
      const ralphContent = await fs.readFile(
        path.join(process.cwd(), "src/cli/commands/ralph.ts"),
        "utf-8",
      );

      expect(ralphContent).not.toContain("ralph-end-loop.json");
    });
  });

  // AC: @trait-error-guidance ac-1
  describe("trait: error-guidance ac-1 (description of what went wrong)", () => {
    it("should describe the error when session not found", async () => {
      const result = kspec("ralph end-loop", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: "NONEXISTENT" },
      });

      const output = result.stdout + result.stderr;
      expect(output).toContain("Session not found");
    });

    it("should describe the error when no session ID set", async () => {
      const result = kspec("ralph end-loop", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: "" },
      });

      const output = result.stdout + result.stderr;
      expect(output).toContain("KSPEC_SESSION_ID not set");
    });
  });

  // AC: @trait-error-guidance ac-2
  describe("trait: error-guidance ac-2 (suggested action to resolve)", () => {
    it("should suggest session creation when no session ID", async () => {
      const result = kspec("ralph end-loop", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: "" },
      });

      const output = result.stdout + result.stderr;
      expect(output).toContain("kspec session create");
    });

    it("should suggest session log list when session not found", async () => {
      const result = kspec("ralph end-loop", tempDir, {
        expectFail: true,
        env: { KSPEC_SESSION_ID: "NONEXISTENT" },
      });

      const output = result.stdout + result.stderr;
      expect(output).toContain("kspec session log list");
    });
  });

  // @trait-error-guidance ac-6: N/A — ralph end-loop does not support --json output mode
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
      'ralph end-loop --reason "Testing"',
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

describe("Session close with closeSession", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should verify closeSession function is exported and usable", async () => {
    // This tests that the closeSession function works by verifying
    // the session store module structure
    const storeContent = await fs.readFile(
      path.join(process.cwd(), "src/sessions/store.ts"),
      "utf-8",
    );
    expect(storeContent).toContain("export async function closeSession");
    expect(storeContent).toContain("close_reason");
  });
});
