import type { CookieOptions } from 'express';

/*
 * The refresh cookie: how it is read, and how it is written.
 *
 * No `cookie-parser`. `res.cookie()` and `res.clearCookie()` are native Express, and reading is one
 * `; `-delimited header — a dependency for that would be a dependency for ten lines (CONTRACT.md §9).
 * The token is opaque and verified against a stored digest, so signed cookies would add nothing.
 */

/**
 * Where the browser is allowed to send the refresh token.
 *
 * Scoped to the auth routes on purpose: the long-lived credential is then simply **absent** from the
 * fifteen-odd other authenticated endpoints, which never need it. Two things about this constant
 * fail silently if they drift, so both are stated rather than left to be rediscovered:
 *
 *  1. `res.clearCookie` must be called with the *identical* path. Clear it on `/` and the browser
 *     keeps the `/api/v1/auth` cookie — logout returns 204, appears to work, and the next reload
 *     silently signs the user back in.
 *  2. This is coupled to `app.setGlobalPrefix('api/v1')` in main.ts. Bumping the API version without
 *     changing this line strands every live session, because the browser stops sending the cookie to
 *     the route that would have rotated it.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * Attributes for the refresh cookie, and the same ones must be used to clear it.
 *
 * `secure` follows the environment rather than being pinned on. Chrome and Firefox do accept
 * `Secure` cookies over `http://localhost`, treating it as a trustworthy origin — but WebKit does
 * not, and it fails by silently never storing the cookie. Pinning it would break local development
 * on Safari with no error message anywhere.
 *
 * `sameSite: 'lax'` plus a same-origin API (the Vite proxy in development, the Netlify rewrite in
 * production) is the CSRF posture — see CONTRACT.md §5 and ADR-008 rev. 3 for why no token is used.
 */
export function refreshCookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  };
}

/**
 * The OAuth transaction cookie (ADR-008a). Same discipline as the refresh cookie: scoped so it is
 * simply **absent** from every request that does not need it, which here is all but two routes.
 */
export const OAUTH_COOKIE_NAME = 'evergrove_oauth';

export const OAUTH_COOKIE_PATH = '/api/v1/auth/oauth';

/** Ten minutes. A consent screen a user leaves open longer than that is an abandoned attempt. */
export const OAUTH_COOKIE_TTL_MS = 600_000;

/**
 * Attributes for the transaction cookie, and the same ones must be used to clear it.
 *
 * **`sameSite: 'lax'` is load-bearing here, and `'strict'` would be a silent, total failure.** The
 * provider's callback arrives as a cross-site *top-level GET navigation*: `Lax` sends the cookie on
 * exactly that, and `Strict` withholds it. Every sign-in would then fail with a state mismatch, on
 * every browser, with nothing in any log explaining why — the request simply arrives without the
 * cookie it was issued moments earlier.
 *
 * `secure` follows the environment for the same reason `refreshCookieOptions` does: WebKit refuses
 * to store `Secure` cookies on `http://localhost` and fails by never storing them at all.
 */
export function oauthCookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: OAUTH_COOKIE_PATH,
  };
}

/**
 * Pull one cookie out of a raw `Cookie` header.
 *
 * @returns the decoded value, or null when the header is absent or has no such cookie.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is a malformed cookie, which is indistinguishable from an
      // absent one as far as every caller is concerned: both end in the same 401.
      return null;
    }
  }

  return null;
}
