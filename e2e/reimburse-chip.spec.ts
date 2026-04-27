// Reimburse chip in schedule form.
//
// `reimburse` is a scheduled type added Apr 2026 — outflow-now-reimbursed-
// later. The chip uses a sage tint with a *dashed* border in both states
// (chip + calendar pill) to communicate "money in eventually" + "uncertain
// timing." This spec verifies:
//   1. The chip is selectable in the schedule form (data-type="reimburse").
//   2. The chip's active state has a dashed border (computed style).
//   3. After submit, the cell renders at least one `.pill.reimburse` with a
//      dashed border. (Cell pills are capped at 2 per cell; the test row may
//      not be among them on a busy day, so we don't assert the test name on
//      the pill — the dashed-border style is the load-bearing assertion.)
//   4. The drawer row for our test name is visible.
//
// Selectors:
//   .type-chip[data-type="reimburse"]   the chip itself
//   .pill.reimburse                     reimburse pill rendered in cells
//   #drawer-list .drawer-item           drawer rows

import { test, expect, type Page } from '@playwright/test';
import { authenticatedContext, cleanupTestData, TEST_MARKER } from './auth-helper';

const TEST_NAME = `${TEST_MARKER}_rb__`;

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

test.describe('reimburse chip in schedule form', () => {
  test.beforeAll(async () => {
    await cleanupTestData();
  });
  test.afterAll(async () => {
    await cleanupTestData();
  });

  test('reimburse-type txn renders .pill.reimburse with dashed border', async ({ browser }) => {
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
    await page.fill('#sched-amount', '42.50');
    await page.fill('#sched-name', TEST_NAME);

    const reimburseChip = page.locator(
      '#sched-type-chips .type-chip[data-type="reimburse"]',
    );
    await expect(reimburseChip).toBeVisible();
    await reimburseChip.click();
    await expect(reimburseChip).toHaveClass(/is-active/);
    await expect(reimburseChip).toHaveAttribute('aria-checked', 'true');

    // The active reimburse chip has a dashed sage border. Check the
    // computed style so a regression to a solid border is caught visually.
    const chipStyle = await reimburseChip.evaluate((el) => {
      const s = getComputedStyle(el);
      return { borderStyle: s.borderStyle };
    });
    expect(chipStyle.borderStyle).toContain('dashed');

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

    // ── Verify at least one reimburse pill on today, with dashed border ──
    // We don't assert the test row is among the cell's two visible pills —
    // pre-existing reimburses may already saturate the slot. The point of
    // this spec is the styling, which is shared across all reimburse rows.
    await expect.poll(
      async () =>
        page.locator('#grid .cell.today .pill.reimburse').count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1);

    const pill = page.locator('#grid .cell.today .pill.reimburse').first();
    await expect(pill).toBeVisible();

    const pillStyle = await pill.evaluate((el) => {
      const s = getComputedStyle(el);
      return { borderStyle: s.borderStyle };
    });
    expect(pillStyle.borderStyle).toContain('dashed');

    // ── Drawer row for OUR test txn is visible ────────────
    // The drawer list is unconstrained — every row for the day shows. This
    // is where we verify the round-trip POST → calendar refetch → render.
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
