// home.js — auth-gated calendar-month view with dummy pre-committed expenses.
//
// This is the post-login landing page. It:
//   1. Calls GET /api/me to gate the page. 401 => redirect to "/".
//   2. Populates the top-right chip as "+N signed in" where N is the
//      returned user_id's digit count (same pattern as the v2 scatter page).
//   3. Wires the sign-out link to POST /api/logout + redirect.
//   4. Renders a calendar-month grid of HARDCODED dummy expenses (PRECOMMITS),
//      with pills colored by type, a click-to-open day drawer, and month
//      navigation arrows. No /api/home fetch, no real cards.
//   5. Wires the floating "+ add account" button to the existing add-account
//      modal via window.CashBFFAddAccount.open().
//
// Keep inline JS out of home.html — CSP blocks inline scripts. Everything
// executable lives here or in add-account.js / sentry-init.js.
(function () {
  'use strict';

  var API_BASE = 'https://api.cashbff.com';

  // Pre-committed expenses for the logged-in user. Empty until we wire real
  // data (Plaid-derived recurring + card minimums + manual entries).
  var PRECOMMITS = [];

  var MONTHS = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december'
  ];
  // Frozen "today" so the dummy pills highlight the right cell regardless of
  // clock drift while we demo the flow.
  var today = new Date(2026, 3, 23); // Apr 23, 2026
  var view = new Date(today.getFullYear(), today.getMonth(), 1);

  // ── DOM refs, populated on boot() ────────────────
  var grid, monthTitle, totalPill, prevBtn, nextBtn;
  var drawer, drawerOverlay, drawerDate, drawerTotal, drawerList, drawerClose;

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

  function totalForMonth(year, month) {
    return PRECOMMITS.reduce(function (sum, e) {
      var d = new Date(e.date + 'T12:00:00');
      if (d.getFullYear() === year && d.getMonth() === month) return sum + e.amount;
      return sum;
    }, 0);
  }

  // ── Calendar grid render ─────────────────────────
  function renderGrid() {
    if (!grid) return;
    grid.innerHTML = '';
    var year = view.getFullYear();
    var month = view.getMonth();
    var firstDay = new Date(year, month, 1);
    var startOfGrid = new Date(year, month, 1 - firstDay.getDay()); // start on Sunday

    monthTitle.textContent = MONTHS[month] + ' ' + year;
    var total = totalForMonth(year, month);
    // [TODO] copy here is placeholder — placement + "spoken for" framing is
    // intentional, but the specific wording ("nothing spoken for yet — this
    // month is open") needs a brand-voice rewrite before launch.
    totalPill.innerHTML = total > 0
      ? '<strong>' + money(total) + '</strong> already spoken for this month'
      : 'nothing spoken for yet — this month is open';
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
        // First-word label keeps pills narrow inside cramped cells.
        p.textContent = '$' + e.amount.toFixed(0) + ' ' + e.name.split(' ')[0];
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
      cell.addEventListener('click', (function (d) {
        return function () { openDrawer(d); };
      })(dateCopy));

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

  // ── Day drawer ───────────────────────────────────
  function openDrawer(d) {
    if (!drawer) return;
    var exps = expensesForDate(d);
    var total = exps.reduce(function (s, e) { return s + e.amount; }, 0);
    drawerDate.textContent = MONTHS[d.getMonth()] + ' ' + d.getDate();
    drawerTotal.innerHTML = exps.length
      ? '<strong>' + money(total) + '</strong> on this day'
      : '';
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
        var typeLabel = {
          bill: 'bill', cc: 'card minimum', sub: 'subscription', planned: 'planned'
        }[e.type] || e.type;
        // textContent-safe construction (name comes from dummy data, not user input,
        // but keep it safe anyway to match the eventual real-data path).
        var nameDiv = document.createElement('div');
        nameDiv.className = 'name';
        nameDiv.textContent = e.name + ' ';
        var small = document.createElement('small');
        small.textContent = typeLabel + (e.confidence < 1.0
          ? ' · ' + Math.round(e.confidence * 100) + '% confidence'
          : '');
        nameDiv.appendChild(small);

        var amtDiv = document.createElement('div');
        amtDiv.className = 'amt';
        amtDiv.textContent = '$' + e.amount.toFixed(2);

        item.appendChild(nameDiv);
        item.appendChild(amtDiv);
        drawerList.appendChild(item);
      });
    }
    drawer.classList.add('open');
    drawerOverlay.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
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
    totalPill    = document.getElementById('total-pill');
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
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      view.setMonth(view.getMonth() + 1);
      renderGrid();
    });
    if (drawerOverlay) drawerOverlay.addEventListener('click', closeDrawer);
    if (drawerClose)   drawerClose.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
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
    renderGrid();
    // Gate the page on /api/me. If the user isn't signed in we'll have already
    // redirected to "/" — the calendar they briefly saw is acceptable; the
    // alternative (hiding everything until /api/me returns) would flash blank.
    gateAuth().catch(function () {
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
