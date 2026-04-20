// Tests for the v2 scatter-seedbed home.js module.
//
// STATUS: waiting on home.js build.
//
// The other agent is porting cashbff.com/home to the v2 scatter-seedbed
// design and will expose:
//
//   window.CashBFFHome = {
//     allocatePositions(cards, canvasWidthPx, canvasHeightPx),
//     renderCards(container, cards),
//     fetchHome(),
//   }
//
// Card shape: { institution: string, mask: string, balance: number, limit: number }
//
// Until that module lands, every test below is marked `.todo` so the suite
// runs green without silently passing against a missing implementation.
// Once home.js ships with the contract above:
//   1. Replace `.todo(...)` with `(...)` (drop the `.todo`).
//   2. Uncomment the `loadModule()` call in beforeAll.
//   3. Re-run `npx vitest run`.
//
// Keep these as pure unit tests — no integration / no real DOM layout.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ── Test fixtures ───────────────────────────────────────────────────
const CANVAS_W = 390;   // iPhone-ish viewport width used by v2 scatter
const CANVAS_H = 720;
const CARD_W = 240;
const CARD_H = 150;

function makeCard(overrides = {}) {
  return {
    institution: 'Capital One',
    mask: '4471',
    balance: 847.22,
    limit: 2500,
    ...overrides,
  };
}

function makeCards(n) {
  const banks = ['Capital One', 'Chase', 'Amex', 'Citi', 'Discover', 'Apple', 'Wells Fargo', 'BoA', 'Synchrony', 'Barclays', 'USAA', 'PNC'];
  return Array.from({ length: n }, (_, i) => makeCard({
    institution: banks[i % banks.length],
    mask: String(1000 + i),
    balance: 100 * (i + 1) + 47,
    limit: 1000 * (i + 1),
  }));
}

// Pairwise minimum separation. Cards are ~240x150; require centers to be
// at least half the smaller dim apart so visible art doesn't fully stack.
// (Full non-overlap would need ~sqrt(CARD_W^2 + CARD_H^2); we relax because
// the scatter design intentionally allows edge kiss.)
const MIN_CENTER_DISTANCE = 60;

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Module loader ───────────────────────────────────────────────────
// Uncomment once home.js exports `window.CashBFFHome` (or ES exports).
// If the agent ships ES exports instead of a window global, swap to:
//   import * as Home from '../home.js';  and drop window usage.
let Home;
async function loadModule() {
  // await import('../home.js');
  // Home = window.CashBFFHome;
}

beforeAll(async () => {
  await loadModule();
});

// ── allocatePositions ───────────────────────────────────────────────
describe('allocatePositions', () => {
  it.todo('returns an array with the same length as its input', () => {
    const cards = makeCards(4);
    const out = Home.allocatePositions(cards, CANVAS_W, CANVAS_H);
    expect(out).toHaveLength(4);
  });

  it.todo('preserves all original card fields on each entry', () => {
    const cards = makeCards(3);
    const out = Home.allocatePositions(cards, CANVAS_W, CANVAS_H);
    out.forEach((entry, i) => {
      expect(entry.card.institution).toBe(cards[i].institution);
      expect(entry.card.mask).toBe(cards[i].mask);
      expect(entry.card.balance).toBe(cards[i].balance);
      expect(entry.card.limit).toBe(cards[i].limit);
    });
  });

  it.todo('adds numeric x, y, rotation, scale to each entry', () => {
    const out = Home.allocatePositions(makeCards(3), CANVAS_W, CANVAS_H);
    out.forEach((entry) => {
      expect(typeof entry.x).toBe('number');
      expect(typeof entry.y).toBe('number');
      expect(typeof entry.rotation).toBe('number');
      expect(typeof entry.scale).toBe('number');
      expect(Number.isFinite(entry.x)).toBe(true);
      expect(Number.isFinite(entry.y)).toBe(true);
      expect(Number.isFinite(entry.rotation)).toBe(true);
      expect(Number.isFinite(entry.scale)).toBe(true);
    });
  });

  it.todo('places cards so no two centers overlap below the min distance', () => {
    const out = Home.allocatePositions(makeCards(5), CANVAS_W, CANVAS_H);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(distance(out[i], out[j])).toBeGreaterThan(MIN_CENTER_DISTANCE);
      }
    }
  });

  // If allocation is deterministic (seeded), this should pass. If the agent
  // chose Math.random() with no seed, flip this to `.todo` with a note.
  it.todo('is stable across re-renders for the same input', () => {
    const cards = makeCards(5);
    const a = Home.allocatePositions(cards, CANVAS_W, CANVAS_H);
    const b = Home.allocatePositions(cards, CANVAS_W, CANVAS_H);
    a.forEach((entry, i) => {
      expect(entry.x).toBeCloseTo(b[i].x, 5);
      expect(entry.y).toBeCloseTo(b[i].y, 5);
      expect(entry.rotation).toBeCloseTo(b[i].rotation, 5);
      expect(entry.scale).toBeCloseTo(b[i].scale, 5);
    });
  });

  it.todo('handles 1, 3, 5, 6, 8, 12 cards without throwing or exceeding canvas bounds', () => {
    for (const n of [1, 3, 5, 6, 8, 12]) {
      const out = Home.allocatePositions(makeCards(n), CANVAS_W, CANVAS_H);
      expect(out).toHaveLength(n);
      out.forEach((entry) => {
        // Allow the card art to extend slightly past edges via the scale factor,
        // but the center should be inside the canvas.
        expect(entry.x).toBeGreaterThanOrEqual(0);
        expect(entry.x).toBeLessThanOrEqual(CANVAS_W);
        expect(entry.y).toBeGreaterThanOrEqual(0);
        expect(entry.y).toBeLessThanOrEqual(CANVAS_H);
      });
    }
  });

  it.todo('scales smallest balance largest and largest balance smallest (relative)', () => {
    const cards = [
      makeCard({ mask: 'LOW', balance: 50 }),
      makeCard({ mask: 'MID', balance: 500 }),
      makeCard({ mask: 'HI', balance: 5000 }),
    ];
    const out = Home.allocatePositions(cards, CANVAS_W, CANVAS_H);
    const byMask = Object.fromEntries(out.map((e) => [e.card.mask, e]));
    expect(byMask.LOW.scale).toBeGreaterThan(byMask.MID.scale);
    expect(byMask.MID.scale).toBeGreaterThan(byMask.HI.scale);
  });

  it.todo('returns an empty array for an empty input', () => {
    expect(Home.allocatePositions([], CANVAS_W, CANVAS_H)).toEqual([]);
  });
});

