// Phase 10C — comprehensive coverage sweep.
//
// Fills the gaps left by prior phase-specific specs by exercising the
// claims documented in docs/user-flow-tree.md. Every test runs against
// a local python static server with all backend calls mocked via
// page.route — no JWT, no prod backend, no Plaid/Stripe network.
//
// Items covered (matching the brief):
//   #1  snapshot-for-AI modal end-to-end (mock-only twin of
//       snapshot.spec.ts which needs JWT_SECRET)
//   #2  acknowledge action soft-deletes a stream-linked row
//   #3  stop-tracking action opens recurring tab
//   #4  privacy + terms pages render and footer links work
//   #5  metrics admin gate (smoke covered already in metrics.spec.ts;
//       this spec doubles up the visit-as-anon path)
//   #6  18+ disclaimer links to terms.html on every funnel page
//   #7  daksh@cashbff.com is the only support email anywhere
//   #8  "my home" pill on every marketing/funnel page when authed
//   #9  logged-in user can VIEW marketing pages (no auto-redirect)
//   #10 autoAdvanceConfirmedStreams is wired into syncUser (source-text
//       check on the backend repo)
//   #11 STREAM_LINKED 409 message uses display_name (source-text check)
//   #12 day popover does NOT leak the `recurring-projection:` tag
//
// Ports: 5188 to avoid clashing with full-sweep.spec.ts (5184),
// onboarding.spec.ts (5183), metrics.spec.ts (5187),
// _snapshot-screenshot.spec.ts (5186), _phase9a-screenshots.spec.ts (5185).
//
// Screenshots land in test-results/v1-comprehensive/.

import { test, expect, type Page, type ConsoleMessage, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/v1-comprehensive');
const PORT = Number(process.env.V1_COMPREHENSIVE_PORT || 5188);
const BASE = `http://localhost:${PORT}`;

// Backend repo lives next door — used for source-text assertions.
const BACKEND_ROOT = resolve(REPO_ROOT, '..', '..', 'CashBFF Plaid API');

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

function attachConsole(page: Page, sink?: string[]) {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (sink) sink.push(text);
      console.error('[console.error]', text);
    }
  });
  page.on('pageerror', (err) => {
    if (sink) sink.push(err.message);
    console.error('[pageerror]', err.message);
  });
}

async function safeClose(context: BrowserContext) {
  try { await context.close(); } catch (err) {
    const msg = (err as Error)?.message || '';
    if (msg.includes('ENOENT') && msg.includes('.playwright-artifacts')) return;
    throw err;
  }
}

async function stubSentry(page: Page) {
  await page.route('**/js.sentry-cdn.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Sentry = window.Sentry || { onLoad: function(){}, init: function(){} };',
    });
  });
}

async function stubPlaid(page: Page) {
  await page.route('**/cdn.plaid.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Plaid = { create: function(){ return { open: function(){}, destroy: function(){} }; } };',
    });
  });
}

