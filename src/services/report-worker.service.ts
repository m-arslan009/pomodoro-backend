import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../common/ports/clock.port';
import { Mailer } from '../common/ports/mailer.port';
import type { DueSubscriptionRecord } from '../common/types/report.types';
import type { Env } from '../config/env.schema';
import {
  MAX_DELIVERY_ATTEMPTS,
  REPORT_FREQUENCIES,
  type ReportData,
  type ReportPeriod,
  buildReport,
  decideRetry,
  isDueAt,
  isEmptyReport,
  localDate,
  previousPeriod,
  precedingPeriod,
} from '../domain/report';
import {
  type DeliveryRecord,
  ReportDeliveryRepository,
} from '../repositories/report-delivery.repository';
import { ReportSubscriptionRepository } from '../repositories/report-subscription.repository';
import { ReportWebhookEventRepository } from '../repositories/report-webhook-event.repository';
import { SessionRepository } from '../repositories/session.repository';
import { MailSendError } from './resend-mailer.service';
import { ReportLinkService } from './report-link.service';
import { ReportRendererService } from './report-renderer.service';

/*
 * The hourly report worker (CONTRACT.md §26).
 *
 * Driven by an external scheduler, because ADR-018 puts the API on a scale-to-zero host: at 08:00 on
 * a Monday a focus app has no traffic, so the container is asleep and its own timer does not exist.
 * The inbound request is what wakes it (ADR-014 rev. 2).
 *
 * EVERY PASS IS BOUNDED. It is designed to be called again, not to finish everything — which is what
 * keeps it inside a host's request timeout and is why `REPORTS_BATCH_SIZE` exists (D5).
 *
 * SAFETY COMES FROM THE DATABASE, NOT FROM THIS FILE. `claimPeriod` inserts against a unique index
 * on `(subscription, kind, period_start)`, so a cron provider that fires twice, a retry, or two
 * overlapping deploys all collapse to one row and one report (A7). Nothing here needs to remember to
 * check.
 *
 * ONE SUBSCRIPTION'S FAILURE NEVER STRANDS THE BATCH. Each is its own try/catch; a render that
 * throws for one account leaves a `retryable` row and the pass continues.
 */

export interface WorkerRunSummary {
  readonly due: number;
  readonly sent: number;
  readonly skipped: number;
  readonly retried: number;
  readonly failed: number;
}

/** Deliveries and webhook receipts are kept for 180 days (L4). */
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** Period membership is decided on local dates, so the instant window is padded past any offset. */
const WINDOW_PADDING_MS = 2 * 24 * 60 * 60 * 1000;

@Injectable()
export class ReportWorkerService {
  private readonly logger = new Logger(ReportWorkerService.name);
  private readonly batchSize: number;

  constructor(
    private readonly subscriptions: ReportSubscriptionRepository,
    private readonly deliveries: ReportDeliveryRepository,
    private readonly webhookEvents: ReportWebhookEventRepository,
    private readonly sessions: SessionRepository,
    private readonly renderer: ReportRendererService,
    private readonly links: ReportLinkService,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.batchSize = config.get('REPORTS_BATCH_SIZE', { infer: true });
  }

  /** One pass: retry what is owed, send what is due, sweep what has aged out (§26.2). */
  async runOnce(): Promise<WorkerRunSummary> {
    const now = this.clock.now();
    const retried = await this.retryPass(now);
    const sending = await this.sendPass(now);
    await this.sweep(now);

    return { ...sending, retried: retried.retried, failed: sending.failed + retried.failed };
  }

  /* --------------------------------------------------------------- Retrying -- */

  /**
   * Re-attempt deliveries that failed temporarily and are now due.
   *
   * **Only `retryable` rows are here.** A `sent` row is terminal: the provider accepted the message,
   * and a later "delivery delayed" webhook does not reopen it (§25.6). Re-sending because delivery
   * is slow is how one report becomes three.
   */
  private async retryPass(now: Date): Promise<{ retried: number; failed: number }> {
    const due = await this.deliveries.findRetryable(now, this.batchSize);
    let retried = 0;
    let failed = 0;

    for (const delivery of due) {
      const subscription = await this.subscriptions.findDueById(delivery.subscriptionId);
      if (!subscription || subscription.status !== 'active') {
        // Unsubscribed, bounced or paused since the attempt that failed. Stop trying rather than
        // mailing somebody who has since asked us not to.
        await this.deliveries.markTerminal(
          delivery.id,
          'failed',
          'Subscription is no longer active.',
        );
        continue;
      }

      const outcome = await this.deliver(subscription, periodOf(delivery), delivery, now);
      if (outcome === 'sent') retried += 1;
      else if (outcome === 'failed') failed += 1;
    }

    return { retried, failed };
  }

