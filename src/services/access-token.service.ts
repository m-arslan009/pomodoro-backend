import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../config/env.schema';

/*
 * The signing and verification of access tokens, and the only place either happens.
 *
 * An access token is the *entire* credential: there is no refresh token, no session row and no
 * revocation, so whoever holds one is the user it names until it expires. Three properties
 * follow from that, and each is enforced here rather than left to a caller:
 *
 *  1. the algorithm is pinned on *verification*, not just on signing. A verifier that accepts
 *     whatever `alg` the token declares can be handed `alg: none`, or an HMAC token signed with
 *     a public key it published — the classic JWT confusion attacks;
 *  2. issuer and audience are checked, so a token minted by a sibling service, or for a
 *     different client of this one, is refused even though its signature is perfectly valid;
 *  3. the payload carries identity only — a user id, nothing else. Profile fields in a token are
 *     a cache that cannot be invalidated: rename an account and every live token keeps asserting
 *     the old name for the rest of its lifetime.
 */

/** What a verified token asserts. Mirrors the `sub` claim, named for how it is used. */
export interface AccessTokenClaims {
  readonly userId: string;
}

export interface IssuedAccessToken {
  readonly token: string;
  /** Milliseconds of validity, so the client knows when it will have to sign in again. */
  readonly expiresInMs: number;
}

/** The claim set as it appears on the wire. `iat`/`exp`/`iss`/`aud` are added by the signer. */
interface AccessTokenPayload {
  readonly sub?: unknown;
}

const ALGORITHM = 'HS256';

@Injectable()
export class AccessTokenService {
  private readonly ttlMs: number;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('JWT_ACCESS_TTL_MS', { infer: true });
    this.issuer = config.get('JWT_ISSUER', { infer: true });
    this.audience = config.get('JWT_AUDIENCE', { infer: true });
  }

  /** How long an issued token lives, so callers report a lifetime they did not invent. */
  get lifetimeMs(): number {
    return this.ttlMs;
  }

  /** Mint a token for one user. It is valid until `exp`, and nothing can cut that short. */
  async issue(userId: string): Promise<IssuedAccessToken> {
    const token = await this.jwt.signAsync(
      { sub: userId },
      {
        algorithm: ALGORITHM,
        // Expressed with the unit attached: a bare number means *seconds* to the underlying
        // signer, which would silently turn a 900000 ms window into a 10-day one.
        expiresIn: `${this.ttlMs}ms`,
        issuer: this.issuer,
        audience: this.audience,
      },
    );

    return { token, expiresInMs: this.ttlMs };
  }

  /**
   * Verify a presented token, or report that it is unusable.
   *
   * Every rejection — bad signature, expired, wrong issuer, wrong audience, malformed, missing
   * claims — collapses into the same `null`. A caller therefore has no failure detail available
   * to leak back to the client even by accident, and no way to accidentally treat one class of
   * invalid token as more acceptable than another.
   */
  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        algorithms: [ALGORITHM],
        issuer: this.issuer,
        audience: this.audience,
      });

      // A signature proves the token is ours, not that it is well-formed; a token missing the
      // claim we depend on is refused rather than defaulted.
      if (typeof payload.sub !== 'string') return null;

      return { userId: payload.sub };
    } catch {
      return null;
    }
  }
}
