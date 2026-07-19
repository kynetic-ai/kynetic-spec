# Local Resources for Plans and Reviews

Plans and reviews often need supporting files: a research PDF that informed a design, a UX screenshot referenced from the plan body, a screen recording captured during a review, an evidence log a reviewer wants future agents to see. kspec stores those files as **local resources** owned by the plan or review they belong to, declared in a manifest, and resolved through versioned references.

This page explains the model. For the commands and API routes that work with it, see [Working With Local Resources](../guides/working-with-local-resources.md).

## Why a Dedicated Model

Three things go wrong when supporting files are dropped into a project ad hoc:

- **They drift away from their context.** A screenshot loose in `/screenshots` does not know which plan it belongs to. Cleaning up later means guessing.
- **They bloat structured records.** Inlining a 2 MB screenshot into the plan YAML makes every list query slower, every cache reload heavier, and every diff harder to read.
- **They have no version identity.** A reviewer can swap a screenshot underneath an approval, and nothing notices.

The local-resource model solves all three. Each resource has a single owning entity, lives in that entity's directory, and is identified by a stable id plus a content hash and git version. References are versioned so a derived task can detect when the underlying file has changed.

## Folder-Backed Storage

Starting with `kynetic: "1.2"`, plans and reviews are folder-backed entities. Each plan and each review owns a directory under `.kspec/` and the project-wide index files stay lean.

### Plan Layout

```
.kspec/
├── project.plans.yaml                          # Lean index: ULID, slugs, title, status, source path,
│                                               #   module, branch, derived refs, timestamps,
│                                               #   resource summaries
└── plans/
    └── <plan-ulid>/
        ├── plan.md                             # Authoritative markdown document
        ├── plan.yaml                           # Identity, status, lifecycle, refs, timestamps
        ├── notes.yaml                          # Optional — present when the plan has notes
        ├── resources.yaml                      # Resource manifest (always present)
        └── resources/                          # Resource files (only when resources exist)
            └── <relative-path>
```

`plan.md` is the source of truth for the plan document. The project-wide `.kspec/project.plans.yaml` index never inlines full markdown, full notes, or resource bytes — only the bounded fields a list view needs.

### Review Layout

```
.kspec/
├── project.reviews.yaml                        # Lean index: ULID, lifecycle, subject summary,
│                                               #   related refs, disposition, timestamps,
│                                               #   resource summaries
└── reviews/
    └── <review-ulid>/
        ├── review.yaml                         # Full review record: subject, threads, checks,
        │                                       #   verdicts, events, notes, external links
        ├── resources.yaml                      # Resource manifest (always present)
        └── resources/                          # Resource files (only when resources exist)
            └── <relative-path>
```

Reviews keep the structured review record cohesive in one `review.yaml` file. Threads, checks, and verdicts are not split into sidecars in this format. As with plans, the project-wide `.kspec/project.reviews.yaml` index stores only the bounded summary fields a list view needs.

### Unknown Files Are Preserved

Anything an editor or another tool drops into a plan or review directory that kspec does not recognize is ignored by kspec semantics and preserved across writes. The CLI does not delete unfamiliar files, so a sibling tool that drops `.DS_Store` or `editor.lock` is safe.

## The Resource Manifest

Every plan and every review has a `resources.yaml` file. It lists every file the entity owns, with enough metadata for list views, API responses, static exports, and drift detection to work without touching the file bytes.

### `resources.yaml` Shape

```yaml
resources:
  - id: ux-mockup
    label: "Sign-in mockup, v3"
    path: ux/sign-in-v3.png
    content_type: image/png
    bytes: 184320
    sha256: 0a4b3f1d2c89e7f6a5b4c3d2e1f009887766554433221100ffeeddccbbaa9988
    git_commit: 7c3a2e4d6f1b9080a5d3e6f8c7b4a290de1f0234
    git_path: .kspec/plans/01JHJ5K9XQ8Z3F2V0WB7T5MNRC/resources/ux/sign-in-v3.png
    description: "Final mockup approved by design review"
```

### `ResourceMetadata` Fields

Every resource — whether returned by the CLI, the daemon API, or a static export — uses the same fixed shape:

| Field          | Type             | Meaning                                                                          |
| -------------- | ---------------- | -------------------------------------------------------------------------------- |
| `id`           | `string`         | Stable identifier. Matches `[a-z0-9][a-z0-9._-]{0,127}`                          |
| `label`        | `string \| null` | Optional human-friendly label                                                    |
| `path`         | `string`         | POSIX-relative path under the entity's `resources/` directory                    |
| `content_type` | `string`         | `type/subtype` MIME token (never null; falls back to `application/octet-stream`) |
| `bytes`        | `number`         | File size in bytes                                                               |
| `sha256`       | `string`         | 64-character lowercase hex content hash                                          |
| `git_commit`   | `string \| null` | 40-character commit SHA captured when bytes were last written                    |
| `git_path`     | `string \| null` | Repository-relative path captured alongside `git_commit`                         |
| `description`  | `string \| null` | Optional free-form description                                                   |

