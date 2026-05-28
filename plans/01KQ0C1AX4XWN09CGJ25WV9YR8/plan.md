# Seed Plan 6: Spec-Tied Code Quality Refactors

Status: seed planning record / non-derivable  
Program charter: `cruft-cleanup-program-charter`  
Depends on: earlier spec cleanup plans, especially validation trust and relevant contract split plans  
Future derive-ready plan candidate slug: `spec-tied-code-quality-refactors`

## Purpose

This seed covers code-quality refactors that make spec verification fragile. These should not be done as an unbounded cleanup sweep. Each real plan should tie code changes to cleaned specs or explicit architectural constraints.

This seed may split into multiple real plans because the areas are independent enough to review separately.

## High-Impact Code Findings

### Validation bypasses TaskDataManager

Finding: `src/parser/validate.ts` discovers task YAML and parses task data directly instead of using `TaskDataManager`.

Risk: split-task storage validation can drift from the real task model and weaken spec/task/AC reference validation.

Relevant spec ties:

- `@task-data-manager`
- split task storage specs
- validation/reference/completeness specs

### Daemon mutations are not consistently serialized

Finding: daemon task API routes mutate state directly while `/api/command` uses the canonical mutation lock path.

Evidence paths:

- `packages/daemon/src/routes/tasks.ts`
- `packages/daemon/src/routes/command.ts`

Risk: route-level mutations, CLI commands, command API, and dispatch agents can race on shadow state.

### Entity cache unlink/delete handling is fragile

Finding: entity cache removal paths can attempt to load removed files and may lack robust per-file error recovery.

Evidence path:

- `src/daemon/entity-cache.ts`

Risk: deletion can leave stale cache state or unhandled rejection risk.

### Web UI API client is overgrown and inconsistent

Finding: `packages/web-ui/src/lib/api.ts` is about 2.5k lines and duplicates fetch/envelope/error handling. Some refs are interpolated directly into paths while others are encoded.

Risk: inconsistent URL encoding, non-JSON error assumptions, and harder-to-test freshness behavior.

### Unbounded list fetches conflict with project convention

Finding: dashboard/board code fetches full lists for counts/aggregates.

Evidence examples:

- `packages/web-ui/src/routes/+page.svelte`
- task board/list code paths

Risk: conflicts with convention that API list endpoints should be paginated and server-side aggregation should be used for computed stats.

### Docs search excerpt safety

Finding: `DocsSearch.svelte` renders Pagefind excerpts with raw `{@html}` while other paths sanitize markdown/rendered content.

Risk: potential XSS/sanitization inconsistency.

### Test suite cleanup

Findings:

- skipped tests claim or relate to AC coverage,
- `tests/agent-dispatch-engine.test.ts` is about 7.4k lines,
- `tests/web-ui-session-stream.test.ts` is about 2.5k lines,
- several large aggregate tests make behavior ownership hard to review.

## Future Plan Boundaries

This seed should likely split into these real plans:

1. **Validation Read Path Refactor** — make validation use `TaskDataManager` and strengthen split-format reference/coverage checks.
2. **Daemon Mutation and Cache Safety** — centralize daemon mutation serialization and deletion/cache invalidation behavior.
3. **Web UI Data Client and Freshness Refactor** — extract request/path helpers, normalize ref encoding, align query invalidation.
4. **Test Verification Cleanup** — unskip/migrate AC-related tests and split oversized behavior aggregates.

Do not try to implement all four in one plan unless the final scope proves smaller than expected.

## Candidate Specs for Future Plans

Add or update specs only where behavior/architecture changes are needed:

- Validation reads all task storage formats through the canonical task data manager.
- Daemon state mutations are serialized through one mutation boundary.
- Entity cache deletion/unlink events remove stale entries and report degraded state predictably.
- Web API client encodes refs safely and handles non-JSON errors consistently.
- Dashboard aggregate data is loaded through bounded or server-aggregated endpoints.
- Search result HTML/excerpts are sanitized before rendering.
- Skipped tests cannot satisfy AC coverage, if this becomes validation behavior.

## Candidate Tasks

- Refactor validation task reads through `TaskDataManager` and add regression tests.
- Centralize daemon mutation serialization for direct route mutations.
- Add entity cache unlink/delete regression tests and fix stale cache behavior.
- Extract Web UI request/path builder and ref encoding helper.
- Replace unbounded dashboard/list fetches with aggregation endpoints or bounded queries.
- Sanitize Pagefind excerpts.
- Split oversized test files by behavior and remove or justify skipped AC tests.

## Review Risks

- Reviewer may block if code cleanup is not tied to specs or explicit architectural constraints.
- Reviewer may block if a task says “refactor” without exact behavior preservation and verification strategy.
- Reviewer may block if one plan combines unrelated daemon, web, validation, and test changes.
- Reviewer may block if performance/maintainability work is framed as product behavior without observable effect.

## Conversion Checklist

Before converting this seed:

1. Check which earlier spec cleanup plans have landed and use their cleaned specs as anchors.
2. Split into narrower plans if more than one subsystem is involved.
3. For each refactor, define behavior-preservation tests and any new behavior specs.
4. Use `npm test -- --run <focused tests>` for targeted verification; do not invoke vitest directly.
5. Keep task descriptions standalone with file paths, why, how, testing, and Covers lines.
