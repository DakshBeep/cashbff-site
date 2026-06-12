// One-off screenshot runner for the site/v2-A-warm-immersive branch review.
// Not part of the test suite; safe to delete.
import { chromium } from '@playwright/test';

const OUT = '/Users/daksh/Documents/agent/wiki/cashbff/marketing/drafts/site-versions/A-warm-immersive';
const BASE = 'http://localhost:4173';

const pages = [
  { file: 'index.html', name: 'home', chatWait: 7500 },
  { file: 'money-dysmorphia.html', name: 'money-dysmorphia', chatWait: 1200 },
  { file: 'start.html', name: 'start', chatWait: 1200 },
];
const viewports = [
  { label: 'desktop-1280', width: 1280, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
];

const browser = await chromium.launch();
for (const vp of viewports) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  // keep externals from stalling the run; allow google fonts through
  await ctx.route(/sentry|posthog|ahrefs|_vercel|stripe/, (r) => r.abort());
  for (const p of pages) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${p.file}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(p.chatWait); // let the chat type itself out
    // walk the page so every scroll-reveal fires, then settle back at top
    await page.evaluate(async () => {
      const step = window.innerHeight * 0.7;
      for (let y = 0; y <= document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 160));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${p.name}-${vp.label}.png`, fullPage: true });
    await page.close();
    console.log(`shot ${p.name} @ ${vp.label}`);
  }
  await ctx.close();
}
await browser.close();
