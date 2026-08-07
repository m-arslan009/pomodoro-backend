import { Injectable } from '@nestjs/common';
import { type AdminAuditEventDto, toAdminAuditEvent } from '../common/types/admin-audit.types';
import type { ListAuditEventsQueryDto } from '../dto/admin.dto';
import { AdminAuditRepository } from '../repositories/admin-audit.repository';

/**
 * The audit feed (`admin_role_plan.md` §6.8).
 *
 * A READ SERVICE, AND ONLY A READ SERVICE. It has no write method and must not grow one: audit rows
 * are appended by the mutation they describe, inside that mutation's transaction
 * (`user.repository.ts`), and a service that could append one on its own would be a way to record
 * something that never happened. The table is append-only, so there is no update or delete to expose
 * either.
 *
 * IT IS SEPARATE FROM `AdminUserService` because the two answer different questions about different
 * tables. That service acts on accounts and every one of its writes produces a row this one reads;
 * merging them would put the only component that can write the trail in the same class as the one
 * that reads it, which is the separation worth keeping on an audit surface.
 *
 * THIS READ IS NOT AUDITED, and none of the admin reads are (§5.2). One row per page view would
 * drown the actions that matter, and Pino's per-request log already records who called what and when
 * (ADR-016) — joined to these rows by `request_id`, which is the same id on both surfaces.
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly events: AdminAuditRepository) {}

  /**
   * One page of the record, newest first.
   *
   * The date strings are parsed here rather than in the DTO because the repository compares
   * instants: the schema's job is to prove the value is a valid ISO-8601 timestamp with an offset,
   * and this is the boundary where a proven string becomes a `Date`. `nextCursor` is null on the
   * last page — there is no total and no page count, for the reason the repository gives.
   */
  async listEvents(
    query: ListAuditEventsQueryDto,
  ): Promise<{ events: AdminAuditEventDto[]; nextCursor: string | null }> {
    const { events, nextCursor } = await this.events.listForAdmin({
      targetUserId: query.targetUserId,
      actorUserId: query.actorUserId,
      action: query.action,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      cursor: query.cursor,
      limit: query.limit,
    });

    return { events: events.map(toAdminAuditEvent), nextCursor };
  }
}
