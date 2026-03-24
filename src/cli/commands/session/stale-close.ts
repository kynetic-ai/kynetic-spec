/**
 * Session stale close command.
 *
 * Orchestrates stale-session candidate selection + auto-abandon metadata apply.
 */

import { initContext } from "../../../parser/index.js";
import {
  applyAutoAbandonMetadata,
  getSession,
  resolveSessionId,
  resolveStaleSessionCriteria,
  selectStaleActiveSessions,
  type StaleSessionEvaluation,
  type StaleSessionSkipped,
} from "../../../sessions/store.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { error, isJsonMode, output } from "../../output.js";

interface SessionStaleCloseOptions {
  refs?: string[];
  all?: boolean;
  dryRun?: boolean;
  force?: boolean;
  olderThan?: string;
  inactiveFor?: string;
  livenessGuard?: string;
}

type TargetMode = "single" | "refs" | "all";

type ResultStatus =
  | "would_abandon"
  | "abandoned"
  | "not_candidate"
  | "not_active"
  | "skipped_error"
  | "resolution_error";

interface SessionStaleCloseResult {
  session_id: string;
  status: ResultStatus;
  reason: string;
  close_reason?: string;
  input_ref?: string;
  started_at?: string;
  last_activity_at?: string;
  last_activity_source?: "event" | "started_at";
  meets_age_threshold?: boolean;
  meets_inactivity_threshold?: boolean;
  blocked_by_liveness_guard?: boolean;
}

interface SessionStaleClosePayload {
  dry_run: boolean;
  mode: TargetMode;
  criteria: {
    older_than: string;
    inactive_for: string;
    liveness_guard: string;
  };
  targets: {
    session_id?: string;
    refs?: string[];
    all: boolean;
  };
  sessions: SessionStaleCloseResult[];
  totals: {
    active_sessions_total: number;
    sessions_evaluated: number;
    candidates: number;
    changed_sessions: number;
    skipped_sessions: number;
    failures: number;
  };
}

interface ResolvedTarget {
  inputRef: string;
  sessionId: string;
}

function normalizeSessionRef(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

function describeNotCandidate(evaluation: StaleSessionEvaluation): string {
  if (evaluation.blockedByLivenessGuard) {
    return "Session has recent activity inside liveness guard window";
  }
  if (!evaluation.meetsAgeThreshold && !evaluation.meetsInactivityThreshold) {
    return "Session does not meet older-than or inactive-for thresholds";
  }
  if (!evaluation.meetsAgeThreshold) {
    return "Session does not meet older-than threshold";
  }
  if (!evaluation.meetsInactivityThreshold) {
    return "Session does not meet inactive-for threshold";
  }
  return "Session is not eligible for stale auto-close";
}

async function promptConfirmation(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });

  rl.close();
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

function buildConfirmationQuestion(mode: TargetMode, candidates: number): string {
  if (mode === "single") {
    return "Auto-abandon this stale session? [y/N] ";
  }
  if (mode === "refs") {
    return `Auto-abandon ${candidates} stale session(s) from --refs? [y/N] `;
  }
  return `Auto-abandon ${candidates} stale active session(s)? [y/N] `;
}

