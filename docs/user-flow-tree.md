# CashBFF user-flow tree (Phase 10C)

Every user-facing path through the V4 web app, walked top-down. Each leaf
names the page, the actor, the landing state, every interactive element,
the redirect targets, and the edge cases. Backend SMS surfaces are
included at the bottom because the same actors hit them.

Roles in this tree:

- **Anon visitor** — no `cbff_session` cookie, never been here.
- **New phone user** — running the index funnel: Plaid -> phone -> OTP -> home.
- **Returning phone user** — clicks "already have an account" or visits `/verify`.
- **New school parent** — fills `/school` -> Stripe SetupIntent -> success.
- **Returning school user (kid)** — `/school/login?email=&code=`.
- **Already-authed user** — sees the floating "my home -> " pill on every
  marketing/funnel page (Phase 9A pivot — no auto-redirect).
- **Admin (Daksh)** — only role with access to `/metrics`.
- **SMS user (Maram)** — silently blocked at `/api/otp/send` and `/api/otp/verify`.
- **SMS spammer** — non-allowlisted inbound texts, soft-dropped.

---

## `/` (index.html)

- Loads `assets/js/auth-banner.js` + `assets/js/index.js`.
- Anon visitor:
  - Sees: hero ("close your eyes. we'll pay it down."), `state-connect`
    panel ("step 1 of 2", `connect-btn`, 18+ disclaimer linking to
    `terms.html`, `returning-link` "already have an account").
  - **`connect-btn` click** -> opens Plaid Link via the SDK.
    - Plaid `onSuccess(public_token, meta)` -> `state-plaid` panel ->
      `POST /api/plaid/exchange` -> `state-phone` panel.
    - Plaid `onExit` -> back to `state-connect`.
  - **State 3 (`state-phone`)** -> `phone-input` -> `send-otp-btn` ->
    `POST /api/otp/send` -> `state-otp` panel.
  - **State 4 (`state-otp`)** -> `otp-input` -> `verify-otp-btn` ->
    `POST /api/otp/verify` -> server sets cookie -> redirect to
    `/welcome.html` for first-timers, `/home.html` for returning.
  - **`returning-link` click** -> hides connect, shows
    `state-returning-phone`.
    - `returning-send-btn` -> `POST /api/otp/send` -> shows
      `state-returning-otp`.
    - `returning-verify-btn` -> `POST /api/otp/verify` -> `/home.html`.
    - `returning-back` -> back to `state-connect`.
  - Footer: privacy, terms, mailto:daksh@cashbff.com.
- Authed user:
  - `probeAuthAndPaintBanner` calls `GET /api/me`. On 200, paints
    floating "my home -> " pill via `showAuthHomeButton()`. Funnel still
    renders (Phase 9A — no auto-redirect).
  - **Pill click** -> `/home.html`.
- Edge cases: Plaid CDN failure -> `connect-btn` disabled with banner
  "loading bank connector"; OTP wrong -> banner "that code didn't match";
  resend timer disables `resend-otp` for 30s.

## `/connect.html`

- Loads `connect.js`. Authed: shows pill + hides `#connect-btn` and
  `.cta-fine` via `hidePageInteractionForAuthed`.
- Anon: `connect-btn` runs the same Plaid flow as `/` State 1, then
  redirects to `/verify.html?phone=...`.
- Disclaimer: "by clicking, you confirm you're 18+ and agree to our
  [terms]" -> `terms.html`.
- Edge cases: Plaid SDK failure -> retry button.

## `/verify.html`

- Loads `verify.js`. Anon hits the page through `/connect` (post-Plaid
  exchange).
