import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/errors/problem.exception';
import type { Clock } from '../common/ports/clock.port';
import type { TaskRecord } from '../common/types/task.types';
import type {
  CreateTaskInput,
  ListTasksOptions,
  TaskRepository,
  UpdateTaskInput,
} from '../repositories/task.repository';
import { TaskService } from './task.service';

/*
 * Task reads and writes for the signed-in account.
 *
 * The repository is a fake rather than a mock with expectations: what matters is the input it is
 * handed and the outcome each of its answers produces, not the call sequence used to get there.
 *
 * The service is thin by design (ADR-005), so there is exactly one decision worth covering — the
 * `completedAt` pairing. It is DERIVED from `status` rather than sent, because a client able to set
 * it independently could claim a task was finished at a time it was not, and every statistic in the
 * product is built from these timestamps.
 *
 * Ownership is absent from these tests because it is absent from the code: every method takes the id
 * the guard read off a verified token, and no route accepts one from the caller (ADR-010).
 */

const NOW = new Date('2026-01-15T09:00:00.000Z');

function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: '018f0000-0000-7000-8000-00000000bbbb',
    title: 'Thesis chapter 3',
    status: 'todo',
    estimatedPomodoros: null,
    createdAt: new Date('2026-01-15T08:00:00.000Z'),
    completedAt: null,
    updatedAt: new Date('2026-01-15T08:30:00.000Z'),
    ...overrides,
  };
}

