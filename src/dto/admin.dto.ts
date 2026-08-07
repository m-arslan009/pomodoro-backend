import { z } from 'zod';
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_LIMIT_DEFAULT,
  ADMIN_AUDIT_LIMIT_MAX,
  ADMIN_AUDIT_LIMIT_MIN,
} from '../domain/admin-audit';
import {
  ADMIN_SEARCH_MAX_LENGTH,
  ADMIN_USERS_LIMIT_DEFAULT,
  ADMIN_USERS_LIMIT_MAX,
  ADMIN_USERS_LIMIT_MIN,
  ADMIN_USER_ROLES,
  ADMIN_USER_STATUSES,
  DISABLE_REASON_MAX_LENGTH,
  DISABLE_REASON_MIN_LENGTH,
} from '../domain/admin-user';

/*
 * Admin requests.
 *
 * Shape only, like every other DTO here — the bounds come from `domain/admin-user.ts` so the
 * endpoint and the rules cannot drift apart.
 *
 * `strictObject` is load-bearing rather than tidy. An unknown query key is a 422, which means a
 * misspelled `?statuss=disabled` fails loudly instead of silently returning every account — the
 * failure mode that matters most on a filter whose whole job is to narrow a list of people.
 */
export const listAdminUsersQuerySchema = z.strictObject({
  /**
   * A prefix of an email address or a username. Optional; absent means "no search".
   *
   * Trimmed before it is measured, so a box full of spaces is rejected as empty rather than
   * accepted as a one-character search that matches nothing.
   */
  q: z
    .string()
    .trim()
    .min(1, 'Enter something to search for.')
    .max(ADMIN_SEARCH_MAX_LENGTH, `Searches are ${ADMIN_SEARCH_MAX_LENGTH} characters or fewer.`)
    .optional(),

  role: z.enum(ADMIN_USER_ROLES, 'Filter by a supported role.').optional(),
  status: z.enum(ADMIN_USER_STATUSES, 'Filter by a supported status.').optional(),

  /** Opaque, and produced only by a previous response. An unparseable one starts from the top. */
  cursor: z.string().min(1).optional(),

  /*
   * Coerced because a query string is text. The bound is the server's, not a suggestion: the client
   * asks for 25, and nothing stops a caller asking for 100 — but 101 is refused rather than clamped,
   * so a caller that expects more than it gets is told so instead of quietly under-reading a page.
   */
  limit: z.coerce
    .number()
    .int()
    .min(ADMIN_USERS_LIMIT_MIN)
    .max(ADMIN_USERS_LIMIT_MAX)
    .default(ADMIN_USERS_LIMIT_DEFAULT),
});
export type ListAdminUsersQueryDto = z.infer<typeof listAdminUsersQuerySchema>;

/**
 * `GET /admin/audit-events` (§6.8) — the audit feed's filters.
 *
 * `strictObject` for the reason stated above, and it matters as much here as on the directory: a
 * misspelled `?actorId=…` must fail loudly rather than silently returning the whole record while the
 * operator believes they are looking at one person's actions.
 *
 * THE ACTION ENUM IS THE FULL §5.2 SET, INCLUDING THE TWO NOBODY PERFORMS. `admin.bootstrap_granted`
 * and `security.refresh_reuse_detected` are written by the CLI and by reuse detection rather than by
 * any route in this namespace — filtering them out here would make the two most security-relevant
 * rows in the table the only ones an operator cannot isolate.
 *
 * BOTH DATES ARE INCLUSIVE and are compared as instants, not as calendar days. The client sends whole
 * local days widened to ISO instants, because "the 6th" means the 6th where the operator is sitting;
 * the server never has to guess a timezone, which is why `offset: true` is required rather than
 * accepting a bare local timestamp.
 */
