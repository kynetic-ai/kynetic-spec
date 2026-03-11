# Plan: Fix Dispatch Review Starvation

## Problem

The dispatch engine alternates worker → reviewer → worker even when multiple `pending_review` tasks exist. This causes PRs to stack up instead of being cleared promptly.

**Root cause:** After an invocation completes, the `.then()` callback calls `_drainQueues()` which only processes items already in the per-agent queues. It does NOT re-evaluate tasks on disk. Tasks that reached `pending_review` from earlier invocations only re-enter the queue via the 60-second reconciliation timer (`_reconcile()`), so the reviewer queue appears empty and a worker task gets the slot.

**Spec gap:** `@dispatch-in-progress-priority ac-4` already requires `pending_review` to be selected before `pending`, but the implementation doesn't satisfy this when the reviewer queue is empty due to the re-evaluation gap.

## Spec Changes

### @agent-dispatch-engine — new AC

**ac-23:** Post-invocation task re-evaluation

```
Given: an agent invocation completes (success or failure after retry exhaustion)
When: the dispatch engine prepares to drain queues for the next invocation
Then: the engine re-evaluates all current task states against dispatch rules
      (identical to reconciliation logic with skipIfActive: true) before
      draining, ensuring tasks that reached a dispatchable state during the
      prior invocation are visible to the drain loop
```

This ensures the drain loop has a complete picture of dispatchable work, not just items that were enqueued via real-time state change events.

### @dispatch-in-progress-priority ac-4 — no change needed

The existing AC is correct as written. The fix is in the dispatch engine implementation (`@agent-dispatch-engine`) not the priority spec. Once post-invocation re-evaluation populates the reviewer queue, the existing status precedence ordering (already implemented in `_compareQueueEntries`) handles the rest.

## Task

### fix-dispatch-review-starvation

**Type:** task
**Priority:** P1 (affects all dispatch runs, causes PR pile-up)
**Spec ref:** @agent-dispatch-engine
**Tags:** dispatch, bug

**Description:** Add post-invocation task re-evaluation to the dispatch engine so pending_review tasks are visible to the drain loop immediately after any invocation completes, not only after the 60-second reconciliation timer.

**Implementation:**

In `src/agent-runtime/dispatch.ts`, modify the `.then()` callback in `_spawnInvocation()` (around line 1144):

```typescript
// Current:
.then(async () => {
  if (!this.running) return;
  try {
    const agents = await this._loadAgents();
    await this._drainQueues(agents);
  } catch { /* Best effort */ }
})

// Proposed:
.then(async () => {
  if (!this.running) return;
  try {
    // Re-evaluate all tasks before draining (mini-reconciliation)
    // AC: @agent-dispatch-engine ac-23
    await this._evaluateAllTasks({ skipIfActive: true });
    const agents = await this._loadAgents();
    await this._drainQueues(agents);
  } catch { /* Best effort */ }
})
```

**Verification:**
- Unit test: 2+ tasks in `pending_review`, 1 `task.ready`. After worker completes, verify reviewer is spawned next (not worker).
- Unit test: Verify the re-evaluation doesn't double-enqueue tasks that are already queued.
- Manual: Run dispatch with multiple queued PRs, observe reviews clear before new work starts.

**Risks:**
- `_evaluateAllTasks` calls `initContext()` + `loadAllTasks()` + `loadMetaContext()` — same as reconciliation. This adds one disk read per invocation completion. Acceptable since invocations take minutes.
- `skipIfActive: true` prevents double-enqueue, but verify the dedup key is (agentId, taskId) not just taskId.

## Out of Scope

- Scoped mutex (narrowing mutex to shadow branch writes only) — separate effort, tracked in artifacts/task-isolation-and-review-system.md
- Unified cross-agent queue — larger refactor, not needed if re-evaluation + agent ordering works
- Worktree isolation — separate layer, independent of this fix
