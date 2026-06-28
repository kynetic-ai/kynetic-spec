import { Elysia, t } from "elysia";
import { ulid } from "ulidx";
import { SPEC_WORKSPACE_MAX_PAGE_SIZE } from "@kynetic-ai/shared";
import type {
  CoverageBucketCounts,
  CoverageCriterionStateDetail,
  CoverageItemStateSummary,
  CoverageStateSnapshot,
  SpecWorkspaceChildSection,
  SpecWorkspaceCriterionDetailProjection,
  SpecWorkspaceCriterionSummary,
  SpecWorkspaceLinkedWorkGroup,
  SpecWorkspaceLinkedWorkItem,
  SpecWorkspaceNodeDetailProjection,
  SpecWorkspaceNodeSummary,
  SpecWorkspacePagination,
  SpecWorkspaceRootProjection,
  SpecWorkspaceUnavailableSection,
} from "@kynetic-ai/shared";
import {
  AlignmentIndex,
  ReferenceIndex,
  getCachedCoverageStateReadModel,
  initContext,
  loadAllItems,
  loadPlans,
  resolveTaskDataManager,
  type LoadedPlan,
  type LoadedSpecItem,
  type LoadedTask,
} from "../../parser/index.js";
import {
  buildItemAncestors,
  computeItemParentMap,
  indexItemsByUlid,
} from "../../lib/breadcrumb-ancestry.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import { getRelatedSessionsForItem } from "./session-related.js";
import { wrapResponse } from "./response-envelope.js";

interface SpecWorkspaceRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

interface Pagination {
  limit: number;
  offset: number;
}

interface PaginationValidationError {
  field: "limit" | "offset";
  message: string;
}

interface ProjectionContext {
  projectPath: string;
  cacheDomainState: string | undefined;
  items: LoadedSpecItem[];
  tasks: LoadedTask[];
  plans: LoadedPlan[];
  coverage: CoverageStateSnapshot;
  parentMap: Map<string, string | undefined>;
  childrenByParent: Map<string | undefined, LoadedSpecItem[]>;
  itemByUlid: Map<string, LoadedSpecItem>;
  refIndex: ReferenceIndex;
  alignment: AlignmentIndex;
  sessionsDir: string;
  sessionLinksByItemUlid: Map<string, Promise<SpecWorkspaceLinkedWorkItem[]>>;
  getEntityCache?: EntityCacheAccessor;
}

function emptyCounts(): CoverageBucketCounts {
  return { covered: 0, failing: 0, not_yet: 0, re_verify: 0 };
}

function emptyCoverageSummary() {
  return {
    counts: emptyCounts(),
    denominator: 0,
    latest_run_id: null,
    unmapped_result_count: 0,
    invalid_result_count: 0,
  };
}

function parsePagination(query: {
  limit?: string;
  offset?: string;
}): { ok: true; pagination: Pagination } | { ok: false; error: PaginationValidationError } {
  const parse = (
    field: "limit" | "offset",
    fallback: number,
  ): { ok: true; value: number } | { ok: false; error: PaginationValidationError } => {
    const value = query[field];
    if (value === undefined) return { ok: true, value: fallback };
    if (!/^\d+$/.test(value)) {
      return {
        ok: false,
        error: { field, message: `${field} must be a non-negative integer` },
      };
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      return {
        ok: false,
        error: { field, message: `${field} must be a non-negative integer` },
      };
    }
    if (field === "limit" && parsed > SPEC_WORKSPACE_MAX_PAGE_SIZE) {
      return {
        ok: false,
        error: {
          field,
          message: `limit must be less than or equal to ${SPEC_WORKSPACE_MAX_PAGE_SIZE}`,
        },
      };
    }
    return { ok: true, value: parsed };
  };
  const limit = parse("limit", 50);
  if (!limit.ok) return { ok: false, error: limit.error };
  const offset = parse("offset", 0);
  if (!offset.ok) return { ok: false, error: offset.error };
  return { ok: true, pagination: { limit: limit.value, offset: offset.value } };
}

function paginationMeta(total: number, pagination: Pagination): SpecWorkspacePagination {
  return {
    total,
    offset: pagination.offset,
    limit: pagination.limit,
    has_more: pagination.offset + pagination.limit < total,
  };
}

