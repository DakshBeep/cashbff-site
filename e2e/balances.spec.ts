// Balances popup smoke test.
//
// Verifies:
//   - Clicking #balances-btn opens #balances-pop (.open class)
//   - The running balance hero is visible (#running-balance not hidden) and
//     #running-balance-amount text starts with "$" or "-$"
//   - At least one .balance-row renders (Daksh's account has linked items)
//   - Pressing Escape closes the popup

import { test, expect } from '@playwright/test';
import { authenticatedContext, cleanupTestData } from './auth-helper';

test.describe('balances popup', () => {
  test.afterAll(async () => {
    await cleanupTestData();
  });

  test('opens, renders running balance + rows, closes on escape', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await page.goto('/home');
    await expect(page.locator('#grid')).toBeVisible();

    // Open the balances popup. /api/balances is fetched lazily on first open.
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/balances') && r.ok(),
        { timeout: 15_000 },
      ),
      page.locator('#balances-btn').click(),
    ]);

    const balancesPop = page.locator('#balances-pop');
    await expect(balancesPop).toHaveClass(/(^|\s)open(\s|$)/);

    // Running balance hero: NOT hidden + amount text starts with $ or -$.
    const runningBalance = page.locator('#running-balance');
    await expect(runningBalance).toBeVisible();
    // The hidden attribute is removed when populated; double-check it.
    await expect(runningBalance).not.toHaveAttribute('hidden', /.*/);

    const runningAmount = page.locator('#running-balance-amount');
    await expect(runningAmount).toBeVisible();
    await expect(runningAmount).toHaveText(/^-?\$/);

    // At least one balance row shown — Daksh has accounts linked.
    const rows = page.locator('.balance-row');
    await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // Escape closes the popup.
    await page.keyboard.press('Escape');
    await expect(balancesPop).not.toHaveClass(/(^|\s)open(\s|$)/);

    await context.close();
  });
});
