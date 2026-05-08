/**
 * /claude page — landing + setup for the cash bff MCP connector.
 *
 * Two interactions only:
 *   1. Primary CTA: copy MCP URL + open claude.ai's add-custom-connector dialog
 *      in a new tab. (As of May 2026, claude.ai doesn't pre-fill the URL field
 *      via query param — we have to ship the user's clipboard with our URL and
 *      they paste in the dialog. ~3 seconds end-to-end.)
 *   2. Inline copy button on the URL block (fallback if the primary one fails
 *      or the user wants to copy without opening claude.ai).
 *
 * Tracks via PostHog (autocapture handles clicks; we add an explicit event
 * for the primary CTA so funnels are easy to build):
 *   - `mcp_connect_clicked` — they clicked the big button
 *   - `mcp_url_copied`      — they used the inline copy button (a different
 *                              intent — already in claude or copying for elsewhere)
 */

(function () {
  "use strict";

  const MCP_URL = "https://api.cashbff.com/mcp";
  // Confirmed by research (May 2026): no query-param pre-fill; this URL opens
  // the right dialog. If Anthropic adds ?url=… support later, we'll swap in.
  const CLAUDE_URL = "https://claude.ai/settings/connectors?modal=add-custom-connector";

  const TOAST_DURATION_MS = 3500;

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

  function showToast(message) {
    const t = $("toast");
    if (!t) return;
    if (message) t.textContent = message;
    t.classList.add("show");
    setTimeout(function () { t.classList.remove("show"); }, TOAST_DURATION_MS);
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
    copyToClipboard(MCP_URL).then(function (ok) {
      track("mcp_connect_clicked", { copy_succeeded: ok });
      if (ok) {
        showToast("URL copied. paste it in the claude.ai dialog.");
      } else {
        showToast("couldn't auto-copy — copy manually from the box below.");
      }
      // Open claude.ai in a new tab regardless. If the copy failed, the user
      // still gets where they need to be and can copy manually from this page.
      window.open(CLAUDE_URL, "_blank", "noopener");
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

  document.addEventListener("DOMContentLoaded", function () {
    const addBtn = $("add-btn");
    if (addBtn) addBtn.addEventListener("click", onAddClick);
    const copyBtn = $("copy-btn");
    if (copyBtn) copyBtn.addEventListener("click", onInlineCopy);
  });
})();
