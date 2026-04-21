# Your First Action

This page walks through creating a spec, deriving a task, and working it to completion. By the end you will have completed one full cycle of the kspec loop.

## Create a spec

A spec defines what you want to build. It lives under a module (your project's top-level module was created by `kspec init`). Find your module's slug:

```bash
kspec item list --type module
```

You should see at least one module, typically `@main`. Create a feature spec under it:

```bash
kspec item add --under @main \
  --title "Contributor guide" \
  --type feature \
  --slug contributing-guide
```

## Add acceptance criteria

Acceptance criteria describe the observable outcomes that prove the spec is satisfied. Add two criteria for the contributor guide:

```bash
kspec item ac add @contributing-guide \
  --given "a new contributor opens the repository" \
  --when "they look for setup and workflow guidance" \
  --then "a CONTRIBUTING.md file documents the steps to set up, make changes, and submit work"
```

```bash
kspec item ac add @contributing-guide \
  --given "the repository README exists" \
  --when "a contributor reads it" \
  --then "the README links to the contributor guide"
```

Inspect the finished spec to confirm everything looks right:

```bash
kspec item get @contributing-guide
```

## Derive a task

Create a task from the spec. This links the work to the spec's acceptance criteria:

```bash
kspec derive @contributing-guide
```

Check what tasks are now ready:

```bash
kspec tasks ready
```

You should see a task like `@task-contributing-guide` in the pending state.

## Start the task

Move the task into active work:

```bash
kspec task start @task-contributing-guide
```

Create a branch for the work:

```bash
kspec task branch @task-contributing-guide
```

This creates (or resumes) a deterministic branch named after the task, which reviewers and automated agents can find consistently. You do not need to invent a branch name yourself.

Add a note explaining your approach:

```bash
kspec task note @task-contributing-guide \
  "Writing CONTRIBUTING.md and linking it from README."
```

## Do the work

Create `CONTRIBUTING.md` in your repository root with the setup and workflow instructions for your project. Then add a link to it from your `README.md`.

After editing, review your work against the acceptance criteria:

```bash
kspec item get @contributing-guide
```

Check each criterion: Does the guide explain setup and contribution workflow? Does the README link to it? If yes, your implementation satisfies the spec.

## Commit with trailers

Commit your changes with task and spec trailers in the commit message:

```bash
git add CONTRIBUTING.md README.md
git commit -m "docs: add contributor guide

Task: @task-contributing-guide
Spec: @contributing-guide"
```

The `Task:` and `Spec:` trailers let kspec and reviewers trace commits back to the governing spec and task. You can find related commits later with `kspec log @task-contributing-guide`.

## Submit for review

When the work is complete, submit the task:

```bash
kspec task submit @task-contributing-guide
```

This moves the task to `pending_review`. A reviewer (human or agent) can now review the work against the acceptance criteria.

## Complete the task

After the work is reviewed and merged, close the loop:

```bash
kspec task complete @task-contributing-guide \
  --reason "Merged. Added contributor guide with spec/task linkage."
```

The task is now complete. You have defined a spec, derived a task, implemented the work, and closed the loop with a traceable completion reason.

---

**Next:** [Where to Go Next](./where-to-go-next.md)
