import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { test, expect } from "./fixtures/test-base";

function appendYamlBlock(filePath: string, block: string): void {
  // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reads test-generated fixture file in temp dir
  const original = readFileSync(filePath, "utf8").trimEnd();
  const normalizedBlock = block.replace(/^\n+/, "").replace(/\n+$/, "");
  writeFileSync(filePath, `${original}\n\n${normalizedBlock}\n`);
}

function replaceYamlText(filePath: string, from: string, to: string): void {
  // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reads test-generated fixture file in temp dir
  const original = readFileSync(filePath, "utf8");
  // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- assertion on test-generated fixture content
  if (!original.includes(from)) {
    throw new Error(`Expected fixture text not found in ${filePath}: ${from}`);
  }
  writeFileSync(filePath, original.replace(from, to));
}

function projectNameFromPath(projectPath: string): string {
  const segments = projectPath.split("/").filter(Boolean);
  return segments.at(-1) ?? projectPath;
}

test.describe("File Watcher UI", () => {
  // Skip all file watcher tests in CI because the hosted environment does not
  // deliver these watcher events reliably enough for the UI assertions.
  // oxlint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    if (process.env.CI) {
      testInfo.skip(
        true,
        "File watcher tests skip in CI — hosted runners do not deliver watcher events reliably",
      );
    }
  });

  // AC: @ui-data-freshness ac-3
  // AC: @ui-data-freshness ac-10
  test("updates the task list after project.tasks.yaml changes without a page refresh", async ({
    page,
    daemon,
  }) => {
    await page.goto("/tasks");

    const taskItems = page.getByTestId("task-list-item");
    await expect(taskItems.first()).toBeVisible({ timeout: 10_000 });
    const countBefore = await taskItems.count();

    const tasksFile = join(daemon.kspecDir, "project.tasks.yaml");
    appendYamlBlock(
      tasksFile,
      `
- _ulid: 01KMWATC48F3R1H8P2Y7C9ZX11
  slugs:
    - watcher-added-task
  title: Watcher added task
  type: task
  status: pending
  priority: 2
  tags:
    - watcher
  depends_on: []
  created_at: "2026-03-30T12:00:00Z"
  notes_count: 0
  todos_count: 0
`,
    );

    await expect(taskItems.filter({ hasText: "Watcher added task" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(taskItems).toHaveCount(countBefore + 1, { timeout: 10_000 });
  });

  // AC: @ui-data-freshness ac-3
  // AC: @ui-data-freshness ac-4
  test("updates the sidebar inbox badge after project.inbox.yaml changes", async ({
    page,
    daemon,
  }) => {
    await page.goto("/tasks");

    const taskItems = page.getByTestId("task-list-item");
    await expect(taskItems.first()).toBeVisible({ timeout: 10_000 });

    const inboxBadge = page.getByTestId("badge-inbox");
    await expect(inboxBadge).toHaveText("3");

    const inboxFile = join(daemon.kspecDir, "project.inbox.yaml");
    appendYamlBlock(
      inboxFile,
      `
  - _ulid: 01KMWATC48F3R1H8P2Y7C9ZX12
    text: Watcher-added inbox item
    tags:
      - watcher
    added_by: watcher-test
    created_at: "2026-03-30T12:05:00Z"
`,
    );

    await expect(inboxBadge).toHaveText("4", { timeout: 10_000 });
  });

  // AC: @ui-data-freshness ac-3
  // AC: @ui-data-freshness ac-10
  test("updates the items view after modules/core.yaml changes", async ({ page, daemon }) => {
    await page.goto("/items");

    const specTree = page.getByTestId("spec-tree").first();
    const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
    await expect(moduleNode).toBeVisible();
    await moduleNode.locator("> div").first().getByTestId("expand-toggle").click();

    const featureTitle = moduleNode
      .getByTestId("tree-node-child")
      .locator('[data-testid*="tree-node-feature"]')
      .first()
      .locator("> div")
      .first()
      .getByTestId("node-title");

    await expect(featureTitle).toContainText("Test Feature");

    const coreModuleFile = join(daemon.kspecDir, "modules", "core.yaml");
    replaceYamlText(coreModuleFile, "title: Test Feature", "title: Watcher Updated Feature");

    await expect(featureTitle).toContainText("Watcher Updated Feature", { timeout: 10_000 });
  });

  // AC: @multi-directory-daemon ac-18
  // AC: @multi-directory-daemon ac-25
  test("does not refetch or replace first-project task data when a second project changes", async ({
    page,
    daemon,
  }) => {
    const secondProjectPath = await daemon.createSecondProject();

    await page.goto("/tasks");

    const taskItems = page.getByTestId("task-list-item");
    await expect(taskItems.first()).toBeVisible({ timeout: 10_000 });
    // Capture the first-project task list snapshot before the second-project mutation
    const countBefore = await taskItems.count();
    const titlesBefore: string[] = [];
    for (let i = 0; i < countBefore; i++) {
      const title = await taskItems.nth(i).getByTestId("task-title").textContent();
      titlesBefore.push(title ?? "");
    }
    await expect(page.getByTestId("project-selector")).toContainText(
      projectNameFromPath(daemon.tempDir),
    );

    const secondTasksFile = join(secondProjectPath, ".kspec", "project.tasks.yaml");
    const unexpectedFirstProjectRefetch = page
      .waitForRequest(
        (request) =>
          request.url().includes("/api/tasks") &&
          request.headers()["x-kspec-dir"] === daemon.tempDir,
        { timeout: 2_000 },
      )
      .then(() => true)
      .catch(() => false);

    writeFileSync(
      secondTasksFile,
      `tasks:
  - _ulid: 01KMWATC48F3R1H8P2Y7C9ZX13
    slugs:
      - second-project-watcher-task
    title: Second project watcher task
    type: task
    status: pending
    priority: 1
    tags:
      - watcher
    depends_on: []
    created_at: "2026-03-30T12:10:00Z"
    notes_count: 0
    todos_count: 0
`,
    );

    expect(await unexpectedFirstProjectRefetch).toBe(false);
    await expect(taskItems.filter({ hasText: "Second project watcher task" })).toHaveCount(0);
    // First-project list should be unchanged after second-project mutation
    await expect(taskItems).toHaveCount(countBefore);
    const titlesAfter: string[] = [];
    for (let i = 0; i < (await taskItems.count()); i++) {
      const title = await taskItems.nth(i).getByTestId("task-title").textContent();
      titlesAfter.push(title ?? "");
    }
    expect(titlesAfter).toEqual(titlesBefore);
  });
});
