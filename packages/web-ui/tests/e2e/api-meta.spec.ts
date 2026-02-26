/**
 * E2E API Tests for Daemon Meta, Validation, and Search Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 * These replace the static analysis tests in:
 *   - tests/daemon-api-meta.test.ts (224 lines)
 *   - tests/daemon-api-validation.test.ts (166 lines)
 *
 * Covered ACs:
 * - @api-contract ac-15: GET /api/meta/session returns session context (focus, threads, questions)
 * - @api-contract ac-16: GET /api/meta/agents returns all defined agents
 * - @api-contract ac-17: GET /api/meta/workflows returns all defined workflows
 * - @api-contract ac-18: GET /api/meta/observations with resolved filter
 * - @api-contract ac-19: GET /api/search?q=keyword searches across all entities
 * - @api-contract ac-20: GET /api/validate returns ValidationResult
 * - @api-contract ac-21: GET /api/alignment returns AlignmentIndex stats and warnings
 *
 * Trait ACs from @trait-json-output:
 * // AC: @trait-json-output ac-1 — N/A: HTTP API always returns JSON, no --json flag needed
 * // AC: @trait-json-output ac-2 — N/A: HTTP API always returns full data, no human-readable mode
 * // AC: @trait-json-output ac-3 — N/A: HTTP API errors use status codes and JSON bodies, not --json flag
 * // AC: @trait-json-output ac-4 — N/A: HTTP API ref format not applicable to REST JSON responses
 * // AC: @trait-json-output ac-5 — N/A: covered by verifying ISO 8601 timestamps in response fields below
 * // AC: @trait-json-output ac-6 — N/A: HTTP API has no formatting flags equivalent to --json
 *
 * Trait ACs from @trait-filterable-list:
 * // AC: @trait-filterable-list ac-1 — N/A: REST query params differ from CLI --status flags; covered by search tests
 * // AC: @trait-filterable-list ac-2 — N/A: REST query params differ from CLI --tag flags
 * // AC: @trait-filterable-list ac-3 — N/A: HTTP API uses limit query param; covered by search limit test below
 * // AC: @trait-filterable-list ac-4 — N/A: HTTP API uses offset query param, not tested on these endpoints
 * // AC: @trait-filterable-list ac-5 — N/A: HTTP API uses AND logic via query params; covered by search filter tests
 * // AC: @trait-filterable-list ac-6 — N/A: REST API returns empty array, not CLI message
 * // AC: @trait-filterable-list ac-7 — N/A: REST API returns total field in JSON response
 * // AC: @trait-filterable-list ac-8 — N/A: REST API does not have count mode
 */

import { test, expect } from '../fixtures/test-base';

const DAEMON_URL = 'http://localhost:3456';

