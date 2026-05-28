# Seed Plan 5: API, Daemon, and Web UI Contract Split

Status: seed planning record / non-derivable  
Program charter: `cruft-cleanup-program-charter`  
Depends on: `spec-catalog-health-validation-trust`, `trait-normalization`  
Future derive-ready plan candidate slug: `api-daemon-web-contract-split`

## Purpose

This seed covers oversized/stale API, daemon, WebSocket, cache, and Web UI specs. The goal is to split umbrella specs into smaller behavior-level contracts that match current implementation or intentionally drive code changes.

## Known Problem Specs

Mega/umbrella specs called out by the audit:

- `@api-contract` — about 40 ACs and stale list response assumptions.
- `@daemon-server` — broad server lifecycle, watcher, WebSocket, static UI, health/debug endpoints, inherited traits.
- `@daemon-entity-cache` — broad cache model and behavior.
- `@multi-directory-daemon` — 43 ACs.
- `@web-dashboard` — 34 ACs.
- `@dispatch-remote-branch-sync` — 48 ACs, may be separate from API/Web but shares mega-spec risk.

## Verified Alignment Issues

### API response envelope drift

`@api-contract` says some endpoints return JSON arrays, including examples like `GET /api/tasks` and `GET /api/items`. Current shared/API code uses normalized envelopes and metadata.

Evidence paths:

- `packages/shared/src/api.ts`
- `packages/daemon/src/routes/response-envelope.ts`

### WebSocket/UI freshness topic drift

Audit found route-local subscriptions using topics like `tasks` while centralized invalidation uses `tasks:updates`. Similar mismatch was reported for reviews.

Evidence paths:

- `packages/web-ui/src/routes/tasks/+page.svelte`
- `packages/web-ui/src/lib/query/ws-invalidation.ts`

Relevant specs:

- `@ui-data-freshness`
- `@automation-event-stream`
- `@ui-automation-view`

### Missing or weak spec candidates

Audit identified real behavior needing stronger spec ownership:

- shared API envelope and error model,
- Web UI query/cache invalidation behavior,
- dashboard bounded aggregation/count loading,
- docs search excerpt safety,
- API pagination and request metadata,
- WebSocket subscription/event topic behavior.

## Future Plan Boundaries

Include:

- split or rewrite `@api-contract` around current envelope/pagination/error/request-id behavior,
- split WebSocket behavior into narrower specs/traits if not already done,
- normalize topic names and data freshness behavior,
- split daemon server/cache specs into reviewable behavior slices,
- add missing specs for shared API envelope, query invalidation, and dashboard aggregation,
- update targeted code/tests only where code is wrong relative to the cleaned contract.

Exclude:

- general CLI/schema rewrite,
- broad daemon mutation/cache safety refactors unless required to satisfy contract split,
- full Web UI redesign,
- generic test-suite cleanup not tied to API/daemon/web behavior.

## Candidate Specs for Future Plan

Potential behavior-level specs:

- API response envelope contract.
- API pagination metadata contract.
- API error response contract.
- Request ID / tracing header contract.
- WebSocket topic subscription contract.
- WebSocket event envelope contract.
- WebSocket heartbeat/close semantics contract.
- Web UI query invalidation contract.
- Dashboard bounded aggregation contract.
- Daemon health/debug cache status contract.
- Static Web UI serving contract.
- File watcher event propagation contract.

## Candidate Tasks for Future Plan

- Rewrite/split `@api-contract` and migrate AC coverage.
- Add or update shared API envelope specs and tests.
- Normalize WebSocket topic names across specs, daemon, Web UI, and tests.
- Split `@daemon-server` into server lifecycle, health/static serving, watcher, WebSocket, and debug/cache status specs.
- Split `@daemon-entity-cache` into loading/readiness/invalidation/degraded-state specs.
- Add dashboard aggregation endpoints or update UI to use existing bounded endpoints.
- Add focused tests for Web UI data freshness and route-local topic subscriptions.

## Review Risks

- Reviewer may block if the plan is still too broad. Consider splitting this seed into API-only and daemon/web-ui-only plans if the final spec count grows too large.
- Reviewer may block if fields/status codes are specified as implementation details instead of external API contracts.
- Reviewer may block if tasks claim UI freshness without dependency on WebSocket/topic specs.
- Reviewer may block if dashboard aggregation is treated as pure performance infra when it is a user-visible freshness/loading behavior.

## Conversion Checklist

Before converting this seed:

1. Complete trait normalization for API/WebSocket/list traits or inline only the contracts needed here.
2. Inspect current `@api-contract`, `@daemon-server`, `@daemon-entity-cache`, `@multi-directory-daemon`, and `@web-dashboard` details.
3. Inventory current daemon route response shapes and shared API types.
4. Inventory WebSocket topics from daemon, shared types, and Web UI invalidation code.
5. Decide whether to split into more than one real plan based on final scope.
