// Phase 7D + Phase 9A — legacy page hygiene verification.
//
// Phase 9A flips the "auto-redirect logged-in users away from /verify and
// /connect" behaviour: instead of bouncing to /home.html, we now render the
// page normally and surface a small "my home →" pill (`#cbff-auth-home-btn`).
// The OTP / Plaid / Stripe interactions stay disabled so an authed visitor
// can't re-trigger them — that part of the Phase 8.5B contract is preserved.
//
// What we still assert here:
//   1. The 18+ disclaimer is rendered + links to privacy.html (unchanged).
//   2. When /api/me 200s, the page renders AND the auth-home pill is visible.
//      Clicking the pill takes the user to /home.html.
//   3. OTP send must NOT fire on verify.html when the user is authed (that's
//      the Phase 8.5B hardening — the pill replaces the redirect, it does
//      NOT mean the OTP form re-activates).
//
// Spins up `python3 -m http.server` locally and mocks every backend call.

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/legacy-hygiene');
// Pin a port outside the 5173 / 5183 range used by other e2e specs so we
// don't collide on shared dev boxes.
const PORT = Number(process.env.LEGACY_HYGIENE_PORT || 5184);
const LOCAL_BASE = `http://localhost:${PORT}`;

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

test.describe('phase 7d + 9a · legacy page hygiene', () => {
  test('verify.html shows the 18+ disclaimer linking to privacy', async ({ page }) => {
    // Force /api/me to 401 so the page renders normally without surfacing
    // the auth-home pill.
    await page.route('**/api/me', (route) => {
      route.fulfill({ status: 401, body: JSON.stringify({ error: 'unauthed' }) });
    });
    // Block the OTP send so the network panel stays clean even if it fires.
    await page.route('**/api/otp/send', (route) => {
      route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });

    await page.goto(`${LOCAL_BASE}/verify.html?phone=5555550100`);
    await page.waitForLoadState('domcontentloaded');

    const disclaimer = page.locator('.age-disclaimer');
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText('18+');
    await expect(disclaimer).toContainText('terms');
    await expect(disclaimer.locator('a[href="privacy.html"]')).toBeVisible();

    // Pill is NOT shown for an unauthed user.
    await expect(page.locator('#cbff-auth-home-btn')).toHaveCount(0);

    await page.screenshot({
      path: 'test-results/legacy-hygiene/verify-with-disclaimer.png',
      fullPage: true,
    });
  });

  test('connect.html shows the 18+ disclaimer linking to privacy', async ({ page }) => {
    // Hold /api/me open indefinitely — the gate fires on load and on 401
    // would redirect to verify.html. Hanging the request lets the static
    // page render fully so we can assert + screenshot.
    await page.route('**/api/me', () => {
      // never call route.fulfill() — request stays pending
    });
    // Belt-and-braces: if the gate ever does land, block the redirect to
    // verify so it doesn't spin off into a different page mid-assert.
    await page.route('**/verify.html', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>verify-blocked</body></html>' });
    });

    await page.goto(`${LOCAL_BASE}/connect.html`, { waitUntil: 'domcontentloaded' });

    const disclaimer = page.locator('.age-disclaimer');
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText('18+');
    await expect(disclaimer.locator('a[href="privacy.html"]')).toBeVisible();
    // Sanity: the connect-with-plaid CTA renders for the unauthed-or-pending case.
    await expect(page.locator('#connect-btn')).toBeVisible();

    await page.screenshot({
      path: 'test-results/legacy-hygiene/connect-with-disclaimer.png',
      fullPage: true,
    });
  });

  test('connect.html: authed user sees page + auth-home pill (no redirect)', async ({ page }) => {
    // Mock /api/me to 200 so the gate paints the pill instead of bouncing.
    await page.route('**/api/me', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user_id: 1, phone: '+15555550100', created_at: null }),
      });
    });
    // Stub /home.html so when the user clicks the pill we land somewhere real.
    await page.route('**/home.html', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><h1 id="home-stub">home</h1></body></html>' });
    });

    await page.goto(`${LOCAL_BASE}/connect.html`);

    // Page should render — we did NOT bounce to /home.html.
    await page.waitForLoadState('domcontentloaded');
    expect(new URL(page.url()).pathname).toBe('/connect.html');

    // The auth-home pill is visible.
    const pill = page.locator('#cbff-auth-home-btn');
    await expect(pill).toBeVisible({ timeout: 5000 });
    await expect(pill).toContainText(/my home/i);

    // The connect CTA is hidden (so an authed visitor can't re-fire Plaid).
    await expect(page.locator('#connect-btn')).toBeHidden();
    // The "you're already signed in" friendly note shows up.
    await expect(page.locator('#cbff-signed-in-note')).toBeVisible();

    await page.screenshot({
      path: 'test-results/legacy-hygiene/connect-authed-pill.png',
      fullPage: true,
    });

    // Click the pill → land on /home.html.
    await pill.click();
    await expect(page.locator('#home-stub')).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain('/home.html');
  });

  test('verify.html: authed user sees page + auth-home pill, OTP never fires', async ({ page }) => {
    await page.route('**/api/me', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user_id: 1, phone: '+15555550100', created_at: null }),
      });
    });
    // OTP send must NOT fire for an authed user — fail loud if it does.
    let otpSendFired = false;
    await page.route('**/api/otp/send', (route) => {
      otpSendFired = true;
      route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });
    let otpVerifyFired = false;
    await page.route('**/api/otp/verify', (route) => {
      otpVerifyFired = true;
      route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/home.html', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><h1 id="home-stub">home</h1></body></html>' });
    });

    await page.goto(`${LOCAL_BASE}/verify.html?phone=5555550100`);
    await page.waitForLoadState('domcontentloaded');

    // We did NOT bounce to /home.html.
    expect(new URL(page.url()).pathname).toBe('/verify.html');

    // Auth-home pill is visible.
    const pill = page.locator('#cbff-auth-home-btn');
    await expect(pill).toBeVisible({ timeout: 5000 });
    await expect(pill).toContainText(/my home/i);

    // The OTP form is hidden so the user can't accidentally re-trigger it.
    await expect(page.locator('#otp-form')).toBeHidden();
    await expect(page.locator('#verify-btn')).toBeHidden();

    // Friendly "you're signed in" note replaces the form.
    await expect(page.locator('#cbff-signed-in-note')).toBeVisible();

    await page.screenshot({
      path: 'test-results/legacy-hygiene/verify-authed-pill.png',
      fullPage: true,
    });

    // Critical: OTP send + verify never fired for an authed user.
    expect(otpSendFired, 'OTP send should NOT fire for an authed user').toBe(false);
    expect(otpVerifyFired, 'OTP verify should NOT fire for an authed user').toBe(false);

    // Click the pill → /home.html.
    await pill.click();
    await expect(page.locator('#home-stub')).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain('/home.html');
  });
});
