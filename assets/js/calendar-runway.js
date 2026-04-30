// calendar-runway.js. horizontal cash-line forecast.
// Visual model: one clean cash line running left to right.
// Expenses drop FROM the line as short vertical bars with amount underneath.
// Paydays bump the line up with a small green circle + label above.
// Day axis at the bottom, tight-week bands subtly behind.
(function () {
  'use strict';

  var PRECOMMITS = [
    { date: '2026-04-24', amount: 14.99,   name: 'Netflix',               type: 'sub',     confidence: 1.0 },
    { date: '2026-04-25', amount: 9.99,    name: 'Spotify',               type: 'sub',     confidence: 1.0 },
    { date: '2026-04-28', amount: 380.00,  name: 'Car payment',           type: 'bill',    confidence: 1.0 },
    { date: '2026-04-30', amount: 62.00,   name: 'Concert',               type: 'planned', confidence: 0.6 },
    { date: '2026-05-01', amount: 1450.00, name: 'Rent',                  type: 'bill',    confidence: 1.0 },
    { date: '2026-05-05', amount: 75.00,   name: 'Phone',                 type: 'bill',    confidence: 1.0 },
    { date: '2026-05-12', amount: 42.00,   name: 'Vet',                   type: 'planned', confidence: 0.7 },
    { date: '2026-05-15', amount: 120.00,  name: 'Credit One',            type: 'cc',      confidence: 1.0 },
    { date: '2026-05-15', amount: 45.00,   name: 'Capital One',           type: 'cc',      confidence: 1.0 },
    { date: '2026-05-22', amount: 14.99,   name: 'Netflix',               type: 'sub',     confidence: 1.0 },
    { date: '2026-05-28', amount: 380.00,  name: 'Car payment',           type: 'bill',    confidence: 1.0 }
  ];

  var PAYDAYS = [
    { date: '2026-04-25', amount: 1820.00 },
    { date: '2026-05-09', amount: 1820.00 },
    { date: '2026-05-23', amount: 1820.00 }
  ];

  var START_BALANCE = 1240.00;
  var TIGHT_THRESHOLD = 400.00;
  var DAYS = 35;
  var today = new Date(2026, 3, 23);

  var isMobile = window.innerWidth < 640;
  var DAY_W = isMobile ? 44 : 64;
  var PAD_L = 40;
  var PAD_R = 40;
  var PAD_TOP = 56;     // space above cash line for payday labels + balance ticks
  var CHART_H = 160;    // vertical chart area
  var AXIS_H = 28;      // day-number row
  var EXP_H = 120;      // space below axis for expense drop labels
  var TOTAL_W = PAD_L + PAD_R + DAY_W * DAYS;
  var TOTAL_H = PAD_TOP + CHART_H + AXIS_H + EXP_H;

  var svg = document.getElementById('runway-svg');
  var wrap = document.getElementById('runway-wrap');
  var introSub = document.getElementById('intro-sub');

  // ── helpers
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function addDays(d, n) { var r = new Date(d); r.setDate(r.getDate()+n); return r; }
  function money(n, decimals) {
    var x = decimals === undefined ? 0 : decimals;
    return '$' + Number(n).toFixed(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function svgEl(name, attrs, text) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', name);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  // ── compute day-by-day balance
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
      date: d, iso: key,
      startBalance: startOfDay, endBalance: balance,
      expenses: dayExpenses, incomes: dayIncome,
      dow: d.getDay()
    });
  }

  // Balance scale: pad top and bottom for room
  var maxBal = Math.max(START_BALANCE, Math.max.apply(null, days.map(function (x) { return Math.max(x.startBalance, x.endBalance); })));
  var minBal = Math.min(START_BALANCE, Math.min.apply(null, days.map(function (x) { return Math.min(x.startBalance, x.endBalance); })));
  // pad scale above max and below min
  var yMax = maxBal + 400;
  var yMin = Math.min(0, minBal - 200);

  function yFor(bal) {
    var t = (bal - yMin) / (yMax - yMin);
    return PAD_TOP + CHART_H - t * CHART_H;
  }
  function xFor(i) { return PAD_L + i * DAY_W + DAY_W / 2; }

  svg.setAttribute('width', TOTAL_W);
  svg.setAttribute('height', TOTAL_H);
  svg.setAttribute('viewBox', '0 0 ' + TOTAL_W + ' ' + TOTAL_H);

  // ── intro copy
  var endBal = days[days.length - 1].endBalance;
  var tightDays = days.filter(function (x) { return x.endBalance < TIGHT_THRESHOLD; }).length;
  var extra = tightDays
    ? '<strong>' + tightDays + '</strong> tight day' + (tightDays === 1 ? '' : 's') + ' ahead.'
    : 'smooth sailing.';
  introSub.innerHTML =
    '<strong>' + money(START_BALANCE) + '</strong> on hand · ' +
    '<strong>' + money(endBal) + '</strong> after may 28 · ' + extra;

  // ── 1. Tight bands (below threshold). drawn first, behind everything
  days.forEach(function (day, i) {
    if (day.endBalance < TIGHT_THRESHOLD) {
      svg.appendChild(svgEl('rect', {
        fill: '#C5B6F1',
        opacity: 0.14,
        x: PAD_L + i * DAY_W,
        y: PAD_TOP,
        width: DAY_W,
        height: CHART_H + AXIS_H
      }));
    }
  });

  // ── 2. Subtle y-gridlines at a few balance levels
  var gridLevels = [0, 500, 1000, 1500, 2000];
  gridLevels.forEach(function (lvl) {
    if (lvl < yMin || lvl > yMax) return;
    svg.appendChild(svgEl('line', {
      x1: PAD_L, x2: TOTAL_W - PAD_R,
      y1: yFor(lvl), y2: yFor(lvl),
      stroke: '#014751',
      'stroke-width': 0.5,
      opacity: 0.1
    }));
    svg.appendChild(svgEl('text', {
      x: PAD_L - 8, y: yFor(lvl) + 3,
      'text-anchor': 'end',
      fill: '#014751',
      opacity: 0.4,
      'font-size': '0.6rem',
      'font-family': 'Instrument Sans, sans-serif'
    }, money(lvl)));
  });

  // ── 3. Threshold dashed line (below which we mark tight)
  svg.appendChild(svgEl('line', {
    x1: PAD_L, x2: TOTAL_W - PAD_R,
    y1: yFor(TIGHT_THRESHOLD), y2: yFor(TIGHT_THRESHOLD),
    stroke: '#C5B6F1',
    'stroke-width': 1,
    'stroke-dasharray': '3,4',
    opacity: 0.7
  }));

  // ── 4. Cash line. stepped cleanly, plus soft area fill
  // each day: start at startBalance for full day-width, then drop/rise to endBalance at the day's end
  var baselineY = PAD_TOP + CHART_H;
  var pathD = '';
  var areaD = 'M ' + PAD_L + ' ' + baselineY + ' ';
  var firstBalY = yFor(days[0].startBalance);
  pathD += 'M ' + PAD_L + ' ' + firstBalY + ' ';
  areaD += 'L ' + PAD_L + ' ' + firstBalY + ' ';

  days.forEach(function (day, i) {
    var xStart = PAD_L + i * DAY_W;
    var xEnd = xStart + DAY_W;
    var yStart = yFor(day.startBalance);
    var yEnd = yFor(day.endBalance);
    // run flat across the day at startBalance then drop at right edge to endBalance
    pathD += 'L ' + xEnd + ' ' + yStart + ' ';
    pathD += 'L ' + xEnd + ' ' + yEnd + ' ';
    areaD += 'L ' + xEnd + ' ' + yStart + ' ';
    areaD += 'L ' + xEnd + ' ' + yEnd + ' ';
  });
  areaD += 'L ' + (TOTAL_W - PAD_R) + ' ' + baselineY + ' Z';

  svg.appendChild(svgEl('path', {
    d: areaD,
    fill: '#014751',
    opacity: 0.05
  }));
  svg.appendChild(svgEl('path', {
    d: pathD,
    fill: 'none',
    stroke: '#014751',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  }));

  // ── 5. Today marker: vertical dashed line + label
  svg.appendChild(svgEl('line', {
    x1: xFor(0), x2: xFor(0),
    y1: PAD_TOP - 18, y2: PAD_TOP + CHART_H + AXIS_H,
    stroke: '#014751',
    'stroke-width': 1,
    'stroke-dasharray': '2,3',
    opacity: 0.5
  }));
  svg.appendChild(svgEl('text', {
    x: xFor(0), y: PAD_TOP - 24,
    'text-anchor': 'middle',
    fill: '#014751',
    'font-family': 'Greed Condensed, sans-serif',
    'font-weight': 500,
    'font-size': '0.72rem'
  }, 'today'));

  // current balance big number above the line at today
  svg.appendChild(svgEl('text', {
    x: xFor(0) + 8, y: yFor(START_BALANCE) - 6,
    fill: '#014751',
    'font-family': 'Greed Condensed, sans-serif',
    'font-weight': 500,
    'font-size': '0.95rem'
  }, money(START_BALANCE)));

  // ── 6. Payday bumps: circle on the line + label above
  days.forEach(function (day, i) {
    day.incomes.forEach(function (p) {
      var xc = xFor(i) + DAY_W / 4; // slight right-of-center since income applies during the day
      var yc = yFor(day.endBalance);
      // upward tick line from baseline to new balance
      svg.appendChild(svgEl('line', {
        x1: PAD_L + i * DAY_W + DAY_W,
        y1: yFor(day.startBalance + p.amount),
        x2: PAD_L + i * DAY_W + DAY_W,
        y2: yFor(day.startBalance),
        stroke: '#D3FFB4',
        'stroke-width': 3,
        'stroke-linecap': 'round',
        opacity: 0.9
      }));
      // small payday circle at the top of the bump
      svg.appendChild(svgEl('circle', {
        cx: PAD_L + i * DAY_W + DAY_W,
        cy: yFor(day.startBalance + p.amount),
        r: 4,
        fill: '#D3FFB4',
        stroke: '#014751',
        'stroke-width': 1.2
      }));
      // label
      svg.appendChild(svgEl('text', {
        x: PAD_L + i * DAY_W + DAY_W,
        y: yFor(day.startBalance + p.amount) - 10,
        'text-anchor': 'middle',
        fill: '#014751',
        'font-family': 'Greed Condensed, sans-serif',
        'font-weight': 500,
        'font-size': '0.7rem'
      }, '+' + money(p.amount)));
      svg.appendChild(svgEl('text', {
        x: PAD_L + i * DAY_W + DAY_W,
        y: yFor(day.startBalance + p.amount) - 23,
        'text-anchor': 'middle',
        fill: '#014751',
        opacity: 0.6,
        'font-family': 'Instrument Sans, sans-serif',
        'font-size': '0.55rem',
        'text-transform': 'lowercase'
      }, 'payday'));
    });
  });

  // ── 7. Expense drops: vertical line from cash line down to the axis,
  //       amount label below the axis, name below amount.
  days.forEach(function (day, i) {
    if (!day.expenses.length) return;
    var xc = xFor(i);
    var yTop = yFor(day.startBalance);
    var totalExp = day.expenses.reduce(function (s, e) { return s + e.amount; }, 0);
    // vertical drop line from cash-line down to axis
    svg.appendChild(svgEl('line', {
      x1: xc, y1: yTop + 1,
      x2: xc, y2: PAD_TOP + CHART_H + 8,
      stroke: '#014751',
      'stroke-width': 1,
      'stroke-linecap': 'round',
      opacity: 0.5
    }));
    // small dot where it hits the axis
    svg.appendChild(svgEl('circle', {
      cx: xc,
      cy: PAD_TOP + CHART_H + 8,
      r: 2.5,
      fill: '#014751'
    }));

    // Stack each expense label below the axis
    day.expenses.forEach(function (e, idx) {
      var labelY = PAD_TOP + CHART_H + AXIS_H + 14 + idx * 32;

      // type color chip
      var chipFill = { bill: '#014751', cc: '#C5B6F1', sub: '#FCFAF2', planned: 'transparent' }[e.type];
      var chipStroke = (e.type === 'sub' || e.type === 'planned') ? '#014751' : 'none';
      var chipDash = e.type === 'planned' ? '2,2' : '0';

      svg.appendChild(svgEl('circle', {
        cx: xc, cy: labelY,
        r: 4,
        fill: chipFill,
        stroke: chipStroke,
        'stroke-width': 1,
        'stroke-dasharray': chipDash
      }));
      // amount
      svg.appendChild(svgEl('text', {
        x: xc, y: labelY + 15,
        'text-anchor': 'middle',
        fill: '#014751',
        'font-family': 'Greed Condensed, sans-serif',
        'font-weight': 500,
        'font-size': '0.72rem'
      }, '-' + money(e.amount)));
      // name
      svg.appendChild(svgEl('text', {
        x: xc, y: labelY + 27,
        'text-anchor': 'middle',
        fill: '#1A1717',
        opacity: e.type === 'planned' ? 0.55 : 0.7,
        'font-family': 'Instrument Sans, sans-serif',
        'font-size': '0.6rem',
        'font-style': e.type === 'planned' ? 'italic' : 'normal'
      }, e.name));
    });
  });

  // ── 8. Day-number axis (below chart)
  var axisY = PAD_TOP + CHART_H + 22;
  days.forEach(function (day, i) {
    var xc = xFor(i);
    // day number
    var isFirstOfMonth = day.date.getDate() === 1;
    var isToday = i === 0;
    svg.appendChild(svgEl('text', {
      x: xc,
      y: axisY,
      'text-anchor': 'middle',
      fill: '#014751',
      opacity: isToday ? 1 : (isFirstOfMonth ? 0.9 : 0.55),
      'font-family': 'Instrument Sans, sans-serif',
      'font-size': '0.65rem',
      'font-weight': isFirstOfMonth || isToday ? 600 : 400
    }, day.date.getDate()));

    // month label on first-of-month
    if (isFirstOfMonth) {
      var monthAbbr = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][day.date.getMonth()];
      svg.appendChild(svgEl('text', {
        x: xc,
        y: axisY - 14,
        'text-anchor': 'middle',
        fill: '#014751',
        'font-family': 'Greed Condensed, sans-serif',
        'font-weight': 500,
        'font-size': '0.75rem'
      }, monthAbbr));
    }
  });

  // start scrolled to the far left (today)
  wrap.scrollLeft = 0;
})();
