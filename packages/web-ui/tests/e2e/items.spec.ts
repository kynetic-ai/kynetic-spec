import { test, expect } from '../fixtures/test-base';

/**
 * Items View E2E Tests
 *
 * Tests for the spec items view in the web dashboard.
 * Tests verify actual behavior, not just element visibility.
 *
 * Covered ACs:
 * - AC-11: Spec tree with hierarchical display, expand/collapse
 * - AC-12: Item detail panel with title, description, ACs (GWT), traits, implementation status
 * - AC-13: Linked tasks section shows tasks with status
 * - AC-14: Traits shown as chips, clickable to trait detail
 * - AC-15: AC row expansion showing full Given/When/Then with test coverage
 */

test.describe('Items View', () => {
  test.describe('Spec Tree (AC-11)', () => {
    test('displays hierarchical spec tree with modules', async ({ page, daemon }) => {
      await page.goto('/items');

      // Wait for spec tree to load
      const specTree = page.getByTestId('spec-tree').first();
      await expect(specTree).toBeVisible();

      // Verify module node is present with actual content
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await expect(moduleNode).toBeVisible();

      // Verify module displays title with actual text (scope to expand-toggle to avoid nested children)
      const nodeTitle = moduleNode.getByTestId('expand-toggle').first().getByTestId('node-title');
      await expect(nodeTitle).toBeVisible();
      await expect(nodeTitle).toContainText('Core Module');
    });

    test('expands module to show nested features', async ({ page, daemon }) => {
      await page.goto('/items');

      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await expect(moduleNode).toBeVisible();

      // Click expand toggle on module
      const expandToggle = moduleNode.getByTestId('expand-toggle').first();
      await expandToggle.click();

      // Child content should be visible - look for feature node
      const childContainer = moduleNode.getByTestId('tree-node-child');
      await expect(childContainer).toBeVisible();

      // Feature should be present with actual title (scope to expand-toggle)
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await expect(featureNode).toBeVisible();

      const featureTitle = featureNode.getByTestId('expand-toggle').first().getByTestId('node-title');
      await expect(featureTitle).toContainText('Test Feature');
    });

    test('expands feature to show nested requirements', async ({ page, daemon }) => {
      await page.goto('/items');

      const specTree = page.getByTestId('spec-tree').first();

      // Expand module first
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      // Find and expand feature
      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().click();

      // Requirement should be visible
      const featureChildContainer = featureNode.getByTestId('tree-node-child');
      await expect(featureChildContainer).toBeVisible();

      const requirementNode = featureChildContainer.locator('[data-testid*="tree-node-requirement"]').first();
      await expect(requirementNode).toBeVisible();

      const reqTitle = requirementNode.getByTestId('expand-toggle').first().getByTestId('node-title');
      await expect(reqTitle).toContainText('Test Requirement');
    });

    test('collapses expanded node to hide children', async ({ page, daemon }) => {
      await page.goto('/items');

      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();

      // Expand module
      await moduleNode.getByTestId('expand-toggle').first().click();
      const childContainer = moduleNode.getByTestId('tree-node-child');
      await expect(childContainer).toBeVisible();

      // Collapse module
      await moduleNode.getByTestId('expand-toggle').first().click();

      // Children should be hidden
      await expect(childContainer).not.toBeVisible();
    });

    test('clicking item title opens detail panel (not expand)', async ({ page, daemon }) => {
      await page.goto('/items');

      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();

      // Click on the title area (scope to expand-toggle to get only this node's title)
      const nodeTitle = moduleNode.getByTestId('expand-toggle').first().getByTestId('node-title');
      await nodeTitle.click();

      // Detail panel should open
      const detailPanel = page.getByTestId('spec-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Panel should show the module's title
      const panelTitle = detailPanel.getByTestId('spec-title');
      await expect(panelTitle).toContainText('Core Module');
    });
  });

  test.describe('Item Detail (AC-12)', () => {
    test('displays item title and description with actual content', async ({ page, daemon }) => {
      await page.goto('/items');

      // Expand module, then click on feature
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Verify title with actual content
      const title = detailPanel.getByTestId('spec-title');
      await expect(title).toContainText('Test Feature');

      // Verify description with actual content
      const description = detailPanel.getByTestId('spec-description');
      await expect(description).toContainText('A test feature for integration testing');
    });

    test('displays item type badge', async ({ page, daemon }) => {
      await page.goto('/items');

      // Click on module to open detail
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      const typeBadge = detailPanel.getByTestId('implementation-status');
      await expect(typeBadge).toBeVisible();
      await expect(typeBadge).toContainText('module');
    });

    test('displays acceptance criteria when item has them', async ({ page, daemon }) => {
      await page.goto('/items');

      // Navigate to feature which has ACs
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      await expect(detailPanel).toBeVisible();

      // AC section should be visible
      const acSection = detailPanel.getByTestId('acceptance-criteria');
      await expect(acSection).toBeVisible();

      // Should have AC items
      const acItems = acSection.getByTestId('ac-item');
      const count = await acItems.count();
      expect(count).toBeGreaterThan(0);

      // First AC should show given text in collapsed state
      const firstAcGiven = acItems.first().getByTestId('ac-given');
      await expect(firstAcGiven).toContainText('a user is viewing the feature');
    });
  });

  test.describe('Linked Tasks (AC-13)', () => {
    test('shows implementation section with linked task', async ({ page, daemon }) => {
      await page.goto('/items');

      // Navigate to test-feature which has a linked task
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Implementation section should be visible
      const implSection = detailPanel.getByTestId('implementation-section');
      await expect(implSection).toBeVisible();

      // Should have a linked task
      const linkedTask = implSection.getByTestId('linked-task').first();
      await expect(linkedTask).toBeVisible();

      // Task should show title and status
      const taskTitle = linkedTask.getByTestId('task-title');
      await expect(taskTitle).toContainText('Test pending task');

      const taskStatus = linkedTask.getByTestId('task-status-badge');
      await expect(taskStatus).toContainText('Pending');
    });

    test('clicking linked task navigates to tasks view', async ({ page, daemon }) => {
      await page.goto('/items');

      // Navigate to test-feature
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      const linkedTask = detailPanel.getByTestId('linked-task').first();
      await linkedTask.click();

      // Should navigate to tasks view
      await page.waitForURL(/\/tasks/);
      expect(page.url()).toContain('/tasks');

      // Task detail panel should open
      const taskDetailPanel = page.getByTestId('task-detail-panel');
      await expect(taskDetailPanel).toBeVisible({ timeout: 5000 });
    });

    test('shows no tasks message when item has no linked tasks', async ({ page, daemon }) => {
      await page.goto('/items');

      // Click on module (which has no linked tasks)
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      const implSection = detailPanel.getByTestId('implementation-section');
      await expect(implSection).toBeVisible();

      // Should show "no tasks" message
      await expect(implSection).toContainText('No tasks linked');
    });
  });

  test.describe('Traits (AC-14)', () => {
    test('displays traits section with trait chips', async ({ page, daemon }) => {
      await page.goto('/items');

      // Navigate to test-feature which has traits
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Traits section should be visible
      const traitsSection = detailPanel.getByTestId('traits-section');
      await expect(traitsSection).toBeVisible();

      // Should have trait chips
      const traitChip = traitsSection.getByTestId('trait-chip').first();
      await expect(traitChip).toBeVisible();

      // Trait should show actual trait name
      const traitTitle = traitChip.getByTestId('trait-title');
      await expect(traitTitle).toContainText('test-trait');
    });

    test('clicking trait chip navigates to trait detail', async ({ page, daemon }) => {
      await page.goto('/items');

      // Navigate to test-feature
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      const traitChip = detailPanel.getByTestId('trait-chip').first();
      await traitChip.click();

      // Should navigate to items view with ref param
      await page.waitForURL(/\/items\?ref=/);
      expect(page.url()).toContain('/items?ref=');
      expect(page.url()).toContain('test-trait');

      // Spec detail panel should show trait info
      const newDetailPanel = page.getByTestId('spec-detail-panel');
      await expect(newDetailPanel).toBeVisible({ timeout: 5000 });

      // Should show trait title
      const traitDetail = newDetailPanel.getByTestId('spec-title');
      await expect(traitDetail).toContainText('Test Trait');
    });

    test('traits section not visible when item has no traits', async ({ page, daemon }) => {
      await page.goto('/items');

      // Navigate to test-requirement which has no traits
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().click();

      const featureChildContainer = featureNode.getByTestId('tree-node-child');
      const requirementNode = featureChildContainer.locator('[data-testid*="tree-node-requirement"]').first();
      await requirementNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Traits section should not be visible
      const traitsSection = detailPanel.getByTestId('traits-section');
      await expect(traitsSection).not.toBeVisible();
    });
  });

  test.describe('Acceptance Criteria Expansion (AC-15)', () => {
    test('expands AC to show full Given/When/Then text', async ({ page, daemon }) => {
      await page.goto('/items');

      // Navigate to test-feature which has ACs
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      const acItem = detailPanel.getByTestId('ac-item').first();

      // Initially, full content should be hidden (accordion collapsed)
      const whenFull = acItem.getByTestId('ac-when-full');
      const thenFull = acItem.getByTestId('ac-then-full');
      await expect(whenFull).not.toBeVisible();
      await expect(thenFull).not.toBeVisible();

      // Click to expand
      const expandToggle = acItem.getByTestId('ac-expand-toggle');
      await expandToggle.click();

      // Full GWT should now be visible with actual content
      const givenFull = acItem.getByTestId('ac-given-full');
      await expect(givenFull).toBeVisible();
      await expect(givenFull).toContainText('a user is viewing the feature');

      await expect(whenFull).toBeVisible();
      await expect(whenFull).toContainText('they check the status');

      await expect(thenFull).toBeVisible();
      await expect(thenFull).toContainText('the feature shows as in progress');
    });

    test('collapses AC to hide full text', async ({ page, daemon }) => {
      await page.goto('/items');

      // Navigate to test-feature
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      const acItem = detailPanel.getByTestId('ac-item').first();
      const expandToggle = acItem.getByTestId('ac-expand-toggle');

      // Expand first
      await expandToggle.click();
      const whenFull = acItem.getByTestId('ac-when-full');
      await expect(whenFull).toBeVisible();

      // Collapse
      await expandToggle.click();

      // Full content should be hidden again
      await expect(whenFull).not.toBeVisible();
    });

    test('shows test coverage indicator element when AC expanded', async ({ page, daemon }) => {
      await page.goto('/items');

      // Navigate to test-feature
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().click();

      const childContainer = moduleNode.getByTestId('tree-node-child');
      const featureNode = childContainer.locator('[data-testid*="tree-node-feature"]').first();
      await featureNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      const detailPanel = page.getByTestId('spec-detail-panel');
      const acItem = detailPanel.getByTestId('ac-item').first();

      // Expand AC
      await acItem.getByTestId('ac-expand-toggle').click();

      // Coverage indicator should be present
      const coverageIndicator = acItem.getByTestId('test-coverage-indicator');
      await expect(coverageIndicator).toBeVisible();

      // Currently shows "Unknown" - placeholder for future implementation
      await expect(coverageIndicator).toContainText('Coverage');
    });
  });

  test.describe('Responsive Layout', () => {
    // AC: @web-dashboard ac-26
    test('adapts to mobile viewport', async ({ page, daemon }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/items');

      // Spec tree should be visible
      const specTree = page.getByTestId('spec-tree').first();
      await expect(specTree).toBeVisible();

      // Container should adapt to narrow viewport
      const treeContainer = page.getByTestId('spec-tree-container').first();
      await expect(treeContainer).toBeVisible();
    });

    // AC: @web-dashboard ac-27
    test('shows detail panel as slide-over on desktop', async ({ page, daemon }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto('/items');

      // Click spec item to open detail (scope to expand-toggle)
      const specTree = page.getByTestId('spec-tree').first();
      const moduleNode = specTree.locator('[data-testid*="tree-node-module"]').first();
      await moduleNode.getByTestId('expand-toggle').first().getByTestId('node-title').click();

      // Detail panel should slide over without navigating away
      const detailPanel = page.getByTestId('spec-detail-panel');
      await expect(detailPanel).toBeVisible();

      // Spec tree should still be visible
      await expect(specTree).toBeVisible();

      // URL should not change to a detail route
      expect(page.url()).toContain('/items');
      expect(page.url()).not.toContain('/items/');
    });
  });
});
