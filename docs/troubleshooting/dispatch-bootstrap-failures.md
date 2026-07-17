# Dispatch Bootstrap Fails Before the Agent Starts

Bootstrap can fail while dispatch is preparing a worker or reviewer workspace. Start with the message in the agent output and the recorded workspace outcome; do not treat a failed preparation as an agent failure or rerun commands blindly.

## A Bootstrap Step Exits Nonzero

### What this means

A configured project or agent bootstrap step returned a nonzero exit code. Dispatch did not start the role because the workspace was not prepared successfully.

### What to observe

Read the failed step name, exit code, and sanitized output in the invocation result. Confirm the task and dispatch state with `kspec task get @task-ref` and `kspec agent dispatch status --json`.

### Recovery procedure

Fix the command, dependency, credentials, or project input named by that step in its source configuration. Run the same supported dispatch event again after the correction; dispatch will evaluate bootstrap for the matching workspace and role. Do not replace the configured step with an ad hoc command in the managed worktree.

### Healthy outcome

The workspace reports bootstrap as ready, the step exits successfully, and the matching worker or reviewer starts without losing the task branch or recorded failure.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for the preparation boundary and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for bootstrap configuration.

## Bootstrap Reports Tracked-File Changes

### What this means

A bootstrap step changed tracked repository files without declaring that mutation safe. Dispatch stops preparation so dependency setup cannot silently become task work or contaminate a reviewer snapshot.

### What to observe

Use `git status --short` in the reported workspace to identify the tracked changes. Compare them with the failed step and confirm the workspace identity with `kspec task get @task-ref`.

### Recovery procedure

Undo the unintended change through the owning tool or correct the bootstrap step so it is read-only. If tracked mutation is an intentional, reviewed part of preparation, configure that individual step with the supported opt-in described in the workspace guide, then let dispatch retry preparation.

### Healthy outcome

The bootstrap step completes with a clean tracked-file status, or its intentional mutation is explicitly permitted and produces the expected prepared state.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for isolation and evidence ownership and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for the tracked-mutation policy.

## A Reviewer Bootstrap Rerun Is Refused

### What this means

A reviewer snapshot could not safely reuse the worker's prepared state, but one of the required steps is not allowed to rerun for reviewers. Dispatch refuses rather than executing a potentially destructive or role-inappropriate step in the detached snapshot.

### What to observe

Read the named step and reviewer-rerun refusal in the review invocation output. Use `kspec task get @task-ref` to confirm that the task is still pending review and that the worker submission remains intact.

### Recovery procedure

Make the step safely repeatable for a detached reviewer and enable reviewer rerun for that step, or restrict it to the worker role when reviewers do not need its output. Resubmit or retry the review through the normal task lifecycle after correcting configuration.

### Healthy outcome

The reviewer either reuses valid worker preparation or runs only the explicitly safe reviewer steps, then opens the submitted snapshot without changing the worker workspace.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for detached reviewer lifecycle and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for role and rerun controls.

## Previously Successful Bootstrap State Is Invalidated

### What this means

Dispatch found that the inputs behind cached preparation no longer match. A target change, bootstrap configuration change, role change, or tracked workspace change can invalidate an earlier successful result.

### What to observe

Read the invalidation reasons in the workspace outcome, then inspect the current task with `kspec task get @task-ref` and the current dispatch projection with `kspec agent status`.

### Recovery procedure

Confirm that the new target and bootstrap configuration are intended. Correct the authoritative configuration if they are not; otherwise allow the next matching dispatch attempt to rerun the required preparation. Do not mark cached state valid manually.

### Healthy outcome

Bootstrap runs against the current inputs, records a new ready result, and the role starts from the intended target without reusing stale preparation.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for source-bound state and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for target precedence.

## The Prepared Workspace Cannot Be Accessed

### What this means

Dispatch has a workspace record, but the recorded directory is missing, unreadable, or no longer a usable managed worktree. The agent is not started against a replacement directory because that would detach the run from its durable evidence.

### What to observe

Use `kspec task get @task-ref` and `kspec agent dispatch status --json` to preserve the task and dispatcher view. Inspect the reported directory with ordinary read-only filesystem checks and `git status --short`; do not create a directory at that path as a substitute.

### Recovery procedure

Restore host access or permissions when the same managed worktree still exists. Otherwise leave the record and branch intact so normal startup reconciliation can classify and recover or reprovision the workspace. Escalate when reconciliation continues to report the record as stale or invalid.

### Healthy outcome

Dispatch can open the recorded workspace, or reconciliation safely provisions the canonical task workspace while preserving branch and task history.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for registry authority and workspace continuity.

## A Bootstrap Failure Exposes Unsafe Command Output

### What this means

Bootstrap records a bounded tail of combined standard output and error so the end of a failure remains diagnosable. The last 4,000 characters can therefore expose anything the command prints, including a credential or private host value.

### What to observe

Read the failed step and bounded output without copying it into another report. Check `kspec task get @task-ref` for task state and `kspec agent dispatch watch` for the invocation boundary. Treat any secret printed by the step as exposed.

### Recovery procedure

Rotate any printed credential, remove secret-bearing output from the step, and replace it with safe diagnostics. Then retry the matching dispatch event. Restrict access to the workspace and session evidence according to the project's incident procedure.

### Healthy outcome

The corrected step exits successfully, dispatch reports ready state, and the captured failure tail contains useful diagnostics without credentials or private values.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for the evidence model and [Agents and Dispatch](../concepts/agents-and-dispatch.md) for invocation output.
