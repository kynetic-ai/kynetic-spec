# Agent Runner Configuration Layer

## Summary

Introduce a first-class runner layer for kspec agent execution. A runner is an execution harness selected from layered configuration: a repo/project layer stores only portable project-specific values, while a local system layer stores machine/user-specific harness mechanics, runtime paths, and credential bindings. The system layer overrides the project layer field-by-field. Agents may reference a runner, while the existing adapter field remains a backward-compatible shortcut.

This plan is scoped to kspec's storage format, TypeScript types, layered resolver/runtime path, daemon and CLI behavior, API data shapes, and Web UI surfaces. It does not implement a full headed Claude Code sidecar. It makes kspec capable of describing, validating, launching, and observing runner-backed ACP processes so a headed sidecar can be integrated without PATH shims or daemon-owned ambient credentials.

## Specs

```yaml
- title: Layered Agent Runner Configuration
  slug: agent-runner-configuration
  type: requirement
  parent: "@agent-integration"
  tags: [agents, config, runners]
  description: |
    kspec resolves named agent runners from two simple configuration layers. The
    repo/project layer stores portable project-specific values only. The local
    system layer stores machine/user-specific harness mechanics, runtime paths,
    credential bindings, and local overrides. The effective runner is the merged
    result, with system values overriding project values for the same runner.
  acceptance_criteria:
    - id: ac-named-runners-loaded
      given: |
        The project runner config or system runner config contains one or more named runner entries
      when: |
        Runner configuration is loaded for a project
      then: |
        Each named runner is available to agent resolution by its configured name
    - id: ac-project-runner-storage-is-repo-managed
      given: |
        Portable project-specific runner values are defined for a project
      when: |
        Those values are persisted
      then: |
        They are stored in a repo-managed runner config artifact rather than in agent meta records or process environment variables
    - id: ac-system-runner-storage-is-local
      given: |
        Local runner values are defined for a project
      when: |
        Those values are persisted
      then: |
        They are stored under the user-level kspec daemon config directory and are not committed to the project repository or shadow branch
    - id: ac-system-overrides-project-values
      given: |
        The same runner field is present in both project and system runner config
      when: |
        The effective runner config is resolved
      then: |
        The system value is used for that field
    - id: ac-project-layer-blocks-harness-logic
      given: |
        Project runner config contains harness logic fields such as kind, adapter, executable path, package materialization, hook transport, or secret source bindings
      when: |
        Project runner config is validated
      then: |
        The project config is rejected with guidance to move those fields to system runner config
    - id: ac-project-layer-blocks-known-secret-keys
      given: |
        Project runner config contains a known adapter or harness API key, auth token, OAuth token, credential variable, or secret-looking literal field
      when: |
        Project runner config is validated
      then: |
        The project config is rejected before it can become the effective runner configuration
    - id: ac-effective-runner-kind-and-adapter-required
      given: |
        A merged effective runner definition is loaded
      when: |
        The runner is validated for invocation
      then: |
        The effective runner has a kind and an adapter reference before it can be used to spawn an agent
    - id: ac-agent-runner-reference
      given: |
        An agent definition contains a runner field
      when: |
        The agent definition is loaded from meta storage
      then: |
        The runner field is accepted as an optional string reference to a named runner
    - id: ac-adapter-field-backcompat
      given: |
        An existing agent definition has an adapter field and no runner field
      when: |
        The agent is invoked or listed
      then: |
        The adapter field continues to work with the same behavior as before the runner layer exists
    - id: ac-runner-precedence-over-adapter
      given: |
        An agent definition has both runner and adapter fields
      when: |
        The agent is invoked
      then: |
        The named runner determines the resolved adapter and execution harness for that invocation

- title: Runner Resolution and Preflight
  slug: runner-resolution-and-preflight
  type: requirement
  parent: "@agent-integration"
  tags: [agents, runtime, validation]
  description: |
    Agent invocation resolves a runner before spawning an adapter process. Resolution
    produces a single invocation contract containing runner identity, adapter identity,
    command, arguments, environment, runtime diagnostics, and cleanup hooks. Invalid
    runner configuration fails before prompt forwarding.
  acceptance_criteria:
    - id: ac-one-shot-uses-runner-resolution
      given: |
        kspec agent run starts a one-shot invocation for an agent with a runner field
      when: |
        The invocation is prepared
      then: |
        The invocation uses the resolved runner contract instead of directly resolving the agent adapter field
    - id: ac-dispatch-uses-runner-resolution
      given: |
        The dispatch engine prepares an eligible queued invocation for an agent with a runner field
      when: |
        The invocation is prepared
      then: |
        The dispatch engine uses the same resolved runner contract as one-shot agent run
    - id: ac-unknown-runner-blocks-before-spawn
      given: |
        An agent references a runner name that is not present in the effective runner registry
      when: |
        kspec prepares a one-shot or dispatched invocation
      then: |
        No adapter process is spawned
    - id: ac-unknown-runner-reports-guidance
      given: |
        An invocation is blocked because the configured runner name is unknown
      when: |
        The failure is reported to the user, session, or task
      then: |
        The report names the missing runner and suggests checking both project runner config, system runner config, and the agent definition
    - id: ac-invalid-runner-blocks-before-prompt
      given: |
        Runner validation fails because a required field, adapter reference, runtime, or security setting is invalid
      when: |
        kspec prepares an invocation
      then: |
        The invocation fails before any prompt content is sent to an adapter process
    - id: ac-session-metadata-records-runner
      given: |
        An invocation uses a runner-backed agent
      when: |
        Session metadata is written
      then: |
        The metadata includes the runner name and the resolved adapter id
    - id: ac-dispatched-event-records-runner
      given: |
        An invocation uses a runner-backed agent
      when: |
        The agent.dispatched event is written
      then: |
        The event includes the runner name and the resolved adapter id

- title: Runner Environment and Secret Boundaries
  slug: runner-environment-secret-boundaries
  type: constraint
  parent: "@agent-integration"
  tags: [agents, security, env]
  description: |
    Runner-launched adapter processes receive an explicit environment assembled
    from the effective runner config. Project config may provide only portable
    non-secret values. Secret bindings and machine-local credential sources live
    in system config, and diagnostics never expose secret values. Host, daemon,
    and nested-agent environment variables do not leak into runners unless the
    effective runner policy allows them.
  acceptance_criteria:
    - id: ac-env-inheritance-policy-applied
      given: |
        The effective runner config declares an environment inheritance policy
      when: |
        kspec builds the adapter process environment
      then: |
        The resulting process environment contains only variables allowed by that policy plus kspec-required invocation variables
    - id: ac-env-set-overrides-allowed-values
      given: |
        The effective runner config declares literal non-secret environment values
      when: |
        kspec builds the adapter process environment
      then: |
        The declared values override inherited values for the same keys
    - id: ac-project-env-literals-are-non-secret
      given: |
        Project runner config declares literal environment values
      when: |
        Project runner config is validated
      then: |
        Known API key, auth token, OAuth token, credential variable, and secret-looking environment names are rejected from the project layer
    - id: ac-secret-env-names-use-bindings
      given: |
        Any runner config layer declares literal environment values
      when: |
        Runner configuration is validated
      then: |
        Known secret-looking environment names are rejected from literal values with guidance to use system secret source bindings
    - id: ac-secret-bindings-system-only
      given: |
        A runner declares a secret source binding
      when: |
        Runner configuration is validated
      then: |
        The binding is accepted only from system runner config and not from project runner config
    - id: ac-secret-values-not-stored-inline
      given: |
        A runner declares a secret reference or source binding
      when: |
        The runner configuration is parsed or shown in diagnostics
      then: |
        The secret source reference is retained without persisting or displaying the secret value from either config layer
    - id: ac-required-secret-missing-blocks
      given: |
        The effective runner config declares a required secret source
      when: |
        That secret source cannot be resolved for an invocation
      then: |
        The invocation is blocked before adapter spawn
    - id: ac-diagnostics-redact-secrets
      given: |
        Runner resolution, preflight, spawn, or adapter startup fails
      when: |
        Diagnostics are recorded in CLI output, session events, task notes, daemon API responses, or Web UI state
      then: |
        Secret values are redacted from every diagnostic surface
    - id: ac-privacy-defaults-applied
      given: |
        A runner launches an external agent runtime
      when: |
        The adapter process environment is built
      then: |
        The process receives kspec's default nonessential-traffic and telemetry suppression variables unless the effective runner config explicitly disables that default

- title: Runner Runtime Version Isolation
  slug: runner-runtime-version-isolation
  type: requirement
  parent: "@agent-integration"
  tags: [agents, runtime, isolation]
  description: |
    Runners may select and pin an underlying external runtime independently of
    the host machine's PATH. Pinned runtimes are resolved or materialized under
    runner-owned storage and fail closed on mismatch or partial materialization.
  acceptance_criteria:
    - id: ac-explicit-executable-precedence
      given: |
        A runner has an explicit executable path configured
      when: |
        Runtime selection occurs
      then: |
        The explicit executable is selected before any pinned package or PATH fallback
    - id: ac-pinned-runtime-precedence
      given: |
        A runner has a pinned runtime version configured and a different compatible command exists on PATH
      when: |
        Runtime selection occurs
      then: |
        The pinned runtime is selected instead of the PATH command
    - id: ac-runner-owned-runtime-storage
      given: |
        A pinned runtime must be materialized for a runner
      when: |
        kspec retrieves, extracts, stages, or promotes the runtime
      then: |
        All writes are confined to runner-owned runtime storage for that project
    - id: ac-global-installs-not-mutated
      given: |
        A pinned runtime is missing or stale
      when: |
        kspec materializes the configured runtime
      then: |
        System installs, global package-manager state, and host PATH entries are not modified
    - id: ac-version-mismatch-blocks
      given: |
        The selected executable reports a version different from the configured pinned version
      when: |
        Runner preflight validates the executable
      then: |
        The invocation is blocked before prompt forwarding
    - id: ac-materialization-failure-blocks
      given: |
        Retrieval, extraction, staging, promotion, or version probing fails for a pinned runtime
      when: |
        Runner preflight runs
      then: |
        kspec does not fall back to PATH or a global install for that invocation
    - id: ac-runtime-diagnostics-identify-source
      given: |
        Runtime selection succeeds or fails
      when: |
        Diagnostics are shown
      then: |
        Diagnostics identify the selected runtime source and resolved version without exposing secrets

- title: Runner Invocation Semantics
  slug: runner-invocation-semantics
  type: requirement
  parent: "@agent-integration"
  tags: [agents, sessions, dispatch]
  description: |
    Runner-backed invocations preserve existing agent semantics while making the
    resolved harness explicit. Skill reference formatting, auto-approval flags,
    session environment injection, lifecycle cleanup, and dispatch preflight all
    operate from the resolved runner contract.
  acceptance_criteria:
    - id: ac-skill-formatting-uses-resolved-adapter
      given: |
        A runner resolves to an adapter with adapter-specific skill invocation formatting
      when: |
        kspec builds the agent prompt with skills
      then: |
        Skill references are formatted according to the resolved adapter
    - id: ac-auto-approve-from-resolved-contract
      given: |
        An agent invocation runs with auto_approve enabled
      when: |
        The resolved runner contract supplies adapter or runner auto-approval arguments
      then: |
        Those arguments are appended to the spawned process for that invocation
    - id: ac-session-env-injected-through-runner
      given: |
        An invocation has a kspec session id
      when: |
        The runner contract requires environment or harness-specific session injection
      then: |
        KSPEC_SESSION_ID reaches child kspec commands through the resolved runner injection path
    - id: ac-runner-cleanup-restores-state
      given: |
        A runner modifies temporary config, environment files, hook settings, or runtime state for an invocation
      when: |
        The invocation closes or fails during startup
      then: |
        Runner cleanup restores prior mutable state or removes temporary state best-effort
    - id: ac-dispatch-preflight-accepts-configured-runners
      given: |
        Dispatch evaluates an agent that references a valid configured runner whose adapter is not a built-in adapter id
      when: |
        Dispatch preflight validates the agent
      then: |
        The agent is accepted if the runner resolves to a spawnable ACP adapter contract
    - id: ac-dispatch-preflight-rejects-invalid-runners
      given: |
        Dispatch evaluates an agent whose runner cannot resolve to a spawnable adapter contract
      when: |
        Dispatch preflight validates the agent
      then: |
        Dispatch reports the runner validation failure instead of relying on a later spawn error

- title: Runner Operator Surfaces
  slug: runner-operator-surfaces
  type: requirement
  parent: "@agent-integration"
  tags: [agents, cli, daemon, web-ui]
  description: |
    Operators can inspect and configure agent runner usage through the same
    surfaces that already expose agents and dispatch state. CLI, daemon API,
    WebSocket status data, and the Web UI show runner identity, resolved adapter,
    validation state, and redacted diagnostics.
  acceptance_criteria:
    - id: ac-agent-list-shows-runner
      given: |
        Agent definitions include runner-backed and legacy adapter-backed agents
      when: |
        kspec agent list is run in human-readable or JSON mode
      then: |
        Each agent entry shows its runner name when present and its resolved adapter identity
    - id: ac-agent-set-updates-runner
      given: |
        An agent definition exists
      when: |
        kspec meta set is used to set or clear the agent runner field
      then: |
        The agent definition is updated without changing unrelated fields
    - id: ac-runner-validation-human-output
      given: |
        A project has runner configuration
      when: |
        An operator runs `kspec agent runners validate`
      then: |
        The human-readable output reports each runner's validation state and redacted diagnostics
    - id: ac-runner-validation-json-output
      given: |
        A project has runner configuration
      when: |
        An operator runs `kspec agent runners validate --json`
      then: |
        The command emits a JSON object with a `runners` array whose entries contain `runner`, `kind`, `resolved_adapter`, `runtime_source`, `status`, `sources`, `overrides`, and redacted `diagnostics` fields
    - id: ac-runner-validation-exit-status
      given: |
        A project has runner configuration
      when: |
        An operator runs `kspec agent runners validate` or `kspec agent runners validate --json`
      then: |
        The command exits with status 0 only when every selected runner is valid
    - id: ac-daemon-agent-api-includes-runner
      given: |
        The daemon serves agent definition data
      when: |
        A client requests agent state
      then: |
        The response includes runner name, resolved adapter identity, and redacted runner diagnostics where available for each agent
    - id: ac-daemon-dispatch-active-api-includes-runner
      given: |
        The daemon serves dispatch status data
      when: |
        A client requests active invocation state
      then: |
        The response includes runner name with resolved adapter identity for active invocations
    - id: ac-daemon-dispatch-queued-api-includes-runner
      given: |
        The daemon serves dispatch status data
      when: |
        A client requests queued invocation state
      then: |
        The response includes runner name with resolved adapter identity for queued invocations
    - id: ac-web-ui-agent-cards-include-runner
      given: |
        The Web UI displays the agents page
      when: |
        Agents are loaded from the daemon API
      then: |
        Agent cards display runner identity when present and resolved adapter identity for all agents
    - id: ac-web-ui-active-invocations-include-runner
      given: |
        The Web UI displays active agent invocations
      when: |
        Invocation data is loaded from the daemon API
      then: |
        Active invocation rows display runner identity when present
    - id: ac-web-ui-queued-invocations-include-runner
      given: |
        The Web UI displays queued agent invocations
      when: |
        Invocation data is loaded from the daemon API
      then: |
        Queued invocation rows display runner identity when present
    - id: ac-web-ui-agent-edit-supports-runner
      given: |
        The Web UI agent edit form is available
      when: |
        A user edits an agent's execution settings
      then: |
        The form can set or clear the runner field without forcing a raw adapter edit
```

