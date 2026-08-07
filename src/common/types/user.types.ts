import { type AdminUserStatus, toAdminUserStatus } from '../../domain/admin-user';

/*
 * Plain shapes that cross layer boundaries.
 *
 * Repositories map Prisma rows onto these before returning them, so no ORM type reaches a
 * service, a guard or a controller. That is what keeps ADR-004's "swap the data-access tool"
 * escape hatch real rather than theoretical.
 */

/**
 * Which set of navigation and routes an account gets.
 *
 * A closed union at the API boundary, but deliberately `string` on `UserRecord` below: the column is
 * `VarChar` + CHECK (no Postgres enum), so Prisma hands back a plain string and the narrowing
 * happens once, in `toUserProfile`. Anything that is not exactly `'admin'` becomes `'user'` — a
 * value the CHECK constraint should make impossible cannot elevate anyone on its way out.
 */
export type UserRole = 'user' | 'admin';

/** A full account row, including the credential. Never leaves the service layer. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly usernameLower: string;
  readonly firstName: string;
  readonly lastName: string;
  /**
   * Null for an account created through a provider that has not set a password (ADR-008a). The
   * type is the enforcement: every consumer is made to decide what "no password" means, and the
   * only correct answer on a verification path is "nothing matches, and it costs the same".
   */
  readonly passwordHash: string | null;
  readonly timezone: string;
  /** `'user'` or `'admin'` as stored. Typed loosely on purpose — see `UserRole`. */
  readonly role: string;
  readonly emailVerifiedAt: Date | null;
  readonly passwordChangedAt: Date;
  readonly lastLoginAt: Date | null;
  readonly avatarUpdatedAt: Date | null;
  /**
   * When an administrator disabled the account, or null while it is active.
   *
   * **Read by the authentication layer, and it refuses.** `JwtGuard` rejects a request from a
   * disabled account with the same 401 as every other rejection; login refuses with the same generic
   * `Invalid credentials` a wrong password gets, and still pays the Argon2 cost so timing cannot
   * tell the two apart; refresh refuses and the cookie is cleared; the OAuth callback redirects with
   * the coarse `invalid_request` code. Because `JwtGuard` already loads this row on every
   * authenticated request, a disable is effective on the account's very next call.
   *
   * Written by `POST /admin/users/:id/disable` and `/reactivate` only, both behind `AdminGuard`.
   */
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What the API returns for an account. Contains no credential material by construction. */
export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly timezone: string;
  /**
   * Read-only output. No public write path can set it — the repository's create and update inputs
   * have no `role` field, and the one route that does write it is `PATCH /admin/users/:id/role`,
   * itself behind `AdminGuard`.
   *
   * The client uses it to decide which navigation to render. That is a convenience, not a control:
   * `AdminGuard` gates the `/admin` namespace on the same value read from the row, and its 404 is
   * the boundary. A browser that lies to itself about this field gets a different menu and no more.
   */
  readonly role: UserRole;
  readonly emailVerified: boolean;
  /** When the avatar last changed, or null when there is none. The bytes are never inlined here. */
  readonly avatarUpdatedAt: string | null;
  readonly createdAt: string;
}

/**
 * The projection of an authenticated request's identity.
 *
 * Deliberately holds no password hash: request-scoped state is the wrong place to park
 * credential material, and the one endpoint that needs it re-reads the row.
 */
export interface AuthContext {
  readonly userId: string;
  readonly profile: UserProfile;
}

/**
 * The columns the directory read selects — and, because it is the only accepted input to
 * `toAdminUserSummary`, the reason a credential cannot reach the admin response by accident.
 *
 * DELIBERATELY NOT `UserRecord`. That type carries `passwordHash`, and a projection function taking
 * it would rely on the author remembering not to read the field. This one *cannot* be handed a hash,
 * because a hash is not part of its input type — the repository's `select` and this interface have
 * to agree, and TypeScript is what checks that they do.
 */
export interface AdminUserRow {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: string;
  readonly emailVerifiedAt: Date | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

/**
 * One account as `GET /admin/users` returns it — the complete allow-list.
 *
 * WHAT IS ABSENT IS THE POINT. No `passwordHash`, no `auth_sessions` row or token hash, no
 * `provider_subject` or `email_at_link`, no report token hashes, no task or session contents. Those
 * are excluded *by construction* rather than by being deleted on the way out: `AdminUserRow` above
 * cannot carry them, so there is nothing here to forget to strip.
 *
 * `lastSeenAt` is also absent, and for a different reason — it is a `MAX()` over `auth_sessions` per
 * row, which is an N+1 on a list. It belongs to the detail view, where it is one query
 * (`admin_role_plan.md` §6.1).
 *
 * `disabledAt` is not returned either: `status` is the whole of what the list needs to say, and the
 * timestamp is detail-view material.
 */
export interface AdminUserSummary {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: UserRole;
  /** Derived from `disabled_at`. There is no status column — see `domain/admin-user.ts`. */
  readonly status: AdminUserStatus;
  readonly emailVerified: boolean;
  readonly createdAt: string;
}

export function toUserProfile(user: UserRecord): UserProfile {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    timezone: user.timezone,
    // The narrowing, and the only place it happens. An allow-list rather than a cast: a stored value
    // outside the CHECK constraint reads as an ordinary user instead of reaching the client as-is.
    role: user.role === 'admin' ? 'admin' : 'user',
    // Exposed as a boolean rather than the timestamp: the client only ever needs the state, and
    // shipping it now means the future verification banner needs no contract change.
    emailVerified: user.emailVerifiedAt !== null,
    avatarUpdatedAt: user.avatarUpdatedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * The directory projection. Deliberately sitting beside `toUserProfile`, because the two are the
 * only projections of an account this API has and they should be readable against each other.
 *
 * It narrows `role` the same way and for the same reason: an allow-list rather than a cast, so a
 * stored value the CHECK constraint should make impossible reads as an ordinary user instead of
 * reaching an operator's screen as-is.
 */
export function toAdminUserSummary(row: AdminUserRow): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: toAdminUserStatus(row.disabledAt),
    emailVerified: row.emailVerifiedAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}
