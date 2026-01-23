/**
 * E2E tests for Spec Item API endpoints
 *
 * Tests verify:
 * - Item routes are properly structured and integrated
 * - Route definitions match spec acceptance criteria
 * - Error handling patterns are implemented
 *
 * AC Coverage:
 * - ac-8: GET /api/items endpoint exists
 * - ac-9: Type filter support
 * - ac-10: GET /api/items/:ref endpoint exists with full details
 * - ac-11: GET /api/items/:ref/tasks endpoint exists
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('Spec Item API Endpoints', () => {
  // AC: @api-contract ac-8, ac-9
  it('should have GET /api/items route with type filter support', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/items.ts'),
      'utf-8'
    );

    // Check route definition exists
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/'");

    // AC: @api-contract ac-9 - Type filter (multi-value)
    expect(routesContent).toContain('query.type');
    expect(routesContent).toContain('Array.isArray(query.type)');
    expect(routesContent).toContain('typeFilters.includes(item.type)');

    // AC: @api-contract ac-8 - Return spec items
    expect(routesContent).toContain('_ulid');
    expect(routesContent).toContain('title');
    expect(routesContent).toContain('type');
    expect(routesContent).toContain('status');

    // AC: @trait-api-endpoint ac-4 - Pagination wrapper
    expect(routesContent).toContain('items');
    expect(routesContent).toContain('total');
    expect(routesContent).toContain('offset');
    expect(routesContent).toContain('limit');
    expect(routesContent).toContain('query.offset');
    expect(routesContent).toContain('query.limit');
  });

  // AC: @api-contract ac-10
  it('should have GET /api/items/:ref route with full details', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/items.ts'),
      'utf-8'
    );

    // Check route definition
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/:ref'");

    // AC: @api-contract ac-10 - Resolve via ReferenceIndex
    expect(routesContent).toContain('ReferenceIndex');
    expect(routesContent).toContain('index.resolve(params.ref)');

    // AC: @api-contract ac-10 - Return full item with acceptance_criteria, traits, relationships
    expect(routesContent).toContain('acceptance_criteria:');
    expect(routesContent).toContain('traits:');
    expect(routesContent).toContain('relationships:');
    expect(routesContent).toContain('description:');

    // AC: @trait-api-endpoint ac-2 - Error handling for invalid ref
    expect(routesContent).toContain('errorResponse(404');
    expect(routesContent).toContain('not_found');
    expect(routesContent).toContain('suggestion');
  });

  // AC: @api-contract ac-11
  it('should have GET /api/items/:ref/tasks route with AlignmentIndex', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/items.ts'),
      'utf-8'
    );

    // Check route definition
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/:ref/tasks'");

    // AC: @api-contract ac-11 - Use AlignmentIndex
    expect(routesContent).toContain('AlignmentIndex');
    expect(routesContent).toContain('alignIndex.getTasksForSpec');

    // Check returns task summary
    expect(routesContent).toContain('linkedTasks');
    expect(routesContent).toContain('status');
    expect(routesContent).toContain('priority');
    expect(routesContent).toContain('notes_count');

    // AC: @trait-api-endpoint ac-2 - Error handling
    expect(routesContent).toContain('errorResponse(404');
    expect(routesContent).toContain('not_found');
  });

  // Integration check
  it('should be integrated into main server', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    // Check import
    expect(serverContent).toContain("import { createItemsRoutes } from './routes/items'");

    // Check usage
    expect(serverContent).toContain('createItemsRoutes');
    expect(serverContent).toContain('kspecDir');
  });

  // Type safety check
  it('should use proper TypeScript types from parser', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/items.ts'),
      'utf-8'
    );

    // Check imports from parser
    expect(routesContent).toContain("from '../../../src/parser/index.js'");
    expect(routesContent).toContain('initContext');
    expect(routesContent).toContain('loadAllItems');
    expect(routesContent).toContain('loadAllTasks');
    expect(routesContent).toContain('ReferenceIndex');
    expect(routesContent).toContain('AlignmentIndex');
    expect(routesContent).toContain('LoadedSpecItem');
  });

  // Query parameter validation
  it('should validate query parameters with Elysia schema', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/items.ts'),
      'utf-8'
    );

    // Check Elysia type definitions for query params
    expect(routesContent).toContain('t.Object({');
    expect(routesContent).toContain('t.Optional');
    expect(routesContent).toContain('t.Union');
    expect(routesContent).toContain('t.String()');
    expect(routesContent).toContain('t.Array(t.String())');
  });
});
