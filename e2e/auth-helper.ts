// Auth helper for Playwright specs.
//
// Production auth is a `cbff_session` HS256 JWT cookie scoped to
// `Domain=.cashbff.com`. The shape is:
//
//   { uid: <user_id>, phone: <e164>, sv: <session_version> }
//
// We mint that locally with `jose` using the same JWT_SECRET the API
// server uses (env var on Render). For local test runs the developer
// exports JWT_SECRET in their shell — never commit it.
//
// If JWT_SECRET is missing the test that calls `authenticatedContext()`
// is skipped with a clear reason rather than failing — that way a
// `npx playwright test --list` (or a CI run without the secret) stays
// quiet instead of erroring out.
//
// Mirrors the cookie-minting approach in
// /Users/daksh/Documents/CashBFF Plaid API/scripts/smoke-home-calendar.sh

import { SignJWT } from 'jose';
import type { Browser, BrowserContext, APIRequestContext } from '@playwright/test';
import { test, request } from '@playwright/test';

export const TEST_UID = process.env.TEST_UID || 'user_19095425819';
export const TEST_PHONE = process.env.TEST_PHONE || '+19095425819';
export const TEST_SV = Number(process.env.TEST_SV || '1');
export const COOKIE_DOMAIN = '.cashbff.com';
export const SITE_URL = 'https://cashbff.com';
export const API_URL = 'https://api.cashbff.com';
export const COOKIE_NAME = 'cbff_session';
// Marker prefix for any data the tests create. Cleanup hooks delete every
// scheduled txn whose name starts with this string.
export const TEST_MARKER = '__playwright_test';

function requireJwtSecret(): string | null {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim() === '') return null;
  return secret;
}

/**
 * Mint a `cbff_session` JWT for the configured test user.
 *
 * Returns null if JWT_SECRET is missing — callers should treat that as a
 * skip signal rather than a failure.
 */
export async function mintSessionToken(opts?: {
  uid?: string;
  phone?: string;
  sv?: number;
  ttlSeconds?: number;
}): Promise<string | null> {
  const secret = requireJwtSecret();
  if (!secret) return null;

  const uid = opts?.uid ?? TEST_UID;
  const phone = opts?.phone ?? TEST_PHONE;
  const sv = opts?.sv ?? TEST_SV;
  const ttl = opts?.ttlSeconds ?? 60 * 30; // 30 min — well past any spec runtime

  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(secret);

  return new SignJWT({ uid, phone, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(key);
}

/**
 * Returns a logged-in BrowserContext, or skips the current test if the
 * JWT secret is missing. Callers should `const ctx = await
 * authenticatedContext(browser);` and then `await ctx.newPage()`.
 */
export async function authenticatedContext(browser: Browser): Promise<BrowserContext> {
  const token = await mintSessionToken();
  if (!token) {
    test.skip(true, 'JWT_SECRET not set in env — see e2e/README.md');
    // test.skip throws, but TS doesn't know — return is unreachable.
    throw new Error('unreachable: test.skip should have thrown');
  }

  const context = await browser.newContext();
  const expires = Math.floor(Date.now() / 1000) + 60 * 30; // matches TTL above
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      domain: COOKIE_DOMAIN,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      expires,
    },
  ]);
  return context;
}

/**
 * Returns an APIRequestContext that talks directly to api.cashbff.com with
 * the auth cookie pre-attached. Used by cleanup hooks to delete any
 * `__playwright_test*__` rows the suite may have left behind.
 *
 * Returns null if no JWT_SECRET is set — cleanup is a best-effort step,
 * the caller decides whether to skip.
 */
export async function authenticatedApi(): Promise<APIRequestContext | null> {
  const token = await mintSessionToken();
  if (!token) return null;
  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: {
      // The API expects the JWT in a cookie, not a bearer header — set both
      // in case some endpoints are picky, but the server only reads the
      // cookie today.
      Cookie: `${COOKIE_NAME}=${token}`,
    },
  });
}

