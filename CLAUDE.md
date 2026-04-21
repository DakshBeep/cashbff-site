# CashBFF web — rules for contributors (human + AI)

## CSP and inline code — never remove 'unsafe-inline' blindly

The CSP in `vercel.json` controls which scripts and styles Chrome allows on `cashbff.com`. **Removing `'unsafe-inline'` from `script-src` or `style-src` silently breaks every page that uses inline `<script>` or `<style>`.**

- Before tightening CSP: `grep -l "<script>" *.html` and `grep -l "<style>" *.html`. If anything is inline, either keep `'unsafe-inline'` or extract it first.
- Validating a CSP change requires a **real browser** — `curl` can't see the block, `jsdom` ignores CSP, our subagents running headless often miss it.
- Symptom of a CSP block: pages load visually but all JS is dead (buttons don't respond, forms don't submit, `fetch()` calls never fire). DevTools Console shows `Executing inline script violates... The action has been blocked`.
- When adding a new external script source (e.g. an analytics CDN), add its origin to the right directive: scripts → `script-src`, fonts → `font-src`, XHR/fetch → `connect-src`, iframes → `frame-src`.

## Deploy model

- The repo is `DakshBeep/cashbff-site`. Prod is `cashbff.com` on Vercel (project `cash-bff/cashbff-site`).
- **Git is not connected to Vercel.** `git push` does NOT auto-deploy. After committing, run `vercel deploy --prod --yes` from this directory to ship.
- Verify a deploy is live with `curl -s https://cashbff.com/<path> | md5` and compare to `md5 -q <local-file>`. Matching md5 = shipped. Not matching = deploy didn't go through.

## Repo layout

The git repo root is `/Users/daksh/Documents/CashBFF SITE/V4-proto/` itself, not the parent `CashBFF SITE/` folder. Old prototypes (`V2/`, `V3/`, `Live/`) live outside the repo and are not deployed.

## Backend boundary

Frontend talks to `https://api.cashbff.com` (the `CashBFF-Plaid-API` repo, hosted on Render). Auth is a cookie named `cbff_session` on `Domain=.cashbff.com`. All authenticated fetches need `credentials: 'include'`. No Bearer tokens, no localStorage — those were ripped out.
