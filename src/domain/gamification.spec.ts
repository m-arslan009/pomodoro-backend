import { describe, expect, it } from 'vitest';
import {
  POINTS,
  STREAK_FREEZE,
  TITLES,
  type GamificationState,
  type ScorableSession,
  applySession,
  attributionDate,
  emptyGamification,
  localDateKey,
  nextDateKey,
  resolveElapsedDays,
  titlesFor,
} from './gamification';

/*
 * The points economy and the title ladder.
 *
 * THIS MODULE IS THE ONLY THING THAT SCORES, so it is the only thing standing between a user and
 * awarding themselves the product: points drive titles, and titles unlock features. Every rule here
 * is therefore tested against what a determined client would try, not only against the happy path.
 *
 * REPLAY EQUIVALENCE IS THE CONTRACT. `user_gamification` is a projection (ADR-006) and
 * `applySession` is the fold that produces it, so folding a user's whole log in `started_at` order
 * must reproduce their stored row exactly. That is what `gamification:rebuild` relies on and what
 * makes updating the projection inside the insert's transaction safe. The final describe block
 * asserts it directly, because a regression there is silent until someone needs the rebuild — which
 * is precisely the moment it cannot be discovered safely.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function completedFocus(day: string): ScorableSession {
  return { type: 'focus', status: 'completed', attributionDate: day };
}

function terminatedFocus(day: string): ScorableSession {
  return { type: 'focus', status: 'terminated', attributionDate: day };
}

function completedBreak(day: string): ScorableSession {
  return { type: 'break', status: 'completed', attributionDate: day };
}

/** Fold a whole list, which is exactly what a rebuild does. */
function fold(sessions: readonly ScorableSession[], from = emptyGamification()): GamificationState {
  return sessions.reduce((state, session) => applySession(state, session).state, from);
}

describe('emptyGamification', () => {
  it('starts a new account at zero, with one streak freeze in hand', () => {
    expect(emptyGamification()).toEqual({
      balance: 0,
      lifetimePoints: 0,
      currentDayStreak: 0,
      longestDayStreak: 0,
      currentSessionRun: 0,
      lastActiveDate: null,
      streakFreezesAvailable: 1,
      lastFreezeGrantedOn: null,
      unlockedTitles: [],
    });
  });

  it('hands back a fresh object each time, so one rebuild cannot poison the next', () => {
    expect(emptyGamification()).not.toBe(emptyGamification());
  });
});

describe('titlesFor', () => {
  it('unlocks a title exactly at its threshold, never one point earlier', () => {
    for (const title of TITLES) {
      expect(titlesFor(title.threshold - 1)).not.toContain(title.key);
      expect(titlesFor(title.threshold)).toContain(title.key);
    }
  });

  it('unlocks every rung up to the earned one and none beyond it', () => {
    // At 4,000 the ladder is cumulative and strictly ordered — a lower tier never leaks a higher.
    expect(titlesFor(4000)).toEqual(['anchor', 'paceSetter', 'catalyst']);
  });

  it('returns nothing below the first rung', () => {
    expect(titlesFor(0)).toEqual([]);
    expect(titlesFor(999)).toEqual([]);
  });

  it('treats a nonsensical total as zero rather than throwing', () => {
    expect(titlesFor(Number.NaN)).toEqual([]);
    expect(titlesFor(-500)).toEqual([]);
  });

  it('keeps the ladder ascending, so "unlocked so far" is a prefix', () => {
    const thresholds = TITLES.map((title) => title.threshold);

    expect([...thresholds].sort((a, b) => a - b)).toEqual(thresholds);
  });
});

