// Unit tests for the pure rendering helpers in metrics.js.
//
// metrics.js is an IIFE that auto-runs on import. Inside a real browser
// it kicks off a 30s setInterval; under jsdom we suppress that by NOT
// providing a #metrics-main element (the auto-init guard returns early).
//
// The IIFE exposes its renderers + formatters on window.__metricsDashboard
// so these tests can drive them against a synthetic DOM scaffold without
// caring about fetch behavior.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

let api;

beforeAll(async () => {
  // Stub fetch so any incidental call doesn't blow up jsdom.
  globalThis.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '',
    });
  await import('../metrics.js');
  api = window.__metricsDashboard;
  if (!api) throw new Error('metrics.js did not expose __metricsDashboard');
});

// Build a minimal scaffold matching the metrics.html layout. Each test
// resets it so the IIFE's module-level refs can be re-pointed.
function buildScaffold() {
  document.body.innerHTML = `
    <main id="metrics-main">
      <div id="refresh-stamp"></div>
      <div id="overview-grid"></div>
      <div id="sms-grid"></div>
      <div id="sms-table-wrap"></div>
      <div id="funnel-grid"></div>
      <div id="recurring-grid"></div>
      <div id="merchant-list"></div>
      <div id="signup-list"></div>
    </main>
    <div id="metrics-denied" hidden>
      <div id="denied-message"></div>
    </div>
  `;
  api.__setRefsForTest({
    $main: document.getElementById('metrics-main'),
    $denied: document.getElementById('metrics-denied'),
    $deniedMsg: document.getElementById('denied-message'),
    $stamp: document.getElementById('refresh-stamp'),
    $overviewGrid: document.getElementById('overview-grid'),
    $smsGrid: document.getElementById('sms-grid'),
    $smsTableWrap: document.getElementById('sms-table-wrap'),
    $funnelGrid: document.getElementById('funnel-grid'),
    $recurringGrid: document.getElementById('recurring-grid'),
    $merchantList: document.getElementById('merchant-list'),
    $signupList: document.getElementById('signup-list'),
  });
  api.__resetDeniedForTest();
}

beforeEach(() => {
  buildScaffold();
});

// ── escapeHtml ─────────────────────────────────────────────────────
describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(api.escapeHtml('<script>alert("&")</script>'))
      .toBe('&lt;script&gt;alert(&quot;&amp;&quot;)&lt;/script&gt;');
  });
  it('returns empty string for null/undefined', () => {
    expect(api.escapeHtml(null)).toBe('');
    expect(api.escapeHtml(undefined)).toBe('');
  });
  it('coerces non-strings', () => {
    expect(api.escapeHtml(42)).toBe('42');
  });
});

// ── formatNumber ───────────────────────────────────────────────────
describe('formatNumber', () => {
  it('renders integers with locale separators', () => {
    expect(api.formatNumber(1234)).toBe('1,234');
  });
  it('renders 0 as 0', () => {
    expect(api.formatNumber(0)).toBe('0');
  });
  it('renders floats with up to 2 decimals', () => {
    // toLocaleString yields "1,234.57" with maximumFractionDigits: 2.
    expect(api.formatNumber(1234.567)).toMatch(/1,234\.57/);
  });
  it('returns em-dash for null/undefined', () => {
    expect(api.formatNumber(null)).toBe('—');
    expect(api.formatNumber(undefined)).toBe('—');
  });
  it('coerces strings through String()', () => {
    expect(api.formatNumber('hi')).toBe('hi');
  });
});

