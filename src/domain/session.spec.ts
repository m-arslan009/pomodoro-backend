import { describe, expect, it } from 'vitest';
import {
  BACKDATE_WINDOW_MS,
  FUTURE_SKEW_TOLERANCE_MS,
  MAX_INTERVAL_MS,
  TIMING_VIOLATION_FIELDS,
  TIMING_VIOLATION_MESSAGES,
  checkTiming,
  clampDuration,
  reasonIsConsistent,
  type SessionTiming,
} from './session';

/*
 * The time authority (ADR-012, CONTRACT.md §15.1).
 *
 * The client reports when a block ran and how much of it was focused; this module decides whether
 * that is plausible and bounds it before anything is computed from it. Points come out of these
 * numbers, and points unlock features — so every rule here is load-bearing against a client that
 * simply posts whatever it likes. None of these tests need a server, a clock, or a database, which
 * is the whole reason the rules live in src/domain.
 *
 * ORDER IS PART OF THE CONTRACT, not an implementation detail, so it is asserted directly: a record
 * that breaks several rules at once must report the one the client can act on.
 */

const NOW = new Date('2026-01-15T09:00:00.000Z');
const MINUTE = 60 * 1000;

/** A perfectly ordinary completed 25-minute block, half an hour ago. */
function timing(overrides: Partial<SessionTiming> = {}): SessionTiming {
  const startedAt = new Date(NOW.getTime() - 30 * MINUTE);
  return {
    startedAt,
    endedAt: new Date(startedAt.getTime() + 25 * MINUTE),
    plannedDurationMs: 25 * MINUTE,
    actualDurationMs: 25 * MINUTE,
    ...overrides,
  };
}

