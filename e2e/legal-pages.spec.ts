// Phase 9B — privacy.html + terms.html visual + linkage tests.
//
// These specs spin up a local python static-file server on a fresh port
// (no JWT_SECRET needed) and load the two legal pages directly. We also
// verify that the index.html footer's privacy + terms links navigate to
// the expected files. Mirrors the e2e/onboarding.spec.ts setup.

import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'test-results/legal-pages');
// Pick a port outside the ranges used by other specs (5183 onboarding).
const PORT = Number(process.env.LEGAL_PAGES_PORT || 5184);
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

// Stub the auth-banner background fetch — every page in V4-proto loads
// /assets/js/auth-banner.js which calls api.cashbff.com/api/me. We don't
// care about that for these specs; just kill it cleanly so no real
// network requests fire.
async function stubBackground(page: Page) {
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
}

test.describe('privacy.html', () => {
  test('renders wordmark, title, and all section headings', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/privacy.html');

    // Wordmark on top bar.
    await expect(page.locator('.wordmark')).toContainText('cash bff');
    await expect(page.locator('.wordmark')).toHaveAttribute('href', '/');

    // Page title.
    await expect(page.locator('h1.content__title')).toContainText('privacy');

    // Sub headline (the "the short, no-nonsense version" tagline).
    await expect(page.locator('.content__sub')).toContainText('short, no-nonsense');

    // All h2 section headings the policy must cover. We do a contains
    // check (case-insensitive substring) against the joined text of all
    // h2s on the page so that minor copy edits don't break the spec.
    const headings = await page.locator('main h2').allInnerTexts();
    const joined = headings.join(' | ').toLowerCase();
    const required = [
      'what we collect',
      'how we use it',
      'research',
      'third parties',
      'your rights',
      'cookies',
      'under 18',
      'changes',
      'contact',
    ];
    for (const needle of required) {
      expect(joined, `missing heading: ${needle}`).toContain(needle);
    }

    // "Last updated" footer line.
    await expect(page.locator('.updated')).toContainText('Last updated: May 3, 2026');

    // Page footer with both legal links + email.
    const foot = page.locator('footer.page-foot');
    await expect(foot.locator('a[href="privacy.html"]')).toBeVisible();
    await expect(foot.locator('a[href="terms.html"]')).toBeVisible();
    await expect(foot.locator('a[href="mailto:daksh@cashbff.com"]')).toBeVisible();

    await page.screenshot({ path: SCREENSHOT_DIR + '/01-privacy-desktop.png', fullPage: true });
    await context.close();
  });

  test('renders cleanly on mobile (375px)', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/privacy.html');
    await expect(page.locator('h1.content__title')).toContainText('privacy');
    await page.screenshot({ path: SCREENSHOT_DIR + '/02-privacy-mobile.png', fullPage: true });
    await context.close();
  });
});

test.describe('terms.html', () => {
  test('renders wordmark, title, and all section headings', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/terms.html');

    await expect(page.locator('.wordmark')).toContainText('cash bff');
    await expect(page.locator('.wordmark')).toHaveAttribute('href', '/');

    await expect(page.locator('h1.content__title')).toContainText('terms');
    await expect(page.locator('.content__sub')).toContainText('short, no-nonsense');

    const headings = await page.locator('main h2').allInnerTexts();
    const joined = headings.join(' | ').toLowerCase();
    const required = [
      'who can use',
      'what we do',
      "what we don't do",
      'your responsibilities',
      'research',
      'subscription billing',
      'termination',
      'disclaimers',
      'governing law',
      'changes to terms',
      'contact',
    ];
    for (const needle of required) {
      expect(joined, `missing heading: ${needle}`).toContain(needle);
    }

    await expect(page.locator('.updated')).toContainText('Last updated: April 29, 2026');

    const foot = page.locator('footer.page-foot');
    await expect(foot.locator('a[href="privacy.html"]')).toBeVisible();
    await expect(foot.locator('a[href="terms.html"]')).toBeVisible();
    await expect(foot.locator('a[href="mailto:daksh@cashbff.com"]')).toBeVisible();

    await page.screenshot({ path: SCREENSHOT_DIR + '/03-terms-desktop.png', fullPage: true });
    await context.close();
  });

  test('renders cleanly on mobile (375px)', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/terms.html');
    await expect(page.locator('h1.content__title')).toContainText('terms');
    await page.screenshot({ path: SCREENSHOT_DIR + '/04-terms-mobile.png', fullPage: true });
    await context.close();
  });
});

test.describe('footer linkage from index.html', () => {
  test('clicking "privacy" in the index footer lands on /privacy.html', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/index.html');

    // Wait for the page-foot to render and find the privacy link inside it.
    const privacyLink = page.locator('footer.page-foot a[href="privacy.html"]');
    await expect(privacyLink).toBeVisible();
    await privacyLink.click();

    await expect(page).toHaveURL(new RegExp('/privacy\\.html$'));
    await expect(page.locator('h1.content__title')).toContainText('privacy');
    await context.close();
  });

  test('clicking "terms" in the index footer lands on /terms.html', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/index.html');

    const termsLink = page.locator('footer.page-foot a[href="terms.html"]');
    await expect(termsLink).toBeVisible();
    await termsLink.click();

    await expect(page).toHaveURL(new RegExp('/terms\\.html$'));
    await expect(page.locator('h1.content__title')).toContainText('terms');
    await context.close();
  });
});
