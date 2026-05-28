# Folder-Backed Plans, Reviews, and Local Resources

## Research Findings

Current implementation facts this draft is based on:

- Tasks already provide the closest in-project pattern: `.kspec/tasks/<ulid>/` stores `task.yaml` and `notes.yaml`, while `project.tasks.yaml` is a lean index. The implementation centralizes layout helpers, preserves unknown files in the task directory, and supports migration/rebuild-index commands.
- Plans are still monolithic: `src/parser/plans.ts` stores every plan in `.kspec/project.plans.yaml`; `PlanSchema.content` stores the entire markdown document inline; `plan import` reads a markdown file and stores its contents; `plan derive` parses `foundPlan.content`.
- Reviews are still monolithic: `src/parser/reviews.ts` stores every review record in `.kspec/project.reviews.yaml`. Review records contain growth-prone threads, checks, verdicts, events, notes, and external links, but the first folder-backed review slice keeps that structured record cohesive and adds first-party local evidence such as screenshots/logs.
- Entity cache and web invalidation currently map only `project.plans.yaml` to the plans domain and `project.reviews.yaml` to the reviews domain. Folder layouts need watcher/cache invalidation for `plans/` and `reviews/` paths.
- kspec state is already git-backed. Resource versioning should use content hashes and git commit/path identity; kspec should not maintain a parallel per-resource history log.
- Sessions and skills are useful precedents for local resources: sessions externalize large event fields to `blobs/` with pointer metadata; skills store `SKILL.md` plus supporting `references/`, `scripts/`, `assets/`, and `docs/` directories.
- Inbox remains single-file because it is intentionally low-friction text capture and triage is the natural pressure valve. Triage remains compact and can continue using `evidence_refs` instead of owning resource directories unless its scope changes.
- During this plan's implementation and review work, active project repositories such as `/home/chapel/Projects/kynetic-spec` and `/home/chapel/Projects/kynetic-spec-dispatch` are live projects, not migration sandboxes. Migration experiments must use isolated temporary projects or explicit disposable copies only.

## Specs

```yaml
- title: Folder-Backed Entity Trait
  slug: trait-folder-backed-entity
  type: trait
  parent: "@core"
  description: |
    An entity that adopts folder-backed storage owns a stable per-entity
    directory, keeps list/index projections bounded, preserves unknown files,
    and can rebuild its index from authoritative folder contents. This trait is
    storage-shape behavior shared by tasks, plans, reviews, and future
    folder-backed entities.
  acceptance_criteria:
    - id: ac-entity-has-ulid-directory
      given: |
        A folder-backed entity exists in the system
      when: |
        The entity is persisted
      then: |
        The entity has its own directory named by its full ULID under that entity type's storage root
    - id: ac-index-excludes-heavy-detail-bytes
      given: |
        Folder-backed entities exist in a project
      when: |
        The entity index is read for listing, filtering, cache warm-up, or dashboard summary surfaces
      then: |
        The index contains bounded identity, lifecycle, summary, and relationship fields without embedding full documents, unbounded detail logs, or resource file bytes
    - id: ac-unknown-files-preserved
      given: |
        A folder-backed entity directory contains unknown files or directories
      when: |
        The entity is read or updated
      then: |
        Unknown entries are ignored by entity semantics and preserved across writes
    - id: ac-index-rebuilds-from-folders
      given: |
        A folder-backed entity index has drifted from entity directories
      when: |
        An index rebuild is requested
      then: |
        The index can be regenerated from entity folders and sidecar metadata

- title: Entity-Scoped Local Resources Trait
  slug: trait-entity-scoped-local-resources
  type: trait
  parent: "@core"
  traits:
    - "@trait-folder-backed-entity"
  description: |
    A folder-backed entity that owns rich context can include local resource
    files beside its structured data. Resource files live under the owning
    entity's `resources/` directory and are declared in `resources.yaml`.
    User-authored references use `./resources/<relative-path>`; consumers
    receive normalized owner/type/resource metadata instead of arbitrary file
    paths.
  acceptance_criteria:
    - id: ac-resource-reference-resolves-within-owner
      given: |
        A folder-backed entity contains a declared local resource
      when: |
        A user, UI route, API route, static export, or agent resolves a `./resources/<relative-path>` reference for that entity
      then: |
        The reference resolves only to a declared file inside the owning entity's `resources/` tree
    - id: ac-resource-metadata-exposes-safe-preview-fields
      given: |
        A folder-backed entity has one or more declared local resources
      when: |
        The entity is read through list, detail, API, static export, or agent-context surfaces
      then: |
        Consumers can discover resource id, label, relative path, content type, byte size, content hash, and git version metadata without embedding large file contents in index records
    - id: ac-path-escape-rejected
      given: |
        A resource reference contains an absolute path, parent traversal, an undeclared resource path, or a symlink escape
      when: |
        The resource is imported, attached, served, exported, or resolved
      then: |
        The operation is rejected with actionable guidance and no file outside the owning entity resource tree is read or written
    - id: ac-binary-resources-are-not-inlined-into-yaml
      given: |
        A local resource is binary or large text
      when: |
        The entity is persisted
      then: |
        The resource remains as a sidecar file and structured records store only bounded metadata or pointers
    - id: ac-resource-delete-follows-owner-delete
      given: |
        A folder-backed entity with local resources is deleted
      when: |
        The deletion is persisted
      then: |
        The entity's owned resource files are removed in the same logical mutation as the entity record
    - id: ac-versioning-uses-git-backed-identity
      given: |
        A resource version is recorded for later resolution or drift detection
      when: |
        The project is stored in git
      then: |
        The version metadata uses content hash plus git commit and repository-relative path when a commit is available, without maintaining a separate resource history log inside kspec
    - id: ac-static-export-copies-resource-assets
      given: |
        A static export includes entities with declared local resources
      when: |
        The export is generated
      then: |
        Resource files are copied under `assets/resources/<entity-type>/<entity-ulid>/<relative-path>` and exported metadata reports that exported path

- title: Folder-Backed Plan Storage
  slug: folder-backed-plan-storage
  type: requirement
  parent: "@plan-crud"
  traits:
    - "@trait-entity-scoped-local-resources"
  description: |
    Plans are stored as folder-backed entities so the markdown plan document and
    local supporting resources can live together without bloating the plan index.
    Each plan directory contains `plan.md`, `plan.yaml`, optional `notes.yaml`,
    `resources.yaml`, and `resources/`. List and detail consumers continue to
    see the same plan identity, status, lifecycle, content, notes, and
    derived-ref semantics.
  acceptance_criteria:
    - id: ac-plan-document-sidecar-is-authoritative
      given: |
        A folder-backed plan is loaded for detail or derivation
      when: |
        The plan document is needed
      then: |
        `.kspec/plans/<plan-ulid>/plan.md` is the authoritative source of plan markdown content
    - id: ac-plan-metadata-sidecar-is-authoritative
      given: |
        A folder-backed plan is loaded or mutated
      when: |
        Plan identity, status, source path, module, branch, timestamps, notes, or derived refs are needed
      then: |
        `.kspec/plans/<plan-ulid>/plan.yaml` stores the authoritative bounded plan metadata while `notes.yaml` stores plan notes when notes are present
    - id: ac-plan-index-has-bounded-projection
      given: |
        Folder-backed plans exist in a project
      when: |
        `.kspec/project.plans.yaml` is read for listing, filtering, or cache warm-up
      then: |
        The index contains plan ULID, slugs, title, status, source path, module, branch, derived refs, timestamps, and resource summaries, but not full markdown content, notes, or resource file bytes
    - id: ac-plan-delete-removes-owned-folder
      given: |
        A folder-backed plan is eligible for removal under the existing plan removal rules
      when: |
        The plan is removed
      then: |
        The plan index entry and `.kspec/plans/<plan-ulid>/` directory are removed in one logical shadow mutation

- title: Plan Resource Derivation Semantics
  slug: plan-resource-derivation-semantics
  type: requirement
  parent: "@plan-derive-enhanced"
  description: |
    Plan task definitions can explicitly reference plan-owned resources via a
    `resource_refs` list containing `./resources/<relative-path>` entries.
    Derived tasks keep versioned references to those plan resources by default;
    task-owned copies are only created by an explicit materialize/copy option.
  acceptance_criteria:
    - id: ac-plan-task-resource-refs-are-structured
      given: |
        A plan document contains a manual task definition in the `## Tasks` YAML block
      when: |
        The task needs one or more plan-local resources
      then: |
        The task definition can declare `resource_refs: ["./resources/<relative-path>"]` entries that must resolve against the source plan's `resources.yaml` manifest
    - id: ac-derived-task-keeps-plan-resource-reference
      given: |
        A plan task definition declares one or more valid `resource_refs`
      when: |
        The plan is derived into tasks without explicit materialization
      then: |
        The derived task records plan-owned resource references instead of copying resource bytes into the task directory
    - id: ac-derived-task-records-resource-version
      given: |
        A derived task records a reference to a plan-owned local resource
      when: |
        The task is created
      then: |
        The task resource reference records owner type, owner ref, resource id, relative path, content hash, and available git commit/path identity from derivation time
    - id: ac-resource-drift-is-visible
      given: |
        A task references a plan resource whose current content no longer matches the version recorded at derivation time
      when: |
        The task detail, agent context, or API resource resolver presents the resource
      then: |
        The consumer is told the resource has changed rather than silently receiving an unversioned replacement
    - id: ac-explicit-copy-mode-creates-task-owned-resource
      given: |
        A derivation command explicitly requests materialized task-owned copies of plan resources
      when: |
        The plan is derived
      then: |
        Each copied resource is stored under the derived task's resource tree and the task resource reference points at the task-owned copy

