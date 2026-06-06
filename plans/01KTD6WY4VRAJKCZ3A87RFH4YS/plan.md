# Resource UI Hardening Plan

## Goal

Close the resource lifecycle holes found by the temp-project end-to-end validation: plan resources must render in the live multi-project UI, task descriptions must resolve `./resources/...` markdown for both plan-owned references and materialized task-owned copies, review resources must stay covered by regression tests, and static export must copy the actual resource assets it advertises.

## Background

The resource model already stores plan/review resources as folder-backed sidecars, derives structured `resource_refs` onto tasks, and can materialize copies with `kspec plan derive --materialize-resources`. The temp-project validation found these gaps:

- Live plan markdown resource URLs can omit project context for browser-initiated `<img>` and `<a>` loads in multi-project mode. The same bytes endpoint succeeds when the selected project is supplied through `kspec_dir`, but browser loads cannot use the normal `X-Kspec-Dir` header.
- Task detail responses do not expose task resource references or a task-scoped resource bytes URL contract to the web UI, so task-description markdown renders `./resources/...` as literal `/resources/...` browser paths and 404s.
- Materialized task resources are copied to the task resource tree and task refs point at task-owned copies, but the live UI has no browser-accessible task resource route to render those copies from task markdown.
- Static export advertises resource asset paths in snapshot data; the implementation must be proven to copy plan, task, and review assets to those paths on disk, not just report metadata.

## Specs

```yaml
- title: Browser Resource URLs Preserve Project Context
  slug: browser-resource-url-project-context
  type: requirement
  parent: "@trait-entity-scoped-local-resources-1"
  description: |
    Browser-rendered resource URLs for plan, task, and review resources carry the selected project context in live multi-project mode because image and link elements cannot send `X-Kspec-Dir` headers.
  acceptance_criteria:
    - id: ac-live-browser-url-routes-to-selected-project
      given: |
        the daemon has more than one project registered and the web UI has a non-default project selected
      when: |
        a plan, task, or review resource is rendered as an image source or document link in the browser
      then: |
        the browser-issued request is routed to the selected project and returns that selected project's declared resource bytes rather than the daemon default project's bytes or a project-not-found response
    - id: ac-browser-url-preserves-resource-boundary
      given: |
        a browser-rendered resource URL contains project-routing context
      when: |
        the daemon resolves the request
      then: |
        the request still resolves only through the owning entity's resource manifest and cannot read undeclared paths, absolute paths, parent traversal paths, or symlink escapes
    - id: ac-static-mode-does-not-include-live-project-query
      given: |
        the web UI is reading a static export snapshot instead of a live daemon project
      when: |
        a plan, task, or review resource is rendered as an image source or document link
      then: |
        the rendered URL points at the snapshot asset path and does not include a live `kspec_dir` query parameter

- title: Task Resource Markdown Resolution
  slug: task-resource-markdown-resolution
  type: requirement
  parent: "@plan-resource-derivation-semantics-1"
  description: |
    Task detail surfaces resolve `./resources/<relative-path>` references in task descriptions through the task's versioned `resource_refs`, including both default plan-owned references and explicit materialized task-owned copies.
  acceptance_criteria:
    - id: ac-task-detail-exposes-resource-resolution
      given: |
        a task has one or more derived resource references
      when: |
        the task is read through the daemon task detail API, static snapshot data, CLI JSON output, or agent context
      then: |
        the consumer can see each resource's owner type, owner ref, resource id, relative path, content type, byte size, recorded content hash, current content hash when available, drift status, and human-readable status message without embedding resource bytes in the task index
    - id: ac-plan-owned-task-markdown-renders
      given: |
        a derived task description contains markdown image or link targets using `./resources/<relative-path>` and the matching task resource reference is plan-owned and not drifted
      when: |
        the task detail is opened in the live web UI
      then: |
        those markdown targets are rewritten to task-scoped browser-safe resource URLs that return the exact plan resource bytes recorded for the task
    - id: ac-materialized-task-markdown-renders
      given: |
        a task was derived with explicit resource materialization and its description contains markdown image or link targets using `./resources/<relative-path>`
      when: |
        the task detail is opened in the live web UI
      then: |
        those markdown targets are rewritten to task-scoped browser-safe resource URLs that return the copied task-owned resource bytes
    - id: ac-task-resource-drift-is-not-silent
      given: |
        a task resource reference no longer matches the current bytes in its owning resource manifest
      when: |
        task detail, task markdown rendering, a task resource bytes route, or agent context presents that resource
      then: |
        the consumer sees a drift or missing-resource status instead of silently receiving bytes that differ from the hash recorded at task derivation time
    - id: ac-unresolved-task-markdown-stays-visible
      given: |
        a task description references `./resources/<relative-path>` but the task has no matching resource reference for that path
      when: |
        the task detail is rendered
      then: |
        the unresolved authoring reference remains visible and the UI shows actionable guidance rather than rewriting it to an unrelated URL

- title: Static Export Resource Assets Are Complete
  slug: static-export-resource-assets-complete
  type: requirement
  parent: "@trait-entity-scoped-local-resources-1"
  description: |
    Static export copies every resource asset that snapshot metadata and rewritten markdown advertise, including plan resources, task-accessible resources, and review resources.
  acceptance_criteria:
    - id: ac-plan-assets-exist-on-disk
      given: |
        a static export includes a plan with declared image and document resources referenced from plan markdown
      when: |
        the export is written to an output directory
      then: |
        each exported plan resource path in the snapshot exists on disk under `assets/resources/plan/<plan-ulid>/<relative-path>` and the plan markdown points at that copied path
    - id: ac-task-assets-exist-on-disk
      given: |
        a static export includes a task whose description references derived resources through `./resources/<relative-path>`
      when: |
        the export is written to an output directory
      then: |
        each exported task resource URL points at an asset path that exists on disk and corresponds to the task's recorded resource owner and hash status
    - id: ac-review-assets-exist-on-disk
      given: |
        a static export includes a review with declared image and document resources
      when: |
        the export is written to an output directory
      then: |
        each exported review resource path in the snapshot exists on disk under `assets/resources/review/<review-ulid>/<relative-path>` and the static UI can open those assets offline

- title: Resource Documentation Covers UI and Task Markdown Behavior
  slug: resource-docs-ui-task-markdown-behavior
  type: requirement
  parent: "@folder-backed-resource-documentation-1"
  description: |
    User-facing documentation describes the live UI, task markdown, drift, and static export behavior for local resources without implying that only plan and review detail pages can render resource links.
  acceptance_criteria:
    - id: ac-docs-name-task-resource-surfaces
      given: |
        a user reads the local resources concept page, guide, command help, or release notes
      when: |
        the documentation describes task resource references and materialized copies
      then: |
        it states how task descriptions may reference resources with `./resources/<relative-path>`, how plan-owned and task-owned copies are resolved, and how drift is surfaced
    - id: ac-docs-name-browser-and-export-verification
      given: |
        a developer needs to verify resource behavior end to end
      when: |
        they read the resource guide or troubleshooting material
      then: |
        they can follow exact temp-project steps that validate CLI storage, daemon bytes routes, live UI image/link rendering, selected-project browser URL routing, and static export asset existence without restarting or stopping the daemon
```

