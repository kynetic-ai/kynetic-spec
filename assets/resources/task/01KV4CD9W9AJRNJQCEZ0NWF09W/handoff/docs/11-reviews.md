# 11 · Reviews — Hub Queue & Per-Subject Surfaces

> Status: **chosen direction, R3 §14–15.** The core idea: a review is one record (`kspec_reviews`) of one review pass against a *subject*, and **each `subject.type` renders its own body shape** while sharing a common header, lifecycle, threads, verdicts, and checks. The Reviews nav target is a flat queue across all subject types.

Screens referenced:

| Image | What it shows |
|---|---|
| `shots/r3-reviews-queue.png` | The Reviews hub — flat queue across all subjects, grouped by lifecycle |
| `shots/r3-review-task.png` | `subject.type=task` — code diff with line-anchored threads |
| `shots/r3-review-code.png` | `subject.type=code` — raw base..head range, NO TASK strip |
| `shots/r3-review-spec.png` | `subject.type=spec` — spec prose + AC-anchored threads |
| (no shot) | `subject.type=plan` — **no dedicated surface; opens the Planning workspace** (doc 10) |

---

## 1. Data model grounding (real schema, from `.kspec/reviews/*/review.yaml` + web `api.ts`)

```yaml
review:
  _ulid, slugs, title, author
  subject: { type: plan|task|code|spec, ref, content_hash, shadow_commit }
  lifecycle_state: draft | open | closed
  threads:
    - _ulid, kind: blocker|question|nit, resolved_at, resolved_by
      anchor:        # union — two shapes exist today:
        # code:       { type: code, path, side: base|head, line_start, line_end, commit }
        # structured: { type: structured, section?, field?, path?, ref? }
      entries: [{ _ulid, author, body, created_at }]
  verdicts: [{ decision: approve|request_changes|comment, reviewer }]
  checks: [{ name, status: pass|fail, required, runner, evidence, applies_to_version }]
  events: [lifecycle_change | thread_created | thread_replied | thread_resolved |
           check_added | verdict_submitted]   # full audit timeline
  examined_commit, external_links, related_refs
```

Shared visual vocabulary (exported tokens in `reference-src/wf3-reviews.jsx` + `wf3-planning.jsx`):

- **Thread kinds** `THREAD_KINDS`: blocker (red ■) / question (amber ?) / nit (grey ·) / idea (green ✦ — *proposed addition, not in schema yet*).
- **Verdicts** `VERDICTS`: APPROVED green / REQUEST CHANGES red / COMMENTED grey.
- **Lifecycle** `LIFECYCLE`: draft muted / open amber / closed green.
- **Subject-type pills** `SubjectTypePill`: PLAN amber / TASK blue `#2f6fdc` / CODE near-black `#444` / SPEC purple `#7a3a8a`.
- **Check pills** `CheckPill`: `✓ vitest` green / `✗ vitest` red, etc.

## 2. Reviews hub (queue)

Header: `Reviews` + `8 records · 4 open · 3 awaiting your action` + `last sync 12s ago`. Tabs: `All (8)` · `By subject` · `Mine (3)` · `By reviewer`. Filter pills: SUBJECT `all | plan | task | code | spec` (with type pills inline); GROUP `state | subject | reviewer`.

Groups by lifecycle with didactic descriptions:
- **Open** — "Awaiting verdict or with unresolved threads."
- **Draft** — "Created but not yet open for review." (e.g. auto-generated reviews with no reviewer yet, dimmed)
- **Closed** — "Resolved. Linked to subject's revision history." (dimmed)

**Queue row** (5-col grid): subject-type pill · title + `subjectRef · rev N` · reviewer (provider glyph or `U` human avatar + name — reviewers can be agents *or* humans, e.g. `@kreed`) · badge cluster (thread kind-counts + check pills + latest verdict chip `✓ approved` / `↻ changes`) · right column (`awaiting` flag in accent + age). Rows carry a lifecycle-colored left border; a row with failing checks is outlined accent (the drawn highlight).

**Routing on click**: plan → Planning workspace; task → task review surface; code → code review surface; spec → spec review surface.

## 3. Shared review header (`ReviewHeader`, all subject types)

1. Breadcrumb row: `kynetic-spec / reviews /` + subject pill + title + lifecycle pill (right).
2. Meta row: `subjectRef · rev N` · reviewer (glyph/avatar + name) · `opened 38m ago` · right-aligned check pills.
3. **Verdict ribbon** (tinted strip): `THREADS 0/7 resolved` | `VERDICT` (latest verdict chip or `awaiting`) | actions when open: `↻ re-request` · `✓ approve` (green) · `↻ request changes` (red).

This ribbon is the review's gate summary — mirrors the CLI review gates (approved disposition + required checks passing + no unresolved blockers).

## 4. Task review (`subject.type=task`) — and code review