- title: Folder-Backed Review Storage
  slug: folder-backed-review-storage
  type: requirement
  parent: "@review-record-storage-and-identity"
  traits:
    - "@trait-entity-scoped-local-resources"
  description: |
    Reviews are stored as folder-backed entities so review records can own
    local evidence such as screenshots, logs, and supporting files without
    rewriting or bloating one project-wide YAML file. The first slice stores
    the full structured ReviewRecord in `review.yaml` and does not split
    threads, checks, verdicts, notes, or events into separate sidecars.
  acceptance_criteria:
    - id: ac-review-detail-file-is-cohesive
      given: |
        A folder-backed review is loaded or mutated
      when: |
        Consumers request the review record
      then: |
        `.kspec/reviews/<review-ulid>/review.yaml` contains the full review detail record, including subject, related refs, threads, checks, verdicts, events, notes, and external links
    - id: ac-review-index-has-bounded-projection
      given: |
        Folder-backed reviews exist in a project
      when: |
        `.kspec/project.reviews.yaml` is read for list, filter, cache warm-up, or dashboard summary surfaces
      then: |
        The index contains review ULID, lifecycle, subject summary, related refs, disposition, timestamps, and resource summaries, but not full review detail or resource bytes
    - id: ac-review-screenshot-resource-loads-in-ui
      given: |
        A review has an attached screenshot resource declared in `resources.yaml`
      when: |
        The review is opened in the web UI or exported to the static UI snapshot
      then: |
        The screenshot can be discovered and loaded from a stable review-scoped resource URL or exported asset path
    - id: ac-review-delete-removes-owned-folder
      given: |
        A folder-backed review is deleted through review storage behavior
      when: |
        The deletion is persisted
      then: |
        The review index entry and `.kspec/reviews/<review-ulid>/` directory are removed in one logical shadow mutation

- title: Entity Folder Migration and Compatibility
  slug: entity-folder-migration-and-compatibility
  type: requirement
  parent: "@core"
  description: |
    Projects using monolithic plan or review files migrate to folder-backed
    storage through `kspec upgrade`. The new project format is `kynetic: "1.2"`
    with `task_storage.format: split`, `plan_storage.format: folder`,
    `review_storage.format: folder`, and `resource_storage.format:
    entity_scoped`. Newer kspec versions that require folder-backed plans or
    reviews block incompatible projects with structured guidance instead of
    silently reading or rewriting ambiguous data.
  acceptance_criteria:
    - id: ac-new-projects-declare-folder-storage
      given: |
        A new project is created with the kspec version that includes folder-backed plans and reviews
      when: |
        The project manifest is generated
      then: |
        The manifest declares `kynetic: "1.2"`, `task_storage.format: split`, `plan_storage.format: folder`, `review_storage.format: folder`, and `resource_storage.format: entity_scoped`
    - id: ac-upgrade-dry-run-previews-layout
      given: |
        A project has monolithic plan or review records
      when: |
        The user runs `kspec upgrade --dry-run`
      then: |
        The command reports the target manifest fields, directories, sidecar files, index changes, resource manifest changes, warnings, and previous shadow commit without writing them
    - id: ac-upgrade-executes-folder-migration
      given: |
        A project has monolithic plan or review records and the user runs `kspec upgrade`
      when: |
        The storage migration succeeds
      then: |
        Plans and reviews are decomposed into the folder-backed layout, lean indexes are written, the manifest is updated to the 1.2 storage fields, and all changes are committed as one logical shadow mutation
    - id: ac-migration-preserves-record-identity-and-unknown-fields
      given: |
        A monolithic plan or review record contains existing fields or unknown fields
      when: |
        It is migrated to folder-backed storage
      then: |
        The migrated entity preserves its ULID, slugs, refs, timestamps, lifecycle state, known fields, and unknown record fields
    - id: ac-unmigrated-projects-are-blocked-with-guidance
      given: |
        A newer kspec command or daemon route needs folder-backed plan, review, or resource behavior and finds `kynetic` below `1.2` or missing `plan_storage.format: folder` or `review_storage.format: folder`
      when: |
        The operation cannot safely continue
      then: |
        It fails with `entity_storage_incompatible` guidance to run `kspec upgrade` or use a kspec version compatible with the existing manifest
    - id: ac-partial-folder-layouts-are-blocked
      given: |
        A project declares folder-backed plan or review storage but has monolithic records without corresponding entity directories or index entries that do not match folders
      when: |
        The relevant entity storage manager initializes
      then: |
        It fails with a structured `partial_entity_storage_layout` incompatibility instead of partially reading or rewriting ambiguous data
    - id: ac-daemon-returns-structured-conflict
      given: |
        A daemon API route needs plan, review, or resource data from an incompatible project
      when: |
        The route handles the storage incompatibility
      then: |
        The response is HTTP 409 with top-level error `entity_storage_incompatible`, a domain-specific code, migration suggestion, and cache-domain context when available

- title: Folder-Backed Resource Documentation
  slug: folder-backed-resource-documentation
  type: requirement
  parent: "@user-documentation"
  description: |
    User-facing documentation and CLI help describe the folder-backed plan and
    review layouts, exact resource commands, exact resource API routes,
    resource reference syntax, derivation copy/reference behavior, upgrade
    behavior, and troubleshooting guidance. Documentation follows the
    implementation contracts from the storage/resource specs; it does not
    create separate storage behavior.
  acceptance_criteria:
    - id: ac-resource-docs-name-exact-interfaces
      given: |
        The folder-backed resource feature is documented
      when: |
        A user reads the documentation or command help
      then: |
        The docs name the exact plan/review resource commands, resource API routes, `resources.yaml` fields, and `kspec plan derive --materialize-resources` behavior
    - id: ac-upgrade-docs-explain-compatibility-gate
      given: |
        The folder-backed storage format is released
      when: |
        A user reads upgrade or troubleshooting documentation
      then: |
        The docs explain the `kynetic: "1.2"` manifest fields, `kspec upgrade` migration path, previous-shadow-commit rollback guidance, and `entity_storage_incompatible` recovery options
