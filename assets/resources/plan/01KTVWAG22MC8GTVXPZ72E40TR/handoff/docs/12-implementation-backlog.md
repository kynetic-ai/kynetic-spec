# 12 · Implementation Backlog — Net-New Technical Capabilities

> Consolidated from every doc's "implementation notes." These are the things the wireframes assume that **do not exist yet** in the kspec daemon/CLI/web-ui — the raw material for kspec plans. Grouped by system layer; each item lists the docs that motivate it.

## A. Schema / data model (kspec core)

1. **Anchor union extensions** for review threads: spec-AC anchor (`spec_ref` + `ac_id`) and plan-text anchor (`section` + `offset_start/end` + quoted text for re-matching). Today only `code` and a loose `structured` shape exist. *(10, 11)*
2. **Thread kind `idea`** in addition to blocker/question/nit. *(10, 11)*
3. **Plan revisions as first-class data**: revision number, author (agent or human), summary note, timestamps, link to reviews that ran against each revision. *(10)*
4. **Session entity surface**: typed trace events, raw transcript, file-diff-vs-base-commit, structured decisions (pending/resolved, choices, resolution + rationale), access scope, budget usage. *(05)*
5. **Structured decisions protocol**: agents raise decisions with explicit choices; humans resolve from UI; resolution feeds back into the running session. Upgrades today's task-block-with-reason-string. *(02, 04, 05)*
6. **AC coverage-state fields**: `annotated_at`, last verification stamp (commit + actor), N/A marking + storage decision (spec-source vs ignore-list, reconcile with in-code `N/A:` annotations). *(07, 08)*

## B. Daemon / API

7. **Coverage-state computation service**: per-AC state (covered/failing/notyet/na/stale/drifted) from annotation presence, test results, spec-edit timestamps (shadow-branch history), code-edit detection over annotated test ranges; cached + invalidated on shadow commits and test runs; per-node rollup aggregation. **The largest net-new backend scope.** *(06, 07, 08, 09)*
8. **Per-AC spec revision diff API** (text of AC as-of `annotated_at` vs current). *(08, 09)*
9. **Resolution mutations**: re-verify stamp, spec-edit revert, dispatch-fix-task-from-AC. *(08, 09)*
10. **Test execution / ingestion endpoint** for `re-run all` + per-AC results (vitest reporter → annotation map). *(09)*
11. **Server-side aggregation endpoints** for every badge/count: inbox open, plans-needing-attention, validate-attention, reviews-awaiting-you, per-project "needs you", board columns. *(01, 02, 04)*
12. **Cross-project layer**: project registry, per-project scoping/multiplexing, aggregate notification/event feed with urgency classification (RIGHT NOW / AWAITING REVIEW / HEADS UP / BACKGROUND). *(01, 02)*
13. **WS event granularity**: per-event types (`thread_created`, `verdict_submitted`, …) on a reviews topic; session trace streaming; dispatch/board live updates. *(04, 05, 11)*
14. **File diffs for review subjects** (task/code): base..head per-file unified diff payloads. *(11)*
15. **Heads-up rule engine** (e.g. inbox staleness >7 days), configurable. *(02, 03)*
16. **Review gating enforcement** surfaced to UI: approve disabled w/ reasons until required checks pass + blockers resolved. *(11)*

## C. Web UI (Svelte)

17. **Multi-project sidebar** with focus-collapse, per-project section-collapse persistence, attention pills, ALL PROJECTS entry, `⌘1..N`. *(01)*
18. **Command palette (⌘K)**: cross-project jump, parameterized actions, capture-to-inbox, agents, recents. *(01)*
19. **All-projects dashboard**: urgency timeline + cards toggle + system/agents rail; CTAs deep-link to resolving surfaces. *(02)*
20. **Inbox with triage mode** (fold `/triage` in; dissolve `/observations` into contextual strips). *(03)*
21. **Task board** with live agent presence and `dispatch ready (N)`. *(04)*
22. **Unified session view** (trace/transcript/files/decisions, sticky decision banner, context-injection input, rails). *(05)*
23. **Unified page+tree spec workspace** with state rollup bars, filter chips, re-verification banner, stale-AC resolution page. *(06, 08)*
24. **Validate view** (queue w/ inline AC detail, matrix w/ cell deep-links, history reserved). *(09)*
25. **Planning workspace v3**: plan list, plan.md w/ anchored inline threads + hover-gutter comment affordance, revisions, reviews tab, review summary rail, docked plan-agent chat with diff attachments and @-context chips. *(10)*
26. **Reviews hub + per-subject surfaces**: queue; task/code three-pane diff review; spec AC-anchored review; plan reviews routed into planning. *(11)*
27. **Anchor→DOM rendering engine** shared by plan threads, spec threads, and `?thread=` deep-link scroll-and-flash. *(10, 11)*
28. **Breadcrumb component** with adaptive truncation + popover. *(01)*

## D. Conventions to honor (from project meta)

- URL/query state via `goto()` only; no `history.*` (breaks reactive effects).
- Paginated list endpoints; no unbounded client fetches; server-resolved titles via ref index.
- WS reconnect tolerance; cached counts invalidate on WS events, no polling.
- Static-mode (`api-static.ts`) degradation: review mutations & live features need graceful read-only fallbacks.

## E. Suggested plan seams

Reasonable kspec plan boundaries, in rough dependency order:

1. Schema extensions (A1–A6) — small, unblock everything.
2. Coverage-state engine (B7–B10) — backend-first, CLI-verifiable before UI.
3. Aggregation + badges (B11) and WS granularity (B13).
4. Spec workspace unified page+tree (C23) on top of 2–3.
5. Validate view (C24).
6. Review surfaces (C26 + B14, B16) and planning workspace (C25 + C27).
7. Sessions (A4–A5, C22) + board (C21).
8. Cross-project layer (B12, C17–C19) — independent track, large.
9. Inbox/triage consolidation (C20, B15) — small, anytime.
