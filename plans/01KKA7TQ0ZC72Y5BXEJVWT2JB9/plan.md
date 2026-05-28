# Lazy Shadow Sync

Replace the current always-pull-on-read pattern with conditional sync that checks for drift before pulling. Writes always sync. Reads only sync when local is behind or diverged from remote.

## Specs

```yaml
- title: Lazy Shadow Sync on Reads
  slug: shadow-lazy-read-sync
  type: requirement
  parent: "@shadow-sync"
  description: |
    Replace the blocking shadowPull() on every CLI/daemon read with a
    lightweight drift check. Only pull when the local shadow branch is
    behind or diverged from remote. Uses FETCH_HEAD mtime to avoid
    redundant git fetch calls, and compares ahead/behind counts when
    fetch data is fresh. FETCH_HEAD path is resolved via
    git rev-parse --git-path FETCH_HEAD from the same cwd used for
    fetch, ensuring correctness in worktree setups.
  acceptance_criteria:
    - id: ac-drift-check
      given: |
        A CLI read command runs (e.g. task list, item get) and
        shadow branch has remote tracking configured
      when: |
        initContext() initializes shadow state
      then: |
        Instead of unconditionally calling shadowPull(), a lightweight
        drift check runs first. If no drift detected, pull is skipped
        and the command proceeds with local state.
    - id: ac-fetch-head-location
      given: |
        The shadow branch is a git worktree of the main repository
      when: |
        Drift check needs to determine fetch freshness
      then: |
        FETCH_HEAD path is resolved via git rev-parse --git-path
        FETCH_HEAD from the worktree dir (the same cwd used for
        fetch operations). In worktrees, git fetch writes FETCH_HEAD
        to the worktree's git dir (e.g. .git/worktrees/-kspec/),
        not the common git dir. The drift check must stat the same
        file that fetch updates.
    - id: ac-fetch-head-freshness
      given: |
        FETCH_HEAD mtime (resolved per ac-fetch-head-location) is
        within the freshness threshold (derived from
        shadow.sync_interval config, default 60s)
      when: |
        Drift check runs
      then: |
        Git fetch is skipped. Drift is determined solely by comparing
        local HEAD against the cached upstream ref from the last fetch.
    - id: ac-fetch-when-stale
      given: |
        FETCH_HEAD mtime is older than the freshness threshold
        or FETCH_HEAD does not exist
      when: |
        Drift check runs
      then: |
        A git fetch is performed to refresh remote refs, then
        local HEAD is compared against upstream.
    - id: ac-fetch-timeout
      given: |
        Network is unavailable or git fetch exceeds 5 seconds
        during drift check
      when: |
        Drift check attempts a fetch due to stale FETCH_HEAD
      then: |
        The spawned git fetch process is killed (SIGTERM with
        SIGKILL fallback) and drift check proceeds with local
        state only.
    - id: ac-fetch-timeout-no-error
      given: |
        A fetch timeout or network failure occurs during drift check
      when: |
        The command continues execution
      then: |
        No error is surfaced to the user. The command proceeds as if
        no drift was detected.
    - id: ac-fetch-timeout-debug-log
      given: |
        A fetch timeout or network failure occurs during drift check
        and --debug-shadow flag or KSPEC_DEBUG=1 is set
      when: |
        Debug output is enabled
      then: |
        A debug-level log is emitted describing the fetch failure,
        visible via --debug-shadow for troubleshooting.
    - id: ac-pull-when-behind
      given: |
        Drift check detects local shadow branch is behind remote
        (remote has commits not present locally)
      when: |
        A read operation is about to proceed
      then: |
        shadowPull() is called to integrate remote changes before
        the read proceeds. Behavior after pull (conflict handling,
        warnings) remains unchanged.
    - id: ac-no-pull-when-ahead
      given: |
        Drift check detects local shadow branch is ahead of remote
        (local has unpushed commits, but remote has no new commits)
      when: |
        A read operation is about to proceed
      then: |
        No pull is performed. Local state is already up to date with
        all remote changes. The unpushed commits will be pushed on
        the next write or daemon sync cycle.
    - id: ac-pull-when-diverged
      given: |
        Drift check detects local and remote have diverged
        (both have commits the other does not)
      when: |
        A read operation is about to proceed
      then: |
        shadowPull() is called to integrate remote changes, using
        the existing rebase + merge driver strategy.
    - id: ac-upstream-ref-missing
      given: |
        Remote tracking is configured but the upstream ref does not
        exist after a successful fetch (e.g. first run, never pushed)
      when: |
        Drift check compares HEAD vs upstream
      then: |
        Drift check returns true (sync needed) as the safer default,
        allowing shadowPull() to handle the situation.
    - id: ac-no-drift-fast-path
      given: |
        Drift check determines local HEAD matches upstream
        (zero behind, zero diverged)
      when: |
        initContext() completes
      then: |
        No pull is performed. Command proceeds immediately with
        local state. No network calls are made when FETCH_HEAD is
        fresh and refs match.
    - id: ac-session-start-always-pulls
      given: |
        User runs kspec session start and remote tracking is configured
      when: |
        initContext() runs for session start
      then: |
        Session start bypasses the drift check and always performs a
        full shadowPull(), ensuring the user sees the latest remote
        state when beginning a work session.
    - id: ac-no-sync-env
      given: |
        KSPEC_NO_SYNC=1 environment variable is set
      when: |
        initContext() runs (regardless of syncMode — drift-check,
        always, or skip)
      then: |
        All pre-read sync is disabled, including drift check and
        unconditional pull for markAlwaysSync commands like session
        start. KSPEC_NO_SYNC takes highest precedence over all
        syncMode values.
    - id: ac-threshold-from-config
      given: |
        shadow.sync_interval is configured in kspec.config.yaml
      when: |
        Drift check determines FETCH_HEAD freshness threshold
      then: |
        Uses the configured sync_interval value (in seconds) as the
        freshness threshold. If not configured, defaults to 60 seconds.
    - id: ac-syncmode-propagation
      given: |
        A CLI command is dispatched via Commander
      when: |
        The preAction hook runs before the command handler
      then: |
        syncMode is determined centrally in the preAction hook based
        on command annotations (markMutating, markAlwaysSync) and
        stored as module-level state. Both the preAction initContext
        call (via maybeAutoStartDaemon) and the action handler
        initContext call read syncMode from this shared state.
        No per-command manual syncMode passing is required.
    - id: ac-syncmode-consume-once
      given: |
        initContext() is called multiple times within the same CLI
        command (e.g. preAction via maybeAutoStartDaemon, then
        action handler)
      when: |
        The second (or subsequent) initContext call runs
      then: |
        Only the first initContext call per command lifecycle
        executes the sync action (drift check, pull, or skip).
        Subsequent calls within the same command skip pre-read
        sync entirely, preventing double-pull.

- title: Always Sync on Shadow Writes
  slug: shadow-write-sync
  type: requirement
  parent: "@shadow-sync"
  depends_on:
    - "@shadow-lazy-read-sync"
  description: |
    Write operations always perform a full sync (pull then push) to
    ensure consistency. This preserves the current pull-rebase-before-push
    pattern in commitIfShadow/shadowPushAsync. Write commands skip the
    pre-read drift check in initContext since the write sync supersedes it.

    Depends on @shadow-lazy-read-sync for the syncMode mechanism.
  acceptance_criteria:
    - id: ac-write-always-syncs
      given: |
        A CLI write command commits to the shadow branch
        (task add, item set, etc.)
      when: |
        commitIfShadow() runs
      then: |
        The existing pull-rebase-before-push pattern executes
        regardless of drift check freshness. Writes never skip sync.
    - id: ac-write-skips-read-check
      given: |
        A mutating command triggers initContext() (either directly
        or via preAction hook)
      when: |
        initContext() initializes shadow state
      then: |
        The pre-read drift check is skipped for both initContext
        calls (preAction and action handler). The write path in
        commitIfShadow provides its own sync, so the pre-read
        check would be redundant overhead.

- title: Daemon Background Sync Pushes
  slug: shadow-daemon-push-sync
  type: requirement
  parent: "@shadow-sync"
  description: |
    Extend the daemon's periodic ShadowSyncScheduler to also push
    after pulling, ensuring local commits are propagated at the
    sync interval rather than only on fire-and-forget after writes.

    Orthogonal to @shadow-lazy-read-sync and @shadow-write-sync —
    can be implemented independently. The daemon's periodic fetch
    freshens FETCH_HEAD in the worktree git dir, which the CLI
    drift check benefits from for its fast path.
  acceptance_criteria:
    - id: ac-periodic-push
      given: |
        Daemon periodic sync interval elapses and there are local
        commits ahead of upstream
      when: |
        ShadowSyncScheduler.syncOnce() runs
      then: |
        After pulling, a push is attempted if local is ahead of
        remote. Push failure is non-fatal (logged, not thrown).
    - id: ac-daemon-freshens-fetch-head
      given: |
        Daemon periodic sync runs its fetch from the worktree dir
      when: |
        CLI commands run between daemon sync intervals
      then: |
        FETCH_HEAD in the worktree git dir is fresh from the
        daemon's last fetch. CLI drift checks (which resolve
        FETCH_HEAD from the same worktree dir) see it as fresh
        and skip redundant fetches during the interval.
```

