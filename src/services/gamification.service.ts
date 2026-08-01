import { Injectable } from '@nestjs/common';
import { type GamificationSnapshot, toGamificationSnapshot } from '../common/types/session.types';
import { type GamificationState, applySession } from '../domain/gamification';
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
  constructor(private readonly sessions: SessionRepository) {}

  /** Zeroes for an account that has never recorded anything — that is not a 404. */
  async getGamification(userId: string): Promise<GamificationSnapshot> {
    return toGamificationSnapshot(await this.sessions.getGamification(userId));
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
