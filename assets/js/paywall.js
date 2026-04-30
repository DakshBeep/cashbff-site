// ── Auth probe (Phase 9A. replaces Phase 7D redirect) ────
// paywall.html is a pre-bank-connect step in the funnel. Phase 9A no longer
// hard-redirects an authed visitor to /home.html. instead we render the
// page, hide the "start trial" CTA so they can't accidentally re-enter the
// flow, and paint the floating "my home →" pill via auth-banner.js. 401 /
// network blip lets the page render normally so the public trial flow
// still works for cold visitors.
(async function probeAuth() {
  try {
    const res = await fetch('https://api.cashbff.com/api/me', { credentials: 'include' });
    if (res.status === 200) {
      let data = null;
      try { data = await res.json(); } catch (_) { data = {}; }
      window.__authedUser = data || {};
      if (typeof window.showAuthHomeButton === 'function') {
        window.showAuthHomeButton();
      }
      if (typeof window.hidePageInteractionForAuthed === 'function') {
        window.hidePageInteractionForAuthed(['#start-btn', '.cta-wrap', '.cta-micro', '.bar__right'], {
          heading: "you're already signed in.",
          body: 'no need to start a new trial. head back to your home.',
          mountSelector: '.pcard',
        });
      }
    }
  } catch (_) {
    // Network blip. let the page render. The downstream connect step
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

// Back to plan. preserve phone
document.getElementById('back-link').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = withPhone('plan.html');
});

// Start trial. for this proto, straight to connect.
// TODO: wire Stripe checkout (create SetupIntent / Checkout Session,
// on success redirect to connect.html?phone=...).
document.getElementById('start-btn').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = withPhone('connect.html');
});