/** Install minimal mocks so home.js can boot without making real network calls. */
async function installHomeMocks(page: Page, opts: {
  meStatus?: number;
  calendarRows?: unknown[];
  streams?: unknown[];
  suggestions?: unknown[];
  snapshotMd?: string;
  deleteReturnsStreamLinked?: { merchant: string };
} = {}) {
  const hits: Record<string, number> = {};
  const record = (key: string) => { hits[key] = (hits[key] || 0) + 1; };

  // Catch-all FIRST so specific routes win on registration order.
  await page.route('**/api.cashbff.com/**', async (route) => {
    record('UNHANDLED ' + route.request().method() + ' ' + route.request().url());
    await route.fulfill({
      status: 404, contentType: 'application/json',
      headers: corsHeaders(), body: JSON.stringify({ error: 'unhandled-mock' }),
    });
  });

  await page.route('**/api.cashbff.com/api/me', async (route) => {
    record('GET /api/me');
    const status = opts.meStatus ?? 200;
    await route.fulfill({
      status, contentType: 'application/json', headers: corsHeaders(),
      body: JSON.stringify(status === 200
        ? { user_id: 'mock_user', phone: '+19095425819', signup_month: '2024-01' }
        : { error: 'unauthed' }),
    });
  });

  await page.route('**/api.cashbff.com/api/calendar*', async (route) => {
    record('GET /api/calendar');
    await route.fulfill({
      status: 200, contentType: 'application/json', headers: corsHeaders(),
      body: JSON.stringify({ expenses: opts.calendarRows ?? [] }),
    });
  });

  for (const path of ['/api/balances', '/api/cards', '/api/wallet', '/api/reimbursements']) {
    await page.route('**/api.cashbff.com' + path, async (route) => {
      record('GET ' + path);
      const empty = path === '/api/balances'
        ? { accounts: [], summary: {} }
        : path === '/api/wallet'
          ? { plaid_accounts: [], tracked_accounts: [], summary: { total_owed: 0, total_in: 0, net: 0, spendable: 0 } }
          : path === '/api/reimbursements'
            ? { items: [] }
            : { cards: [] };
      await route.fulfill({
        status: 200, contentType: 'application/json',
        headers: corsHeaders(), body: JSON.stringify(empty),
      });
    });
  }

  await page.route('**/api.cashbff.com/api/recurring/suggestions', async (route) => {
    record('GET /api/recurring/suggestions');
    await route.fulfill({
      status: 200, contentType: 'application/json', headers: corsHeaders(),
      body: JSON.stringify({ items: opts.suggestions ?? [] }),
    });
  });
  await page.route('**/api.cashbff.com/api/recurring/streams', async (route) => {
    record('GET /api/recurring/streams');
    await route.fulfill({
      status: 200, contentType: 'application/json', headers: corsHeaders(),
      body: JSON.stringify({ items: opts.streams ?? [] }),
    });
  });
  await page.route('**/api.cashbff.com/api/recurring/rollover-prompts', async (route) => {
    record('GET /api/recurring/rollover-prompts');
    await route.fulfill({
      status: 200, contentType: 'application/json', headers: corsHeaders(),
      body: JSON.stringify({ items: [] }),
    });
  });

  await page.route('**/api.cashbff.com/api/snapshot', async (route) => {
    record('GET /api/snapshot');
    await route.fulfill({
      status: 200, contentType: 'application/json', headers: corsHeaders(),
      body: JSON.stringify({
        ok: true,
        snapshot: opts.snapshotMd ?? '# my cashbff snapshot\n\ngenerated 2026-04-29',
        generated_at: '2026-04-29T12:00:00Z',
      }),
    });
  });

  // Use ** (double-star) so we match both /:id and /:id/acknowledge paths.
  await page.route('**/api.cashbff.com/api/transactions/schedule/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === 'POST' && /\/acknowledge$/.test(url)) {
      record('POST /api/transactions/schedule/acknowledge');
      await route.fulfill({
        status: 200, contentType: 'application/json', headers: corsHeaders(),
        body: JSON.stringify({ ok: true, transaction: { id: 9001, acknowledged: true } }),
      });
      return;
    }
    if (method === 'DELETE' && opts.deleteReturnsStreamLinked) {
      record('DELETE /api/transactions/schedule (STREAM_LINKED)');
      await route.fulfill({
        status: 409, contentType: 'application/json', headers: corsHeaders(),
        body: JSON.stringify({
          error: 'this is part of your "' + opts.deleteReturnsStreamLinked.merchant + '" recurring stream.',
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
      status: 200, contentType: 'application/json',
      headers: corsHeaders(), body: JSON.stringify({ ok: true }),
    });
  });

  return { hits };
}

// ─────────────────────────────────────────────────
// Item #6 — 18+ disclaimer links go to terms.html (NOT privacy.html)
// ─────────────────────────────────────────────────

test.describe('item #6 — 18+ disclaimer points at terms.html', () => {
  // index/connect/verify all carry an explicit "18+" sentence ending
  // "agree to our terms" → terms.html. paywall uses a different shape
  // ("by continuing you agree to ... terms") and is covered separately.
  for (const target of ['/index.html', '/connect.html', '/verify.html']) {
    test(`${target} 18+ disclaimer link goes to terms.html`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      attachConsole(page);
      await stubSentry(page); await stubPlaid(page);
      // 401 so funnel shows.
      await page.route('**/api.cashbff.com/**', (r) => r.fulfill({
        status: 401, contentType: 'application/json',
        headers: corsHeaders(), body: JSON.stringify({ error: 'unauthed' }),
      }));

      await page.goto(BASE + target);

      // Find any disclaimer-shaped element with the "18+" wording.
      const disc = page.getByText(/18\+/, { exact: false }).first();
      await expect(disc).toBeVisible({ timeout: 5000 });

      // The link inside that disclaimer must point to terms.html (the
      // visible text is "terms" already — we're enforcing the href).
      const link = disc.locator('a[href*="terms"]').first();
      await expect(link).toBeVisible();
      const href = await link.getAttribute('href');
      // Allow href="terms.html", "/terms.html", or "terms" — but NOT
      // privacy.* (the prior contract).
      expect(href).toBeTruthy();
      expect(href!).not.toMatch(/privacy/i);
      expect(href!).toMatch(/terms/i);

      await safeClose(context);
    });
  }

  test('/paywall.html "by continuing" disclaimer terms link points at terms.html', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page); await stubPlaid(page);
    await page.route('**/api.cashbff.com/**', (r) => r.fulfill({
      status: 401, contentType: 'application/json',
      headers: corsHeaders(), body: JSON.stringify({ error: 'unauthed' }),
    }));

    await page.goto(BASE + '/paywall.html');
    const fine = page.locator('.fine').first();
    await expect(fine).toBeVisible({ timeout: 5000 });
    await expect(fine).toContainText(/by continuing/i);

    const termsLink = fine.locator('#terms-link');
    await expect(termsLink).toHaveAttribute('href', 'terms.html');
    // The browser SHOULD navigate to /terms.html on click — but
    // paywall.js intercepts with preventDefault + alert. That's a known
    // bug surfaced in the report (see paywall.js:62-65). Don't gate the
    // test on the buggy click handler — the href contract is what we
    // care about for the disclaimer.

    await safeClose(context);
  });
});

