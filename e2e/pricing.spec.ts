// Phase 16 — pricing.html visual + waitlist-submit smoke tests.
//
// Spawns a local python static-file server on a fresh port (no JWT_SECRET
// needed) and loads /pricing.html directly. We mock /api/sms-beta-waitlist
// with route() so the form's success / error paths can be driven without
// hitting the live backend. Mirrors the e2e/legal-pages.spec.ts setup.

import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/phase16');
// Port outside the range used by other specs (5183 onboarding, 5184 legal).
const PORT = Number(process.env.PRICING_PORT || 5185);
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

// Stub every outbound call. We don't want auth-banner.js or sentry-cdn.js
// hitting the real network during these tests.
async function stubBackground(page: Page) {
  await page.route('**/api.cashbff.com/api/me', async (route) => {
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
  await page.route('**/us.i.posthog.com/**', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/us-assets.i.posthog.com/**', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });
}

test.describe('pricing.html', () => {
  test('renders headline, $7.49 tier, and SMS beta waitlist form', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/pricing.html');

    // Wordmark on top bar.
    await expect(page.locator('.wordmark')).toContainText('cash bff');
    await expect(page.locator('.wordmark')).toHaveAttribute('href', '/');

    // Headline copy.
    await expect(page.locator('.headline')).toContainText('pay once a month');
    await expect(page.locator('.headline')).toContainText('forget about it');

    // Sub copy.
    await expect(page.locator('.sub')).toContainText('7 days free');
    await expect(page.locator('.sub')).toContainText('cancel anytime');

    // Paid tier — price visible.
    const paidTier = page.locator('.tier--paid');
    await expect(paidTier).toBeVisible();
    await expect(paidTier.locator('[data-test="price"]')).toContainText('$7.49');
    await expect(paidTier.locator('[data-test="price"]')).toContainText('/ month');
    await expect(paidTier).toContainText('the calendar that knows what');
    await expect(paidTier).toContainText('up to 5 banks via plaid');
    await expect(paidTier).toContainText('cancel anytime');
    // CTA points at the signup funnel root.
    const paidCta = paidTier.locator('[data-test="paid-cta"]');
    await expect(paidCta).toBeVisible();
    await expect(paidCta).toHaveAttribute('href', '/');
    await expect(paidCta).toContainText('start your 7 days');

    // SMS beta tier — waitlist form visible.
    const smsTier = page.locator('.tier--soon');
    await expect(smsTier).toBeVisible();
    await expect(smsTier).toContainText('SMS agent');
    await expect(smsTier).toContainText('coming soon');
    await expect(page.locator('#waitlist-form')).toBeVisible();
    await expect(page.locator('#waitlist-email')).toBeVisible();
    await expect(page.locator('#waitlist-note')).toBeVisible();
    await expect(page.locator('[data-test="waitlist-submit"]')).toBeVisible();

    // Promise footer below tiers.
    await expect(page.locator('.promise')).toContainText('early users get permanent perks');

    // Footer links.
    const foot = page.locator('footer.page-foot');
    await expect(foot.locator('a[href="privacy.html"]')).toBeVisible();
    await expect(foot.locator('a[href="terms.html"]')).toBeVisible();
    await expect(foot.locator('a[href="mailto:daksh@cashbff.com"]')).toBeVisible();

    await page.screenshot({ path: SCREENSHOT_DIR + '/01-pricing-desktop.png', fullPage: true });
    await context.close();
  });

  test('renders cleanly on mobile (375px)', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/pricing.html');
    await expect(page.locator('.headline')).toContainText('pay once a month');
    await expect(page.locator('[data-test="price"]')).toContainText('$7.49');
    await expect(page.locator('#waitlist-form')).toBeVisible();
    await page.screenshot({ path: SCREENSHOT_DIR + '/02-pricing-mobile.png', fullPage: true });
    await context.close();
  });

  test('submits the waitlist form and shows success state on 200', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    // Mock the waitlist endpoint with a 200 ok response.
    await page.route('**/api.cashbff.com/api/sms-beta-waitlist', async (route, req) => {
      // Sanity-check the request body shape.
      const body = req.postDataJSON();
      if (!body || !body.email) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': BASE },
          body: JSON.stringify({ error: 'bad' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': BASE },
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(BASE + '/pricing.html');

    await page.locator('#waitlist-email').fill('test@example.com');
    await page.locator('#waitlist-note').fill('would use it for credit-card timing');
    await page.locator('[data-test="waitlist-submit"]').click();

    // Success swap.
    await expect(page.locator('#waitlist-success')).toBeVisible();
    await expect(page.locator('#waitlist-success')).toContainText("you're in");
    await expect(page.locator('#waitlist-success')).toContainText("won't spam");
    // Form is hidden after success.
    await expect(page.locator('#waitlist-form')).toBeHidden();

    await context.close();
  });

  test('shows friendly inline error on 400', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.route('**/api.cashbff.com/api/sms-beta-waitlist', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': BASE },
        body: JSON.stringify({ error: "your email doesn't look right." }),
      });
    });

    await page.goto(BASE + '/pricing.html');

    await page.locator('#waitlist-email').fill('test@example.com');
    await page.locator('[data-test="waitlist-submit"]').click();

    // Error visible, form still showing, success hidden.
    await expect(page.locator('#waitlist-error')).toBeVisible();
    await expect(page.locator('#waitlist-error')).toContainText("doesn't look right");
    await expect(page.locator('#waitlist-form')).toBeVisible();
    await expect(page.locator('#waitlist-success')).toBeHidden();

    await context.close();
  });

  test('client-side validation rejects an obviously-bad email', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    // Even though the network would 400 here, the client should never call.
    let networkHit = false;
    await page.route('**/api.cashbff.com/api/sms-beta-waitlist', async (route) => {
      networkHit = true;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': BASE },
        body: JSON.stringify({ error: 'should not be hit' }),
      });
    });

    await page.goto(BASE + '/pricing.html');

    await page.locator('#waitlist-email').fill('not-an-email');
    await page.locator('[data-test="waitlist-submit"]').click();

    await expect(page.locator('#waitlist-error')).toBeVisible();
    await expect(page.locator('#waitlist-error')).toContainText("doesn't look right");
    await expect(page.locator('#waitlist-success')).toBeHidden();

    expect(networkHit).toBe(false);

    await context.close();
  });
});