describe('localDateKey', () => {
  it('answers in the user’s calendar, not the datacentre’s', () => {
    /*
     * 20:00 UTC is already tomorrow in Karachi. Streaks are the number people feel most
     * proprietorial about, and resolving this against server time breaks them by a day for most of
     * the planet.
     */
    const instant = new Date('2026-01-15T20:00:00.000Z');

    expect(localDateKey(instant, 'Asia/Karachi')).toBe('2026-01-16');
    expect(localDateKey(instant, 'UTC')).toBe('2026-01-15');
  });

  it('handles a zone behind UTC as readily as one ahead', () => {
    const instant = new Date('2026-01-15T04:00:00.000Z');

    expect(localDateKey(instant, 'America/Los_Angeles')).toBe('2026-01-14');
    expect(localDateKey(instant, 'UTC')).toBe('2026-01-15');
  });

  it('pads to a sortable key, because days are compared as strings', () => {
    // `day < last` is how a backdated record is detected, so the format has to sort lexically.
    expect(localDateKey(new Date('2026-03-05T12:00:00.000Z'), 'UTC')).toBe('2026-03-05');
  });

  it('falls back to UTC on an unknown zone instead of throwing', () => {
    // A corrupt timezone string should cost a user a correct streak day at worst, never a recorded
    // session.
    expect(localDateKey(new Date('2026-01-15T20:00:00.000Z'), 'Not/AZone')).toBe('2026-01-15');
  });
});

describe('nextDateKey', () => {
  it('advances an ordinary day', () => {
    expect(nextDateKey('2026-01-15')).toBe('2026-01-16');
  });

  it('crosses a month boundary', () => {
    expect(nextDateKey('2026-01-31')).toBe('2026-02-01');
  });

  it('crosses a year boundary', () => {
    expect(nextDateKey('2026-12-31')).toBe('2027-01-01');
  });

  it('knows about leap days', () => {
    expect(nextDateKey('2028-02-28')).toBe('2028-02-29');
    expect(nextDateKey('2028-02-29')).toBe('2028-03-01');
    expect(nextDateKey('2026-02-28')).toBe('2026-03-01');
  });
});

describe('attributionDate', () => {
  it('attributes a promptly delivered record to the day it started', () => {
    const startedAt = new Date('2026-01-15T09:00:00.000Z');
    const recordedAt = new Date('2026-01-15T09:26:00.000Z');

    expect(attributionDate(startedAt, recordedAt, 'UTC')).toBe('2026-01-15');
  });

  it('still attributes to the start day when delivery is merely slow', () => {
    // Under a day late is a flaky connection, not an attempt at anything.
    const startedAt = new Date('2026-01-15T09:00:00.000Z');
    const recordedAt = new Date(startedAt.getTime() + DAY_MS - 1000);

    expect(attributionDate(startedAt, recordedAt, 'UTC')).toBe('2026-01-15');
  });

  it('attributes a long-queued record to the day it was received', () => {
    /*
     * THE ANTI-CHEAT RULE. The session is stored truthfully either way, but a record flushed from
     * an outbox days later must not reach into the past and repair a streak somebody already broke.
     */
    const startedAt = new Date('2026-01-15T09:00:00.000Z');
    const recordedAt = new Date('2026-01-18T09:00:00.000Z');

    expect(attributionDate(startedAt, recordedAt, 'UTC')).toBe('2026-01-18');
  });

  it('resolves the attributed day in the user’s zone, whichever branch it takes', () => {
    const startedAt = new Date('2026-01-15T20:00:00.000Z');

    expect(attributionDate(startedAt, new Date('2026-01-15T20:30:00.000Z'), 'Asia/Karachi')).toBe(
      '2026-01-16',
    );
    expect(attributionDate(startedAt, new Date('2026-01-20T20:00:00.000Z'), 'Asia/Karachi')).toBe(
      '2026-01-21',
    );
  });
});

