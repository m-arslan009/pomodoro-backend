import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GamificationSnapshot, Session } from '../common/types/session.types';
import type { AuthContext, UserProfile } from '../common/types/user.types';
import type { RecordSessionDto } from '../dto/session.dto';
import type { SessionService } from '../services/session.service';
import { SessionController } from './session.controller';

/*
 * The `/sessions` routes (CONTRACT.md §16.5, §16.6).
 *
 * There are two things here that only a controller test can pin down.
 *
 * THE STATUS CODE IS THE OUTBOX CONTRACT. 201 when the record is new, 200 when this exact
 * `clientSessionId` was already stored. A retried flush is SUCCESS — answering 409 would make a
 * client treat its own retry as an error and, worse, teach it to stop retrying.
 *
 * THE TIMEZONE COMES FROM THE TOKEN. Day attribution is user-local, and the verified token already
 * carries the account's zone, so the streak is computed against the user's calendar without a second
 * query for it and without the client being able to nominate a more convenient day.
 */

const PROFILE: UserProfile = {
  id: 'user-1',
  email: 'ada@evergrove.app',
  username: 'Ada_L',
  firstName: 'Ada',
  lastName: 'Lovelace',
  timezone: 'Europe/London',
  emailVerified: false,
  avatarUpdatedAt: null,
  createdAt: '2026-07-28T09:00:00.000Z',
};

const SESSION: Session = {
  clientSessionId: '018f0000-0000-7000-8000-00000000cccc',
  id: '018f0000-0000-7000-8000-00000000aaaa',
  taskId: '018f0000-0000-7000-8000-00000000bbbb',
  taskTitle: 'Thesis chapter 3',
  type: 'focus',
  status: 'completed',
  startedAt: '2026-01-15T08:35:00.000Z',
  endedAt: '2026-01-15T09:00:00.000Z',
  plannedDurationMs: 1_500_000,
  actualDurationMs: 1_500_000,
  terminationReason: null,
  pointsAwarded: 100,
};

const GAMIFICATION: GamificationSnapshot = {
  balance: 100,
  lifetimePoints: 100,
  currentDayStreak: 1,
  longestDayStreak: 1,
  currentSessionRun: 1,
  streakFreezesAvailable: 1,
  pointsDelta: 100,
  unlockedTitles: [],
  newlyUnlocked: [],
};

const DTO: RecordSessionDto = {
  clientSessionId: SESSION.clientSessionId,
  taskId: SESSION.taskId,
  taskTitle: SESSION.taskTitle,
  type: 'focus',
  status: 'completed',
  startedAt: SESSION.startedAt,
  endedAt: SESSION.endedAt,
  plannedDurationMs: SESSION.plannedDurationMs,
  actualDurationMs: SESSION.actualDurationMs,
  terminationReason: null,
};

function authFor(profile: UserProfile = PROFILE): AuthContext {
  return { userId: profile.id, profile };
}

describe('SessionController', () => {
  let replayed: boolean;
  let statuses: number[];
  let response: Response;
  let sessions: SessionService;
  let controller: SessionController;

  beforeEach(() => {
    replayed = false;
    statuses = [];

    response = {
      status: vi.fn((code: number) => {
        statuses.push(code);
        return response;
      }),
    } as unknown as Response;

    sessions = {
      recordSession: vi.fn(() =>
        Promise.resolve({ session: SESSION, gamification: GAMIFICATION, replayed }),
      ),
      listSessions: vi.fn(() => Promise.resolve({ sessions: [SESSION], nextCursor: null })),
    } as unknown as SessionService;

    controller = new SessionController(sessions);
  });

  describe('POST /sessions', () => {
    it('records against the account the token names', async () => {
      await controller.record(authFor(), DTO, response);

      expect(sessions.recordSession).toHaveBeenCalledWith('user-1', 'Europe/London', DTO);
    });

    it('takes the timezone from the token, not the payload', async () => {
      /*
       * The zone decides which day a session counts toward, and therefore whether a streak
       * survives. Reading it from the request would let a client aim a record at whichever day
       * repaired its streak.
       */
      await controller.record(
        authFor({ ...PROFILE, timezone: 'Asia/Karachi' }),
        { ...DTO, timeZone: 'Pacific/Kiritimati' } as never,
        response,
      );

      expect(sessions.recordSession).toHaveBeenCalledWith(
        'user-1',
        'Asia/Karachi',
        expect.anything(),
      );
    });

    it('answers 201 for a record the server has not seen', async () => {
      await controller.record(authFor(), DTO, response);

      expect(statuses).toEqual([HttpStatus.CREATED]);
    });

    it('answers 200 when the same client session id was already stored', async () => {
      // A retried outbox flush. Success, not an error — the record it wanted stored IS stored.
      replayed = true;

      await controller.record(authFor(), DTO, response);

      expect(statuses).toEqual([HttpStatus.OK]);
    });

    it('returns the record and the new totals together', async () => {
      /*
       * One round trip for both, deliberately: a session never costs two requests, and the record
       * and the totals can never disagree with each other.
       */
      const result = await controller.record(authFor(), DTO, response);

      expect(result).toEqual({ session: SESSION, gamification: GAMIFICATION });
    });

    it('does not leak the replay flag into the body', async () => {
      // The status code already says it. A body field saying the same thing is a second source of
      // truth for the client to branch on, and eventually to branch on differently.
      replayed = true;

      const result = await controller.record(authFor(), DTO, response);

      expect(result).not.toHaveProperty('replayed');
    });

    it('returns the same body whether the record was new or replayed', async () => {
      const fresh = await controller.record(authFor(), DTO, response);
      replayed = true;
      const retried = await controller.record(authFor(), DTO, response);

      expect(retried).toEqual(fresh);
    });
  });

  describe('GET /sessions', () => {
    it('reads the account the token names', async () => {
      await controller.list(authFor(), { limit: 50 });

      expect(sessions.listSessions).toHaveBeenCalledWith('user-1', { limit: 50 });
    });

    it('forwards the query untouched', async () => {
      const query = { from: '2026-01-01T00:00:00.000Z', cursor: 'opaque', limit: 25 };

      await controller.list(authFor(), query);

      expect(sessions.listSessions).toHaveBeenCalledWith('user-1', query);
    });

    it('returns the page unwrapped, log and cursor together', async () => {
      /*
       * This is the ONLY read History needs. There are no statistics endpoints — the client
       * aggregates these records itself, so summaries and timelines cost no further requests and
       * cannot drift from the log they describe.
       */
      await expect(controller.list(authFor(), { limit: 50 })).resolves.toEqual({
        sessions: [SESSION],
        nextCursor: null,
      });
    });

    it('routes a different token to a different account', async () => {
      await controller.list(authFor({ ...PROFILE, id: 'user-2' }), { limit: 50 });

      expect(sessions.listSessions).toHaveBeenCalledWith('user-2', expect.anything());
    });
  });
});
