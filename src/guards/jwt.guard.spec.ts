import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException, type ProblemDetail } from '../common/errors/problem.exception';
import type { AuthenticatedRequest } from '../common/types/authenticated-request';
import type { UserRecord } from '../common/types/user.types';
import type { Env } from '../config/env.schema';
import type { UserRepository } from '../repositories/user.repository';
import { AccessTokenService } from '../services/access-token.service';
import { JwtGuard } from './jwt.guard';

/*
 * The guard is the whole authorization boundary, so it is tested from the outside: a request
 * with a header goes in, and either an authenticated request or one indistinguishable refusal
 * comes out.
 *
 * The token service is the real one over a throwaway key. Faking it would let these tests assert
 * that the guard asked something, where the real one asserts that a genuinely forged, foreign or
 * stale token does not get through.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z');
const MINUTE = 60_000;

const SIGNING_KEY = 'test-signing-key-that-is-long-enough-to-be-valid';
const FOREIGN_KEY = 'another-services-signing-key-of-sufficient-length';

const ENV = {
  JWT_ACCESS_TTL_MS: 15 * MINUTE,
  JWT_ISSUER: 'evergrove',
  JWT_AUDIENCE: 'evergrove-web',
} as const;

/**
 * The one answer every authentication failure gets.
 *
 * Written out here rather than imported from the production helper: comparing the guard's output
 * against the very function that produced it would pass no matter what either said.
 */
const NOT_AUTHENTICATED = {
  status: 401,
  title: 'Not authenticated',
  detail: 'Sign in to continue.',
};

function makeTokens(secret: string): AccessTokenService {
  const config = { get: (key: keyof typeof ENV) => ENV[key] } as unknown as ConfigService<
    Env,
    true
  >;
  return new AccessTokenService(new JwtService({ secret }), config);
}

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    email: 'ada@evergrove.app',
    username: 'Ada_L',
    usernameLower: 'ada_l',
    firstName: 'Ada',
    lastName: 'Lovelace',
    passwordHash: 'hashed:correct horse battery staple',
    timezone: 'Europe/London',
    emailVerifiedAt: null,
    passwordChangedAt: NOW,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** A bare request. `auth` is absent until the guard puts it there, which is what gets asserted. */
function requestWith(authorization?: string): AuthenticatedRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as AuthenticatedRequest;
}

function contextFor(request: AuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JwtGuard', () => {
  let stored: UserRecord | null;
  let users: UserRepository;
  let tokens: AccessTokenService;
  let guard: JwtGuard;

  beforeEach(() => {
    // Frozen so "expired" is something a test can state rather than wait for.
    vi.useFakeTimers({ now: NOW });

    stored = makeUser();
    users = {
      findById: vi.fn((id: string) => Promise.resolve(stored && stored.id === id ? stored : null)),
    } as unknown as UserRepository;

    tokens = makeTokens(SIGNING_KEY);
    guard = new JwtGuard(tokens, users);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('an accepted token', () => {
    it('authenticates the request as the subject the token names', async () => {
      const { token } = await tokens.issue('user-1');
      const request = requestWith(`Bearer ${token}`);

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

      expect(request.auth.userId).toBe('user-1');
    });

    it('answers with the profile the database holds now, not the one the token was minted under', async () => {
      const { token } = await tokens.issue('user-1');
      // The account is renamed and verified after that token was signed.
      stored = makeUser({ username: 'Ada_Renamed', emailVerifiedAt: NOW });

      const request = requestWith(`Bearer ${token}`);
      await guard.canActivate(contextFor(request));

      // Exact equality: the profile is the repository's row projected, with no credential
      // material and nothing carried over from the token.
      expect(request.auth.profile).toEqual({
        id: 'user-1',
        email: 'ada@evergrove.app',
        username: 'Ada_Renamed',
        firstName: 'Ada',
        lastName: 'Lovelace',
        timezone: 'Europe/London',
        emailVerified: true,
        createdAt: NOW.toISOString(),
      });
    });

    it('accepts a lowercase bearer scheme', async () => {
      // RFC 7235 makes the scheme case-insensitive; a client sending `bearer` is not an attack.
      const { token } = await tokens.issue('user-1');
      const request = requestWith(`bearer ${token}`);

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    });
  });

  describe('a refused request', () => {
    it('answers every kind of failure with one indistinguishable problem', async () => {
      const expired = (await tokens.issue('user-1')).token;
      vi.setSystemTime(new Date(NOW.getTime() + 16 * MINUTE));

      // Issued after the jump, so these are live while `expired` is not.
      const valid = (await tokens.issue('user-1')).token;
      const foreign = (await makeTokens(FOREIGN_KEY).issue('user-1')).token;

      const scenarios: ReadonlyArray<{
        why: string;
        header?: string;
        subjectExists?: boolean;
      }> = [
        { why: 'no Authorization header', header: undefined },
        { why: 'an empty Authorization header', header: '' },
        { why: 'a scheme with no credential', header: 'Bearer' },
        { why: 'a credential with no scheme', header: valid },
        { why: 'the wrong scheme', header: `Basic ${valid}` },
        { why: 'more than one credential', header: `Bearer ${valid} ${foreign}` },
        { why: 'a signature from a foreign key', header: `Bearer ${foreign}` },
        { why: 'a token past its expiry', header: `Bearer ${expired}` },
        { why: 'structural garbage', header: 'Bearer not.a.jwt' },
        {
          why: 'a subject that no longer resolves to a user',
          header: `Bearer ${valid}`,
          subjectExists: false,
        },
      ];

      const problems: ProblemDetail[] = [];

      for (const scenario of scenarios) {
        stored = scenario.subjectExists === false ? null : makeUser();
        const request = requestWith(scenario.header);

        const caught: unknown = await guard.canActivate(contextFor(request)).then(
          () => null,
          (error: unknown) => error,
        );

        expect(caught, scenario.why).toBeInstanceOf(ProblemException);
        // A refused request must not be half-authenticated on its way out.
        expect(request.auth, scenario.why).toBeUndefined();
        problems.push((caught as ProblemException).problem);
      }

      expect(problems).toHaveLength(scenarios.length);
      // The point of the guard: an attacker probing it cannot tell "your token expired" from
      // "no such user", because those are different sentences and the difference is the leak.
      expect(new Set(problems.map((problem) => JSON.stringify(problem))).size).toBe(1);
      expect(problems[0]).toEqual(NOT_AUTHENTICATED);
      // No field errors either — naming a field would reconstruct the distinction.
      expect(problems[0].errors).toBeUndefined();
    });
  });
});