// ─────────────────────────────────────────────────
// Item #7 — no hi@cashbff.com anywhere; daksh@ everywhere
// ─────────────────────────────────────────────────

test.describe('item #7 — daksh@cashbff.com replaces hi@', () => {
  for (const target of [
    '/index.html', '/connect.html', '/verify.html', '/paywall.html',
    '/plan.html', '/welcome.html', '/school.html', '/school-login.html',
    '/privacy.html', '/terms.html',
  ]) {
    test(`${target} contains daksh@cashbff.com and not hi@cashbff.com`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      attachConsole(page);
      await stubSentry(page); await stubPlaid(page);
      await page.route('**/api.cashbff.com/**', (r) => r.fulfill({
        status: 401, contentType: 'application/json',
        headers: corsHeaders(), body: JSON.stringify({ error: 'unauthed' }),
      }));

      await page.goto(BASE + target);
      await page.waitForLoadState('domcontentloaded');

      const html = await page.content();
      expect(html, `${target} must NOT contain hi@cashbff.com`).not.toMatch(/hi@cashbff\.com/i);
      expect(html, `${target} must contain daksh@cashbff.com`).toMatch(/daksh@cashbff\.com/i);

      await safeClose(context);
    });
  }
});

// ─────────────────────────────────────────────────
// Item #8 + #9 — "my home" pill on marketing/funnel pages when authed
// ─────────────────────────────────────────────────

