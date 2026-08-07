import { z } from 'zod';
import {
  ADMIN_SEARCH_MAX_LENGTH,
  ADMIN_USERS_LIMIT_DEFAULT,
  ADMIN_USERS_LIMIT_MAX,
  ADMIN_USERS_LIMIT_MIN,
  ADMIN_USER_ROLES,
  ADMIN_USER_STATUSES,
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
