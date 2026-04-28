// Reimbursements panel — happy path.
//
// Verifies the full lifecycle of a row in the reimbursements popup:
//   1. Open the popup via #reimbursements-btn.
//   2. Add a new item (POST /api/reimbursements). Status starts at 'open'.
//   3. Advance status open → submitted via the cycle button.
//   4. Advance status submitted → received via the cycle button.
//   5. Delete the item (trash + inline confirm).
//
// Selectors come from home.html + assets/js/home.js:
//   #reimbursements-btn        opens the panel
//   #reimbursements-pop        the panel itself (.open when visible)
//   #reimb-add-input           description input
//   #reimb-add-form            submits POST
//   .reimb-item                row, has data-id + data-status
//   .reimb-cycle               button on the right that advances status
//   .reimb-back                ↩ undo button on advanced rows
//   .reimb-item__trash         delete glyph
//   .reimb-item__confirm-yes   confirms delete + status changes inline
//
// NB: as of the mis-click safety patch, clicking .reimb-cycle no longer
// PATCHes immediately — it opens an inline confirm; .reimb-item__confirm-yes
// fires the PATCH. .reimb-back works the same way for going backward.
//
// Cleanup: items live in the `reimbursements` table (separate from
// scheduled). The auth-helper sweep only touches scheduled rows, so this
// spec runs its own DELETE-by-API cleanup in afterAll for any leftover
// __playwright_test*__ rows.

import { test, expect, type Page } from '@playwright/test';
import {
  authenticatedContext,
  authenticatedApi,
  cleanupTestData,
  TEST_MARKER,
} from './auth-helper';

const TEST_DESC = `${TEST_MARKER}_reimb__`;

/** Best-effort sweep: list /api/reimbursements and DELETE any row whose
 *  description starts with the test marker. Mirrors cleanupTestData in
 *  auth-helper.ts but for the reimbursements endpoints. */
async function cleanupReimbursements(): Promise<void> {
  const api = await authenticatedApi();
  if (!api) return;
  try {
    const res = await api.get('/api/reimbursements');
    if (!res.ok()) {
      console.warn(`[cleanup-reimb] GET /api/reimbursements -> HTTP ${res.status()}`);
      await api.dispose();
      return;
    }
    const data = (await res.json()) as { items?: Array<{ id: unknown; description?: unknown }> };
    const items = (data.items || []).filter((it) => {
      const d = String(it.description || '');
      return d.startsWith(TEST_MARKER);
    });
    if (items.length === 0) {
      await api.dispose();
      return;
    }
    console.log(`[cleanup-reimb] deleting ${items.length} leftover __playwright_test*__ row(s)`);
    for (const it of items) {
      try {
        const r = await api.delete(`/api/reimbursements/${encodeURIComponent(String(it.id))}`);
        if (!r.ok()) {
          console.warn(`[cleanup-reimb] DELETE id=${it.id} -> HTTP ${r.status()}`);
        }
      } catch (err) {
        console.warn(`[cleanup-reimb] DELETE id=${it.id} threw:`, err);
      }
    }
  } finally {
    await api.dispose();
  }
}

async function openHome(page: Page) {
  await page.goto('/home');
  await expect(page.locator('#grid')).toBeVisible();
}

