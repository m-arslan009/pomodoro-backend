import { Injectable } from '@nestjs/common';
import { Clock } from '../common/ports/clock.port';
import { type GamificationSnapshot, toGamificationSnapshot } from '../common/types/session.types';
import {
  type GamificationState,
  applySession,
  localDateKey,
  resolveElapsedDays,
} from '../domain/gamification';
import { SessionRepository } from '../repositories/session.repository';

/**
 * Reading progression, and rebuilding it from the event log.
 *
 * `user_gamification` is a projection, not a source of truth (ADR-006): every value in it is
 * derivable by folding `focus_sessions` in order through the same domain function that produced it
 * live. `rebuild` is that fold, and it ships with the feature rather than after it — a projection
 * nobody can rebuild is a source of truth wearing a cache's clothes, and the first time it drifts
 * there is no way back.
 *
 * Rebuilding is exact because each session stores the day it was attributed to. Nothing here reads
 * the users table, consults a timezone, or depends on when the rebuild is run.
 */
@Injectable()
export class GamificationService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * The projection as of today. Zeroes for an account that has never recorded anything — that is
   * not a 404.
   *
   * RESOLVED FOR DISPLAY, NOT PERSISTED (ADR-014, CONTRACT.md §14.6). The stored row is only ever
   * as current as the last session recorded, so a streak that lapsed yesterday is still sitting in
   * the database at its old value. Reporting that number would be reporting a streak the user no
   * longer has — and, worse, one they would watch reset the moment they next recorded a session,
   * which reads as the app taking something away.
   *
   * So the read projects the stored state forward through the days that have elapsed, spending a
   * freeze if exactly one day was missed, and returns that. Nothing is written back: `today`
   * depends on when the request arrived, and a projection whose contents depend on when it was
   * last read is no longer rebuildable from the event log (ADR-006). The next recorded session
   * performs the same resolution from the same stored state and persists THAT, because it resolves
   * to the session's attribution date instead of to the wall clock.
   */
  async getGamification(userId: string, timeZone: string): Promise<GamificationSnapshot> {
    const stored = await this.sessions.getGamification(userId);
    const today = localDateKey(this.clock.now(), timeZone);
    return toGamificationSnapshot(resolveElapsedDays(stored, today));
  }

  /** Recompute one account's projection from its log and overwrite the stored row. */
  async rebuild(userId: string): Promise<GamificationState> {
    return this.sessions.rebuild(userId, (state, session) => {
      const { state: next } = applySession(state, {
        type: session.type,
        status: session.status,
        attributionDate: session.attributionDate,
      });
      return next;
    });
  }

  /** Every account with at least one recorded session. */
  async listRebuildableUsers(): Promise<string[]> {
    return this.sessions.listUserIdsWithSessions();
  }
}
