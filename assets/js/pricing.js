// pricing.js — wires the SMS-agent beta waitlist form on /pricing.html.
//
// Behaviour:
//   - Validates email shape client-side (basic regex — server is the
//     authoritative validator).
//   - POSTs { email, note } to /api/sms-beta-waitlist on api.cashbff.com.
//   - On 200, swaps the form for the "you're in" success state.
//   - On 400 / 429 / 500, shows a friendly inline error.
//   - Double-submit guard: disables submit + blocks repeat clicks.
//
// CSP-safe: no inline scripts, no eval. Tags itself onto window so the
// e2e specs can drive the renderers without leaning on private state.

(function () {
  'use strict';

  const API_BASE = 'https://api.cashbff.com';
  // Same shape the server's isValidEmail uses — basic regex catches
  // obvious typos. Server has the final say.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const NOTE_MAX_LEN = 280;

  // ── DOM hooks ──────────────────────────────────────────────────────
  const form = document.getElementById('waitlist-form');
  const emailInput = document.getElementById('waitlist-email');
  const noteInput = document.getElementById('waitlist-note');
  const submitBtn = document.getElementById('waitlist-submit');
  const errorEl = document.getElementById('waitlist-error');
  const successEl = document.getElementById('waitlist-success');

  // The form may not exist on other pages that import this module.
  if (!form || !emailInput || !submitBtn) {
    return;
  }

  // ── State ──────────────────────────────────────────────────────────
  let submitting = false;

  // ── Helpers ────────────────────────────────────────────────────────
  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    if (!errorEl) return;
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
  function isValidEmail(s) {
    if (typeof s !== 'string') return false;
    const trimmed = s.trim();
    return trimmed.length > 0 && trimmed.length <= 254 && EMAIL_RE.test(trimmed);
  }
  function setSubmitting(busy) {
    submitting = busy;
    submitBtn.disabled = busy;
    submitBtn.textContent = busy
      ? 'sending…'
      : 'get on the early-access list →';
  }
  function showSuccess() {
    if (form) form.hidden = true;
    if (successEl) successEl.hidden = false;
    // Hand a friendly anchor so the success state is what scrolls into
    // view rather than the now-hidden form.
    if (successEl && typeof successEl.scrollIntoView === 'function') {
      try {
        successEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (_) { /* sandboxed env */ }
    }
  }

  // ── Post handler ──────────────────────────────────────────────────
  async function postWaitlist(payload) {
    const res = await fetch(API_BASE + '/api/sms-beta-waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      // No cookie needed — this is a public marketing endpoint. Sending
      // credentials anyway is harmless but skip the preflight cost.
      credentials: 'omit',
      body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* empty body */ }
    return { status: res.status, body: body || {} };
  }

  // ── Submit ─────────────────────────────────────────────────────────
  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (submitting) return; // double-submit guard
    clearError();

    const email = (emailInput.value || '').trim();
    const note = (noteInput && noteInput.value ? noteInput.value : '').trim();

    if (!isValidEmail(email)) {
      emailInput.setAttribute('aria-invalid', 'true');
      showError("that email doesn't look right.");
      emailInput.focus();
      return;
    }
    emailInput.removeAttribute('aria-invalid');

    if (note.length > NOTE_MAX_LEN) {
      if (noteInput) noteInput.setAttribute('aria-invalid', 'true');
      showError('keep the note under 280 characters.');
      return;
    }
    if (noteInput) noteInput.removeAttribute('aria-invalid');

    setSubmitting(true);
    try {
      const { status, body } = await postWaitlist({
        email: email,
        note: note.length > 0 ? note : undefined,
      });

      if (status === 200 && body && body.ok === true) {
        showSuccess();
        return;
      }

      // Friendly per-status errors. The body.error from the server is
      // already brand-voice (lowercase, period-cadence) so we surface it
      // directly when present.
      if (status === 429) {
        showError(
          (body && body.error) ||
            "too many signups from your network — try again tomorrow.",
        );
      } else if (status >= 400 && status < 500) {
        showError(
          (body && body.error) ||
            "we couldn't save that — double-check your email and try again.",
        );
      } else {
        showError(
          (body && body.error) ||
            "something broke on our end — try again in a minute.",
        );
      }
    } catch (err) {
      // Network / CORS error — friendly fallback.
      showError("we couldn't reach the server — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  });

  // ── Auth-banner hookup ────────────────────────────────────────────
  // The auth-banner.js file looks up window.__authedUser to decide
  // whether to show the "my home →" pill. Marketing pages like /pricing
  // do a quick /api/me probe; on 200 we surface the pill. On 401/error
  // we just leave the page as-is. This is the same pattern other
  // marketing pages (school.html etc) use.
  fetch(API_BASE + '/api/me', { credentials: 'include' })
    .then(function (r) {
      if (!r.ok) throw new Error('not_authed');
      return r.json();
    })
    .then(function (data) {
      window.__authedUser = data;
      if (typeof window.showAuthHomeButton === 'function') {
        window.showAuthHomeButton();
      }
    })
    .catch(function () { /* not signed in — no-op */ });

  // ── Test harness exposure ─────────────────────────────────────────
  // Vitest / jsdom can drive the renderers via window.__pricing.
  window.__pricing = {
    isValidEmail: isValidEmail,
    showError: showError,
    clearError: clearError,
    showSuccess: showSuccess,
    setSubmitting: setSubmitting,
    NOTE_MAX_LEN: NOTE_MAX_LEN,
  };
})();
