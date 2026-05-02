# CashBFF — full tech stack & how it works

_Last updated: May 2026. Living document — update when architecture shifts._

---

## TL;DR

CashBFF is a **money-on-a-calendar** product for credit-card-carrying adults plus a free under-18 (school) variant. It's three repos talking to one shared Supabase database, with five external integrations (Plaid, Stripe, Twilio, Anthropic, Sentry).

```
cashbff.com (Vercel)     ← static HTML/JS, no state, no DB access
       ↓
api.cashbff.com (Render) ← Express + TypeScript, all business logic
       ↓
Supabase (Postgres)      ← every authoritative row
```

External: Plaid (bank connections), Stripe (parent-age + future paywall), Twilio (SMS OTP + bot), Anthropic Claude (recurring detection LLM brain + SMS bot replies), Sentry (error tracking).

---

## 1. Three repos

| Repo | Code | Hosts | Domain |
|---|---|---|---|
| **CashBFF-Plaid-API** | `~/Documents/CashBFF Plaid API` | Render web service `srv-d3slhc9r0fns738ja6qg` | `api.cashbff.com` |
| **cashbff-site** | `~/Documents/CashBFF SITE/V4-proto` | Vercel project `prj_ojsn0sB6mrG6gkhCZy7sxmfEndi1` | `cashbff.com` |
| **(Supabase project)** | dashboard.supabase.com/project/gfpdubnhpdoalhyrvnmd | (managed) | `db.gfpdubnhpdoalhyrvnmd.supabase.co` |

Backend pushes auto-deploy via Render's GitHub integration. Frontend pushes auto-deploy via Vercel's GitHub integration; you can also force a deploy with `vercel --prod`.

---

## 2. Frontend pages (cashbff.com)

### Public / pre-auth

| Path | File | What it does |
|---|---|---|
| `/` | `index.html` + `assets/js/index.js` | Plaid-first onboarding funnel for ADULTS. Tilted credit-card hero with `redact`/`sweep`/`float` animations. State machine: `STATE_CONNECT` → `STATE_PLAID` → `STATE_PHONE` → `STATE_OTP` → `/home.html`. Returning-user shortcut goes phone → OTP without Plaid. Has a small `under 18? sign in here →` link to `/school/login`. Headline: `see what's coming. before it hits.` |
| `/school` | `school.html` + `assets/js/school.js` | School signup landing for UNDER-18s. Same tilted-card hero with `free 'til 18` pill. Form: parent + student first names + emails + DOB + consent. State machine: form → verifying → stripe-card → finalizing → success. Headline: `free 'til 18. then a year more.` Sub: `no bank needed. just the calendar.` |
| `/school/login` | `school-login.html` + `assets/js/school-login.js` | Kid login. URL accepts `?email=…&code=…` to prefill. Form posts to `/api/school/login`. |
| `/verify` | `verify.html` + `assets/js/verify.js` | Standalone OTP entry — preserved for direct visits. Hardened: button stays disabled until `/api/me` resolves so logged-in users can't accidentally re-OTP. `pageshow` listener re-runs the gate on bfcache restores. |
| `/connect` | `connect.html` + `assets/js/connect.js` | Real Plaid Link integration (Phase 6C). Pulls a link token, opens Stripe SDK, exchanges public token. Used by some legacy paths. |
| `/plan` | `plan.html` | Pre-bank-connect calculator. Mostly bypassed by the new index funnel. |
| `/paywall` | `paywall.html` | "your 7 days start now" trial gate. Currently an interstitial; Stripe billing is wired but not activated. |
| `/welcome` | `welcome.html` | Post-OTP profile completion for users without an email. |
| `/privacy` | `privacy.html` | 719-word privacy policy, brand voice, footer-linked from every page. |
| `/terms` | `terms.html` | 635-word terms of service. Includes "we may use anonymized data for research, never sell or share." |

### Post-auth

| Path | File | What it does |
|---|---|---|
| `/home.html` | `home.html` + `assets/js/home.js` (~5000 lines) | The dashboard. Calendar, scheduled txns, recurring streams, to-do, reimbursements, wallet (manual cards), 📋 snapshot for AI. School users get the same page but with Plaid-related chips hidden via `window.__isSchoolAccount`. |
| `/metrics` | `metrics.html` + `assets/js/metrics.js` | Admin-only dashboard. Five sections: overview, SMS, signup funnel, recurring streams, recent signups. Gated server-side to your `DAKSH_PHONE`-derived user_id. |

