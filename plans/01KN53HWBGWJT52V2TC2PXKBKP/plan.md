# Dispatch Mutation Service

**Status:** WIP Draft — investigation notes and direction, not yet spec/task-ready.

## Problem Statement

The agent invocation runner (`src/agent-runtime/invocation.ts`) performs shadow branch mutations (task notes, task blocks) by shelling out to the `kspec` CLI as a subprocess via `runKspecCli()`. This causes three concrete problems:

1. **Error opacity:** When the subprocess fails, stderr/stdout are often empty. The caller sees only a generic "exited non-zero" message with no diagnostic information about why the mutation failed.

2. **Error masking:** The `addTaskNote` and `blockTask` calls in the failure handler (catch block, ~line 1199) are not wrapped in try/catch. When they throw `DispatchMutationError`, it propagates out and replaces the original invocation error. The dispatch engine retries based on the note-write failure, not the actual invocation failure — and the real error is lost from operator-visible logs entirely.

3. **Daemon loop-back overhead:** When the daemon is running (which is always the case during dispatch), the subprocess path creates a circular call chain: daemon process → spawn Node subprocess → CLI parses args → CLI detects running daemon → HTTP request back to daemon → daemon calls library → response → subprocess exits → daemon reads exit code. The mutation takes a full round trip through process spawning, CLI argument parsing, daemon discovery, and HTTP serialization to end up calling the same library function that's available in-process.

## Current Architecture

### Daemon API routes (the correct pattern)

The daemon's HTTP route handlers (`packages/daemon/src/routes/tasks.ts`, etc.) use direct library calls for mutations:

```
Route handler
  → initContext(projectContext.path)
  → resolveTaskDataManager(ctx).mutateTask(ctx, ref, mutator, options)
  → commitIfShadow(ctx.shadow, operation)
  → entityCache.writeThrough("tasks")
  → pubsub.broadcast("tasks:updates", event, data, projectPath)
  → return response
```

This gives full error context (native exceptions with stack traces), cache consistency (write-through after mutation), real-time UI updates (WebSocket broadcast), and in-process mutex serialization (no file lock needed).

### Invocation runner (the problematic pattern)

The invocation runner (`src/agent-runtime/invocation.ts`) uses CLI subprocesses:

```
runKspecCli(["task", "note", taskRef, note], cwd, kspecCliPath, env)
  → execFileAsync(process.execPath, [kspecCliPath, "task", "note", ...])
  → [subprocess] CLI entry point parses args
  → [subprocess] CLI detects running daemon (daemon-proxy.ts)
  → [subprocess] HTTP POST to daemon API
  → [daemon] route handler calls library (mutateTask, commitIfShadow, etc.)
  → [daemon] returns HTTP response
  → [subprocess] CLI exits with code 0 or 1
  → [parent] reads exit code, stdout, stderr (often empty on failure)
```

The `runKspecCli` helper captures stdout/stderr/exit code but the callers (`addTaskNote`, `blockTask`) only use them to construct a generic error message. The `KSPEC_SHADOW_MUTATION_LOCK_FILE` env var is passed to the subprocess so the CLI entry point acquires a file lock before executing — this serializes shadow writes between the agent subprocess and the invocation runner, but adds lock contention and timeout risk.

### Where runInvocation is called from

The invocation runner is not exclusively a daemon-internal component. It's called from three places:

1. **`packages/daemon/src/routes/agent-dispatch.ts`** — dispatch route (inside daemon process)
2. **`src/agent-runtime/dispatch.ts`** — dispatch engine loop (inside daemon process)
3. **`src/cli/commands/agent.ts`** — `kspec agent run` one-shot CLI (standalone, no daemon required)

This means any solution must work both with and without a running daemon.

### Mutations the invocation runner performs

Currently two, both in the failure/timeout handling paths:

- **`addTaskNote(taskRef, message, cwd, kspecCliPath, env, strict)`** — writes a `[AGENT-FAIL]` or `[AGENT-TIMEOUT]` note to the task. Called at lines ~1049 (timeout) and ~1199 (failure).
- **`blockTask(taskRef, reason, cwd, kspecCliPath, env, strict)`** — blocks a task when consecutive failures exceed the retry limit. Called at line ~1214.

Both delegate to `runKspecCli` and throw `DispatchMutationError` when `strict` is true (which it is whenever a mutation lock file is configured, i.e., during dispatch).

### The `strict` flag behavior

`strict` is `Boolean(mutationLockFile)` — it's true during dispatch (where the lock file is always set) and false during one-shot `kspec agent run` (where there's no lock file). When strict is false, mutation failures are silently swallowed. When strict is true, they throw and (due to the error masking bug) replace the original error.

Neither behavior is ideal: silent swallowing loses the diagnostic info, and throwing masks the original error.

## Explored Alternatives

