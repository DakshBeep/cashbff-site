// Playwright config for the CashBFF web app E2E suite.
//
// Tests run against PROD (cashbff.com / api.cashbff.com) using a JWT cookie
// minted from JWT_SECRET so we skip the SMS OTP step. See e2e/README.md for
// the full env-var rundown.
//
// Single chromium project — keeps the matrix small while we're still
// stabilising selectors. Add firefox/webkit if/when we need them.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Tests target a live prod backend — keep them serial so two specs don't
  // race on Daksh's account state. CI parallelism would also rate-limit us.
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'https://cashbff.com',
    viewport: { width: 1280, height: 800 },
    // Don't auto-record; screenshots on failure are enough to triage flakes.
    video: 'off',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