describe('resolveElapsedDays', () => {
  /*
   * The lazy streak resolution of ADR-014, and the reason there is no nightly job at all.
   *
   * It is PURE IN `today` — it reads no clock of its own — which is what lets one rule serve two
   * callers that must never disagree: the write fold passes the day a completion counts toward, and
   * `GET /gamification` passes the user-local date now. Only the first of those is persisted
   * (CONTRACT.md §14.6), so everything asserted here has to hold for a day chosen either way.
   */

  const active: GamificationState = {
    ...emptyGamification(),
    currentDayStreak: 3,
    longestDayStreak: 3,
    lastActiveDate: '2026-01-15',
  };

  it('leaves a day that is still in progress alone', () => {
    // A streak is broken by a day that ENDED empty, not by one the user still has in front of them.
    // A clock that skews backwards lands here too, harmlessly.
    expect(resolveElapsedDays(active, '2026-01-15')).toBe(active);
    expect(resolveElapsedDays(active, '2026-01-16')).toBe(active);
  });

  it('spends a freeze to cover exactly one missed day', () => {
    const resolved = resolveElapsedDays(active, '2026-01-17');

    expect(resolved.currentDayStreak).toBe(3);
    expect(resolved.streakFreezesAvailable).toBe(0);
  });

  it('advances the marker onto the covered day rather than onto today', () => {
    /*
     * THE MARKER MOVE IS THE WHOLE MECHANISM. It is what makes the same gap impossible to pay for
     * twice, and why no second column is needed to remember that a day was bought. Moving it to
     * `today` instead would credit the user with activity on a day they did nothing.
     */
    expect(resolveElapsedDays(active, '2026-01-17').lastActiveDate).toBe('2026-01-16');
  });

  it('cannot be charged twice for the same gap', () => {
    /*
     * Resolution runs on every read as well as every write, so a second pass over one gap is the
     * NORMAL case, not an edge case — a user who opens the app twice must not be billed twice. The
     * fixture banks two so there is genuinely something left to take.
     */
    const banked: GamificationState = { ...active, streakFreezesAvailable: 2 };
    const once = resolveElapsedDays(banked, '2026-01-17');

    expect(once.streakFreezesAvailable).toBe(1);
    expect(resolveElapsedDays(once, '2026-01-17')).toEqual(once);
  });

  it('refuses to spend on a gap it cannot close', () => {
    // Two missed days is a broken streak whatever is banked. A freeze is insurance against the day
    // life got in the way, not a way to be absent for a week and keep the number.
    const resolved = resolveElapsedDays({ ...active, streakFreezesAvailable: 2 }, '2026-01-18');

    expect(resolved.currentDayStreak).toBe(0);
    expect(resolved.streakFreezesAvailable).toBe(2);
  });

  it('breaks a streak there is nothing banked to save', () => {
    const resolved = resolveElapsedDays({ ...active, streakFreezesAvailable: 0 }, '2026-01-17');

    expect(resolved.currentDayStreak).toBe(0);
  });

  it('leaves the marker where it was when the streak breaks', () => {
    // It records the last day actually worked. Moving it forward would invent activity.
    expect(resolveElapsedDays(active, '2026-01-25').lastActiveDate).toBe('2026-01-15');
  });

  it('takes nothing from an account that never started', () => {
    // No freeze is ever spent protecting a streak that does not exist.
    const fresh = emptyGamification();

    expect(resolveElapsedDays(fresh, '2026-03-01')).toBe(fresh);
  });

  it('takes nothing from a streak that has already lapsed', () => {
    // Otherwise every subsequent read would drain the bank a day at a time for a streak that is
    // already gone.
    const lapsed: GamificationState = { ...active, currentDayStreak: 0 };

    expect(resolveElapsedDays(lapsed, '2026-01-25')).toBe(lapsed);
  });
});

