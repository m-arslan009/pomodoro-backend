import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  EMAIL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  emailLocalPart,
} from './identifier';

/*
 * Provider sign-in rules — pure, framework-free, ORM-free (ADR-008a, CONTRACT.md §3.2, §4.11).
 *
 * Everything here is a decision about *values*: what a provider is, what an ID token has to say
 * before we believe it, what an account derived from a Google profile looks like, and where a
 * successful sign-in is allowed to land. The HTTP call to Google, the cookie, and the database live
 * in the layers above; none of their concerns belong in this file, which is what makes every rule
 * below testable without a server, a browser or a network.
 */

/**
 * The complete list of supported providers.
 *
 * One entry, and adding a second is deliberately not a small change. Branch 3b-ii of §4.12.1
 * auto-links an existing account when the provider says the email is verified, and that trust is a
 * per-provider judgement: Google owns the mailbox it asserts, and a provider that merely echoes a
 * self-declared address does not qualify. A second name added here without re-deciding that is an
 * account-takeover path, so the database CHECK constraint mirrors this list on purpose.
 */
export const OAUTH_PROVIDERS = ['google'] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Where a completed sign-in may land, and the reason it is a fixed list rather than a filter.
 *
 * `returnTo` arrives as a query parameter and comes back out as a `Location` header. An unvalidated
 * value there is an open redirect, and an open redirect on an authentication callback is not a
 * cosmetic bug — it is the delivery mechanism for a phishing page that the user reached by clicking
 * a genuine Evergrove link. Matching against known paths cannot be tricked by an encoding the
 * checker and the browser disagree about, which is how "reject anything with `//` or `:`" fails.
 */
export const ALLOWED_RETURN_TO = ['/timer', '/history', '/settings', '/profile'] as const;

export const DEFAULT_RETURN_TO = '/timer';

/** An allow-listed path, or the default. Never the caller's string, and never an absolute URL. */
export function resolveReturnTo(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_RETURN_TO;
  return (ALLOWED_RETURN_TO as readonly string[]).includes(raw) ? raw : DEFAULT_RETURN_TO;
}

/** 32 CSPRNG bytes, base64url. Used for `state` and `nonce` — both need only unguessability. */
export function randomUrlToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export interface PkcePair {
  /** Kept on this side, in the signed transaction cookie, and sent only at the code exchange. */
  readonly verifier: string;
  /** SHA-256 of the verifier, base64url. The only half the provider and the browser ever see. */
  readonly challenge: string;
}

/**
 * A PKCE verifier and its `S256` challenge (RFC 7636).
 *
 * Applied even though this client is confidential and holds a `client_secret`. OAuth 2.1 and
 * RFC 9700 require PKCE universally because the secret does not defend against the attack it
 * addresses: authorization-code injection, where an attacker who obtains a code through a referrer
 * leak or a redirect misconfiguration redeems it into their own session. Without the verifier the
 * code alone is enough; with it the code is useless to anyone who did not start the flow.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

/* ------------------------------------------------------------------ profile derivation -- */

/**
 * Google supplies none of Evergrove's required shapes directly, so each one is derived here rather
 * than at the persistence boundary — the rules below are the same rules `dto/auth.dto.ts` applies to
 * a hand-typed registration, and they must not drift into a second, laxer copy.
 */
export interface DerivedNames {
  readonly firstName: string;
  readonly lastName: string;
}

/**
 * Names may not contain digits (`NAME_PATTERN`), so digits are replaced by a space rather than
 * deleted — "John2Smith" is two words with a typo between them, not "JohnSmith".
 *
 * @returns a name that satisfies the registration rules, or null when nothing usable survived.
 */
function sanitizeName(raw: string | null): string | null {
  if (raw === null) return null;
  const cleaned = raw.replace(/\d/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < NAME_MIN_LENGTH) return null;
  return cleaned.slice(0, NAME_MAX_LENGTH).trim();
}

/**
 * First and last name, from the best source that yields something usable.
 *
 * The fallbacks are not decoration. `given_name` and `family_name` are optional in OIDC, `name` is
 * a single unstructured string in much of the world, and a Google account can carry a mononym. A
 * derivation that assumed two words would fail account *creation* for those users — so the last
 * resort is a placeholder they can edit, not a rejected sign-in.
 */
export function deriveNames(claims: {
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly name: string | null;
  readonly email: string;
}): DerivedNames {
  const whole = claims.name?.trim() ?? '';
  const spaceAt = whole.indexOf(' ');
  const wholeFirst = spaceAt === -1 ? whole : whole.slice(0, spaceAt);
  const wholeRest = spaceAt === -1 ? '' : whole.slice(spaceAt + 1);

  const firstName =
    sanitizeName(claims.givenName) ??
    sanitizeName(wholeFirst) ??
    sanitizeName(emailLocalPart(claims.email)) ??
    'Evergrove';

  const lastName = sanitizeName(claims.familyName) ?? sanitizeName(wholeRest) ?? 'User';

  return { firstName, lastName };
}

