// school.js — parent-led signup funnel for the under-18 school plan.
//
// Flow (states match the data-state attributes in school.html):
//   form        → user fills 5 fields + consent.
//   verifying   → POST /api/school/start (sets cbff_school cookie, returns
//                 a Stripe SetupIntent client_secret).
//   stripe-card → mount Stripe Payment Element, parent confirms card.
//   finalizing  → POST /api/school/finalize (returns kid_login_code).
//   success     → render shareable URL with email + code prefilled.
//   ageout      → user is 18+, bounce them to the regular plan.
//
// All script lives in this file (no inline scripts — CSP).
// All API calls go to api.cashbff.com with credentials: 'include'.

const API_BASE = 'https://api.cashbff.com';

// Stripe publishable key — public by design, safe to commit (test mode).
// Swap for pk_live_… when going to production.
const STRIPE_PUBLISHABLE_KEY = 'pk_test_51TBOZ3IftBEJjqbcJZW3YtyDbLMNmkFqk80tYv0HbqAUw0apDvt8JtraxVEAWbbmisz0iceKbSItKpSRN5CqPyWH00w6lJITsa';

// ── DOM hooks ─────────────────────────────────────
const $ = (id) => document.getElementById(id);

const states = {
  form:        $('state-form'),
  verifying:   $('state-verifying'),
  stripeCard:  $('state-stripe-card'),
  finalizing:  $('state-finalizing'),
  success:     $('state-success'),
  ageout:      $('state-ageout'),
};

const banner          = $('banner');
const form            = $('school-form');
const submitBtn       = $('submit-btn');
// Hero card + copy (Phase 11 — V4-original visual revival). The card stays
// mounted across all states; we shrink it via .is-compact once the user
// posts the form so the Stripe / success panel gets vertical room. Hero
// copy hides on non-form states for the same reason.
const cardStage       = $('card-stage');
const cardName        = $('card-name');
const heroCopy        = $('hero-copy');

const parentFirstName = $('parent-first-name');
const parentEmail     = $('parent-email');
const studentFirstName = $('student-first-name');
const studentEmail    = $('student-email');
const studentDob      = $('student-dob');
const consentBox      = $('consent');
const consentNameSlot = $('consent-name-slot');

const stripeMount     = $('stripe-card-mount');
const stripeFallback  = $('stripe-fallback');
const verifyCardBtn   = $('verify-card-btn');
const cardBackLink    = $('card-back');

const ageoutBack      = $('ageout-back');

const successStudent  = $('success-student-name');
const kidLoginUrl     = $('kid-login-url');
const copyUrlBtn      = $('copy-url-btn');

// ── State machine ─────────────────────────────────
function showState(name) {
  Object.entries(states).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle('is-active', key === name);
  });
  hideBanner();
  // Compact the tilted credit-card hero once the user advances past
  // STATE_FORM so the form / Stripe / success panel gets vertical room.
  // The card stays mounted across all states for visual continuity.
  if (cardStage) {
    if (name === 'form') cardStage.classList.remove('is-compact');
    else                  cardStage.classList.add('is-compact');
  }
  // Hide the headline copy block on non-form states — the panel title
  // takes over there. Toggling .hidden keeps the layout clean (no blank
  // gap) and screen readers skip it.
  if (heroCopy) {
    heroCopy.hidden = (name !== 'form');
  }
  // Scroll back to top so the panel is the first thing they see (helps a lot
  // on small screens after the form blew off the bottom).
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
}

function showBanner(msg, kind) {
  if (!banner) return;
  banner.textContent = msg;
  banner.classList.remove('banner--info', 'banner--error');
  banner.classList.add(kind === 'error' ? 'banner--error' : 'banner--info');
  banner.hidden = false;
}
function hideBanner() {
  if (!banner) return;
  banner.hidden = true;
  banner.textContent = '';
}

// ── Validation helpers ────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ageFrom(dobStr) {
  // dobStr is YYYY-MM-DD from <input type="date">. Compute integer years.
  if (!dobStr) return null;
  const dob = new Date(dobStr + 'T00:00:00');
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

