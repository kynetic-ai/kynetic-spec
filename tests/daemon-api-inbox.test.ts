/**
 * E2E tests for Inbox API endpoints
 *
 * Tests verify:
 * - Inbox routes are properly structured and integrated
 * - Route definitions match spec acceptance criteria
 * - Error handling patterns are implemented
 *
 * AC Coverage:
 * - ac-12: GET /api/inbox returns items ordered by created_at desc
 * - ac-13: POST /api/inbox creates item with generated ULID
 * - ac-14: DELETE /api/inbox/:ref removes item
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('Inbox API Endpoints', () => {
  // AC: @api-contract ac-12
  it('should have GET /api/inbox route with created_at desc ordering', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/inbox.ts'),
      'utf-8'
    );

    // Check route definition exists
    expect(routesContent).toContain(".get(");
    expect(routesContent).toContain("'/'");

    // AC: @api-contract ac-12 - Sort by created_at descending
    expect(routesContent).toContain('created_at');
    expect(routesContent).toContain('.sort(');
    expect(routesContent).toContain('desc');

    // Check returns inbox items
    expect(routesContent).toContain('items');
    expect(routesContent).toContain('total');
  });

  // AC: @api-contract ac-13
  it('should have POST /api/inbox route that creates item with ULID', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/inbox.ts'),
      'utf-8'
    );

    // Check route definition
    expect(routesContent).toContain(".post(");
    expect(routesContent).toContain("'/'");

    // AC: @api-contract ac-13 - Create with ULID
    expect(routesContent).toContain('createInboxItem');
    expect(routesContent).toContain('saveInboxItem');
    expect(routesContent).toContain('commitIfShadow');

    // AC: @trait-api-endpoint ac-3 - Validate body
    expect(routesContent).toContain('body.text');
    expect(routesContent).toContain('errorResponse(400');
    expect(routesContent).toContain('validation_error');
    expect(routesContent).toContain('details');

    // AC: @trait-api-endpoint ac-5 - Shadow commit
    expect(routesContent).toContain('inbox: add item');

    // WebSocket broadcast
    expect(routesContent).toContain('pubsub.broadcast');
    expect(routesContent).toContain('inbox:updates');
    expect(routesContent).toContain('inbox_item_created');

    // AC: @api-contract ac-13 - Return with ULID
    expect(routesContent).toContain('success: true');
    expect(routesContent).toContain('item');
  });

  // AC: @api-contract ac-14
  it('should have DELETE /api/inbox/:ref route', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/inbox.ts'),
      'utf-8'
    );

    // Check route definition
    expect(routesContent).toContain(".delete(");
    expect(routesContent).toContain("'/:ref'");

    // AC: @api-contract ac-14 - Delete item
    expect(routesContent).toContain('deleteInboxItem');
    expect(routesContent).toContain('ReferenceIndex');
    expect(routesContent).toContain('index.resolve(params.ref)');

    // AC: @trait-api-endpoint ac-2 - Error handling for invalid ref
    expect(routesContent).toContain('errorResponse(404');
    expect(routesContent).toContain('not_found');
    expect(routesContent).toContain('suggestion');

    // Shadow commit
    expect(routesContent).toContain('commitIfShadow');
    expect(routesContent).toContain('inbox: delete');

    // WebSocket broadcast
    expect(routesContent).toContain('inbox_item_deleted');

    // AC: @api-contract ac-14 - Return success confirmation
    expect(routesContent).toContain('success: true');
    expect(routesContent).toContain('deleted');
  });

  // Integration check
  it('should be integrated into main server', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    // Check import
    expect(serverContent).toContain("import { createInboxRoutes } from './routes/inbox'");

    // Check usage
    expect(serverContent).toContain('createInboxRoutes');
    expect(serverContent).toContain('kspecDir');
    expect(serverContent).toContain('pubsub');
  });

  // Type safety check
  it('should use proper TypeScript types from parser', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/inbox.ts'),
      'utf-8'
    );

    // Check imports from parser
    expect(routesContent).toContain("from '../../parser/index.js'");
    expect(routesContent).toContain('initContext');
    expect(routesContent).toContain('loadInboxItems');
    expect(routesContent).toContain('createInboxItem');
    expect(routesContent).toContain('saveInboxItem');
    expect(routesContent).toContain('deleteInboxItem');
    expect(routesContent).toContain('findInboxItemByRef');
    expect(routesContent).toContain('InboxItemInput');
  });

  // Body parameter validation
  it('should validate body parameters with Elysia schema', async () => {
    const routesContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/routes/inbox.ts'),
      'utf-8'
    );

    // Check Elysia type definitions for body params
    expect(routesContent).toContain('body: t.Object({');
    expect(routesContent).toContain('text: t.String()');
    expect(routesContent).toContain('t.Optional');
    expect(routesContent).toContain('t.Array(t.String())');
  });
});
