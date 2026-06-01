/**
 * Meta API Routes
 *
 * REST endpoints for meta operations:
 * - GET /api/meta/session - get session context
 * - GET /api/meta/agents - list agents
 * - PATCH /api/meta/agents/:id - update agent definition
 * - GET /api/meta/workflows - list workflows
 * - GET /api/meta/observations - list observations with filter
 * - GET /api/meta/config - project config from manifest + kspec.config.yaml
 * - GET /api/meta/shadow - shadow branch status
 * - GET /api/meta/conventions - convention definitions
 *
 * AC Coverage:
 * - ac-15: GET /api/meta/session returns session context
 * - ac-16: GET /api/meta/agents returns all agents
 * - ac-17: GET /api/meta/workflows returns all workflows
 * - ac-18: GET /api/meta/observations with filter
 * - @ui-agent-dispatch ac-4: PATCH /api/meta/agents/:id updates agent definition
 * - @ui-settings-view ac-1: GET /api/meta/config, /shadow, /conventions
 */

import path from "node:path";
import { Elysia, t } from "elysia";
import {
  initContext,
  loadMetaContext,
  loadSessionContext,
  saveMetaItem,
} from "../../parser/index.js";
import { commitIfShadow, getShadowStatus, hasRemoteTracking } from "../../parser/shadow.js";
import type { Agent } from "../../schema/meta.js";
import { AgentDispatchEventSchema, ObservationTypeSchema } from "../../schema/meta.js";
import { AgentDispatchAutomationFilterSchema } from "../../schema/task.js";
import { enumArrayUnion, enumUnion } from "./enum-utils.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import { wrapResponse } from "./response-envelope.js";
import {
  resolveEffectiveRunners,
  type EffectiveRunnerRegistry,
} from "../../agents/runner-config.js";
import {
  summarizeRegistryLoadFailure,
  type RegistryLoadFailure,
} from "../../agents/registry-load-failure.js";
import {
  buildRunnerValidationReport,
  type RunnerValidationEntry,
} from "../../agents/runner-validation.js";

interface MetaRouteOptions {
  getEntityCache?: EntityCacheAccessor;
}

interface RunnerEnrichmentContext {
  registry: EffectiveRunnerRegistry;
  validationByRunner: Map<string, RunnerValidationEntry>;
  registryLoadFailures: readonly RegistryLoadFailure[];
}

/**
 * Load the effective runner registry, run the validation pass once, and
 * capture any registry-load failures. Used by both the agent list and the
 * agent PATCH endpoints so the runner-aware response shape stays in sync
 * across read and write paths.
 *
 * Failures degrade silently — agents without a runner field continue to
 * resolve through the legacy adapter path even when the registry cannot
 * be loaded.
 *
 * AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
 * AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
 */
async function loadRunnerEnrichmentContext(projectRoot: string): Promise<RunnerEnrichmentContext> {
  const shadowDir = path.join(projectRoot, ".kspec");
  let registry: EffectiveRunnerRegistry = { runners: {} };
  const validationByRunner = new Map<string, RunnerValidationEntry>();
  let registryLoadFailures: readonly RegistryLoadFailure[] = [];
  try {
    const resolved = await resolveEffectiveRunners({
      projectRoot,
      shadowWorktreeDir: shadowDir,
    });
    registry = resolved.registry;
    const report = await buildRunnerValidationReport(resolved, { cwd: projectRoot });
    for (const entry of report.runners) {
      validationByRunner.set(entry.runner, entry);
    }
    registryLoadFailures = report.registry_load_failures;
  } catch {
    // Runner config is optional — agents without runner fields remain
    // unaffected. Clients that read the legacy `adapter` field keep
    // working without any runner state attached.
  }
  return { registry, validationByRunner, registryLoadFailures };
}

/**
 * Build the runner-aware fields that decorate an agent record for daemon
 * responses. Returns the legacy `adapter`, the runner-resolved
 * `resolved_adapter`, and (when the agent declares a runner) a structured
 * `runner_validation` block that prefers registry-load failures over a
 * generic `unknown_runner` message.
 *
 * AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
 * AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
 * AC: @agent-runner-configuration ac-adapter-field-backcompat
 */
