/*
 * Refresh-session lifetime rules (ADR-008 rev. 3). Pure: no framework, no ORM, no I/O, no clock —
 * "now" arrives as an argument so every rule here is exhaustively testable without waiting.
 *
 * Named `auth-session` rather than `session` because `session.ts` in this folder is the pomodoro
 * interval. A *focus* session is work; an *auth* session is a login. They share no rules.
 */

/*
 * The two windows are configuration, not domain constants: they live in src/config/env.schema.ts
 * (SESSION_IDLE_TTL_MS, SESSION_ABSOLUTE_TTL_MS) and arrive here as arguments. Duplicating the
 * defaults in this file would create a second answer to "how long is a session", and the two would
 * eventually disagree.
 */

/** The subset of a session row these rules need. Plain values — the ORM stops at the repository. */
export interface SessionLifetime {
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * When a session issued or rotated at `now` should next go idle.
 *
 * **The `Math.min` is the load-bearing part of this whole feature.** A rotated session inherits its
 * predecessor's ceiling, so pushing the idle window forward can never push it past that ceiling. Drop
 * the clamp and a client refreshing every fifteen minutes extends its own session forever — the
 * 30-day cap would still be written in the schema, in the config, and in the contract, and would
 * simply never be reached. That failure is silent: everything keeps working, and the limit is gone.
 *
 * @param now          the moment the session is being issued or rotated
 * @param idleTtlMs    how long an unused session survives
 * @param ceiling      the absolute expiry, inherited unchanged from the predecessor
 */
export function nextIdleExpiry(now: Date, idleTtlMs: number, ceiling: Date): Date {
  const sliding = now.getTime() + idleTtlMs;
  return new Date(Math.min(sliding, ceiling.getTime()));
}

/** The ceiling for a session starting now. Only a *fresh sign-in* may compute one. */
export function absoluteExpiryFor(now: Date, absoluteTtlMs: number): Date {
  return new Date(now.getTime() + absoluteTtlMs);
}

/**
 * Whether a session may still be exchanged for an access token.
 *
 * All three conditions are checked here rather than in the query, so "why was this session refused"
 * has exactly one answer in exactly one place. The caller must still distinguish *revoked* from
 * *never existed* — a revoked row that is presented again is a replay, which is a security event and
 * not merely an expired session (see `RefreshTokenService`).
 */
export function isUsable(session: SessionLifetime, now: Date): boolean {
  if (session.revokedAt !== null) return false;
  const at = now.getTime();
  return session.expiresAt.getTime() > at && session.absoluteExpiresAt.getTime() > at;
}
