/**
 * E2E Tests for Validation and Alignment View
 *
 * Tests verify the /validate page renders validation summary, alignment stats,
 * and issues list grouped by severity.
 *
 * Covered ACs:
 * - @ui-validation-view ac-1: Summary shows error count, warning count, valid item count.
 *   Alignment section shows spec coverage %, AC coverage %, orphaned tasks/specs counts.
 *   Issues list grouped by severity.
 */

import { test, expect } from "../fixtures/test-base";

/** Mock validation response with issues. */
function mockValidationWithIssues() {
  return {
    valid: false,
    schemaErrors: [
      {
        file: "modules/broken.yaml",
        path: "features[0]",
        message: 'Invalid schema: missing required field "title"',
      },
    ],
    refErrors: [
      {
        ref: "@nonexistent",
        sourceFile: "modules/core.yaml",
        field: "spec_ref",
        error: "not_found",
        message: "Reference @nonexistent not found",
      },
    ],
    refWarnings: [
      {
        ref: "@deprecated-item",
        sourceFile: "modules/core.yaml",
        field: "implements",
        warning: "deprecated_target",
        message: "Reference @deprecated-item targets a deprecated item",
      },
    ],
    orphans: [
      {
        ulid: "01KTEST000000000ORPHAN0001",
        title: "Orphan requirement",
        type: "requirement",
        file: "modules/orphan.yaml",
      },
    ],
    completenessWarnings: [
      {
        type: "missing_acceptance_criteria",
        itemRef: "@some-feature",
        itemTitle: "Some Feature",
        message: "Item @some-feature has no acceptance criteria",
      },
      {
        type: "missing_test_coverage",
        subtype: "own_ac",
        itemRef: "@test-feature",
        itemTitle: "Test Feature",
        message: "Item @test-feature has 1 AC(s) without test coverage",
        details: "Uncovered: ac-2",
      },
      {
        type: "missing_test_coverage",
        subtype: "trait_ac",
        itemRef: "@batch-exec",
        itemTitle: "Batch Command Execution",
        message: "Item @batch-exec has 2 inherited trait AC(s) without test coverage",
        details:
          "Uncovered trait ACs: @trait-priority-parameter ac-1, @trait-priority-parameter ac-2",
      },
    ],
    traitCycles: [],
  };
}

/** Mock validation response with no issues. */
function mockValidationClean() {
  return {
    valid: true,
    schemaErrors: [],
    refErrors: [],
    refWarnings: [],
    orphans: [],
    completenessWarnings: [],
    traitCycles: [],
  };
}

/** Mock alignment response. */
function mockAlignment() {
  return {
    stats: {
      totalSpecs: 10,
      specsWithTasks: 7,
      alignedSpecs: 5,
      orphanedSpecs: 3,
    },
    warnings: [
      {
        type: "orphaned_spec",
        specUlid: "01KTEST000000000ORPHSPEC01",
        specTitle: "Unimplemented Feature",
        message: 'Spec item "Unimplemented Feature" has no implementing tasks',
      },
      {
        type: "status_mismatch",
        specUlid: "01KTEST000000000MISMATCH1",
        specTitle: "Misaligned Feature",
        message: 'Spec "Misaligned Feature" status is "not_started" but should be "in_progress"',
      },
    ],
  };
}

/** Mock items response (with acceptance_criteria_count for AC coverage calculation). */
function mockItems() {
  // Total ACs: 3+2+1+2+3+1+2+1+3+2 = 20 ACs across 10 items
  return {
    items: [
      { _ulid: "01KTEST000000000000ITEM001", title: "Item 1", acceptance_criteria_count: 3 },
      { _ulid: "01KTEST000000000000ITEM002", title: "Item 2", acceptance_criteria_count: 2 },
      { _ulid: "01KTEST000000000000ITEM003", title: "Item 3", acceptance_criteria_count: 1 },
      { _ulid: "01KTEST000000000000ITEM004", title: "Item 4", acceptance_criteria_count: 2 },
      { _ulid: "01KTEST000000000000ITEM005", title: "Item 5", acceptance_criteria_count: 3 },
      { _ulid: "01KTEST000000000000ITEM006", title: "Item 6", acceptance_criteria_count: 1 },
      { _ulid: "01KTEST000000000000ITEM007", title: "Item 7", acceptance_criteria_count: 2 },
      { _ulid: "01KTEST000000000000ITEM008", title: "Item 8", acceptance_criteria_count: 1 },
      { _ulid: "01KTEST000000000000ITEM009", title: "Item 9", acceptance_criteria_count: 3 },
      { _ulid: "01KTEST000000000000ITEM010", title: "Item 10", acceptance_criteria_count: 2 },
    ],
    total: 10,
    offset: 0,
    limit: 50,
  };
}