function validationError(validation: PaginationValidationError) {
  return {
    error: "validation_error",
    details: [{ field: validation.field, message: validation.message }],
    suggestion: "Use non-negative integer pagination parameters.",
  };
}

function unavailable(
  kind: SpecWorkspaceUnavailableSection["kind"],
  reason: string,
  suggestion: string,
): SpecWorkspaceUnavailableSection {
  return { kind, status: "unavailable", reason, suggestion };
}

function notFound(ref: string, kind = "Spec workspace node") {
  return {
    error: "not_found",
    message: `${kind} reference "${ref}" was not found.`,
    suggestion: "Use kspec search or GET /api/items to find a valid spec reference.",
  };
}

function criterionNotFound(ref: string, acId: string) {
  return {
    error: "not_found",
    message: `Acceptance criterion "${acId}" was not found on spec item "${ref}".`,
    suggestion: "Refresh the workspace or open the parent spec node to see available criteria.",
  };
}

function resolveItem(ctx: ProjectionContext, ref: string): LoadedSpecItem | null {
  const resolved = ctx.refIndex.resolve(ref);
  if (!resolved.ok) return null;
  return ctx.items.find((item) => item._ulid === resolved.ulid) ?? null;
}

function coverageForItem(
  coverage: CoverageStateSnapshot,
  item: Pick<LoadedSpecItem, "_ulid" | "slugs">,
): CoverageItemStateSummary | null {
  const direct = coverage.items[item._ulid] ?? coverage.items[`@${item._ulid}`];
  if (direct) return direct;
  const refs = new Set<string>([item._ulid, `@${item._ulid}`]);
  for (const slug of item.slugs) {
    refs.add(slug);
    refs.add(`@${slug}`);
  }
  return (
    Object.values(coverage.items).find(
      (entry) => refs.has(entry.item_ref) || entry.item_ulid === item._ulid,
    ) ?? null
  );
}

function coverageForCriterion(
  coverage: CoverageStateSnapshot,
  item: LoadedSpecItem,
  acId: string,
): CoverageCriterionStateDetail | null {
  const itemCoverage = coverageForItem(coverage, item);
  if (!itemCoverage) return null;
  return (
    coverage.criteria[`${itemCoverage.item_ulid} ${acId}`] ??
    itemCoverage.criteria.find((criterion) => criterion.ac_id === acId) ??
    null
  );
}

function taskRef(task: Pick<LoadedTask, "_ulid" | "slugs">): string {
  return task.slugs[0] ? `@${task.slugs[0]}` : `@${task._ulid}`;
}

function itemRef(item: Pick<LoadedSpecItem, "_ulid" | "slugs">): string {
  return item.slugs[0] ? `@${item.slugs[0]}` : `@${item._ulid}`;
}

function taskToLinkedWork(task: LoadedTask): SpecWorkspaceLinkedWorkItem {
  return {
    kind: "task",
    ref: taskRef(task),
    title: task.title ?? null,
    status: task.status ?? null,
    created_at: task.created_at ?? null,
    updated_at: task.updated_at ?? null,
  };
}

function planToLinkedWork(plan: LoadedPlan): SpecWorkspaceLinkedWorkItem {
  return {
    kind: "plan",
    ref: plan.slugs[0] ? `@${plan.slugs[0]}` : `@${plan._ulid}`,
    title: plan.title ?? null,
    status: plan.status ?? null,
    created_at: plan.created_at ?? null,
    updated_at: plan.updated_at ?? null,
  };
}

function linkedTasks(ctx: ProjectionContext, item: LoadedSpecItem): LoadedTask[] {
  return ctx.alignment.getTasksForSpec(item._ulid);
}

function linkedPlans(ctx: ProjectionContext, item: LoadedSpecItem): LoadedPlan[] {
  const refs = new Set<string>([item._ulid, `@${item._ulid}`]);
  for (const slug of item.slugs) {
    refs.add(slug);
    refs.add(`@${slug}`);
  }
  return ctx.plans.filter((plan) =>
    plan.derived_specs.some(
      (ref) => refs.has(ref) || refs.has(ref.startsWith("@") ? ref : `@${ref}`),
    ),
  );
}

