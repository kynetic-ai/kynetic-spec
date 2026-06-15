# 07 · Coverage States (Per-AC State Model)

> Status: **recommendation recorded on the wireframe — ship the five-state UI (Stale + Drifted collapse into "Re-verify") while keeping stale-vs-drifted as a sub-classification on the AC page and as a Validate filter facet.** The six-state model is fully specified because the system must still *compute* the distinction.

Screens referenced: `shots/r3-coverage-1-legend.png` (six state cards + open questions), `shots/r3-coverage-2-decision-logic.png` (truth table), `shots/r3-coverage-3-mixed-list.png` (mixed-state list), `shots/r3-coverage-4-five-state-alt.png` (five-state alternative + recommendation).

---

## 1. The six states

Every acceptance criterion is in exactly one state (modulo the stale+drifted overlap, §3). The first four fall out of annotation + test result; Stale and Drifted require **timestamp comparison** and represent "the system worked, then something moved underneath it."

| State | Glyph | Color | Definition | Signal |
|---|---|---|---|---|
| Covered | `●` | green | Has annotated test(s) and they pass | `annotated && pass` |
| Failing | `✗` | red | Has annotated test(s) but the suite fails | `annotated && fail` |
| Not yet | `○` | grey | AC defined but no test annotation references it | `!annotated` |
| N/A | `⊘` | pale grey, dashed pill, row at 0.55 opacity + strikethrough | Explicitly marked not-applicable (trait ACs that don't apply) | `marked-na` |
| Stale | `⟳` | amber | Spec text changed since the annotation was written | `annotated && spec.edited_at > test.annotated_at` |
| Drifted | `⤳` | amber | Covering code changed since the annotation was written | `annotated && code.edited_at > test.annotated_at` |

Visual tokens are centralized (see `COV_STATES` in `reference-src/wf3-coverage-states.jsx`) and consumed by the spec workspace and Validate — **one state → one color/glyph everywhere**. Ambers (needs re-verification) must read distinctly from greys (not started): "'needs work' and 'not started' are never confused."

## 2. Decision logic (truth table)

Evaluation precedence:

1. **N/A first** — explicit override beats everything.
2. **No annotation → Not yet.**
3. **Failing dominates staleness** — if the test is red, fix that before worrying whether the annotation is current (`annotated && fail` → Failing even if spec also edited).
4. Passing + spec edited → **Stale**; passing + code edited → **Drifted**; passing + both edited → **stale+drifted** (the flagged awkward case, §3).
5. Else **Covered**.

## 3. Recorded open questions (from the legend artboard, decide before shipping)

- **Stale + Drifted on the same AC**: show both pills, or pick the more recent? (The five-state model dissolves this — both become Re-verify; the *cause* line then lists both.)
- **What counts as a relevant code edit?** Whole annotated test file vs only lines inside the test body. Leaning: any edit inside the test function.
- **Where does N/A live?** In spec source (`ac-3: na`-style) vs a separate ignore-list. Spec-source is more discoverable; ignore-list survives spec rewrites. (Note: the CLI convention already uses in-code N/A annotations `// AC: @trait ac-N — N/A: reason` — reconcile.)
- **Stale but passing**: "Covered (stale)" or just "Stale"? **Decided: Stale overrides** — the test was written against a different intent, passing is not meaningful.

## 4. Mixed-list presentation rules

- AC row: 3px state-colored left border, mono AC id in state color, title, optional muted caption explaining the state (`2 of 3 tests fail`, `spec edited 3d ago`, `code edited 5d ago`), state pill at right. Stale/drifted rows get a warm tinted background (`#fdfaf5`).
- **Sort order: covered → failing → stale → drifted → notyet → na.** Failing reads loudest; ambers cluster as "needs re-verification"; greys at the bottom ("nothing to do yet"); N/A recedes.
- **Multi-segment rollup bar (`CovStateBar`)** for any parent node: proportional segments in that sort order, N/A at half opacity; label `covered/total−na covered` (N/A excluded from the denominator).

## 5. Five-state model (ship this)

`Covered · Failing · Not yet · Re-verify (⟳, amber) · N/A`

- **Pro**: simpler rollups; one amber bucket = "attention needed here"; easier Validate filtering; no dual-flag ambiguity.
- **Con**: the *why* (spec moved vs code moved) must still surface when you open the AC — list rows show a muted cause caption (`spec moved` / `code moved`), and the AC page + Validate facets expose the full distinction.

## 6. Implementation notes (the hard new machinery)

This is mostly **backend/CLI work that does not exist yet**:

1. **Annotation timestamping** — record when each `// AC:` annotation was last written/verified (git blame on the annotation line, or a recorded `annotated_at` from validation runs).
2. **Spec edit tracking** — per-AC `edited_at` (shadow-branch commit history of the spec item — exists in principle via kspec-meta git log).
3. **Code edit tracking** — define "covering code" (the annotated test function) and detect edits after `annotated_at` (git diff over test file ranges).
4. **State computation service** — daemon-side, cached, invalidated on shadow commits + test runs; feeds spec workspace rollups, Validate queue, sidebar badges.
5. **Test-result ingestion** — per-AC pass/fail from the latest suite run (vitest reporter → annotation map).
6. **N/A marking flow** — UI affordance + storage decision from §3.