## Tasks

derive_from_specs: false

```yaml
- title: Update existing agent, event, and adapter specs for runner semantics
  slug: task-update-existing-agent-runner-specs
  priority: 1
  tags: [specs, agents, runners, compatibility]
  spec_ref: "@agent-definition-schema"
  description: |
    What:
    - Update existing implemented kspec contracts that the runner layer extends. Do not rely on plan-local `## Specs` entries to update existing specs; those entries materialize new specs during derivation.
    - Update `@agent-definition-schema` so the existing Agent Definition Schema contract explicitly includes the new optional `runner` field:
      - Add a new AC `ac-runner-field-accepted`: Given an agent definition includes a `runner` field, when the meta manifest is loaded and validated, then the runner field is accepted as an optional string reference to a named runner.
      - Update existing compatibility/default wording in `ac-8` so legacy agent definitions without `runner` validate successfully with `runner: undefined` in addition to the existing default fields.
      - Add a new AC `ac-meta-set-runner-preserves-fields`: Given an agent definition exists, when `kspec meta set <agent>` sets or clears `runner`, then the agent definition is updated while unrelated fields, including `adapter`, are preserved.
    - Update `@dispatch-event-payload` so existing invocation payload contracts include runner-backed metadata without breaking legacy consumers:
      - Add or amend an AC so runner-backed invocation events include `runner` and `resolved_adapter`; legacy adapter-backed invocation events continue to expose adapter identity and omit `runner` when no runner is configured.
      - Keep `task_ref`, `session_id`, `agent_id`, `trigger`, and terminal `duration_ms` semantics unchanged.
    - Update `@codex-acp-adapter-registration` if the implementation moves Codex session injection behind the runner resolver/env builder:
      - Preserve the behavior that Codex receives `KSPEC_SESSION_ID` through its configured environment policy.
      - Preserve cleanup/restoration behavior after invocation close or startup failure.
      - Rewrite AC wording away from the exact helper names `injectEnvForAdapter`/`removeEnvForAdapter` if those helpers are replaced, so the existing spec continues to describe behavior rather than obsolete implementation mechanics.
    - Update statuses for touched existing specs intentionally: keep implemented specs implemented if the task only broadens their contract and immediately implements/tests the updates in the same task chain; otherwise set touched specs to in_progress with `--no-cascade` before implementation work begins.
    - Add notes to touched specs summarizing that the runner configuration plan extends their existing contracts.
    - Verify every new or edited AC is covered by a later implementation task's `Covers:` line before marking this task complete.

    Why:
    The plan-local Specs block creates new runner specs. It does not patch existing implemented specs such as Agent Definition Schema, Dispatch Event Payload Contracts, or Codex adapter registration. Without this explicit task, derivation would leave the current specs stale or conflicting while implementation changes their behavior.

    How:
    - Use `kspec item get` to capture current target spec text before editing.
    - Use `kspec item ac add` for new ACs and the appropriate item/AC update command for amended ACs; do not hand-edit shadow YAML unless the CLI lacks the needed mutation surface.
    - Keep AC IDs exact and stable so implementation tests can annotate against them.
    - Keep the plan-local runner specs as the new high-level contract; use existing-spec edits only for contracts that already own adjacent behavior.

    Testing:
    - `kspec item get @agent-definition-schema`
    - `kspec item get @dispatch-event-payload`
    - `kspec item get @codex-acp-adapter-registration`
    - `kspec validate --refs --warnings-ok`

    Covers: existing @agent-definition-schema agent field/default/mutation AC updates; existing @dispatch-event-payload invocation payload metadata update; existing @codex-acp-adapter-registration Codex session env and cleanup behavior update

