import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import { Clock } from '../common/ports/clock.port';
import type { AdminActionContext, AdminUserDetail } from '../common/types/admin.types';
import type { AuthenticatedRequest } from '../common/types/authenticated-request';
import type { AdminUserSummary, AuthContext } from '../common/types/user.types';
import {
  type ChangeUserRoleDto,
  type DeleteUserDto,
  type DisableUserDto,
  type ListAdminUsersQueryDto,
  changeUserRoleSchema,
  deleteUserSchema,
  disableUserSchema,
  listAdminUsersQuerySchema,
} from '../dto/admin.dto';
import { AdminGuard } from '../guards/admin.guard';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { AdminUserService } from '../services/admin-user.service';

/**
 * The account directory and the actions on one account (`admin_role_plan.md` §6.1–§6.7, §6.9).
 *
 * GUARD ORDER IS THE CONTRACT. Nest runs controller guards left to right, so `JwtGuard` resolves the
 * account and `AdminGuard` then decides whether this namespace exists for it. Reversing them would
 * make `AdminGuard` read an `auth` that is not there yet and answer 404 to everyone, including
 * administrators.
 *
 * GUARDS RUN BEFORE PIPES, and that ordering is load-bearing here rather than incidental. A
 * non-admin sending `?limit=999`, a malformed uuid, or a body with an unknown key must get the same
 * 404 as one sending nothing — if validation ran first, a 422 naming a parameter would confirm the
 * endpoint is real and that it takes that parameter, which is precisely what the 404 posture exists
 * to withhold.
 *
 * THIS IS THE ONLY NAMESPACE IN THE PRODUCT WHERE A ROUTE TAKES ANOTHER ACCOUNT'S ID. Everywhere
 * else, ownership is a query constraint and no route accepts a user id at all (ADR-010). The
 * exception is contained to this file and to the administration section of `UserRepository`, so the
 * property ADR-010 actually defends — an unscoped query is a deliberate act, reviewable in one place
 * — survives it.
 *
 * EVERY MUTATION IS AUDITED, INSIDE ITS OWN TRANSACTION. There is no route here that changes state
 * without writing an `admin_audit_events` row alongside it, and none may be added: an unaudited
 * administrative write is the one thing this whole design is arranged to prevent (§5.1).
 */
@Controller('admin/users')
@UseGuards(JwtGuard, AdminGuard)
export class AdminUserController {
  constructor(
    private readonly admin: AdminUserService,
    private readonly clock: Clock,
  ) {}

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

  /**
   * Everything an operator needs to decide whether to disable, revoke, or promote — and nothing
   * more (§6.2). Counts and totals, never records: no task title and no focus-session content is
   * reachable through this route or any other in the namespace.
   */
  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ user: AdminUserDetail }> {
    return { user: await this.admin.getUser(id) };
  }

  /**
   * Stop an account immediately — the primary incident control (§6.4).
   *
   * The reason is required and is written to the audit row. In one transaction: `disabled_at` is
   * set, every session is revoked, and the audit row is written. Answers with the account's new
   * detail, so the caller re-renders from the server rather than from a guess.
   *
   * Idempotent on an already-disabled account: 200, no second audit row, no second revocation.
   */
  @Post(':id/disable')
  async disable(
    @CurrentAuth() auth: AuthContext,
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(disableUserSchema)) dto: DisableUserDto,
  ): Promise<{ user: AdminUserDetail }> {
    return { user: await this.admin.disableUser(this.context(auth, request), id, dto.reason) };
  }

  /**
   * Undo a disable (§6.5). Sessions stay revoked — this restores the ability to sign in, not the
   * sessions that existed before. Idempotent on an active account.
   */
  @Post(':id/reactivate')
  async reactivate(
    @CurrentAuth() auth: AuthContext,
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ user: AdminUserDetail }> {
    return { user: await this.admin.reactivateUser(this.context(auth, request), id) };
  }

  /**
   * Cut a suspected-stolen session without disabling the account (§6.6).
   *
   * ANSWERS A COUNT, NOT AN ACCOUNT, because a count is what it did. It kills the refresh half: an
   * access token already issued keeps working until it expires, because `JwtGuard` verifies a
   * signature rather than reading `auth_sessions`. **Disable is the control that acts instantly**,
   * and the admin UI says so — an operator who believes this cuts access outright would not reach
   * for the control that does.
   */
  @Delete(':id/sessions')
  async revokeSessions(
    @CurrentAuth() auth: AuthContext,
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ revoked: number }> {
    return this.admin.revokeSessions(this.context(auth, request), id);
  }

  /**
   * The only write path to `users.role` in the entire application (§6.7).
   *
   * A demotion does not revoke sessions: the account stays signed in as an ordinary user, and
   * because the role is re-read from the row on every request rather than carried in the token, the
   * demotion is effective on their very next call. Idempotent to the current role.
   */
  @Patch(':id/role')
  async changeRole(
    @CurrentAuth() auth: AuthContext,
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(changeUserRoleSchema)) dto: ChangeUserRoleDto,
  ): Promise<{ user: AdminUserDetail }> {
    return { user: await this.admin.changeRole(this.context(auth, request), id, dto) };
  }

  /**
   * Permanently delete an account and everything belonging to it (§6.9).
   *
   * THE CONFIRMATION IS IN THE BODY BECAUSE THE SERVER VERIFIES IT. A typed-address dialog that only
   * the client checks protects nobody against a request that never went through the client, so
   * `confirmEmail` is compared against the row inside the deleting transaction. A DELETE carrying a
   * body is unusual and is the point: this route will not act on a path alone.
   *
   * Answers with what was destroyed, as counts. The audit row survives the deletion — the foreign
   * key is `ON DELETE SET NULL` and the email snapshot is the record.
   */
  @Delete(':id')
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(deleteUserSchema)) dto: DeleteUserDto,
  ): Promise<{ deleted: { counts: { tasks: number; focusSessions: number } } }> {
    const result = await this.admin.deleteUser(this.context(auth, request), id, dto.confirmEmail);
    return { deleted: result };
  }

  /**
   * Who acted, from where, under which request — everything an audit row records about the caller.
   *
   * The actor's email is read from the profile `JwtGuard` already loaded and is **snapshotted** into
   * the row rather than joined at read time, so the trail still names who acted after that
   * operator's own account is gone.
   *
   * `request.id` is Pino's per-request uuid (`app.module.ts`), which the exception filter also
   * reports as the Problem Details `instance`. One id ties an audit row, a log line and the client's
   * error message together.
   */
  private context(auth: AuthContext, request: AuthenticatedRequest): AdminActionContext {
    return {
      actorId: auth.userId,
      actorEmail: auth.profile.email,
      requestId: typeof request.id === 'string' ? request.id : null,
      ip: request.ip ?? null,
      /* Bounded to the column's width here rather than being truncated by the database. */
      userAgent: request.headers['user-agent']?.slice(0, 512) ?? null,
      now: this.clock.now(),
    };
  }
}
