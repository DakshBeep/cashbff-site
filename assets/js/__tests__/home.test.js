// Unit tests for the day-popover running-balance math in home.js.
//
// Bug 1: clicking a day in the calendar showed "running balance: $25.00" /
// "after your plans this day: $0.00" when the user actually had $1000+ cash.
// The prior code used the day's own outflow as the "running balance" line.
// not the carry-forward projection the label promises.
//
// home.js is an IIFE that auto-runs on import. It mounts pure-math helpers
// onto window.__homeDayMath when imported in a browser-like environment so
// these tests can drive the projection without standing up the live UI:
//   - computeTodayBaseBalance()
//   - computeDayProjection(d)
//   - formatSignedMoney(n)
// And test-only setters that inject fixtures:
//   - __setWalletCacheForTest, __setBalancesCacheForTest,
//     __setPrecommitsForTest, __setTodayForTest
//
// We import home.js once (its DOM-touching wireXxx() calls all bail no-op
// when getElementById returns null) and reuse the helpers across cases.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

let math;

beforeAll(async () => {
  // Stub fetch so home.js's gateAuth/fetchCalendar boot calls don't blow up
  // jsdom's lack of network. Returns a 401-ish response that the gateAuth
  // path treats as "not signed in" and silently bails.
  globalThis.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '',
    });
  // Stub location.replace so the 401 redirect doesn't actually navigate.
  if (window.location && typeof window.location.replace !== 'function') {
    window.location.replace = () => {};
  }
  await import('../home.js');
  math = window.__homeDayMath;
  if (!math) throw new Error('home.js did not expose __homeDayMath');
});

beforeEach(() => {
  // Reset fixtures between tests so order doesn't matter.
  math.__setWalletCacheForTest(null);
  math.__setBalancesCacheForTest(null);
  math.__setPrecommitsForTest([]);
  math.__setTodayForTest(new Date(2026, 3, 27)); // Apr 27, 2026 (months are 0-indexed)
});

// ── computeTodayBaseBalance ────────────────────────────────────────
describe('computeTodayBaseBalance', () => {
  it('returns null when neither wallet nor balances is loaded', () => {
    expect(math.computeTodayBaseBalance()).toBe(null);
  });

  it('returns walletCache.summary.running_balance_usd when present', () => {
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 1234.56 },
    });
    expect(math.computeTodayBaseBalance()).toBeCloseTo(1234.56, 2);
  });

  it('falls back to depository − credit from balancesCache', () => {
    math.__setBalancesCacheForTest({
      accounts: [
        { account_type: 'depository', balance_available: 1500 },
        { account_type: 'credit', balance_current: 200 },
      ],
    });
    expect(math.computeTodayBaseBalance()).toBeCloseTo(1300, 2);
  });

  it('prefers wallet over balances fallback', () => {
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 999 },
    });
    math.__setBalancesCacheForTest({
      accounts: [{ account_type: 'depository', balance_available: 50 }],
    });
    expect(math.computeTodayBaseBalance()).toBe(999);
  });
});