- title: Define layered runner config storage, schema, and shared TypeScript types
  slug: task-runner-config-schema-types
  priority: 1
  tags: [config, schema, agents, runners]
  spec_ref: "@agent-runner-configuration"
  depends_on:
    - "@task-update-existing-agent-runner-specs"
  description: |
    What:
    - Add storage and loader support for two runner config layers:
      - Project runner config stored as a repo-managed artifact at `project.runners.yaml` in the shadow worktree root, alongside `kynetic.yaml`; when viewed from the main checkout this appears as `.kspec/project.runners.yaml`. It is loaded only after shadow branch context is available and is never read from root-branch `kspec.config.yaml`.
      - System runner config stored at `<daemon-config-dir>/projects/<project-key>/runners.yaml`, where `<daemon-config-dir>` is the same directory returned by `getDefaultDaemonConfigDir()` unless tests override it.
    - Define `<project-key>` as the lowercase hex SHA-256 digest of the canonical absolute project root path after realpath normalization. Do not truncate it, do not include the raw path in the directory name, and use the same helper in CLI, daemon, and tests.
    - Define separate raw schemas for project runner config and system runner config, plus a merged effective runner type under a shared module such as `src/agents/runner-config.ts`.
    - Project runner config must accept only portable project-specific values, initially limited to non-secret runner values such as `env.set`, `privacy.disable_nonessential_traffic`, and diagnostics preferences that are safe to commit.
    - Project runner config must reject harness logic fields including `kind`, `adapter`, `runtime.executable`, `runtime.package`, `runtime.version`, `runtime.cache_dir`, hook transport settings, and `env.secrets`.
    - Project runner config must reject known adapter/harness secret keys and secret-looking names in `env.set`, including names containing `API_KEY`, `AUTH_TOKEN`, `ACCESS_TOKEN`, `OAUTH_TOKEN`, `SECRET`, `PASSWORD`, and known Claude/Codex/OpenAI credential variable names.
    - System runner config must accept the full initial effective runner shape with these explicit fields and defaults:
      - `kind`: required string enum whose only accepted value in this plan is `acp_process`.
      - `adapter`: required string adapter or package reference.
      - `env.inherit`: enum `ambient`, `minimal`, or `none`, default `minimal` for configured runners.
      - `env.pass`: string array of allowed inherited variable names, default empty.
      - `env.set`: string record for non-secret literals, default empty.
      - `env.secrets`: record keyed by child environment variable name, where each binding has `source` and `required`, default empty.
      - `privacy.disable_nonessential_traffic`: boolean default true.
      - `runtime.executable`: optional string.
      - `runtime.package`: optional string.
      - `runtime.version`: optional string.
      - `runtime.cache_dir`: optional system-config-relative or absolute string.
      - `diagnostics.retain_raw_logs`: enum `never`, `on_failure`, or `always`, default `on_failure`.
    - System runner config must reject known adapter/harness secret keys and secret-looking names in `env.set`; use `env.secrets` bindings for those child environment variables instead.
    - Merge project and system config into effective runners by runner name, with system scalar values replacing project scalar values and system map keys overriding project map keys.
    - Preserve source metadata for validation and diagnostics so each effective runner can report which layer supplied or overrode each field.
    - Export named TypeScript interfaces or inferred aliases for project, system, and effective runner config so runtime, CLI, API, and Web UI serialization code can share the vocabulary.
    - Add parser/loader tests for omitted runner files, project-only portable values, system-only runners, system-over-project overrides, invalid project harness logic, invalid project secret-looking env values, invalid missing effective `kind`, invalid missing effective `adapter`, invalid enum values, and preservation of existing config behavior.

    Why:
    kspec needs a durable layered storage format for execution harnesses before agents, dispatch, CLI, daemon, or UI code can reference them consistently. The repo layer should carry portable project values only; local system config owns machine-specific harness mechanics and credentials.

    How:
    - Keep existing `kspec.config.yaml` behavior unchanged. Do not add runner configuration to `src/parser/config.ts` except for any shared helper plumbing needed to locate the project root.
    - Prefer a dedicated loader module over embedding runner config in the root manifest. The chosen sidecar keeps operational runner values separate from behavioral kspec items while remaining repo-managed in the shadow branch.
    - Use Zod schemas for both layers and include a custom project-layer validator that blocks known secret/API-key names.
    - Keep secret values out of every schema shape. `env.secrets` entries name sources only; they must not include fields named `value`, `token`, `api_key`, or `secret`.
    - Do not parse, accept, or partially validate a `headed_acp_sidecar` runner kind in this plan. A future headed sidecar implementation must add its own kind, loopback binding rules, hook/log ingestion contract, and security tests in a separate reviewed plan.
    - Add or update tests in the existing parser/config test area. If no narrow suite exists, create `tests/runner-config.test.ts` using temp project and temp user-config fixtures.
    - Use system-config-relative or absolute path validation for `runtime.cache_dir`; do not resolve or create runtime directories in the parser task.

    Testing:
    - `npm test -- --fresh tests/runner-config.test.ts`
    - `npm run typecheck`

    Covers: @agent-runner-configuration ac-named-runners-loaded, ac-project-runner-storage-is-repo-managed, ac-system-runner-storage-is-local, ac-system-overrides-project-values, ac-project-layer-blocks-harness-logic, ac-project-layer-blocks-known-secret-keys, ac-effective-runner-kind-and-adapter-required; @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret, ac-secret-env-names-use-bindings, ac-secret-bindings-system-only, ac-secret-values-not-stored-inline

