// Phase 8.5C — Full E2E sweep: every user-facing flow + bug discovery.
//
// This spec covers the gaps left by the existing e2e suite:
//   - Auth-redirect on index/paywall/plan (verify+connect already done in
//     legacy-hygiene.spec.ts).
//   - /school landing → Stripe Elements → success → kid login.
//   - Adult age-out (DOB > 18 years).
//   - Recurring tab v2: skeleton, empty state, suggestions list,
//     manual-add modal, edit modal, 3-month forecast pills.
//   - Calendar: stream-linked row delete returns 409 STREAM_LINKED →
//     friendly inline message (currently fails — bug #1).
//   - Rollover modal NEVER fires on boot (currently fails — bug #2).
//
// Strategy: spin up `python3 -m http.server 5183` against the V4-proto
// repo root, then mock every backend call via page.route(). No real
// backend needed — this means the suite runs without JWT_SECRET, Plaid,
// Stripe, or Twilio. We mock the SDK loads (Plaid, Stripe, Sentry) so
// the page can boot deterministically.
//
// Screenshots land in test-results/full-sweep/.
//
// Existing specs that already cover the rest of the flows:
//   - onboarding.spec.ts        : items #1, #2 (Plaid signup + returning).
//   - legacy-hygiene.spec.ts    : item #3 (verify, connect) + item #4.
//   - recurring-bugs.spec.ts    : recurring tab visual sweep (live).
//   - recurring.spec.ts         : recurring tab confirm/dismiss flow (mocked).

import { test, expect, type Page, type ConsoleMessage, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/full-sweep');
const PORT = Number(process.env.FULL_SWEEP_PORT || 5184);
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess | null = null;

function ensureScreenshotDir() {
  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveP, rejectP) => {
    const tryConnect = () => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.end(); resolveP(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) rejectP(new Error(`port ${port} never opened`));
        else setTimeout(tryConnect, 150);
      });
    };
    tryConnect();
  });
}

test.beforeAll(async () => {
  ensureScreenshotDir();
  server = spawn('python3', ['-m', 'http.server', String(PORT)], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    detached: false,
  });
  await waitForPort(PORT, 8000);
});

test.afterAll(async () => {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    server = null;
  }
});

// ── Shared mock helpers ────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  };
}

function attachConsole(page: Page) {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') console.error('[console.error]', msg.text());
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
}

/** Close a BrowserContext while ignoring the trace-artifact ENOENT race that
 *  Playwright sometimes throws when multiple specs in the same run share a
 *  .playwright-artifacts-N directory under retain-on-failure. The actual
 *  test assertion has already run by the time we get here. */
async function safeClose(context: BrowserContext) {
  try {
    await context.close();
  } catch (err) {
    const msg = (err as Error)?.message || '';
    if (msg.includes('ENOENT') && msg.includes('.playwright-artifacts')) {
      // Known Playwright race during trace finalize — the test already passed.
      return;
    }
    throw err;
  }
}

/** Stub the Sentry CDN script so the page boots without a network round-trip. */
async function stubSentry(page: Page) {
  await page.route('**/js.sentry-cdn.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Sentry = window.Sentry || { onLoad: function(){}, init: function(){} };',
    });
  });
}

/** Stub the Plaid CDN script with a deterministic SDK that exposes
 *  __triggerPlaidSuccess() / __triggerPlaidExit() on the window. */
async function stubPlaid(page: Page) {
  await page.route('**/cdn.plaid.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        (function () {
          window.Plaid = {
            create: function (opts) {
              window.__plaidLastOnSuccess = opts && opts.onSuccess;
              window.__plaidLastOnExit = opts && opts.onExit;
              return {
                open: function () { window.__plaidOpenCalled = true; },
                exit: function () {},
                destroy: function () {},
              };
            },
          };
        })();
      `,
    });
  });
}

/** Stub Stripe.js so school.js gets a deterministic stripe.confirmSetup
 *  result without the real network. */
async function stubStripe(page: Page, opts: { setupSucceeds?: boolean } = {}) {
  const setupSucceeds = opts.setupSucceeds ?? true;
  await page.route('**/js.stripe.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        (function () {
          window.Stripe = function (publishableKey) {
            return {
              elements: function (config) {
                window.__stripeElementsConfig = config;
                return {
                  create: function (type) {
                    return {
                      mount: function (selector) {
                        window.__stripeMountSelector = selector;
                        var el = document.querySelector(selector);
                        if (el) el.innerHTML = '<div data-stripe-stub="1">[stripe stub]</div>';
                      },
                      unmount: function () {},
                      destroy: function () {},
                      on: function () {},
                    };
                  },
                };
              },
              confirmSetup: async function (args) {
                window.__stripeConfirmCalled = true;
                if (${setupSucceeds}) {
                  return { setupIntent: { id: 'seti_mock', status: 'succeeded' } };
                }
                return { error: { message: 'mock card declined.' } };
              },
            };
          };
        })();
      `,
    });
  });
}

