// Phase 8.5B — rollover modal removed.
//
// The frontend no longer renders or wires a rollover modal. Even if the
// backend regresses and starts returning items from
// /api/recurring/rollover-prompts, the modal must not appear because:
//   1. The markup is gone from home.html (#rollover-overlay, #rollover-pop).
//   2. home.js has no rollover wiring — variables, functions, and the
//      load-on-boot call are deleted.
//
// Tests run against the static file-server (python3 -m http.server 5173)
// so we can mock /api/me + /api/recurring/* without touching prod.
//
// Calendar STREAM_LINKED: the new 409 contract — when the user trashes a
// scheduled-txn that was projected forward from a recurring stream, the
// backend returns 409 with {error, code: 'STREAM_LINKED', merchant}. The
// frontend renders a friendly inline message + a clickable "open recurring
// tab" link instead of a generic error.

import { test, expect } from '@playwright/test';

const LOCAL_BASE = 'http://localhost:5173';

// Synthetic minimum-viable backend payloads. /api/me + /api/calendar are
// what home.js needs to successfully boot before we can poke at recurring.
const ME_OK = {
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ user_id: 1, phone: '+15555550100', created_at: null }),
};

// Calendar with a single scheduled txn we can click the trash on. The id
// matters because /api/transactions/schedule/:id is the DELETE endpoint we
// mock to 409. Shape mirrors the real API: { expenses: [...] }.
//
// Date is local-time today so the row lands on the .today cell — home.js
// uses Date#getFullYear/Month/Date (not toISOString) for the today match.
const SCHEDULED_ID = 999;
function localTodayIso(): string {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
const TODAY_ISO = localTodayIso();
const CALENDAR_OK = (dateIso: string) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    expenses: [
      {
        id: SCHEDULED_ID,
        date: dateIso,
        amount: 25,
        name: 'Self Financial',
        type: 'sub',
        source: 'scheduled',
        pending: false,
        confidence: 1,
        institution: null,
        mask: null,
        card_account_id: null,
        note: null,
      },
    ],
  }),
});

const EMPTY_JSON = {
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({}),
};

const ROLLOVER_PROMPTS_NONEMPTY = {
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    items: [
      {
        merchant: 'Test',
        forward_due_date: '2026-05-29',
        display_name: 'Test',
        amount: 25,
        cadence_days: 30,
        next_due_date: '2026-04-29',
        linked_scheduled_txn_id: 1,
      },
    ],
  }),
};

async function mockHomeBootEndpoints(page: import('@playwright/test').Page, opts: {
  rolloverItems?: boolean;
  deleteResponse?: { status: number; body: unknown };
} = {}) {
  await page.route('**/api/me', (route) => route.fulfill(ME_OK));
  await page.route('**/api/calendar*', (route) => route.fulfill(CALENDAR_OK(TODAY_ISO)));
  await page.route('**/api/balances*', (route) =>
    route.fulfill({ ...EMPTY_JSON, body: JSON.stringify({ accounts: [], total_in_plaid: 1000, total_owed_plaid: 0 }) }),
  );
  await page.route('**/api/wallet*', (route) =>
    route.fulfill({
      ...EMPTY_JSON,
      body: JSON.stringify({
        plaid_accounts: [],
        tracked_accounts: [],
        summary: {
          running_balance_usd: 1000,
          total_in_plaid: 1000,
          total_owed_plaid: 0,
          total_tracked_usd: 0,
          as_of: new Date().toISOString(),
        },
      }),
    }),
  );
  await page.route('**/api/reimbursements*', (route) =>
    route.fulfill({ ...EMPTY_JSON, body: JSON.stringify({ items: [] }) }),
  );
  await page.route('**/api/recurring/streams*', (route) =>
    route.fulfill({ ...EMPTY_JSON, body: JSON.stringify({ streams: [] }) }),
  );
  await page.route('**/api/recurring/suggestions*', (route) =>
    route.fulfill({ ...EMPTY_JSON, body: JSON.stringify({ suggestions: [] }) }),
  );
  await page.route('**/api/recurring/rollover-prompts*', (route) => {
    if (opts.rolloverItems) {
      route.fulfill(ROLLOVER_PROMPTS_NONEMPTY);
    } else {
      route.fulfill({ ...EMPTY_JSON, body: JSON.stringify({ items: [] }) });
    }
  });
  if (opts.deleteResponse) {
    await page.route(`**/api/transactions/schedule/${SCHEDULED_ID}`, (route) => {
      if (route.request().method() !== 'DELETE') {
        route.fallback();
        return;
      }
      route.fulfill({
        status: opts.deleteResponse.status,
        contentType: 'application/json',
        body: JSON.stringify(opts.deleteResponse.body),
      });
    });
  }
}

