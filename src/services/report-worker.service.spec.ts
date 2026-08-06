import { beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { MailMessage } from '../common/ports/mailer.port';
import type { DueSubscriptionRecord } from '../common/types/report.types';
import type { SessionRecord } from '../common/types/session.types';
import type { Env } from '../config/env.schema';
import { hashToken } from '../domain/report';
import type {
  ClaimPeriodInput,
  DeliveryRecord,
  ReportDeliveryRepository,
} from '../repositories/report-delivery.repository';
import type { ReportSubscriptionRepository } from '../repositories/report-subscription.repository';
import type { ReportWebhookEventRepository } from '../repositories/report-webhook-event.repository';
import type { SessionRepository } from '../repositories/session.repository';
import { RecordingMailer } from './recording-mailer.service';
import type { ReportLinkService } from './report-link.service';
import type { ReportRendererService } from './report-renderer.service';
import { ReportWorkerService } from './report-worker.service';
import { MailSendError } from './resend-mailer.service';

/*
 * The hourly worker (CONTRACT.md §26).
 *
 * The properties under test are the ones that decide whether a user gets their report once, twice,
 * or never:
 *
 *   ONCE       — the ledger's unique claim is what makes a double tick harmless (A7).
 *   ON TIME    — dueness is resolved in the ACCOUNT'S timezone, not the server's.
 *   NOT EMPTY  — a period with no sessions is recorded as skipped, never sent (P7).
 *   RETRIED    — only temporary failures. A 4xx is terminal, and an accepted message is never
 *                re-sent because delivery was slow.
 *
 * `RecordingMailer` is the real fake from the port's own family, not a stub written here — which is
 * half the reason the port exists (ADR-020, ADR-009).
 */

/** 08:00 Monday in London — due for a weekly subscriber there, and not for one in Auckland. */
const MONDAY_8AM_LONDON = new Date('2026-08-03T07:00:00.000Z');

const CONFIG = { get: () => 100 } as unknown as ConfigService<Env, true>;

function makeSubscription(overrides: Partial<DueSubscriptionRecord> = {}): DueSubscriptionRecord {
  return {
    id: 'sub-1',
    userId: 'user-1',
    frequency: 'weekly',
    status: 'active',
    deliveryDay: 1,
    pausedUntil: null,
    confirmedAt: MONDAY_8AM_LONDON,
    confirmationTokenHash: null,
    confirmationExpiresAt: null,
    unsubscribeTokenHash: hashToken('unsub'),
    consecutiveSoftBounces: 0,
    lastBounceAt: null,
    lastDeliveredPeriodStart: null,
    createdAt: MONDAY_8AM_LONDON,
    updatedAt: MONDAY_8AM_LONDON,
    timeZone: 'Europe/London',
    email: 'ada@example.test',
    firstName: 'Ada',
    ...overrides,
  };
}

/** A completed 25-minute focus block inside the week of 27 July – 2 August. */
function session(endedAt: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'ses-1',
    taskId: 'task-1',
    taskTitleSnapshot: 'Write the report',
    clientSessionId: 'client-1',
    type: 'focus',
    status: 'completed',
    startedAt: new Date(endedAt),
    endedAt: new Date(endedAt),
    plannedDurationMs: 25 * 60 * 1000,
    actualDurationMs: 25 * 60 * 1000,
    terminationReason: null,
    pointsAwarded: 100,
    attributionDate: endedAt.slice(0, 10),
    ...overrides,
  };
}

