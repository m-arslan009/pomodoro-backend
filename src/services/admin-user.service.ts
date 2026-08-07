import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '../common/ports/clock.port';
import { ProblemException, notFoundProblem } from '../common/errors/problem.exception';
import {
  type AdminActionContext,
  type AdminUserDetail,
  type AdminUserDetailParts,
  toAdminUserDetail,
} from '../common/types/admin.types';
import { type AdminUserSummary, toAdminUserSummary } from '../common/types/user.types';
import { adminSearchKey } from '../domain/admin-user';
import type { AdminUserRole } from '../domain/admin-user';
import {
  refusesLastAdmin,
  refusesPromotion,
  refusesSelfDelete,
  refusesSelfDisable,
  refusesSelfRoleChange,
  refusesSelfSessionRevoke,
} from '../domain/role';
import type { RoleRuleTarget, RoleRuleViolation } from '../domain/role';
import type { ChangeUserRoleDto, ListAdminUsersQueryDto } from '../dto/admin.dto';
import { AuthIdentityRepository } from '../repositories/auth-identity.repository';
import { AuthSessionRepository } from '../repositories/auth-session.repository';
import { ReportSubscriptionRepository } from '../repositories/report-subscription.repository';
import { SessionRepository } from '../repositories/session.repository';
import { TaskRepository } from '../repositories/task.repository';
import { UserRepository } from '../repositories/user.repository';
import type { AdminActionResult } from '../repositories/user.repository';

/**
 * The account directory and the actions on one account, for an operator.
 *
 * IT IS DELIBERATELY NOT PART OF `UserService`. That service is the signed-in account acting on
 * itself; this one is an operator acting on everybody, behind a different guard. Merging them would
 * put routes that read and write any row next to routes whose entire safety property is that they
 * touch exactly one.
 *
 * WHERE THE RULES LIVE, AND WHERE THEY RUN. The three domain rules are pure functions in
 * `domain/role.ts`; this service composes them into the check a write is evaluated under, and the
 * repository runs that check **inside the write's transaction**. The split is what makes rule 3
 * correct: "am I the last administrator?" answered outside the transaction lets two concurrent
 * demotions each see two administrators and together empty the set.
 *
 * EVERY WRITE RE-READS AND RETURNS THE FULL DETAIL. §6.4, §6.5 and §6.7 all answer with the account
 * rather than with a boolean, so the client re-renders from the server's version of the row instead
 * of from an optimistic guess. That is one extra read per action and it is the price of the client
 * never being able to display a state the database does not hold.
 *
 * READS ARE NOT AUDITED. A GET that changes nothing has nothing to record, and one row per page view
 * would drown the five actions that matter. Pino's per-request log already records who called what
 * and when (ADR-016), joined to the audit rows by `request_id`.
 */
@Injectable()
export class AdminUserService {
  constructor(
    private readonly users: UserRepository,
    private readonly authSessions: AuthSessionRepository,
    private readonly identities: AuthIdentityRepository,
    private readonly sessions: SessionRepository,
    private readonly tasks: TaskRepository,
    private readonly reports: ReportSubscriptionRepository,
    private readonly clock: Clock,
  ) {}

  async listUsers(
    query: ListAdminUsersQueryDto,
  ): Promise<{ users: AdminUserSummary[]; nextCursor: string | null }> {
    const { users, nextCursor } = await this.users.listForAdmin({
      // Undefined rather than an empty string: absent means "no filter", and the repository
      // distinguishes the two by presence, not by truthiness.
      search: query.q === undefined ? undefined : adminSearchKey(query.q),
      role: query.role,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });

    return { users: users.map(toAdminUserSummary), nextCursor };
  }

