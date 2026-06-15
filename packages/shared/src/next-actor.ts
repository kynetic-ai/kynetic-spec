/**
 * Next-Actor Derivation
 *
 * A single deterministic rule that derives, from a review's lifecycle state
 * and disposition, which role the review awaits — the reviewing party, the
 * author of the work under review, or no one — plus a resolver that maps the
 * awaited role to a concrete recorded participant.
 *
 * This lives next to the actor classifier (`./actor`) in the shared package so
 * the daemon (review payload enrichment) and every web surface ("awaiting your
 * action" views) consume the same implementation rather than each deriving the
 * awaited party differently.
 *
 * AC: @actor-display ac-3 — fixed lifecycle/disposition → role mapping
 * AC: @actor-display ac-4 — every surface resolves the same awaited party
 */

// ─── Review state types ───────────────────────────────────────────────────────

/**
 * Review lifecycle states. Mirrors `ReviewLifecycleStateSchema` in
 * `src/schema/review-records.ts`; declared as a plain literal union here so the
 * dependency-light shared package does not import the core Zod schemas.
 */
export type ReviewLifecycleState = "draft" | "open" | "closed" | "archived";

/**
 * Review dispositions. Mirrors `ReviewDispositionSchema` in
 * `src/schema/review-records.ts`.
 */
export type ReviewDisposition = "pending" | "approved" | "changes_requested";

/**
 * The role a review awaits, or `null` when the review awaits no one.
 *
 * - `"reviewer"` — the reviewing party must act (submit a verdict).
 * - `"work-author"` — the author of the work under review must act (address
 *   requested changes, or take the post-approval next step).
 */
export type AwaitedRole = "reviewer" | "work-author" | null;

// ─── Role derivation ──────────────────────────────────────────────────────────

/**
 * Derive the role a review awaits from its lifecycle state and disposition.
 *
 * The mapping is fixed and total over every lifecycle/disposition combination:
 *
 * | lifecycle            | disposition         | awaited role  |
 * | -------------------- | ------------------- | ------------- |
 * | open                 | pending             | reviewer      |
 * | open                 | changes_requested   | work-author   |
 * | open                 | approved            | work-author   |
 * | draft                | *                   | null          |
 * | closed               | *                   | null          |
 * | archived             | *                   | null          |
 *
 * Only an `open` review awaits a role: a `draft` review is created but not yet
 * open for review, and `closed`/`archived` reviews are resolved — none of them
 * awaits a reviewing or authoring action. The `approved` case still awaits the
 * work-author so post-approval follow-up (e.g. merge) has an owner.
 *
 * Pure function: same inputs → same output, never throws.
 *
 * AC: @actor-display ac-3 — fixed mapping
 */
export function deriveAwaitedRole(
  lifecycle: ReviewLifecycleState,
  disposition: ReviewDisposition,
): AwaitedRole {
  if (lifecycle !== "open") {
    return null;
  }
  switch (disposition) {
    case "pending":
      return "reviewer";
    case "changes_requested":
      return "work-author";
    case "approved":
      return "work-author";
    default:
      return null;
  }
}

// ─── Party resolution ─────────────────────────────────────────────────────────

/**
 * The recorded participants of a review, normalized to the two parties the
 * next-actor rule can resolve.
 *
 * - `reviewer` — the reviewing party (e.g. the latest verdict reviewer, or the
 *   review author when no verdict has been recorded yet).
 * - `workAuthor` — the author/submitter of the work under review.
 *
 * Either may be `null` when the review has not recorded that participant.
 */
export interface ReviewParticipants {
  reviewer: string | null;
  workAuthor: string | null;
}

/**
 * The resolved next actor for a review: the awaited role plus the concrete
 * recorded participant that fills it (or `null` when there is no awaited role,
 * or the awaited role's party is not recorded on the review).
 */
export interface AwaitedParty {
  role: AwaitedRole;
  /** The recorded actor string of the awaited party, or `null`. */
  actor: string | null;
}

/**
 * Resolve an awaited role to a concrete recorded participant.
 *
 * Applies the {@link deriveAwaitedRole} rule to `lifecycle`/`disposition`, then
 * selects the matching participant: `reviewer` role → `participants.reviewer`,
 * `work-author` role → `participants.workAuthor`. When the rule awaits no role,
 * or the awaited party is not recorded, `actor` is `null`.
 *
 * Because the rule and the participant selection both live here, two surfaces
 * that pass the same review state and the same recorded participants always
 * present the same result.
 *
 * Pure function: same inputs → same output, never throws.
 *
 * AC: @actor-display ac-3 — applies the fixed role mapping
 * AC: @actor-display ac-4 — single resolution shared by every surface
 */
export function resolveAwaitedParty(
  lifecycle: ReviewLifecycleState,
  disposition: ReviewDisposition,
  participants: ReviewParticipants,
): AwaitedParty {
  const role = deriveAwaitedRole(lifecycle, disposition);
  if (role === null) {
    return { role: null, actor: null };
  }
  const actor = role === "reviewer" ? participants.reviewer : participants.workAuthor;
  return { role, actor: actor ?? null };
}
