import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/*
 * Periodic email reports — pure rules, framework-free and ORM-free (enforced by eslint on
 * src/domain).
 *
 * Three things live here and nothing else does: the vocabulary (statuses, frequencies, and what
 * each one means), the period arithmetic (CONTRACT.md §24.2), and the confirmation-token primitives
 * (§23.3). All of it is a pure function of its arguments — no clock, no database, no config — which
 * is what lets the timezone and DST cases be tested exhaustively without either.
 *
 * THE TIMEZONE ARRIVES AS AN ARGUMENT, ALWAYS. `users.timezone` is the single interpretation key
 * (CONTRACT.md §1.3) and `report_subscriptions` deliberately does not copy it (§23.0 consequence 1),
 * so every function below that needs one is handed it by the caller that read the user row. There is
 * no default and no fallback to the server's zone — the server runs in UTC and that belongs to
 * nobody.
 */

/* ------------------------------------------------------------------ Vocabulary -- */

/** How often a report is sent. Stored on the subscription even while it is switched off. */
export const REPORT_FREQUENCIES = ['weekly', 'monthly'] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

/**
 * Every status a stored subscription can hold (CONTRACT.md §23.1).
 *
 * `declined` and `unsubscribed` are both "off", and they are deliberately separate. Declining is an
 * answer given before anything was ever sent; unsubscribing is an answer given by someone who was
 * receiving reports and stopped. The state a user is in is the only record of which conversation
 * they had, and the copy differs accordingly.
 *
 * `bounced` is not an answer at all — it is what delivery failure did to a subscription the user
 * never withdrew, which is why the UI must not render it as though they chose it.
 */