```

## Tasks

derive_from_specs: false

```yaml
- title: Update existing plan and review storage specs for folder-backed layouts
  slug: task-update-plan-review-storage-specs
  priority: 1
  tags: [specs, plans, reviews]
  spec_ref: "@entity-folder-migration-and-compatibility"
  description: |
    What:
    - Update existing spec language that hard-codes monolithic files before implementing folder-backed storage. This task is only for catalog/spec maintenance; it must not implement storage code.
    - Update @plan-crud ac-1 exactly as follows:
      - Given: `A user wants to create a plan`
      - When: `kspec plan add --title "Title" --content "Markdown content" is run`
      - Then: `A plan is created with ULID-backed identity, retrievable markdown content, lifecycle metadata, and an auto-commit to the shadow branch`
    - Update @plan-crud ac-2 exactly as follows:
      - Given: `A markdown file exists at a path`
      - When: `kspec plan add --title "Title" --content-file ./plan.md is run`
      - Then: `File content is read and becomes the plan's retrievable markdown content`
    - Update @review-record-storage-and-identity ac-3 exactly as follows:
      - Given: `Review records are stored in the shadow branch`
      - When: `A review mutation is committed`
      - Then: `The review data is persisted in dedicated first-party review storage rather than embedded inside plans, tasks, module files, or other unrelated entity files`
    - Add one new AC to @daemon-entity-cache with id `ac-folder-backed-entity-directory-invalidation` and exact wording:
      - Given: `A file watcher detects a change inside a registered project's folder-backed entity directory`
      - When: `The changed path is under .kspec/plans/<plan-ulid>/ or .kspec/reviews/<review-ulid>/`
      - Then: `The cache invalidates and reloads the plans domain for plan-directory changes or the reviews domain for review-directory changes`
    - Keep @daemon-entity-cache ac-watcher-invalidation and ac-granular-reload unchanged; the new AC narrows those existing cache promises for folder-backed plan/review directories.
    - Set or preserve final implementation statuses exactly as follows after the AC edits: @plan-crud remains `implemented`; @review-record-storage-and-identity remains `implemented`; @daemon-entity-cache remains `in_progress`. Do not mark any of these specs back to `draft` or forward to another status as part of this catalog update.
    - Do not add or edit any inbox, triage, or meta storage specs in this task. This plan intentionally converts plans first and reviews second only; inbox remains single-file, triage continues to reference resources owned elsewhere, and meta is not broadly converted.
    - The new plan-local specs @trait-folder-backed-entity, @trait-entity-scoped-local-resources, @folder-backed-plan-storage, @plan-resource-derivation-semantics, @folder-backed-review-storage, @entity-folder-migration-and-compatibility, and @folder-backed-resource-documentation are materialized by plan derivation; this task only edits the existing specs named above.

    Why:
    - The current specs explicitly require single-file plan/review storage, so implementation would otherwise contradict the source of truth.

    How:
    - Use kspec CLI spec/item commands rather than manual .kspec YAML edits.
    - Keep existing user-visible CLI semantics intact; only remove physical storage assumptions from existing ACs.
    - Preserve task-storage split as the style reference: format-neutral consumer contract plus separate storage-layout specs.

    Testing:
    - Before editing, run `kspec item get @plan-crud`, `kspec item get @review-record-storage-and-identity`, and `kspec item get @daemon-entity-cache` to confirm the current AC ids still exist.
    - After editing, run the same three `kspec item get` commands and verify the exact Given/When/Then text above appears on @plan-crud ac-1, @plan-crud ac-2, @review-record-storage-and-identity ac-3, and @daemon-entity-cache ac-folder-backed-entity-directory-invalidation.
    - Verify final implementation statuses exactly: @plan-crud `implemented`, @review-record-storage-and-identity `implemented`, and @daemon-entity-cache `in_progress`.
    - Run `kspec validate --warnings-ok`.
    - Run focused parser/schema tests that exercise plan/review specs if changed.

    Covers: spec-maintenance prerequisite only; no migration/runtime AC is claimed by this task.

- title: Implement a shared folder-backed entity trait foundation
  slug: task-folder-backed-entity-trait-foundation
  priority: 1
  tags: [storage, schema, parser]
  spec_ref: "@trait-folder-backed-entity"
  depends_on:
    - "@task-update-plan-review-storage-specs"
  description: |
    What:
    - Extract the common folder-backed entity behavior from task split storage into shared helpers/types that future entity stores can adopt.
    - Centralize the exact shared behavior promised by @trait-folder-backed-entity: each entity has a full-ULID directory under its type root; list/cache/dashboard indexes contain bounded identity/lifecycle/summary/relationship fields only; unknown files/directories in entity folders are ignored by semantics and preserved across writes; indexes can be regenerated from entity folders and sidecar metadata.
    - Centralize full-ULID directory naming, storage-root path helpers, bounded index projection conventions, unknown-file preservation, rebuild-index mechanics, and cache invalidation hooks.
    - Keep the abstraction small: it defines folder ownership/index behavior, not plan-specific markdown semantics, review-specific schemas, or resource-manifest semantics.

    Why:
    - Plans, reviews, tasks, and future long-lived entities should not each grow bespoke folder-storage implementations with different safety and rebuild behavior.

    How:
    - Use the current task split implementation as the reference extraction target.
    - Keep entity-specific managers responsible for their own detail schema while sharing folder/index plumbing.

    Testing:
    - Unit-test shared path helpers, full-ULID directory validation, unknown-file preservation behavior, bounded index projection hooks, and rebuild-index behavior through a fixture entity.

    Covers: @trait-folder-backed-entity ac-entity-has-ulid-directory, ac-index-excludes-heavy-detail-bytes, ac-unknown-files-preserved, ac-index-rebuilds-from-folders

