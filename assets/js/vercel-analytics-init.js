// Vercel Analytics — stub queue initializer for the static-site approach.
//
// The official Vercel pattern for non-Next.js sites is two pieces:
//   1. a tiny window.va = function(){...} stub-queue (this file), so any
//      events fired BEFORE the real script.js loads still get recorded.
//   2. a deferred <script src="/_vercel/insights/script.js"></script>.
//
// Vercel normally inlines (1) per their docs, but our CSP doesn't allow
// 'unsafe-inline' for script-src, so we extract it to this same-origin
// file. Identical behavior, CSP-clean.
//
// Cookieless. Anonymous edge-collected pageviews + custom-event API.
window.va = window.va || function () {
  (window.vaq = window.vaq || []).push(arguments);
};