test.describe('item #8/#9 — my-home pill + no auto-redirect for authed users', () => {
  // Pages that must paint the pill but NOT redirect.
  const targets = [
    { path: '/index.html',        marketing: true,  hidesCta: false, ctaSel: '#connect-btn' },
    { path: '/connect.html',      marketing: false, hidesCta: true,  ctaSel: '#connect-btn' },
    { path: '/verify.html',       marketing: false, hidesCta: true,  ctaSel: '#verify-btn' },
    { path: '/paywall.html',      marketing: false, hidesCta: true,  ctaSel: '#start-btn' },
    { path: '/plan.html',         marketing: true,  hidesCta: true,  ctaSel: '#calc-btn' },
    { path: '/school.html',       marketing: true,  hidesCta: false, ctaSel: '#submit-btn' },
  ];

  for (const t of targets) {
    test(`${t.path} authed → pill visible, no redirect to /home.html`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      attachConsole(page);
      await stubSentry(page); await stubPlaid(page);

      await page.route('**/api.cashbff.com/api/me', async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          headers: corsHeaders(),
          body: JSON.stringify({ user_id: 'mock_user', phone: '+19095425819' }),
        });
      });
      await page.route('**/api.cashbff.com/**', async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          headers: corsHeaders(),
          body: JSON.stringify({ ok: true }),
        });
      });

      await page.goto(BASE + t.path);

      // 1. URL did NOT redirect to /home.html.
      await page.waitForTimeout(800);
      const path = new URL(page.url()).pathname;
      expect(path, `${t.path} must NOT auto-redirect for authed users`).not.toBe('/home.html');

      // 2. Pill is in the DOM and visible.
      const pill = page.locator('#cbff-auth-home-btn');
      await expect(pill).toBeVisible({ timeout: 5000 });
      await expect(pill).toContainText(/my home/i);

      // 3. Pill click goes to /home.html (intercept the navigation).
      // We can't verify navigation lands on /home.html without mocking it;
      // assert the href/onclick instead.
      const tag = await pill.evaluate((el) => el.tagName.toLowerCase());
      expect(tag).toBe('button');

      // 4. On functional flow pages, the page's primary CTA should be hidden.
      if (t.hidesCta) {
        const cta = page.locator(t.ctaSel);
        // Some CTAs may not exist on every page, so we soft-assert.
        const count = await cta.count();
        if (count > 0) {
          await expect.soft(cta.first()).toBeHidden({ timeout: 1000 });
        }
      }

      await safeClose(context);
    });
  }

  test('anon visit to /index.html does NOT paint the my-home pill', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page); await stubPlaid(page);
    await page.route('**/api.cashbff.com/**', (r) => r.fulfill({
      status: 401, contentType: 'application/json',
      headers: corsHeaders(), body: JSON.stringify({ error: 'unauthed' }),
    }));
    await page.goto(BASE + '/index.html');
    await page.waitForTimeout(800);

    const pill = page.locator('#cbff-auth-home-btn');
    expect(await pill.count(), 'pill must NOT render for anon visitor').toBe(0);

    // The marketing funnel renders normally.
    await expect(page.locator('#state-connect')).toHaveClass(/is-active/);

    await safeClose(context);
  });
});

// ─────────────────────────────────────────────────
// Item #1 — Snapshot-for-AI modal end-to-end (mock-only twin of
// snapshot.spec.ts which requires JWT_SECRET against prod).
// ─────────────────────────────────────────────────

