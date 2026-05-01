// Phase 14D — Visual + accessibility audit.
//
// Drives every public-facing page (anon + a few mocked-authed states) at
// desktop 1280x900 and mobile 375x800. For each page we:
//   1. Take a full-page screenshot to test-results/v1-visual/.
//   2. Run @axe-core/playwright (WCAG 2A / 2AA) and dump violations.
//   3. Do a lightweight DOM check for missing alt / unlabeled inputs / no-h1
//      / horizontal scroll / small tap targets at 375px.
//
// Audit-only — no source files are modified. /api/me + Plaid + Stripe +
// Sentry CDN are all mocked so we never touch a real backend.
//
// Output:
//   - test-results/v1-visual/<page>-<viewport>.png   (screenshots)
//   - test-results/v1-visual/_report.json            (machine-readable findings)
//
// Filename starts with `v1-` so it shows up beside the existing
// `v1-comprehensive.spec.ts` instead of the leading-underscore helper specs.

import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const REPO_ROOT = resolve(__dirname_local, '..');
const OUT_DIR = resolve(REPO_ROOT, 'test-results/v1-visual');
const PORT = Number(process.env.PHASE14D_PORT || 5193);
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess | null = null;

type Finding = {
  page: string;
  viewport: 'desktop' | 'mobile';
  category: 'a11y' | 'visual' | 'mobile' | 'brand';
  rule: string;
  impact?: string;
  count?: number;
  detail?: string;
};
const FINDINGS: Finding[] = [];

function ensureOutDir() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
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
  ensureOutDir();
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
  // Dump findings as JSON so the report-writer can reuse them.
  try {
    writeFileSync(
      resolve(OUT_DIR, '_report.json'),
      JSON.stringify(FINDINGS, null, 2),
      'utf8',
    );
  } catch (_) { /* report write is best-effort */ }
});

// ── Mock fixtures ────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS, DELETE, PUT, PATCH',
  };
}

function jsonResp(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

async function stubExternalCdns(page: Page) {
  await page.route('**/js.sentry-cdn.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Sentry = window.Sentry || { onLoad: function(){}, init: function(){} };',
    });
  });
  await page.route('**/browser.sentry-cdn.com/**', (route) => {
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
      body: 'window.Stripe = function(){ return { elements: function(){ return { create: function(){ return { mount: function(){}, on: function(){} }; } }; }, confirmSetup: function(){ return Promise.resolve({ setupIntent: { id: "x" } }); } }; };',
    });
  });
}

async function mockAnon(page: Page) {
  await stubExternalCdns(page);
  await page.route('**/api.cashbff.com/**', (route) => {
    route.fulfill(jsonResp({ error: 'unauthed' }, 401));
  });
}

const PHONE_USER = {
  user_id: 19095425819,
  account_type: 'phone',
  phone: '+19095425819',
  created_at: '2025-01-15T12:00:00Z',
  has_active_subscription: true,
};

const SCHOOL_USER = {
  user_id: 'school_4242',
  account_type: 'school',
  email: 'student@school.edu',
  phone: null,
  created_at: '2025-03-10T12:00:00Z',
  has_active_subscription: true,
};

const ADMIN_USER = {
  user_id: 1,
  account_type: 'phone',
  phone: '+15555550100',
  created_at: '2024-09-01T12:00:00Z',
  has_active_subscription: true,
  is_admin: true,
};

