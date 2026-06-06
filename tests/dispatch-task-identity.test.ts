import { describe, it, expect } from "vitest";
import {
  normalizeTaskIdentity,
  buildTaskRefResolver,
  type TaskRefResolver,
} from "../src/agent-runtime/task-identity.js";
import type { LoadedTask } from "../src/parser/yaml.js";
import { testUlid } from "./helpers/cli.js";

/**
 * Build a TaskRefResolver from minimal task-like fixtures. ReferenceIndex only
 * uses _ulid and slugs for dispatch task resolution.
 */
function resolverFor(tasks: Array<{ ulid: string; slugs: string[] }>): TaskRefResolver {
  const loaded = tasks.map(
    (t) =>
      ({
        _ulid: t.ulid,
        slugs: t.slugs,
      }) as unknown as LoadedTask,
  );
  return buildTaskRefResolver(loaded);
}

describe("normalizeTaskIdentity", () => {
  const ulidA = testUlid("a");
  const ulidB = testUlid("b");
  const resolver = resolverFor([
    { ulid: ulidA, slugs: ["task-alpha"] },
    { ulid: ulidB, slugs: ["task-beta"] },
  ]);

  // AC: @dispatch-canonical-task-identity ac-event-ingress-canonicalizes-task-identity
  it("canonicalizes a valid task_id plus matching slug ref, keeping display ref separate", () => {
    const result = normalizeTaskIdentity(
      { taskId: ulidA, taskRef: "@task-alpha", source: "test" },
      resolver,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.taskId).toBe(ulidA);
    expect(result.identity.displayRef).toBe("@task-alpha");
    expect(result.displayRefDerivedFromTaskId).toBe(false);
  });

  // AC: @dispatch-canonical-task-identity ac-event-ingress-canonicalizes-task-identity
  it("canonicalizes a unique ULID-prefix ref to the full ULID", () => {
    const prefix = `@${ulidA.slice(0, 10)}`;
    const result = normalizeTaskIdentity({ taskRef: prefix, source: "watcher" }, resolver);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.taskId).toBe(ulidA);
    expect(result.identity.displayRef).toBe(prefix);
  });

  // AC: @dispatch-canonical-task-identity ac-event-ingress-canonicalizes-task-identity
  it("canonicalizes a full ULID ref", () => {
    const result = normalizeTaskIdentity({ taskRef: `@${ulidA}`, source: "watcher" }, resolver);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.taskId).toBe(ulidA);
  });

  // AC: @dispatch-canonical-task-identity ac-missing-display-ref-normalizes-from-task-id
  it("derives @<task_id> as the display ref when task_ref is omitted", () => {
    const result = normalizeTaskIdentity({ taskId: ulidA, source: "api/events" }, resolver);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.taskId).toBe(ulidA);
    expect(result.identity.displayRef).toBe(`@${ulidA}`);
    expect(result.displayRefDerivedFromTaskId).toBe(true);
  });

  // AC: @dispatch-canonical-task-identity ac-missing-display-ref-normalizes-from-task-id
  it("accepts a valid task_id with the @<id> display ref form without rejecting", () => {
    const result = normalizeTaskIdentity(
      { taskId: ulidA, taskRef: `@${ulidA}`, source: "api/events" },
      resolver,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.taskId).toBe(ulidA);
  });

  // AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
  it("rejects a task_id plus a task_ref that resolves to a different task", () => {
    const result = normalizeTaskIdentity(
      { taskId: ulidA, taskRef: "@task-beta", source: "api/events" },
      resolver,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("task-id-ref-mismatch");
    expect(result.diagnostic).toContain(ulidA);
    expect(result.diagnostic).toContain(ulidB);
    expect(result.diagnostic).toContain("api/events");
    expect(result.providedTaskId).toBe(ulidA);
    expect(result.providedTaskRef).toBe("@task-beta");
  });

  // AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
  it("rejects an unresolved single task_ref", () => {
    const result = normalizeTaskIdentity({ taskRef: "@does-not-exist", source: "cli" }, resolver);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unresolved-task-ref");
    expect(result.canonicalTaskId).toBeNull();
    expect(result.diagnostic).toContain("@does-not-exist");
    expect(result.diagnostic).toContain("cli");
  });

  // AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
  it("rejects an ambiguous ULID-prefix task_ref with candidates", () => {
    // Two ULIDs sharing a common prefix make the prefix ambiguous.
    const shared = "01HSHARED";
    const u1 = `${shared}AAAAAAAAAAAAAAAAA`.slice(0, 26);
    const u2 = `${shared}BBBBBBBBBBBBBBBBB`.slice(0, 26);
    const ambiguousResolver = resolverFor([
      { ulid: u1, slugs: ["t-one"] },
      { ulid: u2, slugs: ["t-two"] },
    ]);
    const result = normalizeTaskIdentity(
      { taskRef: `@${shared}`, source: "reconcile" },
      ambiguousResolver,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ambiguous-task-ref");
    expect(result.candidates).toEqual(expect.arrayContaining([u1, u2]));
  });

  // AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
  it("rejects a duplicate slug task_ref", () => {
    const dupResolver = resolverFor([
      { ulid: testUlid("c"), slugs: ["dup-slug"] },
      { ulid: testUlid("d"), slugs: ["dup-slug"] },
    ]);
    const result = normalizeTaskIdentity({ taskRef: "@dup-slug", source: "cli" }, dupResolver);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("duplicate-task-slug");
  });

  // AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
  it("rejects when neither a resolvable id nor ref is provided", () => {
    const result = normalizeTaskIdentity({ source: "api/events" }, resolver);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing-task-identity");
  });

  // AC: @dispatch-canonical-task-identity ac-missing-display-ref-normalizes-from-task-id
  // An authoritative task_id wins over an unresolvable display ref: the id is
  // canonical and the display ref is derived from it rather than dropping work.
  it("trusts a valid task_id and derives the display ref when the ref is unresolvable", () => {
    const result = normalizeTaskIdentity(
      { taskId: ulidA, taskRef: "@stale-slug", source: "api/events" },
      resolver,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.taskId).toBe(ulidA);
    expect(result.identity.displayRef).toBe(`@${ulidA}`);
    expect(result.displayRefDerivedFromTaskId).toBe(true);
  });

  // AC: @dispatch-canonical-task-identity ac-missing-display-ref-normalizes-from-task-id
  // A valid full ULID task_id not yet present in the loaded index is still
  // trusted as canonical identity (the task may be newer than the snapshot).
  it("trusts a syntactically valid task_id that is not in the index", () => {
    const fresh = testUlid("f");
    const result = normalizeTaskIdentity({ taskId: fresh, source: "api/events" }, resolver);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.taskId).toBe(fresh);
    expect(result.identity.displayRef).toBe(`@${fresh}`);
  });

  // AC: @dispatch-canonical-task-identity ac-alias-canonicalization-diagnostics
  it("includes provided id, provided ref, and source on every outcome", () => {
    const ok = normalizeTaskIdentity(
      { taskId: ulidA, taskRef: "@task-alpha", source: "src-x" },
      resolver,
    );
    expect(ok.providedTaskId).toBe(ulidA);
    expect(ok.providedTaskRef).toBe("@task-alpha");
    expect(ok.source).toBe("src-x");
  });
});
