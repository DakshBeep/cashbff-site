// Screenshot helper for the Snapshot for AI modal.
//
// Spins up a static http server over the repo root, navigates to home.html
// with /api/me + /api/snapshot mocked so the auth gate passes and the
// modal fills with sample Markdown, then dumps a fullPage screenshot.
//
// Not a regression test — purely visual proof for the spec deliverable.
// The leading underscore in the filename signals "supplemental, run on
// demand":
//
//   npx playwright test e2e/_snapshot-screenshot.spec.ts
//
// Output: test-results/snapshot-screenshot/snapshot-modal.png

import { test } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const OUT_DIR = resolve(REPO_ROOT, 'test-results/snapshot-screenshot');
const PORT = Number(process.env.SNAPSHOT_SHOT_PORT || 5186);
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

const SAMPLE_SNAPSHOT_MD = [
  '# my cashbff snapshot',
  '',
  'generated 2026-04-29 · everything below is mine, here\'s the picture',
  '',
  '## balance right now',
  'total cash: $1,742.18 (across 2 accounts)',
  '- bank of america ···1234: $1,242.18',
  '- chase ···5678: $500.00',
  '',
  '## recurring expenses i\'m tracking (next 30 days)',
  '| date | name | amount | frequency |',
  '|------|------|--------|-----------|',
  '| 2026-05-09 | Toyota Ach Lease | $526.01 | monthly |',
  '| 2026-05-10 | Spotify | $11.99 | monthly |',
  '| 2026-05-15 | Audible | $14.95 | monthly |',
  '| 2026-05-20 | Comcast Internet | $79.99 | monthly |',
  '',
  '## scheduled (one-off)',
  '| date | name | amount | type |',
  '|------|------|--------|------|',
  '| 2026-05-15 | dentist copay | $80.00 | bill |',
  '| 2026-05-22 | mom\'s birthday gift | $60.00 | planned |',
  '',
  '## last 30 days of transactions',
  '| date | merchant | amount | category |',
  '|------|----------|--------|----------|',
  '| 2026-04-28 | Whole Foods | -$42.18 | food and drink groceries |',
  '| 2026-04-27 | Shell | -$38.50 | transportation gas |',
  '| 2026-04-26 | Direct Deposit | $1,240.00 | income payroll |',
  '| 2026-04-25 | Trader Joe\'s | -$67.42 | food and drink groceries |',
  '| 2026-04-24 | Spotify | -$11.99 | entertainment subscriptions |',
  '',
  '## what i was thinking about asking',
  '(write your question here, then paste this all into chatgpt or claude)',
  '',
].join('\n');

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

test('snapshot modal · capture sample-data screenshot', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // Auth gate passes if /api/me returns 200.
  await page.route('**/api/me', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user_id: 'mock_user', phone: '+15555551234', signup_month: '2026-01' }),
    });
  });

  // Calendar / balances / wallet — return empty so the page boots without
  // hitting the production API. Snapshot is the one we care about.
  await page.route('**/api/calendar*', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ expenses: [] }) });
  });
  await page.route('**/api/balances', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accounts: [], summary: {} }) });
  });
  await page.route('**/api/wallet', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ plaid_accounts: [], tracked_accounts: [], summary: { total_owed: 0, total_in: 0, net: 0, spendable: 0 } }),
    });
  });
  await page.route('**/api/recurring/suggestions', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await page.route('**/api/recurring/streams', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await page.route('**/api/snapshot', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        snapshot: SAMPLE_SNAPSHOT_MD,
        generated_at: '2026-04-29T12:00:00Z',
      }),
    });
  });

  await page.goto(`${LOCAL_BASE}/home.html`, { waitUntil: 'domcontentloaded' });
  // Wait for the chip to render.
  await page.waitForSelector('#snapshot-btn', { timeout: 8000 });
  // Slight pause so the boot fetches settle and the page paints fully.
  await page.waitForTimeout(600);

  // Open the modal.
  await page.locator('#snapshot-btn').click();
  // Wait for the textarea to fill.
  await page.waitForFunction(() => {
    const el = document.getElementById('snapshot-textarea') as HTMLTextAreaElement | null;
    return !!(el && el.value && el.value.includes('# my cashbff snapshot'));
  }, { timeout: 5000 });
  await page.waitForTimeout(250); // let the open transition finish

  await page.screenshot({ path: `${OUT_DIR}/snapshot-modal.png`, fullPage: true });

  await ctx.close();
});