async function mockHomePhoneUser(page: Page) {
  await stubExternalCdns(page);

  await page.route('**/api/me', (route) => route.fulfill(jsonResp(PHONE_USER)));

  // Calendar with a few mixed scheduled txns this month.
  const today = new Date();
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const day = (offset: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    return ymd(d);
  };
  await page.route('**/api/calendar**', (route) => route.fulfill(jsonResp({
    expenses: [
      { id: 'tx_1', date: day(2),  amount: 1200, name: 'rent',          type: 'rent' },
      { id: 'tx_2', date: day(5),  amount: 95,   name: 'spotify',        type: 'subscription' },
      { id: 'tx_3', date: day(-3), amount: 60,   name: 'groceries',      type: 'expense' },
      { id: 'tx_4', date: day(8),  amount: 150,  name: 'capital one min', type: 'cc-min' },
      { id: 'tx_5', date: day(-1), amount: -2400, name: 'paycheck',      type: 'income' },
    ],
  })));
  await page.route('**/api/balances', (route) => route.fulfill(jsonResp({
    accounts: [
      { id: 'a1', name: 'chase checking',      mask: '1234', account_type: 'depository', balance: 3200.55, as_of: new Date().toISOString() },
      { id: 'a2', name: 'chase savings',       mask: '5678', account_type: 'depository', balance: 1100.00, as_of: new Date().toISOString() },
      { id: 'a3', name: 'capital one platinum', mask: '9012', account_type: 'credit',     balance: 1840.13, as_of: new Date().toISOString() },
    ],
    summary: {
      depository_total: 4300.55,
      credit_total: 1840.13,
      running_balance: 2460.42,
      as_of: new Date().toISOString(),
    },
  })));
  await page.route('**/api/reimbursements', (route) => route.fulfill(jsonResp({
    items: [
      { id: 'r1', amount: 25, name: 'lunch w sarah', state: 'pending', created_at: today.toISOString() },
    ],
  })));
  await page.route('**/api/cards', (route) => route.fulfill(jsonResp({ cards: [] })));
  await page.route('**/api/wallet', (route) => route.fulfill(jsonResp({
    cards: [
      { id: 'a3', name: 'capital one platinum', mask: '9012', account_type: 'credit', balance: 1840.13 },
    ],
    untracked: [],
  })));
  await page.route('**/api/tracked-accounts', (route) => route.fulfill(jsonResp({ accounts: [] })));
  await page.route('**/api/recurring/suggestions', (route) => route.fulfill(jsonResp({ suggestions: [] })));
  await page.route('**/api/recurring/streams', (route) => route.fulfill(jsonResp({ streams: [] })));
  await page.route('**/api/snapshot', (route) => route.fulfill(jsonResp({
    summary: 'You have $2,460 cash, $1,840 credit, rent in 2 days.',
    generated_at: today.toISOString(),
  })));
  await page.route('**/api.cashbff.com/**', (route) => route.fulfill(jsonResp({ ok: true })));
}

async function mockHomeSchoolUser(page: Page) {
  await stubExternalCdns(page);
  await page.route('**/api/me', (route) => route.fulfill(jsonResp(SCHOOL_USER)));
  await page.route('**/api/calendar**', (route) => route.fulfill(jsonResp({ expenses: [] })));
  await page.route('**/api/balances', (route) => route.fulfill(jsonResp({ accounts: [], summary: null })));
  await page.route('**/api/reimbursements', (route) => route.fulfill(jsonResp({ items: [] })));
  await page.route('**/api/cards', (route) => route.fulfill(jsonResp({ cards: [] })));
  await page.route('**/api/wallet', (route) => route.fulfill(jsonResp({ cards: [], untracked: [] })));
  await page.route('**/api/tracked-accounts', (route) => route.fulfill(jsonResp({ accounts: [] })));
  await page.route('**/api/recurring/suggestions', (route) => route.fulfill(jsonResp({ suggestions: [] })));
  await page.route('**/api/recurring/streams', (route) => route.fulfill(jsonResp({ streams: [] })));
  await page.route('**/api.cashbff.com/**', (route) => route.fulfill(jsonResp({ ok: true })));
}

