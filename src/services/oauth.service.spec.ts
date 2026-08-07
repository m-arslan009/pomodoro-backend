import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../common/ports/clock.port';
import { PasswordHasher } from '../common/ports/password-hasher.port';
import type { AuthIdentityRecord, IdTokenClaims } from '../common/types/oauth.types';
import type { UserRecord } from '../common/types/user.types';
import type { Env } from '../config/env.schema';
import type { OAuthCallbackQuery } from '../dto/oauth.dto';
import type { AuthIdentityRepository } from '../repositories/auth-identity.repository';
import type { AuthSessionRepository } from '../repositories/auth-session.repository';
import type {
  CreateUserFromIdentityInput,
  UserConflictField,
  UserRepository,
} from '../repositories/user.repository';
import { AccessTokenService } from './access-token.service';
import { AuthService } from './auth.service';
import type { AuthorizeUrlInput, GoogleOidcService } from './google-oidc.service';
import { OAuthService } from './oauth.service';
import type { OAuthTransactionService } from './oauth-transaction.service';
import { RefreshTokenService } from './refresh-token.service';

/*
 * The account-resolution algorithm (CONTRACT.md §4.12.1) and the flow around it.
 *
 * This is the single most important spec in the OAuth feature, because every branch below decides
 * *which Evergrove account a stranger gets to sign into*. Getting one of them wrong is not a bug
 * that shows up as a broken page; it is a bug that shows up as someone else's history.
 *
 * WHAT IS REAL AND WHAT IS FAKED. `AuthService` is the real one, wired exactly as its own spec wires
 * it, because "the OAuth callback opens the same session the password path opens" is the central
 * claim of ADR-008a and a stubbed `startSession` would assert only that OAuthService called
 * something. Google and the transaction cookie are faked: one is a network, the other is covered
 * where it lives.
 *
 * WHAT IS NOT HERE. Unlinking, listing identities and the explicit link flow (§4.14–§4.17) are phase
 * O4 and do not exist yet — there is no `link-start` to put a `userId` in the transaction, so branch
 * 2 of §4.12.1 is unreachable and is deliberately untested rather than tested against a stub.
 */

const NOW = new Date('2026-08-05T09:00:00.000Z');
const HOUR = 3_600_000;

const SIGNING_KEY = 'test-signing-key-that-is-long-enough-to-be-valid';

const ENV = {
  JWT_ACCESS_TTL_MS: 15 * 60_000,
  JWT_ISSUER: 'evergrove',
  JWT_AUDIENCE: 'evergrove-web',
  SESSION_IDLE_TTL_MS: 7 * 24 * HOUR,
  SESSION_ABSOLUTE_TTL_MS: 30 * 24 * HOUR,
} as const;

const DEVICE = { userAgent: 'vitest', ip: '127.0.0.1' } as const;

/** The app origin the fake `GoogleOidcService` builds redirect targets against. */
const APP = 'http://app.test';

