import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentAuth } from '../common/decorators/current-auth.decorator';
import type { UserSettings } from '../common/types/settings.types';
import type { AuthContext } from '../common/types/user.types';
import { type UpdateSettingsDto, updateSettingsSchema } from '../dto/settings.dto';
import { JwtGuard } from '../guards/jwt.guard';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { SettingsService } from '../services/settings.service';

/**
 * The signed-in account's preferences (CONTRACT.md §4.7, §4.8).
 *
 * A second controller on the `me` path rather than more routes on UserController: `user_settings`
 * has its own repository, and ADR-020 gives each table exactly one component that touches it.
 * Folding these routes into UserController would hand it a second table.
 *
 * Ownership needs no check: the id comes from the verified access token, so there is no path by
 * which a caller could address another user's preferences (ADR-010).
 */
@Controller('me')
@UseGuards(JwtGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('settings')
  async read(@CurrentAuth() auth: AuthContext): Promise<{ settings: UserSettings }> {
    return { settings: await this.settings.getSettings(auth.userId) };
  }

  @Patch('settings')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateSettingsSchema)) dto: UpdateSettingsDto,
  ): Promise<{ settings: UserSettings }> {
    return { settings: await this.settings.updateSettings(auth.userId, dto) };
  }
}
