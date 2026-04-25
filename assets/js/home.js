// home.js — auth-gated calendar-month view backed by /api/calendar.
//
// This is the post-login landing page. It:
//   1. Calls GET /api/me to gate the page. 401 => redirect to "/".
//   2. Populates the top-right chip as "···NNNN signed in" using the last 4
//      digits of the returned phone number.
//   3. Wires the sign-out link to POST /api/logout + redirect.
//   4. Fetches real expenses from GET /api/calendar?from=&to= — seeded with a
//      single fallback entry (Apr 22 income) so the demo still shows something
//      if the backend isn't live yet. Renders them in a calendar-month grid
//      with pills colored by type, a click-to-open day drawer, and month nav.
//   5. Wires the floating "+ add account" button to the existing add-account
//      modal via window.CashBFFAddAccount.open().
//
// Keep inline JS out of home.html — CSP blocks inline scripts. Everything
// executable lives here or in add-account.js / sentry-init.js.
(function () {
  'use strict';

  var API_BASE = 'https://api.cashbff.com';

  // Expenses for the logged-in user. Seeded with a single fallback entry so
  // the demo still renders something on Apr 22 if the backend isn't live.
  // Populated/merged from GET /api/calendar on boot + month nav.
  var PRECOMMITS = [
    { date: '2026-04-22', amount: 127.01, name: 'IAIC claim payment', type: 'income', confidence: 0.9, pending: false }
  ];

  // Cache of "YYYY-MM" keys whose month ranges we've already fetched, so we
  // don't re-request on every prev/next nav. Initial boot fetches the last 14
  // days, which always covers the current month; we mark it fetched up front.
  var fetchedMonths = new Set();

  var MONTHS = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december'
  ];
  // Real today. Floor to local midnight so iso()/sameYMD comparisons are stable.
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var view = new Date(today.getFullYear(), today.getMonth(), 1);

  // ── DOM refs, populated on boot() ────────────────
  var grid, monthTitle, prevBtn, nextBtn;
  var drawer, drawerOverlay, drawerDate, drawerTotal, drawerList, drawerClose;
  var schedBtn, schedOverlay, schedPop, schedClose;

  // Signup boundary — the earliest month the calendar lets the user nav to.
  // Set after /api/me resolves. Before that, stays null and prev-nav is allowed.
  var earliestViewableMonth = null;

  // ── Small helpers ────────────────────────────────
  function iso(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function sameYMD(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth()    === b.getMonth() &&
           a.getDate()     === b.getDate();
  }
  function money(n) {
    return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function expensesForDate(d) {
    var key = iso(d);
    return PRECOMMITS.filter(function (e) { return e.date === key; });
  }

  // ── /api/calendar fetch + merge ──────────────────
  // Merge a batch of expenses into PRECOMMITS, replacing any entries whose
  // (date,name,amount,type) tuple already exists. That keeps the Apr 22
  // fallback in place if the backend returns nothing for that day, but lets
  // the backend's canonical version win when present.
  function mergeExpenses(batch) {
    if (!Array.isArray(batch) || !batch.length) return;
    batch.forEach(function (incoming) {
      if (!incoming || !incoming.date) return;
      var dupeIdx = -1;
      for (var i = 0; i < PRECOMMITS.length; i++) {
        var e = PRECOMMITS[i];
        if (e.date === incoming.date &&
            e.name === incoming.name &&
            e.amount === incoming.amount &&
            e.type === incoming.type) {
          dupeIdx = i;
          break;
        }
      }
      if (dupeIdx >= 0) {
        PRECOMMITS[dupeIdx] = incoming;
      } else {
        PRECOMMITS.push(incoming);
      }
    });
  }

  function fetchCalendarRange(fromISO, toISO) {
    var url = API_BASE + '/api/calendar?from=' + encodeURIComponent(fromISO) +
              '&to=' + encodeURIComponent(toISO);
    return fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      // 401 is handled globally by gateAuth; here we just bail quietly so a
      // stale session during pagination doesn't spam errors.
      if (res.status === 401) return null;
      if (!res.ok) throw new Error('calendar fetch failed ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data) return;
      mergeExpenses(data.expenses || []);
      renderGrid();
    }).catch(function (err) {
      // Non-2xx (and non-401) or network blip: log + leave existing data in
      // place so the fallback Apr 22 entry and any prior fetches stay visible.
      try { console.warn('[home] calendar fetch error:', err); } catch (_) {}
    });
  }

  function monthKey(year, month) {
    return year + '-' + String(month + 1).padStart(2, '0');
  }

  // Initial fetch: last 14 days through today. Covers the current month in
  // the common case where today is mid-month-ish; the month-key cache then
  // suppresses a redundant refetch when the user stays on this month.
  function fetchInitialWindow() {
    var end = new Date(today);
    var start = new Date(today);
    start.setDate(start.getDate() - 13);
    fetchedMonths.add(monthKey(today.getFullYear(), today.getMonth()));
    return fetchCalendarRange(iso(start), iso(end));
  }

  // Month-scoped fetch on prev/next nav. Computes the full month range
  // (1st through last day) so any pill that belongs to this month arrives.
  function fetchMonthIfNeeded(year, month) {
    var key = monthKey(year, month);
    if (fetchedMonths.has(key)) return;
    fetchedMonths.add(key);
    var start = new Date(year, month, 1);
    var end = new Date(year, month + 1, 0); // day 0 of next month = last day of this month
    fetchCalendarRange(iso(start), iso(end));
  }

  // NOTE: totalForMonth() lived here previously for the "$X already spoken
  // for this month" pill. Removed along with the pill. If a monthly metric
  // comes back, rebuild it here and decide cleanly what it sums.

  // ── Calendar grid render ─────────────────────────
  function renderGrid() {
    if (!grid) return;
    grid.innerHTML = '';
    var year = view.getFullYear();
    var month = view.getMonth();
    var firstDay = new Date(year, month, 1);
    var startOfGrid = new Date(year, month, 1 - firstDay.getDay()); // start on Sunday

    monthTitle.textContent = MONTHS[month] + ' ' + year;
    updatePrevArrowState();

    for (var i = 0; i < 42; i++) {
      var cellDate = new Date(startOfGrid);
      cellDate.setDate(startOfGrid.getDate() + i);

      var cell = document.createElement('div');
      cell.className = 'cell';
      if (cellDate.getMonth() !== month) cell.classList.add('off-month');
      if (sameYMD(cellDate, today)) cell.classList.add('today');

      var dateLabel = document.createElement('span');
      dateLabel.className = 'date';
      dateLabel.textContent = cellDate.getDate();
      cell.appendChild(dateLabel);

      var exps = expensesForDate(cellDate);
      var maxPills = 2;
      exps.slice(0, maxPills).forEach(function (e) {
        var p = document.createElement('span');
        p.className = 'pill ' + e.type;
        // Pending (not-yet-settled) transactions render italic — same color,
        // just a visual "about to settle" cue.
        if (e.pending) p.classList.add('pending-tx');
        // First-word label keeps pills narrow inside cramped cells.
        // Income gets a leading "+" so it reads as money in at a glance.
        var prefix = e.type === 'income' ? '+$' : '$';
        p.textContent = prefix + e.amount.toFixed(0) + ' ' + e.name.split(' ')[0];
        cell.appendChild(p);
      });
      if (exps.length > maxPills) {
        var ov = document.createElement('span');
        ov.className = 'overflow';
        ov.textContent = '+' + (exps.length - maxPills) + ' more';
        cell.appendChild(ov);
      }

      // Snapshot the date for the click handler (the loop var would alias).
      var dateCopy = new Date(cellDate);
      cell.addEventListener('click', (function (d, el) {
        return function (ev) {
          ev.stopPropagation();
          openDrawer(d, el);
        };
      })(dateCopy, cell));

      grid.appendChild(cell);
    }
    // Hide the last row if it's entirely off-month (keeps the layout tidy).
    var lastRowStart = new Date(startOfGrid);
    lastRowStart.setDate(startOfGrid.getDate() + 35);
    if (lastRowStart.getMonth() !== month) {
      var cells = grid.querySelectorAll('.cell');
      for (var j = 35; j < 42; j++) {
        if (cells[j]) cells[j].style.display = 'none';
      }
    }
  }

  // ── Day popover (anchored near the clicked cell) ─────────
  function positionPopoverNear(anchorEl) {
    if (!drawer || !anchorEl) return;
    // Mobile breakpoint: CSS handles bottom-docked layout via !important.
    if (window.innerWidth <= 520) return;

    // First render invisibly to measure, then place.
    drawer.style.visibility = 'hidden';
    drawer.style.top = '0px';
    drawer.style.left = '0px';
    // force layout
    var cardRect = drawer.getBoundingClientRect();
    var cardW = cardRect.width;
    var cardH = cardRect.height;

    var rect = anchorEl.getBoundingClientRect();
    var gap = 8;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // Prefer below, then above; horizontally center on the anchor, clamped.
    var top = rect.bottom + gap;
    if (top + cardH > vh - 8) {
      top = Math.max(8, rect.top - gap - cardH);
    }
    var left = rect.left + rect.width / 2 - cardW / 2;
    left = Math.max(8, Math.min(left, vw - cardW - 8));

    drawer.style.top = top + 'px';
    drawer.style.left = left + 'px';
    drawer.style.visibility = '';
  }

  // ── Day popover content ──────────────────────────
  function openDrawer(d, anchorEl) {
    if (!drawer) return;
    var exps = expensesForDate(d);
    // Day total sums outflows only; income is shown inline but doesn't net
    // against the "on this day" number to keep the framing honest.
    var outflow = exps.reduce(function (s, e) {
      return e.type === 'income' ? s : s + e.amount;
    }, 0);
    var incomeCount = exps.filter(function (e) { return e.type === 'income'; }).length;
    drawerDate.textContent = MONTHS[d.getMonth()] + ' ' + d.getDate();
    // Day total line only appears when there's actual outflow. Income-only
    // days are quiet — the item itself is the whole story, no commentary.
    if (outflow > 0) {
      drawerTotal.innerHTML = '<strong>' + money(outflow) + '</strong> on this day';
    } else {
      drawerTotal.innerHTML = '';
    }
    drawerList.innerHTML = '';
    if (!exps.length) {
      var em = document.createElement('div');
      em.className = 'drawer-empty';
      em.textContent = 'nothing scheduled — a free day.';
      drawerList.appendChild(em);
    } else {
      exps.forEach(function (e) {
        var item = document.createElement('div');
        item.className = 'drawer-item';
        // Pending: italic on the name via the same class used on cell pills.
        if (e.pending) item.classList.add('pending-tx');
        // textContent-safe construction — backend has already cleaned the
        // name, but keep the XSS-safe path regardless.
        var nameDiv = document.createElement('div');
        nameDiv.className = 'name';
        nameDiv.textContent = e.name;

        // Confidence-% subtext intentionally dropped for now — user wants a
        // minimal row. Revisit when confidence values actually vary.

        var amtDiv = document.createElement('div');
        amtDiv.className = 'amt';
        // Income renders with a leading "+" so it visually reads as money in.
        amtDiv.textContent = (e.type === 'income' ? '+$' : '$') + e.amount.toFixed(2);

        item.appendChild(nameDiv);
        item.appendChild(amtDiv);
        drawerList.appendChild(item);
      });
    }
    drawer.classList.add('open');
    drawerOverlay.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    // Anchor the popover near the clicked cell (desktop); CSS handles mobile.
    positionPopoverNear(anchorEl);
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  // ── Auth + header chip ──────────────────────────
  // Returns a promise that resolves once the user is confirmed signed in,
  // or never resolves (because we redirected) on 401.
  function gateAuth() {
    return fetch(API_BASE + '/api/me', {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      if (res.status === 401) {
        location.replace('/');
        return new Promise(function () {}); // never resolves — page is navigating away
      }
      if (!res.ok) throw new Error('bad response ' + res.status);
      return res.json();
    }).then(function (data) {
      // Top-right pill: last 4 of the user's real phone number, so "signed in
      // as ···5819" reads accurately instead of the meaningless digit count.
      var pill = document.getElementById('phone-pill');
      if (pill) {
        var phone = data && data.phone ? String(data.phone) : '';
        var last4 = phone.replace(/\D/g, '').slice(-4);
        pill.textContent = last4 ? '···' + last4 + ' signed in' : 'signed in';
      }
      // Clamp the calendar's earliest viewable month to the user's signup
      // month — pre-signup calendar views are meaningless (no backfill yet).
      if (data && data.created_at) {
        var signup = new Date(data.created_at);
        earliestViewableMonth = new Date(signup.getFullYear(), signup.getMonth(), 1);
        updatePrevArrowState();
      }
      return data;
    });
  }

  function atEarliestMonth() {
    if (!earliestViewableMonth) return false;
    return view.getFullYear() === earliestViewableMonth.getFullYear() &&
           view.getMonth()    === earliestViewableMonth.getMonth();
  }
  function updatePrevArrowState() {
    if (!prevBtn) return;
    if (atEarliestMonth()) {
      prevBtn.style.opacity = '0.2';
      prevBtn.style.pointerEvents = 'none';
      prevBtn.setAttribute('aria-disabled', 'true');
    } else {
      prevBtn.style.opacity = '';
      prevBtn.style.pointerEvents = '';
      prevBtn.removeAttribute('aria-disabled');
    }
  }

  function wireSignout() {
    var btn = document.getElementById('signout');
    if (!btn) return;
    btn.addEventListener('click', function () {
      fetch(API_BASE + '/api/logout', { method: 'POST', credentials: 'include' })
        .catch(function () {})
        .then(function () {
          try { localStorage.clear(); } catch (_) {}
          location.replace('/');
        });
    });
  }

  // ── Calendar nav wiring ─────────────────────────
  function wireCalendar() {
    grid         = document.getElementById('grid');
    monthTitle   = document.getElementById('month-title');
    prevBtn      = document.getElementById('prev-month');
    nextBtn      = document.getElementById('next-month');
    drawer       = document.getElementById('drawer');
    drawerOverlay= document.getElementById('drawer-overlay');
    drawerDate   = document.getElementById('drawer-date');
    drawerTotal  = document.getElementById('drawer-total');
    drawerList   = document.getElementById('drawer-list');
    drawerClose  = document.getElementById('drawer-close');

    if (prevBtn) prevBtn.addEventListener('click', function () {
      if (atEarliestMonth()) return; // clamp — can't go back past signup month
      view.setMonth(view.getMonth() - 1);
      renderGrid();
      fetchMonthIfNeeded(view.getFullYear(), view.getMonth());
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      view.setMonth(view.getMonth() + 1);
      renderGrid();
      fetchMonthIfNeeded(view.getFullYear(), view.getMonth());
    });
    if (drawerOverlay) drawerOverlay.addEventListener('click', closeDrawer);
    if (drawerClose)   drawerClose.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDrawer(); closeSchedule(); }
    });
  }

  // ── Schedule-spend button + placeholder popup ────
  function openSchedule() {
    if (!schedPop || !schedOverlay) return;
    schedPop.classList.add('open');
    schedOverlay.classList.add('open');
    schedPop.setAttribute('aria-hidden', 'false');
  }
  function closeSchedule() {
    if (!schedPop || !schedOverlay) return;
    schedPop.classList.remove('open');
    schedOverlay.classList.remove('open');
    schedPop.setAttribute('aria-hidden', 'true');
  }
  function wireScheduleBtn() {
    schedBtn      = document.getElementById('schedule-btn');
    schedOverlay  = document.getElementById('schedule-overlay');
    schedPop      = document.getElementById('schedule-pop');
    schedClose    = document.getElementById('schedule-close');
    if (schedBtn)     schedBtn.addEventListener('click', openSchedule);
    if (schedClose)   schedClose.addEventListener('click', closeSchedule);
    if (schedOverlay) schedOverlay.addEventListener('click', closeSchedule);
  }

  // ── Add-account button wiring ───────────────────
  function wireAddAccountBtn() {
    var btn = document.getElementById('add-account-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (window.CashBFFAddAccount && typeof window.CashBFFAddAccount.open === 'function') {
        window.CashBFFAddAccount.open();
      }
    });
  }

  // ── Boot ────────────────────────────────────────
  function boot() {
    wireSignout();
    wireCalendar();
    wireAddAccountBtn();
    wireScheduleBtn();
    renderGrid();
    // Gate the page on /api/me. If the user isn't signed in we'll have already
    // redirected to "/" — the calendar they briefly saw is acceptable; the
    // alternative (hiding everything until /api/me returns) would flash blank.
    gateAuth().then(function () {
      // Only fetch calendar data once auth is confirmed, so we don't hit the
      // endpoint for a user we're about to redirect anyway.
      fetchInitialWindow();
    }).catch(function () {
      // Network hiccup or 5xx — leave the page visible; user can retry by
      // reloading. We deliberately don't hard-redirect so a transient error
      // doesn't kick a signed-in user out.
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
