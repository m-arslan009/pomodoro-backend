/*
 * Session rules — pure, framework-free, ORM-free (enforced by eslint on src/domain).
 *
 * This module is the time authority (ADR-012). The client reports when a block ran and how much of
 * it was actually focused; the server decides whether that is plausible and clamps it before
 * anything is computed from it. Nothing downstream may trust a client-supplied duration that has
 * not passed through here.
 *
 * WHY THE CLIENT REPORTS DURATION AT ALL. `endedAt - startedAt` is the wall clock, not the focused
 * time, because Pause exists: a block paused for an hour has a 25-minute actual and an 85-minute
 * span. The server cannot reconstruct that, so the client reports it and the server bounds it.
 */

export const SESSION_TYPES = ['focus', 'break'] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

export const SESSION_STATUSES = ['completed', 'terminated'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Why a focus block ended early. Required on a terminated focus session and forbidden otherwise.
 *
 * A fixed set, not free text: terminating costs no points, and this is the entire thing the
 * product gets in exchange. One tap answers it; a text box would not be answered at all.
 */
export const TERMINATION_REASONS = [
  'interrupted',
  'wrong_task',
  'finished_early',
  'out_of_energy',
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Tolerance for a client clock that runs slightly fast. Beyond it, the record is from the future. */
export const FUTURE_SKEW_TOLERANCE_MS = 60 * 1000;

/** How far back a record may be dated. Bounds the outbox and the overlap search alike. */
export const BACKDATE_WINDOW_MS = 7 * DAY_MS;

/** No single interval is plausibly longer than this, whatever the configured duration. */
export const MAX_INTERVAL_MS = 4 * HOUR_MS;

/** The rolling window `GET /sessions` serves when the caller names no lower bound. */
export const HYDRATION_WINDOW_DAYS = 180;

export type TimingViolation =
  | 'ended_in_future'
  | 'started_too_long_ago'
  | 'ended_before_started'
  | 'actual_exceeds_planned'
  | 'actual_exceeds_maximum'
  | 'actual_exceeds_elapsed';

/** The field each violation belongs to, so the API can place the error on an input. */
export const TIMING_VIOLATION_FIELDS: Record<TimingViolation, string> = {
  ended_in_future: 'endedAt',
  started_too_long_ago: 'startedAt',
  ended_before_started: 'endedAt',
  actual_exceeds_planned: 'actualDurationMs',
  actual_exceeds_maximum: 'actualDurationMs',
  actual_exceeds_elapsed: 'actualDurationMs',
};

/** Wording is shared with the frontend so a user sees one message, not two variants. */
export const TIMING_VIOLATION_MESSAGES: Record<TimingViolation, string> = {
  ended_in_future: 'A session cannot end in the future. Check your device clock.',
  started_too_long_ago: 'Sessions older than 7 days can no longer be recorded.',
  ended_before_started: 'A session must end after it starts.',
  actual_exceeds_planned: 'Focused time cannot exceed the length the block was set to.',
  actual_exceeds_maximum: 'A single session cannot be longer than 4 hours.',
  actual_exceeds_elapsed: 'Focused time cannot exceed the time that actually passed.',
};

export interface SessionTiming {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly plannedDurationMs: number;
  readonly actualDurationMs: number;
}

/**
 * The ordered rule list (CONTRACT.md §15.1, rules 1-5). Returns the FIRST violation, or null.
 *
 * Order matters and is part of the contract: a record that is both stale and internally
 * inconsistent reports the staleness, because that is the reason the client cannot fix it by
 * retrying. Rule 6 (overlap) needs the database and lives in the repository; rules 7-8 (clamp and
 * day attribution) are applied after validation passes.
 */
export function checkTiming(timing: SessionTiming, now: Date): TimingViolation | null {
  const started = timing.startedAt.getTime();
  const ended = timing.endedAt.getTime();
  const current = now.getTime();

  if (ended > current + FUTURE_SKEW_TOLERANCE_MS) return 'ended_in_future';
  if (current - started > BACKDATE_WINDOW_MS) return 'started_too_long_ago';
  if (ended <= started) return 'ended_before_started';
  if (timing.actualDurationMs > timing.plannedDurationMs) return 'actual_exceeds_planned';
  if (timing.actualDurationMs > MAX_INTERVAL_MS) return 'actual_exceeds_maximum';
  // Closes "I paused for an hour and focused for two".
  if (timing.actualDurationMs > ended - started) return 'actual_exceeds_elapsed';

  return null;
}

/**
 * Rule 7 — bound the reported duration before ANYTHING is computed from it.
 *
 * Validation already rejects a value outside these bounds, so in the normal path this is a no-op.
 * It exists because "clamp before computing" must be true at the point of computation rather than
 * true by the grace of a check somewhere upstream.
 */
export function clampDuration(actualDurationMs: number, plannedDurationMs: number): number {
  if (!Number.isFinite(actualDurationMs) || actualDurationMs < 0) return 0;
  return Math.min(Math.floor(actualDurationMs), plannedDurationMs);
}

/**
 * Whether a termination reason is consistent with the rest of the record: required on a terminated
 * FOCUS block, forbidden everywhere else. A break is skipped, not abandoned — there is nothing to
 * explain about not resting.
 */
export function reasonIsConsistent(
  type: SessionType,
  status: SessionStatus,
  reason: TerminationReason | null,
): boolean {
  const required = type === 'focus' && status === 'terminated';
  return required ? reason !== null : reason === null;
}
