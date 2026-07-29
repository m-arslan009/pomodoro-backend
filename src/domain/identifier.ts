/*
 * Identity rules — pure, framework-free, ORM-free (enforced by eslint on src/domain).
 *
 * These constants are the authority for the shape of an account's identifiers, and they are
 * mirrored exactly in the frontend's services/validation.js. A client rule looser than this one
 * produces a form that passes and then fails at the API.
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 50;
/** Names may not contain digits — matches the frontend's long-standing rule. */
export const NAME_PATTERN = /^[^\d]+$/;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

export const EMAIL_MAX_LENGTH = 320;
/** Pragmatic shape check: something@something.tld with no spaces. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A login identifier, resolved to the column it will be looked up against. */
export type LoginIdentifier =
  | { readonly kind: 'email'; readonly value: string }
  | { readonly kind: 'username'; readonly value: string };

/** Storage form of an email: trimmed and lowercased. A CHECK constraint enforces this at rest. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Display form of a username: trimmed, casing preserved — it is a public handle. */
export function normalizeUsername(raw: string): string {
  return raw.trim();
}

/** Uniqueness key for a username: the value stored in users.username_lower. */
export function usernameKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Decide which column a login identifier addresses.
 *
 * Detection is deterministic rather than heuristic: usernames are restricted to
 * [A-Za-z0-9_], so a value containing '@' cannot be a username and a value without one cannot
 * be an email. No ambiguous case exists.
 *
 * Deliberately performs no validation. On the login path an unparseable identifier must fail as
 * "invalid credentials" like any other wrong value — telling the caller their email was
 * malformed is a response that varies by cause, which is the enumeration leak we are closing.
 */
export function classifyIdentifier(raw: string): LoginIdentifier {
  const trimmed = raw.trim();
  return trimmed.includes('@')
    ? { kind: 'email', value: trimmed.toLowerCase() }
    : { kind: 'username', value: trimmed.toLowerCase() };
}

export function isValidEmail(value: string): boolean {
  return value.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(value);
}

export function isValidUsername(value: string): boolean {
  return (
    value.length >= USERNAME_MIN_LENGTH &&
    value.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(value)
  );
}

/** The local part of an email — used by the password policy, never for lookup. */
export function emailLocalPart(email: string): string {
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
}
