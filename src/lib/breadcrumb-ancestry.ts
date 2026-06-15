/**
 * Breadcrumb Ancestry Resolution
 *
 * Pure resolver that builds the server-resolved ancestor chain a breadcrumb
 * consumes — refs, titles, and item kinds from the root through the current
 * entity, in hierarchy order. The single source of truth every detail surface
 * uses (daemon item/task/plan/review/session routes and the static-export
 * generator) so the chain is never reconstructed per route or rebuilt from an
 * unbounded entity-list fetch.
 *
 * It lives in `src/lib/` rather than `@kynetic-ai/shared` because the daemon
 * ships unbundled and only *type*-imports the shared package; runtime values it
 * shares with the CLI/export pipeline come from `src/` via relative imports
 * (the same channel as `src/lib/plan-summary.ts`). The output segment type
 * `BreadcrumbAncestor` is the API contract shape and stays in `@kynetic-ai/shared`;
 * it is imported here as a type only (erased at runtime, so no runtime
 * dependency on the shared package is introduced).
 *
 * The chain is built from already-loaded index data:
 *  - Spec items form the only deep hierarchy; their parent path is derived from
 *    `_path`/`_sourceFile` (the same prefix logic the items list uses).
 *  - Every other entity anchors to exactly one typed parent and appends itself:
 *    a task's chain is its `spec_ref` chain plus the task; a plan's is its
 *    `module_ref` chain plus the plan; a review's is its subject entity's chain
 *    plus the review; a session's is its owning task's chain plus the session
 *    when task-scoped. Entities without a resolvable parent return a
 *    single-segment chain (just themselves).
 *
 * Resolution is pure: the same inputs always yield the same chain and no input
 * throws. Unresolvable refs collapse to "no ancestor" rather than erroring, so
 * a dangling parent reference degrades to a shorter chain instead of a failure.
 *
 * AC: @ui-breadcrumb ac-10 — full chain (ref, title, kind, root-to-current)
 *     resolved server-side without an unbounded entity-list fetch.
 */

import type { BreadcrumbAncestor } from "@kynetic-ai/shared";

export type { BreadcrumbAncestor };

/** Spec item fields needed to walk and label the parent chain. */
export interface AncestryItemInput {
  _ulid: string;
  _sourceFile?: string;
  _path?: string;
  title?: string | null;
  type?: string;
  slugs?: string[];
}

/** Task fields needed to anchor a task leaf onto its spec chain. */
export interface AncestryTaskInput {
  _ulid: string;
  title?: string | null;
  slugs?: string[];
  spec_ref?: string | null;
}

/** Plan fields needed to anchor a plan leaf onto its module chain. */
export interface AncestryPlanInput {
  _ulid: string;
  title?: string | null;
  slugs?: string[];
  module_ref?: string | null;
}

/** Review fields needed to anchor a review leaf onto its subject chain. */
export interface AncestryReviewInput {
  _ulid: string;
  title?: string | null;
  slugs?: string[];
  /** Discriminated subject; only task/plan/spec subjects carry a `ref`. */
  subject: { type: string; ref?: string };
}

/** Session fields needed to anchor a session leaf onto its owning task chain. */
export interface AncestrySessionInput {
  /** Session id (used as the segment `ref`). */
  id: string;
  title?: string | null;
  /** Owning task ref when the session is task-scoped; otherwise null/undefined. */
  task_ref?: string | null;
}

/** Kind literal emitted for each non-item leaf entity. */
const TASK_KIND = "task";
const PLAN_KIND = "plan";
const REVIEW_KIND = "review";
const SESSION_KIND = "session";

/** Kind fallback when a spec item carries no `type`. */
const UNKNOWN_ITEM_KIND = "unknown";

/**
 * Compute parent ULIDs for spec items from their `_path`/`_sourceFile`
 * structure. Items are nested when they share a source file and one item's
 * path is the dotted prefix of another's (`features[0]` is the parent of
 * `features[0].requirements[0]`). A file's root item (no `_path`) is the
 * parent of its direct children.
 *
 * This is the single source of truth for item parent relationships; the items
 * list route and the breadcrumb resolver both consume it so the `parent` field
 * and the `ancestors` chain never diverge.
 */
