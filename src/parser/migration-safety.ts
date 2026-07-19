/**
 * Migration safety helpers.
 *
 * The plan/review folder-storage migration mutates `.kspec/` contents and
 * commits to the shadow branch. Operators or test harnesses can opt-in to
 * a preflight tripwire that refuses to mutate a configured set of
 * "protected" project roots — useful for keeping development workers
 * pointed at disposable scratch projects instead of a live repository.
 *
 * The list of protected paths is **never** hardcoded. It is read from the
 * `KSPEC_PROTECTED_PROJECT_PATHS` environment variable
 * (path-delimiter-separated absolute paths). When the variable is unset
 * or empty, the tripwire is a no-op and every executing migration target
 * is treated as safe.
 *
 * This module owns:
 *   - `getProtectedLiveProjectPaths()` — read the env-configured list,
 *   - `resolveMigrationTargets(projectDir, specDir)` for diagnostic
 *     reporting (returns the absolute paths and a `protected` flag), and
 *   - `assertSafeMigrationTarget(...)` which throws when the resolved
 *     target matches a protected path.
 *
 * The tripwire intentionally guards executing migration runs only. Dry-run
 * previews must continue to work against any directory so engineers can
 * inspect what would change.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
 */

import * as path from "node:path";

/**
 * Name of the env variable that holds the path-delimiter-separated list
 * of protected project roots. Exposed for tests and documentation.
 */
export const PROTECTED_PROJECT_PATHS_ENV = "KSPEC_PROTECTED_PROJECT_PATHS";

/**
 * Read the configured protected paths from the environment. Each entry
 * is normalized with {@link path.resolve} before comparison so trailing
 * separators and `.` segments still match. Returns an empty list when
 * the env variable is unset or contains only empty entries — that is
 * the safe default and produces a no-op tripwire.
 */
export function getProtectedLiveProjectPaths(): readonly string[] {
  const raw = process.env[PROTECTED_PROJECT_PATHS_ENV];
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

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
 * Used so a worktree under one of the protected roots still trips the
 * tripwire even when its absolute path differs from the configured root.
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
 * either path matches a configured protected path. Used by `kspec upgrade`
 * to log the resolved targets before mutation (preflight) and by
 * {@link assertSafeMigrationTarget} to gate writes.
 */
export function resolveMigrationTargets(
  projectDir: string,
  specDir: string,
): MigrationTargetReport {
  const resolvedProject = path.resolve(projectDir);
  const resolvedSpec = path.resolve(specDir);
  for (const guarded of getProtectedLiveProjectPaths()) {
    if (
      pathSitsInsideOrEquals(resolvedProject, guarded) ||
      pathSitsInsideOrEquals(resolvedSpec, guarded)
    ) {
      return {
        projectDir: resolvedProject,
        specDir: resolvedSpec,
        protected: true,
        matchedPath: guarded,
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
 * Refuse to mutate a configured protected project. Throws a deterministic
 * error (code `protected_live_project_target`) when the migration target
 * sits inside one of the {@link getProtectedLiveProjectPaths} entries.
 *
 * `force` does not bypass this check by design — operators that need to
 * mutate a protected project unset the env variable.
 */
export class ProtectedLiveProjectError extends Error {
  readonly code = "protected_live_project_target";
  readonly report: MigrationTargetReport;
  constructor(report: MigrationTargetReport) {
    super(
      `Refusing to run executing folder-storage migration on protected project path: ` +
        `${report.matchedPath ?? "(unknown)"} (projectDir=${report.projectDir}, ` +
        `specDir=${report.specDir}). Use an isolated temporary project or unset ` +
        `${PROTECTED_PROJECT_PATHS_ENV} to proceed.`,
    );
    this.name = "ProtectedLiveProjectError";
    this.report = report;
  }
}

/**
 * Throw {@link ProtectedLiveProjectError} when the migration's resolved
 * target is one of the configured protected paths. Returns the report when
 * the target is safe so callers can surface it in diagnostic output. When
 * the env variable is unset (the default), no targets are protected and
 * the function always returns a safe report.
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