### Shared frontend infra

- **`assets/js/auth-banner.js`** — injects the "my home →" floating pill on marketing/funnel pages when the user is authed. Reads `window.__authedUser` (set by each page's gate). Click navigates to `/home.html`.
- **`assets/js/sentry-init.js`** — Sentry browser SDK init. Forwards JS errors to Sentry from every page via the `<script src="https://js.sentry-cdn.com/...">` CDN tag.
- **Brand vocabulary**:
  - Display font: **Greed Condensed** (Bold + Medium woff2 self-hosted)
  - Body font: **Instrument Sans** (Google Fonts)
  - Colors: `--cash-green: #014751`, `--electric-green: #D3FFB4`, `--periwinkle: #C5B6F1`, `--off-black: #1A1717`, `--vanilla: #FCFAF2`
  - Voice: lowercase, conversational, period-cadence headlines (`close your eyes. we'll pay it down.` style)
- **No inline scripts anywhere** (CSP enforced via `vercel.json`).
- **`vercel.json`** has `cleanUrls: true` so `/school` serves `school.html`.

---

## 3. Backend endpoints (api.cashbff.com)

All in **`src/server.ts`** (~5200 lines). The server is one Express app with helmet + cors + cookie-parser + a Sentry layer wrapping every handler.

### Auth & sessions

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/me` | session cookie | Returns `{user_id, phone}` or 401. Recognizes both phone (`user_<digits>`) and school (`school_<uuid>`) IDs. |
| `POST /api/logout` | session cookie | Clears `cbff_session`. |

### Phone signup flow (Plaid-first web onboarding, Phase 7)

The user connects Plaid BEFORE we know their phone. Anonymous state lives in `pending_signups` (UUID-keyed), tracked by an HttpOnly `cbff_signup` cookie:

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/signup/start` | none (anon) | Inserts `pending_signups`, creates Plaid link token, sets `cbff_signup` cookie. |
| `POST /api/signup/exchange` | `cbff_signup` | Exchanges Plaid public_token, encrypts + stores access_token under signup_id. |
| `POST /api/signup/send-otp` | `cbff_signup` | Stores phone + bcrypt-hashed OTP, sends Twilio SMS. Rate-limit: 3/10min/signup_id, 10/24h/phone. |
| `POST /api/signup/verify-otp` | `cbff_signup` | Verifies code, derives `user_id = "user_" + phoneDigits`, **MERGES** pending_signups → `connected_accounts` under real user_id, sets `cbff_session` JWT. |

Returning-user shortcut on `/`: phone → OTP using the legacy `/api/otp/{send,verify}` (no Plaid step, since they're already connected).

### Legacy / SMS-driven endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/create-link-token` | link_token UUID (from SMS magic link) | The original SMS-flow Plaid link-token creator. |
| `POST /api/exchange-token` | link_token UUID | Original SMS-flow exchange. Both blocked for `school_` user IDs. |
| `POST /api/otp/send` | none | Used by `/verify` page for returning users. |
| `POST /api/otp/verify` | none | Sets `cbff_session`. |
| `POST /webhook/sms` | Twilio HMAC | Inbound SMS from Twilio. Whitelist-gated (only Maram + a few testers can chat with the bot). Non-whitelisted senders get an empty TwiML response. |
| `POST /plaid/webhook` | (no signature verification yet — TODO) | Inbound Plaid webhook for transaction updates. Triggers a sync cycle. |

### School (under-18) flow

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/school/start` | none | Validates form (DOB < 18). Creates Stripe Customer + SetupIntent. Stores in `pending_school_signups`. Returns `client_secret` + sets `cbff_school` cookie. |
| `POST /api/school/finalize` | `cbff_school` | Confirms SetupIntent succeeded with Stripe. Generates `school_<uuid>` user_id + bcrypt-hashed kid login code. Creates `school_users` row. Returns kid login URL components. |
| `POST /api/school/login` | none | Body: `{email, code}`. bcrypt.compare against the stored hash. Sets `cbff_session` JWT. Marks the code as used (one-time use). |

### Calendar & scheduled transactions

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/calendar?from=…&to=…` | session | Returns Plaid raw rows + scheduled rows merged for the date range. Skips stream-projected rows that have an `acknowledged_at` (those are "already paid early"). |
| `GET /api/scheduled-transactions` | session | All user's scheduled rows. |
| `POST /api/transactions/schedule` | session | Add a one-off scheduled txn. |
| `PATCH /api/transactions/schedule/:id` | session | Edit. |
| `DELETE /api/transactions/schedule/:id` | session | Delete. **409 STREAM_LINKED** if the row is part of a recurring stream — frontend offers `acknowledge` (mark paid early) or `stop_stream` (open recurring tab). |
| `POST /api/transactions/schedule/:id/acknowledge` | session | Soft-delete. Marks `acknowledged_at = NOW()`. The row stays visible (greyed out, line-through, "✓ paid" badge) but doesn't contribute to projected running balance. |

### Recurring streams (the forecaster)

The product's hero feature. See section 8 below for how it flows.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/recurring/suggestions` | session | Detected merchants the user hasn't confirmed yet (from the trait-bridge populator). |
| `POST /api/recurring/suggestions/:merchant/confirm` | session | Body: `{display_name?, next_due_date?, amount?}`. Materializes the stream as scheduled_transactions rows for the next 3 months. |
| `POST /api/recurring/suggestions/:merchant/dismiss` | session | Don't show again. |
| `GET /api/recurring/streams` | session | All confirmed streams. |
| `POST /api/recurring/streams` | session | Manual add: `{display_name, next_due_date, amount, frequency, end_date?}`. |
| `PATCH /api/recurring/streams/:merchant` | session | Rename/reschedule/end-date. Mirrors changes to all linked scheduled_transactions rows. |
| `DELETE /api/recurring/streams/:merchant` | session | Stop tracking. Deletes all future projection rows. |
| `GET /api/recurring/rollover-prompts` | session | **Now neutered** — always returns `{items:[]}`. The "did this charge?" modal was killed in Phase 8.5A. Instead: `autoAdvanceConfirmedStreams` runs silently after every sync. |

### Wallet & balances

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/wallet` | session | Aggregated view: total cash, total owed, net running balance, plus tracked-cards list. |
| `GET /api/cards` | session | All `account_balances` rows for the user (used by the schedule-form card selector). |
| `GET /api/balances` | session | Raw balances from Plaid. |
| `POST /api/tracked-accounts` | session | Manual card entry (for users who can't or won't connect Plaid). Auto-creates a reminder scheduled_txn if a due date is provided. |
| `GET/PATCH/DELETE /api/tracked-accounts/:id` | session | CRUD. |

### Reimbursements panel

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET/POST/PATCH/DELETE /api/reimbursements` | session | The "I paid for X, someone owes me back" tracker. Auto-linked when a `reimburse`-type scheduled_txn is created. |

### Snapshot for AI (Phase 10A)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/snapshot` | session | Returns Markdown formatted user data — running balance, recurring next 30d, scheduled next 90d, last 30d transactions. Capped at 6000 chars (LLM context). For school users, balances section gracefully says "no linked accounts yet" since they have no Plaid. |

### Metrics (admin-only)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/metrics/overview` | admin (Daksh's user_id) | Counts of users, school signups, scheduled txns, recurring streams. |
| `GET /api/metrics/sms` | admin | Inbound 24h/7d, outbound 24h, last 50 messages preview. |
| `GET /api/metrics/signup-funnel` | admin | Web + school start vs complete counts. |
| `GET /api/metrics/recurring` | admin | Confirmed/dismissed/suggested counts + top 10 merchants. |
| `GET /api/metrics/recent-signups` | admin | Last 20 user_onboarding + school_users rows. PII-safe — user_ids only. |

### Plaid integration endpoints (defensive)

The two main Plaid web-flow endpoints (Phase 6C):

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/plaid/link-token` | session | **403 SCHOOL_NO_PLAID** if user_id starts with `school_`. |
| `POST /api/plaid/exchange` | session | Same school guard. Encrypts access_token, persists to `connected_accounts`, kicks `/api/sync`. |

### Sync & cron

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/sync` | API_SECRET_KEY (internal) | Plaid `transactionsSync` + `accountsBalanceGet` + recurring bridge + `autoAdvanceConfirmedStreams`. Triggered hourly via in-process `setInterval` cron. |
| (cron) `runDataIntegrityCheck` | (in-process) | Runs daily. Sweeps stale `pending_signups` and `pending_school_signups` (24h+). Sentry-alerts on user_id ↔ item_id orphans (the data leak we fixed). |

---

## 4. Database (Supabase Postgres)

Project ID: `gfpdubnhpdoalhyrvnmd`. Connection via `src/db/supabase.ts` using the `postgres` npm package (NOT pg) over the IPv4 pooler URL.

### Auth & user identity

- **`user_onboarding`** — phone users. Columns: `user_id` (PK, format `user_<digits>`), `phone`, `first_name`, `onboarding_step` ('new' | 'awaiting_name' | 'awaiting_bank' | 'complete'), `link_token` (the SMS magic-link UUID), `email`, `session_version` (incremented to revoke all that user's JWTs), timestamps.
- **`school_users`** — under-18 accounts. Columns: `user_id` (PK, format `school_<uuid>`), `parent_email`, `parent_first_name`, `parent_stripe_customer_id`, `student_email`, `student_first_name`, `student_dob`, `kid_login_code_hash` (bcrypt), `kid_login_code_expires_at`, `kid_login_code_used_at`, `parent_age_verified_at`, `status` ('active'|'suspended').
- **`pending_signups`** (Phase 7) — anonymous in-flight web signups. UUID-keyed. Holds `access_token_encrypted`, `phone`, `otp_code_hash`, `otp_expires_at`, `status` ('started'|'connected'|'phone_entered'|'verified'|'merged'). Daily cleanup of >24h rows.
- **`pending_school_signups`** (Phase 8A) — same pattern for school. Holds `stripe_customer_id`, `stripe_setup_intent_id`, `parent_age_verified_at`, `status`.
- **`otp_codes`** — legacy SMS-flow OTP store (used by `/api/otp/*`). bcrypt-hashed codes, max 5 attempts.
- **`whitelisted_numbers`** — phone numbers allowed to chat with the SMS bot. Currently 8 entries (Daksh, Maram, Nico, Idil, Chouly, +3 testers). Non-whitelisted inbound SMS is silently dropped.

### Bank-connection data

- **`connected_accounts`** — one row per Plaid Item. Columns: `item_id` (PK), `user_id`, `access_token` (encrypted via AES in `src/crypto.ts`), `institution`, `connected_at`, `sync_cursor` (for `transactionsSync`).
- **`raw_transactions`** — every Plaid transaction, ever. Columns include `id`, `user_id`, `account_id`, `institution`, `mask`, `date`, `amount` (Plaid convention: positive = outflow), `merchant_name`, `normalized_merchant`, `category`, `corrected_category`, `pending`, `is_refund`, `payment_channel`, `synced_at`, plus user-correction fields (`user_corrected`, `user_note`, `user_tag`).
- **`account_balances`** — current balances per account. Columns: `account_id`, `user_id`, `institution`, `mask`, `account_name`, `account_type` (`depository`|`credit`|`loan`|`investment`), `account_subtype` (`checking`|`savings`|`credit card`|...), `balance_available`, `balance_current`, `balance_limit`, `updated_at`.

### Calendar & scheduling

- **`scheduled_transactions`** — user-added or stream-projected upcoming items. Columns: `id`, `user_id`, `date`, `name`, `amount`, `type` (`bill`|`sub`|`spent`|`reimburse`|`income`|`planned`), `note`, `card_account_id`, `acknowledged_at` (Phase 10B — soft-delete signal), `created_at`. Stream-projected rows have `note='recurring-projection:<merchant>'` so the DELETE handler can refuse and offer the friendly redirect.

### Recurring forecaster

- **`subscription_status`** — the "stream" entity. PK is `(user_id, normalized_merchant)`. Columns: `display_name` (user-renamed), `status` ('active'|'cancelled'), `last_charge_date`, `avg_monthly_amount`, `next_due_date`, `cadence_days`, `frequency` ('weekly'|'biweekly'|'monthly'|'quarterly'|'yearly'), `end_date` (optional, for finite plans like Affirm BNPL), `confirmed_at`, `dismissed_at`, `suggested_at`, `linked_scheduled_txn_id`, `last_account_id` (joined with account_balances for the "from <bank> ···<mask>" line in the recurring tab).

### Profile & traits (legacy LLM-context system)

- **`user_profiles`** — JSONB blob with derived traits. Fields: `traits` (e.g. `has_recurring_subscriptions`, `apple_ecosystem`, `coffee_habit` with `confidence` + `evidence` arrays), `silent_traits`. Rebuilt hourly by `profileStore.rebuildFromTransactions()` from raw_transactions + the merchant-overrides whitelist. The recurring-bridge reads this to seed candidate detection.
- **`merchant_overrides`** — pattern → category/lifestyle-flag mapping. Hand-curated whitelist of ~22 known subscription merchants (Toyota, Spotify, Apple, etc.) plus category corrections for Plaid mistakes.
- **`inferences`** — older pre-LLM monthly summaries.

### Communications & operations

- **`sms_messages`** — every inbound + outbound SMS. Columns: `user_id`, `direction` ('inbound'|'outbound'), `body`, `phone`, `tool_calls` (JSONB, for Claude tool-use), `created_at`. Indexed by `(user_id, created_at)`.
- **`user_corrections`** — when the user corrects a category or marks a sub as cancelled, log it here.

---

## 5. External integrations

### Plaid (production mode)

- Env: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=production`.
- SDK: `plaid` npm package, init in `src/plaid-client.ts`.
- Products used: `transactions` (the only one we need today).
- 9944 institutions in catalog (per audit).
- 10 active items connected across 5 users.
- Webhook URL: every `linkTokenCreate` call now hardcodes `webhook: "https://api.cashbff.com/plaid/webhook"`. All 10 existing items also updated via `itemWebhookUpdate` (Phase 13B-ish).
- Sync model: `transactionsSync` with cursor stored on `connected_accounts.sync_cursor`. Idempotent across calls.

### Stripe (test mode)

- Env: `STRIPE_SECRET_KEY=rk_test_...` (restricted key, scoped to customers + setup_intents + payment_methods + prices/products).
- Frontend publishable key hardcoded in `assets/js/school.js` as `pk_test_…`. Live keys saved but not deployed yet.
- SDK: `stripe` npm, init via `src/stripe-client.ts` lazy singleton.
- Used today: SetupIntents for parent age verification on /school. No subscriptions yet (paywall not activated).
- No webhook receiver yet.

### Twilio

- Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (= `+1 877 812 6360`).
- Used for: outbound SMS (OTP codes, bot replies) + inbound webhook handler.
- Inbound webhook URL: `https://api.cashbff.com/webhook/sms` (just rewired on the Twilio side).
- HMAC signature verification on every inbound — required by `validateTwilioRequest` middleware.
- TCPA compliance: STOP/START/HELP keyword handling in `src/tcpa.ts`.

### Anthropic (Claude)

- Env: `ANTHROPIC_API_KEY`.
- SDK: `@anthropic-ai/sdk` npm.
- Models in use:
  - `claude-haiku-4-5-20251001` for cheap probe / health checks
  - `claude-sonnet-4-6` for the SMS bot reply pipeline (`src/llm/chat.ts`)
- LLM brain prototype (`scripts/recurring-llm-brain.ts`) — one-off classifier for recurring detection. Not in the live request path; trait pipeline + whitelist do the work in production.

### Sentry

- Env: `SENTRY_DSN`.
- SDK: `@sentry/node` (backend) + browser CDN (frontend).
- Breadcrumbs added on every `raw_transactions` INSERT (Phase 6 data-leak prevention).
- `captureException` on integrity-check violations and Stripe / Plaid call failures.

---

## 6. Auth model

### JWT cookies — single source of truth

- Cookie name: **`cbff_session`**, set HttpOnly + Secure + SameSite=Lax + Domain=`.cashbff.com` + Max-Age=30d.
- Algorithm: HS256 with `JWT_SECRET` env (≥32 chars).
- Payload: `{uid: string, phone: string, sv: number, iat, exp}`.
- Signed by **`signSession(uid, phone, sessionVersion = 1)`** in `src/web-auth.ts`.
- Verified by **`verifySession(token)`** — returns the payload or null on any failure.

### Two user types, one auth function

`getAuthedUser(req)` reads the cookie, calls `verifySession`, then **branches on `payload.uid.startsWith("school_")`**:

```
if school_*: SELECT user_id FROM school_users WHERE user_id = ? AND status = 'active'
else:        SELECT session_version FROM user_onboarding WHERE user_id = ?
             AND session_version === payload.sv
```

This is the fix from commit `04f5b1e`. Before that, school users could authenticate but every endpoint rejected them because `getAuthedUser` only checked `user_onboarding`.

### Session revocation

For phone users only (school_users has no `session_version` yet): bump `user_onboarding.session_version` and every existing JWT is invalidated next request.

### Other cookies

- **`cbff_signup`** — anonymous in-flight web signup state, HttpOnly, no expiry (session cookie).
- **`cbff_school`** — anonymous in-flight school signup state, same shape.
- Both cleared at the moment of merge (when the user_id is established).

---

## 7. Data sync loop (the heartbeat)

Runs every hour via in-process `setInterval` in `src/server.ts`'s `syncAllUsers()`. For each user with at least one `connected_accounts` row:

1. **`syncUser`** in `src/sync.ts`:
   - For each Plaid item, call `transactionsSync` with the stored cursor.
   - INSERT new + DELETE removed transactions to `raw_transactions`. Defensive guard: never insert under a different `user_id` than the item's owner.
   - Sentry breadcrumb on every INSERT (so we can trace if cross-user contamination ever recurs).
2. **`profileStore.rebuildFromTransactions`** — re-derives `user_profiles.traits` from raw_transactions + the merchant-overrides whitelist.
3. **`populateRecurringFromTraits`** — the bridge. Reads `traits.has_recurring_subscriptions.evidence[]`. For each merchant: if it's in the SUBSCRIPTION_MERCHANTS whitelist OR has ≥2 charges in the last 60 days, upsert into `subscription_status` with computed `next_due_date` (last_charge_date + cadence). The `ON CONFLICT` clause preserves user-confirmed/dismissed dates.
4. **`autoAdvanceConfirmedStreams`** — silent rollover. For each confirmed stream where `next_due_date <= today + 5d`, if a real Plaid charge appeared in the [-3d, +5d] window: bump `next_due_date += cadence_days`, regenerate projection rows. No user prompt — we just keep the calendar honest.

A **daily** integrity check (also in-process):
- Detects orphaned `pending_signups` and `pending_school_signups` (>24h, not merged) and DELETEs them.
- Cross-references `(user_id, item_id)` pairs in raw_transactions vs connected_accounts. Sentry-alerts on mismatch.

---

## 8. The recurring forecaster (your hero feature)

End-to-end flow:

```
raw_transactions ─┐
                  ├─→ profileStore.rebuildFromTransactions ─→ user_profiles.traits
merchant_overrides┘                                                  │
                                                                     ▼
SUBSCRIPTION_MERCHANTS whitelist ─→ populateRecurringFromTraits ─→ subscription_status (suggested)
                                                                     │
                                          user clicks "✓ confirm"    │
                                                                     ▼
                                    materialize 3 months of projection rows ─→ scheduled_transactions
                                                  (note='recurring-projection:<merchant>')
                                                                     │
                                                                     ▼
                                       calendar reads scheduled_transactions ─→ pills
                                                                     │
                                          real charge lands in window│
                                                                     ▼
                                       autoAdvanceConfirmedStreams shifts next_due
                                       and replaces the projection rows silently
```

**End-of-life handling** — if `subscription_status.end_date` is set (e.g. "Affirm 12-payment plan ends Aug 1"), the bridge stops generating projections beyond it. So Affirm streams self-terminate.

**Soft-delete (Phase 10B)** — if a real charge lands EARLIER than expected and the user clicks the calendar trash on the future row, the row gets `acknowledged_at = NOW()` instead of being deleted. It stays visible (greyed, line-through, "✓ paid" badge) but doesn't contribute to projected running balance.

---

## 9. The snapshot for AI (Phase 10A)

`GET /api/snapshot` returns one big Markdown string (≤6000 chars). Sections:

1. `## balance right now` — running balance leading, then cash-on-hand breakdown by account, then credit-card debt breakdown.
2. `## recurring expenses i'm tracking (next 30 days)` — Markdown table from confirmed `subscription_status` rows.
3. `## scheduled (one-off)` — Markdown table from non-stream-projected `scheduled_transactions` (today→90d).
4. `## last 30 days of transactions` — Markdown table from raw_transactions, sorted desc, capped 100 rows. Outflows rendered negative ("-$42.18") to read like a bank statement.
5. `## what i was thinking about asking` — empty placeholder for the user to type their question.

Frontend: 📋 chip on home → modal with copyable textarea + "ask chatgpt / claude / gemini" deep-link buttons. Works for school users too (they have no Plaid data, so balances + transactions sections render as gracefully empty; their snapshot is mostly their manual scheduled txns).

---

## 10. Branding & copy guardrails

- **No em-dashes anywhere on the site** (Phase 12B swept 401 across 35 files). Brand voice prefers two short sentences ending in periods over a single em-dash-spliced sentence.
- **Lowercase everywhere** except the wordmark (Greed Condensed `cash bff`).
- **Cash-green periods on display headlines**. The `.period` span at the end of `close your eyes.` etc.
- **No exclamation marks** in body copy.
- **Email**: `daksh@cashbff.com` (renamed from `hi@cashbff.com` in commit 537388d).
- **Two-line headline cadence**: each line 3-5 words, hard stress at the end. Examples: `see what's coming. before it hits.` (`/`), `free 'til 18. then a year more.` (`/school`).

---

## 11. Testing surface

### Backend (vitest)
- 1502 total tests, 1489 passing, 13 stale (10 supabase-integrity drift + 3 already fixed in commit `119c240`).
- Files include: `recurring-bridge.test.ts`, `recurring-api.test.ts`, `school.test.ts`, `signup.test.ts`, `metrics.test.ts`, `snapshot.test.ts`, `scheduled-transactions.test.ts`, `calendar.test.ts`, `balances.test.ts`, plus more.

### Frontend (vitest + Playwright)
- 51 vitest unit tests (home day-projection math, metrics renderers).
- ~32 Playwright specs covering signup, school, recurring, snapshot, acknowledge, legal pages, metrics, no-rollover, v1-comprehensive, v1-visual-a11y, conference sweep.

### Full-suite live integration probes
- Phase 14A re-confirmed all 6 integrations live with read-only API calls.

---

## 12. Deployment

### Backend (Render)
- Auto-deploys on push to `main` of `CashBFF-Plaid-API`.
- Build: `npm ci && npm run build` (= `tsc`).
- Start: `node dist/server.js`.
- Cold-start ~30s. Hot-restart ~5s.
- Latest commit at this writing: `119c240`.

### Frontend (Vercel)
- Auto-deploys on push to `main` of `cashbff-site`.
- Static-only, no build step required.
- Force-deploy from CLI: `cd V4-proto && vercel --prod`.
- Latest commit at this writing: `df0803e`.

---

## 13. Kill-switches & defensive guards

- **School-user Plaid block**: `if (user.uid.startsWith("school_")) return res.status(403).json({code: "SCHOOL_NO_PLAID"})` on every Plaid endpoint.
- **SMS whitelist**: non-whitelisted inbound numbers get an empty `<Response></Response>` — no LLM cost, no engagement.
- **Daily cap on bot messages**: `userMessageDailyCap` per phone, prevents runaway Anthropic costs.
- **OTP rate limits**: 3/10min per signup_id, 10/24h per phone. Per phone for legacy `/api/otp/send`.
- **Verify-while-authed protection**: verify.html gate awaits `/api/me`, button stays disabled if user is authed. `pageshow` re-runs gate on bfcache restore. So a logged-in user clicking back in the browser can't accidentally re-OTP.
- **Calendar trash on stream rows**: returns 409 with `code: STREAM_LINKED` instead of deleting. Frontend offers two clear options.
- **Plaid webhook**: signature verification is a TODO at `src/server.ts:5025` — currently rate-limited 5/hr/item but anyone with an item_id can trigger a sync. Pre-launch hardening.

---

## 14. Known caveats / next-session items

- **Maram → web migration** — she still uses SMS exclusively. Migrate her to a phone-derived web account (`user_19092732437` already has the data) so she gets the calendar UX.
- **Stripe live mode** — `pk_live_…` saved but not deployed; needs paired `rk_live_…` / `sk_live_…` on Render before flipping.
- **Plaid webhook signature verification** — pre-public-launch.
- **Color contrast fixes on legacy funnel pages** (Paywall, Plan, Connect, Verify) — per Phase 14D audit. Demo path is clean; legacy pages need the muted-text opacity bumped from 0.55 → 0.7.
- **Mobile tap targets** on those same legacy pages — bump to ≥44px.

---

## 15. The repo map (where to find things)

```
~/Documents/CashBFF Plaid API/        ─ Render backend
├── src/
│   ├── server.ts                     ─ ~5200 lines, all Express handlers
│   ├── web-auth.ts                   ─ JWT sign/verify + getAuthedUser
│   ├── sync.ts                       ─ Plaid transactionsSync orchestrator
│   ├── plaid-client.ts               ─ Plaid SDK init
│   ├── stripe-client.ts              ─ Stripe SDK lazy singleton
│   ├── recurring.ts                  ─ Pure validators + mappers
│   ├── recurring-bridge.ts           ─ trait → subscription_status bridge + autoAdvance
│   ├── scheduled-transactions.ts     ─ Pure helpers + mappers
│   ├── school.ts                     ─ Pure validators + cookie helpers
│   ├── signup.ts                     ─ Pure validators + cookie helpers
│   ├── snapshot.ts                   ─ Pure Markdown builders for the AI snapshot
│   ├── metrics.ts                    ─ Pure SQL helpers for /api/metrics/*
│   ├── balances.ts                   ─ summarizeBalances + running-balance math
│   ├── calendar.ts                   ─ /api/calendar mapper + DATE helpers
│   ├── reimbursements.ts             ─ Pure helpers
│   ├── tracked-accounts.ts           ─ Manual-card validators + reminder helpers
│   ├── currency.ts                   ─ Frankfurter FX + 1h cache
│   ├── data-integrity.ts             ─ Daily orphan sweep
│   ├── normalize-merchant.ts         ─ Plaid name cleanup
│   ├── merchant-overrides.ts         ─ Hand-curated whitelist + category fixes
│   ├── crypto.ts                     ─ AES encrypt/decrypt for access_tokens
│   ├── tcpa.ts                       ─ STOP/HELP keyword handling
│   ├── validation.ts                 ─ phone + input validation
│   ├── onboarding.ts                 ─ SMS state machine
│   ├── llm/                          ─ Claude chat pipeline (system-prompt, tools, load-context)
│   ├── inferences/                   ─ category-summary computation
│   ├── expense/                      ─ separate Maram expense-tracker mode
│   ├── db/
│   │   ├── supabase.ts               ─ postgres tagged-template client
│   │   ├── schema.sql                ─ canonical schema (audit-only, real schema in code)
│   │   ├── create-llm-tables.ts      ─ idempotent table+ALTER migrations
│   │   └── (various admin scripts)
│   └── __tests__/                    ─ vitest specs
├── docs/
│   ├── webapp-plan.md
│   ├── recurring-transactions-plan.md
│   ├── integrations-audit.md         ─ Phase 13B output
│   └── phase14a-test-health.md       ─ Phase 14A output
└── package.json                      ─ Stripe, Plaid, Twilio, Anthropic, Sentry SDKs

~/Documents/CashBFF SITE/V4-proto/     ─ Vercel frontend
├── index.html / school.html / verify.html / connect.html / home.html / metrics.html
│   privacy.html / terms.html / school-login.html / paywall.html / plan.html / welcome.html
├── assets/
│   ├── js/index.js / school.js / school-login.js / verify.js / connect.js
│   │   home.js / metrics.js / paywall.js / plan.js / auth-banner.js / sentry-init.js
│   ├── css/                          ─ (mostly inline in <style> blocks per page)
│   └── fonts/GreedCondensed-Bold.woff2 / GreedCondensed-Medium.woff2
├── e2e/                              ─ Playwright specs (~32)
├── docs/
│   ├── user-flow-tree.md             ─ Phase 10C — every role × every page
│   ├── phase14a-test-health.md       ─ test + health audit
│   ├── phase14d-visual-a11y.md       ─ visual + a11y findings
│   └── tech-stack-summary.md         ─ this document
├── vercel.json                       ─ cleanUrls + CSP + cache headers
└── package.json                      ─ vitest + playwright + stripe-js (for Elements)
```

---

## 16. The mental model in one paragraph

CashBFF is a **calendar that knows your money**. Static pages on Vercel are the front door. An Express app on Render does the work — talks to Plaid, Twilio, Stripe, Anthropic, Supabase. Every authoritative byte lives in Supabase. JWT cookies handle auth, with two flavors of user (`user_<digits>` for phone, `school_<uuid>` for under-18). The hourly sync pulls Plaid transactions, runs a small ML-flavored bridge that turns observed-merchant patterns into "recurring" suggestions, and the user confirms them into materialized future projections on the calendar. There's also a copy-pasteable Markdown snapshot for AI, an admin metrics dashboard, and the SMS bot lurking quietly in the background for the people who started there. Everything else is iteration on those bones.

---

_This doc lives at `docs/tech-stack-summary.md` in the cashbff-site repo. Update it whenever the architecture shifts._
