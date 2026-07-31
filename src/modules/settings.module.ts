import { Module } from '@nestjs/common';
import { SettingsController } from '../controllers/settings.controller';
import { SettingsRepository } from '../repositories/settings.repository';
import { AuthModule } from './auth.module';
import { SettingsService } from '../services/settings.service';

/*
 * User preferences.
 *
 * Imports AuthModule for JwtGuard — the reason that guard is exported and every other provider in
 * that module is not. The repository is deliberately not exported: nothing outside this module may
 * read the user_settings table directly (ADR-020).
 */
@Module({
  imports: [AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService, SettingsRepository],
})
export class SettingsModule {}
