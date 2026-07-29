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