- title: Add agent runner metadata and CLI mutation support
  slug: task-agent-runner-meta-cli
  priority: 1
  tags: [agents, meta, cli, runners]
  spec_ref: "@agent-runner-configuration"
  depends_on:
    - "@task-runner-config-schema-types"
  description: |
    What:
    - Add optional `runner: string` to `AgentSchema` in `src/schema/meta.ts`.
    - Update loaded agent types so `runner` is available everywhere an agent definition is consumed.
    - Update `kspec meta add agent` and `kspec meta set <agent>` surfaces to set and clear runner references.
    - Preserve existing `adapter` behavior for agents without `runner`.
    - When an agent has both `runner` and `adapter`, store both fields but document and display that runner takes invocation precedence.
    - Update `kspec agent list` human-readable and JSON output so it includes `runner` when present and still includes `adapter` for backward compatibility.
    - Add tests for parsing legacy agents, parsing runner-backed agents, setting a runner, clearing a runner, and preserving unrelated agent fields during runner updates.

    Why:
    Agents need a stable pointer to the execution harness while existing projects and default agents continue to rely on the legacy adapter field.

    How:
    - Follow existing patterns for `adapter`, `auto_approve`, `budget`, and `session` fields in meta schema and CLI update code.
    - Do not validate the referenced runner name in schema parsing; missing-runner validation belongs to the runtime resolver, dispatch preflight, and `kspec agent runners validate` surfaces.
    - Do not migrate existing agent records in this task.
    - Use `@agent-definition-schema` as the existing adjacent contract when adding AC annotations in code or tests.

    Testing:
    - `npm test -- --fresh tests/meta-agent-schema.test.ts tests/cli-agent.test.ts`
    - `npm run typecheck`
    - `kspec validate --refs --warnings-ok`

    Covers: @agent-runner-configuration ac-agent-runner-reference, ac-adapter-field-backcompat, ac-runner-precedence-over-adapter; @runner-operator-surfaces ac-agent-set-updates-runner, ac-agent-list-shows-runner; existing @agent-definition-schema ac-runner-field-accepted, ac-meta-set-runner-preserves-fields, ac-8 default compatibility update