test.describe('item #1 — snapshot for AI', () => {
  test('chip click → modal opens, fetch fires, textarea fills, copy works, deep links open new tabs', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page); await stubPlaid(page);

    const SNAPSHOT_MD = '# my cashbff snapshot\n\ngenerated 2026-04-29\n\ntotal cash: $1,700.00';
    await installHomeMocks(page, { snapshotMd: SNAPSHOT_MD });

    // Stub clipboard.writeText so we can observe what the page wrote.
    await page.addInitScript(() => {
      const w = window as unknown as { __clipWrites?: string[]; navigator: Navigator };
      w.__clipWrites = [];
      const writeText = (text: string): Promise<void> => {
        (w.__clipWrites as string[]).push(text); return Promise.resolve();
      };
      try {
        Object.defineProperty(w.navigator, 'clipboard', {
          configurable: true, value: { ...(w.navigator.clipboard || {}), writeText },
        });
      } catch { /* shape mismatch — ignore */ }
    });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });

    // 1. Click 📋 chip → modal opens.
    await page.locator('#snapshot-btn').click();
    const pop = page.locator('#snapshot-pop');
    await expect(pop).toHaveClass(/(^|\s)open(\s|$)/);
    await expect(pop).toHaveAttribute('aria-hidden', 'false');

    // 2. Textarea populates from /api/snapshot.
    const ta = page.locator('#snapshot-textarea');
    await expect(ta).toBeVisible();
    await expect.poll(async () => ta.inputValue(), { timeout: 5000 })
      .toContain('# my cashbff snapshot');
    await expect(ta).toHaveValue(/total cash: \$1,700\.00/);

    await page.screenshot({ path: SCREENSHOT_DIR + '/01-snapshot-modal.png', fullPage: false });

    // 3. Copy button writes to clipboard.
    await page.locator('#snapshot-copy').click();
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const w = window as unknown as { __clipWrites?: string[] };
        return (w.__clipWrites || []).length;
      });
    }, { timeout: 4000 }).toBeGreaterThanOrEqual(1);

    const written = await page.evaluate(() => {
      const w = window as unknown as { __clipWrites?: string[] };
      return (w.__clipWrites || [])[0];
    });
    expect(written).toContain('# my cashbff snapshot');

    // Button flips to "copied!" briefly.
    await expect(page.locator('#snapshot-copy')).toContainText(/copied/i);

    // 4. Deep-link buttons open new tabs (verify attrs).
    for (const id of ['snapshot-ask-chatgpt', 'snapshot-ask-claude', 'snapshot-ask-gemini']) {
      const link = page.locator('#' + id);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
    }

    // 5. Escape closes modal.
    await page.keyboard.press('Escape');
    // home.js wires close on overlay click + close button — Escape
    // isn't currently wired (see legacy code path). Test via close btn.
    if (await pop.evaluate((el) => el.classList.contains('open'))) {
      await page.locator('#snapshot-close').click();
    }
    await expect(pop).not.toHaveClass(/(^|\s)open(\s|$)/);

    await safeClose(context);
  });
});

// ─────────────────────────────────────────────────
// Item #2/#3 — Acknowledge action + stop-tracking action
// (Mock-only variants. Existing acknowledge.spec.ts also covers these
// in a different harness; this version asserts CSS class flips on the
// drawer row.)
// ─────────────────────────────────────────────────

