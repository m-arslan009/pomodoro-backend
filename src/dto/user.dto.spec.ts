import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { updateProfileSchema } from './user.dto';

/*
 * The profile PATCH contract — the rules the frontend's services/validation.js mirrors field for
 * field, and the outer edge of what a request can change about an account.
 *
 * Two properties matter beyond the individual rules. Every field is optional, because the client
 * sends only what changed; and the set of fields is closed, so a payload naming anything else
 * changes nothing.
 */

/** The first message the schema reports for each field, which is all a form ever renders. */
function errorsOf(schema: ZodType, value: unknown): Record<string, string> {
  const result = schema.safeParse(value);
  if (result.success) return {};

  const messages: Record<string, string> = {};
  for (const issue of result.error.issues) {
    // A pathless issue is an object-level refine; the pipe files those under 'body'.
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

describe('updateProfileSchema', () => {
  it('accepts a complete update', () => {
    expect(
      updateProfileSchema.safeParse({
        firstName: 'Ada',
        lastName: 'Lovelace',
        username: 'Ada_L',
        timezone: 'Europe/London',
      }).success,
    ).toBe(true);
  });

  const singleFields: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['a first name alone', { firstName: 'Ada' }],
    ['a last name alone', { lastName: 'Lovelace' }],
    ['a username alone', { username: 'Ada_L' }],
    ['a time zone alone', { timezone: 'Asia/Karachi' }],
  ];

  it.each(singleFields)('accepts %s', (_case, value) => {
    // PATCH semantics: the page saves the diff, so a one-key body is the common case rather than
    // the exception, and nothing else may acquire a value on the way through.
    expect(parsed(updateProfileSchema, value)).toEqual(value);
  });

  it('trims what it stores', () => {
    const data = parsed(updateProfileSchema, {
      firstName: '  Ada  ',
      lastName: '  Lovelace  ',
      username: '  Ada_L  ',
      timezone: '  Europe/London  ',
    });

    expect(data).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      // Trimmed but NOT lowercased: the username is a public handle and its casing is displayed.
      // The lowercase uniqueness key is derived later, in the service.
      username: 'Ada_L',
      timezone: 'Europe/London',
    });
  });

  it('rejects an empty body, under a field name no input renders', () => {
    /*
     * Known wart, pinned rather than endorsed (CONTRACT.md §4.2). The object-level refine emits a
     * pathless issue, which ZodValidationPipe files under 'body' — a key the Profile page has no
     * input for, so the message reaches the user only through the toast. Unreachable while the
     * client guards on a dirty form; a trap for the next caller. Changing it is a contract change.
     */
    expect(errorsOf(updateProfileSchema, {})).toEqual({
      body: 'Provide at least one field to update.',
    });
  });

  it('will not change the email, whatever the payload says', () => {
    // Email is the account's only recovery channel, so moving it needs a verification round trip
    // rather than a key in this body. An unknown key is stripped, which leaves nothing to update.
    expect(errorsOf(updateProfileSchema, { email: 'someone.else@evergrove.app' })).toEqual({
      body: 'Provide at least one field to update.',
    });

    expect(
      parsed(updateProfileSchema, { firstName: 'Ada', email: 'someone.else@evergrove.app' }),
    ).toEqual({ firstName: 'Ada' });
  });

  it('will not change anything else an attacker might name', () => {
    // id, password and the avatar marker are not fields of this contract. Naming one is not an
    // error, it is simply nothing — and it must not become an update.
    expect(
      parsed(updateProfileSchema, {
        firstName: 'Ada',
        id: 'someone-elses-id',
        passwordHash: 'hashed:whatever',
        avatarUpdatedAt: '2026-07-30T10:00:00.000Z',
        emailVerified: true,
      }),
    ).toEqual({ firstName: 'Ada' });
  });

  /*
   * The messages are asserted verbatim because the frontend reproduces them locally to spare a
   * round trip — a rule that drifts here produces a form that passes and then fails at the API
   * with wording the user has already been shown.
   */
  const rejections: ReadonlyArray<[string, Record<string, unknown>, string, string]> = [
    [
      'a first name below the minimum',
      { firstName: 'A' },
      'firstName',
      'First name must be at least 2 characters.',
    ],
    [
      'a first name above the maximum',
      { firstName: 'A'.repeat(51) },
      'firstName',
      'First name must be 50 characters or fewer.',
    ],
    [
      'a first name containing digits',
      { firstName: 'Ada2' },
      'firstName',
      'First name cannot contain numbers.',
    ],
    [
      'a last name below the minimum',
      { lastName: 'L' },
      'lastName',
      'Last name must be at least 2 characters.',
    ],
    [
      'a last name containing digits',
      { lastName: 'Lovelace2' },
      'lastName',
      'Last name cannot contain numbers.',
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
      'a name that is only whitespace',
      { firstName: '   ' },
      'firstName',
      'First name must be at least 2 characters.',
    ],
  ];

  it.each(rejections)('rejects %s', (_case, value, field, message) => {
    expect(errorsOf(updateProfileSchema, value)[field]).toBe(message);
  });

  it('reports every rejected field at once rather than the first', () => {
    // The Profile page places an error under each input; one field per round trip would make
    // fixing a bad form a sequence of submissions.
    const errors = errorsOf(updateProfileSchema, {
      firstName: 'A',
      lastName: 'Lovelace2',
      username: 'ada-l',
    });

    expect(Object.keys(errors).sort()).toEqual(['firstName', 'lastName', 'username']);
  });

  describe('timezone', () => {
    it('accepts an IANA zone the runtime recognises', () => {
      expect(parsed(updateProfileSchema, { timezone: 'Asia/Karachi' }).timezone).toBe(
        'Asia/Karachi',
      );
    });

    it('rejects a zone the runtime does not recognise', () => {
      // The column is an interpretation key: every instant stored for the account is read through
      // it, so an unusable value corrupts future day-buckets rather than merely displaying oddly.
      expect(errorsOf(updateProfileSchema, { timezone: 'Mars/Olympus' })).toEqual({
        timezone: 'Unrecognised time zone.',
      });
    });

    it('rejects an oversized zone before asking the runtime about it', () => {
      expect(errorsOf(updateProfileSchema, { timezone: 'A'.repeat(200) }).timezone).toBe(
        'Time zone is too long.',
      );
    });

    it('rejects an empty zone rather than storing one', () => {
      // Clearing the zone is not an operation this contract offers; there is no "unset" value
      // that day-bucketing could interpret.
      expect(updateProfileSchema.safeParse({ timezone: '' }).success).toBe(false);
    });
  });
});
