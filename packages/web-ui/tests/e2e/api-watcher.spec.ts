/**
 * E2E API Tests for Daemon File Watcher
 *
 * Tests verify actual file watcher behavior by writing YAML files to the daemon's
 * .kspec directory and observing WebSocket broadcasts. These replace the static
 * analysis tests in tests/daemon-watcher.test.ts which only read source files
 * and checked string patterns.
 *
 * Note: File watcher tests are SKIPPED in CI because GitHub Actions does not
 * support recursive fs.watch. Tests pass locally where fs.watch works correctly.
 *
 * Covered ACs:
 * - @daemon-server ac-4: File changes broadcast via WebSocket to subscribed clients
 * - @daemon-server ac-5: Rapid successive file changes are debounced into single notification
 * - @daemon-server ac-6: YAML parse errors don't crash the watcher — error event broadcast instead
 */

// Trait N/A annotations
// AC: @trait-json-output ac-1 — N/A: daemon file watcher is not a CLI command
// AC: @trait-json-output ac-2 — N/A: daemon file watcher is not a CLI command
// AC: @trait-json-output ac-3 — N/A: daemon file watcher is not a CLI command
// AC: @trait-json-output ac-4 — N/A: daemon file watcher is not a CLI command
// AC: @trait-json-output ac-5 — N/A: daemon file watcher is not a CLI command
// AC: @trait-json-output ac-6 — N/A: daemon file watcher is not a CLI command
// AC: @trait-error-guidance ac-1 — N/A: watcher errors are broadcast as WebSocket events, not CLI error guidance
// AC: @trait-error-guidance ac-2 — N/A: watcher errors are broadcast as WebSocket events, not CLI error guidance
// AC: @trait-error-guidance ac-3 — N/A: watcher errors are broadcast as WebSocket events, not CLI error guidance
// AC: @trait-error-guidance ac-4 — N/A: watcher errors are broadcast as WebSocket events, not CLI error guidance
// AC: @trait-error-guidance ac-5 — N/A: watcher errors are broadcast as WebSocket events, not CLI error guidance
// AC: @trait-error-guidance ac-6 — N/A: watcher errors are broadcast as WebSocket events, not CLI error guidance
// AC: @trait-shadow-commit ac-1 — N/A: file watcher does not create shadow commits
// AC: @trait-shadow-commit ac-2 — N/A: file watcher does not create shadow commits
// AC: @trait-shadow-commit ac-3 — N/A: file watcher does not create shadow commits
// AC: @trait-shadow-commit ac-4 — N/A: file watcher does not create shadow commits
// AC: @trait-shadow-commit ac-5 — N/A: file watcher does not create shadow commits
// AC: @trait-shadow-commit ac-6 — N/A: file watcher does not create shadow commits
// AC: @trait-shadow-commit ac-7 — N/A: file watcher does not create shadow commits
// AC: @trait-shadow-commit ac-8 — N/A: file watcher does not create shadow commits
// AC: @trait-localhost-security ac-1 — N/A: localhost security tested in api-server.spec.ts
// AC: @trait-localhost-security ac-2 — N/A: non-localhost rejection tested in api-server.spec.ts
// AC: @trait-localhost-security ac-3 — N/A: daemon does not support external binding configuration
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket connection lifecycle tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-2 — N/A: subscribe ack tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-3 — N/A: broadcast format tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-4 — N/A: heartbeat tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-5 — N/A: ping/pong timeout tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-6 — N/A: backpressure tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-7 — N/A: close codes tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-8 — N/A: client reconnection sequence reset tested in connection.spec.ts

import { writeFileSync } from 'fs';
import { join } from 'path';
import { test, expect } from '../fixtures/test-base';

const DAEMON_WS_URL = 'ws://localhost:3456/ws';
const DAEMON_HTTP_URL = 'http://localhost:3456';

/**
 * Connect to the daemon WebSocket from the browser context.
 * Stores WebSocket in window.__testWs for subsequent calls.
 */
async function connectWebSocket(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(DAEMON_HTTP_URL + '/api/health');

  await page.evaluate((wsUrl: string) => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      (window as unknown as Record<string, unknown>).__testWs = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timed out after 5s'));
      }, 5000);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.event === 'connected') {
            clearTimeout(timeout);
            resolve();
          }
        } catch {
          // ignore non-JSON messages
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket error during connection'));
      };

      ws.onclose = (event) => {
        if (event.code !== 1000 && event.code !== 1001) {
          clearTimeout(timeout);
          reject(new Error(`WebSocket closed unexpectedly: code=${event.code}`));
        }
      };
    });
  }, DAEMON_WS_URL);
}

