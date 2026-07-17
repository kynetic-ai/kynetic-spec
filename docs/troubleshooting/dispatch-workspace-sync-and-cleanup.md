# A Dispatch Workspace Cannot Sync or Clean Up

Workspace status can show a target, synchronization, registry, or cleanup problem while the task and its evidence remain intact. Identify the exact workspace symptom before changing configuration or retrying normal reconciliation.

## The Workspace Target Does Not Match Configuration

### What this means

The workspace was provisioned for a different integration target than the one you expected. A plan target takes precedence over project `dispatch.base_branch`, and an existing workspace retains its resolved target.

### What to observe

Use `kspec task get @task-ref`, `kspec plan get @plan-ref`, and `kspec agent dispatch status --json` to compare task, plan, and degraded-target evidence with the configured base branch.

### Recovery procedure

Correct the authoritative plan target or project dispatch configuration for future provisioning. Do not retarget the existing managed worktree or branch by hand; complete or close it through its recorded integration path, then let dispatch provision subsequent work from the corrected target.

### Healthy outcome

New workspace records name the intended integration target, while existing work retains a coherent, auditable publication path.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for target identity and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for precedence.

## A Plan Target Changed After the Workspace Was Created

### What this means

The plan now points somewhere else, but an already provisioned workspace remains bound to the target recorded at creation. Dispatch does not silently rebase or rewrite that workspace.

### What to observe

Compare `kspec plan get @plan-ref` with `kspec task get @task-ref` and the task's dispatch context. Check `git status --short` before deciding how the existing branch should finish.

### Recovery procedure

Keep the current workspace on its recorded target and use its supported review/publication path. Apply the corrected plan target to workspaces created afterward. If the old target is no longer valid, escalate for an explicit integration decision instead of moving refs inside the managed workspace.

### Healthy outcome

No existing branch is rewritten implicitly, and later plan tasks resolve to the new target at provisioning time.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for source-bound targets and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for plan-scoped dispatch.

## The Workspace Path Collides With Existing Content

### What this means

The configured worktree root or derived task path is already occupied by content dispatch cannot prove it owns. Provisioning stops to avoid overwriting an operator checkout or unrelated files.

### What to observe

Inspect the reported path with read-only filesystem checks and `git status --short` when it is a repository. Use `kspec task get @task-ref` to confirm the canonical task that requested the path.

### Recovery procedure

Choose a non-colliding `dispatch.worktree_root` for future work, or move the unrelated content through its owner's normal process. If the entry may be dispatch evidence, leave it in place and allow registry reconciliation to identify it.

### Healthy outcome

Dispatch provisions the canonical workspace under an empty dispatcher-owned path and unrelated content is unchanged.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for isolation and operator ownership and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for root resolution.

## The Workspace Registry Is Stale or Cannot Be Recovered

### What this means

The durable registry record disagrees with the worktree, branch, or metadata on disk, or the registry cannot be parsed safely. Dispatch preserves ambiguous artifacts instead of rebuilding authority from guesses.

### What to observe

Read the registry health issue exposed by dispatch and use `kspec agent status` plus `kspec task get @task-ref` to identify affected tasks. Inspect branches and paths only with read-only Git and filesystem commands.

### Recovery procedure

Restart or retry normal dispatch reconciliation after restoring access to the source repository. If the same stale or invalid classification remains, escalate with the task ref, branch, path, and sanitized health issue. Do not edit the dispatch workspace registry.

### Healthy outcome

Reconciliation restores a healthy record or leaves a specific protected/blocked state with actionable evidence; it never discards an ambiguous workspace silently.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for registry authority and cleanup ownership.

## Dispatch Is Running in Local-Only Mode

### What this means

The repository has no configured Git remote. This is supported: remote synchronization is `local-only with no degraded state or warnings`, while local dispatch and manual local integration continue.

### What to observe

Use `git remote` to confirm there is no remote and `kspec agent dispatch status --json` to confirm no degraded target was created solely for that condition.

### Recovery procedure

Do nothing when local-only operation is intended. If remote durability is required, configure and verify the repository remote through normal Git administration, then allow the next dispatch startup or sync interval to discover it.

### Healthy outcome

Local-only dispatch remains healthy without sync warnings, or configured remote synchronization begins without changing workspace identity.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for current remote limits and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for `remote_sync`.

## Remote Synchronization Fails Transiently

### What this means

A network, DNS, authentication transport, or temporary remote failure prevented one sync attempt. Transient failures are warnings and retries; they do not by themselves put the target into degraded divergence state.

### What to observe

Read the target-specific warning and failure count, verify connectivity with ordinary read-only Git remote checks, and inspect `kspec agent dispatch status --json` for actual `degradedTargets`.

### Recovery procedure

Restore connectivity or credentials and wait for the next configured sync interval. Keep dispatch running; repeated transient failures are escalated in logs but remain retryable without manual registry changes.

