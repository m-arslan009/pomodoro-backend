import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../common/types/task.types';
import type { AuthContext, UserProfile } from '../common/types/user.types';
import type { TaskService } from '../services/task.service';
import { TaskController } from './task.controller';

/*
 * The `/tasks` routes (CONTRACT.md §16.1-§16.4).
 *
 * The controller is instantiated directly rather than through a testing module: what is asserted is
 * the code in these methods — which id reaches the service and what envelope comes back — not that
 * Nest can wire a constructor.
 *
 * THE OWNERSHIP PROPERTY IS THE ONE WORTH STATING PLAINLY. No route accepts a user id. Every method
 * reads its subject from `auth`, which the guard built from a verified token, so the tests below
 * hand the controller an auth context for one account and a payload naming another and assert the
 * payload changes nothing (ADR-010).
 */

const PROFILE: UserProfile = {
  id: 'user-1',
  email: 'ada@evergrove.app',
  username: 'Ada_L',
  firstName: 'Ada',
  lastName: 'Lovelace',
  timezone: 'Europe/London',
  emailVerified: false,
  avatarUpdatedAt: null,
  createdAt: '2026-07-28T09:00:00.000Z',
};

const TASK: Task = {
  id: '018f0000-0000-7000-8000-00000000bbbb',
  title: 'Thesis chapter 3',
  status: 'todo',
  estimatedPomodoros: null,
  createdAt: '2026-01-15T08:00:00.000Z',
  completedAt: null,
  updatedAt: '2026-01-15T08:30:00.000Z',
};

function authFor(profile: UserProfile = PROFILE): AuthContext {
  return { userId: profile.id, profile };
}

describe('TaskController', () => {
  let tasks: TaskService;
  let controller: TaskController;

  beforeEach(() => {
    tasks = {
      listTasks: vi.fn(() => Promise.resolve({ tasks: [TASK], nextCursor: null })),
      createTask: vi.fn(() => Promise.resolve(TASK)),
      updateTask: vi.fn(() => Promise.resolve(TASK)),
      deleteTask: vi.fn(() => Promise.resolve()),
    } as unknown as TaskService;

    controller = new TaskController(tasks);
  });

  describe('GET /tasks', () => {
    it('reads the account the token names', async () => {
      await controller.list(authFor(), { limit: 50 });

      expect(tasks.listTasks).toHaveBeenCalledWith('user-1', { limit: 50 });
    });

    it('forwards the query untouched', async () => {
      // The controller adds nothing to it — the defaults live in the schema and the window logic
      // lives in the service.
      const query = { status: 'todo' as const, cursor: 'opaque', limit: 25 };

      await controller.list(authFor(), query);

      expect(tasks.listTasks).toHaveBeenCalledWith('user-1', query);
    });

    it('returns the page unwrapped, list and cursor together', async () => {
      // Not nested under a `data` key: the client destructures exactly this.
      await expect(controller.list(authFor(), { limit: 50 })).resolves.toEqual({
        tasks: [TASK],
        nextCursor: null,
      });
    });
  });

  describe('POST /tasks', () => {
    it('creates against the account the token names', async () => {
      await controller.create(authFor(), { title: 'Thesis chapter 3' });

      expect(tasks.createTask).toHaveBeenCalledWith('user-1', { title: 'Thesis chapter 3' });
    });

    it('wraps the task in its envelope', async () => {
      // `{ task }` rather than the bare object, so the response has room to grow a sibling field
      // without becoming a breaking change.
      await expect(controller.create(authFor(), { title: 'Thesis chapter 3' })).resolves.toEqual({
        task: TASK,
      });
    });
  });

  describe('PATCH /tasks/:id', () => {
    it('applies the patch to the account the token names', async () => {
      await controller.update(authFor(), 'task-1', { title: 'Renamed' });

      expect(tasks.updateTask).toHaveBeenCalledWith('user-1', 'task-1', { title: 'Renamed' });
    });

    it('wraps the task in its envelope', async () => {
      await expect(controller.update(authFor(), 'task-1', { title: 'Renamed' })).resolves.toEqual({
        task: TASK,
      });
    });

    it('takes the account from the token, never from the body', async () => {
      /*
       * The payload here names another account. It is not rejected and it is not honoured — it is
       * simply not read, which is what makes the guarantee structural rather than a check somebody
       * could forget to write in the next method.
       */
      await controller.update(authFor(), 'task-1', {
        title: 'Renamed',
        userId: 'someone-else',
      } as never);

      expect(tasks.updateTask).toHaveBeenCalledWith(
        'user-1',
        'task-1',
        expect.objectContaining({ title: 'Renamed' }),
      );
    });
  });

  describe('DELETE /tasks/:id', () => {
    it('deletes against the account the token names', async () => {
      await controller.remove(authFor(), 'task-1');

      expect(tasks.deleteTask).toHaveBeenCalledWith('user-1', 'task-1');
    });

    it('returns nothing, because the route answers 204', async () => {
      // A body on a 204 is discarded by the transport and would only mislead whoever wrote it.
      await expect(controller.remove(authFor(), 'task-1')).resolves.toBeUndefined();
    });
  });

  describe('ownership', () => {
    it('routes every method through the id on the token', async () => {
      // One assertion covering the shape of all four, so a fifth method added without `auth` stands
      // out here rather than in production.
      const other = authFor({ ...PROFILE, id: 'user-2' });

      await controller.list(other, { limit: 50 });
      await controller.create(other, { title: 'A' });
      await controller.update(other, 'task-1', { title: 'A' });
      await controller.remove(other, 'task-1');

      expect(tasks.listTasks).toHaveBeenCalledWith('user-2', expect.anything());
      expect(tasks.createTask).toHaveBeenCalledWith('user-2', expect.anything());
      expect(tasks.updateTask).toHaveBeenCalledWith('user-2', 'task-1', expect.anything());
      expect(tasks.deleteTask).toHaveBeenCalledWith('user-2', 'task-1');
    });
  });
});
