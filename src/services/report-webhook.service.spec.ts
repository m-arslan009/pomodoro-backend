import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { ReportSubscriptionRecord } from '../common/types/report.types';
import type { Env } from '../config/env.schema';
import { SOFT_BOUNCE_LIMIT, hashToken } from '../domain/report';
import type { ReportSubscriptionRepository } from '../repositories/report-subscription.repository';
import type { ReportWebhookEventRepository } from '../repositories/report-webhook-event.repository';
import { ReportWebhookService } from './report-webhook.service';

/*
 * The provider delivery webhook (CONTRACT.md §25.6).
 *
 * Four properties are load-bearing and each one has a concrete victim if it fails:
 *
 *   SIGNED     — an unverified caller must not be able to disable a subscription by naming a
 *                message id.
 *   IDEMPOTENT — every provider retries. The soft-bounce counter is the one non-idempotent effect,
 *                so a redelivered transient bounce must not pause a healthy subscription.
 *   TOLERANT   — an unknown event type is acknowledged, never an error. A webhook that 500s gets
 *                disabled by the provider, costing every future bounce notice.
 *   DECISIVE   — a hard bounce or a complaint stops reports at once, not after two more.
 */

const SECRET_BYTES = Buffer.from('a-test-signing-key-that-is-long-enough');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const NOW = new Date('2026-08-06T09:00:00.000Z');

const CONFIG = { get: () => SECRET } as unknown as ConfigService<Env, true>;

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
    unsubscribeTokenHash: hashToken('unsub'),
    consecutiveSoftBounces: 0,
    lastBounceAt: null,
    lastDeliveredPeriodStart: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Sign a payload exactly as Svix does: HMAC over `id.timestamp.body`, base64, prefixed `v1,`. */
function sign(id: string, body: string, at: Date = NOW): string {
  const timestamp = Math.floor(at.getTime() / 1000).toString();
  const mac = createHmac('sha256', SECRET_BYTES)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return `v1,${mac}`;
}

function event(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, data: { email_id: 'msg_1', ...extra } });
}

function headers(id: string, body: string, at: Date = NOW) {
  return {
    id,
    timestamp: Math.floor(at.getTime() / 1000).toString(),
    signature: sign(id, body, at),
  };
}

