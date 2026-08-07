import { Injectable } from '@nestjs/common';
import type { AdminActionContext, AdminUserDetailRow } from '../common/types/admin.types';
import type { AdminUserRow, UserRecord } from '../common/types/user.types';
import { decodeCursor, paginate } from '../common/utils/cursor';
import { PrismaService } from '../database/prisma.service';
import type { AdminAuditEntry } from '../domain/admin-audit';
import type { AdminUserRole, AdminUserStatus } from '../domain/admin-user';
import type { RoleRuleTarget, RoleRuleViolation } from '../domain/role';

/*
 * The only component allowed to read or write the users table (ADR-020).
 *
 * Every method returns a plain UserRecord rather than a Prisma row, so the ORM stops here.
 *
 * THE ADMINISTRATION SECTION AT THE BOTTOM IS THE ONE PLACE IN THE APPLICATION THAT ADDRESSES
 * SOMEBODY ELSE'S ACCOUNT. Everything above it takes a `userId` the caller already proved they own,
 * which is ADR-010's ownership-as-a-query-constraint in practice. The admin methods deliberately do
 * not, and they are gathered under one heading rather than scattered so that ADR-010's actual
 * security property survives the exception: *bypass requires deliberately writing an unscoped query,
 * which is reviewable in one place.*
 *
 * That section also writes two tables this repository does not own — `auth_sessions` and
 * `admin_audit_events` — and that is the narrower violation, the same one `createFromIdentity`
 * already makes for `auth_identities` and `UserAvatarRepository` makes for `users`. The alternative
 * is passing a transaction handle across repositories, which leaks the ORM into the service layer
 * that ADR-004's escape hatch depends on keeping clean. Atomicity is not negotiable here: an audit
 * row that commits without its state change, or a disable that commits without revoking sessions,
 * are both worse than the layering compromise.
 */

export interface CreateUserInput {
  readonly email: string;
  readonly username: string;
  readonly usernameLower: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly passwordHash: string;
  readonly timezone: string;
}

/**
 * An account created from a provider's assertion (ADR-008a). No password: this account's only
 * credential is the identity created alongside it, which is why the two are written together.
 */
export interface CreateUserFromIdentityInput {
  readonly email: string;
  readonly username: string;
  readonly usernameLower: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly timezone: string;
  /** Set because the provider asserted the address is verified — never on any other basis. */
  readonly emailVerifiedAt: Date;
  readonly provider: string;
  readonly providerSubject: string;
}

/** Which unique identifiers a registration collided with. */
export type UserConflictField = 'email' | 'username';

export type CreateUserResult =
  | { readonly ok: true; readonly user: UserRecord }
  | { readonly ok: false; readonly conflicts: readonly UserConflictField[] };

export interface UpdateProfileInput {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly usernameLower?: string;
  readonly timezone?: string;
}

export type UpdateProfileResult =
  { readonly ok: true; readonly user: UserRecord | null } | { readonly ok: false };

/**
 * The directory read's filters. Every field is already validated and normalised by the time it
 * arrives — `search` in particular is the lowercase storage form, not what the operator typed.
 */
export interface ListAdminUsersOptions {
  /** A lowercase prefix, matched against `email` and `username_lower`. */
  readonly search?: string;
  readonly role?: AdminUserRole;
  readonly status?: AdminUserStatus;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * The columns the admin directory may read — and the only reason no credential can leak into it.
 *
 * This object and `AdminUserRow` have to agree, and TypeScript checks that they do. Widening it is
 * therefore a deliberate, visible act: `password_hash` is one word away, and the type is what stops
 * that word from being typed absent-mindedly.
 */
const ADMIN_USER_FIELDS = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  role: true,
  emailVerifiedAt: true,
  disabledAt: true,
  createdAt: true,
} as const;

/**
 * The `users` columns the detail read may select — the allow-list, one layer down.
 *
 * `passwordHash` IS SELECTED AND IS NEVER RETURNED. The detail payload needs to say *whether* the
 * account has a password, and Prisma cannot compute a boolean in a `select`. So the column is read
 * inside this file — which is the layer already trusted with credentials, since `UserRecord` carries
 * the hash — and reduced to `hasPassword` before the row leaves. `AdminUserDetailRow` has no field
 * that could hold it, so the reduction is checked by the compiler rather than remembered.
 */
