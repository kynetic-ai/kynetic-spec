# Controlling the Dispatch Lifecycle

## Goal

Pause new dispatch work, resume held work, or hard-stop dispatch-owned work at either global or single-task scope. By the end, you will be able to choose the smallest correct scope, read the authoritative status, apply a valid action, and verify recovery without changing task readiness or deleting workspace evidence.

## Prerequisites

- A kspec project with setup completed and dispatch agents configured
- Access to the project daemon and permission to operate dispatch
- The canonical task reference or an unambiguous alias when controlling one task
- A recovery plan for work that a hard stop will cancel

Read [Configuring Dispatch Workspaces](./configuring-dispatch-workspaces.md) first if the integration target, managed worktree root, publication mode, or bootstrap policy is not yet configured. Every lifecycle command has its own generated option list: append `--help` to that exact command. For example, use `kspec agent dispatch stop --help`, `kspec agent dispatch task stop --help`, or `kspec agent status --help`.

## Steps

### 1. Choose global or task scope

Use global scope to hold or stop every dispatch candidate in the project. Use task scope when one canonical task needs intervention and unrelated dispatch work should continue.

Task commands accept a slug, full ULID, or unique ULID prefix, then resolve it to the canonical task ULID before storing control state. Missing, ambiguous, unresolved, or disagreeing task identities fail without changing authority. Status and events may retain a friendly task reference for display, but the durable key is the canonical task identity.

A task-level resume removes that task's hold; it does not bypass global authority. If global dispatch remains paused or stopped, the task remains held from admission.

### 2. Read authority, projection, and work counts

Inspect status before every action:

```bash
kspec agent status
kspec agent dispatch status --json
```

Plain `kspec agent status` provides a human-readable summary with Authority, Projection, Active, Queued, Held, and aggregate Cleanup lines. Use `kspec agent dispatch status --json` when you need the detailed CLI status contract: CLI JSON uses camelCase names such as `globalAuthority`, `activeCount`, `queuedInvocations`, `heldCount`, `heldTasks`, `taskControls`, `cleanupState`, and `degradedTargets`. A missing optional `degradedTargets` array means no target degradation was reported.

Public API consumers instead read `GET /api/agent/status`. The public API uses snake_case wire fields:

| Field              | What it tells you                                                                   |
| ------------------ | ----------------------------------------------------------------------------------- |
| `global_authority` | Durable global authority: `stopped`, `running`, or `paused`                         |
| `projection`       | Current operational projection: `stopped`, `running`, `paused`, or `draining`       |
| `active_count`     | Dispatch-owned invocations already active                                           |
| `queue_depth`      | Candidates currently queued                                                         |
| `held_count`       | Eligible candidates held by global or task authority                                |
| `held_tasks`       | Canonical held-task identity, scope, mode, reason, actor, source, and timestamps    |
| `task_controls`    | Canonical per-task `paused` or `stopped` records and matching cleanup state         |
| `cleanup_state`    | Aggregate `idle`, `pending`, or `failed` cleanup evidence, including scoped entries |
| `degraded_targets` | Remote target synchronization problems; separate from lifecycle authority           |

`draining` is not another durable authority. It means authority is `paused` while active work is still completing. Pausing admits no new matching work but allows active dispatch invocations and sessions to finish naturally.

Cleanup entries identify their `global` or `task` scope, cleanup identifier, phase, status, closed error code, and canonical task identity when task-scoped. Global actions inspect global cleanup. Task actions inspect only cleanup for that canonical task. Aggregate cleanup is observability, not a blanket gate across unrelated scopes.

### 3. Select a valid action

#### Global actions

| Current authority and cleanup                   | Actions          | Result                                                                                |
| ----------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `stopped` with global cleanup idle              | `start`          | Starts admission and reconciles currently eligible work                               |
| `running`                                       | `pause`, `stop`  | Holds new starts gracefully, or commits hard-stop authority and cancels matching work |
| `paused`                                        | `resume`, `stop` | Releases held work, or hard-stops matching work                                       |
| `stopped` with global cleanup pending or failed | `stop`           | Retries the matching global hard-stop cleanup                                         |

`start` and `resume` are not synonyms. Use `start` only to leave cleanup-idle `stopped` authority. Use `resume` only to leave `paused` authority. Repeating an already-satisfied valid action, such as pausing while paused or resuming while running, is a no-op. An action outside the transition matrix is an invalid transition and fails rather than substituting a different action.

#### Task actions

