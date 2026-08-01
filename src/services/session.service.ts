import { Injectable } from '@nestjs/common';
import { sessionConflictProblem, validationProblem } from '../common/errors/problem.exception';
import { Clock } from '../common/ports/clock.port';
import {
  type GamificationSnapshot,
  type Session,
  toGamificationSnapshot,
  toSession,
} from '../common/types/session.types';
import type { ListSessionsQueryDto, RecordSessionDto } from '../dto/session.dto';
import { applySession, attributionDate } from '../domain/gamification';
import {
  HYDRATION_WINDOW_DAYS,
  TIMING_VIOLATION_FIELDS,
  TIMING_VIOLATION_MESSAGES,
  checkTiming,
  clampDuration,
  reasonIsConsistent,
} from '../domain/session';
import { SessionRepository } from '../repositories/session.repository';
import { TaskService } from './task.service';

/**
 * Recording and reading the focus event log.
 *
 * This is the one endpoint in the product with real domain weight, and the responsibility split is
 * the point of it: the client owns the running countdown and reports what happened; the server owns
 * whether that is plausible, what it is worth, and what day it counts toward. The client computes
 * nothing — points drive titles and titles unlock features, so a client that scored itself could
 * award itself the product.
 *
 * Every completed or terminated interval becomes one immutable record. History and analytics are
 * derived from those records alone, which is why there are no statistics endpoints and no
 * History-specific tables: the log is sufficient, so anything else would be a second source of
 * truth to keep in step with it.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly tasks: TaskService,
    private readonly clock: Clock,
  ) {}

  /**
   * Record a finished interval.
   *
   * `replayed` in the result is what lets the controller answer 200 instead of 201 for a retried
   * outbox flush.
   */
  async recordSession(
    userId: string,
    timeZone: string,
    dto: RecordSessionDto,
  ): Promise<{ session: Session; gamification: GamificationSnapshot; replayed: boolean }> {
    const startedAt = new Date(dto.startedAt);
    const endedAt = new Date(dto.endedAt);
    const now = this.clock.now();

    /*
     * A reason is required on a terminated focus block and forbidden anywhere else. Checked here
     * rather than in the schema because it is a relationship between three fields, and a Zod
     * refinement spanning three fields reports against the object rather than the input the user
     * can actually see.
     */
    if (!reasonIsConsistent(dto.type, dto.status, dto.terminationReason)) {
      throw validationProblem([
        {
          field: 'terminationReason',
          message:
            dto.type === 'focus' && dto.status === 'terminated'
              ? 'Tell us why the block ended early.'
              : 'Only a terminated focus session can carry a reason.',
        },
      ]);
    }

    // Rules 1-5 of the ordered time-authority list, in order (CONTRACT.md §15.1).
    const violation = checkTiming(
      {
        startedAt,
        endedAt,
        plannedDurationMs: dto.plannedDurationMs,
        actualDurationMs: dto.actualDurationMs,
      },
      now,
    );

    if (violation) {
      throw validationProblem([
        {
          field: TIMING_VIOLATION_FIELDS[violation],
          message: TIMING_VIOLATION_MESSAGES[violation],
        },
      ]);
    }

    /*
     * An unknown, deleted, or foreign task id does NOT fail the request — the session is recorded
     * with a null link and keeps its title snapshot.
     *
     * Losing an earned session to a broken foreign key would be a far worse outcome than losing the
     * link: the work happened. And because the lookup is scoped by user id, "someone else's task"
     * and "no such task" produce identical results, so nothing is leaked by being forgiving here.
     */
    const taskId =
      dto.taskId && (await this.tasks.taskExists(userId, dto.taskId)) ? dto.taskId : null;

    // Rule 7 — bound the reported duration BEFORE anything is computed from it.
    const actualDurationMs = clampDuration(dto.actualDurationMs, dto.plannedDurationMs);

    // Rule 8 — which user-local day this counts toward. Late arrivals attribute to receipt, so a
    // stale record can be stored truthfully without repairing a streak somebody already broke.
    const day = attributionDate(startedAt, now, timeZone);

    const outcome = await this.sessions.record(
      {
        userId,
        clientSessionId: dto.clientSessionId,
        taskId,
        taskTitle: dto.taskTitle,
        type: dto.type,
        status: dto.status,
        startedAt,
        endedAt,
        plannedDurationMs: dto.plannedDurationMs,
        actualDurationMs,
        terminationReason: dto.terminationReason,
        attributionDate: day,
      },
      (state) => applySession(state, { type: dto.type, status: dto.status, attributionDate: day }),
    );

    switch (outcome.kind) {
      case 'created':
        return {
          session: toSession(outcome.session),
          gamification: toGamificationSnapshot(
            outcome.state,
            outcome.pointsAwarded,
            outcome.newlyUnlocked,
          ),
          replayed: false,
        };

      case 'replayed':
        /*
         * The same record, returned unchanged, with a zero delta and nothing newly unlocked — a
         * retry must not re-announce a title or re-report points the user already saw.
         */
        return {
          session: toSession(outcome.session),
          gamification: toGamificationSnapshot(outcome.state),
          replayed: true,
        };

      /*
       * Rule 6 of the ordered list, and like every other rule in it a 422 naming the field —
       * NOT a 409. The distinction is deliberate: this is the validated path rejecting an
       * implausible record, whereas 'conflict' below is the unique constraint catching a race
       * that slipped past this very check. Same symptom, different layer, different answer.
       */
      case 'overlap':
        throw validationProblem([
          {
            field: 'startedAt',
            message: 'That time range overlaps a session you have already recorded.',
          },
        ]);

      case 'conflict':
        throw sessionConflictProblem('A different session already starts at that exact time.');
    }
  }

  /**
   * The hydration read: the window History can actually render.
   *
   * `from` defaults to 180 days back because that is exactly what the client's widest chart covers.
   * Serving more would ship data nothing displays; serving less would leave a chart with holes.
   */
  async listSessions(
    userId: string,
    query: ListSessionsQueryDto,
  ): Promise<{ sessions: Session[]; nextCursor: string | null }> {
    const from = query.from
      ? new Date(query.from)
      : new Date(this.clock.now().getTime() - HYDRATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const to = query.to ? new Date(query.to) : undefined;

    if (to && to < from) {
      throw validationProblem([
        { field: 'to', message: 'The end of the range precedes its start.' },
      ]);
    }

    const { sessions, nextCursor } = await this.sessions.list(userId, {
      from,
      to,
      cursor: query.cursor,
      limit: query.limit,
    });

    return { sessions: sessions.map(toSession), nextCursor };
  }
}