## Tasks

derive_from_specs: true

## Implementation Notes

### Key files to modify

- `src/parser/yaml.ts` — `initContext()` lines 398-425: replace `shadowPull()` with drift check
- `src/parser/shadow.ts` — new `shadowNeedsSync()` utility (~50 lines), new `spawnGitWithTimeout()` helper
- `src/parser/shadow-sync-scheduler.ts` — add push after pull in `syncOnce()`; ensure fetch runs from worktree dir
- `src/cli/index.ts` — propagate syncMode through preAction hook via module-level state
- `src/cli/command-annotations.ts` — add `markAlwaysSync` / `getAlwaysSyncAnnotation` (mirrors existing `markMutating` pattern)
- `src/cli/commands/session/commands.ts` — annotate session start AND `kspec context` alias with `markAlwaysSync`

### FETCH_HEAD location: worktree git dir, not common dir

Codex experimentally verified: `git fetch` from a worktree writes FETCH_HEAD to the **worktree's git dir** (e.g. `.git/worktrees/-kspec/FETCH_HEAD`), NOT the common `.git/FETCH_HEAD`.

Use `git rev-parse --git-path FETCH_HEAD` from the worktree dir to get the correct path. This returns the worktree-specific path automatically. Both the drift check stat and the fetch must use the same cwd (worktreeDir) to ensure they reference the same FETCH_HEAD file.

