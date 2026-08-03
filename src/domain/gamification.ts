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
 *
 * STREAK FREEZES ARE SPENT BY THE FOLD, NOT BY A CLOCK — and that is what keeps them replayable.
 * `resolveElapsedDays` takes the day to resolve to as an argument, and on the write path that
 * argument is the session's stored `attribution_date`. So a rebuild replays every spend and every
 * grant exactly, because both are functions of the event stream and nothing else.
 *
 * The read path calls the same function with the user-local date NOW, which is not in the event
 * stream — so what it returns is DISPLAY ONLY AND IS NEVER PERSISTED. This is the one place
 * ADR-014's wording ("and persists the result") could not be taken literally: persisting a
 * resolution that depends on when somebody happened to look would make the projection unrebuildable
 * and break ADR-006. The user sees exactly what ADR-014 promised; the row keeps its integrity.
 * CONTRACT.md §14.6 records the trade in full.
 */

export const POINTS = {
  /** Flat, regardless of length: the block was completed or it was not. */
  sessionComplete: 100,
  consecutiveBonus: 50,
  /** The bonus fires on every Nth consecutive completion. */
  consecutiveThreshold: 3,
} as const;

/**
 * The freeze economy, in one place so balancing is a one-line change (CONTRACT.md §14.6).
 *
 * A freeze buys back ONE missed day of `currentDayStreak`. It has no bearing on
 * `currentSessionRun`, which counts sessions rather than days and resets on a termination.
 */
export const STREAK_FREEZE = {
  /**
   * Missed days a single freeze covers. One, deliberately: a freeze is insurance against the day
   * life got in the way, not a way to be absent for a week and keep the number. Two missed days is
   * a broken streak whatever is banked — a freeze is never spent on a gap it cannot close.
   */
  coversMissedDays: 1,
  /** A freeze is earned each time the day streak reaches a multiple of this. */
  grantEveryDays: 7,
  /** The ceiling, so freezes cannot be hoarded into a long absence. */
  maxAvailable: 2,
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

/** Whole calendar days from one key to another. Date-only, so no DST hour can round it wrong. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
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
  /**
   * User-local 'YYYY-MM-DD' of the last completed focus session, or null.
   *
   * ALSO THE FREEZE MARKER. When a freeze covers a missed day this advances onto the covered day,
   * which is what makes the same gap impossible to pay for twice — no second column is needed to
   * remember that a day was bought.
   */
  readonly lastActiveDate: string | null;
  readonly streakFreezesAvailable: number;
  /** User-local 'YYYY-MM-DD' a freeze was last granted on, or null. Caps granting at one a day. */
  readonly lastFreezeGrantedOn: string | null;
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
    lastFreezeGrantedOn: null,
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
  /**
   * Freezes spent by THIS session — 0 or 1 — so the response can announce a covered day exactly
   * once, for the same reason `newlyUnlocked` exists.
   *
   * A transient signal about the request, not stored state: the count itself is
   * `state.streakFreezesAvailable`. Without it the client cannot tell a spend from a grant going
   * the other way, because a session that covers a missed day and then reaches a multiple of seven
   * moves the count by nothing at all.
   */
  readonly freezesSpent: number;
}

/**
 * Resolve the passage of time up to `today` — the lazy streak resolution of ADR-014, and the whole
 * reason there is no nightly job. A per-timezone sweep on a scale-to-zero host is infrastructure
 * that costs money and may not run; asking "what have the intervening days done to this streak?"
 * at the moment somebody looks produces the same answer for free.
 *
 * PURE, AND PURE IN `today` — it reads no clock of its own. That is what lets the same function
 * serve two callers that must not diverge: the write fold passes the day a completion counts
 * toward, and the read path passes the user-local date now. One rule, two entry points.
 *
 * WHICHEVER CALLER USES IT, WHAT IT RETURNS IS ONLY PERSISTED ON THE WRITE PATH. The read path
 * projects forward for display and stores nothing — see the note on replay equivalence at the top
 * of this file, and CONTRACT.md §14.6.
 *
 * Idempotent: applied twice with the same `today`, the second call is a no-op, because either the
 * marker has already moved past the gap or the streak is already zero.
 */
export function resolveElapsedDays(state: GamificationState, today: string): GamificationState {
  const last = state.lastActiveDate;

  // Nothing to lose: no streak has been started, or it has already lapsed.
  if (!last || state.currentDayStreak === 0) return state;

  const missedDays = daysBetween(last, today) - 1;

  /*
   * Nothing has been missed yet. `today` is either the active day itself or the very next one,
   * which the user still has in front of them — a streak is broken by a day that ENDED empty, not
   * by one still in progress. A clock that skews backwards lands here too, harmlessly.
   */
  if (missedDays <= 0) return state;

  /*
   * Exactly one missed day, and something banked to cover it. The marker moves onto the covered
   * day rather than to `today`: the gap is now closed, so a second resolution cannot charge for it
   * again, and the streak count itself is untouched because no new day has been earned.
   */
  if (missedDays === STREAK_FREEZE.coversMissedDays && state.streakFreezesAvailable > 0) {
    return {
      ...state,
      lastActiveDate: nextDateKey(last),
      streakFreezesAvailable: state.streakFreezesAvailable - 1,
    };
  }

  /*
   * More missed days than a freeze can close, or nothing left to close one with. The marker stays
   * where it was — it records the last day actually worked, and moving it would invent activity.
   */
  return { ...state, currentDayStreak: 0 };
}

