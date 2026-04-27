// Day-popover (#drawer) open/close smoke test.
//
// Verifies:
//   - Clicking today's cell opens the drawer (.open class on #drawer)
//   - The drawer date heading is non-empty
//   - Pressing Escape closes the drawer

import { test, expect } from '@playwright/test';
import { authenticatedContext, cleanupTestData } from './auth-helper';

test.describe('day popover', () => {
  test.afterAll(async () => {
    await cleanupTestData();
  });

  test('opens on day click and closes on escape', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await page.goto('/home');
    await expect(page.locator('#grid')).toBeVisible();

    const todayCell = page.locator('#grid .cell.today');
    await expect(todayCell).toHaveCount(1);

    await todayCell.click();

    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/);

    const drawerDate = page.locator('#drawer-date');
    await expect(drawerDate).toBeVisible();
    await expect(drawerDate).not.toHaveText('');

    // Close via Escape — handler is attached to keydown on document.
    await page.keyboard.press('Escape');
    await expect(drawer).not.toHaveClass(/(^|\s)open(\s|$)/);

    await context.close();
  });
});
