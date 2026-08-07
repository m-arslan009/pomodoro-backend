import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException, type FieldError } from '../common/errors/problem.exception';
import type { Clock } from '../common/ports/clock.port';
import { PasswordHasher } from '../common/ports/password-hasher.port';
import type { AuthContext, UserRecord } from '../common/types/user.types';
import type { Env } from '../config/env.schema';
import type { AuthSessionRepository } from '../repositories/auth-session.repository';
import type { CreateUserInput, UserRepository } from '../repositories/user.repository';
import { AccessTokenService } from './access-token.service';
import { AuthService } from './auth.service';
import { RefreshTokenService } from './refresh-token.service';

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
  SESSION_IDLE_TTL_MS: 7 * 24 * HOUR,
  SESSION_ABSOLUTE_TTL_MS: 30 * 24 * HOUR,
} as const;

/** Every flow that opens a session records the device; nothing here asserts on it. */
const DEVICE = { userAgent: 'vitest', ip: '127.0.0.1' } as const;

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
    role: 'user',
    emailVerifiedAt: null,
    passwordChangedAt: NOW,
    lastLoginAt: null,
    avatarUpdatedAt: null,
    disabledAt: null,
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
  let authSessions: AuthSessionRepository;

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

    /*
     * An in-memory stand-in for auth_sessions. Rotation and reuse detection are RefreshTokenService's
     * rules and are covered where they live; what these tests need is only that opening a session
     * succeeds, so every AuthService flow can be exercised end to end.
     */
    authSessions = {
      create: vi.fn(() =>
        Promise.resolve({
          id: 'session-1',
          userId: 'user-1',
          expiresAt: new Date(NOW.getTime() + ENV.SESSION_IDLE_TTL_MS),
          absoluteExpiresAt: new Date(NOW.getTime() + ENV.SESSION_ABSOLUTE_TTL_MS),
          revokedAt: null,
        }),
      ),
      findByTokenHash: vi.fn(() => Promise.resolve(null)),
      rotate: vi.fn(),
      revokeById: vi.fn(() => Promise.resolve()),
      revokeAllForUser: vi.fn(() => Promise.resolve()),
      purgeExpiredForUser: vi.fn(() => Promise.resolve()),
    } as unknown as AuthSessionRepository;

    const refreshTokens = new RefreshTokenService(authSessions, users, clock, config);

    service = new AuthService(users, hasher, clock, accessTokens, refreshTokens);
  });

  describe('login', () => {
    const CREDENTIALS = {
      identifier: 'ada@evergrove.app',
      password: 'correct horse battery staple',
    };

    it('signs in with correct credentials and hands back the account, never its credential', async () => {
      const result = await service.login(CREDENTIALS, DEVICE);

      expect(users.findByEmail).toHaveBeenCalledWith('ada@evergrove.app');
      expect(result.profile.id).toBe('user-1');
      expect(result.profile.username).toBe('Ada_L');

      // The password was actually checked against the stored hash. A success that never reached
      // the hasher is a success that let anyone in.
      expect(hasher.verifications).toBe(1);

      // And the hash does not travel back out — asserted by value as well as by key, because a
      // profile that leaked it under some other name would still pass the property check.
      expect(result.profile).not.toHaveProperty('passwordHash');
      expect(Object.values(result.profile)).not.toContain('hashed:correct horse battery staple');
    });

    it('accepts a username identifier in any casing', async () => {
      const result = await service.login({ ...CREDENTIALS, identifier: 'ADA_L' }, DEVICE);

      expect(result.profile.id).toBe('user-1');
      expect(users.findByUsernameKey).toHaveBeenCalledWith('ada_l');
      expect(users.findByEmail).not.toHaveBeenCalled();
    });

    it('answers with an access token that names the user and nothing else', async () => {
      const result = await service.login(CREDENTIALS, DEVICE);

      expect(result.accessTokenExpiresIn).toBe(8 * HOUR);

      const claims = claimsOf(result.accessToken);
      expect(claims.sub).toBe('user-1');
      /*
       * The token is readable by anyone holding it, so what it carries is a security decision:
       * identity and validity, never profile data. Note the absence of `sid` — ADR-008 rev. 3
       * reinstated sessions but deliberately did not reinstate the claim, because the cookie is
       * the session's name and `logout` reads that instead.
       */
      expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub']);
    });

    it('records the sign-in and opens a refresh session the cookie can carry', async () => {
      const result = await service.login(CREDENTIALS, DEVICE);

      expect(authSessions.create).toHaveBeenCalledTimes(1);

      // Both traces, and they answer different questions: the session row is what a later refresh
      // looks up and what logout revokes, while last_login_at is the account-level fact that
      // survives the session being revoked, expiring, or purged.
      expect(users.markLogin).toHaveBeenCalledWith('user-1', NOW);

      /*
       * The other half of the contract (§4.9): a sign-in is not complete without the refresh
       * token bound for the `Set-Cookie`, and its lifetime is the session's idle window rather
       * than the access token's. A login that returned only an access token would leave the
       * client signed out fifteen minutes later with nothing to renew from.
       */
      expect(result.refresh.token).toBeTruthy();
      expect(result.refresh.expiresAt).toEqual(new Date(NOW.getTime() + ENV.SESSION_IDLE_TTL_MS));

      // What the row keeps is a digest. If the plaintext were stored, a database read would be
      // equivalent to holding every live session on the deployment.
      const [row] = vi.mocked(authSessions.create).mock.calls[0];
      expect(JSON.stringify(row)).not.toContain(result.refresh.token);
    });

    it('gives an unknown account the same answer, and the same work, as a wrong password', async () => {
      stored = null;

      await expect(
        service.login(
          { identifier: 'nobody@evergrove.app', password: 'whatever-long-enough' },
          DEVICE,
        ),
      ).rejects.toMatchObject({ problem: { status: 401, title: 'Invalid credentials' } });

      // The dummy verification is what keeps response *timing* from enumerating accounts.
      expect(hasher.dummyVerifications).toBe(1);
    });

    it('rejects a wrong password with the identical problem response', async () => {
      const error = await service
        .login({ ...CREDENTIALS, password: 'wrong but long enough' }, DEVICE)
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

    it('gives a provider-created account the same rejection, and the same work, as a wrong password', async () => {
      // Created through Google, so there is no password and no password can ever match (ADR-008a).
      stored = makeUser({ passwordHash: null });

      const error = (await service
        .login(CREDENTIALS, DEVICE)
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem).toMatchObject({ status: 401, title: 'Invalid credentials' });
      /*
       * Both halves matter. The identical response stops the login form answering "that account
       * signed up with Google", and the dummy verification stops response *timing* answering it
       * instead — skipping the Argon2 cost here would make this branch measurably faster and turn
       * the endpoint into an oracle for which accounts use a provider.
       */
      expect(hasher.dummyVerifications).toBe(1);
      expect(hasher.verifications).toBe(0);
      expect(users.markLogin).not.toHaveBeenCalled();
    });

    it('upgrades an outdated hash on successful login', async () => {
      stored = makeUser({ passwordHash: 'legacy:correct horse battery staple' });
      hasher.verify = () => Promise.resolve(true);

      await service.login({ ...CREDENTIALS, password: 'a-valid-password' }, DEVICE);

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

    it('persists the new account with its uniqueness key, a usable timezone, and a hashed password', async () => {
      await service.register(SIGNUP, DEVICE);

      expect(createdUsers).toHaveLength(1);
      expect(createdUsers[0]).toMatchObject({
        email: 'ada@evergrove.app',
        firstName: 'Ada',
        lastName: 'Lovelace',
        // Display casing is kept; the lowercase key beside it is what carries the UNIQUE index,
        // so uniqueness is case-insensitive without a citext column.
        username: 'Ada_L',
        usernameLower: 'ada_l',
        // Falls back rather than being left empty when the client could not determine one: every
        // instant stored for this account is later read through this column.
        timezone: 'UTC',
      });

      /*
       * The security requirement of the whole flow: what reaches the database is a hash, and the
       * password the user typed exists nowhere in the row. Asserted as a negative *and* a
       * positive — the negative is what a regression would trip, the positive pins that the value
       * came from the hasher rather than from some other transform of the plaintext.
       */
      expect(createdUsers[0]?.passwordHash).not.toBe(SIGNUP.password);
      expect(createdUsers[0]?.passwordHash).toBe('hashed:correct horse battery staple');
    });

    it('signs the new account in rather than making it log in again', async () => {
      const result = await service.register(SIGNUP, DEVICE);

      // Registration ends at the same startSession() as a sign-in, so it answers with both
      // credentials: the access token the client attaches to its next request...
      expect(claimsOf(result.accessToken).sub).toBe(result.profile.id);
      expect(result.accessTokenExpiresIn).toBe(8 * HOUR);

      // ...and the refresh token bound for the HttpOnly cookie, with a session row behind it.
      // Without this half, a user who just signed up is silently ejected when the access token
      // expires and has to type the credential they only just chose.
      expect(authSessions.create).toHaveBeenCalledTimes(1);
      expect(result.refresh.token).toBeTruthy();
      expect(result.refresh.expiresAt).toEqual(new Date(NOW.getTime() + ENV.SESSION_IDLE_TTL_MS));
    });

    it('rejects a password containing the username before touching the database', async () => {
      await expect(
        service.register({ ...SIGNUP, username: 'ada_l', password: 'my ada_l password' }, DEVICE),
      ).rejects.toMatchObject({ problem: { status: 422 } });

      expect(users.create).not.toHaveBeenCalled();
    });

    /*
     * The three ways an otherwise valid registration is refused. Each is reported by the *database*
     * — the repository surfaces the unique-constraint violation — rather than by a pre-check, which
     * is what makes it correct under two simultaneous sign-ups for the same handle.
     */
    const takenCases: ReadonlyArray<[string, ReadonlyArray<'email' | 'username'>, FieldError[]]> = [
      [
        'an email that is already registered',
        ['email'],
        [{ field: 'email', message: 'An account with this email already exists.' }],
      ],
      [
        'a username that is already taken',
        ['username'],
        [{ field: 'username', message: 'That username is already taken.' }],
      ],
      [
        'both at once, in a single response',
        ['email', 'username'],
        [
          { field: 'email', message: 'An account with this email already exists.' },
          { field: 'username', message: 'That username is already taken.' },
        ],
      ],
    ];

    it.each(takenCases)('refuses %s', async (_case, taken, expected) => {
      conflicts = [...taken];

      const error = (await service
        .register(SIGNUP, DEVICE)
        .catch((caught: unknown) => caught)) as ProblemException;

      expect(error.problem.status).toBe(409);
      expect(error.problem.errors).toEqual(expected);
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
        role: 'user',
        emailVerified: false,
        avatarUpdatedAt: null,
        createdAt: NOW.toISOString(),
      },
    };

    it('records the change and hands this device a fresh token', async () => {
      const result = await service.changePassword(
        auth,
        {
          currentPassword: 'correct horse battery staple',
          newPassword: 'an entirely different one',
        },
        DEVICE,
      );

      expect(users.updatePassword).toHaveBeenCalledWith(
        'user-1',
        'hashed:an entirely different one',
        NOW,
      );
      /*
       * Every other device is signed out, and the caller is not (ADR-008 rev. 3). Revoke-all runs
       * *before* the new session opens, so the fresh one is not caught by it — asserting both is
       * what pins that ordering, which is the part a refactor would silently break.
       *
       * What is still *not* asserted, because it is still true: access tokens already issued
       * elsewhere keep working until they expire. JwtGuard reads no session row, so revocation
       * stops a device renewing, not a token being used.
       */
      expect(authSessions.revokeAllForUser).toHaveBeenCalledWith('user-1', NOW);
      expect(authSessions.create).toHaveBeenCalledTimes(1);
      expect(result.accessToken).toBeTruthy();
    });

    it('rejects a wrong current password without changing anything', async () => {
      await expect(
        service.changePassword(
          auth,
          {
            currentPassword: 'not my password',
            newPassword: 'an entirely different one',
          },
          DEVICE,
        ),
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
        service.changePassword(
          auth,
          {
            currentPassword: 'correct horse battery staple',
            newPassword: 'correct horse battery staple',
          },
          DEVICE,
        ),
      ).rejects.toMatchObject({ problem: { status: 422 } });
    });

    it('tells a provider-created account plainly that it has no password to change', async () => {
      stored = makeUser({ passwordHash: null });

      await expect(
        service.changePassword(
          auth,
          {
            currentPassword: 'correct horse battery staple',
            newPassword: 'an entirely different one',
          },
          DEVICE,
        ),
      ).rejects.toMatchObject({
        problem: {
          status: 422,
          errors: [
            { field: 'currentPassword', message: 'This account does not have a password yet.' },
          ],
        },
      });

      /*
       * Unlike the login path, this one may say so. The caller has already proved they are this
       * user, so there is nothing left to enumerate — and a generic "wrong password" would leave
       * someone typing guesses at a field that can never be satisfied.
       */
      expect(users.updatePassword).not.toHaveBeenCalled();
    });

    it('refuses when the authenticated account no longer exists', async () => {
      stored = null;

      await expect(
        service.changePassword(
          auth,
          {
            currentPassword: 'correct horse battery staple',
            newPassword: 'an entirely different one',
          },
          DEVICE,
        ),
      ).rejects.toMatchObject({ problem: { status: 401 } });
    });
  });
});
