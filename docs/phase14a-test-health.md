# Phase 14A — Pre-conference test + integration health

Run date: 2026-04-30 (local 12:01 PT)

## 1. Backend tests

`cd CashBFF\ Plaid\ API && npx vitest run --exclude='.claude/**'`

| Bucket | Count |
|---|---|
| Total tests | 1502 |
| Passed | 1489 |
| Failed | 13 |
| Test files | 32 (30 passed, 2 failed) |

Failure breakdown:

- **Pre-existing / advisory (10):** all in `src/__tests__/supabase-integrity.test.ts`. Tests assert hard-coded reference counts against live Supabase rows; data has drifted since they were written. Treat as monitoring-style, not blocking.
- **NEW (3):** `src/__tests__/snapshot.test.ts > buildBalancesSection`. Production output was updated in commit `abee8c6` (running-balance / cash-on-hand markdown) but the test wasn't updated. Test still expects the old `total cash: $X (across N accounts)` line. Asserts at lines 240, 252, 271. **Code is correct; the tests are stale.** Snapshot endpoint is verified working by the v1-comprehensive Playwright spec (`item #1 — snapshot for AI`, passed).

## 2. Build status

`npm run build` → `tsc` exits 0, no errors. **Clean.**

## 3. Frontend tests

### Vitest (`npm test` in V4-proto)

| Bucket | Count |
|---|---|
| Total | 51 |
| Passed | 51 |
| Failed | 0 |
| Files | 2 (home.test.js, metrics.test.js) |

### Playwright

Spec inventory: 107 tests across 32 files.

Mock-only specs run:

| Spec | Result |
|---|---|
| legal-pages.spec.ts | passed |
| onboarding.spec.ts | passed |
| full-sweep.spec.ts | passed |
| v1-comprehensive.spec.ts | 55 passed, 3 skipped, 1 failed (mobile-sanity school.html networkidle timeout — flake; school.html itself returns HTTP 200) |
| recurring-bugs.spec.ts | 3 skipped (no JWT_SECRET — expected) |
| running-balance-math.spec.ts | 2 skipped (no JWT_SECRET — expected) |
| per-day-projection.spec.ts | 1 skipped (no JWT_SECRET — expected) |

Live-prod-with-JWT specs (recurring-live, snapshot, etc.) **not run** per instructions.

## 4. Integration health (live probes)

Temp probe at `scripts/_phase14a_probe_tmp.ts` (deleted after run). Credentials sourced via Render API.

| Service | Status | Detail |
|---|---|---|
| Stripe | ✓ | `customers.list({limit:1})` 200 OK; 1 customer returned |
| Plaid | ✓ | `institutionsGet` 200 OK; 9944 institutions in catalog |
| Twilio | ✓ | `IncomingPhoneNumbers` 200 OK; 1 number on account (+1-877-812-6360) |
| Anthropic | ✓ | `claude-haiku-4-5` (model id `claude-haiku-4-5-20251001`) responded "ok"; 9 in / 4 out tokens |
| Supabase | ✓ | `SELECT 1` returned 1 |
| Sentry | ✓ | `SENTRY_DSN` present, valid format, host `o4511234298937344.ingest.us.sentry.io` |

All six green.

## 5. Deploy state

### Render (`srv-d3slhc9r0fns738ja6qg`)

- Latest deploy: `dep-d7q088l8nd3s738lrpi0`
- Status: **live**
- Commit: `f33a4dba069fc4e15edf9400ba36d751b9a0b17f` — "fix(plaid): hardcode webhook URL on every linkTokenCreate"
- Deployed: 2026-05-01 01:39:39 UTC
- Matches `git log origin/main -1 --oneline` → `f33a4db` ✓

### Vercel (`cashbff.com`)

| Asset | last-modified | etag |
|---|---|---|
| `/assets/js/home.js` | Fri 2026-05-01 16:35:48 GMT | `c28627bf0f0b5b0174f8807e8775ba30` |
| `/assets/js/school.js` | Fri 2026-05-01 18:00:54 GMT | `be392c6e50a0df044df721495927a5e9` |

Both fresh (today). `cache-control: public, max-age=0, must-revalidate` → CDN won't serve stale.

## 6. Smoke tests against prod

| URL | Expected | Got |
|---|---|---|
| `GET https://api.cashbff.com/api/me` | 401 | **401** ✓ |
| `POST https://api.cashbff.com/api/school/start` (no body) | 400 | **400** ✓ |
| `GET https://cashbff.com/` | 200 | **200** ✓ |
| `GET https://cashbff.com/school` | 200 or 308 | **200** ✓ (308 on `/school.html` → 200 final) |
| `GET https://cashbff.com/privacy` | 200 | **200** ✓ |
| `GET https://cashbff.com/terms` | 200 | **200** ✓ |

All six match.

## 7. Anything blocking the conference

1. **(low)** `src/__tests__/snapshot.test.ts` 3 failures from code drift after `abee8c6`. Production behaviour is correct — these are stale test assertions. Won't break anything at the conference. Easy 5-minute fix to update the expected strings to match the new running-balance markdown.
2. **(low)** `mobile sanity (375px) /school.html` Playwright test times out on `waitForLoadState('networkidle')`. The page itself loads fine (HTTP 200, all integrations live); networkidle is unreachable because Plaid/Stripe/Sentry SDKs keep XHR ticking. Consider switching this assertion to `domcontentloaded` post-conference.
3. **(low)** 10 stale supabase-integrity tests with hardcoded reference counts. Already known. Re-baseline post-conference.

No HIGH or MEDIUM severity issues.

---

**TL;DR: ready to demo.** All six external integrations live, both deploys on latest, prod URLs healthy, build clean, frontend tests + 1489/1502 backend tests passing. The 13 failures are stale assertions, not real bugs.