describe('ReportWebhookService', () => {
  let subscription: ReportSubscriptionRecord | null;
  let claimed: Set<string>;
  let softBounces: number;
  let calls: string[];
  let service: ReportWebhookService;

  beforeEach(() => {
    subscription = makeSubscription();
    claimed = new Set();
    softBounces = 0;
    calls = [];

    const subscriptions = {
      findByDeliveryMessageId: (messageId: string) =>
        Promise.resolve(messageId === 'msg_1' ? subscription : null),
      recordDelivered: (id: string) => {
        calls.push(`delivered:${id}`);
        softBounces = 0;
        return Promise.resolve();
      },
      recordSoftBounce: (id: string) => {
        calls.push(`soft:${id}`);
        softBounces += 1;
        return Promise.resolve(softBounces);
      },
      pauseUntil: (id: string) => {
        calls.push(`paused:${id}`);
        return Promise.resolve();
      },
      disable: (id: string, status: string) => {
        calls.push(`disabled:${status}:${id}`);
        return Promise.resolve();
      },
    } as unknown as ReportSubscriptionRepository;

    const events = {
      claim: (eventId: string) => {
        if (claimed.has(eventId)) return Promise.resolve(false);
        claimed.add(eventId);
        return Promise.resolve(true);
      },
    } as unknown as ReportWebhookEventRepository;

    service = new ReportWebhookService(subscriptions, events, { now: () => NOW }, CONFIG);
  });

  describe('signature verification', () => {
    it('accepts a correctly signed event', async () => {
      const body = event('email.delivered');
      await expect(service.handle(headers('evt_1', body), Buffer.from(body))).resolves.toBe(
        'applied',
      );
    });

    it('rejects a forged signature', async () => {
      const body = event('email.bounced');
      const outcome = await service.handle(
        { id: 'evt_1', timestamp: headers('evt_1', body).timestamp, signature: 'v1,AAAA' },
        Buffer.from(body),
      );

      expect(outcome).toBe('invalid');
      // Nothing was claimed and nothing was touched — an unverified body is not evidence of
      // anything, and acting on it is how anyone could disable anyone's reports.
      expect(calls).toEqual([]);
      expect(claimed.size).toBe(0);
    });

    it('rejects a body that was altered after signing', async () => {
      const signed = event('email.delivered');
      const tampered = event('email.bounced');

      await expect(service.handle(headers('evt_1', signed), Buffer.from(tampered))).resolves.toBe(
        'invalid',
      );
    });

    it('rejects a replayed request outside the tolerance window', async () => {
      const body = event('email.delivered');
      const old = new Date(NOW.getTime() - 30 * 60 * 1000);

      await expect(service.handle(headers('evt_1', body, old), Buffer.from(body))).resolves.toBe(
        'invalid',
      );
    });

    it('refuses everything when no signing secret is configured', async () => {
      const unconfigured = new ReportWebhookService(
        {} as ReportSubscriptionRepository,
        {} as ReportWebhookEventRepository,
        { now: () => NOW },
        { get: () => undefined } as unknown as ConfigService<Env, true>,
      );
      const body = event('email.bounced');

      // An unverifiable webhook is worse than none: it would let anyone disable any subscription.
      await expect(unconfigured.handle(headers('evt_1', body), Buffer.from(body))).resolves.toBe(
        'unsigned',
      );
    });
  });

  describe('idempotency', () => {
    it('ignores a redelivered event', async () => {
      const body = event('email.bounced', { bounce: { type: 'Permanent' } });

      const first = await service.handle(headers('evt_1', body), Buffer.from(body));
      const second = await service.handle(headers('evt_1', body), Buffer.from(body));

      expect(first).toBe('applied');
      expect(second).toBe('duplicate');
      expect(calls).toEqual(['disabled:bounced:sub-1']);
    });

    it('does not let a redelivered soft bounce count twice', async () => {
      /*
       * The reason the event table exists. Every provider retries, and this is the one effect that
       * is not idempotent — three redeliveries of ONE transient bounce would otherwise pause a
       * perfectly healthy subscription.
       */
      const body = event('email.bounced', { bounce: { type: 'Transient' } });

      for (let i = 0; i < SOFT_BOUNCE_LIMIT; i += 1) {
        await service.handle(headers('evt_same', body), Buffer.from(body));
      }

      expect(calls).toEqual(['soft:sub-1']);
      expect(calls).not.toContain('paused:sub-1');
    });

    it('still counts genuinely distinct soft bounces', async () => {
      const body = event('email.bounced', { bounce: { type: 'Transient' } });

      for (let i = 0; i < SOFT_BOUNCE_LIMIT; i += 1) {
        await service.handle(headers(`evt_${i}`, body), Buffer.from(body));
      }

      expect(calls.filter((call) => call.startsWith('soft:'))).toHaveLength(SOFT_BOUNCE_LIMIT);
      expect(calls).toContain('paused:sub-1');
    });
  });

  describe('event effects', () => {
    it('disables the subscription on a permanent bounce', async () => {
      const body = event('email.bounced', { bounce: { type: 'Permanent' } });
      await service.handle(headers('evt_1', body), Buffer.from(body));

      expect(calls).toEqual(['disabled:bounced:sub-1']);
    });

    it('treats an unclassified bounce as permanent', async () => {
      // Guessing "temporary" about an address that does not exist keeps mailing it, which is
      // precisely what damages a sending reputation.
      const body = event('email.bounced');
      await service.handle(headers('evt_1', body), Buffer.from(body));

      expect(calls).toEqual(['disabled:bounced:sub-1']);
    });

    it('stops reports on a complaint, recorded as unsubscribed rather than bounced', async () => {
      const body = event('email.complained');
      await service.handle(headers('evt_1', body), Buffer.from(body));

      // The address works fine; it was the mail that was unwanted. Nothing about the account's
      // address is in question, so `bounced` would be the wrong fact to record.
      expect(calls).toEqual(['disabled:unsubscribed:sub-1']);
    });

    it('disables on a provider suppression', async () => {
      const body = event('email.suppressed');
      await service.handle(headers('evt_1', body), Buffer.from(body));

      expect(calls).toEqual(['disabled:bounced:sub-1']);
    });

    it('resets the soft-bounce counter on a delivery', async () => {
      const bounce = event('email.bounced', { bounce: { type: 'Transient' } });
      await service.handle(headers('evt_1', bounce), Buffer.from(bounce));

      const delivered = event('email.delivered');
      await service.handle(headers('evt_2', delivered), Buffer.from(delivered));

      expect(calls).toEqual(['soft:sub-1', 'delivered:sub-1']);
      expect(softBounces).toBe(0);
    });

    it('does nothing at all for a delayed delivery', async () => {
      /*
       * THE RULE THAT PREVENTS DUPLICATE REPORTS. The message has already been accepted; "delayed"
       * means the provider is still trying. Treating it as a failure would re-send a report that is
       * about to arrive.
       */
      const body = event('email.delivery_delayed');
      const outcome = await service.handle(headers('evt_1', body), Buffer.from(body));

      expect(outcome).toBe('ignored');
      expect(calls).toEqual([]);
    });

    it('acknowledges an event type it has never heard of', async () => {
      const body = event('email.something_new_in_2027');
      await expect(service.handle(headers('evt_1', body), Buffer.from(body))).resolves.toBe(
        'ignored',
      );
    });

    it('ignores an event for a message that is not ours', async () => {
      const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'someone-else' } });
      const outcome = await service.handle(headers('evt_1', body), Buffer.from(body));

      expect(outcome).toBe('ignored');
      expect(calls).toEqual([]);
    });
  });
});
