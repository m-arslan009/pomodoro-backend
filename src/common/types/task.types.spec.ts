import { describe, expect, it } from 'vitest';
import { type TaskRecord, toTask } from './task.types';

/*
 * The row-to-response mapper for tasks.
 *
 * The reason it exists at all is ADR-004's escape hatch: the repository maps Prisma rows onto
 * `TaskRecord` before returning them, so no ORM type reaches a service or a controller. That is what
 * keeps "swap the data-access tool" real rather than theoretical, and it only holds while every
 * response actually goes through here.
 */

const RECORD: TaskRecord = {
  id: '018f0000-0000-7000-8000-00000000bbbb',
  title: 'Thesis chapter 3',
  status: 'todo',
  estimatedPomodoros: null,
  createdAt: new Date('2026-01-15T08:00:00.000Z'),
  completedAt: null,
  updatedAt: new Date('2026-01-15T08:30:00.000Z'),
};

describe('toTask', () => {
  it('returns exactly the contract field set', () => {
    // One shape for every task response, so the client holds this and never maps between variants.
    expect(Object.keys(toTask(RECORD)).sort()).toEqual([
      'completedAt',
      'createdAt',
      'estimatedPomodoros',
      'id',
      'status',
      'title',
      'updatedAt',
    ]);
  });

  it('never publishes the owning account', () => {
    /*
     * No response carries a user id, because no request accepts one (ADR-010). Ownership is a query
     * constraint, and a task that came back at all is already this account's.
     */
    expect(toTask(RECORD)).not.toHaveProperty('userId');
  });

  it('serialises timestamps as ISO strings', () => {
    const task = toTask(RECORD);

    expect(task.createdAt).toBe('2026-01-15T08:00:00.000Z');
    expect(task.updatedAt).toBe('2026-01-15T08:30:00.000Z');
  });

  it('reports an unfinished task as having no completion time', () => {
    // Null rather than absent: the client stores this object as-is, and an absent key would read as
    // "unknown" where the answer is definitely "not completed".
    expect(toTask(RECORD).completedAt).toBeNull();
  });

  it('serialises a completion time when there is one', () => {
    const completed = toTask({
      ...RECORD,
      status: 'completed',
      completedAt: new Date('2026-01-15T10:00:00.000Z'),
    });

    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBe('2026-01-15T10:00:00.000Z');
  });

  it('carries an estimate through, including its absence', () => {
    expect(toTask(RECORD).estimatedPomodoros).toBeNull();
    expect(toTask({ ...RECORD, estimatedPomodoros: 4 }).estimatedPomodoros).toBe(4);
  });

  it('passes an abandoned task through with no completion time', () => {
    // Abandoned is a real outcome and appears in the outcome breakdown; it is simply not a
    // completion, so the CHECK-constrained pairing holds.
    const abandoned = toTask({ ...RECORD, status: 'abandoned' });

    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.completedAt).toBeNull();
  });
});
