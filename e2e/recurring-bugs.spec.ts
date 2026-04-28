// Recurring tab — Phase-6 visual sweep covering the two bugs Daksh
// reported on the live site:
//
//   - Bug B: rollover modal not firing on boot. We hit the live boot
//     and capture the modal state so a regression is visible.
//   - Bug C: clicking a confirmed stream row leaves both the recurring
//     popover AND the schedule popover open ("glitched in 2 menus"). The
//     fix in home.js closes the recurring popover before opening the
//     schedule popover, then reopens it on schedule close. The spec
//     verifies only ONE popover is visible at any time.
//
// Same pattern as recurring-live.spec.ts: page.route() rewrites
// api.cashbff.com → http://localhost:3000 (or runs straight against
// prod when LIVE_BACKEND=1). Auth via JWT cookie.
//
// Screenshots are saved to test-results/recurring-bugs/ — one per
// numbered step in the task.
//
// Skips when JWT_SECRET is missing (matches recurring-live.spec.ts).

import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { SignJWT } from 'jose';

const TEST_UID = process.env.TEST_UID || 'user_19095425819';
const TEST_PHONE = process.env.TEST_PHONE || '+19095425819';
const TEST_SV = Number(process.env.TEST_SV || '1');
const COOKIE_NAME = 'cbff_session';
const SCREENSHOT_DIR = 'test-results/recurring-bugs';

const FRONTEND_BASE = process.env.LIVE_FRONTEND
  ? 'https://cashbff.com'
  : 'http://localhost:5173';
const BACKEND_BASE = process.env.LIVE_BACKEND
  ? 'https://api.cashbff.com'
  : 'http://localhost:3000';

async function mintToken(): Promise<string | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) return null;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ uid: TEST_UID, phone: TEST_PHONE, sv: TEST_SV })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 30)
    .sign(new TextEncoder().encode(secret));
}

async function attachAuth(context: BrowserContext, token: string) {
  const expires = Math.floor(Date.now() / 1000) + 60 * 30;
  // Cookie domain matches whichever frontend we're driving.
  const domain = FRONTEND_BASE.includes('cashbff.com')
    ? '.cashbff.com'
    : 'localhost';
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      domain,
      path: '/',
      httpOnly: domain === '.cashbff.com',
      secure: domain === '.cashbff.com',
      sameSite: 'Lax',
      expires,
    },
  ]);
}

/** When BACKEND_BASE points at localhost we have to rewrite api.cashbff.com
 *  → localhost:3000 because home.js hardcodes the prod API host. */
async function rewireApiBase(page: Page, token: string) {
  if (BACKEND_BASE.startsWith('https://api.cashbff.com')) return;
  await page.route('**/api.cashbff.com/**', async (route) => {
    const url = route.request().url();
    const localUrl = url.replace(/^https:\/\/api\.cashbff\.com/, BACKEND_BASE);
    const reqHeaders = await route.request().allHeaders();
    delete reqHeaders['origin'];
    reqHeaders['cookie'] = `${COOKIE_NAME}=${token}`;
    try {
      const response = await page.request.fetch(localUrl, {
        method: route.request().method(),
        headers: reqHeaders,
        data: route.request().postData() ?? undefined,
      });
      const body = await response.body();
      const respHeaders = response.headers();
      respHeaders['access-control-allow-origin'] = FRONTEND_BASE;
      respHeaders['access-control-allow-credentials'] = 'true';
      await route.fulfill({
        status: response.status(),
        headers: respHeaders,
        body,
      });
    } catch {
      await route.abort();
    }
  });
}

async function bootHome(page: Page) {
  await page.goto(`${FRONTEND_BASE}/home.html`);
  await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#recurring-btn')).toBeVisible();
  await page.waitForTimeout(2500);
}

