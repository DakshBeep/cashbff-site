// home.js — auth-gated calendar-month view backed by /api/calendar.
//
// This is the post-login landing page. It:
//   1. Calls GET /api/me to gate the page. 401 => redirect to "/".
//   2. Populates the top-right chip as "···NNNN signed in" using the last 4
//      digits of the returned phone number.
//   3. Wires the sign-out link to POST /api/logout + redirect.
//   4. Fetches real expenses from GET /api/calendar?from=&to=. On boot the
//      calendar + balances are first hydrated from localStorage (SWR) so the
//      page paints instantly with last-known data, then silently refreshes.
//      Renders them in a calendar-month grid with pills colored by type, a
//      click-to-open day drawer, and month nav.
//   5. Wires the floating "+ add account" button to the existing add-account
//      modal via window.CashBFFAddAccount.open().
//
// Keep inline JS out of home.html — CSP blocks inline scripts. Everything
// executable lives here or in add-account.js / sentry-init.js.
(function () {
  'use strict';

  var API_BASE = 'https://api.cashbff.com';

  // ── Tiny SWR cache module ────────────────────────
  // Versioned localStorage shim. Lets us hydrate the calendar + balances from
  // last-known data on boot so the page paints instantly, then silently
  // refreshes from the live API. Bump STORAGE_PREFIX to invalidate old keys.
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

  // Expenses for the logged-in user. Empty by default; populated from
  // localStorage on boot via hydrateFromCache(), then merged with fresh
  // data from GET /api/calendar.
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

  // ── SWR hydration ────────────────────────────────
  // Read last-known calendar + balances from localStorage and seed the
  // in-memory state so the page paints instantly on boot. Live fetches kick
  // off afterward and overwrite this with fresh data. Safe to call before
  // wireCalendar() — renderGrid() no-ops if grid isn't bound yet.
  function hydrateFromCache() {
    var cachedExpenses = cacheRead('calendar_expenses');
    if (Array.isArray(cachedExpenses) && cachedExpenses.length) {
      // Trust the cache as the canonical starting set — last write wrote the
      // full PRECOMMITS, so we can replace wholesale rather than merge.
      PRECOMMITS = cachedExpenses;
    }
    var cachedBalances = cacheRead('balances');
    if (cachedBalances && Array.isArray(cachedBalances.accounts)) {
      balancesCache = cachedBalances;
      // Recompute the running balance baseline so the day-popover projection
      // works immediately on cached data, before /api/balances returns.
      var depTotal = 0, ccTotal = 0;
      cachedBalances.accounts.forEach(function (a) {
        var t = (a.account_type || '').toLowerCase();
        var b = balanceForRow(a);
        if (b === null || !isFinite(b)) return;
        if (t === 'depository') depTotal += b;
        else if (t === 'credit') ccTotal += b;
      });
      currentRunningBalance = depTotal - ccTotal;
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
      mergeExpenses(data.expenses || []);
      renderGrid();
      // Persist the full PRECOMMITS array (not just this batch) so the cache
      // stays canonical across months. Other-month entries from prior fetches
      // would be lost if we only stored the incoming batch.
      cacheWrite('calendar_expenses', PRECOMMITS);
      // /api/calendar may have triggered an on-demand Plaid sync server-side
      // (debounced 5min). If it did, balances may have changed too — evict
      // the cache so the next balances open refetches fresh data instead of
      // returning a stale pre-sync snapshot.
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

    // ── Projected running balance for today + future days ───────────
    // Only computed when (1) we have a baseline running balance from
    // /api/balances and (2) the clicked day is today or later. Past days
    // intentionally skip the projection — keeping notes intact but no math.
    if (drawerProjected) {
      drawerProjected.innerHTML = '';
      var isPastDay = d.getTime() < today.getTime();
      if (!isPastDay && currentRunningBalance !== null) {
        // Sum every SCHEDULED item between today and this day (inclusive).
        // Plaid items are already reflected in the running balance baseline
        // (settled = in balance_current; pending = in balance_available),
        // so they're skipped here to avoid double-counting.
        var deltaOut = 0;
        var deltaIn = 0;
        var fromKey = iso(today);
        var toKey = iso(d);
        PRECOMMITS.forEach(function (e) {
          if (e.source !== 'scheduled') return;
          if (e.date < fromKey || e.date > toKey) return;
          if (e.type === 'income') deltaIn  += Number(e.amount) || 0;
          else                     deltaOut += Number(e.amount) || 0;
        });
        // Only render the line if there's something scheduled in this window
        // — otherwise today/future days look noisy with redundant projections.
        if (deltaOut > 0 || deltaIn > 0) {
          var projected = currentRunningBalance + deltaIn - deltaOut;
          var sign = projected < 0 ? '-' : '';
          var abs  = Math.abs(projected).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          var label = sameYMD(d, today) ? 'after today' : 'after this day';
          drawerProjected.innerHTML =
            label + ': <strong>' + sign + '$' + abs + '</strong>';
        }
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
                if (!res.ok) throw new Error('delete failed ' + res.status);
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
      if (e.key === 'Escape') { closeDrawer(); closeSchedule(); closeBalances(); }
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
      if (!out.ok) {
        var msg = (out.data && (out.data.error || out.data.message)) ||
                  ('couldn\'t delete (' + out.status + ').');
        if (schedError) schedError.textContent = msg;
        if (schedDeleteYes) {
          schedDeleteYes.disabled = false;
          schedDeleteYes.textContent = 'yes';
        }
        return;
      }
      // Success: drop the row locally so it doesn't linger, then refetch.
      PRECOMMITS = PRECOMMITS.filter(function (e) { return e.id !== id; });
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
      // Persist for SWR hydration on next boot.
      cacheWrite('balances', balancesCache);
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
    var running = depTotal - ccTotal;
    // Cache for the day-popover projection.
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
    wireBalancesBtn();
    // SWR: paint last-known calendar + balances instantly from localStorage
    // before any network calls. Live fetches below silently refresh.
    hydrateFromCache();
    renderGrid();
    // Gate the page on /api/me. If the user isn't signed in we'll have already
    // redirected to "/" — the calendar they briefly saw is acceptable; the
    // alternative (hiding everything until /api/me returns) would flash blank.
    gateAuth().then(function () {
      // Fetch the calendar window first — its handler triggers a debounced
      // Plaid sync server-side that may update account balances. Once that
      // promise resolves the sync has either completed or hit its 8s timeout,
      // and the cache-evict in fetchCalendarRange() ensures the balances
      // prefetch below sees fresh data instead of a pre-sync snapshot.
      fetchInitialWindow().then(function () {
        if (typeof fetchBalancesOnce === 'function') {
          fetchBalancesOnce().then(function (payload) {
            if (payload) renderBalances(payload);
          }).catch(function () { /* silent — projection just stays hidden */ });
        }
      });
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
