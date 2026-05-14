/**
 * E2E API Tests for Daemon File Watcher
 *
 * Tests verify actual file watcher behavior by writing YAML files to the daemon's
 * .kspec directory and observing WebSocket broadcasts. These replace the static
 * analysis tests in tests/daemon-watcher.test.ts which only read source files
 * and checked string patterns.
 *
 * Note: File watcher tests are SKIPPED in CI because the GitHub Actions
 * environment does not deliver these daemon watcher events reliably enough.
 * Tests pass locally where the watcher can receive native filesystem events.
 *
 * Covered ACs:
 * - @daemon-server ac-4: File changes broadcast via WebSocket to subscribed clients
 * - @daemon-server ac-5: Rapid successive file changes are debounced into single notification
 * - @daemon-server ac-6: YAML parse errors don't crash the watcher — error event broadcast instead
 */

// Spec own AC N/A annotations (ACs not covered in E2E — require infrastructure beyond E2E scope)
// AC: @daemon-server ac-7 — N/A: directory inaccessibility + exponential backoff recovery cannot be reliably triggered in E2E without OS-level access control manipulation; implementation verified in watcher.ts (retryCount, maxRetries, baseBackoffMs, handleWatcherError)
// AC: @daemon-server ac-8 — N/A: watcher recovery/backoff behavior is exercised in unit tests; E2E covers event delivery rather than backend initialization internals

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
// AC: @trait-localhost-security ac-loopback-default — N/A: this watcher-focused E2E does not assert on bind host; default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
// AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
// AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
// AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.
// AC: @trait-websocket-protocol ac-1 — N/A: server connection lifecycle tested in daemon-api/websocket-protocol.test.ts
// AC: @trait-websocket-protocol ac-2 — N/A: subscribe ack tested in daemon-api/websocket-protocol.test.ts
// AC: @trait-websocket-protocol ac-3 — N/A: broadcast format tested in daemon-api/websocket-protocol.test.ts
// AC: @trait-websocket-protocol ac-4 — N/A: heartbeat timing tested in daemon-heartbeat.test.ts
// AC: @trait-websocket-protocol ac-5 — N/A: pong-timeout handling tested in daemon-heartbeat.test.ts
// AC: @trait-websocket-protocol ac-6 — N/A: backpressure handling is outside this watcher-focused spec
// AC: @trait-websocket-protocol ac-7 — N/A: clean shutdown code tested in daemon-api/websocket-protocol.test.ts; timeout close code tested in daemon-heartbeat.test.ts
// AC: @trait-websocket-protocol ac-8 — N/A: client reconnection sequence reset tested in connection.spec.ts

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { test, expect } from "./fixtures/test-base";

/**
 * Connect to the daemon WebSocket from the browser context.
 * Stores WebSocket in window.__testWs for subsequent calls.
 */
async function connectWebSocket(
  page: import("@playwright/test").Page,
  baseUrl: string,
  wsUrl: string,
): Promise<void> {
  await page.goto(`${baseUrl}/api/health`);

  await page.evaluate((evaluateWsUrl: string) => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(evaluateWsUrl);
      (window as unknown as Record<string, unknown>).__testWs = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket connection timed out after 5s"));
      }, 5000);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.event === "connected") {
            clearTimeout(timeout);
            resolve();
          }
        } catch {
          // ignore non-JSON messages
        }
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket error during connection"));
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      ws.onclose = (event) => {
        if (event.code !== 1000 && event.code !== 1001) {
          clearTimeout(timeout);
          reject(new Error(`WebSocket closed unexpectedly: code=${event.code}`));
        }
      };
    });
  }, `${wsUrl}/ws`);
}

/**
 * Subscribe to a WebSocket topic and wait for the ack.
 */
