import{_ as ce}from"./PPVm8Dsz.js";import{a as f,f as w}from"./DFEWOCvw.js";import{p as de,h as b,b as he,k as le,g as a,a as pe,c as k,s as _,e as c,r as p,u as O,n as ue,t as M}from"./B3e3Nrf3.js";import{d as ge,e as B,a as F,s as z}from"./rz93K_c4.js";import{b as me,i as R}from"./DEWxLQhM.js";import{r as fe,e as ke,i as we}from"./DOzdkxgi.js";import{h as ye}from"./Baxgz33B.js";import{a as ve}from"./DfUDaWrH.js";import{g as be}from"./D0JSlpiS.js";import{b as G}from"./DHfJ8rbS.js";import{S as xe}from"./DuszkC7R.js";import{X as Te}from"./DFwyzRMU.js";import{L as Ie}from"./qzTqjC0H.js";const Ae=["getting-started","guides","concepts","troubleshooting","release-notes"];function N(i){const s=i.path.indexOf("/");return s===-1?null:i.path.slice(0,s)}function je(i,s){const t=s.indexOf("/");let r;if(t===-1){if(!i.some(e=>e.path.startsWith(s+"/")))return i.filter(e=>N(e)===null);r=s}else r=s.slice(0,t);return i.filter(d=>N(d)===r)}function Je(i,s){if(!i.endsWith(".md"))return null;const t=s.lastIndexOf("/"),r=t===-1?"":s.slice(0,t),d=r?r.split("/"):[],e=i.split("/"),n=[...d];for(const y of e)if(!(y==="."||y===""))if(y===".."){if(n.length===0)return null;n.pop()}else n.push(y);const m=n.join("/").replace(/\.md$/i,"");return m.endsWith("/index")?m.slice(0,-6):m}function Qe(i,s){if(!i.endsWith(".md"))return null;const t=s.lastIndexOf("/"),r=t===-1?"":s.slice(0,t),d=["docs",...r?r.split("/"):[]],e=i.split("/"),n=[...d];for(const g of e)if(!(g==="."||g===""))if(g===".."){if(n.length===0)return null;n.pop()}else n.push(g);return n.join("/")}function Ze(i){const s=[],t=new Map;for(const e of i){const n=N(e);n===null?s.push(e):(t.has(n)||t.set(n,[]),t.get(n).push(e))}const r=[];for(const e of Ae){const n=t.get(e);n&&n.length>0&&(r.push({key:e,label:H(e),entries:n}),t.delete(e))}const d=[...t.entries()].sort(([e],[n])=>e.localeCompare(n));for(const[e,n]of d)r.push({key:e,label:H(e),entries:n});return s.length>0&&r.push({key:"",label:"Docs",entries:s}),r}function H(i){return i.split("-").map(s=>s.charAt(0).toUpperCase()+s.slice(1)).join(" ")}const _e={entries:[{slug:"concepts",title:"Concepts",content:`# Concepts

The Concepts section gives you durable mental models for how kspec works. Each page explains what a concept is, why it exists, and how you will encounter it in day-to-day use.

- [What kspec Is](./what-kspec-is.md) — the system's purpose and shape
- [Working With kspec Through an Agent](./working-with-an-agent.md) — how to frame requests, what the agent decides on its own, and how to read its output
- [Specs, Tasks, Plans, and Inbox](./specs-tasks-plans-inbox.md) — the four kinds of items and when to use each one
- [The Shadow Branch](./the-shadow-branch.md) — why spec state lives on a separate git branch and how that shows up in practice
- [Traits](./traits.md) — reusable acceptance criteria that compose across specs
- [Reviews](./reviews.md) — the per-cycle review record model and how it gates work
- [Local Resources for Plans and Reviews](./local-resources.md) — how plans and reviews own supporting files, the folder layout, and the copy-vs-reference rule for derivation
- [Agents and Dispatch](./agents-and-dispatch.md) — how agents execute work and how dispatch assigns it
- [Dispatch Workspaces](./dispatch-workspaces.md) — the isolated worker and reviewer lifecycle, from preparation through integration and cleanup
- [Agent Runners](./agent-runners.md) — named execution harnesses, the two-layer config model, and the security boundary between project and system runner config
- [The Web UI and the Daemon](./web-ui-and-daemon.md) — what each surface is for and when to use them
`,path:"concepts/index.md"},{slug:"concepts/agent-runners",title:"Agent Runners",content:'# Agent Runners\n\nA **runner** is a named execution harness for an agent. It tells kspec how to launch the adapter process that an agent talks to — which command to spawn, which environment to give it, which working directory to use, and which secrets it needs. Runners are the operator-facing knob for everything about agent process invocation that lives outside the adapter and outside the agent definition.\n\nBefore runners existed, an agent definition pointed directly at an adapter (`adapter: claude-agent-acp`) and kspec spawned that adapter with whatever the adapter registration declared. That works for the common case but leaves no clean place to put project-specific or machine-specific overrides — different working directories on different machines, project-wide env vars, host-managed credentials, telemetry policy. Runners add a layer in between so those settings have a home that is portable, validated, and never leaks secrets into the repository.\n\n## The Two-Layer Model\n\nRunner configuration is stored in two layers that compose into a single effective runner registry:\n\n- **Project layer** — repo-managed, lives in the shadow worktree at `.kspec/project.runners.yaml`. Carries only **portable, non-secret** values that every machine working on this project should share. The schema rejects secret-looking env names, known credential variable names, and any `env.secrets` bindings at load time.\n- **System layer** — machine-local, lives outside the repository under the user\'s daemon config directory at `<daemon-config-dir>/projects/<project-key>/runners.yaml`. Owns process settings (executable, args, cwd), env policy (inherit, pass, set), credential source bindings (`env.secrets`), and any local overrides of project-layer values.\n\nThe effective runner is the merged result, with **system values overriding project values field-by-field** for the same runner name. Every field in the resolved runner carries source metadata identifying which layer supplied it and whether the system layer overrode a project value.\n\nBoth layers are optional. A project with no runner config and agents that only declare `adapter` keeps working exactly as before — runners are additive.\n\n## How Resolution Works\n\nWhen kspec invokes an agent it walks a short decision tree:\n\n1. If the invocation supplied an explicit `--adapter` override, take the legacy path with that adapter and ignore any configured runner.\n2. If the agent definition has a `runner` field, look the name up in the effective registry. A missing name fails before any process is spawned, with a diagnostic that names both config layers and the agent definition as places to check.\n3. If the agent has no `runner` field, fall back to `agent.adapter` (or the built-in default).\n4. When both `runner` and `adapter` are present, the runner wins. The resolved runner picks the adapter; the agent\'s legacy `adapter` field is retained only as metadata.\n\nResolution produces an invocation contract that contains the runner name, the resolved adapter identity, the command kspec will spawn, its arguments, environment, cwd, and a redacted diagnostics block. Every operator-facing surface — `kspec agent list`, `kspec agent runners validate`, the daemon agent API, dispatch status, the Web UI — renders this contract so the runner and resolved adapter are visible everywhere the agent appears.\n\n## What Goes Where\n\nThe two-layer split is a security and portability boundary, not a feature split.\n\n| Lives in project layer (`project.runners.yaml`)             | Lives in system layer (`runners.yaml`)                    |\n| ----------------------------------------------------------- | --------------------------------------------------------- |\n| `env.set` non-secret literals (e.g. `NODE_ENV: production`) | `kind`, `adapter` (required to make the runner effective) |\n| `privacy.disable_nonessential_traffic`                      | `process.executable`, `process.args`, `process.cwd`       |\n| `diagnostics.retain_raw_logs`                               | `env.inherit`, `env.pass`, `env.secrets`                  |\n\n`env.secrets` is system-only. The project layer schema rejects it outright, and rejects known credential variable names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, …) and any name containing `API_KEY`, `AUTH_TOKEN`, `ACCESS_TOKEN`, `OAUTH_TOKEN`, `SECRET`, or `PASSWORD` from literal `env.set` values. Process args go through a similar secret-shaped-value check that flags `Bearer <token>`, `--api-key=<value>`, and the same flag-name patterns.\n\nThese rules are enforced at config load time, not at invocation time. A project layer that tries to declare an API key never reaches the effective registry — the load step returns a validation issue and the runner is rejected before it can be referenced by any agent.\n\n## Why a Runner Layer at All\n\nRunners exist because adapter registrations are not the right place for operator policy. An adapter says "I am Claude Agent ACP and I launch with this command." It does not say "On this project, prefix that command with our wrapper script and pass `KSPEC_ENV=production`." Without a runner layer, projects have only two options for that kind of override: bake it into the adapter registration (which becomes machine-specific) or set environment variables on the daemon process (which leaks across all invocations). Both undermine the goal of reproducible agent execution.\n\nRunners separate those concerns:\n\n- The **adapter** describes the ACP integration: which protocol version, which entry point, how to format prompts and skills.\n- The **runner** describes the invocation: what to spawn, what environment to give it, what working directory to start from, what credentials it needs, what privacy and diagnostic policy to apply.\n- The **agent definition** points at one or the other (and may keep both for backward compatibility).\n\nThis split also makes the security model legible. Anything portable enough to commit lives in the project layer. Anything that depends on a specific machine, a specific user, or a credential lives in the system layer. There is no third tier where the boundary blurs.\n\n## Where Runners Show Up in Use\n\nYou encounter runners across the same surfaces that already expose agents:\n\n- **CLI.** `kspec agent list` shows the runner name (when present) and the resolved adapter for every agent in both human and JSON output. `kspec agent runners validate` returns the effective registry, source attribution, and redacted diagnostics so operators can confirm what will spawn without running anything.\n- **Daemon API.** Agent and dispatch endpoints include the runner name and resolved adapter on agent definitions, active invocations, and queued invocations, with diagnostics scrubbed of secret material.\n- **Web UI.** Agent cards display the runner identity (when present) and the resolved adapter for every agent. Active and queued invocation rows surface the same fields. The agent edit form sets or clears `runner` without forcing a raw adapter edit.\n- **Session metadata and dispatch events.** `agent.dispatched` events and session metadata for runner-backed invocations carry the runner name and resolved adapter id alongside the existing fields, so logs and dashboards reflect the runner contract.\n\nIf you want the configuration walkthrough — concrete YAML, the validation command, and migration guidance — see [Configuring Agent Runners](../guides/configuring-agent-runners.md).\n',path:"concepts/agent-runners.md"},{slug:"concepts/agents-and-dispatch",title:"Agents and Dispatch",content:`# Agents and Dispatch

Agents are project-defined AI participants. Dispatch is the optional routing loop that matches project events to those definitions and invokes a suitable agent. Together they automate assignment; they do not replace the task, spec, review, or integration records that define the work.

## Why Agents and Dispatch Exist

Agent definitions make repeated work consistent by attaching capabilities, conventions, skills, execution limits, and event rules to a named participant. Dispatch removes the need for a person to notice every ready task or submitted review and start the matching participant by hand.

Projects still decide what may be automated. A dispatch rule can narrow an event to eligible work or another project condition, and an agent can stop at a genuine external blocker just as a human contributor would.

## What Setup Provides

\`kspec setup\` scaffolds default agent definitions for a fresh project: a task worker, a code review agent, a primary development agent, and a plan reviewer. The task worker responds to ready and needs-work task events with automation eligibility filtering by default. The code review agent responds to pending-review tasks. The primary development agent covers coding, testing, refactoring, and review, while the plan reviewer provides plan-review capability. These scaffolded definitions are write-authorized so they can carry out their roles.

They are starting points, not built-in identities that every project must keep. Projects can configure or rename them, deliberately remove them, or add different agents. The live agent registry is authoritative after setup.

## How Dispatch Surfaces in Use

When a matching event occurs, dispatch evaluates the live rules, selects an agent, and prepares an isolated task workspace. A worker reads the task and spec, implements and verifies the change, records notes, and submits it. Review uses a separate snapshot. If changes are requested, a later worker resumes the canonical workspace and task branch.

Dispatch status shows admission authority and observable active, queued, held, cleanup, and degraded-target state. Lifecycle controls govern whether new work may start and whether dispatch-owned work is cancelled; they do not change semantic task readiness or delete workspace evidence.

For the durable isolation and continuity model, read [Dispatch Workspaces](./dispatch-workspaces.md). For operational detail, use [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md), [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md), and the supported [troubleshooting paths](../troubleshooting/index.md).

## Runners and One-Off Invocation

An agent definition points to an execution adapter or a named runner. Runners hold reusable execution configuration and separate project-owned settings from machine-local credentials. See [Agent Runners](./agent-runners.md) for that boundary and [Configuring Agent Runners](../guides/configuring-agent-runners.md) for the setup walkthrough.

An operator can also invoke an agent once without entering the dispatch loop. That one-off path is useful for targeted work and runner testing, but it is not automatically owned by dispatch workspace or lifecycle management.
`,path:"concepts/agents-and-dispatch.md"},{slug:"concepts/dispatch-workspaces",title:"Dispatch Workspaces",content:`# Dispatch Workspaces

## What a Dispatch Workspace Is

A dispatch workspace is the managed, task-scoped place where an automated agent performs work. It combines a git worktree, the task branch checked out there, and durable dispatch records that let kspec relate the directory to the project, task, role, and integration outcome.

The workspace is evidence as well as a place to edit. Its branch, task notes, invocation history, and recorded integration state explain what an agent worked on and what remains to happen.

## Why Isolation Exists

Automated workers must not share an index or working tree with the project checkout, another worker, or a reviewer. Separate workspaces prevent one invocation's edits and git operations from changing another invocation's view of the repository. They also give cleanup and recovery a bounded set of dispatcher-owned paths to reason about.

Isolation does not make the work independent of the project. Every workspace is still bound to one source project and one intended integration target.

## Target and Task Identity

The canonical task identity ties repeated invocations, aliases, and review cycles to the same unit of work. The integration target says where approved work is intended to accumulate. A plan can provide that target for a stack of related tasks; otherwise project dispatch configuration supplies it.

The target is part of workspace meaning, not merely a branch chosen at merge time. If the authoritative target changes or cannot be synchronized safely, dispatch reports that state rather than silently publishing somewhere else.

## Worker Continuity

The canonical worker workspace persists while a task is in progress and when review sends it back for changes. A later worker invocation resumes the same task branch and workspace so it can inherit the implementation, tests, notes, and review context instead of reconstructing them from conversation history.

Only one active invocation owns a canonical task at a time. Continuity means reuse across invocations, not concurrent editing of the same workspace.

## Detached Reviewer Lifecycle

A reviewer receives a separate snapshot of the submitted branch. That snapshot is intentionally isolated from the worker's mutable workspace and from the integration checkout. The reviewer can inspect the exact submitted state, run checks, and record a disposition without taking ownership of the worker's directory.

Reviewer snapshots are short-lived. When review finishes, dispatch evaluates the snapshot for cleanup immediately. If it belongs to active, in-flight, paused-held, or stopped-pending-cleanup evidence, artifact protection preserves it; otherwise dispatch removes the snapshot. The worker workspace follows the longer task lifecycle instead.

## The Fix Cycle

When review requests changes, the task returns to the worker. The worker resumes the canonical workspace, reads the review record, updates the branch, and submits a new version. The next review uses a new reviewer snapshot and a new per-cycle review record.

This division preserves both kinds of continuity: the worker keeps its implementation context, while each review remains a point-in-time assessment of one submitted version. See [Reviews](./reviews.md) for the review-record model.

## Bootstrap State

Before an agent begins its role, dispatch prepares the source-bound workspace and runs the configured project and agent bootstrap steps. Successful state may be reused only while the inputs that made it valid still match. A changed target, configuration, or tracked workspace state can require preparation to run again.

Bootstrap belongs to dispatch workspaces, not to arbitrary one-shot agent runs. A bootstrap failure leaves an observable workspace outcome for inspection rather than pretending the task ran.

## Integration and Publication

The worker commits to the task branch. After review approval, publication uses one of two durable paths: a reviewed manual merge into the integration target or a GitHub pull request when the required remote and tooling are available. The \`auto\` setting selects between those two paths from the environment; it is not a third publication path. Publication records are part of workspace state so cleanup can distinguish integrated work from work that is still unresolved.

The task branch and integration target remain distinct even when both live in the same repository. Dispatch never treats a completed invocation by itself as proof that the work was reviewed or integrated.

## Lifecycle Authority Versus Task Readiness

Task readiness answers whether the task's semantic state and dependencies make it a candidate for work. Lifecycle authority answers whether dispatch may admit that candidate now. Pausing or stopping dispatch does not rewrite the task's readiness, and resuming dispatch re-evaluates current authoritative task state rather than restoring a private queue as truth.

Workspace state is separate again: a workspace can persist while admission is paused, and stopped authority can coexist with cleanup that is still pending. Degraded target state is also independent; a lifecycle action does not clear a synchronization or target-safety problem. The [lifecycle controls guide](../guides/controlling-dispatch-lifecycle.md) owns transition procedures.

## Evidence and Cleanup Ownership

Lifecycle control governs admission and cancellation. It does not delete a workspace or make its evidence disposable. Sessions, branches, worktrees, snapshots, task history, and audit records remain subject to their existing retention and cleanup policy.

Cleanup evaluates durable ownership and integration state. Active, in-flight, paused-held, and stopped-with-pending-cleanup work stays protected. When ownership or safety cannot be established, cleanup preserves or blocks the artifact with recovery information instead of blindly deleting it. A terminal task or resolved integration outcome can move the workspace toward closing and scheduled cleanup.

## Operator Ownership

Operators configure where dispatch workspaces live, which integration targets and publication paths apply, and which agents may be invoked. They inspect task, agent, and dispatch status when preparation, synchronization, review, or cleanup needs attention.

The dispatcher owns its registry, managed worktrees, reviewer snapshots, and task branches. Operators should use supported status, configuration, retry, and recovery paths rather than editing registry or lifecycle state, deleting managed directories, or running manual worktree surgery.

## Current Limitations

Dispatch workspaces are local managed git worktrees, not distributed build sandboxes or resumable machine checkpoints. Remote synchronization is bounded by the configured repository and safety checks; it does not promise that every remote topology can be repaired automatically. One-shot agent runs remain outside dispatch workspace and lifecycle ownership unless dispatch created them.

There is no general workspace list, show, reset, or cleanup command. Lifecycle controls do not substitute for those operations, and cleanup may remain pending when process or workspace ownership cannot be verified safely.

## Related Operations

- [Agents and Dispatch](./agents-and-dispatch.md) introduces agent definitions and automatic assignment.
- [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) explains targets, roots, bootstrap, publication, and synchronization.
- [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) explains admission, pause, resume, hard stop, and status.
- [Troubleshooting](../troubleshooting/index.md) collects supported recovery paths when assignment, preparation, synchronization, or cleanup fails.
`,path:"concepts/dispatch-workspaces.md"},{slug:"concepts/local-resources",title:"Local Resources for Plans and Reviews",content:"# Local Resources for Plans and Reviews\n\nPlans and reviews often need supporting files: a research PDF that informed a design, a UX screenshot referenced from the plan body, a screen recording captured during a review, an evidence log a reviewer wants future agents to see. kspec stores those files as **local resources** owned by the plan or review they belong to, declared in a manifest, and resolved through versioned references.\n\nThis page explains the model. For the commands and API routes that work with it, see [Working With Local Resources](../guides/working-with-local-resources.md).\n\n## Why a Dedicated Model\n\nThree things go wrong when supporting files are dropped into a project ad hoc:\n\n- **They drift away from their context.** A screenshot loose in `/screenshots` does not know which plan it belongs to. Cleaning up later means guessing.\n- **They bloat structured records.** Inlining a 2 MB screenshot into the plan YAML makes every list query slower, every cache reload heavier, and every diff harder to read.\n- **They have no version identity.** A reviewer can swap a screenshot underneath an approval, and nothing notices.\n\nThe local-resource model solves all three. Each resource has a single owning entity, lives in that entity's directory, and is identified by a stable id plus a content hash and git version. References are versioned so a derived task can detect when the underlying file has changed.\n\n## Folder-Backed Storage\n\nStarting with `kynetic: \"1.2\"`, plans and reviews are folder-backed entities. Each plan and each review owns a directory under `.kspec/` and the project-wide index files stay lean.\n\n### Plan Layout\n\n```\n.kspec/\n├── project.plans.yaml                          # Lean index: ULID, slugs, title, status, source path,\n│                                               #   module, branch, derived refs, timestamps,\n│                                               #   resource summaries\n└── plans/\n    └── <plan-ulid>/\n        ├── plan.md                             # Authoritative markdown document\n        ├── plan.yaml                           # Identity, status, lifecycle, refs, timestamps\n        ├── notes.yaml                          # Optional — present when the plan has notes\n        ├── resources.yaml                      # Resource manifest (always present)\n        └── resources/                          # Resource files (only when resources exist)\n            └── <relative-path>\n```\n\n`plan.md` is the source of truth for the plan document. The project-wide `.kspec/project.plans.yaml` index never inlines full markdown, full notes, or resource bytes — only the bounded fields a list view needs.\n\n### Review Layout\n\n```\n.kspec/\n├── project.reviews.yaml                        # Lean index: ULID, lifecycle, subject summary,\n│                                               #   related refs, disposition, timestamps,\n│                                               #   resource summaries\n└── reviews/\n    └── <review-ulid>/\n        ├── review.yaml                         # Full review record: subject, threads, checks,\n        │                                       #   verdicts, events, notes, external links\n        ├── resources.yaml                      # Resource manifest (always present)\n        └── resources/                          # Resource files (only when resources exist)\n            └── <relative-path>\n```\n\nReviews keep the structured review record cohesive in one `review.yaml` file. Threads, checks, and verdicts are not split into sidecars in this format. As with plans, the project-wide `.kspec/project.reviews.yaml` index stores only the bounded summary fields a list view needs.\n\n### Unknown Files Are Preserved\n\nAnything an editor or another tool drops into a plan or review directory that kspec does not recognize is ignored by kspec semantics and preserved across writes. The CLI does not delete unfamiliar files, so a sibling tool that drops `.DS_Store` or `editor.lock` is safe.\n\n## The Resource Manifest\n\nEvery plan and every review has a `resources.yaml` file. It lists every file the entity owns, with enough metadata for list views, API responses, static exports, and drift detection to work without touching the file bytes.\n\n### `resources.yaml` Shape\n\n```yaml\nresources:\n  - id: ux-mockup\n    label: \"Sign-in mockup, v3\"\n    path: ux/sign-in-v3.png\n    content_type: image/png\n    bytes: 184320\n    sha256: 0a4b3f1d2c89e7f6a5b4c3d2e1f009887766554433221100ffeeddccbbaa9988\n    git_commit: 7c3a2e4d6f1b9080a5d3e6f8c7b4a290de1f0234\n    git_path: .kspec/plans/01JHJ5K9XQ8Z3F2V0WB7T5MNRC/resources/ux/sign-in-v3.png\n    description: \"Final mockup approved by design review\"\n```\n\n### `ResourceMetadata` Fields\n\nEvery resource — whether returned by the CLI, the daemon API, or a static export — uses the same fixed shape:\n\n| Field          | Type             | Meaning                                                                          |\n| -------------- | ---------------- | -------------------------------------------------------------------------------- |\n| `id`           | `string`         | Stable identifier. Matches `[a-z0-9][a-z0-9._-]{0,127}`                          |\n| `label`        | `string \\| null` | Optional human-friendly label                                                    |\n| `path`         | `string`         | POSIX-relative path under the entity's `resources/` directory                    |\n| `content_type` | `string`         | `type/subtype` MIME token (never null; falls back to `application/octet-stream`) |\n| `bytes`        | `number`         | File size in bytes                                                               |\n| `sha256`       | `string`         | 64-character lowercase hex content hash                                          |\n| `git_commit`   | `string \\| null` | 40-character commit SHA captured when bytes were last written                    |\n| `git_path`     | `string \\| null` | Repository-relative path captured alongside `git_commit`                         |\n| `description`  | `string \\| null` | Optional free-form description                                                   |\n\nThe exact shape is fixed so plans, reviews, and any future folder-backed entity that adopts the trait read and write the same fields.\n\n### Resource Id Rules\n\nResource ids must match the pattern `[a-z0-9][a-z0-9._-]{0,127}`:\n\n- start with a lowercase letter or digit\n- contain only lowercase letters, digits, `.`, `_`, or `-`\n- be 1 to 128 characters long\n\nIds are stable identifiers — they appear in API URLs, in `resource_refs` on derived tasks, and in materialized task copies as `plan-<resource-id>`. Pick an id you can live with; renaming an id is a remove-and-re-add operation.\n\n### Resource Path Rules\n\nThe `path` field is a POSIX-relative path under the owning entity's `resources/` directory. The following shapes are rejected at the manifest boundary and by every command, API route, and resolver:\n\n- absolute paths (anything that starts with `/`)\n- parent traversal (`..` segments)\n- backslashes (`\\`)\n- empty segments (`a//b`)\n- redundant `.` segments\n- paths that resolve through a symlink outside the resource root\n\nThis guarantees a resource reference always resolves inside its owning entity's tree, no matter where it was authored.\n\n### `content_type` Population\n\n`content_type` is never null. The CLI and API populate it the same way:\n\n1. If an explicit value is supplied (`--content-type` on the CLI, multipart `content_type` field on the API), it must be a non-empty `type/subtype` token with no whitespace. It is stored exactly as given.\n2. Otherwise the value is inferred from the final resource path's extension using the project's MIME lookup (Node's standard MIME table is the fallback).\n3. If inference fails (unknown extension, no extension at all), the stored value is `application/octet-stream`.\n\n## Authoring References: `./resources/<relative-path>`\n\nMarkdown links and structured task definitions reference resources with the `./resources/` prefix:\n\n```markdown\nThe login screen renders the validation error as shown in\n[the v3 mockup](./resources/ux/sign-in-v3.png).\n```\n\n```yaml\n- title: Implement sign-in validation\n  slug: task-implement-sign-in-validation\n  resource_refs:\n    - \"./resources/ux/sign-in-v3.png\"\n```\n\nThe prefix is stable: it means \"a resource owned by this entity, declared in this entity's `resources.yaml`, at this relative path\". It is the only authoring form. Absolute paths, project-relative paths, and undeclared paths are rejected wherever a reference is resolved — import, set, derive, attach, serve, export.\n\n## Versioned References on Derived Tasks\n\nWhen `kspec plan derive` creates a task from a plan task definition that has `resource_refs`, it does **not** copy the resource files by default. It records a `TaskResourceRef` for each referenced resource:\n\n| Field         | Meaning                                                           |\n| ------------- | ----------------------------------------------------------------- |\n| `owner_type`  | `\"plan\"` or `\"task\"` — where the bytes actually live              |\n| `owner_ref`   | Plan ref (for plan-owned) or task ref (for task-owned copies)     |\n| `id`          | Resource id inside the owner's manifest                           |\n| `path`        | Relative path inside the owner's `resources/` tree                |\n| `sha256`      | Content hash captured at derivation time                          |\n| `git_commit`  | Git commit captured at derivation time (or `null` if unavailable) |\n| `git_path`    | Repository-relative path captured alongside `git_commit`          |\n| `recorded_at` | ISO 8601 datetime the reference was recorded                      |\n\nIf the plan resource's current content hash later disagrees with the task's recorded `sha256`, consumers (task detail, agent context, API resource resolver) surface drift instead of silently substituting the new bytes for the old.\n\nThe default mode is intentional. A plan-owned resource is single-sourced; derived tasks get pointers plus the hash and git identity needed to detect drift. Copying creates duplicate bytes and hides history.\n\n## Copying Bytes With `--materialize-resources`\n\nThe only way to copy plan resource bytes into a derived task's own directory is to pass `--materialize-resources` to `kspec plan derive`. When this flag is present:\n\n- Each plan resource referenced by a derived task is copied into `.kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/<relative-path>`.\n- The copied resource is registered in the task's resource manifest with the id `plan-<original-resource-id>` (so a plan resource named `ux-mockup` becomes a task-owned resource named `plan-ux-mockup`).\n- The `TaskResourceRef` switches to `owner_type: \"task\"`, `owner_ref: <task-ulid>`, and points at the task-owned copy.\n\nUse this when a task needs an immutable snapshot of plan resources at derivation time — for example, before handing the task off for long-running work where the plan may continue to evolve.\n\n## Resolving Task Resources From Task Markdown\n\n<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-markdown -->\n\nA task description can reference its resources with the same `./resources/<relative-path>` authoring form a plan uses:\n\n```markdown\nThe validation surface to build is shown in\n![the v3 mockup](./resources/ux/sign-in-v3.png).\n```\n\nThe `./resources/<relative-path>` reference is resolved through the task's own `resolved_resources` projection rather than against a global path. That projection — exposed on the daemon task detail API alongside a task-scoped `resources_base_url` — resolves both ownership cases the same way for the reader:\n\n- **Plan-owned references (the default).** When a task was derived without materialization, its `TaskResourceRef` still points at the plan's owned bytes (`owner_type: \"plan\"`). The reference resolves to the plan resource through the task's projection, and the task-scoped bytes URL streams the plan-owned bytes.\n- **Task-owned copies (materialized).** When a task was derived with `--materialize-resources`, the copy lives under the task's own `resources/` tree (`owner_type: \"task\"`) with the id `plan-<original-resource-id>`. The same `./resources/<relative-path>` reference resolves to the task-owned copy through the task's projection.\n\nEither way, the reader does not have to know whether the bytes are plan-owned or task-owned. A client constructs the browser-fetchable URL from the task detail response as `resources_base_url/<resource-id>/bytes` — concretely `GET /api/tasks/:ref/resources/:resourceId/bytes` — and the daemon serves the correct owner's bytes. The web UI uses exactly this projection to rewrite `./resources/<relative-path>` image and link targets in task descriptions to task-scoped resource URLs.\n\n### Drift, Missing, and Unresolved Task Resources Are Status, Not Silent Bytes\n\n<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-drift -->\n\nEach entry in a task's `resolved_resources` projection reports a `status` of `present`, `drift`, `missing`, or `unresolved`, together with a human-readable `message`:\n\n| `status`     | Meaning                                                                                                     |\n| ------------ | ----------------------------------------------------------------------------------------------------------- |\n| `present`    | The owner still declares the resource and its current content hash matches the hash recorded at derivation. |\n| `drift`      | The owner still declares the resource but its current content hash differs from the recorded `sha256`.      |\n| `missing`    | The owner is resolvable but no longer declares the referenced path.                                         |\n| `unresolved` | The owning plan or task could not be located, so the reference cannot be re-resolved.                       |\n\nWhen a task resource is drifted, missing, or unresolved, kspec surfaces the `status` and `message` instead of silently serving replacement bytes. The task resource bytes route refuses to stream bytes that differ from the hash recorded at task derivation, and the live task detail UI shows the status message rather than rewriting the markdown target to a URL that would serve different bytes. A `./resources/<relative-path>` reference that matches no resolved resource at all stays visible as raw authoring text with actionable guidance — it is never rewritten to an unrelated entity URL. This keeps a changed-underneath resource visible as a status signal instead of a quiet substitution.\n\n## Static Export and Daemon URLs\n\nResources surface through three layers, each with a stable shape.\n\n**CLI / file system.** `./resources/<relative-path>` references resolve against the owning entity's manifest. The bytes live at `.kspec/plans/<plan-ulid>/resources/<relative-path>` or `.kspec/reviews/<review-ulid>/resources/<relative-path>`.\n\n**Daemon API.** Authenticated, project-scoped routes return the resource bytes and metadata using the [`ResourceMetadata`](#resourcemetadata-fields) shape (see [Working With Local Resources](../guides/working-with-local-resources.md#daemon-api-routes) for the full route list).\n\n**Static export.** When the web UI is exported as a static snapshot, resource files are copied to `assets/resources/<entity-type>/<entity-ulid>/<relative-path>`. For plans the layout is `assets/resources/plan/<plan-ulid>/<relative-path>`, for reviews it is `assets/resources/review/<review-ulid>/<relative-path>`, and for task-resolved resources it is `assets/resources/task/<task-ulid>/<relative-path>`:\n\n```\nassets/\n└── resources/\n    ├── plan/\n    │   └── <plan-ulid>/\n    │       └── <relative-path>\n    ├── task/\n    │   └── <task-ulid>/\n    │       └── <relative-path>\n    └── review/\n        └── <review-ulid>/\n            └── <relative-path>\n```\n\nThe export rewrites `./resources/<relative-path>` markdown links in plan and task content to point at the exported asset path. The exported metadata reports the exported path so consumers do not need to re-derive it. Only `present` task resources carry an exported asset path; drifted, missing, or unresolved task references are not exported as bytes, so the static snapshot never advertises a substitute for a resource that changed underneath the task.\n\n## How Resources Surface in Use\n\nWhen you read a plan with `kspec plan get`, the resource manifest summary appears alongside the plan record. When you open a plan in the web UI, the rendered markdown's `./resources/` image links are rewritten to safe plan-scoped resource URLs. When you derive tasks, plan resources travel along as versioned references — or as copies, if you ask. When you static-export the project, resources are copied beside the JSON snapshot so the offline UI works without the daemon.\n\nResources are the same idea kspec applies elsewhere — versioned, identified, owned by one entity, never silently moved — applied to supporting files that used to live in scattered folders.\n",path:"concepts/local-resources.md"},{slug:"concepts/reviews",title:"Reviews",content:`# Reviews

kspec has a built-in review system that creates a structured record for each round of review on a task. Reviews are not just approvals or rejections — they capture the investigation, the feedback, and the resolution in a durable, auditable format.

## Why They Exist

Code review is usually a conversation in a pull request — useful, but ephemeral and hard to trace back to requirements. kspec reviews tie directly to specs and acceptance criteria, so a reviewer can verify that the work actually satisfies what was specified, not just that the code looks reasonable.

The review record also supports iterative fix cycles. When a reviewer requests changes, the record captures exactly what needs to change. When the author fixes the issues and resubmits, a new review record is created for the new round. The full history of review-resubmit cycles is preserved, so no feedback gets lost between rounds.

## What a Review Record Contains

Each review record binds to a **subject** — typically a task's code at a specific commit. The subject includes version information so the system knows when verdicts and checks become stale because the code has changed.

Within a review record, there are three main structures:

**Threads** are the feedback itself. Each thread has a kind — blocker, question, or nit — and contains one or more entries from the participants. Blocker threads must be resolved before the review can approve. Questions and nits are non-blocking but should be addressed. Threads can be anchored to specific code locations or left general.

**Verdicts** record the reviewer's decision: approve, request changes, or comment. Each verdict is stamped with the subject version it applies to. If the subject changes (because the author pushed new code), older verdicts become stale and don't count toward the current disposition.

**Checks** record the results of automated verification — test suites, linters, build steps. Like verdicts, checks are version-aware. A passing test suite from an old commit doesn't satisfy the gate for the current commit.

A review can also own supporting files — screenshots demonstrating a bug, log captures from a failed run, evidence files a reviewer wants to attach to the record. These live alongside the review as [local resources](./local-resources.md), declared in the review's \`resources.yaml\` and resolvable through stable review-scoped URLs in the web UI and static export.

## How Review Gating Works

The review's **disposition** — approved, changes requested, or pending — is computed from the combination of verdicts, checks, and threads:

- **Approved**: all required checks pass, at least one approval verdict exists, no unresolved blocker threads, and no active "request changes" verdicts.
- **Changes requested**: any required check is failing, any blocker thread is unresolved, or any reviewer has requested changes.
- **Pending**: no blockers, but not enough approvals yet.

This means approval is not just one person clicking a button. The system verifies that checks pass, blockers are resolved, and the approval applies to the current version of the code — not a version that has since been updated.

## How Reviews Surface in Use

**After submitting a task.** When a task moves to "pending review," a reviewer (human or agent) creates a review record, investigates the work against the spec's acceptance criteria, opens threads for issues found, and submits a verdict.

**During fix cycles.** If the verdict is "request changes," the task moves to "needs work." The author reads the review threads, addresses each one, replies with what was changed, resolves the threads, and resubmits. A new review record is created for the next round.

**At the merge gate.** Before merging approved work, the merge process checks the review disposition. Only tasks with an approved disposition, passing checks, and no unresolved blocker threads can proceed.

**In the audit trail.** Review records persist as first-class entities in the shadow branch. You can look up any task's review history to see what was found, what was fixed, and who approved it. This is especially valuable when reconstructing decisions months later.

The per-cycle model — one review record per submission round — means the history is clean. Each record represents a complete pass through the work, not an ever-growing thread of mixed feedback from different versions.
`,path:"concepts/reviews.md"},{slug:"concepts/specs-tasks-plans-inbox",title:"Specs, Tasks, Plans, and Inbox",content:`# Specs, Tasks, Plans, and Inbox

kspec organizes work into four kinds of items. Each serves a different purpose, and choosing the right one matters — it determines how the item is tracked, reviewed, and eventually completed.

## Why Four Kinds

A single bucket for "things to do" conflates ideas with commitments, requirements with work items, and design with execution. kspec separates them so each kind can carry the right metadata and follow the right lifecycle.

The result: specs don't get lost in task backlogs, tasks don't duplicate spec content, plans coordinate without micromanaging, and the inbox catches everything else without polluting the structured items.

## What Each Kind Is

### Specs

A spec defines **what the software should do**. It's the source of truth for behavior.

Specs form a hierarchy: a module groups related features, a feature describes a capability, and a requirement pins down a specific behavior. Each spec item carries acceptance criteria — structured Given/When/Then statements that say exactly what "done" means.

Specs don't describe how to implement something. They describe the outcome. A spec for "user login" says what happens when a user enters valid credentials, not which library to use for authentication.

### Tasks

A task tracks **the work of building something**. It points back to a spec and carries its own lifecycle: pending, in progress, under review, completed.

Tasks are where execution happens. They accumulate notes about decisions and discoveries, link to branches and commits, and eventually get reviewed against the spec's acceptance criteria. A task doesn't duplicate the spec — it references it.

### Plans

A plan coordinates **a group of specs and tasks that need to ship together**. When a feature is big enough to span multiple specs, a plan captures the design and tracks which specs and tasks have been derived from it.

Plans have their own lifecycle: draft, approved, active, completed, and rejected. You approve a plan before deriving work from it, which prevents wasted effort on designs that haven't been agreed on. A plan that doesn't survive review ends up rejected — a terminal state that keeps the decision visible rather than silently deleting the proposal.

A plan can own supporting files — screenshots, research PDFs, UX mockups — as [local resources](./local-resources.md) stored beside its markdown document. Derived tasks receive versioned references back to those plan resources, so a task knows which file informed it and can detect when the plan has changed the file since derivation.

### Inbox

The inbox captures **ideas and observations that aren't yet scoped**. An inbox item is just text, a timestamp, and optional tags. It has no acceptance criteria, no lifecycle states, and no review process.

The inbox exists because not every thought is ready to be a spec or task. Some need more context, some turn out to be duplicates, and some are just notes. Triage converts inbox items into structured work when the time is right.

## How to Decide Which Kind to Use

When you encounter a unit of work, apply these rules in order:

**Is it a clear behavior change with a defined outcome?**
Create a **spec** with acceptance criteria, then derive a **task** from it. The spec defines what should change; the task tracks the work of changing it.

**Is it a large effort spanning multiple specs?**
Create a **plan** first. Capture the design, get it approved, then derive specs and tasks from the plan. This prevents scope creep and ensures the parts fit together.

**Is it infrastructure, tooling, or internal work with no user-visible behavior?**
Create a **task** directly. Not everything needs a spec — work that doesn't change user-facing behavior can skip the spec step.

**Is it vague, incomplete, or something you noticed while doing other work?**
Add it to the **inbox**. Don't interrupt your current task to scope it out. Triage it later when you have context to decide whether it becomes a spec, a task, or nothing.

## How They Surface in Use

When you run \`kspec session start\`, you see active tasks and inbox items awaiting triage. The CLI commands for each kind follow predictable patterns — \`kspec item\` for specs, \`kspec task\` for tasks, \`kspec plan\` for plans, and \`kspec inbox\` for the inbox.

During a review, the reviewer checks the task's implementation against the spec's acceptance criteria. The plan, if one exists, provides the broader design context. And if someone spots something that doesn't fit any current spec, it goes into the inbox rather than getting lost in a commit message.

The four kinds create a pipeline: inbox items get triaged into specs, specs get derived into tasks, tasks get worked and reviewed, and plans keep the larger picture coherent.
`,path:"concepts/specs-tasks-plans-inbox.md"},{slug:"concepts/the-shadow-branch",title:"The Shadow Branch",content:`# The Shadow Branch

kspec stores all of its state — specs, tasks, plans, inbox items, reviews, and metadata — on a separate git branch called the shadow branch. This page explains what the shadow branch is, why it exists, and how it appears in your day-to-day work.

## What It Is

The shadow branch is an orphan branch (by default named \`kspec-meta\`) that has no common history with your source code branches. It's checked out as a git worktree into the \`.kspec/\` directory at your project root.

From git's perspective, \`.kspec/\` is a separate working tree pointing at a different branch. From your perspective, it's a directory containing YAML files that kspec reads and writes. Your source-code worktree gitignores \`.kspec/\`, so spec state never appears in source-code commits, regardless of how your project names its branches.

Every kspec CLI command that modifies state — adding a spec, starting a task, recording a note — automatically commits the change to the shadow branch. You don't run \`git add\` or \`git commit\` for spec state. The audit trail builds itself.

## What Lives in \`.kspec/\`

On a project at \`kynetic: "1.2"\` or newer, the shadow branch holds a mix of lean project-wide indexes and folder-backed per-entity directories:

\`\`\`
.kspec/
├── <project-slug>.yaml          # Project manifest: version, storage formats, etc.
├── project.tasks.yaml           # Lean task index
├── project.plans.yaml           # Lean plan index
├── project.reviews.yaml         # Lean review index
├── project.inbox.yaml           # Inbox items (single file by design)
├── modules/                     # Spec items by module
├── tasks/<task-ulid>/           # Per-task core data, notes, history
├── plans/<plan-ulid>/           # Per-plan plan.md, plan.yaml, resources/
└── reviews/<review-ulid>/       # Per-review review.yaml, resources/
\`\`\`

The index files do not inline full markdown, full review records, or resource bytes — those live in the per-entity directories. See [Local Resources for Plans and Reviews](./local-resources.md) for the plan and review layouts and how supporting files (screenshots, PDFs, evidence logs) are stored.

Files that kspec does not recognize inside an entity's directory are ignored by kspec semantics and preserved across writes. A sibling tool that drops \`.DS_Store\` or \`editor.lock\` in a plan folder will not lose them on the next kspec command.

## Why It Exists

Spec and task state needs version control, but mixing it into your source branch creates problems:

- **Noisy history.** Every task note, status change, and spec edit would be a commit on your source-code branches. The signal-to-noise ratio drops fast.
- **Merge conflicts.** Spec YAML files would conflict with other developers' spec changes during code merges, even though spec edits and code edits are independent.
- **Branch coupling.** Feature branches would carry spec state that might not be relevant to the code changes on that branch.

The shadow branch avoids all of this. Spec history lives in its own timeline. Code history stays clean. The two can be pushed and synced independently.

The alternative — storing state in a database or external service — would sacrifice the auditability and portability that git provides. With the shadow branch, your spec history is as durable and inspectable as your code history, and it travels with the repository.

## How It Surfaces in Use

Most of the time, you don't interact with the shadow branch directly. The kspec CLI handles reads and writes transparently. Here's where it shows up:

**Initialization.** When you run \`kspec init\`, it creates the orphan branch and sets up the \`.kspec/\` worktree. This is a one-time operation per project.

**Syncing.** If your team shares spec state, \`kspec shadow sync\` pushes and pulls the shadow branch to a remote. This is separate from pushing your code branches.

**Health checks.** If something goes wrong with the worktree linkage — which can happen after aggressive git operations — \`kspec shadow status\` diagnoses the problem and \`kspec shadow repair\` fixes it.

**Cloning.** When someone clones a repository that uses kspec, \`kspec init\` detects the existing shadow branch on the remote and sets up the local worktree from it.

The key thing to remember: always run kspec commands from your project root, never from inside \`.kspec/\`. The CLI expects to be in the main working tree and manages the shadow worktree on your behalf.
`,path:"concepts/the-shadow-branch.md"},{slug:"concepts/traits",title:"Traits",content:`# Traits

Traits are reusable acceptance criteria that apply across multiple specs. Instead of copying the same requirement into every spec that needs it, you define it once as a trait and declare which specs implement it.

## Why They Exist

Some requirements cut across features. "All CLI commands with structured output support a machine-readable format" is not specific to any one command — it applies to every command that produces structured output. Without traits, you'd either duplicate that criterion in dozens of specs or leave it implicit and hope reviewers remember to check it.

Traits make cross-cutting requirements explicit and auditable. When a spec declares that it implements a trait, it inherits the trait's acceptance criteria. Those inherited criteria show up during review and validation, so nothing gets overlooked.

## What a Trait Is

A trait is a special kind of spec item. Like other spec items, it carries a title, description, and acceptance criteria. The difference is in how it's used: traits aren't implemented directly. Instead, other spec items declare that they implement the trait.

For example, a trait for machine-readable output might define:

- Given a command produces output, when the user requests machine-readable format, then the output is valid structured data.
- Given the user requests machine-readable format, when the command encounters an error, then the error is also returned as structured data.

Any spec that declares it implements this trait automatically inherits these criteria. The spec's own acceptance criteria and the trait's criteria are both required for the implementation to be considered complete.

## How Traits Compose

A spec can implement multiple traits, and traits can define any number of acceptance criteria. The composition is additive: a spec's total acceptance criteria are its own plus all criteria from every trait it implements.

When you view a spec with the CLI, inherited trait criteria are shown alongside the spec's own criteria, with a note indicating which trait they come from. This makes it clear what the full set of requirements is without jumping between files.

If a trait criterion genuinely doesn't apply to a particular spec, you annotate it as not applicable with a reason. This is a deliberate decision, not an omission — the annotation is machine-parseable so validation can distinguish between "covered," "not applicable," and "missing."

## How They Surface in Use

**During spec creation.** When you define a new spec, you can add traits to declare which cross-cutting requirements it should satisfy. The trait's criteria become part of the spec's contract.

**During implementation.** When working on a task, you see both the spec's own criteria and the inherited trait criteria. Each one needs a test annotated with the trait's reference, not the spec's, so the coverage tracking knows which trait is being verified.

**During review.** A reviewer checking a task can see whether all trait criteria have been addressed. The validation tooling reports uncovered trait criteria as warnings, catching gaps before they reach production.

**During evolution.** When you add a new criterion to a trait, every spec that implements it gains that requirement. This is intentional — traits let you raise the bar across the project with a single change. It also means trait changes should be deliberate, since they have wide impact.
`,path:"concepts/traits.md"},{slug:"concepts/web-ui-and-daemon",title:"The Web UI and the Daemon",content:`# The Web UI and the Daemon

kspec provides two runtime surfaces beyond the CLI: a local daemon that serves an API, and a web UI that presents project state in a browser. Both are optional — the CLI is fully self-contained — but they offer a different way to interact with your specs and tasks.

## Why They Exist

The CLI is the primary interface for kspec. It's fast, scriptable, and works in any terminal. But some activities are better served by a visual interface:

- **Browsing specs and tasks** is easier when you can see the hierarchy, filter by status, and click through relationships rather than running a sequence of CLI commands.
- **Reading documentation** is more comfortable in a rendered format with navigation, search, and syntax-highlighted code blocks.
- **Monitoring agent activity** is clearer when you can watch task state changes in real time rather than polling the CLI.

The daemon and web UI serve these needs without replacing the CLI. They read the same state from the shadow branch and present it through a different lens.

## What the Daemon Does

The daemon is a local HTTP server that provides a JSON API over kspec's state. It runs on your machine (default port 3456) and watches the shadow branch for changes.

Its responsibilities include:

- **Serving project data.** Specs, tasks, plans, inbox items, reviews — all available through REST endpoints.
- **File watching.** The daemon monitors the shadow branch for changes and invalidates its cache accordingly. When a CLI command modifies state, the daemon picks up the change without needing a restart.
- **Supporting the web UI.** The web UI is a static SvelteKit application that connects to the daemon's API. Without the daemon running, the web UI can still render documentation (which is bundled at build time) but cannot display live project state.
- **Hosting the dispatch engine.** When agent dispatch is running, it operates within the daemon process. Stopping the daemon stops dispatch.

The daemon is started and stopped through the CLI. A health check endpoint lets you verify it's running.

## What the Web UI Shows

The web UI is a local browser application that gives you a visual overview of your project:

- **Spec tree.** Browse the hierarchy of modules, features, requirements, and their acceptance criteria.
- **Task board.** See tasks grouped by status, with links to their specs and review records.
- **Documentation.** Project docs are bundled at build time and rendered with navigation, a table of contents, and syntax highlighting. This works even without the daemon — the content is embedded in the build.
- **Activity.** See recent changes across specs and tasks.

When connected to the daemon, the web UI supports both reading and changing project state. Its controls cover task lifecycle and notes, dispatch lifecycle, agent definitions, triage, reviews, and other supported workflows. The CLI remains available for terminal and scripted use; both surfaces operate on the same project state.

## How They Surface in Use

**Starting the daemon.** The daemon launches when you need it — for the web UI, for dispatch, or for API access. It's not required for basic CLI operations.

**Browsing the web UI.** The dev server runs on port 5173 and connects to the daemon on port 3456. In production builds, the web UI is a static site that can be served alongside your project's other documentation.

**During development.** If you're developing kspec itself, the web UI dev server supports hot module replacement. For users of kspec, the web UI is pre-built and served by the daemon.

**When the daemon is down.** Everything still works through the CLI. The web UI's documentation pages render from bundled content, so docs are available even without a running daemon. Live project state and mutation controls require the daemon.

The key distinction is between runtime modes: a daemon-connected web UI can read and change live project state, while a static export is a read-only documentation surface. The CLI continues to work independently of either mode.
`,path:"concepts/web-ui-and-daemon.md"},{slug:"concepts/what-kspec-is",title:"What kspec Is",content:`# What kspec Is

kspec is a specification-first task management system for software projects. It connects three things that usually drift apart: what the software should do, what people are working on, and what has actually shipped.

## Why It Exists

Most teams track work in one system and define requirements in another — or don't define requirements at all. Over time the gap between "what we intended" and "what we built" widens silently. Nobody notices until a feature is half-implemented, a review has no criteria to check against, or an AI agent invents its own interpretation of what to do.

kspec closes that gap by making specifications the origin point for work. A spec defines what should exist. A task tracks the effort to build it. The task points back to the spec, so anyone reviewing the work — human or agent — can check it against the original intent.

## The Shape of the System

kspec has four layers:

**Spec items** define behavior. They form a tree: modules contain features, features contain requirements, and each item carries acceptance criteria that say exactly what "done" means. Specs live in \`.kspec/\` as YAML files validated by Zod schemas.

**Tasks** track implementation. A task references a spec and carries its own status, notes, and VCS links. Tasks don't duplicate the spec — they point to it.

**Plans** coordinate larger efforts that span multiple specs and tasks. When a feature is big enough to need design up front, a plan captures the approach before work begins.

**The inbox** catches everything else — observations, ideas, and requests that aren't yet scoped enough to be specs or tasks. Items sit in the inbox until someone triages them.

All of this state lives on a separate git branch (the shadow branch) so it doesn't clutter your source code history. The CLI auto-commits every change, keeping the audit trail intact without manual discipline.

## How It Surfaces in Use

You interact with kspec mainly through its CLI and, optionally, through a local web UI. A typical cycle looks like this:

1. Define a spec with acceptance criteria.
2. Derive a task from that spec.
3. Work the task — writing code, adding notes, annotating tests against acceptance criteria.
4. Submit the task for review.
5. A reviewer (human or agent) checks the work against the spec's acceptance criteria.
6. After approval, the work is merged through the project's integration process.
7. After the merge succeeds, the task is marked complete.

At every step, the spec is the reference point. When you run \`kspec session start\`, you see what's active, what's ready, and what's blocked — all grounded in spec-defined outcomes rather than vague ticket titles.

kspec is also designed to work with AI agents. The same spec and task context that a human reads is available to an agent, so both participants share a single source of truth about what needs to happen and what has been done.
`,path:"concepts/what-kspec-is.md"},{slug:"concepts/working-with-an-agent",title:"Working With kspec Through an Agent",content:`# Working With kspec Through an Agent

kspec is designed so that AI agents and humans share the same project context. This page explains the mental model for directing an agent that uses kspec: how to frame requests, what the agent decides on its own, what it asks about, and how to read what it has done.

## Why This Matters

An AI agent working on your codebase needs the same things a human contributor needs: a clear description of what to build, criteria for when it's done, and a way to record what happened. Without that structure, the agent either asks too many questions or guesses wrong.

kspec provides that structure. The agent reads specs to understand requirements, follows the task lifecycle to track progress, and writes notes so you can see its reasoning after the fact. You don't need to restate context that's already in the spec — the agent can look it up.

## What the Agent Decides on Its Own

When an agent picks up a task, it handles most of the execution independently:

- **Reading specs and acceptance criteria.** The agent uses \`kspec item get\` and \`kspec task get\` to understand what's expected. You don't need to paste requirements into the prompt.
- **Choosing an implementation approach.** The agent plans based on the spec's acceptance criteria, existing code patterns, and any notes on the task.
- **Writing code and tests.** The agent implements the feature, writes tests annotated against acceptance criteria, and runs the test suite.
- **Recording progress.** The agent adds task notes explaining decisions, discoveries, and approach — the same way a human would.
- **Submitting for review.** When the agent believes the work meets all acceptance criteria, it submits the task.

## What the Agent Asks About

Agents escalate when the work requires judgment that the spec doesn't cover:

- **Architectural decisions** not specified in the spec.
- **Scope ambiguity** — when it's unclear whether something is in or out of scope for this task.
- **External blockers** — dependencies that aren't available or specs that need clarification.

If the agent blocks a task, it records a reason. You can unblock it after providing guidance.

## How to Frame Requests

Good requests give the agent a clear starting point:

- **Point to the spec.** "Work on task @task-slug" is better than describing the feature from scratch. The task already links to a spec with acceptance criteria.
- **Be specific about scope.** If you want a subset of the work, say so. Otherwise the agent works toward all acceptance criteria.
- **Trust the lifecycle.** You don't need to tell the agent to write tests or add notes — the task workflow includes those steps.

If you want something that isn't covered by an existing spec, consider creating the spec first. The agent performs better when it has acceptance criteria to check against rather than interpreting a free-form description.

## How to Read What the Agent Did

After an agent works on a task, you can reconstruct what happened:

- **Task notes** show the agent's reasoning, approach, and any surprises it encountered. Check these first.
- **Git commits** carry task and spec trailers, so you can trace commits back to the work item.
- **Test annotations** (\`// AC: @spec-ref ac-N\`) link each test to the acceptance criterion it covers. This tells you which criteria have been verified.
- **The review record**, if one exists, shows what a reviewer found — including any threads that need attention.

The combination of notes, commits, and AC annotations gives you a complete picture without reading every line of code.

## The Feedback Loop

If the agent's work doesn't meet your expectations, the review process sends it back with specific feedback. The agent reads the review threads, addresses each point, and resubmits. Each cycle narrows the gap between what you wanted and what was built.

Over time, better specs produce better agent output. If you find yourself repeatedly correcting the same kind of mistake, the fix is usually a clearer acceptance criterion or an additional trait — not a longer prompt.
`,path:"concepts/working-with-an-agent.md"},{slug:"getting-started",title:"Getting Started",content:`# Getting Started

The Getting Started section walks you from a machine with nothing installed to a working kspec project you have directed your agent through. Follow the pages below in order.

- [Overview](./overview.md) — what kspec is and who it is for
- [Installation](./installation.md) — install kspec and verify it works
- [Initializing a Project](./initializing-a-project.md) — set up the shadow branch and agent configuration
- [Connecting Your Agent](./connecting-your-agent.md) — connect your AI coding agent to your project
- [Your First Action](./your-first-action.md) — create a spec, derive a task, and complete the loop
- [Tutorial](./tutorial.md) — end-to-end walkthrough of the kspec loop
- [Where to Go Next](./where-to-go-next.md) — pointers into Guides and Concepts
`,path:"getting-started/index.md"},{slug:"getting-started/connecting-your-agent",title:"Connecting Your Agent",content:`# Connecting Your Agent

This page covers connecting an AI coding agent to your kspec project so it can read your specs, follow your conventions, and work within the task lifecycle.

## How agent integration works

When you ran \`kspec setup\` in the previous step, kspec generated instruction files that your agent reads automatically:

- **\`AGENTS.md\`** — the entry point that references \`kspec-agents.md\`
- **\`kspec-agents.md\`** — generated instructions containing your project's conventions, workflows, and the task lifecycle
- **\`.agents/skills/\`** — detailed skill files for specific workflows like task work, reviews, and spec writing

Most AI coding agents load \`AGENTS.md\` (or \`CLAUDE.md\` for Claude Code) automatically when they start a session in your repository. No extra configuration is needed beyond what \`kspec setup\` already created.

## Agent-specific setup

### Claude Code

Claude Code reads \`CLAUDE.md\` and \`AGENTS.md\` automatically. After running \`kspec setup\`, verify the connection by starting Claude Code in your project directory and asking it:

\`\`\`
What kspec tasks are ready?
\`\`\`

The agent should run \`kspec tasks ready\` and report the results. If it does, the integration is working.

If Claude Code does not recognize kspec commands, re-run setup with the agent type specified:

\`\`\`bash
kspec setup --agent claude-code
\`\`\`

### Other agents

kspec supports several agent families. Run setup with the appropriate type:

\`\`\`bash
# Cline
kspec setup --agent cline

# Cursor
kspec setup --agent cursor

# Windsurf
kspec setup --agent windsurf
\`\`\`

Each agent type configures the instruction files in the format that agent expects. The underlying content is the same — only the delivery mechanism differs.

## Verify the connection

The simplest way to verify your agent is connected is to ask it to run a kspec command. Start your agent in the project directory and try:

\`\`\`
Run kspec session start and show me the output.
\`\`\`

If the agent executes the command and shows your project context, the integration is working. The output should include your project name, any active tasks, and suggested next actions.

You can also ask the agent to check project health:

\`\`\`
Run kspec doctor and tell me if everything looks healthy.
\`\`\`

A healthy project shows passing checks for the shadow branch, setup state, and manifest.

## What to do if it does not work

If your agent does not recognize kspec:

1. Make sure you ran \`kspec setup\` from the project root
2. Check that \`AGENTS.md\` exists in the repository root and references \`kspec-agents.md\`
3. Check that \`kspec-agents.md\` exists and is not empty
4. Restart your agent to pick up the new files

If the agent can read the files but does not follow kspec workflows, check that \`.agents/skills/\` contains rendered skill files. If the directory is empty, run:

\`\`\`bash
kspec skill render
\`\`\`

---

**Next:** [Your First Action](./your-first-action.md)
`,path:"getting-started/connecting-your-agent.md"},{slug:"getting-started/initializing-a-project",title:"Initializing a Project",content:`# Initializing a Project

This page walks through creating a kspec project in an existing Git repository. By the end you will have a working project with the shadow branch, agent configuration, and session context.

## Initialize kspec

Navigate to your Git repository and run:

\`\`\`bash
kspec init
\`\`\`

This command creates:

- **\`<project-slug>.yaml\`** — the project manifest inside the shadow directory, containing the project name and a reference to the default top-level module. The filename is derived from the project name.
- **\`.kspec/\`** — the shadow directory where all specs and tasks are stored.

If your repository does not have any commits yet, \`kspec init\` will create an initial commit for you.

## The shadow branch

kspec stores specs, tasks, and project metadata on a separate Git branch called **\`kspec-meta\`**. This is the "shadow branch." The \`.kspec/\` directory is a Git worktree that points to this branch.

This design means:

- Spec and task changes never appear in your source branch history
- Your code changes stay clean — no YAML spec files mixed into diffs
- kspec commits to the shadow branch automatically when you run CLI commands

**The \`.kspec/\` directory is not a regular directory.** It is a Git worktree managed by kspec. The files inside it are real and readable, but you should treat them as managed state.

### Do not edit shadow state by hand

Never manually edit files inside \`.kspec/\`. Always use the \`kspec\` CLI to make changes. The CLI ensures proper validation, auto-commits to the shadow branch, and maintains consistency. Manual edits bypass these safeguards and can corrupt your project state.

### Health check and repair

If something goes wrong with the shadow branch — for example, after a failed rebase or a corrupted worktree — kspec provides commands to diagnose and fix it:

\`\`\`bash
kspec shadow status
\`\`\`

This shows the current state of the shadow branch: whether the worktree is connected, whether it is in sync with the remote, and whether there are any issues.

If the status shows problems, repair the worktree:

\`\`\`bash
kspec shadow repair
\`\`\`

This rebuilds the worktree connection without losing your spec data. For a broader health check that includes the shadow branch, setup state, and daemon status:

\`\`\`bash
kspec doctor
\`\`\`

## Run setup

After initializing, run the setup command to configure agent integration:

\`\`\`bash
kspec setup
\`\`\`

Setup performs several steps automatically:

- Detects your agent environment (or asks you to choose one)
- Installs hooks so your agent loads kspec instructions
- Renders skill files that give your agent detailed workflow knowledge
- Generates \`kspec-agents.md\`, the agent instruction file that \`AGENTS.md\` references

You can re-run \`kspec setup\` at any time to update the configuration. It is safe to run repeatedly.

## Check your session context

Start a session to see the current state of your project:

\`\`\`bash
kspec session start
\`\`\`

This shows your project summary, active tasks, and suggested next actions. It is a good command to run at the beginning of any work session to orient yourself.

## What you have now

After \`kspec init\` and \`kspec setup\`, your repository has:

| Item                  | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| \`<project-slug>.yaml\` | Project manifest inside \`.kspec/\`                           |
| \`.kspec/\`             | Shadow directory (worktree on \`kspec-meta\` branch)          |
| \`AGENTS.md\`           | Entry point for agent instructions                          |
| \`kspec-agents.md\`     | Generated agent instructions with conventions and workflows |
| \`.agents/skills/\`     | Rendered skill files for agent use                          |

Your project is ready for agent integration.

---

**Next:** [Connecting Your Agent](./connecting-your-agent.md)
`,path:"getting-started/initializing-a-project.md"},{slug:"getting-started/installation",title:"Installation",content:`# Installation

This page covers installing kspec and verifying that it works.

## Prerequisites

- **Node.js 20 or later** — kspec requires Node.js 20+. Check your version with \`node --version\`.
- **Git** — kspec uses Git for its shadow branch. Any recent version works.
- A **Git repository** — you need an initialized repo to run \`kspec init\`. If you don't have one yet, \`git init\` in an empty directory is enough to get started.

## Install from npm

Install kspec globally so the \`kspec\` command is available everywhere:

\`\`\`bash
npm install -g @kynetic-ai/spec
\`\`\`

## Verify the installation

Run the version command to confirm kspec is installed:

\`\`\`bash
kspec --version
\`\`\`

You should see a semantic version number. If you see a "command not found" error, make sure npm's global executable directory is on your PATH. Start by checking the configured global prefix:

\`\`\`bash
npm config get prefix
\`\`\`

On Unix-like systems, global executables are normally in the \`bin/\` subdirectory of that prefix. npm's global executable location is platform-dependent, so use npm's installation guidance if your platform lays it out differently.

## Verify the help output

Run the top-level help to see all available commands:

\`\`\`bash
kspec --help
\`\`\`

You should see a list of commands including \`init\`, \`setup\`, \`task\`, \`item\`, and others. This confirms the CLI is correctly installed and runnable.

---

**Next:** [Initializing a Project](./initializing-a-project.md)
`,path:"getting-started/installation.md"},{slug:"getting-started/overview",title:"Overview",content:`# Overview

kspec is a specification and task management system for software projects that use AI coding agents. It gives your project a structured way to define **what** to build, track the **work** of building it, and keep agents aligned with your intentions through the entire lifecycle.

## Who kspec is for

kspec is designed for developers who:

- Direct AI agents (Claude Code, Cline, Cursor, Windsurf, or similar) to write code in their projects
- Want a durable record of what was decided, what was built, and why
- Need their agents to understand project context without lengthy re-explanations each session

If you work with AI coding agents and have ever wished they could pick up where they left off, follow your conventions, or understand the bigger picture of your project, kspec gives you the structure to make that happen.

## What kspec does

kspec organizes your project around three ideas:

- **Specs** define desired behavior using acceptance criteria. A spec says what the software should do, not how to build it.
- **Tasks** track the work of satisfying a spec. A task references a spec and carries its own lifecycle: start, work, submit for review, complete.
- **Agent instructions** are generated from your project's conventions, workflows, and specs so that every agent session starts with the right context.

These pieces work together in a loop:

\`\`\`
Define spec → Derive task → Agent works → Review → Merge → Complete → Next spec
\`\`\`

Each iteration produces commits linked back to the governing spec and task, giving you a traceable history from intention through delivery.

## How it fits into your workflow

kspec is a CLI tool that runs alongside your existing tools. It does not replace Git, your editor, or your CI system. Instead, it adds a layer of structured intent:

- **Before coding**: Define what you want in a spec with acceptance criteria
- **During coding**: Your agent reads the spec and works within the task lifecycle
- **After coding**: Reviews verify work against the spec's acceptance criteria, the approved work is merged through the project's integration process, and then the task is completed

Your specs and tasks live on a separate Git branch (the "shadow branch") so they never clutter your source-code branch history. The CLI handles all shadow branch operations automatically.

## What you will build in this guide

Over the next few pages you will:

1. **Install** kspec on your machine
2. **Initialize** a project with the shadow branch and agent configuration
3. **Connect** your AI coding agent so it can read kspec's instructions
4. **Complete your first action** by creating a spec, deriving a task, and working it

By the end, you will have a working kspec project and hands-on experience with the core loop.

---

**Next:** [Installation](./installation.md)
`,path:"getting-started/overview.md"},{slug:"getting-started/tutorial",title:"Getting Started With kspec",content:`# Getting Started With kspec

This tutorial walks through the smallest useful \`kspec\` loop in a fresh repository:

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
- \`gh\` installed if you want to open a pull request from the command line
- Node.js is also the default daemon runtime for \`kspec serve\`. Install [Bun](https://bun.sh) only if your project explicitly configures \`daemon.runtime: bun\`.

If you need install variants, cloned-project setup, or troubleshooting, read [INSTALL.md](../../INSTALL.md) first.

## 1. Install and initialize

Install \`kspec\` globally:

\`\`\`bash
npm install -g @kynetic-ai/spec
\`\`\`

Then initialize it in the repository you want to manage:

\`\`\`bash
cd your-project
git init
kspec init
kspec setup
kspec session start
\`\`\`

What those commands do:

- \`kspec init\` creates the manifest and \`.kspec/\` shadow worktree.
- \`kspec setup\` configures agent/runtime integration and author attribution.
- \`kspec session start\` shows your current project context and the next useful actions.

## 2. Create a small but real spec

The default project created by \`kspec init\` includes a top-level module. In a fresh repo that module is usually \`@main\`.

Confirm the available modules:

\`\`\`bash
kspec item list --type module
\`\`\`

Create a feature spec for a contributor guide:

\`\`\`bash
kspec item add --under @main \\
  --title "Contributor guide" \\
  --type feature \\
  --slug contributing-guide
\`\`\`

Add acceptance criteria that describe the outcome instead of the implementation details:

\`\`\`bash
kspec item ac add @contributing-guide \\
  --given "a new contributor opens the repository" \\
  --when "they look for setup and workflow guidance" \\
  --then "they can find a single contributor guide with the steps to set up, make changes, and submit work"

kspec item ac add @contributing-guide \\
  --given "the repository README is the main entry point" \\
  --when "a contributor starts there" \\
  --then "the README links to the contributor guide"
\`\`\`

Inspect the finished spec:

\`\`\`bash
kspec item get @contributing-guide
\`\`\`

That output is the contract for the implementation task you are about to create.

## 3. Derive a task from the spec

Create linked implementation work:

\`\`\`bash
kspec derive @contributing-guide
kspec tasks ready
\`\`\`

The derived task will usually be named \`@task-contributing-guide\`. Verify the exact ref from \`kspec tasks ready\` or \`kspec task get\`.

## 4. Start the task and isolate the branch

Move the task into active work:

\`\`\`bash
kspec task start @task-contributing-guide
kspec task branch @task-contributing-guide
\`\`\`

Add a note before or during the work so the task history explains what happened:

\`\`\`bash
kspec task note @task-contributing-guide \\
  "Writing CONTRIBUTING.md and linking it from README to satisfy @contributing-guide."
\`\`\`

## 5. Implement the smallest valid change

Now make the real repository change. For this tutorial, that means:

- create \`CONTRIBUTING.md\`
- document setup, workflow, and PR expectations
- add a link to it from \`README.md\`

After editing, review your result against the spec instead of guessing:

\`\`\`bash
kspec item get @contributing-guide
\`\`\`

Ask:

- Does the guide explain setup and change submission?
- Does the README link to it?
- Would a new contributor actually succeed from the documented path?

If yes, validate and inspect your work:

\`\`\`bash
kspec validate
git diff --stat
\`\`\`

For deeper command references while you work, use the generated skills and agent instructions rather than duplicating everything into your own notes:

- [AGENTS.md](../../AGENTS.md)
- \`.agents/skills/\` after \`kspec setup\`

## 6. Commit with task and spec trailers

The commit message should describe the change and keep the task/spec linkage in the body:

\`\`\`text
docs: add contributor guide

Add a first-pass CONTRIBUTING.md and link it from the README.

Task: @task-contributing-guide
Spec: @contributing-guide
\`\`\`

Create that commit with normal git:

\`\`\`bash
git add README.md CONTRIBUTING.md
git commit
\`\`\`

Those trailers matter because they let \`kspec\` and reviewers connect shipped changes back to the governing task and spec.

## 7. Submit the task for review

When the implementation and commit are ready:

\`\`\`bash
kspec task submit @task-contributing-guide
\`\`\`

\`kspec task submit\` moves the task to \`pending_review\`. A reviewer (human or agent) picks it up, creates a kspec review record, and reviews the work. See the review skill for details.

## 8. Complete the loop after merge

After the work is reviewed and merged:

\`\`\`bash
kspec task complete @task-contributing-guide \\
  --reason "Merged. Added contributor guide with spec/task linkage."
\`\`\`

At that point the spec-first loop is complete:

1. you defined the desired behavior in a spec
2. you derived work from that spec
3. you implemented and reviewed against acceptance criteria
4. you closed the task with a merge-linked completion note

## What to do next

Once the basic loop feels natural, expand into the parts of \`kspec\` that matter for larger projects:

- add more features and requirements with \`kspec item add\`
- capture vague ideas in \`kspec inbox add\`
- use \`kspec plan\` for multi-spec changes
- use \`kspec session start\` at the beginning of every work session
- use \`kspec agents generate\` so AI contributors inherit the same workflow conventions

For command details, prefer the built-in help and generated skill docs:

\`\`\`bash
kspec --help
kspec task --help
kspec item --help
\`\`\`

---

**Next:** [Where to Go Next](./where-to-go-next.md)
`,path:"getting-started/tutorial.md"},{slug:"getting-started/where-to-go-next",title:"Where to Go Next",content:`# Where to Go Next

You have installed kspec, initialized a project, connected your agent, and completed one full spec-to-task cycle. Here is where to go from here.

## Guides

The Guides section covers practical workflows you will use as your project grows:

- **Starting a New Project** — deeper coverage of project setup, module structure, and initial spec planning
- **Directing Your Agent** — how to give your agent effective instructions using kspec's task lifecycle and conventions

## Concepts

The Concepts section explains the ideas behind kspec in more depth:

- **What kspec Is** — the design philosophy and how specs, tasks, and agent instructions relate
- **The Shadow Branch** — how the \`kspec-meta\` branch works, why specs live separately from code, and how synchronization works

## Useful commands

As you continue working with kspec, these commands will become part of your routine:

\`\`\`bash
kspec session start            # Orient yourself at the start of a session
kspec inbox add "idea"         # Capture a vague idea for later triage
kspec item add --under @module # Create a new spec item
kspec derive @spec-ref         # Derive tasks from a spec
kspec validate                 # Check spec/task consistency
kspec search "keyword"         # Search across specs, tasks, and inbox
kspec --help                   # Full command reference
\`\`\`

## Getting help

If something goes wrong:

\`\`\`bash
kspec doctor                   # Check project health
kspec shadow status            # Check shadow branch state
kspec shadow repair            # Fix a broken shadow worktree
\`\`\`

For command-specific help, append \`--help\` to any command:

\`\`\`bash
kspec task --help
kspec item --help
kspec setup --help
\`\`\`
`,path:"getting-started/where-to-go-next.md"},{slug:"getting-started/your-first-action",title:"Your First Action",content:`# Your First Action

This page walks through creating a spec, deriving a task, and working it to completion. By the end you will have completed one full cycle of the kspec loop.

## Create a spec

A spec defines what you want to build. It lives under a module (your project's top-level module was created by \`kspec init\`). Find your module's slug:

\`\`\`bash
kspec item list --type module
\`\`\`

You should see at least one module, typically \`@main\`. Create a feature spec under it:

\`\`\`bash
kspec item add --under @main \\
  --title "Contributor guide" \\
  --type feature \\
  --slug contributing-guide
\`\`\`

## Add acceptance criteria

Acceptance criteria describe the observable outcomes that prove the spec is satisfied. Add two criteria for the contributor guide:

\`\`\`bash
kspec item ac add @contributing-guide \\
  --given "a new contributor opens the repository" \\
  --when "they look for setup and workflow guidance" \\
  --then "a CONTRIBUTING.md file documents the steps to set up, make changes, and submit work"
\`\`\`

\`\`\`bash
kspec item ac add @contributing-guide \\
  --given "the repository README exists" \\
  --when "a contributor reads it" \\
  --then "the README links to the contributor guide"
\`\`\`

Inspect the finished spec to confirm everything looks right:

\`\`\`bash
kspec item get @contributing-guide
\`\`\`

## Derive a task

Create a task from the spec. This links the work to the spec's acceptance criteria:

\`\`\`bash
kspec derive @contributing-guide
\`\`\`

Check what tasks are now ready:

\`\`\`bash
kspec tasks ready
\`\`\`

You should see a task like \`@task-contributing-guide\` in the pending state.

## Start the task

Move the task into active work:

\`\`\`bash
kspec task start @task-contributing-guide
\`\`\`

Create a branch for the work:

\`\`\`bash
kspec task branch @task-contributing-guide
\`\`\`

This creates (or resumes) a deterministic branch named after the task, which reviewers and automated agents can find consistently. You do not need to invent a branch name yourself.

Add a note explaining your approach:

\`\`\`bash
kspec task note @task-contributing-guide \\
  "Writing CONTRIBUTING.md and linking it from README."
\`\`\`

## Do the work

Create \`CONTRIBUTING.md\` in your repository root with the setup and workflow instructions for your project. Then add a link to it from your \`README.md\`.

After editing, review your work against the acceptance criteria:

\`\`\`bash
kspec item get @contributing-guide
\`\`\`

Check each criterion: Does the guide explain setup and contribution workflow? Does the README link to it? If yes, your implementation satisfies the spec.

## Commit with trailers

Commit your changes with task and spec trailers in the commit message:

\`\`\`bash
git add CONTRIBUTING.md README.md
git commit -m "docs: add contributor guide

Task: @task-contributing-guide
Spec: @contributing-guide"
\`\`\`

The \`Task:\` and \`Spec:\` trailers let kspec and reviewers trace commits back to the governing spec and task. You can find related commits later with \`kspec log @task-contributing-guide\`.

## Submit for review

When the work is complete, submit the task:

\`\`\`bash
kspec task submit @task-contributing-guide
\`\`\`

This moves the task to \`pending_review\`. A reviewer (human or agent) can now review the work against the acceptance criteria.

## Complete the task

After the work is reviewed and merged, close the loop:

\`\`\`bash
kspec task complete @task-contributing-guide \\
  --reason "Merged. Added contributor guide with spec/task linkage."
\`\`\`

The task is now complete. You have defined a spec, derived a task, implemented the work, and closed the loop with a traceable completion reason.

---

**Next:** [Tutorial](./tutorial.md)
`,path:"getting-started/your-first-action.md"},{slug:"guides",title:"Guides",content:`# Guides

The Guides section covers common kspec workflows as step-by-step procedures framed around a goal you want to accomplish. Each guide states its prerequisites, walks through the steps, and ends with a way to verify you succeeded.

- [Starting a New Project](./starting-a-new-project.md) — set up a kspec project with modules and initial specs
- [Directing Your Agent Effectively](./directing-your-agent.md) — frame requests so your agent stays aligned with specs
- [Importing and Approving a Plan](./importing-and-approving-a-plan.md) — create a plan document, import it, and derive tasks
- [Authoring and Completing a Task](./authoring-and-completing-a-task.md) — work a task through the full lifecycle with AC coverage
- [Reviewing an Agent's Work](./reviewing-an-agents-work.md) — evaluate submitted work against acceptance criteria
- [Working With Local Resources](./working-with-local-resources.md) — attach files to plans and reviews, reference them from markdown and tasks, and serve them through the daemon API and static export
- [Configuring Agent Runners](./configuring-agent-runners.md) — define named runners, split project and system config, bind credentials, validate the effective contract, and migrate existing agents
- [Configuring Dispatch Workspaces](./configuring-dispatch-workspaces.md) — configure integration targets, managed worktree location, publication, bootstrap, and remote synchronization
- [Controlling the Dispatch Lifecycle](./controlling-dispatch-lifecycle.md) — pause, resume, hard-stop, recover, and verify dispatch globally or for one canonical task
- [Upgrading kspec to a New Version](./upgrading-kspec.md) — install a new release and update your project
- [Recovering From Shadow Branch Issues](./recovering-from-shadow-branch-issues.md) — diagnose and fix shadow branch problems
`,path:"guides/index.md"},{slug:"guides/authoring-and-completing-a-task",title:"Authoring and Completing a Task",content:`# Authoring and Completing a Task

This guide covers the full task lifecycle: creating a task, working it, annotating acceptance criteria, and closing the loop. By the end, you will have completed a task with traceable commits and AC coverage.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- At least one spec with acceptance criteria in your project

## Steps

### 1. Create or find a task

If a task already exists, find it:

\`\`\`bash
kspec tasks ready
\`\`\`

If you need to create one from a spec:

\`\`\`bash
kspec derive @your-spec
\`\`\`

This creates a task linked to the spec's acceptance criteria. Check the task details:

\`\`\`bash
kspec task get @task-your-spec
\`\`\`

For all derivation options, run \`kspec derive --help\`.

### 2. Start the task

Move the task into active work:

\`\`\`bash
kspec task start @task-your-spec
\`\`\`

### 3. Create a branch

Create a deterministic branch for the task:

\`\`\`bash
kspec task branch @task-your-spec
\`\`\`

This creates or resumes a branch named after the task. Reviewers and automated agents can find it consistently.

### 4. Read the acceptance criteria

Before writing any code, read every AC on the spec:

\`\`\`bash
kspec item get @your-spec
\`\`\`

For each AC, identify what code to write, what edge cases to consider, and what tests to create. Record your approach:

\`\`\`bash
kspec task note @task-your-spec \\
  "Approach: implementing AC-1 with existing auth helper, AC-2 needs new validation logic."
\`\`\`

### 5. Write tests first

For each acceptance criterion, create an annotated test:

\`\`\`javascript
// AC: @your-spec ac-1
it("should redirect to dashboard after valid login", () => {
  // test implementation
});
\`\`\`

The \`AC:\` annotation links the test to the criterion it proves. Write test skeletons before implementing production code — this ensures coverage is driven by the spec.

### 6. Implement the feature

Write the code to make your tests pass. Add notes when you make significant decisions:

\`\`\`bash
kspec task note @task-your-spec \\
  "Used exponential backoff for retry logic. Max 3 retries based on API rate limits."
\`\`\`

### 7. Commit with trailers

Commit your changes with task and spec trailers:

\`\`\`bash
git add src/ tests/
git commit -m "feat: add user login flow

Task: @task-your-spec
Spec: @your-spec"
\`\`\`

The \`Task:\` and \`Spec:\` trailers let kspec trace commits back to the governing spec.

### 8. Verify AC coverage

Before submitting, confirm each AC has a test:

\`\`\`bash
kspec validate
\`\`\`

This reports any uncovered acceptance criteria.

### 9. Submit for review

When the work is complete:

\`\`\`bash
kspec task submit @task-your-spec
\`\`\`

This moves the task to \`pending_review\`. A reviewer will evaluate the work against the acceptance criteria.

### 10. Complete after merge

After the review approves the work and it is merged:

\`\`\`bash
kspec task complete @task-your-spec \\
  --reason "Merged. Implemented login flow with AC coverage."
\`\`\`

The task is now complete with a traceable reason.

## Verification

Run the following to confirm the task lifecycle is complete:

\`\`\`bash
kspec task get @task-your-spec
\`\`\`

The output should show \`Status: completed\` with your completion reason. You can also trace the work:

\`\`\`bash
kspec log @task-your-spec
\`\`\`

This shows all commits linked to the task through trailers.
`,path:"guides/authoring-and-completing-a-task.md"},{slug:"guides/configuring-agent-runners",title:"Configuring Agent Runners",content:'# Configuring Agent Runners\n\nThis guide walks through configuring named agent runners in a kspec project. By the end you will know how to keep an existing agent on the legacy adapter path, define a named runner that an agent can reference, split portable settings from machine-local settings across the two config layers, bind credentials without committing them, validate the result, and migrate existing projects gradually.\n\nFor the mental model behind runners — what they are, why the two-layer split exists, and how resolution works — read [Agent Runners](../concepts/agent-runners.md) first.\n\n## Prerequisites\n\n- A kspec project with an initialized shadow branch (`kspec doctor` reports a healthy shadow worktree)\n- An agent definition you can edit (the built-in agents from `kspec setup` are fine to use as a base)\n- Familiarity with the agent and dispatch model — see [Agents and Dispatch](../concepts/agents-and-dispatch.md)\n\n## File Locations\n\nRunner configuration lives in two files. You will edit one or both depending on what you are storing.\n\n- **Project layer** — `.kspec/project.runners.yaml` in the shadow worktree. Visible from the main checkout at the same relative path. Tracked on the shadow branch and shared across every clone of the project.\n- **System layer** — `<daemon-config-dir>/projects/<project-key>/runners.yaml` under the user\'s kspec daemon config directory. `<project-key>` is the SHA-256 digest of the canonical absolute project root, so the path is deterministic but does not embed the raw path. The file is local to your machine and never committed.\n\nRun `kspec agent runners validate` from the project root to see which file paths kspec resolved for the current project (the validator reports them when either layer has issues).\n\n## Steps\n\n### 1. Keep an existing agent on the legacy adapter path\n\nYou do not need to change anything to keep using the legacy `adapter` path. An agent definition that points directly at an adapter continues to work:\n\n```yaml kspec-agent\n# kynetic.meta.yaml — legacy agent, no runner field\nagents:\n  - id: task-worker\n    adapter: claude-agent-acp\n    dispatch:\n      - on: task.ready\n        filter:\n          automation: eligible\n      - on: task.in_progress\n      - on: task.needs_work\n```\n\nWhen kspec invokes this agent it takes the implicit path: resolve `claude-agent-acp` from the adapter registry and spawn it with the adapter\'s defaults. No runner config is loaded, no merge happens, and `kspec agent list` shows the agent with the resolved adapter id but no `runner:` line — the runner row is only rendered for agents that declare one.\n\nThis is the path for every existing project until you opt into a runner.\n\n### 2. Define a named runner in system config\n\nA runner becomes available to agents as soon as it appears in either config layer with a resolvable adapter. Because `kind` and `adapter` are required to make a runner effective, and `adapter` is system-only at the schema level for any runner that does not also exist in project config, the smallest useful runner lives in system config.\n\nCreate `<daemon-config-dir>/projects/<project-key>/runners.yaml` with a minimal entry:\n\n```yaml\n# System layer — <daemon-config-dir>/projects/<project-key>/runners.yaml\nrunners:\n  default-acp:\n    kind: acp_process\n    adapter: claude-agent-acp\n```\n\nAfter this file is in place, `default-acp` is a valid named runner. You can confirm it is loaded with:\n\n```bash\nkspec agent runners validate\n```\n\nThe output names the runner, its kind, and the resolved adapter:\n\n```\nRunner validation\n\n  default-acp [valid]\n    kind: acp_process\n    resolved_adapter: claude-agent-acp\n    command_source: adapter\n    cwd_source: invocation\n    args_source: none\n\nOK runner validation passed\n```\n\n`command_source: adapter` here means the runner did not override the executable, so the adapter\'s registered command is what will spawn.\n\n### 3. Add portable non-secret values in project config\n\nMove project-wide settings that should live with the repo into the project layer. Project config carries only `env.set` literals (non-secret), `privacy`, and `diagnostics`:\n\n```yaml\n# Project layer — .kspec/project.runners.yaml\nrunners:\n  default-acp:\n    env:\n      set:\n        NODE_ENV: production\n        KSPEC_PROJECT_TAG: my-project\n    privacy:\n      disable_nonessential_traffic: true\n    diagnostics:\n      retain_raw_logs: on_failure\n```\n\nThese values now apply to every machine that runs this project — they ship with the shadow branch. The project layer schema enforces the security boundary: if you tried to declare `ANTHROPIC_API_KEY` (or any name containing `API_KEY`, `AUTH_TOKEN`, `SECRET`, `PASSWORD`, etc.) under `env.set`, the project layer would be rejected before becoming part of the effective registry.\n\n### 4. Override a project value from system config\n\nWhen the system layer declares the same field as the project layer, the system value wins. This is how you handle machine-specific deviations from the project default without editing the shared project file.\n\nContinuing the example: suppose one developer wants to disable the privacy default on their machine for debugging. They add it to their system file under the same runner name:\n\n```yaml\n# System layer — overriding a project default\nrunners:\n  default-acp:\n    kind: acp_process\n    adapter: claude-agent-acp\n    privacy:\n      disable_nonessential_traffic: false\n```\n\n`kspec agent runners validate` now reports the override:\n\n```\n  default-acp [valid]\n    kind: acp_process\n    resolved_adapter: claude-agent-acp\n    command_source: adapter\n    cwd_source: invocation\n    args_source: none\n    overrides: privacy.disable_nonessential_traffic\n```\n\n`overrides` lists the fields the system layer pulled away from the project layer. `env.set` keys merge per-key — the system layer only overrides keys it explicitly declares, leaving the rest of the project\'s `env.set` intact.\n\n### 5. A complete system runner with env policy, secrets, args, cwd, and an executable\n\nThe full set of process-shaping fields lives in the system layer. Here is a runner that exercises every one of them:\n\n```yaml\n# System layer — full process-shaping example\nrunners:\n  acp-with-secrets:\n    kind: acp_process\n    adapter: claude-agent-acp\n    process:\n      # Optional command reference. Overrides the adapter\'s registered command.\n      executable: /opt/kspec/bin/claude-wrapper\n      # Non-secret arguments appended to the spawn. Secret-shaped values\n      # (Bearer tokens, --api-key flag pairs) are rejected here at load time.\n      args:\n        - "--profile"\n        - "team-default"\n      # Working directory for the child process only. Does not affect daemon cwd.\n      cwd: /opt/kspec/work-roots/agents\n    env:\n      # Inheritance policy. Default is `minimal` (PATH, HOME, USER, LOGNAME,\n      # SHELL, LANG, LC_*, TERM, TMPDIR/TMP/TEMP, PWD). `ambient` passes the\n      # whole host env. `none` inherits nothing.\n      inherit: minimal\n      # Explicit allow-list of additional host vars to forward.\n      pass:\n        - "AWS_REGION"\n        - "NODE_OPTIONS"\n      # Non-secret literals. Same rejection rules as project layer apply.\n      set:\n        KSPEC_RUN_LABEL: "team-default"\n      # Credential source bindings. System layer only.\n      secrets:\n        ANTHROPIC_API_KEY:\n          source: user_env\n          required: true\n    privacy:\n      disable_nonessential_traffic: true\n    diagnostics:\n      retain_raw_logs: on_failure\n```\n\nA few things to call out:\n\n- **`env.secrets` is system-only.** The project layer schema rejects any `env.secrets` block. The source identifier (`user_env`) names where to fetch the value at invocation time; the actual secret value never appears in this file, in session metadata, in diagnostics, or in `kspec agent runners validate` output.\n- **`required: true` blocks invocation when the secret cannot be resolved.** If `ANTHROPIC_API_KEY` is not set in the user environment when an agent invocation prepares, the spawn fails before the adapter starts with a `missing_secret` diagnostic.\n- **`process.cwd` is invocation-local.** It applies only to the spawned child process. The daemon and any other parent processes keep their own cwd. Absolute paths (like the `cwd: /opt/kspec/work-roots/agents` above) are used as-is after normal path normalization. Relative paths are resolved against the directory containing this system `runners.yaml` file — never against the daemon or CLI parent process cwd — so the effective cwd is stable regardless of which process launched kspec.\n- **`process.executable` is optional.** When set, it overrides the adapter\'s registered command. When omitted, the adapter\'s registered command is used and the validator reports `command_source: adapter`.\n- **`process.args` are appended to the spawn**, never persisted into the adapter definition. They reach the child process only for runner-backed invocations of this runner.\n\nValidating this runner shows the per-field source attribution and confirms no secrets leaked into the diagnostic surface:\n\n```\n  acp-with-secrets [valid]\n    kind: acp_process\n    resolved_adapter: claude-agent-acp\n    command_source: runner.system\n    cwd_source: runner.system\n    args_source: runner.system\n```\n\n### 6. Reference the runner from an agent\n\nWith the runner registered, point an agent definition at it. The `runner` field is an optional string that names a runner from the effective registry:\n\n```yaml kspec-agent\n# kynetic.meta.yaml — agent that uses a named runner\nagents:\n  - id: task-worker\n    runner: acp-with-secrets\n    # Adapter is retained only as legacy metadata. Invocation uses the runner.\n    adapter: claude-agent-acp\n    dispatch:\n      - on: task.ready\n        filter:\n          automation: eligible\n      - on: task.in_progress\n      - on: task.needs_work\n```\n\nYou can set or clear the field with `kspec meta set`:\n\n```bash\n# Set a runner reference\nkspec meta set task-worker --runner acp-with-secrets\n\n# Clear the runner reference (agent falls back to adapter / default)\nkspec meta set task-worker --clear-runner\n```\n\n`kspec agent list` shows the runner name and the resolved adapter on every agent. For agents that have both fields, the runner takes invocation precedence — the legacy `adapter` field is reported only for backward compatibility and is not used to spawn.\n\n### 7. Validate the effective configuration\n\nRun the validator any time you change either config layer. It loads both layers, merges them, and reports the effective runner contract without spawning anything.\n\nHuman-readable mode lists each runner with its sources, overrides, and any diagnostics:\n\n```bash\nkspec agent runners validate\n```\n\n`--runner <name>` filters the report to a single named runner:\n\n```bash\nkspec agent runners validate --runner acp-with-secrets\n```\n\n`--json` emits a structured payload suitable for scripting. The shape is stable and matches the operator-surface contract:\n\n```bash\nkspec agent runners validate --json\n```\n\n```json\n{\n  "ok": true,\n  "runners": [\n    {\n      "runner": "acp-with-secrets",\n      "kind": "acp_process",\n      "resolved_adapter": "claude-agent-acp",\n      "command_source": "runner.system",\n      "cwd_source": "runner.system",\n      "args_source": "runner.system",\n      "status": "valid",\n      "sources": {\n        "kind": "system",\n        "adapter": "system",\n        "process_executable": "system",\n        "process_args": "system",\n        "process_cwd": "system",\n        "env_inherit": "system",\n        "env_pass": "system",\n        "env_set_keys": {\n          "KSPEC_RUN_LABEL": "system"\n        },\n        "env_secrets": "system",\n        "privacy_disable_nonessential_traffic": "system",\n        "diagnostics_retain_raw_logs": "system"\n      },\n      "overrides": [],\n      "diagnostics": []\n    }\n  ],\n  "issues": []\n}\n```\n\nThe output fields are:\n\n| Field                   | Meaning                                                                                                                                                          |\n| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |\n| `runner`                | Configured runner name.                                                                                                                                          |\n| `kind`                  | Runner kind. Currently `acp_process`.                                                                                                                            |\n| `resolved_adapter`      | Registered adapter id that the runner spawns.                                                                                                                    |\n| `command_source`        | Where the executable came from: `runner.project`, `runner.system`, `runner.merged`, `adapter` (adapter default), `invocation`, `auto_approve`, or `none`.        |\n| `cwd_source`            | Where the working directory came from. Same vocabulary as `command_source`.                                                                                      |\n| `args_source`           | Where the appended args came from. Same vocabulary.                                                                                                              |\n| `status`                | `valid` or `invalid`. The runner is invalid when any per-runner diagnostic is recorded.                                                                          |\n| `sources`               | Per-field origin map: each field is `project`, `system`, or `default` (or `null` for fields the runner did not declare). `env_set_keys` is a per-key map.        |\n| `overrides`             | Field paths where the system layer overrode a project value. Empty when nothing was overridden.                                                                  |\n| `diagnostics`           | Redacted per-runner issues. Each carries a stable `reason` code and an actionable, secret-free `message`. Empty when the runner is valid.                        |\n| `issues` (report-level) | Validation issues that are not scoped to a single runner — for example, YAML parse errors in either layer file, or an unknown runner name passed via `--runner`. |\n| `ok`                    | `true` only when every selected runner reports `status: valid` and there are no report-level issues.                                                             |\n\nThe exit status follows `ok`: `0` when every selected runner is valid and there are no report-level issues; non-zero otherwise. This makes the command safe to wire into CI or pre-spawn checks.\n\n#### Common failure diagnostics\n\nThe `reason` field on diagnostics is stable. The most common codes you will see:\n\n| `reason`                       | What it means                                                                                                                             | Where to fix it                                                                                               |\n| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |\n| `unknown_runner`               | An agent references a runner name that is not in the effective registry, or `--runner <name>` was passed with a name that does not exist. | Project runner config, system runner config, or the agent definition\'s `runner` field.                        |\n| `invalid_adapter`              | The runner declares an `adapter` value that is not a registered adapter id.                                                               | System runner config.                                                                                         |\n| `missing_adapter_registration` | The runner refers to an adapter that is no longer registered at validation time (e.g., a plugin that has not loaded).                     | The adapter registration — make sure the adapter is installed and registered, or change the runner\'s adapter. |\n| `unspawnable_command`          | `process.executable` cannot be found, is not executable, or failed a quick spawn probe.                                                   | System runner config — fix the path or permissions.                                                           |\n| `invalid_cwd`                  | `process.cwd` does not exist, is not a directory, or is not accessible.                                                                   | System runner config — fix the directory or its permissions.                                                  |\n| `invalid_args`                 | `process.args` contains a secret-shaped value (Bearer token, `--api-key=…`, or the value following a credential-named flag).              | System runner config — move the credential to `env.secrets` and refer to it by env var name in your adapter.  |\n| `missing_secret`               | A `required: true` `env.secrets` binding could not be resolved from its source at invocation time.                                        | The credential source (e.g., user environment) — set the variable or change `required`.                       |\n| `preflight_failure`            | Generic preflight error — usually a YAML parse error or a schema-level rejection in either layer file.                                    | The file path named in the diagnostic message and detail block.                                               |\n\nDiagnostic messages are redacted: the validator never prints secret values, even when reporting that a secret-shaped value was rejected. Args diagnostics name the offending index; env diagnostics name the offending key.\n\n## Migration Guidance\n\nRunner configuration is additive. Adopt it gradually rather than as a sweeping change.\n\n**Existing projects do not need immediate changes.** Every agent that declares `adapter` continues to work without a runner. Nothing about the legacy invocation path changed. You can leave a project on the adapter path indefinitely.\n\n**For new projects, prefer named runners.** When you set up a new project, define a runner for each distinct execution profile (worker, reviewer, headed) and have agents reference the runner by name. This puts adapter-specific env, args, and cwd settings in a place where they can be inspected and overridden without editing agent definitions.\n\n**Move project-wide non-secret settings into the project layer.** If you have `env.set` literals or privacy/diagnostic preferences that every machine should share, put them in `.kspec/project.runners.yaml`. They travel with the shadow branch and apply to every clone.\n\n**Keep secret values in system secret bindings.** Never put API keys, OAuth tokens, or any credential variable in `env.set` — the project layer rejects them at load time, and even the system layer will reject the literal. Use `env.secrets` bindings in the system layer instead, with `required: true` for credentials that should block spawn when missing.\n\n**Keep project runner config limited to portable values.** The project layer is intentionally narrow. If a setting depends on a specific machine, user, file path, or credential, it belongs in the system layer. If a setting could be shared across every clone of the project without modification, it belongs in the project layer.\n\nWhen you migrate an existing agent, the typical sequence is:\n\n1. Create a system runner that mirrors the agent\'s current adapter behavior (`kind: acp_process`, `adapter: <existing-adapter>`).\n2. Move any project-wide non-secret env or privacy settings into `.kspec/project.runners.yaml` under the same runner name.\n3. Move any machine-local env, executable, args, cwd, or credential bindings into the system file.\n4. Set `runner: <name>` on the agent. Leave `adapter` in place as legacy metadata if you want; the runner wins at invocation time.\n5. Run `kspec agent runners validate` to confirm the effective contract.\n6. Smoke-test the agent (one-shot `kspec agent run <agent-id>` or a queued dispatch) to confirm the new invocation path works end-to-end.\n\nYou can stop at any of these steps. An agent with only a project-layer entry and no system entry will fail validation (no `kind`/`adapter`); but the agent itself still works through the legacy adapter path until you set the `runner` field on it.\n\n## Looking Ahead: The Headed Claude Code Sidecar\n\nA future **headed Claude Code sidecar** is planned as a separate runner kind that consumes the same contract described above. It will be a runner alongside `acp_process` rather than a replacement for it. From an operator perspective the workflow is the same as for any other runner:\n\n- The sidecar will appear in `runners.yaml` as a system-layer entry with its own `kind` value and a registered adapter.\n- The same **layered runner config** applies: project layer for portable preferences, system layer for process settings, command references, args, cwd, env policy, and credential bindings.\n- The same **env and secret boundaries** apply: project config remains non-secret, `env.secrets` stays system-only, `required: true` bindings block invocation when missing, and diagnostics redact secret material.\n- The same **invocation inputs** apply: optional `process.executable`, non-secret `process.args`, child-process-only `process.cwd`, and per-field source diagnostics in `kspec agent runners validate`.\n- The same **dispatch compatibility** applies: dispatch preflight accepts the sidecar runner the moment its adapter is registered, and rejects it with the same per-reason diagnostics if validation fails.\n- The same **operator visibility** applies: `kspec agent list`, the daemon agent and dispatch APIs, and the Web UI show the sidecar runner name, the resolved adapter, and any redacted diagnostics on every agent and invocation that uses it.\n\nWhen the sidecar runner kind ships, configuring it will be no different from configuring any other runner described in this guide — you change the `kind` value and point at its adapter; everything else (env, secrets, args, cwd, validation, visibility) reuses the contract above.\n\n## Verification\n\nAfter configuring a runner, work through this checklist:\n\n- `kspec agent runners validate` returns `OK runner validation passed` and exits `0`.\n- `kspec agent runners validate --json` reports `ok: true` and an empty `issues` array.\n- `kspec agent list` shows the expected `runner` name and `resolved_adapter` for the agent.\n- A one-shot invocation completes: `kspec agent run <agent-id> --task @task-ref --dry-run` succeeds and the dry-run summary shows the expected `Runner:`, `Adapter:`, `Command:`, and `Env policy:` lines.\n\nIf any of these fail, read the `diagnostics` block from the validator first — the `reason` code and message identify both the field that is wrong and which config layer owns the fix.\n',path:"guides/configuring-agent-runners.md"},{slug:"guides/configuring-dispatch-workspaces",title:"Configuring Dispatch Workspaces",content:`# Configuring Dispatch Workspaces

## Goal

Configure where dispatch creates task workspaces, which branch they start from, how completed work is published, and which bootstrap steps prepare workers and reviewers. By the end, you will have a schema-valid project configuration and agent-specific bootstrap policy without taking over workspace lifecycle management from kspec.

## Prerequisites

- A kspec project with setup completed and a healthy shadow worktree
- A Git repository with the intended integration branch available locally
- Permission to edit the root \`kspec.config.yaml\` and the project's agent definitions
- Any package manager, compiler, or other tool used by your bootstrap commands already installed on the dispatch host

If project setup is incomplete, run \`kspec setup\` first. Use \`kspec setup --help\` for its complete option list.

## Steps

### 1. Add the minimal project configuration

The root \`kspec.config.yaml\` owns settings shared by every dispatched agent. This complete example makes each dispatch key explicit:

\`\`\`yaml kspec-config
dispatch:
  base_branch: dev
  worktree_root: .kspec-worktrees
  publication_mode: manual_merge
  sync_interval: 60
  remote_sync: true
  bootstrap:
    steps:
      - run: npm ci
        name: install-dependencies
        roles: [worker, reviewer]
        idempotent: true
        allow_tracked_changes: false
        reviewer_rerun_allowed: true
\`\`\`

All dispatch fields are optional. The defaults are:

| Field              | Default                                  | Meaning                                                                              |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| \`base_branch\`      | resolved fallback                        | Default integration target when a task has no plan target                            |
| \`worktree_root\`    | \`.kspec-worktrees\`                       | Root for dispatcher-managed worktrees                                                |
| \`publication_mode\` | \`auto\`                                   | Publication behavior selected from the supported modes below                         |
| \`bootstrap.steps\`  | \`[]\`                                     | Project bootstrap steps, run before agent steps                                      |
| \`sync_interval\`    | \`60\`                                     | Seconds between periodic target synchronization; \`0\` disables only the periodic pass |
| \`remote_sync\`      | enabled exactly when a Git remote exists | Whether dispatch performs remote push and pull operations                            |

The three publication modes are:

- \`manual_merge\` — keep work on the canonical task branch for reviewed local merge into the integration target.
- \`pull_request\` — publish through a GitHub pull request when the required remote and GitHub tooling are available.
- \`auto\` — let kspec select publication behavior from the environment. This is the default.

Use the final integrated values for your project. Do not copy a project-specific branch name or publication policy merely because it appears in another repository.

### 2. Understand base and plan target resolution

For a task derived from a plan with a plan branch, that plan branch is the integration target. It takes precedence over \`dispatch.base_branch\`. For other tasks, the configured base branch takes precedence over kspec's deterministic fallback.

This resolution is source-bound to the task and plan. A dispatched prompt records the canonical branch and integration target chosen for that workspace; bootstrap commands do not choose or rewrite them.

### 3. Choose the worktree root

A relative \`worktree_root\` is resolved from the project root. An absolute path remains absolute. The default keeps transient worktrees under \`.kspec-worktrees\` beside the main checkout.

Project setup and upgrade maintain a sentinel-delimited kspec block in the root \`.gitignore\`. A relative dispatch root is included in that managed block. An absolute root receives no managed repository-relative ignore entry, even when the chosen path is inside the repository, so prefer an absolute location outside the repository. Let kspec maintain this block instead of hand-editing its generated entries.

The configured root is a location policy, not an ownership claim over every directory beneath it. Dispatch's workspace registry is authoritative, and cleanup is limited to artifacts whose dispatch ownership can be established.

### 4. Select publication mode

Choose a mode that matches the project's review policy:

1. Use \`manual_merge\` when reviewed task branches are merged locally into an integration branch.
2. Use \`pull_request\` only when GitHub pull requests are the supported publication path and the host has the required authentication and tooling.
3. Leave \`auto\` when environment-based selection is intentional.

Publication mode controls how completed work is handed to review and integration. It does not change workspace ownership, bootstrap safety, or lifecycle controls.

### 5. Define project bootstrap

Project bootstrap prepares every dispatch-managed workspace before the agent prompt is delivered. Steps run in declaration order. Project steps always run before per-agent steps.

Each step supports these fields:

- \`run\` — required shell command, executed with the workspace as its working directory.
- \`name\` — stable diagnostic name; kspec supplies an indexed name when omitted.
- \`roles\` — optional \`worker\` and/or \`reviewer\` filter. Omit it to apply the step to both roles.
- \`idempotent\` — declares that rerunning the step is safe.
- \`allow_tracked_changes\` — explicit opt-in when a step is intended to modify tracked files. The default is \`false\`; a tracked-file status change otherwise fails bootstrap.
- \`reviewer_rerun_allowed\` — explicitly permits a reviewer rerun even when idempotence alone is not declared.

Use bootstrap for deterministic workspace preparation such as dependency installation or generated build artifacts. Keep source edits in the agent's assigned task work, not in bootstrap.

### 6. Add per-agent bootstrap only where needed

An agent definition can append steps after the project sequence. Dispatch rules use \`on\` and \`filter\`, and automation eligibility is filtered per event rather than by a global agent default:

\`\`\`yaml kspec-agent
dispatch:
  - on: task.ready
    filter:
      automation: eligible
      tags: [dispatch]
      priority: 1
  - on: task.in_progress
    filter:
      automation: eligible
  - on: task.needs_work
    filter:
      automation: eligible
  - on: task.pending_review
bootstrap:
  steps:
    - run: npm run build
      name: build-agent-artifacts
      roles: [worker, reviewer]
      idempotent: true
      allow_tracked_changes: false
      reviewer_rerun_allowed: true
\`\`\`

The example intentionally leaves \`task.pending_review\` without an automation filter: filters belong to the event rule that needs them. Check current agents with \`kspec agent list\`; use \`kspec agent list --help\` for the complete list options.

### 7. Account for worker and reviewer behavior

Worker and reviewer workspaces have different Git shapes: workers use the canonical task branch, while reviewers use detached snapshots. Bootstrap state is recorded per role.

When a worker bootstrap state is still valid and no reviewer-specific steps apply, the reviewer reuses that valid state without rerunning commands. When reviewer steps must run, every applicable step must be safe to rerun: \`idempotent: true\` or \`reviewer_rerun_allowed: true\`. Otherwise reviewer bootstrap fails instead of guessing that a side effect is safe.

A change to bootstrap configuration, a changed canonical branch head, or a previous bootstrap failure invalidates recorded state and causes the applicable safety checks to run again.

### 8. Keep bootstrap and runner environments separate

Bootstrap steps are shell commands run directly in the assigned dispatch workspace. Named runner configuration shapes the agent process; it does not wrap project or per-agent bootstrap commands. Validate named runners separately with \`kspec agent runners validate\`, and use \`kspec agent runners validate --help\` for the full validator options. See [Configuring Agent Runners](./configuring-agent-runners.md) for runner environment and credential policy.

Bootstrap inherits the host environment except for dispatcher's own daemon runtime-mode variables, then adds the environment intended for the step. It also exposes the bootstrap role, source, and step name to the command. Because this is process environment, do not use bootstrap output as a secret transport.

kspec records a bounded tail of combined standard output and error for bootstrap diagnostics, including successful steps. The tail is diagnostic evidence, not a redacted secret store. Never echo credentials, tokens, or other sensitive values from a bootstrap command.

One-shot \`kspec agent run\` invocations are not dispatch-managed workspaces and do not receive this workspace bootstrap contract. Use \`kspec agent run --help\` for the complete one-shot invocation options.

### 9. Configure remote synchronization deliberately

When \`remote_sync\` is omitted, dispatch enables it exactly when the repository has a remote. Without a remote, dispatch remains local-only without degraded status or warnings. Set \`remote_sync: false\` to choose local-only operation even when a remote exists.

With remote synchronization enabled, target updates are fast-forward only; dispatch does not create merge commits to reconcile a divergent target. Periodic synchronization is deferred for a target while that target has an active reviewer. An on-start or before-provision synchronization is still possible when \`sync_interval\` is \`0\`; that value disables only the periodic pass.

Transient fetch or connectivity failures emit warnings and leave the target out of degraded state so dispatch can retry. Failures that make target mutation unsafe, including divergence, are reported as degraded target state rather than silently rewriting history. For a degraded target, public agent status identifies the affected branch, failure kind and reason, and when degradation began. Inspect it with \`kspec agent status\`; use \`kspec agent status --help\` for the complete status options.

Remote synchronization is intentionally limited. It does not promise automatic conflict resolution, merge commits, or recovery from arbitrary remote topology. Repair the branch or remote through the project's normal reviewed Git workflow, then let dispatch retry its fast-forward path.

### 10. Use supported inspection and recovery paths

For configuration and bootstrap diagnosis:

1. Run \`kspec agent status\` to inspect dispatch and degraded-target status. See \`kspec agent status --help\` for all output modes.
2. Run \`kspec task get <task-ref>\` to read task notes and bootstrap failure guidance. See \`kspec task get --help\` for the full command syntax.
3. Run \`kspec agent runners validate\` only for named-runner problems; it does not validate workspace bootstrap. See \`kspec agent runners validate --help\` for all validator options.
4. Correct the project or agent source configuration and allow dispatch to prepare or resume the workspace through its normal task lifecycle.

Lifecycle start, pause, resume, and stop controls govern dispatch admission and owned processes. They do not manage or delete workspaces, and there is no workspace list, show, reset, or cleanup command. Do not edit the workspace registry or lifecycle control state, delete paths under the managed root, or run manual Git worktree mutations as a recovery technique.

For the dispatch mental model, read [Agents and Dispatch](../concepts/agents-and-dispatch.md). For assignment symptoms, use [Dispatch Refuses to Assign a Task](../troubleshooting/dispatch-refuses-to-assign.md).

## Verification

Confirm the configuration without forcing a dispatch lifecycle transition:

1. Run \`kspec setup\` if you changed the managed worktree root and need project scaffolding refreshed. Review \`kspec setup --help\` before selecting options.
2. Run \`kspec agent list\` and confirm the intended agents and event rules are present. Review \`kspec agent list --help\` for the full list options.
3. If an agent uses a named runner, run \`kspec agent runners validate\` and confirm the runner is valid. Review \`kspec agent runners validate --help\` for all options.
4. Run \`kspec agent status\` and confirm there is no unexpected degraded target. Review \`kspec agent status --help\` for all status formats.
5. After the next eligible task is dispatched, use \`kspec task get <task-ref>\` to confirm its task note and assigned workspace context show the expected target and no bootstrap failure. Review \`kspec task get --help\` for the complete syntax.

The goal is met when the selected integration target, worktree root, publication mode, project-before-agent bootstrap sequence, and remote status match the project policy, while the task remains under normal dispatch ownership.
`,path:"guides/configuring-dispatch-workspaces.md"},{slug:"guides/controlling-dispatch-lifecycle",title:"Controlling the Dispatch Lifecycle",content:'# Controlling the Dispatch Lifecycle\n\n## Goal\n\nPause new dispatch work, resume held work, or hard-stop dispatch-owned work at either global or single-task scope. By the end, you will be able to choose the smallest correct scope, read the authoritative status, apply a valid action, and verify recovery without changing task readiness or deleting workspace evidence.\n\n## Prerequisites\n\n- A kspec project with setup completed and dispatch agents configured\n- Access to the project daemon and permission to operate dispatch\n- The canonical task reference or an unambiguous alias when controlling one task\n- A recovery plan for work that a hard stop will cancel\n\nRead [Configuring Dispatch Workspaces](./configuring-dispatch-workspaces.md) first if the integration target, managed worktree root, publication mode, or bootstrap policy is not yet configured. Every lifecycle command has its own generated option list: append `--help` to that exact command. For example, use `kspec agent dispatch stop --help`, `kspec agent dispatch task stop --help`, or `kspec agent status --help`.\n\n## Steps\n\n### 1. Choose global or task scope\n\nUse global scope to hold or stop every dispatch candidate in the project. Use task scope when one canonical task needs intervention and unrelated dispatch work should continue.\n\nTask commands accept a slug, full ULID, or unique ULID prefix, then resolve it to the canonical task ULID before storing control state. Missing, ambiguous, unresolved, or disagreeing task identities fail without changing authority. Status and events may retain a friendly task reference for display, but the durable key is the canonical task identity.\n\nA task-level resume removes that task\'s hold; it does not bypass global authority. If global dispatch remains paused or stopped, the task remains held from admission.\n\n### 2. Read authority, projection, and work counts\n\nInspect status before every action:\n\n```bash\nkspec agent status\nkspec agent dispatch status --json\n```\n\nPlain `kspec agent status` provides a human-readable summary with Authority, Projection, Active, Queued, Held, and aggregate Cleanup lines. Use `kspec agent dispatch status --json` when you need the detailed CLI status contract: CLI JSON uses camelCase names such as `globalAuthority`, `activeCount`, `queuedInvocations`, `heldCount`, `heldTasks`, `taskControls`, `cleanupState`, and `degradedTargets`. A missing optional `degradedTargets` array means no target degradation was reported.\n\nPublic API consumers instead read `GET /api/agent/status`. The public API uses snake_case wire fields:\n\n| Field              | What it tells you                                                                   |\n| ------------------ | ----------------------------------------------------------------------------------- |\n| `global_authority` | Durable global authority: `stopped`, `running`, or `paused`                         |\n| `projection`       | Current operational projection: `stopped`, `running`, `paused`, or `draining`       |\n| `active_count`     | Dispatch-owned invocations already active                                           |\n| `queue_depth`      | Candidates currently queued                                                         |\n| `held_count`       | Eligible candidates held by global or task authority                                |\n| `held_tasks`       | Canonical held-task identity, scope, mode, reason, actor, source, and timestamps    |\n| `task_controls`    | Canonical per-task `paused` or `stopped` records and matching cleanup state         |\n| `cleanup_state`    | Aggregate `idle`, `pending`, or `failed` cleanup evidence, including scoped entries |\n| `degraded_targets` | Remote target synchronization problems; separate from lifecycle authority           |\n\n`draining` is not another durable authority. It means authority is `paused` while active work is still completing. Pausing admits no new matching work but allows active dispatch invocations and sessions to finish naturally.\n\nCleanup entries identify their `global` or `task` scope, cleanup identifier, phase, status, closed error code, and canonical task identity when task-scoped. Global actions inspect global cleanup. Task actions inspect only cleanup for that canonical task. Aggregate cleanup is observability, not a blanket gate across unrelated scopes.\n\n### 3. Select a valid action\n\n#### Global actions\n\n| Current authority and cleanup                   | Actions          | Result                                                                                |\n| ----------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |\n| `stopped` with global cleanup idle              | `start`          | Starts admission and reconciles currently eligible work                               |\n| `running`                                       | `pause`, `stop`  | Holds new starts gracefully, or commits hard-stop authority and cancels matching work |\n| `paused`                                        | `resume`, `stop` | Releases held work, or hard-stops matching work                                       |\n| `stopped` with global cleanup pending or failed | `stop`           | Retries the matching global hard-stop cleanup                                         |\n\n`start` and `resume` are not synonyms. Use `start` only to leave cleanup-idle `stopped` authority. Use `resume` only to leave `paused` authority. Repeating an already-satisfied valid action, such as pausing while paused or resuming while running, is a no-op. An action outside the transition matrix is an invalid transition and fails rather than substituting a different action.\n\n#### Task actions\n\n| Current task control                              | Actions          | Result                                                                |\n| ------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |\n| No task control                                   | `pause`, `stop`  | Adds a canonical task hold, or hard-stops only that task\'s owned work |\n| `paused`                                          | `resume`, `stop` | Removes the task hold, or hard-stops only that task\'s owned work      |\n| `stopped` with matching cleanup idle              | `resume`         | Removes the task stop; global authority still controls admission      |\n| `stopped` with matching cleanup pending or failed | `stop`           | Retries cleanup for that canonical task only                          |\n\nPausing an already paused task and resuming a task without a control record are no-ops. Pausing a stopped task, resuming while matching cleanup is not idle, or using an unresolved identity is invalid. A task hard stop preserves unrelated task controls, invocations, sessions, and cleanup entries.\n\n### 4. Choose pause or hard stop\n\nPause is the graceful admission hold. It commits paused authority, admits no new matching work, and lets active dispatch invocations and sessions finish naturally. Use it for maintenance or investigation when current work may complete safely.\n\nHard stop commits no-start authority before cancelling matching dispatch-owned processes and closing their sessions. Use it when matching active work must not continue. Interactive confirmation states that active matching invocations will be cancelled while session, branch, workspace, worktree, snapshot, and audit evidence is preserved. Declining confirmation sends no control request and exits without success. Noninteractive and JSON hard stop require `--force`.\n\nA dispatch-owned agent session cannot hard-stop its own host. Global and task hard-stop requests from such a context are rejected; operate the host from an independent operator context.\n\n### 5. Run the CLI procedure\n\n#### CLI commands\n\n| Scope  | Command                                       | Use                                        |\n| ------ | --------------------------------------------- | ------------------------------------------ |\n| Global | `kspec agent dispatch start`                  | Leave cleanup-idle stopped authority       |\n| Global | `kspec agent dispatch pause`                  | Hold new starts and drain active work      |\n| Global | `kspec agent dispatch resume`                 | Leave paused authority                     |\n| Global | `kspec agent dispatch stop`                   | Hard-stop globally or retry global cleanup |\n| Global | `kspec agent dispatch status`                 | Read dispatch-focused status               |\n| Global | `kspec agent dispatch watch`                  | Stream active invocation output            |\n| Global | `kspec agent status`                          | Read the public agent and lifecycle status |\n| Task   | `kspec agent dispatch task pause <task-ref>`  | Hold one canonical task                    |\n| Task   | `kspec agent dispatch task resume <task-ref>` | Release one canonical task control         |\n| Task   | `kspec agent dispatch task stop <task-ref>`   | Hard-stop or retry cleanup for one task    |\n\nUse this sequence:\n\n1. Run `kspec agent status` for the human-readable summary, then run `kspec agent dispatch status --json` and record `globalAuthority`, `projection`, `activeCount`, `queuedInvocations`, `heldCount`, `heldTasks`, `taskControls`, matching `cleanupState`, and any `degradedTargets`.\n2. Choose global or task scope from the tables above.\n3. For pause or resume, run the selected command and read its reported authority and projection.\n4. For hard stop, review the cancellation and evidence-preservation warning. Confirm interactively, or add `--force` in noninteractive and JSON use.\n5. Run both status commands again. Use the summary for a quick state check and the JSON result for held rows, task controls, scoped cleanup entries, and degraded targets.\n\nFor any command in the table, append `--help` to that exact command (and omit the `<task-ref>` placeholder) to read its generated Usage and Options output. The guide names the workflow commands but does not duplicate generated flag reference.\n\n### 6. Use the API or agents view when appropriate\n\nThe canonical mutation endpoint is `POST /api/agent/dispatch/control`. Send a global action with a body such as `{"scope":"global","action":"pause"}`. For task scope, provide the task reference or canonical identity required by the public request schema. The server canonicalizes aliases and rejects missing, ambiguous, unresolved, or mismatched identity.\n\nRead public lifecycle status from `GET /api/agent/status`. The compatibility `GET /api/agent/dispatch/status` route remains available for dispatch-focused consumers. The public API uses snake_case wire fields such as `global_authority`, `cleanup_state`, `active_count`, `queue_depth`, `held_count`, `held_tasks`, and `task_controls`. The UI adapter maps those fields to camelCase values such as `globalAuthority`, `cleanupState`, `activeCount`, `queueDepth`, `heldCount`, `heldTasks`, and `taskControls`.\n\nThe [agents view](../../agents) exposes only actions valid for the current global or task state. It labels pause, resume, start, hard stop, and retry hard stop; confirms hard stop; keeps active, queued, held, and cleanup evidence visible; retains focus after updates; and announces lifecycle changes and failures to assistive technology. A degraded target or blocked task is shown separately from lifecycle control.\n\n### 7. Account for the static, read-only UI\n\nIn a static export, the agents view reports stopped, empty lifecycle status and is read-only. It does not send mutation requests.\n\n### 8. Retry failed cleanup and recover after restart\n\nHard-stop failure never restores admission or reports false success. Authority remains `stopped`, and matching cleanup remains `pending` or `failed` with a closed error code and phase. Failures include cancellation timeout, verified signalling failure, session-closure failure, or inability to prove ownership, process birth, or process-group identity.\n\nTo retry:\n\n1. Read `cleanupState` in CLI JSON (or `cleanup_state` in the public API) and identify whether the entry is global or belongs to one canonical task.\n2. Resolve any operator-correctable host condition without deleting dispatch evidence or manually editing lifecycle state.\n3. Run the matching `stop` command again. Global stop retries global cleanup; task stop retries only that task\'s cleanup.\n4. Verify that matching cleanup becomes `idle`. Unrelated cleanup does not block this transition.\n\nCommitted control authority and pending cleanup survive daemon restart. Startup loads the durable control state and retries matching pending cleanup before bootstrap scheduling. An interrupted stop can therefore be retried safely after restart, but recovery proceeds only when dispatch can prove durable session ownership and the process birth/group identity. If it cannot, cleanup may remain pending or failed for an operator to investigate.\n\nDo not edit `.kspec/dispatch-control.yaml` by hand, remove session evidence, delete a managed workspace, or invent a Git worktree recovery procedure. Lifecycle control preserves evidence and does not own workspace deletion.\n\n### 9. Subscribe to lifecycle events for automation\n\nAutomation may subscribe to these public registered event names:\n\n- `dispatch_control.start_applied`\n- `dispatch_control.pause_applied`\n- `dispatch_control.resume_applied`\n- `dispatch_control.stop_applied`\n- `dispatch_control.noop`\n- `dispatch_control.failed`\n\nTask-scoped events use canonical task identity. Failure events expose a closed error code, not raw errors or host paths. Treat events as audit and automation signals; read current status before choosing a follow-up transition.\n\n### 10. Respect safety and error semantics\n\nLifecycle controls do not change semantic task readiness, clear degraded targets, or override task dependencies. They only govern dispatch admission and dispatch-owned active work. A no-op is a successful request whose desired authority already holds; an invalid transition is a failed request whose action is not valid from the current state.\n\nErrors return fixed codes and operator guidance without exposing raw errors or filesystem paths. API transition errors include current lifecycle status so clients can refresh their action choices. Failed control-store commits do not claim that authority changed. Failed cancellation or cleanup retains stopped authority and retry evidence.\n\nDispatch hard stop targets only sessions and processes whose dispatch ownership and process identity can be verified. It does not signal arbitrary one-shot runs or unrelated host processes.\n\n## Supported limitations\n\n- pause is a graceful admission hold; stop is hard stop\n- no checkpointing\n- no distributed scheduler\n- no exact durable FIFO promise\n- no workspace deletion or reset command\n- no control of arbitrary one-shot work outside dispatch ownership\n- recovery may remain pending when process ownership cannot be proven\n\nIn particular, lifecycle control does not checkpoint a prompt, guarantee an exact queue order, control arbitrary `kspec agent run` processes, or guarantee cleanup on a host where equivalent ownership and process-birth evidence is unavailable.\n\nFor the dispatch mental model, read [Agents and Dispatch](../concepts/agents-and-dispatch.md). For workspace policy, read [Configuring Dispatch Workspaces](./configuring-dispatch-workspaces.md). For assignment problems, use [Dispatch Refuses to Assign a Task](../troubleshooting/dispatch-refuses-to-assign.md).\n\n## Verification\n\nVerify the selected scope from the CLI status surfaces:\n\n1. Run `kspec agent status` and confirm the human-readable authority, projection, active, queued, held, and aggregate cleanup summary.\n2. Run `kspec agent dispatch status --json` for detailed verification.\n3. Confirm `globalAuthority` and `projection` match the intended state.\n4. Confirm `activeCount`, `queuedInvocations`, and `heldCount` explain current work.\n5. For task scope, confirm `heldTasks` and `taskControls` name the canonical task and unrelated task rows are unchanged.\n6. Confirm matching `cleanupState` is `idle`, or that any remaining `pending` or `failed` entry has the expected scope, phase, and closed error code.\n7. Confirm task readiness and any `degradedTargets` were not changed by the lifecycle action.\n8. If using the agents view, confirm the next valid actions are labelled, focus remains usable, and the status update is announced.\n\nThe goal is met when the intended global or canonical-task authority is visible, new work is admitted or held as intended, active work was drained or cancelled according to the selected action, and matching cleanup and evidence are accounted for.\n',path:"guides/controlling-dispatch-lifecycle.md"},{slug:"guides/directing-your-agent",title:"Directing Your Agent Effectively",content:`# Directing Your Agent Effectively

This guide covers how to give your AI coding agent effective instructions using kspec's task lifecycle and conventions. By the end, you will know how to frame requests so your agent stays aligned with your specs and produces traceable work.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- An AI coding agent connected to your project (see [Connecting Your Agent](../getting-started/connecting-your-agent.md))
- At least one spec with acceptance criteria in your project

## Steps

### 1. Start a session

At the beginning of every work session, have your agent run:

\`\`\`bash
kspec session start
\`\`\`

This gives the agent your project context: active tasks, specs, and conventions. The agent reads the generated instruction files (\`kspec-agents.md\` and skills) automatically, but \`session start\` grounds it in your project's current state.

### 2. Frame requests around specs

Instead of describing implementation details, point your agent to the spec:

\`\`\`
Work on @task-user-login. The spec is @user-login — read the acceptance criteria and implement accordingly.
\`\`\`

The agent will run \`kspec item get @user-login\` to read the ACs and plan its approach. This keeps the agent focused on what the spec requires rather than what you happen to remember to say.

### 3. Let the agent use the task lifecycle

kspec tasks have a defined lifecycle: start, work, submit, review, complete. Direct your agent to follow it:

\`\`\`
Start the task, create a branch, implement the feature, then submit for review.
\`\`\`

The agent will run the appropriate commands:

\`\`\`bash
kspec task start @task-user-login
kspec task branch @task-user-login
# ... implement ...
kspec task submit @task-user-login
\`\`\`

You do not need to dictate each command. The agent reads the task-work skill and follows the lifecycle.

### 4. Use notes for context

When you want the agent to understand a decision or constraint, add a task note:

\`\`\`bash
kspec task note @task-user-login \\
  "Use the existing auth library in src/lib/auth.ts. Do not add a new dependency."
\`\`\`

Notes persist across sessions. The next time an agent picks up this task, it sees your constraint without you repeating it.

### 5. Review against acceptance criteria

After the agent submits work, review it against the spec's ACs:

\`\`\`bash
kspec item get @user-login
\`\`\`

Each AC describes an observable outcome. Check whether the implementation satisfies each one. If something is missing, create a review record and the agent will address it in a fix cycle.

### 6. Keep the agent on scope

If the agent starts expanding beyond the current task, redirect it:

\`\`\`
That's outside the scope of @task-user-login. Capture it as an inbox item and continue with the current task.
\`\`\`

The agent will run:

\`\`\`bash
kspec inbox add "Discovered: need to refactor auth middleware"
\`\`\`

This captures the idea without derailing the current work.

### 7. Use conventions to set expectations

Your project's conventions (commit format, naming, testing rules) are defined in \`kspec-agents.md\` and generated from your project metadata. If you want the agent to follow a new convention, add it:

\`\`\`bash
kspec meta set development --add-rule "Always run linting before committing"
kspec agents generate
\`\`\`

The agent reads the updated conventions on its next session.

For all convention management options, run \`kspec meta --help\`.

## Verification

Ask your agent:

\`\`\`
What is the current task and what are its acceptance criteria?
\`\`\`

The agent should run \`kspec task get\` and \`kspec item get\` to answer with specific details from your project. If it gives a generic response instead of referencing your actual specs, verify that \`kspec setup\` has been run and the instruction files exist.
`,path:"guides/directing-your-agent.md"},{slug:"guides/importing-and-approving-a-plan",title:"Importing and Approving a Plan",content:`# Importing and Approving a Plan

This guide walks you through creating a structured plan document, importing it into kspec, and approving it to derive specs and tasks. By the end, you will have a plan that produces traceable specs with acceptance criteria and ready-to-work tasks.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- A project initialized with \`kspec init\` and \`kspec setup\`

## Steps

### 1. Write a plan document

A plan document is a markdown file with YAML code blocks that define specs and tasks. Create a file (for example, \`plans/my-feature.md\`) with this structure:

\`\`\`\`markdown kspec-plan
# My Feature Plan

## Specs

\`\`\`yaml
- title: Feature Name
  slug: feature-name
  type: feature
  parent: "@main"
  description: |
    What this feature does and why it matters.
  acceptance_criteria:
    - id: ac-1
      given: |
        A user is on the dashboard
      when: |
        They click the export button
      then: |
        A CSV file downloads with the current data
\`\`\`

## Tasks

\`\`\`yaml
- title: Implement export feature
  slug: task-implement-export
  spec_ref: "@feature-name"
  tags: [mvp, feature]
\`\`\`
\`\`\`\`

Each spec defines what to build with acceptance criteria. Each task references the spec it implements.

### 2. Preview the import

Before importing, preview what kspec will store:

\`\`\`bash
kspec plan import plans/my-feature.md --dry-run
\`\`\`

The preview shows the plan record that would be created without saving anything. Review the output to confirm the structure matches your intent.

For all import options, run \`kspec plan import --help\`.

### 3. Import the plan

When satisfied with the preview, import for real:

\`\`\`bash
kspec plan import plans/my-feature.md
\`\`\`

kspec stores the plan document content on the shadow branch. Importing does not create specs or tasks — that happens in the derive step. Inspect the result:

\`\`\`bash
kspec plan get @plan-my-feature
\`\`\`

### 4. Iterate with additions

If you need to update a plan with revised content, use the \`--into\` flag:

\`\`\`bash
kspec plan import plans/revised-feature.md --into @plan-my-feature --reason "Addressed review feedback"
\`\`\`

This updates the existing plan's stored content rather than creating a new one.

### 5. Approve the plan

Approving a plan signals that its content is ready for derivation:

\`\`\`bash
kspec plan set @plan-my-feature --status approved
\`\`\`

### 6. Derive specs and tasks

Derive materializes the stored plan content into specs and tasks:

\`\`\`bash
kspec plan derive @plan-my-feature
\`\`\`

Preview what will be created before committing:

\`\`\`bash
kspec plan derive @plan-my-feature --dry-run
\`\`\`

If the plan owns local resources (screenshots, research PDFs, evidence files) and any derived task declares \`resource_refs\`, derivation records versioned references back to the plan's resources by default. Pass \`--materialize-resources\` when a task needs an immutable snapshot of the plan resource bytes copied into its own directory:

\`\`\`bash
kspec plan derive @plan-my-feature --materialize-resources
\`\`\`

See [Working With Local Resources](./working-with-local-resources.md) for the full resource workflow, including how to import a plan with sibling resources, attach files to an existing plan, and the difference between referenced and materialized resources.

After derivation, tasks appear in the ready queue:

\`\`\`bash
kspec tasks ready
\`\`\`

## Verification

Run the following to confirm your plan is imported and approved:

\`\`\`bash
kspec plan get @plan-my-feature
\`\`\`

After derivation, the output should show \`Status: active\` and list the derived specs and tasks. Then verify tasks are ready:

\`\`\`bash
kspec tasks ready
\`\`\`

You should see tasks from your plan in the pending state, ready to be started.
`,path:"guides/importing-and-approving-a-plan.md"},{slug:"guides/recovering-from-shadow-branch-issues",title:"Recovering From Shadow Branch Issues",content:`# Recovering From Shadow Branch Issues

This guide covers diagnosing and fixing common shadow branch problems. By the end, you will have a healthy shadow branch and know how to prevent future issues.

## Prerequisites

- An existing kspec project (initialized with \`kspec init\`)
- Familiarity with the shadow branch concept (see the Concepts section when available, or the [Initializing a Project](../getting-started/initializing-a-project.md) page)

## Steps

### 1. Check shadow branch status

Start by diagnosing the current state:

\`\`\`bash
kspec shadow status
\`\`\`

This reports the health of the \`.kspec/\` worktree and its connection to the \`kspec-meta\` branch. Common issues include a disconnected worktree, sync conflicts with a remote, or a missing \`.kspec/\` directory.

### 2. Repair a broken worktree

If the worktree is disconnected or corrupted:

\`\`\`bash
kspec shadow repair
\`\`\`

This reconnects the \`.kspec/\` directory to the \`kspec-meta\` branch. The repair command is non-destructive — it does not delete your spec or task data.

For all repair options, run \`kspec shadow repair --help\`.

### 3. Sync with remote

If your shadow branch is out of sync with a remote (for example, after a teammate pushed changes):

\`\`\`bash
kspec shadow sync
\`\`\`

This pulls remote changes and merges them into your local shadow branch. If there are conflicts:

\`\`\`bash
kspec shadow resolve
\`\`\`

The resolve command walks you through conflict resolution for shadow branch files.

For all sync options, run \`kspec shadow sync --help\`.

### 4. Reinitialize if needed

If the \`.kspec/\` directory is completely missing (for example, after a fresh clone):

\`\`\`bash
kspec init
\`\`\`

If the \`kspec-meta\` branch exists on the remote, \`init\` reconnects to it and restores your specs and tasks. If no remote branch exists, it creates a new shadow branch.

### 5. Verify the fix

After any repair operation, confirm the shadow branch is healthy:

\`\`\`bash
kspec shadow status
\`\`\`

The output should show no issues. Then verify your data is intact:

\`\`\`bash
kspec item list
kspec task list
\`\`\`

Your specs and tasks should appear as expected.

### 6. Prevent future issues

To avoid shadow branch problems:

- **Always run kspec from the project root.** Running it from inside \`.kspec/\` causes the "Cannot run kspec from inside .kspec/ directory" error.
- **Do not manually edit files in \`.kspec/\`.** Use CLI commands — they handle commits to the shadow branch automatically.
- **Do not run manual git commands inside \`.kspec/\`.** Use \`kspec shadow\` commands for worktree operations.
- **Keep your shadow branch pushed.** If your project has a remote, \`kspec shadow sync\` keeps local and remote in sync.

## Verification

Run the full health check:

\`\`\`bash
kspec doctor
\`\`\`

All checks should pass, including the shadow branch check. Then start a session to confirm everything works:

\`\`\`bash
kspec session start
\`\`\`

The session output should show your project context without warnings about shadow branch issues.
`,path:"guides/recovering-from-shadow-branch-issues.md"},{slug:"guides/reviewing-an-agents-work",title:"Reviewing an Agent's Work",content:`# Reviewing an Agent's Work

This guide covers how to review work that an AI agent has submitted. By the end, you will know how to create a review record, evaluate work against acceptance criteria, and provide actionable feedback that the agent can address.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- A task in the \`pending_review\` state (the agent has run \`kspec task submit\`)

## Steps

### 1. Find tasks awaiting review

List tasks that are ready for review:

\`\`\`bash
kspec task list --status pending_review
\`\`\`

Pick a task to review and read its details:

\`\`\`bash
kspec task get @task-some-feature
\`\`\`

The output shows the task's spec reference, notes from the agent, and current status.

### 2. Read the spec and acceptance criteria

Load the spec to understand what the work should accomplish:

\`\`\`bash
kspec item get @some-feature
\`\`\`

Read every acceptance criterion carefully. These are the objective measures you will evaluate against.

### 3. Create a review record

Start the review by creating a review record:

\`\`\`bash
kspec review add --subject-type task --subject-ref @task-some-feature
\`\`\`

This creates a review linked to the task and returns a review reference you will use for threads.

For all review options, run \`kspec review add --help\`.

### 4. Examine the implementation

Review the code changes the agent produced. Compare against the integration branch the task targets (for example, \`dev\` or \`main\`):

\`\`\`bash
git log --oneline origin/<integration-branch>..HEAD
git diff origin/<integration-branch>
\`\`\`

Replace \`<integration-branch>\` with the branch you merge work into — run \`kspec task get @task-ref\` and check the submission linkage to confirm.

For each acceptance criterion, verify:

- **Is there a test annotated with \`AC: @spec ac-N\`?** Every AC should have at least one test.
- **Does the test actually prove the AC?** A test that passes regardless of the feature is not coverage.
- **Does the implementation satisfy the AC's "then" clause?** Read the AC literally.

### 5. Add review threads

For each finding, add a comment thread to the review. Threads have a kind:

\`\`\`bash
kspec review comment @review-ref \\
  --kind blocker \\
  --body "AC-2 has no test coverage. The spec requires validation of expired tokens, but no test exercises this path."
\`\`\`

Thread kinds:

- **blocker** — Must be fixed before approval. Missing AC coverage, broken behavior, or security issues.
- **question** — Needs clarification. The reviewer is unsure whether the approach is correct.
- **nit** — Minor style or preference issue. Non-blocking.

For the full set of comment options, run \`kspec review comment --help\`.

### 6. Submit your verdict

After examining all ACs and adding threads, submit your verdict:

\`\`\`bash
kspec review verdict @review-ref --decision approve
\`\`\`

Or if changes are needed:

\`\`\`bash
kspec review verdict @review-ref --decision request_changes
\`\`\`

A \`request_changes\` verdict moves the task back so the agent can address your feedback. The agent reads your review threads and works through them in a fix cycle.

### 7. Verify the fix cycle

After the agent resubmits, review again. Check that:

- All blocker threads are resolved
- The agent replied to threads explaining what changed
- New changes did not introduce regressions

Create a new review record for each review cycle — do not reopen the previous one.

## Verification

After approving the work, confirm the task status:

\`\`\`bash
kspec task get @task-some-feature
\`\`\`

The task should remain in \`pending_review\` with an approved review. The work can now be merged through the project-defined integration process; complete the task only after that merge succeeds:

\`\`\`bash
kspec review for-task @task-some-feature
\`\`\`

This lists all reviews for the task, showing the approval chain and any prior fix cycles.
`,path:"guides/reviewing-an-agents-work.md"},{slug:"guides/starting-a-new-project",title:"Starting a New Project",content:`# Starting a New Project

This guide walks you through setting up a new kspec project from scratch, including module structure and initial spec planning. By the end, your project will have a shadow branch, agent instructions, and a top-level module ready for specs.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- Node.js 20+ and Git installed
- A Git repository (existing or new)

## Steps

### 1. Initialize kspec

From your project root, run the initialization command:

\`\`\`bash
kspec init
\`\`\`

This creates the shadow branch (\`kspec-meta\`), sets up the \`.kspec/\` worktree directory, and creates a root manifest. If your repository already has a \`kspec-meta\` branch (for example, from a clone), \`kspec init\` reconnects to it.

For the full list of options, run \`kspec init --help\`.

### 2. Run setup

Generate agent instruction files and skill definitions:

\`\`\`bash
kspec setup
\`\`\`

This produces \`AGENTS.md\`, \`kspec-agents.md\`, and the \`.agents/skills/\` directory. Your AI coding agent reads these files automatically when it starts a session in the repository.

For agent-specific setup options, run \`kspec setup --help\`.

### 3. Verify project health

Confirm everything is wired correctly:

\`\`\`bash
kspec doctor
\`\`\`

All checks should pass. If any fail, follow the suggested fix in the output.

### 4. Plan your module structure

kspec organizes specs under modules. The \`init\` command creates a default top-level module. List your modules:

\`\`\`bash
kspec item list --type module
\`\`\`

If your project has distinct domains (for example, a CLI and a web UI), consider creating additional modules:

\`\`\`bash
kspec module add --title "Web UI" --slug web-ui
kspec module add --title "CLI" --slug cli
\`\`\`

For the full set of module options, run \`kspec module add --help\`.

Modules are organizational — they group related specs. You can restructure them later without losing spec or task data.

### 5. Create your first spec

Under your chosen module, create a feature spec with acceptance criteria:

\`\`\`bash
kspec item add --under @main \\
  --title "User login" \\
  --type feature \\
  --slug user-login
\`\`\`

Then add acceptance criteria that describe observable outcomes:

\`\`\`bash
kspec item ac add @user-login \\
  --given "a registered user visits the login page" \\
  --when "they enter valid credentials and submit" \\
  --then "they are redirected to the dashboard"
\`\`\`

### 6. Start a session

Begin a work session to see your project context:

\`\`\`bash
kspec session start
\`\`\`

The output shows your modules, active tasks, and suggested next actions.

## Verification

Run the following to confirm your project is ready:

\`\`\`bash
kspec shadow status
\`\`\`

The output should show a healthy shadow branch with no issues. Then verify your specs are in place:

\`\`\`bash
kspec item list
\`\`\`

You should see your module and any specs you created. Your project is now set up and ready for spec-driven development.
`,path:"guides/starting-a-new-project.md"},{slug:"guides/upgrading-kspec",title:"Upgrading kspec to a New Version",content:`# Upgrading kspec to a New Version

This guide walks you through upgrading kspec to a new version safely. By the end, your project will be running the latest version with updated agent instructions and a verified shadow branch.

## Prerequisites

- An existing kspec project (initialized with \`kspec init\`)
- Node.js 20+ and npm installed

## Steps

### 1. Check your current version

Before upgrading, note your current version:

\`\`\`bash
kspec --version
\`\`\`

### 2. Read the release notes

Check what changed in the new version:

\`\`\`bash
kspec release-notes
\`\`\`

Or view the release notes in the docs if you have the web UI running. Look for breaking changes, new commands, or deprecations that might affect your project.

### 3. Install the new version

Install the new package version via npm:

\`\`\`bash
npm install -g @kynetic-ai/spec@latest
\`\`\`

Verify the package updated:

\`\`\`bash
kspec --version
\`\`\`

### 4. Run the upgrade

The \`kspec upgrade\` command performs all project migration work in one step — task storage migration, plan and review folder-backed storage migration (1.2+), skill re-rendering, agent instruction regeneration, gitignore repair, and release-note surfacing:

\`\`\`bash
kspec upgrade
\`\`\`

Review the output carefully. It lists each migration step, what changed, and any manual follow-ups. Preview what would happen without applying changes:

\`\`\`bash
kspec upgrade --dry-run
\`\`\`

\`--dry-run\` reports every step that would run, the previous shadow commit (so you have a rollback reference before any writes happen), and any warnings — without writing to the shadow branch. Run it first on any project where you want to know exactly what the upgrade will do before committing to it.

For all upgrade options, run \`kspec upgrade --help\`.

#### What \`kynetic: "1.2"\` Changes

Version 1.2 moves plans and reviews from monolithic project-wide files into folder-backed entities and introduces entity-scoped local resources. After a successful upgrade, the project manifest discovered in \`.kspec/\` (normally \`<project-slug>.yaml\`) declares:

\`\`\`yaml
kynetic: "1.2"
task_storage:
  format: split
plan_storage:
  format: folder
review_storage:
  format: folder
resource_storage:
  format: entity_scoped
\`\`\`

On disk, plans live in \`.kspec/plans/<plan-ulid>/\` with \`plan.md\`, \`plan.yaml\`, optional \`notes.yaml\`, \`resources.yaml\`, and \`resources/\`. Reviews live in \`.kspec/reviews/<review-ulid>/\` with a cohesive \`review.yaml\`, \`resources.yaml\`, and \`resources/\`. The project-wide \`.kspec/project.plans.yaml\` and \`.kspec/project.reviews.yaml\` files remain as lean indexes that no longer inline full markdown, notes, review threads, or resource file bytes.

See [Local Resources for Plans and Reviews](../concepts/local-resources.md) for the full layout, schema, and resource model.

#### Rolling Back If Something Goes Wrong

The upgrade output reports the previous shadow commit — the commit on the shadow branch immediately before the upgrade's first write. Look for a line like:

\`\`\`
Shadow HEAD (pre-upgrade rollback ref): a1b2c3d
\`\`\`

That short SHA is your rollback target. If you need to undo the upgrade, reset the shadow branch back to that commit from your project root:

\`\`\`bash
cd .kspec
git reset --hard <previous-shadow-commit>
cd ..
kspec shadow status
\`\`\`

\`kspec shadow status\` should report a healthy worktree on the pre-upgrade commit. Verify your plan and review data is intact, then either retry the upgrade (after addressing whatever motivated the rollback) or pin to the previous kspec version.

The pre-upgrade commit is the rollback ref by design — kspec does not create parallel backup files, because the shadow branch's git history is the backup.

### 5. Check project health

Run the health check to verify nothing broke:

\`\`\`bash
kspec doctor
\`\`\`

All checks should pass. If any fail, follow the suggested fixes in the output. Common upgrade-time failures and their recovery procedures are documented in [Troubleshooting](../troubleshooting/index.md) — in particular [\`entity_storage_incompatible\`: project storage format mismatch](../troubleshooting/entity-storage-incompatible.md) when a plan, review, or resource command reports the project is not on folder-backed storage.

### 6. Verify shadow branch integrity

Confirm the shadow branch is healthy:

\`\`\`bash
kspec shadow status
\`\`\`

If the status shows issues, repair the worktree:

\`\`\`bash
kspec shadow repair
\`\`\`

For all shadow branch commands, run \`kspec shadow --help\`.

### 7. Commit updated files

If the upgrade regenerated instruction files, commit them:

\`\`\`bash
git add AGENTS.md kspec-agents.md .agents/
git commit -m "chore: regenerate agent instructions for kspec $(kspec --version)"
\`\`\`

## Verification

Run the following to confirm the upgrade is complete:

\`\`\`bash
kspec --version
kspec doctor
\`\`\`

The version should show the new release and all health checks should pass. Start a new session to confirm everything works:

\`\`\`bash
kspec session start
\`\`\`

The session output should show your project context without errors.
`,path:"guides/upgrading-kspec.md"},{slug:"guides/working-with-local-resources",title:"Working With Local Resources",content:'# Working With Local Resources\n\nThis guide covers attaching files to plans and reviews, referencing them from plan markdown and task definitions, controlling how derived tasks see them, and serving them through the daemon API and static export. By the end, you will know which command to run for each resource lifecycle step and which API route to call from a custom client.\n\nFor the model behind these commands — the folder layout, manifest schema, and copy-vs-reference rule — see [Local Resources for Plans and Reviews](../concepts/local-resources.md).\n\n## Prerequisites\n\n- Completed the [Getting Started](../getting-started/index.md) section\n- A project on `kynetic: "1.2"` or newer (run `kspec upgrade` if your manifest is older — see [Upgrading kspec to a New Version](./upgrading-kspec.md))\n- A plan or review you can attach files to\n\n## Attaching a File to a Plan\n\n`kspec plan resource add` attaches a local file to a plan. The plan owns the file from that point on.\n\n```bash\nkspec plan resource add @plan-my-feature ./shot.png \\\n  --id login-shot \\\n  --path screenshots/login.png \\\n  --label "Login screen with validation error" \\\n  --description "Captured during user testing on 2026-05-22"\n```\n\nThe required flags are `--id` and `--path`:\n\n- `--id <resource-id>` — stable resource identifier. Must match `[a-z0-9][a-z0-9._-]{0,127}`.\n- `--path <relative-path>` — POSIX-relative path under the plan\'s `resources/` directory. The file is copied there.\n\nOptional flags:\n\n- `--label <label>` — human-friendly label that surfaces in list/detail views\n- `--description <text>` — free-form description\n- `--content-type <mime>` — explicit MIME type; omitted values are inferred from the path extension\n- `--replace` — overwrite an existing resource with the same id (refuses to overwrite a different resource id\'s path)\n- `--json` — emit structured JSON output\n\nWhen `--replace` is omitted, attempting to attach a file under an id or path that already exists fails with `resource_conflict`. Use `--replace` to update an existing resource\'s bytes or metadata in place.\n\n## Listing, Inspecting, and Removing Plan Resources\n\n```bash\nkspec plan resource list @plan-my-feature\nkspec plan resource get  @plan-my-feature login-shot\nkspec plan resource remove @plan-my-feature login-shot\n```\n\n`remove` deletes the manifest entry and the owned file. In interactive shells it prompts for confirmation; pass `--force` to skip the prompt. In non-interactive contexts (CI, dispatched agents), `remove` without `--force` fails with `confirmation_required` rather than blocking on input.\n\nEach of these accepts `--json` to emit structured output suitable for scripting.\n\n## Attaching, Listing, Inspecting, and Removing Review Resources\n\nThe review resource commands mirror the plan commands and accept the same flags:\n\n```bash\nkspec review resource add @review-1 ./screenshot.png \\\n  --id login-bug \\\n  --path screenshots/login.png\n\nkspec review resource list   @review-1\nkspec review resource get    @review-1 login-bug\nkspec review resource remove @review-1 login-bug --force\n```\n\nUse review resources for screenshots, log captures, terminal recordings, or evidence files that a reviewer wants to ship with the review record.\n\n## Importing a Plan With Pre-Declared Resources\n\nWhen you author a plan markdown file outside kspec and want its resources to come along on import, place a sibling `resources.yaml` manifest and `resources/` directory next to the plan markdown:\n\n```\nplans/\n├── my-feature.md\n├── resources.yaml\n└── resources/\n    └── ux/\n        └── sign-in-v3.png\n```\n\nThe sibling `resources.yaml` declares the id and path for each file the plan markdown references:\n\n```yaml\nresources:\n  - id: ux-mockup\n    path: ux/sign-in-v3.png\n    label: "Sign-in mockup, v3"\n    description: "Final mockup approved by design review"\n```\n\nThe plan markdown references resources with `./resources/<relative-path>`:\n\n```markdown\n## Background\n\nThe redesigned validation surface is shown in\n[the v3 mockup](./resources/ux/sign-in-v3.png).\n```\n\nThen import:\n\n```bash\nkspec plan import plans/my-feature.md\n```\n\n`kspec plan import` walks the markdown for `./resources/<rel>` links, validates that each link resolves against the sibling `resources.yaml`, and copies the declared files into `.kspec/plans/<plan-ulid>/resources/`. If any link does not resolve, the import fails before writing anything — the plan record will not be saved with dangling references.\n\nWhen you later update a plan with `kspec plan set @plan --content-file <edited.md>`, the new markdown\'s `./resources/<rel>` links must resolve against the **existing** plan\'s `resources.yaml`. Attach the resources first with `kspec plan resource add`, then point the markdown at them.\n\n## Referencing Plan Resources From Tasks\n\nA plan\'s task definitions can declare `resource_refs` so derived tasks know which plan resources they need:\n\n````markdown\n## Tasks\n\n```yaml\n- title: Implement sign-in validation\n  slug: task-implement-sign-in-validation\n  spec_ref: "@sign-in-validation"\n  resource_refs:\n    - "./resources/ux/sign-in-v3.png"\n```\n````\n\nWhen `kspec plan derive` runs, it validates each `resource_refs` entry against the source plan\'s `resources.yaml`. Refs that do not resolve fail derivation.\n\n## Plan Derive: References vs. Materialized Copies\n\nBy default, `kspec plan derive` records a versioned `TaskResourceRef` pointing back at the plan\'s owned resource. No bytes are copied.\n\n```bash\nkspec plan derive @plan-my-feature\n```\n\nThis is the right default: a plan-owned resource is single-sourced, the derived task carries the content hash and git commit captured at derivation time, and consumers can detect drift if the plan\'s resource later changes.\n\nWhen a task needs an immutable snapshot of the plan\'s resource bytes — for example, before handing off long-running work — pass `--materialize-resources`:\n\n```bash\nkspec plan derive @plan-my-feature --materialize-resources\n```\n\nWhen this flag is present, derivation:\n\n1. Copies each referenced plan resource into `.kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/<relative-path>`.\n2. Registers the copy in the task\'s resource manifest under the id `plan-<original-resource-id>` (so a plan resource named `ux-mockup` becomes the task-owned resource `plan-ux-mockup`).\n3. Updates the task\'s `TaskResourceRef` to point at the task-owned copy (`owner_type: "task"`, `owner_ref: <task-ulid>`).\n\nWithout the flag, no resource bytes are copied — the task references the plan\'s resource directly.\n\n## Daemon API Routes\n\nWhen the daemon is running (`kspec serve start`), every plan and review exposes its resources through stable, project-scoped routes. All routes are authenticated through the daemon\'s existing project-scoping.\n\n### Plan Resources\n\n| Method   | Path                                          | Returns                                                             |\n| -------- | --------------------------------------------- | ------------------------------------------------------------------- |\n| `GET`    | `/api/plans/:ref/resources`                   | `{ "resources": ResourceMetadata[] }`                               |\n| `GET`    | `/api/plans/:ref/resources/:resourceId`       | `{ "resource": ResourceMetadata }`                                  |\n| `GET`    | `/api/plans/:ref/resources/:resourceId/bytes` | Raw bytes with `Content-Type` and `X-Kspec-Resource-Sha256` headers |\n| `POST`   | `/api/plans/:ref/resources`                   | `201 { "resource": ResourceMetadata, "replaced": false }` (create)  |\n|          |                                               | `200 { "resource": ResourceMetadata, "replaced": true }` (replace)  |\n| `DELETE` | `/api/plans/:ref/resources/:resourceId`       | `200 { "removed": { "id": string, "path": string } }`               |\n\n### Review Resources\n\n| Method   | Path                                            | Returns                                                             |\n| -------- | ----------------------------------------------- | ------------------------------------------------------------------- |\n| `GET`    | `/api/reviews/:ref/resources`                   | `{ "resources": ResourceMetadata[] }`                               |\n| `GET`    | `/api/reviews/:ref/resources/:resourceId`       | `{ "resource": ResourceMetadata }`                                  |\n| `GET`    | `/api/reviews/:ref/resources/:resourceId/bytes` | Raw bytes with `Content-Type` and `X-Kspec-Resource-Sha256` headers |\n| `POST`   | `/api/reviews/:ref/resources`                   | `201 { "resource": ResourceMetadata, "replaced": false }` (create)  |\n|          |                                                 | `200 { "resource": ResourceMetadata, "replaced": true }` (replace)  |\n| `DELETE` | `/api/reviews/:ref/resources/:resourceId`       | `200 { "removed": { "id": string, "path": string } }`               |\n\n### Task Resources\n\n<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-markdown -->\n\nA derived task does not own a resource upload endpoint — task resources come from the plan it was derived from, either as plan-owned references (the default) or as task-owned copies (`kspec plan derive --materialize-resources`). The daemon exposes a read-only, task-scoped projection so a client can render `./resources/<relative-path>` references from the task description without knowing which owner holds the bytes:\n\n| Method | Path                                          | Returns                                                                        |\n| ------ | --------------------------------------------- | ------------------------------------------------------------------------------ |\n| `GET`  | `/api/tasks/:ref/resources`                   | `{ "resources": ResolvedTaskResourceSummary[] }`                               |\n| `GET`  | `/api/tasks/:ref/resources/:resourceId`       | `{ "resource": ResolvedTaskResourceSummary }`                                  |\n| `GET`  | `/api/tasks/:ref/resources/:resourceId/bytes` | Raw bytes with `Content-Type`, `Content-Length`, and `X-Kspec-Resource-Sha256` |\n\nThe task detail API response (`GET /api/tasks/:ref`) includes the same projection inline when the task has resource references:\n\n- `resolved_resources` — an array of `ResolvedTaskResourceSummary` entries, each reporting `owner_type` (`"plan"` or `"task"`), `owner_ref`, `id`, `path`, `content_type`, `byte_size`, `status`, `recorded_sha256`, `current_sha256`, `recorded_git_commit`, `current_git_commit`, and a human-readable `message`.\n- `resources_base_url` — a task-scoped base (`/api/tasks/<task-ulid>/resources`) so a client builds browser-fetchable URLs as `resources_base_url/<resource-id>/bytes` without guessing whether the bytes are plan-owned or task-owned.\n\nTask list, dashboard, and other index-tier surfaces stay bounded — they do **not** embed resource bytes or full resource manifests. Resolve bytes through the task detail projection and the `/bytes` route only.\n\n<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-drift -->\n\nEach `ResolvedTaskResourceSummary.status` is one of `present`, `drift`, `missing`, or `unresolved`. When a task resource is drifted, missing, or unresolved, the detail and bytes routes report the status through the `message` field and the `/bytes` route refuses to stream replacement bytes that differ from the hash recorded at task derivation. The live task detail UI renders the `status` and `message` instead of rewriting the markdown target, and an authoring reference that matches no resolved resource stays visible as raw `./resources/<relative-path>` text with guidance to verify the path or re-derive the task — never a silent substitution.\n\n### Browser Resource URLs Need URL-Level Project Context\n\n<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-browser-project-context -->\n\nIn live multi-project mode the daemon resolves which project a request targets from the `X-Kspec-Dir` request header. A `fetch()` from application code can set that header, but a browser `<img src>` or `<a href>` element fetch **cannot send `X-Kspec-Dir`** — the browser controls those request headers, not the page. Without project context, the daemon would resolve the resource against its default project and serve the wrong bytes or a project-not-found response.\n\nTo make rendered image and link resource URLs route to the selected project, the web UI appends the selected project\'s path as a URL-level `kspec_dir` query parameter when rewriting markdown resource references:\n\n```\n/api/tasks/<task-ulid>/resources/<resource-id>/bytes?kspec_dir=<url-encoded-project-path>\n/api/plans/<plan-ulid>/resources/<resource-id>/bytes?kspec_dir=<url-encoded-project-path>\n```\n\nThe daemon project-context middleware reads the project path from the `X-Kspec-Dir` header when present and otherwise from the `kspec_dir` query parameter, so element fetches that cannot set headers still resolve to the correct project. The resource still resolves only through the owning entity\'s manifest, so undeclared paths, absolute paths, parent traversal, and symlink escapes remain rejected regardless of the `kspec_dir` value.\n\n### POST Upload Shape\n\nBoth plan and review POST routes accept `multipart/form-data` with the following fields (task resources have no upload route — they are derived from plans):\n\n| Field          | Required | Notes                                                                                                                    |\n| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |\n| `file`         | Yes      | The resource file. Missing → `400 missing_resource_file`.                                                                |\n| `id`           | Yes      | Resource id. Must match `[a-z0-9][a-z0-9._-]{0,127}`.                                                                    |\n| `path`         | Yes      | POSIX-relative path under the entity\'s `resources/`.                                                                     |\n| `label`        | No       | Optional human-friendly label.                                                                                           |\n| `description`  | No       | Optional free-form description.                                                                                          |\n| `content_type` | No       | Explicit MIME type. Inferred from `path` extension when omitted.                                                         |\n| `replace`      | No       | Accepts `"true"`/`"1"` (true) or `"false"`/`"0"` (false). Other values → `400 invalid_replace_value`. Omitted → `false`. |\n\n### Status and Error Mapping\n\n| Status | When                                                                                             | Body shape                                                                                                                                             |\n| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |\n| `200`  | Successful GET, replace POST, or DELETE                                                          | See route table above                                                                                                                                  |\n| `201`  | Successful create POST                                                                           | `{ "resource": ResourceMetadata, "replaced": false }`                                                                                                  |\n| `400`  | `invalid_resource_id`, `invalid_resource_path`, `missing_resource_file`, `invalid_replace_value` | `{ "error": code, "code": code, "message": string, "resource_id": string\\|null, "path": string\\|null }`                                                |\n| `404`  | `plan_not_found`, `review_not_found`, `resource_not_found`                                       | Same shape as 400                                                                                                                                      |\n| `409`  | `resource_conflict` (id or path collision without `replace`)                                     | Same shape as 400                                                                                                                                      |\n| `409`  | `entity_storage_incompatible` (project not on folder-backed storage)                             | `{ "error": "entity_storage_incompatible", "code": <domain-code>, "message": string, "suggestion": string, "domain": string, "cache_domain": string }` |\n\nThe `entity_storage_incompatible` envelope is shared across all routes that need folder-backed plan, review, or resource data. See [`entity_storage_incompatible`: project storage format mismatch](../troubleshooting/entity-storage-incompatible.md) for the recovery procedure.\n\n### Response Bytes Header\n\nThe `/bytes` route sets:\n\n- `Content-Type` — the resource\'s stored `content_type`\n- `Content-Length` — the resource\'s stored `bytes`\n- `X-Kspec-Resource-Sha256` — the resource\'s stored `sha256`\n\nClients can compare `X-Kspec-Resource-Sha256` against a previously-recorded hash to detect drift without parsing the response body.\n\n## Static Export\n\nWhen the web UI is exported as a static snapshot (`kspec export`), local resource files are copied into the export tree at:\n\n```\n<export-root>/assets/resources/plan/<plan-ulid>/<relative-path>\n<export-root>/assets/resources/task/<task-ulid>/<relative-path>\n<export-root>/assets/resources/review/<review-ulid>/<relative-path>\n```\n\nThe exported metadata includes an `exported_path` field pointing at the asset location. Markdown content in plan and task exports is rewritten so `./resources/<relative-path>` image and link references point at the exported asset path. The static UI works offline without re-resolving references through the daemon. Only `present` task resources are copied and carry an `exported_path`; drifted, missing, or unresolved task references are not exported as bytes.\n\nJSON-to-stdout and `--dry-run` exports skip the file copy but still emit `exported_path` so consumers can construct the expected path.\n\n## Verification\n\nConfirm the full round-trip works in your project:\n\n```bash\n# Attach\nkspec plan resource add @plan-my-feature ./README.md \\\n  --id readme-snapshot \\\n  --path docs/readme.md\n\n# Confirm it landed\nkspec plan resource list @plan-my-feature\nkspec plan resource get  @plan-my-feature readme-snapshot --json\n\n# Reference it from a derived task\nkspec plan derive @plan-my-feature --dry-run\n\n# Remove it\nkspec plan resource remove @plan-my-feature readme-snapshot --force\n```\n\nThe list output should show the attached resource after `add`, the get output should report a populated `sha256` and accurate `bytes`, and the remove output should report the removed id and path.\n\n## End-to-End Verification in a Temp Project\n\n<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-temp-project-e2e-steps -->\n\nThese steps validate the full resource lifecycle end to end — CLI storage, daemon bytes routes, live UI image and link rendering, selected-project browser URL routing, and static export asset existence — **without restarting or stopping the daemon**. Start the daemon once at step 3 and leave it running for every later step; the live UI and the static export both read from the same running daemon. Adjust paths and refs to your fixtures.\n\n### 1. Create two temp projects and author plan resources\n\nUse two separate projects so you can exercise both ownership cases: one project keeps plan-owned task references (the default), the other derives a materialized task-owned copy.\n\n````bash\n# Default-refs project\nmkdir -p /tmp/kspec-res-default && cd /tmp/kspec-res-default\ngit init -q && kspec init\n\n# Author a plan with a sibling resources.yaml + resources/ holding an image and a document\nmkdir -p plans/resources/ux plans/resources/docs\ncp /path/to/sign-in-v3.png plans/resources/ux/sign-in-v3.png\ncp /path/to/spec.pdf         plans/resources/docs/spec.pdf\ncat > plans/resources.yaml <<\'YAML\'\nresources:\n  - id: ux-mockup\n    path: ux/sign-in-v3.png\n  - id: spec-doc\n    path: docs/spec.pdf\nYAML\ncat > plans/feature.md <<\'MD\'\n# Sign-in feature\n\nMockup: ![v3 mockup](./resources/ux/sign-in-v3.png)\nDoc: [spec](./resources/docs/spec.pdf)\n\n## Tasks\n\n```yaml\n- title: Build sign-in\n  slug: task-build-sign-in\n  description: |\n    Reference image: ![mockup](./resources/ux/sign-in-v3.png)\n    Reference doc: [spec](./resources/docs/spec.pdf)\n  resource_refs:\n    - "./resources/ux/sign-in-v3.png"\n    - "./resources/docs/spec.pdf"\n```\n\nMD\n\n````\n\n### 2. Import, derive default refs, and derive a materialized copy in a clean project\n\n```bash\n# Default-refs project: import + approve + derive (plan-owned refs, no bytes copied)\nkspec plan import plans/feature.md\nkspec plan approve @plan-sign-in-feature   # use the slug printed by import\nkspec plan derive @plan-sign-in-feature\n\n# CLI storage check — task carries resolved resource refs with present status\nkspec task get @task-build-sign-in --json | jq \'.resolved_resources[] | {id, owner_type, status}\'\n\n# Separate clean project: same plan, derived with materialized task-owned copies\nmkdir -p /tmp/kspec-res-materialized && cd /tmp/kspec-res-materialized\ngit init -q && kspec init\ncp -r /tmp/kspec-res-default/plans ./plans\nkspec plan import plans/feature.md\nkspec plan approve @plan-sign-in-feature\nkspec plan derive @plan-sign-in-feature --materialize-resources\n\n# Materialized copies live under the task tree with the plan-<id> prefix\nkspec task get @task-build-sign-in --json | jq \'.resolved_resources[] | {id, owner_type, status}\'\nls .kspec/tasks/*/resources/plan/*/ux/sign-in-v3.png\n```\n\nFor the default-refs project, `owner_type` is `plan`; for the materialized project it is `task` and the ids are prefixed `plan-`. Both report `status: present`.\n\n### 3. Start the daemon once — do not stop or restart it\n\n```bash\ncd /tmp/kspec-res-default\nkspec serve start\ncurl -s http://127.0.0.1:3456/api/health    # confirm it is up\n```\n\nLeave this daemon running for every step below. The default project is its default project; the materialized project is targeted by URL-level project context (`kspec_dir`), so you never need to restart the daemon to switch projects.\n\n### 4. Verify daemon bytes routes for plan-owned and task-owned resources\n\nRead the task-scoped projection, then fetch bytes from the task resource route. Use the `kspec_dir` query parameter to target the materialized project through the same running daemon.\n\n```bash\nDEFAULT_DIR=/tmp/kspec-res-default\nMAT_DIR=/tmp/kspec-res-materialized\n\n# Plan-owned (default project) — resolve base URL + ids from task detail\ncurl -s "http://127.0.0.1:3456/api/tasks/@task-build-sign-in/resources" \\\n  -H "X-Kspec-Dir: $DEFAULT_DIR" | jq \'.resources[] | {id, owner_type, status}\'\n\n# Fetch plan-owned bytes; -D - prints the X-Kspec-Resource-Sha256 header\ncurl -s -D - -o /tmp/img.png \\\n  "http://127.0.0.1:3456/api/tasks/@task-build-sign-in/resources/ux-mockup/bytes" \\\n  -H "X-Kspec-Dir: $DEFAULT_DIR" | grep -i x-kspec-resource-sha256\n\n# Task-owned copy (materialized project) targeted via kspec_dir query param — no daemon restart\ncurl -s -o /tmp/img-mat.png \\\n  "http://127.0.0.1:3456/api/tasks/@task-build-sign-in/resources/plan-ux-mockup/bytes?kspec_dir=$MAT_DIR"\n```\n\nBoth fetches return the recorded bytes with `Content-Type`, `Content-Length`, and `X-Kspec-Resource-Sha256` matching the resource recorded at derivation. A drifted, missing, or unresolved reference reports its status instead of streaming replacement bytes.\n\n### 5. Verify live UI image/link rendering and selected-project browser routing\n\nWith the daemon still running, open the web UI (dev server on port 5173, or the daemon-served UI) and:\n\n- Open the **default project\'s** task `task-build-sign-in` in the task detail modal. The `./resources/...` image renders and the document link opens — the UI rewrote them to `/api/tasks/<task-ulid>/resources/<id>/bytes` URLs.\n- Select the **materialized project** in the project switcher and open its task. The same references render from the task-owned copies. Because `<img>` and `<a>` element fetches cannot send `X-Kspec-Dir`, the rendered URLs carry `?kspec_dir=<project-path>` so they route to the selected project through the same daemon — confirm by inspecting an image URL in the browser devtools network panel.\n\n### 6. Verify static export asset existence — same daemon, no restart\n\n```bash\n# Export each project to a static snapshot. Resource assets are copied beside\n# the JSON output file, so write the snapshot inside a per-project export dir.\nmkdir -p /tmp/export-default /tmp/export-materialized\ncd /tmp/kspec-res-default && kspec export --format json --output /tmp/export-default/snapshot.json\ncd /tmp/kspec-res-materialized && kspec export --format json --output /tmp/export-materialized/snapshot.json\n\n# Plan-owned task asset is copied under the task asset path\nls /tmp/export-default/assets/resources/task/*/ux/sign-in-v3.png\nls /tmp/export-default/assets/resources/task/*/docs/spec.pdf\n\n# Materialized task asset also exists under the task asset path\nls /tmp/export-materialized/assets/resources/task/*/ux/sign-in-v3.png\n\n# Plan resources are copied under the plan asset path\nls /tmp/export-default/assets/resources/plan/*/ux/sign-in-v3.png\n```\n\nEach `ls` should list the advertised asset file. The exported plan and task markdown is rewritten to point at these `assets/resources/...` paths, so the offline snapshot renders the same images and links without the daemon.\n\nWhen you finish, you may stop the daemon — but every verification above was performed against a single continuously-running daemon.\n\n## Next Steps\n\n- [Importing and Approving a Plan](./importing-and-approving-a-plan.md) — full plan workflow including resource-aware import and `--materialize-resources` derivation\n- [Local Resources for Plans and Reviews](../concepts/local-resources.md) — the model behind the commands and routes\n- [`entity_storage_incompatible`: project storage format mismatch](../troubleshooting/entity-storage-incompatible.md) — fix when resource commands fail on an unmigrated project\n- [Plan or Review Index Has Drifted From Folder Contents](../troubleshooting/plan-or-review-index-drift.md) — fix when the project-wide index disagrees with on-disk folders\n',path:"guides/working-with-local-resources.md"},{slug:"release-notes",title:"Release Notes",content:"# Release Notes\n\nThe Release Notes section shows what changed in each version of kspec so you can see what is new in the version you have installed and review the history of prior releases.\n\nThe authoritative release notes live in `RELEASE_NOTES.md` at the repository root. You can read them in four ways:\n\n- [Changelog](./changelog.md) — the docs build renders the repository's `RELEASE_NOTES.md` directly and creates an anchor for each version heading.\n- Run `kspec release-notes` to print notes for the installed version, or `kspec release-notes --from <version> --to <version>` for an inclusive range.\n- Run `kspec upgrade` (or `kspec upgrade --dry-run`); the output appends release notes for every intervening version.\n- Read [`RELEASE_NOTES.md`](https://github.com/lepahc/kynetic-spec/blob/main/RELEASE_NOTES.md) directly on GitHub.\n",path:"release-notes/index.md"},{slug:"troubleshooting",title:"Troubleshooting",content:`# Troubleshooting

The Troubleshooting section is an index of recovery procedures keyed by the symptom you observe in your own output or in your agent's output. Each entry describes the symptom, explains what it means, and walks you through the recovery steps.

- [Shadow Branch Is Out of Sync With Remote](./shadow-branch-out-of-sync.md) — local and remote shadow branches have diverged
- [Shadow Branch Worktree Is Broken or Missing](./shadow-branch-worktree-broken.md) — \`.kspec/\` directory is missing or disconnected
- [Daemon Cannot Start Because the Port Is Already in Use](./daemon-port-in-use.md) — port 3456 is occupied by another process
- ["Cannot Run kspec From Inside the Shadow Directory" Error](./cannot-run-from-inside-kspec.md) — your working directory is inside \`.kspec/\`
- [Upgrade Reports a Pre-Plan State or Partial Scaffold](./upgrade-pre-plan-state.md) — project needs newer configuration after a version upgrade
- [\`entity_storage_incompatible\`: Project Storage Format Mismatch](./entity-storage-incompatible.md) — plan, review, or resource command fails because the project is not on folder-backed storage
- [Plan or Review Index Has Drifted From Folder Contents](./plan-or-review-index-drift.md) — the project-wide index disagrees with the on-disk folders; rebuild it
- [Agent Dispatch Refuses to Assign a Task](./dispatch-refuses-to-assign.md) — a task is not being picked up by the dispatch engine
- [Dispatch Bootstrap Fails Before the Agent Starts](./dispatch-bootstrap-failures.md) — workspace preparation fails before a worker or reviewer begins
- [A Dispatch Workspace Cannot Sync or Clean Up](./dispatch-workspace-sync-and-cleanup.md) — target, registry, synchronization, or cleanup status needs operator attention
- [Dispatch Lifecycle Status Rejects an Action or Shows Cleanup](./dispatch-lifecycle-control-failures.md) — current authority, task identity, or scoped cleanup determines the safe retry
- [A Review Is Blocking Merge With an Unresolved Thread](./review-blocking-merge.md) — merge gate rejects work due to an open blocker thread
- [Runner Validation Failures](./runner-validation-failures.md) — diagnose \`kspec agent runners validate\` errors by \`reason\` code
`,path:"troubleshooting/index.md"},{slug:"troubleshooting/cannot-run-from-inside-kspec",title:'"Cannot Run kspec From Inside the Shadow Directory" Error',content:`# "Cannot Run kspec From Inside the Shadow Directory" Error

You run a kspec command and see the error message "Cannot run kspec from inside .kspec/ directory" (or similar), and the command refuses to execute.

## What This Means

kspec expects to be run from your project root — the directory that contains \`.kspec/\` as a subdirectory. The \`.kspec/\` directory is a git worktree for the [shadow branch](../concepts/the-shadow-branch.md), and it has its own \`.git\` pointer inside it.

If your current working directory is inside \`.kspec/\` (or is the \`.kspec/\` directory itself), kspec detects that you are inside the shadow worktree rather than the main project tree. Running commands from this location would operate on the wrong git context, so kspec blocks it.

This most often happens when:

- You navigated into \`.kspec/\` to inspect a YAML file and forgot to change back.
- A script or terminal session started inside the shadow directory.
- An editor's integrated terminal opened with \`.kspec/\` as the working directory.

## How to Fix It

Change your working directory back to the project root:

\`\`\`bash
cd ..
\`\`\`

If you are nested deeper inside \`.kspec/\`, navigate up to the project root — the directory that contains \`.kspec/\` as a child:

\`\`\`bash
cd /path/to/your/project
\`\`\`

Then run your kspec command again from the project root.

If you need to inspect files inside \`.kspec/\`, use your editor or \`cat\` to read them without changing directories. The kspec CLI provides commands to query spec state directly:

\`\`\`bash
kspec item get @your-item
kspec task get @your-task
\`\`\`

These commands read from the shadow branch without requiring you to navigate into \`.kspec/\`.

## Verification

Confirm you are in the right directory:

\`\`\`bash
pwd
\`\`\`

The output should be your project root (the parent of \`.kspec/\`). Running any kspec command should now work:

\`\`\`bash
kspec session start
\`\`\`

A healthy outcome is that the command executes without the "Cannot run kspec from inside .kspec/ directory" error.
`,path:"troubleshooting/cannot-run-from-inside-kspec.md"},{slug:"troubleshooting/daemon-port-in-use",title:"Daemon Cannot Start Because the Port Is Already in Use",content:`# Daemon Cannot Start Because the Port Is Already in Use

You try to start the kspec daemon and see an error that the port (default 3456) is already in use, or the daemon fails to bind and exits immediately.

## What This Means

The [kspec daemon](../concepts/web-ui-and-daemon.md) is a local HTTP server that serves the API and hosts the web UI. It needs an available TCP port to listen on. When port 3456 is already occupied, the daemon cannot start.

Common causes:

- A previous daemon instance is still running (perhaps from an earlier session that wasn't stopped cleanly).
- Another application on your machine is using port 3456.
- A dispatch engine session left a daemon process running in the background.

## How to Fix It

First, check whether a kspec daemon is already running:

\`\`\`bash
kspec serve status
\`\`\`

If a daemon is already running and healthy, you may not need to start another one — another session may already be using it.

### If you are running inside a dispatch session

When the [dispatch engine](../concepts/agents-and-dispatch.md) is active, the daemon is the host process. **Do not run \`kspec serve stop\` or \`kspec serve restart\`** — doing so kills the dispatch engine and terminates the agent. If you hit a port conflict during dispatch, it means a daemon is already serving your project. Confirm with \`kspec serve status\` and use the running instance. If the port is held by a different process, block the task and escalate — the conflict must be resolved outside the dispatch session.

### If you are running outside dispatch

Stop the existing daemon and start a fresh one:

\`\`\`bash
kspec serve stop
kspec serve start
\`\`\`

If \`kspec serve stop\` does not resolve the issue (for example, if a non-kspec process holds the port), find out what is using the port:

\`\`\`bash
lsof -i :3456
\`\`\`

This shows the process ID of whatever is bound to port 3456. If it's a stale kspec process, you can terminate it:

\`\`\`bash
kill <pid>
\`\`\`

Replace \`<pid>\` with the process ID from the \`lsof\` output. Then start the daemon again:

\`\`\`bash
kspec serve start
\`\`\`

## Verification

After starting the daemon, confirm it's running:

\`\`\`bash
kspec serve status
\`\`\`

A healthy outcome shows the daemon running and listening on its port. You can also verify with a direct health check:

\`\`\`bash
curl http://localhost:3456/api/health
\`\`\`

A successful response confirms the daemon is up and serving requests.
`,path:"troubleshooting/daemon-port-in-use.md"},{slug:"troubleshooting/dispatch-bootstrap-failures",title:"Dispatch Bootstrap Fails Before the Agent Starts",content:`# Dispatch Bootstrap Fails Before the Agent Starts

Bootstrap can fail while dispatch is preparing a worker or reviewer workspace. The agent invocation does not start: dispatch writes a \`[DISPATCH-BOOTSTRAP]\` task note and blocks the task. Start with that note and the recorded workspace outcome rather than treating preparation as an agent failure or rerunning commands blindly. After correcting the reported cause, run \`kspec task unblock @task-ref\`; unblock restores the task's prior status so its matching dispatch event can be evaluated again.

## A Bootstrap Step Exits Nonzero

### What this means

A configured project or agent bootstrap step returned a nonzero exit code. Dispatch did not start the role because the workspace was not prepared successfully.

### What to observe

Read the failed step name, exit code, and bounded output tail in dispatcher output and the \`[DISPATCH-BOOTSTRAP]\` task note. The combined standard-output/error tail is limited to the last 4,000 characters and is not redacted. Confirm the blocked task and dispatch state with \`kspec task get @task-ref\` and \`kspec agent dispatch status --json\`.

### Recovery procedure

Fix the command, dependency, credentials, or project input named by that step in its source configuration. Then run \`kspec task unblock @task-ref\`; the restored task status supplies the matching dispatch event, and dispatch evaluates bootstrap for the same workspace and role. Do not replace the configured step with an ad hoc command in the managed worktree.

### Healthy outcome

The task is no longer blocked, the workspace reports bootstrap as ready, the step exits successfully, and the matching worker or reviewer starts without losing the task branch or recorded failure.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for the preparation boundary and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for bootstrap configuration.

## Bootstrap Reports Tracked-File Changes

### What this means

A bootstrap step changed tracked repository files without declaring that mutation safe. Dispatch stops preparation so dependency setup cannot silently become task work or contaminate a reviewer snapshot.

### What to observe

Use \`git status --short\` in the reported workspace to identify the tracked changes. Compare them with the failed step and confirm the workspace identity with \`kspec task get @task-ref\`.

### Recovery procedure

Undo the unintended change through the owning tool or correct the bootstrap step so it is read-only. If tracked mutation is an intentional, reviewed part of preparation, configure that individual step with the supported opt-in described in the workspace guide. Then run \`kspec task unblock @task-ref\` so dispatch can retry preparation from the restored task status.

### Healthy outcome

The task is no longer blocked, and the bootstrap step completes with a clean tracked-file status or an explicitly permitted intentional mutation.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for isolation and evidence ownership and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for the tracked-mutation policy.

## A Reviewer Bootstrap Rerun Is Refused

### What this means

A reviewer snapshot could not safely reuse the worker's prepared state, but one of the required steps is not allowed to rerun for reviewers. Dispatch refuses rather than executing a potentially destructive or role-inappropriate step in the detached snapshot.

### What to observe

Read the named step and reviewer-rerun refusal in dispatcher output and the \`[DISPATCH-BOOTSTRAP]\` task note. Use \`kspec task get @task-ref\` to confirm that dispatch blocked the task while preserving its worker submission and prior \`pending_review\` status for recovery.

### Recovery procedure

Make the step safely repeatable for a detached reviewer and enable reviewer rerun for that step, or restrict it to the worker role when reviewers do not need its output. Then run \`kspec task unblock @task-ref\`; unblock restores \`pending_review\`, allowing the reviewer event to be evaluated again without a new submission.

### Healthy outcome

The task is restored to \`pending_review\`; the reviewer either reuses valid worker preparation or runs only the explicitly safe reviewer steps, then opens the submitted snapshot without changing the worker workspace.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for detached reviewer lifecycle and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for role and rerun controls.

## Previously Successful Bootstrap State Is Invalidated

### What this means

Dispatch reruns cached preparation for exactly three recorded signals: \`prior-bootstrap-failed\`, \`bootstrap-config-changed\`, or \`canonical-branch-head-changed\`.

### What to observe

Read those invalidation reasons in the workspace outcome and allow the automatic rerun to finish. If the automatic rerun succeeds, the workspace records a new successful result and the task is not blocked merely because its cache was invalidated. Only when the rerun itself fails will \`kspec task get @task-ref\` show a blocked task and a \`[DISPATCH-BOOTSTRAP]\` note; use \`kspec agent status\` for the current dispatch projection.

### Recovery procedure

Allow dispatch to rerun preparation automatically. Correct a previously failed step or unintended bootstrap configuration if that rerun reports an error. If the canonical branch advanced intentionally, keep that branch state and let preparation run against its new head. Only when the rerun failed and the task is actually blocked should you run \`kspec task unblock @task-ref\` after correcting the failure; unblock restores the prior task status for another matching attempt. Do not mark cached state valid manually.

### Healthy outcome

Bootstrap runs against the recorded configuration and canonical branch head, records a new successful result, and the role starts without reusing stale preparation. A successful automatic rerun leaves the task unblocked; after a failed rerun, the corrected and explicitly unblocked task returns to its prior status and reaches the same result.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for source-bound state and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for target precedence.

## The Prepared Workspace Cannot Be Accessed

### What this means

Dispatch has a workspace record, but the recorded directory is missing, unreadable, or no longer a usable managed worktree. The agent is not started against a replacement directory because that would detach the run from its durable evidence.

### What to observe

Use \`kspec task get @task-ref\` and \`kspec agent dispatch status --json\` to preserve the task and dispatcher view. Inspect the reported directory with ordinary read-only filesystem checks and \`git status --short\`; do not create a directory at that path as a substitute.

### Recovery procedure

Restore host access or permissions when the same managed worktree still exists. Otherwise leave the record and branch intact so normal startup reconciliation can classify and recover or reprovision the workspace. When the workspace is accessible again, run \`kspec task unblock @task-ref\`; escalate instead when reconciliation continues to report the record as stale or invalid.

### Healthy outcome

The task is no longer blocked, and dispatch can open the recorded workspace or safely reprovision the canonical task workspace while preserving branch and task history.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for registry authority and workspace continuity.

## A Bootstrap Failure Exposes Unsafe Command Output

### What this means

Bootstrap records a bounded tail of combined standard output and error so the end of a failure remains diagnosable. The last 4,000 characters are not redacted and can therefore expose anything the command prints, including a credential or private host value.

### What to observe

Read the failed step and bounded output in dispatcher output and the \`[DISPATCH-BOOTSTRAP]\` task note without copying it into another report. Check \`kspec task get @task-ref\` for the blocked task. Treat any secret printed by the step as exposed.

### Recovery procedure

Rotate any printed credential, remove secret-bearing output from the step, and replace it with safe diagnostics. Then run \`kspec task unblock @task-ref\` to restore the prior task status and retry the matching dispatch event. Restrict access to the workspace and session evidence according to the project's incident procedure.

### Healthy outcome

The task is no longer blocked, the corrected step exits successfully, dispatch reports ready state, and any later failure tail contains useful diagnostics without credentials or private values.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for the evidence model and [Agents and Dispatch](../concepts/agents-and-dispatch.md) for invocation output.
`,path:"troubleshooting/dispatch-bootstrap-failures.md"},{slug:"troubleshooting/dispatch-lifecycle-control-failures",title:"Dispatch Lifecycle Status Rejects an Action or Shows Cleanup",content:`# Dispatch Lifecycle Status Rejects an Action or Shows Cleanup

Lifecycle failures are recovered from current status, not from private state edits. Read the global authority, canonical task control, and matching cleanup entry before choosing start, resume, pause, or hard-stop retry.

## Start, Resume, or Pause Reports an Invalid Transition

### What this means

The requested action is not valid from the current authority or task mode. The \`invalid_transition\` failure includes current status and does not substitute another action.

### What to observe

Run \`kspec agent status\` and \`kspec agent dispatch status --json\`. Compare global authority, projection, and matching cleanup with the action matrix in the lifecycle guide.

### Recovery procedure

Use \`kspec agent dispatch start\` only from cleanup-idle stopped authority, \`kspec agent dispatch resume\` only from paused authority, and pause only where status offers it. For task controls, use the action valid for that canonical task row.

### Healthy outcome

The requested valid transition succeeds or reports a no-op, and status shows the intended authority without changing task readiness.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for authority versus readiness and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for the action matrices.

## A Held Task Does Not Start

### What this means

The task may be semantically ready while global or task lifecycle authority still holds admission. A task resume also cannot bypass paused or stopped global authority.

### What to observe

Run \`kspec task get @task-ref\`, \`kspec tasks ready --eligible\`, and \`kspec agent dispatch status --json\`. Match the canonical task in \`heldTasks\` and \`taskControls\`, then check global authority.

### Recovery procedure

If the task row is paused or stopped with idle cleanup, use \`kspec agent dispatch task resume @task-ref\`. If global authority is paused, use \`kspec agent dispatch resume\`; if it is cleanup-idle stopped, use \`kspec agent dispatch start\`. Resolve ordinary readiness or dependency failures separately.

### Healthy outcome

Current authoritative state is re-evaluated, the held row clears when no other gate remains, and at most one invocation starts for the canonical task.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for held admission and [Agents and Dispatch](../concepts/agents-and-dispatch.md) for assignment.

## A Task Alias Is Missing, Ambiguous, or Mismatched

### What this means

Task-scoped control could not resolve one canonical identity. Closed outcomes include \`task_not_found\`, \`task_identity_ambiguous\`, and \`task_identity_mismatch\`; the request has no effect.

### What to observe

Use \`kspec task get @task-ref\` and \`kspec search "task title"\` to find a full ULID or unique alias. Compare any supplied task id and ref before retrying.

### Recovery procedure

Retry the same task action with one unambiguous slug, full ULID, or unique ULID prefix. Do not add or rewrite a task-control record manually.

### Healthy outcome

Status stores one task-control row under the canonical ULID, displays the friendly ref, and leaves unrelated tasks unchanged.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for canonical task identity and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for accepted aliases.

## Dispatch Is Stopped With Pending or Failed Cleanup

### What this means

A hard stop committed no-start authority but cancellation or session closure did not finish. The contract is: \`hard-stop failure remains stopped with retryable pending or failed matching cleanup\`; it never reports false success.

### What to observe

Run \`kspec agent dispatch status --json\` and identify the cleanup entry's \`global\` or canonical-task scope, phase, status, and closed error code.

### Recovery procedure

Correct the reported host condition, then retry only the matching scope. Use \`kspec agent dispatch stop --force\` for global cleanup or \`kspec agent dispatch task stop @task-ref --force\` for that task. Aggregate cleanup is observability only and unrelated entries do not choose the retry.

### Healthy outcome

Matching cleanup becomes idle. Successful cleanup leaves stopped authority in place until an explicit \`kspec agent dispatch start\` or applicable \`kspec agent dispatch task resume @task-ref\` permits work again.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for evidence preservation and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for scoped cleanup.

## The Control Store Is Unavailable, Corrupt, or Cannot Commit

### What this means

Durable lifecycle authority could not be read or committed. The closed codes are \`control_store_unavailable\`, \`control_store_corrupt\`, and \`control_commit_failed\`; failed writes do not publish a new authority.

### What to observe

Record the closed code and current status from the failed control response. Run \`kspec agent status\` from the project root and check shadow health with \`kspec shadow status\` when the message identifies shadow-state availability.

### Recovery procedure

Restore project or shadow-branch access using the supported shadow recovery guidance, then repeat the same valid lifecycle command. Do not edit \`.kspec/dispatch-control.yaml\` or synthesize a commit.

### Healthy outcome

The durable write commits, status publishes the new authority once, and restart observes the same authority before scheduling.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for durable authority and [The Shadow Branch](../concepts/the-shadow-branch.md) for supported shadow recovery.

## Cleanup Cannot Verify Ownership or Process Identity

### What this means

Dispatch cannot prove session ownership, process birth, or live process-group membership. \`cleanup_identity_unverifiable\` and related ownership, birth, leader, or group codes keep cleanup pending or failed and prevent signalling an uncertain process.

### What to observe

Use \`kspec agent dispatch status --json\` to record scope, cleanup phase, and error code. Preserve the session, process, branch, workspace, worktree, snapshot, and audit evidence named by the stop result.

### Recovery procedure

Retry the same global or task hard stop only after the host can provide equivalent ownership and process-identity evidence. If verification remains unavailable, escalate with the closed code and status; never edit session ownership, process ids, or process groups.

### Healthy outcome

Verified matching work is cancelled and cleanup becomes idle, or uncertain work remains unsignalled with explicit pending evidence instead of a false success.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for protected evidence and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for recovery limitations.

## Hard Stop Is Rejected From a Dispatch-Owned Session

### What this means

The caller belongs to the dispatch engine it is trying to stop. Host-stop rejection prevents an agent from cancelling its own runtime and stranding orchestration state.

### What to observe

The command reports that a dispatch-owned session cannot hard-stop its host. Confirm current authority with \`kspec agent status\`; no stop request was applied.

### Recovery procedure

Open an independent operator shell outside the dispatch-owned invocation, inspect status, then run the same global or task stop there with the required confirmation or \`--force\`.

### Healthy outcome

The independent operator request controls only matching dispatch-owned work, and the original rejected request caused no authority change.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for ownership boundaries and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for hard-stop safety.

## Hard Stop Requires Confirmation or --force

### What this means

Hard stop cancels active matching work. Interactive use requires confirmation; noninteractive and JSON use require \`--force\`. Cancelling the prompt sends no request.

### What to observe

Read the warning about active cancellation and preserved evidence. If the command says hard stop requires \`--force\`, verify the intended scope with \`kspec agent dispatch status --json\` before retrying.

### Recovery procedure

Confirm the interactive prompt when cancellation is intended. In a reviewed noninteractive procedure, use \`kspec agent dispatch stop --force\` or \`kspec agent dispatch task stop @task-ref --force\` for the exact scope.

### Healthy outcome

Declining leaves status unchanged. Confirming commits stopped authority, attempts matching cleanup, and preserves evidence whether cleanup succeeds or remains pending.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for evidence ownership and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for confirmation semantics.

## Lifecycle Controls Are Read-Only in the Static UI

### What this means

The static documentation/web export has no writable daemon connection. The agents view intentionally projects stopped, empty lifecycle status and does not send mutation requests.

### What to observe

The \`/agents\` view labels itself read-only and offers no working lifecycle mutation. Use \`kspec agent status\` in a writable project checkout to observe the live daemon instead.

### Recovery procedure

Open the daemon-backed web UI for the intended project or use the matching CLI command from that project root. Do not treat the static projection as live authority.

### Healthy outcome

The writable surface shows current authority and valid actions, while the static surface remains safely readable and sends no control requests.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for the live authority boundary and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for CLI and UI surfaces.
`,path:"troubleshooting/dispatch-lifecycle-control-failures.md"},{slug:"troubleshooting/dispatch-refuses-to-assign",title:"Agent Dispatch Refuses to Assign a Task",content:"# Agent Dispatch Refuses to Assign a Task\n\nYou start the dispatch engine or run an agent, but the task you expect to be picked up is not assigned. The agent reports no eligible work, or the dispatch status shows the task as unmatched.\n\n## What This Means\n\nThe [dispatch engine](../concepts/agents-and-dispatch.md) matches tasks to agents based on several conditions. A task will not be assigned if any of these checks fail:\n\n- **The matching rule filters the task out.** For each candidate, automation filtering is evaluated per matching rule and event. The default worker rules for `task.ready`, `task.in_progress`, and `task.needs_work` require `automation: eligible`; a reviewer rule for `task.pending_review` or a project-defined rule may use a different filter.\n- **The task is not in a dispatchable state.** Only tasks in `pending`, `in_progress`, or `needs_work` status are candidates for worker agents. Tasks that are `blocked`, `completed`, `cancelled`, or `pending_review` are not routed to workers.\n- **No agent matches the trigger event.** Each agent defines which events it handles. If no agent's dispatch rules match the task's current event, it stays in the queue.\n- **The task has unmet dependencies.** If a task's `depends_on` references include incomplete tasks, it is not considered ready.\n- **Lifecycle authority and held status prevent admission.** A task can remain semantically ready while global dispatch is paused or stopped, or while its canonical task control is paused or stopped. Lifecycle control does not rewrite task readiness.\n\n## How to Fix It\n\nCheck the task's current state and automation eligibility:\n\n```bash\nkspec task get @your-task\n```\n\nLook at the `status` and `automation` fields. If automation is not set to `eligible`, mark it:\n\n```bash\nkspec task set @your-task --automation eligible\n```\n\nCheck whether the task has unmet dependencies:\n\n```bash\nkspec task get @your-task\n```\n\nIf dependencies are listed and not completed, those must be finished first, or you can remove the dependency if it's no longer relevant.\n\nVerify which tasks dispatch considers ready:\n\n```bash\nkspec tasks ready --eligible\n```\n\nIf your task does not appear in this list, the output will help you identify what's blocking it.\n\nCheck that dispatch is running and has agents configured:\n\n```bash\nkspec agent dispatch status\nkspec agent list\n```\n\nRead `globalAuthority`, `heldTasks`, and `taskControls` from JSON status when the task is ready but not starting:\n\n```bash\nkspec agent dispatch status --json\n```\n\nIf lifecycle status holds the task, use the valid action shown by status. Follow [Dispatch Lifecycle Status Rejects an Action or Shows Cleanup](./dispatch-lifecycle-control-failures.md) rather than changing task readiness or control state by hand.\n\nIf no agents are defined, run setup to create the defaults:\n\n```bash\nkspec setup\n```\n\n## Verification\n\nAfter addressing the issue, confirm the task is now eligible:\n\n```bash\nkspec tasks ready --eligible\n```\n\nA healthy outcome shows your task in the ready list. If dispatch is running, it should pick up the task on its next cycle. You can watch the assignment happen:\n\n```bash\nkspec agent dispatch watch\n```\n\nThe task should appear in the dispatch output as assigned to a matching agent.\n",path:"troubleshooting/dispatch-refuses-to-assign.md"},{slug:"troubleshooting/dispatch-workspace-sync-and-cleanup",title:"A Dispatch Workspace Cannot Sync or Clean Up",content:`# A Dispatch Workspace Cannot Sync or Clean Up

Workspace status can show a target, synchronization, registry, or cleanup problem while the task and its evidence remain intact. Identify the exact workspace symptom before changing configuration or retrying normal reconciliation.

## The Workspace Target Does Not Match Configuration

### What this means

The workspace was provisioned for a different integration target than the one you expected. A plan target takes precedence over project \`dispatch.base_branch\`, and an existing workspace retains its resolved target.

### What to observe

Use \`kspec task get @task-ref\`, \`kspec plan get @plan-ref\`, and \`kspec agent dispatch status --json\` to compare task, plan, and degraded-target evidence with the configured base branch.

### Recovery procedure

Correct the authoritative plan target or project dispatch configuration for future provisioning. Do not retarget the existing managed worktree or branch by hand; complete or close it through its recorded integration path, then let dispatch provision subsequent work from the corrected target.

### Healthy outcome

New workspace records name the intended integration target, while existing work retains a coherent, auditable publication path.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for target identity and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for precedence.

## A Plan Target Changed After the Workspace Was Created

### What this means

The plan now points somewhere else, but an already provisioned workspace remains bound to the target recorded at creation. Dispatch does not silently rebase or rewrite that workspace.

### What to observe

Compare \`kspec plan get @plan-ref\` with \`kspec task get @task-ref\` and the task's dispatch context. Check \`git status --short\` before deciding how the existing branch should finish.

### Recovery procedure

Keep the current workspace on its recorded target and use its supported review/publication path. Apply the corrected plan target to workspaces created afterward. If the old target is no longer valid, escalate for an explicit integration decision instead of moving refs inside the managed workspace.

### Healthy outcome

No existing branch is rewritten implicitly, and later plan tasks resolve to the new target at provisioning time.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for source-bound targets and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for plan-scoped dispatch.

## The Workspace Path Collides With Existing Content

### What this means

The configured worktree root or derived task path is already occupied by content dispatch cannot prove it owns. Provisioning stops to avoid overwriting an operator checkout or unrelated files.

### What to observe

Inspect the reported path with read-only filesystem checks and \`git status --short\` when it is a repository. Use \`kspec task get @task-ref\` to confirm the canonical task that requested the path.

### Recovery procedure

Choose a non-colliding \`dispatch.worktree_root\` for future work, or move the unrelated content through its owner's normal process. If the entry may be dispatch evidence, leave it in place and allow registry reconciliation to identify it. Provisioning failure blocks the requesting task, so after the collision is safely corrected, run \`kspec task unblock @task-ref\` to restore its prior status and make it selectable again.

### Healthy outcome

Dispatch provisions the canonical workspace under an empty dispatcher-owned path and unrelated content is unchanged.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for isolation and operator ownership and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for root resolution.

## The Workspace Registry Is Stale or Cannot Be Recovered

### What this means

The durable registry record disagrees with the worktree, branch, or metadata on disk, or the registry cannot be parsed safely. Dispatch preserves ambiguous artifacts instead of rebuilding authority from guesses.

### What to observe

Read the registry health issue exposed by dispatch and use \`kspec agent status\` plus \`kspec task get @task-ref\` to identify affected tasks. Inspect branches and paths only with read-only Git and filesystem commands.

### Recovery procedure

Restart or retry normal dispatch reconciliation after restoring access to the source repository. If the same stale or invalid classification remains, escalate with the task ref, branch, path, and sanitized health issue. Do not edit the dispatch workspace registry.

### Healthy outcome

Reconciliation restores a healthy record or leaves a specific protected/blocked state with actionable evidence; it never discards an ambiguous workspace silently.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for registry authority and cleanup ownership.

## Dispatch Is Running in Local-Only Mode

### What this means

The repository has no configured Git remote. This is supported: remote synchronization is \`local-only with no degraded state or warnings\`, while local dispatch and manual local integration continue.

### What to observe

Use \`git remote\` to confirm there is no remote and \`kspec agent dispatch status --json\` to confirm no degraded target was created solely for that condition.

### Recovery procedure

Do nothing when local-only operation is intended. If remote durability is required, configure and verify the repository remote through normal Git administration, then allow the next dispatch startup or sync interval to discover it.

### Healthy outcome

Local-only dispatch remains healthy without sync warnings, or configured remote synchronization begins without changing workspace identity.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for current remote limits and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for \`remote_sync\`.

## Remote Synchronization Fails Transiently

### What this means

A network, DNS, authentication transport, or temporary remote failure prevented one sync attempt. Transient failures are warnings and retries; they do not by themselves put the target into degraded divergence state.

### What to observe

Read the target-specific warning and failure count, verify connectivity with ordinary read-only Git remote checks, and inspect \`kspec agent dispatch status --json\` for actual \`degradedTargets\`.

### Recovery procedure

Restore connectivity or credentials and wait for the next configured sync interval. Keep dispatch running; repeated transient failures are escalated in logs but remain retryable without manual registry changes.

### Healthy outcome

A later sync succeeds, the target freshness timestamp advances, and healthy targets continue independently throughout.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for synchronization boundaries and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for sync timing.

## An Integration Target Is Degraded by Divergence

### What this means

The local and remote histories cannot be advanced by fast-forward. Dispatch stops provisioning only for that target and reports whether local merges are unpushed or remote history was rewritten.

### What to observe

Run \`kspec agent dispatch status --json\` and record the degraded target's branch, reason, timestamp, and kind. Use \`git status --short\` and normal read-only Git history inspection in the checkout that owns the target.

### Recovery procedure

Reconcile local and remote history through the repository's normal reviewed Git workflow. Do not force-push from a managed task or reviewer workspace. After the branch has one safe history, let the next target-specific sync reevaluate it.

### Healthy outcome

The sync succeeds or is a no-op, that target leaves \`degradedTargets\`, and queued tasks for it become eligible while other targets were never blocked.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for target safety and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for fast-forward-only sync.

## The Integration Target Is Checked Out Elsewhere

### What this means

Dispatch found an occupied checkout. One clean, non-auxiliary checkout can be a safe mutation surface; dirty, staged, ambiguous, auxiliary, in-progress, or overwrite-hazard checkouts are refused.

### What to observe

Use \`git worktree list\` and \`git status --short\` in the named checkout. Confirm \`occupied-checkout\` in \`kspec agent dispatch status --json\` rather than assuming divergence.

### Recovery procedure

Finish or abort the checkout's own Git operation and make its tracked state clean through the owner's normal workflow. Move any conflicting untracked content safely. Then wait for or trigger the same normal sync path; do not delete the checkout to silence the status.

### Healthy outcome

Dispatch uses the single clean eligible checkout, or another safe branch-coherent surface, and clears the target degradation after sync succeeds.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for operator ownership and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for target synchronization.

## Reviewer Target Synchronization Is Deferred

### What this means

The periodic sync reached a target while a reviewer invocation for that target was active. Only that target is deferred to the next interval so the reviewer keeps a stable comparison surface.

### What to observe

Use \`kspec agent status\` to confirm the active reviewer and \`kspec agent dispatch status --json\` to confirm that unrelated targets remain healthy.

### Recovery procedure

Allow the reviewer invocation to finish. Do not cancel review or mutate its target merely to force a periodic refresh; the next interval retries that target automatically.

### Healthy outcome

The reviewer completes against its stable snapshot, the next sync evaluates the target, and other active targets continued syncing.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for detached review and [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md) for reviewer deferral.

## Cleanup Says an Artifact Is Protected

### What this means

The branch, worktree, snapshot, or registry record belongs to active, queued-to-start, paused-held, in-flight, or stopped-with-pending-cleanup work. Protection is evidence preservation, not a request for manual deletion.

### What to observe

Use \`kspec agent status\`, \`kspec agent dispatch status --json\`, and \`kspec task get @task-ref\` to match the protection reason to lifecycle and task state.

### Recovery procedure

Let the owning invocation, review, lifecycle cleanup, or task integration reach its normal durable outcome. Retry only the matching lifecycle cleanup when status offers it. Do not delete or move a managed worktree.

### Healthy outcome

The artifact remains while protected, then normal reconciliation schedules cleanup only after ownership and integration state prove it safe.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for evidence and cleanup ownership and [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md) for matching cleanup scope.

## The Worktree Root Contains an Unknown Entry

### What this means

Dispatch found a directory without enough metadata to prove it is a managed workspace. Unknown entries are preserved when any branch, path, task, or lifecycle protection source could own them.

### What to observe

Compare \`git worktree list\`, \`kspec task get @task-ref\`, and the preservation diagnostic. Do not infer ownership from a directory name alone.

### Recovery procedure

Allow reconciliation to match the entry with registry and Git evidence. If it stays unknown, escalate with the exact diagnostic and read-only inventory; the owner can then move unrelated content through a controlled, recoverable process.

### Healthy outcome

The entry is either recognized and managed, preserved with a concrete protection reason, or confirmed unrelated without destroying dispatch evidence.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for canonical identity and ambiguous-artifact protection.

## A Closed Workspace Is Still Retained

### What this means

Closed registry records are retained for a bounded period, and cleanup can remain blocked by branch, review, lifecycle, or evidence conditions. A terminal task alone is not proof that every artifact is disposable.

### What to observe

Use \`kspec task get @task-ref\` to confirm terminal state and \`kspec agent status\` to check active or pending ownership. Read the cleanup status and retention timestamp rather than inspecting directory age alone.

### Recovery procedure

Wait for normal retention and reconciliation when all cleanup conditions are satisfied. Resolve the named review, integration, or lifecycle condition through its owning workflow. Do not edit the dispatch workspace registry or remove the directory manually.

### Healthy outcome

Recent closed evidence remains available, then eligible records and artifacts are purged by dispatcher-owned cleanup without affecting active work.

### Learn more

See [Dispatch Workspaces](../concepts/dispatch-workspaces.md) for retention and integration evidence.
`,path:"troubleshooting/dispatch-workspace-sync-and-cleanup.md"},{slug:"troubleshooting/entity-storage-incompatible",title:"`entity_storage_incompatible`: Project Storage Format Mismatch",content:'# `entity_storage_incompatible`: Project Storage Format Mismatch\n\nYou run a plan, review, or resource command — for example `kspec plan resource add`, `kspec review get`, or any daemon route under `/api/plans/:ref/resources` — and the operation fails with an `entity_storage_incompatible` error. The CLI prints a code like `legacy_plan_storage_removed` or `missing_review_folder_storage`; the daemon returns an HTTP 409 with a body containing `"error": "entity_storage_incompatible"`.\n\n## What This Means\n\nStarting with `kynetic: "1.2"`, plans and reviews are stored as folder-backed entities and supporting files live in entity-scoped local resources. Commands and daemon routes that need this format check the project manifest and on-disk layout before reading or writing. When the project is not on folder-backed storage, the operation stops with a deterministic, recoverable error instead of guessing how to interpret an ambiguous layout.\n\nThe top-level `entity_storage_incompatible` discriminator is shared across plan, review, and resource domains. The `code` field tells you exactly which boundary failed:\n\n| Code                            | Meaning                                                                                                                                                    |\n| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |\n| `legacy_plan_storage_removed`   | Project manifest is below `kynetic: "1.2"` and stores plans in the legacy `.kspec/project.plans.yaml` monolithic file.                                     |\n| `legacy_review_storage_removed` | Project manifest is below `kynetic: "1.2"` and stores reviews in the legacy `.kspec/project.reviews.yaml` monolithic file.                                 |\n| `missing_plan_folder_storage`   | Manifest is `1.2`+ but `plan_storage.format` is not `folder`.                                                                                              |\n| `missing_review_folder_storage` | Manifest is `1.2`+ but `review_storage.format` is not `folder`.                                                                                            |\n| `partial_entity_storage_layout` | Manifest declares folder-backed storage but the on-disk layout is partial — for example, monolithic records still exist beside the declared folder layout. |\n\nThe daemon response body includes the same fields plus a `suggestion` ("Run `kspec upgrade` to migrate the project, or use a kspec version compatible with the current manifest if upgrade is not desired"), a `domain` (`plans`, `reviews`, or `resources`), and a `cache_domain` (the cache key that was attempted), so client code can surface targeted recovery guidance.\n\nThis does not mean your data is corrupted. The error is the gate that prevents kspec from silently reading or rewriting ambiguous storage. Your plans, reviews, and resources are intact in their existing format.\n\n## How to Fix It\n\n### Migrate the project to `kynetic: "1.2"`\n\nIf you are ready to move to folder-backed storage, run the upgrade:\n\n```bash\nkspec upgrade --dry-run\n```\n\nThe dry run reports every step — including the manifest fields that will be set, the directories that will be created, and the previous shadow commit you can use as a rollback ref — without writing anything. Review the output, then apply:\n\n```bash\nkspec upgrade\n```\n\nAfter a successful upgrade, the failing command should work. See [Upgrading kspec to a New Version](../guides/upgrading-kspec.md) for the full upgrade flow, including rollback instructions.\n\n### Stay on a compatible kspec version\n\nIf you are not ready to migrate — for example, you depend on another tool that reads the monolithic `.kspec/project.plans.yaml` file directly — pin to a kspec version that does not require folder-backed plan, review, or resource storage. Check your installed version with `kspec --version` and consult the [release notes](../release-notes/index.md) for the version that introduced the gate; install the prior major or minor as a stopgap until you can plan the migration.\n\n### Fix a `partial_entity_storage_layout`\n\n`partial_entity_storage_layout` means the manifest declares folder-backed storage but the on-disk layout disagrees. This usually happens when an upgrade was interrupted mid-migration, when a partial restore from a backup re-introduced monolithic files alongside the new folders, or when someone manually edited `.kspec/` state.\n\n1. Run `kspec shadow status` to confirm the worktree itself is healthy. If it is broken, fix that first with [Shadow Branch Worktree Is Broken or Missing](./shadow-branch-worktree-broken.md).\n2. From the project root, inspect the layout:\n\n   ```bash\n   ls .kspec/project.plans.yaml .kspec/project.reviews.yaml 2>/dev/null\n   ls -d .kspec/plans .kspec/reviews 2>/dev/null\n   ```\n\n3. If both monolithic files and folder directories exist, the safe recovery is to roll back to the pre-upgrade commit, then re-run `kspec upgrade`. Find the previous shadow commit in your last upgrade output (or in the shadow branch git log), then:\n\n   ```bash\n   cd .kspec\n   git reset --hard <previous-shadow-commit>\n   cd ..\n   kspec upgrade\n   ```\n\n4. If no clean rollback ref is available, contact your team\'s kspec owner before manually deleting files in `.kspec/`. The shadow branch\'s git history is the authoritative record — manual cleanup that bypasses it can lose data.\n\n## Verification\n\nAfter running `kspec upgrade`, confirm the manifest and folder layout match:\n\n```bash\nkspec --version\nkspec doctor\n```\n\nRe-run the command that originally failed. The error should be gone.\n\nIf the error persists after a successful upgrade, run the original command with verbose output to capture the exact `code` and `domain` reported, and check that your project root really is the directory you expect — every kspec command must run from the project root, never from inside `.kspec/`.\n',path:"troubleshooting/entity-storage-incompatible.md"},{slug:"troubleshooting/plan-or-review-index-drift",title:"Plan or Review Index Has Drifted From Folder Contents",content:`# Plan or Review Index Has Drifted From Folder Contents

You read a plan or review through the CLI, web UI, or daemon API and notice that the listing disagrees with what is on disk: a plan you remember creating is missing from \`kspec plan list\`, a review you deleted still shows up in \`kspec review list\`, or an attached resource is not appearing in \`kspec plan resource list\`. A \`kspec plan rebuild-index\` or \`kspec review rebuild-index\` command reports drift, missing folders, or stale entries.

## What This Means

After the upgrade to \`kynetic: "1.2"\`, the project-wide files \`.kspec/project.plans.yaml\` and \`.kspec/project.reviews.yaml\` are **lean indexes** — they store identity, lifecycle, summary fields, and bounded resource summaries, but they no longer hold the full plan markdown, review record, or resource bytes. The authoritative source for each plan is \`.kspec/plans/<plan-ulid>/plan.md\` and \`plan.yaml\`; for each review it is \`.kspec/reviews/<review-ulid>/review.yaml\`. The index is a derived projection of those folders.

Drift happens when the index disagrees with the folders. Common causes:

- A manual edit to \`.kspec/project.plans.yaml\` or \`.kspec/project.reviews.yaml\` outside the CLI
- A partial restore from backup that brought back an index without the matching folders, or vice versa
- A merge conflict on the shadow branch that was resolved by choosing one side without re-deriving the index
- An interrupted upgrade or an interrupted folder-storage migration

Drift is not data loss. The entity directories are authoritative. The index can always be rebuilt from them.

## How to Fix It

### 1. Check for drift

From the project root, run the rebuild-index command for whichever domain is drifting. Without flags, it validates and exits non-zero if drift exists, without writing anything:

\`\`\`bash
kspec plan rebuild-index
kspec review rebuild-index
\`\`\`

A clean project exits 0 with a "clean" summary. A drifted project exits 1 and reports what is different (folders without index entries, index entries without folders, or entries whose summary fields disagree with the folder contents).

For a richer preview without exit-code drama, pass \`--dry-run\`:

\`\`\`bash
kspec plan rebuild-index --dry-run
kspec review rebuild-index --dry-run
\`\`\`

### 2. Repair additive drift

When the drift is additive — folders exist but the index does not list them, or summary fields are stale — apply the rebuild:

\`\`\`bash
kspec plan rebuild-index --repair
kspec review rebuild-index --repair
\`\`\`

\`--repair\` rewrites \`.kspec/project.plans.yaml\` or \`.kspec/project.reviews.yaml\` from the on-disk folders. This is the safe direction because folders are authoritative.

### 3. Drop stale index entries

If the index lists entries whose folders are missing (for example, a folder was manually deleted), \`--repair\` alone treats those as conflicts and refuses to drop them. Pass \`--force\` once you have confirmed the folder deletion was intentional:

\`\`\`bash
kspec plan rebuild-index --repair --force
kspec review rebuild-index --repair --force
\`\`\`

\`--force\` is only valid with \`--repair\`. It permits dropping index entries whose entity folders are missing. Without \`--force\`, missing folders are treated as conflicts and no files are written.

### Exit Code Summary

| Exit code | Meaning                                                      |
| --------- | ------------------------------------------------------------ |
| 0         | Clean, or successful repair                                  |
| 1         | Drift detected and not repaired                              |
| 2         | Blocked by conflicts (e.g. missing folder without \`--force\`) |

## When Resources Look Wrong

If \`kspec plan resource list\` (or the review equivalent) returns an empty list for an entity you know has resources, or returns a resource whose bytes do not match what you expect:

1. Confirm the resource file actually exists on disk: \`ls .kspec/plans/<plan-ulid>/resources/\` (or the review equivalent).
2. Inspect the manifest: \`cat .kspec/plans/<plan-ulid>/resources.yaml\`.
3. Run rebuild-index for that domain — the resource summary in the project index is derived from each plan's \`resources.yaml\`.

If a resource file exists but is not declared in \`resources.yaml\`, kspec treats it as an unknown file (preserved across writes, but not surfaced as a resource). Re-attach it via the CLI to register it:

\`\`\`bash
kspec plan resource add @plan ./local-copy.png \\
  --id login-shot \\
  --path screenshots/login.png \\
  --replace
\`\`\`

\`--replace\` is required when the path is already present in the manifest (even if you are restoring it after an out-of-band edit).

## When Resource Hashes Drift

If a derived task's \`TaskResourceRef\` reports drift — the task's \`sha256\` no longer matches the plan resource's current \`sha256\` — this is intentional behavior, not a bug. Drift surfaces in task detail, agent context, and the API resource resolver so consumers know the underlying file changed after derivation.

Options for resolving drift:

- **The change is intentional.** Re-derive the task with the updated reference. From a plan with one or more affected tasks, \`kspec plan derive @plan\` records a fresh \`TaskResourceRef\` against the current hash.
- **The change is intentional but the task needs the old bytes.** Re-run derivation with \`--materialize-resources\` for the affected plan; the materialized copy lives under the task's own \`resources/\` tree and is no longer subject to plan-side drift.
- **The change was accidental.** Restore the plan resource from git history. The plan's \`resources/\` files are tracked on the shadow branch like every other piece of project state.

## Verification

After repairing, re-run the validation:

\`\`\`bash
kspec plan rebuild-index
kspec review rebuild-index
\`\`\`

Both should exit 0 with "clean" summaries. Then confirm the affected entities surface correctly:

\`\`\`bash
kspec plan list
kspec review list
\`\`\`

The lists should match what you expect on disk.

## Related

- [\`entity_storage_incompatible\`: project storage format mismatch](./entity-storage-incompatible.md) — when the project is not on folder-backed storage at all
- [Local Resources for Plans and Reviews](../concepts/local-resources.md) — the folder layout and resource model
- [Shadow Branch Worktree Is Broken or Missing](./shadow-branch-worktree-broken.md) — fix the worktree first if rebuild-index commands cannot read \`.kspec/\` at all
`,path:"troubleshooting/plan-or-review-index-drift.md"},{slug:"troubleshooting/review-blocking-merge",title:"A Review Is Blocking Merge With an Unresolved Thread",content:`# A Review Is Blocking Merge With an Unresolved Thread

You try to merge approved work and the merge gate rejects it, citing an unresolved thread in the review record. Alternatively, the review disposition shows "changes requested" even though you believe all feedback has been addressed.

## What This Means

kspec's [review system](../concepts/reviews.md) gates merges on three conditions: the review disposition must be "approved," all required checks must pass, and all blocker threads must be resolved. If any blocker thread remains open — even if a verdict of "approve" has been given — the merge gate will not open.

A thread stays unresolved until it is explicitly marked as resolved. Addressing the feedback in code does not automatically close the thread. The reviewer (or the author, if appropriate) must resolve it through the review interface.

This can also happen when the review's subject version is stale. If the author pushed new commits after the reviewer's verdict, the verdict applies to the old version and may no longer count toward the current disposition.

## How to Fix It

Find the review record for your task:

\`\`\`bash
kspec review for-task @your-task
\`\`\`

Read the full review to identify unresolved threads:

\`\`\`bash
kspec review get @review-ref
\`\`\`

Look for threads with kind "blocker" that are still open. If the feedback is already addressed in the reviewed version and no code change is needed, reply with the evidence and resolve the thread:

\`\`\`bash
kspec review reply @review-ref --thread <thread-id> --body "Fixed: description of what changed"
kspec review resolve @review-ref --thread <thread-id>
\`\`\`

If addressing the feedback requires code changes, or newer commits made the reviewed version stale, the reviewer records a \`request_changes\` verdict. That moves the task from \`pending_review\` to \`needs_work\`. Start the fix cycle, make and commit the changes, then reply to and resolve every addressed thread:

\`\`\`bash
kspec task start @your-task
kspec review reply @review-ref --thread <thread-id> --body "Fixed: description of what changed"
kspec review resolve @review-ref --thread <thread-id>
kspec task submit @your-task
\`\`\`

\`kspec task submit\` is valid after \`kspec task start\` has moved the \`needs_work\` task back to \`in_progress\`. Submission returns it to \`pending_review\`; the reviewer then creates a fresh review record for the new round, preserving the previous review in the history. Do not run \`kspec task submit\` while the task is already in \`pending_review\`.

## Verification

After resolving all threads, check the review disposition:

\`\`\`bash
kspec review get @review-ref
\`\`\`

A healthy outcome shows the disposition as "approved" with no unresolved blocker threads and all required checks passing. The merge gate should now allow the work to proceed.
`,path:"troubleshooting/review-blocking-merge.md"},{slug:"troubleshooting/runner-validation-failures",title:"Runner Validation Failures",content:"# Runner Validation Failures\n\n`kspec agent runners validate` reports failures as structured diagnostics with a stable `reason` code. This page describes each code, the symptoms it produces, and how to fix it. Use it as a lookup keyed by the `reason` value that appears in the validator's output or in the JSON `diagnostics` array.\n\nFor the full configuration walkthrough, see [Configuring Agent Runners](../guides/configuring-agent-runners.md).\n\n## `unknown_runner`\n\n**Symptom.** An agent references a runner name that is not in the effective registry, or `--runner <name>` was passed to the validator with a name that does not exist.\n\n**What it means.** kspec loaded the project and system layers but did not find a runner with the requested name in either one. The reference points at nothing.\n\n**Recovery.**\n\n1. Run `kspec agent runners validate` with no filter to list every runner kspec did find.\n2. Check the spelling in the agent definition (`kspec agent list` shows the `runner` field on each agent).\n3. Confirm both config files exist at the resolved paths — the project layer at `.kspec/project.runners.yaml` and the system layer at `<daemon-config-dir>/projects/<project-key>/runners.yaml`.\n4. Add the missing runner to one of the layers, or update the agent to reference an existing name.\n\n## `invalid_adapter`\n\n**Symptom.** A runner declares an `adapter` value that is not a registered adapter id.\n\n**What it means.** Runners must point at a registered adapter so kspec knows what to spawn. Schema validation rejects unknown adapter ids at load time.\n\n**Recovery.**\n\n1. Read the diagnostic message — when validation rejects an unknown adapter, the message lists the registered adapter ids kspec is aware of.\n2. Edit the runner's `adapter` field in `runners.yaml` to match one of those ids.\n3. If you expected an adapter that is not registered, check that the package providing it is installed and the daemon was restarted after install.\n\n## `missing_adapter_registration`\n\n**Symptom.** A runner refers to an adapter that is registered by name but the registration is missing at validation time.\n\n**What it means.** The adapter id passed the load-time check but is no longer in the runtime registry — typically because a plugin or package that registers it has not been loaded into the current process.\n\n**Recovery.**\n\n1. Confirm the package or plugin that registers the adapter is installed.\n2. Restart the daemon so plugin initialization runs again.\n3. If the adapter is intentionally retired, update the runner to point at a still-registered adapter.\n\n## `unspawnable_command`\n\n**Symptom.** `process.executable` cannot be found, is not executable, or timed out under the validator's quick spawn probe. The diagnostic's details block carries an `unspawnable_reason` (`not_found`, `not_executable`, `timeout`).\n\n**What it means.** The command kspec would spawn for this runner cannot actually be launched. Validation catches this before any agent runs so the failure surfaces in the operator surface rather than inside an invocation.\n\n**Recovery.**\n\n1. Inspect the path in the diagnostic message.\n2. Confirm the file exists, is a regular file, and has the executable bit set for the user that will run the daemon.\n3. If the path was relative, make it absolute or resolve it against the daemon's working directory.\n4. If the runner does not need an executable override, remove `process.executable` so the adapter's registered command is used (`command_source` becomes `adapter`).\n\n## `invalid_cwd`\n\n**Symptom.** `process.cwd` does not exist, is not a directory, or is not accessible. The details block carries a more specific `invalid_cwd_reason` (`not_found`, `not_directory`, `not_accessible`).\n\n**What it means.** The validator checked the directory before spawn and could not confirm it is usable as a child-process working directory.\n\n**Recovery.**\n\n1. Create the directory or fix its permissions.\n2. If the path is incorrect, edit the runner's `process.cwd` field. Relative values are resolved against the directory containing this system `runners.yaml` file — not against the daemon or CLI parent process cwd — so the diagnostic message reports the fully resolved path.\n3. If you do not need a cwd override, remove the field — the invocation cwd will be used (`cwd_source` becomes `invocation`).\n\n## `invalid_args`\n\n**Symptom.** `process.args` contains a value that looks like a secret: a `Bearer <token>` string, a `--api-key=…` argument, the value that follows a credential-named flag, or any pattern the secret-shape detector matches.\n\n**What it means.** Credentials must come through `env.secrets` bindings — they are never accepted in process args because args are visible in process listings and ACP diagnostics.\n\n**Recovery.**\n\n1. Identify the flagged arg index from the diagnostic message.\n2. Remove the credential from `process.args`.\n3. Bind the credential under `env.secrets` in the system layer (e.g., `MY_TOKEN: { source: user_env, required: true }`).\n4. Configure the adapter or executable to read the credential from the env var instead of an argument.\n\n## `missing_secret`\n\n**Symptom.** A `required: true` `env.secrets` binding could not be resolved from its source when an invocation prepared.\n\n**What it means.** The runner declared the credential as required but the source (e.g., `user_env`) does not contain a value for it. The invocation is blocked before adapter spawn so no prompt content reaches the child process.\n\n**Recovery.**\n\n1. Set the missing variable in the credential source (for `user_env`, that is the user's process environment).\n2. If the credential is genuinely optional, change `required: true` to `required: false` (or omit it — `false` is the default).\n3. If the binding is no longer needed, remove the `env.secrets` entry.\n\n## `invalid_command_reference`\n\n**Symptom.** The validator could not resolve `process.executable` to a command reference at all — typically because the value is empty, malformed, or fails earlier than the spawn probe.\n\n**What it means.** The configured executable shape is wrong before kspec even tries to launch it.\n\n**Recovery.**\n\n1. Confirm the value is a non-empty string in `runners.yaml`.\n2. Replace any shell-style expressions (`~/bin/foo`, `$HOME/foo`) with absolute paths — runner config does not expand shell syntax.\n3. If the field was meant to be omitted, delete it entirely so the adapter's registered command is used.\n\n## `preflight_failure`\n\n**Symptom.** A generic preflight error during validation. Common variants include YAML parse errors in either layer file, schema-level rejections (such as a project-layer file that declares `env.secrets`), or unexpected I/O errors when reading the config.\n\n**What it means.** Validation could not get far enough to evaluate individual runner fields because the config layer itself is unhealthy.\n\n**Recovery.**\n\n1. Read the diagnostic `message` and `details` — they name the file path and the specific failure.\n2. For YAML parse errors, open the file in an editor and fix the syntax.\n3. For schema rejections, check the field listed in the message against the rules in [Configuring Agent Runners](../guides/configuring-agent-runners.md):\n   - `env.secrets` is system-only.\n   - `env.set` rejects secret-looking keys and known credential variable names.\n   - `process.args` rejects secret-shaped values.\n   - `kind` must be a supported value (currently `acp_process`).\n   - `adapter` must reference a registered adapter id.\n4. Re-run `kspec agent runners validate` to confirm the file loads cleanly.\n\n## Report-Level Issues\n\nSome failures are not scoped to a single runner and appear in the top-level `issues` array in the JSON payload (or under \"Configuration issues\" in human-readable output). Common cases:\n\n- **Layer YAML parse errors** — surfaced as `preflight_failure` issues with the offending file path.\n- **Unknown runner filter** — passing `--runner <name>` with a name that does not exist surfaces as `unknown_runner` at the report level.\n- **Schema validation of either layer** — fields rejected by the project- or system-layer schema produce report-level issues with the field path the schema flagged.\n\nA report with any report-level issue exits non-zero even if every individual runner that did load is valid. Fix report-level issues first; per-runner diagnostics may resolve on their own once the layer files load cleanly.\n",path:"troubleshooting/runner-validation-failures.md"},{slug:"troubleshooting/shadow-branch-out-of-sync",title:"Shadow Branch Is Out of Sync With Remote",content:`# Shadow Branch Is Out of Sync With Remote

You run \`kspec shadow status\` and see a message that your local shadow branch is behind or ahead of the remote, or you notice that spec and task changes made by a teammate are not showing up locally.

## What This Means

The [shadow branch](../concepts/the-shadow-branch.md) is an independent git branch that tracks spec state separately from your code branches. Like any git branch, it can fall out of sync when multiple contributors are making changes. The local copy on your machine may have commits that the remote does not, or the remote may have commits that you have not pulled yet.

This is normal when teams share spec state. It's the same situation as a code branch being behind \`origin\` — it just needs syncing.

## How to Fix It

Run the sync command from your project root:

\`\`\`bash
kspec shadow sync
\`\`\`

This pushes your local shadow branch commits to the remote and pulls any remote commits that you don't have locally. If both sides have diverged, kspec will attempt to merge them.

If the sync reports a conflict, run:

\`\`\`bash
kspec shadow resolve
\`\`\`

This opens the conflict resolution flow. Most shadow branch conflicts are in YAML files and resolve cleanly once you choose which version of a changed field to keep.

## Verification

After syncing, confirm that the branch is healthy:

\`\`\`bash
kspec shadow status
\`\`\`

A healthy outcome shows the local and remote branches at the same commit with no pending changes. You should see your teammate's specs and tasks when you run \`kspec item list\` or \`kspec task list\`.
`,path:"troubleshooting/shadow-branch-out-of-sync.md"},{slug:"troubleshooting/shadow-branch-worktree-broken",title:"Shadow Branch Worktree Is Broken or Missing",content:`# Shadow Branch Worktree Is Broken or Missing

You run a kspec command and see an error that \`.kspec/\` does not exist, that the worktree is disconnected, or that kspec cannot read its state directory. Alternatively, you notice that the \`.kspec/\` directory is empty or missing entirely.

## What This Means

kspec stores all of its state in a git worktree checked out into \`.kspec/\` at your project root. This worktree points at the [shadow branch](../concepts/the-shadow-branch.md) (an orphan branch called \`kspec-meta\`). The worktree linkage can break if:

- The repository was cloned or moved in a way that didn't preserve git worktree metadata.
- An aggressive \`git clean\` or manual deletion removed the \`.kspec/\` directory or its internal \`.git\` file.
- A git upgrade or filesystem operation corrupted the worktree link files inside \`.git/worktrees/\`.

When the linkage breaks, kspec cannot find or read its YAML state files, so every command fails.

## How to Fix It

First, check what state the shadow branch infrastructure is in:

\`\`\`bash
kspec shadow status
\`\`\`

If the status reports a broken or missing worktree, run the repair command:

\`\`\`bash
kspec shadow repair
\`\`\`

This recreates the worktree linkage from the existing shadow branch. Your spec and task data lives on the \`kspec-meta\` branch in the git history — it is not lost when the worktree breaks. The repair command reconnects the \`.kspec/\` directory to that branch.

If the shadow branch itself does not exist locally but exists on the remote (common after a fresh clone), run:

\`\`\`bash
kspec init
\`\`\`

This detects the remote shadow branch and sets up the local worktree from it.

## Verification

After repairing, confirm that the worktree is healthy:

\`\`\`bash
kspec shadow status
\`\`\`

A healthy outcome shows the worktree connected and the shadow branch checked out. You should be able to run \`kspec item list\` and see your specs and tasks.
`,path:"troubleshooting/shadow-branch-worktree-broken.md"},{slug:"troubleshooting/upgrade-pre-plan-state",title:"Upgrade Reports a Pre-Plan State or Partial Scaffold",content:`# Upgrade Reports a Pre-Plan State or Partial Scaffold

You run \`kspec init\` or \`kspec setup\` after upgrading kspec and see a message about pre-plan state, a partial scaffold, or missing configuration that should have been created during initialization.

## What This Means

kspec evolves across versions. Newer versions may expect configuration files, metadata fields, or directory structures that didn't exist in the version you originally initialized with. When kspec detects that your project's [shadow branch](../concepts/the-shadow-branch.md) state predates certain features, it reports the gap.

A "pre-plan state" message means your project was initialized before the plans feature was added. A "partial scaffold" message means some expected configuration files are present but others are missing — typically because an earlier initialization was interrupted or an upgrade introduced new required files.

This does not mean your existing data is corrupted. Your specs, tasks, and other state are intact. The system just needs the newer scaffolding to be applied.

## How to Fix It

Run the upgrade command, which brings your project from any previously-supported version up to the currently installed version:

\`\`\`bash
kspec upgrade
\`\`\`

This command runs a multi-step pipeline that migrates legacy task storage, backfills missing configuration files, re-renders skills and agent instructions, and records the new version. It is idempotent — running it again when already current is a no-op.

Preview what will change before applying:

\`\`\`bash
kspec upgrade --dry-run
\`\`\`

If \`kspec upgrade\` reports that the shadow branch itself needs initialization (for instance, when a project predates shadow branch support):

\`\`\`bash
kspec init
kspec upgrade
\`\`\`

Running \`kspec init\` on an already-initialized project detects the existing shadow branch and preserves it. It only creates what's missing. The subsequent \`kspec upgrade\` then applies any remaining version-specific migrations.

For cases where only specific scaffolding files are missing and you want to skip the full migration pipeline, \`kspec setup --force\` is a lower-level fallback that re-scaffolds project configuration, skills, and agent instructions without running task-storage migrations or recording a version baseline.

## Verification

After running the upgrade, confirm everything is in order:

\`\`\`bash
kspec shadow status
kspec session start
\`\`\`

A healthy outcome shows the shadow branch connected and healthy, and the session start command displays your project context without warnings about missing scaffolding. If the upgrade introduced new features (like plans or agent definitions), you should see them listed in the session output.
`,path:"troubleshooting/upgrade-pre-plan-state.md"},{slug:"release-notes/changelog",title:"kspec Release Notes",content:`# kspec Release Notes

Release notes for \`@kynetic-ai/spec\` (kspec). Each section below describes a
published version. The most recent version appears first. See the release
skill for the authoring conventions enforced by the CLI.

## Unreleased

Human-authored summary of changes staged for the next release. Promote this
block to a versioned section (with the chosen version number) as part of the
release workflow before tagging.

### New or changed configuration

- **\`kynetic: "1.2"\` storage format.** Project manifests now declare
  \`kynetic: "1.2"\`, \`task_storage.format: split\`, \`plan_storage.format: folder\`,
  \`review_storage.format: folder\`, and \`resource_storage.format: entity_scoped\`.
  \`kspec init\` writes these fields on new projects; \`kspec upgrade\` migrates
  existing projects.

### Breaking changes

- **Folder-backed plan and review storage.** Plans now live in
  \`.kspec/plans/<plan-ulid>/\` directories with \`plan.md\`, \`plan.yaml\`, optional
  \`notes.yaml\`, \`resources.yaml\`, and \`resources/\`. Reviews live in
  \`.kspec/reviews/<review-ulid>/\` directories with cohesive \`review.yaml\`,
  \`resources.yaml\`, and \`resources/\`. The project-wide
  \`.kspec/project.plans.yaml\` and \`.kspec/project.reviews.yaml\` files remain as
  lean indexes (identity, lifecycle, summary fields, resource summaries) but no
  longer inline plan markdown, review records, or resource bytes. Existing
  projects must run \`kspec upgrade\` to migrate; commands and daemon routes that
  need folder-backed plan, review, or resource data on an unmigrated project
  fail with \`entity_storage_incompatible\`. See
  [Upgrading kspec to a New Version](docs/guides/upgrading-kspec.md) and
  [\`entity_storage_incompatible\` troubleshooting](docs/troubleshooting/entity-storage-incompatible.md).

### Features & Additions

- **Entity-scoped local resources.** Plans and reviews can own local files —
  screenshots, PDFs, evidence logs — declared in a per-entity \`resources.yaml\`
  with the fixed \`ResourceMetadata\` shape (\`id\`, \`label\`, \`path\`,
  \`content_type\`, \`bytes\`, \`sha256\`, \`git_commit\`, \`git_path\`, \`description\`).
  Authoring references use the \`./resources/<relative-path>\` form. Resource ids
  match \`[a-z0-9][a-z0-9._-]{0,127}\`; paths must be POSIX-relative under the
  entity's \`resources/\` directory.
- **Plan resource CLI** — \`kspec plan resource add/list/get/remove\` attach,
  inspect, and remove plan-owned local resources. \`add\` requires \`--id\` and
  \`--path\`; replacement is opt-in via \`--replace\`. \`remove\` requires \`--force\`
  in non-interactive contexts.
- **Review resource CLI** — \`kspec review resource add/list/get/remove\` mirror
  the plan resource commands for review-owned evidence files.
- **Plan import with resources** — \`kspec plan import\` copies declared
  resources from a sibling \`resources.yaml\` and \`resources/\` directory into the
  plan's folder, and validates that \`./resources/<rel>\` markdown links resolve.
  \`kspec plan set --content-file\` enforces the same resolution against the
  existing plan's manifest.
- **Plan derive resource references** — derived tasks receive versioned
  \`TaskResourceRef\` entries pointing back at plan-owned resources by default,
  carrying the content hash and git commit captured at derivation time. Use
  \`kspec plan derive --materialize-resources\` to copy plan resource bytes into
  each derived task's \`.kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/\`
  tree with the id \`plan-<resource-id>\`.
- **Daemon resource API** — \`GET/POST/DELETE /api/plans/:ref/resources[/:id[/bytes]]\`
  and \`GET/POST/DELETE /api/reviews/:ref/resources[/:id[/bytes]]\` serve
  resource metadata and bytes. \`POST\` accepts \`multipart/form-data\` with
  \`file\`, \`id\`, \`path\`, optional \`label\`/\`description\`/\`content_type\`, and an
  optional \`replace\` field accepting \`"true"\`/\`"1"\` or \`"false"\`/\`"0"\`. The
  \`/bytes\` route sets \`Content-Type\`, \`Content-Length\`, and the resource's
  \`sha256\` via an \`X-Kspec-Resource-Sha256\` response header.
- **Static export resource layout** — exported plans, tasks, and reviews copy
  resource files to \`assets/resources/plan/<plan-ulid>/<relative-path>\`,
  \`assets/resources/task/<task-ulid>/<relative-path>\`, and
  \`assets/resources/review/<review-ulid>/<relative-path>\`. Plan and task
  markdown links are rewritten to point at the exported asset path so the
  offline UI works without the daemon. Only \`present\` task resources are copied;
  drifted, missing, or unresolved task references are not exported as bytes.
- **Live UI and task-markdown resource resolution.** Task descriptions can
  reference resources with \`./resources/<relative-path>\`, resolved through a
  task-scoped projection on the daemon task detail API. The response exposes
  \`resolved_resources\` (with \`owner_type\`, \`owner_ref\`, \`id\`, \`path\`,
  \`content_type\`, \`byte_size\`, \`status\`, recorded/current \`sha256\` and
  \`git_commit\`, and a human-readable \`message\`) plus a \`resources_base_url\`, and
  task-scoped bytes routes (\`GET /api/tasks/:ref/resources[/:id[/bytes]]\`) serve
  both plan-owned references and \`--materialize-resources\` task-owned copies. The
  task detail UI rewrites those references to task-scoped resource URLs for both
  cases. Task resources are derived from plans — there is no task resource upload
  command. (Plan-only \`kspec plan resource add\` and review-only
  \`kspec review resource add\` remain the only resource upload surfaces.)
- **Resource drift is surfaced, never silently substituted.** Drifted, missing,
  or unresolved task resource references resolve to a \`status\`
  (\`drift\`/\`missing\`/\`unresolved\`) and \`message\` instead of replacement bytes.
  The bytes routes refuse to stream bytes that differ from the hash recorded at
  task derivation, the live UI shows the status message rather than rewriting the
  target, and an authoring reference that matches no resolved resource stays
  visible as raw text with actionable guidance.
- **Browser resource URLs preserve selected-project context.** In live
  multi-project mode, rendered \`<img>\` and \`<a>\` resource URLs carry the selected
  project as a URL-level \`kspec_dir\` query parameter because element fetches
  cannot send the \`X-Kspec-Dir\` header. The daemon project-context middleware
  reads the header when present and otherwise the query parameter, so plan,
  task, and review resource elements resolve to the selected project's bytes
  while still rejecting undeclared, absolute, traversal, and symlink-escape
  paths.
- **Plan and review index rebuild** — \`kspec plan rebuild-index\` and
  \`kspec review rebuild-index\` validate or repair the project-wide index
  against the on-disk entity folders. \`--dry-run\` previews drift; \`--repair\`
  rewrites the index from folders; \`--repair --force\` drops stale index
  entries whose folders are missing. Exit codes are 0 (clean/repaired), 1
  (drift detected), 2 (blocked by conflicts).
- **\`entity_storage_incompatible\` daemon responses** — plan, review, and
  resource routes return HTTP 409 with a structured envelope (top-level
  \`entity_storage_incompatible\` discriminator plus domain-specific codes:
  \`legacy_plan_storage_removed\`, \`legacy_review_storage_removed\`,
  \`missing_plan_folder_storage\`, \`missing_review_folder_storage\`,
  \`partial_entity_storage_layout\`) when the project is not on folder-backed
  storage. The response body includes a \`suggestion\`, \`domain\`, and
  \`cache_domain\` so clients can surface targeted recovery guidance.
- **Upgrade rollback reference** — \`kspec upgrade\` and \`kspec upgrade --dry-run\`
  now report the previous shadow commit (short SHA captured before any
  mutation) so operators have a deterministic rollback point.

### Documentation

- New concept page: [Local Resources for Plans and Reviews](docs/concepts/local-resources.md).
- New guide: [Working With Local Resources](docs/guides/working-with-local-resources.md).
- New troubleshooting pages: [\`entity_storage_incompatible\`](docs/troubleshooting/entity-storage-incompatible.md)
  and [Plan or Review Index Has Drifted](docs/troubleshooting/plan-or-review-index-drift.md).
- Updated [Upgrading kspec to a New Version](docs/guides/upgrading-kspec.md)
  with the 1.2 manifest fields, folder layout, and rollback procedure.
- Updated [Importing and Approving a Plan](docs/guides/importing-and-approving-a-plan.md)
  with \`--materialize-resources\` derivation guidance.
- Updated [Local Resources for Plans and Reviews](docs/concepts/local-resources.md)
  and [Working With Local Resources](docs/guides/working-with-local-resources.md)
  with task-markdown resource resolution, drift status semantics, browser
  \`kspec_dir\` project-context routing, the task static-export asset layout, and an
  end-to-end temp-project verification walkthrough that runs against a single
  continuously-running daemon.
- **Project-neutral package guidance.** Package-shipped agent sections
  (\`templates/agents-sections/\`) and core skills (\`templates/skills/\`) now
  describe universal kspec mechanics only. Hard-coded branch names (\`dev\`,
  \`main\`), toolchain commands (\`npm test\`, \`oxlint\`, Vitest), GitHub PR policy,
  fixed agent ids (\`task-worker\`, \`pr-reviewer\`), and \`kynetic.meta.yaml\`
  references have been replaced with project-defined wording or pointers to
  \`kspec agent list\`, project meta, and project-local skill sources. Consumer
  projects can adopt their own branch policy, toolchain, and external review
  process without inheriting the Kynetic self-hosting repository's defaults.
  Self-hosting policy now lives in local project context (\`AGENTS.md\`,
  project-local \`.kspec/skills/\`, project meta conventions). A new project-local
  \`shared-guidance-neutrality\` reviewer skill encodes the semantic checklist
  reviewers apply to future changes to these shared surfaces.

## v0.14.0

Stability release focused on daemon endpoint coherence, dispatch workspace
cleanup safety, task-storage compatibility responses, docs/search/release-notes
rendering, AC annotation validation, and CI/publish reliability.

### New or changed configuration

- \`daemon.host\` now defaults to numeric IPv4 loopback \`127.0.0.1\` instead of
  \`localhost\` to avoid \`/etc/hosts\` and DNS resolution drift.
- \`daemon.connect_host\` — optional host advertised to local clients when the
  daemon binds a wildcard address such as \`0.0.0.0\` or \`::\`. It can also be set
  with \`KSPEC_DAEMON_CONNECT_HOST\`.

### Breaking changes

- None.

### Features & Additions

- **Daemon endpoint resolution** — shared endpoint metadata and resolution now
  flow through daemon startup, CLI lifecycle metadata, auto-start, clients, and
  web UI daemon access. Endpoint validation rejects unreachable bind/connect
  combinations while preserving loopback aliases and wildcard-bind use cases.
- **Docs and release-note surfaces** — added Pagefind-backed docs search,
  docs navigation integration, release-notes rendering in the web UI, and
  canonical \`RELEASE_NOTES.md\` wiring tests.
- **Task-storage compatibility API responses** — daemon routes now return
  structured \`task_storage_incompatible\` responses for legacy task-storage
  projects, with shared route helpers and coverage across affected surfaces.
- **Detached reviewer merge helper** — merge/reviewer skills gained detached
  review helper support plus portable supporting-file references.
- **AC annotation validation** — acceptance-criteria annotations now enforce
  the \`ac-*\` identifier format, normalize catalog IDs, and report malformed
  annotation and stale-mapping cases more precisely.

### Bug Fixes

- Recursive daemon command proxying is suppressed, including inside agent
  invocations, so daemon-handled commands do not call back into the same proxy
  path.
- Dispatch cleanup preserves active/in-flight task workspaces across branches,
  reviewer snapshots, corrupt metadata, unknown worktree roots, and bootstrap
  race windows while surfacing labeled diagnostics for skipped artifacts.
- Dispatch reconciliation no longer overlaps active cycles; event-bus lineage
  and source-ordering state is bounded so aged correlated chains are released.
- Entity-cache diagnostics suppress repeated known task-storage incompatibility
  reports while preserving degraded-cache behavior.
- Daemon/web UI startup asset resolution, runtime readiness, configured host
  validation, and CLI serve lifecycle metadata were hardened.
- Publish workflow now installs Bun before running the full suite, and package
  repository/discussion URLs now point at \`lepahc/kynetic-spec\`, unblocking npm
  provenance publication.

### Documentation

- README was trimmed into a concise landing page with docs cross-links.
- Added and refreshed Getting Started, Concepts, Guides, and Troubleshooting
  pages, including corrected CLI guidance and recovery procedures.
- Updated merge/reviewer guidance, dispatch-compatible branch guidance, and
  rendered skill outputs.

### Other Changes

- Expanded the daemon-cleanup lint rule and test fixtures to catch unscoped
  daemon ownership, alias/wrapper edge cases, lifecycle hooks, and startup
  failure cleanup leaks.
- Serialized dynamic test-daemon port startup with filesystem locks and held
  Playwright fixture locks across restart windows to remove parallel bind races.
- Applied final \`oxfmt\`, lint, typecheck, and full-test stability sweeps across
  the dev merge delta.

## v0.13.0

Significant release focused on a daemon entity cache, multi-turn session
lifecycle, a new automation subsystem (hooks/schedules/events), split
per-task storage with a required migration, a review records web UI, plan
branches, and a single-command upgrade flow.

### New or changed configuration

- \`daemon.runtime\` — new \`kspec.config.yaml\` key selecting the daemon
  runtime (\`bun\` or \`node\`). Defaults to \`node\`.
- \`dispatch.sync\` — new \`kspec.config.yaml\` section controlling
  integration branch sync cadence and behavior.
- \`coverage.scan_paths\` and \`coverage.exclude_patterns\` — new
  \`kspec.config.yaml\` section for the AC coverage scanner, making it
  language-agnostic and allowing per-project include/exclude tuning.
- \`hooks:\` meta domain — new top-level \`kspec.meta.yaml\` section for
  event-driven hook actions, managed via
  \`kspec hook add/set/list/enable/disable/remove\`. Distinct from the
  existing \`kspec.config.yaml#hooks\` block that controls
  checkpoint/prompt-check hook installation.
- \`schedules:\` meta domain — new top-level \`kspec.meta.yaml\` section for
  cron-style scheduled agent actions, managed via \`kspec schedule\`.
- \`session_prompt\` action type — new action input for multi-turn session
  lifecycle, with \`prompt\`/\`prompt_template\` and skill support.
- \`kspec setup\` / \`kspec init --setup\` now scaffold \`kspec.config.yaml\`,
  default agents, conventions, a session reflection hook (restricted to
  the first idle event), the default module, and gitignore entries on
  first run. Existing setups are preserved.
- \`kspec release-notes\` — new top-level command that prints notes for the
  installed version or an inclusive \`--from <version> --to <version>\`
  range, reading directly from \`RELEASE_NOTES.md\`.
- \`kspec upgrade\` now appends release notes for every intervening version
  to its output so behavioral changes surface during upgrade.
- \`RELEASE_NOTES.md\` is shipped in the published package; the release
  skill documents the authoring conventions and the pre-release check
  that enforces a non-empty entry for the version being released.

### Breaking changes

- **Task storage split requires migration.** Task data now lives in a
  per-task directory layout (core, notes, history) instead of the single
  \`project.tasks.yaml\` monolith. Existing projects must run
  \`kspec task migrate\` to convert their task file to the split layout
  and \`kspec task storage activate\` to enable the new backend. Tasks
  continue to read from the monolithic format until activation, so the
  migration can be staged, but task writes after upgrade require the
  split layout.

### Features & Additions

- **Daemon entity cache** — tiered in-memory cache for items, tasks,
  meta, plans, reviews, inbox, and triage, with watcher-driven
  incremental invalidation, write-through updates, and cache-backed read
  concurrency. Adds \`GET /api/debug/cache-status\` for diagnostics and a
  \`cache:status\` WebSocket topic for domain-ready invalidation signals.
- **Multi-turn session lifecycle** — active session registry, idle-grace
  auto-close, \`session.idle\` event, \`session_prompt\` action type, and
  dispatch engine integration for continuing work across turns.
- **Automation subsystem** — hook, schedule, event, composition, and
  action model with CLI commands (\`kspec hook\`, \`kspec schedule\`,
  \`kspec event\`), a schedule tick engine, a hook execution engine, a
  composition join accumulator, and shared action run tracking.
  \`kspec validate\` now enforces hook/schedule/composition rules.
- **Split per-task storage** — per-task directory layout with core data,
  notes, and history files. Adds \`kspec task migrate\`,
  \`kspec task storage activate\`, \`kspec task rebuild-index\`, write
  buffering for multi-file transactions, and an in-file activity
  timeline in \`task get\`.
- **Review UI in the web app** — review list and detail pages with
  thread view, revision selector, inline diff viewer with commenting,
  structured content viewer for plan/spec reviews, verdict/check/
  thread/lifecycle API endpoints, and WebSocket broadcasts for review
  events. Task detail pages link to associated reviews.
- **Plan branches** — new \`branch\` field on plans, \`kspec plan branch\`
  command, \`kspec plan derive\` tasks by default, and dispatch workspace
  base-branch resolution from plan branch.
- **Single-command upgrade** — \`kspec upgrade\` migrates scaffold,
  skills, and \`kspec-agents.md\` in one step, with corruption recovery,
  orphan skill cleanup, and \`--force\` that preserves user-removed
  defaults.
- **Unified daemon API envelope** — all daemon routes return a typed
  \`ApiResponse<T>\` wrapper. Read routes now serve from the entity
  cache.
- **Dispatch hardening** — session lifecycle event emission on terminal
  states, stale integration target detection when base branch changes,
  dispatch branch push lifecycle, and shadow worktree cross-
  contamination guards.
- **YAML round-trip stability** — raw-data preservation for workflow
  runs and triage records.
- **CLI ergonomics** — \`kspec item ac update\` alias, smarter rejection
  messages when \`kspec task set\` rejects a status transition, automatic
  dangling-reference cleanup on item deletion, and restore of pre-block
  status on \`kspec task unblock\`.
- **Web UI** — automation view with trigger editing, cache-warming
  loading skeletons, session.idle event rendering, query retry
  ceiling, and WebSocket invalidation replacing polling across more
  surfaces.
- **Test infrastructure** — smart test runner caching with condensed
  output, per-file progress in non-verbose mode,
  \`no-source-scanning\` and \`no-leaky-test-daemon\` oxlint rules,
  \`readTestOutput\` helper.

### Bug Fixes

- \`kspec setup\` base-branch fallback now uses the full dispatch fallback
  chain and handles stale remote HEAD.
- Daemon emits cache-invalidation events for new non-active sessions.
- Daemon loads config from worktree root instead of main repo root.
- Batch atomic failures now report \`rolled_back\` correctly and include
  a rollback note in output.
- Web UI plan filter resolves via bidirectional ULID-prefix matching.
- CLI auto-start of daemon is suppressed in dispatch sessions and on
  \`serve\` commands.

### Documentation

- \`AGENTS.md\` trimmed to architecture/gotchas/decision frameworks; CLI
  and workflow detail moved into skills.
- New review-plan skill for plan document quality review.

### Other Changes

- oxlint + oxfmt replace Prettier in the lint/format pipeline.
- Legacy \`ralph\` agent references removed; legacy agent config alias
  retained for back-compat.

## v0.12.0

Major feature release with review records, dispatch workspace management,
and web UI modernization.

### New or changed configuration

- \`kspec.config.yaml\` accepted a \`dispatch.publication_mode\` key with
  \`manual_merge\`, \`pull_request\`, and \`auto\` publication modes controlling
  how dispatched work was published. The default preserved prior behavior.
- \`kspec.config.yaml\` gained a \`hooks\` section for configuring project
  hooks directly during setup.
- \`dispatch.base_branch\` in \`kspec.config.yaml\` now doubles as the
  fallback when a dispatched task submits without an explicit upstream.

### Breaking changes

- Dispatched task review is now driven by per-cycle kspec review records.
  Agents no longer open GitHub PRs for dispatched work; reviews are created
  with \`kspec review\` and merged locally. Automation built around opening
  PRs for dispatched tasks must be updated.

### Features & Additions

- **Per-cycle review records** — review CLI surface for creating, querying,
  and mutating reviews with verdicts, checks, threads, and gate evaluation.
- **Dispatch workspace lifecycle** — canonical task branch lineage, worktree
  isolation, bootstrap preflight, orientation prompts, and workspace
  registry persistence.
- **Task activity timeline** — git query for shadow branch history, activity
  normalization with commit message and diff parsing, and display in
  \`task get\`.
- **Fix-cycle diff context** — reviewer orientation includes diff summary for
  fix cycles.
- **Portable task submission linkage** — dispatch \`base_branch\` fallback for
  \`upstream_ref\`.
- **Session improvements** — branch worktree mode, text search, unified
  filtering, summary stats, and session event detail API.
- **Web UI: TanStack Query v6 migration** — dashboard, core pages, inbox,
  triage, sidebar, and sessions migrated; polling replaced by WebSocket
  invalidation.
- **Web UI: Markdown rendering** — streaming markdown renderer, ANSI
  terminal color rendering, prose typography.
- **Web UI: Session streaming** — WebSocket-first live viewing with infinite
  scroll pagination.
- **Droid ACP adapter** — agent detection, skill import/renderer, and core
  skill registration.
- **YAML serialization stability** — canonical field ordering, round-trip
  stability, and anchor/alias crash prevention.
- **Plan enhancements** — derive from specs, import into existing plans,
  export command, content-only storage.
- **Daemon APIs** — batch item fetch, ref index endpoint, server-side
  aggregation, title resolution, enriched WebSocket broadcasts.
- **Validation** — AC annotation validation, spec completeness policy,
  blanket coverage ref rejection.

### Bug Fixes

- Fixed dispatch workspace provisioning, health reconciliation, and
  lifecycle state management.
- Fixed web UI URL state management — use \`goto()\` instead of
  \`replaceState\`/\`pushState\`.
- Fixed shadow branch sync races with per-worktree locks and in-flight
  dedup.
- Fixed YAML anchor/alias crash when \`sortMapEntries\` reorders shared
  references.
- Hardened test suite for CI stability across dispatch, session, and daemon
  tests.

## v0.11.0

Comprehensive web UI revamp with 11 new views, a design system foundation,
and extensive bug fixes.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Features & Additions

- **Dashboard Overview** — active work summary, status counts,
  needs-attention section with animated counters.
- **Task Board (Kanban)** — column-based view (Backlog/Ready/In
  Progress/Review/Done) with task cards, detail modal, and Active Fleet
  row showing live agent output.
- **Session Stream** — real-time session viewer with thinking blocks, tool
  call views, message rendering, and auto-scroll.
- **Session History** — list view of past agent sessions with filtering,
  dispatch detection, and duration display.
- **Agent & Dispatch View** — agent cards with edit forms, dispatch status,
  active invocation monitoring.
- **Plans View** — plan list with progress tracking and lazy-loaded content
  expansion.
- **Workflows Page** — workflow list with step visualization and start
  action.
- **Settings Page** — project config, conventions, daemon info, shadow
  branch health status.
- **Validation & Alignment View** — spec coverage metrics, trait AC
  warnings.
- **Specs Page** — spec item browser with plan filtering.
- **Enhanced Inbox** — triage status indicators, category/status filters.
- **Design system** — token contract with semantic color variables,
  animation utilities.
- **ReferenceLink component** — unified task/spec/item reference display
  with title resolution.
- **Shared package** — \`@kynetic-ai/shared\` with API types and Zod schemas
  used by daemon and web UI.

### Bug Fixes

- Fixed automation filter dropdown options.
- Removed useless Task/Subtask type filter.
- Unified task detail display across kanban and task list.
- Fixed kanban and task list overflowing viewport.
- Fixed shadow branch health check in daemon.
- Fixed validate page crash from undefined traitCycles.
- Fixed inbox/triage filter dropdowns (Svelte 5 migration).
- Gated sidebar badge counts on project store initialization.
- Tool calls collapsed by default with truncatable name badges.

### CI

- Added \`build:shared\` step to root build script for CI.
- Fixed gh-pages deploy workflow to build shared package before web-ui.

## v0.10.0

Major release introducing the agent dispatch engine — a fully integrated
system for autonomous task execution, replacing the external ralph
orchestrator.

### New or changed configuration

- Agent definitions gained dispatch rules, trigger events, and runtime
  fields. Existing agent definitions continue to load without change.
- Session model extended with \`trigger_source\`, \`agent_id\`, and agent
  lifecycle events.

### Breaking changes

- The external ralph orchestrator is superseded by the built-in dispatch
  engine (\`kspec agent dispatch start/stop/status/watch\`). Projects that
  scripted ralph invocations directly should migrate to the new commands.

### Features & Additions

- **Agent dispatch engine** — autonomous task dispatch with configurable
  agents, dispatch rules, and priority scheduling.
- **Agent invocation lifecycle** — structured agent runs with session
  tracking, budget enforcement, and failure handling.
- **Agent CLI commands** — \`kspec agent run\`, \`kspec agent list\`, and
  dispatch management commands.
- **Dispatch watch streaming** — real-time text output from running agent
  invocations.
- **Daemon dispatch integration** — dispatch engine runs inside the daemon
  with WebSocket event streaming.
- **Web UI bundled in npm package** — daemon serves the web interface
  directly from the installed package.
- **Stale session management** — detect and close stale active sessions
  with \`kspec session close-stale\`.
- **Batch ergonomics** — \`tags\` alias for \`tag\`, P1/P2/P3 priority aliases.
- **Task description editing** — \`kspec task set --description\` support.

### Bug Fixes

- Fixed serve command safety when running under dispatch (prevents agents
  from killing their host daemon).
- Fixed concurrent task mutation data loss during agent invocations.
- Fixed dispatch queue staleness and self-triggering suppression.
- Fixed WebSocket disconnect cleanup for dropped clients.
- Fixed EPIPE handling in JSON-RPC framing output.

## v0.9.1

Bug fixes and stability improvements for the kspec CLI, ralph orchestrator,
and merge driver.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Bug Fixes

- Truncated oversized ACP prompt payloads in ralph to prevent failures.
- Fixed merge driver non-interactive exit code and TTY detection.
- Accepted underscore arg variants in batch payloads.
- Resolved observations slug ambiguity.
- Failed fast for empty batch \`--commands\` input.
- Avoided shell-based git command execution in shadow operations.
- Added explicit \`--agent\` override support for setup.
- Accepted P1–P5 priority notation in task commands.
- Included package version in agents freshness hash.
- Prevented task patch TTY hang without \`--data\`.
- Fixed ralph orchestrator memory leaks causing OOM after long runs.

## v0.9.0

Session event management and ralph adapter improvements.

### New or changed configuration

- Ralph skill invocation became adapter-aware, formatting commands per
  adapter type (Claude Code, Codex).

### Breaking changes

- None.

### Features & Additions

- Added retroactive session event compaction command for managing oversized
  session histories.

### Bug Fixes

- Fixed oversized event payloads in sessions by externalizing them to blob
  storage.
- Routed ralph PR reviews to the dedicated pr-review skill.
- Fixed terminal output streaming to session artifacts.
- Fixed ralph adapter validation false-negative for the codex-acp adapter.

## v0.8.0

Codex integration hardening across setup, skill installation/rendering, and
adapter configuration.

### New or changed configuration

- \`codex-acp\` adapter gained first-class support and per-role adapter
  selection for ralph loop execution.
- Per-adapter auto-approve argument support added to make loop automation
  behavior adapter-aware.
- Codex \`project_doc_fallback_filenames\` now seeded with \`kspec-agents.md\`
  so Codex picks up agent instructions automatically.

### Breaking changes

- None.

### Features & Additions

- Enabled Codex core skill install/render support with namespaced skill
  references.
- Ported project skills to both Claude and Codex render outputs.

### Bug Fixes

- Unified Codex detection behavior across setup/status and enforced Codex
  precedence over Copilot markers.
- Corrected Codex ACP scoped package naming.
- Switched Codex environment injection to TOML and fixed restore handling.
- Fixed shadow git detection for restricted runtime environments.

## v0.7.0

Batch usage documentation for agents, improved CLI discoverability, and a
major test migration from static analysis to E2E.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Features & Additions

- Added the batch usage agent template (\`07-batch-usage.md\`) documenting
  JSON format, argument rules, and invocation methods.
- Added a path filter to \`kspec batch commands\` — look up a single
  command's schema via \`kspec batch commands "task set"\`.

### Bug Fixes

- Fixed bootstrap script detecting stale \`dist/\` and rebuilding when source
  is newer.
- Improved session-close-error test reliability.

## v0.6.0

Quality and reliability release — massive test migration from static
analysis to E2E, improved validation output, and cross-platform fixes.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Features & Additions

- Split trait AC and own AC coverage in \`kspec validate\` output for
  clearer coverage visibility.
- Session-scoped checkpoint hook filtering — checkpoints only fire for the
  active session.
- Local test sharding — \`npm run test:shard1/2/3\` for faster dev runs.

### Bug Fixes

- Bootstrap always npm-links the local kspec build.
- Shadow branch detection works in shallow clones.
- \`KSPEC_SESSION_ID\` injected via harness config in the ralph loop.

## v0.5.0

Session management overhaul, ralph loop improvements, and multi-harness
support.

### New or changed configuration

- \`session_id\` added to the task schema for session-scoped task claiming.
- \`task budget\` schema introduced with CRUD functions and enforcement at
  \`task start\`.
- Multi-harness environment variable injection added for Gemini CLI and
  OpenCode adapters.

### Breaking changes

- None.

### Features & Additions

- Rewrote \`session start\` output with primer/full modes, hierarchical
  activity timeline, and computed JSON fields.
- Added triage-aware inbox statistics to \`session start\`.
- Added \`unlocks N\` dependency display showing what completing a task
  unblocks.
- Implemented \`session create\` command and library function.
- Replaced marker files with session budget in the ralph loop.
- Migrated the end-loop signal from a marker file to session state.
- Replaced bash guard scripts with the native \`kspec guard worktree\`
  command.

### Bug Fixes

- Fixed ralph signal handler to properly await async cleanup.
- Added enum validation for \`item set --status\` and \`--maturity\`.
- Added advisory file locking to prevent concurrent write data loss.
- Fixed \`task set\` null clearing for \`--spec-ref\` and \`--meta-ref\`.
- Fixed \`task submit\` counting toward the max-tasks limit.

## v0.4.0

Core skill system and quality-of-life improvements for the kspec CLI.

### New or changed configuration

- \`kspec setup\` now installs 11 portable core skills (help, observations,
  reflect, triage, triage-inbox, triage-automation, writing-specs, plan,
  task-work, create-workflow, review).

### Breaking changes

- None.

### Features & Additions

- Core skill system — 11 portable skills now ship with kspec and install
  via \`kspec setup\`.
- Skill rendering pipeline — content-hash based skip for unchanged skill
  files during regeneration.
- CI improvements — test suite split into 3 parallel shards with path-based
  filtering for faster feedback.

### Bug Fixes

- Fixed plan import dropping \`spec_ref\` on manual tasks.
- Fixed plan import placing \`type:trait\` items incorrectly.
- Fixed \`task complete --force\` to bypass all state checks as intended.
- Fixed JSON-stringify for nested objects in batch arg serialization.

## v0.3.0

Major feature release introducing the daemon, web dashboard, skill system,
plugin architecture, and interactive triage.

### New or changed configuration

- \`kspec.config.yaml\` introduced with configurable shadow branch, author
  identity, daemon settings, and validation defaults.
- Auto-generated \`kspec-agents.md\` from meta conventions, workflows, and
  template sections.

### Breaking changes

- Introduced the shadow-branch-backed \`.kspec/\` worktree architecture.
  Projects initialized prior to this release continue to work but should
  use \`kspec init\` / \`kspec shadow repair\` to adopt the new layout.

### Features & Additions

- **Interactive Triage System** — full triage workflow with CLI commands,
  daemon API routes, shared export formatter, and web UI.
- **Web Dashboard** — SvelteKit-based web UI with dashboard, inbox, tasks,
  search, session context, and WebSocket real-time updates.
- **Daemon & Server** — Elysia-based daemon with multi-project support,
  file watching, WebSocket broadcasting, auto-start.
- **Skill System** — full skill lifecycle: import, render, drift detection,
  multi-platform support (Claude Code + Codex), core skill installation,
  and plugin marketplace.
- **Agent Instruction Generation** — auto-generated \`kspec-agents.md\` from
  meta conventions, workflows, and template sections.
- **Doctor Command** — health check system for diagnosing kspec
  installation issues.
- **Workflow System** — workflow engine with step navigation, pause/resume,
  enforcement modes, and loop mode for autonomous agents.
- **Shadow Branch Merge Driver** — semantic YAML merge for conflict-free
  shadow branch operations.
- **Setup Pipeline** — unified setup with permission seeding, memory
  seeding, and hook installation.
- **Plugin System** — core skills shipped as an npm package plugin with
  marketplace registration.
- **Plan Import** — structured document import for plan-to-spec
  translation.

## v0.1.2

CLI version display fixes and release automation improvements.

### New or changed configuration

- Added the \`/release\` skill for streamlined version tagging and GitHub
  releases.

### Breaking changes

- None.

### Bug Fixes

- Fixed CLI \`--version\` flag to read the version from \`package.json\`
  instead of using a hardcoded value.
- Fixed npm trusted publishers OIDC authentication by upgrading to Node 22
  and \`npm@latest\`.

## v0.1.1

Bug fixes and documentation updates.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Bug Fixes

- Fixed author attribution for auto-generated notes — now properly uses
  the \`KSPEC_AUTHOR\` environment variable or git user fallback instead of
  hardcoded values.
- Increased timeout for ref resolution test to improve CI reliability.

### Documentation

- Updated \`INSTALL.md\` with npm installation instructions now that the
  package is published.

## v0.1.0

Initial public release of \`@kynetic-ai/spec\`.

### New or changed configuration

- Initial configuration surface: \`.kspec/kynetic.yaml\` manifest, module
  files, project task storage, inbox, plans, reviews, and triage.

### Breaking changes

- N/A (initial release).

### Features & Additions

- First published release of the kspec CLI, library, and schemas.
- YAML-based spec format with Zod validation.
- Task system referencing specs (no duplication).
- Append-only notes with supersession.
- Shadow branch worktree architecture for \`.kspec/\`.
`,path:"release-notes/RELEASE_NOTES.md"}],repoUrl:"https://github.com/lepahc/kynetic-spec/blob/main"},C=_e;function $e(i){return C.entries.find(s=>s.slug===i)}function en(){return C.entries}function nn(i){return je(C.entries,i)}function tn(){return C.repoUrl}var Re=w('<button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><!></button>'),Ce=w('<div class="px-3 py-2 text-sm text-muted-foreground">Search is not available. Build the search index first.</div>'),Se=w('<div class="px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground"><!> Searching...</div>'),We=w('<div class="px-3 py-2 text-sm text-muted-foreground"> </div>'),De=w('<div class="text-xs text-muted-foreground mt-0.5 line-clamp-2"></div>'),Pe=w('<li><button type="button" class="w-full text-left px-3 py-2 hover:bg-accent transition-colors cursor-pointer"><div class="text-sm font-medium"> </div> <!></button></li>'),Le=w('<ul class="py-1"></ul>'),Ee=w('<div class="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-md z-50 max-h-80 overflow-y-auto" data-testid="docs-search-results"><!></div>'),Ue=w('<div class="relative"><div class="relative"><!> <input type="text" placeholder="Search docs..." class="w-full pl-8 pr-8 py-1.5 text-sm rounded-md border border-input bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" data-testid="docs-search-input"/> <!></div> <!></div>');function an(i,s){de(s,!0);let t=b(""),r=b(he([])),d=b(!1),e=b(null),n=b(!1),g=b(void 0),m=b(!1),y=null;async function Y(){if(a(e))return a(e);try{const o=await ce(()=>import(`${G}/pagefind/pagefind.js`),[],import.meta.url);return await o.options({bundlePath:`${G}/pagefind/`}),await o.init(),c(e,o,!0),o}catch{return c(n,!0),null}}function V(){c(m,!0),!a(e)&&!a(n)&&Y()}function K(){setTimeout(()=>{c(m,!1)},200)}function X(o){o.key==="Escape"&&(c(t,""),c(r,[],!0),c(m,!1),a(g)?.blur())}function J(o){be(o),c(t,""),c(r,[],!0),c(m,!1)}le(()=>{const o=a(t).trim();if(o===""){c(r,[],!0),c(d,!1);return}if(!a(e))return;c(d,!0),y&&clearTimeout(y);const u=a(e);y=setTimeout(async()=>{try{const x=await u.search(o),T=await Promise.all(x.results.slice(0,10).map(D=>D.data()));c(r,T,!0)}catch{c(r,[],!0)}finally{c(d,!1)}},200)});var S=Ue(),W=k(S),q=k(W);xe(q,{class:"absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"});var v=_(q,2);fe(v),me(v,o=>c(g,o),()=>a(g));var Q=_(v,2);{var Z=o=>{var u=Re(),x=k(u);Te(x,{class:"h-3.5 w-3.5"}),p(u),F("mousedown",u,T=>{T.preventDefault(),c(t,""),c(r,[],!0)}),f(o,u)};R(Q,o=>{a(t)&&o(Z)})}p(W);var $=_(W,2);{var ee=o=>{var u=Ee(),x=k(u);{var T=l=>{var h=Ce();f(l,h)},D=l=>{var h=Se(),I=k(h);Ie(I,{class:"h-3.5 w-3.5 animate-spin"}),ue(),p(h),f(l,h)},te=l=>{var h=We(),I=k(h);p(h),M(()=>z(I,`No results for "${a(t)??""}"`)),f(l,h)},ae=O(()=>a(r).length===0&&a(t).trim()!==""),se=l=>{var h=Le();ke(h,21,()=>a(r),we,(I,j)=>{var P=Pe(),L=k(P),E=k(L),re=k(E,!0);p(E);var oe=_(E,2);{var ie=A=>{var U=De();ye(U,()=>a(j).excerpt,!0),p(U),f(A,U)};R(oe,A=>{a(j).excerpt&&A(ie)})}p(L),p(P),M(()=>z(re,a(j).meta?.title??"Untitled")),F("mousedown",L,A=>{A.preventDefault(),J(a(j).url)}),f(I,P)}),p(h),f(l,h)};R(x,l=>{a(n)?l(T):a(d)?l(D,1):a(ae)?l(te,2):l(se,-1)})}p(u),f(o,u)},ne=O(()=>a(m)&&(a(t).trim()!==""||a(n)));R($,o=>{a(ne)&&o(ee)})}p(S),B("focus",v,V),B("blur",v,K),F("keydown",v,X),ve(v,()=>a(t),o=>c(t,o)),f(i,S),pe()}ge(["keydown","mousedown"]);export{an as D,en as a,Qe as b,$e as c,nn as d,tn as e,Ze as g,Je as r};