- title: Implement the runner resolver and invocation contract
  slug: task-runner-resolver-invocation-contract
  priority: 1
  tags: [agents, runtime, invocation, runners]
  spec_ref: "@runner-resolution-and-preflight"
  depends_on:
    - "@task-runner-config-schema-types"
    - "@task-agent-runner-meta-cli"
  description: |
    What:
    - Add a runner resolver module such as `src/agents/runners.ts` that exports a `resolveRunnerInvocation(...)` function.
    - The resolver input must include the agent definition, effective runner registry, invocation cwd, session id, auto-approve setting, and base invocation env.
    - The resolver output must include at minimum:
      - `runnerId`: configured runner name or a stable legacy implicit runner id.
      - `adapterId`: resolved adapter id or package reference.
      - `adapter`: the `AgentAdapter` spawn contract.
      - `cwd`: invocation cwd.
      - `env`: complete runner-scoped env overlay for the adapter process.
      - `extraArgs`: auto-approve or runner args to append.
      - `diagnostics`: redacted selected-runner, source-layer, override, and selected-adapter details.
      - `cleanup`: optional async cleanup hook.
    - Update `src/agent-runtime/invocation.ts` so one-shot and dispatch invocations call the resolver before spawning instead of directly calling `resolveAdapter(agent.adapter)`.
    - Preserve legacy behavior by treating an agent without `runner` as an implicit `acp_process` runner around the existing adapter/default adapter resolution.
    - When both `runner` and `adapter` are present, use the runner's adapter for spawn, skill-formatting, auto-approve args, and session metadata.
    - Add `runner` and `adapter` to session metadata and `agent.dispatched` events for runner-backed invocations.
    - Keep existing `agent_type` or adapter metadata populated so older consumers continue to work.
    - Add resolver unit tests for legacy adapter agents, default adapter agents, system-only runner-backed agents, project-plus-system merged runner-backed agents, runner-overrides-adapter precedence, unknown runner failure, unknown built-in adapter package fallback, invalid project-layer config diagnostics, and invalid effective runner diagnostics.

    Why:
    Runtime code needs one source of truth for runner selection so the daemon, CLI, sessions, and dispatch all launch agents through the same harness contract.

    How:
    - Build the resolver as a pure or mostly pure function first; keep process spawning in `spawnAndInitialize`.
    - Return typed errors with machine-readable reason codes for unknown runner, invalid adapter, invalid runtime, missing secret, and preflight failure.
    - The resolver must never forward prompt content to an adapter; it only prepares a spawn contract.
    - Keep adapter-specific skill reference rewriting keyed off the resolved `adapterId`.

    Testing:
    - `npm test -- --fresh tests/agent-runner-resolver.test.ts tests/agent-invocation.test.ts`
    - `npm run typecheck`

    Covers: @runner-resolution-and-preflight ac-one-shot-uses-runner-resolution, ac-invalid-runner-blocks-before-prompt, ac-session-metadata-records-runner, ac-dispatched-event-records-runner; @agent-runner-configuration ac-adapter-field-backcompat, ac-runner-precedence-over-adapter; @runner-invocation-semantics ac-skill-formatting-uses-resolved-adapter, ac-auto-approve-from-resolved-contract; existing @dispatch-event-payload runner-backed invocation metadata update

- title: Build runner environment and secret resolution boundaries
  slug: task-runner-env-secret-boundary
  priority: 1
  tags: [agents, env, security, runners]
  spec_ref: "@runner-environment-secret-boundaries"
  depends_on:
    - "@task-runner-resolver-invocation-contract"
  description: |
    What:
    - Implement a `buildRunnerEnv(...)` helper consumed by the runner resolver.
    - Support `env.inherit` policies exactly as follows:
      - `ambient`: start from sanitized `process.env` for legacy compatibility.
      - `minimal`: start from an empty env and copy only runner `env.pass` names plus process variables required to spawn the configured command on the host platform.
      - `none`: start from an empty env except kspec-required invocation variables and literal runner settings.
    - Preserve existing stripping of nested-agent variables such as `CLAUDECODE` and `CLAUDE_CODE_SESSION` before any inheritance policy is applied.
    - Apply `env.set` after inheritance.
    - Resolve `env.secrets` from approved system-layer sources. The initial implementation must support `source: user_env` by reading the host environment variable with the same name as the target secret name.
    - If a required secret cannot be resolved, return a typed preflight failure before adapter spawn.
    - Add kspec-required invocation variables, including `KSPEC_NO_DAEMON=1`, `KSPEC_SESSION_ID`, and `KSPEC_SHADOW_MUTATION_LOCK_FILE` when provided, after runner environment policy is applied.
    - Apply privacy defaults when `privacy.disable_nonessential_traffic` is true: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, and `DO_NOT_TRACK=1` unless the runner explicitly sets a different value in `env.set`.
    - Add a shared redaction helper for diagnostics that replaces secret values with a redaction marker in CLI output, session events, task notes, daemon responses, and Web UI payloads.
    - Replace or route existing `injectEnvForAdapter(...)` usage so session id injection is part of the resolved runner contract while preserving existing Claude/Codex harness-specific injection behavior.
    - Add tests for every inheritance mode, pass list behavior, literal overrides, required secret failure, optional secret omission, privacy default injection, explicit privacy override, nested-agent env stripping, and diagnostic redaction.

    Why:
    Headed and non-headed agent runtimes cannot rely on daemon ambient auth or user shell state. kspec needs an explicit boundary for credentials and configuration that is portable across daemon and dispatch contexts while keeping repo/project config free of harness secrets.

    How:
    - Keep secret values in local variables only long enough to populate the child process env.
    - Do not write secret values into project runner config, system runner config, session JSONL, task notes, review records, WebSocket events, or Web UI stores.
    - Tests must assert negative cases by checking absence of secret literals in serialized diagnostics and by verifying secret-looking keys are rejected from literal env values.
    - Do not change global `process.env` as part of a runner invocation.

    Testing:
    - `npm test -- --fresh tests/agent-runner-env.test.ts tests/agent-invocation.test.ts`
    - `npm run typecheck`

    Covers: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied, ac-env-set-overrides-allowed-values, ac-project-env-literals-are-non-secret, ac-secret-env-names-use-bindings, ac-secret-bindings-system-only, ac-secret-values-not-stored-inline, ac-required-secret-missing-blocks, ac-diagnostics-redact-secrets, ac-privacy-defaults-applied; @runner-invocation-semantics ac-session-env-injected-through-runner, ac-runner-cleanup-restores-state; existing @codex-acp-adapter-registration Codex session env and cleanup behavior update

