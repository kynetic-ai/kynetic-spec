/**
 * Tests for the opt-in migration safety tripwire.
 *
 * The tripwire is configured via the `KSPEC_PROTECTED_PROJECT_PATHS`
 * env variable (path-delimiter-separated list of absolute paths). Unset or
 * empty value means no targets are protected and every executing migration
 * proceeds.
 *
 * Spec: @entity-folder-migration-and-compatibility-1
 */

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROTECTED_PROJECT_PATHS_ENV,
  ProtectedLiveProjectError,
  assertSafeMigrationTarget,
  getProtectedLiveProjectPaths,
  resolveMigrationTargets,
} from "../src/parser/migration-safety.js";

describe("migration safety tripwire", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[PROTECTED_PROJECT_PATHS_ENV];
    delete process.env[PROTECTED_PROJECT_PATHS_ENV];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[PROTECTED_PROJECT_PATHS_ENV];
    } else {
      process.env[PROTECTED_PROJECT_PATHS_ENV] = originalEnv;
    }
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("returns an empty protected list when the env variable is unset", () => {
    expect(getProtectedLiveProjectPaths()).toEqual([]);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("returns an empty protected list when the env variable is empty", () => {
    process.env[PROTECTED_PROJECT_PATHS_ENV] = "";
    expect(getProtectedLiveProjectPaths()).toEqual([]);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("treats every target as safe when no paths are configured", () => {
    const tmp = path.join(os.tmpdir(), "kspec-migration-safety-temp");
    const report = resolveMigrationTargets(tmp, path.join(tmp, ".kspec"));
    expect(report.protected).toBe(false);
    expect(report.matchedPath).toBeNull();
    expect(() => assertSafeMigrationTarget(tmp, path.join(tmp, ".kspec"))).not.toThrow();
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("parses path-delimiter-separated entries from the env variable", () => {
    const a = path.join(os.tmpdir(), "guarded-a");
    const b = path.join(os.tmpdir(), "guarded-b");
    process.env[PROTECTED_PROJECT_PATHS_ENV] = `${a}${path.delimiter}${b}`;
    expect(getProtectedLiveProjectPaths()).toEqual([path.resolve(a), path.resolve(b)]);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("refuses to migrate a target that matches a configured protected path", () => {
    const guarded = path.join(os.tmpdir(), "kspec-safety-guarded");
    process.env[PROTECTED_PROJECT_PATHS_ENV] = guarded;
    const specDir = path.join(guarded, ".kspec");
    const report = resolveMigrationTargets(guarded, specDir);
    expect(report.protected).toBe(true);
    expect(report.matchedPath).toBe(path.resolve(guarded));
    expect(() => assertSafeMigrationTarget(guarded, specDir)).toThrow(
      ProtectedLiveProjectError,
    );
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("refuses to migrate a worktree nested inside a configured protected path", () => {
    const guarded = path.join(os.tmpdir(), "kspec-safety-parent");
    process.env[PROTECTED_PROJECT_PATHS_ENV] = guarded;
    const worktree = path.join(guarded, ".kspec-worktrees", "task-fake-1-1");
    const specDir = path.join(worktree, ".kspec");
    expect(() => assertSafeMigrationTarget(worktree, specDir)).toThrow(
      ProtectedLiveProjectError,
    );
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("fires the tripwire when only the specDir matches a configured protected path", () => {
    const guarded = path.join(os.tmpdir(), "kspec-safety-spec-only");
    process.env[PROTECTED_PROJECT_PATHS_ENV] = guarded;
    const safeProject = path.join(os.tmpdir(), "kspec-safety-safe-project");
    const guardedSpec = path.join(guarded, ".kspec");
    expect(() => assertSafeMigrationTarget(safeProject, guardedSpec)).toThrow(
      ProtectedLiveProjectError,
    );
  });
});
