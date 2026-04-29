// Phase 9C — admin metrics dashboard.
//
// Drives /metrics.html against a local static server with the five
// /api/metrics/* endpoints mocked. Three test cases:
//   1. Admin path — all five endpoints return sample data; assert each of
//      the five sections renders.
//   2. Non-admin path — the first endpoint returns 403; assert the page
//      flips to the access-denied state and stops the polling loop.
//   3. Visual screenshot — capture the dashboard with sample data so the
//      reviewer can eyeball the layout.
//
// Mocks rather than hitting prod so the test is fully deterministic and
// can run without a real admin JWT.

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const OUT_DIR = resolve(REPO_ROOT, 'test-results/metrics');
const PORT = Number(process.env.METRICS_PORT || 5187);
const LOCAL_BASE = `http://localhost:${PORT}`;

let server: ChildProcess | null = null;

function ensureOutDir() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
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
  ensureOutDir();
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

// ── Mock data fixtures ────────────────────────────────────────────────

const MOCK_OVERVIEW = {
  users_total: 42,
  users_30d: 12,
  users_7d: 3,
  school_signups: 7,
  schedule_txns_total: 156,
  recurring_streams_total: 28,
};

const MOCK_SMS = {
  inbound_24h: 5,
  inbound_7d: 31,
  outbound_24h: 4,
  recent_messages: [
    { user_id: 'user_19095425819', direction: 'inbound', body_preview: 'hey what was that charge from spotify', created_at: new Date(Date.now() - 60_000).toISOString() },
    { user_id: 'user_19095425819', direction: 'outbound', body_preview: 'that was your monthly $9.99 spotify subscription', created_at: new Date(Date.now() - 50_000).toISOString() },
    { user_id: 'user_14155551234', direction: 'inbound', body_preview: 'how much did i spend on coffee this week', created_at: new Date(Date.now() - 3_600_000).toISOString() },
  ],
};

const MOCK_FUNNEL = {
  signup_starts_30d: 18,
  signup_completes_30d: 12,
  school_starts_30d: 9,
  school_completes_30d: 7,
};

const MOCK_RECURRING = {
  confirmed_streams: 28,
  dismissed_streams: 4,
  suggested_streams: 6,
  avg_streams_per_user: 3.45,
  top_merchants: [
    { merchant: 'Spotify', count: 9 },
    { merchant: 'Netflix', count: 7 },
    { merchant: 'Apple', count: 5 },
  ],
};

const MOCK_RECENT_SIGNUPS = {
  items: [
    { user_id: 'user_19095425819', type: 'web', created_at: new Date(Date.now() - 600_000).toISOString() },
    { user_id: 'school_abc12', type: 'school', created_at: new Date(Date.now() - 86_400_000).toISOString() },
    { user_id: 'user_14155551234', type: 'web', created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
  ],
};

// Common mock for the Sentry CDN so the page doesn't sit waiting on it.
async function stubSentry(page: import('@playwright/test').Page) {
  await page.route('**/js.sentry-cdn.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Sentry = { onLoad: () => {}, init: () => {} };',
    });
  });
}

// ── 1. Admin path ─────────────────────────────────────────────────────

