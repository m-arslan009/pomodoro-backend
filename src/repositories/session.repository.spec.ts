import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '../common/utils/cursor';
import type { PrismaService } from '../database/prisma.service';
import {
  type AppliedSession,
  type GamificationState,
  emptyGamification,
} from '../domain/gamification';
import { SessionRepository, type PersistSessionInput } from './session.repository';

/*
 * The only component allowed to touch focus_sessions and user_gamification.
 *
 * ONE REPOSITORY FOR TWO TABLES, against the usual one-table-one-component rule, because they are a
 * single transactional unit: the projection is updated inside the session insert's transaction
 * (ADR-006). Splitting them would push the transaction boundary up into the service and force the
 * ORM's transaction client through a service signature — precisely the leak the layering prevents.
 *
 * WHAT THESE TESTS CAN REACH. Whether Postgres actually serialises two concurrent flushes is
 * Postgres's business and belongs to the e2e suite. What is testable here — and what has failed in
 * real codebases — is the SEQUENCE: that the replay check precedes the overlap check, that the
 * projection is locked before it is read, that the score comes from the injected fold rather than
 * from anything here, and that each of the three constraint violations is turned into the right
 * outcome rather than escaping as a 500.
 */

const NOW = new Date('2026-01-15T09:00:00.000Z');
const MINUTE = 60 * 1000;

function makeRow(overrides: Record<string, unknown> = {}) {
  const startedAt = new Date(NOW.getTime() - 30 * MINUTE);
  return {
    id: '018f0000-0000-7000-8000-00000000aaaa',
    taskId: '018f0000-0000-7000-8000-00000000bbbb',
    taskTitleSnapshot: 'Thesis chapter 3',
    clientSessionId: '018f0000-0000-7000-8000-00000000cccc',
    type: 'focus',
    status: 'completed',
    startedAt,
    endedAt: new Date(startedAt.getTime() + 25 * MINUTE),
    plannedDurationMs: 25 * MINUTE,
    actualDurationMs: 25 * MINUTE,
    terminationReason: null,
    pointsAwarded: 100,
    // `@db.Date` round-trips as UTC midnight.
    attributionDate: new Date('2026-01-15T00:00:00.000Z'),
    ...overrides,
  };
}

function makeGamificationRow(overrides: Record<string, unknown> = {}) {
  return {
    balance: 100,
    lifetimePoints: 100,
    currentDayStreak: 1,
    longestDayStreak: 1,
    currentSessionRun: 1,
    lastActiveDate: new Date('2026-01-15T00:00:00.000Z'),
    streakFreezesAvailable: 1,
    unlockedTitles: ['anchor'],
    ...overrides,
  };
}

function input(overrides: Partial<PersistSessionInput> = {}): PersistSessionInput {
  const startedAt = new Date(NOW.getTime() - 30 * MINUTE);
  return {
    userId: 'user-1',
    clientSessionId: '018f0000-0000-7000-8000-00000000cccc',
    taskId: '018f0000-0000-7000-8000-00000000bbbb',
    taskTitle: 'Thesis chapter 3',
    type: 'focus',
    status: 'completed',
    startedAt,
    endedAt: new Date(startedAt.getTime() + 25 * MINUTE),
    plannedDurationMs: 25 * MINUTE,
    actualDurationMs: 25 * MINUTE,
    terminationReason: null,
    attributionDate: '2026-01-15',
    ...overrides,
  };
}

/** A fold that awards a fixed amount, so the outcome can be traced back to the injected function. */
const advance = (state: GamificationState): AppliedSession => ({
  state: { ...state, balance: state.balance + 100, lifetimePoints: state.lifetimePoints + 100 },
  pointsAwarded: 100,
  newlyUnlocked: ['anchor'],
});

/** Prisma's unique-constraint violation, carrying the offending constraint name in `meta`. */
function uniqueViolation(constraint: string) {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: constraint },
  });
}

function foreignKeyViolation() {
  return Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' });
}