export function computeItemParentMap(items: AncestryItemInput[]): Map<string, string | undefined> {
  const parentMap = new Map<string, string | undefined>();

  // Group items by source file — nesting is only meaningful within a file.
  const byFile = new Map<string, AncestryItemInput[]>();
  for (const item of items) {
    const file = item._sourceFile || "";
    const bucket = byFile.get(file);
    if (bucket) {
      bucket.push(item);
    } else {
      byFile.set(file, [item]);
    }
  }

  for (const [, fileItems] of byFile) {
    // Shorter paths are potential parents; process them first. toSorted returns
    // a new array, leaving the caller's order untouched.
    const sorted = fileItems.toSorted((a, b) => {
      const aLen = a._path?.length || 0;
      const bLen = b._path?.length || 0;
      return aLen - bLen;
    });

    for (const item of sorted) {
      const itemPath = item._path;

      if (!itemPath) {
        // Root item in file — no parent.
        parentMap.set(item._ulid, undefined);
        continue;
      }

      // Parent path is the prefix before the final dotted segment, or the
      // file's root item when the path has no dot.
      const lastDot = itemPath.lastIndexOf(".");
      const parentPath = lastDot > -1 ? itemPath.substring(0, lastDot) : undefined;

      let parentUlid: string | undefined;
      if (parentPath === undefined) {
        const rootItem = fileItems.find((i) => !i._path);
        parentUlid = rootItem?._ulid;
      } else {
        const parentItem = fileItems.find((i) => i._path === parentPath);
        parentUlid = parentItem?._ulid;
      }

      parentMap.set(item._ulid, parentUlid);
    }
  }

  return parentMap;
}

/**
 * Walk a spec item's parent chain into a root-to-item ancestor list, using a
 * precomputed parent map and item lookup. Guards against cycles. Exposed
 * standalone so callers that already hold a `computeItemParentMap` result (the
 * items route computes it for the `parent` field) build the chain without
 * recomputing the map.
 */
export function buildItemAncestors(
  itemByUlid: Map<string, AncestryItemInput>,
  parentMap: Map<string, string | undefined>,
  ulid: string,
): BreadcrumbAncestor[] {
  const chain: BreadcrumbAncestor[] = [];
  const seen = new Set<string>();
  let current: string | undefined = ulid;
  while (current && !seen.has(current)) {
    seen.add(current);
    const item = itemByUlid.get(current);
    if (!item) break;
    chain.unshift({
      ref: item._ulid,
      title: item.title ?? null,
      kind: item.type ?? UNKNOWN_ITEM_KIND,
    });
    current = parentMap.get(current);
  }
  return chain;
}

/** Build a ULID→item lookup map from a flat item list. */
export function indexItemsByUlid(items: AncestryItemInput[]): Map<string, AncestryItemInput> {
  const byUlid = new Map<string, AncestryItemInput>();
  for (const item of items) byUlid.set(item._ulid, item);
  return byUlid;
}

