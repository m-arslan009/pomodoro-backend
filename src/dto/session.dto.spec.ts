import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { MAX_INTERVAL_MS, TERMINATION_REASONS } from '../domain/session';
import { TASK_TITLE_MAX_LENGTH } from '../domain/task';
import { listSessionsQuerySchema, recordSessionSchema } from './session.dto';

/*
 * The session request contracts (CONTRACT.md §16.5, §16.6).
 *
 * SHAPE ONLY, deliberately. Whether the times are plausible relative to each other and to now is
 * domain/session.ts's job, because those rules are ordered and need a clock — keeping them out of
 * here is what lets the ordered rule list stay one readable function instead of a scatter of
 * refinements. So these tests assert the boundary is closed and typed, and leave plausibility to
 * session.spec.ts.
 *
 * The field set being CLOSED is the substantive property. `pointsAwarded` is the one to watch: it is
 * the server's to decide, and a schema that accepted it would be a schema that let a client name
 * its own score.
 */

function errorsOf(schema: ZodType, value: unknown): Record<string, string> {
  const result = schema.safeParse(value);
  if (result.success) return {};

  const messages: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.map(String).join('.') || 'body';
    messages[field] ??= issue.message;
  }
  return messages;
}

function parsed<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`expected a valid value, got: ${JSON.stringify(errorsOf(schema, value))}`);
  }
  return result.data;
}

const CLIENT_SESSION_ID = '018f0000-0000-7000-8000-00000000cccc';
const TASK_ID = '018f0000-0000-7000-8000-00000000bbbb';

/** A record with one required key removed, for asserting that the key is in fact required. */
function withoutKey(key: string): Record<string, unknown> {
  const value = record();
  delete value[key];
  return value;
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientSessionId: CLIENT_SESSION_ID,
    taskId: TASK_ID,
    taskTitle: 'Thesis chapter 3',
    type: 'focus',
    status: 'completed',
    startedAt: '2026-01-15T08:35:00.000Z',
    endedAt: '2026-01-15T09:00:00.000Z',
    plannedDurationMs: 1_500_000,
    actualDurationMs: 1_500_000,
    terminationReason: null,
    ...overrides,
  };
}

