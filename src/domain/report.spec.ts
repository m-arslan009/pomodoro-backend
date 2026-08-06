import { describe, expect, it } from 'vitest';
import {
  DELIVERY_HOUR,
  addDays,
  dayOfMonth,
  generateToken,
  hashToken,
  isDueAt,
  localDate,
  localHour,
  previousPeriod,
  resolveActivation,
  tokenMatches,
  weekdayOf,
} from './report';

/*
 * Report periods and the token primitives (CONTRACT.md §24.2, §23.3).
 *
 * THE TIMEZONE IS THE WHOLE SUBJECT. `report_subscriptions` deliberately stores no zone (§23.0
 * consequence 1), so every period and every delivery time is resolved against `users.timezone`,
 * passed in as an argument. These tests exist to prove that the argument is actually used — a
 * formatter built without an explicit `timeZone` silently falls back to the host's, which on this
 * deployment is UTC, and the resulting bug is invisible in any test run in UTC and wrong for every
 * user who is not.
 *
 * So the fixtures are chosen to be *unambiguous*: an instant that is one date in Auckland and the
 * previous date in Los Angeles cannot pass by accident.
 *
 * None of this needs a clock, a database or a server, which is the reason the rules live in
 * src/domain at all.
 */

describe('localDate', () => {
  /*
   * 21:30 UTC on 6 August. In Auckland it is already the 7th; in Los Angeles it is still the
   * afternoon of the 6th. One instant, three answers — and a function ignoring its `timeZone`
   * argument would give the same one three times.
   */
  const instant = new Date('2026-08-06T21:30:00.000Z');

  it.each([
    ['UTC', '2026-08-06'],
    ['Pacific/Auckland', '2026-08-07'],
    ['America/Los_Angeles', '2026-08-06'],
    ['Asia/Kolkata', '2026-08-07'],
  ])('resolves %s to %s', (timeZone, expected) => {
    expect(localDate(instant, timeZone)).toBe(expected);
  });

  it('puts an instant just before local midnight on the day that is ending', () => {
    // 11:59pm in Auckland, which is 11:59 UTC — a different date in each zone.
    const almostMidnight = new Date('2026-08-06T11:59:00.000Z');
    expect(localDate(almostMidnight, 'Pacific/Auckland')).toBe('2026-08-06');
    expect(localDate(almostMidnight, 'UTC')).toBe('2026-08-06');
    expect(localDate(new Date('2026-08-06T12:01:00.000Z'), 'Pacific/Auckland')).toBe('2026-08-07');
  });
});

describe('localHour', () => {
  it('reports the hour in the account zone, not the host zone', () => {
    // 20:00 UTC is 08:00 the next morning in Auckland — the delivery hour, in one zone only.
    const instant = new Date('2026-08-05T20:00:00.000Z');
    expect(localHour(instant, 'Pacific/Auckland')).toBe(8);
    expect(localHour(instant, 'UTC')).toBe(20);
  });

  it('reports midnight as 0, never 24', () => {
    // Some ICU builds render midnight as "24" under hour12: false. Either is normalised.
    expect(localHour(new Date('2026-08-06T00:00:00.000Z'), 'UTC')).toBe(0);
  });
});

describe('weekdayOf', () => {
  it.each([
    ['2026-08-03', 1, 'Monday'],
    ['2026-08-06', 4, 'Thursday'],
    ['2026-08-09', 7, 'Sunday'],
  ])('%s is ISO weekday %i (%s)', (date, expected) => {
    expect(weekdayOf(date)).toBe(expected);
  });
});

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
  });

  it('crosses a year boundary backwards', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });
});

describe('previousPeriod — weekly', () => {
  /*
   * The period is the Monday–Sunday week that has ENDED, never the one in progress (T3, P8). A
   * report sent on Monday morning covers the seven days before that Monday.
   */
  it('covers the week that ended, from any day of the current week', () => {
    // 2026-08-03 is a Monday; the week that just ended is 27 July – 2 August.
    for (const today of ['2026-08-03', '2026-08-05', '2026-08-09']) {
      expect(previousPeriod('weekly', today)).toEqual({
        kind: 'weekly',
        start: '2026-07-27',
        end: '2026-08-02',
      });
    }
  });

  it('is always exactly seven days', () => {
    const period = previousPeriod('weekly', '2026-03-30');
    expect(addDays(period.start, 6)).toBe(period.end);
    expect(weekdayOf(period.start)).toBe(1);
    expect(weekdayOf(period.end)).toBe(7);
  });

  it('crosses a year boundary', () => {
    // 2027-01-04 is a Monday, so the week that just ended runs from the Monday before it — which
    // puts the period's two ends in different years, and the label in `formatPeriodLabel` has to
    // name both.
    expect(previousPeriod('weekly', '2027-01-04')).toEqual({
      kind: 'weekly',
      start: '2026-12-28',
      end: '2027-01-03',
    });
  });

  /*
   * The DST case, and the reason periods are dates rather than instants. In Europe/London the clocks
   * go forward on 29 March 2026, so that local week is 167 hours rather than 168. Nothing here
   * counts hours, so the period is still seven calendar days — which is what a user means by "last
   * week".
   */
  it('is still seven calendar days across a DST transition', () => {
    const period = previousPeriod('weekly', '2026-04-01');
    expect(period).toEqual({ kind: 'weekly', start: '2026-03-23', end: '2026-03-29' });
    expect(addDays(period.start, 6)).toBe(period.end);
  });
});

