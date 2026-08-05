import { Injectable } from '@nestjs/common';
import type { UserRecord } from '../common/types/user.types';
import { PrismaService } from '../database/prisma.service';

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
