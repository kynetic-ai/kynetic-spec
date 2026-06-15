/**
 * Pure breadcrumb-trail layout logic.
 *
 * Given the server-resolved ancestor chain (root → current entity) the
 * breadcrumb adapts which segments render based on the segment count and the
 * available width. This module isolates that decision so it is testable without
 * a DOM: the component owns measurement (a width observer) and feeds the result
 * back in as `overflowLevel`.
 *
 * Tier rules (count of segments in the full chain, current included):
 *   - ≤ 4 segments  → every segment renders, no collapse indicator
 *   - 5–6 segments  → root + collapse indicator + last two ancestors + current
 *   - 7+ segments   → root + collapse indicator + last one ancestor + current
 *
 * Overflow: when the rendered trail still exceeds its container, the component
 * raises `overflowLevel`. Each level folds one more visible ancestor into the
 * collapse indicator — the root first, then the oldest still-visible trailing
 * ancestor — until the trail fits. The current segment is never collapsed.
 *
 * AC: @ui-breadcrumb ac-1, ac-2, ac-3, ac-4
 */

import type { BreadcrumbAncestor } from "@kynetic-ai/shared";

export interface BreadcrumbTrail {
  /** Leading segments (root side) shown before the collapse indicator. */
  leading: BreadcrumbAncestor[];
  /** Segments folded into the collapse indicator, in hierarchy order. */
  collapsed: BreadcrumbAncestor[];
  /** Ancestor segments shown after the collapse indicator, before current. */
  trailing: BreadcrumbAncestor[];
  /** The current entity — always visible, never collapsed. Null if chain empty. */
  current: BreadcrumbAncestor | null;
  /** Whether a collapse indicator should render. */
  hasCollapse: boolean;
}

/**
 * Compute which ancestor segments render for a given chain and overflow level.
 *
 * @param ancestors Root-to-current chain (current is the last element).
 * @param overflowLevel How many extra visible ancestors to fold away (0 = tier
 *   default). Values beyond what the chain can collapse are clamped.
 */
export function computeTrail(ancestors: BreadcrumbAncestor[], overflowLevel = 0): BreadcrumbTrail {
  const empty: BreadcrumbTrail = {
    leading: [],
    collapsed: [],
    trailing: [],
    current: null,
    hasCollapse: false,
  };

  const n = ancestors.length;
  if (n === 0) return empty;

  const current = ancestors[n - 1];
  if (n === 1) {
    return { leading: [], collapsed: [], trailing: [], current, hasCollapse: false };
  }

  // Candidate ancestors (everything before the current entity).
  const pool = ancestors.slice(0, n - 1);

  // Tier defaults: how many of the ancestors nearest `current` stay visible.
  let keepRoot = true;
  let trailingKeep: number;
  if (n <= 4) {
    trailingKeep = pool.length - 1; // show every ancestor, no collapse
  } else if (n <= 6) {
    trailingKeep = 2;
  } else {
    trailingKeep = 1;
  }

  // Fold visible ancestors away one level at a time: root first, then the
  // oldest still-visible trailing ancestor. The nearest-to-current ancestors
  // stay visible the longest.
  let level = Math.max(0, Math.trunc(overflowLevel));
  while (level > 0) {
    if (keepRoot) {
      keepRoot = false;
    } else if (trailingKeep > 0) {
      trailingKeep -= 1;
    } else {
      break; // everything collapsible is already collapsed
    }
    level -= 1;
  }

  const leading = keepRoot ? pool.slice(0, 1) : [];
  const trailingStart =
    trailingKeep > 0 ? Math.max(pool.length - trailingKeep, keepRoot ? 1 : 0) : pool.length;
  const trailing = trailingKeep > 0 ? pool.slice(trailingStart) : [];
  const collapsed = pool.slice(keepRoot ? 1 : 0, trailingStart);

  return {
    leading,
    collapsed,
    trailing,
    current,
    hasCollapse: collapsed.length > 0,
  };
}

/**
 * Whether the trail still has a visible ancestor that could fold into the
 * collapse indicator. The component stops raising `overflowLevel` once this is
 * false — at that point only the indicator and the current segment remain.
 *
 * AC: @ui-breadcrumb ac-4
 */
export function canCollapseFurther(trail: BreadcrumbTrail): boolean {
  return trail.leading.length > 0 || trail.trailing.length > 0;
}

/**
 * Move the popover's keyboard selection in response to an arrow key.
 *
 * ArrowDown advances toward the end (wrapping in from "no selection" at the
 * top); ArrowUp retreats toward the start (wrapping in from "no selection" at
 * the bottom). Any other key leaves the selection unchanged.
 *
 * AC: @ui-breadcrumb ac-6
 */
export function nextPopoverIndex(current: number, key: string, length: number): number {
  if (length <= 0) return -1;
  if (key === "ArrowDown") {
    return current < 0 ? 0 : Math.min(current + 1, length - 1);
  }
  if (key === "ArrowUp") {
    return current < 0 ? length - 1 : Math.max(current - 1, 0);
  }
  return current;
}
