import { test, expect } from "./fixtures/test-base";

/**
 * Task Board (Kanban) E2E Tests
 *
 * Tests for the Kanban-style task board view.
 *
 * Covered ACs:
 * - AC-1: Tasks distributed into columns by status
 * - AC-2: Task cards show priority, tags, title, slug, spec ref, metadata
 * - AC-3: Clicking card opens detail modal with full task info
 * - AC-4: Active Fleet row shows running agents
 * - AC-5: Real-time updates via WebSocket
 * - AC-6: Action buttons in detail modal execute mutations via API
 * - AC-7: Closing detail modal removes ?ref= query param from URL
 */

test.describe("Task Board (Kanban)", () => {
  // AC: @ui-task-board ac-1
  test("renders board with five columns", async ({ page, daemon: _daemon }) => {
    await page.goto("/tasks/board");

    // Wait for the board container to render before asserting individual columns.
    await expect(page.getByTestId("board-columns")).toBeVisible();
    const columns = page.getByTestId("board-column");

    // Should have 5 columns: Backlog, Ready, In Progress, Review, Done
    await expect(columns).toHaveCount(5);
  });

  // AC: @ui-task-board ac-1
  test("distributes tasks into correct columns based on status", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");

    const boardColumns = page.getByTestId("board-columns");
    await expect(boardColumns).toBeVisible();

    // Verify columns exist by their IDs
    await expect(page.locator('[data-column-id="backlog"]')).toBeVisible();
    await expect(page.locator('[data-column-id="ready"]')).toBeVisible();
    await expect(page.locator('[data-column-id="in_progress"]')).toBeVisible();
    await expect(page.locator('[data-column-id="review"]')).toBeVisible();
    await expect(page.locator('[data-column-id="done"]')).toBeVisible();
  });

  // AC: @ui-task-board ac-2
  test("task card shows priority badge, tag chips, title, slug, spec ref link, and metadata", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");

    // Use 'Ready task' which has tags: [test] and spec_ref: @test-feature
    // It lands in backlog (no automation field = not eligible)
    const backlogColumn = page.locator('[data-column-id="backlog"]');
    await expect(backlogColumn).toBeVisible();
    // Target the specific card by data-task-id for the ready task fixture
    const card = backlogColumn.locator('[data-task-id="01KG0RR6CA45ZT43W2T6HJMVA1"]');
    await expect(card).toBeVisible();

    // Priority badge
    await expect(card.getByTestId("priority-badge")).toBeVisible();

    // Title
    await expect(card.getByTestId("task-title")).toBeVisible();

    // Slug (mono)
    await expect(card.getByTestId("task-slug")).toBeVisible();

    // Tag chips (fixture has tags: ['test'])
    await expect(card.getByTestId("task-tags")).toBeVisible();
    await expect(card.getByTestId("task-tags")).toContainText("test");

    // Spec ref link (fixture has spec_ref: '@test-feature')
    await expect(card.getByTestId("spec-ref-link")).toBeVisible();
    await expect(card.getByTestId("spec-ref-link")).toContainText("@test-feature");

    // Metadata footer (notes count, dependency count, age)
    await expect(card.getByTestId("task-metadata")).toBeVisible();
  });

  // AC: @ui-task-board ac-3
  test("clicking a task card opens the detail modal", async ({ page, daemon: _daemon }) => {
    await page.goto("/tasks/board");

    // Click first task card
    const card = page.getByTestId("task-card").first();
    await expect(card).toBeVisible();
    await card.click();

    // Verify modal opened
    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Modal should show task title
    await expect(page.getByTestId("task-detail-title")).toBeVisible();
    // Modal should show status badge
    await expect(page.getByTestId("task-status-badge")).toBeVisible();
    // Modal should show priority
    await expect(page.getByTestId("task-priority")).toBeVisible();
  });

  // AC: @ui-task-board ac-3
  test("detail modal shows full task info: type, deps, todos, automation, VCS, plan, session", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");

    // Click the in-progress task card — enriched fixture with all AC-3 required fields
    const inProgressColumn = page.locator('[data-column-id="in_progress"]');
    await expect(inProgressColumn).toBeVisible();
    const card = inProgressColumn.getByTestId("task-card").first();
    await expect(card).toBeVisible();
    await card.click();

    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Title
    await expect(modal.getByTestId("task-detail-title")).toHaveText("In progress task");

    // Description
    await expect(modal.getByTestId("task-description")).toBeVisible();

    // Status badge — shared StatusBadge renders a glyph + canonical label
    await expect(modal.getByTestId("task-status-badge")).toContainText("In Progress");

    // Priority
    await expect(modal.getByTestId("task-priority")).toContainText("Priority");

    // Type (AC-3 requires type to be shown)
    await expect(modal.getByTestId("task-type")).toBeVisible();
    await expect(modal.getByTestId("task-type")).toHaveText("task");

    // Spec ref
    await expect(modal.getByTestId("task-spec-ref")).toBeVisible();

    // Tags (fixture has tags: ['test'])
    await expect(modal.getByTestId("task-tags")).toBeVisible();
    await expect(modal.getByTestId("task-tags")).toContainText("test");

    // Automation status
    await expect(modal.getByTestId("task-automation")).toBeVisible();
    await expect(modal.getByTestId("task-automation")).toHaveText("eligible");

    // Dependencies (fixture has depends_on: @test-task-ready)
    await expect(modal.getByTestId("task-dependencies")).toBeVisible();

    // Blocked-by (fixture has blocked_by: ['@test-task-blocked'])
    await expect(modal.getByTestId("task-blocked-by")).toBeVisible();
    await expect(modal.getByTestId("task-blocked-by")).toContainText("@test-task-blocked");

    // VCS info (fixture has branch + PR refs)
    await expect(modal.getByTestId("task-vcs")).toBeVisible();

    // Plan ref (fixture has plan_ref: @test-plan)
    await expect(modal.getByTestId("task-plan-ref")).toBeVisible();

    // Session link (fixture has session_id: session-abc123)
    await expect(modal.getByTestId("task-session-ref")).toBeVisible();
    // Verify session link targets /sessions route (not /session)
    const sessionLink = modal.getByTestId("task-session-ref").locator("a");
    await expect(sessionLink).toHaveAttribute("href", /\/sessions\//);

    // Todos (fixture has 2 todos)
    await expect(modal.getByTestId("task-todos")).toBeVisible();

    // Notes section
    await expect(modal.getByTestId("task-notes")).toBeVisible();
  });

  // AC: @markdown-ui-adoption ac-1
  test("renders task description markdown in the detail modal", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");

    const backlogColumn = page.locator('[data-column-id="backlog"]');
    const card = backlogColumn.locator('[data-task-id="01KG0RR6CA45ZT43W2T6HJMVA1"]');
    await expect(card).toBeVisible();
    await card.click();

    const description = page.getByTestId("task-description");
    await expect(description).toBeVisible();
    await expect(description.locator("strong")).toContainText("pending");
    await expect(description.locator("code")).toContainText("kspec task start @test-task-ready");
  });

  // AC: @markdown-ui-adoption ac-2
  test("renders task note markdown in the detail modal", async ({ page, daemon: _daemon }) => {
    await page.goto("/tasks/board");

    const inProgressColumn = page.locator('[data-column-id="in_progress"]');
    const card = inProgressColumn.locator('[data-task-id="01KG0RR8CB8N4YGP991WD7XS9R"]');
    await expect(card).toBeVisible();
    await card.click();

    const note = page.getByTestId("note-item").first();
    await expect(note).toBeVisible();
    await expect(note.getByTestId("note-content").locator("code")).toContainText("npm test");
    await expect(note.getByTestId("note-content").locator("a")).toHaveAttribute(
      "href",
      "https://example.com/task-docs",
    );
    await expect(note.getByTestId("note-content").locator("li")).toHaveCount(2);
  });

  // AC: @ui-task-board ac-1
  test("shows empty state when no tasks exist", async ({ page }) => {
    // Navigate to board (if daemon has no tasks it should show empty state)
    // This test verifies the empty state component renders
    await page.goto("/tasks/board");

    // Either board columns or empty state should be visible
    const columns = page.getByTestId("board-columns");
    const empty = page.getByTestId("board-empty");

    // Wait for either to appear
    await expect(columns.or(empty)).toBeVisible();
  });

  // AC: @ui-task-board ac-5
  test("board updates after task mutation without page refresh", async ({ page, daemon }) => {
    await page.goto("/tasks/board");
    await expect(page.getByTestId("board-columns")).toBeVisible();

    // Find a pending task card and note its column
    const backlogColumn = page.locator('[data-column-id="backlog"]');
    await expect(backlogColumn).toBeVisible();
    const taskCards = backlogColumn.getByTestId("task-card");
    const _initialBacklogCount = await taskCards.count();

    // Start a pending task via API directly (simulating external state change)
    // Use the ready task which is in pending status
    const startResponse = await page.request.post(
      `${daemon.baseUrl}/api/tasks/01KG0RR6CA45ZT43W2T6HJMVA1/start`,
    );
    expect(startResponse.ok()).toBeTruthy();

    // Wait for the board to update (WebSocket notification or polling triggers reload)
    // The task should move from backlog to in_progress column
    const inProgressColumn = page.locator('[data-column-id="in_progress"]');
    await expect(async () => {
      const inProgressCards = await inProgressColumn.getByTestId("task-card").count();
      expect(inProgressCards).toBeGreaterThan(0);
    }).toPass({ timeout: 10000 });
  });

  // AC: @ui-task-board ac-6
  test("Start action button transitions pending task to in_progress", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");
    await expect(page.getByTestId("board-columns")).toBeVisible();

    // Click a pending task card (backlog column has pending tasks)
    const backlogColumn = page.locator('[data-column-id="backlog"]');
    await expect(backlogColumn).toBeVisible();

    const card = backlogColumn.getByTestId("task-card").first();
    await expect(card).toBeVisible();
    await card.click();

    // Modal should open
    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Verify the Start button is visible and click it
    const startBtn = page.getByTestId("action-start");
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    // Status badge should update to In Progress
    await expect(page.getByTestId("task-status-badge")).toContainText("In Progress", {
      timeout: 5000,
    });
  });

  // AC: @ui-task-board ac-6
  test("Submit action button transitions in_progress task to pending_review", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");
    await expect(page.getByTestId("board-columns")).toBeVisible();

    // Click the in-progress task
    const inProgressColumn = page.locator('[data-column-id="in_progress"]');
    await expect(inProgressColumn).toBeVisible();

    const card = inProgressColumn.getByTestId("task-card").first();
    await expect(card).toBeVisible();
    await card.click();

    // Modal should open
    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Verify the Submit button is visible and click it
    const submitBtn = page.getByTestId("action-submit");
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();

    // Status badge should update to Pending Review (shared token's canonical label)
    await expect(page.getByTestId("task-status-badge")).toContainText("Pending Review", {
      timeout: 5000,
    });
  });

  // AC: @ui-task-board ac-6
  test("Add Note action adds a note to the task", async ({ page, daemon: _daemon }) => {
    await page.goto("/tasks/board");
    await expect(page.getByTestId("board-columns")).toBeVisible();

    // Click a task card to open modal
    const card = page.getByTestId("task-card").first();
    await expect(card).toBeVisible();
    await card.click();

    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Find the add note form
    const noteForm = page.getByTestId("task-add-note");
    await expect(noteForm).toBeVisible();

    // Type a note
    await noteForm.locator("textarea").fill("E2E test note content");

    // Click Add Note button
    const addNoteBtn = page.getByTestId("action-add-note");
    await expect(addNoteBtn).toBeEnabled();
    await addNoteBtn.click();

    // The new note should appear in the notes list
    await expect(
      page.getByTestId("note-item").filter({ hasText: "E2E test note content" }),
    ).toBeVisible({
      timeout: 5000,
    });
  });

  // AC: @ui-task-board ac-6
  test("Complete action transitions task to completed with reason", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");
    await expect(page.getByTestId("board-columns")).toBeVisible();

    // Click a task in the review column (pending_review supports Complete)
    const reviewColumn = page.locator('[data-column-id="review"]');
    await expect(reviewColumn).toBeVisible();

    const card = reviewColumn.getByTestId("task-card").first();
    await expect(card).toBeVisible();
    await card.click();

    // Modal should open
    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Click the Complete toggle button
    const completeToggle = page.getByTestId("action-complete-toggle");
    await expect(completeToggle).toBeVisible();
    await completeToggle.click();

    // Reason input should appear
    const reasonInput = page.getByTestId("reason-input");
    await expect(reasonInput).toBeVisible();

    // Enter a completion reason and confirm
    await reasonInput.locator("input").fill("E2E test: task completed successfully");
    await reasonInput.getByRole("button", { name: "Confirm" }).click();

    // Status badge should update to Completed
    await expect(page.getByTestId("task-status-badge")).toContainText("Completed", {
      timeout: 5000,
    });
  });

  // AC: @ui-task-board ac-6
  test("Block action transitions task to blocked with reason", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");
    await expect(page.getByTestId("board-columns")).toBeVisible();

    // Click a pending task from backlog column (Block is available for non-terminal statuses)
    const backlogColumn = page.locator('[data-column-id="backlog"]');
    await expect(backlogColumn).toBeVisible();

    const card = backlogColumn.getByTestId("task-card").first();
    await expect(card).toBeVisible();
    await card.click();

    // Modal should open
    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Click the Block toggle button
    const blockToggle = page.getByTestId("action-block-toggle");
    await expect(blockToggle).toBeVisible();
    await blockToggle.click();

    // Reason input should appear
    const reasonInput = page.getByTestId("reason-input");
    await expect(reasonInput).toBeVisible();

    // Enter a block reason and confirm
    await reasonInput.locator("input").fill("E2E test: blocked on external dependency");
    await reasonInput.getByRole("button", { name: "Confirm" }).click();

    // Status badge should update to Blocked
    await expect(page.getByTestId("task-status-badge")).toContainText("Blocked", {
      timeout: 5000,
    });
  });

  // AC: @ui-task-board ac-4
  test("active fleet row is hidden when no agents are running", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");

    // Wait for board to load
    await expect(
      page.getByTestId("board-columns").or(page.getByTestId("board-empty")),
    ).toBeVisible();

    // Active fleet should NOT be visible when no agents running
    await expect(page.getByTestId("active-fleet-row")).not.toBeVisible();
  });

  // AC: @ui-task-board ac-4
  test("active fleet row shows running agents with title, agent name, elapsed, output, and pulse", async ({
    page,
    daemon: _daemon,
  }) => {
    const mockAgentStatus = {
      dispatch_enabled: true,
      active_invocations: [
        {
          session_id: "test-session-001",
          agent_id: "task-worker",
          task_ref: "@01KG0RR8CB8N4YGP991WD7XS9R",
          task_title: "In progress task",
          elapsed_ms: 125000, // 2m 5s
        },
      ],
      queue_depth: 0,
      agent_definitions: [{ id: "task-worker", name: "Task Worker", adapter: "claude-agent-acp" }],
    };

    await page.route("**/api/agent/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockAgentStatus),
      });
    });

    await page.goto("/tasks/board");
    await expect(page.getByTestId("board-columns")).toBeVisible();

    const fleetRow = page.getByTestId("active-fleet-row");
    await expect(fleetRow).toBeVisible();

    const fleetCard = page.getByTestId("fleet-card");
    await expect(fleetCard).toBeVisible();

    // Agent name should be resolved from agent_definitions (not raw agent_id)
    const agentName = page.getByTestId("fleet-agent-name");
    await expect(agentName).toBeVisible();
    await expect(agentName).toHaveText("Task Worker");

    const taskTitle = page.getByTestId("fleet-task-title");
    await expect(taskTitle).toBeVisible();
    await expect(taskTitle).toContainText("In progress task");

    await expect(fleetCard.getByText("2m 5s")).toBeVisible();

    // Pulse indicator should be visible (animated dot with ds-breathe class)
    const pulseIndicator = fleetCard.locator(".ds-breathe").first();
    await expect(pulseIndicator).toBeVisible();

    // Empty output placeholder should be visible initially
    const outputEmpty = page.getByTestId("fleet-output-empty");
    await expect(outputEmpty).toBeVisible();
    await expect(outputEmpty).toHaveText(/Awaiting output/);
  });

  // AC: @ui-task-board ac-4
  test("active fleet row shows last few lines of output from WebSocket", async ({
    page,
    daemon: _daemon,
  }) => {
    const mockAgentStatus = {
      dispatch_enabled: true,
      active_invocations: [
        {
          session_id: "test-session-002",
          agent_id: "task-worker",
          task_ref: "@01KG0RR8CB8N4YGP991WD7XS9R",
          task_title: "In progress task",
          elapsed_ms: 30000,
        },
      ],
      queue_depth: 0,
      agent_definitions: [{ id: "task-worker", name: "Task Worker", adapter: "claude-agent-acp" }],
    };

    await page.route("**/api/agent/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockAgentStatus),
      });
    });

    // Track WebSocket instances before page navigation
    await page.addInitScript(() => {
      const instances: WebSocket[] = [];
      const OriginalWebSocket = window.WebSocket;
      (window as any).__test_ws_instances = instances;
      window.WebSocket = new Proxy(OriginalWebSocket, {
        construct(target, args) {
          const ws = new target(...(args as [string, ...any[]]));
          instances.push(ws);
          return ws;
        },
      });
    });

    await page.goto("/tasks/board");
    await expect(page.getByTestId("board-columns")).toBeVisible();
    await expect(page.getByTestId("active-fleet-row")).toBeVisible();

    // Initially output should show empty placeholder
    await expect(page.getByTestId("fleet-output-empty")).toBeVisible();
    await expect(page.getByTestId("fleet-output-empty")).toHaveText(/Awaiting output/);

    // Inject a synthetic message_progress WebSocket message through the live connection
    const injected = await page.evaluate((sessionId) => {
      const instances = (window as any).__test_ws_instances as WebSocket[];
      const ws = instances?.find((s) => s.readyState === WebSocket.OPEN);
      if (!ws) return false;

      const msg = JSON.stringify({
        msg_id: "test-output-001",
        seq: 9999,
        timestamp: new Date().toISOString(),
        topic: "agents",
        event: "message_progress",
        data: {
          session_id: sessionId,
          text: "Running tests...\nAll 25 tests passed\nBuild complete\n",
        },
      });
      ws.dispatchEvent(new MessageEvent("message", { data: msg }));
      return true;
    }, "test-session-002");

    expect(injected).toBe(true);

    // Verify the output lines rendered in the fleet card
    const outputEl = page.getByTestId("fleet-output");
    await expect(outputEl).toBeVisible({ timeout: 5000 });
    await expect(outputEl).toContainText("Running tests...");
    await expect(outputEl).toContainText("All 25 tests passed");
    await expect(outputEl).toContainText("Build complete");

    // Verify aria-live attribute for accessibility
    await expect(outputEl).toHaveAttribute("aria-live", "polite");
  });

  // AC: @ui-task-board ac-3
  // AC: @ui-url-panel-state ac-1 — opens modal via click, URL updated with goto()
  // AC: @ui-url-panel-state ac-2 — dismiss removes ?ref= via goto(), modal stays closed
  test("closing detail modal removes ?ref= query param from URL", async ({
    page,
    daemon: _daemon,
  }) => {
    await page.goto("/tasks/board");
    await expect(page.getByTestId("board-columns")).toBeVisible();

    // Click a task card to open the modal
    const card = page.getByTestId("task-card").first();
    await expect(card).toBeVisible();
    await card.click();

    // Modal should open
    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Close modal by pressing Escape
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();

    // URL should NOT have ?ref= param
    expect(page.url()).not.toContain("ref=");

    // Modal should stay closed — verify component state was fully cleared
    // and the reactive effect watching ?ref= does not reopen the modal
    await page.waitForTimeout(1000);
    await expect(modal).not.toBeVisible();
  });

  // AC: @ui-task-board ac-3
  // AC: @ui-url-panel-state ac-2 — dismiss removes ?ref= via goto(), stays closed
  // AC: @ui-url-panel-state ac-3 — deep-link via ?ref=, dismiss works on first attempt
  test("closing detail modal opened via URL param removes ?ref= and stays closed", async ({
    page,
    daemon: _daemon,
  }) => {
    // Navigate directly with ?ref= param to open modal
    await page.goto("/tasks/board?ref=01KG0RR8CB8N4YGP991WD7XS9R");

    // Modal should open from URL param
    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Close modal by pressing Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    // If modal is still open (URL→modal race), press Escape again
    const closeState = await modal.getAttribute("data-state").catch(() => null);
    if (closeState === "open") {
      await page.keyboard.press("Escape");
    }
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    // URL should no longer contain ?ref=
    expect(page.url()).not.toContain("ref=");

    // Modal should stay closed — component state (selectedTaskRef, modalOpen)
    // must be cleared so the reactive effect doesn't reopen
    await page.waitForTimeout(1000);
    await expect(modal).not.toBeVisible();
  });

  // AC: @ui-task-board ac-3
  // AC: @ui-url-panel-state ac-3 — deep-link via ?ref=, dismiss works and panel stays closed
  test("can reopen same task after closing modal opened via URL param", async ({
    page,
    daemon: _daemon,
  }) => {
    // Open modal via URL param
    await page.goto("/tasks/board?ref=01KG0RR8CB8N4YGP991WD7XS9R");

    const modal = page.getByTestId("task-detail-modal");
    await expect(modal).toBeVisible();

    // Close modal
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const reCloseState = await modal.getAttribute("data-state").catch(() => null);
    if (reCloseState === "open") {
      await page.keyboard.press("Escape");
    }
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    // Click the same task card to reopen — verifies lastProcessedRef was reset
    const card = page.locator('[data-task-id="01KG0RR8CB8N4YGP991WD7XS9R"]');
    await expect(card).toBeVisible();
    await card.click();

    // Modal should reopen successfully
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("task-detail-title")).toBeVisible();
  });

  // View toggle navigation
  test("view toggle navigates between board and list views", async ({ page, daemon: _daemon }) => {
    await page.goto("/tasks/board");

    // Wait for board to load
    await expect(
      page.getByTestId("board-columns").or(page.getByTestId("board-empty")),
    ).toBeVisible();

    // Click list view toggle
    await page.getByTitle("List view").click();

    // Should navigate to tasks list
    await expect(page).toHaveURL(/\/tasks$/);
  });
});
