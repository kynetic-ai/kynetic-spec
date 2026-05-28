# Plan: Per-Role Adapter Configuration for Ralph Loop

## Context

Ralph currently uses a single `--adapter` flag for both the worker agent (task coding) and the reviewer subagent (PR review). To support using different agents for different roles (e.g., Codex for coding, Claude for review), we need per-role adapter configuration.

The adapter infrastructure is solid — `resolveAdapter()` handles registered and ad-hoc adapters. Codex ACP exists. Session env injection for Codex is implemented but commented out.

**This plan produces updated specs with new ACs and a derived implementation task. It does NOT implement the changes.**

## Current Spec Coverage

| Spec | Covers | Gap |
|------|--------|-----|
| `@cli-ralph` (ac-17) | Single `--adapter` flag | No per-role selection |
| `@ralph-subagent-spawning` | Subagent spawning | Assumes same adapter as worker |
| `@ralph-adapter-validation` | Adapter startup validation | Only validates one adapter |
| `@session-creation-and-env-injection` | Env injection per agent type | Codex path commented out, no multi-adapter session |
| `@ralph-wrap-up` | Wrap-up subagent | No role adapter choice defined |

## Specs

```yaml
- slug: ralph-per-role-adapters
  title: "Per-role adapter selection for ralph loop"
  type: feature
  parent: "@cli-ralph"
  description: |
    Ralph supports separate adapter selection for worker, reviewer,
    and wrap-up roles. Each role can use a different ACP-compatible
    agent (e.g., Codex for coding, Claude for review).
  acceptance_criteria:
    - id: ac-1
      given: |
        ralph is invoked with --worker-adapter codex-acp
      when: |
        the task-work prompt is sent
      then: |
        the worker agent spawns using the codex-acp adapter
    - id: ac-2
      given: |
        ralph is invoked with --reviewer-adapter codex-acp
      when: |
        a pending_review task is processed by subagent
      then: |
        the review subagent spawns using the codex-acp adapter
    - id: ac-3
      given: |
        ralph is invoked with --adapter codex-acp but no role-specific flags
      when: |
        both worker and reviewer agents spawn
      then: |
        both use the codex-acp adapter (--adapter is the default for all roles)
    - id: ac-4
      given: |
        ralph is invoked with --adapter claude-agent-acp and --worker-adapter codex-acp
      when: |
        adapters are resolved
      then: |
        worker uses codex-acp, reviewer uses claude-agent-acp (role flag overrides --adapter)
    - id: ac-5
      given: |
        ralph is invoked with no adapter flags
      when: |
        adapters are resolved
      then: |
        both worker and reviewer default to claude-agent-acp
    - id: ac-6
      given: |
        --worker-adapter and --reviewer-adapter resolve to the same adapter ID
      when: |
        startup validation runs
      then: |
        the adapter is validated once (no duplicate validation or env injection)
    - id: ac-7
      given: |
        --worker-adapter is codex-acp and --reviewer-adapter is claude-agent-acp
      when: |
        the session is created
      then: |
        env injection runs for both adapter types and cleanup restores both on exit
    - id: ac-8
      given: |
        the loop exits (any reason)
      when: |
        the wrap-up agent spawns
      then: |
        wrap-up uses the worker adapter (it handles uncommitted code changes)
    - id: ac-9
      given: |
        --worker-adapter specifies a missing npm package
      when: |
        startup validation runs
      then: |
        ralph exits with error code 3 before creating a session, even if --reviewer-adapter is valid
    - id: ac-10
      given: |
        --dry-run is set with per-role adapter flags
      when: |
        prompts are displayed
      then: |
        both adapter IDs are shown in the dry-run output header
    - id: ac-11
      given: |
        --reviewer-adapter specifies a missing npm package
      when: |
        startup validation runs
      then: |
        ralph exits with error code 3 before creating a session, even if --worker-adapter is valid
    - id: ac-12
      given: |
        a ralph session uses different worker and reviewer adapters
      when: |
        the session is created
      then: |
        both adapter IDs are recorded in the session start event metadata

- slug: ralph-adapter-auto-approve
  title: "Per-adapter auto-approve arguments"
  type: feature
  parent: "@cli-ralph"
  description: |
    Each adapter may have different CLI flags for auto-approve/yolo mode.
    The adapter interface supports per-adapter auto-approve args so
    --yolo works correctly regardless of which adapter is used.
  acceptance_criteria:
    - id: ac-1
      given: |
        the adapter registry entry for codex-acp includes autoApproveArgs
      when: |
        ralph spawns codex-acp with --yolo enabled
      then: |
        the codex-specific auto-approve flags are passed to the spawn command
    - id: ac-2
      given: |
        ralph spawns claude-agent-acp with --yolo enabled
      when: |
        the agent process starts
      then: |
        --dangerously-skip-permissions is passed (existing behavior preserved)
    - id: ac-3
      given: |
        ralph is invoked with --no-yolo
      when: |
        any adapter is spawned
      then: |
        no auto-approve args are passed regardless of adapter type
    - id: ac-4
      given: |
        adapter auto-approve args are applied to the worker adapter
      when: |
        the reviewer adapter spawns separately
      then: |
        the reviewer adapter gets its own auto-approve args (no cross-role leakage)

- slug: codex-acp-adapter-registration
  title: "Register codex-acp in adapter registry"
  type: requirement
  parent: "@cli-ralph"
  description: |
    Add codex-acp as a first-class adapter in the built-in registry
    and enable the commented-out Codex env injection path.
  acceptance_criteria:
    - id: ac-1
      given: |
        the adapter registry is loaded
      when: |
        resolveAdapter("codex-acp") is called
      then: |
        a registered adapter is returned (not an ad-hoc npx fallback)
    - id: ac-2
      given: |
        a ralph session uses codex-acp adapter
      when: |
        injectEnvForAdapter is called
      then: |
        KSPEC_SESSION_ID is injected into Codex config (shell_environment_policy.set)
    - id: ac-3
      given: |
        a ralph session with codex-acp adapter exits
      when: |
        removeEnvForAdapter is called
      then: |
        the Codex config is restored to its previous state
```

## Tasks

derive_from_specs: true

## Implementation Notes

### Precedence rules
```
worker adapter = --worker-adapter ?? --adapter ?? "claude-agent-acp"
reviewer adapter = --reviewer-adapter ?? --adapter ?? "claude-agent-acp"
wrap-up adapter = worker adapter (always)
```

### Key files
- `src/cli/commands/ralph.ts` — CLI flags, adapter resolution, loop orchestration
- `src/agents/adapters.ts` — Adapter registry, `AgentAdapter` interface (add `autoApproveArgs`)
- `src/sessions/store.ts` — `injectEnvForAdapter` / `removeEnvForAdapter` (uncomment codex path, support dual injection)
- `src/ralph/subagent.ts` — Receives adapter param (already parameterized)
- `src/ralph/wrap-up.ts` — Receives adapter param (already parameterized)

### Same-adapter dedup
When worker and reviewer resolve to same ID, validation and env injection should run once. Track injected adapters in a Set to avoid duplicate setup/teardown.

### Adapter autoApproveArgs
Add optional `autoApproveArgs: string[]` to `AgentAdapter` interface:
- claude-agent-acp: `["--dangerously-skip-permissions"]`
- codex-acp: TBD (determine correct Codex ACP auto-approve flags)
- When `--no-yolo`: skip autoApproveArgs entirely
