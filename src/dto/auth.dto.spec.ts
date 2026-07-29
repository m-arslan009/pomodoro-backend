import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../domain/password-policy';
import { changePasswordSchema, loginSchema, registerSchema } from './auth.dto';

/*
 * The request contracts — the API's outermost boundary, and the rules the frontend's
 * services/validation.js mirrors field for field.
 *
 * Two things are asserted here that are asserted nowhere else. First, normalisation: what these
 * schemas emit is what reaches the database, so trimming and lowercasing are behaviour, not
 * tidiness. Second — and this is the one worth guarding — how little `loginSchema` validates.
 * Every rule added to it is a question the server answers *before* checking the credential, and
 * "is this shape even registrable?" is exactly the account-enumeration channel ADR-008 closes.
 */

const VALID_REGISTER = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@evergrove.app',
  username: 'Ada_L',
  password: 'correct horse battery',
};

/** The first message a schema reports for each field, which is all a form ever renders. */
function errorsOf(schema: ZodType, value: unknown): Record<string, string> {
  const result = schema.safeParse(value);
  if (result.success) return {};

  const messages: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.map(String).join('.') || 'body';
    messages[field] ??= issue.message;
  }
  return messages;
}

function parsed<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`expected a valid value, got: ${JSON.stringify(errorsOf(schema, value))}`);
  }
  return result.data;
}

describe('registerSchema', () => {
  it('accepts a complete registration', () => {
    expect(registerSchema.safeParse(VALID_REGISTER).success).toBe(true);
  });

  it('normalises the identifiers it stores', () => {
    const data = parsed(registerSchema, {
      ...VALID_REGISTER,
      firstName: '  Ada  ',
      lastName: '  Lovelace  ',
      email: '  ADA@Evergrove.APP  ',
      username: '  Ada_L  ',
    });

    expect(data.firstName).toBe('Ada');
    expect(data.lastName).toBe('Lovelace');
    // Lowercased because it is the uniqueness key; a CHECK constraint enforces the same at rest.
    expect(data.email).toBe('ada@evergrove.app');
    // Trimmed but NOT lowercased: the username is a public handle and its casing is displayed.
    // The lowercase uniqueness key is derived later, in the service.
    expect(data.username).toBe('Ada_L');
  });

  it('leaves the password exactly as it was typed', () => {
    const password = '  leading and trailing  ';
    const data = parsed(registerSchema, { ...VALID_REGISTER, password });

    // Trimming here would silently register a different credential than the one the user chose,
    // and every later sign-in would have to repeat the same trim to match.
    expect(data.password).toBe(password);
  });

  it('treats the timezone as optional', () => {
    expect(parsed(registerSchema, VALID_REGISTER).timezone).toBeUndefined();
    expect(parsed(registerSchema, { ...VALID_REGISTER, timezone: 'Europe/London' }).timezone).toBe(
      'Europe/London',
    );
  });

  it('rejects a timezone the runtime does not recognise', () => {
    // The column is an interpretation key: every instant stored for the account is read through
    // it, so an unusable value corrupts future day-buckets rather than merely displaying oddly.
    expect(errorsOf(registerSchema, { ...VALID_REGISTER, timezone: 'Mars/Olympus' })).toEqual({
      timezone: 'Unrecognised time zone.',
    });
  });

  /*
   * One row per rule the sign-up form mirrors. The messages are asserted verbatim because the
   * frontend reproduces them locally to spare a round trip — a rule that drifts here produces a
   * form that passes and then fails at the API with wording the user has already been shown.
   */
  const rejections: ReadonlyArray<[string, Record<string, unknown>, string, string]> = [
    [
      'a name below the minimum',
      { firstName: 'A' },
      'firstName',
      'First name must be at least 2 characters.',
    ],
    [
      'a name above the maximum',
      { firstName: 'A'.repeat(51) },
      'firstName',
      'First name must be 50 characters or fewer.',
    ],
    [
      'a name containing digits',
      { lastName: 'Lovelace2' },
      'lastName',
      'Last name cannot contain numbers.',
    ],
    ['a malformed email', { email: 'not-an-email' }, 'email', 'Enter a valid email address.'],
    [
      'an email above the maximum',
      { email: `${'a'.repeat(310)}@evergrove.app` },
      'email',
      'Email is too long.',
    ],
    [
      'a username below the minimum',
      { username: 'ad' },
      'username',
      'Username must be at least 3 characters.',
    ],
    [
      'a username above the maximum',
      { username: 'a'.repeat(21) },
      'username',
      'Username must be 20 characters or fewer.',
    ],
    [
      'a username with unsupported characters',
      { username: 'ada-l' },
      'username',
      'Use only letters, numbers, and underscores.',
    ],
    [
      'a password below the minimum',
      { password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) },
      'password',
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    ],
    [
      'a password above the maximum',
      { password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) },
      'password',
      `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`,
    ],
  ];

  it.each(rejections)('rejects %s', (_case, overrides, field, message) => {
    expect(errorsOf(registerSchema, { ...VALID_REGISTER, ...overrides })[field]).toBe(message);
  });

  it('reports every rejected field at once rather than the first', () => {
    // The sign-up form places an error under each input; one field per round trip would make
    // fixing a bad form a sequence of submissions.
    const errors = errorsOf(registerSchema, {
      firstName: 'A',
      lastName: 'Lovelace2',
      email: 'not-an-email',
      username: 'ada-l',
      password: 'short',
    });

    expect(Object.keys(errors).sort()).toEqual([
      'email',
      'firstName',
      'lastName',
      'password',
      'username',
    ]);
  });
});

