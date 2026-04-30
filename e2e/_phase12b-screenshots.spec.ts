// Phase 12B. capture school.html screenshots after em-dash sweep + sub-copy
// + parent-consent shortening. Mirrors `_phase12a-screenshots.spec.ts` but
// writes to test-results/phase12b/ and only shoots the school page (desktop
// + mobile). /api/me is mocked to 401 so the funnel renders in state-form.
//
// Filename starts with `_` to match the existing screenshot-helper convention
// in this folder.

import { test } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/phase12b');
const PORT = Number(process.env.PHASE12B_PORT || 5192);
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
  await page.route('**/js.stripe.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Stripe = function(){ return { elements: function(){ return { create: function(){ return { mount: function(){}, on: function(){} }; } }; }, confirmSetup: function(){ return Promise.resolve({ setupIntent: { id: "x" } }); } }; };',
    });
  });
}

test.describe('Phase 12B. school copy + em-dash sweep', () => {
  test('school.html @ desktop 1280x900', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(BASE + '/school.html');
    // Wait for entrance animations to settle.
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
