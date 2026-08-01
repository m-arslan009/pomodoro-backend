import { z } from 'zod';
import {
  MAX_INTERVAL_MS,
  SESSION_STATUSES,
  SESSION_TYPES,
  TERMINATION_REASONS,
} from '../domain/session';
import { TASK_TITLE_MAX_LENGTH } from '../domain/task';

/*
 * Session requests.
 *
 * This schema checks SHAPE only — that the fields are present, typed and in range. Whether the
 * times are plausible relative to each other and to now is the domain's job (domain/session.ts,
 * CONTRACT.md §15.1), because those rules are ordered and need a clock. Splitting it this way keeps
 * the ordered rule list in one readable place instead of scattered through refinements.
 */

const timestampSchema = z.iso.datetime({
  offset: true,
  error: 'Provide an ISO-8601 timestamp.',
});

const durationSchema = z
  .number()
  .int('Durations are whole milliseconds.')
  .min(0, 'Durations cannot be negative.')
  .max(MAX_INTERVAL_MS, 'A single session cannot be longer than 4 hours.');

export const recordSessionSchema = z.strictObject({
  /** The client's primary key, minted when the block started. Also the idempotency key. */
  clientSessionId: z.uuid('Provide a valid client session id.'),

  /*
   * Nullable: a session can outlive its task. If this id is unknown, deleted, or another
   * account's, the session is still recorded — with a null link, never a rejection.
   */
  taskId: z.uuid('Provide a valid task id.').nullable(),

  /*
   * REQUIRED, and stored verbatim as the history snapshot. The server does not derive it from the
   * task row: once a task can be renamed or deleted, deriving it would either fail outright or
   * stamp work with a name it was never done under.
   */
  taskTitle: z
    .string()
    .trim()
    .min(1, 'A session needs a task name.')
    .max(TASK_TITLE_MAX_LENGTH, `Task names must be ${TASK_TITLE_MAX_LENGTH} characters or fewer.`),

  type: z.enum(SESSION_TYPES, 'Choose a supported session type.'),
  status: z.enum(SESSION_STATUSES, 'Choose a supported session status.'),

  startedAt: timestampSchema,
  endedAt: timestampSchema,

  plannedDurationMs: durationSchema.min(1, 'A session must have been set to some length.'),
  /** Client-reported focused time. Clamped server-side before anything is computed from it. */
  actualDurationMs: durationSchema,

  /** Required on a terminated focus block, forbidden otherwise — checked in the service. */
  terminationReason: z.enum(TERMINATION_REASONS, 'Choose a supported reason.').nullable(),
});
export type RecordSessionDto = z.infer<typeof recordSessionSchema>;

export const listSessionsQuerySchema = z.strictObject({
  /** Defaults to a 180-day window in the service — exactly what History can render. */
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListSessionsQueryDto = z.infer<typeof listSessionsQuerySchema>;
