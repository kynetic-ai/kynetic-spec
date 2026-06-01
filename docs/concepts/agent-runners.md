# Agent Runners

A **runner** is a named execution harness for an agent. It tells kspec how to launch the adapter process that an agent talks to — which command to spawn, which environment to give it, which working directory to use, and which secrets it needs. Runners are the operator-facing knob for everything about agent process invocation that lives outside the adapter and outside the agent definition.

Before runners existed, an agent definition pointed directly at an adapter (`adapter: claude-agent-acp`) and kspec spawned that adapter with whatever the adapter registration declared. That works for the common case but leaves no clean place to put project-specific or machine-specific overrides — different working directories on different machines, project-wide env vars, host-managed credentials, telemetry policy. Runners add a layer in between so those settings have a home that is portable, validated, and never leaks secrets into the repository.

## The Two-Layer Model

Runner configuration is stored in two layers that compose into a single effective runner registry:

- **Project layer** — repo-managed, lives in the shadow worktree at `.kspec/project.runners.yaml`. Carries only **portable, non-secret** values that every machine working on this project should share. The schema rejects secret-looking env names, known credential variable names, and any `env.secrets` bindings at load time.
- **System layer** — machine-local, lives outside the repository under the user's daemon config directory at `<daemon-config-dir>/projects/<project-key>/runners.yaml`. Owns process settings (executable, args, cwd), env policy (inherit, pass, set), credential source bindings (`env.secrets`), and any local overrides of project-layer values.

The effective runner is the merged result, with **system values overriding project values field-by-field** for the same runner name. Every field in the resolved runner carries source metadata identifying which layer supplied it and whether the system layer overrode a project value.

Both layers are optional. A project with no runner config and agents that only declare `adapter` keeps working exactly as before — runners are additive.

## How Resolution Works

When kspec invokes an agent it walks a short decision tree:

1. If the invocation supplied an explicit `--adapter` override, take the legacy path with that adapter and ignore any configured runner.
2. If the agent definition has a `runner` field, look the name up in the effective registry. A missing name fails before any process is spawned, with a diagnostic that names both config layers and the agent definition as places to check.
3. If the agent has no `runner` field, fall back to `agent.adapter` (or the built-in default).
4. When both `runner` and `adapter` are present, the runner wins. The resolved runner picks the adapter; the agent's legacy `adapter` field is retained only as metadata.

Resolution produces an invocation contract that contains the runner name, the resolved adapter identity, the command kspec will spawn, its arguments, environment, cwd, and a redacted diagnostics block. Every operator-facing surface — `kspec agent list`, `kspec agent runners validate`, the daemon agent API, dispatch status, the Web UI — renders this contract so the runner and resolved adapter are visible everywhere the agent appears.

## What Goes Where

The two-layer split is a security and portability boundary, not a feature split.

| Lives in project layer (`project.runners.yaml`)             | Lives in system layer (`runners.yaml`)                    |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `env.set` non-secret literals (e.g. `NODE_ENV: production`) | `kind`, `adapter` (required to make the runner effective) |
| `privacy.disable_nonessential_traffic`                      | `process.executable`, `process.args`, `process.cwd`       |
| `diagnostics.retain_raw_logs`                               | `env.inherit`, `env.pass`, `env.secrets`                  |

`env.secrets` is system-only. The project layer schema rejects it outright, and rejects known credential variable names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, …) and any name containing `API_KEY`, `AUTH_TOKEN`, `ACCESS_TOKEN`, `OAUTH_TOKEN`, `SECRET`, or `PASSWORD` from literal `env.set` values. Process args go through a similar secret-shaped-value check that flags `Bearer <token>`, `--api-key=<value>`, and the same flag-name patterns.

These rules are enforced at config load time, not at invocation time. A project layer that tries to declare an API key never reaches the effective registry — the load step returns a validation issue and the runner is rejected before it can be referenced by any agent.

## Why a Runner Layer at All

Runners exist because adapter registrations are not the right place for operator policy. An adapter says "I am Claude Agent ACP and I launch with this command." It does not say "On this project, prefix that command with our wrapper script and pass `KSPEC_ENV=production`." Without a runner layer, projects have only two options for that kind of override: bake it into the adapter registration (which becomes machine-specific) or set environment variables on the daemon process (which leaks across all invocations). Both undermine the goal of reproducible agent execution.

Runners separate those concerns:

- The **adapter** describes the ACP integration: which protocol version, which entry point, how to format prompts and skills.
- The **runner** describes the invocation: what to spawn, what environment to give it, what working directory to start from, what credentials it needs, what privacy and diagnostic policy to apply.
- The **agent definition** points at one or the other (and may keep both for backward compatibility).

This split also makes the security model legible. Anything portable enough to commit lives in the project layer. Anything that depends on a specific machine, a specific user, or a credential lives in the system layer. There is no third tier where the boundary blurs.

## Where Runners Show Up in Use

You encounter runners across the same surfaces that already expose agents:

- **CLI.** `kspec agent list` shows the runner name (when present) and the resolved adapter for every agent in both human and JSON output. `kspec agent runners validate` returns the effective registry, source attribution, and redacted diagnostics so operators can confirm what will spawn without running anything.
- **Daemon API.** Agent and dispatch endpoints include the runner name and resolved adapter on agent definitions, active invocations, and queued invocations, with diagnostics scrubbed of secret material.
- **Web UI.** Agent cards display the runner identity (when present) and the resolved adapter for every agent. Active and queued invocation rows surface the same fields. The agent edit form sets or clears `runner` without forcing a raw adapter edit.
- **Session metadata and dispatch events.** `agent.dispatched` events and session metadata for runner-backed invocations carry the runner name and resolved adapter id alongside the existing fields, so logs and dashboards reflect the runner contract.

If you want the configuration walkthrough — concrete YAML, the validation command, and migration guidance — see [Configuring Agent Runners](../guides/configuring-agent-runners.md).
