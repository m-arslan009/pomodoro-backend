import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  checkPassword,
  describePasswordViolation,
} from './password-policy';

describe('password policy', () => {
  it('accepts a long passphrase with no digits or symbols', () => {
    // The point of the length-first rule: this is stronger than "Focus25!" and used to fail.
    expect(checkPassword('correct horse battery staple')).toBeNull();
  });

  it('rejects anything below the minimum length', () => {
    expect(checkPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('too_short');
    expect(checkPassword('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });

  it('rejects anything above the maximum length', () => {
    // The cap bounds Argon2 CPU per request and dodges bcrypt's silent 72-byte truncation.
    expect(checkPassword('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe('too_long');
    expect(checkPassword('a'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });

  it('rejects a password containing the username or the email local part', () => {
    expect(checkPassword('my_ada_l_password', { username: 'ada_l' })).toBe('contains_identifier');
    expect(checkPassword('ADA_L_is_my_secret', { username: 'ada_l' })).toBe('contains_identifier');
    expect(checkPassword('ada-not-really-here', { email: 'ada@evergrove.app' })).toBe(
      'contains_identifier',
    );
  });

  it('ignores identifier fragments too short to be meaningful', () => {
    // A two-letter username would otherwise ban most English passwords.
    expect(checkPassword('absolutely fine', { username: 'ab' })).toBeNull();
  });

  it('describes every violation with user-facing wording', () => {
    expect(describePasswordViolation('too_short')).toContain(String(PASSWORD_MIN_LENGTH));
    expect(describePasswordViolation('too_long')).toContain(String(PASSWORD_MAX_LENGTH));
    expect(describePasswordViolation('contains_identifier')).toMatch(/username or email/i);
  });
});
