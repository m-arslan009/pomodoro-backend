/*
 * Keeping OAuth credentials out of the log (CONTRACT.md §9.7).
 *
 * `pino-http` serialises the request URL in full, and the provider callback is reached at
 * `…/callback?code=<live authorization code>&state=…`. Left alone, every successful Google sign-in
 * writes a redeemable credential to disk — at the development default of `LOG_LEVEL=debug`, onto
 * every developer's machine. That is a defect from the moment the route exists, not hardening.
 *
 * **The outbound half is not handled here.** The start route answers with a `Location` carrying
 * `state`, `nonce` and the PKCE challenge, and that is removed declaratively by the
 * `res.headers.location` entry in `app.module.ts`'s `redact` list. It is worth knowing why the
 * symmetry is broken: overriding pino's `res` serialiser replaces pino-http's own, and pino's base
 * one reports `statusCode: null` unless `headersSent` is set — so the matching-pair version of this
 * file silently degraded every response line in the application while looking correct.
 *
 * This is a pure function rather than an inline serialiser body so the rule can be tested. The
 * inline version shipped with a hole in it, and the hole was found by reading a log file by hand.
 */

/** Requests under this prefix carry credentials in their query string. */
export const OAUTH_ROUTE_PREFIX = '/api/v1/auth/oauth';

const REDACTED_QUERY = '?[redacted]';

/**
 * Strip the query from an OAuth route's URL, keeping the path.
 *
 * The path is the diagnostic value of the line — that a callback was reached, and with what status.
 * The parameters are the part that must not survive. A `redact` path expression cannot do this
 * because the URL is one string rather than a traversable object.
 */
export function scrubRequestUrl(url: string): string {
  if (!url.startsWith(OAUTH_ROUTE_PREFIX)) return url;

  const queryAt = url.indexOf('?');
  return queryAt === -1 ? url : `${url.slice(0, queryAt)}${REDACTED_QUERY}`;
}
