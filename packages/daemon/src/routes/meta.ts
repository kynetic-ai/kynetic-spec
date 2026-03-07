/**
 * Meta API Routes
 *
 * REST endpoints for meta operations:
 * - GET /api/meta/session - get session context
 * - GET /api/meta/agents - list agents
 * - PATCH /api/meta/agents/:id - update agent definition
 * - GET /api/meta/workflows - list workflows
 * - GET /api/meta/observations - list observations with filter
 *
 * AC Coverage:
 * - ac-15: GET /api/meta/session returns session context
 * - ac-16: GET /api/meta/agents returns all agents
 * - ac-17: GET /api/meta/workflows returns all workflows
 * - ac-18: GET /api/meta/observations with filter
 * - @ui-agent-dispatch ac-4: PATCH /api/meta/agents/:id updates agent definition
 */

import { Elysia, t } from 'elysia';
import {
  initContext,
  loadMetaContext,
  loadSessionContext,
  saveMetaItem,
} from '../../parser/index.js';
import { commitIfShadow } from '../../parser/shadow.js';

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

        // Apply partial updates from body
        const updated = { ...agent, ...body };

        await saveMetaItem(ctx, updated, 'agent');
        await commitIfShadow(ctx.shadow, `meta: update agent ${params.id}`);

        return updated;
      },
      {
        params: t.Object({
          id: t.String(),
        }),
        body: t.Object({
          name: t.Optional(t.String()),
          description: t.Optional(t.String()),
          adapter: t.Optional(t.String()),
          dispatch: t.Optional(
            t.Array(
              t.Object({
                on: t.String(),
                filter: t.Optional(
                  t.Object({
                    automation: t.Optional(t.String()),
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
          type: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        }),
      }
    );
}
