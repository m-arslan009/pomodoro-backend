import type { GamificationState } from '../../domain/gamification';
import type { SessionStatus, SessionType, TerminationReason } from '../../domain/session';

/*
 * Plain shapes that cross layer boundaries — see task.types.ts for the reasoning.
 */

/** A session row as the repository returns it. */
export interface SessionRecord {
  readonly id: string;
  readonly taskId: string | null;
  readonly taskTitleSnapshot: string;
  readonly clientSessionId: string;
  readonly type: string;
  readonly status: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly plannedDurationMs: number;
  readonly actualDurationMs: number;
  readonly terminationReason: string | null;
  readonly pointsAwarded: number;
  /**
   * The user-local day this record counts toward, as 'YYYY-MM-DD'. Internal: it is decided once at
   * insert and replayed verbatim by a rebuild, and the client has no use for it.
   */
  readonly attributionDate: string;
}

/**
 * The canonical session record (CONTRACT.md §14.1) — what POST returns, what GET returns, what the
 * client stores, and what History aggregates. One shape everywhere, because two would guarantee a
 * mapping bug at the seam between them.
 *
 * `clientSessionId` leads because it, not `id`, is the client's primary key: it exists from the
 * moment a block starts, survives sync, and is the idempotency key. `syncState` is the client's own
 * field and is deliberately absent here — the server has no opinion on it.
 */
export interface Session {
  readonly clientSessionId: string;
  readonly id: string;
  readonly taskId: string | null;
  /** The title as the user saw it while focusing. Survives renaming and deleting the task. */
  readonly taskTitle: string;
  readonly type: SessionType;
  readonly status: SessionStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly plannedDurationMs: number;
  /** Server-clamped. May be lower than the client reported (ADR-012). */
  readonly actualDurationMs: number;
  readonly terminationReason: TerminationReason | null;
  readonly pointsAwarded: number;
}

export function toSession(record: SessionRecord): Session {
  return {
    clientSessionId: record.clientSessionId,
    id: record.id,
    taskId: record.taskId,
    taskTitle: record.taskTitleSnapshot,
    type: record.type as SessionType,
    status: record.status as SessionStatus,
    startedAt: record.startedAt.toISOString(),
    endedAt: record.endedAt.toISOString(),
    plannedDurationMs: record.plannedDurationMs,
    actualDurationMs: record.actualDurationMs,
    terminationReason: record.terminationReason as TerminationReason | null,
    pointsAwarded: record.pointsAwarded,
  };
}

/**
 * The progression object returned alongside every recorded session, and by `GET /gamification`.
 *
 * It carries the whole projection rather than a delta so the client can replace its copy outright:
 * a client that patched its own totals would be computing, and the client computes nothing.
 */
export interface GamificationSnapshot {
  readonly balance: number;
  readonly lifetimePoints: number;
  readonly currentDayStreak: number;
  readonly longestDayStreak: number;
  readonly currentSessionRun: number;
  readonly streakFreezesAvailable: number;
  /**
   * Freezes this request spent to cover a missed day, so a "your streak was saved" notice fires
   * exactly once — the same role `newlyUnlocked` plays for titles.
   *
   * ZERO ON A READ, and deliberately so. `GET /gamification` resolves elapsed days for display
   * without persisting them (§14.6), so it re-derives the same pending spend on every poll;
   * announcing it each time would report one covered day over and over. The spend is announced by
   * the request that makes it real — the recorded session that writes it down.
   */
  readonly streakFreezesSpent: number;
  /** Points this request awarded. Zero on a read, and on anything that scores nothing. */
  readonly pointsDelta: number;
  readonly unlockedTitles: readonly string[];
  /** Titles crossed by THIS request, so a celebration fires exactly once. */
  readonly newlyUnlocked: readonly string[];
}

export function toGamificationSnapshot(
  state: GamificationState,
  pointsDelta = 0,
  newlyUnlocked: readonly string[] = [],
  streakFreezesSpent = 0,
): GamificationSnapshot {
  return {
    balance: state.balance,
    lifetimePoints: state.lifetimePoints,
    currentDayStreak: state.currentDayStreak,
    longestDayStreak: state.longestDayStreak,
    currentSessionRun: state.currentSessionRun,
    streakFreezesAvailable: state.streakFreezesAvailable,
    streakFreezesSpent,
    pointsDelta,
    unlockedTitles: state.unlockedTitles,
    newlyUnlocked,
  };
}
