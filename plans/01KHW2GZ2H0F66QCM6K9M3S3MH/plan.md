# Unified Health Check Command (kspec doctor)

## Context

Three separate commands check different aspects of project health: `kspec shadow status` (worktree), `kspec setup --status` (agent environment), `kspec serve status` (daemon). Consumer projects have no single "is everything working?" command. Task `@01KHVMJ5` captured this need. This spec and task supersede `@01KHVMJ5`.

## Specs

```yaml
- slug: doctor-command
  title: "Unified Health Check Command"
  type: feature
  parent: "@cli"
  traits:
    - "@trait-json-output"
    - "@trait-semantic-exit-codes"
    - "@trait-error-guidance"
  description: |
    The `kspec doctor` command aggregates all health checks — shadow branch,
    agent setup, and daemon status — into a single unified report. Each check
    reports a severity (ok, warning, error). The overall verdict is healthy
    only when no errors exist. Warnings (e.g. daemon not running) do not
    cause a non-zero exit.

    Architecture: library function in src/parser/doctor.ts returns DoctorReport,
    CLI command in src/cli/commands/doctor.ts formats and outputs it. Daemon
    status logic extracted from serve.ts into a shared getDaemonStatus()
    to avoid duplication.
  acceptance_criteria:
    - id: ac-no-git-repo
      given: |
        the current directory is not inside a git repository
      when: |
        the user runs kspec doctor
      then: |
        prints a message that no git repository was found and
        exits with code 1
    - id: ac-not-initialized
      given: |
        kspec has not been initialized (no shadow branch, no .kspec/ directory)
      when: |
        the user runs kspec doctor
      then: |
        prints a clear message that kspec is not initialized, guides
        the user to run kspec init, and exits with code 1
    - id: ac-shadow-healthy
      given: |
        kspec is initialized and the shadow branch is healthy
      when: |
        the user runs kspec doctor
      then: |
        the shadow section shows branch exists, worktree exists,
        and worktree linked — each as a separate line with severity ok
    - id: ac-setup-agent-hooks
      given: |
        kspec is initialized
      when: |
        the user runs kspec doctor
      then: |
        the setup section shows detected agent type and hooks status
    - id: ac-setup-skills-agents-md
      given: |
        kspec is initialized
      when: |
        the user runs kspec doctor
      then: |
        the setup section shows skills rendered count, drift count,
        and kspec-agents.md freshness
    - id: ac-daemon-running
      given: |
        kspec is initialized
      when: |
        the user runs kspec doctor
      then: |
        the daemon section shows whether it is running, and if so
        its PID, port, and uptime
    - id: ac-daemon-unreachable
      given: |
        the daemon process is running (PID alive) but the health
        endpoint is unreachable (starting up, port conflict)
      when: |
        the user runs kspec doctor
      then: |
        daemon section shows running with PID but marks health
        endpoint as unreachable with warning severity
    - id: ac-daemon-not-running
      given: |
        the daemon is not running
      when: |
        the user runs kspec doctor
      then: |
        daemon section shows not running with severity warning
        (not error), since the daemon is optional
    - id: ac-overall-verdict
      given: |
        all health checks have completed
      when: |
        results are rendered
      then: |
        the output ends with an overall verdict — healthy if no
        errors exist, or issues found with counts of errors and
        warnings
    - id: ac-partial-init
      given: |
        the shadow branch exists but setup has not been run
        (no hooks, no skills rendered, no kspec-agents.md)
      when: |
        the user runs kspec doctor
      then: |
        shadow shows ok, setup shows missing items with error
        severity and guidance to run kspec setup, daemon shows
        its independent status
    - id: ac-staleness-unknown
      given: |
        kspec-agents.md staleness cannot be determined (no manifest,
        hash computation fails)
      when: |
        the user runs kspec doctor
      then: |
        setup section reports kspec-agents.md status as unknown
        with warning severity, not falsely as current
    - id: ac-json-output
      given: |
        the user runs kspec doctor --json
      when: |
        the command completes
      then: |
        output is a JSON object with shadow, setup, daemon, and
        overall keys including severity per check and healthy boolean
    - id: ac-exit-zero
      given: |
        the doctor command completes with zero errors (warnings ok)
      when: |
        the process exits
      then: |
        exit code is 0
    - id: ac-exit-one
      given: |
        the doctor command completes with one or more error-severity checks
      when: |
        the process exits
      then: |
        exit code is 1
```

## Tasks

```yaml
- slug: impl-doctor-command
  title: "Implement kspec doctor command"
  spec_ref: "@doctor-command"
  priority: 3
  tags:
    - cli
    - dx
```

## Implementation Notes

### Per-spec: @doctor-command

**Severity model:** Each check gets `ok | warning | error`. Shadow broken = error. Setup missing = error. Daemon not running = warning. Staleness unknown = warning. Exit 0 when no errors (warnings are fine). Exit 1 when any error exists.

**Library layer: `src/parser/doctor.ts` (new)**

Place alongside existing parser modules (`src/parser/shadow.ts`, `src/parser/yaml.ts`) rather than creating a new `src/lib/` directory. Follows existing project structure where non-CLI logic lives in `src/parser/`.

