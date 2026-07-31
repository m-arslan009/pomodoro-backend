import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/errors/problem.exception';
import type { SettingsRecord } from '../common/types/settings.types';
import type { UpdateSettingsDto } from '../dto/settings.dto';
import type { SettingsRepository, UpdateSettingsInput } from '../repositories/settings.repository';
import { SettingsService } from './settings.service';

/*
 * Preference reads and writes for the signed-in account.
 *
 * The repository is a fake rather than a mock with expectations: what matters is the input it is
 * handed and the outcome each of its answers produces, not the call sequence used to get there.
 *
 * The service is thin by design (ADR-005), so there is exactly one decision here worth covering —
 * which keys reach the JSONB fragment. An absent key must leave the stored value untouched, which
 * is what makes a per-section save additive; an explicit `customTheme: null` must survive, because
 * null is the instruction that clears the palette.
 *
 * Ownership is absent from these tests because it is absent from the code: every method takes the
 * id the guard read off a verified token, and no route accepts one from the caller (ADR-010).
 */

const UPDATED_AT = new Date('2026-07-30T09:12:44.301Z');

const PALETTE = { accent: '#8fd694', leaf: '#2f5d3a', wood: '#6b4f3a' };

function makeRecord(overrides: Partial<SettingsRecord> = {}): SettingsRecord {
  return {
    workMinutes: 25,
    breakMinutes: 5,
    theme: 'system',
    preferences: {},
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('SettingsService', () => {
  let writes: Array<{ userId: string; input: UpdateSettingsInput }>;
  let stored: SettingsRecord | null;
  let written: SettingsRecord | null;
  let settings: SettingsRepository;
  let service: SettingsService;

  beforeEach(() => {
    writes = [];
    stored = null;
    written = makeRecord();

    settings = {
      findByUserId: vi.fn(() => Promise.resolve(stored)),
      upsert: vi.fn((userId: string, input: UpdateSettingsInput) => {
        writes.push({ userId, input });
        return Promise.resolve(written);
      }),
    } as unknown as SettingsRepository;

    service = new SettingsService(settings);
  });

  /** The fragment the one write under test carried. */
  function fragment() {
    return writes[0]?.input.preferences;
  }

  describe('getSettings', () => {
    it('reads the account the id names', async () => {
      await service.getSettings('user-1');

      expect(settings.findByUserId).toHaveBeenCalledWith('user-1');
    });

    it('answers with defaults when the account has never saved anything', async () => {
      // No row is not a 404 and not an empty response — it is the domain defaults, so the client
      // has usable values on a brand-new account (CONTRACT.md §4.7).
      const result = await service.getSettings('user-1');

      expect(result).toMatchObject({ workMinutes: 25, breakMinutes: 5, theme: 'system' });
      expect(result.updatedAt).toBeNull();
    });

    it('does not write anything on a read', async () => {
      // Reading must not create the row; a lazy row is what makes the migration purely additive.
      await service.getSettings('user-1');

      expect(settings.upsert).not.toHaveBeenCalled();
    });

    it('flattens a stored row into the API shape', async () => {
      stored = makeRecord({
        workMinutes: 45,
        preferences: { background: 'dusk', labels: { work: 'Deep work', break: 'Tea' } },
      });

      await expect(service.getSettings('user-1')).resolves.toMatchObject({
        workMinutes: 45,
        background: 'dusk',
        labels: { work: 'Deep work', break: 'Tea' },
        updatedAt: '2026-07-30T09:12:44.301Z',
      });
    });
  });

  describe('updateSettings', () => {
    it('writes against the id it was given', async () => {
      await service.updateSettings('user-1', { workMinutes: 30 });

      expect(writes[0]?.userId).toBe('user-1');
    });

    it('forwards the scalar columns as they were sent', async () => {
      await service.updateSettings('user-1', {
        workMinutes: 30,
        breakMinutes: 10,
        theme: 'dark',
      });

      expect(writes[0]?.input).toMatchObject({
        workMinutes: 30,
        breakMinutes: 10,
        theme: 'dark',
      });
    });

    it('leaves the columns the request omitted undefined', async () => {
      await service.updateSettings('user-1', { workMinutes: 30 });

      // undefined is how the repository is told "do not touch this column". Sending the current
      // value back instead would turn every PATCH into a full-row write.
      expect(writes[0]?.input).toMatchObject({
        workMinutes: 30,
        breakMinutes: undefined,
        theme: undefined,
      });
    });

    it('sends an empty fragment when only columns changed', async () => {
      await service.updateSettings('user-1', { workMinutes: 30 });

      // An empty object merges to a no-op in Postgres, so the stored appearance survives a
      // durations-only save untouched.
      expect(fragment()).toEqual({});
    });

    it('carries only the appearance keys the request actually named', async () => {
      await service.updateSettings('user-1', { background: 'dusk' });

      // The key must be *absent*, not present-and-undefined: an undefined value would serialise
      // to nothing useful in the JSONB fragment, whereas an absent key leaves the stored value
      // alone. That is what makes a per-section save additive rather than destructive.
      expect(fragment()).toEqual({ background: 'dusk' });
      expect(Object.keys(fragment() ?? {})).toEqual(['background']);
    });

    it('splits one payload across columns and blob without dropping either half', async () => {
      await service.updateSettings('user-1', {
        workMinutes: 30,
        labels: { work: 'Deep work', break: 'Tea' },
      });

      expect(writes[0]?.input).toMatchObject({ workMinutes: 30 });
      expect(fragment()).toEqual({ labels: { work: 'Deep work', break: 'Tea' } });
    });

    it('preserves a null palette, because null is the instruction to clear it', async () => {
      // The one place absence and null differ. Stripping null here would make "reset my colours"
      // silently do nothing.
      await service.updateSettings('user-1', { customTheme: null });

      expect(fragment()).toEqual({ customTheme: null });
    });

    it('sends a palette through unchanged', async () => {
      await service.updateSettings('user-1', { customTheme: PALETTE });

      expect(fragment()).toEqual({ customTheme: PALETTE });
    });

    it('carries every appearance key when a request names them all', async () => {
      await service.updateSettings('user-1', {
        customTheme: PALETTE,
        background: 'ember',
        labels: { work: 'Deep work', break: 'Tea' },
      });

      expect(fragment()).toEqual({
        customTheme: PALETTE,
        background: 'ember',
        labels: { work: 'Deep work', break: 'Tea' },
      });
    });

    it('never puts a column key into the blob', async () => {
      // The split is the service's only real job. A duration landing in `preferences` would be
      // written, returned, and then quietly ignored by every reader.
      await service.updateSettings('user-1', { workMinutes: 30, theme: 'dark' });

      expect(fragment()).not.toHaveProperty('workMinutes');
      expect(fragment()).not.toHaveProperty('theme');
    });

    it('answers with the stored row, not the values that were submitted', async () => {
      // The client replaces its state with this response, so it has to be what the database
      // actually holds — including the fields this PATCH did not touch.
      written = makeRecord({ workMinutes: 30, preferences: { background: 'dusk' } });

      await expect(service.updateSettings('user-1', { workMinutes: 30 })).resolves.toMatchObject({
        workMinutes: 30,
        breakMinutes: 5,
        background: 'dusk',
      });
    });

    it('returns the full settings object, not just what changed', async () => {
      const result = await service.updateSettings('user-1', { workMinutes: 30 });

      expect(Object.keys(result).sort()).toEqual([
        'background',
        'breakMinutes',
        'customTheme',
        'labels',
        'theme',
        'updatedAt',
        'workMinutes',
      ]);
    });

    it('refuses when the account no longer exists', async () => {
      // The row vanished between authenticating and saving. A token that named it is no longer
      // usable, so this is 401 rather than 404 — there is nobody to be not-found.
      written = null;

      const error = (await service
        .updateSettings('user-1', { workMinutes: 30 })
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error).toBeInstanceOf(ProblemException);
      expect(error.problem.status).toBe(401);
      expect(error.problem.title).toBe('Not authenticated');
    });

    it('does not read before it writes', async () => {
      // The upsert is one statement precisely so that two concurrent section saves cannot lose
      // each other; a read here would reintroduce the race it was written to avoid.
      await service.updateSettings('user-1', { workMinutes: 30 });

      expect(settings.findByUserId).not.toHaveBeenCalled();
      expect(settings.upsert).toHaveBeenCalledTimes(1);
    });

    it('applies a full update in a single write', async () => {
      const dto: UpdateSettingsDto = {
        workMinutes: 30,
        breakMinutes: 10,
        theme: 'dark',
        customTheme: PALETTE,
        background: 'ember',
        labels: { work: 'Deep work', break: 'Tea' },
      };

      await service.updateSettings('user-1', dto);

      // Atomicity is a contract requirement (CONTRACT.md §4.8): a rejected field rolls back the
      // whole PATCH, which is only true while this stays one call.
      expect(settings.upsert).toHaveBeenCalledTimes(1);
    });
  });
});