/** Four base36 characters, appended to a username stem after a collision. */
function collisionSuffix(): string {
  let suffix = '';
  for (let i = 0; i < 4; i += 1) suffix += randomInt(36).toString(36);
  return suffix;
}

/** How many usernames to try before giving up on deriving one (CONTRACT.md §3.2). */
export const USERNAME_ATTEMPT_LIMIT = 5;

/**
 * A username candidate for attempt number `attempt`, counting from zero.
 *
 * There is no "is this taken?" pre-check anywhere in this flow, and that is the design. Checking and
 * then inserting is a race: two sign-ins deriving the same candidate both see it free and one insert
 * fails anyway. The unique index is the only race-free authority, so the caller inserts, lets the
 * index refuse, and asks here for the next candidate.
 */
export function deriveUsernameCandidate(email: string, attempt: number): string {
  const base =
    emailLocalPart(email)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, USERNAME_MAX_LENGTH) || 'user';

  if (attempt === 0 && base.length >= USERNAME_MIN_LENGTH) return base;

  // Leave room for the separator and the four suffix characters, so the result stays in bounds.
  const stem = base.slice(0, USERNAME_MAX_LENGTH - 5);
  return `${stem}_${collisionSuffix()}`;
}

/* ------------------------------------------------------------------- ID token validation -- */

/**
 * The claims we read off a validated ID token, and the complete list of what this feature is
 * willing to believe a provider about.
 *
 * `sub` is the identity. `email` is consulted exactly once — to find an account to auto-link the
 * first time someone signs in — and never again: a returning user resolves by `sub` alone, so
 * changing their Google address does not change who they are here (§4.12.1 step 3a).
 */
export interface IdTokenClaims {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly name: string | null;
}

/** Google publishes both spellings, and the token uses one or the other depending on its age. */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;

/** Tolerance for `exp` and `iat`, in milliseconds. Two clocks are never exactly the same clock. */
export const CLOCK_LEEWAY_MS = 60_000;

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Read a JWT's payload without verifying its signature.
 *
 * **That omission is deliberate and it is load-bearing, so it is stated here rather than left to be
 * discovered.** OIDC Core §3.1.3.7 permits skipping ID-token signature validation when the token
 * arrives over a direct, TLS-authenticated back-channel call to the token endpoint — which is
 * exactly how this one arrives: a server-to-server POST we initiated, to a pinned host, using
 * `client_secret`. TLS already answered "did this come from Google", and the signature would answer
 * the same question a second time at the cost of a JWKS fetch, a key cache, and a JOSE dependency.
 *
 * The consequence is that this function must never be pointed at a token from anywhere else. A
 * token arriving in a request — from a browser, a query parameter, a header — has no such guarantee
 * and would need its signature checked. Nothing in this codebase does that, and nothing may start.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface IdTokenExpectations {
  readonly audience: string;
  readonly nonce: string;
  readonly now: Date;
}

/**
 * Validate an ID token's claims and project the ones we use.
 *
 * Every rejection returns the same `null`. As with `AccessTokenService.verify`, the caller then has
 * no failure detail available to leak — the six ways this can fail all become one `invalid_request`
 * redirect, so a caller learns that the attempt failed and not which half of it worked.
 *
 * `email_verified` is read but **not** enforced here: it is a claim, and whether a false value is
 * fatal is a policy question that belongs with the account-resolution rules (§4.12.1 step 0), not
 * with token validity.
 */
export function validateIdTokenClaims(
  token: string,
  expected: IdTokenExpectations,
): IdTokenClaims | null {
  const payload = decodeJwtPayload(token);
  if (payload === null) return null;

  const issuer = optionalString(payload.iss);
  if (issuer === null || !(GOOGLE_ISSUERS as readonly string[]).includes(issuer)) return null;

  // The token was minted for *this* client. Without it, an ID token issued to any other Google
  // application would be accepted here, which is the classic confused-deputy sign-in.
  if (optionalString(payload.aud) !== expected.audience) return null;

  // Bound to this specific authorization request, so a token captured elsewhere cannot be replayed
  // into our callback.
  if (optionalString(payload.nonce) !== expected.nonce) return null;

  const nowMs = expected.now.getTime();
  if (typeof payload.exp !== 'number' || payload.exp * 1000 + CLOCK_LEEWAY_MS <= nowMs) return null;
  if (typeof payload.iat !== 'number' || payload.iat * 1000 - CLOCK_LEEWAY_MS > nowMs) return null;

  const sub = optionalString(payload.sub);
  if (sub === null || sub.length > 255) return null;

  const email = optionalString(payload.email);
  if (email === null || email.length > EMAIL_MAX_LENGTH || !email.includes('@')) return null;

  return {
    sub,
    email: email.trim().toLowerCase(),
    // Absent is not verified. Google sends this claim; a token without it is one we do not
    // understand, and defaulting an unknown to `true` is how auto-linking becomes a takeover.
    emailVerified: payload.email_verified === true,
    givenName: optionalString(payload.given_name),
    familyName: optionalString(payload.family_name),
    name: optionalString(payload.name),
  };
}