test.describe('reimbursements panel', () => {
  test.beforeAll(async () => {
    await cleanupReimbursements();
    await cleanupTestData();
  });
  test.afterAll(async () => {
    await cleanupReimbursements();
    await cleanupTestData();
  });

  test('add → open → submitted → received → delete', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await openHome(page);

    // ── Open the panel ─────────────────────────────────────
    await page.locator('#reimbursements-btn').click();
    const panel = page.locator('#reimbursements-pop');
    await expect(panel).toHaveClass(/(^|\s)open(\s|$)/);

    // The list fetches lazily on first open. Wait for the network call so
    // the rendered state is reliable before we add anything.
    await page.waitForResponse(
      (r) =>
        r.url().includes('/api/reimbursements') &&
        r.request().method() === 'GET' &&
        r.ok(),
      { timeout: 15_000 },
    ).catch(() => {
      // Cache might be backend-fresh from a prior test run — that's fine.
    });

    // ── Add an item (POST) ─────────────────────────────────
    await page.fill('#reimb-add-input', TEST_DESC);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/reimbursements') &&
          r.request().method() === 'POST' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      page.locator('#reimb-add-form button[type="submit"]').click(),
    ]);

    const row = page.locator(`.reimb-item:has-text("${TEST_DESC}")`).first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'open');

    // ── Advance: open → submitted ──────────────────────────
    // The cycle button reads "submit claim →" while status is open. Clicking
    // it now opens an inline confirm; we then click "yes" to fire the PATCH.
    let cycleBtn = row.locator('.reimb-cycle');
    await expect(cycleBtn).toContainText(/submit/i);
    await cycleBtn.click();
    let yesAdvance = row.locator('.reimb-item__confirm-yes');
    await expect(yesAdvance).toBeVisible();
    await expect(row.locator('.reimb-item__confirm-label')).toContainText(/submit claim\?/i);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/reimbursements') &&
          r.request().method() === 'PATCH' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      yesAdvance.click(),
    ]);
    await expect(row).toHaveAttribute('data-status', 'submitted');

    // ── Advance: submitted → received ──────────────────────
    cycleBtn = row.locator('.reimb-cycle');
    await expect(cycleBtn).toContainText(/got\s*EOB|got eob/i);
    await cycleBtn.click();
    yesAdvance = row.locator('.reimb-item__confirm-yes');
    await expect(yesAdvance).toBeVisible();
    await expect(row.locator('.reimb-item__confirm-label')).toContainText(/mark received\?/i);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/reimbursements') &&
          r.request().method() === 'PATCH' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      yesAdvance.click(),
    ]);
    await expect(row).toHaveAttribute('data-status', 'received');
    // Terminal: button is disabled + reads "done".
    await expect(row.locator('.reimb-cycle')).toBeDisabled();
    await expect(row.locator('.reimb-cycle')).toContainText(/done/i);

    // ── Back-arrow undo: received → submitted ──────────────
    // The ↩ button is invisible at rest; force-click since hover is flaky.
    await row.locator('.reimb-back').click({ force: true });
    let yesBack = row.locator('.reimb-item__confirm-yes');
    await expect(yesBack).toBeVisible();
    await expect(row.locator('.reimb-item__confirm-label')).toContainText(/back to submitted\?/i);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/reimbursements') &&
          r.request().method() === 'PATCH' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      yesBack.click(),
    ]);
    await expect(row).toHaveAttribute('data-status', 'submitted');

    // Re-advance back to received so the delete leg of the test still
    // exercises the trash-on-received path.
    cycleBtn = row.locator('.reimb-cycle');
    await cycleBtn.click();
    yesAdvance = row.locator('.reimb-item__confirm-yes');
    await expect(yesAdvance).toBeVisible();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/reimbursements') &&
          r.request().method() === 'PATCH' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      yesAdvance.click(),
    ]);
    await expect(row).toHaveAttribute('data-status', 'received');

    // ── Delete via trash + inline confirm ──────────────────
    // Trash sits to the left of the cycle btn. Force click — the glyph is
    // inside an SVG and headless hover state can be flaky.
    await row.locator('.reimb-item__trash').click({ force: true });

    const yesBtn = row.locator('.reimb-item__confirm-yes');
    await expect(yesBtn).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/reimbursements') &&
          r.request().method() === 'DELETE' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      yesBtn.click(),
    ]);

    // Row should disappear from the panel.
    await expect.poll(
      async () =>
        page.locator(`.reimb-item:has-text("${TEST_DESC}")`).count(),
      { timeout: 10_000 },
    ).toBe(0);

    await context.close();
  });
});