- title: Implement a shared entity-local resource trait and resolver
  slug: task-entity-local-resource-model
  priority: 1
  tags: [resources, schema, parser]
  spec_ref: "@trait-entity-scoped-local-resources"
  depends_on:
    - "@task-folder-backed-entity-trait-foundation"
  description: |
    What:
    - Add shared schema/types for `resources.yaml`: `resources` array entries with stable `id`, `label`, `path` relative to the entity `resources/` directory, `content_type`, `bytes`, `sha256`, optional `git_commit`, optional repository-relative `git_path`, and optional `description`.
    - Define the exact shared `ResourceMetadata` shape as `{ "id": string, "label": string|null, "path": string, "content_type": string, "bytes": number, "sha256": string, "git_commit": string|null, "git_path": string|null, "description": string|null }`.
    - Define `content_type` population exactly: when a CLI `--content-type` value or API `content_type` multipart field is supplied, validate it is a non-empty MIME-ish token of the form `type/subtype` with no whitespace and store it exactly; when omitted, infer from the final resource path extension using the existing project MIME lookup if one exists, otherwise Node's standard MIME lookup, and if inference fails store `application/octet-stream`. The field is never null in `ResourceMetadata`.
    - Validate resource identifiers with exact pattern `[a-z0-9][a-z0-9._-]{0,127}`.
    - Resource paths use POSIX-style relative paths under the owner `resources/` directory; reject paths that start with `/`, contain `..`, contain `\`, are undeclared, or resolve through symlinks outside the resource root.
    - Add path normalization and validation helpers that accept only `./resources/<relative-path>` authoring references, reject absolute paths, reject `..`, reject undeclared resource paths, reject symlink escapes, and keep all resolution inside the owning entity resource tree.
    - Add resolver helpers that load metadata, resolve a resource path for an entity, and produce bounded previews without loading binary bytes into YAML records.
    - Add static-export helpers that copy resource files to `assets/resources/<entity-type>/<entity-ulid>/<relative-path>` and return that exported path in metadata.

    Why:
    - Plans and reviews need the same local-resource behavior. Building this once avoids incompatible attachment models.

    How:
    - Use the session blob pointer pattern for hashes/previews and the skill supporting-file directory pattern for safe relative sidecar directories.
    - Do not expose arbitrary filesystem reads; all resolution starts from the owning entity directory and declared manifest entries.
    - Keep list/index projections bounded.

    Testing:
    - Unit-test valid references, absolute path rejection, parent traversal rejection, undeclared path rejection, symlink escape rejection, metadata hash computation, explicit `content_type` storage, inferred `content_type` by extension, `application/octet-stream` fallback for unknown extensions, invalid content-type rejection, git version metadata capture, binary-resource metadata, missing-resource guidance, and static-export path generation.

    Covers: @trait-entity-scoped-local-resources ac-resource-reference-resolves-within-owner, ac-resource-metadata-exposes-safe-preview-fields, ac-path-escape-rejected, ac-binary-resources-are-not-inlined-into-yaml, ac-versioning-uses-git-backed-identity, ac-static-export-copies-resource-assets

- title: Implement entity storage version and incompatibility gates
  slug: task-entity-storage-version-compatibility-gates
  priority: 2
  tags: [migration, manifest, daemon, cli]
  spec_ref: "@entity-folder-migration-and-compatibility"
  depends_on:
    - "@task-entity-local-resource-model"
  description: |
    What:
    - Define manifest version `kynetic: "1.2"` for folder-backed plans/reviews/resources. This version gate applies only to plan storage, review storage, and entity-scoped local resources; do not convert inbox, triage, sessions, or broad meta storage in this task.
    - Extend manifest parsing and initialization so new projects write `task_storage.format: split`, `plan_storage.format: folder`, `review_storage.format: folder`, and `resource_storage.format: entity_scoped`.
    - Add deterministic storage incompatibility errors for plan/review/resource domains with top-level code `entity_storage_incompatible` and domain-specific codes: `legacy_plan_storage_removed`, `legacy_review_storage_removed`, `missing_plan_folder_storage`, `missing_review_folder_storage`, and `partial_entity_storage_layout`.
    - Permit `kspec upgrade`, `kspec doctor`, and read-only compatibility diagnostics to run on old layouts; block commands/routes that need folder-backed plan, review, or resource behavior until upgrade succeeds.
    - Add daemon mapping so incompatible plan/review/resource reads return HTTP 409 with error, code, suggestion, domain, and cache-domain state rather than 404 or unhandled 500.
    - Treat `/home/chapel/Projects/kynetic-spec` and `/home/chapel/Projects/kynetic-spec-dispatch` as protected live projects during this plan's implementation. Do not run executing upgrade/migration commands in those directories or against their `.kspec` worktrees while developing or manually testing this feature.
    - If this task detects either protected live project already declares `kynetic: "1.2"`, `plan_storage.format: folder`, `review_storage.format: folder`, or has `.kspec/plans/` or `.kspec/reviews/` created by this plan's migration work, stop the current task before further writes and report the detected path/state so Jacob can repair it. Do not attempt an automated rollback or cleanup of the live project.

    Why:
    - Storage managers and UI/API work need a stable compatibility contract before they start touching folder-backed data. Workers must not decide ad hoc whether to dual-read, hard-fail, or rewrite stale layouts.

    How:
    - Model this after task storage activation and `task_storage_incompatible`, but use `entity_storage_incompatible` because the new gate covers plans, reviews, and resources.
    - Guidance should say: run `kspec upgrade` to migrate the project, or use a kspec version compatible with the current manifest if upgrade is not desired.

    Testing:
    - Manifest tests for new-project defaults and 1.2 fields.
    - CLI tests for old manifests, missing storage fields, and partial layouts.
    - Daemon tests for 409 `entity_storage_incompatible` responses and cache-domain context.
    - Run compatibility-gate and migration-shape tests only against temp directories, checked-in fixtures, or disposable copies created for the test. Never use the active `/home/chapel/Projects/kynetic-spec` or `/home/chapel/Projects/kynetic-spec-dispatch` repositories as the migrated fixture.
    - `kspec validate --warnings-ok`.

    Covers: @entity-folder-migration-and-compatibility ac-new-projects-declare-folder-storage, ac-unmigrated-projects-are-blocked-with-guidance, ac-partial-folder-layouts-are-blocked, ac-daemon-returns-structured-conflict

- title: Convert plan persistence to a folder-backed storage manager
  slug: task-folder-backed-plan-storage-manager
  priority: 3
  tags: [plans, parser, migration]
  spec_ref: "@folder-backed-plan-storage"
  depends_on:
    - "@task-entity-storage-version-compatibility-gates"
  description: |
    What:
    - Introduce a plan storage manager/backing layout using `.kspec/plans/<plan-ulid>/plan.md`, `plan.yaml`, optional `notes.yaml`, `resources.yaml`, and `resources/`.
    - Keep `.kspec/project.plans.yaml` as a lean index with ULID, slugs, title, status, source path, module, branch, derived refs, timestamps, and bounded resource summaries.
    - Keep `loadPlans`, `findPlanByRef`, `savePlan`, `mutatePlanAtomically`, and `deletePlan` consumer semantics stable while moving physical reads/writes behind the manager.
    - Preserve unknown files in plan directories and delete owned directories/resources when deleting a plan.
    - Add exactly `kspec plan rebuild-index` with `--dry-run`, `--repair`, `--force`, and `--json` flags. Default/no flag validates drift and exits nonzero if drift exists without writing. `--dry-run` prints the same drift summary and never writes. `--repair` rewrites `.kspec/project.plans.yaml` from plan folders. `--force` is accepted only with `--repair` and permits dropping stale index entries whose entity folders are missing; without `--force`, missing folders are a conflict and no files are written.
    - Define `kspec plan rebuild-index --json` output as `{ "domain": "plans", "status": "clean"|"drift"|"repaired"|"blocked", "dry_run": boolean, "repair": boolean, "force": boolean, "summary": { "folders": number, "index_entries": number, "added": number, "updated": number, "removed_stale": number, "conflicts": number }, "changes": [{ "kind": "add"|"update"|"remove_stale", "ref": string, "path": string }], "conflicts": [{ "code": string, "ref": string|null, "path": string|null, "message": string }] }`. JSON exit codes are 0 for `clean` or successful `repaired`, 1 for `drift` when not repaired, and 2 for `blocked` conflicts.
    - When the manager sees old/missing/partial storage markers, raise the shared entity-storage incompatibility errors from @task-entity-storage-version-compatibility-gates instead of dual-reading or silently migrating.

    Why:
    - Plan markdown and supporting research artifacts will grow; storing all plan content and future resources inline in one YAML file makes list/cache operations heavier and makes resource ownership unclear.

    How:
    - Reuse the task split patterns: centralized path helpers, lean index projection, authoritative detail files, raw-shape migration helpers, buffer-aware writes, and single shadow commits for multi-file mutations.
    - Keep API/shared `PlanDetail.content` available by loading `plan.md` during detail reads.
    - Treat `plan.md` as authoritative when index/core metadata and document content disagree.

    Testing:
    - Add plan storage unit tests for create/list/detail/update/delete, owned resource cleanup on plan delete, unknown file preservation, content sidecar authority, index projection, rebuild drift detection, `--repair`, `--force` stale-entry handling, and incompatibility errors for old or partial layouts.
    - Run existing plan parser/import/derive tests to prove consumer semantics did not change.

    Covers: @folder-backed-plan-storage ac-plan-document-sidecar-is-authoritative, ac-plan-metadata-sidecar-is-authoritative, ac-plan-index-has-bounded-projection, ac-plan-delete-removes-owned-folder, @trait-folder-backed-entity ac-entity-has-ulid-directory, ac-index-excludes-heavy-detail-bytes, ac-unknown-files-preserved, ac-index-rebuilds-from-folders, @trait-entity-scoped-local-resources ac-resource-delete-follows-owner-delete

- title: Convert review persistence to folder-backed storage with resource support
  slug: task-folder-backed-review-storage-manager
  priority: 3
  tags: [reviews, parser, migration]
  spec_ref: "@folder-backed-review-storage"
  depends_on:
    - "@task-entity-storage-version-compatibility-gates"
  description: |
    What:
    - Introduce a review storage manager/backing layout using `.kspec/reviews/<review-ulid>/review.yaml`, `resources.yaml`, and `resources/`.
    - Store the full cohesive ReviewRecord shape in `review.yaml`; do not split threads, checks, verdicts, notes, or events into separate files in this plan.
    - Keep `loadReviewRecords`, `findReviewByRef`, `saveReviewRecord`, `mutateReviewAtomically`, and delete semantics stable for existing callers.
    - Keep `.kspec/project.reviews.yaml` as a lean index with ULID, lifecycle, subject summary, related refs, disposition, timestamps, and bounded resource summaries.
    - Add exactly `kspec review rebuild-index` with `--dry-run`, `--repair`, `--force`, and `--json` flags. Default/no flag validates drift and exits nonzero if drift exists without writing. `--dry-run` prints the same drift summary and never writes. `--repair` rewrites `.kspec/project.reviews.yaml` from review folders. `--force` is accepted only with `--repair` and permits dropping stale index entries whose entity folders are missing; without `--force`, missing folders are a conflict and no files are written.
    - Define `kspec review rebuild-index --json` output as `{ "domain": "reviews", "status": "clean"|"drift"|"repaired"|"blocked", "dry_run": boolean, "repair": boolean, "force": boolean, "summary": { "folders": number, "index_entries": number, "added": number, "updated": number, "removed_stale": number, "conflicts": number }, "changes": [{ "kind": "add"|"update"|"remove_stale", "ref": string, "path": string }], "conflicts": [{ "code": string, "ref": string|null, "path": string|null, "message": string }] }`. JSON exit codes are 0 for `clean` or successful `repaired`, 1 for `drift` when not repaired, and 2 for `blocked` conflicts.
    - When the manager sees old/missing/partial storage markers, raise the shared entity-storage incompatibility errors from @task-entity-storage-version-compatibility-gates instead of dual-reading or silently migrating.

    Why:
    - Reviews are the best non-plan candidate for folder storage because screenshots/logs/evidence should be review-local, while the review's structured discussion/check/verdict/note data should remain cohesive until there is a measured reason to split it.

    How:
    - Use the shared folder-backed entity trait for index/detail separation and the shared resource trait for evidence files.
    - Delete owned resources with the review directory.

    Testing:
    - Review storage unit tests for create/list/detail/mutations against the cohesive review detail file, screenshot resource metadata, owned resource cleanup on review delete, unknown file preservation, index rebuild drift detection, `--repair`, `--force` stale-entry handling, and incompatibility errors for old or partial layouts.
    - Existing review CLI/API tests should pass unchanged except where they assert monolithic storage internals.

    Covers: @folder-backed-review-storage ac-review-detail-file-is-cohesive, ac-review-index-has-bounded-projection, ac-review-screenshot-resource-loads-in-ui, ac-review-delete-removes-owned-folder, @trait-folder-backed-entity ac-entity-has-ulid-directory, ac-index-excludes-heavy-detail-bytes, ac-unknown-files-preserved, ac-index-rebuilds-from-folders, @trait-entity-scoped-local-resources ac-resource-delete-follows-owner-delete

- title: Implement plan and review storage migration plus upgrade integration
  slug: task-plan-review-folder-storage-migration
  priority: 4
  tags: [migration, upgrade, cli]
  spec_ref: "@entity-folder-migration-and-compatibility"
  depends_on:
    - "@task-folder-backed-plan-storage-manager"
    - "@task-folder-backed-review-storage-manager"
  description: |
    What:
    - Add dry-run and executing migration steps to `kspec upgrade` for the 1.2 folder-backed plan/review/resource format.
    - For plans, move inline `content` into `.kspec/plans/<plan-ulid>/plan.md`, move bounded metadata into `plan.yaml`, move notes into `notes.yaml` when present, create empty `resources.yaml` when no resources exist, and write the lean `.kspec/project.plans.yaml` index with ULID, slugs, title, status, source path, module, branch, derived refs, timestamps, and bounded resource summaries only.
    - For reviews, move each full review record into `.kspec/reviews/<review-ulid>/review.yaml`, create empty `resources.yaml` when no resources exist, and write the lean `.kspec/project.reviews.yaml` index with ULID, lifecycle, subject summary, related refs, disposition, timestamps, and bounded resource summaries only.
    - Preserve these exact folder layouts: plan folders contain `plan.md`, `plan.yaml`, optional `notes.yaml`, `resources.yaml`, and `resources/`; review folders contain cohesive `review.yaml`, `resources.yaml`, and `resources/`.
    - Do not create inbox, triage, session, or broad meta folder migrations. Inbox is intentionally capped by triage, triage keeps using references to resources owned elsewhere unless its scope changes, sessions are only a blob-pointer precedent, and skills already have a supporting-file folder model.
    - Update the manifest to `kynetic: "1.2"`, `task_storage.format: split`, `plan_storage.format: folder`, `review_storage.format: folder`, and `resource_storage.format: entity_scoped` only after successful migration.
    - Detect already migrated and partially migrated layouts with clear reporting.
    - Report the previous shadow commit as rollback guidance instead of creating parallel backup files.
    - Add structured incompatibility errors for routes/commands that cannot safely operate on a stale or partial layout.
    - For all manual/exploratory upgrade runs, use an isolated temp project or an explicit disposable copy of fixture data. Do not run `kspec upgrade` or any executing migration command in `/home/chapel/Projects/kynetic-spec`, `/home/chapel/Projects/kynetic-spec-dispatch`, or their `.kspec` worktrees as part of this plan's implementation/testing.
    - Add a worker preflight/tripwire to this task's implementation checklist: before any manual non-dry-run migration command, print and verify `pwd`, the resolved project root, and the target `.kspec` path. If the target is one of the protected live paths above, abort without mutation.
    - If an implementation or review agent observes that either protected live project has been migrated during this plan's work (manifest `kynetic: "1.2"`, `plan_storage.format: folder`, `review_storage.format: folder`, or unexpected `.kspec/plans/`/`.kspec/reviews/` directories), block the current task, make no further writes to that project, and report the path plus observed marker. Jacob owns recovery; agents must not silently repair or continue.

    Why:
    - Existing projects must have a safe path from monolithic files to folder-backed storage, and daemon/API consumers need deterministic behavior during compatibility windows.

    How:
    - Follow `kspec task migrate` and `task rebuild-index` conventions: dry-run previews, best-effort preservation with warnings, one logical buffered mutation, shadow commit, rebuild/repair command, and upgrade pipeline integration.
    - Do not silently dual-write or opportunistically migrate during normal plan/review commands; migration is owned by `kspec upgrade`.
    - Build migration tests using temp project factories, copied fixtures, or scratch repositories whose paths are asserted not to be `/home/chapel/Projects/kynetic-spec` or `/home/chapel/Projects/kynetic-spec-dispatch` before writes begin.

    Testing:
    - Migration tests for empty files, valid records, invalid-but-preserved raw records, missing ULIDs, unknown fields, already migrated layouts, partial layouts, dry-run no writes, executing migration writes expected dirs/files/indexes, manifest 1.2 fields, previous-commit reporting, and upgrade integration.
    - Daemon compatibility tests for structured stale-layout errors.
    - Add at least one test/helper assertion proving executing migration fixtures are isolated from the protected live project paths. Manual test notes must name the temporary/disposable project path used, not either active repository path.

    Covers: @entity-folder-migration-and-compatibility ac-upgrade-dry-run-previews-layout, ac-upgrade-executes-folder-migration, ac-migration-preserves-record-identity-and-unknown-fields, ac-unmigrated-projects-are-blocked-with-guidance, ac-partial-folder-layouts-are-blocked

- title: Update daemon cache invalidation for folder-backed plan and review directories
  slug: task-folder-backed-plan-review-cache-invalidation
  priority: 5
  tags: [daemon, cache, plans, reviews]
  spec_ref: "@daemon-entity-cache"
  depends_on:
    - "@task-folder-backed-plan-storage-manager"
    - "@task-folder-backed-review-storage-manager"
  description: |
    What:
    - Implement the existing-spec AC added by @task-update-plan-review-storage-specs: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation.
    - Update daemon watcher/file-to-domain mapping so changes under `.kspec/plans/<plan-ulid>/` invalidate and reload the `plans` cache domain.
    - Update daemon watcher/file-to-domain mapping so changes under `.kspec/reviews/<review-ulid>/` invalidate and reload the `reviews` cache domain.
    - Keep existing `.kspec/project.plans.yaml` and `.kspec/project.reviews.yaml` parent-index invalidation behavior intact.
    - Treat `plan.md`, `plan.yaml`, `notes.yaml`, `resources.yaml`, and files under plan `resources/` as plan-domain changes.
    - Treat `review.yaml`, `resources.yaml`, and files under review `resources/` as review-domain changes.
    - Preserve @daemon-entity-cache ac-granular-reload: plan-folder changes reload only the plans domain, review-folder changes reload only the reviews domain, and unrelated domains are not reloaded.
    - Preserve @daemon-entity-cache ac-reload-dedup: multiple file events from one multi-file entity mutation coalesce to one reload per affected domain.

    Why:
    - Folder-backed plans and reviews move authoritative detail and resources out of the parent index files. Without directory-aware invalidation, the daemon can serve stale plan/review detail or resource summaries after a sidecar change.

    How:
    - Extend the existing file-to-domain/path classifier instead of adding ad hoc route-level invalidation.
    - Normalize changed paths relative to `.kspec/` before classification.
    - Match only full folder-backed roots (`plans/<ulid>/...` and `reviews/<ulid>/...`), not arbitrary filenames containing `plans` or `reviews`.
    - Reuse the existing domain-level debounce/reload flow; do not create a separate watcher for resources.

    Testing:
    - Add focused daemon entity-cache tests for changed paths `.kspec/plans/<ulid>/plan.md`, `.kspec/plans/<ulid>/resources.yaml`, `.kspec/plans/<ulid>/resources/ux.png`, `.kspec/reviews/<ulid>/review.yaml`, `.kspec/reviews/<ulid>/resources.yaml`, and `.kspec/reviews/<ulid>/resources/screenshot.png`.
    - Assert plan paths affect only the plans domain and review paths affect only the reviews domain.
    - Assert parent index files `.kspec/project.plans.yaml` and `.kspec/project.reviews.yaml` still invalidate their existing domains.
    - Run `npm test -- --run tests/daemon-entity-cache.test.ts` and `kspec validate --warnings-ok`.

    Covers: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation, ac-watcher-invalidation, ac-granular-reload, ac-reload-dedup

- title: Add plan import, resource attachment, and derivation semantics
  slug: task-plan-resource-import-and-derive
  priority: 5
  tags: [plans, resources, cli]
  spec_ref: "@plan-resource-derivation-semantics"
  depends_on:
    - "@task-plan-review-folder-storage-migration"
  description: |
    What:
    - Extend `kspec plan import <plan-md>` so any `./resources/<relative-path>` markdown link requires a sibling `resources.yaml` beside the imported markdown file; the manifest must declare each linked path with an explicit id, and import copies declared files from the sibling `resources/` directory into `.kspec/plans/<plan-ulid>/resources/`.
    - Extend `kspec plan set @plan --content-file <plan-md>` so `./resources/<relative-path>` markdown links must resolve against the existing plan `resources.yaml`; users attach resources before setting content that references them.
    - Extend the plan document manual task schema so each additional task may include `resource_refs: ["./resources/<relative-path>"]`; reject refs that do not resolve against the source plan's `resources.yaml` at derive time.
    - Add exact plan-resource CLI commands: `kspec plan resource add <plan-ref> <source-file> --id <resource-id> --path <relative-path> [--label <label>] [--description <text>] [--content-type <mime>] [--replace] [--json]`; `kspec plan resource list <plan-ref> [--json]`; `kspec plan resource get <plan-ref> <resource-id> [--json]`; `kspec plan resource remove <plan-ref> <resource-id> [--force] [--json]`.
    - Use the shared resource contract from @task-entity-local-resource-model: resource ids match `[a-z0-9][a-z0-9._-]{0,127}`; authoring references are `./resources/<relative-path>`; internal refs record owner type, owner ref, resource id, relative path, `sha256`, optional `git_commit`, and optional `git_path`; forbidden paths include absolute paths, parent traversal, backslashes, undeclared paths, and symlink escapes.
    - For plan resource add/import/set paths, apply the shared `content_type` rule: explicit values must be non-empty `type/subtype` tokens with no whitespace; omitted values are inferred from final resource path extension; unknown extensions store `application/octet-stream`.
    - `plan resource add` requires explicit `--id` and `--path`; id or path collisions fail with `resource_conflict` unless `--replace` is supplied. Replacement updates one existing resource id, replaces the file bytes and metadata, removes the old file if the path changes, and refuses to overwrite a different resource id's path. `remove` deletes the manifest entry and owned file; without `--force` it prompts in interactive mode and fails in non-interactive mode.
    - Define plan resource CLI `--json` success output exactly: `add` returns `{ "resource": <ResourceMetadata>, "replaced": boolean }`; `list` returns `{ "resources": <ResourceMetadata[]> }`; `get` returns `{ "resource": <ResourceMetadata> }`; `remove` returns `{ "removed": { "id": string, "path": string } }`. CLI JSON failures use `{ "error": string, "code": "invalid_resource_id"|"invalid_resource_path"|"source_file_missing"|"source_file_unreadable"|"resource_conflict"|"resource_not_found"|"plan_not_found"|"confirmation_required"|"operation_cancelled"|"entity_storage_incompatible", "message": string, "resource_id": string|null, "path": string|null, "source_file": string|null }`. Missing plan refs return `plan_not_found`; missing `<source-file>` returns `source_file_missing`; unreadable or non-regular `<source-file>` returns `source_file_unreadable`; non-interactive `remove` without `--force` returns `confirmation_required`; interactive remove answered no returns `operation_cancelled`. Exit codes follow @trait-semantic-exit-codes exactly: success exits 0; invalid id/path, source file failures, missing plan/resource, and conflicts exit 1; user cancellation exits 2; storage incompatibility or unexpected IO after validation exits 3.
    - Plan resource API routes and upload body shapes are owned by @task-plan-resource-api-ui-static, not this task.
    - During `kspec plan derive`, preserve plan resource references on derived tasks by default and record owner type, owner ref, resource id, relative path, content hash, and available git commit/path identity.
    - Add exact derivation flag `kspec plan derive ... --materialize-resources`; when present, copy each referenced resource into `.kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/<relative-path>`, add task resource manifest ids as `plan-<resource-id>`, and point the task reference at the task-owned copy. Without this flag, no resource bytes are copied.

    Why:
    - A UX plan may include screenshots or research PDFs that task workers need to consult. Default copying creates drift and duplicate bytes; unversioned links hide changes.

    How:
    - Keep plan resources plan-owned by default. Derived tasks get refs/pointers plus hash/git metadata, not copied files.
    - Ensure task detail/agent context can resolve plan-owned resources even when task storage remains task-owned.
    - Surface drift if the current plan resource hash no longer matches the hash recorded on the task.

    Testing:
    - CLI tests for `kspec plan resource add/list/get/remove`, required `--id`/`--path`, missing plan refs, missing/unreadable source files, `--replace` collisions, non-interactive remove without `--force`, interactive remove cancellation, invalid paths, `--json`, JSON error envelopes, and exact exit codes.
    - Parser/import/set tests for valid `resource_refs`, unresolved `resource_refs`, valid markdown links with sibling import manifest, unresolved markdown links during import, and unresolved markdown links during `plan set`.
    - Derive tests for default resource refs, hash/git version metadata, drift reporting, and exact `--materialize-resources` copy mode/path/id behavior.

    Covers: @plan-resource-derivation-semantics ac-plan-task-resource-refs-are-structured, ac-derived-task-keeps-plan-resource-reference, ac-derived-task-records-resource-version, ac-resource-drift-is-visible, ac-explicit-copy-mode-creates-task-owned-resource

- title: Update plan daemon API, cache, web UI, and static export for resources
  slug: task-plan-resource-api-ui-static
  priority: 5
  tags: [plans, daemon, web-ui]
  spec_ref: "@folder-backed-plan-storage"
  depends_on:
    - "@task-plan-resource-import-and-derive"
    - "@task-folder-backed-plan-review-cache-invalidation"
  description: |
    What:
    - Verify the daemon resource routes use the cache invalidation behavior implemented by @task-folder-backed-plan-review-cache-invalidation; do not add a second route-specific watcher.
    - Keep `/api/plans` list fast by using index/resource summaries only.
    - Keep `/api/plans/:ref` returning `PlanDetail.content` while adding resource summary data and safe resource fetch URLs.
    - Use this exact `ResourceMetadata` shape in every plan resource API response: `{ "id": string, "label": string|null, "path": string, "content_type": string, "bytes": number, "sha256": string, "git_commit": string|null, "git_path": string|null, "description": string|null }`.
    - For API uploads, apply the shared `content_type` rule: explicit multipart `content_type` values must be non-empty `type/subtype` tokens with no whitespace; omitted values are inferred from final resource path extension; unknown extensions store `application/octet-stream`.
    - Add exact authenticated/project-scoped plan resource endpoints using the shared resolver: `GET /api/plans/:ref/resources` returns HTTP 200 `{ "resources": <ResourceMetadata[]> }`; `GET /api/plans/:ref/resources/:resourceId` returns HTTP 200 `{ "resource": <ResourceMetadata> }`; `GET /api/plans/:ref/resources/:resourceId/bytes` returns HTTP 200 raw bytes with `Content-Type` and `X-Kspec-Resource-Sha256`; `POST /api/plans/:ref/resources` accepts `multipart/form-data` with file field `file` and text fields `id`, `path`, optional `label`, optional `description`, optional `content_type`, optional `replace`; `replace` is false when omitted, true only when the field value is exactly `true` or `1`, false when exactly `false` or `0`, and any other value fails with 400 `invalid_replace_value`; `DELETE /api/plans/:ref/resources/:resourceId` deletes the manifest entry and owned file.
    - Define plan resource API status/error mapping: POST create returns 201 `{ "resource": <ResourceMetadata>, "replaced": false }`; POST replace returns 200 `{ "resource": <ResourceMetadata>, "replaced": true }`; DELETE returns 200 `{ "removed": { "id": string, "path": string } }`; invalid id/path or missing fields return 400 with `invalid_resource_id`/`invalid_resource_path`; missing multipart `file` returns 400 `missing_resource_file`; invalid multipart `replace` returns 400 `invalid_replace_value`; missing plan or resource returns 404 with `plan_not_found`/`resource_not_found`; id/path collisions return 409 `resource_conflict`; incompatible storage returns HTTP 409 using the shared `entity_storage_incompatible` envelope from @task-entity-storage-version-compatibility-gates, including top-level error, domain-specific code, migration suggestion, and cache-domain context. Non-compatibility resource error bodies use `{ "error": string, "code": string, "message": string, "resource_id": string|null, "path": string|null }`.
    - Update web UI plan rendering so `./resources/<relative-path>` image/resource links are rewritten to safe plan-scoped resource URLs.
    - Update static JSON export/static UI so plan resources are copied under `assets/resources/plan/<plan-ulid>/<relative-path>` and markdown/resource metadata points at those exported paths.

    Why:
    - Moving content/resources out of the monolithic file must not regress the current plan UI, daemon route, cache, WebSocket invalidation, or static export behavior.

    How:
    - Do not load resource bytes for list routes or cache warm-up.
    - Serve only resolved entity-local resources through the shared resolver.
    - Keep markdown rendering fallback behavior for unresolved resources with visible guidance.

    Testing:
    - Daemon route tests for list/detail/resource metadata/resource bytes, multipart POST create/replace, missing multipart file, valid/invalid `replace` field values, DELETE, invalid id/path rejection, 404 missing plan/resource, 409 resource conflicts, and shared-envelope 409 incompatibility responses.
    - Web UI tests for plan markdown with a local image/resource link.
    - Static export tests for resource metadata and offline resource loading from `assets/resources/plan/<plan-ulid>/...`.

    Covers: @folder-backed-plan-storage ac-plan-document-sidecar-is-authoritative, ac-plan-index-has-bounded-projection, @trait-entity-scoped-local-resources ac-resource-reference-resolves-within-owner, ac-resource-metadata-exposes-safe-preview-fields, ac-path-escape-rejected, ac-static-export-copies-resource-assets

- title: Add review screenshot/evidence API and UI support
  slug: task-review-screenshot-resource-ui
  priority: 5
  tags: [reviews, daemon, web-ui]
  spec_ref: "@folder-backed-review-storage"
  depends_on:
    - "@task-plan-review-folder-storage-migration"
    - "@task-folder-backed-plan-review-cache-invalidation"
  description: |
    What:
    - Use the shared resource contract from @task-entity-local-resource-model: resource ids match `[a-z0-9][a-z0-9._-]{0,127}`; resource paths are POSIX-style paths below the review-owned `resources/` directory; forbidden paths include absolute paths, parent traversal, backslashes, undeclared paths, and symlink escapes; `ResourceMetadata` is `{ "id": string, "label": string|null, "path": string, "content_type": string, "bytes": number, "sha256": string, "git_commit": string|null, "git_path": string|null, "description": string|null }`.
    - For review resource CLI/API upload paths, apply the shared `content_type` rule: explicit values must be non-empty `type/subtype` tokens with no whitespace; omitted values are inferred from final resource path extension; unknown extensions store `application/octet-stream`.
    - Add exact review-resource CLI commands matching the plan resource shape: `kspec review resource add <review-ref> <source-file> --id <resource-id> --path <relative-path> [--label <label>] [--description <text>] [--content-type <mime>] [--replace] [--json]`; `kspec review resource list <review-ref> [--json]`; `kspec review resource get <review-ref> <resource-id> [--json]`; `kspec review resource remove <review-ref> <resource-id> [--force] [--json]`.
    - `review resource add` requires explicit `--id` and `--path`; id or path collisions fail with `resource_conflict` unless `--replace` is supplied. Replacement updates one existing resource id, replaces file bytes and metadata, removes the old file if the path changes, and refuses to overwrite a different resource id's path. `remove` deletes the manifest entry and owned file; without `--force` it prompts in interactive mode and fails in non-interactive mode.
    - Define review resource CLI `--json` success output exactly: `add` returns `{ "resource": <ResourceMetadata>, "replaced": boolean }`; `list` returns `{ "resources": <ResourceMetadata[]> }`; `get` returns `{ "resource": <ResourceMetadata> }`; `remove` returns `{ "removed": { "id": string, "path": string } }`. CLI JSON failures use `{ "error": string, "code": "invalid_resource_id"|"invalid_resource_path"|"source_file_missing"|"source_file_unreadable"|"resource_conflict"|"resource_not_found"|"review_not_found"|"confirmation_required"|"operation_cancelled"|"entity_storage_incompatible", "message": string, "resource_id": string|null, "path": string|null, "source_file": string|null }`. Missing review refs return `review_not_found`; missing `<source-file>` returns `source_file_missing`; unreadable or non-regular `<source-file>` returns `source_file_unreadable`; non-interactive `remove` without `--force` returns `confirmation_required`; interactive remove answered no returns `operation_cancelled`. Exit codes follow @trait-semantic-exit-codes exactly: success exits 0; invalid id/path, source file failures, missing review/resource, and conflicts exit 1; user cancellation exits 2; storage incompatibility or unexpected IO after validation exits 3.
    - Add exact review-resource daemon routes: `GET /api/reviews/:ref/resources` returns HTTP 200 `{ "resources": <ResourceMetadata[]> }`; `GET /api/reviews/:ref/resources/:resourceId` returns HTTP 200 `{ "resource": <ResourceMetadata> }`; `GET /api/reviews/:ref/resources/:resourceId/bytes` returns HTTP 200 raw bytes with `Content-Type` and `X-Kspec-Resource-Sha256`; `POST /api/reviews/:ref/resources` accepts `multipart/form-data` with file field `file` and text fields `id`, `path`, optional `label`, optional `description`, optional `content_type`, optional `replace`; `replace` is false when omitted, true only when the field value is exactly `true` or `1`, false when exactly `false` or `0`, and any other value fails with 400 `invalid_replace_value`; `DELETE /api/reviews/:ref/resources/:resourceId` deletes the manifest entry and owned file.
    - Define review resource API status/error mapping: POST create returns 201 `{ "resource": <ResourceMetadata>, "replaced": false }`; POST replace returns 200 `{ "resource": <ResourceMetadata>, "replaced": true }`; DELETE returns 200 `{ "removed": { "id": string, "path": string } }`; invalid id/path or missing fields return 400 with `invalid_resource_id`/`invalid_resource_path`; missing multipart `file` returns 400 `missing_resource_file`; invalid multipart `replace` returns 400 `invalid_replace_value`; missing review or resource returns 404 with `review_not_found`/`resource_not_found`; id/path collisions return 409 `resource_conflict`; incompatible storage returns HTTP 409 using the shared `entity_storage_incompatible` envelope from @task-entity-storage-version-compatibility-gates, including top-level error, domain-specific code, migration suggestion, and cache-domain context. Non-compatibility resource error bodies use `{ "error": string, "code": string, "message": string, "resource_id": string|null, "path": string|null }`.
    - Update review detail UI so screenshot/evidence resources can be previewed or opened from the review page.
    - Update static export so review resources are copied under `assets/resources/review/<review-ulid>/<relative-path>` and review metadata points at those exported paths.
    - Verify review resource routes and WebSocket broadcasts use the cache invalidation behavior implemented by @task-folder-backed-plan-review-cache-invalidation; do not add a second route-specific watcher.

    Why:
    - Review screenshots should be local to the review so UI and agents can load the same evidence without relying on external links.

    How:
    - Keep `external_links` for non-authoritative remote links; use first-party review resources for local evidence that should travel with the review.
    - Do not inline screenshots into review YAML or API list payloads.

    Testing:
    - CLI/API tests for `kspec review resource add/list/get/remove`, required `--id`/`--path`, missing review refs, missing/unreadable source files, `--replace` collisions, non-interactive remove without `--force`, interactive remove cancellation, invalid paths, `--json`, JSON error envelopes, exact exit codes, exact review resource routes, multipart POST create/replace, missing multipart file, valid/invalid `replace` field values, DELETE, resource bytes, 404 missing review/resource, 409 resource conflicts, and shared-envelope 409 incompatibility responses.
    - Web UI tests for rendering review resource summaries and previewing screenshot resources.
    - Static export test that review screenshots load from `assets/resources/review/<review-ulid>/...`.

    Covers: @folder-backed-review-storage ac-review-screenshot-resource-loads-in-ui, ac-review-index-has-bounded-projection, @trait-entity-scoped-local-resources ac-resource-reference-resolves-within-owner, ac-binary-resources-are-not-inlined-into-yaml, ac-static-export-copies-resource-assets

- title: Document resource references and folder-backed entity maintenance
  slug: task-folder-backed-resources-docs
  priority: 5
  tags: [docs, resources]
  spec_ref: "@folder-backed-resource-documentation"
  depends_on:
    - "@task-plan-resource-api-ui-static"
    - "@task-review-screenshot-resource-ui"
  description: |
    What:
    - Document the exact folder layouts for plans and reviews: `.kspec/project.plans.yaml` and `.kspec/project.reviews.yaml` remain lean indexes; `.kspec/plans/<plan-ulid>/` contains `plan.md`, `plan.yaml`, optional `notes.yaml`, `resources.yaml`, and `resources/`; `.kspec/reviews/<review-ulid>/` contains cohesive `review.yaml`, `resources.yaml`, and `resources/`.
    - Document the exact `resources.yaml` / `ResourceMetadata` fields: `id`, `label`, `path`, `content_type`, `bytes`, `sha256`, `git_commit`, `git_path`, and `description`; document resource id pattern `[a-z0-9][a-z0-9._-]{0,127}` and path restrictions.
    - Document `./resources/<relative-path>` authoring references, plan-task `resource_refs`, normalized internal resource references, static export paths, and daemon/API resource URLs.
    - Document the copy-vs-reference rule: derived tasks keep versioned references to plan-owned resources by default, including content hash and git identity; `kspec plan derive ... --materialize-resources` is the only mode that copies bytes into `.kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/<relative-path>` using ids `plan-<resource-id>`.
    - Update release notes and upgrade docs for the `kynetic: "1.2"` storage-format change.
    - Add troubleshooting guidance for stale indexes, missing resources, drifted resource hashes, `entity_storage_incompatible`, and partial folder layouts.

    Why:
    - Resource references are a new cross-cutting concept. Users and agents need a stable convention, not ad hoc local file paths.

    How:
    - Use examples: plan research PDF, plan UX screenshot, plan task `resource_refs`, review screenshot, review log/evidence file.
    - Keep docs format-neutral where possible; avoid telling users to edit `.kspec` internals manually except where documenting the storage format itself.

    Testing:
    - Run docs checks if applicable.
    - Run focused CLI help/documentation tests if command help output changes.

    Covers: @folder-backed-resource-documentation ac-resource-docs-name-exact-interfaces, ac-upgrade-docs-explain-compatibility-gate
```

