import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Mailer } from '../common/ports/mailer.port';
import type { Env } from '../config/env.schema';
import { ReportController } from '../controllers/report.controller';
import { ReportTokenController } from '../controllers/report-token.controller';
import { ReportWorkerController } from '../controllers/report-worker.controller';
import { WorkerSecretGuard } from '../guards/worker-secret.guard';
import { ReportDeliveryRepository } from '../repositories/report-delivery.repository';
import { ReportSubscriptionRepository } from '../repositories/report-subscription.repository';
import { ReportWebhookEventRepository } from '../repositories/report-webhook-event.repository';
import { ConsoleMailer } from '../services/console-mailer.service';
import { ReportLinkService } from '../services/report-link.service';
import { ReportMailService } from '../services/report-mail.service';
import { ReportRendererService } from '../services/report-renderer.service';
import { ReportSubscriptionService } from '../services/report-subscription.service';
import { ReportTestSendService } from '../services/report-test-send.service';
import { ReportWebhookService } from '../services/report-webhook.service';
import { ReportWorkerService } from '../services/report-worker.service';
import { ResendMailer } from '../services/resend-mailer.service';
import { SmtpMailer } from '../services/smtp-mailer.service';
import { AuthModule } from './auth.module';
import { SessionModule } from './session.module';

/*
 * Periodic email reports.
 *
 * Imports AuthModule for JwtGuard and its two constructor arguments — the reason those three are
 * exported and nothing else in that module is. `Clock` comes from the same place, and
 * `UserRepository` is used for exactly one read: `users.timezone` and the verified-address flag, the
 * two facts a subscription deliberately does not copy (§23.0 consequence 1).
 *
 * Neither repository is exported. Nothing outside this module may read `report_subscriptions` or
 * `report_deliveries` directly (ADR-020).
 */
@Module({
  /*
   * SessionModule for READS ONLY — `findEndedBetween` and `getGamification`. The report is a fold
   * over the event log and ADR-020 gives `focus_sessions` exactly one repository, so the alternative
   * was a second component over the same table.
   */
  imports: [AuthModule, SessionModule],
  controllers: [ReportController, ReportTokenController, ReportWorkerController],
  providers: [
    ReportSubscriptionService,
    ReportMailService,
    ReportLinkService,
    ReportRendererService,
    ReportWorkerService,
    ReportWebhookService,
    // Reachable only from `npm run report:send-test`. No controller injects it, so there is no
    // HTTP route by which a report can be sent to a named account on demand.
    ReportTestSendService,
    WorkerSecretGuard,
    ReportSubscriptionRepository,
    ReportDeliveryRepository,
    ReportWebhookEventRepository,
    {
      /*
       * The `Mailer` binding, and the only place a provider is chosen (ADR-009 as amended).
       *
       * A factory rather than `useClass`, because the choice is a runtime value: one deployment
       * sends through Resend and a developer's checkout prints to the log. Everything downstream
       * depends on the abstract class, so this is the one line that changes when the provider does.
       *
       * `RecordingMailer` is deliberately unreachable from here — it is registered by tests
       * directly. A configuration under which production silently stops sending mail is not a
       * configuration worth supporting.
       */
      provide: Mailer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Mailer => {
        switch (config.get('MAIL_PROVIDER', { infer: true })) {
          case 'resend':
            return new ResendMailer(config);
          case 'smtp':
            return new SmtpMailer(config);
          default:
            return new ConsoleMailer();
        }
      },
    },
  ],
  /*
   * NOTHING IS EXPORTED, AND THAT IS THE POINT.
   *
   * §25.7 originally had `POST /auth/register` accept a `reportFrequency` and write the
   * subscription "in the same transaction as the user". Implementing it revealed two problems.
   *
   * The first is structural: AuthModule would have to import this module for the service, while
   * this module already imports AuthModule for `JwtGuard` — a circular module dependency, resolvable
   * only with `forwardRef`, which this codebase has never needed and should not acquire for a
   * preference.
   *
   * The second is that the promise could not be kept anyway. Applying the answer sends a
   * confirmation email, and an outbound HTTP call has no business inside a database transaction —
   * it would hold the write open for the length of a provider round trip and roll the new account
   * back if the provider was slow.
   *
   * So the signup answer is a follow-up `PUT /me/reports` from the client, using the access token
   * registration just returned. One code path, one implementation of the L3 rule, and no cycle.
   * §25.7 is amended to match.
   */
})
export class ReportModule {}