export const listAuditEventsQuerySchema = z
  .strictObject({
    /** Both ids are uuids: the feed filters on identity, never on an address. */
    targetUserId: z.uuid('Provide a valid user id.').optional(),
    actorUserId: z.uuid('Provide a valid user id.').optional(),

    action: z.enum(ADMIN_AUDIT_ACTIONS, 'Filter by a supported action.').optional(),

    from: z.iso.datetime({ offset: true, error: 'Provide an ISO-8601 timestamp.' }).optional(),
    to: z.iso.datetime({ offset: true, error: 'Provide an ISO-8601 timestamp.' }).optional(),

    /** Opaque, and produced only by a previous response. An unparseable one starts from the top. */
    cursor: z.string().min(1).optional(),

    limit: z.coerce
      .number()
      .int()
      .min(ADMIN_AUDIT_LIMIT_MIN)
      .max(ADMIN_AUDIT_LIMIT_MAX)
      .default(ADMIN_AUDIT_LIMIT_DEFAULT),
  })
  /*
   * An inverted range is refused rather than quietly returning nothing. Both readings of an empty
   * result — "nothing happened in this window" and "these two dates are the wrong way round" — look
   * identical on an audit page, and only one of them is worth acting on.
   */
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    error: 'The start of the range must not be after its end.',
    path: ['from'],
  });
export type ListAuditEventsQueryDto = z.infer<typeof listAuditEventsQuerySchema>;

/*
 * The write bodies.
 *
 * `strictObject` everywhere, for the reason stated above and one more that only applies here: these
 * routes mutate somebody else's account, and a body carrying a key the schema does not know is a
 * caller who believes they are doing something this endpoint does not do. Failing loudly is the only
 * safe answer on a destructive path.
 *
 * NOTE WHAT NO SCHEMA BELOW ACCEPTS. There is no `disabledAt`, no `status`, no `id`, and no way to
 * name the actor — every one of those is decided by the server from the verified token and the
 * clock. The bodies carry a reason, a role and a confirmation, and nothing else.
 */

/**
 * `POST /admin/users/:id/disable` (§6.4).
 *
 * The reason is REQUIRED. An unexplained disable writes an audit row that answers who and when but
 * not why, which is the one question the trail exists to answer. Trimmed before it is measured, so a
 * box full of spaces is rejected as empty rather than accepted as a reason nobody can read.
 */
export const disableUserSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(DISABLE_REASON_MIN_LENGTH, 'Give a reason for disabling this account.')
    .max(
      DISABLE_REASON_MAX_LENGTH,
      `Reasons are ${DISABLE_REASON_MAX_LENGTH} characters or fewer.`,
    ),
});
export type DisableUserDto = z.infer<typeof disableUserSchema>;

/**
 * `PATCH /admin/users/:id/role` (§6.7).
 *
 * The one write path to `users.role` in the application, and the enum is the same constant the
 * database CHECK constraint mirrors — a value outside it is a 422 here rather than a constraint
 * violation three layers down.
 */
export const changeUserRoleSchema = z.strictObject({
  role: z.enum(ADMIN_USER_ROLES, 'Choose a supported role.'),
});
export type ChangeUserRoleDto = z.infer<typeof changeUserRoleSchema>;

/**
 * `DELETE /admin/users/:id` (§6.9) — the typed confirmation, verified by the server.
 *
 * NORMALISED THE WAY `users.email` IS STORED: trim + lowercase, which a CHECK constraint pins on the
 * column. That makes the comparison in the repository an exact string match with nothing left to
 * forgive, and it means an operator who types the address with a capital letter is not refused for a
 * difference the database does not consider one.
 *
 * The confirmation is checked against the row inside the deleting transaction, never here — a DTO
 * can only say the value is well-formed, and "well-formed" is not "the right account".
 */
export const deleteUserSchema = z.strictObject({
  confirmEmail: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Type the account’s email address to confirm.')
    .max(ADMIN_SEARCH_MAX_LENGTH),
});
export type DeleteUserDto = z.infer<typeof deleteUserSchema>;