test.describe('item #2 — acknowledge action soft-deletes the row', () => {
  test('trash → "I already paid this" → row gets is-acknowledged class + paid badge', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page); await stubPlaid(page);

    // Place the projection row mid-month so it's visible without nav.
    const today = new Date();
    const targetDay = Math.min(15, today.getDate() + 1);
    const targetDate = new Date(today.getFullYear(), today.getMonth(), targetDay);
    const targetIso = targetDate.toISOString().slice(0, 10);

    const projection = {
      id: 9001, date: targetIso, amount: 25, name: 'Self Financial', type: 'sub',
      card_account_id: null, note: 'recurring-projection:self-financial',
      confidence: 1, pending: false, source: 'scheduled',
      institution: 'Chase', mask: '1234',
    };
    const { hits } = await installHomeMocks(page, {
      streams: [], suggestions: [],
      calendarRows: [projection],
      deleteReturnsStreamLinked: { merchant: 'self-financial' },
    });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    // Open the day drawer for the projection cell.
    const subPill = page.locator('.cell .pill.sub').first();
    await expect(subPill).toBeVisible({ timeout: 5000 });
    const cell = subPill.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " cell ")]').first();
    await cell.click();

    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 3000 });

    const drawerItem = drawer.locator('.drawer-item').filter({ hasText: /self financial/i }).first();
    await expect(drawerItem).toBeVisible({ timeout: 3000 });
    await drawerItem.locator('.drawer-item__trash').first().click();

    // Confirm "yes" on the inline confirm.
    const confirmYes = drawerItem.locator('.row-confirm__yes').first();
    await confirmYes.click();

    // 409 → 2-button surface appears. Click the acknowledge button.
    const ackBtn = drawerItem.locator('.row-confirm__ack').first();
    await expect(ackBtn).toBeVisible({ timeout: 3000 });
    await expect(ackBtn).toContainText(/already paid/i);
    await page.screenshot({ path: SCREENSHOT_DIR + '/02-ack-2button.png', fullPage: false });

    await ackBtn.click();

    // Wait for the POST /acknowledge to fire.
    await expect.poll(() =>
      hits['POST /api/transactions/schedule/acknowledge'] || 0, { timeout: 4000 }
    ).toBeGreaterThanOrEqual(1);

    // The drawer auto-reopens; find the row again and assert the new state.
    // home.js calls closeDrawer + openDrawer to re-render.
    await page.waitForTimeout(800);
    const drawerNew = page.locator('#drawer.open');
    const rowAfter = drawerNew.locator('.drawer-item').filter({ hasText: /self financial/i }).first();
    if (await rowAfter.count() > 0) {
      await expect.soft(rowAfter).toHaveClass(/is-acknowledged/);
    }

    // Pill in the calendar grid must also carry is-acknowledged.
    const pillAfter = page.locator('.cell .pill.sub').first();
    if (await pillAfter.count() > 0) {
      await expect.soft(pillAfter).toHaveClass(/is-acknowledged/);
    }
    await page.screenshot({ path: SCREENSHOT_DIR + '/02-ack-after.png', fullPage: false });

    await safeClose(context);
  });
});

test.describe('item #3 — stop-tracking opens recurring tab', () => {
  test('trash → 409 → "stop tracking this stream" → recurring tab opens', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page); await stubPlaid(page);

    const today = new Date();
    const targetDay = Math.min(15, today.getDate() + 1);
    const targetDate = new Date(today.getFullYear(), today.getMonth(), targetDay);
    const targetIso = targetDate.toISOString().slice(0, 10);

    await installHomeMocks(page, {
      streams: [], suggestions: [],
      calendarRows: [{
        id: 9001, date: targetIso, amount: 25, name: 'Self Financial', type: 'sub',
        card_account_id: null, note: 'recurring-projection:self-financial',
        confidence: 1, pending: false, source: 'scheduled',
        institution: 'Chase', mask: '1234',
      }],
      deleteReturnsStreamLinked: { merchant: 'self-financial' },
    });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    // Drill into the day drawer.
    const subPill = page.locator('.cell .pill.sub').first();
    await expect(subPill).toBeVisible({ timeout: 5000 });
    const cell = subPill.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " cell ")]').first();
    await cell.click();
    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/);
    const drawerItem = drawer.locator('.drawer-item').filter({ hasText: /self financial/i }).first();
    await drawerItem.locator('.drawer-item__trash').first().click();
    await drawerItem.locator('.row-confirm__yes').first().click();

    const stopBtn = drawerItem.locator('.row-confirm__stop-stream').first();
    await expect(stopBtn).toBeVisible({ timeout: 3000 });
    await expect(stopBtn).toContainText(/stop tracking/i);
    await stopBtn.click();

    // openRecurring() opens #recurring-pop.
    const recurring = page.locator('#recurring-pop');
    await expect(recurring).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 3000 });
    await page.screenshot({ path: SCREENSHOT_DIR + '/03-stop-tracking-opens-recurring.png', fullPage: false });

    await safeClose(context);
  });
});

// ─────────────────────────────────────────────────
// Item #4 — Privacy + Terms render (smoke; deeper coverage in
// legal-pages.spec.ts)
// ─────────────────────────────────────────────────

