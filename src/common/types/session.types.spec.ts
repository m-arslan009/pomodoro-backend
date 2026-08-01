import { describe, expect, it } from 'vitest';
import type { GamificationState } from '../../domain/gamification';
import { type SessionRecord, toGamificationSnapshot, toSession } from './session.types';

/*
 * The row-to-response mappers for the session log.
 *
 * Boring by intent, and worth testing precisely because of it: these are the last thing that runs
 * before data leaves the process, so a dropped or renamed field here is invisible in every layer
 * above and only surfaces as a hole in someone's history chart.
 *
 * Two properties carry real weight. `attributionDate` must NOT reach the client — it is an internal
 * decision replayed by a rebuild, and exposing it would invite a client to reason about it. And
 * dates must leave as ISO strings, because the client stores this object verbatim and JSON has no
 * Date.
 */

const RECORD: SessionRecord = {
  id: '018f0000-0000-7000-8000-00000000aaaa',
  taskId: '018f0000-0000-7000-8000-00000000bbbb',
  taskTitleSnapshot: 'Thesis chapter 3',
  clientSessionId: '018f0000-0000-7000-8000-00000000cccc',
  type: 'focus',
  status: 'completed',
  startedAt: new Date('2026-01-15T08:35:00.000Z'),
  endedAt: new Date('2026-01-15T09:00:00.000Z'),
  plannedDurationMs: 1_500_000,
  actualDurationMs: 1_499_000,
  terminationReason: null,
  pointsAwarded: 100,
  attributionDate: '2026-01-15',
};

const STATE: GamificationState = {
  balance: 550,
  lifetimePoints: 1050,
  currentDayStreak: 3,
  longestDayStreak: 7,
  currentSessionRun: 2,
  lastActiveDate: '2026-01-15',
  streakFreezesAvailable: 1,
  unlockedTitles: ['anchor'],
};

describe('toSession', () => {
  it('returns exactly the canonical field set', () => {
    /*
     * CONTRACT.md §14.1. One shape for POST, for GET, for what the client stores and for what
     * History aggregates — two variants would guarantee a mapping bug at the seam between them.
     */
    expect(Object.keys(toSession(RECORD)).sort()).toEqual([
      'actualDurationMs',
      'clientSessionId',
      'endedAt',
      'id',
      'plannedDurationMs',
      'pointsAwarded',
      'startedAt',
      'status',
      'taskId',
      'taskTitle',
      'terminationReason',
      'type',
    ]);
  });

  it('withholds the attributed day', () => {
    // Internal: decided once at insert and replayed verbatim by a rebuild. The client has no use
    // for it, and publishing it would make it something the client could start depending on.
    expect(toSession(RECORD)).not.toHaveProperty('attributionDate');
  });

  it('publishes the title snapshot under its contract name', () => {
    // `task_title_snapshot` in the column, `taskTitle` on the wire. The rename is the mapper's
    // whole job here, and getting it wrong leaves every history row unlabelled.
    expect(toSession(RECORD).taskTitle).toBe('Thesis chapter 3');
  });

  it('serialises both timestamps as ISO strings', () => {
    const session = toSession(RECORD);

    expect(session.startedAt).toBe('2026-01-15T08:35:00.000Z');
    expect(session.endedAt).toBe('2026-01-15T09:00:00.000Z');
  });

  it('carries the server-clamped duration, not the planned one', () => {
    // The client adopts this answer over the number it sent (ADR-012), so the two must be
    // distinguishable in the response.
    const session = toSession(RECORD);

    expect(session.actualDurationMs).toBe(1_499_000);
    expect(session.plannedDurationMs).toBe(1_500_000);
  });

  it('keeps a session whose task is gone', () => {
    // The foreign key is ON DELETE SET NULL and the snapshot survives it. Deleting a label has
    // never been a reason to lose the work done under it.
    const orphaned = toSession({ ...RECORD, taskId: null });

    expect(orphaned.taskId).toBeNull();
    expect(orphaned.taskTitle).toBe('Thesis chapter 3');
  });

  it('carries a termination reason when there is one', () => {
    const terminated = toSession({
      ...RECORD,
      status: 'terminated',
      terminationReason: 'interrupted',
      pointsAwarded: 0,
    });

    expect(terminated).toMatchObject({
      status: 'terminated',
      terminationReason: 'interrupted',
      pointsAwarded: 0,
    });
  });
});

describe('toGamificationSnapshot', () => {
  it('publishes the whole projection, not a delta', () => {
    /*
     * The client replaces its copy outright with this object. A client that patched its own totals
     * would be computing, and the client computes nothing.
     */
    expect(Object.keys(toGamificationSnapshot(STATE)).sort()).toEqual([
      'balance',
      'currentDayStreak',
      'currentSessionRun',
      'lifetimePoints',
      'longestDayStreak',
      'newlyUnlocked',
      'pointsDelta',
      'streakFreezesAvailable',
      'unlockedTitles',
    ]);
  });

  it('withholds the last active day', () => {
    // Internal streak bookkeeping. The streak counts are the user-facing facts; the marker they are
    // computed from is not.
    expect(toGamificationSnapshot(STATE)).not.toHaveProperty('lastActiveDate');
  });

  it('reports nothing gained on a plain read', () => {
    // `GET /gamification` awards nothing, so a non-zero delta here would make the client announce
    // points for merely looking.
    const snapshot = toGamificationSnapshot(STATE);

    expect(snapshot.pointsDelta).toBe(0);
    expect(snapshot.newlyUnlocked).toEqual([]);
  });

  it('reports what a recording awarded', () => {
    const snapshot = toGamificationSnapshot(STATE, 150, ['anchor']);

    expect(snapshot.pointsDelta).toBe(150);
    expect(snapshot.newlyUnlocked).toEqual(['anchor']);
  });

  it('keeps titles already held separate from titles just crossed', () => {
    // The client celebrates off `newlyUnlocked` and renders the ladder off `unlockedTitles`.
    // Collapsing them would re-congratulate someone on every subsequent session.
    const snapshot = toGamificationSnapshot(
      { ...STATE, unlockedTitles: ['anchor', 'paceSetter'] },
      150,
      ['paceSetter'],
    );

    expect(snapshot.unlockedTitles).toEqual(['anchor', 'paceSetter']);
    expect(snapshot.newlyUnlocked).toEqual(['paceSetter']);
  });

  it('copies the projection’s own numbers through unchanged', () => {
    expect(toGamificationSnapshot(STATE)).toMatchObject({
      balance: 550,
      lifetimePoints: 1050,
      currentDayStreak: 3,
      longestDayStreak: 7,
      currentSessionRun: 2,
      streakFreezesAvailable: 1,
    });
  });
});
