/*
 * Timezone validation. `users.timezone` is an interpretation key, not a preference: every
 * instant stored for an account is read through it, so an unusable value would corrupt every
 * future day-bucket rather than merely displaying oddly.
 */

export const DEFAULT_TIMEZONE = 'UTC';
export const TIMEZONE_MAX_LENGTH = 64;

/**
 * True when the runtime recognises the value as an IANA zone. Asking Intl is more accurate and
 * more durable than a hand-maintained list, which would go stale as zones change.
 */
export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > TIMEZONE_MAX_LENGTH) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
