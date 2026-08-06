import { Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '../common/types/raw-body-request';
import { WorkerSecretGuard } from '../guards/worker-secret.guard';
import { type WorkerRunSummary, ReportWorkerService } from '../services/report-worker.service';
import { ReportWebhookService } from '../services/report-webhook.service';

/*
 * The two machine-facing routes: the scheduler's tick and the provider's delivery webhook
 * (CONTRACT.md §25.5, §25.6).
 *
 * Separate from both user-facing report controllers, because neither of these has a user. They are
 * grouped together for one reason: they are the only routes in the application whose caller is
 * another system, and each authenticates with its own shared secret rather than with a session.
 *
 * Neither appears in the OpenAPI document the frontend consumes.
 */
@Controller()
export class ReportWorkerController {
  constructor(
    private readonly worker: ReportWorkerService,
    private readonly webhooks: ReportWebhookService,
  ) {}

  /**
   * One bounded pass — retry what is owed, send what is due, sweep what has aged out (§26.2).
   *
   * **It is not designed to finish everything.** An external scheduler calls it every hour on the
   * hour; each call processes at most `REPORTS_BATCH_SIZE` subscriptions and returns, which is what
   * keeps it inside a host's request timeout. The counts come back so the cron provider's log is
   * worth reading.
   *
   * Its own throttle, well above one call an hour but far below anything that could be used to
   * hammer the database.
   */
  @Throttle({ default: { limit: 12, ttl: 900_000 } })
  @UseGuards(WorkerSecretGuard)
  @Post('internal/reports/run')
  @HttpCode(200)
  async run(): Promise<WorkerRunSummary> {
    return this.worker.runOnce();
  }

  /**
   * Provider delivery events (§25.6).
   *
   * **Always 204, whatever happened.** An unrecognised event, a duplicate, even a bad signature —
   * all acknowledged. A webhook endpoint that returns an error gets retried and then disabled by the
   * provider, which would cost every future bounce notice; and answering differently per outcome
   * would tell an unauthenticated caller whether their forged signature was close. What the request
   * actually did is in the log, not in the response.
   *
   * No guard: the signature IS the authentication, and it is checked inside the service against the
   * raw body that `main.ts` preserved.
   */
  @Throttle({ default: { limit: 600, ttl: 900_000 } })
  @Post('webhooks/mail')
  @HttpCode(204)
  async receive(
    @Req() request: RawBodyRequest,
    @Headers('svix-id') id?: string,
    @Headers('svix-timestamp') timestamp?: string,
    @Headers('svix-signature') signature?: string,
  ): Promise<void> {
    await this.webhooks.handle({ id, timestamp, signature }, request.rawBody);
  }
}
