import { emailLocalPart } from './identifier';

/*
 * Password policy — length-first, per the approved refinement.
 *
 * Composition rules (one letter, one digit, one symbol) push users toward predictable
 * substitutions without adding meaningful entropy, so they are gone. Length carries the
 * strength instead.
 *
 * The maximum is not cosmetic. It bounds the CPU an unauthenticated request can spend inside
 * Argon2, and ADR-008 names bcrypt as the fallback hasher — bcrypt silently truncates at 72
 * bytes, which would make a very long passphrase weaker than it appears.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** The shortest identifier fragment worth refusing inside a password. */
const MIN_FRAGMENT_LENGTH = 3;

export type PasswordViolation = 'too_short' | 'too_long' | 'contains_identifier';

/** Wording is shared with the frontend so a user sees one message, not two variants. */
export const PASSWORD_VIOLATION_MESSAGES: Record<PasswordViolation, string> = {
  too_short: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  too_long: `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`,
  contains_identifier: 'Password must not contain your username or email address.',
};

export interface PasswordIdentifiers {
  readonly username?: string;
  readonly email?: string;
}

function containsFragment(password: string, fragment: string | undefined): boolean {
  if (!fragment) return false;
  const normalized = fragment.trim().toLowerCase();
  if (normalized.length < MIN_FRAGMENT_LENGTH) return false;
  return password.toLowerCase().includes(normalized);
}

/**
 * The single authority on whether a password may be accepted. Returns the first violation, or
 * null when the password is acceptable.
 *
 * Identifier containment is checked here rather than in a DTO because on the change-password
 * path the username and email are not in the request body — only the service knows them.
 */
export function checkPassword(
  password: string,
  identifiers: PasswordIdentifiers = {},
): PasswordViolation | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';

  if (containsFragment(password, identifiers.username)) return 'contains_identifier';
  if (identifiers.email && containsFragment(password, emailLocalPart(identifiers.email))) {
    return 'contains_identifier';
  }

  return null;
}

export function describePasswordViolation(violation: PasswordViolation): string {
  return PASSWORD_VIOLATION_MESSAGES[violation];
}
