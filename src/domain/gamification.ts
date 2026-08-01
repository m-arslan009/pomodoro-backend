/*
 * The points economy and the title ladder — pure, framework-free, ORM-free.
 *
 * THIS MODULE IS THE ONLY THING THAT SCORES. The client computes nothing: it reports what happened
 * and renders what comes back. That is not a style preference — points drive titles, titles unlock
 * features, so a client that could compute its own score could award itself the product.
 *
 * REPLAY EQUIVALENCE IS THE CONTRACT. `user_gamification` is a projection (ADR-006), and
 * `applySession` is the fold that produces it. Feeding every session for a user through this
 * function in `started_at` order must reproduce their stored row exactly — that property is what
 * `gamification:rebuild` relies on, and what makes updating the projection inside the insert's
 * transaction safe rather than a durability risk. Any change here that is not a pure function of
 * the event stream breaks it.
 *
 * TERMINATING COSTS NOTHING. It scores 0 and resets the session run. Penalising an honest early
 * stop taught users to let the clock run out in another tab, which is worse data and worse for
 * them. The reason capture is what the product gets instead.
 */

export const POINTS = {
  /** Flat, regardless of length: the block was completed or it was not. */
  sessionComplete: 100,
  consecutiveBonus: 50,
  /** The bonus fires on every Nth consecutive completion. */
  consecutiveThreshold: 3,
} as const;

export interface Title {
  readonly key: string;
  readonly name: string;
  readonly threshold: number;
  readonly feature: string;
}

/** Thresholds double at each rung. Mirrored by the frontend for display only. */
export const TITLES: readonly Title[] = [
  { key: 'anchor', name: 'The Anchor', threshold: 1000, feature: 'themeEditor' },
  { key: 'paceSetter', name: 'The Pace Setter', threshold: 2000, feature: 'backgroundAndLabels' },
  { key: 'catalyst', name: 'The Catalyst', threshold: 4000, feature: 'timeUtilization' },
  { key: 'vanguard', name: 'The Vanguard', threshold: 8000, feature: 'graphicalReports' },
  { key: 'paragon', name: 'The Paragon', threshold: 16000, feature: 'scheduling' },
];

/** Title keys unlocked at a lifetime total, ascending. Lifetime never decreases, so nor does this. */
export function titlesFor(lifetimePoints: number): string[] {
  const points = Number.isFinite(lifetimePoints) && lifetimePoints > 0 ? lifetimePoints : 0;
  return TITLES.filter((title) => points >= title.threshold).map((title) => title.key);
}

/* ------------------------------------------------------------------ Days -- */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The user-local calendar day of an instant, as 'YYYY-MM-DD'.
 *
 * Local, not UTC, and local to the USER rather than the server: a session finished at 23:30 in
 * Karachi belongs to the day that user lived through, not to whatever date it was in the datacentre.
 * Streaks are the one number people feel proprietorial about, and getting this wrong breaks them by
 * a day for most of the planet.
 *
 * Falls back to UTC on an unknown zone rather than throwing — a bad timezone string should not cost
 * someone a recorded session.
 */
export function localDateKey(instant: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);

    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** The calendar day after a 'YYYY-MM-DD' key. Date-only, so UTC arithmetic is exact. */
export function nextDateKey(dateKey: string): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Which day a record counts toward (CONTRACT.md §14.2).
 *
 * A record that arrives promptly is attributed to the day it was STARTED. One that arrives late —
 * queued offline, flushed days later — is attributed to the day it was RECEIVED.
 *
 * That asymmetry is deliberate and is the anti-cheat rule: the session is stored truthfully either
 * way, but backdating must never reach into the past to repair a streak somebody already broke.
 */
export function attributionDate(startedAt: Date, recordedAt: Date, timeZone: string): string {
  const late = recordedAt.getTime() - startedAt.getTime() > DAY_MS;
  return localDateKey(late ? recordedAt : startedAt, timeZone);
}

/* ------------------------------------------------------------ Projection -- */

