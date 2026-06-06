# Resource UI Hardening Plan

## Goal

Close the resource lifecycle holes found by temp-project end-to-end validation: plan resources must render in the live multi-project UI, task descriptions must resolve `./resources/...` markdown for both plan-owned references and materialized task-owned copies, review resources must stay covered as the working comparator, and static export must copy the actual resource assets it advertises.

## Background

The existing resource model stores plan/review resources as folder-backed sidecars, derives structured `resource_refs` onto tasks, and can materialize copies with `kspec plan derive --materialize-resources`. The validation found these holes:

- Live plan markdown can build browser resource URLs without selected-project context. The same daemon bytes endpoint works when `kspec_dir` is present, but `<img>` and `<a>` fetches cannot send `X-Kspec-Dir`.
- Task detail responses do not expose resolved task resources or a task-scoped bytes URL contract, so task-description markdown renders `./resources/...` as literal browser paths and 404s.
- Materialized task resources are copied to the task resource tree and task refs point at task-owned copies, but the live UI has no browser-accessible task resource route to render those copies from task markdown.
- Static export must be proven to copy plan, task, and review resource files to the asset paths advertised by snapshot metadata and rewritten markdown.

## Specs

```yaml
- title: Live Plan Resource URLs Preserve Project Context
  slug: live-plan-resource-url-project-context
  type: requirement
  parent: "@web-ui"
  description: |
    Browser-rendered plan resource URLs carry selected-project context in live multi-project mode because image and link elements cannot send `X-Kspec-Dir` headers.
  acceptance_criteria:
    - id: ac-plan-image-routes-to-selected-project
      given: |
        the daemon has multiple projects registered, the web UI has a non-default project selected, and a plan markdown image references a declared resource with `./resources/<relative-path>`
      when: |
        the browser fetches the rendered image URL from the plan detail view
      then: |
        the request returns that selected project's declared plan resource bytes instead of the daemon default project's bytes or a project-not-found response
    - id: ac-plan-doc-link-routes-to-selected-project
      given: |
        the daemon has multiple projects registered, the web UI has a non-default project selected, and a plan markdown document link references a declared resource with `./resources/<relative-path>`
      when: |
        the browser opens the rendered document link from the plan detail view
      then: |
        the request returns that selected project's declared plan resource bytes instead of the daemon default project's bytes or a project-not-found response
    - id: ac-plan-resource-url-still-uses-plan-manifest
      given: |
        a rendered live plan resource URL includes selected-project routing context
      when: |
        the daemon resolves the resource request
      then: |
        the request still resolves only through the owning plan's resource manifest and rejects undeclared paths, absolute paths, parent traversal paths, and symlink escapes

- title: Task Resource Resolution API Contract
  slug: task-resource-resolution-api-contract
  type: requirement
  parent: "@api-contract"
  description: |
    Task detail APIs expose a bounded resolved-resource projection and task-scoped bytes routes for the task's versioned `resource_refs` without embedding resource bytes in task indexes.
  acceptance_criteria:
    - id: ac-task-detail-exposes-resolved-resources
      given: |
        a task has one or more derived resource references
      when: |
        the task is read through the daemon task detail API
      then: |
        the response includes `resolved_resources`, where each entry reports owner type, owner ref, resource id, relative path, content type, byte size, recorded content hash, current content hash when available, drift status, and a human-readable status message
    - id: ac-task-detail-exposes-resource-base-url
      given: |
        a task detail response includes one or more `resolved_resources`
      when: |
        a client needs browser-fetchable bytes for a resolved task resource
      then: |
        the response includes a task-scoped `resources_base_url` so clients construct `resources_base_url/<resource-id>/bytes` without guessing whether the bytes are plan-owned or task-owned
    - id: ac-task-resource-index-stays-bounded
      given: |
        tasks with resource references exist in the project
      when: |
        task list, dashboard, cache warm-up, or other index-tier surfaces are read
      then: |
        those surfaces do not embed resource bytes or unbounded resource manifests
    - id: ac-task-resource-bytes-serve-present-plan-owned-ref
      given: |
        a task resource reference is plan-owned and its current plan resource hash matches the hash recorded at task derivation
      when: |
        `GET /api/tasks/:ref/resources/:resourceId/bytes` is requested for that resource
      then: |
        the route returns the referenced plan resource bytes with content type, content length, and `X-Kspec-Resource-Sha256` matching the current declared resource
    - id: ac-task-resource-bytes-serve-present-task-owned-copy
      given: |
        a task resource reference is task-owned because the task was derived with explicit resource materialization
      when: |
        `GET /api/tasks/:ref/resources/:resourceId/bytes` is requested for that resource
      then: |
        the route returns the copied task-owned resource bytes with content type, content length, and `X-Kspec-Resource-Sha256` matching the task-owned manifest entry
    - id: ac-task-resource-bytes-refuse-drifted-or-missing-ref
      given: |
        a task resource reference is drifted, missing, or unresolved
      when: |
        a task resource detail route or task resource bytes route is requested for that resource
      then: |
        the response reports the exact status and does not stream replacement bytes that differ from the hash recorded at task derivation

- title: Live Task Resource Markdown Rendering
  slug: live-task-resource-markdown-rendering
  type: requirement
  parent: "@ui-task-board"
  description: |
    The task detail UI rewrites `./resources/<relative-path>` references in task descriptions through the task API's resolved resource projection for both default plan-owned refs and explicit materialized task-owned copies.
  acceptance_criteria:
    - id: ac-plan-owned-task-image-renders
      given: |
        a derived task description contains a markdown image target using `./resources/<relative-path>` and the matching task resource is a non-drifted plan-owned reference
      when: |
        the task detail modal renders in the live web UI
      then: |
        the image target is rewritten to the task-scoped resource bytes URL and the browser displays the recorded plan resource image
    - id: ac-plan-owned-task-doc-link-opens
      given: |
        a derived task description contains a markdown document link using `./resources/<relative-path>` and the matching task resource is a non-drifted plan-owned reference
      when: |
        the user opens the link from the live task detail modal
      then: |
        the browser receives the recorded plan resource document bytes from the selected project
    - id: ac-materialized-task-image-renders
      given: |
        a task was derived with `--materialize-resources` and its description contains a markdown image target using `./resources/<relative-path>` for a copied resource
      when: |
        the task detail modal renders in the live web UI
      then: |
        the image target is rewritten to the task-scoped resource bytes URL and the browser displays the copied task-owned image
    - id: ac-materialized-task-doc-link-opens
      given: |
        a task was derived with `--materialize-resources` and its description contains a markdown document link using `./resources/<relative-path>` for a copied resource
      when: |
        the user opens the link from the live task detail modal
      then: |
        the browser receives the copied task-owned document bytes from the selected project
    - id: ac-drifted-task-resource-is-visible-not-silent
      given: |
        a task description references a resource whose resolved task resource status is drift, missing, or unresolved
      when: |
        the task detail modal renders
      then: |
        the UI shows the resource status message and does not rewrite the markdown target to a URL that silently serves different bytes
    - id: ac-unmatched-task-resource-reference-stays-raw
      given: |
        a task description references `./resources/<relative-path>` and the task has no matching resolved resource path
      when: |
        the task detail modal renders
      then: |
        the unresolved authoring reference remains visible and the UI shows actionable guidance rather than rewriting it to `/resources/<relative-path>` or an unrelated entity URL

- title: Live Review Resource URLs Preserve Project Context
  slug: live-review-resource-url-project-context
  type: requirement
  parent: "@review-records-web-ui"
  description: |
    Review resource cards continue to provide the working browser URL comparator for local resources in live multi-project mode.
  acceptance_criteria:
    - id: ac-review-image-routes-to-selected-project
      given: |
        the daemon has multiple projects registered, the web UI has a non-default project selected, and a review has a declared image resource
      when: |
        the browser fetches the rendered review image preview URL
      then: |
        the request returns that selected project's review image bytes instead of the daemon default project's bytes or a project-not-found response
    - id: ac-review-doc-link-routes-to-selected-project
      given: |
        the daemon has multiple projects registered, the web UI has a non-default project selected, and a review has a declared document resource
      when: |
        the browser opens the rendered review document link
      then: |
        the request returns that selected project's review document bytes instead of the daemon default project's bytes or a project-not-found response

- title: Static Export Resource Assets Are Complete
  slug: static-export-resource-assets-complete
  type: requirement
  parent: "@gh-pages-export"
  description: |
    Static export copies every resource asset that snapshot metadata and rewritten markdown advertise for plans, tasks, and reviews.
  acceptance_criteria:
    - id: ac-static-plan-image-asset-exists
      given: |
        a static export includes a plan with a declared image resource referenced from plan markdown
      when: |
        the export is written to an output directory
      then: |
        the rewritten plan image URL points to an asset that exists on disk under `assets/resources/plan/<plan-ulid>/<relative-path>`
    - id: ac-static-plan-doc-asset-exists
      given: |
        a static export includes a plan with a declared document resource referenced from plan markdown
      when: |
        the export is written to an output directory
      then: |
        the rewritten plan document link points to an asset that exists on disk under `assets/resources/plan/<plan-ulid>/<relative-path>`
    - id: ac-static-task-plan-owned-asset-uses-recorded-hash
      given: |
        a static export includes a task description that references a non-drifted plan-owned resource through `./resources/<relative-path>`
      when: |
        the export is written to an output directory
      then: |
        the rewritten task resource URL points to an asset whose bytes match the task's recorded resource hash
    - id: ac-static-task-materialized-asset-exists
      given: |
        a static export includes a task description that references a materialized task-owned resource through `./resources/<relative-path>`
      when: |
        the export is written to an output directory
      then: |
        the rewritten task resource URL points to a copied task asset that exists on disk and matches the task-owned manifest hash
    - id: ac-static-task-drift-is-visible-not-rewritten
      given: |
        a static export includes a task description that references a drifted, missing, or unresolved task resource
      when: |
        the export is written
      then: |
        the task snapshot exposes the drift status, the markdown target is not rewritten to current replacement bytes, and no asset path is advertised for bytes that do not match the task's recorded resource hash
    - id: ac-static-review-image-asset-exists
      given: |
        a static export includes a review with a declared image resource
      when: |
        the export is written to an output directory
      then: |
        the review image URL points to an asset that exists on disk under `assets/resources/review/<review-ulid>/<relative-path>`
    - id: ac-static-review-doc-asset-exists
      given: |
        a static export includes a review with a declared document resource
      when: |
        the export is written to an output directory
      then: |
        the review document link points to an asset that exists on disk under `assets/resources/review/<review-ulid>/<relative-path>`

- title: Resource Documentation Covers UI and Task Markdown Behavior
  slug: resource-docs-ui-task-markdown-behavior
  type: requirement
  parent: "@folder-backed-resource-documentation-1"
  description: |
    User-facing documentation describes live UI routing, task markdown resolution, drift, and static export behavior for local resources.
  acceptance_criteria:
    - id: ac-docs-name-task-resource-markdown
      given: |
        a user reads the local resources concept page, guide, or release notes
      when: |
        the documentation describes task resource references
      then: |
        it states how task descriptions may reference resources with `./resources/<relative-path>` and how plan-owned and task-owned copies are resolved
    - id: ac-docs-name-task-resource-drift
      given: |
        a user reads the local resources concept page, guide, or troubleshooting material
      when: |
        the documentation describes task resource references
      then: |
        it states that drifted, missing, or unresolved task resources are surfaced as status messages instead of silently serving replacement bytes
    - id: ac-docs-name-browser-project-context
      given: |
        a user reads the local resources guide or troubleshooting material
      when: |
        the documentation describes live web UI resource rendering in multi-project mode
      then: |
        it states that browser image and link resource URLs need URL-level selected-project context because element fetches cannot send `X-Kspec-Dir`
    - id: ac-docs-name-temp-project-e2e-steps
      given: |
        a developer needs to verify resource behavior end to end
      when: |
        they read the resource guide or troubleshooting material
      then: |
        they can follow exact temp-project steps that validate CLI storage, daemon bytes routes, live UI image/link rendering, selected-project browser URL routing, and static export asset existence without restarting or stopping the daemon
```

