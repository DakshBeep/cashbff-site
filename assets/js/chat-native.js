// chat-native.js. Presentation enhancement for the site v2 chat-native layer.
// CSP-safe (external file, no eval, no inline). Three jobs:
//   1. Arm the animated chat sequences: elements with .chat-seq get .play when
//      they enter the viewport, so their bubbles arrive like a live thread.
//      Without JS, or with reduced motion, every bubble is fully visible.
//   2. Scroll-reveal (same contract as reveal.js): .reveal elements rise in.
//   3. Sticky chrome: .topbar gets .is-scrolled after a small scroll.
(function () {
  'use strict';

  var docEl = document.documentElement;
  var reduce = false;
  try {
    reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) { /* matchMedia unavailable: treat as no preference */ }

  if (!reduce && 'IntersectionObserver' in window) {
    // Arm the hidden initial states only when JS is actually running and
    // motion is allowed. CSS keys off these classes so no-JS visitors (and
    // crawlers) always see the full page.
    docEl.classList.add('has-chat-js');
    docEl.classList.add('has-reveal-js');

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add(
            entry.target.classList.contains('chat-seq') ? 'play' : 'is-in'
          );
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });

    var els = document.querySelectorAll('.chat-seq, .reveal');
    Array.prototype.forEach.call(els, function (el) {
      var rect = el.getBoundingClientRect();
      // Anything already in the first viewport plays immediately; everything
      // below the fold waits for the scroll.
      if (rect.top < (window.innerHeight || docEl.clientHeight) * 0.92) {
        el.classList.add(el.classList.contains('chat-seq') ? 'play' : 'is-in');
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
