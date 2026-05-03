// Vercel Speed Insights — stub queue initializer for the static-site approach.
//
// Mirror of vercel-analytics-init.js but for the Web Vitals (CLS/FID/LCP/
// TTFB/INP) collector. Real script lives at /_vercel/speed-insights/script.js
// and is loaded with `defer` after this stub registers.
//
// Like Vercel Analytics, this is cookieless and same-origin. Extracted to
// a separate file because our CSP forbids inline scripts.
window.si = window.si || function () {
  (window.siq = window.siq || []).push(arguments);
};
