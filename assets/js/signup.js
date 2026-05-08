// signup.js. Lowest-friction subscribe order for cashbff.com.
//
// New state machine (the FRONT lane):
//   STATE_PHONE   → user enters their phone. /api/otp/send → STATE_OTP
//   STATE_OTP     → user enters 6-digit code. /api/otp/verify → cookie set
//                   + account created → STATE_TRIAL
//   STATE_TRIAL   → "start free trial" → fetch /api/me to grab user_id, then
//                   navigate the SAME tab to the Stripe Payment Link with
//                   ?client_reference_id=<uid> appended. After Stripe, it
//                   redirects back to /signup?subscribed=1 → smart routing
//                   puts the user in STATE_PLAID.
//   STATE_PLAID   → "connect your bank" opens Plaid Link. Same /api/signup/start
//                   + /api/signup/exchange flow as before. On success → STATE_CLAUDE
//   STATE_CLAUDE  → "open in claude" copies the MCP URL to clipboard +
//                   opens claude.ai's connector dialog in a new tab.
//
// Returning lane (preserved):
//   STATE_RETURNING_PHONE / STATE_RETURNING_OTP → straight /api/otp/* sign-in
//   for users who already have an account. Lands them on /home or the safe ?next.
//
// Smart routing on page load:
//   1. read URL params (?step=, ?subscribed=, ?next=)
//   2. call /api/me with credentials:'include'
//   3. branch on auth + (talk_status, has_bank) to pick the starting state
//
// All API calls use credentials:'include' because cbff_session and
// cbff_signup are HttpOnly cookies on Domain=.cashbff.com.
//
// CSP-safe: no inline scripts, no eval. Plaid SDK + Sentry are allow-listed
// in vercel.json.

