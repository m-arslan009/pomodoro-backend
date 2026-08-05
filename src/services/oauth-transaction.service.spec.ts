import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OAuthTransaction } from '../common/types/oauth.types';
import type { Env } from '../config/env.schema';
import { AccessTokenService } from './access-token.service';
import { OAuthTransactionService } from './oauth-transaction.service';

/*
 * The `evergrove_oauth` cookie's contents.
 *
 * The real signer is used throughout — faking it would leave nothing under test, since the entire
 * responsibility of this service is that a value survives a round trip through a hostile browser and
 * comes back trustworthy.
 *
 * The tests that matter most are the two isolation ones at the end. This service and
 * `AccessTokenService` share `JWT_SECRET`, so a valid signature proves nothing about which kind of
 * token is being held; only the pinned `audience` keeps a transaction cookie from satisfying
 * `JwtGuard` and an access token from satisfying this.
 */

const SIGNING_KEY = 'test-signing-key-that-is-long-enough-to-be-valid';

const ENV = {
  OAUTH_TXN_TTL_MS: 600_000,
  JWT_ISSUER: 'evergrove',
  JWT_AUDIENCE: 'evergrove-web',
  JWT_ACCESS_TTL_MS: 900_000,
} as const;

const TRANSACTION: OAuthTransaction = {
  state: 'state-value',
  nonce: 'nonce-value',
  codeVerifier: 'verifier-value',
  returnTo: '/history',
  timezone: 'Europe/London',
};

describe('OAuthTransactionService', () => {
  let jwt: JwtService;
  let service: OAuthTransactionService;
  let accessTokens: AccessTokenService;

  beforeEach(() => {
    jwt = new JwtService({ secret: SIGNING_KEY });
    const config = { get: (key: keyof typeof ENV) => ENV[key] } as unknown as ConfigService<
      Env,
      true
    >;

    service = new OAuthTransactionService(jwt, config);
    accessTokens = new AccessTokenService(jwt, config);
  });

  it('returns the transaction it was given, unchanged', async () => {
    const token = await service.issue(TRANSACTION);

    await expect(service.verify(token)).resolves.toEqual(TRANSACTION);
  });

  it('carries an absent timezone through as absent', async () => {
    const token = await service.issue({ ...TRANSACTION, timezone: null });

    await expect(service.verify(token)).resolves.toMatchObject({ timezone: null });
  });

  it('reports the configured lifetime so the cookie does not restate it', () => {
    // Two places holding the same duration is two places that can drift, and the failure would be
    // a cookie the browser drops while the token inside it is still valid.
    expect(service.lifetimeMs).toBe(600_000);
  });

  it('refuses a token signed with a different key', async () => {
    const forged = await new JwtService({
      secret: 'a-different-key-of-sufficient-length!!',
    }).signAsync(
      { ...TRANSACTION },
      { algorithm: 'HS256', issuer: ENV.JWT_ISSUER, audience: 'evergrove-oauth-txn' },
    );

    /*
     * This is the property that makes the `state` comparison worth doing. An *unsigned* cookie is
     * one the attacker's own browser can also write, so matching it against a `state` they chose
     * proves nothing; a signature they cannot produce turns it into a real double-submit defence.
     */
    await expect(service.verify(forged)).resolves.toBeNull();
  });

  it('refuses a token whose payload was edited', async () => {
    const token = await service.issue(TRANSACTION);
    const [header, payload, signature] = token.split('.');

    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    edited.state = 'the-attackers-state';

    const tampered = [
      header,
      Buffer.from(JSON.stringify(edited)).toString('base64url'),
      signature,
    ].join('.');

    await expect(service.verify(tampered)).resolves.toBeNull();
  });

  it('refuses an expired transaction', async () => {
    const expired = await jwt.signAsync(
      { ...TRANSACTION },
      {
        algorithm: 'HS256',
        expiresIn: '-1s',
        issuer: ENV.JWT_ISSUER,
        audience: 'evergrove-oauth-txn',
      },
    );

    // The ten-minute window is what bounds how long a captured `state` stays worth anything.
    await expect(service.verify(expired)).resolves.toBeNull();
  });

  it('refuses a token missing any claim the flow depends on', async () => {
    for (const missing of ['state', 'nonce', 'codeVerifier', 'returnTo']) {
      const claims: Record<string, unknown> = { ...TRANSACTION };
      delete claims[missing];

      const token = await jwt.signAsync(claims, {
        algorithm: 'HS256',
        expiresIn: '10m',
        issuer: ENV.JWT_ISSUER,
        audience: 'evergrove-oauth-txn',
      });

      // A signature proves the token is ours, not that it is well-formed.
      await expect(service.verify(token)).resolves.toBeNull();
    }
  });

  it('refuses garbage without throwing', async () => {
    await expect(service.verify('not-a-token')).resolves.toBeNull();
    await expect(service.verify('')).resolves.toBeNull();
  });

  it('does not accept an access token as a transaction', async () => {
    const issued = await accessTokens.issue('user-1');

    // Same key, same algorithm, valid signature — and still refused, because the audience differs.
    await expect(service.verify(issued.token)).resolves.toBeNull();
  });

  it('is not accepted as an access token by the guard path', async () => {
    const token = await service.issue(TRANSACTION);

    // The other direction of the same isolation. Without it, a ten-minute cookie holding a
    // `codeVerifier` would authenticate API requests if it happened to carry a `sub`.
    await expect(accessTokens.verify(token)).resolves.toBeNull();
  });
});