  /**
   * One account, gathered from every table that holds a fact about it (§6.2).
   *
   * A FAN-OUT ACROSS REPOSITORIES, NOT A JOIN. Each table is read by the component that owns it
   * (ADR-020), and each of those reads is its own narrow admin projection rather than the record
   * type the rest of the application uses — which is how `provider_subject`, the session token
   * digests, the report token hashes and `last_error` stay out of this payload by construction
   * instead of by being stripped on the way past.
   *
   * Six queries in parallel. They are independent, none of them is a scan, and the alternative — one
   * hand-written join — would be the first raw SQL in the project and would put every one of those
   * excluded columns one `SELECT *` away.
   *
   * `getGamification` is the one read here that is NOT admin-specific: it is the same projection the
   * account's own progression endpoint uses, so it returns two internal fields the detail view has
   * no use for (`currentSessionRun`, `lastActiveDate`). Neither reaches the response —
   * `toAdminUserDetail` names the six fields it emits rather than spreading what it was given, which
   * is why reusing this read is safe and why the projection is written that way.
   */
  async getUser(id: string): Promise<AdminUserDetail> {
    const user = await this.users.findAdminDetailById(id);
    if (!user) throw this.missing();

    const now = this.clock.now();
    const [identities, sessions, gamification, tasks, focusSessions, reports] = await Promise.all([
      this.identities.listForAdmin(id),
      this.authSessions.summariseForAdmin(id, now),
      this.sessions.getGamification(id),
      this.tasks.countForAdmin(id),
      this.sessions.countForAdmin(id),
      this.reports.findAdminSummary(id),
    ]);

    const parts: AdminUserDetailParts = {
      user,
      identities,
      sessions,
      gamification,
      counts: { tasks, focusSessions },
      reports,
    };

    return toAdminUserDetail(parts);
  }

  /**
   * Block an account immediately, and cut every session it holds (§6.4).
   *
   * Both rules that can refuse it: an administrator may not disable themselves, and the last
   * remaining administrator may not be disabled. A disabled administrator still counts toward the
   * administrator set — see `domain/role.ts` for why counting only active ones would let the set be
   * emptied one disable at a time.
   */
  async disableUser(
    actor: AdminActionContext,
    targetId: string,
    reason: string,
  ): Promise<AdminUserDetail> {
    const outcome = await this.users.disableForAdmin(targetId, reason, actor, (target, admins) => {
      if (refusesSelfDisable(actor.actorId, target.id)) return 'self_disable';
      if (refusesLastAdmin(target, admins)) return 'last_admin';
      return null;
    });

    this.settle(outcome);
    return this.getUser(targetId);
  }

  /** Restore the ability to sign in. Sessions revoked at disable time stay revoked (§6.5). */
  async reactivateUser(actor: AdminActionContext, targetId: string): Promise<AdminUserDetail> {
    this.settle(await this.users.reactivateForAdmin(targetId, actor));
    return this.getUser(targetId);
  }

  /**
   * Cut every refresh session without disabling the account (§6.6).
   *
   * THE ONE ACTION THAT DOES NOT ANSWER WITH THE ACCOUNT, because a count is what it did. The client
   * re-reads the detail afterwards to show the new session summary — that round trip is why the
   * response is honest about being a count rather than pretending to be a user.
   */
  async revokeSessions(actor: AdminActionContext, targetId: string): Promise<{ revoked: number }> {
    const outcome = await this.users.revokeSessionsForAdmin(targetId, actor, (target) =>
      refusesSelfSessionRevoke(actor.actorId, target.id) ? 'self_session_revoke' : null,
    );

    return this.settle(outcome);
  }

  /**
   * The only write path to `users.role` (§6.7).
   *
   * Three refusals: self-target, demoting the last administrator, and promoting an account that
   * cannot sign in. The last is not one of the three rules but belongs beside them — promoting a
   * disabled or credential-less account creates an administrator who cannot sign in and whom rule 3
   * then refuses to demote, turning one careless promotion into a permanent phantom operator.
   */
  async changeRole(
    actor: AdminActionContext,
    targetId: string,
    dto: ChangeUserRoleDto,
  ): Promise<AdminUserDetail> {
    const nextRole: AdminUserRole = dto.role;

    const outcome = await this.users.changeRoleForAdmin(
      targetId,
      nextRole,
      actor,
      (target, admins) => this.checkRoleChange(actor.actorId, target, admins, nextRole),
    );

    this.settle(outcome);
    return this.getUser(targetId);
  }