/** The projection, as plain values. Mirrors `user_gamification` without importing the ORM. */
export interface GamificationState {
  readonly balance: number;
  readonly lifetimePoints: number;
  readonly currentDayStreak: number;
  readonly longestDayStreak: number;
  readonly currentSessionRun: number;
  /** User-local 'YYYY-MM-DD' of the last completed focus session, or null. */
  readonly lastActiveDate: string | null;
  readonly streakFreezesAvailable: number;
  readonly unlockedTitles: readonly string[];
}

/** A brand-new account's projection. Also the starting accumulator for a rebuild. */
export function emptyGamification(): GamificationState {
  return {
    balance: 0,
    lifetimePoints: 0,
    currentDayStreak: 0,
    longestDayStreak: 0,
    currentSessionRun: 0,
    lastActiveDate: null,
    streakFreezesAvailable: 1,
    unlockedTitles: [],
  };
}

/** The part of a session that the economy actually reads. */
export interface ScorableSession {
  readonly type: string;
  readonly status: string;
  /** User-local day this record counts toward — see `attributionDate`. */
  readonly attributionDate: string;
}

export interface AppliedSession {
  readonly state: GamificationState;
  readonly pointsAwarded: number;
  /** Titles crossed by THIS session, so the response can announce them exactly once. */
  readonly newlyUnlocked: readonly string[];
}

/** Advance the day streak, given the day this completion counts toward. */
function advanceDayStreak(
  state: GamificationState,
  day: string,
): { currentDayStreak: number; longestDayStreak: number; lastActiveDate: string } {
  const last = state.lastActiveDate;

  // First ever completion.
  if (!last) {
    return {
      currentDayStreak: 1,
      longestDayStreak: Math.max(1, state.longestDayStreak),
      lastActiveDate: day,
    };
  }

  // Already counted today — a streak counts days, not sessions.
  if (day === last) {
    return {
      currentDayStreak: state.currentDayStreak,
      longestDayStreak: state.longestDayStreak,
      lastActiveDate: last,
    };
  }

  /*
   * Backdated: this record belongs to a day at or before the one already counted. It is stored,
   * but it does not touch the streak and does not move the marker. Allowing it to would let
   * someone mend a broken streak by flushing a stale record, which is exactly what the
   * attribution rule above exists to prevent.
   */
  if (day < last) {
    return {
      currentDayStreak: state.currentDayStreak,
      longestDayStreak: state.longestDayStreak,
      lastActiveDate: last,
    };
  }

  const continued = day === nextDateKey(last);
  const next = continued ? state.currentDayStreak + 1 : 1;
  return {
    currentDayStreak: next,
    longestDayStreak: Math.max(state.longestDayStreak, next),
    lastActiveDate: day,
  };
}

/**
 * Fold one session into the projection. The single scoring authority, and the single replay step.
 *
 * Three cases, and only the first of them changes a number:
 *   completed focus  → +100, plus +50 when the resulting run is a multiple of 3; day streak may advance
 *   terminated focus → 0 points, session run resets, day streak untouched
 *   any break        → nothing at all
 */
export function applySession(state: GamificationState, session: ScorableSession): AppliedSession {
  if (session.type !== 'focus') {
    return { state, pointsAwarded: 0, newlyUnlocked: [] };
  }

  if (session.status === 'terminated') {
    /*
     * The day streak is deliberately untouched: the user may already have completed a session
     * today, and taking that away for stopping a later one would punish them twice for one
     * decision — once by the reset, once by having tried again.
     */
    return {
      state: { ...state, currentSessionRun: 0 },
      pointsAwarded: 0,
      newlyUnlocked: [],
    };
  }

  const currentSessionRun = state.currentSessionRun + 1;
  const bonus = currentSessionRun % POINTS.consecutiveThreshold === 0 ? POINTS.consecutiveBonus : 0;
  const pointsAwarded = POINTS.sessionComplete + bonus;

  const lifetimePoints = state.lifetimePoints + pointsAwarded;
  const before = state.unlockedTitles;
  const unlockedTitles = titlesFor(lifetimePoints);
  const newlyUnlocked = unlockedTitles.filter((key) => !before.includes(key));

  const streak = advanceDayStreak(state, session.attributionDate);

  return {
    state: {
      ...state,
      balance: state.balance + pointsAwarded,
      lifetimePoints,
      currentSessionRun,
      unlockedTitles,
      ...streak,
    },
    pointsAwarded,
    newlyUnlocked,
  };
}
