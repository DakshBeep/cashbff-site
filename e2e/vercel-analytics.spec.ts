// Phase 17 — Vercel Analytics + Speed Insights presence + cookielessness guard.
//
// This spec confirms two things on the static cashbff.com frontend:
//   1. The two stub-queue initializers (window.va, window.si) are wired up
//      after DOMContentLoaded — proving the new <script src=".../vercel-
//      analytics-init.js" defer> tags landed and parse cleanly.
//   2. NO cookies named `_va_*`, `_vercel_*`, or anything matching common
//      analytics tracker patterns are set as a side-effect of loading the
//      page — Vercel Analytics is supposed to be cookieless and we want a
//      regression alarm if that ever changes.
//
// We don't try to actually load `/_vercel/insights/script.js` or
// `/_vercel/speed-insights/script.js` here — those endpoints only exist
// in the Vercel runtime, not under a local `python3 -m http.server`.
// All 4xx for those scripts are stubbed to a no-op so the page loads
// cleanly without console-error spam.
//
// Mirrors the local-server harness from `e2e/posthog-cookies.spec.ts`.

import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/vercel-analytics');
const PORT = Number(process.env.VERCEL_ANALYTICS_PORT || 5191);
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

async function stubNetwork(page: Page) {
  // The /_vercel/* endpoints are Vercel-runtime-only; locally they 404.
  // Stub them to no-op JS so the page parse is clean.
  await page.route('**/_vercel/insights/script.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '/* stubbed Vercel Analytics script.js */',
    });
  });
  await page.route('**/_vercel/speed-insights/script.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '/* stubbed Vercel Speed Insights script.js */',
    });
  });
  // Same network stubs as posthog-cookies.spec.ts so the page loads
  // without firing real upstream calls.
  await page.route('**/api.cashbff.com/**', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': BASE },
      body: JSON.stringify({ error: 'unauthenticated' }),
    });
  });
  await page.route('**/js.sentry-cdn.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Sentry = window.Sentry || { onLoad: function(){}, init: function(){} };',
    });
  });
  await page.route('**/us-assets.i.posthog.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '/* stubbed posthog array.js */',
    });
  });
  await page.route('**/us.i.posthog.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });
}

const VERCEL_COOKIE_PATTERNS = [
  /^_va_/i,            // Speculative — Vercel Analytics cookie names if they ever start setting one.
  /^_vercel/i,
  /vercel/i,
];

test.describe('vercel-analytics', () => {
  test('window.va + window.si stubs are wired after DOMContentLoaded', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubNetwork(page);

    await page.goto(BASE + '/index.html');
    // The init files use `defer`, so they execute after DOMContentLoaded
    // but before window 'load'. Wait for full load to be safe.
    await page.waitForLoadState('load');

    const haveVa = await page.evaluate(() => typeof (window as unknown as { va: unknown }).va === 'function');
    const haveSi = await page.evaluate(() => typeof (window as unknown as { si: unknown }).si === 'function');

    expect(haveVa, 'window.va stub queue must be defined after page load').toBe(true);
    expect(haveSi, 'window.si stub queue must be defined after page load').toBe(true);

    await context.close();
  });

  test('no Vercel-flavored cookies are set (cookielessness regression guard)', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubNetwork(page);

    await page.goto(BASE + '/index.html');
    await page.waitForLoadState('load');
    // Give any deferred analytics one more tick to misbehave.
    await page.waitForTimeout(300);

    const cookies = await context.cookies();

    for (const cookie of cookies) {
      for (const pattern of VERCEL_COOKIE_PATTERNS) {
        expect(
          pattern.test(cookie.name),
          `Unexpected Vercel-flavored cookie found: ${cookie.name}`,
        ).toBe(false);
      }
    }

    await context.close();
  });
});
