import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { notAuthenticatedProblem } from '../common/errors/problem.exception';
import { Clock } from '../common/ports/clock.port';
import {
  type ReportSubscriptionRecord,
  type ReportSubscriptionView,
  toReportSubscriptionView,
} from '../common/types/report.types';
import type { Env } from '../config/env.schema';
import {
  DEFAULT_DELIVERY_DAY,
  type FrequencyChoice,
  type ReportFrequency,
  generateToken,
  hashToken,
  resolveActivation,
} from '../domain/report';
import { ReportSubscriptionRepository } from '../repositories/report-subscription.repository';
import { UserRepository } from '../repositories/user.repository';
import { ReportLinkService } from './report-link.service';
import { ReportMailService } from './report-mail.service';

/*
 * The subscription lifecycle — the whole of what a user can do to their own reports.
 *
 * This service holds real rules, so it is one of the places ADR-005 allocates depth to. Three of
 * them are worth naming because getting any one wrong is a privacy failure rather than a bug:
 *
 *  1. A MISSING ROW IS A STATE, NOT AN ERROR. Reading returns `unasked`; nothing 404s, and nothing
 *     creates a row on a read (§25.1).
 *  2. AN ADDRESS IS PROVEN BEFORE IT IS USED. Only a verified account activates immediately; anyone
 *     else gets a pending subscription and a single-use link (L3). The database enforces the same
 *     invariant, so no future code path can route around this one.
 *  3. DECLINING IS AN ANSWER AND IS WRITTEN DOWN. "No thanks" stores a row, because silence and
 *     refusal have to stay distinguishable (§23.0 consequence 3).
 */

/** What a confirmation attempt did. `invalid` covers unknown, expired, and already-used alike. */
export type TokenOutcome =
  { readonly kind: 'ok'; readonly view: ReportSubscriptionView } | { readonly kind: 'invalid' };

@Injectable()
export class ReportSubscriptionService {
  private readonly logger = new Logger(ReportSubscriptionService.name);
  private readonly confirmationTtlMs: number;

  constructor(
    private readonly subscriptions: ReportSubscriptionRepository,
    private readonly users: UserRepository,
    private readonly mail: ReportMailService,
    private readonly links: ReportLinkService,
    private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.confirmationTtlMs = config.get('REPORT_CONFIRMATION_TTL_MS', { infer: true });
  }

  /** The account's current answer, or `unasked` when it has never given one. Never a 404. */
  async read(userId: string): Promise<ReportSubscriptionView> {
    return toReportSubscriptionView(await this.subscriptions.findByUserId(userId));
  }

  /**
   * Set the frequency, or decline (§25.2).
   *
   * Every transition a signed-in user can make runs through here: choosing for the first time,
   * changing frequency, declining, resuming a paused subscription, and asking for another
   * confirmation email. They are one method because they are one decision — "what should my reports
   * be from now on?" — and splitting them into endpoints per transition would put the state machine
   * in the router.
   */
  async choose(userId: string, choice: FrequencyChoice): Promise<ReportSubscriptionView> {
    const existing = await this.subscriptions.findByUserId(userId);

    if (choice === 'none') return this.decline(userId, existing);

    const user = await this.users.findById(userId);
    // The token verified, then the account vanished mid-request. There is nothing to sign in as.
    if (!user) throw notAuthenticatedProblem();

    const now = this.clock.now();
    /*
     * L3, in one line. A Google-verified address is one Google has asserted (§11) and is enough to
     * send to; anything else has to prove it can receive mail first. `emailVerifiedAt` is written
     * only by a verified Google sign-in, so in practice this is exactly the provider/password split.
     */
    const status = resolveActivation(user.emailVerifiedAt !== null);
    const confirmed = status === 'active';

    /*
     * A token is minted for a pending subscription and for nothing else. Issuing a second
     * invalidates the first by overwriting the hash — which is what makes "resend" work without a
     * token table, and what makes the old link stop working the moment a new one is sent (§23.3).
     */
    const token = confirmed ? null : generateToken();
    const tokenHash = token === null ? null : hashToken(token);
    const expiresAt = token === null ? null : new Date(now.getTime() + this.confirmationTtlMs);

    const record = existing
      ? await this.subscriptions.update(userId, {
          frequency: choice,
          status,
          /*
           * Resuming. A subscription paused by soft bounces, or switched off, comes back cleanly:
           * the pause lifts and the bounce counter resets, because the user has just told us the
           * address is one they want mail at. A `bounced` subscription resets the same way — the
           * hard bounce is still recorded in `lastBounceAt` for anyone investigating.
           */
          pausedUntil: null,
          consecutiveSoftBounces: 0,
          // Once proven, an address stays proven. Re-subscribing does not re-verify.
          confirmedAt: confirmed ? (existing.confirmedAt ?? now) : existing.confirmedAt,
          confirmationTokenHash: tokenHash,
          confirmationExpiresAt: expiresAt,
        })
      : await this.subscriptions.create({
          userId,
          frequency: choice,
          status,
          deliveryDay: DEFAULT_DELIVERY_DAY,
          confirmedAt: confirmed ? now : null,
          confirmationTokenHash: tokenHash,
          confirmationExpiresAt: expiresAt,
          unsubscribeTokenHash: hashToken(this.links.unsubscribeToken(userId)),
        });

    if (!record) throw notAuthenticatedProblem();

    if (token !== null) {
      await this.sendConfirmation(user.email, user.firstName, choice, token);
    }

    return toReportSubscriptionView(record);
  }

