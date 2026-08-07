import { Injectable } from '@nestjs/common';
import type { AdminAuditEventRow } from '../common/types/admin-audit.types';
import { decodeCursor, paginate } from '../common/utils/cursor';
import { PrismaService } from '../database/prisma.service';
import type { AdminAuditAction } from '../domain/admin-audit';

/**
 * Reading `admin_audit_events` (`admin_role_plan.md` §6.8).
 *
 * READ-ONLY, AND THAT IS STRUCTURAL RATHER THAN A CHOICE OF SCOPE. There is no update method and no
 * delete method here, and none may be added: the table is append-only (§3.2), and the soft-delete
 * pattern every other table in this schema follows is deliberately withheld from it — a retention
 * window on an audit log is a policy decision, not a default. The single insert path lives in
 * `user.repository.ts`, inside the transaction of the mutation it describes, because an audit row
 * that can commit separately from its own action is not evidence of anything.
 *
 * SO THIS CLASS CANNOT WRITE AND THE WRITER CANNOT BE CALLED ON ITS OWN. Between them that is the
 * append-only guarantee: no caller anywhere can produce a row except as part of a state change, and
 * no caller anywhere can alter one afterwards.
 *
 * THE PROJECTION IS AN ALLOW-LIST. `AUDIT_FIELDS` names eleven columns; the table has exactly those
 * eleven, and naming them rather than selecting the row means a column added later is invisible to
 * this endpoint until somebody deliberately adds it here. The two `users` relations are NOT
 * traversed — the email snapshots are the record (§3.2), and joining to the live account would both
 * re-derive what was deliberately frozen and put every column of `users` one `select` away from an
 * operator's screen.
 */

/** The columns the feed returns. Eleven of eleven — an allow-list by construction, not by omission. */
const AUDIT_FIELDS = {
  id: true,
  action: true,
  actorUserId: true,
  actorEmailSnapshot: true,
  targetUserId: true,
  targetEmailSnapshot: true,
  metadata: true,
  requestId: true,
  ip: true,
  userAgent: true,
  createdAt: true,
} as const;

/** What the feed can be narrowed by. Every field optional; absent means "no filter". */
export interface ListAuditEventsOptions {
  readonly targetUserId?: string;
  readonly actorUserId?: string;
  readonly action?: AdminAuditAction;
  readonly from?: Date;
  readonly to?: Date;
  readonly cursor?: string;
  readonly limit: number;
}

@Injectable()
export class AdminAuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of the record, newest first (§6.8).
   *
   * CURSOR, NEVER OFFSET, and the sort is fixed rather than client-selectable — a client-chosen sort
   * key means a client-chosen cursor key, which is how keyset pagination quietly turns back into
   * offset pagination. `(created_at DESC, id DESC)` matches `admin_audit_events_created_at_id_idx`
   * exactly, so the ordering is index order and the keyset predicate walks it forwards.
   *
   * There is no total count, for the reason the directory gives: `COUNT(*)` over a filtered scan is
   * a second full query, and a cursor list has no page count to report.
   *
   * THE DATE RANGE IS INCLUSIVE AT BOTH ENDS. `gte`/`lte` rather than `gt`/`lt`, because the client
   * sends whole-day boundaries — the last millisecond of the "to" day — and an exclusive upper bound
   * would silently drop an event recorded in that millisecond. On an audit surface a dropped row is
   * indistinguishable from evidence that nothing happened.
   */
  async listForAdmin(
    options: ListAuditEventsOptions,
  ): Promise<{ events: AdminAuditEventRow[]; nextCursor: string | null }> {
    const cursor = decodeCursor(options.cursor);

    const rows = await this.prisma.adminAuditEvent.findMany({
      where: {
        ...(options.targetUserId ? { targetUserId: options.targetUserId } : {}),
        ...(options.actorUserId ? { actorUserId: options.actorUserId } : {}),
        ...(options.action ? { action: options.action } : {}),

        /*
         * The window and the cursor both constrain `created_at`, so they go in `AND` as separate
         * terms rather than into one object. Two `createdAt` keys in a single object literal is a
         * silent overwrite — the second wins and the first vanishes — which here would page
         * correctly while ignoring the date filter, or filter correctly while paging from the top
         * forever.
         */
        AND: [
          ...(options.from || options.to
            ? [
                {
                  createdAt: {
                    ...(options.from ? { gte: options.from } : {}),
                    ...(options.to ? { lte: options.to } : {}),
                  },
                },
              ]
            : []),

          /*
           * Strictly after the last row of the previous page, in the same order the query sorts by.
           * The id breaks ties, so two events recorded in the same millisecond — which a single
           * transaction writing one row per action makes entirely possible under load — cannot
           * straddle a page boundary and lose one of themselves.
           */
          ...(cursor
            ? [
                {
                  OR: [
                    { createdAt: { lt: cursor.timestamp } },
                    { createdAt: cursor.timestamp, id: { lt: cursor.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than asked for: the extra row answers "is there another page?" without a second
      // COUNT over the same predicate, and is never returned.
      take: options.limit + 1,
      select: AUDIT_FIELDS,
    });

    const { items, nextCursor } = paginate(rows, options.limit, (row) => ({
      timestamp: row.createdAt,
      id: row.id,
    }));

    return { events: items, nextCursor };
  }
}
