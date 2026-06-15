/**
 * Actor-field inventory.
 *
 * The single, exhaustive list of every stored-record field that represents a
 * human or agent actor/author/reviewer/resolver/addition-source identity. The
 * actor-normalization upgrade step, its tests, and the upgrade docs all consume
 * this one inventory so the field list cannot drift between code, coverage, and
 * documentation.
 *
 * Each entry records the field's record kind, owning Zod schema/type, on-disk
 * storage path shape, the field path within the record, and its disposition:
 *
 *   - `normalize`    — the migration rewrites this field to a canonical identity
 *   - `out_of_scope` — the field's name looks actor-bearing but it is NOT a
 *                      free-form human/agent identity (entity ref, enum, tool
 *                      name, …); the migration leaves it untouched. A `reason`
 *                      is required so the exclusion is auditable.
 *
 * Completeness is enforced behaviorally, not by trust: `findUncoveredActorFields`
 * walks the actual Zod schema objects at runtime and asserts that every field
 * whose name matches the actor-name heuristic is represented here. A new
 * actor-bearing field added to any stored-record schema fails the migration
 * closed until it is classified in this inventory.
 *
 * AC: @actor-history-normalization ac-6 — inventory covers every actor-bearing
 *     schema field with record kind, storage path, owning schema, and disposition
 */

import type { ZodTypeAny } from "zod";
import {
  InboxItemSchema,
  ObservationSchema,
  PlanSchema,
  ReviewRecordSchema,
  SpecItemSchema,
  TaskSchema,
  TriageRecordSchema,
  WorkflowRunSchema,
} from "../schema/index.js";

/**
 * Disposition for an inventoried actor-bearing field.
 */
export type ActorFieldDisposition = "normalize" | "out_of_scope";

/**
 * A single inventoried field. `fieldPath` uses dotted segments with `[]`
 * markers for array traversal (e.g. `threads[].entries[].author`), matching
 * the path notation produced by the schema walker so the two can be compared
 * directly.
 */
export interface ActorFieldInventoryEntry {
  /** Migration record kind — also the key used for the per-kind default actor. */
  recordKind: ActorRecordKind;
  /** Owning Zod schema / type name. */
  schemaType: string;
  /** On-disk storage path shape under the project spec dir. */
  storagePath: string;
  /** Field path within the record, `[]`-segmented for arrays. */
  fieldPath: string;
  /** Whether the migration normalizes this field or leaves it out of scope. */
  disposition: ActorFieldDisposition;
  /** Why a field is out of scope. Required for `out_of_scope`, omitted otherwise. */
  reason?: string;
}

/**
 * Record kinds the migration knows how to scan and rewrite. Each maps to a
 * loader/saver handler in `actor-normalization-migration.ts` and to a declared
 * default actor.
 */
export type ActorRecordKind =
  | "review"
  | "task"
  | "inbox"
  | "triage"
  | "observation"
  | "workflow_run"
  | "spec_item"
  | "plan";

/**
 * The exhaustive inventory. Grouped by record kind for readability; order does
 * not matter to consumers.
 *
 * AC: @actor-history-normalization ac-6 — exhaustive field documentation
 */
