import { Injectable } from '@nestjs/common';
import { Clock } from '../common/ports/clock.port';
import { notFoundProblem } from '../common/errors/problem.exception';
import { type Task, toTask } from '../common/types/task.types';
import type { CreateTaskDto, ListTasksQueryDto, UpdateTaskDto } from '../dto/task.dto';
import { TaskRepository } from '../repositories/task.repository';
import { completedAtFor } from '../domain/task';

/**
 * Task reads and writes for the signed-in account.
 *
 * Thin by design (ADR-005): a task has no invariants the DTO and the CHECK constraints do not
 * already enforce. The one rule that lives here is the `completedAt` pairing, because it is derived
 * from `status` rather than sent — a client that could set it independently could claim a task was
 * finished at a time it was not.
 *
 * No transition is rejected. Every status is reachable from every other, including completed → todo:
 * refusing that would amount to telling someone they are not allowed to have been wrong.
 */
@Injectable()
export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly clock: Clock,
  ) {}

  async listTasks(
    userId: string,
    query: ListTasksQueryDto,
  ): Promise<{ tasks: Task[]; nextCursor: string | null }> {
    const { tasks, nextCursor } = await this.tasks.list(userId, {
      status: query.status,
      from: query.from ? new Date(query.from) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    });

    return { tasks: tasks.map(toTask), nextCursor };
  }

  async createTask(userId: string, dto: CreateTaskDto): Promise<Task> {
    /*
     * Duplicate titles are allowed and there is no uniqueness constraint. Two tasks called "email"
     * on different days are two tasks, and rejecting the second would be the API inventing a rule
     * about the user's own vocabulary.
     */
    const record = await this.tasks.create(userId, {
      title: dto.title,
      estimatedPomodoros: dto.estimatedPomodoros ?? null,
    });

    return toTask(record);
  }

  async updateTask(userId: string, id: string, dto: UpdateTaskDto): Promise<Task> {
    const record = await this.tasks.update(userId, id, {
      title: dto.title,
      status: dto.status,
      estimatedPomodoros: dto.estimatedPomodoros,
      // Stamped on completion, cleared on every other transition. Absent when status is untouched,
      // so a rename cannot disturb it.
      completedAt:
        dto.status === undefined ? undefined : completedAtFor(dto.status, this.clock.now()),
    });

    // Not this account's task, or already deleted. 404 either way: the API never confirms that
    // somebody else's id exists (ADR-010).
    if (!record) throw notFoundProblem('That task no longer exists.');

    return toTask(record);
  }

  async deleteTask(userId: string, id: string): Promise<void> {
    const deleted = await this.tasks.delete(userId, id);
    if (!deleted) throw notFoundProblem('That task no longer exists.');
  }

  /**
   * Whether a task exists for this account.
   *
   * Exists so the session recorder can resolve a task link without reaching into the tasks table
   * itself — the repository stays the only component that touches it (ADR-020), and what crosses
   * the module boundary is a question rather than a table.
   */
  async taskExists(userId: string, taskId: string): Promise<boolean> {
    return this.tasks.existsForUser(userId, taskId);
  }
}