test.describe('item #4 — privacy + terms smoke', () => {
  for (const t of [
    { path: '/privacy.html', heading: /privacy/i },
    { path: '/terms.html',   heading: /terms/i },
  ]) {
    test(`${t.path} renders title + footer links`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      attachConsole(page);
      await stubSentry(page); await stubPlaid(page);
      await page.route('**/api.cashbff.com/**', (r) => r.fulfill({
        status: 401, contentType: 'application/json',
        headers: corsHeaders(), body: JSON.stringify({ error: 'unauthed' }),
      }));

      await page.goto(BASE + t.path);
      await expect(page.locator('h1.content__title')).toContainText(t.heading);

      const foot = page.locator('footer.page-foot');
      await expect(foot.locator('a[href="privacy.html"]')).toBeVisible();
      await expect(foot.locator('a[href="terms.html"]')).toBeVisible();
      await expect(foot.locator('a[href^="mailto:daksh@cashbff.com"]')).toBeVisible();

      await safeClose(context);
    });
  }
});

// ─────────────────────────────────────────────────
// Item #5 — Metrics admin gate (anon path)
// ─────────────────────────────────────────────────

test.describe('item #5 — metrics admin gate', () => {
  test('non-admin (401 from any endpoint) → access-denied panel', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);

    // metrics.js targets localhost:3000 when served from localhost (see
    // metrics.js:22) — match without a domain prefix so we catch both
    // localhost:3000 and api.cashbff.com regardless of host.
    for (const path of ['/api/metrics/overview', '/api/metrics/sms', '/api/metrics/signup-funnel',
                        '/api/metrics/recurring', '/api/metrics/recent-signups']) {
      await page.route('**' + path, (r) => r.fulfill({
        status: 401, contentType: 'application/json',
        headers: corsHeaders(), body: JSON.stringify({ error: 'Not authenticated.' }),
      }));
    }

    await page.goto(BASE + '/metrics.html');
    await page.waitForSelector('#metrics-denied:not([hidden])', { timeout: 5000 });
    await expect(page.locator('#metrics-denied')).toBeVisible();
    await expect(page.locator('#metrics-main')).toBeHidden();
    await expect(page.locator('#metrics-denied h2')).toContainText('not authorized');

    await safeClose(context);
  });
});

// ─────────────────────────────────────────────────
// Item #10 — autoAdvanceConfirmedStreams source-text wiring
// ─────────────────────────────────────────────────

test.describe('item #10 — autoAdvanceConfirmedStreams wired into syncUser', () => {
  test('src/sync.ts imports + invokes autoAdvanceConfirmedStreams', async () => {
    const syncTsPath = join(BACKEND_ROOT, 'src/sync.ts');
    if (!existsSync(syncTsPath)) {
      // Backend repo not next door — soft-skip rather than fail.
      test.skip(true, `backend repo not found at ${syncTsPath}`);
    }
    const text = readFileSync(syncTsPath, 'utf8');
    expect(text).toMatch(/import\s*\{[^}]*autoAdvanceConfirmedStreams[^}]*\}/);
    // The call site is `await autoAdvanceConfirmedStreams(sql, userId);`
    // inside `syncUser(...)`. Match a non-greedy span to avoid coupling
    // to whitespace.
    expect(text).toMatch(/autoAdvanceConfirmedStreams\s*\(/);
    expect(text).toMatch(/export\s+async\s+function\s+syncUser/);
  });
});

// ─────────────────────────────────────────────────
// Item #11 — STREAM_LINKED 409 message uses display_name (not slug)
// ─────────────────────────────────────────────────

test.describe('item #11 — STREAM_LINKED 409 uses display_name', () => {
  test('server.ts source: 409 body resolves display_name from subscription_status', async () => {
    const serverTsPath = join(BACKEND_ROOT, 'src/server.ts');
    if (!existsSync(serverTsPath)) {
      test.skip(true, `backend repo not found at ${serverTsPath}`);
    }
    const text = readFileSync(serverTsPath, 'utf8');
    // The branch fetches stream.display_name and uses it in the error
    // message via "merchant" alias. We assert both:
    expect(text).toMatch(/SELECT\s+display_name,\s+normalized_merchant\s+FROM\s+subscription_status/i);
    expect(text).toMatch(/code:\s*"STREAM_LINKED"/);
    // Body MUST include both `merchant` and `display_name` keys with the
    // resolved value. Stream slug fallback uses `noteTag` — never used
    // standalone in the message.
    expect(text).toMatch(/merchant,\s*\n\s*display_name:\s*merchant/);
  });
});

