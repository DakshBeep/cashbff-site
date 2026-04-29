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
  // To-do popup (localStorage-backed mockup; no backend yet).
  var todoBtn, todoBtnCount, todoOverlay, todoPop, todoClose,
      todoAddForm, todoAddInput, todoAddBtn, todoError, todoList;
  // Recurring popup — backed by /api/recurring/{suggestions,streams}.
  // Cache shape:
  //   recurringSuggestionsCache: array of {merchant, display_name, amount,
  //                                        next_due_date, cadence_days,
  //                                        last_charge_date, suggested_at}
  //   recurringStreamsCache:    array of suggestion + {confirmed_at,
  //                                                    linked_scheduled_txn_id}
  // Both are SWR (hydrated from localStorage on boot, refetched on first
  // open + every successful mutation).
  var recurringBtn, recurringBtnCount, recurringOverlay, recurringPop,
      recurringClose, recurringStatus,
      recurringSuggestionsList, recurringSuggestionsCount,
      recurringStreamsList, recurringStreamsCount,
      recurringAddBtn;
  var recurringSuggestionsCache = null;
  var recurringSuggestionsFetchInflight = null;
  var recurringStreamsCache = null;
  var recurringStreamsFetchInflight = null;
  // Phase 8C: explicit fetch-state flags so the panel can distinguish
  // "loading" (paint skeleton) from "loaded-empty" (paint empty-state copy)
  // from "loaded-with-items" (paint cards). Without this the panel briefly
  // showed "nothing tracked yet" while the GET was still in flight, which
  // was triggering users to mass-refresh thinking the data was lost.
  var recurringSuggestionsLoaded = false;
  var recurringStreamsLoaded = false;
  // Recurring add modal (Phase 8C: manual entry for streams the bridge
  // didn't catch).
  var recurringAddOverlay, recurringAddPop, recurringAddClose,
      recurringAddForm, recurringAddName, recurringAddAmount,
      recurringAddDate, recurringAddEnd, recurringAddFreqChips,
      recurringAddError, recurringAddSubmit;
  // Recurring edit modal (Phase 8C: dedicated stream editor with frequency
  // + end_date support, replaces the old "open schedule popover from row").
  var recurringEditOverlay, recurringEditPop, recurringEditClose,
      recurringEditForm, recurringEditName, recurringEditAmount,
      recurringEditDate, recurringEditEnd, recurringEditFreqChips,
      recurringEditError, recurringEditSubmit,
      recurringEditDelete, recurringEditDeleteConfirm,
      recurringEditDeleteYes, recurringEditDeleteCancel;
  var recurringEditCurrent = null; // the stream currently being edited
  // Phase 8.5B: rollover modal removed entirely. Streams now auto-project
  // forward until the user sets an end_date on the stream itself; there's no
  // longer a per-charge "did this fire?" prompt. The backend's
  // /api/recurring/rollover-prompts endpoint still exists but is contracted
  // to return {items: []}. Markup, CSS, and wiring are all gone — searching
  // for "rollover" in this file should yield nothing.
  // Wallet popup — linked Plaid accounts (read-only) + manually-tracked cards.
  // Backed by /api/wallet for read, /api/tracked-accounts (POST/DELETE) for
  // mutations on the user-added cards.
  var walletBtn, walletOverlay, walletPop, walletClose,
      walletRunning, walletStatus,
      walletLinkedGroup, walletLinkedList,
      walletTrackedGroup, walletTrackedList,
      walletAddForm, walletAddName, walletAddBalance, walletAddCurrency,
      walletAddDate, walletAddKindChips, walletAddSubmit, walletAddError;
  // Snapshot popup — copy-pasteable Markdown brief of the user's data.
  // Backed by /api/snapshot. The textarea is filled on every open from
  // a fresh GET — we don't cache because the snapshot is point-in-time
  // (balances + transactions) and a stale paste would mislead the LLM.
  var snapshotBtn, snapshotOverlay, snapshotPop, snapshotClose,
      snapshotTextarea, snapshotCopy, snapshotStatus;
  var snapshotCopiedTimer = null;
  // To-do items live in localStorage under cbff_v1_todos via the existing
  // cacheRead/cacheWrite helpers. Shape: [{ id, text, done, created_at }].
  // null on boot until ensureTodosLoaded() seeds from cache + adds the example.
  var todosCache = null;

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

  // Wallet payload: { plaid_accounts, tracked_accounts, summary }. Lazily
  // fetched on first wallet-panel open AND prefetched in boot() so the
  // running-balance hero in the balances panel can include tracked-card totals.
  // Evicted on every successful tracked-account mutation. SWR: hydrated from
  // localStorage on boot for instant paint when the panel opens.
  var walletCache = null;
  var walletFetchInflight = null;
  // Selected kind for the add-tracked-card form. Defaults to 'credit' since
  // tracked cards are most often credit cards (debt the user wants visible
  // alongside Plaid checking balances). Flipped by the .type-chip[data-kind]
  // cluster click handler.
  var walletAddKind = 'credit';

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

  // Format a signed dollar amount as "$1,234.56" or "-$1,234.56".
  function formatSignedMoney(n) {
    var sign = n < 0 ? '-' : '';
    var abs  = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + '$' + abs;
  }

  // Today's actual cash position — what the user has RIGHT NOW, before any
  // future plans are layered in. Pulled from /api/wallet's
  // running_balance_usd (depository − cc_owed + tracked) when available;
  // falls back to a frontend recomputation from balancesCache (depository −
  // credit, ignoring tracked accounts). Returns null if neither source is
  // ready, so callers can hide the running-balance line instead of showing
  // a misleading $0.
  function computeTodayBaseBalance() {
    var summary = walletCache && walletCache.summary;
    if (summary && typeof summary.running_balance_usd === 'number') {
      return summary.running_balance_usd;
    }
    if (balancesCache && Array.isArray(balancesCache.accounts)) {
      var depTotal = 0;
      var ccTotal  = 0;
      balancesCache.accounts.forEach(function (a) {
        var t = (a.account_type || '').toLowerCase();
        var b = balanceForRow(a);
        if (b === null || !isFinite(b)) return;
        if (t === 'depository') depTotal += b;
        else if (t === 'credit') ccTotal += b;
      });
      return depTotal - ccTotal;
    }
    return null;
  }

  // Project the running cash balance to the START of day `d` — i.e. today's
  // base balance plus the net of every scheduled item dated AFTER today and
  // STRICTLY BEFORE `d`. The clicked day's own scheduled txns are NOT
  // included here; they're shown separately in the "after your plans this
  // day" line so the user can see the before/after.
  //
  // Returns { hasBase: boolean, runningBalance: number }. hasBase=false
  // when neither /api/wallet nor /api/balances has resolved yet — caller
  // hides the running-balance line.
  function computeDayProjection(d) {
    var base = computeTodayBaseBalance();
    if (base === null) return { hasBase: false, runningBalance: 0 };

    var dKey = iso(d);
    var todayKey = iso(today);
    var net = 0;
    PRECOMMITS.forEach(function (e) {
      if (!e || e.source !== 'scheduled') return;
      // Phase 10B: acknowledged ("✓ already paid") rows do NOT contribute to
      // FUTURE running-balance projection. The user has flagged them as paid
      // already — the actual charge appears in raw_transactions and reduces
      // the balance there, so projecting a phantom future debit too would
      // double-count.
      if (e.acknowledged) return;
      // Strictly between today (exclusive) and d (exclusive). We exclude
      // today because today's actual balance already reflects whatever has
      // settled today; the "running balance up to day d" is the position
      // you'd be in walking forward day-by-day from today, applying every
      // scheduled item along the way until you arrive at the start of d.
      if (e.date <= todayKey) return;
      if (e.date >= dKey) return;
      var amt = Number(e.amount) || 0;
      if (e.type === 'income') net += amt;
      else                     net -= amt;
    });
    return { hasBase: true, runningBalance: base + net };
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
    // To-dos are mockup-only — same cache helper, no backend hydration.
    var cachedTodos = cacheRead('todos');
    if (Array.isArray(cachedTodos)) {
      todosCache = cachedTodos;
    }
    // Wallet is SWR — last-known payload paints the panel instantly on reopen.
    // The boot prefetch refreshes this with canonical server state so the
    // running-balance hero in balances reflects fresh tracked totals.
    var cachedWallet = cacheRead('wallet');
    if (cachedWallet && typeof cachedWallet === 'object') {
      walletCache = cachedWallet;
    }
    // Recurring suggestions + streams — SWR. Last-known list paints the panel
    // instantly on first open; the live GET refreshes both panels.
    // Phase 8C: a cached array satisfies the "loaded" flag so the user
    // doesn't see a skeleton flash on top of data that's already on disk.
    var cachedRecurringSuggestions = cacheRead('recurring_suggestions');
    if (Array.isArray(cachedRecurringSuggestions)) {
      recurringSuggestionsCache = cachedRecurringSuggestions;
      recurringSuggestionsLoaded = true;
    }
    var cachedRecurringStreams = cacheRead('recurring_streams');
    if (Array.isArray(cachedRecurringStreams)) {
      recurringStreamsCache = cachedRecurringStreams;
      recurringStreamsLoaded = true;
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

  // Derive a monthKey ("YYYY-MM") from an ISO date string ("YYYY-MM-DD").
  // Returns null on missing/malformed input. Used by mutation paths to
  // invalidate the fetchedMonths cache for months other than the visible one
  // (e.g. confirming a stream whose next_due_date is in a different month).
  function monthKeyFromIso(isoDate) {
    if (!isoDate || typeof isoDate !== 'string') return null;
    var parts = isoDate.slice(0, 10).split('-');
    if (parts.length !== 3) return null;
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return null;
    return monthKey(y, m - 1);
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
        // Phase 10B: acknowledged rows still render in the cell so the
        // visual reminder survives, but they get the greyed-out styling.
        if (e.acknowledged) p.classList.add('is-acknowledged');
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
    // Phase 10B: skip acknowledged rows — they're "already paid" so the
    // real charge will show up in raw_transactions; counting them again
    // here would double-debit the "after your plans" line.
    var dayScheduledOut = 0;
    var dayScheduledIn = 0;
    var thisDayKey = iso(d);
    PRECOMMITS.forEach(function (e) {
      if (e.source !== 'scheduled') return;
      if (e.acknowledged) return;
      if (e.date !== thisDayKey) return;
      if (e.type === 'income') dayScheduledIn  += Number(e.amount) || 0;
      else                     dayScheduledOut += Number(e.amount) || 0;
    });

    // Bug 1 fix: "running balance" is the carry-forward cash position
    // projected to the start of the clicked day — i.e. today's actual
    // balance MINUS scheduled outflows for every day BETWEEN today and
    // d (exclusive of d itself, since d's plans are folded into the
    // "after your plans" line). Previously this line showed only the
    // day's own outflow, which made a $25 plan on a day where the user
    // had $1000+ cash render as "running balance: $25.00" — confusing
    // and just wrong.
    var dayProjection = computeDayProjection(d);
    if (!isPastDay && dayProjection.hasBase) {
      drawerTotal.innerHTML = 'running balance: <strong>' +
        formatSignedMoney(dayProjection.runningBalance) + '</strong>';
    } else {
      drawerTotal.innerHTML = '';
    }

    // Bottom line: "after your plans this day: $Y" — running balance
    // MINUS today's scheduled outflow + today's scheduled income.
    // Hidden for past days, when we don't have a balance baseline, and
    // when this day has no scheduled activity to project through.
    if (drawerProjected) {
      drawerProjected.innerHTML = '';
      if (!isPastDay && dayProjection.hasBase &&
          (dayScheduledOut > 0 || dayScheduledIn > 0)) {
        var afterPlans = dayProjection.runningBalance - dayScheduledOut + dayScheduledIn;
        var label = sameYMD(d, today) ? 'after your plans today'
                                      : 'after your plans this day';
        drawerProjected.innerHTML =
          label + ': <strong>' + formatSignedMoney(afterPlans) + '</strong>';
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
        // Phase 10B: acknowledged ("✓ already paid") rows render greyed-out
        // with line-through + a "✓ paid" badge so the user keeps the visual
        // reminder without it counting against the projected balance.
        if (e.acknowledged) item.classList.add('is-acknowledged');

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
        // Phase 10B: append a tiny "✓ paid" badge after the name when the
        // row has been acknowledged. CSS gives it cash-green color + small
        // pill chrome.
        if (e.acknowledged) {
          var badge = document.createElement('span');
          badge.className = 'ack-badge';
          badge.textContent = '✓ paid';
          nameDiv.appendChild(document.createTextNode(' '));
          nameDiv.appendChild(badge);
        }
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
        // Stream-projected rows have an internal `recurring-projection:<merchant>` tag
        // that's for backend bookkeeping — never expose it to the user.
        if (e.note && String(e.note).trim() && !String(e.note).startsWith('recurring-projection:')) {
          var noteDiv = document.createElement('div');
          noteDiv.className = 'note';
          noteDiv.textContent = e.note;
          rowMain.appendChild(noteDiv);
        }

        item.appendChild(rowMain);

        // Trash + pencil glyphs for scheduled rows — fade in on hover/focus
        // via CSS. Built with createElementNS so the SVGs stay inert and
        // CSP-safe (no innerHTML for executable-ish surfaces).
        //
        // Phase 10B TODO: clicking trash on an already-acknowledged row
        // currently triggers the same 409 STREAM_LINKED 2-button surface as
        // an active stream-linked row (since acknowledged rows are also
        // stream-linked). v1 keeps this behavior — the user can re-tap
        // "✓ I already paid this" (idempotent: backend returns 404 since
        // acknowledged_at IS NOT NULL) or "stop tracking this stream". A
        // future task could add an "un-acknowledge" affordance, but for
        // now the duplicate-acknowledge no-op is acceptable.
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
                if (res.status === 401) { location.replace('/'); return null; }
                // Phase 8.5B: 409 STREAM_LINKED — row is projected forward
                // from a recurring stream. Phase 10B: the body now also
                // includes `actions: ['acknowledge', 'stop_stream']` so we
                // surface BOTH options inline.
                if (res.status === 409) {
                  return res.json().catch(function () { return {}; }).then(function (data) {
                    return {
                      __streamLinked: true,
                      merchant: (data && data.merchant) || null,
                      actions: (data && Array.isArray(data.actions)) ? data.actions : ['stop_stream'],
                    };
                  });
                }
                // 404 = already gone server-side (e.g. zombie from a stale
                // localStorage cache). Treat it as success — purge locally so
                // the row stops haunting the UI on every reload.
                if (!res.ok && res.status !== 404) throw new Error('delete failed ' + res.status);
                return { __ok: true };
              }).then(function (out) {
                if (!out) return; // 401 path already navigated.
                if (out.__streamLinked) {
                  // Phase 10B: render the new TWO-button surface stacked.
                  //   1. "✓ I already paid this" — soft-acknowledge: row stays
                  //      visible greyed-out, no longer counts against the
                  //      running balance projection.
                  //   2. "stop tracking this stream" — opens the recurring
                  //      tab so the user can set an end_date on the stream.
                  // Cancel link bails out of the surface entirely.
                  var merchant = out.merchant || 'this';
                  var actions = out.actions || ['stop_stream'];
                  var newRow = document.createElement('div');
                  newRow.className = 'row-confirm row-confirm--stream-linked row-confirm--stacked';
                  var msg = document.createElement('span');
                  msg.className = 'row-confirm__label';
                  msg.textContent = 'this is part of your ' + merchant
                    + ' recurring stream.';
                  newRow.appendChild(msg);

                  var actionsWrap = document.createElement('span');
                  actionsWrap.className = 'row-confirm__actions';
                  newRow.appendChild(actionsWrap);

                  if (actions.indexOf('acknowledge') !== -1) {
                    var ackBtn = document.createElement('button');
                    ackBtn.type = 'button';
                    ackBtn.className = 'row-confirm__yes row-confirm__ack';
                    ackBtn.textContent = '✓ I already paid this';
                    ackBtn.addEventListener('click', function (aev) {
                      aev.stopPropagation();
                      ackBtn.disabled = true;
                      ackBtn.textContent = 'marking…';
                      fetch(API_BASE + '/api/transactions/schedule/'
                            + encodeURIComponent(txnSnapshot.id) + '/acknowledge',
                            { method: 'POST', credentials: 'include' })
                        .then(function (ackRes) {
                          if (ackRes.status === 401) { location.replace('/'); return null; }
                          if (!ackRes.ok && ackRes.status !== 404) {
                            throw new Error('acknowledge failed ' + ackRes.status);
                          }
                          return ackRes.json().catch(function () { return null; });
                        })
                        .then(function (ackOut) {
                          if (!ackOut) return;
                          // Flip the in-memory row so renderGrid + the day
                          // drawer immediately reflect the new state without
                          // a full refetch.
                          for (var i = 0; i < PRECOMMITS.length; i++) {
                            var p = PRECOMMITS[i];
                            if (p && p.source === 'scheduled' && p.id === txnSnapshot.id) {
                              p.acknowledged = true;
                              break;
                            }
                          }
                          if (newRow.parentNode) newRow.parentNode.removeChild(newRow);
                          if (item.parentNode) item.parentNode.removeChild(item);
                          renderGrid();
                          // Re-open the drawer with the updated state so the
                          // user sees the row return as "✓ paid".
                          try { closeDrawer(); openDrawer(d); } catch (_) {}
                        })
                        .catch(function (ackErr) {
                          try { console.warn('[home] acknowledge failed:', ackErr); } catch (_) {}
                          ackBtn.disabled = false;
                          ackBtn.textContent = '✓ I already paid this';
                        });
                    });
                    actionsWrap.appendChild(ackBtn);
                  }

                  var stopBtn = document.createElement('button');
                  stopBtn.type = 'button';
                  stopBtn.className = 'row-confirm__stop-stream';
                  stopBtn.textContent = 'stop tracking this stream';
                  stopBtn.addEventListener('click', function (lev) {
                    lev.stopPropagation();
                    try { openRecurring(); } catch (_) {}
                  });
                  actionsWrap.appendChild(stopBtn);

                  var dismissBtn = document.createElement('button');
                  dismissBtn.type = 'button';
                  dismissBtn.className = 'row-confirm__no';
                  dismissBtn.textContent = 'cancel';
                  dismissBtn.addEventListener('click', function (dev) {
                    dev.stopPropagation();
                    if (newRow.parentNode) newRow.parentNode.removeChild(newRow);
                    existingRight.forEach(function (n) { n.style.display = ''; });
                  });
                  actionsWrap.appendChild(dismissBtn);
                  if (confirmRow.parentNode) {
                    confirmRow.parentNode.replaceChild(newRow, confirmRow);
                  }
                  return;
                }
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
        // Same idea for the to-do panel: an inline delete-confirm gets
        // dismissed first before ESC bubbles up to closing the whole panel.
        if (dismissOpenTodoConfirms()) return;
        // Wallet panel mirrors the same pattern for tracked-row deletes.
        if (dismissOpenWalletConfirms()) return;
        closeDrawer();
        closeSchedule();
        closeBalances();
        closeReimbursements();
        closeTodo();
        closeRecurring();
        closeWallet();
        closeSnapshot();
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
    // If this schedule popover was launched from a recurring-stream row,
    // pop the recurring panel back open so the user lands where they
    // started — the stream list with the (now-edited) row visible. The
    // flag is one-shot: cleared the moment we honour it. Without this the
    // user would close the schedule and find themselves on the bare
    // calendar, having lost their place. (Bug C.)
    if (reopenRecurringAfterSchedule) {
      reopenRecurringAfterSchedule = false;
      // Defensive: only reopen if the recurring panel isn't already open
      // (e.g. ESC fast-paths, double-fires) and the wiring exists.
      if (recurringPop && !recurringPop.classList.contains('open')) {
        try { openRecurring(); } catch (_) {}
      }
    }
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
      // If this edit originated from a recurring-stream row, mirror the
      // change onto the stream so the recurring panel + future calendar
      // refetches stay in sync. We deliberately ignore failures here — the
      // calendar has already been updated by the PATCH above; a PATCH-stream
      // failure just means the stream's cached values may drift one cycle.
      if (isEdit && pendingRecurringEdit
          && Number(pendingRecurringEdit.scheduledId) === Number(editingTxnId)) {
        var merch = pendingRecurringEdit.merchant;
        pendingRecurringEdit = null;
        try {
          patchRecurringStream(merch, {
            display_name: body.name,
            next_due_date: body.date,
            amount: body.amount
          }).catch(function () {});
        } catch (_) {}
      } else {
        pendingRecurringEdit = null;
      }
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
        // Phase 8.5B: 409 STREAM_LINKED — row is projected forward from a
        // recurring stream. Phase 10B: surface BOTH options inline:
        //   1. "✓ I already paid this" — POST /acknowledge, soft-delete.
        //   2. "stop tracking this stream" — open recurring tab.
        // Both buttons are appended to the #sched-error region so the layout
        // stays consistent with the existing error chrome. CSP-safe (no
        // inline handlers).
        if (out.status === 409 && out.data && out.data.code === 'STREAM_LINKED') {
          var merchant = (out.data && out.data.merchant) || 'this';
          var actions = (out.data && Array.isArray(out.data.actions))
            ? out.data.actions
            : ['stop_stream'];
          if (schedError) {
            schedError.textContent = 'this is part of your ' + merchant
              + ' recurring stream. ';

            if (actions.indexOf('acknowledge') !== -1) {
              var ackLink = document.createElement('button');
              ackLink.type = 'button';
              ackLink.className = 'sched-error-link sched-error-link--ack';
              ackLink.textContent = '✓ I already paid this';
              ackLink.addEventListener('click', function () {
                ackLink.disabled = true;
                ackLink.textContent = 'marking…';
                fetch(API_BASE + '/api/transactions/schedule/'
                      + encodeURIComponent(id) + '/acknowledge',
                      { method: 'POST', credentials: 'include' })
                  .then(function (ackRes) {
                    if (ackRes.status === 401) { location.replace('/'); return null; }
                    if (!ackRes.ok && ackRes.status !== 404) {
                      throw new Error('acknowledge failed ' + ackRes.status);
                    }
                    return ackRes.json().catch(function () { return null; });
                  })
                  .then(function (ackOut) {
                    if (!ackOut) return;
                    // Flip the in-memory row so the calendar reflects the
                    // change immediately, then close the popover and let
                    // refreshAfterScheduleChange pull canonical state.
                    for (var i = 0; i < PRECOMMITS.length; i++) {
                      var p = PRECOMMITS[i];
                      if (p && p.source === 'scheduled' && p.id === id) {
                        p.acknowledged = true;
                        break;
                      }
                    }
                    if (schedDeleteYes) {
                      schedDeleteYes.disabled = false;
                      schedDeleteYes.textContent = 'yes';
                    }
                    hideDeleteConfirm();
                    closeSchedule();
                    refreshAfterScheduleChange();
                  })
                  .catch(function (ackErr) {
                    try { console.warn('[home] acknowledge failed:', ackErr); } catch (_) {}
                    if (schedError) {
                      schedError.textContent = 'couldn’t mark paid — try again.';
                    }
                  });
              });
              schedError.appendChild(ackLink);
              schedError.appendChild(document.createTextNode(' OR '));
            }

            var link = document.createElement('button');
            link.type = 'button';
            link.className = 'sched-error-link';
            link.textContent = 'stop tracking this stream';
            link.addEventListener('click', function () {
              try { closeSchedule(); } catch (_) {}
              try { openRecurring(); } catch (_) {}
            });
            schedError.appendChild(link);
            schedError.appendChild(document.createTextNode(' to set an end date.'));
          }
          if (schedDeleteYes) {
            schedDeleteYes.disabled = false;
            schedDeleteYes.textContent = 'yes';
          }
          return;
        }
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
    // The "forever true" amount: depository minus credit-card debt minus any
    // user-tracked card balances (from /api/wallet). When the wallet payload
    // is loaded, we use summary.running_balance_usd as the canonical base
    // (backend computes: depository − cc_owed − tracked). When it's not
    // loaded we fall back to a frontend depository−credit computation —
    // tracked totals are then absent until the prefetch lands.
    // In both paths, we layer in scheduled (planned) outflow/income deltas
    // since those live on the frontend (calendar) only.
    var schedOut = 0;
    var schedIn = 0;
    PRECOMMITS.forEach(function (e) {
      if (e.source !== 'scheduled') return;
      if (e.type === 'income') schedIn  += Number(e.amount) || 0;
      else                     schedOut += Number(e.amount) || 0;
    });

    var running;
    var walletSummary = walletCache && walletCache.summary;
    if (walletSummary && typeof walletSummary.running_balance_usd === 'number') {
      // Backend already nets depository − cc_owed − tracked. Layer scheduled.
      running = walletSummary.running_balance_usd - schedOut + schedIn;
    } else {
      // Wallet not yet loaded — fall back to plaid-only depository − credit.
      // Uses balanceForRow() so the per-row visible number matches what gets
      // summed in. balanceForRow prefers balance_available for depository
      // (subtracts pending holds — the most honest "available now" figure)
      // and balance_current for credit (Plaid convention: positive = owed).
      var depTotal = 0;
      var ccTotal  = 0;
      accounts.forEach(function (a) {
        var t = (a.account_type || '').toLowerCase();
        var b = balanceForRow(a);
        if (b === null || !isFinite(b)) return;
        if (t === 'depository') depTotal += b;
        else if (t === 'credit') ccTotal += b;
      });
      running = depTotal - ccTotal - schedOut + schedIn;
    }
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

  // ── To-do popup (localStorage-only mockup) ──────
  // Backed by cbff_v1_todos via cacheRead/cacheWrite. Schema:
  //   [{ id: string, text: string, done: boolean, created_at: number }]
  // Open tasks render first, completed at the bottom (greyed + struck through).
  // First open ever seeds an example task so the panel doesn't feel empty.
  // Once the user deletes everything, we DON'T re-seed — they meant to clear.
  var TODO_EXAMPLE_TEXT = 'call insurance about copay refund';

  function persistTodos() {
    if (Array.isArray(todosCache)) cacheWrite('todos', todosCache);
  }

  // Lazy-init the cache + seed the example. Called by openTodo() so the seed
  // happens on first open rather than on boot — keeps the work off the
  // critical path. Returns the current array (never null after this runs).
  function ensureTodosLoaded() {
    if (!Array.isArray(todosCache)) {
      var cached = cacheRead('todos');
      todosCache = Array.isArray(cached) ? cached : [];
    }
    if (todosCache.length === 0 && !cacheRead('todos_seeded')) {
      todosCache = [{
        id: 'seed-' + Date.now(),
        text: TODO_EXAMPLE_TEXT,
        done: false,
        created_at: Date.now()
      }];
      // Mark seeded so we don't re-add the example after the user clears the
      // list. They explicitly emptied it; respect that.
      cacheWrite('todos_seeded', true);
      persistTodos();
    }
    return todosCache;
  }

  function setTodoError(text) {
    if (todoError) todoError.textContent = text || '';
  }

  // Stable ID — Date.now()+random suffix is plenty for a localStorage mockup
  // and avoids needing crypto.randomUUID for older browsers.
  function newTodoId() {
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  // Update the small count badge on the chip. Only visible when there's at
  // least one open (un-done) item, so the chip stays calm when the list is
  // empty or fully completed.
  function updateTodoBadge() {
    if (!todoBtnCount) return;
    var openCount = (todosCache || []).reduce(function (n, t) {
      return n + (t && !t.done ? 1 : 0);
    }, 0);
    if (openCount > 0) {
      todoBtnCount.textContent = String(openCount);
      todoBtnCount.hidden = false;
    } else {
      todoBtnCount.textContent = '';
      todoBtnCount.hidden = true;
    }
  }

  // Sort: open tasks first (newest at top), completed below (newest at top).
  function sortedTodos() {
    var items = Array.isArray(todosCache) ? todosCache.slice() : [];
    items.sort(function (a, b) {
      var ad = a && a.done ? 1 : 0;
      var bd = b && b.done ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return (b.created_at || 0) - (a.created_at || 0);
    });
    return items;
  }

  function buildTodoConfirmRow(labelText) {
    var confirmRow = document.createElement('div');
    confirmRow.className = 'row-confirm';

    var label = document.createElement('span');
    label.className = 'row-confirm__label';
    label.textContent = labelText;
    confirmRow.appendChild(label);

    var sep1 = document.createElement('span');
    sep1.className = 'row-confirm__sep';
    sep1.textContent = '\u00b7';
    confirmRow.appendChild(sep1);

    var yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'row-confirm__yes';
    yesBtn.textContent = 'yes';
    confirmRow.appendChild(yesBtn);

    var sep2 = document.createElement('span');
    sep2.className = 'row-confirm__sep';
    sep2.textContent = '\u00b7';
    confirmRow.appendChild(sep2);

    var noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'row-confirm__no';
    noBtn.textContent = 'cancel';
    confirmRow.appendChild(noBtn);

    return { node: confirmRow, label: label, yes: yesBtn, no: noBtn };
  }

  function buildTodoItem(item) {
    var row = document.createElement('div');
    row.className = 'todo-item';
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-id', item.id);
    if (item.done) row.classList.add('is-done');

    // Custom round checkbox — visual button, real toggle role via aria.
    var box = document.createElement('button');
    box.type = 'button';
    box.className = 'todo-checkbox';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', item.done ? 'true' : 'false');
    box.setAttribute('aria-label',
      (item.done ? 'mark not done: ' : 'mark done: ') + (item.text || ''));
    row.appendChild(box);

    var text = document.createElement('span');
    text.className = 'todo-item__text';
    text.textContent = item.text || '';
    row.appendChild(text);

    // Trash glyph — same SVG approach as the reimb item, fades in on hover.
    var trash = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    trash.setAttribute('class', 'todo-item__trash');
    trash.setAttribute('viewBox', '0 0 16 16');
    trash.setAttribute('fill', 'none');
    trash.setAttribute('stroke', 'currentColor');
    trash.setAttribute('stroke-width', '1.4');
    trash.setAttribute('stroke-linecap', 'round');
    trash.setAttribute('stroke-linejoin', 'round');
    trash.setAttribute('role', 'button');
    trash.setAttribute('tabindex', '0');
    trash.setAttribute('aria-label', 'delete: ' + (item.text || 'task'));
    var trashPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    trashPath.setAttribute('d', 'M3 4h10M6 4V2.8h4V4M5 4v9h6V4M7.5 6.5v4M9 6.5v4');
    trash.appendChild(trashPath);
    row.appendChild(trash);

    // Toggle done on checkbox click. Updates cache + re-renders so completed
    // items drop to the bottom of the list.
    box.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleTodo(item.id);
    });

    // Delete: open inline confirm (mirrors row-confirm pattern from day popover).
    var openDeleteConfirm = function (ev) {
      ev.stopPropagation();
      if (row.querySelector('.row-confirm')) return;
      // Hide trash + (optionally) checkbox label so the confirm row reads cleanly.
      trash.style.display = 'none';
      var c = buildTodoConfirmRow('delete?');
      row.appendChild(c.node);
      var restore = function () {
        if (c.node.parentNode) c.node.parentNode.removeChild(c.node);
        trash.style.display = '';
      };
      c.node._todoCancel = restore;
      try { c.yes.focus({ preventScroll: true }); } catch (_) { c.yes.focus(); }
      c.no.addEventListener('click', function (cev) {
        cev.stopPropagation();
        restore();
      });
      c.yes.addEventListener('click', function (cev) {
        cev.stopPropagation();
        deleteTodo(item.id);
        // deleteTodo re-renders synchronously; row gets rebuilt or removed.
      });
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

  function renderTodos() {
    if (!todoList) return;
    todoList.innerHTML = '';
    var items = sortedTodos();
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'todo-empty';
      empty.textContent = 'nothing to handle right now.';
      todoList.appendChild(empty);
      updateTodoBadge();
      return;
    }
    items.forEach(function (it) { todoList.appendChild(buildTodoItem(it)); });
    updateTodoBadge();
  }

  function addTodo(text) {
    var t = (text || '').trim();
    setTodoError('');
    if (!t) {
      setTodoError('add something to handle.');
      return;
    }
    if (t.length > 120) {
      setTodoError('too long (max 120).');
      return;
    }
    if (!Array.isArray(todosCache)) todosCache = [];
    todosCache.push({
      id: newTodoId(),
      text: t,
      done: false,
      created_at: Date.now()
    });
    persistTodos();
    if (todoAddInput) todoAddInput.value = '';
    renderTodos();
  }

  function toggleTodo(id) {
    if (!Array.isArray(todosCache)) return;
    for (var i = 0; i < todosCache.length; i++) {
      if (todosCache[i] && todosCache[i].id === id) {
        todosCache[i].done = !todosCache[i].done;
        break;
      }
    }
    persistTodos();
    renderTodos();
  }

  function deleteTodo(id) {
    if (!Array.isArray(todosCache)) return;
    todosCache = todosCache.filter(function (t) { return !t || t.id !== id; });
    persistTodos();
    renderTodos();
  }

  // ESC-dismissable inline confirms inside the to-do panel. Returns true if
  // anything was dismissed so the global ESC handler can short-circuit.
  function dismissOpenTodoConfirms() {
    if (!todoList) return false;
    var confirms = todoList.querySelectorAll('.row-confirm');
    if (!confirms.length) return false;
    Array.prototype.forEach.call(confirms, function (n) {
      if (typeof n._todoCancel === 'function') n._todoCancel();
    });
    return true;
  }

  function openTodo() {
    if (!todoPop || !todoOverlay) return;
    ensureTodosLoaded();
    todoPop.classList.add('open');
    todoOverlay.classList.add('open');
    todoPop.setAttribute('aria-hidden', 'false');
    setTodoError('');
    renderTodos();
    if (todoAddInput) {
      try { todoAddInput.focus({ preventScroll: true }); } catch (_) { todoAddInput.focus(); }
    }
  }

  function closeTodo() {
    if (!todoPop || !todoOverlay) return;
    todoPop.classList.remove('open');
    todoOverlay.classList.remove('open');
    todoPop.setAttribute('aria-hidden', 'true');
    setTodoError('');
  }

  function wireTodoBtn() {
    todoBtn       = document.getElementById('todo-btn');
    todoBtnCount  = document.getElementById('todo-btn-count');
    todoOverlay   = document.getElementById('todo-overlay');
    todoPop       = document.getElementById('todo-pop');
    todoClose     = document.getElementById('todo-close');
    todoAddForm   = document.getElementById('todo-add-form');
    todoAddInput  = document.getElementById('todo-add-input');
    todoAddBtn    = document.getElementById('todo-add-btn');
    todoError     = document.getElementById('todo-error');
    todoList      = document.getElementById('todo-list');

    if (todoBtn)     todoBtn.addEventListener('click', openTodo);
    if (todoClose)   todoClose.addEventListener('click', closeTodo);
    if (todoOverlay) todoOverlay.addEventListener('click', closeTodo);
    if (todoAddForm) {
      todoAddForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        addTodo(todoAddInput && todoAddInput.value);
      });
    }
    // Initialize the badge on boot so the count is right before first open.
    // ensureTodosLoaded() seeds the example on the very first render path,
    // but we only render the chip badge once todos are loaded — which we
    // defer until the panel opens. Read the cache directly here so the badge
    // shows for returning users without forcing a seed on boot.
    var cached = cacheRead('todos');
    if (Array.isArray(cached)) {
      todosCache = cached;
      updateTodoBadge();
    }
  }

  // ── Recurring popup (real data) ─────────────────
  // Two sections: "to review" (suggestions backed by /api/recurring/suggestions)
  // + "your recurring" (confirmed streams backed by /api/recurring/streams).
  // SWR: hydrate from localStorage on boot, refetch on first open + after
  // every successful mutation. The badge on the chip shows # of suggestions.

  function persistRecurringSuggestionsCache() {
    if (Array.isArray(recurringSuggestionsCache)) {
      cacheWrite('recurring_suggestions', recurringSuggestionsCache);
    }
  }
  function persistRecurringStreamsCache() {
    if (Array.isArray(recurringStreamsCache)) {
      cacheWrite('recurring_streams', recurringStreamsCache);
    }
  }

  function setRecurringStatus(text) {
    if (recurringStatus) recurringStatus.textContent = text || '';
  }

  function updateRecurringBadge() {
    if (!recurringBtnCount) return;
    var count = Array.isArray(recurringSuggestionsCache)
      ? recurringSuggestionsCache.length
      : 0;
    if (count > 0) {
      recurringBtnCount.textContent = String(count);
      recurringBtnCount.hidden = false;
    } else {
      recurringBtnCount.textContent = '';
      recurringBtnCount.hidden = true;
    }
  }

  function fetchRecurringSuggestionsOnce(opts) {
    var force = !!(opts && opts.force);
    if (!force && Array.isArray(recurringSuggestionsCache)
        && recurringSuggestionsCache._fresh) {
      return Promise.resolve(recurringSuggestionsCache);
    }
    if (recurringSuggestionsFetchInflight) return recurringSuggestionsFetchInflight;
    recurringSuggestionsFetchInflight = fetch(
      API_BASE + '/api/recurring/suggestions',
      { headers: { 'Content-Type': 'application/json' }, credentials: 'include' }
    ).then(function (res) {
      if (res.status === 401) return { items: [] };
      if (!res.ok) throw new Error('recurring suggestions fetch failed ' + res.status);
      return res.json();
    }).then(function (data) {
      var items = (data && Array.isArray(data.items)) ? data.items : [];
      recurringSuggestionsCache = items;
      recurringSuggestionsLoaded = true;
      try {
        Object.defineProperty(recurringSuggestionsCache, '_fresh',
          { value: true, enumerable: false, configurable: true });
      } catch (_) { recurringSuggestionsCache._fresh = true; }
      persistRecurringSuggestionsCache();
      recurringSuggestionsFetchInflight = null;
      updateRecurringBadge();
      return recurringSuggestionsCache;
    }).catch(function (err) {
      recurringSuggestionsFetchInflight = null;
      try { console.warn('[home] recurring suggestions fetch error:', err); } catch (_) {}
      throw err;
    });
    return recurringSuggestionsFetchInflight;
  }

  function fetchRecurringStreamsOnce(opts) {
    var force = !!(opts && opts.force);
    if (!force && Array.isArray(recurringStreamsCache)
        && recurringStreamsCache._fresh) {
      return Promise.resolve(recurringStreamsCache);
    }
    if (recurringStreamsFetchInflight) return recurringStreamsFetchInflight;
    recurringStreamsFetchInflight = fetch(
      API_BASE + '/api/recurring/streams',
      { headers: { 'Content-Type': 'application/json' }, credentials: 'include' }
    ).then(function (res) {
      if (res.status === 401) return { items: [] };
      if (!res.ok) throw new Error('recurring streams fetch failed ' + res.status);
      return res.json();
    }).then(function (data) {
      var items = (data && Array.isArray(data.items)) ? data.items : [];
      recurringStreamsCache = items;
      recurringStreamsLoaded = true;
      try {
        Object.defineProperty(recurringStreamsCache, '_fresh',
          { value: true, enumerable: false, configurable: true });
      } catch (_) { recurringStreamsCache._fresh = true; }
      persistRecurringStreamsCache();
      recurringStreamsFetchInflight = null;
      return recurringStreamsCache;
    }).catch(function (err) {
      recurringStreamsFetchInflight = null;
      try { console.warn('[home] recurring streams fetch error:', err); } catch (_) {}
      throw err;
    });
    return recurringStreamsFetchInflight;
  }

  // Format an ISO yyyy-mm-dd as "may 14" (lowercase short month).
  function formatRecurringDate(iso) {
    if (!iso || typeof iso !== 'string') return '—';
    var parts = iso.slice(0, 10).split('-');
    if (parts.length !== 3) return iso;
    var months = ['jan','feb','mar','apr','may','jun',
                  'jul','aug','sep','oct','nov','dec'];
    var mi = Number(parts[1]) - 1;
    if (mi < 0 || mi > 11) return iso;
    return months[mi] + ' ' + Number(parts[2]);
  }

  // Default a missing next_due_date to today + 30 days, ISO. Used by the
  // suggestion card when the bridge couldn't infer one (rare but possible).
  function defaultNextDueIso() {
    var d = new Date();
    d.setDate(d.getDate() + 30);
    return iso(d);
  }

  function buildRecurringSuggestionCard(item) {
    var card = document.createElement('div');
    card.className = 'recurring-suggestion';
    card.setAttribute('data-merchant', item.merchant || '');

    // ── Name field (editable text) ──────────────────────
    var nameField = document.createElement('div');
    nameField.className = 'recurring-suggestion__field';
    var nameLabel = document.createElement('label');
    nameLabel.className = 'recurring-suggestion__label';
    nameLabel.textContent = 'name';
    var nameInput = document.createElement('input');
    nameInput.className = 'recurring-suggestion__input';
    nameInput.type = 'text';
    nameInput.maxLength = 80;
    nameInput.value = (typeof item.display_name === 'string' && item.display_name.length > 0)
      ? item.display_name
      : (item.merchant || '');
    nameLabel.htmlFor = 'rec-sug-name-' + (item.merchant || '');
    nameInput.id = nameLabel.htmlFor;
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    // ── Date field (next charge) ────────────────────────
    var dateField = document.createElement('div');
    dateField.className = 'recurring-suggestion__field';
    var dateLabel = document.createElement('label');
    dateLabel.className = 'recurring-suggestion__label';
    dateLabel.textContent = 'next charge';
    var dateInput = document.createElement('input');
    dateInput.className = 'recurring-suggestion__input';
    dateInput.type = 'date';
    dateInput.value = (typeof item.next_due_date === 'string' && item.next_due_date.length >= 10)
      ? item.next_due_date.slice(0, 10)
      : defaultNextDueIso();
    dateLabel.htmlFor = 'rec-sug-date-' + (item.merchant || '');
    dateInput.id = dateLabel.htmlFor;
    dateField.appendChild(dateLabel);
    dateField.appendChild(dateInput);
    card.appendChild(dateField);

    // ── Amount field ────────────────────────────────────
    var amtField = document.createElement('div');
    amtField.className = 'recurring-suggestion__field recurring-suggestion__field--amount';
    var amtLabel = document.createElement('label');
    amtLabel.className = 'recurring-suggestion__label';
    amtLabel.textContent = 'amount';
    var amtPrefix = document.createElement('span');
    amtPrefix.className = 'recurring-suggestion__amount-prefix';
    amtPrefix.textContent = '$';
    var amtInput = document.createElement('input');
    amtInput.className = 'recurring-suggestion__input';
    amtInput.type = 'number';
    amtInput.step = '0.01';
    amtInput.min = '0';
    amtInput.inputMode = 'decimal';
    amtInput.placeholder = '0.00';
    var amt = (typeof item.amount === 'number' && isFinite(item.amount)) ? item.amount : 0;
    amtInput.value = amt > 0 ? amt.toFixed(2) : '0';
    amtLabel.htmlFor = 'rec-sug-amt-' + (item.merchant || '');
    amtInput.id = amtLabel.htmlFor;
    amtField.appendChild(amtLabel);
    amtField.appendChild(amtPrefix);
    amtField.appendChild(amtInput);
    card.appendChild(amtField);

    // ── "from {Institution} ···{mask}" provenance line ───
    // Phase 5: replaces the old "saw this last on…" reasoning line. Only
    // rendered when both fields are present; if either is missing we omit
    // the row entirely (no "from undefined ···" rendering).
    if (typeof item.from_institution === 'string'
        && item.from_institution.length > 0
        && typeof item.from_mask === 'string'
        && item.from_mask.length > 0) {
      var meta = document.createElement('div');
      meta.className = 'recurring-suggestion__meta';
      meta.textContent = 'from ' + item.from_institution + ' \u00b7\u00b7\u00b7' + item.from_mask;
      card.appendChild(meta);
    }

    // ── Inline error row ────────────────────────────────
    var err = document.createElement('div');
    err.className = 'recurring-suggestion__error';
    card.appendChild(err);

    // ── Actions ─────────────────────────────────────────
    var actions = document.createElement('div');
    actions.className = 'recurring-suggestion__actions';

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'recurring-suggestion__confirm';
    confirmBtn.textContent = '\u2713 add to recurring';
    actions.appendChild(confirmBtn);

    var dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'recurring-suggestion__dismiss';
    dismissBtn.textContent = 'not recurring';
    actions.appendChild(dismissBtn);

    card.appendChild(actions);

    // ── Behaviour: confirm flow ─────────────────────────
    confirmBtn.addEventListener('click', function () {
      err.textContent = '';
      var nameVal = (nameInput.value || '').trim();
      var dateVal = (dateInput.value || '').trim();
      var amtRaw = (amtInput.value || '').trim();
      var amtNum = parseFloat(amtRaw);
      if (!nameVal) { err.textContent = 'give it a name.'; return; }
      if (!dateVal) { err.textContent = 'pick a next-charge date.'; return; }
      if (!amtRaw || isNaN(amtNum) || amtNum < 0) {
        err.textContent = 'enter an amount of zero or more.';
        return;
      }
      confirmBtn.disabled = true;
      dismissBtn.disabled = true;
      var prevText = confirmBtn.textContent;
      confirmBtn.textContent = 'adding\u2026';
      confirmRecurringSuggestion(item.merchant, {
        display_name: nameVal,
        next_due_date: dateVal,
        amount: Math.round(amtNum * 100) / 100
      }).then(function () {
        // Cache + UI refresh handled by the shared post-mutation flow.
      }).catch(function (e) {
        confirmBtn.disabled = false;
        dismissBtn.disabled = false;
        confirmBtn.textContent = prevText;
        err.textContent = (e && e.userMessage) || 'couldn\u2019t add \u2014 try again.';
      });
    });

    // ── Behaviour: inline dismiss confirm ──────────────
    dismissBtn.addEventListener('click', function () {
      err.textContent = '';
      // Bail if a confirm is already up.
      if (card.querySelector('.recurring-suggestion__confirm-row')) return;
      // Hide the action buttons and inject a row-confirm under the meta line.
      actions.style.display = 'none';
      var confirmRow = document.createElement('div');
      confirmRow.className = 'row-confirm recurring-suggestion__confirm-row';

      var label = document.createElement('span');
      label.className = 'row-confirm__label';
      label.textContent = 'really?';
      confirmRow.appendChild(label);

      var sep1 = document.createElement('span');
      sep1.className = 'row-confirm__sep';
      sep1.textContent = '\u00b7';
      confirmRow.appendChild(sep1);

      var yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'row-confirm__yes';
      yes.textContent = 'yes, dismiss';
      confirmRow.appendChild(yes);

      var sep2 = document.createElement('span');
      sep2.className = 'row-confirm__sep';
      sep2.textContent = '\u00b7';
      confirmRow.appendChild(sep2);

      var no = document.createElement('button');
      no.type = 'button';
      no.className = 'row-confirm__no';
      no.textContent = 'cancel';
      confirmRow.appendChild(no);

      card.appendChild(confirmRow);

      var restore = function () {
        if (confirmRow.parentNode) confirmRow.parentNode.removeChild(confirmRow);
        actions.style.display = '';
      };

      no.addEventListener('click', restore);
      yes.addEventListener('click', function () {
        yes.disabled = true;
        no.disabled = true;
        label.textContent = 'dismissing\u2026';
        dismissRecurringSuggestion(item.merchant).then(function () {
          // Cache + UI refresh handled by the shared post-mutation flow.
        }).catch(function () {
          label.textContent = 'couldn\u2019t dismiss \u00b7 cancel';
          yes.style.display = 'none';
          sep2.style.display = 'none';
          no.disabled = false;
        });
      });
    });

    return card;
  }

  function buildRecurringStreamRow(item) {
    var row = document.createElement('div');
    row.className = 'recurring-stream';
    row.setAttribute('data-merchant', item.merchant || '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');

    var dot = document.createElement('span');
    dot.className = 'recurring-stream__dot';
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);

    var main = document.createElement('div');
    main.className = 'recurring-stream__main';
    var name = document.createElement('div');
    name.className = 'recurring-stream__name';
    name.textContent = (typeof item.display_name === 'string' && item.display_name.length > 0)
      ? item.display_name
      : (item.merchant || '');
    main.appendChild(name);

    var meta = document.createElement('div');
    meta.className = 'recurring-stream__meta';
    var pill = document.createElement('span');
    pill.className = 'recurring-stream__pill';
    pill.textContent = 'next: ' + formatRecurringDate(item.next_due_date);
    meta.appendChild(pill);
    var amt = document.createElement('span');
    amt.className = 'recurring-stream__amt';
    var amtNum = (typeof item.amount === 'number' && isFinite(item.amount)) ? item.amount : 0;
    amt.textContent = '$' + amtNum.toFixed(2);
    meta.appendChild(amt);
    main.appendChild(meta);

    // ── "from {Institution} ···{mask}" provenance line ───
    // Phase 5: only rendered when both fields are present.
    if (typeof item.from_institution === 'string'
        && item.from_institution.length > 0
        && typeof item.from_mask === 'string'
        && item.from_mask.length > 0) {
      var fromLine = document.createElement('div');
      fromLine.className = 'recurring-stream__from';
      fromLine.textContent = 'from ' + item.from_institution + ' \u00b7\u00b7\u00b7' + item.from_mask;
      main.appendChild(fromLine);
    }

    row.appendChild(main);

    var actions = document.createElement('div');
    actions.className = 'recurring-stream__actions';

    // Pencil — opens the schedule popover in edit mode for the linked txn.
    var edit = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    edit.setAttribute('class', 'recurring-stream__edit');
    edit.setAttribute('viewBox', '0 0 16 16');
    edit.setAttribute('fill', 'none');
    edit.setAttribute('stroke', 'currentColor');
    edit.setAttribute('stroke-width', '1.4');
    edit.setAttribute('stroke-linecap', 'round');
    edit.setAttribute('stroke-linejoin', 'round');
    edit.setAttribute('role', 'button');
    edit.setAttribute('tabindex', '0');
    edit.setAttribute('aria-label', 'edit ' + (item.display_name || item.merchant || ''));
    var editPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    editPath.setAttribute('d', 'M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z');
    edit.appendChild(editPath);
    actions.appendChild(edit);

    // Trash — inline confirm row → DELETE /streams/:merchant.
    var trash = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    trash.setAttribute('class', 'recurring-stream__trash');
    trash.setAttribute('viewBox', '0 0 16 16');
    trash.setAttribute('fill', 'none');
    trash.setAttribute('stroke', 'currentColor');
    trash.setAttribute('stroke-width', '1.4');
    trash.setAttribute('stroke-linecap', 'round');
    trash.setAttribute('stroke-linejoin', 'round');
    trash.setAttribute('role', 'button');
    trash.setAttribute('tabindex', '0');
    trash.setAttribute('aria-label', 'remove ' + (item.display_name || item.merchant || ''));
    var trashPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    trashPath.setAttribute('d', 'M3 4h10M6 4V2.8h4V4M5 4v9h6V4M7.5 6.5v4M9 6.5v4');
    trash.appendChild(trashPath);
    actions.appendChild(trash);
    row.appendChild(actions);

    // Phase 8C: open the new dedicated #recurring-edit-pop modal. The old
    // flow opened the schedule popover (which was originally for one-off
    // scheduled txns) and then mirrored saves back onto the stream. The
    // new modal owns the recurring concept end-to-end — including
    // frequency + end_date — so the mental models stay clean. Stream-row
    // edits no longer touch /api/transactions/schedule.
    var openEditFlow = function (ev) {
      if (ev) ev.stopPropagation();
      openRecurringEdit(item);
    };
    row.addEventListener('click', function (ev) {
      // Ignore clicks that landed on the trash/edit icons (they handle
      // themselves below).
      if (ev.target === trash || trash.contains(ev.target)) return;
      if (ev.target === edit || edit.contains(ev.target)) return;
      openEditFlow(ev);
    });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openEditFlow(ev);
      }
    });
    edit.addEventListener('click', openEditFlow);

    // Trash → inline confirm row → DELETE /streams/:merchant.
    trash.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (row.querySelector('.row-confirm')) return;
      // Hide the right-hand action icons + tuck the confirm row in there.
      actions.style.display = 'none';

      var confirmRow = document.createElement('div');
      confirmRow.className = 'row-confirm';
      var label = document.createElement('span');
      label.className = 'row-confirm__label';
      label.textContent = 'remove?';
      confirmRow.appendChild(label);
      var sep1 = document.createElement('span');
      sep1.className = 'row-confirm__sep';
      sep1.textContent = '\u00b7';
      confirmRow.appendChild(sep1);
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'row-confirm__yes';
      yes.textContent = 'yes';
      confirmRow.appendChild(yes);
      var sep2 = document.createElement('span');
      sep2.className = 'row-confirm__sep';
      sep2.textContent = '\u00b7';
      confirmRow.appendChild(sep2);
      var no = document.createElement('button');
      no.type = 'button';
      no.className = 'row-confirm__no';
      no.textContent = 'cancel';
      confirmRow.appendChild(no);
      row.appendChild(confirmRow);

      var restore = function () {
        if (confirmRow.parentNode) confirmRow.parentNode.removeChild(confirmRow);
        actions.style.display = '';
      };
      no.addEventListener('click', function (cev) {
        cev.stopPropagation();
        restore();
      });
      yes.addEventListener('click', function (cev) {
        cev.stopPropagation();
        yes.disabled = true;
        no.disabled = true;
        label.textContent = 'removing\u2026';
        deleteRecurringStream(item.merchant).catch(function () {
          label.textContent = 'couldn\u2019t remove \u00b7 cancel';
          yes.style.display = 'none';
          sep2.style.display = 'none';
          no.disabled = false;
        });
      });
    });

    return row;
  }

  // Holds the pending {merchant, scheduledId} when the user opens the schedule
  // popover from a stream row. After a successful PATCH on the scheduled txn,
  // patchScheduleSubmit() consults this and PATCHes the stream too.
  var pendingRecurringEdit = null;
  // One-shot flag set by buildRecurringStreamRow → openEditFlow when it opens
  // the schedule popover from a stream row. closeSchedule() consumes the flag
  // to reopen the recurring panel so the user lands back where they started.
  // Without this both popovers would visibly stack ("glitched in 2 menus").
  var reopenRecurringAfterSchedule = false;

  // Phase 8C: paint a 3-card skeleton while a fetch is in flight. Replaces
  // the empty-state copy that used to flash during a slow GET (which made
  // users mass-refresh thinking the data was gone). variant ='card' for
  // the suggestions section (taller cards), 'row' for streams (compact).
  function buildRecurringSkeleton(variant) {
    var wrap = document.createElement('div');
    wrap.className = 'recurring-skeleton';
    wrap.setAttribute('data-skeleton', variant || 'card');
    var cls = variant === 'row'
      ? 'recurring-skeleton__row'
      : 'recurring-skeleton__card';
    for (var i = 0; i < 3; i++) {
      var c = document.createElement('div');
      c.className = cls;
      c.setAttribute('aria-hidden', 'true');
      wrap.appendChild(c);
    }
    return wrap;
  }

  function renderRecurring() {
    if (recurringSuggestionsList) {
      recurringSuggestionsList.innerHTML = '';
      // Three-state machine: loading -> skeleton, loaded-empty -> empty
      // copy, loaded-with-items -> cards. Without the explicit loaded
      // flag the empty-state copy flashes during a fetch (Phase 8C bug).
      if (!recurringSuggestionsLoaded && !Array.isArray(recurringSuggestionsCache)) {
        if (recurringSuggestionsCount) {
          recurringSuggestionsCount.textContent = '';
        }
        recurringSuggestionsList.appendChild(buildRecurringSkeleton('card'));
      } else {
        var suggestions = Array.isArray(recurringSuggestionsCache)
          ? recurringSuggestionsCache : [];
        if (recurringSuggestionsCount) {
          recurringSuggestionsCount.textContent = '(' + suggestions.length + ')';
        }
        if (!suggestions.length) {
          var empty1 = document.createElement('div');
          empty1.className = 'recurring-empty';
          empty1.textContent = 'all caught up \u2014 we\u2019ll surface new ones as we see them.';
          recurringSuggestionsList.appendChild(empty1);
        } else {
          suggestions.forEach(function (it) {
            recurringSuggestionsList.appendChild(buildRecurringSuggestionCard(it));
          });
        }
      }
    }
    if (recurringStreamsList) {
      recurringStreamsList.innerHTML = '';
      if (!recurringStreamsLoaded && !Array.isArray(recurringStreamsCache)) {
        if (recurringStreamsCount) {
          recurringStreamsCount.textContent = '';
        }
        recurringStreamsList.appendChild(buildRecurringSkeleton('row'));
      } else {
        var streams = Array.isArray(recurringStreamsCache)
          ? recurringStreamsCache : [];
        if (recurringStreamsCount) {
          recurringStreamsCount.textContent = '(' + streams.length + ')';
        }
        if (!streams.length) {
          var empty2 = document.createElement('div');
          empty2.className = 'recurring-empty';
          empty2.textContent = 'nothing tracked yet \u2014 add one above or wait for a suggestion.';
          recurringStreamsList.appendChild(empty2);
        } else {
          streams.forEach(function (it) {
            recurringStreamsList.appendChild(buildRecurringStreamRow(it));
          });
        }
      }
    }
    updateRecurringBadge();
  }

  // After every successful mutation (confirm/dismiss/patch/delete) we re-fetch
  // both lists so the cached _fresh marker is honest and the calendar's
  // visible-month cache is invalidated so a `sub` row appears immediately.
  // `extraDates` is an optional array of ISO date strings (next_due_date
  // before/after) — months derived from those are also evicted, so a stream
  // whose next_due_date sits in a different month than the visible one still
  // refreshes its calendar pills without a hard reload. Pass both old and new
  // dates on PATCHes that move a stream across months.
  function reloadRecurringAfterMutation(extraDates) {
    // Drop _fresh so the next fetchOnce hits the network.
    if (recurringSuggestionsCache) {
      try { recurringSuggestionsCache._fresh = false; } catch (_) {}
    }
    if (recurringStreamsCache) {
      try { recurringStreamsCache._fresh = false; } catch (_) {}
    }
    var p1 = fetchRecurringSuggestionsOnce({ force: true });
    var p2 = fetchRecurringStreamsOnce({ force: true });
    return Promise.all([p1, p2]).then(function () {
      renderRecurring();
      // Force a calendar refetch for the visible month so a fresh "sub" row
      // appears (or vanishes) without a hard reload.
      try {
        var visibleKey = monthKey(view.getFullYear(), view.getMonth());
        var keysToEvict = [visibleKey];
        if (Array.isArray(extraDates)) {
          extraDates.forEach(function (iso) {
            var k = monthKeyFromIso(iso);
            if (k && keysToEvict.indexOf(k) === -1) keysToEvict.push(k);
          });
        }
        keysToEvict.forEach(function (k) { fetchedMonths.delete(k); });
        // Always refetch the visible month so the user sees fresh pills now.
        fetchMonthIfNeeded(view.getFullYear(), view.getMonth());
        // Refetch any other affected month so a calendar nav to it is fresh.
        keysToEvict.forEach(function (k) {
          if (k === visibleKey) return;
          var p = k.split('-');
          var y = Number(p[0]);
          var m = Number(p[1]);
          if (isFinite(y) && isFinite(m)) fetchMonthIfNeeded(y, m - 1);
        });
      } catch (_) {}
    });
  }

  // Look up a stream's current next_due_date from the cache (used by
  // mutation paths so they can invalidate the prior month's calendar cache
  // when a PATCH moves the date across a month boundary, or a DELETE
  // removes a pill in some non-visible month).
  function streamNextDueIso(merchant) {
    if (!Array.isArray(recurringStreamsCache)) return null;
    for (var i = 0; i < recurringStreamsCache.length; i++) {
      var s = recurringStreamsCache[i];
      if (s && s.merchant === merchant) {
        return (typeof s.next_due_date === 'string') ? s.next_due_date : null;
      }
    }
    return null;
  }

  function confirmRecurringSuggestion(merchant, edits) {
    var url = API_BASE + '/api/recurring/suggestions/'
      + encodeURIComponent(merchant) + '/confirm';
    var newDate = (edits && typeof edits.next_due_date === 'string')
      ? edits.next_due_date : null;
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edits || {})
    }).then(function (res) {
      if (res.status === 401) { location.replace('/'); throw new Error('unauthed'); }
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          var err = new Error('confirm failed ' + res.status);
          err.userMessage = (data && data.error) || 'couldn\u2019t add.';
          throw err;
        });
      }
      return res.json();
    }).then(function () {
      // Confirming creates a new stream + linked scheduled txn at next_due_date.
      // Pass that date so its month's calendar cache is also invalidated.
      return reloadRecurringAfterMutation(newDate ? [newDate] : null);
    });
  }

  function dismissRecurringSuggestion(merchant) {
    var url = API_BASE + '/api/recurring/suggestions/'
      + encodeURIComponent(merchant) + '/dismiss';
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    }).then(function (res) {
      if (res.status === 401) { location.replace('/'); throw new Error('unauthed'); }
      if (!res.ok) throw new Error('dismiss failed ' + res.status);
      return res.json();
    }).then(function () {
      return reloadRecurringAfterMutation();
    });
  }

  function patchRecurringStream(merchant, edits) {
    var url = API_BASE + '/api/recurring/streams/' + encodeURIComponent(merchant);
    // Capture the prior next_due_date BEFORE the request — we need both old
    // and new dates so the calendar cache is invalidated for both months
    // when a PATCH moves the stream across a month boundary.
    var priorDate = streamNextDueIso(merchant);
    var newDate = (edits && typeof edits.next_due_date === 'string')
      ? edits.next_due_date : null;
    return fetch(url, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edits || {})
    }).then(function (res) {
      if (res.status === 401) { location.replace('/'); throw new Error('unauthed'); }
      if (!res.ok) throw new Error('patch failed ' + res.status);
      return res.json();
    }).then(function () {
      var dates = [];
      if (priorDate) dates.push(priorDate);
      if (newDate)   dates.push(newDate);
      return reloadRecurringAfterMutation(dates.length ? dates : null);
    });
  }

  function deleteRecurringStream(merchant) {
    var url = API_BASE + '/api/recurring/streams/' + encodeURIComponent(merchant);
    // Capture the stream's next_due_date before delete so the calendar cache
    // for that month is invalidated and the now-orphaned pill clears even
    // when the user is viewing a different month.
    var priorDate = streamNextDueIso(merchant);
    return fetch(url, {
      method: 'DELETE',
      credentials: 'include'
    }).then(function (res) {
      if (res.status === 401) { location.replace('/'); throw new Error('unauthed'); }
      if (!res.ok && res.status !== 404) throw new Error('delete failed ' + res.status);
      return res.json().catch(function () { return {}; });
    }).then(function () {
      return reloadRecurringAfterMutation(priorDate ? [priorDate] : null);
    });
  }

  function openRecurring() {
    if (!recurringPop || !recurringOverlay) return;
    recurringPop.classList.add('open');
    recurringOverlay.classList.add('open');
    recurringPop.setAttribute('aria-hidden', 'false');
    setRecurringStatus('');

    // Phase 8C: ALWAYS render on open. If the caches aren't loaded yet
    // renderRecurring() paints the skeleton (3 ghost cards/rows). If the
    // caches ARE loaded (cache-hydrated boot or a prior session) it paints
    // real items. Either way, no empty-state flash on a slow fetch.
    renderRecurring();
    // Skip refetch when both caches are backend-fresh from this session.
    var sFresh = Array.isArray(recurringSuggestionsCache) && recurringSuggestionsCache._fresh;
    var stFresh = Array.isArray(recurringStreamsCache) && recurringStreamsCache._fresh;
    if (!sFresh || !stFresh) {
      Promise.all([
        fetchRecurringSuggestionsOnce(),
        fetchRecurringStreamsOnce()
      ]).then(function () {
        setRecurringStatus('');
        renderRecurring();
      }).catch(function () {
        // On error, mark loaded so the empty-state replaces the skeleton
        // (skeleton spinning forever is worse than an empty list + a
        // visible error message).
        recurringSuggestionsLoaded = true;
        recurringStreamsLoaded = true;
        renderRecurring();
        setRecurringStatus('couldn\u2019t load \u2014 refresh and try again.');
      });
    }
    // Phase 8.5B: rollover modal is gone. Streams auto-project forward; no
    // per-charge prompt needs to fire when the recurring tab opens.
  }

  function closeRecurring() {
    if (!recurringPop || !recurringOverlay) return;
    recurringPop.classList.remove('open');
    recurringOverlay.classList.remove('open');
    recurringPop.setAttribute('aria-hidden', 'true');
  }

  function wireRecurringBtn() {
    recurringBtn               = document.getElementById('recurring-btn');
    recurringBtnCount          = document.getElementById('recurring-btn-count');
    recurringOverlay           = document.getElementById('recurring-overlay');
    recurringPop               = document.getElementById('recurring-pop');
    recurringClose             = document.getElementById('recurring-close');
    recurringStatus            = document.getElementById('recurring-status');
    recurringSuggestionsList   = document.getElementById('recurring-suggestions-list');
    recurringSuggestionsCount  = document.getElementById('recurring-suggestions-count');
    recurringStreamsList       = document.getElementById('recurring-streams-list');
    recurringStreamsCount      = document.getElementById('recurring-streams-count');
    recurringAddBtn            = document.getElementById('recurring-add-btn');

    if (recurringBtn)     recurringBtn.addEventListener('click', openRecurring);
    if (recurringClose)   recurringClose.addEventListener('click', closeRecurring);
    if (recurringOverlay) recurringOverlay.addEventListener('click', closeRecurring);
    if (recurringAddBtn)  recurringAddBtn.addEventListener('click', openRecurringAdd);

    // If a hydrated cache exists, paint the badge up front so a returning user
    // sees the "review N" pill without waiting for the live fetch.
    updateRecurringBadge();
  }

  // ── Recurring add modal (Phase 8C) ──────────────
  // Manual entry path for streams the bridge didn't catch. POSTs to the
  // new /api/recurring/streams endpoint. On success the modal closes and
  // the recurring panel + calendar refetch so the user sees the new row +
  // its forward projection paint immediately.
  function setRecurringAddError(text) {
    if (recurringAddError) recurringAddError.textContent = text || '';
  }

  function getSelectedFreq(chipsEl) {
    if (!chipsEl) return 'monthly';
    var active = chipsEl.querySelector('.freq-chip.is-active');
    return (active && active.getAttribute('data-freq')) || 'monthly';
  }

  function setSelectedFreq(chipsEl, value) {
    if (!chipsEl) return;
    var chips = chipsEl.querySelectorAll('.freq-chip');
    var matched = false;
    chips.forEach(function (c) {
      var f = c.getAttribute('data-freq');
      var on = f === value;
      if (on) matched = true;
      c.classList.toggle('is-active', on);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    if (!matched) {
      // Default monthly if the requested value isn't in the chip set.
      chips.forEach(function (c) {
        var on = c.getAttribute('data-freq') === 'monthly';
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
  }

  function wireFreqChips(chipsEl) {
    if (!chipsEl) return;
    chipsEl.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest && ev.target.closest('.freq-chip');
      if (!btn) return;
      var f = btn.getAttribute('data-freq');
      if (!f) return;
      setSelectedFreq(chipsEl, f);
    });
  }

  function resetRecurringAddForm() {
    if (recurringAddName)   recurringAddName.value = '';
    if (recurringAddAmount) recurringAddAmount.value = '';
    if (recurringAddDate)   recurringAddDate.value = '';
    if (recurringAddEnd)    recurringAddEnd.value = '';
    setSelectedFreq(recurringAddFreqChips, 'monthly');
    setRecurringAddError('');
    if (recurringAddSubmit) {
      recurringAddSubmit.disabled = false;
      recurringAddSubmit.textContent = 'add it';
    }
  }

  function openRecurringAdd() {
    if (!recurringAddPop || !recurringAddOverlay) return;
    resetRecurringAddForm();
    // Default the date to today + 30 (sensible for monthly bills).
    if (recurringAddDate) {
      try { recurringAddDate.value = defaultNextDueIso(); } catch (_) {}
    }
    recurringAddPop.classList.add('open');
    recurringAddOverlay.classList.add('open');
    recurringAddPop.setAttribute('aria-hidden', 'false');
    if (recurringAddName) {
      try { recurringAddName.focus({ preventScroll: true }); }
      catch (_) { recurringAddName.focus(); }
    }
  }

  function closeRecurringAdd() {
    if (!recurringAddPop || !recurringAddOverlay) return;
    recurringAddPop.classList.remove('open');
    recurringAddOverlay.classList.remove('open');
    recurringAddPop.setAttribute('aria-hidden', 'true');
  }

  function postRecurringStream(body) {
    return fetch(API_BASE + '/api/recurring/streams', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401) { location.replace('/'); throw new Error('unauthed'); }
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          var err = new Error('add failed ' + res.status);
          err.userMessage = (data && data.error) || 'couldn’t add — try again.';
          throw err;
        });
      }
      return res.json();
    });
  }

  function handleRecurringAddSubmit(ev) {
    ev.preventDefault();
    setRecurringAddError('');
    var nameVal = (recurringAddName && recurringAddName.value || '').trim();
    var amtRaw  = (recurringAddAmount && recurringAddAmount.value || '').trim();
    var dateVal = (recurringAddDate && recurringAddDate.value || '').trim();
    var endVal  = (recurringAddEnd && recurringAddEnd.value || '').trim();
    var freqVal = getSelectedFreq(recurringAddFreqChips);

    if (!nameVal) { setRecurringAddError('give it a name.'); return; }
    var amtNum = parseFloat(amtRaw);
    if (!amtRaw || isNaN(amtNum) || amtNum <= 0) {
      setRecurringAddError('enter an amount above zero.'); return;
    }
    if (!dateVal) { setRecurringAddError('pick a next-charge date.'); return; }
    if (endVal && endVal < dateVal) {
      setRecurringAddError('end date must be on or after the next charge date.');
      return;
    }

    var body = {
      display_name: nameVal,
      next_due_date: dateVal,
      amount: Math.round(amtNum * 100) / 100,
      frequency: freqVal
    };
    if (endVal) body.end_date = endVal;

    if (recurringAddSubmit) {
      recurringAddSubmit.disabled = true;
      recurringAddSubmit.textContent = 'adding…';
    }

    postRecurringStream(body).then(function () {
      closeRecurringAdd();
      // Refetch streams + suggestions + invalidate calendar so the new
      // projection paints immediately.
      reloadRecurringAfterMutation([dateVal]);
    }).catch(function (e) {
      if (recurringAddSubmit) {
        recurringAddSubmit.disabled = false;
        recurringAddSubmit.textContent = 'add it';
      }
      setRecurringAddError((e && e.userMessage) || 'couldn’t add — try again.');
    });
  }

  function wireRecurringAddModal() {
    recurringAddOverlay   = document.getElementById('recurring-add-overlay');
    recurringAddPop       = document.getElementById('recurring-add-pop');
    recurringAddClose     = document.getElementById('recurring-add-close');
    recurringAddForm      = document.getElementById('recurring-add-form');
    recurringAddName      = document.getElementById('rec-add-name');
    recurringAddAmount    = document.getElementById('rec-add-amount');
    recurringAddDate      = document.getElementById('rec-add-date');
    recurringAddEnd       = document.getElementById('rec-add-end');
    recurringAddFreqChips = document.getElementById('rec-add-freq-chips');
    recurringAddError     = document.getElementById('rec-add-error');
    recurringAddSubmit    = document.getElementById('rec-add-submit');

    if (recurringAddClose)   recurringAddClose.addEventListener('click', closeRecurringAdd);
    if (recurringAddOverlay) recurringAddOverlay.addEventListener('click', closeRecurringAdd);
    if (recurringAddForm)    recurringAddForm.addEventListener('submit', handleRecurringAddSubmit);
    wireFreqChips(recurringAddFreqChips);
  }

  // ── Recurring edit modal (Phase 8C) ─────────────
  // Dedicated stream editor — replaces the old "open schedule popover from
  // a stream row" flow. Owns name/amount/next_due_date/frequency/end_date
  // + a "stop tracking this" delete affordance with inline confirm.
  function setRecurringEditError(text) {
    if (recurringEditError) recurringEditError.textContent = text || '';
  }

  function resetRecurringEditForm() {
    if (recurringEditName)   recurringEditName.value = '';
    if (recurringEditAmount) recurringEditAmount.value = '';
    if (recurringEditDate)   recurringEditDate.value = '';
    if (recurringEditEnd)    recurringEditEnd.value = '';
    setSelectedFreq(recurringEditFreqChips, 'monthly');
    setRecurringEditError('');
    if (recurringEditSubmit) {
      recurringEditSubmit.disabled = false;
      recurringEditSubmit.textContent = 'save changes';
    }
    if (recurringEditDeleteConfirm) recurringEditDeleteConfirm.hidden = true;
    if (recurringEditDelete) {
      recurringEditDelete.hidden = false;
      recurringEditDelete.disabled = false;
    }
    if (recurringEditDeleteYes) {
      recurringEditDeleteYes.disabled = false;
      recurringEditDeleteYes.textContent = 'yes';
    }
  }

  function openRecurringEdit(stream) {
    if (!recurringEditPop || !recurringEditOverlay) return;
    if (!stream) return;
    recurringEditCurrent = stream;
    resetRecurringEditForm();

    if (recurringEditName) {
      recurringEditName.value = (typeof stream.display_name === 'string'
        && stream.display_name.length > 0)
        ? stream.display_name
        : (stream.merchant || '');
    }
    if (recurringEditAmount) {
      var amt = (typeof stream.amount === 'number' && isFinite(stream.amount))
        ? stream.amount : 0;
      recurringEditAmount.value = amt > 0 ? amt.toFixed(2) : '';
    }
    if (recurringEditDate) {
      recurringEditDate.value = (typeof stream.next_due_date === 'string'
        && stream.next_due_date.length >= 10)
        ? stream.next_due_date.slice(0, 10) : '';
    }
    if (recurringEditEnd) {
      recurringEditEnd.value = (typeof stream.end_date === 'string'
        && stream.end_date.length >= 10)
        ? stream.end_date.slice(0, 10) : '';
    }
    setSelectedFreq(recurringEditFreqChips,
      (typeof stream.frequency === 'string' && stream.frequency.length > 0)
        ? stream.frequency : 'monthly');

    recurringEditPop.classList.add('open');
    recurringEditOverlay.classList.add('open');
    recurringEditPop.setAttribute('aria-hidden', 'false');
    if (recurringEditName) {
      try { recurringEditName.focus({ preventScroll: true }); }
      catch (_) { recurringEditName.focus(); }
    }
  }

  function closeRecurringEdit() {
    if (!recurringEditPop || !recurringEditOverlay) return;
    recurringEditPop.classList.remove('open');
    recurringEditOverlay.classList.remove('open');
    recurringEditPop.setAttribute('aria-hidden', 'true');
    recurringEditCurrent = null;
  }

  function handleRecurringEditSubmit(ev) {
    ev.preventDefault();
    if (!recurringEditCurrent) return;
    setRecurringEditError('');
    var merchant = recurringEditCurrent.merchant;
    var nameVal = (recurringEditName && recurringEditName.value || '').trim();
    var amtRaw  = (recurringEditAmount && recurringEditAmount.value || '').trim();
    var dateVal = (recurringEditDate && recurringEditDate.value || '').trim();
    var endRaw  = (recurringEditEnd && recurringEditEnd.value || '');
    var endVal  = endRaw.trim();
    var freqVal = getSelectedFreq(recurringEditFreqChips);

    if (!nameVal) { setRecurringEditError('give it a name.'); return; }
    var amtNum = parseFloat(amtRaw);
    if (!amtRaw || isNaN(amtNum) || amtNum <= 0) {
      setRecurringEditError('enter an amount above zero.'); return;
    }
    if (!dateVal) { setRecurringEditError('pick a next-charge date.'); return; }
    if (endVal && endVal < dateVal) {
      setRecurringEditError('end date must be on or after the next charge date.');
      return;
    }

    // PATCH semantics: undefined means "don't change". For end_date the
    // user clearing the field means "clear it server-side" — we send null.
    // Always send the four other editable fields so the cache stays
    // canonical even if the user only changed one.
    var body = {
      display_name: nameVal,
      amount: Math.round(amtNum * 100) / 100,
      next_due_date: dateVal,
      frequency: freqVal,
      end_date: endVal ? endVal : null
    };

    if (recurringEditSubmit) {
      recurringEditSubmit.disabled = true;
      recurringEditSubmit.textContent = 'saving…';
    }

    patchRecurringStream(merchant, body).then(function () {
      closeRecurringEdit();
    }).catch(function (e) {
      if (recurringEditSubmit) {
        recurringEditSubmit.disabled = false;
        recurringEditSubmit.textContent = 'save changes';
      }
      setRecurringEditError((e && e.userMessage) || 'couldn’t save — try again.');
    });
  }

  function showRecurringEditDeleteConfirm() {
    if (recurringEditDelete) recurringEditDelete.hidden = true;
    if (recurringEditDeleteConfirm) recurringEditDeleteConfirm.hidden = false;
  }

  function hideRecurringEditDeleteConfirm() {
    if (recurringEditDelete) recurringEditDelete.hidden = false;
    if (recurringEditDeleteConfirm) recurringEditDeleteConfirm.hidden = true;
  }

  function handleRecurringEditDelete() {
    if (!recurringEditCurrent) return;
    var merchant = recurringEditCurrent.merchant;
    if (recurringEditDeleteYes) {
      recurringEditDeleteYes.disabled = true;
      recurringEditDeleteYes.textContent = 'removing…';
    }
    setRecurringEditError('');
    deleteRecurringStream(merchant).then(function () {
      closeRecurringEdit();
    }).catch(function (e) {
      if (recurringEditDeleteYes) {
        recurringEditDeleteYes.disabled = false;
        recurringEditDeleteYes.textContent = 'yes';
      }
      setRecurringEditError((e && e.userMessage) || 'couldn’t remove — try again.');
    });
  }

  function wireRecurringEditModal() {
    recurringEditOverlay      = document.getElementById('recurring-edit-overlay');
    recurringEditPop          = document.getElementById('recurring-edit-pop');
    recurringEditClose        = document.getElementById('recurring-edit-close');
    recurringEditForm         = document.getElementById('recurring-edit-form-modal');
    recurringEditName         = document.getElementById('rec-edit-name');
    recurringEditAmount       = document.getElementById('rec-edit-amount');
    recurringEditDate         = document.getElementById('rec-edit-date');
    recurringEditEnd          = document.getElementById('rec-edit-end');
    recurringEditFreqChips    = document.getElementById('rec-edit-freq-chips');
    recurringEditError        = document.getElementById('rec-edit-error');
    recurringEditSubmit       = document.getElementById('rec-edit-submit');
    recurringEditDelete       = document.getElementById('rec-edit-delete');
    recurringEditDeleteConfirm= document.getElementById('rec-edit-delete-confirm');
    recurringEditDeleteYes    = document.getElementById('rec-edit-delete-yes');
    recurringEditDeleteCancel = document.getElementById('rec-edit-delete-cancel');

    if (recurringEditClose)        recurringEditClose.addEventListener('click', closeRecurringEdit);
    if (recurringEditOverlay)      recurringEditOverlay.addEventListener('click', closeRecurringEdit);
    if (recurringEditForm)         recurringEditForm.addEventListener('submit', handleRecurringEditSubmit);
    if (recurringEditDelete)       recurringEditDelete.addEventListener('click', showRecurringEditDeleteConfirm);
    if (recurringEditDeleteCancel) recurringEditDeleteCancel.addEventListener('click', hideRecurringEditDeleteConfirm);
    if (recurringEditDeleteYes)    recurringEditDeleteYes.addEventListener('click', handleRecurringEditDelete);
    wireFreqChips(recurringEditFreqChips);
  }


  // ── Wallet popup ────────────────────────────────
  // Reads /api/wallet for { plaid_accounts, tracked_accounts, summary }.
  // Linked rows are read-only (mirror balances). Tracked rows can be
  // created (POST /api/tracked-accounts) and deleted (DELETE /api/tracked-
  // accounts/:id). Cache lifecycle:
  //   • Hydrated from localStorage on boot for instant paint.
  //   • Prefetched in boot() (after gateAuth) so the balances running-balance
  //     hero can include tracked totals before the user ever opens this panel.
  //   • Fetched again on first open if the prefetch failed.
  //   • Evicted on every successful tracked-account mutation.
  var WALLET_CURRENCIES = ['USD','EUR','GBP','JPY','CAD','AUD','CHF','SEK','NOK','DKK','NZD'];

  function persistWalletCache() {
    if (walletCache && typeof walletCache === 'object') {
      cacheWrite('wallet', walletCache);
    }
  }

  // Reuse the same balance-picking heuristics the balances panel uses, so a
  // linked Plaid account renders the same number in both places.
  function walletLinkedAmount(acct) {
    var t = (acct && acct.account_type || '').toLowerCase();
    if (t === 'depository') {
      if (typeof acct.balance_available === 'number') return acct.balance_available;
      if (typeof acct.balance_current   === 'number') return acct.balance_current;
      return null;
    }
    if (typeof acct.balance_current === 'number') return acct.balance_current;
    if (typeof acct.balance_available === 'number') return acct.balance_available;
    return null;
  }

  function walletLinkedRowClass(type) {
    var t = (type || '').toLowerCase();
    if (t === 'credit')     return 'is-credit';
    if (t === 'depository') return 'is-depository';
    return '';
  }

  function fetchWalletOnce(opts) {
    opts = opts || {};
    if (walletCache && walletCache._fresh && !opts.force) {
      return Promise.resolve(walletCache);
    }
    if (walletFetchInflight) return walletFetchInflight;
    walletFetchInflight = fetch(API_BASE + '/api/wallet', {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      if (res.status === 401) {
        // gateAuth handles redirect — return an empty shell so callers can
        // render an empty-state without crashing.
        return { plaid_accounts: [], tracked_accounts: [], summary: null };
      }
      if (!res.ok) throw new Error('wallet fetch failed ' + res.status);
      return res.json();
    }).then(function (data) {
      var payload = {
        plaid_accounts:    (data && Array.isArray(data.plaid_accounts))    ? data.plaid_accounts    : [],
        tracked_accounts:  (data && Array.isArray(data.tracked_accounts))  ? data.tracked_accounts  : [],
        summary:           (data && data.summary) ? data.summary : null
      };
      walletCache = payload;
      try { Object.defineProperty(walletCache, '_fresh', { value: true, enumerable: false, configurable: true }); }
      catch (_) { walletCache._fresh = true; }
      persistWalletCache();
      walletFetchInflight = null;
      return walletCache;
    }).catch(function (err) {
      walletFetchInflight = null;
      try { console.warn('[home] wallet fetch error:', err); } catch (_) {}
      throw err;
    });
    return walletFetchInflight;
  }

  function setWalletStatus(text) {
    if (walletStatus) walletStatus.textContent = text || '';
  }
  function setWalletError(text) {
    if (walletAddError) walletAddError.textContent = text || '';
  }

  // Render the small "running balance: $X" line at the top of the wallet
  // panel. Source-of-truth for this number is summary.running_balance_usd
  // from /api/wallet. Backend computes: depository - cc_owed - tracked +
  // scheduled deltas. We don't recompute on the frontend — keeps wallet's
  // top line and the balances hero math aligned with each other.
  function renderWalletRunning() {
    if (!walletRunning) return;
    var summary = walletCache && walletCache.summary;
    if (!summary || typeof summary.running_balance_usd !== 'number') {
      walletRunning.textContent = '';
      return;
    }
    var n = summary.running_balance_usd;
    var sign = n < 0 ? '-' : '';
    var abs  = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    walletRunning.innerHTML = 'running balance: <strong>' + sign + '$' + abs + '</strong>';
  }

  function buildWalletLinkedRow(acct) {
    var row = document.createElement('div');
    row.className = 'wallet-linked-row ' + walletLinkedRowClass(acct.account_type);

    var label = document.createElement('div');
    label.className = 'wallet-linked-row__label';
    var inst = acct.institution || 'account';
    var mask = acct.mask ? ' \u00b7\u00b7\u00b7' + acct.mask : '';
    label.textContent = inst + mask;
    row.appendChild(label);

    var amt = document.createElement('div');
    amt.className = 'wallet-linked-row__amt';
    var bal = walletLinkedAmount(acct);
    if (bal === null) {
      amt.textContent = '\u2014';
    } else {
      // Mirror balances-panel convention: credit balances show as positive
      // "amount owed" (Plaid: positive number = debt).
      var t = (acct.account_type || '').toLowerCase();
      var n = (t === 'credit') ? Math.abs(bal) : bal;
      amt.textContent = money(n);
    }
    row.appendChild(amt);
    return row;
  }

  // Format a currency amount with the right glyph for common cases. Falls
  // back to "<code> <amount>" for unfamiliar codes so we never show garbage.
  function formatTrackedBalance(amount, currency) {
    var n = Number(amount);
    if (!isFinite(n)) return '\u2014';
    var c = (currency || 'USD').toUpperCase();
    var glyphs = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5' };
    var formatted = n.toFixed(c === 'JPY' ? 0 : 2)
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (glyphs[c]) return glyphs[c] + formatted;
    return c + ' ' + formatted;
  }

  // Lightweight YYYY-MM-DD → "apr 30" formatter. Avoids new Date()'s timezone
  // surprises on date-only strings (which can flip the day in PT).
  function formatDueDate(s) {
    if (!s || typeof s !== 'string') return '';
    var parts = s.split('-');
    if (parts.length !== 3) return '';
    var m = Number(parts[1]) - 1;
    var d = Number(parts[2]);
    if (m < 0 || m > 11 || !d) return '';
    return MONTHS[m].slice(0, 3) + ' ' + d;
  }

  function buildWalletTrackedConfirmRow(labelText) {
    var confirmRow = document.createElement('div');
    confirmRow.className = 'wallet-tracked-row__confirm';

    var label = document.createElement('span');
    label.className = 'wallet-tracked-row__confirm-label';
    label.textContent = labelText;
    confirmRow.appendChild(label);

    var sep1 = document.createElement('span');
    sep1.className = 'wallet-tracked-row__confirm-sep';
    sep1.textContent = '\u00b7';
    confirmRow.appendChild(sep1);

    var yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'wallet-tracked-row__confirm-yes';
    yesBtn.textContent = 'yes';
    confirmRow.appendChild(yesBtn);

    var sep2 = document.createElement('span');
    sep2.className = 'wallet-tracked-row__confirm-sep';
    sep2.textContent = '\u00b7';
    confirmRow.appendChild(sep2);

    var noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'wallet-tracked-row__confirm-no';
    noBtn.textContent = 'cancel';
    confirmRow.appendChild(noBtn);

    return { node: confirmRow, label: label, yes: yesBtn, no: noBtn, sep2: sep2 };
  }

  function buildWalletTrackedRow(item) {
    var row = document.createElement('div');
    var kind = (item && item.kind) || 'debit';
    row.className = 'wallet-tracked-row is-' + (kind === 'credit' ? 'credit' : 'debit');
    row.setAttribute('data-id', String(item.id));

    var main = document.createElement('div');
    main.className = 'wallet-tracked-row__main';

    var line = document.createElement('div');
    line.className = 'wallet-tracked-row__line';

    var name = document.createElement('span');
    name.className = 'wallet-tracked-row__name';
    name.textContent = item.name || '';
    line.appendChild(name);

    var chip = document.createElement('span');
    chip.className = 'kind-chip ' + (kind === 'credit' ? 'is-credit' : 'is-debit');
    chip.textContent = kind;
    line.appendChild(chip);
    main.appendChild(line);

    if (item.due_date) {
      var due = document.createElement('span');
      due.className = 'wallet-tracked-row__due';
      due.textContent = 'due ' + (formatDueDate(item.due_date) || item.due_date);
      main.appendChild(due);
    }
    row.appendChild(main);

    var right = document.createElement('div');
    right.className = 'wallet-tracked-row__right';

    var amt = document.createElement('div');
    amt.className = 'wallet-tracked-row__amt';
    var native = document.createElement('span');
    native.textContent = formatTrackedBalance(item.balance, item.currency || 'USD');
    amt.appendChild(native);
    var cur = (item.currency || 'USD').toUpperCase();
    if (cur !== 'USD' && typeof item.balance_usd === 'number' && isFinite(item.balance_usd)) {
      var usd = document.createElement('span');
      usd.className = 'wallet-tracked-row__amt-usd';
      usd.textContent = '\u2248 ' + money(item.balance_usd) + ' usd';
      amt.appendChild(usd);
    }
    right.appendChild(amt);

    var trash = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    trash.setAttribute('class', 'wallet-tracked-row__trash');
    trash.setAttribute('viewBox', '0 0 16 16');
    trash.setAttribute('fill', 'none');
    trash.setAttribute('stroke', 'currentColor');
    trash.setAttribute('stroke-width', '1.4');
    trash.setAttribute('stroke-linecap', 'round');
    trash.setAttribute('stroke-linejoin', 'round');
    trash.setAttribute('role', 'button');
    trash.setAttribute('tabindex', '0');
    trash.setAttribute('aria-label', 'delete ' + (item.name || 'tracked card'));
    var trashPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    trashPath.setAttribute('d', 'M3 4h10M6 4V2.8h4V4M5 4v9h6V4M7.5 6.5v4M9 6.5v4');
    trash.appendChild(trashPath);
    right.appendChild(trash);

    row.appendChild(right);

    var openDeleteConfirm = function (ev) {
      ev.stopPropagation();
      if (row.querySelector('.wallet-tracked-row__confirm')) return;
      // Hide the whole right cluster so the inline confirm gets the room.
      right.style.display = 'none';

      var c = buildWalletTrackedConfirmRow('delete?');
      row.appendChild(c.node);

      var restore = function () {
        if (c.node.parentNode) c.node.parentNode.removeChild(c.node);
        right.style.display = '';
      };
      c.node._walletCancel = restore;
      try { c.yes.focus({ preventScroll: true }); } catch (_) { c.yes.focus(); }

      c.no.addEventListener('click', function (cev) {
        cev.stopPropagation();
        restore();
      });
      c.yes.addEventListener('click', function (cev) {
        cev.stopPropagation();
        c.yes.disabled = true;
        c.no.disabled  = true;
        c.label.textContent = 'deleting\u2026';
        deleteTrackedAccount(item).catch(function () {
          c.label.textContent = 'couldn\u2019t delete \u00b7 cancel';
          c.yes.style.display = 'none';
          c.sep2.style.display = 'none';
          c.no.disabled = false;
        });
      });
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

  function renderWallet() {
    if (!walletLinkedList || !walletTrackedList) return;
    walletLinkedList.innerHTML = '';
    walletTrackedList.innerHTML = '';

    var linked  = (walletCache && Array.isArray(walletCache.plaid_accounts))
      ? walletCache.plaid_accounts : [];
    var tracked = (walletCache && Array.isArray(walletCache.tracked_accounts))
      ? walletCache.tracked_accounts : [];

    if (linked.length) {
      if (walletLinkedGroup) walletLinkedGroup.hidden = false;
      linked.forEach(function (a) {
        walletLinkedList.appendChild(buildWalletLinkedRow(a));
      });
    } else if (walletLinkedGroup) {
      walletLinkedGroup.hidden = true;
    }

    if (tracked.length) {
      if (walletTrackedGroup) walletTrackedGroup.hidden = false;
      tracked.forEach(function (it) {
        walletTrackedList.appendChild(buildWalletTrackedRow(it));
      });
    } else if (walletTrackedGroup) {
      walletTrackedGroup.hidden = true;
    }

    renderWalletRunning();
  }

  // POST /api/tracked-accounts. Validates inline, prepends on success, evicts
  // the cache + refetches so summary.running_balance_usd updates and the
  // balances hero (next time it renders) reflects the new total.
  function addTrackedAccount(form) {
    setWalletError('');
    var name = (walletAddName && walletAddName.value || '').trim();
    var balanceRaw = (walletAddBalance && walletAddBalance.value || '').trim();
    var balanceNum = parseFloat(balanceRaw);
    var currency  = (walletAddCurrency && walletAddCurrency.value || 'USD').toUpperCase();
    var dueDate   = (walletAddDate && walletAddDate.value || '').trim();
    var kind      = walletAddKind === 'credit' ? 'credit' : 'debit';

    if (!name) {
      setWalletError('give it a name.');
      return;
    }
    if (name.length > 80) {
      setWalletError('name is too long (max 80).');
      return;
    }
    if (!balanceRaw || isNaN(balanceNum)) {
      setWalletError('enter a balance.');
      return;
    }
    if (WALLET_CURRENCIES.indexOf(currency) === -1) {
      setWalletError('pick a supported currency.');
      return;
    }

    var body = {
      name: name,
      kind: kind,
      balance: Math.round(balanceNum * 100) / 100,
      currency: currency
    };
    if (dueDate) body.due_date = dueDate;

    if (walletAddSubmit) {
      walletAddSubmit.disabled = true;
      walletAddSubmit.textContent = 'tracking\u2026';
    }

    fetch(API_BASE + '/api/tracked-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (out) {
      if (!out.ok || !out.data || !out.data.item) {
        var msg = (out.data && (out.data.error || out.data.message)) ||
                  ('couldn\u2019t track (' + out.status + ').');
        setWalletError(msg);
        if (walletAddSubmit) {
          walletAddSubmit.disabled = false;
          walletAddSubmit.textContent = '+ track it';
        }
        return;
      }
      // Optimistically prepend so the panel updates immediately. Then evict
      // + refetch so summary.running_balance_usd is canonical.
      var item = out.data.item;
      if (!walletCache || typeof walletCache !== 'object') {
        walletCache = { plaid_accounts: [], tracked_accounts: [], summary: null };
      }
      var existing = Array.isArray(walletCache.tracked_accounts)
        ? walletCache.tracked_accounts : [];
      walletCache.tracked_accounts = [item].concat(existing);
      try { Object.defineProperty(walletCache, '_fresh', { value: true, enumerable: false, configurable: true }); }
      catch (_) { walletCache._fresh = true; }
      persistWalletCache();
      renderWallet();

      if (form && typeof form.reset === 'function') form.reset();
      if (walletAddCurrency) walletAddCurrency.value = 'USD';
      setWalletAddKind('credit');
      if (walletAddSubmit) {
        walletAddSubmit.disabled = false;
        walletAddSubmit.textContent = '+ track it';
      }

      // Refetch to pull canonical summary (running_balance_usd, balance_usd
      // for the new item, etc.). The optimistic item missing balance_usd just
      // means we render native-only until the refetch lands.
      walletCache._fresh = false;
      fetchWalletOnce({ force: true }).then(function () {
        renderWallet();
        // Wallet's tracked totals affect the balances running-balance hero —
        // repaint balances if it has data so the hero reflects the new card.
        if (balancesCache) renderBalances(balancesCache);
      }).catch(function () { /* keep optimistic state */ });
    }).catch(function (err) {
      setWalletError('network error \u2014 try again.');
      if (walletAddSubmit) {
        walletAddSubmit.disabled = false;
        walletAddSubmit.textContent = '+ track it';
      }
      try { console.warn('[home] tracked-account add error:', err); } catch (_) {}
    });
  }

  function deleteTrackedAccount(item) {
    if (!item || item.id == null) return Promise.resolve(false);
    setWalletError('');
    return fetch(API_BASE + '/api/tracked-accounts/' + encodeURIComponent(item.id), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (out) {
      if (!out.ok && out.status !== 404) {
        var msg = (out.data && (out.data.error || out.data.message)) ||
                  ('couldn\u2019t delete (' + out.status + ').');
        setWalletError(msg);
        throw new Error(msg);
      }
      // Drop the row locally + re-render. Then refetch for fresh summary.
      if (walletCache && Array.isArray(walletCache.tracked_accounts)) {
        walletCache.tracked_accounts = walletCache.tracked_accounts.filter(function (x) {
          return x.id !== item.id;
        });
        try { Object.defineProperty(walletCache, '_fresh', { value: false, enumerable: false, configurable: true }); }
        catch (_) { walletCache._fresh = false; }
        persistWalletCache();
        renderWallet();
      }
      fetchWalletOnce({ force: true }).then(function () {
        renderWallet();
        if (balancesCache) renderBalances(balancesCache);
      }).catch(function () { /* leave local state */ });
      return true;
    }).catch(function (err) {
      if (err && err.message && walletAddError && !walletAddError.textContent) {
        setWalletError('network error \u2014 try again.');
      }
      try { console.warn('[home] tracked-account delete error:', err); } catch (_) {}
      throw err;
    });
  }

  function setWalletAddKind(kind) {
    walletAddKind = kind === 'credit' ? 'credit' : 'debit';
    if (!walletAddKindChips) return;
    var chips = walletAddKindChips.querySelectorAll('.type-chip');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-kind') === walletAddKind;
      chips[i].classList.toggle('is-active', on);
      chips[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  // Dismiss any open inline-confirm rows in the wallet panel — wired into
  // the global ESC handler so the user can always back out.
  function dismissOpenWalletConfirms() {
    if (!walletTrackedList) return false;
    var confirms = walletTrackedList.querySelectorAll('.wallet-tracked-row__confirm');
    if (!confirms.length) return false;
    Array.prototype.forEach.call(confirms, function (n) {
      if (typeof n._walletCancel === 'function') n._walletCancel();
    });
    return true;
  }

  function openWallet() {
    if (!walletPop || !walletOverlay) return;
    walletPop.classList.add('open');
    walletOverlay.classList.add('open');
    walletPop.setAttribute('aria-hidden', 'false');
    setWalletError('');
    // Re-sync the kind-chip cluster to the current state on every open so the
    // visual matches walletAddKind (default 'credit') even after a prior open
    // mutated state without submitting.
    setWalletAddKind(walletAddKind);

    // Always paint whatever cache we have first (could be hydrated from
    // localStorage, could be the boot prefetch, could be null).
    if (walletCache && typeof walletCache === 'object') {
      setWalletStatus('');
      renderWallet();
    }

    if (walletCache && walletCache._fresh) {
      if (walletAddName) {
        try { walletAddName.focus({ preventScroll: true }); } catch (_) { walletAddName.focus(); }
      }
      return;
    }
    if (!walletCache) setWalletStatus('loading\u2026');

    fetchWalletOnce().then(function () {
      setWalletStatus('');
      renderWallet();
    }).catch(function () {
      setWalletStatus('couldn\u2019t load \u2014 refresh and try again.');
    });

    if (walletAddName) {
      try { walletAddName.focus({ preventScroll: true }); } catch (_) { walletAddName.focus(); }
    }
  }

  function closeWallet() {
    if (!walletPop || !walletOverlay) return;
    walletPop.classList.remove('open');
    walletOverlay.classList.remove('open');
    walletPop.setAttribute('aria-hidden', 'true');
    setWalletError('');
  }

  function wireWalletBtn() {
    walletBtn          = document.getElementById('wallet-btn');
    walletOverlay      = document.getElementById('wallet-overlay');
    walletPop          = document.getElementById('wallet-pop');
    walletClose        = document.getElementById('wallet-close');
    walletRunning      = document.getElementById('wallet-running');
    walletStatus       = document.getElementById('wallet-status');
    walletLinkedGroup  = document.getElementById('wallet-linked-group');
    walletLinkedList   = document.getElementById('wallet-linked-list');
    walletTrackedGroup = document.getElementById('wallet-tracked-group');
    walletTrackedList  = document.getElementById('wallet-tracked-list');
    walletAddForm      = document.getElementById('wallet-add-form');
    walletAddName      = document.getElementById('wt-name');
    walletAddBalance   = document.getElementById('wt-balance');
    walletAddCurrency  = document.getElementById('wt-currency');
    walletAddDate      = document.getElementById('wt-date');
    walletAddKindChips = document.getElementById('wt-kind-chips');
    walletAddSubmit    = document.getElementById('wt-submit');
    walletAddError     = document.getElementById('wt-error');

    if (walletBtn)     walletBtn.addEventListener('click', openWallet);
    if (walletClose)   walletClose.addEventListener('click', closeWallet);
    if (walletOverlay) walletOverlay.addEventListener('click', closeWallet);
    if (walletAddForm) {
      walletAddForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        addTrackedAccount(walletAddForm);
      });
    }
    if (walletAddKindChips) {
      walletAddKindChips.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest && ev.target.closest('.type-chip');
        if (!btn || !walletAddKindChips.contains(btn)) return;
        var kind = btn.getAttribute('data-kind');
        if (!kind) return;
        setWalletAddKind(kind);
      });
    }
  }

  // ── Snapshot popup ──────────────────────────────
  // Copy-pasteable Markdown brief — the user opens the modal, the text
  // auto-fills from /api/snapshot, they hit "copy", paste into ChatGPT /
  // Claude / Gemini, and ask a money question. Replaces the SMS bot.
  // The textarea is re-fetched on every open (the data is point-in-time
  // and a cached paste would mislead the LLM).
  function setSnapshotStatus(text) {
    if (snapshotStatus) snapshotStatus.textContent = text || '';
  }

  function fetchSnapshot() {
    return fetch(API_BASE + '/api/snapshot', {
      credentials: 'include'
    }).then(function (res) {
      if (res.status === 401) { location.replace('/'); throw new Error('unauthed'); }
      if (!res.ok) throw new Error('snapshot fetch failed: ' + res.status);
      return res.json();
    });
  }

  function openSnapshot() {
    if (!snapshotPop || !snapshotOverlay) return;
    snapshotPop.classList.add('open');
    snapshotOverlay.classList.add('open');
    snapshotPop.setAttribute('aria-hidden', 'false');

    // Reset any prior "copied!" pulse on the button so a re-open doesn't
    // start in the success state.
    if (snapshotCopiedTimer) {
      clearTimeout(snapshotCopiedTimer);
      snapshotCopiedTimer = null;
    }
    if (snapshotCopy) {
      snapshotCopy.classList.remove('is-copied');
      snapshotCopy.textContent = '📋 copy';
      snapshotCopy.disabled = true;
    }
    if (snapshotTextarea) snapshotTextarea.value = '';
    setSnapshotStatus('loading…');

    fetchSnapshot().then(function (payload) {
      var md = payload && typeof payload.snapshot === 'string'
        ? payload.snapshot
        : '';
      if (snapshotTextarea) snapshotTextarea.value = md;
      setSnapshotStatus('');
      if (snapshotCopy) snapshotCopy.disabled = !md;
    }).catch(function () {
      setSnapshotStatus('couldn’t load — refresh and try again.');
      if (snapshotCopy) snapshotCopy.disabled = true;
    });
  }

  function closeSnapshot() {
    if (!snapshotPop || !snapshotOverlay) return;
    snapshotPop.classList.remove('open');
    snapshotOverlay.classList.remove('open');
    snapshotPop.setAttribute('aria-hidden', 'true');
    setSnapshotStatus('');
  }

  function copySnapshotToClipboard() {
    if (!snapshotTextarea || !snapshotCopy) return;
    var text = snapshotTextarea.value || '';
    if (!text) return;

    function flashCopied() {
      snapshotCopy.classList.add('is-copied');
      snapshotCopy.textContent = '✓ copied!';
      if (snapshotCopiedTimer) clearTimeout(snapshotCopiedTimer);
      snapshotCopiedTimer = setTimeout(function () {
        snapshotCopy.classList.remove('is-copied');
        snapshotCopy.textContent = '📋 copy';
        snapshotCopiedTimer = null;
      }, 1800);
    }

    // Modern Async Clipboard API — only available on https / localhost.
    // Fall back to the textarea-select trick if clipboard isn't writable.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flashCopied).catch(function () {
        try {
          snapshotTextarea.focus();
          snapshotTextarea.select();
          var ok = document.execCommand && document.execCommand('copy');
          if (ok) flashCopied();
          else setSnapshotStatus('select + copy manually if your browser blocks clipboard.');
        } catch (_) {
          setSnapshotStatus('select + copy manually if your browser blocks clipboard.');
        }
      });
    } else {
      try {
        snapshotTextarea.focus();
        snapshotTextarea.select();
        var ok = document.execCommand && document.execCommand('copy');
        if (ok) flashCopied();
        else setSnapshotStatus('select + copy manually if your browser blocks clipboard.');
      } catch (_) {
        setSnapshotStatus('select + copy manually if your browser blocks clipboard.');
      }
    }
  }

  function wireSnapshotBtn() {
    snapshotBtn       = document.getElementById('snapshot-btn');
    snapshotOverlay   = document.getElementById('snapshot-overlay');
    snapshotPop       = document.getElementById('snapshot-pop');
    snapshotClose     = document.getElementById('snapshot-close');
    snapshotTextarea  = document.getElementById('snapshot-textarea');
    snapshotCopy      = document.getElementById('snapshot-copy');
    snapshotStatus    = document.getElementById('snapshot-status');

    if (snapshotBtn)     snapshotBtn.addEventListener('click', openSnapshot);
    if (snapshotClose)   snapshotClose.addEventListener('click', closeSnapshot);
    if (snapshotOverlay) snapshotOverlay.addEventListener('click', closeSnapshot);
    if (snapshotCopy)    snapshotCopy.addEventListener('click', copySnapshotToClipboard);
    // The 3 LLM links are <a target="_blank"> — no JS needed; the browser
    // opens each chat home in a new tab and the user pastes after copy.
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
    wireTodoBtn();
    wireRecurringBtn();
    wireRecurringAddModal();
    wireRecurringEditModal();
    wireWalletBtn();
    wireSnapshotBtn();
    // Reimbursements + wallet are SWR — hydrate their in-memory caches from
    // localStorage so the panels paint instantly when opened. Calendar +
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
      // Phase 8.5B: rollover modal removed; no per-charge prompt fires after
      // auth. Streams auto-project forward and the user controls end_date
      // from the recurring tab.
      // Prefetch recurring suggestions in the background so the chip badge
      // shows the right "review N" count before the user opens the panel.
      try { fetchRecurringSuggestionsOnce({ force: true }).catch(function () {}); } catch (_) {}
      // Fetch the calendar window first — its handler triggers a debounced
      // Plaid sync server-side that may update account balances. Once that
      // promise resolves the sync has either completed or hit its 8s timeout,
      // and the cache-evict in fetchCalendarRange() ensures the balances
      // prefetch below sees fresh data instead of a pre-sync snapshot.
      startLoading();
      var calendarP = fetchInitialWindow();
      settle(calendarP, endLoading);
      return calendarP.then(function () {
        // Prefetch balances + wallet in parallel. Wallet powers the running-
        // balance hero in the balances panel (it adds tracked-card totals via
        // summary.total_tracked_usd), so we want it ready before renderBalances
        // runs. Both are independent fetches; either failing leaves the other
        // path intact.
        if (typeof fetchBalancesOnce === 'function') {
          startLoading();
          var walletP = fetchWalletOnce({ force: true }).then(function () {
            // If the wallet panel is already open (unlikely on boot) repaint it.
            if (walletPop && walletPop.classList.contains('open')) renderWallet();
          }).catch(function () { /* silent — balances hero just falls back to plaid-only */ });
          var balancesP = fetchBalancesOnce().then(function (payload) {
            // Wait on the wallet prefetch so renderBalances picks up tracked
            // totals on the very first paint. Race resolved by Promise.all
            // resolving once both settle (or one rejects — wallet rejection
            // already swallowed above so this Promise.all only rejects on
            // balances).
            return Promise.all([walletP]).then(function () {
              if (payload) renderBalances(payload);
            });
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

  // Test hook: expose pure-math helpers for the day-popover running-balance
  // logic so vitest + Playwright can verify the projection without driving
  // the full UI. Read-only; mutating these has no effect on home.js state.
  // Safe to reference even when the page is mid-boot (helpers don't touch
  // the DOM). Only mounted in browser-with-window contexts.
  if (typeof window !== 'undefined') {
    window.__homeDayMath = {
      computeTodayBaseBalance: computeTodayBaseBalance,
      computeDayProjection: computeDayProjection,
      formatSignedMoney: formatSignedMoney,
      // Test-only setters so unit tests can inject fixtures without
      // standing up the live caches.
      __setWalletCacheForTest: function (next) { walletCache = next; },
      __setBalancesCacheForTest: function (next) { balancesCache = next; },
      __setPrecommitsForTest: function (next) {
        PRECOMMITS = Array.isArray(next) ? next.slice() : [];
      },
      __setTodayForTest: function (next) {
        if (next instanceof Date) {
          today = new Date(next.getTime());
          today.setHours(0, 0, 0, 0);
        }
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