describe('previousPeriod — monthly', () => {
  it('covers the calendar month that ended, never a rolling 30 days (T4)', () => {
    expect(previousPeriod('monthly', '2026-08-01')).toEqual({
      kind: 'monthly',
      start: '2026-07-01',
      end: '2026-07-31',
    });
  });

  it.each([
    ['2026-03-01', '2026-02-01', '2026-02-28', 'a 28-day February'],
    ['2028-03-01', '2028-02-01', '2028-02-29', 'a leap February'],
    ['2026-05-01', '2026-04-01', '2026-04-30', 'a 30-day month'],
    ['2026-01-01', '2025-12-01', '2025-12-31', 'December of the previous year'],
  ])('from %s covers %s to %s — %s', (today, start, end) => {
    expect(previousPeriod('monthly', today)).toEqual({ kind: 'monthly', start, end });
  });

  it('always starts on the first and ends on a month end', () => {
    const period = previousPeriod('monthly', '2026-07-01');
    expect(dayOfMonth(period.start)).toBe(1);
    expect(addDays(period.end, 1)).toBe('2026-07-01');
  });
});

describe('isDueAt', () => {
  /*
   * Due means the right local DAY and the delivery HOUR, both resolved in the account's own zone.
   * The worker ticks hourly, so this must answer true for exactly one tick per period per account.
   */

  it('is due at 08:00 local on the delivery day, in the account zone', () => {
    // 20:00 UTC Sunday = 08:00 Monday in Auckland.
    const instant = new Date('2026-08-02T20:00:00.000Z');
    expect(isDueAt('weekly', 1, instant, 'Pacific/Auckland')).toBe(true);
  });

  it('is not due at the same instant for an account in another zone', () => {
    /*
     * The same instant, and the whole point of the feature's timezone rule: it is Monday morning in
     * Auckland and Sunday lunchtime in London, so one account is due and the other is not.
     */
    const instant = new Date('2026-08-02T20:00:00.000Z');
    expect(isDueAt('weekly', 1, instant, 'Europe/London')).toBe(false);
    expect(localDate(instant, 'Europe/London')).toBe('2026-08-02');
  });

  it('is not due an hour either side of the delivery hour', () => {
    expect(isDueAt('weekly', 1, new Date('2026-08-03T07:00:00.000Z'), 'UTC')).toBe(false);
    expect(isDueAt('weekly', 1, new Date('2026-08-03T08:00:00.000Z'), 'UTC')).toBe(true);
    expect(isDueAt('weekly', 1, new Date('2026-08-03T09:00:00.000Z'), 'UTC')).toBe(false);
  });

  it('is not due on the wrong weekday', () => {
    // 2026-08-04 is a Tuesday.
    expect(isDueAt('weekly', 1, new Date('2026-08-04T08:00:00.000Z'), 'UTC')).toBe(false);
    expect(isDueAt('weekly', 2, new Date('2026-08-04T08:00:00.000Z'), 'UTC')).toBe(true);
  });

  it('sends a monthly report on the 1st and ignores the delivery day', () => {
    const first = new Date('2026-08-01T08:00:00.000Z');
    expect(isDueAt('monthly', 1, first, 'UTC')).toBe(true);
    // The stored delivery day is meaningless for a monthly subscription; it must not gate it.
    expect(isDueAt('monthly', 5, first, 'UTC')).toBe(true);
    expect(isDueAt('monthly', 1, new Date('2026-08-02T08:00:00.000Z'), 'UTC')).toBe(false);
  });

  it('fires exactly once across a full day of hourly ticks', () => {
    /*
     * The property that matters operationally. The ledger's unique constraint is the real guard
     * against a double send (A7), but a predicate that answered true twice would mean the second
     * tick did a period resolution and a database round trip for nothing, every week.
     */
    const dueHours = Array.from({ length: 24 }, (_, hour) => {
      const at = new Date(Date.UTC(2026, 7, 3, hour, 0, 0));
      return isDueAt('weekly', 1, at, 'UTC');
    }).filter(Boolean);

    expect(dueHours).toHaveLength(1);
    expect(DELIVERY_HOUR).toBe(8);
  });
});

describe('resolveActivation', () => {
  /*
   * L3 in one line: a verified address activates immediately, anything else has to prove it can
   * receive mail first. `emailVerifiedAt` is written only by a verified Google sign-in, so in
   * practice this is the provider/password split.
   */
  it('activates a verified address immediately', () => {
    expect(resolveActivation(true)).toBe('active');
  });

  it('holds an unverified address at pending confirmation', () => {
    expect(resolveActivation(false)).toBe('pending_confirmation');
  });
});

describe('tokens', () => {
  it('mints a different token every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(tokens.size).toBe(50);
  });

  it('is URL-safe, so it survives being pasted out of an email', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('stores a hash, never the token', () => {
    const token = generateToken();
    const stored = hashToken(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(token);
  });

  it('matches only the token it was derived from', () => {
    const token = generateToken();
    expect(tokenMatches(token, hashToken(token))).toBe(true);
    expect(tokenMatches(generateToken(), hashToken(token))).toBe(false);
  });

  it('rejects a malformed stored hash rather than throwing', () => {
    // timingSafeEqual throws on a length mismatch; a corrupt row must be a "no", not a 500.
    expect(tokenMatches(generateToken(), 'not-a-hash')).toBe(false);
  });
});
