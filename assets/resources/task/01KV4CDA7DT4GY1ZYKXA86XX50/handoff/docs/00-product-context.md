# 00 · Product Context & How This Export Came To Be

## What this is

A behavioral-spec export of the **kspec web UI wireframe explorations** (rounds 1–3), prepared for the Kynetic Spec project so an agent can draft kspec plans covering the full scope of the work. The wireframes were built as React mockups purely as a *reference rendering* — **the target implementation is the existing SvelteKit web-ui** (`src/routes/…`, daemon-backed). Treat the JSX in `reference-src/` as a precise behavioral artifact, not code to port.

These are wireframes: **layout, behavior, states, and information architecture are the spec; visual design (colors, type, spacing) is explicitly deferred** and will be defined later. The amber/paper palette in the shots is scaffolding, not brand.

## What kspec is (context for the agent)

kspec is a spec-first development system: spec items (modules/features/requirements/constraints with Gherkin-style ACs) live in a `.kspec/` **shadow branch** worktree; tasks track work and reference specs; agents (task-worker, pr-reviewer, plan-agent, …) are dispatched by a daemon-hosted **dispatch engine**; **reviews are first-class records** (`kspec_reviews`) with subjects, threads, verdicts, and checks; test↔AC linkage happens via `// AC: @spec ac-N` annotations. The web UI is a Svelte SPA served by the daemon (REST + WebSocket).

## Source inventory

| Round | File | Sections |
|---|---|---|
| 1 (sketch fidelity) | `wireframes.html` | sidebar variants A–D · all-projects overview (cards + timeline) · app shell (top bar, ⌘K palette, status chrome) · planning (3 layout variants) |
| 2 (refined) | `wireframes-v2.html` | settled sidebar (Inbox heads PLAN, RUNNING inline) · timeline-primary overview w/ cards toggle · app shell w/ ⌘K · markdown-first planning w/ inline reviews + docked chat |
| 3 (current) | `wireframes-v3.html` | sidebar focus-collapse · task board · spec workspace (drill-in + inline-expand archived → unified page+tree chosen) · breadcrumb truncation · sessions unified (supersedes agent-detail + sessions split) · coverage states · spec×states integration · validate · planning v3 · reviews hub + per-subject surfaces |

Round 3 marks superseded sections `[ARCHIVED]` in place — they are included here (docs + shots) because they carry rationale.

## Reading order for planning

1. `01` shell & navigation → the frame everything sits in
2. `02`/`03` dashboard, notifications, inbox → cross-project + capture layer
3. `06` spec workspace → the core navigation model
4. `07`/`08`/`09` coverage states → validate → the alignment machinery (largest net-new backend scope)
5. `10`/`11` planning & reviews → the collaboration core (review records, anchored threads)
6. `04`/`05` board & sessions → execution surfaces
7. `12` implementation backlog → consolidated net-new technical capabilities & schema gaps

## Decision history (cross-round narrative)

- **Sidebar**: A/B/C/D explored → C's PLAN/WORK grouping won, D contributed RUNNING + attention-first pills → R2 added Inbox-heads-PLAN and ALL PROJECTS → R3 settled focus-collapse (one project expanded at a time, per-project section collapse remembered).
- **Overview**: cards vs timeline competed in R1 → R2 settled timeline-primary with cards as a toggle; the timeline *is* the notification system (no separate tray).
- **Inbox/triage/observations**: separate destinations in R1 → R2 collapsed: triage = mode of Inbox; observations = derived findings shown in context.
- **Planning**: chat-left vs 3-pane vs markdown-first in R1 → R2: markdown-first + docked (not floating) chat + GitHub-PR-style inline threads + multi-review-per-revision → R3: modeled on the real review schema, plan list + tabs (plan.md / revisions / reviews / derived), review summary rail.
- **Spec workspace**: drill-in vs inline-expand both archived → unified page+tree (every node expands inline AND has its own page; hover-title ↗ disambiguates) → extended with coverage states (multi-segment rollups, re-verification banner, stale AC page).
- **Coverage**: six computed states (covered/failing/notyet/na/stale/drifted) with full decision logic → ship five-state UI (stale+drifted → Re-verify) with cause as sub-classification.
- **Sessions**: agent-detail page + sessions/terminal page → one unified session view (trace/transcript/files/decisions tabs, sticky decision banner, context/access/budget rail); session = unit of execution; same shape for running/blocked/completed.
- **Reviews**: plan-reviews-as-separate-nav (R1 variant B) rejected → one Reviews hub across all subject types; each `subject.type` gets its own body shape; plan reviews render *inside* the planning workspace.
- **Breadcrumbs**: six truncation strategies → adaptive rule (full ≤4 segs; root+…+last2; root+…+last1; `‹‹` stack) with popover-rendered collapsed segments.

## About chat histories

The user asked for the design-conversation history to be included. The full chat transcripts of the wireframing sessions were **not recoverable as files** at export time; this export compensates with (a) the decision narrative above, (b) per-doc "explored alternatives / why they lost" sections, and (c) every annotation, open question, and behavioral note that was written into the wireframes themselves (those were the durable record of the conversations). Where a decision's rationale was recorded verbatim on an artboard, the docs quote it.

## Fidelity caveats

- All data in the shots is **plausible fiction** (refs like `@plan-review-records-web-ui`, counts, timestamps) — mirroring real kspec data shapes but not real project state.
- Round-1 shots render in a hand-drawn style on purpose (lowest fidelity round).
- Some interactions are described in labels/notes rather than drawn (e.g. drag-and-drop, every hover state); docs flag these as open where material.