// ── formatTimeShort ────────────────────────────────────────────────
describe('formatTimeShort', () => {
  it('returns empty string on falsy input', () => {
    expect(api.formatTimeShort('')).toBe('');
    expect(api.formatTimeShort(null)).toBe('');
  });
  it('shows "just now" for sub-minute timestamps', () => {
    const iso = new Date(Date.now() - 5_000).toISOString();
    expect(api.formatTimeShort(iso)).toBe('just now');
  });
  it('shows minutes-ago for sub-hour timestamps', () => {
    const iso = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(api.formatTimeShort(iso)).toBe('10m ago');
  });
  it('shows hours-ago for sub-day timestamps', () => {
    const iso = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    expect(api.formatTimeShort(iso)).toBe('5h ago');
  });
  it('shows days-ago for sub-week timestamps', () => {
    const iso = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    expect(api.formatTimeShort(iso)).toBe('3d ago');
  });
  it('falls back to YYYY-MM-DD for older timestamps', () => {
    const iso = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    const out = api.formatTimeShort(iso);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── renderOverview ─────────────────────────────────────────────────
describe('renderOverview', () => {
  it('renders six cards from a complete payload', () => {
    api.renderOverview({
      users_total: 10, users_30d: 5, users_7d: 2,
      school_signups: 0, schedule_txns_total: 13, recurring_streams_total: 13,
    });
    const cards = document.querySelectorAll('#overview-grid .card');
    expect(cards.length).toBe(6);
    expect(document.getElementById('overview-grid').textContent).toContain('users · total');
    expect(document.getElementById('overview-grid').textContent).toContain('10');
    expect(document.getElementById('overview-grid').textContent).toContain('school signups');
  });

  it('renders an error banner when payload signals __error', () => {
    api.renderOverview({ __error: 'HTTP 500' });
    expect(document.getElementById('overview-grid').querySelector('.error')).not.toBe(null);
    expect(document.getElementById('overview-grid').textContent).toContain('HTTP 500');
  });

  it('escapes hostile values', () => {
    api.renderOverview({
      users_total: '<img src=x onerror=alert(1)>',
      users_30d: 0, users_7d: 0,
      school_signups: 0, schedule_txns_total: 0, recurring_streams_total: 0,
    });
    const html = document.getElementById('overview-grid').innerHTML;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

// ── renderSms ──────────────────────────────────────────────────────
describe('renderSms', () => {
  it('renders 3 cards + a table row per recent message', () => {
    api.renderSms({
      inbound_24h: 2,
      inbound_7d: 18,
      outbound_24h: 2,
      recent_messages: [
        { user_id: 'user_1', direction: 'inbound', body_preview: 'hi', created_at: new Date().toISOString() },
        { user_id: 'user_2', direction: 'outbound', body_preview: 'hello', created_at: new Date().toISOString() },
      ],
    });
    expect(document.querySelectorAll('#sms-grid .card').length).toBe(3);
    expect(document.querySelectorAll('#sms-table-wrap tbody tr').length).toBe(2);
    expect(document.getElementById('sms-table-wrap').textContent).toContain('user_1');
    expect(document.getElementById('sms-table-wrap').textContent).toContain('hello');
  });

  it('shows an empty banner when recent_messages is empty', () => {
    api.renderSms({
      inbound_24h: 0, inbound_7d: 0, outbound_24h: 0,
      recent_messages: [],
    });
    expect(document.getElementById('sms-table-wrap').querySelector('.empty')).not.toBe(null);
  });

  it('escapes message bodies', () => {
    api.renderSms({
      inbound_24h: 0, inbound_7d: 0, outbound_24h: 0,
      recent_messages: [
        { user_id: '<x>', direction: '<x>', body_preview: '<script>', created_at: new Date().toISOString() },
      ],
    });
    const html = document.getElementById('sms-table-wrap').innerHTML;
    expect(html).not.toMatch(/<script>/);
    expect(html).toContain('&lt;script&gt;');
  });
});

// ── renderFunnel ──────────────────────────────────────────────────
describe('renderFunnel', () => {
  it('renders 4 cards', () => {
    api.renderFunnel({
      signup_starts_30d: 18,
      signup_completes_30d: 12,
      school_starts_30d: 9,
      school_completes_30d: 7,
    });
    expect(document.querySelectorAll('#funnel-grid .card').length).toBe(4);
    // Conversion rate hint shows for the completes cards.
    const text = document.getElementById('funnel-grid').textContent;
    expect(text).toContain('67% conversion'); // 12/18 = 0.666... -> 67%
    expect(text).toContain('78% conversion'); // 7/9 = 0.777... -> 78%
  });

  it('omits conversion hint when starts is 0', () => {
    api.renderFunnel({
      signup_starts_30d: 0,
      signup_completes_30d: 0,
      school_starts_30d: 0,
      school_completes_30d: 0,
    });
    expect(document.getElementById('funnel-grid').textContent).not.toContain('% conversion');
  });
});

// ── renderRecurring ───────────────────────────────────────────────
describe('renderRecurring', () => {
  it('renders 4 cards + one row per top merchant', () => {
    api.renderRecurring({
      confirmed_streams: 13,
      dismissed_streams: 2,
      suggested_streams: 4,
      avg_streams_per_user: 6.5,
      top_merchants: [
        { merchant: 'Apple', count: 2 },
        { merchant: 'Spotify', count: 1 },
      ],
    });
    expect(document.querySelectorAll('#recurring-grid .card').length).toBe(4);
    expect(document.querySelectorAll('#merchant-list .merchant-row').length).toBe(2);
    expect(document.getElementById('merchant-list').textContent).toContain('Apple');
    // avg should be formatted to 2 decimals.
    expect(document.getElementById('recurring-grid').textContent).toContain('6.5');
  });

  it('shows empty banner when no merchants', () => {
    api.renderRecurring({
      confirmed_streams: 0, dismissed_streams: 0, suggested_streams: 0,
      avg_streams_per_user: 0, top_merchants: [],
    });
    expect(document.getElementById('merchant-list').querySelector('.empty')).not.toBe(null);
  });
});

// ── renderSignups ─────────────────────────────────────────────────
describe('renderSignups', () => {
  it('renders one row per item with type pill', () => {
    api.renderSignups({
      items: [
        { user_id: 'user_1', type: 'web', created_at: new Date().toISOString() },
        { user_id: 'school_2', type: 'school', created_at: new Date().toISOString() },
      ],
    });
    const rows = document.querySelectorAll('#signup-list .signup-row');
    expect(rows.length).toBe(2);
    expect(document.getElementById('signup-list').textContent).toContain('user_1');
    expect(document.getElementById('signup-list').textContent).toContain('school_2');
    expect(document.getElementById('signup-list').textContent).toContain('web');
    expect(document.getElementById('signup-list').textContent).toContain('school');
  });

  it('shows empty banner on empty items list', () => {
    api.renderSignups({ items: [] });
    expect(document.getElementById('signup-list').querySelector('.empty')).not.toBe(null);
  });

  it('shows error banner on __error payload', () => {
    api.renderSignups({ __error: 'oops' });
    expect(document.getElementById('signup-list').querySelector('.error')).not.toBe(null);
    expect(document.getElementById('signup-list').textContent).toContain('oops');
  });
});
