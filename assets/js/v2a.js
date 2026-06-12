// v2a.js: site v2 direction A (warm immersive calm) motion layer.
// CSP-safe (external file, no eval, no inline). Two jobs:
//   1. The living chat: the WhatsApp mock ([data-chat-script]) types itself.
//      Bubbles are real DOM content at load; they're hidden ONLY after this
//      script adds html.has-chat-js, so no-JS visitors, crawlers, and
//      reduced-motion users always see the full conversation.
//   2. Gentle parallax: elements with [data-drift] ease a few pixels against
//      the scroll. Whisper-level, skipped entirely under reduced motion.
(function () {
  'use strict';

  var docEl = document.documentElement;
  var reduce = false;
  try {
    reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) { /* matchMedia unavailable: treat as no preference */ }

  /* ── 1. the living chat ── */
  var chat = document.querySelector('[data-chat-script]');
  if (chat && !reduce && 'IntersectionObserver' in window) {
    docEl.classList.add('has-chat-js');

    var msgs = Array.prototype.slice.call(chat.querySelectorAll('.msg'));
    var typing = chat.querySelector('.typing');
    var started = false;

    var showTyping = function (beforeEl) {
      if (!typing) return;
      // the dots appear where the next bubble will land
      if (beforeEl && beforeEl.parentNode) beforeEl.parentNode.insertBefore(typing, beforeEl);
      typing.classList.add('is-on');
    };
    var hideTyping = function () {
      if (typing) typing.classList.remove('is-on');
    };

    var play = function () {
      if (started) return;
      started = true;
      var t = 600; // a breath before the first message
      msgs.forEach(function (msg) {
        var isBff = msg.classList.contains('bff');
        if (isBff) {
          // cashbff "types" first
          (function (el, at) {
            setTimeout(function () { showTyping(el); }, at);
          })(msg, t);
          t += 1250;
        } else {
          t += 450;
        }
        (function (el, at) {
          setTimeout(function () {
            hideTyping();
            el.classList.add('is-in');
          }, at);
        })(msg, t);
        t += 650;
      });
    };

    // start when the phone is actually on screen
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          play();
          io.disconnect();
        }
      });
    }, { threshold: 0.35 });
    io.observe(chat);
  }

  /* ── 2. gentle parallax drift ── */
  var drifters = Array.prototype.slice.call(document.querySelectorAll('[data-drift]'));
  if (drifters.length && !reduce) {
    var ticking = false;
    var paint = function () {
      ticking = false;
      var y = window.scrollY || 0;
      drifters.forEach(function (el) {
        var f = parseFloat(el.getAttribute('data-drift')) || 0;
        el.style.transform = 'translate3d(0,' + (y * f).toFixed(1) + 'px,0)';
      });
    };
    window.addEventListener('scroll', function () {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(paint);
      }
    }, { passive: true });
    paint();
  }
})();
