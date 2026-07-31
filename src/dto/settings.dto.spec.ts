import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { updateSettingsSchema } from './settings.dto';

/*
 * The settings PATCH contract — the rules the frontend's services/validation.js mirrors field for
 * field (CONTRACT.md §3), and the outer edge of what a request can change about an account's
 * preferences.
 *
 * Three properties matter beyond the individual rules. Every field is optional, because the page
 * saves one section at a time; the set of fields is closed; and `customTheme: null` is a value —
 * it clears the palette override — rather than an omission.
 */

/** The first message the schema reports for each field, which is all a form ever renders. */
function errorsOf(schema: ZodType, value: unknown): Record<string, string> {
  const result = schema.safeParse(value);
  if (result.success) return {};

  const messages: Record<string, string> = {};
  for (const issue of result.error.issues) {
    // A pathless issue is an object-level refine or an unknown key; the pipe files those under
    // 'body'.
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

describe('updateSettingsSchema', () => {
  it('accepts a complete update', () => {
    expect(
      updateSettingsSchema.safeParse({
        workMinutes: 30,
        breakMinutes: 10,
        theme: 'dark',
        customTheme: { accent: '#8fd694', leaf: '#2f5d3a', wood: '#6b4f3a' },
        background: 'dusk',
        labels: { work: 'Deep work', break: 'Tea' },
      }).success,
    ).toBe(true);
  });

  const singleFields: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['a focus length alone', { workMinutes: 30 }],
    ['a break length alone', { breakMinutes: 10 }],
    ['a base theme alone', { theme: 'dark' }],
    ['a palette alone', { customTheme: { accent: '#8fd694', leaf: '#2f5d3a', wood: '#6b4f3a' } }],
    ['a background alone', { background: 'ember' }],
    ['labels alone', { labels: { work: 'Deep work', break: 'Tea' } }],
  ];

  it.each(singleFields)('accepts %s', (_case, value) => {
    // PATCH semantics: the page saves per section, so a one-key body is the common case rather
    // than the exception, and nothing else may acquire a value on the way through.
    expect(parsed(updateSettingsSchema, value)).toEqual(value);
  });

  it('rejects an empty body, under a field name no input renders', () => {
    /*
     * The same known wart as PATCH /me (CONTRACT.md §4.8): the object-level refine emits a
     * pathless issue, which ZodValidationPipe files under 'body' — a key the Settings page has no
     * input for, so the message reaches the user only through the toast. Unreachable while the
     * client guards on a dirty form. Changing it is a contract change.
     */
    expect(errorsOf(updateSettingsSchema, {})).toEqual({
      body: 'Provide at least one setting to update.',
    });
  });

  it('treats an explicit undefined as no update at all', () => {
    // JSON cannot carry undefined, but a hand-built client object can. "Present but undefined"
    // must not satisfy the at-least-one-key rule, or a PATCH that changes nothing would succeed.
    expect(errorsOf(updateSettingsSchema, { workMinutes: undefined })).toEqual({
      body: 'Provide at least one setting to update.',
    });
  });

  it('refuses a payload naming anything outside the contract', () => {
    /*
     * Deliberately stricter than updateProfileSchema, which strips an unknown key and carries on.
     * Here the body is rejected outright, so a client sending a field this API does not have is
     * told so rather than watching a save silently do nothing.
     *
     * The consequence is worth stating: a valid field travelling alongside an unknown one is NOT
     * applied. The whole PATCH fails, which is the atomicity CONTRACT.md §4.8 requires.
     */
    expect(errorsOf(updateSettingsSchema, { workMinutes: 30, schedule: { mon: true } })).toEqual({
      body: 'Unrecognized key: "schedule"',
    });
  });

  it('will not change anything an attacker might name', () => {
    // There is no user id, no row id, and no updatedAt in this contract. Naming one is refused
    // rather than ignored, so it can never become part of a write.
    expect(errorsOf(updateSettingsSchema, { theme: 'dark', userId: 'someone-elses-id' }).body).toBe(
      'Unrecognized key: "userId"',
    );
  });

  /*
   * The messages are asserted verbatim because the frontend reproduces them locally to spare a
   * round trip — a rule that drifts here produces a form that passes and then fails at the API
   * with wording the user has already been shown.
   */
  const rejections: ReadonlyArray<[string, Record<string, unknown>, string, string]> = [
    [
      'a fractional focus length',
      { workMinutes: 25.5 },
      'workMinutes',
      'Focus session must be a whole number of minutes.',
    ],
    [
      'a focus length below the minimum',
      { workMinutes: 0 },
      'workMinutes',
      'Focus session must be between 1 and 120 minutes.',
    ],
    [
      'a focus length above the maximum',
      { workMinutes: 121 },
      'workMinutes',
      'Focus session must be between 1 and 120 minutes.',
    ],
    [
      'a negative focus length',
      { workMinutes: -5 },
      'workMinutes',
      'Focus session must be between 1 and 120 minutes.',
    ],
    [
      'a break below the minimum',
      { breakMinutes: 0 },
      'breakMinutes',
      'Short break must be between 1 and 60 minutes.',
    ],
    [
      'a break above the maximum',
      { breakMinutes: 61 },
      'breakMinutes',
      'Short break must be between 1 and 60 minutes.',
    ],
    [
      'a fractional break',
      { breakMinutes: 5.5 },
      'breakMinutes',
      'Short break must be a whole number of minutes.',
    ],
    [
      'a duration sent as a string',
      { workMinutes: '30' },
      'workMinutes',
      'Invalid input: expected number, received string',
    ],
    ['an unsupported theme', { theme: 'solarized' }, 'theme', 'Choose a supported theme.'],
    [
      'an unsupported background',
      { background: 'ocean' },
      'background',
      'Choose a supported background.',
    ],
    [
      'a colour that is not six-digit hex',
      { customTheme: { accent: 'red', leaf: '#2f5d3a', wood: '#6b4f3a' } },
      'customTheme.accent',
      'Use a six-digit hex colour.',
    ],
    [
      'a three-digit hex shorthand',
      { customTheme: { accent: '#fff', leaf: '#2f5d3a', wood: '#6b4f3a' } },
      'customTheme.accent',
      'Use a six-digit hex colour.',
    ],
    [
      'a label over the maximum',
      { labels: { work: 'a'.repeat(19), break: '' } },
      'labels.work',
      'Labels must be 18 characters or fewer.',
    ],
  ];

  it.each(rejections)('rejects %s', (_case, value, field, message) => {
    expect(errorsOf(updateSettingsSchema, value)[field]).toBe(message);
  });

  it('reports every rejected field at once rather than the first', () => {
    // The Settings page places an error under each input; one field per round trip would make
    // fixing a bad form a sequence of submissions.
    const errors = errorsOf(updateSettingsSchema, {
      workMinutes: 999,
      breakMinutes: 0,
      theme: 'solarized',
    });

    expect(Object.keys(errors).sort()).toEqual(['breakMinutes', 'theme', 'workMinutes']);
  });

  describe('durations at the boundary', () => {
    // The limits are inclusive on both sides; an off-by-one here silently narrows what the app
    // offers, which no error message would reveal.
    const accepted: ReadonlyArray<[string, Record<string, number>]> = [
      ['the shortest focus block', { workMinutes: 1 }],
      ['the longest focus block', { workMinutes: 120 }],
      ['the shortest break', { breakMinutes: 1 }],
      ['the longest break', { breakMinutes: 60 }],
    ];

    it.each(accepted)('accepts %s', (_case, value) => {
      expect(parsed(updateSettingsSchema, value)).toEqual(value);
    });
  });

  describe('theme', () => {
    it.each(['system', 'dark'])('accepts %s', (theme) => {
      expect(parsed(updateSettingsSchema, { theme }).theme).toBe(theme);
    });

    it('rejects light, which the enum no longer carries', () => {
      // CONTRACT.md §9.3: applyBaseTheme set an attribute no stylesheet read, so the option
      // claimed a capability the app did not have. Re-adding it later widens the enum additively.
      expect(errorsOf(updateSettingsSchema, { theme: 'light' })).toEqual({
        theme: 'Choose a supported theme.',
      });
    });
  });

  describe('background', () => {
    it.each(['forest', 'dusk', 'ember', 'midnight'])('accepts %s', (background) => {
      expect(parsed(updateSettingsSchema, { background }).background).toBe(background);
    });
  });

  describe('customTheme', () => {
    it('accepts null, which clears the override', () => {
      // Nullable rather than optional-only: absence means "leave the palette alone", null means
      // "go back to the stylesheet". They are different instructions and both must be sendable.
      expect(parsed(updateSettingsSchema, { customTheme: null })).toEqual({ customTheme: null });
    });

    it('accepts uppercase hex', () => {
      const palette = { accent: '#8FD694', leaf: '#2F5D3A', wood: '#6B4F3A' };

      expect(parsed(updateSettingsSchema, { customTheme: palette }).customTheme).toEqual(palette);
    });

    it('requires all three colours, not a partial palette', () => {
      // A partial palette would leave the client guessing which CSS variables it still owns.
      const errors = errorsOf(updateSettingsSchema, { customTheme: { accent: '#8fd694' } });

      expect(Object.keys(errors).sort()).toEqual(['customTheme.leaf', 'customTheme.wood']);
    });

    it('refuses a colour key it does not recognise', () => {
      // The failure mode this guards: a typo'd colour name that validated and then did nothing.
      expect(
        errorsOf(updateSettingsSchema, {
          customTheme: { accent: '#8fd694', leaf: '#2f5d3a', wood: '#6b4f3a', bark: '#000000' },
        }).customTheme,
      ).toBe('Unrecognized key: "bark"');
    });
  });

  describe('labels', () => {
    it('trims what it stores', () => {
      // Trimmed at the boundary so everything downstream receives the canonical value.
      expect(
        parsed(updateSettingsSchema, { labels: { work: '  Deep work  ', break: '  Tea  ' } })
          .labels,
      ).toEqual({ work: 'Deep work', break: 'Tea' });
    });

    it('measures the length after trimming, not before', () => {
      // Surrounding whitespace the user cannot see must not cost them characters they can.
      const padded = { work: `  ${'a'.repeat(18)}  `, break: '' };

      expect(parsed(updateSettingsSchema, { labels: padded }).labels?.work).toBe('a'.repeat(18));
    });

    it('accepts a label of exactly the maximum length', () => {
      expect(
        parsed(updateSettingsSchema, { labels: { work: 'a'.repeat(18), break: '' } }).labels?.work,
      ).toBe('a'.repeat(18));
    });

    it('accepts empty labels, which mean "use the built-in ones"', () => {
      // Blank is a value here rather than a gap, so clearing a custom label is an ordinary save.
      expect(parsed(updateSettingsSchema, { labels: { work: '', break: '' } }).labels).toEqual({
        work: '',
        break: '',
      });
    });

    it('requires both labels to travel together', () => {
      // The object is replaced whole, never merged key-by-key, so a one-sided payload would
      // silently blank the other phase's label.
      expect(errorsOf(updateSettingsSchema, { labels: { work: 'Focus' } })['labels.break']).toBe(
        'Invalid input: expected string, received undefined',
      );
    });

    it('refuses a label key it does not recognise', () => {
      expect(
        errorsOf(updateSettingsSchema, { labels: { work: '', break: '', longBreak: 'Rest' } })
          .labels,
      ).toBe('Unrecognized key: "longBreak"');
    });
  });
});
