# Task Isolation, Review System, and Human-Agent Task Model

Working document — captures research, design thinking, and open questions from the 2026-03-10 session.

## Context

kspec dispatch runs multiple autonomous agents concurrently. Current gaps:

1. **Chain isolation** — Multi-step refactors (A → B → C via `depends_on`) have no branch affinity or interleaving protection
2. **Concurrent conflicts** — Agents share one working directory, rely on branch switching (fragile)
3. **No native review system** — All review goes through GitHub PRs, even when unnecessary
4. **No human-agent task hierarchy** — Agent tasks and human-visible work units are the same thing
5. **Planning is import-only** — No iterative editing of plans once they're in the system

---

## Part 1: Task Isolation

### Current State

| Mechanism | Does | Doesn't |
|-----------|------|---------|
| `depends_on` | Blocks scheduling until deps complete | No branch affinity — next task starts fresh |
| `shadowMutex` | Serializes `.kspec/` state writes | Doesn't isolate code work |
| Per-task branches | Agents create `feat/task-slug` branches | All agents share same working directory |
| `max_concurrent: 1` | One invocation per agent type | Doesn't help when worker + reviewer overlap |
| `session_id` | Advisory claim tracking | Not enforced |
| `clone-for-testing` | Creates isolated repo copy | Not used by dispatch |
| `spec_ref` / `tags` | Link tasks to spec areas | Not used for scheduling decisions |

### Industry Research

**Universal pattern: Worktrees, not locks.** Every major AI coding system uses git worktrees (or full VMs) for isolation. None use file locking.

- **Claude Code** — `--worktree` flag, Agent Teams use worktrees per agent
- **Cursor** — Background agents run in isolated Ubuntu VMs (cloud) or worktrees (local)
- **Codex** — Worktrees per agent on the backend
- **ccswarm** — Rust orchestrator, worktree per agent, merge queue
- **Overstory** — Worktrees + 4-tier conflict resolution (mechanical → AI-assisted → monitor)
- **Composio Agent Orchestrator** — Decomposes features into parallel tasks, spawns agents in isolation
- **GitButler** — Alternative: lifecycle hooks auto-sort edits into branches in a single working directory

**Cursor's failed experiments:** Tried file locking (agents held locks too long; 20 agents degraded to throughput of 2-3) and optimistic concurrency control (agents became risk-averse). Winning pattern: **hierarchical planning** — planner decomposes into architecturally non-overlapping tasks, workers execute in isolated worktrees.

**Stacked PRs (Graphite):** Automatic rebase cascade, stack-aware merge queue, per-stack CI. GitHub's native merge queue does NOT understand PR dependencies.

**Conflict-aware scheduling (Aviator):** Analyzes which files each PR touches, creates dynamic parallel queues — PRs touching disjoint areas merge independently.

### Proposed Approach: Three Layers

**Layer 1: Task Groups (chain affinity)** — Small effort

New `group` field on tasks. Tasks sharing a group get:
- Priority affinity: after completing one, check for next in group before unrelated work
- Branch inheritance: next task starts from predecessor's branch
- Optional exclusivity: don't interleave unrelated work while group has pending tasks

For chain tasks: local review between steps, full review only at the end (or on demand). No PR between chain steps — the chain produces one reviewable unit.

```yaml
group: z.string().optional()
group_position: z.number().optional()
group_final: z.boolean().optional()
```

**Layer 2: Worktree isolation** — Medium effort (in progress)

Each dispatch invocation gets its own git worktree. Work already in progress to make kspec aware of worktrees (looking up for proper shadow branch from within a worktree).

For chain tasks: share a worktree or base on predecessor's branch.

**Layer 3: Spec-aware scheduling** — Medium effort

Use `spec_ref` → parent module to predict code area overlap. Block concurrent dispatch of tasks whose specs share a module. Cheap to implement since the spec→module mapping already exists.

---

## Part 2: Native Review System

### The Idea

A kspec-native review process with its own data structure. Not just for code — for any artifact needing a review cycle (specs, plans, designs, code changes).

### What It Replaces / Complements

- **Today:** All code review goes through GitHub PRs. Local review (the skill) runs checks but doesn't produce a persistent review record.
- **Goal:** Review records live in kspec. When a GitHub PR is used, the record mirrors what's posted there. When no PR exists (chain tasks, local work), the review record IS the review.

### Review Record — What to Track

- **Subject:** What's being reviewed (task ref, spec ref, branch, commit range, arbitrary artifact)
- **Status:** pending, in_progress, approved, changes_requested, rejected
- **Comments:** Structured (file/line for code, section for specs) and general
- **History:** Status changes with timestamps and who/what made them
- **Verdicts:** Per-reviewer approval/rejection with reasons
- **External links:** GitHub PR URL when one exists (for mirroring)

### Open Questions

- Does the review record live on the shadow branch alongside tasks?
- How does it relate to the existing `review_url` and `pending_review` status on tasks?
- Should automated checks (local-review, CI) produce structured results in the review record?
- How granular are comments — file:line level? Or higher-level findings?

---

## Part 3: Branch Topology and Dev Branch

### The Idea

