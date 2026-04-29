// Phase 7C — Plaid-first onboarding funnel for cashbff.com.
//
// These tests run against a STATIC FILE SERVER spun up locally (no
// JWT_SECRET needed) and mock every backend call via page.route. Plaid's
// SDK is also mocked — we override window.Plaid with a fake `create()`
// that triggers the configured callbacks immediately.
//
// What's covered:
//   1. Auto-redirect: a user with a valid /api/me 200 lands on home.html
//      without ever seeing the funnel.
//   2. Happy path (new user): connect → exchange → phone → otp → home.
//   3. Plaid onExit voluntary: returns to State 1 with a friendly note.
//   4. Returning-user shortcut: phone → /api/otp/* → home.
//
// Screenshots of every state are saved to test-results/onboarding/.

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

// __dirname is not defined under ESM ("type": "module"); recover it from
// import.meta.url so we can resolve the V4-proto repo root.
const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/onboarding');
// Use a port outside the 5173 / 3000 range so we don't fight other dev
// servers a developer might have running.
const PORT = Number(process.env.ONBOARDING_PORT || 5183);
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
  // Python ships on every macOS dev box; this matches the manual workflow
  // in the task brief ("python3 -m http.server 5173 from V4-proto").
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

// ── Mock helpers ─────────────────────────────────
//
// All four specs share the same Plaid SDK mock + a baseline route map.
// Each spec layers in its own /api/me mock first so the auto-redirect
// branch behaves correctly.

interface MockOpts {
  // Whether /api/me should respond 200 (logged in) or 401 (anon).
  meStatus?: 200 | 401;
  // Plaid behavior: 'success' triggers onSuccess, 'exit-voluntary' triggers
  // onExit(null), 'exit-error' triggers onExit(err).
  plaidBehavior?: 'success' | 'exit-voluntary' | 'exit-error';
  institutionName?: string;
  // Optional capture map — every endpoint we mock pushes into this.
  hits?: Record<string, number>;
  payloads?: Record<string, unknown[]>;
}

