// ── Phase 7D auth gate ────────────────────────────
// plan.html is the cold-start "tell me about your cards" calculator. If
// the user already has a session (/api/me 200) they're past this step —
// bounce them to /home.html before they fill in fake numbers. 401 / net
// errors silently fall through so the public calculator still works.
(async function gateAuth() {
  try {
    const res = await fetch('https://api.cashbff.com/api/me', { credentials: 'include' });
    if (res.status === 200) location.replace('/home.html');
  } catch (_) {
    // Cold-start network blip — let the page render and behave like a
    // public marketing calculator.
  }
})();

// ── Phone pill ───────────────────────────────────
const params = new URLSearchParams(location.search);
const rawPhone = params.get('phone') || '';
const digits = rawPhone.replace(/\D/g, '');
const pill = document.getElementById('phone-pill');
if (digits.length >= 10) {
  const d = digits.slice(-10);
  pill.textContent = `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

// ── State ────────────────────────────────────────
const state = {
  strategy: 'avalanche',
  cards: [],
};
const MAX_CARDS = 3;

function newCard() {
  return { id: Math.random().toString(36).slice(2, 9), nickname: '', balance: '', apr: '', min: '' };
}

// ── Card form rendering ──────────────────────────
const cardsList = document.getElementById('cards-list');
const addBtn = document.getElementById('add-btn');

function renderCards() {
  cardsList.innerHTML = '';
  state.cards.forEach((card, idx) => {
    const row = document.createElement('div');
    row.className = 'card-row';
    row.innerHTML = `
      <div class="field">
        <label for="nick-${card.id}">nickname</label>
        <input id="nick-${card.id}" type="text" data-k="nickname" value="${escapeAttr(card.nickname)}" placeholder="${idx === 0 ? 'chase sapphire' : idx === 1 ? 'capital one' : 'amex'}">
      </div>
      <div class="field">
        <label for="bal-${card.id}">balance ($)</label>
        <input id="bal-${card.id}" type="number" inputmode="decimal" data-k="balance" value="${escapeAttr(card.balance)}" placeholder="3200">
      </div>
      <div class="field">
        <label for="apr-${card.id}">APR (%)</label>
        <input id="apr-${card.id}" type="number" inputmode="decimal" step="0.01" data-k="apr" value="${escapeAttr(card.apr)}" placeholder="22.9">
      </div>
      <div class="field">
        <label for="min-${card.id}">minimum ($)</label>
        <input id="min-${card.id}" type="number" inputmode="decimal" data-k="min" value="${escapeAttr(card.min)}" placeholder="55">
      </div>
      <button type="button" class="remove-btn" aria-label="remove card" ${state.cards.length === 1 ? 'style="visibility:hidden"' : ''}>×</button>
    `;
    row.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', (e) => {
        card[e.target.dataset.k] = e.target.value;
        updateMonthlyHint();
      });
    });
    row.querySelector('.remove-btn').addEventListener('click', () => {
      state.cards = state.cards.filter(c => c.id !== card.id);
      renderCards();
      updateAddBtn();
      updateMonthlyHint();
    });
    cardsList.appendChild(row);
  });
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function updateAddBtn() {
  addBtn.disabled = state.cards.length >= MAX_CARDS;
  addBtn.textContent = state.cards.length >= MAX_CARDS ? '(three cards max for now)' : '+ add another card';
}

addBtn.addEventListener('click', () => {
  if (state.cards.length >= MAX_CARDS) return;
  state.cards.push(newCard());
  renderCards();
  updateAddBtn();
});

// Seed
state.cards.push(newCard());
renderCards();
updateAddBtn();

// ── Strategy toggle ──────────────────────────────
const stratBtns = document.querySelectorAll('.strat-toggle button');
const stratHint = document.getElementById('strat-hint');
stratBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    stratBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.strategy = btn.dataset.strat;
    stratHint.textContent = state.strategy === 'avalanche'
      ? 'saves the most money — attacks highest rate first.'
      : 'fastest wins — attacks smallest balance first.';
  });
});

// ── Monthly hint ─────────────────────────────────
const monthlyInput = document.getElementById('monthly');
const monthlyHint = document.getElementById('monthly-hint');
function updateMonthlyHint() {
  const totalMin = state.cards.reduce((s, c) => s + (Number(c.min) || 0), 0);
  const monthly = Number(monthlyInput.value) || 0;
  if (totalMin <= 0) {
    monthlyHint.textContent = "we'll set a sensible default — adjust up if you can.";
    return;
  }
  if (monthly < totalMin) {
    monthlyHint.textContent = `minimum total is $${totalMin.toFixed(0)}/mo. pushing extra in gets you there faster.`;
  } else {
    const extra = monthly - totalMin;
    monthlyHint.textContent = extra === 0
      ? `that covers minimums. add even $20 and you'll be surprised.`
      : `$${extra.toFixed(0)}/mo over minimums. that's where the magic is.`;
  }
}
monthlyInput.addEventListener('input', updateMonthlyHint);
updateMonthlyHint();