export const ACTOR_FIELD_INVENTORY: readonly ActorFieldInventoryEntry[] = [
  // ── Reviews (folder-backed: reviews/<ulid>/review.yaml + project.reviews.yaml index) ──
  {
    recordKind: "review",
    schemaType: "ReviewRecordSchema",
    storagePath: "reviews/<ulid>/review.yaml",
    fieldPath: "author",
    disposition: "normalize",
  },
  {
    recordKind: "review",
    schemaType: "ReviewThreadEntrySchema",
    storagePath: "reviews/<ulid>/review.yaml",
    fieldPath: "threads[].entries[].author",
    disposition: "normalize",
  },
  {
    recordKind: "review",
    schemaType: "ReviewThreadSchema",
    storagePath: "reviews/<ulid>/review.yaml",
    fieldPath: "threads[].resolved_by",
    disposition: "normalize",
  },
  {
    recordKind: "review",
    schemaType: "ReviewVerdictSchema",
    storagePath: "reviews/<ulid>/review.yaml",
    fieldPath: "verdicts[].reviewer",
    disposition: "normalize",
  },
  {
    recordKind: "review",
    schemaType: "ReviewEventSchema",
    storagePath: "reviews/<ulid>/review.yaml",
    fieldPath: "events[].actor",
    disposition: "normalize",
  },
  {
    recordKind: "review",
    schemaType: "NoteSchema",
    storagePath: "reviews/<ulid>/review.yaml",
    fieldPath: "notes[].author",
    disposition: "normalize",
  },
  {
    recordKind: "review",
    schemaType: "ReviewCheckSchema",
    storagePath: "reviews/<ulid>/review.yaml",
    fieldPath: "checks[].runner",
    disposition: "out_of_scope",
    reason:
      "CI/test runner tool identifier (e.g. vitest, eslint, github-actions), not a human or agent actor.",
  },

  // ── Tasks (split: tasks/<ulid>/task.yaml + notes.yaml) ──
  {
    recordKind: "task",
    schemaType: "NoteSchema",
    storagePath: "tasks/<ulid>/notes.yaml",
    fieldPath: "notes[].author",
    disposition: "normalize",
  },
  {
    recordKind: "task",
    schemaType: "TodoSchema",
    storagePath: "tasks/<ulid>/task.yaml",
    fieldPath: "todos[].added_by",
    disposition: "normalize",
  },
  {
    recordKind: "task",
    schemaType: "TaskSchema",
    storagePath: "tasks/<ulid>/task.yaml",
    fieldPath: "assignee",
    disposition: "normalize",
  },
  {
    // The per-task field-change history lives in the `history` array inside
    // task.yaml but is NOT part of TaskSchema — it is an internal stored-record
    // shape the split backend manages directly (see HistoryEntry in
    // task-data-manager.ts), so the schema-reflection guard cannot discover it.
    // Each entry's `author` is an explicit actor/author identity, so it is an
    // in-scope normalize field and is inventoried here by hand. The migration's
    // task handler loads and rewrites it via the history-aware save path.
    recordKind: "task",
    schemaType: "HistoryEntry",
    storagePath: "tasks/<ulid>/task.yaml",
    fieldPath: "history[].author",
    disposition: "normalize",
  },
  {
    recordKind: "task",
    schemaType: "TaskSchema",
    storagePath: "tasks/<ulid>/task.yaml",
    fieldPath: "blocked_by",
    disposition: "out_of_scope",
    reason: "Array of blocking task references (entity refs), not actor identities.",
  },
  {
    recordKind: "task",
    schemaType: "TaskResourceRefSchema",
    storagePath: "tasks/<ulid>/task.yaml",
    fieldPath: "resource_refs[].owner_ref",
    disposition: "out_of_scope",
    reason: "Reference to the owning plan/task entity, not an actor identity.",
  },
  {
    recordKind: "task",
    schemaType: "TaskResourceRefSchema",
    storagePath: "tasks/<ulid>/task.yaml",
    fieldPath: "resource_refs[].owner_type",
    disposition: "out_of_scope",
    reason: 'Resource owner-type enum ("plan" | "task"), not an actor identity.',
  },

  // ── Inbox (monolithic: project.inbox.yaml) ──
  {
    recordKind: "inbox",
    schemaType: "InboxItemSchema",
    storagePath: "project.inbox.yaml",
    fieldPath: "added_by",
    disposition: "normalize",
  },

  // ── Triage (monolithic: project.triage.yaml) ──
  {
    recordKind: "triage",
    schemaType: "TriageRecordSchema",
    storagePath: "project.triage.yaml",
    fieldPath: "decided_by",
    disposition: "normalize",
  },
  {
    recordKind: "triage",
    schemaType: "TriageRecordSchema",
    storagePath: "project.triage.yaml",
    fieldPath: "override_by",
    disposition: "normalize",
  },

  // ── Meta observations (<base>.meta.yaml) ──
  {
    recordKind: "observation",
    schemaType: "ObservationSchema",
    storagePath: "<base>.meta.yaml",
    fieldPath: "author",
    disposition: "normalize",
  },
  {
    recordKind: "observation",
    schemaType: "ObservationSchema",
    storagePath: "<base>.meta.yaml",
    fieldPath: "resolved_by",
    disposition: "normalize",
  },

  // ── Workflow runs (<base>.runs.yaml) ──
  {
    recordKind: "workflow_run",
    schemaType: "WorkflowRunSchema",
    storagePath: "<base>.runs.yaml",
    fieldPath: "initiated_by",
    disposition: "normalize",
  },

  // ── Spec / module items (manifest + modules/*.yaml) ──
  {
    recordKind: "spec_item",
    schemaType: "SpecItemSchema",
    storagePath: "<manifest>.yaml | modules/*.yaml",
    fieldPath: "created_by",
    disposition: "normalize",
  },
  {
    recordKind: "spec_item",
    schemaType: "NoteSchema",
    storagePath: "<manifest>.yaml | modules/*.yaml",
    fieldPath: "notes[].author",
    disposition: "normalize",
  },
  {
    recordKind: "spec_item",
    schemaType: "SpecItemSchema",
    storagePath: "<manifest>.yaml | modules/*.yaml",
    fieldPath: "superseded_by",
    disposition: "out_of_scope",
    reason: "Reference to the superseding spec item (entity ref), not an actor identity.",
  },
  {
    recordKind: "spec_item",
    schemaType: "SpecItemSchema",
    storagePath: "<manifest>.yaml | modules/*.yaml",
    fieldPath: "verified_by",
    disposition: "out_of_scope",
    reason: "Reference to the verifying spec item (entity ref), not an actor identity.",
  },

  // ── Plans (folder-backed: plans/<ulid>/notes.yaml) ──
  {
    recordKind: "plan",
    schemaType: "NoteSchema",
    storagePath: "plans/<ulid>/notes.yaml",
    fieldPath: "notes[].author",
    disposition: "normalize",
  },
];