function buildAgentRunnerFields(
  agent: { id: string; runner?: string; adapter?: string },
  context: RunnerEnrichmentContext,
): {
  adapter: string;
  resolved_adapter: string;
  runner_validation?: {
    status: "valid" | "invalid";
    diagnostics: ReadonlyArray<{
      reason: string;
      message: string;
      details?: Readonly<Record<string, unknown>>;
    }>;
  };
} {
  const runnerEntry = agent.runner ? context.registry.runners[agent.runner] : undefined;
  const resolvedAdapter = runnerEntry?.adapter ?? agent.adapter ?? "claude-agent-acp";
  const out: ReturnType<typeof buildAgentRunnerFields> = {
    adapter: resolvedAdapter,
    resolved_adapter: resolvedAdapter,
  };
  if (!agent.runner) return out;

  const entry = context.validationByRunner.get(agent.runner);
  if (entry) {
    out.runner_validation = {
      status: entry.status,
      diagnostics: entry.diagnostics,
    };
    return out;
  }
  if (runnerEntry) {
    out.runner_validation = {
      status: "invalid",
      diagnostics: [
        {
          reason: "preflight_failure",
          message:
            "Runner registry loaded but validation report unavailable; rerun `kspec agent runners validate` for details.",
        },
      ],
    };
    return out;
  }
  if (context.registryLoadFailures.length > 0) {
    // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
    out.runner_validation = {
      status: "invalid",
      diagnostics: context.registryLoadFailures.map((failure) => ({
        reason: "runner_registry_unavailable",
        message:
          `Runner registry unavailable: ${summarizeRegistryLoadFailure(failure)}. ` +
          `Fix the ${failure.layer} runner config before relying on runner "${agent.runner}".`,
        details: {
          runner: agent.runner,
          agent: agent.id,
          layer: failure.layer,
          config_path: failure.config_path,
          issues: failure.issues.map((issue) => ({ ...issue })),
        },
      })),
    };
    return out;
  }
  out.runner_validation = {
    status: "invalid",
    diagnostics: [
      {
        reason: "unknown_runner",
        message:
          `Runner "${agent.runner}" is not present in the effective runner registry. ` +
          `Check the project runner config (project.runners.yaml in the kspec shadow worktree), ` +
          `the system runner config (runners.yaml under the daemon config dir), and the agent definition's runner field.`,
        details: { runner: agent.runner, agent: agent.id },
      },
    ],
  };
  return out;
}