test.describe('phase 8.5b · rollover modal removed', () => {
  test('no #rollover-pop / #rollover-overlay markup in home.html', async ({ page }) => {
    // Block boot fetches so the page just renders the static markup. The
    // rollover modal markup either exists or it doesn't — no JS dependency.
    await mockHomeBootEndpoints(page);

    await page.goto(`${LOCAL_BASE}/home.html`);
    await page.waitForLoadState('domcontentloaded');

    // Both the markup and CSS classes should be gone. We assert the
    // selectors return zero matches — Playwright's `count()` is the
    // canonical way to test for absence.
    expect(await page.locator('#rollover-pop').count()).toBe(0);
    expect(await page.locator('#rollover-overlay').count()).toBe(0);
    expect(await page.locator('.rollover-pop').count()).toBe(0);
    expect(await page.locator('.rollover-overlay').count()).toBe(0);
  });

  test('non-empty rollover-prompts response does not produce a modal', async ({ page }) => {
    // Even if the backend regresses and starts returning items, no modal can
    // render because the markup is gone and home.js no longer wires it.
    await mockHomeBootEndpoints(page, { rolloverItems: true });

    await page.goto(`${LOCAL_BASE}/home.html`);
    await page.waitForLoadState('domcontentloaded');
    // Give the boot sequence a moment in case home.js were to lazily fetch
    // and attempt to render — we want to catch any regression where wiring
    // got re-introduced.
    await page.waitForTimeout(1500);

    // No modal of any kind should be visible.
    expect(await page.locator('#rollover-pop').count()).toBe(0);
    expect(await page.locator('#rollover-overlay').count()).toBe(0);

    // The recurring chip should still work — open it and confirm the
    // recurring-pop opens cleanly without a rollover stacked behind it.
    const recurringBtn = page.locator('#recurring-btn');
    await expect(recurringBtn).toBeVisible();
    await recurringBtn.click();
    await expect(page.locator('#recurring-pop')).toHaveClass(/(^|\s)open(\s|$)/);
  });
});

test.describe('phase 8.5b · calendar 409 stream-linked', () => {
  test('trash on a stream-linked row shows friendly message + open-recurring link', async ({ page }) => {
    const STREAM_LINKED_409 = {
      status: 409,
      body: {
        error: 'this row is part of a recurring stream',
        code: 'STREAM_LINKED',
        merchant: 'Self Financial',
      },
    };
    await mockHomeBootEndpoints(page, { deleteResponse: STREAM_LINKED_409 });

    await page.goto(`${LOCAL_BASE}/home.html`);
    await page.waitForLoadState('domcontentloaded');
    // Wait for grid to render with the scheduled txn.
    await expect(page.locator('#grid')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(800); // let calendar paint

    // Open the day popover for today's cell. The scheduled txn should appear
    // there. We click the cell that has a pill matching today's date.
    const todayCell = page.locator('#grid .cell.today').first();
    await todayCell.click();
    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 4000 });

    // Click the trash on the only scheduled row.
    const trash = page.locator('#drawer-list .drawer-item__trash').first();
    await expect(trash).toBeVisible();
    await trash.click();

    // The inline confirm row should now have "delete this? · yes · cancel".
    const confirmYes = page.locator('#drawer-list .row-confirm__yes').first();
    await expect(confirmYes).toBeVisible();
    await confirmYes.click();

    // After the 409, the friendly message should replace the confirm row.
    // We assert on the merchant name + the "open recurring tab" affordance.
    const friendlyRow = page.locator('#drawer-list .row-confirm--stream-linked');
    await expect(friendlyRow).toBeVisible({ timeout: 3000 });
    await expect(friendlyRow).toContainText('Self Financial');
    await expect(friendlyRow).toContainText('recurring stream');

    const openLink = friendlyRow.locator('button', { hasText: 'open recurring tab' });
    await expect(openLink).toBeVisible();

    // Clicking the link opens the recurring panel.
    await openLink.click();
    await expect(page.locator('#recurring-pop')).toHaveClass(/(^|\s)open(\s|$)/, {
      timeout: 4000,
    });
  });
});

test.describe('phase 8.5b · verify.html gate hardening', () => {
  test('authed user is redirected before any OTP fires AND verify button stays disabled', async ({ page }) => {
    // Mock /api/me → 200 (authed).
    await page.route('**/api/me', (route) => route.fulfill(ME_OK));
    // OTP endpoints must NEVER fire for an authed user. We instrument
    // both send + verify so a regression is loud.
    let otpSendFired = false;
    let otpVerifyFired = false;
    await page.route('**/api/otp/send', (route) => {
      otpSendFired = true;
      route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/otp/verify', (route) => {
      otpVerifyFired = true;
      route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/home.html', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>home</body></html>' });
    });

    await page.goto(`${LOCAL_BASE}/verify.html?phone=5555550100`);
    await page.waitForURL('**/home.html', { timeout: 5000 });
    expect(page.url()).toContain('/home.html');
    expect(otpSendFired, 'OTP send must not fire for an authed user').toBe(false);
    expect(otpVerifyFired, 'OTP verify must not fire for an authed user').toBe(false);
  });

  test('verify button is force-disabled until the gate resolves with a 401', async ({ page }) => {
    // Hold /api/me open so the gate stays in flight. Until it resolves the
    // verify button must be disabled even if all 6 OTP digits are filled.
    await page.route('**/api/me', () => {
      // never call route.fulfill() — gate stays pending
    });
    // Block the OTP send so we don't accidentally hit anything.
    await page.route('**/api/otp/send', (route) => {
      route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });

    await page.goto(`${LOCAL_BASE}/verify.html?phone=5555550100`, { waitUntil: 'domcontentloaded' });

    const verifyBtn = page.locator('#verify-btn');
    await expect(verifyBtn).toBeDisabled();
    // Fill all 6 digits — the button must STILL be disabled because the
    // gate hasn't resolved yet.
    const inputs = page.locator('.otp input');
    for (let i = 0; i < 6; i++) {
      await inputs.nth(i).fill(String(i));
    }
    await expect(verifyBtn).toBeDisabled();
  });
});
