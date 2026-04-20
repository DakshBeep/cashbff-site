// home.js — scatter/seedbed rendering of the logged-in user's real cards.
// Visual direction ported from home-bloom-v2. Positions are generated
// programmatically so any card count (1..N) lays out without overlap.
//
// Public API (bound to window.CashBFFHome for testability):
//   allocatePositions(cards, canvasWidthPx, canvasHeightPx) -> positionedCards[]
//   renderCards(container, cards)
//   fetchHome() -> Promise<{cards, first_name?}>
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────
  var API_BASE = 'https://api.cashbff.com';
  var NAME_KEY = 'cbff_first_name';
  var SIZE_CLASSES = ['size-huge', 'size-large', 'size-med', 'size-small', 'size-tiny'];

  // ── Helpers ─────────────────────────────────────
  function formatMoney(n) {
    var rounded = Math.round(n * 100) / 100;
    var dollars = Math.floor(rounded);
    var cents = Math.round((rounded - dollars) * 100);
    return {
      dollars: '$' + dollars.toLocaleString('en-US'),
      cents: '.' + String(cents).padStart(2, '0')
    };
  }
  function cleanText(raw) {
    return String(raw || '').toLowerCase().trim().replace(/[<>&"]/g, '');
  }
  function escapeHTML(raw) {
    return String(raw || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Deterministic RNG seeded off the card mask ──
  // Tiny xorshift / string hash. Same mask => same position across reloads.
  function hashString(s) {
    var h = 2166136261 >>> 0;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    var t = seed >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      var r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Position allocation ─────────────────────────
  // Strategy: for each card, pick a size based on its balance rank (smallest
  // balance = biggest tile). Compute pixel dimensions, then place via seeded
  // jittered-grid / rejection sampling so tiles don't overlap and stay in bounds.
  // Deterministic: hashing the card mask as seed means reloads are stable.
  function sizeTierForRank(rank, total) {
    // Map rank (0 = smallest balance) to one of SIZE_CLASSES, scaling by total.
    if (total <= 1) return 0;
    var ratio = rank / (total - 1);
    if (ratio < 0.15) return 0; // huge
    if (ratio < 0.35) return 1; // large
    if (ratio < 0.65) return 2; // med
    if (ratio < 0.85) return 3; // small
    return 4;                    // tiny
  }

  // Tile dimensions in px for a given size tier and canvas width.
  // Scale with canvas so the layout looks right at mobile + desktop widths.
  function tileDims(tier, canvasW) {
    // Base widths as fractions of canvas width, clamped.
    var fractions = [0.42, 0.33, 0.28, 0.22, 0.19];
    var aspects   = [0.75, 0.77, 0.75, 0.74, 0.74]; // height/width
    var w = Math.max(150, Math.min(340, canvasW * fractions[tier]));
    var h = w * aspects[tier];
    return { w: w, h: h };
  }

  function rectsOverlap(a, b, pad) {
    pad = pad || 0;
    return !(a.x + a.w + pad <= b.x ||
             b.x + b.w + pad <= a.x ||
             a.y + a.h + pad <= b.y ||
             b.y + b.h + pad <= a.y);
  }

  /**
   * allocatePositions(cards, canvasW, canvasH)
   * Returns a new array of card objects with layout props:
   *   { ...card, _rank, _size, x, y, w, h, rot, driftDur, driftDelay }
   */
  function allocatePositions(cards, canvasW, canvasH) {
    if (!Array.isArray(cards) || cards.length === 0) return [];
    canvasW = Math.max(280, canvasW || 640);
    canvasH = Math.max(320, canvasH || 640);

    // Sort ascending by balance for ranking. Keep original index so output
    // order matches input order (consumer may want stable iteration).
    var withRank = cards.map(function (c, i) {
      return { card: c, origIndex: i, balance: Number(c.balance) || 0 };
    });
    var sorted = withRank.slice().sort(function (a, b) { return a.balance - b.balance; });
    sorted.forEach(function (entry, rank) { entry.rank = rank; });

    var total = cards.length;
    var PAD = 10; // px gap between tiles

    // Place biggest tiles first — they're hardest to fit.
    var placementOrder = sorted.slice().sort(function (a, b) { return a.rank - b.rank; });
    var placed = [];

    placementOrder.forEach(function (entry) {
      var tier = sizeTierForRank(entry.rank, total);
      var dims = tileDims(tier, canvasW);
      // Clamp dims to canvas.
      if (dims.w > canvasW - 16) { dims.w = canvasW - 16; dims.h = dims.w * 0.75; }
      if (dims.h > canvasH - 16) { dims.h = canvasH - 16; dims.w = dims.h / 0.75; }

      var seed = hashString((entry.card.mask || '') + ':' + (entry.card.institution || '') + ':' + entry.origIndex);
      var rand = mulberry32(seed || (entry.origIndex + 1) * 97);

      var maxX = Math.max(0, canvasW - dims.w);
      var maxY = Math.max(0, canvasH - dims.h);

      var chosen = null;
      // Up to N rejection-sample attempts; if all fail, shrink the tile and retry.
      for (var shrink = 0; shrink < 5 && !chosen; shrink++) {
        for (var attempt = 0; attempt < 60; attempt++) {
          var x = rand() * maxX;
          var y = rand() * maxY;
          var rect = { x: x, y: y, w: dims.w, h: dims.h };
          var clash = false;
          for (var i = 0; i < placed.length; i++) {
            if (rectsOverlap(rect, placed[i].rect, PAD)) { clash = true; break; }
          }
          if (!clash) { chosen = rect; break; }
        }
        if (!chosen) {
          // Shrink 12% and recompute bounds.
          dims.w *= 0.88; dims.h *= 0.88;
          maxX = Math.max(0, canvasW - dims.w);
          maxY = Math.max(0, canvasH - dims.h);
        }
      }
      // Last-resort fallback: place anyway at the least-occupied corner-ish spot.
      if (!chosen) {
        chosen = { x: (rand() * maxX) | 0, y: (rand() * maxY) | 0, w: dims.w, h: dims.h };
      }

      // Rotation ±3–6°, seeded.
      var rotMag = 3 + rand() * 3;
      var rotSign = rand() < 0.5 ? -1 : 1;
      var rot = (rotMag * rotSign).toFixed(2) + 'deg';

      // Drift 7–11s with small per-card delay so they desync.
      var dur = (7 + rand() * 4).toFixed(2) + 's';
      var delay = (rand() * 1.4).toFixed(2) + 's';

      placed.push({
        entry: entry,
        tier: tier,
        rect: chosen,
        rot: rot,
        driftDur: dur,
        driftDelay: delay
      });
    });

    // Return in original input order for a stable, testable output.
    var byOrig = new Array(total);
    placed.forEach(function (p) {
      byOrig[p.entry.origIndex] = {
        card: p.entry.card,
        rank: p.entry.rank,
        size: p.tier,
        sizeClass: SIZE_CLASSES[p.tier],
        x: p.rect.x,
        y: p.rect.y,
        w: p.rect.w,
        h: p.rect.h,
        rot: p.rot,
        driftDur: p.driftDur,
        driftDelay: p.driftDelay
      };
    });
    return byOrig;
  }

  // ── Rendering ───────────────────────────────────
  function buildSeedElement(positioned) {
    var card = positioned.card;
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'seed ' + positioned.sizeClass;
    el.dataset.rank = String(positioned.rank);
    el.dataset.mask = String(card.mask || '');
    el.setAttribute('aria-label',
      cleanText(card.institution) + ' card ending in ' + cleanText(card.mask));
    el.style.setProperty('--x', positioned.x + 'px');
    el.style.setProperty('--y', positioned.y + 'px');
    el.style.setProperty('--w', positioned.w + 'px');
    el.style.setProperty('--h', positioned.h + 'px');
    el.style.setProperty('--rot', positioned.rot);
    el.style.setProperty('--drift-dur', positioned.driftDur);
    el.style.setProperty('--drift-delay', positioned.driftDelay);
    el.style.transform = 'rotate(' + positioned.rot + ')';

    var money = formatMoney(Number(card.balance) || 0);
    var institution = escapeHTML(cleanText(card.institution) || 'card');
    var mask = escapeHTML(cleanText(card.mask));
    var limit = Number(card.limit);
    var limitStr = (isFinite(limit) && limit > 0)
      ? 'limit $' + limit.toLocaleString('en-US')
      : '';

    el.innerHTML =
      '<span class="seed__top">' + institution + (mask ? ' · …' + mask : '') + '</span>' +
      '<span>' +
        '<span class="seed__balance">' + money.dollars +
          '<span class="cents">' + money.cents + '</span>' +
        '</span>' +
      '</span>' +
      '<span class="seed__bottom">' + limitStr + '</span>';

    return el;
  }

  function renderCards(container, cards) {
    if (!container) return;
    container.innerHTML = '';
    if (!cards || cards.length === 0) {
      renderEmpty(container);
      return;
    }
    var rect = container.getBoundingClientRect();
    var positioned = allocatePositions(cards, rect.width || container.clientWidth, rect.height || container.clientHeight);
    positioned.forEach(function (p) {
      if (!p) return;
      container.appendChild(buildSeedElement(p));
    });
  }

  function renderEmpty(container) {
    container.innerHTML =
      '<div class="state state--empty">' +
        '<span>no cards connected yet.</span>' +
        '<a href="connect.html">connect one →</a>' +
      '</div>';
  }
  function renderError(container) {
    container.innerHTML = '<div class="state state--err"><em>give us a sec…</em></div>';
  }
  function renderLoading(container) {
    container.innerHTML = '<div class="state state--loading"><span>settling in…</span></div>';
  }

  // ── Fetch ───────────────────────────────────────
  function fetchHome() {
    return fetch(API_BASE + '/api/home', {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      if (res.status === 401) {
        location.replace('/');
        // Return a never-resolving promise so callers don't proceed mid-redirect.
        return new Promise(function () {});
      }
      if (!res.ok) throw new Error('bad response ' + res.status);
      return res.json();
    }).then(function (data) {
      var cards = Array.isArray(data && data.cards) ? data.cards : [];
      if (data && data.first_name) {
        try { localStorage.setItem(NAME_KEY, String(data.first_name)); } catch (_) {}
      }
      return { cards: cards, first_name: data && data.first_name };
    });
  }

  // ── Header ──────────────────────────────────────
  function wirePhonePill() {
    var pill = document.getElementById('phone-pill');
    if (!pill) return;
    var params = new URLSearchParams(location.search);
    var rawPhone = params.get('phone') || '';
    var digits = rawPhone.replace(/\D/g, '');
    if (digits.length >= 10) {
      var d = digits.slice(-10);
      pill.textContent = '+1 (' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6);
    }
  }

  function wireSignout() {
    var btn = document.getElementById('signout');
    if (!btn) return;
    btn.addEventListener('click', function () {
      fetch(API_BASE + '/api/logout', { method: 'POST', credentials: 'include' })
        .catch(function () { /* leaving anyway */ })
        .then(function () {
          try { localStorage.clear(); } catch (_) {}
          var container = document.getElementById('scatter');
          if (container) container.innerHTML = '';
          location.replace('/');
        });
    });
  }

  // ── Card count pill (overrides the phone pill with "+N signed in") ──
  function updateSignedInCount(n) {
    var pill = document.getElementById('phone-pill');
    if (!pill) return;
    // Only overwrite if the user didn't arrive with a ?phone= param.
    var params = new URLSearchParams(location.search);
    if (!params.get('phone')) {
      pill.textContent = '+' + n + ' signed in';
    }
  }

  // ── Boot ────────────────────────────────────────
  function boot() {
    wirePhonePill();
    wireSignout();
    var container = document.getElementById('scatter');
    if (!container) return;
    renderLoading(container);
    fetchHome().then(function (data) {
      updateSignedInCount((data.cards || []).length);
      renderCards(container, data.cards);
    }).catch(function () {
      renderError(container);
    });
  }

  // Expose the API surface for tests + other scripts.
  window.CashBFFHome = {
    allocatePositions: allocatePositions,
    renderCards: renderCards,
    renderEmpty: renderEmpty,
    renderError: renderError,
    renderLoading: renderLoading,
    fetchHome: fetchHome,
    // internals exposed for tests:
    _hashString: hashString,
    _sizeTierForRank: sizeTierForRank,
    _tileDims: tileDims
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
