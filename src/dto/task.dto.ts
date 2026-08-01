import { z } from 'zod';
import {
  TASK_ESTIMATE_MAX,
  TASK_ESTIMATE_MIN,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
} from '../domain/task';

/*
 * Task requests. Every rule is imported from src/domain rather than restated, so the API boundary
 * and the business rules cannot drift apart, and the same constants are mirrored in the frontend
 * (CONTRACT.md §15).
 */

/** Trimmed at the boundary, so everything downstream receives the canonical value. */
const titleSchema = z
  .string()
  .trim()
  .min(1, 'Give the task a name.')
  .max(TASK_TITLE_MAX_LENGTH, `Task names must be ${TASK_TITLE_MAX_LENGTH} characters or fewer.`);

/*
 * Nullable, not optional-only: null is the value that CLEARS an estimate, which is a different
 * instruction from omitting the key and leaving it alone.
 */
const estimateSchema = z
  .number()
  .int('An estimate must be a whole number of pomodoros.')
  .min(TASK_ESTIMATE_MIN, `Estimates run from ${TASK_ESTIMATE_MIN} to ${TASK_ESTIMATE_MAX}.`)
  .max(TASK_ESTIMATE_MAX, `Estimates run from ${TASK_ESTIMATE_MIN} to ${TASK_ESTIMATE_MAX}.`)
  .nullable();

export const createTaskSchema = z.strictObject({
  title: titleSchema,
  estimatedPomodoros: estimateSchema.optional(),
});
export type CreateTaskDto = z.infer<typeof createTaskSchema>;

/*
 * A PATCH: absent keys are untouched. The refine is what stops an empty body silently succeeding
 * and returning an unchanged task, which would look like a write that worked.
 */
export const updateTaskSchema = z
  .strictObject({
    title: titleSchema.optional(),
    status: z.enum(TASK_STATUSES, 'Choose a supported task status.').optional(),
    estimatedPomodoros: estimateSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one field to update.',
  });
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;

/** Query parameters arrive as strings, so numeric bounds are coerced before they are checked. */
export const listTasksQuerySchema = z.strictObject({
  /*
   * Optional by design. Omitting it returns EVERY status, which is what hydration does so History
   * can break down task outcomes — a default of 'todo' here would silently make that chart read
   * 100% "in progress".
   */
  status: z.enum(TASK_STATUSES, 'Choose a supported task status.').optional(),
  /** Lower bound on creation time. Ignored for `status=todo`: an open task is never out of window. */
  from: z.iso.datetime({ offset: true, error: 'Provide an ISO-8601 timestamp.' }).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListTasksQueryDto = z.infer<typeof listTasksQuerySchema>;
