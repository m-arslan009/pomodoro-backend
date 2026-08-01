import type { TaskStatus } from '../../domain/task';

/*
 * Plain shapes that cross layer boundaries.
 *
 * The repository maps Prisma rows onto `TaskRecord` before returning them, so no ORM type reaches
 * a service or a controller — the same discipline user.types.ts applies, and what keeps ADR-004's
 * "swap the data-access tool" escape hatch real rather than theoretical.
 */

/** A task row as the repository returns it. Dates are Dates. */
export interface TaskRecord {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly estimatedPomodoros: number | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
}

/**
 * What the API returns for a task (CONTRACT.md §16). One shape for every task response, so the
 * client can hold exactly this in its store and never map between two variants.
 */
export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly estimatedPomodoros: number | null;
  readonly createdAt: string;
  /** Set if and only if the task is completed — a CHECK constraint guarantees the pairing. */
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export function toTask(record: TaskRecord): Task {
  return {
    id: record.id,
    title: record.title,
    status: record.status as TaskStatus,
    estimatedPomodoros: record.estimatedPomodoros,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  };
}