/** Mock tasks response (for orphaned task count). */
function mockTasks() {
  return {
    items: [
      {
        _ulid: "01KTEST000000000000TASK001",
        title: "Task with spec",
        status: "pending",
        priority: 2,
        spec_ref: "@test-feature",
        tags: [],
        depends_on: [],
        created_at: "2026-01-01T00:00:00Z",
        notes_count: 0,
      },
      {
        _ulid: "01KTEST000000000000TASK002",
        title: "Task without spec",
        status: "in_progress",
        priority: 3,
        tags: [],
        depends_on: [],
        created_at: "2026-01-01T00:00:00Z",
        notes_count: 0,
      },
      {
        _ulid: "01KTEST000000000000TASK003",
        title: "Another orphan task",
        status: "pending",
        priority: 1,
        tags: [],
        depends_on: [],
        created_at: "2026-01-01T00:00:00Z",
        notes_count: 0,
      },
    ],
    total: 3,
    offset: 0,
    limit: 50,
  };
}

/** Register all route mocks for the validate page. */
async function setupValidateRoutes(
  page: import("@playwright/test").Page,
  options?: {
    validation?: ReturnType<typeof mockValidationWithIssues>;
    alignment?: ReturnType<typeof mockAlignment>;
    items?: ReturnType<typeof mockItems>;
    tasks?: ReturnType<typeof mockTasks>;
  },
) {
  const validationData = options?.validation ?? mockValidationWithIssues();
  const alignmentData = options?.alignment ?? mockAlignment();
  const itemsData = options?.items ?? mockItems();
  const tasksData = options?.tasks ?? mockTasks();

  await page.route("**/api/validate", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(validationData),
    });
  });

  await page.route("**/api/alignment", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(alignmentData),
    });
  });

  await page.route("**/api/items?*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(itemsData),
    });
  });

  await page.route("**/api/tasks?*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(tasksData),
    });
  });
}