  /**
   * "No email reports" — an explicit answer, stored as `declined`.
   *
   * Distinct from `unsubscribed`, which is what the link in an email produces. Both mean off; they
   * record different conversations, and the wording the user reads differs accordingly.
   */
  private async decline(
    userId: string,
    existing: ReportSubscriptionRecord | null,
  ): Promise<ReportSubscriptionView> {
    if (existing) {
      return toReportSubscriptionView(
        await this.subscriptions.update(userId, {
          status: 'declined',
          // A pending confirmation is abandoned with the choice. Leaving a live token behind would
          // mean an old email could still switch reports back on after the user said no.
          confirmationTokenHash: null,
          confirmationExpiresAt: null,
          pausedUntil: null,
        }),
      );
    }

    /*
     * Declining without an existing row still writes one, and this is the case §23.0 consequence 3
     * exists for. Without it "asked, said no" is indistinguishable from "never asked", and the
     * one-time invitation would ask again on the next page load, forever.
     *
     * A frequency is stored even though nothing will be sent: it is what a later "yes" restores.
     */
    const record = await this.subscriptions.create({
      userId,
      frequency: 'weekly',
      status: 'declined',
      deliveryDay: DEFAULT_DELIVERY_DAY,
      confirmedAt: null,
      confirmationTokenHash: null,
      confirmationExpiresAt: null,
      unsubscribeTokenHash: hashToken(this.links.unsubscribeToken(userId)),
    });

    if (!record) throw notAuthenticatedProblem();
    return toReportSubscriptionView(record);
  }

  /**
   * Consume a confirmation token (§25.3). **Unauthenticated** — the token is the credential.
   *
   * Unknown, expired, and already-consumed all answer the same way, and none of them is a 404.
   * Distinguishing them would let anyone with a URL probe which tokens exist, and answering "not
   * found" for an unknown token is that probe in its clearest form.
   */
  async confirm(token: string): Promise<TokenOutcome> {
    const record = await this.subscriptions.findByConfirmationTokenHash(hashToken(token));
    if (!record || !record.confirmationExpiresAt) return { kind: 'invalid' };

    const now = this.clock.now();
    if (record.confirmationExpiresAt.getTime() <= now.getTime()) return { kind: 'invalid' };

    /*
     * Single-use: the hash is cleared in the same statement that activates. A second click finds no
     * row and gets `invalid`, which is the correct answer — the link really has been used.
     */
    const updated = await this.subscriptions.update(record.userId, {
      status: 'active',
      confirmedAt: record.confirmedAt ?? now,
      confirmationTokenHash: null,
      confirmationExpiresAt: null,
      pausedUntil: null,
      consecutiveSoftBounces: 0,
    });

    return { kind: 'ok', view: toReportSubscriptionView(updated) };
  }

  /**
   * Turn reports off from a link in an email (§25.4). **Unauthenticated**, and idempotent.
   *
   * The unsubscribe token does not expire, so a second click answers exactly like the first. A link
   * in a year-old email that errored would be a link that lied, and "your unsubscribe failed" is
   * the message most likely to turn a quiet opt-out into a spam complaint.
   */
  async unsubscribe(token: string): Promise<TokenOutcome> {
    const record = await this.subscriptions.findByUnsubscribeTokenHash(hashToken(token));
    if (!record) return { kind: 'invalid' };

    if (record.status === 'unsubscribed') {
      return { kind: 'ok', view: toReportSubscriptionView(record) };
    }

    const updated = await this.subscriptions.update(record.userId, {
      status: 'unsubscribed',
      confirmationTokenHash: null,
      confirmationExpiresAt: null,
      pausedUntil: null,
    });

    return { kind: 'ok', view: toReportSubscriptionView(updated) };
  }

  /**
   * Sending is awaited, not queued (ADR-009's rule, applied to this feature's one inline send).
   *
   * A failure here rejects the whole `choose`, which is deliberate: the subscription is already
   * `pending_confirmation` at that point, so the user is told something went wrong rather than
   * being left waiting for an email that was never sent. Retrying is one click on "resend".
   */
  private async sendConfirmation(
    to: string,
    firstName: string,
    frequency: ReportFrequency,
    token: string,
  ): Promise<void> {
    await this.mail.sendConfirmation({ to, firstName, frequency, token });
  }
}
