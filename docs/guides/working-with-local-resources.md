# Working With Local Resources

This guide covers attaching files to plans and reviews, referencing them from plan markdown and task definitions, controlling how derived tasks see them, and serving them through the daemon API and static export. By the end, you will know which command to run for each resource lifecycle step and which API route to call from a custom client.

For the model behind these commands — the folder layout, manifest schema, and copy-vs-reference rule — see [Local Resources for Plans and Reviews](../concepts/local-resources.md).

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- A project on `kynetic: "1.2"` or newer (run `kspec upgrade` if your manifest is older — see [Upgrading kspec to a New Version](./upgrading-kspec.md))
- A plan or review you can attach files to

## Attaching a File to a Plan

`kspec plan resource add` attaches a local file to a plan. The plan owns the file from that point on.

```bash
kspec plan resource add @plan-my-feature ./shot.png \
  --id login-shot \
  --path screenshots/login.png \
  --label "Login screen with validation error" \
  --description "Captured during user testing on 2026-05-22"
```

The required flags are `--id` and `--path`:

- `--id <resource-id>` — stable resource identifier. Must match `[a-z0-9][a-z0-9._-]{0,127}`.
- `--path <relative-path>` — POSIX-relative path under the plan's `resources/` directory. The file is copied there.

Optional flags:

