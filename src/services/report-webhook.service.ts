import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../common/ports/clock.port';
import type { Env } from '../config/env.schema';
import {
  SOFT_BOUNCE_LIMIT,
  SOFT_BOUNCE_PAUSE_MS,
  classifyDeliveryEvent,
  verifyWebhookSignature,
} from '../domain/report';
import { ReportSubscriptionRepository } from '../repositories/report-subscription.repository';
import { ReportWebhookEventRepository } from '../repositories/report-webhook-event.repository';

/*
 * The mail provider's delivery webhook (CONTRACT.md §25.6).
 *
 * THIS IS THE ONLY WAY BOUNCES ARE LEARNED. A send API answers 200 on *acceptance*, not on delivery;
 * without this endpoint the bounce policy in L3 is unimplementable and a dead address is mailed
 * forever, which is what damages a sending reputation.
 *
 * Three properties, each of which is the whole point of one part of the code below:
 *
 *   VERIFIED — the signature is checked against the RAW body before anything is parsed, logged or
 *   stored. An unverified payload is attacker-supplied and is treated as such.
 *
 *   IDEMPOTENT — every provider retries. The soft-bounce rule COUNTS, so a single transient bounce
 *   redelivered three times would pause a healthy subscription. The claim in
 *   `report_webhook_events` is what prevents that.
 *
 *   TOLERANT — an event type this build has never heard of is acknowledged and ignored. A webhook
 *   that 500s on an unrecognised payload gets the endpoint disabled by the provider, costing us
 *   every future bounce notice.
 */

/** What a request did, for the controller's response and for the operator's log. */
export type WebhookOutcome = 'unsigned' | 'invalid' | 'duplicate' | 'ignored' | 'applied';

/** The subset of a provider event this service reads. Everything else is deliberately unread. */
interface DeliveryEventPayload {
  type?: unknown;
  data?: { email_id?: unknown; bounce?: { type?: unknown } | null } | null;
}

@Injectable()
export class ReportWebhookService {
  private readonly logger = new Logger(ReportWebhookService.name);
  private readonly secret: string | undefined;

  constructor(
    private readonly subscriptions: ReportSubscriptionRepository,
    private readonly events: ReportWebhookEventRepository,
    private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('MAIL_WEBHOOK_SECRET', { infer: true });
  }

  /**
   * Handle one signed event.
   *
   * @param headers The Svix trio — `svix-id`, `svix-timestamp`, `svix-signature`.
   * @param rawBody The exact bytes received. Re-serialising a parsed object produces a different
   *   string and the signature would never match (see `common/types/raw-body-request.ts`).
   */
  async handle(
    headers: { id?: string; timestamp?: string; signature?: string },
    rawBody: Buffer | undefined,
  ): Promise<WebhookOutcome> {
    /*
     * No secret configured means no verification is possible, and an unverifiable webhook is worse
     * than none: it would let anyone on the internet disable any subscription they could name a
     * message id for. Refusing is the only safe answer.
     */
    if (!this.secret) {
      this.logger.warn('A delivery webhook arrived but MAIL_WEBHOOK_SECRET is not configured.');
      return 'unsigned';
    }

    if (!rawBody || !headers.id || !headers.timestamp || !headers.signature) return 'invalid';

    const verified = verifyWebhookSignature({
      secret: this.secret,
      id: headers.id,
      timestamp: headers.timestamp,
      signatureHeader: headers.signature,
      rawBody,
      now: this.clock.now(),
    });

    // Nothing about an unverified request is logged beyond the fact of it. The body is
    // attacker-controlled and could carry anything at all.
    if (!verified) return 'invalid';

    let payload: DeliveryEventPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as DeliveryEventPayload;
    } catch {
      return 'invalid';
    }

    const type = typeof payload.type === 'string' ? payload.type : '';

    /*
     * Claim BEFORE acting. The insert is the lock: a redelivery loses the unique index and returns
     * here, so the increment below runs exactly once per real event.
     */
    if (!(await this.events.claim(headers.id, type))) return 'duplicate';

    const bounceType =
      typeof payload.data?.bounce?.type === 'string' ? payload.data.bounce.type : null;
    const effect = classifyDeliveryEvent(type, bounceType);
    if (effect === 'none') return 'ignored';

    const messageId = typeof payload.data?.email_id === 'string' ? payload.data.email_id : null;
    if (!messageId) return 'ignored';

    const subscription = await this.subscriptions.findByDeliveryMessageId(messageId);
    // The message is not one of ours, or its delivery row has aged out of retention. Either way
    // there is nothing to apply, and inventing a subscription to punish would be worse.
    if (!subscription) return 'ignored';

    const now = this.clock.now();

    switch (effect) {
      case 'delivered':
        // The address works. The soft-bounce counter starts again from zero, so three transient
        // failures spread over a year never accumulate into a pause.
        await this.subscriptions.recordDelivered(subscription.id);
        break;

      case 'soft_bounce': {
        const consecutive = await this.subscriptions.recordSoftBounce(subscription.id, now);
        if (consecutive >= SOFT_BOUNCE_LIMIT) {
          await this.subscriptions.pauseUntil(
            subscription.id,
            new Date(now.getTime() + SOFT_BOUNCE_PAUSE_MS),
          );
        }
        break;
      }

      case 'disable_bounced':
        // A permanent bounce or a provider suppression. Reports stop now, not after two more.
        await this.subscriptions.disable(subscription.id, 'bounced', now);
        break;

      case 'disable_complaint':
        /*
         * Somebody pressed "this is spam". Treated exactly as an unsubscribe, because it is one —
         * and recorded as `unsubscribed` rather than `bounced` because the address works fine; it
         * is the mail that was unwanted. Nothing about the account's address is in question.
         */
        await this.subscriptions.disable(subscription.id, 'unsubscribed', now);
        break;
    }

    // The subscription id, never the address. A log reader who should not know who receives
    // reports still cannot tell from this line.
    this.logger.log(`Delivery event ${type} applied to subscription ${subscription.id}.`);
    return 'applied';
  }
}
