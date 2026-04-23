// calendar-month.js — dummy month-grid view of pre-committed expenses.
(function () {
  'use strict';

  var PRECOMMITS = [
    { date: '2026-04-24', amount: 14.99,   name: 'Netflix',               type: 'sub',     confidence: 1.0 },
    { date: '2026-04-25', amount: 9.99,    name: 'Spotify',               type: 'sub',     confidence: 1.0 },
    { date: '2026-04-28', amount: 380.00,  name: 'Car payment',           type: 'bill',    confidence: 1.0 },
    { date: '2026-04-30', amount: 62.00,   name: 'Concert — Philip pays back?', type: 'planned', confidence: 0.6 },
    { date: '2026-05-01', amount: 1450.00, name: 'Rent',                  type: 'bill',    confidence: 1.0 },
    { date: '2026-05-05', amount: 75.00,   name: 'Phone bill',            type: 'bill',    confidence: 1.0 },
    { date: '2026-05-12', amount: 42.00,   name: 'Vet (Pepper checkup)',  type: 'planned', confidence: 0.7 },
    { date: '2026-05-15', amount: 120.00,  name: 'Credit One — min due',  type: 'cc',      confidence: 1.0 },
    { date: '2026-05-15', amount: 45.00,   name: 'Capital One — min due', type: 'cc',      confidence: 1.0 },
    { date: '2026-05-22', amount: 14.99,   name: 'Netflix',               type: 'sub',     confidence: 1.0 },
    { date: '2026-05-28', amount: 380.00,  name: 'Car payment',           type: 'bill',    confidence: 1.0 }
  ];

  var MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  var today = new Date(2026, 3, 23); // frozen "today" — Apr 23 2026, matches session date
  var view = new Date(today.getFullYear(), today.getMonth(), 1);

  var grid = document.getElementById('grid');
  var monthTitle = document.getElementById('month-title');
  var totalPill = document.getElementById('total-pill');
  var prevBtn = document.getElementById('prev-month');
  var nextBtn = document.getElementById('next-month');
  var drawer = document.getElementById('drawer');
  var drawerOverlay = document.getElementById('drawer-overlay');
  var drawerDate = document.getElementById('drawer-date');
  var drawerTotal = document.getElementById('drawer-total');
  var drawerList = document.getElementById('drawer-list');
  var drawerClose = document.getElementById('drawer-close');

  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function sameYMD(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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

  function renderGrid() {
    grid.innerHTML = '';
    var year = view.getFullYear();
    var month = view.getMonth();
    var firstDay = new Date(year, month, 1);
    var startOfGrid = new Date(year, month, 1 - firstDay.getDay()); // start on Sunday

    monthTitle.textContent = MONTHS[month] + ' ' + year;
    var total = totalForMonth(year, month);
    totalPill.innerHTML = '<strong>' + money(total) + '</strong> already spoken for this month';

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
        p.textContent = '$' + e.amount.toFixed(0) + ' ' + e.name.split(' ')[0];
        cell.appendChild(p);
      });
      if (exps.length > maxPills) {
        var ov = document.createElement('span');
        ov.className = 'overflow';
        ov.textContent = '+' + (exps.length - maxPills) + ' more';
        cell.appendChild(ov);
      }

      var dateCopy = new Date(cellDate);
      cell.addEventListener('click', function (d) {
        return function () { openDrawer(d); };
      }(dateCopy));

      grid.appendChild(cell);
    }
    // break out once all "real" week rows are shown — hide last trailing empty row if fully off-month
    var lastRowStart = new Date(startOfGrid); lastRowStart.setDate(startOfGrid.getDate() + 35);
    if (lastRowStart.getMonth() !== month) {
      var cells = grid.querySelectorAll('.cell');
      for (var j = 35; j < 42; j++) cells[j].style.display = 'none';
    }
  }

  function openDrawer(d) {
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
        item.innerHTML =
          '<div class="name">' + e.name + ' <small>' + typeLabel +
            (e.confidence < 1.0 ? ' · ' + Math.round(e.confidence * 100) + '% confidence' : '') +
          '</small></div>' +
          '<div class="amt">$' + e.amount.toFixed(2) + '</div>';
        drawerList.appendChild(item);
      });
    }
    drawer.classList.add('open');
    drawerOverlay.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  prevBtn.addEventListener('click', function () {
    view.setMonth(view.getMonth() - 1);
    renderGrid();
  });
  nextBtn.addEventListener('click', function () {
    view.setMonth(view.getMonth() + 1);
    renderGrid();
  });
  drawerOverlay.addEventListener('click', closeDrawer);
  drawerClose.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDrawer();
  });

  renderGrid();
})();
