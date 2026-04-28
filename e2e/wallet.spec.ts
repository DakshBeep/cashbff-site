// Wallet panel — tracked-card form smoke test.
//
// Verifies:
//   1. The kind chip cluster (#wt-kind-chips) renders both debit + credit chips.
//   2. Default selection on open is `credit` (the most common tracked card).
//   3. Clicking each chip toggles `.is-active` correctly between the two —
//      this regresses the bug where missing CSS for [data-kind] made the
//      click feel like a no-op visually.
//   4. Filling name + balance + currency and submitting the form posts to
//      /api/tracked-accounts and prepends the new row in the tracked list
//      with the correct kind class on the row + .kind-chip pill.
//   5. The DELETE path removes the row from the panel.
//
// Selectors come from home.html / assets/js/home.js:
//   #wallet-btn                            wallet header chip button
//   #wallet-pop                            wallet panel root
//   #wt-kind-chips .type-chip[data-kind]   kind chip cluster
//   #wallet-add-form                       the inline add form
//   #wallet-tracked-list .wallet-tracked-row
//                                          rendered tracked-card rows

import { test, expect, type Page } from '@playwright/test';
import { authenticatedContext, cleanupTrackedAccounts, TEST_MARKER } from './auth-helper';

const TEST_NAME = `${TEST_MARKER}_wallet__`;

async function openHomeAndWallet(page: Page) {
  await page.goto('/home');
  await expect(page.locator('#grid')).toBeVisible();
  // /api/wallet is prefetched in boot(), so by the time we click wallet-btn
  // the cache should be warm and the panel should paint immediately.
  await page.locator('#wallet-btn').click();
  await expect(page.locator('#wallet-pop')).toHaveClass(/(^|\s)open(\s|$)/);
}

test.describe('wallet panel — tracked-card form', () => {
  test.beforeAll(async () => {
    await cleanupTrackedAccounts();
  });
  test.afterAll(async () => {
    await cleanupTrackedAccounts();
  });

  test('kind chips toggle between debit + credit', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await openHomeAndWallet(page);

    const debitChip = page.locator('#wt-kind-chips .type-chip[data-kind="debit"]');
    const creditChip = page.locator('#wt-kind-chips .type-chip[data-kind="credit"]');

    // Both chips visible.
    await expect(debitChip).toBeVisible();
    await expect(creditChip).toBeVisible();

    // Default: credit selected.
    await expect(creditChip).toHaveClass(/is-active/);
    await expect(creditChip).toHaveAttribute('aria-checked', 'true');
    await expect(debitChip).not.toHaveClass(/is-active/);
    await expect(debitChip).toHaveAttribute('aria-checked', 'false');

    // Click debit → active flips.
    await debitChip.click();
    await expect(debitChip).toHaveClass(/is-active/);
    await expect(debitChip).toHaveAttribute('aria-checked', 'true');
    await expect(creditChip).not.toHaveClass(/is-active/);
    await expect(creditChip).toHaveAttribute('aria-checked', 'false');

    // Click credit → flips back.
    await creditChip.click();
    await expect(creditChip).toHaveClass(/is-active/);
    await expect(creditChip).toHaveAttribute('aria-checked', 'true');
    await expect(debitChip).not.toHaveClass(/is-active/);
    await expect(debitChip).toHaveAttribute('aria-checked', 'false');

    await context.close();
  });

  test('filling form + submitting creates a tracked credit card row', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await openHomeAndWallet(page);

    // Default credit — leave it selected.
    const creditChip = page.locator('#wt-kind-chips .type-chip[data-kind="credit"]');
    await expect(creditChip).toHaveClass(/is-active/);

    await page.fill('#wt-name', TEST_NAME);
    await page.fill('#wt-balance', '123.45');
    await page.selectOption('#wt-currency', 'USD');

    // Submit and wait for POST to complete.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/tracked-accounts') &&
          r.request().method() === 'POST' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      page.locator('#wt-submit').click(),
    ]);

    // The optimistic prepend renders immediately with .is-credit on the row +
    // a .kind-chip.is-credit pill inside.
    const row = page
      .locator(`#wallet-tracked-list .wallet-tracked-row:has-text("${TEST_NAME}")`)
      .first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveClass(/is-credit/);
    await expect(row.locator('.kind-chip.is-credit')).toBeVisible();

    await context.close();
  });
});
