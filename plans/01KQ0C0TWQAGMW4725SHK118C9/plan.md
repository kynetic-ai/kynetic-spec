# Seed Plan 3: Trait Normalization

Status: seed planning record / non-derivable  
Program charter: `cruft-cleanup-program-charter`  
Depends on: `spec-catalog-health-validation-trust`, `backfill-process-spec-retirement`  
Future derive-ready plan candidate slug: `trait-normalization`

## Purpose

This seed covers cleanup of broad, conflicting, or misapplied traits. Traits are inherited contracts; if a trait is too broad or wrong, every inheriting spec becomes harder to reason about and review.

Trait cleanup should happen before broad spec rewrites because downstream specs should inherit precise contracts, not today’s broad/noisy ones.

## Known Trait Problems

### Semantic exit code conflict

- `@trait-semantic-exit-codes` conflicts with `@cli-exit-codes`.
- Audit finding: the trait says validation errors return exit code `1`, while canonical CLI exit-code behavior defines distinct codes such as validation and not-found cases.

Likely cleanup: make the trait refer to the canonical exit-code mapping behavior or split/remove the conflicting ACs.

### Filterable list is too broad

- `@trait-filterable-list` bundles filtering, pagination, count mode, summary output, and filter combination semantics.

Likely cleanup: split into narrower traits such as:

- filtering,
- pagination,
- count mode,
- empty-result reporting,
- filter composition.

### API and WebSocket traits are too broad

- `@trait-api-endpoint` can impose generic API obligations on endpoints where only some apply.
- `@trait-websocket-protocol` mixes subscription, event envelope, heartbeat, backpressure, close codes, and reconnect behavior.

Likely cleanup: split API response envelope, API pagination, mutation persistence, request IDs, WebSocket subscription, heartbeat, backpressure, close semantics, and reconnect semantics.

### Markdown traits need safety/rendering separation

- Audit flagged markdown rendering/safety concerns, especially Pagefind excerpts rendered via `{@html}`.

Likely cleanup: separate “markdown rendering output shape” from “unsafe HTML sanitization / trusted HTML boundary” behavior.

### Type-safe input boundary may be a constraint

- `@trait-type-safe-input` broadly mandates schema-derived validation for input boundaries.

Decision needed: should this remain a trait applied to specific input surfaces, or become a cross-cutting constraint/decision about validation architecture?

### Idempotent file scaffold has compound ACs

- `@trait-idempotent-file-scaffold ac-force-backs-up-before-overwrite` contains multiple outcomes in one AC.
- It should remain scoped only to file scaffolds and not meta-item scaffolds.

## Future Plan Boundaries

Include:

- audit trait definitions and current inheritors,
- resolve direct contradictions,
- split broad traits into smaller traits where needed,
- update inheriting specs to use only traits whose full AC set applies,
- split compound trait ACs,
- document trait scope decisions.

Exclude:

- full command spec rewrite,
- API/daemon/web spec split beyond trait extraction needed for later plans,
- code changes unless validation/rendering behavior must change for trait correctness.

## Candidate Specs for Future Plan

Potential new or revised trait specs:

- CLI exit-code mapping trait or decision tied to `@cli-exit-codes`.
- List filtering trait.
- List pagination trait.
- Count-only output trait.
- API response envelope trait.
- API request ID / traceability trait.
- WebSocket subscription trait.
- WebSocket heartbeat trait.
- WebSocket backpressure trait.
- Markdown safety/sanitization trait.
- Markdown rendering trait.

Each trait must be narrow enough that every inherited AC applies wherever the trait is used.

## Candidate Tasks for Future Plan

- List all traits and inheritors with `kspec item list --type trait` and item detail lookups.
- Resolve `@trait-semantic-exit-codes` conflict with `@cli-exit-codes`.
- Split broad traits and reapply inheritors.
- Remove misapplied traits from specs with conflicting semantics.
- Split compound trait ACs and update Covers/annotations.
- Run validation and targeted tests for trait inheritance/display/coverage.

## Review Risks

- Reviewer may block if new traits are still too broad.
- Reviewer may block if a trait is applied before its ACs are verified against each inheritor.
- Reviewer may block if trait splitting leaves dangling refs or unresolved inherited coverage.
- Reviewer may block if exact exit-code values are duplicated in multiple specs instead of centralized.

## Conversion Checklist

Before converting this seed:

1. Complete Plan 1 so trait validation is not polluted by broken refs/test traits.
2. Run `kspec item list --type trait` and inspect each trait’s inheritors.
3. For each proposed split, identify all specs that will gain/lose inherited ACs.
4. Confirm whether `@cli-exit-codes` is the canonical source for exit-code values.
5. Decide whether type-safe input belongs as trait, constraint, or both.