const ADMIN_DETAIL_FIELDS = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  role: true,
  timezone: true,
  emailVerifiedAt: true,
  passwordChangedAt: true,
  passwordHash: true,
  avatarUpdatedAt: true,
  disabledAt: true,
  createdAt: true,
} as const;

/**
 * Why an administrative write was refused, or that the target does not exist.
 *
 * `not_found` is in the same union as the rule violations because the caller has to answer all of
 * them and the transaction is the only place that can tell them apart — the row is read, the rules
 * are applied and the write happens under one snapshot.
 */
export type AdminActionRefusal = RoleRuleViolation | 'not_found' | 'email_mismatch';

export type AdminActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: AdminActionRefusal };

/**
 * The rule check, supplied by the caller and run **inside the transaction**.
 *
 * A parameter rather than an `if` in this file, for the same reason `SessionRepository.record` takes
 * the scoring fold as one: the rules stay in `src/domain`, pure and testable without a database,
 * while this method owns the snapshot they must be evaluated under. Rule 3 in particular is only
 * correct inside the transaction — two concurrent demotions evaluating "am I the last admin?"
 * outside it would each see two administrators and together empty the set.
 *
 * Returns the violation to refuse with, or null to proceed.
 */
export type AdminRuleCheck = (
  target: RoleRuleTarget,
  adminCount: number,
) => RoleRuleViolation | null;

/** Prisma's unique-constraint failure, detected structurally so no ORM type escapes this file. */
function isUniqueViolation(error: unknown): error is { code: string; meta?: { target?: unknown } } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