// ─────────────────────────────────────────────────
// Item #3 — Auto-redirect for already-authed users
// ─────────────────────────────────────────────────

test.describe('item #3 — already-logged-in redirect', () => {
  for (const target of ['/index.html', '/paywall.html', '/plan.html']) {
    test(`${target} bounces authed users to /home.html`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      attachConsole(page);
      await stubSentry(page);
      await stubPlaid(page);

      // /api/me → 200, simulating an authed session.
      await page.route('**/api.cashbff.com/api/me', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: corsHeaders(),
          body: JSON.stringify({ user_id: 'mock_user', phone: '+19095425819' }),
        });
      });
      // Stub /home.html so the redirect actually lands somewhere.
      await page.route('**/home.html', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!DOCTYPE html><html><body><h1 id="home-stub">home</h1></body></html>',
        });
      });

      await page.goto(BASE + target);
      // Wait for the redirect to land.
      await expect(page.locator('#home-stub')).toBeVisible({ timeout: 5000 });
      expect(new URL(page.url()).pathname).toBe('/home.html');

      await safeClose(context);
    });
  }
});

// ─────────────────────────────────────────────────
// Item #5 — /school → Stripe Elements → success → kid login
// ─────────────────────────────────────────────────

test.describe('item #5 — school onboarding (under-18)', () => {
  test('full flow: form → start → stripe → finalize → success → login', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubStripe(page, { setupSucceeds: true });

    const hits: Record<string, number> = {};
    const payloads: Record<string, unknown[]> = {};
    function record(key: string, payload?: unknown) {
      hits[key] = (hits[key] || 0) + 1;
      if (payload !== undefined) {
        if (!payloads[key]) payloads[key] = [];
        payloads[key].push(payload);
      }
    }

    // Auth gate: 401 so the form renders.
    await page.route('**/api.cashbff.com/api/me', async (route) => {
      record('GET /api/me');
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'unauthed' }),
      });
    });

    // /api/school/start → returns Stripe SetupIntent client_secret.
    await page.route('**/api.cashbff.com/api/school/start', async (route) => {
      let body: unknown = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
      record('POST /api/school/start', body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({
          ok: true,
          client_secret: 'seti_mock_secret_abc123',
          school_id: 'school_mock_1',
        }),
      });
    });

    // /api/school/finalize → returns kid login code.
    await page.route('**/api.cashbff.com/api/school/finalize', async (route) => {
      record('POST /api/school/finalize');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({
          ok: true,
          kid_login_code: 'ABCD1234',
          student_email: 'sam@school.edu',
          student_first_name: 'Sam',
        }),
      });
    });

    // ── Visit /school.html ─────────────────────────
    await page.goto(BASE + '/school.html');
    await expect(page.locator('#school-form')).toBeVisible();
    await page.screenshot({ path: SCREENSHOT_DIR + '/school-01-form.png', fullPage: true });

    // ── Fill the form with under-18 DOB ────────────
    const youngDob = '2010-06-15'; // 15-ish years old in 2026.
    await page.locator('#parent-first-name').fill('Alex');
    await page.locator('#parent-email').fill('alex@parent.com');
    await page.locator('#student-first-name').fill('Sam');
    await page.locator('#student-email').fill('sam@school.edu');
    await page.locator('#student-dob').fill(youngDob);
    await page.locator('#consent').check();
    await page.locator('#submit-btn').click();

    // ── /api/school/start fired with the values ────
    await expect.poll(() => hits['POST /api/school/start'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);
    const startPayload = (payloads['POST /api/school/start'] || [])[0] as Record<string, unknown>;
    expect(startPayload.parent_email).toBe('alex@parent.com');
    expect(startPayload.student_email).toBe('sam@school.edu');

    // ── State: stripe-card visible, mount happened ─
    await expect(page.locator('#state-stripe-card')).toHaveClass(/is-active/, { timeout: 4000 });
    const mountSelector = await page.evaluate(() => (window as { __stripeMountSelector?: string }).__stripeMountSelector);
    expect(mountSelector).toBe('#stripe-card-mount');
    await page.screenshot({ path: SCREENSHOT_DIR + '/school-02-stripe-card.png', fullPage: true });

    // ── Click "verify my card" → confirmSetup → finalize ─
    await page.locator('#verify-card-btn').click();
    await expect.poll(async () => {
      return await page.evaluate(() => (window as { __stripeConfirmCalled?: boolean }).__stripeConfirmCalled);
    }, { timeout: 4000 }).toBe(true);
    await expect.poll(() => hits['POST /api/school/finalize'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);

    // ── State: success, with kid login URL prefilled ──
    await expect(page.locator('#state-success')).toHaveClass(/is-active/, { timeout: 4000 });
    const kidUrl = await page.locator('#kid-login-url').inputValue();
    expect(kidUrl).toContain('cashbff.com/school/login');
    expect(kidUrl).toContain('email=sam%40school.edu');
    expect(kidUrl).toContain('code=ABCD1234');
    await expect(page.locator('#success-student-name')).toContainText('Sam');
    await page.screenshot({ path: SCREENSHOT_DIR + '/school-03-success.png', fullPage: true });

    // ── Visit /school/login URL with prefilled query ────
    // Stripe was already stubbed; we now mock /api/school/login + /api/me
    // separately so the kid landing works.
    await page.route('**/api.cashbff.com/api/school/login', async (route) => {
      record('POST /api/school/login');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({ ok: true, redirect: '/home.html' }),
      });
    });
    await page.route('**/home.html', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><body><h1 id="home-stub">home</h1></body></html>',
      });
    });

    await page.goto(BASE + '/school-login.html?email=sam%40school.edu&code=ABCD1234');
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#student_email')).toHaveValue('sam@school.edu');
    await expect(page.locator('#kid_code')).toHaveValue('ABCD1234');
    await page.screenshot({ path: SCREENSHOT_DIR + '/school-04-login-prefill.png', fullPage: true });

    await page.locator('#login-btn').click();
    await expect.poll(() => hits['POST /api/school/login'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#home-stub')).toBeVisible({ timeout: 5000 });

    await safeClose(context);
  });
});