## Tasks

derive_from_specs: false

```yaml
- title: Add resource URL and task markdown contract tests
  slug: add-resource-url-task-markdown-contract-tests
  description: |
    Covers:
    - @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
    - @live-plan-resource-url-project-context ac-plan-doc-link-routes-to-selected-project
    - @live-review-resource-url-project-context ac-review-image-routes-to-selected-project
    - @live-review-resource-url-project-context ac-review-doc-link-routes-to-selected-project
    - @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
    - @live-task-resource-markdown-rendering ac-plan-owned-task-doc-link-opens
    - @live-task-resource-markdown-rendering ac-materialized-task-image-renders
    - @live-task-resource-markdown-rendering ac-materialized-task-doc-link-opens
    - @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw

    Add failing tests before implementation. Cover the exact holes from the temp-project validation:
    - Plan resource markdown rewriting in live multi-project mode must produce URLs that a browser can fetch without `X-Kspec-Dir` and that preserve selected-project routing context.
    - Task description markdown `./resources/<path>` must rewrite through task resolved resources for default plan-owned resources.
    - Task description markdown `./resources/<path>` must rewrite through task resolved resources for `--materialize-resources` task-owned copies.
    - Unmatched task description resource references must remain visible and must not be rewritten to `/resources/...`.
    - Review resource URL tests remain as the passing comparator for selected-project browser URL routing.

    Files to inspect and extend include `tests/web-ui/plan-resource-links.test.ts`, `packages/web-ui/src/lib/utils/plan-resource-links.ts`, `packages/web-ui/src/lib/api.ts`, and existing task modal tests if present. If there is no task markdown utility test file, create one under `tests/web-ui/` and import the web UI utility directly. Assert rendered URLs, owner/status metadata, and HTTP outcomes; do not assert implementation-only class names.
  priority: 1
  tags:
    - resources
    - tests
    - web-ui
  spec_ref: "@live-task-resource-markdown-rendering"

- title: Expose task resolved resources through shared API and daemon task detail
  slug: expose-task-resolved-resources-api
  description: |
    Covers:
    - @task-resource-resolution-api-contract ac-task-detail-exposes-resolved-resources
    - @task-resource-resolution-api-contract ac-task-detail-exposes-resource-base-url
    - @task-resource-resolution-api-contract ac-task-resource-index-stays-bounded

    Extend the task resource API contract so task detail consumers have enough data to resolve task markdown safely:
    - Add shared TypeScript types for the projected resolved task resource shape named `ResolvedTaskResourceSummary` or an equally explicit name. The task detail field name must be `resolved_resources`.
    - Extend `TaskDetail` to include `resolved_resources?: ResolvedTaskResourceSummary[]` and `resources_base_url?: string` for detail responses. Do not add resource bytes to task list or dashboard response shapes.
    - Update `packages/daemon/src/routes/tasks.ts` to call the existing task resource resolver for task detail responses and populate the new fields on cache hits and disk fallback paths.
    - Preserve existing `kspec task get --json` and agent-context drift semantics by reusing `resolveTaskResources` and `projectResolvedTaskResources` rather than duplicating drift logic.

    Verification: run focused shared type tests and daemon task route tests, then run `kspec validate --warnings-ok` to ensure new AC annotations resolve.
  priority: 1
  tags:
    - resources
    - api
    - daemon
  spec_ref: "@task-resource-resolution-api-contract"
  depends_on:
    - "@add-resource-url-task-markdown-contract-tests"

- title: Add task resource bytes routes with drift-safe behavior
  slug: add-task-resource-bytes-routes
  description: |
    Covers:
    - @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-plan-owned-ref
    - @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-task-owned-copy
    - @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
    - @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent

    Add daemon routes rooted at `/api/tasks/:ref/resources` so browsers and static/live UI code resolve task resources through the task's versioned refs:
    - `GET /api/tasks/:ref/resources` returns the task detail `resolved_resources` projection.
    - `GET /api/tasks/:ref/resources/:resourceId` returns one resolved resource projection or a structured 404 when the task has no matching resource id.
    - `GET /api/tasks/:ref/resources/:resourceId/bytes` serves bytes only when the resolved resource status is `present`; it sets `Content-Type`, `Content-Length`, and `X-Kspec-Resource-Sha256` from the current matching resource.
    - For `drift`, `missing`, or `unresolved`, return a structured non-2xx response that names the status and does not stream bytes.
    - Resolve plan-owned refs through the source plan manifest and task-owned refs through the current task's resource manifest. Use the existing resource resolver and manifest helpers; do not raw-join user-authored paths.
    - Binary browser URLs in live multi-project mode must include selected-project context just like review resource URLs.

    Verification: add daemon API tests for present plan-owned bytes, present materialized task-owned bytes, drift refusal, missing-resource refusal, and selected-project routing.
  priority: 1
  tags:
    - resources
    - api
    - daemon
  spec_ref: "@task-resource-resolution-api-contract"
  depends_on:
    - "@expose-task-resolved-resources-api"

- title: Generalize live UI resource markdown rewriting for plans and tasks
  slug: generalize-live-ui-resource-markdown-rewriting
  description: |
    Covers:
    - @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
    - @live-plan-resource-url-project-context ac-plan-doc-link-routes-to-selected-project
    - @live-plan-resource-url-project-context ac-plan-resource-url-still-uses-plan-manifest
    - @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
    - @live-task-resource-markdown-rendering ac-plan-owned-task-doc-link-opens
    - @live-task-resource-markdown-rendering ac-materialized-task-image-renders
    - @live-task-resource-markdown-rendering ac-materialized-task-doc-link-opens
    - @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent
    - @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw

    Update the web UI resource-link utilities and task detail rendering:
    - Replace the plan-only URL construction assumption with a reusable resource markdown rewrite helper that accepts entity resource metadata and an entity-scoped `resources_base_url`.
    - Ensure live plan resource URLs append selected-project context for browser-fetchable URLs. Do not rely on `X-Kspec-Dir` for `<img>` or `<a>` resource loads.
    - In the task detail modal, rewrite `task.description` before passing it to the markdown renderer using `task.resolved_resources` and `task.resources_base_url`.
    - Render a compact task resources/status section when task resources exist so drift/missing/unresolved states are visible even if an image cannot load.
    - Keep review resource rendering behavior intact and covered by existing tests.

    Verification: run web UI unit tests for plan resource links, task resource links, review resource cards, and the task modal. Build or typecheck the web UI with the project's standard command.
  priority: 1
  tags:
    - resources
    - web-ui
  spec_ref: "@live-task-resource-markdown-rendering"
  depends_on:
    - "@add-task-resource-bytes-routes"

- title: Make static export copy and rewrite all advertised resource assets
  slug: make-static-export-copy-rewrite-all-resource-assets
  description: |
    Covers:
    - @static-export-resource-assets-complete ac-static-plan-image-asset-exists
    - @static-export-resource-assets-complete ac-static-plan-doc-asset-exists
    - @static-export-resource-assets-complete ac-static-task-plan-owned-asset-uses-recorded-hash
    - @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
    - @static-export-resource-assets-complete ac-static-task-drift-is-visible-not-rewritten
    - @static-export-resource-assets-complete ac-static-review-image-asset-exists
    - @static-export-resource-assets-complete ac-static-review-doc-asset-exists

    Harden static export so every resource path advertised by snapshot metadata or rewritten markdown exists on disk:
    - Verify and, if needed, fix plan resource asset copying for `generateJsonSnapshot({ assetsOutputDir })` and the CLI/static export path. Disk files must exist under `assets/resources/plan/<plan-ulid>/<relative-path>` for exported plan resources.
    - Add task resource export support for task descriptions that reference `./resources/<path>`. For non-drifted plan-owned task refs, reuse or copy bytes whose hash matches the task's recorded hash. For materialized task-owned refs, copy from the task resource tree to a deterministic task asset path and rewrite task markdown to that path.
    - For drifted, missing, or unresolved task refs, expose status in the task snapshot, leave the authoring reference visible or otherwise show the status, and do not advertise an asset path for bytes that do not match the task's recorded resource hash.
    - Keep review resource copying and URL encoding behavior intact, including paths containing characters such as `#`, `?`, and spaces.
    - Add tests that assert actual files exist on disk for plan, task, and review resources, not only that snapshot JSON contains `exported_path` strings.

    Verification: run `tests/export/plan-resources.test.ts`, `tests/review-resource-static-export.test.ts`, the new task static export tests, and an export CLI smoke test in a temp project.
  priority: 2
  tags:
    - resources
    - export
  spec_ref: "@static-export-resource-assets-complete"
  depends_on:
    - "@generalize-live-ui-resource-markdown-rewriting"

