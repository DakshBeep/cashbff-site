// Per-day projection line in the day popover.
//
// On any future-or-today cell with at least one scheduled txn AND a known
// base balance (from /api/wallet), the popover renders two lines:
//   "running balance: $X"                  (carry-forward to start of day)
//   "after your plans today: $Y"           (today)
//   "after your plans this day: $Y"        (future days)
//
// Math (assets/js/home.js — computeDayProjection + openDrawer):
//   running_balance(d) = walletCache.summary.running_balance_usd
//                       + Σ(scheduled income for dates strictly between today and d)
//                       − Σ(scheduled outflow for dates strictly between today and d)
//   afterPlans(d)      = running_balance(d) − dayScheduledOut + dayScheduledIn
// i.e. running_balance is the cash position projected to the START of the
// clicked day; afterPlans subtracts the day's own scheduled outflow.
//
// When d == today, running_balance is just today's wallet balance. We
// cross-check both lines against /api/wallet + /api/calendar.

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import {
  authenticatedContext,
  authenticatedApi,
  cleanupTestData,
  TEST_MARKER,
} from './auth-helper';

const TEST_NAME = `${TEST_MARKER}_proj__`;
const TEST_AMOUNT = 10; // small, so we never tip the day's outflow into "$0"

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDollar(text: string): number | null {
  const m = text.replace(/,/g, '').match(/(-?)\$([\d.]+)/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const n = parseFloat(m[2]);
  return Number.isFinite(n) ? sign * n : null;
}

/** Pull every expense for `date` from /api/calendar. Returns the running
 *  outflow + scheduled in/out splits the same way home.js computes them. */
async function fetchDayMath(api: APIRequestContext, date: string) {
  const res = await api.get(`/api/calendar?from=${date}&to=${date}`);
  if (!res.ok()) {
    throw new Error(`/api/calendar -> ${res.status()}`);
  }
  const body = (await res.json()) as {
    expenses?: Array<{
      amount: number;
      type: string;
      source?: string;
      date: string;
    }>;
  };
  const exps = (body.expenses || []).filter((e) => e.date === date);
  // outflow = sum of NON-income amounts (matches home.js line 406-408)
  const outflow = exps.reduce(
    (s, e) => (e.type === 'income' ? s : s + Number(e.amount || 0)),
    0,
  );
  let dayScheduledOut = 0;
  let dayScheduledIn = 0;
  for (const e of exps) {
    if (e.source !== 'scheduled') continue;
    if (e.type === 'income') dayScheduledIn += Number(e.amount) || 0;
    else dayScheduledOut += Number(e.amount) || 0;
  }
  return { outflow, dayScheduledOut, dayScheduledIn };
}

async function openHome(page: Page) {
  await page.goto('/home');
  await expect(page.locator('#grid')).toBeVisible();
  await expect(page.locator('#grid .cell.today')).toHaveCount(1);
}

test.describe('per-day projection line', () => {
  test.beforeAll(async () => {
    await cleanupTestData();
  });
  test.afterAll(async () => {
    await cleanupTestData();
  });

  test('"after your plans today" appears with correct math', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await openHome(page);

    // ── Schedule a small spend for today ──────────────────
    await page.locator('#schedule-btn').click();
    const schedulePop = page.locator('#schedule-pop');
    await expect(schedulePop).toHaveClass(/(^|\s)open(\s|$)/);

    await page.fill('#sched-date', todayIso());
    await page.fill('#sched-amount', String(TEST_AMOUNT));
    await page.fill('#sched-name', TEST_NAME);
    await page.locator('#sched-type-chips .type-chip[data-type="planned"]').click();

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

    // ── Open today and wait for the projection line to render ─
    await expect.poll(
      async () => {
        await page.locator('#grid .cell.today').click();
        const drawerOpen = await page.locator('#drawer.open').count();
        if (!drawerOpen) return false;
        const projTxt = (await page.locator('#drawer-projected').textContent()) || '';
        if (!projTxt.includes('after your plans today')) {
          await page.keyboard.press('Escape');
          return false;
        }
        return true;
      },
      { timeout: 20_000 },
    ).toBe(true);

    // ── Compute expected math from /api/calendar + /api/wallet ──────────
    // home.js uses a snapshotted PRECOMMITS array + walletCache, but both are
    // sourced from the same APIs so we can reproduce the arithmetic exactly.
    const api = await authenticatedApi();
    if (!api) throw new Error('JWT_SECRET missing — should have been caught earlier');
    const { dayScheduledOut, dayScheduledIn } = await fetchDayMath(api, todayIso());

    // Pull running_balance_usd from /api/wallet — that's the canonical base
    // balance home.js uses for the per-day projection.
    const walletRes = await api.get('/api/wallet');
    if (!walletRes.ok()) {
      throw new Error(`/api/wallet -> ${walletRes.status()}`);
    }
    const walletBody = (await walletRes.json()) as {
      summary?: { running_balance_usd?: number };
    };
    await api.dispose();
    const baseBalance = walletBody.summary?.running_balance_usd;
    if (typeof baseBalance !== 'number') {
      // No wallet data — projection is hidden in this state, so we can't
      // cross-check the numbers. Skip the math assertion but keep the
      // existence check above so a regression that nukes the line
      // entirely still fails this spec.
      console.warn('[per-day-projection] no wallet running_balance_usd; skipping math.');
      await context.close();
      return;
    }

    // For d == today the carry-forward IS today's base balance — no
    // intermediate days to walk through.
    const expectedRunning = baseBalance;
    const expectedAfter = expectedRunning - dayScheduledOut + dayScheduledIn;

    const totalText = (await page.locator('#drawer-total').textContent()) || '';
    const projText = (await page.locator('#drawer-projected').textContent()) || '';
    const total = parseDollar(totalText);
    const projected = parseDollar(projText);

    expect(total).not.toBeNull();
    expect(projected).not.toBeNull();
    if (total === null || projected === null) return; // typeguard

    // Top line: now shows the carry-forward running balance, NOT the day's
    // outflow. (Bug 1 fix.)
    expect(Math.abs(total - expectedRunning)).toBeLessThan(0.01);
    // Bottom line: running − dayScheduledOut + dayScheduledIn.
    expect(Math.abs(projected - expectedAfter)).toBeLessThan(0.01);

    // Sanity: our test row contributed at least TEST_AMOUNT to dayScheduledOut.
    expect(dayScheduledOut).toBeGreaterThanOrEqual(TEST_AMOUNT);

    // Bonus: ensure it's the today-specific copy, not "this day".
    expect(projText).toContain('after your plans today');

    await context.close();
  });
});