```
main ← human-gated, ships to users
  ↑ (merge when human approves)
dev ← agents merge here freely after review passes
  ↑ (merge after local/automated review)
feat/task-* ← per-task branches
```

### Key Properties

- **`main`** is protected — only merged to via human-approved process
- **`dev`** (or `integration`, `next`, whatever) is where agent work lands after passing review
- **Task branches** are created per-task (or per-group for chains), merge to dev
- Branches tracked in kspec — persisted, protected during active work, cleaned up after merge

### Open Questions

- Single `dev` branch or per-human-task integration branches?
- How do concurrent human tasks interact on `dev`?
- Does `dev` get CI? Or only when merging to main?
- How does this interact with worktree isolation? (worktrees would branch from dev, not main?)

---

## Part 4: Human-Agent Task Hierarchy

### The Idea

Two tiers of tasks:

**Agent tasks** (what we have today):
- Granular, spec-derived
- Worked on by autonomous agents
- Produce code changes, test additions, etc.

**Human tasks** (new):
- Higher-level, less granular
- Aggregate multiple agent tasks into a reviewable unit
- What the user actually sees and acts on
- Dependent on all sub-tasks completing

### The "Ship to Human" Package

When all agent sub-tasks for a human task complete, produce a review package:
- What changed (diff summary, not raw diff)
- How to test it and what to test
- Behavioral changes explained in user terms
- Test results / coverage summary
- Links to relevant specs and ACs

### Example Flow

```
Human Task: "Add user authentication"
  ├── Agent Task 1: Implement auth schema
  ├── Agent Task 2: Add login endpoint
  ├── Agent Task 3: Add session management
  ├── Agent Task 4: Write tests
  └── Agent Task 5: Update docs

Each agent task:
  work → local review (review record) → merge to dev

When all complete:
  Human task produces review package
  → Human reviews on dev branch
  → Approve → merge dev to main
```

### Relationship to Existing Schema

Current task schema has no parent/child hierarchy beyond `depends_on`. Options:
- Add `parent_task` ref to agent tasks pointing to human task
- Use `group` for both chain affinity and human-task grouping
- New `human_task` item type with different fields (summary template, test instructions, etc.)

### Research Needed

What are others doing for AI-generated review packages?
- GitHub Copilot PR summaries
- Graphite stack summaries
- Factory.ai's presentation of completed work
- Changelog generation tools (changesets, semantic-release, etc.)
- How do teams handle "what changed" communication for large feature branches?

---

## Part 5: Iterative Planning

### The Problem

Current plan workflow is import-only: write a structured document, `kspec plan import`, done. No way to iteratively edit a plan once it's in the system without manually running CLI commands for each change.

### The Idea

Plans should be editable artifacts with round-trip capability:

```bash
# Export plan to editable file
kspec plan export @plan-ref --output /tmp/plan-edit.yaml

# User/agent edits the file...

# Import changes back (kspec diffs against current state)
kspec plan update @plan-ref --from /tmp/plan-edit.yaml

# History tracked via shadow branch git history
kspec plan history @plan-ref
```

### Why This Enables Everything Else

The isolation, review, and human-task designs described above are themselves plans that need iterative refinement. If we can make planning iterative first:

1. Write these designs as kspec plans
2. Iterate on them with easy export/edit/import cycles
3. Use shadow branch git history for diffs and tracking
4. When ready, import to create specs and tasks

This makes the planning tool the foundation for everything else.

### Design Considerations

- **Export format:** Should be the same structured YAML/markdown used for import
- **Diff handling:** kspec can diff exported vs current state to show what changed
- **Conflict resolution:** If specs/tasks were already created from the plan, how do edits propagate?
- **Granularity:** Can you edit just the specs section? Just one task? Or always the whole plan?

---

## Part 6: Dispatch Serialization Bottleneck (2026-03-11 investigation)

### Finding

The dispatch engine runs only **one invocation at a time globally**, even though per-agent `max_concurrent` should allow worker + reviewer to run in parallel.

**Root cause:** `_spawnInvocation()` wraps the entire invocation in `shadowMutex.runExclusive()` (`dispatch.ts:~1078`). The mutex exists to prevent concurrent git operations on the shadow branch, but it's held for the full duration of the invocation — not just the brief moments when task state is written.

```
Timeline (current):
  [--- worker invocation (holds mutex) ---][--- reviewer invocation (holds mutex) ---]

Timeline (with scoped mutex):
  [--- worker invocation ---]  ← mutex only during kspec CLI calls
  [--- reviewer invocation ---]  ← can overlap with worker
```

### Impact on review clearing

`_drainQueues()` iterates agents in **definition order** from `kynetic.meta.yaml`. No cross-agent prioritization exists. If task-worker is defined before pr-reviewer, the worker always gets the mutex first when both have queued items.

Status precedence (`in_progress: 0, needs_work: 1, pending_review: 2, pending: 3`) only applies **within** a single agent's queue, not across agents. So a low-priority `task.ready` for the worker can block a higher-urgency `task.pending_review` for the reviewer simply by being drained first.

**Result:** PRs stack up because new work keeps getting spawned before reviews clear.

