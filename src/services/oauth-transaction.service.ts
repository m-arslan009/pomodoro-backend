import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { OAuthTransaction } from '../common/types/oauth.types';
import type { Env } from '../config/env.schema';

/*
 * The `evergrove_oauth` cookie's contents: signed on the way out, verified on the way back.
 *
 * This is state that has to survive a round trip through Google and come back trustworthy. A table
 * would need a row for every *attempted* sign-in — including the ones abandoned at the consent
 * screen — plus a sweep to clear them, which is the scheduled job ADR-014 argues against. Signing
 * the values into a short-lived cookie stores nothing and expires by itself.
 *
 * Signing rather than merely setting is what makes the `state` comparison mean something. An
 * unsigned cookie is one the attacker's own browser can also write, so matching it against the
 * `state` they chose proves nothing; a signature the client cannot produce turns the comparison into
 * a genuine double-submit defence.
 */

const ALGORITHM = 'HS256';

/**
 * A separate audience from the access token, sharing the same signing key.
 *
 * Without it the two token types are interchangeable to the verifier: a transaction cookie would
 * satisfy `JwtGuard` if it carried a `sub`, and an access token would satisfy this service. Pinning
 * `audience` on both sides makes each verifier reject the other's tokens despite a valid signature —
 * the same reasoning `AccessTokenService` gives for checking issuer and audience at all.
 */
const TRANSACTION_AUDIENCE = 'evergrove-oauth-txn';

/** The claim set as it appears on the wire. `iat`/`exp`/`iss`/`aud` are added by the signer. */
interface TransactionPayload {
  readonly state?: unknown;
  readonly nonce?: unknown;
  readonly codeVerifier?: unknown;
  readonly returnTo?: unknown;
  readonly timezone?: unknown;
}

@Injectable()
export class OAuthTransactionService {
  private readonly ttlMs: number;
  private readonly issuer: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('OAUTH_TXN_TTL_MS', { infer: true });
    this.issuer = config.get('JWT_ISSUER', { infer: true });
  }

  /** How long the cookie lives, so the controller sets an expiry it did not invent. */
  get lifetimeMs(): number {
    return this.ttlMs;
  }

  async issue(transaction: OAuthTransaction): Promise<string> {
    return this.jwt.signAsync(
      {
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
        returnTo: transaction.returnTo,
        timezone: transaction.timezone,
      },
      {
        algorithm: ALGORITHM,
        // The unit is attached deliberately: a bare number means *seconds* to the signer, which
        // would turn a 600000 ms window into a seven-day one.
        expiresIn: `${this.ttlMs}ms`,
        issuer: this.issuer,
        audience: TRANSACTION_AUDIENCE,
      },
    );
  }

  /**
   * Verify a presented transaction cookie.
   *
   * Every rejection — expired, forged, wrong audience, missing claims, malformed — collapses into
   * the same `null`, and the caller turns all of them into one `invalid_request` redirect. A caller
   * with no failure detail cannot leak one, and cannot come to treat one class of bad cookie as
   * more acceptable than another.
   */
  async verify(token: string): Promise<OAuthTransaction | null> {
    try {
      const payload = await this.jwt.verifyAsync<TransactionPayload>(token, {
        algorithms: [ALGORITHM],
        issuer: this.issuer,
        audience: TRANSACTION_AUDIENCE,
      });

      if (
        typeof payload.state !== 'string' ||
        typeof payload.nonce !== 'string' ||
        typeof payload.codeVerifier !== 'string' ||
        typeof payload.returnTo !== 'string'
      ) {
        return null;
      }

      return {
        state: payload.state,
        nonce: payload.nonce,
        codeVerifier: payload.codeVerifier,
        returnTo: payload.returnTo,
        timezone: typeof payload.timezone === 'string' ? payload.timezone : null,
      };
    } catch {
      return null;
    }
  }
}