### Healthy outcome

A later sync succeeds, the target freshness timestamp advances, and healthy targets continue independently throughout.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for synchronization boundaries and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for sync timing.

## An Integration Target Is Degraded by Divergence

### What this means

The local and remote histories cannot be advanced by fast-forward. Dispatch stops provisioning only for that target and reports whether local merges are unpushed or remote history was rewritten.

### What to observe

Run `kspec agent dispatch status --json` and record the degraded target's branch, reason, timestamp, and kind. Use `git status --short` and normal read-only Git history inspection in the checkout that owns the target.

### Recovery procedure

Reconcile local and remote history through the repository's normal reviewed Git workflow. Do not force-push from a managed task or reviewer workspace. After the branch has one safe history, let the next target-specific sync reevaluate it.

### Healthy outcome

The sync succeeds or is a no-op, that target leaves `degradedTargets`, and queued tasks for it become eligible while other targets were never blocked.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for target safety and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for fast-forward-only sync.

## The Integration Target Is Checked Out Elsewhere

### What this means

Dispatch found an occupied checkout. One clean, non-auxiliary checkout can be a safe mutation surface; dirty, staged, ambiguous, auxiliary, in-progress, or overwrite-hazard checkouts are refused.

### What to observe

Use `git worktree list` and `git status --short` in the named checkout. Confirm `occupied-checkout` in `kspec agent dispatch status --json` rather than assuming divergence.

### Recovery procedure

Finish or abort the checkout's own Git operation and make its tracked state clean through the owner's normal workflow. Move any conflicting untracked content safely. Then wait for or trigger the same normal sync path; do not delete the checkout to silence the status.

### Healthy outcome

Dispatch uses the single clean eligible checkout, or another safe branch-coherent surface, and clears the target degradation after sync succeeds.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for operator ownership and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for target synchronization.

## Reviewer Target Synchronization Is Deferred

### What this means

The periodic sync reached a target while a reviewer invocation for that target was active. Only that target is deferred to the next interval so the reviewer keeps a stable comparison surface.

### What to observe

Use `kspec agent status` to confirm the active reviewer and `kspec agent dispatch status --json` to confirm that unrelated targets remain healthy.

### Recovery procedure

Allow the reviewer invocation to finish. Do not cancel review or mutate its target merely to force a periodic refresh; the next interval retries that target automatically.

### Healthy outcome

The reviewer completes against its stable snapshot, the next sync evaluates the target, and other active targets continued syncing.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for detached review and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for reviewer deferral.

## Cleanup Says an Artifact Is Protected

### What this means

The branch, worktree, snapshot, or registry record belongs to active, queued-to-start, paused-held, in-flight, or stopped-with-pending-cleanup work. Protection is evidence preservation, not a request for manual deletion.

### What to observe

Use `kspec agent status`, `kspec agent dispatch status --json`, and `kspec task get @task-ref` to match the protection reason to lifecycle and task state.

### Recovery procedure

Let the owning invocation, review, lifecycle cleanup, or task integration reach its normal durable outcome. Retry only the matching lifecycle cleanup when status offers it. Do not delete or move a managed worktree.

### Healthy outcome

The artifact remains while protected, then normal reconciliation schedules cleanup only after ownership and integration state prove it safe.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for evidence and cleanup ownership and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for matching cleanup scope.

## The Worktree Root Contains an Unknown Entry

### What this means

Dispatch found a directory without enough metadata to prove it is a managed workspace. Unknown entries are preserved when any branch, path, task, or lifecycle protection source could own them.

### What to observe

Compare `git worktree list`, `kspec task get @task-ref`, and the preservation diagnostic. Do not infer ownership from a directory name alone.

### Recovery procedure

Allow reconciliation to match the entry with registry and Git evidence. If it stays unknown, escalate with the exact diagnostic and read-only inventory; the owner can then move unrelated content through a controlled, recoverable process.

### Healthy outcome

The entry is either recognized and managed, preserved with a concrete protection reason, or confirmed unrelated without destroying dispatch evidence.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for canonical identity and ambiguous-artifact protection.

## A Closed Workspace Is Still Retained

### What this means

Closed registry records are retained for a bounded period, and cleanup can remain blocked by branch, review, lifecycle, or evidence conditions. A terminal task alone is not proof that every artifact is disposable.

### What to observe

Use `kspec task get @task-ref` to confirm terminal state and `kspec agent status` to check active or pending ownership. Read the cleanup status and retention timestamp rather than inspecting directory age alone.

### Recovery procedure

Wait for normal retention and reconciliation when all cleanup conditions are satisfied. Resolve the named review, integration, or lifecycle condition through its owning workflow. Do not edit the dispatch workspace registry or remove the directory manually.

### Healthy outcome

Recent closed evidence remains available, then eligible records and artifacts are purged by dispatcher-owned cleanup without affecting active work.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for retention and integration evidence.
