import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { Clock } from '../common/ports/clock.port';
import type { DeviceContext, IssuedRefreshToken } from '../common/types/auth-session.types';
import type { Env } from '../config/env.schema';
import { absoluteExpiryFor, isUsable, nextIdleExpiry } from '../domain/auth-session';
import { AuthSessionRepository } from '../repositories/auth-session.repository';
import { UserRepository } from '../repositories/user.repository';

/*
 * The refresh half of the credential pair (ADR-008 rev. 3): minting, hashing, rotation, revocation,
 * and reuse detection. The only place a refresh token is created or consumed.
 *
 * `node:crypto` is used directly rather than behind a port. ADR-020 admits exactly two ports, and
 * the standard applied there holds here: a port with one implementation and no plausible second is
 * a lie about the future. `Clock` *is* injected, because tests must control expiry without waiting
 * seven days.
 *
 * The token is opaque, not a JWT. Nothing needs to read anything out of it — the row it names holds
 * every fact about the session — so a signed, self-describing token would only add a second thing
 * that can be forged.
 */

/** 32 bytes from a CSPRNG. Guessing one is not a threat model; this is why the throttle is loose. */
const TOKEN_BYTES = 32;

/** Why a presented refresh token was refused. The caller collapses all of them into one 401. */
export type RefreshFailure =
  /** No such digest. A forged, mangled, or long-purged token. */
  | 'unknown'
  /** Matched a row that is revoked, expired, or past its ceiling. */
  | 'unusable';

export interface RefreshSuccess {
  readonly ok: true;
  readonly userId: string;
  readonly session: IssuedRefreshToken;
}

export interface RefreshRejection {
  readonly ok: false;
  readonly reason: RefreshFailure;
}

@Injectable()
export class RefreshTokenService {
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;

  constructor(
    private readonly sessions: AuthSessionRepository,
    /*
     * For reuse detection alone. `UserRepository` is the one component permitted to write
     * `auth_sessions`, `users` and `admin_audit_events` in a single transaction, which is what
     * recording a replay atomically requires — see `recordRefreshReuse`. Nothing else in this
     * service touches it.
     */
    private readonly users: UserRepository,
    private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.idleTtlMs = config.get('SESSION_IDLE_TTL_MS', { infer: true });
    this.absoluteTtlMs = config.get('SESSION_ABSOLUTE_TTL_MS', { infer: true });
  }

  /**
   * Open a new session for a user who has just proved their password.
   *
   * This is the only path that computes a fresh ceiling. Every later step inherits it, which is what
   * makes the 30-day cap a cap rather than a suggestion.
   */
  async issue(userId: string, device: DeviceContext): Promise<IssuedRefreshToken> {
    const now = this.clock.now();
    const token = mintToken();
    const absoluteExpiresAt = absoluteExpiryFor(now, this.absoluteTtlMs);
    const expiresAt = nextIdleExpiry(now, this.idleTtlMs, absoluteExpiresAt);

    await this.sessions.create({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      absoluteExpiresAt,
      now,
      device,
    });

    /*
     * Bounded, index-driven, and on a path that is already writing — which is why no scheduled job
     * exists for it (ADR-014).
     *
     * The grace period is one whole idle window, not zero. Reuse detection reads *revoked* rows, so
     * sweeping them promptly would blind it during exactly the window an attacker would use. A row
     * this old would be refused on expiry alone, so keeping it costs nothing.
     */
    await this.sessions.purgeExpiredForUser(userId, new Date(now.getTime() - this.idleTtlMs));

    return { token, expiresAt };
  }