describe('TaskService', () => {
  let listOptions: Array<{ userId: string; options: ListTasksOptions }>;
  let creates: Array<{ userId: string; input: CreateTaskInput }>;
  let updates: Array<{ userId: string; id: string; input: UpdateTaskInput }>;
  let deletes: Array<{ userId: string; id: string }>;

  let listed: TaskRecord[];
  let nextCursor: string | null;
  let created: TaskRecord;
  let updated: TaskRecord | null;
  let deleteResult: boolean;
  let exists: boolean;

  let tasks: TaskRepository;
  let service: TaskService;

  beforeEach(() => {
    listOptions = [];
    creates = [];
    updates = [];
    deletes = [];

    listed = [makeRecord()];
    nextCursor = null;
    created = makeRecord();
    updated = makeRecord();
    deleteResult = true;
    exists = true;

    tasks = {
      list: vi.fn((userId: string, options: ListTasksOptions) => {
        listOptions.push({ userId, options });
        return Promise.resolve({ tasks: listed, nextCursor });
      }),
      create: vi.fn((userId: string, input: CreateTaskInput) => {
        creates.push({ userId, input });
        return Promise.resolve(created);
      }),
      update: vi.fn((userId: string, id: string, input: UpdateTaskInput) => {
        updates.push({ userId, id, input });
        return Promise.resolve(updated);
      }),
      delete: vi.fn((userId: string, id: string) => {
        deletes.push({ userId, id });
        return Promise.resolve(deleteResult);
      }),
      existsForUser: vi.fn(() => Promise.resolve(exists)),
    } as unknown as TaskRepository;

    const clock: Clock = { now: () => NOW };

    service = new TaskService(tasks, clock);
  });

  describe('listTasks', () => {
    it('constrains the read to the id it was given', async () => {
      await service.listTasks('user-1', { limit: 50 });

      expect(listOptions[0]?.userId).toBe('user-1');
    });

    it('forwards the filters it was handed', async () => {
      await service.listTasks('user-1', {
        status: 'completed',
        from: '2026-01-01T00:00:00.000Z',
        cursor: 'opaque',
        limit: 25,
      });

      expect(listOptions[0]?.options).toMatchObject({
        status: 'completed',
        cursor: 'opaque',
        limit: 25,
      });
    });

    it('parses the lower bound into a Date for the repository', async () => {
      // The boundary speaks ISO strings; everything inside it speaks Dates.
      await service.listTasks('user-1', { from: '2026-01-01T00:00:00.000Z', limit: 50 });

      expect(listOptions[0]?.options.from).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    });

    it('leaves the lower bound unset when none was given', async () => {
      // undefined rather than a default window: unlike sessions, an open task is a commitment and
      // is never out of window.
      await service.listTasks('user-1', { limit: 50 });

      expect(listOptions[0]?.options.from).toBeUndefined();
    });

    it('maps rows to the API shape', async () => {
      listed = [makeRecord({ status: 'completed', completedAt: NOW })];

      const result = await service.listTasks('user-1', { limit: 50 });

      expect(result.tasks[0]).toEqual({
        id: '018f0000-0000-7000-8000-00000000bbbb',
        title: 'Thesis chapter 3',
        status: 'completed',
        estimatedPomodoros: null,
        createdAt: '2026-01-15T08:00:00.000Z',
        completedAt: '2026-01-15T09:00:00.000Z',
        updatedAt: '2026-01-15T08:30:00.000Z',
      });
    });

    it('passes the page cursor straight back out', async () => {
      nextCursor = 'next-page';

      await expect(service.listTasks('user-1', { limit: 50 })).resolves.toMatchObject({
        nextCursor: 'next-page',
      });
    });

    it('answers with an empty list rather than failing on a new account', async () => {
      listed = [];

      await expect(service.listTasks('user-1', { limit: 50 })).resolves.toEqual({
        tasks: [],
        nextCursor: null,
      });
    });
  });

  describe('createTask', () => {
    it('writes against the id it was given', async () => {
      await service.createTask('user-1', { title: 'Thesis chapter 3' });

      expect(creates[0]?.userId).toBe('user-1');
    });

    it('defaults an omitted estimate to null', async () => {
      // The column is nullable and the repository writes what it is handed; `undefined` would
      // reach the ORM as "no opinion" on an insert, which is not the same as "no estimate".
      await service.createTask('user-1', { title: 'Thesis chapter 3' });

      expect(creates[0]?.input).toEqual({ title: 'Thesis chapter 3', estimatedPomodoros: null });
    });

    it('carries an estimate that was given', async () => {
      await service.createTask('user-1', { title: 'Thesis chapter 3', estimatedPomodoros: 4 });

      expect(creates[0]?.input.estimatedPomodoros).toBe(4);
    });

    it('allows a duplicate title', async () => {
      /*
       * There is no uniqueness constraint and no check here. Two tasks called "email" on different
       * days are two tasks, and rejecting the second would be the API inventing a rule about the
       * user's own vocabulary.
       */
      await service.createTask('user-1', { title: 'email' });
      await service.createTask('user-1', { title: 'email' });

      expect(tasks.create).toHaveBeenCalledTimes(2);
    });

    it('answers with the stored row', async () => {
      created = makeRecord({ id: 'server-1', title: 'Thesis chapter 3' });

      await expect(
        service.createTask('user-1', { title: 'Thesis chapter 3' }),
      ).resolves.toMatchObject({ id: 'server-1', status: 'todo', completedAt: null });
    });
  });

  describe('updateTask', () => {
    it('writes against the id it was given', async () => {
      await service.updateTask('user-1', 'task-1', { title: 'Renamed' });

      expect(updates[0]).toMatchObject({ userId: 'user-1', id: 'task-1' });
    });

    it('leaves completedAt untouched when the status was not named', async () => {
      /*
       * THE RULE THIS SERVICE EXISTS FOR. A rename must not disturb a completion timestamp —
       * `undefined` is how the repository is told not to touch the column at all.
       */
      await service.updateTask('user-1', 'task-1', { title: 'Renamed' });

      expect(updates[0]?.input.completedAt).toBeUndefined();
      expect(updates[0]?.input).toMatchObject({ title: 'Renamed', status: undefined });
    });

    it('stamps completedAt from the clock when a task is completed', async () => {
      // From the clock port, never from the request: the server decides when "now" was.
      await service.updateTask('user-1', 'task-1', { status: 'completed' });

      expect(updates[0]?.input.completedAt).toEqual(NOW);
    });

    it('clears completedAt when a task is reopened', async () => {
      // Leaving a stale timestamp behind would violate the CHECK constraint and, worse, keep the
      // task in the completed-task count while it sat in the backlog.
      await service.updateTask('user-1', 'task-1', { status: 'todo' });

      expect(updates[0]?.input.completedAt).toBeNull();
    });

    it('clears completedAt when a task is abandoned', async () => {
      await service.updateTask('user-1', 'task-1', { status: 'abandoned' });

      expect(updates[0]?.input.completedAt).toBeNull();
    });

    it('forwards a null estimate as the instruction to clear it', async () => {
      // Null is a value here, not an omission.
      await service.updateTask('user-1', 'task-1', { estimatedPomodoros: null });

      expect(updates[0]?.input.estimatedPomodoros).toBeNull();
    });

    it('answers with the stored row rather than the patch', async () => {
      // The client replaces its copy with this, so it has to be what the database now holds —
      // including `updatedAt`, which the patch never mentions.
      updated = makeRecord({ title: 'Renamed', updatedAt: NOW });

      await expect(
        service.updateTask('user-1', 'task-1', { title: 'Renamed' }),
      ).resolves.toMatchObject({ title: 'Renamed', updatedAt: '2026-01-15T09:00:00.000Z' });
    });

    it('reports a missing task as not found, never as forbidden', async () => {
      /*
       * Not this account's task, or already deleted — and the two are indistinguishable on purpose.
       * A 403 would confirm that somebody else's id exists (ADR-010).
       */
      updated = null;

      const error = (await service
        .updateTask('user-1', 'someone-elses-task', { title: 'Renamed' })
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error).toBeInstanceOf(ProblemException);
      expect(error.problem.status).toBe(404);
      expect(error.problem.title).toBe('Not found');
    });
  });

  describe('deleteTask', () => {
    it('deletes against the id it was given', async () => {
      await service.deleteTask('user-1', 'task-1');

      expect(deletes[0]).toEqual({ userId: 'user-1', id: 'task-1' });
    });

    it('reports a missing task as not found', async () => {
      deleteResult = false;

      const error = (await service
        .deleteTask('user-1', 'task-1')
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error).toBeInstanceOf(ProblemException);
      expect(error.problem.status).toBe(404);
    });

    it('resolves with nothing on success, because 204 has no body', async () => {
      await expect(service.deleteTask('user-1', 'task-1')).resolves.toBeUndefined();
    });
  });

  describe('taskExists', () => {
    it('asks the repository, scoped to the account', async () => {
      /*
       * Exists so the session recorder can resolve a task link without reaching into the tasks
       * table itself — the repository stays the only component that touches it (ADR-020), and what
       * crosses the module boundary is a question rather than a table.
       */
      await service.taskExists('user-1', 'task-1');

      expect(tasks.existsForUser).toHaveBeenCalledWith('user-1', 'task-1');
    });

    it('answers false for a task belonging to someone else', async () => {
      // The lookup is scoped by user id, so "someone else's task" and "no such task" produce
      // identical answers and nothing is leaked.
      exists = false;

      await expect(service.taskExists('user-1', 'foreign-task')).resolves.toBe(false);
    });
  });
});
