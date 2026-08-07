import type { AdminUserStatus } from '../../domain/admin-user';
import { toAdminUserStatus } from '../../domain/admin-user';
import type { UserRole } from './user.types';

/*
 * The account detail an operator sees — `GET /admin/users/:id` (`admin_role_plan.md` §6.2).
 *
 * WHAT IS ABSENT IS THE POINT, exactly as it is for `AdminUserSummary` next door in user.types.ts.
 * The deny-list §6.2 states in full: `password_hash`, `auth_sessions.token_hash`, any refresh token
 * or cookie value, `auth_identities.provider_subject`, `auth_identities.email_at_link`, report
 * confirmation and unsubscribe token hashes, `report_deliveries.last_error`, any OAuth client id or
 * secret, and **any `focus_sessions` or `tasks` row content**.
 *
 * THAT LAST EXCLUSION IS THE PRIVACY LINE OF THE WHOLE ADMIN SURFACE: counts and totals, never
 * records. An operator can see that an account recorded 318 focus sessions; they cannot see what the
 * user was working on. `task_title_snapshot` is the user's own text about their own work and no
 * admin route returns it — which is why `counts` below is two integers and there is no list type
 * anywhere in this file to be tempted into widening.
 *
 * The exclusions are structural rather than remembered. Each input row type below is the exact
 * projection its repository selects, and none of them *can* carry a credential — so there is nothing
 * here to forget to strip on the way out. `hasPassword` is the shape that takes for the one
 * credential fact an operator legitimately needs: a boolean and a timestamp, *whether* and *when*,
 * never *what*.
 */

/**
 * The `users` columns the detail read selects.
 *
 * `hasPassword` rather than `passwordHash`: the repository reads the column and reduces it to a
 * boolean before returning, so the hash exists in the repository's own statement and nowhere above
 * it. This type is what makes that a compile-time fact instead of a convention.
 */
export interface AdminUserDetailRow {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: string;
  readonly timezone: string;
  readonly emailVerifiedAt: Date | null;
  readonly passwordChangedAt: Date;
  readonly hasPassword: boolean;
  readonly avatarUpdatedAt: Date | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

/** One linked provider. No `provider_subject`, no `email_at_link` — neither is an operator's business. */
export interface AdminIdentityRow {
  readonly provider: string;
  readonly linkedAt: Date;
  readonly lastLoginAt: Date | null;
}

/** The refresh sessions, summarised. No token digests, no forensic columns, no per-session rows. */
export interface AdminSessionSummary {
  readonly activeCount: number;
  readonly lastSeenAt: Date | null;
}

/** The progression projection, as totals. */
export interface AdminGamificationSummary {
  readonly lifetimePoints: number;
  readonly balance: number;
  readonly currentDayStreak: number;
  readonly longestDayStreak: number;
  readonly streakFreezesAvailable: number;
  readonly unlockedTitles: readonly string[];
}

/**
 * The email-report state.
 *
 * Two statuses and two timestamps, and deliberately nothing else: `report_deliveries.last_error` is
 * the provider's own words and can quote an address or an internal reason, which is why §26.4 says
 * it is never returned by any endpoint. The confirmation and unsubscribe token hashes are excluded
 * the same way every other digest in this file is — by not being in the type.
 */
export interface AdminReportsSummary {
  readonly status: string;
  readonly frequency: string | null;
  readonly lastDeliveryStatus: string | null;
  readonly lastDeliveryAt: Date | null;
}

/**
 * Everything an administrative write needs that is not about the target: who is acting, from where,
 * and when.
 *
 * IT LIVES HERE RATHER THAN ON THE REPOSITORY because the controller builds it — the actor comes
 * from the verified token, the request id and the user agent from the request — and a controller
 * importing a repository is exactly what the `no-restricted-imports` rule forbids. A plain shape
 * that crosses the boundary belongs in this folder, which is what this folder is for.
 *
 * The actor's email is snapshotted into the audit row rather than joined at read time, so the trail
 * still names who acted after that operator's own account is gone. `requestId` is Pino's per-request
 * id, which the exception filter also reports as the Problem Details `instance`.
 */
export interface AdminActionContext {
  readonly actorId: string;
  readonly actorEmail: string;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly now: Date;
}

/** What an account has recorded, as counts. Never the records. */
export interface AdminUserCounts {
  readonly tasks: number;
  readonly focusSessions: number;
}

/** Everything the service gathers before projecting. Each field comes from its table's own owner. */
export interface AdminUserDetailParts {
  readonly user: AdminUserDetailRow;
  readonly identities: readonly AdminIdentityRow[];
  readonly sessions: AdminSessionSummary;
  readonly gamification: AdminGamificationSummary;
  readonly counts: AdminUserCounts;
  /** Null when the account has never answered the reports question — no row means silence. */
  readonly reports: AdminReportsSummary | null;
}

/**
 * The complete allow-list, as the API serialises it.
 *
 * Timestamps are ISO 8601 strings rather than `Date`, matching `UserProfile` and `AdminUserSummary`:
 * the serialiser is not left to decide, and the frontend parses one format everywhere.
 */
export interface AdminUserDetail {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: UserRole;
  readonly status: AdminUserStatus;
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly disabledAt: string | null;

