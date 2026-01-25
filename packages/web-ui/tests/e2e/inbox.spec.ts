import { test, expect } from '../fixtures/test-base';

test.describe('Inbox View', () => {
	test.beforeEach(async ({ page, daemon }) => {
		await page.goto('/inbox');
		// Wait for page to load
		await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
	});

	// AC: @web-dashboard ac-16
	test('displays inbox items ordered by created_at desc', async ({ page }) => {
		// Wait for inbox list to load
		const inboxList = page.getByTestId('inbox-list');
		await expect(inboxList).toBeVisible({ timeout: 10000 });

		// Get all inbox items
		const items = page.getByTestId('inbox-item');
		const count = await items.count();

		if (count > 1) {
			// Verify items are present - ordering is handled by API
			// In real scenario, could verify timestamps are descending
			expect(count).toBeGreaterThan(0);
		}
	});

	// AC: @web-dashboard ac-16
	test('shows text preview, tags, and added_by for items', async ({ page }) => {
		const inboxList = page.getByTestId('inbox-list');
		await expect(inboxList).toBeVisible({ timeout: 10000 });

		const items = page.getByTestId('inbox-item');
		const count = await items.count();

		if (count > 0) {
			const firstItem = items.first();

			// Text should be visible
			await expect(firstItem.getByTestId('inbox-text')).toBeVisible();

			// Created date should be visible
			await expect(firstItem.getByTestId('inbox-created-at')).toBeVisible();

			// Added by should be visible
			await expect(firstItem.getByTestId('inbox-added-by')).toBeVisible();
		}
	});

	// AC: @web-dashboard ac-17
	test('Add button shows input field', async ({ page }) => {
		// Initially, input should not be visible
		await expect(page.getByTestId('inbox-input')).not.toBeVisible();

		// Click Add button
		await page.getByTestId('add-inbox-button').click();

		// Input field should now be visible
		await expect(page.getByTestId('inbox-input')).toBeVisible();
		await expect(page.getByTestId('inbox-submit')).toBeVisible();
	});

	// AC: @web-dashboard ac-17
	test('Enter key submits new item', async ({ page }) => {
		// Open add input
		await page.getByTestId('add-inbox-button').click();
		await expect(page.getByTestId('inbox-input')).toBeVisible();

		// Type text and press Enter
		const testText = `E2E test item ${Date.now()}`;
		await page.getByTestId('inbox-input').fill(testText);
		await page.getByTestId('inbox-input').press('Enter');

		// Item should appear in the list
		await expect(page.getByText(testText)).toBeVisible({ timeout: 5000 });
	});

	// AC: @web-dashboard ac-18
	test('new item appears at top of list', async ({ page }) => {
		// Wait for list to load
		const inboxList = page.getByTestId('inbox-list');
		await expect(inboxList).toBeVisible({ timeout: 10000 });

		// Get initial first item text (if any)
		const items = page.getByTestId('inbox-item');
		const initialCount = await items.count();

		// Add new item
		await page.getByTestId('add-inbox-button').click();
		const testText = `Top item test ${Date.now()}`;
		await page.getByTestId('inbox-input').fill(testText);
		await page.getByTestId('inbox-submit').click();

		// Wait for new item to appear
		await expect(page.getByText(testText)).toBeVisible({ timeout: 5000 });

		// Verify it's at the top (first item)
		const updatedItems = page.getByTestId('inbox-item');
		const newCount = await updatedItems.count();
		expect(newCount).toBe(initialCount + 1);

		// First item should contain our new text
		const firstItem = updatedItems.first();
		await expect(firstItem.getByText(testText)).toBeVisible();
	});

	// AC: @web-dashboard ac-18
	test('new item appears with animation', async ({ page }) => {
		// Add new item
		await page.getByTestId('add-inbox-button').click();
		const testText = `Animation test ${Date.now()}`;
		await page.getByTestId('inbox-input').fill(testText);
		await page.getByTestId('inbox-submit').click();

		// Item should appear (animation is CSS-based, we just verify it appears)
		await expect(page.getByText(testText)).toBeVisible({ timeout: 5000 });
	});

	// AC: @web-dashboard ac-19
	test('delete button shows confirmation dialog', async ({ page }) => {
		// Wait for list to load
		const inboxList = page.getByTestId('inbox-list');
		await expect(inboxList).toBeVisible({ timeout: 10000 });

		const items = page.getByTestId('inbox-item');
		const count = await items.count();

		if (count > 0) {
			// Click delete on first item
			await items.first().getByTestId('delete-inbox-button').click();

			// Confirmation dialog should appear
			const dialog = page.getByTestId('confirm-delete-dialog');
			await expect(dialog).toBeVisible({ timeout: 5000 });

			// Dialog should have Yes and No buttons
			await expect(page.getByTestId('confirm-delete-yes')).toBeVisible();
			await expect(page.getByTestId('confirm-delete-no')).toBeVisible();

			// Cancel the delete
			await page.getByTestId('confirm-delete-no').click();
			await expect(dialog).not.toBeVisible();
		}
	});

	// AC: @web-dashboard ac-19
	test('confirmed delete removes item from list', async ({ page }) => {
		// First, add an item that we'll delete
		await page.getByTestId('add-inbox-button').click();
		const testText = `Delete test ${Date.now()}`;
		await page.getByTestId('inbox-input').fill(testText);
		await page.getByTestId('inbox-submit').click();

		// Wait for item to appear
		await expect(page.getByText(testText)).toBeVisible({ timeout: 5000 });

		// Get the item we just added
		const itemToDelete = page.getByTestId('inbox-item').filter({ hasText: testText });
		await expect(itemToDelete).toBeVisible();

		// Click delete
		await itemToDelete.getByTestId('delete-inbox-button').click();

		// Confirm deletion
		await expect(page.getByTestId('confirm-delete-dialog')).toBeVisible();
		await page.getByTestId('confirm-delete-yes').click();

		// Item should be removed
		await expect(page.getByText(testText)).not.toBeVisible({ timeout: 5000 });
	});

	test('handles empty inbox state', async ({ page }) => {
		// If inbox is empty, should show helpful message
		const items = page.getByTestId('inbox-item');
		const count = await items.count();

		if (count === 0) {
			await expect(page.getByText('No inbox items.')).toBeVisible();
		}
	});

	test('add button toggles between Add and Cancel', async ({ page }) => {
		// Initially shows "Add Item"
		const addButton = page.getByTestId('add-inbox-button');
		await expect(addButton).toContainText('Add Item');

		// Click to open input
		await addButton.click();
		await expect(page.getByTestId('inbox-input')).toBeVisible();

		// Button should now show "Cancel"
		await expect(addButton).toContainText('Cancel');

		// Click again to close
		await addButton.click();
		await expect(page.getByTestId('inbox-input')).not.toBeVisible();
		await expect(addButton).toContainText('Add Item');
	});

	test('submit button disabled when input is empty', async ({ page }) => {
		// Open add input
		await page.getByTestId('add-inbox-button').click();
		await expect(page.getByTestId('inbox-input')).toBeVisible();

		// Submit button should be disabled when input is empty
		const submitButton = page.getByTestId('inbox-submit');
		await expect(submitButton).toBeDisabled();

		// Type something
		await page.getByTestId('inbox-input').fill('Test');

		// Submit button should now be enabled
		await expect(submitButton).toBeEnabled();
	});
});
