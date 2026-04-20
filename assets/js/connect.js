// ── Config ──────────────────────────────────────
// TODO: wire real Plaid Link once OTP auth lands.
// When MOCK_MODE = false, the page will hit the real backend:
//   POST /api/create-link-token   { user_id, link_token }
//   POST /api/exchange-token      { user_id, public_token }
// For now we simulate the flow so Maya can continue to home.html.
const MOCK_MODE = true;
const API_BASE  = 'https://api.cashbff.com';

// ── Phone parsing ───────────────────────────────
const params   = new URLSearchParams(location.search);
const rawPhone = params.get('phone') || '';
const digits   = rawPhone.replace(/\D/g, '');
const phoneDigits = digits.slice(-10);
const userId  = phoneDigits ? ('user_' + phoneDigits) : 'user_anon';
const pill    = document.getElementById('phone-pill');
if (phoneDigits.length === 10) {
  pill.textContent = `+1 (${phoneDigits.slice(0,3)}) ${phoneDigits.slice(3,6)}-${phoneDigits.slice(6)}`;
}

// Skip link passes phone through
const skipLink = document.getElementById('skip-link');
skipLink.href = 'home.html' + (phoneDigits ? ('?phone=' + phoneDigits) : '');

// ── Status renderers ────────────────────────────
const statusEl = document.getElementById('status');
const statusContent = document.getElementById('status-content');
const connectBtn = document.getElementById('connect-btn');

function showLoading(msg) {
  statusEl.classList.add('show', 'status-loading');
  statusEl.classList.remove('status-error', 'status-success');
  statusContent.innerHTML = `
    <div class="status-msg">${msg || 'connecting'}</div>
    <div class="status-sub">this usually takes a few seconds</div>
    <div class="status-pulse" aria-hidden="true"></div>
  `;
}

function showSuccess(institution) {
  statusEl.classList.remove('status-loading', 'status-error');
  statusEl.classList.add('show', 'status-success');
  const name = institution ? escapeHtml(institution) : 'your bank';
  statusContent.innerHTML = `
    <div class="status-tick">✓ linked</div>
    <div class="status-sub">${name} connected — taking you home…</div>
  `;
}

function showError(msg) {
  statusEl.classList.remove('status-loading', 'status-success');
  statusEl.classList.add('show', 'status-error');
  statusContent.innerHTML = `
    <div class="status-msg" style="font-size:1.15rem">hm, that didn't work</div>
    <div class="status-sub">${escapeHtml(msg || "try again in a sec")}</div>
    <button class="retry-btn" id="retry-btn">try again</button>
  `;
  document.getElementById('retry-btn').addEventListener('click', () => {
    statusEl.classList.remove('show');
    connectBtn.disabled = false;
  });
  connectBtn.disabled = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function goHome() {
  const href = 'home.html' + (phoneDigits ? ('?phone=' + phoneDigits) : '');
  setTimeout(() => { location.href = href; }, 1500);
}

// ── Real Plaid flow (used when MOCK_MODE = false) ──
async function realPlaidFlow() {
  showLoading('connecting');
  connectBtn.disabled = true;

  let linkToken;
  try {
    const res = await fetch(API_BASE + '/api/create-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, link_token: null }),
    });
    if (!res.ok) throw new Error('link-token request failed');
    const data = await res.json();
    linkToken = data.link_token || data.linkToken;
    if (!linkToken) throw new Error('no link_token returned');
  } catch (err) {
    showError("couldn't reach the bank service — give it a moment.");
    return;
  }

  if (!window.Plaid || !window.Plaid.create) {
    showError("plaid didn't load — check your connection.");
    return;
  }

  const handler = window.Plaid.create({
    token: linkToken,
    onSuccess: async (public_token, metadata) => {
      showLoading('saving');
      try {
        const r = await fetch(API_BASE + '/api/exchange-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: userId,
            public_token: public_token,
            link_token: linkToken,
          }),
        });
        if (!r.ok) throw new Error('exchange failed');
        const inst = metadata && metadata.institution && metadata.institution.name;
        showSuccess(inst);
        goHome();
      } catch (e) {
        showError("we connected but couldn't save it — one more try?");
      }
    },
    onExit: (err) => {
      if (err) {
        showError("plaid closed before we finished — try again whenever.");
      } else {
        // User cancelled quietly — hide status, re-enable button
        statusEl.classList.remove('show');
        connectBtn.disabled = false;
      }
    },
  });
  handler.open();
}

// ── Mock flow (proto-grade) ─────────────────────
function mockPlaidFlow() {
  connectBtn.disabled = true;
  showLoading('connecting');
  setTimeout(() => {
    showSuccess('your bank');
    goHome();
  }, 2000);
}

// ── Wire the button ─────────────────────────────
connectBtn.addEventListener('click', () => {
  if (MOCK_MODE) {
    mockPlaidFlow();
  } else {
    realPlaidFlow();
  }
});
