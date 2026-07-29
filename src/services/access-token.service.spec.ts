import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema';
import { AccessTokenService } from './access-token.service';

/*
 * The access token is the one credential here with no server-side record behind it: whoever
 * holds it is the user it names until it expires. Two things follow, and both are tested — what
 * a token is allowed to say, and every reason to refuse one.
 *
 * The service is built over a real JwtService with a throwaway key rather than a stubbed signer.
 * A stub would only prove the service called something; the real signer lets these tests read
 * what actually travels on the wire, which is the only thing an attacker ever sees.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z');
const MINUTE = 60_000;

/** Test-only keys. Long enough to satisfy the same rule the environment schema enforces. */
const SIGNING_KEY = 'test-signing-key-that-is-long-enough-to-be-valid';
const FOREIGN_KEY = 'another-services-signing-key-of-sufficient-length';

interface TokenEnv {
  JWT_ACCESS_TTL_MS: number;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
}

const ENV: TokenEnv = {
  JWT_ACCESS_TTL_MS: 15 * MINUTE,
  JWT_ISSUER: 'evergrove',
  JWT_AUDIENCE: 'evergrove-web',
};

function makeService(secret: string, overrides: Partial<TokenEnv> = {}): AccessTokenService {
  const env = { ...ENV, ...overrides };
  const config = {
    get: (key: keyof typeof env) => env[key],
  } as unknown as ConfigService<Env, true>;

  return new AccessTokenService(new JwtService({ secret }), config);
}

/** One segment of a token, decoded and deliberately *not* verified. */
function decodeSegment(token: string, index: number): Record<string, unknown> {
  const segment = token.split('.')[index] ?? '';
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const decodeHeader = (token: string) => decodeSegment(token, 0);
const decodeClaims = (token: string) => decodeSegment(token, 1);

/** A perfectly well-formed claim set with no signature at all — the classic `alg: none` attack. */
function unsignedToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

describe('AccessTokenService', () => {
  const tokens = makeService(SIGNING_KEY);

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('issue', () => {
    it('signs exactly the contracted claim set and nothing else', async () => {
      const { token } = await tokens.issue('user-1');
      const claims = decodeClaims(token);

      // Anything beyond these five is a cache that cannot be invalidated: rename an account and
      // every live token would keep asserting the old name until it expired.
      expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub']);
      expect(claims).toMatchObject({
        sub: 'user-1',
        iss: 'evergrove',
        aud: 'evergrove-web',
      });
    });

    it('pins the algorithm and reports the lifetime it actually signed', async () => {
      const issued = await tokens.issue('user-1');
      const claims = decodeClaims(issued.token);

      expect(decodeHeader(issued.token).alg).toBe('HS256');
      expect(issued.expiresInMs).toBe(15 * MINUTE);
      // Milliseconds at the boundary, seconds on the wire: a bare 900000 handed to the signer
      // would silently become a ten-day window.
      expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
    });
  });

  describe('verify', () => {
    it('round-trips a token it issued', async () => {
      const { token } = await tokens.issue('user-1');

      await expect(tokens.verify(token)).resolves.toEqual({ userId: 'user-1' });
    });

    it('refuses a token signed with a foreign key', async () => {
      const { token } = await makeService(FOREIGN_KEY).issue('user-1');

      await expect(tokens.verify(token)).resolves.toBeNull();
    });

    it('refuses a token minted by another issuer', async () => {
      const other = makeService(SIGNING_KEY, { JWT_ISSUER: 'evergrove-staging' });
      const { token } = await other.issue('user-1');

      // Same key, flawless signature: a sibling deployment that shares a secret still must not
      // be able to speak for this one.
      await expect(tokens.verify(token)).resolves.toBeNull();
    });

    it('refuses a token minted for another audience', async () => {
      const other = makeService(SIGNING_KEY, { JWT_AUDIENCE: 'evergrove-admin' });
      const { token } = await other.issue('user-1');

      await expect(tokens.verify(token)).resolves.toBeNull();
    });

    it('refuses a token once its lifetime has run out', async () => {
      vi.useFakeTimers({ now: NOW });
      const { token } = await tokens.issue('user-1');
      await expect(tokens.verify(token)).resolves.not.toBeNull();

      // Expiry is the only thing that ever ends this credential, so it has to actually bite.
      vi.setSystemTime(new Date(NOW.getTime() + 15 * MINUTE + 1000));

      await expect(tokens.verify(token)).resolves.toBeNull();
    });

    it('refuses an unsigned forgery of an otherwise valid claim set', async () => {
      vi.useFakeTimers({ now: NOW });
      const issuedAt = Math.floor(NOW.getTime() / 1000);
      const forged = unsignedToken({
        sub: 'user-1',
        iss: 'evergrove',
        aud: 'evergrove-web',
        iat: issuedAt,
        exp: issuedAt + 900,
      });

      // Every claim is correct and the token is live; only the signature is missing. A verifier
      // that trusted the token's own `alg` header would accept this.
      await expect(tokens.verify(forged)).resolves.toBeNull();
    });

    it('refuses structurally garbage input instead of throwing', async () => {
      const garbage = ['', '   ', 'not-a-token', 'a.b', 'a.b.c', 'e30.e30.', '{"sub":"user-1"}'];

      const results = await Promise.all(garbage.map((value) => tokens.verify(value)));

      // A thrown error would hand the caller something to branch on, and a branch is a leak.
      expect(results).toEqual(garbage.map(() => null));
    });

    it('refuses a validly signed token of its own that names no subject', async () => {
      const signer = new JwtService({ secret: SIGNING_KEY });
      const token = await signer.signAsync(
        { role: 'admin' },
        {
          algorithm: 'HS256',
          issuer: ENV.JWT_ISSUER,
          audience: ENV.JWT_AUDIENCE,
          expiresIn: '15m',
        },
      );

      // A signature proves where a token came from, not that it carries what the guard depends
      // on. `sub` is the entire identity assertion, so its absence is refused rather than
      // defaulted to something harmless-looking like an empty string.
      await expect(tokens.verify(token)).resolves.toBeNull();
    });
  });
});