/**
 * Bank a freeze for a streak that has reached another multiple of `grantEveryDays`.
 *
 * Granting is a pure function of the streak the fold just produced, which is what keeps it
 * replayable — nothing here reads a clock, a calendar, or a wall-clock elapsed time.
 */
function grantFreeze(state: GamificationState, day: string): GamificationState {
  if (state.currentDayStreak === 0) return state;
  if (state.currentDayStreak % STREAK_FREEZE.grantEveryDays !== 0) return state;
  if (state.streakFreezesAvailable >= STREAK_FREEZE.maxAvailable) return state;
  // At most one grant per user-local day, whatever else that day contains.
  if (state.lastFreezeGrantedOn === day) return state;

  return {
    ...state,
    streakFreezesAvailable: state.streakFreezesAvailable + 1,
    lastFreezeGrantedOn: day,
  };
}

/** Advance the day streak, given the day this completion counts toward. */
function advanceDayStreak(state: GamificationState, day: string): GamificationState {
  const last = state.lastActiveDate;

  // First ever completion.
  if (!last) {
    return {
      ...state,
      currentDayStreak: 1,
      longestDayStreak: Math.max(1, state.longestDayStreak),
      lastActiveDate: day,
    };
  }

  /*
   * Already counted today — a streak counts days, not sessions — or backdated, meaning this record
   * belongs to a day at or before the one already counted. A backdated record is stored, but it
   * does not touch the streak, does not move the marker, and cannot spend or earn a freeze.
   * Allowing it to would let someone mend a broken streak by flushing a stale record, which is
   * exactly what the attribution rule above exists to prevent (ADR-011).
   */
  if (day <= last) return state;

  // What the intervening days did to the streak — including spending a freeze to survive them.
  const resolved = resolveElapsedDays(state, day);
  const currentDayStreak = resolved.currentDayStreak + 1;

  return {
    ...resolved,
    currentDayStreak,
    longestDayStreak: Math.max(resolved.longestDayStreak, currentDayStreak),
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
    return { state, pointsAwarded: 0, newlyUnlocked: [], freezesSpent: 0 };
  }

  if (session.status === 'terminated') {
    /*
     * The day streak is deliberately untouched: the user may already have completed a session
     * today, and taking that away for stopping a later one would punish them twice for one
     * decision — once by the reset, once by having tried again.
     *
     * NO FREEZE IS SPENT HERE EITHER, and that follows from the same rule: terminating costs
     * nothing, and paying a freeze for an honest early stop would be a cost. Elapsed days are
     * resolved by the next COMPLETION, which is the only event that can extend the streak a freeze
     * exists to protect.
     */
    return {
      state: { ...state, currentSessionRun: 0 },
      pointsAwarded: 0,
      newlyUnlocked: [],
      freezesSpent: 0,
    };
  }

  const currentSessionRun = state.currentSessionRun + 1;
  const bonus = currentSessionRun % POINTS.consecutiveThreshold === 0 ? POINTS.consecutiveBonus : 0;
  const pointsAwarded = POINTS.sessionComplete + bonus;

  const lifetimePoints = state.lifetimePoints + pointsAwarded;
  const before = state.unlockedTitles;
  const unlockedTitles = titlesFor(lifetimePoints);
  const newlyUnlocked = unlockedTitles.filter((key) => !before.includes(key));

  /*
   * Streak first, then the grant that the resulting streak may have earned. In that order a single
   * session can legitimately do both — cover a missed day out of the bank, then reach a multiple of
   * seven and put one back.
   */
  const streaked = advanceDayStreak(state, session.attributionDate);

  /*
   * Measured before the grant, not after. `advanceDayStreak` never grants, so the difference across
   * it is the spend alone — whereas comparing the final count to the original would report zero for
   * a session that both covered a missed day and earned one back, which is the case the client most
   * needs told about.
   */
  const freezesSpent = Math.max(0, state.streakFreezesAvailable - streaked.streakFreezesAvailable);
  const resolved = grantFreeze(streaked, session.attributionDate);

  return {
    state: {
      ...resolved,
      balance: state.balance + pointsAwarded,
      lifetimePoints,
      currentSessionRun,
      unlockedTitles,
    },
    pointsAwarded,
    newlyUnlocked,
    freezesSpent,
  };
}
