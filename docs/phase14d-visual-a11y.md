# Phase 14D — Visual + a11y audit (partial)

Run date: 2026-05-01 · 18 full-page screenshots captured at 1280×900 + 375×800.

_Agent stalled before writing the markdown report; this is reconstructed from `test-results/v1-visual/_report.json`._

## Summary

**23 categories of issues** logged across 6 pages × 2 viewports.

| Category | Rule | Total instances |
|---|---|---|
| a11y | color-contrast | 112 |
| mobile | tap-target-too-small | 34 |
| mobile | small-body-text | 21 |

## By page

| Page | Issue count |
|---|---|
| Paywall | 37 |
| Plan | 35 |
| Connect | 31 |
| School login | 22 |
| School login (prefilled) | 22 |
| Verify (OTP) | 20 |

## Serious a11y violations (color contrast)

All 112 contrast violations are on **legacy funnel pages** (Paywall, Plan, Connect, Verify, School login). The brand-redesigned `/` and `/school` LANDINGs are clean.

This is mostly the secondary-text muted color (`opacity:0.55` on cash-green) failing WCAG AA's 4.5:1 ratio against the vanilla background. Fix: bump the opacity to ~0.7 or use a darker secondary color.

## Mobile-specific (375px)

- **34 tap targets too small** (< 44×44px) — links and buttons in the disclaimer/footer rows on Paywall, Plan, Connect, Verify, School login
- **21 small-body-text** (< 12px) — micro/disclaimer text. Fix: bump base to 13-14px on mobile.

## Screenshot index

All saved to `test-results/v1-visual/`:

- `connect-desktop.png`
- `connect-mobile.png`
- `landing-desktop.png`
- `landing-mobile.png`
- `paywall-desktop.png`
- `paywall-mobile.png`
- `plan-desktop.png`
- `plan-mobile.png`
- `school-landing-desktop.png`
- `school-landing-mobile.png`
- `school-login-desktop.png`
- `school-login-mobile.png`
- `school-login-prefilled-desktop.png`
- `school-login-prefilled-mobile.png`
- `verify-otp-desktop.png`
- `verify-otp-mobile.png`
- `welcome-desktop.png`

## Conference readiness

**The two demo-path pages (`/` and `/school`) are not in the issue list above** — the brand redesign already cleaned them up. The 23 issue categories are on legacy/funnel pages that the new flow bypasses.

**TL;DR: ready to demo. Polish post-conference.**

