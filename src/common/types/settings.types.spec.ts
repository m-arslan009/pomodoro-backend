import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, type SettingsRecord, toUserSettings } from './settings.types';

/*
 * The one place the stored split is undone.
 *
 * Two responsibilities, and the second is the interesting one. Flattening columns and JSONB into
 * the single object the API returns (CONTRACT.md §2.2) is mechanical. Surviving a blob that does
 * not match the current schema is not: Zod guarantees the shape of what this process writes, but
 * not of what is already at rest. A row written before a rule changed, hand-edited, or left behind
 * by a downgrade must degrade to a default rather than serve the client a value its own published
 * types say is impossible.
 */

const UPDATED_AT = new Date('2026-07-30T09:12:44.301Z');

const PALETTE = { accent: '#8fd694', leaf: '#2f5d3a', wood: '#6b4f3a' };

function makeRecord(overrides: Partial<SettingsRecord> = {}): SettingsRecord {
  return {
    workMinutes: 30,
    breakMinutes: 10,
    theme: 'dark',
    preferences: {
      customTheme: PALETTE,
      background: 'dusk',
      labels: { work: 'Deep work', break: 'Tea' },
    },
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

/** Only the blob differs; the scalar columns are never the thing under test here. */
function withPreferences(preferences: unknown) {
  return toUserSettings(makeRecord({ preferences }));
}

describe('toUserSettings', () => {
  describe('an account with no row', () => {
    it('reads as the domain defaults rather than a 404', () => {
      // Reading does not create the row, so this is the response for most accounts most of the
      // time — an account that has changed nothing is not an error (CONTRACT.md §4.7).
      expect(toUserSettings(null)).toEqual(DEFAULT_USER_SETTINGS);
    });

    it('reports updatedAt as null, so the client can tell "never saved" from "saved"', () => {
      expect(toUserSettings(null).updatedAt).toBeNull();
    });

    it('defaults to 25/5, system, no palette, forest, and built-in labels', () => {
      // Pinned verbatim: these are mirrored in the frontend and a silent change here would
      // desynchronise the two without failing anything.
      expect(DEFAULT_USER_SETTINGS).toEqual({
        workMinutes: 25,
        breakMinutes: 5,
        theme: 'system',
        customTheme: null,
        background: 'forest',
        labels: { work: '', break: '' },
        updatedAt: null,
      });
    });
  });

  describe('a stored row', () => {
    it('flattens the columns and the blob into one object', () => {
      // The column/JSONB split exists in the database and must not reach the client, which is
      // what lets a key move between the two later without breaking the API (CONTRACT.md §1.4).
      expect(toUserSettings(makeRecord())).toEqual({
        workMinutes: 30,
        breakMinutes: 10,
        theme: 'dark',
        customTheme: PALETTE,
        background: 'dusk',
        labels: { work: 'Deep work', break: 'Tea' },
        updatedAt: '2026-07-30T09:12:44.301Z',
      });
    });

    it('serialises the timestamp as ISO 8601, not a Date', () => {
      expect(toUserSettings(makeRecord()).updatedAt).toBe('2026-07-30T09:12:44.301Z');
    });

    it('never leaks the storage shape', () => {
      // No `preferences` key, and no sign that a blob was involved. The client sees one flat
      // object or the abstraction was pointless.
      expect(toUserSettings(makeRecord())).not.toHaveProperty('preferences');
    });
  });

  describe('a theme column that no longer validates', () => {
    it('falls back to the default rather than serving an unsupported value', () => {
      expect(toUserSettings(makeRecord({ theme: 'solarized' })).theme).toBe('system');
    });

    it("migrates a stored 'light' to system on read", () => {
      // 'light' was a real value before CONTRACT.md §9.3 narrowed the enum, so rows carrying it
      // exist. This is the whole migration: no backfill, and the next save overwrites it.
      expect(toUserSettings(makeRecord({ theme: 'light' })).theme).toBe('system');
    });
  });

  describe('a preferences blob that is not an object', () => {
    it.each([
      ['null', null],
      ['an array', ['dusk']],
      ['a string', 'dusk'],
      ['a number', 7],
    ])('reads %s as no preferences at all', (_case, preferences) => {
      const settings = withPreferences(preferences);

      expect(settings).toMatchObject({
        customTheme: null,
        background: 'forest',
        labels: { work: '', break: '' },
      });
      // The columns are unaffected — a damaged blob must not cost the user their durations.
      expect(settings).toMatchObject({ workMinutes: 30, breakMinutes: 10, theme: 'dark' });
    });
  });

  describe('a palette that is not usable', () => {
    it('drops a palette missing one of its three colours', () => {
      // All three or nothing: a partial palette would leave the client guessing which CSS
      // variables it still owns.
      expect(
        withPreferences({ customTheme: { accent: '#8fd694', leaf: '#2f5d3a' } }).customTheme,
      ).toBeNull();
    });

    it('drops a palette whose colour is not a string', () => {
      expect(
        withPreferences({ customTheme: { accent: 1, leaf: '#2f5d3a', wood: '#6b4f3a' } })
          .customTheme,
      ).toBeNull();
    });

    it('drops a palette that is not an object', () => {
      expect(withPreferences({ customTheme: 'green' }).customTheme).toBeNull();
    });

    it('reads only the three keys it knows, ignoring anything else stored beside them', () => {
      expect(withPreferences({ customTheme: { ...PALETTE, bark: '#000000' } }).customTheme).toEqual(
        PALETTE,
      );
    });

    it('does not second-guess a stored colour that is not hex', () => {
      // Deliberate: the read path checks structure, not format. A value that got past the DTO is
      // returned as stored, because silently rewriting a user's saved colour would be worse than
      // rendering it and letting them fix it.
      const odd = { accent: 'rebeccapurple', leaf: '#2f5d3a', wood: '#6b4f3a' };

      expect(withPreferences({ customTheme: odd }).customTheme).toEqual(odd);
    });
  });

  describe('a background that is not usable', () => {
    it.each([
      ['an unknown preset', 'ocean'],
      ['a non-string', 3],
      ['null', null],
    ])('falls back to forest for %s', (_case, background) => {
      expect(withPreferences({ background }).background).toBe('forest');
    });

    it.each(['forest', 'dusk', 'ember', 'midnight'])('passes %s through', (background) => {
      expect(withPreferences({ background }).background).toBe(background);
    });
  });

  describe('labels that are not usable', () => {
    it('fills in only the missing side', () => {
      // Each label degrades on its own; one damaged value must not cost the user the other.
      expect(withPreferences({ labels: { work: 'Deep work' } }).labels).toEqual({
        work: 'Deep work',
        break: '',
      });
    });

    it('replaces a non-string label with the built-in default', () => {
      expect(withPreferences({ labels: { work: 42, break: 'Tea' } }).labels).toEqual({
        work: '',
        break: 'Tea',
      });
    });

    it('reads labels that are not an object as both defaults', () => {
      expect(withPreferences({ labels: 'Focus' }).labels).toEqual({ work: '', break: '' });
    });

    it('preserves an intentionally empty label', () => {
      // '' means "use the built-in label" and is a value the user can choose, so it must survive
      // the read rather than being treated as absent.
      expect(withPreferences({ labels: { work: '', break: 'Tea' } }).labels).toEqual({
        work: '',
        break: 'Tea',
      });
    });
  });
});
