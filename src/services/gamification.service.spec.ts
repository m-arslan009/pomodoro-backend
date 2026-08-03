import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../common/ports/clock.port';
import type { SessionRecord } from '../common/types/session.types';
import { type GamificationState, emptyGamification } from '../domain/gamification';
import type { SessionRepository } from '../repositories/session.repository';
import { GamificationService } from './gamification.service';

/*
 * Reading progression, and rebuilding it from the event log.
 *
 * `user_gamification` is a projection, not a source of truth (ADR-006): every value in it is
 * derivable by folding `focus_sessions` in order through the same domain function that produced it
 * live. The rebuild ships with the feature rather than after it — a projection nobody can rebuild is
 * a source of truth wearing a cache's clothes, and the first time it drifts there is no way back.
 *
 * The repository fake here actually drives the fold callback over a fixture log, because "the
 * rebuild replays through the domain" is the property under test, not "the service calls a method".
 */

function makeRecord(
  overrides: Partial<SessionRecord> & Pick<SessionRecord, 'attributionDate'>,
): SessionRecord {
  const startedAt = new Date('2026-01-15T08:35:00.000Z');
  return {
    id: 'session-1',
    taskId: null,
    taskTitleSnapshot: 'Thesis chapter 3',
    clientSessionId: 'client-1',
    type: 'focus',
    status: 'completed',
    startedAt,
    endedAt: new Date(startedAt.getTime() + 25 * 60 * 1000),
    plannedDurationMs: 1_500_000,
    actualDurationMs: 1_500_000,
    terminationReason: null,
    pointsAwarded: 100,
    ...overrides,
  };
}

