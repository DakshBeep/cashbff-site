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
  var schedForm, schedDate, schedAmount, schedName, schedTypeChips,
      schedCard, schedNote, schedError, schedSubmit;
  var balBtn, balOverlay, balPop, balClose,
      balSummary, balStatus, balGroups, balAsOf;

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

        var amtDiv = document.createElement('div');
        amtDiv.className = 'amt';
        // Income renders with a leading "+" so it visually reads as money in.
        amtDiv.textContent = (e.type === 'income' ? '+$' : '$') + e.amount.toFixed(2);

        item.appendChild(rowMain);
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

  function resetScheduleForm() {
    if (!schedForm) return;
    schedForm.reset();
    if (schedDate) schedDate.value = iso(today); // default to today
    setSelectedType('planned');
    if (schedError) schedError.textContent = '';
    if (schedSubmit) {
      schedSubmit.disabled = false;
      schedSubmit.textContent = '+ schedule it';
    }
  }

  function openSchedule() {
    if (!schedPop || !schedOverlay) return;
    resetScheduleForm();
    // Lazy-load cards on first open; subsequent opens reuse the cache.
    fetchCardsOnce().then(populateCardSelect);
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

  // Submit handler: validates inline, posts to /api/transactions/schedule,
  // closes on success, surfaces server errors above the submit button.
  function handleScheduleSubmit(ev) {
    ev.preventDefault();
    if (!schedForm) return;
    if (schedError) schedError.textContent = '';

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

    var body = {
      date: dateVal,
      amount: Math.round(amountNum * 100) / 100,
      name: nameVal,
      type: typeVal
    };
    if (cardVal) body.card_account_id = cardVal;
    if (noteVal) body.note = noteVal;

    if (schedSubmit) {
      schedSubmit.disabled = true;
      schedSubmit.textContent = 'scheduling…';
    }

    fetch(API_BASE + '/api/transactions/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (out) {
      if (!out.ok) {
        var msg = (out.data && (out.data.error || out.data.message)) ||
                  ('couldn\'t schedule (' + out.status + ').');
        if (schedError) schedError.textContent = msg;
        if (schedSubmit) {
          schedSubmit.disabled = false;
          schedSubmit.textContent = '+ schedule it';
        }
        return;
      }
      // Success: drop the visible month from the cache so the next render
      // pulls the freshly-scheduled item (and anything else we may have
      // missed). We refetch only the visible month, not every fetched month.
      closeSchedule();
      var key = monthKey(view.getFullYear(), view.getMonth());
      fetchedMonths.delete(key);
      fetchMonthIfNeeded(view.getFullYear(), view.getMonth());
    }).catch(function (err) {
      if (schedError) schedError.textContent = 'network error — try again.';
      if (schedSubmit) {
        schedSubmit.disabled = false;
        schedSubmit.textContent = '+ schedule it';
      }
      try { console.warn('[home] schedule submit error:', err); } catch (_) {}
    });
  }

  function wireScheduleBtn() {
    schedBtn       = document.getElementById('schedule-btn');
    schedOverlay   = document.getElementById('schedule-overlay');
    schedPop       = document.getElementById('schedule-pop');
    schedClose     = document.getElementById('schedule-close');
    schedForm      = document.getElementById('schedule-form');
    schedDate      = document.getElementById('sched-date');
    schedAmount    = document.getElementById('sched-amount');
    schedName      = document.getElementById('sched-name');
    schedTypeChips = document.getElementById('sched-type-chips');
    schedCard      = document.getElementById('sched-card');
    schedNote      = document.getElementById('sched-note');
    schedError     = document.getElementById('sched-error');
    schedSubmit    = document.getElementById('sched-submit');

    if (schedBtn)     schedBtn.addEventListener('click', openSchedule);
    if (schedClose)   schedClose.addEventListener('click', closeSchedule);
    if (schedOverlay) schedOverlay.addEventListener('click', closeSchedule);
    if (schedForm)    schedForm.addEventListener('submit', handleScheduleSubmit);
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
    // The "forever true" amount: every depository balance (incl. negatives /
    // overdraft) minus every credit-card balance currently owed. Computed
    // from the rows directly so overdrafts on checking aren't silently
    // floored to zero (which is what summary.total_in does).
    var depTotal = 0;
    var ccTotal  = 0;
    accounts.forEach(function (a) {
      var t = (a.account_type || '').toLowerCase();
      var b = typeof a.balance_current === 'number' ? a.balance_current : Number(a.balance_current);
      if (!isFinite(b)) return;
      if (t === 'depository') depTotal += b;
      else if (t === 'credit') ccTotal += b;
    });
    var running = depTotal - ccTotal;
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
