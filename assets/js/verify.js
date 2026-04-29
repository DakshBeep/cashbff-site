// ── Phase 7D auth gate (hardened in Phase 8.5B) ──────────
// If the user already has a valid cbff_session cookie they shouldn't be
// looking at the OTP page — bounce them to /home.html before any SMS
// fires or visible state changes. The gate is a promise the rest of the
// file awaits before doing anything user-visible. Phase 8.5B tightens the
// race window so an authed user who hits "back" can't trip an OTP send or
// a verify request before the redirect lands:
//   1. The verify button is force-disabled until the gate resolves with
//      false (i.e. the user is NOT authed). On 200 the button stays
//      disabled while the location.replace completes.
//   2. sendOtp() and the verify submit handler BOTH await the gate before
//      hitting the network.
//   3. The pageshow handler re-runs the gate on bfcache restore so a back-
//      navigation doesn't show a stale rendered form alongside an authed
//      session.
//
// Status semantics:
//   200 → already authed → location.replace('/home.html'), promise pends.
//   401 / network blip → resolve(false) and let the OTP flow proceed.
async function runAuthGate() {
  try {
    const res = await fetch('https://api.cashbff.com/api/me', { credentials: 'include' });
    if (res.status === 200) {
      location.replace('/home.html');
      // Never resolve — pending promise short-circuits any awaiter while
      // the navigation lands.
      await new Promise(() => {});
    }
  } catch (_) {
    // Network hiccup → fall through; the user can still try OTP.
  }
  return false;
}
const gateAuthPromise = runAuthGate();
// bfcache safety: if the page is restored from back/forward cache the
// module body doesn't re-execute, so a previously-decided gate is reused.
// On 'pageshow' with persisted=true, re-validate against /api/me — if the
// user is now authed (or was already), bounce them again.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    runAuthGate().catch(() => {});
  }
});

// ── Display phone from query ──────────────────────
const params = new URLSearchParams(location.search);
const rawPhone = params.get('phone') || '';
const digits = rawPhone.replace(/\D/g, '');
const display = document.getElementById('phone-display');
if (digits.length >= 10) {
  const d = digits.slice(-10);
  display.textContent = `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
} else if (digits.length > 0) {
  display.textContent = '+1 ' + digits;
}

// ── OTP inputs ────────────────────────────────────
const otpInputs = Array.from(document.querySelectorAll('.otp input'));
const verifyBtn = document.getElementById('verify-btn');

// Phase 8.5B: gate-resolved flag flips to true the moment the auth gate
// returns false (i.e. the user is NOT authed). Until then, checkComplete
// keeps the verify button disabled even if all 6 digits are filled — this
// removes the race where a fast user could submit the OTP form before the
// /api/me redirect lands. resend button is also force-disabled while the
// gate is in flight (see the resend handler below).
let gateResolved = false;
gateAuthPromise.then(() => {
  // Promise only resolves when the user is unauthed (the 200 path pends
  // forever via `await new Promise(() => {})`). Once we're here it's safe
  // to enable the verify button.
  gateResolved = true;
  checkComplete();
});

function checkComplete() {
  const filled = otpInputs.every(i => /^\d$/.test(i.value));
  verifyBtn.disabled = !filled || !gateResolved;
}

function setInput(el, val) {
  el.value = val;
  el.classList.toggle('filled', !!val);
}

function distribute(str, startIdx = 0) {
  const digits = str.replace(/\D/g, '').split('');
  let i = startIdx;
  for (const d of digits) {
    if (i >= otpInputs.length) break;
    setInput(otpInputs[i], d);
    i++;
  }
  checkComplete();
  const focusIdx = Math.min(i, otpInputs.length - 1);
  otpInputs[focusIdx].focus();
  otpInputs[focusIdx].select && otpInputs[focusIdx].select();
}

otpInputs.forEach((input, idx) => {
  // `beforeinput` gives us the raw input data on mobile browsers where
  // `input` event value can be unreliable after maxlength clamps.
  input.addEventListener('input', (e) => {
    const raw = (e.target.value || '').replace(/\D/g, '');
    if (!raw) {
      setInput(input, '');
      checkComplete();
      return;
    }
    // If multiple digits landed (autofill / fast typing / paste), spread them.
    if (raw.length > 1) {
      setInput(input, raw[0]);
      distribute(raw.slice(1), idx + 1);
      return;
    }
    setInput(input, raw);
    if (idx < otpInputs.length - 1) {
      otpInputs[idx + 1].focus();
      otpInputs[idx + 1].select && otpInputs[idx + 1].select();
    }
    checkComplete();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') {
      if (input.value) {
        // Let default clear this box.
        return;
      }
      if (idx > 0) {
        e.preventDefault();
        const prev = otpInputs[idx - 1];
        setInput(prev, '');
        prev.focus();
        checkComplete();
      }
      return;
    }
    if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault();
      otpInputs[idx - 1].focus();
      return;
    }
    if (e.key === 'ArrowRight' && idx < otpInputs.length - 1) {
      e.preventDefault();
      otpInputs[idx + 1].focus();
      return;
    }
    if (e.key === 'Enter' && !verifyBtn.disabled) {
      e.preventDefault();
      verifyBtn.click();
      return;
    }
    // If this box already has a digit and the user types another digit,
    // forward it to the next box (otherwise maxlength swallows it silently).
    if (/^\d$/.test(e.key) && input.value && idx < otpInputs.length - 1) {
      e.preventDefault();
      const next = otpInputs[idx + 1];
      setInput(next, e.key);
      if (idx + 1 < otpInputs.length - 1) {
        otpInputs[idx + 2].focus();
      } else {
        next.focus();
      }
      checkComplete();
    }
  });

  input.addEventListener('focus', () => {
    // Select contents so typing replaces instead of appending.
    setTimeout(() => input.select && input.select(), 0);
  });

  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const paste = (e.clipboardData || window.clipboardData).getData('text');
    distribute(paste, 0);
  });
});

otpInputs[0].focus();

// ── Config ───────────────────────────────────────
const API_BASE = 'https://api.cashbff.com';
const NAME_KEY = 'cbff_first_name';
const LAST_KEY = 'cbff_last_name';
const STATS_KEY = 'cbff_stats';
const hint = document.getElementById('hint');

function e164(raw) {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length >= 8) return '+' + d;
  return null;
}

// ── Send the real OTP on page load ───────────────
function setHint(text, isError) {
  hint.textContent = text;
  hint.style.color = isError ? '#7a1f2a' : '';
}

async function sendOtp() {
  // Wait for the auth gate first — if /api/me returns 200 we'll be in the
  // middle of navigating to home and don't want to fire an SMS at the
  // user's phone on the way out.
  await gateAuthPromise;
  const phone = e164(rawPhone);
  if (!phone) {
    setHint("that number doesn't look right — try again?", true);
    return;
  }
  setHint('sending your code…');
  try {
    const res = await fetch(`${API_BASE}/api/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    if (res.status === 429) {
      setHint('slow down — too many codes. try again in a bit.', true);
      return;
    }
    if (!res.ok) {
      setHint("couldn't send the code. tap resend to try again.", true);
      return;
    }
    setHint('code sent. enter the 6 digits above.');
  } catch (_) {
    setHint('network hiccup. tap "resend code" to try again.', true);
  } finally {
    // Always make sure inputs are interactive once we're done sending.
    otpInputs.forEach(i => { i.disabled = false; });
    checkComplete();
    if (document.activeElement === document.body) otpInputs[0].focus();
  }
}
sendOtp();

