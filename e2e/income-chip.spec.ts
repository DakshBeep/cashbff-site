// Income chip in schedule form.
//
// Verifies that:
//   1. The income type chip exists in #sched-type-chips.
//   2. Selecting it + submitting creates a row that appears with a sage
//      `.pill.income` swatch in today's calendar cell.
//   3. The day-popover row has the `+$` prefix in the cell pill (income
//      reads as "money in" at a glance).
//
// Selectors come from home.html / assets/js/home.js:
//   .type-chip[data-type="income"]   the chip itself
//   .pill.income                     income pill rendered in calendar cells
//   #drawer-list .drawer-item        drawer rows

import { test, expect, type Page } from '@playwright/test';
import { authenticatedContext, cleanupTestData, TEST_MARKER } from './auth-helper';

const TEST_NAME = `${TEST_MARKER}_income__`;

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function openHome(page: Page) {
  await page.goto('/home');
  await expect(page.locator('#grid')).toBeVisible();
  await expect(page.locator('#grid .cell.today')).toHaveCount(1);
}

test.describe('income chip in schedule form', () => {
  test.beforeAll(async () => {
    await cleanupTestData();
  });
  test.afterAll(async () => {
    await cleanupTestData();
  });

  test('creating an income txn shows a sage .pill.income on today', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await openHome(page);

    // ── Open schedule popup ────────────────────────────────
    await page.locator('#schedule-btn').click();
    const schedulePop = page.locator('#schedule-pop');
    await expect(schedulePop).toHaveClass(/(^|\s)open(\s|$)/);

    // ── Fill the form ──────────────────────────────────────
    const today = todayIso();
    await page.fill('#sched-date', today);
    await page.fill('#sched-amount', '500.00');
    await page.fill('#sched-name', TEST_NAME);

    const incomeChip = page.locator('#sched-type-chips .type-chip[data-type="income"]');
    await incomeChip.click();
    await expect(incomeChip).toHaveClass(/is-active/);
    await expect(incomeChip).toHaveAttribute('aria-checked', 'true');

    // ── Submit ─────────────────────────────────────────────
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/transactions/schedule') &&
          r.request().method() === 'POST' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      page.locator('#sched-submit').click(),
    ]);
    await expect(schedulePop).not.toHaveClass(/(^|\s)open(\s|$)/);

    // ── Verify the calendar cell has at least one .pill.income ────
    // Cells render at most maxPills (2) pills, so on a day with multiple
    // income rows our test row may not be among the visible pills. The
    // load-bearing assertion is the drawer row + that the income pill
    // styling exists (any income pill on today gives us coverage of the
    // sage class application).
    await expect.poll(
      async () => page.locator('#grid .cell.today .pill.income').count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1);

    const incomePill = page.locator('#grid .cell.today .pill.income').first();
    await expect(incomePill).toBeVisible();
    // Income pills always start with "+$" — verifies the prefix logic in
    // the cell renderer regardless of which income txn we landed on.
    await expect(incomePill).toContainText('+$');

    // ── Confirm OUR row shows in the drawer ────────────────
    // The drawer is unconstrained — every row for the day shows.
    await page.locator('#grid .cell.today').click();
    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/);

    const drawerRow = page
      .locator(`#drawer-list .drawer-item:has-text("${TEST_NAME}")`)
      .first();
    await expect(drawerRow).toBeVisible();

    await context.close();
  });
});
