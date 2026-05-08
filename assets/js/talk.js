/**
 * /talk page — landing + setup for the cash bff MCP connector + paid tier.
 *
 * Three interactions:
 *   1. Primary CTA "add to claude": copy MCP URL + open claude.ai's
 *      add-custom-connector dialog in a new tab. (As of May 2026, claude.ai
 *      doesn't pre-fill the URL field via query param — we ship the user's
 *      clipboard with our URL and they paste in the dialog.)
 *   2. Inline copy button on the URL block (fallback if the primary fails
 *      or the user wants to copy without opening claude.ai).
 *   3. Trial CTA "start free 14-day trial" — on click we hit /api/me to grab
 *      the user's id, then open the Stripe Payment Link in a new tab with
 *      `client_reference_id=<user_id>` so the resulting subscription can be
 *      linked back to the cashbff account via Stripe webhook. If the visitor
 *      is anon (401), we show an inline notice asking them to sign in first.
 *      The link's static href stays as a no-JS fallback; the JS click handler
 *      preventDefault()s and overrides on success.
 *
 * Stripe redirects back to /talk?subscribed=1 after successful Checkout. On
 * that load we show a one-time toast nudging the user toward "add to claude".
 *
 * PostHog events:
 *   - `mcp_connect_clicked`   — they clicked the big "add to claude" button
 *   - `mcp_url_copied`         — they used the inline copy button
 *   - `talk_trial_started`     — they clicked the trial CTA (pre-Stripe;
 *                                fires regardless of authed/anon path so we
 *                                can split the funnel by `auth_state`)
 *   - `talk_trial_subscribed`  — page loaded with ?subscribed=1 (deduped via
 *                                sessionStorage so refreshes don't double-fire)
 */