/** Prisma's "record to update not found". */
function isMissingRecord(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';
}

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /** Lookup by the case-insensitive uniqueness key, never by the display username. */
  async findByUsernameKey(usernameLower: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { usernameLower } });
  }

  /**
   * One page of the account directory, newest first (`admin_role_plan.md` §6.1).
   *
   * THE ONE READ IN THIS FILE THAT IS NOT SCOPED TO A SINGLE ACCOUNT, and the only one there will
   * be. ADR-010 makes ownership a query constraint rather than a check afterwards, and every other
   * method here addresses exactly one row by a key the caller already holds. This one deliberately
   * addresses all of them — which is why it lives behind `AdminGuard` and why it selects through an
   * allow-list instead of returning `UserRecord`.
   *
   * It is also the reason there is no `AdminUserRepository`: ADR-020 gives the `users` table exactly
   * one component that touches it, and a second repository over the same table is precisely what
   * that rule exists to prevent.
   *
   * CURSOR, NEVER OFFSET. Sort is fixed `created_at DESC, id DESC` and is not client-selectable —
   * a client-chosen sort key means a client-chosen cursor key, which is how keyset pagination
   * quietly turns back into offset pagination. There is no total count either: `COUNT(*)` over a
   * filtered search is a second full query, and cursor pagination has no page count to report.
   *
   * `q` is a PREFIX match, not `contains`. A substring search would force a sequential scan over the
   * one table every authenticated request already reads; a prefix stays on the unique indexes that
   * `email` and `username_lower` already carry (§1.1). Stated so it is not "improved" into
   * `contains` later.
   */
  async listForAdmin(
    options: ListAdminUsersOptions,
  ): Promise<{ users: AdminUserRow[]; nextCursor: string | null }> {
    const cursor = decodeCursor(options.cursor);

    const rows = await this.prisma.user.findMany({
      where: {
        ...(options.role ? { role: options.role } : {}),
        /*
         * The derived status, expressed against the column it is derived from. Two separate spreads
         * rather than a ternary chain so that "no status filter" is the absence of both rather than
         * a third branch someone has to notice.
         */
        ...(options.status === 'active' ? { disabledAt: null } : {}),
        ...(options.status === 'disabled' ? { disabledAt: { not: null } } : {}),

        /*
         * BOTH DISJUNCTIONS GO IN `AND`, and this is not stylistic. The search and the cursor are
         * each an `OR`, and two `OR` keys in one object literal is a silent overwrite — the second
         * wins and the first vanishes. That failure would page correctly while ignoring the search
         * box, which is the kind of bug that reads as a backend "returning everything" rather than
         * as a lost predicate.
         */
        AND: [
          ...(options.search
            ? [
                {
                  OR: [
                    { email: { startsWith: options.search } },
                    { usernameLower: { startsWith: options.search } },
                  ],
                },
              ]
            : []),
          /*
           * Strictly after the last row of the previous page, in the same order the query sorts by.
           * The id breaks ties, so two accounts created in the same millisecond cannot straddle a
           * page boundary and lose one of themselves.
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
      select: ADMIN_USER_FIELDS,
    });

    const { items, nextCursor } = paginate(rows, options.limit, (row) => ({
      timestamp: row.createdAt,
      id: row.id,
    }));

    return { users: items, nextCursor };
  }

  /**
   * Insert, letting the unique indexes arbitrate.
   *
   * There is no "is this email taken?" pre-check on purpose: between the check and the insert
   * another request can register the same address, so the constraint is the only race-free
   * authority. The conflict is then translated into field errors for the form.
   */
  async create(input: CreateUserInput): Promise<CreateUserResult> {
    try {
      const user = await this.prisma.user.create({ data: { ...input } });
      return { ok: true, user };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const target = JSON.stringify(error.meta?.target ?? '');
      const conflicts: UserConflictField[] = [];
      if (target.includes('email')) conflicts.push('email');
      if (target.includes('username')) conflicts.push('username');

      // An unrecognised target still means "taken"; reporting both is better than reporting none.
      return { ok: false, conflicts: conflicts.length > 0 ? conflicts : ['email', 'username'] };
    }
  }

  /**
   * Create an account and its provider identity in one statement.
   *
   * The atomicity is the whole reason this is not two calls. An account created from a provider has
   * a null `password_hash`, so the identity *is* its only credential — and a failure between the two
   * inserts would leave an account nobody can ever sign into, holding an email address that now
   * blocks re-registration. A nested write is one statement in one implicit transaction, so that
   * state cannot exist.
   *
   * It reaches into `auth_identities`, which `AuthIdentityRepository` otherwise owns. That is the
   * narrower violation: the alternative is passing a transaction handle across two repositories,
   * which leaks the ORM into the service layer that ADR-004's escape hatch depends on keeping clean.
   */
  async createFromIdentity(input: CreateUserFromIdentityInput): Promise<CreateUserResult> {
    try {
      const user = await this.prisma.user.create({
        data: {
          email: input.email,
          username: input.username,
          usernameLower: input.usernameLower,
          firstName: input.firstName,
          lastName: input.lastName,
          timezone: input.timezone,
          emailVerifiedAt: input.emailVerifiedAt,
          passwordHash: null,
          identities: {
            create: {
              provider: input.provider,
              providerSubject: input.providerSubject,
              emailAtLink: input.email,
            },
          },
        },
      });
      return { ok: true, user };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const target = JSON.stringify(error.meta?.target ?? '');
      const conflicts: UserConflictField[] = [];
      if (target.includes('email')) conflicts.push('email');
      if (target.includes('username')) conflicts.push('username');

      /*
       * A collision on `auth_identities` reports neither, and the caller must not read that as
       * "the username was free". Reporting both is the safe default here as it is in `create`:
       * it says "something was taken" without claiming to know what.
       */
      return { ok: false, conflicts: conflicts.length > 0 ? conflicts : ['email', 'username'] };
    }
  }

  /**
   * Record that the address is verified, and only ever because a provider asserted it.
   *
   * Written for the first time by ADR-008a; still read by nothing. No guard, route or rule gates on
   * `email_verified_at`, and none may until the verification flow of §11 exists — this column
   * currently records a fact, it does not grant anything.
   */
  async markEmailVerified(id: string, at: Date): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { emailVerifiedAt: at } });
  }

  /**
   * Patch the editable profile fields. `username` and `usernameLower` always move together —
   * the database CHECK constraint rejects the row otherwise, which is the point of having it.
   */
  async updateProfile(id: string, data: UpdateProfileInput): Promise<UpdateProfileResult> {
    try {
      const user = await this.prisma.user.update({
        where: { id },
        data: {
          ...(data.firstName === undefined ? {} : { firstName: data.firstName }),
          ...(data.lastName === undefined ? {} : { lastName: data.lastName }),
          ...(data.username === undefined
            ? {}
            : { username: data.username, usernameLower: data.usernameLower }),
          ...(data.timezone === undefined ? {} : { timezone: data.timezone }),
        },
      });
      return { ok: true, user };
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false };
      // The row vanished between authenticating and saving — a deleted account mid-request.
      if (isMissingRecord(error)) return { ok: true, user: null };
      throw error;
    }
  }

  async updatePassword(id: string, passwordHash: string, changedAt: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash, passwordChangedAt: changedAt },
    });
  }

  /** Rehash-on-login when hashing parameters have moved on; leaves passwordChangedAt alone. */
  async updatePasswordHashOnly(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  async markLogin(id: string, at: Date): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { lastLoginAt: at } });
  }

  /* ------------------------------------------------------------ Administration -- */
  /*
   * Everything below addresses an account the caller does not own. See the file header for why they
   * are gathered here rather than spread across the services that call them, and why they are
   * allowed to write `auth_sessions` and `admin_audit_events` inside their own transactions.
   *
   * A SHARED SHAPE, DELIBERATELY. Every write below reads the target row, evaluates the caller's
   * rules against it, performs its change, and inserts exactly one audit row — all under one
   * transaction, in that order. Where an action is idempotent it returns early *after* the rule
   * check and *before* the audit insert, so repeating it is a 200 that records nothing rather than a
   * second row claiming the same thing happened twice.
   */

  /**
   * One account's detail for an operator (`admin_role_plan.md` §6.2).
   *
   * The `users` half only. Sessions, identities, counts, progression and reports each belong to
   * another table, and each is read by that table's own repository — this method does not join
   * across them, so no single query here can grow into one that returns another account's rows.
   */
  async findAdminDetailById(id: string): Promise<AdminUserDetailRow | null> {
    const row = await this.prisma.user.findUnique({ where: { id }, select: ADMIN_DETAIL_FIELDS });
    if (!row) return null;

    // The reduction. `passwordHash` exists in this statement's result and in no value that leaves.
    const { passwordHash, ...rest } = row;
    return { ...rest, hasPassword: passwordHash !== null };
  }

  /**
   * Disable an account, revoke every session it holds, and record why — atomically (§6.4).
   *
   * REVOKING IN THE SAME TRANSACTION IS LOAD-BEARING, not tidiness. Without it the refresh cookie
   * survives the disable, and a later reactivation would silently restore a live 30-day credential
   * that was in an attacker's hands throughout the disabled period.
   *
   * Idempotent on an already-disabled account: 200, no second audit row, no second revocation. The
   * timestamp keeps naming the moment the account was actually disabled rather than the last time
   * somebody asked.
   *
   * @returns how many sessions the disable revoked.
   */
  async disableForAdmin(
    targetId: string,
    reason: string,
    context: AdminActionContext,
    check: AdminRuleCheck,
  ): Promise<AdminActionResult<{ sessionsRevoked: number }>> {
    return this.prisma.$transaction(async (tx) => {
      const target = await readRuleTarget(tx, targetId);
      if (!target) return { ok: false, refusal: 'not_found' };

      const violation = check(target.rules, await countAdmins(tx));
      if (violation) return { ok: false, refusal: violation };

      // Already disabled — nothing to do, and nothing to record.
      if (target.rules.disabled) return { ok: true, value: { sessionsRevoked: 0 } };

      const revoked = await tx.authSession.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: context.now },
      });

      await tx.user.update({ where: { id: targetId }, data: { disabledAt: context.now } });

      await writeAudit(tx, {
        action: 'user.disabled',
        actorUserId: context.actorId,
        actorEmailSnapshot: context.actorEmail,
        targetUserId: targetId,
        targetEmailSnapshot: target.email,
        metadata: { reason, sessionsRevoked: revoked.count },
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return { ok: true, value: { sessionsRevoked: revoked.count } };
    });
  }

  /**
   * Clear the disabled flag (§6.5).
   *
   * SESSIONS STAY REVOKED. Reactivation restores the ability to sign in, not the sessions that
   * existed before it — the user signs in again with the credential they already had, and both
   * password and Google sign-in work unchanged because neither was touched.
   *
   * No rule bounds this one: making an account usable again cannot empty the administrator set or
   * lock the operator out, so there is nothing to refuse. Idempotent on an active account.
   */
  async reactivateForAdmin(
    targetId: string,
    context: AdminActionContext,
  ): Promise<AdminActionResult<null>> {
    return this.prisma.$transaction(async (tx) => {
      const target = await readRuleTarget(tx, targetId);
      if (!target) return { ok: false, refusal: 'not_found' };

      if (!target.rules.disabled) return { ok: true, value: null };

      await tx.user.update({ where: { id: targetId }, data: { disabledAt: null } });

      await writeAudit(tx, {
        action: 'user.reactivated',
        actorUserId: context.actorId,
        actorEmailSnapshot: context.actorEmail,
        targetUserId: targetId,
        targetEmailSnapshot: target.email,
        metadata: {},
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return { ok: true, value: null };
    });
  }

  /**
   * Revoke every live refresh session for an account, without touching the account (§6.6).
   *
   * Sets `revoked_at` and keeps the rows, never deletes them — that is what lets reuse detection
   * still tell a replayed token from an unknown one.
   *
   * A revocation of zero sessions is still audited, unlike the idempotent no-ops above. The
   * operator took an action and it had an effect they should be able to see recorded: "we cut this
   * account's sessions and there were none" is a fact worth having in the trail.
   */
  async revokeSessionsForAdmin(
    targetId: string,
    context: AdminActionContext,
    check: AdminRuleCheck,
  ): Promise<AdminActionResult<{ revoked: number }>> {
    return this.prisma.$transaction(async (tx) => {
      const target = await readRuleTarget(tx, targetId);
      if (!target) return { ok: false, refusal: 'not_found' };

      const violation = check(target.rules, await countAdmins(tx));
      if (violation) return { ok: false, refusal: violation };

      const revoked = await tx.authSession.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: context.now },
      });

      await writeAudit(tx, {
        action: 'user.sessions_revoked',
        actorUserId: context.actorId,
        actorEmailSnapshot: context.actorEmail,
        targetUserId: targetId,
        targetEmailSnapshot: target.email,
        metadata: { revoked: revoked.count },
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return { ok: true, value: { revoked: revoked.count } };
    });
  }

  /**
   * The only write path to `users.role` in the entire application (§6.7).
   *
   * A DEMOTION DOES NOT REVOKE SESSIONS, deliberately. The demoted account stays signed in as an
   * ordinary user, and because `AdminGuard` reads the role from the row `JwtGuard` already loads
   * rather than from a token claim, the demotion is effective on their very next request. Signing
   * them out as well would be a punishment unrelated to the privilege change.
   *
   * Idempotent to the role the account already holds: 200, no audit row — a state that did not
   * change did not happen.
   */
  async changeRoleForAdmin(
    targetId: string,
    nextRole: AdminUserRole,
    context: AdminActionContext,
    check: AdminRuleCheck,
  ): Promise<AdminActionResult<null>> {
    return this.prisma.$transaction(async (tx) => {
      const target = await readRuleTarget(tx, targetId);
      if (!target) return { ok: false, refusal: 'not_found' };

      const violation = check(target.rules, await countAdmins(tx));
      if (violation) return { ok: false, refusal: violation };

      if (target.rules.role === nextRole) return { ok: true, value: null };

      await tx.user.update({ where: { id: targetId }, data: { role: nextRole } });

      await writeAudit(tx, {
        action: 'user.role_changed',
        actorUserId: context.actorId,
        actorEmailSnapshot: context.actorEmail,
        targetUserId: targetId,
        targetEmailSnapshot: target.email,
        metadata: { from: target.rules.role, to: nextRole },
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return { ok: true, value: null };
    });
  }

  /**
   * Permanently delete an account and everything belonging to it (§6.9).
   *
   * THE CONFIRMATION IS VERIFIED HERE, INSIDE THE TRANSACTION, against the row about to be deleted.
   * A client-side dialog protects nobody against a request that never went through the client, and
   * comparing outside the transaction would leave a window in which the address changed between the
   * check and the delete — so the typed address is matched against the same snapshot the delete
   * runs on. Exact comparison: `email` is stored trim+lowercase behind a CHECK constraint, and the
   * DTO normalises the submitted value the same way, so there is nothing left for a case-insensitive
   * match to forgive.
   *
   * THE CASCADE IS THE SCHEMA'S, NOT THIS METHOD'S. Sessions, identities, avatar, settings, tasks,
   * focus sessions, gamification and the report subscription all declare `onDelete: Cascade`, so one
   * delete removes them. `admin_audit_events` deliberately does not — it is `SET NULL` — which is
   * why the audit row below is written *before* the delete and why its email snapshot is the record
   * that survives.
   *
   * @returns what was destroyed, as counts.
   */
  async deleteForAdmin(
    targetId: string,
    confirmEmail: string,
    context: AdminActionContext,
    check: AdminRuleCheck,
  ): Promise<AdminActionResult<{ tasks: number; focusSessions: number }>> {
    return this.prisma.$transaction(async (tx) => {
      const target = await readRuleTarget(tx, targetId);
      if (!target) return { ok: false, refusal: 'not_found' };

      const violation = check(target.rules, await countAdmins(tx));
      if (violation) return { ok: false, refusal: violation };

      if (confirmEmail !== target.email) return { ok: false, refusal: 'email_mismatch' };

      const [tasks, focusSessions] = await Promise.all([
        tx.task.count({ where: { userId: targetId } }),
        tx.focusSession.count({ where: { userId: targetId } }),
      ]);

      /*
       * Written first, while the foreign key still resolves. The delete then nulls `target_user_id`
       * through `ON DELETE SET NULL` and leaves the row — with its email snapshot — standing. Doing
       * it the other way round would work too, but only because the column is nullable; this order
       * states the intent, which is that the record of the deletion is created by the deletion.
       */
      await writeAudit(tx, {
        action: 'user.deleted',
        actorUserId: context.actorId,
        actorEmailSnapshot: context.actorEmail,
        targetUserId: targetId,
        targetEmailSnapshot: target.email,
        metadata: { counts: { tasks, focusSessions } },
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      });

      await tx.user.delete({ where: { id: targetId } });

      return { ok: true, value: { tasks, focusSessions } };
    });
  }
}

/* ------------------------------------------------------ Transaction helpers -- */
/*
 * Shared by the administration methods above, and deliberately module-private: they take a
 * transaction client, so exposing them would be exposing a way to run an unscoped write outside one.
 */

/** The subset of the client these helpers need — narrow enough that no ORM type escapes the file. */
type AdminTx = Pick<PrismaService, 'user' | 'authSession' | 'adminAuditEvent'>;

/**
 * The target row, as the rules need it plus the email the audit row snapshots.
 *
 * `hasCredential` is what §6.7's promotion control turns on: an account with neither a password nor
 * a linked identity cannot sign in, so promoting it would create an administrator who never can.
 */
async function readRuleTarget(
  tx: AdminTx,
  id: string,
): Promise<{ email: string; rules: RoleRuleTarget } | null> {
  const row = await tx.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      role: true,
      disabledAt: true,
      passwordHash: true,
      _count: { select: { identities: true } },
    },
  });
  if (!row) return null;

  return {
    email: row.email,
    rules: {
      id: row.id,
      // Narrowed the same way every other projection narrows it: a stored value outside the CHECK
      // constraint reads as an ordinary user rather than being trusted as-is.
      role: row.role === 'admin' ? 'admin' : 'user',
      disabled: row.disabledAt !== null,
      hasCredential: row.passwordHash !== null || row._count.identities > 0,
    },
  };
}

