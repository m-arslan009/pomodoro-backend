import { Injectable } from '@nestjs/common';
import type { SessionRecord } from '../common/types/session.types';
import { decodeCursor, paginate } from '../common/utils/cursor';
import { PrismaService } from '../database/prisma.service';
import {
  type AppliedSession,
  type GamificationState,
  emptyGamification,
} from '../domain/gamification';
import type { SessionStatus, SessionType, TerminationReason } from '../domain/session';

/*
 * The only component allowed to touch focus_sessions and user_gamification.
 *
 * WHY ONE REPOSITORY FOR TWO TABLES, against the usual one-table-one-component rule: they are a
 * single transactional unit. The projection is updated inside the session insert's transaction
 * (ADR-006), so splitting them would push the transaction boundary up into the service and force
 * the ORM's transaction client through a service signature — which is precisely the ORM leak the
 * layering exists to prevent. `user_gamification` is not independently writable by design: the only
 * things that may change it are recording a session and rebuilding from the log, both of which
 * live here.
 *
 * Ownership is a query constraint throughout, never a check afterwards (ADR-010).
 */

export interface PersistSessionInput {
  readonly userId: string;
  readonly clientSessionId: string;
  readonly taskId: string | null;
  readonly taskTitle: string;
  readonly type: SessionType;
  readonly status: SessionStatus;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly plannedDurationMs: number;
  /** Already clamped by the domain. The repository stores what it is given. */
  readonly actualDurationMs: number;
  readonly terminationReason: TerminationReason | null;
  /** Decided by the domain from the user's timezone, then stored so replay never recomputes it. */
  readonly attributionDate: string;
}

export type RecordOutcome =
  | {
      readonly kind: 'created';
      readonly session: SessionRecord;
      readonly state: GamificationState;
      readonly pointsAwarded: number;
      readonly newlyUnlocked: readonly string[];
      /** Freezes this record spent covering a missed day, so the response announces it once. */
      readonly freezesSpent: number;
    }
  /** This exact record was already stored. A retried outbox flush is success, not an error. */
  | {
      readonly kind: 'replayed';
      readonly session: SessionRecord;
      readonly state: GamificationState;
    }
  /** A different session already occupies that instant — a double-tap, or two devices. */
  | { readonly kind: 'conflict' }
  /** The interval overlaps one already recorded. */
  | { readonly kind: 'overlap' };

export interface ListSessionsOptions {
  readonly from: Date;
  readonly to?: Date;
  readonly cursor?: string;
  readonly limit: number;
}

const SESSION_FIELDS = {
  id: true,
  taskId: true,
  taskTitleSnapshot: true,
  clientSessionId: true,
  type: true,
  status: true,
  startedAt: true,
  endedAt: true,
  plannedDurationMs: true,
  actualDurationMs: true,
  terminationReason: true,
  pointsAwarded: true,
  attributionDate: true,
} as const;

/** The shape `SESSION_FIELDS` selects, before the date column is narrowed to a calendar key. */
type SessionRow = Omit<SessionRecord, 'attributionDate'> & { attributionDate: Date };

function toRecord(row: SessionRow): SessionRecord {
  return { ...row, attributionDate: row.attributionDate.toISOString().slice(0, 10) };
}

/** A Prisma error carrying a Postgres constraint name somewhere in its metadata. */
function violates(error: unknown, fragment: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  if (error.code !== 'P2002' && error.code !== 'P2010') return false;
  return JSON.stringify('meta' in error ? error.meta : {}).includes(fragment);
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2003';
}

