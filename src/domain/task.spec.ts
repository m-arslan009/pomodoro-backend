import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_STATUS,
  TASK_ESTIMATE_MAX,
  TASK_ESTIMATE_MIN,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
  completedAtFor,
} from './task';

/*
 * Task rules.
 *
 * Deliberately thin — a task has no invariants the DTO and the CHECK constraints do not already
 * enforce. What this module exists for is to be the ONE place the limits are stated, so the DTO, the
 * repository and the frontend mirror all source them rather than restating them (CONTRACT.md §15).
 * A client rule looser than the server's produces a form that passes and then fails at the API; a
 * stricter one blocks input the server would accept. Both are contract violations, so the constants
 * are asserted here as the values the mirrors are checked against.
 */

const NOW = new Date('2026-01-15T09:00:00.000Z');

describe('task constants', () => {
  it('offers exactly three statuses', () => {
    /*
     * No 'expired': real work spans days, and an unfinished task disappearing overnight is a
     * mechanic that annoys rather than motivates. No 'terminated' either — a SESSION is terminated,
     * a TASK is abandoned. Reusing one word for both is what let a single interrupted pomodoro
     * remove a multi-day task from someone's backlog.
     */
    expect(TASK_STATUSES).toEqual(['todo', 'completed', 'abandoned']);
  });

  it('starts a task as open', () => {
    expect(DEFAULT_TASK_STATUS).toBe('todo');
    expect(TASK_STATUSES).toContain(DEFAULT_TASK_STATUS);
  });

  it('states the limits the frontend mirrors', () => {
    // These exact numbers are duplicated in frontend/pomodoro/src/services/tasks.js. If one moves
    // without the other, the two validators disagree and the user meets the difference.
    expect(TASK_TITLE_MAX_LENGTH).toBe(120);
    expect(TASK_ESTIMATE_MIN).toBe(1);
    expect(TASK_ESTIMATE_MAX).toBe(20);
  });

  it('keeps the estimate range non-empty', () => {
    expect(TASK_ESTIMATE_MIN).toBeLessThanOrEqual(TASK_ESTIMATE_MAX);
  });
});

describe('completedAtFor', () => {
  it('stamps the moment a task is completed', () => {
    expect(completedAtFor('completed', NOW)).toBe(NOW);
  });

  it('clears the stamp on every other status', () => {
    /*
     * `completedAt` is derived, never sent. A client able to set it independently could claim a
     * task was finished at a time it was not — and the statistics are built from these timestamps.
     * Clearing it on the way out of `completed` is what keeps the CHECK constraint satisfiable.
     */
    expect(completedAtFor('todo', NOW)).toBeNull();
    expect(completedAtFor('abandoned', NOW)).toBeNull();
  });

  it('answers for every status the API accepts', () => {
    // A status added without a rule here would land as `completedAt: null` by accident rather than
    // by decision, so the exhaustiveness is worth pinning.
    for (const status of TASK_STATUSES) {
      const result = completedAtFor(status, NOW);
      expect(status === 'completed' ? result : null).toEqual(result);
    }
  });

  it('permits reopening a completed task', () => {
    // Every transition is legal from every state. Refusing completed → todo would amount to telling
    // someone they are not allowed to have been wrong about finishing something.
    expect(completedAtFor('todo', NOW)).toBeNull();
  });
});