/**
 * Sweep any leftover `__playwright_test*__` tracked accounts for the test
 * user. Lists them via /api/wallet and deletes anything whose name matches
 * the marker. Safe to call multiple times.
 */
export async function cleanupTrackedAccounts(): Promise<void> {
  const api = await authenticatedApi();
  if (!api) return;

  let leftovers: Array<{ id: string | number; name: string }> = [];
  try {
    const res = await api.get('/api/wallet');
    if (!res.ok()) {
      console.warn(`[cleanup] /api/wallet returned ${res.status()} — skipping`);
      await api.dispose();
      return;
    }
    const data = (await res.json()) as {
      tracked_accounts?: Array<Record<string, unknown>>;
    };
    const tracked = data.tracked_accounts || [];
    leftovers = tracked
      .filter((t) => String(t.name || '').startsWith(TEST_MARKER))
      .map((t) => ({ id: t.id as string | number, name: String(t.name) }));
  } catch (err) {
    console.warn('[cleanup] could not list wallet:', err);
    await api.dispose();
    return;
  }

  if (leftovers.length === 0) {
    await api.dispose();
    return;
  }

  console.log(`[cleanup] deleting ${leftovers.length} leftover __playwright_test*__ tracked account(s)`);
  for (const row of leftovers) {
    try {
      const res = await api.delete(
        `/api/tracked-accounts/${encodeURIComponent(String(row.id))}`,
      );
      if (!res.ok() && res.status() !== 404) {
        console.warn(
          `[cleanup] DELETE tracked id=${row.id} name=${row.name} -> HTTP ${res.status()}`,
        );
      }
    } catch (err) {
      console.warn(`[cleanup] DELETE tracked id=${row.id} threw:`, err);
    }
  }
  await api.dispose();
}

/**
 * Sweep any leftover `__playwright_test*__` scheduled transactions for the
 * test user. Pulls a wide calendar window (90d back, 90d forward) and
 * deletes anything that matches the marker. Safe to call multiple times.
 *
 * Reports counts via console.log so a CI run shows what got cleaned up.
 */
export async function cleanupTestData(): Promise<void> {
  const api = await authenticatedApi();
  if (!api) {
    // No secret — nothing to clean up since no test could have created data.
    return;
  }

  const today = new Date();
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 90);
  const toDate = new Date(today);
  toDate.setDate(toDate.getDate() + 90);

  const fromIso = fromDate.toISOString().slice(0, 10);
  const toIso = toDate.toISOString().slice(0, 10);

  let leftovers: Array<{ id: string | number; name: string; source?: string }> = [];
  try {
    const res = await api.get(`/api/calendar?from=${fromIso}&to=${toIso}`);
    if (!res.ok()) {
      console.warn(`[cleanup] /api/calendar returned ${res.status()} — skipping cleanup`);
      await api.dispose();
      return;
    }
    const data = (await res.json()) as { expenses?: Array<Record<string, unknown>> };
    const expenses = data.expenses || [];
    leftovers = expenses
      .filter((e) => {
        const name = String(e.name || '');
        const source = String(e.source || '');
        // Only delete scheduled rows — never touch Plaid-sourced data.
        return source === 'scheduled' && name.startsWith(TEST_MARKER);
      })
      .map((e) => ({
        id: e.id as string | number,
        name: String(e.name),
        source: String(e.source || ''),
      }));
  } catch (err) {
    console.warn('[cleanup] could not list calendar:', err);
    await api.dispose();
    return;
  }

  if (leftovers.length === 0) {
    await api.dispose();
    return;
  }

  console.log(`[cleanup] deleting ${leftovers.length} leftover __playwright_test*__ row(s)`);
  for (const row of leftovers) {
    try {
      const res = await api.delete(
        `/api/transactions/schedule/${encodeURIComponent(String(row.id))}`,
      );
      if (!res.ok()) {
        console.warn(
          `[cleanup] DELETE id=${row.id} name=${row.name} -> HTTP ${res.status()}`,
        );
      }
    } catch (err) {
      console.warn(`[cleanup] DELETE id=${row.id} threw:`, err);
    }
  }
  await api.dispose();
}
