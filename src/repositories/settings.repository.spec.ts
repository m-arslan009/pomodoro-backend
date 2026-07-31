import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service';
import { SettingsRepository } from './settings.repository';

/*
 * The only component allowed to touch the user_settings table (ADR-020).
 *
 * What these tests can and cannot reach is worth being explicit about. The upsert is one
 * hand-written statement whose *semantics* — COALESCE keeping stored scalars, `||` merging the
 * JSONB blob, ON CONFLICT making it atomic — are Postgres's behaviour, not this file's, and only a
 * real database can demonstrate them. Those belong to the e2e suite (CONTRACT.md §10.2 S2).
 *
 * What is testable here is everything around the statement, and all of it has failed in real
 * codebases: the parameters handed to the driver, the snake_case-to-camelCase mapping of the
 * returned row, and the two failure branches. In particular, an absent scalar must reach the query
 * as SQL NULL rather than `undefined` — COALESCE is what preserves the stored value, and it has
 * nothing to work with if the parameter never arrives.
 */

const UPDATED_AT = new Date('2026-07-30T09:12:44.301Z');

const PALETTE = { accent: '#8fd694', leaf: '#2f5d3a', wood: '#6b4f3a' };

/** A row exactly as Postgres returns it from the RETURNING clause. */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    work_minutes: 30,
    break_minutes: 10,
    theme: 'dark',
    preferences: { background: 'dusk' },
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

/** Prisma's foreign-key violation, as the client raises it. */
function foreignKeyViolation() {
  return Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' });
}