- `--label <label>` — human-friendly label that surfaces in list/detail views
- `--description <text>` — free-form description
- `--content-type <mime>` — explicit MIME type; omitted values are inferred from the path extension
- `--replace` — overwrite an existing resource with the same id (refuses to overwrite a different resource id's path)
- `--json` — emit structured JSON output

When `--replace` is omitted, attempting to attach a file under an id or path that already exists fails with `resource_conflict`. Use `--replace` to update an existing resource's bytes or metadata in place.

## Listing, Inspecting, and Removing Plan Resources

```bash
kspec plan resource list @plan-my-feature
kspec plan resource get  @plan-my-feature login-shot
kspec plan resource remove @plan-my-feature login-shot
```

`remove` deletes the manifest entry and the owned file. In interactive shells it prompts for confirmation; pass `--force` to skip the prompt. In non-interactive contexts (CI, dispatched agents), `remove` without `--force` fails with `confirmation_required` rather than blocking on input.

Each of these accepts `--json` to emit structured output suitable for scripting.

## Attaching, Listing, Inspecting, and Removing Review Resources

The review resource commands mirror the plan commands and accept the same flags:

```bash
kspec review resource add @review-1 ./screenshot.png \
  --id login-bug \
  --path screenshots/login.png

kspec review resource list   @review-1
kspec review resource get    @review-1 login-bug
kspec review resource remove @review-1 login-bug --force
```

Use review resources for screenshots, log captures, terminal recordings, or evidence files that a reviewer wants to ship with the review record.

## Importing a Plan With Pre-Declared Resources

When you author a plan markdown file outside kspec and want its resources to come along on import, place a sibling `resources.yaml` manifest and `resources/` directory next to the plan markdown:

```
plans/
├── my-feature.md
├── resources.yaml
└── resources/
    └── ux/
        └── sign-in-v3.png
```

The sibling `resources.yaml` declares the id and path for each file the plan markdown references:

```yaml
resources:
  - id: ux-mockup
    path: ux/sign-in-v3.png
    label: "Sign-in mockup, v3"
    description: "Final mockup approved by design review"
```

The plan markdown references resources with `./resources/<relative-path>`:

```markdown
## Background

The redesigned validation surface is shown in
[the v3 mockup](./resources/ux/sign-in-v3.png).
```

Then import:

```bash
kspec plan import plans/my-feature.md
```

`kspec plan import` walks the markdown for `./resources/<rel>` links, validates that each link resolves against the sibling `resources.yaml`, and copies the declared files into `.kspec/plans/<plan-ulid>/resources/`. If any link does not resolve, the import fails before writing anything — the plan record will not be saved with dangling references.

When you later update a plan with `kspec plan set @plan --content-file <edited.md>`, the new markdown's `./resources/<rel>` links must resolve against the **existing** plan's `resources.yaml`. Attach the resources first with `kspec plan resource add`, then point the markdown at them.

## Referencing Plan Resources From Tasks

A plan's task definitions can declare `resource_refs` so derived tasks know which plan resources they need:

````markdown
## Tasks

```yaml
- title: Implement sign-in validation
  slug: task-implement-sign-in-validation
  spec_ref: "@sign-in-validation"
  resource_refs:
    - "./resources/ux/sign-in-v3.png"
```
````

When `kspec plan derive` runs, it validates each `resource_refs` entry against the source plan's `resources.yaml`. Refs that do not resolve fail derivation.

## Plan Derive: References vs. Materialized Copies

By default, `kspec plan derive` records a versioned `TaskResourceRef` pointing back at the plan's owned resource. No bytes are copied.

```bash
kspec plan derive @plan-my-feature
```

This is the right default: a plan-owned resource is single-sourced, the derived task carries the content hash and git commit captured at derivation time, and consumers can detect drift if the plan's resource later changes.

When a task needs an immutable snapshot of the plan's resource bytes — for example, before handing off long-running work — pass `--materialize-resources`:

```bash
kspec plan derive @plan-my-feature --materialize-resources
```

When this flag is present, derivation:

1. Copies each referenced plan resource into `.kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/<relative-path>`.
2. Registers the copy in the task's resource manifest under the id `plan-<original-resource-id>` (so a plan resource named `ux-mockup` becomes the task-owned resource `plan-ux-mockup`).
3. Updates the task's `TaskResourceRef` to point at the task-owned copy (`owner_type: "task"`, `owner_ref: <task-ulid>`).

Without the flag, no resource bytes are copied — the task references the plan's resource directly.

## Daemon API Routes

When the daemon is running (`kspec serve start`), every plan and review exposes its resources through stable, project-scoped routes. All routes are authenticated through the daemon's existing project-scoping.

### Plan Resources

| Method   | Path                                          | Returns                                                             |
| -------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `GET`    | `/api/plans/:ref/resources`                   | `{ "resources": ResourceMetadata[] }`                               |
| `GET`    | `/api/plans/:ref/resources/:resourceId`       | `{ "resource": ResourceMetadata }`                                  |
| `GET`    | `/api/plans/:ref/resources/:resourceId/bytes` | Raw bytes with `Content-Type` and `X-Kspec-Resource-Sha256` headers |
| `POST`   | `/api/plans/:ref/resources`                   | `201 { "resource": ResourceMetadata, "replaced": false }` (create)  |
|          |                                               | `200 { "resource": ResourceMetadata, "replaced": true }` (replace)  |
| `DELETE` | `/api/plans/:ref/resources/:resourceId`       | `200 { "removed": { "id": string, "path": string } }`               |

### Review Resources

| Method   | Path                                            | Returns                                                             |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `GET`    | `/api/reviews/:ref/resources`                   | `{ "resources": ResourceMetadata[] }`                               |
| `GET`    | `/api/reviews/:ref/resources/:resourceId`       | `{ "resource": ResourceMetadata }`                                  |
| `GET`    | `/api/reviews/:ref/resources/:resourceId/bytes` | Raw bytes with `Content-Type` and `X-Kspec-Resource-Sha256` headers |
| `POST`   | `/api/reviews/:ref/resources`                   | `201 { "resource": ResourceMetadata, "replaced": false }` (create)  |
|          |                                                 | `200 { "resource": ResourceMetadata, "replaced": true }` (replace)  |
| `DELETE` | `/api/reviews/:ref/resources/:resourceId`       | `200 { "removed": { "id": string, "path": string } }`               |

### Task Resources

<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-markdown -->

A derived task does not own a resource upload endpoint — task resources come from the plan it was derived from, either as plan-owned references (the default) or as task-owned copies (`kspec plan derive --materialize-resources`). The daemon exposes a read-only, task-scoped projection so a client can render `./resources/<relative-path>` references from the task description without knowing which owner holds the bytes:

| Method | Path                                          | Returns                                                                        |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET`  | `/api/tasks/:ref/resources`                   | `{ "resources": ResolvedTaskResourceSummary[] }`                               |
| `GET`  | `/api/tasks/:ref/resources/:resourceId`       | `{ "resource": ResolvedTaskResourceSummary }`                                  |
| `GET`  | `/api/tasks/:ref/resources/:resourceId/bytes` | Raw bytes with `Content-Type`, `Content-Length`, and `X-Kspec-Resource-Sha256` |

The task detail API response (`GET /api/tasks/:ref`) includes the same projection inline when the task has resource references:

- `resolved_resources` — an array of `ResolvedTaskResourceSummary` entries, each reporting `owner_type` (`"plan"` or `"task"`), `owner_ref`, `id`, `path`, `content_type`, `byte_size`, `status`, `recorded_sha256`, `current_sha256`, `recorded_git_commit`, `current_git_commit`, and a human-readable `message`.
- `resources_base_url` — a task-scoped base (`/api/tasks/<task-ulid>/resources`) so a client builds browser-fetchable URLs as `resources_base_url/<resource-id>/bytes` without guessing whether the bytes are plan-owned or task-owned.

Task list, dashboard, and other index-tier surfaces stay bounded — they do **not** embed resource bytes or full resource manifests. Resolve bytes through the task detail projection and the `/bytes` route only.

<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-drift -->

Each `ResolvedTaskResourceSummary.status` is one of `present`, `drift`, `missing`, or `unresolved`. When a task resource is drifted, missing, or unresolved, the detail and bytes routes report the status through the `message` field and the `/bytes` route refuses to stream replacement bytes that differ from the hash recorded at task derivation. The live task detail UI renders the `status` and `message` instead of rewriting the markdown target, and an authoring reference that matches no resolved resource stays visible as raw `./resources/<relative-path>` text with guidance to verify the path or re-derive the task — never a silent substitution.

### Browser Resource URLs Need URL-Level Project Context

<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-browser-project-context -->

In live multi-project mode the daemon resolves which project a request targets from the `X-Kspec-Dir` request header. A `fetch()` from application code can set that header, but a browser `<img src>` or `<a href>` element fetch **cannot send `X-Kspec-Dir`** — the browser controls those request headers, not the page. Without project context, the daemon would resolve the resource against its default project and serve the wrong bytes or a project-not-found response.

To make rendered image and link resource URLs route to the selected project, the web UI appends the selected project's path as a URL-level `kspec_dir` query parameter when rewriting markdown resource references:

```
/api/tasks/<task-ulid>/resources/<resource-id>/bytes?kspec_dir=<url-encoded-project-path>
/api/plans/<plan-ulid>/resources/<resource-id>/bytes?kspec_dir=<url-encoded-project-path>
```

The daemon project-context middleware reads the project path from the `X-Kspec-Dir` header when present and otherwise from the `kspec_dir` query parameter, so element fetches that cannot set headers still resolve to the correct project. The resource still resolves only through the owning entity's manifest, so undeclared paths, absolute paths, parent traversal, and symlink escapes remain rejected regardless of the `kspec_dir` value.

### POST Upload Shape

Both plan and review POST routes accept `multipart/form-data` with the following fields (task resources have no upload route — they are derived from plans):

| Field          | Required | Notes                                                                                                                    |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `file`         | Yes      | The resource file. Missing → `400 missing_resource_file`.                                                                |
| `id`           | Yes      | Resource id. Must match `[a-z0-9][a-z0-9._-]{0,127}`.                                                                    |
| `path`         | Yes      | POSIX-relative path under the entity's `resources/`.                                                                     |
| `label`        | No       | Optional human-friendly label.                                                                                           |
| `description`  | No       | Optional free-form description.                                                                                          |
| `content_type` | No       | Explicit MIME type. Inferred from `path` extension when omitted.                                                         |
| `replace`      | No       | Accepts `"true"`/`"1"` (true) or `"false"`/`"0"` (false). Other values → `400 invalid_replace_value`. Omitted → `false`. |

### Status and Error Mapping

| Status | When                                                                                             | Body shape                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | Successful GET, replace POST, or DELETE                                                          | See route table above                                                                                                                                  |
| `201`  | Successful create POST                                                                           | `{ "resource": ResourceMetadata, "replaced": false }`                                                                                                  |
| `400`  | `invalid_resource_id`, `invalid_resource_path`, `missing_resource_file`, `invalid_replace_value` | `{ "error": code, "code": code, "message": string, "resource_id": string\|null, "path": string\|null }`                                                |
| `404`  | `plan_not_found`, `review_not_found`, `resource_not_found`                                       | Same shape as 400                                                                                                                                      |
| `409`  | `resource_conflict` (id or path collision without `replace`)                                     | Same shape as 400                                                                                                                                      |
| `409`  | `entity_storage_incompatible` (project not on folder-backed storage)                             | `{ "error": "entity_storage_incompatible", "code": <domain-code>, "message": string, "suggestion": string, "domain": string, "cache_domain": string }` |

The `entity_storage_incompatible` envelope is shared across all routes that need folder-backed plan, review, or resource data. See [`entity_storage_incompatible`: project storage format mismatch](../troubleshooting/entity-storage-incompatible.md) for the recovery procedure.

### Response Bytes Header

The `/bytes` route sets:

- `Content-Type` — the resource's stored `content_type`
- `Content-Length` — the resource's stored `bytes`
- `X-Kspec-Resource-Sha256` — the resource's stored `sha256`

Clients can compare `X-Kspec-Resource-Sha256` against a previously-recorded hash to detect drift without parsing the response body.

## Static Export

When the web UI is exported as a static snapshot (`kspec export`), local resource files are copied into the export tree at:

```
<export-root>/assets/resources/plan/<plan-ulid>/<relative-path>
<export-root>/assets/resources/task/<task-ulid>/<relative-path>
<export-root>/assets/resources/review/<review-ulid>/<relative-path>
```

The exported metadata includes an `exported_path` field pointing at the asset location. Markdown content in plan and task exports is rewritten so `./resources/<relative-path>` image and link references point at the exported asset path. The static UI works offline without re-resolving references through the daemon. Only `present` task resources are copied and carry an `exported_path`; drifted, missing, or unresolved task references are not exported as bytes.

JSON-to-stdout and `--dry-run` exports skip the file copy but still emit `exported_path` so consumers can construct the expected path.

## Verification

Confirm the full round-trip works in your project:

```bash
# Attach
kspec plan resource add @plan-my-feature ./README.md \
  --id readme-snapshot \
  --path docs/readme.md

# Confirm it landed
kspec plan resource list @plan-my-feature
kspec plan resource get  @plan-my-feature readme-snapshot --json

# Reference it from a derived task
kspec plan derive @plan-my-feature --dry-run

# Remove it
kspec plan resource remove @plan-my-feature readme-snapshot --force
```

The list output should show the attached resource after `add`, the get output should report a populated `sha256` and accurate `bytes`, and the remove output should report the removed id and path.

## End-to-End Verification in a Temp Project

<!-- AC: @resource-docs-ui-task-markdown-behavior ac-docs-name-temp-project-e2e-steps -->

These steps validate the full resource lifecycle end to end — CLI storage, daemon bytes routes, live UI image and link rendering, selected-project browser URL routing, and static export asset existence — **without restarting or stopping the daemon**. Start the daemon once at step 3 and leave it running for every later step; the live UI and the static export both read from the same running daemon. Adjust paths and refs to your fixtures.

### 1. Create two temp projects and author plan resources

Use two separate projects so you can exercise both ownership cases: one project keeps plan-owned task references (the default), the other derives a materialized task-owned copy.

````bash
# Default-refs project
mkdir -p /tmp/kspec-res-default && cd /tmp/kspec-res-default
git init -q && kspec init

# Author a plan with a sibling resources.yaml + resources/ holding an image and a document
mkdir -p plans/resources/ux plans/resources/docs
cp /path/to/sign-in-v3.png plans/resources/ux/sign-in-v3.png
cp /path/to/spec.pdf         plans/resources/docs/spec.pdf
cat > plans/resources.yaml <<'YAML'
resources:
  - id: ux-mockup
    path: ux/sign-in-v3.png
  - id: spec-doc
    path: docs/spec.pdf
YAML
cat > plans/feature.md <<'MD'
# Sign-in feature

Mockup: ![v3 mockup](./resources/ux/sign-in-v3.png)
Doc: [spec](./resources/docs/spec.pdf)

## Tasks

```yaml
- title: Build sign-in
  slug: task-build-sign-in
  description: |
    Reference image: ![mockup](./resources/ux/sign-in-v3.png)
    Reference doc: [spec](./resources/docs/spec.pdf)
  resource_refs:
    - "./resources/ux/sign-in-v3.png"
    - "./resources/docs/spec.pdf"
````

MD

````

### 2. Import, derive default refs, and derive a materialized copy in a clean project

```bash
# Default-refs project: import + approve + derive (plan-owned refs, no bytes copied)
kspec plan import plans/feature.md
kspec plan approve @plan-sign-in-feature   # use the slug printed by import
kspec plan derive @plan-sign-in-feature

# CLI storage check — task carries resolved resource refs with present status
kspec task get @task-build-sign-in --json | jq '.resolved_resources[] | {id, owner_type, status}'

# Separate clean project: same plan, derived with materialized task-owned copies
mkdir -p /tmp/kspec-res-materialized && cd /tmp/kspec-res-materialized
git init -q && kspec init
cp -r /tmp/kspec-res-default/plans ./plans
kspec plan import plans/feature.md
kspec plan approve @plan-sign-in-feature
kspec plan derive @plan-sign-in-feature --materialize-resources

# Materialized copies live under the task tree with the plan-<id> prefix
kspec task get @task-build-sign-in --json | jq '.resolved_resources[] | {id, owner_type, status}'
ls .kspec/tasks/*/resources/plan/*/ux/sign-in-v3.png
````

For the default-refs project, `owner_type` is `plan`; for the materialized project it is `task` and the ids are prefixed `plan-`. Both report `status: present`.

### 3. Start the daemon once — do not stop or restart it

```bash
cd /tmp/kspec-res-default
kspec serve start
curl -s http://127.0.0.1:3456/api/health    # confirm it is up
```

Leave this daemon running for every step below. The default project is its default project; the materialized project is targeted by URL-level project context (`kspec_dir`), so you never need to restart the daemon to switch projects.

### 4. Verify daemon bytes routes for plan-owned and task-owned resources

Read the task-scoped projection, then fetch bytes from the task resource route. Use the `kspec_dir` query parameter to target the materialized project through the same running daemon.

```bash
DEFAULT_DIR=/tmp/kspec-res-default
MAT_DIR=/tmp/kspec-res-materialized

# Plan-owned (default project) — resolve base URL + ids from task detail
curl -s "http://127.0.0.1:3456/api/tasks/@task-build-sign-in/resources" \
  -H "X-Kspec-Dir: $DEFAULT_DIR" | jq '.resources[] | {id, owner_type, status}'

# Fetch plan-owned bytes; -D - prints the X-Kspec-Resource-Sha256 header
curl -s -D - -o /tmp/img.png \
  "http://127.0.0.1:3456/api/tasks/@task-build-sign-in/resources/ux-mockup/bytes" \
  -H "X-Kspec-Dir: $DEFAULT_DIR" | grep -i x-kspec-resource-sha256

# Task-owned copy (materialized project) targeted via kspec_dir query param — no daemon restart
curl -s -o /tmp/img-mat.png \
  "http://127.0.0.1:3456/api/tasks/@task-build-sign-in/resources/plan-ux-mockup/bytes?kspec_dir=$MAT_DIR"
```

Both fetches return the recorded bytes with `Content-Type`, `Content-Length`, and `X-Kspec-Resource-Sha256` matching the resource recorded at derivation. A drifted, missing, or unresolved reference reports its status instead of streaming replacement bytes.

### 5. Verify live UI image/link rendering and selected-project browser routing

With the daemon still running, open the web UI (dev server on port 5173, or the daemon-served UI) and:

- Open the **default project's** task `task-build-sign-in` in the task detail modal. The `./resources/...` image renders and the document link opens — the UI rewrote them to `/api/tasks/<task-ulid>/resources/<id>/bytes` URLs.
- Select the **materialized project** in the project switcher and open its task. The same references render from the task-owned copies. Because `<img>` and `<a>` element fetches cannot send `X-Kspec-Dir`, the rendered URLs carry `?kspec_dir=<project-path>` so they route to the selected project through the same daemon — confirm by inspecting an image URL in the browser devtools network panel.

### 6. Verify static export asset existence — same daemon, no restart

```bash
# Export each project to a static snapshot
cd /tmp/kspec-res-default && kspec export --out /tmp/export-default
cd /tmp/kspec-res-materialized && kspec export --out /tmp/export-materialized

# Plan-owned task asset is copied under the task asset path
ls /tmp/export-default/assets/resources/task/*/ux/sign-in-v3.png
ls /tmp/export-default/assets/resources/task/*/docs/spec.pdf

# Materialized task asset also exists under the task asset path
ls /tmp/export-materialized/assets/resources/task/*/ux/sign-in-v3.png

# Plan resources are copied under the plan asset path
ls /tmp/export-default/assets/resources/plan/*/ux/sign-in-v3.png
```

Each `ls` should list the advertised asset file. The exported plan and task markdown is rewritten to point at these `assets/resources/...` paths, so the offline snapshot renders the same images and links without the daemon.

When you finish, you may stop the daemon — but every verification above was performed against a single continuously-running daemon.

## Next Steps

- [Importing and Approving a Plan](./importing-and-approving-a-plan.md) — full plan workflow including resource-aware import and `--materialize-resources` derivation
- [Local Resources for Plans and Reviews](../concepts/local-resources.md) — the model behind the commands and routes
- [`entity_storage_incompatible`: project storage format mismatch](../troubleshooting/entity-storage-incompatible.md) — fix when resource commands fail on an unmigrated project
- [Plan or Review Index Has Drifted From Folder Contents](../troubleshooting/plan-or-review-index-drift.md) — fix when the project-wide index disagrees with on-disk folders
