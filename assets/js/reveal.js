// reveal.js. Presentation-layer enhancement for the 2026-06-11 redesign.
// CSP-safe (external file, no eval, no inline). Two jobs:
//   1. Scroll-reveal: elements with .reveal fade/rise in once they enter the
//      viewport (IntersectionObserver). Without JS, or with reduced motion,
//      everything stays fully visible — content is never gated on JS.
//   2. Sticky top bar: .topbar gets .is-scrolled after a small scroll so it
//      can grow a hairline + shadow.
(function () {
  'use strict';

  var docEl = document.documentElement;
  var reduce = false;
  try {
    reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) { /* matchMedia unavailable: treat as no preference */ }

  // Arm the hidden initial state only when JS is actually running and motion
  // is allowed. CSS keys off html.has-reveal-js so no-JS visitors (and
  // crawlers) always see the full page.
  if (!reduce && 'IntersectionObserver' in window) {
    docEl.classList.add('has-reveal-js');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

    var els = document.querySelectorAll('.reveal');
    Array.prototype.forEach.call(els, function (el) {
      var rect = el.getBoundingClientRect();
      // Anything already in the first viewport reveals immediately (no pop-in
      // on load); everything below the fold reveals on scroll.
      if (rect.top < (window.innerHeight || docEl.clientHeight) * 0.9) {
        el.classList.add('is-in');
      } else {
        io.observe(el);
      }
    });
  }

  // Top bar elevation.
  var bar = document.querySelector('.topbar');
  if (bar) {
    var paint = function () {
      if (window.scrollY > 8) bar.classList.add('is-scrolled');
      else bar.classList.remove('is-scrolled');
    };
    window.addEventListener('scroll', paint, { passive: true });
    paint();
  }
})();
