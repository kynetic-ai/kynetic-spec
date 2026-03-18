import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { Elysia } from 'elysia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initGitRepo, createTempDir, cleanupTempDir } from './helpers/cli.js';
import { testUlid } from './helpers/cli.js';
import { projectContextMiddleware } from '../dist/daemon/middleware/project-context.ts';
import { createAutomationRoutes } from '../dist/daemon/routes/automation.ts';
import {
  createAgentDispatchRoutes,
  getDispatchEngine,
} from '../dist/daemon/routes/agent-dispatch.ts';

/**
 * Set up a kspec project directory with automation config (hooks, schedules, compositions).
 */
async function setupAutomationProject(prefix: string, options: {
  hooks?: Array<{ _ulid: string; name: string; on: string; enabled: boolean; filter?: Record<string, unknown>; action: { type: string; command: string } }>;
  schedules?: Array<{ _ulid: string; id: string; name: string; cron: string; timezone?: string; overlap_policy?: string; backfill?: boolean; enabled: boolean; action: { type: string; command: string } }>;
  compositions?: Array<{ _ulid: string; id: string; name: string; join_count: number; on_complete: { type: string; command: string }; timeout_ms?: number; enabled: boolean }>;
} = {}) {
  const rootDir = await createTempDir(prefix);

  initGitRepo(rootDir);

  // Write kynetic.yaml
  writeFileSync(
    join(rootDir, 'kynetic.yaml'),
    YAML.stringify({ kynetic: '1', project: { name: 'Automation Test' } }),
  );

  // Write kynetic.meta.yaml with hooks, schedules, compositions
  const metaContent: Record<string, unknown> = {
    kynetic_meta: '1.0',
    agents: [],
    hooks: options.hooks ?? [],
    schedules: options.schedules ?? [],
    compositions: options.compositions ?? [],
  };
  writeFileSync(
    join(rootDir, 'kynetic.meta.yaml'),
    YAML.stringify(metaContent),
  );

  // Write project.tasks.yaml
  writeFileSync(join(rootDir, 'project.tasks.yaml'), YAML.stringify({ tasks: [] }));

  // Create .kspec directory
  mkdirSync(join(rootDir, '.kspec'), { recursive: true });
  writeFileSync(join(rootDir, '.kspec', 'placeholder'), 'shadow');
  writeFileSync(join(rootDir, 'README.md'), '# test\n');

  return rootDir;
}

function createTestApp() {
  const { middleware } = projectContextMiddleware();
  return new Elysia()
    .use(middleware)
    .use(createAgentDispatchRoutes())
    .use(createAutomationRoutes());
}