async function linkedSessions(
  ctx: ProjectionContext,
  item: LoadedSpecItem,
): Promise<SpecWorkspaceLinkedWorkItem[]> {
  const cached = ctx.sessionLinksByItemUlid.get(item._ulid);
  if (cached) return cached;

  const promise = getRelatedSessionsForItem({
    itemRef: itemRef(item),
    items: ctx.items,
    tasks: ctx.tasks,
    sessionsDir: ctx.sessionsDir,
    getEntityCache: ctx.getEntityCache,
    projectPath: ctx.projectPath,
  }).then((sessionsResult) =>
    "sessions" in sessionsResult
      ? sessionsResult.sessions.map((session) => ({
          kind: "session" as const,
          ref: session.id,
          title: session.title ?? null,
          status: session.status ?? null,
          created_at: session.started_at ?? null,
          updated_at: session.updated_at ?? null,
        }))
      : [],
  );

  ctx.sessionLinksByItemUlid.set(item._ulid, promise);
  return promise;
}

async function linkedWorkCounts(ctx: ProjectionContext, item: LoadedSpecItem) {
  const sessions = await linkedSessions(ctx, item);
  return {
    task: linkedTasks(ctx, item).length,
    session: sessions.length,
    plan: linkedPlans(ctx, item).length,
    review: 0,
    observation: 0,
  };
}

async function toNodeSummary(
  ctx: ProjectionContext,
  item: LoadedSpecItem,
): Promise<SpecWorkspaceNodeSummary> {
  const coverage = coverageForItem(ctx.coverage, item);
  return {
    ref: itemRef(item),
    _ulid: item._ulid,
    slugs: item.slugs,
    title: item.title,
    type: item.type ?? "unknown",
    status: item.status,
    tags: item.tags ?? [],
    parent: ctx.parentMap.get(item._ulid),
    acceptance_criteria_count: item.acceptance_criteria?.length ?? 0,
    child_count: ctx.childrenByParent.get(item._ulid)?.length ?? 0,
    coverage,
    coverage_counts: coverage?.counts ?? emptyCounts(),
    linked_work_counts: await linkedWorkCounts(ctx, item),
  };
}

function toCriterionSummary(
  ctx: ProjectionContext,
  item: LoadedSpecItem,
  ac: NonNullable<LoadedSpecItem["acceptance_criteria"]>[number],
): SpecWorkspaceCriterionSummary {
  return {
    id: ac.id,
    given: ac.given,
    when: ac.when,
    then: ac.then,
    coverage: coverageForCriterion(ctx.coverage, item, ac.id),
  };
}

async function childSections(
  ctx: ProjectionContext,
  item: LoadedSpecItem,
  pagination: Pagination,
): Promise<SpecWorkspaceChildSection[]> {
  const children = ctx.childrenByParent.get(item._ulid) ?? [];
  const byType = new Map<string, LoadedSpecItem[]>();
  for (const child of children) {
    const type = child.type ?? "unknown";
    const bucket = byType.get(type);
    if (bucket) bucket.push(child);
    else byType.set(type, [child]);
  }

  return Promise.all(
    [...byType.entries()].map(async ([type, nodes]) => ({
      type,
      title: type,
      nodes: await Promise.all(
        nodes
          .slice(pagination.offset, pagination.offset + pagination.limit)
          .map((node) => toNodeSummary(ctx, node)),
      ),
      pagination: paginationMeta(nodes.length, pagination),
    })),
  );
}

async function linkedWorkGroups(
  ctx: ProjectionContext,
  item: LoadedSpecItem,
): Promise<SpecWorkspaceLinkedWorkGroup[]> {
  const tasks = linkedTasks(ctx, item);
  const plans = linkedPlans(ctx, item);
  const sessions = await linkedSessions(ctx, item);

  return [
    {
      kind: "task",
      inclusion_rule:
        "Tasks are included when task.spec_ref resolves to this spec item through the server reference index.",
      total: tasks.length,
      items: tasks.map(taskToLinkedWork),
    },
    {
      kind: "session",
      inclusion_rule:
        "Sessions are included when their task_id points at a task linked to this spec item.",
      total: sessions.length,
      items: sessions,
    },
    {
      kind: "plan",
      inclusion_rule:
        "Plans are included when their derived_specs list contains this spec item's ULID or slug reference.",
      total: plans.length,
      items: plans.map(planToLinkedWork),
    },
    {
      kind: "review",
      inclusion_rule:
        "Reviews are reserved for review subjects that target this spec item or its linked work.",
      total: 0,
      items: [],
      unavailable: unavailable(
        "reviews",
        "Review-to-spec workspace projection is not available in this read model yet.",
        "Use the Reviews page or a task detail view for review context.",
      ),
    },
    {
      kind: "observation",
      inclusion_rule:
        "Observations are reserved for observations whose evidence or promoted work targets this spec item.",
      total: 0,
      items: [],
      unavailable: unavailable(
        "observations",
        "Observation-to-spec workspace projection is not available in this read model yet.",
        "Use the Observations page for systemic notes.",
      ),
    },
  ];
}