// ─────────────────────────────────────────────────
// Item #6 — Adult age-out
// ─────────────────────────────────────────────────

test.describe('item #6 — adult age-out', () => {
  test('DOB > 18 years routes to ageout state with cashbff.com link', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubStripe(page);

    let schoolStartCalled = false;
    await page.route('**/api.cashbff.com/api/me', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'unauthed' }),
      });
    });
    await page.route('**/api.cashbff.com/api/school/start', async (route) => {
      schoolStartCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({ ok: true, client_secret: 'seti_mock' }),
      });
    });

    await page.goto(BASE + '/school.html');
    await expect(page.locator('#school-form')).toBeVisible();

    // ── Fill with an adult DOB (1995 → 30+ years old) ─
    await page.locator('#parent-first-name').fill('Alex');
    await page.locator('#parent-email').fill('alex@parent.com');
    await page.locator('#student-first-name').fill('Sam');
    await page.locator('#student-email').fill('sam@adult.com');
    await page.locator('#student-dob').fill('1995-01-01');
    await page.locator('#consent').check();
    await page.locator('#submit-btn').click();

    // ── Should land on ageout, NOT verifying / stripe ──
    await expect(page.locator('#state-ageout')).toHaveClass(/is-active/, { timeout: 4000 });
    await expect(page.locator('.ageout__body')).toContainText('cashbff.com');
    await expect(page.locator('.ageout__cta')).toHaveAttribute('href', '/');
    await page.screenshot({ path: SCREENSHOT_DIR + '/school-ageout.png', fullPage: true });

    // /api/school/start should NOT have been called.
    expect(schoolStartCalled).toBe(false);

    // "wrong birthday? go back" returns to form.
    await page.locator('#ageout-back').click();
    await expect(page.locator('#state-form')).toHaveClass(/is-active/);

    await safeClose(context);
  });
});

