# cash bff — site

The marketing site and auth'd web app at [cashbff.com](https://cashbff.com).

## Pages

- `index.html` — landing (fading credit card hero)
- `verify.html` — phone + OTP
- `plan.html` — add cards + see debt-free date (calendar reveal)
- `paywall.html` — start 7-day free trial
- `connect.html` — Plaid Link (currently mocked)
- `home.html` — post-auth Sunday Receipt dashboard
- `privacy.html` — privacy policy

## Stack

Pure static HTML + CSS + JS. No framework. Fonts (Greed Condensed) and palette per the brand style guide.

## Deploy

Auto-deploys to Vercel on push to `main`. Domain: cashbff.com.

## Backend

Express API lives in a separate repo and is deployed to Render. The frontend talks to it at `api.cashbff.com` (or the Render URL) — see the `fetch(...)` calls in the verify/connect/home pages.