async function mockMetricsAdmin(page: Page) {
  await stubExternalCdns(page);
  await page.route('**/api/me', (route) => route.fulfill(jsonResp(ADMIN_USER)));
  const overview = {
    total_users: 482,
    paying_users: 73,
    free_users: 409,
    cards_tracked: 1284,
    scheduled_txns: 942,
  };
  await page.route('**/api/metrics/overview', (route) => route.fulfill(jsonResp(overview)));
  await page.route('**/api/metrics/sms', (route) => route.fulfill(jsonResp({
    last_24h: 1184, last_7d: 7421,
    rows: [
      { day: '2026-04-29', sent: 1100, replies: 48, errors: 2 },
      { day: '2026-04-28', sent: 1054, replies: 42, errors: 0 },
      { day: '2026-04-27', sent: 1006, replies: 39, errors: 1 },
    ],
  })));
  await page.route('**/api/metrics/signup-funnel', (route) => route.fulfill(jsonResp({
    step_landing: 1842, step_otp_sent: 1320, step_verified: 940, step_connected: 612, step_paid: 73,
  })));
  await page.route('**/api/metrics/recurring', (route) => route.fulfill(jsonResp({
    total_streams: 3812, top_merchants: [
      { merchant: 'spotify', count: 412 },
      { merchant: 'netflix', count: 388 },
      { merchant: 'verizon', count: 296 },
    ],
  })));
  await page.route('**/api/metrics/recent-signups', (route) => route.fulfill(jsonResp({
    rows: [
      { user_id: 19095425900, phone: '+1909···5900', created_at: '2026-04-30T10:30:00Z' },
      { user_id: 19095425899, phone: '+1909···5899', created_at: '2026-04-30T09:11:00Z' },
    ],
  })));
  await page.route('**/api.cashbff.com/**', (route) => route.fulfill(jsonResp({ ok: true })));
}

// ── DOM-level a11y / visual checks ──────────────────────────────────────

