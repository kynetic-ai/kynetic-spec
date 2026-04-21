# Connecting Your Agent

This page covers connecting an AI coding agent to your kspec project so it can read your specs, follow your conventions, and work within the task lifecycle.

## How agent integration works

When you ran `kspec setup` in the previous step, kspec generated instruction files that your agent reads automatically:

- **`AGENTS.md`** — the entry point that references `kspec-agents.md`
- **`kspec-agents.md`** — generated instructions containing your project's conventions, workflows, and the task lifecycle
- **`.agents/skills/`** — detailed skill files for specific workflows like task work, reviews, and spec writing

Most AI coding agents load `AGENTS.md` (or `CLAUDE.md` for Claude Code) automatically when they start a session in your repository. No extra configuration is needed beyond what `kspec setup` already created.

## Agent-specific setup

### Claude Code

Claude Code reads `CLAUDE.md` and `AGENTS.md` automatically. After running `kspec setup`, verify the connection by starting Claude Code in your project directory and asking it:

```
What kspec tasks are ready?
```

The agent should run `kspec tasks ready` and report the results. If it does, the integration is working.

If Claude Code does not recognize kspec commands, re-run setup with the agent type specified:

```bash
kspec setup --agent claude-code
```

### Other agents

kspec supports several agent families. Run setup with the appropriate type:

```bash
# Cline
kspec setup --agent cline

# Cursor
kspec setup --agent cursor

# Windsurf
kspec setup --agent windsurf
```

Each agent type configures the instruction files in the format that agent expects. The underlying content is the same — only the delivery mechanism differs.

## Verify the connection

The simplest way to verify your agent is connected is to ask it to run a kspec command. Start your agent in the project directory and try:

```
Run kspec session start and show me the output.
```

If the agent executes the command and shows your project context, the integration is working. The output should include your project name, any active tasks, and suggested next actions.

You can also ask the agent to check project health:

```
Run kspec doctor and tell me if everything looks healthy.
```

A healthy project shows passing checks for the shadow branch, setup state, and manifest.

## What to do if it does not work

If your agent does not recognize kspec:

1. Make sure you ran `kspec setup` from the project root
2. Check that `AGENTS.md` exists in the repository root and references `kspec-agents.md`
3. Check that `kspec-agents.md` exists and is not empty
4. Restart your agent to pick up the new files

If the agent can read the files but does not follow kspec workflows, check that `.agents/skills/` contains rendered skill files. If the directory is empty, run:

```bash
kspec skill render
```

---

**Next:** [Your First Action](./your-first-action.md)
