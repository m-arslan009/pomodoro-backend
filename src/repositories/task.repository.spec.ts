import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '../common/utils/cursor';
import type { PrismaService } from '../database/prisma.service';
import { TaskRepository } from './task.repository';

/*
 * The only component allowed to read or write the tasks table (ADR-020).
 *
 * WHAT THESE TESTS CAN REACH, and what they cannot. Whether Postgres honours the predicate is
 * Postgres's business and belongs to the e2e suite; what is testable here is the QUERY THAT IS
 * BUILT, and that is where the security property lives.
 *
 * Every method takes the user id as a query CONSTRAINT rather than checking ownership after the
 * fact (ADR-010). The difference matters: a check can be forgotten in a new method, whereas a
 * constraint baked into the where-clause means a foreign id simply matches nothing. So the
 * assertions below are mostly "the user id is in the where clause", stated once per method, because
 * that single fact is what makes a foreign task 404 rather than 403.
 */

const NOW = new Date('2026-01-15T09:00:00.000Z');

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '018f0000-0000-7000-8000-00000000bbbb',
    title: 'Thesis chapter 3',
    status: 'todo',
    estimatedPomodoros: null,
    createdAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Prisma's "no row matched the where clause". */
function notFound() {
  return Object.assign(new Error('Record to update not found'), { code: 'P2025' });
}

/**
 * The query object as it reaches the driver. Every field is declared present so assertions can read
 * through it without optional chaining; the ones a given call does not carry are simply not read.
 */
interface CapturedArgs {
  where: Record<string, any>;
  data: Record<string, any>;
  select: Record<string, unknown>;
  orderBy: unknown;
  take: number;
}

const capture = (args: unknown) => args as CapturedArgs;