describe('GamificationService', () => {
  let stored: GamificationState;
  let log: SessionRecord[];
  let userIds: string[];

  let sessions: SessionRepository;
  let service: GamificationService;

  beforeEach(() => {
    stored = emptyGamification();
    log = [];
    userIds = [];

    sessions = {
      getGamification: vi.fn(() => Promise.resolve(stored)),
      rebuild: vi.fn(
        (
          _userId: string,
          advance: (state: GamificationState, session: SessionRecord) => GamificationState,
        ) => {
          // Stand in for the batched ascending scan: fold the fixture log through the callback.
          return Promise.resolve(log.reduce(advance, emptyGamification()));
        },
      ),
      listUserIdsWithSessions: vi.fn(() => Promise.resolve(userIds)),
    } as unknown as SessionRepository;

    // Fixed, because the read now resolves elapsed days against it (ADR-014) and a wall clock would
    // make every streak assertion below depend on the day the suite happened to run.
    const clock: Clock = { now: () => new Date('2026-01-16T10:00:00.000Z') };

    service = new GamificationService(sessions, clock);
  });

  describe('getGamification', () => {
    it('reads the account the id names', async () => {
      await service.getGamification('user-1', 'UTC');

      expect(sessions.getGamification).toHaveBeenCalledWith('user-1');
    });

    it('answers with zeroes for an account that has never recorded anything', async () => {
      // Not a 404. A brand-new account has a progression, it is simply all zeroes, and the client
      // needs usable numbers before the first session exists.
      const snapshot = await service.getGamification('user-1', 'UTC');

      expect(snapshot).toMatchObject({
        balance: 0,
        lifetimePoints: 0,
        currentDayStreak: 0,
        unlockedTitles: [],
      });
    });

    it('publishes the projection as a snapshot, not the raw state', async () => {
      stored = {
        ...emptyGamification(),
        balance: 550,
        lifetimePoints: 1050,
        currentDayStreak: 3,
        unlockedTitles: ['anchor'],
      };

      const snapshot = await service.getGamification('user-1', 'UTC');

      expect(snapshot).toMatchObject({ lifetimePoints: 1050, unlockedTitles: ['anchor'] });
      // The streak marker is internal bookkeeping and does not cross the boundary.
      expect(snapshot).not.toHaveProperty('lastActiveDate');
    });

    it('reports nothing gained, because a read awards nothing', async () => {
      /*
       * An endpoint that could move points would be an endpoint that could grant titles. Every
       * write path runs through recording a session, so this one reports a zero delta always.
       */
      const snapshot = await service.getGamification('user-1', 'UTC');

      expect(snapshot.pointsDelta).toBe(0);
      expect(snapshot.newlyUnlocked).toEqual([]);
    });
  });

  describe('getGamification — elapsed days (ADR-014)', () => {
    /*
     * The stored row is only ever as current as the last session recorded, so a streak that lapsed
     * yesterday is still sitting in the database at its old value. Reporting that number would
     * report a streak the user no longer has — and worse, one they would watch reset the moment
     * they next recorded a session, which reads as the app taking something away.
     *
     * The clock is fixed at 2026-01-16, so "today" below is that day unless a test says otherwise.
     */

    it('projects a lapsed streak forward instead of reporting a stale one', async () => {
      // Last active on the 14th, so the 15th was missed and the banked freeze covers it.
      stored = {
        ...emptyGamification(),
        currentDayStreak: 3,
        longestDayStreak: 3,
        lastActiveDate: '2026-01-14',
        streakFreezesAvailable: 1,
      };

      const snapshot = await service.getGamification('user-1', 'UTC');

      expect(snapshot.currentDayStreak).toBe(3);
      expect(snapshot.streakFreezesAvailable).toBe(0);
    });

    it('shows a streak too far gone to save as broken, with the freeze still in hand', async () => {
      // Four days is more than a freeze can close, and one is never spent on a gap it cannot close.
      stored = {
        ...emptyGamification(),
        currentDayStreak: 5,
        longestDayStreak: 5,
        lastActiveDate: '2026-01-12',
        streakFreezesAvailable: 1,
      };

      const snapshot = await service.getGamification('user-1', 'UTC');

      expect(snapshot.currentDayStreak).toBe(0);
      expect(snapshot.streakFreezesAvailable).toBe(1);
    });

    it('leaves today alone, because the user still has it', async () => {
      stored = {
        ...emptyGamification(),
        currentDayStreak: 3,
        longestDayStreak: 3,
        lastActiveDate: '2026-01-15',
        streakFreezesAvailable: 1,
      };

      const snapshot = await service.getGamification('user-1', 'UTC');

      expect(snapshot.currentDayStreak).toBe(3);
      expect(snapshot.streakFreezesAvailable).toBe(1);
    });

    it('resolves in the user’s calendar, not the server’s', async () => {
      /*
       * The same instant is the 16th in UTC and the 17th in Karachi, which is the difference
       * between "yesterday, still in progress" and "one missed day". Resolving against server time
       * would break this by a day for most of the planet.
       */
      stored = {
        ...emptyGamification(),
        currentDayStreak: 3,
        longestDayStreak: 3,
        lastActiveDate: '2026-01-15',
        streakFreezesAvailable: 1,
      };

      const evening: Clock = { now: () => new Date('2026-01-16T20:00:00.000Z') };
      const local = new GamificationService(sessions, evening);

      await expect(local.getGamification('user-1', 'UTC')).resolves.toMatchObject({
        currentDayStreak: 3,
        streakFreezesAvailable: 1,
      });
      await expect(local.getGamification('user-1', 'Asia/Karachi')).resolves.toMatchObject({
        currentDayStreak: 3,
        streakFreezesAvailable: 0,
      });
    });

    it('persists none of it, so the projection stays rebuildable', async () => {
      /*
       * THE ONE PLACE ADR-014'S "and persists the result" WAS NOT TAKEN LITERALLY (§14.6). `today`
       * depends on when the request happened to arrive, so writing it back would make
       * `user_gamification` depend on when it was last READ — and a projection that does is no
       * longer derivable from the event log, which is ADR-006 and the whole justification for it
       * being a projection at all.
       */
      stored = {
        ...emptyGamification(),
        currentDayStreak: 3,
        longestDayStreak: 3,
        lastActiveDate: '2026-01-14',
        streakFreezesAvailable: 1,
      };
      const before = structuredClone(stored);

      await service.getGamification('user-1', 'UTC');
      await service.getGamification('user-1', 'UTC');

      expect(stored).toEqual(before);
      expect(sessions.rebuild).not.toHaveBeenCalled();
    });

    it('announces no spend, however many times the same one is re-derived', async () => {
      /*
       * A read re-derives the same pending spend on every poll precisely because it never writes it
       * down. Announcing it each time would report one covered day over and over, so the spend is
       * announced by the request that makes it real — the recorded session (§14.6).
       */
      stored = {
        ...emptyGamification(),
        currentDayStreak: 3,
        longestDayStreak: 3,
        lastActiveDate: '2026-01-14',
        streakFreezesAvailable: 1,
      };

      const snapshot = await service.getGamification('user-1', 'UTC');

      expect(snapshot.streakFreezesSpent).toBe(0);
    });
  });

  describe('rebuild', () => {
    it('rebuilds the account the id names', async () => {
      await service.rebuild('user-1');

      expect(sessions.rebuild).toHaveBeenCalledWith('user-1', expect.any(Function));
    });

    it('replays the log through the same domain fold the live path uses', async () => {
      /*
       * THE PROPERTY THE WHOLE PROJECTION RESTS ON. If the rebuild scored differently from the
       * recorder, the projection would be unrecoverable the moment it drifted — and drift is
       * silent, so nobody would find out until the rebuild made things worse.
       */
      log = [
        makeRecord({ attributionDate: '2026-01-15' }),
        makeRecord({ attributionDate: '2026-01-15' }),
        makeRecord({ attributionDate: '2026-01-16' }),
      ];

      const state = await service.rebuild('user-1');

      // Three completed focus blocks, the third of them consecutive: 100 + 100 + 150.
      expect(state.lifetimePoints).toBe(350);
      expect(state.currentSessionRun).toBe(3);
      expect(state.currentDayStreak).toBe(2);
    });

    it('replays the stored attribution day rather than recomputing it', async () => {
      /*
       * Rebuilding is exact BECAUSE each session carries the day it was attributed to. Nothing here
       * reads the users table, consults a timezone, or depends on when the rebuild is run — so a
       * user who moves country does not have their history rewritten underneath them.
       */
      log = [
        makeRecord({ attributionDate: '2026-01-15' }),
        makeRecord({ attributionDate: '2026-01-16' }),
        makeRecord({ attributionDate: '2026-01-17' }),
      ];

      const state = await service.rebuild('user-1');

      expect(state.currentDayStreak).toBe(3);
      expect(state.lastActiveDate).toBe('2026-01-17');
    });

    it('scores a terminated block at nothing and resets the run', async () => {
      log = [
        makeRecord({ attributionDate: '2026-01-15' }),
        makeRecord({
          attributionDate: '2026-01-15',
          status: 'terminated',
          terminationReason: 'interrupted',
          pointsAwarded: 0,
        }),
      ];

      const state = await service.rebuild('user-1');

      expect(state.lifetimePoints).toBe(100);
      expect(state.currentSessionRun).toBe(0);
    });

    it('ignores breaks entirely', async () => {
      // A break in the log must contribute nothing, or every rebuilt total would drift upward from
      // the live one it is supposed to reproduce.
      log = [
        makeRecord({ attributionDate: '2026-01-15' }),
        makeRecord({ attributionDate: '2026-01-15', type: 'break', pointsAwarded: 0 }),
        makeRecord({ attributionDate: '2026-01-15' }),
      ];

      const state = await service.rebuild('user-1');

      expect(state.lifetimePoints).toBe(200);
      expect(state.currentSessionRun).toBe(2);
    });

    it('produces zeroes for an account with an empty log', async () => {
      // The correct answer for someone who deleted everything, and the reason the fold starts from
      // `emptyGamification()` rather than from whatever is currently stored.
      const state = await service.rebuild('user-1');

      expect(state).toEqual(emptyGamification());
    });

    it('replays freeze spends and grants from the log alone', async () => {
      /*
       * The rebuild reaches the freeze economy through the same fold and the same stored attribution
       * dates — it reads no clock, so a replay run months later still spends on the 16th. A rebuild
       * that could not reproduce the count would hand back a projection contradicting the streak it
       * had just recomputed.
       */
      log = [
        makeRecord({ attributionDate: '2026-01-15' }),
        // The 16th missed, and the account's starting freeze covers it.
        makeRecord({ attributionDate: '2026-01-17' }),
      ];

      const state = await service.rebuild('user-1');

      expect(state.currentDayStreak).toBe(2);
      expect(state.streakFreezesAvailable).toBe(0);
    });

    it('restores titles from the points it recomputed', async () => {
      // Titles are derived from lifetime points, so they come back on their own. A rebuild that had
      // to carry them separately would be a rebuild that could disagree with itself.
      log = Array.from({ length: 9 }, () => makeRecord({ attributionDate: '2026-01-15' }));

      const state = await service.rebuild('user-1');

      expect(state.lifetimePoints).toBe(1050);
      expect(state.unlockedTitles).toEqual(['anchor']);
    });
  });

  describe('listRebuildableUsers', () => {
    it('asks the repository for every account with a session', async () => {
      userIds = ['user-1', 'user-2'];

      await expect(service.listRebuildableUsers()).resolves.toEqual(['user-1', 'user-2']);
      expect(sessions.listUserIdsWithSessions).toHaveBeenCalled();
    });

    it('answers with an empty list on a fresh installation', async () => {
      await expect(service.listRebuildableUsers()).resolves.toEqual([]);
    });
  });
});
