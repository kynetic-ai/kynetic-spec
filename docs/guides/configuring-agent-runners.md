# Configuring Agent Runners

This guide walks through configuring named agent runners in a kspec project. By the end you will know how to keep an existing agent on the legacy adapter path, define a named runner that an agent can reference, split portable settings from machine-local settings across the two config layers, bind credentials without committing them, validate the result, and migrate existing projects gradually.

For the mental model behind runners — what they are, why the two-layer split exists, and how resolution works — read [Agent Runners](../concepts/agent-runners.md) first.

## Prerequisites

- A kspec project with an initialized shadow branch (`kspec doctor` reports a healthy shadow worktree)
- An agent definition you can edit (the built-in agents from `kspec setup` are fine to use as a base)
- Familiarity with the agent and dispatch model — see [Agents and Dispatch](../concepts/agents-and-dispatch.md)

## File Locations

Runner configuration lives in two files. You will edit one or both depending on what you are storing.

- **Project layer** — `.kspec/project.runners.yaml` in the shadow worktree. Visible from the main checkout at the same relative path. Tracked on the shadow branch and shared across every clone of the project.
- **System layer** — `<daemon-config-dir>/projects/<project-key>/runners.yaml` under the user's kspec daemon config directory. `<project-key>` is the SHA-256 digest of the canonical absolute project root, so the path is deterministic but does not embed the raw path. The file is local to your machine and never committed.

Run `kspec agent runners validate` from the project root to see which file paths kspec resolved for the current project (the validator reports them when either layer has issues).

## Steps

### 1. Keep an existing agent on the legacy adapter path

You do not need to change anything to keep using the legacy `adapter` path. An agent definition that points directly at an adapter continues to work:

```yaml
# kynetic.meta.yaml — legacy agent, no runner field
agents:
  - id: task-worker
    adapter: claude-agent-acp
    dispatch:
      - trigger: task.ready
        filters:
          automation: eligible
      - trigger: task.in_progress
      - trigger: task.needs_work
```

When kspec invokes this agent it takes the implicit path: resolve `claude-agent-acp` from the adapter registry and spawn it with the adapter's defaults. No runner config is loaded, no merge happens, and `kspec agent list` shows the agent with the resolved adapter id but no `runner:` line — the runner row is only rendered for agents that declare one.

This is the path for every existing project until you opt into a runner.

### 2. Define a named runner in system config

A runner becomes available to agents as soon as it appears in either config layer with a resolvable adapter. Because `kind` and `adapter` are required to make a runner effective, and `adapter` is system-only at the schema level for any runner that does not also exist in project config, the smallest useful runner lives in system config.

Create `<daemon-config-dir>/projects/<project-key>/runners.yaml` with a minimal entry:

```yaml
# System layer — <daemon-config-dir>/projects/<project-key>/runners.yaml
runners:
  default-acp:
    kind: acp_process
    adapter: claude-agent-acp
```

After this file is in place, `default-acp` is a valid named runner. You can confirm it is loaded with:

```bash
kspec agent runners validate
```

The output names the runner, its kind, and the resolved adapter:

```
Runner validation

  default-acp [valid]
    kind: acp_process
    resolved_adapter: claude-agent-acp
    command_source: adapter
    cwd_source: invocation
    args_source: none

OK runner validation passed
```

`command_source: adapter` here means the runner did not override the executable, so the adapter's registered command is what will spawn.

### 3. Add portable non-secret values in project config

Move project-wide settings that should live with the repo into the project layer. Project config carries only `env.set` literals (non-secret), `privacy`, and `diagnostics`:

```yaml
# Project layer — .kspec/project.runners.yaml
runners:
  default-acp:
    env:
      set:
        NODE_ENV: production
        KSPEC_PROJECT_TAG: my-project
    privacy:
      disable_nonessential_traffic: true
    diagnostics:
      retain_raw_logs: on_failure
```

These values now apply to every machine that runs this project — they ship with the shadow branch. The project layer schema enforces the security boundary: if you tried to declare `ANTHROPIC_API_KEY` (or any name containing `API_KEY`, `AUTH_TOKEN`, `SECRET`, `PASSWORD`, etc.) under `env.set`, the project layer would be rejected before becoming part of the effective registry.

### 4. Override a project value from system config

When the system layer declares the same field as the project layer, the system value wins. This is how you handle machine-specific deviations from the project default without editing the shared project file.

Continuing the example: suppose one developer wants to disable the privacy default on their machine for debugging. They add it to their system file under the same runner name:

