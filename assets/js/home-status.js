/**
 * home-status.js — minimal post-login status page.
 *
 * Replaces the legacy ~5000-line dashboard at /home with a single
 * "you're in" status view. The cashbff product is the WhatsApp agent;
 * once a user is signed in, banked, and subscribed they talk to their
 * money in WhatsApp, so /home is just a place to confirm "yes, you're
 * signed in", finish onboarding, or land on an "all set" confirmation.
 *
 * Contract:
 *   - Calls /api/me with credentials. On 401 → redirect to /signup.
 *   - Renders state-appropriate primary CTA based on
 *       (talk_status, has_bank):
 *
 *         not trialing/active     → [start your trial →]   /signup?step=trial
 *         trialing/active, no bank → [connect your bank →] /signup?step=plaid
 *         trialing/active + bank   → (no live CTA — "all set" confirmation)
 *
 *   - The fully-set-up path has NO live CTA yet: the WhatsApp number is
 *     gated on Meta business verification (wa.me doesn't exist), so we
 *     hide the primary button and show an "all set" confirmation line
 *     instead. When the number goes live, swap the hidden button for a
 *     wa.me link in pickCta() (set href + drop hideButton).
 *
 *   - Logout button POSTs /api/logout with credentials, then sends the
 *     user to /. The endpoint clears the cookie and returns 200.
 *
 *   - Banks list rendered if banks[] non-empty; mirrors signup.js's
 *     renderBankList (institution + ····mask). "add another bank →"
 *     is a plain <a> in markup, no JS needed.
 *
 *   - "manage subscription" is an <a> whose click is intercepted to POST
 *     /api/billing-portal and redirect to the returned Stripe portal URL.
 *     "add another bank" + footer links are plain <a> elements with hrefs.
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
   *  Returns { label, href, helper, hideButton? }. When hideButton is true,
   *  render() hides the primary button entirely and shows only the helper
   *  line — used for the fully-set-up state, which has no live CTA yet
   *  (the WhatsApp number is gated on Meta business verification). */
  function pickCta(status, hasBank) {
    const subscribed = status === "trialing" || status === "active";

    if (!subscribed) {
      return {
        label: "start your trial",
        href: "/signup?step=trial",
        helper: "your trial isn't started yet.",
        hideButton: false
      };
    }
    if (subscribed && !hasBank) {
      return {
        label: "connect your bank",
        href: "/signup?step=plaid",
        helper: "you've got the trial. now let's link a bank.",
        hideButton: false
      };
    }
    // Fully set up: subscribed + bank linked. The WhatsApp line is live (the
    // 909), so the primary CTA opens a chat with cashbff on WhatsApp (warm
    // prefill); render() opens external hand-offs in a new tab.
    return {
      label: "open cashbff on whatsapp",
      href: "https://wa.me/19096555215?text=hey%20cashbff",
      helper: "you're all set. tap below to start texting cashbff on whatsapp.",
      hideButton: false
    };
  }

  /** Manage subscription: mint a real (live-mode) Stripe Customer Portal
   *  session for the signed-in user via POST /api/billing-portal and redirect
   *  there. Replaces the old hardcoded TEST-mode portal URL, which 404'd for
   *  real subscribers. CSP-safe: attached via addEventListener, not inline. */
  async function onManageClick(e) {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    const link = $("manage-link");
    const original = link ? link.textContent : null;
    if (link) link.textContent = "opening billing…";
    track("home_manage_subscription_clicked", {});
    try {
      const res = await fetch(API_BASE + "/api/billing-portal", {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json().catch(function () { return null; });
      if (res.ok && body && body.url) {
        window.location.href = body.url;
        return;
      }
      // Non-OK or missing url: surface the backend's message when present.
      showToast((body && body.error) || "couldn't open billing. refresh and try again.");
    } catch (err) {
      showToast("couldn't open billing. check your connection and try again.");
    }
    if (link && original !== null) link.textContent = original;
  }

  /** Minimal toast — reuses the #toast element + `.toast.show` CSS already in
   *  home.html (same reveal convention as signup.js). */
  function showToast(msg) {
    const t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(function () { t.classList.remove("show"); }, 4000);
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

    if (helperEl) helperEl.textContent = choice.helper || "";
    if (ctaEl) {
      if (choice.hideButton) {
        // Defensive: a future state could still hide the button and let the
        // helper line carry the message on its own.
        ctaEl.hidden = true;
      } else {
        if (labelEl) labelEl.textContent = choice.label;
        ctaEl.setAttribute("href", choice.href);
        // External hand-offs (the wa.me WhatsApp link) open in a new tab so the
        // dashboard stays put; internal routes navigate in place.
        if (/^https?:\/\//.test(choice.href)) {
          ctaEl.setAttribute("target", "_blank");
          ctaEl.setAttribute("rel", "noopener noreferrer");
        }
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

    // Manage-subscription link → Stripe Customer Portal (via /api/billing-portal).
    const manageLink = $("manage-link");
    if (manageLink) manageLink.addEventListener("click", onManageClick);

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
