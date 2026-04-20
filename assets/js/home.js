// ── Config ───────────────────────────────────────
const API_BASE = 'https://api.cashbff.com';
const NAME_KEY = 'cbff_first_name';
const MAX_SLOTS = 5;

// ── Phone pill ──────────────────────────────────
const params = new URLSearchParams(location.search);
const rawPhone = params.get('phone') || '';
const digits = rawPhone.replace(/\D/g, '');
const pill = document.getElementById('phone-pill');
if (digits.length >= 10) {
  const d = digits.slice(-10);
  pill.textContent = `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

// First name pulled from localStorage for parity with home.html, though
// Drift doesn't render a greeting — we still read it so other tabs stay warm.
(localStorage.getItem(NAME_KEY) || '').trim();

// ── Helpers ─────────────────────────────────────
function formatMoney(n) {
  const rounded = Math.round(n * 100) / 100;
  const dollars = Math.floor(rounded);
  const cents = Math.round((rounded - dollars) * 100);
  return {
    dollars: '$' + dollars.toLocaleString('en-US'),
    cents: '.' + String(cents).padStart(2, '0'),
  };
}

function cleanText(raw) {
  return String(raw || '').toLowerCase().trim().replace(/[<>&"]/g, '');
}

// ── Sign out ─────────────────────────────────────
document.getElementById('signout').addEventListener('click', async () => {
  try {
    await fetch(`${API_BASE}/api/logout`, { method: 'POST', credentials: 'include' });
  } catch (_) { /* leaving anyway */ }
  localStorage.clear();
  location.href = 'index.html';
});

// ── Render ──────────────────────────────────────
function renderCard(card, slot) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card';
  el.dataset.slot = String(slot);
  el.setAttribute('aria-label',
    `${cleanText(card.institution)} ${cleanText(card.name)} card`);

  const { dollars, cents } = formatMoney(Number(card.balance) || 0);
  const institution = cleanText(card.institution) || cleanText(card.name) || 'card';
  const nickname = cleanText(card.name) || 'card';
  const maskBit = card.mask ? ` · …${card.mask}` : '';

  el.innerHTML = `
    <span class="card__inner">
      <span class="card__top">${institution}</span>
      <span class="card__balance">${dollars}<span class="cents">${cents}</span></span>
      <span class="card__bottom">${nickname}${maskBit}</span>
    </span>
  `;

  el.addEventListener('click', () => {
    el.classList.add('is-tapped');
    setTimeout(() => el.classList.remove('is-tapped'), 260);
    console.log('card clicked', card.name);
  });

  return el;
}

function renderEmpty(container) {
  container.innerHTML = `
    <div class="empty">
      <span>no cards connected yet.</span>
      <a href="connect.html">connect one →</a>
    </div>
  `;
}

function renderError(container) {
  container.innerHTML = `
    <div class="err">give us a sec — trying again in a moment.</div>
  `;
}

async function loadHome() {
  const container = document.getElementById('drift');
  try {
    const res = await fetch(`${API_BASE}/api/home`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (res.status === 401) { localStorage.clear(); location.href = 'index.html'; return; }
    if (!res.ok) throw new Error('bad response');

    const data = await res.json();
    const cards = Array.isArray(data.cards) ? data.cards : [];

    // Cache first_name if the API offers one.
    if (data.first_name) {
      try { localStorage.setItem(NAME_KEY, String(data.first_name)); } catch (_) {}
    }

    if (cards.length === 0) { renderEmpty(container); return; }

    container.innerHTML = '';
    cards.slice(0, MAX_SLOTS).forEach((c, i) => {
      container.appendChild(renderCard(c, i));
    });
  } catch (_) {
    renderError(container);
  }
}

loadHome();