- title: Update resource documentation and release notes
  slug: update-resource-documentation-ui-task-markdown
  description: |
    Covers:
    - @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-markdown
    - @resource-docs-ui-task-markdown-behavior ac-docs-name-task-resource-drift
    - @resource-docs-ui-task-markdown-behavior ac-docs-name-browser-project-context
    - @resource-docs-ui-task-markdown-behavior ac-docs-name-temp-project-e2e-steps

    Update the docs so future users and reviewers know the exact intended behavior:
    - `docs/concepts/local-resources.md` must describe task-description markdown resolution through task resolved resources, both plan-owned and materialized task-owned cases, drift behavior, and static export behavior.
    - `docs/guides/working-with-local-resources.md` must include exact commands for a temp project that imports plan resources, derives default refs, derives materialized copies in a separate clean project, opens the UI without restarting/stopping the daemon, verifies browser image/doc links, and verifies static export file existence.
    - Troubleshooting or guide text must explicitly call out that browser image/link resource URLs need URL-level selected-project context in live multi-project mode because headers are unavailable for element fetches.
    - Release notes must call out the fixed UI/static behavior without claiming unsupported task-owned resource upload commands unless those are implemented in this plan.

    Verification: run docs/resource tests if present, grep AC annotations for the new documentation spec, and run `kspec validate --warnings-ok`.
  priority: 2
  tags:
    - resources
    - docs
  spec_ref: "@resource-docs-ui-task-markdown-behavior"
  depends_on:
    - "@make-static-export-copy-rewrite-all-resource-assets"

