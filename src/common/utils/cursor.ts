/*
 * Keyset (cursor) pagination helpers.
 *
 * Cursors, never OFFSET. OFFSET makes the database walk and discard every skipped row, so page 40
 * costs forty times page 1 — and worse, a record inserted mid-scroll shifts every subsequent page,
 * so the user silently skips or re-sees rows. Both lists paginated here (tasks by `created_at`,
 * sessions by `started_at`) are append-heavy and read newest-first, which is exactly the case where
 * that goes wrong.
 *
 * The cursor is the last row's sort key plus its id. The id breaks ties, so two rows sharing a
 * timestamp cannot straddle a page boundary and lose one of themselves.
 *
 * It is base64url-encoded to signal "opaque, do not construct one by hand" — not to hide anything.
 * Both halves are values the caller already has.
 */

export interface Cursor {
  readonly timestamp: Date;
  readonly id: string;
}

export function encodeCursor(timestamp: Date, id: string): string {
  return Buffer.from(`${timestamp.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Null for anything unparseable — a malformed cursor starts from the beginning, it does not 500. */
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;

  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.indexOf('|');
    if (separator < 0) return null;

    const timestamp = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(timestamp.getTime()) || !id) return null;

    return { timestamp, id };
  } catch {
    return null;
  }
}

/**
 * Trim an over-fetched page to its requested size and derive the next cursor.
 *
 * The caller asks for `limit + 1` rows; the extra one is never returned, it only answers "is there
 * more?" without a second COUNT query over the same predicate.
 */
export function paginate<T>(
  rows: readonly T[],
  limit: number,
  key: (row: T) => { timestamp: Date; id: string },
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items.at(-1);

  if (!hasMore || !last) return { items, nextCursor: null };

  const { timestamp, id } = key(last);
  return { items, nextCursor: encodeCursor(timestamp, id) };
}