async function installMocks(page: Page, opts: MockOpts = {}) {
  const meStatus = opts.meStatus ?? 401;
  const plaidBehavior = opts.plaidBehavior ?? 'success';
  const institutionName = opts.institutionName ?? 'Bank of America';
  const hits = opts.hits ?? {};
  const payloads = opts.payloads ?? {};

  function record(key: string, payload?: unknown) {
    hits[key] = (hits[key] || 0) + 1;
    if (payload !== undefined) {
      if (!payloads[key]) payloads[key] = [];
      payloads[key].push(payload);
    }
  }

  // ── IMPORTANT: registration order ────────────────
  // Playwright tries routes in REVERSE registration order (last registered
  // wins). We register the catch-all FIRST so the specific endpoints
  // registered below take precedence over it.
  await page.route('**/api.cashbff.com/**', async (route) => {
    record('UNHANDLED ' + route.request().method() + ' ' + route.request().url());
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'unhandled-mock' }),
    });
  });

  // /api/me — auto-redirect gate.
  await page.route('**/api.cashbff.com/api/me', async (route) => {
    record('GET /api/me');
    if (meStatus === 200) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({ user_id: 'mock_user', phone: '+19095425819' }),
      });
    } else {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'unauthenticated' }),
      });
    }
  });

  // /api/signup/start
  await page.route('**/api.cashbff.com/api/signup/start', async (route) => {
    record('POST /api/signup/start');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({
        link_token: 'link-sandbox-mock-12345',
        signup_id: 'signup_mock_1',
      }),
    });
  });

  // /api/signup/exchange
  await page.route('**/api.cashbff.com/api/signup/exchange', async (route) => {
    let body: unknown = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    record('POST /api/signup/exchange', body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, institution: institutionName }),
    });
  });

  // /api/signup/send-otp
  await page.route('**/api.cashbff.com/api/signup/send-otp', async (route) => {
    let body: unknown = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    record('POST /api/signup/send-otp', body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true }),
    });
  });

  // /api/signup/verify-otp
  await page.route('**/api.cashbff.com/api/signup/verify-otp', async (route) => {
    let body: unknown = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    record('POST /api/signup/verify-otp', body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, redirect: '/home.html' }),
    });
  });

  // /api/otp/* (returning-user shortcut — pre-Phase-7A endpoints)
  await page.route('**/api.cashbff.com/api/otp/send', async (route) => {
    let body: unknown = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    record('POST /api/otp/send', body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api.cashbff.com/api/otp/verify', async (route) => {
    let body: unknown = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    record('POST /api/otp/verify', body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, is_returning: true, has_email: true }),
    });
  });

  // Plaid SDK — replace the real CDN script with a stub that exposes a
  // deterministic `Plaid.create(...)` that fires our chosen callback. We
  // also short-circuit any other api.cashbff.com calls we didn't list to
  // avoid surprises.
  await page.route('**/cdn.plaid.com/link/v2/stable/link-initialize.js', async (route) => {
    const stub = `
      (function () {
        window.__plaidStubCreates = 0;
        window.__plaidLastToken = null;
        window.Plaid = {
          create: function (opts) {
            window.__plaidStubCreates += 1;
            window.__plaidLastToken = opts && opts.token;
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
    `;
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: stub,
    });
  });

  // Sentry CDN — no-op stub so the main script doesn't hit the network.
  await page.route('**/js.sentry-cdn.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Sentry = window.Sentry || { onLoad: function(){}, init: function(){} };',
    });
  });

  // Fire the Plaid callback once `open()` has been called by the SUT. We
  // poll briefly so the SDK init order doesn't matter.
  await page.exposeFunction('__triggerPlaidBehavior', async () => {
    const behavior = plaidBehavior;
    return await page.evaluate((b) => {
      if (b === 'success') {
        const cb = (window as unknown as { __plaidLastOnSuccess?: (t: string, m: unknown) => void }).__plaidLastOnSuccess;
        if (cb) cb('public-mock-token-abcd', { institution: { name: 'Bank of America', institution_id: 'ins_mock' }, accounts: [] });
      } else if (b === 'exit-voluntary') {
        const cb = (window as unknown as { __plaidLastOnExit?: (e: unknown, m: unknown) => void }).__plaidLastOnExit;
        if (cb) cb(null, {});
      } else if (b === 'exit-error') {
        const cb = (window as unknown as { __plaidLastOnExit?: (e: unknown, m: unknown) => void }).__plaidLastOnExit;
        if (cb) cb({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'mock error' }, {});
      }
    }, behavior);
  });

  return { hits, payloads };
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
}

function attachConsole(page: Page) {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') console.error('[console.error]', msg.text());
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
}

// ─────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────