export async function sessionStaleCloseAction(
  sessionIdOrPrefix: string | undefined,
  options: SessionStaleCloseOptions,
): Promise<void> {
  try {
    const ctx = await initContext();

    const refs = options.refs ?? [];
    const hasRefs = refs.length > 0;
    const hasSingleTarget = typeof sessionIdOrPrefix === "string";
    const allMode = options.all === true;
    const dryRun = options.dryRun === true;

    if (!allMode && !hasSingleTarget && !hasRefs) {
      error(
        "Missing target. Provide <session-id>, --refs, or --all.",
        "Try: kspec session stale close <session-id> | --refs <session-id...> | --all",
      );
      process.exit(EXIT_CODES.USAGE_ERROR);
    }

    if (allMode && hasSingleTarget) {
      error("Cannot use <session-id> together with --all");
      process.exit(EXIT_CODES.USAGE_ERROR);
    }

    if (allMode && hasRefs) {
      error("Cannot use --refs together with --all");
      process.exit(EXIT_CODES.USAGE_ERROR);
    }

    if (hasSingleTarget && hasRefs) {
      error("Cannot use <session-id> together with --refs");
      process.exit(EXIT_CODES.USAGE_ERROR);
    }

    const resolvedCriteria = resolveStaleSessionCriteria({
      olderThan: options.olderThan,
      inactiveFor: options.inactiveFor,
      livenessGuard: options.livenessGuard,
    });

    if (!resolvedCriteria.ok) {
      error(resolvedCriteria.message, {
        field: resolvedCriteria.field,
        value: resolvedCriteria.value,
        guidance: resolvedCriteria.guidance,
      });
      process.exit(EXIT_CODES.USAGE_ERROR);
    }

    const selection = await selectStaleActiveSessions(ctx.sessionsDir, {
      olderThan: options.olderThan,
      inactiveFor: options.inactiveFor,
      livenessGuard: options.livenessGuard,
    });

    const evaluationById = new Map(
      selection.evaluations.map((evaluation) => [evaluation.sessionId, evaluation]),
    );
    const skippedById = new Map(selection.skipped.map((skipped) => [skipped.sessionId, skipped]));

    const results: SessionStaleCloseResult[] = [];
    const targetCandidates: StaleSessionEvaluation[] = [];
    let failures = 0;

    let mode: TargetMode;
    let targetSessionId: string | undefined;
    const targetRefs: string[] = [];

    if (allMode) {
      mode = "all";

      for (const skipped of selection.skipped) {
        results.push({
          session_id: skipped.sessionId,
          status: "skipped_error",
          reason: skipped.detail,
        });
      }

      for (const evaluation of selection.evaluations) {
        if (evaluation.eligible) {
          targetCandidates.push(evaluation);
          results.push({
            session_id: evaluation.sessionId,
            status: dryRun ? "would_abandon" : "abandoned",
            reason: "Session meets stale criteria and is eligible for auto-close",
            started_at: evaluation.startedAt,
            last_activity_at: evaluation.lastActivityAt,
            last_activity_source: evaluation.lastActivitySource,
            meets_age_threshold: evaluation.meetsAgeThreshold,
            meets_inactivity_threshold: evaluation.meetsInactivityThreshold,
            blocked_by_liveness_guard: evaluation.blockedByLivenessGuard,
          });
        } else {
          results.push({
            session_id: evaluation.sessionId,
            status: "not_candidate",
            reason: describeNotCandidate(evaluation),
            started_at: evaluation.startedAt,
            last_activity_at: evaluation.lastActivityAt,
            last_activity_source: evaluation.lastActivitySource,
            meets_age_threshold: evaluation.meetsAgeThreshold,
            meets_inactivity_threshold: evaluation.meetsInactivityThreshold,
            blocked_by_liveness_guard: evaluation.blockedByLivenessGuard,
          });
        }
      }

      failures = selection.failureCount;
    } else {
      mode = hasRefs ? "refs" : "single";

      const resolvedTargets: ResolvedTarget[] = [];

      if (hasRefs) {
        const seenSessionIds = new Set<string>();

        for (const rawRef of refs) {
          const normalized = normalizeSessionRef(rawRef);
          const resolution = await resolveSessionId(ctx.sessionsDir, normalized);

          if (!resolution.ok) {
            failures += 1;
            if (resolution.error === "not_found") {
              results.push({
                session_id: normalized,
                input_ref: rawRef,
                status: "resolution_error",
                reason: `Session not found: ${rawRef}. Try: kspec session list --status active`,
              });
            } else {
              results.push({
                session_id: normalized,
                input_ref: rawRef,
                status: "resolution_error",
                reason:
                  `Ambiguous session ref ${rawRef}: ${resolution.matches.join(", ")}. ` +
                  "Try: kspec session list --status active and use a longer ref.",
              });
            }
            continue;
          }

          if (seenSessionIds.has(resolution.id)) {
            continue;
          }
          seenSessionIds.add(resolution.id);

          resolvedTargets.push({
            inputRef: rawRef,
            sessionId: resolution.id,
          });
          targetRefs.push(resolution.id);
        }
      } else {
        const normalized = normalizeSessionRef(sessionIdOrPrefix!);
        const resolution = await resolveSessionId(ctx.sessionsDir, normalized);
        if (!resolution.ok) {
          if (resolution.error === "not_found") {
            error(
              `Session not found: ${sessionIdOrPrefix}`,
              "Try: kspec session list --status active",
            );
            process.exit(EXIT_CODES.NOT_FOUND);
          }
          error(
            `Session prefix "${sessionIdOrPrefix}" is ambiguous: ${resolution.matches.join(", ")}`,
            "Try: kspec session list --status active and use a longer ref",
          );
          process.exit(EXIT_CODES.NOT_FOUND);
        }

        targetSessionId = resolution.id;
        resolvedTargets.push({
          inputRef: sessionIdOrPrefix!,
          sessionId: resolution.id,
        });
      }

      for (const target of resolvedTargets) {
        const metadata = await getSession(ctx.sessionsDir, target.sessionId);

        if (!metadata) {
          failures += 1;
          results.push({
            session_id: target.sessionId,
            input_ref: target.inputRef,
            status: "resolution_error",
            reason: `Session metadata missing for ${target.sessionId}`,
          });
          continue;
        }

        if (metadata.status !== "active") {
          results.push({
            session_id: target.sessionId,
            input_ref: target.inputRef,
            status: "not_active",
            reason: `Session status is ${metadata.status}; only active sessions are eligible`,
          });
          continue;
        }

        const skipped = skippedById.get(target.sessionId);
        if (skipped) {
          failures += 1;
          results.push({
            session_id: target.sessionId,
            input_ref: target.inputRef,
            status: "skipped_error",
            reason: skipped.detail,
          });
          continue;
        }

        const evaluation = evaluationById.get(target.sessionId);
        if (!evaluation) {
          failures += 1;
          results.push({
            session_id: target.sessionId,
            input_ref: target.inputRef,
            status: "skipped_error",
            reason: "Session evaluation unavailable",
          });
          continue;
        }

        if (!evaluation.eligible) {
          results.push({
            session_id: target.sessionId,
            input_ref: target.inputRef,
            status: "not_candidate",
            reason: describeNotCandidate(evaluation),
            started_at: evaluation.startedAt,
            last_activity_at: evaluation.lastActivityAt,
            last_activity_source: evaluation.lastActivitySource,
            meets_age_threshold: evaluation.meetsAgeThreshold,
            meets_inactivity_threshold: evaluation.meetsInactivityThreshold,
            blocked_by_liveness_guard: evaluation.blockedByLivenessGuard,
          });
          continue;
        }

        targetCandidates.push(evaluation);
        results.push({
          session_id: target.sessionId,
          input_ref: target.inputRef,
          status: dryRun ? "would_abandon" : "abandoned",
          reason: "Session meets stale criteria and is eligible for auto-close",
          started_at: evaluation.startedAt,
          last_activity_at: evaluation.lastActivityAt,
          last_activity_source: evaluation.lastActivitySource,
          meets_age_threshold: evaluation.meetsAgeThreshold,
          meets_inactivity_threshold: evaluation.meetsInactivityThreshold,
          blocked_by_liveness_guard: evaluation.blockedByLivenessGuard,
        });
      }
    }

    if (!dryRun && targetCandidates.length > 0 && !options.force) {
      if (isJsonMode()) {
        error("Confirmation required. Use --force with --json");
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      const isTTY =
        process.env.KSPEC_TEST_TTY === "1" ||
        process.env.KSPEC_TEST_TTY === "true" ||
        process.stdin.isTTY;
      if (!isTTY) {
        error("Non-interactive environment. Use --force to proceed");
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      const confirmed = await promptConfirmation(
        buildConfirmationQuestion(mode, targetCandidates.length),
      );
      if (!confirmed) {
        error("Operation cancelled");
        process.exit(EXIT_CODES.USAGE_ERROR);
      }
    }

    const applyResult = await applyAutoAbandonMetadata(
      ctx.sessionsDir,
      {
        criteria: selection.criteria,
        candidates: targetCandidates,
      },
      {
        dryRun,
      },
    );

    const updatesBySessionId = new Map(
      applyResult.updates.map((update) => [update.sessionId, update]),
    );

    for (const result of results) {
      if (result.status !== "would_abandon" && result.status !== "abandoned") {
        continue;
      }

      const update = updatesBySessionId.get(result.session_id);
      if (!update) {
        failures += 1;
        result.status = "skipped_error";
        result.reason = "Failed to generate close metadata update";
        continue;
      }

      result.close_reason = update.closeReason;
      if (!dryRun) {
        result.status = "abandoned";
        result.reason = "Session was auto-abandoned";
      } else {
        result.status = "would_abandon";
        result.reason = "Session would be auto-abandoned (dry run)";
      }
    }

    const candidatesCount = targetCandidates.length;
    const changedSessions = dryRun ? 0 : applyResult.updatedCount;
    const skippedSessions = results.filter(
      (result) =>
        result.status === "not_candidate" ||
        result.status === "not_active" ||
        result.status === "skipped_error" ||
        result.status === "resolution_error",
    ).length;

    const payload: SessionStaleClosePayload = {
      dry_run: dryRun,
      mode,
      criteria: {
        older_than: selection.criteria.olderThan,
        inactive_for: selection.criteria.inactiveFor,
        liveness_guard: selection.criteria.livenessGuard,
      },
      targets: {
        session_id: targetSessionId,
        refs: targetRefs.length > 0 ? targetRefs : undefined,
        all: allMode,
      },
      sessions: results,
      totals: {
        active_sessions_total: selection.totalActiveSessions,
        sessions_evaluated: results.filter((result) => result.status !== "resolution_error").length,
        candidates: candidatesCount,
        changed_sessions: changedSessions,
        skipped_sessions: skippedSessions,
        failures,
      },
    };

    output(payload, () => {
      if (dryRun) {
        console.log("Dry run preview - no session files were modified.");
      }

      console.log("Stale session close results:");
      for (const result of results) {
        const shortId = result.session_id.slice(0, 8);
        console.log(`[${shortId}] ${result.status} - ${result.reason}`);
        if (result.close_reason) {
          console.log(`  close_reason: ${result.close_reason}`);
        }
      }

      const totals = payload.totals;
      console.log("");
      console.log("Summary:");
      console.log(`  Active sessions: ${totals.active_sessions_total}`);
      console.log(`  Evaluated:       ${totals.sessions_evaluated}`);
      console.log(`  Candidates:      ${totals.candidates}`);
      console.log(`  Changed:         ${totals.changed_sessions}`);
      console.log(`  Skipped:         ${totals.skipped_sessions}`);
      console.log(`  Failures:        ${totals.failures}`);
    });

    if (failures > 0) {
      process.exit(EXIT_CODES.ERROR);
    }
  } catch (err) {
    error("Failed to close stale sessions", err);
    process.exit(EXIT_CODES.ERROR);
  }
}
