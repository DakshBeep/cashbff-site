// ── Phase 7D auth gate ────────────────────────────
// paywall.html is a pre-bank-connect step. If /api/me already says the
// user is authed (and by implication has a session) they don't need to
// see this page again — drop them on /home.html. Any non-200 response
// (401, network blip) just lets the page render normally so the public
// trial flow still works for cold visitors.
(async function gateAuth() {
  try {
    const res = await fetch('https://api.cashbff.com/api/me', { credentials: 'include' });
    if (res.status === 200) location.replace('/home.html');
  } catch (_) {
    // Network blip — let the page render. The downstream connect step
    // re-checks auth before any sensitive call.
  }
})();

// ── Parse phone, preserve through navigation ────
const params = new URLSearchParams(location.search);
const rawPhone = params.get('phone') || '';
const digits = rawPhone.replace(/\D/g, '');

const pill = document.getElementById('phone-pill');
if (digits.length >= 10) {
  const d = digits.slice(-10);
  pill.textContent = `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

function withPhone(path) {
  return rawPhone ? `${path}?phone=${encodeURIComponent(rawPhone)}` : path;
}

// Back to plan — preserve phone
document.getElementById('back-link').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = withPhone('plan.html');
});

// Start trial — for this proto, straight to connect.
// TODO: wire Stripe checkout (create SetupIntent / Checkout Session,
// on success redirect to connect.html?phone=...).
document.getElementById('start-btn').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = withPhone('connect.html');
});

// Terms placeholder
document.getElementById('terms-link').addEventListener('click', (e) => {
  e.preventDefault();
  // TODO: replace with real terms page when available.
  alert('terms coming soon.');
});