/** `@db.Date` round-trips as UTC midnight, so the calendar key is the leading 10 characters. */
function toDateKey(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function fromDateKey(key: string | null): Date | null {
  return key ? new Date(`${key}T00:00:00.000Z`) : null;
}

@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------------------------------------ Reads -- */

  async findByClientSessionId(
    userId: string,
    clientSessionId: string,
  ): Promise<SessionRecord | null> {
    const row = await this.prisma.focusSession.findUnique({
      where: { userId_clientSessionId: { userId, clientSessionId } },
      select: SESSION_FIELDS,
    });
    return row ? toRecord(row) : null;
  }

  /** A page of sessions, newest first. The hydration read. */
  async list(
    userId: string,
    options: ListSessionsOptions,
  ): Promise<{ sessions: SessionRecord[]; nextCursor: string | null }> {
    const cursor = decodeCursor(options.cursor);

    const rows = await this.prisma.focusSession.findMany({
      where: {
        userId,
        startedAt: {
          gte: options.from,
          ...(options.to ? { lte: options.to } : {}),
          ...(cursor ? { lte: cursor.timestamp } : {}),
        },
        ...(cursor
          ? {
              OR: [
                { startedAt: { lt: cursor.timestamp } },
                { startedAt: cursor.timestamp, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      select: SESSION_FIELDS,
    });

    const { items, nextCursor } = paginate(rows, options.limit, (row) => ({
      timestamp: row.startedAt,
      id: row.id,
    }));

    return { sessions: items.map(toRecord), nextCursor };
  }

  /** The projection, or a zeroed one when the account has never recorded anything. */
  async getGamification(userId: string): Promise<GamificationState> {
    const row = await this.prisma.userGamification.findUnique({ where: { userId } });
    if (!row) return emptyGamification();

    return {
      balance: row.balance,
      lifetimePoints: row.lifetimePoints,
      currentDayStreak: row.currentDayStreak,
      longestDayStreak: row.longestDayStreak,
      currentSessionRun: row.currentSessionRun,
      lastActiveDate: toDateKey(row.lastActiveDate),
      streakFreezesAvailable: row.streakFreezesAvailable,
      lastFreezeGrantedOn: toDateKey(row.lastFreezeGrantedOn),
      unlockedTitles: row.unlockedTitles,
    };
  }

  /* ------------------------------------------------------------ Write -- */

  /**
   * Record a session and advance the projection, atomically.
   *
   * `advance` is the pure scoring fold supplied by the service. Keeping it a parameter is what lets
   * this method own locking and persistence while the economy stays in src/domain, testable without
   * a database — and it is the same function `rebuild` replays, so the two cannot diverge.
   *
   * The sequence inside one transaction:
   *   1. replay check — the same client id resolves to the same row, and is success
   *   2. overlap check — no two intervals for one user may cover the same instant
   *   3. upsert-and-LOCK the projection row, so concurrent flushes serialise
   *   4. score, from the locked state
   *   5. insert the immutable record
   *   6. write the projection back
   */
  async record(
    input: PersistSessionInput,
    advance: (state: GamificationState) => AppliedSession,
    allowTaskRetry = true,
  ): Promise<RecordOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.focusSession.findUnique({
          where: {
            userId_clientSessionId: {
              userId: input.userId,
              clientSessionId: input.clientSessionId,
            },
          },
          select: SESSION_FIELDS,
        });

        if (existing) {
          const state = await this.readGamificationWithin(tx, input.userId);
          return { kind: 'replayed', session: toRecord(existing), state } as const;
        }

        const overlapping = await tx.focusSession.findFirst({
          // Half-open comparison, so a break starting exactly when a block ended is adjacent
          // rather than overlapping — which is the normal case, not an error.
          where: {
            userId: input.userId,
            startedAt: { lt: input.endedAt },
            endedAt: { gt: input.startedAt },
          },
          select: { id: true },
        });

        if (overlapping) return { kind: 'overlap' } as const;

        /*
         * Create the projection row if absent and take a row lock on it either way. Two outbox
         * flushes arriving together must not both read a session run of 4 and both write 5.
         */
        await tx.$executeRaw`
          INSERT INTO user_gamification (user_id, updated_at)
          VALUES (${input.userId}::uuid, now())
          ON CONFLICT (user_id) DO UPDATE SET updated_at = user_gamification.updated_at
        `;

        const current = await this.readGamificationWithin(tx, input.userId);
        const applied = advance(current);

        const session = await tx.focusSession.create({
          data: {
            userId: input.userId,
            taskId: input.taskId,
            taskTitleSnapshot: input.taskTitle,
            clientSessionId: input.clientSessionId,
            type: input.type,
            status: input.status,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            plannedDurationMs: input.plannedDurationMs,
            actualDurationMs: input.actualDurationMs,
            terminationReason: input.terminationReason,
            pointsAwarded: applied.pointsAwarded,
            attributionDate: new Date(`${input.attributionDate}T00:00:00.000Z`),
          },
          select: SESSION_FIELDS,
        });

        await tx.userGamification.update({
          where: { userId: input.userId },
          data: {
            balance: applied.state.balance,
            lifetimePoints: applied.state.lifetimePoints,
            currentDayStreak: applied.state.currentDayStreak,
            longestDayStreak: applied.state.longestDayStreak,
            currentSessionRun: applied.state.currentSessionRun,
            lastActiveDate: fromDateKey(applied.state.lastActiveDate),
            /*
             * The fold derives these now (CONTRACT.md §14.6): a completion may spend a freeze to
             * cover a missed day and may earn one back by reaching a multiple of seven. Leaving
             * them out — as this write did while the feature was display-only — would let a spend
             * be announced in the response and then silently refunded on the next read.
             */
            streakFreezesAvailable: applied.state.streakFreezesAvailable,
            lastFreezeGrantedOn: fromDateKey(applied.state.lastFreezeGrantedOn),
            unlockedTitles: [...applied.state.unlockedTitles],
          },
        });

        return {
          kind: 'created',
          session: toRecord(session),
          state: applied.state,
          pointsAwarded: applied.pointsAwarded,
          newlyUnlocked: applied.newlyUnlocked,
          freezesSpent: applied.freezesSpent,
        } as const;
      });
    } catch (error) {
      /*
       * The task was deleted between resolving it and inserting. The session is still real work
       * and must not be lost over a broken link, so record it unlinked — exactly what would have
       * happened had the delete landed a moment earlier.
       */
      if (isForeignKeyViolation(error) && input.taskId && allowTaskRetry) {
        return this.record({ ...input, taskId: null }, advance, false);
      }

      // Two devices claimed the same instant. A genuine conflict, unlike a replay.
      if (violates(error, 'started_at')) return { kind: 'conflict' };

      /*
       * A concurrent flush of the SAME record won the race. Its transaction committed the row we
       * were about to write, so re-reading is the correct answer and the caller sees success.
       */
      if (violates(error, 'client_session_id')) {
        const session = await this.findByClientSessionId(input.userId, input.clientSessionId);
        if (session) {
          return { kind: 'replayed', session, state: await this.getGamification(input.userId) };
        }
      }

      throw error;
    }
  }

  /* ---------------------------------------------------------- Rebuild -- */

  /**
   * Replay the entire event log for one account and overwrite the projection.
   *
   * The projection's whole justification is that it is derivable (ADR-006). This is the proof, and
   * it is shipped rather than promised: a projection nobody can rebuild is a source of truth
   * wearing a cache's clothes.
   *
   * Streams in batches so a heavy account does not load its whole history into memory.
   */
  async rebuild(
    userId: string,
    advance: (state: GamificationState, session: SessionRecord) => GamificationState,
    batchSize = 500,
  ): Promise<GamificationState> {
    let state = emptyGamification();
    let after: { startedAt: Date; id: string } | null = null;

    for (;;) {
      const rows: SessionRow[] = await this.prisma.focusSession.findMany({
        where: {
          userId,
          ...(after
            ? {
                OR: [
                  { startedAt: { gt: after.startedAt } },
                  { startedAt: after.startedAt, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        // Ascending: a fold over an event log is only meaningful in the order it happened.
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        take: batchSize,
        select: SESSION_FIELDS,
      });

      if (rows.length === 0) break;

      for (const row of rows) state = advance(state, toRecord(row));

      const last = rows.at(-1);
      if (!last || rows.length < batchSize) break;
      after = { startedAt: last.startedAt, id: last.id };
    }

    await this.prisma.userGamification.upsert({
      where: { userId },
      create: {
        userId,
        balance: state.balance,
        lifetimePoints: state.lifetimePoints,
        currentDayStreak: state.currentDayStreak,
        longestDayStreak: state.longestDayStreak,
        currentSessionRun: state.currentSessionRun,
        lastActiveDate: fromDateKey(state.lastActiveDate),
        streakFreezesAvailable: state.streakFreezesAvailable,
        lastFreezeGrantedOn: fromDateKey(state.lastFreezeGrantedOn),
        unlockedTitles: [...state.unlockedTitles],
      },
      /*
       * The update writes the freeze fields too, REVERSING the rule that held while the feature was
       * display-only. Back then the count was granted out of band, so rewriting it here would have
       * confiscated one; now the fold derives every spend and every grant from the event stream, so
       * a rebuild that skipped them would leave a count contradicting the streak it just replayed —
       * which is precisely the drift ADR-006 says a rebuild exists to remove.
       */
      update: {
        balance: state.balance,
        lifetimePoints: state.lifetimePoints,
        currentDayStreak: state.currentDayStreak,
        longestDayStreak: state.longestDayStreak,
        currentSessionRun: state.currentSessionRun,
        lastActiveDate: fromDateKey(state.lastActiveDate),
        streakFreezesAvailable: state.streakFreezesAvailable,
        lastFreezeGrantedOn: fromDateKey(state.lastFreezeGrantedOn),
        unlockedTitles: [...state.unlockedTitles],
      },
    });

    return state;
  }

  /** Every account that has a projection or any recorded session. Used by the rebuild command. */
  async listUserIdsWithSessions(): Promise<string[]> {
    const rows = await this.prisma.focusSession.findMany({
      distinct: ['userId'],
      select: { userId: true },
      orderBy: { userId: 'asc' },
    });
    return rows.map((row) => row.userId);
  }

  /** Reads the projection through a transaction client, so it sees the lock this tx holds. */
  private async readGamificationWithin(
    tx: Pick<PrismaService, 'userGamification'>,
    userId: string,
  ): Promise<GamificationState> {
    const row = await tx.userGamification.findUnique({ where: { userId } });
    if (!row) return emptyGamification();

    return {
      balance: row.balance,
      lifetimePoints: row.lifetimePoints,
      currentDayStreak: row.currentDayStreak,
      longestDayStreak: row.longestDayStreak,
      currentSessionRun: row.currentSessionRun,
      lastActiveDate: toDateKey(row.lastActiveDate),
      streakFreezesAvailable: row.streakFreezesAvailable,
      lastFreezeGrantedOn: toDateKey(row.lastFreezeGrantedOn),
      unlockedTitles: row.unlockedTitles,
    };
  }
}
