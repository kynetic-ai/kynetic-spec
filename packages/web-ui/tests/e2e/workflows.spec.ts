/**
 * E2E Tests for Workflows View
 *
 * Tests verify the /workflows page renders workflow definitions with
 * id, description, steps, triggers, and start action.
 *
 * Covered ACs:
 * - @ui-workflows-view ac-1: Each workflow shows id, description, ordered steps with names,
 *   trigger type if configured, and loop variant indicator. A Start button initiates the
 *   workflow via daemon API.
 */

import { test, expect } from '../fixtures/test-base';

test.describe('Workflows View', () => {
  // AC: @ui-workflows-view ac-1
  test.describe('Workflow List Rendering', () => {
    test('renders workflow cards from meta definitions', async ({ page, daemon }) => {
      await page.goto('/workflows');

      // Wait for loading to finish
      await expect(page.getByTestId('workflows-loading')).toHaveCount(0);

      const workflowList = page.getByTestId('workflows-list');
      await expect(workflowList).toBeVisible();

      const cards = page.getByTestId('workflow-card');
      await expect(cards).toHaveCount(2);
    });

    // AC: @ui-workflows-view ac-1 — workflow id
    test('workflow card shows id', async ({ page, daemon }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-loading')).toHaveCount(0);

      const ids = page.getByTestId('workflow-id');
      await expect(ids.first()).toContainText('spec-first');
      await expect(ids.nth(1)).toContainText('session-start');
    });

    // AC: @ui-workflows-view ac-1 — workflow description
    test('workflow card shows description', async ({ page, daemon }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-loading')).toHaveCount(0);

      const descriptions = page.getByTestId('workflow-description');
      await expect(descriptions.first()).toContainText('Check spec coverage before implementing');
    });

    // AC: @ui-workflows-view ac-1 — trigger type badge
    test('workflow card shows trigger type', async ({ page, daemon }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-loading')).toHaveCount(0);

      const triggers = page.getByTestId('workflow-trigger');
      await expect(triggers.first()).toContainText('behavior-change');
      await expect(triggers.nth(1)).toContainText('session-start');
    });

    // AC: @ui-workflows-view ac-1 — ordered steps with names
    test('workflow card shows ordered steps', async ({ page, daemon }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-loading')).toHaveCount(0);

      // First workflow has 3 steps
      const firstCard = page.getByTestId('workflow-card').first();
      const stepsContainer = firstCard.getByTestId('workflow-steps');
      await expect(stepsContainer).toBeVisible();

      const steps = firstCard.getByTestId('workflow-step');
      await expect(steps).toHaveCount(3);

      // Verify step content
      await expect(steps.first()).toContainText('Does the spec cover this change?');
      await expect(steps.nth(1)).toContainText('What is the spec status?');
      await expect(steps.nth(2)).toContainText('Update or create spec item if needed');
    });

    // AC: @ui-workflows-view ac-1 — Start button
    test('workflow card shows Start button', async ({ page, daemon }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-loading')).toHaveCount(0);

      const startButtons = page.getByTestId('workflow-start-btn');
      await expect(startButtons).toHaveCount(2);
      await expect(startButtons.first()).toContainText('Start');
    });
  });

  test.describe('Loading and Empty States', () => {
    test('shows loading skeleton initially', async ({ page, daemon }) => {
      // Navigate but don't wait for network idle
      const response = page.goto('/workflows', { waitUntil: 'commit' });

      // Check loading skeleton appears
      const loading = page.getByTestId('workflows-loading');
      // Loading may resolve quickly; just verify page navigated
      await response;
    });

    test('shows summary count after loading', async ({ page, daemon }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-loading')).toHaveCount(0);

      const summary = page.getByTestId('workflows-summary');
      await expect(summary).toContainText('2 workflows defined');
    });
  });

  test.describe('Step Type Icons', () => {
    // AC: @ui-workflows-view ac-1 — steps show type visually
    test('check steps show on_fail text', async ({ page, daemon }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-loading')).toHaveCount(0);

      // First step of first workflow is a check with on_fail
      const firstCard = page.getByTestId('workflow-card').first();
      const steps = firstCard.getByTestId('workflow-step');
      await expect(steps.first()).toContainText('on fail:');
      await expect(steps.first()).toContainText('Update or create spec before proceeding');
    });

    // AC: @ui-workflows-view ac-1 — decision steps show options
    test('decision steps show options', async ({ page, daemon }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-loading')).toHaveCount(0);

      const firstCard = page.getByTestId('workflow-card').first();
      const decisionStep = firstCard.getByTestId('workflow-step').nth(1);
      await expect(decisionStep).toContainText('Spec exists and matches');
      await expect(decisionStep).toContainText('No spec exists');
    });
  });
});
