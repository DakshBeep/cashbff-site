// Reminder auto-create on tracked-card POST.
//
// When a user adds a tracked credit card with `due_date` set, the backend
// auto-inserts a math-neutral reminder row in `scheduled_transactions` on
// that date. Format:
//   name:   "reminder · <SHORT>" (≤ 24 chars total, see tracked-accounts.ts)
//   amount: 0
//   type:   reminder (renders as a $0.00 row in the day popover)
//
// This spec exercises the full POST → calendar refetch → day-popover render
// path. We:
//   1. Open the wallet panel.
//   2. Add a tracked credit card with a due_date ~14 days out + a unique
//      `__playwright_test_reminder__` name.
//   3. Close the wallet panel.
//   4. Navigate the calendar to the due_date's month (clicking next-month
//      until the title matches; cap to keep us from looping forever).
//   5. Open the popover for that day (locate the cell by its visible day
//      label, scoped to non-off-month cells).
//   6. Assert at least one row whose name starts with "reminder ·" and whose
//      amount is "$0.00".
//   7. Cleanup: DELETE the tracked card and the auto-created reminder row.
//
// Selectors:
//   #wallet-btn, #wallet-pop, #wt-name, #wt-balance, #wt-currency, #wt-date
//   #next-month, #prev-month, #month-title
//   #grid .cell:not(.off-month) .date          day labels for in-month cells
//   #drawer #drawer-list .drawer-item          drawer rows

import { test, expect, type Page } from '@playwright/test';
import {
  authenticatedContext,
  authenticatedApi,
  cleanupTrackedAccounts,
  cleanupTestData,
  TEST_MARKER,
} from './auth-helper';

const TEST_NAME = `${TEST_MARKER}_reminder__`;

/** yyyy-MM-dd 14 days from local-now. The reminder spec wants the row to be
 *  "in the future" so the calendar fetch covers it on the next month. */
function dueDateTwoWeeksAhead(): { iso: string; year: number; month0: number; day: number } {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return {
    iso: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year: y,
    month0: d.getMonth(), // 0-based month for matching with home.js MONTHS
    day,
  };
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

async function navigateToMonth(page: Page, year: number, month0: number) {
  const target = `${MONTHS[month0]} ${year}`;
  // Up to 24 months in either direction — guards against bugs that would
  // otherwise loop forever (e.g. if next-month is wired wrong).
  for (let i = 0; i < 24; i++) {
    const title = (await page.locator('#month-title').textContent())?.trim().toLowerCase() ?? '';
    if (title === target) return;
    await page.locator('#next-month').click();
    // Allow the renderGrid → refetch chain a beat to finish.
    await page.waitForTimeout(200);
  }
  throw new Error(`could not reach ${target} (last seen title=${await page.locator('#month-title').textContent()})`);
}

test.describe('reminder auto-create from tracked-card due_date', () => {
  test.beforeAll(async () => {
    await cleanupTrackedAccounts();
    await cleanupTestData();
  });
  test.afterAll(async () => {
    await cleanupTrackedAccounts();
    await cleanupTestData();
  });

  test('adding a tracked card with due_date creates a $0.00 reminder on that day', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await page.goto('/home');
    await expect(page.locator('#grid')).toBeVisible();

    const due = dueDateTwoWeeksAhead();

    // ── Open wallet + add tracked card with due_date ──────────
    await page.locator('#wallet-btn').click();
    await expect(page.locator('#wallet-pop')).toHaveClass(/(^|\s)open(\s|$)/);

    // Default kind is credit — leave it. Reminder auto-create runs for any
    // tracked account with due_date, but credit is the realistic case.
    await page.fill('#wt-name', TEST_NAME);
    await page.fill('#wt-balance', '50');
    await page.selectOption('#wt-currency', 'USD');
    await page.fill('#wt-date', due.iso);

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

    // Close the wallet panel — Escape works regardless of confirm state.
    await page.keyboard.press('Escape');
    await expect(page.locator('#wallet-pop')).not.toHaveClass(/(^|\s)open(\s|$)/);

    // ── Navigate calendar to the due_date's month ─────────────
    await navigateToMonth(page, due.year, due.month0);

    // ── Open the cell for `due.day` ───────────────────────────
    // Pick the in-month cell whose .date span text == day-of-month.
    const dueCell = page.locator(
      `#grid .cell:not(.off-month):has(.date:text-is("${due.day}"))`,
    ).first();
    await expect(dueCell).toBeVisible();
    await dueCell.click();

    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/);

    // ── Assert the reminder row + $0.00 amount ────────────────
    // The row's name starts with "reminder · " (literal U+00B7 middle dot).
    // We match by name-starts-with and DON'T pin the suffix — buildReminderName
    // truncates to 24 chars total and the suffix is derived from the (possibly
    // long) tracked-card name.
    const reminderRow = page
      .locator('#drawer-list .drawer-item:has(.name)', {
        has: page.locator('.name', { hasText: /^reminder\s*\u00b7/ }),
      })
      .first();
    await expect(reminderRow).toBeVisible({ timeout: 10_000 });
    await expect(reminderRow.locator('.amt')).toHaveText('$0.00');

    await context.close();

    // ── Programmatic cleanup of the auto-created reminder row.
    // The afterAll sweep handles tracked accounts; cleanupTestData() catches
    // scheduled rows whose name starts with TEST_MARKER. The reminder name is
    // "reminder · <short>" — does NOT start with TEST_MARKER, so the auto-
    // sweep WOULDN'T catch it. Delete it explicitly here.
    const api = await authenticatedApi();
    if (api) {
      try {
        const fromIso = due.iso;
        const toIso = due.iso;
        const res = await api.get(`/api/calendar?from=${fromIso}&to=${toIso}`);
        if (res.ok()) {
          const body = (await res.json()) as { expenses?: Array<{ id: number; name: string; source?: string; note?: string | null }> };
          const items = (body.expenses || []).filter((e) => {
            const name = String(e.name || '');
            const note = String(e.note || '');
            // Match "reminder ·" prefix AND auto-note "auto-created from
            // tracked card #N" so we don't nuke an unrelated user-created
            // reminder that happens to share the prefix.
            return e.source === 'scheduled' && name.startsWith('reminder \u00b7') && note.includes('auto-created from tracked card');
          });
          for (const it of items) {
            await api.delete(`/api/transactions/schedule/${it.id}`).catch(() => {});
          }
        }
      } finally {
        await api.dispose();
      }
    }
  });
});
