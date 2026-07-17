# Dispatch Workspaces

## What a Dispatch Workspace Is

A dispatch workspace is the managed, task-scoped place where an automated agent performs work. It combines a git worktree, the task branch checked out there, and durable dispatch records that let kspec relate the directory to the project, task, role, and integration outcome.

The workspace is evidence as well as a place to edit. Its branch, task notes, invocation history, and recorded integration state explain what an agent worked on and what remains to happen.

## Why Isolation Exists

Automated workers must not share an index or working tree with the project checkout, another worker, or a reviewer. Separate workspaces prevent one invocation's edits and git operations from changing another invocation's view of the repository. They also give cleanup and recovery a bounded set of dispatcher-owned paths to reason about.

Isolation does not make the work independent of the project. Every workspace is still bound to one source project and one intended integration target.

## Target and Task Identity

The canonical task identity ties repeated invocations, aliases, and review cycles to the same unit of work. The integration target says where approved work is intended to accumulate. A plan can provide that target for a stack of related tasks; otherwise project dispatch configuration supplies it.

The target is part of workspace meaning, not merely a branch chosen at merge time. If the authoritative target changes or cannot be synchronized safely, dispatch reports that state rather than silently publishing somewhere else.

## Worker Continuity

The canonical worker workspace persists while a task is in progress and when review sends it back for changes. A later worker invocation resumes the same task branch and workspace so it can inherit the implementation, tests, notes, and review context instead of reconstructing them from conversation history.

Only one active invocation owns a canonical task at a time. Continuity means reuse across invocations, not concurrent editing of the same workspace.

## Detached Reviewer Lifecycle

A reviewer receives a separate snapshot of the submitted branch. That snapshot is intentionally isolated from the worker's mutable workspace and from the integration checkout. The reviewer can inspect the exact submitted state, run checks, and record a disposition without taking ownership of the worker's directory.

Reviewer snapshots are short-lived. When review finishes and no retention or debugging hold applies, they become cleanup-eligible. The worker workspace follows the longer task lifecycle instead.

## The Fix Cycle

When review requests changes, the task returns to the worker. The worker resumes the canonical workspace, reads the review record, updates the branch, and submits a new version. The next review uses a new reviewer snapshot and a new per-cycle review record.

This division preserves both kinds of continuity: the worker keeps its implementation context, while each review remains a point-in-time assessment of one submitted version. See [Reviews](./reviews.md) for the review-record model.

## Bootstrap State

Before an agent begins its role, dispatch prepares the source-bound workspace and runs the configured project and agent bootstrap steps. Successful state may be reused only while the inputs that made it valid still match. A changed target, configuration, or tracked workspace state can require preparation to run again.

Bootstrap belongs to dispatch workspaces, not to arbitrary one-shot agent runs. A bootstrap failure leaves an observable workspace outcome for inspection rather than pretending the task ran.

## Integration and Publication

The worker commits to the task branch. After review approval, the configured publication mode determines how that branch reaches its integration target: a supported local merge path, an external review path, or an explicitly configured automatic path. Publication records are part of workspace state so cleanup can distinguish integrated work from work that is still unresolved.

The task branch and integration target remain distinct even when both live in the same repository. Dispatch never treats a completed invocation by itself as proof that the work was reviewed or integrated.

## Lifecycle Authority Versus Task Readiness

Task readiness answers whether the task's semantic state and dependencies make it a candidate for work. Lifecycle authority answers whether dispatch may admit that candidate now. Pausing or stopping dispatch does not rewrite the task's readiness, and resuming dispatch re-evaluates current authoritative task state rather than restoring a private queue as truth.

Workspace state is separate again: a workspace can persist while admission is paused, and stopped authority can coexist with cleanup that is still pending. Degraded target state is also independent; a lifecycle action does not clear a synchronization or target-safety problem. The [lifecycle controls guide](../guides/controlling-dispatch-lifecycle.md) owns transition procedures.

## Evidence and Cleanup Ownership

Lifecycle control governs admission and cancellation. It does not delete a workspace or make its evidence disposable. Sessions, branches, worktrees, snapshots, task history, and audit records remain subject to their existing retention and cleanup policy.

Cleanup evaluates durable ownership and integration state. Active, in-flight, paused-held, and stopped-with-pending-cleanup work stays protected. When ownership or safety cannot be established, cleanup preserves or blocks the artifact with recovery information instead of blindly deleting it. A terminal task or resolved integration outcome can move the workspace toward closing and scheduled cleanup.

## Operator Ownership

Operators configure where dispatch workspaces live, which integration targets and publication paths apply, and which agents may be invoked. They inspect task, agent, and dispatch status when preparation, synchronization, review, or cleanup needs attention.

The dispatcher owns its registry, managed worktrees, reviewer snapshots, and task branches. Operators should use supported status, configuration, retry, and recovery paths rather than editing registry or lifecycle state, deleting managed directories, or running manual worktree surgery.

## Current Limitations

Dispatch workspaces are local managed git worktrees, not distributed build sandboxes or resumable machine checkpoints. Remote synchronization is bounded by the configured repository and safety checks; it does not promise that every remote topology can be repaired automatically. One-shot agent runs remain outside dispatch workspace and lifecycle ownership unless dispatch created them.

There is no general workspace list, show, reset, or cleanup command. Lifecycle controls do not substitute for those operations, and cleanup may remain pending when process or workspace ownership cannot be verified safely.

## Related Operations

- [Agents and Dispatch](./agents-and-dispatch.md) introduces agent definitions and automatic assignment.
- [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) explains targets, roots, bootstrap, publication, and synchronization.
- [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) explains admission, pause, resume, hard stop, and status.
- [Troubleshooting](../troubleshooting/index.md) collects supported recovery paths when assignment, preparation, synchronization, or cleanup fails.