async function subscribeTopic(page: import("@playwright/test").Page, topic: string): Promise<void> {
  await page.evaluate(
    ({ topicName }: { topicName: string }) => {
      return new Promise<void>((resolve, reject) => {
        const ws = (window as unknown as Record<string, WebSocket>).__testWs;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket not connected"));
          return;
        }

        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for subscribe ack for topic: ${topicName}`));
        }, 5000);

        const original = ws.onmessage;
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.ack === true && data.success) {
              clearTimeout(timeout);
              // oxlint-disable-next-line unicorn/prefer-add-event-listener
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
            action: "subscribe",
            request_id: `sub-${topicName}-${Date.now()}`,
            payload: { topics: [topicName] },
          }),
        );
      });
    },
    { topicName: topic },
  );
}

/**
 * Wait for a broadcast event on a specific topic.
 * Must call subscribeTopic() before this.
 */
async function waitForBroadcast(
  page: import("@playwright/test").Page,
  topic: string,
  timeoutMs = 10000,
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
          reject(new Error("WebSocket not connected"));
          return;
        }

        const timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out after ${waitMs}ms waiting for broadcast on topic: ${expectedTopic}`,
            ),
          );
        }, waitMs);

        const original = ws.onmessage;
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            // Broadcast events: msg_id, seq, timestamp, topic, event, data
            if (data.topic === expectedTopic && data.msg_id) {
              clearTimeout(timeout);
              // oxlint-disable-next-line unicorn/prefer-add-event-listener
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
    { expectedTopic: topic, waitMs: timeoutMs },
  );
}

/**
 * Install a broadcast counter for a topic and return a function to collect the count.
 *
 * Unlike countBroadcasts(), this function is two-phase:
 * 1. Call installBroadcastCounter() and await it — this guarantees the listener is
 *    installed in the browser BEFORE any Node.js writes happen.
 * 2. After triggering the writes, call the returned collectFn after a delay to read
 *    the accumulated count.
 *
 * This eliminates the race where page.evaluate() round-trip completes AFTER the
 * debounced broadcast has already fired.
 */
async function installBroadcastCounter(
  page: import("@playwright/test").Page,
  topic: string,
): Promise<() => Promise<number>> {
  // Install the counter in the browser and confirm it's ready
  await page.evaluate(
    ({ expectedTopic }: { expectedTopic: string }) => {
      const ws = (window as unknown as Record<string, WebSocket>).__testWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Attach a named counter that accumulates broadcast count
      (window as unknown as Record<string, number>).__broadcastCount = 0;
      const countKey = `__broadcastCount_${expectedTopic.replace(/:/g, "_")}`;
      (window as unknown as Record<string, number>)[countKey] = 0;

      const original = ws.onmessage;
      const counter = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          if (data.topic === expectedTopic && data.msg_id) {
            (window as unknown as Record<string, number>)[countKey]++;
          }
        } catch {
          // ignore
        }
        if (original) original.call(ws, event);
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      ws.onmessage = counter;
      // Store for cleanup
      (window as unknown as Record<string, unknown>).__broadcastCounter = counter;
      (window as unknown as Record<string, string>).__broadcastCounterTopic = expectedTopic;
    },
    { expectedTopic: topic },
  );

  // Return a collector function that reads the count after writes have settled
  return async () => {
    return page.evaluate(
      ({ expectedTopic }: { expectedTopic: string }) => {
        const countKey = `__broadcastCount_${expectedTopic.replace(/:/g, "_")}`;
        return (window as unknown as Record<string, number>)[countKey] ?? 0;
      },
      { expectedTopic: topic },
    );
  };
}

/**
 * Wait for a broadcast on the files:errors topic.
 */
async function waitForErrorBroadcast(
  page: import("@playwright/test").Page,
  timeoutMs = 10000,
): Promise<{
  msg_id: string;
  topic: string;
  event: string;
  data: { error: string; ref?: string };
}> {
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
          reject(new Error("WebSocket not connected"));
          return;
        }

        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for files:errors broadcast"));
        }, waitMs);

        const original = ws.onmessage;
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.topic === "files:errors" && data.msg_id) {
              clearTimeout(timeout);
              // oxlint-disable-next-line unicorn/prefer-add-event-listener
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
    { waitMs: timeoutMs },
  );
}

