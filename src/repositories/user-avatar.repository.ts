import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/*
 * The only component allowed to read or write the user_avatars table (ADR-020).
 *
 * Kept apart from UserRepository so that class keeps its claim on the users table, and so the one
 * query that loads image bytes is impossible to reach by accident from the request hot path.
 */

export interface AvatarRecord {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export interface ReplaceAvatarInput {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

/** Prisma's "record to update not found" — the account was deleted mid-request. */
function isMissingRecord(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';
}

@Injectable()
export class UserAvatarRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUserId(userId: string): Promise<AvatarRecord | null> {
    return this.prisma.userAvatar.findUnique({
      where: { userId },
      select: { data: true, contentType: true, byteSize: true, width: true, height: true },
    });
  }

  /**
   * Writes the image and its marker on `users` together, so the two can never disagree about
   * whether an avatar exists.
   *
   * The user row is touched first: if the account has gone, that fails with a recognisable error
   * instead of the foreign-key violation the upsert would raise second.
   *
   * @returns false when the account no longer exists.
   */
  async replace(userId: string, input: ReplaceAvatarInput, at: Date): Promise<boolean> {
    try {
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: userId }, data: { avatarUpdatedAt: at } }),
        this.prisma.userAvatar.upsert({
          where: { userId },
          create: { userId, ...input },
          update: { ...input },
        }),
      ]);
      return true;
    } catch (error) {
      if (isMissingRecord(error)) return false;
      throw error;
    }
  }

  /**
   * Clears the image and its marker together, for the same reason `replace` writes them together.
   *
   * `deleteMany` rather than `delete` because removing an avatar that is not there is a success,
   * not a missing-record error (CONTRACT.md §4.5) — it matches zero rows and reports it.
   *
   * @returns false when the account no longer exists.
   */
  async remove(userId: string): Promise<boolean> {
    try {
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: userId }, data: { avatarUpdatedAt: null } }),
        this.prisma.userAvatar.deleteMany({ where: { userId } }),
      ]);
      return true;
    } catch (error) {
      if (isMissingRecord(error)) return false;
      throw error;
    }
  }
}