  /**
   * Exchange a presented refresh token for its successor.
   *
   * **Reuse detection lives here, and it is the reason rotation retains revoked rows.** A digest
   * that matches nothing is an unknown token — forged, mangled, or purged — and means only that this
   * caller is not signed in. A digest that matches a *revoked* row is different in kind: that token
   * was real, it was already spent, and something still holds a copy. The honest reading is that it
   * leaked, so every session the account has is revoked, not just the chain that was replayed.
   *
   * The accepted cost is that "the chain" and "the account" are the same thing here — there is no
   * family column — so a detected replay signs the user out of their legitimate devices too. On a
   * genuine theft that is the outcome you want. The known false positive is a *lost refresh
   * response*: the client retries with a token the server already rotated away. The client's
   * single-flight lock removes the concurrent case; the lost-response case is accepted and watched
   * (ADR-008 rev. 3, revisit-when).
   */
  async rotate(
    presented: string,
    device: DeviceContext,
  ): Promise<RefreshSuccess | RefreshRejection> {
    const now = this.clock.now();
    const existing = await this.sessions.findByTokenHash(hashToken(presented));

    if (!existing) return { ok: false, reason: 'unknown' };

    if (!isUsable(existing, now)) {
      /*
       * A revoked row is a REPLAY, and it is recorded as a security event, not just acted on.
       * `recordRefreshReuse` revokes every session and appends the `security.refresh_reuse_detected`
       * audit row in one transaction, so the sign-out and the record of why it happened commit
       * together — an operator seeing an account signed out everywhere can find the reason, which
       * before this was visible only in an ephemeral log line.
       *
       * Expiry takes the other branch and writes nothing: a token that simply aged out is not an
       * event, and auditing it would bury the replays under the ordinary ones.
       */
      if (existing.revokedAt !== null) {
        await this.users.recordRefreshReuse(existing.userId, {
          requestId: device.requestId ?? null,
          ip: device.ip,
          userAgent: device.userAgent,
          now,
        });
      }
      return { ok: false, reason: 'unusable' };
    }

    const token = mintToken();
    // Inherited, never recomputed. Recomputing here is the one-line change that would silently
    // repeal the 30-day ceiling.
    const expiresAt = nextIdleExpiry(now, this.idleTtlMs, existing.absoluteExpiresAt);

    await this.sessions.rotate({
      previousId: existing.id,
      userId: existing.userId,
      tokenHash: hashToken(token),
      expiresAt,
      absoluteExpiresAt: existing.absoluteExpiresAt,
      now,
      device,
    });

    return { ok: true, userId: existing.userId, session: { token, expiresAt } };
  }

  /**
   * End the session a presented token names. Logout.
   *
   * Silent about whether anything matched: the endpoint answers 204 either way, so an
   * unauthenticated caller cannot use it to discover which tokens are live.
   */
  async revoke(presented: string): Promise<void> {
    const existing = await this.sessions.findByTokenHash(hashToken(presented));
    if (!existing) return;
    await this.sessions.revokeById(existing.id, this.clock.now());
  }

  /**
   * Sign an account out everywhere — a password change.
   *
   * Revokes *every* session including the caller's, rather than trying to spare it. The caller stays
   * signed in because `AuthService` immediately opens a fresh one, which is both simpler than an
   * exclusion and safe in the better direction: the worst outcome of a mistake here is one extra
   * sign-in, where the worst outcome of a mistaken exclusion is a session that survived a password
   * change.
   */
  async revokeAll(userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId, this.clock.now());
  }
}

/** 32 CSPRNG bytes, base64url so the value is cookie-safe without escaping. */
function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * What actually goes in the database. SHA-256 rather than Argon2 on purpose: the input is 256 bits
 * of uniform randomness, so there is no dictionary to slow an attacker down through — the stretching
 * that a password needs would buy nothing here and cost every request.
 */
function hashToken(token: string): Uint8Array<ArrayBuffer> {
  // Copied into a plain Uint8Array rather than handed over as a Buffer: Prisma types a `Bytes`
  // column as Uint8Array<ArrayBuffer>, and Buffer's backing store is only ArrayBufferLike.
  return new Uint8Array(createHash('sha256').update(token).digest());
}