| Current task control                              | Actions          | Result                                                                |
| ------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| No task control                                   | `pause`, `stop`  | Adds a canonical task hold, or hard-stops only that task's owned work |
| `paused`                                          | `resume`, `stop` | Removes the task hold, or hard-stops only that task's owned work      |
| `stopped` with matching cleanup idle              | `resume`         | Removes the task stop; global authority still controls admission      |
| `stopped` with matching cleanup pending or failed | `stop`           | Retries cleanup for that canonical task only                          |

Pausing an already paused task and resuming a task without a control record are no-ops. Pausing a stopped task, resuming while matching cleanup is not idle, or using an unresolved identity is invalid. A task hard stop preserves unrelated task controls, invocations, sessions, and cleanup entries.

### 4. Choose pause or hard stop

Pause is the graceful admission hold. It commits paused authority, admits no new matching work, and lets active dispatch invocations and sessions finish naturally. Use it for maintenance or investigation when current work may complete safely.

Hard stop commits no-start authority before cancelling matching dispatch-owned processes and closing their sessions. Use it when matching active work must not continue. Interactive confirmation states that active matching invocations will be cancelled while session, branch, workspace, worktree, snapshot, and audit evidence is preserved. Declining confirmation sends no control request and exits without success. Noninteractive and JSON hard stop require `--force`.

A dispatch-owned agent session cannot hard-stop its own host. Global and task hard-stop requests from such a context are rejected; operate the host from an independent operator context.

### 5. Run the CLI procedure

#### CLI commands

| Scope  | Command                                       | Use                                        |
| ------ | --------------------------------------------- | ------------------------------------------ |
| Global | `kspec agent dispatch start`                  | Leave cleanup-idle stopped authority       |
| Global | `kspec agent dispatch pause`                  | Hold new starts and drain active work      |
| Global | `kspec agent dispatch resume`                 | Leave paused authority                     |
| Global | `kspec agent dispatch stop`                   | Hard-stop globally or retry global cleanup |
| Global | `kspec agent dispatch status`                 | Read dispatch-focused status               |
| Global | `kspec agent dispatch watch`                  | Stream active invocation output            |
| Global | `kspec agent status`                          | Read the public agent and lifecycle status |
| Task   | `kspec agent dispatch task pause <task-ref>`  | Hold one canonical task                    |
| Task   | `kspec agent dispatch task resume <task-ref>` | Release one canonical task control         |
| Task   | `kspec agent dispatch task stop <task-ref>`   | Hard-stop or retry cleanup for one task    |

Use this sequence:

1. Run `kspec agent status` for the human-readable summary, then run `kspec agent dispatch status --json` and record `globalAuthority`, `projection`, `activeCount`, `queuedInvocations`, `heldCount`, `heldTasks`, `taskControls`, matching `cleanupState`, and any `degradedTargets`.
2. Choose global or task scope from the tables above.
3. For pause or resume, run the selected command and read its reported authority and projection.
4. For hard stop, review the cancellation and evidence-preservation warning. Confirm interactively, or add `--force` in noninteractive and JSON use.
5. Run both status commands again. Use the summary for a quick state check and the JSON result for held rows, task controls, scoped cleanup entries, and degraded targets.

For any command in the table, append `--help` to that exact command (and omit the `<task-ref>` placeholder) to read its generated Usage and Options output. The guide names the workflow commands but does not duplicate generated flag reference.

### 6. Use the API or agents view when appropriate

The canonical mutation endpoint is `POST /api/agent/dispatch/control`. Send a global action with a body such as `{"scope":"global","action":"pause"}`. For task scope, provide the task reference or canonical identity required by the public request schema. The server canonicalizes aliases and rejects missing, ambiguous, unresolved, or mismatched identity.

Read public lifecycle status from `GET /api/agent/status`. The compatibility `GET /api/agent/dispatch/status` route remains available for dispatch-focused consumers. The public API uses snake_case wire fields such as `global_authority`, `cleanup_state`, `active_count`, `queue_depth`, `held_count`, `held_tasks`, and `task_controls`. The UI adapter maps those fields to camelCase values such as `globalAuthority`, `cleanupState`, `activeCount`, `queueDepth`, `heldCount`, `heldTasks`, and `taskControls`.

The agents view at `/agents` exposes only actions valid for the current global or task state. It labels pause, resume, start, hard stop, and retry hard stop; confirms hard stop; keeps active, queued, held, and cleanup evidence visible; retains focus after updates; and announces lifecycle changes and failures to assistive technology. A degraded target or blocked task is shown separately from lifecycle control.

