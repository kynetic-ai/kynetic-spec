/**
 * Shared status-token vocabulary.
 *
 * The single source of truth that maps every entity lifecycle/state value the
 * web UI renders — task statuses, review lifecycle + disposition, spec maturity
 * + implementation status, session statuses, coverage presentation buckets, and
 * git diff file statuses — to exactly one visual token: a color family plus a
 * glyph. Every surface that shows a state draws its color and glyph from here,
 * so the same state reads identically wherever it appears (one token per state,
 * no state unmapped).
 *
 * Colors are expressed as design-token families backed by the `--design-*`
 * status/severity CSS custom properties (see `ds/tokens.css` and the Tailwind
 * theme bridge in `app.css`). A family `f` always has both a `--color-<f>` and a
 * `--color-<f>-fg` variable, so {@link statusBadgeClass} and
 * {@link statusTextClass} can derive utility classes mechanically.
 *
 * This module is intentionally framework-free (no Svelte, no `$lib` imports) so
 * the token table can be unit-tested directly.
 */

/**
 * Design-token color families usable by a status token. Each maps to
 * `--color-<family>` (saturated) and `--color-<family>-fg` (contrast) CSS
 * variables exposed as Tailwind color utilities.
 */
export type StatusColorFamily =
  | "status-pending"
  | "status-in-progress"
  | "status-pending-review"
  | "status-needs-work"
  | "status-completed"
  | "status-blocked"
  | "status-cancelled"
  | "severity-error"
  | "severity-warning"
  | "severity-info"
  | "severity-success";

/** A single resolved status token: one color family + one glyph + a label. */
export interface StatusToken {
  /** Human-readable label for the state. */
  label: string;
  /** Single glyph representing the state (icon-font-free, Unicode or letter). */
  glyph: string;
  /** Design-token color family backing the token's color. */
  family: StatusColorFamily;
}

/** The state-vocabulary domains the token table covers. */
export type StatusDomain =
  | "task"
  | "review-lifecycle"
  | "review-disposition"
  | "spec-maturity"
  | "spec-implementation"
  | "session"
  | "coverage"
  | "diff";

/**
 * The canonical, four-bucket coverage presentation vocabulary
 * (per @coverage-state-presentation). Stale/drifted re-verification causes
 * collapse into `re_verify`; they are secondary detail, not presentation states.
 */
