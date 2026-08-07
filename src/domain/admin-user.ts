/*
 * Administration rules for the account directory — pure, framework-free, ORM-free (enforced by
 * eslint on src/domain).
 *
 * These constants are the authority for what `GET /admin/users` accepts, and they are mirrored in
 * the frontend's `services/adminUsers.js`. The mirror is a convenience for rendering a control
 * without a round trip; this file is what actually decides, and the DTO re-checks every request
 * against it.
 *
 * SCOPE. This is the READ half of the admin surface and nothing more. There is no disable rule here,
 * no reactivate rule, no role-change rule and no audit vocabulary — `disabled_at` is *read* to derive
 * a status and is written by nothing in the application (`admin_role_plan.md` §6.4 owns that, and it
 * is not built).
 */

/** The roles an account can hold. Mirrors the `users_role_check` constraint exactly. */
export const ADMIN_USER_ROLES = ['user', 'admin'] as const;
export type AdminUserRole = (typeof ADMIN_USER_ROLES)[number];

/**
 * The account states the directory can filter by.
 *
 * DERIVED, NEVER STORED. There is no `status` column and there must not be one: it is a reading of
 * `disabled_at`, and a second column holding the same fact is a second thing to keep in step — the
 * two would disagree the first time a disable failed halfway.
 */
export const ADMIN_USER_STATUSES = ['active', 'disabled'] as const;
export type AdminUserStatus = (typeof ADMIN_USER_STATUSES)[number];

/** Matches `EMAIL_MAX_LENGTH` — the longest address the search could be looking for. */
export const ADMIN_SEARCH_MAX_LENGTH = 320;

/** The page bounds (`admin_role_plan.md` §6.1). */
export const ADMIN_USERS_LIMIT_MIN = 1;
export const ADMIN_USERS_LIMIT_MAX = 100;
export const ADMIN_USERS_LIMIT_DEFAULT = 50;

/**
 * The storage form of a search term.
 *
 * Trim+lowercase because that is the form BOTH searched columns are already in: `email` is stored
 * normalised (a CHECK pins it) and `username_lower` exists precisely so case-insensitive matching
 * needs no `lower()` wrapper and no `citext`. Lowercasing the *term* instead of the column is what
 * keeps the comparison sargable — a `lower(email)` on the left-hand side would discard the unique
 * index on every request.
 *
 * @param raw The `q` parameter, already trimmed and length-checked by the DTO.
 */
export function adminSearchKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * An account's status, from the one column that decides it.
 *
 * @param disabledAt When the account was disabled, or null while it is active.
 */
export function toAdminUserStatus(disabledAt: Date | null): AdminUserStatus {
  return disabledAt === null ? 'active' : 'disabled';
}
