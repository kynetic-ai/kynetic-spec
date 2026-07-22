# kspec Web UI — Wireframe Behavioral Spec Export

Prepared for the Kynetic Spec project. Feed this folder to a planning agent to draft kspec plans covering the full scope of the wireframed web UI. Start with `00-product-context.md`, end with `12-implementation-backlog.md` (the consolidated net-new capability list with suggested plan seams).

**These are wireframes** — behavior, states, and information architecture are the spec; visual design (color, type) is deferred. The JSX reference implementation is React but the target is the existing SvelteKit web-ui.

## Contents

```
00-product-context.md                         what/why, source inventory, decision history, caveats
01-app-shell-and-navigation.md                sidebar (focus-collapse), ⌘K palette, status chrome, breadcrumbs
02-all-projects-dashboard-and-notifications.md  urgency timeline = the notification system, cards, alerting
03-inbox-and-triage.md                        capture surface, triage mode, observations-as-derived-findings
04-task-board.md                              kanban w/ live agent presence, dispatch-ready
05-sessions-and-agents.md                     unified session view, decisions, access/budget rails
06-spec-workspace.md                          unified page+tree model (+ archived alternatives)
07-coverage-states.md                         six-state model, decision logic, five-state recommendation
08-spec-states-integration.md                 rollup bars, re-verification banner, stale AC page
09-validate.md                                flat attention queue, matrix, inline resolution
10-planning-workspace.md                      plan.md w/ anchored inline threads, revisions, docked chat
11-reviews.md                                 reviews hub + per-subject surfaces, schema grounding & gaps
12-implementation-backlog.md                  every net-new capability, grouped, w/ suggested plan seams
shots/                                        61 PNG snapshots — every artboard & state, named r<round>-<area>-<state>
reference-src/                                the wireframe sources (React/JSX + HTML hosts)
```

## Shot index

**Round 1** (hand-drawn fidelity): `r1-sidebar-a|b|c|d`, `r1-overview-cards`, `r1-overview-timeline`, `r1-shell-top`, `r1-command-palette`, `r1-status-chrome`, `r1-planning-2pane|3pane|overlay`

**Round 2**: `r2-sidebar`, `r2-overview-timeline`, `r2-app-shell-palette`, `r2-planning-markdown`

**Round 3** (current direction): `r3-sidebar-focus-a|b` · `r3-task-board` · `r3-spec-unified-1-tree-hover…5-ac` · `r3-breadcrumb-variants-a|b|c` · `r3-session-1-trace…5-completed` · `r3-coverage-1-legend…4-five-state-alt` · `r3-spec-states-1-requirement…3-stale-ac` · `r3-validate-1-queue…3-ac-detail` · `r3-planning-1-plan-tab…3-revisions-tab` · `r3-reviews-queue` · `r3-review-task|code|spec` · archived: `r3-archived-agent-detail`, `r3-archived-sessions`, `r3-archived-spec-drill-1…5`, `r3-archived-spec-expand-1…5`

Each doc opens with a table mapping its shots to what they show. Archived shots document rejected directions — their rationale is in the docs; don't plan implementation from them.

## How to mine this for plans

1. Read `00` then `12` to get scope shape; `12.E` proposes plan boundaries in dependency order.
2. For each candidate plan, read the relevant numbered doc(s) end-to-end; the **Behaviors**, **Implementation notes**, and **Open questions** sections translate nearly 1:1 into spec requirements/ACs, technical tasks, and decisions-to-raise.
3. Quote-level fidelity: where docs quote the wireframe verbatim (italics/quotes), treat that as recorded design intent.
4. Cross-check data-model claims against `11 §1` (real `review.yaml` schema) and the live codebase before deriving specs — the docs flag gaps explicitly as "schema extensions to propose."
5. The `reference-src/` JSX contains exact copy, badge logic, color/state tokens (`COV_STATES`, `THREAD_KINDS`, `LIFECYCLE`, `VERDICTS`) and edge-case comments not all of which are repeated in the docs — grep it when a doc detail needs more precision.
