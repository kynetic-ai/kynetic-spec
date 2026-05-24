/**
 * Migration safety helpers.
 *
 * The plan/review folder-storage migration mutates `.kspec/` contents and
 * commits to the shadow branch. During development those mutations must
 * never run against the live kynetic-spec repositories — the plan owning
 * this work calls those paths out explicitly and demands a tripwire that
 * refuses to mutate when the resolved project root matches one of them.
 *
 * This module owns:
 *   - the list of protected live project paths,
 *   - `resolveMigrationTargets(projectDir, specDir)` for diagnostic
 *     reporting (returns the absolute paths and a `protected` flag), and
 *   - `assertSafeMigrationTarget(...)` which throws when the resolved
 *     target matches a protected path.
 *
 * The tripwire intentionally guards executing migration runs only. Dry-run
 * previews must continue to work against any directory (including the live
 * repos) so engineers can inspect what would change.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
 */

import * as path from "node:path";

/**
 * Absolute paths of live project repositories that must never be mutated
 * by a non-dry-run plan/review migration. The migration helper resolves
 * its target project root and the corresponding `.kspec/` directory and
 * compares both against this list — if either matches, the operation is
 * refused without mutating state.
 *
 * Paths are normalized with {@link path.resolve} before comparison so
 * trailing separators, `.` segments, and symlink-free relative inputs
 * still match.
 */
export const PROTECTED_LIVE_PROJECT_PATHS: readonly string[] = [
  "/home/chapel/Projects/kynetic-spec",
  "/home/chapel/Projects/kynetic-spec-dispatch",
];

/**
 * Outcome of comparing the migration's target paths against the protected
 * live paths. `projectDir` is the absolute resolved project root, `specDir`
 * is the absolute resolved `.kspec/` worktree, and `matchedPath` is the
 * protected path that matched (or null when neither matched).
 */
export interface MigrationTargetReport {
  readonly projectDir: string;
  readonly specDir: string;
  readonly protected: boolean;
  readonly matchedPath: string | null;
}

/**
 * Returns true when `candidate` resolves to (or sits inside) `protectedRoot`.
 * Used so a worktree under one of the live repos (for example
 * `.kspec-worktrees/...`) still trips the tripwire even when its absolute
 * path differs from the protected root.
 */
function pathSitsInsideOrEquals(candidate: string, protectedRoot: string): boolean {
  const a = path.resolve(candidate);
  const b = path.resolve(protectedRoot);
  if (a === b) return true;
  const withSep = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(withSep);
}

/**
 * Resolve the project/specDir pair for a migration and report whether
 * either path matches a protected live path. Used by `kspec upgrade` to
 * log the resolved targets before mutation (preflight) and by
 * {@link assertSafeMigrationTarget} to gate writes.
 */
export function resolveMigrationTargets(
  projectDir: string,
  specDir: string,
): MigrationTargetReport {
  const resolvedProject = path.resolve(projectDir);
  const resolvedSpec = path.resolve(specDir);
  for (const guarded of PROTECTED_LIVE_PROJECT_PATHS) {
    if (
      pathSitsInsideOrEquals(resolvedProject, guarded) ||
      pathSitsInsideOrEquals(resolvedSpec, guarded)
    ) {
      return {
        projectDir: resolvedProject,
        specDir: resolvedSpec,
        protected: true,
        matchedPath: path.resolve(guarded),
      };
    }
  }
  return {
    projectDir: resolvedProject,
    specDir: resolvedSpec,
    protected: false,
    matchedPath: null,
  };
}

/**
 * Refuse to mutate a protected live project. Throws a deterministic error
 * (code `protected_live_project_target`) when the migration target matches
 * one of {@link PROTECTED_LIVE_PROJECT_PATHS}. The caller (upgrade
 * pipeline) is expected to surface the error as a migration failure with
 * the matched path and resolved targets so an operator can diagnose how a
 * disallowed run was attempted.
 *
 * `force` does not bypass this check by design — the tripwire is meant to
 * prevent silent recovery and is part of the plan's safety contract.
 */
export class ProtectedLiveProjectError extends Error {
  readonly code = "protected_live_project_target";
  readonly report: MigrationTargetReport;
  constructor(report: MigrationTargetReport) {
    super(
      `Refusing to run executing folder-storage migration on protected live project path: ` +
        `${report.matchedPath ?? "(unknown)"} (projectDir=${report.projectDir}, ` +
        `specDir=${report.specDir}). Use an isolated temporary project for any executing migration.`,
    );
    this.name = "ProtectedLiveProjectError";
    this.report = report;
  }
}

/**
 * Throw {@link ProtectedLiveProjectError} when the migration's resolved
 * target is one of the protected live paths. Returns the report when the
 * target is safe so callers can surface it in diagnostic output.
 */
export function assertSafeMigrationTarget(
  projectDir: string,
  specDir: string,
): MigrationTargetReport {
  const report = resolveMigrationTargets(projectDir, specDir);
  if (report.protected) {
    throw new ProtectedLiveProjectError(report);
  }
  return report;
}