describe('SettingsRepository', () => {
  let queries: Array<{ sql: readonly string[]; values: unknown[] }>;
  let rows: unknown[];
  let queryError: Error | null;
  let found: unknown;
  let prisma: PrismaService;
  let repository: SettingsRepository;

  beforeEach(() => {
    queries = [];
    rows = [makeRow()];
    queryError = null;
    found = null;

    prisma = {
      userSettings: {
        findUnique: vi.fn(() => Promise.resolve(found)),
      },
      $queryRaw: vi.fn((sql: readonly string[], ...values: unknown[]) => {
        queries.push({ sql, values });
        return queryError ? Promise.reject(queryError) : Promise.resolve(rows);
      }),
    } as unknown as PrismaService;

    repository = new SettingsRepository(prisma);
  });

  describe('findByUserId', () => {
    it('constrains the read to the id it was given', async () => {
      await repository.findByUserId('user-1');

      // Ownership is a query constraint, never a check performed afterwards (ADR-010).
      expect(prisma.userSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
    });

    it('answers null when the account has never saved a preference', async () => {
      // The lazy row is what makes the migration additive; a missing row is an ordinary answer.
      await expect(repository.findByUserId('user-1')).resolves.toBeNull();
    });

    it('returns the stored row when there is one', async () => {
      found = {
        workMinutes: 30,
        breakMinutes: 10,
        theme: 'dark',
        preferences: { background: 'dusk' },
        updatedAt: UPDATED_AT,
      };

      await expect(repository.findByUserId('user-1')).resolves.toEqual(found);
    });

    it('selects only the columns the API shape needs', async () => {
      await repository.findByUserId('user-1');

      const call = vi.mocked(prisma.userSettings.findUnique).mock.calls[0]?.[0] as {
        select: Record<string, boolean>;
      };

      // Not created_at and not user_id: neither reaches the client, and selecting explicitly is
      // what stops a future column joining the payload by accident.
      expect(Object.keys(call.select).sort()).toEqual([
        'breakMinutes',
        'preferences',
        'theme',
        'updatedAt',
        'workMinutes',
      ]);
    });

    it('does not write anything', async () => {
      await repository.findByUserId('user-1');

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('upsert', () => {
    const emptyPatch = { preferences: {} };

    it('writes in a single statement', async () => {
      await repository.upsert('user-1', { workMinutes: 30, preferences: {} });

      // One statement is atomic without a transaction, an isolation level, or a retry loop. Split
      // it into a read and a write and two concurrent section saves start losing each other.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('addresses the row by the id it was given', async () => {
      await repository.upsert('user-1', emptyPatch);

      expect(queries[0]?.values[0]).toBe('user-1');
    });

    it('sends an absent scalar as null, so COALESCE can keep the stored value', async () => {
      await repository.upsert('user-1', { workMinutes: 30, preferences: {} });

      // undefined would arrive as a missing parameter rather than SQL NULL, and COALESCE would
      // have nothing to fall back from — the failure mode this assertion exists to catch.
      expect(queries[0]?.values).toContain(30);
      expect(queries[0]?.values).toContain(null);
      expect(queries[0]?.values).not.toContain(undefined);
    });

    it('sends every scalar when the request named them all', async () => {
      await repository.upsert('user-1', {
        workMinutes: 30,
        breakMinutes: 10,
        theme: 'dark',
        preferences: {},
      });

      const { values } = queries[0] ?? { values: [] };

      expect(values).toContain(30);
      expect(values).toContain(10);
      expect(values).toContain('dark');
      expect(values).not.toContain(null);
    });

    it('serialises the preferences fragment as JSON text', async () => {
      await repository.upsert('user-1', {
        preferences: { background: 'dusk', labels: { work: 'Deep work', break: 'Tea' } },
      });

      // It is cast to jsonb in the statement, so it has to travel as a string; handing the driver
      // an object would bind it as a record and the merge would fail at the database.
      expect(queries[0]?.values).toContain(
        JSON.stringify({ background: 'dusk', labels: { work: 'Deep work', break: 'Tea' } }),
      );
    });

    it('serialises an empty fragment as {}, which merges to a no-op', async () => {
      await repository.upsert('user-1', { workMinutes: 30, preferences: {} });

      expect(queries[0]?.values).toContain('{}');
    });

    it('serialises a null palette rather than dropping it', async () => {
      // JSON.stringify keeps an explicit null value, which is what makes `||` overwrite the
      // stored palette with null instead of leaving it in place.
      await repository.upsert('user-1', { preferences: { customTheme: null } });

      expect(queries[0]?.values).toContain('{"customTheme":null}');
    });

    it('serialises a palette whole', async () => {
      await repository.upsert('user-1', { preferences: { customTheme: PALETTE } });

      expect(queries[0]?.values).toContain(JSON.stringify({ customTheme: PALETTE }));
    });

    it('maps the returned row out of the database naming', async () => {
      const record = await repository.upsert('user-1', emptyPatch);

      // The snake_case boundary stops here: nothing above this layer knows the column names.
      expect(record).toEqual({
        workMinutes: 30,
        breakMinutes: 10,
        theme: 'dark',
        preferences: { background: 'dusk' },
        updatedAt: UPDATED_AT,
      });
    });

    it('returns the timestamp as a Date for the type layer to serialise', async () => {
      const record = await repository.upsert('user-1', emptyPatch);

      expect(record?.updatedAt).toBeInstanceOf(Date);
    });

    it('answers null when the account was deleted between authenticating and saving', async () => {
      // The insert has no row to reference, so Postgres refuses it. That is a vanished account,
      // not a server fault, and the service turns it into a 401.
      queryError = foreignKeyViolation();

      await expect(repository.upsert('user-1', emptyPatch)).resolves.toBeNull();
    });

    it('answers null when the statement returns nothing', async () => {
      rows = [];

      await expect(repository.upsert('user-1', emptyPatch)).resolves.toBeNull();
    });

    it('lets every other database failure through', async () => {
      // A connection drop or a constraint this code does not model must not be reported to the
      // user as "you are signed out" — it is a 500 and it belongs in the logs.
      queryError = Object.assign(new Error('connection terminated'), { code: 'P1001' });

      await expect(repository.upsert('user-1', emptyPatch)).rejects.toThrow(
        'connection terminated',
      );
    });

    it('does not mistake an error without a code for a missing account', async () => {
      queryError = new Error('something else entirely');

      await expect(repository.upsert('user-1', emptyPatch)).rejects.toThrow(
        'something else entirely',
      );
    });
  });
});