// ── Payoff math ──────────────────────────────────
function simulate(cards, strategy, monthlyPayment) {
  const MAX_MONTHS = 600;
  const remaining = cards.map(c => ({ ...c }));
  let months = 0;
  let totalInterest = 0;
  const payoffOrder = [];

  while (remaining.some(c => c.balance > 0.005) && months < MAX_MONTHS) {
    remaining.forEach(c => {
      if (c.balance > 0) {
        const interest = c.balance * (c.apr / 100 / 12);
        c.balance += interest;
        totalInterest += interest;
      }
    });

    const active = remaining.filter(c => c.balance > 0);
    const sorted = [...active].sort((a, b) => {
      return strategy === 'avalanche' ? (b.apr - a.apr) : (a.balance - b.balance);
    });

    let pot = monthlyPayment;
    active.forEach(c => {
      const pay = Math.min(c.min, c.balance, pot);
      c.balance -= pay;
      pot -= pay;
    });
    for (const c of sorted) {
      if (pot <= 0) break;
      if (c.balance <= 0) continue;
      const pay = Math.min(pot, c.balance);
      c.balance -= pay;
      pot -= pay;
    }

    remaining.forEach(c => {
      if (c.balance <= 0.005 && !payoffOrder.find(p => p.id === c.id)) {
        payoffOrder.push({ id: c.id, nickname: c.nickname, month: months + 1 });
      }
    });

    months++;
  }

  return { months, totalInterest, payoffOrder, maxedOut: months >= MAX_MONTHS };
}

// ── Calculate handler ────────────────────────────
const calcBtn = document.getElementById('calc-btn');
const calcErr = document.getElementById('calc-err');
const formView = document.getElementById('form-view');
const resultView = document.getElementById('result-view');

calcBtn.addEventListener('click', () => {
  calcErr.classList.remove('show');
  calcErr.textContent = '';

  const parsed = state.cards.map(c => ({
    id: c.id,
    nickname: c.nickname.trim() || 'card',
    balance: Number(c.balance),
    apr: Number(c.apr),
    min: Number(c.min),
  })).filter(c => c.balance > 0);

  if (parsed.length === 0) {
    calcErr.textContent = 'add at least one card with a balance.';
    calcErr.classList.add('show');
    return;
  }
  if (parsed.some(c => !isFinite(c.apr) || c.apr < 0 || c.apr > 100)) {
    calcErr.textContent = 'APR looks off — check those rates.';
    calcErr.classList.add('show');
    return;
  }
  if (parsed.some(c => !isFinite(c.min) || c.min < 0)) {
    calcErr.textContent = 'minimum payment missing or invalid.';
    calcErr.classList.add('show');
    return;
  }

  const monthly = Number(monthlyInput.value);
  const totalMin = parsed.reduce((s, c) => s + c.min, 0);
  if (!isFinite(monthly) || monthly < totalMin) {
    calcErr.textContent = `monthly payment needs to cover minimums ($${totalMin.toFixed(0)}/mo).`;
    calcErr.classList.add('show');
    return;
  }

  const yourPlan = simulate(parsed, state.strategy, monthly);
  const minsOnly = simulate(parsed, state.strategy, totalMin);

  if (yourPlan.maxedOut) {
    calcErr.textContent = "math doesn't converge — try a higher monthly payment.";
    calcErr.classList.add('show');
    return;
  }

  const saved = Math.max(0, minsOnly.totalInterest - yourPlan.totalInterest);
  const debtFreeDate = addMonths(new Date(), yourPlan.months);

  renderCalendar(debtFreeDate);
  document.getElementById('reveal-saved').textContent = '$' + Math.round(saved).toLocaleString();
  document.getElementById('reveal-months').textContent = yourPlan.months;

  const orderEl = document.getElementById('order-list');
  orderEl.innerHTML = '';
  yourPlan.payoffOrder.forEach((p, i) => {
    const step = document.createElement('div');
    step.className = 'order-step';
    const whenDate = addMonths(new Date(), p.month);
    step.innerHTML = `
      <span class="order-step__n">${i + 1}</span>
      <span class="order-step__name">${escapeHtml(p.nickname)}</span>
      <span class="order-step__when">paid off ${formatMonth(whenDate)}</span>
    `;
    orderEl.appendChild(step);
  });

  formView.style.display = 'none';
  resultView.classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.getElementById('edit-btn').addEventListener('click', () => {
  resultView.classList.remove('show');
  formView.style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Preserve phone through flow when continuing to paywall
document.getElementById('continue-btn').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = `paywall.html?phone=${encodeURIComponent(rawPhone)}`;
});

function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}
function formatMonth(d) {
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

// ── Calendar renderer ────────────────────────────
function renderCalendar(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const targetDay = date.getDate();

  const header = document.getElementById('cal-header');
  header.textContent = date.toLocaleString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0 = Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  let i = 0;

  for (let e = 0; e < firstDayOfWeek; e++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day empty';
    cell.style.setProperty('--i', i++);
    grid.appendChild(cell);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    if (d === targetDay) cell.classList.add('target');
    cell.textContent = d;
    cell.style.setProperty('--i', i++);
    grid.appendChild(cell);
  }
}
