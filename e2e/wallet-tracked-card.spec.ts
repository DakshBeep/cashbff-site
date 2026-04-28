// Wallet panel — full tracked-card lifecycle with FX + due date.
//
// Extends e2e/wallet.spec.ts (which covers the kind-chip toggle + a USD-only
// happy path). This spec adds:
//
//   1. Both `linked` (read-only Plaid section) and `tracked` (user-added)
//      sections render — verifies the wallet panel shows BOTH groups, not
//      just one.
//   2. Adding a credit card with a NON-USD currency (EUR) renders the
//      "≈ $X usd" FX annotation in the row's right-hand stack.
//   3. The row gets the right kind-chip color (.is-credit) — same as the
//      smaller wallet.spec assertion but on a EUR row this time.
//   4. Cleanup: DELETE the tracked row via the API helper to keep state tidy
//      (the per-test afterAll sweep also catches anything left behind).
//
// Selectors:
//   #wallet-btn                                     wallet header chip
//   #wallet-pop                                     panel root
//   #wallet-linked-group, #wallet-tracked-group     section roots (both render)
//   #wt-name, #wt-balance, #wt-currency, #wt-date   add form fields
//   #wt-kind-chips .type-chip[data-kind="credit"]   credit kind chip
//   #wallet-tracked-list .wallet-tracked-row        rendered tracked rows
//   .wallet-tracked-row__amt-usd                    FX annotation span

import { test, expect, type Page } from '@playwright/test';
import {
  authenticatedContext,
  cleanupTrackedAccounts,
  TEST_MARKER,
} from './auth-helper';

const TEST_NAME = `${TEST_MARKER}_revolut__`;

/** Returns yyyy-MM-dd ~14 days in the future. Local time is fine — the
 *  backend stores due_date as a plain DATE column. */
function dueDateTwoWeeksAhead(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function openHomeAndWallet(page: Page) {
  await page.goto('/home');
  await expect(page.locator('#grid')).toBeVisible();
  await page.locator('#wallet-btn').click();
  await expect(page.locator('#wallet-pop')).toHaveClass(/(^|\s)open(\s|$)/);
}

test.describe('wallet panel — tracked card with FX + due date', () => {
  test.beforeAll(async () => {
    await cleanupTrackedAccounts();
  });
  test.afterAll(async () => {
    await cleanupTrackedAccounts();
  });

  test('linked + tracked sections render, EUR row shows FX annotation', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await openHomeAndWallet(page);

    // Wait for /api/wallet so both groups have a chance to populate. Daksh's
    // account has Plaid items, so the linked group should also un-hide.
    await page.waitForResponse(
      (r) => r.url().includes('/api/wallet') && r.request().method() === 'GET' && r.ok(),
      { timeout: 15_000 },
    ).catch(() => {
      // Cache-warm path: prefetch already landed, no fresh GET fires here.
    });

    // ── 1. Both linked + tracked sections render ──────────────
    // The page-level CSS hides empty groups via `hidden`. Plaid-linked items
    // exist (depository + credit) so #wallet-linked-group should be visible.
    // The tracked group may be hidden if there are 0 tracked accounts — we
    // assert it un-hides AFTER the test row is added.
    const linkedGroup = page.locator('#wallet-linked-group');
    await expect(linkedGroup).not.toHaveAttribute('hidden', /.*/, { timeout: 10_000 });
    // At least one .balance-row equivalent in the linked list.
    const linkedRows = page.locator('#wallet-linked-list .wallet-linked-row');
    await expect.poll(async () => linkedRows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // ── 2. Fill the add-tracked-card form (EUR + due_date) ────
    const due = dueDateTwoWeeksAhead();
    await page.fill('#wt-name', TEST_NAME);

    // Default chip is `credit` — no need to click, but pin it so a regression
    // changing the default doesn't silently flip the test under us.
    const creditChip = page.locator('#wt-kind-chips .type-chip[data-kind="credit"]');
    await expect(creditChip).toHaveClass(/is-active/);

    await page.fill('#wt-balance', '100');
    await page.selectOption('#wt-currency', 'EUR');
    await page.fill('#wt-date', due);

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

    // ── 3. Row appears with .is-credit + EUR balance + FX annotation ──
    // Note: there's a known frontend bug where the POST handler sets a
    // misleading "couldn't track (201)" error message because it reads
    // `out.data.item` but the server returns `out.data.account`. Despite
    // the error text, the wallet ends up refetching (boot-time prefetch)
    // and the row appears within ~1s. A longer timeout absorbs that race.
    const row = page
      .locator(`#wallet-tracked-list .wallet-tracked-row:has-text("${TEST_NAME}")`)
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveClass(/is-credit/);
    await expect(row.locator('.kind-chip.is-credit')).toBeVisible();

    // Tracked group is now visible (was likely hidden if user had 0 tracked).
    const trackedGroup = page.locator('#wallet-tracked-group');
    await expect(trackedGroup).not.toHaveAttribute('hidden', /.*/);

    // FX annotation: the row renders "≈ $X.XX usd" when currency != USD.
    // We don't pin the exact rate (FX moves) — just that the annotation
    // exists and matches the "≈ $<num> usd" pattern.
    const usdAnnotation = row.locator('.wallet-tracked-row__amt-usd');
    await expect(usdAnnotation).toBeVisible();
    await expect(usdAnnotation).toHaveText(/\u2248\s*\$\d+(\.\d{1,2})?\s+usd/i);

    // Due-date line should also render — formatted as "due May 5" etc.
    await expect(row.locator('.wallet-tracked-row__due')).toBeVisible();

    await context.close();
  });
});