function claimsOf(accessToken: string): Record<string, unknown> {
  const segment = accessToken.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
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

function makeClaims(overrides: Partial<IdTokenClaims> = {}): IdTokenClaims {
  return {
    sub: 'google-subject-1',
    email: 'ada@evergrove.app',
    emailVerified: true,
    givenName: 'Ada',
    familyName: 'Lovelace',
    name: 'Ada Lovelace',
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<AuthIdentityRecord> = {}): AuthIdentityRecord {
  return {
    id: 'identity-1',
    userId: 'user-1',
    provider: 'google',
    providerSubject: 'google-subject-1',
    emailAtLink: 'ada@evergrove.app',
    linkedAt: NOW,
    lastLoginAt: null,
    ...overrides,
  };
}

/** A well-formed callback: the shape every failure test starts from and breaks one field of. */
function callback(overrides: Partial<OAuthCallbackQuery> = {}): OAuthCallbackQuery {
  return { code: 'authorization-code', state: 'state-value', error: null, ...overrides };
}

class FakeHasher extends PasswordHasher {
  hash(plain: string): Promise<string> {
    return Promise.resolve(`hashed:${plain}`);
  }
  verify(hashed: string, plain: string): Promise<boolean> {
    return Promise.resolve(hashed === `hashed:${plain}`);
  }
  verifyDummy(): Promise<void> {
    return Promise.resolve();
  }
  needsRehash(): boolean {
    return false;
  }
}

describe('OAuthService', () => {
  /** Accounts, keyed by id. Doubles as the email index, which is small enough to scan. */
  let usersById: Map<string, UserRecord>;
  let identityRows: AuthIdentityRecord[];

  /** Successive results for `createFromIdentity`; `null` means "let the insert succeed". */
  let createConflicts: Array<readonly UserConflictField[] | null>;
  let createdInputs: CreateUserFromIdentityInput[];
  /** How many identity inserts must be refused before one is allowed through. */
  let identityInsertFailures: number;
  /*
   * What the request that beat us committed, and it must only become visible *after* our insert is
   * refused. Seeding it up front would let the first lookup find it, so the retry path would never
   * run and the test would pass without exercising the thing it names.
   */
  let identityAppearsAfterFailure: AuthIdentityRecord | null;
  let userAppearsAfterConflict: UserRecord | null;

  let transaction: {
    state: string;
    nonce: string;
    codeVerifier: string;
    returnTo: string;
    timezone: string | null;
  } | null;
  let issuedTransactions: Array<Record<string, unknown>>;
  let authorizeInputs: AuthorizeUrlInput[];

  let exchangeSucceeds: boolean;
  let validatedClaims: IdTokenClaims | null;
  let validateCalls: Array<{ idToken: string; nonce: string }>;

  let users: UserRepository;
  let identities: AuthIdentityRepository;
  let google: GoogleOidcService;
  let transactions: OAuthTransactionService;
  let authSessions: AuthSessionRepository;
  let service: OAuthService;

  beforeEach(() => {
    usersById = new Map([['user-1', makeUser()]]);
    identityRows = [];
    createConflicts = [];
    createdInputs = [];
    identityInsertFailures = 0;
    identityAppearsAfterFailure = null;
    userAppearsAfterConflict = null;

    transaction = {
      state: 'state-value',
      nonce: 'nonce-value',
      codeVerifier: 'verifier-value',
      returnTo: '/timer',
      timezone: 'Europe/London',
    };
    issuedTransactions = [];
    authorizeInputs = [];

    exchangeSucceeds = true;
    validatedClaims = makeClaims();
    validateCalls = [];

    let nextUserId = 2;

    users = {
      findById: vi.fn((id: string) => Promise.resolve(usersById.get(id) ?? null)),
      findByEmail: vi.fn((email: string) =>
        Promise.resolve([...usersById.values()].find((user) => user.email === email) ?? null),
      ),
      findByUsernameKey: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(),
      createFromIdentity: vi.fn((input: CreateUserFromIdentityInput) => {
        createdInputs.push(input);

        const conflicts = createConflicts.shift() ?? null;
        if (conflicts !== null) {
          // The row our insert collided with becomes visible only now, exactly as it would if
          // another request had committed it a moment before ours reached the index.
          if (userAppearsAfterConflict) {
            usersById.set(userAppearsAfterConflict.id, userAppearsAfterConflict);
            userAppearsAfterConflict = null;
          }
          return Promise.resolve({ ok: false as const, conflicts });
        }

        const user = makeUser({
          id: `user-${nextUserId++}`,
          email: input.email,
          username: input.username,
          usernameLower: input.usernameLower,
          firstName: input.firstName,
          lastName: input.lastName,
          timezone: input.timezone,
          emailVerifiedAt: input.emailVerifiedAt,
          passwordHash: null,
        });
        usersById.set(user.id, user);
        identityRows.push(
          makeIdentity({
            id: `identity-${user.id}`,
            userId: user.id,
            providerSubject: input.providerSubject,
            emailAtLink: input.email,
          }),
        );
        return Promise.resolve({ ok: true as const, user });
      }),
      markEmailVerified: vi.fn((id: string, at: Date) => {
        const user = usersById.get(id);
        if (user) usersById.set(id, { ...user, emailVerifiedAt: at });
        return Promise.resolve();
      }),
      markLogin: vi.fn(() => Promise.resolve()),
      updatePassword: vi.fn(() => Promise.resolve()),
      updatePasswordHashOnly: vi.fn(() => Promise.resolve()),
    } as unknown as UserRepository;

    identities = {
      findByProviderSubject: vi.fn((provider: string, subject: string) =>
        Promise.resolve(
          identityRows.find(
            (row) => row.provider === provider && row.providerSubject === subject,
          ) ?? null,
        ),
      ),
      create: vi.fn((input: { userId: string; providerSubject: string; emailAtLink: string }) => {
        if (identityInsertFailures > 0) {
          identityInsertFailures -= 1;
          if (identityAppearsAfterFailure) {
            identityRows.push(identityAppearsAfterFailure);
            identityAppearsAfterFailure = null;
          }
          return Promise.resolve({ ok: false as const });
        }
        const identity = makeIdentity({
          id: `identity-${input.userId}`,
          userId: input.userId,
          providerSubject: input.providerSubject,
          emailAtLink: input.emailAtLink,
        });
        identityRows.push(identity);
        return Promise.resolve({ ok: true as const, identity });
      }),
      touchLastLogin: vi.fn(() => Promise.resolve()),
    } as unknown as AuthIdentityRepository;

    google = {
      isEnabled: true,
      appUrl: (path: string) => `${APP}${path}`,
      buildAuthorizeUrl: vi.fn((input: AuthorizeUrlInput) => {
        authorizeInputs.push(input);
        return `https://accounts.google.test/authorize?state=${input.state}`;
      }),
      exchangeCode: vi.fn(() =>
        Promise.resolve(
          exchangeSucceeds ? { ok: true as const, idToken: 'id-token' } : { ok: false as const },
        ),
      ),
      validateIdToken: vi.fn((idToken: string, nonce: string) => {
        validateCalls.push({ idToken, nonce });
        return validatedClaims;
      }),
    } as unknown as GoogleOidcService;

    transactions = {
      lifetimeMs: 600_000,
      issue: vi.fn((payload: Record<string, unknown>) => {
        issuedTransactions.push(payload);
        return Promise.resolve('signed-transaction');
      }),
      verify: vi.fn(() => Promise.resolve(transaction)),
    } as unknown as OAuthTransactionService;

    const clock: Clock = { now: () => NOW };
    const config = { get: (key: keyof typeof ENV) => ENV[key] } as unknown as ConfigService<
      Env,
      true
    >;

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
      revokeById: vi.fn(() => Promise.resolve()),
      revokeAllForUser: vi.fn(() => Promise.resolve()),
      purgeExpiredForUser: vi.fn(() => Promise.resolve()),
    } as unknown as AuthSessionRepository;

    const auth = new AuthService(
      users,
      new FakeHasher(),
      clock,
      new AccessTokenService(new JwtService({ secret: SIGNING_KEY }), config),
      new RefreshTokenService(authSessions, clock, config),
    );

    service = new OAuthService(users, identities, google, transactions, auth, clock);
  });

  describe('start', () => {
    it('carries the landing page and the browser zone into the transaction', async () => {
      await service.start({ returnTo: '/history', timezone: 'Asia/Tokyo' });

      expect(issuedTransactions[0]).toMatchObject({
        returnTo: '/history',
        timezone: 'Asia/Tokyo',
      });
    });

    it('sends the provider a challenge, never the verifier that unlocks it', async () => {
      await service.start({ returnTo: '/timer', timezone: null });

      const issued = issuedTransactions[0];
      const verifier = issued.codeVerifier as string;

      /*
       * The PKCE property, stated as an equation rather than trusted. The verifier stays on this
       * side; only its SHA-256 is sent. If these ever diverge, Google rejects every exchange — and
       * if the verifier itself were sent, PKCE would be protecting nothing.
       */
      expect(authorizeInputs[0]?.codeChallenge).toBe(
        createHash('sha256').update(verifier).digest('base64url'),
      );
      expect(authorizeInputs[0]?.codeChallenge).not.toBe(verifier);
    });

    it('binds the request with a state and a nonce that are different unguessable values', async () => {
      await service.start({ returnTo: '/timer', timezone: null });
      await service.start({ returnTo: '/timer', timezone: null });

      const [first, second] = issuedTransactions;

      // Two roles, two values: `state` proves the callback belongs to this request, `nonce` proves
      // the ID token does. Reusing one value for both would collapse two defences into one.
      expect(first.state).not.toBe(first.nonce);
      // And neither is reused across attempts, or a captured one would stay useful.
      expect(second.state).not.toBe(first.state);
      expect(second.nonce).not.toBe(first.nonce);
      expect((first.state as string).length).toBeGreaterThanOrEqual(32);
    });

    it('echoes the transaction state into the authorization request', async () => {
      await service.start({ returnTo: '/timer', timezone: null });

      expect(authorizeInputs[0]?.state).toBe(issuedTransactions[0]?.state);
      expect(authorizeInputs[0]?.nonce).toBe(issuedTransactions[0]?.nonce);
    });
  });

  describe('handleCallback — refusals', () => {
    it('reports a declined consent screen as a cancellation', async () => {
      const result = await service.handleCallback(
        'signed-transaction',
        callback({ error: 'access_denied', code: null }),
        DEVICE,
      );

      expect(result).toEqual({ ok: false, code: 'access_denied' });
    });

    it('collapses every other provider error into the generic code', async () => {
      // `admin_policy_enforced`, `org_internal` and friends describe our configuration, not the
      // user's action. Naming them back would describe our setup to a stranger.
      const result = await service.handleCallback(
        'signed-transaction',
        callback({ error: 'admin_policy_enforced', code: null }),
        DEVICE,
      );

      expect(result).toEqual({ ok: false, code: 'invalid_request' });
    });

    it('refuses a callback with no transaction cookie', async () => {
      const result = await service.handleCallback(null, callback(), DEVICE);

      expect(result).toEqual({ ok: false, code: 'invalid_request' });
      expect(google.exchangeCode).not.toHaveBeenCalled();
    });

    it('refuses a transaction cookie that does not verify', async () => {
      transaction = null;

      const result = await service.handleCallback('tampered', callback(), DEVICE);

      expect(result).toEqual({ ok: false, code: 'invalid_request' });
      expect(google.exchangeCode).not.toHaveBeenCalled();
    });

    it('refuses a mismatched state and does not spend the code', async () => {
      const result = await service.handleCallback(
        'signed-transaction',
        callback({ state: 'not-the-state-we-issued' }),
        DEVICE,
      );

      expect(result).toEqual({ ok: false, code: 'invalid_request' });
      /*
       * The CSRF defence, and the ordering is the point. A mismatched `state` means this callback
       * belongs to somebody else's authorization request, so the code must not be redeemed —
       * redeeming first and checking afterwards would already have bound the wrong Google account.
       */
      expect(google.exchangeCode).not.toHaveBeenCalled();
    });

    it('refuses a callback carrying no state at all', async () => {
      const result = await service.handleCallback(
        'signed-transaction',
        callback({ state: null }),
        DEVICE,
      );

      expect(result).toEqual({ ok: false, code: 'invalid_request' });
    });

    it('refuses a callback carrying no code', async () => {
      const result = await service.handleCallback(
        'signed-transaction',
        callback({ code: null }),
        DEVICE,
      );

      expect(result).toEqual({ ok: false, code: 'invalid_request' });
      expect(google.exchangeCode).not.toHaveBeenCalled();
    });

    it('reports a failed code exchange as a provider problem', async () => {
      exchangeSucceeds = false;

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      // Distinct from invalid_request on purpose: this one is worth retrying and is not the user's
      // doing, so the client says "Google could not be reached" rather than "that link expired".
      expect(result).toEqual({ ok: false, code: 'provider_unavailable' });
    });

    it('validates the ID token against the nonce from the transaction, not from the request', async () => {
      await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(validateCalls[0]).toEqual({ idToken: 'id-token', nonce: 'nonce-value' });
    });

    it('refuses an ID token whose claims do not validate', async () => {
      validatedClaims = null;

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result).toEqual({ ok: false, code: 'invalid_request' });
      expect(users.createFromIdentity).not.toHaveBeenCalled();
    });

    it('refuses an unverified email before anything is created or linked', async () => {
      validatedClaims = makeClaims({ email: 'stranger@evergrove.app', emailVerified: false });

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result).toEqual({ ok: false, code: 'email_unverified' });
      /*
       * Step 0 of §4.12.1, and it is the load-bearing precondition for the whole algorithm. Branch
       * 3b-ii hands an existing account to whoever proves control of a matching address — sound only
       * because an unverified claim never reaches it. Asserting that *nothing* was written is what
       * pins the ordering.
       */
      expect(users.createFromIdentity).not.toHaveBeenCalled();
      expect(identities.create).not.toHaveBeenCalled();
    });

    it('refuses an unverified email even when it matches an existing account exactly', async () => {
      validatedClaims = makeClaims({ emailVerified: false });

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result).toEqual({ ok: false, code: 'email_unverified' });
      expect(identities.create).not.toHaveBeenCalled();
    });
  });

  describe('handleCallback — a returning user (§4.12.1 branch 3a)', () => {
    beforeEach(() => {
      identityRows.push(makeIdentity());
    });

    it('signs the linked account in without creating anything', async () => {
      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      expect(users.createFromIdentity).not.toHaveBeenCalled();
      expect(identities.create).not.toHaveBeenCalled();
    });

    it('resolves by provider subject and never consults the email', async () => {
      // The user changed their Google address since linking. They are the same person: `sub` is the
      // identity. Re-resolving by email here would hand the account to whoever now holds the old one.
      validatedClaims = makeClaims({ email: 'ada-new@elsewhere.test' });

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result).toMatchObject({ ok: true });
      expect(users.findByEmail).not.toHaveBeenCalled();
      if (result.ok) expect(claimsOf(result.auth.accessToken).sub).toBe('user-1');
    });

    it('records the sign-in on both the identity and the account', async () => {
      await service.handleCallback('signed-transaction', callback(), DEVICE);

      // Two different questions: which credential was used, and when the account was last reached.
      expect(identities.touchLastLogin).toHaveBeenCalledWith('identity-1', NOW);
      expect(users.markLogin).toHaveBeenCalledWith('user-1', NOW);
    });

    it('fails closed when the identity points at an account that is gone', async () => {
      usersById.clear();

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      // The row cascades with the account, so this is close to unreachable — and it must not open a
      // session for nobody if it ever happens.
      expect(result).toEqual({ ok: false, code: 'invalid_request' });
      expect(authSessions.create).not.toHaveBeenCalled();
    });
  });

  describe('handleCallback — a new account (§4.12.1 branch 3b-i)', () => {
    beforeEach(() => {
      usersById.clear();
    });

    it('creates the account with no password and a verified address', async () => {
      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      expect(createdInputs[0]).toMatchObject({
        email: 'ada@evergrove.app',
        firstName: 'Ada',
        lastName: 'Lovelace',
        provider: 'google',
        providerSubject: 'google-subject-1',
        emailVerifiedAt: NOW,
      });
    });

    it('derives the username from the email local part', async () => {
      validatedClaims = makeClaims({ email: 'ada.lovelace@evergrove.app' });

      await service.handleCallback('signed-transaction', callback(), DEVICE);

      // Punctuation the username rule forbids is stripped rather than rejected: a sign-in must not
      // fail because of the shape of somebody's email address.
      expect(createdInputs[0]).toMatchObject({
        username: 'adalovelace',
        usernameLower: 'adalovelace',
      });
    });

    it('takes the timezone from the transaction so the account buckets days correctly', async () => {
      await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(createdInputs[0]?.timezone).toBe('Europe/London');
    });

    it('falls back to UTC when the browser volunteered no zone', async () => {
      transaction = { ...transaction!, timezone: null };

      await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(createdInputs[0]?.timezone).toBe('UTC');
    });

    it('retries with a suffixed username when the derived one is taken', async () => {
      createConflicts = [['username']];

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      expect(createdInputs).toHaveLength(2);
      /*
       * No pre-check anywhere: two sign-ins can both find the same candidate free, so the unique
       * index is the only race-free authority and its refusal is the signal to try again.
       */
      expect(createdInputs[0]?.username).toBe('ada');
      expect(createdInputs[1]?.username).toMatch(/^ada_[a-z0-9]{4}$/);
      expect(createdInputs[1]?.usernameLower).toBe(createdInputs[1]?.username.toLowerCase());
    });

    it('gives up after five username attempts rather than looping', async () => {
      createConflicts = [['username'], ['username'], ['username'], ['username'], ['username']];

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(createdInputs).toHaveLength(5);
      expect(result).toEqual({ ok: false, code: 'invalid_request' });
    });

    it('opens a session naming the account it just created', async () => {
      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(claimsOf(result.auth.accessToken).sub).toBe('user-2');
      expect(users.markLogin).toHaveBeenCalledWith('user-2', NOW);
    });
  });

  describe('handleCallback — auto-linking an existing account (§4.12.1 branch 3b-ii)', () => {
    it('links the provider to the account that already owns the address', async () => {
      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      expect(users.createFromIdentity).not.toHaveBeenCalled();
      expect(identities.create).toHaveBeenCalledWith({
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'google-subject-1',
        emailAtLink: 'ada@evergrove.app',
      });
    });

    it('leaves the existing password in place so both methods keep working', async () => {
      await service.handleCallback('signed-transaction', callback(), DEVICE);

      // Linking adds a way in. It must never remove one — the account was reachable by password a
      // moment ago and still is.
      expect(usersById.get('user-1')?.passwordHash).toBe('hashed:correct horse battery staple');
      expect(users.updatePassword).not.toHaveBeenCalled();
    });

    it('records the address as verified and says so in the same response', async () => {
      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(users.markEmailVerified).toHaveBeenCalledWith('user-1', NOW);
      /*
       * The response has to agree with the write that just happened. Returning the record as it was
       * loaded — before the update — would answer the very sign-in that verified the address with
       * `emailVerified: false`, and the client would believe that for the life of the access token.
       */
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.auth.profile.emailVerified).toBe(true);
    });

    it('does not rewrite a timestamp that is already there', async () => {
      const verifiedEarlier = new Date('2026-01-01T00:00:00.000Z');
      usersById.set('user-1', makeUser({ emailVerifiedAt: verifiedEarlier }));

      await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(users.markEmailVerified).not.toHaveBeenCalled();
    });

    it('matches the account on the normalised address', async () => {
      usersById.set('user-1', makeUser({ email: 'ada@evergrove.app' }));
      validatedClaims = makeClaims({ email: 'ada@evergrove.app' });

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      if (result.ok) expect(claimsOf(result.auth.accessToken).sub).toBe('user-1');
    });
  });

  describe('handleCallback — losing a race', () => {
    it('signs in when another request created the same identity first', async () => {
      /*
       * Our auto-link insert is refused, and only then does the winner's row become visible. The
       * second pass finds it and branch 3a takes over — which is the entire point of the retry: a
       * lost race is not a failure, it is a lookup that was a moment early.
       */
      identityInsertFailures = 1;
      identityAppearsAfterFailure = makeIdentity({ id: 'identity-racer' });

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      expect(identities.touchLastLogin).toHaveBeenCalledWith('identity-racer', NOW);
      if (result.ok) expect(claimsOf(result.auth.accessToken).sub).toBe('user-1');
    });

    it('links instead of creating when another request registered the same email first', async () => {
      usersById.clear();
      createConflicts = [['email']];
      // The account our insert collided with, appearing only once the collision has happened.
      userAppearsAfterConflict = makeUser({ id: 'user-9' });

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      // Pass one tried to create; pass two found the winner and linked to it instead of retrying
      // the insert with a different username, which would have produced a duplicate account.
      expect(createdInputs).toHaveLength(1);
      expect(identities.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-9' }));
      if (result.ok) expect(claimsOf(result.auth.accessToken).sub).toBe('user-9');
    });

    it('asks the user to retry rather than looping when it loses twice', async () => {
      identityInsertFailures = 2;

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      // Two passes, never more. A third would mean something retrying cannot fix.
      expect(result).toEqual({ ok: false, code: 'invalid_request' });
      expect(authSessions.create).not.toHaveBeenCalled();
    });
  });

  describe('handleCallback — session integration', () => {
    beforeEach(() => {
      identityRows.push(makeIdentity());
    });

    it('opens exactly one ordinary session through the shared entry point', async () => {
      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      /*
       * The central claim of ADR-008a: a provider session is not a variant, it is the same object.
       * One `auth_sessions` row, a refresh token bound for the same cookie, and an access token
       * carrying identity and validity and nothing else — no marker that says "signed in with
       * Google", because no part of the application is allowed to care.
       */
      expect(authSessions.create).toHaveBeenCalledTimes(1);
      expect(result.auth.refresh.token).toBeTruthy();
      expect(result.auth.accessTokenExpiresIn).toBe(ENV.JWT_ACCESS_TTL_MS);
      expect(Object.keys(claimsOf(result.auth.accessToken)).sort()).toEqual([
        'aud',
        'exp',
        'iat',
        'iss',
        'sub',
      ]);
    });

    it('never exposes credential material through the profile', async () => {
      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.auth.profile).not.toHaveProperty('passwordHash');
    });

    it('lands the browser where the transaction said', async () => {
      transaction = { ...transaction!, returnTo: '/history' };

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      expect(result).toMatchObject({ ok: true, returnTo: '/history' });
    });

    it('re-checks the landing page instead of trusting the cookie it signed', async () => {
      transaction = { ...transaction!, returnTo: 'https://evil.test/harvest' };

      const result = await service.handleCallback('signed-transaction', callback(), DEVICE);

      /*
       * The cookie is signed, so this value cannot have been tampered with — the check is for the
       * case where the allow-list shrinks between issue and callback, and for the certainty that no
       * path exists from a request parameter to a `Location` header without passing this filter.
       */
      expect(result).toMatchObject({ ok: true, returnTo: '/timer' });
    });
  });
});