async function runDomChecks(
  page: Page,
  pageLabel: string,
  viewport: 'desktop' | 'mobile',
) {
  // 1. Horizontal scroll
  const horizontalScroll = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (horizontalScroll.scrollWidth > horizontalScroll.innerWidth + 1) {
    FINDINGS.push({
      page: pageLabel,
      viewport,
      category: 'visual',
      rule: 'horizontal-scroll',
      detail: `scrollWidth=${horizontalScroll.scrollWidth} > innerWidth=${horizontalScroll.innerWidth}`,
    });
  }

  // 2. Missing alt attributes (images only, decorative <img alt=""> is fine)
  const missingAlt = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img'))
      .filter((img) => !img.hasAttribute('alt'))
      .map((img) => ({ src: img.getAttribute('src') || '', html: img.outerHTML.slice(0, 120) }));
  });
  if (missingAlt.length > 0) {
    FINDINGS.push({
      page: pageLabel,
      viewport,
      category: 'a11y',
      rule: 'img-missing-alt',
      count: missingAlt.length,
      detail: missingAlt.map((m) => m.src).slice(0, 3).join('; '),
    });
  }

  // 3. Inputs without label / aria-label / aria-labelledby
  const unlabeled = await page.evaluate(() => {
    const out: { id: string; type: string; html: string }[] = [];
    document.querySelectorAll('input, select, textarea').forEach((el) => {
      const tag = el as HTMLInputElement;
      const type = (tag.type || '').toLowerCase();
      // Skip hidden / button-shaped inputs.
      if (['hidden', 'submit', 'button', 'reset'].includes(type)) return;
      const id = tag.id;
      const aria = tag.getAttribute('aria-label') || tag.getAttribute('aria-labelledby');
      const labeled = id && document.querySelector(`label[for="${id}"]`);
      if (!labeled && !aria) {
        out.push({
          id: id || '(no id)',
          type,
          html: tag.outerHTML.slice(0, 120),
        });
      }
    });
    return out;
  });
  if (unlabeled.length > 0) {
    FINDINGS.push({
      page: pageLabel,
      viewport,
      category: 'a11y',
      rule: 'input-missing-label',
      count: unlabeled.length,
      detail: unlabeled.map((u) => `${u.type}#${u.id}`).slice(0, 5).join('; '),
    });
  }

  // 4. Heading hierarchy: at least one h1, no skipping levels going down.
  const headings = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .filter((h) => {
        // Skip headings that are visually hidden via display:none or visibility:hidden
        const style = window.getComputedStyle(h);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map((h) => ({ level: Number(h.tagName.slice(1)), text: (h.textContent || '').trim().slice(0, 60) }));
  });
  const visibleHeadings = headings;
  const h1Count = visibleHeadings.filter((h) => h.level === 1).length;
  if (h1Count === 0) {
    FINDINGS.push({
      page: pageLabel,
      viewport,
      category: 'a11y',
      rule: 'no-h1',
      detail: 'page has no visible <h1>',
    });
  }
  // Detect a forward skip (e.g. h1 -> h3 with no h2 between) anywhere in flow.
  for (let i = 1; i < visibleHeadings.length; i++) {
    const prev = visibleHeadings[i - 1].level;
    const cur = visibleHeadings[i].level;
    if (cur > prev + 1) {
      FINDINGS.push({
        page: pageLabel,
        viewport,
        category: 'a11y',
        rule: 'heading-skip',
        detail: `h${prev} (“${visibleHeadings[i - 1].text}”) -> h${cur} (“${visibleHeadings[i].text}”)`,
      });
      break; // one is enough to flag
    }
  }

  // 5. Mobile-only: tap targets < 44x44.
  if (viewport === 'mobile') {
    const tinyTargets = await page.evaluate(() => {
      const out: { kind: string; w: number; h: number; text: string }[] = [];
      document.querySelectorAll('a, button, [role="button"], [role="tab"], input[type=submit], input[type=button]').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return; // hidden
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        if (r.width < 44 || r.height < 44) {
          out.push({
            kind: el.tagName.toLowerCase(),
            w: Math.round(r.width),
            h: Math.round(r.height),
            text: ((el as HTMLElement).innerText || (el as HTMLElement).getAttribute('aria-label') || '').trim().slice(0, 40),
          });
        }
      });
      return out;
    });
    if (tinyTargets.length > 0) {
      FINDINGS.push({
        page: pageLabel,
        viewport,
        category: 'mobile',
        rule: 'tap-target-too-small',
        count: tinyTargets.length,
        detail: tinyTargets.slice(0, 5).map((t) => `${t.kind}(${t.w}x${t.h}) “${t.text}”`).join('; '),
      });
    }

    // Body-text font-size baseline. Take a small sample of paragraph-ish elems.
    const tinyText = await page.evaluate(() => {
      const out: { tag: string; px: number; text: string }[] = [];
      const candidates = Array.from(document.querySelectorAll('p, li, span, div'))
        .filter((el) => {
          const t = (el as HTMLElement).innerText?.trim();
          return t && t.length > 8;
        })
        .slice(0, 30); // cap to avoid running through huge DOMs
      candidates.forEach((el) => {
        const px = parseFloat(window.getComputedStyle(el as HTMLElement).fontSize);
        if (px && px < 12) {
          out.push({
            tag: el.tagName.toLowerCase(),
            px,
            text: (el as HTMLElement).innerText.trim().slice(0, 40),
          });
        }
      });
      return out;
    });
    if (tinyText.length > 0) {
      FINDINGS.push({
        page: pageLabel,
        viewport,
        category: 'mobile',
        rule: 'small-body-text',
        count: tinyText.length,
        detail: tinyText.slice(0, 3).map((t) => `${t.tag}(${t.px}px) “${t.text}”`).join('; '),
      });
    }
  }

  // 6. Brand consistency: brand fonts loaded? Use document.fonts to check.
  const brandFonts = await page.evaluate(() => {
    const families = new Set<string>();
    try {
      // @ts-ignore — document.fonts is on FontFaceSet
      document.fonts.forEach((f) => families.add(f.family));
    } catch (_) { /* old browser */ }
    return Array.from(families);
  });
  const wantsGreed = brandFonts.some((f) => /Greed/i.test(f));
  if (!wantsGreed) {
    FINDINGS.push({
      page: pageLabel,
      viewport,
      category: 'brand',
      rule: 'greed-condensed-not-loaded',
      detail: `loaded fonts: ${brandFonts.slice(0, 6).join(', ') || '(none)'}`,
    });
  }
}

