# wa.me prefill registry — surface → first message (attribution)

Every WhatsApp CTA on cashbff.com carries a distinct natural-language prefill so the
agent (and Attio/PostHog) can attribute an inbound texter to the surface that sent them,
with zero UTM plumbing. The prefill IS the tracking token: it reads like a human opener,
and the literal first message tells us the source.

Rules:
- One prefill per surface, never reused. New page = new line here + a unique prefill.
- Keep them lowercase, warm, natural (brand voice; no em dashes, no "~").
- The bare `hey cashbff` is RESERVED for /signup completion (the post-payment handoff),
  so an unadorned opener means "came through the signup funnel".
- Phone: +1 909 655 5215 (`wa.me/19096555215`).

| surface | URL-encoded `?text=` | decoded first message |
|---|---|---|
| `/signup` (done state, existing) | `hey%20cashbff` | hey cashbff |
| `/start` | `hey%20cashbff%2C%20ready%20to%20start` | hey cashbff, ready to start |
| `/money-dysmorphia` | `hey%20cashbff%2C%20checking%20my%20balance%20always%20feels%20like%20bad%20news` | hey cashbff, checking my balance always feels like bad news |
| `/cashbff-vs-rocket-money` | `hey%20cashbff%2C%20came%20from%20the%20rocket%20money%20comparison` | hey cashbff, came from the rocket money comparison |
| `/cashbff-vs-cleo` | `hey%20cashbff%2C%20came%20from%20the%20cleo%20comparison` | hey cashbff, came from the cleo comparison |
| `/cashbff-vs-monarch-money` | `hey%20cashbff%2C%20came%20from%20the%20monarch%20comparison` | hey cashbff, came from the monarch comparison |
| `/cashbff-vs-era` | `hey%20cashbff%2C%20came%20from%20the%20era%20comparison` | hey cashbff, came from the era comparison |

Notes:
- Home (`/`), `/how-it-works`, `/faq`, `/is-cashbff-legit` funnel their primary CTAs to
  `/start` (the single click-to-WhatsApp endpoint), so they inherit the `/start` prefill.
  If any of them ever gets a direct wa.me CTA, mint a new prefill and add it here first.
- The viral motion uses per-person prefills (`hi! <name> sent me`); those are managed in
  Attio, not here. This registry covers site surfaces only.
- Last updated 2026-06-11 (the dysmorphia stance run).