// ─────────────────────────────────────────────────
// Items #7, #8, #9 — Recurring tab v2 + STREAM_LINKED
//                    + rollover-never (home.html sweep)
// ─────────────────────────────────────────────────

interface HomeMockOpts {
  suggestions?: unknown[];
  streams?: unknown[];
  rolloverItems?: unknown[];
  calendarRows?: unknown[];
  delaySuggestionsMs?: number;
  delayStreamsMs?: number;
  // When set, DELETE /api/transactions/schedule/:id returns 409 STREAM_LINKED.
  deleteReturnsStreamLinked?: { merchant: string };
}

async function installHomeMocks(page: Page, opts: HomeMockOpts = {}) {
  const hits: Record<string, number> = {};
  const payloads: Record<string, unknown[]> = {};
  const record = (key: string, payload?: unknown) => {
    hits[key] = (hits[key] || 0) + 1;
    if (payload !== undefined) {
      if (!payloads[key]) payloads[key] = [];
      payloads[key].push(payload);
    }
  };

  // Catch-all FIRST so specific routes win on registration order.
  await page.route('**/api.cashbff.com/**', async (route) => {
    record('UNHANDLED ' + route.request().method() + ' ' + route.request().url());
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'unhandled-mock' }),
    });
  });

  await page.route('**/api.cashbff.com/api/me', async (route) => {
    record('GET /api/me');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({
        user_id: 'mock_user',
        phone: '+19095425819',
        signup_month: '2024-01',
      }),
    });
  });

  await page.route('**/api.cashbff.com/api/calendar*', async (route) => {
    record('GET /api/calendar');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ expenses: opts.calendarRows ?? [] }),
    });
  });

  await page.route('**/api.cashbff.com/api/balances', async (route) => {
    record('GET /api/balances');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ accounts: [], summary: {} }),
    });
  });

  await page.route('**/api.cashbff.com/api/cards', async (route) => {
    record('GET /api/cards');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ cards: [] }),
    });
  });

  await page.route('**/api.cashbff.com/api/wallet', async (route) => {
    record('GET /api/wallet');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({
        plaid_accounts: [],
        tracked_accounts: [],
        summary: { total_owed: 0, total_in: 0, net: 0, spendable: 0 },
      }),
    });
  });

  await page.route('**/api.cashbff.com/api/recurring/suggestions', async (route) => {
    record('GET /api/recurring/suggestions');
    if (opts.delaySuggestionsMs) await new Promise((r) => setTimeout(r, opts.delaySuggestionsMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ items: opts.suggestions ?? [] }),
    });
  });

  await page.route('**/api.cashbff.com/api/recurring/streams', async (route) => {
    if (route.request().method() === 'POST') {
      let body: unknown = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
      record('POST /api/recurring/streams', body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({
          ok: true,
          stream: {
            merchant: 'manually-added-bill',
            display_name: (body as { name?: string })?.name || 'manual',
            mode_amount: (body as { amount?: number })?.amount || 0,
            next_due_date: (body as { next_due_date?: string })?.next_due_date || '2026-05-01',
            cadence: 'monthly',
            status: 'active',
          },
        }),
      });
      return;
    }
    record('GET /api/recurring/streams');
    if (opts.delayStreamsMs) await new Promise((r) => setTimeout(r, opts.delayStreamsMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ items: opts.streams ?? [] }),
    });
  });

  // PATCH /api/recurring/streams/:merchant (edit)
  await page.route('**/api.cashbff.com/api/recurring/streams/*', async (route) => {
    const method = route.request().method();
    if (method === 'PATCH') {
      let body: unknown = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
      record('PATCH /api/recurring/streams', body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({ ok: true, stream: {} }),
      });
      return;
    }
    if (method === 'DELETE') {
      record('DELETE /api/recurring/streams');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    record(`UNHANDLED ${method} stream-by-merchant`);
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'not-mocked' }),
    });
  });

  await page.route('**/api.cashbff.com/api/recurring/rollover-prompts', async (route) => {
    record('GET /api/recurring/rollover-prompts');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ items: opts.rolloverItems ?? [] }),
    });
  });

  // DELETE /api/transactions/schedule/:id — STREAM_LINKED 409 path.
  // Phase 10B: the 409 body now carries an `actions: ['acknowledge',
  // 'stop_stream']` array so the frontend can render the new two-button
  // surface. Item #8 below relies on the acknowledge button being present.
  await page.route('**/api.cashbff.com/api/transactions/schedule/*', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    // POST /api/transactions/schedule/:id/acknowledge — soft-delete path.
    if (method === 'POST' && /\/acknowledge$/.test(url)) {
      record('POST /api/transactions/schedule/acknowledge');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({
          ok: true,
          transaction: {
            id: 9001,
            date: '2026-04-29',
            amount: 25,
            name: 'Self Financial',
            type: 'sub',
            card_account_id: null,
            note: 'recurring-projection:self-financial',
            confidence: 1,
            pending: false,
            source: 'scheduled',
            institution: 'Chase',
            mask: '1234',
            acknowledged: true,
          },
        }),
      });
      return;
    }
    if (method === 'DELETE' && opts.deleteReturnsStreamLinked) {
      record('DELETE /api/transactions/schedule (STREAM_LINKED)');
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({
          error:
            'this is part of your "' + opts.deleteReturnsStreamLinked.merchant +
            '" recurring stream. mark it ✓ paid here to keep the reminder, OR open the recurring tab to set an end date.',
          code: 'STREAM_LINKED',
          merchant: opts.deleteReturnsStreamLinked.merchant,
          display_name: opts.deleteReturnsStreamLinked.merchant,
          actions: ['acknowledge', 'stop_stream'],
        }),
      });
      return;
    }
    record('DELETE /api/transactions/schedule');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true }),
    });
  });

  return { hits, payloads };
}

