/**
 * E2E API Tests for Daemon Items Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 * These replace the static analysis tests in tests/daemon-api-items.test.ts
 * which only read source files and check string patterns.
 *
 * Covered ACs:
 * - @api-contract ac-8: GET /api/items returns array of spec items (modules, features, requirements)
 * - @api-contract ac-9: GET /api/items with type filter (?type=feature&type=requirement)
 * - @api-contract ac-10: GET /api/items/:ref returns full item with acceptance_criteria, traits, relationships
 * - @api-contract ac-11: GET /api/items/:ref/tasks returns tasks linked via AlignmentIndex
 */

import { test, expect } from '../fixtures/test-base';

// AC: @trait-api-endpoint ac-2 — N/A: POST /api/items/batch reports missing refs in an
// unresolved array by design instead of failing the whole batch with 404.
// AC: @trait-api-endpoint ac-4 — N/A: POST /api/items/batch returns {items, unresolved};
// it is a batch lookup endpoint, not a paginated list endpoint.
// AC: @trait-api-endpoint ac-5 — N/A: POST /api/items/batch is read-only and does not mutate shadow state.

test.describe('Items API', () => {
  test.describe('GET /api/items', () => {
    // AC: @api-contract ac-8
    test('returns spec items with required fields', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      // Response should have paginated format
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('offset');
      expect(body).toHaveProperty('limit');
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);

      // Each item should have required fields
      const item = body.items[0];
      expect(item).toHaveProperty('_ulid');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('status');
    });

    // AC: @api-contract ac-8 - returns modules, features, and requirements
    test('returns items of different types (modules, features, requirements)', async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);

      const types = body.items.map((i: { type: string }) => i.type);

      // Fixtures include module, feature, and requirement types
      expect(types).toContain('module');
      expect(types).toContain('feature');
      expect(types).toContain('requirement');
    });

    // AC: @api-contract ac-8 - slugs field is present
    test('items include slugs array', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // All items should have slugs
      for (const item of body.items) {
        expect(item).toHaveProperty('slugs');
        expect(Array.isArray(item.slugs)).toBe(true);
      }
    });

    // AC: @api-contract ac-9 - single type filter
    test('filters items by single type value', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items?type=feature`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);
      // Fixture has at least one feature
      expect(body.items.length).toBeGreaterThan(0);

      // All returned items should be features
      for (const item of body.items) {
        expect(item.type).toBe('feature');
      }
    });

    // AC: @api-contract ac-9 - multi-value type filter (repeated params)
    test('filters items by multiple type values using repeated params', async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items?type=feature&type=requirement`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);

      // All returned items should match the filter
      for (const item of body.items) {
        expect(['feature', 'requirement']).toContain(item.type);
      }

      // Should include both types from fixtures
      const types = body.items.map((i: { type: string }) => i.type);
      expect(types).toContain('feature');
      expect(types).toContain('requirement');
    });

    // AC: @api-contract ac-9 - type filter excludes non-matching types
    test('type filter excludes items of non-matching types', async ({ request, daemon }) => {
      // Filter for only modules — should not return features or requirements
      const response = await request.get(`${daemon.baseUrl}/api/items?type=module`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);

      for (const item of body.items) {
        expect(item.type).toBe('module');
        expect(item.type).not.toBe('feature');
        expect(item.type).not.toBe('requirement');
      }
    });

    // AC: @api-contract ac-8 (pagination) - returns pagination wrapper
    test('returns paginated response with {items, total, offset, limit}', async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items?offset=0&limit=2`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('offset');
      expect(body).toHaveProperty('limit');

      expect(typeof body.total).toBe('number');
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(2);
      expect(body.items.length).toBeLessThanOrEqual(2);
    });

    // AC: @api-contract ac-8 (pagination) - pagination offsets work
    test('respects offset parameter for pagination', async ({ request, daemon }) => {
      // Get total count first
      const allResponse = await request.get(`${daemon.baseUrl}/api/items`);
      const allBody = await allResponse.json();
      const total = allBody.total;

      // Only test pagination if there are more than 2 items
      if (total > 2) {
        const page1 = await request.get(`${daemon.baseUrl}/api/items?offset=0&limit=2`);
        const body1 = await page1.json();

        const page2 = await request.get(`${daemon.baseUrl}/api/items?offset=2&limit=2`);
        const body2 = await page2.json();

        // Pages should have different items
        const ids1 = body1.items.map((i: { _ulid: string }) => i._ulid);
        const ids2 = body2.items.map((i: { _ulid: string }) => i._ulid);
        for (const id of ids2) {
          expect(ids1).not.toContain(id);
        }

        // Total is consistent across pages
        expect(body1.total).toBe(body2.total);
      }
    });
  });

  test.describe('GET /api/items/:ref', () => {
    // AC: @api-contract ac-10 - resolve item by slug
    test('resolves item by slug and returns full item', async ({ request, daemon }) => {
      // Use known fixture slug
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-feature`);
      expect(response.status()).toBe(200);

      const item = await response.json();
      expect(item).toHaveProperty('_ulid');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('status');
      expect(item.type).toBe('feature');
    });

    // AC: @api-contract ac-10 - returns acceptance_criteria
    test('returns item with acceptance_criteria array', async ({ request, daemon }) => {
      // test-feature has 2 ACs in the fixture
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-feature`);
      expect(response.status()).toBe(200);

      const item = await response.json();
      expect(item).toHaveProperty('acceptance_criteria');
      expect(Array.isArray(item.acceptance_criteria)).toBe(true);
      expect(item.acceptance_criteria.length).toBeGreaterThan(0);

      const ac = item.acceptance_criteria[0];
      expect(ac).toHaveProperty('id');
      expect(ac).toHaveProperty('given');
      expect(ac).toHaveProperty('when');
      expect(ac).toHaveProperty('then');
    });

    // AC: @api-contract ac-10 - returns traits
    test('returns item with traits array', async ({ request, daemon }) => {
      // test-feature has the @test-trait in its traits
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-feature`);
      expect(response.status()).toBe(200);

      const item = await response.json();
      expect(item).toHaveProperty('traits');
      expect(Array.isArray(item.traits)).toBe(true);
      expect(item.traits.length).toBeGreaterThan(0);
      // Fixture: test-feature has traits: ["@test-trait"]
      expect(item.traits).toContain('@test-trait');
    });

    // AC: @api-contract ac-10 - returns description
    test('returns item with description field', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-feature`);
      expect(response.status()).toBe(200);

      const item = await response.json();
      expect(item).toHaveProperty('description');
      expect(typeof item.description).toBe('string');
      expect(item.description.length).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-10 - resolve by full ULID
    test('resolves item by full ULID', async ({ request, daemon }) => {
      // First, get the item list to find a ULID
      const listResponse = await request.get(`${daemon.baseUrl}/api/items?type=feature`);
      const listBody = await listResponse.json();
      expect(listBody.items.length).toBeGreaterThan(0);

      const firstItem = listBody.items[0];
      expect(firstItem._ulid).toBeTruthy();

      // Get by full ULID
      const response = await request.get(`${daemon.baseUrl}/api/items/@${firstItem._ulid}`);
      expect(response.status()).toBe(200);

      const item = await response.json();
      expect(item._ulid).toBe(firstItem._ulid);
      expect(item.title).toBe(firstItem.title);
    });

    // AC: @api-contract ac-10 (error handling) - 404 for invalid ref
    test('returns 404 for non-existent item ref', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items/@nonexistent-item-xyz`);
      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('not_found');
      expect(body).toHaveProperty('message');
      expect(body).toHaveProperty('suggestion');
    });

    // AC: @api-contract ac-10 - returns JSON content type
    test('returns JSON content type', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-feature`);
      expect(response.status()).toBe(200);

      const contentType = response.headers()['content-type'] || '';
      expect(contentType).toContain('application/json');
    });
  });

  test.describe('GET /api/items/:ref/tasks', () => {
    // AC: @api-contract ac-11 - returns tasks linked via AlignmentIndex
    test('returns tasks linked to spec item', async ({ request, daemon }) => {
      // test-feature has tasks with spec_ref: "@test-feature" in the fixture
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-feature/tasks`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.items)).toBe(true);
      // Fixture has tasks linked to @test-feature
      expect(body.items.length).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-11 - linked tasks have summary fields
    test('linked tasks include required summary fields', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-feature/tasks`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBeGreaterThan(0);

      const task = body.items[0];
      expect(task).toHaveProperty('_ulid');
      expect(task).toHaveProperty('title');
      expect(task).toHaveProperty('status');
      expect(task).toHaveProperty('priority');
      expect(task).toHaveProperty('notes_count');
    });

    // AC: @api-contract ac-11 - total matches items count
    test('total matches number of linked tasks', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-feature/tasks`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.total).toBe(body.items.length);
    });

    // AC: @api-contract ac-11 - spec_ref matches the requested spec
    test('linked tasks have spec_ref pointing to the requested spec', async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-feature/tasks`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBeGreaterThan(0);

      // All tasks should reference test-feature
      for (const task of body.items) {
        expect(task.spec_ref).toBe('@test-feature');
      }
    });

    // AC: @api-contract ac-11 (error handling) - 404 for invalid ref
    test('returns 404 for non-existent item ref', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items/@nonexistent-item-xyz/tasks`);
      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('not_found');
    });

    // AC: @api-contract ac-11 - empty array for item with no linked tasks
    test('returns empty items array for spec item with no linked tasks', async ({
      request,
      daemon,
    }) => {
      // test-trait is a trait with no tasks linked to it
      const response = await request.get(`${daemon.baseUrl}/api/items/@test-trait/tasks`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.total).toBe(0);
      expect(body.items.length).toBe(0);
    });
  });

  test.describe('POST /api/items/batch', () => {
    // AC: @batch-item-fetch-api ac-1
    // AC: @trait-api-endpoint ac-1
    test('returns spec item summaries for valid item refs', async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/items/batch`, {
        data: { refs: ['@test-feature', '@test-requirement'] },
      });

      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('application/json');

      const body = await response.json();
      expect(body.unresolved).toEqual([]);
      expect(body.items).toHaveLength(2);

      expect(body.items[0]).toMatchObject({
        ulid: '01KF1645CBDJYHWBPYWRN3HYPJ',
        slugs: ['test-feature'],
        title: 'Test Feature',
        type: 'feature',
        status: 'in_progress',
        maturity: 'draft',
        traits: ['@test-trait'],
        ac_count: 2,
      });

      expect(body.items[1]).toMatchObject({
        ulid: '01KF1645CBKJNPWH1E02WN4MMX',
        slugs: ['test-requirement'],
        title: 'Test Requirement',
        type: 'requirement',
        status: 'not_started',
        maturity: 'draft',
        traits: [],
        ac_count: 0,
      });
    });

    // AC: @batch-item-fetch-api ac-2
    test('returns unresolved refs separately while preserving resolved results', async ({
      request,
      daemon,
    }) => {
      const response = await request.post(`${daemon.baseUrl}/api/items/batch`, {
        data: { refs: ['@test-feature', '@does-not-exist', '@test-task-ready'] },
      });

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items).toHaveLength(2);
      expect(body.unresolved).toEqual(['@does-not-exist']);
      expect(body.items[0].title).toBe('Test Feature');
      expect(body.items[1].title).toBe('Ready task');
    });

    // AC: @batch-item-fetch-api ac-3
    test('returns task summaries when refs resolve to tasks', async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/items/batch`, {
        data: { refs: ['@test-task-ready', '@test-task-in-progress'] },
      });

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.unresolved).toEqual([]);
      expect(body.items).toHaveLength(2);

      expect(body.items[0]).toEqual({
        ulid: '01KG0RR6CA45ZT43W2T6HJMVA1',
        slugs: ['test-task-ready'],
        title: 'Ready task',
        status: 'pending',
        priority: 2,
        spec_ref: '@test-feature',
      });

      expect(body.items[1]).toEqual({
        ulid: '01KG0RR8CB8N4YGP991WD7XS9R',
        slugs: ['test-task-in-progress'],
        title: 'In progress task',
        status: 'in_progress',
        priority: 3,
        spec_ref: '@test-feature',
      });
    });

    // AC: @batch-item-fetch-api ac-4
    test('returns empty arrays for an empty batch', async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/items/batch`, {
        data: { refs: [] },
      });

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toEqual({
        items: [],
        unresolved: [],
      });
    });

    // AC: @batch-item-fetch-api ac-5
    test('returns 400 with a descriptive message when batch size exceeds 100 refs', async ({
      request,
      daemon,
    }) => {
      const refs = Array.from({ length: 101 }, (_, index) => `@missing-${index}`);
      const response = await request.post(`${daemon.baseUrl}/api/items/batch`, {
        data: { refs },
      });

      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body).toEqual({
        error: 'validation_error',
        details: [
          {
            field: 'refs',
            message: 'Maximum batch size is 100 refs',
          },
        ],
      });
    });

    // AC: @trait-api-endpoint ac-3
    test('returns 400 with validation details when refs is missing', async ({
      request,
      daemon,
    }) => {
      const response = await request.post(`${daemon.baseUrl}/api/items/batch`, {
        data: {},
      });

      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body).toEqual({
        error: 'validation_error',
        details: [
          {
            field: 'refs',
            message: 'Refs is required and must be an array of item references',
          },
        ],
      });
    });

    // AC: @trait-api-endpoint ac-6
    test('includes x-request-id header on batch responses', async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/items/batch`, {
        data: { refs: ['@test-feature'] },
      });

      expect(response.status()).toBe(200);
      expect(response.headers()['x-request-id']).toBeTruthy();
    });
  });

  test.describe('Content-Type and Response Format', () => {
    // AC: @api-contract ac-8 - JSON content type for GET /api/items
    test('returns JSON content type for list endpoint', async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/items`);
      expect(response.status()).toBe(200);

      const contentType = response.headers()['content-type'] || '';
      expect(contentType).toContain('application/json');
    });

    // AC: @api-contract ac-8, ac-10 - list and detail responses consistent
    test('list and detail responses have consistent item fields', async ({ request, daemon }) => {
      // Get list
      const listResponse = await request.get(`${daemon.baseUrl}/api/items?type=feature`);
      const listBody = await listResponse.json();
      expect(listBody.items.length).toBeGreaterThan(0);

      const listItem = listBody.items[0];
      expect(listItem._ulid).toBeTruthy();

      // Get detail by ULID
      const detailResponse = await request.get(`${daemon.baseUrl}/api/items/@${listItem._ulid}`);
      expect(detailResponse.status()).toBe(200);
      const detailItem = await detailResponse.json();

      // Core fields should be consistent between list and detail
      expect(detailItem._ulid).toBe(listItem._ulid);
      expect(detailItem.title).toBe(listItem.title);
      expect(detailItem.type).toBe(listItem.type);
    });
  });
});