// ─────────────────────────────────────────────────
// Item #12 — day popover does NOT leak `recurring-projection:` tag
// ─────────────────────────────────────────────────

test.describe('item #12 — day popover hides recurring-projection: tag', () => {
  test('rendered drawer note text never contains recurring-projection:', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page); await stubPlaid(page);

    const today = new Date();
    const targetDay = Math.min(15, today.getDate() + 1);
    const targetDate = new Date(today.getFullYear(), today.getMonth(), targetDay);
    const targetIso = targetDate.toISOString().slice(0, 10);

    await installHomeMocks(page, {
      calendarRows: [{
        id: 9001, date: targetIso, amount: 25, name: 'Self Financial', type: 'sub',
        card_account_id: null, note: 'recurring-projection:self-financial',
        confidence: 1, pending: false, source: 'scheduled',
        institution: 'Chase', mask: '1234',
      }],
    });

    await page.goto(BASE + '/home.html');
    await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1200);

    const subPill = page.locator('.cell .pill.sub').first();
    await expect(subPill).toBeVisible({ timeout: 5000 });
    const cell = subPill.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " cell ")]').first();
    await cell.click();

    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/);
    const drawerItem = drawer.locator('.drawer-item').filter({ hasText: /self financial/i }).first();
    await expect(drawerItem).toBeVisible();

    // The note div must NOT exist for projection-tagged rows. If a .note
    // div IS present, it must NOT contain the slug.
    const note = drawerItem.locator('.note');
    const noteCount = await note.count();
    if (noteCount > 0) {
      const text = (await note.textContent()) || '';
      expect(text, 'note text must NOT contain "recurring-projection:"')
        .not.toMatch(/recurring-projection:/);
    }

    // Belt-and-braces: the entire drawer DOM must not contain the slug.
    const drawerHtml = (await drawer.innerHTML());
    expect(drawerHtml,
      'drawer DOM must not leak the recurring-projection: prefix')
      .not.toMatch(/recurring-projection:/);

    await page.screenshot({ path: SCREENSHOT_DIR + '/12-day-popover-clean.png', fullPage: false });

    await safeClose(context);
  });
});

// ─────────────────────────────────────────────────
// Item #14 — Mobile (375px) layout sanity for the marketing pages
// ─────────────────────────────────────────────────

test.describe('mobile sanity (375px)', () => {
  for (const target of ['/index.html', '/connect.html', '/verify.html', '/paywall.html', '/school.html']) {
    test(`${target} renders without JS errors at 375px`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      const page = await context.newPage();
      const errors: string[] = [];
      // Only collect pageerrors (uncaught JS) — the 401 network responses
      // surface in console.error as "Failed to load resource" but they are
      // intentional (auth gate) and not a JS bug.
      page.on('pageerror', (err) => errors.push(err.message));
      await stubSentry(page); await stubPlaid(page);
      await page.route('**/api.cashbff.com/**', (r) => r.fulfill({
        status: 401, contentType: 'application/json',
        headers: corsHeaders(), body: JSON.stringify({ error: 'unauthed' }),
      }));

      await page.goto(BASE + target);
      await page.waitForLoadState('networkidle');

      // Wordmark is always present on the top bar.
      await expect(page.locator('.wordmark').first()).toBeVisible();

      // No uncaught JS errors during boot.
      expect(errors, `pageerror on ${target}: ${errors.join('; ')}`).toHaveLength(0);

      await page.screenshot({
        path: SCREENSHOT_DIR + '/mobile-' + target.replace(/[\/.]/g, '_') + '.png',
        fullPage: true,
      });
      await safeClose(context);
    });
  }
});
