# Dispatch Bootstrap Fails Before the Agent Starts

Bootstrap can fail while dispatch is preparing a worker or reviewer workspace. The agent invocation does not start: dispatch writes a `[DISPATCH-BOOTSTRAP]` task note and blocks the task. Start with that note and the recorded workspace outcome rather than treating preparation as an agent failure or rerunning commands blindly. After correcting the reported cause, run `kspec task unblock @task-ref`; unblock restores the task's prior status so its matching dispatch event can be evaluated again.

## A Bootstrap Step Exits Nonzero

### What this means

A configured project or agent bootstrap step returned a nonzero exit code. Dispatch did not start the role because the workspace was not prepared successfully.

### What to observe

Read the failed step name, exit code, and bounded output tail in dispatcher output and the `[DISPATCH-BOOTSTRAP]` task note. The combined standard-output/error tail is limited to the last 4,000 characters and is not redacted. Confirm the blocked task and dispatch state with `kspec task get @task-ref` and `kspec agent dispatch status --json`.

### Recovery procedure

Fix the command, dependency, credentials, or project input named by that step in its source configuration. Then run `kspec task unblock @task-ref`; the restored task status supplies the matching dispatch event, and dispatch evaluates bootstrap for the same workspace and role. Do not replace the configured step with an ad hoc command in the managed worktree.

### Healthy outcome

The task is no longer blocked, the workspace reports bootstrap as ready, the step exits successfully, and the matching worker or reviewer starts without losing the task branch or recorded failure.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for the preparation boundary and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for bootstrap configuration.

## Bootstrap Reports Tracked-File Changes

### What this means

A bootstrap step changed tracked repository files without declaring that mutation safe. Dispatch stops preparation so dependency setup cannot silently become task work or contaminate a reviewer snapshot.

### What to observe

Use `git status --short` in the reported workspace to identify the tracked changes. Compare them with the failed step and confirm the workspace identity with `kspec task get @task-ref`.

### Recovery procedure

Undo the unintended change through the owning tool or correct the bootstrap step so it is read-only. If tracked mutation is an intentional, reviewed part of preparation, configure that individual step with the supported opt-in described in the workspace guide. Then run `kspec task unblock @task-ref` so dispatch can retry preparation from the restored task status.

### Healthy outcome

The task is no longer blocked, and the bootstrap step completes with a clean tracked-file status or an explicitly permitted intentional mutation.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for isolation and evidence ownership and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for the tracked-mutation policy.

## A Reviewer Bootstrap Rerun Is Refused

### What this means

A reviewer snapshot could not safely reuse the worker's prepared state, but one of the required steps is not allowed to rerun for reviewers. Dispatch refuses rather than executing a potentially destructive or role-inappropriate step in the detached snapshot.

### What to observe

Read the named step and reviewer-rerun refusal in dispatcher output and the `[DISPATCH-BOOTSTRAP]` task note. Use `kspec task get @task-ref` to confirm that dispatch blocked the task while preserving its worker submission and prior `pending_review` status for recovery.

### Recovery procedure

Make the step safely repeatable for a detached reviewer and enable reviewer rerun for that step, or restrict it to the worker role when reviewers do not need its output. Then run `kspec task unblock @task-ref`; unblock restores `pending_review`, allowing the reviewer event to be evaluated again without a new submission.

### Healthy outcome

The task is restored to `pending_review`; the reviewer either reuses valid worker preparation or runs only the explicitly safe reviewer steps, then opens the submitted snapshot without changing the worker workspace.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for detached reviewer lifecycle and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for role and rerun controls.

## Previously Successful Bootstrap State Is Invalidated

### What this means

Dispatch reruns cached preparation for exactly three recorded signals: `prior-bootstrap-failed`, `bootstrap-config-changed`, or `canonical-branch-head-changed`.

### What to observe

Read those invalidation reasons in the workspace outcome and allow the automatic rerun to finish. If the automatic rerun succeeds, the workspace records a new successful result and the task is not blocked merely because its cache was invalidated. Only when the rerun itself fails will `kspec task get @task-ref` show a blocked task and a `[DISPATCH-BOOTSTRAP]` note; use `kspec agent status` for the current dispatch projection.

### Recovery procedure

Allow dispatch to rerun preparation automatically. Correct a previously failed step or unintended bootstrap configuration if that rerun reports an error. If the canonical branch advanced intentionally, keep that branch state and let preparation run against its new head. Only when the rerun failed and the task is actually blocked should you run `kspec task unblock @task-ref` after correcting the failure; unblock restores the prior task status for another matching attempt. Do not mark cached state valid manually.

### Healthy outcome

Bootstrap runs against the recorded configuration and canonical branch head, records a new successful result, and the role starts without reusing stale preparation. A successful automatic rerun leaves the task unblocked; after a failed rerun, the corrected and explicitly unblocked task returns to its prior status and reaches the same result.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for source-bound state and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for target precedence.

## The Prepared Workspace Cannot Be Accessed

### What this means

Dispatch has a workspace record, but the recorded directory is missing, unreadable, or no longer a usable managed worktree. The agent is not started against a replacement directory because that would detach the run from its durable evidence.

### What to observe

Use `kspec task get @task-ref` and `kspec agent dispatch status --json` to preserve the task and dispatcher view. Inspect the reported directory with ordinary read-only filesystem checks and `git status --short`; do not create a directory at that path as a substitute.

### Recovery procedure

Restore host access or permissions when the same managed worktree still exists. Otherwise leave the record and branch intact so normal startup reconciliation can classify and recover or reprovision the workspace. When the workspace is accessible again, run `kspec task unblock @task-ref`; escalate instead when reconciliation continues to report the record as stale or invalid.

### Healthy outcome

The task is no longer blocked, and dispatch can open the recorded workspace or safely reprovision the canonical task workspace while preserving branch and task history.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for registry authority and workspace continuity.

## A Bootstrap Failure Exposes Unsafe Command Output

### What this means

Bootstrap records a bounded tail of combined standard output and error so the end of a failure remains diagnosable. The last 4,000 characters are not redacted and can therefore expose anything the command prints, including a credential or private host value.

### What to observe

Read the failed step and bounded output in dispatcher output and the `[DISPATCH-BOOTSTRAP]` task note without copying it into another report. Check `kspec task get @task-ref` for the blocked task. Treat any secret printed by the step as exposed.

### Recovery procedure

Rotate any printed credential, remove secret-bearing output from the step, and replace it with safe diagnostics. Then run `kspec task unblock @task-ref` to restore the prior task status and retry the matching dispatch event. Restrict access to the workspace and session evidence according to the project's incident procedure.

### Healthy outcome

The task is no longer blocked, the corrected step exits successfully, dispatch reports ready state, and any later failure tail contains useful diagnostics without credentials or private values.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for the evidence model and [Agents and Dispatch](../concepts/agents-and-dispatch.md) for invocation output.