## Implementation Notes

### Final conversion scope

- Convert plans first. Plan documents are already markdown, already long-lived, already reviewed, and naturally own design/research/supporting artifacts.
- Convert reviews second, but keep the first folder-backed review layout simple. The main gain is review-local screenshots/evidence; split review threads/events/checks/verdicts/notes only if a later measured need justifies that complexity.
- Do not convert inbox in this plan. Inbox is intentionally small text capture and should be cleared by triage.
- Do not convert triage unless triage becomes an evidence-owning artifact. For now it can reference resources owned by plans/reviews/tasks/specs.
- Do not broadly convert meta. Skills already have the right folder/resource model. Other meta types are small enough for manifest/include storage until proven otherwise.
- Sessions are not a conversion target; they are a precedent for blob pointer metadata and bounded previews.

### Shared traits

This plan adds reusable traits instead of making folder/resource behavior plan- or review-specific:

- `@trait-folder-backed-entity` owns per-ULID directories, bounded index projections, unknown-file preservation, and index rebuild behavior.
- `@trait-entity-scoped-local-resources` builds on that folder trait and owns resource manifests, safe path resolution, metadata projection, delete behavior, static export copying, and git/content-version metadata.

Tasks already satisfy much of the folder-backed trait in practice; implementation should extract or formalize that behavior rather than fork it for plans and reviews.