- title: Validate resource lifecycle end to end in temp projects
  slug: validate-resource-lifecycle-e2e-temp-projects
  description: |
    Covers:
    - @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
    - @live-plan-resource-url-project-context ac-plan-doc-link-routes-to-selected-project
    - @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-plan-owned-ref
    - @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-task-owned-copy
    - @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
    - @live-task-resource-markdown-rendering ac-plan-owned-task-doc-link-opens
    - @live-task-resource-markdown-rendering ac-materialized-task-image-renders
    - @live-task-resource-markdown-rendering ac-materialized-task-doc-link-opens
    - @live-review-resource-url-project-context ac-review-image-routes-to-selected-project
    - @live-review-resource-url-project-context ac-review-doc-link-routes-to-selected-project
    - @static-export-resource-assets-complete ac-static-plan-image-asset-exists
    - @static-export-resource-assets-complete ac-static-plan-doc-asset-exists
    - @static-export-resource-assets-complete ac-static-task-plan-owned-asset-uses-recorded-hash
    - @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
    - @static-export-resource-assets-complete ac-static-review-image-asset-exists
    - @static-export-resource-assets-complete ac-static-review-doc-asset-exists

    Run the final proof without restarting or stopping the daemon:
    - Create fresh temp kspec projects with image and document fixtures declared in `resources.yaml` beside the plan markdown.
    - Import the plan, derive one project with default plan-owned task resource refs, and derive a second clean project with `--materialize-resources`.
    - Add a review with image and document resources.
    - Register temp projects through the existing daemon project API or rely on selected-project context; do not stop or restart the daemon.
    - Verify CLI storage and `kspec task get` statuses, daemon bytes routes for plan/task/review resources, live UI plan markdown rendering, live UI task modal markdown rendering for default and materialized cases, live UI review resource rendering, and static export asset existence.
    - Capture browser screenshots showing rendered plan image/doc link, task image/doc link in both default and materialized cases, review resource cards, and static export/offline link behavior where practical.

    Verification: attach the temp project paths, command outputs, HTTP status summary, and screenshot paths to the task notes or final review.
  priority: 2
  tags:
    - resources
    - e2e
    - web-ui
  spec_ref: "@live-plan-resource-url-project-context"
  depends_on:
    - "@update-resource-documentation-ui-task-markdown"
```

## Implementation Notes

- Do not restart or stop the daemon during validation. Use `KSPEC_NO_DAEMON=1` only for CLI operations that should bypass incidental daemon communication, and use the existing project registration API for temp-project UI checks.
- Keep task resources read-only in this plan. The plan adds task resource read/detail/bytes behavior for derived refs and materialized copies; it does not add general `kspec task resource add/remove` authoring commands.
- Keep `ResourceMetadata` byte-free and URL-free. Browser-safe fetch URLs belong in entity-scoped base URL fields or client URL helpers, not inside each resource metadata object.
- The task detail projection field is `resolved_resources`; do not use `resource_refs` for the resolved API/UI projection because raw task schema already uses that name for stored refs.
- When a task resource is drifted, do not render changed bytes as if they were the recorded resource. Show drift and require an explicit re-derive or resource update workflow outside this plan.
- Prefer reusable resource link helpers over a second plan-only regex. The existing `./resources/...` authoring syntax and path validation rules must stay consistent between parser-side extraction and UI-side rewriting.
- Add tests before fixes where possible. The first task should fail on the currently observed behavior: browser URL missing selected-project routing context and task markdown emitting literal `/resources/...` links.