/** Strip a leading `@` from a reference, if present. */
function stripAt(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

/** Per-collection lookup tables for ref → entity resolution. */
interface Lookup<T> {
  byUlid: Map<string, T>;
  ulidBySlug: Map<string, string>;
  ulids: string[];
}

function buildLookup<T extends { _ulid: string; slugs?: string[] }>(entries: T[]): Lookup<T> {
  const byUlid = new Map<string, T>();
  const ulidBySlug = new Map<string, string>();
  const ulids: string[] = [];
  for (const entry of entries) {
    byUlid.set(entry._ulid, entry);
    ulids.push(entry._ulid);
    for (const slug of entry.slugs ?? []) {
      // First writer wins; mirrors slug-uniqueness expectations elsewhere.
      if (!ulidBySlug.has(slug)) ulidBySlug.set(slug, entry._ulid);
    }
  }
  return { byUlid, ulidBySlug, ulids };
}

/**
 * Resolve a reference against a lookup using the same precedence the daemon's
 * ReferenceIndex uses: exact slug, exact ULID, then unique ULID prefix.
 * Returns undefined when the ref is missing, unknown, or an ambiguous prefix.
 */
function resolveRef<T>(ref: string | null | undefined, lookup: Lookup<T>): T | undefined {
  if (!ref) return undefined;
  const clean = stripAt(ref);
  if (clean.length === 0) return undefined;

  const slugUlid = lookup.ulidBySlug.get(clean);
  if (slugUlid) return lookup.byUlid.get(slugUlid);

  const exact = lookup.byUlid.get(clean.toUpperCase());
  if (exact) return exact;

  const lower = clean.toLowerCase();
  let match: T | undefined;
  for (const ulid of lookup.ulids) {
    if (ulid.toLowerCase().startsWith(lower)) {
      if (match) return undefined; // ambiguous prefix
      match = lookup.byUlid.get(ulid);
    }
  }
  return match;
}

/**
 * Resolver that builds breadcrumb ancestor chains from already-loaded index
 * data. Construct once per request (or once per snapshot) with the entity
 * collections available on that surface, then call the per-kind method for the
 * leaf entity being served.
 *
 * Only `items` is required; `tasks` and `plans` are needed when resolving
 * review subjects or session owners that point at those collections. A leaf
 * whose parent collection was not supplied degrades to a single-segment chain.
 */
export class BreadcrumbAncestryResolver {
  private readonly items: Lookup<AncestryItemInput>;
  private readonly tasks: Lookup<AncestryTaskInput>;
  private readonly plans: Lookup<AncestryPlanInput>;
  private readonly parentMap: Map<string, string | undefined>;

  constructor(input: {
    items: AncestryItemInput[];
    tasks?: AncestryTaskInput[];
    plans?: AncestryPlanInput[];
  }) {
    this.items = buildLookup(input.items);
    this.tasks = buildLookup(input.tasks ?? []);
    this.plans = buildLookup(input.plans ?? []);
    this.parentMap = computeItemParentMap(input.items);
  }

  /** Build the chain for a spec item addressed by ref (root → item). */
  forItem(ref: string): BreadcrumbAncestor[] {
    const item = resolveRef(ref, this.items);
    if (!item) return [];
    return this.itemChainByUlid(item._ulid);
  }

  /**
   * Build the chain for a spec item addressed by ULID. Walks the parent map
   * root-ward, guarding against cycles, and emits root-to-item order.
   */
  itemChainByUlid(ulid: string): BreadcrumbAncestor[] {
    return buildItemAncestors(this.items.byUlid, this.parentMap, ulid);
  }

  /** Build the chain for a task: its spec_ref chain plus the task itself. */
  forTask(task: AncestryTaskInput): BreadcrumbAncestor[] {
    const base = task.spec_ref ? this.forItem(task.spec_ref) : [];
    return [...base, { ref: task._ulid, title: task.title ?? null, kind: TASK_KIND }];
  }

  /** Build the chain for a plan: its module_ref chain plus the plan itself. */
  forPlan(plan: AncestryPlanInput): BreadcrumbAncestor[] {
    const base = plan.module_ref ? this.forItem(plan.module_ref) : [];
    return [...base, { ref: plan._ulid, title: plan.title ?? null, kind: PLAN_KIND }];
  }

  /**
   * Build the chain for a review: its subject entity's chain plus the review.
   * Task/plan/spec subjects resolve through their collection; code/external
   * subjects (and unresolvable subject refs) yield a single-segment chain.
   */
  forReview(review: AncestryReviewInput): BreadcrumbAncestor[] {
    const base = this.subjectChain(review.subject);
    return [...base, { ref: review._ulid, title: review.title ?? null, kind: REVIEW_KIND }];
  }

  /**
   * Build the chain for a session: its owning task's chain plus the session
   * when task-scoped; otherwise a single-segment chain.
   */
  forSession(session: AncestrySessionInput): BreadcrumbAncestor[] {
    let base: BreadcrumbAncestor[] = [];
    if (session.task_ref) {
      const task = resolveRef(session.task_ref, this.tasks);
      if (task) base = this.forTask(task);
    }
    return [...base, { ref: session.id, title: session.title ?? null, kind: SESSION_KIND }];
  }

  private subjectChain(subject: { type: string; ref?: string }): BreadcrumbAncestor[] {
    if (!subject.ref) return [];
    switch (subject.type) {
      case "task": {
        const task = resolveRef(subject.ref, this.tasks);
        return task ? this.forTask(task) : [];
      }
      case "plan": {
        const plan = resolveRef(subject.ref, this.plans);
        return plan ? this.forPlan(plan) : [];
      }
      case "spec":
        return this.forItem(subject.ref);
      default:
        return [];
    }
  }
}
