# 01 · App Shell & Navigation

> Behavioral spec mined from wireframe rounds 1–3.
> Status: **sidebar structure (V3) and breadcrumb variant F are settled directions**; round-1 sidebar variants A–D are recorded as explored alternatives with the reasoning that led to V3.

Screens referenced:

| Image | What it shows |
|---|---|
| `shots/r1-sidebar-a.png` | R1 Variant A — AGENTS / WORK / SPECS / CONFIG grouping |
| `shots/r1-sidebar-b.png` | R1 Variant B — PLANNING broken out as its own group |
| `shots/r1-sidebar-c.png` | R1 Variant C — PLAN / WORK merged-operations grouping |
| `shots/r1-sidebar-d.png` | R1 Variant D — attention-first, everything collapsed |
| `shots/r2-sidebar.png` | R2 sidebar — chosen C+D hybrid (Inbox heads PLAN, RUNNING inline) |
| `shots/r3-sidebar-focus-a.png` | R3 — kynetic-spec focused (others collapsed) |
| `shots/r3-sidebar-focus-b.png` | R3 — plantry focused; kynetic-spec auto-collapsed |
| `shots/r1-shell-top.png` | R1 top bar — project crumb / breadcrumb / palette / contextual sub-bar |
| `shots/r1-command-palette.png` | R1 command palette concept |
| `shots/r1-status-chrome.png` | R1 bottom status chrome concept |
| `shots/r2-app-shell-palette.png` | R2 app shell with ⌘K palette open over content |
| `shots/r3-breadcrumb-variants-a/b/c.png` | R3 — six breadcrumb truncation strategies + recommendation |

---

## 1. Sidebar — final structure (R3)

The sidebar is a **multi-project, project-focused tree** on a dark surface. Top-to-bottom anatomy:

1. **Brand row** — `kspec` wordmark + a `+` affordance (add/register project).
2. **ALL PROJECTS row** — a persistent entry above the project list, always one click away. Carries an aggregate attention pill (e.g. `4 ⚠`) summing "needs you" items across every project. Navigates to the all-projects dashboard (doc 02).
3. **Project rows** — one per registered project, each with a color swatch, name, and a right-aligned *pulse* indicator (see §1.3).
4. **Expanded (focused) project** — exactly one project renders its nav tree inline (see §1.1).
5. **Status footer** — pinned to the bottom: daemon health + port (`● daemon :3456`) and dispatch summary (`dispatch · 2`).

### 1.1 Focus-collapse behavior (settled, R3 §01)

- **Exactly one project is expanded at a time** — the *focused* project.
- Clicking a collapsed project's row expands it and collapses the previously focused one.
- The focused project stays in place when you navigate within it, so its active subroute remains visible.
- Sub-sections within a project (PLAN / WORK / RUNNING / AGENTS / CONFIG) can each be independently collapsed by the user; **those choices are remembered per-project** (persistence requirement — localStorage or user settings).
- R2 had recorded the open question "multi-expand vs auto-collapse?"; R3 resolves it: **multi-expand is disallowed** because multi-expanded sidebars get too long.

Edge cases explicitly called out on the wireframe:

- A **non-focused project with an active running agent or blocker still surfaces an attention pill** on its collapsed row (decision recorded as "currently: yes").
- `Cmd+1..N` to focus the Nth project — noted as "likely yes for power users".

### 1.2 Section structure inside the focused project (settled, R2→R3)

```
PLAN
  Inbox        (badge: open inbox count, e.g. 7)
  Plans        (badge: count needing attention, amber ⚠ variant, e.g. 2⚠)
  Specs
  Validate     (badge: ACs needing attention, amber ⚠, e.g. 49⚠)
WORK
  Tasks        (badge: actionable count, e.g. 3)
  Board
  Reviews      (badge: green count = awaiting your action, e.g. 2)
RUNNING        (collapsible; only present when agents are live; shows live dot + count)
  <agent> · @ref     one row per live agent: provider glyph (colored green when
  <agent> · @ref     running), agent name, current subject ref in mono
AGENTS         (collapsed by default; total count at right, e.g. 4)
  Sessions     (dim/secondary row)
CONFIG         (collapsed by default)
```

Decisions encoded here (R2 section 01 annotations, verbatim intent):

- **Inbox heads the PLAN group as the capture surface.** Triage is a *mode inside the Inbox view*, not a separate nav item. Observations surface as *derived findings on plans/specs*, not a separate destination. (R1 variant A had Inbox under WORK; B dropped it; C had it under WORK; the R2 synthesis moved it to the top of PLAN.)
- **RUNNING is borrowed from R1 variant D** — an inline list of live agents on this project. It collapses when nothing is running.
- **AGENTS + CONFIG are collapsed by default**, opened on demand.
- Badge color semantics: **amber ⚠ = needs your attention**, **green = awaiting your action (reviews)**, plain = neutral counts. Red pill on a *collapsed* project row = blocker in that project (see plantry/ralph rows).
- Collapsed project rows can also carry: `idle` muted pill, green dot (healthy/active), red count pill (blockers).

### 1.3 Explored alternatives (R1, recorded for rationale)

| Variant | Grouping | What it tested | Why it lost |
|---|---|---|---|
| A | AGENTS / WORK / SPECS / CONFIG | Notes-faithful ordering; agents first | Agents rarely the primary destination; planning had no home |
| B | PLANNING / WORK / AGENTS / SPECS / CONFIG | Planning as a first-class group with Plans / Drafts / Plan reviews | Splitting "Plan reviews" from "Reviews" fragments review surfaces (later unified in R3 Reviews hub) |
| C | PLAN / WORK (+ inline AGENTS) / CONFIG | Operations-merged; agents as a flat sub-group under WORK | Won structurally — became the R2 base |
| D | NEEDS YOU / RUNNING / everything collapsed | Attention-first; nav itself is a todo list | Too lossy as the *only* nav, but its RUNNING section and attention-pill ideas were kept |