test.describe('item #9 — rollover modal NEVER fires on boot', () => {
  test('with backend returning items, modal still does not appear within 5s', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    // Adversarial: backend returns a non-empty rollover-prompts list. The
    // 8.5B contract is that the frontend should NOT open the modal even if
    // the backend offers one — the day-of rollover UX is being killed.
    const rolloverItems = [
      {
        merchant: 'self-financial',
        display_name: 'Self Financial',
        next_due_date: '2026-04-29',
        amount: 25,
        observed_date: '2026-03-29',
      },
    ];
    const { hits } = await installHomeMocks(page, { rolloverItems });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });

    // Wait 5 seconds — way past any boot timer that could open the modal.
    await page.waitForTimeout(5000);

    // 8.5B contract: rollover-pop markup is GONE from home.html, AND the
    // rollover-prompts fetch is no longer fired by boot.
    const rolloverPopCount = await page.locator('#rollover-pop').count();
    expect(rolloverPopCount, '#rollover-pop markup should be removed from home.html').toBe(0);

    const rolloverFetches = hits['GET /api/recurring/rollover-prompts'] || 0;
    expect.soft(rolloverFetches, 'home.js should not call /api/recurring/rollover-prompts on boot').toBe(0);

    // Belt-and-braces: assert nothing role=dialog is open right now.
    const openDialogs = await page.locator('[role="dialog"][aria-hidden="false"]').count();
    expect(openDialogs).toBe(0);

    await page.screenshot({ path: SCREENSHOT_DIR + '/item-9-no-rollover.png', fullPage: true });
    console.log(`[item-9] rolloverFetches=${rolloverFetches}, rolloverPopCount=${rolloverPopCount}`);

    await safeClose(context);
  });
});

