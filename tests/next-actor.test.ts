/**
 * Next-actor derivation behavioral tests.
 *
 * Exercises the single shared rule that derives whom a review awaits from its
 * lifecycle state and disposition, plus the resolver that maps the awaited role
 * to a concrete recorded participant. The role mapping is asserted with a
 * table that enumerates EVERY lifecycle × disposition combination so no case is
 * left unspecified.
 */

import { describe, it, expect } from "vitest";
import {
  deriveAwaitedRole,
  resolveAwaitedParty,
  type AwaitedRole,
  type ReviewDisposition,
  type ReviewLifecycleState,
  type ReviewParticipants,
} from "../packages/shared/src/next-actor.ts";

const LIFECYCLES: ReviewLifecycleState[] = ["draft", "open", "closed", "archived"];
const DISPOSITIONS: ReviewDisposition[] = ["pending", "approved", "changes_requested"];

/**
 * Expected awaited role for every lifecycle × disposition combination.
 * Independently transcribed from the fixed mapping in @actor-display ac-3 — the
 * source of truth for this table is the AC, not the implementation.
 */
const EXPECTED: Array<{
  lifecycle: ReviewLifecycleState;
  disposition: ReviewDisposition;
  role: AwaitedRole;
}> = [
  // draft — not yet open for review → awaits no role.
  { lifecycle: "draft", disposition: "pending", role: null },
  { lifecycle: "draft", disposition: "approved", role: null },
  { lifecycle: "draft", disposition: "changes_requested", role: null },
  // open — the only lifecycle that awaits a role; disposition selects which.
  { lifecycle: "open", disposition: "pending", role: "reviewer" },
  { lifecycle: "open", disposition: "approved", role: "work-author" },
  { lifecycle: "open", disposition: "changes_requested", role: "work-author" },
  // closed — resolved → awaits no role.
  { lifecycle: "closed", disposition: "pending", role: null },
  { lifecycle: "closed", disposition: "approved", role: null },
  { lifecycle: "closed", disposition: "changes_requested", role: null },
  // archived — resolved → awaits no role.
  { lifecycle: "archived", disposition: "pending", role: null },
  { lifecycle: "archived", disposition: "approved", role: null },
  { lifecycle: "archived", disposition: "changes_requested", role: null },
];

describe("deriveAwaitedRole — fixed lifecycle/disposition mapping (ac-3)", () => {
  // The table must cover the full cross product with no gaps or duplicates.
  it("enumerates every lifecycle × disposition combination exactly once", () => {
    expect(EXPECTED).toHaveLength(LIFECYCLES.length * DISPOSITIONS.length);
    const seen = new Set(EXPECTED.map((row) => `${row.lifecycle}/${row.disposition}`));
    expect(seen.size).toBe(EXPECTED.length);
    for (const lifecycle of LIFECYCLES) {
      for (const disposition of DISPOSITIONS) {
        expect(seen.has(`${lifecycle}/${disposition}`)).toBe(true);
      }
    }
  });

  for (const { lifecycle, disposition, role } of EXPECTED) {
    // AC: @actor-display ac-3 — derived awaited role follows the fixed mapping
    it(`${lifecycle} + ${disposition} → ${role ?? "no role"}`, () => {
      expect(deriveAwaitedRole(lifecycle, disposition)).toBe(role);
    });
  }

  // AC: @actor-display ac-3 — deterministic (same inputs → same output)
  it("is deterministic across repeated calls", () => {
    for (const { lifecycle, disposition } of EXPECTED) {
      const first = deriveAwaitedRole(lifecycle, disposition);
      const second = deriveAwaitedRole(lifecycle, disposition);
      expect(second).toBe(first);
    }
  });
});

describe("resolveAwaitedParty — role → recorded participant (ac-3, ac-4)", () => {
  const participants: ReviewParticipants = {
    reviewer: "@codex",
    workAuthor: "Jacob Chapel",
  };

  // AC: @actor-display ac-3 — reviewer role resolves to the reviewer party
  it("resolves an open+pending review to the reviewer participant", () => {
    expect(resolveAwaitedParty("open", "pending", participants)).toEqual({
      role: "reviewer",
      actor: "@codex",
    });
  });

  // AC: @actor-display ac-3 — work-author role resolves to the work author
  it("resolves open+changes_requested and open+approved to the work author", () => {
    expect(resolveAwaitedParty("open", "changes_requested", participants)).toEqual({
      role: "work-author",
      actor: "Jacob Chapel",
    });
    expect(resolveAwaitedParty("open", "approved", participants)).toEqual({
      role: "work-author",
      actor: "Jacob Chapel",
    });
  });

  // AC: @actor-display ac-3 — closed/archived reviews await no party
  it("resolves closed and archived reviews to no role and no actor", () => {
    for (const lifecycle of ["closed", "archived"] as ReviewLifecycleState[]) {
      for (const disposition of DISPOSITIONS) {
        expect(resolveAwaitedParty(lifecycle, disposition, participants)).toEqual({
          role: null,
          actor: null,
        });
      }
    }
  });

  // AC: @actor-display ac-4 — a known role with an unrecorded party yields a
  // null actor (the rule still identifies the role; the party is just absent).
  it("returns a null actor when the awaited party is not recorded", () => {
    expect(
      resolveAwaitedParty("open", "pending", { reviewer: null, workAuthor: "Jacob Chapel" }),
    ).toEqual({ role: "reviewer", actor: null });
    expect(
      resolveAwaitedParty("open", "approved", { reviewer: "@codex", workAuthor: null }),
    ).toEqual({ role: "work-author", actor: null });
  });

  // AC: @actor-display ac-4 — two independent surfaces deriving the awaited
  // party from the same review state + participants present the same result.
  it("produces identical results for two independent call sites", () => {
    for (const lifecycle of LIFECYCLES) {
      for (const disposition of DISPOSITIONS) {
        // Surface A and surface B build participants the same way from the
        // same recorded review and call the one shared resolver.
        const surfaceA = resolveAwaitedParty(lifecycle, disposition, participants);
        const surfaceB = resolveAwaitedParty(lifecycle, disposition, {
          reviewer: participants.reviewer,
          workAuthor: participants.workAuthor,
        });
        expect(surfaceB).toEqual(surfaceA);
      }
    }
  });
});
