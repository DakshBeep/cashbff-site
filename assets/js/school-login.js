// school-login.js — companion login page for kids on the school plan.
//
// Flow:
//   1. Page loads → check /api/me. If already authed:
//        - school account → /home.html
//        - phone account  → friendly nudge to cashbff.com
//      If 401 → render the form, prefill email + code from URL params.
//   2. User submits → POST /api/school/login → on 200, follow redirect.
//
// All script lives in this file (no inline scripts — CSP).

const API_BASE = 'https://api.cashbff.com';

const $ = (id) => document.getElementById(id);

const banner   = $('banner');
const form     = $('login-form');
const emailEl  = $('student_email');
const codeEl   = $('kid_code');
const loginBtn = $('login-btn');

// ── Banner helpers ────────────────────────────────
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

// ── Prefill from query string ─────────────────────
// The success state on /school sends parents to a URL like
//   /school/login?email=foo@bar.com&code=ABCD1234
// so the kid can just open it and tap "log in" without typing.
(function prefillFromQuery() {
  try {
    const params = new URLSearchParams(location.search);
    const qEmail = params.get('email');
    const qCode  = params.get('code');
    if (qEmail && emailEl && !emailEl.value) emailEl.value = qEmail;
    if (qCode  && codeEl  && !codeEl.value)  codeEl.value  = qCode.toUpperCase();
  } catch (_) {
    // Ignore — params just won't get prefilled.
  }
})();

// Code field nicety: uppercase + strip whitespace as the user types.
if (codeEl) {
  codeEl.addEventListener('input', () => {
    const cleaned = codeEl.value.replace(/\s+/g, '').toUpperCase();
    if (cleaned !== codeEl.value) codeEl.value = cleaned;
  });
}

// ── Auth probe (Phase 9A) ─────────────────────────
// school-login is a "functional flow" page — it lets a kid trade an
// email + code for a session. If they're already authed we no longer
// hard-redirect; we let the page render but disable the login form
// (so they can't accidentally re-trigger /api/school/login) and surface
// the floating "my home →" pill so they can jump back with one tap.
async function probeAuth() {
  let res;
  try {
    res = await fetch(API_BASE + '/api/me', { credentials: 'include' });
  } catch (_) {
    // Network blip — let the form render so they can try anyway.
    return;
  }
  if (res.status === 200) {
    let data = {};
    try { data = await res.json(); } catch (_) {}
    window.__authedUser = data || {};
    if (typeof window.showAuthHomeButton === 'function') {
      window.showAuthHomeButton();
    }
    const userId = (data && data.user_id) || '';
    const accountType = (data && data.account_type) || '';
    const isSchool = accountType === 'school' || (typeof userId === 'string' && userId.startsWith('school_'));
    if (isSchool) {
      // Disable the form and show a friendly inline "you're signed in" note.
      if (typeof window.hidePageInteractionForAuthed === 'function') {
        window.hidePageInteractionForAuthed(['#login-form'], {
          heading: "you're already signed in.",
          body: 'jump back to your home whenever you\'re ready.',
          mountSelector: '.sub',
        });
      } else {
        if (loginBtn) loginBtn.disabled = true;
        if (emailEl)  emailEl.disabled  = true;
        if (codeEl)   codeEl.disabled   = true;
      }
      return;
    }
    // 200 but not a school account — phone-account user landed on the wrong
    // page. Don't bounce them; show a friendly message instead.
    showBanner(
      'you\'re signed in to a phone account already — head to cashbff.com instead.',
      'info'
    );
    if (loginBtn) loginBtn.disabled = true;
    if (emailEl)  emailEl.disabled  = true;
    if (codeEl)   codeEl.disabled   = true;
    return;
  }
  // 401 (or anything else) → render form (already visible).
}

// ── Submit handler ────────────────────────────────
let submitting = false;
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting) return; // double-click guard

  const email = (emailEl.value || '').trim().toLowerCase();
  const code  = (codeEl.value  || '').trim().toUpperCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showBanner('that email doesn\'t look right — double-check it?', 'error');
    return;
  }
  if (!code || code.length < 6) {
    showBanner('your code is 8 characters — double-check it?', 'error');
    return;
  }

  submitting = true;
  loginBtn.disabled = true;
  const originalLabel = loginBtn.textContent;
  loginBtn.textContent = 'logging in…';
  hideBanner();

  try {
    const res = await fetch(API_BASE + '/api/school/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const msg = (data && data.error)
        || (res.status === 429 ? 'too many tries — wait a moment and try again.'
        :  res.status === 401 ? 'that email and code didn\'t match — try once more.'
        :  'we couldn\'t log you in — try again in a sec.');
      showBanner(msg, 'error');
      loginBtn.disabled = false;
      loginBtn.textContent = originalLabel;
      submitting = false;
      return;
    }
    const dest = data.redirect || '/home.html';
    location.href = dest;
  } catch (_) {
    showBanner('network hiccup — try again.', 'error');
    loginBtn.disabled = false;
    loginBtn.textContent = originalLabel;
    submitting = false;
  }
});

probeAuth();
