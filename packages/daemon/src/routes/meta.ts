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

import { Elysia, t } from 'elysia';
import {
  initContext,
  loadMetaContext,
  loadSessionContext,
  saveMetaItem,
} from '../../parser/index.js';
import { commitIfShadow, getShadowStatus, hasRemoteTracking } from '../../parser/shadow.js';
import type { Agent } from '../../schema/meta.js';
import { AgentDispatchEventSchema, ObservationTypeSchema } from '../../schema/meta.js';
import { AgentDispatchAutomationFilterSchema } from '../../schema/task.js';
import { enumArrayUnion, enumUnion } from './enum-utils.js';

interface MetaRouteOptions {}

export function createMetaRoutes(options: MetaRouteOptions = {}) {
  // No closure-scoped kspecDir needed - comes from middleware

  return new Elysia({ prefix: '/api/meta' })
    // AC: @api-contract ac-15 - Get session context
    .get('/session', async ({ projectContext }) => {
      // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
      const ctx = await initContext(projectContext.path);
      const session = await loadSessionContext(ctx);

      // AC: @api-contract ac-15 - Return session context (focus, threads, questions)
      return {
        focus: session.focus,
        threads: session.threads || [],
        questions: session.questions || [],
        updated_at: session.updated_at,
      };
    })

    // AC: @api-contract ac-16 - List agents
    .get('/agents', async ({ projectContext }) => {
      // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
      const ctx = await initContext(projectContext.path);
      const meta = await loadMetaContext(ctx);

      // AC: @api-contract ac-16 - Return all defined agents
      const agents = meta.agents;

      return {
        items: agents,
        total: agents.length,
      };
    })

    // AC: @ui-agent-dispatch ac-4 - Update agent definition
    // Body schema mirrors editable fields from AgentSchema (src/schema/meta.ts).
    // Dispatch event enum values derived from AgentDispatchEventSchema.
    .patch(
      '/agents/:id',
      async ({ params, body, projectContext }) => {
        const ctx = await initContext(projectContext.path);
        const meta = await loadMetaContext(ctx);

        // Find the agent by id
        const agent = meta.agents.find((a) => a.id === params.id);
        if (!agent) {
          throw new Error(`Agent not found: ${params.id}`);
        }

        // Apply partial updates from body — result satisfies Agent type from schema
        const updated: Agent = { ...agent, ...body };

        await saveMetaItem(ctx, updated, 'agent');
        await commitIfShadow(ctx.shadow, `meta: update agent ${params.id}`);

        return updated;
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
          dispatch: t.Optional(
            t.Array(
              t.Object({
                on: t.Union(AgentDispatchEventSchema.options.map((v) => t.Literal(v))),
                filter: t.Optional(
                  t.Object({
                    automation: t.Optional(enumUnion(AgentDispatchAutomationFilterSchema.options)),
                    tags: t.Optional(t.Array(t.String())),
                    priority: t.Optional(t.Number()),
                  })
                ),
              })
            )
          ),
          capabilities: t.Optional(t.Array(t.String())),
          tools: t.Optional(t.Array(t.String())),
          skills: t.Optional(t.Array(t.String())),
          budget: t.Optional(
            t.Object({
              max_tasks: t.Optional(t.Number()),
              max_retries: t.Optional(t.Number()),
              timeout_minutes: t.Optional(t.Number()),
            })
          ),
          concurrency: t.Optional(
            t.Object({
              max_concurrent: t.Optional(t.Number()),
            })
          ),
          auto_approve: t.Optional(t.Boolean()),
          prompt_template: t.Optional(t.String()),
        }),
      }
    )

    // AC: @api-contract ac-17 - List workflows
    .get('/workflows', async ({ projectContext }) => {
      // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
      const ctx = await initContext(projectContext.path);
      const meta = await loadMetaContext(ctx);

      // AC: @api-contract ac-17 - Return all defined workflows
      const workflows = meta.workflows;

      return {
        items: workflows,
        total: workflows.length,
      };
    })

    // AC: @api-contract ac-18 - List observations with filter
    .get(
      '/observations',
      async ({ query, projectContext }) => {
        // AC: @multi-directory-daemon ac-1, ac-24 - Use project context from middleware
        const ctx = await initContext(projectContext.path);
        const meta = await loadMetaContext(ctx);

        // Start with all observations
        let filtered = meta.observations || [];

        // AC: @api-contract ac-18 - Filter by resolved status
        if (query.resolved !== undefined) {
          const resolvedFilter = query.resolved === 'true';
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
        const sorted = [...filtered].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

        return {
          items: sorted,
          total: sorted.length,
        };
      },
      {
        query: t.Object({
          resolved: t.Optional(t.String()),
          type: t.Optional(enumArrayUnion(ObservationTypeSchema.options)),
        }),
      }
    )

    // AC: @ui-settings-view ac-1 - Project config from manifest
    .get('/config', async ({ projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const manifest = ctx.manifest;
      const config = ctx.config;

      return {
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
      };
    })

    // AC: @ui-settings-view ac-1 - Shadow branch status
    .get('/shadow', async ({ projectContext }) => {
      const ctx = await initContext(projectContext.path);

      if (!ctx.shadow) {
        return {
          enabled: false,
          branch_name: null,
          worktree_dir: null,
          healthy: false,
          remote_tracking: false,
        };
      }

      const status = await getShadowStatus(ctx.rootDir, {
        branchName: ctx.shadow.branchName,
        directory: ctx.config.shadow.directory,
      });
      const hasRemote = await hasRemoteTracking(ctx.shadow.worktreeDir, {
        branchName: ctx.shadow.branchName,
      });

      return {
        enabled: ctx.shadow.enabled,
        branch_name: ctx.shadow.branchName,
        worktree_dir: ctx.shadow.worktreeDir,
        healthy: status.healthy,
        remote_tracking: hasRemote,
      };
    })

    // AC: @ui-settings-view ac-1 - Convention definitions
    .get('/conventions', async ({ projectContext }) => {
      const ctx = await initContext(projectContext.path);
      const meta = await loadMetaContext(ctx);

      return {
        items: meta.conventions,
        total: meta.conventions.length,
      };
    });
}