function validateForm(values) {
  if (!values.parent_first_name) return 'add your parent\'s first name.';
  if (!EMAIL_RE.test(values.parent_email)) return 'that parent email doesn\'t look right.';
  if (!values.student_first_name) return 'add your first name.';
  if (!EMAIL_RE.test(values.student_email)) return 'that student email doesn\'t look right.';
  if (values.parent_email.toLowerCase() === values.student_email.toLowerCase()) {
    return 'parent and student emails need to be different.';
  }
  const age = ageFrom(values.student_dob);
  if (age === null) return 'pick your date of birth.';
  if (age >= 18) return 'AGE_OUT';
  if (age < 5)   return 'that birthday looks off — double-check it?';
  if (!consentBox.checked) return 'your parent has to tick the consent box.';
  return null;
}

// Mirror the kid's first name into the consent label as they type — and
// into the credit-card hero's name slot, so the card visually personalises
// to "their" card the moment they identify themselves.
studentFirstName.addEventListener('input', () => {
  const v = studentFirstName.value.trim();
  if (consentNameSlot) {
    consentNameSlot.textContent = v ? v : '[student\'s name]';
  }
  if (cardName) {
    cardName.textContent = v ? v.toLowerCase() : 'your future here';
  }
});

// ── Stripe init ───────────────────────────────────
// Stripe.js is loaded from the CDN in <head>. If the key is unset or the
// script failed to load we surface an inline fallback message but still let
// the form render (so users aren't blocked from drafting their info).
const stripeKeyConfigured = STRIPE_PUBLISHABLE_KEY && !STRIPE_PUBLISHABLE_KEY.endsWith('REPLACE_ME');
const stripe = (window.Stripe && stripeKeyConfigured) ? window.Stripe(STRIPE_PUBLISHABLE_KEY) : null;
let stripeElements = null;
let stripePaymentEl = null;
let cachedClientSecret = null;

function mountStripeIfReady(clientSecret) {
  if (!stripe) {
    if (stripeFallback) stripeFallback.hidden = false;
    if (verifyCardBtn) verifyCardBtn.disabled = true;
    return false;
  }
  if (stripeFallback) stripeFallback.hidden = true;
  if (verifyCardBtn)  verifyCardBtn.disabled = false;

  // Re-mount with a fresh client_secret if we already had one (e.g. user
  // backed out and resubmitted the form). Stripe Elements doesn't support
  // updating client_secret in place, so we rebuild.
  if (stripePaymentEl) {
    try { stripePaymentEl.unmount(); } catch (_) {}
    stripePaymentEl = null;
  }
  stripeElements = stripe.elements({ clientSecret, appearance: { theme: 'flat' } });
  stripePaymentEl = stripeElements.create('payment');
  stripePaymentEl.mount('#stripe-card-mount');
  return true;
}

// ── Submit handler (form → verifying → stripe-card) ───
let submittingForm = false;
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submittingForm) return; // double-click guard

  const values = {
    parent_first_name:  parentFirstName.value.trim(),
    parent_email:       parentEmail.value.trim(),
    student_first_name: studentFirstName.value.trim(),
    student_email:      studentEmail.value.trim(),
    student_dob:        studentDob.value, // YYYY-MM-DD
  };

  const err = validateForm(values);
  if (err === 'AGE_OUT') {
    showState('ageout');
    return;
  }
  if (err) {
    showBanner(err, 'error');
    return;
  }

  submittingForm = true;
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = 'one sec…';
  showState('verifying');

  try {
    const res = await fetch(API_BASE + '/api/school/start', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.client_secret) {
      const msg = (data && data.error) || 'we couldn\'t start verification — try again in a sec.';
      // Drop the user back to the form with the error visible.
      showState('form');
      showBanner(msg, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
      submittingForm = false;
      return;
    }
    cachedClientSecret = data.client_secret;
    showState('stripeCard');
    mountStripeIfReady(cachedClientSecret);
  } catch (_) {
    showState('form');
    showBanner('network hiccup — try again?', 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    submittingForm = false;
    return;
  }
  // Re-enable the original button so a back-trip works without a stuck
  // disabled state.
  submitBtn.disabled = false;
  submitBtn.textContent = originalLabel;
  submittingForm = false;
});