describe('TaskRepository', () => {
  let findManyArgs: CapturedArgs[];
  let findFirstArgs: CapturedArgs[];
  let createArgs: CapturedArgs[];
  let updateArgs: CapturedArgs[];
  let deleteArgs: CapturedArgs[];

  let rows: unknown[];
  let firstRow: unknown;
  let updateError: Error | null;
  let deleteCount: number;

  let prisma: PrismaService;
  let repository: TaskRepository;

  beforeEach(() => {
    findManyArgs = [];
    findFirstArgs = [];
    createArgs = [];
    updateArgs = [];
    deleteArgs = [];

    rows = [makeRow()];
    firstRow = { id: 'task-1' };
    updateError = null;
    deleteCount = 1;

    prisma = {
      task: {
        findMany: vi.fn((args: unknown) => {
          findManyArgs.push(capture(args));
          return Promise.resolve(rows);
        }),
        findFirst: vi.fn((args: unknown) => {
          findFirstArgs.push(capture(args));
          return Promise.resolve(firstRow);
        }),
        create: vi.fn((args: unknown) => {
          createArgs.push(capture(args));
          return Promise.resolve(makeRow());
        }),
        update: vi.fn((args: unknown) => {
          updateArgs.push(capture(args));
          return updateError ? Promise.reject(updateError) : Promise.resolve(makeRow());
        }),
        deleteMany: vi.fn((args: unknown) => {
          deleteArgs.push(capture(args));
          return Promise.resolve({ count: deleteCount });
        }),
      },
    } as unknown as PrismaService;

    repository = new TaskRepository(prisma);
  });

  describe('list', () => {
    it('constrains every read to the owning account', async () => {
      await repository.list('user-1', { limit: 50 });

      expect(findManyArgs[0].where).toMatchObject({ userId: 'user-1' });
    });

    it('filters by status only when one was asked for', async () => {
      await repository.list('user-1', { limit: 50 });
      expect(findManyArgs[0].where.status).toBeUndefined();

      await repository.list('user-1', { status: 'completed', limit: 50 });
      expect(findManyArgs[1].where.status).toBe('completed');
    });

    it('applies the creation window to resolved tasks', async () => {
      await repository.list('user-1', { status: 'completed', from: NOW, limit: 50 });

      expect(findManyArgs[0].where.createdAt).toEqual({ gte: NOW });
    });

    it('IGNORES the window for open tasks', async () => {
      /*
       * The window is right for history and wrong for a commitment. An open task created 200 days
       * ago is still open, and dropping it out of the backlog because it is old would look exactly
       * like the data loss this whole feature exists to end.
       */
      await repository.list('user-1', { status: 'todo', from: NOW, limit: 50 });

      expect(findManyArgs[0].where.createdAt).toBeUndefined();
    });

    it('applies the window to an unfiltered read', async () => {
      // Unfiltered is the hydration read, which wants every status inside the window.
      await repository.list('user-1', { from: NOW, limit: 50 });

      expect(findManyArgs[0].where.createdAt).toEqual({ gte: NOW });
    });

    it('reads newest first, with the id breaking ties', async () => {
      // The tie-break is what stops two tasks created in the same millisecond from straddling a
      // page boundary and losing one of themselves.
      await repository.list('user-1', { limit: 50 });

      expect(findManyArgs[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('over-fetches by exactly one row', async () => {
      // The extra row answers "is there another page?" without a second COUNT over the same
      // predicate. It is never returned.
      await repository.list('user-1', { limit: 50 });

      expect(findManyArgs[0].take).toBe(51);
    });

    it('turns a cursor into a keyset predicate rather than an offset', async () => {
      const cursor = encodeCursor(NOW, 'task-9');

      await repository.list('user-1', { cursor, limit: 50 });

      expect(findManyArgs[0].where.OR).toEqual([
        { createdAt: { lt: NOW } },
        { createdAt: NOW, id: { lt: 'task-9' } },
      ]);
    });

    it('starts from the beginning when the cursor is unusable', async () => {
      // A hand-edited cursor must not 500, and it must not silently return someone else's page.
      await repository.list('user-1', { cursor: 'not-a-cursor', limit: 50 });

      expect(findManyArgs[0].where.OR).toBeUndefined();
    });

    it('trims the over-fetched row and emits a cursor', async () => {
      rows = Array.from({ length: 3 }, (_, index) =>
        makeRow({ id: `task-${index}`, createdAt: new Date(NOW.getTime() - index * 1000) }),
      );

      const result = await repository.list('user-1', { limit: 2 });

      expect(result.tasks).toHaveLength(2);
      expect(result.nextCursor).not.toBeNull();
    });

    it('reports no next page when the rows do not fill the over-fetch', async () => {
      rows = [makeRow()];

      await expect(repository.list('user-1', { limit: 50 })).resolves.toMatchObject({
        nextCursor: null,
      });
    });

    it('selects only the columns the API publishes', async () => {
      // No `userId` in the projection: it is a query input, never an output, and a response that
      // carried it would be publishing the ownership it is meant to enforce silently.
      await repository.list('user-1', { limit: 50 });

      expect(Object.keys(findManyArgs[0].select).sort()).toEqual([
        'completedAt',
        'createdAt',
        'estimatedPomodoros',
        'id',
        'status',
        'title',
        'updatedAt',
      ]);
    });
  });

  describe('existsForUser', () => {
    it('scopes the lookup to the account', async () => {
      // This is what makes "someone else's task" and "no such task" indistinguishable to the
      // session recorder, so being forgiving about a missing link leaks nothing.
      await repository.existsForUser('user-1', 'task-1');

      expect(findFirstArgs[0].where).toEqual({ id: 'task-1', userId: 'user-1' });
    });

    it('answers true when a row matches', async () => {
      await expect(repository.existsForUser('user-1', 'task-1')).resolves.toBe(true);
    });

    it('answers false for a foreign or missing task', async () => {
      firstRow = null;

      await expect(repository.existsForUser('user-1', 'task-1')).resolves.toBe(false);
    });

    it('reads no more than the id', async () => {
      // It is a question, not a fetch.
      await repository.existsForUser('user-1', 'task-1');

      expect(findFirstArgs[0].select).toEqual({ id: true });
    });
  });

  describe('create', () => {
    it('stamps the owning account onto the row', async () => {
      await repository.create('user-1', { title: 'Thesis chapter 3', estimatedPomodoros: null });

      expect(createArgs[0].data).toMatchObject({ userId: 'user-1', title: 'Thesis chapter 3' });
    });

    it('writes a null estimate as null', async () => {
      await repository.create('user-1', { title: 'A', estimatedPomodoros: null });

      expect(createArgs[0].data.estimatedPomodoros).toBeNull();
    });

    it('does not set a status, so the column default decides', async () => {
      // A task is born 'todo', and the default lives in the schema where a rebuild or a manual
      // insert also sees it.
      await repository.create('user-1', { title: 'A', estimatedPomodoros: null });

      expect(createArgs[0].data).not.toHaveProperty('status');
    });
  });

  describe('update', () => {
    it('puts the account in the where clause alongside the primary key', async () => {
      /*
       * THE OWNERSHIP PROPERTY. A foreign id updates nothing rather than being updated and then
       * rejected — there is no window in which someone else's row has been written.
       */
      await repository.update('user-1', 'task-1', { title: 'Renamed' });

      expect(updateArgs[0].where).toEqual({ id: 'task-1', userId: 'user-1' });
    });

    it('writes only the fields the patch named', async () => {
      // An absent key must not reach the ORM at all — `undefined` in a Prisma `data` object is
      // ignored, but building it explicitly is what makes that intentional rather than incidental.
      await repository.update('user-1', 'task-1', { title: 'Renamed' });

      expect(updateArgs[0].data).toEqual({ title: 'Renamed' });
    });

    it('writes a completion timestamp when it was derived', async () => {
      await repository.update('user-1', 'task-1', { status: 'completed', completedAt: NOW });

      expect(updateArgs[0].data).toEqual({ status: 'completed', completedAt: NOW });
    });

    it('writes an explicit null to clear a completion timestamp', async () => {
      // Null is a value here. Dropping it would leave a reopened task carrying the moment it was
      // finished, and the CHECK constraint would refuse the row.
      await repository.update('user-1', 'task-1', { status: 'todo', completedAt: null });

      expect(updateArgs[0].data).toEqual({ status: 'todo', completedAt: null });
    });

    it('writes an explicit null to clear an estimate', async () => {
      await repository.update('user-1', 'task-1', { estimatedPomodoros: null });

      expect(updateArgs[0].data).toEqual({ estimatedPomodoros: null });
    });

    it('answers null when nothing matched, rather than throwing', async () => {
      // The service turns this into a 404. Letting Prisma's own error escape would surface as a
      // 500 for the entirely ordinary case of a task deleted in another tab.
      updateError = notFound();

      await expect(repository.update('user-1', 'task-1', { title: 'Renamed' })).resolves.toBeNull();
    });

    it('rethrows anything that is not a missing row', async () => {
      // A connection failure must not be reported to the user as "your task is gone".
      updateError = Object.assign(new Error('connection lost'), { code: 'P1001' });

      await expect(repository.update('user-1', 'task-1', { title: 'Renamed' })).rejects.toThrow(
        'connection lost',
      );
    });
  });

  describe('delete', () => {
    it('constrains the delete to the owning account', async () => {
      /*
       * deleteMany rather than delete, so a foreign id is a no-op that reports a count instead of
       * an exception — the same shape of answer as "already gone", which is what makes the two
       * indistinguishable to the caller.
       */
      await repository.delete('user-1', 'task-1');

      expect(deleteArgs[0].where).toEqual({ id: 'task-1', userId: 'user-1' });
    });

    it('reports whether anything was actually deleted', async () => {
      await expect(repository.delete('user-1', 'task-1')).resolves.toBe(true);

      deleteCount = 0;
      await expect(repository.delete('user-1', 'task-1')).resolves.toBe(false);
    });

    it('does not touch the session log', async () => {
      /*
       * The foreign key is ON DELETE SET NULL and every session carries its own title snapshot, so
       * history survives a deleted task intact. Deleting a label has never been a reason to delete
       * the work done under it, and the points already earned are not clawed back.
       *
       * The double here exposes no `focusSession` at all, so reaching for one would throw rather
       * than quietly pass — which is what makes the single delete below meaningful.
       */
      await expect(repository.delete('user-1', 'task-1')).resolves.toBe(true);

      expect(deleteArgs).toHaveLength(1);
      expect(deleteArgs[0].where).not.toHaveProperty('sessions');
    });
  });
});
