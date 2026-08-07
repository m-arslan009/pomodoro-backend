import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AdminAuditEventDto } from '../common/types/admin-audit.types';
import { type ListAuditEventsQueryDto, listAuditEventsQuerySchema } from '../dto/admin.dto';
import { AdminGuard } from '../guards/admin.guard';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { AdminAuditService } from '../services/admin-audit.service';

/**
 * The audit record (`admin_role_plan.md` §6.8): who did what, to whom, and when.
 *
 * GUARD ORDER IS THE CONTRACT, exactly as on the accounts controller. Nest runs controller guards
 * left to right, so `JwtGuard` resolves the account and `AdminGuard` then decides whether this
 * namespace exists for it. Reversing them would make `AdminGuard` read an `auth` that is not there
 * yet and answer 404 to everyone, administrators included.
 *
 * GUARDS RUN BEFORE PIPES, and that ordering carries more weight here than anywhere else in the
 * namespace. A non-admin sending `?action=user.disabled` or a malformed uuid must get the same 404
 * as one sending nothing at all — if validation ran first, a 422 naming `action` would confirm both
 * that this endpoint is real and that the product records that action, which is precisely what the
 * 404 posture exists to withhold. The audit trail is the last thing that should answer questions
 * about itself to someone who is not allowed to read it.
 *
 * ONE ROUTE, AND IT IS A GET. There is no POST, no PATCH and no DELETE on this controller and none
 * may be added: `admin_audit_events` is append-only and its rows are written by the mutations they
 * describe, inside those mutations' transactions. An endpoint that could create an audit row would
 * be an endpoint that could record something that never happened; one that could delete a row would
 * defeat the entire table.
 *
 * READING IT IS NOT ITSELF AUDITED (§5.2), like every other admin read. Pino's per-request log
 * already records who called this and when, and `request_id` joins that line to the rows returned.
 */
@Controller('admin/audit-events')
@UseGuards(JwtGuard, AdminGuard)
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  /**
   * One page of events, newest first, filtered by target / actor / action / date range.
   *
   * `nextCursor` is null on the last page. There is no total and no page count — a keyset list
   * cannot honestly report either without a second full query over the same predicate.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(listAuditEventsQuerySchema)) query: ListAuditEventsQueryDto,
  ): Promise<{ events: AdminAuditEventDto[]; nextCursor: string | null }> {
    return this.audit.listEvents(query);
  }
}