/**
 * Root stored-record schemas walked by the fail-closed completeness guard,
 * keyed by the migration record kind. These are the canonical persisted
 * shapes — input/validation variants are intentionally excluded because they
 * describe the same on-disk fields.
 */
const ROOT_SCHEMAS: ReadonlyArray<{ recordKind: ActorRecordKind; schema: ZodTypeAny }> = [
  { recordKind: "review", schema: ReviewRecordSchema as unknown as ZodTypeAny },
  { recordKind: "task", schema: TaskSchema as unknown as ZodTypeAny },
  { recordKind: "inbox", schema: InboxItemSchema as unknown as ZodTypeAny },
  { recordKind: "triage", schema: TriageRecordSchema as unknown as ZodTypeAny },
  { recordKind: "observation", schema: ObservationSchema as unknown as ZodTypeAny },
  { recordKind: "workflow_run", schema: WorkflowRunSchema as unknown as ZodTypeAny },
  { recordKind: "spec_item", schema: SpecItemSchema as unknown as ZodTypeAny },
  { recordKind: "plan", schema: PlanSchema as unknown as ZodTypeAny },
];

/**
 * Whether a field name looks like it could hold a human/agent actor identity.
 *
 * Matches the actor/author/reviewer/resolver/addition-source families the
 * normalization spec enumerates: the literal `actor`/`assignee`, anything
 * containing `author`/`reviewer`/`owner`, and any `*_by` suffix (resolved_by,
 * added_by, decided_by, created_by, initiated_by, …). The heuristic is
 * deliberately broad: an over-match is harmless (it just requires an
 * `out_of_scope` inventory entry), while an under-match would let a real actor
 * field slip past the guard.
 */
export function looksLikeActorFieldName(name: string): boolean {
  const lc = name.toLowerCase();
  return (
    lc === "actor" ||
    lc === "assignee" ||
    lc.includes("author") ||
    lc.includes("reviewer") ||
    lc.includes("owner") ||
    lc.endsWith("_by")
  );
}

/**
 * A schema field whose name looks actor-bearing, with its `[]`-segmented path.
 */
export interface SchemaActorField {
  recordKind: ActorRecordKind;
  fieldPath: string;
}

/** Peel zod wrapper types to reach the underlying object/array/leaf schema. */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  // Guard against pathological recursion via lazy/recursive schemas.
  for (let i = 0; i < 20; i++) {
    const def = (current as { _def?: Record<string, unknown> })._def;
    const typeName = def?.typeName as string | undefined;
    if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
      current = def!.innerType as ZodTypeAny;
      continue;
    }
    if (typeName === "ZodEffects") {
      current = def!.schema as ZodTypeAny;
      continue;
    }
    if (typeName === "ZodBranded" || typeName === "ZodReadonly" || typeName === "ZodCatch") {
      current = (def!.innerType ?? def!.type) as ZodTypeAny;
      continue;
    }
    if (typeName === "ZodLazy") {
      current = (def!.getter as () => ZodTypeAny)();
      continue;
    }
    return current;
  }
  return current;
}

/**
 * Recursively collect every field whose name looks actor-bearing from a stored
 * record schema, producing `[]`-segmented paths that match the inventory's
 * `fieldPath` notation.
 */