describe('loginSchema', () => {
  /*
   * The security property of this schema is what it does NOT do. Each of these values is
   * unregistrable, and every one must still be accepted here so that it fails later as
   * "invalid credentials" — identical to a wrong password. Rejecting any of them would answer a
   * question about the account namespace to a caller who has proved nothing.
   */
  const permitted: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['an identifier that is not a valid email', { identifier: 'not-an-email' }],
    ['an identifier that is not a valid username', { identifier: 'ada l!' }],
    ['a password far below the registration minimum', { password: 'x' }],
    ['a password that would fail the policy', { password: 'ada_l' }],
  ];

  it.each(permitted)('deliberately accepts %s', (_case, overrides) => {
    const value = {
      identifier: 'ada@evergrove.app',
      password: 'correct horse battery',
      ...overrides,
    };

    expect(loginSchema.safeParse(value).success).toBe(true);
  });

  it('trims the identifier without changing its case', () => {
    const data = parsed(loginSchema, {
      identifier: '  ADA@Evergrove.APP  ',
      password: 'correct horse battery',
    });

    // Casing is settled later by classifyIdentifier, which knows which column it addresses.
    expect(data.identifier).toBe('ADA@Evergrove.APP');
  });

  it('leaves the password untouched', () => {
    const password = '  spaces are significant  ';

    expect(parsed(loginSchema, { identifier: 'ada@evergrove.app', password }).password).toBe(
      password,
    );
  });

  /*
   * The only rules it does enforce: presence, so the client can distinguish "I submitted an
   * empty form" from "your credentials are wrong"; and an upper bound, so an oversized body
   * cannot be spent inside Argon2.
   */
  const refused: ReadonlyArray<[string, Record<string, unknown>, string, string]> = [
    ['an empty identifier', { identifier: '   ' }, 'identifier', 'Enter your email or username.'],
    ['an empty password', { password: '' }, 'password', 'Enter your password.'],
    [
      'an oversized identifier',
      { identifier: 'a'.repeat(321) },
      'identifier',
      'That identifier is too long.',
    ],
    [
      'an oversized password',
      { password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) },
      'password',
      'Password is too long.',
    ],
  ];

  it.each(refused)('rejects %s', (_case, overrides, field, message) => {
    const value = {
      identifier: 'ada@evergrove.app',
      password: 'correct horse battery',
      ...overrides,
    };

    expect(errorsOf(loginSchema, value)[field]).toBe(message);
  });

  it('rejects a body missing both fields', () => {
    expect(Object.keys(errorsOf(loginSchema, {})).sort()).toEqual(['identifier', 'password']);
  });
});

describe('changePasswordSchema', () => {
  const VALID = {
    currentPassword: 'correct horse battery',
    newPassword: 'an entirely different one',
  };

  it('accepts a current password and a policy-compliant new one', () => {
    expect(changePasswordSchema.safeParse(VALID).success).toBe(true);
  });

  it('holds the current password to presence only', () => {
    // It is checked against the stored hash, not against the policy — an account created before
    // a policy change must still be able to escape it.
    expect(changePasswordSchema.safeParse({ ...VALID, currentPassword: 'x' }).success).toBe(true);
  });

  const refused: ReadonlyArray<[string, Record<string, unknown>, string, string]> = [
    [
      'a missing current password',
      { currentPassword: '' },
      'currentPassword',
      'Enter your current password.',
    ],
    [
      'a new password below the minimum',
      { newPassword: 'short' },
      'newPassword',
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    ],
    [
      'a new password above the maximum',
      { newPassword: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) },
      'newPassword',
      `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`,
    ],
  ];

  it.each(refused)('rejects %s', (_case, overrides, field, message) => {
    expect(errorsOf(changePasswordSchema, { ...VALID, ...overrides })[field]).toBe(message);
  });

  it('does not check the new password against the account identifiers', () => {
    // It cannot: the body carries no username or email. That rule belongs to AuthService, which
    // reads the account first — and its own spec covers it.
    expect(
      changePasswordSchema.safeParse({ ...VALID, newPassword: 'my ada_l password' }).success,
    ).toBe(true);
  });
});