// ── Stripe verify-card handler (stripe-card → finalizing) ─
let verifyingCard = false;
if (verifyCardBtn) {
  verifyCardBtn.addEventListener('click', async () => {
    if (verifyingCard) return; // double-click guard
    if (!stripe || !stripeElements) {
      showBanner('card verification isn\'t configured yet — email daksh@cashbff.com.', 'error');
      return;
    }
    verifyingCard = true;
    verifyCardBtn.disabled = true;
    const originalLabel = verifyCardBtn.textContent;
    verifyCardBtn.textContent = 'verifying…';
    hideBanner();

    try {
      const result = await stripe.confirmSetup({
        elements: stripeElements,
        redirect: 'if_required',
      });
      if (result.error) {
        showBanner(result.error.message || 'that card didn\'t verify — give it another go.', 'error');
        verifyCardBtn.disabled = false;
        verifyCardBtn.textContent = originalLabel;
        verifyingCard = false;
        return;
      }
      const si = result.setupIntent;
      if (!si || si.status !== 'succeeded') {
        showBanner('card verification didn\'t finish — try once more.', 'error');
        verifyCardBtn.disabled = false;
        verifyCardBtn.textContent = originalLabel;
        verifyingCard = false;
        return;
      }
      // Setup succeeded — move on to finalize.
      verifyCardBtn.textContent = originalLabel;
      verifyingCard = false;
      await runFinalize();
    } catch (_) {
      showBanner('network hiccup — try the card again.', 'error');
      verifyCardBtn.disabled = false;
      verifyCardBtn.textContent = originalLabel;
      verifyingCard = false;
    }
  });
}

// "back to the form" link from the stripe-card state.
if (cardBackLink) {
  cardBackLink.addEventListener('click', (e) => {
    e.preventDefault();
    showState('form');
  });
}

// ── Finalize (finalizing → success) ──────────────
async function runFinalize() {
  showState('finalizing');
  try {
    const res = await fetch(API_BASE + '/api/school/finalize', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.kid_login_code || !data.student_email) {
      const msg = (data && data.error) || 'we couldn\'t finish setup — try the card step again.';
      showState('stripeCard');
      showBanner(msg, 'error');
      return;
    }
    renderSuccess(data);
    showState('success');
  } catch (_) {
    showState('stripeCard');
    showBanner('network hiccup — give the card step one more go.', 'error');
  }
}

// ── Success render ───────────────────────────────
function renderSuccess(data) {
  const name  = (data.student_first_name || '').trim() || 'your kid';
  const email = data.student_email;
  const code  = data.kid_login_code;
  if (successStudent) successStudent.textContent = name;
  const url = 'https://cashbff.com/school/login?email='
    + encodeURIComponent(email)
    + '&code=' + encodeURIComponent(code);
  if (kidLoginUrl) {
    kidLoginUrl.value = url;
  }
}

// Copy URL button — clipboard write with a tiny visual ack.
let copyInFlight = false;
if (copyUrlBtn) {
  copyUrlBtn.addEventListener('click', async () => {
    if (copyInFlight || !kidLoginUrl) return;
    copyInFlight = true;
    const url = kidLoginUrl.value;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Fallback for older browsers / insecure contexts.
        kidLoginUrl.select();
        document.execCommand && document.execCommand('copy');
      }
      const orig = copyUrlBtn.textContent;
      copyUrlBtn.textContent = 'copied ✓';
      copyUrlBtn.classList.add('copied');
      setTimeout(() => {
        copyUrlBtn.textContent = orig;
        copyUrlBtn.classList.remove('copied');
        copyInFlight = false;
      }, 1500);
    } catch (_) {
      copyUrlBtn.textContent = 'long-press it ↑';
      setTimeout(() => {
        copyUrlBtn.textContent = 'copy';
        copyInFlight = false;
      }, 1800);
    }
  });
}

// "wrong birthday? go back" from the ageout panel.
if (ageoutBack) {
  ageoutBack.addEventListener('click', (e) => {
    e.preventDefault();
    showState('form');
  });
}

// ── Auth probe (Phase 9A) ─────────────────────────
// school.html is a marketing page — we want logged-in visitors to be able to
// browse it. If /api/me 200s we paint the floating "my home →" pill via
// auth-banner.js and stash the user; we no longer hard-redirect.
async function probeAuth() {
  let res;
  try {
    res = await fetch(API_BASE + '/api/me', { credentials: 'include' });
  } catch (_) {
    // Network blip — let the form render and they can try anyway.
    return;
  }
  if (res.status === 200) {
    let data = null;
    try { data = await res.json(); } catch (_) { data = {}; }
    window.__authedUser = data || {};
    if (typeof window.showAuthHomeButton === 'function') {
      window.showAuthHomeButton();
    }
  }
  // 401 (or anything else) → fall through, the form is already visible.
}

// Kick off the auth probe immediately on load.
probeAuth();
