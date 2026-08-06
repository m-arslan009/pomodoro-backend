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

  /*
   * The per-field rules themselves — lengths, formats, character sets — are not enumerated here.
   * They are ordinary field validation, and the two that carry real weight live where they are
   * enforced: the password bounds in `domain/password-policy.spec.ts`, and uniqueness at the
   * database, in `services/auth.service.spec.ts`. What the schema owes the sign-up form is this
   * one behaviour.
   */
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
  const VALID_LOGIN = { identifier: 'ada@evergrove.app', password: 'correct horse battery' };

  /*
   * The security property of this schema is what it does NOT do. Each of these values is
   * unregistrable, and every one must still be accepted here so that it fails later as
   * "invalid credentials" — identical to a wrong password. Rejecting any of them would answer a
   * question about the account namespace to a caller who has proved nothing.
   */
  it('deliberately accepts values that could never have been registered', () => {
    const unregistrable: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['an identifier that is not a valid email', { identifier: 'not-an-email' }],
      ['an identifier that is not a valid username', { identifier: 'ada l!' }],
      ['a password far below the registration minimum', { password: 'x' }],
      ['a password that would fail the policy', { password: 'ada_l' }],
    ];

    const refusedHere = unregistrable
      .filter(([, overrides]) => !loginSchema.safeParse({ ...VALID_LOGIN, ...overrides }).success)
      .map(([label]) => label);

    // Named rather than asserted as four booleans: each shape is a separate enumeration channel,
    // so a failure has to say which one started being answered early.
    expect(refusedHere).toEqual([]);
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

  it('refuses an oversized identifier or password before they can be spent inside Argon2', () => {
    /*
     * The one ceiling the schema does enforce, and it is a cost control rather than a validation
     * rule: an unbounded password is CPU the server burns hashing something it was always going
     * to reject. Presence is also enforced, and is deliberately not tested here — an empty field
     * is a form concern, and it reveals nothing either way.
     */
    expect(errorsOf(loginSchema, { ...VALID_LOGIN, identifier: 'a'.repeat(321) }).identifier).toBe(
      'That identifier is too long.',
    );

    expect(
      errorsOf(loginSchema, { ...VALID_LOGIN, password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) })
        .password,
    ).toBe('Password is too long.');
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