  /* ---------------------------------------------------------------- Sending -- */

  private async sendPass(
    now: Date,
  ): Promise<{ due: number; sent: number; skipped: number; failed: number }> {
    let due = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const frequency of REPORT_FREQUENCIES) {
      const candidates = await this.subscriptions.findDeliverable(frequency, this.batchSize);

      for (const subscription of candidates) {
        /*
         * Dueness is decided in the ACCOUNT'S zone, read from `users.timezone` through the join —
         * there is no timezone on the subscription (§23.0 consequence 1). This is also why the SQL
         * filter above is coarse: "08:00 wherever this person lives" is not a predicate SQL can
         * express without a per-row timezone expression.
         */
        if (!isDueAt(frequency, subscription.deliveryDay, now, subscription.timeZone)) continue;
        due += 1;

        const period = previousPeriod(frequency, localDate(now, subscription.timeZone));

        /*
         * Claim before rendering. Losing the claim means another pass already owns this period, and
         * the correct response is to do nothing at all — not to render and discard, which would
         * cost the work anyway.
         */
        const delivery = await this.deliveries.claimPeriod({
          subscriptionId: subscription.id,
          periodKind: frequency,
          periodStart: toDate(period.start),
          periodEnd: toDate(period.end),
        });

        if (!delivery) {
          due -= 1;
          continue;
        }

        const outcome = await this.deliver(subscription, period, delivery, now);
        if (outcome === 'sent') sent += 1;
        else if (outcome === 'skipped') skipped += 1;
        else if (outcome === 'failed') failed += 1;
      }
    }