**Important — fetch cwd alignment required:** Not all current fetch operations use the worktree dir:
- `fetchRemote()` runs from `projectRoot` → writes `.git/FETCH_HEAD` (wrong for drift check)
- `pullRebaseBeforePush` runs from `worktreeDir` → writes `.git/worktrees/-kspec/FETCH_HEAD` (correct)

The drift check stats the worktree-specific FETCH_HEAD. For daemon periodic sync to freshen the same file, the `ShadowSyncScheduler` must change its fetch to run from `worktreeDir` (or use a worktree-aware fetch helper). This is a required change in `shadow-sync-scheduler.ts` and potentially in `shadowPullImpl` where it calls `fetchRemote(projectRoot, ...)`. The fetch cwd must be `worktreeDir` everywhere the drift check depends on FETCH_HEAD freshness.

### Drift detection: ahead vs behind vs diverged

Use `git rev-list --left-right --count HEAD...@{u}` which returns `ahead\tbehind` in a single call. Only pull when `behind > 0` (behind or diverged). When `ahead > 0` but `behind == 0`, local is ahead-only — no pull needed, push will happen on next write or daemon sync.

### Cancellable git fetch with process kill

`runGitAsync` wraps `execFileAsync` and returns only `{stdout, stderr}` — no child process handle. Cannot kill a process you don't hold a reference to.

