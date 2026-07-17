# Configuring Dispatch Workspaces

## Goal

Configure where dispatch creates task workspaces, which branch they start from, how completed work is published, and which bootstrap steps prepare workers and reviewers. By the end, you will have a schema-valid project configuration and agent-specific bootstrap policy without taking over workspace lifecycle management from kspec.

## Prerequisites

- A kspec project with setup completed and a healthy shadow worktree
- A Git repository with the intended integration branch available locally
- Permission to edit the root `kspec.config.yaml` and the project's agent definitions
- Any package manager, compiler, or other tool used by your bootstrap commands already installed on the dispatch host

If project setup is incomplete, run `kspec setup` first. Use `kspec setup --help` for its complete option list.

## Steps

### 1. Add the minimal project configuration

The root `kspec.config.yaml` owns settings shared by every dispatched agent. This complete example makes each dispatch key explicit:

```yaml kspec-config
dispatch:
  base_branch: dev
  worktree_root: .kspec-worktrees
  publication_mode: manual_merge
  sync_interval: 60
  remote_sync: true
  bootstrap:
    steps:
      - run: npm ci
        name: install-dependencies
        roles: [worker, reviewer]
        idempotent: true
        allow_tracked_changes: false
        reviewer_rerun_allowed: true
```

All dispatch fields are optional. The defaults are:

| Field              | Default                                  | Meaning                                                                              |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `base_branch`      | resolved fallback                        | Default integration target when a task has no plan target                            |
| `worktree_root`    | `.kspec-worktrees`                       | Root for dispatcher-managed worktrees                                                |
| `publication_mode` | `auto`                                   | Publication behavior selected from the supported modes below                         |
| `bootstrap.steps`  | `[]`                                     | Project bootstrap steps, run before agent steps                                      |
| `sync_interval`    | `60`                                     | Seconds between periodic target synchronization; `0` disables only the periodic pass |
| `remote_sync`      | enabled exactly when a Git remote exists | Whether dispatch performs remote push and pull operations                            |

The three publication modes are:

- `manual_merge` — keep work on the canonical task branch for reviewed local merge into the integration target.
- `pull_request` — publish through a GitHub pull request when the required remote and GitHub tooling are available.
- `auto` — let kspec select publication behavior from the environment. This is the default.

Use the final integrated values for your project. Do not copy a project-specific branch name or publication policy merely because it appears in another repository.

### 2. Understand base and plan target resolution

For a task derived from a plan with a plan branch, that plan branch is the integration target. It takes precedence over `dispatch.base_branch`. For other tasks, the configured base branch takes precedence over kspec's deterministic fallback.

This resolution is source-bound to the task and plan. A dispatched prompt records the canonical branch and integration target chosen for that workspace; bootstrap commands do not choose or rewrite them.

### 3. Choose the worktree root

A relative `worktree_root` is resolved from the project root. An absolute path remains absolute. The default keeps transient worktrees under `.kspec-worktrees` beside the main checkout.

Project setup and upgrade maintain a sentinel-delimited kspec block in the root `.gitignore`. A relative dispatch root is included in that managed block. An absolute root receives no managed repository-relative ignore entry, even when the chosen path is inside the repository, so prefer an absolute location outside the repository. Let kspec maintain this block instead of hand-editing its generated entries.

The configured root is a location policy, not an ownership claim over every directory beneath it. Dispatch's workspace registry is authoritative, and cleanup is limited to artifacts whose dispatch ownership can be established.

### 4. Select publication mode

Choose a mode that matches the project's review policy:

1. Use `manual_merge` when reviewed task branches are merged locally into an integration branch.
2. Use `pull_request` only when GitHub pull requests are the supported publication path and the host has the required authentication and tooling.
3. Leave `auto` when environment-based selection is intentional.

Publication mode controls how completed work is handed to review and integration. It does not change workspace ownership, bootstrap safety, or lifecycle controls.

### 5. Define project bootstrap

Project bootstrap prepares every dispatch-managed workspace before the agent prompt is delivered. Steps run in declaration order. Project steps always run before per-agent steps.

Each step supports these fields:

- `run` — required shell command, executed with the workspace as its working directory.
- `name` — stable diagnostic name; kspec supplies an indexed name when omitted.
- `roles` — optional `worker` and/or `reviewer` filter. Omit it to apply the step to both roles.
- `idempotent` — declares that rerunning the step is safe.
- `allow_tracked_changes` — explicit opt-in when a step is intended to modify tracked files. The default is `false`; a tracked-file status change otherwise fails bootstrap.
- `reviewer_rerun_allowed` — explicitly permits a reviewer rerun even when idempotence alone is not declared.

Use bootstrap for deterministic workspace preparation such as dependency installation or generated build artifacts. Keep source edits in the agent's assigned task work, not in bootstrap.

### 6. Add per-agent bootstrap only where needed

An agent definition can append steps after the project sequence. Dispatch rules use `on` and `filter`, and automation eligibility is filtered per event rather than by a global agent default:

```yaml kspec-agent
dispatch:
  - on: task.ready
    filter:
      automation: eligible
      tags: [dispatch]
      priority: 1
  - on: task.in_progress
    filter:
      automation: eligible
  - on: task.needs_work
    filter:
      automation: eligible
  - on: task.pending_review
bootstrap:
  steps:
    - run: npm run build
      name: build-agent-artifacts
      roles: [worker, reviewer]
      idempotent: true
      allow_tracked_changes: false
      reviewer_rerun_allowed: true
```

