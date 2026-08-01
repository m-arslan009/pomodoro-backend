import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, paginate } from './cursor';

/*
 * Keyset pagination.
 *
 * Cursors rather than OFFSET, because both lists paginated here are append-heavy and read
 * newest-first: with OFFSET, a record inserted mid-scroll shifts every later page, so the user
 * silently skips or re-sees rows. The id in the cursor is what stops two rows sharing a timestamp
 * from straddling a page boundary and losing one of themselves.
 *
 * The decoder's contract is the interesting half. A cursor arrives from the network and may be
 * anything at all, so every malformed input has to resolve to "start from the beginning" — a
 * hand-edited cursor that produced a 500 would be a trivially reachable denial of service.
 */

const TIMESTAMP = new Date('2026-01-15T09:00:00.000Z');
const ID = '018f0000-0000-7000-8000-000000000001';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a timestamp and an id', () => {
    const decoded = decodeCursor(encodeCursor(TIMESTAMP, ID));

    expect(decoded?.timestamp.toISOString()).toBe(TIMESTAMP.toISOString());
    expect(decoded?.id).toBe(ID);
  });

  it('preserves millisecond precision', () => {
    // Sessions can legitimately share a second; the tie-break is only exact if the timestamp is.
    const precise = new Date('2026-01-15T09:00:00.123Z');

    expect(decodeCursor(encodeCursor(precise, ID))?.timestamp.getTime()).toBe(precise.getTime());
  });

  it('produces a URL-safe token', () => {
    // It rides in a query string. Base64url rather than base64 so `+` and `/` never need escaping.
    const encoded = encodeCursor(TIMESTAMP, ID);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it('is opaque but not secret', () => {
    // Encoded to signal "do not construct one by hand", not to hide anything: both halves are
    // values the caller already has.
    const decoded = Buffer.from(encodeCursor(TIMESTAMP, ID), 'base64url').toString('utf8');

    expect(decoded).toBe(`${TIMESTAMP.toISOString()}|${ID}`);
  });

  it('tolerates an id containing the separator', () => {
    // The split is on the FIRST separator, so anything after it is the id verbatim.
    const awkward = 'a|b|c';

    expect(decodeCursor(encodeCursor(TIMESTAMP, awkward))?.id).toBe(awkward);
  });

  describe('rejecting anything unusable', () => {
    it('reads an absent cursor as the first page', () => {
      expect(decodeCursor(undefined)).toBeNull();
      expect(decodeCursor('')).toBeNull();
    });

    it('rejects a token with no separator', () => {
      expect(decodeCursor(Buffer.from('nonsense', 'utf8').toString('base64url'))).toBeNull();
    });

    it('rejects an unparseable timestamp', () => {
      expect(
        decodeCursor(Buffer.from(`not-a-date|${ID}`, 'utf8').toString('base64url')),
      ).toBeNull();
    });

    it('rejects an empty id', () => {
      // Without the id there is no tie-break, and the query would silently drop rows sharing a
      // timestamp with the last one on the page.
      const raw = Buffer.from(`${TIMESTAMP.toISOString()}|`, 'utf8').toString('base64url');

      expect(decodeCursor(raw)).toBeNull();
    });

    it('rejects arbitrary junk without throwing', () => {
      // The decoder is reached before authentication does anything useful with the query, so it
      // must never be the thing that turns a bad request into a 500.
      for (const junk of ['%%%', '!!!!', 'ïż½', '========', 'a'.repeat(10_000)]) {
        expect(() => decodeCursor(junk)).not.toThrow();
      }
    });
  });
});

describe('paginate', () => {
  const key = (row: { id: string; at: Date }) => ({ timestamp: row.at, id: row.id });

  function rows(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `id-${index}`,
      at: new Date(TIMESTAMP.getTime() - index * 1000),
    }));
  }

  it('returns everything and no cursor when the page is not full', () => {
    const result = paginate(rows(3), 10, key);

    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  it('returns no cursor when the rows exactly fill the page', () => {
    /*
     * The caller over-fetches by one, so "exactly `limit` rows came back" already proves there is
     * no next page. Emitting a cursor here would cost the client an extra request that returns
     * nothing — the classic off-by-one that shows up as a phantom empty page.
     */
    const result = paginate(rows(10), 10, key);

    expect(result.items).toHaveLength(10);
    expect(result.nextCursor).toBeNull();
  });

  it('trims the over-fetched row and emits a cursor', () => {
    const all = rows(11);
    const result = paginate(all, 10, key);

    expect(result.items).toHaveLength(10);
    // The extra row is never returned; it only answers "is there more?" without a second COUNT
    // over the same predicate.
    expect(result.items.at(-1)?.id).toBe('id-9');
    expect(result.nextCursor).not.toBeNull();
  });

  it('builds the cursor from the last row it actually returned', () => {
    // Not the over-fetched one. A cursor built from the row that was withheld would skip it.
    const all = rows(11);
    const result = paginate(all, 10, key);
    const decoded = decodeCursor(result.nextCursor ?? undefined);

    expect(decoded?.id).toBe('id-9');
    expect(decoded?.timestamp.getTime()).toBe(all[9].at.getTime());
  });

  it('handles an empty page', () => {
    const result = paginate([], 10, key);

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('does not hand back the caller’s array', () => {
    // The rows come straight from the driver; returning the same reference would let a caller's
    // later mutation reach back into whatever else held it.
    const source = rows(3);
    const result = paginate(source, 10, key);

    expect(result.items).not.toBe(source);
    expect(result.items).toEqual(source);
  });
});
