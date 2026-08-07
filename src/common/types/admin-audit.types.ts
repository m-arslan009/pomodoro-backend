/*
 * The shapes that cross the repository boundary for `admin_audit_events`, and the one projection the
 * feed is serialised through (`admin_role_plan.md` §6.8).
 *
 * SEPARATE FROM admin.types.ts because it answers a different question. That file is about an
 * *account* — what an operator may see of a person. This one is about an *event* — what was done,
 * by whom, to whom. The account file's deny-list is a list of columns on `users` and its children;
 * this file's is a list of things that must never have been written into `metadata` in the first
 * place, which is enforced at the write site by the typed union in `domain/admin-audit.ts`.
 *
 * WHAT AN AUDIT ROW MAY NEVER CARRY (§5.3), restated here because this is the file that decides what
 * leaves the server: no password or hash, no token or token digest, no cookie value, no
 * `provider_subject`, no `email_at_link`, no OAuth client id or secret, no authorization code, no
 * `report_deliveries.last_error`, and no task or focus-session content. None of it is stripped here,
 * because none of it is ever written — `metadata` is built from a per-action union whose variants
 * name their fields exhaustively, never from a spread request body.
 *
 * THE ORM STOPS BELOW THIS FILE (ADR-020). `metadata` arrives as `unknown` rather than as Prisma's
 * `JsonValue`, so nothing above the repository depends on the generated client, and the projection
 * below is what turns it into a plain object.
 */

/**
 * What a system-written audit row records about the request that triggered it.
 *
 * DELIBERATELY NOT `AdminActionContext`. That shape carries `actorId` and `actorEmail` as required
 * strings, because an administrative write always has an administrator behind it. A security event
 * has none — the whole point of `security.refresh_reuse_detected` is that nobody performed it and
 * the actor is a replay we cannot attribute — so reusing that type would force a call site to invent
 * an actor, which is the one thing an audit row must never contain.
 *
 * The three request fields come from the same places the admin context reads them: Pino's per-request
 * id, the request's ip, and the user agent header. Every one of them is nullable, because a security
 * event can be recorded on a path where the request has already been rejected.
 */
export interface SecurityEventContext {
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly now: Date;
}

/**
 * One row as the repository selects it. The column names, before projection.
 *
 * Both id columns are nullable and the two nulls mean different things — a system-written event has
 * no actor, a deleted account leaves a null target — which is why the snapshots beside them are
 * required reading rather than a fallback.
 */
export interface AdminAuditEventRow {
  readonly id: string;
  readonly action: string;
  readonly actorUserId: string | null;
  readonly actorEmailSnapshot: string;
  readonly targetUserId: string | null;
  readonly targetEmailSnapshot: string | null;
  readonly metadata: unknown;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}

/** One party to an event, as the API serialises it: the live id when there is one, and the snapshot. */
export interface AdminAuditParty {
  readonly id: string | null;
  readonly email: string;
}

/**
 * One event, as the API serialises it — the complete allow-list for this surface.
 *
 * `createdAt` is an ISO 8601 string rather than a `Date`, matching every other admin response: the
 * serialiser is not left to decide, and the frontend parses one format everywhere.
 */
export interface AdminAuditEventDto {
  readonly id: string;
  readonly action: string;
  readonly actor: AdminAuditParty;
  readonly target: AdminAuditParty;
  readonly metadata: Record<string, unknown>;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
}

/**
 * `metadata` as a plain object, whatever the column actually held.
 *
 * The column is `NOT NULL DEFAULT '{}'` and every writer passes a typed union member, so the guard
 * below should never fire. It exists because JSONB will hold a scalar, a null or an array perfectly
 * happily if anything ever writes one, and the frontend iterates this value's keys — an array or a
 * bare string reaching it would render as a broken detail list rather than as the empty one that a
 * row with no detail is supposed to produce.
 */
function toMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * The feed projection, and the only way an audit response is built.
 *
 * IT NAMES EVERY FIELD IT EMITS rather than spreading the row. That is the same discipline
 * `toAdminUserDetail` follows and it matters more here, not less: a widened `select` in the
 * repository would otherwise flow straight to the client, and this table sits beside the two
 * foreign keys that point at `users`.
 *
 * The target's email falls back to the empty string rather than to the target's id or to a
 * placeholder. The column is nullable only for rows written before it was populated; an empty string
 * renders as "Not recorded", which is a true statement, where showing an id in an email field would
 * be a false one.
 */
export function toAdminAuditEvent(row: AdminAuditEventRow): AdminAuditEventDto {
  return {
    id: row.id,
    action: row.action,
    actor: { id: row.actorUserId, email: row.actorEmailSnapshot },
    target: { id: row.targetUserId, email: row.targetEmailSnapshot ?? '' },
    metadata: toMetadata(row.metadata),
    requestId: row.requestId,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
}