```yaml
# System layer — overriding a project default
runners:
  default-acp:
    kind: acp_process
    adapter: claude-agent-acp
    privacy:
      disable_nonessential_traffic: false
```

`kspec agent runners validate` now reports the override:

```
  default-acp [valid]
    kind: acp_process
    resolved_adapter: claude-agent-acp
    command_source: adapter
    cwd_source: invocation
    args_source: none
    overrides: privacy.disable_nonessential_traffic
```

`overrides` lists the fields the system layer pulled away from the project layer. `env.set` keys merge per-key — the system layer only overrides keys it explicitly declares, leaving the rest of the project's `env.set` intact.

### 5. A complete system runner with env policy, secrets, args, cwd, and an executable

The full set of process-shaping fields lives in the system layer. Here is a runner that exercises every one of them:

```yaml
# System layer — full process-shaping example
runners:
  acp-with-secrets:
    kind: acp_process
    adapter: claude-agent-acp
    process:
      # Optional command reference. Overrides the adapter's registered command.
      executable: /opt/kspec/bin/claude-wrapper
      # Non-secret arguments appended to the spawn. Secret-shaped values
      # (Bearer tokens, --api-key flag pairs) are rejected here at load time.
      args:
        - "--profile"
        - "team-default"
      # Working directory for the child process only. Does not affect daemon cwd.
      cwd: /opt/kspec/work-roots/agents
    env:
      # Inheritance policy. Default is `minimal` (PATH, HOME, USER, LOGNAME,
      # SHELL, LANG, LC_*, TERM, TMPDIR/TMP/TEMP, PWD). `ambient` passes the
      # whole host env. `none` inherits nothing.
      inherit: minimal
      # Explicit allow-list of additional host vars to forward.
      pass:
        - "AWS_REGION"
        - "NODE_OPTIONS"
      # Non-secret literals. Same rejection rules as project layer apply.
      set:
        KSPEC_RUN_LABEL: "team-default"
      # Credential source bindings. System layer only.
      secrets:
        ANTHROPIC_API_KEY:
          source: user_env
          required: true
    privacy:
      disable_nonessential_traffic: true
    diagnostics:
      retain_raw_logs: on_failure
```

A few things to call out:

- **`env.secrets` is system-only.** The project layer schema rejects any `env.secrets` block. The source identifier (`user_env`) names where to fetch the value at invocation time; the actual secret value never appears in this file, in session metadata, in diagnostics, or in `kspec agent runners validate` output.
- **`required: true` blocks invocation when the secret cannot be resolved.** If `ANTHROPIC_API_KEY` is not set in the user environment when an agent invocation prepares, the spawn fails before the adapter starts with a `missing_secret` diagnostic.
- **`process.cwd` is invocation-local.** It applies only to the spawned child process. The daemon and any other parent processes keep their own cwd. Absolute paths (like the `cwd: /opt/kspec/work-roots/agents` above) are used as-is after normal path normalization. Relative paths are resolved against the directory containing this system `runners.yaml` file — never against the daemon or CLI parent process cwd — so the effective cwd is stable regardless of which process launched kspec.
- **`process.executable` is optional.** When set, it overrides the adapter's registered command. When omitted, the adapter's registered command is used and the validator reports `command_source: adapter`.
- **`process.args` are appended to the spawn**, never persisted into the adapter definition. They reach the child process only for runner-backed invocations of this runner.

Validating this runner shows the per-field source attribution and confirms no secrets leaked into the diagnostic surface:

```
  acp-with-secrets [valid]
    kind: acp_process
    resolved_adapter: claude-agent-acp
    command_source: runner.system
    cwd_source: runner.system
    args_source: runner.system
```

### 6. Reference the runner from an agent

With the runner registered, point an agent definition at it. The `runner` field is an optional string that names a runner from the effective registry:

```yaml
# kynetic.meta.yaml — agent that uses a named runner
agents:
  - id: task-worker
    runner: acp-with-secrets
    # Adapter is retained only as legacy metadata. Invocation uses the runner.
    adapter: claude-agent-acp
    dispatch:
      - trigger: task.ready
        filters:
          automation: eligible
      - trigger: task.in_progress
      - trigger: task.needs_work
```

You can set or clear the field with `kspec meta set`:

```bash
# Set a runner reference
kspec meta set task-worker --runner acp-with-secrets

# Clear the runner reference (agent falls back to adapter / default)
kspec meta set task-worker --clear-runner
```

`kspec agent list` shows the runner name and the resolved adapter on every agent. For agents that have both fields, the runner takes invocation precedence — the legacy `adapter` field is reported only for backward compatibility and is not used to spawn.

