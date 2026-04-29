// auth-banner.js — shared "go to my home" pill for marketing + onboarding
// pages. Phase 9A pivots away from the previous "if /api/me 200, hard-redirect
// to /home.html" pattern: a logged-in user can now browse marketing pages
// (index.html, school.html) AND the funnel pages (verify, connect, paywall,
// plan, school-login) without being bounced. This module provides the small
// fixed-position pill that gives them a one-tap shortcut back to their home.
//
// Usage from a page's own JS:
//   1. After /api/me returns 200, set window.__authedUser = data.
//   2. Call showAuthHomeButton(). On 401 or net error, call hideAuthHomeButton()
//      (or just don't call show). Idempotent on both sides — safe to call
//      multiple times.
//   3. For "functional flow" pages (verify, connect, paywall, plan,
//      school-login) call hidePageInteractionForAuthed() to dim/hide the
//      page's primary CTA so an already-authed user can't accidentally
//      re-trigger OTP / Plaid / Stripe. The pill remains the obvious next
//      step.
//
// CSP-safe: no inline scripts, no inline event handlers. Styles are injected
// via a <style> tag (style-src 'unsafe-inline' is in the CSP, and the
// approach matches how other pages bundle their CSS).

(function () {
  'use strict';

  const STYLE_ID  = 'cbff-auth-banner-style';
  const BUTTON_ID = 'cbff-auth-home-btn';
  const SIGNED_IN_NOTE_ID = 'cbff-signed-in-note';
  const HIDE_CLASS = 'cbff-authed-hide';

  // Brand-token CSS — cash-green pill with vanilla text. Designed to land in
  // the top-right corner of the viewport without overlapping any of the
  // existing page chrome (wordmark sits top-left). At 375px we shrink the
  // padding so the pill stays clear of the existing top bar.
  const STYLE = `
    .cbff-authed-hide { display: none !important; }
    #${BUTTON_ID} {
      position: fixed;
      top: 1rem;
      right: 1rem;
      z-index: 9999;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.55rem 0.95rem;
      background: var(--cash-green, #014751);
      color: var(--vanilla, #FCFAF2);
      font-family: var(--font-body, 'Instrument Sans', system-ui, sans-serif);
      font-weight: 600;
      font-size: 0.78rem;
      letter-spacing: 0.01em;
      border: none;
      border-radius: 999px;
      box-shadow: 0 4px 14px rgba(1, 71, 81, 0.18);
      cursor: pointer;
      text-decoration: none;
      line-height: 1;
      transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
    }
    #${BUTTON_ID}:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(1, 71, 81, 0.24);
    }
    #${BUTTON_ID}:active { transform: translateY(0); opacity: 0.9; }
    #${BUTTON_ID}:focus-visible {
      outline: 2px solid var(--electric-green, #D3FFB4);
      outline-offset: 2px;
    }
    #${BUTTON_ID} .cbff-arrow { font-size: 0.95em; }
    #${SIGNED_IN_NOTE_ID} {
      display: block;
      max-width: 28rem;
      margin: 1.25rem auto 0;
      padding: 0.95rem 1.1rem;
      background: rgba(1, 71, 81, 0.06);
      border: 1px solid rgba(1, 71, 81, 0.14);
      border-radius: 14px;
      color: var(--off-black, #1A1717);
      font-family: var(--font-body, 'Instrument Sans', system-ui, sans-serif);
      font-size: 0.92rem;
      line-height: 1.5;
      text-align: center;
    }
    #${SIGNED_IN_NOTE_ID} strong { color: var(--cash-green, #014751); }
    #${SIGNED_IN_NOTE_ID} a {
      color: var(--cash-green, #014751);
      font-weight: 600;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    @media (max-width: 480px) {
      #${BUTTON_ID} {
        top: 0.65rem;
        right: 0.65rem;
        padding: 0.5rem 0.8rem;
        font-size: 0.72rem;
      }
    }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = STYLE;
    document.head.appendChild(tag);
  }

  function ensureButton() {
    let btn = document.getElementById(BUTTON_ID);
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BUTTON_ID;
    btn.setAttribute('aria-label', 'go to my home');
    // Copy is intentionally lowercase to match the existing brand voice
    // (see index.html / verify.html etc).
    btn.innerHTML = '<span>my home</span><span class="cbff-arrow" aria-hidden="true">→</span>';
    btn.addEventListener('click', function () {
      try { location.href = '/home.html'; } catch (_) { /* sandboxed env */ }
    });
    document.body.appendChild(btn);
    return btn;
  }

  function showAuthHomeButton() {
    if (typeof document === 'undefined' || !document.body) return;
    ensureStyle();
    ensureButton();
  }

  function hideAuthHomeButton() {
    const btn = document.getElementById(BUTTON_ID);
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
  }

  // Hide a list of selectors (the page's primary CTA / form). Used by the
  // "functional flow" pages (verify, connect, paywall, plan, school-login)
  // when the visitor is already authed — we don't want them re-triggering
  // OTP, Plaid, Stripe, or otherwise re-entering a flow they've completed.
  // `noteOpts` lets each page customise the friendly inline message that
  // replaces the form. Pass `mountSelector` as the element AFTER which the
  // note is inserted; if omitted the note appends to <main> or document.body.
  function hidePageInteractionForAuthed(selectorList, noteOpts) {
    if (typeof document === 'undefined') return;
    ensureStyle();
    if (Array.isArray(selectorList)) {
      selectorList.forEach(function (sel) {
        try {
          document.querySelectorAll(sel).forEach(function (el) {
            el.classList.add(HIDE_CLASS);
          });
        } catch (_) { /* bad selector — skip */ }
      });
    }
    if (noteOpts && !document.getElementById(SIGNED_IN_NOTE_ID)) {
      const note = document.createElement('div');
      note.id = SIGNED_IN_NOTE_ID;
      note.setAttribute('role', 'status');
      // Keep the message minimal — the pill is the call to action.
      const heading = (noteOpts.heading || "you're already signed in.").toString();
      const body    = (noteOpts.body    || 'jump back to your home whenever.').toString();
      // textContent everywhere — never set innerHTML from caller-controlled
      // strings, since the message could conceivably embed a username.
      const h = document.createElement('strong');
      h.textContent = heading;
      const b = document.createElement('div');
      b.style.marginTop = '0.35rem';
      b.style.opacity = '0.85';
      b.textContent = body;
      note.appendChild(h);
      note.appendChild(b);

      // Mount strategy:
      //   • If `mountInto` is set, append the note as the LAST child of the
      //     matched element. Use this when the form/CTA you just hid is a
      //     sibling that lives inside the same wrapper (e.g. <main>).
      //   • Else, if `mountSelector` is set, place the note as the next
      //     sibling of that element (so it visually sits right under the
      //     copy you targeted, e.g. ".sub" or ".intro").
      //   • Fallback: append to <main> or <body>.
      let inserted = false;
      if (noteOpts.mountInto) {
        try {
          const parent = document.querySelector(noteOpts.mountInto);
          if (parent) { parent.appendChild(note); inserted = true; }
        } catch (_) {}
      }
      if (!inserted && noteOpts.mountSelector) {
        try {
          const mount = document.querySelector(noteOpts.mountSelector);
          if (mount && mount.parentNode) {
            mount.parentNode.insertBefore(note, mount.nextSibling);
            inserted = true;
          }
        } catch (_) {}
      }
      if (!inserted) {
        const main = document.querySelector('main') || document.body;
        if (main) main.appendChild(note);
      }
    }
  }

  // Expose on window so each page's IIFE can reach the helpers without
  // wrestling with module imports (the pages are plain <script> tags).
  window.showAuthHomeButton = showAuthHomeButton;
  window.hideAuthHomeButton = hideAuthHomeButton;
  window.hidePageInteractionForAuthed = hidePageInteractionForAuthed;
})();