(function () {
  "use strict";

  const MCP_URL = "https://api.cashbff.com/mcp";
  // Confirmed by research (May 2026): no query-param pre-fill; this URL opens
  // the right dialog. If Anthropic adds ?url=… support later, we'll swap in.
  const CLAUDE_URL = "https://claude.ai/settings/connectors?modal=add-custom-connector";

  const API_BASE = "https://api.cashbff.com";
  // Stripe Payment Link for the $12.99/mo Talk plan w/ 14-day trial. We
  // append `?client_reference_id=<user_id>` at click time so the resulting
  // subscription can be reconciled to the cashbff user.
  const BASE_STRIPE_URL = "https://buy.stripe.com/14A9ATdOeen7aKA8BT1sQ01";

  const TOAST_DURATION_MS = 3500;
  // Slightly longer for the post-checkout success toast — it's higher-stakes
  // than the copy-confirm toasts.
  const SUCCESS_TOAST_DURATION_MS = 6000;

  function $(id) { return document.getElementById(id); }

  /** Try to copy text to clipboard. Returns true on success.
   *  Falls back from navigator.clipboard (modern, requires HTTPS + user gesture)
   *  to document.execCommand (deprecated but still works in older Safari).
   *  Both can fail silently — caller should still show the URL on screen. */
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      // fall through to legacy
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.left = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function showToast(message, durationMs) {
    const t = $("toast");
    if (!t) return;
    if (message) t.textContent = message;
    t.classList.add("show");
    const dur = typeof durationMs === "number" ? durationMs : TOAST_DURATION_MS;
    setTimeout(function () { t.classList.remove("show"); }, dur);
  }

  function track(event, props) {
    try {
      if (window.posthog && typeof window.posthog.capture === "function") {
        window.posthog.capture(event, props || {});
      }
    } catch (e) {
      // never let tracking break the UX
    }
  }

  function onAddClick() {
    // CRITICAL: open the new tab SYNCHRONOUSLY here, inside the click handler.
    // Browsers (Safari + Firefox strict mode especially) block window.open()
    // called after an `await` / Promise resolution because the user-gesture
    // context is gone. Opening it first preserves the gesture, then we do
    // the copy in the background.
    const newTab = window.open(CLAUDE_URL, "_blank", "noopener");

    copyToClipboard(MCP_URL).then(function (ok) {
      track("mcp_connect_clicked", { copy_succeeded: ok, popup_opened: !!newTab });
      if (ok) {
        showToast("URL copied. paste it in the claude.ai dialog.");
      } else if (newTab) {
        showToast("couldn't auto-copy — use the copy button below to grab it.");
      } else {
        // Both popup blocked AND copy failed — last-ditch user instructions.
        showToast("popup blocked. allow popups for cashbff.com, or copy the URL below manually.");
      }
    });
  }

  function onInlineCopy() {
    copyToClipboard(MCP_URL).then(function (ok) {
      track("mcp_url_copied", { copy_succeeded: ok });
      const btn = $("copy-btn");
      if (!btn) return;
      const original = btn.textContent;
      btn.textContent = ok ? "copied" : "select + copy";
      setTimeout(function () { btn.textContent = original; }, 1800);
    });
  }

  /** Render (or refresh) a small inline notice right below the trial button.
   *  Used when the visitor isn't authed — we ask them to sign in before
   *  Stripe collects their payment so we can stitch the subscription back to
   *  their cashbff account via `client_reference_id`. We append-once and
   *  reuse the same node on subsequent clicks so users don't see stacked
   *  notices. CSP-safe: no inline scripts, link uses href + addEventListener. */
  function showAuthRequiredNotice() {
    const trialBtn = $("trial-btn");
    if (!trialBtn) return;
    let notice = $("trial-auth-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "trial-auth-notice";
      notice.className = "trial-auth-notice";
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      // Minimal inline styling so we don't need a CSS edit (constraint: js
      // only). A future pass can hoist these to a stylesheet.
      notice.style.marginTop = "0.6rem";
      notice.style.fontSize = "0.85rem";
      notice.style.lineHeight = "1.4";
      notice.style.opacity = "0.85";
      notice.style.textAlign = "center";

      const msg = document.createElement("span");
      msg.textContent = "first sign in or sign up — we'll bring you right back. ";
      notice.appendChild(msg);

      const link = document.createElement("a");
      // TODO: signup.js doesn't yet honor a `next=` query param after signup
      // verify (it follows server-provided `redirect` or falls back to
      // /home.html). For v0 we send users to "/signup" and accept the
      // rougher UX of them having to click "start free trial" again after
      // logging in. When signup.js learns to read next=/?action=start-trial,
      // swap this href to that path so we round-trip cleanly.
      link.href = "/signup?next=/";
      link.textContent = "sign in";
      link.style.textDecoration = "underline";
      notice.appendChild(link);

      // Insert just after the trial button.
      if (trialBtn.parentNode) {
        trialBtn.parentNode.insertBefore(notice, trialBtn.nextSibling);
      }
    }
    notice.hidden = false;
  }

  function hideAuthRequiredNotice() {
    const notice = $("trial-auth-notice");
    if (notice) notice.hidden = true;
  }

  /** Trial CTA click handler. Resolves the user's id via /api/me, then opens
   *  Stripe Checkout with `client_reference_id` so the subscription can be
   *  linked back to the cashbff account. If the visitor is anon (401), we
   *  show an inline sign-in nudge instead of letting them pay anonymously. */
  function onTrialClick(e) {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    // Track first so we never miss the click even if the network call below
    // fails. `auth_state` gets refined once /api/me resolves; default 'anon'.
    track("talk_trial_started", { source: "talk_page", auth_state: "anon" });
    hideAuthRequiredNotice();

    fetch(API_BASE + "/api/me", { credentials: "include" })
      .then(function (res) {
        if (res.status === 401) {
          showAuthRequiredNotice();
          return null;
        }
        if (!res.ok) {
          // 5xx / network-ish: be forgiving and let them through with the
          // anon checkout link. Worse than ideal (no client_reference_id)
          // but better than a dead button. The Stripe webhook reconciliation
          // path will simply not find a match for these.
          window.open(BASE_STRIPE_URL, "_blank", "noopener,noreferrer");
          return null;
        }
        return res.json().catch(function () { return null; });
      })
      .then(function (data) {
        if (!data) return;
        const userId = data.user_id || data.id || null;
        if (!userId) {
          // Authed but no id field — fall back to anon checkout. Same
          // reasoning as the 5xx branch: don't block payment.
          window.open(BASE_STRIPE_URL, "_blank", "noopener,noreferrer");
          return;
        }
        // Refine the auth_state for this funnel step. Fires a second event
        // so we can see authed-vs-anon split cleanly.
        track("talk_trial_started", { source: "talk_page", auth_state: "authed" });
        const url = BASE_STRIPE_URL + "?client_reference_id=" + encodeURIComponent(userId);
        window.open(url, "_blank", "noopener,noreferrer");
      })
      .catch(function () {
        // Total fetch failure (offline, DNS). Same fallback: open anon.
        window.open(BASE_STRIPE_URL, "_blank", "noopener,noreferrer");
      });
  }

  /** On page load with ?subscribed=1, show a success toast nudging the user
   *  toward the next step (connecting Claude). PostHog event is deduped via
   *  sessionStorage so refreshes don't double-count. */
  function maybeHandleSubscribedSuccess() {
    let params;
    try { params = new URLSearchParams(window.location.search); }
    catch (e) { return; }
    if (params.get("subscribed") !== "1") return;

    showToast("✓ you're in. now click 'add to claude' to connect.", SUCCESS_TOAST_DURATION_MS);

    try {
      const key = "cbff_talk_trial_subscribed_tracked";
      if (window.sessionStorage && window.sessionStorage.getItem(key) !== "1") {
        track("talk_trial_subscribed", { source: "talk_page" });
        window.sessionStorage.setItem(key, "1");
      }
    } catch (e) {
      // sessionStorage can throw in private mode / disabled storage. Track
      // anyway — duplicate events are cheaper than missed events.
      track("talk_trial_subscribed", { source: "talk_page" });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    const addBtn = $("add-btn");
    if (addBtn) addBtn.addEventListener("click", onAddClick);
    const copyBtn = $("copy-btn");
    if (copyBtn) copyBtn.addEventListener("click", onInlineCopy);
    const trialBtn = $("trial-btn");
    if (trialBtn) trialBtn.addEventListener("click", onTrialClick);
    // Fires only when the URL has ?subscribed=1 (Stripe success redirect).
    maybeHandleSubscribedSuccess();
  });
})();