- title: Add runner runtime version resolution and materialization
  slug: task-runner-runtime-version-isolation
  priority: 1
  tags: [agents, runtime, isolation, runners]
  spec_ref: "@runner-runtime-version-isolation"
  depends_on:
    - "@task-runner-resolver-invocation-contract"
  description: |
    What:
    - Implement runtime selection for runner configs that specify `runtime.executable`, `runtime.package`, or `runtime.version`.
    - Selection precedence must be:
      1. `runtime.executable` explicit path.
      2. Pinned `runtime.package` plus `runtime.version` materialized under runner-owned cache/storage.
      3. PATH fallback only when no explicit executable and no pinned runtime are configured.
    - Add a runner-owned cache/storage path resolver. Default storage must live under the project-scoped system runner storage area, not under the repo-managed project runner config or a global package manager location.
    - Implement pinned runtime materialization with staged download/extract/install, version probing, and atomic promotion of verified runtime state.
    - If materialization cannot be implemented generically for every package manager in this task, provide a package-manager strategy interface and implement a deterministic fake strategy for tests plus the concrete Node package strategy used by kspec adapter packages.
    - Fail closed if retrieval, extraction, promotion, executable discovery, or version probing fails.
    - Fail closed if the selected executable reports a version that does not match the configured pin.
    - Report selected source, cache identity, executable path or path hash, and resolved version in redacted diagnostics.
    - Add fake-binary and fake-package-manager tests that prove no writes occur outside the runner-owned cache/storage directory.

    Why:
    External agent CLIs can change behavior across releases and membership/account tiers. Runner-owned version resolution prevents host PATH drift from changing dispatch behavior silently.

    How:
    - Keep all materialization tests in temp project directories.
    - Do not run migration or runtime materialization tests against live `~/Projects/kynetic-spec` or `~/Projects/kynetic-spec-dispatch` checkouts.
    - Do not mutate global npm, bun, pnpm, system PATH, or user-level Claude/Codex config during tests.
    - Make executable version probing bounded by a timeout and surface typed diagnostics on timeout.

    Testing:
    - `npm test -- --fresh tests/agent-runner-runtime.test.ts`
    - `npm run typecheck`

    Covers: @runner-runtime-version-isolation ac-explicit-executable-precedence, ac-pinned-runtime-precedence, ac-runner-owned-runtime-storage, ac-global-installs-not-mutated, ac-version-mismatch-blocks, ac-materialization-failure-blocks, ac-runtime-diagnostics-identify-source

- title: Make dispatch preflight runner-aware
  slug: task-dispatch-runner-preflight
  priority: 1
  tags: [dispatch, agents, validation, runners]
  spec_ref: "@runner-invocation-semantics"
  depends_on:
    - "@task-runner-resolver-invocation-contract"
    - "@task-runner-env-secret-boundary"
    - "@task-runner-runtime-version-isolation"
  description: |
    What:
    - Replace dispatch preflight code that directly calls `getAdapter(agent.adapter)` with runner-aware validation.
    - Dispatch preflight must accept configured runners whose adapters resolve through the same path used by `resolveRunnerInvocation(...)`, including registered adapters and package-backed ACP adapters.
    - Dispatch preflight must reject unknown runner names, malformed runner configs, missing required secrets, runtime version mismatch, runtime materialization failure, and unspawnable adapter contracts before queueing or spawning an invocation.
    - When preflight rejects an agent for a task, log the reason with runner name and resolved adapter when available.
    - When preflight rejects a task-bound dispatch, add an actionable task note that names the agent and runner but redacts secret values.
    - Preserve existing behavior for legacy adapter-backed agents with no runner.
    - Add dispatch tests for valid runner-backed worker pickup, valid runner-backed reviewer pickup, unknown runner rejection, missing required secret rejection, runtime mismatch rejection, package-backed adapter acceptance, and legacy adapter compatibility.

    Why:
    Dispatch currently has a hardcoded adapter registry check that blocks ad-hoc or sidecar-backed adapters even when invocation code could launch them. Preflight and invocation need to agree.

    How:
    - Keep validation side-effect free unless the runner explicitly needs bounded preflight materialization for pinned runtime checks.
    - Use fake runners and fake package strategies in tests. Do not invoke real Claude, Codex, or network package downloads.
    - Verify failed preflight does not create an agent process, active invocation, or prompt event.

    Testing:
    - `npm test -- --fresh tests/agent-dispatch-engine.test.ts tests/agent-runner-resolver.test.ts`
    - `npm run typecheck`

    Covers: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution, ac-unknown-runner-blocks-before-spawn, ac-unknown-runner-reports-guidance; @runner-invocation-semantics ac-dispatch-preflight-accepts-configured-runners, ac-dispatch-preflight-rejects-invalid-runners; @runner-environment-secret-boundaries ac-required-secret-missing-blocks, ac-diagnostics-redact-secrets

- title: Expose runner validation and diagnostics in CLI surfaces
  slug: task-cli-runner-surfaces
  priority: 2
  tags: [cli, agents, diagnostics, runners]
  spec_ref: "@runner-operator-surfaces"
  depends_on:
    - "@task-agent-runner-meta-cli"
    - "@task-dispatch-runner-preflight"
  description: |
    What:
    - Update `kspec agent list` to show runner name, resolved adapter, and validation state for every agent. JSON output must include machine-readable `runner`, `adapter`, `resolved_adapter`, and `runner_validation` fields.
    - Update `kspec agent run --dry-run` so it reports the runner name, resolved adapter, environment policy summary, runtime source summary, and validation state without spawning an adapter process.
    - Add `kspec agent runners validate [--runner <name>] [--json]` so operators can validate all effective runners or one selected runner without running a prompt.
    - Document the new command in `kspec agent --help` and `kspec agent runners --help`.
    - Runner validation output must support human-readable and JSON modes and must identify project/system source layers plus system-over-project overrides without exposing raw secret material.
    - Error output must include actionable guidance for unknown runner, invalid adapter, invalid runtime, and missing required secret source.
    - Error output and JSON diagnostics must redact all secret values.
    - Add CLI tests for human output, JSON output, dry-run output, validation success, validation failure, and redaction.

    Why:
    Operators need to see how an agent will run before dispatch picks it up, especially when credentials and runtime pins differ from their shell environment.

    How:
    - Reuse the runner resolver in validation mode so CLI status matches real invocation behavior.
    - Do not spawn real external agent binaries in CLI surface tests; use mock adapters and fake runtime strategies.
    - Preserve existing `kspec agent list` fields so scripts that consume adapter information keep working.

    Testing:
    - `npm test -- --fresh tests/cli-agent.test.ts tests/agent-runner-cli.test.ts`
    - `npm run typecheck`

    Covers: @runner-operator-surfaces ac-agent-list-shows-runner, ac-runner-validation-human-output, ac-runner-validation-json-output, ac-runner-validation-exit-status; @runner-resolution-and-preflight ac-unknown-runner-reports-guidance; @runner-environment-secret-boundaries ac-diagnostics-redact-secrets