### What needs to change (two independent improvements)

**1. Scoped mutex (enables parallelism)**

Narrow the mutex from wrapping the entire invocation to wrapping only shadow branch mutations (kspec CLI calls inside `runInvocation`). This would let worker and reviewer run concurrently since their code work doesn't conflict — only their task state writes do.

Considerations:
- `runInvocation` calls `kspec task note`, `kspec task block`, etc. via `spawnSync` — these are the only shadow branch writers
- The invocation's code work (editing files, running tests) doesn't touch `.kspec/`
- With worktree isolation (Layer 2), code work is fully independent; scoped mutex is the complementary change for shadow branch access

**2. Post-invocation re-evaluation (fixes review starvation)**

**Problem:** When an invocation completes, `.then()` calls `_drainQueues()` — but this only drains what's already in the queues. It does NOT re-evaluate tasks on disk. Tasks that were already `pending_review` from earlier invocations only get re-enqueued by the 60-second reconciliation timer (`_reconcile()`). This creates a gap where:

1. Worker finishes → submits task A → pr-reviewer enqueued for A
2. Mutex releases → drain spawns reviewer for A
3. Reviewer finishes A → drain runs → **reviewer queue is empty** (tasks B and C in pending_review were consumed by prior drain cycles)
4. Worker has a ready item → spawns worker instead
5. 60s later, reconciliation discovers B and C still pending_review → re-enqueues them
6. But worker is already running — B and C wait behind it

**Fix:** After each invocation completes, run `_evaluateAllTasks({ skipIfActive: true })` (a mini-reconciliation) before draining. This ensures all current pending_review tasks are in the queue before the drain loop decides what to spawn next. Effectively the `.then()` callback should match what `_reconcile()` does, not just `_drainQueues()` alone.

**Impact:** With pr-reviewer first in agent definition order (already applied) + post-invocation re-evaluation, reviews would be drained before new work whenever pending_review tasks exist on disk.

**3. Agent definition order (applied, partial fix)**

Reordered pr-reviewer before task-worker in `kynetic.meta.yaml` so the drain loop checks reviewer slots first. This only helps when both queues have items — which requires fix #2 to work reliably.

**4. Longer-term: unified cross-agent queue**

Replace per-agent queues with a single priority queue sorted by status precedence. `pending_review` (precedence 2) would naturally drain before `pending` (precedence 3) regardless of agent. This eliminates the need for agent definition ordering.

### Relationship to other layers

| Layer | How it helps |
|-------|-------------|
| Post-invocation re-eval (#2) | **Immediate fix** — ensures reviews are visible to drain loop |
| Agent ordering (#3) | Ensures reviewer drains first when queue is populated |
| Scoped mutex (#1) | Enables true parallelism — reviewer and worker run concurrently |
| Worktree isolation (Layer 2) | Eliminates code-level conflicts; scoped mutex becomes safe |
| Task groups (Layer 1) | Group affinity means fewer context switches between worker/reviewer |
| Spec-aware scheduling (Layer 3) | Reduces conflicts further, making parallel dispatch safer |

The post-invocation re-evaluation (#2) is the **smallest fix that addresses review starvation** within the current serial architecture. Scoped mutex (#1) + worktree isolation are needed for true parallelism.

---

## Priority / Sequencing

Suggested order based on dependencies:

1. **Iterative planning** — Enables everything else. Small, focused feature.
2. **Task groups (chain affinity)** — Solves immediate dispatch problem. Small schema + dispatch change.
3. **Review records** — Foundation for local review system. Medium effort, enables removing PR dependency.
4. **Worktree isolation** — Already in progress. Medium effort.
5. **Spec-aware scheduling** — Builds on existing spec→module mapping. Medium effort.
6. **Branch topology (dev branch)** — Requires review records to be useful. Medium effort.
7. **Human-agent task hierarchy** — Requires review records + branch topology. Larger effort.

Items 1-2 are immediately actionable. Items 3-5 can be parallelized. Items 6-7 depend on 3.

---

## Sources

### Multi-Agent Isolation
- Claude Code worktree support, Agent Teams
- Cursor Background Agents (isolated VMs)
- OpenAI Codex (worktrees per agent)
- ccswarm (github.com/nwiizo/ccswarm)
- Overstory (github.com/jayminwest/overstory) — 4-tier conflict resolution
- Composio Agent Orchestrator (github.com/ComposioHQ/agent-orchestrator)
- GitButler lifecycle hooks approach (blog.gitbutler.com/parallel-claude-code)

### Stacked PRs / Merge Queues
- Graphite — stack-aware merge queue, automatic rebase cascade
- Aviator Affected Targets — file-path-based parallel queues
- Mergify speculative merge queues
- ghstack, spr, git-town
- `git --update-refs` (Git 2.38+)

### Workflow Orchestration
- Temporal — durable execution, step-level recovery
- Inngest — step functions with persistent state
- Saga pattern (orchestration vs choreography)

### Key Insight from Industry
> "Isolation via branching, not locking. Speculative/optimistic execution. Durable step tracking."
> — Cross-cutting patterns from all surveyed systems