export const COVERAGE_STATES = ["covered", "failing", "not_yet", "re_verify"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/** Git diff file change statuses (mirrors the web-ui DiffFile.status union). */
export const DIFF_FILE_STATES = ["added", "deleted", "modified", "renamed"] as const;
export type DiffFileState = (typeof DIFF_FILE_STATES)[number];

/**
 * The full token table: `domain → state → token`. This object is the single
 * source every status surface consumes.
 */
export const STATUS_TOKENS: Record<StatusDomain, Record<string, StatusToken>> = {
  // Task lifecycle (TaskStatusSchema).
  task: {
    pending: { label: "Pending", glyph: "○", family: "status-pending" },
    in_progress: { label: "In Progress", glyph: "◐", family: "status-in-progress" },
    pending_review: { label: "Pending Review", glyph: "⊙", family: "status-pending-review" },
    needs_work: { label: "Needs Work", glyph: "⟳", family: "status-needs-work" },
    blocked: { label: "Blocked", glyph: "✗", family: "status-blocked" },
    completed: { label: "Completed", glyph: "●", family: "status-completed" },
    cancelled: { label: "Cancelled", glyph: "⊘", family: "status-cancelled" },
  },

  // Review lifecycle state (ReviewLifecycleStateSchema).
  "review-lifecycle": {
    draft: { label: "Draft", glyph: "○", family: "status-pending" },
    open: { label: "Open", glyph: "◐", family: "status-in-progress" },
    closed: { label: "Closed", glyph: "●", family: "status-completed" },
    archived: { label: "Archived", glyph: "⊘", family: "status-cancelled" },
  },

  // Review disposition (ReviewDispositionSchema).
  "review-disposition": {
    pending: { label: "Pending", glyph: "○", family: "status-pending" },
    approved: { label: "Approved", glyph: "●", family: "status-completed" },
    changes_requested: { label: "Changes Requested", glyph: "✗", family: "status-blocked" },
  },

  // Spec maturity (MaturitySchema).
  "spec-maturity": {
    draft: { label: "Draft", glyph: "○", family: "status-pending" },
    proposed: { label: "Proposed", glyph: "◐", family: "status-pending-review" },
    stable: { label: "Stable", glyph: "●", family: "status-completed" },
    deferred: { label: "Deferred", glyph: "⊘", family: "status-cancelled" },
    deprecated: { label: "Deprecated", glyph: "⊗", family: "severity-error" },
  },

  // Spec implementation status (ImplementationStatusSchema).
  "spec-implementation": {
    not_started: { label: "Not Started", glyph: "○", family: "status-cancelled" },
    in_progress: { label: "In Progress", glyph: "◐", family: "status-in-progress" },
    implemented: { label: "Implemented", glyph: "◕", family: "status-pending-review" },
    verified: { label: "Verified", glyph: "●", family: "status-completed" },
  },

  // Session status (SessionStatusSchema).
  session: {
    active: { label: "Active", glyph: "◐", family: "status-in-progress" },
    completed: { label: "Completed", glyph: "●", family: "status-completed" },
    abandoned: { label: "Abandoned", glyph: "⊘", family: "status-cancelled" },
    timed_out: { label: "Timed Out", glyph: "⊗", family: "severity-warning" },
    failed: { label: "Failed", glyph: "✗", family: "status-blocked" },
    stalled: { label: "Stalled", glyph: "⟳", family: "status-needs-work" },
  },

  // Coverage presentation buckets (@coverage-state-presentation).
  coverage: {
    covered: { label: "Covered", glyph: "●", family: "severity-success" },
    failing: { label: "Failing", glyph: "✗", family: "severity-error" },
    not_yet: { label: "Not Yet", glyph: "○", family: "status-cancelled" },
    re_verify: { label: "Re-verify", glyph: "⟳", family: "severity-warning" },
  },

  // Git diff file status (DiffFile.status). Glyphs are the conventional
  // single-letter change codes; rendered as a colored glyph (no pill).
  diff: {
    added: { label: "Added", glyph: "A", family: "severity-success" },
    deleted: { label: "Deleted", glyph: "D", family: "severity-error" },
    modified: { label: "Modified", glyph: "M", family: "severity-warning" },
    renamed: { label: "Renamed", glyph: "R", family: "severity-info" },
  },
};

/**
 * Fallback token for an unknown/unmapped state. Neutral grey with a question
 * glyph so an unexpected value still renders predictably instead of throwing.
 */
export const UNKNOWN_STATUS_TOKEN: StatusToken = {
  label: "Unknown",
  glyph: "?",
  family: "status-cancelled",
};

/**
 * Resolve the visual token for a `(domain, state)` pair. Returns the shared
 * token if the state is in the vocabulary, otherwise {@link UNKNOWN_STATUS_TOKEN}.
 * Resolution is deterministic — the same state always yields the same token,
 * which is what guarantees the same color + glyph on every surface.
 */
export function resolveStatusToken(domain: StatusDomain, state: string): StatusToken {
  return STATUS_TOKENS[domain]?.[state] ?? UNKNOWN_STATUS_TOKEN;
}

/** Whether a `(domain, state)` pair is present in the vocabulary. */
export function hasStatusToken(domain: StatusDomain, state: string): boolean {
  return STATUS_TOKENS[domain]?.[state] !== undefined;
}

/**
 * Tailwind utility classes for a filled badge/pill: saturated background with
 * its contrast foreground. e.g. `"bg-status-completed text-status-completed-fg"`.
 */
export function statusBadgeClass(family: StatusColorFamily): string {
  return `bg-${family} text-${family}-fg`;
}

/**
 * Tailwind utility class for a colored glyph/text on a transparent background.
 * e.g. `"text-severity-success"`.
 */
export function statusTextClass(family: StatusColorFamily): string {
  return `text-${family}`;
}
