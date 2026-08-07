import { Injectable } from '@nestjs/common';
import type { AdminUserRow, UserRecord } from '../common/types/user.types';
import { decodeCursor, paginate } from '../common/utils/cursor';
import { PrismaService } from '../database/prisma.service';
import type { AdminUserRole, AdminUserStatus } from '../domain/admin-user';

/*
 * The only component allowed to read or write the users table (ADR-020).
 *
 * Every method returns a plain UserRecord rather than a Prisma row, so the ORM stops here.
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
}
