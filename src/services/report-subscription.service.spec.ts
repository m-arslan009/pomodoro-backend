import { beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { ReportSubscriptionRecord } from '../common/types/report.types';
import type { UserRecord } from '../common/types/user.types';
import type { Env } from '../config/env.schema';
import { hashToken } from '../domain/report';
import type {
  CreateSubscriptionInput,
  ReportSubscriptionRepository,
  SubscriptionPatch,
} from '../repositories/report-subscription.repository';
import type { UserRepository } from '../repositories/user.repository';
import type { ReportLinkService } from './report-link.service';
import type { ReportMailService } from './report-mail.service';
import { ReportSubscriptionService } from './report-subscription.service';

/*
 * The subscription lifecycle (CONTRACT.md §25.1–§25.4).
 *
 * Fakes rather than mocks with expectations: what matters is the state each answer produces and the
 * mail it does or does not cause, never the call sequence used to get there.
 *
 * Four rules here are privacy rules rather than behaviour, and each one is a defect with a real
 * victim if it inverts:
 *
 *   L3         — an unverified address must never be activated without proving it can receive mail.
 *   §25.1      — a missing row is a state, not a 404; a Google account lives in it permanently.
 *   §23.0 c3   — declining WRITES a row, or "said no" and "never asked" become the same thing and
 *                the dashboard invitation asks forever.
 *   §25.3/25.4 — unknown, expired and used tokens are one answer, or the endpoint is an oracle for
 *                which tokens exist.
 */

const NOW = new Date('2026-08-06T09:00:00.000Z');
const CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CONFIG = {
  get: () => CONFIRMATION_TTL_MS,
} as unknown as ConfigService<Env, true>;

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    email: 'ada@example.test',
    username: 'ada',
    usernameLower: 'ada',
    firstName: 'Ada',
    lastName: 'Lovelace',
    passwordHash: 'argon2id$...',
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

function makeSubscription(
  overrides: Partial<ReportSubscriptionRecord> = {},
): ReportSubscriptionRecord {
  return {
    id: 'sub-1',
    userId: 'user-1',
    frequency: 'weekly',
    status: 'active',
    deliveryDay: 1,
    pausedUntil: null,
    confirmedAt: NOW,
    confirmationTokenHash: null,
    confirmationExpiresAt: null,
    unsubscribeTokenHash: hashToken('unsub-token'),
    consecutiveSoftBounces: 0,
    lastBounceAt: null,
    lastDeliveredPeriodStart: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('ReportSubscriptionService', () => {
  let stored: ReportSubscriptionRecord | null;
  let user: UserRecord;
  let created: CreateSubscriptionInput[];
  let patches: SubscriptionPatch[];
  let confirmations: { to: string; token: string; frequency: string }[];
  let service: ReportSubscriptionService;

  beforeEach(() => {
    stored = null;
    user = makeUser();
    created = [];
    patches = [];
    confirmations = [];

    const subscriptions = {
      findByUserId: () => Promise.resolve(stored),
      create: (input: CreateSubscriptionInput) => {
        created.push(input);
        stored = makeSubscription({
          frequency: input.frequency,
          status: input.status,
          deliveryDay: input.deliveryDay,
          confirmedAt: input.confirmedAt,
          confirmationTokenHash: input.confirmationTokenHash,
          confirmationExpiresAt: input.confirmationExpiresAt,
          unsubscribeTokenHash: input.unsubscribeTokenHash,
        });
        return Promise.resolve(stored);
      },
      update: (_userId: string, patch: SubscriptionPatch) => {
        patches.push(patch);
        stored = { ...makeSubscription(), ...stored, ...patch };
        return Promise.resolve(stored);
      },
      findByConfirmationTokenHash: (hash: string) =>
        Promise.resolve(stored?.confirmationTokenHash === hash ? stored : null),
      findByUnsubscribeTokenHash: (hash: string) =>
        Promise.resolve(stored?.unsubscribeTokenHash === hash ? stored : null),
    } as unknown as ReportSubscriptionRepository;

    const users = {
      findById: () => Promise.resolve(user),
    } as unknown as UserRepository;

    const mail = {
      sendConfirmation: (input: { to: string; token: string; frequency: string }) => {
        confirmations.push(input);
        return Promise.resolve();
      },
    } as unknown as ReportMailService;

    const clock = { now: () => NOW };

    /*
     * The unsubscribe token is derived rather than random (§26.5), so the fake returns the same
     * fixed value the subscription fixture was hashed from — which is what makes the token lookup
     * in the unsubscribe tests resolve.
     */
    const links = {
      unsubscribeToken: () => 'unsub-token',
      unsubscribeUrl: () => 'https://app.test/reports/unsubscribe?token=unsub-token',
      settingsUrl: () => 'https://app.test/settings',
    } as unknown as ReportLinkService;

    service = new ReportSubscriptionService(subscriptions, users, mail, links, clock, CONFIG);
  });

  describe('read — a missing row is a state, not an error', () => {
    it('answers "unasked" for an account that has never been asked', async () => {
      await expect(service.read('user-1')).resolves.toEqual({
        status: 'unasked',
        frequency: null,
        deliveryDay: null,
        confirmedAt: null,
        requiresConfirmation: false,
      });
    });

    it('does not create a row on a read', async () => {
      await service.read('user-1');
      // The distinction the whole feature turns on. A read that wrote would make every account
      // look asked, and the one-time invitation would never appear again (§23.0 consequence 3).
      expect(created).toHaveLength(0);
      expect(stored).toBeNull();
    });

    it('hides the delivery day for a monthly subscription', async () => {
      stored = makeSubscription({ frequency: 'monthly', deliveryDay: 3 });
      const view = await service.read('user-1');
      expect(view.deliveryDay).toBeNull();
    });

    it('never exposes token material or bounce state', async () => {
      stored = makeSubscription({ consecutiveSoftBounces: 2 });
      const view = await service.read('user-1');
      expect(Object.keys(view).sort()).toEqual([
        'confirmedAt',
        'deliveryDay',
        'frequency',
        'requiresConfirmation',
        'status',
      ]);
    });
  });

  describe('choose — L3 activation', () => {
    it('activates a Google-verified address immediately, with no email', async () => {
      user = makeUser({ emailVerifiedAt: new Date('2026-08-01T00:00:00.000Z') });

      const view = await service.choose('user-1', 'weekly');

      expect(view.status).toBe('active');
      expect(view.requiresConfirmation).toBe(false);
      expect(confirmations).toHaveLength(0);
      expect(created[0].confirmationTokenHash).toBeNull();
    });

    it('holds an unverified password account pending, and sends exactly one confirmation', async () => {
      const view = await service.choose('user-1', 'monthly');

      expect(view.status).toBe('pending_confirmation');
      expect(view.requiresConfirmation).toBe(true);
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0].to).toBe('ada@example.test');
      expect(confirmations[0].frequency).toBe('monthly');
    });

    it('stores only the hash of the token it emailed', async () => {
      await service.choose('user-1', 'weekly');

      const emailed = confirmations[0].token;
      expect(created[0].confirmationTokenHash).toBe(hashToken(emailed));
      expect(created[0].confirmationTokenHash).not.toBe(emailed);
      expect(created[0].confirmationExpiresAt).toEqual(
        new Date(NOW.getTime() + CONFIRMATION_TTL_MS),
      );
    });

    it('re-issuing invalidates the previous link', async () => {
      await service.choose('user-1', 'weekly');
      const first = confirmations[0].token;

      await service.choose('user-1', 'weekly');
      const second = confirmations[1].token;

      expect(second).not.toBe(first);
      // One live token per subscription — the column is overwritten, so the old link is dead.
      expect(stored?.confirmationTokenHash).toBe(hashToken(second));
    });
  });

  describe('choose — declining writes a row', () => {
    it('records a decline for an account with no subscription', async () => {
      const view = await service.choose('user-1', 'none');

      expect(view.status).toBe('declined');
      // Silence and refusal must stay distinguishable, or the invitation asks forever.
      expect(created).toHaveLength(1);
      expect(created[0].status).toBe('declined');
    });

    it('sends no mail when declining', async () => {
      await service.choose('user-1', 'none');
      expect(confirmations).toHaveLength(0);
    });

    it('abandons an outstanding confirmation, so an old link cannot switch reports back on', async () => {
      await service.choose('user-1', 'weekly');
      expect(stored?.confirmationTokenHash).not.toBeNull();

      await service.choose('user-1', 'none');

      expect(stored?.status).toBe('declined');
      expect(stored?.confirmationTokenHash).toBeNull();
      expect(stored?.confirmationExpiresAt).toBeNull();
    });
  });

  describe('choose — resuming', () => {
    it('lifts a pause and clears the bounce counter', async () => {
      user = makeUser({ emailVerifiedAt: NOW });
      stored = makeSubscription({
        status: 'paused',
        pausedUntil: new Date('2026-08-20T00:00:00.000Z'),
        consecutiveSoftBounces: 3,
      });

      const view = await service.choose('user-1', 'weekly');

      expect(view.status).toBe('active');
      expect(stored?.pausedUntil).toBeNull();
      expect(stored?.consecutiveSoftBounces).toBe(0);
    });

    it('does not re-verify an address that was already proven', async () => {
      const confirmedAt = new Date('2026-07-01T00:00:00.000Z');
      user = makeUser({ emailVerifiedAt: NOW });
      stored = makeSubscription({ status: 'unsubscribed', confirmedAt });

      const view = await service.choose('user-1', 'monthly');

      expect(view.status).toBe('active');
      expect(view.confirmedAt).toBe(confirmedAt.toISOString());
      expect(confirmations).toHaveLength(0);
    });
  });

  describe('confirm', () => {
    it('activates the subscription and consumes the token', async () => {
      await service.choose('user-1', 'weekly');
      const token = confirmations[0].token;

      const outcome = await service.confirm(token);

      expect(outcome.kind).toBe('ok');
      expect(stored?.status).toBe('active');
      expect(stored?.confirmedAt).toEqual(NOW);
      expect(stored?.confirmationTokenHash).toBeNull();
    });

    it('rejects the same token a second time', async () => {
      await service.choose('user-1', 'weekly');
      const token = confirmations[0].token;
      await service.confirm(token);

      // Single-use. A second click really has used the link, and saying so is correct.
      await expect(service.confirm(token)).resolves.toEqual({ kind: 'invalid' });
    });

    it('rejects an expired token', async () => {
      stored = makeSubscription({
        status: 'pending_confirmation',
        confirmedAt: null,
        confirmationTokenHash: hashToken('stale'),
        confirmationExpiresAt: new Date(NOW.getTime() - 1),
      });

      await expect(service.confirm('stale')).resolves.toEqual({ kind: 'invalid' });
    });

    it('answers identically for an unknown token', async () => {
      /*
       * Unknown, expired and already-used are one response. Distinguishing them — or answering 404
       * for one of them — turns the endpoint into a probe for which tokens exist.
       */
      await expect(service.confirm('never-issued')).resolves.toEqual({ kind: 'invalid' });
    });
  });

  describe('unsubscribe', () => {
    it('switches reports off and records that they were unsubscribed, not declined', async () => {
      stored = makeSubscription();

      const outcome = await service.unsubscribe('unsub-token');

      expect(outcome.kind).toBe('ok');
      // Distinct from `declined`: this user was receiving reports and stopped, which is a
      // different conversation and different copy (§23.1).
      expect(stored?.status).toBe('unsubscribed');
    });

    it('is idempotent — a second click answers exactly like the first', async () => {
      stored = makeSubscription();

      const first = await service.unsubscribe('unsub-token');
      const second = await service.unsubscribe('unsub-token');

      expect(first).toEqual(second);
      expect(second.kind).toBe('ok');
    });

    it('keeps the address proven, so turning reports back on does not re-verify', async () => {
      stored = makeSubscription({ confirmedAt: new Date('2026-07-01T00:00:00.000Z') });

      await service.unsubscribe('unsub-token');

      expect(stored?.confirmedAt).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    });

    it('answers "invalid" for an unknown token, never a 404', async () => {
      stored = makeSubscription();
      await expect(service.unsubscribe('some-other-token')).resolves.toEqual({ kind: 'invalid' });
    });
  });
});