test.describe("Validation and Alignment View", () => {
  test.describe("Summary Cards (AC-1)", () => {
    // AC: @ui-validation-view ac-1
    test("displays error count, warning count, and valid item count", async ({
      page,
      daemon: _daemon,
    }) => {
      await setupValidateRoutes(page);
      await page.goto("/validate");

      // Wait for data to load
      await expect(page.getByTestId("summary-cards")).toBeVisible();

      // Error count card
      const errorCard = page.getByTestId("error-count-card");
      await expect(errorCard).toBeVisible();
      // 1 schemaError + 1 refError + 0 traitCycles = 2 errors
      await expect(errorCard).toContainText("2");
      await expect(errorCard).toContainText("Errors");

      // Warning count card
      const warningCard = page.getByTestId("warning-count-card");
      await expect(warningCard).toBeVisible();
      // 1 refWarning + 3 completenessWarnings + 1 orphan = 5 warnings
      await expect(warningCard).toContainText("5");
      await expect(warningCard).toContainText("Warnings");

      // Valid items card
      const validCard = page.getByTestId("valid-count-card");
      await expect(validCard).toBeVisible();
      await expect(validCard).toContainText("Valid Items");
      // 10 items total, 2 source items with errors:
      // schemaError from 'modules/broken.yaml', refError from sourceFile 'modules/core.yaml'
      // → 10 - 2 = 8 valid items
      const validCount = page.getByTestId("valid-item-count");
      await expect(validCount).toContainText("8");
    });

    // AC: @ui-validation-view ac-1
    test('shows "Issues Found" badge when validation has errors', async ({
      page,
      daemon: _daemon,
    }) => {
      await setupValidateRoutes(page);
      await page.goto("/validate");

      await expect(page.getByTestId("status-invalid")).toBeVisible();
      await expect(page.getByTestId("status-invalid")).toContainText("Issues Found");
    });

    // AC: @ui-validation-view ac-1
    test('shows "Valid" badge when all checks pass', async ({ page, daemon: _daemon }) => {
      await setupValidateRoutes(page, { validation: mockValidationClean() });
      await page.goto("/validate");

      await expect(page.getByTestId("status-valid")).toBeVisible();
      await expect(page.getByTestId("status-valid")).toContainText("Valid");
    });
  });

  test.describe("Alignment Section (AC-1)", () => {
    // AC: @ui-validation-view ac-1
    test("shows spec coverage percentage", async ({ page, daemon: _daemon }) => {
      await setupValidateRoutes(page);
      await page.goto("/validate");

      const specCoverage = page.getByTestId("spec-coverage");
      await expect(specCoverage).toBeVisible();
      // 7/10 specs with tasks = 70%
      await expect(specCoverage).toContainText("70%");
      await expect(specCoverage).toContainText("Spec Coverage");
    });

    // AC: @ui-validation-view ac-1
    test("shows AC coverage percentage", async ({ page, daemon: _daemon }) => {
      await setupValidateRoutes(page);
      await page.goto("/validate");

      const acCoverage = page.getByTestId("ac-coverage");
      await expect(acCoverage).toBeVisible();
      await expect(acCoverage).toContainText("AC Coverage");
      // 20 total ACs (from acceptance_criteria_count)
      // 1 uncovered own AC (from "Uncovered: ac-2") + 2 uncovered trait ACs
      // (from "Uncovered trait ACs: @trait-priority-parameter ac-1, @trait-priority-parameter ac-2")
      // Coverage = (20 - 3) / 20 = 85%
      await expect(acCoverage).toContainText("85%");
      await expect(acCoverage).toContainText("17/20 ACs with tests");
    });

    // AC: @ui-validation-view ac-1
    test("AC coverage includes uncovered trait ACs", async ({ page, daemon: _daemon }) => {
      // Build validation with ONLY trait AC warnings (no own AC warnings)
      const traitOnlyValidation = {
        ...mockValidationClean(),
        completenessWarnings: [
          {
            type: "missing_test_coverage",
            subtype: "trait_ac",
            itemRef: "@batch-exec",
            itemTitle: "Batch Command Execution",
            message: "Item @batch-exec has 3 inherited trait AC(s) without test coverage",
            details:
              "Uncovered trait ACs: @trait-priority-parameter ac-1, @trait-priority-parameter ac-2, @trait-priority-parameter ac-3",
          },
        ],
      };
      await setupValidateRoutes(page, { validation: traitOnlyValidation });
      await page.goto("/validate");

      const acCoverage = page.getByTestId("ac-coverage");
      await expect(acCoverage).toBeVisible();
      // 20 total ACs, 3 uncovered trait ACs → (20 - 3) / 20 = 85%
      await expect(acCoverage).toContainText("85%");
      await expect(acCoverage).toContainText("17/20 ACs with tests");
    });

    // AC: @ui-validation-view ac-1
    test("shows orphaned tasks count", async ({ page, daemon: _daemon }) => {
      await setupValidateRoutes(page);
      await page.goto("/validate");

      const orphanedTasks = page.getByTestId("orphaned-tasks");
      await expect(orphanedTasks).toBeVisible();
      await expect(orphanedTasks).toContainText("Orphaned Tasks");
      // 2 tasks without spec_ref
      await expect(orphanedTasks).toContainText("2");
    });

    // AC: @ui-validation-view ac-1
    test("shows orphaned specs count", async ({ page, daemon: _daemon }) => {
      await setupValidateRoutes(page);
      await page.goto("/validate");

      const orphanedSpecs = page.getByTestId("orphaned-specs");
      await expect(orphanedSpecs).toBeVisible();
      await expect(orphanedSpecs).toContainText("Orphaned Specs");
      // 3 orphaned specs from alignment stats
      await expect(orphanedSpecs).toContainText("3");
    });
  });

  test.describe("Issues List (AC-1)", () => {
    // AC: @ui-validation-view ac-1
    test("shows issues grouped by severity", async ({ page, daemon: _daemon }) => {
      await setupValidateRoutes(page);
      await page.goto("/validate");

      const issuesList = page.getByTestId("issues-list");
      await expect(issuesList).toBeVisible();

      // Error issues group
      const errorGroup = page.getByTestId("error-issues");
      await expect(errorGroup).toBeVisible();
      await expect(errorGroup).toContainText("Errors (2)");

      // Warning issues group
      const warningGroup = page.getByTestId("warning-issues");
      await expect(warningGroup).toBeVisible();
      // 1 refWarning + 3 completenessWarnings + 1 status_mismatch alignment = 5 warnings
      await expect(warningGroup).toContainText("Warnings (5)");

      // Info issues group
      const infoGroup = page.getByTestId("info-issues");
      await expect(infoGroup).toBeVisible();
      // 1 orphan + 1 orphaned_spec alignment warning = 2 info
      await expect(infoGroup).toContainText("Info (2)");
    });

    // AC: @ui-validation-view ac-1
    test("error issues show category badge and message", async ({ page, daemon: _daemon }) => {
      await setupValidateRoutes(page);
      await page.goto("/validate");

      const errorIssues = page.getByTestId("issue-error");
      await expect(errorIssues).toHaveCount(2);

      // First error: schema error
      const firstError = errorIssues.nth(0);
      await expect(firstError).toContainText("Schema");
      await expect(firstError).toContainText("Invalid schema");

      // Second error: reference error
      const secondError = errorIssues.nth(1);
      await expect(secondError).toContainText("Reference");
      await expect(secondError).toContainText("@nonexistent not found");
    });

    // AC: @ui-validation-view ac-1
    test("shows no issues message when validation is clean", async ({ page, daemon: _daemon }) => {
      await setupValidateRoutes(page, {
        validation: mockValidationClean(),
        alignment: { stats: mockAlignment().stats, warnings: [] },
      });
      await page.goto("/validate");

      const noIssues = page.getByTestId("no-issues");
      await expect(noIssues).toBeVisible();
      await expect(noIssues).toContainText("No issues found");
    });
  });

  test.describe("Loading State", () => {
    test("shows loading skeleton while fetching", async ({ page, daemon: _daemon }) => {
      // Delay the response to observe loading state
      await page.route("**/api/validate", async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mockValidationClean()),
        });
      });
      await page.route("**/api/alignment", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mockAlignment()),
        });
      });
      await page.route("**/api/items?*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mockItems()),
        });
      });
      await page.route("**/api/tasks?*", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mockTasks()),
        });
      });

      await page.goto("/validate");

      const skeleton = page.getByTestId("loading");
      await expect(skeleton).toBeVisible();

      // Eventually loads
      await expect(page.getByTestId("summary-cards")).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Empty State", () => {
    test("shows empty state when no data returned", async ({ page, daemon: _daemon }) => {
      // Return errors for all endpoints to trigger no-data state
      await page.route("**/api/validate", (route) => {
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal_error" }),
        });
      });
      await page.route("**/api/alignment", (route) => {
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal_error" }),
        });
      });
      await page.route("**/api/items?*", (route) => {
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal_error" }),
        });
      });
      await page.route("**/api/tasks?*", (route) => {
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal_error" }),
        });
      });

      await page.goto("/validate");

      // Error state should appear
      const errorBanner = page.getByTestId("error");
      await expect(errorBanner).toBeVisible();
    });
  });

  test.describe("Navigation", () => {
    test("validate page is accessible from sidebar", async ({ page, daemon: _daemon }) => {
      await setupValidateRoutes(page);
      await page.goto("/");

      const validateLink = page.getByTestId("nav-link-validate");
      await expect(validateLink).toBeVisible();

      await validateLink.click();
      await expect(page).toHaveURL(/\/validate/);
    });
  });
});