Three-pane body under the header: `file tree (240) · unified diff (flex) · thread rail (320)`.

- **File tree**: `FILES · 7 changed` + `+625 −0` rollup; per-file rows with path, thread-count badge **colored by the most severe thread kind** in that file, +adds/−dels, `✗` marker on files with failing tests. Active file highlighted.
- **Diff view**: sticky file header (path, +/−, `view ▸ unified · split · raw`), hunk headers, line rows (number gutter, +/− symbol, syntax line). **Anchored lines** get a warm background + 3px accent left border; the thread bubble renders *directly beneath its anchor line*, indented, with kind-colored left border — anatomy: provider glyph, author, KIND chip, `· path:line` anchor label, time; body (rich text, can cite trait ACs like `@trait-loading-states ac-2`); footer `↳ reply…` + `resolve`.
- **Thread rail**: `THREADS · 7 total` + `0/7 resolved` (accent); filter pills `all 7 | blockers 2 | nits 4`; **jump rows** (kind chip, anchor `file:line`, 2-line snippet; click scrolls diff to anchor; active row tinted). Pinned bottom: **CHECKS panel** — `✗ vitest — 3 failures in tests/web/reviews.test.ts` / `✓ typecheck — 0 errors` / `✓ lint` (name, status, evidence from the check record).
- The anchor labels mirror the real anchor shape exactly: `path + line_start/line_end + side (+ commit)`.

**Code review (`subject.type=code`)** is the same surface minus the task: the subject is a bare `abc123 → def456 · 8 files` commit range. A **`NO TASK` strip** under the header explains "This review covers a raw commit range with no task attached — a hotfix." and offers **`+ attach to task`** (retroactively binds the review to a task). Use case: hotfixes reviewed before any task object exists.

## 5. Spec review (`subject.type=spec`)

Body = the spec's prose + acceptance criteria; threads anchor to **specific ACs**:

- Header block: kind pill + spec title, meta (`rev 3 · proposed · parent @daemon-server`).
- AC list: each AC as a card (`AC-n`, text, maturity chip `PROPOSED`). ACs with threads get an accent outline; the thread renders indented beneath the AC card.
- AC thread extras beyond the common anatomy: an optional **SUGGESTION block** (dashed-top section with a concrete proposed fix) and an extra action **`↳ accept & open follow-up`** (accept the suggestion and spawn follow-up work) alongside `resolve`.
- Right rail: `THREADS · 3 unresolved` jump cards (kind, `ac-n` anchor, snippet) · `DERIVED FROM` (plan ref + rev) · `RELATED SPECS` (sibling / parent constraint / inherited traits) · `HISTORY` (spec revision list with notes).

**Deliberate dogfooding detail**: the drawn blocker thread on `ac-3` is the spec-review-agent pointing out that *"the anchor schema isn't specified — code subjects need path/line/side/commit; spec subjects need `spec_ref` + `ac_id`; plan subjects need `section` + `offset_start/end`. The AC says 'optional anchor' without defining the union."* That is the real data-model gap this UI needs closed: **the anchor union must gain a spec-AC variant and a plan-text-offset variant** (today only `code` and loose `structured` exist).

## 6. Plan review (`subject.type=plan`) — no separate surface

Verbatim design contract from the wireframe: plan reviews open **directly into the Planning workspace** (doc 10) with:

- the review's open threads inlined against the plan body at their text anchors,
- the review record selected in the right rail (lifecycle, verdicts, checks),
- optionally a `?review=…&thread=…` deep link that scrolls-and-flashes the target thread.

Rationale: "the plan author and reviewer share one workspace — no context switch between 'viewing the plan' and 'viewing the review.'"

## 7. Behaviors & gates

1. Thread resolve/reply from any surface mutates the same record (`POST /threads`, `/replies`, `/resolve` endpoints — these exist in `api.ts`).
2. Verdict actions in the ribbon submit verdict events; approve is gated on required checks + no unresolved blockers (server-enforced; UI should disable + explain).
3. Check results arrive from runner sessions; clicking a check should link to its evidence/session.
4. Live updates over WS (the plan body itself records the open question: per-event types vs single `review_updated` — the spec-review nit recommends **per-event types**).
5. Lifecycle transitions: draft → open → closed; closed reviews stay browsable and linked to subject revision history.

## 8. Implementation notes / gaps

- **New anchor variants** (spec-AC, plan-text) + `idea` thread kind — schema PRs to kspec core before UI work.
- Diff rendering: server must provide base..head file diffs for task/code subjects (`diff_params { base, head }` already appears in `ReviewContentResponse`).
- The existing `/reviews/[id]` route renders generic content sections — the per-subject surfaces replace that with subject-specific renderers behind one route (the drawn question "are the four subject renderers one component or four?" is open implementation detail).
- Thread-anchor → DOM mapping for plan/spec subjects shares machinery with planning inline threads (doc 10 §4).