Create a new `spawnGitWithTimeout()` helper that uses `child_process.spawn` directly, retains the child handle, and kills it on timeout:

```typescript
async function spawnGitWithTimeout(
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    let promiseSettled = false;
    let processExited = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // Escalate to SIGKILL if process hasn't exited after grace period.
      // child.killed only means signal was sent, not that process exited.
      // Track actual exit via processExited flag set in 'close' handler.
      setTimeout(() => {
        if (!processExited) child.kill('SIGKILL');
      }, 1000);
      promiseSettled = true;
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      processExited = true;
      clearTimeout(timer);
      if (promiseSettled) return; // Already rejected by timeout
      promiseSettled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args[0]} exited ${code}: ${stderr}`));
    });
  });
}
```

Use this for the drift check fetch only. Other git operations continue using `runGitAsync`.

### Drift check implementation sketch

```typescript
async function shadowNeedsSync(
  worktreeDir: string,
  remoteName: string,
  thresholdMs: number,
): Promise<boolean> {
  // 1. Resolve FETCH_HEAD path for this worktree
  const { stdout: fetchHeadRaw } = await runGitAsync(
    worktreeDir, ['rev-parse', '--git-path', 'FETCH_HEAD']
  );
  const fetchHeadPath = path.resolve(worktreeDir, fetchHeadRaw.trim());

  // 2. Check freshness — if stale, fetch with timeout + process kill
  let fetchNeeded = true;
  try {
    const stat = await fs.stat(fetchHeadPath);
    fetchNeeded = (Date.now() - stat.mtimeMs) > thresholdMs;
  } catch {
    // No FETCH_HEAD — need to fetch
  }

  if (fetchNeeded) {
    try {
      await spawnGitWithTimeout(
        worktreeDir,
        ['fetch', remoteName],
        5000,
      );
    } catch {
      // Network failure or timeout — proceed with local state
      return false;
    }
  }

  // 3. Check ahead/behind — only sync when behind or diverged
  try {
    const { stdout } = await runGitAsync(
      worktreeDir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']
    );
    const [, behind] = stdout.trim().split('\t').map(Number);
    return behind > 0;
  } catch {
    // No upstream ref exists — force sync as safer default
    return true;
  }
}
```

### syncMode propagation: module-level state, not per-callsite args

**Problem:** `initContext()` is called twice per command:
1. `preAction` hook → `maybeAutoStartDaemon()` → `initContext()`
2. Command action handler → `initContext()`

Requiring every handler to pass `syncMode` is brittle. Instead, use module-level state set once in the preAction hook:

```typescript
// src/cli/sync-mode.ts

/** Controls pre-read sync behavior in initContext(). */
type ShadowSyncMode =
  | 'drift-check'  // Default for reads: lightweight check, pull only if behind/diverged
  | 'always'       // Session start: unconditional shadowPull()
  | 'skip';        // Mutating commands: no pre-read sync (commitIfShadow handles it)

let commandSyncMode: ShadowSyncMode | null = null;
let commandId: number = 0; // Monotonic counter scoping consume-once to a command lifecycle
let consumedForCommand: number = -1;

/**
 * Set sync mode for the current CLI command lifecycle.
 * Called once in preAction. Increments commandId to scope consume-once.
 */
export function setSyncMode(mode: ShadowSyncMode): void {
  commandSyncMode = mode;
  commandId++;
  consumedForCommand = -1;
}

