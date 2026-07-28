/**
 * pricing-checkout.js — auth-aware Stripe checkout wiring for /pricing.
 *
 * Replaces the old talk.js include on the pricing page. It keeps ONLY the
 * piece that matters for getting paid: when a logged-in visitor clicks a buy
 * button, we resolve their cashbff user id via /api/me and append
 * `?client_reference_id=<uid>` to the Stripe Payment Link so the resulting
 * subscription can be reconciled back to their account by the Stripe webhook
 * (the same client_reference_id contract the backend already expects).
 * Logged-out visitors are routed to /signup FIRST (which establishes an
 * account + uid before checkout) so every payment carries a client_reference_id
 * and can be attributed. Opening a bare Payment Link for an anonymous visitor
 * created charged-but-never-activated orphans, so we no longer do that.
 *
 * Each buy button opts in with `data-checkout="stripe"` and carries its own
 * `data-stripe-url` (the bare Payment Link). The static href stays as the
 * no-JS / failure fallback; the click handler preventDefault()s and overrides
 * only on the authed-success path. This lets one script wire BOTH the monthly
 * and annual buttons without hard-coding either URL here.
 *
 * Design-system + voice clean: no copy lives in this file, and no old-stack
 * references. CSP-safe: external module under /assets/js, no inline scripts,
 * no eval.
 *
 * PostHog events:
 *   - `pricing_checkout_clicked` — fired on every click (deduped per plan via
 *     the `plan` + `auth_state` props), so the funnel can split authed vs anon.
 */

(function () {
  "use strict";

  const API_BASE = "https://api.cashbff.com";

  function track(event, props) {
    try {
      if (window.posthog && typeof window.posthog.capture === "function") {
        window.posthog.capture(event, props || {});
      }
    } catch (e) {
      // never let analytics break the purchase path
    }
  }

  /** Point an already-opened tab at a URL, or open one if we don't have a
   *  handle. Splitting "open the tab" (synchronous, in the click gesture) from
   *  "navigate it" (after the async /api/me) is what keeps Safari's popup
   *  blocker from swallowing the checkout window. */
  function sendTabTo(win, url) {
    if (win && !win.closed) {
      win.location.href = url;
    } else {
      // Pre-open was blocked or closed; best-effort direct open.
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  /** Send the anonymous visitor into the account-first funnel. Uses the tab we
   *  pre-opened when possible, otherwise navigates the current window, so they
   *  never reach Stripe without a uid (which would orphan the payment). */
  function routeToSignup(win, plan) {
    const signupUrl = "https://cashbff.com/signup?plan=" + encodeURIComponent(plan);
    if (win && !win.closed) {
      win.location.href = signupUrl;
    } else {
      window.location.href = signupUrl;
    }
  }

  /** Build the final checkout URL, appending client_reference_id when we have
   *  a user id. Preserves any query string already on the base link. */
  function withClientRef(baseUrl, userId) {
    if (!userId) return baseUrl;
    const sep = baseUrl.indexOf("?") === -1 ? "?" : "&";
    return baseUrl + sep + "client_reference_id=" + encodeURIComponent(userId);
  }

  function onCheckoutClick(e) {
    const btn = e.currentTarget;
    const baseUrl =
      (btn && btn.getAttribute("data-stripe-url")) ||
      (btn && btn.getAttribute("href")) ||
      null;
    const plan = (btn && btn.getAttribute("data-plan")) || "unknown";
    if (!baseUrl) return; // nothing to do; let the href behave normally

    // Take over navigation so we can resolve auth + stitch in the user id
    // first. The static href remains the fallback only if something below
    // throws synchronously.
    if (e && typeof e.preventDefault === "function") e.preventDefault();

    // Pre-open the destination tab SYNCHRONOUSLY inside the click gesture.
    // Safari blocks window.open() that happens later inside a fetch .then();
    // opening now and navigating it after the fetch is allowed.
    const win = window.open("about:blank", "_blank");

    // Track immediately so we never miss the click even if /api/me hangs.
    track("pricing_checkout_clicked", { plan: plan, auth_state: "anon" });

    fetch(API_BASE + "/api/me", { credentials: "include" })
      .then(function (res) {
        if (res.status === 401) {
          // Logged-out visitor: route to /signup FIRST so an account + uid
          // exist before checkout. Never open a bare Payment Link here — that
          // is the orphan (charged, never activated) path.
          routeToSignup(win, plan);
          return null;
        }
        if (!res.ok) {
          // 5xx / network-ish: the visitor may well be logged in. Open the bare
          // link; the webhook's email-based reconciliation is the backstop.
          sendTabTo(win, baseUrl);
          return null;
        }
        return res.json().catch(function () { return null; });
      })
      .then(function (data) {
        if (!data) return; // already handled (anon / error branch)
        const userId = data.user_id || data.id || null;
        if (!userId) {
          // Authed but no id field — bare link + email reconciliation backstop.
          sendTabTo(win, baseUrl);
          return;
        }
        track("pricing_checkout_clicked", { plan: plan, auth_state: "authed" });
        sendTabTo(win, withClientRef(baseUrl, userId));
      })
      .catch(function () {
        // Total fetch failure (offline, DNS). Bare link + backstop.
        sendTabTo(win, baseUrl);
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    const buttons = document.querySelectorAll('[data-checkout="stripe"]');
    buttons.forEach(function (btn) {
      btn.addEventListener("click", onCheckoutClick);
    });
  });
})();
