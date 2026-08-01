import { Injectable } from '@nestjs/common';
import type { TaskRecord } from '../common/types/task.types';
import { decodeCursor, paginate } from '../common/utils/cursor';
import { PrismaService } from '../database/prisma.service';
import type { TaskStatus } from '../domain/task';

/*
 * The only component allowed to read or write the tasks table (ADR-020).
 *
 * Every method takes the user id as a QUERY CONSTRAINT rather than checking ownership after the
 * fact (ADR-010). The difference matters: a check can be forgotten in a new method, whereas a
 * constraint baked into the where-clause means a foreign id simply matches nothing. That is also
 * why a foreign task yields 404 rather than 403 — the row is not "forbidden", it is not there, and
 * the API never confirms that someone else's id exists.
 */

export interface ListTasksOptions {
  readonly status?: TaskStatus;
  readonly from?: Date;
  readonly cursor?: string;
  readonly limit: number;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly estimatedPomodoros: number | null;
}

export interface UpdateTaskInput {
  readonly title?: string;
  readonly status?: TaskStatus;
  readonly estimatedPomodoros?: number | null;
  /** Derived from `status` by the service; set on completion, cleared on any other transition. */
  readonly completedAt?: Date | null;
}

const TASK_FIELDS = {
  id: true,
  title: true,
  status: true,
  estimatedPomodoros: true,
  createdAt: true,
  completedAt: true,
  updatedAt: true,
} as const;

/** Prisma's "no row matched the where clause" — here always "not this user's task, or gone". */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';
}

@Injectable()
export class TaskRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A page of tasks, newest first.
   *
   * `from` is deliberately IGNORED for `status: 'todo'`. The window is right for history and wrong
   * for a commitment: an open task created 200 days ago is still open, and dropping it out of the
   * backlog because it is old would look exactly like the data loss this feature exists to end.
   */
  async list(
    userId: string,
    options: ListTasksOptions,
  ): Promise<{
    tasks: TaskRecord[];
    nextCursor: string | null;
  }> {
    const cursor = decodeCursor(options.cursor);
    const windowed = options.from && options.status !== 'todo' ? options.from : undefined;

    const rows = await this.prisma.task.findMany({
      where: {
        userId,
        ...(options.status ? { status: options.status } : {}),
        ...(windowed ? { createdAt: { gte: windowed } } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.timestamp } },
                { createdAt: cursor.timestamp, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than asked for, purely to answer "is there another page?".
      take: options.limit + 1,
      select: TASK_FIELDS,
    });

    const { items, nextCursor } = paginate(rows, options.limit, (row) => ({
      timestamp: row.createdAt,
      id: row.id,
    }));

    return { tasks: items, nextCursor };
  }

  /** Used by the recording path to resolve a task link without owning the session tables. */
  async existsForUser(userId: string, taskId: string): Promise<boolean> {
    const row = await this.prisma.task.findFirst({
      where: { id: taskId, userId },
      select: { id: true },
    });
    return row !== null;
  }

  async create(userId: string, input: CreateTaskInput): Promise<TaskRecord> {
    return this.prisma.task.create({
      data: {
        userId,
        title: input.title,
        estimatedPomodoros: input.estimatedPomodoros,
      },
      select: TASK_FIELDS,
    });
  }

  /**
   * Apply a patch. Null when the task does not exist for this user.
   *
   * The user id sits in the `where` alongside the primary key, so a foreign id updates nothing
   * rather than being updated and then rejected.
   */
  async update(userId: string, id: string, input: UpdateTaskInput): Promise<TaskRecord | null> {
    try {
      return await this.prisma.task.update({
        where: { id, userId },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.estimatedPomodoros === undefined
            ? {}
            : { estimatedPomodoros: input.estimatedPomodoros }),
          ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
        },
        select: TASK_FIELDS,
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Hard delete. False when there was nothing to delete.
   *
   * Sessions recorded against this task are NOT deleted: the foreign key is ON DELETE SET NULL, and
   * each session carries its own title snapshot, so history survives intact. The event log is
   * append-only, and points already earned are not clawed back by an edit to a label.
   */
  async delete(userId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.task.deleteMany({ where: { id, userId } });
    return count > 0;
  }
}
