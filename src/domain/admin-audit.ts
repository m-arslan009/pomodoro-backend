/*
 * The audit vocabulary — pure, framework-free, ORM-free (enforced by eslint on src/domain).
 *
 * ONE ACTION NAME PER ADMINISTRATIVE WRITE, and the list is closed. `admin_audit_events_action_check`
 * in the migration pins the same five values in the database, so a typo cannot produce a row that
 * exists and no filter ever matches — an audit entry nobody can find is worse than none, because it
 * makes the trail look complete when it is not.
 *
 * `metadata` IS A TYPED UNION, NEVER A SPREAD REQUEST BODY. This is the mechanical half of §5.3's
 * rule about what an audit row may never contain: no password or hash, no token or digest, no
 * cookie, no `provider_subject`, no OAuth secret, no `report_deliveries.last_error`, and no task or
 * focus-session content. A service that built metadata by spreading a DTO would inherit every field
 * that DTO ever grows; these shapes cannot, because each names its fields exhaustively.
 *
 * The disable reason is the one free-text value that reaches this table, and it is the operator's
 * own words about their own decision — bounded at 280 characters by `domain/admin-user.ts` and
 * written by an administrator, not by the account being described.
 *
 * READS ARE NOT AUDITED. `GET /admin/users` and `GET /admin/users/:id` write nothing here: one row
 * per page view would drown the five actions that matter, and Pino's per-request log already
 * records who called what and when (ADR-016), joined to these rows by `request_id`.
 */

/**
 * Every action that may be written. Mirrors the database CHECK constraint exactly.
 *
 * TWO OF THEM HAVE NO ADMINISTRATOR BEHIND THEM, and they are the reason `actorUserId` below is
 * nullable. `admin.bootstrap_granted` is written by the deploy-shell script that creates the first
 * operator — there is no signed-in admin at that moment by definition, since the point of the script
 * is that none exists yet. `security.refresh_reuse_detected` is written by `refresh-token.service.ts`
 * when a spent refresh token is presented again: the system detected it, nobody performed it, and the
 * "actor" is a replay we cannot attribute. Both record `'system:cli'` / `'system'` in the actor
 * snapshot so the row still says *what* wrote it.
 *
 * `security.refresh_reuse_detected` is the one writer outside the admin namespace, and it is
 * deliberate (`admin_role_plan.md` §5.2): reuse detection already revokes every session the account
 * holds, which is a real security event with a user target and no credential material in it.
 * Recording it gives the audit page genuine security content for one extra call site and no new
 * table.
 *
 * LOGIN FAILURES ARE NOT HERE AND MUST NOT BE ADDED. Volume makes them a log-and-alert concern
 * (ADR-016), and a per-attempt table on an unauthenticated route is a write amplifier an attacker
 * controls.
 */
export const ADMIN_AUDIT_ACTIONS = [
  'user.disabled',
  'user.reactivated',
  'user.role_changed',
  'user.sessions_revoked',
  'user.deleted',
  'admin.bootstrap_granted',
  'security.refresh_reuse_detected',
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/**
 * The actor snapshot written when no account performed the action.
 *
 * A string rather than a null, because `actor_email_snapshot` is NOT NULL and because "the system
 * did this" is a fact worth recording rather than an absence. The nullable half is `actorUserId`,
 * which genuinely has no row to point at.
 */
export const SYSTEM_ACTOR_EMAIL = 'system';
export const SYSTEM_CLI_ACTOR_EMAIL = 'system:cli';

/** The audit feed's page bounds (`admin_role_plan.md` §6.8). */
export const ADMIN_AUDIT_LIMIT_MIN = 1;
export const ADMIN_AUDIT_LIMIT_MAX = 100;
export const ADMIN_AUDIT_LIMIT_DEFAULT = 50;

/**
 * The per-action detail, as a discriminated union.
 *
 * Each variant names its fields exhaustively — that is what stops a future field on a DTO landing
 * here by accident. A new action means a new variant, a new constant above, and a widened CHECK
 * constraint: three deliberate edits, which is the intended friction.
 */
export type AdminAuditMetadata =
  /** The operator's stated reason, and how many live sessions the disable took with it. */
  | { readonly reason: string; readonly sessionsRevoked: number }
  /** Reactivation restores sign-in and nothing else, so there is nothing to record. */
  | Record<string, never>
  | { readonly from: string; readonly to: string }
  | { readonly revoked: number }
  /** What was destroyed, as counts. Never the rows themselves. */
  | { readonly counts: { readonly tasks: number; readonly focusSessions: number } }
  /** How the first administrator was granted. `'cli'` is the only route that exists. */
  | { readonly via: 'cli' }
  /**
   * A detected replay, and the blast radius it caused.
   *
   * THE COUNT IS THE WHOLE RECORD. Not the presented token, not its digest, not the session id, not
   * the cookie — a replayed credential is still a credential, and §5.3 forbids every one of those
   * from reaching this table. How many sessions the detection revoked is what an operator needs to
   * understand the event, and it discloses nothing that could be replayed again.
   */
  | { readonly sessionsRevoked: number };

/**
 * One row, as the repository takes it.
 *
 * The email snapshots are required rather than derived: the target's row is gone by the time a
 * `user.deleted` event is read, and `target_user_id` is null on it. The snapshot is the record and
 * the foreign key is only a convenience while both accounts still exist.
 */
export interface AdminAuditEntry {
  readonly action: AdminAuditAction;
  /**
   * Null for a system-written event, and null once the acting account is deleted. The snapshot
   * beside it is the record in both cases — see `ADMIN_AUDIT_ACTIONS` for which actions have no
   * actor by construction.
   */
  readonly actorUserId: string | null;
  readonly actorEmailSnapshot: string;
  /** Null once the account is gone — which is exactly the case a deletion row describes. */
  readonly targetUserId: string | null;
  readonly targetEmailSnapshot: string;
  readonly metadata: AdminAuditMetadata;
  /** Joins this row to its Pino log line and the request's Problem Details `instance`. */
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}