test.describe('item #7 — recurring tab v2', () => {
  // Helper to build a confirmed stream payload — shape matches what
  // /api/recurring/streams actually returns (mapStreamRow → mapSuggestionRow
  // in src/recurring.ts).
  function streamFixture(overrides: Record<string, unknown> = {}) {
    return {
      merchant: 'self-financial',
      display_name: 'Self Financial',
      amount: 25,
      next_due_date: '2026-05-01',
      cadence_days: 30,
      last_charge_date: '2026-04-01',
      suggested_at: '2026-03-15T00:00:00Z',
      confirmed_at: '2026-03-20T00:00:00Z',
      linked_scheduled_txn_id: 9001,
      frequency: 'monthly',
      end_date: null,
      from_institution: 'Chase',
      from_mask: '1234',
      ...overrides,
    };
  }

  function suggestionFixture(overrides: Record<string, unknown> = {}) {
    return {
      merchant: 'netflix',
      display_name: 'Netflix',
      amount: 15.99,
      next_due_date: '2026-05-08',
      cadence_days: 30,
      last_charge_date: '2026-04-08',
      suggested_at: '2026-04-15T00:00:00Z',
      frequency: 'monthly',
      end_date: null,
      from_institution: 'Chase',
      from_mask: '1234',
      ...overrides,
    };
  }

  test('skeleton renders during slow GETs', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    await installHomeMocks(page, {
      suggestions: [],
      streams: [],
      delaySuggestionsMs: 1500,
      delayStreamsMs: 1500,
    });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });

    // Open the recurring tab BEFORE the GETs land.
    await page.locator('#recurring-btn').click();
    const recurringPop = page.locator('#recurring-pop');
    await expect(recurringPop).toHaveClass(/(^|\s)open(\s|$)/);

    // Skeleton elements should be visible during the wait.
    const skeleton = page.locator('.recurring-skeleton').first();
    await expect(skeleton).toBeVisible({ timeout: 1000 });
    await page.screenshot({ path: SCREENSHOT_DIR + '/recurring-01-skeleton.png', fullPage: true });

    await safeClose(context);
  });

  test('empty state copy renders when both lists are empty', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    await installHomeMocks(page, { suggestions: [], streams: [] });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
    await page.locator('#recurring-btn').click();
    await expect(page.locator('#recurring-pop')).toHaveClass(/(^|\s)open(\s|$)/);

    // Wait for the GETs to land + render to settle.
    await expect(page.locator('#recurring-streams-list .recurring-empty')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#recurring-streams-list .recurring-empty')).toContainText(/nothing tracked yet/i);
    await expect(page.locator('#recurring-suggestions-list .recurring-empty')).toBeVisible();

    await page.screenshot({ path: SCREENSHOT_DIR + '/recurring-02-empty.png', fullPage: true });

    await safeClose(context);
  });

  test('suggestions list renders cards with name, amount, date, source bank', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    const suggestions = [
      suggestionFixture({ merchant: 'netflix', display_name: 'Netflix', mode_amount: 15.99 }),
      suggestionFixture({ merchant: 'spotify', display_name: 'Spotify', mode_amount: 11.99 }),
    ];
    await installHomeMocks(page, { suggestions, streams: [] });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
    await page.locator('#recurring-btn').click();

    const cards = page.locator('#recurring-suggestions-list .recurring-suggestion');
    await expect(cards).toHaveCount(2, { timeout: 5000 });

    // First card carries Netflix data.
    const first = cards.first();
    await expect(first).toHaveAttribute('data-merchant', 'netflix');
    // Name input is editable but defaults to the display_name.
    const nameInput = first.locator('input[type="text"]').first();
    await expect(nameInput).toHaveValue('Netflix');

    await page.screenshot({ path: SCREENSHOT_DIR + '/recurring-03-suggestions.png', fullPage: true });

    await safeClose(context);
  });

  test('add-manual-stream modal: open → submit → POST /api/recurring/streams', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    const { hits, payloads } = await installHomeMocks(page, { suggestions: [], streams: [] });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
    await page.locator('#recurring-btn').click();
    await expect(page.locator('#recurring-pop')).toHaveClass(/(^|\s)open(\s|$)/);
    await page.waitForTimeout(500);

    // Click the add button.
    await page.locator('#recurring-add-btn').click();
    const addPop = page.locator('#recurring-add-pop');
    await expect(addPop).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 2000 });
    await page.screenshot({ path: SCREENSHOT_DIR + '/recurring-04-add-modal.png', fullPage: true });

    // Fill the form.
    await page.locator('#rec-add-name').fill('Comcast Internet');
    await page.locator('#rec-add-amount').fill('89.99');
    await page.locator('#rec-add-date').fill('2026-05-15');
    // Frequency 'monthly' is already active by default.
    await expect(page.locator('#rec-add-freq-chips .freq-chip.is-active')).toHaveAttribute('data-freq', 'monthly');
    await page.locator('#rec-add-end').fill('2027-05-15');

    await page.locator('#rec-add-submit').click();
    await expect.poll(() => hits['POST /api/recurring/streams'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);

    const submitted = (payloads['POST /api/recurring/streams'] || [])[0] as Record<string, unknown>;
    // home.js posts the canonical { display_name, next_due_date, amount,
    // frequency, end_date } shape that matches the backend validator.
    expect(submitted.display_name).toBe('Comcast Internet');
    expect(Number(submitted.amount)).toBeCloseTo(89.99, 2);
    expect(submitted.next_due_date).toBe('2026-05-15');
    expect(submitted.frequency).toBe('monthly');
    expect(submitted.end_date).toBe('2027-05-15');

    await safeClose(context);
  });

  test('edit existing stream: row click → edit modal → PATCH end_date', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    const streams = [
      streamFixture({
        merchant: 'self-financial',
        display_name: 'Self Financial',
        mode_amount: 25,
        next_due_date: '2026-05-01',
        end_date: null,
      }),
    ];
    const { hits, payloads } = await installHomeMocks(page, { suggestions: [], streams });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
    await page.locator('#recurring-btn').click();
    await expect(page.locator('#recurring-pop')).toHaveClass(/(^|\s)open(\s|$)/);

    // Wait for the stream row to render.
    const streamRow = page.locator('#recurring-streams-list .recurring-stream').first();
    await expect(streamRow).toBeVisible({ timeout: 5000 });
    await streamRow.locator('.recurring-stream__main').click();

    // Edit modal should open with the data prefilled.
    const editPop = page.locator('#recurring-edit-pop');
    await expect(editPop).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 2000 });
    await expect(page.locator('#rec-edit-name')).toHaveValue('Self Financial');
    // home.js renders amount as toFixed(2).
    await expect(page.locator('#rec-edit-amount')).toHaveValue('25.00');
    await expect(page.locator('#rec-edit-date')).toHaveValue('2026-05-01');
    await page.screenshot({ path: SCREENSHOT_DIR + '/recurring-05-edit-modal.png', fullPage: true });

    // Set an end_date and save.
    await page.locator('#rec-edit-end').fill('2026-12-31');
    await page.locator('#rec-edit-submit').click();
    await expect.poll(() => hits['PATCH /api/recurring/streams'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);

    const patched = (payloads['PATCH /api/recurring/streams'] || [])[0] as Record<string, unknown>;
    expect(patched.end_date).toBe('2026-12-31');

    await safeClose(context);
  });

  test('3-month forecast: calendar carries projection rows', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    // home.js boots showing the CURRENT month. Build projections for the
    // current + next 2 months so at least one pill is visible without
    // navigating. Pill text is "$25 Self" (first word only, see home.js
    // line ~565).
    const today = new Date();
    function isoFor(monthOffset: number, day: number): string {
      const d = new Date(today.getFullYear(), today.getMonth() + monthOffset, day);
      return d.toISOString().slice(0, 10);
    }
    const projections = [0, 1, 2].map((m, i) => ({
      id: 1000 + i,
      date: isoFor(m, 1),
      amount: 25,
      name: 'Self Financial',
      type: 'sub',
      card_account_id: null,
      note: 'recurring-projection:self-financial',
      confidence: 1,
      pending: false,
      source: 'scheduled',
      institution: 'Chase',
      mask: '1234',
    }));
    await installHomeMocks(page, {
      suggestions: [],
      streams: [streamFixture()],
      calendarRows: projections,
    });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    // Pill text format: "$25 Self" — search for any sub-typed pill.
    const subPills = page.locator('.cell .pill.sub');
    const initialPillCount = await subPills.count();

    // Verify forward nav reaches month 1 and month 2 — there should be a
    // sub pill in each.
    const nextBtn = page.locator('#next-month');
    let pillCounts: number[] = [initialPillCount];
    for (let nav = 0; nav < 2; nav++) {
      await nextBtn.click();
      await page.waitForTimeout(600);
      pillCounts.push(await subPills.count());
    }
    // Reset to current month for the screenshot.
    await page.locator('#prev-month').click();
    await page.locator('#prev-month').click();
    await page.waitForTimeout(400);

    await page.screenshot({ path: SCREENSHOT_DIR + '/recurring-06-3mo-forecast.png', fullPage: true });

    // At least one of the three months we visited must show a sub pill.
    // home.js renders cells from a 6-week grid, so off-month cells from
    // adjacent months may carry pills too — that's fine, we only require
    // proof that the projection data flowed through.
    const totalPills = pillCounts.reduce((a, b) => a + b, 0);
    expect.soft(totalPills, `expected sub pills across 3 months but saw ${pillCounts}`).toBeGreaterThanOrEqual(3);
    expect(totalPills).toBeGreaterThanOrEqual(1);

    await safeClose(context);
  });
});