describe('applySession', () => {
  describe('breaks', () => {
    it('scores nothing and changes nothing at all', () => {
      /*
       * A break is not work. Letting one through the economy would roughly double every figure the
       * product reports, and letting it touch the session run would hand out the consecutive bonus
       * for resting.
       */
      const before = fold([completedFocus('2026-01-15')]);
      const result = applySession(before, completedBreak('2026-01-15'));

      expect(result.state).toBe(before);
      expect(result.pointsAwarded).toBe(0);
      expect(result.newlyUnlocked).toEqual([]);
    });

    it('does not break a run that surrounds it', () => {
      // The normal rhythm is focus, break, focus. If a break reset the run, the consecutive bonus
      // could never be earned by anybody following the product's own advice.
      const state = fold([
        completedFocus('2026-01-15'),
        completedBreak('2026-01-15'),
        completedFocus('2026-01-15'),
        completedBreak('2026-01-15'),
        completedFocus('2026-01-15'),
      ]);

      expect(state.currentSessionRun).toBe(3);
      expect(state.lifetimePoints).toBe(350);
    });
  });

  describe('terminated focus blocks', () => {
    it('costs nothing but resets the run', () => {
      /*
       * Penalising an honest early stop taught users to let the clock run out in another tab, which
       * is worse data and worse for them. The reason capture is what the product gets instead.
       */
      const before = fold([completedFocus('2026-01-15'), completedFocus('2026-01-15')]);
      const result = applySession(before, terminatedFocus('2026-01-15'));

      expect(result.pointsAwarded).toBe(0);
      expect(result.state.lifetimePoints).toBe(before.lifetimePoints);
      expect(result.state.balance).toBe(before.balance);
      expect(result.state.currentSessionRun).toBe(0);
    });

    it('leaves the day streak alone', () => {
      /*
       * The user may already have completed a session today. Taking the day away for stopping a
       * later one would punish them twice for one decision — once by the reset, and once for
       * having tried again at all.
       */
      const before = fold([completedFocus('2026-01-15')]);
      const after = applySession(before, terminatedFocus('2026-01-15')).state;

      expect(after.currentDayStreak).toBe(1);
      expect(after.lastActiveDate).toBe('2026-01-15');
    });

    it('never unlocks a title', () => {
      const before = fold(Array.from({ length: 9 }, () => completedFocus('2026-01-15')));
      const result = applySession(before, terminatedFocus('2026-01-15'));

      expect(result.newlyUnlocked).toEqual([]);
    });
  });

  describe('completed focus blocks', () => {
    it('awards a flat rate, regardless of how long the block was', () => {
      // Flat by design: the block was completed or it was not. Paying by duration would make a
      // four-hour block worth ten pomodoros and quietly punish short, focused work.
      const result = applySession(emptyGamification(), completedFocus('2026-01-15'));

      expect(result.pointsAwarded).toBe(POINTS.sessionComplete);
      expect(result.state.lifetimePoints).toBe(100);
      expect(result.state.balance).toBe(100);
      expect(result.state.currentSessionRun).toBe(1);
    });

    it('pays the consecutive bonus on every third completion', () => {
      const awarded: number[] = [];

      let state = emptyGamification();
      for (let completion = 1; completion <= 9; completion += 1) {
        const result = applySession(state, completedFocus('2026-01-15'));
        awarded.push(result.pointsAwarded);
        state = result.state;
      }

      expect(awarded).toEqual([100, 100, 150, 100, 100, 150, 100, 100, 150]);
      expect(state.lifetimePoints).toBe(1050);
    });

    it('restarts the run after a termination, so the bonus is not paid early', () => {
      /*
       * The run is the thing a terminated block costs. Two completions, a stop, then a third
       * completion is not three in a row, and paying the bonus there would make terminating free.
       */
      const state = fold([
        completedFocus('2026-01-15'),
        completedFocus('2026-01-15'),
        terminatedFocus('2026-01-15'),
        completedFocus('2026-01-15'),
      ]);

      expect(state.currentSessionRun).toBe(1);
      expect(state.lifetimePoints).toBe(300);
    });

    it('moves balance and lifetime together', () => {
      // They diverge only once something spends the balance. Nothing does yet, and the day it does,
      // lifetime must not move with it — titles are earned once and never lost.
      const state = fold(Array.from({ length: 4 }, () => completedFocus('2026-01-15')));

      expect(state.balance).toBe(state.lifetimePoints);
    });
  });

  describe('title unlocks', () => {
    it('announces a title on the session that crosses its threshold', () => {
      // 9 completions = 1,050 lifetime, and the tenth is not what earns The Anchor.
      let state = emptyGamification();
      const announcements: readonly string[][] = Array.from({ length: 9 }, () => {
        const result = applySession(state, completedFocus('2026-01-15'));
        state = result.state;
        return [...result.newlyUnlocked];
      });

      expect(announcements.filter((names) => names.length > 0)).toEqual([['anchor']]);
      expect(state.unlockedTitles).toEqual(['anchor']);
    });

    it('announces a title exactly once, however many sessions follow', () => {
      // The client fires a celebration off this field. Re-announcing would congratulate someone
      // repeatedly for something they earned twenty sessions ago.
      const before = fold(Array.from({ length: 12 }, () => completedFocus('2026-01-15')));
      const result = applySession(before, completedFocus('2026-01-15'));

      expect(before.unlockedTitles).toContain('anchor');
      expect(result.newlyUnlocked).toEqual([]);
    });

    it('announces two titles at once when a single session clears both', () => {
      // Contrived against the real ladder, but the rule is "everything crossed by THIS session",
      // not "the next one up" — a state repaired by a rebuild can legitimately jump.
      const stalled: GamificationState = {
        ...emptyGamification(),
        lifetimePoints: 1950,
        balance: 1950,
        currentSessionRun: 2,
        unlockedTitles: [],
      };

      const result = applySession(stalled, completedFocus('2026-01-15'));

      expect(result.pointsAwarded).toBe(150);
      expect(result.newlyUnlocked).toEqual(['anchor', 'paceSetter']);
    });
  });

  describe('the day streak', () => {
    it('starts at one on the first ever completion', () => {
      const state = applySession(emptyGamification(), completedFocus('2026-01-15')).state;

      expect(state).toMatchObject({
        currentDayStreak: 1,
        longestDayStreak: 1,
        lastActiveDate: '2026-01-15',
      });
    });

    it('counts days, not sessions', () => {
      // Five blocks in one afternoon is one day of showing up.
      const state = fold(Array.from({ length: 5 }, () => completedFocus('2026-01-15')));

      expect(state.currentDayStreak).toBe(1);
      expect(state.currentSessionRun).toBe(5);
    });

    it('extends across consecutive days', () => {
      const state = fold([
        completedFocus('2026-01-15'),
        completedFocus('2026-01-16'),
        completedFocus('2026-01-17'),
      ]);

      expect(state).toMatchObject({
        currentDayStreak: 3,
        longestDayStreak: 3,
        lastActiveDate: '2026-01-17',
      });
    });

    it('extends across a month boundary', () => {
      const state = fold([completedFocus('2026-01-31'), completedFocus('2026-02-01')]);

      expect(state.currentDayStreak).toBe(2);
    });

    it('restarts after a missed day it cannot cover, but remembers the best run', () => {
      /*
       * Nothing banked, so the 18th genuinely ends the run. A new account starts with one freeze in
       * hand, and with it this same log keeps the streak alive — which is the freeze block's
       * business, not this one's.
       */
      const drained: GamificationState = { ...emptyGamification(), streakFreezesAvailable: 0 };
      const state = fold(
        [
          completedFocus('2026-01-15'),
          completedFocus('2026-01-16'),
          completedFocus('2026-01-17'),
          // 18th missed.
          completedFocus('2026-01-19'),
        ],
        drained,
      );

      expect(state).toMatchObject({
        currentDayStreak: 1,
        longestDayStreak: 3,
        lastActiveDate: '2026-01-19',
      });
    });

    it('refuses to let a backdated record repair a broken streak', () => {
      /*
       * THE POINT OF THE WHOLE ATTRIBUTION RULE. Someone who missed the 18th cannot flush a stale
       * record dated to it and have the streak rejoined. The record is stored, it just buys nothing.
       *
       * Drained on purpose: the streak has to be genuinely broken for the rule to be under test at
       * all, and a banked freeze would have covered the 18th before the stale record ever arrived.
       */
      const drained: GamificationState = { ...emptyGamification(), streakFreezesAvailable: 0 };
      const broken = fold([completedFocus('2026-01-17'), completedFocus('2026-01-19')], drained);
      const after = applySession(broken, completedFocus('2026-01-18')).state;

      expect(after.currentDayStreak).toBe(1);
      expect(after.lastActiveDate).toBe('2026-01-19');
    });

    it('still pays points for a backdated record', () => {
      // It bought no streak, but the work happened and is worth what any block is worth.
      const broken = fold([completedFocus('2026-01-19')]);
      const result = applySession(broken, completedFocus('2026-01-18'));

      expect(result.pointsAwarded).toBe(100);
      expect(result.state.lifetimePoints).toBe(200);
    });

    it('does not move the marker backwards', () => {
      const broken = fold([completedFocus('2026-01-19')]);
      const after = applySession(broken, completedFocus('2026-01-10')).state;

      expect(after.lastActiveDate).toBe('2026-01-19');
    });
  });

  describe('streak freezes', () => {
    /*
     * A freeze buys back ONE missed day of `currentDayStreak`, and has no bearing on
     * `currentSessionRun` — that one counts sessions rather than days and resets on a termination.
     *
     * Spending happens inside the fold rather than on a clock, which is what keeps it replayable:
     * the day passed to `resolveElapsedDays` here is the session's stored attribution date, so a
     * rebuild reaches the same answer however long afterwards it runs.
     */

    it('covers a missed day and reports the spend, so it is announced exactly once', () => {
      // `freezesSpent` is to a saved day what `newlyUnlocked` is to a title: the transient signal
      // that lets the client say it happened, once, without computing anything itself.
      const before = fold([completedFocus('2026-01-15')]);
      const result = applySession(before, completedFocus('2026-01-17'));

      expect(result.freezesSpent).toBe(1);
      expect(result.state.currentDayStreak).toBe(2);
      expect(result.state.streakFreezesAvailable).toBe(0);
    });

    it('reports the spend even when the same session earns one straight back', () => {
      /*
       * THE CASE THE COUNT ALONE CANNOT ANSWER, and the entire reason `freezesSpent` exists.
       * Covering a missed day and then reaching a multiple of seven moves `streakFreezesAvailable`
       * by nothing at all, so a client watching only the count would report a saved day as unsaved.
       */
      const sixDays: GamificationState = {
        ...emptyGamification(),
        currentDayStreak: 6,
        longestDayStreak: 6,
        lastActiveDate: '2026-01-20',
        streakFreezesAvailable: 1,
      };

      // The 21st missed; this completion covers it and takes the streak to seven.
      const result = applySession(sixDays, completedFocus('2026-01-22'));

      expect(result.state.currentDayStreak).toBe(7);
      expect(result.state.streakFreezesAvailable).toBe(1);
      expect(result.freezesSpent).toBe(1);
    });

    it('spends nothing on a gap wider than a freeze covers', () => {
      // The streak restarts at one and the freeze is still in hand — it was never spent on a gap it
      // could not close.
      const before = fold([completedFocus('2026-01-15')]);
      const result = applySession(before, completedFocus('2026-01-18'));

      expect(result.freezesSpent).toBe(0);
      expect(result.state.currentDayStreak).toBe(1);
      expect(result.state.streakFreezesAvailable).toBe(1);
    });

    it('banks one when the day streak reaches a multiple of seven', () => {
      const drained: GamificationState = { ...emptyGamification(), streakFreezesAvailable: 0 };
      const week = fold(
        Array.from({ length: 7 }, (_, index) => completedFocus(`2026-01-${15 + index}`)),
        drained,
      );

      expect(week.currentDayStreak).toBe(7);
      expect(week.streakFreezesAvailable).toBe(1);
    });

    it('banks one a day at most, however many blocks that day holds', () => {
      // Without the per-day guard every later block on the seventh day would bank another one, and
      // a heavy afternoon would fill the account to the ceiling.
      const drained: GamificationState = { ...emptyGamification(), streakFreezesAvailable: 0 };
      const week = fold(
        Array.from({ length: 7 }, (_, index) => completedFocus(`2026-01-${15 + index}`)),
        drained,
      );
      const sameDayAgain = fold([completedFocus('2026-01-21'), completedFocus('2026-01-21')], week);

      expect(sameDayAgain.streakFreezesAvailable).toBe(1);
    });

    it('stops banking at the ceiling, so freezes cannot be hoarded into a long absence', () => {
      // Fourteen consecutive days passes two grant points, and the account starts with one in hand.
      const fortnight = fold(
        Array.from({ length: 14 }, (_, index) => completedFocus(`2026-01-${15 + index}`)),
      );

      expect(fortnight.currentDayStreak).toBe(14);
      expect(fortnight.streakFreezesAvailable).toBe(STREAK_FREEZE.maxAvailable);
    });

    it('never spends one on a terminated block', () => {
      /*
       * Terminating costs nothing, and paying a freeze for an honest early stop would be a cost.
       * Only a completion can extend the streak a freeze exists to protect, so only a completion
       * resolves the days behind it — the days here are left entirely unexamined.
       */
      const before = fold([completedFocus('2026-01-15')]);
      const result = applySession(before, terminatedFocus('2026-01-20'));

      expect(result.freezesSpent).toBe(0);
      expect(result.state.streakFreezesAvailable).toBe(1);
      expect(result.state.currentDayStreak).toBe(1);
      expect(result.state.lastActiveDate).toBe('2026-01-15');
    });

    it('refuses to let a backdated record spend or earn one', () => {
      /*
       * ADR-011 carried through to freezes. A record attributed to a day at or before the marker is
       * stored and paid for like any other, but it cannot advance the streak, spend a freeze, or
       * bank one — otherwise a stale outbox flush would be a way to buy back a day already lost.
       */
      const broken = fold([completedFocus('2026-01-15'), completedFocus('2026-01-19')]);
      const result = applySession(broken, completedFocus('2026-01-18'));

      expect(result.freezesSpent).toBe(0);
      expect(result.state.streakFreezesAvailable).toBe(1);
      expect(result.state.lastActiveDate).toBe('2026-01-19');
      // Still paid, and still counted toward the session run — third in a row, so the bonus lands.
      // What backdating buys is nothing at all in the CALENDAR; the work itself is worth what any
      // block is worth.
      expect(result.pointsAwarded).toBe(150);
    });
  });
});