/**
 * Subscribe to a WebSocket topic and wait for the ack.
 */
async function subscribeTopic(page: import('@playwright/test').Page, topic: string): Promise<void> {
  await page.evaluate(
    ({ topicName }: { topicName: string }) => {
      return new Promise<void>((resolve, reject) => {
        const ws = (window as unknown as Record<string, WebSocket>).__testWs;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket not connected'));
          return;
        }

        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for subscribe ack for topic: ${topicName}`));
        }, 5000);

        const original = ws.onmessage;
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.ack === true && data.success) {
              clearTimeout(timeout);
              ws.onmessage = original;
              resolve();
              return;
            }
          } catch {
            // not JSON
          }
          if (original) original.call(ws, event);
        };

        ws.send(
          JSON.stringify({
            action: 'subscribe',
            request_id: `sub-${topicName}-${Date.now()}`,
            payload: { topics: [topicName] },
          })
        );
      });
    },
    { topicName: topic }
  );
}

/**
 * Wait for a broadcast event on a specific topic.
 * Must call subscribeTopic() before this.
 */
async function waitForBroadcast(
  page: import('@playwright/test').Page,
  topic: string,
  timeoutMs = 10000
): Promise<{
  msg_id: string;
  seq: number;
  timestamp: string;
  topic: string;
  event: string;
  data: unknown;
}> {
  return page.evaluate(
    ({ expectedTopic, waitMs }: { expectedTopic: string; waitMs: number }) => {
      return new Promise<{
        msg_id: string;
        seq: number;
        timestamp: string;
        topic: string;
        event: string;
        data: unknown;
      }>((resolve, reject) => {
        const ws = (window as unknown as Record<string, WebSocket>).__testWs;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket not connected'));
          return;
        }

        const timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out after ${waitMs}ms waiting for broadcast on topic: ${expectedTopic}`
            )
          );
        }, waitMs);

        const original = ws.onmessage;
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            // Broadcast events: msg_id, seq, timestamp, topic, event, data
            if (data.topic === expectedTopic && data.msg_id) {
              clearTimeout(timeout);
              ws.onmessage = original;
              resolve(data);
              return;
            }
          } catch {
            // not JSON or wrong format
          }
          if (original) original.call(ws, event);
        };
      });
    },
    { expectedTopic: topic, waitMs: timeoutMs }
  );
}

/**
 * Count broadcasts on a topic received within a time window.
 * The window starts immediately when this promise is created.
 */
async function countBroadcasts(
  page: import('@playwright/test').Page,
  topic: string,
  windowMs: number
): Promise<number> {
  return page.evaluate(
    ({ expectedTopic, durationMs }: { expectedTopic: string; durationMs: number }) => {
      return new Promise<number>((resolve) => {
        const ws = (window as unknown as Record<string, WebSocket>).__testWs;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve(0);
          return;
        }

        let count = 0;
        const original = ws.onmessage;

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.topic === expectedTopic && data.msg_id) {
              count++;
            }
          } catch {
            // ignore
          }
          if (original) original.call(ws, event);
        };

        setTimeout(() => {
          ws.onmessage = original;
          resolve(count);
        }, durationMs);
      });
    },
    { expectedTopic: topic, durationMs: windowMs }
  );
}

/**
 * Wait for a broadcast on the files:errors topic.
 */
async function waitForErrorBroadcast(
  page: import('@playwright/test').Page,
  timeoutMs = 10000
): Promise<{ msg_id: string; topic: string; event: string; data: { error: string; ref?: string } }> {
  return page.evaluate(
    ({ waitMs }: { waitMs: number }) => {
      return new Promise<{
        msg_id: string;
        topic: string;
        event: string;
        data: { error: string; ref?: string };
      }>((resolve, reject) => {
        const ws = (window as unknown as Record<string, WebSocket>).__testWs;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket not connected'));
          return;
        }

        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for files:errors broadcast'));
        }, waitMs);

        const original = ws.onmessage;
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.topic === 'files:errors' && data.msg_id) {
              clearTimeout(timeout);
              ws.onmessage = original;
              resolve(data);
              return;
            }
          } catch {
            // not JSON
          }
          if (original) original.call(ws, event);
        };
      });
    },
    { waitMs: timeoutMs }
  );
}

