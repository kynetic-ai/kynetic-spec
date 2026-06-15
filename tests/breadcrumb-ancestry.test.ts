/**
 * Behavioral tests for the breadcrumb ancestry resolver.
 *
 * These exercise the resolver directly (build inputs, call the per-kind method,
 * assert the resolved chain) — the single source of truth every detail surface
 * consumes. The chain shape proves @ui-breadcrumb ac-10: a full root-to-current
 * chain of {ref, title, kind} resolved from already-loaded data, with no list
 * scan required.
 */

import { describe, it, expect } from "vitest";
import {
  BreadcrumbAncestryResolver,
  buildItemAncestors,
  computeItemParentMap,
  indexItemsByUlid,
  type AncestryItemInput,
  type AncestryTaskInput,
  type AncestryPlanInput,
} from "../src/lib/breadcrumb-ancestry.js";

// A three-level spec hierarchy in one file: module → feature → requirement.
const MODULE: AncestryItemInput = {
  _ulid: "01ITEMMODULE0000000000000A",
  _sourceFile: "modules/m.yaml",
  title: "Auth Module",
  type: "module",
  slugs: ["auth-module"],
};
const FEATURE: AncestryItemInput = {
  _ulid: "01ITEMFEATURE000000000000B",
  _sourceFile: "modules/m.yaml",
  _path: "features[0]",
  title: "Login Feature",
  type: "feature",
  slugs: ["login-feature"],
};
const REQUIREMENT: AncestryItemInput = {
  _ulid: "01ITEMREQUIRE000000000000C",
  _sourceFile: "modules/m.yaml",
  _path: "features[0].requirements[0]",
  title: "Password Login",
  type: "requirement",
  slugs: ["password-login"],
};
// A second file with its own root item, to prove cross-file isolation.
const OTHER_MODULE: AncestryItemInput = {
  _ulid: "01ITEMOTHER00000000000000D",
  _sourceFile: "modules/other.yaml",
  title: "Other Module",
  type: "module",
  slugs: ["other-module"],
};

const ITEMS = [MODULE, FEATURE, REQUIREMENT, OTHER_MODULE];

const TASK: AncestryTaskInput = {
  _ulid: "01TASK0000000000000000000E",
  title: "Implement password login",
  slugs: ["task-password-login"],
  spec_ref: "@password-login",
};
const TASK_NO_SPEC: AncestryTaskInput = {
  _ulid: "01TASK0000000000000000000F",
  title: "Infra chore",
  slugs: ["task-infra"],
  spec_ref: null,
};

const PLAN: AncestryPlanInput = {
  _ulid: "01PLAN0000000000000000000G",
  title: "Auth Rollout Plan",
  slugs: ["plan-auth"],
  module_ref: "@auth-module",
};
const PLAN_NO_MODULE: AncestryPlanInput = {
  _ulid: "01PLAN0000000000000000000H",
  title: "Loose Plan",
  slugs: ["plan-loose"],
  module_ref: null,
};

function makeResolver() {
  return new BreadcrumbAncestryResolver({
    items: ITEMS,
    tasks: [TASK, TASK_NO_SPEC],
    plans: [PLAN, PLAN_NO_MODULE],
  });
}

describe("computeItemParentMap", () => {
  // AC: @ui-breadcrumb ac-10
  it("derives parent ULIDs from _path/_sourceFile prefixes", () => {
    const parentMap = computeItemParentMap(ITEMS);
    expect(parentMap.get(MODULE._ulid)).toBeUndefined();
    expect(parentMap.get(FEATURE._ulid)).toBe(MODULE._ulid);
    expect(parentMap.get(REQUIREMENT._ulid)).toBe(FEATURE._ulid);
    expect(parentMap.get(OTHER_MODULE._ulid)).toBeUndefined();
  });

  // AC: @ui-breadcrumb ac-10
  it("does not cross source-file boundaries when assigning parents", () => {
    const parentMap = computeItemParentMap(ITEMS);
    // OTHER_MODULE is a root in its own file even though MODULE is also a root.
    expect(parentMap.get(OTHER_MODULE._ulid)).toBeUndefined();
  });
});

