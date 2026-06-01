/**
 * pricing-checkout.js — auth-aware Stripe checkout wiring for /pricing.
 *
 * Replaces the old talk.js include on the pricing page. It keeps ONLY the
 * piece that matters for getting paid: when a logged-in visitor clicks a buy
 * button, we resolve their cashbff user id via /api/me and append
 * `?client_reference_id=<uid>` to the Stripe Payment Link so the resulting
 * subscription can be reconciled back to their account by the Stripe webhook
 * (the same client_reference_id contract the backend already expects).
 * Logged-out visitors fall through to the bare Payment Link, which is the
 * correct no-uid behaviour for an anonymous marketing visitor.
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

  /** Open the Stripe Payment Link in a new tab. Mirrors the Stripe Payment
   *  Link convention (target=_blank) used across the site. */
  function openCheckout(url) {
    window.open(url, "_blank", "noopener,noreferrer");
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

    // Take over navigation so we can stitch in the user id first. The static
    // href remains the fallback only if something below throws synchronously.
    if (e && typeof e.preventDefault === "function") e.preventDefault();

    // Track immediately so we never miss the click even if /api/me hangs.
    track("pricing_checkout_clicked", { plan: plan, auth_state: "anon" });

    fetch(API_BASE + "/api/me", { credentials: "include" })
      .then(function (res) {
        if (res.status === 401) {
          // Logged-out marketing visitor: bare link is correct (no uid to
          // attach). The Stripe success page handles the rest of onboarding.
          openCheckout(baseUrl);
          return null;
        }
        if (!res.ok) {
          // 5xx / network-ish: don't block the sale. Open the bare link; the
          // webhook simply won't find a match for this one.
          openCheckout(baseUrl);
          return null;
        }
        return res.json().catch(function () { return null; });
      })
      .then(function (data) {
        if (!data) return; // already handled (anon / error branch opened it)
        const userId = data.user_id || data.id || null;
        if (!userId) {
          // Authed but no id field — fall back to the bare link rather than
          // block payment.
          openCheckout(baseUrl);
          return;
        }
        track("pricing_checkout_clicked", { plan: plan, auth_state: "authed" });
        openCheckout(withClientRef(baseUrl, userId));
      })
      .catch(function () {
        // Total fetch failure (offline, DNS). Same fallback: open the bare link.
        openCheckout(baseUrl);
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    const buttons = document.querySelectorAll('[data-checkout="stripe"]');
    buttons.forEach(function (btn) {
      btn.addEventListener("click", onCheckoutClick);
    });
  });
})();
