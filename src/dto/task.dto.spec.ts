import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { TASK_ESTIMATE_MAX, TASK_ESTIMATE_MIN, TASK_TITLE_MAX_LENGTH } from '../domain/task';
import { createTaskSchema, listTasksQuerySchema, updateTaskSchema } from './task.dto';

/*
 * The task request contracts — the rules frontend/pomodoro/src/services/tasks.js mirrors
 * (CONTRACT.md §15), and the outer edge of what a request may say about a task.
 *
 * The schemas check SHAPE. What they must get exactly right is the difference between an ABSENT key
 * and a NULL one, because for `estimatedPomodoros` those are two different instructions: omit it and
 * the stored value stands, send null and it is cleared. Collapsing them makes "remove my estimate"
 * silently do nothing.
 */

/** The first message the schema reports for each field, which is all a form ever renders. */
function errorsOf(schema: ZodType, value: unknown): Record<string, string> {
  const result = schema.safeParse(value);
  if (result.success) return {};

  const messages: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.map(String).join('.') || 'body';
    messages[field] ??= issue.message;
  }
  return messages;
}

function parsed<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`expected a valid value, got: ${JSON.stringify(errorsOf(schema, value))}`);
  }
  return result.data;
}

describe('createTaskSchema', () => {
  it('accepts a title on its own', () => {
    // The only thing the add-a-task form collects. Everything else is optional by design.
    expect(createTaskSchema.safeParse({ title: 'Thesis chapter 3' }).success).toBe(true);
  });

  it('accepts a title with an estimate', () => {
    expect(
      createTaskSchema.safeParse({ title: 'Thesis chapter 3', estimatedPomodoros: 4 }).success,
    ).toBe(true);
  });

  it('trims at the boundary, so nothing downstream sees stray whitespace', () => {
    // Trimmed HERE rather than in the service, so the repository, the response and the session
    // snapshot all receive one canonical value.
    expect(parsed(createTaskSchema, { title: '  Thesis chapter 3  ' }).title).toBe(
      'Thesis chapter 3',
    );
  });

  it('rejects a title that is only whitespace', () => {
    // Trim runs first, so this is empty by the time the minimum is checked — otherwise a row of
    // spaces would become an untitled, unfindable task.
    expect(errorsOf(createTaskSchema, { title: '   ' })).toMatchObject({
      title: 'Give the task a name.',
    });
  });

  it('rejects a missing or empty title', () => {
    expect(createTaskSchema.safeParse({}).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('accepts a title at the length limit and rejects one past it', () => {
    expect(createTaskSchema.safeParse({ title: 'x'.repeat(TASK_TITLE_MAX_LENGTH) }).success).toBe(
      true,
    );
    expect(
      createTaskSchema.safeParse({ title: 'x'.repeat(TASK_TITLE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('measures the limit after trimming', () => {
    // Otherwise trailing spaces would push a legal title over the edge, and the user would be told
    // to shorten a name that is already short enough.
    const padded = `  ${'x'.repeat(TASK_TITLE_MAX_LENGTH)}  `;

    expect(createTaskSchema.safeParse({ title: padded }).success).toBe(true);
  });

  it('holds the estimate inside its documented range', () => {
    expect(
      createTaskSchema.safeParse({ title: 'A', estimatedPomodoros: TASK_ESTIMATE_MIN }).success,
    ).toBe(true);
    expect(
      createTaskSchema.safeParse({ title: 'A', estimatedPomodoros: TASK_ESTIMATE_MAX }).success,
    ).toBe(true);
    expect(createTaskSchema.safeParse({ title: 'A', estimatedPomodoros: 0 }).success).toBe(false);
    expect(
      createTaskSchema.safeParse({ title: 'A', estimatedPomodoros: TASK_ESTIMATE_MAX + 1 }).success,
    ).toBe(false);
  });

  it('requires a whole number of pomodoros', () => {
    expect(createTaskSchema.safeParse({ title: 'A', estimatedPomodoros: 2.5 }).success).toBe(false);
  });

  it('accepts an explicitly null estimate', () => {
    expect(createTaskSchema.safeParse({ title: 'A', estimatedPomodoros: null }).success).toBe(true);
  });

  it('refuses fields it does not define', () => {
    /*
     * strictObject, so a client cannot smuggle a field the API never promised. `status` is the one
     * that matters: a task is born 'todo', and letting create set it would allow a task to be
     * conjured straight into the completed-task count.
     */
    expect(createTaskSchema.safeParse({ title: 'A', status: 'completed' }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: 'A', userId: 'someone-else' }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: 'A', completedAt: '2026-01-15' }).success).toBe(
      false,
    );
  });
});

describe('updateTaskSchema', () => {
  it('accepts each field on its own', () => {
    // A PATCH: the rename form sends a title, the checkbox sends a status, and neither disturbs
    // anything it did not name.
    expect(updateTaskSchema.safeParse({ title: 'Renamed' }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ status: 'completed' }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ estimatedPomodoros: 3 }).success).toBe(true);
  });

  it('accepts every task status, including reopening', () => {
    // Refusing completed → todo would amount to telling someone they may not have been wrong.
    for (const status of ['todo', 'completed', 'abandoned']) {
      expect(updateTaskSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it('rejects a status the domain does not define', () => {
    // 'expired' and 'terminated' are the two that used to exist. Neither is a task status now.
    expect(updateTaskSchema.safeParse({ status: 'expired' }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ status: 'terminated' }).success).toBe(false);
  });

  it('rejects an empty patch', () => {
    /*
     * Without this the request would succeed and return an unchanged task, which looks exactly like
     * a write that worked. The refine is what makes "nothing happened" reportable.
     */
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
    expect(errorsOf(updateTaskSchema, {})).toMatchObject({
      body: 'Provide at least one field to update.',
    });
  });

  it('treats a null estimate as a real instruction, not an empty patch', () => {
    // Clearing an estimate is a change. The refine tests for `!== undefined` precisely so that null
    // counts as something the user asked for.
    expect(updateTaskSchema.safeParse({ estimatedPomodoros: null }).success).toBe(true);
  });

  it('applies the same title rules as create', () => {
    expect(parsed(updateTaskSchema, { title: '  Renamed  ' }).title).toBe('Renamed');
    expect(updateTaskSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(
      updateTaskSchema.safeParse({ title: 'x'.repeat(TASK_TITLE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('refuses to let a client set the derived completion time', () => {
    /*
     * `completedAt` is derived from `status` by the service. A client able to set it independently
     * could claim a task was finished at a time it was not, and every statistic is built from
     * exactly these timestamps.
     */
    expect(updateTaskSchema.safeParse({ completedAt: '2026-01-15T09:00:00.000Z' }).success).toBe(
      false,
    );
    expect(
      updateTaskSchema.safeParse({ status: 'completed', completedAt: '2020-01-01T00:00:00.000Z' })
        .success,
    ).toBe(false);
  });

  it('refuses to let a client reassign a task', () => {
    expect(updateTaskSchema.safeParse({ title: 'A', userId: 'someone-else' }).success).toBe(false);
  });
});

describe('listTasksQuerySchema', () => {
  it('accepts an empty query and defaults the page size', () => {
    expect(parsed(listTasksQuerySchema, {})).toEqual({ limit: 50 });
  });

  it('leaves status unset when the caller omits it', () => {
    /*
     * Omitting it returns EVERY status, which is what hydration wants so History can break down
     * task outcomes. A default of 'todo' here would silently make that chart read 100% in-progress.
     */
    expect(parsed(listTasksQuerySchema, {}).status).toBeUndefined();
  });

  it('accepts each supported status filter', () => {
    for (const status of ['todo', 'completed', 'abandoned']) {
      expect(listTasksQuerySchema.safeParse({ status }).success).toBe(true);
    }
    expect(listTasksQuerySchema.safeParse({ status: 'expired' }).success).toBe(false);
  });

  it('coerces the page size, because query parameters arrive as strings', () => {
    // Without coercion every request from a real client would fail the integer check.
    expect(parsed(listTasksQuerySchema, { limit: '25' }).limit).toBe(25);
  });

  it('bounds the page size', () => {
    /*
     * The ceiling is what stops one request asking the database for everything. Unbounded, a single
     * caller could pull an entire account's history in one query.
     */
    expect(listTasksQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listTasksQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listTasksQuerySchema.safeParse({ limit: '100' }).success).toBe(true);
  });

  it('requires an ISO timestamp for the lower bound', () => {
    expect(listTasksQuerySchema.safeParse({ from: '2026-01-15T00:00:00.000Z' }).success).toBe(true);
    expect(listTasksQuerySchema.safeParse({ from: '2026-01-15' }).success).toBe(false);
    expect(listTasksQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
  });

  it('accepts an offset, not only Z', () => {
    // Clients send their own zone; rejecting +05:00 would make the window wrong by hours for
    // anyone who is not on UTC.
    expect(listTasksQuerySchema.safeParse({ from: '2026-01-15T00:00:00+05:00' }).success).toBe(
      true,
    );
  });

  it('rejects an empty cursor rather than treating it as absent', () => {
    expect(listTasksQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });

  it('refuses unknown query parameters', () => {
    // A typo'd filter must fail loudly. Silently ignoring it would return an unfiltered list that
    // looks like a filtered one.
    expect(listTasksQuerySchema.safeParse({ statuss: 'todo' }).success).toBe(false);
    expect(listTasksQuerySchema.safeParse({ userId: 'someone-else' }).success).toBe(false);
  });
});
