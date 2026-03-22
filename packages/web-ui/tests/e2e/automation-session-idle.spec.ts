/**
 * E2E Tests for Automation View — Session Idle Events and Session Prompt Action Type
 *
 * Tests verify the /automation page renders session.idle events with enriched
 * detail (turn count, agent ID, duration) and that the hook display recognizes
 * the session_prompt action type.
 *
 * Covered ACs:
 * - @session-idle-event ac-1: Event log renders session idle events with turn context
 */

import { test, expect } from '../fixtures/test-base';

// AC: @session-idle-event ac-1
test.describe('Automation View — Session Idle Event Rendering', () => {
  const MOCK_SESSION_IDLE_EVENT = {
    event_id: 'evt-session-idle-001',
    event_type: 'session.idle',
    emitted_at: '2026-03-22T10:30:00.000Z',
    source_type: 'session',
    source_id: 'session-abc123',
    causation_id: null,
    correlation_id: 'corr-001',
    payload: {
      session_id: 'session-abc123',
      agent_id: 'task-worker',
      task_ref: '@task-example',
      turn_count: 3,
      stop_reason: 'end_turn',
      duration_ms: 45200,
    },
  };

  const MOCK_TASK_EVENT = {
    event_id: 'evt-task-ready-001',
    event_type: 'task.ready',
    emitted_at: '2026-03-22T10:29:00.000Z',
    source_type: 'task_watcher',
    source_id: 'task-001',
    causation_id: 'cause-001',
    correlation_id: null,
    payload: {
      task_id: 'task-001',
      status: 'pending',
    },
  };

  function mockEventsResponse(events: unknown[]) {
    return {
      items: events,
      total: events.length,
      offset: 0,
      limit: 50,
    };
  }

  // AC: @session-idle-event ac-1
  test('session.idle event row shows turn count badge', async ({ page, daemon }) => {
    await page.route('**/api/events/recent*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockEventsResponse([MOCK_SESSION_IDLE_EVENT])),
      });
    });

    await page.goto('/automation');
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    const section = page.getByTestId('event-log-section');
    await expect(section).toBeVisible();

    const turnBadge = page.getByTestId('session-idle-turn-count');
    await expect(turnBadge).toBeVisible();
    await expect(turnBadge).toContainText('turn 3');
  });

  // AC: @session-idle-event ac-1
  test('session.idle event row shows agent ID', async ({ page, daemon }) => {
    await page.route('**/api/events/recent*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockEventsResponse([MOCK_SESSION_IDLE_EVENT])),
      });
    });

    await page.goto('/automation');
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    const agentId = page.getByTestId('session-idle-agent');
    await expect(agentId).toBeVisible();
    await expect(agentId).toContainText('task-worker');
  });

  // AC: @session-idle-event ac-1
  test('session.idle event row shows formatted duration', async ({ page, daemon }) => {
    await page.route('**/api/events/recent*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockEventsResponse([MOCK_SESSION_IDLE_EVENT])),
      });
    });

    await page.goto('/automation');
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    const duration = page.getByTestId('session-idle-duration');
    await expect(duration).toBeVisible();
    // 45200ms = 45.2s
    await expect(duration).toContainText('45.2s');
  });

  // AC: @session-idle-event ac-1
  test('session.idle event shows session domain badge', async ({ page, daemon }) => {
    await page.route('**/api/events/recent*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockEventsResponse([MOCK_SESSION_IDLE_EVENT])),
      });
    });

    await page.goto('/automation');
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    // The event type badge should show "session.idle" with outline variant (session domain)
    const row = page.getByTestId('event-row-evt-session-idle-001');
    await expect(row).toBeVisible();
    await expect(row).toContainText('session.idle');
  });

  // AC: @session-idle-event ac-1
  test('non-session.idle events still show causation ID in details', async ({ page, daemon }) => {
    await page.route('**/api/events/recent*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockEventsResponse([MOCK_TASK_EVENT])),
      });
    });

    await page.goto('/automation');
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    const details = page.getByTestId('event-details-evt-task-ready-001');
    await expect(details).toBeVisible();
    // Should show truncated causation ID, not turn count
    await expect(details).toContainText('cause-00');
    // Should NOT show session-idle-specific elements
    await expect(page.getByTestId('session-idle-turn-count')).toHaveCount(0);
  });

  // AC: @session-idle-event ac-1
  test('session.idle expanded payload shows full event data', async ({ page, daemon }) => {
    await page.route('**/api/events/recent*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockEventsResponse([MOCK_SESSION_IDLE_EVENT])),
      });
    });

    await page.goto('/automation');
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    // Click to expand the event row
    const row = page.getByTestId('event-row-evt-session-idle-001');
    await row.click();

    // Expanded payload should show the full JSON including turn_count
    const section = page.getByTestId('event-log-section');
    await expect(section).toContainText('"turn_count": 3');
    await expect(section).toContainText('"agent_id": "task-worker"');
    await expect(section).toContainText('"stop_reason": "end_turn"');
  });
});

test.describe('Automation View — Session Prompt Action Type Badge', () => {
  // AC: @session-idle-event ac-1 — action type badge recognizes session_prompt
  test('hook card shows Session Prompt label for session_prompt action type', async ({ page, daemon }) => {
    await page.route('**/api/hooks*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'hook-session-prompt-001',
              name: 'Follow-up prompt on idle',
              on: 'session.idle',
              filter: { turn_count: 1 },
              action_type: 'session_prompt',
              enabled: true,
            },
          ],
          total: 1,
          offset: 0,
          limit: 50,
        }),
      });
    });

    await page.goto('/automation');
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    const hookCard = page.getByTestId('hook-card-hook-session-prompt-001');
    await expect(hookCard).toBeVisible();

    // Should show human-friendly label instead of raw action_type
    const actionBadge = hookCard.getByTestId('hook-action-badge');
    await expect(actionBadge).toBeVisible();
    await expect(actionBadge).toContainText('Session Prompt');
  });

  test('hook card shows event badge for session.idle trigger', async ({ page, daemon }) => {
    await page.route('**/api/hooks*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'hook-session-prompt-002',
              name: 'Idle handler',
              on: 'session.idle',
              filter: null,
              action_type: 'session_prompt',
              enabled: true,
            },
          ],
          total: 1,
          offset: 0,
          limit: 50,
        }),
      });
    });

    await page.goto('/automation');
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    const hookCard = page.getByTestId('hook-card-hook-session-prompt-002');
    await expect(hookCard).toBeVisible();
    await expect(hookCard).toContainText('on: session.idle');
  });
});

test.describe('Automation View — Trigger Picker Includes Session Idle', () => {
  // AC: @session-idle-event ac-1 — trigger picker shows session.idle as available event
  test('trigger picker includes session.idle in available events', async ({ page, daemon }) => {
    await page.goto('/automation');
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    // Open edit dialog for pr-reviewer (has fewer triggers, more available)
    await page.getByTestId('edit-triggers-pr-reviewer').click();
    await expect(page.getByTestId('trigger-edit-dialog')).toBeVisible();

    // session.idle should be available to add
    const addButton = page.getByTestId('add-trigger-session.idle');
    await expect(addButton).toBeVisible();
  });
});