- title: Add runner fields to daemon API and dispatch status payloads
  slug: task-daemon-api-runner-surfaces
  priority: 2
  tags: [daemon, api, agents, runners]
  spec_ref: "@runner-operator-surfaces"
  depends_on:
    - "@task-dispatch-runner-preflight"
    - "@task-cli-runner-surfaces"
  description: |
    What:
    - Update daemon agent-definition responses so each agent includes runner name, configured adapter, resolved adapter, and redacted runner validation diagnostics.
    - Update dispatch status responses so active and queued invocations include runner name when present and resolved adapter identity.
    - Update WebSocket event payloads for agent dispatched/started/failed/status updates if those payloads expose adapter or invocation details today.
    - Ensure legacy clients that only read the adapter field continue to receive an adapter identity.
    - Add API tests for runner-backed agents, legacy adapter-backed agents, invalid runner diagnostics, active invocation status, queued invocation status, and secret redaction.
    - If shared API response TypeScript types exist, update them in the same task.

    Why:
    The Web UI and external automation should not infer runner state from raw config files. Daemon payloads need to expose the same resolved runner information that CLI users see.

    How:
    - Locate the existing agent and dispatch status endpoint handlers before editing response types.
    - Keep diagnostics bounded and redacted; do not send full child process env maps to clients.
    - Add compatibility assertions that existing adapter fields remain populated for old consumers.

    Testing:
    - `npm test -- --fresh tests/daemon-agent-api.test.ts tests/agent-dispatch-api.test.ts`
    - `npm run typecheck`

    Covers: @runner-operator-surfaces ac-daemon-agent-api-includes-runner, ac-daemon-dispatch-active-api-includes-runner, ac-daemon-dispatch-queued-api-includes-runner; @runner-resolution-and-preflight ac-session-metadata-records-runner, ac-dispatched-event-records-runner; @runner-environment-secret-boundaries ac-diagnostics-redact-secrets

- title: Update Web UI agent and dispatch surfaces for runners
  slug: task-web-ui-runner-surfaces
  priority: 3
  tags: [web-ui, agents, dispatch, runners]
  spec_ref: "@runner-operator-surfaces"
  depends_on:
    - "@task-daemon-api-runner-surfaces"
  description: |
    What:
    - Update `packages/web-ui/src/routes/agents/+page.svelte` and the agent components under `packages/web-ui/src/lib/components/agents/` so runner-backed agents show runner name and resolved adapter identity.
    - Update `AgentCard.svelte` to display runner validation state and redacted diagnostic summaries when the daemon reports them.
    - Update `ActiveInvocationRow.svelte` and dispatch status components so active and queued invocations show runner identity when present.
    - Update `AgentEditForm.svelte` so users can set or clear the runner field without editing raw YAML and without being forced to change the adapter field.
    - Preserve legacy adapter display for agents that do not have a runner.
    - Add Web UI unit/component tests or E2E coverage for runner-backed agent display, legacy adapter display, edit-form runner set/clear behavior, invalid runner diagnostic display, and secret redaction.

    Why:
    The Web UI is an operator surface for dispatch and agent health. Runner-backed agents must be visible and editable there so operators do not need to cross-check YAML while debugging automation.

    How:
    - Use API-provided resolved fields; do not parse kspec.config.yaml in the browser.
    - Use existing Svelte 5 patterns in the agents route and components.
    - Do not display raw env maps or secret source values beyond non-secret names and redacted status.
    - Use `goto()` from `$app/navigation` if this task changes URL state.

    Testing:
    - `npm test -- --fresh packages/web-ui/tests/e2e/agents.spec.ts`
    - `npm run typecheck`
    - `npm run check`

    Covers: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner, ac-web-ui-active-invocations-include-runner, ac-web-ui-queued-invocations-include-runner, ac-web-ui-agent-edit-supports-runner, ac-daemon-agent-api-includes-runner, ac-daemon-dispatch-active-api-includes-runner, ac-daemon-dispatch-queued-api-includes-runner; @runner-environment-secret-boundaries ac-diagnostics-redact-secrets

- title: Document runner configuration and migration path
  slug: task-document-runner-config-migration
  priority: 3
  tags: [docs, agents, config, runners]
  spec_ref: "@agent-runner-configuration"
  depends_on:
    - "@task-cli-runner-surfaces"
    - "@task-web-ui-runner-surfaces"
  description: |
    What:
    - Add user-facing documentation for the runner layer in the appropriate docs location for agent integration or configuration.
    - Include examples for:
      - legacy adapter-backed agent with no runner;
      - named `acp_process` runner defined in system config and referenced by an agent;
      - project runner config containing portable non-secret values only;
      - system runner config overriding project values for the same runner;
      - system runner config with minimal env inheritance, explicit pass list, required user-env secret binding, and privacy defaults;
      - pinned runtime selection with runner-owned cache storage under local system config;
      - agent definition that uses `runner` while retaining `adapter` only as legacy metadata.
    - Document migration guidance: existing projects do not need immediate changes; new projects should prefer runner references for adapter-specific auth/runtime settings; do not put secret values in either project or system runner config, and do not put harness logic or credential bindings in project runner config.
    - Document `kspec agent runners validate` and `kspec agent runners validate --json`, including output fields, exit-status behavior, and the meaning of common failure diagnostics.
    - Document that the full headed Claude Code sidecar is separate implementation scope; this plan provides the kspec runner contract it will plug into, but this plan accepts only the `acp_process` runner kind.
    - Update generated or static agent instructions only if the runner workflow changes what task workers or reviewers need to know.

    Why:
    Runner configuration adds a new operator-facing abstraction. Users need examples and migration guidance that make the security and compatibility model clear.

    How:
    - Keep docs generic to kspec. Do not reference private chat context, local credential values, or machine-specific paths.
    - Ensure every example uses placeholder secret names and redacted values.
    - If templates or skills are changed, run the required render/generate command and commit generated artifacts together.

    Testing:
    - `npm run check`
    - `kspec validate --refs --warnings-ok`

    Covers: @agent-runner-configuration ac-project-runner-storage-is-repo-managed, ac-system-runner-storage-is-local, ac-system-overrides-project-values, ac-adapter-field-backcompat; @runner-operator-surfaces ac-runner-validation-human-output, ac-runner-validation-json-output, ac-runner-validation-exit-status; @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret, ac-secret-env-names-use-bindings, ac-secret-bindings-system-only, ac-secret-values-not-stored-inline, ac-diagnostics-redact-secrets

