// Recurring tab smoke test.
//
// Phase 3 ships the suggestions + streams panels and the rollover modal.
// Phase 4 will own the deep E2E sweep — for now we just want to confirm:
//   1. The recurring chip opens the popover.
//   2. Both labeled sections render ("to review (N)" + "your recurring (M)").
//   3. Clicking "+ add to recurring" on a suggestion fires a real
//      POST /api/recurring/suggestions/:merchant/confirm.
//   4. The rollover modal markup is wired up (overlay + pop nodes exist
//      and are hidden by default).
//
// The confirm POST is mocked via page.route so this spec doesn't mutate
// Daksh's prod state. The GET /suggestions list is also mocked so we can
// guarantee at least one card renders even if the live data shifts.
//
// Selectors:
//   #recurring-btn                       chip
//   #recurring-pop                       panel
//   #recurring-suggestions-list          list of cards
//   #recurring-streams-list              list of confirmed rows
//   .recurring-suggestion__confirm       primary "✓ add to recurring" button
//   #rollover-overlay / #rollover-pop    rollover modal nodes

import { test, expect, type Page } from '@playwright/test';
import { authenticatedContext } from './auth-helper';

const MOCK_SUGGESTIONS = {
  items: [
    {
      merchant: 'mock_spotify',
      display_name: 'Spotify (mocked)',
      amount: 11.99,
      next_due_date: '2026-05-14',
      cadence_days: 30,
      last_charge_date: '2026-04-14',
      suggested_at: '2026-04-15T00:00:00Z',
      // Phase-5: provenance fields surfaced via the LEFT JOIN with
      // account_balances. The UI renders "from {Institution} ···{mask}".
      from_institution: 'Bank of America',
      from_mask: '1234',
    },
    {
      merchant: 'mock_audible',
      display_name: 'Audible (mocked)',
      amount: 14.95,
      next_due_date: '2026-05-20',
      cadence_days: 30,
      last_charge_date: '2026-04-20',
      suggested_at: '2026-04-22T00:00:00Z',
      from_institution: null,
      from_mask: null,
    },
  ],
};

const MOCK_STREAMS = { items: [] as unknown[] };
const MOCK_ROLLOVER = { items: [] as unknown[] };

async function openHome(page: Page) {
  await page.goto('/home');
  await expect(page.locator('#grid')).toBeVisible();
}

test.describe('recurring tab smoke', () => {
  test('renders both sections + confirm round-trips', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    let confirmCalled = false;
    let confirmPayload: Record<string, unknown> | null = null;

    // Mock the three GETs so the panel paints with deterministic data.
    await page.route('**/api/recurring/suggestions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SUGGESTIONS),
      });
    });
    await page.route('**/api/recurring/streams', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_STREAMS),
      });
    });
    await page.route('**/api/recurring/rollover-prompts', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_ROLLOVER),
      });
    });
    // Mock the confirm POST so we don't write to Daksh's account.
    await page.route(
      /\/api\/recurring\/suggestions\/[^/]+\/confirm$/,
      async (route) => {
        const req = route.request();
        if (req.method() === 'POST') {
          confirmCalled = true;
          try { confirmPayload = JSON.parse(req.postData() || '{}'); } catch {}
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: true,
              stream: {
                ...MOCK_SUGGESTIONS.items[0],
                confirmed_at: '2026-04-27T00:00:00Z',
                linked_scheduled_txn_id: 9999,
              },
              scheduled_txn: {
                id: 9999, date: '2026-05-14', amount: 11.99,
                name: 'Spotify (mocked)', type: 'sub',
                card_account_id: null, note: null, confidence: 1,
                pending: false, source: 'scheduled',
                institution: null, mask: null,
              },
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    await openHome(page);

    // ── Open the recurring popup ────────────────────────────
    await page.locator('#recurring-btn').click();
    const pop = page.locator('#recurring-pop');
    await expect(pop).toHaveClass(/(^|\s)open(\s|$)/);

    // ── Both labeled sections present ───────────────────────
    await expect(
      page.locator('#recurring-suggestions-section .recurring-section__heading')
    ).toContainText('to review');
    await expect(
      page.locator('#recurring-streams-section .recurring-section__heading')
    ).toContainText('your recurring');

    // Suggestion cards render — at least one with the mocked merchant.
    const firstCard = page.locator(
      '#recurring-suggestions-list .recurring-suggestion'
    ).first();
    await expect(firstCard).toBeVisible();
    await expect(firstCard).toHaveAttribute('data-merchant', 'mock_spotify');
    await expect(
      firstCard.locator('.recurring-suggestion__confirm')
    ).toContainText('add to recurring');

    // ── Phase-5 provenance line: "from Bank of America ···1234" ──
    // Renders only when both from_institution and from_mask are present.
    const provenance = firstCard.locator('.recurring-suggestion__meta');
    await expect(provenance).toBeVisible();
    await expect(provenance).toContainText('from Bank of America');
    await expect(provenance).toContainText('1234');

    // ── Phase-5 confirms the OLD "saw this last on..." line is gone ──
    // The reasoning meta line was deleted in Phase 5; the only meta line
    // now is the provenance line above.
    await expect(firstCard.locator('.recurring-suggestion__meta'))
      .not.toContainText('saw this last on');
    await expect(firstCard.locator('.recurring-suggestion__meta'))
      .not.toContainText('cadence');

    // ── Second card has no from_* → no provenance line at all ────
    const secondCard = page.locator(
      '#recurring-suggestions-list .recurring-suggestion'
    ).nth(1);
    await expect(secondCard).toBeVisible();
    await expect(secondCard.locator('.recurring-suggestion__meta')).toHaveCount(0);

    // The chip badge should reflect the count.
    const badge = page.locator('#recurring-btn-count');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('2');

    // ── Empty-state for streams (mock returned no items) ────
    await expect(
      page.locator('#recurring-streams-list .recurring-empty')
    ).toContainText('nothing tracked yet');

    // ── Click "+ add to recurring" on the first card ────────
    await firstCard.locator('.recurring-suggestion__confirm').click();

    // Wait for the confirm POST to land.
    await expect.poll(() => confirmCalled, { timeout: 5_000 }).toBe(true);
    expect(confirmPayload).toBeTruthy();
    expect(confirmPayload).toMatchObject({
      display_name: expect.any(String),
      next_due_date: expect.any(String),
      amount: expect.any(Number),
    });

    // ── Rollover modal markup exists + is hidden by default ─
    const rolloverPop = page.locator('#rollover-pop');
    await expect(rolloverPop).toHaveAttribute('aria-hidden', 'true');
    const rolloverOverlay = page.locator('#rollover-overlay');
    await expect(rolloverOverlay).not.toHaveClass(/(^|\s)open(\s|$)/);

    // Screenshot for QA. Stored under test-results/.
    await page.screenshot({
      path: 'test-results/recurring-tab.png',
      fullPage: false,
    });

    await context.close();
  });
});
