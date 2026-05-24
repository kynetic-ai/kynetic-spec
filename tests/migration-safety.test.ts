/**
 * Tests for the migration safety tripwire.
 *
 * The plan/review folder-storage migration must refuse to mutate the
 * protected live kynetic-spec / kynetic-spec-dispatch repositories. The
 * tripwire fires on either the project root or the resolved specDir
 * matching one of those paths.
 *
 * Spec: @entity-folder-migration-and-compatibility-1
 */

import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PROTECTED_LIVE_PROJECT_PATHS,
  ProtectedLiveProjectError,
  assertSafeMigrationTarget,
  resolveMigrationTargets,
} from "../src/parser/migration-safety.js";

describe("migration safety tripwire", () => {
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("exposes the documented protected live paths", () => {
    expect(PROTECTED_LIVE_PROJECT_PATHS).toContain("/home/chapel/Projects/kynetic-spec");
    expect(PROTECTED_LIVE_PROJECT_PATHS).toContain(
      "/home/chapel/Projects/kynetic-spec-dispatch",
    );
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("treats a temp directory as a safe migration target", () => {
    const tmp = path.join(os.tmpdir(), "kspec-migration-safety-temp");
    const report = resolveMigrationTargets(tmp, path.join(tmp, ".kspec"));
    expect(report.protected).toBe(false);
    expect(report.matchedPath).toBeNull();
    expect(() => assertSafeMigrationTarget(tmp, path.join(tmp, ".kspec"))).not.toThrow();
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("refuses to migrate the protected kynetic-spec project root", () => {
    const guarded = "/home/chapel/Projects/kynetic-spec";
    const specDir = path.join(guarded, ".kspec");
    const report = resolveMigrationTargets(guarded, specDir);
    expect(report.protected).toBe(true);
    expect(report.matchedPath).toBe(guarded);
    expect(() => assertSafeMigrationTarget(guarded, specDir)).toThrow(ProtectedLiveProjectError);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("refuses to migrate a worktree nested inside a protected project", () => {
    const guarded = "/home/chapel/Projects/kynetic-spec-dispatch";
    const worktree = path.join(guarded, ".kspec-worktrees", "task-fake-1-1");
    const specDir = path.join(worktree, ".kspec");
    expect(() => assertSafeMigrationTarget(worktree, specDir)).toThrow(
      ProtectedLiveProjectError,
    );
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("fires the tripwire when only the specDir matches a protected path", () => {
    const safeProject = path.join(os.tmpdir(), "safe-project");
    const guardedSpec = path.join("/home/chapel/Projects/kynetic-spec", ".kspec");
    expect(() => assertSafeMigrationTarget(safeProject, guardedSpec)).toThrow(
      ProtectedLiveProjectError,
    );
  });
});