// ── Verify the code ──────────────────────────────
verifyBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  if (verifyBtn.disabled) return;
  // Phase 8.5B defense in depth: even though checkComplete() keeps this
  // button disabled until the gate resolves to "unauthed", await the
  // gate again before firing /api/otp/verify so a stray click can't
  // beat the navigation when the user is in fact authed.
  await gateAuthPromise;
  const code = Array.from(otpInputs).map(i => i.value).join('');
  const phone = e164(rawPhone);
  if (!phone || !/^\d{6}$/.test(code)) return;

  verifyBtn.disabled = true;
  const originalLabel = verifyBtn.textContent;
  verifyBtn.textContent = 'verifying…';

  try {
    const res = await fetch(`${API_BASE}/api/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ phone, code }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      hint.textContent = data.error || "that code didn't match. try again?";
      hint.style.color = '#7a1f2a';
      verifyBtn.disabled = false;
      verifyBtn.textContent = originalLabel;
      otpInputs.forEach(i => { i.value = ''; i.classList.remove('filled'); });
      otpInputs[0].focus();
      return;
    }

    // Store name + stats for later requests / welcome-back page.
    if (data.first_name) localStorage.setItem(NAME_KEY, data.first_name);
    if (data.last_name)  localStorage.setItem(LAST_KEY, data.last_name);
    if (data.stats)      localStorage.setItem(STATS_KEY, JSON.stringify(data.stats));

    // Route: returning user without email → welcome-back page.
    // Otherwise continue the standard new-user flow.
    const query = `?phone=${encodeURIComponent(rawPhone)}`;
    if (data.is_returning && !data.has_email) {
      location.href = 'welcome.html' + query;
    } else if (data.is_returning) {
      // Returning user who already gave us an email — straight to home.
      location.href = 'home.html' + query;
    } else {
      location.href = 'plan.html' + query;
    }
  } catch (_) {
    hint.textContent = 'network hiccup. try again in a sec.';
    hint.style.color = '#7a1f2a';
    verifyBtn.disabled = false;
    verifyBtn.textContent = originalLabel;
  }
});

// ── Resend ───────────────────────────────────────
document.getElementById('resend').addEventListener('click', async () => {
  // Phase 8.5B: sendOtp() already awaits the gate, but we double-await here
  // so the visible "sending…" affordance doesn't flash for an authed user
  // about to be redirected.
  await gateAuthPromise;
  const el = document.getElementById('resend');
  const orig = el.textContent;
  el.textContent = 'sending…';
  el.style.opacity = '0.7';
  await sendOtp();
  el.textContent = 'new code sent ✓';
  setTimeout(() => { el.textContent = orig; el.style.opacity = ''; }, 2500);
});
