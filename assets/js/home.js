// home.js — auth-gated calendar-month view backed by /api/calendar.
//
// This is the post-login landing page. It:
//   1. Calls GET /api/me to gate the page. 401 => redirect to "/".
//   2. Populates the top-right chip as "···NNNN signed in" using the last 4
//      digits of the returned phone number.
//   3. Wires the sign-out link to POST /api/logout + redirect.
//   4. Fetches real expenses from GET /api/calendar?from=&to=. On boot the
//      calendar + balances are fetched fresh on every page load — no
//      localStorage hydration. The thin progress bar at the top of
//      home.html (#page-loader) communicates the wait while /api/me,
//      /api/calendar, and /api/balances are in flight. Renders results in a
//      calendar-month grid with pills colored by type, a click-to-open day
//      drawer, and month nav. Reimbursements still use SWR (panel-scoped).
//   5. Wires the floating "+ add account" button to the existing add-account
//      modal via window.CashBFFAddAccount.open().
//
// Keep inline JS out of home.html — CSP blocks inline scripts. Everything
// executable lives here or in add-account.js / sentry-init.js.
(function () {
  'use strict';

  var API_BASE = 'https://api.cashbff.com';

  // ── Tiny SWR cache module ────────────────────────
  // Versioned localStorage shim. Currently only used by reimbursements —
  // calendar + balances were intentionally pulled off SWR (zombie scheduled
  // txns + stale running-balance figures kept surfacing on boot before the
  // live fetches could resolve). Helpers and the cbff_v1_ prefix are kept
  // in case we want SWR back for those panels later. Bump STORAGE_PREFIX
  // to invalidate old keys.
  var STORAGE_PREFIX = 'cbff_v1_';
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — cap age so we don't hydrate truly ancient data

  function cacheRead(key) {
    try {
      var raw = localStorage.getItem(STORAGE_PREFIX + key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.savedAt !== 'number') return null;
      if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;
      return parsed.value;
    } catch (_) { return null; }
  }
  function cacheWrite(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify({
        savedAt: Date.now(), value: value
      }));
    } catch (_) { /* private mode / quota — silently skip */ }
  }
  function cacheClearAll() {
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(STORAGE_PREFIX) === 0) localStorage.removeItem(k);
      });
    } catch (_) {}
  }

  // ── Page-loader inflight tracker ─────────────────
  // Drives the thin progress bar at the top of home.html. The boot sequence
  // wraps each network call (gateAuth, fetchInitialWindow, fetchBalancesOnce)
  // in startLoading/endLoading so the bar stays up while ANY of them is in
  // flight and disappears when all have settled. Use .finally(endLoading)
  // (or the polyfilled equivalent) so error paths don't leave the bar stuck.
  var pageLoader = null; // bound on boot via wirePageLoader()
  var inflightCount = 0;
  function startLoading() {
    inflightCount++;
    if (inflightCount === 1 && pageLoader) {
      pageLoader.classList.add('is-loading');
    }
  }
  function endLoading() {
    inflightCount = Math.max(0, inflightCount - 1);
    if (inflightCount === 0 && pageLoader) {
      pageLoader.classList.remove('is-loading');
    }
  }
  // Run a callback on settle for any promise, regardless of whether
  // Promise.prototype.finally is available (older Safari/Edge).
  function settle(promise, cb) {
    if (promise && typeof promise.finally === 'function') {
      return promise.finally(cb);
    }
    return Promise.resolve(promise).then(function (v) {
      try { cb(); } catch (_) {}
      return v;
    }, function (e) {
      try { cb(); } catch (_) {}
      throw e;
    });
  }

  // Expenses for the logged-in user. Empty by default; populated by the
  // /api/calendar fetch on boot. Calendar data is no longer hydrated from
  // localStorage — the user wants a fresh load every time, with the page
  // loader bar communicating the wait. See hydrateFromCache() below.
  var PRECOMMITS = [];

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
  var drawerProjected;

  // Today's running balance (depository - credit, using balanceForRow per
  // account). Set when /api/balances resolves; null until then. Used to
  // project per-day balance after scheduled outflows in the day popover.
  var currentRunningBalance = null;
  var schedBtn, schedOverlay, schedPop, schedClose, schedTitle;
  var schedForm, schedDate, schedAmount, schedName, schedTypeChips,
      schedCard, schedNote, schedError, schedSubmit;
  var schedFooter, schedDeleteBtn, schedDeleteConfirm,
      schedDeleteYes, schedDeleteCancel;
  var balBtn, balOverlay, balPop, balClose,
      balSummary, balStatus, balGroups, balAsOf;
  var reimbBtn, reimbOverlay, reimbPop, reimbClose,
      reimbAddForm, reimbAddInput, reimbAddBtn,
      reimbError, reimbStatus, reimbGroups;

  // Edit-mode flag for the schedule popup. null = create mode (default), a
  // string id = edit mode for that scheduled transaction. Toggled by
  // openSchedule(txn) and reset by resetScheduleForm() / openSchedule().
  var editingTxnId = null;

  // Cards list for the schedule form's card select. Lazily fetched on first
  // open, then cached in memory for the page lifetime.
  var cardsCache = null;
  var cardsFetchInflight = null;

  // Balances list for the balances popup. Lazily fetched on first open and
  // reused on subsequent opens — the panel doesn't refetch on close/reopen.
  var balancesCache = null;
  var balancesFetchInflight = null;

  // Reimbursements list for the reimbursements popup. Lazily fetched on first
  // open, then evicted on every successful mutation (POST/PATCH/DELETE) so the
  // next open refetches. Still SWR: hydrated from localStorage on boot for
  // instant paint when the panel opens, then refreshed from the live API.
  // (Calendar + balances were pulled off SWR — this panel kept it because
  // the data is small and panel-scoped.)
  var reimbursementsCache = null;
  var reimbursementsFetchInflight = null;

  // Earliest month the calendar lets the user nav back to. Initialized from
  // signup_month (via /api/me). Then extended backward whenever a calendar
  // fetch surfaces transactions older than the current boundary — Plaid's
  // historical sync is often deeper than the user's CashBFF signup date,
  // and that data is still genuinely theirs to see.
  var earliestViewableMonth = null;

  function extendEarliestFromData() {
    if (!PRECOMMITS.length) return;
    var earliestDate = null;
    for (var i = 0; i < PRECOMMITS.length; i++) {
      var d = PRECOMMITS[i].date;
      if (!d) continue;
      if (earliestDate === null || d < earliestDate) earliestDate = d;
    }
    if (!earliestDate) return;
    var parts = earliestDate.split('-');
    var dataMonth = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    if (!earliestViewableMonth || dataMonth.getTime() < earliestViewableMonth.getTime()) {
      earliestViewableMonth = dataMonth;
      updatePrevArrowState();
    }
  }

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

  // ── SWR hydration (reimbursements only) ──────────
  // Calendar + balances are NO LONGER hydrated from localStorage. The user
  // wants a fresh load every time — the page-loader bar at the top of
  // home.html signals the wait. Hydrating calendar from a stale cache was
  // surfacing zombie scheduled txns and stale running-balance figures until
  // the live fetches resolved. Reimbursements stays SWR (small data,
  // panel-scoped, low risk).
  // The cacheRead/cacheWrite helpers and the cbff_v1_ prefix are kept in
  // case we want to bring SWR back for calendar/balances later.
  function hydrateFromCache() {
    var cachedReimbursements = cacheRead('reimbursements');
    if (Array.isArray(cachedReimbursements)) {
      reimbursementsCache = cachedReimbursements;
    }
  }

  // ── /api/calendar fetch + merge ──────────────────
  // Merge a batch of expenses into PRECOMMITS, replacing any entries whose
  // (date,name,amount,type) tuple already exists. Cache-hydrated rows from
  // a previous session get overwritten by the backend's canonical version
  // when it arrives; rows the backend doesn't return stay until the next
  // full month-fetch evicts them.
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
      var expenses = data.expenses || [];
      // Canonical range refresh: PURGE any existing in-memory entries within
      // the requested [fromISO, toISO] window before merging. Without this,
      // entries deleted server-side (e.g. an old scheduled txn we DELETE'd
      // from another device or a stale cache hydrated from localStorage)
      // would stick around forever because mergeExpenses only adds/updates,
      // never removes. The server's response IS the truth for its range.
      PRECOMMITS = PRECOMMITS.filter(function (e) {
        return !(e.date >= fromISO && e.date <= toISO);
      });
      mergeExpenses(expenses);
      // Extend earliestViewableMonth backward if this batch contained txns
      // from before the signup-month clamp. Plaid's historical sync often
      // pulls 12-24 months of bank-side data, all of which is genuinely the
      // user's — they should be able to navigate to it.
      extendEarliestFromData();
      renderGrid();
      // No localStorage write — calendar is fresh on every load now.
      // /api/calendar may have triggered an on-demand Plaid sync server-side
      // (debounced 5min). If it did, balances may have changed too — evict
      // the in-memory cache so the next balances open refetches fresh data
      // instead of returning a stale pre-sync snapshot.
      balancesCache = null;
      balancesFetchInflight = null;
    }).catch(function (err) {
      // Non-2xx (and non-401) or network blip: log + leave existing data in
      // place so any prior fetches and cache-hydrated rows stay visible.
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
    // Backfill ALL the user's data on boot — past 350 days + next 2 months.
    // /api/calendar caps a single request at 365 days, so we issue TWO
    // parallel range fetches and merge. Covers the full Plaid historical
    // sync (typically 12-24 months of bank-side data) AND near-future
    // scheduled/reimburse txns. fetchedMonths is marked for every spanned
    // month so prev/next nav doesn't redundantly refetch.
    var todayLocal = new Date(today);
    var todayISO = iso(todayLocal);

    var pastStart = new Date(todayLocal);
    pastStart.setDate(pastStart.getDate() - 350);

    var futStart = new Date(todayLocal);
    futStart.setDate(futStart.getDate() + 1);
    var futEnd = new Date(todayLocal.getFullYear(), todayLocal.getMonth() + 3, 0);

    // Mark every spanned month as already-fetched so month nav uses the
    // initial fetch's data and doesn't kick a redundant request.
    var d = new Date(pastStart.getFullYear(), pastStart.getMonth(), 1);
    var stop = new Date(futEnd.getFullYear(), futEnd.getMonth(), 1);
    while (d.getTime() <= stop.getTime()) {
      fetchedMonths.add(monthKey(d.getFullYear(), d.getMonth()));
      d.setMonth(d.getMonth() + 1);
    }

    return Promise.all([
      fetchCalendarRange(iso(pastStart), todayISO),
      fetchCalendarRange(iso(futStart), iso(futEnd)),
    ]);
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
    drawerDate.textContent = MONTHS[d.getMonth()] + ' ' + d.getDate();
    // Past days are intentionally quiet — no day total, no projection. Just
    // notes/items in the list. Per-day math only matters going forward.
    var isPastDay = d.getTime() < today.getTime();

    // Sum scheduled-only items for THIS exact day (used for the projection
    // line below). Income from scheduled adds, scheduled outflows subtract.
    var dayScheduledOut = 0;
    var dayScheduledIn = 0;
    var thisDayKey = iso(d);
    PRECOMMITS.forEach(function (e) {
      if (e.source !== 'scheduled') return;
      if (e.date !== thisDayKey) return;
      if (e.type === 'income') dayScheduledIn  += Number(e.amount) || 0;
      else                     dayScheduledOut += Number(e.amount) || 0;
    });

    // Top line: "running balance: $X" — the day total (renamed from "on this
    // day"). Math becomes intuitive: top minus your scheduled = bottom.
    if (!isPastDay && outflow > 0) {
      drawerTotal.innerHTML = 'running balance: <strong>' + money(outflow) + '</strong>';
    } else {
      drawerTotal.innerHTML = '';
    }

    // Bottom line: "after your plans this day: $Y" — top minus scheduled
    // outflow + scheduled income, computed PER DAY (not across a window).
    // Hidden for past days, free days, and when there's no scheduled txn.
    if (drawerProjected) {
      drawerProjected.innerHTML = '';
      if (!isPastDay && outflow > 0 && (dayScheduledOut > 0 || dayScheduledIn > 0)) {
        var afterPlans = outflow - dayScheduledOut + dayScheduledIn;
        var sign = afterPlans < 0 ? '-' : '';
        var abs  = Math.abs(afterPlans).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        var label = sameYMD(d, today) ? 'after your plans today'
                                      : 'after your plans this day';
        drawerProjected.innerHTML =
          label + ': <strong>' + sign + '$' + abs + '</strong>';
      }
    }
    drawerList.innerHTML = '';
    if (!exps.length) {
      // Free day — render nothing in the list. The date header is enough; an
      // explicit "nothing scheduled" line just adds noise to an already-quiet
      // popover.
    } else {
      exps.forEach(function (e) {
        var item = document.createElement('div');
        item.className = 'drawer-item';
        // Pending: italic on the name via the same class used on cell pills.
        if (e.pending) item.classList.add('pending-tx');

        // Scheduled rows are clickable to open the edit popup. Plaid rows
        // stay non-interactive for this pass — backend doesn't support edit
        // there yet, so no affordance, no click handler.
        var isEditable = e.source === 'scheduled' && e.id != null;
        if (isEditable) {
          item.classList.add('is-scheduled');
          item.setAttribute('role', 'button');
          item.setAttribute('tabindex', '0');
          item.setAttribute('aria-label', 'edit ' + e.name);
        }

        // Left-side stack: name, optional from-card chip, optional note.
        // textContent-safe construction — backend has already cleaned the
        // strings, but keep the XSS-safe path regardless.
        var rowMain = document.createElement('div');
        rowMain.className = 'row-main';

        var nameDiv = document.createElement('div');
        nameDiv.className = 'name';
        nameDiv.textContent = e.name;
        rowMain.appendChild(nameDiv);

        // Card chip: "from <institution> ···<mask>" — shown for Plaid AND
        // scheduled items whenever the backend has a card on the row. Skip
        // entirely if no card is linked (institution + mask both absent).
        if (e.institution || e.mask) {
          var cardDiv = document.createElement('div');
          cardDiv.className = 'from-card';
          var label = 'from ';
          if (e.institution) label += e.institution;
          if (e.mask) label += (e.institution ? ' ' : '') + '···' + e.mask;
          cardDiv.textContent = label;
          rowMain.appendChild(cardDiv);
        }

        // Note: only on scheduled items for this pass. Plaid-item note
        // editing comes in a future task; backend always returns "" for them.
        if (e.note && String(e.note).trim()) {
          var noteDiv = document.createElement('div');
          noteDiv.className = 'note';
          noteDiv.textContent = e.note;
          rowMain.appendChild(noteDiv);
        }

        item.appendChild(rowMain);

        // Trash + pencil glyphs for scheduled rows — fade in on hover/focus
        // via CSS. Built with createElementNS so the SVGs stay inert and
        // CSP-safe (no innerHTML for executable-ish surfaces).
        if (isEditable) {
          // Trash glyph — sits LEFT of the pencil, click triggers inline
          // "delete? yes / cancel" confirm in the row's right-side area.
          var trash = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          trash.setAttribute('class', 'drawer-item__trash');
          trash.setAttribute('viewBox', '0 0 16 16');
          trash.setAttribute('fill', 'none');
          trash.setAttribute('stroke', 'currentColor');
          trash.setAttribute('stroke-width', '1.4');
          trash.setAttribute('stroke-linecap', 'round');
          trash.setAttribute('stroke-linejoin', 'round');
          trash.setAttribute('role', 'button');
          trash.setAttribute('tabindex', '0');
          trash.setAttribute('aria-label', 'delete ' + e.name);
          var trashPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          // simple bin: lid line + body box + 2 inner stripes
          trashPath.setAttribute('d', 'M3 4h10M6 4V2.8h4V4M5 4v9h6V4M7.5 6.5v4M9 6.5v4');
          trash.appendChild(trashPath);
          item.appendChild(trash);

          // Pencil glyph — opens edit popup (existing behavior).
          var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('class', 'drawer-item__edit');
          svg.setAttribute('viewBox', '0 0 16 16');
          svg.setAttribute('fill', 'none');
          svg.setAttribute('stroke', 'currentColor');
          svg.setAttribute('stroke-width', '1.5');
          svg.setAttribute('stroke-linecap', 'round');
          svg.setAttribute('stroke-linejoin', 'round');
          svg.setAttribute('aria-hidden', 'true');
          var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z');
          svg.appendChild(path);
          item.appendChild(svg);
        }

        var amtDiv = document.createElement('div');
        amtDiv.className = 'amt';
        // Income renders with a leading "+" so it visually reads as money in.
        amtDiv.textContent = (e.type === 'income' ? '+$' : '$') + e.amount.toFixed(2);
        item.appendChild(amtDiv);

        // Wire click + keyboard for editable rows. Snapshot the txn so the
        // closure doesn't alias the loop var.
        if (isEditable) {
          var txnSnapshot = e;
          var openEdit = function (ev) {
            ev.stopPropagation();
            // Close the day popover first so the edit popup gets focus cleanly.
            closeDrawer();
            openSchedule(txnSnapshot);
          };
          // Whole-row click → edit, except clicks ON the trash icon get
          // intercepted below (stopPropagation in the trash handler).
          item.addEventListener('click', openEdit);
          item.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              openEdit(ev);
            }
          });

          // Wire the trash icon: click → render an inline confirm in this row.
          // Stop propagation so the row-level edit handler doesn't fire.
          var openConfirm = function (ev) {
            ev.stopPropagation();
            // Hide the existing right-side controls (trash + pencil + amount)
            // and inject an inline "delete this? · yes · cancel" line.
            var existingRight = item.querySelectorAll(
              '.drawer-item__trash, .drawer-item__edit, .amt'
            );
            existingRight.forEach(function (n) { n.style.display = 'none'; });

            // Already a confirm in this row? bail.
            if (item.querySelector('.row-confirm')) return;

            var confirmRow = document.createElement('div');
            confirmRow.className = 'row-confirm';

            var label = document.createElement('span');
            label.className = 'row-confirm__label';
            label.textContent = 'delete this?';
            confirmRow.appendChild(label);

            var yesBtn = document.createElement('button');
            yesBtn.type = 'button';
            yesBtn.className = 'row-confirm__yes';
            yesBtn.textContent = 'yes';
            confirmRow.appendChild(yesBtn);

            var sep = document.createElement('span');
            sep.className = 'row-confirm__sep';
            sep.textContent = '·';
            confirmRow.appendChild(sep);

            var noBtn = document.createElement('button');
            noBtn.type = 'button';
            noBtn.className = 'row-confirm__no';
            noBtn.textContent = 'cancel';
            confirmRow.appendChild(noBtn);

            item.appendChild(confirmRow);

            var restore = function () {
              if (confirmRow.parentNode) confirmRow.parentNode.removeChild(confirmRow);
              existingRight.forEach(function (n) { n.style.display = ''; });
            };

            noBtn.addEventListener('click', function (cev) {
              cev.stopPropagation();
              restore();
            });

            yesBtn.addEventListener('click', function (cev) {
              cev.stopPropagation();
              yesBtn.disabled = true;
              noBtn.disabled = true;
              label.textContent = 'deleting…';
              fetch(API_BASE + '/api/transactions/schedule/' + encodeURIComponent(txnSnapshot.id), {
                method: 'DELETE',
                credentials: 'include'
              }).then(function (res) {
                if (res.status === 401) { location.replace('/'); return; }
                // 404 = already gone server-side (e.g. zombie from a stale
                // localStorage cache). Treat it as success — purge locally so
                // the row stops haunting the UI on every reload.
                if (!res.ok && res.status !== 404) throw new Error('delete failed ' + res.status);
                // Remove from local state so the day popover and grid reflect
                // the change without needing a full month refetch.
                var idx = PRECOMMITS.indexOf(txnSnapshot);
                if (idx >= 0) PRECOMMITS.splice(idx, 1);
                else {
                  // Fallback: filter by id.
                  PRECOMMITS = PRECOMMITS.filter(function (x) {
                    return !(x.source === 'scheduled' && x.id === txnSnapshot.id);
                  });
                }
                // No localStorage write — calendar is fresh on every load.
                // The in-memory PRECOMMITS update above is enough for the
                // current session; next reload pulls fresh from /api/calendar.
                // Pop the row out of the drawer DOM.
                if (item.parentNode) item.parentNode.removeChild(item);
                renderGrid();
              }).catch(function (err) {
                try { console.warn('[home] delete failed:', err); } catch (_) {}
                label.textContent = 'couldn\u2019t delete · cancel';
                yesBtn.style.display = 'none';
                sep.style.display = 'none';
                noBtn.disabled = false;
              });
            });
          };
          trash.addEventListener('click', openConfirm);
          trash.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              openConfirm(ev);
            }
          });
        }

        drawerList.appendChild(item);
      });
    }

    // ── Per-day "+ schedule on this day" footer button ───────────
    // Lets the user create a scheduled transaction directly from the day
    // they're looking at, with the date pre-filled. Sits below the list.
    // Past days still allow scheduling (you may want to log a planned thing
    // retroactively for projection purposes — backend has no date guard).
    var schedHere = document.createElement('button');
    schedHere.type = 'button';
    schedHere.className = 'drawer-schedule-btn';
    var schedHereLabel = sameYMD(d, today) ? '+ schedule today'
                                           : '+ schedule on this day';
    schedHere.textContent = schedHereLabel;
    schedHere.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var dateStr = iso(d);
      // Close the day popover first so the schedule popup gets focus cleanly,
      // then open the schedule form pre-set to this date. openSchedule with
      // no txn = create mode; we override the date input after open.
      closeDrawer();
      openSchedule();
      // Defer so the form has rendered + reset before we override the date.
      setTimeout(function () {
        if (schedDate) schedDate.value = dateStr;
      }, 0);
    });
    drawerList.appendChild(schedHere);

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
    drawer        = document.getElementById('drawer');
    drawerOverlay = document.getElementById('drawer-overlay');
    drawerDate    = document.getElementById('drawer-date');
    drawerTotal   = document.getElementById('drawer-total');
    drawerProjected = document.getElementById('drawer-projected');
    drawerList    = document.getElementById('drawer-list');
    drawerClose   = document.getElementById('drawer-close');

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
      if (e.key === 'Escape') {
        // If the reimbursements panel has an open inline confirm, ESC dismisses
        // just that — the panel itself stays open so the user can keep working.
        if (dismissOpenReimbConfirms()) return;
        closeDrawer();
        closeSchedule();
        closeBalances();
        closeReimbursements();
      }
    });
  }

  // ── Schedule-spend popup + form ──────────────────
  // Cards are fetched once on first open and reused — backend is read-mostly
  // here and the user doesn't add cards mid-session through this UI.
  function fetchCardsOnce() {
    if (cardsCache) return Promise.resolve(cardsCache);
    if (cardsFetchInflight) return cardsFetchInflight;
    cardsFetchInflight = fetch(API_BASE + '/api/cards', {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      if (res.status === 401) return { cards: [] }; // gateAuth handles redirect elsewhere
      if (!res.ok) throw new Error('cards fetch failed ' + res.status);
      return res.json();
    }).then(function (data) {
      cardsCache = (data && Array.isArray(data.cards)) ? data.cards : [];
      cardsFetchInflight = null;
      return cardsCache;
    }).catch(function (err) {
      cardsFetchInflight = null;
      try { console.warn('[home] cards fetch error:', err); } catch (_) {}
      // Don't bake the failure into cache — let the next open retry.
      return [];
    });
    return cardsFetchInflight;
  }

  function populateCardSelect(cards) {
    if (!schedCard) return;
    // Wipe and rebuild, preserving the leading "no card / not linked" option.
    schedCard.innerHTML = '';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'no card / not linked';
    schedCard.appendChild(none);
    (cards || []).forEach(function (c) {
      if (!c || !c.account_id) return;
      var opt = document.createElement('option');
      opt.value = c.account_id;
      var inst = c.institution || 'card';
      var mask = c.mask ? ' ···' + c.mask : '';
      opt.textContent = inst + mask;
      schedCard.appendChild(opt);
    });
  }

  function setSelectedType(type) {
    if (!schedTypeChips) return;
    var chips = schedTypeChips.querySelectorAll('.type-chip');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-type') === type;
      chips[i].classList.toggle('is-active', on);
      chips[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  function getSelectedType() {
    if (!schedTypeChips) return 'planned';
    var active = schedTypeChips.querySelector('.type-chip.is-active');
    return active ? (active.getAttribute('data-type') || 'planned') : 'planned';
  }

  // Reset the schedule form to a clean create-mode state. Called every time
  // the popup opens so a previous edit session never leaks into a fresh open.
  function resetScheduleForm() {
    if (!schedForm) return;
    schedForm.reset();
    if (schedDate) schedDate.value = iso(today); // default to today
    setSelectedType('planned');
    if (schedError) schedError.textContent = '';
    editingTxnId = null;
    if (schedTitle) schedTitle.textContent = 'schedule a spend';
    if (schedSubmit) {
      schedSubmit.disabled = false;
      schedSubmit.textContent = '+ schedule it';
    }
    // Hide delete affordance + reset confirm row to neutral state.
    if (schedFooter) schedFooter.hidden = true;
    if (schedDeleteBtn) schedDeleteBtn.hidden = false;
    if (schedDeleteConfirm) schedDeleteConfirm.hidden = true;
  }

  // Apply a scheduled-transaction object to the form fields. Card population
  // is asynchronous (fetchCardsOnce), so we set the card value after it
  // resolves; everything else is set inline.
  function applyTxnToForm(txn) {
    if (!txn) return;
    if (schedDate)   schedDate.value   = txn.date || '';
    if (schedAmount) schedAmount.value = (txn.amount != null) ? String(txn.amount) : '';
    if (schedName)   schedName.value   = txn.name || '';
    if (schedNote)   schedNote.value   = txn.note || '';
    setSelectedType(txn.type || 'planned');
    // card_account_id is applied inside the cards-fetched .then() below so
    // the option exists in the select before we try to select it.
  }

  // Open the schedule popup. Pass a scheduled-transaction object to enter
  // edit mode (title flips, fields prefill, delete affordance shows, submit
  // text becomes "+ save changes"). Pass nothing for create mode.
  function openSchedule(txn) {
    if (!schedPop || !schedOverlay) return;
    resetScheduleForm();

    var isEdit = !!(txn && txn.id != null);
    if (isEdit) {
      editingTxnId = txn.id;
      if (schedTitle) schedTitle.textContent = 'edit transaction';
      if (schedSubmit) schedSubmit.textContent = '+ save changes';
      if (schedFooter) schedFooter.hidden = false;
      applyTxnToForm(txn);
    }

    // Lazy-load cards on first open; subsequent opens reuse the cache.
    // In edit mode, set the card_account_id once options are populated.
    fetchCardsOnce().then(function (cards) {
      populateCardSelect(cards);
      if (isEdit && schedCard) {
        schedCard.value = txn.card_account_id || '';
      }
    });
    schedPop.classList.add('open');
    schedOverlay.classList.add('open');
    schedPop.setAttribute('aria-hidden', 'false');
    // Focus the first field for keyboard users.
    if (schedDate) {
      try { schedDate.focus({ preventScroll: true }); } catch (_) { schedDate.focus(); }
    }
  }
  function closeSchedule() {
    if (!schedPop || !schedOverlay) return;
    schedPop.classList.remove('open');
    schedOverlay.classList.remove('open');
    schedPop.setAttribute('aria-hidden', 'true');
  }

  // After a successful create / edit / delete, evict the visible month from
  // the fetched-months cache so the calendar refetches and renders cleanly.
  // Also drops the cached entry locally for delete so the row vanishes
  // immediately even if the refetch is in flight.
  function refreshAfterScheduleChange() {
    var key = monthKey(view.getFullYear(), view.getMonth());
    fetchedMonths.delete(key);
    fetchMonthIfNeeded(view.getFullYear(), view.getMonth());
  }

  // Submit handler: validates inline, then POSTs (create mode) or PATCHes
  // (edit mode) to /api/transactions/schedule[/:id]. Closes + refetches the
  // visible month on success, surfaces server errors above the submit button.
  function handleScheduleSubmit(ev) {
    ev.preventDefault();
    if (!schedForm) return;
    if (schedError) schedError.textContent = '';

    var isEdit = editingTxnId != null;
    var dateVal = (schedDate && schedDate.value || '').trim();
    var amountRaw = (schedAmount && schedAmount.value || '').trim();
    var amountNum = parseFloat(amountRaw);
    var nameVal = (schedName && schedName.value || '').trim();
    var typeVal = getSelectedType();
    var cardVal = (schedCard && schedCard.value || '').trim();
    var noteVal = (schedNote && schedNote.value || '').trim();

    if (!dateVal) {
      if (schedError) schedError.textContent = 'pick a date.';
      return;
    }
    if (!amountRaw || isNaN(amountNum) || amountNum <= 0) {
      if (schedError) schedError.textContent = 'enter an amount above zero.';
      return;
    }
    if (!nameVal) {
      if (schedError) schedError.textContent = 'give it a name.';
      return;
    }

    // For PATCH the backend accepts unchanged values, so we send the full
    // editable set rather than diffing — simpler + robust to subtle equality
    // bugs (string vs number id, null vs "" note). Empty string clears.
    var body = {
      date: dateVal,
      amount: Math.round(amountNum * 100) / 100,
      name: nameVal,
      type: typeVal
    };
    if (isEdit) {
      // Always include card + note in edit mode so empty values clear them.
      body.card_account_id = cardVal;
      body.note = noteVal;
    } else {
      if (cardVal) body.card_account_id = cardVal;
      if (noteVal) body.note = noteVal;
    }

    var pendingText = isEdit ? 'saving…' : 'scheduling…';
    var defaultText = isEdit ? '+ save changes' : '+ schedule it';
    if (schedSubmit) {
      schedSubmit.disabled = true;
      schedSubmit.textContent = pendingText;
    }

    var url, method;
    if (isEdit) {
      url = API_BASE + '/api/transactions/schedule/' + encodeURIComponent(editingTxnId);
      method = 'PATCH';
    } else {
      url = API_BASE + '/api/transactions/schedule';
      method = 'POST';
    }

    fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (out) {
      if (!out.ok) {
        var fallback = isEdit ? 'couldn\'t save (' : 'couldn\'t schedule (';
        var msg = (out.data && (out.data.error || out.data.message)) ||
                  (fallback + out.status + ').');
        if (schedError) schedError.textContent = msg;
        if (schedSubmit) {
          schedSubmit.disabled = false;
          schedSubmit.textContent = defaultText;
        }
        return;
      }
      // Success: drop the visible month from the cache so the next render
      // pulls the freshly-saved item. We refetch only the visible month.
      closeSchedule();
      refreshAfterScheduleChange();
    }).catch(function (err) {
      if (schedError) schedError.textContent = 'network error — try again.';
      if (schedSubmit) {
        schedSubmit.disabled = false;
        schedSubmit.textContent = defaultText;
      }
      try { console.warn('[home] schedule submit error:', err); } catch (_) {}
    });
  }

  // Delete-confirm UI: replace the "delete" link with an inline
  // "delete this? · yes · cancel" row. Cancel restores the link, yes fires
  // the DELETE call, refetches, and closes the popup.
  function showDeleteConfirm() {
    if (schedDeleteBtn) schedDeleteBtn.hidden = true;
    if (schedDeleteConfirm) schedDeleteConfirm.hidden = false;
  }
  function hideDeleteConfirm() {
    if (schedDeleteBtn) schedDeleteBtn.hidden = false;
    if (schedDeleteConfirm) schedDeleteConfirm.hidden = true;
  }

  function handleDeleteConfirmed() {
    if (editingTxnId == null) return;
    if (schedError) schedError.textContent = '';
    if (schedDeleteYes) {
      schedDeleteYes.disabled = true;
      schedDeleteYes.textContent = 'deleting…';
    }
    var id = editingTxnId;
    fetch(API_BASE + '/api/transactions/schedule/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (out) {
      // 404 = already gone server-side (zombie from stale cache). Treat as
      // success so the local state purges instead of error-displaying.
      if (!out.ok && out.status !== 404) {
        var msg = (out.data && (out.data.error || out.data.message)) ||
                  ('couldn\'t delete (' + out.status + ').');
        if (schedError) schedError.textContent = msg;
        if (schedDeleteYes) {
          schedDeleteYes.disabled = false;
          schedDeleteYes.textContent = 'yes';
        }
        return;
      }
      // Success (or 404 zombie purge): drop the row locally so it doesn't
      // linger, then refetch the visible month for canonical state.
      PRECOMMITS = PRECOMMITS.filter(function (e) { return e.id !== id; });
      // No localStorage write — fresh on every load.
      // Reset confirm UI before closing so the next open starts in the
      // neutral "delete" link state.
      if (schedDeleteYes) {
        schedDeleteYes.disabled = false;
        schedDeleteYes.textContent = 'yes';
      }
      hideDeleteConfirm();
      closeSchedule();
      refreshAfterScheduleChange();
    }).catch(function (err) {
      if (schedError) schedError.textContent = 'network error — try again.';
      if (schedDeleteYes) {
        schedDeleteYes.disabled = false;
        schedDeleteYes.textContent = 'yes';
      }
      try { console.warn('[home] schedule delete error:', err); } catch (_) {}
    });
  }

  function wireScheduleBtn() {
    schedBtn       = document.getElementById('schedule-btn');
    schedOverlay   = document.getElementById('schedule-overlay');
    schedPop       = document.getElementById('schedule-pop');
    schedClose     = document.getElementById('schedule-close');
    schedTitle     = document.getElementById('schedule-pop-title');
    schedForm      = document.getElementById('schedule-form');
    schedDate      = document.getElementById('sched-date');
    schedAmount    = document.getElementById('sched-amount');
    schedName      = document.getElementById('sched-name');
    schedTypeChips = document.getElementById('sched-type-chips');
    schedCard      = document.getElementById('sched-card');
    schedNote      = document.getElementById('sched-note');
    schedError     = document.getElementById('sched-error');
    schedSubmit    = document.getElementById('sched-submit');
    schedFooter        = document.getElementById('schedule-footer');
    schedDeleteBtn     = document.getElementById('schedule-delete');
    schedDeleteConfirm = document.getElementById('schedule-delete-confirm');
    schedDeleteYes     = document.getElementById('schedule-delete-yes');
    schedDeleteCancel  = document.getElementById('schedule-delete-cancel');

    // Bare chip click opens create mode — wrap so we don't leak the click
    // event into openSchedule's optional-txn parameter.
    if (schedBtn)     schedBtn.addEventListener('click', function () { openSchedule(); });
    if (schedClose)   schedClose.addEventListener('click', closeSchedule);
    if (schedOverlay) schedOverlay.addEventListener('click', closeSchedule);
    if (schedForm)    schedForm.addEventListener('submit', handleScheduleSubmit);
    if (schedDeleteBtn)    schedDeleteBtn.addEventListener('click', showDeleteConfirm);
    if (schedDeleteCancel) schedDeleteCancel.addEventListener('click', hideDeleteConfirm);
    if (schedDeleteYes)    schedDeleteYes.addEventListener('click', handleDeleteConfirmed);
    if (schedTypeChips) {
      schedTypeChips.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest && ev.target.closest('.type-chip');
        if (!btn || !schedTypeChips.contains(btn)) return;
        var type = btn.getAttribute('data-type');
        if (type) setSelectedType(type);
      });
    }
  }

  // ── Balances popup ───────────────────────────────
  // Fetches /api/balances once on first open and caches the result for the
  // page lifetime. Subsequent opens reuse the cache — no refetch on reopen.
  function fetchBalancesOnce() {
    if (balancesCache) return Promise.resolve(balancesCache);
    if (balancesFetchInflight) return balancesFetchInflight;
    balancesFetchInflight = fetch(API_BASE + '/api/balances', {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      if (res.status === 401) return { accounts: [], summary: null }; // gateAuth handles redirect
      if (!res.ok) throw new Error('balances fetch failed ' + res.status);
      return res.json();
    }).then(function (data) {
      balancesCache = {
        accounts: (data && Array.isArray(data.accounts)) ? data.accounts : [],
        summary: (data && data.summary) ? data.summary : null
      };
      // No localStorage write — balances are fresh on every load. The
      // in-memory balancesCache still serves repeat opens within a session.
      balancesFetchInflight = null;
      return balancesCache;
    }).catch(function (err) {
      balancesFetchInflight = null;
      try { console.warn('[home] balances fetch error:', err); } catch (_) {}
      // Don't bake the failure — re-throw so the caller can show an error state
      // and the next open retries cleanly.
      throw err;
    });
    return balancesFetchInflight;
  }

  // Format a server-provided ISO timestamp as a low-key relative phrase like
  // "2 min ago", "an hour ago", or "earlier today". Falls back to the date
  // (e.g. "apr 21") when relative phrasing would be misleading or the input
  // can't be parsed.
  function humanizeAsOf(iso) {
    if (!iso) return '';
    var then = new Date(iso);
    if (isNaN(then.getTime())) return '';
    var now = new Date();
    var diffMs = now - then;
    if (diffMs < 0) diffMs = 0;
    var diffSec = Math.floor(diffMs / 1000);
    var diffMin = Math.floor(diffSec / 60);
    var diffHr  = Math.floor(diffMin / 60);

    if (diffSec < 45) return 'just now';
    if (diffMin < 2)  return 'a min ago';
    if (diffMin < 60) return diffMin + ' min ago';
    if (diffHr  < 2)  return 'an hour ago';
    // Same calendar day, more than ~2 hours back — keep it warm/loose.
    var sameDay = then.getFullYear() === now.getFullYear() &&
                  then.getMonth()    === now.getMonth() &&
                  then.getDate()     === now.getDate();
    if (sameDay) return 'earlier today';
    if (diffHr < 24) return diffHr + ' hr ago';
    var diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return 'yesterday';
    if (diffDay < 7)  return diffDay + ' days ago';
    // Older than a week — fall back to a short month-day stamp in lowercase.
    return MONTHS[then.getMonth()].slice(0, 3) + ' ' + then.getDate();
  }

  // Sage/periwinkle accents are applied via CSS class (.is-credit, .is-depository).
  function balanceRowClass(type) {
    var t = (type || '').toLowerCase();
    if (t === 'credit') return 'is-credit';
    if (t === 'depository') return 'is-depository';
    return ''; // neutral for "other"
  }

  // Pick the visible balance for a row. Credit accounts use balance_current
  // (Plaid: positive number = amount owed). Depository uses available when
  // present, falling back to current. Other types fall back to current.
  function balanceForRow(acct) {
    var t = (acct.account_type || '').toLowerCase();
    if (t === 'depository') {
      if (typeof acct.balance_available === 'number') return acct.balance_available;
      if (typeof acct.balance_current   === 'number') return acct.balance_current;
      return null;
    }
    if (typeof acct.balance_current === 'number') return acct.balance_current;
    if (typeof acct.balance_available === 'number') return acct.balance_available;
    return null;
  }

  function buildBalanceRow(acct) {
    var row = document.createElement('div');
    row.className = 'balance-row ' + balanceRowClass(acct.account_type);

    var label = document.createElement('div');
    label.className = 'balance-row__label';
    var inst = acct.institution || 'account';
    var mask = acct.mask ? ' ···' + acct.mask : '';
    label.textContent = inst + mask;
    row.appendChild(label);

    var amt = document.createElement('div');
    amt.className = 'balance-row__amt';
    var bal = balanceForRow(acct);
    if (bal === null) {
      amt.textContent = '—';
    } else {
      // Plaid convention: positive credit balance = amount owed. The "cards"
      // group heading already conveys "this is what you owe", so strip a
      // leading minus on credit rows to keep the display clean.
      var t = (acct.account_type || '').toLowerCase();
      var n = (t === 'credit') ? Math.abs(bal) : bal;
      amt.textContent = money(n);
    }
    row.appendChild(amt);

    return row;
  }

  function renderBalances(payload) {
    if (!balGroups || !balSummary || !balAsOf) return;
    balGroups.innerHTML = '';
    balAsOf.textContent = '';

    var accounts = (payload && payload.accounts) || [];
    var summary  = (payload && payload.summary)  || null;
    var rbBlock  = document.getElementById('running-balance');
    var rbAmt    = document.getElementById('running-balance-amount');

    // Empty state — surface the brand-voice prompt and skip group/list render.
    if (!accounts.length) {
      if (rbBlock) rbBlock.hidden = true;
      balSummary.classList.add('is-muted-italic');
      balSummary.textContent = 'nothing connected yet — add an account';
      return;
    }
    balSummary.classList.remove('is-muted-italic');

    // ── Running balance ──────────────────────────────
    // The "forever true" amount: depository minus credit-card debt.
    // Uses balanceForRow() so the per-row visible number matches what gets
    // summed into running balance — no balance_current vs balance_available
    // mismatch between the row display and the hero. balanceForRow prefers
    // balance_available for depository (subtracts pending holds, the most
    // honest "available now" figure) and balance_current for credit
    // (Plaid convention: positive = amount owed).
    var depTotal = 0;
    var ccTotal  = 0;
    accounts.forEach(function (a) {
      var t = (a.account_type || '').toLowerCase();
      var b = balanceForRow(a);
      if (b === null || !isFinite(b)) return;
      if (t === 'depository') depTotal += b;
      else if (t === 'credit') ccTotal += b;
    });
    // Subtract every scheduled (planned) outflow + add every scheduled income
    // so the running balance hero reflects "what you'll have left after every
    // plan you've put on the calendar." Planned txns aren't in the bank yet,
    // so they have to be applied here on the frontend — backend balances are
    // only Plaid-derived.
    var schedOut = 0;
    var schedIn = 0;
    PRECOMMITS.forEach(function (e) {
      if (e.source !== 'scheduled') return;
      if (e.type === 'income') schedIn  += Number(e.amount) || 0;
      else                     schedOut += Number(e.amount) || 0;
    });
    var running = depTotal - ccTotal - schedOut + schedIn;
    // Cache for downstream consumers (currently unused after the openDrawer
    // refactor, but kept for future per-day formulas that need the baseline).
    currentRunningBalance = running;
    if (rbBlock && rbAmt) {
      rbBlock.hidden = false;
      // Format with $ + grouping; preserve sign so underwater reads honestly.
      var sign = running < 0 ? '-' : '';
      var abs  = Math.abs(running).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      rbAmt.textContent = sign + '$' + abs;
    }

    // Compose the summary line from totals. Backend computes totals already;
    // this just picks the right phrasing for which side(s) are non-zero.
    var owed = summary && typeof summary.total_owed === 'number' ? summary.total_owed : 0;
    var inn  = summary && typeof summary.total_in   === 'number' ? summary.total_in   : 0;
    var parts = [];
    if (owed > 0) parts.push('you owe ' + money(owed));
    if (inn  > 0) parts.push('you have ' + money(inn));
    balSummary.textContent = parts.length ? parts.join(' · ') : '';

    // Group by type (preserving server's credit-first ordering within group).
    var groups = { credit: [], depository: [], other: [] };
    accounts.forEach(function (a) {
      var t = (a.account_type || '').toLowerCase();
      if (t === 'credit') groups.credit.push(a);
      else if (t === 'depository') groups.depository.push(a);
      else groups.other.push(a);
    });

    var order = [
      { key: 'credit',     heading: 'cards',    listId: 'balances-list-credit' },
      { key: 'depository', heading: 'accounts', listId: 'balances-list-depository' },
      { key: 'other',      heading: 'other',    listId: 'balances-list-other' }
    ];
    order.forEach(function (g) {
      var rows = groups[g.key];
      if (!rows.length) return;
      var section = document.createElement('section');
      section.className = 'balances-group';

      var h = document.createElement('div');
      h.className = 'balances-group__heading';
      h.textContent = g.heading;
      section.appendChild(h);

      var list = document.createElement('div');
      list.className = 'balances-list';
      list.id = g.listId;
      rows.forEach(function (a) { list.appendChild(buildBalanceRow(a)); });
      section.appendChild(list);

      balGroups.appendChild(section);
    });

    var asOfStr = summary && summary.as_of ? humanizeAsOf(summary.as_of) : '';
    if (asOfStr) balAsOf.textContent = 'as of ' + asOfStr;
  }

  function setBalancesStatus(text) {
    if (!balStatus) return;
    balStatus.textContent = text || '';
  }

  function openBalances() {
    if (!balPop || !balOverlay) return;
    balPop.classList.add('open');
    balOverlay.classList.add('open');
    balPop.setAttribute('aria-hidden', 'false');

    if (balancesCache) {
      // Cache hit — just render and show.
      setBalancesStatus('');
      renderBalances(balancesCache);
      return;
    }

    // First open: show loading state, fetch, then render or surface error.
    if (balSummary) {
      balSummary.textContent = '';
      balSummary.classList.remove('is-muted-italic');
    }
    if (balGroups) balGroups.innerHTML = '';
    if (balAsOf)   balAsOf.textContent = '';
    setBalancesStatus('loading…');

    fetchBalancesOnce().then(function (payload) {
      setBalancesStatus('');
      renderBalances(payload);
    }).catch(function () {
      setBalancesStatus('couldn\u2019t load — refresh and try again.');
    });
  }

  function closeBalances() {
    if (!balPop || !balOverlay) return;
    balPop.classList.remove('open');
    balOverlay.classList.remove('open');
    balPop.setAttribute('aria-hidden', 'true');
  }

  function wireBalancesBtn() {
    balBtn      = document.getElementById('balances-btn');
    balOverlay  = document.getElementById('balances-overlay');
    balPop      = document.getElementById('balances-pop');
    balClose    = document.getElementById('balances-close');
    balSummary  = document.getElementById('balances-summary');
    balStatus   = document.getElementById('balances-status');
    balGroups   = document.getElementById('balances-groups');
    balAsOf     = document.getElementById('balances-asof');

    if (balBtn)     balBtn.addEventListener('click', openBalances);
    if (balClose)   balClose.addEventListener('click', closeBalances);
    if (balOverlay) balOverlay.addEventListener('click', closeBalances);
  }

  // ── Reimbursements popup ────────────────────────
  // Simple to-do list backed by /api/reimbursements. Same paper-tint modal
  // pattern as schedule + balances. Cache lifecycle:
  //   • Hydrated from localStorage on boot (SWR) for instant paint on reopen
  //     across page loads.
  //   • Lazily fetched on first open if no cache exists.
  //   • Evicted on every successful POST/PATCH/DELETE so the next read pulls
  //     the canonical server state. We optimistically update the local cache
  //     for status cycle so the row repaints instantly without waiting on the
  //     refetch; rollback on error.
  var REIMB_GROUP_ORDER = [
    { key: 'open',      heading: 'open' },
    { key: 'submitted', heading: 'submitted' },
    { key: 'received',  heading: 'received' }
  ];
  // Cycle map: clicking the right-side text advances to the next status.
  // 'received' is terminal — button is rendered greyed out / non-interactive.
  var REIMB_NEXT_STATUS = {
    open: 'submitted',
    submitted: 'received'
  };
  function reimbCycleLabel(status) {
    if (status === 'open')      return 'submit claim \u2192';
    if (status === 'submitted') return 'got EOB \u2192';
    return 'done';
  }
  // Question copy for the inline confirm when advancing forward. Mirrors the
  // verb in the cycle button so the user knows exactly what "yes" means.
  function reimbAdvanceConfirmLabel(status) {
    if (status === 'open')      return 'submit claim?';
    if (status === 'submitted') return 'mark received?';
    return '';
  }
  // Question copy for the back-arrow undo confirm.
  function reimbBackConfirmLabel(status) {
    if (status === 'submitted') return 'back to open?';
    if (status === 'received')  return 'back to submitted?';
    return '';
  }
  // Previous-status map for the back-arrow. open has no predecessor.
  var REIMB_PREV_STATUS = {
    submitted: 'open',
    received:  'submitted'
  };

  function persistReimbursementsCache() {
    if (Array.isArray(reimbursementsCache)) {
      cacheWrite('reimbursements', reimbursementsCache);
    }
  }

  function fetchReimbursementsOnce() {
    if (Array.isArray(reimbursementsCache) && reimbursementsCache.length >= 0 && reimbursementsCache._fresh) {
      // _fresh marker indicates this cache was loaded from the live API in
      // this page session. Hydrated-from-localStorage caches lack the marker
      // so we still fall through to the network on first open.
      return Promise.resolve(reimbursementsCache);
    }
    if (reimbursementsFetchInflight) return reimbursementsFetchInflight;
    reimbursementsFetchInflight = fetch(API_BASE + '/api/reimbursements', {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      if (res.status === 401) return { items: [] }; // gateAuth handles redirect
      if (!res.ok) throw new Error('reimbursements fetch failed ' + res.status);
      return res.json();
    }).then(function (data) {
      var items = (data && Array.isArray(data.items)) ? data.items : [];
      reimbursementsCache = items;
      // Mark this cache as backend-fresh so subsequent opens reuse without
      // refetching. Eviction (cache = null) clears this implicitly.
      try { Object.defineProperty(reimbursementsCache, '_fresh', { value: true, enumerable: false, configurable: true }); }
      catch (_) { reimbursementsCache._fresh = true; }
      persistReimbursementsCache();
      reimbursementsFetchInflight = null;
      return reimbursementsCache;
    }).catch(function (err) {
      reimbursementsFetchInflight = null;
      try { console.warn('[home] reimbursements fetch error:', err); } catch (_) {}
      throw err;
    });
    return reimbursementsFetchInflight;
  }

  function setReimbStatus(text) {
    if (reimbStatus) reimbStatus.textContent = text || '';
  }
  function setReimbError(text) {
    if (reimbError) reimbError.textContent = text || '';
  }

  // Group items by status, preserving server's intra-group ordering
  // (open → submitted → received, then by recency within each).
  function groupReimbursements(items) {
    var groups = { open: [], submitted: [], received: [] };
    (items || []).forEach(function (it) {
      var s = (it && it.status) || 'open';
      if (groups[s]) groups[s].push(it);
      else groups.open.push(it);
    });
    return groups;
  }

  function renderReimbursements() {
    if (!reimbGroups) return;
    reimbGroups.innerHTML = '';
    var items = Array.isArray(reimbursementsCache) ? reimbursementsCache : [];

    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'reimb-empty';
      empty.textContent = 'no reimbursements yet \u2014 add one above.';
      reimbGroups.appendChild(empty);
      return;
    }

    var groups = groupReimbursements(items);
    REIMB_GROUP_ORDER.forEach(function (g) {
      var rows = groups[g.key];
      if (!rows.length) return;
      var section = document.createElement('section');
      section.className = 'reimb-group';

      var h = document.createElement('div');
      h.className = 'reimb-group__heading';
      h.textContent = g.heading;
      section.appendChild(h);

      var list = document.createElement('div');
      list.className = 'reimb-list';
      list.id = 'reimb-list-' + g.key;
      rows.forEach(function (item) { list.appendChild(buildReimbItem(item)); });
      section.appendChild(list);

      reimbGroups.appendChild(section);
    });
  }

  // Build an inline "label · yes · cancel" confirm row, mirroring the
  // day-popover .row-confirm pattern. Returns { node, label, yes, no, sep2 }
  // so callers can flip into a "loading…" or "couldn't… · cancel" state.
  function buildReimbConfirmRow(labelText) {
    var confirmRow = document.createElement('div');
    confirmRow.className = 'reimb-item__confirm';

    var label = document.createElement('span');
    label.className = 'reimb-item__confirm-label';
    label.textContent = labelText;
    confirmRow.appendChild(label);

    var sep1 = document.createElement('span');
    sep1.className = 'reimb-item__confirm-sep';
    sep1.textContent = '\u00b7';
    confirmRow.appendChild(sep1);

    var yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'reimb-item__confirm-yes';
    yesBtn.textContent = 'yes';
    confirmRow.appendChild(yesBtn);

    var sep2 = document.createElement('span');
    sep2.className = 'reimb-item__confirm-sep';
    sep2.textContent = '\u00b7';
    confirmRow.appendChild(sep2);

    var noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'reimb-item__confirm-no';
    noBtn.textContent = 'cancel';
    confirmRow.appendChild(noBtn);

    return { node: confirmRow, label: label, yes: yesBtn, no: noBtn, sep2: sep2 };
  }

  function buildReimbItem(item) {
    var row = document.createElement('div');
    row.className = 'reimb-item';
    row.setAttribute('data-id', String(item.id));
    row.setAttribute('data-status', item.status || 'open');

    var desc = document.createElement('div');
    desc.className = 'reimb-item__desc';
    desc.textContent = item.description || '';
    row.appendChild(desc);

    // Trash glyph — leftmost on hover, same SVG pattern as the day popover.
    var trash = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    trash.setAttribute('class', 'reimb-item__trash');
    trash.setAttribute('viewBox', '0 0 16 16');
    trash.setAttribute('fill', 'none');
    trash.setAttribute('stroke', 'currentColor');
    trash.setAttribute('stroke-width', '1.4');
    trash.setAttribute('stroke-linecap', 'round');
    trash.setAttribute('stroke-linejoin', 'round');
    trash.setAttribute('role', 'button');
    trash.setAttribute('tabindex', '0');
    trash.setAttribute('aria-label', 'delete ' + (item.description || 'reimbursement'));
    var trashPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    trashPath.setAttribute('d', 'M3 4h10M6 4V2.8h4V4M5 4v9h6V4M7.5 6.5v4M9 6.5v4');
    trash.appendChild(trashPath);
    row.appendChild(trash);

    var status = item.status || 'open';

    // Back-arrow button — only on rows that have already advanced. Sits LEFT
    // of the cycle button, fades in on hover/focus-within (same pattern as
    // the trash glyph) so it stays out of the way at rest.
    var back = null;
    if (status === 'submitted' || status === 'received') {
      back = document.createElement('button');
      back.type = 'button';
      back.className = 'reimb-back';
      back.textContent = '\u21a9'; // ↩
      back.setAttribute(
        'aria-label',
        status === 'submitted' ? 'move back to open' : 'move back to submitted'
      );
      row.appendChild(back);
    }

    var cycle = document.createElement('button');
    cycle.type = 'button';
    cycle.className = 'reimb-cycle';
    cycle.textContent = reimbCycleLabel(status);
    if (status === 'received') {
      cycle.classList.add('is-done');
      cycle.disabled = true;
      cycle.setAttribute('aria-disabled', 'true');
    }
    row.appendChild(cycle);

    // Show the inline confirm row in place of the right-side controls. The
    // controls (trash, back, cycle) are hidden and restored by `restore()`.
    // `kind` is one of 'delete' | 'advance' | 'back' so we can wire the
    // correct yes-handler. Returns nothing — callers don't need the node.
    var openInlineConfirm = function (kind) {
      // Bail if a confirm is already open in this row.
      if (row.querySelector('.reimb-item__confirm')) return;

      var labelText;
      if (kind === 'delete')       labelText = 'delete?';
      else if (kind === 'advance') labelText = reimbAdvanceConfirmLabel(item.status || 'open');
      else if (kind === 'back')    labelText = reimbBackConfirmLabel(item.status || 'open');
      if (!labelText) return;

      // Hide existing right-side controls.
      trash.style.display = 'none';
      if (back) back.style.display = 'none';
      cycle.style.display = 'none';

      var c = buildReimbConfirmRow(labelText);
      row.appendChild(c.node);

      var restore = function () {
        if (c.node.parentNode) c.node.parentNode.removeChild(c.node);
        trash.style.display = '';
        if (back) back.style.display = '';
        cycle.style.display = '';
      };

      // Track this confirm row so a panel-level ESC can dismiss it.
      c.node._reimbCancel = restore;

      // Move focus to "yes" so Enter confirms and Tab/Shift-Tab moves to
      // cancel. ESC is handled at the panel level.
      try { c.yes.focus({ preventScroll: true }); } catch (_) { c.yes.focus(); }

      c.no.addEventListener('click', function (cev) {
        cev.stopPropagation();
        restore();
      });

      c.yes.addEventListener('click', function (cev) {
        cev.stopPropagation();
        c.yes.disabled = true;
        c.no.disabled = true;
        if (kind === 'delete') {
          c.label.textContent = 'deleting\u2026';
          deleteReimbursement(item).catch(function () {
            c.label.textContent = 'couldn\u2019t delete \u00b7 cancel';
            c.yes.style.display = 'none';
            c.sep2.style.display = 'none';
            c.no.disabled = false;
          });
          return;
        }
        // Forward + back share the same code path — both PATCH the row to a
        // target status, optimistically update the cache, and re-render.
        // changeStatus rolls back on failure and surfaces the error in the
        // panel-level error slot, so we just let the row re-render naturally.
        var target;
        if (kind === 'advance') target = REIMB_NEXT_STATUS[item.status || 'open'];
        else                    target = REIMB_PREV_STATUS[item.status || 'open'];
        if (!target) { restore(); return; }
        changeStatus(item, target);
        // changeStatus calls renderReimbursements() synchronously, which
        // rebuilds this row from scratch — restore() is unnecessary.
      });
    };

    // Cycle (forward) — only wire when there's a next status. Native
    // <button> clicks fire on Enter/Space already, so we don't need an
    // extra keydown handler here (unlike the SVG trash, which is not a
    // button element).
    if (status !== 'received') {
      cycle.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openInlineConfirm('advance');
      });
    }

    // Back-arrow — wire only when present (submitted + received rows).
    // Same story: native <button> handles keyboard activation natively.
    if (back) {
      back.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openInlineConfirm('back');
      });
    }

    // Trash → delete confirm. (keyboard already supported via tabindex on the
    // SVG; Enter/Space mirrors the day-popover pattern.)
    var openDeleteConfirm = function (ev) {
      ev.stopPropagation();
      openInlineConfirm('delete');
    };
    trash.addEventListener('click', openDeleteConfirm);
    trash.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openDeleteConfirm(ev);
      }
    });

    return row;
  }

  // Dismiss any open inline-confirm rows in the reimbursements panel. Wired
  // to the global ESC handler so the user can always back out of a confirm
  // without committing. Returns true if at least one confirm was dismissed.
  function dismissOpenReimbConfirms() {
    if (!reimbGroups) return false;
    var confirms = reimbGroups.querySelectorAll('.reimb-item__confirm');
    if (!confirms.length) return false;
    Array.prototype.forEach.call(confirms, function (n) {
      if (typeof n._reimbCancel === 'function') n._reimbCancel();
    });
    return true;
  }

  // POST a new reimbursement. Validates, then optimistically appends on
  // success and refetches to get the canonical sort + ids.
  function addReimbursement(description) {
    var d = (description || '').trim();
    setReimbError('');
    if (!d) {
      setReimbError('add a description.');
      return Promise.resolve(null);
    }
    if (d.length > 120) {
      setReimbError('description is too long (max 120).');
      return Promise.resolve(null);
    }
    if (reimbAddBtn) reimbAddBtn.disabled = true;
    return fetch(API_BASE + '/api/reimbursements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ description: d })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (out) {
      if (!out.ok || !out.data || !out.data.item) {
        var msg = (out.data && (out.data.error || out.data.message)) ||
                  ('couldn\u2019t add (' + out.status + ').');
        setReimbError(msg);
        if (reimbAddBtn) reimbAddBtn.disabled = false;
        return null;
      }
      // Prepend the new item locally so the panel updates immediately. The
      // backend's canonical sort puts open items first and most-recent on top
      // within a group, which matches a prepend for the open bucket.
      var newItem = out.data.item;
      reimbursementsCache = [newItem].concat(
        Array.isArray(reimbursementsCache) ? reimbursementsCache : []
      );
      try { Object.defineProperty(reimbursementsCache, '_fresh', { value: true, enumerable: false, configurable: true }); }
      catch (_) { reimbursementsCache._fresh = true; }
      persistReimbursementsCache();
      if (reimbAddInput) reimbAddInput.value = '';
      if (reimbAddBtn) reimbAddBtn.disabled = false;
      renderReimbursements();
      return newItem;
    }).catch(function (err) {
      setReimbError('network error \u2014 try again.');
      if (reimbAddBtn) reimbAddBtn.disabled = false;
      try { console.warn('[home] reimbursement add error:', err); } catch (_) {}
      return null;
    });
  }

  // PATCH an item to a target status (forward via the cycle button or
  // backward via the ↩ undo button). Optimistically updates the cache + UI,
  // rolls back if the server says no. The PATCH endpoint accepts movement in
  // any direction (open ↔ submitted ↔ received) so the same code path works
  // for both advance and back.
  function changeStatus(item, next) {
    if (!item || !item.id) return;
    var current = item.status || 'open';
    if (!next || next === current) return;
    setReimbError('');
    var prevStatus = current;
    item.status = next;
    persistReimbursementsCache();
    renderReimbursements();

    fetch(API_BASE + '/api/reimbursements/' + encodeURIComponent(item.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ status: next })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (out) {
      if (!out.ok) {
        // Rollback the optimistic update.
        item.status = prevStatus;
        persistReimbursementsCache();
        renderReimbursements();
        var msg = (out.data && (out.data.error || out.data.message)) ||
                  ('couldn\u2019t update (' + out.status + ').');
        setReimbError(msg);
        return;
      }
      // Server may return a fuller item (e.g. updated_at) — overlay onto local.
      if (out.data && out.data.item) {
        Object.assign(item, out.data.item);
        persistReimbursementsCache();
        renderReimbursements();
      }
    }).catch(function (err) {
      item.status = prevStatus;
      persistReimbursementsCache();
      renderReimbursements();
      setReimbError('network error \u2014 try again.');
      try { console.warn('[home] reimbursement patch error:', err); } catch (_) {}
    });
  }

  // DELETE an item. Returns a promise so the inline confirm row can flip into
  // an error state if the call fails.
  function deleteReimbursement(item) {
    if (!item || !item.id) return Promise.resolve(false);
    setReimbError('');
    return fetch(API_BASE + '/api/reimbursements/' + encodeURIComponent(item.id), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (out) {
      if (!out.ok) {
        var msg = (out.data && (out.data.error || out.data.message)) ||
                  ('couldn\u2019t delete (' + out.status + ').');
        setReimbError(msg);
        throw new Error(msg);
      }
      // Drop the row from the cache + re-render.
      reimbursementsCache = (reimbursementsCache || []).filter(function (x) {
        return x.id !== item.id;
      });
      try { Object.defineProperty(reimbursementsCache, '_fresh', { value: true, enumerable: false, configurable: true }); }
      catch (_) { reimbursementsCache._fresh = true; }
      persistReimbursementsCache();
      renderReimbursements();
      return true;
    }).catch(function (err) {
      // Already-rendered network error message stays in place; just re-throw
      // so the inline confirm UI can flip into "couldn't delete" state.
      if (err && err.message && reimbError && !reimbError.textContent) {
        setReimbError('network error \u2014 try again.');
      }
      try { console.warn('[home] reimbursement delete error:', err); } catch (_) {}
      throw err;
    });
  }

  function openReimbursements() {
    if (!reimbPop || !reimbOverlay) return;
    reimbPop.classList.add('open');
    reimbOverlay.classList.add('open');
    reimbPop.setAttribute('aria-hidden', 'false');
    setReimbError('');

    // Always render whatever's currently in cache (could be stale from
    // localStorage, could be null) before any network call so the panel
    // paints instantly with last-known data.
    if (Array.isArray(reimbursementsCache)) {
      setReimbStatus('');
      renderReimbursements();
    }

    // Skip refetch when we already have a backend-fresh cache from this
    // session. Otherwise hit the network and overwrite.
    if (Array.isArray(reimbursementsCache) && reimbursementsCache._fresh) {
      // Focus the input so users can start typing immediately.
      if (reimbAddInput) {
        try { reimbAddInput.focus({ preventScroll: true }); } catch (_) { reimbAddInput.focus(); }
      }
      return;
    }
    // Render a loading line if the cache is empty so the panel isn't blank.
    if (!Array.isArray(reimbursementsCache)) setReimbStatus('loading\u2026');

    fetchReimbursementsOnce().then(function () {
      setReimbStatus('');
      renderReimbursements();
    }).catch(function () {
      setReimbStatus('couldn\u2019t load \u2014 refresh and try again.');
    });

    if (reimbAddInput) {
      try { reimbAddInput.focus({ preventScroll: true }); } catch (_) { reimbAddInput.focus(); }
    }
  }

  function closeReimbursements() {
    if (!reimbPop || !reimbOverlay) return;
    reimbPop.classList.remove('open');
    reimbOverlay.classList.remove('open');
    reimbPop.setAttribute('aria-hidden', 'true');
  }

  function wireReimbursementsBtn() {
    reimbBtn       = document.getElementById('reimbursements-btn');
    reimbOverlay   = document.getElementById('reimbursements-overlay');
    reimbPop       = document.getElementById('reimbursements-pop');
    reimbClose     = document.getElementById('reimbursements-close');
    reimbAddForm   = document.getElementById('reimb-add-form');
    reimbAddInput  = document.getElementById('reimb-add-input');
    reimbAddBtn    = document.getElementById('reimb-add-btn');
    reimbError     = document.getElementById('reimb-error');
    reimbStatus    = document.getElementById('reimb-status');
    reimbGroups    = document.getElementById('reimb-groups');

    if (reimbBtn)     reimbBtn.addEventListener('click', openReimbursements);
    if (reimbClose)   reimbClose.addEventListener('click', closeReimbursements);
    if (reimbOverlay) reimbOverlay.addEventListener('click', closeReimbursements);
    if (reimbAddForm) {
      reimbAddForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        addReimbursement(reimbAddInput && reimbAddInput.value);
      });
    }
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
    pageLoader = document.getElementById('page-loader');
    wireSignout();
    wireCalendar();
    wireAddAccountBtn();
    wireScheduleBtn();
    wireBalancesBtn();
    wireReimbursementsBtn();
    // Reimbursements is still SWR — hydrate its in-memory cache from
    // localStorage so the panel paints instantly when opened. Calendar +
    // balances are NOT hydrated; they wait for the live fetches below.
    hydrateFromCache();
    // Render an empty grid up front so the layout is stable while the
    // /api/calendar fetch runs. The page-loader bar communicates the wait.
    renderGrid();
    // Gate the page on /api/me. If the user isn't signed in we'll have
    // already redirected to "/" — the empty calendar visible during boot is
    // acceptable. The page-loader bar shows progress for all three boot
    // fetches; settle() ensures error paths don't leave the bar stuck.
    startLoading();
    settle(gateAuth().then(function () {
      // Fetch the calendar window first — its handler triggers a debounced
      // Plaid sync server-side that may update account balances. Once that
      // promise resolves the sync has either completed or hit its 8s timeout,
      // and the cache-evict in fetchCalendarRange() ensures the balances
      // prefetch below sees fresh data instead of a pre-sync snapshot.
      startLoading();
      var calendarP = fetchInitialWindow();
      settle(calendarP, endLoading);
      return calendarP.then(function () {
        if (typeof fetchBalancesOnce === 'function') {
          startLoading();
          var balancesP = fetchBalancesOnce().then(function (payload) {
            if (payload) renderBalances(payload);
          }).catch(function () { /* silent — projection just stays hidden */ });
          settle(balancesP, endLoading);
        }
      });
    }).catch(function () {
      // Network hiccup or 5xx — leave the page visible; user can retry by
      // reloading. We deliberately don't hard-redirect so a transient error
      // doesn't kick a signed-in user out.
    }), endLoading);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
