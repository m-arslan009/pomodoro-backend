import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import type { ReportSubscriptionView } from '../common/types/report.types';
import type { AuthContext } from '../common/types/user.types';
import {
  type UpdateReportSubscriptionDto,
  updateReportSubscriptionSchema,
} from '../dto/report.dto';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { ReportSubscriptionService } from '../services/report-subscription.service';

/**
 * The signed-in account's email report preference (CONTRACT.md §25.1, §25.2).
 *
 * A third controller on the `me` path, beside UserController and SettingsController, for the reason
 * ADR-020 gives: `report_subscriptions` has its own repository, and each table gets exactly one
 * component that touches it. Folding these routes into SettingsController would hand it a second.
 *
 * Ownership needs no check — the id comes from the verified access token, so there is no path by
 * which a caller could address another account's subscription (ADR-010).
 *
 * **PUT, not PATCH.** The body is the account's whole answer to one question; there is no partial
 * update of "how often would you like reports?", so the semantics settings.controller.ts needs do
 * not apply here.
 */
@Controller('me')
@UseGuards(JwtGuard)
export class ReportController {
  constructor(private readonly reports: ReportSubscriptionService) {}

  /**
   * Never 404s. An account with no subscription gets `status: "unasked"` — the permanent state of
   * every Google-created account until it opens Settings, and what the client renders the three
   * options on.
   */
  @Get('reports')
  async read(@CurrentAuth() auth: AuthContext): Promise<ReportSubscriptionView> {
    return this.reports.read(auth.userId);
  }

  /**
   * Choosing, changing, declining, resuming, and asking for another confirmation email are all this
   * one call — see `ReportSubscriptionService.choose`.
   *
   * 200 whether the answer activated reports or only started the confirmation round trip. Neither
   * is a failure, and `requiresConfirmation` in the response is how the client tells them apart.
   */
  @Put('reports')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateReportSubscriptionSchema))
    dto: UpdateReportSubscriptionDto,
  ): Promise<ReportSubscriptionView> {
    return this.reports.choose(auth.userId, dto.frequency);
  }
}
