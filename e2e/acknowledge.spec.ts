// Phase 10B — soft-delete + "✓ already paid" on stream-linked rows.
//
// Three flows under test:
//   1. Click trash on a stream-linked drawer row → 409 STREAM_LINKED →
//      assert BOTH inline buttons appear ("✓ I already paid this" +
//      "stop tracking this stream") + cancel.
//   2. Click "✓ I already paid this" → POST /acknowledge mock → assert
//      the row gets the .is-acknowledged class + line-through styling.
//   3. Click "stop tracking this stream" → recurring tab opens.
//
// Same harness as full-sweep.spec.ts: a python static server on the
// V4-proto repo root, all backend calls mocked via page.route. No JWT,
// no live backend, no Plaid/Stripe network — just deterministic stubs.

import { test, expect, type Page, type ConsoleMessage, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/acknowledge');
const PORT = Number(process.env.ACK_SPEC_PORT || 5187);
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

async function safeClose(context: BrowserContext) {
  try {
    await context.close();
  } catch (err) {
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

interface MockState {
  acknowledgeHits: number;
  ackOnce: boolean;
}

/** Install the minimum set of /api mocks needed to boot home.js and drive the
 *  trash → acknowledge flow. The 409 on DELETE returns the new actions array;
 *  the POST /acknowledge mock flips a counter so we can assert the call fired. */
async function installMocks(page: Page, state: MockState) {
  const targetIso = (() => {
    // Mid-month, in the current month, in the future so the row falls into
    // the projection window.
    const today = new Date();
    const day = Math.min(28, today.getDate() + 2);
    const targetDate = new Date(today.getFullYear(), today.getMonth(), day);
    return targetDate.toISOString().slice(0, 10);
  })();

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
    acknowledged: false,
  };

  await page.route('**/api.cashbff.com/api/me', async (route) => {
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
    // Reflect the acknowledged state once acknowledged_at has been flipped
    // — that's how the canonical refetch would behave on the live backend.
    const expense = state.ackOnce ? { ...projection, acknowledged: true } : projection;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ expenses: [expense] }),
    });
  });

  await page.route('**/api.cashbff.com/api/balances', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({
        accounts: [
          { account_id: 'a', account_type: 'depository', balance_available: 1000 },
        ],
        summary: {},
      }),
    });
  });

  await page.route('**/api.cashbff.com/api/cards', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ cards: [] }),
    });
  });

  await page.route('**/api.cashbff.com/api/wallet', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({
        plaid_accounts: [],
        tracked_accounts: [],
        summary: { running_balance_usd: 1000, total_in: 1000, total_owed: 0 },
      }),
    });
  });

  await page.route('**/api.cashbff.com/api/recurring/suggestions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ items: [] }),
    });
  });

  await page.route('**/api.cashbff.com/api/recurring/streams*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ items: [] }),
    });
  });

  await page.route('**/api.cashbff.com/api/reimbursements*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ items: [] }),
    });
  });

  // DELETE → 409 STREAM_LINKED with the new actions array.
  // POST /acknowledge → 200 with the row flipped to acknowledged.
  await page.route('**/api.cashbff.com/api/transactions/schedule/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === 'POST' && /\/acknowledge$/.test(url)) {
      state.acknowledgeHits += 1;
      state.ackOnce = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({
          ok: true,
          transaction: { ...projection, acknowledged: true },
        }),
      });
      return;
    }
    if (method === 'DELETE') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({
          error:
            'this is part of your "self-financial" recurring stream. mark it ✓ paid here to keep the reminder, OR open the recurring tab to set an end date.',
          code: 'STREAM_LINKED',
          merchant: 'self-financial',
          display_name: 'self-financial',
          actions: ['acknowledge', 'stop_stream'],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true }),
    });
  });

  return projection;
}

async function openDrawerOnProjectionDay(page: Page) {
  await expect(page.locator('#grid')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);

  const subPill = page.locator('.cell .pill.sub').first();
  await expect(subPill).toBeVisible({ timeout: 5000 });
  const cell = subPill.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " cell ")]',
  ).first();
  await cell.click();

  const drawer = page.locator('#drawer');
  await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/, { timeout: 3000 });
  return drawer;
}

