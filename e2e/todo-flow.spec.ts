// To-do panel — happy-path lifecycle.
//
// To-dos live ENTIRELY in localStorage (cbff_v1_todos via cacheRead/cacheWrite
// in home.js). No backend. The panel:
//   - Seeds an example task ("call insurance about copay refund") on FIRST
//     ever open. Subsequent opens skip the seed even if the list is empty —
//     respects the user's intent to clear it.
//   - Sorts: open first (newest top), completed below (newest top).
//   - Toggle done = strikethrough + drop to bottom.
//   - Delete = trash glyph → inline confirm row → yes/cancel.
//
// We don't assert the seed text directly because the cbff_v1_todos_seeded
// flag may already be set from a prior session. Instead we just verify the
// panel renders + supports add/toggle/delete, then clear localStorage so the
// state is reset for the user's real session.
//
// Selectors:
//   #todo-btn / #todo-pop            chip + panel
//   #todo-add-form / #todo-add-input add form
//   #todo-list                       rendered list root
//   .todo-item                       row, has data-id
//   .todo-item.is-done               struck-through state
//   .todo-checkbox                   round checkbox button
//   .todo-item__trash                delete glyph
//   .row-confirm__yes                inline yes button
//   .todo-item__text                 row label

import { test, expect, type Page } from '@playwright/test';
import { authenticatedContext } from './auth-helper';

const TEST_TEXT = '__playwright_test__ todo';

async function openHomeAndTodo(page: Page) {
  await page.goto('/home');
  await expect(page.locator('#grid')).toBeVisible();
  await page.locator('#todo-btn').click();
  await expect(page.locator('#todo-pop')).toHaveClass(/(^|\s)open(\s|$)/);
}

test.describe('to-do panel', () => {
  test('add → toggle done → delete via inline confirm', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    // Wipe any leftover localStorage from a prior run BEFORE the page loads
    // its modules — we visit a tiny page on the right origin first, clear
    // storage, then navigate to /home.
    await page.goto('/home');
    await page.evaluate(() => {
      try {
        // Only clear keys this app owns — leave Sentry / unrelated keys alone.
        const prefix = 'cbff_v1_';
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) keys.push(k);
        }
        for (const k of keys) localStorage.removeItem(k);
      } catch (_) { /* noop */ }
    });
    // Re-navigate so home.js reads the cleared cache on boot.
    await openHomeAndTodo(page);

    // ── 1. Panel renders ──────────────────────────────────
    // After the cache wipe, the seed-once flag is gone — so the example
    // task should be inserted on this open.
    await expect(page.locator('#todo-list')).toBeVisible();
    const seedRow = page
      .locator('#todo-list .todo-item__text:text-matches("call insurance", "i")')
      .first();
    await expect(seedRow).toBeVisible();

    // ── 2. Add a task ─────────────────────────────────────
    await page.fill('#todo-add-input', TEST_TEXT);
    await page.locator('#todo-add-form button[type="submit"]').click();

    // The new task is added at the top (newest open first).
    const newRow = page
      .locator(`#todo-list .todo-item:has(.todo-item__text:text-is("${TEST_TEXT}"))`)
      .first();
    await expect(newRow).toBeVisible();
    await expect(newRow).not.toHaveClass(/is-done/);

    // ── 3. Toggle done ────────────────────────────────────
    await newRow.locator('.todo-checkbox').click();
    await expect(newRow).toHaveClass(/is-done/);
    // The done class drives strikethrough via CSS. Sanity-check the
    // computed `text-decoration-line` includes line-through.
    const decoration = await newRow.locator('.todo-item__text').evaluate(
      (el) => getComputedStyle(el).textDecorationLine,
    );
    expect(decoration).toContain('line-through');

    // After toggle, the item should sort BELOW any non-done items. The
    // seeded example is open, so its row index < our row's index.
    const items = page.locator('#todo-list .todo-item');
    const allTexts = await items.allTextContents();
    const seedIdx = allTexts.findIndex((t) => /call insurance/i.test(t));
    const ourIdx = allTexts.findIndex((t) => t.includes(TEST_TEXT));
    expect(seedIdx).toBeGreaterThan(-1);
    expect(ourIdx).toBeGreaterThan(-1);
    expect(ourIdx, 'completed task should sort below the open seeded task').toBeGreaterThan(seedIdx);

    // ── 4. Delete via trash + inline confirm ──────────────
    await newRow.locator('.todo-item__trash').click({ force: true });
    const yesBtn = newRow.locator('.row-confirm__yes');
    await expect(yesBtn).toBeVisible();
    await yesBtn.click();
    // Row should disappear from the list.
    await expect.poll(
      async () =>
        page
          .locator(`#todo-list .todo-item:has(.todo-item__text:text-is("${TEST_TEXT}"))`)
          .count(),
      { timeout: 5_000 },
    ).toBe(0);

    // ── Cleanup: clear localStorage so the user's real session isn't
    // polluted with this test's seed flag/items.
    await page.evaluate(() => {
      try {
        const prefix = 'cbff_v1_';
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) keys.push(k);
        }
        for (const k of keys) localStorage.removeItem(k);
      } catch (_) { /* noop */ }
    });

    await context.close();
  });
});
