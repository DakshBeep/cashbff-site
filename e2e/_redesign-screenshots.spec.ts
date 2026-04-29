// Phase 11 — capture screenshots of the redesigned index.html and
// school.html in the V4-original visual language. Mocks /api/me to 401 so
// the marketing funnel renders in its hero state for both desktop (1280×900)
// and mobile (375×800). Saves to test-results/redesign/.
//
// Filename starts with `_` to match the existing convention for screenshot
// helpers in this folder (see `_phase9a-screenshots.spec.ts`,
// `_snapshot-screenshot.spec.ts`) — these specs document the redesign
// visually and run alongside the regular e2e suite.
//
// Spins up `python3 -m http.server` locally — same approach as the other
// e2e specs in this folder.

import { test } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/redesign');
const PORT = Number(process.env.REDESIGN_PORT || 5189);
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
    'access-control-allow-origin': '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
}

// Mock all API + Sentry + Plaid + Stripe CDNs so no network calls leak.
// /api/me 401 keeps both marketing pages in their hero state.
async function installMocks(page: import('@playwright/test').Page) {
  await page.route('**/api.cashbff.com/**', (route) => {
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'unauthed' }),
    });
  });
  await page.route('**/js.sentry-cdn.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Sentry = window.Sentry || { onLoad: function(){}, init: function(){} };',
    });
  });
  await page.route('**/cdn.plaid.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Plaid = { create: function(){ return { open: function(){}, exit: function(){}, destroy: function(){} }; } };',
    });
  });
  await page.route('**/js.stripe.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Stripe = function(){ return { elements: function(){ return { create: function(){ return { mount: function(){}, unmount: function(){} }; } }; }, confirmSetup: function(){ return Promise.resolve({ setupIntent: { status: "succeeded" } }); } }; };',
    });
  });
}

test.describe('Phase 11 redesign — screenshot capture', () => {
  test('index.html @ desktop 1280x900', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(BASE + '/index.html');
    // Wait for the entrance animation to settle (card 0.9s + copy 0.7s @ 0.7s
    // delay = ~1.4s total).
    await page.waitForTimeout(1600);
    await page.screenshot({ path: SCREENSHOT_DIR + '/index-desktop.png', fullPage: false });
    await context.close();
  });

  test('index.html @ mobile 375x800', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(BASE + '/index.html');
    await page.waitForTimeout(1600);
    await page.screenshot({ path: SCREENSHOT_DIR + '/index-mobile.png', fullPage: true });
    await context.close();
  });

  test('school.html @ desktop 1280x900', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(BASE + '/school.html');
    await page.waitForTimeout(1600);
    await page.screenshot({ path: SCREENSHOT_DIR + '/school-desktop.png', fullPage: true });
    await context.close();
  });

  test('school.html @ mobile 375x800', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(BASE + '/school.html');
    await page.waitForTimeout(1600);
    await page.screenshot({ path: SCREENSHOT_DIR + '/school-mobile.png', fullPage: true });
    await context.close();
  });
});
