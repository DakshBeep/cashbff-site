// connect.js — Plaid Link integration for the web onboarding flow.
//
// Lifecycle:
//   1. Page loads → confirm session via GET /api/me. 401 → redirect to verify.html.
//   2. User clicks "connect with plaid" → POST /api/plaid/link-token (cookie-authed).
//   3. Plaid.create({...}).open() opens the Plaid modal.
//   4. onSuccess(public_token, metadata) → POST /api/plaid/exchange → home.html.
//   5. onExit (user closed modal) → re-enable the button, hide loading state.
//
// All script lives in this file (no inline scripts — CSP).

const API_BASE = 'https://api.cashbff.com';

// ── DOM hooks ─────────────────────────────────────
const statusEl     = document.getElementById('status');
const statusContent = document.getElementById('status-content');
const connectBtn   = document.getElementById('connect-btn');
const phonePill    = document.getElementById('phone-pill');

// Guard against re-entrant clicks while a Link handler is already in flight
// (the Plaid SDK is happy to open multiple modals on top of each other if
// asked — that flickers and confuses users on slow networks).
let linkHandler = null;
let inFlight    = false;

// ── UI renderers ──────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function showLoading(msg) {
  statusEl.classList.add('show', 'status-loading');
  statusEl.classList.remove('status-error', 'status-success');
  statusContent.innerHTML = `
    <div class="status-msg">${escapeHtml(msg || 'connecting')}</div>
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
    <div class="status-sub">${escapeHtml(msg || 'try again in a sec')}</div>
    <button class="retry-btn" id="retry-btn">try again</button>
  `;
  const retry = document.getElementById('retry-btn');
  if (retry) {
    retry.addEventListener('click', () => {
      statusEl.classList.remove('show');
      connectBtn.disabled = false;
      inFlight = false;
    });
  }
  connectBtn.disabled = false;
  inFlight = false;
}

function clearStatus() {
  statusEl.classList.remove('show', 'status-loading', 'status-success', 'status-error');
  statusContent.innerHTML = '';
}

function renderPhonePill(phone) {
  if (!phonePill) return;
  const last4 = String(phone || '').replace(/\D/g, '').slice(-4);
  phonePill.textContent = last4 ? `···${last4} signed in` : 'signed in';
}

// ── Auth gate ─────────────────────────────────────
// /api/me returns 401 if the cbff_session cookie is missing/invalid/revoked.
// On 401 we send the user back to verify.html so they can sign in again —
// this also matches home.js's gate behavior, with verify.html as the entry
// point for the web auth flow.
async function gateAuth() {
  let res;
  try {
    res = await fetch(API_BASE + '/api/me', { credentials: 'include' });
  } catch (_) {
    showError("we couldn't reach the server — check your connection.");
    connectBtn.disabled = true;
    return null;
  }
  if (res.status === 401) {
    location.replace('verify.html');
    // Return a never-resolving promise so callers don't continue while
    // the page is mid-navigation.
    return new Promise(() => {});
  }
  if (!res.ok) {
    showError("something's off on our end — try again in a moment.");
    connectBtn.disabled = true;
    return null;
  }
  const data = await res.json().catch(() => ({}));
  renderPhonePill(data.phone);
  return data;
}

// ── Plaid Link flow ───────────────────────────────
async function startPlaidFlow() {
  if (inFlight) return;
  inFlight = true;
  connectBtn.disabled = true;
  showLoading('connecting');

  // 1. Get a fresh link token from the backend.
  let linkToken;
  try {
    const res = await fetch(API_BASE + '/api/plaid/link-token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 401) {
      location.replace('verify.html');
      return;
    }
    if (!res.ok) throw new Error('link-token request failed (' + res.status + ')');
    const data = await res.json();
    linkToken = data.link_token;
    if (!linkToken) throw new Error('no link_token returned');
  } catch (_) {
    showError("couldn't reach the bank service — give it a moment.");
    return;
  }

  // 2. SDK loaded?
  if (!window.Plaid || typeof window.Plaid.create !== 'function') {
    showError("plaid didn't load — check your connection.");
    return;
  }

  // 3. Build the handler. We re-create on each click so each attempt gets
  //    a fresh link token (Plaid tokens are short-lived and one-shot).
  try {
    linkHandler = window.Plaid.create({
      token: linkToken,
      onSuccess: handlePlaidSuccess,
      onExit:    handlePlaidExit,
      onEvent:   handlePlaidEvent,
    });
    linkHandler.open();
    // Hide the loading status once Plaid's modal is up — Plaid owns the UI.
    clearStatus();
  } catch (_) {
    showError("we couldn't open the bank picker — try again.");
  }
}

async function handlePlaidSuccess(public_token, metadata) {
  showLoading('saving');
  try {
    const res = await fetch(API_BASE + '/api/plaid/exchange', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_token: public_token, metadata: metadata }),
    });
    if (res.status === 401) {
      location.replace('verify.html');
      return;
    }
    if (!res.ok) throw new Error('exchange failed (' + res.status + ')');
    const inst = metadata && metadata.institution && metadata.institution.name;
    showSuccess(inst);
    // Give the success state a beat to land before navigating.
    setTimeout(() => { location.href = 'home.html'; }, 1500);
  } catch (_) {
    showError("we connected but couldn't save it — one more try?");
  }
}

function handlePlaidExit(err, metadata) {
  // Two paths:
  //   a) err is non-null → Plaid surfaced an error (institution timeout,
  //      MFA bailed, network blip). Show retryable copy.
  //   b) err is null    → user closed the modal voluntarily (no bank picked
  //      yet). Quietly reset the page so they can try again whenever.
  if (err) {
    showError("plaid closed before we finished — try again whenever.");
    return;
  }
  clearStatus();
  connectBtn.disabled = false;
  inFlight = false;
}

function handlePlaidEvent(eventName /*, metadata */) {
  // OPEN means the modal mounted successfully — at that point our local
  // loading copy is redundant. (We already hide it after .open() resolves
  // synchronously; this is a belt-and-braces in case of race conditions
  // on slow devices.)
  if (eventName === 'OPEN') clearStatus();
}

// ── Wire it up ────────────────────────────────────
connectBtn.addEventListener('click', () => { startPlaidFlow(); });

// Gate auth as soon as the page loads. If the user isn't signed in, they
// get bounced to verify.html before they can click anything.
gateAuth();
