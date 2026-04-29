// index.js — Plaid-first onboarding funnel for cashbff.com.
//
// State machine (one section visible at a time):
//   STATE_CONNECT          → big "connect your bank" CTA + sign-in link.
//   STATE_PLAID            → Plaid modal owns the screen; we show a calm
//                            "connecting…" backdrop in case the modal flickers.
//   STATE_PHONE            → after exchange. Heading shows the institution.
//   STATE_OTP              → after send-otp. Single 6-digit field.
//   STATE_RETURNING_PHONE  → "already have an account" entry — talks to the
//                            existing /api/otp/* endpoints, NOT /signup/*.
//   STATE_RETURNING_OTP    → 6-digit code for returning users.
//
// Auto-redirect: at boot we hit GET /api/me. If 200 we replace into
// /home.html before painting anything (fixes the "logged-in user lands on
// the marketing page" UX bug).
//
// All API calls use credentials:'include' because cbff_session and
// cbff_signup are HttpOnly cookies on Domain=.cashbff.com.
//
// CSP-safe: no inline scripts, no eval. Plaid SDK and Sentry are
// allow-listed in vercel.json.

(function () {
  'use strict';

  const API_BASE = 'https://api.cashbff.com';

  const STATE_CONNECT          = 'connect';
  const STATE_PLAID            = 'plaid';
  const STATE_PHONE            = 'phone';
  const STATE_OTP              = 'otp';
  const STATE_RETURNING_PHONE  = 'returning-phone';
  const STATE_RETURNING_OTP    = 'returning-otp';

  // ── DOM hooks ────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const banner          = $('banner');
  const institutionName = $('institution-name');
  const phoneInput      = $('phone-input');
  const otpInput        = $('otp-input');
  const phoneDisplay    = $('phone-display');
  const sendOtpBtn      = $('send-otp-btn');
  const verifyOtpBtn    = $('verify-otp-btn');
  const connectBtn      = $('connect-btn');
  const returningLink   = $('returning-link');
  const returningPhoneInput   = $('returning-phone-input');
  const returningOtpInput     = $('returning-otp-input');
  const returningPhoneDisplay = $('returning-phone-display');
  const returningSendBtn      = $('returning-send-btn');
  const returningVerifyBtn    = $('returning-verify-btn');
  const returningBackLink     = $('returning-back');
  const resendOtpBtn          = $('resend-otp');
  const changePhoneBtn        = $('change-phone');
  const returningResendBtn    = $('returning-resend');
  const returningChangeBtn    = $('returning-change');

  // ── In-flight + transient state ─────────────────
  // `inFlight` covers the whole "starting Plaid → exchange" sequence so a
  // second click can't double-fire link-token requests. Each per-button
  // guard below covers the local CTA only.
  let inFlight = false;
  // Tracks which signup phone the user submitted (E.164) so the verify
  // call sends the right number even if they edit the field after.
  let signupPhoneE164 = null;
  // Same for the returning-user shortcut.
  let returningPhoneE164 = null;
  // Resend cooldown timer ids so re-renders don't leak intervals.
  let signupResendTimer = null;
  let returningResendTimer = null;

  // ── State machine ───────────────────────────────
  function showState(name) {
    const sections = document.querySelectorAll('.state');
    sections.forEach((s) => {
      if (s.getAttribute('data-state') === name) {
        s.classList.add('is-active');
      } else {
        s.classList.remove('is-active');
      }
    });
    // Clear any banner left over from another state.
    hideBanner();
    // Auto-focus the relevant input on entry.
    if (name === STATE_PHONE) setTimeout(() => phoneInput && phoneInput.focus(), 100);
    if (name === STATE_OTP) setTimeout(() => otpInput && otpInput.focus(), 100);
    if (name === STATE_RETURNING_PHONE) setTimeout(() => returningPhoneInput && returningPhoneInput.focus(), 100);
    if (name === STATE_RETURNING_OTP) setTimeout(() => returningOtpInput && returningOtpInput.focus(), 100);
  }

  // ── Inline banner ───────────────────────────────
  function showBanner(msg, kind) {
    if (!banner) return;
    banner.textContent = msg;
    banner.className = 'banner banner--' + (kind === 'error' ? 'error' : 'info');
    banner.hidden = false;
  }
  function hideBanner() {
    if (!banner) return;
    banner.hidden = true;
    banner.textContent = '';
  }

  // ── Helpers ─────────────────────────────────────
  function e164(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d.startsWith('1')) return '+' + d;
    if (d.length >= 8) return '+' + d;
    return null;
  }
  function maskPhone(e164Phone) {
    const d = String(e164Phone || '').replace(/\D/g, '');
    if (d.length < 10) return e164Phone || '';
    const last = d.slice(-10);
    return '+1 (' + last.slice(0, 3) + ') ' + last.slice(3, 6) + '-' + last.slice(6);
  }

  // Phone formatter — pretty-print as the user types (display only; we
  // re-extract digits on submit so paste / partial entries still work).
  function formatPhoneDisplay(input) {
    const d = String(input.value || '').replace(/\D/g, '').slice(0, 10);
    let out = d;
    if (d.length > 6) out = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
    else if (d.length > 3) out = '(' + d.slice(0, 3) + ') ' + d.slice(3);
    else if (d.length > 0) out = '(' + d;
    input.value = out;
  }

  function startResendCooldown(button, seconds, timerSlot) {
    // Returns a token that can be used to clear the cooldown if needed.
    if (!button) return;
    const original = button.textContent;
    let remaining = seconds;
    button.disabled = true;
    button.textContent = 'resend in ' + remaining + 's';
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) {
        button.disabled = false;
        button.textContent = original;
        if (timerSlot === 'signup') {
          clearInterval(signupResendTimer);
          signupResendTimer = null;
        } else {
          clearInterval(returningResendTimer);
          returningResendTimer = null;
        }
        return;
      }
      button.textContent = 'resend in ' + remaining + 's';
    };
    const id = setInterval(tick, 1000);
    if (timerSlot === 'signup') signupResendTimer = id;
    else returningResendTimer = id;
  }

  // ── Network helpers ─────────────────────────────
  async function api(method, path, body) {
    const opts = {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { ok: res.ok, status: res.status, data };
  }

  // ── Auto-redirect for already-authed users ──────
  // Run before painting the funnel. If /api/me 200s the user already has a
  // valid cbff_session — they belong on /home.html, not the landing page.
  // On 401 we just render normally. On any other error we still render so
  // the funnel is reachable even if /api/me is briefly down.
  async function autoRedirectIfLoggedIn() {
    try {
      const res = await fetch(API_BASE + '/api/me', {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        location.replace('/home.html');
        return new Promise(() => {}); // page is navigating away
      }
    } catch (_) { /* offline / DNS — render the funnel anyway */ }
    return false;
  }

  // ── Plaid SDK guard ─────────────────────────────
  // The CDN script is in the HTML <head>. If it failed to load (offline,
  // CSP misconfig) `window.Plaid` is undefined. We retry briefly so a slow
  // mobile network gets a fair shake before bailing.
  function waitForPlaid(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000);
    return new Promise((resolve) => {
      const check = () => {
        if (window.Plaid && typeof window.Plaid.create === 'function') {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) { resolve(false); return; }
        setTimeout(check, 120);
      };
      check();
    });
  }

  // ── Signup flow — Plaid Link ────────────────────
  async function startSignupFlow() {
    if (inFlight) return;
    inFlight = true;
    if (connectBtn) connectBtn.disabled = true;
    hideBanner();

    // 1. Backend mints a link_token + sets the cbff_signup cookie.
    let linkToken;
    try {
      const r = await api('POST', '/api/signup/start');
      if (!r.ok || !r.data || !r.data.link_token) {
        throw new Error('signup/start failed');
      }
      linkToken = r.data.link_token;
    } catch (_) {
      showBanner("we couldn't reach the bank service — give it a sec and try again.", 'error');
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
      return;
    }

    // 2. Make sure the Plaid SDK is loaded (handles slow CDN / iOS).
    const plaidReady = await waitForPlaid(4000);
    if (!plaidReady) {
      showBanner("plaid didn't load — check your connection and try again.", 'error');
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
      return;
    }

    // 3. Move to the in-flight state, then open Plaid.
    showState(STATE_PLAID);
    try {
      const handler = window.Plaid.create({
        token: linkToken,
        onSuccess: handlePlaidSuccess,
        onExit: handlePlaidExit,
      });
      handler.open();
    } catch (_) {
      showState(STATE_CONNECT);
      showBanner("we couldn't open the bank picker — try again.", 'error');
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
    }
  }

  async function handlePlaidSuccess(public_token, metadata) {
    // Exchange the public_token server-side. The cbff_signup cookie tells
    // the backend which signup row this Plaid item belongs to.
    try {
      const r = await api('POST', '/api/signup/exchange', { public_token: public_token });
      if (!r.ok || !r.data || r.data.ok !== true) {
        throw new Error('exchange failed');
      }
      const inst = (r.data && r.data.institution)
        || (metadata && metadata.institution && metadata.institution.name)
        || 'bank';
      if (institutionName) institutionName.textContent = String(inst).toLowerCase();
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
      showState(STATE_PHONE);
    } catch (_) {
      showState(STATE_CONNECT);
      showBanner("we connected but couldn't save it — one more try?", 'error');
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
    }
  }

  function handlePlaidExit(err /*, metadata */) {
    // Two cases:
    //   1) err is non-null → Plaid surfaced something (institution timeout,
    //      MFA bailed). We want to be friendly and let them retry.
    //   2) err is null → user closed the modal voluntarily.
    inFlight = false;
    if (connectBtn) connectBtn.disabled = false;
    // Order matters: showState clears the banner, so paint the banner AFTER
    // we transition back to the connect state.
    showState(STATE_CONNECT);
    if (err) {
      showBanner("plaid closed before we finished — try again whenever.", 'error');
    } else {
      showBanner("no worries — try again whenever.", 'info');
    }
  }

  // ── Signup flow — phone + OTP ───────────────────
  async function sendSignupOtp(phoneE164) {
    const r = await api('POST', '/api/signup/send-otp', { phone: phoneE164 });
    if (r.status === 429) {
      showBanner('slow down — too many codes. try again in a bit.', 'error');
      return false;
    }
    if (!r.ok || !r.data || r.data.ok !== true) {
      showBanner("we couldn't send the code. try again?", 'error');
      return false;
    }
    return true;
  }

  async function handleSendSignupOtp() {
    if (!sendOtpBtn || sendOtpBtn.disabled) return;
    const raw = phoneInput ? phoneInput.value : '';
    const phone = e164(raw);
    if (!phone) {
      showBanner("that number doesn't look right — give it another try?", 'error');
      return;
    }
    sendOtpBtn.disabled = true;
    const orig = sendOtpBtn.textContent;
    sendOtpBtn.textContent = 'sending…';
    hideBanner();
    const ok = await sendSignupOtp(phone);
    sendOtpBtn.disabled = false;
    sendOtpBtn.textContent = orig;
    if (!ok) return;
    signupPhoneE164 = phone;
    if (phoneDisplay) phoneDisplay.textContent = maskPhone(phone);
    showState(STATE_OTP);
    // Start the cooldown so users can't spam resend.
    startResendCooldown(resendOtpBtn, 30, 'signup');
  }

  async function handleVerifySignupOtp() {
    if (!verifyOtpBtn || verifyOtpBtn.disabled) return;
    const code = (otpInput ? otpInput.value : '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) {
      showBanner('enter all 6 digits.', 'error');
      return;
    }
    if (!signupPhoneE164) {
      // Edge case: the user reloaded the page mid-flow. Send them back.
      showBanner('your phone got cleared — start again.', 'error');
      showState(STATE_PHONE);
      return;
    }
    verifyOtpBtn.disabled = true;
    const orig = verifyOtpBtn.textContent;
    verifyOtpBtn.textContent = 'verifying…';
    hideBanner();
    try {
      const r = await api('POST', '/api/signup/verify-otp', {
        phone: signupPhoneE164, code: code,
      });
      if (!r.ok || !r.data || r.data.ok !== true) {
        showBanner("that code didn't match — try again?", 'error');
        if (otpInput) { otpInput.value = ''; otpInput.focus(); }
        verifyOtpBtn.disabled = false;
        verifyOtpBtn.textContent = orig;
        return;
      }
      // Backend tells us where to go (e.g. /home.html). Default if missing.
      const dest = (r.data && r.data.redirect) || '/home.html';
      location.href = dest;
    } catch (_) {
      showBanner('network hiccup — try again in a sec.', 'error');
      verifyOtpBtn.disabled = false;
      verifyOtpBtn.textContent = orig;
    }
  }

  async function handleResendSignupOtp() {
    if (!resendOtpBtn || resendOtpBtn.disabled) return;
    if (!signupPhoneE164) {
      showState(STATE_PHONE);
      return;
    }
    resendOtpBtn.disabled = true;
    hideBanner();
    const ok = await sendSignupOtp(signupPhoneE164);
    if (ok) {
      showBanner('new code sent.', 'info');
      startResendCooldown(resendOtpBtn, 30, 'signup');
    } else {
      resendOtpBtn.disabled = false;
    }
  }

  function handleChangeSignupPhone() {
    // Clear the OTP field but keep the phone so they can edit it.
    if (otpInput) otpInput.value = '';
    if (signupResendTimer) {
      clearInterval(signupResendTimer);
      signupResendTimer = null;
      if (resendOtpBtn) {
        resendOtpBtn.disabled = false;
        resendOtpBtn.textContent = "didn't get it? resend";
      }
    }
    showState(STATE_PHONE);
  }

  // ── Returning-user flow ─────────────────────────
  // Uses the existing /api/otp/* endpoints (NOT /signup/*) because those are
  // signup-only. The verify response sets cbff_session directly.
  async function handleReturningStart() {
    showState(STATE_RETURNING_PHONE);
  }

  async function sendReturningOtp(phoneE164Local) {
    const r = await api('POST', '/api/otp/send', { phone: phoneE164Local });
    if (r.status === 429) {
      showBanner('slow down — too many codes. try again in a bit.', 'error');
      return false;
    }
    if (!r.ok) {
      showBanner("we couldn't send the code. try again?", 'error');
      return false;
    }
    return true;
  }

  async function handleSendReturningOtp() {
    if (!returningSendBtn || returningSendBtn.disabled) return;
    const raw = returningPhoneInput ? returningPhoneInput.value : '';
    const phone = e164(raw);
    if (!phone) {
      showBanner("that number doesn't look right — give it another try?", 'error');
      return;
    }
    returningSendBtn.disabled = true;
    const orig = returningSendBtn.textContent;
    returningSendBtn.textContent = 'sending…';
    hideBanner();
    const ok = await sendReturningOtp(phone);
    returningSendBtn.disabled = false;
    returningSendBtn.textContent = orig;
    if (!ok) return;
    returningPhoneE164 = phone;
    if (returningPhoneDisplay) returningPhoneDisplay.textContent = maskPhone(phone);
    showState(STATE_RETURNING_OTP);
    startResendCooldown(returningResendBtn, 30, 'returning');
  }

  async function handleVerifyReturningOtp() {
    if (!returningVerifyBtn || returningVerifyBtn.disabled) return;
    const code = (returningOtpInput ? returningOtpInput.value : '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) {
      showBanner('enter all 6 digits.', 'error');
      return;
    }
    if (!returningPhoneE164) {
      showBanner('your phone got cleared — start again.', 'error');
      showState(STATE_RETURNING_PHONE);
      return;
    }
    returningVerifyBtn.disabled = true;
    const orig = returningVerifyBtn.textContent;
    returningVerifyBtn.textContent = 'verifying…';
    hideBanner();
    try {
      const r = await api('POST', '/api/otp/verify', {
        phone: returningPhoneE164, code: code,
      });
      if (!r.ok || !r.data || r.data.ok !== true) {
        showBanner("that code didn't match — try again?", 'error');
        if (returningOtpInput) { returningOtpInput.value = ''; returningOtpInput.focus(); }
        returningVerifyBtn.disabled = false;
        returningVerifyBtn.textContent = orig;
        return;
      }
      // Returning users always go home — their session is set.
      location.href = '/home.html';
    } catch (_) {
      showBanner('network hiccup — try again in a sec.', 'error');
      returningVerifyBtn.disabled = false;
      returningVerifyBtn.textContent = orig;
    }
  }

  async function handleResendReturningOtp() {
    if (!returningResendBtn || returningResendBtn.disabled) return;
    if (!returningPhoneE164) {
      showState(STATE_RETURNING_PHONE);
      return;
    }
    returningResendBtn.disabled = true;
    hideBanner();
    const ok = await sendReturningOtp(returningPhoneE164);
    if (ok) {
      showBanner('new code sent.', 'info');
      startResendCooldown(returningResendBtn, 30, 'returning');
    } else {
      returningResendBtn.disabled = false;
    }
  }

  function handleChangeReturningPhone() {
    if (returningOtpInput) returningOtpInput.value = '';
    if (returningResendTimer) {
      clearInterval(returningResendTimer);
      returningResendTimer = null;
      if (returningResendBtn) {
        returningResendBtn.disabled = false;
        returningResendBtn.textContent = "didn't get it? resend";
      }
    }
    showState(STATE_RETURNING_PHONE);
  }

  // ── Wire up ─────────────────────────────────────
  function wire() {
    if (connectBtn) connectBtn.addEventListener('click', startSignupFlow);
    if (returningLink) returningLink.addEventListener('click', handleReturningStart);

    // Phone formatters — pretty-print as user types.
    if (phoneInput) {
      phoneInput.addEventListener('input', () => formatPhoneDisplay(phoneInput));
      // Pressing Enter inside the form submits the send-otp action.
      phoneInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleSendSignupOtp(); }
      });
    }
    if (returningPhoneInput) {
      returningPhoneInput.addEventListener('input', () => formatPhoneDisplay(returningPhoneInput));
      returningPhoneInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleSendReturningOtp(); }
      });
    }

    // OTP fields — strip non-digits + auto-submit on 6.
    if (otpInput) {
      otpInput.addEventListener('input', () => {
        const cleaned = otpInput.value.replace(/\D/g, '').slice(0, 6);
        if (cleaned !== otpInput.value) otpInput.value = cleaned;
        if (cleaned.length === 6) handleVerifySignupOtp();
      });
      otpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleVerifySignupOtp(); }
      });
    }
    if (returningOtpInput) {
      returningOtpInput.addEventListener('input', () => {
        const cleaned = returningOtpInput.value.replace(/\D/g, '').slice(0, 6);
        if (cleaned !== returningOtpInput.value) returningOtpInput.value = cleaned;
        if (cleaned.length === 6) handleVerifyReturningOtp();
      });
      returningOtpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleVerifyReturningOtp(); }
      });
    }

    if (sendOtpBtn) sendOtpBtn.addEventListener('click', handleSendSignupOtp);
    if (verifyOtpBtn) verifyOtpBtn.addEventListener('click', handleVerifySignupOtp);
    if (resendOtpBtn) resendOtpBtn.addEventListener('click', handleResendSignupOtp);
    if (changePhoneBtn) changePhoneBtn.addEventListener('click', handleChangeSignupPhone);

    if (returningSendBtn) returningSendBtn.addEventListener('click', handleSendReturningOtp);
    if (returningVerifyBtn) returningVerifyBtn.addEventListener('click', handleVerifyReturningOtp);
    if (returningResendBtn) returningResendBtn.addEventListener('click', handleResendReturningOtp);
    if (returningChangeBtn) returningChangeBtn.addEventListener('click', handleChangeReturningPhone);
    if (returningBackLink) returningBackLink.addEventListener('click', () => showState(STATE_CONNECT));
  }

  // ── Boot ────────────────────────────────────────
  // Order matters: gate first (so logged-in users never see the funnel),
  // then wire events. The gate may navigate away, in which case wire() is
  // moot — but it's still cheap.
  (async function boot() {
    await autoRedirectIfLoggedIn();
    wire();
  })();

  // Test hook — only exposed in non-prod-like environments. Some Playwright
  // mocks need to skip the auto-redirect or peek at the state machine. We
  // gate this behind a query param so prod users never see it.
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('__cbff_test') === '1') {
      window.__cbffIndex = {
        showState,
        showBanner,
        hideBanner,
        STATE_CONNECT, STATE_PLAID, STATE_PHONE, STATE_OTP,
        STATE_RETURNING_PHONE, STATE_RETURNING_OTP,
      };
    }
  } catch (_) { /* ignore */ }
})();
