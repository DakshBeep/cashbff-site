// Reimbursements panel — confirm row UX.
//
// The cycle button (`submit claim →` / `got EOB →`) and the back-arrow (`↩`)
// are misclick-protected: clicking them opens an inline `<label> · yes ·
// cancel` confirm row. Only `yes` fires the PATCH. This spec exercises the
// cancel branch + the back-arrow flow, which the broader
// reimbursements.spec.ts only touches in passing.
//
// Flow:
//   1. Open panel + add a test reimbursement.
//   2. Click `submit claim →` → confirm row appears with label "submit claim?".
//   3. Click `cancel` → row reverts, status stays `open`, no PATCH fires.
//   4. Click `submit claim →` again, click `yes` → status advances to `submitted`.
//   5. A `↩` back-arrow is now present + visible-on-hover.
//   6. Click `↩` → confirm appears, click `yes` → reverts to `open`.
//   7. Cleanup via DELETE.
//
// Selectors:
//   #reimbursements-btn / #reimbursements-pop
//   #reimb-add-input / #reimb-add-form
//   .reimb-item            row, has data-id + data-status
//   .reimb-cycle           advance button
//   .reimb-back            ↩ undo button on advanced rows
//   .reimb-item__confirm-label / -yes / -no  inline confirm row

import { test, expect, type Page } from '@playwright/test';
import {
  authenticatedContext,
  authenticatedApi,
  TEST_MARKER,
} from './auth-helper';

const TEST_DESC = `${TEST_MARKER}_reimbconfirm__`;

async function cleanupReimbursements(): Promise<void> {
  const api = await authenticatedApi();
  if (!api) return;
  try {
    const res = await api.get('/api/reimbursements');
    if (!res.ok()) return;
    const data = (await res.json()) as { items?: Array<{ id: unknown; description?: unknown }> };
    const leftovers = (data.items || []).filter((it) =>
      String(it.description || '').startsWith(TEST_MARKER),
    );
    for (const it of leftovers) {
      await api
        .delete(`/api/reimbursements/${encodeURIComponent(String(it.id))}`)
        .catch(() => {});
    }
  } finally {
    await api.dispose();
  }
}

async function openReimbursements(page: Page) {
  await page.goto('/home');
  await expect(page.locator('#grid')).toBeVisible();
  await page.locator('#reimbursements-btn').click();
  await expect(page.locator('#reimbursements-pop')).toHaveClass(/(^|\s)open(\s|$)/);
  // Wait for the GET so the list is in a known state when we add.
  await page
    .waitForResponse(
      (r) =>
        r.url().includes('/api/reimbursements') &&
        r.request().method() === 'GET' &&
        r.ok(),
      { timeout: 15_000 },
    )
    .catch(() => {});
}

test.describe('reimbursements — confirm + back-arrow', () => {
  test.beforeAll(async () => {
    await cleanupReimbursements();
  });
  test.afterAll(async () => {
    await cleanupReimbursements();
  });

  test('cancel reverts confirm; yes advances; back-arrow reverts again', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    await openReimbursements(page);

    // ── Add ────────────────────────────────────────────────
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

    // ── Click `submit claim →` → confirm appears ──────────
    let cycleBtn = row.locator('.reimb-cycle');
    await expect(cycleBtn).toContainText(/submit/i);
    await cycleBtn.click();
    await expect(row.locator('.reimb-item__confirm-label')).toContainText(/submit claim\?/i);
    const yesBtn = row.locator('.reimb-item__confirm-yes');
    const noBtn = row.locator('.reimb-item__confirm-no');
    await expect(yesBtn).toBeVisible();
    await expect(noBtn).toBeVisible();

    // ── Click `cancel` → row reverts to open, NO patch fires ──
    let patchSeen = false;
    const onPatch = (req: import('@playwright/test').Request) => {
      if (req.url().includes('/api/reimbursements') && req.method() === 'PATCH') patchSeen = true;
    };
    page.on('request', onPatch);
    await noBtn.click();
    // Confirm row should be gone, cycle btn back.
    await expect(row.locator('.reimb-item__confirm-label')).toHaveCount(0);
    await expect(row.locator('.reimb-cycle')).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'open');
    // Quick beat to give a stray PATCH a chance to fire (it shouldn't).
    await page.waitForTimeout(500);
    expect(patchSeen, 'cancel should NOT fire a PATCH').toBe(false);
    page.off('request', onPatch);

    // ── Click `submit claim →` again, click `yes` → submitted ──
    cycleBtn = row.locator('.reimb-cycle');
    await cycleBtn.click();
    await expect(row.locator('.reimb-item__confirm-yes')).toBeVisible();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/reimbursements') &&
          r.request().method() === 'PATCH' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      row.locator('.reimb-item__confirm-yes').click(),
    ]);
    await expect(row).toHaveAttribute('data-status', 'submitted');

    // ── ↩ back-arrow is present in the DOM ────────────────
    const backBtn = row.locator('.reimb-back');
    await expect(backBtn).toHaveCount(1);

    // ── Click ↩ → confirm appears → click yes → status: open ──
    await backBtn.click({ force: true });
    await expect(row.locator('.reimb-item__confirm-label')).toContainText(/back to open\?/i);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/reimbursements') &&
          r.request().method() === 'PATCH' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      row.locator('.reimb-item__confirm-yes').click(),
    ]);
    await expect(row).toHaveAttribute('data-status', 'open');

    // ── Cleanup via trash + confirm ───────────────────────
    await row.locator('.reimb-item__trash').click({ force: true });
    await expect(row.locator('.reimb-item__confirm-yes')).toBeVisible();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/reimbursements') &&
          r.request().method() === 'DELETE' &&
          r.ok(),
        { timeout: 15_000 },
      ),
      row.locator('.reimb-item__confirm-yes').click(),
    ]);

    await context.close();
  });
});
