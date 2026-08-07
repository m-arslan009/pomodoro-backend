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

/** Every action that may be written. Mirrors the database CHECK constraint exactly. */
export const ADMIN_AUDIT_ACTIONS = [
  'user.disabled',
  'user.reactivated',
  'user.role_changed',
  'user.sessions_revoked',
  'user.deleted',
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

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
  | { readonly counts: { readonly tasks: number; readonly focusSessions: number } };

/**
 * One row, as the repository takes it.
 *
 * The email snapshots are required rather than derived: the target's row is gone by the time a
 * `user.deleted` event is read, and `target_user_id` is null on it. The snapshot is the record and
 * the foreign key is only a convenience while both accounts still exist.
 */
export interface AdminAuditEntry {
  readonly action: AdminAuditAction;
  readonly actorUserId: string;
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
