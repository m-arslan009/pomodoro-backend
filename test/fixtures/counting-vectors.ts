/*
 * THE SHARED COUNTING VECTORS (CONTRACT.md §24.1).
 *
 * MIRROR — this file exists twice, byte for byte:
 *   backend/test/fixtures/counting-vectors.ts
 *   frontend/pomodoro/src/tests/fixtures/counting-vectors.js
 * Change one and you must change the other. There is deliberately no type annotation anywhere below,
 * which is what lets the TypeScript copy and the JavaScript copy be the same bytes.
 *
 * WHY IT EXISTS. The email report and the History dashboard compute the same figures from the same
 * records, in two languages, in two npm packages with no shared workspace between them. §24.1 states
 * the four counting rules in prose; these vectors are the same rules as arithmetic, so a change to
 * one implementation that drifts from the other fails a test instead of shipping a report whose
 * numbers disagree with the app the user is looking at.
 *
 * Both sides assert the same six fields — the ones that are genuinely shared. Task outcomes and
 * streak freezes are History's alone; periods and buckets are the report's alone.
 *
 * Durations are exact minutes so nothing here depends on rounding, except VECTOR 5, where rounding
 * IS the subject.
 */

const MINUTE = 60 * 1000;

/**
 * Every vector is a fixed instant range inside one week so both sides can hand it to whatever
 * windowing they use and get the same answer. Times are UTC and the fixtures are asserted in UTC —
 * timezone behaviour is the report's own concern and is covered by report.spec.ts, not here.
 */