test.describe('Phase 10B — acknowledge soft-delete', () => {
  test('409 STREAM_LINKED renders both inline buttons + cancel', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    const state: MockState = { acknowledgeHits: 0, ackOnce: false };
    await installMocks(page, state);

    await page.goto(BASE + '/home.html');
    const drawer = await openDrawerOnProjectionDay(page);

    const drawerItem = drawer
      .locator('.drawer-item')
      .filter({ hasText: /self financial/i })
      .first();
    await expect(drawerItem).toBeVisible();

    // Open the inline confirm.
    await drawerItem.locator('.drawer-item__trash').first().click();
    // First click triggers the regular "delete this? · yes · cancel".
    const yesBtn = drawerItem.locator('.row-confirm__yes').first();
    await expect(yesBtn).toBeVisible();
    await yesBtn.click();

    // Wait for the 409 → 2-button surface to swap in.
    await page.waitForTimeout(700);

    const ackBtn = drawerItem.locator('.row-confirm__ack');
    const stopBtn = drawerItem.locator('.row-confirm__stop-stream');
    const cancelBtn = drawerItem.locator('.row-confirm__no');

    await expect(ackBtn).toBeVisible();
    await expect(stopBtn).toBeVisible();
    await expect(cancelBtn).toBeVisible();
    await expect(ackBtn).toContainText(/already paid/i);
    await expect(stopBtn).toContainText(/stop tracking/i);

    await page.screenshot({
      path: SCREENSHOT_DIR + '/01-two-button-surface.png',
      fullPage: true,
    });

    await safeClose(context);
  });

  test('clicking ✓ I already paid this → POST /acknowledge → row gets is-acknowledged styling', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    const state: MockState = { acknowledgeHits: 0, ackOnce: false };
    await installMocks(page, state);

    await page.goto(BASE + '/home.html');
    let drawer = await openDrawerOnProjectionDay(page);

    let drawerItem = drawer
      .locator('.drawer-item')
      .filter({ hasText: /self financial/i })
      .first();
    await drawerItem.locator('.drawer-item__trash').first().click();
    await drawerItem.locator('.row-confirm__yes').first().click();
    await page.waitForTimeout(600);

    // Click "✓ I already paid this".
    await drawerItem.locator('.row-confirm__ack').click();
    // Wait for the in-flight POST + the drawer re-render.
    await expect.poll(() => state.acknowledgeHits, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(700);

    // After ack: home.js calls closeDrawer(); openDrawer(d) so the row
    // re-renders with the .is-acknowledged class and the "✓ paid" badge.
    drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/(^|\s)open(\s|$)/);
    drawerItem = drawer
      .locator('.drawer-item.is-acknowledged')
      .filter({ hasText: /self financial/i })
      .first();
    await expect(drawerItem).toBeVisible({ timeout: 3000 });

    // Line-through is applied to the .name child via CSS — assert the
    // computed style picks it up.
    const nameDecoration = await drawerItem.locator('.name').evaluate((el) => {
      return getComputedStyle(el).textDecorationLine;
    });
    expect(nameDecoration).toContain('line-through');

    // Badge is present.
    await expect(drawerItem.locator('.ack-badge')).toContainText(/✓ paid/);

    await page.screenshot({
      path: SCREENSHOT_DIR + '/02-acknowledged-row.png',
      fullPage: true,
    });

    await safeClose(context);
  });

  test('clicking stop tracking this stream → opens recurring tab', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await stubSentry(page);
    await stubPlaid(page);

    const state: MockState = { acknowledgeHits: 0, ackOnce: false };
    await installMocks(page, state);

    await page.goto(BASE + '/home.html');
    const drawer = await openDrawerOnProjectionDay(page);

    const drawerItem = drawer
      .locator('.drawer-item')
      .filter({ hasText: /self financial/i })
      .first();
    await drawerItem.locator('.drawer-item__trash').first().click();
    await drawerItem.locator('.row-confirm__yes').first().click();
    await page.waitForTimeout(600);

    await drawerItem.locator('.row-confirm__stop-stream').click();

    // Recurring popover opens.
    await expect(page.locator('#recurring-pop')).toHaveClass(
      /(^|\s)open(\s|$)/,
      { timeout: 3000 },
    );

    await page.screenshot({
      path: SCREENSHOT_DIR + '/03-stop-tracking-opens-recurring.png',
      fullPage: true,
    });

    expect(state.acknowledgeHits).toBe(0);

    await safeClose(context);
  });
});