async function loadProjectionContext(
  projectPath: string,
  options: SpecWorkspaceRouteOptions,
): Promise<ProjectionContext> {
  const cache = options.getEntityCache?.(projectPath);
  const cacheDomainState = cache?.getDomainState("items");
  const ctx = await initContext(projectPath, { syncMode: "skip" });
  const items =
    ((cache && cacheDomainState === "ready" ? cache.getAllItemDetails() : null) as
      | LoadedSpecItem[]
      | null) ?? (await loadAllItems(ctx));
  const tasks =
    ((cache && cache.getDomainState("tasks") === "ready" ? cache.getTaskIndex() : null) as
      | LoadedTask[]
      | null) ?? (await resolveTaskDataManager(ctx).loadAllTasks(ctx));
  const plans =
    ((cache && cache.getDomainState("plans") === "ready" ? cache.getPlansIndex() : null) as
      | LoadedPlan[]
      | null) ?? (await loadPlans(ctx));
  const coverage = await getCachedCoverageStateReadModel(ctx);
  const parentMap = computeItemParentMap(items);
  const childrenByParent = new Map<string | undefined, LoadedSpecItem[]>();
  for (const item of items) {
    const parent = parentMap.get(item._ulid);
    const bucket = childrenByParent.get(parent);
    if (bucket) bucket.push(item);
    else childrenByParent.set(parent, [item]);
  }
  const refIndex = new ReferenceIndex(tasks, items);
  const alignment = new AlignmentIndex(tasks, items);
  alignment.buildLinks(refIndex);
  return {
    projectPath,
    cacheDomainState,
    items,
    tasks,
    plans,
    coverage,
    parentMap,
    childrenByParent,
    itemByUlid: indexItemsByUlid(items) as Map<string, LoadedSpecItem>,
    refIndex,
    alignment,
    sessionsDir: ctx.sessionsDir,
    sessionLinksByItemUlid: new Map(),
    getEntityCache: options.getEntityCache,
  };
}

async function buildRootProjection(
  ctx: ProjectionContext,
  pagination: Pagination,
): Promise<SpecWorkspaceRootProjection> {
  const topLevel = ctx.childrenByParent.get(undefined) ?? [];
  const byType: Record<string, number> = {};
  let acceptanceCriteria = 0;
  for (const item of ctx.items) {
    const type = item.type ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    acceptanceCriteria += item.acceptance_criteria?.length ?? 0;
  }
  return {
    kind: "root",
    corpus: {
      items: ctx.items.length,
      acceptance_criteria: acceptanceCriteria,
      by_type: byType,
    },
    coverage_summary: ctx.coverage.summary,
    top_level_nodes: await Promise.all(
      topLevel
        .slice(pagination.offset, pagination.offset + pagination.limit)
        .map((item) => toNodeSummary(ctx, item)),
    ),
    pagination: paginationMeta(topLevel.length, pagination),
    unavailable_sections: [],
  };
}

async function buildNodeProjection(
  ctx: ProjectionContext,
  item: LoadedSpecItem,
  pagination: Pagination,
): Promise<SpecWorkspaceNodeDetailProjection> {
  return {
    kind: "node",
    node: await toNodeSummary(ctx, item),
    ancestors: buildItemAncestors(ctx.itemByUlid, ctx.parentMap, item._ulid),
    description: item.description,
    traits: item.traits ?? [],
    relationships: {
      depends_on: item.depends_on ?? [],
      implements: item.implements ?? [],
      relates_to: item.relates_to ?? [],
      tests: item.tests ?? [],
      supersedes: item.supersedes ?? null,
    },
    child_sections: await childSections(ctx, item, pagination),
    acceptance_criteria: (item.acceptance_criteria ?? []).map((ac) =>
      toCriterionSummary(ctx, item, ac),
    ),
    linked_work: await linkedWorkGroups(ctx, item),
    unavailable_sections: [],
  };
}

