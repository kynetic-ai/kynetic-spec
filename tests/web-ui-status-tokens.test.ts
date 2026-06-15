/**
 * Shared status-token vocabulary tests.
 *
 * Behavioral tests over the single status-token source the web UI draws from.
 * They exercise the real resolver and class helpers (no source scanning) and
 * cross-check the vocabulary against the canonical Zod enums so the table can
 * never silently drift out of sync with the entity state model.
 *
 * Spec: @ui-view-header ac-2 (one shared token per state, on every surface)
 * Spec: @coverage-state-presentation ac-2 (same coverage token on both surfaces)
 */

import { describe, it, expect } from "vitest";

import {
  STATUS_TOKENS,
  UNKNOWN_STATUS_TOKEN,
  COVERAGE_STATES,
  DIFF_FILE_STATES,
  resolveStatusToken,
  hasStatusToken,
  statusBadgeClass,
  statusTextClass,
  type StatusDomain,
  type StatusColorFamily,
} from "../packages/web-ui/src/lib/ds/status-tokens";

import { TaskStatusSchema, MaturitySchema, ImplementationStatusSchema } from "../src/schema/common";
import { ReviewLifecycleStateSchema, ReviewDispositionSchema } from "../src/schema/review-records";
import { SessionStatusSchema } from "../src/sessions/types";

// Canonical state vocabulary: each domain mapped to its authoritative state
// list. Schema-backed domains pull from the Zod enums (source of truth); the
// two UI-only vocabularies (coverage buckets, diff statuses) pull from the
// module's own exported constants.
const VOCABULARY: Record<StatusDomain, readonly string[]> = {
  task: TaskStatusSchema.options,
  "review-lifecycle": ReviewLifecycleStateSchema.options,
  "review-disposition": ReviewDispositionSchema.options,
  "spec-maturity": MaturitySchema.options,
  "spec-implementation": ImplementationStatusSchema.options,
  session: SessionStatusSchema.options,
  coverage: COVERAGE_STATES,
  diff: DIFF_FILE_STATES,
};

const ALLOWED_FAMILIES: StatusColorFamily[] = [
  "status-pending",
  "status-in-progress",
  "status-pending-review",
  "status-needs-work",
  "status-completed",
  "status-blocked",
  "status-cancelled",
  "severity-error",
  "severity-warning",
  "severity-info",
  "severity-success",
];

const allEntries: Array<{ domain: StatusDomain; state: string }> = (
  Object.keys(VOCABULARY) as StatusDomain[]
).flatMap((domain) => VOCABULARY[domain].map((state) => ({ domain, state })));

describe("status-token vocabulary completeness", () => {
  // AC: @ui-view-header ac-2
  // every state in the model has a token (no state unmapped).
  it.each(allEntries)("maps %s/%s to a defined token", ({ domain, state }) => {
    expect(hasStatusToken(domain, state)).toBe(true);
    const token = resolveStatusToken(domain, state);
    expect(token).not.toBe(UNKNOWN_STATUS_TOKEN);
    expect(token.glyph.length).toBeGreaterThan(0);
    expect(token.label.length).toBeGreaterThan(0);
    expect(ALLOWED_FAMILIES).toContain(token.family);
  });

  // AC: @ui-view-header ac-2
  // the table covers exactly the canonical vocabulary, nothing extra (drift guard).
  it.each(Object.keys(VOCABULARY) as StatusDomain[])(
    "has no extra or missing states for domain %s",
    (domain) => {
      const tableStates = Object.keys(STATUS_TOKENS[domain]).toSorted();
      const canonicalStates = [...VOCABULARY[domain]].toSorted();
      expect(tableStates).toEqual(canonicalStates);
    },
  );
});

describe("one token per state (uniqueness + determinism)", () => {
  // AC: @ui-view-header ac-2
  // a state resolves to exactly one token; resolving it again (i.e. on a second
  // surface) yields the identical color + glyph.
  it.each(allEntries)(
    "resolves %s/%s deterministically to the same color and glyph",
    ({ domain, state }) => {
      const first = resolveStatusToken(domain, state);
      const second = resolveStatusToken(domain, state);
      // Same singleton object from the single source — not a per-call copy.
      expect(first).toBe(second);
      expect(first).toBe(STATUS_TOKENS[domain][state]);
      // The "token" is a single color + single glyph (no ambiguity).
      expect(first.family).toBe(second.family);
      expect(first.glyph).toBe(second.glyph);
    },
  );

  // AC: @coverage-state-presentation ac-2
  // the same coverage state on two different surfaces is the same visual token.
  // Each coverage bucket is one of the four presentation states and resolves
  // identically wherever drawn.
  it.each([...COVERAGE_STATES])(
    "coverage bucket %s renders one identical token on every surface",
    (state) => {
      const surfaceA = resolveStatusToken("coverage", state);
      const surfaceB = resolveStatusToken("coverage", state);
      expect(surfaceA).toEqual(surfaceB);
      expect(surfaceA.glyph).toBe(surfaceB.glyph);
      expect(surfaceA.family).toBe(surfaceB.family);
    },
  );

  // AC: @coverage-state-presentation ac-2
  it("exposes exactly the four coverage presentation buckets", () => {
    expect([...COVERAGE_STATES]).toEqual(["covered", "failing", "not_yet", "re_verify"]);
    expect(Object.keys(STATUS_TOKENS.coverage).toSorted()).toEqual(
      ["covered", "failing", "not_yet", "re_verify"].toSorted(),
    );
  });
});

describe("unknown states fall back without throwing", () => {
  it("returns the neutral fallback token for an unmapped state", () => {
    const token = resolveStatusToken("task", "does_not_exist");
    expect(token).toBe(UNKNOWN_STATUS_TOKEN);
    expect(hasStatusToken("task", "does_not_exist")).toBe(false);
    expect(ALLOWED_FAMILIES).toContain(token.family);
  });
});

describe("class helpers derive design-token utilities", () => {
  it("builds a filled badge class from a family", () => {
    expect(statusBadgeClass("status-completed")).toBe(
      "bg-status-completed text-status-completed-fg",
    );
    expect(statusBadgeClass("severity-success")).toBe(
      "bg-severity-success text-severity-success-fg",
    );
  });

  it("builds a glyph/text class from a family", () => {
    expect(statusTextClass("severity-error")).toBe("text-severity-error");
    expect(statusTextClass("status-in-progress")).toBe("text-status-in-progress");
  });

  // Every family in the table is one of the design-token-backed families, so
  // the derived utility classes always resolve to real `--color-*` variables.
  it("only ever uses design-token-backed families", () => {
    const usedFamilies = Array.from(
      new Set(allEntries.map(({ domain, state }) => STATUS_TOKENS[domain][state].family)),
    );
    for (const family of usedFamilies) {
      expect(ALLOWED_FAMILIES).toContain(family);
    }
  });
});