test.describe("File Watcher API", () => {
  // Skip all file watcher tests in CI because the hosted environment does not
  // deliver these watcher events reliably, causing flaky integration results.
  // Tests pass locally where native fs.watch with recursive mode works correctly.
  // oxlint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    if (process.env.CI) {
      testInfo.skip(
        true,
        "File watcher tests skip in CI — hosted runners do not deliver watcher events reliably",
      );
    }
  });

  test.beforeEach(async ({ page, daemon }) => {
    await connectWebSocket(page, daemon.baseUrl, daemon.wsUrl);
  });

  // AC: @daemon-server ac-4
  test("broadcasts files:updates when a YAML file in .kspec is modified", async ({
    page,
    daemon,
  }) => {
    await subscribeTopic(page, "files:updates");

    // Set up broadcast listener BEFORE modifying the file to avoid race conditions
    const broadcastPromise = waitForBroadcast(page, "files:updates");

    // Modify a YAML file directly in the daemon's .kspec directory
    const targetFile = join(daemon.kspecDir, "kynetic.yaml");
    writeFileSync(
      targetFile,
      [
        'kynetic: "1.0"',
        "",
        "project:",
        '  name: "E2E Watcher Test Project"',
        '  version: "0.2.0"',
        "  status: draft",
        "  description: Modified by file watcher E2E test",
        "",
      ].join("\n"),
    );

    // Wait for watcher to debounce and broadcast
    const broadcast = await broadcastPromise;

    // AC: @daemon-server ac-4 — file change triggers WebSocket broadcast with correct structure
    expect(broadcast).toHaveProperty("msg_id");
    expect(typeof broadcast.msg_id).toBe("string");
    expect(broadcast.msg_id.length).toBeGreaterThan(0);

    expect(broadcast.topic).toBe("files:updates");

    expect(broadcast).toHaveProperty("seq");
    expect(typeof broadcast.seq).toBe("number");
    expect(broadcast.seq).toBeGreaterThan(0);

    expect(broadcast).toHaveProperty("timestamp");
    expect(typeof broadcast.timestamp).toBe("string");
    expect(isNaN(new Date(broadcast.timestamp as string).getTime())).toBe(false);

    expect(broadcast).toHaveProperty("event");
    expect(typeof broadcast.event).toBe("string");

    expect(broadcast).toHaveProperty("data");
  });

  // AC: @api-contract ac-7
  test("task note API mutation broadcasts tasks:updates and persists the note", async ({
    page,
    daemon,
    request,
  }) => {
    await subscribeTopic(page, "tasks:updates");

    // Get a task from the fixture
    const tasksResponse = await request.get(`${daemon.baseUrl}/api/tasks`);
    const tasksBody = await tasksResponse.json();
    expect(Array.isArray(tasksBody.data)).toBe(true);
    expect(tasksBody.data.length).toBeGreaterThan(0);
    const taskRef = tasksBody.data[0]._ulid;

    // Set up listener before triggering mutation
    const broadcastPromise = waitForBroadcast(page, "tasks:updates");
    const noteContent = "E2E file watcher detection test note";

    // Add a note via HTTP API — the route broadcasts tasks:updates immediately
    // and persists the note into the split-storage notes.yaml file.
    const noteResponse = await request.post(`${daemon.baseUrl}/api/tasks/${taskRef}/note`, {
      data: {
        content: noteContent,
        author: "@test",
      },
    });
    expect(noteResponse.status()).toBe(200);
    const noteBody = await noteResponse.json();
    expect(noteBody.success).toBe(true);
    expect(noteBody.note._ulid).toBeTruthy();

    // AC: @api-contract ac-7 — task note mutation broadcasts task_updated
    const broadcast = await broadcastPromise;
    expect(broadcast.topic).toBe("tasks:updates");
    expect(broadcast.event).toBe("task_updated");
    expect(broadcast).toHaveProperty("msg_id");
    expect(broadcast.data).toMatchObject({
      ref: taskRef,
      ulid: taskRef,
      action: "note_added",
      note_ulid: noteBody.note._ulid,
    });

    const notesPath = join(daemon.kspecDir, "tasks", taskRef, "notes.yaml");
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reads test-generated output in temp dir
    expect(readFileSync(notesPath, "utf8")).toContain(noteContent);
  });

  // AC: @daemon-server ac-5
  test("rapid successive file changes are debounced — fewer broadcasts than writes", async ({
    page,
    daemon,
  }) => {
    await subscribeTopic(page, "files:updates");

    const targetFile = join(daemon.kspecDir, "kynetic.yaml");
    const base = [
      'kynetic: "1.0"',
      "",
      "project:",
      '  name: "Debounce Test"',
      '  version: "0.1.0"',
      "  status: draft",
    ].join("\n");

    // Phase 1: Install the counter listener in the browser and await confirmation.
    // This guarantees the listener is installed BEFORE any Node.js writes happen,
    // eliminating the race where page.evaluate() round-trip occurs after the broadcast.
    const collectCount = await installBroadcastCounter(page, "files:updates");

    // Phase 2: Make 3 rapid writes within ~120ms — all within the 500ms debounce window.
    // The counter listener is already installed, so no broadcasts will be missed.
    writeFileSync(targetFile, `${base}\n  description: rapid write 1\n`);
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(targetFile, `${base}\n  description: rapid write 2\n`);
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(targetFile, `${base}\n  description: rapid write 3\n`);

    // Phase 3: Wait for debounce to settle (500ms window + 300ms buffer), then collect count.
    await new Promise((r) => setTimeout(r, 1200));
    const broadcastCount = await collectCount();

    // AC: @daemon-server ac-5 — debounce collapses rapid writes into fewer broadcasts
    // Ideal: 1 broadcast. Allow up to 2 for timing edge cases where first write's debounce
    // timer fires before the third write resets it.
    expect(broadcastCount).toBeGreaterThanOrEqual(1); // At least one change was detected
    expect(broadcastCount).toBeLessThanOrEqual(2); // Debounce prevented 3 separate broadcasts
  });

  // AC: @daemon-server ac-5
  test("no second broadcast arrives within 400ms after debounced rapid writes", async ({
    page,
    daemon,
  }) => {
    await subscribeTopic(page, "files:updates");

    const targetFile = join(daemon.kspecDir, "kynetic.yaml");
    const base = [
      'kynetic: "1.0"',
      "",
      "project:",
      '  name: "Debounce Verify"',
      '  version: "0.1.0"',
      "  status: draft",
    ].join("\n");

    // Set up broadcast listener BEFORE any writes to eliminate the race where the
    // debounce fires (500ms after last write) before waitForBroadcast is called.
    // waitForBroadcast returns a Promise that resolves on the NEXT broadcast.
    const firstBroadcastPromise = waitForBroadcast(page, "files:updates");

    // 3 rapid writes within ~100ms — all within 500ms debounce.
    // The listener is already installed before the first write.
    writeFileSync(targetFile, `${base}\n  description: write A\n`);
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(targetFile, `${base}\n  description: write B\n`);
    await new Promise((r) => setTimeout(r, 40));
    writeFileSync(targetFile, `${base}\n  description: write C\n`);

    // The debounce fires 500ms after the last write (write C + 500ms)
    const firstBroadcast = await firstBroadcastPromise;

    // AC: @daemon-server ac-5 — debounced broadcast arrives
    expect(firstBroadcast.topic).toBe("files:updates");
    expect(firstBroadcast).toHaveProperty("msg_id");

    // Install a fresh counter for the 400ms window AFTER the first broadcast.
    // (400ms < 500ms debounce, so any lingering timer would have fired by now)
    const collectExtra = await installBroadcastCounter(page, "files:updates");
    await new Promise((r) => setTimeout(r, 400));
    const extraCount = await collectExtra();

    // AC: @daemon-server ac-5 — no additional broadcast within 400ms of the first
    expect(extraCount).toBe(0);
  });

  // AC: @daemon-server ac-6
  test("YAML parse error does not crash daemon — broadcasts error event on files:errors", async ({
    page,
    daemon,
    request,
  }) => {
    await subscribeTopic(page, "files:updates");
    await subscribeTopic(page, "files:errors");

    const targetFile = join(daemon.kspecDir, "kynetic.yaml");
    // Write invalid YAML that will fail to parse
    const invalidYaml = [
      'kynetic: "1.0"',
      "{ invalid yaml: [unclosed bracket",
      "  bad indentation:",
    ].join("\n");

    // Set up error listener before writing the bad file
    const errorBroadcastPromise = waitForErrorBroadcast(page);

    writeFileSync(targetFile, invalidYaml);

    // Wait for the error broadcast
    const errorBroadcast = await errorBroadcastPromise;

    // AC: @daemon-server ac-6 — error event is broadcast with correct structure
    expect(errorBroadcast.topic).toBe("files:errors");
    expect(errorBroadcast.event).toBe("file_error");
    expect(errorBroadcast).toHaveProperty("msg_id");
    expect(errorBroadcast.data).toHaveProperty("error");
    expect(typeof errorBroadcast.data.error).toBe("string");
    expect(errorBroadcast.data.error.length).toBeGreaterThan(0);

    // AC: @daemon-server ac-6 — daemon did NOT crash, still responds to health check
    const healthResponse = await request.get(`${daemon.baseUrl}/api/health`);
    expect(healthResponse.status()).toBe(200);
    const health = await healthResponse.json();
    expect(health.status).toBe("ok");
  });

  // AC: @daemon-server ac-6
  test("daemon recovers after YAML parse error and processes subsequent valid file change", async ({
    page,
    daemon,
    request,
  }) => {
    await subscribeTopic(page, "files:updates");
    await subscribeTopic(page, "files:errors");

    const targetFile = join(daemon.kspecDir, "kynetic.yaml");

    // Step 1: Write invalid YAML — should broadcast error, not crash
    const errorPromise = waitForErrorBroadcast(page);
    writeFileSync(targetFile, 'kynetic: "1.0"\n{ invalid: [unclosed\n');
    await errorPromise; // Confirm error was detected and broadcast (watcher still active)

    // Step 2: Fix the file with valid YAML — watcher should resume processing normally
    const recoveryPromise = waitForBroadcast(page, "files:updates");
    writeFileSync(
      targetFile,
      [
        'kynetic: "1.0"',
        "",
        "project:",
        '  name: "Recovered Project"',
        '  version: "0.1.0"',
        "  status: draft",
        "  description: Recovered after YAML parse error",
        "",
      ].join("\n"),
    );
    const recoveryBroadcast = await recoveryPromise;

    // AC: @daemon-server ac-6 — daemon processes valid file after error (not crashed/frozen)
    expect(recoveryBroadcast.topic).toBe("files:updates");
    expect(recoveryBroadcast).toHaveProperty("msg_id");

    // Final health check
    const healthResponse = await request.get(`${daemon.baseUrl}/api/health`);
    expect(healthResponse.status()).toBe(200);
  });

  test("broadcasts sessions updates when a session file changes", async ({ page, daemon }) => {
    await subscribeTopic(page, "sessions");

    const broadcastPromise = waitForBroadcast(page, "sessions");

    const sessionDir = join(daemon.tempDir, ".kspec-sessions", "01JTESTWATCHERSESSION00000001");
    const metadataPath = join(sessionDir, "session.yaml");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      metadataPath,
      [
        "id: 01JTESTWATCHERSESSION00000001",
        "agent_type: task-worker",
        "status: active",
        'started_at: "2026-03-19T12:00:00.000Z"',
        "trigger: manual",
        "",
      ].join("\n"),
    );

    const broadcast = await broadcastPromise;

    expect(broadcast.topic).toBe("sessions");
    expect(broadcast.event).toBe("session_changed");
    expect(broadcast).toHaveProperty("msg_id");
  });
});
