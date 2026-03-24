/**
 * Session stale close command tests.
 *
 * Task: @implement-stale-active-session-cleanup
 * Spec: @session-stale-cleanup
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  appendEvent,
  createSession,
  getSession,
  getSessionEventsPath,
} from "../src/sessions/store.js";
import { cleanupTempDir, kspec, kspecJson, setupTempFixtures, testUlid } from "./helpers/cli.js";

interface SessionStaleCloseJson {
  dry_run: boolean;
  mode: "single" | "refs" | "all";
  criteria: {
    older_than: string;
    inactive_for: string;
    liveness_guard: string;
  };
  sessions: Array<{
    session_id: string;
    status: string;
    reason: string;
    close_reason?: string;
  }>;
  totals: {
    active_sessions_total: number;
    sessions_evaluated: number;
    candidates: number;
    changed_sessions: number;
    skipped_sessions: number;
    failures: number;
  };
}

interface JsonErrorPayload {
  success: false;
  error: string;
  details?: {
    field?: string;
    value?: string;
    guidance?: string;
  };
}

describe("session stale close", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    sessionsDir = path.join(tempDir, ".kspec-sessions");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function createActiveSession(
    sessionId: string,
    startedAt: string,
    lastActivityAt?: string,
  ): Promise<void> {
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
      status: "active",
      started_at: startedAt,
    });

    if (lastActivityAt) {
      await appendEvent(sessionsDir, {
        session_id: sessionId,
        type: "session.update",
        ts: new Date(lastActivityAt).getTime(),
        data: { update: "heartbeat" },
      });
    }
  }

  // AC: @session-stale-cleanup ac-1
  // AC: @trait-dry-run ac-1
  // AC: @trait-dry-run ac-2
  // AC: @trait-dry-run ac-3
  // AC: @trait-dry-run ac-6
  // AC: @trait-json-output ac-1
  // AC: @trait-json-output ac-2
  it("reports would-close sessions in --all --dry-run with per-session reasons", async () => {
    const staleId = testUlid("SESS", 1);
    await createActiveSession(staleId, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");

    const result = kspecJson<SessionStaleCloseJson>(
      "session stale close --all --dry-run --older-than 24h --inactive-for 6h",
      tempDir,
    );

    expect(result.mode).toBe("all");
    expect(result.dry_run).toBe(true);
    expect(result.totals.candidates).toBe(1);
    expect(result.totals.changed_sessions).toBe(0);
    expect(result.sessions[0].status).toBe("would_abandon");
    expect(result.sessions[0].reason).toContain("dry run");
    expect(result.sessions[0].close_reason?.startsWith("auto-abandoned:")).toBe(true);

    const unchanged = await getSession(sessionsDir, staleId);
    expect(unchanged?.status).toBe("active");
    expect(unchanged?.ended_at).toBeUndefined();
  });

  // AC: @session-stale-cleanup ac-2
  // AC: @trait-confirmation-prompt ac-4
  it("closes only the targeted stale active session in single-target mode", async () => {
    const targetId = testUlid("SESS", 2);
    const otherId = testUlid("SESS", 3);
    await createActiveSession(targetId, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");
    await createActiveSession(otherId, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");

    const output = kspecJson<SessionStaleCloseJson>(
      `session stale close ${targetId} --older-than 24h --inactive-for 6h --force`,
      tempDir,
    );

    expect(output.mode).toBe("single");
    expect(output.totals.changed_sessions).toBe(1);

    const target = await getSession(sessionsDir, targetId);
    const other = await getSession(sessionsDir, otherId);
    expect(target?.status).toBe("abandoned");
    expect(target?.close_reason?.startsWith("auto-abandoned:")).toBe(true);
    expect(other?.status).toBe("active");
  });

  // AC: @session-stale-cleanup ac-3
  // AC: @trait-semantic-exit-codes ac-1
  // AC: @trait-semantic-exit-codes ac-5
  it("returns success with zero changes when no sessions match stale criteria", async () => {
    const recentId = testUlid("SESS", 4);
    await createActiveSession(recentId, new Date().toISOString());

    const output = kspecJson<SessionStaleCloseJson>(
      `session stale close ${recentId} --older-than 24h --inactive-for 6h --force`,
      tempDir,
    );

    expect(output.totals.candidates).toBe(0);
    expect(output.totals.changed_sessions).toBe(0);
    expect(output.sessions[0].status).toBe("not_candidate");

    const session = await getSession(sessionsDir, recentId);
    expect(session?.status).toBe("active");
  });

  // AC: @session-stale-cleanup ac-4
  // AC: @session-stale-cleanup ac-5
  it("reports all-mode totals for candidates, changed, skipped, and failures", async () => {
    const staleId = testUlid("SESS", 5);
    const freshId = testUlid("SESS", 6);
    const brokenId = testUlid("SESS", 7);

    await createActiveSession(staleId, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");
    await createActiveSession(freshId, new Date().toISOString());
    await createActiveSession(brokenId, "2024-01-01T00:00:00.000Z", undefined);
    await fs.mkdir(getSessionEventsPath(sessionsDir, brokenId), { recursive: true });

    const dryRun = kspecJson<SessionStaleCloseJson>(
      "session stale close --all --dry-run --older-than 24h --inactive-for 6h",
      tempDir,
    );
    expect(dryRun.totals.candidates).toBe(1);
    expect(dryRun.totals.skipped_sessions).toBe(2);
    expect(dryRun.totals.failures).toBe(1);

    const apply = kspecJson<SessionStaleCloseJson>(
      "session stale close --all --older-than 24h --inactive-for 6h --force",
      tempDir,
    );
    expect(apply.totals.changed_sessions).toBe(1);
    expect(apply.totals.candidates).toBe(1);

    const stale = await getSession(sessionsDir, staleId);
    const fresh = await getSession(sessionsDir, freshId);
    const broken = await getSession(sessionsDir, brokenId);
    expect(stale?.status).toBe("abandoned");
    expect(fresh?.status).toBe("active");
    expect(broken?.status).toBe("active");
  });

  // AC: @session-stale-cleanup ac-6
  // AC: @trait-semantic-exit-codes ac-6
  it("errors when no target mode is provided", async () => {
    const result = kspec("session stale close", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing target");
    expect(result.stderr).toContain("<session-id>, --refs, or --all");
  });

  // AC: @session-stale-cleanup ac-7
  it("errors when positional target and --all are combined", async () => {
    const sessionId = testUlid("SESS", 8);
    await createActiveSession(sessionId, "2024-01-01T00:00:00.000Z");

    const result = kspec(`session stale close ${sessionId} --all`, tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Cannot use <session-id> together with --all");
  });

  // AC: @session-stale-cleanup ac-8
  // AC: @trait-multi-ref-batch ac-1
  // AC: @trait-multi-ref-batch ac-3
  // AC: @trait-multi-ref-batch ac-8
  it("evaluates unique sessions only once in --refs mode", async () => {
    const staleId = testUlid("SESS", 9);
    const freshId = testUlid("SESS", 10);
    await createActiveSession(staleId, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");
    await createActiveSession(freshId, new Date().toISOString());

    const output = kspecJson<SessionStaleCloseJson>(
      `session stale close --refs ${staleId} ${staleId} ${freshId} --dry-run --older-than 24h --inactive-for 6h`,
      tempDir,
    );

    const staleRows = output.sessions.filter((row) => row.session_id === staleId);
    expect(staleRows).toHaveLength(1);
    expect(output.totals.sessions_evaluated).toBe(2);
  });

  // AC: @session-stale-cleanup ac-9
  // AC: @trait-multi-ref-batch ac-6
  it("errors when --refs is combined with --all or positional target", async () => {
    const sessionId = testUlid("SESS", 11);
    await createActiveSession(sessionId, "2024-01-01T00:00:00.000Z");

    const withAll = kspec(`session stale close --refs ${sessionId} --all`, tempDir, {
      expectFail: true,
    });
    expect(withAll.exitCode).toBe(2);
    expect(withAll.stderr).toContain("Cannot use --refs together with --all");

    const withPositional = kspec(`session stale close ${sessionId} --refs ${sessionId}`, tempDir, {
      expectFail: true,
    });
    expect(withPositional.exitCode).toBe(2);
    expect(withPositional.stderr).toContain("Cannot use <session-id> together with --refs");
  });

  // AC: @trait-multi-ref-batch ac-2
  // AC: @trait-multi-ref-batch ac-4
  // AC: @trait-multi-ref-batch ac-5
  // AC: @trait-multi-ref-batch ac-7
  // AC: @trait-dry-run ac-4
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-3
  // AC: @trait-error-guidance ac-6
  it("continues refs batch after resolution errors and returns partial-failure exit", async () => {
    const staleId = testUlid("SESS", 12);
    await createActiveSession(staleId, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");

    const result = kspec(
      `session stale close --refs ${staleId} BADREF --dry-run --older-than 24h --inactive-for 6h --json`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(1);

    const payload = JSON.parse(result.stdout) as SessionStaleCloseJson;
    expect(payload.totals.candidates).toBe(1);
    expect(payload.totals.changed_sessions).toBe(0);
    expect(payload.totals.failures).toBe(1);
    expect(payload.sessions.some((row) => row.status === "resolution_error")).toBe(true);
    const resolutionError = payload.sessions.find((row) => row.status === "resolution_error");
    expect(resolutionError?.reason).toContain("Session not found");
    expect(resolutionError?.reason).toContain("kspec session list --status active");

    const unchanged = await getSession(sessionsDir, staleId);
    expect(unchanged?.status).toBe("active");
  });

  // AC: @trait-json-output ac-3
  it("returns structured JSON errors in --json mode", async () => {
    const result = kspec("session stale close --json", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(2);

    const payload = JSON.parse(result.stderr) as JsonErrorPayload;
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("Missing target");
  });

  // AC: @trait-error-guidance ac-5
  it("includes validation field/value details for invalid criteria in JSON mode", async () => {
    const result = kspec("session stale close --all --older-than nope --json", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(2);

    const payload = JSON.parse(result.stderr) as JsonErrorPayload;
    expect(payload.error).toContain("Invalid value for --older-than");
    expect(payload.details?.field).toBe("older-than");
    expect(payload.details?.value).toBe("nope");
  });

  // AC: @trait-confirmation-prompt ac-1
  // AC: @trait-confirmation-prompt ac-6
  it("requires --force in non-interactive destructive mode", async () => {
    const staleId = testUlid("SESS", 13);
    await createActiveSession(staleId, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");

    const result = kspec(
      `session stale close ${staleId} --older-than 24h --inactive-for 6h`,
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Non-interactive environment. Use --force to proceed");
  });

  // AC: @trait-confirmation-prompt ac-3
  // AC: @trait-semantic-exit-codes ac-3
  it("returns cancellation exit when user declines interactive confirmation", async () => {
    const staleId = testUlid("SESS", 14);
    await createActiveSession(staleId, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");

    const result = kspec(
      `session stale close ${staleId} --older-than 24h --inactive-for 6h`,
      tempDir,
      {
        expectFail: true,
        stdin: "n",
        env: {
          KSPEC_TEST_TTY: "1",
        },
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Operation cancelled");
  });

  // AC: @trait-confirmation-prompt ac-2
  it("proceeds when user confirms interactive prompt in single-target mode", async () => {
    const staleId = testUlid("SESS", 15);
    await createActiveSession(staleId, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");

    const result = kspec(
      `session stale close ${staleId} --older-than 24h --inactive-for 6h`,
      tempDir,
      {
        stdin: "yes",
        env: {
          KSPEC_TEST_TTY: "1",
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Auto-abandon this stale session? [y/N]");

    const session = await getSession(sessionsDir, staleId);
    expect(session?.status).toBe("abandoned");
    expect(session?.close_reason?.startsWith("auto-abandoned:")).toBe(true);
  });

  // AC: @trait-confirmation-prompt ac-5
  it("uses a single confirmation prompt for destructive --refs batch mode", async () => {
    const staleA = testUlid("SESS", 16);
    const staleB = testUlid("SESS", 17);
    await createActiveSession(staleA, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");
    await createActiveSession(staleB, "2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z");

    const result = kspec(
      `session stale close --refs ${staleA} ${staleB} --older-than 24h --inactive-for 6h`,
      tempDir,
      {
        stdin: "y",
        env: {
          KSPEC_TEST_TTY: "1",
        },
      },
    );

    expect(result.exitCode).toBe(0);
    const promptCount = result.stdout.match(/from --refs\? \[y\/N\]/g)?.length ?? 0;
    expect(promptCount).toBe(1);

    const first = await getSession(sessionsDir, staleA);
    const second = await getSession(sessionsDir, staleB);
    expect(first?.status).toBe("abandoned");
    expect(second?.status).toBe("abandoned");
  });

  // AC: @trait-dry-run ac-5
  // AC: @trait-json-output ac-4 -- N/A: session IDs are identifiers, not @ref-index references.
  // AC: @trait-json-output ac-5 -- N/A: this command does not emit timestamps in top-level totals.
  // AC: @trait-json-output ac-6 -- N/A: no competing output-format flags beyond global --json.
  // AC: @trait-semantic-exit-codes ac-2 -- covered by usage-error validation tests above.
  // AC: @trait-semantic-exit-codes ac-4 -- covered by malformed criteria and runtime exception path.
  // AC: @trait-semantic-exit-codes ac-7 -- covered by refs partial-failure test above.
  // AC: @trait-semantic-exit-codes ac-8 -- N/A: exit code constants documented centrally.
  // AC: @trait-error-guidance ac-4 -- N/A: command has no state machine transitions; only validation/lookup errors.
  // AC: @trait-shadow-commit ac-1 -- N/A: session operations no longer commit to kspec-meta (session storage separation).
  // AC: @trait-shadow-commit ac-2 -- N/A: session operations no longer commit to kspec-meta.
  // AC: @trait-shadow-commit ac-3 -- N/A: session operations no longer commit to kspec-meta.
  // AC: @trait-shadow-commit ac-4 -- N/A: session operations no longer commit to kspec-meta.
  // AC: @trait-shadow-commit ac-5 -- N/A: session operations no longer commit to kspec-meta.
  // AC: @trait-shadow-commit ac-6 -- N/A: session operations no longer commit to kspec-meta.
  // AC: @trait-shadow-commit ac-7 -- N/A: session operations no longer commit to kspec-meta.
  // AC: @trait-shadow-commit ac-8 -- N/A: session operations no longer commit to kspec-meta.
});
