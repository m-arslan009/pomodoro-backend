import { describe, expect, it } from 'vitest';
import { COUNTING_VECTORS } from '../../test/fixtures/counting-vectors';
import {
  type ReportSessionInput,
  buildReport,
  previousPeriod,
  summarizeSessions,
  topTasks,
} from './report';

/*
 * The counting rules, against the SHARED VECTORS (CONTRACT.md §24.1).
 *
 * `test/fixtures/counting-vectors.ts` exists twice, byte for byte — here and at
 * `frontend/pomodoro/src/tests/fixtures/counting-vectors.js`. The frontend suite asserts the same
 * expectations against `services/history.js`. That mirror is the only thing keeping the email report
 * and the History dashboard from quietly disagreeing about how many sessions somebody did, in two
 * languages, in two packages with no shared workspace between them.
 *
 * If a vector fails on one side only, the two implementations have drifted and one of them is now
 * lying to a user who can see both.
 */

/** The fixture stores ISO strings so both copies can be identical; the fold takes Dates. */
function toSessions(vector: (typeof COUNTING_VECTORS)[number]): ReportSessionInput[] {
  return vector.sessions.map((session) => ({
    type: session.type,
    status: session.status,
    endedAt: new Date(session.endedAt),
    actualDurationMs: session.actualDurationMs,
    taskTitleSnapshot: session.taskTitleSnapshot,
    terminationReason: session.terminationReason,
  }));
}

describe('shared counting vectors', () => {
  it.each(COUNTING_VECTORS.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      const totals = summarizeSessions(toSessions(vector));

      expect(totals.completedSessions).toBe(vector.expected.completedSessions);
      expect(totals.terminatedSessions).toBe(vector.expected.terminatedSessions);
      expect(totals.totalSessions).toBe(vector.expected.totalSessions);
      expect(totals.focusMinutes).toBe(vector.expected.focusMinutes);
      expect(totals.completionRate).toBe(vector.expected.completionRate);
    },
  );

  it.each(COUNTING_VECTORS.map((vector) => [vector.name, vector] as const))(
    'points are lifetime points — %s',
    (_name, vector) => {
      const data = buildReport({
        period: previousPeriod('weekly', '2026-08-03'),
        timeZone: 'UTC',
        firstName: 'Ada',
        generatedAt: new Date('2026-08-03T08:00:00.000Z'),
        sessions: toSessions(vector),
        progress: {
          lifetimePoints: vector.gamification.lifetimePoints,
          currentDayStreak: vector.gamification.currentDayStreak,
          longestDayStreak: vector.gamification.longestDayStreak,
        },
      });

      // Rule 3. One vector deliberately gives `balance` a different value from `lifetimePoints`,
      // so returning the wrong field is visible now rather than on the day a spending rule ships
      // and the headline figure quietly becomes a lie (defect F5).
      expect(data.lifetimePoints).toBe(vector.expected.points);
    },
  );
});

describe('period membership', () => {
  const period = previousPeriod('weekly', '2026-08-03'); // 27 Jul – 2 Aug

  function session(endedAt: string): ReportSessionInput {
    return {
      type: 'focus',
      status: 'completed',
      endedAt: new Date(endedAt),
      actualDurationMs: 25 * 60 * 1000,
      taskTitleSnapshot: 'Task',
      terminationReason: null,
    };
  }

  it('includes a session that ended inside the period', () => {
    const data = build([session('2026-07-28T10:25:00.000Z')]);
    expect(data.totals.totalSessions).toBe(1);
  });

  it('excludes one that ended after it', () => {
    const data = build([session('2026-08-03T10:25:00.000Z')]);
    expect(data.totals.totalSessions).toBe(0);
  });

  it('puts a block spanning local midnight in the period it ENDED in (rule 4)', () => {
    /*
     * London is on BST here, so 22:10Z is 23:10 on 2 August — the last day of the period — and
     * 23:10Z is 00:10 on the 3rd, which is the next one. A block begun on Sunday night and finished
     * after midnight therefore counts toward NEXT week's report.
     *
     * The day-streak resolves the same block differently: it credits `attributionDate`, fixed at
     * insert from `startedAt`. They differ by design and neither may be "fixed" to match the other
     * (edge case E8).
     */
    expect(build([session('2026-08-02T22:10:00.000Z')]).totals.totalSessions).toBe(1);
    expect(build([session('2026-08-02T23:10:00.000Z')]).totals.totalSessions).toBe(0);
  });

  it('decides membership in the ACCOUNT zone, not the server zone', () => {
    /*
     * 2026-08-03T05:00Z is still 2 August in Los Angeles and already the 3rd in London. One
     * instant, one period, two answers — which is the whole reason the timezone is an argument and
     * never a default.
     */
    const instant = '2026-08-03T05:00:00.000Z';
    expect(build([session(instant)], 'Europe/London').totals.totalSessions).toBe(0);
    expect(build([session(instant)], 'America/Los_Angeles').totals.totalSessions).toBe(1);
  });

  function build(sessions: ReportSessionInput[], timeZone = 'Europe/London') {
    return buildReport({
      period,
      timeZone,
      firstName: 'Ada',
      generatedAt: new Date('2026-08-03T07:00:00.000Z'),
      sessions,
      progress: { lifetimePoints: 0, currentDayStreak: 0, longestDayStreak: 0 },
    });
  }
});

describe('topTasks', () => {
  function focus(title: string, minutes: number): ReportSessionInput {
    return {
      type: 'focus',
      status: 'completed',
      endedAt: new Date('2026-07-28T10:25:00.000Z'),
      actualDurationMs: minutes * 60 * 1000,
      taskTitleSnapshot: title,
      terminationReason: null,
    };
  }

  it('orders by focus time and caps the rows', () => {
    const sessions = Array.from({ length: 14 }, (_, index) => focus(`Task ${index}`, index + 1));
    const { rows, remaining } = topTasks(sessions);

    expect(rows).toHaveLength(10);
    expect(rows[0].title).toBe('Task 13');
    expect(remaining).toBe(4);
  });

  it('groups by the title as it was when the work happened', () => {
    // The snapshot, never the current task row — renaming a task must not rewrite last month's
    // report, and a deleted task must not make one fail (§13.2).
    const { rows } = topTasks([focus('Old name', 25), focus('Old name', 25)]);

    expect(rows).toHaveLength(1);
    expect(rows[0].sessions).toBe(2);
    expect(rows[0].focusMinutes).toBe(50);
  });

  it('is a total order, so the same data always renders the same way', () => {
    const first = topTasks([focus('B', 25), focus('A', 25)]).rows.map((row) => row.title);
    const second = topTasks([focus('A', 25), focus('B', 25)]).rows.map((row) => row.title);

    expect(first).toEqual(second);
  });
});
