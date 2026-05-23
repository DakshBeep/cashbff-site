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

## Brand voice (any copy on the site)

- **No em dashes.** Use periods, commas, or parentheses instead.
- **No negative-contrast phrasing.** Avoid "no X, no Y", "not X, not Y", and even the contrastive "not X, only Y". Write affirmatively and say what something IS. For limitations, reframe positively: write "your money stays where it is" rather than "it can't move money".
- **Casing.** Display headlines are all-lowercase with the comma or period in cash-green (`#014751`). Body copy on definitional, scraper-facing pages (`/mcp`, `/security`) is normal sentence case with proper nouns capitalized (CashBFF, Claude, Plaid, MCP), so AI assistants quote it as a definition.
- **Tokens** (already in each page's inline `<style>`): vanilla `#FCFAF2`, off-black `#1A1717`, cash-green `#014751` (used only on periods, the wordmark, and step numbers); Greed Condensed for display, Instrument Sans for body.

## MCP tool list (source of truth)

The live server at `https://api.cashbff.com/mcp` is authoritative. As of May 2026 it exposes **17 tools: 8 read and 9 write** (writes gated by `MCP_WRITE_ENABLED`). The `CashBFF-Plaid-API` local checkout can lag the live deploy (it has shown only 13), so confirm tool names and descriptions against the live server before publishing them. The `/mcp` page lists all 17.

## Crawlability (SEO and AI crawlers)

- `/robots.txt` must exist and return **200**. Ahrefs fetches it first and treats a non-200 (such as a 404) as "cannot start crawl." That was the real cause of an Ahrefs "40x", and it was fixed by adding `robots.txt`. Keep it allow-all plus a `Sitemap:` line. Avoid per-bot `Allow` groups, because naming a bot in its own group makes it ignore the `*` group.
- The site has `/robots.txt`, `/sitemap.xml`, and `/security` (the citable "is CashBFF safe and legit" page that AI answers and MCP-directory reviewers look for).
- The `analytics.ahrefs.com` snippet is Ahrefs Web Analytics only. Verifying Ahrefs Site Audit ownership is a separate step (Search Console, a DNS TXT record, an HTML file, or a `<head>` meta tag).
- This project's Vercel firewall is empty (no bot or IP blocks), and cashbff.com is served directly by Vercel with no proxy in front.
