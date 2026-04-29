// Phase 7D — legacy page hygiene verification.
//
// Two checks per page:
//   1. The 18+ disclaimer line renders and links to privacy.html.
//   2. When /api/me returns 200 (mocked), the page redirects to /home.html
//      before any user-visible content has a chance to settle.
//
// We hit a local file-server (python3 -m http.server 5173) instead of prod
// so we can mock the /api/me response without touching the real backend.

import { test, expect } from '@playwright/test';

const LOCAL_BASE = 'http://localhost:5173';

test.describe('phase 7d · legacy page hygiene', () => {
  test('verify.html shows the 18+ disclaimer linking to privacy', async ({ page }) => {
    // Force /api/me to 401 so the page renders normally without bouncing.
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

    await page.screenshot({
      path: 'test-results/legacy-hygiene/verify-with-disclaimer.png',
      fullPage: true,
    });
  });

  test('connect.html shows the 18+ disclaimer linking to privacy', async ({ page }) => {
    // Hold the /api/me response open indefinitely — the connect page fires
    // the gate fetch on load, and on 401 it redirects to verify.html. By
    // hanging the request we let the static page render fully without ever
    // resolving the gate, so we can assert + screenshot the connect view.
    await page.route('**/api/me', () => {
      // never call route.fulfill() — request stays pending for the duration
    });
    // Block verify.html nav as a belt-and-braces in case the gate ever
    // does land before assertions complete.
    await page.route('**/verify.html', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>verify-blocked</body></html>' });
    });

    await page.goto(`${LOCAL_BASE}/connect.html`, { waitUntil: 'domcontentloaded' });

    const disclaimer = page.locator('.age-disclaimer');
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText('18+');
    await expect(disclaimer.locator('a[href="privacy.html"]')).toBeVisible();
    // Sanity: the connect-with-plaid CTA is rendered above the disclaimer.
    await expect(page.locator('#connect-btn')).toBeVisible();

    await page.screenshot({
      path: 'test-results/legacy-hygiene/connect-with-disclaimer.png',
      fullPage: true,
    });
  });

  test('connect.html bounces authed users to /home.html (200 → redirect)', async ({ page }) => {
    // Mock /api/me to 200 so the gate redirects to home.
    await page.route('**/api/me', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user_id: 1, phone: '+15555550100', created_at: null }),
      });
    });
    // Stub home.html so the redirect resolves without 404.
    await page.route('**/home.html', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>home</body></html>' });
    });

    await page.goto(`${LOCAL_BASE}/connect.html`);
    // Wait until we land on /home.html.
    await page.waitForURL('**/home.html', { timeout: 5000 });
    expect(page.url()).toContain('/home.html');
  });

  test('verify.html bounces authed users to /home.html (200 → redirect)', async ({ page }) => {
    await page.route('**/api/me', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user_id: 1, phone: '+15555550100', created_at: null }),
      });
    });
    // OTP send must NOT fire for an authed user — we'll fail loud if it does.
    let otpSendFired = false;
    await page.route('**/api/otp/send', (route) => {
      otpSendFired = true;
      route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/home.html', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>home</body></html>' });
    });

    await page.goto(`${LOCAL_BASE}/verify.html?phone=5555550100`);
    await page.waitForURL('**/home.html', { timeout: 5000 });
    expect(page.url()).toContain('/home.html');
    expect(otpSendFired, 'OTP send should not fire for an authed user').toBe(false);
  });
});
