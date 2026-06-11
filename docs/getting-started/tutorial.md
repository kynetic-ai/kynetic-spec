# Getting Started With kspec

This tutorial walks through the smallest useful `kspec` loop in a fresh repository:

1. install the CLI
2. initialize a project
3. define a spec with acceptance criteria
4. derive a task from that spec
5. do the work on a branch
6. submit it with task/spec-linked commit trailers
7. complete the task after merge

The example uses a documentation deliverable so you can try the whole flow in almost any repository without needing app-specific code.

## Before you begin

- Node.js 20+
- Git repository initialized locally
- `gh` installed if you want to open a pull request from the command line
- [Bun](https://bun.sh) installed if you plan to use the web dashboard (`kspec serve`)

If you need install variants, cloned-project setup, or troubleshooting, read [INSTALL.md](../../INSTALL.md) first.

## 1. Install and initialize

Install `kspec` globally:

```bash
npm install -g @kynetic-ai/spec
```

Then initialize it in the repository you want to manage:

```bash
cd your-project
git init
kspec init
kspec setup
kspec session start
```

What those commands do:

- `kspec init` creates the manifest and `.kspec/` shadow worktree.
- `kspec setup` configures agent/runtime integration and author attribution.
- `kspec session start` shows your current project context and the next useful actions.

## 2. Create a small but real spec

The default project created by `kspec init` includes a top-level module. In a fresh repo that module is usually `@main`.

Confirm the available modules:

```bash
kspec item list --type module
```

Create a feature spec for a contributor guide:

```bash
kspec item add --under @main \
  --title "Contributor guide" \
  --type feature \
  --slug contributing-guide
```

Add acceptance criteria that describe the outcome instead of the implementation details:

```bash
kspec item ac add @contributing-guide \
  --given "a new contributor opens the repository" \
  --when "they look for setup and workflow guidance" \
  --then "they can find a single contributor guide with the steps to set up, make changes, and submit work"

kspec item ac add @contributing-guide \
  --given "the repository README is the main entry point" \
  --when "a contributor starts there" \
  --then "the README links to the contributor guide"
```

Inspect the finished spec:

```bash
kspec item get @contributing-guide
```

That output is the contract for the implementation task you are about to create.

## 3. Derive a task from the spec

Create linked implementation work:

```bash
kspec derive @contributing-guide
kspec tasks ready
```

The derived task will usually be named `@task-contributing-guide`. Verify the exact ref from `kspec tasks ready` or `kspec task get`.

## 4. Start the task and isolate the branch

Move the task into active work:

```bash
kspec task start @task-contributing-guide
kspec task branch @task-contributing-guide
```

Add a note before or during the work so the task history explains what happened:

```bash
kspec task note @task-contributing-guide \
  "Writing CONTRIBUTING.md and linking it from README to satisfy @contributing-guide."
```

## 5. Implement the smallest valid change

Now make the real repository change. For this tutorial, that means:

- create `CONTRIBUTING.md`
- document setup, workflow, and PR expectations
- add a link to it from `README.md`

After editing, review your result against the spec instead of guessing:

```bash
kspec item get @contributing-guide
```

Ask:

- Does the guide explain setup and change submission?
- Does the README link to it?
- Would a new contributor actually succeed from the documented path?

If yes, validate and inspect your work:

```bash
kspec validate
git diff --stat
```

For deeper command references while you work, use the generated skills and agent instructions rather than duplicating everything into your own notes:

- [AGENTS.md](../../AGENTS.md)
- `.agents/skills/` after `kspec setup`

## 6. Commit with task and spec trailers

The commit message should describe the change and keep the task/spec linkage in the body:

```text
docs: add contributor guide

Add a first-pass CONTRIBUTING.md and link it from the README.

Task: @task-contributing-guide
Spec: @contributing-guide
```

Create that commit with normal git:

```bash
git add README.md CONTRIBUTING.md
git commit
```

Those trailers matter because they let `kspec` and reviewers connect shipped changes back to the governing task and spec.

## 7. Submit the task for review

When the implementation and commit are ready:

```bash
kspec task submit @task-contributing-guide
```

`kspec task submit` moves the task to `pending_review`. A reviewer (human or agent) picks it up, creates a kspec review record, and reviews the work. See the review skill for details.

## 8. Complete the loop after merge

After the work is reviewed and merged:

```bash
kspec task complete @task-contributing-guide \
  --reason "Merged. Added contributor guide with spec/task linkage."
```

At that point the spec-first loop is complete:

1. you defined the desired behavior in a spec
2. you derived work from that spec
3. you implemented and reviewed against acceptance criteria
4. you closed the task with a merge-linked completion note

## What to do next

Once the basic loop feels natural, expand into the parts of `kspec` that matter for larger projects:

- add more features and requirements with `kspec item add`
- capture vague ideas in `kspec inbox add`
- use `kspec plan` for multi-spec changes
- use `kspec session start` at the beginning of every work session
- use `kspec agents generate` so AI contributors inherit the same workflow conventions

For command details, prefer the built-in help and generated skill docs:

```bash
kspec --help
kspec task --help
kspec item --help
```
