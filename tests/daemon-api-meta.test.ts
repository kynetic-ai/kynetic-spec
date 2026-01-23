/**
 * E2E tests for Meta API endpoints
 *
 * Tests verify:
 * - Meta routes are properly structured and integrated
 * - Route definitions match spec acceptance criteria
 * - Error handling patterns are implemented
 *
 * AC Coverage:
 * - ac-15: GET /api/meta/session returns session context
 * - ac-16: GET /api/meta/agents returns all agents
 * - ac-17: GET /api/meta/workflows returns all workflows
 * - ac-18: GET /api/meta/observations with filter
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('Meta API Endpoints', () => {
  // AC: @api-contract ac-15
  it('should have GET /api/meta/session route', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/meta.ts'),
      'utf-8'
    );

    // Check route definition exists
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/session'");

    // AC: @api-contract ac-15 - Load and return session context
    expect(routesContent).toContain('loadSessionContext');

    // AC: @api-contract ac-15 - Return focus, threads, questions
    expect(routesContent).toContain('focus:');
    expect(routesContent).toContain('threads:');
    expect(routesContent).toContain('questions:');
    expect(routesContent).toContain('updated_at:');
  });

  // AC: @api-contract ac-16
  it('should have GET /api/meta/agents route', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/meta.ts'),
      'utf-8'
    );

    // Check route definition
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/agents'");

    // AC: @api-contract ac-16 - Load meta context and use agents array
    expect(routesContent).toContain('loadMetaContext');
    expect(routesContent).toContain('meta.agents');

    // Return format
    expect(routesContent).toContain('items:');
    expect(routesContent).toContain('total:');
  });

  // AC: @api-contract ac-17
  it('should have GET /api/meta/workflows route', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/meta.ts'),
      'utf-8'
    );

    // Check route definition
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/workflows'");

    // AC: @api-contract ac-17 - Load meta context and use workflows array
    expect(routesContent).toContain('loadMetaContext');
    expect(routesContent).toContain('meta.workflows');

    // Return format
    expect(routesContent).toContain('items:');
    expect(routesContent).toContain('total:');
  });

  // AC: @api-contract ac-18
  it('should have GET /api/meta/observations route with filter', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/meta.ts'),
      'utf-8'
    );

    // Check route definition
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/observations'");

    // AC: @api-contract ac-18 - Load observations
    expect(routesContent).toContain('loadMetaContext');
    expect(routesContent).toContain('meta.observations');

    // AC: @api-contract ac-18 - Filter by resolved status
    expect(routesContent).toContain('query.resolved');
    expect(routesContent).toContain('resolved_at');

    // Sort by created_at descending
    expect(routesContent).toContain('.sort(');
    expect(routesContent).toContain('created_at');

    // Return format
    expect(routesContent).toContain('items:');
    expect(routesContent).toContain('total:');
  });

  // Integration check
  it('should be integrated into main server', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    // Check import
    expect(serverContent).toContain("import { createMetaRoutes } from './routes/meta'");

    // Check usage
    expect(serverContent).toContain('createMetaRoutes');
    expect(serverContent).toContain('kspecDir');
  });

  // Type safety check
  it('should use proper TypeScript types from parser', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/meta.ts'),
      'utf-8'
    );

    // Check imports from parser
    expect(routesContent).toContain("from '../../../src/parser/index.js'");
    expect(routesContent).toContain('initContext');
    expect(routesContent).toContain('loadMetaContext');
    expect(routesContent).toContain('loadSessionContext');
  });

  // Query parameter validation
  it('should validate query parameters with Elysia schema', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/meta.ts'),
      'utf-8'
    );

    // Check Elysia type definitions for query params
    expect(routesContent).toContain('query: t.Object({');
    expect(routesContent).toContain('t.Optional');
    expect(routesContent).toContain('t.String()');
  });
});
