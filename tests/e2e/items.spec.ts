import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-base";

async function workspaceTree(page: Page): Promise<Locator> {
  const tree = page.getByTestId("spec-tree").first();
  await expect(tree).toBeVisible();
  return tree;
}

function treeRow(node: Locator): Locator {
  return node.locator("> div").first();
}

async function firstModule(page: Page): Promise<Locator> {
  const tree = await workspaceTree(page);
  const moduleNode = tree.locator('[data-testid*="tree-node-module"]').first();
  await expect(moduleNode).toBeVisible();
  return moduleNode;
}

async function expandModule(page: Page): Promise<Locator> {
  const moduleNode = await firstModule(page);
  await treeRow(moduleNode).getByTestId("workspace-row-body").click();
  await expect(moduleNode.getByTestId("tree-node-child")).toBeVisible();
  return moduleNode;
}

async function firstFeatureUnderModule(page: Page): Promise<Locator> {
  const moduleNode = await expandModule(page);
  const featureNode = moduleNode
    .getByTestId("tree-node-child")
    .locator('[data-testid*="tree-node-feature"]')
    .first();
  await expect(featureNode).toBeVisible();
  await expect(treeRow(featureNode).getByTestId("node-title")).toContainText("Test Feature");
  return featureNode;
}

test.describe("Spec Workspace", () => {
  // AC: @web-dashboard ac-11
  // AC: @unified-spec-workspace-navigation ac-dual-gesture-row
  test("row body expands inline while title opens a focused node page", async ({ page }) => {
    await page.goto("/specs");

    const moduleNode = await firstModule(page);
    await expect(treeRow(moduleNode).getByTestId("node-title")).toContainText("Core Module");

    await treeRow(moduleNode).getByTestId("workspace-row-body").click();
    await expect(moduleNode.getByTestId("tree-node-child")).toBeVisible();
    await expect(page).not.toHaveURL(/node=/);

    await Promise.all([
      page.waitForURL(/\/specs\?.*node=/),
      treeRow(moduleNode).getByTestId("node-title").click(),
    ]);
    await expect(page.getByTestId("spec-detail-panel").getByTestId("spec-title")).toContainText(
      "Core Module",
    );
  });

  // AC: @unified-spec-workspace-navigation ac-stable-node-urls
  // AC: @unified-spec-workspace-navigation ac-existing-ref-links-compatible
  // AC: @web-dashboard ac-12
  test("stable node URLs and legacy ref URLs restore the focused workspace page", async ({
    page,
  }) => {
    await page.goto("/specs?node=%40test-feature");
    const detail = page.getByTestId("spec-detail-panel");
    await expect(detail.getByTestId("spec-title")).toContainText("Test Feature");
    await expect(detail.getByTestId("spec-linked-work-count")).toContainText("7");

    await page.reload();
    await expect(detail.getByTestId("spec-title")).toContainText("Test Feature");

    await page.goto("/specs?ref=%40test-feature");
    await expect(detail.getByTestId("spec-title")).toContainText("Test Feature");
    await expect(page).toHaveURL(/\/specs\?ref=%40test-feature/);
  });

  // AC: @unified-spec-workspace-navigation ac-stable-node-urls
  // AC: @web-dashboard ac-15
  test("criterion URLs are shareable and reload to the criterion page", async ({ page }) => {
    await page.goto("/specs?node=%40test-core&ac=ac-module");

    const detail = page.getByTestId("spec-detail-panel");
    await expect(detail.getByTestId("spec-title")).toContainText("Core Module");
    await expect(detail.getByRole("heading", { name: "Scenario" })).toBeVisible();
    await expect(detail.getByTestId("ac-given-full")).toContainText("core module workspace page");

    await page.reload();
    await expect(detail.getByRole("heading", { name: "Scenario" })).toBeVisible();
    await expect(page).toHaveURL(/node=%40test-core&ac=ac-module/);
  });

  // AC: @unified-spec-workspace-navigation ac-touch-and-keyboard-open
  test("keyboard and touch users get named controls for expand and open", async ({ page }) => {
    await page.goto("/specs");
    const moduleNode = await firstModule(page);
    const row = treeRow(moduleNode);

    await expect(row.getByTestId("workspace-row-body")).toHaveAttribute(
      "aria-label",
      /Expand Core Module/,
    );
    await expect(row.getByTestId("node-title")).toHaveAttribute(
      "aria-label",
      /Open Core Module as workspace page/,
    );

    await row.getByTestId("workspace-row-body").focus();
    await page.keyboard.press("Enter");
    await expect(moduleNode.getByTestId("tree-node-child")).toBeVisible();

    await row.getByTestId("node-title").focus();
    await Promise.all([page.waitForURL(/node=/), page.keyboard.press("Enter")]);
    await expect(page.getByTestId("spec-detail-panel").getByTestId("spec-title")).toContainText(
      "Core Module",
    );
  });

  // AC: @unified-spec-workspace-navigation ac-expansion-state-preserved
  test("browser back restores previously expanded branches", async ({ page }) => {
    await page.goto("/specs");
    const featureNode = await firstFeatureUnderModule(page);
    await expect(page).toHaveURL(/expanded=/);

    await Promise.all([
      page.waitForURL(/node=.*test-feature/),
      treeRow(featureNode).getByTestId("node-title").click(),
    ]);
    await expect(page.getByTestId("spec-detail-panel").getByTestId("spec-title")).toContainText(
      "Test Feature",
    );

    await page.goBack();
    const moduleNode = await firstModule(page);
    await expect(moduleNode.getByTestId("tree-node-child")).toBeVisible();
    await expect(page).toHaveURL(/expanded=/);
  });

  // AC: @unified-spec-workspace-navigation ac-multi-branch-expansion
  test("nested branch expansion does not collapse an already expanded branch", async ({ page }) => {
    await page.goto("/specs");
    const moduleNode = await expandModule(page);
    const featureNode = moduleNode
      .getByTestId("tree-node-child")
      .locator('[data-testid*="tree-node-feature"]')
      .first();

    await treeRow(featureNode).getByTestId("workspace-row-body").click();
    await expect(moduleNode.getByTestId("tree-node-child")).toBeVisible();
    await expect(featureNode.getByTestId("tree-node-child")).toBeVisible();
    await expect(page).toHaveURL(
      /expanded=.*test-core.*test-feature|expanded=.*test-feature.*test-core/,
    );
  });

  // AC: @unified-spec-workspace-navigation ac-page-children-use-same-rows
  test("node page child sections reuse the workspace row component", async ({ page }) => {
    await page.goto("/specs?node=test-core");

    const childSection = page.getByTestId("workspace-page-children");
    await expect(childSection).toBeVisible();
    const childRow = childSection.locator('[data-testid*="tree-node-feature"]').first();
    await expect(childRow.getByTestId("node-title")).toContainText("Test Feature");

    await childRow.getByTestId("workspace-row-body").click();
    await expect(childRow.getByTestId("tree-node-child")).toBeVisible();
  });

  // AC: @unified-spec-workspace-navigation ac-stable-node-urls
  test("criterion open affordance navigates from a node page to a criterion page", async ({
    page,
  }) => {
    await page.goto("/specs?node=%40test-core");
    const acSection = page.getByTestId("acceptance-criteria");
    await expect(acSection).toBeVisible();

    await Promise.all([
      page.waitForURL(/node=%40test-core&ac=ac-module/),
      acSection.getByTestId("ac-open-page").first().click(),
    ]);

    await expect(
      page.getByTestId("spec-detail-panel").getByRole("heading", { name: "Scenario" }),
    ).toBeVisible();
  });

  // AC: @unified-spec-workspace-navigation ac-no-horizontal-scroll
  test("workspace avoids page-level horizontal scroll on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/specs?node=test-feature&expanded=test-core,test-feature");

    await expect(page.getByTestId("spec-workspace")).toBeVisible();
    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(hasHorizontalScroll).toBe(false);
  });

  // AC: @web-dashboard ac-13
  // AC: @web-dashboard ac-14
  test("focused node pages expose linked tasks and trait navigation", async ({ page }) => {
    await page.goto("/specs?node=test-feature");
    const detail = page.getByTestId("spec-detail-panel");

    const linkedTask = detail.getByTestId("linked-task").first();
    await expect(linkedTask).toBeVisible();
    await expect(linkedTask.getByTestId("task-title")).toContainText("Ready task");
    await expect(linkedTask.getByTestId("task-status-badge")).toContainText("Pending");

    const traitLink = detail.getByTestId("trait-chip").first().getByTestId("reference-link");
    await expect(traitLink).toContainText("test-trait");
    await Promise.all([page.waitForURL(/\/specs\?ref=.*test-trait/), traitLink.click()]);
    await expect(detail.getByTestId("spec-title")).toContainText("Test Trait");
  });
});