function collectActorFields(
  schema: ZodTypeAny,
  recordKind: ActorRecordKind,
  prefix: string,
  visited: Set<unknown>,
  out: SchemaActorField[],
): void {
  const node = unwrap(schema);
  const def = (node as { _def?: Record<string, unknown> })._def;
  const typeName = def?.typeName as string | undefined;

  if (typeName === "ZodArray") {
    const element = (def!.type ?? def!.element) as ZodTypeAny;
    collectActorFields(element, recordKind, `${prefix}[]`, visited, out);
    return;
  }

  if (typeName === "ZodObject") {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    const shapeFn = (node as { shape?: Record<string, ZodTypeAny> }).shape;
    const shape =
      typeof shapeFn === "function"
        ? (shapeFn as unknown as () => Record<string, ZodTypeAny>)()
        : (shapeFn as Record<string, ZodTypeAny>);
    for (const [key, child] of Object.entries(shape ?? {})) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      if (looksLikeActorFieldName(key)) {
        out.push({ recordKind, fieldPath });
      }
      collectActorFields(child, recordKind, fieldPath, visited, out);
    }
    return;
  }

  if (typeName === "ZodDiscriminatedUnion" || typeName === "ZodUnion") {
    const options = (def!.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>) ?? [];
    const optionList = Array.isArray(options) ? options : Array.from(options.values());
    for (const option of optionList) {
      collectActorFields(option, recordKind, prefix, visited, out);
    }
    return;
  }

  if (typeName === "ZodRecord") {
    const valueType = def!.valueType as ZodTypeAny;
    if (valueType) {
      collectActorFields(valueType, recordKind, `${prefix}[]`, visited, out);
    }
    return;
  }

  // Leaf (string, number, enum, …) — nothing further to traverse. The key was
  // already evaluated by the parent object.
}

/**
 * Walk every stored-record root schema and return the actor-named fields the
 * walker found, each paired with its record kind. Exposed for tests and the
 * fail-closed guard.
 */
export function collectSchemaActorFields(): SchemaActorField[] {
  const out: SchemaActorField[] = [];
  for (const { recordKind, schema } of ROOT_SCHEMAS) {
    // A fresh visited-set per root so a shared schema (e.g. NoteSchema reused by
    // task/plan/review/spec) is fully traversed under each owning record kind.
    collectActorFields(schema, recordKind, "", new Set(), out);
  }
  return out;
}

/**
 * Find actor-named schema fields that are NOT represented in the inventory.
 *
 * The guard for ac-6: an empty result means every actor-bearing field in the
 * stored-record schemas is accounted for (as `normalize` or `out_of_scope`). A
 * non-empty result lists fields that must be classified before the migration
 * can run.
 *
 * AC: @actor-history-normalization ac-6 — implementation checked against schemas
 */
export function findUncoveredActorFields(
  inventory: readonly ActorFieldInventoryEntry[] = ACTOR_FIELD_INVENTORY,
): SchemaActorField[] {
  const covered = new Set(inventory.map((e) => `${e.recordKind}::${e.fieldPath}`));
  const uncovered: SchemaActorField[] = [];
  const seen = new Set<string>();
  for (const field of collectSchemaActorFields()) {
    const key = `${field.recordKind}::${field.fieldPath}`;
    if (!covered.has(key) && !seen.has(key)) {
      seen.add(key);
      uncovered.push(field);
    }
  }
  return uncovered;
}

/** Error thrown when the inventory does not cover an actor-bearing schema field. */
export class ActorInventoryIncompleteError extends Error {
  readonly uncovered: SchemaActorField[];
  constructor(uncovered: SchemaActorField[]) {
    const list = uncovered.map((f) => `  - ${f.recordKind}: ${f.fieldPath}`).join("\n");
    super(
      "Actor-field inventory is incomplete — the following actor-bearing schema " +
        "fields are not classified as `normalize` or `out_of_scope` in " +
        `ACTOR_FIELD_INVENTORY:\n${list}\n\n` +
        "Classify each field in src/parser/actor-field-inventory.ts before " +
        "running the actor-normalization upgrade step.",
    );
    this.name = "ActorInventoryIncompleteError";
    this.uncovered = uncovered;
  }
}

/**
 * Fail closed if any actor-bearing schema field is missing from the inventory.
 * Called at the start of the migration so future schema fields cannot be
 * silently skipped.
 *
 * AC: @actor-history-normalization ac-6 — fail closed on uncovered actor field
 */
export function assertInventoryCoversSchemas(
  inventory: readonly ActorFieldInventoryEntry[] = ACTOR_FIELD_INVENTORY,
): void {
  const uncovered = findUncoveredActorFields(inventory);
  if (uncovered.length > 0) {
    throw new ActorInventoryIncompleteError(uncovered);
  }
}

/** All `normalize` field paths for a record kind, `[]`-segmented. */
export function normalizeFieldPathsFor(recordKind: ActorRecordKind): string[] {
  return ACTOR_FIELD_INVENTORY.filter(
    (e) => e.recordKind === recordKind && e.disposition === "normalize",
  ).map((e) => e.fieldPath);
}