describe('ReportWorkerService', () => {
  let subscriptions: DueSubscriptionRecord[];
  let sessions: SessionRecord[];
  let ledger: DeliveryRecord[];
  let claims: ClaimPeriodInput[];
  let marks: string[];
  let mailer: RecordingMailer;
  let worker: ReportWorkerService;

  beforeEach(() => {
    subscriptions = [makeSubscription()];
    sessions = [session('2026-07-28T10:25:00.000Z')];
    ledger = [];
    claims = [];
    marks = [];
    mailer = new RecordingMailer();

    const subscriptionRepo = {
      findDeliverable: (frequency: string) =>
        Promise.resolve(subscriptions.filter((s) => s.frequency === frequency)),
      findDueById: (id: string) => Promise.resolve(subscriptions.find((s) => s.id === id) ?? null),
      markPeriodDelivered: (id: string) => {
        marks.push(`delivered:${id}`);
        return Promise.resolve();
      },
    } as unknown as ReportSubscriptionRepository;

    const deliveryRepo = {
      /*
       * The fake enforces the same unique constraint the database does. Without that this suite
       * would prove nothing about the property it exists to check.
       */
      claimPeriod: (input: ClaimPeriodInput) => {
        const key = `${input.subscriptionId}|${input.periodKind}|${input.periodStart.toISOString()}`;
        if (
          claims.some(
            (c) => `${c.subscriptionId}|${c.periodKind}|${c.periodStart.toISOString()}` === key,
          )
        ) {
          return Promise.resolve(null);
        }
        claims.push(input);
        const row: DeliveryRecord = {
          id: `del-${claims.length}`,
          subscriptionId: input.subscriptionId,
          periodKind: input.periodKind,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: null,
          providerMessageId: null,
          lastError: null,
          generatedAt: null,
        };
        ledger.push(row);
        return Promise.resolve(row);
      },
      markSent: (id: string) => {
        marks.push(`sent:${id}`);
        return Promise.resolve();
      },
      markSkippedEmpty: (id: string) => {
        marks.push(`skipped:${id}`);
        return Promise.resolve();
      },
      markRetryable: (id: string, at: Date) => {
        marks.push(`retryable:${id}:${at.toISOString()}`);
        return Promise.resolve();
      },
      markTerminal: (id: string, status: string) => {
        marks.push(`terminal:${status}:${id}`);
        return Promise.resolve();
      },
      findRetryable: () => Promise.resolve([]),
      purgeOlderThan: () => Promise.resolve(0),
    } as unknown as ReportDeliveryRepository;

    const sessionRepo = {
      findEndedBetween: () => Promise.resolve(sessions),
      getGamification: () =>
        Promise.resolve({ lifetimePoints: 500, currentDayStreak: 3, longestDayStreak: 9 }),
    } as unknown as SessionRepository;

    const renderer = {
      render: () => Promise.resolve(Buffer.from('%PDF-1.7 rendered')),
    } as unknown as ReportRendererService;

    const links = {
      unsubscribeUrl: () => 'https://app.test/reports/unsubscribe?token=abc',
      settingsUrl: () => 'https://app.test/settings',
    } as unknown as ReportLinkService;

    const webhookEvents = {
      purgeOlderThan: () => Promise.resolve(0),
    } as unknown as ReportWebhookEventRepository;

    worker = new ReportWorkerService(
      subscriptionRepo,
      deliveryRepo,
      webhookEvents,
      sessionRepo,
      renderer,
      links,
      mailer,
      { now: () => MONDAY_8AM_LONDON },
      CONFIG,
    );
  });

  describe('sending a due report', () => {
    it('sends exactly one message and records it', async () => {
      const summary = await worker.runOnce();

      expect(summary.sent).toBe(1);
      expect(mailer.sent).toHaveLength(1);
      expect(marks).toContain('sent:del-1');
      expect(marks).toContain('delivered:sub-1');
    });

    it('covers the week that ended, not the one in progress', async () => {
      await worker.runOnce();

      expect(claims[0].periodStart.toISOString().slice(0, 10)).toBe('2026-07-27');
      expect(claims[0].periodEnd.toISOString().slice(0, 10)).toBe('2026-08-02');
      expect(mailer.last?.subject).toContain('Mon 27 Jul – Sun 2 Aug 2026');
    });

    it('attaches the PDF and carries the figures as text too', async () => {
      await worker.runOnce();
      const message = mailer.last as MailMessage;

      expect(message.attachments?.[0].filename).toBe('evergrove-report-2026-07-27.pdf');
      expect(message.attachments?.[0].contentType).toBe('application/pdf');
      // §26.5: an attachment-only email is unreadable to anyone who cannot open a PDF.
      expect(message.text).toContain('Sessions completed : 1');
      expect(message.text).toContain('Unsubscribe:');
    });

    it('carries a machine-readable unsubscribe header', async () => {
      await worker.runOnce();
      const message = mailer.last as MailMessage;

      expect(message.headers?.['List-Unsubscribe']).toContain('/reports/unsubscribe?token=');
      expect(message.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    });
  });

  describe('exactly once', () => {
    it('does not send again when the tick runs twice', async () => {
      /*
       * A7. With no queue, safety is the unique index on (subscription, kind, period_start): the
       * second claim loses, and the correct response is to do nothing at all.
       */
      await worker.runOnce();
      const second = await worker.runOnce();

      expect(mailer.sent).toHaveLength(1);
      expect(second.sent).toBe(0);
      expect(claims).toHaveLength(1);
    });
  });

  describe('timezone', () => {
    it('does not send to an account for whom it is not yet 08:00', async () => {
      // The same instant is Monday 8pm in Auckland — the right day, the wrong hour.
      subscriptions = [makeSubscription({ timeZone: 'Pacific/Auckland' })];

      const summary = await worker.runOnce();

      expect(summary.sent).toBe(0);
      expect(mailer.sent).toHaveLength(0);
    });

    it('does not send on the wrong local weekday', async () => {
      subscriptions = [makeSubscription({ deliveryDay: 3 })];

      const summary = await worker.runOnce();
      expect(summary.sent).toBe(0);
    });
  });

  describe('empty periods', () => {
    it('records a skip and sends nothing', async () => {
      sessions = [];

      const summary = await worker.runOnce();

      expect(summary.sent).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(mailer.sent).toHaveLength(0);
      // Recorded, not silently passed over — otherwise the next tick decides again, forever.
      expect(marks).toContain('skipped:del-1');
    });

    it('does not count break intervals as activity', async () => {
      // Rule 1: a period of nothing but breaks is an empty period.
      sessions = [session('2026-07-28T10:30:00.000Z', { type: 'break' })];

      const summary = await worker.runOnce();
      expect(summary.skipped).toBe(1);
    });
  });

  describe('failures', () => {
    it('retries a provider 5xx', async () => {
      mailer.failWith = new MailSendError('upstream', 503);

      const summary = await worker.runOnce();

      expect(summary.failed).toBe(1);
      expect(marks.some((mark) => mark.startsWith('retryable:del-1:'))).toBe(true);
    });

    it('retries a dead network', async () => {
      mailer.failWith = new MailSendError('unreachable', 0);

      await worker.runOnce();
      expect(marks.some((mark) => mark.startsWith('retryable:'))).toBe(true);
    });

    it('does not retry a 4xx', async () => {
      /*
       * A rejected address will be rejected identically next time. Retrying turns one failure into
       * five identical ones against a mailbox that already said no.
       */
      mailer.failWith = new MailSendError('rejected', 422);

      await worker.runOnce();

      expect(marks).toContain('terminal:failed:del-1');
      expect(marks.some((mark) => mark.startsWith('retryable:'))).toBe(false);
    });

    it('leaves the period claimed, so a failure never becomes a double send', async () => {
      mailer.failWith = new MailSendError('upstream', 500);
      await worker.runOnce();

      // The next tick must not re-claim and re-send; the retry pass owns it from here.
      const second = await worker.runOnce();
      expect(second.sent).toBe(0);
      expect(claims).toHaveLength(1);
    });
  });
});