### Option 1: Internal HTTP call to daemon API

Replace `runKspecCli` subprocess calls with `fetch("http://localhost:${port}/api/...")` calls to the daemon's own API.

**Pros:**
- Minimal new code — API endpoints exist and handle commit + cache + broadcast
- Full error response (HTTP status, JSON body) instead of opaque exit code
- No subprocess overhead or daemon-proxy loop
- Cache and WebSocket consistency maintained automatically
- Mutation lock handled by daemon's in-process mutex, not file lock

**Cons:**
- Couples invocation runner to a running daemon — `kspec agent run` one-shot doesn't require a daemon, so needs a fallback (direct library call or mandatory daemon), splitting the code path
- Localhost HTTP still has serialization/TCP overhead for what is an in-process operation
- Port discovery plumbing needed (port file, pass in options)
- Circular dependency risk — daemon spawns invocations, invocations call back into daemon; potential for deadlock if HTTP handler blocks on something the invocation needs
- Error contract mismatch — daemon API shapes responses for web UI clients, invocation runner would need to interpret HTTP error shapes rather than catching native exceptions
- Testing requires a running daemon or HTTP mock layer

### Option 2: Shared mutation service (preferred)

Extract the mutate + commit + cache-invalidate + broadcast pattern into a service layer. Both daemon routes and the invocation runner call the same service. Cache and pubsub are optional dependencies — present when running in daemon, no-ops when standalone.

**Pros:**
- Single code path for all callers — daemon routes, invocation runner, and one-shot CLI all use the same mutation logic with no behavioral divergence
- In-process, zero overhead — direct function call, native error propagation, full stack traces
- No daemon dependency — works standalone for `kspec agent run`; cache/broadcast are optional enhancements, not requirements
- Testable in isolation — pass mock/no-op cache and pubsub, test mutation logic directly
- Eliminates the subprocess entirely — no `runKspecCli`, no file lock dance, no exit code parsing
- Natural error handling — thrown errors with full context, no serialization boundary losing details
- Forces cleanup of duplicate boilerplate — the commit + cache + broadcast sequence is currently copy-pasted across every daemon route handler; extracting it is independently valuable

**Cons:**
- More upfront work — need to define the service interface, extract from existing routes, wire dependency injection for cache/pubsub
- Scope creep risk — "extract a service layer" can expand into a large refactor if applied to all mutation types at once; needs discipline to start narrow and expand incrementally
- Cache/pubsub coupling decisions — the service needs to know about cache domains and broadcast topics; either takes explicit callbacks (flexible but verbose) or imports those concerns (simpler but tighter coupling)
- Two consumers with different needs — daemon routes do things like `syncSpecImplementationStatus` and multi-domain cache writes that are specific to certain transitions; the service interface needs to be flexible enough without becoming a god object
- Migration risk — daemon routes currently work; extracting their internals into a service means touching every route, which is a large blast radius

## Why Option 2

Option 1 is pragmatic but fundamentally the wrong abstraction — it replaces one inter-process boundary (subprocess) with another (HTTP) for operations happening within the same process. It also creates a hard dependency on the daemon for the one-shot path, which currently works standalone.

Option 2 is the architecturally correct answer because the invocation runner and daemon routes are performing the same logical operation (mutate task state on the shadow branch) and should share the same code path. The daemon-specific concerns (cache write-through, WebSocket broadcast) are side effects that belong behind an interface, not in the caller.

The scope risk is real but manageable. The narrowest useful starting point: extract just the mutations the invocation runner needs (`addTaskNote`, `blockTask`) into shared functions that accept optional cache/pubsub context. This gets the invocation runner off subprocesses without requiring a full daemon route refactor. Daemon routes can migrate to the same service incrementally.

## Spec Gap

The existing spec `@agent-invocation-lifecycle` ac-5 says:

> "the task receives a failure note"

It does not specify what happens when the failure note write itself fails. There is no AC covering diagnostic logging of failed shadow mutations during dispatch. A new AC should specify: when a dispatch-initiated shadow mutation fails, the mutation's failure details (error message, stderr, exit code where applicable) are logged to the dispatch/daemon log.

## Open Questions

- Should the mutation service own the shadow commit, or should the caller control commit boundaries? (Daemon routes sometimes use `skipCommit` to batch multiple mutations into one commit.)
- What's the right interface for optional cache/pubsub — callback functions, an event emitter, or an injected service object?
- Should `kspec agent run` (one-shot) auto-start a daemon to get cache/broadcast benefits, or is standalone-with-no-side-effects the right default?
- Are there other `runKspecCli` call sites beyond the invocation runner that should be audited? (Initial search found them only in `src/agent-runtime/invocation.ts`.)
- The `strict` flag conflates "are we in dispatch mode" with "should mutation failures throw." Should these be separate concerns?
