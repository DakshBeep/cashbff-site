# CashBFF Playwright E2E suite

End-to-end tests for the web app, run against the live production stack
(`https://cashbff.com` + `https://api.cashbff.com`). The OTP login step is
skipped by minting a `cbff_session` JWT cookie locally and injecting it into
the browser before each spec.

## Prereqs

- Node 18+
- The production `JWT_SECRET` (Render env var on the API service)

## Install

```bash
cd "/Users/daksh/Documents/CashBFF SITE/V4-proto"
npm install
npx playwright install chromium
```

## Run

```bash
JWT_SECRET=<prod secret> npm run e2e
```

Run a single spec:

```bash
JWT_SECRET=<prod secret> npx playwright test schedule-lifecycle
```

Headed (watch the browser drive itself):

```bash
JWT_SECRET=<prod secret> npx playwright test --headed
```

List specs without running them (sanity check):

```bash
npx playwright test --list
```

If `JWT_SECRET` is missing from the environment, every spec will `test.skip()`
with a clear reason rather than failing, so a `--list` (or a CI run without
the secret wired in) stays green.

## Env vars

| Var          | Default               | Purpose                                                      |
| ------------ | --------------------- | ------------------------------------------------------------ |
| `JWT_SECRET` | _(required)_          | The HS256 signing secret used by the API server.             |
| `TEST_UID`   | `user_19095425819`    | Daksh's prod user id. Override to point at a different user. |
| `TEST_PHONE` | `+19095425819`        | E.164 phone in the JWT payload.                              |
| `TEST_SV`    | `1`                   | Session version. Bump if the user's `sv` ever rotates.       |

See `.env.example` at the repo root.

## What's covered

| Spec                            | Covers                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| `home-calendar.spec.ts`         | `/home` renders, calendar grid + month title + today cell.      |
| `day-popover.spec.ts`           | Clicking a day opens `#drawer`; Escape closes it.               |
| `schedule-lifecycle.spec.ts`    | Full POST → PATCH → DELETE on `/api/transactions/schedule`.     |
| `balances.spec.ts`              | Balances popup, running balance hero, account rows, Escape closes. |

OTP send/verify is **not** covered — it requires a real SMS roundtrip.

## Cleanup

The schedule lifecycle spec creates rows with names starting with
`__playwright_test`. Each spec has a `beforeAll` / `afterAll` hook that calls
`cleanupTestData()` from `auth-helper.ts`, which:

1. Pulls `GET /api/calendar?from=…&to=…` over a ±90 day window.
2. Deletes every `source: "scheduled"` expense whose name starts with
   `__playwright_test`.

That sweep runs even if a spec throws midway, so a failed run won't leave
junk on Daksh's account.

## Notes / tradeoffs

- **Tests target prod.** A staging environment would be safer, but none
  exists yet. Until then, the cleanup hook + the unique marker prefix keep
  the blast radius small.
- **Single user.** All specs run as Daksh's account. If we wire a dedicated
  test user later, swap `TEST_UID` / `TEST_PHONE` / `TEST_SV` env vars or
  create a `e2e/.env.test`.
- **Serial workers.** Playwright is configured with `workers: 1` so two
  specs don't race on the same account state.
- **Trace on failure** is enabled — if a spec fails, run
  `npx playwright show-trace test-results/<failed-spec>/trace.zip` to step
  through the run frame-by-frame.
