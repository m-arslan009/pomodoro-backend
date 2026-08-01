/*
 * Task rules — pure, framework-free, ORM-free (enforced by eslint on src/domain).
 *
 * Constants and one transition helper, deliberately: a task is thin CRUD, so a domain *layer*
 * here would be ceremony. This module exists so the DTO, the repository and the frontend mirror
 * source their limits from one named authority rather than restating them (CONTRACT.md §15).
 *
 * A client rule looser than these produces a form that passes and then fails at the API; a
 * stricter one blocks input the server would accept. Both are contract violations.
 */

export const TASK_TITLE_MAX_LENGTH = 120;

export const TASK_ESTIMATE_MIN = 1;
export const TASK_ESTIMATE_MAX = 20;

/**
 * The three statuses, and no others.
 *
 * There is no 'expired': real work spans days, and an unfinished task disappearing overnight is a
 * mechanic that annoys rather than motivates. There is no 'terminated' either — a *session* is
 * terminated, a *task* is abandoned. Reusing one word for both is what let a single interrupted
 * pomodoro remove a multi-day task from the backlog.
 */
export const TASK_STATUSES = ['todo', 'completed', 'abandoned'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DEFAULT_TASK_STATUS: TaskStatus = 'todo';

/**
 * Whether a status change should stamp or clear `completedAt`.
 *
 * Every transition is legal from every state — no state machine is enforced beyond the CHECK
 * constraint. Rejecting `completed → todo` would amount to telling a user they may not have been
 * wrong about finishing something.
 */
export function completedAtFor(status: TaskStatus, now: Date): Date | null {
  return status === 'completed' ? now : null;
}
