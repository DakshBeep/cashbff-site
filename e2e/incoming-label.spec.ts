// Income chip label text — verifies the chip with `data-type="income"` in
// the schedule popup displays the LABEL TEXT `incoming` (not `income`).
//
// Background: the user-facing label was reworded from `income` → `incoming`
// in the type-chip cluster; the underlying `data-type` (and pill class)
// stayed `income` so the rest of the codebase didn't have to churn. This
// spec pins that copy decision so a regression to `income` is caught.
//
// Selectors come from home.html:
//   #schedule-pop                          schedule popup root
//   #sched-type-chips .type-chip[data-type="income"]
//                                          the income chip itself

import { test, expect } from '@playwright/test';
import { authenticatedContext } from './auth-helper';

test.describe('income chip label', () => {
  test('chip with data-type="income" reads "incoming"', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await page.goto('/home');
    await expect(page.locator('#grid')).toBeVisible();

    await page.locator('#schedule-btn').click();
    const schedulePop = page.locator('#schedule-pop');
    await expect(schedulePop).toHaveClass(/(^|\s)open(\s|$)/);

    const incomeChip = page.locator(
      '#sched-type-chips .type-chip[data-type="income"]',
    );
    await expect(incomeChip).toBeVisible();
    // Strict text match — catches regressions to `income`, `+ income`, etc.
    await expect(incomeChip).toHaveText('incoming');

    await context.close();
  });
});