(function () {
  'use strict';

  const API_BASE = 'https://api.cashbff.com';
  const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/14A9ATdOeen7aKA8BT1sQ01';
  const MCP_URL = 'https://api.cashbff.com/mcp';
  const CLAUDE_CONNECTOR_URL = 'https://claude.ai/settings/connectors?modal=add-custom-connector';

  // ── states ──────────────────────────────────────
  const STATE_PHONE            = 'phone';
  const STATE_OTP              = 'otp';
  const STATE_TRIAL            = 'trial';
  const STATE_PLAID            = 'plaid';
  const STATE_CLAUDE           = 'claude';
  const STATE_RETURNING_PHONE  = 'returning-phone';
  const STATE_RETURNING_OTP    = 'returning-otp';

  // Forward-flow order. used to drive the progress dots.
  const FORWARD_FLOW = [STATE_PHONE, STATE_OTP, STATE_TRIAL, STATE_PLAID, STATE_CLAUDE];
  // Map state → which progress dot index to highlight (phone+otp share dot 0).
  const PROGRESS_INDEX = {
    [STATE_PHONE]:  0,
    [STATE_OTP]:    0,
    [STATE_TRIAL]:  1,
    [STATE_PLAID]:  2,
    [STATE_CLAUDE]: 3,
  };

  // ── DOM hooks ────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const banner          = $('banner');
  const progressEl      = $('progress');

  const phoneInput      = $('phone-input');
  const otpInput        = $('otp-input');
  const phoneDisplay    = $('phone-display');
  const sendOtpBtn      = $('send-otp-btn');
  const verifyOtpBtn    = $('verify-otp-btn');
  const resendOtpBtn    = $('resend-otp');
  const changePhoneBtn  = $('change-phone');
  const returningLink   = $('returning-link');

  const trialBtn        = $('trial-btn');
  const connectBtn      = $('connect-btn');
  const plaidFlight     = $('plaid-flight');
  const plaidEmpty      = $('plaid-empty');
  const plaidList       = $('plaid-list');
  const bankList        = $('bank-list');
  const addAnotherBtn   = $('add-another-btn');
  const plaidContinueBtn = $('plaid-continue-btn');
  const claudeBtn       = $('claude-btn');
  const toast           = $('toast');

  const returningPhoneInput   = $('returning-phone-input');
  const returningOtpInput     = $('returning-otp-input');
  const returningPhoneDisplay = $('returning-phone-display');
  const returningSendBtn      = $('returning-send-btn');
  const returningVerifyBtn    = $('returning-verify-btn');
  const returningResendBtn    = $('returning-resend');
  const returningChangeBtn    = $('returning-change');
  const returningBackLink     = $('returning-back');

  // ── transient state ─────────────────────────────
  // `inFlight` covers Plaid Link's "starting → exchange" sequence so a
  // double-click can't double-fire link-token requests.
  let inFlight = false;
  let signupPhoneE164 = null;
  let returningPhoneE164 = null;
  let signupResendTimer = null;
  let returningResendTimer = null;
  // Cached user_id from /api/me, used to attach client_reference_id to the
  // Stripe Payment Link so we can stitch the checkout back to our user.
  let cachedUserId = null;

  // ── PostHog tracking helper ─────────────────────
  function track(event, props) {
    try {
      if (window.posthog && typeof window.posthog.capture === 'function') {
        window.posthog.capture(event, props || {});
      }
    } catch (_) { /* never let analytics break the funnel */ }
  }

  // ── State machine ───────────────────────────────
  function showState(name) {
    const sections = document.querySelectorAll('.state');
    sections.forEach((s) => {
      if (s.getAttribute('data-state') === name) s.classList.add('is-active');
      else s.classList.remove('is-active');
    });
    hideBanner();
    paintProgress(name);

    // Auto-focus the relevant input on entry.
    if (name === STATE_PHONE)            setTimeout(() => phoneInput && phoneInput.focus(), 100);
    if (name === STATE_OTP)              setTimeout(() => otpInput && otpInput.focus(), 100);
    if (name === STATE_RETURNING_PHONE)  setTimeout(() => returningPhoneInput && returningPhoneInput.focus(), 100);
    if (name === STATE_RETURNING_OTP)    setTimeout(() => returningOtpInput && returningOtpInput.focus(), 100);
  }

  function paintProgress(stateName) {
    if (!progressEl) return;
    // Returning lane has no progress dots.
    const isReturning = stateName === STATE_RETURNING_PHONE || stateName === STATE_RETURNING_OTP;
    progressEl.hidden = isReturning;
    if (isReturning) return;

    const activeIdx = PROGRESS_INDEX[stateName];
    if (activeIdx === undefined) { progressEl.hidden = true; return; }
    const dots = progressEl.querySelectorAll('.progress__dot');
    dots.forEach((dot, i) => {
      dot.classList.remove('is-active', 'is-done');
      if (i < activeIdx) dot.classList.add('is-done');
      else if (i === activeIdx) dot.classList.add('is-active');
    });
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

  function showToast(msg) {
    if (!toast) return;
    if (msg) toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2400);
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
  function formatPhoneDisplay(input) {
    const d = String(input.value || '').replace(/\D/g, '').slice(0, 10);
    let out = d;
    if (d.length > 6) out = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
    else if (d.length > 3) out = '(' + d.slice(0, 3) + ') ' + d.slice(3);
    else if (d.length > 0) out = '(' + d;
    input.value = out;
  }

  function startResendCooldown(button, seconds, slot) {
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
        if (slot === 'signup') { clearInterval(signupResendTimer); signupResendTimer = null; }
        else                   { clearInterval(returningResendTimer); returningResendTimer = null; }
        return;
      }
      button.textContent = 'resend in ' + remaining + 's';
    };
    const id = setInterval(tick, 1000);
    if (slot === 'signup') signupResendTimer = id;
    else                   returningResendTimer = id;
  }

  // Returns a `?next=…` value only if it's a same-origin path.
  function safeNextFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const nextRaw = params.get('next');
    return (typeof nextRaw === 'string' && nextRaw.startsWith('/')) ? nextRaw : null;
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

  // ── /api/me probe. Returns { ok, status, data }. ─
  async function fetchMe() {
    try {
      const res = await fetch(API_BASE + '/api/me', {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      return { ok: res.ok, status: res.status, data: data || {} };
    } catch (_) {
      return { ok: false, status: 0, data: {} };
    }
  }

  // ── Plaid SDK guard ─────────────────────────────
  function waitForPlaid(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000);
    return new Promise((resolve) => {
      const check = () => {
        if (window.Plaid && typeof window.Plaid.create === 'function') { resolve(true); return; }
        if (Date.now() >= deadline) { resolve(false); return; }
        setTimeout(check, 120);
      };
      check();
    });
  }

  // ── STATE_PHONE: send signup OTP ────────────────
  // Note: with the new flow, a signup user hits /api/otp/send (NOT
  // /api/signup/send-otp) so the same OTP code path creates the account on
  // verify. The legacy /api/signup/* endpoints are only used by Plaid Link.
  async function sendOtp(phoneE164) {
    const r = await api('POST', '/api/otp/send', { phone: phoneE164 });
    if (r.status === 429) {
      showBanner('slow down. too many codes. try again in a bit.', 'error');
      return false;
    }
    if (!r.ok) {
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
      showBanner("that number doesn't look right. give it another try?", 'error');
      return;
    }
    sendOtpBtn.disabled = true;
    const orig = sendOtpBtn.textContent;
    sendOtpBtn.textContent = 'sending…';
    hideBanner();
    const ok = await sendOtp(phone);
    sendOtpBtn.disabled = false;
    sendOtpBtn.textContent = orig;
    if (!ok) return;
    signupPhoneE164 = phone;
    if (phoneDisplay) phoneDisplay.textContent = maskPhone(phone);
    track('signup_phone_submitted', {});
    showState(STATE_OTP);
    startResendCooldown(resendOtpBtn, 30, 'signup');
  }

  // ── STATE_OTP: verify code → STATE_TRIAL ────────
  async function handleVerifySignupOtp() {
    if (!verifyOtpBtn || verifyOtpBtn.disabled) return;
    const code = (otpInput ? otpInput.value : '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) {
      showBanner('enter all 6 digits.', 'error');
      return;
    }
    if (!signupPhoneE164) {
      showBanner('your phone got cleared. start again.', 'error');
      showState(STATE_PHONE);
      return;
    }
    verifyOtpBtn.disabled = true;
    const orig = verifyOtpBtn.textContent;
    verifyOtpBtn.textContent = 'verifying…';
    hideBanner();
    try {
      const r = await api('POST', '/api/otp/verify', {
        phone: signupPhoneE164, code: code,
      });
      if (!r.ok || !r.data || r.data.ok !== true) {
        showBanner("that code didn't match. try again?", 'error');
        if (otpInput) { otpInput.value = ''; otpInput.focus(); }
        verifyOtpBtn.disabled = false;
        verifyOtpBtn.textContent = orig;
        return;
      }
      // Cookie is now set. Hand off to the trial step.
      track('signup_otp_verified', {});
      // Pre-fetch /api/me so the Stripe button is instant when the user clicks.
      fetchMe().then((me) => {
        if (me.ok && me.data && me.data.user_id) cachedUserId = me.data.user_id;
      }).catch(() => {});
      showState(STATE_TRIAL);
      verifyOtpBtn.disabled = false;
      verifyOtpBtn.textContent = orig;
    } catch (_) {
      showBanner('network hiccup. try again in a sec.', 'error');
      verifyOtpBtn.disabled = false;
      verifyOtpBtn.textContent = orig;
    }
  }

  async function handleResendSignupOtp() {
    if (!resendOtpBtn || resendOtpBtn.disabled) return;
    if (!signupPhoneE164) { showState(STATE_PHONE); return; }
    resendOtpBtn.disabled = true;
    hideBanner();
    const ok = await sendOtp(signupPhoneE164);
    if (ok) {
      showBanner('new code sent.', 'info');
      startResendCooldown(resendOtpBtn, 30, 'signup');
    } else {
      resendOtpBtn.disabled = false;
    }
  }

  function handleChangeSignupPhone() {
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

  // ── STATE_TRIAL: stripe payment link, SAME tab ──
  async function handleStartTrial() {
    if (!trialBtn || trialBtn.disabled) return;
    trialBtn.disabled = true;
    const orig = trialBtn.textContent;
    trialBtn.textContent = 'opening…';
    hideBanner();

    // Prefer the cached user_id; fall back to /api/me if it isn't there yet.
    let uid = cachedUserId;
    if (!uid) {
      const me = await fetchMe();
      if (me.ok && me.data && me.data.user_id) uid = me.data.user_id;
    }

    track('signup_trial_started', { has_user_id: Boolean(uid) });

    let url = STRIPE_PAYMENT_LINK;
    if (uid) {
      const sep = url.includes('?') ? '&' : '?';
      url = url + sep + 'client_reference_id=' + encodeURIComponent(uid);
    }
    // SAME-tab navigation: the redirect from Stripe lands back on /signup?subscribed=1
    // and our smart routing pushes the user into STATE_PLAID.
    window.location.href = url;
  }

  // ── STATE_PLAID: bank list rendering ────────────
  // Toggles between empty + list sub-views and renders #bank-list items
  // from a banks[] array (each: { item_id, institution, mask }).
  function renderBankList(banks) {
    const list = Array.isArray(banks) ? banks : [];
    if (!plaidEmpty || !plaidList || !bankList) return;

    if (list.length === 0) {
      plaidEmpty.hidden = false;
      plaidList.hidden = true;
      return;
    }

    // Clear all but the eyebrow header (.bank-list__head), then re-append items.
    const head = bankList.querySelector('.bank-list__head');
    while (bankList.firstChild) bankList.removeChild(bankList.firstChild);
    if (head) bankList.appendChild(head);

    list.forEach((b) => {
      if (!b) return;
      const row = document.createElement('div');
      row.className = 'bank-list__item';
      const inst = String(b.institution || 'your bank').toLowerCase();
      row.appendChild(document.createTextNode(inst));
      if (b.mask) {
        const m = document.createElement('span');
        m.className = 'bank-list__mask';
        m.textContent = '····' + String(b.mask);
        row.appendChild(m);
      }
      bankList.appendChild(row);
    });

    plaidEmpty.hidden = true;
    plaidList.hidden = false;
  }

  // Pull /api/me and refresh the bank list. Used after every Plaid success
  // and on STATE_PLAID entry so the user always sees the current set.
  async function refreshBankList() {
    const me = await fetchMe();
    const banks = (me.ok && me.data && Array.isArray(me.data.banks)) ? me.data.banks : [];
    renderBankList(banks);
    return banks;
  }

  // ── STATE_PLAID: link token + Plaid Link ────────
  async function startPlaidFlow() {
    if (inFlight) return;
    inFlight = true;
    if (connectBtn) connectBtn.disabled = true;
    if (addAnotherBtn) addAnotherBtn.disabled = true;
    hideBanner();

    let linkToken;
    try {
      const r = await api('POST', '/api/signup/start');
      if (!r.ok || !r.data || !r.data.link_token) throw new Error('signup/start failed');
      linkToken = r.data.link_token;
    } catch (_) {
      showBanner("we couldn't reach the bank service. give it a sec and try again.", 'error');
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
      if (addAnotherBtn) addAnotherBtn.disabled = false;
      return;
    }

    const plaidReady = await waitForPlaid(4000);
    if (!plaidReady) {
      showBanner("the bank picker didn't load. check your connection and try again.", 'error');
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
      if (addAnotherBtn) addAnotherBtn.disabled = false;
      return;
    }

    // Reveal the in-flight overlay so users see something happening even if
    // Plaid's modal flickers on slower devices.
    if (plaidFlight) plaidFlight.hidden = false;

    try {
      const handler = window.Plaid.create({
        token: linkToken,
        onSuccess: handlePlaidSuccess,
        onExit: handlePlaidExit,
      });
      handler.open();
    } catch (_) {
      if (plaidFlight) plaidFlight.hidden = true;
      showBanner("we couldn't open the bank picker. try again.", 'error');
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
      if (addAnotherBtn) addAnotherBtn.disabled = false;
    }
  }

  async function handlePlaidSuccess(public_token /*, metadata */) {
    try {
      const r = await api('POST', '/api/signup/exchange', { public_token: public_token });
      if (!r.ok || !r.data || r.data.ok !== true) throw new Error('exchange failed');
      track('signup_plaid_connected', {});
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
      if (addAnotherBtn) addAnotherBtn.disabled = false;
      if (plaidFlight) plaidFlight.hidden = true;
      // Stay on STATE_PLAID. Refresh the list so the user can see what's
      // linked + decide whether to add more or continue.
      await refreshBankList();
    } catch (_) {
      if (plaidFlight) plaidFlight.hidden = true;
      showBanner("we connected but couldn't save it. one more try?", 'error');
      inFlight = false;
      if (connectBtn) connectBtn.disabled = false;
      if (addAnotherBtn) addAnotherBtn.disabled = false;
    }
  }

  function handlePlaidExit(err /*, metadata */) {
    inFlight = false;
    if (connectBtn) connectBtn.disabled = false;
    if (addAnotherBtn) addAnotherBtn.disabled = false;
    if (plaidFlight) plaidFlight.hidden = true;
    if (err) showBanner("the bank picker closed before we finished. try again whenever.", 'error');
    else     showBanner("no worries. try again whenever.", 'info');
  }

  // Continue button: advance to STATE_CLAUDE.
  function handlePlaidContinue() {
    track('signup_plaid_continued', {});
    showState(STATE_CLAUDE);
  }

  // ── STATE_CLAUDE: copy MCP url + open connector ─
  async function handleOpenInClaude() {
    if (!claudeBtn) return;
    // Try modern Clipboard API first; fall back to legacy execCommand for
    // older browsers. Either way we open the dialog so the user can paste.
    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(MCP_URL);
        copied = true;
      }
    } catch (_) { /* fall through to legacy */ }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = MCP_URL;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copied = true;
      } catch (_) { /* clipboard blocked. open the dialog anyway. */ }
    }
    if (copied) showToast('url copied. paste it in the claude.ai dialog.');
    track('signup_claude_added', { copied: copied });
    window.open(CLAUDE_CONNECTOR_URL, '_blank', 'noopener');
  }

  // ── Returning lane ──────────────────────────────
  function handleReturningStart() {
    showState(STATE_RETURNING_PHONE);
  }

  async function sendReturningOtp(phoneE164Local) {
    const r = await api('POST', '/api/otp/send', { phone: phoneE164Local });
    if (r.status === 429) {
      showBanner('slow down. too many codes. try again in a bit.', 'error');
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
      showBanner("that number doesn't look right. give it another try?", 'error');
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
      showBanner('your phone got cleared. start again.', 'error');
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
        showBanner("that code didn't match. try again?", 'error');
        if (returningOtpInput) { returningOtpInput.value = ''; returningOtpInput.focus(); }
        returningVerifyBtn.disabled = false;
        returningVerifyBtn.textContent = orig;
        return;
      }
      // Returning users skip the funnel entirely. Honor ?next=… (path-only)
      // else send them to /home.
      const nextDest = safeNextFromUrl();
      location.href = nextDest || '/home';
    } catch (_) {
      showBanner('network hiccup. try again in a sec.', 'error');
      returningVerifyBtn.disabled = false;
      returningVerifyBtn.textContent = orig;
    }
  }

  async function handleResendReturningOtp() {
    if (!returningResendBtn || returningResendBtn.disabled) return;
    if (!returningPhoneE164) { showState(STATE_RETURNING_PHONE); return; }
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

  // ── Smart routing on page load ──────────────────
  // Decision tree:
  //   /api/me 401                                    → STATE_PHONE
  //   /api/me 200 + ?subscribed=1                    → STATE_PLAID (empty view)
  //   /api/me 200 + ?step=plaid                      → STATE_PLAID (list view if banks)
  //   /api/me 200 + ?step=claude                     → STATE_CLAUDE
  //   /api/me 200 + trialing/active + has_bank       → /home (full setup, direct hit)
  //   /api/me 200 + trialing/active + no bank        → STATE_PLAID (empty)
  //   /api/me 200 + no/none talk_status              → STATE_TRIAL
  // /api/me failures (network etc) fall back to STATE_PHONE.
  async function decideStartingState() {
    const params = new URLSearchParams(window.location.search);
    const stepParam      = params.get('step');
    const justSubscribed = params.get('subscribed') === '1';

    const me = await fetchMe();

    if (me.status === 401 || !me.ok) {
      // Anonymous (or network blip). Start at the top of the funnel.
      showState(STATE_PHONE);
      // Auto-paint the auth-banner pill if a session shows up later.
      try { if (typeof window.showAuthHomeButton === 'function') window.showAuthHomeButton(); } catch (_) {}
      return;
    }

    // We have a session. Cache user_id for the Stripe handoff.
    if (me.data && me.data.user_id) cachedUserId = me.data.user_id;
    window.__authedUser = me.data || {};
    try { if (typeof window.showAuthHomeButton === 'function') window.showAuthHomeButton(); } catch (_) {}

    const status  = me.data && me.data.talk_status ? String(me.data.talk_status).toLowerCase() : null;
    const hasBank = !!(me.data && me.data.has_bank);
    const banks   = (me.data && Array.isArray(me.data.banks)) ? me.data.banks : [];
    const subscribed = status === 'trialing' || status === 'active';

    // Just came back from Stripe checkout: force the empty state — they
    // just paid and it's time for their first bank, even if some stale
    // banks[] data exists.
    if (justSubscribed) {
      renderBankList([]);
      showState(STATE_PLAID);
      return;
    }

    // Explicit ?step=plaid: show STATE_PLAID with whatever banks are linked
    // (so a user coming back from /home can add more).
    if (stepParam === 'plaid') {
      renderBankList(banks);
      showState(STATE_PLAID);
      return;
    }
    if (stepParam === 'claude') { showState(STATE_CLAUDE); return; }

    // Fully set up: subscribe + bank linked → bounce to home (or ?next).
    // Direct /signup hit, no ?step=, no ?subscribed=1.
    if (subscribed && hasBank) {
      const nextDest = safeNextFromUrl();
      location.href = nextDest || '/home';
      return;
    }

    // Subscribed but no bank yet → connect bank (empty view).
    if (subscribed && !hasBank) {
      renderBankList([]);
      showState(STATE_PLAID);
      return;
    }

    // Authed but no subscription → trial pitch.
    showState(STATE_TRIAL);
  }

  // ── Wire up ─────────────────────────────────────
  function wire() {
    // STATE_PHONE
    if (sendOtpBtn) sendOtpBtn.addEventListener('click', handleSendSignupOtp);
    if (phoneInput) {
      phoneInput.addEventListener('input', () => formatPhoneDisplay(phoneInput));
      phoneInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleSendSignupOtp(); }
      });
    }
    if (returningLink) returningLink.addEventListener('click', handleReturningStart);

    // STATE_OTP
    if (verifyOtpBtn) verifyOtpBtn.addEventListener('click', handleVerifySignupOtp);
    if (resendOtpBtn) resendOtpBtn.addEventListener('click', handleResendSignupOtp);
    if (changePhoneBtn) changePhoneBtn.addEventListener('click', handleChangeSignupPhone);
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

    // STATE_TRIAL
    if (trialBtn) trialBtn.addEventListener('click', handleStartTrial);

    // STATE_PLAID
    if (connectBtn)        connectBtn.addEventListener('click', startPlaidFlow);
    if (addAnotherBtn)     addAnotherBtn.addEventListener('click', startPlaidFlow);
    if (plaidContinueBtn)  plaidContinueBtn.addEventListener('click', handlePlaidContinue);

    // STATE_CLAUDE
    if (claudeBtn) claudeBtn.addEventListener('click', handleOpenInClaude);

    // Returning lane
    if (returningSendBtn) returningSendBtn.addEventListener('click', handleSendReturningOtp);
    if (returningVerifyBtn) returningVerifyBtn.addEventListener('click', handleVerifyReturningOtp);
    if (returningResendBtn) returningResendBtn.addEventListener('click', handleResendReturningOtp);
    if (returningChangeBtn) returningChangeBtn.addEventListener('click', handleChangeReturningPhone);
    if (returningBackLink) returningBackLink.addEventListener('click', () => showState(STATE_PHONE));
    if (returningPhoneInput) {
      returningPhoneInput.addEventListener('input', () => formatPhoneDisplay(returningPhoneInput));
      returningPhoneInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleSendReturningOtp(); }
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
  }

  // ── Boot ────────────────────────────────────────
  (async function boot() {
    wire();
    // decideStartingState handles the /api/me call + the routing branches.
    decideStartingState().catch(() => { showState(STATE_PHONE); });
  })();

  // Test hook. only exposed when ?__cbff_test=1 so prod users never see it.
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('__cbff_test') === '1') {
      window.__cbffSignup = {
        showState,
        showBanner,
        hideBanner,
        STATE_PHONE, STATE_OTP, STATE_TRIAL, STATE_PLAID, STATE_CLAUDE,
        STATE_RETURNING_PHONE, STATE_RETURNING_OTP,
      };
    }
  } catch (_) { /* ignore */ }
})();
