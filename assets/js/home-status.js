/**
 * home-status.js — minimal post-login status page.
 *
 * Replaces the legacy ~5000-line dashboard at /home with a single
 * "you're in" status view. After the cashbff product pivoted to
 * "talk to your money inside Claude", the calendar dashboard stopped
 * making sense as the primary post-login surface — the user lives in
 * Claude now, /home is just a place to confirm "yes, you're signed in"
 * and nudge them back into Claude (or finish onboarding).
 *
 * Contract:
 *   - Calls /api/me with credentials. On 401 → redirect to /signup.
 *   - Renders state-appropriate primary CTA based on
 *       (talk_status, has_bank):
 *
 *         not trialing/active     → [start your trial →]   /signup?step=trial
 *         trialing/active, no bank → [connect your bank →] /signup?step=plaid
 *         trialing/active + bank   → [open in claude →]    (clipboard + popup)
 *
 *   - "open in claude" click mirrors talk.js#onAddClick exactly: open the
 *     popup SYNCHRONOUSLY inside the click handler (so Safari/Firefox
 *     don't blow away the user gesture across an await), then write the
 *     MCP URL to the clipboard in the background.
 *
 *   - Logout button POSTs /api/logout with credentials, then sends the
 *     user to /. The endpoint clears the cookie and returns 200.
 *
 *   - Banks list rendered if banks[] non-empty; mirrors signup.js's
 *     renderBankList (institution + ····mask). "add another bank →"
 *     is a plain <a> in markup, no JS needed.
 *
 *   - "manage subscription" + "add another bank" + footer links are all
 *     plain <a> elements with hrefs — no event handlers.
 *
 * PostHog event:
 *   - home_loaded { talk_status, has_bank } — fires once on every render
 *     (excluding the 401 redirect). We rely on the parent posthog-init.js
 *     to lazy-load the SDK; if it isn't there yet, we silently skip.
 *
 * CSP:
 *   The site CSP is `script-src 'self' …` (no `'unsafe-inline'`). All
 *   handlers attach via addEventListener. No inline JS in home.html.
 */