### 7. Validate the effective configuration

Run the validator any time you change either config layer. It loads both layers, merges them, and reports the effective runner contract without spawning anything.

Human-readable mode lists each runner with its sources, overrides, and any diagnostics:

```bash
kspec agent runners validate
```

`--runner <name>` filters the report to a single named runner:

```bash
kspec agent runners validate --runner acp-with-secrets
```

`--json` emits a structured payload suitable for scripting. The shape is stable and matches the operator-surface contract:

```bash
kspec agent runners validate --json
```

```json
{
  "ok": true,
  "runners": [
    {
      "runner": "acp-with-secrets",
      "kind": "acp_process",
      "resolved_adapter": "claude-agent-acp",
      "command_source": "runner.system",
      "cwd_source": "runner.system",
      "args_source": "runner.system",
      "status": "valid",
      "sources": {
        "kind": "system",
        "adapter": "system",
        "process_executable": "system",
        "process_args": "system",
        "process_cwd": "system",
        "env_inherit": "system",
        "env_pass": "system",
        "env_set_keys": {
          "KSPEC_RUN_LABEL": "system"
        },
        "env_secrets": "system",
        "privacy_disable_nonessential_traffic": "system",
        "diagnostics_retain_raw_logs": "system"
      },
      "overrides": [],
      "diagnostics": []
    }
  ],
  "issues": []
}
```

The output fields are:

