// Phase 12A — capture index.html screenshots after the new headline +
// left-aligned hero copy land. Mirrors `_redesign-screenshots.spec.ts` but
// writes to test-results/phase12a/ and only shoots the index page (desktop
// + mobile). /api/me is mocked to 401 so the funnel renders in its hero
// (state-connect) state.
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
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/phase12a');
const PORT = Number(process.env.PHASE12A_PORT || 5191);
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
  await page.route('**/cdn.plaid.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Plaid = { create: function(){ return { open: function(){}, exit: function(){}, destroy: function(){} }; } };',
    });
  });
}

test.describe('Phase 12A — new headline + left-aligned hero', () => {
  test('index.html @ desktop 1280x900', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(BASE + '/index.html');
    // Wait for entrance animations to settle (~1.4s).
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
});
