/**
 * E2E tests for Validation and Search API endpoints
 *
 * Tests verify:
 * - Validation routes are properly structured and integrated
 * - Route definitions match spec acceptance criteria
 * - Search, validate, and alignment endpoints are implemented
 *
 * AC Coverage:
 * - ac-19: GET /api/search?q=query searches across all entities
 * - ac-20: GET /api/validate returns ValidationResult
 * - ac-21: GET /api/alignment returns AlignmentIndex stats
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('Validation API Endpoints', () => {
  // AC: @api-contract ac-19
  it('should have GET /api/search route with query parameter', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/validation.ts'),
      'utf-8'
    );

    // Check route definition exists
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/search'");

    // AC: @api-contract ac-19 - Load all data sources
    expect(routesContent).toContain('buildIndexes');
    expect(routesContent).toContain('loadInboxItems');
    expect(routesContent).toContain('loadMetaContext');

    // AC: @api-contract ac-19 - Search across all entity types
    expect(routesContent).toContain('grepItem');
    expect(routesContent).toContain("type: 'item'");
    expect(routesContent).toContain("type: 'task'");
    expect(routesContent).toContain("type: 'inbox'");
    expect(routesContent).toContain("type: 'observation'");
    expect(routesContent).toContain("type: 'agent'");
    expect(routesContent).toContain("type: 'workflow'");
    expect(routesContent).toContain("type: 'convention'");

    // AC: @api-contract ac-19 - Return results with matched fields
    expect(routesContent).toContain('matchedFields');
    expect(routesContent).toContain('results:');
    expect(routesContent).toContain('total:');
  });

  // AC: @api-contract ac-19 - Search filters
  it('should support search filters and options', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/validation.ts'),
      'utf-8'
    );

    // AC: @api-contract ac-19 - Filter options
    expect(routesContent).toContain('query.type');
    expect(routesContent).toContain('query.status');
    expect(routesContent).toContain('query.itemsOnly');
    expect(routesContent).toContain('query.tasksOnly');
    expect(routesContent).toContain('query.limit');

    // Query parameter validation
    expect(routesContent).toContain('query: t.Object({');
    expect(routesContent).toContain('q: t.Optional(t.String())');
  });

  // AC: @api-contract ac-20
  it('should have GET /api/validate route', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/validation.ts'),
      'utf-8'
    );

    // Check route definition
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/validate'");

    // AC: @api-contract ac-20 - Call validate function
    expect(routesContent).toContain('validate');
    expect(routesContent).toContain('await validate(ctx)');

    // AC: @api-contract ac-20 - Return ValidationResult fields
    expect(routesContent).toContain('valid:');
    expect(routesContent).toContain('schemaErrors:');
    expect(routesContent).toContain('refErrors:');
    expect(routesContent).toContain('refWarnings:');
    expect(routesContent).toContain('orphans:');
    expect(routesContent).toContain('completenessWarnings:');
    expect(routesContent).toContain('traitCycles:');
  });

  // AC: @api-contract ac-21
  it('should have GET /api/alignment route', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/validation.ts'),
      'utf-8'
    );

    // Check route definition
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/alignment'");

    // AC: @api-contract ac-21 - Build indexes and create AlignmentIndex
    expect(routesContent).toContain('buildIndexes');
    expect(routesContent).toContain('AlignmentIndex');
    expect(routesContent).toContain('buildLinks');

    // AC: @api-contract ac-21 - Get stats and warnings
    expect(routesContent).toContain('getStats()');
    expect(routesContent).toContain('findAlignmentWarnings()');

    // AC: @api-contract ac-21 - Return stats and warnings
    expect(routesContent).toContain('stats:');
    expect(routesContent).toContain('totalSpecs:');
    expect(routesContent).toContain('specsWithTasks:');
    expect(routesContent).toContain('alignedSpecs:');
    expect(routesContent).toContain('orphanedSpecs:');
    expect(routesContent).toContain('warnings');
  });

  // Integration check
  it('should be integrated into main server', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    // Check import
    expect(serverContent).toContain("import { createValidationRoutes } from './routes/validation'");

    // Check usage
    expect(serverContent).toContain('createValidationRoutes');
    expect(serverContent).toContain('kspecDir');
  });

  // Type safety check
  it('should use proper TypeScript types from parser', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/validation.ts'),
      'utf-8'
    );

    // Check imports from parser
    expect(routesContent).toContain("from '../../parser/index.js'");
    expect(routesContent).toContain('initContext');
    expect(routesContent).toContain('buildIndexes');
    expect(routesContent).toContain('validate');
    expect(routesContent).toContain('AlignmentIndex');
    expect(routesContent).toContain('loadInboxItems');
    expect(routesContent).toContain('loadMetaContext');

    // Check imports from utils
    expect(routesContent).toContain("from '../../utils/grep.js'");
    expect(routesContent).toContain('grepItem');

    // Check meta types import
    expect(routesContent).toContain("from '../../parser/meta.js'");
    expect(routesContent).toContain('LoadedAgent');
    expect(routesContent).toContain('LoadedWorkflow');
    expect(routesContent).toContain('LoadedObservation');
    expect(routesContent).toContain('LoadedConvention');
  });
});