// Run axe + dump findings.
async function runAxe(
  page: Page,
  pageLabel: string,
  viewport: 'desktop' | 'mobile',
) {
  try {
    const builder = new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
    const results = await builder.analyze();
    for (const v of results.violations) {
      FINDINGS.push({
        page: pageLabel,
        viewport,
        category: 'a11y',
        rule: v.id,
        impact: v.impact ?? undefined,
        count: v.nodes.length,
        detail: (v.help || v.description || '').slice(0, 200),
      });
    }
  } catch (err) {
    FINDINGS.push({
      page: pageLabel,
      viewport,
      category: 'a11y',
      rule: 'axe-failed',
      detail: String((err as Error).message || err).slice(0, 200),
    });
  }
}

// ── Page list ────────────────────────────────────────────────────────────

type PageEntry = {
  label: string;          // canonical name in report (matches user spec)
  path: string;           // local path to load
  setup: (p: Page) => Promise<void>;
  desktop: boolean;
  mobile: boolean;
};

const PAGES: PageEntry[] = [
  { label: 'Landing',        path: '/index.html',                           setup: mockAnon,            desktop: true, mobile: true },
  { label: 'School landing', path: '/school.html',                          setup: mockAnon,            desktop: true, mobile: true },
  { label: 'Verify (OTP)',   path: '/verify.html?phone=5555550100',         setup: mockAnon,            desktop: true, mobile: true },
  { label: 'Connect',        path: '/connect.html',                         setup: mockAnon,            desktop: true, mobile: true },
  { label: 'Plan',           path: '/plan.html',                            setup: mockAnon,            desktop: true, mobile: true },
  { label: 'Paywall',        path: '/paywall.html',                         setup: mockAnon,            desktop: true, mobile: true },
  { label: 'School login',   path: '/school-login.html',                    setup: mockAnon,            desktop: true, mobile: true },
  { label: 'School login (prefilled)', path: '/school-login.html?email=student%40school.edu&code=ABCD1234', setup: mockAnon, desktop: true, mobile: true },
  { label: 'Welcome',        path: '/welcome.html',                         setup: mockAnon,            desktop: true, mobile: true },
  { label: 'Privacy',        path: '/privacy.html',                         setup: mockAnon,            desktop: true, mobile: true },
  { label: 'Terms',          path: '/terms.html',                           setup: mockAnon,            desktop: true, mobile: true },
  { label: 'Home (phone)',   path: '/home.html',                            setup: mockHomePhoneUser,   desktop: true, mobile: true },
  { label: 'Home (school)',  path: '/home.html',                            setup: mockHomeSchoolUser,  desktop: true, mobile: true },
  { label: 'Metrics (admin)', path: '/metrics.html',                        setup: mockMetricsAdmin,    desktop: true, mobile: false },
];

function safeName(label: string): string {
  return label
    .toLowerCase()
    .replace(/[\s()/]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Tests ────────────────────────────────────────────────────────────────

test.describe('Phase 14D — visual + a11y audit', () => {
  for (const entry of PAGES) {
    if (entry.desktop) {
      test(`${entry.label} @ desktop 1280x900`, async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await ctx.newPage();
        await entry.setup(page);
        await page.goto(BASE + entry.path, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1800); // let entrance animations + boot fetches settle
        const fname = `${safeName(entry.label)}-desktop.png`;
        await page.screenshot({ path: resolve(OUT_DIR, fname), fullPage: true });
        await runDomChecks(page, entry.label, 'desktop');
        await runAxe(page, entry.label, 'desktop');
        await ctx.close();
      });
    }
    if (entry.mobile) {
      test(`${entry.label} @ mobile 375x800`, async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
        const page = await ctx.newPage();
        await entry.setup(page);
        await page.goto(BASE + entry.path, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1800);
        const fname = `${safeName(entry.label)}-mobile.png`;
        await page.screenshot({ path: resolve(OUT_DIR, fname), fullPage: true });
        await runDomChecks(page, entry.label, 'mobile');
        await runAxe(page, entry.label, 'mobile');
        await ctx.close();
      });
    }
  }

  // No assertion intentionally — this is an audit. The serialized report at
  // test-results/v1-visual/_report.json is the artefact we read in to write
  // docs/phase14d-visual-a11y.md.
  test('audit complete', () => {
    expect(true).toBeTruthy();
  });
});
