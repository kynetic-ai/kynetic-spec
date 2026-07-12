# 06 · Spec Workspace (Unified Page+Tree)

> Status: **R3 §07 "unified page+tree" is the chosen direction.** Two archived alternatives (drill-in §05, inline-expand §06) are summarized at the end with why they lost. The coverage-states layer that extends this workspace is doc 07/08.

Screens referenced:

| Image | What it shows |
|---|---|
| `shots/r3-spec-unified-1-tree-hover.png` | Root tree; expand-inline + hover-title "open ↗" affordance |
| `shots/r3-spec-unified-2-module.png` | Module page (Web UI System) |
| `shots/r3-spec-unified-3-feature.png` | Feature page (Web Dashboard) w/ sub-feature expanded inline |
| `shots/r3-spec-unified-4-requirement.png` | Requirement page; ACs as expandable rows, AC-1 expanded |
| `shots/r3-spec-unified-5-ac.png` | AC page (leaf) with scenario, evidence, siblings |
| `shots/r3-archived-spec-drill-*.png` | [archived] drill-in navigation, 5 levels |
| `shots/r3-archived-spec-expand-*.png` | [archived] inline-expand tree, 4 states + leaf page |

---

## 1. Core interaction model (the big idea)

Every spec node — **module, feature, sub-feature, requirement, even individual AC** — supports the *same two gestures*:

1. **Click the row body → expand inline.** Children render directly below as inset rows (vertical guide line ties the group to its parent; parent gets an inset left bar + tinted background to signal expanded state).
2. **Hover the title → an `↗` open-page icon appears (title underlines); click title/icon → navigate to that node's own page.**

On a node's page, its children render as the **same expandable rows** — navigation feels identical at every depth. Inline expansions made before navigating persist on the page; **Back returns to the tree with all expansion state intact.**

Even leaf ACs get a full page — for shareable URLs and focus.

## 2. Node row anatomy (`URow`)

- **Kind pill** (left): `module` purple `#7a3a8a` · `feature` blue `#2f6fdc` · `requirement` green `#1f9d6b` · `constraint` grey `#5a5a5a`. (AC rows show the `AC-n` mono id instead.)
- Title (semibold) + one-line muted summary (ellipsized).
- Optional tag chips (`web`, `svelte`, `api`…).
- **Coverage count** `covered/total` (mono, right-aligned) — always the **rollup of every AC underneath** the node.
- **Coverage dot**: green (good) / amber `#c9962f` (partial) / red (bad). Page headers use a 120px coverage bar with the same thresholds (>70% green, >30% amber, else red).

## 3. The five page shapes

All share: breadcrumb (doc 01 §3), `NodePageHeader` (kind pill, title, tags, coverage bar + n/m, description paragraph, trait chips like `@trait-markdown-rendering`), then children sections.

1. **Root (Specs)** — title + corpus stats (`4 modules · 41 features · 89 requirements · 312 acceptance criteria`), module rows.
2. **Module page** — `FEATURES · n` rows, `CONSTRAINTS · n` rows, `LINKED WORK · 8 tasks · 14 sessions · 3 plans` strip (same component on every page level).
3. **Feature page** — `SUB-FEATURES · n` rows (can nest, expandable inline), plus `REQUIREMENTS · n cross-cutting` section for requirements attached directly to the feature.
4. **Requirement page** — `ACCEPTANCE CRITERIA · 9 · 1 covered`; AC rows expand inline to show GIVEN/WHEN/THEN in a 2-col grid right in the row body; linked-work strip below.
5. **AC page** — header (`AC-1` chip, title, `✓ Covered` pill), provenance line ("last verified 2d ago by session 01KQ11ES4HFP"), `SCENARIO` block (full G/W/T), **`COVERAGE EVIDENCE`** (sessions + implementing tasks with links), `SIBLINGS` (other ACs in the requirement for lateral navigation).

## 4. Data notes

- The tree mirrors `.kspec/modules/*.yaml` spec items; AC coverage comes from test annotations (`// AC: @spec-item ac-N`) + validation runs.
- Coverage rollups per node must be **computed server-side** and cached (corpus is ~312 ACs and grows).
- "Last verified by session X" links coverage state to session records (doc 05).
- Linked work = tasks with `spec_ref`, sessions touching the item, plans deriving it.

## 5. Archived alternatives (recorded rationale)

- **Drill-in (§05)** — each level is a separate page; rows show a `→` affordance and navigate. Lost because: deep hierarchies require many round-trips; no way to scan across branches; the leaf page was good and was kept.
- **Inline-expand (§06)** — pure tree; clicking expands inline, any number of branches open at once, each level inset with a guide line; leaf click navigates to a full page with back-preserves-expansions. Lost as a *sole* model because deep content needs a focused page at every level, not only at leaves.
- **Unified (§07)** = inline-expand's tree mechanics + drill-in's pages at *every* node, disambiguated by click-target (row body vs title). This resolves the tension instead of choosing a side.
- An even earlier exploration (`SpecWorkspace` in `reference-src/wf3-views.jsx`, unmounted) tried a 4-column layout (sidebar · spec tree · body · right rail) with three AC display variants (cards / strip / matrix) and a right rail carrying IMPLEMENTATION / SESSIONS / DERIVED FROM / OBSERVATIONS. The right-rail content survives conceptually as the linked-work strip + AC evidence sections; the OBSERVATIONS-as-derived-findings idea is the settled home for observations (doc 03 §1).

## 6. Open questions

- Where does spec *editing* happen? All five pages are read/navigate surfaces; mutation flows (add AC, edit description) are not yet wireframed.
- Constraint rows have no coverage counts — confirm constraints carry no ACs or display differently.
- Tree virtualization for large corpora.