### Git-backed resource versioning

Because kspec state is stored in git, resource manifests do not need their own history model. A resource reference records `sha256` and, when available, `git_commit` plus repository-relative `git_path`. Drift detection compares the recorded identity to current working/shadow state instead of maintaining a parallel per-resource revision log.

### Chosen folder layouts

```text
.kspec/
  kynetic.yaml                    # kynetic: "1.2" + storage format fields
  project.plans.yaml              # lean plan index
  plans/
    <plan-ulid>/
      plan.md                     # authoritative markdown content
      plan.yaml                   # bounded plan metadata
      notes.yaml                  # optional plan notes/work log
      resources.yaml              # resource manifest, bounded metadata
      resources/
        research.pdf
        ux/empty-state.png

  project.reviews.yaml            # lean review index
  reviews/
    <review-ulid>/
      review.yaml                 # full cohesive ReviewRecord detail
      resources.yaml              # resource manifest, bounded metadata
      resources/
        screenshots/failure.png
        logs/test-output.txt
```

### Resource manifest and reference syntax

Each entity-local `resources.yaml` has this shape:

```yaml
resources:
  - id: ux-empty-state
    label: Empty state screenshot
    path: ux/empty-state.png
    content_type: image/png
    bytes: 12345
    sha256: <hex>
    git_commit: <commit-or-null>
    git_path: .kspec/plans/<plan-ulid>/resources/ux/empty-state.png
    description: Optional human context
```