export function createMetaRoutes(_options: MetaRouteOptions = {}) {
  const { getEntityCache } = _options;

  return (
    new Elysia({ prefix: "/api/meta" })
      // AC: @api-contract ac-15 - Get session context
      // AC: @daemon-read-path ac-no-per-request-sync — serve from cache when available
      .get("/session", async ({ projectContext }) => {
        const cache = getEntityCache?.(projectContext.path);
        const metaDomainState = cache?.getDomainState("meta");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && metaDomainState === "loading") {
          return wrapResponse(
            { focus: null, threads: [], questions: [], updated_at: new Date().toISOString() },
            { cacheDomainState: "loading" },
          );
        }

        if (cache && metaDomainState === "ready") {
          const cachedSession = cache.getSessionContext();
          if (cachedSession)
            return wrapResponse(cachedSession, { cacheDomainState: metaDomainState });
        }

        // Fallback: cache not ready or no cached session context
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
        const ctx = await initContext(projectContext.path, { syncMode: "skip" });
        const session = await loadSessionContext(ctx);

        // AC: @api-contract ac-15 - Return session context (focus, threads, questions)
        return wrapResponse({
          focus: session.focus,
          threads: session.threads || [],
          questions: session.questions || [],
          updated_at: session.updated_at,
        });
      })

      // AC: @api-contract ac-16 - List agents
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
      // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
      .get("/agents", async ({ projectContext }) => {
        // AC: @daemon-entity-cache ac-serve-from-memory — try cached MetaContext first
        const cache = getEntityCache?.(projectContext.path);
        const metaDomainState = cache?.getDomainState("meta");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && metaDomainState === "loading") {
          return wrapResponse([] as never[], { cacheDomainState: "loading", total: 0 });
        }

        let meta;
        if (cache && metaDomainState === "ready") {
          meta = cache.getMetaDetail();
        }
        if (!meta) {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          meta = await loadMetaContext(ctx);
        }

        // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
        // AC: @daemon-read-path ac-no-per-request-sync — resolve runner registry
        // directly from the project path so warm-cache reads do not call
        // initContext or any git-backed helper. The runner loader treats both
        // the project layer (shadow worktree `project.runners.yaml`) and the
        // system layer (daemon config dir) as optional, so an absent file or
        // missing shadow worktree returns an empty registry without erroring.
        // Failures degrade silently — agents without runner references remain
        // unaffected when the registry cannot load.
        const enrichment = await loadRunnerEnrichmentContext(projectContext.path);

        // AC: @api-contract ac-16 - Return all defined agents
        // AC: @agent-runner-configuration ac-adapter-field-backcompat
        // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
        // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
        const agents = meta.agents.map((a) => {
          const runnerFields = buildAgentRunnerFields(a, enrichment);
          const result: Record<string, unknown> = { ...a, ...runnerFields };
          return result;
        });

        return wrapResponse(agents, { total: agents.length, cacheDomainState: metaDomainState });
      })

      // AC: @ui-agent-dispatch ac-4 - Update agent definition
      // Body schema mirrors editable fields from AgentSchema (src/schema/meta.ts).
      // Dispatch event enum values derived from AgentDispatchEventSchema.
      .patch(
        "/agents/:id",
        async ({ params, body, projectContext }) => {
          const ctx = await initContext(projectContext.path);
          const meta = await loadMetaContext(ctx);

          // Find the agent by id
          const agent = meta.agents.find((a) => a.id === params.id);
          if (!agent) {
            throw new Error(`Agent not found: ${params.id}`);
          }

          // Apply partial updates from body — result satisfies Agent type from schema.
          // AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
          // Treat an explicit `runner: null` as a clear operation since
          // AgentSchema models the field as optional, not nullable.
          const { runner: runnerUpdate, ...restBody } = body as typeof body & {
            runner?: string | null;
          };
          const updated: Agent = { ...agent, ...restBody };
          if (runnerUpdate === null) {
            delete (updated as { runner?: string }).runner;
          } else if (typeof runnerUpdate === "string") {
            (updated as { runner?: string }).runner = runnerUpdate;
          }

          await saveMetaItem(ctx, updated, "agent");
          await commitIfShadow(ctx.shadow, `meta: update agent ${params.id}`);

          // AC: @daemon-entity-cache ac-write-through — update cache before response
          const agentCache = getEntityCache?.(projectContext.path);
          if (agentCache) {
            await agentCache.writeThrough("meta");
          }

          // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
          // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
          // Enrich the response with the same `adapter`, `resolved_adapter`,
          // and redacted `runner_validation` block the list endpoint
          // returns. Without this, API clients would observe a less complete
          // contract immediately after editing runner fields than they see
          // from a follow-up list call.
          const patchEnrichment = await loadRunnerEnrichmentContext(projectContext.path);
          const runnerFields = buildAgentRunnerFields(updated, patchEnrichment);
          return { ...updated, ...runnerFields };
        },
        {
          params: t.Object({
            id: t.String(),
          }),
          // Editable fields from AgentSchema — dispatch.on enum derived from AgentDispatchEventSchema
          body: t.Object({
            name: t.Optional(t.String()),
            description: t.Optional(t.String()),
            adapter: t.Optional(t.String()),
            // AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
            // Allow nullable so callers can clear the runner field
            // explicitly. The Zod schema treats an absent field the same
            // as null on update.
            runner: t.Optional(t.Union([t.String(), t.Null()])),
            dispatch: t.Optional(
              t.Array(
                t.Object({
                  on: t.Union(AgentDispatchEventSchema.options.map((v) => t.Literal(v))),
                  filter: t.Optional(
                    t.Object({
                      automation: t.Optional(
                        enumUnion(AgentDispatchAutomationFilterSchema.options),
                      ),
                      tags: t.Optional(t.Array(t.String())),
                      priority: t.Optional(t.Number()),
                    }),
                  ),
                }),
              ),
            ),
            capabilities: t.Optional(t.Array(t.String())),
            tools: t.Optional(t.Array(t.String())),
            skills: t.Optional(t.Array(t.String())),
            budget: t.Optional(
              t.Object({
                max_tasks: t.Optional(t.Number()),
                max_retries: t.Optional(t.Number()),
                timeout_minutes: t.Optional(t.Number()),
              }),
            ),
            concurrency: t.Optional(
              t.Object({
                max_concurrent: t.Optional(t.Number()),
              }),
            ),
            auto_approve: t.Optional(t.Boolean()),
            prompt_template: t.Optional(t.String()),
          }),
        },
      )

      // AC: @api-contract ac-17 - List workflows
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      .get("/workflows", async ({ projectContext }) => {
        // AC: @daemon-entity-cache ac-serve-from-memory — try cached MetaContext first
        const cache = getEntityCache?.(projectContext.path);
        const metaDomainState = cache?.getDomainState("meta");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && metaDomainState === "loading") {
          return wrapResponse([] as never[], { cacheDomainState: "loading", total: 0 });
        }

        let meta;
        if (cache && metaDomainState === "ready") {
          meta = cache.getMetaDetail();
        }
        if (!meta) {
          // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          meta = await loadMetaContext(ctx);
        }

        // AC: @api-contract ac-17 - Return all defined workflows
        const workflows = meta.workflows;

        return wrapResponse(workflows, {
          total: workflows.length,
          cacheDomainState: metaDomainState,
        });
      })

      // AC: @api-contract ac-18 - List observations with filter
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      .get(
        "/observations",
        async ({ query, projectContext }) => {
          // AC: @daemon-entity-cache ac-serve-from-memory — try cached MetaContext first
          const cache = getEntityCache?.(projectContext.path);
          const metaDomainState = cache?.getDomainState("meta");

          // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
          if (cache && metaDomainState === "loading") {
            return wrapResponse([] as never[], { cacheDomainState: "loading", total: 0 });
          }

          let meta;
          if (cache && metaDomainState === "ready") {
            meta = cache.getMetaDetail();
          }
          if (!meta) {
            // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
            // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
            const ctx = await initContext(projectContext.path, { syncMode: "skip" });
            meta = await loadMetaContext(ctx);
          }

          // Start with all observations
          let filtered = meta.observations || [];

          // AC: @api-contract ac-18 - Filter by resolved status
          if (query.resolved !== undefined) {
            const resolvedFilter = query.resolved === "true";
            filtered = filtered.filter((obs) => {
              const isResolved = !!obs.resolved_at;
              return isResolved === resolvedFilter;
            });
          }

          // Optional type filter (not in ACs but useful)
          if (query.type) {
            const typeFilters = Array.isArray(query.type) ? query.type : [query.type];
            filtered = filtered.filter((obs) => typeFilters.includes(obs.type));
          }

          // Sort by created_at descending (newest first)
          const sorted = [...filtered].toSorted(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          );

          return wrapResponse(sorted, { total: sorted.length, cacheDomainState: metaDomainState });
        },
        {
          query: t.Object({
            resolved: t.Optional(t.String()),
            type: t.Optional(enumArrayUnion(ObservationTypeSchema.options)),
          }),
        },
      )

      // AC: @ui-settings-view ac-1 - Project config from manifest
      // AC: @daemon-read-path ac-no-per-request-sync — serve from cache when available
      .get("/config", async ({ projectContext }) => {
        const cache = getEntityCache?.(projectContext.path);
        const metaDomainState = cache?.getDomainState("meta");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && metaDomainState === "loading") {
          return wrapResponse(
            {
              project: null,
              spec_version: null,
              root_dir: null,
              remote_tracking: null,
              daemon: null,
            },
            { cacheDomainState: "loading" },
          );
        }

        if (cache && metaDomainState === "ready") {
          const cachedConfig = cache.getProjectConfig();
          if (cachedConfig)
            return wrapResponse(cachedConfig, { cacheDomainState: metaDomainState });
        }

        // Fallback: cache not available at all (no entity cache configured)
        const ctx = await initContext(projectContext.path, { syncMode: "skip" });
        const manifest = ctx.manifest;
        const config = ctx.config;

        return wrapResponse({
          project: manifest?.project ?? null,
          spec_version: manifest?.kynetic ?? null,
          root_dir: ctx.projectRoot,
          remote_tracking: config.shadow.remote
            ? { value: config.shadow.remote.value, type: config.shadow.remote.type }
            : null,
          daemon: {
            port: config.daemon.port,
            host: config.daemon.host,
            auto_start: config.daemon.auto_start,
          },
        });
      })

      // AC: @ui-settings-view ac-1 - Shadow branch status
      // AC: @daemon-read-path ac-no-per-request-sync — serve from cache when available
      .get("/shadow", async ({ projectContext }) => {
        const cache = getEntityCache?.(projectContext.path);
        const metaDomainState = cache?.getDomainState("meta");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && metaDomainState === "loading") {
          return wrapResponse(
            {
              enabled: false,
              branch_name: null,
              worktree_dir: null,
              healthy: false,
              remote_tracking: false,
            },
            { cacheDomainState: "loading" },
          );
        }

        if (cache && metaDomainState === "ready") {
          const cachedShadow = cache.getShadowInfo();
          if (cachedShadow)
            return wrapResponse(cachedShadow, { cacheDomainState: metaDomainState });
        }

        // Fallback: cache not available at all (no entity cache configured)
        const ctx = await initContext(projectContext.path, { syncMode: "skip" });

        if (!ctx.shadow) {
          return wrapResponse({
            enabled: false,
            branch_name: null,
            worktree_dir: null,
            healthy: false,
            remote_tracking: false,
          });
        }

        const status = await getShadowStatus(ctx.rootDir, {
          branchName: ctx.shadow.branchName,
          directory: ctx.config.shadow.directory,
        });
        const hasRemote = await hasRemoteTracking(ctx.shadow.worktreeDir, {
          branchName: ctx.shadow.branchName,
        });

        return wrapResponse({
          enabled: ctx.shadow.enabled,
          branch_name: ctx.shadow.branchName,
          worktree_dir: ctx.shadow.worktreeDir,
          healthy: status.healthy,
          remote_tracking: hasRemote,
        });
      })

      // AC: @ui-settings-view ac-1 - Convention definitions
      // AC: @daemon-entity-cache ac-serve-from-memory — serve from cache when available
      .get("/conventions", async ({ projectContext }) => {
        // AC: @daemon-entity-cache ac-serve-from-memory — try cached MetaContext first
        const cache = getEntityCache?.(projectContext.path);
        const metaDomainState = cache?.getDomainState("meta");

        // AC: @daemon-entity-cache ac-warming-availability — return loading indicator
        if (cache && metaDomainState === "loading") {
          return wrapResponse([] as never[], { cacheDomainState: "loading", total: 0 });
        }

        let meta;
        if (cache && metaDomainState === "ready") {
          meta = cache.getMetaDetail();
        }
        if (!meta) {
          // AC: @shadow-lazy-read-sync ac-daemon-bypass — skip drift-check on daemon reads
          const ctx = await initContext(projectContext.path, { syncMode: "skip" });
          meta = await loadMetaContext(ctx);
        }

        return wrapResponse(meta.conventions, {
          total: meta.conventions.length,
          cacheDomainState: metaDomainState,
        });
      })
  );
}