async function buildCriterionProjection(
  ctx: ProjectionContext,
  item: LoadedSpecItem,
  acId: string,
): Promise<SpecWorkspaceCriterionDetailProjection | null> {
  const ac = item.acceptance_criteria?.find((candidate) => candidate.id === acId);
  if (!ac) return null;
  const criterion = toCriterionSummary(ctx, item, ac);
  const coverage = coverageForCriterion(ctx.coverage, item, acId);
  return {
    kind: "criterion",
    parent: await toNodeSummary(ctx, item),
    ancestors: buildItemAncestors(ctx.itemByUlid, ctx.parentMap, item._ulid),
    criterion,
    coverage,
    evidence: {
      latest_run: coverage?.latest_run_evidence ?? [],
      unmapped_results: coverage?.unmapped_result_references ?? [],
      reverify_causes: coverage?.freshness.secondary_causes ?? [],
    },
    siblings: (item.acceptance_criteria ?? []).map((entry) => toCriterionSummary(ctx, item, entry)),
    linked_work: await linkedWorkGroups(ctx, item),
    unavailable_sections: [],
  };
}

export function createSpecWorkspaceRoutes(options: SpecWorkspaceRouteOptions = {}) {
  return (
    new Elysia({ prefix: "/api/spec-workspace" })
      // AC: @trait-api-endpoint ac-6
      .onTransform(({ set }) => {
        set.headers["X-Request-Id"] = ulid();
      })
      .get(
        "/root",
        async ({ query, projectContext, error: errorResponse }) => {
          const pagination = parsePagination(query);
          if (!pagination.ok) return errorResponse(400, validationError(pagination.error));
          const cache = options.getEntityCache?.(projectContext.path);
          const itemsDomainState = cache?.getDomainState("items");
          if (cache && itemsDomainState === "loading") {
            return wrapResponse(
              {
                kind: "root",
                corpus: { items: 0, acceptance_criteria: 0, by_type: {} },
                coverage_summary: emptyCoverageSummary(),
                top_level_nodes: [],
                pagination: paginationMeta(0, pagination.pagination),
                unavailable_sections: [],
              } satisfies SpecWorkspaceRootProjection,
              { cacheDomainState: "loading", ...paginationMeta(0, pagination.pagination) },
            );
          }
          const projectionContext = await loadProjectionContext(projectContext.path, options);
          const projection = await buildRootProjection(projectionContext, pagination.pagination);
          return wrapResponse(projection, {
            cacheDomainState: projectionContext.cacheDomainState,
            total: projection.pagination.total,
            offset: projection.pagination.offset,
            limit: projection.pagination.limit,
          });
        },
        {
          query: t.Object({
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )
      .get(
        "/nodes/:ref",
        async ({ params, query, projectContext, error: errorResponse }) => {
          const pagination = parsePagination(query);
          if (!pagination.ok) return errorResponse(400, validationError(pagination.error));
          const projectionContext = await loadProjectionContext(projectContext.path, options);
          const item = resolveItem(projectionContext, params.ref);
          if (!item) return errorResponse(404, notFound(params.ref));
          return wrapResponse(
            await buildNodeProjection(projectionContext, item, pagination.pagination),
            {
              cacheDomainState: projectionContext.cacheDomainState,
            },
          );
        },
        {
          params: t.Object({ ref: t.String() }),
          query: t.Object({
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )
      .get(
        "/criteria/:ref/:acId",
        async ({ params, projectContext, error: errorResponse }) => {
          const projectionContext = await loadProjectionContext(projectContext.path, options);
          const item = resolveItem(projectionContext, params.ref);
          if (!item) return errorResponse(404, notFound(params.ref));
          const projection = await buildCriterionProjection(projectionContext, item, params.acId);
          if (!projection) return errorResponse(404, criterionNotFound(params.ref, params.acId));
          return wrapResponse(projection, { cacheDomainState: projectionContext.cacheDomainState });
        },
        {
          params: t.Object({ ref: t.String(), acId: t.String() }),
        },
      )
  );
}