  /**
   * Permanently delete an account (§6.9).
   *
   * The typed confirmation is verified in the repository, against the same row the delete runs on.
   * Nothing about that check lives here: a service-level comparison would be a check against a row
   * read a moment earlier, which is exactly the window the transaction closes.
   */
  async deleteUser(
    actor: AdminActionContext,
    targetId: string,
    confirmEmail: string,
  ): Promise<{ counts: { tasks: number; focusSessions: number } }> {
    const outcome = await this.users.deleteForAdmin(
      targetId,
      confirmEmail,
      actor,
      (target, admins) => {
        if (refusesSelfDelete(actor.actorId, target.id)) return 'self_delete';
        if (refusesLastAdmin(target, admins)) return 'last_admin';
        return null;
      },
    );

    return { counts: this.settle(outcome) };
  }

  /* ---------------------------------------------------------------- Refusals -- */

  /** The rule set for a role change, as one function so the promotion control cannot be forgotten. */
  private checkRoleChange(
    actorId: string,
    target: RoleRuleTarget,
    admins: number,
    nextRole: AdminUserRole,
  ): RoleRuleViolation | null {
    if (refusesSelfRoleChange(actorId, target.id)) return 'self_role_change';
    /*
     * Only a demotion can empty the administrator set, so rule 3 is asked only about one. Asking it
     * about a promotion would refuse promoting the second administrator, which is the opposite of
     * what the rule protects.
     */
    if (nextRole !== 'admin' && refusesLastAdmin(target, admins)) return 'last_admin';
    if (refusesPromotion(target, nextRole)) return 'promotion_blocked';
    return null;
  }

  /**
   * Turn a repository refusal into the response the client sees, or return quietly on success.
   *
   * ONE PLACE, so no route can answer a rule violation with a status another route answers
   * differently. The mapping itself is short and load-bearing:
   *
   *  - `not_found` → the namespace's own 404, byte-identical to what a non-admin gets for any admin
   *    URL. A distinct body would tell a non-admin that this route exists.
   *  - every rule violation → **409**, not 422: the request was well-formed, the target exists, and
   *    the action is still refused. There is no field for a form to fix.
   *  - `email_mismatch` → **422** with a field error, because there *is* a field to fix and the
   *    client can place the message on it.
   *
   * The 409 `detail` is written to be read by an operator. It is the one message on this surface the
   * client shows verbatim, and it has to be: the last-admin rule depends on a count the browser does
   * not hold, so the client cannot generate that sentence itself.
   */
  private settle<T>(outcome: AdminActionResult<T>): T {
    if (outcome.ok) return outcome.value;

    switch (outcome.refusal) {
      case 'not_found':
        throw this.missing();

      case 'self_role_change':
        throw conflict('You cannot change your own role. Ask another administrator to do it.');

      case 'self_disable':
        throw conflict('You cannot disable your own account. Ask another administrator to do it.');

      case 'self_delete':
        throw conflict('You cannot delete your own account. Ask another administrator to do it.');

      case 'self_session_revoke':
        throw conflict('You cannot revoke your own sessions here. Sign out instead.');

      case 'last_admin':
        throw conflict(
          'This is the last administrator account. The system must always have at least one administrator, so this one cannot be demoted or disabled — promote another account first.',
        );

      case 'promotion_blocked':
        throw conflict(
          'This account cannot be promoted: it is disabled, or it has no password and no linked sign-in. Promoting it would create an administrator who cannot sign in and could not then be demoted.',
        );

      case 'email_mismatch':
        throw new ProblemException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          title: 'Validation failed',
          detail: 'The confirmation address does not match this account.',
          errors: [{ field: 'confirmEmail', message: 'This is not this account’s email address.' }],
        });

      default:
        throw this.missing();
    }
  }

  /**
   * "There is no such account" — and deliberately the same 404 the namespace gives a non-admin.
   *
   * `notFoundProblem` rather than `routeNotFoundProblem`: the caller has already been admitted by
   * `AdminGuard`, so they know the namespace exists and there is nothing left to withhold. Saying
   * plainly that the account is gone is useful to an operator whose colleague deleted it a minute
   * ago, and discloses nothing they could not learn from the directory listing.
   */
  private missing(): ProblemException {
    return notFoundProblem('No account with that id.');
  }
}

/** A domain-rule refusal on a well-formed request. Always 409, never 422 — see `domain/role.ts`. */
function conflict(detail: string): ProblemException {
  return new ProblemException({
    status: HttpStatus.CONFLICT,
    title: 'Action not allowed',
    detail,
  });
}
