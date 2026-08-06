import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { ReportSubscriptionView } from '../common/types/report.types';
import { type ReportTokenDto, reportTokenSchema } from '../dto/report.dto';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { ReportSubscriptionService } from '../services/report-subscription.service';

/*
 * The two routes reached from a link in an email (CONTRACT.md §25.3, §25.4).
 *
 * UNAUTHENTICATED, AND SEPARATED FROM ReportController FOR THAT REASON. They carry no guard because
 * the token *is* the credential and the reader is, by definition, often not signed in — the link
 * arrives on a phone that may never have been. Keeping them in their own file means the guarded
 * controller cannot lose its guard by someone adding a route to the wrong class.
 *
 * POST, NOT GET, AND THE EMAIL LINKS TO THE FRONTEND. Corporate mail scanners follow links in
 * incoming mail; a GET that consumed a single-use token would be spent by the scanner before the
 * human ever clicked. The link opens a page, and the page makes this request.
 *
 * BOTH ANSWER 200 FOR A TOKEN THEY DO NOT RECOGNISE. Unknown, expired and already-consumed are one
 * response with `status: "invalid"` — never a 404. Distinguishing them would turn either endpoint
 * into an oracle for which tokens exist.
 */
@Controller('reports')
export class ReportTokenController {
  constructor(private readonly reports: ReportSubscriptionService) {}

  /**
   * Tighter than the global ceiling, because these are the only unauthenticated writes in the
   * feature. A token is 32 random bytes, so guessing is not the threat; the throttle is here so the
   * endpoint cannot be used as free database load.
   */
  @Throttle({ default: { limit: 20, ttl: 900_000 } })
  @Post('confirm')
  @HttpCode(200)
  async confirm(
    @Body(new ZodValidationPipe(reportTokenSchema)) dto: ReportTokenDto,
  ): Promise<ReportSubscriptionView | { status: 'invalid' }> {
    const outcome = await this.reports.confirm(dto.token);
    return outcome.kind === 'ok' ? outcome.view : { status: 'invalid' };
  }

  /**
   * Idempotent by contract: the unsubscribe token does not expire, and a second click answers
   * exactly like the first. This route also serves `List-Unsubscribe-Post`, which is why it takes a
   * bare token and requires no session.
   */
  @Throttle({ default: { limit: 20, ttl: 900_000 } })
  @Post('unsubscribe')
  @HttpCode(200)
  async unsubscribe(
    @Body(new ZodValidationPipe(reportTokenSchema)) dto: ReportTokenDto,
  ): Promise<ReportSubscriptionView | { status: 'invalid' }> {
    const outcome = await this.reports.unsubscribe(dto.token);
    return outcome.kind === 'ok' ? outcome.view : { status: 'invalid' };
  }
}