describe('replay equivalence (ADR-006)', () => {
  /*
   * The projection's entire justification is that it is derivable. These assert the property the
   * `gamification:rebuild` command depends on: the fold is a pure function of the event stream, so
   * replaying the log reproduces the stored row exactly.
   *
   * A regression here is invisible until someone actually needs a rebuild — which is the worst
   * possible moment to discover the projection cannot be reconstructed.
   */

  const LOG: readonly ScorableSession[] = [
    completedFocus('2026-01-15'),
    completedBreak('2026-01-15'),
    completedFocus('2026-01-15'),
    terminatedFocus('2026-01-15'),
    completedFocus('2026-01-16'),
    completedFocus('2026-01-16'),
    completedFocus('2026-01-16'),
    completedBreak('2026-01-16'),
    completedFocus('2026-01-18'),
  ];

  it('reproduces the same state from the same log, every time', () => {
    expect(fold(LOG)).toEqual(fold(LOG));
  });

  it('reaches the same state incrementally as it does in one pass', () => {
    // "Live" is the incremental path taken inside the insert's transaction; "rebuilt" is the batch
    // replay. They are the same function, and this is the assertion that keeps them so.
    const live = LOG.reduce(
      (state, session) => applySession(state, session).state,
      emptyGamification(),
    );
    const rebuilt = fold(LOG);

    expect(rebuilt).toEqual(live);
  });

  it('produces a state consistent with its own history', () => {
    const state = fold(LOG);

    expect(state).toEqual({
      /*
       * Six completed focus blocks. The termination zeroes the run, so the two after it start over
       * and the bonus lands on the third of THOSE: 100, 100, [0], 100, 100, 150, 100 = 650.
       *
       * Note the run keeps climbing across the day boundary — it is a streak of completions, not of
       * days, and only a termination resets it.
       */
      balance: 650,
      lifetimePoints: 650,
      /*
       * 15th, 16th, then the 18th. The 17th was missed, and the account's starting freeze covers
       * it — so the streak reaches 3 rather than restarting, and the bank is empty afterwards. The
       * marker is the 18th because the covering session earned that day outright.
       */
      currentDayStreak: 3,
      longestDayStreak: 3,
      currentSessionRun: 4,
      lastActiveDate: '2026-01-18',
      streakFreezesAvailable: 0,
      lastFreezeGrantedOn: null,
      unlockedTitles: [],
    });
  });

  it('replays every spend and every grant, because both are functions of the log', () => {
    /*
     * The freeze economy is the newest thing that could quietly break rebuildability, and the reason
     * `resolveElapsedDays` takes the day as an argument instead of reading a clock. On this path
     * that argument is the session's stored attribution date, so the fold spends and banks at
     * exactly the same points however long after the fact it is replayed.
     */
    const log: readonly ScorableSession[] = [
      completedFocus('2026-01-15'),
      // The 16th missed, and covered out of the bank rather than breaking the streak.
      completedFocus('2026-01-17'),
      completedFocus('2026-01-18'),
      completedFocus('2026-01-19'),
      completedFocus('2026-01-20'),
      completedFocus('2026-01-21'),
      // Seventh day of the streak: one banked back.
      completedFocus('2026-01-22'),
    ];

    expect(fold(log)).toEqual({
      // Seven completions, the bonus landing on the third and the sixth: 100 × 7 + 50 × 2.
      balance: 800,
      lifetimePoints: 800,
      currentDayStreak: 7,
      longestDayStreak: 7,
      currentSessionRun: 7,
      lastActiveDate: '2026-01-22',
      // Started with one, spent it on the 16th, earned it back on the seventh day.
      streakFreezesAvailable: 1,
      lastFreezeGrantedOn: '2026-01-22',
      unlockedTitles: [],
    });
  });

  it('never mutates the state it was handed', () => {
    // The fold is only replayable while it stays pure. An in-place update would make a rebuild
    // depend on how many times it had been run.
    const before = fold(LOG);
    const snapshot = structuredClone(before);

    applySession(before, completedFocus('2026-01-19'));

    expect(before).toEqual(snapshot);
  });

  it('is order-sensitive, which is why a rebuild reads ascending', () => {
    /*
     * Not a wart — a property worth pinning. The streak depends on the sequence of days, so
     * replaying the log newest-first would produce a different and wrong answer. The repository
     * orders by `started_at` ascending for exactly this reason.
     */
    const forwards = fold([completedFocus('2026-01-15'), completedFocus('2026-01-16')]);
    const backwards = fold([completedFocus('2026-01-16'), completedFocus('2026-01-15')]);

    expect(forwards.currentDayStreak).toBe(2);
    expect(backwards.currentDayStreak).toBe(1);
  });
});
