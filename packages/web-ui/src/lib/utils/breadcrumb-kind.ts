/**
 * Per-segment item-kind metadata for the breadcrumb.
 *
 * The ancestor chain carries a `kind` string per segment (spec item types plus
 * task/plan/review/session). This maps each kind to:
 *   - a short label shown in the kind indicator pill,
 *   - the reference type used to build the segment's navigation URL, and
 *   - a Tailwind class for the indicator colour.
 *
 * AC: @ui-breadcrumb ac-9
 */

import type { RefType } from "$lib/utils/reference";

export interface KindMeta {
  /** Short label rendered in the kind-indicator pill. */
  label: string;
  /** Reference type used by refHref() to route the segment. */
  refType: RefType;
  /** Tailwind classes for the indicator pill. */
  pillClass: string;
}

const SPEC_KINDS = new Set(["module", "feature", "requirement", "decision", "trait"]);

const KIND_META: Record<string, KindMeta> = {
  module: {
    label: "module",
    refType: "spec",
    pillClass: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  },
  feature: {
    label: "feature",
    refType: "spec",
    pillClass: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  },
  requirement: {
    label: "requirement",
    refType: "spec",
    pillClass: "bg-green-500/15 text-green-700 dark:text-green-300",
  },
  decision: {
    label: "decision",
    refType: "spec",
    pillClass: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  trait: {
    label: "trait",
    refType: "spec",
    pillClass: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
  },
  task: {
    label: "task",
    refType: "task",
    pillClass: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  plan: {
    label: "plan",
    refType: "plan",
    pillClass: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  },
  review: {
    label: "review",
    refType: "review",
    pillClass: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  },
  session: {
    label: "session",
    refType: "session",
    pillClass: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  },
};

const UNKNOWN_META: KindMeta = {
  label: "item",
  refType: "spec",
  pillClass: "bg-muted text-muted-foreground",
};

/**
 * Resolve display + routing metadata for a segment kind. Unrecognised kinds
 * fall back to a neutral spec-routed pill so the trail still renders and links.
 */
export function kindMeta(kind: string): KindMeta {
  return KIND_META[kind] ?? UNKNOWN_META;
}

/** Whether a kind is a spec item type (module/feature/requirement/decision/trait). */
export function isSpecKind(kind: string): boolean {
  return SPEC_KINDS.has(kind);
}