    return { due, sent, skipped, failed };
  }

  /**
   * Build, render and send one report, and record what happened.
   *
   * The only place in the feature that touches all four of the event log, the renderer, the mailer
   * and the ledger — deliberately, so the ordering guarantees live in one readable sequence.
   */
  private async deliver(
    subscription: DueSubscriptionRecord,
    period: ReportPeriod,
    delivery: DeliveryRecord,
    now: Date,
  ): Promise<'sent' | 'skipped' | 'failed'> {
    try {
      const data = await this.compose(subscription, period, now);

      /*
       * An empty period is not sent (P7). A document whose only content is that the user did
       * nothing is a reproach, and this product removed its termination penalty precisely to stop
       * reproaching people. The decision is recorded so the next tick does not reconsider it.
       */
      if (isEmptyReport(data)) {
        await this.deliveries.markSkippedEmpty(delivery.id);
        return 'skipped';
      }

      const pdf = await this.renderer.render(data);
      const receipt = await this.mailer.send(this.compose_message(subscription, data, pdf));

      await this.deliveries.markSent(delivery.id, receipt.messageId, data.generatedAt);
      await this.subscriptions.markPeriodDelivered(subscription.id, toDate(period.start));
      return 'sent';
    } catch (error) {
      return this.recordFailure(delivery, error, now);
    }
  }

  /** Load the window, fold it, and hand back a report. Pure once the two reads are done. */
  private async compose(
    subscription: DueSubscriptionRecord,
    period: ReportPeriod,
    now: Date,
  ): Promise<ReportData> {
    // The comparison column needs the period before this one, so the window covers both.
    const earliest = precedingPeriod(period).start;
    const [sessions, progress] = await Promise.all([
      this.sessions.findEndedBetween(
        subscription.userId,
        new Date(toDate(earliest).getTime() - WINDOW_PADDING_MS),
        new Date(toDate(period.end).getTime() + WINDOW_PADDING_MS + 24 * 60 * 60 * 1000),
      ),
      this.sessions.getGamification(subscription.userId),
    ]);

    return buildReport({
      period,
      timeZone: subscription.timeZone,
      firstName: subscription.firstName,
      // The cut-off stamped into the footer. The period is frozen here and no later arrival
      // restates it (§24.3).
      generatedAt: now,
      sessions: sessions.map((session) => ({
        type: session.type,
        status: session.status,
        endedAt: session.endedAt,
        actualDurationMs: session.actualDurationMs,
        taskTitleSnapshot: session.taskTitleSnapshot,
        terminationReason: session.terminationReason,
      })),
      progress,
    });
  }

  /** Body, headers and attachment. The headline figures are text, not only in the PDF (§26.5). */
  private compose_message(
    subscription: DueSubscriptionRecord,
    data: ReportData,
    pdf: Buffer,
  ): Parameters<Mailer['send']>[0] {
    const kind = data.period.kind === 'monthly' ? 'monthly' : 'weekly';
    const filename = `evergrove-report-${data.period.start}.pdf`;

    return {
      to: subscription.email,
      subject: `Your ${kind} Evergrove report — ${data.periodLabel}`,
      text: [
        `Hi ${data.firstName},`,
        '',
        `Here is your ${kind} focus summary for ${data.periodLabel} (${data.timeZone}).`,
        '',
        `  Sessions completed : ${data.totals.completedSessions}`,
        `  Stopped early      : ${data.totals.terminatedSessions}`,
        `  Time focused       : ${data.totals.focusMinutes} minutes`,
        `  Completion rate    : ${data.totals.completionRate}%`,
        `  Current streak     : ${data.currentDayStreak} days`,
        '',
        'The attached PDF has the full breakdown.',
        '',
        'Change how often you get these, or turn them off:',
        this.links.settingsUrl(),
        '',
        'Unsubscribe:',
        this.links.unsubscribeUrl(subscription.userId),
      ].join('\n'),
      attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
      headers: {
        /*
         * L1: this is opt-in, non-transactional mail, so it carries a machine-readable unsubscribe
         * in both forms. The one-click POST goes straight to the API and never reaches the page —
         * which is why that endpoint takes a bare token and needs no session (§26.5).
         */
        'List-Unsubscribe': `<${this.links.unsubscribeUrl(subscription.userId)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  /* ---------------------------------------------------------------- Failure -- */

  /**
   * Classify a failure and write the ledger accordingly (§26.3).
   *
   * Only temporary failures are retried: a dead network, a 429, or a provider 5xx. A 4xx is a
   * rejected address or a malformed payload, and retrying it five times turns one failure into five
   * identical ones. Anything that is not a `MailSendError` — a render fault, a database blip — is
   * treated as temporary, because it is ours and it may well be transient.
   */
  private async recordFailure(
    delivery: DeliveryRecord,
    error: unknown,
    now: Date,
  ): Promise<'failed'> {
    const status = error instanceof MailSendError ? error.status : 0;
    const attempts = delivery.attempts + 1;
    const decision = decideRetry(attempts, status, now);
    const message = error instanceof Error ? error.message : 'Unknown failure.';

    if (decision.kind === 'retry') {
      await this.deliveries.markRetryable(delivery.id, decision.at, message);
    } else if (decision.kind === 'abandoned') {
      await this.deliveries.markTerminal(
        delivery.id,
        'abandoned',
        `Gave up after ${MAX_DELIVERY_ATTEMPTS} attempts: ${message}`,
      );
    } else {
      await this.deliveries.markTerminal(delivery.id, 'failed', message);
    }

    // The delivery id, never the recipient. An operator can join it to the subscription; a log
    // reader who should not know who receives reports still cannot tell.
    this.logger.warn(`Report delivery ${delivery.id} ${decision.kind} (status ${status}).`);
    return 'failed';
  }

  /* ------------------------------------------------------------------ Sweep -- */

  private async sweep(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    await this.deliveries.purgeOlderThan(cutoff);
    await this.webhookEvents.purgeOlderThan(cutoff);
  }
}

/** `YYYY-MM-DD` as a UTC midnight `Date`, which is how Postgres stores a `DATE`. */
function toDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The period a stored delivery row describes. */
function periodOf(delivery: DeliveryRecord): ReportPeriod {
  return {
    kind: delivery.periodKind,
    start: delivery.periodStart.toISOString().slice(0, 10),
    end: delivery.periodEnd.toISOString().slice(0, 10),
  };
}
