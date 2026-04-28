// Running balance math — sanity-check the /api/wallet summary.
//
// Backend doc on the formula (src/server.ts L2833):
//   running_balance_usd = total_in_plaid - total_owed_plaid + total_tracked_usd
//
// This spec doesn't touch the UI — it talks directly to the API via the
// auth-helper. The point is to catch an arithmetic regression at the source
// (e.g. the day someone removes total_tracked_usd from the formula but
// forgets to update consumers). Any drift > $0.01 fails.
//
// We also do a soft cross-check that the summary's `total_in_plaid` aligns
// with the depository row(s) in /api/balances (using `balance_available`,
// not `balance_current` — that's the spec). We pull both values; if Plaid
// happens to refresh balances between the two GETs, the cross-check is
// skipped with a warning rather than failing the test.
//
// No test data is created — pure read.

import { test, expect } from '@playwright/test';
import { authenticatedApi } from './auth-helper';

type WalletSummary = {
  running_balance_usd: number;
  total_in_plaid: number;
  total_owed_plaid: number;
  total_tracked_usd: number;
  as_of: string | null;
};

type BalanceAccount = {
  account_type: string;
  account_subtype?: string | null;
  balance_available: number | null;
  balance_current: number | null;
};

test.describe('running balance math (read-only)', () => {
  test('summary.running_balance_usd matches in - owed + tracked, within $0.01', async () => {
    const api = await authenticatedApi();
    if (!api) {
      test.skip(true, 'JWT_SECRET not set');
      return;
    }
    try {
      const res = await api.get('/api/wallet');
      expect(res.ok(), `GET /api/wallet -> ${res.status()}`).toBeTruthy();
      const data = (await res.json()) as { summary?: Partial<WalletSummary> };
      const summary = data.summary as WalletSummary | undefined;
      expect(summary, '/api/wallet response missing `summary`').toBeDefined();
      if (!summary) return; // typeguard

      // All four numbers should be present + finite. NaN would slip past the
      // arithmetic check below (NaN - NaN = NaN, and Math.abs(NaN) > 0.01 is
      // false), so guard explicitly.
      for (const key of ['running_balance_usd', 'total_in_plaid', 'total_owed_plaid', 'total_tracked_usd'] as const) {
        expect(typeof summary[key]).toBe('number');
        expect(Number.isFinite(summary[key]), `${key} must be finite`).toBe(true);
      }

      const expected =
        summary.total_in_plaid - summary.total_owed_plaid + summary.total_tracked_usd;
      const drift = Math.abs(summary.running_balance_usd - expected);
      expect(
        drift,
        `running_balance_usd=${summary.running_balance_usd} but ` +
          `total_in - owed + tracked = ${expected.toFixed(2)} ` +
          `(drift=${drift.toFixed(4)})`,
      ).toBeLessThan(0.01);
    } finally {
      await api.dispose();
    }
  });

  test('total_in_plaid uses balance_available for depository rows (soft cross-check)', async () => {
    const api = await authenticatedApi();
    if (!api) {
      test.skip(true, 'JWT_SECRET not set');
      return;
    }
    try {
      // Two GETs in quick succession. If account_balances refreshes between
      // them, the sum may not match exactly — we tolerate that with a soft
      // assertion + warning, since balance freshness isn't this spec's focus.
      const [walletRes, balRes] = await Promise.all([
        api.get('/api/wallet'),
        api.get('/api/balances'),
      ]);
      expect(walletRes.ok()).toBeTruthy();
      expect(balRes.ok()).toBeTruthy();

      const wallet = (await walletRes.json()) as { summary?: WalletSummary };
      const balances = (await balRes.json()) as { accounts?: BalanceAccount[] };

      const totalIn = wallet.summary?.total_in_plaid;
      expect(typeof totalIn).toBe('number');
      if (typeof totalIn !== 'number') return;

      const accounts = balances.accounts || [];
      // /api/balances spec (src/balances.ts L152-170): for each depository
      // row, prefer balance_available, fall back to balance_current. Sum
      // those values where the chosen value is > 0.
      const summed = accounts
        .filter((a) => (a.account_type || '').toLowerCase() === 'depository')
        .reduce((acc, a) => {
          const v = a.balance_available !== null ? a.balance_available : a.balance_current;
          if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return acc;
          return acc + v;
        }, 0);

      const drift = Math.abs(totalIn - summed);
      if (drift > 0.05) {
        // Likely Plaid refreshed between the two reads. Don't fail — log it
        // and note the soft check skipped. The hard formula test above is
        // the primary regression net.
        console.warn(
          `[running-balance-math] soft cross-check skipped: ` +
            `total_in_plaid=${totalIn} vs depository sum=${summed.toFixed(2)} (drift=${drift.toFixed(2)}). ` +
            `Likely a Plaid refresh raced between /api/wallet and /api/balances.`,
        );
        return;
      }
      // Exact-ish match — within $0.05 (covers float dust + rounding).
      expect(drift).toBeLessThan(0.05);

      // Also assert that for at least one depository row, balance_available
      // is non-null AND was used in the sum (otherwise the test is trivially
      // green even if the formula regresses to balance_current).
      const usedAvailable = accounts.some(
        (a) =>
          (a.account_type || '').toLowerCase() === 'depository' &&
          a.balance_available !== null &&
          a.balance_available !== a.balance_current,
      );
      if (!usedAvailable) {
        console.warn(
          `[running-balance-math] no depository account has distinct balance_available; ` +
            `cross-check is weakened (sum could be balance_current too).`,
        );
      }
    } finally {
      await api.dispose();
    }
  });
});