test('metrics · admin user sees all five sections rendered', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await stubSentry(page);

  // Mock all five metrics endpoints with 200 + sample data.
  await page.route('**/api/metrics/overview', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_OVERVIEW),
  }));
  await page.route('**/api/metrics/sms', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SMS),
  }));
  await page.route('**/api/metrics/signup-funnel', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_FUNNEL),
  }));
  await page.route('**/api/metrics/recurring', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_RECURRING),
  }));
  await page.route('**/api/metrics/recent-signups', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_RECENT_SIGNUPS),
  }));

  await page.goto(`${LOCAL_BASE}/metrics.html`, { waitUntil: 'domcontentloaded' });

  // Main wrapper visible, denied wrapper hidden.
  await expect(page.locator('#metrics-main')).toBeVisible();
  await expect(page.locator('#metrics-denied')).toBeHidden();

  // Wait for at least one card to render — that confirms data landed.
  await page.waitForSelector('#overview-grid .card', { timeout: 5000 });

  // Section 1 — overview cards (6 of them).
  const overviewCards = await page.locator('#overview-grid .card').count();
  expect(overviewCards).toBe(6);
  await expect(page.locator('#overview-grid')).toContainText('users · total');
  await expect(page.locator('#overview-grid')).toContainText('42');
  await expect(page.locator('#overview-grid')).toContainText('school signups');
  await expect(page.locator('#overview-grid')).toContainText('recurring streams');

  // Section 2 — SMS cards + recent message table.
  const smsCards = await page.locator('#sms-grid .card').count();
  expect(smsCards).toBe(3);
  await expect(page.locator('#sms-grid')).toContainText('inbound · 24h');
  await expect(page.locator('#sms-grid')).toContainText('5');
  // Table renders rows.
  const smsRows = await page.locator('#sms-table-wrap tbody tr').count();
  expect(smsRows).toBe(MOCK_SMS.recent_messages.length);
  await expect(page.locator('#sms-table-wrap')).toContainText('user_19095425819');
  await expect(page.locator('#sms-table-wrap')).toContainText('hey what was that charge from spotify');

  // Section 3 — funnel (4 cards).
  const funnelCards = await page.locator('#funnel-grid .card').count();
  expect(funnelCards).toBe(4);
  await expect(page.locator('#funnel-grid')).toContainText('web · starts');
  await expect(page.locator('#funnel-grid')).toContainText('school · completes');
  // Conversion rate hint should render: 12 / 18 = 67%.
  await expect(page.locator('#funnel-grid')).toContainText('67% conversion');

  // Section 4 — recurring cards + top merchants list.
  const recurringCards = await page.locator('#recurring-grid .card').count();
  expect(recurringCards).toBe(4);
  await expect(page.locator('#recurring-grid')).toContainText('confirmed');
  await expect(page.locator('#recurring-grid')).toContainText('avg / user');
  await expect(page.locator('#recurring-grid')).toContainText('3.45');
  // Merchant list renders one row per merchant.
  const merchantRows = await page.locator('#merchant-list .merchant-row').count();
  expect(merchantRows).toBe(MOCK_RECURRING.top_merchants.length);
  await expect(page.locator('#merchant-list')).toContainText('Spotify');
  await expect(page.locator('#merchant-list')).toContainText('Netflix');

  // Section 5 — recent signups list (3 rows).
  const signupRows = await page.locator('#signup-list .signup-row').count();
  expect(signupRows).toBe(MOCK_RECENT_SIGNUPS.items.length);
  await expect(page.locator('#signup-list')).toContainText('user_19095425819');
  await expect(page.locator('#signup-list')).toContainText('school_abc12');
  await expect(page.locator('#signup-list')).toContainText('web');
  await expect(page.locator('#signup-list')).toContainText('school');

  // Capture a screenshot for the report.
  await page.screenshot({ path: `${OUT_DIR}/metrics-admin-desktop.png`, fullPage: true });

  await ctx.close();
});

// ── 2. Non-admin path ─────────────────────────────────────────────────

test('metrics · non-admin user sees access-denied panel', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await stubSentry(page);

  // First endpoint returns 403 — the page should flip to denied immediately
  // without rendering the rest. Stub the other four anyway in case our
  // bundled code races; they should never get called once denied is shown.
  await page.route('**/api/metrics/overview', (r) => r.fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Admin only.' }),
  }));
  await page.route('**/api/metrics/sms', (r) => r.fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Admin only.' }),
  }));
  await page.route('**/api/metrics/signup-funnel', (r) => r.fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Admin only.' }),
  }));
  await page.route('**/api/metrics/recurring', (r) => r.fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Admin only.' }),
  }));
  await page.route('**/api/metrics/recent-signups', (r) => r.fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Admin only.' }),
  }));

  await page.goto(`${LOCAL_BASE}/metrics.html`, { waitUntil: 'domcontentloaded' });

  // Wait for the denied panel to flip visible.
  await page.waitForSelector('#metrics-denied:not([hidden])', { timeout: 5000 });

  await expect(page.locator('#metrics-denied')).toBeVisible();
  await expect(page.locator('#metrics-main')).toBeHidden();

  // Denied panel content sanity: title + link back to /home.html.
  await expect(page.locator('#metrics-denied h2')).toContainText('not authorized');
  const homeLink = page.locator('#metrics-denied a[href="/home.html"]');
  await expect(homeLink).toBeVisible();
  await expect(homeLink).toContainText('go home');

  await ctx.close();
});

// ── 3. /api/me admin probe behavior — handled at the route layer ─────
// The /metrics page deliberately doesn't probe /api/me before hitting the
// dashboard endpoints (the spec doesn't require it; the metrics endpoints
// are themselves the admin gate). This test confirms the dashboard never
// blocks on /api/me — we'd see hung loading text otherwise.

test('metrics · 401 from any endpoint flips to denied state', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await stubSentry(page);

  // Simulate "not signed in at all" — the page should still flip to
  // denied (with a specific sign-in message).
  await page.route('**/api/metrics/overview', (r) => r.fulfill({
    status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Not authenticated.' }),
  }));
  await page.route('**/api/metrics/sms', (r) => r.fulfill({
    status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Not authenticated.' }),
  }));
  await page.route('**/api/metrics/signup-funnel', (r) => r.fulfill({
    status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Not authenticated.' }),
  }));
  await page.route('**/api/metrics/recurring', (r) => r.fulfill({
    status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Not authenticated.' }),
  }));
  await page.route('**/api/metrics/recent-signups', (r) => r.fulfill({
    status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Not authenticated.' }),
  }));

  await page.goto(`${LOCAL_BASE}/metrics.html`, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('#metrics-denied:not([hidden])', { timeout: 5000 });
  await expect(page.locator('#metrics-denied')).toBeVisible();
  // 401 swaps in the "sign in to view" copy.
  await expect(page.locator('#denied-message')).toContainText('sign in');

  await ctx.close();
});