// ── computeDayProjection ───────────────────────────────────────────
describe('computeDayProjection', () => {
  it('hasBase=false when no balance source is loaded', () => {
    const out = math.computeDayProjection(new Date(2026, 3, 29));
    expect(out.hasBase).toBe(false);
  });

  it('reproduces Bug 1: $1000 base + $25 plan on Apr 29 → running=$1000, after=$975', () => {
    // The exact case the user reported on the live site. Today is Apr 27,
    // wallet shows $1000 cash, the only scheduled txn is a $25 Self Financial
    // sub on Apr 29. Clicking Apr 29 should display "running balance:
    // $1000.00" (the carry-forward) and "after your plans this day: $975.00".
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 1000 },
    });
    math.__setPrecommitsForTest([
      {
        date: '2026-04-29',
        amount: 25,
        type: 'sub',
        source: 'scheduled',
        name: 'Self Financial',
      },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 29));
    expect(out.hasBase).toBe(true);
    expect(out.runningBalance).toBeCloseTo(1000, 2);
    // Caller computes "after" = running − dayOut + dayIn = 1000 − 25 = 975.
    expect(out.runningBalance - 25).toBeCloseTo(975, 2);
  });

  it('layers in scheduled outflows that fall BETWEEN today and the clicked day', () => {
    // Today=Apr 27, click Apr 30. Scheduled: $50 on Apr 28, $30 on Apr 29.
    // Both fall strictly between today (exclusive) and Apr 30 (exclusive),
    // so the running balance should reflect both: 1000 − 50 − 30 = 920.
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 1000 },
    });
    math.__setPrecommitsForTest([
      { date: '2026-04-28', amount: 50, type: 'sub', source: 'scheduled' },
      { date: '2026-04-29', amount: 30, type: 'sub', source: 'scheduled' },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 30));
    expect(out.runningBalance).toBeCloseTo(920, 2);
  });

  it('does NOT include the clicked day\'s own scheduled txns (they go in "after your plans")', () => {
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 1000 },
    });
    math.__setPrecommitsForTest([
      // This one is ON the clicked day. must be excluded from running.
      { date: '2026-04-29', amount: 200, type: 'sub', source: 'scheduled' },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 29));
    expect(out.runningBalance).toBeCloseTo(1000, 2);
  });

  it('does NOT include today\'s own scheduled txns (already reflected in base)', () => {
    // Today=Apr 27, click Apr 29. Scheduled $40 on Apr 27 (today). wallet
    // already reflects today's settled spend; we don't double-count.
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 1000 },
    });
    math.__setPrecommitsForTest([
      { date: '2026-04-27', amount: 40, type: 'sub', source: 'scheduled' },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 29));
    expect(out.runningBalance).toBeCloseTo(1000, 2);
  });

  it('adds scheduled income between today and clicked day', () => {
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 200 },
    });
    math.__setPrecommitsForTest([
      { date: '2026-04-28', amount: 500, type: 'income', source: 'scheduled' },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 29));
    expect(out.runningBalance).toBeCloseTo(700, 2);
  });

  it('ignores Plaid-source rows entirely (only scheduled count toward projection)', () => {
    // Plaid actuals after today are impossible; on/before today they're
    // already in the base balance. Either way, projection must skip them.
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 1000 },
    });
    math.__setPrecommitsForTest([
      { date: '2026-04-28', amount: 999, type: 'sub', source: 'plaid' },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 29));
    expect(out.runningBalance).toBeCloseTo(1000, 2);
  });

  it('handles a clicked day equal to today: running balance equals today\'s cash', () => {
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 750 },
    });
    math.__setPrecommitsForTest([
      // Future scheduled. irrelevant when clicking today.
      { date: '2026-04-29', amount: 25, type: 'sub', source: 'scheduled' },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 27));
    expect(out.runningBalance).toBeCloseTo(750, 2);
  });

  it('reflects underwater (negative) balances honestly', () => {
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: -100 },
    });
    math.__setPrecommitsForTest([
      { date: '2026-04-28', amount: 50, type: 'sub', source: 'scheduled' },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 29));
    expect(out.runningBalance).toBeCloseTo(-150, 2);
  });

  // ── Phase 10B: acknowledged ("✓ already paid") rows excluded ─────
  //
  // The user's habit when a recurring expense charges early is to delete the
  // future calendar projection. With acknowledge soft-delete, the row stays
  // visible greyed-out as a paid reminder, but it does NOT contribute to
  // the projected running balance. the actual charge will appear in
  // raw_transactions and reduce the balance there.
  it('skips acknowledged scheduled rows in the projection (Phase 10B)', () => {
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 1000 },
    });
    math.__setPrecommitsForTest([
      // Active future scheduled. DOES count toward projection.
      { date: '2026-04-28', amount: 50, type: 'sub', source: 'scheduled' },
      // Acknowledged ("paid") future scheduled. DOES NOT count.
      {
        date: '2026-04-28',
        amount: 200,
        type: 'sub',
        source: 'scheduled',
        acknowledged: true,
      },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 29));
    // 1000 − 50 (active) − 0 (acknowledged skipped) = 950.
    expect(out.runningBalance).toBeCloseTo(950, 2);
  });

  it('a fully-acknowledged set leaves the projection at the base balance', () => {
    math.__setWalletCacheForTest({
      summary: { running_balance_usd: 1000 },
    });
    math.__setPrecommitsForTest([
      {
        date: '2026-04-28',
        amount: 100,
        type: 'sub',
        source: 'scheduled',
        acknowledged: true,
      },
      {
        date: '2026-04-28',
        amount: 50,
        type: 'sub',
        source: 'scheduled',
        acknowledged: true,
      },
    ]);
    const out = math.computeDayProjection(new Date(2026, 3, 29));
    expect(out.runningBalance).toBeCloseTo(1000, 2);
  });
});

// ── formatSignedMoney ─────────────────────────────────────────────
describe('formatSignedMoney', () => {
  it('formats positive whole dollars with $ and 2dp', () => {
    expect(math.formatSignedMoney(25)).toBe('$25.00');
  });

  it('groups thousands with commas', () => {
    expect(math.formatSignedMoney(1234.5)).toBe('$1,234.50');
    expect(math.formatSignedMoney(1234567.89)).toBe('$1,234,567.89');
  });

  it('prefixes negatives with a leading minus', () => {
    expect(math.formatSignedMoney(-42.5)).toBe('-$42.50');
  });

  it('handles zero cleanly', () => {
    expect(math.formatSignedMoney(0)).toBe('$0.00');
  });
});
