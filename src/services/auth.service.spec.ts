import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../common/errors/problem.exception';
import type { Clock } from '../common/ports/clock.port';
import { PasswordHasher } from '../common/ports/password-hasher.port';
import type { AuthContext, UserRecord } from '../common/types/user.types';
import type { Env } from '../config/env.schema';
import type { CreateUserInput, UserRepository } from '../repositories/user.repository';
import { AccessTokenService } from './access-token.service';
import { AuthService } from './auth.service';

/*
 * The service is exercised against fakes rather than mocks with expectations: what matters is
 * the observable outcome of each flow, not the call sequence used to reach it.
 *
 * The access-token service is the real one, signing with a throwaway key. Stubbing it would
 * assert that AuthService called something, where the real one asserts that what comes back is a
 * token — and a signer is fast enough that there is no reason to fake it.
 */

const NOW = new Date('2026-07-28T09:00:00.000Z');
const HOUR = 3_600_000;

/** Test-only key. Long enough to satisfy the same rule the environment schema enforces. */
const SIGNING_KEY = 'test-signing-key-that-is-long-enough-to-be-valid';

const ENV = {
  JWT_ACCESS_TTL_MS: 8 * HOUR,
  JWT_ISSUER: 'evergrove',
  JWT_AUDIENCE: 'evergrove-web',
} as const;