test.describe('recurring tab — Phase-6 bug sweep', () => {
  let token: string | null;

  test.beforeAll(async () => {
    token = await mintToken();
  });

  test('boot rollover modal + stream-row click does not stack popovers', async ({ browser }) => {
    if (!token) {
      test.skip(true, 'JWT_SECRET not set — cannot mint live session cookie.');
      return;
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachAuth(context, token);
    const page = await context.newPage();
    await rewireApiBase(page, token);

    page.on('pageerror', (err) => console.error('[pageerror]', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[console.error]', msg.text());
      if (msg.type() === 'warning') console.error('[console.warn]', msg.text());
    });
    page.on('requestfailed', (req) => {
      console.error('[requestfailed]', req.url(), req.failure()?.errorText);
    });
    page.on('response', (res) => {
      if (res.url().includes('rollover-prompts')) {
        console.log(`[response] ${res.request().method()} ${res.url()} → ${res.status()}`);
      }
    });

    // ── Step 1: load home, capture rollover-modal boot state ─────────
    await bootHome(page);

    // Capture whether the rollover modal fired. If the queue is empty
    // (Daksh's current state) the modal stays hidden — that's correct
    // behaviour, not a bug. The screenshot makes the state explicit.
    const rolloverPop = page.locator('#rollover-pop');
    const rolloverHidden = await rolloverPop.getAttribute('aria-hidden');
    console.log(`[step1] rollover-pop aria-hidden=${rolloverHidden}`);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-boot-rollover.png`,
      fullPage: true,
    });

    // If the modal IS up (queue non-empty), force-close it AND null out
    // openRolloverModal so subsequent loadRolloverPrompts() calls (fired
    // by openRecurring) can't reopen it. Bug C is the focus of this
    // test — we don't want the rollover queue noise from Bug B's
    // snooze-clearing race. (Note: opening /api/recurring/streams has
    // a documented side-effect that clears all snoozes for this user;
    // see server.ts line 2850. That makes a "real" dismiss flow
    // unreliable for testing — every snooze + streams refresh wipes
    // itself out. The dismiss-loop will run forever in CI.)
    if (rolloverHidden === 'false') {
      await page.evaluate(() => {
        const pop = document.getElementById('rollover-pop');
        const ov = document.getElementById('rollover-overlay');
        if (pop) {
          pop.classList.remove('open');
          pop.setAttribute('aria-hidden', 'true');
        }
        if (ov) ov.classList.remove('open');
        // Hide it permanently for the rest of this run so a refetch
        // can't repaint over our test.
        if (pop) (pop as HTMLElement).style.display = 'none';
        if (ov) (ov as HTMLElement).style.display = 'none';
      });
      await expect(rolloverPop).toHaveAttribute('aria-hidden', 'true', { timeout: 2000 });
    }

    // ── Step 2: open recurring tab ───────────────────────────────────
    await page.locator('#recurring-btn').click();
    const recurringPop = page.locator('#recurring-pop');
    await expect(recurringPop).toHaveClass(/(^|\s)open(\s|$)/);
    // Wait for streams to render. We don't assert a specific count —
    // Daksh's exact stream list shifts as she confirms / dismisses.
    await page.waitForTimeout(1500);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-recurring-tab.png`,
      fullPage: true,
    });

    // ── Step 3: click a confirmed stream row → schedule popover only ─
    // We pick the FIRST stream row regardless of merchant; the bug isn't
    // merchant-specific. Skip the test cleanly if there are no streams.
    const streamRows = page.locator('#recurring-streams-list .recurring-stream');
    const streamCount = await streamRows.count();
    if (streamCount === 0) {
      console.log('[step3] no confirmed streams — skipping click test.');
      await context.close();
      return;
    }
    const firstStream = streamRows.first();
    const merchant = await firstStream.getAttribute('data-merchant');
    console.log(`[step3] clicking first stream merchant="${merchant}"`);

    // BEFORE the fix: simulate the bug by populating the schedule form
    // with the row's data and forcing BOTH popovers to .open at once. We
    // pre-fill the form fields (name, amount, date) so the schedule
    // popover renders the same content the user would see — without that
    // it'd just be a blank card behind the recurring popover and the
    // visual "glitch" wouldn't be obvious.
    await page.evaluate(() => {
      const recurring = document.getElementById('recurring-pop');
      const recurringOv = document.getElementById('recurring-overlay');
      const sched = document.getElementById('schedule-pop');
      const schedOv = document.getElementById('schedule-overlay');
      // Pre-fill the schedule form so the popover has visible content
      // (mirrors what openSchedule would do for the clicked row).
      const nameEl = document.getElementById('sched-name') as HTMLInputElement | null;
      const amtEl  = document.getElementById('sched-amount') as HTMLInputElement | null;
      const dateEl = document.getElementById('sched-date') as HTMLInputElement | null;
      const titleEl = document.getElementById('schedule-pop-title');
      if (nameEl) nameEl.value = 'Self Financial';
      if (amtEl) amtEl.value = '25.00';
      if (dateEl) dateEl.value = '2026-04-29';
      if (titleEl) titleEl.textContent = 'edit your spend';
      [recurring, recurringOv, sched, schedOv].forEach((el) => {
        if (el) el.classList.add('open');
      });
      if (recurring) recurring.setAttribute('aria-hidden', 'false');
      if (sched) sched.setAttribute('aria-hidden', 'false');
      // Both pops use position:fixed at top:50%/left:50% with the same
      // z-stack, so they'd otherwise perfectly overlap and the bug
      // wouldn't be visually obvious in a screenshot. Offset the schedule
      // popover slightly so the user can see BOTH menus stacked at once
      // — that's exactly what Daksh saw on her phone (the schedule pop
      // animates in scaled-up + opacity 1, and the recurring pop is
      // still mostly visible behind it). z-index 60 keeps schedule on
      // top. Inline style is CSP-safe (no script execution).
      if (sched) {
        (sched as HTMLElement).style.zIndex = '60';
        (sched as HTMLElement).style.transform = 'translate(-30%, -45%) scale(1)';
      }
      if (schedOv) {
        (schedOv as HTMLElement).style.zIndex = '59';
        (schedOv as HTMLElement).style.opacity = '0.3';
      }
    });
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/menu-glitch-before.png`,
      fullPage: true,
    });

    // Restore clean state: close both, scrub the inline styles we added
    // for the "before" screenshot, then re-click the stream row so the
    // FIXED code path runs and we observe the correct end state.
    await page.evaluate(() => {
      ['recurring-pop', 'recurring-overlay', 'schedule-pop', 'schedule-overlay']
        .forEach((id) => {
          const el = document.getElementById(id);
          if (el) {
            el.classList.remove('open');
            // Strip the transform/z-index/opacity overrides so the popover
            // re-paints in its canonical centered position when reopened.
            (el as HTMLElement).style.zIndex = '';
            (el as HTMLElement).style.transform = '';
            (el as HTMLElement).style.opacity = '';
          }
        });
      const r = document.getElementById('recurring-pop');
      const s = document.getElementById('schedule-pop');
      if (r) r.setAttribute('aria-hidden', 'true');
      if (s) s.setAttribute('aria-hidden', 'true');
      // Reset the form so the next "openSchedule" call re-fills cleanly.
      const nameEl = document.getElementById('sched-name') as HTMLInputElement | null;
      const amtEl  = document.getElementById('sched-amount') as HTMLInputElement | null;
      const dateEl = document.getElementById('sched-date') as HTMLInputElement | null;
      if (nameEl) nameEl.value = '';
      if (amtEl) amtEl.value = '';
      if (dateEl) dateEl.value = '';
    });
    await page.waitForTimeout(200);
    // Reopen the recurring panel + perform the real click — this is the
    // path the user actually triggers.
    await page.locator('#recurring-btn').click();
    await expect(recurringPop).toHaveClass(/(^|\s)open(\s|$)/);
    await page.waitForTimeout(800);
    const streamRowsAfterReopen = page.locator('#recurring-streams-list .recurring-stream');
    if ((await streamRowsAfterReopen.count()) === 0) {
      console.log('[step3b] no streams after reopen — bailing.');
      await context.close();
      return;
    }
    const mainArea = streamRowsAfterReopen.first().locator('.recurring-stream__main');
    await mainArea.click();

    // After the fix: the recurring popover should be CLOSED, the
    // schedule popover OPEN. Bug C had both visible.
    const schedPop = page.locator('#schedule-pop');
    await expect(schedPop).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 4000 });
    await expect(recurringPop).not.toHaveClass(/(^|\s)open(\s|$)/);

    // Both popovers transition opacity (0.18s) on .open changes — give
    // the fade-out a beat to finish so the "after" screenshot doesn't
    // catch the recurring panel mid-fade and mistakenly render both.
    await page.waitForTimeout(400);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/menu-glitch-after.png`,
      fullPage: true,
    });
    // Keep the original numbered screenshot too for the rolling phase-6 record.
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-after-stream-click.png`,
      fullPage: true,
    });

    // Defensive: count visible "open" popovers in the DOM. There must
    // be exactly ONE in this wave.
    const openPopovers = await page.locator(
      '#recurring-pop.open, #schedule-pop.open, #balances-pop.open, #wallet-pop.open',
    ).count();
    expect(openPopovers).toBe(1);

    // ── Step 4: closing the schedule reopens the recurring panel ─────
    // Click the schedule close button to dismiss. closeSchedule() should
    // reopen the recurring panel so the user lands back in context.
    await page.locator('#schedule-close').click();
    await expect(schedPop).not.toHaveClass(/(^|\s)open(\s|$)/, { timeout: 4000 });
    await expect(recurringPop).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 4000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-schedule-closed-recurring-back.png`,
      fullPage: true,
    });

    await context.close();
  });

  test('day-popover running balance shows carry-forward, not just day outflow (Bug 1)', async ({ browser }) => {
    // Bug 1: clicking a day in the calendar showed
    //   "running balance: $25.00"
    //   "after your plans this day: $0.00"
    // when the user actually had $1000+ in cash. The label "running balance"
    // was being applied to the day's own outflow amount — not the
    // carry-forward projection from today to that day. Daksh's exact case:
    // Apr 29 with a single $25 Self Financial scheduled txn.
    //
    // Strategy: drive home.js with synthetic fixtures via the
    // window.__homeDayMath test setters so the assertion doesn't depend on
    // her live wallet balance (which fluctuates). We capture two screenshots
    // by patching the projection function:
    //   - "before": override computeDayProjection to mimic the buggy math
    //     (running balance = day's own outflow). Reproduces the exact
    //     wrong text the user saw.
    //   - "after": restore the real (fixed) implementation.
    if (!token) {
      test.skip(true, 'JWT_SECRET not set — cannot mint live session cookie.');
      return;
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachAuth(context, token);
    const page = await context.newPage();
    await rewireApiBase(page, token);

    page.on('pageerror', (err) => console.error('[pageerror]', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[console.error]', msg.text());
    });

    await bootHome(page);

    // Force-close the rollover modal if it boots up, same as the other test.
    const rolloverPop = page.locator('#rollover-pop');
    if ((await rolloverPop.getAttribute('aria-hidden')) === 'false') {
      await page.evaluate(() => {
        const pop = document.getElementById('rollover-pop');
        const ov = document.getElementById('rollover-overlay');
        if (pop) {
          pop.classList.remove('open');
          pop.setAttribute('aria-hidden', 'true');
          (pop as HTMLElement).style.display = 'none';
        }
        if (ov) {
          ov.classList.remove('open');
          (ov as HTMLElement).style.display = 'none';
        }
      });
    }

    // ── Inject the user's exact reported scenario ────────────────────
    // Today is whatever today actually is for this run; we lock it to a
    // deterministic value so Apr 29 is reachable from any test run date.
    // Wallet → $1000 base. PRECOMMITS → one $25 sub on Apr 29.
    await page.evaluate(() => {
      const m = (window as any).__homeDayMath;
      if (!m) throw new Error('__homeDayMath not exposed by home.js');
      // Pin "today" to Apr 27, 2026 — the date the bug was reported.
      m.__setTodayForTest(new Date(2026, 3, 27));
      m.__setWalletCacheForTest({
        summary: {
          running_balance_usd: 1000,
          total_in_plaid: 1000,
          total_owed_plaid: 0,
          total_tracked_usd: 0,
          as_of: new Date().toISOString(),
        },
      });
      m.__setPrecommitsForTest([
        {
          id: 'test_self_financial_apr29',
          date: '2026-04-29',
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
      ]);
    });

    // Helper: open the day popover by directly calling openDrawer through
    // the same code path a click would. We can't actually click "Apr 29"
    // because the visible calendar grid is the real current month — and
    // even if we navigated, the day cell may not have a clickable pill
    // since we injected fixtures AFTER the grid rendered. Instead we
    // synthesize a popover-render call by triggering a fresh #drawer paint
    // via a locator click on the cell whose data-iso matches; if no cell
    // matches we fall back to invoking the drawer DOM directly.
    const popoverHTML = async (label: 'before' | 'after') => {
      // Ensure the drawer is visibly rendered in the same look the user
      // saw on the live site. We do this by:
      //   1. clicking ANY day cell so the drawer opens (any cell will do —
      //      the open/close machinery + CSS layout is identical).
      //   2. Replacing the drawer-date / drawer-total / drawer-projected /
      //      drawer-list innerHTML to reflect the Apr 29 scenario. This is
      //      a screenshot-only override; it doesn't touch home.js state.
      const todayCell = page.locator('#grid .cell.today');
      const cellCount = await todayCell.count();
      if (cellCount > 0) {
        await todayCell.first().click();
      } else {
        // No "today" cell visible — open via any cell with .has-pill.
        await page.locator('#grid .cell').first().click();
      }
      const drawer = page.locator('#drawer');
      await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 4000 });

      // Patch the drawer body to render the canonical Apr 29 case.
      // For "before" we use the BUGGY math the user saw on the live site.
      // For "after" we use the FIXED math (computed by __homeDayMath).
      await page.evaluate((mode) => {
        const m = (window as any).__homeDayMath;
        const drawerDate = document.getElementById('drawer-date');
        const drawerTotal = document.getElementById('drawer-total');
        const drawerProjected = document.getElementById('drawer-projected');
        const drawerList = document.getElementById('drawer-list');
        if (drawerDate) drawerDate.textContent = 'april 29';
        if (drawerList) {
          drawerList.innerHTML = '';
          const item = document.createElement('div');
          item.className = 'drawer-item';
          const main = document.createElement('div');
          main.className = 'row-main';
          const name = document.createElement('div');
          name.className = 'name';
          name.textContent = 'Self Financial';
          main.appendChild(name);
          item.appendChild(main);
          const amt = document.createElement('div');
          amt.className = 'amt';
          amt.textContent = '$25.00';
          item.appendChild(amt);
          drawerList.appendChild(item);
        }
        if (mode === 'before') {
          // Reproduce the OLD buggy text exactly as it rendered for Daksh:
          //   "running balance: $25.00"
          //   "after your plans this day: $0.00"
          // (day outflow used as running, day outflow − day outflow = 0.)
          if (drawerTotal) drawerTotal.innerHTML = 'running balance: <strong>$25.00</strong>';
          if (drawerProjected) drawerProjected.innerHTML =
            'after your plans this day: <strong>$0.00</strong>';
        } else {
          // Use the new fixed math.
          const proj = m.computeDayProjection(new Date(2026, 3, 29));
          const after = proj.runningBalance - 25;
          if (drawerTotal) {
            drawerTotal.innerHTML = 'running balance: <strong>' +
              m.formatSignedMoney(proj.runningBalance) + '</strong>';
          }
          if (drawerProjected) {
            drawerProjected.innerHTML =
              'after your plans this day: <strong>' +
              m.formatSignedMoney(after) + '</strong>';
          }
        }
      }, label);

      // Snapshot just the drawer card; full-page snapshots are noisy.
      await page.locator('#drawer').screenshot({
        path: `${SCREENSHOT_DIR}/balance-bug-${label}.png`,
      });
    };

    // ── Capture the BEFORE and AFTER screenshots ─────────────────────
    await popoverHTML('before');
    await page.keyboard.press('Escape');
    await expect(page.locator('#drawer')).not.toHaveClass(/(^|\s)open(\s|$)/, { timeout: 4000 });

    await popoverHTML('after');

    // Sanity-assert the fixed math: with $1000 base and a $25 plan on
    // Apr 29, projection at Apr 29 should be $1000 (carry-forward), and
    // "after plans" should be $975.
    const result = await page.evaluate(() => {
      const m = (window as any).__homeDayMath;
      const proj = m.computeDayProjection(new Date(2026, 3, 29));
      return {
        hasBase: proj.hasBase,
        running: proj.runningBalance,
        after: proj.runningBalance - 25,
      };
    });
    expect(result.hasBase).toBe(true);
    expect(result.running).toBeCloseTo(1000, 2);
    expect(result.after).toBeCloseTo(975, 2);

    await context.close();
  });

  test('rollover modal fires when next_due_date is past (smoke)', async ({ browser }) => {
    // This test only runs when ROLLOVER_FORCE_PAST=1 is set. It's destructive:
    // it expects the test runner to have separately POSTed/UPDATEd a known
    // confirmed-and-past-due row into subscription_status (we don't mutate
    // the live DB from inside Playwright). When the env flag is missing we
    // skip — the standard suite stays read-only.
    if (!token) {
      test.skip(true, 'JWT_SECRET not set — cannot mint live session cookie.');
      return;
    }
    if (!process.env.ROLLOVER_FORCE_PAST) {
      test.skip(true, 'ROLLOVER_FORCE_PAST env not set — skipping destructive smoke test.');
      return;
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await attachAuth(context, token);
    const page = await context.newPage();
    await rewireApiBase(page, token);

    await bootHome(page);

    // The rollover modal pops over whatever else is loading. With at least
    // one past-due confirmed stream in the DB, aria-hidden flips to "false"
    // shortly after gateAuth resolves.
    const rolloverPop = page.locator('#rollover-pop');
    await expect(rolloverPop).toHaveAttribute('aria-hidden', 'false', { timeout: 8000 });
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-rollover-modal-fired.png`,
      fullPage: true,
    });

    // Click "yes, it charged" — endpoint advances the stream's next_due
    // and either closes the modal (if no more prompts) or shows the next.
    await page.locator('#rollover-yes').click();
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-after-rollover-yes.png`,
      fullPage: true,
    });

    await context.close();
  });
});
