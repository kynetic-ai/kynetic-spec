# Dispatch Trivial-Drift Auto-Repair (Research)

Research-only draft. No specs or tasks proposed yet — capturing investigation
findings and design ideas for later triage.

## Problem

When the dispatch shared checkout (`../kynetic-spec-dispatch`) accumulates
tracked-file drift on its integration target branch, the dispatch engine marks
the target DEGRADED and defers every queued task targeting that branch. The
engine refuses automatic repair if any tracked files are modified, regardless
of *what* those modifications are. The current message tells a human operator
to commit/stash/discard manually.

Observed instance (2026-04-09): A worker invocation's `npm install` left
`package.json` and `package-lock.json` modified with a vitest minor version
bump (`^4.0.17` → `^4.1.4`) on the dispatch checkout's `dev` branch. Dispatch
went DEGRADED, deferred two `pending_review` tasks, and required manual
`git checkout --` to recover. The drift had no real intent behind it — it
was an agent's side effect — and the safe recovery was mechanical.

The cost is silent: tasks sit in `pending_review` indefinitely with no
external alarm, only a recurring "Deferring @X because integration target
\"dev\" is degraded" log line. A user has to notice the dispatch logs to
discover the stall.

## Current Architecture (file:line refs)

- **Drift detection**: `src/agent-runtime/workspace.ts:652-753`
  (`ensureDispatchIntegrationTargetCheckoutCoherence`). Line 676 runs
  `git diff --quiet`; on exit code 1 it throws `buildUnsafeCheckoutDriftError`
  at 683-689 with a fixed message. **No file inspection** — the function
  doesn't know what changed.
- **DEGRADED entry**: `src/agent-runtime/dispatch.ts:3402-3419`
  (`_enterDegradedState`). State stored in-memory in `_degradedTargets` —
  not persisted, no TTL.
- **Deferral**: `src/agent-runtime/dispatch.ts:2228-2235` during queue drain.
- **Recovery**: No retry loop. Recovery happens only when the periodic
  `_syncIntegrationTarget` (3180+) next succeeds, calling
  `_exitDegradedState` (3428-3440). There is no time-based polling of the
  working tree.
- **Agent dispatch**: `src/agent-runtime/dispatch.ts:1117-1127` matches
  task-state events to agent dispatch rules and enqueues invocations.
  All current agents are task-event-triggered. There is no concept of a
  system/maintenance agent triggered by a non-task event.
- **Event registry**: `src/schema/event-registry.ts` defines the event
  type schema. A new system event type would be registered here.

## Design Space

Two distinct tiers, with very different complexity envelopes.

### Tier 1: Inline auto-repair (no agent)

Add a classification step inside `workspace.ts` before the throw at 683.
Run `git diff --name-only`; if every changed file is on a strict whitelist
(initially: `package-lock.json` only), run `git checkout --` on those files,
log the action, and continue as if no drift existed. No new event, no new
agent, no schema change. Roughly 50 lines plus tests.

Properties:
- Fast and cheap — no LLM round-trip.
- Auditable — pure file operation, easy to log and revert reasoning about.
- Mechanically safe within its whitelist.
- Cannot handle drifts that need any judgment.

### Tier 2: Repair agent dispatched on a system event

Add a new event type (e.g. `system.checkout_drift_trivial`), emit it from
`_enterDegradedState` when a classifier marks the drift trivial, and let an
agent definition in `kynetic.meta.yaml` subscribe via the existing dispatch
rule mechanism. No new invocation pathway needed — the existing
`_enqueue` → `runInvocation` flow handles it.

Properties:
- Reuses existing dispatch primitives cleanly.
- Opens the door to semi-trivial repairs requiring judgment (yaml conflicts,
  ambiguous package.json diffs).
- Adds latency and cost (LLM invocation per drift event).
- Introduces a new "system event" precedent in the dispatch model — currently
  every event is task-derived. That's a real architectural shift to absorb.

### Recommended starting point

Tier 1, lockfile-only. If observed drift patterns over time show recurring
non-lockfile cases that *would* be auto-repairable with judgment, escalate
to Tier 2 with the field data to justify the new precedent. Building Tier 2
first risks the new "system agent" pattern landing without a strong use case.

## Open Questions

1. **Whitelist scope.** Strict `package-lock.json` is unambiguously safe.
   Adding `package.json` would have repaired the observed instance, but
   it's also exactly where real intentional dependency changes live —
   the same diff shape appears whether the bump was an `npm install`
   side-effect or a deliberate upgrade. False-positive auto-discard of
   a real `package.json` change could destroy work. Possible refinement:
   only auto-repair `package.json` if the diff is structurally a version
   bump in `dependencies`/`devDependencies` and the matching lockfile
   change is consistent. That's a parser, not a whitelist — likely
   premature.

2. **Audit visibility.** Auto-discarding tracked files silently is scary
   even when correct. Minimum: structured log line with the file list and
   the diff hash. Stretch: file an automatic `meta observe friction`
   entry so the action surfaces in reflection without requiring log
   archaeology.

3. **Loop protection.** If a worker agent's `npm install` keeps
   re-introducing the same drift on every invocation, repeated
   auto-repair would mask a real problem (likely a node_modules
   resolution issue or a missing `--no-save` flag in some script).
   Need a counter: "repaired N times in M minutes → stop repairing,
   stay DEGRADED, escalate." This is the load-bearing safety mechanism
   — without it, auto-repair becomes a way to hide chronic bugs.

4. **Root cause of the observed drift.** Why did a worker's `npm install`
   bump vitest in the first place? Was it `npm ci` (which shouldn't
   touch lockfiles) or `npm install` (which can)? Identifying and
   eliminating the source might be more valuable than auto-repair.
   Worth grepping the worker agent prompts and the bootstrap script
   before committing to auto-repair as a strategy.

5. **Alarm channel for unrepairable drift.** Today, DEGRADED state is
   only visible in the daemon log. Should it surface in `kspec agent
   dispatch status`, in a `kspec inbox` entry, or via a friction
   observation? The user discovered today's instance only because they
   went looking for why a task wasn't being picked up. The detection
   gap is arguably worse than the repair gap.

## Related Items

- @01KKSGTN — original inbox report of test daemon leak (different surface,
  but same theme of "agent side effects accumulating silently")
- @task-cli-serve-test-daemon-cleanup — task that was deferred by today's
  DEGRADED state, surfacing the gap
- `dispatch-remote-branch-sync` spec area — the home of integration
  target sync logic; any repair work would land alongside it
- `src/agent-runtime/workspace.ts` and `src/agent-runtime/dispatch.ts` —
  primary code locations for either tier