/**
 * The query object as it reaches the driver. Every field is declared present so assertions can read
 * through it without optional chaining; the ones a given call does not carry are simply not read.
 */
interface CapturedArgs {
  where: Record<string, any>;
  data: Record<string, any>;
  create: Record<string, any>;
  update: Record<string, any>;
  select: Record<string, unknown>;
  orderBy: unknown;
  take: number;
  distinct: readonly string[];
}

const capture = (args: unknown) => args as CapturedArgs;

describe('SessionRepository', () => {
  /** Every call the transaction made, in order — the sequence is the thing under test. */
  let calls: string[];

  let findManyArgs: CapturedArgs[];
  let findFirstArgs: CapturedArgs[];
  let createArgs: CapturedArgs[];
  let updateArgs: CapturedArgs[];
  let upsertArgs: CapturedArgs[];
  let rawStatements: string[];

  let rows: unknown[];
  /**
   * Successive `findMany` results, for the paging tests.
   *
   * `rebuild` pages until a batch comes back shorter than the batch size, so a double that returns
   * the same full batch forever never terminates — the loop is correct and the fixture is what has
   * to advance. Null means "not paging": every call answers with `rows`.
   */
  let batches: unknown[][] | null;
  let existingSession: unknown;
  let overlappingSession: unknown;
  let gamificationRow: unknown;
  let transactionError: Error | null;
  let createError: Error | null;

  let prisma: PrismaService;
  let repository: SessionRepository;

  beforeEach(() => {
    calls = [];
    findManyArgs = [];
    findFirstArgs = [];
    createArgs = [];
    updateArgs = [];
    upsertArgs = [];
    rawStatements = [];

    rows = [makeRow()];
    batches = null;
    existingSession = null;
    overlappingSession = null;
    gamificationRow = null;
    transactionError = null;
    createError = null;

    const focusSession = {
      findUnique: vi.fn(() => {
        calls.push('findUnique:session');
        return Promise.resolve(existingSession);
      }),
      findFirst: vi.fn((args: unknown) => {
        calls.push('findFirst:overlap');
        findFirstArgs.push(capture(args));
        return Promise.resolve(overlappingSession);
      }),
      findMany: vi.fn((args: unknown) => {
        findManyArgs.push(capture(args));
        if (batches) return Promise.resolve(batches.shift() ?? []);
        return Promise.resolve(rows);
      }),
      create: vi.fn((args: unknown) => {
        calls.push('create:session');
        createArgs.push(capture(args));
        return createError ? Promise.reject(createError) : Promise.resolve(makeRow());
      }),
    };

    const userGamification = {
      findUnique: vi.fn(() => {
        calls.push('findUnique:gamification');
        return Promise.resolve(gamificationRow);
      }),
      update: vi.fn((args: unknown) => {
        calls.push('update:gamification');
        updateArgs.push(capture(args));
        return Promise.resolve(makeGamificationRow());
      }),
      upsert: vi.fn((args: unknown) => {
        calls.push('upsert:gamification');
        upsertArgs.push(capture(args));
        return Promise.resolve(makeGamificationRow());
      }),
    };

    prisma = {
      focusSession,
      userGamification,
      $executeRaw: vi.fn((sql: readonly string[]) => {
        calls.push('lock:gamification');
        rawStatements.push(sql.join('?'));
        return Promise.resolve(1);
      }),
      $transaction: vi.fn((run: (tx: unknown) => Promise<unknown>) => {
        if (transactionError) return Promise.reject(transactionError);
        return run(prisma);
      }),
    } as unknown as PrismaService;

    repository = new SessionRepository(prisma);
  });

  describe('findByClientSessionId', () => {
    it('looks the record up by the account and the client’s own key together', async () => {
      // The composite unique is what makes two users' client ids independent of each other.
      existingSession = makeRow();

      await repository.findByClientSessionId('user-1', 'client-1');

      expect(prisma.focusSession.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_clientSessionId: { userId: 'user-1', clientSessionId: 'client-1' } },
        }),
      );
    });

    it('narrows the stored date column to a calendar key', async () => {
      // `@db.Date` round-trips as a UTC-midnight Date; everything above this layer wants
      // 'YYYY-MM-DD', because that is what the fold compares.
      existingSession = makeRow();

      const record = await repository.findByClientSessionId('user-1', 'client-1');

      expect(record?.attributionDate).toBe('2026-01-15');
    });

    it('answers null when there is no such record', async () => {
      await expect(repository.findByClientSessionId('user-1', 'client-1')).resolves.toBeNull();
    });
  });

  describe('list', () => {
    it('constrains the read to the owning account', async () => {
      await repository.list('user-1', { from: NOW, limit: 50 });

      expect(findManyArgs[0].where).toMatchObject({ userId: 'user-1' });
    });

    it('applies the lower bound of the window', async () => {
      await repository.list('user-1', { from: NOW, limit: 50 });

      expect(findManyArgs[0].where.startedAt).toMatchObject({ gte: NOW });
    });

    it('applies an upper bound only when one was given', async () => {
      const to = new Date('2026-01-31T00:00:00.000Z');

      await repository.list('user-1', { from: NOW, limit: 50 });
      expect(findManyArgs[0].where.startedAt).toEqual({ gte: NOW });

      await repository.list('user-1', { from: NOW, to, limit: 50 });
      expect(findManyArgs[1].where.startedAt).toEqual({ gte: NOW, lte: to });
    });

    it('reads newest first, with the id breaking ties', async () => {
      await repository.list('user-1', { from: NOW, limit: 50 });

      expect(findManyArgs[0].orderBy).toEqual([{ startedAt: 'desc' }, { id: 'desc' }]);
    });

    it('over-fetches by exactly one row', async () => {
      await repository.list('user-1', { from: NOW, limit: 50 });

      expect(findManyArgs[0].take).toBe(51);
    });

    it('turns a cursor into a keyset predicate', async () => {
      const cursor = encodeCursor(NOW, 'session-9');

      await repository.list('user-1', { from: NOW, cursor, limit: 50 });

      expect(findManyArgs[0].where.OR).toEqual([
        { startedAt: { lt: NOW } },
        { startedAt: NOW, id: { lt: 'session-9' } },
      ]);
    });

    it('maps every row’s date column', async () => {
      rows = [makeRow(), makeRow({ id: 'session-2' })];

      const result = await repository.list('user-1', { from: NOW, limit: 50 });

      expect(result.sessions.map((session) => session.attributionDate)).toEqual([
        '2026-01-15',
        '2026-01-15',
      ]);
    });

    it('answers with an empty page rather than failing', async () => {
      rows = [];

      await expect(repository.list('user-1', { from: NOW, limit: 50 })).resolves.toEqual({
        sessions: [],
        nextCursor: null,
      });
    });
  });

  describe('getGamification', () => {
    it('answers with a zeroed projection when the account has no row', async () => {
      /*
       * No row is not a 404 and not an error — it is a brand-new account. The row is created lazily
       * by the first recording, which is what keeps the migration purely additive.
       */
      await expect(repository.getGamification('user-1')).resolves.toEqual(emptyGamification());
    });

    it('maps a stored row onto plain values', async () => {
      // No ORM type escapes the repository (ADR-004), and the date column becomes a calendar key.
      gamificationRow = makeGamificationRow();

      await expect(repository.getGamification('user-1')).resolves.toEqual({
        balance: 100,
        lifetimePoints: 100,
        currentDayStreak: 1,
        longestDayStreak: 1,
        currentSessionRun: 1,
        lastActiveDate: '2026-01-15',
        streakFreezesAvailable: 1,
        unlockedTitles: ['anchor'],
      });
    });

    it('carries a null marker through as null', async () => {
      gamificationRow = makeGamificationRow({ lastActiveDate: null });

      const state = await repository.getGamification('user-1');

      expect(state.lastActiveDate).toBeNull();
    });
  });

  describe('record — the ordinary path', () => {
    it('runs everything inside one transaction', async () => {
      /*
       * The insert and the projection update are one unit. Outside a transaction, a crash between
       * them would leave points awarded for a session that does not exist — or a session that
       * scored nothing — and the projection would silently stop matching its own log.
       */
      await repository.record(input(), advance);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('checks for a replay, then an overlap, then locks, then scores and writes', async () => {
      // The order is the design. Asserting it here is what stops a later edit from, say, scoring
      // before taking the lock.
      await repository.record(input(), advance);

      expect(calls).toEqual([
        'findUnique:session',
        'findFirst:overlap',
        'lock:gamification',
        'findUnique:gamification',
        'create:session',
        'update:gamification',
      ]);
    });

    it('creates the projection row if absent and locks it either way', async () => {
      /*
       * Two outbox flushes arriving together must not both read a session run of 4 and both write
       * 5. The upsert-and-lock is what serialises them, and it has to happen BEFORE the read.
       */
      await repository.record(input(), advance);

      expect(rawStatements[0]).toContain('INSERT INTO user_gamification');
      expect(rawStatements[0]).toContain('ON CONFLICT (user_id) DO UPDATE');
      expect(calls.indexOf('lock:gamification')).toBeLessThan(
        calls.indexOf('findUnique:gamification'),
      );
    });

    it('stores what it was given, without re-deciding any of it', async () => {
      // The duration is already clamped and the day already attributed. A repository that
      // recomputed either would be a second authority on both.
      await repository.record(input({ actualDurationMs: 1_499_000 }), advance);

      expect(createArgs[0].data).toMatchObject({
        userId: 'user-1',
        taskTitleSnapshot: 'Thesis chapter 3',
        actualDurationMs: 1_499_000,
        attributionDate: new Date('2026-01-15T00:00:00.000Z'),
      });
    });

    it('takes the score from the injected fold', async () => {
      /*
       * `advance` is a parameter precisely so this method can own locking and persistence while the
       * economy stays in src/domain — and so the fold stored here is the same one `rebuild` replays.
       */
      const result = await repository.record(input(), advance);

      expect(createArgs[0].data.pointsAwarded).toBe(100);
      expect(result).toMatchObject({
        kind: 'created',
        pointsAwarded: 100,
        newlyUnlocked: ['anchor'],
      });
    });

    it('writes the folded projection back', async () => {
      await repository.record(input(), advance);

      expect(updateArgs[0].where).toEqual({ userId: 'user-1' });
      expect(updateArgs[0].data).toMatchObject({ balance: 100, lifetimePoints: 100 });
    });

    it('converts the calendar key back into a date for storage', async () => {
      gamificationRow = makeGamificationRow();

      await repository.record(input(), (state) => ({
        state: { ...state, lastActiveDate: '2026-01-16' },
        pointsAwarded: 100,
        newlyUnlocked: [],
      }));

      expect(updateArgs[0].data.lastActiveDate).toEqual(new Date('2026-01-16T00:00:00.000Z'));
    });
  });

  describe('record — a replay', () => {
    it('returns the original record without writing anything', async () => {
      /*
       * THE OUTBOX CONTRACT, at its source. The same client session id resolves to the same row,
       * and that is success — so nothing is inserted and, critically, nothing is scored a second
       * time.
       */
      existingSession = makeRow();

      const result = await repository.record(input(), advance);

      expect(result.kind).toBe('replayed');
      expect(prisma.focusSession.create).not.toHaveBeenCalled();
      expect(prisma.userGamification.update).not.toHaveBeenCalled();
    });

    it('answers before it even looks for an overlap', async () => {
      // A replayed record necessarily overlaps itself. Checking overlap first would turn every
      // retry into a rejection.
      existingSession = makeRow();

      await repository.record(input(), advance);

      expect(calls).not.toContain('findFirst:overlap');
    });

    it('reports the current totals alongside it', async () => {
      // The client still adopts the response, so a retry must leave it holding correct numbers.
      existingSession = makeRow();
      gamificationRow = makeGamificationRow();

      const result = await repository.record(input(), advance);

      expect(result).toMatchObject({ kind: 'replayed', state: { lifetimePoints: 100 } });
    });
  });

  describe('record — an overlap', () => {
    it('refuses a record covering an instant already claimed', async () => {
      overlappingSession = { id: 'other-session' };

      const result = await repository.record(input(), advance);

      expect(result.kind).toBe('overlap');
      expect(prisma.focusSession.create).not.toHaveBeenCalled();
    });

    it('compares half-open, so an adjacent break is not an overlap', async () => {
      /*
       * A break starting exactly when a focus block ended is the NORMAL case, not an error. A
       * closed comparison here would reject the product's own core rhythm.
       */
      await repository.record(input(), advance);

      expect(findFirstArgs[0].where.startedAt).toEqual({ lt: input().endedAt });
      expect(findFirstArgs[0].where.endedAt).toEqual({ gt: input().startedAt });
    });

    it('searches only this account’s log', async () => {
      await repository.record(input(), advance);

      expect(findFirstArgs[0].where.userId).toBe('user-1');
    });
  });

  describe('record — races and broken links', () => {
    it('re-records unlinked when the task was deleted mid-flight', async () => {
      /*
       * The task went away between resolving it and inserting. The session is still real work and
       * must not be lost over a broken link — recording it unlinked is exactly what would have
       * happened had the delete landed a moment earlier.
       */
      let attempt = 0;
      transactionError = null;
      prisma.$transaction = vi.fn((run: (tx: unknown) => Promise<unknown>) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(foreignKeyViolation());
        return run(prisma);
      }) as unknown as PrismaService['$transaction'];

      const result = await repository.record(input(), advance);

      expect(result.kind).toBe('created');
      expect(createArgs[0].data.taskId).toBeNull();
      expect(createArgs[0].data.taskTitleSnapshot).toBe('Thesis chapter 3');
    });

    it('retries the unlinked write exactly once', async () => {
      // Bounded by `allowTaskRetry`. Unbounded, a persistent foreign-key failure would recurse
      // until the stack gave out.
      transactionError = foreignKeyViolation();

      await expect(repository.record(input(), advance)).rejects.toThrow(
        'Foreign key constraint violated',
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('does not retry when there was no task to lose', async () => {
      transactionError = foreignKeyViolation();

      await expect(repository.record(input({ taskId: null }), advance)).rejects.toThrow();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('reports a genuine clash on the same instant as a conflict', async () => {
      // Two devices both insisting they ran a block at 09:14:02 — a different session, not a retry.
      transactionError = uniqueViolation('focus_sessions_user_id_started_at_key');

      await expect(repository.record(input(), advance)).resolves.toEqual({ kind: 'conflict' });
    });

    it('treats a lost race on the same client id as a replay', async () => {
      /*
       * A concurrent flush of the SAME record won. Its transaction committed the row this one was
       * about to write, so re-reading is the correct answer and the caller sees success — which is
       * what keeps a double-flush from surfacing to the user as an error.
       */
      transactionError = uniqueViolation('focus_sessions_user_id_client_session_id_key');
      existingSession = makeRow();

      const result = await repository.record(input(), advance);

      expect(result.kind).toBe('replayed');
    });

    it('rethrows a unique violation it cannot account for', async () => {
      // Guessing at an unknown constraint would report success for a write that did not happen.
      transactionError = uniqueViolation('some_other_unique_index');

      await expect(repository.record(input(), advance)).rejects.toThrow();
    });

    it('rethrows anything that is not a constraint violation', async () => {
      transactionError = Object.assign(new Error('connection lost'), { code: 'P1001' });

      await expect(repository.record(input(), advance)).rejects.toThrow('connection lost');
    });
  });

  describe('rebuild', () => {
    const fold = (state: GamificationState): GamificationState => ({
      ...state,
      lifetimePoints: state.lifetimePoints + 100,
    });

    it('replays the log in the order it happened', async () => {
      /*
       * ASCENDING, and that is not a detail: the fold is order-sensitive because the day streak
       * depends on the sequence of days. Replaying newest-first would produce a different and wrong
       * answer.
       */
      await repository.rebuild('user-1', fold);

      expect(findManyArgs[0].orderBy).toEqual([{ startedAt: 'asc' }, { id: 'asc' }]);
    });

    it('scopes the replay to one account', async () => {
      await repository.rebuild('user-1', fold);

      expect(findManyArgs[0].where).toMatchObject({ userId: 'user-1' });
    });

    it('folds every row it read', async () => {
      rows = [makeRow(), makeRow({ id: 'session-2' }), makeRow({ id: 'session-3' })];

      const state = await repository.rebuild('user-1', fold);

      expect(state.lifetimePoints).toBe(300);
    });

    it('starts from an empty projection, not from what is stored', async () => {
      // The point of a rebuild is to discard the stored row. Seeding from it would fold the drift
      // back in and call it repaired.
      gamificationRow = makeGamificationRow({ lifetimePoints: 99_999 });
      rows = [];

      const state = await repository.rebuild('user-1', fold);

      expect(state).toEqual(emptyGamification());
    });

    it('streams in batches rather than loading a whole history', async () => {
      // A heavy account should not have to fit in memory to be repaired. A FULL batch means there
      // may be more, so it pages on; the second batch here is empty and ends the scan.
      batches = [[makeRow({ id: 'session-1' }), makeRow({ id: 'session-2' })], []];

      const state = await repository.rebuild('user-1', fold, 2);

      expect(findManyArgs).toHaveLength(2);
      // It pages with a keyset predicate built from the last row of the previous batch, never an
      // offset — the same reason the read paths use cursors.
      expect(findManyArgs[1].where.OR).toBeDefined();
      // Both rows of the first batch were folded, and neither was folded twice.
      expect(state.lifetimePoints).toBe(200);
    });

    it('stops as soon as a batch comes back short', async () => {
      rows = [makeRow()];

      await repository.rebuild('user-1', fold, 500);

      expect(findManyArgs).toHaveLength(1);
    });

    it('stops on an empty log without writing a partial fold', async () => {
      rows = [];

      await repository.rebuild('user-1', fold);

      expect(findManyArgs).toHaveLength(1);
    });

    it('overwrites the stored projection with what it derived', async () => {
      rows = [makeRow()];

      await repository.rebuild('user-1', fold);

      expect(upsertArgs[0]).toMatchObject({ where: { userId: 'user-1' } });
      expect(upsertArgs[0].update).toMatchObject({ lifetimePoints: 100 });
    });

    it('creates the row when the account never had one', async () => {
      // Upsert rather than update: an account whose projection was lost entirely is exactly the
      // case a rebuild exists to fix.
      rows = [makeRow()];

      await repository.rebuild('user-1', fold);

      expect(upsertArgs[0].create).toMatchObject({ userId: 'user-1', lifetimePoints: 100 });
    });

    it('does not reset the streak freezes it did not derive', async () => {
      // They are granted out of band, so an update that rewrote them would quietly confiscate one.
      rows = [makeRow()];

      await repository.rebuild('user-1', fold);

      expect(upsertArgs[0].update).not.toHaveProperty('streakFreezesAvailable');
    });
  });

  describe('listUserIdsWithSessions', () => {
    it('asks for one row per account', async () => {
      rows = [{ userId: 'user-1' }, { userId: 'user-2' }];

      await expect(repository.listUserIdsWithSessions()).resolves.toEqual(['user-1', 'user-2']);
      expect(findManyArgs[0]).toMatchObject({ distinct: ['userId'], select: { userId: true } });
    });

    it('orders deterministically, so a batch rebuild is resumable', async () => {
      rows = [];

      await repository.listUserIdsWithSessions();

      expect(findManyArgs[0].orderBy).toEqual({ userId: 'asc' });
    });
  });
});
