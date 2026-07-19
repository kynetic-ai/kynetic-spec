import { test, expect } from "./fixtures/test-base";

const taskId = "01KXH2PVX606KVK5C4ERCB8WTY";
const otherTaskId = "01KXH2PX40XP0VVDT0KWKRR7TT";
const timestamp = "2026-07-16T12:00:00.000Z";

type LifecycleStatus = ReturnType<typeof lifecycleStatus>;

function cleanupEntry(
  cleanupId: string,
  scope: "global" | "task",
  status: "pending" | "failed",
  options: { task_id?: string; error_code?: string } = {},
) {
  return {
    cleanup_id: cleanupId,
    scope,
    ...(options.task_id ? { task_id: options.task_id } : {}),
    status,
    phase: status === "failed" ? "signals_sent" : "owned",
    ...(options.error_code ? { error_code: options.error_code } : {}),
  };
}

function heldTask(mode: "paused" | "stopped" = "paused", scope: "global" | "task" = "global") {
  return {
    task_id: taskId,
    task_ref: "@task-ui-dispatch-lifecycle-controls",
    title: "Migrate every lifecycle UI consumer and control",
    scope,
    mode,
    reason: "operator request",
    actor: "browser-e2e",
    source: "ui",
    controlled_at: timestamp,
    updated_at: timestamp,
  };
}

function taskControl(
  mode: "paused" | "stopped",
  cleanup_state: LifecycleStatus["cleanup_state"] = { status: "idle", entries: [] },
) {
  return {
    task_id: taskId,
    task_ref: "@task-ui-dispatch-lifecycle-controls",
    title: "Migrate every lifecycle UI consumer and control",
    mode,
    reason: "operator request",
    actor: "browser-e2e",
    source: "ui",
    controlled_at: timestamp,
    updated_at: timestamp,
    cleanup_state,
  };
}

function lifecycleStatus(overrides: Record<string, unknown> = {}) {
  return {
    dispatch_enabled: false,
    active_invocations: [],
    queued_invocations: [],
    agent_definitions: [],
    degraded: { active: false, reason: "", enteredAt: null },
    global_authority: "stopped",
    projection: "stopped",
    cleanup_state: { status: "idle" as const, entries: [] },
    active_count: 0,
    queue_depth: 0,
    held_count: 0,
    held_tasks: [],
    task_controls: [],
    degraded_targets: [],
    ...overrides,
  };
}

function mutationData(status: LifecycleStatus) {
  return {
    global_authority: status.global_authority,
    projection: status.projection,
    cleanup_state: status.cleanup_state,
    active_count: status.active_count,
    queue_depth: status.queue_depth,
    held_count: status.held_count,
    held_tasks: status.held_tasks,
    task_controls: status.task_controls,
    degraded_targets: status.degraded_targets,
  };
}

async function routeLifecycleStatus(
  page: import("@playwright/test").Page,
  getStatus: () => LifecycleStatus,
) {
  await page.route("**/api/agent/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(getStatus()),
    });
  });
}

async function routeLifecycleControl(
  page: import("@playwright/test").Page,
  respond: (
    body: Record<string, unknown>,
    requestIndex: number,
  ) => { status: number; body: Record<string, unknown> },
) {
  let requestCount = 0;
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/agent/dispatch/control", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    const response = respond(body, requestCount++);
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });
  return {
    bodies,
    get requestCount() {
      return requestCount;
    },
  };
}

function staticSnapshot() {
  return {
    version: "0.14.0",
    exported_at: timestamp,
    project: { name: "Lifecycle Browser Fixture", version: "0.14.0" },
    tasks: [],
    items: [],
    inbox: [],
    session: null,
    observations: [],
    agents: [],
    workflows: [],
    conventions: [],
  };
}

async function routeStaticSnapshot(page: import("@playwright/test").Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({ status: 503, body: "Service Unavailable" }),
  );
  await page.route("**/kspec-snapshot.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(staticSnapshot()),
    }),
  );
}

function recordBrowserErrors(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  return errors;
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
}

