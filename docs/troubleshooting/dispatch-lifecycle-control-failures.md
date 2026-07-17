# Dispatch Lifecycle Status Rejects an Action or Shows Cleanup

Lifecycle failures are recovered from current status, not from private state edits. Read the global authority, canonical task control, and matching cleanup entry before choosing start, resume, pause, or hard-stop retry.

## Start, Resume, or Pause Reports an Invalid Transition

### What this means

The requested action is not valid from the current authority or task mode. The `invalid_transition` failure includes current status and does not substitute another action.

### What to observe

Run `kspec agent status` and `kspec agent dispatch status --json`. Compare global authority, projection, and matching cleanup with the action matrix in the lifecycle guide.

### Recovery procedure

Use `kspec agent dispatch start` only from cleanup-idle stopped authority, `kspec agent dispatch resume` only from paused authority, and pause only where status offers it. For task controls, use the action valid for that canonical task row.

### Healthy outcome

The requested valid transition succeeds or reports a no-op, and status shows the intended authority without changing task readiness.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for authority versus readiness and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for the action matrices.

## A Held Task Does Not Start

### What this means

The task may be semantically ready while global or task lifecycle authority still holds admission. A task resume also cannot bypass paused or stopped global authority.

### What to observe

Run `kspec task get @task-ref`, `kspec tasks ready --eligible`, and `kspec agent dispatch status --json`. Match the canonical task in `heldTasks` and `taskControls`, then check global authority.

### Recovery procedure

If the task row is paused or stopped with idle cleanup, use `kspec agent dispatch task resume @task-ref`. If global authority is paused, use `kspec agent dispatch resume`; if it is cleanup-idle stopped, use `kspec agent dispatch start`. Resolve ordinary readiness or dependency failures separately.

### Healthy outcome

Current authoritative state is re-evaluated, the held row clears when no other gate remains, and at most one invocation starts for the canonical task.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for held admission and [Agents and Dispatch](../concepts/agents-and-dispatch.md) for assignment.

## A Task Alias Is Missing, Ambiguous, or Mismatched

### What this means

Task-scoped control could not resolve one canonical identity. Closed outcomes include `task_not_found`, `task_identity_ambiguous`, and `task_identity_mismatch`; the request has no effect.

### What to observe

Use `kspec task get @task-ref` and `kspec search "task title"` to find a full ULID or unique alias. Compare any supplied task id and ref before retrying.

### Recovery procedure

Retry the same task action with one unambiguous slug, full ULID, or unique ULID prefix. Do not add or rewrite a task-control record manually.

### Healthy outcome

Status stores one task-control row under the canonical ULID, displays the friendly ref, and leaves unrelated tasks unchanged.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for canonical task identity and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for accepted aliases.

## Dispatch Is Stopped With Pending or Failed Cleanup

### What this means

A hard stop committed no-start authority but cancellation or session closure did not finish. The contract is: `hard-stop failure remains stopped with retryable pending or failed matching cleanup`; it never reports false success.

### What to observe

Run `kspec agent dispatch status --json` and identify the cleanup entry's `global` or canonical-task scope, phase, status, and closed error code.

### Recovery procedure

Correct the reported host condition, then retry only the matching scope. Use `kspec agent dispatch stop --force` for global cleanup or `kspec agent dispatch task stop @task-ref --force` for that task. Aggregate cleanup is observability only and unrelated entries do not choose the retry.

### Healthy outcome

Matching cleanup becomes idle. Successful cleanup leaves stopped authority in place until an explicit `kspec agent dispatch start` or applicable `kspec agent dispatch task resume @task-ref` permits work again.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for evidence preservation and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for scoped cleanup.

## The Control Store Is Unavailable, Corrupt, or Cannot Commit

### What this means

Durable lifecycle authority could not be read or committed. The closed codes are `control_store_unavailable`, `control_store_corrupt`, and `control_commit_failed`; failed writes do not publish a new authority.

### What to observe

Record the closed code and current status from the failed control response. Run `kspec agent status` from the project root and check shadow health with `kspec shadow status` when the message identifies shadow-state availability.

### Recovery procedure

Restore project or shadow-branch access using the supported shadow recovery guidance, then repeat the same valid lifecycle command. Do not edit `.kspec/dispatch-control.yaml` or synthesize a commit.

### Healthy outcome

The durable write commits, status publishes the new authority once, and restart observes the same authority before scheduling.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for durable authority and [The Shadow Branch](../concepts/the-shadow-branch.md) for supported shadow recovery.

## Cleanup Cannot Verify Ownership or Process Identity

### What this means

Dispatch cannot prove session ownership, process birth, or live process-group membership. `cleanup_identity_unverifiable` and related ownership, birth, leader, or group codes keep cleanup pending or failed and prevent signalling an uncertain process.

### What to observe

Use `kspec agent dispatch status --json` to record scope, cleanup phase, and error code. Preserve the session, process, branch, workspace, worktree, snapshot, and audit evidence named by the stop result.

### Recovery procedure

Retry the same global or task hard stop only after the host can provide equivalent ownership and process-identity evidence. If verification remains unavailable, escalate with the closed code and status; never edit session ownership, process ids, or process groups.

### Healthy outcome

Verified matching work is cancelled and cleanup becomes idle, or uncertain work remains unsignalled with explicit pending evidence instead of a false success.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for protected evidence and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for recovery limitations.

## Hard Stop Is Rejected From a Dispatch-Owned Session

### What this means

The caller belongs to the dispatch engine it is trying to stop. Host-stop rejection prevents an agent from cancelling its own runtime and stranding orchestration state.

### What to observe

The command reports that a dispatch-owned session cannot hard-stop its host. Confirm current authority with `kspec agent status`; no stop request was applied.

### Recovery procedure

Open an independent operator shell outside the dispatch-owned invocation, inspect status, then run the same global or task stop there with the required confirmation or `--force`.

### Healthy outcome

The independent operator request controls only matching dispatch-owned work, and the original rejected request caused no authority change.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for ownership boundaries and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for hard-stop safety.

## Hard Stop Requires Confirmation or --force

### What this means

Hard stop cancels active matching work. Interactive use requires confirmation; noninteractive and JSON use require `--force`. Cancelling the prompt sends no request.

### What to observe

Read the warning about active cancellation and preserved evidence. If the command says hard stop requires `--force`, verify the intended scope with `kspec agent dispatch status --json` before retrying.

### Recovery procedure

Confirm the interactive prompt when cancellation is intended. In a reviewed noninteractive procedure, use `kspec agent dispatch stop --force` or `kspec agent dispatch task stop @task-ref --force` for the exact scope.

### Healthy outcome

Declining leaves status unchanged. Confirming commits stopped authority, attempts matching cleanup, and preserves evidence whether cleanup succeeds or remains pending.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for evidence ownership and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for confirmation semantics.

## Lifecycle Controls Are Read-Only in the Static UI

### What this means

The static documentation/web export has no writable daemon connection. The agents view intentionally projects stopped, empty lifecycle status and does not send mutation requests.

### What to observe

The `/agents` view labels itself read-only and offers no working lifecycle mutation. Use `kspec agent status` in a writable project checkout to observe the live daemon instead.

### Recovery procedure

Open the daemon-backed web UI for the intended project or use the matching CLI command from that project root. Do not treat the static projection as live authority.

### Healthy outcome

The writable surface shows current authority and valid actions, while the static surface remains safely readable and sends no control requests.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for the live authority boundary and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for CLI and UI surfaces.