(function () {
  "use strict";

  const API_BASE = "https://api.cashbff.com";
  const MCP_URL = "https://api.cashbff.com/mcp";
  // Confirmed via talk.js (May 2026): no query-param URL pre-fill, this
  // opens the right add-custom-connector dialog. Keep in sync with talk.js.
  const CLAUDE_URL = "https://claude.ai/settings/connectors?modal=add-custom-connector";

  const TOAST_DURATION_MS = 3500;

  function $(id) { return document.getElementById(id); }

  /** Read /api/me. Returns { status, data } or { status, data: null } on
   *  network failure. We treat network failure the same as a 5xx for the
   *  UI: stay on the loading view (don't redirect, don't blow up). */
  async function fetchMe() {
    try {
      const res = await fetch(API_BASE + "/api/me", { credentials: "include" });
      if (!res.ok) return { status: res.status, data: null };
      const data = await res.json().catch(function () { return null; });
      return { status: res.status, data: data };
    } catch (e) {
      return { status: 0, data: null };
    }
  }

  /** Mask phone to "+1 (***) ***-1234" — only the last 4 digits visible.
   *  Falls back to the raw e.164 string if parsing fails. */
  function maskPhone(e164Phone) {
    const d = String(e164Phone || "").replace(/\D/g, "");
    if (d.length < 4) return e164Phone || "";
    const last4 = d.slice(-4);
    return "+1 (***) ***-" + last4;
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

  function showToast(message, durationMs) {
    const t = $("toast");
    if (!t) return;
    if (message) t.textContent = message;
    t.classList.add("show");
    const dur = typeof durationMs === "number" ? durationMs : TOAST_DURATION_MS;
    setTimeout(function () { t.classList.remove("show"); }, dur);
  }

  /** Try to copy text to clipboard. Same fallback ladder as talk.js:
   *  navigator.clipboard (modern HTTPS path) → execCommand (legacy Safari).
   *  Returns true on success, false otherwise. Caller decides what to do
   *  with a failure (toast + manual copy is the usual pattern). */
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

  /** Render the linked-banks section, then unhide it. Mirrors the format
   *  used in signup.js#renderBankList: institution name (lowercased) + a
   *  separated mask span (····1234). On empty array we leave the section
   *  hidden — this is called only when banks.length > 0. */
  function renderBanks(banks) {
    const list = $("banks-list");
    const section = $("banks");
    if (!list || !section) return;

    while (list.firstChild) list.removeChild(list.firstChild);

    banks.forEach(function (b) {
      if (!b) return;
      const li = document.createElement("li");
      li.className = "banks__item";
      const inst = String(b.institution || "your bank").toLowerCase();
      li.appendChild(document.createTextNode(inst));
      if (b.mask) {
        const m = document.createElement("span");
        m.className = "banks__mask";
        m.textContent = "····" + String(b.mask);
        li.appendChild(m);
      }
      list.appendChild(li);
    });

    section.hidden = false;
  }

  /** Decide which primary-CTA flavor to show.
   *  Returns { label, href, helper, onClick? }. If onClick is present we
   *  wire it to the button instead of relying on the href (used for the
   *  "open in claude" path that needs synchronous window.open). */
  function pickCta(status, hasBank) {
    const subscribed = status === "trialing" || status === "active";

    if (!subscribed) {
      return {
        label: "start your trial",
        href: "/signup?step=trial",
        helper: "your trial isn't started yet.",
        onClick: null
      };
    }
    if (subscribed && !hasBank) {
      return {
        label: "connect your bank",
        href: "/signup?step=plaid",
        helper: "you've got the trial. now let's link a bank.",
        onClick: null
      };
    }
    // happy path: subscribed + bank linked.
    return {
      label: "open in claude",
      href: CLAUDE_URL,
      helper: "you're set up. talk to your money in claude.",
      onClick: onOpenInClaude
    };
  }

  /** Open-in-Claude click handler. Identical pattern to talk.js#onAddClick:
   *  fire window.open SYNCHRONOUSLY inside the gesture handler so Safari /
   *  Firefox strict mode don't block the popup, THEN do the async clipboard
   *  write in the background. The toast surfaces success/failure. */
  function onOpenInClaude(e) {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    const newTab = window.open(CLAUDE_URL, "_blank", "noopener");

    copyToClipboard(MCP_URL).then(function (ok) {
      track("home_open_in_claude_clicked", { copy_succeeded: ok, popup_opened: !!newTab });
      if (ok) {
        showToast("URL copied. paste it in the claude.ai dialog.");
      } else if (newTab) {
        showToast("couldn't auto-copy — copy this URL: " + MCP_URL);
      } else {
        showToast("popup blocked. allow popups for cashbff.com.");
      }
    });
  }

  /** Logout: POST /api/logout with credentials. Backend clears the session
   *  cookie and returns 200; we then send the user to / (marketing home).
   *  We disable the button while in flight so a double-click doesn't fire
   *  a second request after the first already cleared the cookie. */
  async function onLogoutClick() {
    const btn = $("logout-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "logging out...";
    }
    track("home_logout_clicked", {});
    try {
      await fetch(API_BASE + "/api/logout", { method: "POST", credentials: "include" });
    } catch (e) {
      // even on a network failure, redirect — the user's intent is clear
      // and the browser already has a stale cookie that the server will
      // reject on the next request.
    }
    window.location.href = "/";
  }

  /** Wire up the page once /api/me has resolved with a session. */
  function render(me) {
    const data = me.data || {};
    const phone = data.phone || "";
    const status = data.talk_status ? String(data.talk_status).toLowerCase() : null;
    const hasBank = !!data.has_bank;
    const banks = Array.isArray(data.banks) ? data.banks : [];

    // phone label
    const phoneEl = $("phone-mask");
    if (phoneEl) phoneEl.textContent = maskPhone(phone);

    // primary CTA
    const ctaEl = $("primary-cta");
    const labelEl = $("primary-cta-label");
    const helperEl = $("cta-helper");
    const choice = pickCta(status, hasBank);

    if (labelEl) labelEl.textContent = choice.label;
    if (helperEl) helperEl.textContent = choice.helper || "";
    if (ctaEl) {
      ctaEl.setAttribute("href", choice.href);
      if (choice.onClick) {
        ctaEl.addEventListener("click", choice.onClick);
      }
    }

    // banks list (only render the section if there's at least one)
    if (banks.length > 0) renderBanks(banks);

    // manage subscription is shown only when the user actually has a
    // subscription to manage. Pre-trial users would see a Stripe portal
    // with no subscription — not useful, hide it.
    const manageEl = $("manage");
    const subscribed = status === "trialing" || status === "active";
    if (manageEl && subscribed) manageEl.hidden = false;

    // reveal hero + cta, hide loading
    const loading = $("loading");
    const hero = $("hero");
    const cta = $("cta");
    if (loading) loading.hidden = true;
    if (hero) hero.hidden = false;
    if (cta) cta.hidden = false;

    track("home_loaded", { talk_status: status, has_bank: hasBank });
  }

  document.addEventListener("DOMContentLoaded", function () {
    // logout is wired regardless of /api/me state — even on a stuck network
    // call the user should be able to sign out.
    const logoutBtn = $("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", onLogoutClick);

    fetchMe().then(function (me) {
      if (me.status === 401) {
        window.location.href = "/signup";
        return;
      }
      if (me.status !== 200 || !me.data) {
        // 5xx or network failure: leave the loading slug up. The user can
        // refresh — we don't want to falsely redirect or claim they're
        // signed in. This is a deliberate dead-end on transient failure.
        const loading = $("loading");
        if (loading) loading.textContent = "couldn't load your status. refresh to retry.";
        return;
      }
      render(me);
    });
  });
})();