test.describe("dispatch lifecycle browser regression", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // AC: @ui-agent-dispatch ac-2
  // AC: @ui-agent-dispatch ac-3
  // AC: @ui-agent-dispatch ac-status-projection
  // AC: @ui-agent-dispatch ac-status-active-work-visible
  // AC: @ui-agent-dispatch ac-status-queued-work-visible
  // AC: @ui-agent-dispatch ac-status-held-work-visible
  // AC: @ui-agent-dispatch ac-stopped-actions-valid
  // AC: @ui-agent-dispatch ac-control-separated-from-degraded
  // AC: @ui-agent-dispatch ac-control-separated-from-blocked
  test("renders the complete desktop authority, cleanup, count, and action matrix", async ({
    page,
    daemon: _daemon,
  }) => {
    const browserErrors = recordBrowserErrors(page);
    let status = lifecycleStatus();
    await routeLifecycleStatus(page, () => status);

    const scenarios: Array<{
      name: string;
      status: LifecycleStatus;
      authority: string;
      projection: string;
      globalActions: string[];
      taskActions?: string[];
      taskRow?: "held" | "control";
    }> = [
      {
        name: "running/running",
        status: lifecycleStatus({
          dispatch_enabled: true,
          global_authority: "running",
          projection: "running",
        }),
        authority: "running",
        projection: "running",
        globalActions: ["Pause", "Hard stop"],
      },
      {
        name: "paused/paused",
        status: lifecycleStatus({ global_authority: "paused", projection: "paused" }),
        authority: "paused",
        projection: "paused",
        globalActions: ["Resume", "Hard stop"],
      },
      {
        name: "paused/draining with live work",
        status: lifecycleStatus({
          global_authority: "paused",
          projection: "draining",
          active_invocations: [
            {
              session_id: "session-lifecycle-browser",
              agent_id: "task-worker",
              task_ref: "@task-ui-dispatch-lifecycle-controls",
              task_title: "Migrate every lifecycle UI consumer and control",
              elapsed_ms: 1200,
              resolved_adapter: "codex-acp",
            },
          ],
          queued_invocations: [
            {
              agent_id: "pr-reviewer",
              task_ref: "@task-ui-dispatch-lifecycle-controls",
              task_title: "Migrate every lifecycle UI consumer and control",
              wait_ms: 500,
              resolved_adapter: "codex-acp",
            },
          ],
          active_count: 1,
          queue_depth: 1,
          held_count: 1,
          held_tasks: [heldTask()],
          degraded: {
            active: true,
            reason: "branch diverged",
            enteredAt: timestamp,
          },
          degraded_targets: [
            {
              branch: "dev",
              reason: "branch diverged",
              enteredAt: timestamp,
              kind: "sync",
            },
          ],
        }),
        authority: "paused",
        projection: "draining",
        globalActions: ["Resume", "Hard stop"],
        taskActions: ["Pause task", "Hard-stop task"],
        taskRow: "held",
      },
      {
        name: "legacy false with active work",
        status: lifecycleStatus({
          dispatch_enabled: false,
          global_authority: "running",
          projection: "running",
          active_invocations: [
            {
              session_id: "session-legacy-active",
              agent_id: "task-worker",
              task_ref: "@task-ui-dispatch-lifecycle-controls",
              task_title: "Migrate every lifecycle UI consumer and control",
              elapsed_ms: 900,
              resolved_adapter: "codex-acp",
            },
          ],
          active_count: 1,
        }),
        authority: "running",
        projection: "running",
        globalActions: ["Pause", "Hard stop"],
      },
      {
        name: "stopped/idle",
        status: lifecycleStatus(),
        authority: "stopped",
        projection: "stopped",
        globalActions: ["Start"],
      },
      {
        name: "stopped/global-pending",
        status: lifecycleStatus({
          cleanup_state: {
            status: "pending",
            entries: [cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AB", "global", "pending")],
          },
        }),
        authority: "stopped",
        projection: "stopped",
        globalActions: ["Retry hard stop"],
      },
      {
        name: "stopped/mixed-failed-plus-pending",
        status: lifecycleStatus({
          cleanup_state: {
            status: "failed",
            entries: [
              cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AC", "global", "failed", {
                error_code: "cancellation_timeout",
              }),
              cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AD", "task", "pending", {
                task_id: otherTaskId,
              }),
            ],
          },
        }),
        authority: "stopped",
        projection: "stopped",
        globalActions: ["Retry hard stop"],
      },
      {
        name: "stopped/unrelated-task-cleanup",
        status: lifecycleStatus({
          cleanup_state: {
            status: "failed",
            entries: [
              cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AE", "task", "failed", {
                task_id: taskId,
                error_code: "session_closure_failed",
              }),
            ],
          },
          held_count: 1,
          held_tasks: [heldTask("stopped", "task")],
          task_controls: [
            taskControl("stopped", {
              status: "failed",
              entries: [
                cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AE", "task", "failed", {
                  task_id: taskId,
                  error_code: "session_closure_failed",
                }),
              ],
            }),
          ],
        }),
        authority: "stopped",
        projection: "stopped",
        globalActions: ["Start"],
        taskActions: ["Retry hard stop"],
        taskRow: "held",
      },
      {
        name: "task-stopped-idle",
        status: lifecycleStatus({
          dispatch_enabled: true,
          global_authority: "running",
          projection: "running",
          task_controls: [taskControl("stopped")],
        }),
        authority: "running",
        projection: "running",
        globalActions: ["Pause", "Hard stop"],
        taskActions: ["Resume task"],
        taskRow: "control",
      },
      {
        name: "task-stopped-failed",
        status: lifecycleStatus({
          dispatch_enabled: true,
          global_authority: "running",
          projection: "running",
          cleanup_state: {
            status: "failed",
            entries: [
              cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AJ", "task", "failed", {
                task_id: taskId,
                error_code: "cancellation_failed",
              }),
            ],
          },
          task_controls: [
            taskControl("stopped", {
              status: "failed",
              entries: [
                cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AJ", "task", "failed", {
                  task_id: taskId,
                  error_code: "cancellation_failed",
                }),
              ],
            }),
          ],
        }),
        authority: "running",
        projection: "running",
        globalActions: ["Pause", "Hard stop"],
        taskActions: ["Retry hard stop"],
        taskRow: "control",
      },
    ];

    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
    for (const scenario of scenarios) {
      await test.step(scenario.name, async () => {
        status = scenario.status;
        await page.goto("/agents");
        await expect(page.getByTestId("agents-loading")).toHaveCount(0);
        await expect(page.getByTestId("dispatch-authority")).toHaveText(scenario.authority);
        await expect(page.getByTestId("dispatch-projection")).toHaveText(scenario.projection);
        const controls = page.getByTestId("dispatch-section");
        await expect(controls.locator("button[data-lifecycle-control]")).toHaveText(
          scenario.globalActions,
        );
        await expect(page.getByTestId("dispatch-active-count")).toHaveText(
          String(scenario.status.active_count),
        );
        await expect(page.getByTestId("dispatch-queued-count")).toHaveText(
          String(scenario.status.queue_depth),
        );
        await expect(page.getByTestId("dispatch-held-count")).toHaveText(
          String(scenario.status.held_count),
        );

        const taskRow = scenario.taskRow
          ? page.getByTestId(
              `${scenario.taskRow === "held" ? "held-task" : "task-control"}-${taskId}`,
            )
          : null;
        if (taskRow) {
          await expect(taskRow).toBeVisible();
          await expect(taskRow.locator("button[data-lifecycle-control]")).toHaveText(
            scenario.taskActions ?? [],
          );
        } else {
          await expect(page.getByTestId(`held-task-${taskId}`)).toHaveCount(0);
          await expect(page.getByTestId(`task-control-${taskId}`)).toHaveCount(0);
        }

        if (scenario.name.includes("draining")) {
          await expect(page.getByTestId("active-invocation-row")).toContainText("task-worker");
          await expect(page.getByTestId("queued-invocation-row")).toContainText("pr-reviewer");
          await expect(page.getByTestId(`held-task-${taskId}`)).toContainText(
            "Migrate every lifecycle UI consumer and control",
          );
          await expect(page.getByTestId("dispatch-degraded-state")).toContainText("Degraded state");
          await expect(page.getByTestId("dispatch-degraded-state")).toContainText(
            "branch diverged",
          );
          await expect(page.getByTestId("held-tasks-section")).toContainText("Held Tasks");
          await expect(page.getByTestId(`held-task-${taskId}`)).toContainText(
            "Held by global authority: operator request",
          );
        }
        if (scenario.name === "legacy false with active work") {
          await expect(page.getByTestId("active-invocation-row")).toContainText("task-worker");
        }
        if (scenario.status.cleanup_state.entries.length > 0) {
          const evidence = page.getByTestId("dispatch-cleanup-evidence");
          for (const entry of scenario.status.cleanup_state.entries) {
            await expect(evidence).toContainText(
              `${entry.scope}${"task_id" in entry ? `/${entry.task_id}` : ""}: ${entry.status}/${entry.phase}${"error_code" in entry ? ` (${entry.error_code})` : ""}`,
            );
          }
        }
      });
    }

    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  });

  // AC: @ui-agent-dispatch ac-hard-stop-confirmation-cancellation
  // AC: @ui-agent-dispatch ac-hard-stop-confirmation-evidence
  // AC: @ui-agent-dispatch ac-hard-stop-confirmation-cancelled
  // AC: @ui-agent-dispatch ac-lifecycle-controls-labelled
  // AC: @ui-agent-dispatch ac-lifecycle-focus-retained
  // AC: @ui-agent-dispatch ac-lifecycle-live-update
  test("supports keyboard control with confirmation, cancellation, focus, and live updates", async ({
    page,
    daemon: _daemon,
  }) => {
    const browserErrors = recordBrowserErrors(page);
    let status = lifecycleStatus({
      dispatch_enabled: true,
      global_authority: "running",
      projection: "running",
    });
    await routeLifecycleStatus(page, () => status);
    const controls = await routeLifecycleControl(page, (body) => {
      status = lifecycleStatus({
        dispatch_enabled: body.action !== "pause",
        global_authority: body.action === "pause" ? "paused" : "running",
        projection: body.action === "pause" ? "paused" : "running",
      });
      return {
        status: 200,
        body: { ok: true, data: { ...mutationData(status), outcome: "applied" }, error: null },
      };
    });

    await page.goto("/agents");
    const stopButton = page.getByRole("button", { name: "Hard stop", exact: true });
    await stopButton.focus();
    await stopButton.press("Space");
    const dialog = page.getByRole("dialog", { name: "Confirm hard stop" });
    await expect(dialog).toContainText("Active matching invocations will be cancelled.");
    await expect(dialog).toContainText("audit evidence will be preserved");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(stopButton).toBeFocused();
    expect(controls.requestCount).toBe(0);

    const pauseButton = page.getByRole("button", { name: "Pause", exact: true });
    await pauseButton.focus();
    await pauseButton.press("Enter");
    const resumeButton = page.getByRole("button", { name: "Resume", exact: true });
    await expect(resumeButton).toBeFocused();
    const liveStatus = page.getByTestId("dispatch-live-status");
    await expect(liveStatus).toHaveAttribute("aria-live", "polite");
    await expect(liveStatus).toContainText("Dispatch status changed: Paused");
    expect(controls.bodies).toEqual([{ scope: "global", action: "pause" }]);
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  });

  // AC: @ui-agent-dispatch ac-status-held-work-visible
  // AC: @ui-agent-dispatch ac-lifecycle-controls-labelled
  // AC: @ui-agent-dispatch ac-lifecycle-focus-retained
  // AC: @ui-agent-dispatch ac-lifecycle-live-update
  test("confirms task hard stop using submitted refs and canonical response identity", async ({
    page,
    daemon: _daemon,
  }) => {
    const browserErrors = recordBrowserErrors(page);
    let status = lifecycleStatus({
      dispatch_enabled: true,
      global_authority: "running",
      projection: "running",
      held_count: 1,
      held_tasks: [heldTask("paused", "task")],
      task_controls: [taskControl("paused")],
    });
    await routeLifecycleStatus(page, () => status);
    const controls = await routeLifecycleControl(page, (_body) => {
      status = lifecycleStatus({
        dispatch_enabled: true,
        global_authority: "running",
        projection: "running",
        task_controls: [taskControl("stopped")],
      });
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            ...mutationData(status),
            outcome: "applied",
            task_id: taskId,
            task_ref: "@task-ui-dispatch-lifecycle-controls",
          },
          error: null,
        },
      };
    });

    await page.goto("/agents");
    const row = page.getByTestId(`held-task-${taskId}`);
    await expect(row).toContainText("Migrate every lifecycle UI consumer and control");
    await expect(row.getByRole("button", { name: "Resume task" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Hard-stop task" })).toBeVisible();
    await row.getByRole("button", { name: "Hard-stop task" }).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Confirm hard stop" });
    await expect(dialog).toContainText("Active matching invocations will be cancelled.");
    await dialog.getByRole("button", { name: "Confirm" }).click();

    expect(controls.bodies).toEqual([
      {
        scope: "task",
        action: "stop",
        task_ref: "@task-ui-dispatch-lifecycle-controls",
      },
    ]);
    await expect(row).toHaveCount(0);
    const canonicalResult = page.getByTestId(`task-control-${taskId}`);
    await expect(canonicalResult).toContainText("Migrate every lifecycle UI consumer and control");
    await expect(canonicalResult.getByRole("link")).toHaveAttribute(
      "href",
      `/tasks/board?ref=%40task-ui-dispatch-lifecycle-controls`,
    );
    await expect(canonicalResult.getByRole("button", { name: "Resume task" })).toBeVisible();
    await expect(page.getByTestId("task-lifecycle-live-status")).toContainText(
      "Task lifecycle changed: Migrate every lifecycle UI consumer and control",
    );
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeFocused();
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  });

  // AC: @ui-agent-dispatch ac-status-held-work-visible
  // AC: @ui-agent-dispatch ac-stopped-actions-valid
  test("permits task metadata control during global cleanup without starting work", async ({
    page,
    daemon: _daemon,
  }) => {
    const browserErrors = recordBrowserErrors(page);
    const globalEntry = cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AK", "global", "pending");
    let status = lifecycleStatus({
      cleanup_state: { status: "pending", entries: [globalEntry] },
      held_count: 1,
      held_tasks: [heldTask("stopped", "global")],
    });
    await routeLifecycleStatus(page, () => status);
    const controls = await routeLifecycleControl(page, (_body) => {
      status = lifecycleStatus({
        cleanup_state: { status: "pending", entries: [globalEntry] },
        held_count: 1,
        held_tasks: [heldTask("stopped", "global")],
        task_controls: [taskControl("paused")],
      });
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            ...mutationData(status),
            outcome: "applied",
            task_id: taskId,
            task_ref: "@task-ui-dispatch-lifecycle-controls",
          },
          error: null,
        },
      };
    });

    await page.goto("/agents");
    const row = page.getByTestId(`held-task-${taskId}`);
    await row.getByRole("button", { name: "Pause task", exact: true }).press("Space");
    expect(controls.bodies).toEqual([
      {
        scope: "task",
        action: "pause",
        task_ref: "@task-ui-dispatch-lifecycle-controls",
      },
    ]);
    await expect(page.getByTestId("dispatch-authority")).toHaveText("stopped");
    await expect(page.getByTestId("dispatch-cleanup-evidence")).toContainText(
      "global: pending/owned",
    );
    await expect(page.getByTestId("dispatch-active-count")).toHaveText("0");
    await expect(page.getByTestId("active-invocations-section")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry hard stop", exact: true })).toBeVisible();
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  });

  // AC: @ui-agent-dispatch ac-stopped-actions-valid
  // AC: @ui-agent-dispatch ac-lifecycle-focus-retained
  test("retains cleanup evidence on retry failure and remains stopped after retry success", async ({
    page,
    daemon: _daemon,
  }) => {
    const browserErrors = recordBrowserErrors(page);
    const failedEntry = cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AF", "global", "failed", {
      error_code: "cancellation_timeout",
    });
    let status = lifecycleStatus({
      cleanup_state: { status: "failed", entries: [failedEntry] },
    });
    await routeLifecycleStatus(page, () => status);
    const controls = await routeLifecycleControl(page, (_body, requestIndex) => {
      if (requestIndex === 0) {
        return {
          status: 409,
          body: {
            ok: false,
            data: mutationData(status),
            error: { code: "cancellation_timeout", message: "private daemon detail" },
          },
        };
      }
      status = lifecycleStatus();
      return {
        status: 200,
        body: { ok: true, data: { ...mutationData(status), outcome: "applied" }, error: null },
      };
    });

    await page.goto("/agents");
    const retry = page.getByRole("button", { name: "Retry hard stop", exact: true });
    await retry.click();
    await page
      .getByRole("dialog", { name: "Confirm hard stop" })
      .getByRole("button", { name: "Confirm" })
      .click();
    await expect(page.getByTestId("error-message")).toHaveText(
      "Dispatch cancellation timed out. Retry hard stop after inspecting the controlled process.",
    );
    await expect(page.getByTestId("error-message")).not.toContainText("private daemon detail");
    await expect(page.getByTestId("dispatch-cleanup-evidence")).toContainText(
      "cancellation_timeout",
    );
    await expect(retry).toBeFocused();

    await retry.click();
    await page
      .getByRole("dialog", { name: "Confirm hard stop" })
      .getByRole("button", { name: "Confirm" })
      .click();
    await expect(page.getByTestId("dispatch-status-badge")).toHaveText("Stopped");
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
    expect(controls.bodies).toEqual([
      { scope: "global", action: "stop" },
      { scope: "global", action: "stop" },
    ]);
    expect(browserErrors, browserErrors.join("\n")).toEqual([
      "console: Failed to load resource: the server responded with a status of 409 (Conflict)",
    ]);
  });

  // AC: @ui-agent-dispatch ac-stopped-actions-valid
  // AC: @ui-agent-dispatch ac-lifecycle-focus-retained
  test("maps a stale prohibited action and refreshes to the server lifecycle status", async ({
    page,
    daemon: _daemon,
  }) => {
    const browserErrors = recordBrowserErrors(page);
    let status = lifecycleStatus();
    const pending = lifecycleStatus({
      cleanup_state: {
        status: "pending",
        entries: [cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AG", "global", "pending")],
      },
    });
    await routeLifecycleStatus(page, () => status);
    await routeLifecycleControl(page, () => {
      status = pending;
      return {
        status: 409,
        body: {
          ok: false,
          data: mutationData(pending),
          error: { code: "invalid_transition", message: "private stale-state detail" },
        },
      };
    });

    await page.goto("/agents");
    const start = page.getByRole("button", { name: "Start", exact: true });
    await start.click();
    await expect(page.getByTestId("error-message")).toHaveText(
      "Invalid dispatch lifecycle transition. Refresh lifecycle status and choose an allowed action.",
    );
    await expect(page.getByTestId("error-message")).not.toContainText("private stale-state detail");
    await expect(page.getByRole("button", { name: "Retry hard stop", exact: true })).toBeVisible();
    await expect(page.getByTestId("dispatch-cleanup-evidence")).toContainText("pending/owned");
    expect(browserErrors, browserErrors.join("\n")).toEqual([
      "console: Failed to load resource: the server responded with a status of 409 (Conflict)",
    ]);
  });

  // AC: @ui-agent-dispatch ac-status-active-work-visible
  // AC: @ui-agent-dispatch ac-status-queued-work-visible
  // AC: @ui-agent-dispatch ac-status-held-work-visible
  test("keeps lifecycle evidence visible in dashboard, board, triggers, and event log", async ({
    page,
    daemon: _daemon,
  }) => {
    const browserErrors = recordBrowserErrors(page);
    const status = lifecycleStatus({
      global_authority: "paused",
      projection: "draining",
      active_invocations: [
        {
          session_id: "session-lifecycle-browser",
          agent_id: "task-worker",
          task_ref: "@task-ui-dispatch-lifecycle-controls",
          task_title: "Migrate every lifecycle UI consumer and control",
          elapsed_ms: 1200,
          resolved_adapter: "codex-acp",
        },
      ],
      queued_invocations: [
        {
          agent_id: "pr-reviewer",
          task_ref: "@task-ui-dispatch-lifecycle-controls",
          task_title: "Migrate every lifecycle UI consumer and control",
          wait_ms: 500,
          resolved_adapter: "codex-acp",
        },
      ],
      active_count: 1,
      queue_depth: 1,
      held_count: 1,
      held_tasks: [heldTask()],
    });
    await routeLifecycleStatus(page, () => status);

    await page.goto("/");
    await expect(page.getByTestId("dispatch-lifecycle-evidence")).toContainText("1 active");
    await expect(page.getByTestId("active-fleet-row")).toContainText("task-worker");

    await page.goto("/tasks/board");
    await expect(page.getByTestId("dispatch-lifecycle-evidence")).toContainText("1 queued");
    await expect(page.getByTestId("active-fleet-row")).toContainText(
      "Migrate every lifecycle UI consumer and control",
    );

    await page.goto("/automation");
    await expect(page.getByTestId("dispatch-lifecycle-evidence")).toContainText("1 held");
    await expect(page.getByTestId("dispatch-triggers-section")).toBeVisible();
    await expect(page.getByTestId("event-log-section")).toBeVisible();
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  });

  for (const route of ["/agents", "/tasks/board", "/automation"] as const) {
    // AC: @ui-agent-dispatch ac-lifecycle-controls-labelled
    test(`keeps lifecycle rows and controls usable without narrow overflow on ${route}`, async ({
      page,
      daemon: _daemon,
    }) => {
      const browserErrors = recordBrowserErrors(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const status = lifecycleStatus({
        global_authority: "paused",
        projection: "draining",
        held_count: 1,
        held_tasks: [heldTask()],
      });
      await routeLifecycleStatus(page, () => status);
      await page.goto(route);
      await expect(
        page.getByTestId("dispatch-lifecycle-evidence").or(page.getByTestId("dispatch-status")),
      ).toBeVisible();
      if (route === "/agents") {
        await expect(page.getByTestId(`held-task-${taskId}`)).toBeVisible();
        await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      }
      if (route === "/tasks/board") {
        await expect(page.getByTestId("board-columns")).toBeVisible();
      }
      if (route === "/automation") {
        await expect(page.getByTestId("dispatch-triggers-section")).toBeVisible();
        await expect(page.getByTestId("event-log-section")).toBeVisible();
      }
      await expectNoHorizontalOverflow(page);
      expect(browserErrors, browserErrors.join("\n")).toEqual([]);
    });
  }

  test("rejects mixed casing and malformed cleanup conditionals before rendering rows", async ({
    page,
    daemon: _daemon,
  }) => {
    const browserErrors = recordBrowserErrors(page);
    let response = {
      ...lifecycleStatus(),
      globalAuthority: "stopped",
    };
    await page.route("**/api/agent/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(response),
      }),
    );

    await page.goto("/agents");
    await expect(page.getByTestId("error-message")).toContainText(
      "Dispatch lifecycle operation failed",
    );
    await expect(page.getByTestId("dispatch-status")).toHaveCount(0);

    response = {
      ...lifecycleStatus(),
      cleanup_state: {
        status: "pending",
        entries: [
          cleanupEntry("01KXH2Q0BP8A27D1E5X7Q3W2AH", "global", "pending", {
            error_code: "internal_error",
          }),
        ],
      },
    } as typeof response;
    await page.reload();
    await expect(page.getByTestId("error-message")).toContainText(
      "Dispatch lifecycle operation failed",
    );
    await expect(page.getByTestId("dispatch-cleanup-evidence")).toHaveCount(0);
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  });

  // AC: @ui-agent-dispatch ac-3
  // AC: @ui-agent-dispatch ac-lifecycle-controls-labelled
  test("renders stopped static fallback as read-only and never posts control requests", async ({
    page,
  }) => {
    const browserErrors = recordBrowserErrors(page);
    let controlRequests = 0;
    await routeStaticSnapshot(page);
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/agent/dispatch/control"
      ) {
        controlRequests += 1;
      }
    });

    await page.goto("/agents");
    await expect(page.getByText(/read-only/i).first()).toBeVisible();
    await expect(page.getByTestId("dispatch-authority")).toHaveText("stopped");
    const start = page.getByRole("button", { name: "Start", exact: true });
    await expect(start).toBeDisabled();
    await start.press("Enter");
    expect(controlRequests).toBe(0);
    expect(browserErrors, browserErrors.join("\n")).toEqual([
      "console: Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    ]);
  });
});
