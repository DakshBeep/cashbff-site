// home.js — infinite-canvas workspace for the logged-in user's cards.
//
// The "viewport" is a fixed full-screen element. Inside it lives a much larger
// "world" (a pannable, zoomable surface with a dot-grid background). Cards are
// placed at world coordinates; pan/zoom applies a single CSS transform to the
// world element so everything moves as one.
//
// Public API (bound to window.CashBFFHome for testability):
//   allocatePositions(cards, canvasW, canvasH) -> positionedCards[]
//   renderCards(container, cards)              (legacy; writes into container)
//   fetchHome() -> Promise<{cards, first_name?}>
//   addLocalCard(card)                         (optimistic manual-add hook)
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────
  var API_BASE = 'https://api.cashbff.com';
  var NAME_KEY = 'cbff_first_name';
  var MANUAL_KEY = 'cbff_manual_cards';
  var SIZE_CLASSES = ['size-huge', 'size-large', 'size-med', 'size-small', 'size-tiny'];

  // World / canvas.
  var WORLD_W = 8000;
  var WORLD_H = 8000;
  // A generous "playground" in the center of the world where we allocate card
  // positions. Everything outside stays empty grid — you can still pan there.
  // Expanded ~1.4x from the original 1800x1200 so cards have more negative
  // space between tiles (OCD-friendly: more air, same tile size).
  var PLAYGROUND_W = 2520;
  var PLAYGROUND_H = 1680;

  // Zoom clamps + trackpad feel.
  // MIN_ZOOM extended to 0.35 so the user can pull back far enough for the
  // cards to feel held-at-a-distance, not crowded.
  var MIN_ZOOM = 0.35;
  var MAX_ZOOM = 2.0;
  // Initial auto-fit lands inside this band rather than filling the viewport,
  // so first load reads as breathy, not tight.
  var INITIAL_FIT_MIN = 0.75;
  var INITIAL_FIT_MAX = 0.85;
  var WHEEL_ZOOM_INTENSITY = 0.0015;     // ctrl+wheel / trackpad pinch
  var WHEEL_PAN_INTENSITY  = 1.0;        // plain wheel = pan

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
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── Deterministic RNG seeded off the card mask ──
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

  // ── Position allocation (unchanged contract) ────
  function sizeTierForRank(rank, total) {
    if (total <= 1) return 0;
    var ratio = rank / (total - 1);
    if (ratio < 0.15) return 0;
    if (ratio < 0.35) return 1;
    if (ratio < 0.65) return 2;
    if (ratio < 0.85) return 3;
    return 4;
  }
  function tileDims(tier, canvasW) {
    var fractions = [0.42, 0.33, 0.28, 0.22, 0.19];
    var aspects   = [0.75, 0.77, 0.75, 0.74, 0.74];
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
   * Returns a positioned card per input, in the same order.
   */
  function allocatePositions(cards, canvasW, canvasH) {
    if (!Array.isArray(cards) || cards.length === 0) return [];
    canvasW = Math.max(280, canvasW || 640);
    canvasH = Math.max(320, canvasH || 640);

    var withRank = cards.map(function (c, i) {
      return { card: c, origIndex: i, balance: Number(c.balance) || 0 };
    });
    var sorted = withRank.slice().sort(function (a, b) { return a.balance - b.balance; });
    sorted.forEach(function (entry, rank) { entry.rank = rank; });

    var total = cards.length;
    var PAD = 24; // more breathing room on the open canvas

    var placementOrder = sorted.slice().sort(function (a, b) { return a.rank - b.rank; });
    var placed = [];

    placementOrder.forEach(function (entry) {
      var tier = sizeTierForRank(entry.rank, total);
      var dims = tileDims(tier, canvasW);
      if (dims.w > canvasW - 16) { dims.w = canvasW - 16; dims.h = dims.w * 0.75; }
      if (dims.h > canvasH - 16) { dims.h = canvasH - 16; dims.w = dims.h / 0.75; }

      var seed = hashString((entry.card.mask || '') + ':' + (entry.card.institution || '') + ':' + entry.origIndex);
      var rand = mulberry32(seed || (entry.origIndex + 1) * 97);

      var maxX = Math.max(0, canvasW - dims.w);
      var maxY = Math.max(0, canvasH - dims.h);

      var chosen = null;
      for (var shrink = 0; shrink < 5 && !chosen; shrink++) {
        for (var attempt = 0; attempt < 80; attempt++) {
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
          dims.w *= 0.88; dims.h *= 0.88;
          maxX = Math.max(0, canvasW - dims.w);
          maxY = Math.max(0, canvasH - dims.h);
        }
      }
      if (!chosen) {
        chosen = { x: (rand() * maxX) | 0, y: (rand() * maxY) | 0, w: dims.w, h: dims.h };
      }

      var rotMag = 3 + rand() * 3;
      var rotSign = rand() < 0.5 ? -1 : 1;
      var rot = (rotMag * rotSign).toFixed(2) + 'deg';
      var dur = (10 + rand() * 4).toFixed(2) + 's';
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

  // ── Card element builder ────────────────────────
  function buildSeedElement(positioned, worldOffsetX, worldOffsetY) {
    var card = positioned.card;
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'seed ' + positioned.sizeClass;
    el.dataset.rank = String(positioned.rank);
    el.dataset.mask = String(card.mask || '');
    el.setAttribute('aria-label',
      cleanText(card.institution) + ' card ending in ' + cleanText(card.mask));
    el.style.setProperty('--x', (worldOffsetX + positioned.x) + 'px');
    el.style.setProperty('--y', (worldOffsetY + positioned.y) + 'px');
    el.style.setProperty('--w', positioned.w + 'px');
    el.style.setProperty('--h', positioned.h + 'px');
    el.style.setProperty('--rot', positioned.rot);
    el.style.setProperty('--drift-dur', positioned.driftDur);
    el.style.setProperty('--drift-delay', positioned.driftDelay);

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

    // Stub: click does nothing in this pass; hover lift handled in CSS.
    el.addEventListener('click', function (ev) {
      ev.stopPropagation();
      // Intentionally empty — card detail panel is a follow-up.
    });
    return el;
  }

  // ── Legacy renderCards (kept for test compat) ───
  function renderCards(container, cards) {
    if (!container) return;
    container.innerHTML = '';
    if (!cards || cards.length === 0) return;
    var rect = container.getBoundingClientRect();
    var positioned = allocatePositions(cards, rect.width || container.clientWidth, rect.height || container.clientHeight);
    positioned.forEach(function (p) {
      if (!p) return;
      container.appendChild(buildSeedElement(p, 0, 0));
    });
  }

  // ── Fetch ───────────────────────────────────────
  function fetchHome() {
    return fetch(API_BASE + '/api/home', {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    }).then(function (res) {
      if (res.status === 401) {
        location.replace('/');
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

  // ── localStorage fallback for manual cards ──────
  function loadManualCards() {
    try {
      var raw = localStorage.getItem(MANUAL_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  function saveManualCard(card) {
    try {
      var list = loadManualCards();
      list.push(card);
      localStorage.setItem(MANUAL_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  // ── Header UI bits ──────────────────────────────
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
        .catch(function () {})
        .then(function () {
          try { localStorage.clear(); } catch (_) {}
          location.replace('/');
        });
    });
  }
  function updateSignedInCount(n) {
    var pill = document.getElementById('phone-pill');
    if (!pill) return;
    var params = new URLSearchParams(location.search);
    if (!params.get('phone')) {
      pill.textContent = '+' + n + ' signed in';
    }
  }

  // ── Canvas engine (pan/zoom state lives here) ───
  var Canvas = {
    viewport: null,
    world: null,
    addBtn: null,
    loadingToast: null,

    panX: 0,
    panY: 0,
    // Default zoom to the low end of the initial fit band so the world reads
    // as breathy even before autoFit runs.
    zoom: 0.75,
    positioned: [],       // {card, x, y (world coords), w, h, ...}
    worldOffsetX: 0,       // playground origin inside the world
    worldOffsetY: 0,

    // Runtime input state
    _isPanning: false,
    _panStart: null,
    _pointerMoved: 0,
    _activePointers: {},   // for pinch-zoom
    _pinchStart: null,

    init: function () {
      this.viewport = document.getElementById('viewport');
      this.world = document.getElementById('world');
      this.addBtn = document.getElementById('add-account-btn');
      this.loadingToast = document.getElementById('loading-toast');
      if (!this.viewport || !this.world) return;

      // Center the playground inside the world.
      this.worldOffsetX = Math.round((WORLD_W - PLAYGROUND_W) / 2);
      this.worldOffsetY = Math.round((WORLD_H - PLAYGROUND_H) / 2);

      this._wireInput();
      this._wireResize();
      this._wireKeyboard();
      this.applyTransform();
    },

    applyTransform: function () {
      if (!this.world) return;
      this.world.style.transform =
        'translate(' + this.panX + 'px, ' + this.panY + 'px) scale(' + this.zoom + ')';
    },

    // Fit all rendered cards into the viewport, with a margin.
    autoFit: function () {
      if (!this.positioned.length || !this.viewport) {
        // With no cards, center the viewport on the middle of the playground
        // at the low end of the initial fit band so the empty state also feels
        // breathy rather than filling the screen.
        var vw0 = this.viewport ? this.viewport.clientWidth : window.innerWidth;
        var vh0 = this.viewport ? this.viewport.clientHeight : window.innerHeight;
        this.zoom = INITIAL_FIT_MIN;
        var cx0 = this.worldOffsetX + PLAYGROUND_W / 2;
        var cy0 = this.worldOffsetY + PLAYGROUND_H / 2;
        this.panX = Math.round(vw0 / 2 - cx0 * this.zoom);
        this.panY = Math.round(vh0 / 2 - cy0 * this.zoom);
        this.applyTransform();
        return;
      }
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      var i, p, wx, wy;
      for (i = 0; i < this.positioned.length; i++) {
        p = this.positioned[i];
        wx = this.worldOffsetX + p.x;
        wy = this.worldOffsetY + p.y;
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wx + p.w > maxX) maxX = wx + p.w;
        if (wy + p.h > maxY) maxY = wy + p.h;
      }
      // Extra-generous margin so the fit doesn't kiss the viewport edges —
      // this produces the "held at arm's length" feel rather than filling it.
      var padding = 180;
      minX -= padding; minY -= padding; maxX += padding; maxY += padding;
      var vw = this.viewport.clientWidth;
      var vh = this.viewport.clientHeight;
      var contentW = maxX - minX;
      var contentH = maxY - minY;
      var zoomX = vw / contentW;
      var zoomY = vh / contentH;
      var fitZoom = Math.min(zoomX, zoomY);
      // Cap the initial fit so the cards feel breathy from first load. If the
      // content naturally wants to sit further out (i.e. lots of cards), let
      // it, but never squash in tighter than INITIAL_FIT_MAX.
      fitZoom = Math.min(fitZoom, INITIAL_FIT_MAX);
      // And never shrink below the lower end of the breathy band on auto-fit —
      // the user can still pinch out to MIN_ZOOM manually.
      fitZoom = Math.max(fitZoom, INITIAL_FIT_MIN);
      fitZoom = clamp(fitZoom, MIN_ZOOM, MAX_ZOOM);
      this.zoom = fitZoom;
      // Center the content box inside the viewport.
      var cxWorld = (minX + maxX) / 2;
      var cyWorld = (minY + maxY) / 2;
      this.panX = vw / 2 - cxWorld * this.zoom;
      this.panY = vh / 2 - cyWorld * this.zoom;
      this.applyTransform();
    },

    // Smooth transition to auto-fit (for the "press 0" affordance). We animate
    // the (panX, panY, zoom) triple with a short ease so the user sees the
    // motion rather than a jarring snap.
    smoothAutoFit: function () {
      if (!this.world) return;
      var startPanX = this.panX, startPanY = this.panY, startZoom = this.zoom;
      // Compute target values without committing them yet.
      var savedPanX = this.panX, savedPanY = this.panY, savedZoom = this.zoom;
      this.autoFit();
      var targetPanX = this.panX, targetPanY = this.panY, targetZoom = this.zoom;
      // Restore start state so the tween reads as motion, not a jump.
      this.panX = savedPanX; this.panY = savedPanY; this.zoom = savedZoom;
      this.applyTransform();

      var self = this;
      var duration = 420;
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      function ease(t) { return 1 - Math.pow(1 - t, 3); } // easeOutCubic
      function frame() {
        var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        var t = Math.min(1, (now - t0) / duration);
        var k = ease(t);
        self.panX = startPanX + (targetPanX - startPanX) * k;
        self.panY = startPanY + (targetPanY - startPanY) * k;
        self.zoom = startZoom + (targetZoom - startZoom) * k;
        self.applyTransform();
        if (t < 1) requestAnimationFrame(frame);
      }
      // Skip animation if the user prefers reduced motion.
      var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduceMotion) {
        this.panX = targetPanX; this.panY = targetPanY; this.zoom = targetZoom;
        this.applyTransform();
        return;
      }
      requestAnimationFrame(frame);
    },

    render: function (cards) {
      this.world.innerHTML = '';
      this.positioned = allocatePositions(cards, PLAYGROUND_W, PLAYGROUND_H);
      var self = this;
      this.positioned.forEach(function (p) {
        if (!p) return;
        var el = buildSeedElement(p, self.worldOffsetX, self.worldOffsetY);
        self.world.appendChild(el);
      });
      this._syncAddBtnMode(cards.length);
    },

    // Add a single card without disturbing existing layout. Places it at a
    // seeded spot that doesn't overlap current cards (within the playground
    // box). Returns the positioned entry.
    addCard: function (card) {
      var canvasW = PLAYGROUND_W;
      var canvasH = PLAYGROUND_H;
      var idx = this.positioned.length;
      var tier = sizeTierForRank(Math.max(0, Math.min(idx, 4)), idx + 1);
      var dims = tileDims(tier, canvasW);
      var seed = hashString((card.mask || '') + ':' + (card.institution || '') + ':new:' + Date.now());
      var rand = mulberry32(seed);
      var PAD = 24;
      var chosen = null;
      var maxX = Math.max(0, canvasW - dims.w);
      var maxY = Math.max(0, canvasH - dims.h);
      for (var shrink = 0; shrink < 5 && !chosen; shrink++) {
        for (var attempt = 0; attempt < 80; attempt++) {
          var x = rand() * maxX;
          var y = rand() * maxY;
          var rect = { x: x, y: y, w: dims.w, h: dims.h };
          var clash = false;
          for (var i = 0; i < this.positioned.length; i++) {
            var p = this.positioned[i];
            if (rectsOverlap(rect, { x: p.x, y: p.y, w: p.w, h: p.h }, PAD)) {
              clash = true; break;
            }
          }
          if (!clash) { chosen = rect; break; }
        }
        if (!chosen) {
          dims.w *= 0.88; dims.h *= 0.88;
          maxX = Math.max(0, canvasW - dims.w);
          maxY = Math.max(0, canvasH - dims.h);
        }
      }
      if (!chosen) {
        chosen = { x: rand() * maxX, y: rand() * maxY, w: dims.w, h: dims.h };
      }
      var rotMag = 3 + rand() * 3;
      var rotSign = rand() < 0.5 ? -1 : 1;
      var entry = {
        card: card,
        rank: idx,
        size: tier,
        sizeClass: SIZE_CLASSES[tier],
        x: chosen.x,
        y: chosen.y,
        w: chosen.w,
        h: chosen.h,
        rot: (rotMag * rotSign).toFixed(2) + 'deg',
        driftDur: (10 + rand() * 4).toFixed(2) + 's',
        driftDelay: (rand() * 1.4).toFixed(2) + 's'
      };
      this.positioned.push(entry);
      var el = buildSeedElement(entry, this.worldOffsetX, this.worldOffsetY);
      el.classList.add('is-new');
      this.world.appendChild(el);
      this._syncAddBtnMode(this.positioned.length);
      // Gently re-fit so the new card is in view.
      this.autoFit();
      return entry;
    },

    _syncAddBtnMode: function (n) {
      if (!this.addBtn) return;
      if (n === 0) {
        this.addBtn.classList.add('add-btn--center');
        this.addBtn.classList.remove('add-btn--corner');
        this.addBtn.textContent = '+ add account';
      } else {
        this.addBtn.classList.remove('add-btn--center');
        this.addBtn.classList.add('add-btn--corner');
        this.addBtn.textContent = '+ add';
      }
    },

    hideLoading: function () {
      if (this.loadingToast) this.loadingToast.remove();
    },

    showError: function () {
      if (this.loadingToast) {
        this.loadingToast.classList.remove('toast--loading');
        this.loadingToast.textContent = 'give us a sec…';
      }
    },

    // ── Input handlers ─────────────────────────
    _wireInput: function () {
      var self = this;
      var vp = this.viewport;

      // Pointer events cover mouse + touch + pen.
      vp.addEventListener('pointerdown', function (e) {
        // Ignore if the pointer originates inside a card / UI chip — we still
        // want them to be clickable.
        if (e.target.closest('.seed') || e.target.closest('.chip') ||
            e.target.closest('.add-btn') || e.target.closest('.modal-backdrop')) {
          return;
        }
        vp.setPointerCapture(e.pointerId);
        self._activePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        if (Object.keys(self._activePointers).length === 1) {
          self._isPanning = true;
          self._panStart = { x: e.clientX, y: e.clientY, panX: self.panX, panY: self.panY };
          self._pointerMoved = 0;
          vp.classList.add('is-panning');
        } else if (Object.keys(self._activePointers).length === 2) {
          // Pinch start
          var ids = Object.keys(self._activePointers);
          var a = self._activePointers[ids[0]];
          var b = self._activePointers[ids[1]];
          var dx = b.x - a.x, dy = b.y - a.y;
          self._pinchStart = {
            dist: Math.sqrt(dx * dx + dy * dy),
            zoom: self.zoom,
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
            panX: self.panX,
            panY: self.panY
          };
          self._isPanning = false;
        }
      });

      vp.addEventListener('pointermove', function (e) {
        if (!self._activePointers[e.pointerId]) return;
        var prev = self._activePointers[e.pointerId];
        self._activePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        var ids = Object.keys(self._activePointers);
        if (ids.length === 2 && self._pinchStart) {
          var a = self._activePointers[ids[0]];
          var b = self._activePointers[ids[1]];
          var dx = b.x - a.x, dy = b.y - a.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          var newZoom = clamp(self._pinchStart.zoom * (d / self._pinchStart.dist), MIN_ZOOM, MAX_ZOOM);
          // Keep the pinch midpoint anchored in world-space.
          var cx = self._pinchStart.cx;
          var cy = self._pinchStart.cy;
          var rect = vp.getBoundingClientRect();
          var px = cx - rect.left;
          var py = cy - rect.top;
          // world point under pinch center at start:
          var worldPx = (px - self._pinchStart.panX) / self._pinchStart.zoom;
          var worldPy = (py - self._pinchStart.panY) / self._pinchStart.zoom;
          self.panX = px - worldPx * newZoom;
          self.panY = py - worldPy * newZoom;
          self.zoom = newZoom;
          self.applyTransform();
          return;
        }
        if (self._isPanning && self._panStart) {
          var mx = e.clientX - self._panStart.x;
          var my = e.clientY - self._panStart.y;
          self._pointerMoved = Math.max(self._pointerMoved, Math.abs(mx), Math.abs(my));
          self.panX = self._panStart.panX + mx;
          self.panY = self._panStart.panY + my;
          self.applyTransform();
        }
      });

      function endPointer(e) {
        delete self._activePointers[e.pointerId];
        if (Object.keys(self._activePointers).length < 2) {
          self._pinchStart = null;
        }
        if (Object.keys(self._activePointers).length === 0) {
          self._isPanning = false;
          self._panStart = null;
          vp.classList.remove('is-panning');
        }
        try { vp.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      vp.addEventListener('pointerup', endPointer);
      vp.addEventListener('pointercancel', endPointer);
      vp.addEventListener('pointerleave', endPointer);

      // Wheel: ctrl+wheel (or trackpad pinch) = zoom; plain wheel = pan.
      vp.addEventListener('wheel', function (e) {
        e.preventDefault();
        var rect = vp.getBoundingClientRect();
        var px = e.clientX - rect.left;
        var py = e.clientY - rect.top;
        if (e.ctrlKey) {
          var newZoom = clamp(self.zoom * (1 - e.deltaY * WHEEL_ZOOM_INTENSITY), MIN_ZOOM, MAX_ZOOM);
          // Anchor the zoom to the cursor's world coord.
          var worldPx = (px - self.panX) / self.zoom;
          var worldPy = (py - self.panY) / self.zoom;
          self.panX = px - worldPx * newZoom;
          self.panY = py - worldPy * newZoom;
          self.zoom = newZoom;
        } else {
          self.panX -= e.deltaX * WHEEL_PAN_INTENSITY;
          self.panY -= e.deltaY * WHEEL_PAN_INTENSITY;
        }
        self.applyTransform();
      }, { passive: false });
    },

    _wireResize: function () {
      var self = this;
      var pending = null;
      window.addEventListener('resize', function () {
        if (pending) cancelAnimationFrame(pending);
        pending = requestAnimationFrame(function () {
          self.autoFit();
          pending = null;
        });
      });
    },

    _wireKeyboard: function () {
      // "N" or Cmd/Ctrl+A opens the add-account modal.
      // "G" opens the add-goal modal.
      // "0" smoothly resets zoom + centering to auto-fit.
      // All shortcuts are suppressed while the user is typing in a field.
      var self = this;
      document.addEventListener('keydown', function (e) {
        var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target && e.target.tagName || '');
        if (typing) return;
        if (e.target && e.target.isContentEditable) return;

        var openAdd = window.CashBFFAddAccount && window.CashBFFAddAccount.open;
        var openGoal = window.CashBFFGoal && window.CashBFFGoal.open;

        if (e.key === '0' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          self.smoothAutoFit();
          return;
        }
        if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey) {
          if (openAdd) { e.preventDefault(); openAdd(); }
        } else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
          if (openAdd) { e.preventDefault(); openAdd(); }
        } else if ((e.key === 'g' || e.key === 'G') && !e.metaKey && !e.ctrlKey) {
          if (openGoal) { e.preventDefault(); openGoal(); }
        }
      });
    }
  };

  // ── Boot ────────────────────────────────────────
  function boot() {
    wirePhonePill();
    wireSignout();
    Canvas.init();

    // Wire the add button to the modal.
    var addBtn = document.getElementById('add-account-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        if (window.CashBFFAddAccount && window.CashBFFAddAccount.open) {
          window.CashBFFAddAccount.open();
        }
      });
    }

    fetchHome().then(function (data) {
      var cards = (data.cards || []).slice();
      // Layer in any optimistically-saved manual cards (endpoint may be down).
      var locals = loadManualCards();
      if (locals.length) {
        // Dedupe by (institution, mask) so refresh doesn't double-render
        // entries that later made it to the backend.
        var seen = {};
        cards.forEach(function (c) {
          seen[(c.institution || '').toLowerCase() + '|' + (c.mask || '')] = true;
        });
        locals.forEach(function (c) {
          var key = (c.institution || '').toLowerCase() + '|' + (c.mask || '');
          if (!seen[key]) { cards.push(c); seen[key] = true; }
        });
      }
      updateSignedInCount(cards.length);
      Canvas.render(cards);
      Canvas.hideLoading();
      Canvas.autoFit();
    }).catch(function () {
      Canvas.showError();
      // Still allow add-account even on fetch error.
      Canvas._syncAddBtnMode(0);
    });
  }

  // ── Public API ──────────────────────────────────
  window.CashBFFHome = {
    allocatePositions: allocatePositions,
    renderCards: renderCards,
    fetchHome: fetchHome,
    addLocalCard: function (card) {
      saveManualCard(card);
      Canvas.addCard(card);
      updateSignedInCount(Canvas.positioned.length);
    },
    addServerCard: function (card) {
      // Card made it to the server; render it but don't persist to localStorage.
      Canvas.addCard(card);
      updateSignedInCount(Canvas.positioned.length);
    },
    _canvas: Canvas,
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