/**
 * How many accounts hold the admin role, counted under the caller's transaction snapshot.
 *
 * Read on every administrative write rather than only the ones that could empty the set, so the
 * rule check has the same inputs everywhere and no call site has to decide whether rule 3 applies.
 * It is a count over a table of this size — the schema's own note on why `role` carries no index.
 */
async function countAdmins(tx: AdminTx): Promise<number> {
  return tx.user.count({ where: { role: 'admin' } });
}

/**
 * Append one audit row.
 *
 * INSERT ONLY, AND THERE IS NO OTHER WRITER. No update path and no delete path exists anywhere in
 * the application for `admin_audit_events` — ADR-006's append-only discipline applied to a second
 * table. `metadata` arrives as the typed union from `domain/admin-audit.ts`, never as a spread
 * request body, which is what keeps a future DTO field from landing credential material in the
 * trail.
 */
async function writeAudit(tx: AdminTx, entry: AdminAuditEntry): Promise<void> {
  await tx.adminAuditEvent.create({
    data: {
      action: entry.action,
      actorUserId: entry.actorUserId,
      actorEmailSnapshot: entry.actorEmailSnapshot,
      targetUserId: entry.targetUserId,
      targetEmailSnapshot: entry.targetEmailSnapshot,
      metadata: entry.metadata,
      requestId: entry.requestId,
      ip: entry.ip,
      userAgent: entry.userAgent,
    },
  });
}
