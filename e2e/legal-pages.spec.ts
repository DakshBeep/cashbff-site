// privacy.html + terms.html visual + linkage tests.
//
// Rewritten 2026-06-11 for the strict-register legal refresh + site redesign:
//   • both documents now render as a boxed "doc" card with Title Case headings,
//     an Effective-date meta line, and a Summary callout;
//   • terms.html carries the new prominent accuracy disclaimer and the
//     Section 16 arbitration agreement (AAA consumer rules, small-claims
//     carve-out, LA County seat, 30-day opt-out, class action waiver);
//   • privacy.html encodes founder access for support + product research (§6);
//   • the legal name is "Khanna's LLC" (with the apostrophe) everywhere;
//   • every marketing footer links /privacy + /terms (asserted via index.html).
//
// These specs spin up a local python static-file server on a fresh port
// (no JWT_SECRET needed) and load the pages directly. Note: prod serves clean
// URLs (/privacy), python's http.server does not, so link targets are asserted
// as attributes and pages are visited via their .html filenames.

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

// Stub background fetches — pages load posthog-init.js which calls
// api.cashbff.com/api/me, and some pages pull the Sentry loader. Kill both
// cleanly so no real network requests fire.
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
  test('renders wordmark, title, meta, and all section headings', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/privacy.html');

    // Wordmark on the sticky top bar.
    await expect(page.locator('.wordmark')).toContainText('cashbff');
    await expect(page.locator('.wordmark')).toHaveAttribute('href', '/');

    // Document title + effective date + operator (apostrophe form).
    await expect(page.locator('h1.doc__title')).toHaveText('Privacy Policy');
    await expect(page.locator('.doc__meta')).toContainText('Effective June 11, 2026');
    await expect(page.locator('.doc__meta')).toContainText("Khanna's LLC");

    // Summary callout.
    await expect(page.locator('.doc__summary')).toContainText('Summary:');
    await expect(page.locator('.doc__summary')).toContainText('We never sell or share your data');

    // All h2 section headings the policy must cover (substring check against
    // the joined lowercase text so minor copy edits don't break the spec).
    const headings = await page.locator('main h2').allInnerTexts();
    const joined = headings.join(' | ').toLowerCase();
    const required = [
      'what we collect',
      'how we use your data',
      'how you reach cashbff',
      'third-party services we rely on',
      'analytics and monitoring',
      'how we handle your messages',
      'data security',
      'data retention',
      'your rights and controls',
      'changes to this policy',
      'contact',
    ];
    for (const needle of required) {
      expect(joined, `missing heading: ${needle}`).toContain(needle);
    }

    // §6 encodes founder access for support + product research (R2).
    const bodyText = (await page.locator('article.doc').innerText()).toLowerCase();
    expect(bodyText).toContain('today, our team is the founder');
    expect(bodyText).toContain('product improvement and research');
    // R3 stays generic + consent-first (no institutions named).
    expect(bodyText).toContain('we will ask for your consent first');
    expect(bodyText).not.toContain('educational institution');
    expect(bodyText).not.toContain('financial wellness');
    // The deliberate §6 storage hedge is preserved verbatim (Daksh's call).
    expect(bodyText).toContain('we may also store whatsapp message content');
    // Legal-name standardization: no apostrophe-less variant anywhere.
    expect(bodyText).not.toContain('khannas llc');

    // "Last updated" footer line.
    await expect(page.locator('.updated')).toContainText('Last updated: June 11, 2026');

    // Page footer with both legal links + email.
    const foot = page.locator('footer.page-foot');
    await expect(foot.locator('a[href="/privacy"]')).toBeVisible();
    await expect(foot.locator('a[href="/terms"]')).toBeVisible();
    await expect(foot.locator('a[href="mailto:daksh@cashbff.com"]')).toBeVisible();
    await expect(foot).toContainText("Khanna's LLC");

    await page.screenshot({ path: SCREENSHOT_DIR + '/01-privacy-desktop.png', fullPage: true });
    await context.close();
  });

  test('renders cleanly on mobile (375px)', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/privacy.html');
    await expect(page.locator('h1.doc__title')).toHaveText('Privacy Policy');
    await page.screenshot({ path: SCREENSHOT_DIR + '/02-privacy-mobile.png', fullPage: true });
    await context.close();
  });
});