### 7. Account for the static, read-only UI

In a static export, the agents view reports stopped, empty lifecycle status and is read-only. It does not send mutation requests.

### 8. Retry failed cleanup and recover after restart

Hard-stop failure never restores admission or reports false success. Authority remains `stopped`, and matching cleanup remains `pending` or `failed` with a closed error code and phase. Failures include cancellation timeout, verified signalling failure, session-closure failure, or inability to prove ownership, process birth, or process-group identity.

To retry:

1. Read `cleanupState` in CLI JSON (or `cleanup_state` in the public API) and identify whether the entry is global or belongs to one canonical task.
2. Resolve any operator-correctable host condition without deleting dispatch evidence or manually editing lifecycle state.
3. Run the matching `stop` command again. Global stop retries global cleanup; task stop retries only that task's cleanup.
4. Verify that matching cleanup becomes `idle`. Unrelated cleanup does not block this transition.

Committed control authority and pending cleanup survive daemon restart. Startup loads the durable control state and retries matching pending cleanup before bootstrap scheduling. An interrupted stop can therefore be retried safely after restart, but recovery proceeds only when dispatch can prove durable session ownership and the process birth/group identity. If it cannot, cleanup may remain pending or failed for an operator to investigate.

Do not edit `.kspec/dispatch-control.yaml` by hand, remove session evidence, delete a managed workspace, or invent a Git worktree recovery procedure. Lifecycle control preserves evidence and does not own workspace deletion.

### 9. Subscribe to lifecycle events for automation

Automation may subscribe to these public registered event names:

- `dispatch_control.start_applied`
- `dispatch_control.pause_applied`
- `dispatch_control.resume_applied`
- `dispatch_control.stop_applied`
- `dispatch_control.noop`
- `dispatch_control.failed`

Task-scoped events use canonical task identity. Failure events expose a closed error code, not raw errors or host paths. Treat events as audit and automation signals; read current status before choosing a follow-up transition.

### 10. Respect safety and error semantics

Lifecycle controls do not change semantic task readiness, clear degraded targets, or override task dependencies. They only govern dispatch admission and dispatch-owned active work. A no-op is a successful request whose desired authority already holds; an invalid transition is a failed request whose action is not valid from the current state.

Errors return fixed codes and operator guidance without exposing raw errors or filesystem paths. API transition errors include current lifecycle status so clients can refresh their action choices. Failed control-store commits do not claim that authority changed. Failed cancellation or cleanup retains stopped authority and retry evidence.

Dispatch hard stop targets only sessions and processes whose dispatch ownership and process identity can be verified. It does not signal arbitrary one-shot runs or unrelated host processes.

## Supported limitations

- pause is a graceful admission hold; stop is hard stop
- no checkpointing
- no distributed scheduler
- no exact durable FIFO promise
- no workspace deletion or reset command
- no control of arbitrary one-shot work outside dispatch ownership
- recovery may remain pending when process ownership cannot be proven

In particular, lifecycle control does not checkpoint a prompt, guarantee an exact queue order, control arbitrary `kspec agent run` processes, or guarantee cleanup on a host where equivalent ownership and process-birth evidence is unavailable.

For the dispatch mental model, read [Agents and Dispatch](../concepts/agents-and-dispatch.md). For workspace policy, read [Configuring Dispatch Workspaces](./configuring-dispatch-workspaces.md). For assignment problems, use [Dispatch Refuses to Assign a Task](../troubleshooting/dispatch-refuses-to-assign.md).

## Verification

Verify the selected scope from the CLI status surfaces:

1. Run `kspec agent status` and confirm the human-readable authority, projection, active, queued, held, and aggregate cleanup summary.
2. Run `kspec agent dispatch status --json` for detailed verification.
3. Confirm `globalAuthority` and `projection` match the intended state.
4. Confirm `activeCount`, `queuedInvocations`, and `heldCount` explain current work.
5. For task scope, confirm `heldTasks` and `taskControls` name the canonical task and unrelated task rows are unchanged.
6. Confirm matching `cleanupState` is `idle`, or that any remaining `pending` or `failed` entry has the expected scope, phase, and closed error code.
7. Confirm task readiness and any `degradedTargets` were not changed by the lifecycle action.
8. If using the agents view, confirm the next valid actions are labelled, focus remains usable, and the status update is announced.

The goal is met when the intended global or canonical-task authority is visible, new work is admitted or held as intended, active work was drained or cancelled according to the selected action, and matching cleanup and evidence are accounted for.
