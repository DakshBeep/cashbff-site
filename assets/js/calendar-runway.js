// calendar-runway.js — horizontal cash-line forecast over ~35 days.
(function () {
  'use strict';

  var PRECOMMITS = [
    { date: '2026-04-24', amount: 14.99,   name: 'Netflix',               type: 'sub',     confidence: 1.0 },
    { date: '2026-04-25', amount: 9.99,    name: 'Spotify',               type: 'sub',     confidence: 1.0 },
    { date: '2026-04-28', amount: 380.00,  name: 'Car payment',           type: 'bill',    confidence: 1.0 },
    { date: '2026-04-30', amount: 62.00,   name: 'Concert',               type: 'planned', confidence: 0.6 },
    { date: '2026-05-01', amount: 1450.00, name: 'Rent',                  type: 'bill',    confidence: 1.0 },
    { date: '2026-05-05', amount: 75.00,   name: 'Phone',                 type: 'bill',    confidence: 1.0 },
    { date: '2026-05-12', amount: 42.00,   name: 'Vet (Pepper)',          type: 'planned', confidence: 0.7 },
    { date: '2026-05-15', amount: 120.00,  name: 'Credit One',            type: 'cc',      confidence: 1.0 },
    { date: '2026-05-15', amount: 45.00,   name: 'Capital One',           type: 'cc',      confidence: 1.0 },
    { date: '2026-05-22', amount: 14.99,   name: 'Netflix',               type: 'sub',     confidence: 1.0 },
    { date: '2026-05-28', amount: 380.00,  name: 'Car payment',           type: 'bill',    confidence: 1.0 }
  ];

  // bi-weekly paydays
  var PAYDAYS = [
    { date: '2026-04-25', amount: 1820.00 },
    { date: '2026-05-09', amount: 1820.00 },
    { date: '2026-05-23', amount: 1820.00 }
  ];

  var START_BALANCE = 1240.00;
  var TIGHT_THRESHOLD = 400.00;
  var DAYS = 35;
  var today = new Date(2026, 3, 23); // Apr 23 2026

  // dimensions
  var DAY_W = 56;
  var DAY_W_MOBILE = 38;
  var dayW = window.innerWidth < 640 ? DAY_W_MOBILE : DAY_W;
  var PAD_L = 36, PAD_R = 36, PAD_T = 60, PAD_B = 120;
  var CHART_H = 170; // vertical room for cash line
  var TOTAL_W = PAD_L + PAD_R + dayW * DAYS;
  var TOTAL_H = PAD_T + CHART_H + PAD_B;

  var svg = document.getElementById('runway-svg');
  var wrap = document.getElementById('runway-wrap');
  var introSub = document.getElementById('intro-sub');

  function money(n) {
    return '$' + Math.round(n).toLocaleString();
  }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function addDays(d, n) {
    var r = new Date(d); r.setDate(r.getDate() + n); return r;
  }
  function el(name, attrs, text) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', name);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }

  // Compute running balance per day (balance AFTER the day's events)
  var days = [];
  var balance = START_BALANCE;
  for (var i = 0; i < DAYS; i++) {
    var d = addDays(today, i);
    var key = iso(d);
    var dayExpenses = PRECOMMITS.filter(function (e) { return e.date === key; });
    var dayIncome = PAYDAYS.filter(function (p) { return p.date === key; });
    var startOfDay = balance;
    var expenseTotal = dayExpenses.reduce(function (s, e) { return s + e.amount; }, 0);
    var incomeTotal = dayIncome.reduce(function (s, p) { return s + p.amount; }, 0);
    balance = balance + incomeTotal - expenseTotal;
    days.push({
      date: d,
      iso: key,
      startBalance: startOfDay,
      endBalance: balance,
      expenses: dayExpenses,
      incomes: dayIncome,
      dow: d.getDay()
    });
  }

  // Y-scale: balance → pixel
  var maxBal = Math.max.apply(null, days.map(function (x) { return x.endBalance; }).concat(START_BALANCE));
  var minBal = Math.min.apply(null, days.map(function (x) { return x.endBalance; }).concat(START_BALANCE));
  // pad the scale a bit
  var yMax = maxBal + 200;
  var yMin = Math.min(0, minBal - 200);
  function yFor(bal) {
    var t = (bal - yMin) / (yMax - yMin);
    return PAD_T + CHART_H - t * CHART_H;
  }
  function xFor(i) {
    return PAD_L + (i + 0.5) * dayW;
  }

  svg.setAttribute('width', TOTAL_W);
  svg.setAttribute('height', TOTAL_H);
  svg.setAttribute('viewBox', '0 0 ' + TOTAL_W + ' ' + TOTAL_H);

  // Intro copy
  var endBal = days[days.length - 1].endBalance;
  var tightDays = days.filter(function (d) { return d.endBalance < TIGHT_THRESHOLD; }).length;
  var phrase = tightDays > 0
    ? '<strong>' + money(START_BALANCE) + '</strong> on hand today · <strong>' + money(endBal) + '</strong> after may 28'
    : '<strong>' + money(START_BALANCE) + '</strong> on hand · smooth sailing for 35 days';
  introSub.innerHTML = phrase;

  // Tight bands — rects behind tight days
  days.forEach(function (day, i) {
    if (day.endBalance < TIGHT_THRESHOLD) {
      svg.appendChild(el('rect', {
        class: 'tight-band',
        x: PAD_L + i * dayW,
        y: PAD_T,
        width: dayW,
        height: CHART_H
      }));
    }
  });

  // Threshold line
  svg.appendChild(el('line', {
    class: 'threshold-line',
    x1: PAD_L, x2: TOTAL_W - PAD_R,
    y1: yFor(TIGHT_THRESHOLD), y2: yFor(TIGHT_THRESHOLD)
  }));
  svg.appendChild(el('text', {
    class: 'threshold-label',
    x: TOTAL_W - PAD_R + 4,
    y: yFor(TIGHT_THRESHOLD) + 3
  }, money(TIGHT_THRESHOLD)));

  // Today line (left edge)
  svg.appendChild(el('line', {
    class: 'today-line',
    x1: xFor(0), x2: xFor(0),
    y1: PAD_T - 15, y2: PAD_T + CHART_H + 10
  }));
  svg.appendChild(el('text', {
    class: 'today-label',
    x: xFor(0), y: PAD_T - 22,
    'text-anchor': 'middle'
  }, 'today'));

  // Cash line path + area
  var pathD = '';
  var areaD = '';
  // Start at day 0's start balance at left edge
  var firstX = xFor(0) - dayW/2 + 6;
  var firstY = yFor(days[0].startBalance);
  pathD += 'M ' + firstX + ' ' + firstY + ' ';
  areaD += 'M ' + firstX + ' ' + (PAD_T + CHART_H) + ' L ' + firstX + ' ' + firstY + ' ';

  days.forEach(function (day, i) {
    var xCenter = xFor(i);
    var yEnd = yFor(day.endBalance);
    // horizontal to just before center then drop to new balance
    pathD += 'L ' + xCenter + ' ' + yFor(day.startBalance) + ' ';
    pathD += 'L ' + xCenter + ' ' + yEnd + ' ';
    areaD += 'L ' + xCenter + ' ' + yFor(day.startBalance) + ' ';
    areaD += 'L ' + xCenter + ' ' + yEnd + ' ';
  });
  var lastX = xFor(days.length - 1) + dayW/2 - 6;
  pathD += 'L ' + lastX + ' ' + yFor(days[days.length - 1].endBalance);
  areaD += 'L ' + lastX + ' ' + yFor(days[days.length - 1].endBalance) + ' ';
  areaD += 'L ' + lastX + ' ' + (PAD_T + CHART_H) + ' Z';

  svg.appendChild(el('path', { class: 'cash-line-area', d: areaD }));
  svg.appendChild(el('path', { class: 'cash-line', d: pathD }));

  // Day labels + expense markers + payday markers
  days.forEach(function (day, i) {
    var xCenter = xFor(i);

    // day number label at bottom
    var isWeekend = day.dow === 0 || day.dow === 6;
    var showMonth = day.date.getDate() === 1 || i === 0;
    svg.appendChild(el('text', {
      class: 'day-label' + (isWeekend ? ' weekend' : ''),
      x: xCenter, y: PAD_T + CHART_H + 18,
      'text-anchor': 'middle'
    }, day.date.getDate()));

    if (showMonth) {
      var monthAbbr = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][day.date.getMonth()];
      svg.appendChild(el('text', {
        class: 'day-label',
        x: xCenter, y: PAD_T + CHART_H + 32,
        'text-anchor': 'middle',
        'font-weight': '600'
      }, monthAbbr));
    }

    // paydays first (above cash line as upward marker)
    day.incomes.forEach(function (p) {
      svg.appendChild(el('circle', {
        class: 'payday-marker',
        cx: xCenter,
        cy: yFor(day.startBalance + p.amount),
        r: 4,
        stroke: '#014751',
        'stroke-width': '1'
      }));
      svg.appendChild(el('text', {
        class: 'payday-label',
        x: xCenter,
        y: yFor(day.startBalance + p.amount) - 10,
        'text-anchor': 'middle'
      }, '+' + money(p.amount)));
    });

    // expenses stacked below cash line
    day.expenses.forEach(function (e, idx) {
      var stackY = PAD_T + CHART_H + 50 + idx * 26;
      var color = { bill: '#014751', cc: '#C5B6F1', sub: '#FCFAF2', planned: 'transparent' }[e.type];
      var stroke = (e.type === 'sub' || e.type === 'planned') ? '#014751' : 'none';
      var dash = e.type === 'planned' ? '3,2' : '0';
      // circle marker
      svg.appendChild(el('circle', {
        class: 'expense-bar',
        cx: xCenter, cy: stackY,
        r: 7,
        fill: color,
        stroke: stroke,
        'stroke-width': '1',
        'stroke-dasharray': dash
      }));
      // amount
      svg.appendChild(el('text', {
        class: 'expense-amt',
        x: xCenter, y: stackY + 3,
        'text-anchor': 'middle',
        fill: (e.type === 'bill') ? '#FCFAF2' : '#014751',
        'font-size': '0.6rem'
      }, '$' + Math.round(e.amount)));
      // name below marker
      svg.appendChild(el('text', {
        class: 'expense-label',
        x: xCenter, y: stackY + 18,
        'text-anchor': 'middle',
        'font-style': e.type === 'planned' ? 'italic' : 'normal'
      }, e.name.length > 10 ? e.name.substring(0, 10) + '…' : e.name));
    });
  });

  // Scroll to today on load
  setTimeout(function () {
    wrap.scrollLeft = 0;
  }, 0);
})();