/**
 * Consume sync mode for the current command.
 * Returns the real mode on first call per commandId, then 'skip' for
 * subsequent calls (prevents double-pull when preAction and action
 * handler both call initContext).
 *
 * Non-Commander callers (daemon, dispatch engine) that never call
 * setSyncMode() get null, signaling initContext to use its default
 * behavior (drift-check).
 */
export function consumeSyncMode(): ShadowSyncMode {
  // Non-Commander caller — no preAction set syncMode
  if (commandSyncMode === null) return 'drift-check';

  // Already consumed for this command lifecycle
  if (consumedForCommand === commandId) return 'skip';

  consumedForCommand = commandId;
  return commandSyncMode;
}
```

In `preAction` (src/cli/index.ts):

```typescript
.hook("preAction", async (thisCommand, actionCommand) => {
  const isMutating = getMutatingAnnotation(actionCommand);
  const isAlwaysSync = getAlwaysSyncAnnotation(actionCommand);

  if (isAlwaysSync) {
    setSyncMode('always');
  } else if (isMutating) {
    setSyncMode('skip');
  } else {
    setSyncMode('drift-check');
  }

  await maybeAutoStartDaemon();
});
```

`initContext()` calls `consumeSyncMode()` internally — no signature change needed. The existing `startDir?: string` parameter is unchanged.

Consume-once is scoped to a command lifecycle via `commandId` counter (incremented by `setSyncMode`). This prevents:
- Double-pull when `syncMode === 'always'` (session start): preAction initContext pulls, action handler initContext skips
- Stale state for non-Commander callers (daemon, dispatch): `consumeSyncMode()` returns `'drift-check'` when `setSyncMode` was never called, since `commandSyncMode` starts as `null`
- Cross-command bleed: each `setSyncMode` call resets the consume-once guard via new `commandId`

This avoids:
- Changing `initContext()` signature (many callers)
- Per-command manual passing (brittle)
- Process-global state leaking to non-CLI callers

### Existing spec ACs to update

- `@shadow-sync ac-2` — currently says "session start pulls remote changes before showing session context." Rewrite to: "session start always performs a full shadowPull regardless of drift check freshness, ensuring the user sees latest remote state when beginning a work session."

Note: `@config-shadow ac-11` is about write-path pull-rebase-before-push behavior — it remains accurate and does NOT need updating. The pre-read sync behavior change is fully captured in the new `@shadow-lazy-read-sync` spec.

### Spec dependencies

- `@shadow-lazy-read-sync` is the core spec — defines drift check, syncMode, and fast path
- `@shadow-write-sync` depends on `@shadow-lazy-read-sync` for the syncMode mechanism (explicit `depends_on`)
- `@shadow-daemon-push-sync` is orthogonal — can be implemented independently. Its fetch freshens FETCH_HEAD which helps the CLI fast path, but the CLI works without it (falls back to its own fetch when stale)

### What stays the same

- Fire-and-forget push after writes (`shadowPushAsync`)
- In-flight promise dedup for `shadowPull()`
- Merge driver for YAML conflicts
- `KSPEC_NO_SYNC` escape hatch
- `kspec shadow sync` explicit command
- `@config-shadow ac-11` (write-path pull-rebase-before-push)

### Known limitations

- TOCTOU: If daemon fetches while CLI stats FETCH_HEAD simultaneously, CLI may see an incomplete write. The window is sub-millisecond and the consequence is at most one stale read until the next check. Acceptable.
- The daemon's fetch freshens FETCH_HEAD for CLI commands on the same machine. If no daemon is running, CLI falls back to its own fetch when FETCH_HEAD is stale.
- Unrelated fetches (e.g., `git fetch` on main branch by the user) may update a different FETCH_HEAD (main repo's, not worktree's), so they do NOT interfere with the worktree drift check. This is a benefit of using the worktree-specific FETCH_HEAD path.