describe('recordSessionSchema', () => {
  it('accepts a completed focus block', () => {
    expect(recordSessionSchema.safeParse(record()).success).toBe(true);
  });

  it('accepts a terminated focus block with a reason', () => {
    expect(
      recordSessionSchema.safeParse(
        record({ status: 'terminated', terminationReason: 'interrupted' }),
      ).success,
    ).toBe(true);
  });

  it('accepts a break', () => {
    expect(recordSessionSchema.safeParse(record({ type: 'break' })).success).toBe(true);
  });

  describe('the idempotency key', () => {
    it('requires a UUID', () => {
      /*
       * The client's primary key, minted when the block started, and the thing that makes a retried
       * outbox flush resolve to the original record rather than a duplicate. A client-chosen
       * arbitrary string would collide across devices.
       */
      expect(recordSessionSchema.safeParse(record({ clientSessionId: 'block-1' })).success).toBe(
        false,
      );
      expect(recordSessionSchema.safeParse(record({ clientSessionId: '' })).success).toBe(false);
    });

    it('is required', () => {
      expect(recordSessionSchema.safeParse(withoutKey('clientSessionId')).success).toBe(false);
    });
  });

  describe('the task link', () => {
    it('accepts a null task id', () => {
      // A session can outlive its task, and one recorded after the task was deleted still happened.
      expect(recordSessionSchema.safeParse(record({ taskId: null })).success).toBe(true);
    });

    it('still requires the key to be present', () => {
      // Nullable, not optional: the client always knows whether there was a task, so an absent key
      // is a client bug rather than a legitimate "unknown".
      expect(recordSessionSchema.safeParse(withoutKey('taskId')).success).toBe(false);
    });

    it('rejects a task id that is not a UUID', () => {
      expect(recordSessionSchema.safeParse(record({ taskId: 'local-1739' })).success).toBe(false);
    });
  });

  describe('the title snapshot', () => {
    it('is required even when a task is linked', () => {
      /*
       * The server does not derive it from the task row. Once a task can be renamed or deleted,
       * deriving it would either fail outright or stamp work with a name it was never done under.
       */
      expect(recordSessionSchema.safeParse(withoutKey('taskTitle')).success).toBe(false);
      expect(recordSessionSchema.safeParse(record({ taskTitle: '' })).success).toBe(false);
      expect(recordSessionSchema.safeParse(record({ taskTitle: '   ' })).success).toBe(false);
    });

    it('is trimmed and length-bounded like a task title', () => {
      // It is stored verbatim in a NOT NULL column that mirrors the task's own limit.
      expect(parsed(recordSessionSchema, record({ taskTitle: '  Deep work  ' })).taskTitle).toBe(
        'Deep work',
      );
      expect(
        recordSessionSchema.safeParse(record({ taskTitle: 'x'.repeat(TASK_TITLE_MAX_LENGTH + 1) }))
          .success,
      ).toBe(false);
    });
  });

  describe('enumerations', () => {
    it('accepts only the two session types', () => {
      expect(recordSessionSchema.safeParse(record({ type: 'focus' })).success).toBe(true);
      expect(recordSessionSchema.safeParse(record({ type: 'break' })).success).toBe(true);
      expect(recordSessionSchema.safeParse(record({ type: 'work' })).success).toBe(false);
    });

    it('accepts only the two terminal statuses', () => {
      // There is no 'running' status: the server has no concept of a block in progress, and a
      // record exists only once the interval is over.
      expect(recordSessionSchema.safeParse(record({ status: 'completed' })).success).toBe(true);
      expect(
        recordSessionSchema.safeParse(
          record({ status: 'terminated', terminationReason: 'interrupted' }),
        ).success,
      ).toBe(true);
      expect(recordSessionSchema.safeParse(record({ status: 'running' })).success).toBe(false);
      expect(recordSessionSchema.safeParse(record({ status: 'paused' })).success).toBe(false);
    });

    it('accepts every documented termination reason and nothing else', () => {
      // Fixed set, not free text: one tap answers it, whereas a text box would not be answered at
      // all — and the outcome breakdown needs values it can group.
      for (const reason of TERMINATION_REASONS) {
        expect(
          recordSessionSchema.safeParse(record({ status: 'terminated', terminationReason: reason }))
            .success,
        ).toBe(true);
      }
      expect(
        recordSessionSchema.safeParse(record({ status: 'terminated', terminationReason: 'bored' }))
          .success,
      ).toBe(false);
    });

    it('requires the reason key even when there is no reason', () => {
      // Its consistency with type and status is checked in the service, which needs the value to
      // be present in order to have an opinion about it.
      expect(recordSessionSchema.safeParse(withoutKey('terminationReason')).success).toBe(false);
    });
  });

  describe('timestamps', () => {
    it('requires ISO-8601 with an offset', () => {
      expect(recordSessionSchema.safeParse(record({ startedAt: '2026-01-15' })).success).toBe(
        false,
      );
      expect(recordSessionSchema.safeParse(record({ startedAt: '15/01/2026 08:35' })).success).toBe(
        false,
      );
      expect(recordSessionSchema.safeParse(record({ startedAt: 1_768_000_000_000 })).success).toBe(
        false,
      );
    });

    it('accepts a non-UTC offset', () => {
      // The client sends its own zone. Rejecting +05:00 would make the record unrepresentable for
      // most of the world.
      expect(
        recordSessionSchema.safeParse(
          record({ startedAt: '2026-01-15T13:35:00+05:00', endedAt: '2026-01-15T14:00:00+05:00' }),
        ).success,
      ).toBe(true);
    });
  });

  describe('durations', () => {
    it('requires whole milliseconds', () => {
      expect(recordSessionSchema.safeParse(record({ actualDurationMs: 1500.5 })).success).toBe(
        false,
      );
    });

    it('rejects a negative duration', () => {
      expect(recordSessionSchema.safeParse(record({ actualDurationMs: -1 })).success).toBe(false);
    });

    it('rejects a block that was never given a length', () => {
      // A zero-length plan would score the same 100 points as a real block.
      expect(recordSessionSchema.safeParse(record({ plannedDurationMs: 0 })).success).toBe(false);
    });

    it('allows a zero actual, because a block can be stopped immediately', () => {
      expect(
        recordSessionSchema.safeParse(
          record({ status: 'terminated', terminationReason: 'wrong_task', actualDurationMs: 0 }),
        ).success,
      ).toBe(true);
    });

    it('caps both durations at the four-hour ceiling', () => {
      expect(
        recordSessionSchema.safeParse(record({ actualDurationMs: MAX_INTERVAL_MS })).success,
      ).toBe(true);
      expect(
        recordSessionSchema.safeParse(record({ actualDurationMs: MAX_INTERVAL_MS + 1 })).success,
      ).toBe(false);
      expect(
        recordSessionSchema.safeParse(record({ plannedDurationMs: MAX_INTERVAL_MS + 1 })).success,
      ).toBe(false);
    });
  });

  describe('the closed field set', () => {
    it('refuses a client-supplied score', () => {
      /*
       * THE ONE THAT MATTERS MOST. The server owns the economy outright, so a schema that accepted
       * this would be a schema that let a client award itself points it never earned.
       */
      expect(recordSessionSchema.safeParse(record({ pointsAwarded: 10_000 })).success).toBe(false);
    });

    it('refuses a client-supplied attribution day', () => {
      // Decided by the server from the user's zone. Accepting it would let a client aim a record at
      // whichever day repaired its streak.
      expect(recordSessionSchema.safeParse(record({ attributionDate: '2026-01-14' })).success).toBe(
        false,
      );
    });

    it('refuses a server id or an owner', () => {
      expect(recordSessionSchema.safeParse(record({ id: 'server-1' })).success).toBe(false);
      expect(recordSessionSchema.safeParse(record({ userId: 'someone-else' })).success).toBe(false);
    });

    it('refuses the client’s own sync bookkeeping', () => {
      // `syncState` is the client's field and the server has no opinion on it; it must be stripped
      // before sending rather than tolerated on arrival.
      expect(recordSessionSchema.safeParse(record({ syncState: 'pending' })).success).toBe(false);
    });
  });
});

describe('listSessionsQuerySchema', () => {
  it('accepts an empty query and defaults the page size', () => {
    // `from` is left unset here and defaulted in the service to the 180-day window, because the
    // default needs a clock.
    expect(parsed(listSessionsQuerySchema, {})).toEqual({ limit: 50 });
  });

  it('accepts a bounded range', () => {
    expect(
      listSessionsQuerySchema.safeParse({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T23:59:59.999Z',
      }).success,
    ).toBe(true);
  });

  it('requires ISO timestamps for both bounds', () => {
    expect(listSessionsQuerySchema.safeParse({ from: '2026-01-01' }).success).toBe(false);
    expect(listSessionsQuerySchema.safeParse({ to: 'now' }).success).toBe(false);
  });

  it('coerces and bounds the page size', () => {
    expect(parsed(listSessionsQuerySchema, { limit: '25' }).limit).toBe(25);
    expect(listSessionsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listSessionsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('rejects an empty cursor', () => {
    expect(listSessionsQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });

  it('refuses unknown query parameters', () => {
    expect(listSessionsQuerySchema.safeParse({ userId: 'someone-else' }).success).toBe(false);
    expect(listSessionsQuerySchema.safeParse({ status: 'completed' }).success).toBe(false);
  });
});