test.describe('onboarding funnel — Phase 7C', () => {
  test('1. already-authed user is redirected to /home.html', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    // Stub home.html so it doesn't run its own gateAuth (which would
    // bounce back to / on the 401 we use in other tests). We only care
    // that the browser navigated there.
    await page.route('**/home.html', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><body><h1 id="home-stub">home</h1></body></html>',
      });
    });
    const { hits } = await installMocks(page, { meStatus: 200 });

    await page.goto(BASE + '/index.html');

    // Wait for the navigation to land on /home.html and the stub to render.
    await expect(page.locator('#home-stub')).toBeVisible({ timeout: 5000 });
    expect(new URL(page.url()).pathname).toBe('/home.html');
    expect(hits['GET /api/me']).toBeGreaterThanOrEqual(1);

    await context.close();
  });

  test('2. new user happy path: connect → exchange → phone → otp → home', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    // Stub /home.html so we can assert the funnel finishes with a real
    // navigation (instead of getting bounced back to / by home.js's
    // own gateAuth on the 401 we mocked above).
    await page.route('**/home.html', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><body><h1 id="home-stub">home</h1></body></html>',
      });
    });
    const { hits, payloads } = await installMocks(page, {
      meStatus: 401,
      plaidBehavior: 'success',
      institutionName: 'Bank of America',
    });

    await page.goto(BASE + '/index.html');

    // ── State 1: connect ───────────────────────────
    await expect(page.locator('#state-connect')).toHaveClass(/is-active/);
    await expect(page.locator('#connect-btn')).toBeVisible();
    await expect(page.locator('#returning-link')).toContainText('already have an account');

    // Disclaimer is right below the CTA.
    const disclaimer1 = page.locator('#state-connect .disclaimer');
    await expect(disclaimer1).toContainText("18+");
    await expect(disclaimer1.locator('a')).toHaveAttribute('href', 'privacy.html');

    await page.screenshot({ path: SCREENSHOT_DIR + '/01-state-connect.png', fullPage: false });

    // Click connect → /api/signup/start fires → State 2 paints.
    await page.locator('#connect-btn').click();

    // Wait for the start request to fire.
    await expect.poll(() => hits['POST /api/signup/start'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);

    // ── State 2: Plaid in flight ───────────────────
    await expect(page.locator('#state-plaid')).toHaveClass(/is-active/);
    await expect(page.locator('.plaid-flight__msg')).toContainText('connecting');
    await page.waitForTimeout(450);
    await page.screenshot({ path: SCREENSHOT_DIR + '/02-state-plaid.png', fullPage: false });

    // The SUT should have called Plaid.create + open(). Trigger onSuccess.
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __plaidOpenCalled?: boolean }).__plaidOpenCalled);
    }, { timeout: 4000 }).toBe(true);

    // Now fire onSuccess to drive the exchange + transition to phone state.
    await page.evaluate(() => {
      const fn = (window as unknown as { __triggerPlaidBehavior?: () => Promise<void> }).__triggerPlaidBehavior;
      if (fn) return fn();
    });

    // ── State 3: phone ─────────────────────────────
    await expect(page.locator('#state-phone')).toHaveClass(/is-active/, { timeout: 4000 });
    await expect(page.locator('#institution-name')).toContainText('bank of america');
    expect(hits['POST /api/signup/exchange']).toBeGreaterThanOrEqual(1);

    const disclaimer3 = page.locator('#state-phone .disclaimer');
    await expect(disclaimer3).toContainText("18+");
    await expect(disclaimer3.locator('a')).toHaveAttribute('href', 'privacy.html');

    // Wait for the fadeUp transition (350ms) so the screenshot isn't half-rendered.
    await page.waitForTimeout(450);
    await page.screenshot({ path: SCREENSHOT_DIR + '/03-state-phone.png', fullPage: false });

    // Type a phone number + click send.
    await page.locator('#phone-input').fill('9095425819');
    await page.locator('#send-otp-btn').click();
    await expect.poll(() => hits['POST /api/signup/send-otp'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);
    const sendOtpPayload = (payloads['POST /api/signup/send-otp'] || [])[0] as { phone?: string };
    expect(sendOtpPayload && sendOtpPayload.phone).toBe('+19095425819');

    // ── State 4: OTP ───────────────────────────────
    await expect(page.locator('#state-otp')).toHaveClass(/is-active/);
    await expect(page.locator('#phone-display')).toContainText('5819');
    await page.waitForTimeout(450);
    await page.screenshot({ path: SCREENSHOT_DIR + '/04-state-otp.png', fullPage: false });

    // Enter 6 digits → auto-submit triggers verify.
    await page.locator('#otp-input').fill('123456');
    await expect.poll(() => hits['POST /api/signup/verify-otp'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);

    // Final step: redirect to /home.html (stub renders #home-stub).
    await expect(page.locator('#home-stub')).toBeVisible({ timeout: 5000 });
    expect(new URL(page.url()).pathname).toBe('/home.html');

    await context.close();
  });

  test('3. plaid onExit voluntary returns to State 1', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    const { hits } = await installMocks(page, {
      meStatus: 401,
      plaidBehavior: 'exit-voluntary',
    });

    await page.goto(BASE + '/index.html');
    await expect(page.locator('#state-connect')).toHaveClass(/is-active/);

    await page.locator('#connect-btn').click();
    await expect.poll(() => hits['POST /api/signup/start'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#state-plaid')).toHaveClass(/is-active/);

    // Wait for open() then trigger onExit(null, {}).
    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __plaidOpenCalled?: boolean }).__plaidOpenCalled);
    }, { timeout: 4000 }).toBe(true);

    await page.evaluate(() => {
      const fn = (window as unknown as { __triggerPlaidBehavior?: () => Promise<void> }).__triggerPlaidBehavior;
      if (fn) return fn();
    });

    // We should be back on State 1 with a friendly banner.
    await expect(page.locator('#state-connect')).toHaveClass(/is-active/, { timeout: 4000 });
    await expect(page.locator('#banner')).toBeVisible();
    await expect(page.locator('#banner')).toContainText(/no worries|try again/);

    // Exchange should NOT have been called.
    expect(hits['POST /api/signup/exchange'] || 0).toBe(0);

    await context.close();
  });

  test('4. returning-user shortcut → /api/otp/* → home', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachConsole(page);
    await page.route('**/home.html', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><body><h1 id="home-stub">home</h1></body></html>',
      });
    });
    const { hits, payloads } = await installMocks(page, { meStatus: 401 });

    await page.goto(BASE + '/index.html');
    await expect(page.locator('#state-connect')).toHaveClass(/is-active/);

    // Click the inline link.
    await page.locator('#returning-link').click();
    await expect(page.locator('#state-returning-phone')).toHaveClass(/is-active/);
    await page.waitForTimeout(450);
    await page.screenshot({ path: SCREENSHOT_DIR + '/05-returning-phone.png', fullPage: false });

    // Submit phone — calls /api/otp/send (NOT /signup/send-otp).
    await page.locator('#returning-phone-input').fill('9095425819');
    await page.locator('#returning-send-btn').click();
    await expect.poll(() => hits['POST /api/otp/send'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);
    const sendPayload = (payloads['POST /api/otp/send'] || [])[0] as { phone?: string };
    expect(sendPayload && sendPayload.phone).toBe('+19095425819');
    // /signup/send-otp should NOT be called for returning users.
    expect(hits['POST /api/signup/send-otp'] || 0).toBe(0);

    // OTP step.
    await expect(page.locator('#state-returning-otp')).toHaveClass(/is-active/);
    await expect(page.locator('#returning-phone-display')).toContainText('5819');
    await page.waitForTimeout(450);
    await page.screenshot({ path: SCREENSHOT_DIR + '/06-returning-otp.png', fullPage: false });

    await page.locator('#returning-otp-input').fill('654321');
    await expect.poll(() => hits['POST /api/otp/verify'] || 0, { timeout: 4000 }).toBeGreaterThanOrEqual(1);
    expect(hits['POST /api/signup/verify-otp'] || 0).toBe(0);

    await expect(page.locator('#home-stub')).toBeVisible({ timeout: 5000 });
    expect(new URL(page.url()).pathname).toBe('/home.html');

    await context.close();
  });

  // ── Mobile screenshot pass (375px) ───────────────
  test('mobile (375px) renders all four signup states', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    attachConsole(page);
    await installMocks(page, {
      meStatus: 401,
      plaidBehavior: 'success',
      institutionName: 'Chase',
    });

    await page.goto(BASE + '/index.html');
    await expect(page.locator('#state-connect')).toHaveClass(/is-active/);
    await page.screenshot({ path: SCREENSHOT_DIR + '/mobile-01-connect.png', fullPage: true });

    // Drive through manually (without auto-submit on OTP) so we can grab
    // each mobile screenshot.
    await page.locator('#connect-btn').click();
    await expect(page.locator('#state-plaid')).toHaveClass(/is-active/);
    await page.waitForTimeout(450);
    await page.screenshot({ path: SCREENSHOT_DIR + '/mobile-02-plaid.png', fullPage: true });

    await expect.poll(async () => {
      return await page.evaluate(() => (window as unknown as { __plaidOpenCalled?: boolean }).__plaidOpenCalled);
    }, { timeout: 4000 }).toBe(true);
    await page.evaluate(() => {
      const fn = (window as unknown as { __triggerPlaidBehavior?: () => Promise<void> }).__triggerPlaidBehavior;
      if (fn) return fn();
    });

    await expect(page.locator('#state-phone')).toHaveClass(/is-active/);
    await page.waitForTimeout(450);
    await page.screenshot({ path: SCREENSHOT_DIR + '/mobile-03-phone.png', fullPage: true });

    await page.locator('#phone-input').fill('9095425819');
    await page.locator('#send-otp-btn').click();
    await expect(page.locator('#state-otp')).toHaveClass(/is-active/);
    await page.waitForTimeout(450);
    await page.screenshot({ path: SCREENSHOT_DIR + '/mobile-04-otp.png', fullPage: true });

    await context.close();
  });
});