---

## 2. App shell

### 2.1 Top chrome (R2 direction)

A slim (≈38px) dark top bar:

- Left: window controls (desktop-app affordance).
- **Center: command palette opener** — a wide (≈380px) inset field reading "Search anything · run command · go to…" with a `⌘K` kbd chip. The palette is the primary global navigation instrument.
- Right cluster (mono, small): daemon dot, aggregate attention count (`3 ⚠`, amber), running-agent count (`4 running`).

R1 explored a heavier two-row header (project crumb zone at left, view breadcrumb center, palette + icons right, plus a **contextual sub-bar** carrying the current entity's ref, lifecycle pill, child counts, and view-specific actions like `Export` / `Approve & derive`). The R2 shell slims the global bar and pushes entity context down into each view's own header — but the *contextual action strip* idea (entity ref + state pill + actions) recurs in every R3 view header and should be treated as the standard view-header pattern.

### 2.2 Command palette (⌘K)

Single input; results grouped into ranked sections:

1. **JUMP TO** — fully-qualified paths `project / area / @ref` with a trailing state hint (`rev 4`, `task · blocked` in red). Top hit highlighted with accent background + left accent border.
2. **ACTIONS** — context-aware verbs, each with optional kbd shortcut: "Send active selection to plan-agent ⌘⏎", "Trigger pr-reviewer on @auth-refactor rev 4 ⌘R", "Capture to inbox: '…' ⌘I", "New plan from selection".
3. **AGENTS** — live agents with their current subject and elapsed time; selecting jumps to the session.
4. **RECENT** — recently visited entities across all projects, muted.

Footer legend: `↑↓ navigate · ⏎ open · ⌘⏎ run · ⇥ filter`.

Behavioral notes:
- Search must match across **all projects**, not just the focused one (results carry the project prefix).
- "Capture to inbox" turns the current query text into an inbox item — the palette doubles as the quick-capture entry point.
- Actions are *parameterized by current context* (selection, current entity, current revision).

### 2.3 Status chrome

System-health strip (R1 explored it as a bottom bar; R2/R3 fold it into the sidebar footer + top bar). Canonical contents wherever it lives:

- daemon status + port
- dispatch engine: active / queued counts
- shadow-branch sync recency ("shadow synced 14s ago") — surfaces the worktree health that `kspec shadow status` reports
- app version
- aggregate "N needs you" (amber) — click ≈ jump to attention/inbox

---

## 3. Breadcrumbs — long-path truncation (R3 §08)

Problem: spec paths go 6+ levels deep (`Specs › Web UI System › Web Dashboard › Plans View › Plan Content Embedded Views › AC-1`). The bar must stay on **one line** and never wrap, while every ancestor stays reachable.

Six variants were drawn (see `shots/r3-breadcrumb-variants-*.png`); each ellipsis is a **popover** that renders the collapsed segments inline, in the same `›`-separated style as the bar (visually consistent, clickable left-to-right, keyboard navigable ↑↓ + enter, no layout shift):

- **A · Full path** — control; only when space allows.
- **B · Root + … + immediate parent + current** — ellipsis popover holds the middle.
- **C · Ellipsis-only** — drops root too; popover holds entire chain including root.
- **D · Per-segment name truncation** — keeps all segments, ellipsizes names; "doesn't scale past ~6 levels", relies on hover-to-reveal.
- **E · Ancestor stack `‹‹`** — only current node + stack button; popover = full path. Most aggressive.
- **F · Root + … + last two + current** — **recommended default**.

**Adopted adaptive rule (ship this):**

| Segment count | Render |
|---|---|
| ≤ 4 | full path, no ellipsis |
| 5–6 | root + … + last 2 + current (F) |
| 7+ | root + … + last 1 + current (B) |
| still overflows | `‹‹` stack (E) |

Segments render with their **spec-kind pill** (module / feature / requirement / constraint — see doc 06 §kind-pills) next to the name; the current segment gets an accent-tinted background and bold weight.

---

## 4. Implementation notes (Svelte target)

- The existing web-ui has top-level routes (`/plans`, `/specs`, `/tasks`, `/reviews`, `/inbox`, `/sessions`, `/validate`, `/triage`, `/observations`, …) but **no multi-project sidebar, no focus-collapse tree, no ALL PROJECTS aggregate**. The sidebar implies a *project registry* + per-project daemon/cache scoping (the daemon already supports project headers — see `getProjectHeaders()` in `src/lib/api.ts`).
- Triage currently exists as a separate route (`/triage`); the wireframes fold it into Inbox as a mode (doc 03). Same for `/observations` → derived findings strips on plans/specs.
- Badge counts (inbox open, plans-needing-attention, validate-attention, tasks actionable, reviews awaiting-you) must come from **server-side aggregation endpoints**, not client-side list fetches (project convention: "API list endpoints must use pagination; use server-side aggregation for computed statistics").
- Sidebar nav state (focused project, per-project section collapse) persists across sessions.
- Keyboard: `⌘K` palette; proposed `⌘1..N` project focus.
- All URL/query state changes must go through `goto()` from `$app/navigation` (project convention — `replaceState`/`pushState` break reactive effects).

## 5. Open questions

- Attention pill on collapsed projects: current decision is *yes* — revisit only if it proves noisy.
- Where status chrome finally lives: sidebar footer (current direction) vs dedicated bottom bar.
- Palette ACTIONS section: which verbs ship first (the four drawn are: send-to-plan-agent, trigger reviewer on rev, capture-to-inbox, new-plan-from-selection).
