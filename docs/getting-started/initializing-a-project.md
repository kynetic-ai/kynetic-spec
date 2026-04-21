# Initializing a Project

This page walks through creating a kspec project in an existing Git repository. By the end you will have a working project with the shadow branch, agent configuration, and session context.

## Initialize kspec

Navigate to your Git repository and run:

```bash
kspec init
```

This command creates:

- **`kynetic.yaml`** — the project manifest at the repository root, containing the project name and a default top-level module.
- **`.kspec/`** — the shadow directory where all specs and tasks are stored.

If your repository does not have any commits yet, `kspec init` will create an initial commit for you.

## The shadow branch

kspec stores specs, tasks, and project metadata on a separate Git branch called **`kspec-meta`**. This is the "shadow branch." The `.kspec/` directory is a Git worktree that points to this branch.

This design means:

- Spec and task changes never appear in your main branch history
- Your code PRs stay clean — no YAML spec files mixed into diffs
- kspec commits to the shadow branch automatically when you run CLI commands

**The `.kspec/` directory is not a regular directory.** It is a Git worktree managed by kspec. The files inside it are real and readable, but you should treat them as managed state.

### Do not edit shadow state by hand

Never manually edit files inside `.kspec/`. Always use the `kspec` CLI to make changes. The CLI ensures proper validation, auto-commits to the shadow branch, and maintains consistency. Manual edits bypass these safeguards and can corrupt your project state.

### Health check and repair

If something goes wrong with the shadow branch — for example, after a failed rebase or a corrupted worktree — kspec provides commands to diagnose and fix it:

```bash
kspec shadow status
```

This shows the current state of the shadow branch: whether the worktree is connected, whether it is in sync with the remote, and whether there are any issues.

If the status shows problems, repair the worktree:

```bash
kspec shadow repair
```

This rebuilds the worktree connection without losing your spec data. For a broader health check that includes the shadow branch, setup state, and daemon status:

```bash
kspec doctor
```

## Run setup

After initializing, run the setup command to configure agent integration:

```bash
kspec setup
```

Setup performs several steps automatically:

- Detects your agent environment (or asks you to choose one)
- Installs hooks so your agent loads kspec instructions
- Renders skill files that give your agent detailed workflow knowledge
- Generates `kspec-agents.md`, the agent instruction file that `AGENTS.md` references

You can re-run `kspec setup` at any time to update the configuration. It is safe to run repeatedly.

## Check your session context

Start a session to see the current state of your project:

```bash
kspec session start
```

This shows your project summary, active tasks, and suggested next actions. It is a good command to run at the beginning of any work session to orient yourself.

## What you have now

After `kspec init` and `kspec setup`, your repository has:

| Item | Purpose |
|------|---------|
| `kynetic.yaml` | Project manifest |
| `.kspec/` | Shadow directory (worktree on `kspec-meta` branch) |
| `AGENTS.md` | Entry point for agent instructions |
| `kspec-agents.md` | Generated agent instructions with conventions and workflows |
| `.agents/skills/` | Rendered skill files for agent use |

Your project is ready for agent integration.

---

**Next:** [Connecting Your Agent](./connecting-your-agent.md)