describe("BreadcrumbAncestryResolver.forItem", () => {
  // AC: @ui-breadcrumb ac-10
  it("returns the full root-to-item chain in hierarchy order", () => {
    const chain = makeResolver().forItem("@password-login");
    expect(chain).toEqual([
      { ref: MODULE._ulid, title: "Auth Module", kind: "module" },
      { ref: FEATURE._ulid, title: "Login Feature", kind: "feature" },
      { ref: REQUIREMENT._ulid, title: "Password Login", kind: "requirement" },
    ]);
  });

  // AC: @ui-breadcrumb ac-10
  it("returns a single-segment chain for a root item", () => {
    const chain = makeResolver().forItem("@auth-module");
    expect(chain).toEqual([{ ref: MODULE._ulid, title: "Auth Module", kind: "module" }]);
  });

  // AC: @ui-breadcrumb ac-10
  it("resolves by ULID and ULID prefix as well as slug", () => {
    const resolver = makeResolver();
    const bySlug = resolver.forItem("@login-feature");
    const byUlid = resolver.forItem(FEATURE._ulid);
    const byPrefix = resolver.forItem(FEATURE._ulid.slice(0, 10));
    expect(byUlid).toEqual(bySlug);
    expect(byPrefix).toEqual(bySlug);
  });

  // AC: @ui-breadcrumb ac-10
  it("returns an empty chain for an unresolvable ref", () => {
    expect(makeResolver().forItem("@does-not-exist")).toEqual([]);
  });
});

describe("BreadcrumbAncestryResolver.forTask", () => {
  // AC: @ui-breadcrumb ac-10
  it("is the spec_ref chain plus the task itself", () => {
    const chain = makeResolver().forTask(TASK);
    expect(chain).toEqual([
      { ref: MODULE._ulid, title: "Auth Module", kind: "module" },
      { ref: FEATURE._ulid, title: "Login Feature", kind: "feature" },
      { ref: REQUIREMENT._ulid, title: "Password Login", kind: "requirement" },
      { ref: TASK._ulid, title: "Implement password login", kind: "task" },
    ]);
  });

  // AC: @ui-breadcrumb ac-10
  it("is a single-segment chain when the task has no spec_ref", () => {
    const chain = makeResolver().forTask(TASK_NO_SPEC);
    expect(chain).toEqual([{ ref: TASK_NO_SPEC._ulid, title: "Infra chore", kind: "task" }]);
  });
});

describe("BreadcrumbAncestryResolver.forPlan", () => {
  // AC: @ui-breadcrumb ac-10
  it("is the module_ref chain plus the plan itself", () => {
    const chain = makeResolver().forPlan(PLAN);
    expect(chain).toEqual([
      { ref: MODULE._ulid, title: "Auth Module", kind: "module" },
      { ref: PLAN._ulid, title: "Auth Rollout Plan", kind: "plan" },
    ]);
  });

  // AC: @ui-breadcrumb ac-10
  it("is a single-segment chain when the plan has no module_ref", () => {
    const chain = makeResolver().forPlan(PLAN_NO_MODULE);
    expect(chain).toEqual([{ ref: PLAN_NO_MODULE._ulid, title: "Loose Plan", kind: "plan" }]);
  });
});