export const COUNTING_VECTORS = [
  {
    name: 'rule 1 — break intervals are recorded and never counted',
    /*
     * The defect this prevents (E12): counting breaks roughly doubles every figure the product
     * reports, and it does it silently, because the numbers stay plausible.
     */
    sessions: [
      {
        type: 'focus',
        status: 'completed',
        endedAt: '2026-07-27T09:25:00.000Z',
        actualDurationMs: 25 * MINUTE,
        taskTitleSnapshot: 'Write the report',
        terminationReason: null,
      },
      {
        type: 'break',
        status: 'completed',
        endedAt: '2026-07-27T09:30:00.000Z',
        actualDurationMs: 5 * MINUTE,
        taskTitleSnapshot: 'Write the report',
        terminationReason: null,
      },
      {
        type: 'break',
        status: 'terminated',
        endedAt: '2026-07-27T09:34:00.000Z',
        actualDurationMs: 4 * MINUTE,
        taskTitleSnapshot: 'Write the report',
        terminationReason: 'interrupted',
      },
    ],
    gamification: { lifetimePoints: 100, balance: 100, currentDayStreak: 1, longestDayStreak: 1 },
    expected: {
      completedSessions: 1,
      terminatedSessions: 0,
      totalSessions: 1,
      focusMinutes: 25,
      completionRate: 100,
      points: 100,
    },
  },

  {
    name: 'rule 2 — a terminated block still counts its minutes',
    /*
     * A block honestly ended after twenty minutes was twenty minutes of focus. The caption reads
     * "min focused", not "min completed". This is the termination-penalty supersession applied to
     * the clock: the product stopped punishing an honest early stop, so it must not quietly erase
     * the work either.
     */
    sessions: [
      {
        type: 'focus',
        status: 'completed',
        endedAt: '2026-07-28T10:25:00.000Z',
        actualDurationMs: 25 * MINUTE,
        taskTitleSnapshot: 'Refactor the parser',
        terminationReason: null,
      },
      {
        type: 'focus',
        status: 'terminated',
        endedAt: '2026-07-28T11:20:00.000Z',
        actualDurationMs: 20 * MINUTE,
        taskTitleSnapshot: 'Refactor the parser',
        terminationReason: 'interrupted',
      },
    ],
    gamification: { lifetimePoints: 100, balance: 100, currentDayStreak: 2, longestDayStreak: 2 },
    expected: {
      completedSessions: 1,
      terminatedSessions: 1,
      totalSessions: 2,
      // 25 + 20. A implementation that counted only completed blocks would answer 25.
      focusMinutes: 45,
      completionRate: 50,
      points: 100,
    },
  },

  {
    name: 'rule 3 — points are LIFETIME points, never the balance',
    /*
     * Defect F5: the tile returned `balance` under a "Lifetime points earned" caption. The two are
     * equal while nothing subtracts, so the vector below makes them differ — which is the only way
     * the mistake is visible before a spending rule exists.
     */
    sessions: [
      {
        type: 'focus',
        status: 'completed',
        endedAt: '2026-07-29T09:25:00.000Z',
        actualDurationMs: 25 * MINUTE,
        taskTitleSnapshot: 'Read the ADRs',
        terminationReason: null,
      },
    ],
    gamification: { lifetimePoints: 4200, balance: 1200, currentDayStreak: 3, longestDayStreak: 9 },
    expected: {
      completedSessions: 1,
      terminatedSessions: 0,
      totalSessions: 1,
      focusMinutes: 25,
      completionRate: 100,
      points: 4200,
    },
  },

  {
    name: 'an empty period is all zeroes, and the completion rate does not divide by zero',
    sessions: [],
    gamification: { lifetimePoints: 0, balance: 0, currentDayStreak: 0, longestDayStreak: 0 },
    expected: {
      completedSessions: 0,
      terminatedSessions: 0,
      totalSessions: 0,
      focusMinutes: 0,
      completionRate: 0,
      points: 0,
    },
  },

  {
    name: 'minutes and the completion rate both round the same way',
    /*
     * 1 of 3 completed is 33.33…%, and 90 seconds is 1.5 minutes. Both sides must round rather than
     * truncate, and must round the TOTAL rather than each session — summing three 90-second blocks
     * gives 4.5 minutes, which is 5, not 3×2.
     */
    sessions: [
      {
        type: 'focus',
        status: 'completed',
        endedAt: '2026-07-30T09:01:30.000Z',
        actualDurationMs: 90 * 1000,
        taskTitleSnapshot: 'Tiny one',
        terminationReason: null,
      },
      {
        type: 'focus',
        status: 'terminated',
        endedAt: '2026-07-30T09:03:00.000Z',
        actualDurationMs: 90 * 1000,
        taskTitleSnapshot: 'Tiny one',
        terminationReason: 'finished_early',
      },
      {
        type: 'focus',
        status: 'terminated',
        endedAt: '2026-07-30T09:04:30.000Z',
        actualDurationMs: 90 * 1000,
        taskTitleSnapshot: 'Tiny one',
        terminationReason: 'out_of_energy',
      },
    ],
    gamification: { lifetimePoints: 300, balance: 300, currentDayStreak: 4, longestDayStreak: 9 },
    expected: {
      completedSessions: 1,
      terminatedSessions: 2,
      totalSessions: 3,
      focusMinutes: 5,
      completionRate: 33,
      points: 300,
    },
  },

  {
    name: 'a title with combining marks and an emoji survives grouping and counting',
    /*
     * Task titles are user-authored free text and reach a PDF. Two sessions on one title must group
     * as one task however that title is encoded — and the count must not change because a character
     * happens to be outside the BMP.
     */
    sessions: [
      {
        type: 'focus',
        status: 'completed',
        endedAt: '2026-07-31T09:25:00.000Z',
        actualDurationMs: 25 * MINUTE,
        taskTitleSnapshot: 'Café ☕ — déjà vu 🌲',
        terminationReason: null,
      },
      {
        type: 'focus',
        status: 'completed',
        endedAt: '2026-07-31T10:25:00.000Z',
        actualDurationMs: 25 * MINUTE,
        taskTitleSnapshot: 'Café ☕ — déjà vu 🌲',
        terminationReason: null,
      },
    ],
    gamification: { lifetimePoints: 200, balance: 200, currentDayStreak: 5, longestDayStreak: 9 },
    expected: {
      completedSessions: 2,
      terminatedSessions: 0,
      totalSessions: 2,
      focusMinutes: 50,
      completionRate: 100,
      points: 200,
    },
  },
];