// ── renderCards ─────────────────────────────────────────────────────
describe('renderCards', () => {
  let container;
  beforeEach(() => {
    container = document.createElement('div');
  });

  it.todo('creates one .card element per input card', () => {
    const cards = makeCards(3);
    Home.renderCards(container, cards);
    expect(container.querySelectorAll('.card')).toHaveLength(3);
  });

  it.todo('tags each .card with a data attribute matching the input mask', () => {
    const cards = makeCards(3);
    Home.renderCards(container, cards);
    const nodes = container.querySelectorAll('.card');
    nodes.forEach((node, i) => {
      // Accept either data-mask or data-slot-keyed lookup — update to match module.
      const mask = node.getAttribute('data-mask') || node.dataset.mask;
      expect(mask).toBe(cards[i].mask);
    });
  });

  it.todo('applies absolute positioning + rotate + scale as inline styles', () => {
    const cards = makeCards(2);
    Home.renderCards(container, cards);
    const first = container.querySelector('.card');
    const style = first.getAttribute('style') || '';
    expect(style).toMatch(/position:\s*absolute/i);
    expect(style).toMatch(/rotate|transform/i);
    expect(style).toMatch(/scale|transform/i);
  });

  it.todo('renders the empty-state element when given an empty array', () => {
    Home.renderCards(container, []);
    expect(container.querySelectorAll('.card')).toHaveLength(0);
    expect(container.textContent.toLowerCase()).toContain('no cards connected yet');
  });
});

// ── fetchHome ───────────────────────────────────────────────────────
describe('fetchHome', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.todo('resolves with { cards: [...] } on a 200 response', async () => {
    const payload = { cards: makeCards(2) };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    const out = await Home.fetchHome();
    expect(out).toEqual(payload);
  });

  it.todo('sends credentials: include in the fetch options', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cards: [] }),
    });
    await Home.fetchHome();
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts).toMatchObject({ credentials: 'include' });
  });

  it.todo('redirects to / on 401 via location.replace', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    // jsdom's location is non-configurable; stub only the method we need.
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, replace },
    });
    await Home.fetchHome().catch(() => {});
    expect(replace).toHaveBeenCalledWith('/');
  });

  // The module's chosen 500 contract is unknown until it ships. Update this
  // to either `.rejects` or an `{ error: ... }` shape once confirmed.
  it.todo('handles 500 according to module contract (reject or error flag)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    // Example (reject branch):
    //   await expect(Home.fetchHome()).rejects.toThrow();
    // Example (error-flag branch):
    //   await expect(Home.fetchHome()).resolves.toMatchObject({ error: true });
  });
});