describe("BreadcrumbAncestryResolver.forReview", () => {
  const REVIEW_ULID = "01REVIEW00000000000000000I";

  // AC: @ui-breadcrumb ac-10
  it("extends a task subject's chain (spec chain + task + review)", () => {
    const chain = makeResolver().forReview({
      _ulid: REVIEW_ULID,
      title: "Review of password login",
      subject: { type: "task", ref: "@task-password-login" },
    });
    expect(chain.map((s) => s.kind)).toEqual([
      "module",
      "feature",
      "requirement",
      "task",
      "review",
    ]);
    expect(chain.at(-1)).toEqual({
      ref: REVIEW_ULID,
      title: "Review of password login",
      kind: "review",
    });
  });

  // AC: @ui-breadcrumb ac-10
  it("extends a plan subject's chain (module chain + plan + review)", () => {
    const chain = makeResolver().forReview({
      _ulid: REVIEW_ULID,
      title: "Plan review",
      subject: { type: "plan", ref: "@plan-auth" },
    });
    expect(chain.map((s) => s.kind)).toEqual(["module", "plan", "review"]);
  });

  // AC: @ui-breadcrumb ac-10
  it("extends a spec subject's chain (item chain + review)", () => {
    const chain = makeResolver().forReview({
      _ulid: REVIEW_ULID,
      title: "Spec review",
      subject: { type: "spec", ref: "@login-feature" },
    });
    expect(chain.map((s) => s.kind)).toEqual(["module", "feature", "review"]);
  });

  // AC: @ui-breadcrumb ac-10
  it("is a single-segment chain for a code subject (no ref)", () => {
    const chain = makeResolver().forReview({
      _ulid: REVIEW_ULID,
      title: "Code review",
      subject: { type: "code" },
    });
    expect(chain).toEqual([{ ref: REVIEW_ULID, title: "Code review", kind: "review" }]);
  });

  // AC: @ui-breadcrumb ac-10
  it("is a single-segment chain when the subject ref is unresolvable", () => {
    const chain = makeResolver().forReview({
      _ulid: REVIEW_ULID,
      title: "Dangling review",
      subject: { type: "task", ref: "@nope" },
    });
    expect(chain).toEqual([{ ref: REVIEW_ULID, title: "Dangling review", kind: "review" }]);
  });
});

describe("BreadcrumbAncestryResolver.forSession", () => {
  const SESSION_ID = "sess-abc123";

  // AC: @ui-breadcrumb ac-10
  it("is the owning task's chain plus the session for a task-scoped session", () => {
    const chain = makeResolver().forSession({ id: SESSION_ID, task_ref: "@task-password-login" });
    expect(chain.map((s) => s.kind)).toEqual([
      "module",
      "feature",
      "requirement",
      "task",
      "session",
    ]);
    expect(chain.at(-1)).toEqual({ ref: SESSION_ID, title: null, kind: "session" });
  });

  // AC: @ui-breadcrumb ac-10
  it("is a single-segment chain when the session has no owning task", () => {
    const chain = makeResolver().forSession({ id: SESSION_ID });
    expect(chain).toEqual([{ ref: SESSION_ID, title: null, kind: "session" }]);
  });
});

describe("buildItemAncestors", () => {
  // AC: @ui-breadcrumb ac-10
  it("walks a precomputed parent map into a root-to-item chain", () => {
    const parentMap = computeItemParentMap(ITEMS);
    const byUlid = indexItemsByUlid(ITEMS);
    const chain = buildItemAncestors(byUlid, parentMap, REQUIREMENT._ulid);
    expect(chain.map((s) => s.ref)).toEqual([MODULE._ulid, FEATURE._ulid, REQUIREMENT._ulid]);
  });

  // AC: @ui-breadcrumb ac-10
  it("guards against a parent-map cycle instead of looping forever", () => {
    const a: AncestryItemInput = {
      _ulid: "01CYCLEA000000000000000000",
      title: "A",
      type: "feature",
    };
    const b: AncestryItemInput = {
      _ulid: "01CYCLEB000000000000000000",
      title: "B",
      type: "feature",
    };
    const byUlid = indexItemsByUlid([a, b]);
    // Hand-build a cyclic parent map: a → b → a.
    const cyclic = new Map<string, string | undefined>([
      [a._ulid, b._ulid],
      [b._ulid, a._ulid],
    ]);
    const chain = buildItemAncestors(byUlid, cyclic, a._ulid);
    // Each node appears at most once; the walk terminates.
    const refs = chain.map((s) => s.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toContain(a._ulid);
  });

  // AC: @ui-breadcrumb ac-10
  it("falls back to a kind of 'unknown' when an item has no type", () => {
    const typeless: AncestryItemInput = { _ulid: "01NOTYPE0000000000000000J", title: "Mystery" };
    const byUlid = indexItemsByUlid([typeless]);
    const parentMap = computeItemParentMap([typeless]);
    const chain = buildItemAncestors(byUlid, parentMap, typeless._ulid);
    expect(chain).toEqual([{ ref: typeless._ulid, title: "Mystery", kind: "unknown" }]);
  });
});
