import { Injectable } from '@nestjs/common';
import type { AuthSessionRecord, DeviceContext } from '../common/types/auth-session.types';
import { PrismaService } from '../database/prisma.service';

/*
 * The only component allowed to read or write the auth_sessions table (ADR-020).
 *
 * Every method takes a token *digest* (a raw byte array, matching the bytea column) or a session id —
 * never a plaintext token. Hashing happens one layer up in RefreshTokenService, so the plaintext
 * never reaches a query, a log, or a stack trace from here.
 *
 * Deletion policy is deliberate and easy to get wrong: revocation **sets `revoked_at` and keeps the
 * row**. Deleting instead would make a replayed token indistinguishable from an unknown one, which
 * is exactly the signal reuse detection depends on. Rows are removed only by `purgeExpired`, once
 * they are far enough past their idle window that a replay would be refused anyway.
 */

export interface CreateSessionInput {
  readonly userId: string;
  readonly tokenHash: Uint8Array<ArrayBuffer>;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly now: Date;
  readonly device: DeviceContext;
}

export interface RotateSessionInput {
  /** The row being replaced. Revoked, not deleted, in the same transaction as the insert. */
  readonly previousId: string;
  readonly userId: string;
  readonly tokenHash: Uint8Array<ArrayBuffer>;
  readonly expiresAt: Date;
  /** Inherited from the predecessor, never recomputed — see `domain/auth-session.ts`. */
  readonly absoluteExpiresAt: Date;
  readonly now: Date;
  readonly device: DeviceContext;
}

/** Columns every read returns. The digest and the forensic columns are never handed upward. */
const RECORD_FIELDS = {
  id: true,
  userId: true,
  expiresAt: true,
  absoluteExpiresAt: true,
  revokedAt: true,
} as const;

@Injectable()
export class AuthSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Open a session. Only a fresh sign-in calls this; every later step rotates. */
  async create(input: CreateSessionInput): Promise<AuthSessionRecord> {
    return this.prisma.authSession.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        lastSeenAt: input.now,
        userAgent: input.device.userAgent,
        ip: input.device.ip,
      },
      select: RECORD_FIELDS,
    });
  }

  /**
   * Look a presented token up by its digest.
   *
   * Returns revoked and expired rows too — the caller has to tell "revoked" from "never existed"
   * apart, because only the first is a reuse signal. Filtering them out in the query would throw
   * away the distinction the whole detection rests on.
   */
  async findByTokenHash(tokenHash: Uint8Array<ArrayBuffer>): Promise<AuthSessionRecord | null> {
    return this.prisma.authSession.findUnique({
      where: { tokenHash },
      select: RECORD_FIELDS,
    });
  }

  /**
   * Replace one session with its successor: revoke the old row and insert the new one **in a single
   * transaction**. Two writes that could half-apply would leave either a session with no successor
   * (a signed-out user) or two live siblings (a credential that outlived its rotation).
   */
  async rotate(input: RotateSessionInput): Promise<AuthSessionRecord> {
    const [, next] = await this.prisma.$transaction([
      this.prisma.authSession.update({
        where: { id: input.previousId },
        data: { revokedAt: input.now },
        select: { id: true },
      }),
      this.prisma.authSession.create({
        data: {
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          absoluteExpiresAt: input.absoluteExpiresAt,
          lastSeenAt: input.now,
          userAgent: input.device.userAgent,
          ip: input.device.ip,
        },
        select: RECORD_FIELDS,
      }),
    ]);

    return next;
  }

  /**
   * Revoke one session — logout.
   *
   * Already-revoked rows are left alone, so the timestamp keeps naming the moment the session
   * actually ended rather than the last time someone asked.
   */
  async revokeById(id: string, now: Date): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /**
   * Revoke every live session for one account — a password change, and a detected token replay.
   *
   * Neither caller spares a session. A password change revokes all and immediately opens a fresh
   * one for the caller; a replay wants the account signed out everywhere by definition.
   */
  async revokeAllForUser(userId: string, now: Date): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /**
   * Drop this account's dead rows. Called on login only — bounded work on a path that is already
   * writing, which is why no scheduled job exists (ADR-014).
   *
   * Only rows past their idle window go, and only those revoked long enough ago that a replay would
   * be refused on expiry alone. Recently revoked rows are what reuse detection reads, so sweeping
   * them eagerly would blind it during exactly the window an attack would use.
   */
  async purgeExpiredForUser(userId: string, before: Date): Promise<void> {
    await this.prisma.authSession.deleteMany({
      where: { userId, expiresAt: { lt: before } },
    });
  }
}