  readonly timezone: string;
  readonly avatarUpdatedAt: string | null;
  readonly passwordChangedAt: string | null;
  readonly hasPassword: boolean;

  readonly identities: readonly {
    readonly provider: string;
    readonly linkedAt: string;
    readonly lastLoginAt: string | null;
  }[];

  readonly sessions: { readonly activeCount: number; readonly lastSeenAt: string | null };

  readonly gamification: {
    readonly lifetimePoints: number;
    readonly balance: number;
    readonly currentDayStreak: number;
    readonly longestDayStreak: number;
    readonly streakFreezesAvailable: number;
    readonly unlockedTitles: readonly string[];
  };

  readonly counts: AdminUserCounts;

  readonly reports: {
    readonly status: string;
    readonly frequency: string | null;
    readonly lastDeliveryStatus: string | null;
    readonly lastDeliveryAt: string | null;
  };
}

/**
 * What an account that has never answered the reports question reports as.
 *
 * `'unasked'` is a real value rather than a null the client has to interpret, and it is the same
 * synthetic status `GET /me/reports` already returns for the absent row (CONTRACT.md §25.1) — the
 * two surfaces name the same state the same way, which is the only reason the frontend needs no
 * special case.
 */
const UNASKED_REPORTS = {
  status: 'unasked',
  frequency: null,
  lastDeliveryStatus: null,
  lastDeliveryAt: null,
} as const;

/**
 * The detail projection, and the only way a detail response is built.
 *
 * It narrows `role` the way `toUserProfile` and `toAdminUserSummary` do — an allow-list rather than
 * a cast, so a stored value the CHECK constraint should make impossible reads as an ordinary user
 * instead of reaching an operator's screen as-is.
 */
export function toAdminUserDetail(parts: AdminUserDetailParts): AdminUserDetail {
  const { user } = parts;

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role === 'admin' ? 'admin' : 'user',
    status: toAdminUserStatus(user.disabledAt),
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
    disabledAt: user.disabledAt?.toISOString() ?? null,

    timezone: user.timezone,
    avatarUpdatedAt: user.avatarUpdatedAt?.toISOString() ?? null,
    /*
     * Null when there is no password at all. The column is NOT NULL and defaults to the account's
     * creation time, so a provider-created account would otherwise report a "password changed"
     * moment for a password it has never had.
     */
    passwordChangedAt: user.hasPassword ? user.passwordChangedAt.toISOString() : null,
    hasPassword: user.hasPassword,

    identities: parts.identities.map((identity) => ({
      provider: identity.provider,
      linkedAt: identity.linkedAt.toISOString(),
      lastLoginAt: identity.lastLoginAt?.toISOString() ?? null,
    })),

    sessions: {
      activeCount: parts.sessions.activeCount,
      lastSeenAt: parts.sessions.lastSeenAt?.toISOString() ?? null,
    },

    gamification: {
      lifetimePoints: parts.gamification.lifetimePoints,
      balance: parts.gamification.balance,
      currentDayStreak: parts.gamification.currentDayStreak,
      longestDayStreak: parts.gamification.longestDayStreak,
      streakFreezesAvailable: parts.gamification.streakFreezesAvailable,
      unlockedTitles: parts.gamification.unlockedTitles,
    },

    counts: parts.counts,

    reports:
      parts.reports === null
        ? UNASKED_REPORTS
        : {
            status: parts.reports.status,
            frequency: parts.reports.frequency,
            lastDeliveryStatus: parts.reports.lastDeliveryStatus,
            lastDeliveryAt: parts.reports.lastDeliveryAt?.toISOString() ?? null,
          },
  };
}
