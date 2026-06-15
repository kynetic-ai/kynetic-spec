# 08 · Spec Workspace × Coverage States (Integration)

> Status: R3 §11 — extends the unified spec workspace (doc 06) with the state model (doc 07). Single direction, no competing variants.

Screens referenced: `shots/r3-spec-states-1-requirement.png` (requirement page, all six states), `shots/r3-spec-states-2-tree-rollups.png` (tree with multi-segment rollups), `shots/r3-spec-states-3-stale-ac.png` (stale AC page with spec diff + resolve actions).

---

## 1. What changes vs the plain workspace (doc 06)

1. Coverage rollup becomes a **multi-segment `CovStateBar`** (covered/failing/stale/drifted/notyet/na) instead of a single covered/total ratio — readable at every tree level. Each row's bar is the rollup of every AC underneath it.
2. AC rows use the shared `StatePill`/state tokens so visual treatment matches the legend, Validate, everywhere.
3. A **filter chip strip** narrows the AC list by state inline: `all 12 · covered 3 · failing 1 · stale 2 · drifted 1 · not yet 4 · n/a 1` (each chip carries its dot + count; active chip inverts). Right side of the strip: `⟳ 3 need re-verification → validate` quick link.
4. The requirement page surfaces a **re-verification banner** when any AC is stale/drifted: warm panel, `⟳`, "**3 ACs need re-verification.** 2 stale (spec edited after the test was annotated) · 1 drifted (covering code edited after the test was annotated)." with CTA **`review in Validate →`** — the entry point into the Validate view scoped to this requirement.
5. A **WHOLE PROJECT rollup strip** heads the tree: project-wide `CovStateBar` (e.g. 145 covered / 12 failing / 28 stale / 9 drifted / 109 notyet / 9 na of 312) + `⟳ 37 need re-verification`. This is also the source for the sidebar's `Validate 49⚠`-style badge (failing + stale + drifted).

## 2. Stale AC page (the resolution surface)

For a stale AC, the AC page becomes a focused decision tool:

1. **Header**: `AC-4` amber chip, title, `⟳ Stale` pill.
2. **Why-stale banner**: "Spec text was edited **3 days ago** by `@kreed`. The annotated test (`test_unparseable_yaml_fallback`) was written against the previous wording 13d ago. The test still passes — but it may not be testing what the AC now claims." (Requires per-edit author + timestamps.)
3. **SPEC DIFF — what the AC used to say vs now**: per-clause (GIVEN/WHEN/THEN) was→now blocks; unchanged clauses marked `unchanged` and muted; changed clauses show struck-through *was* (warm bg) and *now* (green bg). **This requires per-AC structured diffing between spec revisions.**
4. **ANNOTATED TEST**: file:line, passing/failing pill, last run + duration, the annotation comment. Links to source.
5. **RESOLVE — three actions** (cards; primary = filled):
   - **Update the test** (primary) — "Confirm test exercises new behavior… Re-annotate; freshness clock resets." CTA: `Dispatch task → @bash-coder` (resolution can dispatch an agent).
   - **Mark verified as-is** — "stamp the annotation as re-verified at this commit." CTA: `✓ Accept current snapshot`.
   - **Roll back the spec** — "If the spec edit wasn't intentional, revert it. The annotation goes back to fresh automatically." CTA: `↶ Revert spec edit`.

The same panel appears **inline in the Validate queue** (doc 09 §3) — same content, two presentations.

A drifted AC page is the mirror image (code diff instead of spec diff) — not separately drawn; derive it from this shape.

## 3. New machinery implied (beyond doc 07 §6)

- **Per-AC spec revision diffing**: store/recover the AC text as of `annotated_at` and diff against current (shadow-branch history makes this possible; needs an API).
- **Re-verification stamp**: a recorded "verified at commit X by user Y" event that resets freshness without code changes.
- **Spec revert flow**: revert a specific spec edit from the UI (shadow-branch commit revert via daemon).
- **Dispatch-from-resolution**: create + dispatch a fix task pre-loaded with the AC context.
