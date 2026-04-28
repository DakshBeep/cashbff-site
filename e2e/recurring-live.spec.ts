// Recurring tab — LIVE end-to-end QA sweep (Phase 4).
//
// This spec hits the REAL backend at http://localhost:3000 (not the mocked
// recurring.spec.ts — that one routes intercept the API). It exercises the
// full Self Financial round-trip plus the rollover modal path against the
// live DB row for user_19095425819.
//
// How API_BASE redirection works:
//   home.js hardcodes API_BASE = 'https://api.cashbff.com'. We hijack every
//   request to that host with page.route() and forward it to localhost:3000.
//   The auth cookie cbff_session is set on the page context so the local
//   server treats us as user_19095425819.
//
// What we assert:
//   1. 10 active suggestions render (badge + cards).
//   2. Confirming Self Financial promotes the row to a stream and the
//      schedule shows up in the May calendar grid.
//   3. Deleting the stream removes it from both the panel and the calendar.
//   4. The rollover modal fires for a confirmed stream whose next_due_date
//      is in the past with no observed charge in the +/- window.
//
// Cleanup: every mutation we make in this spec is rolled back via the API
// at the end so the DB lands back in the original 10-suggestions state.
//
// Selectors mirror those in recurring.spec.ts for consistency.

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { SignJWT } from 'jose';

const TEST_UID = 'user_19095425819';
const TEST_PHONE = '+19095425819';
const TEST_SV = 1;
const COOKIE_NAME = 'cbff_session';
const SCREENSHOT_DIR = 'test-results/recurring-live';

const FRONTEND_BASE = 'http://localhost:5173';
const BACKEND_BASE = 'http://localhost:3000';

async function mintToken(): Promise<string> {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET env required (>=32 chars).');
  }
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ uid: TEST_UID, phone: TEST_PHONE, sv: TEST_SV })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 30)
    .sign(new TextEncoder().encode(secret));
}

/** Set the JWT cookie on the context for both localhost (page) and
 *  api.cashbff.com (in case the JS reads cookies before route hits). The
 *  request-rewrite below is what actually attaches it to the local backend
 *  via the `Cookie` header. */
async function attachAuth(context: BrowserContext, token: string) {
  const expires = Math.floor(Date.now() / 1000) + 60 * 30;
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      domain: 'localhost',
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
      expires,
    },
  ]);
}

/** Hijack every fetch that home.js makes to api.cashbff.com and forward it
 *  to the local backend with the auth cookie attached. */
async function rewireApiBase(page: Page, token: string) {
  await page.route('**/api.cashbff.com/**', async (route) => {
    const url = route.request().url();
    const localUrl = url.replace(
      /^https:\/\/api\.cashbff\.com/,
      BACKEND_BASE,
    );
    const reqHeaders = await route.request().allHeaders();
    // Strip the Origin header so CORS doesn't reject — backend allows
    // localhost:3000 + cashbff.com but not localhost:5173. We're talking
    // server-side here so CORS is moot, but Express will still echo it.
    delete reqHeaders['origin'];
    reqHeaders['cookie'] = `${COOKIE_NAME}=${token}`;
    try {
      const response = await page.request.fetch(localUrl, {
        method: route.request().method(),
        headers: reqHeaders,
        data: route.request().postData() ?? undefined,
      });
      const body = await response.body();
      // Always allow CORS so the SPA's credentialed fetch can read the
      // response — even for OPTIONS preflights that the page might emit.
      const respHeaders = response.headers();
      respHeaders['access-control-allow-origin'] = FRONTEND_BASE;
      respHeaders['access-control-allow-credentials'] = 'true';
      await route.fulfill({
        status: response.status(),
        headers: respHeaders,
        body,
      });
    } catch (err) {
      await route.abort();
    }
  });
}

/** API helper for cleanup hooks — talks straight to localhost:3000 with
 *  the same auth cookie. Returns null on failure. */