test.describe('File Watcher API', () => {
  // Skip all file watcher tests in CI — GitHub Actions does not support recursive fs.watch.
  // The CI environment's Chokidar fallback doesn't reliably emit events, causing flaky tests.
  // Tests pass locally where native fs.watch with recursive mode works correctly.
  test.beforeEach(async ({}, testInfo) => {
    if (process.env.CI) {
      testInfo.skip(
        true,
        'File watcher tests skip in CI — GitHub Actions does not support recursive fs.watch'
      );
    }
  });

  test.beforeEach(async ({ page }) => {
    await connectWebSocket(page);
  });

  // AC: @daemon-server ac-4
  test('broadcasts files:updates when a YAML file in .kspec is modified', async ({
    page,
    daemon,
  }) => {
    await subscribeTopic(page, 'files:updates');

    // Set up broadcast listener BEFORE modifying the file to avoid race conditions
    const broadcastPromise = waitForBroadcast(page, 'files:updates');

    // Modify a YAML file directly in the daemon's .kspec directory
    const targetFile = join(daemon.kspecDir, 'kynetic.yaml');
    writeFileSync(
      targetFile,
      [
        'kynetic: "1.0"',
        '',
        'project:',
        '  name: "E2E Watcher Test Project"',
        '  version: "0.2.0"',
        '  status: draft',
        '  description: Modified by file watcher E2E test',
        '',
      ].join('\n')
    );

    // Wait for watcher to debounce and broadcast
    const broadcast = await broadcastPromise;

    // AC: @daemon-server ac-4 — file change triggers WebSocket broadcast with correct structure
    expect(broadcast).toHaveProperty('msg_id');
    expect(typeof broadcast.msg_id).toBe('string');
    expect(broadcast.msg_id.length).toBeGreaterThan(0);

    expect(broadcast.topic).toBe('files:updates');

    expect(broadcast).toHaveProperty('seq');
    expect(typeof broadcast.seq).toBe('number');
    expect(broadcast.seq).toBeGreaterThan(0);

    expect(broadcast).toHaveProperty('timestamp');
    expect(typeof broadcast.timestamp).toBe('string');
    expect(isNaN(new Date(broadcast.timestamp as string).getTime())).toBe(false);

    expect(broadcast).toHaveProperty('event');
    expect(typeof broadcast.event).toBe('string');

    expect(broadcast).toHaveProperty('data');
  });

  // AC: @daemon-server ac-4
  test('file change via HTTP API mutation triggers watcher broadcast', async ({
    page,
    daemon,
    request,
  }) => {
    await subscribeTopic(page, 'files:updates');

    // Get a task from the fixture
    const tasksResponse = await request.get(`${DAEMON_HTTP_URL}/api/tasks`);
    const tasksBody = await tasksResponse.json();
    expect(tasksBody.items.length).toBeGreaterThan(0);
    const taskRef = tasksBody.items[0]._ulid;

    // Set up listener before triggering mutation
    const broadcastPromise = waitForBroadcast(page, 'files:updates');

    // Add a note via HTTP API — daemon writes to project.tasks.yaml, watcher detects it
    const noteResponse = await request.post(`${DAEMON_HTTP_URL}/api/tasks/${taskRef}/note`, {
      data: {
        content: 'E2E file watcher detection test note',
        author: '@test',
      },
    });
    expect(noteResponse.status()).toBe(200);

    // AC: @daemon-server ac-4 — broadcast received after API-triggered file change
    const broadcast = await broadcastPromise;
    expect(broadcast.topic).toBe('files:updates');
    expect(broadcast).toHaveProperty('msg_id');
  });

  // AC: @daemon-server ac-5
  test('rapid successive file changes are debounced — fewer broadcasts than writes', async ({
    page,
    daemon,
  }) => {
    await subscribeTopic(page, 'files:updates');

    const targetFile = join(daemon.kspecDir, 'kynetic.yaml');
    const base = [
      'kynetic: "1.0"',
      '',
      'project:',
      '  name: "Debounce Test"',
      '  version: "0.1.0"',
      '  status: draft',
    ].join('\n');

    // Start counting broadcasts in a 2-second window, then make rapid writes
    // Both the counter and the writes start near-simultaneously
    const countingPromise = countBroadcasts(page, 'files:updates', 2000);

    // 3 rapid writes within ~120ms — all within the 500ms debounce window
    writeFileSync(targetFile, base + '\n  description: rapid write 1\n');
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(targetFile, base + '\n  description: rapid write 2\n');
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(targetFile, base + '\n  description: rapid write 3\n');

    // Wait for counting window to complete
    const broadcastCount = await countingPromise;

    // AC: @daemon-server ac-5 — debounce collapses rapid writes into fewer broadcasts
    // Ideal: 1 broadcast. Allow up to 2 for timing edge cases.
    expect(broadcastCount).toBeGreaterThanOrEqual(1); // At least one change was detected
    expect(broadcastCount).toBeLessThanOrEqual(2); // Debounce prevented 3 separate broadcasts
  });

  // AC: @daemon-server ac-5
  test('no second broadcast arrives within 400ms after debounced rapid writes', async ({
    page,
    daemon,
  }) => {
    await subscribeTopic(page, 'files:updates');

    const targetFile = join(daemon.kspecDir, 'kynetic.yaml');
    const base = [
      'kynetic: "1.0"',
      '',
      'project:',
      '  name: "Debounce Verify"',
      '  version: "0.1.0"',
      '  status: draft',
    ].join('\n');

    // 3 rapid writes within ~100ms — all within 500ms debounce
    writeFileSync(targetFile, base + '\n  description: write A\n');
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(targetFile, base + '\n  description: write B\n');
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(targetFile, base + '\n  description: write C\n');

    // The debounce fires 500ms after the last write (write C + 500ms)
    // Wait for the first (debounced) broadcast
    const firstBroadcast = await waitForBroadcast(page, 'files:updates');

    // AC: @daemon-server ac-5 — debounced broadcast arrives
    expect(firstBroadcast.topic).toBe('files:updates');
    expect(firstBroadcast).toHaveProperty('msg_id');

    // Verify no additional broadcast arrives in the next 400ms
    // (400ms < 500ms debounce, so any lingering timer would have fired by now)
    const extraCount = await countBroadcasts(page, 'files:updates', 400);
    expect(extraCount).toBe(0);
  });

  // AC: @daemon-server ac-6
  test('YAML parse error does not crash daemon — broadcasts error event on files:errors', async ({
    page,
    daemon,
    request,
  }) => {
    await subscribeTopic(page, 'files:updates');
    await subscribeTopic(page, 'files:errors');

    const targetFile = join(daemon.kspecDir, 'kynetic.yaml');
    // Write invalid YAML that will fail to parse
    const invalidYaml = [
      'kynetic: "1.0"',
      '{ invalid yaml: [unclosed bracket',
      '  bad indentation:',
    ].join('\n');

    // Set up error listener before writing the bad file
    const errorBroadcastPromise = waitForErrorBroadcast(page);

    writeFileSync(targetFile, invalidYaml);

    // Wait for the error broadcast
    const errorBroadcast = await errorBroadcastPromise;

    // AC: @daemon-server ac-6 — error event is broadcast with correct structure
    expect(errorBroadcast.topic).toBe('files:errors');
    expect(errorBroadcast.event).toBe('file_error');
    expect(errorBroadcast).toHaveProperty('msg_id');
    expect(errorBroadcast.data).toHaveProperty('error');
    expect(typeof errorBroadcast.data.error).toBe('string');
    expect(errorBroadcast.data.error.length).toBeGreaterThan(0);

    // AC: @daemon-server ac-6 — daemon did NOT crash, still responds to health check
    const healthResponse = await request.get(`${DAEMON_HTTP_URL}/api/health`);
    expect(healthResponse.status()).toBe(200);
    const health = await healthResponse.json();
    expect(health.status).toBe('ok');
  });

  // AC: @daemon-server ac-6
  test('daemon recovers after YAML parse error and processes subsequent valid file change', async ({
    page,
    daemon,
    request,
  }) => {
    await subscribeTopic(page, 'files:updates');
    await subscribeTopic(page, 'files:errors');

    const targetFile = join(daemon.kspecDir, 'kynetic.yaml');

    // Step 1: Write invalid YAML — should broadcast error, not crash
    const errorPromise = waitForErrorBroadcast(page);
    writeFileSync(targetFile, 'kynetic: "1.0"\n{ invalid: [unclosed\n');
    await errorPromise; // Confirm error was detected and broadcast (watcher still active)

    // Step 2: Fix the file with valid YAML — watcher should resume processing normally
    const recoveryPromise = waitForBroadcast(page, 'files:updates');
    writeFileSync(
      targetFile,
      [
        'kynetic: "1.0"',
        '',
        'project:',
        '  name: "Recovered Project"',
        '  version: "0.1.0"',
        '  status: draft',
        '  description: Recovered after YAML parse error',
        '',
      ].join('\n')
    );
    const recoveryBroadcast = await recoveryPromise;

    // AC: @daemon-server ac-6 — daemon processes valid file after error (not crashed/frozen)
    expect(recoveryBroadcast.topic).toBe('files:updates');
    expect(recoveryBroadcast).toHaveProperty('msg_id');

    // Final health check
    const healthResponse = await request.get(`${DAEMON_HTTP_URL}/api/health`);
    expect(healthResponse.status()).toBe(200);
  });
});