- Visible: `phone-input`, `verify-btn`, `meta-row` ("didn't get it?
  resend / wrong number? change it"), 18+ disclaimer linking to
  `terms.html`.
- Authed: `verify-btn` + form hidden, "already signed in" note + pill.
- `verify-btn` click -> `POST /api/otp/verify` -> `/home.html`.
- Edge cases: 5 wrong attempts -> backend locks the OTP row, response
  "Too many attempts" -> banner.

## `/paywall.html`

- Loads `paywall.js`. Pre-bank-connect step in the funnel.
- Anon visitor: `start-btn` -> `connect.html?phone=...` (Stripe checkout
  not wired yet — placeholder).
- Authed: pill + hides `start-btn` + "you're already signed in" note.
- Footer: privacy, terms, mailto.
- **BUG**: `terms-link` click handler in `paywall.js` calls
  `e.preventDefault()` and shows `alert('terms coming soon.')` instead of
  navigating to `/terms.html`. Disclaimer link is broken.

## `/plan.html`

- Loads `plan.js`. Marketing calculator.
- Visible: form (debt amounts, income), result view.
- `calc-btn` runs the local payoff math, swaps `form-view` for
  `result-view`.
- Authed: pill + hides form + result via
  `hidePageInteractionForAuthed`.

## `/welcome.html`

- Loads `welcome.js`. Post-signup profile step (only first-time users).
- Visible: stats row (accts, txns, "with us"), profile form (first
  name, last name, email, dob), `submit-btn`, "skip for now" link to
  `/home.html`.
- `submit-btn` -> `POST /api/profile` -> `/home.html`.
- Edge cases: skip-link does NOT post — user lands on home with empty
  profile.

## `/home.html` (the main app)

- Auth gate: `GET /api/me`. 401 -> `location.replace('/')`. 200 -> render.
- Calls in parallel: `/api/calendar`, `/api/balances`, `/api/cards`,
  `/api/wallet`, `/api/recurring/suggestions`, `/api/recurring/streams`,
  `/api/reimbursements`. NO call to `/api/recurring/rollover-prompts` —
  Phase 8.5B killed the day-of rollover modal.
- **Top bar**: wordmark, phone-pill (`+1 (XXX) XXX-XXXX`), settings/menu
  link.
- **Hero strip**: balances chip, plans/spending/incoming chips, snapshot
  chip, recurring chip, reimbursements chip, to-do chip.
- **`#snapshot-btn` click** (Phase 10A):
  - Opens `#snapshot-pop` modal -> `GET /api/snapshot` -> textarea fills
    with copy-pasteable Markdown.
  - **`snapshot-copy` click** -> `navigator.clipboard.writeText(text)` ->
    button flashes "copied!".
  - LLM deep-links: `snapshot-ask-chatgpt`, `snapshot-ask-claude`,
    `snapshot-ask-gemini` (`target="_blank"`, `rel="noopener"`).
  - **Escape / overlay click** -> closes modal.
- **`#recurring-btn` click**:
  - Opens `#recurring-pop` -> renders skeleton -> populates with
    suggestions (`#recurring-suggestions-list`) and confirmed streams
    (`#recurring-streams-list`).
  - **Suggestion card** -> editable name + amount + date inputs, accept
    / dismiss buttons.
  - **Stream card** -> `.recurring-stream__main` click opens
    `#recurring-edit-pop`; trash icon -> `DELETE /api/recurring/streams/:merchant`.
  - **`#recurring-add-btn`** -> `#recurring-add-pop` (manual add modal)
    with name, amount, date, frequency chips, end-date.
  - Empty state: "nothing tracked yet."
- **Calendar grid**:
  - Renders 6-week month grid. Each cell shows total spend, optional
    pills for bill/cc/sub/income.
  - **Cell click** -> opens `#drawer` (day popover). Lists each
    transaction row with name, amount, source bank.
  - **Acknowledged rows** (Phase 10B): rendered greyed-out, line-through,
    "checkmark paid" badge, excluded from running-balance projection.
  - **Note text** never includes the internal `recurring-projection:`
    prefix — `home.js:772` strips it before rendering the `.note` div.
  - **Trash icon** on a stream-linked row -> 2-button confirm:
    1. `DELETE /api/transactions/schedule/:id` -> 409 STREAM_LINKED.
    2. Surface renders `[merchant] is part of your recurring stream` +
       buttons "checkmark I already paid this" + "stop tracking this
       stream" + cancel.
    3. **Acknowledge** -> `POST /api/transactions/schedule/:id/acknowledge` ->
       row gets `.is-acknowledged`, projection re-renders.
    4. **Stop tracking** -> opens `#recurring-pop` (recurring tab).
- **Floating `#add-account-btn`** (bottom-center) -> `add-account.js`
  modal with Plaid / Manual / Close choices.
- **Footer**: privacy, terms, mailto:daksh@cashbff.com.
- Edge cases: stale localStorage `cbff_v1_*` cache TTL is 24h (calendar
  is NOT SWR-cached — was pulling zombies).

## `/school.html`

- Loads `school.js`. Funnel for under-18 student users; parent fills
  the form on the kid's behalf.
- Anon: `state-form` shows parent first name + email, student first
  name + email, dob, consent checkbox, `submit-btn` "count me in".
  - **Submit click**:
    - DOB >= 18 years old -> swap to `state-ageout` (CTA -> `/`,
      "wrong birthday? go back" -> `state-form`).
    - DOB < 18 -> `POST /api/school/start` -> `state-verifying` ->
      Stripe Elements mount in `state-stripe-card`.
  - **`verify-card-btn`** -> `stripe.confirmSetup` -> `POST /api/school/finalize` ->
    `state-success` (kid login URL pre-filled, copy button).
- Authed: pill + hides form via `hidePageInteractionForAuthed`.
- **BUG**: `school.html:591` consent text reads "i agree to the
  [terms]" but the `<a>` `href` is `privacy.html` — wrong target.

## `/school-login.html`

- Loads `school-login.js`. Student-facing login.
- Visible: `student_email` and `kid_code` inputs, `login-btn`. URL
  query params (`?email=&code=`) auto-populate inputs.
- **Submit** -> `POST /api/school/login` -> `/home.html`.
- Inline copy: "lost your code? ask your parent for a new one — they
  can grab it from cashbff.com/school."
- Edge cases: bad code -> banner.

## `/privacy.html`

- Static legal page. No JS calls. Sections: what we collect, how we use
  it, research data, third parties, your rights, cookies, under 18,
  changes, contact. Footer: privacy / terms / mailto.

## `/terms.html`

- Static legal page. Sections: who can use, what we do, what we don't
  do, your responsibilities, research, subscription billing,
  termination, disclaimers, governing law, changes, contact.

## `/metrics.html` (admin only)

- Loads `metrics.js`. Auto-refreshes every 30s.
- Calls all five `/api/metrics/*` endpoints in parallel:
  `overview`, `sms`, `signup-funnel`, `recurring`, `recent-signups`.
- Admin: `#metrics-main` shown, sections render.
- Non-admin (any 403/401 from any endpoint): flips to `#metrics-denied`
  with "go home" link to `/home.html`.
- Edge cases: partial failures still flip to denied (all-or-nothing).

---

## SMS surfaces (backend `recurring-bridge.ts` -> `/api/twilio/sms`)

- **Allowlisted user (Maram)**: Twilio inbound -> backend silently
  drops at `POST /api/otp/send` + `POST /api/otp/verify`. Returns 200
  `ok: true` with no SMS sent. Verifies as "No active code" if she
  tries the OTP path. See `auth-e2e.test.ts:165-181`.
- **Non-allowlisted spammer**: same silent-drop behavior — keeps cost
  bounded.
- Phase 8.5A: `autoAdvanceConfirmedStreams` runs inside `syncUser`
  (`src/sync.ts:399`) — observed charges in the [-3d, +5d] window
  silently bump `next_due_date`. The user never sees a prompt.

---

## Common edge cases across pages

- **Auth expired mid-session**: any 401 from a bound endpoint -> the
  caller redirects to `/`. The cookie is HttpOnly so JS can't read its
  expiry directly; we infer from API responses.
- **Already-authed user on a marketing page**: per Phase 9A, no
  hard-redirect — the floating pill is the affordance.
- **No-data state**: `/home.html` calendar shows "no transactions yet";
  recurring tab shows "nothing tracked yet"; reimbursements shows "no
  reimbursements".
- **Plaid SDK failure**: `connect-btn` disabled, banner "loading bank
  connector".
- **Stripe SDK failure on `/school`**: error banner + email link to
  daksh@cashbff.com.