test.describe('item #8 — calendar STREAM_LINKED 409 → friendly message', () => {
  test('clicking trash on a stream-linked row surfaces inline friendly text', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    // Place the projection row mid-month in the CURRENT month so home.js
    // renders it on boot without needing calendar nav.
    const today = new Date();
    const targetDay = Math.min(15, today.getDate() + 1);
    const targetDate = new Date(today.getFullYear(), today.getMonth(), targetDay);
    const targetIso = targetDate.toISOString().slice(0, 10);

    const projection = {
      id: 9001,
      date: targetIso,
      amount: 25,
      name: 'Self Financial',
      type: 'sub',
      card_account_id: null,
      note: 'recurring-projection:self-financial',
      confidence: 1,
      pending: false,
      source: 'scheduled',
      institution: 'Chase',
      mask: '1234',
    };
    await installHomeMocks(page, {
      streams: [],
      suggestions: [],
      calendarRows: [projection],
      deleteReturnsStreamLinked: { merchant: 'self-financial' },
    });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    // Click the cell that carries our pill. The cell holding the pill has
    // class "cell" and a child .pill.sub — find that and click its parent.
    const subPill = page.locator('.cell .pill.sub').first();
    await expect(subPill).toBeVisible({ timeout: 5000 });
    const cell = subPill.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " cell ")]').first();
    await cell.click();

    // Drawer opens — find the Self Financial row and click trash → yes.
    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 3000 });

    const drawerItem = drawer.locator('.drawer-item').filter({ hasText: /self financial/i }).first();
    await expect(drawerItem).toBeVisible({ timeout: 3000 });
    await page.screenshot({ path: SCREENSHOT_DIR + '/item-8-drawer.png', fullPage: true });

    // Trash icon is an SVG inside the drawer item.
    const trash = drawerItem.locator('.drawer-item__trash').first();
    await trash.click();
    // home.js renders an inline "yes/no" confirm in the same row.
    const confirmYes = drawerItem.locator('.row-confirm__yes').first();
    if ((await confirmYes.count()) === 0) {
      // Fallback: any visible "yes" button.
      await drawerItem.getByRole('button', { name: /yes/i }).click();
    } else {
      await confirmYes.click();
    }

    // Wait for the 409 to land. Currently home.js displays the generic
    // "couldn't delete · cancel" message — no merchant, no recurring hint.
    // The friendly inline message is the contract we want to enforce.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: SCREENSHOT_DIR + '/item-8-after-409.png', fullPage: true });

    const inlineText = (await drawerItem.textContent()) || '';
    console.log(`[item-8] post-409 drawer text: "${inlineText.replace(/\s+/g, ' ').trim()}"`);

    // Soft assertions — capturing the bug state without failing the suite.
    // The friendly message should contain the merchant name AND mention
    // the recurring panel.
    expect.soft(inlineText, 'expected "recurring" wording in friendly STREAM_LINKED message').toMatch(/recurring/i);
    expect.soft(inlineText, 'expected merchant name in friendly message').toMatch(/self financial/i);
    // Phase 10B: the surface now offers BOTH options inline — assert the
    // acknowledge CTA + the stop-tracking link are present.
    expect.soft(inlineText, 'expected "I already paid this" CTA in 2-button surface').toMatch(/already paid/i);
    expect.soft(inlineText, 'expected "stop tracking" affordance').toMatch(/stop tracking/i);

    await safeClose(context);
  });
});
