import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service';
import { AuthIdentityRepository } from './auth-identity.repository';

/*
 * The only component allowed to touch `auth_identities`.
 *
 * What is worth asserting at this layer is narrow and specific: that the lookup addresses the
 * compound unique index rather than scanning, that a unique violation becomes an *outcome* instead
 * of escaping as a 500, and that the ORM stops here — every method answers with a plain record.
 *
 * Whether Postgres enforces the two unique indexes is Postgres's business and belongs to the e2e
 * suite. Whether this file asks it to is testable here.
 */

const NOW = new Date('2026-08-05T09:00:00.000Z');

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'identity-1',
    userId: 'user-1',
    provider: 'google',
    providerSubject: 'google-subject-1',
    emailAtLink: 'ada@evergrove.app',
    linkedAt: NOW,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Prisma's unique-constraint violation, carrying the offending constraint in `meta`. */
function uniqueViolation(constraint: string) {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: constraint },
  });
}

interface CapturedArgs {
  where: Record<string, any>;
  data: Record<string, any>;
}

describe('AuthIdentityRepository', () => {
  let findUniqueArgs: CapturedArgs[];
  let createArgs: CapturedArgs[];
  let updateArgs: CapturedArgs[];

  let row: unknown;
  let createError: Error | null;

  let prisma: PrismaService;
  let repository: AuthIdentityRepository;

  beforeEach(() => {
    findUniqueArgs = [];
    createArgs = [];
    updateArgs = [];
    row = makeRow();
    createError = null;

    prisma = {
      authIdentity: {
        findUnique: vi.fn((args: CapturedArgs) => {
          findUniqueArgs.push(args);
          return Promise.resolve(row);
        }),
        create: vi.fn((args: CapturedArgs) => {
          createArgs.push(args);
          if (createError) return Promise.reject(createError);
          return Promise.resolve(makeRow(args.data));
        }),
        update: vi.fn((args: CapturedArgs) => {
          updateArgs.push(args);
          return Promise.resolve(makeRow());
        }),
      },
    } as unknown as PrismaService;

    repository = new AuthIdentityRepository(prisma);
  });

  describe('findByProviderSubject', () => {
    it('addresses the compound unique index', async () => {
      await repository.findByProviderSubject('google', 'google-subject-1');

      // Not a filtered scan: this is the sign-in hot path, and the index that serves it is the same
      // one guaranteeing a Google account cannot reach two Evergrove accounts.
      expect(findUniqueArgs[0]?.where).toEqual({
        provider_providerSubject: { provider: 'google', providerSubject: 'google-subject-1' },
      });
    });

    it('answers with a plain record, not an ORM row', async () => {
      const identity = await repository.findByProviderSubject('google', 'google-subject-1');

      // `createdAt`/`updatedAt` exist on the row and deliberately not on the record: nothing above
      // this layer has a use for them, and mapping is what keeps ADR-004's escape hatch real.
      expect(identity).toEqual({
        id: 'identity-1',
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'google-subject-1',
        emailAtLink: 'ada@evergrove.app',
        linkedAt: NOW,
        lastLoginAt: null,
      });
    });

    it('reports an unlinked provider account as absent', async () => {
      row = null;

      await expect(repository.findByProviderSubject('google', 'nobody')).resolves.toBeNull();
    });

    it('offers no way to resolve an identity by email address', () => {
      /*
       * The absence is the safeguard, so it is pinned rather than left to discipline. `email_at_link`
       * is audit material; a lookup method on it would eventually be used as one, and a user who
       * changed their Google address would then be resolved to whoever holds the old one.
       */
      expect(Object.getOwnPropertyNames(AuthIdentityRepository.prototype)).toEqual([
        'constructor',
        'findByProviderSubject',
        'create',
        'touchLastLogin',
      ]);
    });
  });

  describe('create', () => {
    it('writes the identity exactly as given', async () => {
      const result = await repository.create({
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'google-subject-1',
        emailAtLink: 'ada@evergrove.app',
      });

      expect(createArgs[0]?.data).toEqual({
        userId: 'user-1',
        provider: 'google',
        providerSubject: 'google-subject-1',
        emailAtLink: 'ada@evergrove.app',
      });
      expect(result).toMatchObject({ ok: true });
    });

    it('turns a unique violation into a refusal rather than an error', async () => {
      createError = uniqueViolation('auth_identities_provider_subject_key');

      /*
       * There is no pre-check anywhere in this flow, on purpose: between a check and an insert
       * another request can claim the same pair, so the index is the only race-free authority. That
       * makes a refusal *information* — the caller re-runs the resolution and finds what the other
       * request committed.
       */
      await expect(
        repository.create({
          userId: 'user-1',
          provider: 'google',
          providerSubject: 'google-subject-1',
          emailAtLink: 'ada@evergrove.app',
        }),
      ).resolves.toEqual({ ok: false });
    });

    it('refuses the same way when the account already has that provider', async () => {
      createError = uniqueViolation('auth_identities_user_provider_key');

      await expect(
        repository.create({
          userId: 'user-1',
          provider: 'google',
          providerSubject: 'another-subject',
          emailAtLink: 'ada@evergrove.app',
        }),
      ).resolves.toEqual({ ok: false });
    });

    it('lets an unexpected database failure escape', async () => {
      createError = Object.assign(new Error('connection reset'), { code: 'P1001' });

      // Swallowing this would report "that provider account is taken" for an outage, and the caller
      // would tell the user something confidently wrong.
      await expect(
        repository.create({
          userId: 'user-1',
          provider: 'google',
          providerSubject: 'google-subject-1',
          emailAtLink: null,
        }),
      ).rejects.toThrow('connection reset');
    });
  });

  describe('touchLastLogin', () => {
    it('stamps the named identity and nothing else', async () => {
      await repository.touchLastLogin('identity-1', NOW);

      expect(updateArgs[0]).toEqual({
        where: { id: 'identity-1' },
        data: { lastLoginAt: NOW },
      });
    });
  });
});
