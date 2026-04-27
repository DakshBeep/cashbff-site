// Home page + calendar grid smoke test.
//
// Confirms that with a valid `cbff_session` cookie:
//   - /home renders without redirecting to the OTP login at "/"
//   - The calendar grid (#grid) has a full month worth of cells
//   - The month title is visible
//   - Today's cell is marked with .today
//
// Anything that depends on user-specific data (pills, totals, balances) is
// covered by the more focused specs.

import { test, expect } from '@playwright/test';
import { authenticatedContext, cleanupTestData } from './auth-helper';

test.describe('home calendar', () => {
  test.afterAll(async () => {
    await cleanupTestData();
  });

  test('renders calendar after auth without redirecting', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await page.goto('/home');

    // The /home page does its auth gate client-side — give /api/me a beat to
    // resolve before asserting on the URL. waitForLoadState('networkidle')
    // would be too aggressive (Sentry pings stay open), so we just wait for
    // the grid to populate.
    await expect(page.locator('#grid')).toBeVisible();

    // Should NOT have been redirected to "/" (the welcome / OTP page).
    expect(new URL(page.url()).pathname).toBe('/home');

    // Month title shown — non-empty text.
    const monthTitle = page.locator('#month-title');
    await expect(monthTitle).toBeVisible();
    await expect(monthTitle).not.toHaveText('');

    // Calendar fills 5–6 weeks; at least 28 cells must be rendered.
    const cells = page.locator('#grid .cell');
    await expect.poll(async () => cells.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(28);

    // Today cell is highlighted.
    const todayCell = page.locator('#grid .cell.today');
    await expect(todayCell).toHaveCount(1);

    await context.close();
  });
});