export const SUBSCRIPTION_STATUSES = [
  'pending_confirmation',
  'active',
  'paused',
  'declined',
  'unsubscribed',
  'bounced',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * What the API reports for an account with **no row at all**.
 *
 * Never stored — there is no `unasked` in the table, because the absence of the row *is* the state.
 * That is the whole point of §23.0 consequence 3: "asked, said no" is a `declined` row and "never
 * asked" is no row, and only keeping them apart lets the one-time invitation know whether it has
 * already had its answer. A Google-created account is permanently in this state until it opens
 * Settings, because the OAuth callback has no form to answer (§23.0 consequence 2).
 */
export const UNASKED = 'unasked' as const;

/** The status as a caller outside the table sees it: what is stored, or the absence of a row. */
export type SubscriptionState = SubscriptionStatus | typeof UNASKED;

/** The three answers `PUT /me/reports` accepts. `none` is an answer, not the absence of one. */
export const FREQUENCY_CHOICES = [...REPORT_FREQUENCIES, 'none'] as const;
export type FrequencyChoice = (typeof FREQUENCY_CHOICES)[number];

/** Statuses that mean a report is expected to go out. Nothing else is ever selected for delivery. */
export function isDeliverable(status: SubscriptionStatus): boolean {
  return status === 'active';
}

/** Weekly reports are delivered on Monday (T1). 1 = Monday … 7 = Sunday, matching ISO-8601. */
export const DEFAULT_DELIVERY_DAY = 1;

/** 08:00 in the account's own timezone (T2). Fixed, not a preference — there is no column for it. */
export const DELIVERY_HOUR = 8;

/** A confirmation link is good for seven days (§23.3). */
export const CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How many consecutive soft bounces pause a subscription, and for how long (§25.6). */
export const SOFT_BOUNCE_LIMIT = 3;
export const SOFT_BOUNCE_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ Activation -- */

/**
 * What choosing a frequency does, given what is known about the address (§25.2, L3).
 *
 * A Google-verified address activates immediately; anything else has to prove it can receive mail
 * first. This is the whole of the L3 rule and it is one line, deliberately: the decision is made
 * here so that no controller, service, or repository is in a position to make a different one.
 */
export function resolveActivation(emailVerified: boolean): 'active' | 'pending_confirmation' {
  return emailVerified ? 'active' : 'pending_confirmation';
}

/* ----------------------------------------------------------------------- Tokens -- */

/**
 * A fresh link credential: 32 random bytes, base64url. Returned in the clear exactly once, to be
 * put in an email and then forgotten — only its hash is ever stored (§23.3).
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256, hex. The token is high-entropy random, so a password KDF would buy nothing. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Compare a presented token against a stored hash without leaking, through timing, how much of it
 * was right. Both sides are fixed-length hex by construction, so length can never differ here — the
 * guard is for a stored value that is somehow malformed rather than for an attacker-chosen one.
 */
export function tokenMatches(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

/* ----------------------------------------------------------------- Local dates -- */

/**
 * A calendar date in some timezone, as `YYYY-MM-DD`.
 *
 * Periods are expressed in dates rather than instants on purpose (§24.2). A DST day is 23 or 25
 * hours long, so anything that counted elapsed milliseconds between two local midnights would be
 * wrong twice a year; nothing here counts milliseconds, so there is no DST case to handle.
 */
export type LocalDate = string;

/**
 * The calendar date `instant` falls on, in `timeZone`.
 *
 * The formatter is built per call with an **explicit `timeZone`**, never reused from a module-level
 * instance. A shared formatter would have to be created without one, and a formatter without a
 * timeZone silently uses the host's — which on this deployment is UTC, so every account west of
 * Greenwich would have its evenings filed under the following day. `en-CA` is chosen only because
 * it renders ISO-ordered `YYYY-MM-DD`.
 */
export function localDate(instant: Date, timeZone: string): LocalDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The hour of day (0–23) `instant` falls in, in `timeZone`. */
export function localHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(instant);

  // `hourCycle: 'h23'` is not universally honoured through `hour12: false`; some ICU builds render
  // midnight as "24". Normalising is cheaper than depending on which one shipped.
  return Number(hour) % 24;
}

/** ISO weekday for a local date: 1 = Monday … 7 = Sunday. */
export function weekdayOf(date: LocalDate): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Day of the month for a local date. */
export function dayOfMonth(date: LocalDate): number {
  return Number(date.slice(8, 10));
}

/* ---------------------------------------------------------------------- Periods -- */

/** The closed range a report covers, as user-local dates. Both ends inclusive. */
export interface ReportPeriod {
  readonly kind: ReportFrequency;
  readonly start: LocalDate;
  readonly end: LocalDate;
}

/** Shift a local date by whole days. Pure calendar arithmetic — no zone, no clock, no DST. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The most recent **complete** period ending before `today`.
 *
 * Complete is the operative word (P8). A subscription confirmed on a Wednesday does not produce a
 * three-day report; its first report covers the first whole week or month after it was confirmed.
 * There is no partial period anywhere in this feature.
 *
 * @param kind   weekly → the Monday–Sunday week that has ended; monthly → the calendar month (T4).
 * @param today  The user-local date the worker is running on.
 */
export function previousPeriod(kind: ReportFrequency, today: LocalDate): ReportPeriod {
  if (kind === 'weekly') {
    // Back up to this week's Monday, then take the seven days before it.
    const thisMonday = addDays(today, -(weekdayOf(today) - 1));
    const start = addDays(thisMonday, -7);
    return { kind, start, end: addDays(start, 6) };
  }

  // The calendar month before the one `today` is in. Day 0 of a month is the last day of the one
  // before it, which is how the end date avoids a table of month lengths and a leap-year rule.
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const start = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
  return { kind, start, end };
}

/**
 * Whether a subscription's report is due at this instant, in the account's own zone.
 *
 * Due means: the right local day, and the delivery hour. The worker ticks hourly (§26.1), so this
 * answers true for exactly one tick per period per account — and the delivery ledger's unique
 * constraint (§23.2) is what makes a second tick in the same hour harmless anyway.
 */
export function isDueAt(
  frequency: ReportFrequency,
  deliveryDay: number,
  now: Date,
  timeZone: string,
): boolean {
  if (localHour(now, timeZone) !== DELIVERY_HOUR) return false;

  const today = localDate(now, timeZone);
  return frequency === 'weekly' ? weekdayOf(today) === deliveryDay : dayOfMonth(today) === 1;
}

/* ------------------------------------------------------------- Aggregation -- */

/*
 * THE FOUR COUNTING RULES (CONTRACT.md §24.1), and the reason this is a pure function.
 *
 * The report and the History page must produce the same numbers from the same records, in two
 * languages, in two npm packages with no shared workspace between them. What holds them together is
 * this section, the mirrored fixture vectors in `test/fixtures/counting-vectors.ts`, and nothing
 * else — so every rule is stated here rather than being implied by the code that happens to
 * implement it:
 *
 *   1. FOCUS ONLY. `type === 'focus'`. Break intervals are recorded and never counted; letting them
 *      through roughly doubles every figure the product reports (edge case E12).
 *   2. TERMINATED BLOCKS COUNT TOWARD FOCUS MINUTES. A block honestly ended after twenty minutes was
 *      twenty minutes of focus. Session *counts* still split completed from terminated.
 *      `actualDurationMs` is server-clamped before it is stored (§15.1), so summing is safe.
 *   3. POINTS ARE LIFETIME POINTS, never the balance. The caption says "earned" (defect F5).
 *   4. `endedAt` DECIDES THE BUCKET. The day-streak is decided by `attributionDate` and the two
 *      differ by design for a block spanning local midnight (edge case E8). Neither may be
 *      "fixed" to match the other.
 *
 * Rule 4 is also what decides period membership: a session belongs to the period its `endedAt` falls
 * in, resolved in the account's own timezone.
 */

/** A session, reduced to the fields any report figure is computed from. */
export interface ReportSessionInput {
  readonly type: string;
  readonly status: string;
  readonly endedAt: Date;
  readonly actualDurationMs: number;
  /** The title as the user saw it while focusing. Survives renaming and deleting the task. */
  readonly taskTitleSnapshot: string;
  readonly terminationReason: string | null;
}

/** The progression projection, reduced to what a report renders (§24.5). */
export interface ReportProgressInput {
  readonly lifetimePoints: number;
  readonly currentDayStreak: number;
  readonly longestDayStreak: number;
}

export interface ReportTotals {
  readonly completedSessions: number;
  readonly terminatedSessions: number;
  readonly totalSessions: number;
  readonly focusMinutes: number;
  /** Whole percent, 0 when nothing was recorded. Mirrors `summarize()` exactly. */
  readonly completionRate: number;
}

export const EMPTY_TOTALS: ReportTotals = {
  completedSessions: 0,
  terminatedSessions: 0,
  totalSessions: 0,
  focusMinutes: 0,
  completionRate: 0,
};

/** One column of the breakdown chart. */
export interface ReportBucket {
  readonly label: string;
  readonly completed: number;
  readonly terminated: number;
  readonly focusMinutes: number;
}

export interface ReportTaskRow {
  readonly title: string;
  readonly sessions: number;
  readonly focusMinutes: number;
}

export interface ReportTerminationRow {
  readonly reason: string;
  readonly count: number;
}

/** At most ten task rows, then a count of the rest (P12). */
export const MAX_TASK_ROWS = 10;

/** Titles are truncated for layout, not for safety — they are text nodes either way (§26.4). */
export const TASK_TITLE_MAX = 60;

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Rule 1. Every figure in a report is computed from this list and never from the raw one. */
export function focusOnly(sessions: readonly ReportSessionInput[]): ReportSessionInput[] {
  return sessions.filter((session) => session.type === 'focus');
}

/**
 * Rule 4 applied to membership: the period a session belongs to is decided by where its `endedAt`
 * falls in the account's own timezone — not the server's, and not by `startedAt`.
 */
export function sessionsInPeriod(
  sessions: readonly ReportSessionInput[],
  period: ReportPeriod,
  timeZone: string,
): ReportSessionInput[] {
  return focusOnly(sessions).filter((session) => {
    const day = localDate(session.endedAt, timeZone);
    return day >= period.start && day <= period.end;
  });
}

/**
 * Rules 1 and 2. The exact server-side mirror of `summarize()`'s session half.
 *
 * Expects a list that has already been narrowed to the period; it applies rule 1 again anyway,
 * because a caller passing raw sessions would otherwise double every figure silently.
 */
export function summarizeSessions(sessions: readonly ReportSessionInput[]): ReportTotals {
  const focus = focusOnly(sessions);
  const completedSessions = focus.filter((session) => session.status === 'completed').length;
  const terminatedSessions = focus.filter((session) => session.status === 'terminated').length;
  const totalSessions = completedSessions + terminatedSessions;

  // Rule 2: every focus block contributes its clamped actual duration, terminated included.
  const focusMs = focus.reduce(
    (sum, session) =>
      sum + (Number.isFinite(session.actualDurationMs) ? session.actualDurationMs : 0),
    0,
  );

  return {
    completedSessions,
    terminatedSessions,
    totalSessions,
    focusMinutes: Math.round(focusMs / 60000),
    completionRate: totalSessions > 0 ? Math.round((completedSessions / totalSessions) * 100) : 0,
  };
}

/**
 * The breakdown chart's columns: one per local day for a weekly report, one per part-week for a
 * monthly one (§24.5).
 *
 * Every bucket in the period is emitted, including the empty ones. A chart that silently omitted
 * the days someone did not focus would flatter them, and would also make two reports of the same
 * length different widths.
 */
export function buildBuckets(
  sessions: readonly ReportSessionInput[],
  period: ReportPeriod,
  timeZone: string,
): ReportBucket[] {
  const days: LocalDate[] = [];
  for (let day = period.start; day <= period.end; day = addDays(day, 1)) days.push(day);

  const tally = new Map<LocalDate, { completed: number; terminated: number; focusMs: number }>();
  for (const day of days) tally.set(day, { completed: 0, terminated: 0, focusMs: 0 });

  for (const session of sessionsInPeriod(sessions, period, timeZone)) {
    const entry = tally.get(localDate(session.endedAt, timeZone));
    if (!entry) continue;
    if (session.status === 'completed') entry.completed += 1;
    else if (session.status === 'terminated') entry.terminated += 1;
    entry.focusMs += Number.isFinite(session.actualDurationMs) ? session.actualDurationMs : 0;
  }

  if (period.kind === 'weekly') {
    return days.map((day) => {
      const entry = tally.get(day)!;
      return {
        label: WEEKDAY_LABELS[weekdayOf(day) - 1],
        completed: entry.completed,
        terminated: entry.terminated,
        focusMinutes: Math.round(entry.focusMs / 60000),
      };
    });
  }

  /*
   * A month is chunked on Monday boundaries and clipped to the month, so the first and last columns
   * are usually short. Labelled by day range rather than "week 1", which would invite the reader to
   * count weeks that do not line up with any calendar they own.
   */
  const chunks: LocalDate[][] = [];
  for (const day of days) {
    if (chunks.length === 0 || weekdayOf(day) === 1) chunks.push([]);
    chunks[chunks.length - 1].push(day);
  }

  return chunks.map((chunk) => {
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    const totals = chunk.reduce(
      (accumulator, day) => {
        const entry = tally.get(day)!;
        return {
          completed: accumulator.completed + entry.completed,
          terminated: accumulator.terminated + entry.terminated,
          focusMs: accumulator.focusMs + entry.focusMs,
        };
      },
      { completed: 0, terminated: 0, focusMs: 0 },
    );

    return {
      label: first === last ? `${dayOfMonth(first)}` : `${dayOfMonth(first)}–${dayOfMonth(last)}`,
      completed: totals.completed,
      terminated: totals.terminated,
      focusMinutes: Math.round(totals.focusMs / 60000),
    };
  });
}

/**
 * The task table: the ten titles with the most focus time in the period, then a count of the rest.
 *
 * Grouped by `taskTitleSnapshot` rather than by task id, and that is deliberate rather than
 * convenient. The snapshot is what the user saw while focusing; the task itself may since have been
 * renamed or deleted, and a report that retitled last month's work would be rewriting history the
 * event log exists to preserve (§13.2). It also means the report never needs to read `tasks` at all,
 * so a deleted task cannot make a report fail.
 */
export function topTasks(
  sessions: readonly ReportSessionInput[],
  limit: number = MAX_TASK_ROWS,
): { readonly rows: ReportTaskRow[]; readonly remaining: number } {
  const byTitle = new Map<string, { sessions: number; focusMs: number }>();

  for (const session of focusOnly(sessions)) {
    const entry = byTitle.get(session.taskTitleSnapshot) ?? { sessions: 0, focusMs: 0 };
    entry.sessions += 1;
    entry.focusMs += Number.isFinite(session.actualDurationMs) ? session.actualDurationMs : 0;
    byTitle.set(session.taskTitleSnapshot, entry);
  }

  const ordered = [...byTitle.entries()]
    .map(([title, entry]) => ({
      title,
      sessions: entry.sessions,
      focusMinutes: Math.round(entry.focusMs / 60000),
    }))
    // Minutes first, then sessions, then title — a total order, so the same data always renders
    // in the same sequence and two runs of one report are byte-comparable.
    .sort(
      (a, b) =>
        b.focusMinutes - a.focusMinutes ||
        b.sessions - a.sessions ||
        a.title.localeCompare(b.title),
    );

  return { rows: ordered.slice(0, limit), remaining: Math.max(0, ordered.length - limit) };
}

/**
 * Raw counts per termination reason, most frequent first (P10).
 *
 * Counts only. This is deliberately **not** the deferred focus-insight panel (N1, §21): there is no
 * comparison across periods and nothing here tells the user anything they did not already say when
 * they picked the reason.
 */
export function terminationCounts(sessions: readonly ReportSessionInput[]): ReportTerminationRow[] {
  const counts = new Map<string, number>();

  for (const session of focusOnly(sessions)) {
    if (session.status !== 'terminated' || !session.terminationReason) continue;
    counts.set(session.terminationReason, (counts.get(session.terminationReason) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Everything a rendered report contains. Nothing outside this shape reaches the document. */
export interface ReportData {
  readonly period: ReportPeriod;
  readonly periodLabel: string;
  readonly previousPeriodLabel: string;
  readonly timeZone: string;
  readonly firstName: string;
  readonly generatedAt: Date;
  readonly totals: ReportTotals;
  readonly previousTotals: ReportTotals;
  readonly buckets: readonly ReportBucket[];
  readonly tasks: readonly ReportTaskRow[];
  readonly remainingTasks: number;
  readonly terminations: readonly ReportTerminationRow[];
  readonly lifetimePoints: number;
  readonly currentDayStreak: number;
  readonly longestDayStreak: number;
}

/**
 * `Mon 27 Jul – Sun 2 Aug 2026` for a week, `July 2026` for a month (§27).
 *
 * Built from the date parts directly rather than through `Intl`, because the period is already a
 * local calendar range: handing `YYYY-MM-DD` back to a formatter would mean re-interpreting it in
 * some timezone, which is exactly the round trip that puts a report one day out.
 */
export function formatPeriodLabel(period: ReportPeriod): string {
  const monthName = (date: LocalDate) => MONTH_LABELS[Number(date.slice(5, 7)) - 1];

  if (period.kind === 'monthly') {
    return `${monthName(period.start)} ${period.start.slice(0, 4)}`;
  }

  const startYear = period.start.slice(0, 4);
  const endYear = period.end.slice(0, 4);
  const start = `${WEEKDAY_LABELS[weekdayOf(period.start) - 1]} ${dayOfMonth(period.start)} ${monthName(period.start)}`;
  const end = `${WEEKDAY_LABELS[weekdayOf(period.end) - 1]} ${dayOfMonth(period.end)} ${monthName(period.end)}`;

  return startYear === endYear
    ? `${start} – ${end} ${endYear}`
    : `${start} ${startYear} – ${end} ${endYear}`;
}

/** The period immediately before this one, for the comparison column. */
export function precedingPeriod(period: ReportPeriod): ReportPeriod {
  return period.kind === 'weekly'
    ? { kind: 'weekly', start: addDays(period.start, -7), end: addDays(period.start, -1) }
    : previousPeriod('monthly', period.start);
}

/**
 * The whole fold, in one pure call.
 *
 * Takes every session the caller loaded — the period and the one before it — and decides membership
 * itself, so the repository never has to know a counting rule. Nothing here reads a clock: even
 * `generatedAt` is supplied, which is what makes a report reproducible from the event log.
 */
export function buildReport(input: {
  readonly period: ReportPeriod;
  readonly timeZone: string;
  readonly firstName: string;
  readonly generatedAt: Date;
  readonly sessions: readonly ReportSessionInput[];
  readonly progress: ReportProgressInput;
}): ReportData {
  const previous = precedingPeriod(input.period);
  const current = sessionsInPeriod(input.sessions, input.period, input.timeZone);
  const before = sessionsInPeriod(input.sessions, previous, input.timeZone);
  const tasks = topTasks(current);

  return {
    period: input.period,
    periodLabel: formatPeriodLabel(input.period),
    previousPeriodLabel: formatPeriodLabel(previous),
    timeZone: input.timeZone,
    firstName: input.firstName,
    generatedAt: input.generatedAt,
    totals: summarizeSessions(current),
    previousTotals: summarizeSessions(before),
    buckets: buildBuckets(current, input.period, input.timeZone),
    tasks: tasks.rows,
    remainingTasks: tasks.remaining,
    terminations: terminationCounts(current),
    // Rule 3.
    lifetimePoints: input.progress.lifetimePoints,
    currentDayStreak: input.progress.currentDayStreak,
    longestDayStreak: input.progress.longestDayStreak,
  };
}

/** True when the period held no focus work at all — the P7 skip condition. */
export function isEmptyReport(data: ReportData): boolean {
  return data.totals.totalSessions === 0;
}

/* ------------------------------------------------------------ Retry policy -- */

/*
 * With no queue, the retry ladder is written here rather than inherited from one (§26.3, ADR-014
 * rev. 2). It is a pure function of the attempt count and the provider's answer, so every branch is
 * testable without a provider, a clock, or a database.
 */

/** After this many attempts a delivery is abandoned rather than retried forever. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Backoff ceiling. Beyond a day, a report about last week has stopped being worth sending. */
export const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

export type RetryDecision =
  | { readonly kind: 'retry'; readonly at: Date }
  | { readonly kind: 'failed' }
  | { readonly kind: 'abandoned' };

/**
 * Whether a failed send is worth another attempt, and when.
 *
 * ONLY TEMPORARY FAILURES ARE RETRIED. A network that never answered (status 0), a provider 5xx, or
 * a 429 are all conditions that may not hold in an hour. A 4xx is not: a rejected address or a
 * malformed payload will be rejected identically next time, and retrying it five times turns one
 * failure into five identical ones against an address that already said no.
 *
 * **A message the provider accepted is never here at all.** Acceptance ends the delivery — a `sent`
 * row is terminal, and a later "delayed" webhook does not reopen it (§25.6). Re-sending because
 * delivery is slow is how one report becomes three.
 *
 * @param attempts How many attempts have already been made, including the one that just failed.
 */
export function decideRetry(attempts: number, status: number, now: Date): RetryDecision {
  const temporary = status === 0 || status === 429 || status >= 500;
  if (!temporary) return { kind: 'failed' };
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return { kind: 'abandoned' };

  // 1h, 2h, 4h, 8h… capped. The tick is hourly, so anything finer than an hour is not achievable
  // anyway — the schedule is the floor on retry latency, and that is recorded rather than hidden.
  const delay = Math.min(2 ** Math.max(0, attempts - 1) * 60 * 60 * 1000, MAX_RETRY_DELAY_MS);
  return { kind: 'retry', at: new Date(now.getTime() + delay) };
}

/* --------------------------------------------------------- Delivery events -- */

/**
 * What a provider event means for the subscription behind it (§25.6).
 *
 * The provider's vocabulary is translated into ours exactly once, here, so no service is in a
 * position to decide that a complaint is "sort of like" a soft bounce.
 */
export type DeliveryEffect =
  'none' | 'delivered' | 'soft_bounce' | 'disable_bounced' | 'disable_complaint';

/**
 * Map a provider event onto its effect.
 *
 * `delayed` is deliberately `none`. It means the provider is still trying, and the message has
 * already been accepted — treating it as a failure would re-send a report that is about to arrive.
 * `sent`, `opened` and `clicked` are `none` for the opposite reason: nothing about the subscription
 * changed, and this product does not track opens or clicks at all (P13).
 *
 * An event this build has never heard of is `none`, never an error. A webhook that 500s on an
 * unrecognised payload gets the endpoint disabled by the provider, which costs us every bounce
 * notice — a far worse outcome than ignoring one event.
 *
 * @param bounceType The provider's own classification, when it sends one. Anything that is not
 *   explicitly transient is treated as permanent: guessing "temporary" about an address that does
 *   not exist keeps mailing it, which is precisely what damages a sending reputation.
 */
export function classifyDeliveryEvent(type: string, bounceType?: string | null): DeliveryEffect {
  switch (type) {
    case 'email.delivered':
      return 'delivered';

    case 'email.bounced': {
      const transient = (bounceType ?? '').toLowerCase();
      return transient === 'transient' || transient === 'soft' ? 'soft_bounce' : 'disable_bounced';
    }

    case 'email.complained':
      return 'disable_complaint';

    /*
     * The provider's suppression list already refuses this address — it bounced hard for somebody,
     * or somebody complained. Continuing to queue reports for it achieves nothing and keeps the
     * account looking active.
     */
    case 'email.suppressed':
      return 'disable_bounced';

    /*
     * The provider could not send at all. Terminal for THIS delivery and recorded as such, but not
     * a judgement about the address, so the subscription survives.
     */
    case 'email.failed':
      return 'none';

    // 'email.delivery_delayed', 'email.sent', 'email.opened', 'email.clicked', and anything new.
    default:
      return 'none';
  }
}

/* ------------------------------------------------------ Webhook signatures -- */

/** Replay window for a signed webhook. Svix's own default, and a generous one. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Verify a Svix-style signature over the RAW request body (§25.6).
 *
 * Three things are checked, and dropping any one of them makes the check decorative:
 *
 *   1. The HMAC covers `id.timestamp.body`, so neither the id nor the timestamp can be altered
 *      without invalidating it.
 *   2. The timestamp is within tolerance, so a captured request cannot be replayed tomorrow.
 *   3. The comparison is constant-time, so the endpoint does not become an oracle for guessing a
 *      signature byte by byte.
 *
 * The header may carry several space-separated `v1,<signature>` entries during a secret rotation;
 * any one matching is a pass.
 *
 * @param secret The provider's signing secret, `whsec_<base64>`.
 * @param rawBody The exact bytes received — never a re-serialised object.
 */
export function verifyWebhookSignature(input: {
  readonly secret: string;
  readonly id: string;
  readonly timestamp: string;
  readonly signatureHeader: string;
  readonly rawBody: Buffer;
  readonly now: Date;
}): boolean {
  const seconds = Number(input.timestamp);
  if (!Number.isFinite(seconds)) return false;
  if (Math.abs(input.now.getTime() - seconds * 1000) > WEBHOOK_TOLERANCE_MS) return false;

  const key = input.secret.startsWith('whsec_')
    ? Buffer.from(input.secret.slice('whsec_'.length), 'base64')
    : Buffer.from(input.secret, 'base64');
  if (key.length === 0) return false;

  const signed = Buffer.concat([
    Buffer.from(`${input.id}.${input.timestamp}.`, 'utf8'),
    input.rawBody,
  ]);
  const expected = createHmac('sha256', key).update(signed).digest();

  return input.signatureHeader
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .some((entry) => {
      const presented = Buffer.from(entry.slice(3), 'base64');
      return presented.length === expected.length && timingSafeEqual(presented, expected);
    });
}

/* ------------------------------------------------------ Unsubscribe tokens -- */

/**
 * The unsubscribe token for an account — **derived, not random** (§23.1, §26.5).
 *
 * Two requirements meet here and only a derivation satisfies both. The column stores a hash, so the
 * plaintext cannot be read back; and every report must carry a working unsubscribe link, including
 * reports sent months apart, so the token cannot be re-minted per send without killing the link in
 * every email already delivered.
 *
 * Deriving it from the account id under the application's signing key gives a token that is stable
 * for the life of the account, reproducible by the worker, and still useless to anyone holding only
 * a database dump — the stored value remains a SHA-256, and reversing it would additionally require
 * the signing key.
 *
 * THE LABEL IS DOMAIN SEPARATION. Without it, a value derived here would be a valid HMAC of the
 * account id under the same key that signs access tokens, and any other feature that derived a
 * secret the same way would collide with this one.
 */
export function deriveUnsubscribeToken(secret: string, userId: string): string {
  return createHmac('sha256', secret).update(`report-unsubscribe:${userId}`).digest('base64url');
}