/** The claims a signed access token carries, read without verifying it. */
function claimsOf(accessToken: string): Record<string, unknown> {
  const segment = accessToken.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

class FakeHasher extends PasswordHasher {
  dummyVerifications = 0;
  verifications = 0;

  hash(plain: string): Promise<string> {
    return Promise.resolve(`hashed:${plain}`);
  }

  verify(hashed: string, plain: string): Promise<boolean> {
    this.verifications += 1;
    return Promise.resolve(hashed === `hashed:${plain}`);
  }

  verifyDummy(): Promise<void> {
    this.dummyVerifications += 1;
    return Promise.resolve();
  }

  needsRehash(hashed: string): boolean {
    return hashed.startsWith('legacy:');
  }
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
    avatarUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('AuthService', () => {
  let hasher: FakeHasher;
  let createdUsers: CreateUserInput[];
  let users: UserRepository;
  let service: AuthService;
  let conflicts: Array<'email' | 'username'>;
  let stored: UserRecord | null;

  beforeEach(() => {
    hasher = new FakeHasher();
    createdUsers = [];
    conflicts = [];
    stored = makeUser();

    users = {
      findById: vi.fn(() => Promise.resolve(stored)),
      findByEmail: vi.fn((email: string) =>
        Promise.resolve(stored && stored.email === email ? stored : null),
      ),
      findByUsernameKey: vi.fn((key: string) =>
        Promise.resolve(stored && stored.usernameLower === key ? stored : null),
      ),
      create: vi.fn((input: CreateUserInput) => {
        createdUsers.push(input);
        return Promise.resolve(
          conflicts.length > 0
            ? { ok: false as const, conflicts }
            : { ok: true as const, user: makeUser(input) },
        );
      }),
      updatePassword: vi.fn(() => Promise.resolve()),
      updatePasswordHashOnly: vi.fn(() => Promise.resolve()),
      markLogin: vi.fn(() => Promise.resolve()),
    } as unknown as UserRepository;

    const clock: Clock = { now: () => NOW };
    const config = {
      get: (key: keyof typeof ENV) => ENV[key],
    } as unknown as ConfigService<Env, true>;

    const accessTokens = new AccessTokenService(new JwtService({ secret: SIGNING_KEY }), config);

    service = new AuthService(users, hasher, clock, accessTokens);
  });

  describe('login', () => {
    const CREDENTIALS = {
      identifier: 'ada@evergrove.app',
      password: 'correct horse battery staple',
    };

    it('accepts an email identifier', async () => {
      const result = await service.login(CREDENTIALS);

      expect(result.profile.username).toBe('Ada_L');
      expect(users.findByEmail).toHaveBeenCalledWith('ada@evergrove.app');
    });

    it('accepts a username identifier in any casing', async () => {
      const result = await service.login({ ...CREDENTIALS, identifier: 'ADA_L' });

      expect(result.profile.id).toBe('user-1');
      expect(users.findByUsernameKey).toHaveBeenCalledWith('ada_l');
      expect(users.findByEmail).not.toHaveBeenCalled();
    });

    it('never returns the credential material in the profile', async () => {
      const result = await service.login(CREDENTIALS);

      expect(Object.values(result.profile)).not.toContain('hashed:correct horse battery staple');
      expect(result.profile).not.toHaveProperty('passwordHash');
    });

    it('answers with an access token that names the user and nothing else', async () => {
      const result = await service.login(CREDENTIALS);

      expect(result.accessTokenExpiresIn).toBe(8 * HOUR);

      const claims = claimsOf(result.accessToken);
      expect(claims.sub).toBe('user-1');
      // The token is the whole credential and it is readable by anyone holding it, so what it
      // carries is a security decision: identity and validity, never profile data.
      expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub']);
    });

    it('records the sign-in without persisting a session', async () => {
      await service.login(CREDENTIALS);

      // last_login_at is now the only trace a sign-in leaves; there is no row to write and
      // nothing for a later request to look up.
      expect(users.markLogin).toHaveBeenCalledWith('user-1', NOW);
    });

    it('gives an unknown account the same answer, and the same work, as a wrong password', async () => {
      stored = null;

      await expect(
        service.login({ identifier: 'nobody@evergrove.app', password: 'whatever-long-enough' }),
      ).rejects.toMatchObject({ problem: { status: 401, title: 'Invalid credentials' } });

      // The dummy verification is what keeps response *timing* from enumerating accounts.
      expect(hasher.dummyVerifications).toBe(1);
    });

    it('rejects a wrong password with the identical problem response', async () => {
      const error = await service
        .login({ ...CREDENTIALS, password: 'wrong but long enough' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProblemException);
      expect((error as ProblemException).problem).toMatchObject({
        status: 401,
        title: 'Invalid credentials',
      });
      // No field errors: naming the offending field would defeat the generic message.
      expect((error as ProblemException).problem.errors).toBeUndefined();
      expect(users.markLogin).not.toHaveBeenCalled();
    });

    it('upgrades an outdated hash on successful login', async () => {
      stored = makeUser({ passwordHash: 'legacy:correct horse battery staple' });
      hasher.verify = () => Promise.resolve(true);

      await service.login({ ...CREDENTIALS, password: 'a-valid-password' });

      expect(users.updatePasswordHashOnly).toHaveBeenCalledWith(
        'user-1',
        'hashed:a-valid-password',
      );
    });
  });

  describe('register', () => {
    const SIGNUP = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@evergrove.app',
      username: 'Ada_L',
      password: 'correct horse battery staple',
    };

    it('stores the display username alongside its lowercase uniqueness key', async () => {
      await service.register({ ...SIGNUP, timezone: 'Europe/London' });

      expect(createdUsers[0]).toMatchObject({ username: 'Ada_L', usernameLower: 'ada_l' });
    });

    it('defaults the timezone when the client could not determine one', async () => {
      await service.register({ ...SIGNUP, username: 'ada_l' });

      expect(createdUsers[0]?.timezone).toBe('UTC');
    });

    it('signs the new account in rather than making it log in again', async () => {
      const result = await service.register(SIGNUP);

      expect(result.accessToken).toBeTruthy();
      expect(result.accessTokenExpiresIn).toBe(8 * HOUR);
    });

    it('rejects a password containing the username before touching the database', async () => {
      await expect(
        service.register({ ...SIGNUP, username: 'ada_l', password: 'my ada_l password' }),
      ).rejects.toMatchObject({ problem: { status: 422 } });

      expect(users.create).not.toHaveBeenCalled();
    });

    it('reports a taken email or username as field errors', async () => {
      conflicts = ['email', 'username'];

      const error = (await service
        .register({ ...SIGNUP, username: 'ada_l' })
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(409);
      expect(error.problem.errors).toEqual([
        { field: 'email', message: 'An account with this email already exists.' },
        { field: 'username', message: 'That username is already taken.' },
      ]);
    });
  });

  describe('changePassword', () => {
    const auth: AuthContext = {
      userId: 'user-1',
      profile: {
        id: 'user-1',
        email: 'ada@evergrove.app',
        username: 'Ada_L',
        firstName: 'Ada',
        lastName: 'Lovelace',
        timezone: 'Europe/London',
        emailVerified: false,
        avatarUpdatedAt: null,
        createdAt: NOW.toISOString(),
      },
    };

    it('records the change and hands this device a fresh token', async () => {
      const result = await service.changePassword(auth, {
        currentPassword: 'correct horse battery staple',
        newPassword: 'an entirely different one',
      });

      expect(users.updatePassword).toHaveBeenCalledWith(
        'user-1',
        'hashed:an entirely different one',
        NOW,
      );
      // The caller stays signed in. Note what is *not* asserted: nothing revokes anything,
      // because there is nothing to revoke — tokens already issued to other devices go on
      // working until they expire. That is the accepted cost of a stateless design, and it is
      // stated here so the omission reads as a decision rather than an oversight.
      expect(result.accessToken).toBeTruthy();
    });

    it('rejects a wrong current password without changing anything', async () => {
      await expect(
        service.changePassword(auth, {
          currentPassword: 'not my password',
          newPassword: 'an entirely different one',
        }),
      ).rejects.toMatchObject({
        problem: {
          status: 422,
          errors: [{ field: 'currentPassword', message: 'That is not your current password.' }],
        },
      });

      expect(users.updatePassword).not.toHaveBeenCalled();
    });

    it('refuses to reuse the current password', async () => {
      await expect(
        service.changePassword(auth, {
          currentPassword: 'correct horse battery staple',
          newPassword: 'correct horse battery staple',
        }),
      ).rejects.toMatchObject({ problem: { status: 422 } });
    });

    it('refuses when the authenticated account no longer exists', async () => {
      stored = null;

      await expect(
        service.changePassword(auth, {
          currentPassword: 'correct horse battery staple',
          newPassword: 'an entirely different one',
        }),
      ).rejects.toMatchObject({ problem: { status: 401 } });
    });
  });
});
