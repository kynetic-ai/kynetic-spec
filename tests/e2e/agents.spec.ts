/**
 * E2E Tests for Agent and Dispatch View
 *
 * Tests verify the /agents page renders agent definitions, dispatch status,
 * and active invocations correctly. Agent definition editing (name, description,
 * adapter, capabilities, etc.) is tested here.
 *
 * Dispatch trigger editing tests have moved to automation.spec.ts — trigger
 * editing now lives in the automation view per @ui-automation-view ac-5.
 *
 * Covered ACs:
 * - @ui-agent-dispatch ac-1: Agent definitions show name, triggers, active/completed counts
 * - @ui-agent-dispatch ac-2: Dispatch running with stop button and active invocations
 * - @ui-agent-dispatch ac-3: Dispatch stopped with no active invocations
 */

import { test, expect } from "./fixtures/test-base";

test.describe("Agent and Dispatch View", () => {
  test.describe("Dispatch Stopped State (AC-3)", () => {
    // AC: @ui-agent-dispatch ac-3
    test("shows dispatch status as stopped initially", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");

      const dispatchStatus = page.getByTestId("dispatch-status");
      await expect(dispatchStatus).toBeVisible();

      const badge = page.getByTestId("dispatch-status-badge");
      await expect(badge).toContainText("Stopped");
    });

    // AC: @ui-agent-dispatch ac-3
    test("shows stopped indicator when dispatch is not running", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.goto("/agents");

      const indicator = page.getByTestId("dispatch-indicator-stopped");
      await expect(indicator).toBeVisible();
    });

    // AC: @ui-agent-dispatch ac-3
    test("shows no active invocations when dispatch is stopped", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.goto("/agents");

      const invocationsSection = page.getByTestId("active-invocations-section");
      await expect(invocationsSection).toHaveCount(0);
    });
  });

  test.describe("Agent Definitions (AC-1)", () => {
    // AC: @ui-agent-dispatch ac-1
    test("renders agent cards from meta definitions", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");

      // Wait for loading to finish
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const section = page.getByTestId("agent-definitions-section");
      await expect(section).toBeVisible();

      // Fixture has 2 agents: task-worker and pr-reviewer
      const taskWorkerCard = page.getByTestId("agent-card-task-worker");
      await expect(taskWorkerCard).toBeVisible();

      const prReviewerCard = page.getByTestId("agent-card-pr-reviewer");
      await expect(prReviewerCard).toBeVisible();
    });

    // AC: @ui-agent-dispatch ac-1
    test("agent card shows name", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-task-worker");
      const name = card.getByTestId("agent-name");
      await expect(name).toContainText("Task Worker");
    });

    // AC: @ui-agent-dispatch ac-1
    test("agent card shows triggers", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-task-worker");
      const triggers = card.getByTestId("agent-trigger");
      // task-worker has 3 triggers: ready, in_progress, needs_work
      await expect(triggers).toHaveCount(3);
    });

    // AC: @ui-agent-dispatch ac-1
    test("agent card shows active invocation count", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-task-worker");
      const activeCount = card.getByTestId("agent-active-count");
      await expect(activeCount).toBeVisible();
      await expect(activeCount).toContainText("0");
    });

    // AC: @ui-agent-dispatch ac-1
    test("agent card shows completed count", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-task-worker");
      const completedCount = card.getByTestId("agent-completed-count");
      await expect(completedCount).toBeVisible();
      await expect(completedCount).toContainText("0");
    });

    // AC: @ui-agent-dispatch ac-1
    test("pr-reviewer agent shows pending_review trigger", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-pr-reviewer");
      const triggers = card.getByTestId("agent-trigger");
      await expect(triggers).toHaveCount(1);
      await expect(triggers.first()).toContainText("pending_review");
    });

    // AC: @ui-agent-dispatch ac-1 — Read-only filter badges on agent cards
    test("agent card shows filter badges for automation, tags, and priority", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-task-worker");

      // Fixture has task.ready with filter: { automation: eligible, tags: [mvp], priority: 3 }
      await expect(card.getByTestId("filter-badge-automation").first()).toContainText("eligible");
      await expect(card.getByTestId("filter-badge-tag").first()).toContainText("mvp");
      await expect(card.getByTestId("filter-badge-priority").first()).toContainText("p≤3");
    });

    test('agent card shows "Configure in Automation" link', async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-task-worker");
      const link = card.getByTestId("configure-triggers-link");
      await expect(link).toBeVisible();
      await expect(link).toContainText("Configure in Automation");
      await expect(link).toHaveAttribute("href", "/automation");
    });
  });

  test.describe("Dispatch Running State (AC-2)", () => {
    // AC: @ui-agent-dispatch ac-2
    test("shows dispatch as running after start", async ({ page, daemon, request }) => {
      // Start dispatch via API
      await request.post(`${daemon.baseUrl}/api/agent/dispatch`, {
        data: { action: "start" },
        headers: { "Content-Type": "application/json" },
      });

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const badge = page.getByTestId("dispatch-status-badge");
      await expect(badge).toContainText("Running");

      const indicator = page.getByTestId("dispatch-indicator-running");
      await expect(indicator).toBeVisible();

      // Clean up
      await request.post(`${daemon.baseUrl}/api/agent/dispatch`, {
        data: { action: "stop" },
        headers: { "Content-Type": "application/json" },
      });
    });

    // AC: @ui-agent-dispatch ac-2
    test("shows stop button when dispatch is running", async ({ page, daemon, request }) => {
      await request.post(`${daemon.baseUrl}/api/agent/dispatch`, {
        data: { action: "start" },
        headers: { "Content-Type": "application/json" },
      });

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const toggleButton = page.getByTestId("dispatch-toggle-button");
      await expect(toggleButton).toBeVisible();
      await expect(toggleButton).toContainText("Stop");

      // Clean up
      await request.post(`${daemon.baseUrl}/api/agent/dispatch`, {
        data: { action: "stop" },
        headers: { "Content-Type": "application/json" },
      });
    });

    // AC: @ui-agent-dispatch ac-2
    test("clicking stop button stops dispatch", async ({ page, daemon, request }) => {
      await request.post(`${daemon.baseUrl}/api/agent/dispatch`, {
        data: { action: "start" },
        headers: { "Content-Type": "application/json" },
      });

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      // Click stop
      const toggleButton = page.getByTestId("dispatch-toggle-button");
      await expect(toggleButton).toBeVisible();
      await toggleButton.click();

      // Wait for status to update
      const badge = page.getByTestId("dispatch-status-badge");
      await expect(badge).toContainText("Stopped");
    });

    // AC: @ui-agent-dispatch ac-2
    test("clicking start button starts dispatch", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const toggleButton = page.getByTestId("dispatch-toggle-button");
      await expect(toggleButton).toContainText("Start");

      await toggleButton.click();

      // Wait for status to update
      const badge = page.getByTestId("dispatch-status-badge");
      await expect(badge).toContainText("Running");

      // Clean up - stop dispatch
      await toggleButton.click();
      await expect(badge).toContainText("Stopped");
    });
  });

  test.describe("Loading and Error States", () => {
    test("shows loading skeleton initially", async ({ page, daemon: _daemon }) => {
      // Delay API responses so the skeleton is reliably visible
      await page.route("**/api/agent/status", async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        await route.continue();
      });
      await page.route("**/api/meta/agents", async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        await route.continue();
      });

      await page.goto("/agents");

      // Skeleton should be visible while API calls are delayed
      const skeleton = page.getByTestId("agents-loading");
      await expect(skeleton).toBeVisible();

      // Eventually loading finishes and content appears
      await expect(page.getByTestId("dispatch-section")).toBeVisible({ timeout: 5000 });
    });

    test("error message displays on API failure", async ({ page, daemon: _daemon }) => {
      // Intercept API calls and return errors
      await page.route("**/api/agent/status", (route) => {
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal_error", message: "Daemon unavailable" }),
        });
      });
      await page.route("**/api/meta/agents", (route) => {
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal_error", message: "Daemon unavailable" }),
        });
      });

      await page.goto("/agents");

      // Error message should be displayed with API error message
      const errorMessage = page.getByTestId("error-message");
      await expect(errorMessage).toBeVisible();
      await expect(errorMessage).toContainText("Daemon unavailable");
    });
  });

  test.describe("Empty State", () => {
    test("shows agent definitions section", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const section = page.getByTestId("agent-definitions-section");
      await expect(section).toBeVisible();
    });

    // AC: @ui-agent-dispatch ac-2 — Empty state for active invocations when dispatch is running
    test("shows actionable empty state when dispatch is running with no active invocations", async ({
      page,
      daemon,
      request,
    }) => {
      // Start dispatch so it's enabled
      await request.post(`${daemon.baseUrl}/api/agent/dispatch`, {
        data: { action: "start" },
        headers: { "Content-Type": "application/json" },
      });

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      // Active invocations section should be visible (dispatch is running)
      const invocationsSection = page.getByTestId("active-invocations-section");
      await expect(invocationsSection).toBeVisible();

      // Empty state should be shown with actionable guidance
      const emptyState = page.getByTestId("active-invocations-empty");
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toContainText("No active invocations");
      await expect(emptyState).toContainText("kspec tasks ready --eligible");

      // Clean up
      await request.post(`${daemon.baseUrl}/api/agent/dispatch`, {
        data: { action: "stop" },
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  test.describe("Accessibility", () => {
    test("has aria-live region for invocation announcements", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      // The live region should exist for screen reader announcements
      const liveRegion = page.getByTestId("invocation-live-region");
      await expect(liveRegion).toBeAttached();
      await expect(liveRegion).toHaveAttribute("aria-live", "assertive");
    });

    test("active invocations section has aria-live attribute", async ({
      page,
      daemon,
      request,
    }) => {
      // Start dispatch to make the section appear
      await request.post(`${daemon.baseUrl}/api/agent/dispatch`, {
        data: { action: "start" },
        headers: { "Content-Type": "application/json" },
      });

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      // Wait for the conditionally-rendered invocations section to appear
      const invocationsSection = page.getByTestId("active-invocations-section");
      await expect(invocationsSection).toBeVisible();
      await expect(invocationsSection).toHaveAttribute("aria-live", "polite");

      // Clean up
      await request.post(`${daemon.baseUrl}/api/agent/dispatch`, {
        data: { action: "stop" },
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  test.describe("Navigation", () => {
    test("agents page is accessible from sidebar", async ({ page, daemon: _daemon }) => {
      await page.goto("/");

      const agentsLink = page.getByTestId("nav-link-agents");
      await expect(agentsLink).toBeVisible();

      await agentsLink.click();
      await expect(page).toHaveURL(/\/agents/);
    });
  });

  test.describe("Agent Editing", () => {
    test("edit button opens dialog with agent fields pre-populated", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      // Click edit on task-worker agent
      const editButton = page.getByTestId("agent-edit-button-task-worker");
      await expect(editButton).toBeVisible();
      await editButton.click();

      // Dialog should open
      const dialog = page.getByTestId("agent-edit-dialog");
      await expect(dialog).toBeVisible();

      // Title should show the agent id
      const title = page.getByTestId("agent-edit-title");
      await expect(title).toContainText("task-worker");

      // Name field should be pre-populated
      const nameInput = page.getByTestId("agent-edit-name");
      await expect(nameInput).toHaveValue("Task Worker");
    });

    test("edit dialog shows prompt template textarea", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      await page.getByTestId("agent-edit-button-task-worker").click();
      await expect(page.getByTestId("agent-edit-dialog")).toBeVisible();

      const promptTemplate = page.getByTestId("agent-edit-prompt-template");
      await expect(promptTemplate).toBeVisible();
    });

    test("edit dialog mentions automation view for trigger editing", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      await page.getByTestId("agent-edit-button-task-worker").click();
      await expect(page.getByTestId("agent-edit-dialog")).toBeVisible();

      // Dialog description should mention automation view
      const dialog = page.getByTestId("agent-edit-dialog");
      await expect(dialog).toContainText("Automation");
    });

    test("cancel discards changes and closes dialog", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      await page.getByTestId("agent-edit-button-task-worker").click();
      await expect(page.getByTestId("agent-edit-dialog")).toBeVisible();

      // Modify name
      const nameInput = page.getByTestId("agent-edit-name");
      await nameInput.fill("Modified Name");

      // Cancel
      await page.getByTestId("agent-edit-cancel").click();

      // Dialog should close
      await expect(page.getByTestId("agent-edit-dialog")).toHaveCount(0);

      // Card name should still be original
      const card = page.getByTestId("agent-card-task-worker");
      await expect(card.getByTestId("agent-name")).toContainText("Task Worker");
    });

    test("save persists changes via PATCH API and updates card", async ({
      page,
      daemon: _daemon,
    }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      await page.getByTestId("agent-edit-button-task-worker").click();
      await expect(page.getByTestId("agent-edit-dialog")).toBeVisible();

      // Modify description
      const descInput = page.getByTestId("agent-edit-description");
      await descInput.fill("Updated description via E2E test");

      // Save
      await page.getByTestId("agent-edit-save").click();

      // Dialog should close
      await expect(page.getByTestId("agent-edit-dialog")).toHaveCount(0);

      // Verify the update persisted by reloading
      await page.reload();
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-task-worker");
      await expect(card).toContainText("Updated description via E2E test");
    });

    test("edit form shows error on save failure", async ({ page, daemon: _daemon }) => {
      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      await page.getByTestId("agent-edit-button-task-worker").click();
      await expect(page.getByTestId("agent-edit-dialog")).toBeVisible();

      // Intercept PATCH to simulate failure
      await page.route("**/api/meta/agents/task-worker", (route) => {
        if (route.request().method() === "PATCH") {
          route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "internal_error", message: "Save failed" }),
          });
        } else {
          route.continue();
        }
      });

      // Save
      await page.getByTestId("agent-edit-save").click();

      // Error should be displayed
      const errorMsg = page.getByTestId("agent-edit-error");
      await expect(errorMsg).toBeVisible();
      await expect(errorMsg).toContainText("Save failed");
    });
  });

  // AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner
  // AC: @runner-operator-surfaces ac-web-ui-active-invocations-include-runner
  // AC: @runner-operator-surfaces ac-web-ui-queued-invocations-include-runner
  // AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  test.describe("Runner Surfaces", () => {
    // Shared mock payloads. The fixture daemon doesn't have a runner registry
    // configured, so these tests intercept the relevant endpoints to deliver
    // the runner-aware response shape the daemon emits in production.
    const RUNNER_AGENTS_ENVELOPE = {
      data: [
        {
          _ulid: "01KF0AGENT1CA45ZT43W2T6HJM",
          id: "task-worker",
          name: "Task Worker",
          description: "Runner-backed worker",
          capabilities: [],
          tools: [],
          conventions: [],
          adapter: "claude-agent-acp",
          runner: "claude-cli",
          resolved_adapter: "claude-agent-acp",
          runner_validation: {
            status: "valid",
            diagnostics: [],
          },
          dispatch: [{ on: "task.ready" }],
          skills: [],
          concurrency: { max_concurrent: 1 },
          auto_approve: false,
        },
        {
          _ulid: "01KF0AGENT2CC9N4YGP991WD7X",
          id: "pr-reviewer",
          name: "PR Reviewer",
          description: "Legacy adapter-backed reviewer",
          capabilities: [],
          tools: [],
          conventions: [],
          adapter: "claude-agent-acp",
          resolved_adapter: "claude-agent-acp",
          dispatch: [{ on: "task.pending_review" }],
          skills: [],
          concurrency: { max_concurrent: 1 },
          auto_approve: false,
        },
        {
          _ulid: "01KF0AGENT3CC9N4YGP991WD7X",
          id: "broken-runner-agent",
          name: "Broken Runner Agent",
          description: "Agent with invalid runner",
          capabilities: [],
          tools: [],
          conventions: [],
          adapter: "claude-agent-acp",
          runner: "missing-runner",
          resolved_adapter: "claude-agent-acp",
          runner_validation: {
            status: "invalid",
            diagnostics: [
              {
                reason: "unknown_runner",
                message:
                  'Runner "missing-runner" is not in the registry. Secret values [redacted].',
              },
            ],
          },
          dispatch: [{ on: "task.ready" }],
          skills: [],
          concurrency: { max_concurrent: 1 },
          auto_approve: false,
        },
      ],
      meta: { total: 3 },
    };

    const RUNNER_STATUS_RESPONSE = {
      dispatch_enabled: true,
      active_invocations: [
        {
          session_id: "01KSESSION00000000000000001",
          agent_id: "task-worker",
          task_ref: null,
          task_title: null,
          elapsed_ms: 5_000,
          resolved_adapter: "claude-agent-acp",
          runner: "claude-cli",
        },
        {
          session_id: "01KSESSION00000000000000002",
          agent_id: "pr-reviewer",
          task_ref: null,
          task_title: null,
          elapsed_ms: 1_000,
          resolved_adapter: "claude-agent-acp",
        },
      ],
      queued_invocations: [
        {
          agent_id: "task-worker",
          task_ref: null,
          task_title: null,
          wait_ms: 2_000,
          resolved_adapter: "claude-agent-acp",
          runner: "claude-cli",
        },
        {
          agent_id: "pr-reviewer",
          task_ref: null,
          task_title: null,
          wait_ms: 500,
          resolved_adapter: "claude-agent-acp",
        },
      ],
      queue_depth: 2,
      agent_definitions: [
        {
          id: "task-worker",
          name: "Task Worker",
          adapter: "claude-agent-acp",
          resolved_adapter: "claude-agent-acp",
          runner: "claude-cli",
          completed_sessions: 0,
        },
        {
          id: "pr-reviewer",
          name: "PR Reviewer",
          adapter: "claude-agent-acp",
          resolved_adapter: "claude-agent-acp",
          completed_sessions: 0,
        },
        {
          id: "broken-runner-agent",
          name: "Broken Runner Agent",
          adapter: "claude-agent-acp",
          resolved_adapter: "claude-agent-acp",
          runner: "missing-runner",
          completed_sessions: 0,
        },
      ],
    };

    async function mockRunnerSurfaces(page: import("@playwright/test").Page) {
      await page.route("**/api/meta/agents", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(RUNNER_AGENTS_ENVELOPE),
        }),
      );
      await page.route("**/api/agent/status", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(RUNNER_STATUS_RESPONSE),
        }),
      );
    }

    // AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner
    test("agent card shows runner name when present", async ({ page, daemon: _daemon }) => {
      await mockRunnerSurfaces(page);

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-task-worker");
      const runnerName = card.getByTestId("agent-runner-name");
      await expect(runnerName).toBeVisible();
      await expect(runnerName).toContainText("claude-cli");
    });

    // AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner
    test("agent card shows resolved adapter for all agents", async ({ page, daemon: _daemon }) => {
      await mockRunnerSurfaces(page);

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      // Runner-backed agent: resolved_adapter present
      const workerAdapter = page
        .getByTestId("agent-card-task-worker")
        .getByTestId("agent-resolved-adapter");
      await expect(workerAdapter).toBeVisible();
      await expect(workerAdapter).toContainText("claude-agent-acp");

      // Legacy adapter-backed agent: resolved_adapter still shown
      const reviewerAdapter = page
        .getByTestId("agent-card-pr-reviewer")
        .getByTestId("agent-resolved-adapter");
      await expect(reviewerAdapter).toBeVisible();
      await expect(reviewerAdapter).toContainText("claude-agent-acp");
    });

    // AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner — legacy preserved
    test("legacy adapter agent card omits runner identity", async ({ page, daemon: _daemon }) => {
      await mockRunnerSurfaces(page);

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-pr-reviewer");
      // No runner name badge for legacy agents
      await expect(card.getByTestId("agent-runner-name")).toHaveCount(0);
      // No validation badge for legacy agents
      await expect(card.getByTestId("agent-runner-validation")).toHaveCount(0);
    });

    // AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner — validation state
    test("agent card shows runner validation badge", async ({ page, daemon: _daemon }) => {
      await mockRunnerSurfaces(page);

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      // Valid runner shows Valid badge
      const validBadge = page
        .getByTestId("agent-card-task-worker")
        .getByTestId("agent-runner-validation");
      await expect(validBadge).toBeVisible();
      await expect(validBadge).toContainText("Valid");

      // Invalid runner shows Invalid badge
      const invalidBadge = page
        .getByTestId("agent-card-broken-runner-agent")
        .getByTestId("agent-runner-validation");
      await expect(invalidBadge).toBeVisible();
      await expect(invalidBadge).toContainText("Invalid");
    });

    // AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner — diagnostics
    // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
    test("agent card renders redacted runner diagnostics on invalid state", async ({
      page,
      daemon: _daemon,
    }) => {
      await mockRunnerSurfaces(page);

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-broken-runner-agent");
      const diagList = card.getByTestId("agent-runner-diagnostics");
      await expect(diagList).toBeVisible();

      const diag = card.getByTestId("agent-runner-diagnostic").first();
      await expect(diag.getByTestId("agent-runner-diagnostic-reason")).toContainText(
        "unknown_runner",
      );
      // Renders the daemon-supplied redacted message verbatim — never
      // attempts to expand secret material on the client.
      await expect(diag.getByTestId("agent-runner-diagnostic-message")).toContainText("[redacted]");

      // Valid agents must not display any diagnostics list.
      const validCard = page.getByTestId("agent-card-task-worker");
      await expect(validCard.getByTestId("agent-runner-diagnostics")).toHaveCount(0);
    });

    // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
    test("agent card does not leak structured diagnostic details into the DOM", async ({
      page,
      daemon: _daemon,
    }) => {
      // Even if the daemon returned a runner_validation diagnostic with
      // structured `details` (which may surface secret-source binding names
      // alongside the operator-facing message), the card must render only
      // the daemon-supplied redacted `message` string. Distinct sentinel
      // tokens in `details` would never appear in the redacted message —
      // verify they never reach the DOM.
      const DETAILS_SENTINEL = "DO_NOT_RENDER_DETAILS_TOKEN_ZZQ7";
      const payloadWithDetails = {
        data: [
          {
            _ulid: "01KF0AGENT4CC9N4YGP991WD7Y",
            id: "secret-redaction-agent",
            name: "Secret Redaction Agent",
            description: "Agent whose diagnostic carries structured details",
            capabilities: [],
            tools: [],
            conventions: [],
            adapter: "claude-agent-acp",
            runner: "redaction-runner",
            resolved_adapter: "claude-agent-acp",
            runner_validation: {
              status: "invalid",
              diagnostics: [
                {
                  reason: "secret_source_missing",
                  message: "Required secret source could not be resolved. Value not shown.",
                  details: {
                    binding: DETAILS_SENTINEL,
                    runner: "redaction-runner",
                  },
                },
              ],
            },
            dispatch: [{ on: "task.ready" }],
            skills: [],
            concurrency: { max_concurrent: 1 },
            auto_approve: false,
          },
        ],
        meta: { total: 1 },
      };

      await page.route("**/api/meta/agents", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payloadWithDetails),
        }),
      );
      await page.route("**/api/agent/status", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            dispatch_enabled: false,
            active_invocations: [],
            queued_invocations: [],
            queue_depth: 0,
            agent_definitions: [
              {
                id: "secret-redaction-agent",
                name: "Secret Redaction Agent",
                adapter: "claude-agent-acp",
                resolved_adapter: "claude-agent-acp",
                runner: "redaction-runner",
                completed_sessions: 0,
              },
            ],
          }),
        }),
      );

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const card = page.getByTestId("agent-card-secret-redaction-agent");
      const cardText = await card.innerText();

      // Daemon-supplied redacted message renders verbatim.
      await expect(card.getByTestId("agent-runner-diagnostic-message")).toContainText(
        "Value not shown",
      );

      // The card must not surface the diagnostic `details` object — the
      // sentinel token and any `binding:` structural key are never rendered.
      expect(cardText).not.toContain(DETAILS_SENTINEL);
      expect(cardText.toLowerCase()).not.toContain("binding:");
    });

    // AC: @runner-operator-surfaces ac-web-ui-active-invocations-include-runner
    test("active invocation row shows runner identity when present", async ({
      page,
      daemon: _daemon,
    }) => {
      await mockRunnerSurfaces(page);

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const section = page.getByTestId("active-invocations-section");
      await expect(section).toBeVisible();

      const rows = section.getByTestId("active-invocation-row");
      await expect(rows).toHaveCount(2);

      // Runner-backed invocation displays runner badge
      const runnerBadges = section.getByTestId("invocation-runner");
      await expect(runnerBadges).toHaveCount(1);
      await expect(runnerBadges.first()).toContainText("claude-cli");
    });

    // AC: @runner-operator-surfaces ac-web-ui-queued-invocations-include-runner
    test("queued invocation row shows runner identity when present", async ({
      page,
      daemon: _daemon,
    }) => {
      await mockRunnerSurfaces(page);

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      const section = page.getByTestId("queued-invocations-section");
      await expect(section).toBeVisible();

      const rows = section.getByTestId("queued-invocation-row");
      await expect(rows).toHaveCount(2);

      const queuedRunner = section.getByTestId("queued-invocation-runner");
      await expect(queuedRunner).toHaveCount(1);
      await expect(queuedRunner.first()).toContainText("claude-cli");
    });

    // AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
    test("edit form exposes runner field pre-populated from agent definition", async ({
      page,
      daemon: _daemon,
    }) => {
      await mockRunnerSurfaces(page);

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      await page.getByTestId("agent-edit-button-task-worker").click();
      await expect(page.getByTestId("agent-edit-dialog")).toBeVisible();

      const runnerInput = page.getByTestId("agent-edit-runner");
      await expect(runnerInput).toBeVisible();
      await expect(runnerInput).toHaveValue("claude-cli");
    });

    // AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
    test("edit form can set runner without touching adapter field", async ({
      page,
      daemon: _daemon,
    }) => {
      await mockRunnerSurfaces(page);

      let capturedBody: Record<string, unknown> | null = null;
      await page.route("**/api/meta/agents/pr-reviewer", (route) => {
        const request = route.request();
        if (request.method() === "PATCH") {
          capturedBody = request.postDataJSON() as Record<string, unknown>;
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              _ulid: "01KF0AGENT2CC9N4YGP991WD7X",
              id: "pr-reviewer",
              name: "PR Reviewer",
              description: "Legacy adapter-backed reviewer",
              capabilities: [],
              tools: [],
              conventions: [],
              adapter: "claude-agent-acp",
              runner: "new-runner",
              resolved_adapter: "claude-agent-acp",
              dispatch: [{ on: "task.pending_review" }],
              skills: [],
              concurrency: { max_concurrent: 1 },
              auto_approve: false,
            }),
          });
        } else {
          route.continue();
        }
      });

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      await page.getByTestId("agent-edit-button-pr-reviewer").click();
      await expect(page.getByTestId("agent-edit-dialog")).toBeVisible();

      // Adapter input untouched
      const adapterInput = page.getByTestId("agent-edit-adapter");
      await expect(adapterInput).toHaveValue("claude-agent-acp");

      // Set the runner field only
      const runnerInput = page.getByTestId("agent-edit-runner");
      await runnerInput.fill("new-runner");

      await page.getByTestId("agent-edit-save").click();
      await expect(page.getByTestId("agent-edit-dialog")).toHaveCount(0);

      // The PATCH payload includes the new runner string but keeps the
      // adapter at its existing value.
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.runner).toBe("new-runner");
      expect(capturedBody!.adapter).toBe("claude-agent-acp");
    });

    // AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
    test("edit form clears runner by submitting runner: null", async ({
      page,
      daemon: _daemon,
    }) => {
      await mockRunnerSurfaces(page);

      let capturedBody: Record<string, unknown> | null = null;
      await page.route("**/api/meta/agents/task-worker", (route) => {
        const request = route.request();
        if (request.method() === "PATCH") {
          capturedBody = request.postDataJSON() as Record<string, unknown>;
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              _ulid: "01KF0AGENT1CA45ZT43W2T6HJM",
              id: "task-worker",
              name: "Task Worker",
              description: "Runner-backed worker",
              capabilities: [],
              tools: [],
              conventions: [],
              adapter: "claude-agent-acp",
              resolved_adapter: "claude-agent-acp",
              dispatch: [{ on: "task.ready" }],
              skills: [],
              concurrency: { max_concurrent: 1 },
              auto_approve: false,
            }),
          });
        } else {
          route.continue();
        }
      });

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      await page.getByTestId("agent-edit-button-task-worker").click();
      await expect(page.getByTestId("agent-edit-dialog")).toBeVisible();

      // Pre-populated with claude-cli; use the Clear shortcut button
      const runnerInput = page.getByTestId("agent-edit-runner");
      await expect(runnerInput).toHaveValue("claude-cli");
      await page.getByTestId("agent-edit-runner-clear").click();
      await expect(runnerInput).toHaveValue("");

      await page.getByTestId("agent-edit-save").click();
      await expect(page.getByTestId("agent-edit-dialog")).toHaveCount(0);

      // Explicit null in payload signals a clear operation to the daemon.
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.runner).toBeNull();
    });

    // AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
    test("edit form omits runner field when unchanged", async ({ page, daemon: _daemon }) => {
      await mockRunnerSurfaces(page);

      let capturedBody: Record<string, unknown> | null = null;
      await page.route("**/api/meta/agents/task-worker", (route) => {
        const request = route.request();
        if (request.method() === "PATCH") {
          capturedBody = request.postDataJSON() as Record<string, unknown>;
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              _ulid: "01KF0AGENT1CA45ZT43W2T6HJM",
              id: "task-worker",
              name: "Updated Worker",
              description: "Runner-backed worker",
              capabilities: [],
              tools: [],
              conventions: [],
              adapter: "claude-agent-acp",
              runner: "claude-cli",
              resolved_adapter: "claude-agent-acp",
              dispatch: [{ on: "task.ready" }],
              skills: [],
              concurrency: { max_concurrent: 1 },
              auto_approve: false,
            }),
          });
        } else {
          route.continue();
        }
      });

      await page.goto("/agents");
      await expect(page.getByTestId("agents-loading")).toHaveCount(0);

      await page.getByTestId("agent-edit-button-task-worker").click();
      await expect(page.getByTestId("agent-edit-dialog")).toBeVisible();

      // Only modify the name; runner field is left at its baseline value.
      await page.getByTestId("agent-edit-name").fill("Updated Worker");

      await page.getByTestId("agent-edit-save").click();
      await expect(page.getByTestId("agent-edit-dialog")).toHaveCount(0);

      expect(capturedBody).not.toBeNull();
      // Omit semantics: the daemon treats absence as "leave runner unchanged".
      expect("runner" in capturedBody!).toBe(false);
    });
  });
});
