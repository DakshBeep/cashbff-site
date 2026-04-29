// Snapshot popup smoke test.
//
// Verifies:
//   1. Clicking #snapshot-btn opens #snapshot-pop (.open class).
//   2. /api/snapshot is fetched and the textarea is filled with the
//      mocked Markdown.
//   3. Clicking #snapshot-copy invokes navigator.clipboard.writeText
//      with the textarea contents (verified by reading from a stub
//      installed via page.evaluate).
//   4. The "ask claude →" link points at https://claude.ai/ and
//      opens in a new tab.
//   5. Pressing Escape closes the popup.
//
// Selectors:
//   #snapshot-btn         chip
//   #snapshot-pop         modal
//   #snapshot-textarea    pre-filled markdown viewer
//   #snapshot-copy        big copy CTA
//   #snapshot-ask-claude  one of the LLM links

import { test, expect, type Page } from '@playwright/test';
import { authenticatedContext } from './auth-helper';

const MOCK_SNAPSHOT_MD = [
  '# my cashbff snapshot',
  '',
  'generated 2026-04-29 · everything below is mine, here\'s the picture',
  '',
  '## balance right now',
  'total cash: $1,700.00 (across 2 accounts)',
  '- bank of america ···1234: $1,200.00',
  '- chase ···5678: $500.00',
  '',
  '## recurring expenses i\'m tracking (next 30 days)',
  '| date | name | amount | frequency |',
  '|------|------|--------|-----------|',
  '| 2026-05-09 | Toyota Ach Lease | $526.01 | monthly |',
  '| 2026-05-10 | Spotify | $11.99 | monthly |',
  '',
  '## what i was thinking about asking',
  '(write your question here, then paste this all into chatgpt or claude)',
  '',
].join('\n');

async function openHome(page: Page) {
  await page.goto('/home');
  await expect(page.locator('#grid')).toBeVisible();
}

test.describe('snapshot popup', () => {
  test('opens, fills textarea, copies via clipboard API, closes on escape', async ({ browser }) => {
    const context = await authenticatedContext(browser);
    const page = await context.newPage();

    let snapshotCalled = 0;
    await page.route('**/api/snapshot', async (route) => {
      snapshotCalled += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          snapshot: MOCK_SNAPSHOT_MD,
          generated_at: '2026-04-29T12:00:00Z',
        }),
      });
    });

    // Stub navigator.clipboard.writeText *before* the page boots so the
    // production wiring picks up our spy. Captures the last-written
    // text on window for the assertion below.
    await page.addInitScript(() => {
      const w = window as unknown as {
        __clipboardWrites?: string[];
        navigator: Navigator;
      };
      w.__clipboardWrites = [];
      // Some Playwright/Chromium combos already expose navigator.clipboard
      // as a read-only object. Wrap-or-replace works in both shapes.
      const existing = w.navigator.clipboard;
      const writeText = (text: string): Promise<void> => {
        (w.__clipboardWrites as string[]).push(text);
        return Promise.resolve();
      };
      try {
        Object.defineProperty(w.navigator, 'clipboard', {
          configurable: true,
          value: { ...(existing || {}), writeText },
        });
      } catch {
        // Fallback for older shapes — patch only the writeText method.
        if (existing && typeof existing === 'object') {
          (existing as { writeText: typeof writeText }).writeText = writeText;
        }
      }
    });

    await openHome(page);

    // 1. Chip click → modal opens.
    await page.locator('#snapshot-btn').click();
    const pop = page.locator('#snapshot-pop');
    await expect(pop).toHaveClass(/(^|\s)open(\s|$)/);

    // 2. Textarea fills with the mocked Markdown.
    const textarea = page.locator('#snapshot-textarea');
    await expect(textarea).toBeVisible();
    await expect.poll(() => snapshotCalled, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => textarea.inputValue(), { timeout: 5_000 })
      .toContain('# my cashbff snapshot');
    await expect(textarea).toHaveValue(/total cash: \$1,700\.00/);

    // 3. Click copy → navigator.clipboard.writeText is called with the
    //    full snapshot text.
    await page.locator('#snapshot-copy').click();
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const w = window as unknown as { __clipboardWrites?: string[] };
        return (w.__clipboardWrites || []).length;
      });
    }, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);

    const writtenText = await page.evaluate(() => {
      const w = window as unknown as { __clipboardWrites?: string[] };
      return (w.__clipboardWrites || [])[0];
    });
    expect(writtenText).toContain('# my cashbff snapshot');
    expect(writtenText).toContain('Toyota Ach Lease');

    // The button flips to a "✓ copied!" success state briefly.
    await expect(page.locator('#snapshot-copy')).toContainText(/copied/i);

    // 4. "ask claude →" link points at claude.ai, opens in a new tab.
    const claudeLink = page.locator('#snapshot-ask-claude');
    await expect(claudeLink).toHaveAttribute('href', /^https:\/\/claude\.ai\/?$/);
    await expect(claudeLink).toHaveAttribute('target', '_blank');
    // rel="noopener" prevents tab-jacking via window.opener.
    await expect(claudeLink).toHaveAttribute('rel', /noopener/);

    // 5. Escape closes the popup.
    await page.keyboard.press('Escape');
    await expect(pop).not.toHaveClass(/(^|\s)open(\s|$)/);

    await context.close();
  });
});