- title: Add end-to-end runner compatibility and regression coverage
  slug: task-runner-compatibility-regressions
  priority: 3
  tags: [testing, agents, dispatch, runners]
  spec_ref: "@runner-invocation-semantics"
  depends_on:
    - "@task-web-ui-runner-surfaces"
    - "@task-document-runner-config-migration"
  description: |
    What:
    - Add an end-to-end compatibility test suite that exercises the runner layer across parser, meta, CLI, invocation, dispatch, daemon API, and Web UI boundaries using fake adapters and fake runtimes.
    - Cover these flows:
      - existing legacy agent with only `adapter` still runs through one-shot invocation;
      - existing legacy dispatch worker still passes dispatch preflight;
      - system-only runner-backed one-shot invocation records runner and resolved adapter in session metadata/events;
      - project-plus-system runner config merges with system overrides and reports source-layer diagnostics;
      - project runner config containing a known API key or harness logic field is rejected before any invocation;
      - runner-backed dispatch invocation queues and starts with runner diagnostics visible through daemon status;
      - invalid runner blocks before prompt forwarding and records actionable redacted diagnostics;
      - missing required secret blocks before spawn and no secret literal appears in any serialized output;
      - pinned fake runtime is selected over PATH and runtime mismatch blocks before spawn;
      - Web UI agents route renders runner-backed and legacy agents from daemon payload fixtures.
    - Add AC annotations in tests for the plan specs covered by each flow.
    - Keep all test projects, runner caches, fake package roots, and session directories inside temp directories.
    - Do not call real Claude, Codex, Droid, network package registries, or global package managers from this suite.

    Why:
    The runner layer cuts across storage, runtime, daemon, CLI, and UI. Focused unit tests are necessary but not sufficient to prevent regressions at the boundaries between those surfaces.

    How:
    - Prefer fake ACP adapters that speak the minimum protocol needed for existing invocation tests.
    - Use fake runtime strategy hooks introduced by earlier tasks rather than live package downloads.
    - Assert both positive behavior and absence of leaks or global mutations.
    - Include a final `kspec validate --completeness --warnings-ok` run after AC annotations are added.

    Testing:
    - `npm test -- --fresh tests/agent-runner-e2e.test.ts packages/web-ui/tests/e2e/agents.spec.ts`
    - `npm run typecheck`
    - `npm run check`
    - `kspec validate --refs --warnings-ok`
    - `kspec validate --completeness --warnings-ok`

    Covers: @agent-runner-configuration ac-named-runners-loaded, ac-project-runner-storage-is-repo-managed, ac-system-runner-storage-is-local, ac-system-overrides-project-values, ac-project-layer-blocks-harness-logic, ac-project-layer-blocks-known-secret-keys, ac-agent-runner-reference, ac-adapter-field-backcompat, ac-runner-precedence-over-adapter; @runner-resolution-and-preflight ac-one-shot-uses-runner-resolution, ac-dispatch-uses-runner-resolution, ac-unknown-runner-blocks-before-spawn, ac-session-metadata-records-runner, ac-dispatched-event-records-runner; @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret, ac-secret-env-names-use-bindings, ac-required-secret-missing-blocks, ac-diagnostics-redact-secrets; @runner-runtime-version-isolation ac-pinned-runtime-precedence, ac-version-mismatch-blocks; @runner-invocation-semantics ac-dispatch-preflight-accepts-configured-runners, ac-dispatch-preflight-rejects-invalid-runners; @runner-operator-surfaces ac-daemon-agent-api-includes-runner, ac-daemon-dispatch-active-api-includes-runner, ac-daemon-dispatch-queued-api-includes-runner, ac-web-ui-agent-cards-include-runner, ac-web-ui-active-invocations-include-runner, ac-web-ui-queued-invocations-include-runner
```

## Implementation Notes

### Boundary decisions

- Runner is the public config term. Internal code may call strategy classes harnesses, but user-facing YAML, CLI, API, and UI surfaces should say runner consistently.
- Runner config is layered. Project runner config belongs in the repo-managed shadow sidecar at `project.runners.yaml` in the shadow worktree root, visible from the main checkout as `.kspec/project.runners.yaml`, and is intentionally limited to portable, non-secret project-specific values. System runner config belongs at `<daemon-config-dir>/projects/<project-key>/runners.yaml`, where `<project-key>` is the full lowercase hex SHA-256 digest of the canonical absolute project root path after realpath normalization; it owns harness mechanics, local paths, credential source bindings, and runtime materialization settings.
- The project layer must not define harness logic. If a value selects how to run an adapter, how to materialize a runtime, how hooks are transported, or how secrets are sourced, it belongs in the system layer.
- System config overrides project config field-by-field for the same runner name. Validation and diagnostics should show source layers and override facts without showing raw secrets.
- Secret values must come from runtime secret sources such as user environment variables. Config stores secret references or bindings, not token values; project config additionally rejects known API key/token variable names and secret-looking literal keys.
- Existing agents with only `adapter` remain supported. This plan must not force a metadata migration or break default agents.
- A runner-backed agent may retain an `adapter` field for compatibility, but invocation uses the runner's adapter.
- The sidecar that maps a headed TUI to ACP is out of scope here. This plan supplies the kspec contract that such a sidecar uses: layered runner config, explicit env/secrets, runtime pinning, diagnostics, dispatch compatibility, and operator visibility. This plan intentionally accepts only the `acp_process` runner kind; a future sidecar kind must be introduced by a separate reviewed plan.

### Dependency ordering

1. Existing agent, event, and adapter specs are updated first so workers do not implement against stale implemented contracts.
2. Layered runner config schema and types establish the storage and merge vocabulary.
3. Agent meta and CLI mutation support allow agents to reference runners.
4. Runtime resolver makes one-shot invocation use effective runner contracts.
5. Env/secret and runtime-isolation tasks harden the resolved contract.
6. Dispatch preflight moves daemon automation onto the same resolver.
7. CLI, daemon API, and Web UI surfaces expose the resolved state to operators.
8. Documentation and end-to-end regressions close compatibility and migration gaps.

### Live-project safety

Runtime materialization, env injection, and migration/compatibility tests must use temp projects, disposable clones, fake adapters, and fake runtime caches. They must not run against live `~/Projects/kynetic-spec` or `~/Projects/kynetic-spec-dispatch` as mutation or migration targets. If a worker finds runner cache markers, generated configs, or partial runtime materialization in either live checkout while testing, stop and report the exact path before making further writes.

### Review focus

Reviewers should check that each task is executable without chat history, that no task leaves runner field names or env policies for a worker to invent, that every security-sensitive behavior has a test path, and that UI/API/CLI surfaces all carry the same redacted runner diagnostics.
