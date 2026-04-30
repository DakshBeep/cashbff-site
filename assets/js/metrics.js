// Admin metrics dashboard. Phase 9C.
//
// Fetches the five /api/metrics/* endpoints in parallel, renders cards +
// tables, auto-refreshes every 30 seconds. On 403 (non-admin), shows the
// access-denied panel instead of the dashboard.
//
// Auth model: the page is gated server-side. We don't try to detect admin
// status before fetching. we just attempt all five requests; if any of
// them returns 403, we flip to the denied state. credentials: 'include'
// is required so the cbff_session cookie ships with the cross-origin
// request to api.cashbff.com.
//
// Mounted on metrics.html as <script type="module"> so it runs after the
// DOM is parsed (no DOMContentLoaded juggling).

(function () {
  'use strict';

  // ── Config ─────────────────────────────────────────
  // Talks to the same API host as home.js so Sentry + cookies behave the
  // same way. localhost dev is supported via the explicit override.
  var API_BASE = window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://api.cashbff.com';

  // 30 seconds matches the user's spec. fast enough that the dashboard
  // feels live but not so fast it strains the DB on every tick.
  var REFRESH_MS = 30_000;

  // ── Endpoints ─────────────────────────────────────
  var ENDPOINTS = {
    overview: '/api/metrics/overview',
    sms: '/api/metrics/sms',
    funnel: '/api/metrics/signup-funnel',
    recurring: '/api/metrics/recurring',
    signups: '/api/metrics/recent-signups',
  };

  // ── DOM refs (resolved on init) ───────────────────
  var $main, $denied, $deniedMsg, $stamp;
  var $overviewGrid, $smsGrid, $smsTableWrap;
  var $funnelGrid, $recurringGrid, $merchantList, $signupList;

  // Track whether we've already flipped to denied so we don't keep polling.
  var deniedShown = false;
  var refreshTimer = null;

  // ── Boot ──────────────────────────────────────────
  function init() {
    $main = document.getElementById('metrics-main');
    $denied = document.getElementById('metrics-denied');
    $deniedMsg = document.getElementById('denied-message');
    $stamp = document.getElementById('refresh-stamp');
    $overviewGrid = document.getElementById('overview-grid');
    $smsGrid = document.getElementById('sms-grid');
    $smsTableWrap = document.getElementById('sms-table-wrap');
    $funnelGrid = document.getElementById('funnel-grid');
    $recurringGrid = document.getElementById('recurring-grid');
    $merchantList = document.getElementById('merchant-list');
    $signupList = document.getElementById('signup-list');

    // Show the dashboard skeleton up-front; sections render their own
    // loading state until we get data back.
    if ($main) $main.hidden = false;

    refreshAll();
    refreshTimer = setInterval(refreshAll, REFRESH_MS);
  }

  // ── Fetch helpers ─────────────────────────────────
  function fetchJson(path) {
    return fetch(API_BASE + path, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).then(function (res) {
      if (res.status === 403) {
        // Caller treats { __denied: true } as the trigger to flip the
        // page. Surfacing it here keeps the higher-level Promise.all
        // simple (no rejection-vs-resolution branching).
        return { __denied: true, __status: 403 };
      }
      if (res.status === 401) {
        // Not signed in at all. also treat as denied so the user gets
        // a clear path back to /home.html. (They can sign in there.)
        return { __denied: true, __status: 401 };
      }
      if (!res.ok) {
        return { __error: 'HTTP ' + res.status, __status: res.status };
      }
      return res.json().catch(function () {
        return { __error: 'Could not parse response' };
      });
    }).catch(function (err) {
      return { __error: String(err && err.message || err) };
    });
  }

  // ── Top-level refresh ─────────────────────────────
  function refreshAll() {
    if (deniedShown) return;

    Promise.all([
      fetchJson(ENDPOINTS.overview),
      fetchJson(ENDPOINTS.sms),
      fetchJson(ENDPOINTS.funnel),
      fetchJson(ENDPOINTS.recurring),
      fetchJson(ENDPOINTS.signups),
    ]).then(function (results) {
      // If ANY endpoint returned 403/401, flip to the denied state. the
      // dashboard is all-or-nothing (no point showing partial data the
      // user shouldn't see).
      var denied = results.find(function (r) { return r && r.__denied; });
      if (denied) {
        showDenied(denied.__status === 401 ? 'sign in to view this dashboard.' : null);
        return;
      }

      renderOverview(results[0]);
      renderSms(results[1]);
      renderFunnel(results[2]);
      renderRecurring(results[3]);
      renderSignups(results[4]);

      var now = new Date();
      if ($stamp) {
        $stamp.textContent = 'updated ' + formatTime(now);
      }
    });
  }

  // ── Denied state ──────────────────────────────────
  function showDenied(message) {
    deniedShown = true;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if ($main) $main.hidden = true;
    if ($denied) $denied.hidden = false;
    if ($deniedMsg && message) $deniedMsg.textContent = message;
  }

  // ── Renderers ────────────────────────────────────
  function renderOverview(data) {
    if (!$overviewGrid) return;
    if (!data || data.__error) {
      $overviewGrid.innerHTML = '<div class="error" style="grid-column: 1 / -1;">' +
        escapeHtml(data && data.__error || 'failed to load') + '</div>';
      return;
    }
    var cards = [
      { label: 'users · total', value: data.users_total, hint: 'web users w/ onboarding row' },
      { label: 'users · 30d', value: data.users_30d },
      { label: 'users · 7d', value: data.users_7d },
      { label: 'school signups', value: data.school_signups },
      { label: 'scheduled txns', value: data.schedule_txns_total },
      { label: 'recurring streams', value: data.recurring_streams_total, hint: 'confirmed, active' },
    ];
    $overviewGrid.innerHTML = cards.map(renderCard).join('');
  }

  function renderSms(data) {
    if (!$smsGrid || !$smsTableWrap) return;
    if (!data || data.__error) {
      $smsGrid.innerHTML = '<div class="error" style="grid-column: 1 / -1;">' +
        escapeHtml(data && data.__error || 'failed to load') + '</div>';
      $smsTableWrap.innerHTML = '<div class="error">failed to load messages</div>';
      return;
    }
    var cards = [
      { label: 'inbound · 24h', value: data.inbound_24h },
      { label: 'inbound · 7d', value: data.inbound_7d },
      { label: 'outbound · 24h', value: data.outbound_24h },
    ];
    $smsGrid.innerHTML = cards.map(renderCard).join('');

    var rows = Array.isArray(data.recent_messages) ? data.recent_messages : [];
    if (rows.length === 0) {
      $smsTableWrap.innerHTML = '<div class="empty">no messages in the recent window.</div>';
      return;
    }
    var rowsHtml = rows.map(function (m) {
      return '<tr>' +
        '<td class="col-uid">' + escapeHtml(m.user_id || '') + '</td>' +
        '<td class="col-direction" data-direction="' + escapeHtml(m.direction || '') + '">' +
          escapeHtml(m.direction || '') +
        '</td>' +
        '<td class="col-body">' + escapeHtml(m.body_preview || '') + '</td>' +
        '<td class="col-time">' + escapeHtml(formatTimeShort(m.created_at)) + '</td>' +
      '</tr>';
    }).join('');
    $smsTableWrap.innerHTML =
      '<table class="metrics-table" aria-label="recent sms messages">' +
        '<thead><tr>' +
          '<th>user</th>' +
          '<th>dir</th>' +
          '<th>body (≤60c)</th>' +
          '<th>when</th>' +
        '</tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>';
  }

  function renderFunnel(data) {
    if (!$funnelGrid) return;
    if (!data || data.__error) {
      $funnelGrid.innerHTML = '<div class="error" style="grid-column: 1 / -1;">' +
        escapeHtml(data && data.__error || 'failed to load') + '</div>';
      return;
    }
    var cards = [
      { label: 'web · starts', value: data.signup_starts_30d },
      { label: 'web · completes', value: data.signup_completes_30d, hint: convRate(data.signup_completes_30d, data.signup_starts_30d) },
      { label: 'school · starts', value: data.school_starts_30d },
      { label: 'school · completes', value: data.school_completes_30d, hint: convRate(data.school_completes_30d, data.school_starts_30d) },
    ];
    $funnelGrid.innerHTML = cards.map(renderCard).join('');
  }

  function renderRecurring(data) {
    if (!$recurringGrid || !$merchantList) return;
    if (!data || data.__error) {
      $recurringGrid.innerHTML = '<div class="error" style="grid-column: 1 / -1;">' +
        escapeHtml(data && data.__error || 'failed to load') + '</div>';
      $merchantList.innerHTML = '<div class="error">failed to load merchants</div>';
      return;
    }
    var avg = typeof data.avg_streams_per_user === 'number' ? data.avg_streams_per_user.toFixed(2) : '-';
    var cards = [
      { label: 'confirmed', value: data.confirmed_streams },
      { label: 'dismissed', value: data.dismissed_streams },
      { label: 'suggested', value: data.suggested_streams },
      { label: 'avg / user', value: avg, small: true },
    ];
    $recurringGrid.innerHTML = cards.map(renderCard).join('');

    var merchants = Array.isArray(data.top_merchants) ? data.top_merchants : [];
    if (merchants.length === 0) {
      $merchantList.innerHTML = '<div class="empty">no confirmed merchants yet.</div>';
      return;
    }
    $merchantList.innerHTML = merchants.map(function (m) {
      return '<div class="merchant-row">' +
        '<span class="merchant-row__name">' + escapeHtml(m.merchant || '') + '</span>' +
        '<span class="merchant-row__count">' + escapeHtml(String(m.count || 0)) + '</span>' +
      '</div>';
    }).join('');
  }

  function renderSignups(data) {
    if (!$signupList) return;
    if (!data || data.__error) {
      $signupList.innerHTML = '<div class="error">' +
        escapeHtml(data && data.__error || 'failed to load') + '</div>';
      return;
    }
    var items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      $signupList.innerHTML = '<div class="empty">no signups yet.</div>';
      return;
    }
    $signupList.innerHTML = items.map(function (s) {
      return '<div class="signup-row">' +
        '<span class="signup-row__uid">' + escapeHtml(s.user_id || '') + '</span>' +
        '<span class="signup-row__type" data-type="' + escapeHtml(s.type || '') + '">' +
          escapeHtml(s.type || '') +
        '</span>' +
        '<span class="signup-row__time">' + escapeHtml(formatTimeShort(s.created_at)) + '</span>' +
      '</div>';
    }).join('');
  }

  // ── Card template ────────────────────────────────
  function renderCard(c) {
    var hint = c.hint
      ? '<div class="card__hint">' + escapeHtml(c.hint) + '</div>'
      : '';
    var valueClass = c.small ? 'card__value card__value--small' : 'card__value';
    return '<div class="card">' +
      '<div class="card__label">' + escapeHtml(c.label) + '</div>' +
      '<div class="' + valueClass + '">' + escapeHtml(formatNumber(c.value)) + '</div>' +
      hint +
    '</div>';
  }

  // ── Formatters ───────────────────────────────────
  function formatNumber(v) {
    if (v == null) return '-';
    if (typeof v === 'number' && Number.isFinite(v)) {
      // No decimals for integers; locale-formatted otherwise.
      if (Number.isInteger(v)) return v.toLocaleString();
      return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return String(v);
  }

  function convRate(num, denom) {
    var n = Number(num);
    var d = Number(denom);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return '';
    var pct = (n / d) * 100;
    return pct.toFixed(0) + '% conversion';
  }

  function formatTime(d) {
    if (!(d instanceof Date)) d = new Date(d);
    if (Number.isNaN(d.getTime())) return '';
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var ss = String(d.getSeconds()).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }

  function formatTimeShort(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    var now = new Date();
    var diffMs = now.getTime() - d.getTime();
    var diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return diffMin + 'm ago';
    var diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + 'h ago';
    var diffD = Math.floor(diffH / 24);
    if (diffD < 7) return diffD + 'd ago';
    // Older. fall back to a calendar date.
    return d.toISOString().slice(0, 10);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Test hook (used by vitest jsdom tests) ───────
  // Mirror the shape home.js uses: expose pure helpers on a window-keyed
  // namespace so unit tests can import the module and assert on rendering
  // without standing up the full UI.
  if (typeof window !== 'undefined') {
    window.__metricsDashboard = {
      renderCard: renderCard,
      renderOverview: renderOverview,
      renderSms: renderSms,
      renderFunnel: renderFunnel,
      renderRecurring: renderRecurring,
      renderSignups: renderSignups,
      formatNumber: formatNumber,
      formatTimeShort: formatTimeShort,
      escapeHtml: escapeHtml,
      __init: init,
      __setRefsForTest: function (refs) {
        $main = refs.$main || $main;
        $denied = refs.$denied || $denied;
        $deniedMsg = refs.$deniedMsg || $deniedMsg;
        $stamp = refs.$stamp || $stamp;
        $overviewGrid = refs.$overviewGrid || $overviewGrid;
        $smsGrid = refs.$smsGrid || $smsGrid;
        $smsTableWrap = refs.$smsTableWrap || $smsTableWrap;
        $funnelGrid = refs.$funnelGrid || $funnelGrid;
        $recurringGrid = refs.$recurringGrid || $recurringGrid;
        $merchantList = refs.$merchantList || $merchantList;
        $signupList = refs.$signupList || $signupList;
      },
      __resetDeniedForTest: function () {
        deniedShown = false;
      },
    };
  }

  // ── Auto-init when DOM is ready ──────────────────
  // Only auto-init when running in a real browser (we have a body and the
  // metrics.html scaffold). The vitest jsdom env imports this module to
  // exercise pure helpers. it shouldn't kick off a setInterval.
  var inBrowser = typeof document !== 'undefined' &&
    document.getElementById &&
    document.getElementById('metrics-main') !== null;
  if (inBrowser) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
