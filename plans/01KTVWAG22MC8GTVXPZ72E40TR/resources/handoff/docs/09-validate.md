# 09 · Validate View

> Status: R3 §12 — single direction with two complementary presentations (Queue default, Matrix alternate). This is **the home for failing / stale / drifted ACs** — the flat-queue inverse of the spec tree: "what in my spec is out of alignment right now?", prioritized by severity, cleared one after another without leaving the queue.

Screens referenced: `shots/r3-validate-1-queue.png`, `shots/r3-validate-2-matrix.png`, `shots/r3-validate-3-ac-detail.png`.

---

## 1. Frame & header (shared by all tabs)

- Title `Validate` + corpus line (`312 acceptance criteria across 4 modules`).
- Right: `last sync 38s ago` + **`↻ re-run all`** (triggers a full validation pass).
- **Project-level breakdown bar** (`BigCovBar`): 12px multi-segment bar over all ACs + a legend row with per-state dot/count/label, ending with the derived headline **`49 need your attention`** (= failing + stale + drifted; accent, bold). This number is the source of the sidebar `Validate 49⚠` badge.
- Tabs: `Queue (49)` · `Matrix` · `History` (History not drawn — reserved for validation-run history). Right-aligned search: `filter by name, parent, tag…`.

## 2. Queue tab (default)

Controls row: `SHOWING` filter pills (`needs attention` default-active · all · failing · stale · drifted · not yet) + `GROUP BY` pills (`state` default · module · age).

Grouped by state in **priority order, each group headed by its glyph, label, count, and a didactic description**:

1. **Failing (12)** — "Tests are red. Fix these first — staleness and drift aren't meaningful while a test is failing."
2. **Stale (28)** — "Spec text moved after the test was annotated. The test may pass against a different intent than what the AC now claims."
3. **Drifted (9)** — "Covering code changed after the test was annotated… verify the test still maps to the AC's claim."
4. **Not yet (109)** — muted, description suppressed in-list ("Defined ACs with no test annotation. Each one is a piece of intent the suite doesn't measure.").

**Queue row** (4-col grid): AC id (state color) · name + full parent path (mono, ellipsized, e.g. `Web UI / Web Dashboard / Plans View / Plan Content Embedded Views`) · reason caption (`2 of 3 tests fail`, `spec edited 3d ago by @kreed`, `code edited 5d ago — 3 lines in embedded.ts:204-208`, `flaky · failing intermittently`) · age (`stale 3d`, `failing 18h`). State-colored 3px left border.

Each group truncates with a `+ N more <state> ACs — expand ▾` affordance.

## 3. Inline AC detail (no navigation)

Clicking a row expands it in place (heavy ink outline, `▾`), revealing a **condensed version of the Stale AC page** (doc 08 §2) so you stay in the queue:

- `SPEC DIFF · GIVEN unchanged · THEN edited` — compact 3-col was→now table (label | struck-through was on warm bg | now on green bg), only changed clauses listed in the summary.
- `ANNOTATED TEST` — file:line, `passing · 28ms`, `annotated 13d ago · @spec ac-4`.
- `RESOLVE` — four actions: **`Update test → dispatch @bash-coder`** (primary, filled) · `✓ Mark verified as-is (accept snapshot)` · `↶ Revert spec edit` · `Open AC page →` (ghost escape-hatch to the full page).

Same content as the AC page, two presentations — inline keeps the user in flow for batch-clearing.

## 4. Matrix tab

`modules × states` table:

- Header row: MODULE + the six states (dot + label, state-colored) + ROLLUP.
- Cells: counts; zeros render as muted `—`; **actionable cells (failing/stale/drifted, n>0) render in state color and get a saturated background once over a per-state threshold** (stale ≥10, failing ≥5, drifted ≥3 in the wireframe — treat thresholds as tunable "heat").
- Row end: mini `CovStateBar` rollup per module. Footer: TOTAL row.
- **Click a cell → jump back to Queue filtered to that module × state intersection.**
- Below: an **OBSERVATIONS panel** — narrative findings derived from the matrix (e.g. "Web UI has **24 stale ACs** — Kreed's spec edits last week landed without follow-up test passes. This is the largest single re-verification bucket."). These are generated insights (agent- or rule-produced), in keeping with observations-as-derived-findings (doc 03).

## 5. Implementation notes

- Queue + matrix are projections of the same per-AC state dataset (doc 07 §6) — build the state-computation service first; both views are then mostly presentation.
- Group-by `module` and `age` reorder the same rows; filters and group-by combine; cell-click from Matrix deep-links with query params (use `goto()` for URL state).
- Inline resolution actions mutate and should optimistically collapse the row out of the queue when the state clears.
- `re-run all` and per-AC test runs need a daemon endpoint to execute the suite (or accept results pushed from CI) — decide execution model early.
- History tab reserved: validation runs over time (trend of the breakdown bar) — not yet specified.
