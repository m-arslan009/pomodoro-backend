import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AdminUserSummary } from '../common/types/user.types';
import { type ListAdminUsersQueryDto, listAdminUsersQuerySchema } from '../dto/admin.dto';
import { AdminGuard } from '../guards/admin.guard';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { AdminUserService } from '../services/admin-user.service';

/**
 * The account directory (`admin_role_plan.md` §6.1) — the first route in the `/admin` namespace.
 *
 * GUARD ORDER IS THE CONTRACT. Nest runs controller guards left to right, so `JwtGuard` resolves the
 * account and `AdminGuard` then decides whether this namespace exists for it. Reversing them would
 * make `AdminGuard` read an `auth` that is not there yet and answer 404 to everyone, including
 * administrators.
 *
 * GUARDS RUN BEFORE PIPES, and that ordering is load-bearing here rather than incidental. A
 * non-admin sending `?limit=999` must get the same 404 as one sending nothing — if validation ran
 * first, a 422 complaining about `limit` would confirm the endpoint is real and that it takes a
 * `limit`, which is precisely what the 404 posture exists to withhold.
 *
 * READ-ONLY, AND STAYING THAT WAY IN THIS INCREMENT. Disable, reactivate, revoke-sessions, role
 * change, the audit feed and the statistics view are all specified in `admin_role_plan.md` and are
 * deliberately absent — every one of them is a write, and every one of them needs the audit table
 * that has not been built.
 */
@Controller('admin/users')
@UseGuards(JwtGuard, AdminGuard)
export class AdminUserController {
  constructor(private readonly admin: AdminUserService) {}

  /**
   * One page of accounts, newest first, filtered by search / role / status.
   *
   * `nextCursor` is null on the last page. There is no total and no page count — see the repository
   * for why a cursor list cannot honestly report either.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(listAdminUsersQuerySchema)) query: ListAdminUsersQueryDto,
  ): Promise<{ users: AdminUserSummary[]; nextCursor: string | null }> {
    return this.admin.listUsers(query);
  }
}