The exact shape is fixed so plans, reviews, and any future folder-backed entity that adopts the trait read and write the same fields.

### Resource Id Rules

Resource ids must match the pattern `[a-z0-9][a-z0-9._-]{0,127}`:

- start with a lowercase letter or digit
- contain only lowercase letters, digits, `.`, `_`, or `-`
- be 1 to 128 characters long

Ids are stable identifiers — they appear in API URLs, in `resource_refs` on derived tasks, and in materialized task copies as `plan-<resource-id>`. Pick an id you can live with; renaming an id is a remove-and-re-add operation.

### Resource Path Rules

The `path` field is a POSIX-relative path under the owning entity's `resources/` directory. The following shapes are rejected at the manifest boundary and by every command, API route, and resolver:

- absolute paths (anything that starts with `/`)
- parent traversal (`..` segments)
- backslashes (`\`)
- empty segments (`a//b`)
- redundant `.` segments
- paths that resolve through a symlink outside the resource root

This guarantees a resource reference always resolves inside its owning entity's tree, no matter where it was authored.

### `content_type` Population

`content_type` is never null. The CLI and API populate it the same way:

1. If an explicit value is supplied (`--content-type` on the CLI, multipart `content_type` field on the API), it must be a non-empty `type/subtype` token with no whitespace. It is stored exactly as given.
2. Otherwise the value is inferred from the final resource path's extension using the project's MIME lookup (Node's standard MIME table is the fallback).
3. If inference fails (unknown extension, no extension at all), the stored value is `application/octet-stream`.

## Authoring References: `./resources/<relative-path>`

Markdown links and structured task definitions reference resources with the `./resources/` prefix:

```markdown
The login screen renders the validation error as shown in
[the v3 mockup](./resources/ux/sign-in-v3.png).
```

```yaml
- title: Implement sign-in validation
  slug: task-implement-sign-in-validation
  resource_refs:
    - "./resources/ux/sign-in-v3.png"
```

The prefix is stable: it means "a resource owned by this entity, declared in this entity's `resources.yaml`, at this relative path". It is the only authoring form. Absolute paths, project-relative paths, and undeclared paths are rejected wherever a reference is resolved — import, set, derive, attach, serve, export.

## Versioned References on Derived Tasks

When `kspec plan derive` creates a task from a plan task definition that has `resource_refs`, it does **not** copy the resource files by default. It records a `TaskResourceRef` for each referenced resource:

| Field         | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `owner_type`  | `"plan"` or `"task"` — where the bytes actually live              |
| `owner_ref`   | Plan ref (for plan-owned) or task ref (for task-owned copies)     |
| `id`          | Resource id inside the owner's manifest                           |
| `path`        | Relative path inside the owner's `resources/` tree                |
| `sha256`      | Content hash captured at derivation time                          |
| `git_commit`  | Git commit captured at derivation time (or `null` if unavailable) |
| `git_path`    | Repository-relative path captured alongside `git_commit`          |
| `recorded_at` | ISO 8601 datetime the reference was recorded                      |

If the plan resource's current content hash later disagrees with the task's recorded `sha256`, consumers (task detail, agent context, API resource resolver) surface drift instead of silently substituting the new bytes for the old.

The default mode is intentional. A plan-owned resource is single-sourced; derived tasks get pointers plus the hash and git identity needed to detect drift. Copying creates duplicate bytes and hides history.

## Copying Bytes With `--materialize-resources`

The only way to copy plan resource bytes into a derived task's own directory is to pass `--materialize-resources` to `kspec plan derive`. When this flag is present:

- Each plan resource referenced by a derived task is copied into `.kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/<relative-path>`.
- The copied resource is registered in the task's resource manifest with the id `plan-<original-resource-id>` (so a plan resource named `ux-mockup` becomes a task-owned resource named `plan-ux-mockup`).
- The `TaskResourceRef` switches to `owner_type: "task"`, `owner_ref: <task-ulid>`, and points at the task-owned copy.

Use this when a task needs an immutable snapshot of plan resources at derivation time — for example, before handing the task off for long-running work where the plan may continue to evolve.

## Resolving Task Resources From Task Markdown

<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-markdown -->

A task description can reference its resources with the same `./resources/<relative-path>` authoring form a plan uses:

```markdown
The validation surface to build is shown in
![the v3 mockup](./resources/ux/sign-in-v3.png).
```

The `./resources/<relative-path>` reference is resolved through the task's own `resolved_resources` projection rather than against a global path. That projection — exposed on the daemon task detail API alongside a task-scoped `resources_base_url` — resolves both ownership cases the same way for the reader:

- **Plan-owned references (the default).** When a task was derived without materialization, its `TaskResourceRef` still points at the plan's owned bytes (`owner_type: "plan"`). The reference resolves to the plan resource through the task's projection, and the task-scoped bytes URL streams the plan-owned bytes.
- **Task-owned copies (materialized).** When a task was derived with `--materialize-resources`, the copy lives under the task's own `resources/` tree (`owner_type: "task"`) with the id `plan-<original-resource-id>`. The same `./resources/<relative-path>` reference resolves to the task-owned copy through the task's projection.

Either way, the reader does not have to know whether the bytes are plan-owned or task-owned. A client constructs the browser-fetchable URL from the task detail response as `resources_base_url/<resource-id>/bytes` — concretely `GET /api/tasks/:ref/resources/:resourceId/bytes` — and the daemon serves the correct owner's bytes. The web UI uses exactly this projection to rewrite `./resources/<relative-path>` image and link targets in task descriptions to task-scoped resource URLs.

### Drift, Missing, and Unresolved Task Resources Are Status, Not Silent Bytes

<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-drift -->

Each entry in a task's `resolved_resources` projection reports a `status` of `present`, `drift`, `missing`, or `unresolved`, together with a human-readable `message`:

| `status`     | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `present`    | The owner still declares the resource and its current content hash matches the hash recorded at derivation. |
| `drift`      | The owner still declares the resource but its current content hash differs from the recorded `sha256`.      |
| `missing`    | The owner is resolvable but no longer declares the referenced path.                                         |
| `unresolved` | The owning plan or task could not be located, so the reference cannot be re-resolved.                       |

When a task resource is drifted, missing, or unresolved, kspec surfaces the `status` and `message` instead of silently serving replacement bytes. The task resource bytes route refuses to stream bytes that differ from the hash recorded at task derivation, and the live task detail UI shows the status message rather than rewriting the markdown target to a URL that would serve different bytes. A `./resources/<relative-path>` reference that matches no resolved resource at all stays visible as raw authoring text with actionable guidance — it is never rewritten to an unrelated entity URL. This keeps a changed-underneath resource visible as a status signal instead of a quiet substitution.

## Static Export and Daemon URLs

Resources surface through three layers, each with a stable shape.

**CLI / file system.** `./resources/<relative-path>` references resolve against the owning entity's manifest. The bytes live at `.kspec/plans/<plan-ulid>/resources/<relative-path>` or `.kspec/reviews/<review-ulid>/resources/<relative-path>`.

**Daemon API.** Authenticated, project-scoped routes return the resource bytes and metadata using the [`ResourceMetadata`](#resourcemetadata-fields) shape (see [Working With Local Resources](../guides/working-with-local-resources.md#daemon-api-routes) for the full route list).

**Static export.** When the web UI is exported as a static snapshot, resource files are copied to `assets/resources/<entity-type>/<entity-ulid>/<relative-path>`. For plans the layout is `assets/resources/plan/<plan-ulid>/<relative-path>`, for reviews it is `assets/resources/review/<review-ulid>/<relative-path>`, and for task-resolved resources it is `assets/resources/task/<task-ulid>/<relative-path>`:

```
assets/
└── resources/
    ├── plan/
    │   └── <plan-ulid>/
    │       └── <relative-path>
    ├── task/
    │   └── <task-ulid>/
    │       └── <relative-path>
    └── review/
        └── <review-ulid>/
            └── <relative-path>
```

The export rewrites `./resources/<relative-path>` markdown links in plan and task content to point at the exported asset path. The exported metadata reports the exported path so consumers do not need to re-derive it. Only `present` task resources carry an exported asset path; drifted, missing, or unresolved task references are not exported as bytes, so the static snapshot never advertises a substitute for a resource that changed underneath the task.

## How Resources Surface in Use

When you read a plan with `kspec plan get`, the resource manifest summary appears alongside the plan record. When you open a plan in the web UI, the rendered markdown's `./resources/` image links are rewritten to safe plan-scoped resource URLs. When you derive tasks, plan resources travel along as versioned references — or as copies, if you ask. When you static-export the project, resources are copied beside the JSON snapshot so the offline UI works without the daemon.

Resources are the same idea kspec applies elsewhere — versioned, identified, owned by one entity, never silently moved — applied to supporting files that used to live in scattered folders.