Accepted authoring references in plan/review markdown and plan task `resource_refs` are `./resources/<relative-path>` entries. Internal references normalize to owner type, owner ref, resource id, manifest path, content hash, and git commit/path identity. Raw absolute paths, parent traversal, undeclared resource paths, and symlink escapes are rejected.

### Derivation copy-vs-reference decision

Default to keeping a versioned reference to the plan resource, not copying bytes into the task. Reasons:

- The plan is the reviewed context bundle and should remain the canonical owner of research/UX references.
- Copying every referenced image/PDF into every derived task creates duplicate bytes and drift.
- A task can still be standalone if the task body includes explicit resource refs and the agent resolver knows how to fetch them.
- Hash/git-version metadata lets the UI/agent report drift if someone changes the plan resource after derivation.

Explicit materialize/copy mode is available only when requested on derivation and creates task-owned resource copies.

### Migration and compatibility decision

This plan follows the task-storage compatibility model but applies it to plan/review/resource storage:

- New format marker: `kynetic: "1.2"`.
- Required manifest fields: `task_storage.format: split`, `plan_storage.format: folder`, `review_storage.format: folder`, `resource_storage.format: entity_scoped`.
- `kspec upgrade --dry-run` previews the exact file moves and manifest changes.
- `kspec upgrade` performs the migration and commits one logical shadow mutation.
- Normal plan/review/resource commands do not opportunistically migrate old projects.
- A newer kspec that requires folder-backed plan/review/resource behavior blocks incompatible projects with `entity_storage_incompatible` and guidance to run `kspec upgrade` or use a kspec version compatible with the current manifest.
- Rollback guidance is git-based: the upgrade output reports the previous shadow commit. The migration does not create parallel backup files that duplicate git history.