test.describe('terms.html', () => {
  test('renders wordmark, title, disclaimer, arbitration section, and all headings', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/terms.html');

    await expect(page.locator('.wordmark')).toContainText('cashbff');
    await expect(page.locator('.wordmark')).toHaveAttribute('href', '/');

    await expect(page.locator('h1.doc__title')).toHaveText('Terms of Service');
    await expect(page.locator('.doc__meta')).toContainText('Effective June 11, 2026');
    await expect(page.locator('.doc__meta')).toContainText("Khanna's LLC");
    await expect(page.locator('.doc__summary')).toContainText('Summary:');

    // The prominent plain-language accuracy disclaimer near the top.
    const notice = page.locator('.doc__notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('cashbff is software');
    await expect(notice).toContainText('Verify any number that matters');

    const headings = await page.locator('main h2').allInnerTexts();
    const joined = headings.join(' | ').toLowerCase();
    const required = [
      'acceptance of these terms',
      'eligibility',
      'what cashbff is',
      'does and does not do',
      'messaging consent and rates',
      'your account and accurate information',
      'acceptable use',
      'message content and how we access it',
      'third-party services',
      'subscriptions, billing, cancellation, and refunds',
      'disclaimers of warranties',
      'limitation of liability',
      'indemnification',
      'changes to these terms',
      'termination',
      'governing law and dispute resolution',
      'contact us',
    ];
    for (const needle of required) {
      expect(joined, `missing heading: ${needle}`).toContain(needle);
    }

    // Section 16: the deliberate arbitration reversal, drafted airtight.
    const bodyText = (await page.locator('article.doc').innerText()).toLowerCase();
    expect(bodyText).toContain('binding individual arbitration');
    expect(bodyText).toContain('american arbitration association');
    expect(bodyText).toContain('consumer arbitration rules');
    expect(bodyText).toContain('small claims court');
    expect(bodyText).toContain('los angeles county');
    expect(bodyText).toContain('class action waiver');
    expect(bodyText).toContain('arbitration opt-out');
    expect(bodyText).toContain('within 30 days');
    // R11: the strict one-liner.
    expect(bodyText).toContain('not a licensed financial advisor, counselor, or therapist');
    // The WhatsApp "tell us to stop" opt-out line is removed (Daksh's call);
    // SMS keywords remain.
    expect(bodyText).not.toContain('opt out by telling us to stop');
    expect(bodyText).toContain('reply stop');
    // §8 keeps the storage hedge but mirrors the research-access reason (R12).
    expect(bodyText).toContain('we may store and retain your messages');
    expect(bodyText).toContain('product improvement and research');
    // Legal-name standardization.
    expect(bodyText).not.toContain('khannas llc');
    expect(bodyText).toContain("khanna's llc");

    await expect(page.locator('.updated')).toContainText('Last updated: June 11, 2026');

    const foot = page.locator('footer.page-foot');
    await expect(foot.locator('a[href="/privacy"]')).toBeVisible();
    await expect(foot.locator('a[href="/terms"]')).toBeVisible();
    await expect(foot.locator('a[href="mailto:daksh@cashbff.com"]')).toBeVisible();

    await page.screenshot({ path: SCREENSHOT_DIR + '/03-terms-desktop.png', fullPage: true });
    await context.close();
  });

  test('renders cleanly on mobile (375px)', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/terms.html');
    await expect(page.locator('h1.doc__title')).toHaveText('Terms of Service');
    await page.screenshot({ path: SCREENSHOT_DIR + '/04-terms-mobile.png', fullPage: true });
    await context.close();
  });
});

test.describe('footer linkage from index.html', () => {
  // Prod serves clean URLs (/privacy, /terms via vercel.json cleanUrls), which
  // the local python server can't resolve, so we assert the hrefs and then
  // load the underlying files directly.
  test('index footer links both legal docs and they render', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/index.html');

    const foot = page.locator('footer.footer');
    await expect(foot.locator('a[href="/privacy"]')).toBeVisible();
    await expect(foot.locator('a[href="/terms"]')).toBeVisible();
    await expect(foot).toContainText("Khanna's LLC");

    await page.goto(BASE + '/privacy.html');
    await expect(page.locator('h1.doc__title')).toHaveText('Privacy Policy');

    await page.goto(BASE + '/terms.html');
    await expect(page.locator('h1.doc__title')).toHaveText('Terms of Service');
    await context.close();
  });

  test('signup consent line links both legal docs', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await stubBackground(page);

    await page.goto(BASE + '/signup.html');
    const consent = page.locator('#consent-line');
    await expect(consent).toContainText('by continuing you agree to the terms and privacy policy.');
    await expect(consent.locator('a[href="/terms"]')).toBeVisible();
    await expect(consent.locator('a[href="/privacy"]')).toBeVisible();
    await context.close();
  });
});
