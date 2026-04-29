// Phase 9A — manual smoke screenshots.
//
// Drives every affected page with /api/me mocked to 200 so the auth-home
// pill is visible, then dumps a fullPage screenshot for each at desktop +
// mobile (375px) viewports. Not a regression test — purely visual proof
// that the pill renders consistently across pages and that the
// "you're already signed in" note replaces the form on functional flow
// pages.
//
// The leading underscore in the filename signals "supplemental, not a
// gate." Run explicitly:
//   npx playwright test e2e/_phase9a-screenshots.spec.ts
//
// Output: test-results/phase9a/<page>-{desktop,mobile}.png

import { test } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const OUT_DIR = resolve(REPO_ROOT, 'test-results/phase9a');
const PORT = Number(process.env.PHASE9A_PORT || 5185);
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

const PAGES = [
  { path: '/index.html',                   name: 'index' },
  { path: '/school.html',                  name: 'school' },
  { path: '/school-login.html',            name: 'school-login' },
  { path: '/verify.html?phone=5555550100', name: 'verify' },
  { path: '/connect.html',                 name: 'connect' },
  { path: '/paywall.html',                 name: 'paywall' },
  { path: '/plan.html',                    name: 'plan' },
];

async function installCommonMocks(page: import('@playwright/test').Page, accountType: string) {
  await page.route('**/api/me', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user_id: accountType === 'school' ? 'school_1' : 1,
        account_type: accountType,
        phone: accountType === 'phone' ? '+15555550100' : null,
      }),
    });
  });
  await page.route('**/home.html', (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><h1 id="home-stub">home</h1></body></html>' });
  });
  // Stub Plaid / Stripe / Sentry CDN so external scripts don't slow the
  // screenshot loop (and so the pages don't try to actually init those SDKs).
  await page.route('**/cdn.plaid.com/**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.Plaid = { create: () => ({ open: () => {}, destroy: () => {} }) };' });
  });
  await page.route('**/js.stripe.com/**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.Stripe = function () { return { elements: () => ({ create: () => ({ mount: () => {} }) }), confirmSetup: () => Promise.resolve({}) }; };' });
  });
  await page.route('**/js.sentry-cdn.com/**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.Sentry = { onLoad: () => {}, init: () => {} };' });
  });
}

test('phase 9a · capture screenshots of all 7 pages (desktop + mobile)', async ({ browser }) => {
  for (const p of PAGES) {
    // Desktop pass.
    const dCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const dPage = await dCtx.newPage();
    // school-login routes off account_type === 'school'; everywhere else we
    // just need a 200.
    await installCommonMocks(dPage, p.name === 'school-login' ? 'school' : 'phone');
    await dPage.goto(`${LOCAL_BASE}${p.path}`, { waitUntil: 'domcontentloaded' });
    // Give the auth probe a moment to land + paint the pill.
    await dPage.waitForSelector('#cbff-auth-home-btn', { timeout: 5000 }).catch(() => {});
    await dPage.waitForTimeout(400);
    await dPage.screenshot({ path: `${OUT_DIR}/${p.name}-desktop.png`, fullPage: true });
    await dCtx.close();

    // Mobile pass (375px).
    const mCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const mPage = await mCtx.newPage();
    await installCommonMocks(mPage, p.name === 'school-login' ? 'school' : 'phone');
    await mPage.goto(`${LOCAL_BASE}${p.path}`, { waitUntil: 'domcontentloaded' });
    await mPage.waitForSelector('#cbff-auth-home-btn', { timeout: 5000 }).catch(() => {});
    await mPage.waitForTimeout(400);
    await mPage.screenshot({ path: `${OUT_DIR}/${p.name}-mobile.png`, fullPage: true });
    await mCtx.close();
  }
});