### Migration test isolation and live-project tripwire

During this plan's implementation/review work, `/home/chapel/Projects/kynetic-spec` and `/home/chapel/Projects/kynetic-spec-dispatch` are protected live projects. They may be inspected and dry-run diagnostics may be used when they do not mutate state, but agents must not run executing migration/upgrade commands against either live project or its `.kspec` worktree. Manual and exploratory migration tests must use temp directories, checked-in fixtures, or explicitly disposable copies whose paths are verified before writes begin.

If any worker or reviewer detects that either protected live project was migrated by this plan's work — for example `kynetic: "1.2"`, `plan_storage.format: folder`, `review_storage.format: folder`, or unexpected `.kspec/plans/` / `.kspec/reviews/` directories appear — the agent must stop the current task, make no further writes to that project, and report the exact path plus observed marker. Recovery is intentionally left to Jacob; agents must not hide the issue by reverting or cleanup scripts.

### Final command and route decisions

- Plan resources use `kspec plan resource add|list|get|remove`; review resources use `kspec review resource add|list|get|remove`. `add` always requires explicit `--id` and `--path`. Collisions fail unless `--replace` is present. `remove` requires `--force` in non-interactive mode.
- Plan resource routes are `/api/plans/:ref/resources`, `/api/plans/:ref/resources/:resourceId`, and `/api/plans/:ref/resources/:resourceId/bytes`, with `POST` on the collection and `DELETE` on the resource id. Review resource routes mirror this under `/api/reviews/:ref/resources`.
- Resource identifiers are explicit, stable ids matching `[a-z0-9][a-z0-9._-]{0,127}`. Resource paths use POSIX-style relative paths under the owner `resources/` directory; they must not start with `/`, contain `..`, contain `\`, or resolve through symlinks outside the resource root.
- `<ResourceMetadata>` means `{ "id": string, "label": string|null, "path": string, "content_type": string, "bytes": number, "sha256": string, "git_commit": string|null, "git_path": string|null, "description": string|null }`.
- `content_type` is always populated: explicit CLI/API values must be non-empty `type/subtype` tokens with no whitespace; omitted values are inferred from the final resource path extension; unknown extensions use `application/octet-stream`.
- CLI and API resource errors share codes where their transports overlap: `invalid_resource_id`, `invalid_resource_path`, `resource_conflict`, `resource_not_found`, `plan_not_found`, `review_not_found`, and `entity_storage_incompatible`. CLI-only add/remove errors include `source_file_missing`, `source_file_unreadable`, `confirmation_required`, and `operation_cancelled`; API-only multipart errors include `missing_resource_file` and `invalid_replace_value`. API `entity_storage_incompatible` always uses the shared storage-compatibility envelope rather than the resource-error envelope.
- Rebuild-index JSON for plans/reviews uses one shared envelope with `domain`, `status`, `dry_run`, `repair`, `force`, `summary`, `changes`, and `conflicts`; status is `clean`, `drift`, `repaired`, or `blocked`.
- Plan import validates `./resources/` links against a sibling `resources.yaml` plus sibling `resources/` directory. Plan set validates links against the existing plan manifest. Plan derive validates task `resource_refs` against the source plan manifest.
- The only task-resource materialization flag is `kspec plan derive ... --materialize-resources`. Default derivation keeps versioned plan-owned references.
- Rebuild commands are exact per-domain commands: `kspec plan rebuild-index` and `kspec review rebuild-index`, with `--dry-run`, `--repair`, `--force`, and `--json`. There is no unspecified shared alternative in this plan.

### Main implementation risks

- Existing specs hard-code `project.plans.yaml` and `project.reviews.yaml`; those must be updated first.
- `PlanSchema.content` is inline today, and many consumers expect `PlanDetail.content`; the manager/API should preserve that logical detail field while changing physical storage.
- `plan derive` currently parses `foundPlan.content`; storage manager detail loading must provide the current markdown before derivation.
- Entity cache and web invalidation only watch monolithic file paths today.
- Migration must preserve unknown fields and raw shape well enough to avoid losing data from older files.
- Static export must copy resource files to deterministic exported asset paths so the static UI can load images/PDFs offline.
