import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/errors/problem.exception';
import type { Clock } from '../common/ports/clock.port';
import type { SessionRecord } from '../common/types/session.types';
import {
  emptyGamification,
  type AppliedSession,
  type GamificationState,
} from '../domain/gamification';
import type { RecordSessionDto } from '../dto/session.dto';
import type {
  ListSessionsOptions,
  PersistSessionInput,
  RecordOutcome,
  SessionRepository,
} from '../repositories/session.repository';
import type { TaskService } from './task.service';
import { SessionService } from './session.service';

/*
 * Recording and reading the focus event log — the one endpoint in the product with real domain
 * weight.
 *
 * The responsibility split is the whole point of it. The client owns the running countdown and
 * reports what happened; the server owns whether that is plausible, what it is worth, and what day
 * it counts toward. So the assertions here are mostly about what the service REFUSES to take the
 * client's word for.
 *
 * The repository is a fake that actually invokes the `advance` callback, because the fact that the
 * service hands the domain fold down rather than scoring inline is the property that keeps the live
 * path and the rebuild path the same function (ADR-006).
 */

const NOW = new Date('2026-01-15T09:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const CLIENT_SESSION_ID = '018f0000-0000-7000-8000-00000000cccc';
const TASK_ID = '018f0000-0000-7000-8000-00000000bbbb';

function dto(overrides: Partial<RecordSessionDto> = {}): RecordSessionDto {
  const startedAt = new Date(NOW.getTime() - 30 * MINUTE);
  return {
    clientSessionId: CLIENT_SESSION_ID,
    taskId: TASK_ID,
    taskTitle: 'Thesis chapter 3',
    type: 'focus',
    status: 'completed',
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + 25 * MINUTE).toISOString(),
    plannedDurationMs: 25 * MINUTE,
    actualDurationMs: 25 * MINUTE,
    terminationReason: null,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const startedAt = new Date(NOW.getTime() - 30 * MINUTE);
  return {
    id: '018f0000-0000-7000-8000-00000000aaaa',
    taskId: TASK_ID,
    taskTitleSnapshot: 'Thesis chapter 3',
    clientSessionId: CLIENT_SESSION_ID,
    type: 'focus',
    status: 'completed',
    startedAt,
    endedAt: new Date(startedAt.getTime() + 25 * MINUTE),
    plannedDurationMs: 25 * MINUTE,
    actualDurationMs: 25 * MINUTE,
    terminationReason: null,
    pointsAwarded: 100,
    attributionDate: '2026-01-15',
    ...overrides,
  };
}

/** The first field error a rejection carries, which is what the client places on an input. */
function fieldErrorOf(error: ProblemException) {
  return error.problem.errors?.[0];
}

describe('SessionService', () => {
  let persisted: PersistSessionInput[];
  let applied: AppliedSession[];
  let listOptions: Array<{ userId: string; options: ListSessionsOptions }>;

  let outcome: (input: PersistSessionInput, applied: AppliedSession) => RecordOutcome;
  let startingState: GamificationState;
  let listed: SessionRecord[];
  let nextCursor: string | null;
  let taskExists: boolean;

  let sessions: SessionRepository;
  let tasks: TaskService;
  let service: SessionService;

  beforeEach(() => {
    persisted = [];
    applied = [];
    listOptions = [];

    startingState = emptyGamification();
    listed = [makeRecord()];
    nextCursor = null;
    taskExists = true;

    outcome = (input, result) => ({
      kind: 'created',
      session: makeRecord({
        taskId: input.taskId,
        taskTitleSnapshot: input.taskTitle,
        actualDurationMs: input.actualDurationMs,
        pointsAwarded: result.pointsAwarded,
      }),
      state: result.state,
      pointsAwarded: result.pointsAwarded,
      newlyUnlocked: result.newlyUnlocked,
    });

    sessions = {
      record: vi.fn(
        (input: PersistSessionInput, advance: (s: GamificationState) => AppliedSession) => {
          persisted.push(input);
          // Actually run the fold, so the points in the response are the domain's and not a fixture's.
          const result = advance(startingState);
          applied.push(result);
          return Promise.resolve(outcome(input, result));
        },
      ),
      list: vi.fn((userId: string, options: ListSessionsOptions) => {
        listOptions.push({ userId, options });
        return Promise.resolve({ sessions: listed, nextCursor });
      }),
    } as unknown as SessionRepository;

    tasks = {
      taskExists: vi.fn(() => Promise.resolve(taskExists)),
    } as unknown as TaskService;

    const clock: Clock = { now: () => NOW };

    service = new SessionService(sessions, tasks, clock);
  });

  describe('recordSession — the happy path', () => {
    it('persists the record against the account it was told', async () => {
      await service.recordSession('user-1', 'UTC', dto());

      expect(persisted[0]?.userId).toBe('user-1');
    });

    it('stores the client’s idempotency key, because that is what makes a retry safe', async () => {
      await service.recordSession('user-1', 'UTC', dto());

      expect(persisted[0]?.clientSessionId).toBe(CLIENT_SESSION_ID);
    });

    it('stores the title snapshot verbatim', async () => {
      /*
       * Not derived from the task row. Once a task can be renamed or deleted, deriving it would
       * either fail outright or stamp work with a name it was never done under.
       */
      await service.recordSession('user-1', 'UTC', dto({ taskTitle: 'Deep work' }));

      expect(persisted[0]?.taskTitle).toBe('Deep work');
    });

    it('parses the boundary’s ISO strings into Dates', async () => {
      await service.recordSession('user-1', 'UTC', dto());

      expect(persisted[0]?.startedAt).toBeInstanceOf(Date);
      expect(persisted[0]?.endedAt).toBeInstanceOf(Date);
    });

    it('answers with the stored record and the recomputed totals in one round trip', async () => {
      /*
       * RPC-flavoured on purpose (ADR-007): a session never costs two requests, and the record and
       * the totals can never disagree with each other.
       */
      const result = await service.recordSession('user-1', 'UTC', dto());

      expect(result.session.clientSessionId).toBe(CLIENT_SESSION_ID);
      expect(result.gamification.lifetimePoints).toBe(100);
      expect(result.gamification.pointsDelta).toBe(100);
      expect(result.replayed).toBe(false);
    });

    it('takes the score from the domain fold rather than computing one', async () => {
      // The service hands `advance` down and adopts whatever it returns. That is what keeps the
      // live path and the rebuild path literally the same function.
      startingState = { ...emptyGamification(), currentSessionRun: 2 };

      const result = await service.recordSession('user-1', 'UTC', dto());

      // Third in a row, so the consecutive bonus applies — decided in src/domain, not here.
      expect(result.gamification.pointsDelta).toBe(150);
      expect(applied[0]?.pointsAwarded).toBe(150);
    });

    it('announces a title crossed by this session', async () => {
      startingState = { ...emptyGamification(), lifetimePoints: 950, balance: 950 };

      const result = await service.recordSession('user-1', 'UTC', dto());

      expect(result.gamification.newlyUnlocked).toEqual(['anchor']);
    });
  });

  describe('recordSession — the task link', () => {
    it('keeps the link when the task is this account’s', async () => {
      await service.recordSession('user-1', 'UTC', dto());

      expect(tasks.taskExists).toHaveBeenCalledWith('user-1', TASK_ID);
      expect(persisted[0]?.taskId).toBe(TASK_ID);
    });

    it('records the session unlinked when the task is unknown, deleted or foreign', async () => {
      /*
       * NOT a rejection. Losing an earned session to a broken foreign key would be far worse than
       * losing the link — the work happened. And because the lookup is scoped by user id, "someone
       * else's task" and "no such task" are indistinguishable, so nothing leaks by being forgiving.
       */
      taskExists = false;

      const result = await service.recordSession('user-1', 'UTC', dto());

      expect(persisted[0]?.taskId).toBeNull();
      expect(persisted[0]?.taskTitle).toBe('Thesis chapter 3');
      expect(result.session.taskTitle).toBe('Thesis chapter 3');
    });

    it('does not look up a task when the client sent none', async () => {
      await service.recordSession('user-1', 'UTC', dto({ taskId: null }));

      expect(tasks.taskExists).not.toHaveBeenCalled();
      expect(persisted[0]?.taskId).toBeNull();
    });
  });

  describe('recordSession — the time authority', () => {
    it('clamps the reported duration before anything is computed from it', async () => {
      /*
       * Rule 7. Validation already rejects a duration past the plan, so this is normally a no-op —
       * it exists so "clamped before computing" is true at the point of computation rather than by
       * the grace of a check upstream.
       */
      await service.recordSession('user-1', 'UTC', dto({ actualDurationMs: 25 * MINUTE }));

      const stored = persisted[0];
      expect(stored?.actualDurationMs).toBeLessThanOrEqual(stored?.plannedDurationMs ?? 0);
    });

    it('stores the floor of a fractional duration', async () => {
      await service.recordSession('user-1', 'UTC', dto({ actualDurationMs: 1500.9 }));

      expect(persisted[0]?.actualDurationMs).toBe(1500);
    });

    it('attributes a promptly delivered record to the day it started', async () => {
      await service.recordSession('user-1', 'UTC', dto());

      expect(persisted[0]?.attributionDate).toBe('2026-01-15');
    });

    it('attributes a long-queued record to the day it was received', async () => {
      // The anti-cheat rule: a stale record is stored truthfully but must not repair a broken
      // streak.
      const startedAt = new Date(NOW.getTime() - 3 * DAY);

      await service.recordSession(
        'user-1',
        'UTC',
        dto({
          startedAt: startedAt.toISOString(),
          endedAt: new Date(startedAt.getTime() + 25 * MINUTE).toISOString(),
        }),
      );

      expect(persisted[0]?.attributionDate).toBe('2026-01-15');
    });

    it('resolves the day in the user’s zone, not the server’s', async () => {
      /*
       * The timezone comes from the verified token, so the streak is computed against the user's
       * own calendar without a second query for it. 21:00 UTC is already tomorrow in Karachi.
       */
      const startedAt = new Date('2026-01-15T21:00:00.000Z');
      const clock: Clock = { now: () => new Date('2026-01-15T21:30:00.000Z') };
      service = new SessionService(sessions, tasks, clock);

      await service.recordSession(
        'user-1',
        'Asia/Karachi',
        dto({
          startedAt: startedAt.toISOString(),
          endedAt: new Date(startedAt.getTime() + 25 * MINUTE).toISOString(),
        }),
      );

      expect(persisted[0]?.attributionDate).toBe('2026-01-16');
    });

    it('rejects a record from the future, naming the field', async () => {
      const startedAt = new Date(NOW.getTime() + 10 * MINUTE);

      const error = (await service
        .recordSession(
          'user-1',
          'UTC',
          dto({
            startedAt: startedAt.toISOString(),
            endedAt: new Date(startedAt.getTime() + 25 * MINUTE).toISOString(),
          }),
        )
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(422);
      expect(fieldErrorOf(error)?.field).toBe('endedAt');
      expect(fieldErrorOf(error)?.message).toMatch(/device clock/i);
    });

    it('rejects a record older than the backdate window', async () => {
      const startedAt = new Date(NOW.getTime() - 8 * DAY);

      const error = (await service
        .recordSession(
          'user-1',
          'UTC',
          dto({
            startedAt: startedAt.toISOString(),
            endedAt: new Date(startedAt.getTime() + 25 * MINUTE).toISOString(),
          }),
        )
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(422);
      expect(fieldErrorOf(error)?.field).toBe('startedAt');
    });

    it('rejects more focused time than actually elapsed', async () => {
      const startedAt = new Date(NOW.getTime() - 30 * MINUTE);

      const error = (await service
        .recordSession(
          'user-1',
          'UTC',
          dto({
            startedAt: startedAt.toISOString(),
            endedAt: new Date(startedAt.getTime() + 10 * MINUTE).toISOString(),
            actualDurationMs: 20 * MINUTE,
          }),
        )
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(422);
      expect(fieldErrorOf(error)?.field).toBe('actualDurationMs');
    });

    it('never persists a record it rejected', async () => {
      const startedAt = new Date(NOW.getTime() + 10 * MINUTE);

      await service
        .recordSession(
          'user-1',
          'UTC',
          dto({
            startedAt: startedAt.toISOString(),
            endedAt: new Date(startedAt.getTime() + 25 * MINUTE).toISOString(),
          }),
        )
        .catch(() => undefined);

      expect(sessions.record).not.toHaveBeenCalled();
    });
  });

  describe('recordSession — the termination reason', () => {
    it('requires a reason on a terminated focus block', async () => {
      // Terminating costs no points, so this is the entire thing the product gets in exchange.
      const error = (await service
        .recordSession('user-1', 'UTC', dto({ status: 'terminated', terminationReason: null }))
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(422);
      expect(fieldErrorOf(error)).toEqual({
        field: 'terminationReason',
        message: 'Tell us why the block ended early.',
      });
    });

    it('accepts a terminated focus block that carries one', async () => {
      await expect(
        service.recordSession(
          'user-1',
          'UTC',
          dto({ status: 'terminated', terminationReason: 'interrupted' }),
        ),
      ).resolves.toBeDefined();

      expect(persisted[0]?.terminationReason).toBe('interrupted');
    });

    it('refuses a reason on a completed block', async () => {
      const error = (await service
        .recordSession('user-1', 'UTC', dto({ terminationReason: 'interrupted' }))
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(422);
      expect(fieldErrorOf(error)?.message).toMatch(/Only a terminated focus session/i);
    });

    it('refuses a reason on a break', async () => {
      // A break is skipped, not abandoned. There is nothing to explain about declining a rest.
      const error = (await service
        .recordSession(
          'user-1',
          'UTC',
          dto({ type: 'break', status: 'terminated', terminationReason: 'interrupted' }),
        )
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(422);
    });

    it('accepts a terminated break with no reason', async () => {
      await expect(
        service.recordSession(
          'user-1',
          'UTC',
          dto({ type: 'break', status: 'terminated', terminationReason: null }),
        ),
      ).resolves.toBeDefined();
    });

    it('checks the reason before it checks the clock', async () => {
      /*
       * Ordering worth pinning: the reason is something the user can supply on the spot, whereas a
       * stale record cannot be fixed at all. Reporting the fixable one first is the more useful
       * answer when a record breaks both rules.
       */
      const startedAt = new Date(NOW.getTime() - 8 * DAY);

      const error = (await service
        .recordSession(
          'user-1',
          'UTC',
          dto({
            status: 'terminated',
            terminationReason: null,
            startedAt: startedAt.toISOString(),
            endedAt: new Date(startedAt.getTime() + 25 * MINUTE).toISOString(),
          }),
        )
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(fieldErrorOf(error)?.field).toBe('terminationReason');
    });
  });

  describe('recordSession — the outcomes the repository can report', () => {
    it('reports a replay as success, with nothing gained', async () => {
      /*
       * THE OUTBOX CONTRACT. A retried flush is success. Answering with an error would make a
       * client treat its own retry as a failure and, worse, teach it to stop retrying.
       */
      outcome = () => ({ kind: 'replayed', session: makeRecord(), state: startingState });

      const result = await service.recordSession('user-1', 'UTC', dto());

      expect(result.replayed).toBe(true);
      expect(result.session.clientSessionId).toBe(CLIENT_SESSION_ID);
      // Zero delta and no announcement: a retry must not re-report points the user already saw or
      // re-fire a title celebration.
      expect(result.gamification.pointsDelta).toBe(0);
      expect(result.gamification.newlyUnlocked).toEqual([]);
    });

    it('reports an overlap as a validation failure on startedAt, not a conflict', async () => {
      /*
       * Rule 6 of the ordered list, and like every other rule in it a 422 naming the field. The
       * distinction from 409 is deliberate: this is the validated path rejecting an implausible
       * record, whereas a conflict is the unique constraint catching a race that slipped past it.
       */
      outcome = () => ({ kind: 'overlap' });

      const error = (await service
        .recordSession('user-1', 'UTC', dto())
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(422);
      expect(fieldErrorOf(error)?.field).toBe('startedAt');
      expect(fieldErrorOf(error)?.message).toMatch(/overlaps/i);
    });

    it('reports a genuine race as a conflict', async () => {
      // Two devices both insisting they ran a block at the same instant — a different record, not
      // a retry of this one.
      outcome = () => ({ kind: 'conflict' });

      const error = (await service
        .recordSession('user-1', 'UTC', dto())
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(409);
      expect(error.problem.title).toBe('Session conflict');
    });
  });

  describe('listSessions', () => {
    it('constrains the read to the id it was given', async () => {
      await service.listSessions('user-1', { limit: 50 });

      expect(listOptions[0]?.userId).toBe('user-1');
    });

    it('defaults to the window History can actually render', async () => {
      /*
       * 180 days, because that is exactly what the client's widest chart covers. Serving more would
       * ship data nothing displays; serving less would leave a chart with holes.
       */
      await service.listSessions('user-1', { limit: 50 });

      const expected = new Date(NOW.getTime() - 180 * DAY);
      expect(listOptions[0]?.options.from.getTime()).toBe(expected.getTime());
      expect(listOptions[0]?.options.to).toBeUndefined();
    });

    it('honours an explicit range', async () => {
      await service.listSessions('user-1', {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T00:00:00.000Z',
        limit: 50,
      });

      expect(listOptions[0]?.options.from).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      expect(listOptions[0]?.options.to).toEqual(new Date('2026-01-31T00:00:00.000Z'));
    });

    it('rejects a range that ends before it starts', async () => {
      // Otherwise it silently returns nothing, which is indistinguishable from "you have no
      // history" — the exact confusion the History empty state exists to avoid.
      const error = (await service
        .listSessions('user-1', {
          from: '2026-01-31T00:00:00.000Z',
          to: '2026-01-01T00:00:00.000Z',
          limit: 50,
        })
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(422);
      expect(fieldErrorOf(error)?.field).toBe('to');
    });

    it('maps rows to the canonical session shape', async () => {
      const result = await service.listSessions('user-1', { limit: 50 });

      expect(result.sessions[0]).toMatchObject({
        clientSessionId: CLIENT_SESSION_ID,
        taskTitle: 'Thesis chapter 3',
        startedAt: '2026-01-15T08:30:00.000Z',
      });
      expect(result.sessions[0]).not.toHaveProperty('attributionDate');
    });

    it('passes the page cursor through in both directions', async () => {
      nextCursor = 'next-page';

      const result = await service.listSessions('user-1', { cursor: 'this-page', limit: 25 });

      expect(listOptions[0]?.options).toMatchObject({ cursor: 'this-page', limit: 25 });
      expect(result.nextCursor).toBe('next-page');
    });

    it('answers with an empty log rather than failing on a new account', async () => {
      listed = [];

      await expect(service.listSessions('user-1', { limit: 50 })).resolves.toEqual({
        sessions: [],
        nextCursor: null,
      });
    });
  });
});