The example intentionally leaves `task.pending_review` without an automation filter: filters belong to the event rule that needs them. Check current agents with `kspec agent list`; use `kspec agent --help` for the complete agent command reference.

### 7. Account for worker and reviewer behavior

Worker and reviewer workspaces have different Git shapes: workers use the canonical task branch, while reviewers use detached snapshots. Bootstrap state is recorded per role.

When a worker bootstrap state is still valid and no reviewer-specific steps apply, the reviewer reuses that valid state without rerunning commands. When reviewer steps must run, every applicable step must be safe to rerun: `idempotent: true` or `reviewer_rerun_allowed: true`. Otherwise reviewer bootstrap fails instead of guessing that a side effect is safe.

A change to bootstrap configuration, a changed canonical branch head, or a previous bootstrap failure invalidates recorded state and causes the applicable safety checks to run again.

### 8. Keep bootstrap and runner environments separate

Bootstrap steps are shell commands run directly in the assigned dispatch workspace. Named runner configuration shapes the agent process; it does not wrap project or per-agent bootstrap commands. Validate named runners separately with `kspec agent runners validate`, and use `kspec agent runners validate --help` for the full validator options. See [Configuring Agent Runners](./configuring-agent-runners.md) for runner environment and credential policy.

Bootstrap inherits the host environment except for dispatcher's own daemon runtime-mode variables, then adds the environment intended for the step. It also exposes the bootstrap role, source, and step name to the command. Because this is process environment, do not use bootstrap output as a secret transport.

kspec records a bounded tail of combined standard output and error for bootstrap diagnostics, including successful steps. The tail is diagnostic evidence, not a redacted secret store. Never echo credentials, tokens, or other sensitive values from a bootstrap command.

One-shot `kspec agent run` invocations are not dispatch-managed workspaces and do not receive this workspace bootstrap contract. Use `kspec agent --help` for one-shot invocation help.

### 9. Configure remote synchronization deliberately

When `remote_sync` is omitted, dispatch enables it exactly when the repository has a remote. Without a remote, dispatch remains local-only without degraded status or warnings. Set `remote_sync: false` to choose local-only operation even when a remote exists.

With remote synchronization enabled, target updates are fast-forward only; dispatch does not create merge commits to reconcile a divergent target. Periodic synchronization is deferred for a target while that target has an active reviewer. An on-start or before-provision synchronization is still possible when `sync_interval` is `0`; that value disables only the periodic pass.

Transient fetch or connectivity failures emit warnings and leave the target out of degraded state so dispatch can retry. Failures that make target mutation unsafe, including divergence, are reported as degraded target state rather than silently rewriting history. For a degraded target, public agent status identifies the affected branch, failure kind and reason, and when degradation began. Inspect it with `kspec agent status`; use `kspec agent status --help` for the complete status options.

Remote synchronization is intentionally limited. It does not promise automatic conflict resolution, merge commits, or recovery from arbitrary remote topology. Repair the branch or remote through the project's normal reviewed Git workflow, then let dispatch retry its fast-forward path.

### 10. Use supported inspection and recovery paths

For configuration and bootstrap diagnosis:

1. Run `kspec agent status` to inspect dispatch and degraded-target status. See `kspec agent status --help` for all output modes.
2. Run `kspec task get <task-ref>` to read task notes and bootstrap failure guidance. See `kspec task get --help` for the full command syntax.
3. Run `kspec agent runners validate` only for named-runner problems; it does not validate workspace bootstrap. See `kspec agent runners validate --help` for all validator options.
4. Correct the project or agent source configuration and allow dispatch to prepare or resume the workspace through its normal task lifecycle.

Lifecycle start, pause, resume, and stop controls govern dispatch admission and owned processes. They do not manage or delete workspaces, and there is no workspace list, show, reset, or cleanup command. Do not edit the workspace registry or lifecycle control state, delete paths under the managed root, or run manual Git worktree mutations as a recovery technique.

For the dispatch mental model, read [Agents and Dispatch](../concepts/agents-and-dispatch.md). For assignment symptoms, use [Dispatch Refuses to Assign a Task](../troubleshooting/dispatch-refuses-to-assign.md).

## Verification

Confirm the configuration without forcing a dispatch lifecycle transition:

1. Run `kspec setup` if you changed the managed worktree root and need project scaffolding refreshed. Review `kspec setup --help` before selecting options.
2. Run `kspec agent list` and confirm the intended agents and event rules are present. Review `kspec agent --help` for the full command reference.
3. If an agent uses a named runner, run `kspec agent runners validate` and confirm the runner is valid. Review `kspec agent runners validate --help` for all options.
4. Run `kspec agent status` and confirm there is no unexpected degraded target. Review `kspec agent status --help` for all status formats.
5. After the next eligible task is dispatched, use `kspec task get <task-ref>` to confirm its task note and assigned workspace context show the expected target and no bootstrap failure. Review `kspec task get --help` for the complete syntax.

The goal is met when the selected integration target, worktree root, publication mode, project-before-agent bootstrap sequence, and remote status match the project policy, while the task remains under normal dispatch ownership.