| Field                   | Meaning                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner`                | Configured runner name.                                                                                                                                          |
| `kind`                  | Runner kind. Currently `acp_process`.                                                                                                                            |
| `resolved_adapter`      | Registered adapter id that the runner spawns.                                                                                                                    |
| `command_source`        | Where the executable came from: `runner.project`, `runner.system`, `runner.merged`, `adapter` (adapter default), `invocation`, `auto_approve`, or `none`.        |
| `cwd_source`            | Where the working directory came from. Same vocabulary as `command_source`.                                                                                      |
| `args_source`           | Where the appended args came from. Same vocabulary.                                                                                                              |
| `status`                | `valid` or `invalid`. The runner is invalid when any per-runner diagnostic is recorded.                                                                          |
| `sources`               | Per-field origin map: each field is `project`, `system`, or `default` (or `null` for fields the runner did not declare). `env_set_keys` is a per-key map.        |
| `overrides`             | Field paths where the system layer overrode a project value. Empty when nothing was overridden.                                                                  |
| `diagnostics`           | Redacted per-runner issues. Each carries a stable `reason` code and an actionable, secret-free `message`. Empty when the runner is valid.                        |
| `issues` (report-level) | Validation issues that are not scoped to a single runner — for example, YAML parse errors in either layer file, or an unknown runner name passed via `--runner`. |
| `ok`                    | `true` only when every selected runner reports `status: valid` and there are no report-level issues.                                                             |

The exit status follows `ok`: `0` when every selected runner is valid and there are no report-level issues; non-zero otherwise. This makes the command safe to wire into CI or pre-spawn checks.

#### Common failure diagnostics

The `reason` field on diagnostics is stable. The most common codes you will see:

| `reason`                       | What it means                                                                                                                             | Where to fix it                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `unknown_runner`               | An agent references a runner name that is not in the effective registry, or `--runner <name>` was passed with a name that does not exist. | Project runner config, system runner config, or the agent definition's `runner` field.                        |
| `invalid_adapter`              | The runner declares an `adapter` value that is not a registered adapter id.                                                               | System runner config.                                                                                         |
| `missing_adapter_registration` | The runner refers to an adapter that is no longer registered at validation time (e.g., a plugin that has not loaded).                     | The adapter registration — make sure the adapter is installed and registered, or change the runner's adapter. |
| `unspawnable_command`          | `process.executable` cannot be found, is not executable, or failed a quick spawn probe.                                                   | System runner config — fix the path or permissions.                                                           |
| `invalid_cwd`                  | `process.cwd` does not exist, is not a directory, or is not accessible.                                                                   | System runner config — fix the directory or its permissions.                                                  |
| `invalid_args`                 | `process.args` contains a secret-shaped value (Bearer token, `--api-key=…`, or the value following a credential-named flag).              | System runner config — move the credential to `env.secrets` and refer to it by env var name in your adapter.  |
| `missing_secret`               | A `required: true` `env.secrets` binding could not be resolved from its source at invocation time.                                        | The credential source (e.g., user environment) — set the variable or change `required`.                       |
| `preflight_failure`            | Generic preflight error — usually a YAML parse error or a schema-level rejection in either layer file.                                    | The file path named in the diagnostic message and detail block.                                               |

Diagnostic messages are redacted: the validator never prints secret values, even when reporting that a secret-shaped value was rejected. Args diagnostics name the offending index; env diagnostics name the offending key.

## Migration Guidance

Runner configuration is additive. Adopt it gradually rather than as a sweeping change.

**Existing projects do not need immediate changes.** Every agent that declares `adapter` continues to work without a runner. Nothing about the legacy invocation path changed. You can leave a project on the adapter path indefinitely.

**For new projects, prefer named runners.** When you set up a new project, define a runner for each distinct execution profile (worker, reviewer, headed) and have agents reference the runner by name. This puts adapter-specific env, args, and cwd settings in a place where they can be inspected and overridden without editing agent definitions.

**Move project-wide non-secret settings into the project layer.** If you have `env.set` literals or privacy/diagnostic preferences that every machine should share, put them in `.kspec/project.runners.yaml`. They travel with the shadow branch and apply to every clone.

**Keep secret values in system secret bindings.** Never put API keys, OAuth tokens, or any credential variable in `env.set` — the project layer rejects them at load time, and even the system layer will reject the literal. Use `env.secrets` bindings in the system layer instead, with `required: true` for credentials that should block spawn when missing.

**Keep project runner config limited to portable values.** The project layer is intentionally narrow. If a setting depends on a specific machine, user, file path, or credential, it belongs in the system layer. If a setting could be shared across every clone of the project without modification, it belongs in the project layer.

When you migrate an existing agent, the typical sequence is:

1. Create a system runner that mirrors the agent's current adapter behavior (`kind: acp_process`, `adapter: <existing-adapter>`).
2. Move any project-wide non-secret env or privacy settings into `.kspec/project.runners.yaml` under the same runner name.
3. Move any machine-local env, executable, args, cwd, or credential bindings into the system file.
4. Set `runner: <name>` on the agent. Leave `adapter` in place as legacy metadata if you want; the runner wins at invocation time.
5. Run `kspec agent runners validate` to confirm the effective contract.
6. Smoke-test the agent (one-shot `kspec agent run <agent-id>` or a queued dispatch) to confirm the new invocation path works end-to-end.

You can stop at any of these steps. An agent with only a project-layer entry and no system entry will fail validation (no `kind`/`adapter`); but the agent itself still works through the legacy adapter path until you set the `runner` field on it.

## Looking Ahead: The Headed Claude Code Sidecar

A future **headed Claude Code sidecar** is planned as a separate runner kind that consumes the same contract described above. It will be a runner alongside `acp_process` rather than a replacement for it. From an operator perspective the workflow is the same as for any other runner:

- The sidecar will appear in `runners.yaml` as a system-layer entry with its own `kind` value and a registered adapter.
- The same **layered runner config** applies: project layer for portable preferences, system layer for process settings, command references, args, cwd, env policy, and credential bindings.
- The same **env and secret boundaries** apply: project config remains non-secret, `env.secrets` stays system-only, `required: true` bindings block invocation when missing, and diagnostics redact secret material.
- The same **invocation inputs** apply: optional `process.executable`, non-secret `process.args`, child-process-only `process.cwd`, and per-field source diagnostics in `kspec agent runners validate`.
- The same **dispatch compatibility** applies: dispatch preflight accepts the sidecar runner the moment its adapter is registered, and rejects it with the same per-reason diagnostics if validation fails.
- The same **operator visibility** applies: `kspec agent list`, the daemon agent and dispatch APIs, and the Web UI show the sidecar runner name, the resolved adapter, and any redacted diagnostics on every agent and invocation that uses it.

When the sidecar runner kind ships, configuring it will be no different from configuring any other runner described in this guide — you change the `kind` value and point at its adapter; everything else (env, secrets, args, cwd, validation, visibility) reuses the contract above.

## Verification

After configuring a runner, work through this checklist:

- `kspec agent runners validate` returns `OK runner validation passed` and exits `0`.
- `kspec agent runners validate --json` reports `ok: true` and an empty `issues` array.
- `kspec agent list` shows the expected `runner` name and `resolved_adapter` for the agent.
- A one-shot invocation completes: `kspec agent run <agent-id> --task @task-ref --dry-run` succeeds and the dry-run summary shows the expected `Runner:`, `Adapter:`, `Command:`, and `Env policy:` lines.

If any of these fail, read the `diagnostics` block from the validator first — the `reason` code and message identify both the field that is wrong and which config layer owns the fix.
