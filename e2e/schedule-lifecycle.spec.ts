// Schedule transaction lifecycle: create → edit → delete.
//
// This is the most thorough spec — it exercises POST + PATCH + DELETE on
// /api/transactions/schedule[/:id] via the UI. Uses `__playwright_test__`
// as a marker name so leftover rows are easy to spot and the cleanup hook
// can sweep them. The cleanup runs even if any step throws (afterEach).
//
// Selectors come from home.html: #schedule-btn, #schedule-pop, #sched-date,
// #sched-amount, #sched-name, #sched-type-chips, #sched-submit, #drawer,
// #drawer-list, .drawer-item, .drawer-item__trash, .row-confirm__yes,
// #schedule-pop-title.

import { test, expect, type Page } from '@playwright/test';
import { authenticatedContext, cleanupTestData, TEST_MARKER } from './auth-helper';

const TEST_NAME = `${TEST_MARKER}__`; // "__playwright_test__"
const EDITED_NAME = `${TEST_MARKER}_edited__`; // "__playwright_test_edited__"

function todayIso(): string {
  // Use the local date so it lines up with what the calendar grid considers
  // "today" — the page builds today from `new Date()` in the user's tz.
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

async function clickTodayCell(page: Page) {
  await page.locator('#grid .cell.today').click();
  await expect(page.locator('#drawer')).toHaveClass(/(^|\s)open(\s|$)/);
}

test.describe('schedule transaction lifecycle', () => {
  // Best-effort sweep both before and after — `before` knocks out anything
  // a previous failed run left behind so the spec starts clean.
  test.beforeAll(async () => {
    await cleanupTestData();
  });
  test.afterAll(async () => {
    await cleanupTestData();
  });

  test('create, edit, and delete a scheduled txn end-to-end', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await openHome(page);

    // ── Create ─────────────────────────────────────────────
    await page.locator('#schedule-btn').click();
    const schedulePop = page.locator('#schedule-pop');
    await expect(schedulePop).toHaveClass(/(^|\s)open(\s|$)/);
    await expect(page.locator('#schedule-pop-title')).toHaveText('schedule a spend');

    // Fill the form. The date input defaults to today already, but we set
    // it explicitly so the spec is self-contained if defaults change.
    const today = todayIso();
    await page.fill('#sched-date', today);
    await page.fill('#sched-amount', '99.99');
    await page.fill('#sched-name', TEST_NAME);

    // Pick the planned chip (already active by default, but click anyway to
    // catch a regression where the default changes).
    const plannedChip = page.locator('#sched-type-chips .type-chip[data-type="planned"]');
    await plannedChip.click();
    await expect(plannedChip).toHaveClass(/is-active/);

    // Submit + wait for the popup to close as success signal.
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

    // ── Verify the row appears in the day popover ─────────
    // The grid refetches after a successful create — give it a beat.
    await expect.poll(
      async () => {
        await clickTodayCell(page);
        const visible = await page.locator(`#drawer-list .drawer-item:has-text("${TEST_NAME}")`).count();
        if (visible > 0) return true;
        // Close + retry — the calendar might still be refetching.
        await page.keyboard.press('Escape');
        return false;
      },
      { timeout: 15_000 },
    ).toBe(true);

    let row = page.locator(`#drawer-list .drawer-item:has-text("${TEST_NAME}")`).first();
    await expect(row).toBeVisible();

    // ── Edit ──────────────────────────────────────────────
    // Whole-row click opens the edit popup. The trash icon stops propagation
    // so we click the row body (the .row-main child) to be safe — that's
    // always present and not the trash glyph.
    await row.locator('.row-main').click();

    await expect(schedulePop).toHaveClass(/(^|\s)open(\s|$)/);
    await expect(page.locator('#schedule-pop-title')).toHaveText('edit transaction');
    // Fields prefilled.
    await expect(page.locator('#sched-name')).toHaveValue(TEST_NAME);
    await expect(page.locator('#sched-amount')).toHaveValue('99.99');
    await expect(page.locator('#sched-date')).toHaveValue(today);

    // Change the name and save.
    await page.fill('#sched-name', EDITED_NAME);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/transactions/schedule') &&
          r.request().method() === 'PATCH' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      page.locator('#sched-submit').click(),
    ]);
    await expect(schedulePop).not.toHaveClass(/(^|\s)open(\s|$)/);

    // ── Verify the renamed row shows ──────────────────────
    await expect.poll(
      async () => {
        await clickTodayCell(page);
        const visible = await page.locator(`#drawer-list .drawer-item:has-text("${EDITED_NAME}")`).count();
        if (visible > 0) return true;
        await page.keyboard.press('Escape');
        return false;
      },
      { timeout: 15_000 },
    ).toBe(true);

    row = page.locator(`#drawer-list .drawer-item:has-text("${EDITED_NAME}")`).first();
    await expect(row).toBeVisible();

    // ── Delete via the row's trash icon ───────────────────
    // The trash svg has opacity:0 unless hovered — force the click rather
    // than relying on the hover state, which is brittle in headless.
    await row.locator('.drawer-item__trash').click({ force: true });

    // Inline confirm appears within the same row.
    const yesBtn = row.locator('.row-confirm__yes');
    await expect(yesBtn).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/transactions/schedule') &&
          r.request().method() === 'DELETE' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      yesBtn.click(),
    ]);

    // Row should be gone from the drawer list. The drawer may close or
    // re-render, so check by re-opening if needed.
    await expect.poll(
      async () => {
        const drawerOpen = (await page.locator('#drawer.open').count()) > 0;
        if (!drawerOpen) {
          await clickTodayCell(page);
        }
        const stillThere = await page
          .locator(`#drawer-list .drawer-item:has-text("${EDITED_NAME}")`)
          .count();
        if (stillThere === 0) return true;
        await page.keyboard.press('Escape');
        return false;
      },
      { timeout: 15_000 },
    ).toBe(true);

    await context.close();
  });
});