```typescript
interface CheckResult {
  name: string;
  severity: 'ok' | 'warning' | 'error';
  details: Record<string, unknown>;
  guidance?: string;
}

interface DoctorReport {
  shadow: CheckResult;
  setup: CheckResult;
  daemon: CheckResult;
  overall: { healthy: boolean; errors: number; warnings: number };
}

export async function getDoctorReport(projectRoot: string): Promise<DoctorReport>
```

Flow:
1. `getShadowStatus(projectRoot)` — if `!exists`, return early with not-initialized report
2. If shadow exists, run setup + daemon in parallel via `Promise.allSettled`
3. For setup: call `getSetupStatus(projectRoot)` — fix staleness bug (unknown, not false-current)
4. For daemon: call new `getDaemonStatus()` extracted from serve.ts
5. Compute overall: `healthy = (errors === 0)`

**Extract `getDaemonStatus()` from `serve.ts`**

Currently `statusServer()` in serve.ts (line 391) mixes data-gathering with output. Extract the data-gathering portion into a shared function (either in `pid-utils.ts` or a new `src/lib/daemon-status.ts`):

```typescript
interface DaemonStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  uptime: number | null;  // null if not reachable
  reachable: boolean;
  projects: Array<{ path: string; registeredAt: string; watcherStatus: string }>;
}
export async function getDaemonStatus(): Promise<DaemonStatus>
```

Include `projects` array to avoid regressing `serve status` output — `statusServer()` currently fetches this from `/api/projects`. Then refactor `statusServer()` to call `getDaemonStatus()` instead of doing its own PID/health fetching. Note: `readPort()` throws on missing/invalid port file — wrap in try/catch returning null.

**Fix `getSetupStatus` staleness false-positive**

In `setup.ts` lines 1106 and 1109, the status falls back to `"current"` when hash can't be checked. Change to `"unknown"` in those cases. Update `SetupStatus.agentsMd.status` type from `"current" | "stale" | "missing"` to `"current" | "stale" | "missing" | "unknown"` (line 965). Update the text renderer in setup.ts to handle the new `"unknown"` case.

**Extract setup status logic to avoid CLI coupling**

Rather than exporting `getSetupStatus` directly from the CLI command file (which imports commander, chalk, etc.), extract the pure status-gathering logic into `src/parser/setup-status.ts` (or `src/lib/setup-status.ts`). The CLI command file keeps its formatter and calls the extracted function. This avoids doctor.ts depending on a CLI command module.

**CLI layer: `src/cli/commands/doctor.ts` (new)**

Thin wrapper:
1. `getGitRoot()` — error if not git repo
2. Call `getDoctorReport(gitRoot)`
3. `output(report, formatDoctorReport)` for --json
4. Exit based on `report.overall.healthy`

**Registration:** Add to `src/cli/commands/index.ts` and wire in `src/cli/index.ts`.

**Display format:**
```
kspec doctor
════════════

Shadow Branch
  ✓ Branch exists
  ✓ Worktree exists
  ✓ Worktree linked

Agent Setup
  ✓ Agent: claude-code (high)
  ✓ Hooks: promptCheck, stop, preToolUse
  ✓ Skills: 12 rendered, 0 drifted
  ⚠ kspec-agents.md: unknown — could not determine freshness

Daemon
  ✓ Running (PID 12345, port 3456, uptime 2h 15m)

Overall: healthy (11 ok, 1 warning, 0 errors)
```

### Files to modify

| File | Change |
|------|--------|
| `src/parser/doctor.ts` | **New** — `getDoctorReport()` library function |
| `src/cli/commands/doctor.ts` | **New** — CLI command wrapper |
| `src/parser/setup-status.ts` | **New** — extracted `getSetupStatus()`/`SetupStatus` from CLI layer |
| `src/cli/commands/setup.ts` | Refactor to call extracted `getSetupStatus()`; fix staleness type |
| `src/cli/commands/serve.ts` | Extract `getDaemonStatus()` from `statusServer()` |
| `src/cli/pid-utils.ts` | Or put `getDaemonStatus()` here alongside `PidFileManager` |
| `src/cli/commands/index.ts` | Add export |
| `src/cli/index.ts` | Wire registration |

### Existing code to reuse

- `getShadowStatus()` — `src/parser/shadow.ts:267` (already exported)
- `PidFileManager` — `src/cli/pid-utils.ts:18`
- `output()` — `src/cli/output.ts`
- `EXIT_CODES` — `src/cli/exit-codes.ts`
- `getGitRoot()` — `src/parser/shadow.ts`

### Post-import actions

1. `kspec task complete @01KHVMJ5 --reason "Superseded by @doctor-command spec and @impl-doctor-command task"`
2. Set automation eligible on the new task

### Verification

1. `npm test` — unit tests for `getDoctorReport()` (mock subsystem functions)
2. `kspec doctor` — run in kynetic-spec repo, expect healthy
3. `kspec doctor --json` — verify JSON structure with severity fields
4. Create temp project with `kspec init` but no `kspec setup` — verify partial-init
5. Stop daemon → `kspec doctor` — daemon shows warning, overall still healthy
6. Break worktree link → `kspec doctor` — shadow shows error, overall unhealthy, exit 1