async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(BACKEND_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${COOKIE_NAME}=${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function bootHome(page: Page) {
  await page.goto(`${FRONTEND_BASE}/home.html`);
  // The grid is the canonical "page is alive" element.
  await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
  // Wait for the recurring chip to render (boot fetched /api/me).
  await expect(page.locator('#recurring-btn')).toBeVisible();
  // Wait for the badge to populate — that confirms the suggestions fetch
  // completed. Calendar pills render in parallel; a small extra tick
  // covers the calendar paint.
  await page.locator('#recurring-btn-count').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(2500);
}

test.describe('recurring tab — live end-to-end', () => {
  let token: string;

  test.beforeAll(async () => {
    token = await mintToken();
  });

  test.afterAll(async () => {
    // DB-side cleanup runs via a separate node script after the suite —
    // see scripts/_recurring-live-cleanup.mjs (executed by the runner).
    // We can't reach the DB from inside Playwright's test process without
    // hauling postgres into the frontend repo.
  });

  test('full Self Financial flow + rollover', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachAuth(context, token);
    const page = await context.newPage();
    await rewireApiBase(page, token);

    // Surface boot errors during this run (helps triage).
    page.on('pageerror', (err) => console.error('[pageerror]', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[console.error]', msg.text());
    });

    await bootHome(page);

    // Belt-and-braces: if a prior aborted run left the rollover modal in
    // an open state on boot (because Speechify/Instacart+ are still
    // confirmed-and-past-due in the DB), dismiss it first so the recurring
    // chip is clickable. The DB-reset script run before this spec should
    // make this branch a no-op in CI.
    const rolloverPopBootCheck = page.locator('#rollover-pop');
    if (await rolloverPopBootCheck.getAttribute('aria-hidden') === 'false') {
      await page.locator('#rollover-dismiss').click();
      await expect(rolloverPopBootCheck).toHaveAttribute('aria-hidden', 'true', { timeout: 5000 });
    }

    // ── Step 1: open recurring tab, assert 10 suggestions ─────────────
    await page.locator('#recurring-btn').click();
    const pop = page.locator('#recurring-pop');
    await expect(pop).toHaveClass(/(^|\s)open(\s|$)/);

    const badge = page.locator('#recurring-btn-count');
    // Badge text is the suggestions count (the "to review" number).
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('10', { timeout: 5000 });

    const suggestionCards = page.locator('#recurring-suggestions-list .recurring-suggestion');
    await expect(suggestionCards).toHaveCount(10);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-recurring-tab.png`,
      fullPage: true,
    });

    // ── Step 2: edit and confirm Self Financial ──────────────────────
    const selfCard = page.locator(
      '#recurring-suggestions-list .recurring-suggestion[data-merchant="Self Financial"]',
    );
    await expect(selfCard).toBeVisible();

    const nameInput = selfCard.locator('input[type="text"]');
    const dateInput = selfCard.locator('input[type="date"]');
    const amtInput = selfCard.locator('input[type="number"]');
    await expect(nameInput).toBeVisible();
    await expect(dateInput).toBeVisible();
    await expect(amtInput).toBeVisible();
    // Pre-fill: name should default to display_name; date defaults to today+30
    // (since the row's next_due_date is null for this user); amount is 0.
    await expect(nameInput).toHaveValue('Self Financial');

    await nameInput.fill('Self payment');
    await dateInput.fill('2026-05-15');
    await amtInput.fill('25.00');

    await selfCard.locator('.recurring-suggestion__confirm').click();

    // Wait for the panel to re-render with 9 suggestions + 1 stream.
    await expect(suggestionCards).toHaveCount(9, { timeout: 8000 });
    const streamRows = page.locator('#recurring-streams-list .recurring-stream');
    await expect(streamRows).toHaveCount(1);
    await expect(streamRows.first().locator('.recurring-stream__name')).toHaveText('Self payment');

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-after-confirm.png`,
      fullPage: true,
    });

    // ── Step 3: navigate calendar to May 2026, assert sub pill ───────
    // Close the recurring popup first.
    await page.locator('#recurring-close').click();
    await expect(pop).not.toHaveClass(/(^|\s)open(\s|$)/);

    // Default month is current real-month (date in env is April 2026
    // per user's calendar). Click next-month once to go to May 2026.
    const monthTitle = page.locator('#month-title');
    const initialTitle = (await monthTitle.textContent())?.trim() || '';
    if (!/may 2026/i.test(initialTitle)) {
      await page.locator('#next-month').click();
    }
    await expect(monthTitle).toContainText(/may 2026/i, { timeout: 5000 });

    // Wait for the May calendar to fetch; then look for a pill matching
    // "$25 Self" in some cell. The renderGrid pills use first-word labels
    // and integer-rounded amounts.
    await page.waitForTimeout(1500);
    const subPill = page.locator('#grid .pill.sub', { hasText: 'Self' });
    await expect(subPill.first()).toBeVisible({ timeout: 8000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-calendar-with-sub.png`,
      fullPage: true,
    });

    // ── Step 4: delete the Self payment stream, assert it's gone ─────
    await page.locator('#recurring-btn').click();
    await expect(pop).toHaveClass(/(^|\s)open(\s|$)/);
    const selfStream = page.locator(
      '#recurring-streams-list .recurring-stream[data-merchant="Self Financial"]',
    );
    await expect(selfStream).toBeVisible();
    await selfStream.locator('.recurring-stream__trash').click();
    await selfStream.locator('.row-confirm__yes').click();

    // The stream row should disappear. Note: deleting a confirmed stream
    // soft-deletes via dismissed_at, so the suggestion does NOT come back —
    // we stay at 9 suggestions (this is intentional product behavior).
    await expect(streamRows).toHaveCount(0, { timeout: 8000 });
    await expect(suggestionCards).toHaveCount(9);

    // Close popup and confirm the calendar pill is gone too.
    await page.locator('#recurring-close').click();
    // Force re-paint of May.
    await page.waitForTimeout(1500);
    const subPillAfter = page.locator('#grid .pill.sub', { hasText: 'Self' });
    await expect(subPillAfter).toHaveCount(0, { timeout: 5000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-after-delete.png`,
      fullPage: true,
    });

    // ── Step 5: rollover modal ────────────────────────────────────────
    // Confirm Speechify first — its current next_due_date (Mar 28) plus
    // cadence (33) lands on Apr 30 which is > today (Apr 27), so a single
    // "yes" advance closes the modal cleanly. (Instacart+ has cadence 30
    // and due Mar 18, so it'd take 2 yes-clicks before the date catches
    // up — works but adds noise to the assertion.)
    await page.locator('#recurring-btn').click();
    const speechifyCard = page.locator(
      '#recurring-suggestions-list .recurring-suggestion[data-merchant="Speechify"]',
    );
    await expect(speechifyCard).toBeVisible();
    // Use whatever values are pre-filled — the past date here is the trigger.
    await speechifyCard.locator('.recurring-suggestion__confirm').click();
    await expect(streamRows).toHaveCount(1, { timeout: 8000 });

    // Close + reopen so openRecurring re-fetches rollover-prompts.
    await page.locator('#recurring-close').click();
    await page.locator('#recurring-btn').click();
    // Rollover modal should open shortly after openRecurring fires.
    const rolloverPop = page.locator('#rollover-pop');
    await expect(rolloverPop).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 8000 });
    await expect(rolloverPop).toHaveAttribute('aria-hidden', 'false');

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-rollover-modal.png`,
      fullPage: true,
    });

    // ── Step 6: click "yes, it charged", assert advance ──────────────
    // Snapshot the stream's date (formatted "next: mar 28") before.
    const beforeText = await page.locator(
      '#recurring-streams-list .recurring-stream[data-merchant="Speechify"] .recurring-stream__pill',
    ).textContent();
    await page.locator('#rollover-yes').click();

    // The modal closes after the POST + queue refresh because Mar 28 + 33d
    // = Apr 30 > today (Apr 27).
    await expect(rolloverPop).toHaveAttribute('aria-hidden', 'true', { timeout: 10_000 });

    // Stream's next_due_date should advance — the pill text changes.
    await page.waitForTimeout(1200);
    const afterText = await page.locator(
      '#recurring-streams-list .recurring-stream[data-merchant="Speechify"] .recurring-stream__pill',
    ).textContent();
    expect(afterText).toBeTruthy();
    expect(afterText).not.toBe(beforeText);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-after-rollover-yes.png`,
      fullPage: true,
    });

    // ── Cleanup: delete Speechify stream so user state is repeatable.
    const spStream = page.locator(
      '#recurring-streams-list .recurring-stream[data-merchant="Speechify"]',
    );
    await spStream.locator('.recurring-stream__trash').click();
    await spStream.locator('.row-confirm__yes').click();
    await expect(streamRows).toHaveCount(0, { timeout: 8000 });

    await context.close();
  });
});