describe('checkTiming', () => {
  it('accepts an ordinary block', () => {
    expect(checkTiming(timing(), NOW)).toBeNull();
  });

  describe('rule 1 — a session cannot end in the future', () => {
    it('tolerates a clock that runs slightly fast', () => {
      /*
       * A device whose clock is thirty seconds ahead is normal and unremarkable, and rejecting its
       * records would lose real work over something the user cannot see, let alone fix.
       */
      const endedAt = new Date(NOW.getTime() + FUTURE_SKEW_TOLERANCE_MS - 1000);
      const startedAt = new Date(endedAt.getTime() - 25 * MINUTE);

      expect(checkTiming(timing({ startedAt, endedAt }), NOW)).toBeNull();
    });

    it('rejects a record from beyond the tolerance', () => {
      const endedAt = new Date(NOW.getTime() + FUTURE_SKEW_TOLERANCE_MS + 1000);
      const startedAt = new Date(endedAt.getTime() - 25 * MINUTE);

      expect(checkTiming(timing({ startedAt, endedAt }), NOW)).toBe('ended_in_future');
    });

    it('is inclusive at the tolerance boundary', () => {
      const endedAt = new Date(NOW.getTime() + FUTURE_SKEW_TOLERANCE_MS);
      const startedAt = new Date(endedAt.getTime() - 25 * MINUTE);

      expect(checkTiming(timing({ startedAt, endedAt }), NOW)).toBeNull();
    });
  });

  describe('rule 2 — a session cannot be older than the backdate window', () => {
    it('accepts a record from just inside the window', () => {
      const startedAt = new Date(NOW.getTime() - BACKDATE_WINDOW_MS + MINUTE);

      expect(
        checkTiming(
          timing({ startedAt, endedAt: new Date(startedAt.getTime() + 25 * MINUTE) }),
          NOW,
        ),
      ).toBeNull();
    });

    it('rejects a record from beyond it', () => {
      // The window is what bounds the outbox and the overlap search alike. Without it, a client
      // could post a session dated to any point in history and reshape a whole year of statistics.
      const startedAt = new Date(NOW.getTime() - BACKDATE_WINDOW_MS - MINUTE);

      expect(
        checkTiming(
          timing({ startedAt, endedAt: new Date(startedAt.getTime() + 25 * MINUTE) }),
          NOW,
        ),
      ).toBe('started_too_long_ago');
    });
  });

  describe('rule 3 — a session must end after it starts', () => {
    it('rejects an inverted interval', () => {
      const startedAt = new Date(NOW.getTime() - 10 * MINUTE);

      expect(
        checkTiming(
          timing({
            startedAt,
            endedAt: new Date(startedAt.getTime() - MINUTE),
            actualDurationMs: 0,
          }),
          NOW,
        ),
      ).toBe('ended_before_started');
    });

    it('rejects a zero-length interval', () => {
      // Not merely degenerate: a zero-length block scores the same 100 points as a real one, so
      // accepting it would be an unlimited points faucet.
      const startedAt = new Date(NOW.getTime() - 10 * MINUTE);

      expect(checkTiming(timing({ startedAt, endedAt: startedAt, actualDurationMs: 0 }), NOW)).toBe(
        'ended_before_started',
      );
    });
  });

  describe('rule 4 — focused time cannot exceed the planned length', () => {
    it('rejects more focus than the block was set to', () => {
      expect(
        checkTiming(timing({ plannedDurationMs: 25 * MINUTE, actualDurationMs: 26 * MINUTE }), NOW),
      ).toBe('actual_exceeds_planned');
    });

    it('accepts exactly the planned length', () => {
      expect(
        checkTiming(timing({ plannedDurationMs: 25 * MINUTE, actualDurationMs: 25 * MINUTE }), NOW),
      ).toBeNull();
    });
  });

  describe('rule 5 — no interval is plausibly longer than four hours', () => {
    it('rejects a block beyond the maximum even when its plan agrees', () => {
      /*
       * Reachable only past the DTO's own ceiling on `plannedDurationMs`, which is the point: the
       * bound has to hold at the place the number is used, not by the grace of a check upstream
       * that a future caller might bypass.
       */
      const startedAt = new Date(NOW.getTime() - 5 * 60 * MINUTE);

      expect(
        checkTiming(
          timing({
            startedAt,
            endedAt: new Date(startedAt.getTime() + 5 * 60 * MINUTE),
            plannedDurationMs: 5 * 60 * MINUTE,
            actualDurationMs: MAX_INTERVAL_MS + 1,
          }),
          NOW,
        ),
      ).toBe('actual_exceeds_maximum');
    });
  });

  describe('rule 6 — focused time cannot exceed the time that actually passed', () => {
    it('closes "I paused for an hour and focused for two"', () => {
      /*
       * The one rule that cannot be derived from the others. Pause is why the client reports a
       * duration at all — a block paused for an hour has a 25-minute actual and an 85-minute span —
       * and this is the bound that stops that latitude becoming a licence.
       */
      const startedAt = new Date(NOW.getTime() - 30 * MINUTE);

      expect(
        checkTiming(
          timing({
            startedAt,
            endedAt: new Date(startedAt.getTime() + 10 * MINUTE),
            plannedDurationMs: 25 * MINUTE,
            actualDurationMs: 20 * MINUTE,
          }),
          NOW,
        ),
      ).toBe('actual_exceeds_elapsed');
    });

    it('allows focused time equal to the elapsed span', () => {
      const startedAt = new Date(NOW.getTime() - 30 * MINUTE);

      expect(
        checkTiming(
          timing({
            startedAt,
            endedAt: new Date(startedAt.getTime() + 25 * MINUTE),
            actualDurationMs: 25 * MINUTE,
          }),
          NOW,
        ),
      ).toBeNull();
    });

    it('allows a paused block whose span far exceeds its focused time', () => {
      // The normal case for anyone who takes a phone call mid-block.
      const startedAt = new Date(NOW.getTime() - 90 * MINUTE);

      expect(
        checkTiming(
          timing({
            startedAt,
            endedAt: new Date(startedAt.getTime() + 85 * MINUTE),
            plannedDurationMs: 25 * MINUTE,
            actualDurationMs: 25 * MINUTE,
          }),
          NOW,
        ),
      ).toBeNull();
    });
  });

  describe('rule ordering', () => {
    it('reports staleness ahead of an internal inconsistency', () => {
      /*
       * THE REASON ORDER IS SPECIFIED. A stale record cannot be fixed by retrying — the client must
       * discard it. Reporting the inconsistency instead would send the client off to correct a
       * duration and resubmit a record the server will never accept.
       */
      const startedAt = new Date(NOW.getTime() - BACKDATE_WINDOW_MS - MINUTE);

      expect(
        checkTiming(
          timing({
            startedAt,
            endedAt: new Date(startedAt.getTime() + MINUTE),
            plannedDurationMs: 25 * MINUTE,
            actualDurationMs: 25 * MINUTE,
          }),
          NOW,
        ),
      ).toBe('started_too_long_ago');
    });

    it('reports a future end ahead of everything else', () => {
      // A clock skewed far forward makes every later rule report nonsense, so it is diagnosed first
      // and the message names the actual cause: the device clock.
      const startedAt = new Date(NOW.getTime() + 10 * 60 * MINUTE);

      expect(
        checkTiming(
          timing({
            startedAt,
            endedAt: new Date(startedAt.getTime() - MINUTE),
            actualDurationMs: 99 * MINUTE,
          }),
          NOW,
        ),
      ).toBe('ended_in_future');
    });
  });

  describe('violation reporting', () => {
    it('places every violation on a field the client actually sent', () => {
      // The frontend drops these against inputs, so a field name that is not in the payload would
      // silently orphan the message.
      const payloadFields = new Set([
        'startedAt',
        'endedAt',
        'plannedDurationMs',
        'actualDurationMs',
      ]);

      for (const field of Object.values(TIMING_VIOLATION_FIELDS)) {
        expect(payloadFields.has(field)).toBe(true);
      }
    });

    it('carries a message for every violation it can report', () => {
      const violations = Object.keys(TIMING_VIOLATION_FIELDS);

      expect(Object.keys(TIMING_VIOLATION_MESSAGES).sort()).toEqual(violations.sort());
      for (const message of Object.values(TIMING_VIOLATION_MESSAGES)) {
        expect(message.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('clampDuration', () => {
  it('leaves a plausible duration alone', () => {
    expect(clampDuration(25 * MINUTE, 25 * MINUTE)).toBe(25 * MINUTE);
  });

  it('bounds a duration to the planned length', () => {
    /*
     * Validation already rejects this, so in the normal path the clamp is a no-op. It exists so
     * that "clamped before anything is computed from it" is true AT the point of computation,
     * rather than true by the grace of a check somewhere upstream.
     */
    expect(clampDuration(99 * MINUTE, 25 * MINUTE)).toBe(25 * MINUTE);
  });

  it('floors a fractional millisecond', () => {
    expect(clampDuration(1500.9, 25 * MINUTE)).toBe(1500);
  });

  it('treats a negative duration as zero', () => {
    expect(clampDuration(-1, 25 * MINUTE)).toBe(0);
  });

  it('treats a non-finite duration as zero rather than propagating it', () => {
    /*
     * Zero, NOT the planned duration — including for Infinity. A non-finite value is not a long
     * session, it is a broken client, and crediting it with a full block would reward the breakage.
     * NaN is the one that would do real damage if it slipped through: it sails past Math.min, gets
     * stored, and every aggregate built on that column reads NaN from then on.
     */
    expect(clampDuration(Number.NaN, 25 * MINUTE)).toBe(0);
    expect(clampDuration(Number.POSITIVE_INFINITY, 25 * MINUTE)).toBe(0);
    expect(clampDuration(Number.NEGATIVE_INFINITY, 25 * MINUTE)).toBe(0);
  });
});

describe('reasonIsConsistent', () => {
  it('requires a reason on a terminated focus block', () => {
    // Terminating costs no points, so the reason is the entire thing the product gets in exchange.
    expect(reasonIsConsistent('focus', 'terminated', 'interrupted')).toBe(true);
    expect(reasonIsConsistent('focus', 'terminated', null)).toBe(false);
  });

  it('forbids a reason on a completed focus block', () => {
    expect(reasonIsConsistent('focus', 'completed', null)).toBe(true);
    expect(reasonIsConsistent('focus', 'completed', 'interrupted')).toBe(false);
  });

  it('forbids a reason on a break, however it ended', () => {
    // A break is skipped, not abandoned. Asking why someone declined a rest has no honest answer,
    // and offering the focus reasons there would collect noise into the outcome breakdown.
    expect(reasonIsConsistent('break', 'terminated', null)).toBe(true);
    expect(reasonIsConsistent('break', 'terminated', 'interrupted')).toBe(false);
    expect(reasonIsConsistent('break', 'completed', null)).toBe(true);
    expect(reasonIsConsistent('break', 'completed', 'out_of_energy')).toBe(false);
  });
});