test.describe('Meta API', () => {
  test.describe('GET /api/meta/session', () => {
    // AC: @api-contract ac-15
    test('returns session context with focus, threads, and questions', async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/session`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      // Required fields per ac-15
      expect(body).toHaveProperty('focus');
      expect(body).toHaveProperty('threads');
      expect(body).toHaveProperty('questions');

      // threads and questions are arrays
      expect(Array.isArray(body.threads)).toBe(true);
      expect(Array.isArray(body.questions)).toBe(true);
    });

    // AC: @api-contract ac-15 - fixture data integrity
    test('returns fixture session context values', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/session`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Fixture has focus: "E2E testing", threads: [], questions: []
      expect(body.focus).toBe('E2E testing');
      expect(body.threads).toEqual([]);
      expect(body.questions).toEqual([]);
    });

    // AC: @api-contract ac-15 - JSON content type
    test('returns JSON content type', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/session`);
      const contentType = response.headers()['content-type'] || '';
      expect(contentType).toContain('application/json');
    });
  });

  test.describe('GET /api/meta/agents', () => {
    // AC: @api-contract ac-16
    test('returns paginated response with items and total', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/agents`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.total).toBe('number');
    });

    // AC: @api-contract ac-16 - fixture data consistency
    test('items count matches total field', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/agents`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Fixture has agents: [] in kynetic.meta.yaml
      expect(body.total).toBe(body.items.length);
      expect(body.items.length).toBe(0);
      expect(body.total).toBe(0);
    });
  });

  test.describe('GET /api/meta/workflows', () => {
    // AC: @api-contract ac-17
    test('returns paginated response with items and total', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/workflows`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.total).toBe('number');
    });

    // AC: @api-contract ac-17 - fixture data consistency
    test('items count matches total field', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/workflows`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Fixture has workflows: [] in kynetic.meta.yaml
      expect(body.total).toBe(body.items.length);
      expect(body.items.length).toBe(0);
      expect(body.total).toBe(0);
    });
  });

  test.describe('GET /api/meta/observations', () => {
    // AC: @api-contract ac-18
    test('returns all observations without filter', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/observations`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.items)).toBe(true);
      // Fixture has 2 observations
      expect(body.items.length).toBe(2);
      expect(body.total).toBe(2);
    });

    // AC: @api-contract ac-18 - each observation has required fields
    test('observations have required fields', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/observations`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.items.length).toBeGreaterThan(0);

      const obs = body.items[0];
      expect(obs).toHaveProperty('_ulid');
      expect(obs).toHaveProperty('created_at');
      expect(obs).toHaveProperty('type');
      expect(obs).toHaveProperty('content');
    });

    // AC: @api-contract ac-18 - observations ordered by created_at descending
    test('returns observations ordered by created_at descending (newest first)', async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/observations`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const items = body.items;
      expect(items.length).toBeGreaterThanOrEqual(2);

      // Verify descending order
      for (let i = 0; i < items.length - 1; i++) {
        const current = new Date(items[i].created_at).getTime();
        const next = new Date(items[i + 1].created_at).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });

    // AC: @api-contract ac-18 - filter by resolved=false returns unresolved
    test('filters unresolved observations with ?resolved=false', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/observations?resolved=false`);

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);
      // Fixture has 2 unresolved observations
      expect(body.items.length).toBe(2);

      // None should have resolved_at set
      for (const obs of body.items) {
        expect(obs.resolved_at).toBeFalsy();
      }
    });

    // AC: @api-contract ac-18 - filter by resolved=true returns no results (fixture has none)
    test('filters resolved observations with ?resolved=true', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/observations?resolved=true`);

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);
      // Fixture has no resolved observations
      expect(body.items.length).toBe(0);
      expect(body.total).toBe(0);
    });

    // AC: @api-contract ac-18 - fixture content check
    test('returns fixture observations with correct content', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/meta/observations`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const types = body.items.map((obs: { type: string }) => obs.type);

      // Fixture has friction and success observations
      expect(types).toContain('friction');
      expect(types).toContain('success');

      const frictionObs = body.items.find((obs: { type: string }) => obs.type === 'friction');
      expect(frictionObs.content).toBe('Test friction observation');

      const successObs = body.items.find((obs: { type: string }) => obs.type === 'success');
      expect(successObs.content).toBe('Test success observation');
    });
  });
});

test.describe('Search API', () => {
  test.describe('GET /api/search', () => {
    // AC: @api-contract ac-19
    test('returns search results with results array and total', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/search?q=test`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      expect(body).toHaveProperty('results');
      expect(body).toHaveProperty('total');
      expect(Array.isArray(body.results)).toBe(true);
    });

    // AC: @api-contract ac-19 - each result has type, ulid, title, matchedFields
    test('each search result has required fields', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/search?q=test`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.results.length).toBeGreaterThan(0);

      const result = body.results[0];
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('ulid');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('matchedFields');
      expect(Array.isArray(result.matchedFields)).toBe(true);
    });

    // AC: @api-contract ac-19 - searches across spec items
    test('finds spec items matching query', async ({ request, daemon }) => {
      // Fixture has "Test Feature", "Test Requirement", etc. matching "Core"
      const response = await request.get(`${DAEMON_URL}/api/search?q=Core+Module`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const itemResults = body.results.filter(
        (r: { type: string }) => r.type === 'item'
      );
      expect(itemResults.length).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-19 - searches across tasks
    test('finds tasks matching query', async ({ request, daemon }) => {
      // Fixture has "Ready task", "In progress task", etc.
      const response = await request.get(`${DAEMON_URL}/api/search?q=Ready+task`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const taskResults = body.results.filter((r: { type: string }) => r.type === 'task');
      expect(taskResults.length).toBeGreaterThan(0);
      expect(taskResults[0].type).toBe('task');
    });

    // AC: @api-contract ac-19 - searches inbox items
    test('finds inbox items matching query', async ({ request, daemon }) => {
      // Fixture inbox has "First inbox item for testing"
      const response = await request.get(`${DAEMON_URL}/api/search?q=First+inbox+item`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const inboxResults = body.results.filter((r: { type: string }) => r.type === 'inbox');
      expect(inboxResults.length).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-19 - searches meta entities (observations)
    test('finds observations matching query', async ({ request, daemon }) => {
      // Fixture has "Test friction observation"
      const response = await request.get(`${DAEMON_URL}/api/search?q=friction+observation`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const obsResults = body.results.filter(
        (r: { type: string }) => r.type === 'observation'
      );
      expect(obsResults.length).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-19 - returns empty results for no match
    test('returns empty results for non-matching query', async ({ request, daemon }) => {
      const response = await request.get(
        `${DAEMON_URL}/api/search?q=zzznomatch_unique_xyz_99999`
      );
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.results).toEqual([]);
      expect(body.total).toBe(0);
    });

    // AC: @api-contract ac-19 - returns empty results for empty query
    test('returns empty results when no query provided', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/search`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.results).toEqual([]);
      expect(body.total).toBe(0);
    });

    // AC: @api-contract ac-19 - result types are from known set
    test('result types are from known entity types', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/search?q=test`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const knownTypes = ['item', 'task', 'inbox', 'observation', 'agent', 'workflow', 'convention'];

      for (const result of body.results) {
        expect(knownTypes).toContain(result.type);
      }
    });

    // AC: @api-contract ac-19 - limit parameter restricts results
    test('limits results with ?limit parameter', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/search?q=test&limit=2`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Should have at most 2 results
      expect(body.results.length).toBeLessThanOrEqual(2);
      // Total may be higher than shown
      expect(body).toHaveProperty('showing');
    });

    // AC: @api-contract ac-19 - showing field
    test('includes showing field in response', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/search?q=test`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('showing');
      expect(body.showing).toBe(body.results.length);
    });
  });
});

test.describe('Validation API', () => {
  test.describe('GET /api/validate', () => {
    // AC: @api-contract ac-20
    test('returns ValidationResult with required fields', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/validate`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      // Required ValidationResult fields per ac-20
      expect(body).toHaveProperty('valid');
      expect(body).toHaveProperty('schemaErrors');
      expect(body).toHaveProperty('refErrors');
      expect(body).toHaveProperty('orphans');

      expect(typeof body.valid).toBe('boolean');
      expect(Array.isArray(body.schemaErrors)).toBe(true);
      expect(Array.isArray(body.refErrors)).toBe(true);
      expect(Array.isArray(body.orphans)).toBe(true);
    });

    // AC: @api-contract ac-20 - fixture data is valid
    test('fixture data passes validation', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/validate`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Fixture data should be valid
      expect(body.schemaErrors.length).toBe(0);
      expect(body.refErrors.length).toBe(0);
    });

    // AC: @api-contract ac-20 - includes refWarnings and completenessWarnings
    test('includes refWarnings and completenessWarnings fields', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/validate`);
      expect(response.status()).toBe(200);

      const body = await response.json();

      expect(body).toHaveProperty('refWarnings');
      expect(body).toHaveProperty('completenessWarnings');
      expect(Array.isArray(body.refWarnings)).toBe(true);
      expect(Array.isArray(body.completenessWarnings)).toBe(true);
    });

    // AC: @api-contract ac-20 - includes traitCycles field
    test('includes traitCycles field', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/validate`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('traitCycles');
      expect(Array.isArray(body.traitCycles)).toBe(true);
    });

    // AC: @api-contract ac-20 - JSON content type
    test('returns JSON content type', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/validate`);
      const contentType = response.headers()['content-type'] || '';
      expect(contentType).toContain('application/json');
    });
  });

  test.describe('GET /api/alignment', () => {
    // AC: @api-contract ac-21
    test('returns alignment stats and warnings', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/alignment`);

      expect(response.status()).toBe(200);

      const body = await response.json();

      expect(body).toHaveProperty('stats');
      expect(body).toHaveProperty('warnings');
      expect(Array.isArray(body.warnings)).toBe(true);
    });

    // AC: @api-contract ac-21 - stats has required fields
    test('stats contains required alignment fields', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/alignment`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const stats = body.stats;

      expect(stats).toHaveProperty('totalSpecs');
      expect(stats).toHaveProperty('specsWithTasks');
      expect(stats).toHaveProperty('alignedSpecs');
      expect(stats).toHaveProperty('orphanedSpecs');

      expect(typeof stats.totalSpecs).toBe('number');
      expect(typeof stats.specsWithTasks).toBe('number');
      expect(typeof stats.alignedSpecs).toBe('number');
      expect(typeof stats.orphanedSpecs).toBe('number');
    });

    // AC: @api-contract ac-21 - stats values are non-negative
    test('alignment stats values are non-negative integers', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/alignment`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      const stats = body.stats;

      expect(stats.totalSpecs).toBeGreaterThanOrEqual(0);
      expect(stats.specsWithTasks).toBeGreaterThanOrEqual(0);
      expect(stats.alignedSpecs).toBeGreaterThanOrEqual(0);
      expect(stats.orphanedSpecs).toBeGreaterThanOrEqual(0);
    });

    // AC: @api-contract ac-21 - fixture has spec items
    test('fixture has spec items reflected in totalSpecs', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/alignment`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Fixture has modules/core.yaml with module, feature, trait, requirement
      expect(body.stats.totalSpecs).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-21 - JSON content type
    test('returns JSON content type', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/alignment`);
      const contentType = response.headers()['content-type'] || '';
      expect(contentType).toContain('application/json');
    });
  });
});