function makeRequest(app: Elysia, path: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
} = {}) {
  const reqOptions: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      Host: 'localhost',
      ...options.headers,
    },
  };
  if (options.body !== undefined) {
    reqOptions.body = JSON.stringify(options.body);
    (reqOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  return app.handle(new Request(`http://localhost${path}`, reqOptions));
}

describe('Automation API routes', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    // Stop any running engines by sending stop requests
    const dirs = tempDirs.splice(0);
    for (const dir of dirs) {
      const engine = getDispatchEngine(dir);
      if (engine) {
        const app = createTestApp();
        await makeRequest(app, '/api/agent/dispatch', {
          method: 'POST',
          headers: { 'X-Kspec-Dir': dir },
          body: { action: 'stop' },
        });
      }
      await cleanupTempDir(dir);
    }
  });

  // ─── Hooks ──────────────────────────────────────────────────────────────

  describe('GET /api/hooks', () => {
    // AC: @automation-api ac-1
    it('returns all configured hooks with enabled state', async () => {
      const hookUlid1 = testUlid('hook1');
      const hookUlid2 = testUlid('hook2');
      const rootDir = await setupAutomationProject('kspec-auto-hooks-', {
        hooks: [
          {
            _ulid: hookUlid1,
            name: 'on-task-ready',
            on: 'task.ready',
            enabled: true,
            filter: { source_type: 'task_watcher' },
            action: { type: 'command', command: 'echo ready' },
          },
          {
            _ulid: hookUlid2,
            name: 'on-task-review',
            on: 'task.pending_review',
            enabled: false,
            action: { type: 'command', command: 'echo done' },
          },
        ],
      });
      tempDirs.push(rootDir);

      const app = createTestApp();
      const response = await makeRequest(app, '/api/hooks', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.items).toHaveLength(2);
      expect(data.total).toBe(2);

      // First hook — enabled
      const hook1 = data.items.find((h: { name: string }) => h.name === 'on-task-ready');
      expect(hook1).toBeDefined();
      expect(hook1.enabled).toBe(true);
      expect(hook1.on).toBe('task.ready');
      expect(hook1.action_type).toBe('command');

      // Second hook — disabled
      const hook2 = data.items.find((h: { name: string }) => h.name === 'on-task-review');
      expect(hook2).toBeDefined();
      expect(hook2.enabled).toBe(false);
    });

    // AC: @trait-api-endpoint ac-4
    it('supports pagination with limit and offset', async () => {
      const hooks = Array.from({ length: 3 }, (_, i) => ({
        _ulid: testUlid(`hookpg${i}`),
        name: `hook-${i}`,
        on: 'task.ready' as const,
        enabled: true,
        action: { type: 'command' as const, command: `echo ${i}` },
      }));

      const rootDir = await setupAutomationProject('kspec-auto-hooks-page-', { hooks });
      tempDirs.push(rootDir);

      const app = createTestApp();
      const response = await makeRequest(app, '/api/hooks?limit=2&offset=1', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.items).toHaveLength(2);
      expect(data.total).toBe(3);
      expect(data.offset).toBe(1);
      expect(data.limit).toBe(2);
    });

    // AC: @trait-api-endpoint ac-1
    it('returns empty list when no hooks configured', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-hooks-empty-');
      tempDirs.push(rootDir);

      const app = createTestApp();
      const response = await makeRequest(app, '/api/hooks', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.items).toHaveLength(0);
      expect(data.total).toBe(0);
    });
  });

  // ─── Schedules ──────────────────────────────────────────────────────────

  describe('GET /api/schedules', () => {
    // AC: @trait-api-endpoint ac-4
    it('returns all configured schedules with pagination', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-sched-list-', {
        schedules: [
          {
            _ulid: testUlid('sched1'),
            id: 'daily-backup',
            name: 'Daily Backup',
            cron: '0 2 * * *',
            timezone: 'UTC',
            overlap_policy: 'skip',
            enabled: true,
            action: { type: 'command', command: 'echo backup' },
          },
        ],
      });
      tempDirs.push(rootDir);

      const app = createTestApp();
      const response = await makeRequest(app, '/api/schedules', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].id).toBe('daily-backup');
      expect(data.items[0].name).toBe('Daily Backup');
      expect(data.items[0].enabled).toBe(true);
      expect(data.total).toBe(1);
    });
  });

  describe('GET /api/schedules/:id/status', () => {
    // AC: @automation-api ac-2
    it('returns schedule runtime status when engine is running', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-sched-status-', {
        schedules: [
          {
            _ulid: testUlid('sched2'),
            id: 'hourly-sync',
            name: 'Hourly Sync',
            cron: '0 * * * *',
            timezone: 'UTC',
            overlap_policy: 'skip',
            enabled: true,
            action: { type: 'command', command: 'echo sync' },
          },
        ],
      });
      tempDirs.push(rootDir);

      const app = createTestApp();

      // Start dispatch engine
      const startResp = await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });
      expect(startResp.status).toBe(200);

      // Query schedule status
      const response = await makeRequest(app, '/api/schedules/hourly-sync/status', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.id).toBe('hourly-sync');
      expect(data.name).toBe('Hourly Sync');
      expect(data.enabled).toBe(true);
      expect(data.cron).toBe('0 * * * *');
      expect(data.run_count).toBe(0);
      expect(data.active_run_count).toBe(0);
      expect(data.active_run_ids).toEqual([]);
      expect(data.overlap_state).toBe('idle');
      // next_tick should be a valid ISO date string
      expect(data.next_tick).toBeTruthy();
      expect(data.last_tick).toBeNull();
    });

    // AC: @trait-api-endpoint ac-2
    it('returns 404 when schedule not found', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-sched-404-', {
        schedules: [
          {
            _ulid: testUlid('sched3'),
            id: 'existing-schedule',
            name: 'Existing',
            cron: '0 * * * *',
            enabled: true,
            action: { type: 'command', command: 'echo hi' },
          },
        ],
      });
      tempDirs.push(rootDir);

      const app = createTestApp();

      // Start dispatch engine
      await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });

      // Query non-existent schedule
      const response = await makeRequest(app, '/api/schedules/nonexistent/status', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('not_found');
    });

    it('returns 404 when no engine running', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-sched-noeng-');
      tempDirs.push(rootDir);

      const app = createTestApp();
      const response = await makeRequest(app, '/api/schedules/any-id/status', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('not_found');
    });
  });

  describe('POST /api/schedules/:id/trigger', () => {
    // AC: @automation-api ac-3
    it('triggers a schedule and returns accepted outcome', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-trigger-', {
        schedules: [
          {
            _ulid: testUlid('schtrig'),
            id: 'test-trigger',
            name: 'Test Trigger',
            cron: '0 0 1 1 *',  // January 1st — won't fire naturally
            enabled: true,
            action: { type: 'command', command: 'echo triggered' },
          },
        ],
      });
      tempDirs.push(rootDir);

      const app = createTestApp();

      // Start dispatch engine
      await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });

      // Trigger the schedule
      const response = await makeRequest(app, '/api/schedules/test-trigger/trigger', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.outcome).toBe('accepted');
      expect(data.accepted).toBe(true);
    });

    // AC: @trait-api-endpoint ac-2
    it('returns 404 for non-existent schedule', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-trig404-', {
        schedules: [
          {
            _ulid: testUlid('sch404t'),
            id: 'real-schedule',
            name: 'Real Schedule',
            cron: '0 * * * *',
            enabled: true,
            action: { type: 'command', command: 'echo hi' },
          },
        ],
      });
      tempDirs.push(rootDir);

      const app = createTestApp();
      await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });

      const response = await makeRequest(app, '/api/schedules/fake-id/trigger', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(404);
    });
  });

  // ─── Events ──────────────────────────────────────────────────────────────

  describe('GET /api/events/recent', () => {
    // AC: @automation-api ac-4
    it('returns recent events from ring buffer', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-events-');
      tempDirs.push(rootDir);

      const app = createTestApp();

      // Start dispatch engine
      await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });

      // Emit a test event directly on the bus
      const engine = getDispatchEngine(rootDir);
      expect(engine).toBeDefined();
      engine!.eventBus.emit({
        event_type: 'test.event',
        source_type: 'manual',
        source_id: 'test',
        payload: { key: 'value' },
      });

      // Query recent events
      const response = await makeRequest(app, '/api/events/recent', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.items.length).toBeGreaterThanOrEqual(1);
      const testEvent = data.items.find(
        (e: { event_type: string }) => e.event_type === 'test.event',
      );
      expect(testEvent).toBeDefined();
      expect(testEvent.source_type).toBe('manual');
      expect(testEvent.payload.key).toBe('value');
      // AC: @trait-json-output ac-5 — timestamps in ISO 8601
      expect(testEvent.emitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    // AC: @automation-api ac-4 — filter by event type
    it('filters events by type query param', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-events-filter-');
      tempDirs.push(rootDir);

      const app = createTestApp();
      await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });

      const engine = getDispatchEngine(rootDir)!;
      engine.eventBus.emit({
        event_type: 'task.ready',
        source_type: 'manual',
        source_id: 'test',
        payload: {},
      });
      engine.eventBus.emit({
        event_type: 'schedule.tick',
        source_type: 'manual',
        source_id: 'test',
        payload: {},
      });

      const response = await makeRequest(app, '/api/events/recent?type=task.ready', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.items.every(
        (e: { event_type: string }) => e.event_type === 'task.ready',
      )).toBe(true);
    });

    it('returns empty list when no engine running', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-events-noeng-');
      tempDirs.push(rootDir);

      const app = createTestApp();
      const response = await makeRequest(app, '/api/events/recent', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.items).toEqual([]);
      expect(data.total).toBe(0);
    });

    // AC: @trait-api-endpoint ac-4
    it('supports pagination', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-events-page-');
      tempDirs.push(rootDir);

      const app = createTestApp();
      await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });

      const engine = getDispatchEngine(rootDir)!;
      for (let i = 0; i < 5; i++) {
        engine.eventBus.emit({
          event_type: `test.event.${i}`,
          source_type: 'manual',
          source_id: 'test',
          payload: { index: i },
        });
      }

      const response = await makeRequest(app, '/api/events/recent?limit=2&offset=1', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.items).toHaveLength(2);
      expect(data.total).toBe(5);
      expect(data.offset).toBe(1);
      expect(data.limit).toBe(2);
    });
  });

  describe('POST /api/events/emit', () => {
    // AC: @automation-api ac-6
    it('emits a test event on the bus and reports matched hooks', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-emit-', {
        hooks: [
          {
            _ulid: testUlid('hemit1'),
            name: 'match-me',
            on: 'action.completed',
            enabled: true,
            action: { type: 'command', command: 'echo matched' },
          },
          {
            _ulid: testUlid('hemit2'),
            name: 'no-match',
            on: 'schedule.tick',
            enabled: true,
            action: { type: 'command', command: 'echo nope' },
          },
        ],
      });
      tempDirs.push(rootDir);

      const app = createTestApp();
      await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });

      const response = await makeRequest(app, '/api/events/emit', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: {
          event_type: 'action.completed',
          payload: { action_run_id: 'test-run-1', action_type: 'command' },
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.accepted).toBe(true);
      expect(data.event_id).toBeTruthy();
      // Should report matched hooks (match-me should match, no-match should not)
      expect(data.matched_hooks).toHaveLength(1);
      expect(data.matched_hooks[0].name).toBe('match-me');
      // action_run_id may not be available synchronously per AC-6
      expect(data.matched_hooks[0].action_run_id).toBeNull();
    });

    // AC: @trait-api-endpoint ac-3
    it('returns 400 when engine not running', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-emit-noeng-');
      tempDirs.push(rootDir);

      const app = createTestApp();
      const response = await makeRequest(app, '/api/events/emit', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: {
          event_type: 'action.started',
          payload: {},
        },
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('engine_not_running');
    });

    // AC: @automation-api ac-6 — event emitted on bus as manual source
    it('emitted event is visible in recent events', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-emit-visible-');
      tempDirs.push(rootDir);

      const app = createTestApp();
      await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });

      // Emit via API
      await makeRequest(app, '/api/events/emit', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: {
          event_type: 'action.started',
          payload: { foo: 'bar' },
        },
      });

      // Check it appears in recent events
      const response = await makeRequest(app, '/api/events/recent?type=action.started', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].source_type).toBe('manual');
      expect(data.items[0].source_id).toBe('api');
      expect(data.items[0].payload.foo).toBe('bar');
    });
  });

  // ─── Compositions ────────────────────────────────────────────────────────

  describe('GET /api/compositions/:config_id/activations', () => {
    // AC: @automation-api ac-5
    it('returns activations for a composition config', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-comp-', {
        compositions: [
          {
            _ulid: testUlid('comp1'),
            id: 'test-join',
            name: 'Test Join',
            join_count: 3,
            on_complete: { type: 'command', command: 'echo done' },
            timeout_ms: 60000,
            enabled: true,
          },
        ],
      });
      tempDirs.push(rootDir);

      const app = createTestApp();

      // Start dispatch engine (this also starts join accumulator)
      await makeRequest(app, '/api/agent/dispatch', {
        method: 'POST',
        headers: { 'X-Kspec-Dir': rootDir },
        body: { action: 'start' },
      });

      // Query activations — should be empty initially
      const response = await makeRequest(app, '/api/compositions/test-join/activations', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.config_id).toBe('test-join');
      expect(data.activations).toEqual([]);
    });

    it('returns 404 when no engine running', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-comp-noeng-');
      tempDirs.push(rootDir);

      const app = createTestApp();
      const response = await makeRequest(app, '/api/compositions/any-config/activations', {
        headers: { 'X-Kspec-Dir': rootDir },
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('not_found');
    });
  });

  // ─── Trait: @trait-api-endpoint ──────────────────────────────────────────

  describe('trait compliance', () => {
    // AC: @trait-api-endpoint ac-1
    it('all list endpoints return JSON with 2xx status', async () => {
      const rootDir = await setupAutomationProject('kspec-auto-trait-json-');
      tempDirs.push(rootDir);

      const app = createTestApp();
      const endpoints = ['/api/hooks', '/api/schedules', '/api/events/recent'];

      for (const endpoint of endpoints) {
        const response = await makeRequest(app, endpoint, {
          headers: { 'X-Kspec-Dir': rootDir },
        });
        expect(response.status).toBe(200);
        const contentType = response.headers.get('content-type');
        expect(contentType).toContain('json');
      }
    });
  });

  // ─── Trait: @trait-json-output ──────────────────────────────────────────

  // AC: @trait-json-output ac-5 — timestamps use ISO 8601
  // Covered by 'returns recent events from ring buffer' test above

  // ─── Trait: @trait-localhost-security ────────────────────────────────────

  // AC: @trait-localhost-security ac-1, ac-2, ac-3
  // Localhost security is handled at the server level (localhostOnly middleware),
  // not at the route level. These are infrastructure concerns tested in daemon-server.test.ts.
  // AC: @trait-localhost-security ac-1 — N/A: Server binding is tested in daemon-server.test.ts
  // AC: @trait-localhost-security ac-2 — N/A: Connection rejection is tested in daemon-server.test.ts
  // AC: @trait-localhost-security ac-3 — N/A: Security warning is tested in daemon-server.test.ts

  // ─── Trait: @trait-api-endpoint ac-6 ────────────────────────────────────

  // AC: @trait-api-endpoint ac-6 — N/A: X-Request-Id header is infrastructure concern handled by Elysia framework

  // ─── Trait: @trait-api-endpoint ac-5 ────────────────────────────────────

  // AC: @trait-api-endpoint ac-5 — N/A: The automation API endpoints are read-only queries
  // against runtime state. The only mutation (POST /events/emit) emits on the in-memory bus,
  // which is volatile — no shadow commit needed.

  // ─── Trait: @trait-json-output ──────────────────────────────────────────

  // AC: @trait-json-output ac-1 — N/A: These are API endpoints, not CLI commands with --json flag
  // AC: @trait-json-output ac-2 — N/A: These are API endpoints, not CLI commands
  // AC: @trait-json-output ac-3 — N/A: These are API endpoints, not CLI commands
  // AC: @trait-json-output ac-4 — N/A: These are API endpoints; refs use @ prefix where applicable
  // AC: @trait-json-output ac-6 — N/A: These are API endpoints, not CLI commands with formatting flags
});