## Tasks

```yaml
- title: Add resource URL and task markdown contract tests
  slug: add-resource-url-task-markdown-contract-tests
  description: |
    Add failing tests before implementation. Cover the exact holes from the temp-project validation:
    - Plan resource markdown rewriting in live multi-project mode must produce URLs that a browser can fetch without `X-Kspec-Dir` and that preserve selected-project routing context.
    - Task description markdown `./resources/<path>` must rewrite through task resource refs for default plan-owned resources.
    - Task description markdown `./resources/<path>` must rewrite through task resource refs for `--materialize-resources` task-owned copies.
    - Unmatched task description resource references must remain visible and must not be rewritten to `/resources/...`.
    - Review resource URL tests must remain as the passing comparator for selected-project browser URL routing.
    Files to inspect and extend include `tests/web-ui/plan-resource-links.test.ts`, `packages/web-ui/src/lib/utils/plan-resource-links.ts`, `packages/web-ui/src/lib/api.ts`, and existing task modal tests if present. If there is no task markdown utility test file, create one under `tests/web-ui/` and import the web UI utility directly. Do not encode implementation-specific class names in AC assertions; assert rendered URLs, owner/status metadata, and HTTP outcomes.
  priority: 1
  tags:
    - resources
    - tests
    - web-ui
  spec_ref: "@browser-resource-url-project-context"

- title: Expose task resource resolution through shared API and daemon task detail
  slug: expose-task-resource-resolution-api
  description: |
    Extend the task resource API contract so task detail consumers have enough data to resolve task markdown safely:
    - Add shared TypeScript types for the projected resolved task resource shape. Include owner_type, owner_ref, id, path, content_type, bytes, recorded_sha256, current_sha256, recorded_git_commit, current_git_commit, status, and message. Keep resource bytes out of task list/index responses.
    - Extend `TaskDetail` to include a bounded `resource_refs` or `resources` projection and a task-scoped `resources_base_url` for detail responses when resources are present. Use one field name consistently across daemon, static, and UI code; document the chosen name in comments.
    - Update `packages/daemon/src/routes/tasks.ts` to call the existing task resource resolver for task detail responses and populate the new fields on cache hits and disk fallback paths.
    - Preserve existing `kspec task get --json` / agent-context drift semantics by reusing `resolveTaskResources` and `projectResolvedTaskResources` rather than duplicating drift logic.
    Verification: run focused shared type tests and daemon task route tests, then run `kspec validate --warnings-ok` to ensure new AC annotations resolve.
  priority: 1
  tags:
    - resources
    - api
    - daemon
  spec_ref: "@task-resource-markdown-resolution"
  depends_on:
    - "@add-resource-url-task-markdown-contract-tests"

- title: Add task resource bytes routes with drift-safe behavior
  slug: add-task-resource-bytes-routes
  description: |
    Add daemon routes rooted at `/api/tasks/:ref/resources` so browsers and static/live UI code can resolve task resources through the task's versioned refs rather than guessing whether bytes live on the plan or task:
    - `GET /api/tasks/:ref/resources` returns the resolved task resource projection from the task detail contract.
    - `GET /api/tasks/:ref/resources/:resourceId` returns one resolved resource projection or a structured 404 when the task has no matching resource id.
    - `GET /api/tasks/:ref/resources/:resourceId/bytes` serves bytes only when the resolved resource status is `present`; it sets `Content-Type`, `Content-Length`, and `X-Kspec-Resource-Sha256` from the current matching resource. For `drift`, `missing`, or `unresolved`, return a structured non-2xx response that names the status and does not stream bytes.
    - The route must resolve plan-owned refs through the source plan manifest and task-owned refs through the current task's resource manifest. It must reject path traversal and symlink escape by using the existing resource resolver/manifest helpers, not raw path joins.
    - Binary browser URLs in live multi-project mode must include selected-project context just like review resource URLs.
    Verification: add daemon API tests for present plan-owned bytes, present materialized task-owned bytes, drift refusal, missing-resource refusal, and selected-project routing.
  priority: 1
  tags:
    - resources
    - api
    - daemon
  spec_ref: "@task-resource-markdown-resolution"
  depends_on:
    - "@expose-task-resource-resolution-api"

- title: Generalize live UI resource markdown rewriting for plans and tasks
  slug: generalize-live-ui-resource-markdown-rewriting
  description: |
    Update the web UI resource-link utilities and task detail rendering:
    - Replace the plan-only URL construction assumption with a reusable resource markdown rewrite helper that accepts entity resource metadata and an entity-scoped `resources_base_url`.
    - Ensure live plan `resources_base_url` or the client helper appends selected-project context to browser-fetchable URLs. Do not rely on `X-Kspec-Dir` for `<img>` or `<a>` resource loads.
    - In the task detail modal, rewrite `task.description` before passing it to the markdown renderer using the resolved task resources and the task-scoped `resources_base_url`.
    - Render a compact task resources/status section when task resources exist so drift/missing/unresolved states are visible even if an image cannot load.
    - Keep review resource rendering behavior intact and covered by existing tests.
    Verification: run web UI unit tests for plan resource links, task resource links, review resource cards, and the task modal. Build or typecheck the web UI with the project's standard command.
  priority: 1
  tags:
    - resources
    - web-ui
  spec_ref: "@task-resource-markdown-resolution"
  depends_on:
    - "@add-task-resource-bytes-routes"

- title: Make static export copy and rewrite all advertised resource assets
  slug: make-static-export-copy-rewrite-all-resource-assets
  description: |
    Harden static export so every resource path advertised by snapshot metadata or rewritten markdown exists on disk:
    - Verify and, if needed, fix plan resource asset copying for `generateJsonSnapshot({ assetsOutputDir })` and the CLI/static export path. The disk file must exist under `assets/resources/plan/<plan-ulid>/<relative-path>` for each exported plan resource.
    - Add task resource export support for task descriptions that reference `./resources/<path>`. For plan-owned task refs, either reuse the exported plan asset when the recorded hash is present or emit a drift/missing status instead of rewriting to bytes. For materialized task-owned refs, copy from the task resource tree to a deterministic task asset path and rewrite task markdown to that path.
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
    Update the docs so future users and reviewers know the exact intended behavior:
    - `docs/concepts/local-resources.md` must describe task-description markdown resolution through task `resource_refs`, both plan-owned and materialized task-owned cases, drift behavior, and static export behavior.
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
  spec_ref: "@browser-resource-url-project-context"
  depends_on:
    - "@update-resource-documentation-ui-task-markdown"
```

## Implementation Notes

- Do not restart or stop the daemon during validation. Use `KSPEC_NO_DAEMON=1` only for CLI operations that should bypass incidental daemon communication, and use the existing project registration API for temp-project UI checks.
- Keep task resources read-only in this plan. The plan adds task resource read/detail/bytes behavior for derived refs and materialized copies; it does not add general `kspec task resource add/remove` authoring commands.
- Keep `ResourceMetadata` byte-free and URL-free. Browser-safe fetch URLs belong in entity-scoped base URL fields or client URL helpers, not inside each resource metadata object.
- When a task resource is drifted, do not render changed bytes as if they were the recorded resource. Show drift and require an explicit re-derive or resource update workflow outside this plan.
- Prefer reusable resource link helpers over a second plan-only regex. The existing `./resources/...` authoring syntax and path validation rules must stay consistent between parser-side extraction and UI-side rewriting.
- Add tests before fixes where possible. The first task should fail on the currently observed behavior: browser URL missing selected-project routing context and task markdown emitting literal `/resources/...` links.
